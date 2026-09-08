<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { licenseRefreshTick } from '../stores/license-state'

/** 顶栏授权提示（两模式共用，由 getLicenseStatus 驱动，dual-mode/03 §5/§6、06 §6）。 */
interface LicState {
  activated: boolean
  expired: boolean
  rolledBack: boolean
  daysRemaining?: number
  expiresAt?: number
  pubkeyReminder: boolean
}

const state = ref<LicState>({ activated: false, expired: false, rolledBack: false, pubkeyReminder: false })

async function refresh(): Promise<void> {
  try {
    const lic = await window.api.unit.getLicense()
    if (!lic.activated) {
      state.value = { activated: false, expired: false, rolledBack: false, pubkeyReminder: false }
      return
    }
    // 离线且未导出公钥包 → 提醒（学生端拿不到申请公钥）。
    let pubkeyReminder = false
    const caps = await window.api.app.getCapabilities()
    if (caps.transport === 'file') {
      const info = await window.api.unit.getActivationInfo()
      pubkeyReminder = info.role === 'level1' && info.pubkeyExported !== true
    }
    state.value = {
      activated: true,
      expired: lic.expired,
      rolledBack: lic.rolledBack === true,
      daysRemaining: lic.daysRemaining,
      expiresAt: lic.expiresAt,
      pubkeyReminder
    }
  } catch {
    state.value = { activated: false, expired: false, rolledBack: false, pubkeyReminder: false }
  }
}

const banners = computed<Array<{ color: 'error' | 'warning'; text: string }>>(() => {
  const s = state.value
  if (!s.activated) return []
  const out: Array<{ color: 'error' | 'warning'; text: string }> = []
  if (s.rolledBack) {
    out.push({
      color: 'error',
      text: '检测到系统时间异常（本机记录的最近使用时间晚于当前时间），请校正系统时间后重试'
    })
  }
  if (s.expired) {
    out.push({ color: 'error', text: '授权已过期，当前仅可查看历史数据，请联系服务商续期' })
  } else if (typeof s.daysRemaining === 'number' && s.daysRemaining <= 30) {
    const date = s.expiresAt ? new Date(s.expiresAt).toLocaleDateString('zh-CN') : ''
    out.push({ color: 'warning', text: `授权将于 ${date} 到期，请联系服务商续期` })
  }
  if (s.pubkeyReminder) {
    out.push({
      color: 'warning',
      text: '尚未导出公钥包：学生端将拿不到申请公钥。请到「设置 → 授权」导出公钥包并发给服务商'
    })
  }
  return out
})
watch(licenseRefreshTick, () => void refresh())

let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  void refresh()
  // 定时刷新：捕获到期跨点、时钟回拨；也推进主进程的单调时间水位。
  timer = setInterval(() => void refresh(), 60_000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div v-if="banners.length" class="shrink-0">
    <UAlert
      v-for="(b, i) in banners"
      :key="i"
      :color="b.color"
      :title="b.text"
      variant="subtle"
      :ui="{ root: 'rounded-none py-2' }"
    />
  </div>
</template>
