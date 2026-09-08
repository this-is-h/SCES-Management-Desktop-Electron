<script setup lang="ts">
/** 拖入文件遮罩层：文件拖入窗口时全屏提示“松开鼠标即可导入”，由 useFileDrop 控制 active。 */
defineProps<{ active: boolean }>()
</script>

<template>
  <Teleport to="body">
    <div
      v-if="active"
      data-slot="fileDropOverlay"
      class="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm"
    >
      <div
        class="rounded-2xl border-2 border-dashed border-primary/60 bg-elevated/95 px-16 py-12 text-center shadow-xl"
      >
        <UIcon name="i-lucide-file-up" class="mx-auto mb-4 size-12 text-primary" />
        <p class="text-lg font-medium">松开鼠标，导入 .dyf 申请文件</p>
        <p class="mt-1 text-sm text-dimmed">支持单个或多个文件，松开后立即开始导入</p>
      </div>
    </div>
  </Teleport>
</template>
