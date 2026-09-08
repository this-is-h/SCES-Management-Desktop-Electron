<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useToast } from '@nuxt/ui/composables'
import type { AdminCapabilities, LicenseFilePreview } from '../../../preload/types'
import { ipcErrorMessage } from '../utils/ipc'
import GuardedButton from '../components/GuardedButton.vue'

const emit = defineEmits<{ initialized: [] }>()
const toast = useToast()

const caps = ref<AdminCapabilities | null>(null)
const isOffline = computed(() => caps.value?.unitActivation === 'license-file')

// online（授权码）
const isDev = ref(false)
const serverUrl = ref('')
const code = ref('')

// offline（授权文件）
const fingerprint = ref('')
const licensePath = ref('')
const preview = ref<LicenseFilePreview | null>(null)
const password = ref('')

const submitting = ref(false)
const error = ref('')
const hasAccounts = ref(false)
const resuming = ref(false)

const roleText = computed(() => {
  const r = preview.value?.role
  if (r === 'level1') return '单位管理员'
  if (r === 'level2') return '年级管理员'
  if (r === 'level3') return '班级管理员'
  return ''
})

const canSubmit = computed(() =>
  isOffline.value ? preview.value !== null && password.value.length > 0 : code.value.trim().length > 0
)
const submitDisabledReason = computed(() => {
  if (isOffline.value) {
    if (!preview.value) return '请先选择并确认有效的授权文件'
    if (!password.value) return '请输入授权文件口令'
  } else if (!code.value.trim()) {
    return '请输入授权码'
  }
  return '请补全激活信息后重试'
})

onMounted(async () => {
  try {
    caps.value = await window.api.app.getCapabilities()
  } catch {
    // 忽略：caps 加载失败时默认按在线表单渲染
  }
  isDev.value = await window.api.app.isDev()
  hasAccounts.value = await window.api.unit.hasAccounts()
  if (caps.value?.showFingerprint) {
    try {
      fingerprint.value = (await window.api.unit.getFingerprint()).code
    } catch {
      // 忽略
    }
  }
  if (!isOffline.value) {
    const info = await window.api.unit.getActivationInfo()
    if (info.serverUrl) serverUrl.value = info.serverUrl
  }
})

async function copyFingerprint(): Promise<void> {
  if (!fingerprint.value) return
  await navigator.clipboard.writeText(fingerprint.value)
  toast.add({ title: '已复制机器码', color: 'success' })
}

/** 选择授权文件 → 验签读 header（不需口令），展示单位信息供确认。 */
async function pickLicense(): Promise<void> {
  error.value = ''
  try {
    const path = await window.api.unit.pickLicense()
    if (!path) return
    licensePath.value = path
    preview.value = await window.api.unit.inspectLicense(path)
    if (!preview.value) error.value = '无法读取该授权文件'
  } catch (err) {
    preview.value = null
    error.value = ipcErrorMessage(err)
  }
}

async function submit(): Promise<void> {
  error.value = ''
  submitting.value = true
  try {
    if (isOffline.value) {
      await window.api.unit.activate({
        kind: 'license-file',
        filePath: licensePath.value,
        password: password.value
      })
    } else {
      if (!code.value.trim()) {
        error.value = '请输入授权码'
        return
      }
      await window.api.unit.activate({
        kind: 'license-code',
        code: code.value.trim(),
        serverUrl: isDev.value ? serverUrl.value.trim() : undefined
      })
    }
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

function formatDate(ts?: number): string {
  return ts ? new Date(ts).toLocaleDateString('zh-CN') : '—'
}
</script>

<template>
  <div class="activate-screen">
    <UCard class="activate-card">
      <template #title>学生综合素质测评管理系统</template>
      <template #description>
        {{ isOffline ? '请导入授权文件激活系统（授权文件由服务商提供）' : '请输入授权码激活系统（授权码由服务商提供）' }}
      </template>
      <template #default>
        <!-- 离线：机器码 + 授权文件 + 两步激活 -->
        <div v-if="isOffline" class="form">
          <UFormField v-if="fingerprint" label="本机机器码" description="签发授权/换机时提供给服务商">
            <div class="flex items-center gap-2">
              <UInput :model-value="fingerprint" readonly class="code-input w-full" />
              <UButton icon="i-lucide-copy" color="neutral" variant="outline" @click="copyFingerprint" />
            </div>
          </UFormField>

          <UFormField label="授权文件（.dysl / .dysd）">
            <div class="flex items-center gap-2">
              <UInput
                :model-value="preview ? '已选择：' + (licensePath.split(/[\\/]/).pop() ?? '') : ''"
                readonly
                placeholder="尚未选择授权文件"
                class="w-full"
              />
              <UButton label="浏览" color="neutral" variant="outline" @click="pickLicense" />
            </div>
          </UFormField>

          <!-- 验签后的 header 展示：确认无误再输口令 -->
          <div v-if="preview" class="preview">
            <div class="preview-row"><span class="preview-key">单位</span><span>{{ preview.unitName }}</span></div>
            <div class="preview-row"><span class="preview-key">角色</span><span>{{ roleText }}</span></div>
            <div
              v-if="preview.scope?.grade || preview.scope?.class"
              class="preview-row"
            >
              <span class="preview-key">数据范围</span>
              <span>{{ preview.scope?.class ?? preview.scope?.grade }}</span>
            </div>
            <div class="preview-row"><span class="preview-key">有效期至</span><span>{{ formatDate(preview.expiresAt) }}</span></div>
          </div>

          <UFormField v-if="preview" label="口令">
            <UInput
              v-model="password"
              type="password"
              placeholder="服务商单独提供的口令"
              class="w-full"
              @keyup.enter="canSubmit && submit()"
            />
          </UFormField>

          <UAlert v-if="error" color="error" :title="error" variant="soft" />
        </div>

        <!-- 在线：授权码 -->
        <div v-else class="form">
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
.preview {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border-radius: 8px;
  background: var(--ui-bg-elevated);
  font-size: 13px;
}
.preview-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.preview-key {
  color: var(--ui-text-muted);
}
.code-input :deep(input) {
  font-family: 'Cascadia Code', Consolas, monospace;
  letter-spacing: 1px;
}
</style>
