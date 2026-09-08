/**
 * 单位配置服务：单位配置（UnitConfig）读取（架构文档 §3.2，决策 #38）。
 * 配置由服务端写好并下发（激活时导入），管理端只读，不提供创建/编辑能力。
 * 表 config_template 存 UnitConfig 各段 JSON（unit/class/student/dyf/calc/rank）。
 */
import type {
  ClassCascader,
  DyfConfig,
  StudentField,
  UnitBinding,
  UnitCalcConfig,
  UnitConfig,
  UnitConfigStatus,
  UnitRankConfig
} from '@sces/shared'
import { getDb } from '../db'

/** 行 → 单位配置对象（解析各段 JSON）。 */
function rowToTemplate(row: Record<string, unknown>): UnitConfig {
  return {
    schemaVersion: 1,
    id: row.id as string,
    name: row.name as string,
    version: row.version as number,
    revision: row.revision as number,
    status: row.status as UnitConfigStatus,
    unit: JSON.parse(row.unit as string) as UnitBinding,
    class: JSON.parse(row.classJson as string) as ClassCascader,
    student: JSON.parse(row.student as string) as StudentField[],
    dyf: JSON.parse(row.dyf as string) as DyfConfig,
    calc: JSON.parse(row.calc as string) as UnitCalcConfig,
    rank: JSON.parse(row.rankJson as string) as UnitRankConfig,
    updatedAt: row.updatedAt as number
  }
}

/** 列选择（class/rank 为 SQL 保留字，用 _json 后缀列，别名回 camelCase）。 */
const SELECT_COLUMNS = `id, name, version, revision, status, unit, class_json AS classJson,
       student, dyf, calc, rank_json AS rankJson, created_at AS createdAt, updated_at AS updatedAt`

/** 单位配置详情。 */
export function getTemplate(id: string): UnitConfig | null {
  const db = getDb()
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM config_template WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined
  return row ? rowToTemplate(row) : null
}

/** 最新已发布配置（批次创建时的回退配置：单位未绑定配置时使用，决策 #20）。 */
export function getLatestPublishedTemplate(): UnitConfig | null {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM config_template
       WHERE status = 'published'
       ORDER BY updated_at DESC LIMIT 1`
    )
    .get() as Record<string, unknown> | undefined
  return row ? rowToTemplate(row) : null
}

/** 当前单位的班级级联(签发下级授权时选数据范围用;未激活/无配置返回空)。 */
export function getActiveUnitClassOptions(): ClassCascader {
  const db = getDb()
  const row = db.prepare('SELECT config_template_id AS id FROM unit LIMIT 1').get() as
    | { id: string | null }
    | undefined
  if (!row?.id) return { titles: [], options: [] }
  return getTemplate(row.id)?.class ?? { titles: [], options: [] }
}
