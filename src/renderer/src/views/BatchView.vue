<script setup lang="ts">
import { inject, onMounted, ref, useTemplateRef, watch, type Ref } from 'vue'
import type { Batch } from '@sces/shared'
import { useToast } from '@nuxt/ui/composables'
import { CalendarDate, Time } from '@internationalized/date'
import { ipcErrorMessage } from '../utils/ipc'
import { batchStatusColor, batchStatusLabel } from '../utils/batch-status'
import GuardedButton from '../components/GuardedButton.vue'

// 授权过期后只读：禁用一切写操作（创建/编辑/激活/关闭），查看不受影响。
const props = withDefaults(defineProps<{ readonly?: boolean }>(), { readonly: false })

const toast = useToast()

// 创建动作提升到 navbar（对齐模板），由 AppLayout 注入；readonly 同步给 navbar 禁用按钮
const batchCreate = inject<Ref<(() => void) | null>>('batchCreate')
const batchReadonly = inject<Ref<boolean>>('batchReadonly')
if (batchCreate) batchCreate.value = openCreate
watch(
  () => props.readonly,
  (v) => {
    if (batchReadonly) batchReadonly.value = v
  },
  { immediate: true }
)

const batches = ref<Batch[]>([])
const loading = ref(false)
const dialogOpen = ref(false)
const editing = ref<Batch | null>(null)
const submitting = ref(false)
const formError = ref('')

// 确认对话框：受控 open（每次 open 都是新会话，取消后仍可再次打开，修复单例失效问题）。
// confirmColor 语义化配色：常规确认用 primary（主题色），破坏性/不可逆动作用 error（红色警示）。
const confirmOpen = ref(false)
const confirmState = ref<{
  title: string
  description?: string
  confirmLabel?: string
  confirmColor?: 'primary' | 'error'
  action?: () => Promise<void>
}>({ title: '' })

function askConfirm(opts: {
  title: string
  description?: string
  confirmLabel?: string
  confirmColor?: 'primary' | 'error'
  action: () => Promise<void>
}): void {
  confirmState.value = opts
  confirmOpen.value = true
}

async function runConfirm(): Promise<void> {
  confirmOpen.value = false
  if (confirmState.value.action) await confirmState.value.action()
}

// UInputDate 模板引用（date picker 弹层的锚点）。
const startDateRef = useTemplateRef('startDateRef')
const endDateRef = useTemplateRef('endDateRef')

// 批次状态展示统一来自 utils/batch-status（shared BATCH_STATUS_LABELS：draft=未开放）
// 与 BatchSelect 等下拉共用，避免各页文案漂移。

// 日期/时间分离：日期用 CalendarDate（date picker 弹层），时间用 Time（24 小时制）。
// UInputDate/UInputTime 的 modelValue 类型来自 Nuxt UI 内部 reka-ui 的类型声明，
// 与 @internationalized/date 直接导入的类型实例不兼容（class #private nominal 差异），
// 此处用宽松类型承接组件双向绑定，提交时统一转换。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DateField = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TimeField = any

/** epoch 毫秒 → { 日期, 时间 }（本地时区）。 */
function fromEpoch(epoch?: number): { date: DateField; time: TimeField } {
  if (epoch == null) return { date: undefined, time: undefined }
  const d = new Date(epoch)
  return {
    date: new CalendarDate(d.getFullYear(), d.getMonth() + 1, d.getDate()),
    time: new Time(d.getHours(), d.getMinutes())
  }
}

/** { 日期, 时间 } → epoch 毫秒（本地时区，由 Date 构造器采用）；日期为空则视为未填。 */
function toEpoch(date?: DateField, time?: TimeField): number | undefined {
  if (!date) return undefined
  const t = time ?? new Time(0, 0)
  return new Date(date.year, date.month - 1, date.day, t.hour, t.minute).getTime()
}

const form = ref({
  year: new Date().getFullYear(),
  semester: 1 as 1 | 2,
  isTest: false,
  applyStartDate: undefined as DateField,
  applyStartTime: undefined as TimeField,
  applyEndDate: undefined as DateField,
  applyEndTime: undefined as TimeField
})

const semesterOptions = [
  { label: '第 1 学期', value: 1 },
  { label: '第 2 学期', value: 2 }
]

const columns = [
  { accessorKey: 'year', header: '学年' },
  { accessorKey: 'semester', header: '学期' },
  { accessorKey: 'status', header: '状态' },
  { id: 'applyTime', header: '申请时间' },
  { id: 'actions', header: '操作' }
]

async function load(): Promise<void> {
  loading.value = true
  try {
    batches.value = await window.api.batch.list()
  } catch (err) {
    toast.add({ title: '加载失败', description: ipcErrorMessage(err), color: 'error' })
  } finally {
    loading.value = false
  }
}

onMounted(load)

function openCreate(): void {
  editing.value = null
  formError.value = ''
  form.value = {
    year: new Date().getFullYear(),
    semester: 1,
    isTest: false,
    applyStartDate: undefined,
    applyStartTime: undefined,
    applyEndDate: undefined,
    applyEndTime: undefined
  }
  dialogOpen.value = true
}

function openEdit(batch: Batch): void {
  editing.value = batch
  formError.value = ''
  const start = fromEpoch(batch.applyStartAt)
  const end = fromEpoch(batch.applyEndAt)
  form.value = {
    year: batch.year,
    semester: batch.semester,
    isTest: batch.isTest === true,
    applyStartDate: start.date,
    applyStartTime: start.time,
    applyEndDate: end.date,
    applyEndTime: end.time
  }
  dialogOpen.value = true
}

async function submit(): Promise<void> {
  formError.value = ''
  if (!form.value.applyStartDate || !form.value.applyEndDate) {
    formError.value = '请填写申请开始与结束日期'
    return
  }
  submitting.value = true
  try {
    const input = {
      year: form.value.year,
      semester: form.value.semester,
      isTest: form.value.isTest,
      applyStartAt: toEpoch(form.value.applyStartDate, form.value.applyStartTime),
      applyEndAt: toEpoch(form.value.applyEndDate, form.value.applyEndTime)
    }
    if (editing.value) {
      await window.api.batch.update(editing.value.batchId, input)
      toast.add({ title: '已保存', description: '批次已更新', color: 'success' })
    } else {
      const { warnings } = await window.api.batch.create(input)
      toast.add({ title: '已创建', description: '批次创建成功', color: 'success' })
      for (const w of warnings) {
        toast.add({ title: '提示', description: w, color: 'warning' })
      }
    }
    dialogOpen.value = false
    await load()
  } catch (err) {
    formError.value = ipcErrorMessage(err)
  } finally {
    submitting.value = false
  }
}

async function activate(batch: Batch): Promise<void> {
  try {
    await window.api.batch.activate(batch.batchId)
    toast.add({ title: '已激活', description: '批次已进入进行中', color: 'success' })
    await load()
  } catch (err) {
    toast.add({ title: '操作失败', description: ipcErrorMessage(err), color: 'error' })
  }
}

async function close(batch: Batch): Promise<void> {
  try {
    await window.api.batch.close(batch.batchId)
    toast.add({ title: '已关闭', description: '批次已结束', color: 'success' })
    await load()
  } catch (err) {
    toast.add({ title: '操作失败', description: ipcErrorMessage(err), color: 'error' })
  }
}

/** 激活前二次确认（激活后学生即可申请，不可撤销）。 */
function confirmActivate(batch: Batch): void {
  askConfirm({
    title: '激活批次',
    description: `激活后学生即可开始申请，且无法撤销。确定激活「${batch.year} 年第 ${batch.semester} 学期」批次吗？`,
    confirmLabel: '激活',
    action: () => activate(batch)
  })
}

/** 关闭前二次确认（关闭后停止接收申请，不可撤销）。 */
function confirmClose(batch: Batch): void {
  askConfirm({
    title: '关闭批次',
    description: `关闭后该批次停止接收申请，且无法撤销。确定关闭「${batch.year} 年第 ${batch.semester} 学期」批次吗？`,
    confirmLabel: '关闭',
    confirmColor: 'error',
    action: () => close(batch)
  })
}

function formatTime(ts?: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}
</script>

<template>
  <div class="page">
    <UTable
      :data="batches"
      :loading="loading"
      :columns="columns"
      :ui="{
        th: 'px-3 py-2 text-xs font-medium',
        td: 'px-3 py-1.5 text-sm whitespace-nowrap'
      }"
    >
      <template #year-cell="{ row }">{{ row.original.year }} 年</template>
      <template #semester-cell="{ row }">第 {{ row.original.semester }} 学期</template>
      <template #status-cell="{ row }">
        <div class="status-cell">
          <UBadge
            :color="batchStatusColor[row.original.status]"
            :label="batchStatusLabel(row.original.status)"
          />
          <UBadge v-if="row.original.isTest" color="warning" variant="subtle" label="测试" />
        </div>
      </template>
      <template #applyTime-cell="{ row }">
        {{ formatTime(row.original.applyStartAt) }} ~ {{ formatTime(row.original.applyEndAt) }}
      </template>
      <template #actions-cell="{ row }">
        <div class="row-actions">
          <GuardedButton
            v-if="row.original.status === 'draft'"
            size="sm"
            variant="ghost"
            label="编辑"
            :disabled="props.readonly"
            disabled-reason="授权已过期，请更新授权后再编辑批次"
            @click="openEdit(row.original)"
          />
          <GuardedButton
            v-if="row.original.status === 'draft'"
            size="sm"
            variant="ghost"
            label="激活"
            :disabled="props.readonly"
            disabled-reason="授权已过期，请更新授权后再激活批次"
            @click="confirmActivate(row.original)"
          />
          <GuardedButton
            v-if="row.original.status === 'active'"
            size="sm"
            color="error"
            variant="ghost"
            label="关闭"
            :disabled="props.readonly"
            disabled-reason="授权已过期，请更新授权后再关闭批次"
            @click="confirmClose(row.original)"
          />
        </div>
      </template>
    </UTable>

    <UModal
      v-model:open="dialogOpen"
      :title="editing ? '编辑批次' : '创建批次'"
      :ui="{ content: 'w-full max-w-md', footer: 'justify-end' }"
    >
      <template #body>
        <div class="form">
          <div class="form-grid">
            <UFormField label="学年">
              <UInputNumber v-model="form.year" :min="2000" :max="2100" class="w-full" />
            </UFormField>
            <UFormField label="学期">
              <USelect v-model="form.semester" :items="semesterOptions" class="w-full" />
            </UFormField>
          </div>

          <div class="form-grid">
            <UFormField label="开始日期" required>
              <UInputDate
                ref="startDateRef"
                v-model="form.applyStartDate"
                class="w-full"
                :ui="{ base: 'justify-center' }"
              >
                <template #trailing>
                  <UPopover :reference="startDateRef?.inputsRef?.[3]?.$el">
                    <UButton
                      color="neutral"
                      variant="link"
                      size="sm"
                      icon="i-lucide-calendar"
                      aria-label="选择日期"
                      class="px-0"
                    />
                    <template #content>
                      <UCalendar v-model="form.applyStartDate" class="p-2" />
                    </template>
                  </UPopover>
                </template>
              </UInputDate>
            </UFormField>
            <UFormField label="开始时间">
              <UInputTime
                v-model="form.applyStartTime"
                :hour-cycle="24"
                class="w-full"
                :ui="{ base: 'justify-center' }"
              />
            </UFormField>
          </div>

          <div class="form-grid">
            <UFormField label="结束日期" required>
              <UInputDate
                ref="endDateRef"
                v-model="form.applyEndDate"
                class="w-full"
                :ui="{ base: 'justify-center' }"
              >
                <template #trailing>
                  <UPopover :reference="endDateRef?.inputsRef?.[3]?.$el">
                    <UButton
                      color="neutral"
                      variant="link"
                      size="sm"
                      icon="i-lucide-calendar"
                      aria-label="选择日期"
                      class="px-0"
                    />
                    <template #content>
                      <UCalendar v-model="form.applyEndDate" class="p-2" />
                    </template>
                  </UPopover>
                </template>
              </UInputDate>
            </UFormField>
            <UFormField label="结束时间">
              <UInputTime
                v-model="form.applyEndTime"
                :hour-cycle="24"
                class="w-full"
                :ui="{ base: 'justify-center' }"
              />
            </UFormField>
          </div>

          <UFormField label="批次类型">
            <UCheckbox
              v-model="form.isTest"
              :disabled="!!editing"
              label="测试批次"
              description="用于试用或演示，不影响正式数据"
            />
          </UFormField>

          <UAlert v-if="formError" color="error" :title="formError" variant="soft" />
        </div>
      </template>
      <template #footer>
        <UButton label="取消" color="neutral" variant="outline" @click="dialogOpen = false" />
        <UButton label="保存" :loading="submitting" @click="submit" />
      </template>
    </UModal>

    <!-- 二次确认对话框（受控 open，取消后仍可再次打开）；确认按钮按语义配色 -->
    <UModal
      v-model:open="confirmOpen"
      :title="confirmState.title"
      :description="confirmState.description"
      :ui="{ footer: 'justify-end' }"
    >
      <template #footer>
        <UButton label="取消" color="neutral" variant="outline" @click="confirmOpen = false" />
        <UButton
          :label="confirmState.confirmLabel ?? '确认'"
          :color="confirmState.confirmColor ?? 'primary'"
          @click="runConfirm"
        />
      </template>
    </UModal>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.row-actions {
  display: flex;
  gap: 4px;
}
.status-cell {
  display: flex;
  align-items: center;
  gap: 6px;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
/* 表单两列栅格：左列（学年/日期）宽，右列（学期/时间）统一收窄且等宽，
   避免时间选择框比学期选择框还宽。 */
.form-grid {
  display: grid;
  grid-template-columns: 3fr 2fr;
  gap: 12px;
}
/* 日期/时间输入框：日期与时间内容居中统一通过组件官方插槽覆盖
   :ui={ base: 'justify-center' } 实现，不用 :deep() 覆盖内部结构。 */
</style>
