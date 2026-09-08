<script setup lang="ts">
/**
 * 批次选择下拉（德育分页面共用）：选项与选中值均展示状态 Badge（未开放/进行中/已结束）
 * 与测试 Badge。标签统一来自 shared BATCH_STATUS_LABELS。
 */
import { computed } from 'vue'
import type { Batch } from '@sces/shared'
import { batchStatusColor, batchStatusLabel } from '../utils/batch-status'

const props = withDefaults(
  defineProps<{
    batches: Batch[]
    modelValue: string
    placeholder?: string
    disabled?: boolean
  }>(),
  { placeholder: '选择批次', disabled: false }
)

const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()

function batchLabel(b: Batch): string {
  return `${b.year} 学年第 ${b.semester} 学期批次`
}

interface BatchOption {
  label: string
  value: string
  status?: Batch['status']
  isTest?: boolean
  disabled?: boolean
}

const options = computed<BatchOption[]>(() =>
  props.batches.length
    ? props.batches.map((b) => ({
        label: batchLabel(b),
        value: b.batchId,
        status: b.status,
        isTest: b.isTest === true
      }))
    : [{ label: '暂无批次，请先在「批次管理」创建', value: '__none__', disabled: true }]
)

const selected = computed(() => props.batches.find((b) => b.batchId === props.modelValue) ?? null)
</script>

<template>
  <USelect
    :model-value="modelValue"
    :items="options"
    :placeholder="placeholder"
    :disabled="disabled"
    class="w-full"
    @update:model-value="(v) => emit('update:modelValue', String(v ?? ''))"
  >
    <template #default>
      <span class="inline-flex min-w-0 items-center gap-1.5">
        <span class="truncate">{{ selected ? batchLabel(selected) : placeholder }}</span>
        <UBadge
          v-if="selected"
          size="xs"
          :color="batchStatusColor[selected.status]"
          :label="batchStatusLabel(selected.status)"
          class="shrink-0"
        />
        <UBadge
          v-if="selected?.isTest"
          size="xs"
          color="warning"
          variant="subtle"
          label="测试"
          class="shrink-0"
        />
      </span>
    </template>
    <template #item-label="{ item }">
      <span v-if="item.value === '__none__'" class="text-dimmed">{{ item.label }}</span>
      <span v-else class="inline-flex min-w-0 items-center gap-1.5">
        <span class="truncate">{{ item.label }}</span>
        <UBadge
          v-if="item.status"
          size="xs"
          :color="batchStatusColor[item.status]"
          :label="batchStatusLabel(item.status)"
          class="shrink-0"
        />
        <UBadge
          v-if="item.isTest"
          size="xs"
          color="warning"
          variant="subtle"
          label="测试"
          class="shrink-0"
        />
      </span>
    </template>
  </USelect>
</template>
