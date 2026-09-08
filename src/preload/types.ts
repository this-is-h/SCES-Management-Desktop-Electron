/**
 * preload 白名单 API 的类型契约：渲染进程通过 window.api 访问。
 * 输入/输出类型与主进程服务对齐，供 index.ts（实现）与 index.d.ts（全局声明）复用。
 */
import type { ApplyStatus, AuditLog, Batch, ClassCascader, ConfirmLevel, TimelineEvent } from '@sces/shared'
import type { UpdateCheckResult } from '../main/services/updater'
export type { UpdateCheckResult }

/** 单位信息（渲染进程可见，不含私钥）。 */
export interface UnitInfo {
  id: string
  name: string
  unitType: string
  createdAt: number
  /** 一级单位（学校）名称——完整单位名 = parentUnitName + name（issue #3）。 */
  parentUnitName?: string
  parentUnitId?: string
}

/** 账号索引条目（侧边栏切换列表用）。账号身份 = accountId（与单位解耦）。 */
export interface AccountInfo {
  /** 账号 id（一级=unitId；二三级=unitId__role__scopeHash）。 */
  accountId: string
  /** 所属单位 id。 */
  unitId: string
  name: string
  /** 一级单位（学校）名称——完整单位名 = parentUnitName + name（issue #3）。 */
  parentUnitName?: string
  unitType: string
  role: 'level1' | 'level2' | 'level3'
  /** 数据范围（二级=年级 / 三级=班级；一级为空）。 */
  scope?: { grade?: string; class?: string }
  expiresAt?: number
  lastUsedAt: number
}

/** 授权状态（过期只读 + 时钟回拨检测）。 */
export interface LicenseStatus {
  activated: boolean
  expiresAt?: number
  expired: boolean
  /** 时钟回拨检测（离线防篡改，dual-mode/03 §6）：本机记录的最近使用时间晚于当前时间。 */
  rolledBack?: boolean
  /** 距到期剩余天数（已过期为 0）；用于 ≤30 天续期提示。 */
  daysRemaining?: number
}

/** 管理端能力矩阵（gateway/capabilities.ts 的单一真源；渲染层视图分支唯一依据）。 */
export interface AdminCapabilities {
  mode: 'offline' | 'online'
  profileId: string
  unitActivation: 'license-code' | 'license-file'
  serverUrlConfigurable: boolean
  remoteLicenseRefresh: boolean
  transport: 'http' | 'file'
  showFingerprint: boolean
}

/** 激活输入：一级用授权码（online）或授权文件（offline）；二三级恒为授权文件（.dysd）。 */
export type ActivateInput =
  | { kind: 'license-code'; code: string; serverUrl?: string }
  | { kind: 'license-file'; filePath: string; password: string }

/** 授权文件预览（验签 + 读 header，不需口令）：激活页第一步展示。 */
export interface LicenseFilePreview {
  type: string
  unitId: string
  unitName: string
  role: 'level1' | 'level2' | 'level3'
  scope: { grade?: string; class?: string }
  expiresAt: number
  boundFingerprint: string | null
  signKeyId: string
}

/** 公钥包（.dysk）导出结果。 */
export interface PublishPubkeyResult {
  transport: 'http' | 'file'
  path?: string
  exported: boolean
}

/** 激活信息（设置页展示）。 */
export interface ActivationInfo {
  serverUrl?: string
  expiresAt?: number
  mode?: 'offline' | 'online'
  role?: 'level1' | 'level2' | 'level3'
  scope?: { grade?: string; class?: string }
  licenseId?: string
  delegationId?: string
  /** 当前申请密钥 keyId。 */
  keyId?: string
  signKeyId?: string
  /** 本机机器码。 */
  fingerprint?: string
  boundFingerprint?: string | null
  profileId?: string
  /** 配置版本 version.revision。 */
  configVersion?: string
  /** 是否已导出过公钥包（.dysk）。 */
  pubkeyExported?: boolean
}

/** 批次创建输入（计算规则与排名范围由模板决定）。 */
export interface CreateBatchInput {
  year: number
  semester: 1 | 2
  /** 是否测试批次（同一学期可在前一个测试结束后再开新的）。 */
  isTest?: boolean
  /** 使用的配置模板 id（缺省取最新已发布模板；编辑时不可变更）。 */
  templateId?: string
  applyStartAt?: number
  applyEndAt?: number
}

/** 主题模式：亮色/暗色/跟随系统。 */
export type ThemeMode = 'light' | 'dark' | 'system'

/** 数据存储目录信息（设置页展示用）。 */
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

// ---------- M3 导入与审核 ----------

/** 单个 .dyf 文件的导入结果。 */
export interface ImportFileResult {
  /** 原文件名。 */
  fileName: string
  ok: boolean
  /** accept 已导入 / reject 已拒绝 / conflict 待处理冲突 / error 文件错误。 */
  decision: 'accept' | 'reject' | 'conflict' | 'error'
  reason?: string
  studentId?: string
  name?: string
  applyId?: string
  revision?: number
  conflictId?: number
  /** 非阻断提示（如申请期外导出）。 */
  warnings?: string[]
}

/** 待处理学号冲突（暂存于 import_conflict）。 */
export interface PendingConflict {
  conflictId: number
  batchId: string
  studentId: string
  /** 已有记录姓名。 */
  existingName: string
  /** 新导入文件姓名。 */
  incomingName: string
  fileName: string
  createdAt: number
}

/** 冲突处理结果。 */
export interface ConflictResolveResult {
  /** incoming 选择时返回 'imported'（已导入新申请），existing 时返回 'rejected'。 */
  decision: 'rejected' | 'imported'
  reason?: string
  applyId?: string
}

/** 审核列表条目。 */
export interface ApplyListItem {
  applyId: string
  studentId: string
  name: string
  className?: string
  grade?: string
  major?: string
  phone?: string
  status: ApplyStatus
  currentRevision: number
  confirmLevel?: ConfirmLevel
  importedAt?: number
  firstEnteredAt?: number
  lastStudentExportedAt?: number
  lastImportedAt?: number
  lastModifiedAt?: number
  lastExportedAt?: number
  dyfConfirmedAt?: number
  /** 德育分总分（审核后分，未审项按申请分）。 */
  dyfTotal: number
  scoreCount: number
}

/** 审核列表查询选项。 */
export interface ApplyListOptions {
  status?: ApplyStatus
  /** 按学号/姓名模糊搜索。 */
  search?: string
  limit?: number
  offset?: number
}

/** 审核列表结果（分页）。 */
export interface ApplyListResult {
  items: ApplyListItem[]
  total: number
}

/** 审核详情中的德育明细行。 */
export interface ApplyScoreItem {
  itemCode: string
  category: string
  /** 项目描述（来自配置模板）。 */
  description: string
  appliedScore: number
  finalScore?: number
  maxScore?: number
  /** 输入步长（配置 scoreType：stepper 的 step；input/radio 由小数位推导）。 */
  step: number
  /** 小数位数（0~2）：与学生端一致的精度约束，避免管理端把小数吸附成整数。 */
  decimals: number
  allowAdd: boolean
  /** 是否学生端可申请（配置模板标记；缺省按共享层兼容规则回退）。 */
  studentApplicable: boolean
  /** 学生是否已申请该条目（存在导入的明细行；false = 管理端补录）。 */
  applied: boolean
  /** 是否配置模板定义条目（false = 导入文件中模板未定义的项目）。 */
  templateItem: boolean
  /** 证明材料文件绝对路径列表。 */
  evidenceFiles?: string[]
}

/** 审核详情（申请 + 学生 + 明细 + 总分）。 */
export interface ApplyDetail {
  applyId: string
  studentId: string
  name: string
  phone?: string
  grade?: string
  major?: string
  className?: string
  status: ApplyStatus
  currentRevision: number
  confirmLevel?: ConfirmLevel
  confirmBy?: string
  confirmAt?: number
  importedAt?: number
  firstEnteredAt?: number
  lastStudentExportedAt?: number
  lastImportedAt?: number
  lastModifiedAt?: number
  lastExportedAt?: number
  dyfConfirmedAt?: number
  /** 确认单（签字确认单截图）相对路径，经 evidence.read 读取展示/保存；无则 undefined。 */
  confirmSlip?: string
  dyfTotal: number
  scores: ApplyScoreItem[]
}

/** 排名行（德育分总分 + 班级/专业排名，决策 #21）。 */
export interface RankingRow {
  studentId: string
  name: string
  className?: string
  grade?: string
  major?: string
  dyfTotal: number
  rankClass?: number
  rankMajor?: number
}

/** 排名查询结果。 */
export interface RankingListResult {
  items: RankingRow[]
  total: number
}

/** 批次德育分总览（总览页）。 */
export interface BatchOverview {
  batch: {
    year: number
    semester: 1 | 2
    isTest: boolean
    status: string
    /** 班级端审核完成时间（整班导出，决策 #17）。 */
    classReviewedAt?: number
  }
  studentCount: number
  applyCount: number
  statusCounts: Record<string, number>
  conflictCount: number
  /** 参与排名人数（final_grade 行数，需先「计算排名」）。 */
  rankedCount: number
  /** 参与排名学生德育分总分。 */
  rankedSum: number
  /** 班级列表（总体情况班级筛选用，决策 #19）。 */
  classes: string[]
  classCount: number
  latestImportAt?: number
  scoresChangedAt?: number
  tableExportedAt?: number
  /** 参与排名学生平均分（未计算排名时为 undefined）。 */
  avgScore?: number
  /** 参与排名学生最高分（未计算排名时为 undefined）。 */
  maxScore?: number
  /** 参与排名学生最低分（未计算排名时为 undefined）。 */
  minScore?: number
  /** 最近一次排名计算时间（未计算为 undefined）。 */
  rankedAt?: number
  /** 排名是否过期（分数在计算后又变更，或从未计算）：为真时禁止导出。 */
  rankingStale: boolean
}

/** 总体情况大表格：列（模板条目）。 */
export interface ScoreTableColumn {
  itemCode: string
  category: string
  description: string
}

/** 总体情况大表格：行（一位学生，决策 #19：序号/基本信息 + 项目列，班级/专业排名）。 */
export interface ScoreTableRow {
  studentId: string
  name: string
  className?: string
  grade?: string
  major?: string
  dyfTotal: number
  /** itemCode → 得分（finalScore ?? appliedScore）。 */
  scores: Record<string, number>
  rankClass?: number
  rankMajor?: number
}

/** 总体情况大表格结果（全量，滚动呈现）。 */
export interface ScoreTableResult {
  columns: ScoreTableColumn[]
  rows: ScoreTableRow[]
  total: number
}

/** 换机申请结果。 */
export interface RebindResult {
  transport: 'http' | 'file'
  /** offline 导出的 .dysr 路径。 */
  path?: string
  message: string
}

/** 导入单位证书(.dysc)结果。 */
export interface ImportCertResult {
  /** 单位授权到期日(级联封顶下级有效期)。 */
  notAfter: number
  /** notAfter 与本地生效有效期不一致(提示续期未同步)。 */
  expiryMismatch: boolean
}

/** "下级授权"页就绪状态:是否已导入单位证书。 */
export interface DelegationReadiness {
  ready: boolean
  /** 单位授权到期日(= 下级有效期上限)。 */
  notAfter?: number
  /** 当前签发会携带的非草稿批次数（进行中 + 已结束）。 */
  batchCount?: number
}

/** 下级授权台账条目。 */
export interface DelegationRecord {
  delegationId: string
  role: 'level2' | 'level3'
  scope: { grade?: string; class?: string }
  holderLabel: string | null
  boundFingerprint: string | null
  expiresAt: number
  issuedAt: number
  reissuedAt: number | null
  revokedAt: number | null
  /** 本地是否保存了可直接导出的授权文件快照。 */
  exportable?: boolean
}

/** 批量签发下级授权输入（多个范围共用有效期/口令；不绑设备）。 */
export interface IssueDelegationBatchInput {
  /** 选择的年级；每个年级自动签发一份 level2 和其全部班级 level3 授权。 */
  grades: string[]
  holderLabel?: string
  expiresAt: number
  password: string
}

/** 批量签发下级授权结果。 */
export interface IssueDelegationBatchResult {
  grades: number
  classes: number
  path: string
}

/** 批量重签结果。 */
export interface ReissueResult {
  reissued: number
  path: string
}

/** 渲染进程可调用的白名单 API。 */
export interface DmsApi {
  app: {
    /** 是否开发模式（开发模式激活页可配置服务端地址）。 */
    isDev(): Promise<boolean>
    /** 管理端能力矩阵（视图渲染分支的唯一依据）。 */
    getCapabilities(): Promise<AdminCapabilities>
    /** 当前应用版本号（侧边栏版本按钮展示）。 */
    getVersion(): Promise<string>
  }
  theme: {
    getMode(): Promise<ThemeMode>
    setMode(mode: ThemeMode): Promise<void>
    isDark(): Promise<boolean>
    /** 订阅主题变化（含系统主题切换），返回取消订阅函数。 */
    onChanged(callback: (isDark: boolean) => void): () => void
  }
  unit: {
    isInitialized(): Promise<boolean>
    get(): Promise<UnitInfo | null>
    getActivationInfo(): Promise<ActivationInfo>
    /** 授权状态（是否激活/是否过期/时钟回拨/剩余天数，过期只读）。 */
    getLicense(): Promise<LicenseStatus>
    /** 已添加的账号列表（侧边栏切换）。 */
    getAccounts(): Promise<AccountInfo[]>
    /** 激活：授权码（online）或授权文件（offline，按文件 type 分派）。 */
    activate(input: ActivateInput): Promise<UnitInfo>
    /** 本机机器码（离线授权绑定用；带一键复制）。 */
    getFingerprint(): Promise<{ code: string }>
    /** 打开授权文件选择框（.dysl/.dysd），取消返回 null。 */
    pickLicense(): Promise<string | null>
    /** 验签 + 读 header（不需口令）：激活前展示单位信息供确认，online 返回 null。 */
    inspectLicense(filePath: string): Promise<LicenseFilePreview | null>
    /** 导出公钥包（.dysk）交服务商换取单位证书；online 为 HTTP POST。 */
    publishPubkey(): Promise<PublishPubkeyResult>
    /** 切换账号（切换后窗口重载）。 */
    switchAccount(accountId: string): Promise<void>
    /** online 换机：服务端作废旧码签发新码，本机随后注销回验证页。 */
    rebindDevice(reason?: string): Promise<void>
    /** offline 换机：导出 .dysr 换机申请文件（不自动注销），取消返回 null。newFingerprint = 新设备机器码。 */
    exportRebindRequest(newFingerprint: string, reason: string): Promise<RebindResult | null>
    /** 注销本机账号（删除本地数据，回未激活态）。 */
    deactivate(): Promise<void>
    /** 回到验证页（添加单位/账号用）：保留已有账号数据，仅切到未激活态。 */
    logout(): Promise<void>
    /** 是否已有任何账号（决定验证页是否展示“返回我的系统”）。 */
    hasAccounts(): Promise<boolean>
    /** 从验证页返回最近使用的系统（不删数据）。 */
    resume(): Promise<void>
    /** 打开单位证书选择框(.dysc),取消返回 null。 */
    pickCert(): Promise<string | null>
    /** 导入单位证书(.dysc,仅 level1):验签 + 核对后落库,方可签发下级授权。 */
    importCert(filePath: string): Promise<ImportCertResult>
    /** 当前单位班级级联(签发下级授权选数据范围用)。 */
    getClassOptions(): Promise<ClassCascader>
  }
  /** M-O1B:下级授权(.dysd)签发与台账(仅 level1)。 */
  delegation: {
    /** 是否已导入单位证书(据此启用"签发下级授权")。 */
    readiness(): Promise<DelegationReadiness>
    /** 签发台账列表。 */
    list(): Promise<DelegationRecord[]>
    /** 按年级签发授权包（年级授权 + 全部班级授权），取消返回 null。 */
    issueBatch(input: IssueDelegationBatchInput): Promise<IssueDelegationBatchResult | null>
    /** 续期后按台账批量重签,导出到目录,取消返回 null。 */
    reissue(password: string): Promise<ReissueResult | null>
    /** 单独导出台账中保存的原授权文件。 */
    exportFile(delegationId: string): Promise<string | null>
    /** 把选中的授权文件导出为一个 zip。 */
    exportFiles(delegationIds: string[]): Promise<string | null>
    /** 本地作废(仅台账与审计,不影响已发出文件)。 */
    revoke(delegationId: string): Promise<void>
    /** 批量本地作废。 */
    revokeMany(delegationIds: string[]): Promise<{ revoked: number }>
  }
  batch: {
    list(): Promise<Batch[]>
    get(id: string): Promise<Batch | null>
    /** 创建批次；warnings 含离线 seq>1 等非阻断提示。 */
    create(input: CreateBatchInput): Promise<{ batch: Batch; warnings: string[] }>
    update(id: string, input: CreateBatchInput): Promise<Batch>
    activate(id: string): Promise<Batch>
    close(id: string): Promise<Batch>
  }
  audit: {
    list(options?: { limit?: number; offset?: number; batchId?: string }): Promise<AuditLog[]>
  }
  /** 导入统一 .dyf 学生申请/管理端交换文件（通过 documentType 路由）。 */
  import: {
    /** 弹出统一 .dyf 文件选择框，取消返回 null。 */
    pickFiles(): Promise<string[] | null>
    /** 导入一个或多个 .dyf 文件；overwrite 仅一级导入管理端交换数据时覆盖已有数据。 */
    run(
      batchId: string,
      filePaths: string[],
      options?: { overwrite?: boolean }
    ): Promise<ImportFileResult[]>
    /** 拖放/选择框拿到的 File 对象 → 本地文件路径（Electron webUtils，拖入导入用）。 */
    getPathForFile(file: unknown): string
    /** 待处理学号冲突列表。 */
    listConflicts(batchId: string): Promise<PendingConflict[]>
    /** 处理冲突：以现有记录为准或以新导入为准（只能设置一次）。 */
    resolveConflict(
      batchId: string,
      conflictId: number,
      choice: 'existing' | 'incoming'
    ): Promise<ConflictResolveResult>
    /** 错误处理：修正学生姓名（仅一次）。 */
    correctName(batchId: string, studentId: string, newName: string): Promise<void>
  }
  /** M3：审核（扣分/加分/整班确认导出）。 */
  apply: {
    list(batchId: string, options?: ApplyListOptions): Promise<ApplyListResult>
    detail(batchId: string, applyId: string): Promise<ApplyDetail>
    timeline(batchId: string, applyId: string): Promise<TimelineEvent[]>
    /** 一键补全基础分：把「基础分」类别条目补足到满分（仅作用于基础分全为 0 的学生）。 */
    fillBaseScores(batchId: string): Promise<{ studentsFilled: number; itemsFilled: number }>
    /** 调整单个德育明细分（扣分/加分）。 */
    setScore(batchId: string, applyId: string, itemCode: string, finalScore: number): Promise<void>
    /**
     * 整班确认并导出（issue #4/#5）：二三级先产出 .dyf 数据文件（写盘成功后）再确认锁定，
     * 取消保存 → 返回 { canceled:true } 且无任何状态变更；一级为汇总终端仅最终确认（path=null）。
     */
    confirmBatchExport(batchId: string): Promise<{
      confirmedCount?: number
      path?: string | null
      canceled?: boolean
      syncPending?: boolean
    }>
    /** 撤销整班导出（仅一级，留审计）：confirmed → reviewing，清除班级端审核标记。 */
    revokeBatchExport(batchId: string): Promise<void>
    /** 手动计算排名（决策 #47）：重算 final_grade 与班排/专排，返回参与排名人数。 */
    computeRanking(batchId: string): Promise<{ rankedCount: number }>
  }
  overview: {
    /** 批次德育分总览（学生/申请/状态/冲突/确认统计/班级列表/平均·最高·最低）。 */
    get(batchId: string): Promise<BatchOverview>
    /** 总体情况大表格（模板条目为列，全量滚动呈现；支持搜索与班级筛选）。 */
    scoreTable(
      batchId: string,
      options?: { search?: string; classes?: string[]; limit?: number; offset?: number }
    ): Promise<ScoreTableResult>
  }
  /** 导出（主进程弹保存对话框）。 */
  export: {
    /** 导出总体情况表格为 .xlsx（多行表头 + 合并单元格 + 大标题），返回路径或 null=取消。 */
    scoreTableXlsx(
      batchId: string,
      options?: { search?: string; classes?: string[]; categories?: string[] }
    ): Promise<string | null>
    /** 保存图片（data URL → 文件，另存证明材料/确认单），返回路径或 null=取消。 */
    saveImage(fileName: string, dataUrl: string): Promise<string | null>
    /** 重新导出本级数据 .dyf（issue #5：二级可无限制导出），返回路径或 null=取消。 */
    batchData(batchId: string): Promise<string | null>
    onBatchProgress(callback: (progress: {
      phase: 'prepare' | 'write' | 'finalize'
      completedFrames: number
      totalFrames: number
      writtenBytes: number
    }) => void): () => void
  }
  evidence: {
    /** 读证据文件为 data URL（审核详情展示），文件不存在返回 null。 */
    read(filePath: string): Promise<string | null>
  }
  data: {
    /** 当前数据存储目录信息。 */
    getInfo(): Promise<DataDirInfo>
    /** 弹出目录选择框（取消返回 null）。 */
    pickDir(): Promise<string | null>
    /** 迁移数据到目标目录并重启应用（null = 恢复默认位置）。 */
    setDir(target: string | null): Promise<void>
  }
  /** 自动更新：轻量版本检查（不自动下载安装包，仅引导手动下载）。 */
  update: {
    /** 手动检查更新。manual=false 时遵循 24h 节流；返回 null = 网络失败/无更新通道（静默）。 */
    check(manual: boolean): Promise<UpdateCheckResult | null>
    /** 订阅主进程推送的检查结果（自动检查或手动检查后）。 */
    onStatus(callback: (payload: UpdateCheckResult | null) => void): void
  }
}
