<script setup lang="ts">
import { onMounted } from 'vue'
import { useTheme } from '../composables/useTheme'

const { initTheme } = useTheme()

onMounted(initTheme)
</script>

<template>
  <div class="titlebar">
    <span class="title">学生综合素质测评管理系统</span>
  </div>
</template>

<style scoped>
.titlebar {
  display: flex;
  align-items: center;
  height: 35px;
  padding-left: 12px;
  /* 右侧留出 Windows 窗口控制按钮（titleBarOverlay）空间 */
  padding-right: 150px;
  background: var(--ui-bg);
  border-bottom: 1px solid var(--ui-border);
  -webkit-app-region: drag;
  user-select: none;
  flex-shrink: 0;
}
.title {
  font-size: 13px;
  color: var(--ui-text-muted);
}
</style>
