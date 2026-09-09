<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useToast } from '@nuxt/ui/composables'
import { ipcErrorMessage } from '../utils/ipc'
import GuardedButton from '../components/GuardedButton.vue'

const emit = defineEmits<{ initialized: [] }>()
const toast = useToast()

// online（授权码激活）
const isDev = ref(false)
const serverUrl = ref('')
const code = ref('')

const submitting = ref(false)
const error = ref('')
const hasAccounts = ref(false)
const resuming = ref(false)

const canSubmit = computed(() => code.value.trim().length > 0)
const submitDisabledReason = computed(() => (!code.value.trim() ? '请输入授权码' : ''))

onMounted(async () => {
  isDev.value = await window.api.app.isDev()
  hasAccounts.value = await window.api.unit.hasAccounts()
  if (!isDev.value) return
  try {
    const info = await window.api.unit.getActivationInfo()
    if (info.serverUrl) serverUrl.value = info.serverUrl
  } catch {
    // 忽略
  }
})

async function submit(): Promise<void> {
  error.value = ''
  if (!code.value.trim()) {
    error.value = '请输入授权码'
    return
  }
  submitting.value = true
  try {
    await window.api.unit.activate({
      code: code.value.trim(),
      serverUrl: isDev.value ? serverUrl.value.trim() : undefined
    })
    toast.add({ title: '激活成功', color: 'success' })
    emit('initialized')
  } catch (err) {
    error.value = ipcErrorMessage(err)
  } finally {
    submitting.value = false
  }
}

/** 返回我的系统：恢复到最近使用的账号（主进程切库并重载窗口）。 */
async function resume(): Promise<void> {
  resuming.value = true
  try {
    await window.api.unit.resume()
  } catch (err) {
    error.value = ipcErrorMessage(err)
    resuming.value = false
  }
}
</script>

<template>
  <div class="activate-screen">
    <UCard class="activate-card">
      <template #title>学生综合素质测评管理系统</template>
      <template #description> 请输入授权码激活系统（授权码由服务商提供） </template>
      <template #default>
        <div class="form">
          <UFormField v-if="isDev" label="服务端地址（开发模式）">
            <UInput v-model="serverUrl" placeholder="http://127.0.0.1:3000" class="w-full" />
          </UFormField>

          <UFormField label="授权码">
            <UInput
              v-model="code"
              placeholder="DMS-XXXX-XXXX-XXXX"
              class="code-input w-full"
              autocomplete="off"
              @keyup.enter="canSubmit && submit()"
            />
          </UFormField>

          <UAlert v-if="error" color="error" :title="error" variant="soft" />
        </div>
      </template>
      <template #footer>
        <div class="footer">
          <UButton
            v-if="hasAccounts"
            label="返回我的系统"
            color="neutral"
            variant="outline"
            :loading="resuming"
            block
            @click="resume"
          />
          <GuardedButton
            label="激活并进入系统"
            :loading="submitting"
            :disabled="!canSubmit"
            :disabled-reason="submitDisabledReason"
            block
            @click="submit"
          />
        </div>
      </template>
    </UCard>
  </div>
</template>

<style scoped>
.activate-screen {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  background: var(--ui-bg-muted);
}
.activate-card {
  width: 420px;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.footer {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.code-input :deep(input) {
  font-family: 'Cascadia Code', Consolas, monospace;
  letter-spacing: 1px;
}
</style>
