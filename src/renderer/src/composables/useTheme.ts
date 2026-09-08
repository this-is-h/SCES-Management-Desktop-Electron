/**
 * 主题状态管理（模块级单例）：亮色/暗色/系统三态。
 * - 状态来源不变：主进程 nativeTheme（getMode / isDark / theme:changed 推送）。
 * - 应用方式改为 Nuxt UI color mode：VueUse useColorMode 在 <html> 上切换 .dark class，
 *   驱动 Nuxt UI 的 --ui-* 语义变量。VueUse v14 合法值为 light/dark/auto（写入返回的
 *   ref 本身），应用层的 'system' 映射为 'auto'（自动跟随 prefers-color-scheme；
 *   Electron 渲染进程的媒体查询跟随主进程 nativeTheme.themeSource）。
 */
import { ref } from 'vue'
import { useColorMode } from '@vueuse/core'
import type { ThemeMode } from '../../../preload/types'

const mode = ref<ThemeMode>('system')
const isDark = ref(false)
let initialized = false

const colorMode = useColorMode()

/** 将应用模式同步到 Nuxt UI color mode（VueUse v14 合法值为 light/dark/auto）。 */
function applyColorMode(): void {
  colorMode.value = mode.value === 'system' ? 'auto' : mode.value
}

/** 初始化主题（幂等，应用启动时调用一次）。 */
export async function initTheme(): Promise<void> {
  if (initialized) return
  initialized = true
  try {
    mode.value = await window.api.theme.getMode()
    isDark.value = await window.api.theme.isDark()
    applyColorMode()
    window.api.theme.onChanged((dark) => {
      isDark.value = dark
    })
  } catch (err) {
    console.error('主题初始化失败', err)
  }
}

/** 切换主题模式（主进程会推送 theme:changed 更新 isDark）。 */
export async function setThemeMode(next: ThemeMode): Promise<void> {
  mode.value = next
  applyColorMode()
  try {
    await window.api.theme.setMode(next)
  } catch (err) {
    console.error('主题切换失败', err)
  }
}

export function useTheme(): {
  mode: typeof mode
  isDark: typeof isDark
  initTheme: typeof initTheme
  setThemeMode: typeof setThemeMode
} {
  return { mode, isDark, initTheme, setThemeMode }
}
