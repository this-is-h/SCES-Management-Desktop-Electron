/**
 * 单位证书(unit_cert 表,schema v8)访问层。
 *
 * `.dysc` 由服务商签发,是二三级授权的信任锚;一级导入后方可签发下级授权。
 * `cert_json` 存 `.dysc` 全文,签发 `.dysd` 时逐字节内嵌(dual-mode/12 §2.1)。
 */
import { asUnitCert } from '@sces/shared/license'
import type { UnitCertFile } from '@sces/shared/license'
import { getDb } from '../db'

/** 本机单位证书(读库还原 `.dysc` 全文)。 */
export interface StoredUnitCert {
  unitId: string
  licenseId: string
  signKeyId: string
  applyKeyId: string
  notAfter: number
  cert: UnitCertFile
}

/** 落库单位证书(导入 `.dysc` 时;INSERT OR REPLACE,一单位一份)。 */
export function upsertUnitCert(cert: UnitCertFile): void {
  const p = cert.payload
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO unit_cert
         (unit_id, license_id, sign_key_id, apply_key_id, not_after, cert_json, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(p.unitId, p.licenseId, p.signKey.keyId, p.applyKey.keyId, p.notAfter, JSON.stringify(cert), Date.now())
}

/** 读本机单位证书;未导入返回 null。 */
export function getUnitCertOrNull(): StoredUnitCert | null {
  const row = getDb()
    .prepare(
      `SELECT unit_id AS unitId, license_id AS licenseId, sign_key_id AS signKeyId,
              apply_key_id AS applyKeyId, not_after AS notAfter, cert_json AS certJson
       FROM unit_cert LIMIT 1`
    )
    .get() as
    | {
        unitId: string
        licenseId: string
        signKeyId: string
        applyKeyId: string
        notAfter: number
        certJson: string
      }
    | undefined
  if (!row) return null
  return {
    unitId: row.unitId,
    licenseId: row.licenseId,
    signKeyId: row.signKeyId,
    applyKeyId: row.applyKeyId,
    notAfter: row.notAfter,
    cert: asUnitCert(JSON.parse(row.certJson))
  }
}
