/**
 * 多账号索引：userData/data/accounts.json。
 * 每个账号一个独立 SQLite 目录，天然隔离业务数据与审计日志。
 * 账号身份 = accountId（与单位解耦）：一级 = unitId；二三级 = unitId__role__scopeHash。
 * 同一单位的一级/二级/三级（不同数据范围）是相互独立、数据互不互通的不同账号。
 * 索引仅存展示所需的非敏感信息，私钥永远在各账号自己的库内。
 */
import { app } from 'electron'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { LicenseScope } from './settings'
import { getSetting, setSetting, type ActivationState } from './settings'

/** 授权级别。 */
export type AccountRole = 'level1' | 'level2' | 'level3'

/** 账号索引条目（渲染层可见）。 */
export interface AccountInfo {
  /** 账号 id（账号身份，与单位解耦）：一级 = unitId；二三级 = unitId__role__scopeHash。 */
  accountId: string
  /** 所属单位 id（同一单位可有多个不同角色/范围的独立账号）。 */
  unitId: string
  /** 单位名称。 */
  name: string
  /** 一级单位（学校）名称——完整单位名 = parentUnitName + name（issue #3）；旧账号缺失时回退为 name。 */
  parentUnitName?: string
  /** 单位类型（书院/学院/系）。 */
  unitType: string
  /** 授权级别。 */
  role: AccountRole
  /** 数据范围（二级=年级 / 三级=班级；一级为空）。 */
  scope?: LicenseScope
  /** 授权到期时间。 */
  expiresAt?: number
  /** 该账号的完整激活信息：切换账号时据此恢复全局 settings.activation；旧账号缺失时由角色/范围/到期重建。 */
  activation?: ActivationState
  /** 最近使用时间（排序用）。 */
  lastUsedAt: number
}

interface AccountsFile {
  accounts: AccountInfo[]
  /** 当前激活账号 accountId（null = 未选择，进入验证页）。 */
  activeAccountId: string | null
}

/**
 * 账号身份：一级 = unitId（与历史目录兼容）；二三级 = unitId__role__scopeHash。
 * 同一单位的不同角色/范围据此落到不同目录，数据互不互通。
 */
export function accountIdFor(unitId: string, role: AccountRole, scope?: LicenseScope): string {
  if (role === 'level1') return unitId
  const scopeKey = `${scope?.grade ?? ''}|${scope?.class ?? ''}`
  const hash = createHash('sha256').update(scopeKey).digest('hex').slice(0, 10)
  return `${unitId}__${role}__${hash}`
}

/** 默认数据根目录（userData/data，未自定义时使用）。 */
export function defaultDataDir(): string {
  return join(app.getPath('userData'), 'data')
}

/** 当前数据根目录：读设置中的自定义路径，未设置时用默认值。 */
export function getDataDir(): string {
  return getSetting('dataDir') ?? defaultDataDir()
}

function dataDir(): string {
  return getDataDir()
}

function indexPath(): string {
  return join(dataDir(), 'accounts.json')
}

/**
 * 读账号索引（含旧格式迁移）：
 * - 旧条目缺 accountId → 回填 accountId=unitId（历史均为一级，目录不变）；
 * - 旧字段 activeUnitId → 映射为 activeAccountId。
 */
function read(): AccountsFile {
  let raw: (Partial<AccountsFile> & { activeUnitId?: string | null }) | null = null
  try {
    raw = JSON.parse(readFileSync(indexPath(), 'utf-8'))
  } catch {
    return { accounts: [], activeAccountId: null }
  }
  const list = (raw?.accounts ?? []) as Array<AccountInfo & { accountId?: string }>
  const accounts: AccountInfo[] = list.map((a) => ({ ...a, accountId: a.accountId ?? a.unitId }))
  const activeAccountId = raw?.activeAccountId ?? raw?.activeUnitId ?? null
  return { accounts, activeAccountId }
}

function write(file: AccountsFile): void {
  mkdirSync(dirname(indexPath()), { recursive: true })
  writeFileSync(indexPath(), JSON.stringify(file, null, 2))
}

/** 列出全部账号（按最近使用倒序）。 */
export function listAccounts(): AccountInfo[] {
  return read().accounts.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}

/** 当前激活账号（未选择返回 null）。 */
export function getActiveAccount(): AccountInfo | null {
  const f = read()
  return f.accounts.find((a) => a.accountId === f.activeAccountId) ?? null
}

/** 是否已有任何账号（决定验证页是否展示“返回”）。 */
export function hasAccounts(): boolean {
  return read().accounts.length > 0
}

/** 新增/更新账号索引（激活成功后调用）。 */
export function upsertAccount(info: Omit<AccountInfo, 'lastUsedAt'>): void {
  const f = read()
  const now = Date.now()
  const i = f.accounts.findIndex((a) => a.accountId === info.accountId)
  if (i >= 0) f.accounts[i] = { ...info, lastUsedAt: now }
  else f.accounts.push({ ...info, lastUsedAt: now })
  write(f)
}

/** 设置当前激活账号（切库前调用）：更新指针与最近使用时间，并把该账号的激活信息同步到全局。 */
export function setActiveAccount(accountId: string | null): void {
  const f = read()
  f.activeAccountId = accountId
  if (accountId) {
    const acc = f.accounts.find((a) => a.accountId === accountId)
    if (acc) acc.lastUsedAt = Date.now()
  }
  write(f)
  syncActiveActivation()
}

/** 把当前激活账号的授权信息同步到全局 settings.activation（启动/切换/激活后调用，确保各处读取反映当前账号）。 */
export function syncActiveActivation(): void {
  const acc = getActiveAccount()
  if (!acc) {
    setSetting('activation', undefined)
    return
  }
  if (acc.activation) {
    setSetting('activation', acc.activation)
    return
  }
  // 旧账号未按账号存 activation：若全局 activation 恰属于本账号，沿用其完整信息（含 licenseId 等），
  // 否则按 AccountInfo 重建关键字段；随后回填账号存储，下次切换即完整恢复。
  const global = getSetting('activation')
  const belongs =
    !!global &&
    global.unitId === acc.unitId &&
    (global.role ?? 'level1') === acc.role &&
    (global.scope?.grade ?? '') === (acc.scope?.grade ?? '') &&
    (global.scope?.class ?? '') === (acc.scope?.class ?? '')
  const activation: ActivationState = belongs
    ? (global as ActivationState)
    : { unitId: acc.unitId, expiresAt: acc.expiresAt ?? 0, role: acc.role, scope: acc.scope }
  setAccountActivation(acc.accountId, activation)
}

/** 更新某账号存储的激活信息；若为当前激活账号，同步刷新全局 settings.activation。 */
export function setAccountActivation(accountId: string, activation: ActivationState): void {
  const f = read()
  const acc = f.accounts.find((a) => a.accountId === accountId)
  if (!acc) return
  acc.activation = activation
  acc.expiresAt = activation.expiresAt
  acc.role = activation.role ?? acc.role
  acc.scope = activation.scope
  write(f)
  if (f.activeAccountId === accountId) setSetting('activation', activation)
}

/** 移除账号索引（删库目录前调用）。 */
export function removeAccount(accountId: string): void {
  const f = read()
  f.accounts = f.accounts.filter((a) => a.accountId !== accountId)
  if (f.activeAccountId === accountId) f.activeAccountId = null
  write(f)
}

/** 某账号的数据目录（userData/data/accounts/<accountId>）。 */
export function accountDir(accountId: string): string {
  return join(dataDir(), 'accounts', accountId)
}

/** 某账号的 SQLite 文件路径。 */
export function accountDbPath(accountId: string): string {
  return join(accountDir(accountId), 'dms.db')
}

/** 删除某账号的整个数据目录（注销/换机）。 */
export function deleteAccountDir(accountId: string): void {
  const dir = accountDir(accountId)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}

/** 确保数据根目录存在。 */
export function ensureDataDir(): void {
  mkdirSync(dataDir(), { recursive: true })
}
