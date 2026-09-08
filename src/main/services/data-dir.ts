/**
 * 数据存储目录服务：查询当前数据目录，以及迁移数据到自定义位置（其他盘/共享盘）。
 * 默认数据根为 userData/data（见 accounts.ts），迁移后由 settings.dataDir 记录自定义路径。
 * 迁移是高风险操作：先关闭数据库确保 WAL 合并，再整体拷贝，失败回滚并保持设置不变。
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { cp } from 'fs/promises'
import { resolve, sep } from 'path'
import { closeDb } from '../db'
import { defaultDataDir, getDataDir, listAccounts } from './accounts'
import { setSetting } from './settings'

/** 数据目录信息（设置页展示用）。 */
export interface DataDirInfo {
  /** 当前数据根目录。 */
  dir: string
  /** 默认数据根目录（userData/data）。 */
  defaultDir: string
  /** 是否使用默认位置。 */
  isDefault: boolean
  /** 账号数（提示将迁移多少份数据）。 */
  accountCount: number
  /** 当前目录是否已有数据。 */
  hasData: boolean
}

/** 查询当前数据目录状态。 */
export function getDataDirInfo(): DataDirInfo {
  const dir = getDataDir()
  const defaultDir = defaultDataDir()
  return {
    dir,
    defaultDir,
    isDefault: dir === defaultDir,
    accountCount: listAccounts().length,
    hasData: existsSync(dir)
  }
}

/** 归一化路径用于比较（Windows 不区分大小写）。 */
function norm(p: string): string {
  const r = resolve(p)
  return process.platform === 'win32' ? r.toLowerCase() : r
}

/**
 * 迁移数据到目标目录（null 表示恢复默认位置）。
 * 迁移成功后设置持久化；失败则回滚（清掉拷贝内容）并保持原设置不变。
 * 恢复默认位置时，若默认目录已存在内容（系统自身的数据），由系统先清空再迁入，无需用户手动删除。
 */
export async function setDataDir(targetRaw: string | null): Promise<void> {
  const current = getDataDir()
  const defaultDir = defaultDataDir()
  const target = targetRaw ? resolve(targetRaw.trim()) : defaultDir

  if (!target) throw new Error('数据目录不能为空')
  if (norm(target) === norm(current)) throw new Error('目标目录与当前数据目录相同')
  // 防止把数据目录迁到自己内部（递归拷贝）
  if (norm(target).startsWith(norm(current) + sep))
    throw new Error('目标目录不能位于当前数据目录内')

  if (existsSync(target)) {
    if (targetRaw) {
      // 迁移到自定义目录：目标必须为空或不存在，避免覆盖已有数据
      if (readdirSync(target).length > 0) throw new Error('目标目录非空，请选择空目录或新目录')
    } else if (norm(target) !== norm(current)) {
      // 恢复默认位置：默认目录已有内容时由系统清空后迁入（当前数据仍完整，可回滚）
      rmSync(target, { recursive: true, force: true })
    }
  }

  // 关闭数据库连接，确保 WAL 数据合并、文件一致
  closeDb()

  const hadData = existsSync(current)
  const targetExisted = existsSync(target)
  try {
    if (hadData) {
      // fs.cp 会自动创建目标目录；把整个数据根（accounts.json + accounts/）拷过去
      await cp(current, target, { recursive: true })
    } else {
      mkdirSync(target, { recursive: true })
    }
  } catch (err) {
    // 回滚：清掉刚拷贝的内容；目标原本存在则恢复空目录
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    if (targetExisted) mkdirSync(target, { recursive: true })
    void err
    throw new Error('数据迁移失败，请检查目标目录是否可写，原数据未受影响')
  }

  // 写入设置（null 时恢复默认位置）
  if (targetRaw) setSetting('dataDir', target)
  else setSetting('dataDir', undefined)

  // 迁移成功后清空原数据根，避免残留两份数据（此时数据已在 target，安全可靠）。
  if (hadData && norm(current) !== norm(target)) {
    try {
      rmSync(current, { recursive: true, force: true })
    } catch {
      // 清理失败不影响迁移结果（如被占用），下次启动可再清理
    }
  }
}
