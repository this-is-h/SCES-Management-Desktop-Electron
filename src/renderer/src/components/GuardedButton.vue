<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'

defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    label?: string
    icon?: string
    loading?: boolean
    disabled?: boolean
    disabledReason?: string
  }>(),
  {
    label: undefined,
    icon: undefined,
    loading: false,
    disabled: false,
    disabledReason: '当前操作不可用，请检查页面状态后重试'
  }
)
const emit = defineEmits<{ click: [event: MouseEvent] }>()
const toast = useToast()

function onClick(event: MouseEvent): void {
  if (props.disabled) {
    toast.add({ title: '当前操作不可用', description: props.disabledReason, color: 'warning' })
    return
  }
  emit('click', event)
}
</script>

<template>
  <UButton
    v-bind="$attrs"
    :label="label"
    :icon="icon"
    :loading="loading"
    :disabled="loading"
    :aria-disabled="disabled"
    :title="disabled ? disabledReason : undefined"
    :class="disabled ? 'opacity-50 cursor-not-allowed' : ''"
    @click="onClick"
  >
    <slot />
  </UButton>
</template>
