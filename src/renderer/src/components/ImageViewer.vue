<script setup lang="ts">
/**
 * 图片查看器（证明材料 / 确认单共用）：居中显示、适应窗口，支持滚轮/按钮缩放、拖拽平移、
 * 多图翻页；可选「保存图片」。替代原「证明材料」网格弹窗（不居中、不能放大的问题，issue #5）。
 */
import { computed, ref, watch } from 'vue'
import { useToast } from '@nuxt/ui/composables'
import { ipcErrorMessage } from '../utils/ipc'

const props = withDefaults(
  defineProps<{
    open: boolean
    title?: string
    images: { src: string; label?: string }[]
    /** 是否显示「保存图片」。 */
    allowSave?: boolean
    /** 保存时默认文件名（不含序号与扩展名）。 */
    saveName?: string
  }>(),
  { title: '图片', allowSave: false, saveName: '图片' }
)
const emit = defineEmits<{ 'update:open': [boolean] }>()

const toast = useToast()
const index = ref(0)
const scale = ref(1)
const tx = ref(0)
const ty = ref(0)
const dragging = ref(false)
let startX = 0
let startY = 0

const current = computed(() => props.images[index.value] ?? null)
const count = computed(() => props.images.length)

function reset(): void {
  scale.value = 1
  tx.value = 0
  ty.value = 0
}

watch(
  () => props.open,
  (v) => {
    if (v) {
      index.value = 0
      reset()
    }
  }
)
watch(index, reset)

function go(delta: number): void {
  if (!count.value) return
  index.value = (index.value + delta + count.value) % count.value
}

function zoom(delta: number): void {
  scale.value = Math.min(6, Math.max(0.5, Number((scale.value + delta).toFixed(2))))
  if (scale.value === 1) {
    tx.value = 0
    ty.value = 0
  }
}

function onWheel(e: WheelEvent): void {
  e.preventDefault()
  zoom(e.deltaY < 0 ? 0.2 : -0.2)
}

function onPointerDown(e: PointerEvent): void {
  if (scale.value <= 1) return
  dragging.value = true
  startX = e.clientX - tx.value
  startY = e.clientY - ty.value
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
}
function onPointerMove(e: PointerEvent): void {
  if (!dragging.value) return
  tx.value = e.clientX - startX
  ty.value = e.clientY - startY
}
function onPointerUp(): void {
  dragging.value = false
}

/** 依 data URL 前缀猜测扩展名（保存用）。 */
function extOf(src: string): string {
  if (src.startsWith('data:image/png')) return 'png'
  if (src.startsWith('data:image/webp')) return 'webp'
  if (src.startsWith('data:image/gif')) return 'gif'
  return 'jpg'
}

async function save(): Promise<void> {
  if (!current.value) return
  try {
    const suffix = count.value > 1 ? `-${index.value + 1}` : ''
    const path = await window.api.export.saveImage(
      `${props.saveName}${suffix}.${extOf(current.value.src)}`,
      current.value.src
    )
    if (path) toast.add({ title: '已保存', description: path, color: 'success' })
  } catch (err) {
    toast.add({ title: '保存失败', description: ipcErrorMessage(err), color: 'error' })
  }
}
</script>

<template>
  <UModal
    :open="open"
    :title="title"
    :ui="{ content: 'w-full max-w-4xl' }"
    @update:open="emit('update:open', $event)"
  >
    <template #body>
      <div v-if="!count" class="py-10 text-center text-sm text-dimmed">暂无图片</div>
      <div v-else class="viewer">
        <div
          class="stage"
          @wheel="onWheel"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointerleave="onPointerUp"
        >
          <img
            v-if="current"
            :src="current.src"
            class="img"
            :class="{ grab: scale > 1, grabbing: dragging }"
            :style="{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }"
            alt="预览图"
            draggable="false"
          />
        </div>
        <div class="toolbar">
          <div class="flex items-center gap-1">
            <UButton icon="i-lucide-zoom-out" size="sm" variant="ghost" @click="zoom(-0.2)" />
            <span class="scale-label">{{ Math.round(scale * 100) }}%</span>
            <UButton icon="i-lucide-zoom-in" size="sm" variant="ghost" @click="zoom(0.2)" />
            <UButton label="重置" size="sm" variant="ghost" @click="reset" />
          </div>
          <div v-if="count > 1" class="flex items-center gap-2">
            <UButton icon="i-lucide-chevron-left" size="sm" variant="ghost" @click="go(-1)" />
            <span class="text-sm text-dimmed">{{ index + 1 }} / {{ count }}</span>
            <UButton icon="i-lucide-chevron-right" size="sm" variant="ghost" @click="go(1)" />
          </div>
          <UButton
            v-if="allowSave && current"
            label="保存图片"
            icon="i-lucide-download"
            size="sm"
            variant="outline"
            @click="save"
          />
        </div>
        <div v-if="current?.label" class="text-center text-sm text-dimmed">{{ current.label }}</div>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.viewer {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.stage {
  position: relative;
  height: min(60vh, 520px);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: var(--ui-bg-muted, rgba(0, 0, 0, 0.04));
  border-radius: 8px;
  touch-action: none;
}
.img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  transform-origin: center center;
  transition: transform 0.05s linear;
  user-select: none;
}
.img.grab {
  cursor: grab;
}
.img.grabbing {
  cursor: grabbing;
}
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.scale-label {
  min-width: 44px;
  text-align: center;
  font-size: 12px;
  color: var(--ui-text-dimmed);
}
</style>
