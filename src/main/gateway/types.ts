/**
 * AdminGateway：管理端一切"外部权威"操作的抽象层。
 *
 * 设计目标（dual-mode/02-mode-switch.md、13-flow-symmetry.md）：业务服务层
 * （services/**）**永不**读 __DMS_MODE__；两模式的差异全部落在本抽象的两份实现里
 * （offline.ts / online.ts）。调用点在两模式下是**同一份代码**，只是拿到的实现不同。
 *
 * - offline：本地即权威（验签授权文件、no-op 上报、导出 .dysk/.dysr 文件）。
 * - online：服务端为权威（HTTP 授权、Bearer 上报）。
 */
import type { ApplyStatus, Batch, BatchStatus, Jwk, UnitConfig } from '@sces/shared'
import type { DysFileType, LicenseRole, LicenseScope, UnitCertFile, UnitRef } from '@sces/shared/license'

/** 激活输入：一级用授权码（online）或授权文件（offline）；二三级恒为授权文件（.dysd）。 */
export type ActivateInput =
  | { kind: 'license-code'; code: string; serverUrl?: string }
  | { kind: 'license-file'; filePath: string; password: string }

/** 单位申请密钥材料（RSA-OAEP，学生 .dyf 加解密用）。 */
export interface ApplyKeyMaterial {
  keyId: string
  publicKeyJwk: Jwk
  privateKeyJwk: Jwk
  /** 是否当前密钥(新批次加密对接);.dysd 下发多把时用于标记。 */
  current?: boolean
}

/**
 * 激活结果：两模式返回同一形状。
 * `applyKeys` 仅二三级（.dysd 下发，M-O1B）携带；一级为 undefined → 由 unit.ts 本地生成。
 */
export interface ActivateResult {
  unit: UnitRef
  configTemplate: UnitConfig
  expiresAt: number
  role: LicenseRole
  scope: LicenseScope
  /** 授权权威方：本地验签 / 服务端核验。 */
  authority: 'local' | 'server'
  /** 一级 .dysl 的授权 id。 */
  licenseId?: string
  /** 二三级 .dysd 的下级授权 id（M-O1B）。 */
  delegationId?: string
  /** 验签所用的服务商签名密钥 id。 */
  signKeyId?: string
  /** 绑定的机器码；null = 浮动授权。 */
  boundFingerprint?: string | null
  /** online：unitToken（决策 #29）。 */
  unitToken?: string
  /** 二三级:随 .dysd 下发的申请密钥(含私钥);一级 undefined。 */
  applyKeys?: ApplyKeyMaterial[]
  /** 二三级:.dysd 内嵌的单位证书,落 unit_cert 表(信任锚);一级 undefined。 */
  unitCert?: UnitCertFile
  /** 二三级:.dysd 下发的一级批次快照,落 batch 表(二三级不能自建批次);一级 undefined。 */
  batches?: Batch[]
}

/** 授权文件预览（验签 + 读 header，不需口令）：激活页第一步用。online 无文件 → null。 */
export interface LicenseFilePreview {
  type: DysFileType
  unitId: string
  unitName: string
  role: LicenseRole
  scope: LicenseScope
  expiresAt: number
  boundFingerprint: string | null
  signKeyId: string
}

/** 公钥交付结果：online = HTTP POST；offline = 导出 .dysk 文件。 */
export interface PublishPubkeyResult {
  transport: 'http' | 'file'
  /** offline 导出到的 .dysk 路径（未导出时 undefined）。 */
  path?: string
  exported: boolean
}

/** 换机结果：online = 服务端换新码；offline = 导出 .dysr 文件交服务商。 */
export interface RebindResult {
  transport: 'http' | 'file'
  /** offline 导出的 .dysr 路径。 */
  path?: string
  /** 面向用户的中文提示。 */
  message: string
}

/** 远端授权状态（fetchLicenseStatus）。offline 恒返回 null（"远端无话可说"）。 */
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

/** 批量申请状态上报（整班确认，决策 #32）。 */
export interface ApplyStatusesReport {
  batchId: string
  status: ApplyStatus
  applyIds: string[]
}

/** 批量上报结果。offline 全部 ok、authority='local'。 */
export interface ApplyStatusesResult {
  succeeded: number
  failed: number
  results: Array<{ applyId: string; ok: boolean; authority: 'local' | 'server' }>
}

/**
 * 管理端网关：两份实现（offline.ts / online.ts）都 `satisfies AdminGateway`，
 * 保证方法集与返回类型完全一致（对称性由类型系统钉住，见 13 §4）。
 */
export interface AdminGateway {
  readonly mode: 'offline' | 'online'

  /** 激活：offline 验签授权文件；online POST /authorize。 */
  activate(input: ActivateInput): Promise<ActivateResult>

  /** 授权文件预览（验签 + 读 header，不解封）：offline 返回预览；online 返回 null。 */
  inspectLicenseFile(filePath: string): Promise<LicenseFilePreview | null>

  /**
   * 交付单位申请公钥：online POST /units/{id}/public-key；
   * offline 在 `exportPath` 提供时导出 .dysk 公钥包（单位签发私钥自签），否则不动作。
   */
  publishUnitPublicKey(opts?: { exportPath?: string }): Promise<PublishPubkeyResult>

  /** 申请换机：online 服务端换码；offline 导出 .dysr。 */
  requestRebind(newFingerprint: string, reason: string, exportPath?: string): Promise<RebindResult>

  /** 拉取远端授权状态：offline 返回 null（回落本地 expiresAt）。 */
  fetchLicenseStatus(): Promise<RemoteLicenseStatus | null>

  /** 上报批次公开信息：offline no-op。 */
  publishBatch(batch: BatchPublicInput): Promise<void>

  /** 上报批次状态迁移：offline no-op。 */
  publishBatchStatus(batchId: string, status: BatchStatus): Promise<void>

  /** 上报单个申请状态：offline no-op。 */
  publishApplyStatus(input: ApplyStatusReport): Promise<void>

  /** 批量上报申请状态：offline 全 ok（authority='local'）。 */
  publishApplyStatuses(input: ApplyStatusesReport): Promise<ApplyStatusesResult>

  /** 发起新一轮审核：offline no-op（轮次只在本地推进）。 */
  openReviewRound(applyId: string, reason?: string): Promise<void>

  /** 解析当前单位申请密钥（批次创建时取，跨批次复用）。两模式都读本地 apply_key。 */
  resolveApplyKey(): Promise<ApplyKeyMaterial>
}
