<script setup lang="ts">
/**
 * 德育分总体情况页（决策 #16/#19）：全部学生明细大表格 + 导入结果 + 学号冲突处理。
 * - 批次选择 / 导入 / 导出在标题栏功能区（AppLayout 共享状态 dyfState）；
 * - 表格：模板全量条目为列（按类别分组，可勾选显示哪些类别，全不选=仅基本信息+总分/排名），
 *   全部学生滚动呈现（不分页），学号/姓名/总分/班排/专排可排序（增/降）；
 * - 一、二级管理员可筛选班级（展示一个或多个）；
 * - 班级端审核（整班导出）后本端锁定：不可再导入、处理冲突（仅可查看）。
 */
import { computed, h, onMounted, ref, watch } from 'vue'
import type { ColumnDef, SortingState } from '@tanstack/vue-table'
import type { PendingConflict, ScoreTableColumn, ScoreTableRow } from '../../../preload/types'
import { useToast } from '@nuxt/ui/composables'
import { ipcErrorMessage } from '../utils/ipc'
import GuardedButton from '../components/GuardedButton.vue'
import { bumpDyfRefresh, currentBatch, dyfState, isDyfExported } from '../stores/dyf-state'

// 授权过期后只读：禁用冲突处理（查看不受影响）
const props = withDefaults(defineProps<{ readonly?: boolean }>(), { readonly: false })

const toast = useToast()
const tableLoading = ref(false)
let tableRequestSerial = 0
let overviewRequestSerial = 0
let conflictRequestSerial = 0
const PAGE_SIZE = 500
const page = ref(1)
const table = ref<{ columns: ScoreTableColumn[]; rows: ScoreTableRow[]; total: number }>({
  columns: [],
  rows: [],
  total: 0
})
const sorting = ref<SortingState>([])

const selectedBatch = currentBatch

/** 是否已完成班级端审核（整班导出，决策 #17，响应式）。 */
const exported = isDyfExported

// 待处理冲突
const conflicts = ref<PendingConflict[]>([])
const conflictsOpen = ref(false)
const resolveOpen = ref(false)
const resolving = ref(false)
const currentConflict = ref<PendingConflict | null>(null)

// 类别选择状态（首次加载初始化；类别失效时回退全选；全不选 = 仅基本信息）
const categoriesInitialized = ref(false)

/** 类别全选状态。 */
const allCategoriesSelected = computed(
  () =>
    dyfState.table.allCategories.length > 0 &&
    dyfState.table.filter.categories.length === dyfState.table.allCategories.length
)

/** 班级多选选项：无班级数据时注入禁用占位项（在下拉列表视口内展示，决策 #19）。 */
const classOptions = computed(() =>
  dyfState.table.allClasses.length
    ? dyfState.table.allClasses.map((c) => ({ label: c, value: c }))
    : [{ label: '暂无班级数据，导入学生后生成', value: '__none__', disabled: true }]
)

/** 可排序表头（学号/姓名/总分/班排/专排，点击切换 增/降）。 */
function sortableHeader(label: string): ColumnDef<ScoreTableRow>['header'] {
  return ({ column }) =>
    h(
      'button',
      {
        type: 'button',
        class: 'inline-flex items-center gap-1 whitespace-nowrap',
        onClick: () => column.toggleSorting()
      },
      [
        label,
        h(
          'span',
          { class: 'text-dimmed text-xs' },
          column.getIsSorted() === 'desc' ? '↓' : column.getIsSorted() === 'asc' ? '↑' : '⇅'
        )
      ]
    )
}

/**
 * 大表格列（决策 #19）：「基本信息」分组（序号/学号/姓名/班级/总分/班排/专排）
 * + 勾选的项目类别分组（按模板顺序；全不选则仅基本信息）。
 * 分组表头（meta.class.th）加底色/居中，使其明确占据整组列宽。
 */
const tableColumns = computed<ColumnDef<ScoreTableRow>[]>(() => {
  const groupTh = 'text-center bg-elevated/60'
  const base: ColumnDef<ScoreTableRow> = {
    id: 'base-info',
    header: '基本信息',
    meta: { class: { th: groupTh } },
    columns: [
      { id: 'seq', header: '序号', size: 60 },
      { accessorKey: 'studentId', header: sortableHeader('学号'), size: 110 },
      { accessorKey: 'name', header: sortableHeader('姓名'), size: 100 },
      { accessorKey: 'className', header: '班级', size: 130 },
      { accessorKey: 'dyfTotal', header: sortableHeader('总分'), size: 70 },
      { accessorKey: 'rankClass', header: sortableHeader('班排'), size: 56 },
      { accessorKey: 'rankMajor', header: sortableHeader('专排'), size: 56 }
    ]
  }
  const selected = new Set(dyfState.table.filter.categories)
  const categoryOrder: string[] = []
  const grouped: Record<string, ColumnDef<ScoreTableRow>[]> = {}
  for (const c of table.value.columns) {
    if (!selected.has(c.category)) continue
    if (!grouped[c.category]) {
      grouped[c.category] = []
      categoryOrder.push(c.category)
    }
    grouped[c.category].push({
      accessorKey: `scores.${c.itemCode}`,
      header: c.itemCode,
      cell: scoreCell,
      size: 54
    })
  }
  const categoryCols = categoryOrder.map((cat) => ({
    id: `cat-${cat}`,
    header: cat,
    meta: { class: { th: groupTh } },
    columns: grouped[cat]
  }))
  return [base, ...categoryCols]
})

async function loadTable(): Promise<void> {
  if (!dyfState.batchId) {
    table.value = { columns: [], rows: [], total: 0 }
    return
  }
  tableLoading.value = true
  const requestSerial = ++tableRequestSerial
  try {
    const f = dyfState.table.filter
    const r = await window.api.overview.scoreTable(dyfState.batchId, {
      search: f.search || undefined,
      classes: f.classes.length ? [...f.classes] : undefined,
      limit: PAGE_SIZE,
      offset: (page.value - 1) * PAGE_SIZE
    })
    if (requestSerial !== tableRequestSerial) return
    table.value = r
    // 类别列清单（模板顺序），并初始化/校正类别选择
    const allCats = [...new Set(r.columns.map((c) => c.category))]
    dyfState.table.allCategories = allCats
    if (!categoriesInitialized.value) {
      dyfState.table.filter.categories = [...allCats]
      categoriesInitialized.value = true
    } else {
      const valid = dyfState.table.filter.categories.filter((c) => allCats.includes(c))
      if (valid.length !== dyfState.table.filter.categories.length) {
        dyfState.table.filter.categories = valid.length ? valid : []
      }
    }
  } catch (err) {
    if (requestSerial !== tableRequestSerial) return
    toast.add({ title: '加载大表格失败', description: ipcErrorMessage(err), color: 'error' })
  } finally {
    if (requestSerial === tableRequestSerial) tableLoading.value = false
  }
}

/** 加载总览（班级列表，供班级筛选）。 */
async function loadOverview(): Promise<void> {
  if (!dyfState.batchId) return
  const serial = ++overviewRequestSerial
  try {
    const o = await window.api.overview.get(dyfState.batchId)
    if (serial !== overviewRequestSerial) return
    dyfState.table.allClasses = o.classes ?? []
  } catch {
    // 忽略：班级筛选不可用时退化为全部班级
  }
}

async function loadConflicts(): Promise<void> {
  if (!dyfState.batchId) {
    conflicts.value = []
    return
  }
  const serial = ++conflictRequestSerial
  try {
    const r = await window.api.import.listConflicts(dyfState.batchId)
    if (serial !== conflictRequestSerial) return
    conflicts.value = r
  } catch (err) {
    if (serial !== conflictRequestSerial) return
    toast.add({ title: '加载冲突失败', description: ipcErrorMessage(err), color: 'error' })
  }
}

function toggleCategory(category: string, on: boolean): void {
  const cur = [...dyfState.table.filter.categories]
  dyfState.table.filter.categories = on
    ? cur.includes(category)
      ? cur
      : [...cur, category]
    : cur.filter((c) => c !== category)
}

function toggleAllCategories(on: boolean | 'indeterminate'): void {
  dyfState.table.filter.categories = on === true ? [...dyfState.table.allCategories] : []
}

/** 班级多选变更（模板事件值类型宽松，收敛为 string[]；剔除占位项）。 */
function updateClasses(v: unknown): void {
  dyfState.table.filter.classes = (Array.isArray(v) ? v : []).filter(
    (x): x is string => typeof x === 'string' && x !== '__none__'
  )
}

/** 搜索关键字变更。 */
function updateSearch(v: unknown): void {
  dyfState.table.filter.search = typeof v === 'string' ? v : ''
}

function doSearch(): void {
  page.value = 1
  void loadTable()
}

function openResolve(conflict: PendingConflict): void {
  currentConflict.value = conflict
  conflictsOpen.value = false
  resolveOpen.value = true
}

/** 处理冲突：指定“正确学生”（只能设置一次，不可撤销）。 */
async function resolve(choice: 'existing' | 'incoming'): Promise<void> {
  if (!currentConflict.value) return
  resolving.value = true
  try {
    const r = await window.api.import.resolveConflict(
      dyfState.batchId,
      currentConflict.value.conflictId,
      choice
    )
    toast.add({
      title: choice === 'existing' ? '已锁定现有记录' : '已以新导入为准导入',
      description: r.reason,
      color: 'success'
    })
    resolveOpen.value = false
    currentConflict.value = null
    await loadConflicts()
    conflictsOpen.value = conflicts.value.length > 0
    await loadTable()
    await loadOverview()
    // 决策 #19：冲突处理后三页（总览/总体情况/审核）同步刷新
    bumpDyfRefresh()
  } catch (err) {
    toast.add({ title: '处理失败', description: ipcErrorMessage(err), color: 'error' })
  } finally {
    resolving.value = false
  }
}

function formatTime(ts?: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function formatScore(v?: number): string {
  return v === undefined || v === null ? '—' : String(v)
}

/** 项目分数单元格渲染：0 分留空（未申请/被改为 0 均显示空白，与导出一致）。 */
function scoreCell({ getValue }: { getValue: () => unknown }): string | number {
  const v = getValue() as number | undefined
  return v === 0 ? '' : v ?? ''
}

// 批次切换 / 导入 / 整班导出 → 刷新
watch(
  () => dyfState.refreshTick,
  () => {
    void loadOverview()
    void loadConflicts()
    void loadTable()
  }
)

// 班级筛选变化 → 重载表格
watch(
  () => dyfState.table.filter.classes,
  () => {
    page.value = 1
    void loadTable()
  }
)

watch(page, () => void loadTable())

onMounted(async () => {
  await loadOverview()
  await loadConflicts()
  await loadTable()
})
</script>

<template>
  <div class="page h-full min-h-0">
    <!-- 批次状态提示（紧凑，决策 #19） -->
    <UAlert
      v-if="selectedBatch && selectedBatch.status !== 'active'"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="selectedBatch.status === 'draft' ? '批次未开放，激活后可导入' : '批次已结束，目前仅能查看'"
    />

    <UAlert
      v-if="exported"
      color="success"
      variant="subtle"
      icon="i-lucide-lock"
      title="本班已完成班级端审核并整班导出"
      description="导出后本端不可再导入、修改或处理冲突；当前仅可查看总体情况。"
    />

    <!-- 筛选栏（决策 #19）：搜索 + 类别勾选 + 班级筛选 -->
    <div class="filter-bar">
      <UButton
        v-if="conflicts.length"
        color="warning"
        variant="soft"
        icon="i-lucide-triangle-alert"
        :label="`学号冲突 (${conflicts.length})`"
        @click="conflictsOpen = true"
      />
      <UInput
        :model-value="dyfState.table.filter.search"
        placeholder="搜索学号 / 姓名"
        icon="i-lucide-search"
        class="w-56"
        @update:model-value="updateSearch"
        @keyup.enter="doSearch"
      />
      <UButton label="搜索" variant="outline" @click="doSearch" />
      <span class="text-sm text-dimmed nowrap">项目类别：</span>
      <UCheckbox
        label="全选"
        :model-value="allCategoriesSelected"
        @update:model-value="toggleAllCategories"
      />
      <UCheckbox
        v-for="c in dyfState.table.allCategories"
        :key="c"
        :label="c"
        :model-value="dyfState.table.filter.categories.includes(c)"
        @update:model-value="(v) => toggleCategory(c, !!v)"
      />
      <USelect
        :model-value="dyfState.table.filter.classes"
        :items="classOptions"
        multiple
        placeholder="全部班级（可多选）"
        class="w-60 ml-auto"
        @update:model-value="updateClasses"
      >
        <!-- 占位提示：未选择班级时展示（决策 #19） -->
        <template #default>
          <span
            v-if="dyfState.table.filter.classes.length === 0"
            class="text-dimmed truncate"
          >
            全部班级（可多选）
          </span>
          <span v-else class="truncate">{{ dyfState.table.filter.classes.join('、') }}</span>
        </template>
      </USelect>
    </div>

    <!-- 总体情况大表格（决策 #19：全部学生滚动呈现，可排序；表格占满可用高度）
         性能（决策 #19）：virtualize 真窗口化（只渲染可见行）+ watchOptions deep:false
         （整表替换引用，避免对大量学生×大量分数单元格做深度响应式监听）。 -->
    <div class="score-table-viewport">
      <UTable
        :data="table.rows"
        :columns="tableColumns"
        v-model:sorting="sorting"
        :loading="tableLoading"
        :watch-options="{ deep: false }"
        :virtualize="{ estimateSize: 34 }"
        sticky
        class="score-table"
        :ui="{
          root: 'flex-1 min-h-0 min-w-0',
          base: 'w-max min-w-full',
          th: 'px-2 py-2 text-xs font-medium whitespace-nowrap',
          td: 'px-2 py-1.5 text-sm whitespace-nowrap'
        }"
      >
        <template #empty>
          <div class="text-sm text-dimmed py-10 text-center">
            <p>暂无申请数据</p>
            <p class="text-xs mt-1">请先在「批次管理」激活批次，并在右上角「导入 .dyf」导入学生申请</p>
          </div>
        </template>
        <template #seq-cell="{ row }">
          <span class="text-dimmed">{{ (page - 1) * PAGE_SIZE + row.index + 1 }}</span>
        </template>
        <template #dyfTotal-cell="{ row }">
          <span class="font-medium">{{ row.original.dyfTotal }}</span>
        </template>
        <template #rankClass-cell="{ row }">{{ formatScore(row.original.rankClass) }}</template>
        <template #rankMajor-cell="{ row }">{{ formatScore(row.original.rankMajor) }}</template>
      </UTable>
    </div>

    <div v-if="table.total > PAGE_SIZE" class="flex items-center justify-between gap-3">
      <span class="text-xs text-dimmed">共 {{ table.total }} 人，每页 {{ PAGE_SIZE }} 人</span>
      <UPagination v-model:page="page" :total="table.total" :items-per-page="PAGE_SIZE" />
    </div>

    <!-- 学号冲突列表弹窗（决策 #19）：替代页面内联显示块 -->
    <UModal
      v-model:open="conflictsOpen"
      title="学号冲突"
      description="同一学号出现不同姓名，需指定“正确学生”（只能设置一次，不可撤销）"
      :ui="{ content: 'w-full max-w-3xl', footer: 'justify-end' }"
    >
      <template #body>
        <UTable
          :data="conflicts"
          :columns="[
            { accessorKey: 'studentId', header: '学号' },
            { accessorKey: 'existingName', header: '已有记录' },
            { accessorKey: 'incomingName', header: '新导入' },
            { accessorKey: 'fileName', header: '文件' },
            { accessorKey: 'createdAt', header: '时间' },
            { id: 'actions', header: '操作' }
          ]"
          :ui="{ th: 'px-3 py-2 text-xs font-medium', td: 'px-3 py-1.5 text-sm whitespace-nowrap' }"
        >
          <template #studentId-cell="{ row }">{{ row.original.studentId }}</template>
          <template #existingName-cell="{ row }">
            <span>{{ row.original.existingName }}</span>
            <UBadge label="已有记录" color="neutral" variant="subtle" />
          </template>
          <template #incomingName-cell="{ row }">
            <span>{{ row.original.incomingName }}</span>
            <UBadge label="新导入" color="info" variant="subtle" />
          </template>
          <template #fileName-cell="{ row }">{{ row.original.fileName }}</template>
          <template #createdAt-cell="{ row }">{{ formatTime(row.original.createdAt) }}</template>
          <template #actions-cell="{ row }">
            <GuardedButton
              size="sm"
              variant="ghost"
              label="处理"
              :disabled="props.readonly || exported"
              :disabled-reason="props.readonly ? '授权已过期，请更新授权后再处理冲突' : '该批次已导出锁定，不能再处理冲突'"
              @click="openResolve(row.original)"
            />
          </template>
        </UTable>
      </template>
      <template #footer>
        <UButton label="关闭" color="neutral" variant="outline" @click="conflictsOpen = false" />
      </template>
    </UModal>

    <!-- 冲突处理对话框 -->
    <UModal
      v-model:open="resolveOpen"
      title="处理学号冲突"
      :description="`学号 ${currentConflict?.studentId ?? ''} 出现了两份不同姓名的申请，只能选择一次且不可撤销`"
      :ui="{ content: 'w-full max-w-lg', footer: 'justify-end' }"
    >
      <template #body>
        <div v-if="currentConflict" class="form">
          <UAlert
            color="warning"
            variant="soft"
            icon="i-lucide-triangle-alert"
            title="锁定后不可修改、不可撤销"
            description="请确认哪一份是正确学生。锁定后，任何同学号不同姓名的导入将被直接拒绝。"
          />
          <div class="candidate-grid">
            <UCard :ui="{ body: 'flex flex-col gap-2' }">
              <div class="flex items-center gap-2">
                <UBadge label="已有记录" color="neutral" />
                <span class="font-medium">{{ currentConflict.existingName }}</span>
              </div>
              <p class="text-sm text-dimmed">保留当前已导入的数据，拒绝新导入文件</p>
              <UButton
                label="以已有记录为准"
                variant="outline"
                :loading="resolving"
                @click="resolve('existing')"
              />
            </UCard>
            <UCard :ui="{ body: 'flex flex-col gap-2' }">
              <div class="flex items-center gap-2">
                <UBadge label="新导入" color="info" />
                <span class="font-medium">{{ currentConflict.incomingName }}</span>
              </div>
              <p class="text-sm text-dimmed">修正姓名并以新导入文件为准（旧数据作废）</p>
              <UButton label="以新导入为准" :loading="resolving" @click="resolve('incoming')" />
            </UCard>
          </div>
        </div>
      </template>
      <template #footer>
        <UButton label="取消" color="neutral" variant="outline" @click="resolveOpen = false" />
      </template>
    </UModal>
  </div>
</template>

<style scoped>
.page {
  flex: 1 1 0%;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow: hidden;
}
.filter-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.score-table-viewport {
  flex: 1 1 0%;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
}
.section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.section-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.section-title {
  font-size: 14px;
  font-weight: 600;
}
.nowrap {
  white-space: nowrap;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.candidate-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
</style>
