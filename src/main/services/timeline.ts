import { randomUUID } from 'crypto'
import type { AuditRole, TimelineAction, TimelineActorType, TimelineEvent } from '@sces/shared'
import { getDb } from '../db'
import { currentRole, currentScope, outOfScopeReason } from './role'

export interface TimelineWriteInput {
  eventId?: string
  batchId: string
  applyId?: string
  actorType: TimelineActorType
  role?: AuditRole
  scope?: Record<string, unknown>
  action: TimelineAction
  occurredAt?: number
  revision?: number
  sourceFileHash?: string
  detail?: Record<string, unknown>
}

/** Writes one idempotent event. Callers inside a larger transaction use this directly. */
export function insertTimelineEvent(input: TimelineWriteInput): string {
  const eventId = input.eventId ?? randomUUID()
  const occurredAt = Number.isFinite(input.occurredAt) ? Number(input.occurredAt) : Date.now()
  const createdAt = Date.now()
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO timeline_event
       (event_id, batch_id, apply_id, actor_type, role, scope_json, action, occurred_at,
        revision, source_file_hash, detail_json, created_at)
       VALUES (@eventId, @batchId, @applyId, @actorType, @role, @scopeJson, @action, @occurredAt,
        @revision, @sourceFileHash, @detailJson, @createdAt)`
    )
    .run({
      eventId,
      batchId: input.batchId,
      applyId: input.applyId ?? null,
      actorType: input.actorType,
      role: input.role ?? null,
      scopeJson: input.scope ? JSON.stringify(input.scope) : null,
      action: input.action,
      occurredAt,
      revision: input.revision ?? null,
      sourceFileHash: input.sourceFileHash ?? null,
      detailJson: input.detail ? JSON.stringify(input.detail) : null,
      createdAt
    })
  return eventId
}

/** Writes a local event and maintains query-friendly apply timestamp summaries. */
export function writeTimelineEvent(input: TimelineWriteInput): string {
  const eventId = insertTimelineEvent(input)
  if (!input.applyId) return eventId
  const db = getDb()
  const at = Number.isFinite(input.occurredAt) ? Number(input.occurredAt) : Date.now()
  switch (input.action) {
    case 'student.entered':
      db.prepare(
        `UPDATE apply SET first_entered_at = CASE
          WHEN first_entered_at IS NULL OR first_entered_at = 0 THEN ? ELSE first_entered_at END
         WHERE apply_id = ?`
      ).run(at, input.applyId)
      break
    case 'student.exported':
      db.prepare(
        `UPDATE apply SET last_student_exported_at = CASE
          WHEN last_student_exported_at IS NULL OR last_student_exported_at < ? THEN ? ELSE last_student_exported_at END
         WHERE apply_id = ?`
      ).run(at, at, input.applyId)
      break
    case 'admin.imported':
      db.prepare(
        `UPDATE apply SET last_imported_at = CASE
          WHEN last_imported_at IS NULL OR last_imported_at < ? THEN ? ELSE last_imported_at END
         WHERE apply_id = ?`
      ).run(at, at, input.applyId)
      break
    case 'admin.modified':
      db.prepare(
        `UPDATE apply SET last_modified_at = CASE
          WHEN last_modified_at IS NULL OR last_modified_at < ? THEN ? ELSE last_modified_at END
         WHERE apply_id = ?`
      ).run(at, at, input.applyId)
      break
    case 'admin.exported':
      db.prepare(
        `UPDATE apply SET last_exported_at = CASE
          WHEN last_exported_at IS NULL OR last_exported_at < ? THEN ? ELSE last_exported_at END
         WHERE apply_id = ?`
      ).run(at, at, input.applyId)
      break
    default:
      break
  }
  return eventId
}

export function listTimelineEvents(batchId: string, applyId: string): TimelineEvent[] {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT s.grade, s.class_name AS className
       FROM apply a JOIN student s ON s.id = a.student_id
       WHERE a.batch_id = ? AND a.apply_id = ?`
    )
    .get(batchId, applyId) as { grade: string | null; className: string | null } | undefined
  if (!row) throw new Error('申请不存在')
  if (outOfScopeReason({ grade: row.grade, className: row.className })) {
    throw new Error('申请不在当前账号授权范围内')
  }
  const rows = db
    .prepare(
      `SELECT event_id AS eventId, batch_id AS batchId, apply_id AS applyId,
              actor_type AS actorType, role, scope_json AS scopeJson, action,
              occurred_at AS occurredAt, revision, source_file_hash AS sourceFileHash,
              detail_json AS detailJson, created_at AS createdAt
       FROM timeline_event
       WHERE batch_id = ? AND apply_id = ?
       ORDER BY occurred_at ASC, event_id ASC`
    )
    .all(batchId, applyId) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    eventId: r.eventId as string,
    batchId: r.batchId as string,
    applyId: r.applyId as string,
    actorType: r.actorType as TimelineActorType,
    role: (r.role as AuditRole | null) ?? undefined,
    scope: parseJsonObject(r.scopeJson as string | null),
    action: r.action as TimelineAction,
    occurredAt: r.occurredAt as number,
    revision: (r.revision as number | null) ?? undefined,
    sourceFileHash: (r.sourceFileHash as string | null) ?? undefined,
    detail: parseJsonObject(r.detailJson as string | null),
    createdAt: r.createdAt as number
  }))
}

export function currentTimelineActor(): Pick<TimelineWriteInput, 'actorType' | 'role' | 'scope'> {
  return { actorType: 'admin', role: currentRole(), scope: { ...currentScope() } }
}

function parseJsonObject(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}
