<script setup lang="ts">
/**
 * 德育分审核页（决策 #16/#19/#17）：左侧学生列表（按班级分组、可展开/收缩、滚动呈现、无分页）
 * + 右侧两栏审核（左=管理端项目/学生端不可申请，右=学生端申请项目）。
 * - 批次选择 / 导入 / 整班导出在标题栏功能区（AppLayout 共享状态 dyfState）；
 * - 德育分排名已在总体情况表格中查看，本页不再提供排名 tab（决策 #19）；
 * - 确认 = 整班一次性确认（导出），批次打上班级端审核标记后本端锁定（决策 #17）。
 */
import {
  computed,
  inject,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
  watchEffect
} from 'vue'
import type { Ref } from 'vue'
import type { ApplyDetail, ApplyListItem, ApplyScoreItem } from '../../../preload/types'
import type { TimelineEvent } from '@sces/shared'
import { useToast } from '@nuxt/ui/composables'
import { ipcErrorMessage } from '../utils/ipc'
import { bumpDyfRefresh, currentBatch, dyfState, isDyfExported } from '../stores/dyf-state'
import ImageViewer from '../components/ImageViewer.vue'

// 授权过期后只读：审核/修正/导入全部禁用（查看不受影响）
const props = withDefaults(
  defineProps<{ readonly?: boolean; role?: 'level1' | 'level2' | 'level3' }>(),
  { readonly: false, role: 'level1' }
)

const toast = useToast()

const selectedBatch = currentBatch

/** 是否已完成班级端审核（整班导出，决策 #17）：导出后本端锁定，响应式。 */
const exported = isDyfExported

// 审核列表（左侧）：全部学生，按班级分组，可展开/收缩，滚动呈现（决策 #19）
const search = ref('')
const applies = ref<ApplyListItem[]>([])
const loading = ref(false)
let appliesRequestSerial = 0
const expanded = reactive<Record<string, boolean>>({})

/** 按班级分组（保持出现顺序）。 */
const classGroups = computed(() => {
  const order: string[] = []
  const map: Record<string, ApplyListItem[]> = {}
  for (const a of applies.value) {
    const key = a.className || '未分班'
    if (!map[key]) {
      map[key] = []
      order.push(key)
    }
    map[key].push(a)
  }
  return order.map((cls) => ({ cls, items: map[cls] }))
})

function toggleGroup(cls: string): void {
  expanded[cls] = !expanded[cls]
}

// 审核详情（右侧）
const selectedApplyId = ref('')
const detail = ref<ApplyDetail | null>(null)
const scoreDraft = ref<Record<string, number>>({})

// 图片查看器（证明材料 / 确认单共用，issue #5：居中可缩放可保存）
const viewerOpen = ref(false)
const viewerTitle = ref('')
const viewerImages = ref<{ src: string; label?: string }[]>([])
const viewerSaveName = ref('图片')

// 分数自动保存（issue #2：无「开始审核 / 保存分数」按钮，改动即存）
const savedScore = ref<Record<string, number>>({})
const savedAt = ref(0)
const saveTimers: Record<string, ReturnType<typeof setTimeout>> = {}
const pendingSaveItems = new Map<string, ApplyScoreItem>()
let loadedBatchId = ''

// 功能区动作（AppLayout 提供 ref，本页选中学生后填充：查看确认单 / 修正姓名）
const reviewViewSlip = inject<Ref<(() => void) | null>>('reviewViewSlip', ref(null))
const reviewViewTimeline = inject<Ref<(() => void) | null>>('reviewViewTimeline', ref(null))
const reviewCorrectName = inject<Ref<(() => void) | null>>('reviewCorrectName', ref(null))
const reviewHasSlip = inject<Ref<boolean>>('reviewHasSlip', ref(false))
const reviewCanTimeline = inject<Ref<boolean>>('reviewCanTimeline', ref(false))
const reviewCanCorrect = inject<Ref<boolean>>('reviewCanCorrect', ref(false))

const timelineOpen = ref(false)
const timelineLoading = ref(false)
const timelineEvents = ref<TimelineEvent[]>([])

function timelineLabel(event: TimelineEvent): string {
  if (event.action === 'student.entered') return '进入批次'
  if (event.action === 'student.exported') return `导出第 ${event.revision ?? '?'} 版`
  if (event.action === 'admin.imported') return '导入'
  if (event.action === 'admin.modified') return '最后修改'
  if (event.action === 'admin.exported') return '导出'
  if (event.action === 'admin.confirmed') return '确认'
  if (event.action === 'admin.confirmation-revoked') return '撤销确认'
  return event.action
}

function timelineActor(event: TimelineEvent): string {
  if (event.actorType === 'student') return '学生端'
  if (event.role === 'level3') return '班级管理员'
  if (event.role === 'level2') return '年级管理员'
  if (event.role === 'level1') return '单位管理员'
  return '系统'
}

function timelineChanges(
  event: TimelineEvent
): Array<{ field?: string; before?: unknown; after?: unknown }> {
  return Array.isArray(event.detail?.changes)
    ? (event.detail?.changes as Array<{ field?: string; before?: unknown; after?: unknown }>)
    : []
}

function openTimeline(): void {
  void loadTimeline()
}

async function loadTimeline(): Promise<void> {
  if (!detail.value) return
  timelineLoading.value = true
  try {
    timelineEvents.value = await window.api.apply.timeline(dyfState.batchId, detail.value.applyId)
    timelineOpen.value = true
  } catch (err) {
    toast.add({ title: '时间线加载失败', description: ipcErrorMessage(err), color: 'error' })
  } finally {
    timelineLoading.value = false
  }
}

// 修正姓名（错误处理，仅一次）
const correctOpen = ref(false)
const correctNameInput = ref('')
const correcting = ref(false)

/** 按类别分组（保持模板顺序）。 */
interface ScoreGroup {
  category: string
  items: ApplyScoreItem[]
}
function groupByCategory(items: ApplyScoreItem[]): ScoreGroup[] {
  const order: string[] = []
  const map: Record<string, ApplyScoreItem[]> = {}
  for (const it of items) {
    if (!map[it.category]) {
      map[it.category] = []
      order.push(it.category)
    }
    map[it.category].push(it)
  }
  return order.map((c) => ({ category: c, items: map[c] }))
}

/** 左列：管理端项目（学生端不可申请；含模板未定义、学生导入出现的核对项）。 */
const adminGroups = computed(() =>
  groupByCategory((detail.value?.scores ?? []).filter((s) => !s.studentApplicable))
)

/** 右列：学生端申请项目（学生已申请；或未申请但当前角色可加分——供管理员补录加分）。 */
const studentGroups = computed(() =>
  groupByCategory(
    (detail.value?.scores ?? []).filter((s) => s.studentApplicable && (s.applied || canAdd(s)))
  )
)

async function loadApplies(): Promise<void> {
  if (!dyfState.batchId) {
    applies.value = []
    return
  }
  if (loadedBatchId && loadedBatchId !== dyfState.batchId) {
    await flushPendingScoreSaves()
    selectedApplyId.value = ''
    detail.value = null
  }
  loadedBatchId = dyfState.batchId
  loading.value = true
  const serial = ++appliesRequestSerial
  try {
    const r = await window.api.apply.list(dyfState.batchId, {
      search: search.value || undefined,
      limit: 10000
    })
    if (serial !== appliesRequestSerial) return
    applies.value = r.items
    // 新班级默认展开
    for (const g of classGroups.value) {
      if (expanded[g.cls] === undefined) expanded[g.cls] = true
    }
    if (!selectedApplyId.value && r.items.length) {
      await selectApply(r.items[0])
    } else if (!r.items.length) {
      selectedApplyId.value = ''
      detail.value = null
    }
  } catch (err) {
    if (serial !== appliesRequestSerial) return
    toast.add({ title: '加载申请失败', description: ipcErrorMessage(err), color: 'error' })
  } finally {
    if (serial === appliesRequestSerial) loading.value = false
  }
}

async function selectApply(item: ApplyListItem): Promise<void> {
  if (selectedApplyId.value === item.applyId && detail.value) return
  timelineOpen.value = false
  await flushPendingScoreSaves()
  selectedApplyId.value = item.applyId
  await openDetail(item.applyId)
}

async function openDetail(applyId: string): Promise<void> {
  try {
    detail.value = await window.api.apply.detail(dyfState.batchId, applyId)
    const draft: Record<string, number> = {}
    for (const s of detail.value.scores) draft[s.itemCode] = s.finalScore ?? s.appliedScore ?? 0
    scoreDraft.value = draft
    savedScore.value = { ...draft }
  } catch (err) {
    toast.add({ title: '加载详情失败', description: ipcErrorMessage(err), color: 'error' })
  }
}

async function refreshDetail(): Promise<void> {
  if (!selectedApplyId.value) return
  await openDetail(selectedApplyId.value)
}

/** 当前角色可设置的分数上限。 */
function maxScoreFor(it: ApplyScoreItem): number | undefined {
  // 非学生申请项（管理端补录，如基础分）：任何角色都可录入到满分（不受加分限制）
  if (!it.studentApplicable) return it.maxScore ?? undefined
  // 学生申请项：可加分者到满分，否则封顶在申请分（只能扣分，且不低于已存分，避免夹没一级补录/加分）
  if (props.role === 'level1' || (props.role === 'level2' && it.allowAdd === true)) {
    return it.maxScore ?? undefined
  }
  const applied = it.appliedScore ?? 0
  return Math.max(applied, it.finalScore ?? applied)
}

/** 当前角色能否为该项目加分（决定「可加分」标识与未申请项目是否展示）。 */
function canAdd(it: ApplyScoreItem): boolean {
  // 非学生申请项（管理端补录）：任何角色都可录入，不算「加分」
  if (!it.studentApplicable) return false
  return props.role === 'level1' || (props.role === 'level2' && it.allowAdd === true)
}

/** 数字格式化：限定小数位数，驱动 reka-ui 解析/吸附精度，避免把小数吸附成整数。 */
function fmtFor(it: ApplyScoreItem): Intl.NumberFormatOptions {
  return { minimumFractionDigits: 0, maximumFractionDigits: it.decimals ?? 0 }
}

/** 分数输入：更新草稿并防抖自动保存该条明细（issue #2：改动即存，无需按钮）。 */
function onScoreInput(item: ApplyScoreItem, value: number | null | undefined): void {
  const raw = Number(value ?? 0)
  const d = item.decimals ?? 0
  const val = Number.isFinite(raw) ? Number(raw.toFixed(d)) : 0
  scoreDraft.value[item.itemCode] = val
  if (props.readonly || exported.value || detail.value?.status === 'confirmed') return
  clearTimeout(saveTimers[item.itemCode])
  pendingSaveItems.set(item.itemCode, item)
  saveTimers[item.itemCode] = setTimeout(() => {
    delete saveTimers[item.itemCode]
    pendingSaveItems.delete(item.itemCode)
    void saveOne(item)
  }, 500)
}

async function flushPendingScoreSaves(): Promise<void> {
  const items = [...pendingSaveItems.values()]
  pendingSaveItems.clear()
  for (const item of items) {
    clearTimeout(saveTimers[item.itemCode])
    delete saveTimers[item.itemCode]
    await saveOne(item)
  }
}

/** 保存单条明细（自动保存）：失败则回退到已存值并提示，避免 UI 与实际不一致。 */
async function saveOne(item: ApplyScoreItem): Promise<void> {
  if (!detail.value) return
  const val = scoreDraft.value[item.itemCode]
  if (val === savedScore.value[item.itemCode]) return
  try {
    await window.api.apply.setScore(dyfState.batchId, detail.value.applyId, item.itemCode, val)
    savedScore.value[item.itemCode] = val
    savedAt.value = Date.now()
    // 三页（总览/总体情况/审核列表含本页左列总分）同步刷新
    bumpDyfRefresh()
  } catch (err) {
    scoreDraft.value[item.itemCode] = savedScore.value[item.itemCode] ?? 0
    toast.add({ title: '保存失败', description: ipcErrorMessage(err), color: 'error' })
  }
}

/** 修正姓名（错误处理：学生输错/改名/录入错误，仅一次）。 */
function openCorrectName(): void {
  correctNameInput.value = detail.value?.name ?? ''
  correctOpen.value = true
}

async function submitCorrectName(): Promise<void> {
  if (!detail.value) return
  correcting.value = true
  try {
    await window.api.import.correctName(
      dyfState.batchId,
      detail.value.studentId,
      correctNameInput.value
    )
    toast.add({ title: '姓名已修正', description: '修正后该学号以新姓名为准', color: 'success' })
    correctOpen.value = false
    await refreshDetail()
    await loadApplies()
    bumpDyfRefresh()
  } catch (err) {
    toast.add({ title: '修正失败', description: ipcErrorMessage(err), color: 'error' })
  } finally {
    correcting.value = false
  }
}

/** 查看证明材料（evidence → data URL），用图片查看器居中可缩放展示。 */
async function viewEvidence(item: ApplyScoreItem): Promise<void> {
  if (!item.evidenceFiles || item.evidenceFiles.length === 0) return
  const images: { src: string }[] = []
  for (const p of item.evidenceFiles) {
    const dataUrl = await window.api.evidence.read(p)
    if (dataUrl) images.push({ src: dataUrl })
  }
  viewerImages.value = images
  viewerTitle.value = `证明材料 ${item.itemCode} ${item.description || ''}`.trim()
  viewerSaveName.value = `证明材料-${detail.value?.studentId ?? ''}-${item.itemCode}`
  viewerOpen.value = true
}

/** 查看确认单（学生端签字确认单截图，附在申请文件中）。 */
async function viewConfirmSlip(): Promise<void> {
  if (!detail.value?.confirmSlip) return
  const dataUrl = await window.api.evidence.read(detail.value.confirmSlip)
  if (!dataUrl) {
    toast.add({ title: '确认单不可用', description: '未找到确认单文件', color: 'warning' })
    return
  }
  viewerImages.value = [{ src: dataUrl }]
  viewerTitle.value = `确认单 - ${detail.value.name}`
  viewerSaveName.value = `确认单-${detail.value.studentId}`
  viewerOpen.value = true
}

function formatTime(ts?: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function doSearch(): void {
  void loadApplies()
}

// 批次切换 / 导入 / 整班导出 → 刷新
watch(
  () => dyfState.refreshTick,
  () => {
    void loadApplies()
  }
)

onMounted(async () => {
  await loadApplies()
})

/** 头部总分：优先取左列列表该生实时总分（自动保存后随刷新更新），回退详情总分。 */
const liveTotal = computed(() => {
  const it = applies.value.find((a) => a.applyId === selectedApplyId.value)
  return it?.dyfTotal ?? detail.value?.dyfTotal ?? 0
})

/** 最近自动保存时间提示。 */
const savedAtText = computed(() => (savedAt.value ? formatTime(savedAt.value) : ''))

// 把「查看确认单 / 修正姓名」动作与可用状态挂到 AppLayout 功能区（标题栏 tab 右侧）
watchEffect(() => {
  reviewViewSlip.value = viewConfirmSlip
  reviewViewTimeline.value = openTimeline
  reviewCorrectName.value = openCorrectName
  reviewHasSlip.value = !!detail.value?.confirmSlip
  reviewCanTimeline.value = !!detail.value
  reviewCanCorrect.value =
    !!detail.value && !props.readonly && !exported.value && detail.value.status !== 'confirmed'
})
onBeforeUnmount(() => {
  void flushPendingScoreSaves()
  reviewViewSlip.value = null
  reviewViewTimeline.value = null
  reviewCorrectName.value = null
  reviewHasSlip.value = false
  reviewCanTimeline.value = false
  reviewCanCorrect.value = false
})
</script>

<template>
  <div class="page h-full min-h-0">
    <UAlert
      v-if="props.readonly"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="授权已过期，仅可查看"
      description="审核、导出、撤销、姓名修正与导入已禁用。"
    />

    <!-- 批次状态提示（紧凑，决策 #19） -->
    <UAlert
      v-if="selectedBatch && selectedBatch.status !== 'active'"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="
        selectedBatch.status === 'draft' ? '批次未开放，激活后可导入' : '批次已结束，目前仅能查看'
      "
    />

    <UAlert
      v-if="exported"
      color="success"
      variant="subtle"
      icon="i-lucide-lock"
      title="本班已完成班级端审核并整班导出"
      description="导出后本端不可再导入、修改或处理冲突；如需调整请联系一级管理员撤销导出。"
    />

    <!-- 审核：左侧学生列表（按班级分组）+ 右侧两栏 -->
    <div class="review-layout">
      <!-- 左列：学生列表（按班级分组，可展开/收缩，滚动） -->
      <div class="student-pane">
        <div class="flex gap-2">
          <UInput
            v-model="search"
            placeholder="搜索学号 / 姓名"
            icon="i-lucide-search"
            class="flex-1"
            @keyup.enter="doSearch"
          />
          <UButton label="搜索" variant="outline" size="sm" @click="doSearch" />
        </div>
        <div class="student-list">
          <template v-if="classGroups.length">
            <div v-for="g in classGroups" :key="g.cls" class="class-group">
              <button type="button" class="class-group-head" @click="toggleGroup(g.cls)">
                <span class="chevron" :class="{ open: expanded[g.cls] }">▸</span>
                <span class="font-medium">{{ g.cls }}</span>
                <span class="group-count">{{ g.items.length }}</span>
              </button>
              <div v-if="expanded[g.cls]" class="class-group-body">
                <button
                  v-for="item in g.items"
                  :key="item.applyId"
                  type="button"
                  class="student-item"
                  :class="{ active: selectedApplyId === item.applyId }"
                  @click="selectApply(item)"
                >
                  <div class="flex items-center justify-between gap-2">
                    <span class="truncate font-medium">{{ item.name }}</span>
                  </div>
                  <div class="student-item-sub">{{ item.studentId }}</div>
                </button>
              </div>
            </div>
          </template>
          <div v-else class="list-empty">
            <span v-if="loading">加载中…</span>
            <span v-else>暂无申请</span>
          </div>
        </div>
      </div>

      <!-- 右侧：详情 + 两栏分数 -->
      <div class="detail-pane">
        <template v-if="detail">
          <div class="detail-head">
            <div class="info-grid">
              <span class="info-item"><b>姓名</b>{{ detail.name }}</span>
              <span class="info-item"><b>学号</b>{{ detail.studentId }}</span>
              <span class="info-item"><b>班级</b>{{ detail.className || '—' }}</span>
              <span class="info-item"><b>年级</b>{{ detail.grade || '—' }}</span>
              <span class="info-item"><b>专业</b>{{ detail.major || '—' }}</span>
              <span class="info-item"><b>手机号</b>{{ detail.phone || '—' }}</span>
              <span class="info-item"><b>版本</b>第 {{ detail.currentRevision }} 版</span>
              <span class="info-item"
                ><b>总分</b><span class="font-medium">{{ liveTotal }}</span></span
              >
            </div>
            <div class="flex flex-col items-end gap-1">
              <span v-if="detail.status === 'confirmed'" class="text-xs text-dimmed"
                >确认于 {{ formatTime(detail.confirmAt) }}</span
              >
            </div>
          </div>

          <div class="scores-grid">
            <!-- 左列：管理端项目 -->
            <div class="score-col">
              <div class="col-title">
                管理端项目
                <span class="col-sub">学生端不可申请</span>
              </div>
              <div class="col-scroll">
                <template v-if="adminGroups.length">
                  <div v-for="g in adminGroups" :key="`a-${g.category}`" class="score-group">
                    <div class="group-title">{{ g.category }}</div>
                    <div v-for="it in g.items" :key="it.itemCode" class="score-item">
                      <div class="score-item-head">
                        <span class="item-code">{{ it.itemCode }}</span>
                        <span class="item-desc">{{ it.description || '—' }}</span>
                        <UBadge
                          v-if="it.allowAdd"
                          size="xs"
                          color="info"
                          variant="subtle"
                          label="可加分"
                          class="shrink-0"
                        />
                        <UButton
                          v-if="it.evidenceFiles && it.evidenceFiles.length"
                          size="xs"
                          variant="ghost"
                          icon="i-lucide-image"
                          label="证明"
                          class="shrink-0"
                          @click="viewEvidence(it)"
                        />
                      </div>
                      <div class="score-item-body">
                        <span v-if="it.applied" class="applied">申请 {{ it.appliedScore }} 分</span>
                        <span v-else class="applied text-dimmed">未申请（管理端补录）</span>
                        <UInputNumber
                          :model-value="scoreDraft[it.itemCode]"
                          @update:model-value="(v) => onScoreInput(it, v)"
                          :min="0"
                          :max="maxScoreFor(it)"
                          :step="it.step"
                          :format-options="fmtFor(it)"
                          :disabled="detail.status === 'confirmed' || exported || props.readonly"
                          class="w-28"
                          size="sm"
                        />
                      </div>
                    </div>
                  </div>
                </template>
                <div v-else class="col-empty">无管理端项目</div>
              </div>
            </div>

            <!-- 右列：学生端申请项目 -->
            <div class="score-col">
              <div class="col-title">
                学生端申请项目
                <span class="col-sub">学生端可申请</span>
              </div>
              <div class="col-scroll">
                <template v-if="studentGroups.length">
                  <div v-for="g in studentGroups" :key="`s-${g.category}`" class="score-group">
                    <div class="group-title">{{ g.category }}</div>
                    <div v-for="it in g.items" :key="it.itemCode" class="score-item">
                      <div class="score-item-head">
                        <span class="item-code">{{ it.itemCode }}</span>
                        <span class="item-desc">{{ it.description || '—' }}</span>
                        <UBadge
                          v-if="it.allowAdd && canAdd(it)"
                          size="xs"
                          color="info"
                          variant="subtle"
                          label="可加分"
                          class="shrink-0"
                        />
                        <UButton
                          v-if="it.evidenceFiles && it.evidenceFiles.length"
                          size="xs"
                          variant="ghost"
                          icon="i-lucide-image"
                          label="证明"
                          class="shrink-0"
                          @click="viewEvidence(it)"
                        />
                      </div>
                      <div class="score-item-body">
                        <span v-if="it.applied" class="applied">申请 {{ it.appliedScore }} 分</span>
                        <span v-else class="applied text-dimmed">未申请（可补录加分）</span>
                        <UInputNumber
                          :model-value="scoreDraft[it.itemCode]"
                          @update:model-value="(v) => onScoreInput(it, v)"
                          :min="0"
                          :max="maxScoreFor(it)"
                          :step="it.step"
                          :format-options="fmtFor(it)"
                          :disabled="detail.status === 'confirmed' || exported || props.readonly"
                          class="w-28"
                          size="sm"
                        />
                      </div>
                    </div>
                  </div>
                </template>
                <div v-else class="col-empty">该学生暂无申请项目</div>
              </div>
            </div>
          </div>

          <div class="actions">
            <template v-if="detail.status === 'reviewing'">
              <span class="text-sm text-dimmed">
                <template v-if="props.readonly || exported">当前仅可查看，不能修改分数</template>
                <template v-else
                  >分数修改后自动保存<template v-if="savedAtText"
                    >（最近保存 {{ savedAtText }}）</template
                  ></template
                >
              </span>
            </template>
            <span v-else-if="detail.status === 'confirmed'" class="text-sm text-dimmed"
              >已随整班导出确认，德育分冻结；如需调整请撤销导出</span
            >
          </div>
        </template>
        <div v-else class="detail-empty">请在左侧选择一名学生查看详情</div>
      </div>
    </div>

    <!-- 图片查看器（证明材料 / 确认单，issue #5：居中可缩放可保存） -->
    <ImageViewer
      v-model:open="viewerOpen"
      :title="viewerTitle"
      :images="viewerImages"
      :save-name="viewerSaveName"
      allow-save
    />

    <!-- 修正姓名 -->
    <UModal
      v-model:open="timelineOpen"
      title="德育分时间线"
      :description="detail ? `${detail.name}（${detail.studentId}）` : ''"
    >
      <template #body>
        <div v-if="timelineLoading" class="timeline-empty">加载中...</div>
        <div v-else-if="timelineEvents.length" class="timeline-list">
          <div v-for="event in timelineEvents" :key="event.eventId" class="timeline-row">
            <div class="timeline-dot" />
            <div class="timeline-content">
              <div class="timeline-title">
                <span class="font-medium">{{ timelineActor(event) }}</span>
                <span>{{ timelineLabel(event) }}</span>
                <UBadge
                  v-if="event.revision"
                  size="xs"
                  color="neutral"
                  variant="subtle"
                  :label="`第 ${event.revision} 版`"
                />
              </div>
              <div class="timeline-time">{{ formatTime(event.occurredAt) }}</div>
              <div
                v-if="event.action === 'admin.modified' && timelineChanges(event).length"
                class="timeline-detail"
              >
                <span
                  v-for="change in timelineChanges(event)"
                  :key="`${event.eventId}-${change.field}`"
                >
                  {{ change.field }}：{{ change.before }} → {{ change.after }}
                </span>
              </div>
            </div>
          </div>
        </div>
        <div v-else class="timeline-empty">暂无时间记录</div>
      </template>
    </UModal>

    <UModal
      v-model:open="correctOpen"
      title="修正学生姓名"
      :description="`学号 ${detail?.studentId ?? ''}，仅允许修正一次，修正前后姓名都会记录在案`"
      :ui="{ footer: 'justify-end' }"
    >
      <template #body>
        <div class="form">
          <UFormField label="新姓名" required>
            <UInput v-model="correctNameInput" placeholder="输入正确姓名" class="w-full" />
          </UFormField>
          <UAlert
            color="warning"
            variant="soft"
            icon="i-lucide-triangle-alert"
            title="修正后不可再次修改"
            description="修正后该学号以新姓名为准，再导入旧姓名的文件将被拒绝。"
          />
        </div>
      </template>
      <template #footer>
        <UButton label="取消" color="neutral" variant="outline" @click="correctOpen = false" />
        <UButton label="确认修正" :loading="correcting" @click="submitCorrectName" />
      </template>
    </UModal>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
/* 审核布局：左学生列表（按班级分组）+ 右详情（详情内两栏分数） */
.review-layout {
  display: flex;
  flex: 1;
  min-height: 0;
  gap: 12px;
}
.student-pane {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 280px;
  min-height: 0;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  padding: 10px;
  background: color-mix(in oklab, var(--ui-bg-elevated) 60%, transparent);
}
.student-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.class-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.class-group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: 8px;
  text-align: left;
  cursor: pointer;
  border: 1px solid transparent;
  font-size: 13px;
}
.class-group-head:hover {
  background: var(--ui-bg-elevated);
}
.chevron {
  display: inline-block;
  transition: transform 0.15s;
  color: var(--ui-text-dimmed);
  font-size: 10px;
}
.chevron.open {
  transform: rotate(90deg);
}
.group-count {
  font-size: 11px;
  color: var(--ui-text-dimmed);
  background: var(--ui-bg-elevated);
  border-radius: 999px;
  padding: 0 7px;
}
.class-group-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.student-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 10px;
  border-radius: 8px;
  text-align: left;
  cursor: pointer;
  border: 1px solid transparent;
}
.student-item:hover {
  background: var(--ui-bg-elevated);
}
.student-item.active {
  border-color: var(--ui-primary);
  background: color-mix(in oklab, var(--ui-primary) 10%, transparent);
}
.student-item-sub {
  font-size: 12px;
  color: var(--ui-text-dimmed);
}
.list-empty,
.detail-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 0;
  font-size: 13px;
  color: var(--ui-text-dimmed);
}
.detail-pane {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  gap: 10px;
}
.detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  background: color-mix(in oklab, var(--ui-bg-elevated) 60%, transparent);
}
.info-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, auto));
  gap: 6px 18px;
}
.info-item {
  font-size: 13px;
  color: var(--ui-text-dimmed);
  white-space: nowrap;
}
.info-item b {
  color: var(--ui-text);
  font-weight: 500;
  margin-right: 6px;
}
.scores-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  flex: 1;
  min-height: 0;
}
.score-col {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  overflow: hidden;
  background: color-mix(in oklab, var(--ui-bg-elevated) 60%, transparent);
}
.col-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 12px;
  font-size: 13px;
  font-weight: 600;
  border-bottom: 1px solid var(--ui-border);
}
.col-sub {
  font-size: 12px;
  font-weight: 400;
  color: var(--ui-text-dimmed);
}
.col-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 12px 12px;
}
.col-empty {
  padding: 32px 0;
  text-align: center;
  font-size: 13px;
  color: var(--ui-text-dimmed);
}
.score-group {
  margin-bottom: 10px;
}
.group-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-muted);
  margin: 10px 0 6px;
}
.score-item {
  padding: 8px 10px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  margin-bottom: 6px;
  background: var(--ui-bg);
}
.score-item-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.item-code {
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-primary);
  white-space: nowrap;
}
.item-desc {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--ui-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.score-item-body {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.applied {
  font-size: 12px;
  color: var(--ui-text-dimmed);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.evidence-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  max-height: 60vh;
  overflow-y: auto;
}
.evidence-img {
  width: 100%;
  border-radius: 8px;
  border: 1px solid var(--ui-border);
}
.timeline-list {
  display: flex;
  flex-direction: column;
  gap: 0;
  max-height: 60vh;
  overflow-y: auto;
  padding: 4px 6px;
}
.timeline-row {
  position: relative;
  display: flex;
  gap: 12px;
  min-height: 58px;
}
.timeline-row:not(:last-child)::before {
  content: '';
  position: absolute;
  left: 5px;
  top: 14px;
  bottom: 0;
  width: 1px;
  background: var(--ui-border);
}
.timeline-dot {
  z-index: 1;
  width: 11px;
  height: 11px;
  margin-top: 4px;
  flex: 0 0 11px;
  border: 2px solid var(--ui-primary);
  border-radius: 50%;
  background: var(--ui-bg);
}
.timeline-content {
  min-width: 0;
  padding-bottom: 14px;
}
.timeline-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
  font-size: 13px;
}
.timeline-time,
.timeline-detail {
  margin-top: 3px;
  font-size: 12px;
  color: var(--ui-text-dimmed);
}
.timeline-detail {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.timeline-empty {
  padding: 28px 0;
  text-align: center;
  color: var(--ui-text-dimmed);
  font-size: 13px;
}
</style>
