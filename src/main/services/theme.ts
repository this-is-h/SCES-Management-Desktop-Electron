/**
 * 主题服务：亮色/暗色/系统三态切换（参考 test/clubx 实现）。
 * - nativeTheme.themeSource 控制 Electron 主题（窗口控制按钮、系统 UI）。
 * - 渲染层通过 Nuxt UI color mode 切换 <html>.dark class 驱动 --ui-* 变量。
 * - 主题模式持久化到 settings.json（settings 服务）。
 */
import { nativeTheme, BrowserWindow } from 'electron'
import { getSetting, setSetting } from './settings'

export type ThemeMode = 'light' | 'dark' | 'system'

const TITLEBAR_HEIGHT = 35

/** 标题栏背景色（与渲染层 --ui-bg 一致；暗色为 Nuxt UI 默认 neutral=slate 的 900 阶）。 */
const TITLEBAR_COLORS = {
  light: { color: '#ffffff', symbolColor: '#000000' },
  dark: { color: '#18181b', symbolColor: '#ffffff' }
} as const

/** 当前主题模式。 */
export function getThemeMode(): ThemeMode {
  return nativeTheme.themeSource as ThemeMode
}

/** 设置主题模式（light/dark/system），并同步窗口标题栏覆盖层。 */
export function setThemeMode(mode: ThemeMode): void {
  nativeTheme.themeSource = mode
  setSetting('themeMode', mode)
  updateTitleBarOverlay()
}

/** 当前是否深色（跟随系统时取系统值）。 */
export function isDark(): boolean {
  return nativeTheme.shouldUseDarkColors
}

/** 更新所有窗口的标题栏覆盖层颜色（窗口控制按钮）。 */
export function updateTitleBarOverlay(): void {
  const colors = isDark() ? TITLEBAR_COLORS.dark : TITLEBAR_COLORS.light
  for (const win of BrowserWindow.getAllWindows()) {
    win.setTitleBarOverlay({
      color: colors.color,
      symbolColor: colors.symbolColor,
      height: TITLEBAR_HEIGHT
    })
  }
}

/** 监听系统主题变化（nativeTheme.themeSource 变化或系统主题切换）。 */
export function onThemeUpdated(callback: () => void): void {
  nativeTheme.on('updated', callback)
}

/** 初始化：应用持久化主题模式。 */
export function initTheme(): void {
  nativeTheme.themeSource = getSetting('themeMode') ?? 'system'
}
