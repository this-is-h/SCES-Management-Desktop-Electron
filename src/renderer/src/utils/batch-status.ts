/**
 * 批次状态展示（渲染层）：中文标签统一来自 shared `BATCH_STATUS_LABELS`（避免文案漂移），
 * 颜色为 UI 层关注点，集中在此维护。
 */
import type { BatchStatus } from '@sces/shared'
import { BATCH_STATUS_LABELS } from '@sces/shared'

export type BatchStatusBadgeColor = 'neutral' | 'info' | 'success'

/** 批次状态 → Badge 颜色（draft 未开放 / active 进行中 / closed 已结束）。 */
export const batchStatusColor: Record<BatchStatus, BatchStatusBadgeColor> = {
  draft: 'neutral',
  active: 'info',
  closed: 'success'
}

/** 批次状态中文标签（shared 单一来源）。 */
export function batchStatusLabel(status: BatchStatus): string {
  return BATCH_STATUS_LABELS[status] ?? status
}
