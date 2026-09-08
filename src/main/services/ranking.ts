/**
 * 排名服务（决策 #47：手动计算排名）：管理端手动触发，计算德育分总分与排名（架构 §8.2 / §8.4）。
 *
 * - 德育分总分：shared calcDyfTotal（惩罚分类目为负、负分项目单项取负）；
 * - 排名固定为**班级排名（rank_class）+ 专业排名（rank_major）**（决策 #21，取消排名范围配置）：
 *   班级按 class_name 分组，专业按 年级+专业 分组（同年级同专业）；
 * - 并列规则：批次配置 rank.tieRule（same-rank 同分同名次跳号 / dense 同分同名次不跳号）；
 * - 参与排名者 = 批次内已导入/审核中/已确认的申请（未导入草稿不计）；computeRanking 全量重算 final_grade。
 *   分数/名单变更后 scores_changed_at 更新，排名过期（ranked_at < scores_changed_at）时禁止导出。
 */
import type { RankInput, DyfTotalConfig } from '@sces/shared'
import { calcDyfTotal, calcRank, extractDyfTotalConfig } from '@sces/shared'
import { getDb } from '../db'
import { getBatch } from './batch'
import { getTemplate } from './config-template'
import { assertWritable } from './license'
import { writeAudit } from './audit'
import { currentRole, studentScopeSql } from './role'

/** 标记批次分数/名单已变更（导入/改分/补全/冲突处理后调用），使已算排名过期。 */
export function touchScoresChanged(batchId: string): void {
  getDb().prepare(`UPDATE batch SET scores_changed_at = ? WHERE id = ?`).run(Date.now(), batchId)
}

/** 排名是否为最新：已计算且不早于最近一次分数/名单变更。 */
export function isRankingFresh(batch: { rankedAt?: number; scoresChangedAt?: number }): boolean {
  if (!batch.rankedAt) return false
  return !batch.scoresChangedAt || batch.rankedAt >= batch.scoresChangedAt
}

/**
 * 手动计算排名（决策 #47）：全量重算批次内「已导入/审核中/已确认」申请的 final_grade 与排名，
 * 并落 batch.ranked_at。整班导出锁定后排名已固定，不可再算。
 */
export function computeRanking(batchId: string): { rankedCount: number } {
  assertWritable()
  const db = getDb()
  const batch = getBatch(batchId)
  if (!batch) throw new Error('批次不存在')
  if (batch.classReviewedAt) throw new Error('该批次已整班导出并锁定，排名已固定')
  const template = batch.configTemplateId ? getTemplate(batch.configTemplateId) : null
  const totalConfig = extractDyfTotalConfig(template)
  // 参与排名者受当前角色 scope 限制（与总览/表格/审核/导出一致，dual-mode/12 §5.4 安全边界）：
  // level3 限本班、level2 限本年级、level1 全单位。否则会出现「排名算出 N 人、页面/导出 0 人」的不一致。
  const sc = studentScopeSql({ grade: 's.grade', class: 's.class_name' })
  const rows = db
    .prepare(
      `SELECT a.apply_id AS applyId, a.student_id AS studentDbId
       FROM apply a JOIN student s ON s.id = a.student_id
       WHERE a.batch_id = ? AND a.status IN ('imported', 'reviewing', 'confirmed')${sc.clause}`
    )
    .all(batchId, ...sc.params) as Array<{ applyId: string; studentDbId: number }>

  const insert = db.prepare(`INSERT INTO final_grade (batch_id, student_id, dyf_total) VALUES (?, ?, ?)`)
  const rebuild = db.transaction((list: Array<{ applyId: string; studentDbId: number }>) => {
    db.prepare(`DELETE FROM final_grade WHERE batch_id = ?`).run(batchId)
    for (const r of list) insert.run(batchId, r.studentDbId, dyfTotalForApply(r.applyId, totalConfig))
    recomputeRanks(batchId)
    db.prepare(`UPDATE batch SET ranked_at = ? WHERE id = ?`).run(Date.now(), batchId)
  })
  rebuild(rows)

  writeAudit({
    batchId,
    operator: 'local-admin',
    role: currentRole(),
    scope: 'unit',
    action: 'ranking.compute',
    detail: { rankedCount: rows.length }
  })
  return { rankedCount: rows.length }
}

/** 某申请的德育分总分（finalScore 优先，未审项用 appliedScore；标记驱动 penalty/negative）。 */
function dyfTotalForApply(applyId: string, totalConfig: DyfTotalConfig): number {
  const rows = getDb()
    .prepare(
      `SELECT category, item_code AS itemCode, applied_score AS appliedScore, final_score AS finalScore
       FROM dyf_score WHERE apply_id = ?`
    )
    .all(applyId) as Array<Record<string, unknown>>
  return calcDyfTotal(
    rows.map((r) => ({
      categoryCode: r.category as string,
      itemNumber: r.itemCode as string,
      score: (r.finalScore as number | null) ?? (r.appliedScore as number)
    })),
    totalConfig
  )
}

/**
 * 重算批次内全部已确认学生的排名（决策 #21）：固定 班级排名 + 专业排名。
 * 班级：按 class_name 分组；专业：按 年级+专业 分组。rank_grade/rank_school 不再写入。
 */
function recomputeRanks(batchId: string): void {
  const db = getDb()
  const batch = getBatch(batchId)
  if (!batch) return

  let tieRule: 'same-rank' | 'dense' = 'same-rank'
  const template = batch.configTemplateId ? getTemplate(batch.configTemplateId) : null
  if (template) tieRule = template.rank.tieRule

  const students = db
    .prepare(
      `SELECT s.id AS studentDbId, f.dyf_total AS dyfTotal,
              s.class_name AS className, s.grade, s.major
       FROM final_grade f JOIN student s ON s.id = f.student_id
       WHERE f.batch_id = ?`
    )
    .all(batchId) as Array<Record<string, unknown>>

  // 班级排名：同班分组
  const classGroups = new Map<string, RankInput[]>()
  for (const s of students) {
    const key = String(s.className ?? '')
    const list = classGroups.get(key) ?? []
    list.push({ studentId: String(s.studentDbId), score: s.dyfTotal as number })
    classGroups.set(key, list)
  }
  const classRanks = new Map<number, number>()
  for (const list of classGroups.values()) {
    for (const ranked of calcRank(list, { tieRule })) {
      classRanks.set(Number(ranked.studentId), ranked.rank)
    }
  }

  // 专业排名：同年级同专业分组
  const majorGroups = new Map<string, RankInput[]>()
  for (const s of students) {
    const key = `${String(s.grade ?? '')}|${String(s.major ?? '')}`
    const list = majorGroups.get(key) ?? []
    list.push({ studentId: String(s.studentDbId), score: s.dyfTotal as number })
    majorGroups.set(key, list)
  }
  const majorRanks = new Map<number, number>()
  for (const list of majorGroups.values()) {
    for (const ranked of calcRank(list, { tieRule })) {
      majorRanks.set(Number(ranked.studentId), ranked.rank)
    }
  }

  const update = db.prepare(
    `UPDATE final_grade SET rank_class = ?, rank_major = ? WHERE batch_id = ? AND student_id = ?`
  )
  for (const s of students) {
    const id = s.studentDbId as number
    update.run(classRanks.get(id) ?? null, majorRanks.get(id) ?? null, batchId, id)
  }
}
