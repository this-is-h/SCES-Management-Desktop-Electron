<script setup lang="ts">
/**
 * 设置 → 文件解析：解析德育分文件（.dyf）并完整展示，仅查看不可修改。
 * 子页（决策：先做学生端，管理端占位）：
 *  - 学生端导出：上传学生小程序导出的 .dyf 申请文件 → 主进程用本机申请密钥链解密 →
 *    渲染基础信息/时间信息/德育分明细（含证明材料）与解密后的原始数据；
 *  - 管理端导出：占位（后续解析管理端间交换文件）。
 * 注意：本页只允许「选择文件」上传，不支持拖入——拖入在全局是导入德育分文件。
 */
import { computed, ref } from 'vue'
import { useToast } from '@nuxt/ui/composables'
import ImageViewer from '../components/ImageViewer.vue'
import { ipcErrorMessage } from '../utils/ipc'
import type { DyfParseStudentResult, DyfParseScoreItem } from '../../../preload/types'

const toast = useToast()

const activeTab = ref<'student' | 'admin'>('student')

// 学生端解析（当前实现）
const parsing = ref(false)
const result = ref<DyfParseStudentResult | null>(null)

const viewerOpen = ref(false)
const viewerTitle = ref('')
const viewerImages = ref<{ src: string; label?: string }[]>([])

/** 选择并解析学生端导出的 .dyf（单选；解析失败展示原因，如密钥不匹配）。 */
async function onPickStudentFile(): Promise<void> {
  if (parsing.value) return
  const path = await window.api.parse.pickFile()
  if (!path) return
  parsing.value = true
  try {
    const res = await window.api.parse.studentFile(path)
    if (!res.ok) {
      result.value = null
      toast.add({
        title: '无法解析',
        description: res.error ?? '解析失败',
        color: 'error'
      })
      return
    }
    result.value = res
    toast.add({
      title: '解析成功',
      description: `${res.summary.personal.find((p) => p.key === 'name')?.value ?? ''}（${res.summary.personal.find((p) => p.key === 'studentId')?.value ?? ''}）· ${res.scores.length} 项明细`,
      color: 'success'
    })
  } catch (err) {
    toast.add({ title: '解析失败', description: ipcErrorMessage(err), color: 'error' })
  } finally {
    parsing.value = false
  }
}

/** 按类别分组（保持模板顺序；未知项目归「未知」）。 */
interface ScoreGroup {
  category: string
  items: DyfParseScoreItem[]
}
const scoreGroups = computed<ScoreGroup[]>(() => {
  const r = result.value
  if (!r || !r.ok) return []
  const order: string[] = []
  const map: Record<string, DyfParseScoreItem[]> = {}
  for (const it of r.scores) {
    if (!map[it.categoryName]) {
      map[it.categoryName] = []
      order.push(it.categoryName)
    }
    map[it.categoryName].push(it)
  }
  return order.map((category) => ({ category, items: map[category] }))
})

function formatTime(ts?: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN')
}

function formatBytes(size?: number): string {
  if (size === undefined) return '—'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(2)} MB`
}

function actionLabel(action: string): string {
  if (action === 'student.entered') return '进入批次'
  if (action === 'student.exported') return '导出申请'
  return action
}

function openEvidence(item: DyfParseScoreItem): void {
  if (!item.evidence.length) return
  viewerTitle.value = `${item.itemCode} ${item.description}`
  viewerImages.value = item.evidence.map((src, i) => ({
    src,
    label:
      src.startsWith('data:application/octet-stream;base64,') && src.length < 200
        ? '证明材料过大，未内嵌展示'
        : `材料 ${i + 1}`
  }))
  viewerOpen.value = true
}

function openConfirmSlip(): void {
  const r = result.value
  if (!r || !r.ok || !r.confirmSlip) return
  viewerTitle.value = '确认单'
  viewerImages.value = [{ src: r.confirmSlip, label: '确认单' }]
  viewerOpen.value = true
}

/** 原始数据 JSON 文本（解密后 payload）。 */
const rawText = computed(() => {
  const r = result.value
  if (!r || !r.ok) return ''
  return JSON.stringify(r.raw, null, 2)
})
</script>

<template>
  <div class="flex flex-col gap-4 w-full lg:max-w-2xl mx-auto">
    <div>
      <UPageCard
        title="德育分文件解析"
        description="上传德育分文件并解析（使用当前密钥；请通过选择文件上传，拖入文件为导入操作）"
        variant="naked"
        orientation="horizontal"
        class="mb-4"
      />

      <UPageCard variant="subtle" :ui="{ container: 'divide-y divide-default' }">
        <UTabs
          v-model="activeTab"
          :items="[
            { label: '学生端导出文件', value: 'student', icon: 'i-lucide-user' },
            { label: '管理端导出文件', value: 'admin', icon: 'i-lucide-building-2' }
          ]"
        />
      </UPageCard>
    </div>

    <!-- 学生端导出文件解析 -->
    <div v-if="activeTab === 'student'" class="flex flex-col gap-4">
      <UPageCard variant="subtle">
        <div class="flex items-center justify-between gap-4">
          <div class="flex flex-col gap-0.5">
            <span class="text-sm font-medium">解析学生端导出的申请文件</span>
            <span class="text-xs text-muted">
              上传学生小程序导出的 .dyf 文件，使用本机当前密钥解密并完整展示
            </span>
          </div>
          <UButton
            label="选择文件"
            icon="i-lucide-file-up"
            :loading="parsing"
            @click="onPickStudentFile"
          />
        </div>
      </UPageCard>

      <template v-if="result && result.ok">
        <!-- 基础信息 -->
        <div>
          <UPageCard title="基础信息" variant="naked" orientation="horizontal" class="mb-2" />
          <UPageCard variant="subtle">
            <div class="info-grid">
              <span v-for="p in result.summary.personal" :key="p.key" class="info-item">
                <b>{{ p.label }}</b
                >{{ p.value }}
              </span>
            </div>
          </UPageCard>
        </div>

        <!-- 时间信息 -->
        <div>
          <UPageCard title="时间信息" variant="naked" orientation="horizontal" class="mb-2" />
          <UPageCard variant="subtle" :ui="{ container: 'divide-y divide-default' }">
            <div class="info-grid !pb-4">
              <span class="info-item"><b>申请 ID</b>{{ result.summary.applyId || '—' }}</span>
              <span class="info-item"><b>版本</b>第 {{ result.summary.revision }} 版</span>
              <span class="info-item"><b>批次</b>{{ result.summary.batchId || '—' }}</span>
              <span class="info-item"
                ><b>导出时间</b>{{ formatTime(result.summary.exportedAt) }}</span
              >
              <span class="info-item"
                ><b>首次进入</b>{{ formatTime(result.summary.enteredAt) }}</span
              >
              <span class="info-item"><b>密钥 ID</b>{{ result.header.keyId || '—' }}</span>
            </div>
            <div v-if="result.summary.exports.length" class="pt-4">
              <div class="text-xs text-muted mb-2">导出历史</div>
              <div
                v-for="(e, i) in result.summary.exports"
                :key="`${e.revision}-${i}`"
                class="flex items-center gap-2 text-sm not-last:mb-1"
              >
                <UBadge size="xs" color="neutral" variant="subtle" :label="`第 ${e.revision} 版`" />
                <span class="text-muted">{{ formatTime(e.exportedAt) }}</span>
                <span
                  v-if="e.fileHash"
                  class="text-xs font-mono text-dimmed truncate"
                  :title="e.fileHash"
                  >{{ e.fileHash.slice(0, 12) }}…</span
                >
              </div>
            </div>
          </UPageCard>
        </div>

        <!-- 分数信息（仅展示，不能加减分，不显示未申请项目） -->
        <div>
          <UPageCard
            title="分数信息"
            :description="`合计 ${result.summary.totalScore} 分（文件内申请分，仅展示）`"
            variant="naked"
            orientation="horizontal"
            class="mb-2"
          />
          <UPageCard variant="subtle">
            <template v-if="scoreGroups.length">
              <div v-for="g in scoreGroups" :key="g.category" class="score-group">
                <div class="group-title">{{ g.category }}</div>
                <div v-for="it in g.items" :key="it.itemCode" class="score-item">
                  <div class="score-item-head">
                    <span class="item-code">{{ it.itemCode }}</span>
                    <span class="item-desc">{{ it.description || '—' }}</span>
                    <UBadge
                      v-if="it.negative"
                      size="xs"
                      color="error"
                      variant="subtle"
                      label="负向"
                      class="shrink-0"
                    />
                    <UBadge
                      v-if="it.allowAdd"
                      size="xs"
                      color="info"
                      variant="subtle"
                      label="可加分"
                      class="shrink-0"
                    />
                    <UBadge
                      v-if="!it.templateItem"
                      size="xs"
                      color="warning"
                      variant="subtle"
                      label="模板未定义"
                      class="shrink-0"
                    />
                    <UButton
                      v-if="it.evidence.length"
                      size="xs"
                      variant="ghost"
                      icon="i-lucide-image"
                      :label="`证明 ${it.evidence.length}`"
                      class="shrink-0"
                      @click="openEvidence(it)"
                    />
                  </div>
                  <div class="score-item-body">
                    <span class="applied">申请 {{ it.appliedScore }} 分</span>
                    <span v-if="it.maxScore !== undefined" class="applied text-dimmed"
                      >上限 {{ it.maxScore }} 分</span
                    >
                  </div>
                </div>
              </div>
            </template>
            <div v-else class="empty-tip">文件中没有德育分明细</div>
          </UPageCard>
        </div>

        <!-- 确认单 -->
        <div v-if="result.confirmSlip">
          <UPageCard title="确认单" variant="naked" orientation="horizontal" class="mb-2" />
          <UPageCard variant="subtle">
            <UButton
              label="查看确认单"
              icon="i-lucide-image"
              color="neutral"
              variant="outline"
              @click="openConfirmSlip"
            />
          </UPageCard>
        </div>

        <!-- 时间线 -->
        <div v-if="result.timeline.length">
          <UPageCard title="时间线" variant="naked" orientation="horizontal" class="mb-2" />
          <UPageCard variant="subtle" :ui="{ container: 'divide-y divide-default' }">
            <div
              v-for="ev in result.timeline"
              :key="ev.eventId"
              class="flex items-center gap-2 py-2 text-sm"
            >
              <UBadge size="xs" color="neutral" variant="subtle" :label="actionLabel(ev.action)" />
              <span class="text-muted">{{ formatTime(ev.occurredAt) }}</span>
              <span v-if="ev.revision !== undefined" class="text-xs text-dimmed"
                >第 {{ ev.revision }} 版</span
              >
              <span
                v-if="ev.sourceFileHash"
                class="text-xs font-mono text-dimmed truncate"
                :title="ev.sourceFileHash"
                >{{ ev.sourceFileHash.slice(0, 12) }}…</span
              >
            </div>
          </UPageCard>
        </div>

        <!-- 原始数据（解密后） -->
        <div>
          <UPageCard
            title="原始数据"
            :description="`解密后的文件内容（SHA-256：${result.payloadHash.slice(0, 16)}…）`"
            variant="naked"
            orientation="horizontal"
            class="mb-2"
          />
          <UPageCard variant="subtle">
            <details class="raw-details">
              <summary class="text-sm font-medium cursor-pointer">
                展开解密后的完整 JSON（{{ formatBytes(rawText.length) }}）
              </summary>
              <pre class="raw-json">{{ rawText }}</pre>
            </details>
          </UPageCard>
        </div>
      </template>
    </div>

    <!-- 管理端导出文件解析（占位） -->
    <div v-else class="flex flex-col gap-4">
      <UPageCard variant="subtle">
        <UAlert
          color="info"
          variant="soft"
          icon="i-lucide-hourglass"
          title="解析功能开发中"
          description="管理端数据交换文件已随离线分级授权下线；本页当前解析学生端导出的 .dyf 申请文件。更多解析能力开发中，敬请期待。"
        />
      </UPageCard>
    </div>

    <!-- 证明材料 / 确认单查看 -->
    <ImageViewer v-model:open="viewerOpen" :title="viewerTitle" :images="viewerImages" allow-save />
  </div>
</template>

<style scoped>
.info-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, auto));
  gap: 8px 24px;
}
.info-item {
  font-size: 13px;
  color: var(--ui-text-dimmed);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.info-item b {
  color: var(--ui-text);
  font-weight: 500;
  margin-right: 6px;
}
.score-group {
  margin-bottom: 12px;
}
.group-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-muted);
  margin: 12px 0 6px;
}
.score-item {
  padding: 8px 10px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  margin-bottom: 6px;
  background: var(--ui-bg);
}
.score-item-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.item-code {
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-primary);
  white-space: nowrap;
}
.item-desc {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--ui-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.score-item-body {
  display: flex;
  align-items: center;
  gap: 12px;
}
.applied {
  font-size: 12px;
  color: var(--ui-text-dimmed);
}
.empty-tip {
  padding: 28px 0;
  text-align: center;
  font-size: 13px;
  color: var(--ui-text-dimmed);
}
.raw-details {
  font-size: 13px;
}
.raw-json {
  margin-top: 10px;
  max-height: 50vh;
  overflow: auto;
  padding: 12px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: var(--ui-bg-elevated);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
