<script setup lang="ts">
import { onMounted, ref } from 'vue'
import InitView from './views/InitView.vue'
import AppLayout from './components/AppLayout.vue'

// 启动门槛：未初始化（无单位）→ 初始化向导；已初始化 → 进入系统
const initialized = ref<boolean | null>(null)

onMounted(async () => {
  try {
    initialized.value = await window.api.unit.isInitialized()
  } catch (err) {
    console.error('检查初始化状态失败', err)
    initialized.value = false
  }
})
</script>

<template>
  <!-- UApp：Toast / Tooltip / 程序化弹层（useOverlay）的根容器，必需 -->
  <UApp>
    <div v-if="initialized === null" class="boot-screen">正在加载…</div>
    <InitView v-else-if="!initialized" @initialized="initialized = true" />
    <AppLayout v-else />
  </UApp>
</template>

<style scoped>
.boot-screen {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  color: var(--ui-text-muted);
  font-size: 14px;
}
</style>
