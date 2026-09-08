/**
 * 审计日志服务：所有写操作必须落审计（架构文档 §3.7 / §6.2）。
 */
import type { AuditLog, AuditRole } from '@sces/shared'
import { getDb } from '../db'

/** 审计条目（写入时）。 */
export interface AuditEntry {
  batchId?: string
  operator: string
  role: AuditRole
  /** 数据范围（class/grade/unit）。 */
  scope: string
  /** 操作类型（如 batch.create / template.import / unit.init）。 */
  action: string
  /** 操作目标（如 batchId / templateId）。 */
  target?: string
  /** 变更前后 JSON。 */
  detail?: unknown
}

/** 写入一条审计日志。 */
export function writeAudit(entry: AuditEntry): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO audit_log (batch_id, operator, role, scope, action, target, detail, created_at)
     VALUES (@batchId, @operator, @role, @scope, @action, @target, @detail, @createdAt)`
  ).run({
    batchId: entry.batchId ?? null,
    operator: entry.operator,
    role: entry.role,
    scope: entry.scope,
    action: entry.action,
    target: entry.target ?? null,
    detail: entry.detail !== undefined ? JSON.stringify(entry.detail) : null,
    createdAt: Date.now()
  })
}

/** 查询审计日志（按时间倒序，分页）。 */
export function listAudit(options?: {
  limit?: number
  offset?: number
  batchId?: string
}): AuditLog[] {
  const db = getDb()
  const { limit = 200, offset = 0, batchId } = options ?? {}
  const where = batchId ? 'WHERE batch_id = @batchId' : ''
  const rows = db
    .prepare(
      `SELECT id, batch_id AS batchId, operator, role, scope, action, target, detail, created_at AS createdAt
       FROM audit_log
       ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT @limit OFFSET @offset`
    )
    .all({ limit, offset, batchId: batchId ?? null }) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    ...r,
    detail: r.detail ? JSON.parse(r.detail as string) : undefined
  })) as unknown as AuditLog[]
}
