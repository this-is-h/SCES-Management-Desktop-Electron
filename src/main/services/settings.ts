/**
 * 应用设置服务：持久化到 userData/settings.json。
 * 存储：主题模式、服务端地址、安装实例ID、激活信息、时钟水位、数据目录。
 */
import { app } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

/** 激活状态(persist 到 settings.json 的 activation 字段)。 */
export interface ActivationState {
  unitId: string
  /** 生效有效期:一级 = .dysl 的 expiresAt;二三级 = min(.dysd expiresAt, unitCert.notAfter)。 */
  expiresAt: number
  role?: 'level1' | 'level2' | 'level3'
  scope?: { grade?: string; class?: string }
  /** 授权来源模式(与构建模式一致;不一致 = 授权文件与安装包不配套)。 */
  mode?: 'offline' | 'online'
  /** 一级:.dysl 授权 id。 */
  licenseId?: string
  /** 二三级:.dysd 下级授权 id。 */
  delegationId?: string
  /** 验签所用的服务商签名密钥 id。 */
  signKeyId?: string
  boundFingerprint?: string | null
  /** online:unitToken(决策 #29)。 */
  unitToken?: string
  /** 离线:是否已导出过公钥包(.dysk)。 */
  pubkeyExported?: boolean
}

interface AppSettings {
  themeMode?: 'light' | 'dark' | 'system'
  serverUrl?: string
  /** 安装实例ID（首次生成，随请求上送，标识本机）。 */
  installId?: string
  /** 激活信息(dual-mode/03 §4.2)。role/scope/mode 为激活时写入;存量在线数据可能缺失。 */
  activation?: ActivationState
  /** 自动更新检查源（覆盖构建期注入的 __DMS_UPDATE_URL__；改域/CDN/OSS 时用，无需重打包）。 */
  updateUrl?: string
  /** 上次自动更新检查时间（Unix 毫秒，24h 节流用）。 */
  updateLastCheckAt?: number
  /** 时钟回拨防护水位（dual-mode/03 §6）：单调推进的最近使用时间。 */
  clockHighWater?: number
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
