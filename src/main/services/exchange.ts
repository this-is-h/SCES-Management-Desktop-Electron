/**
 * 管理端间数据交换（.dyf，架构 §5.3 / M6：三级 → 二级 → 一级）。
 *
 * - 导出（streamBatchExchange）：把当前账号 scope 内的学生、申请和德育明细按帧加密并直接写入文件。
 *   内嵌 SHA-256（复用 .dyf 混合加密 encryptPayload），产出 .dyf 文件字节。一级为汇总终端，不导出（issue #5）。
 * - 导入（importBatchExchange）：用批次私钥解密 + 校验哈希，按角色合并（issue #5）：
 *     · 二三级：越权 / 已存在一律跳过——不制造冲突、不覆盖旧数据；
 *     · 一级：可覆盖已有数据（渲染层已弹「会覆盖旧数据」提示，overwrite=true 时生效）。
 * 各级经 .dysd 批次快照持有同一批次公私钥，故互解。
 * v2：携带证明材料与确认单（原始 base64，与 .dyf payload 证据格式一致），让上级复核能看到实际证明，而非只看分数。
 */
import { createReadStream, createWriteStream, mkdirSync } from 'fs'
import { open as openFile, rename, rm, stat as statAsync } from 'fs/promises'
import { basename, join } from 'path'
import { tmpdir } from 'os'
import { createHash, randomUUID } from 'crypto'
import { once } from 'events'
import type { Batch, UnitConfig } from '@sces/shared'
import {
  decryptDyfContainerFromSource,
  encryptDyfContainerToSink,
  findTemplateItem,
  readDyfContainerHeader
} from '@sces/shared'
import { getDb } from '../db'
import { writeAudit } from './audit'
import { buildExportName } from './export-naming'
import { currentRole, currentScope, outOfScopeReason, studentScopeSql } from './role'
import {
  collectEvidenceDirs,
  commitEvidenceStage,
  createEvidenceStage,
  discardEvidenceStage,
  evidenceBaseDir,
  removeEvidenceDirs,
  stageConfirmSlip,
  stageEvidenceAssetFile,
  stageEvidenceFiles,
  resolveEvidencePath,
  type EvidenceStage
} from './evidence'
import { touchScoresChanged } from './ranking'
import { userFacingErrorMessage } from './user-error'
import { getTemplate } from './config-template'
import type { ImportFileResult } from '../../preload/types'
import { insertTimelineEvent, writeTimelineEvent } from './timeline'

export interface ExchangeExportProgress {
  phase: 'prepare' | 'write' | 'finalize'
  completedFrames: number
  totalFrames: number
  writtenBytes: number
}

/** .dyf 管理端交换 payload schema 版本。 */
const EXCHANGE_SCHEMA_VERSION = 2
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

function isBase64(value: string): boolean {
  return value.length % 4 !== 1 && BASE64_RE.test(value)
}

function mimeFromPath(filePath: string): string {
  const ext = filePath.toLowerCase().split('.').pop() ?? ''
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'png') return 'image/png'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  return 'application/octet-stream'
}

async function hashEvidencePath(relativePath: string): Promise<{ sha256: string; size: number }> {
  const absolutePath = resolveEvidencePath(relativePath)
  const stats = await statAsync(absolutePath)
  if (!stats.isFile()) throw new Error(`证据材料不是文件：${relativePath}`)
  const hash = createHash('sha256')
  const stream = createReadStream(absolutePath)
  for await (const chunk of stream) hash.update(chunk)
  return { sha256: hash.digest('hex'), size: stats.size }
}

async function hashFilePath(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

async function readExchangeHeaderFromFile(filePath: string): Promise<{
  header: ReturnType<typeof readDyfContainerHeader>
  frameOffset: number
  size: number
}> {
  const stats = await statAsync(filePath)
  const handle = await openFile(filePath, 'r')
  try {
    const prefix = Buffer.alloc(12)
    const first = await handle.read(prefix, 0, prefix.length, 0)
    if (first.bytesRead !== prefix.length) throw new Error('DYF 文件头部不完整')
    const headerLength = prefix.readUInt32BE(8)
    if (headerLength < 2 || headerLength > 16 * 1024 * 1024) throw new Error('DYF 头部长度无效')
    const headerData = Buffer.alloc(prefix.length + headerLength)
    prefix.copy(headerData)
    const rest = await handle.read(headerData, prefix.length, headerLength, prefix.length)
    if (rest.bytesRead !== headerLength) throw new Error('DYF 文件头部不完整')
    return { header: readDyfContainerHeader(headerData), frameOffset: prefix.length + headerLength, size: stats.size }
  } finally {
    await handle.close()
  }
}

interface ExchangeScore {
  itemCode: string
  category: string
  appliedScore: number
  finalScore: number | null
  maxScore: number | null
  allowAdd: boolean
  /** 证明材料（兼容学生端 payload；管理端交换统一使用 evidenceRefs）。 */
  evidence?: string[]
  evidenceRefs?: string[]
}
interface ExchangeApply {
  applyId: string
  studentId: string
  status: string
  currentRevision: number
  scores: ExchangeScore[]
  /** 确认单截图（兼容学生端 payload；管理端交换统一使用 confirmSlipRef）。 */
  confirmSlip?: string
  confirmSlipRef?: string
  timeline?: Array<{
    eventId: string
    actorType: 'student' | 'admin' | 'system'
    role?: string
    action: string
    occurredAt: number
    revision?: number
    sourceFileHash?: string
    detail?: Record<string, unknown>
  }>
}
interface ExchangeStudent {
  studentId: string
  name: string
  phone: string | null
  grade: string | null
  major: string | null
  className: string | null
}

function validateExchangePayload(
  payload: unknown,
  batch: Batch,
  template: UnitConfig
): payload is ExchangePayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  const p = payload as Partial<ExchangePayload>
  if (p.documentType !== 'admin-exchange' || p.exchangeVersion !== EXCHANGE_SCHEMA_VERSION || p.batchId !== batch.batchId) return false
  if (p.year !== batch.year || p.semester !== batch.semester) return false
  if (!['level2', 'level3'].includes(String(p.fromRole ?? ''))) return false
  if (!p.fromScope || typeof p.fromScope !== 'object' || Array.isArray(p.fromScope)) return false
  if (p.fromScope.grade !== undefined && typeof p.fromScope.grade !== 'string') return false
  if (p.fromScope.class !== undefined && typeof p.fromScope.class !== 'string') return false
  if (typeof p.exportedAt !== 'number' || !Number.isFinite(p.exportedAt) || p.exportedAt <= 0)
    return false
  if (!Array.isArray(p.students) || !Array.isArray(p.applies)) return false
  const studentIds = new Set<string>()
  for (const s of p.students) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return false
    const student = s as ExchangeStudent
    if (
      typeof student.studentId !== 'string' ||
      !student.studentId.trim() ||
      typeof student.name !== 'string' ||
      !student.name.trim() ||
      studentIds.has(student.studentId)
    )
      return false
    studentIds.add(student.studentId)
    for (const value of [student.phone, student.grade, student.major, student.className]) {
      if (value !== null && typeof value !== 'string') return false
    }
  }
  const applyIds = new Set<string>()
  const applyStudents = new Set<string>()
  for (const a of p.applies) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return false
    const apply = a as ExchangeApply
    if (
      typeof apply.applyId !== 'string' ||
      !apply.applyId.trim() ||
      typeof apply.studentId !== 'string' ||
      applyIds.has(apply.applyId) ||
      !studentIds.has(apply.studentId)
    )
      return false
    if (!Number.isInteger(apply.currentRevision) || apply.currentRevision < 1) return false
    if (!['submitted', 'imported', 'reviewing', 'confirmed'].includes(apply.status)) return false
    if (!Array.isArray(apply.scores) || applyStudents.has(apply.studentId)) return false
    applyIds.add(apply.applyId)
    applyStudents.add(apply.studentId)
    const itemCodes = new Set<string>()
    for (const s of apply.scores) {
      if (!s || typeof s !== 'object' || Array.isArray(s)) return false
      const score = s as ExchangeScore
      if (
        typeof score.itemCode !== 'string' ||
        !/^\d+$/.test(score.itemCode) ||
        itemCodes.has(score.itemCode)
      )
        return false
      const configured = findTemplateItem(template, score.itemCode)
      if (!configured || score.category !== configured.category) return false
      if (
        typeof score.appliedScore !== 'number' ||
        !Number.isFinite(score.appliedScore) ||
        score.appliedScore < 0
      )
        return false
      if (
        score.finalScore !== null &&
        (typeof score.finalScore !== 'number' ||
          !Number.isFinite(score.finalScore) ||
          score.finalScore < 0)
      )
        return false
      if (
        score.maxScore !== null &&
        (typeof score.maxScore !== 'number' ||
          !Number.isFinite(score.maxScore) ||
          score.maxScore < 0)
      )
        return false
      const configuredMax = configured.maxScore ?? null
      if (score.maxScore !== configuredMax || score.allowAdd !== configured.allowAdd) return false
      if (
        configuredMax !== null &&
        (score.appliedScore > configuredMax ||
          (score.finalScore !== null && score.finalScore > configuredMax))
      )
        return false
      if (score.evidence !== undefined) {
        if (
          !Array.isArray(score.evidence) ||
          score.evidence.some(
            (evidence) => typeof evidence !== 'string' || !evidence || !isBase64(evidence)
          )
        )
          return false
      }
      if (score.evidenceRefs !== undefined) {
        if (
          !Array.isArray(score.evidenceRefs) ||
          score.evidenceRefs.some((ref) => typeof ref !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(ref))
        ) return false
      }
      itemCodes.add(score.itemCode)
    }
    if (apply.confirmSlip !== undefined) {
      if (typeof apply.confirmSlip !== 'string') return false
      if (!apply.confirmSlip || !isBase64(apply.confirmSlip)) return false
    }
    if (apply.confirmSlipRef !== undefined &&
      (typeof apply.confirmSlipRef !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(apply.confirmSlipRef))) return false
    if (apply.timeline !== undefined) {
      if (!Array.isArray(apply.timeline)) return false
      for (const event of apply.timeline) {
        if (!event || typeof event.eventId !== 'string' || !event.eventId ||
          !['student', 'admin', 'system'].includes(event.actorType) ||
          typeof event.action !== 'string' || !Number.isFinite(event.occurredAt)) return false
      }
    }
  }
  const assetIds = new Set<string>()
  if (p.assets !== undefined) {
    if (!Array.isArray(p.assets)) return false
    for (const asset of p.assets) {
      if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return false
      if (
        typeof asset.assetId !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test(asset.assetId) ||
        assetIds.has(asset.assetId) ||
        typeof asset.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(asset.sha256) ||
        asset.assetId !== `sha256:${asset.sha256}` ||
        typeof asset.mimeType !== 'string' ||
        typeof asset.size !== 'number' ||
        !Number.isInteger(asset.size) ||
        asset.size < 1
      ) return false
      assetIds.add(asset.assetId)
    }
  }
  for (const apply of p.applies) {
    for (const score of apply.scores) {
      for (const ref of score.evidenceRefs ?? []) if (!assetIds.has(ref)) return false
    }
    if (apply.confirmSlipRef && !assetIds.has(apply.confirmSlipRef)) return false
  }
  return true
}

/** .dyf 管理端交换明文 payload（加密前）。 */
export interface ExchangePayload {
  documentType: 'admin-exchange'
  exchangeVersion: number
  batchId: string
  year: number
  semester: number
  /** 导出方角色与范围（供上级识别来源）。 */
  fromRole: string
  fromScope: { grade?: string; class?: string }
  exportedAt: number
  students: ExchangeStudent[]
  applies: ExchangeApply[]
  assets?: Array<{ assetId: string; sha256: string; mimeType: string; size: number }>
}

function resolveExchangeAssetFile(
  payload: ExchangePayload,
  ref: string,
  assets: Map<string, { path: string; descriptor: { assetId: string; sha256: string; mimeType: string; size: number } }>
): { path: string; descriptor: { assetId: string; sha256: string; mimeType: string; size: number } } {
  const descriptor = (payload.assets ?? []).find((item) => item.assetId === ref)
  const asset = assets.get(ref)
  if (!descriptor || !asset) throw new Error(`交换文件缺少证明材料正文 ${ref}`)
  return asset
}

export function getBatchExchangeFileName(batch: Batch): string {
  return `${buildExportName(batch, '德育分数据')}.dyf`
}

/**
 * 导出当前账号 scope 内的批次数据为 .dyf（发送给上级复核）。一级为终端，不导出。
 * 只读——不改动任何库状态；由调用方（IPC）写盘成功后再决定是否确认锁定。
 */
async function streamBatchExchange(
  batch: Batch,
  sink: {
    write: (chunk: Uint8Array) => Promise<void>
    onProgress?: (progress: ExchangeExportProgress) => void
  }
): Promise<{ fileName: string; frameCount: number; writtenBytes: number }> {
  const role = currentRole()
  if (role === 'level1') throw new Error('一级为汇总终端，无需导出数据（仅导入下级上交的数据）')
  const db = getDb()
  const sc = studentScopeSql({ grade: 's.grade', class: 's.class_name' })

  const studentStmt = db
    .prepare(
      `SELECT s.student_id AS studentId, s.name, s.phone, s.grade, s.major, s.class_name AS className
       FROM student s WHERE s.batch_id = ?${sc.clause} ORDER BY s.student_id`
    )
    .iterate(batch.batchId, ...sc.params) as IterableIterator<ExchangeStudent>
  const studentRows = studentStmt
  const applyRows = db
    .prepare(
      `SELECT a.apply_id AS applyId, s.student_id AS studentId, a.status, a.current_revision AS currentRevision,
              a.confirm_slip AS confirmSlip
       FROM apply a JOIN student s ON s.id = a.student_id
       WHERE a.batch_id = ?${sc.clause}`
    )
    .iterate(batch.batchId, ...sc.params) as IterableIterator<{
    applyId: string
    studentId: string
    status: string
    currentRevision: number
    confirmSlip: string | null
  }>

  const scoreStmt = db.prepare(
    `SELECT item_code AS itemCode, category, applied_score AS appliedScore, final_score AS finalScore,
            max_score AS maxScore, allow_add AS allowAdd, evidence_files AS evidenceFiles FROM dyf_score WHERE apply_id = ?`
  )
  const timelineStmt = db.prepare(
    `SELECT event_id AS eventId, actor_type AS actorType, role, action,
            occurred_at AS occurredAt, revision, source_file_hash AS sourceFileHash,
            detail_json AS detailJson
     FROM timeline_event WHERE apply_id = ? ORDER BY occurred_at, event_id`
  )
  // 仅保留去重后的资产元数据；正文在加密写出阶段按块读取，避免把整个班级的图片留在内存。
  const assets = new Map<string, { assetId: string; sha256: string; mimeType: string; size: number; sourcePath: string }>()
  const readEvidenceAsset = async (path: string): Promise<string> => {
    const digest = await hashEvidencePath(path)
    const sha256 = digest.sha256
    const ref = `sha256:${sha256}`
    if (!assets.has(ref)) {
      assets.set(ref, {
        assetId: ref,
        sha256,
        mimeType: mimeFromPath(path),
        size: digest.size,
        sourcePath: path
      })
    }
    return ref
  }
  let manifestPath = ''
  let manifestStream!: ReturnType<typeof createWriteStream>
  try {
  manifestPath = join(tmpdir(), `dms-dyf-manifest-${randomUUID()}.json`)
  manifestStream = createWriteStream(manifestPath, { flags: 'wx' })
  const manifestHash = createHash('sha256')
  let manifestSize = 0
  let manifestError: Error | null = null
  manifestStream.on('error', (error) => {
    manifestError = error instanceof Error ? error : new Error(String(error))
  })
  const writeManifestText = async (value: string): Promise<void> => {
    if (manifestError) throw manifestError
    const bytes = Buffer.from(value, 'utf8')
    manifestHash.update(bytes)
    manifestSize += bytes.length
    if (!manifestStream.write(bytes)) {
      await once(manifestStream, 'drain')
      if (manifestError) throw manifestError
    }
  }
  const scope = currentScope()
  const exportedAt = Date.now()
  await writeManifestText(
    JSON.stringify({
      documentType: 'admin-exchange',
      exchangeVersion: EXCHANGE_SCHEMA_VERSION,
      batchId: batch.batchId,
      year: batch.year,
      semester: batch.semester,
      fromRole: role,
      fromScope: scope,
      exportedAt
    }).replace(/}\s*$/, '') + ',"students":['
  )
  let firstStudent = true
  let studentCount = 0
  for (const student of studentRows) {
    await writeManifestText(`${firstStudent ? '' : ','}${JSON.stringify(student)}`)
    firstStudent = false
    studentCount++
  }
  if (studentCount === 0) throw new Error('鏈寖鍥存殏鏃犲鐢熸暟鎹彲瀵煎嚭')
  await writeManifestText(',"applies":[')
  let firstApply = true
  for (const a of applyRows) {
    const scores: ExchangeScore[] = []
    for (const r of scoreStmt.all(a.applyId) as Array<Record<string, unknown>>) {
      const evidencePaths = (r.evidenceFiles as string | null) ?? ''
      const evidenceRefs: string[] = []
      for (const p of JSON.parse(evidencePaths) as string[]) {
        evidenceRefs.push(await readEvidenceAsset(p))
      }
      scores.push({
        itemCode: r.itemCode as string,
        category: r.category as string,
        appliedScore: r.appliedScore as number,
        finalScore: (r.finalScore as number | null) ?? null,
        maxScore: (r.maxScore as number | null) ?? null,
        allowAdd: r.allowAdd === 1,
        ...(evidenceRefs.length ? { evidenceRefs } : {})
      })
    }
    const timeline = (timelineStmt.all(a.applyId) as Array<Record<string, unknown>>).map((event): NonNullable<ExchangeApply['timeline']>[number] => ({
      eventId: event.eventId as string,
      actorType: event.actorType as 'student' | 'admin' | 'system',
      role: (event.role as string | null) ?? undefined,
      action: event.action as string,
      occurredAt: event.occurredAt as number,
      revision: (event.revision as number | null) ?? undefined,
      sourceFileHash: (event.sourceFileHash as string | null) ?? undefined,
      detail: event.detailJson ? JSON.parse(event.detailJson as string) : undefined
    }))
    const applyRecord: ExchangeApply = {
      applyId: a.applyId,
      studentId: a.studentId,
      status: a.status,
      currentRevision: a.currentRevision,
      ...(a.confirmSlip ? { confirmSlipRef: await readEvidenceAsset(a.confirmSlip) } : {}),
      scores,
      ...(timeline.length ? { timeline } : {})
    }
    await writeManifestText(`${firstApply ? '' : ','}${JSON.stringify(applyRecord)}`)
    firstApply = false
  }

  const assetDescriptors = Array.from(assets.values()).map(({ assetId, sha256, mimeType, size }) => ({
    assetId,
    sha256,
    mimeType,
    size
  }))
  const assetHashers = new Map<string, ReturnType<typeof createHash>>()
  await writeManifestText(`],"assets":${JSON.stringify(assetDescriptors)}}`)
  await new Promise<void>((resolve, reject) => {
    if (manifestError) return reject(manifestError)
    manifestStream.once('error', reject)
    manifestStream.end(() => resolve())
  })
    const manifestSource = {
    size: manifestSize,
    contentHash: manifestHash.digest('hex'),
    readChunk: async (offset: number, maxBytes: number): Promise<Uint8Array> => {
      const handle = await openFile(manifestPath, 'r')
      try {
        const buffer = Buffer.allocUnsafe(maxBytes)
        const result = await handle.read(buffer, 0, maxBytes, offset)
        return buffer.subarray(0, result.bytesRead)
      } finally {
        await handle.close()
      }
    }
    }
    const result = await encryptDyfContainerToSink({
      manifest: manifestSource,
      publicKeyJwk: batch.publicKeyJwk,
      type: 'exchange',
      documentType: 'admin-exchange',
      schemaVersion: 2,
      batchId: batch.batchId,
      keyId: batch.keyId,
      assets: assetDescriptors,
      readAssetChunk: async (assetId, offset, maxBytes) => {
        const asset = assets.get(assetId)
        if (!asset) throw new Error(`导出资产不存在：${assetId}`)
        const handle = await openFile(resolveEvidencePath(asset.sourcePath), 'r')
        try {
          const buffer = Buffer.allocUnsafe(maxBytes)
          const result = await handle.read(buffer, 0, maxBytes, offset)
          const bytes = buffer.subarray(0, result.bytesRead)
          if (bytes.length < 1) throw new Error(`导出资产读取到空块：${asset.sourcePath}`)
          const hasher = assetHashers.get(assetId) ?? createHash('sha256')
          hasher.update(bytes)
          assetHashers.set(assetId, hasher)
          return bytes
        } finally {
          await handle.close()
        }
      },
      validateAsset: async (assetId) => {
        const asset = assets.get(assetId)
        const hasher = assetHashers.get(assetId)
        if (!asset || !hasher || hasher.digest('hex') !== asset.sha256) {
          throw new Error(`导出资产内容在读取期间发生变化：${assetId}`)
        }
      },
      write: sink.write,
      onProgress: (progress) => {
        if (sink.onProgress) {
          sink.onProgress({
            phase: 'write',
            completedFrames: progress.completed,
            totalFrames: progress.total,
            writtenBytes: progress.writtenBytes
          })
        }
      }
    })
    return {
      fileName: `${buildExportName(batch, '德育分数据')}.dyf`,
      frameCount: result.frameCount,
      writtenBytes: result.writtenBytes
    }
  finally {
    if (manifestStream && !manifestStream.destroyed) manifestStream.destroy()
    await rm(manifestPath, { force: true })
  }
}

/** Streams an exchange directly to a temporary file and atomically publishes it on success. */
export async function exportBatchExchangeToFile(
  batch: Batch,
  targetPath: string,
  onProgress?: (progress: ExchangeExportProgress) => void
): Promise<{ path: string; fileHash: string; frameCount: number; writtenBytes: number }> {
  const tempPath = `${targetPath}.part-${randomUUID()}`
  const output = createWriteStream(tempPath, { flags: 'wx' })
  let streamError: Error | null = null
  output.on('error', (error) => {
    streamError = error instanceof Error ? error : new Error(String(error))
  })
  const fileHash = createHash('sha256')
  try {
    const result = await streamBatchExchange(batch, {
      write: async (chunk) => {
        if (streamError) throw streamError
        const buffer = Buffer.from(chunk)
        fileHash.update(buffer)
        if (!output.write(buffer)) {
          await Promise.race([
            once(output, 'drain'),
            once(output, 'error').then(() => undefined)
          ])
          if (streamError) throw streamError
        }
      },
      onProgress
    })
    await new Promise<void>((resolve, reject) => {
      if (streamError) {
        reject(streamError)
        return
      }
      output.once('error', reject)
      output.end(() => resolve())
    })
    if (streamError) throw streamError
    await rm(targetPath, { force: true })
    await rename(tempPath, targetPath)
    writeAudit({
      batchId: batch.batchId,
      operator: 'local-admin',
      role: currentRole(),
      scope: JSON.stringify(currentScope()),
      action: 'exchange.export',
      target: batch.batchId,
      detail: { streamed: true, frameCount: result.frameCount, writtenBytes: result.writtenBytes }
    })
    onProgress?.({
      phase: 'finalize',
      completedFrames: result.frameCount ?? 0,
      totalFrames: result.frameCount ?? 0,
      writtenBytes: result.writtenBytes ?? 0
    })
    return {
      path: targetPath,
      fileHash: fileHash.digest('hex'),
      frameCount: result.frameCount ?? 0,
      writtenBytes: result.writtenBytes ?? 0
    }
  } catch (error) {
    output.destroy()
    await rm(tempPath, { force: true })
    throw error
  }
}

/** Records a successful management exchange write for every application in the current scope. */
export function recordBatchExchangeExport(batch: Batch): number {
  const role = currentRole()
  if (role === 'level1') return 0
  const db = getDb()
  const sc = studentScopeSql({ grade: 's.grade', class: 's.class_name' })
  const rows = db
    .prepare(
      `SELECT a.apply_id AS applyId FROM apply a JOIN student s ON s.id = a.student_id
       WHERE a.batch_id = ?${sc.clause}`
    )
    .all(batch.batchId, ...sc.params) as Array<{ applyId: string }>
  const occurredAt = Date.now()
  for (const row of rows) {
    writeTimelineEvent({
      batchId: batch.batchId,
      applyId: row.applyId,
      actorType: 'admin',
      role,
      scope: { ...currentScope() },
      action: 'admin.exported',
      occurredAt
    })
  }
  return rows.length
}

/**
 * 导入 .dyf 管理端交换文件（合并下级 / 同级上交的数据），逐学生返回结果。
 * 角色规则（issue #5）：二三级越权或已存在一律跳过（不覆盖、不冲突）；一级 overwrite=true 时覆盖已有。
 * v2：上级覆盖导入时，把随文件携带的证明材料与确认单落盘到本端证据目录。
 */
export async function importBatchExchange(
  batch: Batch,
  filePath: string,
  overwrite: boolean
): Promise<ImportFileResult[]> {
  const fileName = basename(filePath)
  if (filePath.toLowerCase().endsWith('.dxy')) {
    return [{ fileName, ok: false, decision: 'error', reason: '旧 .dxy 文件格式已停用，请导出新的 .dyf 文件' }]
  }
  let header: ReturnType<typeof readDyfContainerHeader>
  let frameOffset = 0
  let fileSize = 0
  try {
    const source = await readExchangeHeaderFromFile(filePath)
    header = source.header
    frameOffset = source.frameOffset
    fileSize = source.size
  } catch (error) {
    return [
      {
        fileName,
        ok: false,
        decision: 'error',
        reason: userFacingErrorMessage(
          error,
          '文件无法解析，请确认是完整的 .dyf 管理端数据交换文件',
          `dxy-read:${fileName}`
        )
      }
    ]
  }
  if (header.type !== 'exchange' || header.documentType !== 'admin-exchange') {
    return [
      { fileName, ok: false, decision: 'error', reason: '该文件不是 v2 管理端交换文件（.dyf）' }
    ]
  }
  if (!batch.privateKeyJwk) {
    return [
      {
        fileName,
        ok: false,
        decision: 'error',
        reason: '本批次缺少私钥，无法解密数据文件（请确认授权已下发批次私钥）'
      }
    ]
  }

  let payload: ExchangePayload
  const exchangeAssetDir = join(evidenceBaseDir(), '.staging', `exchange-${randomUUID()}`)
  mkdirSync(exchangeAssetDir, { recursive: true })
  const exchangeAssets = new Map<string, { path: string; descriptor: { assetId: string; sha256: string; mimeType: string; size: number } }>()
  const exchangeAssetHandles = new Map<number, Awaited<ReturnType<typeof openFile>>>()
  const exchangeAssetHashes = new Map<number, ReturnType<typeof createHash>>()
  const cleanupExchangeAssets = async (): Promise<void> => {
    for (const handle of exchangeAssetHandles.values()) {
      try {
        await handle.close()
      } catch {
        // Best effort cleanup after a failed source read.
      }
    }
    await rm(exchangeAssetDir, { recursive: true, force: true })
  }
  let sourceFileHash = ''
  let sourceHandle: Awaited<ReturnType<typeof openFile>> | null = null
  try {
    sourceHandle = await openFile(filePath, 'r')
    const r = await decryptDyfContainerFromSource({
      header,
      frameOffset,
      totalSize: fileSize,
      privateKeyJwk: batch.privateKeyJwk,
      read: async (offset, length) => {
        const handle = sourceHandle
        if (!handle) throw new Error('DYF 源文件句柄已关闭')
        const buffer = Buffer.allocUnsafe(length)
        let completed = 0
        while (completed < length) {
          const part = await handle.read(buffer, completed, length - completed, offset + completed)
          if (part.bytesRead < 1) throw new Error('DYF 文件读取不完整')
          completed += part.bytesRead
        }
        return buffer
      },
      writeAssetChunk: async (asset, assetIndex, offset, chunk) => {
        let target = exchangeAssets.get(asset.assetId)
        if (!target) {
          target = {
            path: join(exchangeAssetDir, `${assetIndex}-${asset.sha256}.part`),
            descriptor: { assetId: asset.assetId, sha256: asset.sha256, mimeType: asset.mimeType, size: asset.size }
          }
          exchangeAssets.set(asset.assetId, target)
        }
        let handle = exchangeAssetHandles.get(assetIndex)
        if (!handle) {
          handle = await openFile(target.path, 'w')
          exchangeAssetHandles.set(assetIndex, handle)
          exchangeAssetHashes.set(assetIndex, createHash('sha256'))
        }
        await handle.write(Buffer.from(chunk), 0, chunk.length, offset)
        exchangeAssetHashes.get(assetIndex)!.update(chunk)
      },
      validateAsset: async (asset, assetIndex) => {
        const handle = exchangeAssetHandles.get(assetIndex)
        if (handle) await handle.close()
        const hash = exchangeAssetHashes.get(assetIndex)
        if (!hash || hash.digest('hex') !== asset.sha256) throw new Error(`DYF 资产完整性校验失败：${asset.assetId}`)
      }
    })
    await sourceHandle.close()
    sourceHandle = null
    payload = r.payload as ExchangePayload
    sourceFileHash = await hashFilePath(filePath)
  } catch {
    if (sourceHandle) await sourceHandle.close()
    await cleanupExchangeAssets()
    return [
      {
        fileName,
        ok: false,
        decision: 'error',
        reason: '无法解密该数据文件，可能不是本单位或本批次的数据'
      }
    ]
  }
  const template = batch.configTemplateId ? getTemplate(batch.configTemplateId) : null
  if (!template) {
    await cleanupExchangeAssets()
    return [
      { fileName, ok: false, decision: 'error', reason: '批次配置模板缺失，无法校验数据文件' }
    ]
  }
  if (!validateExchangePayload(payload, batch, template)) {
    await cleanupExchangeAssets()
    return [
      {
        fileName,
        ok: false,
        decision: 'error',
        reason: '数据文件内容不完整或格式不受支持，未导入任何数据'
      }
    ]
  }
  if (payload.batchId !== batch.batchId) {
    await cleanupExchangeAssets()
    return [
      {
        fileName,
        ok: false,
        decision: 'error',
        reason: `数据文件批次与当前批次不符（当前为 ${batch.year} 学年第 ${batch.semester} 学期）`
      }
    ]
  }

  const role = currentRole()
  const db = getDb()
  const applyByStudent = new Map<string, ExchangeApply>()
  for (const a of payload.applies) applyByStudent.set(a.studentId, a)
  const evidenceStages: EvidenceStage[] = []

  /** 覆盖导入被替换的旧 apply 的证据目录（相对账号目录），事务提交成功后清理孤儿。 */
  const orphanEvidenceRelDirs: string[] = []

  const stageExchangeAssetRefs = (stage: EvidenceStage, itemCode: string, refs: string[]): string[] =>
    refs.map((ref, index) => {
      const asset = resolveExchangeAssetFile(payload, ref, exchangeAssets)
      return stageEvidenceAssetFile(
        stage,
        itemCode,
        index + 1,
        asset.path,
        asset.descriptor.assetId,
        asset.descriptor.mimeType,
        asset.descriptor.size
      )
    })

  /** 合并单个学生（覆盖或新增）；由外层整文件事务统一提交。 */
  const merge = (student: ExchangeStudent): void => {
    const existing = db
      .prepare('SELECT id FROM student WHERE batch_id = ? AND student_id = ?')
      .get(batch.batchId, student.studentId) as { id: number } | undefined
    const apply = applyByStudent.get(student.studentId)
    let studentDbId: number
    if (existing) {
      // 覆盖导入只在 incoming 明确携带申请时替换旧申请；纯学生名册/元数据更新不能误删既有申请。
            if (apply) {
        const oldApply = db
          .prepare('SELECT apply_id AS applyId FROM apply WHERE batch_id = ? AND student_id = ?')
          .get(batch.batchId, existing.id) as { applyId: string } | undefined
        if (oldApply) {
          // 删除前收集旧证据文件路径（evidence_files + confirm_slip），供事务提交后清理孤儿目录
          const oldScoreRows = db
            .prepare('SELECT evidence_files AS evidenceFiles FROM dyf_score WHERE apply_id = ?')
            .all(oldApply.applyId) as Array<{ evidenceFiles: string | null }>
          const oldApplyRow = db
            .prepare('SELECT confirm_slip AS confirmSlip FROM apply WHERE apply_id = ?')
            .get(oldApply.applyId) as { confirmSlip: string | null } | undefined
          const oldEvidenceFiles: string[] = []
          for (const row of oldScoreRows) {
            const files = JSON.parse(row.evidenceFiles ?? '[]') as string[]
            for (const f of files) oldEvidenceFiles.push(f)
          }
          if (oldApplyRow?.confirmSlip) oldEvidenceFiles.push(oldApplyRow.confirmSlip)
          orphanEvidenceRelDirs.push(...collectEvidenceDirs(oldEvidenceFiles))
          db.prepare('DELETE FROM timeline_event WHERE apply_id = ?').run(oldApply.applyId)
          db.prepare('DELETE FROM dyf_score WHERE apply_id = ?').run(oldApply.applyId)
          db.prepare('DELETE FROM apply_revision WHERE apply_id = ?').run(oldApply.applyId)
          db.prepare('DELETE FROM final_grade WHERE batch_id = ? AND student_id = ?').run(
            batch.batchId,
            existing.id
          )
          db.prepare('DELETE FROM apply WHERE apply_id = ?').run(oldApply.applyId)
        }
      }
      db.prepare(
        'UPDATE student SET name = ?, phone = ?, grade = ?, major = ?, class_name = ? WHERE id = ?'
      ).run(
        student.name,
        student.phone,
        student.grade,
        student.major,
        student.className,
        existing.id
      )
      studentDbId = existing.id
    } else {
      const r = db
        .prepare(
          `INSERT INTO student (batch_id, student_id, name, phone, grade, major, class_name, id_conflict_locked, name_corrected)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`
        )
        .run(
          batch.batchId,
          student.studentId,
          student.name,
          student.phone,
          student.grade,
          student.major,
          student.className
        )
      studentDbId = Number(r.lastInsertRowid)
    }

    if (apply) {
      const now = Date.now()
      const evidenceStage = createEvidenceStage(batch.batchId, student.studentId)
      evidenceStages.push(evidenceStage)
      // 确认单随文件落盘（v2）；无则置空（覆盖导入时清除旧确认单）。
      const slipPath = apply.confirmSlip
        ? stageConfirmSlip(evidenceStage, apply.confirmSlip)
        : apply.confirmSlipRef
          ? stageExchangeAssetRefs(evidenceStage, 'confirm-slip', [apply.confirmSlipRef])[0] ?? null
          : null
      db.prepare(
        `INSERT INTO apply (apply_id, batch_id, student_id, status, current_revision, imported_at, confirm_slip)
         VALUES (?, ?, ?, 'reviewing', ?, ?, ?)`
      ).run(apply.applyId, batch.batchId, studentDbId, apply.currentRevision, now, slipPath)
      db.prepare(
        `INSERT INTO apply_revision (apply_id, revision, file_hash, created_at) VALUES (?, ?, ?, ?)`
      ).run(apply.applyId, apply.currentRevision, sourceFileHash, now)
      const insScore = db.prepare(
        `INSERT INTO dyf_score (apply_id, item_code, category, applied_score, final_score, max_score, allow_add, evidence_files)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`
      )
      for (const s of apply.scores) {
        // 证明材料随文件落盘（v2）；无证据则空数组。
        const evidencePaths = s.evidence
          ? stageEvidenceFiles(evidenceStage, s.itemCode, s.evidence)
          : stageExchangeAssetRefs(evidenceStage, s.itemCode, s.evidenceRefs ?? [])
        // 下级已审定分（finalScore ?? appliedScore）作为上级复核的申请分基线，final 留空供上级审。
        insScore.run(
          apply.applyId,
          s.itemCode,
          s.category,
          s.finalScore ?? s.appliedScore,
          s.maxScore,
          s.allowAdd ? 1 : 0,
          JSON.stringify(evidencePaths)
        )
      }
      for (const event of apply.timeline ?? []) {
        if (!event.eventId || !Number.isFinite(event.occurredAt)) continue
        if (!['student.entered', 'student.exported', 'admin.imported', 'admin.modified', 'admin.exported', 'admin.confirmed'].includes(event.action)) continue
        insertTimelineEvent({
          eventId: event.eventId,
          batchId: batch.batchId,
          applyId: apply.applyId,
          actorType: event.actorType,
          role: event.role === 'level1' || event.role === 'level2' || event.role === 'level3' ? event.role : undefined,
          action: event.action as Parameters<typeof insertTimelineEvent>[0]['action'],
          occurredAt: event.occurredAt,
          revision: event.revision,
          sourceFileHash: event.sourceFileHash,
          detail: event.detail
        })
      }
      writeTimelineEvent({
        batchId: batch.batchId,
        applyId: apply.applyId,
        actorType: 'admin',
        role,
        scope: { ...currentScope() },
        action: 'admin.imported',
        occurredAt: now,
        revision: apply.currentRevision,
        sourceFileHash,
        detail: { source: 'admin-exchange', fromRole: payload.fromRole }
      })
      commitEvidenceStage(evidenceStage)
    }
  }

  const results: ImportFileResult[] = []
  const acceptedStudents: ExchangeStudent[] = []
  for (const student of payload.students) {
    const scopeReject = outOfScopeReason(student)
    if (scopeReject) {
      results.push({
        fileName,
        ok: false,
        decision: 'reject',
        reason: scopeReject,
        studentId: student.studentId,
        name: student.name
      })
      continue
    }
    const has = db
      .prepare(
        'SELECT 1 AS x FROM apply a JOIN student s ON s.id = a.student_id WHERE a.batch_id = ? AND s.student_id = ?'
      )
      .get(batch.batchId, student.studentId) as { x: number } | undefined
    if (has && role !== 'level1') {
      results.push({
        fileName,
        ok: false,
        decision: 'reject',
        reason: '该学号已存在，本账号（二/三级）不覆盖已有数据',
        studentId: student.studentId,
        name: student.name
      })
      continue
    }
    if (has && role === 'level1' && !overwrite) {
      results.push({
        fileName,
        ok: false,
        decision: 'reject',
        reason: '该学号已存在（未确认覆盖，已跳过）',
        studentId: student.studentId,
        name: student.name
      })
      continue
    }
    acceptedStudents.push(student)
  }

  try {
    db.transaction(() => {
      for (const student of acceptedStudents) merge(student)
    })()
    // 覆盖导入成功：清理被替换旧 apply 遗留的证据目录（孤儿文件，仅磁盘占用）
    removeEvidenceDirs(orphanEvidenceRelDirs)
    for (const student of acceptedStudents) {
      results.push({
        fileName,
        ok: true,
        decision: 'accept',
        studentId: student.studentId,
        name: student.name
      })
    }
  } catch {
    for (const stage of evidenceStages) discardEvidenceStage(stage)
    for (const student of acceptedStudents) {
      results.push({
        fileName,
        ok: false,
        decision: 'error',
        reason: '数据合并失败，已回滚本文件的全部变更',
        studentId: student.studentId,
        name: student.name
      })
    }
  }

  await cleanupExchangeAssets()

  const accepted = results.filter((r) => r.ok).length
  if (accepted > 0) touchScoresChanged(batch.batchId)
  writeAudit({
    batchId: batch.batchId,
    operator: 'local-admin',
    role,
    scope: JSON.stringify(currentScope()),
    action: 'exchange.import',
    target: batch.batchId,
    detail: {
      fileName,
      fromRole: payload.fromRole,
      accepted,
      total: payload.students.length,
      overwrite
    }
  })
  return results
}
