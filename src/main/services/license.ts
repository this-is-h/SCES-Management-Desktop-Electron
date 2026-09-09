/**
 * 授权状态服务：安装实例ID、到期判定、写操作前置校验。
 * 判定在主进程执行（防渲染层绕过）；过期后降级为只读——可打开查看历史数据，
 * 但一切写操作（创建/编辑/激活/关闭/导入/导出）被 assertWritable 拦截。
 * 授权状态以服务端为准（可远端刷新），本地 expiresAt 仅做离线兜底提示。
 */
import { randomUUID } from 'crypto'
import { getSetting, setSetting } from './settings'

/** 授权状态。 */
export interface LicenseStatus {
  /** 是否已激活（存在当前账号）。 */
  activated: boolean
  /** 授权到期时间。 */
  expiresAt?: number
  /** 是否已过期（过期后只读）。 */
  expired: boolean
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

/** 读取当前授权状态（本地 expiresAt；在线可经 gateway.fetchLicenseStatus 远端刷新）。 */
export function getLicenseStatus(): LicenseStatus {
  const activation = getSetting('activation')
  if (!activation) return { activated: false, expired: false }
  const now = Date.now()
  const expiresAt = activation.expiresAt
  const expired = typeof expiresAt === 'number' ? expiresAt < now : false
  const daysRemaining =
    typeof expiresAt === 'number' ? Math.max(0, Math.ceil((expiresAt - now) / 86_400_000)) : undefined
  return { activated: true, expiresAt, expired, daysRemaining }
}

/**
 * 写操作前置校验：未授权 / 过期一律拒绝。
 * 所有写 IPC（批次增删改/状态迁移/导入等）进入服务层前必须调用。
 */
export function assertWritable(): void {
  const s = getLicenseStatus()
  if (!s.activated) throw new Error('系统未授权，无法执行操作')
  if (s.expired) {
    throw new Error(
      `授权已于 ${new Date(s.expiresAt!).toLocaleDateString('zh-CN')} 过期，当前仅可查看历史数据，无法进行操作。请联系服务商续期`
    )
  }
}
