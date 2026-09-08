/**
 * 下级授权(.dysd)签发与台账(delegation 表,schema v8)——仅 level1。
 *
 * 依赖单位证书(.dysc):未导入则拒绝签发(信任链缺锚,二三级无法验证)。
 * 有效期被 unit_cert.not_after 封顶(级联到期,dual-mode/12 §3.1);
 * 续期后按台账批量重签(§4),keyId 不变,历史 .dyf 与已导入数据不受影响。
 */
import { randomUUID } from 'crypto'
import { writeFileSync } from 'fs'
import { issueDelegatedLicense } from '@sces/shared/license'
import type {
  DelegatedApplyKey,
  DelegatedLicenseFile,
  DelegatedRole,
  LicenseScope
} from '@sces/shared/license'
import type { UnitConfig } from '@sces/shared'
import JSZip from 'jszip'
import { getDb } from '../db'
import { writeAudit } from './audit'
import { assertWritable } from './license'
import { listApplyKeysForDelegation } from './apply-key'
import { getTemplate } from './config-template'
import { listBatches } from './batch'
import { getUnitCertOrNull } from './unit-cert-store'
import { readUnitSignKey } from './unit-keys'
import { assertLevel1 } from './role'
import type { DelegationReadiness, DelegationRecord } from '../../preload/types'

interface DelegationRow {
  delegationId: string
  role: string
  scopeJson: string
  holderLabel: string | null
  boundFingerprint: string | null
  expiresAt: number
  issuedAt: number
  reissuedAt: number | null
  revokedAt: number | null
  fileJson: string | null
  scopeKey: string | null
}

interface PackageEntry {
  delegationId: string
  role: DelegatedRole
  scope: LicenseScope
  fileJson: string
}

const SELECT = `delegation_id AS delegationId, role, scope_json AS scopeJson, holder_label AS holderLabel,
  bound_fingerprint AS boundFingerprint, expires_at AS expiresAt, issued_at AS issuedAt,
  reissued_at AS reissuedAt, revoked_at AS revokedAt, file_json AS fileJson, scope_key AS scopeKey`

function rowToRecord(r: DelegationRow): DelegationRecord {
  return {
    delegationId: r.delegationId,
    role: r.role === 'level2' ? 'level2' : 'level3',
    scope: JSON.parse(r.scopeJson) as LicenseScope,
    holderLabel: r.holderLabel,
    boundFingerprint: r.boundFingerprint,
    expiresAt: r.expiresAt,
    issuedAt: r.issuedAt,
    reissuedAt: r.reissuedAt,
    revokedAt: r.revokedAt,
    exportable: Boolean(r.fileJson)
  }
}

function configuredClassValues(config: UnitConfig): string[] {
  const result: string[] = []
  const walk = (
    nodes: Array<{ value: string; children?: Array<{ value: string; children?: unknown[] }> }>
  ): void => {
    for (const node of nodes) {
      const children = Array.isArray(node.children) ? node.children : []
      if (children.length)
        walk(
          children as Array<{
            value: string
            children?: Array<{ value: string; children?: unknown[] }>
          }>
        )
      else if (node.value) result.push(String(node.value))
    }
  }
  walk(
    config.class.options as Array<{
      value: string
      children?: Array<{ value: string; children?: unknown[] }>
    }>
  )
  return Array.from(new Set(result))
}

function safeFilePart(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_').slice(0, 50) || '授权'
}

function delegationScopeKey(role: DelegatedRole, scope: LicenseScope): string {
  return `${role}|${scope.grade || ''}|${scope.class || ''}`
}

function existingDelegationId(
  unitId: string,
  role: DelegatedRole,
  scope: LicenseScope
): string | null {
  const row = getDb()
    .prepare(
      'SELECT delegation_id AS delegationId FROM delegation WHERE unit_id = ? AND scope_key = ?'
    )
    .get(unitId, delegationScopeKey(role, scope)) as { delegationId: string } | undefined
  return row ? row.delegationId : null
}

/** 台账单条导出的用户友好文件名，包含年级以避免不同年级同名班级冲突。 */
export function getDelegationFileName(delegationId: string): string {
  const row = getDb()
    .prepare('SELECT role, scope_json AS scopeJson FROM delegation WHERE delegation_id = ?')
    .get(delegationId) as { role: string; scopeJson: string } | undefined
  if (!row) return `${safeFilePart(delegationId)}.dysd`
  let scope: LicenseScope = {}
  try {
    scope = JSON.parse(row.scopeJson) as LicenseScope
  } catch {
    return `${safeFilePart(delegationId)}.dysd`
  }
  if (row.role === 'level2' && scope.grade) {
    return `${safeFilePart(scope.grade)}年级授权.dysd`
  }
  if (row.role === 'level3' && scope.grade && scope.class) {
    return `${safeFilePart(scope.grade)}级-${safeFilePart(scope.class)}授权.dysd`
  }
  if (scope.class) return `${safeFilePart(scope.class)}授权.dysd`
  if (scope.grade) return `${safeFilePart(scope.grade)}年级授权.dysd`
  return `${safeFilePart(delegationId)}.dysd`
}

/** 输出“总包 -> 年级 zip -> 年级授权 + 各班授权”的嵌套压缩包。 */
async function writeDelegationPackage(entries: PackageEntry[], exportPath: string): Promise<void> {
  const outer = new JSZip()
  const byGrade = new Map<string, PackageEntry[]>()
  for (const entry of entries) {
    const grade = entry.scope.grade || '未标年级'
    const list = byGrade.get(grade) || []
    list.push(entry)
    byGrade.set(grade, list)
  }
  for (const [grade, gradeEntries] of byGrade) {
    const gradeZip = new JSZip()
    const level2 = gradeEntries.find((entry) => entry.role === 'level2')
    if (level2) gradeZip.file(`${safeFilePart(grade)}年级授权.dysd`, level2.fileJson)
    for (const entry of gradeEntries
      .filter((item) => item.role === 'level3')
      .sort((a, b) => String(a.scope.class).localeCompare(String(b.scope.class)))) {
      gradeZip.file(`${safeFilePart(String(entry.scope.class))}班授权.dysd`, entry.fileJson)
    }
    const gradeBuffer = await gradeZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    outer.file(`${safeFilePart(grade)}年级授权.zip`, gradeBuffer)
  }
  const buffer = await outer.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  writeFileSync(exportPath, buffer)
}

/** 单位配置模板 id(签发时装入 .dysd 机密段)。 */
function unitConfigTemplateId(): string {
  const row = getDb().prepare('SELECT config_template_id AS id FROM unit LIMIT 1').get() as
    { id: string | null } | undefined
  if (!row?.id) throw new Error('未找到单位配置,无法签发下级授权')
  return row.id
}

/** 是否已导入单位证书(渲染层据此启用"签发下级授权")。 */
export function getDelegationReadiness(): DelegationReadiness {
  const cert = getUnitCertOrNull()
  const batchCount = listBatches().filter((batch) => batch.status !== 'draft').length
  return cert ? { ready: true, notAfter: cert.notAfter, batchCount } : { ready: false, batchCount }
}

/** 台账列表(签发时间倒序)。 */
export function listDelegations(): DelegationRecord[] {
  const rows = getDb()
    .prepare(`SELECT ${SELECT} FROM delegation ORDER BY issued_at DESC`)
    .all() as DelegationRow[]
  return rows.map(rowToRecord)
}

/** 共用签发核心:校验证书/私钥/有效期上限,产出 .dysd 文件对象(不落台账、不写盘)。 */
async function signDelegation(params: {
  delegationId: string
  role: DelegatedRole
  scope: LicenseScope
  boundFingerprint: string | null
  expiresAt: number
  password: string
}): Promise<DelegatedLicenseFile> {
  if (params.role === 'level2') {
    if (!/^\d{4}$/.test(String(params.scope.grade || '')) || params.scope.class) {
      throw new Error('年级授权必须包含四位年级信息，且不能带班级范围')
    }
  } else if (!/^\d{4}$/.test(String(params.scope.grade || '')) || !params.scope.class) {
    throw new Error('班级授权必须同时包含四位年级和班级信息')
  }
  const cert = getUnitCertOrNull()
  if (!cert) {
    throw new Error('请先导入单位证书(.dysc):导出公钥包 → 服务商回传证书后导入,方可签发下级授权')
  }
  if (params.expiresAt <= Date.now()) {
    throw new Error('下级授权有效期必须晚于当前时间（不能签发已过期的授权）')
  }
  if (params.expiresAt > cert.notAfter) {
    throw new Error(
      `下级授权有效期不能超过单位授权到期日(${new Date(cert.notAfter).toLocaleDateString('zh-CN')})`
    )
  }
  const unit = readUnitSignKey()
  if (!unit.privateKeyJwk) throw new Error('本机无单位签发私钥,无法签发下级授权')
  const configTemplate: UnitConfig | null = getTemplate(unitConfigTemplateId())
  if (!configTemplate) throw new Error('未找到单位配置,无法签发下级授权')
  const applyKeys: DelegatedApplyKey[] = listApplyKeysForDelegation()
  if (applyKeys.length === 0) throw new Error('未找到单位申请密钥,无法签发下级授权')
  // 随授权下发一级已创建的批次快照（草稿不下发）：二三级不能自建批次，靠此获得可导入的批次。
  const batches = listBatches().filter((b) => b.status !== 'draft')
  return issueDelegatedLicense({
    delegationId: params.delegationId,
    unitId: unit.unitId,
    role: params.role,
    scope: params.scope,
    issuedAt: Date.now(),
    expiresAt: params.expiresAt,
    boundFingerprint: params.boundFingerprint,
    signKeyId: cert.signKeyId,
    unitCert: cert.cert,
    secret: { configTemplate, applyKeys, batches },
    password: params.password,
    signPrivateKeyJwk: unit.privateKeyJwk
  })
}

/**
 * 按年级签发授权包：每个年级生成一份 level2 年级授权，并自动为配置中的每个班级生成
 * 带 grade + class 范围的 level3 授权；最终生成一个总 zip，内部按年级包含子 zip。
 */
export async function issueDelegationsBatch(
  input: { grades: string[]; holderLabel?: string; expiresAt: number; password: string },
  exportPath: string
): Promise<{ grades: number; classes: number; path: string }> {
  assertWritable()
  assertLevel1('delegation.issue-batch')
  const grades = Array.from(
    new Set(
      input.grades.map((grade) => String(grade).trim()).filter((grade) => /^\d{4}$/.test(grade))
    )
  )
  if (!grades.length) throw new Error('未选择有效年级（年级应为四位数字）')
  const unit = readUnitSignKey()
  const configTemplate = getTemplate(unitConfigTemplateId())
  if (!configTemplate) throw new Error('未找到单位配置，无法生成班级授权')
  const classes = configuredClassValues(configTemplate)
  if (!classes.length) throw new Error('单位配置未定义班级，无法生成班级授权')
  const classCount = classes.length * grades.length
  const now = Date.now()
  const insert = getDb().prepare(
    `INSERT INTO delegation
       (delegation_id, unit_id, role, scope_json, scope_key, holder_label, bound_fingerprint, expires_at, issued_at, reissued_at, revoked_at, file_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT(unit_id, scope_key) DO UPDATE SET
       role = excluded.role,
       scope_json = excluded.scope_json,
       holder_label = excluded.holder_label,
       bound_fingerprint = excluded.bound_fingerprint,
       expires_at = excluded.expires_at,
       reissued_at = excluded.reissued_at,
       revoked_at = NULL,
       file_json = excluded.file_json`
  )
  const records: Array<{
    delegationId: string
    role: DelegatedRole
    scope: LicenseScope
    fileJson: string
  }> = []
  const packageEntries: PackageEntry[] = []
  for (const grade of grades) {
    const gradeScope = { grade }
    const gradeDelegationId =
      existingDelegationId(unit.unitId, 'level2', gradeScope) || `D-${randomUUID()}`
    const gradeFile = await signDelegation({
      delegationId: gradeDelegationId,
      role: 'level2',
      scope: gradeScope,
      boundFingerprint: null,
      expiresAt: input.expiresAt,
      password: input.password
    })
    const gradeJson = JSON.stringify(gradeFile, null, 2)
    records.push({
      delegationId: gradeDelegationId,
      role: 'level2',
      scope: gradeScope,
      fileJson: gradeJson
    })
    packageEntries.push({
      delegationId: gradeDelegationId,
      role: 'level2',
      scope: gradeScope,
      fileJson: gradeJson
    })
    for (const className of classes) {
      const scope = { grade, class: className }
      const delegationId = existingDelegationId(unit.unitId, 'level3', scope) || `D-${randomUUID()}`
      const file = await signDelegation({
        delegationId,
        role: 'level3',
        scope,
        boundFingerprint: null,
        expiresAt: input.expiresAt,
        password: input.password
      })
      const fileJson = JSON.stringify(file, null, 2)
      records.push({ delegationId, role: 'level3', scope, fileJson })
      packageEntries.push({ delegationId, role: 'level3', scope, fileJson })
    }
  }
  // 先落台账（SQLite 事务），成功后再写 zip——避免“有授权文件、无台账记录”的孤儿。
  // 台账是后续重签/作废/导出的依据；写盘失败时台账快照（file_json）仍完整，
  // 用户可用“重新导出/批量导出”从台账再生 zip，无需删除台账行
  // （delegation_id 按 scope 复用，删除会误伤此前有效记录）。
  const tx = getDb().transaction(() => {
    for (const record of records) {
      insert.run(
        record.delegationId,
        unit.unitId,
        record.role,
        JSON.stringify(record.scope),
        delegationScopeKey(record.role, record.scope),
        input.holderLabel ?? null,
        null,
        input.expiresAt,
        now,
        now,
        record.fileJson
      )
    }
  })
  tx()
  await writeDelegationPackage(packageEntries, exportPath)
  writeAudit({
    operator: 'level1',
    role: 'level1',
    scope: 'unit',
    action: 'delegation.issue-batch',
    target: 'unit',
    detail: {
      grades: grades.length,
      classes: classCount,
      issued: records.length,
      expiresAt: input.expiresAt,
      path: exportPath
    }
  })
  return { grades: grades.length, classes: classCount, path: exportPath }
}

/**
 * 续期后批量重签(dual-mode/12 §4):导入新 .dysc 后,按台账逐条重签未作废项,
 * 有效期级联延到单位新到期日(cert.notAfter),keyId 不变;统一用新口令,导出到目录。
 */
export async function reissueDelegations(
  input: { password: string },
  exportPath: string
): Promise<{ reissued: number; path: string }> {
  assertWritable()
  assertLevel1('delegation.reissue')
  const cert = getUnitCertOrNull()
  if (!cert) throw new Error('请先导入新的单位证书(.dysc)后再批量重签')
  const rows = getDb()
    .prepare(`SELECT ${SELECT} FROM delegation WHERE revoked_at IS NULL ORDER BY issued_at`)
    .all() as DelegationRow[]
  const now = Date.now()
  const entries: PackageEntry[] = []
  for (const record of rows.map(rowToRecord)) {
    const file = await signDelegation({
      delegationId: record.delegationId,
      role: record.role,
      scope: record.scope,
      boundFingerprint: record.boundFingerprint,
      expiresAt: cert.notAfter,
      password: input.password
    })
    const fileJson = JSON.stringify(file, null, 2)
    entries.push({
      delegationId: record.delegationId,
      role: record.role,
      scope: record.scope,
      fileJson
    })
  }
  await writeDelegationPackage(entries, exportPath)
  const update = getDb().prepare(
    'UPDATE delegation SET expires_at = ?, reissued_at = ?, file_json = ? WHERE delegation_id = ?'
  )
  const tx = getDb().transaction(() => {
    for (const entry of entries) update.run(cert.notAfter, now, entry.fileJson, entry.delegationId)
  })
  tx()
  writeAudit({
    operator: 'level1',
    role: 'level1',
    scope: 'unit',
    action: 'delegation.reissue',
    target: cert.unitId,
    detail: { count: entries.length, notAfter: cert.notAfter, path: exportPath }
  })
  return { reissued: entries.length, path: exportPath }
}

/** 从台账导出一份授权文件原文；不重新签发，也不需要原口令。 */
export function exportDelegationFile(delegationId: string, exportPath: string): string {
  assertWritable()
  assertLevel1('delegation.export')
  const row = getDb()
    .prepare('SELECT file_json AS fileJson FROM delegation WHERE delegation_id = ?')
    .get(delegationId) as { fileJson: string | null } | undefined
  if (!row) throw new Error('未找到该下级授权记录')
  if (!row.fileJson) throw new Error('该授权记录没有文件快照，请重新签发或批量重签后再导出')
  writeFileSync(exportPath, row.fileJson, 'utf-8')
  writeAudit({
    operator: 'level1',
    role: 'level1',
    scope: 'unit',
    action: 'delegation.export',
    target: delegationId,
    detail: { path: exportPath }
  })
  return exportPath
}

/** 将选中的授权文件快照打包导出，文件名使用可读范围名称。 */
export async function exportDelegationFiles(
  delegationIds: string[],
  exportPath: string
): Promise<string> {
  assertWritable()
  assertLevel1('delegation.export-many')
  const ids = Array.from(new Set(delegationIds.map((id) => String(id).trim()).filter(Boolean)))
  if (!ids.length) throw new Error('请至少选择一条授权记录')
  const placeholders = ids.map(() => '?').join(',')
  const rows = getDb()
    .prepare(
      `SELECT delegation_id AS delegationId, file_json AS fileJson FROM delegation WHERE delegation_id IN (${placeholders})`
    )
    .all(...ids) as Array<{ delegationId: string; fileJson: string | null }>
  if (rows.length !== ids.length) throw new Error('部分授权记录不存在，请刷新台账后重试')
  const missing = rows.filter((row) => !row.fileJson)
  if (missing.length) throw new Error('部分授权没有文件快照，请重新签发或批量重签后再导出')
  const zip = new JSZip()
  for (const row of rows) zip.file(getDelegationFileName(row.delegationId), row.fileJson as string)
  writeFileSync(exportPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  writeAudit({
    operator: 'level1',
    role: 'level1',
    scope: 'unit',
    action: 'delegation.export-many',
    target: 'unit',
    detail: { count: rows.length, delegationIds: ids, path: exportPath }
  })
  return exportPath
}

/**
 * 本地作废(离线无法真正吊销):仅打台账标记 + 审计,不影响已发出的文件。
 * UI 必须如实说明这一点。
 */
export function revokeDelegation(delegationId: string): void {
  assertWritable()
  assertLevel1('delegation.revoke')
  const res = getDb()
    .prepare('UPDATE delegation SET revoked_at = ? WHERE delegation_id = ? AND revoked_at IS NULL')
    .run(Date.now(), delegationId)
  if (res.changes === 0) throw new Error('未找到该下级授权,或已作废')
  writeAudit({
    operator: 'level1',
    role: 'level1',
    scope: 'unit',
    action: 'delegation.revoke',
    target: delegationId
  })
}

/** 批量本地作废；已作废记录保持幂等，不重复计数。 */
export function revokeDelegations(delegationIds: string[]): { revoked: number } {
  assertWritable()
  assertLevel1('delegation.revoke-many')
  const ids = Array.from(new Set(delegationIds.map((id) => String(id).trim()).filter(Boolean)))
  if (!ids.length) throw new Error('请至少选择一条授权记录')
  const placeholders = ids.map(() => '?').join(',')
  const result = getDb()
    .prepare(
      `UPDATE delegation SET revoked_at = ? WHERE delegation_id IN (${placeholders}) AND revoked_at IS NULL`
    )
    .run(Date.now(), ...ids)
  writeAudit({
    operator: 'level1',
    role: 'level1',
    scope: 'unit',
    action: 'delegation.revoke-many',
    target: 'unit',
    detail: { requested: ids.length, revoked: result.changes, delegationIds: ids }
  })
  return { revoked: result.changes }
}
