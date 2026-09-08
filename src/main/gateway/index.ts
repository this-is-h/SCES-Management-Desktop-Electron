/**
 * 网关选择：**编译期常量三元**，Rollup 静态求值后另一实现整块被摇掉——
 * 离线产物不含 online.ts 的 HTTP 逻辑与服务端地址（06 §7；scripts/verify-build.mjs 机械保证）。
 * 必须保持可静态求值，不要经过函数包装，否则 tree-shaking 失效。
 */
import { offlineGateway } from './offline'
import { onlineGateway } from './online'
import type { AdminGateway } from './types'

export const gateway: AdminGateway =
  __DMS_MODE__ === 'offline' ? offlineGateway : onlineGateway

export { capabilities } from './capabilities'
export type { AdminCapabilities } from './capabilities'
