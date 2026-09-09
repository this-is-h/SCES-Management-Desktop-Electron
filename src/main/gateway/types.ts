/**
 * AdminGateway：管理端一切"外部权威"操作的抽象层。
 *
 * 在线版唯一实现（gateway/online.ts）：激活走服务端授权码，批次/状态/授权状态经 HTTP 同步，
 * 申请密钥本地持有（apply_key，解密历史 .dyf；公钥随激活即时上报）。离线授权链已移除。
 */
import type { ApplyStatus, BatchStatus, Jwk, UnitConfig } from '@sces/shared'

/** 单位引用（激活响应）。 */
export interface UnitRef {
  unitId: string
  name: string
  unitType: string
  parentUnit?: { unitId: string; name: string }
}

/** 单位申请密钥材料（RSA-OAEP，学生 .dyf 加解密用）。 */
export interface ApplyKeyMaterial {
  keyId: string
  publicKeyJwk: Jwk
  privateKeyJwk: Jwk
  /** 是否当前密钥（新批次加密对接）。 */
  current?: boolean
}

/** 激活结果（服务端核验授权码下发）。 */
export interface ActivateResult {
  unit: UnitRef
  configTemplate: UnitConfig
  expiresAt: number
  role: 'level1'
  scope: Record<string, never>
  authority: 'server'
  /** 服务端授权码对应的授权 id。 */
  licenseId?: string
  /** 写接口 Bearer 凭证（绑定 unitId + installId）。 */
  unitToken?: string
}

/** 换机结果（服务端受理换机申请）。 */
export interface RebindResult {
  /** 面向用户的中文提示。 */
  message: string
}

/** 远端授权状态（fetchLicenseStatus）。 */
export interface RemoteLicenseStatus {
  status: 'active' | 'expired' | 'revoked'
  expiresAt?: number
  notAfter?: number
}

/** 批次公开信息（publishBatch 上报，学生端可见字段）。 */
export interface BatchPublicInput {
  batchId: string
  unitId: string
  year: number
  semester: number
  isTest: boolean
  keyId: string
  publicKeyJwk: Jwk
  applyStartAt?: number
  applyEndAt?: number
}

/** 单个申请状态上报（导入成功 / 开始审核）。 */
export interface ApplyStatusReport {
  applyId: string
  batchId: string
  status: ApplyStatus
  revision?: number
}

/** 批量申请状态上报（整班确认）。 */
export interface ApplyStatusesReport {
  batchId: string
  status: ApplyStatus
  applyIds: string[]
}

/** 批量上报结果。 */
export interface ApplyStatusesResult {
  succeeded: number
  failed: number
  results: Array<{ applyId: string; ok: boolean; authority: 'server' }>
}

/**
 * 管理端网关（在线版实现 online.ts `satisfies AdminGateway`）。
 */
export interface AdminGateway {
  readonly mode: 'online'

  /** 激活：POST /authorize 核验授权码。 */
  activate(input: { code: string }): Promise<ActivateResult>

  /** 交付单位申请公钥（当前 apply_key 公钥）：POST /units/{id}/public-key。 */
  publishUnitPublicKey(): Promise<void>

  /** 申请换机：POST /units/rebind（新机以新 installId 重新激活后由服务端放行）。 */
  requestRebind(reason: string): Promise<RebindResult>

  /** 拉取远端授权状态：失败返回 null（回落本地 expiresAt）。 */
  fetchLicenseStatus(): Promise<RemoteLicenseStatus | null>

  /** 上报批次公开信息。 */
  publishBatch(batch: BatchPublicInput): Promise<void>

  /** 上报批次状态迁移。 */
  publishBatchStatus(batchId: string, status: BatchStatus): Promise<void>

  /** 上报单个申请状态。 */
  publishApplyStatus(input: ApplyStatusReport): Promise<void>

  /** 批量上报申请状态。 */
  publishApplyStatuses(input: ApplyStatusesReport): Promise<ApplyStatusesResult>

  /** 发起新一轮审核。 */
  openReviewRound(applyId: string, reason?: string): Promise<void>

  /** 解析当前单位申请密钥（批次创建时取，跨批次复用）。读本地 apply_key。 */
  resolveApplyKey(): Promise<ApplyKeyMaterial>
}
