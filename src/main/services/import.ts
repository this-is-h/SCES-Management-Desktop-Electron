/**
 * 导入服务：导入学生端导出的 .dyf 加密申请文件（架构 §3.3 / §5.1 / §7）。
 *
 * 流程：读文件 → JSON 解析 → 批次私钥解密（校验完整性哈希）→ 校验 payload →
 *       学号冲突判定（shared checkImport）→
 *         accept  正常导入（学生/申请/版本/德育明细落库，证据落盘）
 *         reject  直接拒绝（重复导入 / 可疑导入），记录审计
 *         conflict 暂存待处理（import_conflict 表），由管理端处理（见 conflict.ts）
 *
 * 防篡改：重复导入拒绝、导入即进入 reviewing（学生端只读）、每次导入写审计。
 */
import { createReadStream, mkdirSync, readFileSync } from 'fs'
import { open, rm } from 'fs/promises'
import { basename, join } from 'path'
import { randomUUID, createHash } from 'crypto'
import type {
  Apply,
  Batch,
  UnitConfig,
  ExistingStudent,
  ImportPayload,
  Student
} from '@sces/shared'
import {
  BATCH_STATUS_LABELS,
  checkImport,
  bytesToBase64,
  decryptDyfContainerFromSource,
  readDyfContainerHeader,
  normalizeImportDyf,
  validateApplyPayload
} from '@sces/shared'
import { getDb } from '../db'
import { resolveDecryptKeys } from './apply-key'
import { assertBatchNotExported, getBatch } from './batch'
import { getTemplate } from './config-template'
import { assertReadableFile, MAX_APPLICATION_FILE_BYTES } from './file-guard'
import { writeAudit } from './audit'
import { assertWritable } from './license'
import { currentRole, currentScope, outOfScopeReason } from './role'
import { touchScoresChanged } from './ranking'
import {
  commitEvidenceStage,
  createEvidenceStage,
  discardEvidenceStage,
  evidenceBaseDir,
  stageEvidenceAssetFile,
  stageConfirmSlip,
  stageEvidenceFiles
} from './evidence'
import { importBatchExchange } from './exchange'
import { publishApplyStatusReliable } from './status-outbox'
import { userFacingErrorMessage } from './user-error'
import type { ImportFileResult } from '../../preload/types'
import { insertTimelineEvent, writeTimelineEvent } from './timeline'

type ImportedAssetFile = {
  path: string
  descriptor: { assetId: string; sha256: string; mimeType: string; size: number }
}

/**
 * 导入一个/多个统一扩展名 `.dyf` 文件：学生申请或管理端数据交换。
 * 通过容器头部的 documentType 路由，逐文件处理，互不影响。
 * overwrite：仅一级管理端交换导入时生效（覆盖已有数据，渲染层已提示）。
 */
export async function importApplyFiles(
  batchId: string,
  filePaths: string[],
  options: { overwrite?: boolean } = {}
): Promise<ImportFileResult[]> {
  assertWritable()
  const batch = getBatch(batchId)
  if (!batch) throw new Error('批次不存在')
  assertImportable(batch)
  assertBatchNotExported(batch)
  const template = batch.configTemplateId ? getTemplate(batch.configTemplateId) : null
  if (!template) throw new Error('批次配置模板缺失，无法解析申请内容')

  const results: ImportFileResult[] = []
  for (const filePath of filePaths) {
    try {
      // 扩展名白名单 + 大小上限（渲染层路径不可信；异步 readFile 前先校验，避免读大文件阻塞主进程）
      assertReadableFile(filePath, ['.dyf'], MAX_APPLICATION_FILE_BYTES)
      const { header } = await readContainerHeaderFromFile(filePath)
      if (header.documentType === 'admin-exchange') {
        results.push(...(await importBatchExchange(batch, filePath, options.overwrite ?? false)))
      } else if (header.documentType === 'student-application') {
        results.push(await importOneFile(batch, template, filePath))
      } else {
        results.push({
          fileName: basename(filePath),
          ok: false,
          decision: 'error',
          reason: '文件不是受支持的德育分 v2 文件（缺少有效 documentType）'
        })
      }
    } catch (err) {
      // 单个文件异常不阻断其余文件
      results.push({
        fileName: basename(filePath),
        ok: false,
        decision: 'error',
        reason: userFacingErrorMessage(
          err,
          '导入失败，请确认文件完整、格式正确且未被其他程序占用',
          `import:${basename(filePath)}`
        )
      })
    }
  }
  // 有文件成功导入（新增/更新申请与分数）→ 标记排名过期，需重新计算
  if (results.some((r) => r.ok)) touchScoresChanged(batchId)
  return results
}

/** Reads only the fixed prefix and JSON header; the encrypted frame body is not loaded for routing. */
export async function readContainerHeaderFromFile(filePath: string): Promise<{
  header: ReturnType<typeof readDyfContainerHeader>
  frameOffset: number
  size: number
}> {
  const handle = await open(filePath, 'r')
  try {
    const prefixLength = 12
    const prefix = Buffer.alloc(prefixLength)
    const first = await handle.read(prefix, 0, prefixLength, 0)
    if (first.bytesRead !== prefixLength) throw new Error('DYF 文件头部不完整')
    const headerLength = prefix.readUInt32BE(8)
    if (headerLength < 2 || headerLength > 16 * 1024 * 1024) throw new Error('DYF 头部长度无效')
    const headerData = Buffer.alloc(prefixLength + headerLength)
    prefix.copy(headerData, 0)
    const rest = await handle.read(headerData, prefixLength, headerLength, prefixLength)
    if (rest.bytesRead !== headerLength) throw new Error('DYF 文件头部不完整')
    const stats = await handle.stat()
    return { header: readDyfContainerHeader(headerData), frameOffset: prefixLength + headerLength, size: stats.size }
  } finally {
    await handle.close()
  }
}

async function hashFilePath(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

async function rmAssetTempDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

/** 校验批次可导入：仅「进行中」批次接收申请文件（未开放/已结束均拒绝，决策 #14）。 */
export function assertImportable(batch: Batch): void {
  if (batch.status !== 'active') {
    const label = BATCH_STATUS_LABELS[batch.status] ?? batch.status
    throw new Error(label === '未开放' ? '批次未开放，请先在「批次管理」中激活批次后再导入' : `批次已${label}，无法再导入申请文件`)
  }
}

/** 导入单个文件（解密 + 校验 + 判定 + 落库）。 */
async function importOneFile(
  batch: Batch,
  template: UnitConfig,
  filePath: string
): Promise<ImportFileResult> {
  const fileName = basename(filePath)

  // 1. 读文件与 JSON 解析
  let header: ReturnType<typeof readDyfContainerHeader>
  let frameOffset = 0
  let fileSize = 0
  try {
    const source = await readContainerHeaderFromFile(filePath)
    header = source.header
    frameOffset = source.frameOffset
    fileSize = source.size
  } catch (error) {
    return {
      fileName,
      ok: false,
      decision: 'error',
      reason: userFacingErrorMessage(
        error,
        '文件无法解析，请确认是完整的 .dyf 学生申请文件',
        `dyf-read:${fileName}`
      )
    }
  }

  if (header.documentType !== 'student-application' || header.type !== 'apply') {
    return {
      fileName,
      ok: false,
      decision: 'error',
      reason: '仅支持德育分 v2 学生申请文件；旧版本文件不再导入'
    }
  }

  // 2. 解密 + 完整性校验：按 file.keyId → batch.keyId → apply_key 全表 → batch 私钥 逐把回退。
  const candidates = resolveDecryptKeys(batch, header.keyId)
  let payload: unknown
  let hash = ''
  let fileHash = ''
  const assetTempDir = join(evidenceBaseDir(), '.staging', `student-${randomUUID()}`)
  mkdirSync(assetTempDir, { recursive: true })
  const assetFiles = new Map<string, { path: string; descriptor: { assetId: string; sha256: string; mimeType: string; size: number } }>()
  const assetHandles = new Map<number, Awaited<ReturnType<typeof open>>>()
  const assetHashes = new Map<number, ReturnType<typeof createHash>>()
  const cleanupAssets = async (): Promise<void> => {
    for (const handle of assetHandles.values()) {
      try {
        await handle.close()
      } catch {
        // Best effort cleanup after a failed import.
      }
    }
    await rmAssetTempDir(assetTempDir)
  }
  const resetAssetsForRetry = async (): Promise<void> => {
    await cleanupAssets()
    mkdirSync(assetTempDir, { recursive: true })
    assetFiles.clear()
    assetHandles.clear()
    assetHashes.clear()
  }
  let decrypted = false
  for (const privateKeyJwk of candidates) {
    let sourceHandle: Awaited<ReturnType<typeof open>> | null = null
    try {
      sourceHandle = await open(filePath, 'r')
      const result = await decryptDyfContainerFromSource({
        header,
        frameOffset,
        totalSize: fileSize,
        privateKeyJwk,
        read: async (offset, length) => {
          const buffer = Buffer.allocUnsafe(length)
          let completed = 0
          while (completed < length) {
            const part = await sourceHandle!.read(buffer, completed, length - completed, offset + completed)
            if (part.bytesRead < 1) throw new Error('DYF 文件读取不完整')
            completed += part.bytesRead
          }
          return buffer
        },
        writeAssetChunk: async (asset, assetIndex, offset, chunk) => {
          let target = assetFiles.get(asset.assetId)
          if (!target) {
            target = {
              path: join(assetTempDir, `${assetIndex}-${asset.sha256}.part`),
              descriptor: { assetId: asset.assetId, sha256: asset.sha256, mimeType: asset.mimeType, size: asset.size }
            }
            assetFiles.set(asset.assetId, target)
          }
          let handle = assetHandles.get(assetIndex)
          if (!handle) {
            handle = await open(target.path, 'w')
            assetHandles.set(assetIndex, handle)
            assetHashes.set(assetIndex, createHash('sha256'))
          }
          await handle.write(Buffer.from(chunk), 0, chunk.length, offset)
          assetHashes.get(assetIndex)!.update(chunk)
        },
        validateAsset: async (asset, assetIndex) => {
          const handle = assetHandles.get(assetIndex)
          if (handle) await handle.close()
          const digest = assetHashes.get(assetIndex)
          if (!digest || digest.digest('hex') !== asset.sha256) throw new Error(`DYF 资产完整性校验失败：${asset.assetId}`)
        }
      })
      await sourceHandle.close()
      sourceHandle = null
      payload = result.payload
      hash = result.hash
      fileHash = await hashFilePath(filePath)
      decrypted = true
      break
    } catch {
      if (sourceHandle) await sourceHandle.close()
      await resetAssetsForRetry()
      // 换下一把密钥重试
    }
  }
  if (!decrypted) {
    await cleanupAssets()
    return {
      fileName,
      ok: false,
      decision: 'error',
      reason: '无法解密该申请文件，可能不是本单位或本批次的文件'
    }
  }

  // 3. 校验 payload 必填项与批次归属
  const validation = validateApplyPayload(
    payload as {
      applyId?: unknown
      batchId?: unknown
      revision?: unknown
      personal?: Record<string, unknown>
      dyf?: unknown
    },
    { requireDyf: true }
  )
  if (!validation.ok) {
    await cleanupAssets()
    return { fileName, ok: false, decision: 'error', reason: validation.errors.join('；') }
  }
  const p = payload as ImportPayload
  if (p.documentType !== 'student-application') {
    await cleanupAssets()
    return { fileName, ok: false, decision: 'error', reason: '学生申请文件内容类型无效' }
  }
  if (p.batchId !== batch.batchId) {
    const fileTerm =
      p.personal.year && p.personal.semester
        ? `文件属于 ${p.personal.year} 学年第 ${p.personal.semester} 学期，`
        : ''
    await cleanupAssets()
    return {
      fileName,
      ok: false,
      decision: 'error',
      reason: `文件批次与当前批次不符（${fileTerm}当前批次为 ${batch.year} 学年第 ${batch.semester} 学期），无法导入`
    }
  }
  const studentId = String(p.personal.studentId ?? '').trim()
  const name = String(p.personal.name ?? '').trim()
  if (!studentId || !name) {
    await cleanupAssets()
    return { fileName, ok: false, decision: 'error', reason: '申请文件缺少学号或姓名' }
  }

  const normalized = normalizeImportDyf(p, template)
  if (normalized.unknownItems.length > 0) {
    await cleanupAssets()
    return {
      fileName,
      ok: false,
      decision: 'error',
      reason: `申请文件包含当前单位配置中不存在的项目：${normalized.unknownItems.join('、')}`
    }
  }
  const overLimit = normalized.scores.find(
    (score) => score.maxScore !== undefined && score.appliedScore > score.maxScore
  )
  if (overLimit) {
    await cleanupAssets()
    return {
      fileName,
      ok: false,
      decision: 'error',
      reason: `德育分项目 ${overLimit.itemCode} 的申请分超过配置上限 ${overLimit.maxScore}`
    }
  }

  // 数据范围门禁（§5.4/§6）：二三级越权学生直接拒绝（落审计），避免落库后被 scope 过滤造成不一致。
  const scopeReject = outOfScopeReason(p.personal)
  if (scopeReject) {
    writeAudit({
      batchId: batch.batchId,
      operator: 'local-admin',
      role: currentRole(),
      scope: 'unit',
      action: 'import.reject',
      target: studentId,
      detail: { fileName, name, applyId: p.applyId, revision: p.revision, reason: scopeReject }
    })
    await cleanupAssets()
    return { fileName, ok: false, decision: 'reject', reason: scopeReject, studentId, name }
  }

  // 4. 学号冲突判定（§7.2 / §7.3）
  const existing = findExisting(batch.batchId, studentId)

  // 班级端审核门禁（决策 #17）：该学号已被标记为班级端审核（整班导出后 confirmed），
  // 同级账号也不得再导入这些学生的信息或导出的整班文件。
  if (existing?.applyStatus === 'confirmed') {
    writeAudit({
      batchId: batch.batchId,
      operator: 'local-admin',
      role: currentRole(),
      scope: 'unit',
      action: 'import.reject',
      target: studentId,
      detail: { fileName, name, applyId: p.applyId, revision: p.revision, reason: '已完成班级端审核' }
    })
    await cleanupAssets()
    return {
      fileName,
      ok: false,
      decision: 'reject',
      reason: '该学号已完成班级端审核并整班导出，无法再次导入',
      studentId,
      name
    }
  }

  const decision = checkImport({ studentId, name, applyId: p.applyId, existing })
  const role = currentRole()

  if (decision.decision === 'reject') {
    writeAudit({
      batchId: batch.batchId,
      operator: 'local-admin',
      role,
      scope: 'unit',
      action: 'import.reject',
      target: studentId,
      detail: { fileName, name, applyId: p.applyId, revision: p.revision, reason: decision.reason }
    })
    await cleanupAssets()
    return { fileName, ok: false, decision: 'reject', reason: decision.reason, studentId, name }
  }

  if (decision.decision === 'conflict') {
    let conflictPayload: ImportPayload
    try {
      conflictPayload = await materializeStudentAssetFiles(p, assetFiles)
    } catch (error) {
      await cleanupAssets()
      throw error
    }
    const conflictId = stageConflict(
      batch.batchId,
      studentId,
      existing!.name,
      name,
      conflictPayload,
      fileName,
      hash
    )
    writeAudit({
      batchId: batch.batchId,
      operator: 'local-admin',
      role,
      scope: 'unit',
      action: 'import.conflict.staged',
      target: studentId,
      detail: {
        fileName,
        existingName: existing!.name,
        incomingName: name,
        applyId: p.applyId,
        conflictId
      }
    })
    await cleanupAssets()
    return {
      fileName,
      ok: true,
      decision: 'conflict',
      studentId,
      name,
      applyId: p.applyId,
      revision: p.revision,
      conflictId
    }
  }

  // 5. accept：落库 + 申请期外导出提示 + 状态上报
  try {
    importAcceptedPayload(batch, template, p, fileHash || hash, assetFiles)
  } catch (error) {
    await cleanupAssets()
    throw error
  }
  await cleanupAssets()
  const warnings: string[] = []
  if (typeof p.exportedAt === 'number' && batch.applyEndAt && p.exportedAt > batch.applyEndAt) {
    warnings.push(`该申请在申请期外导出（导出时间 ${new Date(p.exportedAt).toLocaleString('zh-CN')}）`)
  }
  writeAudit({
    batchId: batch.batchId,
    operator: 'local-admin',
    role,
    scope: 'unit',
    action: 'import.accept',
    target: studentId,
    detail: {
      fileName,
      name,
      applyId: p.applyId,
      revision: p.revision,
      scoreCount: Object.keys(p.dyf ?? {}).length,
      ...(warnings.length ? { warnings } : {})
    }
  })
  // 上报申请状态（离线 no-op；在线 POST /applies/:id/status，为学生端感知"已导入"预留）。
  const synced = await publishApplyStatusReliable({
    applyId: p.applyId,
    batchId: batch.batchId,
    status: 'reviewing',
    revision: p.revision
  })
  if (!synced) {
    warnings.push('在线状态尚未同步，联网后请重试状态同步')
  }
  return {
    fileName,
    ok: true,
    decision: 'accept',
    studentId,
    name,
    applyId: p.applyId,
    revision: p.revision,
    ...(warnings.length ? { warnings } : {})
  }
}

/** 查询已有学生（含当前申请状态，供重复导入判定）。 */
export function findExisting(batchId: string, studentId: string): ExistingStudent | undefined {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT id, student_id AS studentId, name, id_conflict_locked AS idConflictLocked,
              name_corrected AS nameCorrected
       FROM student WHERE batch_id = ? AND student_id = ?`
    )
    .get(batchId, studentId) as
    | {
        id: number
        studentId: string
        name: string
        idConflictLocked: number
        nameCorrected: number
      }
    | undefined
  if (!row) return undefined
  const apply = db
    .prepare(
      `SELECT status FROM apply WHERE batch_id = ? AND student_id = ? ORDER BY imported_at DESC LIMIT 1`
    )
    .get(batchId, row.id) as { status: string } | undefined
  return {
    studentId: row.studentId,
    name: row.name,
    idConflictLocked: row.idConflictLocked === 1,
    nameCorrected: row.nameCorrected === 1,
    applyStatus: (apply?.status as Apply['status']) ?? undefined
  }
}

/** 暂存冲突（import_conflict），返回冲突记录 id。 */
function stageConflict(
  batchId: string,
  studentId: string,
  existingName: string,
  incomingName: string,
  payload: unknown,
  fileName: string,
  fileHash: string
): number {
  const db = getDb()
  const r = db
    .prepare(
      `INSERT INTO import_conflict (batch_id, student_id, existing_name, incoming_name, payload, file_name, file_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      batchId,
      studentId,
      existingName,
      incomingName,
      JSON.stringify(payload),
      fileName,
      fileHash,
      Date.now()
    )
  return Number(r.lastInsertRowid)
}

/** 读取某学生行（无则 undefined）。 */
export function findStudentRow(batchId: string, studentId: string): Student | undefined {
  const row = getDb()
    .prepare(
      `SELECT id, batch_id AS batchId, student_id AS studentId, name, phone, grade, major,
              class_name AS className, id_conflict_locked AS idConflictLocked,
              name_corrected AS nameCorrected
       FROM student WHERE batch_id = ? AND student_id = ?`
    )
    .get(batchId, studentId) as Record<string, unknown> | undefined
  if (!row) return undefined
  return {
    id: row.id as number,
    batchId: row.batchId as string,
    studentId: row.studentId as string,
    name: row.name as string,
    phone: (row.phone as string | null) ?? undefined,
    grade: (row.grade as string | null) ?? undefined,
    major: (row.major as string | null) ?? undefined,
    className: (row.className as string | null) ?? undefined,
    idConflictLocked: row.idConflictLocked === 1,
    nameCorrected: row.nameCorrected === 1
  }
}

/**
 * 将已通过判定的申请 payload 落库（accept 路径与冲突处理 incoming 路径共用）。
 * 事务：学生（存在则复用）→ 申请（reviewing）→ 版本 → 德育明细 + 证据落盘。
 * 调用方须保证：该学号当前没有其他已导入申请（冲突处理已先清理旧申请）。
 */
export function importAcceptedPayload(
  batch: Batch,
  template: UnitConfig,
  payload: ImportPayload,
  fileHash: string,
  assetFiles?: Map<string, ImportedAssetFile>
): void {
  const db = getDb()
  const studentId = String(payload.personal.studentId ?? '').trim()
  const now = Date.now()
  const evidenceStage = createEvidenceStage(batch.batchId, studentId)

  try {
    const insert = db.transaction(() => {
    // 学生：存在则复用（冲突处理 incoming 路径已改名一致），否则新建
    let student = findStudentRow(batch.batchId, studentId)
    if (!student) {
      const r = db
        .prepare(
          `INSERT INTO student (batch_id, student_id, name, phone, grade, major, class_name, id_conflict_locked, name_corrected)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`
        )
        .run(
          batch.batchId,
          studentId,
          String(payload.personal.name ?? '').trim(),
          nullableString(payload.personal.phone),
          nullableString(payload.personal.grade),
          nullableString(payload.personal.major),
          nullableString(payload.personal.className)
        )
      student = findStudentRow(batch.batchId, studentId)
      if (!student) throw new Error('学生记录写入失败')
      void r
    }

    // 申请：学生×批次唯一，不得重复
    const existingApply = db
      .prepare('SELECT apply_id AS applyId FROM apply WHERE batch_id = ? AND student_id = ?')
      .get(batch.batchId, student.id)
    if (existingApply) {
      throw new Error('该学号已有导入的申请，重复导入被拒绝')
    }
    const latestStudentExportAt = payload.lifecycle?.exports?.reduce(
      (latest, item) => Math.max(latest, Number(item.exportedAt) || 0),
      Number(payload.exportedAt) || 0
    ) || null
    db.prepare(
      `INSERT INTO apply (apply_id, batch_id, student_id, status, current_revision, imported_at,
                          first_entered_at, last_student_exported_at, last_imported_at)
       VALUES (?, ?, ?, 'reviewing', ?, ?, ?, ?, ?)`
    ).run(
      payload.applyId,
      batch.batchId,
      student.id,
      payload.revision,
      now,
      payload.lifecycle?.enteredAt ?? null,
      latestStudentExportAt,
      now
    )

    // 版本快照
    db.prepare(
      `INSERT INTO apply_revision (apply_id, revision, file_hash, created_at) VALUES (?, ?, ?, ?)`
    ).run(payload.applyId, payload.revision, fileHash, now)

    // 德育明细（category/allowAdd/maxScore 由模板解析）+ 证据落盘
    const { scores } = normalizeImportDyf(payload, template)
    const insertScore = db.prepare(
      `INSERT INTO dyf_score (apply_id, item_code, category, applied_score, final_score, max_score, allow_add, evidence_files)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`
    )
    for (const s of scores) {
      const evidencePaths = s.evidenceRefs && assetFiles
        ? s.evidenceRefs.map((ref, index) => {
            const asset = assetFiles.get(ref)
            if (!asset) throw new Error(`缺少证明材料资产正文 ${ref}`)
            return stageEvidenceAssetFile(
              evidenceStage,
              s.itemCode,
              index + 1,
              asset.path,
              asset.descriptor.assetId,
              asset.descriptor.mimeType,
              asset.descriptor.size
            )
          })
        : stageEvidenceFiles(evidenceStage, s.itemCode, s.evidence)
      insertScore.run(
        payload.applyId,
        s.itemCode,
        s.category,
        s.appliedScore,
        s.maxScore ?? null,
        s.allowAdd ? 1 : 0,
        JSON.stringify(evidencePaths)
      )
    }

    // 确认单（学生端签字确认单截图）落盘 + 记录相对路径（审核端可查看/保存）
    if (payload.confirmSlip) {
      const slipPath = stageConfirmSlip(evidenceStage, payload.confirmSlip)
      db.prepare('UPDATE apply SET confirm_slip = ? WHERE apply_id = ?').run(slipPath, payload.applyId)
    } else if (payload.confirmSlipRef && assetFiles) {
      const asset = assetFiles.get(payload.confirmSlipRef)
      if (!asset) throw new Error(`缺少确认单资产正文 ${payload.confirmSlipRef}`)
      const slipPath = stageEvidenceAssetFile(
        evidenceStage,
        'confirm-slip',
        1,
        asset.path,
        asset.descriptor.assetId,
        asset.descriptor.mimeType,
        asset.descriptor.size
      )
      db.prepare('UPDATE apply SET confirm_slip = ? WHERE apply_id = ?').run(slipPath, payload.applyId)
    }
    const sourceTimeline = Array.isArray(payload.timeline) ? payload.timeline : []
    for (const event of sourceTimeline) {
      if (!event || typeof event.eventId !== 'string' || !event.eventId) continue
      if (event.action !== 'student.entered' && event.action !== 'student.exported') continue
      insertTimelineEvent({
        eventId: event.eventId,
        batchId: batch.batchId,
        applyId: payload.applyId,
        actorType: 'student',
        action: event.action,
        occurredAt: event.occurredAt,
        revision: event.revision,
        sourceFileHash: event.sourceFileHash
      })
    }
    if (payload.lifecycle?.enteredAt && !sourceTimeline.some((event) => event.action === 'student.entered')) {
      insertTimelineEvent({
        batchId: batch.batchId,
        applyId: payload.applyId,
        actorType: 'student',
        action: 'student.entered',
        occurredAt: payload.lifecycle.enteredAt
      })
    }
    writeTimelineEvent({
      batchId: batch.batchId,
      applyId: payload.applyId,
      actorType: 'admin',
      role: currentRole(),
      scope: { ...currentScope() },
      action: 'admin.imported',
      occurredAt: now,
      revision: payload.revision,
      sourceFileHash: fileHash,
      detail: { source: 'student-application' }
    })
    // Make the complete evidence set visible only after all files were written.
    commitEvidenceStage(evidenceStage)
  })
    insert()
  } catch (error) {
    discardEvidenceStage(evidenceStage)
    throw error
  }
}

/** 空字符串 → null（SQLite 空值），避免存空串。 */
function nullableString(value: unknown): string | null {
  const v = String(value ?? '').trim()
  return v ? v : null
}

/** Creates a durable conflict snapshot by embedding only that student's assets. */
async function materializeStudentAssetFiles(
  payload: ImportPayload,
  assets: Map<string, ImportedAssetFile>
): Promise<ImportPayload> {
  const next = JSON.parse(JSON.stringify(payload)) as ImportPayload
  for (const entry of Object.values(next.dyf ?? {})) {
    const refs = entry.evidenceRefs
    if (!refs) continue
    entry.evidence = refs.map((ref) => {
      const asset = assets.get(ref)
      if (!asset) throw new Error(`学生申请文件缺少证明材料正文 ${ref}`)
      return bytesToBase64(readFileSync(asset.path))
    })
    delete entry.evidenceRefs
  }
  if (next.confirmSlipRef) {
    const asset = assets.get(next.confirmSlipRef)
    if (!asset) throw new Error(`学生申请文件缺少确认单正文 ${next.confirmSlipRef}`)
    next.confirmSlip = bytesToBase64(readFileSync(asset.path))
    delete next.confirmSlipRef
  }
  return next
}
