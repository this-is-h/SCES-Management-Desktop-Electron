/**
 * 在线网关：服务端为权威（路径以 SCES-Server/contracts/openapi.yaml 为准）。
 * 激活走授权码（POST /authorize），身份 = unitToken Bearer + X-Unit-Id/X-Install-Id；
 * 申请密钥本地持有，公钥随激活即时上报（接口 2）。
 */
import { is } from '@electron-toolkit/utils'
import type { BatchStatus, UnitConfig } from '@sces/shared'
import { getActiveAccount } from '../services/accounts'
import { getInstallId } from '../services/license'
import { getSetting } from '../services/settings'
import { getCurrentApplyKey } from '../services/apply-key'
import type {
  ActivateResult,
  AdminGateway,
  ApplyKeyMaterial,
  ApplyStatusReport,
  ApplyStatusesReport,
  ApplyStatusesResult,
  BatchPublicInput,
  RebindResult,
  RemoteLicenseStatus
} from './types'

/** 服务端地址：开发模式可配置（settings 或默认本地），生产模式编译进安装包。 */
function serverUrl(): string {
  if (is.dev) return getSetting('serverUrl') ?? 'http://127.0.0.1:3000'
  return __DMS_SERVER_URL__
}

/** 统一请求头：身份标识 + unitToken Bearer。 */
function authHeaders(): Record<string, string> {
  const acc = getActiveAccount()
  const token = getSetting('activation')?.unitToken
  return {
    'Content-Type': 'application/json',
    ...(acc ? { 'X-Unit-Id': acc.unitId } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'X-Install-Id': getInstallId()
  }
}

/** 统一 POST，把网络/HTTP/业务错误翻译成对用户友好的中文。 */
async function post<T>(path: string, body: unknown): Promise<T> {
  let resp: Response
  try {
    resp = await fetch(`${serverUrl()}${path}`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body)
    })
  } catch {
    throw new Error('无法连接服务端，请检查网络或稍后重试')
  }

  let json: { ok: boolean; data?: T; error?: string } | undefined
  try {
    json = (await resp.json()) as { ok: boolean; data?: T; error?: string }
  } catch {
    json = undefined
  }

  if (!resp.ok || !json || json.ok === false) {
    const bizError = json?.error?.trim()
    if (bizError) throw new Error(bizError)
    if (resp.status === 404) throw new Error('服务端未提供该功能，请升级服务端')
    if (resp.status === 401 || resp.status === 403) throw new Error('授权校验未通过，请重新激活')
    if (resp.status === 429) throw new Error('操作过于频繁，请稍后再试')
    if (resp.status >= 500) throw new Error('服务端异常，请稍后重试')
    throw new Error('请求失败，请稍后重试')
  }
  return json.data as T
}

/** GET（fetchLicenseStatus 用）。失败返回 null（回落本地），不抛。 */
async function getJson<T>(path: string): Promise<T | null> {
  try {
    const resp = await fetch(`${serverUrl()}${path}`, { headers: authHeaders() })
    if (!resp.ok) return null
    const json = (await resp.json()) as { ok: boolean; data?: T }
    return json.ok ? (json.data ?? null) : null
  } catch {
    return null
  }
}

/** /authorize 响应数据（接口 1）。 */
interface AuthorizeData {
  unit: { unitId: string; unitName: string; unitType: string }
  configTemplate: UnitConfig
  expiresAt: number
  licenseId?: string
  unitToken?: string
}

export const onlineGateway: AdminGateway = {
  mode: 'online',

  async activate(input: { code: string }): Promise<ActivateResult> {
    const code = input.code.trim()
    if (!code) throw new Error('授权码不能为空')
    const data = await post<AuthorizeData>('/api/v1/authorize', { code })
    return {
      unit: {
        unitId: data.unit.unitId,
        name: data.unit.unitName,
        unitType: data.unit.unitType
      },
      configTemplate: data.configTemplate,
      expiresAt: data.expiresAt,
      role: 'level1',
      scope: {},
      authority: 'server',
      licenseId: data.licenseId,
      unitToken: data.unitToken
    }
  },

  async publishUnitPublicKey(): Promise<void> {
    const acc = getActiveAccount()
    const applyKey = getCurrentApplyKey()
    await post(`/api/v1/units/${acc?.unitId ?? ''}/public-key`, {
      keyId: applyKey.keyId,
      publicKeyJwk: applyKey.publicKeyJwk
    })
  },

  async requestRebind(reason: string): Promise<RebindResult> {
    await post('/api/v1/units/rebind', { reason })
    return { message: '换机申请已提交，服务端将签发新授权码' }
  },

  async fetchLicenseStatus(): Promise<RemoteLicenseStatus | null> {
    return getJson<RemoteLicenseStatus>('/api/v1/license/status')
  },

  async publishBatch(batch: BatchPublicInput): Promise<void> {
    await post('/api/v1/batches', batch)
  },

  async publishBatchStatus(batchId: string, status: BatchStatus): Promise<void> {
    await post(`/api/v1/batches/${batchId}/status`, { status })
  },

  async publishApplyStatus(input: ApplyStatusReport): Promise<void> {
    await post(`/api/v1/applies/${input.applyId}/status`, {
      batchId: input.batchId,
      status: input.status,
      revision: input.revision
    })
  },

  async publishApplyStatuses(input: ApplyStatusesReport): Promise<ApplyStatusesResult> {
    return post<ApplyStatusesResult>(`/api/v1/batches/${input.batchId}/apply-statuses`, {
      status: input.status,
      applyIds: input.applyIds
    })
  },

  async openReviewRound(applyId: string, reason?: string): Promise<void> {
    await post(`/api/v1/applies/${applyId}/review-rounds`, { reason })
  },

  async resolveApplyKey(): Promise<ApplyKeyMaterial> {
    return getCurrentApplyKey()
  }
}
