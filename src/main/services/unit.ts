/**
 * 单位（账号）服务：一级管理端激活成为超级管理员。
 * 激活权威由 gateway 决定：离线本地验签授权文件（.dysl），在线服务端核验授权码。
 * 激活后本地生成单位签发密钥（RSA-PSS）与单位申请密钥（RSA-OAEP），私钥不出本机。
 * 多账号：激活成功后写入账号索引并打开该账号独立库；可同时保留多个账号并切换。
 */
import { readFileSync } from 'fs'
import type Database from 'better-sqlite3'
import { generateRsaKeyPair, verifyRsaKeyPair } from '@sces/shared'
import type { Batch, UnitBinding, UnitConfig } from '@sces/shared'
import { canonical, generateSignKeyPair } from '@sces/shared/crypto/sign'
import { computeFingerprint } from '@sces/shared/fingerprint'
import { asUnitCert, parseDysFile, verifyUnitCert } from '@sces/shared/license'
import { is } from '@electron-toolkit/utils'
import { closeDb, openActiveDb, getDb } from '../db'
import { gateway } from '../gateway'
import type {
  ActivateResult,
  LicenseFilePreview,
  PublishPubkeyResult,
  RebindResult
} from '../gateway/types'
import { writeAudit } from './audit'
import { getSetting, setSetting } from './settings'
import type { ActivationState } from './settings'
import {
  accountIdFor,
  upsertAccount,
  setActiveAccount,
  getActiveAccount,
  listAccounts,
  removeAccount,
  deleteAccountDir,
  hasAccounts,
  setAccountActivation,
  type AccountInfo
} from './accounts'
import { getCurrentApplyKey, getCurrentApplyKeyOrNull, insertApplyKey } from './apply-key'
import { assertWritable, getLicenseStatus, type LicenseStatus } from './license'
import { assertLevel1 } from './role'
import { readUnitSignKey } from './unit-keys'
import { upsertUnitCert } from './unit-cert-store'
import { assertReadableFile } from './file-guard'
import type { ActivateInput, ActivationInfo } from '../../preload/types'

/** 单位信息（不含私钥）。完整单位名 = parentUnitName（一级/学校）+ name（二级独立单位，issue #3）。 */
export interface UnitInfo {
  id: string
  name: string
  unitType: string
  createdAt: number
  /** 一级单位（学校）名称——单位完整名的第一部分；旧配置/回退时 undefined。 */
  parentUnitName?: string
  /** 一级单位 id。 */
  parentUnitId?: string
}

/** 服务端地址：开发模式可配置（settings 或默认本地），生产模式编译进安装包。 */
export function getServerUrl(): string {
  if (is.dev) return getSetting('serverUrl') ?? 'http://127.0.0.1:3000'
  return __DMS_SERVER_URL__
}

/** 是否已有激活账号（决定进入系统还是验证页）。 */
export function isInitialized(): boolean {
  return getActiveAccount() !== null
}

/** 获取当前单位（未激活返回 null）。 */
export function getUnit(): UnitInfo | null {
  const acc = getActiveAccount()
  if (!acc) return null
  try {
    const row = getDb()
      .prepare('SELECT id, name, unit_type AS unitType, created_at AS createdAt FROM unit LIMIT 1')
      .get() as UnitInfo | undefined
    const base = row ?? { id: acc.unitId, name: acc.name, unitType: acc.unitType, createdAt: 0 }
    const parent = boundParentUnit()
    return { ...base, parentUnitName: parent?.name, parentUnitId: parent?.unitId }
  } catch {
    return { id: acc.unitId, name: acc.name, unitType: acc.unitType, createdAt: 0 }
  }
}

/** 绑定配置模板里的一级单位（学校）——单位完整名的第一部分（决策 #34，issue #3）。 */
function boundParentUnit(): { unitId: string; name: string } | undefined {
  try {
    const row = getDb()
      .prepare(
        `SELECT unit FROM config_template WHERE id = (SELECT config_template_id FROM unit LIMIT 1)`
      )
      .get() as { unit?: string } | undefined
    return row?.unit ? (JSON.parse(row.unit) as UnitBinding).parentUnit : undefined
  } catch {
    return undefined
  }
}

/** 账号列表（侧边栏切换）。回填当前单位各账号的一级单位名，使切换器与标题栏单位名一致（issue #3）。 */
export function getAccounts(): AccountInfo[] {
  const accounts = listAccounts()
  const active = getActiveAccount()
  const parent = boundParentUnit()
  if (active && parent?.name) {
    for (const a of accounts) if (a.unitId === active.unitId) a.parentUnitName = parent.name
  }
  return accounts
}

/** 是否已有任何账号（决定验证页是否展示“返回我的系统”）。 */
export function hasAnyAccount(): boolean {
  return hasAccounts()
}

/** 授权状态（过期只读判定）。 */
export function getLicense(): LicenseStatus {
  return getLicenseStatus()
}

/** 获取激活信息（设置页展示：单位/角色/授权 id/申请密钥 keyId/机器码/配置版本/发布档）。 */
export function getActivationInfo(): ActivationInfo {
  const activation = getSetting('activation')
  const applyKey = getCurrentApplyKeyOrNull()
  let configVersion: string | undefined
  try {
    const row = getDb()
      .prepare(
        `SELECT version, revision FROM config_template
         WHERE id = (SELECT config_template_id FROM unit LIMIT 1)`
      )
      .get() as { version: number; revision: number } | undefined
    if (row) configVersion = `v${row.version}.${row.revision}`
  } catch {
    configVersion = undefined
  }
  return {
    serverUrl: getServerUrl(),
    expiresAt: activation?.expiresAt,
    mode: activation?.mode,
    role: activation?.role,
    scope: activation?.scope,
    licenseId: activation?.licenseId,
    delegationId: activation?.delegationId,
    keyId: applyKey?.keyId,
    signKeyId: activation?.signKeyId,
    fingerprint: computeFingerprint(),
    boundFingerprint: activation?.boundFingerprint,
    profileId: __DMS_PROFILE_ID__,
    configVersion,
    pubkeyExported: activation?.pubkeyExported
  }
}

/**
 * 激活：gateway 决定在线核验（授权码）或本地验签（授权文件）。
 * 现有多账号/幂等/修复重装逻辑保留；激活后本地生成两把密钥（决策 #41）。
 */
export async function activateUnit(input: ActivateInput): Promise<UnitInfo> {
  // 授权:离线本地验签(.dysl / .dysd),在线服务端核验授权码。gateway 决定权威方。
  // 渲染层路径不可信：本地授权文件读取前校验扩展名白名单 + 大小上限（gateway 内同步 readFileSync）。
  if (input.kind === 'license-file') {
    assertReadableFile(input.filePath, ['.dysl', '.dysd'])
  }
  const result = await gateway.activate(input)
  const mode = gateway.mode
  return result.role === 'level1' ? activateLevel1(result, mode) : activateSubordinate(result, mode)
}

/** 组装激活记录(两级共用)。 */
function buildActivationRecord(
  result: ActivateResult,
  mode: 'offline' | 'online'
): ActivationState {
  return {
    unitId: result.unit.unitId,
    expiresAt: result.expiresAt,
    role: result.role,
    scope: result.scope,
    mode,
    licenseId: result.licenseId,
    delegationId: result.delegationId,
    signKeyId: result.signKeyId,
    boundFingerprint: result.boundFingerprint ?? null,
    unitToken: result.unitToken
  }
}

/**
 * 幂等 / 修复重装:已添加过该单位账号时,更新授权信息并切库返回;
 * 数据缺失则清残留后返回 null,交由调用方走全新安装。两级共用。
 */
function tryIdempotentEnter(
  result: ActivateResult,
  activationRecord: ActivationState
): UnitInfo | null {
  const accountId = accountIdFor(result.unit.unitId, result.role, result.scope)
  const existingAcc = listAccounts().find((a) => a.accountId === accountId)
  if (!existingAcc) return null
  let hasUnit = false
  try {
    closeDb()
    setActiveAccount(accountId)
    openActiveDb()
    hasUnit = !!getDb().prepare('SELECT 1 FROM unit WHERE id = ? LIMIT 1').get(result.unit.unitId)
  } catch {
    hasUnit = false
  }
  if (hasUnit) {
    // 幂等进入:更新有效期/授权信息并切到该账号；角色专属数据由调用方继续同步。
    setAccountActivation(accountId, activationRecord)
    return {
      id: result.unit.unitId,
      name: result.unit.name,
      unitType: result.unit.unitType,
      createdAt: Date.now()
    }
  }
  // 数据缺失 → 修复重装:清掉残留后重建。
  closeDb()
  deleteAccountDir(accountId)
  return null
}

/** 落库单位配置模板(两级共用)。 */
function insertConfigTemplate(db: Database.Database, cfg: UnitConfig, now: number): void {
  db.prepare(
    `INSERT INTO config_template (id, name, version, revision, status, unit, class_json, student, dyf, calc, rank_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       version = excluded.version,
       revision = excluded.revision,
       status = excluded.status,
       unit = excluded.unit,
       class_json = excluded.class_json,
       student = excluded.student,
       dyf = excluded.dyf,
       calc = excluded.calc,
       rank_json = excluded.rank_json,
       updated_at = excluded.updated_at`
  ).run(
    cfg.id,
    cfg.name,
    cfg.version,
    cfg.revision,
    cfg.status,
    JSON.stringify(cfg.unit),
    JSON.stringify(cfg.class),
    JSON.stringify(cfg.student),
    JSON.stringify(cfg.dyf),
    JSON.stringify(cfg.calc),
    JSON.stringify(cfg.rank),
    now,
    cfg.updatedAt ?? now
  )
}

/**
 * 同步下级授权携带的批次快照。只增量更新同 batchId 的公开/密钥字段，不删除授权中未携带的
 * 历史批次，也不覆盖本机审核/排名/表格导出标记，确保已结束批次仍可查看。
 */
function syncDelegatedBatchSnapshots(db: Database.Database, batches: Batch[] | undefined): number {
  if (!Array.isArray(batches) || batches.length === 0) return 0
  const upsert = db.prepare(
    `INSERT INTO batch (id, year, semester, is_test, status, apply_start_at, apply_end_at, config_template_id,
                        calc_mode, calc_config, rank_scope, public_key_jwk, private_key_jwk, key_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       year = excluded.year,
       semester = excluded.semester,
       is_test = excluded.is_test,
       status = excluded.status,
       apply_start_at = excluded.apply_start_at,
       apply_end_at = excluded.apply_end_at,
       config_template_id = excluded.config_template_id,
       calc_mode = excluded.calc_mode,
       calc_config = excluded.calc_config,
       rank_scope = excluded.rank_scope,
       public_key_jwk = excluded.public_key_jwk,
       private_key_jwk = excluded.private_key_jwk,
       key_id = excluded.key_id,
       updated_at = excluded.updated_at`
  )
  const tx = db.transaction(() => {
    for (const b of batches) {
      upsert.run(
        b.batchId,
        b.year,
        b.semester,
        b.isTest ? 1 : 0,
        b.status,
        b.applyStartAt ?? null,
        b.applyEndAt ?? null,
        b.configTemplateId ?? null,
        b.calcMode,
        JSON.stringify(b.calcConfig),
        JSON.stringify(b.rankScope),
        JSON.stringify(b.publicKeyJwk),
        JSON.stringify(b.privateKeyJwk),
        b.keyId ?? null,
        b.createdAt,
        b.updatedAt
      )
    }
  })
  tx()
  return batches.length
}

/** 更新授权时把下级授权机密段完整同步到已有账号数据库。 */
function syncSubordinateGrantData(result: ActivateResult): number {
  if (!result.applyKeys?.length || !result.unitCert) {
    throw new Error('下级授权文件缺少必要信息(申请密钥 / 单位证书)')
  }
  const db = getDb()
  const now = Date.now()
  insertConfigTemplate(db, result.configTemplate, now)
  db.prepare(
    `UPDATE unit SET name = ?, unit_type = ?, public_key_jwk = ?, config_template_id = ? WHERE id = ?`
  ).run(
    result.unit.name,
    result.unit.unitType,
    JSON.stringify(result.unitCert.payload.signKey.publicKeyJwk),
    result.configTemplate.id,
    result.unit.unitId
  )
  for (const key of result.applyKeys) {
    insertApplyKey({
      keyId: key.keyId,
      unitId: result.unit.unitId,
      publicKeyJwk: key.publicKeyJwk,
      privateKeyJwk: key.privateKeyJwk,
      current: key.current ?? false
    })
  }
  upsertUnitCert(result.unitCert)
  return syncDelegatedBatchSnapshots(db, result.batches)
}

/** 一级激活:本地生成单位签发密钥(RSA-PSS)+ 单位申请密钥(RSA-OAEP),私钥不出本机。 */
async function activateLevel1(
  result: ActivateResult,
  mode: 'offline' | 'online'
): Promise<UnitInfo> {
  const { unit, configTemplate } = result
  const activationRecord = buildActivationRecord(result, mode)
  const entered = tryIdempotentEnter(result, activationRecord)
  if (entered) return entered

  const accountId = accountIdFor(unit.unitId, result.role, result.scope)
  upsertAccount({
    accountId,
    unitId: unit.unitId,
    name: unit.name,
    unitType: unit.unitType,
    parentUnitName: unit.parentUnit?.name,
    role: result.role,
    scope: result.scope,
    expiresAt: result.expiresAt,
    activation: activationRecord
  })
  setActiveAccount(accountId)
  openActiveDb()

  const signPair = await generateSignKeyPair()
  const applyPair = await generateRsaKeyPair()
  if (!(await verifyRsaKeyPair(applyPair))) throw new Error('单位申请密钥对生成失败')

  const db = getDb()
  const now = Date.now()
  db.prepare('DELETE FROM unit WHERE id = ?').run(unit.unitId)
  db.prepare('DELETE FROM config_template WHERE id = ?').run(configTemplate.id)
  db.prepare(
    `INSERT INTO unit (id, name, unit_type, public_key_jwk, private_key_jwk, config_template_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    unit.unitId,
    unit.name,
    unit.unitType,
    JSON.stringify(signPair.publicKeyJwk),
    JSON.stringify(signPair.privateKeyJwk),
    configTemplate.id,
    now
  )
  insertApplyKey({
    keyId: `${unit.unitId}-k1`,
    unitId: unit.unitId,
    publicKeyJwk: applyPair.publicKeyJwk,
    privateKeyJwk: applyPair.privateKeyJwk,
    current: true
  })
  insertConfigTemplate(db, configTemplate, now)
  setSetting('activation', activationRecord)

  // 交付单位申请公钥:online 立即 POST;offline no-op(公钥包由设置页手动导出 .dysk)。
  try {
    await gateway.publishUnitPublicKey()
  } catch {
    // 公钥交付失败不阻断本地激活
  }

  writeAudit({
    operator: 'system',
    role: 'level1',
    scope: 'unit',
    action: `unit.activate.${mode}`,
    target: unit.unitId,
    detail: { name: unit.name, unitType: unit.unitType, expiresAt: result.expiresAt }
  })
  return { id: unit.unitId, name: unit.name, unitType: unit.unitType, createdAt: now }
}

/**
 * 二三级激活(.dysd,dual-mode/12 §3):只存公开信息 + 下发的申请密钥 + 单位证书。
 * 无单位签发私钥(不能再往下签发);有效期已由 gateway 封顶为 min(expiresAt, notAfter)。
 */
async function activateSubordinate(
  result: ActivateResult,
  mode: 'offline' | 'online'
): Promise<UnitInfo> {
  if (!result.applyKeys?.length || !result.unitCert || !result.delegationId) {
    throw new Error('下级授权文件缺少必要信息(申请密钥 / 单位证书)')
  }
  const { unit, configTemplate } = result
  const activationRecord = buildActivationRecord(result, mode)
  const entered = tryIdempotentEnter(result, activationRecord)
  if (entered) {
    const syncedBatches = syncSubordinateGrantData(result)
    writeAudit({
      operator: result.role,
      role: result.role,
      scope: JSON.stringify(result.scope),
      action: `unit.delegated-license.refresh.${mode}`,
      target: unit.unitId,
      detail: {
        delegationId: result.delegationId,
        expiresAt: result.expiresAt,
        batchSnapshots: syncedBatches
      }
    })
    return entered
  }

  const accountId = accountIdFor(unit.unitId, result.role, result.scope)
  upsertAccount({
    accountId,
    unitId: unit.unitId,
    name: unit.name,
    unitType: unit.unitType,
    parentUnitName: unit.parentUnit?.name,
    role: result.role,
    scope: result.scope,
    expiresAt: result.expiresAt,
    activation: activationRecord
  })
  setActiveAccount(accountId)
  openActiveDb()

  const db = getDb()
  const now = Date.now()
  db.prepare('DELETE FROM unit WHERE id = ?').run(unit.unitId)
  db.prepare('DELETE FROM config_template WHERE id = ?').run(configTemplate.id)
  // 只存单位签发公钥,private_key_jwk 为 NULL(schema v8):二三级无签发私钥。
  db.prepare(
    `INSERT INTO unit (id, name, unit_type, public_key_jwk, private_key_jwk, config_template_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    unit.unitId,
    unit.name,
    unit.unitType,
    JSON.stringify(result.unitCert.payload.signKey.publicKeyJwk),
    null,
    configTemplate.id,
    now
  )
  insertConfigTemplate(db, configTemplate, now)
  const syncedBatches = syncSubordinateGrantData(result)
  setSetting('activation', activationRecord)

  writeAudit({
    operator: result.role,
    role: result.role,
    scope: JSON.stringify(result.scope),
    action: `unit.activate-delegated.${mode}`,
    target: unit.unitId,
    detail: {
      role: result.role,
      scope: result.scope,
      delegationId: result.delegationId,
      expiresAt: result.expiresAt,
      batchSnapshots: syncedBatches
    }
  })
  return { id: unit.unitId, name: unit.name, unitType: unit.unitType, createdAt: now }
}

/**
 * 导入单位证书(.dysc,仅 level1):服务商回签,是签发下级授权的信任锚。
 * 验服务商签名 + 核对单位/签发公钥/申请公钥与本机一致后落库;notAfter 与本地有效期不一致则提示。
 */
export async function importUnitCert(
  filePath: string
): Promise<{ notAfter: number; expiryMismatch: boolean }> {
  assertWritable()
  // 扩展名白名单 + 大小上限（渲染层路径不可信；同步读取前先校验）
  assertReadableFile(filePath, ['.dysc'])
  const cert = asUnitCert(parseDysFile(readFileSync(filePath, 'utf-8')))
  await verifyUnitCert(cert, __DMS_LICENSE_VERIFY_KEYS__)
  const unit = readUnitSignKey()
  if (cert.payload.unitId !== unit.unitId) {
    throw new Error('单位证书与本机单位不一致')
  }
  if (canonical(cert.payload.signKey.publicKeyJwk) !== canonical(unit.publicKeyJwk)) {
    throw new Error('单位证书中的签发公钥与本机不一致,请确认公钥包是否为本机导出')
  }
  const applyKey = getCurrentApplyKey()
  if (cert.payload.applyKey.keyId !== applyKey.keyId) {
    throw new Error('单位证书中的申请公钥与本机当前申请密钥不一致,请重新导出公钥包')
  }
  upsertUnitCert(cert)
  const activation = getSetting('activation')
  const expiryMismatch =
    typeof activation?.expiresAt === 'number' && cert.payload.notAfter !== activation.expiresAt
  writeAudit({
    operator: 'level1',
    role: 'level1',
    scope: 'unit',
    action: 'unit.import-cert',
    target: cert.payload.unitId,
    detail: { licenseId: cert.payload.licenseId, notAfter: cert.payload.notAfter, expiryMismatch }
  })
  return { notAfter: cert.payload.notAfter, expiryMismatch }
}

/** 切换账号：关闭当前库，激活目标账号并打开其库（窗口随后重载）。 */
export function switchAccount(accountId: string): void {
  if (!listAccounts().some((a) => a.accountId === accountId)) throw new Error('账号不存在')
  closeDb()
  setActiveAccount(accountId)
  openActiveDb()
}

/** 从验证页返回：恢复到最近使用的账号（不删数据）。无账号时抛错。 */
export function resumeLastAccount(): void {
  const last = listAccounts()[0]
  if (!last) throw new Error('暂无可返回的系统')
  closeDb()
  setActiveAccount(last.accountId)
  openActiveDb()
}

/**
 * 回到验证页：仅清除激活指针，保留账号数据（用于“添加账号”）。
 * 不删除任何账号目录，原账号仍可切回。
 */
export function logoutToVerify(): void {
  closeDb()
  setActiveAccount(null)
}

/**
 * 注销当前账号（换机/移除）：删除该账号数据目录与索引，回到未激活态。
 * 仅删当前账号，其他账号数据不受影响。
 */
export function deactivateCurrent(): void {
  const acc = getActiveAccount()
  if (!acc) return
  closeDb()
  removeAccount(acc.accountId)
  deleteAccountDir(acc.accountId)
  setSetting('activation', undefined)
}

/** online 换机：请求服务端作废旧码签发新码，成功后本机注销回验证页。 */
export async function rebindDevice(reason?: string): Promise<void> {
  const s = getLicenseStatus()
  if (!s.activated) throw new Error('系统未授权')
  if (s.expired) throw new Error('授权已过期，无法更换授权设备，请使用新授权码重新激活')
  await gateway.requestRebind(computeFingerprint(), reason ?? '')
  // 服务端已签发新授权码并作废旧码 → 本机立即注销，退回验证页
  deactivateCurrent()
}

/** 本机机器码（离线授权绑定用；首启激活页与设置页展示）。 */
export function getFingerprint(): { code: string } {
  return { code: computeFingerprint() }
}

/** 验签 + 读 header（不需口令）：激活前展示单位信息供确认。online 返回 null。 */
export function inspectLicense(filePath: string): Promise<LicenseFilePreview | null> {
  // 渲染层路径不可信：读取前校验扩展名白名单 + 大小上限
  assertReadableFile(filePath, ['.dysl', '.dysd'])
  return gateway.inspectLicenseFile(filePath)
}

/** 导出单位公钥包（.dysk）交服务商；online 为 HTTP POST。成功后标记 pubkeyExported。 */
export async function publishPubkey(exportPath?: string): Promise<PublishPubkeyResult> {
  assertLevel1('unit.publish-pubkey')
  const result = await gateway.publishUnitPublicKey(exportPath ? { exportPath } : undefined)
  if (result.exported) {
    const activation = getSetting('activation')
    const acc = getActiveAccount()
    if (activation && acc)
      setAccountActivation(acc.accountId, { ...activation, pubkeyExported: true })
  }
  return result
}

/**
 * offline 换机：导出 .dysr 换机申请文件（不自动注销，决策 06 §5）。
 * `newFingerprint` 是新设备的机器码（用户从新机激活页读取录入）。
 */
export function exportRebindRequest(
  newFingerprint: string,
  reason: string,
  exportPath: string
): Promise<RebindResult> {
  const s = getLicenseStatus()
  if (!s.activated) throw new Error('系统未授权')
  return gateway.requestRebind(newFingerprint, reason, exportPath)
}
