/**
 * SQLite 数据库初始化与迁移。
 * 多账号：每个账号（单位）一个独立目录 userData/data/accounts/<unitId>/dms.db，
 * 业务数据与审计日志按账号天然隔离。WAL 模式，外键约束开启。
 */
import Database from 'better-sqlite3'
import { app } from 'electron'
import { mkdirSync, existsSync, readFileSync, renameSync, unlinkSync } from 'fs'
import { dirname, join } from 'path'
import { MIGRATIONS } from './schema'
import {
  getActiveAccount,
  accountDbPath,
  ensureDataDir,
  upsertAccount,
  setActiveAccount,
  syncActiveActivation
} from '../services/accounts'

let db: Database.Database | null = null

/** 获取数据库连接（未初始化时抛错）。 */
export function getDb(): Database.Database {
  if (!db) throw new Error('数据库未初始化')
  return db
}

/** 当前账号的 SQLite 文件路径（基于激活账号指针）。 */
export function getDbPath(): string {
  const acc = getActiveAccount()
  if (!acc) throw new Error('无激活账号')
  return accountDbPath(acc.accountId)
}

/**
 * 执行迁移：按 PRAGMA user_version 逐版本升级。
 *
 * 外键处理：涉及表重建（DROP/RENAME 被引用表）的迁移在有存量数据时会触发
 * FOREIGN KEY constraint failed，而 `PRAGMA foreign_keys` 在事务内为 no-op、
 * 必须在事务外设置（SQLite 官方表重建法约定）。故此处在整个迁移循环外先关外键，
 * 全部迁移完成后在事务外用 foreign_key_check 校验完整性再重开——既允许 v6 这类
 * 重建迁移，又保证迁移后引用关系无悬挂。
 */
function migrate(database: Database.Database): void {
  const current = database.pragma('user_version', { simple: true }) as number
  if (current >= MIGRATIONS.length) return

  // 事务外关外键（事务内设置无效）
  database.pragma('foreign_keys = OFF')
  try {
    for (let v = current; v < MIGRATIONS.length; v++) {
      database.exec('BEGIN')
      try {
        database.exec(MIGRATIONS[v])
        database.pragma(`user_version = ${v + 1}`)
        database.exec('COMMIT')
      } catch (err) {
        database.exec('ROLLBACK')
        // 迁移失败的底层原因（SQLite 英文错误）不展示给用户，统一给中文提示
        void err
        throw new Error(`数据库迁移失败（v${v} → v${v + 1}），请尝试重启应用或联系服务商`)
      }
    }
    // 迁移后校验引用完整性（关外键期间的重建不应留下悬挂外键）
    const violations = database.pragma('foreign_key_check') as unknown[]
    if (violations.length > 0) {
      throw new Error('数据库迁移后完整性校验未通过，请尝试重启应用或联系服务商')
    }
  } finally {
    // 无论成败都恢复外键约束（连接级设置）
    database.pragma('foreign_keys = ON')
  }
}

/**
 * 早期“一键补全基础分”曾把分类名称写入 dyf_score.category；计算引擎使用分类 code。
 * v13 前执行一次模板驱动修复，避免已有数据库中的基础分被错误归类。
 */
function repairLegacyScoreCategories(database: Database.Database): void {
  const templates = database.prepare('SELECT id, dyf FROM config_template').all() as Array<{
    id: string
    dyf: string
  }>
  const selectRows = database.prepare(
    `SELECT ds.id, ds.item_code AS itemCode, ds.category
     FROM dyf_score ds
     JOIN apply a ON a.apply_id = ds.apply_id
     JOIN batch b ON b.id = a.batch_id
     WHERE b.config_template_id = ?`
  )
  const update = database.prepare('UPDATE dyf_score SET category = ? WHERE id = ?')

  database.transaction(() => {
    for (const template of templates) {
      let dyf: { categories?: Array<{ code?: string; groups?: Array<{ items?: Array<{ code?: string }> }> }> }
      try {
        dyf = JSON.parse(template.dyf) as typeof dyf
      } catch {
        continue
      }
      const categoryByItem = new Map<string, string>()
      for (const category of Array.isArray(dyf.categories) ? dyf.categories : []) {
        if (!category.code) continue
        for (const group of Array.isArray(category.groups) ? category.groups : []) {
          for (const item of Array.isArray(group.items) ? group.items : []) {
            if (item.code) categoryByItem.set(item.code, category.code)
          }
        }
      }
      const rows = selectRows.all(template.id) as Array<{ id: number; itemCode: string; category: string }>
      for (const row of rows) {
        const expected = categoryByItem.get(row.itemCode)
        if (expected && expected !== row.category) update.run(expected, row.id)
      }
    }
  })()
}

/** 打开指定账号的数据库（先关闭旧连接）。 */
export function openDb(dbPath: string): Database.Database {
  if (db) {
    db.close()
    db = null
  }
  mkdirSync(dirname(dbPath), { recursive: true })
  db = new Database(dbPath)
  migrate(db)
  seedTemplates(db)
  // 幂等修复旧的“分类名称污染”（早期一键补全基础分把分类名称写进 dyf_score.category，
  // 计算引擎用 category code）。每次打开都执行：只修正与模板预期不一致的行，
  // 不依赖“迁移前版本 < v13”的一次性门——中断过的库在下次打开也会最终修复。
  repairLegacyScoreCategories(db)
  return db
}

/** 关闭数据库（应用退出或切换账号前调用）。 */
export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

/** 打开当前激活账号的库（启动/切换账号后调用）。无激活账号时返回 false。 */
export function openActiveDb(): boolean {
  const acc = getActiveAccount()
  if (!acc) return false
  openDb(accountDbPath(acc.accountId))
  syncActiveActivation()
  return true
}

/**
 * 一次性迁移旧版单库（userData/data/dms.db → accounts/<unitId>/dms.db）。
 * 从旧库 unit 表读出单位信息建立账号索引并设为激活；失败则跳过（不影响新装）。
 */
export function migrateLegacyIfNeeded(): void {
  ensureDataDir()
  if (getActiveAccount()) return // 已是多账号结构
  const legacyPath = join(app.getPath('userData'), 'data', 'dms.db')
  if (!existsSync(legacyPath)) return

  let legacy: Database.Database | null = null
  try {
    legacy = new Database(legacyPath, { readonly: true })
    const unit = legacy
      .prepare('SELECT id, name, unit_type AS unitType FROM unit LIMIT 1')
      .get() as { id: string; name: string; unitType: string } | undefined
    if (!unit) return
    legacy.close()
    legacy = null

    // 建立账号索引并把旧库文件整体迁移到账号目录
    upsertAccount({ accountId: unit.id, unitId: unit.id, name: unit.name, unitType: unit.unitType, role: 'level1' })
    const target = accountDbPath(unit.id)
    mkdirSync(dirname(target), { recursive: true })
    renameSync(legacyPath, target)
    // 清理旧 WAL/SHM 残留
    for (const suffix of ['-wal', '-shm']) {
      const f = legacyPath + suffix
      if (existsSync(f)) unlinkSync(f)
    }
    setActiveAccount(unit.id)
  } catch {
    // 迁移失败不阻塞启动（按未激活处理，用户重新激活）
    if (legacy) legacy.close()
  }
}

/** 内置配置模板文件（决策 #18/#38：励行书院默认配置 + 测试配置；由契约种子同步而来）。 */
const SEED_TEMPLATE_FILES = ['lixing-shuyuan.json', 'test-1.json']

/** 模板目录：dev 在应用根 resources/，生产在 asar.unpacked/resources/。 */
function templatesDir(): string {
  const candidates = [
    join(app.getAppPath(), 'resources', 'templates'),
    join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'templates')
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return candidates[0]
}

/**
 * 幂等种子化内置单位配置（决策 #18/#38：契约种子为唯一权威，构建时同步到 resources）。
 * 按配置 id INSERT OR IGNORE：已存在的（如服务端下发过）不覆盖；
 * 新种子 updated_at=now，成为「最新已发布配置」，新批次默认使用励行书院配置。
 */
function seedTemplates(database: Database.Database): void {
  const dir = templatesDir()
  const now = Date.now()
  const insert = database.prepare(
    `INSERT OR IGNORE INTO config_template (id, name, version, revision, status, unit, class_json, student, dyf, calc, rank_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const file of SEED_TEMPLATE_FILES) {
    const p = join(dir, file)
    if (!existsSync(p)) continue
    let tpl: Record<string, unknown>
    try {
      tpl = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof tpl.id !== 'string' || !tpl.id) continue
    insert.run(
      tpl.id,
      String(tpl.name ?? tpl.id),
      Number(tpl.version ?? 1),
      Number(tpl.revision ?? 0),
      String(tpl.status ?? 'published'),
      JSON.stringify(tpl.unit ?? {}),
      JSON.stringify(tpl.class ?? { titles: [], options: [] }),
      JSON.stringify(tpl.student ?? []),
      JSON.stringify(tpl.dyf ?? { categories: [] }),
      JSON.stringify(tpl.calc ?? { calcMode: 'weighted', dyfWeight: 0.3, courseWeight: 0.7 }),
      JSON.stringify(tpl.rank ?? { tieRule: 'same-rank' }),
      now,
      now
    )
  }
}
