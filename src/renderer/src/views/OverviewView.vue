<script setup lang="ts">
/**
 * 德育分总览页（决策 #16/#19）：批次维度数据看板，仅统计展示，不含导入能力。
 * 批次选择在标题栏功能区（AppLayout 共享）；导入/导出也在功能区。
 * 展示：批次信息、学生/班级规模、申请覆盖率、平均/最高/最低分、冲突和数据更新时间。
 */
import { computed, onMounted, ref, watch } from 'vue'
import type { BatchOverview } from '../../../preload/types'
import { useToast } from '@nuxt/ui/composables'
import { ipcErrorMessage } from '../utils/ipc'
import { batchStatusColor, batchStatusLabel } from '../utils/batch-status'
import { currentBatch, dyfState, isDyfExported } from '../stores/dyf-state'

const props = withDefaults(defineProps<{ readonly?: boolean }>(), { readonly: false })
void props

const toast = useToast()

const overview = ref<BatchOverview | null>(null)
const loading = ref(false)
let requestSerial = 0

const selectedBatch = currentBatch

/** 是否已完成班级端审核（整班导出，决策 #17，响应式）。 */
const exported = isDyfExported

/** 排名新鲜度展示（提取为 computed，避免复杂表达式进模板）。 */
const rankStale = computed(() => overview.value?.rankingStale ?? false)
const rankColor = computed<'warning' | 'success'>(() => (rankStale.value ? 'warning' : 'success'))
const rankIcon = computed(() =>
  rankStale.value ? 'i-lucide-triangle-alert' : 'i-lucide-list-ordered'
)
const rankLabel = computed(() =>
  rankStale.value
    ? '排名待更新：分数有变动，请到「总体情况」页点「计算排名」'
    : `排名已更新（${formatTime(overview.value?.rankedAt)}）`
)

async function loadOverview(): Promise<void> {
  if (!dyfState.batchId) {
    overview.value = null
    return
  }
  loading.value = true
  const serial = ++requestSerial
  try {
    const o = await window.api.overview.get(dyfState.batchId)
    if (serial !== requestSerial) return
    overview.value = o
  } catch (err) {
    if (serial !== requestSerial) return
    toast.add({ title: '加载总览失败', description: ipcErrorMessage(err), color: 'error' })
  } finally {
    if (serial === requestSerial) loading.value = false
  }
}

function formatTime(ts?: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function formatScore(v?: number): string {
  return v === undefined || v === null ? '—' : String(v)
}

watch(
  () => dyfState.refreshTick,
  () => {
    void loadOverview()
  }
)

onMounted(async () => {
  await loadOverview()
})
</script>

<template>
  <div class="page">
    <!-- 批次信息（批次选择在标题栏功能区） -->
    <div v-if="selectedBatch" class="batch-line">
      <span class="font-medium"
        >{{ selectedBatch.year }} 学年第 {{ selectedBatch.semester }} 学期</span
      >
      <UBadge
        :color="batchStatusColor[selectedBatch.status]"
        :label="batchStatusLabel(selectedBatch.status)"
      />
      <UBadge v-if="selectedBatch.isTest" color="warning" variant="subtle" label="测试" />
      <UBadge
        v-if="exported"
        color="success"
        variant="subtle"
        icon="i-lucide-package-check"
        :label="`已导出（班级端审核完成 ${formatTime(selectedBatch.classReviewedAt)}）`"
      />
    </div>

    <div v-if="overview && !exported" class="batch-line">
      <UBadge :color="rankColor" variant="subtle" :icon="rankIcon" :label="rankLabel" />
    </div>

    <UAlert
      v-if="exported"
      color="success"
      variant="subtle"
      icon="i-lucide-lock"
      title="本班已完成班级端审核并整班导出"
      description="导出后本端不可再导入、修改或处理冲突；如需调整请联系一级管理员撤销导出。"
      class="mb-1"
    />

    <!-- 统计卡片 -->
    <div v-if="overview" class="stats">
      <UCard :ui="{ body: 'flex flex-col gap-1' }">
        <span class="stat-label">学生总数</span>
        <span class="stat-value">{{ overview.studentCount }}</span>
        <span class="stat-sub"
          >申请覆盖
          {{
            overview.studentCount
              ? ((overview.applyCount / overview.studentCount) * 100).toFixed(1)
              : 0
          }}%</span
        >
      </UCard>

      <UCard :ui="{ body: 'flex flex-col gap-1' }">
        <span class="stat-label">班级数</span>
        <span class="stat-value">{{ overview.classCount }}</span>
        <span class="stat-sub">当前授权范围内</span>
      </UCard>

      <UCard :ui="{ body: 'flex flex-col gap-1' }">
        <span class="stat-label">平均分</span>
        <span class="stat-value">{{
          overview.rankedCount ? (overview.rankedSum / overview.rankedCount).toFixed(2) : '—'
        }}</span>
        <span class="stat-sub">参与排名 {{ overview.rankedCount }} 人</span>
      </UCard>

      <UCard :ui="{ body: 'flex flex-col gap-1' }">
        <span class="stat-label">最高分</span>
        <span class="stat-value">{{ formatScore(overview.maxScore) }}</span>
        <span class="stat-sub">参与排名 {{ overview.rankedCount }} 人</span>
      </UCard>

      <UCard :ui="{ body: 'flex flex-col gap-1' }">
        <span class="stat-label">最低分</span>
        <span class="stat-value">{{ formatScore(overview.minScore) }}</span>
        <span class="stat-sub">详见总体情况表格</span>
      </UCard>

      <UCard :ui="{ body: 'flex flex-col gap-1' }">
        <span class="stat-label">待处理冲突</span>
        <span class="stat-value" :class="overview.conflictCount > 0 ? 'text-warning' : ''">
          {{ overview.conflictCount }}
        </span>
        <span class="stat-sub">{{
          overview.conflictCount > 0 ? '请到「总体情况」页处理' : '无'
        }}</span>
      </UCard>
    </div>
    <UCard
      v-if="overview"
      title="数据时间"
      :ui="{ header: 'py-3', body: 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3' }"
    >
      <div class="timeline-item">
        <span class="stat-label">最近导入申请</span>
        <span>{{ formatTime(overview.latestImportAt) }}</span>
      </div>
      <div class="timeline-item">
        <span class="stat-label">最近数据变更</span>
        <span>{{ formatTime(overview.scoresChangedAt) }}</span>
      </div>
      <div class="timeline-item">
        <span class="stat-label">最近计算排名</span>
        <span>{{ formatTime(overview.rankedAt) }}</span>
      </div>
      <div class="timeline-item">
        <span class="stat-label">最近导出表格</span>
        <span>{{ formatTime(overview.tableExportedAt) }}</span>
      </div>
    </UCard>
    <div v-else class="text-sm text-dimmed py-6">
      暂无批次数据，请先在「批次管理」创建并激活批次
    </div>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.batch-line {
  display: flex;
  align-items: center;
  gap: 10px;
}
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}
.stat-label {
  font-size: 12px;
  color: var(--ui-text-dimmed);
}
.stat-value {
  font-size: 28px;
  font-weight: 700;
  line-height: 1.2;
}
.stat-sub {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.timeline-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
</style>
