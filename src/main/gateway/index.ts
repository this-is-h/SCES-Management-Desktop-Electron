/**
 * 网关选择（在线版唯一实现）。离线网关与双模切换已随离线版下线移除。
 */
import { onlineGateway } from './online'
import type { AdminGateway } from './types'

export const gateway: AdminGateway = onlineGateway

export { capabilities } from './capabilities'
export type { AdminCapabilities } from './capabilities'
