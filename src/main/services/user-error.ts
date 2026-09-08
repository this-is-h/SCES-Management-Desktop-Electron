const ELECTRON_ERROR_PREFIX = /^Error invoking remote method '[^']+':\s*Error:\s*/
const GENERIC_ERROR_PREFIX = /^(?:Error|TypeError|RangeError|ReferenceError|SyntaxError):\s*/i
const HAS_CHINESE = /[\u3400-\u9fff]/
const TECHNICAL_DETAIL =
  /(?:SQLITE(?:_[A-Z_]+)?|\bE(?:NOENT|ACCES|PERM|NOSPC|ISDIR|NOTDIR)\b|\bERR_[A-Z_]+\b|constraint failed|node:|file:\/\/|[A-Za-z]:\\|\/Users\/|\/home\/|\bat\s+\S+\s*\(|\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\s+\w+)/i

/**
 * Keeps expected Chinese business messages user-visible while logging unexpected technical failures.
 * This is also used by result-returning imports, which do not travel through rejected IPC promises.
 */
export function userFacingErrorMessage(error: unknown, fallback: string, context: string): string {
  console.error(`[${context}]`, error)
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const message = raw
    .replace(ELECTRON_ERROR_PREFIX, '')
    .replace(GENERIC_ERROR_PREFIX, '')
    .trim()
  if (!message || message.length > 300 || !HAS_CHINESE.test(message) || TECHNICAL_DETAIL.test(message)) {
    return fallback
  }
  return message
}
