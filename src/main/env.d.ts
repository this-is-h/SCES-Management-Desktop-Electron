/** 构建时注入（electron.vite.config.ts define）。 */

/** 当前发布模式：offline（离线）或 online（在线）。来源 deploy/profile.json.mode。 */
declare const __DMS_MODE__: 'offline' | 'online'

/** 发布档标识（写进"关于"页，便于售后定位）。来源 deploy/profile.json.profileId。 */
declare const __DMS_PROFILE_ID__: string

/**
 * 构建时注入的服务端地址（electron.vite.config.ts define）。
 * offline 下为空串：任何误用都会立刻在 dev 里暴露，而不是静默打到 example.com。
 */
declare const __DMS_SERVER_URL__: string

/**
 * 服务商签名公钥列表（可多把，支持轮换）。来源 deploy/profile.json.management.licenseVerifyKeys。
 * 仅 offline 模式携带；online 下为空数组。
 */
declare const __DMS_LICENSE_VERIFY_KEYS__: {
  keyId: string
  publicKeyJwk: import('@sces/shared').Jwk
}[]

/**
 * 授权时钟守卫配置（防篡改时钟绕过授权过期）。来源 deploy/profile.json.management.clockGuard。
 * profile 未配置时回退为 { enabled: false, toleranceMs: 0 }。
 */
declare const __DMS_CLOCK_GUARD__: { enabled: boolean; toleranceMs: number }
/** 自动更新检查源（electron.vite.config.ts define）。来源 deploy/profile.json.management.updateUrl。 */
declare const __DMS_UPDATE_URL__: string
