/**
 * IPC 报错文案清洗：剥掉 Electron 在 invoke 失败时自动叠加的技术前缀，
 * 只保留主进程抛出的、面向用户的中文业务信息。SQLite、Node、文件路径和堆栈等
 * 技术细节写入开发者控制台，界面显示稳定的中文兜底文案。
 *
 * 说明（根治边界）：
 * - 主进程所有 throw 的错误文案都已是中文（服务层统一翻译，不透出底层英文/SQLite/HTTP 状态文本）；
 * - 唯一由系统叠加、主进程无法控制的是 Electron 的 IPC 前缀，格式固定为
 *   `Error invoking remote method '<channel>': Error: <原始message>`（见 electron 源码 ipc-renderer）。
 *   因此这里**只做确定性前缀剥离**，不用正则猜测业务内容、不过度处理。
 */

/** Electron IPC 前缀：channel 名不含冒号，故可用固定正则精确匹配一次。 */
const IPC_PREFIX = /^Error invoking remote method '[^']+':\s*Error:\s*/
const GENERIC_ERROR_PREFIX = /^(?:Error|TypeError|RangeError|ReferenceError|SyntaxError):\s*/i
const HAS_CHINESE = /[\u3400-\u9fff]/
const TECHNICAL_DETAIL =
  /(?:SQLITE(?:_[A-Z_]+)?|\bE(?:NOENT|ACCES|PERM|NOSPC|ISDIR|NOTDIR)\b|\bERR_[A-Z_]+\b|constraint failed|node:|file:\/\/|[A-Za-z]:\\|\/Users\/|\/home\/|\bat\s+\S+\s*\(|\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\s+\w+)/i

export function ipcErrorMessage(err: unknown): string {
  console.error('[ipc]', err)
  const raw = err instanceof Error ? err.message : String(err ?? '')
  const message = raw.replace(IPC_PREFIX, '').replace(GENERIC_ERROR_PREFIX, '').trim()
  if (
    !message ||
    message.length > 300 ||
    !HAS_CHINESE.test(message) ||
    TECHNICAL_DETAIL.test(message)
  ) {
    return '操作失败，请稍后重试；如持续出现，请联系系统管理员'
  }
  return message
}
