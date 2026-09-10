/**
 * preload 白名单 API 的类型契约：渲染进程通过 window.api 访问。
 * 输入/输出类型与主进程服务对齐，供 index.ts（实现）与 index.d.ts（全局声明）复用。
 */
import type {
  ApplyStatus,
  AuditLog,
  Batch,
  ConfirmLevel,
  TimelineEvent
} from '@sces/shared'
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

/** 授权状态（过期只读判定）。 */
export interface LicenseStatus {
  activated: boolean
  expiresAt?: number
  expired: boolean
  /** 距到期剩余天数（已过期为 0）；用于 ≤30 天续期提示。 */
  daysRemaining?: number
}

/** 管理端能力矩阵（gateway/capabilities.ts 的单一真源；渲染层视图分支唯一依据）。 */
export interface AdminCapabilities {
  mode: 'online'
  profileId: string
}

/** 激活输入（在线版：授权码激活）。 */
export interface ActivateInput {
  code: string
  serverUrl?: string
}

/** 激活信息（设置页展示）。 */
export interface ActivationInfo {
  serverUrl?: string
  expiresAt?: number
  role?: 'level1' | 'level2' | 'level3'
  scope?: { grade?: string; class?: string }
  licenseId?: string
  /** 当前申请密钥 keyId。 */
  keyId?: string
  profileId?: string
  /** 配置版本 version.revision。 */
  configVersion?: string
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

// ---------- 德育分文件解析（设置 → 文件解析，仅展示不改库） ----------

/** 解析出的德育分明细行（展示用；分数为文件内申请分，不可修改）。 */
export interface DyfParseScoreItem {
  itemCode: string
  /** 分类 code（模板未定义时为「未知」）。 */
  categoryCode: string
  /** 分类显示名。 */
  categoryName: string
  /** 项目描述（模板；未定义为「模板未定义项目」）。 */
  description: string
  /** 学生申请分。 */
  appliedScore: number
  /** 分值上限（模板 scoreType 推导）。 */
  maxScore?: number
  allowAdd: boolean
  studentApplicable: boolean
  negative: boolean
  /** 是否配置模板定义条目。 */
  templateItem: boolean
  /** 证明材料（data URL；超限条目为占位值）。 */
  evidence: string[]
}

/** 解析出的导出历史（时间信息）。 */
export interface DyfParseExportEvent {
  revision: number
  exportedAt: number
  fileHash?: string
}

/** 学生端 .dyf 文件解析结果（ok=false 时仅 fileName/error）。 */
export type DyfParseStudentResult = DyfParseStudentOk | DyfParseStudentError

/** 解析失败：密钥不匹配、文件损坏或格式不支持。 */
export interface DyfParseStudentError {
  fileName: string
  ok: false
  /** 中文原因（如「无法解析：文件使用的密钥与本机不匹配」）。 */
  error: string
}

/** 解析成功：完整展示数据。 */
export interface DyfParseStudentOk {
  fileName: string
  ok: true
  /** 容器头（不解密即可读的元信息）。 */
  header: {
    schemaVersion: number
    type: string
    documentType: string
    batchId?: string
    keyId?: string
    applyId?: string
    revision?: number
    algorithm: string
    createdAt: number
    frameCount: number
    contentHash: string
    assets: Array<{ assetId: string; mimeType: string; size: number; sha256: string }>
  }
  summary: {
    applyId: string
    revision: number
    batchId: string
    /** 基础信息（已知字段按序 + 其余透出）。 */
    personal: Array<{ key: string; label: string; value: string }>
    exportedAt?: number
    enteredAt?: number
    exports: DyfParseExportEvent[]
    /** 文件内德育分明细合计。 */
    totalScore: number
  }
  /** 德育分明细（仅文件内已申请项目）。 */
  scores: DyfParseScoreItem[]
  /** 确认单（data URL，可选）。 */
  confirmSlip?: string
  timeline: Array<{
    eventId: string
    action: string
    occurredAt: number
    revision?: number
    sourceFileHash?: string
  }>
  /** 解密后的原始 payload（附在页面底部供核对）。 */
  raw: unknown
  /** payload 的 SHA-256（hex）。 */
  payloadHash: string
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

/** 换机申请结果（online：服务端受理）。 */
export interface RebindResult {
  message: string
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
    /** 切换账号（切换后窗口重载）。 */
    switchAccount(accountId: string): Promise<void>
    /** online 换机：服务端作废旧码签发新码，本机随后注销回验证页。 */
    rebindDevice(reason?: string): Promise<void>
    /** 注销本机账号（删除本地数据，回未激活态）。 */
    deactivate(): Promise<void>
    /** 回到验证页（添加单位/账号用）：保留已有账号数据，仅切到未激活态。 */
    logout(): Promise<void>
    /** 是否已有任何账号（决定验证页是否展示“返回我的系统”）。 */
    hasAccounts(): Promise<boolean>
    /** 从验证页返回最近使用的系统（不删数据）。 */
    resume(): Promise<void>
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
  /** 导入 .dyf 学生申请文件。 */
  import: {
    /** 弹出 .dyf 文件选择框，取消返回 null。 */
    pickFiles(): Promise<string[] | null>
    /** 导入一个或多个 .dyf 学生申请文件。 */
    run(batchId: string, filePaths: string[]): Promise<ImportFileResult[]>
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
  /** 设置 → 文件解析：解析德育分文件（.dyf），仅展示不改库。 */
  parse: {
    /** 弹出 .dyf 文件选择框（单选），取消返回 null。 */
    pickFile(): Promise<string | null>
    /** 解析学生端导出的 .dyf 申请文件（密钥不匹配返回 ok=false + 原因）。 */
    studentFile(filePath: string): Promise<DyfParseStudentResult>
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
     * 整班最终确认：确认即锁定，状态经 outbox 同步服务端（管理端间 .dxy 交换已下线）。
     */
    confirmBatchExport(batchId: string): Promise<{
      confirmedCount?: number
      syncPending?: boolean
    }>
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
