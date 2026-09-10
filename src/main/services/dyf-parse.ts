/**
 * 德育分文件解析服务（设置 → 文件解析，仅展示不改库）。
 *
 * 学生端导出文件（.dyf student-application）：读容器头 → 按 header.keyId → 批次 keyId →
 * apply_key 全表逐把密钥回退解密（与 import.ts 同一密钥链，`当前密钥`即本机账号的申请私钥）→
 * 把基础信息/时间信息/德育分明细（含证明材料 data URL）与解密后的原始 payload 一并返回。
 * 密钥不匹配（文件非本机单位/批次签发）时返回明确的「无法解析」原因。
 *
 * 与导入的区别：本服务只读不落库，也不要求批次存在/进行中——纯文件解析。
 */
import { open, rm } from 'fs/promises'
import { readFileSync, mkdirSync } from 'fs'
import { basename, join } from 'path'
import { createHash, randomUUID } from 'crypto'
import type { Hash } from 'crypto'
import type {
  Batch,
  ImportPayload,
  Jwk,
  UnitConfig,
  DyfContainerHeader,
  DyfAssetDescriptor
} from '@sces/shared'
import { decryptDyfContainerFromSource } from '@sces/shared'
import { getDb } from '../db'
import { getBatch } from './batch'
import { getTemplate } from './config-template'
import { assertReadableFile, MAX_APPLICATION_FILE_BYTES } from './file-guard'
import { readContainerHeaderFromFile } from './import'
import { evidenceBaseDir } from './evidence'
import type { DyfParseStudentResult, DyfParseScoreItem } from '../../preload/types'

/** 单个证明材料转 data URL 的最大字节数（超出则给出占位说明，避免 IPC 载荷过大）。 */
const MAX_EVIDENCE_DATA_URL_BYTES = 20 * 1024 * 1024

/** 证明材料超限占位（保持条目可见但不再传原始字节）。 */
function evidenceOversizePlaceholder(): string {
  return 'data:application/octet-stream;base64,'
}

interface TemplateItemMeta {
  categoryCode: string
  categoryName: string
  description?: string
  allowAdd: boolean
  studentApplicable: boolean
  negative: boolean
  maxScore?: number
}

/** 从单位配置解析项目元信息（类别名/描述/可加分/上限等）。模板未定义返回 null。 */
function describeTemplateItem(template: UnitConfig, itemCode: string): TemplateItemMeta | null {
  const categories = template.dyf?.categories
  if (!Array.isArray(categories)) return null
  for (const category of categories) {
    for (const group of category.groups ?? []) {
      for (const item of group.items ?? []) {
        if (item.code !== itemCode) continue
        let maxScore: number | undefined
        const st = item.scoreType
        if (st && typeof st === 'object') {
          if (st.type === 'radio' && Array.isArray(st.options)) {
            const values = st.options.map((o) => Number(o?.value)).filter((v) => Number.isFinite(v))
            maxScore = values.length ? Math.max(...values) : undefined
          } else if ('max' in st) {
            const max = Number(st.max)
            maxScore = Number.isFinite(max) ? max : undefined
          }
        }
        return {
          categoryCode: category.code,
          categoryName: category.name,
          description: item.description,
          allowAdd: item.allowAdd === true,
          studentApplicable: item.studentApplicable !== false,
          negative: item.negative === true,
          maxScore
        }
      }
    }
  }
  return null
}

/** 解析候选私钥：本机账号 apply_key 全表（批次存在时含批次私钥兜底）。 */
function resolveParseKeys(fileKeyId: string | undefined, batch: Batch | null): Jwk[] {
  const rows = getDb()
    .prepare(
      `SELECT key_id AS keyId, private_key_jwk AS privateKeyJwk
       FROM apply_key ORDER BY is_current DESC, created_at DESC`
    )
    .all() as Array<{ keyId: string; privateKeyJwk: string }>

  const out: Jwk[] = []
  const seen = new Set<string>()
  const push = (jwk: Jwk | undefined | null): void => {
    if (!jwk) return
    const key = JSON.stringify(jwk)
    if (seen.has(key)) return
    seen.add(key)
    out.push(jwk)
  }
  if (fileKeyId) {
    const hit = rows.find((r) => r.keyId === fileKeyId)
    if (hit) push(JSON.parse(hit.privateKeyJwk) as Jwk)
  }
  for (const r of rows) push(JSON.parse(r.privateKeyJwk) as Jwk)
  push(batch?.privateKeyJwk)
  return out
}

/** 根据 base64 前缀猜测图片类型（证据以图片为主，缺省 octet-stream）。 */
function sniffMime(base64: string): string {
  const head = base64.slice(0, 12)
  if (head.startsWith('/9j/')) return 'image/jpeg'
  if (head.startsWith('iVBORw0KGgo')) return 'image/png'
  if (head.startsWith('R0lGOD')) return 'image/gif'
  return 'application/octet-stream'
}

/** base64 → data URL。 */
function base64ToDataUrl(base64: string, mimeType?: string): string {
  const mime =
    mimeType && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mimeType) ? mimeType : sniffMime(base64)
  return `data:${mime};base64,${base64}`
}

interface StagedAsset {
  path: string
  descriptor: DyfAssetDescriptor
}

/** 一位学生的完整解析结果（学生端导出文件）。解析失败返回 ok=false + error。 */
export async function parseStudentDyfFile(filePath: string): Promise<DyfParseStudentResult> {
  const fileName = basename(filePath)
  try {
    assertReadableFile(filePath, ['.dyf'], MAX_APPLICATION_FILE_BYTES)
  } catch (err) {
    return { fileName, ok: false, error: err instanceof Error ? err.message : '文件不可读' }
  }

  // 1. 读容器头（只读头部与偏移，不加载密文帧）
  let header: DyfContainerHeader
  let frameOffset = 0
  let fileSize = 0
  try {
    const source = await readContainerHeaderFromFile(filePath)
    header = source.header
    frameOffset = source.frameOffset
    fileSize = source.size
  } catch (err) {
    return {
      fileName,
      ok: false,
      error: `文件无法解析，请确认是完整的 .dyf 文件（${err instanceof Error ? err.message : ''}）`
    }
  }

  if (header.documentType !== 'student-application' || header.type !== 'apply') {
    return {
      fileName,
      ok: false,
      error: '仅支持德育分 v2 学生申请文件（.dyf）'
    }
  }

  // 2. 密钥回退解密（`当前密钥` = 本机账号申请私钥链；全部失败 = 密钥不正确）
  const batch = header.batchId ? getBatch(header.batchId) : null
  const candidates = resolveParseKeys(header.keyId, batch)

  const assetTempDir = join(evidenceBaseDir(), '.staging', `parse-${randomUUID()}`)
  mkdirSync(assetTempDir, { recursive: true })
  const assetFiles = new Map<string, StagedAsset>()
  const assetHandles = new Map<number, Awaited<ReturnType<typeof open>>>()
  const assetHashes = new Map<number, Hash>()
  const cleanup = async (): Promise<void> => {
    for (const handle of assetHandles.values()) {
      try {
        await handle.close()
      } catch {
        // best effort
      }
    }
    await rm(assetTempDir, { recursive: true, force: true })
  }
  const resetForRetry = async (): Promise<void> => {
    await cleanup()
    mkdirSync(assetTempDir, { recursive: true })
    assetFiles.clear()
    assetHandles.clear()
    assetHashes.clear()
  }

  let payload: unknown = null
  let payloadHash = ''
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
            const part = await sourceHandle!.read(
              buffer,
              completed,
              length - completed,
              offset + completed
            )
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
              descriptor: asset
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
          if (!digest || digest.digest('hex') !== asset.sha256) {
            throw new Error(`DYF 资产完整性校验失败：${asset.assetId}`)
          }
        }
      })
      await sourceHandle.close()
      sourceHandle = null
      payload = result.payload
      payloadHash = result.hash
      decrypted = true
      break
    } catch {
      if (sourceHandle) await sourceHandle.close()
      await resetForRetry()
    }
  }
  if (!decrypted) {
    await cleanup()
    return {
      fileName,
      ok: false,
      error: '无法解析：文件使用的密钥与本机不匹配（可能不是本单位或本批次的文件），或文件已损坏'
    }
  }

  // 3. 展示数据组装（宽松：未在模板定义的项目保留为「未知」展示，不拒绝解析）
  const p = payload as ImportPayload
  const template = batch?.configTemplateId ? getTemplate(batch.configTemplateId) : null

  const dyfRaw = p.dyf
  const dyfEntries =
    dyfRaw && typeof dyfRaw === 'object' && !Array.isArray(dyfRaw)
      ? (dyfRaw as Record<string, { score?: unknown; evidence?: unknown; evidenceRefs?: unknown }>)
      : {}

  const scores: DyfParseScoreItem[] = []
  let totalScore = 0
  for (const [itemCode, entry] of Object.entries(dyfEntries)) {
    if (!entry || typeof entry !== 'object') continue
    const appliedScore = Number(entry.score ?? 0)
    if (!Number.isFinite(appliedScore)) continue
    const meta = template ? describeTemplateItem(template, itemCode) : null
    const refs = Array.isArray(entry.evidenceRefs)
      ? entry.evidenceRefs.map((v) => String(v)).filter(Boolean)
      : []
    const legacy = Array.isArray(entry.evidence)
      ? entry.evidence.map((v) => String(v)).filter(Boolean)
      : []

    const evidence: string[] = []
    for (const ref of refs) {
      const asset = assetFiles.get(ref)
      if (!asset) continue
      const bytes = readFileSync(asset.path)
      evidence.push(
        bytes.length > MAX_EVIDENCE_DATA_URL_BYTES
          ? evidenceOversizePlaceholder()
          : base64ToDataUrl(bytes.toString('base64'), asset.descriptor.mimeType)
      )
    }
    for (const base64 of legacy) {
      const bytes = Buffer.from(base64, 'base64')
      evidence.push(
        bytes.length > MAX_EVIDENCE_DATA_URL_BYTES
          ? evidenceOversizePlaceholder()
          : base64ToDataUrl(base64)
      )
    }

    totalScore += appliedScore
    scores.push({
      itemCode,
      categoryCode: meta?.categoryCode ?? '未知',
      categoryName: meta?.categoryName ?? '未知',
      description: meta?.description ?? (meta ? itemCode : '（模板未定义项目）'),
      appliedScore,
      maxScore: meta?.maxScore,
      allowAdd: meta?.allowAdd ?? false,
      studentApplicable: meta?.studentApplicable ?? true,
      negative: meta?.negative ?? false,
      templateItem: Boolean(meta),
      evidence
    })
  }

  // 4. 基础信息：personal 已知字段按序 + 其余透出
  const personal = (p.personal ?? {}) as Record<string, unknown>
  const knownOrder = [
    'name',
    'studentId',
    'grade',
    'major',
    'className',
    'phone',
    'year',
    'semester'
  ]
  const labelMap: Record<string, string> = {
    name: '姓名',
    studentId: '学号',
    phone: '手机号',
    grade: '年级',
    major: '专业',
    className: '班级',
    year: '学年',
    semester: '学期'
  }
  const personalList: Array<{ key: string; label: string; value: string }> = []
  for (const key of knownOrder) {
    const v = personal[key]
    if (v === undefined || v === null || v === '') continue
    personalList.push({ key, label: labelMap[key] ?? key, value: String(v) })
  }
  for (const [key, value] of Object.entries(personal)) {
    if (knownOrder.includes(key) || value === undefined || value === null || value === '') continue
    personalList.push({ key, label: labelMap[key] ?? key, value: String(value) })
  }

  // 5. 时间信息：导出历史 + 首次进入时间
  const exportsList: Array<{ revision: number; exportedAt: number; fileHash?: string }> = []
  const lifecycleExports = p.lifecycle?.exports
  if (Array.isArray(lifecycleExports)) {
    for (const e of lifecycleExports) {
      if (!e || typeof e.revision !== 'number') continue
      exportsList.push({
        revision: e.revision,
        exportedAt: Number(e.exportedAt) || 0,
        fileHash: e.fileHash
      })
    }
  }
  if (
    typeof p.exportedAt === 'number' &&
    !exportsList.some((e) => e.revision === p.revision && e.exportedAt === p.exportedAt)
  ) {
    exportsList.push({ revision: p.revision ?? 0, exportedAt: p.exportedAt })
  }
  exportsList.sort((a, b) => a.exportedAt - b.exportedAt)

  // 6. 确认单 → data URL
  let confirmSlip: string | undefined
  if (p.confirmSlipRef) {
    const asset = assetFiles.get(p.confirmSlipRef)
    if (asset) {
      const bytes = readFileSync(asset.path)
      confirmSlip = base64ToDataUrl(
        bytes.toString('base64'),
        asset.descriptor.mimeType || 'image/png'
      )
    }
  } else if (p.confirmSlip) {
    confirmSlip = base64ToDataUrl(p.confirmSlip, 'image/png')
  }

  const result: DyfParseStudentResult = {
    fileName,
    ok: true,
    header: {
      schemaVersion: header.formatVersion,
      type: header.type,
      documentType: header.documentType,
      batchId: header.batchId,
      keyId: header.keyId,
      applyId: header.applyId,
      revision: header.revision,
      algorithm: header.algorithm,
      createdAt: header.createdAt,
      frameCount: header.frameCount,
      contentHash: header.contentHash,
      assets: (header.assets ?? []).map((a) => ({
        assetId: a.assetId,
        mimeType: a.mimeType,
        size: a.size,
        sha256: a.sha256
      }))
    },
    summary: {
      applyId: p.applyId ?? '',
      revision: p.revision ?? 0,
      batchId: p.batchId ?? '',
      personal: personalList,
      exportedAt: typeof p.exportedAt === 'number' ? p.exportedAt : undefined,
      enteredAt: p.lifecycle?.enteredAt,
      exports: exportsList,
      totalScore
    },
    scores,
    confirmSlip,
    timeline: Array.isArray(p.timeline)
      ? p.timeline.map((e) => ({
          eventId: e?.eventId ?? '',
          action: e?.action ?? '',
          occurredAt: Number(e?.occurredAt) || 0,
          revision: e?.revision,
          sourceFileHash: e?.sourceFileHash
        }))
      : [],
    raw: payload,
    payloadHash
  }
  await cleanup()
  return result
}
