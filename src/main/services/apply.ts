/**
 * 审核服务（M3）：德育分审核闭环。
 *
 * 列表 → 详情 → 修改分数（reviewing）→ 扣分/加分（设置 finalScore）→
 * 确认德育分（reviewing → confirmed，计算总分与排名）→ 撤销确认（仅一级，留审计）。
 *
 * 约束：
 * - 状态机单向推进（shared assertApplyTransition），confirmed 后分数冻结；
 * - 扣分（finalScore < appliedScore）任何角色可操作；加分仅对「学生申请项」限制（一级全可/二级限可加分项/
 *   三级不可），非学生申请项（管理端补录，如基础分）任何角色可录入（shared canAdjustScore，权限矩阵 §6.2）；
 * - 德育分总分与排名在确认时计算（架构 §8.2），未确认学生不进 final_grade。
 */
import type { ApplyStatus, ConfirmLevel, DyfTotalConfig } from '@sces/shared'
import {
  adjustDirection,
  calcDyfTotal,
  canAdjustScore,
  extractDyfTotalConfig,
  findTemplateItem,
  isStudentApplicableItem,
  maxScoreOf,
  scorePrecisionOf
} from '@sces/shared'
import { getDb } from '../db'
import { assertBatchNotExported, getBatch } from './batch'
import { getTemplate } from './config-template'
import { writeAudit } from './audit'
import { assertWritable } from './license'
import {
  confirmLevelForRole,
  currentRole,
  currentScope,
  outOfScopeReason
} from './role'
import { computeRanking, isRankingFresh, touchScoresChanged } from './ranking'
import { publishApplyStatusReliable, publishApplyStatusesReliable } from './status-outbox'
import type {
  ApplyDetail,
  ApplyListItem,
  ApplyListOptions,
  ApplyListResult,
  ApplyScoreItem
} from '../../preload/types'
import { writeTimelineEvent } from './timeline'

/**
 * 取批次绑定配置的总分计算标记（决策 #36：penalty 分类 code + negative 条目 code）。
 * 无配置时返回空标记（不识别任何 penalty/negative）。
 */
function resolveTotalConfig(batchId: string): DyfTotalConfig {
  const batch = getBatch(batchId)
  const template = batch?.configTemplateId ? getTemplate(batch.configTemplateId) : null
  return extractDyfTotalConfig(template)
}

/** 审核列表（含德育分总分，SQL 分页）。 */
export function listApplies(batchId: string, options: ApplyListOptions = {}): ApplyListResult {
  const db = getDb()
  const { status, search, limit = 100, offset = 0 } = options
  const where: string[] = ['a.batch_id = @batchId']
  const params: Record<string, unknown> = { batchId, limit, offset }
  if (status) {
    where.push('a.status = @status')
    params.status = status
  }
  if (search && search.trim()) {
    where.push('(s.student_id LIKE @kw OR s.name LIKE @kw)')
    params.kw = `%${search.trim()}%`
  }
  // 数据范围(安全边界):level3 限本班、level2 限本年级。
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
  const whereSql = where.join(' AND ')

  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM apply a JOIN student s ON s.id = a.student_id WHERE ${whereSql}`
      )
      .get(params) as { c: number }
  ).c

  const rows = db
    .prepare(
      `SELECT a.apply_id AS applyId, a.status, a.current_revision AS currentRevision,
              a.confirm_level AS confirmLevel, a.imported_at AS importedAt, a.dyf_confirmed_at AS dyfConfirmedAt,
              a.first_entered_at AS firstEnteredAt, a.last_student_exported_at AS lastStudentExportedAt,
              a.last_imported_at AS lastImportedAt, a.last_modified_at AS lastModifiedAt,
              a.last_exported_at AS lastExportedAt,
              s.student_id AS studentId, s.name, s.class_name AS className, s.grade, s.major, s.phone
       FROM apply a JOIN student s ON s.id = a.student_id
       WHERE ${whereSql}
       ORDER BY COALESCE(a.last_imported_at, a.imported_at) DESC, a.apply_id
       LIMIT @limit OFFSET @offset`
    )
    .all(params) as Array<Record<string, unknown>>

  const items = attachDyfTotals(rows, resolveTotalConfig(batchId)).map((r) => ({
    applyId: r.applyId,
    studentId: r.studentId,
    name: r.name,
    className: r.className ?? undefined,
    grade: r.grade ?? undefined,
    major: r.major ?? undefined,
    phone: r.phone ?? undefined,
    status: r.status,
    currentRevision: r.currentRevision,
    confirmLevel: r.confirmLevel ?? undefined,
    importedAt: r.importedAt ?? undefined,
    firstEnteredAt: r.firstEnteredAt ?? undefined,
    lastStudentExportedAt: r.lastStudentExportedAt ?? undefined,
    lastImportedAt: r.lastImportedAt ?? undefined,
    lastModifiedAt: r.lastModifiedAt ?? undefined,
    lastExportedAt: r.lastExportedAt ?? undefined,
    dyfConfirmedAt: r.dyfConfirmedAt ?? undefined,
    dyfTotal: r.dyfTotal,
    scoreCount: r.scoreCount
  })) as ApplyListItem[]
  return { items, total }
}

/** 给列表行附加德育分总分与明细数（一次 SQL 批量取分，避免逐行查询）。 */
function attachDyfTotals(
  rows: Array<Record<string, unknown>>,
  totalConfig: DyfTotalConfig
): Array<Record<string, unknown>> {
  const applyIds = rows.map((r) => r.applyId as string)
  const byApply = new Map<
    string,
    Array<{ categoryCode: string; itemNumber: string; score: number }>
  >()
  if (applyIds.length) {
    const placeholders = applyIds.map(() => '?').join(',')
    const scores = getDb()
      .prepare(
        `SELECT apply_id AS applyId, category, item_code AS itemCode,
                applied_score AS appliedScore, final_score AS finalScore
         FROM dyf_score WHERE apply_id IN (${placeholders})`
      )
      .all(...applyIds) as Array<Record<string, unknown>>
    for (const s of scores) {
      const list = byApply.get(s.applyId as string) ?? []
      list.push({
        categoryCode: s.category as string,
        itemNumber: s.itemCode as string,
        score: (s.finalScore as number | null) ?? (s.appliedScore as number)
      })
      byApply.set(s.applyId as string, list)
    }
  }
  return rows.map((r) => {
    const details = byApply.get(r.applyId as string) ?? []
    return { ...r, dyfTotal: calcDyfTotal(details, totalConfig), scoreCount: details.length }
  })
}

/**
 * 审核详情（申请 + 学生 + 德育明细 + 总分）。
 * 明细 = 配置模板全量条目 × 已导入明细合并：
 * - 模板条目：studentApplicable 由模板标记（缺省按共享层兼容规则回退）；
 *   学生已申请的条目 applied=true（带 appliedScore/evidence），未申请的 applied=false（管理端补录用）；
 * - 模板未定义的项目（学生导入文件中出现）：保留并标注 templateItem=false，审核端人工核对。
 */
export function getApplyDetail(batchId: string, applyId: string): ApplyDetail {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT a.apply_id AS applyId, a.status, a.current_revision AS currentRevision,
              a.confirm_level AS confirmLevel, a.confirm_by AS confirmBy, a.confirm_at AS confirmAt,
              a.imported_at AS importedAt, a.dyf_confirmed_at AS dyfConfirmedAt, a.confirm_slip AS confirmSlip,
              a.first_entered_at AS firstEnteredAt, a.last_student_exported_at AS lastStudentExportedAt,
              a.last_imported_at AS lastImportedAt, a.last_modified_at AS lastModifiedAt,
              a.last_exported_at AS lastExportedAt,
              s.student_id AS studentId, s.name, s.phone, s.grade, s.major, s.class_name AS className
       FROM apply a JOIN student s ON s.id = a.student_id
       WHERE a.batch_id = ? AND a.apply_id = ?`
    )
    .get(batchId, applyId) as Record<string, unknown> | undefined
  if (!row) throw new Error('申请不存在')
  const scopeReason = outOfScopeReason({ grade: row.grade, className: row.className })
  if (scopeReason) throw new Error('申请不在当前账号授权范围内')

  const scoreRows = db
    .prepare(
      `SELECT item_code AS itemCode, category, applied_score AS appliedScore, final_score AS finalScore,
              max_score AS maxScore, allow_add AS allowAdd, evidence_files AS evidenceFiles
       FROM dyf_score WHERE apply_id = ? ORDER BY category, item_code`
    )
    .all(applyId) as Array<Record<string, unknown>>

  const template = getBatch(batchId)?.configTemplateId
    ? getTemplate(getBatch(batchId)!.configTemplateId!)
    : null

  // 模板条目 → 明细行（未申请的条目 applied=false，供管理端补录；学生端可申请的未填条目不展示）
  const merged: ApplyScoreItem[] = []
  if (template) {
    for (const category of template.dyf.categories) {
      for (const group of category.groups) {
        for (const item of group.items) {
          const row = scoreRows.find((s) => s.itemCode === item.code)
          merged.push({
            itemCode: item.code,
            category: category.name,
            description: item.description,
            appliedScore: (row?.appliedScore as number) ?? 0,
            finalScore: row ? ((row.finalScore as number | null) ?? undefined) : undefined,
            maxScore:
              row !== undefined
                ? ((row.maxScore as number | null) ?? undefined)
                : maxScoreOf(item.scoreType),
            allowAdd: row ? row.allowAdd === 1 : item.allowAdd === true,
            studentApplicable: isStudentApplicableItem(item, category.name),
            applied: row !== undefined,
            templateItem: true,
            evidenceFiles: row ? parseEvidenceList(row.evidenceFiles as string | null) : undefined,
            ...scorePrecisionOf(item.scoreType)
          })
        }
      }
    }
  }

  // 模板未定义的项目（学生导入文件中出现）→ 追加，视为管理端核对项
  for (const s of scoreRows) {
    const itemCode = s.itemCode as string
    if (merged.some((m) => m.itemCode === itemCode)) continue
    merged.push({
      itemCode,
      category: (s.category as string) || '未知',
      description: describeItem(batchId, itemCode),
      appliedScore: s.appliedScore as number,
      finalScore: (s.finalScore as number | null) ?? undefined,
      maxScore: (s.maxScore as number | null) ?? undefined,
      allowAdd: s.allowAdd === 1,
      studentApplicable: false,
      applied: true,
      templateItem: false,
      evidenceFiles: parseEvidenceList(s.evidenceFiles as string | null),
      step: 1,
      decimals: 0
    })
  }

  // 总分：按已落库明细计算（finalScore ?? appliedScore），未补录条目不参与
  const detail: ApplyDetail = {
    applyId: row.applyId as string,
    studentId: row.studentId as string,
    name: row.name as string,
    phone: (row.phone as string | null) ?? undefined,
    grade: (row.grade as string | null) ?? undefined,
    major: (row.major as string | null) ?? undefined,
    className: (row.className as string | null) ?? undefined,
    status: row.status as ApplyStatus,
    currentRevision: row.currentRevision as number,
    confirmLevel: (row.confirmLevel as ConfirmLevel | null) ?? undefined,
    confirmBy: (row.confirmBy as string | null) ?? undefined,
    confirmAt: (row.confirmAt as number | null) ?? undefined,
    importedAt: (row.importedAt as number | null) ?? undefined,
    firstEnteredAt: (row.firstEnteredAt as number | null) ?? undefined,
    lastStudentExportedAt: (row.lastStudentExportedAt as number | null) ?? undefined,
    lastImportedAt: (row.lastImportedAt as number | null) ?? undefined,
    lastModifiedAt: (row.lastModifiedAt as number | null) ?? undefined,
    lastExportedAt: (row.lastExportedAt as number | null) ?? undefined,
    dyfConfirmedAt: (row.dyfConfirmedAt as number | null) ?? undefined,
    confirmSlip: (row.confirmSlip as string | null) ?? undefined,
    dyfTotal: calcDyfTotal(
      scoreRows.map((s) => ({
        categoryCode: s.category as string,
        itemNumber: s.itemCode as string,
        score: ((s.finalScore as number | null) ?? (s.appliedScore as number)) as number
      })),
      resolveTotalConfig(batchId)
    ),
    scores: merged
  }
  return detail
}

/** 从配置模板取项目描述（审核明细展示用）。 */
function describeItem(batchId: string, itemCode: string): string {
  const batch = getBatch(batchId)
  const template = batch?.configTemplateId ? getTemplate(batch.configTemplateId) : null
  if (!template) return ''
  for (const category of template.dyf.categories) {
    for (const group of category.groups) {
      const item = group.items.find((i) => i.code === itemCode)
      if (item) return item.description
    }
  }
  return ''
}

/**
 * 调整单个德育明细分（扣分/加分/管理端补录）。
 * - 状态须为 imported / reviewing（confirmed 后冻结）；
 * - 扣分：任何角色；加分仅对「学生申请项」限制（一级全可/二级限可加分项/三级不可），非学生申请项（补录）任何角色可；
 * - finalScore 不得为负，且不超过 maxScore（有上限时）；
 * - 明细行不存在（如基础分等学生端不可申请条目）→ 从配置模板解析类别/上限后创建（管理端补录，留审计）。
 */
export async function setScore(
  batchId: string,
  applyId: string,
  itemCode: string,
  finalScore: number
): Promise<void> {
  assertWritable()
  const batch = getBatch(batchId)
  if (!batch) throw new Error('批次不存在')
  assertBatchNotExported(batch)
  const db = getDb()
  const apply = getApply(batchId, applyId)
  if (apply.status === 'confirmed') throw new Error('德育分已确认，无法修改；如需修改请先撤销导出')
  if (apply.status !== 'imported' && apply.status !== 'reviewing') {
    throw new Error('当前状态不可审核')
  }

  const score = Number(finalScore)
  if (!Number.isFinite(score)) throw new Error('分数无效')
  if (score < 0) throw new Error('分数不能为负')

  const existing = db
    .prepare(
      `SELECT applied_score AS appliedScore, final_score AS finalScore,
              max_score AS maxScore, allow_add AS allowAdd
       FROM dyf_score WHERE apply_id = ? AND item_code = ?`
    )
    .get(applyId, itemCode) as Record<string, unknown> | undefined
  const template = batch.configTemplateId ? getTemplate(batch.configTemplateId) : null
  const meta = template ? findTemplateItem(template, itemCode) : null
  if (!existing && !meta) throw new Error('项目未在配置模板中定义，无法新增')

  // 上限：已有行用其 max_score，否则用模板上限
  const maxScore = existing ? ((existing.maxScore as number | null) ?? undefined) : meta?.maxScore
  if (maxScore !== undefined && score > maxScore) {
    throw new Error(`分数不能超过上限 ${maxScore}`)
  }

  // 加分权限仅对「学生可申请项」生效（防止管理端抬高学生自报分）；
  // 管理端补录项（非学生可申请，如基础分，基线 0）属数据录入，任何角色都可写；
  // 未在模板中的项（未知导入项）按学生提交处理，保留加分限制。
  const appliedScore = existing ? (existing.appliedScore as number) : 0
  const allowAdd = existing ? existing.allowAdd === 1 : meta?.allowAdd === true
  const studentApplicable = meta ? meta.studentApplicable : true
  const direction = adjustDirection(appliedScore, score)
  if (
    direction === 'add' &&
    !canAdjustScore({ role: currentRole(), allowAdd, direction: 'add', studentApplicable })
  ) {
    throw new Error(
      currentRole() === 'level3'
        ? '班级管理员（三级）只能扣分，不能加分'
        : '该项目不允许加分（仅一级可对非可加分项加分）'
    )
  }

  const before = existing ? ((existing.finalScore as number | null) ?? appliedScore) : 0
  if (before === score) return
  const created = !existing
  if (created) {
    db.prepare(
      `INSERT INTO dyf_score (apply_id, item_code, category, applied_score, final_score, max_score, allow_add, evidence_files)
       VALUES (?, ?, ?, 0, ?, ?, ?, '[]')`
    ).run(applyId, itemCode, meta!.category, score, meta!.maxScore ?? null, meta!.allowAdd ? 1 : 0)
  } else {
    db.prepare(`UPDATE dyf_score SET final_score = ? WHERE apply_id = ? AND item_code = ?`).run(
      score,
      applyId,
      itemCode
    )
  }

  // 兼容旧库：首次发生审核修改时把历史 imported 记录归一到 reviewing。
  if (apply.status === 'imported') {
    db.prepare(`UPDATE apply SET status = 'reviewing' WHERE apply_id = ? AND batch_id = ?`).run(
      applyId,
      batchId
    )
  }

  writeAudit({
    batchId,
    operator: 'local-admin',
    role: currentRole(),
    scope: 'unit',
    action: 'apply.score.update',
    target: applyId,
    detail: {
      studentId: apply.studentId,
      itemCode,
      before,
      after: score,
      direction,
      created
    }
  })
  const commitTimeline = db.transaction(() => {
    writeTimelineEvent({
      batchId,
      applyId,
      actorType: 'admin',
      role: currentRole(),
      scope: { ...currentScope() },
      action: 'admin.modified',
      detail: {
        changes: [{ field: `score.${itemCode}`, before, after: score }],
        direction,
        created
      }
    })
  })
  commitTimeline()
  touchScoresChanged(batchId)
  const synced = await publishApplyStatusReliable({
    applyId,
    batchId,
    status: 'reviewing'
  })
  if (!synced) {
    writeAudit({
      batchId,
      operator: 'local-admin',
      role: currentRole(),
      scope: 'unit',
      action: 'apply.status-sync.pending',
      target: applyId,
      detail: { status: 'reviewing' }
    })
  }
}

/**
 * 一键补全基础分：把「基础分」类别下每个「非学生申请」条目补足到其满分，逐条幂等
 * （已有生效分数的条目跳过，含学生申请项如 CET/活动一律不覆盖）。
 * 作用范围受当前角色 scope 限制（三级限本班、二级限本年级）。整班导出后锁定不可补。
 */
export function fillBaseScores(batchId: string): { studentsFilled: number; itemsFilled: number } {
  assertWritable()
  const batch = getBatch(batchId)
  if (!batch) throw new Error('批次不存在')
  assertBatchNotExported(batch)
  const template = batch.configTemplateId ? getTemplate(batch.configTemplateId) : null
  if (!template) throw new Error('批次配置模板缺失，无法补全基础分')

  // 基础分类别条目（category.code==='base'，兼容名称「基础分」）+ 各自满分。
  // 仅收集「非学生可申请」的固定满分条目（排除 CET/活动等学生申请项、negative 项、无有效满分项）。
  const baseItems: Array<{ itemCode: string; category: string; maxScore: number }> = []
  for (const category of template.dyf.categories) {
    if (category.code !== 'base' && category.name !== '基础分') continue
    for (const group of category.groups) {
      for (const item of group.items) {
        if (isStudentApplicableItem(item, category.name)) continue
        if (item.negative === true) continue
        const max = maxScoreOf(item.scoreType)
        if (typeof max === 'number' && Number.isFinite(max) && max > 0) {
          baseItems.push({ itemCode: item.code, category: category.code, maxScore: max })
        }
      }
    }
  }
  if (!baseItems.length) throw new Error('配置模板未定义可补全的基础分条目')

  const db = getDb()
  // 数据范围（安全边界）：三级限本班、二级限本年级
  const role = currentRole()
  const scope = currentScope()
  let scopeClause = ''
  const scopeParams: string[] = []
  if (role === 'level3' && scope.class && scope.grade) {
    scopeClause = ' AND s.class_name = ? AND s.grade = ?'
    scopeParams.push(scope.class, scope.grade)
  } else if (role === 'level3') {
    scopeClause = ' AND 1 = 0'
  } else if (role === 'level2' && scope.grade) {
    scopeClause = ' AND s.grade = ?'
    scopeParams.push(scope.grade)
  }
  const applies = db
    .prepare(
      `SELECT a.apply_id AS applyId FROM apply a JOIN student s ON s.id = a.student_id
       WHERE a.batch_id = ? AND a.status IN ('imported', 'reviewing')${scopeClause}`
    )
    .all(batch.batchId, ...scopeParams) as Array<{ applyId: string }>

  const baseCodes = baseItems.map((b) => b.itemCode)
  const placeholders = baseCodes.map(() => '?').join(',')
  const selectExisting = db.prepare(
    `SELECT item_code AS itemCode, final_score AS finalScore, applied_score AS appliedScore
     FROM dyf_score WHERE apply_id = ? AND item_code IN (${placeholders})`
  )
  const insertScore = db.prepare(
    `INSERT INTO dyf_score (apply_id, item_code, category, applied_score, final_score, max_score, allow_add, evidence_files)
     VALUES (?, ?, ?, 0, ?, ?, 0, '[]')`
  )
  const updateScore = db.prepare(
    `UPDATE dyf_score SET final_score = ? WHERE apply_id = ? AND item_code = ?`
  )

  let studentsFilled = 0
  let itemsFilled = 0
  const touchedApplyIds: string[] = []
  const changesByApply = new Map<string, Array<{ field: string; before: number; after: number }>>()
  const tx = db.transaction(() => {
    for (const { applyId } of applies) {
      const existing = selectExisting.all(applyId, ...baseCodes) as Array<{
        itemCode: string
        finalScore: number | null
        appliedScore: number
      }>
      const byCode = new Map(existing.map((e) => [e.itemCode, e]))
      let touched = false
      for (const b of baseItems) {
        const row = byCode.get(b.itemCode)
        const effective = (row?.finalScore ?? row?.appliedScore ?? 0) || 0
        // 该条目已有生效分数（含学生申请的 CET 等）→ 保留不覆盖；否则补到满分（幂等）
        if (effective > 0) continue
        if (row) updateScore.run(b.maxScore, applyId, b.itemCode)
        else insertScore.run(applyId, b.itemCode, b.category, b.maxScore, b.maxScore)
        itemsFilled++
        touched = true
        const changes = changesByApply.get(applyId) ?? []
        changes.push({ field: `score.${b.itemCode}`, before: effective, after: b.maxScore })
        changesByApply.set(applyId, changes)
      }
      if (touched) {
        studentsFilled++
        touchedApplyIds.push(applyId)
      }
    }
  })
  tx()

  const fillTime = Date.now()
  for (const applyId of touchedApplyIds) {
    writeTimelineEvent({
      batchId,
      applyId,
      actorType: 'admin',
      role,
      scope: { ...currentScope() },
      action: 'admin.modified',
      occurredAt: fillTime,
      detail: { operation: 'fill-base-scores', changes: changesByApply.get(applyId) ?? [] }
    })
  }

  writeAudit({
    batchId,
    operator: 'local-admin',
    role,
    scope: 'unit',
    action: 'apply.base.fill',
    target: batchId,
    detail: { studentsFilled, itemsFilled }
  })
  if (itemsFilled > 0) touchScoresChanged(batchId)
  return { studentsFilled, itemsFilled }
}

/**
 * 整班确认并导出（决策 #17）：只允许全班一次性全部确认（即导出操作）。
 * - 批次全部 imported/reviewing 申请 → confirmed（confirmLevel 由当前角色决定，
 *   M3 仅 level1 → 1；三级/二级复核留 M6 .dys 数据交换）；
 * - 校验排名为最新（isRankingFresh）后，全量重算 final_grade 与排名（computeRanking）；
 * - 批次打上班级端审核标记（batch.class_reviewed_at），此后本端锁定：
 *   不可再导入/修改/处理冲突；撤销导出仅一级可操作（留审计）。
 */
export async function confirmBatchExport(
  batchId: string
): Promise<{ confirmedCount: number; syncPending?: boolean }> {
  assertWritable()
  const role = currentRole()
  if (role === 'level2') {
    throw new Error('年级端导出后仍可继续复核，因此不会执行锁定确认')
  }
  const db = getDb()
  const batch = getBatch(batchId)
  if (!batch) throw new Error('批次不存在')
  if (batch.status === 'draft') throw new Error('批次未开放，无法导出')
  if (batch.classReviewedAt) throw new Error('该班已完成班级端审核并整班导出，请勿重复操作')
  if (!isRankingFresh(batch)) {
    throw new Error(
      '排名尚未计算或已过期，请先在「总体情况」页点击「计算排名」，确认最新排名后再导出'
    )
  }

  const pending = db
    .prepare(
      `SELECT apply_id AS applyId FROM apply
       WHERE batch_id = ? AND status IN ('imported', 'reviewing')`
    )
    .all(batchId) as Array<{ applyId: string }>
  if (!pending.length) throw new Error('本班暂无待确认的申请')

  const level = confirmLevelForRole(role)
  const now = Date.now()

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE apply SET status = 'confirmed', confirm_level = ?, confirm_by = ?, confirm_at = ?, dyf_confirmed_at = ?
       WHERE batch_id = ? AND status IN ('imported', 'reviewing')`
    ).run(level, 'local-admin', now, now, batchId)
    computeRanking(batchId)
    db.prepare('UPDATE batch SET class_reviewed_at = ?, updated_at = ? WHERE id = ?').run(
      now,
      now,
      batchId
    )
  })
  tx()

  for (const { applyId } of pending) {
    if (role === 'level1') {
      writeTimelineEvent({
        batchId,
        applyId,
        actorType: 'admin',
        role,
        scope: { ...currentScope() },
        action: 'admin.exported',
        occurredAt: now,
        detail: { kind: 'final-confirmation' }
      })
    }
    writeTimelineEvent({
      batchId,
      applyId,
      actorType: 'admin',
      role,
      scope: { ...currentScope() },
      action: 'admin.confirmed',
      occurredAt: now,
      detail: { confirmLevel: level }
    })
  }

  writeAudit({
    batchId,
    operator: 'local-admin',
    role,
    scope: 'unit',
    action: 'apply.batch.export',
    target: batchId,
    detail: { confirmedCount: pending.length, confirmLevel: level }
  })
  // 批量上报申请状态（离线全 ok/local；在线 POST /batches/:id/apply-statuses，决策 #32）。
  const synced = await publishApplyStatusesReliable({
    batchId,
    status: 'confirmed',
    applyIds: pending.map((p) => p.applyId)
  })
  if (synced) {
    return { confirmedCount: pending.length }
  }
  writeAudit({
    batchId,
    operator: 'local-admin',
    role,
    scope: 'unit',
    action: 'apply.status-sync.pending',
    target: batchId,
    detail: { status: 'confirmed', applyCount: pending.length }
  })
  return { confirmedCount: pending.length, syncPending: true }
}

/** 读申请行（校验批次归属）。 */
function getApply(batchId: string, applyId: string): { status: ApplyStatus; studentId: string } {
  const row = getDb()
    .prepare(
      `SELECT status, s.student_id AS studentId, s.grade, s.class_name AS className
       FROM apply a JOIN student s ON s.id = a.student_id
       WHERE a.batch_id = ? AND a.apply_id = ?`
    )
    .get(batchId, applyId) as
    | { status: ApplyStatus; studentId: string; grade: string | null; className: string | null }
    | undefined
  if (!row) throw new Error('申请不存在')
  if (outOfScopeReason({ grade: row.grade, className: row.className })) {
    throw new Error('申请不在当前账号授权范围内')
  }
  return row
}

/** 解析证据文件路径列表（dyf_score.evidence_files JSON）。 */
function parseEvidenceList(json: string | null): string[] | undefined {
  if (!json) return undefined
  try {
    const list = JSON.parse(json) as unknown
    return Array.isArray(list) ? list.map((v) => String(v)).filter(Boolean) : undefined
  } catch {
    return undefined
  }
}
