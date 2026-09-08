/**
 * 管理端能力矩阵（dual-mode/13-flow-symmetry.md §6 收敛版）。
 *
 * **全仓库唯一允许读 __DMS_MODE__ 的业务侧文件**（另一处是 env.d.ts 的 declare）。
 * scripts/check-symmetry.mjs 机械校验这一点：命中其他文件即失败。
 *
 * 每个标记都是**真实的能力/传输差异**，不是"同一件事的两种做法"——
 * 初稿的 applyKeySource / batchIdStrategy / statusReporting 已删除（见 13 §1）。
 */
export interface AdminCapabilities {
  mode: 'offline' | 'online'
  profileId: string
  /** 一级激活方式（二三级恒为授权文件 .dysd，不受模式影响）。 */
  unitActivation: 'license-code' | 'license-file'
  /** 设置页是否显示服务端地址（仅 online + dev）。 */
  serverUrlConfigurable: boolean
  /** 授权状态能否远端刷新与即时吊销（决定是否显示「刷新授权状态」）。 */
  remoteLicenseRefresh: boolean
  /** 公钥交付与换机的传输方式：HTTP 请求 / 导出文件交给服务商。 */
  transport: 'http' | 'file'
  /** 是否展示机器码（离线授权绑定用）。 */
  showFingerprint: boolean
}

/** 编译期常量折叠：Rollup 静态求值，离线产物里 online 分支整块被摇掉。 */
export const capabilities: AdminCapabilities =
  __DMS_MODE__ === 'offline'
    ? {
        mode: 'offline',
        profileId: __DMS_PROFILE_ID__,
        unitActivation: 'license-file',
        serverUrlConfigurable: false,
        remoteLicenseRefresh: false,
        transport: 'file',
        showFingerprint: true
      }
    : {
        mode: 'online',
        profileId: __DMS_PROFILE_ID__,
        unitActivation: 'license-code',
        serverUrlConfigurable: true,
        remoteLicenseRefresh: true,
        transport: 'http',
        showFingerprint: false
      }
