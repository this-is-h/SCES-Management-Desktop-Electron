/**
 * 应用设置服务：持久化到 userData/settings.json。
 * 存储：主题模式、服务端地址、安装实例ID、激活信息、时钟水位、数据目录。
 */
import { app } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

/** 数据范围（兼容存量离线账号读取；新激活均为 level1 无 scope）。 */
export type LicenseScope = { grade?: string; class?: string }

/** 激活状态(persist 到 settings.json 的 activation 字段)。 */
export interface ActivationState {
  unitId: string
  /** 生效有效期（服务端下发）。 */
  expiresAt: number
  role?: 'level1' | 'level2' | 'level3'
  scope?: { grade?: string; class?: string }
  /** 服务端授权 id。 */
  licenseId?: string
  /** online:unitToken(决策 #29)。 */
  unitToken?: string
}

interface AppSettings {
  themeMode?: 'light' | 'dark' | 'system'
  serverUrl?: string
  /** 安装实例ID（首次生成，随请求上送，标识本机）。 */
  installId?: string
  /** 激活信息（role/scope 供存量离线账号兼容读取；新激活均为 level1 无 scope）。 */
  activation?: ActivationState
  /** 自动更新检查源（覆盖构建期注入的 __DMS_UPDATE_URL__；改域/CDN/OSS 时用，无需重打包）。 */
  updateUrl?: string
  /** 上次自动更新检查时间（Unix 毫秒，24h 节流用）。 */
  updateLastCheckAt?: number
  /**
   * 自定义数据根目录（未设置 = 默认 userData/data）。
   * 通过「设置 → 数据存储」迁移后写入，指向其他盘/共享盘。
   */
  dataDir?: string
}

let cache: AppSettings | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function load(): AppSettings {
  if (cache) return cache
  try {
    cache = JSON.parse(readFileSync(settingsPath(), 'utf-8')) as AppSettings
  } catch {
    cache = {}
  }
  return cache
}

function save(): void {
  try {
    writeFileSync(settingsPath(), JSON.stringify(cache ?? {}, null, 2))
  } catch {
    // 写入失败不影响运行
  }
}

export function getSetting<K extends keyof AppSettings>(key: K): AppSettings[K] | undefined {
  return load()[key]
}

export function setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
  load()[key] = value
  save()
}
