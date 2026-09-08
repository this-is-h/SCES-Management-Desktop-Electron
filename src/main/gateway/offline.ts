/**
 * 离线网关：本地即权威。这些不是"抛错的桩"，是真实现（dual-mode/06 §1.1）：
 * - activate：验签授权文件 + 口令解封（.dysl；.dysd 留 M-O1B）。
 * - publishUnitPublicKey：导出 .dysk 公钥包（单位签发私钥自签，13 §1 改为真实现）。
 * - requestRebind：导出 .dysr 换机申请文件。
 * - 各上报方法：no-op（本机即权威，无接收方）。调用点与在线同一份代码（G2）。
 *
 * 在线产物里本文件整块被 Rollup 摇掉（gateway/index.ts 编译期常量三元选择）。
 */
import { app } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { computeFingerprint } from '@sces/shared/fingerprint'
import {
  LICENSE_SCHEMA_VERSION,
  LicenseError,
  asDelegatedLicense,
  asOfflineLicense,
  issueUnitPubkeyPackage,
  openDelegatedLicense,
  openOfflineLicense,
  parseDysFile,
  verifyDelegatedLicense,
  verifyOfflineLicense
} from '@sces/shared/license'
import type { RebindRequestFile } from '@sces/shared/license'
import { getActiveAccount } from '../services/accounts'
import { getSetting } from '../services/settings'
import { getCurrentApplyKey } from '../services/apply-key'
import { readUnitSignKey, signKeyIdFor } from '../services/unit-keys'
import { getUnitCertOrNull } from '../services/unit-cert-store'
import type {
  ActivateInput,
  ActivateResult,
  AdminGateway,
  ApplyKeyMaterial,
  ApplyStatusesReport,
  ApplyStatusesResult,
  LicenseFilePreview,
  PublishPubkeyResult,
  RebindResult
} from './types'

/** 读文件文本，失败给中文错误（供 activate / inspect 复用）。 */
function readText(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    throw new LicenseError('not-a-license', '无法读取文件')
  }
}

export const offlineGateway: AdminGateway = {
  mode: 'offline',

  async activate(input: ActivateInput): Promise<ActivateResult> {
    if (input.kind !== 'license-file') {
      throw new Error('当前离线版仅支持导入授权文件激活')
    }
    const env = parseDysFile(readText(input.filePath))
    if (env.type === 'delegated-license') {
      const dysd = asDelegatedLicense(env)
      const opened = await openDelegatedLicense({
        file: dysd,
        verifyKeys: __DMS_LICENSE_VERIFY_KEYS__,
        machineFingerprint: computeFingerprint(),
        password: input.password
      })
      const cfg = opened.secret.configTemplate
      return {
        unit: {
          unitId: opened.header.unitId,
          name: cfg.unit.name,
          unitType: cfg.unit.unitType,
          parentUnit: cfg.unit.parentUnit
        },
        configTemplate: cfg,
        expiresAt: opened.effectiveExpiresAt,
        role: opened.header.role,
        scope: opened.header.scope,
        authority: 'local',
        delegationId: opened.header.delegationId,
        signKeyId: opened.header.signKeyId,
        boundFingerprint: opened.header.boundFingerprint,
        applyKeys: opened.secret.applyKeys.map((k) => ({
          keyId: k.keyId,
          publicKeyJwk: k.publicKeyJwk,
          privateKeyJwk: k.privateKeyJwk,
          current: k.current
        })),
        unitCert: dysd.unitCert,
        batches: opened.secret.batches ?? []
      }
    }
    const file = asOfflineLicense(env)
    const secret = await openOfflineLicense({
      file,
      password: input.password,
      verifyKeys: __DMS_LICENSE_VERIFY_KEYS__,
      fingerprint: computeFingerprint()
    })
    return {
      unit: secret.unit,
      configTemplate: secret.configTemplate,
      expiresAt: file.header.expiresAt,
      role: file.header.role,
      scope: file.header.scope,
      authority: 'local',
      licenseId: file.header.licenseId,
      signKeyId: file.header.signKeyId,
      boundFingerprint: file.header.boundFingerprint
    }
  },

  async inspectLicenseFile(filePath: string): Promise<LicenseFilePreview | null> {
    const env = parseDysFile(readText(filePath))
    if (env.type === 'delegated-license') {
      const dysd = asDelegatedLicense(env)
      const verified = await verifyDelegatedLicense({
        file: dysd,
        verifyKeys: __DMS_LICENSE_VERIFY_KEYS__,
        machineFingerprint: computeFingerprint()
      })
      const dh = dysd.header
      return {
        type: dysd.type,
        unitId: dh.unitId,
        unitName: dh.unitId,
        role: dh.role,
        scope: dh.scope,
        expiresAt: verified.effectiveExpiresAt,
        boundFingerprint: dh.boundFingerprint,
        signKeyId: dh.signKeyId
      }
    }
    if (env.type !== 'offline-license') {
      throw new LicenseError('not-a-license')
    }
    const file = asOfflineLicense(env)
    await verifyOfflineLicense(file, __DMS_LICENSE_VERIFY_KEYS__)
    const h = file.header
    return {
      type: file.type,
      unitId: h.unitId,
      unitName: h.unitName,
      role: h.role,
      scope: h.scope,
      expiresAt: h.expiresAt,
      boundFingerprint: h.boundFingerprint,
      signKeyId: h.signKeyId
    }
  },

  async publishUnitPublicKey(opts?: { exportPath?: string }): Promise<PublishPubkeyResult> {
    // 无导出路径 = 激活流程里的默认调用：离线不弹对话框，交由设置页/顶栏手动导出。
    if (!opts?.exportPath) return { transport: 'file', exported: false }
    const unitKey = readUnitSignKey()
    if (!unitKey.privateKeyJwk) {
      throw new Error('本机无单位签发私钥，无法导出公钥包')
    }
    const applyKey = getCurrentApplyKey()
    const activation = getSetting('activation')
    // licenseId 优先取激活信息；旧账号 activation 可能缺失，回退到已导入的单位证书（同一 licenseId，供换证核对台账）。
    const licenseId = activation?.licenseId || getUnitCertOrNull()?.licenseId || ''
    if (!licenseId) {
      throw new Error(
        '当前账号缺少授权 id（licenseId），无法导出可换证的公钥包。请到「设置 → 授权 → 更新授权」重新导入一级授权文件(.dysl)后再导出。'
      )
    }
    const pkg = await issueUnitPubkeyPackage({
      payload: {
        licenseId,
        unitId: unitKey.unitId,
        boundFingerprint: activation?.boundFingerprint ?? null,
        signKey: { keyId: signKeyIdFor(unitKey.unitId), publicKeyJwk: unitKey.publicKeyJwk },
        applyKey: { keyId: applyKey.keyId, publicKeyJwk: applyKey.publicKeyJwk },
        issuedAt: Date.now()
      },
      signPrivateKeyJwk: unitKey.privateKeyJwk
    })
    writeFileSync(opts.exportPath, JSON.stringify(pkg, null, 2), 'utf-8')
    return { transport: 'file', path: opts.exportPath, exported: true }
  },

  async requestRebind(
    newFingerprint: string,
    reason: string,
    exportPath?: string
  ): Promise<RebindResult> {
    if (!exportPath) throw new Error('未选择保存位置')
    const acc = getActiveAccount()
    const activation = getSetting('activation')
    const req: RebindRequestFile = {
      schemaVersion: LICENSE_SCHEMA_VERSION,
      type: 'rebind-request',
      licenseId: activation?.licenseId ?? '',
      unitId: acc?.unitId ?? '',
      oldFingerprint: activation?.boundFingerprint ?? null,
      newFingerprint,
      requestedAt: Date.now(),
      reason,
      appVersion: app.getVersion(),
      profileId: __DMS_PROFILE_ID__
    }
    writeFileSync(exportPath, JSON.stringify(req, null, 2), 'utf-8')
    return {
      transport: 'file',
      path: exportPath,
      message: '已生成换机申请文件，请发送给服务商换取新的授权文件'
    }
  },

  /** 无远端可查 → null 表示"以本地 expiresAt 为准"。 */
  async fetchLicenseStatus() {
    return null
  },

  /** 批次只存在于本机 SQLite。 */
  async publishBatch() {},
  async publishBatchStatus() {},
  async publishApplyStatus() {},
  async openReviewRound() {},

  async publishApplyStatuses(input: ApplyStatusesReport): Promise<ApplyStatusesResult> {
    return {
      succeeded: input.applyIds.length,
      failed: 0,
      results: input.applyIds.map((applyId) => ({ applyId, ok: true, authority: 'local' as const }))
    }
  },

  /** 申请密钥来自本地 apply_key（激活时生成，跨批次复用）。 */
  async resolveApplyKey(): Promise<ApplyKeyMaterial> {
    return getCurrentApplyKey()
  }
}
