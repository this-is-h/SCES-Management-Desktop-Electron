/**
 * 单位签发密钥(RSA-PSS)读取:unit 表的 public_key_jwk / private_key_jwk。
 * 一级激活时本地生成,私钥不出本机;二三级只存签发公钥(private_key_jwk 为 NULL,schema v8)。
 *
 * 独立成服务(不放 gateway/offline.ts):delegation.ts / unit.ts / 两份网关都要读它,
 * 而 service 不应依赖 offline 网关——否则会把 offline 实现拖进在线产物,破坏 tree-shaking。
 */
import type { Jwk } from '@sces/shared'
import { getDb } from '../db'

/** 单位签发密钥。二三级无私钥(privateKeyJwk = null)。 */
export interface UnitSignKey {
  unitId: string
  publicKeyJwk: Jwk
  privateKeyJwk: Jwk | null
}

/** 单位签发密钥 keyId(M-O1 单账号单签发密钥,确定性派生;轮换留后续)。 */
export function signKeyIdFor(unitId: string): string {
  return `${unitId}-sign-1`
}

/** 读本机单位签发密钥;无单位行返回 null。 */
export function readUnitSignKeyOrNull(): UnitSignKey | null {
  const row = getDb()
    .prepare('SELECT id, public_key_jwk AS pub, private_key_jwk AS priv FROM unit LIMIT 1')
    .get() as { id: string; pub: string; priv: string | null } | undefined
  if (!row) return null
  return {
    unitId: row.id,
    publicKeyJwk: JSON.parse(row.pub) as Jwk,
    privateKeyJwk: row.priv ? (JSON.parse(row.priv) as Jwk) : null
  }
}

/** 读本机单位签发密钥;缺失即抛。 */
export function readUnitSignKey(): UnitSignKey {
  const key = readUnitSignKeyOrNull()
  if (!key) throw new Error('未找到单位签发密钥，请重新激活')
  return key
}
