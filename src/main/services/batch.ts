/**
 * 批次服务：一次综测周期的完整配置，由一级管理端创建（架构文档 §3.1）。
 * 批次密钥取单位申请密钥（跨批次复用，gateway.resolveApplyKey）；batchId 两模式确定性派生
 * （与学生端包内一致，决策 #46）。状态机 draft → active → closed。
 * 计算规则（calcMode/calcConfig）与排名范围（rankScope）从单位绑定配置模板读取，
 * 创建时快照到批次，模板后续更新不影响已创建批次。
 */
import type { Batch, BatchStatus, CalcConfig, RankScope } from '@sces/shared'
import { assertBatchTransition, BATCH_STATUS_LABELS, deriveOfflineBatchId } from '@sces/shared'
import { getDb } from '../db'
import { gateway } from '../gateway'
import { publishBatchReliable, publishBatchStatusReliable } from './status-outbox'
import { writeAudit } from './audit'
import { getLatestPublishedTemplate, getTemplate } from './config-template'
import { assertWritable } from './license'
import { assertLevel1, currentRole } from './role'

/** 批次创建/更新输入（计算规则与排名范围由单位绑定模板决定，决策 #20）。 */
export interface CreateBatchInput {
  year: number
  semester: 1 | 2
  /** 是否测试批次（试用/演示；同一学期可在前一个测试结束后再开新的）。 */
  isTest?: boolean
  applyStartAt?: number
  applyEndAt?: number
}

/** 行 → 批次对象（解析 JSON 字段）。 */
function rowToBatch(row: Record<string, unknown>): Batch {
  return {
    batchId: row.id as string,
    year: row.year as number,
    semester: row.semester as 1 | 2,
    isTest: row.isTest === 1 || row.isTest === true,
    status: row.status as BatchStatus,
    applyStartAt: (row.applyStartAt as number | null) ?? undefined,
    applyEndAt: (row.applyEndAt as number | null) ?? undefined,
    configTemplateId: (row.configTemplateId as string | null) ?? undefined,
    calcMode: row.calcMode as Batch['calcMode'],
    calcConfig: JSON.parse(row.calcConfig as string) as CalcConfig,
    rankScope: JSON.parse(row.rankScope as string) as RankScope[],
    classReviewedAt: (row.classReviewedAt as number | null) ?? undefined,
    rankedAt: (row.rankedAt as number | null) ?? undefined,
    scoresChangedAt: (row.scoresChangedAt as number | null) ?? undefined,
    tableExportedAt: (row.tableExportedAt as number | null) ?? undefined,
    publicKeyJwk: JSON.parse(row.publicKeyJwk as string),
    privateKeyJwk: JSON.parse(row.privateKeyJwk as string),
    keyId: (row.keyId as string | null) ?? undefined,
    createdAt: row.createdAt as number,
    updatedAt: row.updatedAt as number
  }
}

/** 批次状态 → 中文（面向用户展示，与渲染层/共享层统一，不暴露枚举原文）。 */
function batchStatusLabel(status: BatchStatus): string {
  return BATCH_STATUS_LABELS[status] ?? '未知'
}

/**
 * 班级端审核门禁（决策 #17）：整班导出后本端锁定，
 * 不可再导入/修改/处理冲突；需撤销导出（仅一级）后才可继续操作。
 */
export function assertBatchNotExported(batch: Batch): void {
  if (batch.classReviewedAt) {
    throw new Error('该班已完成班级端审核并整班导出，本端不可再修改或导入；如需调整请联系一级管理员撤销导出')
  }
}

/** 校验批次输入（申请时间为必填）。 */
function validateBatchInput(input: CreateBatchInput): void {
  if (!Number.isInteger(input.year) || input.year < 2000 || input.year > 2100) {
    throw new Error('学年非法')
  }
  if (input.semester !== 1 && input.semester !== 2) throw new Error('学期非法（1/2）')
  if (!input.applyStartAt || !input.applyEndAt) {
    throw new Error('请填写申请开始与结束时间')
  }
  if (input.applyStartAt >= input.applyEndAt) {
    throw new Error('申请开始时间必须早于结束时间')
  }
}

/**
 * 校验批次唯一性与进行中限制（创建/编辑共用）。
 * - 正式批次：同一学年学期只能有一个（任意状态），且全局只能有一个进行中；
 * - 测试批次：同一学期可有多个（前一个结束后再开新的），但同时只能有一个进行中测试批次。
 */
function assertBatchAvailable(
  year: number,
  semester: 1 | 2,
  isTest: boolean,
  excludeId?: string
): void {
  const db = getDb()
  if (!isTest) {
    const duplicate = db
      .prepare('SELECT id FROM batch WHERE year = ? AND semester = ? AND is_test = 0 AND id != ?')
      .get(year, semester, excludeId ?? '')
    if (duplicate) throw new Error(`${year} 学年第 ${semester} 学期已存在正式批次，请勿重复创建`)
  }
  const active = db
    .prepare("SELECT id, is_test AS isTest FROM batch WHERE status = 'active' AND id != ?")
    .get(excludeId ?? '') as { id: string; isTest: number } | undefined
  if (active) {
    if (isTest && active.isTest === 1) {
      throw new Error('已有进行中的测试批次，请先将其结束后再开启新的测试批次')
    }
    if (!isTest && active.isTest === 0) {
      throw new Error('已有进行中的正式批次，请先将其关闭后再创建新批次')
    }
  }
}

/** 单位绑定模板 id（决策 #20：配置与单位绑定；缺省回退最新已发布模板）。 */
function getUnitConfigTemplateId(): string | null {
  const row = getDb()
    .prepare('SELECT config_template_id AS configTemplateId FROM unit LIMIT 1')
    .get() as { configTemplateId: string | null } | undefined
  return row?.configTemplateId ?? null
}

/** 从单位绑定配置读取计算规则与排名范围（快照；缺省取最新已发布配置）。 */
function resolveCalcFromTemplate(): {
  configTemplateId: string
  calcMode: Batch['calcMode']
  calcConfig: CalcConfig
  rankScope: RankScope[]
} {
  const boundId = getUnitConfigTemplateId()
  const template = boundId ? getTemplate(boundId) : getLatestPublishedTemplate()
  if (!template) throw new Error('未找到配置模板，请联系服务商')
  if (template.calc.calcMode === 'formula') {
    throw new Error('当前版本暂不支持公式计算模板，请改用加权计算配置后再创建批次')
  }
  // 决策 #21：排名固定为班级 + 专业，UnitConfig.rank 已取消 scopes（仅保留 tieRule）；
  // rankScope 字段作快照兼容保留，实际排名口径由 ranking.ts 固定。
  return {
    configTemplateId: template.id,
    calcMode: template.calc.calcMode,
    calcConfig: template.calc,
    rankScope: ['class', 'major']
  }
}

/** 本单位 id（批次 id 派生需要）。 */
function requireUnitId(): string {
  const row = getDb().prepare('SELECT id FROM unit LIMIT 1').get() as { id: string } | undefined
  if (!row) throw new Error('未找到单位信息，请先激活')
  return row.id
}

/** 同 (year, semester, isTest) 下的下一个序号（1 + 已有批次数，决策 #46）。 */
function nextBatchSeq(year: number, semester: 1 | 2, isTest: boolean): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM batch WHERE year = ? AND semester = ? AND is_test = ?')
    .get(year, semester, isTest ? 1 : 0) as { n: number }
  return row.n + 1
}

/** 批次列表（按创建时间倒序）。 */
export function listBatches(): Batch[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, year, semester, is_test AS isTest, status, apply_start_at AS applyStartAt, apply_end_at AS applyEndAt,
              config_template_id AS configTemplateId, calc_mode AS calcMode, calc_config AS calcConfig,
              rank_scope AS rankScope, class_reviewed_at AS classReviewedAt,
              ranked_at AS rankedAt, scores_changed_at AS scoresChangedAt, table_exported_at AS tableExportedAt,
              public_key_jwk AS publicKeyJwk, private_key_jwk AS privateKeyJwk, key_id AS keyId,
              created_at AS createdAt, updated_at AS updatedAt
       FROM batch
       ORDER BY created_at DESC`
    )
    .all() as Array<Record<string, unknown>>
  return rows.map(rowToBatch)
}

/** 批次详情。 */
export function getBatch(batchId: string): Batch | null {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT id, year, semester, is_test AS isTest, status, apply_start_at AS applyStartAt, apply_end_at AS applyEndAt,
              config_template_id AS configTemplateId, calc_mode AS calcMode, calc_config AS calcConfig,
              rank_scope AS rankScope, class_reviewed_at AS classReviewedAt,
              ranked_at AS rankedAt, scores_changed_at AS scoresChangedAt, table_exported_at AS tableExportedAt,
              public_key_jwk AS publicKeyJwk, private_key_jwk AS privateKeyJwk, key_id AS keyId,
              created_at AS createdAt, updated_at AS updatedAt
       FROM batch WHERE id = ?`
    )
    .get(batchId) as Record<string, unknown> | undefined
  return row ? rowToBatch(row) : null
}

/** 渲染层可见的批次：剥离申请私钥（密钥最小暴露，渲染层无需解密能力）。 */
export function toPublicBatch(batch: Batch | null): Batch | null {
  if (!batch) return null
  const { privateKeyJwk: _omit, ...pub } = batch
  return pub
}
/** 创建批次：快照计算规则，取单位申请密钥、确定性派生 id 并落库；上报批次（离线 no-op）。 */
export async function createBatch(
  input: CreateBatchInput
): Promise<{ batch: Batch; warnings: string[] }> {
  assertWritable()
  assertLevel1('batch.create')
  validateBatchInput(input)
  const isTest = input.isTest === true
  assertBatchAvailable(input.year, input.semester, isTest)
  const db = getDb()

  const { configTemplateId, calcMode, calcConfig, rankScope } = resolveCalcFromTemplate()

  // 密钥：两模式统一取单位申请密钥（跨批次复用；离线来自授权后本地生成，在线同）。
  const applyKey = await gateway.resolveApplyKey()

  // 批次 id：两模式确定性派生（与学生端包内一致，决策 #46 修订）。
  const unitId = requireUnitId()
  const seq = nextBatchSeq(input.year, input.semester, isTest)
  const id = await deriveOfflineBatchId({
    unitId,
    year: input.year,
    semester: input.semester,
    isTest,
    seq
  })

  const now = Date.now()
  db.prepare(
    `INSERT INTO batch (id, year, semester, is_test, status, apply_start_at, apply_end_at, config_template_id,
                        calc_mode, calc_config, rank_scope, public_key_jwk, private_key_jwk, key_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.year,
    input.semester,
    isTest ? 1 : 0,
    input.applyStartAt ?? null,
    input.applyEndAt ?? null,
    configTemplateId,
    calcMode,
    JSON.stringify(calcConfig),
    JSON.stringify(rankScope),
    JSON.stringify(applyKey.publicKeyJwk),
    JSON.stringify(applyKey.privateKeyJwk),
    applyKey.keyId,
    now,
    now
  )

  writeAudit({
    batchId: id,
    operator: 'local-admin',
    role: currentRole(),
    scope: 'unit',
    action: 'batch.create',
    target: id,
    detail: {
      year: input.year,
      semester: input.semester,
      isTest,
      calcMode,
      templateId: configTemplateId,
      keyId: applyKey.keyId,
      seq
    }
  })

  const batch = getBatch(id)!
  // 上报批次公开信息（离线 no-op；在线 POST /batches）。
  const published = await publishBatchReliable({
    batchId: id,
    unitId,
    year: input.year,
    semester: input.semester,
    isTest,
    keyId: applyKey.keyId,
    publicKeyJwk: applyKey.publicKeyJwk,
    applyStartAt: input.applyStartAt,
    applyEndAt: input.applyEndAt
  })

  const warnings: string[] = []
  if (!published) warnings.push('批次已在本地创建，但在线状态尚未同步，联网后将自动重试')
  return { batch, warnings }
}

/** 更新草稿批次（仅 draft 可编辑，计算规则保持创建时快照）。 */
export function updateBatch(batchId: string, input: CreateBatchInput): Batch {
  assertWritable()
  assertLevel1('batch.update')
  const existing = getBatch(batchId)
  if (!existing) throw new Error('批次不存在或已被删除')
  if (existing.status !== 'draft') {
    throw new Error(`仅未开放批次可编辑，当前状态：${batchStatusLabel(existing.status)}`)
  }

  validateBatchInput(input)
  // isTest 在创建后不可变更，沿用原值参与唯一性校验
  assertBatchAvailable(input.year, input.semester, existing.isTest === true, batchId)

  const db = getDb()
  const now = Date.now()
  db.prepare(
    `UPDATE batch
     SET year = ?, semester = ?, apply_start_at = ?, apply_end_at = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    input.year,
    input.semester,
    input.applyStartAt ?? null,
    input.applyEndAt ?? null,
    now,
    batchId
  )

  writeAudit({
    batchId,
    operator: 'local-admin',
    role: 'level1',
    scope: 'unit',
    action: 'batch.update',
    target: batchId,
    detail: { year: input.year, semester: input.semester, isTest: existing.isTest === true }
  })

  return getBatch(batchId)!
}

/** 批次状态迁移（draft → active → closed），单向推进。 */
async function transitionBatch(batchId: string, to: BatchStatus, action: string): Promise<Batch> {
  assertWritable()
  assertLevel1(action)
  const existing = getBatch(batchId)
  if (!existing) throw new Error('批次不存在或已被删除')
  try {
    assertBatchTransition(existing.status, to)
  } catch {
    // 共享层断言抛的是“非法状态迁移：draft → active”（含英文枚举），用户不可见，转中文
    throw new Error('当前状态不允许执行此操作')
  }
  // 激活时再次校验“同时仅一个进行中（同类）”约束
  if (to === 'active') {
    assertBatchAvailable(existing.year, existing.semester, existing.isTest === true, batchId)
  }

  const db = getDb()
  db.prepare('UPDATE batch SET status = ?, updated_at = ? WHERE id = ?').run(to, Date.now(), batchId)
  writeAudit({
    batchId,
    operator: 'local-admin',
    role: currentRole(),
    scope: 'unit',
    action,
    target: batchId,
    detail: {
      year: existing.year,
      semester: existing.semester,
      isTest: existing.isTest === true,
      from: existing.status,
      to
    }
  })
  // 上报批次状态迁移（离线 no-op；在线 POST /batches/:id/status，为学生端感知激活/关闭预留）。
  const published = await publishBatchStatusReliable(batchId, to)
  if (!published) {
    // 本地状态已经提交；状态 outbox 会在网络恢复或应用重启后自动重试。
    writeAudit({
      batchId,
      operator: 'local-admin',
      role: 'level1',
      scope: 'unit',
      action: 'batch.status-sync.pending',
      target: batchId,
      detail: { status: to }
    })
  }
  return getBatch(batchId)!
}

/** 激活批次（draft → active）。 */
export function activateBatch(batchId: string): Promise<Batch> {
  return transitionBatch(batchId, 'active', 'batch.activate')
}

/** 关闭批次（active → closed）。 */
export function closeBatch(batchId: string): Promise<Batch> {
  return transitionBatch(batchId, 'closed', 'batch.close')
}

/** A .dxy file must be based on a table exported after the latest score/list change. */
export function assertFreshTableExport(batchId: string): void {
  const batch = getBatch(batchId)
  if (!batch) throw new Error('批次不存在')
  if (!batch.rankedAt || (batch.scoresChangedAt && batch.rankedAt < batch.scoresChangedAt)) {
    throw new Error('排名尚未计算或已经过期，请先按最新数据重新计算排名')
  }
  if (!batch.tableExportedAt) {
    throw new Error('导出德育分数据文件前，请先导出一次公示表格')
  }
  if (batch.scoresChangedAt && batch.tableExportedAt < batch.scoresChangedAt) {
    throw new Error('分数或名单在上次表格导出后发生了变化，请重新计算排名并导出最新表格')
  }
}

/** Called only after the XLSX file has been written successfully. */
export function markTableExported(batchId: string): void {
  const batch = getBatch(batchId)
  if (!batch) throw new Error('批次不存在')
  if (!batch.rankedAt || (batch.scoresChangedAt && batch.rankedAt < batch.scoresChangedAt)) {
    throw new Error('排名尚未计算或已经过期，不能登记本次表格导出')
  }
  const now = Date.now()
  getDb().prepare('UPDATE batch SET table_exported_at = ?, updated_at = ? WHERE id = ?').run(now, now, batchId)
  writeAudit({
    batchId,
    operator: 'local-admin',
    role: currentRole(),
    scope: 'unit',
    action: 'score-table.export',
    target: batchId,
    detail: { exportedAt: now }
  })
}
