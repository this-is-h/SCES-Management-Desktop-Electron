/**
 * 授权状态服务：安装实例ID、到期判定、写操作前置校验。
 * 判定在主进程执行（防渲染层绕过）；过期后降级为只读——可打开查看历史数据，
 * 但一切写操作（创建/编辑/激活/关闭/导入/导出）被 assertWritable 拦截。
 */
import { randomUUID } from 'crypto'
import { decideClockGuard } from '@sces/shared/license'
import { getSetting, setSetting } from './settings'

/** 授权状态。 */
export interface LicenseStatus {
  /** 是否已激活（存在当前账号）。 */
  activated: boolean
  /** 授权到期时间。 */
  expiresAt?: number
  /** 是否已过期（过期后只读）。 */
  expired: boolean
  /** 时钟回拨检测（离线防篡改，dual-mode/03 §6）。 */
  rolledBack?: boolean
  /** 距到期剩余天数（已过期为 0）；用于 ≤30 天续期提示。 */
  daysRemaining?: number
}

/** 安装实例ID：首次生成并持久化，随所有服务端请求上送，标识本机。 */
export function getInstallId(): string {
  let id = getSetting('installId')
  if (!id) {
    id = randomUUID()
    setSetting('installId', id)
  }
  return id
}

/**
 * 时钟回拨防护（dual-mode/03 §6）：每次读授权状态时推进单调水位；
 * 发现 now 明显早于水位（超容差）即判定时钟被调回，用于绕过 expiresAt。
 * 诚实边界：能防"随手改时间"，不能防"删 settings.json + 改时间"（离线固有上限）。
 */
export function guardClock(): { rolledBack: boolean; highWater: number } {
  if (!__DMS_CLOCK_GUARD__.enabled) return { rolledBack: false, highWater: 0 }
  const hw = getSetting('clockHighWater') ?? 0
  const { rolledBack, nextHighWater } = decideClockGuard(Date.now(), hw, __DMS_CLOCK_GUARD__.toleranceMs)
  if (nextHighWater !== hw) setSetting('clockHighWater', nextHighWater)
  return { rolledBack, highWater: nextHighWater }
}

/** 读取当前授权状态（基于本地 expiresAt；离线以本地为准 + 时钟回拨检测）。 */
export function getLicenseStatus(): LicenseStatus {
  const activation = getSetting('activation')
  if (!activation) return { activated: false, expired: false }
  const now = Date.now()
  const { rolledBack } = guardClock()
  const expiresAt = activation.expiresAt
  const expired = typeof expiresAt === 'number' ? expiresAt < now : false
  const daysRemaining =
    typeof expiresAt === 'number' ? Math.max(0, Math.ceil((expiresAt - now) / 86_400_000)) : undefined
  return { activated: true, expiresAt, expired, rolledBack, daysRemaining }
}

/**
 * 写操作前置校验：未授权 / 时钟回拨 / 过期一律拒绝。
 * 所有写 IPC（批次增删改/状态迁移/导入等）进入服务层前必须调用。
 */
export function assertWritable(): void {
  const s = getLicenseStatus()
  if (!s.activated) throw new Error('系统未授权，无法执行操作')
  if (s.rolledBack) {
    throw new Error(
      '检测到系统时间异常（本机记录的最近使用时间晚于当前时间），请校正系统时间后重试'
    )
  }
  if (s.expired) {
    throw new Error(
      `授权已于 ${new Date(s.expiresAt!).toLocaleDateString('zh-CN')} 过期，当前仅可查看历史数据，无法进行操作。请联系服务商续期`
    )
  }
}
