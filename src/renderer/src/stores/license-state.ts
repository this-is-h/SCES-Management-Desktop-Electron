/**
 * 授权状态刷新信号：导出公钥包等操作后自增，顶栏 LicenseBanner 监听后立即刷新，
 * 避免「未导出公钥包」等提示在下一次 60s 轮询前仍旧显示。
 */
import { ref } from 'vue'

/** 自增即触发顶栏授权提示刷新。 */
export const licenseRefreshTick = ref(0)

/** 触发顶栏授权提示立即刷新。 */
export function bumpLicenseRefresh(): void {
  licenseRefreshTick.value += 1
}
