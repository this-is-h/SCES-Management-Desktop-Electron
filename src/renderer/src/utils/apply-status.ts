/**
 * 申请状态展示（渲染层）：中文标签与 Badge 颜色集中维护，多个页面共用。
 * 注意：申请状态与批次状态不同（批次状态见 utils/batch-status.ts，draft=未开放）。
 */
import type { ApplyStatus } from '@sces/shared'

export type ApplyStatusBadgeColor = 'neutral' | 'info' | 'warning' | 'success'

/** 申请状态 → Badge 颜色。 */
export const applyStatusColor: Record<ApplyStatus, ApplyStatusBadgeColor> = {
  draft: 'neutral',
  submitted: 'neutral',
  imported: 'info',
  reviewing: 'warning',
  confirmed: 'success'
}

/** 申请状态中文标签。 */
export const applyStatusLabel: Record<ApplyStatus, string> = {
  draft: '草稿',
  submitted: '已导出',
  imported: '待审核',
  reviewing: '审核中',
  confirmed: '已确认'
}
