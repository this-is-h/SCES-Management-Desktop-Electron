/**
 * 自动更新服务：轻量版本检查（不下载安装包，只检查是否有新版并引导手动下载）。
 *
 * 设计（与 dual-mode 离线优先基调一致）：
 * - 只拉取一个静态 latest.json 元数据，与 app.getVersion() 比对，不触发 electron-updater 的全量下载流。
 * - 网络失败/无更新一律静默返回 null，绝不影响主流程（离线可用）。
 * - 检查源 = deploy/profile.json.management.updateUrl（构建期注入 __DMS_UPDATE_URL__），
 *   可被 settings 里的 updateUrl 覆盖（便于改域/CDN/OSS 而无需重打包）。
 * - 自动检查仅在打包态（!is.dev）生效，且 24h 节流；设置页手动按钮强制检查。
 */
import { app, net, BrowserWindow } from 'electron'
import { getSetting, setSetting } from './settings'

/** latest.json 元数据格式（由发布流程/脚本生成，托管在静态站点）。 */
export interface UpdateManifest {
  /** 最新版本号，与 package.json 的 version 语义一致（semver）。 */
  version: string
  /** 更新日志（渲染层展示，纯文本，可含换行）。 */
  notes?: string
  /** 下载页/安装包直链（引导用户手动下载安装）。 */
  downloadUrl: string
  /** true = 强更（旧版应停止使用）；false/缺省 = 可选更新。 */
  mandatory?: boolean
  /** 更新时间（ISO 或 Unix 秒，展示用）。 */
  publishedAt?: string | number
}

/** 检查结果（渲染层可直接消费；null = 网络失败/无更新通道，静默不打扰）。 */
export interface UpdateCheckResult {
  current: string
  latest: string
  /** 是否有可更新版本（latest > current）。 */
  hasUpdate: boolean
  /** 是否强更（仅 hasUpdate 时有意义）。 */
  mandatory: boolean
  notes?: string
  downloadUrl: string
  publishedAt?: string | number
}

/** 自动检查节流间隔：24 小时。 */
const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
/** 单次检查网络超时：10 秒（避免离线场景长时间卡住）。 */
const FETCH_TIMEOUT_MS = 10_000

/** 缓存目录/时间 key（settings.json 持久化，重启不丢失节流状态）。 */
const LAST_CHECK_KEY = 'updateLastCheckAt' as const

/**
 * 解析当前版本号（app.getVersion() 可能带 `v` 前缀或 `-build` 后缀，统一归一到 semver 比较）。
 * 返回 [major, minor, patch] 数值数组；解析失败返回 null。
 */
function parseVersion(v: string | undefined | null): [number, number, number] | null {
  if (!v) return null
  const clean = v.trim().replace(/^v/i, '').split('-')[0] ?? ''
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(clean)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** 版本比较：a > b 返回 1，a < b 返回 -1，相等返回 0。 */
function compareVersions(a: [number, number, number] | null, b: [number, number, number] | null): number {
  if (!a && !b) return 0
  if (!a) return -1
  if (!b) return 1
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return 1
    if (a[i] < b[i]) return -1
  }
  return 0
}

/** 当前检查源：settings 覆盖 > 构建期注入。 */
export function getUpdateUrl(): string {
  return getSetting('updateUrl') ?? __DMS_UPDATE_URL__ ?? ''
}

/**
 * 拉取并解析 latest.json。失败返回 null（不抛，静默）。
 * 用 Electron 的 net.fetch（走系统代理，兼容国内网络环境）。
 */
async function fetchManifest(): Promise<UpdateManifest | null> {
  const url = getUpdateUrl()
  if (!url) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const resp = await net.fetch(url, { signal: controller.signal })
    if (!resp.ok) return null
    const json = (await resp.json()) as Partial<UpdateManifest>
    if (!json || typeof json.version !== 'string' || typeof json.downloadUrl !== 'string') return null
    return {
      version: json.version,
      notes: typeof json.notes === 'string' ? json.notes : undefined,
      downloadUrl: json.downloadUrl,
      mandatory: json.mandatory === true,
      publishedAt: json.publishedAt
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 执行一次版本检查。manual=false 时遵循 24h 节流；manual=true 忽略节流。
 * 返回 null 表示「网络失败/无更新通道/节流中」，渲染层据此静默或提示。
 */
export async function checkForUpdates(manual: boolean): Promise<UpdateCheckResult | null> {
  // 仅打包态自动检查；dev 下只允许手动触发（且需显式配置了 updateUrl）。
  const url = getUpdateUrl()
  if (!url) return null
  if (!manual) {
    const last = getSetting(LAST_CHECK_KEY)
    if (typeof last === 'number' && Date.now() - last < AUTO_CHECK_INTERVAL_MS) return null
  }

  const manifest = await fetchManifest()
  if (!manifest) return null

  const current = app.getVersion()
  const cur = parseVersion(current)
  const latest = parseVersion(manifest.version)
  const hasUpdate = compareVersions(latest, cur) > 0

  // 更新节流时间：无论结果如何都记录，避免失败后 24h 内疯狂重试。
  if (!manual) setSetting(LAST_CHECK_KEY, Date.now())

  return {
    current,
    latest: manifest.version,
    hasUpdate,
    mandatory: manifest.mandatory === true && hasUpdate,
    notes: manifest.notes,
    downloadUrl: manifest.downloadUrl,
    publishedAt: manifest.publishedAt
  }
}

/** 把检查结果推送给所有窗口（渲染层订阅 update:status）。 */
function pushToRenderer(payload: UpdateCheckResult | null): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('update:status', payload)
  }
}

/** 自动检查入口：打包态启动延迟 + 节流。失败静默。 */
export function initUpdater(): void {
  if (import.meta.env?.DEV || process.env.NODE_ENV === 'development' || !app.isPackaged) return
  if (!getUpdateUrl()) return
  // 启动延迟 15s，避免与窗口初始化争抢；内部再叠加 24h 节流。
  setTimeout(() => {
    void checkForUpdates(false).then((result) => {
      if (result) pushToRenderer(result)
    })
  }, 15_000)
}