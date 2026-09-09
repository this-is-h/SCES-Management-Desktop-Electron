/**
 * 本地数据库加密密钥保管（决策：SQLCipher（better-sqlite3-multiple-ciphers）加密 dms.db）。
 *
 * 密钥：首次生成 32 字节随机密钥（base64），用 Electron safeStorage（Windows = DPAPI）
 * 加密后落盘 userData/security/db-key.json；运行期解密到内存供 SQLite 连接使用。
 * 效果：数据库文件脱离本机 Windows 用户凭据即不可读（拷贝 %APPDATA% 到别的机器/账号打不开）。
 *
 * 降级：safeStorage.isEncryptionAvailable() 为 false 的平台（如无钥匙环的 Linux），
 * 回退为明文落盘并打错误日志——该平台加密形同虚设，属可接受的显式降级（本产品目标平台为 Windows）。
 */
import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'

/** 密钥文件版本。 */
const KEY_FILE_VERSION = 1

interface DbKeyFileV1 {
  version: 1
  /** 加密方式：safeStorage（DPAPI）或 plaintext-fallback。 */
  wrapped: 'safeStorage' | 'plaintext-fallback'
  /** wrapped='safeStorage'：safeStorage.encryptString(密钥base64) 的 base64。 */
  sealed?: string
  /** wrapped='plaintext-fallback'：明文密钥 base64（仅 safeStorage 不可用时的显式降级）。 */
  plain?: string
}

export interface DbKeyMaterial {
  /** 数据库密钥（base64，32 字节随机）。 */
  key: string
  /** 密钥如何保管。 */
  wrapped: 'safeStorage' | 'plaintext-fallback'
}

function keyFilePath(): string {
  return join(app.getPath('userData'), 'security', 'db-key.json')
}

function readKeyFile(): DbKeyFileV1 | null {
  const path = keyFilePath()
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as DbKeyFileV1
    if (!parsed || parsed.version !== KEY_FILE_VERSION) return null
    return parsed
  } catch {
    return null
  }
}

function writeKeyFile(file: DbKeyFileV1): void {
  const path = keyFilePath()
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(file, null, 2))
}

/**
 * 读取或首次生成数据库密钥。生成后立即加密落盘，后续启动复用。
 * 密钥文件损坏/缺失但库已加密时，调用方（db 层）会给出「数据库无法打开」的明确提示。
 */
export function loadOrCreateDbKey(): DbKeyMaterial {
  const existing = readKeyFile()
  if (existing) {
    if (existing.wrapped === 'safeStorage' && typeof existing.sealed === 'string') {
      return {
        key: safeStorage.decryptString(Buffer.from(existing.sealed, 'base64')),
        wrapped: 'safeStorage'
      }
    }
    if (existing.wrapped === 'plaintext-fallback' && typeof existing.plain === 'string') {
      return { key: existing.plain, wrapped: 'plaintext-fallback' }
    }
    throw new Error('数据库密钥文件内容无效，无法解密数据库')
  }

  // 首次生成：32 字节随机密钥（base64 表示，无引号等 SQL 特殊字符，可安全嵌入 PRAGMA）。
  const key = randomBytes(32).toString('base64')
  if (safeStorage.isEncryptionAvailable()) {
    const sealed = safeStorage.encryptString(key)
    writeKeyFile({
      version: KEY_FILE_VERSION,
      wrapped: 'safeStorage',
      sealed: sealed.toString('base64')
    })
    return { key, wrapped: 'safeStorage' }
  }
  // 显式降级：无系统级密钥保护（Linux 无钥匙环等）。写入错误日志便于部署侧发现。
  console.error('[db-key] safeStorage 不可用，数据库密钥以明文落盘（该平台加密保护降级为仅混淆）')
  writeKeyFile({ version: KEY_FILE_VERSION, wrapped: 'plaintext-fallback', plain: key })
  return { key, wrapped: 'plaintext-fallback' }
}
