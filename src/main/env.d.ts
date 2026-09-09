/** 构建时注入（electron.vite.config.ts define）。 */

/** 发布档标识（写进"关于"页，便于售后定位）。来源 deploy/profile.json.profileId。 */
declare const __DMS_PROFILE_ID__: string

/**
 * 构建时注入的服务端地址（electron.vite.config.ts define）。
 * 生产模式编译进安装包；开发模式可被 settings.serverUrl 覆盖。
 */
declare const __DMS_SERVER_URL__: string

/** 自动更新检查源（electron.vite.config.ts define）。来源 deploy/profile.json.management.updateUrl。 */
declare const __DMS_UPDATE_URL__: string
