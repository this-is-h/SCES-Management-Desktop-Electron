<script setup lang="ts">
/**
 * 下级授权（M-O1B）：仅 level1 可见。签发 / 台账 / 批量重签 / 本地作废。
 * - 单位证书就绪（导入 .dysc）后才可签发下级授权，有效期封顶到单位授权到期日；
 * - 只按年级签发：每个年级自动生成一份 level2 年级授权和该配置下全部班级的 level3 授权，
 *   三级授权同时写入 grade + class，避免班级账号跨年级导入。
 * - 二三级角色看不到本页入口（导航由 AppLayout 控制）。
 */
import { computed, onMounted, ref, useTemplateRef } from 'vue'
import { useToast } from '@nuxt/ui/composables'
import { CalendarDate } from '@internationalized/date'
import type { DelegationRecord, DelegationReadiness } from '../../../preload/types'
import { ipcErrorMessage } from '../utils/ipc'
import GuardedButton from '../components/GuardedButton.vue'

const toast = useToast()

// ---------- 单位证书状态 ----------
const readiness = ref<DelegationReadiness>({ ready: false })
const ready = computed(() => readiness.value.ready)
const notAfter = computed(() => readiness.value.notAfter)
const importing = ref(false)
const pubkeyBusy = ref(false)

// ---------- 签发台账 ----------
const records = ref<DelegationRecord[]>([])
const loading = ref(false)
const selectedIds = ref<string[]>([])
const bulkExporting = ref(false)
const bulkRevokeOpen = ref(false)
const bulkRevoking = ref(false)

const selectedRecords = computed(() =>
  records.value.filter((record) => selectedIds.value.includes(record.delegationId))
)
const allSelected = computed(
  () => records.value.length > 0 && selectedIds.value.length === records.value.length
)
const partiallySelected = computed(
  () => selectedIds.value.length > 0 && selectedIds.value.length < records.value.length
)
const selectedActiveCount = computed(
  () => selectedRecords.value.filter((record) => !record.revokedAt).length
)
const canBulkExport = computed(
  () =>
    selectedRecords.value.length > 0 && selectedRecords.value.every((record) => record.exportable)
)

// ---------- 签发表单 ----------
const issueOpen = ref(false)
const noBatchConfirmOpen = ref(false)
const noBatchAction = ref<'issue' | 'reissue'>('issue')
const submitting = ref(false)
const formError = ref('')

// UInputDate/UCalendar 的 modelValue 类型与 @internationalized/date 直接导入的
// CalendarDate 实例存在 class #private nominal 差异，故与 BatchView 一致用宽松类型承接。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DateField = any

const form = ref<{
  grades: string[]
  holderLabel: string
  expiresAt: DateField
  password: string
}>({
  grades: [],
  holderLabel: '',
  expiresAt: undefined,
  password: ''
})

/** 年级标签（去重并清理空值）；每个标签必须是四位数字。 */
const gradeList = computed(() =>
  Array.from(new Set(form.value.grades.map((grade) => String(grade).trim()).filter(Boolean)))
)
const invalidGrades = computed(() => gradeList.value.filter((grade) => !/^\d{4}$/.test(grade)))

const selectedScopes = computed<{ grade: string }[]>(() =>
  gradeList.value.map((grade) => ({ grade }))
)
const submitLabel = computed(() =>
  selectedScopes.value.length
    ? `签发 ${selectedScopes.value.length} 个年级并打包`
    : '生成并打包年级授权'
)

// 有效期选择器封顶 = 单位授权到期日（notAfter）。
const maxDate = computed(() =>
  notAfter.value
    ? new CalendarDate(
        new Date(notAfter.value).getFullYear(),
        new Date(notAfter.value).getMonth() + 1,
        new Date(notAfter.value).getDate()
      )
    : undefined
)
const today = new Date()
const minDate = new CalendarDate(today.getFullYear(), today.getMonth() + 1, today.getDate())
const expiryShortcuts: Array<{ label: string; months?: number }> = [
  { label: '1个月', months: 1 },
  { label: '3个月', months: 3 },
  { label: '6个月', months: 6 },
  { label: '1年', months: 12 },
  { label: '与一级账号一致' }
]

function calendarDateEpoch(value: DateField): number {
  return new Date(value.year, value.month - 1, value.day).getTime()
}

function setExpiryShortcut(shortcut: { months?: number }): void {
  if (shortcut.months === undefined) {
    form.value.expiresAt = maxDate.value
    return
  }
  const target = new Date()
  target.setHours(0, 0, 0, 0)
  const originalDay = target.getDate()
  target.setDate(1)
  target.setMonth(target.getMonth() + shortcut.months)
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  target.setDate(Math.min(originalDay, lastDay))
  let next = new CalendarDate(target.getFullYear(), target.getMonth() + 1, target.getDate())
  if (maxDate.value && calendarDateEpoch(next) > calendarDateEpoch(maxDate.value))
    next = maxDate.value
  form.value.expiresAt = next
}

const canSubmit = computed(() => {
  if (!ready.value) return false
  if (invalidGrades.value.length) return false
  if (!gradeList.value.length) return false
  if (!form.value.expiresAt) return false
  if (!form.value.password) return false
  return true
})
const submitDisabledReason = computed(() => {
  if (!ready.value) return '请先导入服务商签发的单位证书（.dysc）'
  if (invalidGrades.value.length) return `年级必须为四位数字：${invalidGrades.value.join('、')}`
  if (!gradeList.value.length) return '请至少填写一个年级（四位数字）'
  if (!form.value.expiresAt) return '请选择授权有效期'
  if (!form.value.password) return '请输入授权文件口令'
  return '请补全签发信息后重试'
})

const dateRef = useTemplateRef('dateRef')

// ---------- 批量重签 ----------
const reissueOpen = ref(false)
const reissuePassword = ref('')
const reissuing = ref(false)

// ---------- 本地作废 ----------
const revokeOpen = ref(false)
const revokeTarget = ref<DelegationRecord | null>(null)
const revoking = ref(false)

onMounted(loadAll)

async function loadAll(): Promise<void> {
  await Promise.all([loadReadiness(), loadRecords()])
}

async function loadReadiness(): Promise<void> {
  try {
    readiness.value = await window.api.delegation.readiness()
  } catch (err) {
    toast.add({ title: '读取单位证书状态失败', description: ipcErrorMessage(err), color: 'error' })
  }
}

async function loadRecords(): Promise<void> {
  loading.value = true
  try {
    records.value = await window.api.delegation.list()
    const validIds = new Set(records.value.map((record) => record.delegationId))
    selectedIds.value = selectedIds.value.filter((id) => validIds.has(id))
  } catch (err) {
    toast.add({ title: '加载台账失败', description: ipcErrorMessage(err), color: 'error' })
  } finally {
    loading.value = false
  }
}

function toggleAllRows(value: boolean | 'indeterminate'): void {
  selectedIds.value = value === true ? records.value.map((record) => record.delegationId) : []
}

function toggleRow(delegationId: string, value: boolean | 'indeterminate'): void {
  const set = new Set(selectedIds.value)
  if (value === true) set.add(delegationId)
  else set.delete(delegationId)
  selectedIds.value = Array.from(set)
}

async function exportSelected(): Promise<void> {
  if (!canBulkExport.value) return
  bulkExporting.value = true
  try {
    const path = await window.api.delegation.exportFiles(selectedIds.value)
    if (path)
      toast.add({
        title: `已导出 ${selectedIds.value.length} 份授权`,
        description: path,
        color: 'success'
      })
  } catch (err) {
    toast.add({ title: '批量导出失败', description: ipcErrorMessage(err), color: 'error' })
  } finally {
    bulkExporting.value = false
  }
}

function openBulkRevoke(): void {
  if (selectedActiveCount.value > 0) bulkRevokeOpen.value = true
}

async function submitBulkRevoke(): Promise<void> {
  const ids = selectedRecords.value
    .filter((record) => !record.revokedAt)
    .map((record) => record.delegationId)
  if (!ids.length) return
  bulkRevoking.value = true
  try {
    const result = await window.api.delegation.revokeMany(ids)
    toast.add({
      title: '批量作废完成',
      description: `已作废 ${result.revoked} 份授权`,
      color: 'success'
    })
    bulkRevokeOpen.value = false
    selectedIds.value = []
    await loadRecords()
  } catch (err) {
    toast.add({ title: '批量作废失败', description: ipcErrorMessage(err), color: 'error' })
  } finally {
    bulkRevoking.value = false
  }
}

/** 导出公钥包（.dysk）交服务商换取单位证书。 */
async function onPublishPubkey(): Promise<void> {
  pubkeyBusy.value = true
  try {
    const res = await window.api.unit.publishPubkey()
    if (!res.exported) return
    toast.add({
      title: '已导出公钥包',
      description: res.path ? `已导出到 ${res.path}` : '公钥包已上报服务商',
      color: 'success'
    })
  } catch (err) {
    toast.add({ title: '操作失败', description: ipcErrorMessage(err), color: 'error' })
  } finally {
    pubkeyBusy.value = false
  }
}

/** 导入单位证书（.dysc）：验签 + 核对后落库。 */
async function onImportCert(): Promise<void> {
  importing.value = true
  try {
    const path = await window.api.unit.pickCert()
    if (!path) return
    const res = await window.api.unit.importCert(path)
    toast.add({
      title: '已导入单位证书',
      description: `单位授权到期日 ${new Date(res.notAfter).toLocaleDateString('zh-CN')}`,
      color: 'success'
    })
    if (res.expiryMismatch) {
      toast.add({
        title: '到期日不一致',
        description: '证书到期日与本地授权不一致，请确认是否已续期',
        color: 'warning'
      })
    }
    await Promise.all([loadReadiness(), loadRecords()])
  } catch (err) {
    toast.add({ title: '导入失败', description: ipcErrorMessage(err), color: 'error' })
  } finally {
    importing.value = false
  }
}

function openIssue(): void {
  formError.value = ''
  form.value = {
    grades: [],
    holderLabel: '',
    expiresAt: undefined,
    password: ''
  }
  issueOpen.value = true
}

/** 提交签发：按年级生成“年级授权 + 全部班级授权”的嵌套 zip。 */
async function submitIssue(skipBatchWarning = false): Promise<void> {
  formError.value = ''
  if (!canSubmit.value) return
  if (!skipBatchWarning && (readiness.value.batchCount || 0) === 0) {
    noBatchAction.value = 'issue'
    noBatchConfirmOpen.value = true
    return
  }
  submitting.value = true
  try {
    // CalendarDate → 本地时区 epoch 毫秒（对齐 BatchView toEpoch 惯例）
    const expiresAt = new Date(
      form.value.expiresAt.year,
      form.value.expiresAt.month - 1,
      form.value.expiresAt.day
    ).getTime()
    const res = await window.api.delegation.issueBatch({
      grades: gradeList.value,
      holderLabel: form.value.holderLabel.trim() || undefined,
      expiresAt,
      password: form.value.password
    })
    if (!res) return
    toast.add({
      title: `已签发 ${res.grades} 个年级授权`,
      description: `共包含 ${res.classes} 个班级授权，已导出到 ${res.path}`,
      color: 'success'
    })
    issueOpen.value = false
    await loadRecords()
  } catch (err) {
    formError.value = ipcErrorMessage(err)
  } finally {
    submitting.value = false
  }
}

function requestIssueSubmit(): void {
  void submitIssue(false)
}

function confirmWithoutBatch(): void {
  noBatchConfirmOpen.value = false
  if (noBatchAction.value === 'reissue') void submitReissue(true)
  else void submitIssue(true)
}

/** 批量重签：续期（导入新证书）后统一重签，下级导入新文件方可延期。 */
async function submitReissue(skipBatchWarning = false): Promise<void> {
  if (!reissuePassword.value) return
  if (!skipBatchWarning && (readiness.value.batchCount || 0) === 0) {
    noBatchAction.value = 'reissue'
    reissueOpen.value = false
    noBatchConfirmOpen.value = true
    return
  }
  reissuing.value = true
  try {
    const res = await window.api.delegation.reissue(reissuePassword.value)
    if (!res) return // 取消保存
    toast.add({
      title: '已重签',
      description: `已重签 ${res.reissued} 份，导出到 ${res.path}`,
      color: 'success'
    })
    reissueOpen.value = false
    reissuePassword.value = ''
    await loadRecords()
  } catch (err) {
    toast.add({ title: '重签失败', description: ipcErrorMessage(err), color: 'error' })
  } finally {
    reissuing.value = false
  }
}

function requestReissue(): void {
  void submitReissue(false)
}

function cancelNoBatchConfirm(): void {
  noBatchConfirmOpen.value = false
  if (noBatchAction.value === 'reissue') reissueOpen.value = true
}

/** 打开本地作废确认。 */
function openRevoke(rec: DelegationRecord): void {
  revokeTarget.value = rec
  revokeOpen.value = true
}

async function submitRevoke(): Promise<void> {
  if (!revokeTarget.value) return
  revoking.value = true
  try {
    await window.api.delegation.revoke(revokeTarget.value.delegationId)
    toast.add({
      title: '已作废',
      description: '该下级授权已在本地台账作废（不影响已发出的授权文件）',
      color: 'success'
    })
    revokeOpen.value = false
    revokeTarget.value = null
    await loadRecords()
  } catch (err) {
    toast.add({ title: '操作失败', description: ipcErrorMessage(err), color: 'error' })
  } finally {
    revoking.value = false
  }
}

/** 角色中文（台账列）。 */
function roleLabel(role: DelegationRecord['role']): string {
  return role === 'level2' ? '二级年级管理员' : '三级班级管理员'
}

function scopeLabel(scope: DelegationRecord['scope']): string {
  if (scope.class && scope.grade) return `${scope.grade}级 / ${scope.class}`
  return scope.grade ? `${scope.grade}级` : scope.class ? `未标年级 / ${scope.class}` : '—'
}

function formatDate(ts?: number | null): string {
  return ts ? new Date(ts).toLocaleDateString('zh-CN') : '—'
}

function formatTime(ts?: number | null): string {
  return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—'
}

/** 状态：已作废 / 正常；到期 ≤30 天高亮。 */
function recordStatus(rec: DelegationRecord): {
  label: string
  color: 'error' | 'warning' | 'success'
} {
  if (rec.revokedAt) return { label: '已作废', color: 'error' }
  const days = Math.ceil((rec.expiresAt - Date.now()) / 86400000)
  if (days <= 30) return { label: '即将到期', color: 'warning' }
  return { label: '正常', color: 'success' }
}

const exportingId = ref<string | null>(null)

async function exportRecord(rec: DelegationRecord): Promise<void> {
  exportingId.value = rec.delegationId
  try {
    const path = await window.api.delegation.exportFile(rec.delegationId)
    if (path) toast.add({ title: '授权文件已导出', description: path, color: 'success' })
  } catch (err) {
    toast.add({ title: '导出失败', description: ipcErrorMessage(err), color: 'error' })
  } finally {
    exportingId.value = null
  }
}

const columns = [
  { id: 'select', header: '' },
  { accessorKey: 'holderLabel', header: '备注' },
  { accessorKey: 'role', header: '角色' },
  { accessorKey: 'scope', header: '范围' },
  { accessorKey: 'boundFingerprint', header: '机器码' },
  { accessorKey: 'expiresAt', header: '有效期' },
  { accessorKey: 'issuedAt', header: '签发时间' },
  { accessorKey: 'reissuedAt', header: '重签时间' },
  { accessorKey: 'status', header: '状态' },
  { id: 'actions', header: '操作' }
]
</script>

<template>
  <div class="delegation-page">
    <div class="certificate-bar">
      <UAlert
        v-if="!ready"
        class="flex-1"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="请先导入单位证书"
        description="导出公钥包交给服务商，并导入回传的单位证书后方可签发。"
      />
      <UAlert
        v-else-if="notAfter"
        class="flex-1"
        color="info"
        variant="subtle"
        icon="i-lucide-shield-check"
        title="授权签发就绪"
        :description="`一级授权 ${formatDate(notAfter)} 到期；将携带 ${readiness.batchCount || 0} 个非草稿批次。`"
      />
      <div class="certificate-actions">
        <UButton
          icon="i-lucide-key-round"
          variant="outline"
          :loading="pubkeyBusy"
          label="导出公钥"
          @click="onPublishPubkey"
        />
        <UButton
          icon="i-lucide-file-check-2"
          :loading="importing"
          label="导入证书"
          @click="onImportCert"
        />
      </div>
    </div>

    <section class="table-section">
      <div class="table-toolbar">
        <div class="min-w-0">
          <h3 class="font-semibold">签发台账</h3>
          <span class="text-xs text-dimmed"
            >共 {{ records.length }} 条，已选择 {{ selectedIds.length }} 条</span
          >
        </div>
        <div class="table-actions">
          <GuardedButton
            label="批量导出"
            icon="i-lucide-files"
            variant="outline"
            :loading="bulkExporting"
            :disabled="!canBulkExport"
            disabled-reason="请至少选择一条含文件快照的授权记录"
            @click="exportSelected"
          />
          <GuardedButton
            label="批量作废"
            icon="i-lucide-ban"
            color="error"
            variant="outline"
            :disabled="selectedActiveCount === 0"
            disabled-reason="请至少选择一条未作废的授权记录"
            @click="openBulkRevoke"
          />
          <GuardedButton
            label="批量重签"
            icon="i-lucide-rotate-ccw"
            variant="outline"
            :disabled="!ready"
            disabled-reason="请先导入服务商签发的单位证书（.dysc）"
            @click="reissueOpen = true"
          />
          <GuardedButton
            label="按年级签发"
            icon="i-lucide-plus"
            :disabled="!ready"
            disabled-reason="请先导入服务商签发的单位证书（.dysc）"
            @click="openIssue"
          />
        </div>
      </div>

      <div class="table-scroll">
        <UTable
          :data="records"
          :loading="loading"
          :columns="columns"
          class="delegation-table"
          :ui="{
            root: 'flex-1 min-h-0 min-w-0',
            base: 'min-w-[1120px]',
            th: 'px-3 py-2 text-xs font-medium sticky top-0 z-10 bg-default',
            td: 'px-3 py-1.5 text-sm whitespace-nowrap'
          }"
        >
          <template #select-header>
            <UCheckbox
              :model-value="allSelected"
              :indeterminate="partiallySelected"
              aria-label="全选授权"
              @update:model-value="toggleAllRows"
            />
          </template>
          <template #select-cell="{ row }">
            <UCheckbox
              :model-value="selectedIds.includes(row.original.delegationId)"
              :aria-label="`选择 ${scopeLabel(row.original.scope)}`"
              @update:model-value="(value) => toggleRow(row.original.delegationId, value)"
            />
          </template>
          <template #holderLabel-cell="{ row }">{{ row.original.holderLabel || '—' }}</template>
          <template #role-cell="{ row }">{{ roleLabel(row.original.role) }}</template>
          <template #scope-cell="{ row }">{{ scopeLabel(row.original.scope) }}</template>
          <template #boundFingerprint-cell="{ row }">
            <span class="text-dimmed">{{ row.original.boundFingerprint || '未绑定' }}</span>
          </template>
          <template #expiresAt-cell="{ row }">
            <span :class="recordStatus(row.original).color === 'warning' ? 'text-amber-600' : ''">
              {{ formatDate(row.original.expiresAt) }}
            </span>
          </template>
          <template #issuedAt-cell="{ row }">{{ formatTime(row.original.issuedAt) }}</template>
          <template #reissuedAt-cell="{ row }">{{ formatTime(row.original.reissuedAt) }}</template>
          <template #status-cell="{ row }">
            <UBadge
              :color="recordStatus(row.original).color"
              :label="recordStatus(row.original).label"
            />
          </template>
          <template #actions-cell="{ row }">
            <GuardedButton
              size="sm"
              variant="ghost"
              icon="i-lucide-file-down"
              label="导出"
              :loading="exportingId === row.original.delegationId"
              :disabled="!row.original.exportable"
              disabled-reason="该记录没有保存授权文件快照，请重新签发或批量重签"
              @click="exportRecord(row.original)"
            />
            <UButton
              v-if="!row.original.revokedAt"
              size="sm"
              color="error"
              variant="ghost"
              label="作废"
              @click="openRevoke(row.original)"
            />
          </template>
        </UTable>
      </div>
    </section>

    <!-- 签发对话框 -->
    <UModal
      v-model:open="issueOpen"
      title="按年级签发授权包"
      :ui="{ content: 'w-full max-w-lg', footer: 'justify-end' }"
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <UFormField
            label="年级（可多个）"
            required
            description="每个标签是一个年级；每个年级自动生成一份年级授权，并包含当前单位配置中的全部班级授权。"
          >
            <UInputTags
              v-model="form.grades"
              :max="20"
              add-on-paste
              add-on-tab
              add-on-blur
              delimiter=","
              placeholder="输入四位年级后按回车，例如 2025；每个年级单独一个标签"
              class="w-full"
            />
            <p v-if="invalidGrades.length" class="text-sm text-error mt-1">
              年级必须为四位数字：{{ invalidGrades.join('、') }}
            </p>
          </UFormField>

          <UFormField label="备注（选填）">
            <UInput v-model="form.holderLabel" placeholder="如：高二年级管理员" class="w-full" />
          </UFormField>

          <UFormField
            label="有效期"
            required
            :description="maxDate ? `不得晚于单位授权到期日 ${formatDate(notAfter)}` : ''"
          >
            <div class="flex flex-wrap gap-2 mb-2">
              <UButton
                v-for="shortcut in expiryShortcuts"
                :key="shortcut.label"
                size="sm"
                color="neutral"
                variant="outline"
                :label="shortcut.label"
                @click="setExpiryShortcut(shortcut)"
              />
            </div>
            <UInputDate
              ref="dateRef"
              :model-value="form.expiresAt"
              :min="minDate"
              class="w-full"
              :ui="{ base: 'justify-center' }"
            >
              <template #trailing>
                <UPopover :reference="dateRef?.inputsRef?.[3]?.$el">
                  <UButton
                    color="neutral"
                    variant="link"
                    size="sm"
                    icon="i-lucide-calendar"
                    aria-label="选择日期"
                    class="px-0"
                  />
                  <template #content>
                    <UCalendar v-model="form.expiresAt" :max="maxDate" class="p-2" />
                  </template>
                </UPopover>
              </template>
            </UInputDate>
          </UFormField>

          <UFormField label="口令" required description="口令需线下告知下级">
            <UInput
              v-model="form.password"
              type="password"
              class="w-full"
              @keyup.enter="canSubmit && submitIssue()"
            />
          </UFormField>

          <UAlert v-if="formError" color="error" :title="formError" variant="soft" />
        </div>
      </template>
      <template #footer>
        <UButton label="取消" color="neutral" variant="outline" @click="issueOpen = false" />
        <GuardedButton
          :label="submitLabel"
          :loading="submitting"
          :disabled="!canSubmit"
          :disabled-reason="submitDisabledReason"
          @click="requestIssueSubmit"
        />
      </template>
    </UModal>

    <UModal
      v-model:open="noBatchConfirmOpen"
      :title="noBatchAction === 'reissue' ? '重签包中没有最新批次' : '当前没有可下发批次'"
      :description="
        noBatchAction === 'reissue'
          ? '重签仍会更新有效期、配置和密钥，但不会向下级新增可用批次；下级本机已有的历史批次不会被删除。'
          : '下级账号不能自行创建批次；继续签发后可以激活账号，但必须等待一级重新签发或重签包含批次的授权，才能导入学生文件。'
      "
      :ui="{ content: 'w-full max-w-md', footer: 'justify-end' }"
    >
      <template #body>
        <UAlert
          color="warning"
          variant="soft"
          icon="i-lucide-triangle-alert"
          title="建议先创建并激活至少一个批次"
          description="该限制不强制；确认后仍可生成不含批次的授权包。"
        />
      </template>
      <template #footer>
        <UButton
          label="取消"
          color="neutral"
          variant="outline"
          @click="cancelNoBatchConfirm"
        />
        <UButton
          :label="noBatchAction === 'reissue' ? '仍然重签' : '仍然签发'"
          color="warning"
          @click="confirmWithoutBatch"
        />
      </template>
    </UModal>

    <!-- 批量重签对话框 -->
    <UModal
      v-model:open="reissueOpen"
      title="批量重签"
      :ui="{ content: 'w-full max-w-md', footer: 'justify-end' }"
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <UAlert
            color="info"
            variant="subtle"
            icon="i-lucide-info"
            title="续期说明"
            description="续期（导入新证书）后需批量重签，下级导入新文件方可延期。"
          />
          <UFormField label="统一新口令" required description="口令需线下告知下级">
            <UInput
              v-model="reissuePassword"
              type="password"
              class="w-full"
              @keyup.enter="requestReissue"
            />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <UButton label="取消" color="neutral" variant="outline" @click="reissueOpen = false" />
        <GuardedButton
          label="开始重签"
          :loading="reissuing"
          :disabled="!reissuePassword"
          disabled-reason="请输入统一的新口令"
          @click="requestReissue"
        />
      </template>
    </UModal>

    <!-- 本地作废确认 -->
    <UModal
      v-model:open="revokeOpen"
      title="本地作废"
      :ui="{ content: 'w-full max-w-md', footer: 'justify-end' }"
    >
      <template #body>
        <UAlert
          color="error"
          variant="soft"
          icon="i-lucide-triangle-alert"
          title="本地作废仅用于台账与审计，不能撤销已发出的授权文件；真正吊销需等其到期或在线模式。"
          description="作废后该条记录从正常改为已作废，不影响下级已导入的授权文件。确定作废吗？"
        />
      </template>
      <template #footer>
        <UButton label="取消" color="neutral" variant="outline" @click="revokeOpen = false" />
        <UButton label="确认作废" color="error" :loading="revoking" @click="submitRevoke" />
      </template>
    </UModal>

    <UModal
      v-model:open="bulkRevokeOpen"
      title="批量作废授权"
      :description="`将作废选中的 ${selectedActiveCount} 份有效授权。离线作废只更新本机台账，不影响已经发出的文件。`"
      :ui="{ content: 'w-full max-w-md', footer: 'justify-end' }"
    >
      <template #body>
        <UAlert
          color="error"
          variant="soft"
          icon="i-lucide-triangle-alert"
          title="此操作会批量更新台账并写入审计日志"
          description="如需再次使用同一账号范围，可重新按年级签发，新授权会覆盖该范围的旧台账记录。"
        />
      </template>
      <template #footer>
        <UButton label="取消" color="neutral" variant="outline" @click="bulkRevokeOpen = false" />
        <UButton
          label="确认批量作废"
          color="error"
          :loading="bulkRevoking"
          @click="submitBulkRevoke"
        />
      </template>
    </UModal>
  </div>
</template>

<style scoped>
.delegation-page {
  flex: 1 1 0%;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: hidden;
}
.certificate-bar,
.table-toolbar,
.table-actions,
.certificate-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.certificate-bar {
  flex: 0 0 auto;
}
.certificate-actions,
.table-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
}
.table-section {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.table-toolbar {
  flex: 0 0 auto;
  justify-content: space-between;
}
.table-scroll {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
}
@media (max-width: 900px) {
  .certificate-bar,
  .table-toolbar {
    align-items: stretch;
    flex-direction: column;
  }
  .certificate-actions,
  .table-actions {
    justify-content: flex-start;
  }
}
</style>
