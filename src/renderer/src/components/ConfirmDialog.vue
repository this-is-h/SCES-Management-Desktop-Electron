<script setup lang="ts">
/**
 * 程序化确认对话框（配合 useOverlay）：
 * 确认/取消分别 emit close(true/false)，overlay.open() 的 Promise 据此 resolve。
 */
type ConfirmColor = 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'error' | 'neutral'

interface Props {
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  confirmColor?: ConfirmColor
}

withDefaults(defineProps<Props>(), {
  description: undefined,
  confirmLabel: '确认',
  cancelLabel: '取消',
  confirmColor: 'primary'
})

const emits = defineEmits<{ close: [value: boolean] }>()
</script>

<template>
  <UModal
    :title="title"
    :description="description"
    :dismissible="false"
    :close="false"
    :ui="{ footer: 'justify-end' }"
  >
    <template #footer>
      <UButton
        :label="cancelLabel"
        color="neutral"
        variant="outline"
        @click="emits('close', false)"
      />
      <UButton :label="confirmLabel" :color="confirmColor" @click="emits('close', true)" />
    </template>
  </UModal>
</template>
