<script setup lang="ts">
/**
 * 导入结果弹窗：一次 .dyf 导入完成后自动弹出，汇总每个文件的处理结果
 * （已导入 / 已拒绝 / 待处理冲突 / 文件错误）与说明（含非阻断警告）。
 * 替代原「总体情况」页内联的结果显示块（决策 #19 调整：导入反馈走弹窗）。
 * 学号冲突的逐条处理仍在「总体情况」页的冲突弹窗内完成（本窗只提示数量与去向）。
 */
import { computed } from 'vue'
import type { ImportFileResult } from '../../../preload/types'

const props = defineProps<{
  open: boolean
  results: ImportFileResult[]
}>()
const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>()

const resultMeta: Record<
  ImportFileResult['decision'],
  { label: string; color: 'success' | 'error' | 'warning' | 'neutral' }
> = {
  accept: { label: '已导入', color: 'success' },
  reject: { label: '已拒绝', color: 'error' },
  conflict: { label: '待处理冲突', color: 'warning' },
  error: { label: '文件错误', color: 'neutral' }
}

const summary = computed(() => {
  const by = (d: ImportFileResult['decision']): number =>
    props.results.filter((r) => r.decision === d).length
  return {
    accept: by('accept'),
    conflict: by('conflict'),
    reject: by('reject'),
    error: by('error')
  }
})

/** 说明列：主原因 + 非阻断警告，分号连接。 */
function detailText(r: ImportFileResult): string {
  const parts: string[] = []
  if (r.reason) parts.push(r.reason)
  if (r.warnings?.length) parts.push(...r.warnings)
  return parts.join('；') || '—'
}
</script>

<template>
  <UModal
    :open="props.open"
    title="导入结果"
    :ui="{ content: 'w-full max-w-3xl', footer: 'justify-end' }"
    @update:open="emit('update:open', $event)"
  >
    <template #body>
      <div class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center gap-2">
          <UBadge color="success" variant="subtle" :label="`已导入 ${summary.accept}`" />
          <UBadge color="warning" variant="subtle" :label="`待处理冲突 ${summary.conflict}`" />
          <UBadge color="error" variant="subtle" :label="`已拒绝 ${summary.reject}`" />
          <UBadge color="neutral" variant="subtle" :label="`文件错误 ${summary.error}`" />
        </div>

        <UAlert
          v-if="summary.conflict > 0"
          color="warning"
          variant="soft"
          icon="i-lucide-triangle-alert"
          title="存在待处理学号冲突"
          :description="`共 ${summary.conflict} 条。关闭本窗后，在「总体情况」页点击「学号冲突」按钮逐条处理。`"
        />

        <UTable
          :data="props.results"
          :columns="[
            { accessorKey: 'fileName', header: '文件' },
            { accessorKey: 'decision', header: '结果' },
            { accessorKey: 'studentId', header: '学号' },
            { accessorKey: 'name', header: '姓名' },
            { accessorKey: 'reason', header: '说明' }
          ]"
          :ui="{ th: 'px-3 py-2 text-xs font-medium', td: 'px-3 py-1.5 text-sm' }"
        >
          <template #fileName-cell="{ row }">
            <span class="whitespace-nowrap">{{ row.original.fileName }}</span>
          </template>
          <template #decision-cell="{ row }">
            <UBadge
              :color="resultMeta[row.original.decision].color"
              :label="resultMeta[row.original.decision].label"
            />
          </template>
          <template #studentId-cell="{ row }">{{ row.original.studentId || '—' }}</template>
          <template #name-cell="{ row }">{{ row.original.name || '—' }}</template>
          <template #reason-cell="{ row }">
            <span class="text-sm">{{ detailText(row.original) }}</span>
          </template>
        </UTable>
      </div>
    </template>
    <template #footer>
      <UButton label="关闭" color="neutral" variant="outline" @click="emit('update:open', false)" />
    </template>
  </UModal>
</template>
