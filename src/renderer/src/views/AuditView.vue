<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { AuditLog } from '@sces/shared'
import { useToast } from '@nuxt/ui/composables'
import { ipcErrorMessage } from '../utils/ipc'

const toast = useToast()

const logs = ref<AuditLog[]>([])
const loading = ref(false)

const columns = [
  { accessorKey: 'createdAt', header: '时间' },
  { id: 'operator', header: '操作人' },
  { id: 'operation', header: '操作' }
]

async function load(): Promise<void> {
  loading.value = true
  try {
    logs.value = await window.api.audit.list({ limit: 200 })
  } catch (err) {
    toast.add({ title: '加载失败', description: ipcErrorMessage(err), color: 'error' })
  } finally {
    loading.value = false
  }
}

onMounted(load)

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

/** detail 是后端写入的 JSON（变更前后/上下文），从中提取可读信息。 */
function asDetail(log: AuditLog): Record<string, unknown> {
  return (log.detail ?? {}) as Record<string, unknown>
}

/** 批次显示名：取 detail 里的学年学期（+ 测试标记），不回显 UUID。 */
function batchName(log: AuditLog): string {
  const d = asDetail(log)
  if (typeof d.year === 'number' && typeof d.semester === 'number') {
    const base = `${d.year} 学年第 ${d.semester} 学期批次`
    return d.isTest ? `${base}（测试）` : base
  }
  return '一个批次'
}

/**
 * 操作者 → 面向用户的操作人。'system' 为系统自动（如批次到时间自动关闭），
 * 'local-admin' 为本机管理员手动操作。
 */
function operatorText(log: AuditLog): string {
  if (log.operator === 'system') return '系统'
  if (log.operator === 'local-admin') return '管理员'
  return log.operator || '—'
}

/**
 * 把系统内部 action + detail 翻译成面向用户的操作描述。
 * 说明“做了什么 + 作用于谁”，避免直接暴露 action 码、UUID 或配置术语。
 */
function operationText(log: AuditLog): string {
  const d = asDetail(log)
  void d
  switch (log.action) {
    case 'unit.activate': {
      const name = typeof d.name === 'string' ? d.name : '当前单位'
      return `激活单位「${name}」`
    }
    case 'unit.init':
      return '初始化系统'
    case 'batch.create':
      return `创建${batchName(log)}`
    case 'batch.update':
      return `编辑${batchName(log)}`
    case 'batch.activate':
      return `激活${batchName(log)}，开放申请`
    case 'batch.close':
      return `关闭${batchName(log)}，停止接收申请`
    case 'template.create':
      return '创建配置模板'
    case 'template.update':
      return '编辑配置模板'
    case 'template.publish':
      return '发布配置模板'
    case 'template.archive':
      return '归档配置模板'
    case 'import.accept': {
      const name = typeof d.name === 'string' ? d.name : '学生'
      const studentId = typeof d.studentId === 'string' ? d.studentId : ''
      return `导入${name}（${studentId}）的申请`
    }
    case 'import.reject': {
      const studentId = typeof d.studentId === 'string' ? d.studentId : ''
      const reason = typeof d.reason === 'string' ? d.reason : ''
      return `拒绝导入学号 ${studentId} 的申请（${reason}）`
    }
    case 'import.conflict.staged': {
      const studentId = typeof d.studentId === 'string' ? d.studentId : ''
      const existing = typeof d.existingName === 'string' ? d.existingName : ''
      const incoming = typeof d.incomingName === 'string' ? d.incomingName : ''
      return `暂存学号 ${studentId} 的冲突（${existing} vs ${incoming}）`
    }
    case 'conflict.resolve.existing': {
      const studentId = typeof d.studentId === 'string' ? d.studentId : ''
      const locked = typeof d.lockedName === 'string' ? d.lockedName : ''
      return `学号冲突处理：${studentId} 以已有记录「${locked}」为准并锁定`
    }
    case 'conflict.resolve.incoming': {
      const studentId = typeof d.studentId === 'string' ? d.studentId : ''
      const before = typeof d.beforeName === 'string' ? d.beforeName : ''
      const after = typeof d.afterName === 'string' ? d.afterName : ''
      return `学号冲突处理：${studentId} 以新导入「${after}」为准（原「${before}」作废）`
    }
    case 'student.name.correct': {
      const studentId = typeof d.studentId === 'string' ? d.studentId : ''
      const before = typeof d.beforeName === 'string' ? d.beforeName : ''
      const after = typeof d.afterName === 'string' ? d.afterName : ''
      return `修正学号 ${studentId} 的姓名：${before} → ${after}`
    }
    case 'apply.review.start': {
      const studentId = typeof d.studentId === 'string' ? d.studentId : ''
      return `开始审核学号 ${studentId} 的申请`
    }
    case 'apply.score.update': {
      const studentId = typeof d.studentId === 'string' ? d.studentId : ''
      const itemCode = typeof d.itemCode === 'string' ? d.itemCode : ''
      const before = d.before
      const after = d.after
      const created = d.created === true
      return `调整学号 ${studentId} 的 ${itemCode} 分数：${String(before ?? '')} → ${String(after ?? '')}${created ? '（管理端补录）' : ''}`
    }
    case 'apply.confirm': {
      const studentId = typeof d.studentId === 'string' ? d.studentId : ''
      return `确认学号 ${studentId} 的德育分并计算排名`
    }
    case 'apply.confirm.revoke': {
      const studentId = typeof d.studentId === 'string' ? d.studentId : ''
      return `撤销学号 ${studentId} 的德育分确认`
    }
    default:
      // 未知 action 不回显内部码，给通用文案（日志已按 batchId 归集）
      return '执行了一项操作'
  }
}
</script>

<template>
  <div class="page">
    <UTable
      :data="logs"
      :loading="loading"
      :columns="columns"
      :ui="{
        th: 'px-3 py-2 text-xs font-medium',
        td: 'px-3 py-1.5 text-sm'
      }"
    >
      <template #createdAt-cell="{ row }">
        <span class="nowrap">{{ formatTime(row.original.createdAt) }}</span>
      </template>
      <template #operator-cell="{ row }">
        <span class="nowrap">{{ operatorText(row.original) }}</span>
      </template>
      <template #operation-cell="{ row }">{{ operationText(row.original) }}</template>
    </UTable>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.nowrap {
  white-space: nowrap;
}
</style>
