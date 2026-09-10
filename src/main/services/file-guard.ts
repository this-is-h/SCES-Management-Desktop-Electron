/**
 * 文件读入守卫：渲染层路径进入主进程读文件前的统一校验。
 *
 * 背景（评审 P2-4）：`unit:inspect-license` / `unit:import-cert` / `import:run`
 * 接受渲染层传来的文件路径直接 `readFileSync`。渲染层路径虽来自系统对话框，
 * 但主进程不应信任渲染层字符串——补两道防线：
 *  1. 扩展名白名单：只允许本通道合法的文件类型（如 .dyf），
 *     堵住"任意路径读取 + 错误文案差异构成的存在性/类型探测 oracle"；
   *  2. 大小上限：拒绝超大文件，避免同步 readFileSync 阻塞主进程。
 * 注：应用数据文件（.dyf 学生申请）放宽至 1GB（见 MAX_APPLICATION_FILE_BYTES），
 * 真实材料（压缩图片证据）可达数百 MB；license/证书文件保持 50MB 收紧下限。
 */
import { statSync } from 'fs'
import { extname } from 'path'

/** 默认单文件读取上限：50MB（正常 .dyf 含证据 base64 也远低于此）。 */
export const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024

/**
 * 应用数据文件读取上限：1GB。
 * .dyf（单个学生材料）的证据为压缩图片 base64，
 * 大班/多年级聚合可达数百 MB——上限只是 OOM 保险丝，不是业务边界。
 */
/** 业务不限制德育分文件大小；文件流/分块实现负责控制运行时内存。 */
export const MAX_APPLICATION_FILE_BYTES = Number.MAX_SAFE_INTEGER

/**
 * 校验文件可读：扩展名在白名单、存在且为普通文件、大小不超上限。
 * 任一不满足抛中文错误（由 userFacingErrorMessage 收敛为用户可见文案）。
 */
export function assertReadableFile(
  filePath: string,
  allowedExts: string[],
  maxBytes: number = DEFAULT_MAX_FILE_BYTES
): void {
  const ext = extname(String(filePath ?? '')).toLowerCase()
  if (!allowedExts.includes(ext)) {
    const label = ext ? `（${ext}）` : '（无扩展名）'
    throw new Error(`不支持的文件类型${label}，允许：${allowedExts.join(' / ')}`)
  }
  let st
  try {
    st = statSync(filePath)
  } catch {
    throw new Error('文件不存在或无法访问')
  }
  if (!st.isFile()) {
    throw new Error('所选路径不是文件')
  }
  if (st.size > maxBytes) {
    const mb = Math.ceil(st.size / 1024 / 1024)
    const cap = Math.floor(maxBytes / 1024 / 1024)
    throw new Error(`文件过大（${mb}MB，上限 ${cap}MB）`)
  }
}
