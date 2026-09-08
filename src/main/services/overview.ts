/**
 * 德育分总览服务（M3）：批次维度的数据看板。
 * 统计全部走 SQL 聚合（COUNT/GROUP BY/SUM），避免全量内存扫描（架构 §11）。
 * 总体情况大表格：模板全量条目为列、按学生取全量（滚动呈现，决策 #19）、支持班级筛选与排序。
 */
import type { ApplyStatus, BatchStatus } from '@sces/shared'
import { calcDyfTotal, extractDyfTotalConfig } from '@sces/shared'
import { getDb } from '../db'
import { getBatch } from './batch'
import { getTemplate } from './config-template'
import { currentRole, currentScope, studentScopeSql } from './role'
import { isRankingFresh } from './ranking'

/** 总览数据。 */
export interface BatchOverview {
  batch: {
    year: number
    semester: 1 | 2
    isTest: boolean
    status: BatchStatus
    /** 班级端审核完成时间（整班导出，决策 #17）。 */
    classReviewedAt?: number
  }
  /** 学生总数（含已导入申请与仅建档）。 */
  studentCount: number
  /** 申请总数。 */
  applyCount: number
  /** 各状态申请数（draft/submitted/imported/reviewing/confirmed）。 */
  statusCounts: Record<ApplyStatus, number>
  /** 待处理学号冲突数。 */
  conflictCount: number
  /** 参与排名人数（final_grade 行数：已导入/审核中/已确认学生，需先点「计算排名」）。 */
  rankedCount: number
  /** 参与排名学生德育分总分（用于计算平均分）。 */
  rankedSum: number
  /** 班级列表（总体情况班级筛选用，决策 #19）。 */
  classes: string[]
  /** 当前数据范围内的班级数量。 */
  classCount: number
  /** 最近一次导入申请时间。 */
  latestImportAt?: number
  /** 最近一次分数/名单变更时间。 */
  scoresChangedAt?: number
  /** 最近一次成功导出公示表格时间。 */
  tableExportedAt?: number
  /** 参与排名学生平均分（未计算排名时为 undefined）。 */
  avgScore?: number
  /** 参与排名学生最高分（未计算排名时为 undefined）。 */
  maxScore?: number
  /** 参与排名学生最低分（未计算排名时为 undefined）。 */
  minScore?: number
  /** 最近一次排名计算时间（未计算为 undefined）。 */
  rankedAt?: number
  /** 排名是否过期（分数在计算后又变更，或从未计算）：为真时禁止导出。 */
  rankingStale: boolean
}

/** 批次德育分总览。 */
export function getBatchOverview(batchId: string): BatchOverview {
  const db = getDb()
  const batch = getBatch(batchId)
  if (!batch) throw new Error('批次不存在')

  // 数据范围(安全边界):level3 限本班、level2 限本年级、level1 全单位。涉及 student 的统计一律 JOIN 后过滤。
  const sc = studentScopeSql({ grade: 's.grade', class: 's.class_name' })

  const studentCount = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM student s WHERE s.batch_id = ?${sc.clause}`)
      .get(batchId, ...sc.params) as {
      c: number
    }
  ).c
  const applyCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM apply a JOIN student s ON s.id = a.student_id WHERE a.batch_id = ?${sc.clause}`
      )
      .get(batchId, ...sc.params) as { c: number }
  ).c
  const conflictCount = (
    db.prepare('SELECT COUNT(*) AS c FROM import_conflict WHERE batch_id = ?').get(batchId) as {
      c: number
    }
  ).c

  const statusCounts: Record<ApplyStatus, number> = {
    draft: 0,
    submitted: 0,
    imported: 0,
    reviewing: 0,
    confirmed: 0
  }
  const statusRows = db
    .prepare(
      `SELECT a.status AS status, COUNT(*) AS c FROM apply a JOIN student s ON s.id = a.student_id
       WHERE a.batch_id = ?${sc.clause} GROUP BY a.status`
    )
    .all(batchId, ...sc.params) as Array<{ status: ApplyStatus; c: number }>
  for (const r of statusRows) {
    if (r.status in statusCounts) statusCounts[r.status] = r.c
  }

  const rankedRow = db
    .prepare(
      `SELECT COUNT(*) AS c, COALESCE(SUM(f.dyf_total), 0) AS total
       FROM final_grade f JOIN student s ON s.id = f.student_id
       WHERE f.batch_id = ?${sc.clause}`
    )
    .get(batchId, ...sc.params) as { c: number; total: number }

  // 班级列表(去空)
  const classRows = db
    .prepare(
      `SELECT DISTINCT s.class_name AS className FROM student s
       WHERE s.batch_id = ? AND s.class_name IS NOT NULL AND s.class_name != ''${sc.clause}
       ORDER BY s.class_name`
    )
    .all(batchId, ...sc.params) as Array<{ className: string }>

  // 参与排名学生平均/最高/最低（final_grade = 已算排名的学生集）
  const statRow = db
    .prepare(
      `SELECT AVG(f.dyf_total) AS avgScore, MAX(f.dyf_total) AS maxScore, MIN(f.dyf_total) AS minScore
       FROM final_grade f JOIN student s ON s.id = f.student_id WHERE f.batch_id = ?${sc.clause}`
    )
    .get(batchId, ...sc.params) as {
    avgScore: number | null
    maxScore: number | null
    minScore: number | null
  }
  const latestImportRow = db
    .prepare(
      `SELECT MAX(COALESCE(a.last_imported_at, a.imported_at)) AS latestImportAt
       FROM apply a JOIN student s ON s.id = a.student_id
       WHERE a.batch_id = ?${sc.clause}`
    )
    .get(batchId, ...sc.params) as { latestImportAt: number | null }

  return {
    batch: {
      year: batch.year,
      semester: batch.semester,
      isTest: batch.isTest === true,
      status: batch.status,
      classReviewedAt: batch.classReviewedAt ?? undefined
    },
    studentCount,
    applyCount,
    statusCounts,
    conflictCount,
    rankedCount: rankedRow.c,
    rankedSum: rankedRow.total,
    classes: classRows.map((r) => r.className),
    classCount: classRows.length,
    latestImportAt: latestImportRow.latestImportAt ?? undefined,
    scoresChangedAt: batch.scoresChangedAt,
    tableExportedAt: batch.tableExportedAt,
    avgScore: statRow.avgScore ?? undefined,
    maxScore: statRow.maxScore ?? undefined,
    minScore: statRow.minScore ?? undefined,
    rankedAt: batch.rankedAt,
    rankingStale: !isRankingFresh(batch)
  }
}

/** 总体情况大表格：列（模板条目，按类别/分组顺序）。 */
export interface ScoreTableColumn {
  itemCode: string
  category: string
  description: string
}

/** 总体情况大表格：行（一位学生）。 */
export interface ScoreTableRow {
  studentId: string
  name: string
  className?: string
  grade?: string
  major?: string
  /** 德育分总分（finalScore 优先，未审项按 appliedScore）。 */
  dyfTotal: number
  /** itemCode → 得分（finalScore ?? appliedScore）；学生未申请的条目不出现。 */
  scores: Record<string, number>
  /** 已确认学生的排名（决策 #21：仅班级排名 + 专业排名）。 */
  rankClass?: number
  rankMajor?: number
}

/** 总体情况大表格结果（全量，滚动呈现）。 */
export interface ScoreTableResult {
  columns: ScoreTableColumn[]
  rows: ScoreTableRow[]
  total: number
}

export interface ScoreTableQueryOptions {
  search?: string
  classes?: string[]
  limit?: number
  offset?: number
}

interface ScoreTableFilter {
  whereSql: string
  params: Record<string, unknown>
}

/** 页面查询、导出元数据和流式导出共用同一筛选/scope 边界。 */
function buildScoreTableFilter(
  batchId: string,
  options: Pick<ScoreTableQueryOptions, 'search' | 'classes'>
): ScoreTableFilter {
  const where: string[] = ['a.batch_id = @batchId']
  const params: Record<string, unknown> = { batchId }
  const { search, classes } = options
  if (search && search.trim()) {
    where.push('(s.student_id LIKE @kw OR s.name LIKE @kw)')
    params.kw = `%${search.trim()}%`
  }
  if (classes && classes.length) {
    const placeholders = classes.map((_, i) => `@cls${i}`).join(',')
    where.push(`s.class_name IN (${placeholders})`)
    classes.forEach((c, i) => {
      params[`cls${i}`] = c
    })
  }
  const scopeRole = currentRole()
  const scopeVal = currentScope()
  if (scopeRole === 'level3' && scopeVal.class && scopeVal.grade) {
    where.push('s.class_name = @scopeClass AND s.grade = @scopeGrade')
    params.scopeClass = scopeVal.class
    params.scopeGrade = scopeVal.grade
  } else if (scopeRole === 'level3') {
    where.push('1 = 0')
  } else if (scopeRole === 'level2' && scopeVal.grade) {
    where.push('s.grade = @scopeGrade')
    params.scopeGrade = scopeVal.grade
  }
  return { whereSql: where.join(' AND '), params }
}

/** 流式导出标题与分页边界所需的轻量聚合信息。 */
export function getScoreTableDimensions(
  batchId: string,
  options: Pick<ScoreTableQueryOptions, 'search' | 'classes'> = {}
): { total: number; grade?: string; major?: string; className?: string } {
  const batch = getBatch(batchId)
  if (!batch) throw new Error('批次不存在')
  const { whereSql, params } = buildScoreTableFilter(batchId, options)
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS total,
              CASE WHEN COUNT(DISTINCT NULLIF(s.grade, '')) = 1 THEN MAX(NULLIF(s.grade, '')) END AS grade,
              CASE WHEN COUNT(DISTINCT NULLIF(s.major, '')) = 1 THEN MAX(NULLIF(s.major, '')) END AS major,
              CASE WHEN COUNT(DISTINCT NULLIF(s.class_name, '')) = 1 THEN MAX(NULLIF(s.class_name, '')) END AS className
       FROM apply a JOIN student s ON s.id = a.student_id
       WHERE ${whereSql}`
    )
    .get(params) as {
    total: number
    grade: string | null
    major: string | null
    className: string | null
  }
  return {
    total: row.total,
    grade: row.grade ?? undefined,
    major: row.major ?? undefined,
    className: row.className ?? undefined
  }
}

/**
 * 总体情况大表格：模板全量条目为列，按学生取全量（决策 #19：滚动呈现，不分页）。
 * 列只算一次；行明细与排名按页取（apply → dyf_score / final_grade）。
 * classes 为空数组 = 全部班级。
 */
export function getScoreTable(
  batchId: string,
  options: ScoreTableQueryOptions = {}
): ScoreTableResult {
  const db = getDb()
  const batch = getBatch(batchId)
  if (!batch) throw new Error('批次不存在')

  const template = batch.configTemplateId ? getTemplate(batch.configTemplateId) : null
  const totalConfig = extractDyfTotalConfig(template)
  const columns: ScoreTableColumn[] = []
  if (template) {
    for (const category of template.dyf.categories) {
      for (const group of category.groups) {
        for (const item of group.items) {
          columns.push({
            itemCode: item.code,
            category: category.name,
            description: item.description
          })
        }
      }
    }
  }

  // 主进程钳制分页参数：渲染层参数不可信，勿让其驱动全量物化（每行带逐项分数 map）。
  // 上限 5000，与渲染层常量一致；非法值归一化而不是抛错，避免一次坏参数打挂整个页面。
  const MAX_TABLE_LIMIT = 5000
  const rawLimit = Number(options?.limit ?? 10000)
  const rawOffset = Number(options?.offset ?? 0)
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), MAX_TABLE_LIMIT) : 10000
  const offset = Number.isFinite(rawOffset) ? Math.max(Math.floor(rawOffset), 0) : 0
  const filter = buildScoreTableFilter(batchId, options)
  const whereSql = filter.whereSql
  const params: Record<string, unknown> = { ...filter.params, limit, offset }

  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM apply a JOIN student s ON s.id = a.student_id WHERE ${whereSql}`
      )
      .get(params) as { c: number }
  ).c

  const rows = db
    .prepare(
      `SELECT a.apply_id AS applyId, a.status, s.id AS studentDbId, s.student_id AS studentId,
              s.name, s.class_name AS className, s.grade, s.major
       FROM apply a JOIN student s ON s.id = a.student_id
       WHERE ${whereSql}
       ORDER BY s.student_id
       LIMIT @limit OFFSET @offset`
    )
    .all(params) as Array<Record<string, unknown>>

  // 按页取明细与排名
  const applyIds = rows.map((r) => r.applyId as string)
  const scoresByApply = new Map<
    string,
    Array<{ categoryCode: string; itemNumber: string; score: number }>
  >()
  const rankByStudent = new Map<number, { rankClass?: number; rankMajor?: number }>()
  if (applyIds.length) {
    const placeholders = applyIds.map(() => '?').join(',')
    const scoreRows = db
      .prepare(
        `SELECT apply_id AS applyId, category, item_code AS itemCode,
                applied_score AS appliedScore, final_score AS finalScore
         FROM dyf_score WHERE apply_id IN (${placeholders})`
      )
      .all(...applyIds) as Array<Record<string, unknown>>
    for (const s of scoreRows) {
      const list = scoresByApply.get(s.applyId as string) ?? []
      list.push({
        categoryCode: s.category as string,
        itemNumber: s.itemCode as string,
        score: ((s.finalScore as number | null) ?? (s.appliedScore as number)) as number
      })
      scoresByApply.set(s.applyId as string, list)
    }

    const rankRows = db
      .prepare(
        `SELECT s.id AS studentDbId, f.rank_class AS rankClass, f.rank_major AS rankMajor
         FROM final_grade f JOIN student s ON s.id = f.student_id
         WHERE f.batch_id = ? AND s.student_id IN (${placeholders})`
      )
      .all(batchId, ...rows.map((r) => r.studentId as string)) as Array<Record<string, unknown>>
    for (const r of rankRows) {
      rankByStudent.set(r.studentDbId as number, {
        rankClass: (r.rankClass as number | null) ?? undefined,
        rankMajor: (r.rankMajor as number | null) ?? undefined
      })
    }
  }

  const items: ScoreTableRow[] = rows.map((r) => {
    const details = scoresByApply.get(r.applyId as string) ?? []
    const scores: Record<string, number> = {}
    for (const d of details) scores[d.itemNumber] = d.score
    const rank = rankByStudent.get(r.studentDbId as number)
    return {
      studentId: r.studentId as string,
      name: r.name as string,
      className: (r.className as string | null) ?? undefined,
      grade: (r.grade as string | null) ?? undefined,
      major: (r.major as string | null) ?? undefined,
      dyfTotal: calcDyfTotal(details, totalConfig),
      scores,
      rankClass: rank?.rankClass,
      rankMajor: rank?.rankMajor
    }
  })

  return { columns, rows: items, total }
}
