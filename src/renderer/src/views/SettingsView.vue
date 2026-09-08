<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useToast } from '@nuxt/ui/composables'
import { useTheme } from '../composables/useTheme'
import type {
  ThemeMode,
  DataDirInfo,
  AccountInfo,
  AdminCapabilities,
  ActivationInfo,
  LicenseFilePreview,
  UpdateCheckResult
} from '../../../preload/types'
import { ipcErrorMessage } from '../utils/ipc'
import { fullUnitName } from '../utils/unit-name'
import { bumpLicenseRefresh } from '../stores/license-state'
import GuardedButton from '../components/GuardedButton.vue'

const props = withDefaults(defineProps<{ tab?: string }>(), { tab: 'settings-general' })

const toast = useToast()
const { mode, setThemeMode } = useTheme()

const themeOptions: { label: string; value: ThemeMode }[] = [
  { label: '亮色', value: 'light' },
  { label: '暗色', value: 'dark' },
  { label: '跟随系统', value: 'system' }
]

// 授权信息
const expiresAt = ref<number | undefined>()
const rebinding = ref(false)
const rebindOpen = ref(false)

// 数据存储目录
const dataInfo = ref<DataDirInfo | null>(null)
const resetOpen = ref(false)
const migrating = ref(false)

// 账号（当前已添加的单位）
const accounts = ref<AccountInfo[]>([])

// 能力矩阵 + 激活信息（离线授权信息展示）
const caps = ref<AdminCapabilities | null>(null)
const activation = ref<ActivationInfo | null>(null)
const unitName = ref('')
const rolledBack = ref(false)

// 离线：导出公钥包 / 注销 / 换机 / 更新授权
const pubkeyBusy = ref(false)
const deactivateOpen = ref(false)
const rebindOfflineOpen = ref(false)
const newFingerprint = ref('')
const rebindReason = ref('')
const renewOpen = ref(false)
const renewPath = ref('')
const renewPreview = ref<LicenseFilePreview | null>(null)
const renewPassword = ref('')
const renewBusy = ref(false)
const renewError = ref('')

onMounted(async () => {
  try {
    caps.value = await window.api.app.getCapabilities()
  } catch {
    // 忽略
  }
  try {
    const lic = await window.api.unit.getLicense()
    expiresAt.value = lic.expiresAt
    rolledBack.value = lic.rolledBack === true
  } catch {
    // 忽略
  }
  try {
    activation.value = await window.api.unit.getActivationInfo()
  } catch {
    // 忽略
  }
  try {
    unitName.value = fullUnitName(await window.api.unit.get())
  } catch {
    // 忽略
  }
  try {
    dataInfo.value = await window.api.data.getInfo()
  } catch {
    // 忽略
  }
  try {
    accounts.value = await window.api.unit.getAccounts()
  } catch {
    // 忽略
  }
})

function formatExpiry(ts?: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString('zh-CN')
}

/** 申请更换授权设备：二次确认 → 服务端作废旧码签发新码 → 本机注销回验证页。 */
async function onRebind(): Promise<void> {
  rebindOpen.value = false
  rebinding.value = true
  try {
    await window.api.unit.rebindDevice()
    // 成功后窗口由主进程重载回验证页
  } catch (err) {
    toast.add({ title: '操作失败', description: ipcErrorMessage(err), color: 'error' })
  } finally {
    rebinding.value = false
  }
}

/** 更改数据目录：直接弹出系统目录选择框，选中即迁移（成功后主进程自动重启），取消则不变。 */
async function onChangeDir(): Promise<void> {
  try {
    const picked = await window.api.data.pickDir()
    if (!picked) return // 用户取消，不修改
    migrating.value = true
    await window.api.data.setDir(picked)
  } catch (err) {
    toast.add({ title: '操作失败', description: ipcErrorMessage(err), color: 'error' })
  } finally {
    migrating.value = false
  }
}

/** 恢复默认位置：二次确认后迁移回 userData/data 并重启。 */
async function onReset(): Promise<void> {
  resetOpen.value = false
  migrating.value = true
  try {
    await window.api.data.setDir(null)
  } catch (err) {
    toast.add({ title: '操作失败', description: ipcErrorMessage(err), color: 'error' })
  } finally {
    migrating.value = false
  }
}

/** 角色中文。 */
function roleLabel(role?: AccountInfo['role']): string {
  if (!role) return ''
  const map: Record<AccountInfo['role'], string> = {
    level1: '一级管理员',
    level2: '二级管理员',
    level3: '三级管理员'
  }
  return map[role] ?? role
}

/** 复制机器码到剪贴板。 */
async function copyFingerprint(): Promise<void> {
  if (!activation.value?.fingerprint) return
  await navigator.clipboard.writeText(activation.value.fingerprint)
  toast.add({ title: '已复制机器码', color: 'success' })
}

/** 导出单位公钥包（.dysk）交服务商换取单位证书。 */
async function onPublishPubkey(): Promise<void> {
  pubkeyBusy.value = true
  try {
    const res = await window.api.unit.publishPubkey()
    if (res.exported) {
      toast.add({
        title: '公钥包已导出',
        description: '请发送给服务商换取单位证书',
        color: 'success'
      })
      if (activation.value) activation.value.pubkeyExported = true
      bumpLicenseRefresh()
    }
  } catch (err) {
    toast.add({ title: '导出失败', description: ipcErrorMessage(err), color: 'error' })
  } finally {
    pubkeyBusy.value = false
  }
}

/** 注销本机账号（删除本地数据，回未激活态；主进程随后重载窗口）。 */
async function onDeactivate(): Promise<void> {
  deactivateOpen.value = false
  try {
    await window.api.unit.deactivate()
  } catch (err) {
    toast.add({ title: '操作失败', description: ipcErrorMessage(err), color: 'error' })
  }
}

/** 离线换机：导出 .dysr 换机申请文件（不注销本机）。 */
async function onExportRebind(): Promise<void> {
  if (!newFingerprint.value.trim()) {
    toast.add({ title: '请填写新设备机器码', color: 'warning' })
    return
  }
  rebinding.value = true
  try {
    const res = await window.api.unit.exportRebindRequest(
      newFingerprint.value.trim(),
      rebindReason.value.trim()
    )
    if (res) {
      rebindOfflineOpen.value = false
      newFingerprint.value = ''
      rebindReason.value = ''
      toast.add({ title: '换机申请已导出', description: res.message, color: 'success' })
    }
  } catch (err) {
    toast.add({ title: '操作失败', description: ipcErrorMessage(err), color: 'error' })
  } finally {
    rebinding.value = false
  }
}

/** 更新授权（续期）：选择新授权文件 → 验签预览。 */
async function onPickRenew(): Promise<void> {
  renewError.value = ''
  try {
    const path = await window.api.unit.pickLicense()
    if (!path) return
    renewPath.value = path
    renewPreview.value = await window.api.unit.inspectLicense(path)
  } catch (err) {
    renewError.value = ipcErrorMessage(err)
    renewPreview.value = null
  }
}

/** 确认更新授权：口令解封激活（走幂等分支，仅更新有效期/配置）。 */
async function onRenew(): Promise<void> {
  renewError.value = ''
  if (!renewPath.value) {
    renewError.value = '请先选择授权文件'
    return
  }
  renewBusy.value = true
  try {
    await window.api.unit.activate({
      kind: 'license-file',
      filePath: renewPath.value,
      password: renewPassword.value
    })
    toast.add({ title: '授权已更新', color: 'success' })
    renewOpen.value = false
    renewPath.value = ''
    renewPreview.value = null
    renewPassword.value = ''
    const lic = await window.api.unit.getLicense()
    expiresAt.value = lic.expiresAt
    activation.value = await window.api.unit.getActivationInfo()
  } catch (err) {
    renewError.value = ipcErrorMessage(err)
  } finally {
    renewBusy.value = false
  }
}

// 自动更新：轻量版本检查（仅检查不下载，引导手动下载安装）。
const updateBusy = ref(false)
const updateResult = ref<UpdateCheckResult | null>(null)

async function onCheckUpdate(manual = true): Promise<void> {
  updateBusy.value = true
  try {
    const res = await window.api.update.check(manual)
    updateResult.value = res
    if (!res) {
      toast.add({
        title: '检查更新失败',
        description: '无法连接更新服务器，请检查网络或稍后重试',
        color: 'warning'
      })
    } else if (res.hasUpdate) {
      const kind = res.mandatory ? '发现新版本（强制更新）' : '发现新版本'
      toast.add({ title: kind, description: `当前 ${res.current} → 最新 ${res.latest}`, color: 'success' })
    } else {
      toast.add({ title: '已是最新版本', description: `当前版本 ${res.current}`, color: 'success' })
    }
  } catch (err) {
    toast.add({ title: '检查更新失败', description: ipcErrorMessage(err), color: 'error' })
  } finally {
    updateBusy.value = false
  }
}

function goDownload(): void {
  if (updateResult.value?.downloadUrl) window.open(updateResult.value.downloadUrl, '_blank')
}
</script>

<template>
  <!-- 通用：外观 + 数据位置 -->
  <div
    v-if="props.tab === 'settings-general'"
    class="flex flex-col gap-4 sm:gap-6 lg:gap-12 w-full lg:max-w-2xl mx-auto"
  >
    <div>
      <UPageCard
        title="外观"
        description="自定义系统的显示方式"
        variant="naked"
        orientation="horizontal"
        class="mb-4"
      />

      <UPageCard variant="subtle" :ui="{ container: 'divide-y divide-default' }">
        <UFormField
          label="显示模式"
          description="选择亮色、暗色或跟随系统"
          class="flex items-center justify-between not-last:pb-4 gap-2"
        >
          <URadioGroup
            v-model="mode"
            :items="themeOptions"
            orientation="horizontal"
            @update:model-value="(v) => setThemeMode(v as ThemeMode)"
          />
        </UFormField>
      </UPageCard>
    </div>

    <div>
      <UPageCard
        title="数据位置"
        :description="
          dataInfo
            ? `共 ${dataInfo.accountCount} 个单位的数据存储于此`
            : '业务数据、证明材料与审计日志的本地存储位置'
        "
        variant="naked"
        orientation="horizontal"
        class="mb-4"
      />

      <UPageCard variant="subtle" :ui="{ container: 'divide-y divide-default' }">
        <UFormField
          label="存储目录"
          :description="dataInfo ? dataInfo.dir : '加载中…'"
          class="flex items-center justify-between not-last:pb-4 gap-2"
        >
          <div class="flex items-center gap-2 shrink-0">
            <UButton
              v-if="dataInfo && !dataInfo.isDefault"
              label="恢复默认位置"
              color="neutral"
              variant="outline"
              :loading="migrating"
              @click="resetOpen = true"
            />
            <UButton
              label="更改数据目录"
              color="neutral"
              variant="outline"
              :loading="migrating"
              @click="onChangeDir"
            />
          </div>
        </UFormField>
      </UPageCard>
    </div>

    <div>
      <UPageCard
        title="更新"
        description="检查新版本并引导下载安装（不自动覆盖安装包）"
        variant="naked"
        orientation="horizontal"
        class="mb-4"
      />
      <UPageCard variant="subtle" :ui="{ container: 'divide-y divide-default' }">
        <UFormField
          label="检查更新"
          description="自动静默检查新版本，发现更新后引导手动下载安装"
          class="flex items-center justify-between not-last:pb-4 gap-2"
        >
          <div v-if="updateResult?.hasUpdate" class="flex items-center gap-2">
            <span class="text-sm text-dimmed">最新 {{ updateResult.latest }}</span>
            <UButton label="去下载" color="primary" @click="goDownload" />
          </div>
          <UButton
            label="检查更新"
            color="neutral"
            variant="outline"
            :loading="updateBusy"
            @click="onCheckUpdate(true)"
          />
        </UFormField>
      </UPageCard>
    </div>
  </div>

  <!-- 授权 -->
  <div
    v-else-if="props.tab === 'settings-license'"
    class="flex flex-col gap-4 sm:gap-6 lg:gap-12 w-full lg:max-w-2xl mx-auto"
  >
    <div>
      <UPageCard
        title="授权"
        :description="activation?.profileId ? `发布档：${activation.profileId}` : '当前设备的授权状态'"
        variant="naked"
        orientation="horizontal"
        class="mb-4"
      />

      <UPageCard variant="subtle" :ui="{ container: 'divide-y divide-default' }">
        <UFormField label="单位" class="flex items-center justify-between not-last:pb-4 gap-2">
          <span class="text-sm">
            {{ unitName || '—' }}
            <span v-if="activation?.role" class="text-muted">· {{ roleLabel(activation.role) }}</span>
          </span>
        </UFormField>

        <UFormField
          label="授权有效期至"
          description="授权到期后仅可查看历史数据，无法进行操作"
          class="flex items-center justify-between not-last:pb-4 gap-2"
        >
          <span class="text-sm">{{ formatExpiry(expiresAt) }}</span>
        </UFormField>

        <UFormField
          v-if="rolledBack"
          label="系统时间异常"
          class="flex items-center justify-between not-last:pb-4 gap-2"
        >
          <span class="text-sm text-error">检测到时间被回拨，请校正系统时间后重试</span>
        </UFormField>

        <template v-if="caps?.mode === 'offline'">
          <UFormField
            v-if="activation?.licenseId"
            label="授权 id"
            class="flex items-center justify-between not-last:pb-4 gap-2"
          >
            <span class="text-sm font-mono">{{ activation.licenseId }}</span>
          </UFormField>
          <UFormField
            v-if="activation?.keyId"
            label="申请密钥"
            description="学生端加密申请文件所用公钥的编号"
            class="flex items-center justify-between not-last:pb-4 gap-2"
          >
            <span class="text-sm font-mono">{{ activation.keyId }}</span>
          </UFormField>
          <UFormField
            v-if="activation?.fingerprint"
            label="本机机器码"
            description="换机 / 签发授权时提供给服务商"
            class="flex items-center justify-between not-last:pb-4 gap-2"
          >
            <div class="flex items-center gap-2 shrink-0">
              <span class="text-sm font-mono">{{ activation.fingerprint }}</span>
              <UButton
                icon="i-lucide-copy"
                color="neutral"
                variant="ghost"
                size="xs"
                @click="copyFingerprint"
              />
            </div>
          </UFormField>
          <UFormField
            v-if="activation?.configVersion"
            label="配置版本"
            class="flex items-center justify-between not-last:pb-4 gap-2"
          >
            <span class="text-sm">{{ activation.configVersion }}</span>
          </UFormField>
        </template>

        <UFormField
          v-if="caps?.serverUrlConfigurable && activation?.serverUrl"
          label="服务端地址"
          class="flex items-center justify-between not-last:pb-4 gap-2"
        >
          <span class="text-sm font-mono">{{ activation.serverUrl }}</span>
        </UFormField>

        <UFormField
          v-if="caps?.transport === 'file' && activation?.role === 'level1'"
          label="公钥包"
          :description="
            activation?.pubkeyExported
              ? '已导出；如需重新领取证书可再次导出'
              : '未导出：小程序拿不到申请公钥，请导出后发给服务商'
          "
          class="flex items-center justify-between not-last:pb-4 gap-2"
        >
          <UButton
            label="导出公钥包"
            color="neutral"
            variant="outline"
            :loading="pubkeyBusy"
            @click="onPublishPubkey"
          />
        </UFormField>

        <UFormField
          v-if="caps?.mode === 'offline'"
          label="更新授权"
          description="收到续期授权文件后导入，仅更新有效期与配置"
          class="flex items-center justify-between not-last:pb-4 gap-2"
        >
          <UButton label="更新授权" color="neutral" variant="outline" @click="renewOpen = true" />
        </UFormField>

        <UFormField
          label="更换授权设备"
          :description="
            caps?.transport === 'file'
              ? '导出换机申请文件发给服务商，收到新授权文件后在新设备激活'
              : '将本机授权迁移到另一台设备（原授权码作废，签发新码）'
          "
          class="flex items-center justify-between not-last:pb-4 gap-2"
        >
          <UButton
            label="申请更换设备"
            color="neutral"
            variant="outline"
            :loading="rebinding"
            @click="caps?.transport === 'file' ? (rebindOfflineOpen = true) : (rebindOpen = true)"
          />
        </UFormField>

        <UFormField
          label="注销本机账号"
          description="删除本机该单位的全部数据，回到未激活状态"
          class="flex items-center justify-between not-last:pb-4 gap-2"
        >
          <UButton
            label="注销本机账号"
            color="error"
            variant="outline"
            @click="deactivateOpen = true"
          />
        </UFormField>
      </UPageCard>
    </div>
  </div>

  <!-- 账号：已登录的单位 -->
  <div
    v-else-if="props.tab === 'settings-accounts'"
    class="flex flex-col gap-4 sm:gap-6 lg:gap-12 w-full lg:max-w-2xl mx-auto"
  >
    <div>
      <UPageCard
        title="账号"
        description="本机已添加的单位，不同单位的数据相互独立"
        variant="naked"
        orientation="horizontal"
        class="mb-4"
      />

      <UPageCard variant="subtle" :ui="{ container: 'divide-y divide-default' }">
        <div
          v-for="(acc, i) in accounts"
          :key="acc.unitId"
          class="flex items-center justify-between gap-4 not-last:pb-4"
          :class="[i > 0 && 'pt-4']"
        >
          <div class="flex flex-col gap-0.5 min-w-0">
            <span class="text-sm font-medium truncate">{{ fullUnitName(acc) }}</span>
            <span class="text-xs text-muted">
              {{ acc.unitType || '单位' }} · {{ roleLabel(acc.role) }} · 授权至
              {{ formatExpiry(acc.expiresAt) }}
            </span>
          </div>
          <UBadge v-if="i === 0" label="当前" color="primary" variant="subtle" size="sm" />
        </div>
        <p v-if="!accounts.length" class="text-sm text-muted py-4">暂无账号</p>
      </UPageCard>
    </div>
  </div>

  <!-- 更换授权设备二次确认（受控 open，取消后仍可再次打开） -->
  <UModal
    v-model:open="rebindOpen"
    title="更换授权设备"
    description="申请后服务端将作废当前授权码并签发新授权码，本机将立即退出到验证页，需在新设备上用新授权码重新激活。确定继续吗？"
    :ui="{ footer: 'justify-end' }"
  >
    <template #footer>
      <UButton label="取消" color="neutral" variant="outline" @click="rebindOpen = false" />
      <UButton label="申请更换" color="error" @click="onRebind" />
    </template>
  </UModal>

  <!-- 恢复默认数据目录：二次确认 -->
  <UModal
    v-model:open="resetOpen"
    title="恢复默认数据目录"
    description="将把数据迁移回默认位置，并自动重启应用使其生效。确定继续吗？"
    :ui="{ footer: 'justify-end' }"
  >
    <template #footer>
      <UButton label="取消" color="neutral" variant="outline" @click="resetOpen = false" />
      <UButton label="恢复并重启" :loading="migrating" @click="onReset" />
    </template>
  </UModal>

  <!-- 离线换机：导出 .dysr（不注销本机） -->
  <UModal
    v-model:open="rebindOfflineOpen"
    title="申请更换设备"
    description="填写新设备的机器码，导出换机申请文件发给服务商换取新授权文件。本机不会注销。"
    :ui="{ footer: 'justify-end' }"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <UFormField label="新设备机器码" description="在新设备的激活页读取">
          <UInput v-model="newFingerprint" placeholder="XXXX-XXXX-XXXX" class="w-full" />
        </UFormField>
        <UFormField label="原因（可选）">
          <UInput v-model="rebindReason" placeholder="如：原电脑损坏" class="w-full" />
        </UFormField>
      </div>
    </template>
    <template #footer>
      <UButton label="取消" color="neutral" variant="outline" @click="rebindOfflineOpen = false" />
      <UButton label="导出申请文件" :loading="rebinding" @click="onExportRebind" />
    </template>
  </UModal>

  <!-- 注销本机账号：二次确认 -->
  <UModal
    v-model:open="deactivateOpen"
    title="注销本机账号"
    description="将删除本机该单位的全部数据（分数、材料、审计），回到未激活状态。此操作不可撤销。确定继续吗？"
    :ui="{ footer: 'justify-end' }"
  >
    <template #footer>
      <UButton label="取消" color="neutral" variant="outline" @click="deactivateOpen = false" />
      <UButton label="注销" color="error" @click="onDeactivate" />
    </template>
  </UModal>

  <!-- 更新授权（续期）：导入新授权文件 -->
  <UModal
    v-model:open="renewOpen"
    title="更新授权"
    description="选择服务商续期后的授权文件（.dysl），输入口令后更新有效期与配置。"
    :ui="{ footer: 'justify-end' }"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <UButton
          label="选择授权文件"
          color="neutral"
          variant="outline"
          icon="i-lucide-file"
          @click="onPickRenew"
        />
        <div v-if="renewPreview" class="text-sm text-muted">
          {{ renewPreview.unitName }} · 有效期至 {{ formatExpiry(renewPreview.expiresAt) }}
        </div>
        <UFormField v-if="renewPreview" label="口令">
          <UInput
            v-model="renewPassword"
            type="password"
            placeholder="服务商提供的口令"
            class="w-full"
          />
        </UFormField>
        <UAlert v-if="renewError" color="error" :title="renewError" variant="soft" />
      </div>
    </template>
    <template #footer>
      <UButton label="取消" color="neutral" variant="outline" @click="renewOpen = false" />
      <GuardedButton
        label="确认更新"
        :loading="renewBusy"
        :disabled="!renewPreview"
        disabled-reason="请先选择并确认新的授权文件"
        @click="onRenew"
      />
    </template>
  </UModal>
</template>
