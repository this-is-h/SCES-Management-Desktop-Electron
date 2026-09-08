import type { ApplyStatusReport, ApplyStatusesReport, BatchPublicInput } from '../gateway/types'
import type { BatchStatus } from '@sces/shared'
import { getDb } from '../db'
import { gateway } from '../gateway'

type StatusOutboxOperation = 'batch-public' | 'batch-status' | 'apply-status' | 'apply-statuses'

interface BatchStatusPayload {
  batchId: string
  status: BatchStatus
}

type StatusOutboxPayload = BatchPublicInput | BatchStatusPayload | ApplyStatusReport | ApplyStatusesReport

interface StatusOutboxRow {
  id: number
  operation: StatusOutboxOperation
  payload: string
  attempts: number
}

let workerTimer: NodeJS.Timeout | null = null
let processing = false

function enqueue(
  operation: StatusOutboxOperation,
  batchId: string,
  payload: StatusOutboxPayload
): number | null {
  if (gateway.mode !== 'online') return null
  const now = Date.now()
  const result = getDb()
    .prepare(
      `INSERT INTO status_outbox (operation, batch_id, payload, attempts, next_attempt_at, created_at)
       VALUES (?, ?, ?, 0, ?, ?)`
    )
    .run(operation, batchId, JSON.stringify(payload), now, now)
  return Number(result.lastInsertRowid)
}

/** 返回需要重试的缩减 payload；null 表示本事件已完整成功。 */
async function dispatch(
  operation: StatusOutboxOperation,
  payload: StatusOutboxPayload
): Promise<StatusOutboxPayload | null> {
  switch (operation) {
    case 'batch-public':
      await gateway.publishBatch(payload as BatchPublicInput)
      return null
    case 'batch-status': {
      const value = payload as BatchStatusPayload
      await gateway.publishBatchStatus(value.batchId, value.status)
      return null
    }
    case 'apply-status':
      await gateway.publishApplyStatus(payload as ApplyStatusReport)
      return null
    case 'apply-statuses': {
      const value = payload as ApplyStatusesReport
      const result = await gateway.publishApplyStatuses(value)
      if (result.failed === 0) return null
      const failedIds = result.results.filter((item) => !item.ok).map((item) => item.applyId)
      return { ...value, applyIds: failedIds.length > 0 ? failedIds : value.applyIds }
    }
  }
}

function retryDelay(attempts: number): number {
  return Math.min(5 * 60_000, 5_000 * 2 ** Math.min(attempts, 6))
}

/** Retries pending operations in creation order so the remote monotonic state machine cannot be reordered. */
export async function flushStatusOutbox(): Promise<void> {
  if (gateway.mode !== 'online' || processing) return
  processing = true
  try {
    const db = getDb()
    const rows = db
      .prepare(
        `SELECT id, operation, payload, attempts
         FROM status_outbox
         WHERE completed_at IS NULL AND next_attempt_at <= ?
         ORDER BY id ASC LIMIT 50`
      )
      .all(Date.now()) as StatusOutboxRow[]

    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload) as StatusOutboxPayload
        const retryPayload = await dispatch(row.operation, payload)
        if (retryPayload) {
          const attempts = row.attempts + 1
          db.prepare(
            `UPDATE status_outbox
             SET payload = ?, attempts = ?, next_attempt_at = ?, last_error = ?
             WHERE id = ?`
          ).run(
            JSON.stringify(retryPayload),
            attempts,
            Date.now() + retryDelay(attempts),
            '部分申请状态尚未同步',
            row.id
          )
          break
        }
        db.prepare('UPDATE status_outbox SET completed_at = ?, last_error = NULL WHERE id = ?').run(
          Date.now(),
          row.id
        )
      } catch (error) {
        const attempts = row.attempts + 1
        const message = error instanceof Error ? error.message : 'status sync failed'
        db.prepare(
          `UPDATE status_outbox
           SET attempts = ?, next_attempt_at = ?, last_error = ?
           WHERE id = ?`
        ).run(attempts, Date.now() + retryDelay(attempts), message.slice(0, 500), row.id)
        // Preserve event order; a later state must not overtake the failed state.
        break
      }
    }

    db.prepare('DELETE FROM status_outbox WHERE completed_at IS NOT NULL AND completed_at < ?').run(
      Date.now() - 30 * 24 * 60 * 60_000
    )
  } catch {
    // No active database during activation/account switching: the next interval retries automatically.
  } finally {
    processing = false
  }
}

async function enqueueAndFlush(
  operation: StatusOutboxOperation,
  batchId: string,
  payload: StatusOutboxPayload
): Promise<boolean> {
  if (gateway.mode !== 'online') return true
  const id = enqueue(operation, batchId, payload)
  if (id === null) return true
  await flushStatusOutbox()
  const row = getDb()
    .prepare('SELECT completed_at AS completedAt FROM status_outbox WHERE id = ?')
    .get(id) as { completedAt: number | null } | undefined
  return Boolean(row?.completedAt)
}

export function startStatusOutboxWorker(): void {
  if (gateway.mode !== 'online' || workerTimer) return
  void flushStatusOutbox()
  workerTimer = setInterval(() => void flushStatusOutbox(), 30_000)
}

export async function publishBatchReliable(input: BatchPublicInput): Promise<boolean> {
  return enqueueAndFlush('batch-public', input.batchId, input)
}

export async function publishBatchStatusReliable(batchId: string, status: BatchStatus): Promise<boolean> {
  return enqueueAndFlush('batch-status', batchId, { batchId, status })
}

export async function publishApplyStatusReliable(input: ApplyStatusReport): Promise<boolean> {
  return enqueueAndFlush('apply-status', input.batchId, input)
}

export async function publishApplyStatusesReliable(input: ApplyStatusesReport): Promise<boolean> {
  return enqueueAndFlush('apply-statuses', input.batchId, input)
}
