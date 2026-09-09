<script setup lang="ts">
import { computed, onMounted, provide, ref, watch } from 'vue'
import type { DropdownMenuItem, NavigationMenuItem } from '@nuxt/ui'
import type { AccountInfo } from '../../../preload/types'
import { useToast } from '@nuxt/ui/composables'
import TitleBar from './TitleBar.vue'
import BatchSelect from './BatchSelect.vue'
import FileDropOverlay from './FileDropOverlay.vue'
import ImportResultModal from './ImportResultModal.vue'
import GuardedButton from './GuardedButton.vue'
import BatchView from '../views/BatchView.vue'
import OverviewView from '../views/OverviewView.vue'
import TableView from '../views/TableView.vue'
import ReviewView from '../views/ReviewView.vue'
import AuditView from '../views/AuditView.vue'
import SettingsView from '../views/SettingsView.vue'
import { useFileImport } from '../composables/useFileImport'
import { ipcErrorMessage } from '../utils/ipc'
import { fullUnitName } from '../utils/unit-name'
import {
  bumpDyfRefresh,
  currentBatch as storeCurrentBatch,
  dyfState,
  isDyfExported
} from '../stores/dyf-state'

type Tab =
  | 'batch'
  | 'dyf-overview'
  | 'dyf-table'
  | 'dyf-review'
  | 'audit'
  | 'settings-general'
  | 'settings-license'
  | 'settings-accounts'
  | 'settings-parse'

const current = ref<Tab>('batch')
const unitName = ref('')
const accounts = ref<AccountInfo[]>([])
const expired = ref(false)
// 当前账号角色（M-O1B：level1 才显示下级授权入口；二三级隐藏越权按钮）
const role = ref<AccountInfo['role']>('level1')
const toast = useToast()

// 批次页“创建批次”动作提升到 navbar（对齐模板 customers 页），经 provide 传给 BatchView
const batchCreate = ref<(() => void) | null>(null)
const batchReadonly = ref(false)
provide('batchCreate', batchCreate)
provide('batchReadonly', batchReadonly)

// 审核页功能区动作（provide 给 ReviewView 填充；标题栏 tab 右侧按钮触发）
const reviewViewSlip = ref<(() => void) | null>(null)
const reviewViewTimeline = ref<(() => void) | null>(null)
const reviewCorrectName = ref<(() => void) | null>(null)
const reviewHasSlip = ref(false)
const reviewCanTimeline = ref(false)
const reviewCanCorrect = ref(false)
provide('reviewViewSlip', reviewViewSlip)
provide('reviewViewTimeline', reviewViewTimeline)
provide('reviewCorrectName', reviewCorrectName)
provide('reviewHasSlip', reviewHasSlip)
provide('reviewCanTimeline', reviewCanTimeline)
provide('reviewCanCorrect', reviewCanCorrect)

// 德育分子页（总览 / 总体情况 / 审核）：侧边栏一个分组，顶部标签栏同步展示。
// 决策 #16：总览与总体情况分页；总览仅统计（不含导入），
// 导入能力合入「总体情况」（导入 + 冲突处理 + 大表格）与「审核」两个子页。
const dyfTabItems = computed<NavigationMenuItem[]>(() => [
  {
    label: '总览',
    icon: 'i-lucide-layout-dashboard',
    value: 'dyf-overview',
    active: current.value === 'dyf-overview',
    onSelect: () => (current.value = 'dyf-overview')
  },
  {
    label: '总体情况',
    icon: 'i-lucide-table-2',
    value: 'dyf-table',
    active: current.value === 'dyf-table',
    onSelect: () => (current.value = 'dyf-table')
  },
  {
    label: '审核',
    icon: 'i-lucide-clipboard-check',
    value: 'dyf-review',
    active: current.value === 'dyf-review',
    onSelect: () => (current.value = 'dyf-review')
  }
])

// ---------- 德育分功能区（决策 #19）：批次选择 / 导入 / 导出整班 / 导出表格 ----------
// 批次选择与导入/导出集中在标题栏右侧功能区；总览页只显示批次选择。

/** 是否已完成班级端审核（整班导出，决策 #17，响应式）。 */
const exported = isDyfExported
/** 当前批次（所有操作门禁与原因提示共用）。 */
const currentBatch = storeCurrentBatch

/** 可导入：进行中批次、未整班导出、未过期。 */
const canImportDyf = computed(
  () =>
    dyfState.batches.find((b) => b.batchId === dyfState.batchId)?.status === 'active' &&
    !exported.value &&
    !expired.value
)

const importDisabledReason = computed(() => {
  const batch = currentBatch.value
  if (!batch) return '请先选择一个批次'
  if (expired.value) return '授权已过期，请到“设置 - 授权信息”更新授权'
  if (exported.value) return '该批次已导出锁定；一级离线端可先撤销导出，其他角色不能再修改'
  if (batch.status === 'draft') return '批次尚未开放，请先到“批次管理”激活批次'
  if (batch.status === 'closed') return '批次已经结束，不能再导入或补录数据'
  return '当前批次暂不可执行此操作'
})

// 导入结果弹窗（决策 #19：导入反馈走弹窗，替代「总体情况」页内联结果块）
const importResultOpen = ref(false)

// 导入编排（选择/拖放共用；结果写入共享状态，各子页经 refreshTick 刷新）。
// 拖放仅德育分相关页面启用：设置页（含文件解析）不做拖入（拖入是导入操作，与解析冲突）。
const { importing, results, dragging, pickAndImport } = useFileImport({
  getBatchId: () => dyfState.batchId,
  getOverwrite: () => role.value === 'level1',
  enabled: () => !current.value.startsWith('settings'),
  // 一级拖放导入 .dxy 会覆盖同学号旧数据：二次确认后再导入（选择框路径由 onImportClick 确认）。
  confirmOverwrite: () =>
    new Promise<boolean>((resolve) => {
      askConfirm({
        title: '导入将覆盖同学号旧数据',
        description:
          '一级拖入管理端交换文件（.dyf）会用新数据覆盖相同学号的已有申请与分数（不可恢复）。确定继续导入吗？',
        confirmLabel: '继续导入',
        confirmColor: 'error',
        action: async () => resolve(true),
        onCancel: () => resolve(false)
      })
    }),
  onImported: () => {
    dyfState.results = results.value
    importResultOpen.value = results.value.length > 0
    bumpDyfRefresh()
  }
})

watch(importing, (v) => {
  dyfState.importing = v
})

// 二次确认（整班导出 / 撤销导出 / 一级覆盖导入）
const confirmOpen = ref(false)
const confirmState = ref<{
  title: string
  description?: string
  confirmLabel?: string
  confirmColor?: 'primary' | 'error'
  action?: () => Promise<void>
  /** 取消/关闭弹窗时回调（供 promise 形式的二次确认在取消时 resolve false）。 */
  onCancel?: () => void
}>({ title: '' })
const exporting = ref(false)
const exportProgress = ref<{
  completedFrames: number
  totalFrames: number
  writtenBytes: number
} | null>(null)
const exportProgressLabel = computed(() => {
  const progress = exportProgress.value
  if (!progress || progress.totalFrames <= 0) return ''
  return `导出中 ${Math.floor((progress.completedFrames / progress.totalFrames) * 100)}%`
})

function askConfirm(opts: {
  title: string
  description?: string
  confirmLabel?: string
  confirmColor?: 'primary' | 'error'
  action: () => Promise<void>
  onCancel?: () => void
}): void {
  confirmState.value = opts
  confirmOpen.value = true
}

async function runConfirm(): Promise<void> {
  confirmOpen.value = false
  if (confirmState.value.action) await confirmState.value.action()
}

function cancelConfirm(): void {
  confirmOpen.value = false
  confirmState.value.onCancel?.()
}

/** 加载批次列表到共享状态（功能区分区批次下拉；初始化/整班导出后刷新）。 */
async function loadDyfBatches(): Promise<void> {
  try {
    dyfState.batches = await window.api.batch.list()
    const active = dyfState.batches.find((b) => b.status === 'active')
    if (!dyfState.batchId || !dyfState.batches.some((b) => b.batchId === dyfState.batchId)) {
      dyfState.batchId = active?.batchId ?? dyfState.batches[0]?.batchId ?? ''
    }
  } catch (err) {
    toast.add({ title: '加载批次失败', description: ipcErrorMessage(err), color: 'error' })
  }
}

/** 整班确认并导出（issue #4/#5）：二三级确认 + 产出 .dyf 数据文件（取消保存则不锁定，可重试）；一级为汇总终端仅最终确认。 */
async function exportWholeClass(): Promise<void> {
  if (expired.value) {
    toast.add({ title: '授权已过期', description: '请先在设置中续期或更新授权', color: 'warning' })
    return
  }
  if (!rankingFresh.value) {
    toast.add({
      title: '请先计算排名',
      description: '分数有更新，导出前请到「总体情况」页点「计算排名」确认最新排名',
      color: 'warning'
    })
    return
  }
  if (role.value !== 'level1' && !tableExportFresh.value) {
    toast.add({
      title: '请先导出最新表格',
      description: '德育分数据文件必须与公示表格一致；请先点击“导出表格”，再执行本级数据导出',
      color: 'warning'
    })
    return
  }
  exportProgress.value = null
  exporting.value = true
  try {
    const r = await window.api.apply.confirmBatchExport(dyfState.batchId)
    if (r.canceled) return // 取消保存文件：未确认、未锁定，可重试（不锁死数据）
    toast.add({
      title:
        role.value === 'level1'
          ? '已最终确认'
          : role.value === 'level2'
            ? '已导出本级数据'
            : '已确认并导出',
      description:
        role.value === 'level2' && r.path
          ? `数据文件已导出到：${r.path}；年级端仍可继续复核和再次导出`
          : r.path
            ? `全班 ${r.confirmedCount} 人已确认，数据文件已导出到：${r.path}`
            : `全班 ${r.confirmedCount ?? 0} 人已最终确认`,
      color: r.syncPending ? 'warning' : 'success'
    })
    if (r.syncPending) {
      toast.add({
        title: '在线状态待同步',
        description: '本地已完成确认，服务端状态尚未同步，请联网后重试',
        color: 'warning'
      })
    }
    await loadDyfBatches()
    bumpDyfRefresh()
  } catch (err) {
    toast.add({ title: '操作失败', description: ipcErrorMessage(err), color: 'error' })
  } finally {
    exporting.value = false
    exportProgress.value = null
  }
}

function requestWholeClassExport(): void {
  if (!canExportWholeClass.value) {
    void exportWholeClass()
    return
  }
  askConfirm({
    title:
      role.value === 'level1'
        ? '最终确认全部数据'
        : role.value === 'level2'
          ? '导出本级数据'
          : '确认并导出整班数据',
    description:
      role.value === 'level1'
        ? '将一次性最终确认全部已导入数据并固定排名；操作后本端锁定、影响重大，请确认无误后继续。'
        : role.value === 'level2'
          ? '将按最新排名和已导出的公示表格生成本级数据文件；导出后仍可继续复核、修改并再次导出。'
          : '将一次性确认全部数据并导出为数据文件（.dyf，发送给上级管理员复核）；导出后本端锁定，不可再修改本批次。',
    confirmLabel: role.value === 'level1' ? '最终确认' : '确认并导出',
    confirmColor: 'error',
    action: exportWholeClass
  })
}

/** 重新导出数据文件（issue #5：二级可无限制导出）：已锁定批次重新生成 .dyf，不改任何状态。 */
async function reExportData(): Promise<void> {
  exportProgress.value = null
  exporting.value = true
  try {
    const path = await window.api.export.batchData(dyfState.batchId)
    if (path) toast.add({ title: '已重新导出数据', description: path, color: 'success' })
  } catch (err) {
    toast.add({ title: '导出失败', description: ipcErrorMessage(err), color: 'error' })
  } finally {
    exporting.value = false
    exportProgress.value = null
  }
}

/** 导入按钮：一级导入前强提示会覆盖同学号旧数据（issue #5）；二三级直接选择导入（不覆盖）。 */
function onImportClick(): void {
  if (role.value === 'level1') {
    askConfirm({
      title: '导入将覆盖同学号旧数据',
      description:
        '一级导入管理端交换文件（.dyf）会用新数据覆盖相同学号的已有申请与分数（不可恢复）。确定继续导入吗？',
      confirmLabel: '继续导入',
      confirmColor: 'error',
      action: async () => {
        await pickAndImport()
      }
    })
  } else {
    void pickAndImport()
  }
}

/** 排名是否为最新（已算且不早于最近一次分数/名单变更）：过期或未算时禁止导出。 */
const rankingFresh = computed(() => {
  const b = currentBatch.value
  if (!b || !b.rankedAt) return false
  return !b.scoresChangedAt || b.rankedAt >= b.scoresChangedAt
})

/** 非一级导出 .dxy 前，公示表格必须晚于最近一次分数/名单变更。 */
const tableExportFresh = computed(() => {
  const b = currentBatch.value
  if (!b?.tableExportedAt) return false
  return !b.scoresChangedAt || b.tableExportedAt >= b.scoresChangedAt
})

/** 可计算排名：进行中批次、未整班导出、未过期。 */
const canComputeRanking = computed(
  () => currentBatch.value?.status === 'active' && !exported.value && !expired.value
)

/** 可整班导出：未过期且排名最新（未算/过期时禁止，须先「计算排名」）。 */
const canExportWholeClass = computed(
  () => !expired.value && rankingFresh.value && (role.value === 'level1' || tableExportFresh.value)
)

/** 可导出表格：未过期，且排名最新或已锁定（已导出批次排名已冻结，可随时导公示表）。 */
const canExportTable = computed(() => !expired.value && (exported.value || rankingFresh.value))

const rankingDisabledReason = computed(() => {
  const batch = currentBatch.value
  if (!batch) return '请先选择一个批次'
  if (expired.value) return '授权已过期，请到“设置 - 授权信息”更新授权'
  if (exported.value) return '该批次已导出锁定，排名已经冻结'
  if (batch.status !== 'active') return '只有进行中的批次可以重新计算排名'
  return '当前状态不能计算排名'
})

const wholeClassDisabledReason = computed(() => {
  if (!currentBatch.value) return '请先选择一个批次'
  if (expired.value) return '授权已过期，请到“设置 - 授权信息”更新授权'
  if (!rankingFresh.value) return '分数或名单有更新，请先点击“计算排名”'
  if (role.value !== 'level1' && !tableExportFresh.value) {
    return '请先导出与当前数据一致的最新公示表格'
  }
  return '当前状态不能导出本级数据'
})

const tableDisabledReason = computed(() => {
  if (!currentBatch.value) return '请先选择一个批次'
  if (expired.value) return '授权已过期，请到“设置 - 授权信息”更新授权'
  if (!exported.value && !rankingFresh.value) return '分数或名单有更新，请先点击“计算排名”'
  return '当前状态不能导出表格'
})

const ranking = ref(false)

/** 手动计算排名（决策 #47）：重算后刷新各页并提示。 */
async function computeRankingNow(): Promise<void> {
  if (!dyfState.batchId) {
    toast.add({ title: '请先选择批次', color: 'warning' })
    return
  }
  ranking.value = true
  try {
    const r = await window.api.apply.computeRanking(dyfState.batchId)
    await loadDyfBatches()
    bumpDyfRefresh()
    toast.add({
      title: '排名已更新',
      description: `已按最新分数计算 ${r.rankedCount} 名学生的班级/专业排名`,
      color: 'success'
    })
  } catch (err) {
    toast.add({ title: '计算排名失败', description: ipcErrorMessage(err), color: 'error' })
  } finally {
    ranking.value = false
  }
}

/** 导出表格（.xlsx）：主进程按当前类别/班级/搜索筛选生成（决策 #19）。排名过期时禁止。 */
async function exportTableXlsx(): Promise<void> {
  if (expired.value) {
    toast.add({ title: '授权已过期', description: '请先在设置中续期或更新授权', color: 'warning' })
    return
  }
  if (!dyfState.batchId) {
    toast.add({ title: '请先选择批次', color: 'warning' })
    return
  }
  if (!exported.value && !rankingFresh.value) {
    toast.add({
      title: '请先计算排名',
      description: '分数有更新，导出前请到「总体情况」页点「计算排名」',
      color: 'warning'
    })
    return
  }
  exporting.value = true
  try {
    const f = dyfState.table.filter
    const path = await window.api.export.scoreTableXlsx(dyfState.batchId, {
      search: f.search || undefined,
      classes: f.classes.length ? [...f.classes] : undefined,
      categories: [...f.categories]
    })
    if (path) {
      toast.add({ title: '已导出表格', description: path, color: 'success' })
      await loadDyfBatches()
    }
  } catch (err) {
    toast.add({ title: '导出失败', description: ipcErrorMessage(err), color: 'error' })
  } finally {
    exporting.value = false
  }
}

// 一键补全基础分（issue #1：总体情况页功能区）
const fillingBase = ref(false)
async function fillBaseScores(): Promise<void> {
  if (!dyfState.batchId) {
    toast.add({ title: '请先选择批次', color: 'warning' })
    return
  }
  fillingBase.value = true
  try {
    const r = await window.api.apply.fillBaseScores(dyfState.batchId)
    toast.add({
      title: '已补全基础分',
      description: `${r.studentsFilled} 名学生、${r.itemsFilled} 个明细补足为满分`,
      color: 'success'
    })
    bumpDyfRefresh()
  } catch (err) {
    toast.add({ title: '补全失败', description: ipcErrorMessage(err), color: 'error' })
  } finally {
    fillingBase.value = false
  }
}

/** 批次切换 → 通知子页刷新。 */
watch(
  () => dyfState.batchId,
  () => {
    bumpDyfRefresh()
  }
)

/**
 * 分数/名单变更（改分/补全/导入/冲突处理等，各页均 bumpDyfRefresh）后统一重载批次。
 * 功能区「排名待更新」标记与导出门禁读的是 dyfState.batches 里的 scores_changed_at/ranked_at；
 * 不随刷新重载则改分后排名不会及时变为「需计算」状态（本次修复）。
 */
watch(
  () => dyfState.refreshTick,
  () => {
    void loadDyfBatches()
  }
)

/** 进入德育分分组：在「批次管理」新建/激活批次后，功能区批次下拉需同步最新列表。 */
watch(
  () => current.value,
  (tab, prev) => {
    if (tab.startsWith('dyf-') && !prev.startsWith('dyf-')) void loadDyfBatches()
  }
)

// 设置页顶部标签栏：对齐模板 settings.vue（UNavigationMenu + highlight，而非 UTabs）。
// 与侧边栏“设置”子项共用图标/状态，点击切换 current。
const settingsTabItems = computed<NavigationMenuItem[]>(() => [
  {
    label: '通用',
    icon: 'i-lucide-sliders-horizontal',
    value: 'settings-general',
    active: current.value === 'settings-general',
    onSelect: () => (current.value = 'settings-general')
  },
  {
    label: '授权',
    icon: 'i-lucide-shield-check',
    value: 'settings-license',
    active: current.value === 'settings-license',
    onSelect: () => (current.value = 'settings-license')
  },
  {
    label: '账号',
    icon: 'i-lucide-users',
    value: 'settings-accounts',
    active: current.value === 'settings-accounts',
    onSelect: () => (current.value = 'settings-accounts')
  },
  {
    label: '文件解析',
    icon: 'i-lucide-file-search',
    value: 'settings-parse',
    active: current.value === 'settings-parse',
    onSelect: () => (current.value = 'settings-parse')
  }
])

onMounted(async () => {
  window.api.export.onBatchProgress((progress) => {
    exportProgress.value = progress
  })
  try {
    const info = await window.api.unit.get()
    if (info) unitName.value = fullUnitName(info)
    accounts.value = await window.api.unit.getAccounts()
    const lic = await window.api.unit.getLicense()
    expired.value = lic.expired
    const act = await window.api.unit.getActivationInfo()
    if (act.role) role.value = act.role
  } catch {
    // 忽略：获取失败不影响主界面
  }
  await loadDyfBatches()
  await loadAppVersion()
  // 自动更新推送：主进程启动后自动检查（打包态 + 24h 节流）结果 → 侧边栏版本按钮 badge
  window.api.update.onStatus((payload) => {
    if (payload && payload.hasUpdate) {
      updateAvailable.value = true
      updateVersion.value = payload.latest
      updateUrl.value = payload.downloadUrl
    }
  })
})

/** 授权到期时间（格式化展示）。 */
const expiryText = computed(() => {
  const acc = accounts.value[0]
  if (!acc?.expiresAt) return ''
  return new Date(acc.expiresAt).toLocaleDateString('zh-CN')
})

/**
 * 主导航：批次管理 / 德育分（总览·总体情况·审核）/ 操作记录 / 设置（通用 / 授权 / 账号 / 更多）。
 * 与 dashboard-vue 模板完全一致：触发器（含子页面的标签）带 `to` 指向其第一子页
 * （德育分 → /dyf-overview 总览；设置 → /settings 通用）。
 * 收缩态下 UNavigationMenu 将触发器渲染为带 href 的链接（模板经 vue-router 跳转）；
 * 本应用无 vue-router（ui router:false 时 ULink 渲染普通 <a>），由 onSidebarClickCapture
 * 在捕获阶段拦截该锚点点击并映射为页面切换（阻止默认整页跳转）。
 * 注意：不要把 onSelect 放在触发器上——收缩态+popover 时 reka-ui NavigationMenuLink 的
 * @select 经 as-child 合并到 UPopover 上，而 UPopover inheritAttrs:false 会丢弃该处理器，
 * 点击永远不会触发（模板正是因此用 to 而非 onSelect）。
 */
const navItems = computed<NavigationMenuItem[]>(() => [
  {
    label: '批次管理',
    icon: 'i-lucide-calendar-days',
    value: 'batch',
    active: current.value === 'batch',
    onSelect: () => (current.value = 'batch')
  },
  {
    label: '德育分',
    icon: 'i-lucide-clipboard-check',
    // 对齐模板：触发器 to = 第一子页（总览）
    to: '/dyf-overview',
    type: 'trigger',
    defaultOpen: true,
    children: dyfTabItems.value
  },
  {
    label: '操作记录',
    icon: 'i-lucide-history',
    value: 'audit',
    active: current.value === 'audit',
    onSelect: () => (current.value = 'audit')
  },
  {
    label: '设置',
    icon: 'i-lucide-settings',
    // 对齐模板：触发器 to = 第一子页（通用）
    to: '/settings',
    type: 'trigger',
    defaultOpen: true,
    children: settingsTabItems.value
  }
])

/** 侧边栏内部“路由”：触发器 to 渲染出的锚点 href → 页面 Tab。 */
const SIDEBAR_ROUTES: Record<string, Tab> = {
  '/dyf-overview': 'dyf-overview',
  '/settings': 'settings-general'
}

/** 拦截侧边栏内部链接点击（捕获阶段，先于默认跳转）：映射到页面切换而非整页刷新。 */
function onSidebarClickCapture(e: MouseEvent): void {
  const anchor = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
  if (!anchor) return
  const tab = SIDEBAR_ROUTES[anchor.getAttribute('href') ?? '']
  if (!tab) return
  e.preventDefault()
  current.value = tab
}

const currentSettingsTab = computed(() =>
  current.value.startsWith('settings-') ? (current.value as Tab) : 'settings-general'
)

// 当前账号 / 当前单位（accounts 按最近使用倒序，[0] = 当前账号）
const currentAccount = computed<AccountInfo | undefined>(() => accounts.value[0])
const currentUnitId = computed(() => currentAccount.value?.unitId)
// 应用版本 + 自动更新（侧边栏底部版本按钮：显示版本、点击手动检查；有新版时图标/tag 提示）。
const appVersion = ref(__DMS_VERSION__ ?? '')
const checkingUpdate = ref(false)
const updateAvailable = ref(false)
const updateVersion = ref('')
const updateUrl = ref('')

async function loadAppVersion(): Promise<void> {
  try {
    appVersion.value = await window.api.app.getVersion()
  } catch {
    // 忽略：拿不到版本不影响主界面
  }
}

async function checkUpdate(): Promise<void> {
  checkingUpdate.value = true
  try {
    const res = await window.api.update.check(true)
    if (res && res.hasUpdate) {
      updateAvailable.value = true
      updateVersion.value = res.latest
      updateUrl.value = res.downloadUrl
      toast.add({
        title: res.mandatory ? '发现新版本（强制更新）' : '发现新版本',
        description: `当前 ${res.current} → 最新 ${res.latest}`,
        color: 'success'
      })
    } else if (!res) {
      toast.add({
        title: '检查更新失败',
        description: '无法连接更新服务器，请稍后重试',
        color: 'warning'
      })
    } else {
      toast.add({
        title: '已是最新版本',
        description: `当前版本 ${appVersion.value}`,
        color: 'success'
      })
    }
  } catch {
    toast.add({ title: '检查更新失败', color: 'error' })
  } finally {
    checkingUpdate.value = false
  }
}

function gotoDownload(): void {
  if (updateUrl.value) window.open(updateUrl.value, '_blank')
}

const ROLE_TEXT: Record<AccountInfo['role'], string> = {
  level1: '单位管理员',
  level2: '年级管理员',
  level3: '班级管理员'
}

/** 管理员条目描述：范围（年级/班级）+ 当前账号附带授权到期。 */
function roleDesc(a: AccountInfo): string | undefined {
  const scope = a.scope?.class ?? a.scope?.grade
  const isCurrent = a.accountId === currentAccount.value?.accountId
  const expiry = isCurrent && expiryText.value ? `授权至 ${expiryText.value}` : ''
  return [scope, expiry].filter(Boolean).join(' · ') || undefined
}

// 单位切换（左上角）：同一单位的多个管理员账号合并成一个单位条目；切换单位＝切到该单位最近使用的账号
//（会一并切换当前管理员与其独立数据空间）。当前单位高亮；末尾「添加单位」。
const unitMenuItems = computed<DropdownMenuItem[]>(() => {
  const seen = new Set<string>()
  const items: DropdownMenuItem[] = []
  for (const a of accounts.value) {
    if (seen.has(a.unitId)) continue
    seen.add(a.unitId)
    items.push({
      label: fullUnitName(a),
      icon: 'i-lucide-building-2',
      active: a.unitId === currentUnitId.value,
      onSelect: () => {
        if (a.unitId !== currentUnitId.value) void window.api.unit.switchAccount(a.accountId)
      }
    })
  }
  items.push({ type: 'separator' })
  items.push({
    label: '添加单位',
    icon: 'i-lucide-plus',
    onSelect: () => {
      void window.api.unit.logout()
    }
  })
  return items
})

// 管理员切换（左下角）：仅列当前单位下的账号（一级/二级/三级，数据互不互通）；只显示角色/范围，不显示单位名；
// 切换管理员不改变单位。当前账号高亮；末尾「添加账号」。
const roleMenuItems = computed<DropdownMenuItem[]>(() => {
  const items: DropdownMenuItem[] = accounts.value
    .filter((a) => a.unitId === currentUnitId.value)
    .map((a) => ({
      label: ROLE_TEXT[a.role],
      icon: 'i-lucide-shield-check',
      description: roleDesc(a),
      active: a.accountId === currentAccount.value?.accountId,
      onSelect: () => {
        if (a.accountId !== currentAccount.value?.accountId)
          void window.api.unit.switchAccount(a.accountId)
      }
    }))
  items.push({ type: 'separator' })
  items.push({
    label: '添加账号',
    icon: 'i-lucide-plus',
    onSelect: () => {
      void window.api.unit.logout()
    }
  })
  return items
})
</script>

<template>
  <div class="flex flex-col h-screen">
    <TitleBar />
    <!-- 覆盖 UDashboardGroup 默认 fixed inset-0（tv/twMerge 需显式 static 才能覆盖 fixed）：
         标题栏占 35px，dashboard 作为 flex item 占据剩余空间。unit=rem + storage=local 对齐模板。 -->
    <UDashboardGroup
      unit="rem"
      storage="local"
      :ui="{ base: 'static flex flex-1 min-h-0 overflow-hidden' }"
    >
      <UDashboardSidebar
        id="main"
        collapsible
        resizable
        class="bg-elevated/25 min-h-0"
        :ui="{ footer: 'border-t border-default' }"
        @click.capture="onSidebarClickCapture"
      >
        <template #header="{ collapsed }">
          <UDropdownMenu
            :items="unitMenuItems"
            :content="{ align: 'start', collisionPadding: 12 }"
            :ui="{ content: collapsed ? 'w-40' : 'w-(--reka-dropdown-menu-trigger-width)' }"
          >
            <UButton
              v-bind="{
                icon: 'i-lucide-building-2',
                label: collapsed ? undefined : unitName || '学生综合素质测评管理系统',
                trailingIcon: collapsed ? undefined : 'i-lucide-chevrons-up-down'
              }"
              color="neutral"
              variant="ghost"
              block
              :square="collapsed"
              class="data-[state=open]:bg-elevated"
              :class="[!collapsed && 'py-2']"
              :ui="{ trailingIcon: 'text-dimmed' }"
            />
          </UDropdownMenu>
        </template>

        <template #default="{ collapsed }">
          <!-- 触发器 to → 锚点（收缩态点击跳第一子页）；锚点点击由 onSidebarClickCapture 拦截映射 -->
          <UNavigationMenu
            :collapsed="collapsed"
            :items="navItems"
            orientation="vertical"
            tooltip
            popover
          />

          <!-- 版本按钮：对齐参考模板 Feedback / Help & Support 的位置（mt-auto 沉底到账号上方）。
               显示当前版本，点击手动检查更新；自动检查发现新版时（弹窗可能被忽略）徽标提示并可直接跳转下载页。 -->
          <div class="mt-auto flex flex-col gap-0.5">
            <UButton
              v-bind="{
                icon: updateAvailable ? 'i-lucide-download' : 'i-lucide-circle-help',
                label: collapsed ? undefined : 'v' + (appVersion || '…')
              }"
              :color="updateAvailable ? 'success' : 'neutral'"
              :variant="updateAvailable ? 'subtle' : 'ghost'"
              block
              :square="collapsed"
              :loading="checkingUpdate"
              class="mt-1 justify-start data-[state=open]:bg-elevated"
              :class="[!collapsed && 'py-2']"
              @click="updateAvailable ? gotoDownload() : checkUpdate()"
            >
              <template #trailing>
                <UBadge
                  v-if="updateAvailable && !collapsed"
                  color="success"
                  variant="subtle"
                  icon="i-lucide-download"
                  :label="'新版 ' + updateVersion"
                />
              </template>
            </UButton>
          </div>
        </template>

        <template #footer="{ collapsed }">
          <UDropdownMenu
            :items="roleMenuItems"
            :content="{ align: 'start', collisionPadding: 12 }"
            :ui="{ content: collapsed ? 'w-40' : 'w-(--reka-dropdown-menu-trigger-width)' }"
          >
            <UButton
              v-bind="{
                icon: 'i-lucide-shield-check',
                label: collapsed
                  ? undefined
                  : currentAccount
                    ? ROLE_TEXT[currentAccount.role]
                    : '管理员',
                trailingIcon: collapsed ? undefined : 'i-lucide-chevrons-up-down'
              }"
              color="neutral"
              variant="ghost"
              block
              :square="collapsed"
              class="data-[state=open]:bg-elevated"
              :class="[!collapsed && 'py-2']"
              :ui="{ trailingIcon: 'text-dimmed' }"
            />
          </UDropdownMenu>
        </template>
      </UDashboardSidebar>

      <!-- 宽表页面由表格自身承担双向滚动，避免横向滚动条落到整页内容底部。 -->
      <UDashboardPanel
        id="main"
        :ui="{
          root: 'min-h-0 h-full',
          body:
            current === 'dyf-table' ? 'min-h-0 overflow-hidden' : undefined
        }"
      >
        <template #header>
          <UDashboardNavbar
            :title="
              current === 'batch'
                ? '批次管理'
                : current.startsWith('dyf-')
                  ? '德育分'
                  : current === 'audit'
                      ? '操作记录'
                      : '设置'
            "
          >
            <template #leading>
              <UDashboardSidebarCollapse />
            </template>
            <template #right>
              <GuardedButton
                v-if="current === 'batch' && role === 'level1'"
                label="创建批次"
                icon="i-lucide-plus"
                :disabled="batchReadonly"
                disabled-reason="授权已过期，请到“设置 - 授权信息”更新授权后再创建批次"
                @click="batchCreate?.()"
              />

              <!-- 德育分功能区（决策 #19）：批次选择 + 导入 + 确认/导出 + 导出表格；总览页仅批次选择。计算排名移至「总体情况」功能区（issue #6）。 -->
              <template v-if="current.startsWith('dyf-')">
                <div class="flex items-center gap-2">
                  <div class="w-72">
                    <BatchSelect v-model="dyfState.batchId" :batches="dyfState.batches" />
                  </div>
                  <template v-if="current !== 'dyf-overview'">
                    <GuardedButton
                      label="导入"
                      icon="i-lucide-file-up"
                      :loading="dyfState.importing"
                      :disabled="!canImportDyf"
                      :disabled-reason="importDisabledReason"
                      @click="onImportClick"
                    />
                    <UBadge
                      v-if="exporting && exportProgressLabel"
                      color="primary"
                      variant="subtle"
                      icon="i-lucide-loader-circle"
                      :label="exportProgressLabel"
                    />
                    <template v-if="exported">
                      <UBadge
                        color="success"
                        variant="subtle"
                        icon="i-lucide-lock"
                        label="已导出"
                      />
                      <GuardedButton
                        v-if="role !== 'level1'"
                        label="重新导出数据"
                        icon="i-lucide-file-down"
                        variant="outline"
                        :loading="exporting"
                        :disabled="expired"
                        disabled-reason="授权已过期，请到“设置 - 授权信息”更新授权后再导出"
                        @click="reExportData"
                      />
                    </template>
                    <GuardedButton
                      v-else
                      :label="
                        role === 'level1'
                          ? '最终确认'
                          : role === 'level2'
                            ? '导出本级数据'
                            : '导出整班'
                      "
                      icon="i-lucide-package-check"
                      :loading="exporting"
                      :disabled="!canExportWholeClass"
                      :disabled-reason="wholeClassDisabledReason"
                      @click="requestWholeClassExport"
                    />
                    <GuardedButton
                      label="导出表格"
                      icon="i-lucide-file-down"
                      :loading="exporting"
                      :disabled="!canExportTable"
                      :disabled-reason="tableDisabledReason"
                      @click="exportTableXlsx"
                    />
                  </template>
                </div>
              </template>
            </template>
          </UDashboardNavbar>

          <UDashboardToolbar v-if="current.startsWith('dyf-') || current.startsWith('settings')">
            <!-- -mx-1 对齐 DashboardSidebarCollapse 按钮（模板 settings.vue 同款）；
                 德育分：左侧子页标签栏 + 右侧「本页专属」动作（总体情况=补全基础分；审核=确认单/修正姓名） -->
            <template v-if="current.startsWith('dyf-')">
              <UNavigationMenu :items="dyfTabItems" highlight class="-mx-1 flex-1" />
              <template v-if="current === 'dyf-table'">
                <GuardedButton
                  label="计算排名"
                  icon="i-lucide-list-ordered"
                  variant="outline"
                  :loading="ranking"
                  :disabled="!canComputeRanking"
                  :disabled-reason="rankingDisabledReason"
                  @click="computeRankingNow"
                />
                <UBadge
                  v-if="canComputeRanking && !rankingFresh"
                  color="warning"
                  variant="subtle"
                  icon="i-lucide-triangle-alert"
                  label="排名待更新"
                />
              </template>
              <GuardedButton
                v-if="current === 'dyf-table'"
                label="一键补全基础分"
                icon="i-lucide-wand-2"
                variant="outline"
                :loading="fillingBase"
                :disabled="!canImportDyf"
                :disabled-reason="importDisabledReason"
                @click="fillBaseScores"
              />
              <template v-if="current === 'dyf-review'">
                <GuardedButton
                  label="查看确认单"
                  icon="i-lucide-file-signature"
                  variant="outline"
                  :disabled="!reviewHasSlip"
                  disabled-reason="请先在左侧选择一名已提交签字确认单的学生"
                  @click="reviewViewSlip?.()"
                />
                <GuardedButton
                  label="查看时间线"
                  icon="i-lucide-history"
                  variant="outline"
                  :disabled="!reviewCanTimeline"
                  disabled-reason="请先在左侧选择一名学生"
                  @click="reviewViewTimeline?.()"
                />
                <GuardedButton
                  label="修正姓名"
                  icon="i-lucide-user-pen"
                  variant="ghost"
                  :disabled="!reviewCanCorrect"
                  disabled-reason="请选择未确认且当前可编辑的学生；已导出或授权过期时不能修正姓名"
                  @click="reviewCorrectName?.()"
                />
              </template>
            </template>
            <UNavigationMenu v-else :items="settingsTabItems" highlight class="-mx-1 flex-1" />
          </UDashboardToolbar>
        </template>

        <template #body>
          <UAlert
            v-if="expired"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            title="授权已过期"
            description="当前仅可查看历史数据，无法进行操作。请在设置中续期或更换授权设备。"
            class="mb-4"
          />
          <FileDropOverlay :active="dragging && !current.startsWith('settings')" />
          <BatchView v-if="current === 'batch'" :readonly="expired" />
          <OverviewView v-else-if="current === 'dyf-overview'" :readonly="expired" />
          <TableView v-else-if="current === 'dyf-table'" :readonly="expired" />
          <ReviewView v-else-if="current === 'dyf-review'" :readonly="expired" :role="role" />
          <AuditView v-else-if="current === 'audit'" />
          <SettingsView v-else :tab="currentSettingsTab" />
        </template>
      </UDashboardPanel>
    </UDashboardGroup>

    <!-- 二次确认（整班导出 / 撤销导出 / 一级覆盖导入） -->
    <UModal v-model:open="confirmOpen" :title="confirmState.title" :ui="{ footer: 'justify-end' }">
      <template #body>
        <UAlert
          v-if="confirmState.confirmColor === 'error'"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :description="confirmState.description"
        />
        <p v-else class="text-sm text-muted">{{ confirmState.description }}</p>
      </template>
      <template #footer>
        <UButton label="取消" color="neutral" variant="outline" @click="cancelConfirm" />
        <UButton
          :label="confirmState.confirmLabel ?? '确认'"
          :color="confirmState.confirmColor ?? 'primary'"
          @click="runConfirm"
        />
      </template>
    </UModal>

    <!-- 导入结果弹窗（决策 #19）：一次导入完成后自动弹出，替代页面内联结果块 -->
    <ImportResultModal v-model:open="importResultOpen" :results="dyfState.results" />
  </div>
</template>
