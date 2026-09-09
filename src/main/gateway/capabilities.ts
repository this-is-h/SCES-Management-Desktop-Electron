/**
 * 管理端能力矩阵（在线版收敛）。
 *
 * 仅保留发布档标识；离线能力位（文件激活/机器码/公钥包/文件换机等）已随离线版下线移除，
 * 渲染层不再按 mode/transport 分支。
 */
export interface AdminCapabilities {
  mode: 'online'
  profileId: string
}

export const capabilities: AdminCapabilities = {
  mode: 'online',
  profileId: __DMS_PROFILE_ID__
}
