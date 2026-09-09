/**
 * 单位（账号）服务：管理端激活成为单位管理员。
 * 激活权威 = 服务端（gateway online：POST /authorize 核验授权码）。
 * 激活后本地生成单位申请密钥（RSA-OAEP，apply_key 表），私钥不出本机；
 * 申请公钥随激活即时上报服务端（学生 .dyf 加密对接）。
 * 多账号：激活成功后写入账号索引并打开该账号独立库；可同时保留多个账号并切换。
 * 离线授权链（.dysl/.dysd 授权文件、机器码、单位证书/委派）已随离线版下线移除。
 */
import type Database from 'better-sqlite3'
import { generateRsaKeyPair, verifyRsaKeyPair } from '@sces/shared'
import type { UnitBinding, UnitConfig } from '@sces/shared'
import { is } from '@electron-toolkit/utils'
import { closeDb, openActiveDb, getDb } from '../db'
import { gateway } from '../gateway'
import type { ActivateResult } from '../gateway/types'
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
import { getCurrentApplyKeyOrNull, insertApplyKey } from './apply-key'
import { assertWritable, getLicenseStatus, type LicenseStatus } from './license'
import type { ActivateInput, ActivationInfo } from '../../preload/types'

/** 单位信息（不含私钥）。完整单位名 = parentUnitName（学校）+ name（二级独立单位）。 */
export interface UnitInfo {
  id: string
  name: string
  unitType: string
  createdAt: number
  /** 学校名称——单位完整名的第一部分；旧配置/回退时 undefined。 */
  parentUnitName?: string
  /** 学校单位 id。 */
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

/** 绑定配置模板里的学校单位——单位完整名的第一部分。 */
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

/** 账号列表（侧边栏切换）。回填当前单位各账号的学校名。 */
export function getAccounts(): AccountInfo[] {
  const accounts = listAccounts()
  const active = getActiveAccount()
  const parent = boundParentUnit()
  if (active && parent?.name) {
    for (const a of accounts) if (a.unitId === active.unitId) a.parentUnitName = parent.name
  }
  return accounts
}

/** 是否已有任何账号（决定验证页是否展示"返回我的系统"）。 */
export function hasAnyAccount(): boolean {
  return hasAccounts()
}

/** 授权状态（过期只读判定）。 */
export function getLicense(): LicenseStatus {
  return getLicenseStatus()
}

/** 获取激活信息（设置页展示：单位/角色/授权 id/申请密钥 keyId/配置版本/发布档）。 */
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
    role: activation?.role,
    scope: activation?.scope,
    licenseId: activation?.licenseId,
    keyId: applyKey?.keyId,
    profileId: __DMS_PROFILE_ID__,
    configVersion
  }
}

/** 激活（服务端核验授权码）。现有多账号/幂等/修复重装逻辑保留。 */
export async function activateUnit(input: ActivateInput): Promise<UnitInfo> {
  const result = await gateway.activate({ code: input.code })
  return activateLevel1(result)
}

/** 组装激活记录。 */
function buildActivationRecord(result: ActivateResult): ActivationState {
  return {
    unitId: result.unit.unitId,
    expiresAt: result.expiresAt,
    role: result.role,
    scope: result.scope,
    licenseId: result.licenseId,
    unitToken: result.unitToken
  }
}

/**
 * 幂等 / 修复重装：已添加过该单位账号时，更新授权信息并切库返回；
 * 数据缺失则清残留后返回 null，交由调用方走全新安装。
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
    // 幂等进入：更新授权信息并切到该账号。
    setAccountActivation(accountId, activationRecord)
    return {
      id: result.unit.unitId,
      name: result.unit.name,
      unitType: result.unit.unitType,
      createdAt: Date.now()
    }
  }
  // 数据缺失 → 修复重装：清掉残留后重建。
  closeDb()
  deleteAccountDir(accountId)
  return null
}

/** 落库单位配置模板。 */
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

/** 单位激活：本地生成单位申请密钥（RSA-OAEP），私钥不出本机。 */
async function activateLevel1(result: ActivateResult): Promise<UnitInfo> {
  const { unit, configTemplate } = result
  const activationRecord = buildActivationRecord(result)
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

  const applyPair = await generateRsaKeyPair()
  if (!(await verifyRsaKeyPair(applyPair))) throw new Error('单位申请密钥对生成失败')

  const db = getDb()
  const now = Date.now()
  db.prepare('DELETE FROM unit WHERE id = ?').run(unit.unitId)
  db.prepare('DELETE FROM config_template WHERE id = ?').run(configTemplate.id)
  db.prepare(
    `INSERT INTO unit (id, name, unit_type, config_template_id, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(unit.unitId, unit.name, unit.unitType, configTemplate.id, now)
  insertApplyKey({
    keyId: `${unit.unitId}-k1`,
    unitId: unit.unitId,
    publicKeyJwk: applyPair.publicKeyJwk,
    privateKeyJwk: applyPair.privateKeyJwk,
    current: true
  })
  insertConfigTemplate(db, configTemplate, now)
  setSetting('activation', activationRecord)

  // 交付单位申请公钥：即时上报服务端（失败不阻断本地激活，批次上报时服务端会提示缺钥）。
  try {
    await gateway.publishUnitPublicKey()
  } catch {
    // 公钥交付失败不阻断本地激活
  }

  writeAudit({
    operator: 'system',
    role: 'level1',
    scope: 'unit',
    action: 'unit.activate.online',
    target: unit.unitId,
    detail: { name: unit.name, unitType: unit.unitType, expiresAt: result.expiresAt }
  })
  return { id: unit.unitId, name: unit.name, unitType: unit.unitType, createdAt: now }
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
 * 回到验证页：仅清除激活指针，保留账号数据（用于"添加账号"）。
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
  assertWritable()
  await gateway.requestRebind(reason ?? '')
  // 服务端已受理换机 → 本机立即注销，退回验证页（新机以新 installId 重新激活）。
  deactivateCurrent()
}
