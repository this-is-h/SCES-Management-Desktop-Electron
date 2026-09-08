/**
 * 证明材料存储服务（架构 §9.3）：证明材料存管理端本地文件系统，
 * 目录 `data/accounts/<unitId>/evidence/<batchId>/<studentId>/`。
 * dyf_score.evidence_files 存**相对账号目录的路径**（如 evidence/<batch>/<student>/evidence-1.jpg），
 * 读取时按当前账号目录解析——数据目录迁移（settings.dataDir）后路径依然有效。
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, statSync } from 'fs'
import { stat as statAsync, readFile as readFileAsync } from 'fs/promises'
import { dirname, join, sep } from 'path'
import { randomUUID } from 'crypto'
import { createHash } from 'crypto'
import { accountDir, getActiveAccount } from './accounts'
import { getDb } from '../db'

/** 当前账号的证据根目录（绝对路径）。 */
export function evidenceBaseDir(): string {
  const acc = getActiveAccount()
  if (!acc) throw new Error('无激活账号')
  return join(accountDir(acc.accountId), 'evidence')
}

/** 某学生（批次内学号）的证据目录（绝对路径）。 */
export function studentEvidenceDir(batchId: string, studentId: string): string {
  return join(evidenceBaseDir(), batchId, studentId)
}

/** A single import writes files below a private staging directory before exposing them to SQLite. */
export interface EvidenceStage {
  stageDir: string
  targetDir: string
  relativeDir: string
  committed: boolean
  stagedObjects: Array<{ temporary: string; target: string; relativePath: string }>
}

/**
 * Creates an isolated evidence destination for one imported application.
 * A unique destination prevents an interrupted overwrite from damaging evidence referenced by old rows.
 */
export function createEvidenceStage(batchId: string, studentId: string): EvidenceStage {
  const id = randomUUID()
  const relativeDir = join('evidence', batchId, studentId, `import-${id}`).split(sep).join('/')
  const stageDir = join(evidenceBaseDir(), '.staging', id)
  mkdirSync(stageDir, { recursive: true })
  return {
    stageDir,
    targetDir: join(evidenceBaseDir(), batchId, studentId, `import-${id}`),
    relativeDir,
    committed: false,
    stagedObjects: []
  }
}

/** 根据 base64 前缀猜测图片扩展名（证据以图片为主，缺省 .bin）。 */
function sniffExtension(base64: string): string {
  if (base64.startsWith('/9j/')) return 'jpg'
  if (base64.startsWith('iVBORw0KGg')) return 'png'
  if (base64.startsWith('R0lGOD')) return 'gif'
  if (base64.startsWith('UklGR')) return 'webp'
  return 'bin'
}

/** base64 → 文件（返回相对账号目录的路径）。文件名带明细项 code，避免不同明细的证据互相覆盖。 */
export function stageEvidenceFile(
  stage: EvidenceStage,
  itemCode: string,
  index: number,
  base64: string
): string {
  if (stage.committed) throw new Error('Evidence staging area has already been committed')
  void itemCode
  void index
  return stageEvidenceAsset(stage, base64)
}

/** 批量保存某明细项的证据（返回相对路径列表）。 */
export function stageEvidenceFiles(
  stage: EvidenceStage,
  itemCode: string,
  evidence: string[]
): string[] {
  return (Array.isArray(evidence) ? evidence : []).map((base64, i) =>
    stageEvidenceFile(stage, itemCode, i + 1, base64)
  )
}

/** 确认单截图 base64 → 文件（返回相对账号目录路径）。固定文件名，重新导入覆盖。 */
export function stageConfirmSlip(stage: EvidenceStage, base64: string): string {
  if (stage.committed) throw new Error('Evidence staging area has already been committed')
  return stageEvidenceAsset(stage, base64)
}

/** Adds an already decrypted content-addressed asset file to an evidence stage. */
export function stageEvidenceAssetFile(
  stage: EvidenceStage,
  itemCode: string,
  index: number,
  sourcePath: string,
  assetId: string,
  mimeType: string,
  size: number
): string {
  if (stage.committed) throw new Error('Evidence staging area has already been committed')
  void itemCode
  void index
  const match = /^sha256:([0-9a-f]{64})$/.exec(String(assetId))
  if (!match) throw new Error('资产标识无效')
  const sha256 = match[1]!
  const ext = extensionForMime(mimeType)
  const relativePath = `evidence/objects/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}.${ext}`
  const existing = getAssetByHash(sha256)
  const finalRelativePath = existing?.relativePath ?? relativePath
  const target = resolveEvidencePath(finalRelativePath)
  if (existsSync(target)) {
    if (existsSync(sourcePath)) rmSync(sourcePath, { force: true })
    return finalRelativePath
  }
  const staged = stage.stagedObjects.find((object) => object.relativePath === finalRelativePath)
  if (staged) {
    if (staged.temporary !== sourcePath && existsSync(sourcePath)) rmSync(sourcePath, { force: true })
    return finalRelativePath
  }
  const actualSize = statSync(sourcePath).size
  if (actualSize !== size) throw new Error(`资产大小校验失败：${assetId}`)
  stage.stagedObjects.push({ temporary: sourcePath, target, relativePath: finalRelativePath })
  if (!existing) registerAsset(sha256, finalRelativePath, ext, size)
  return finalRelativePath
}

/** Stores one content-addressed object in the stage and returns its stable account-relative path. */
function stageEvidenceAsset(stage: EvidenceStage, base64: string): string {
  const bytes = Buffer.from(String(base64 ?? ''), 'base64')
  if (!bytes.length) throw new Error('证明材料为空或不是有效的 base64 数据')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const ext = sniffExtension(String(base64 ?? ''))
  const relativePath = `evidence/objects/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}.${ext}`
  const existing = getAssetByHash(sha256)
  if (existing) {
    const existingTarget = resolveEvidencePath(existing.relativePath)
    if (existsSync(existingTarget)) return existing.relativePath
  }
  const target = resolveEvidencePath(existing?.relativePath ?? relativePath)
  if (stage.stagedObjects.some((object) => object.relativePath === (existing?.relativePath ?? relativePath))) {
    return existing?.relativePath ?? relativePath
  }
  if (!existsSync(target)) {
    const temporary = join(stage.stageDir, `${sha256}.${ext}.part`)
    writeFileSync(temporary, bytes)
    const finalRelativePath = existing?.relativePath ?? relativePath
    stage.stagedObjects.push({ temporary, target, relativePath: finalRelativePath })
    if (!existing) registerAsset(sha256, finalRelativePath, ext, bytes.length)
  }
  return existing?.relativePath ?? relativePath
}

function registerAsset(sha256: string, relativePath: string, ext: string, size: number): void {
  try {
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO evidence_asset
         (asset_id, relative_path, sha256, mime_type, size_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(`sha256:${sha256}`, relativePath, sha256, mimeForExtension(ext), size, Date.now())
  } catch {
    // Keep file import usable for an interrupted pre-v17 database; migration will surface the error on open.
  }
}

function getAssetByHash(sha256: string): { assetId: string; relativePath: string } | undefined {
  try {
    return getDb().prepare('SELECT asset_id AS assetId, relative_path AS relativePath FROM evidence_asset WHERE sha256 = ?').get(sha256) as
      | { assetId: string; relativePath: string }
      | undefined
  } catch {
    return undefined
  }
}

function mimeForExtension(ext: string): string {
  if (ext === 'jpg') return 'image/jpeg'
  if (ext === 'png') return 'image/png'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  return 'application/octet-stream'
}

function extensionForMime(mimeType: string): string {
  const mime = String(mimeType ?? '').toLowerCase()
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg'
  if (mime === 'image/png') return 'png'
  if (mime === 'image/gif') return 'gif'
  if (mime === 'image/webp') return 'webp'
  return 'bin'
}

/** Atomically exposes a fully written stage. Call before its database transaction begins. */
export function commitEvidenceStage(stage: EvidenceStage): void {
  if (stage.committed) return
  for (const object of stage.stagedObjects) {
    mkdirSync(dirname(object.target), { recursive: true })
    if (existsSync(object.target)) {
      rmSync(object.temporary, { force: true })
    } else {
      renameSync(object.temporary, object.target)
    }
  }
  rmSync(stage.stageDir, { recursive: true, force: true })
  stage.committed = true
}

/** Removes a failed import's staged or already exposed evidence directory. */
export function discardEvidenceStage(stage: EvidenceStage): void {
  if (existsSync(stage.stageDir)) rmSync(stage.stageDir, { recursive: true, force: true })
  if (stage.committed && stage.stagedObjects.length) {
    for (const object of stage.stagedObjects) {
      try {
        if (existsSync(object.target)) rmSync(object.target, { force: true })
      } catch {
        // Best effort cleanup; shared objects are never removed by directory cleanup.
      }
    }
  }
}

/** Compatibility helpers for callers that need a one-shot write outside an import transaction. */
export function saveEvidenceFile(
  batchId: string,
  studentId: string,
  itemCode: string,
  index: number,
  base64: string
): string {
  const stage = createEvidenceStage(batchId, studentId)
  try {
    const path = stageEvidenceFile(stage, itemCode, index, base64)
    commitEvidenceStage(stage)
    return path
  } catch (error) {
    discardEvidenceStage(stage)
    throw error
  }
}

export function saveEvidenceFiles(
  batchId: string,
  studentId: string,
  itemCode: string,
  evidence: string[]
): string[] {
  const stage = createEvidenceStage(batchId, studentId)
  try {
    const paths = stageEvidenceFiles(stage, itemCode, evidence)
    commitEvidenceStage(stage)
    return paths
  } catch (error) {
    discardEvidenceStage(stage)
    throw error
  }
}

export function saveConfirmSlip(batchId: string, studentId: string, base64: string): string {
  const stage = createEvidenceStage(batchId, studentId)
  try {
    const path = stageConfirmSlip(stage, base64)
    commitEvidenceStage(stage)
    return path
  } catch (error) {
    discardEvidenceStage(stage)
    throw error
  }
}

/** 相对证据路径 → 当前账号下的绝对路径（防路径穿越：仅允许 evidence/ 子路径）。 */
export function resolveEvidencePath(relPath: string): string {
  const acc = getActiveAccount()
  if (!acc) throw new Error('无激活账号')
  const normalized = String(relPath ?? '').replace(/\\/g, '/')
  if (
    !normalized.startsWith('evidence/') ||
    normalized.includes('..') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    throw new Error('非法证据路径')
  }
  return join(accountDir(acc.accountId), normalized)
}

/**
 * 读证据文件为原始 base64（.dxy 交换嵌入用，与 .dyf payload 的证据格式一致）。
 * 文件不存在或非文件返回 null。
 */
export function readEvidenceFileBase64(relPath: string): string | null {
  const filePath = resolveEvidencePath(relPath)
  if (!existsSync(filePath)) return null
  const stat = statSync(filePath)
  if (!stat.isFile()) return null
  return readFileSync(filePath).toString('base64')
}

/**
 * 异步读证据文件为原始 base64（.dxy 整包导出用，避免大批量证据同步读阻塞主进程）。
 * 文件不存在或非文件返回 null。
 */
export async function readEvidenceFileBase64Async(relPath: string): Promise<string | null> {
  const filePath = resolveEvidencePath(relPath)
  try {
    const st = await statAsync(filePath)
    if (!st.isFile()) return null
    return (await readFileAsync(filePath)).toString('base64')
  } catch {
    return null
  }
 }

/** 读证据文件为 data URL（审核详情展示用）。文件不存在返回 null。 */
export function readEvidenceAsDataUrl(relPath: string): string | null {
  const base64 = readEvidenceFileBase64(relPath)
  if (!base64) return null
  const ext = resolveEvidencePath(relPath).split('.').pop() ?? 'bin'
  const mime =
    ext === 'jpg' || ext === 'jpeg'
      ? 'image/jpeg'
      : ext === 'png'
        ? 'image/png'
        : ext === 'gif'
          ? 'image/gif'
          : ext === 'webp'
            ? 'image/webp'
            : 'application/octet-stream'
  return `data:${mime};base64,${base64}`
}

/** Reads an evidence object without the 4/3 base64 expansion used by legacy callers. */
export async function readEvidenceFileBytesAsync(relPath: string): Promise<Buffer | null> {
  const filePath = resolveEvidencePath(relPath)
  try {
    const st = await statAsync(filePath)
    if (!st.isFile()) return null
    return await readFileAsync(filePath)
  } catch {
    return null
  }
}

/**
 * 从证据文件相对路径收集其所属证据目录（去重、仅接受 evidence/ 前缀）。
 * 用于覆盖导入/冲突处理后清理旧证据孤儿目录。
 */
export function collectEvidenceDirs(relPaths: string[]): string[] {
  const dirs: string[] = []
  const seen = new Set<string>()
  for (const rel of relPaths) {
    if (typeof rel !== 'string' || rel.length === 0) continue
    const normalized = rel.replace(/\\/g, '/')
    if (normalized.startsWith('evidence/objects/')) continue
    const dir = dirname(normalized).split(sep).join('/')
    if (dir === '.' || !dir.startsWith('evidence/') || seen.has(dir)) continue
    seen.add(dir)
    dirs.push(dir)
  }
  return dirs
}

/**
 * 删除一批证据目录（孤儿清理）。经 resolveEvidencePath 防路径穿越，仅允许 evidence/ 子路径；
 * 失败静默（孤儿只是磁盘占用，不影响数据一致性），不抛出。
 */
export function removeEvidenceDirs(relDirs: string[]): void {
  for (const dir of relDirs) {
    try {
      if (dir.replace(/\\/g, '/').startsWith('evidence/objects/')) continue
      const abs = resolveEvidencePath(dir)
      if (existsSync(abs) && statSync(abs).isDirectory()) {
        rmSync(abs, { recursive: true, force: true })
      }
    } catch {
      // 忽略：清理失败不影响数据一致性
    }
  }
}
