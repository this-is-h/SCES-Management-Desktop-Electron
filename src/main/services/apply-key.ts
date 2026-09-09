/**
 * 单位申请密钥（apply_key 表，schema v7）访问层（决策 #41/#45）。
 *
 * 申请密钥（RSA-OAEP）由一级管理端激活时本地生成、跨批次复用，支持跨学年轮换：
 * `is_current=1` 的一把用于新批次加密对接；历史密钥保留用于解密旧 `.dyf`。
 * 两模式共用——在线模式的申请密钥同样本地生成、进本表（决策 #41 修订，见 13 §1）。
 */
import type { Batch, Jwk } from '@sces/shared'
import { getDb } from '../db'
import type { ApplyKeyMaterial } from '../gateway/types'

interface ApplyKeyRow {
  keyId: string
  publicKeyJwk: string
  privateKeyJwk: string
  isCurrent: number
  createdAt: number
}

/** 插入一把申请密钥。current=true 时先清零其它行的 is_current（保证唯一 current）。 */
export function insertApplyKey(input: {
  keyId: string
  unitId: string
  publicKeyJwk: Jwk
  privateKeyJwk: Jwk
  current: boolean
}): void {
  const db = getDb()
  const now = Date.now()
  const tx = db.transaction(() => {
    if (input.current) db.prepare('UPDATE apply_key SET is_current = 0').run()
    db.prepare(
      `INSERT OR REPLACE INTO apply_key (key_id, unit_id, public_key_jwk, private_key_jwk, is_current, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      input.keyId,
      input.unitId,
      JSON.stringify(input.publicKeyJwk),
      JSON.stringify(input.privateKeyJwk),
      input.current ? 1 : 0,
      now
    )
  })
  tx()
}

/** 当前申请密钥（is_current=1；无 current 时取最近创建）。无任何密钥返回 null。 */
export function getCurrentApplyKeyOrNull(): ApplyKeyMaterial | null {
  const row = getDb()
    .prepare(
      `SELECT key_id AS keyId, public_key_jwk AS publicKeyJwk, private_key_jwk AS privateKeyJwk,
              is_current AS isCurrent, created_at AS createdAt
       FROM apply_key ORDER BY is_current DESC, created_at DESC LIMIT 1`
    )
    .get() as ApplyKeyRow | undefined
  if (!row) return null
  return {
    keyId: row.keyId,
    publicKeyJwk: JSON.parse(row.publicKeyJwk) as Jwk,
    privateKeyJwk: JSON.parse(row.privateKeyJwk) as Jwk
  }
}

/** 当前申请密钥；缺失即抛（批次创建 / 公钥包导出前置）。 */
export function getCurrentApplyKey(): ApplyKeyMaterial {
  const key = getCurrentApplyKeyOrNull()
  if (!key) throw new Error('未找到单位申请密钥，请重新激活或联系服务商')
  return key
}

/**
 * 解密候选私钥顺序（import.ts 多密钥回退，dual-mode/06 §4）：
 * `file.keyId` 精确命中 → `batch.keyId` → apply_key 全表(is_current DESC, created_at DESC)
 * → `batch.privateKeyJwk` 兜底（兼容 v6 及更早存量批次）。去重后返回。
 */
export function resolveDecryptKeys(batch: Batch, fileKeyId?: string): Jwk[] {
  const rows = getDb()
    .prepare(
      `SELECT key_id AS keyId, public_key_jwk AS publicKeyJwk, private_key_jwk AS privateKeyJwk,
              is_current AS isCurrent, created_at AS createdAt
       FROM apply_key ORDER BY is_current DESC, created_at DESC`
    )
    .all() as ApplyKeyRow[]

  const out: Jwk[] = []
  const seen = new Set<string>()
  const push = (jwk: Jwk | undefined): void => {
    if (!jwk) return
    const k = JSON.stringify(jwk)
    if (seen.has(k)) return
    seen.add(k)
    out.push(jwk)
  }

  if (fileKeyId) {
    const hit = rows.find((r) => r.keyId === fileKeyId)
    if (hit) push(JSON.parse(hit.privateKeyJwk) as Jwk)
  }
  if (batch.keyId) {
    const hit = rows.find((r) => r.keyId === batch.keyId)
    if (hit) push(JSON.parse(hit.privateKeyJwk) as Jwk)
  }
  for (const r of rows) push(JSON.parse(r.privateKeyJwk) as Jwk)
  push(batch.privateKeyJwk)
  return out
}
