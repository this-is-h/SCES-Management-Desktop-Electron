/**
 * 德育分功能区共享状态（决策 #19）：批次选择、导入结果、表格筛选跨子页共享。
 * 批次选择 / 导入 / 导出（整班、表格）集中在「德育分」标题栏右侧功能区（AppLayout 持有），
 * 三个子页（总览 / 总体情况 / 审核）从本模块读取批次与刷新信号，不再各自持有工具栏。
 */
import { computed, reactive } from 'vue'
import type { Batch } from '@sces/shared'
import type { ImportFileResult } from '../../../preload/types'

/** 总体情况表格视图状态（导出表格按钮与表格页共用）。 */
export interface DyfTableFilter {
  /** 选中的项目类别（空数组 = 不显示任何项目列，仅基本信息 + 总分/排名）。 */
  categories: string[]
  /** 选中的班级（空数组 = 全部班级）。 */
  classes: string[]
  /** 搜索关键字（学号/姓名）。 */
  search: string
}

export const dyfState = reactive({
  /** 全部批次（功能区批次下拉）。 */
  batches: [] as Batch[],
  /** 当前选中批次（功能区批次下拉 v-model）。 */
  batchId: '',
  /** 本次导入结果（总体情况页展示）。 */
  results: [] as ImportFileResult[],
  /** 导入进行中（功能区按钮 loading）。 */
  importing: false,
  /** 批次切换 / 导入 / 导出后的刷新信号（各子页 watch 自增触发重载）。 */
  refreshTick: 0,
  /** 总体情况表格视图状态（导出表格共用）。 */
  table: {
    filter: { categories: [], classes: [], search: '' } as DyfTableFilter,
    /** 全部类别（列筛选用，来自模板，顺序 = 模板顺序）。 */
    allCategories: [] as string[],
    /** 全部班级（班级筛选用，来自总览）。 */
    allClasses: [] as string[]
  }
})

/** 触发子页刷新（批次切换 / 导入 / 整班导出后调用）。 */
export function bumpDyfRefresh(): void {
  dyfState.refreshTick += 1
}

/** 当前选中批次对象（响应式，单一路径：功能区与各子页统一经此取批次，避免多处重复 find 造成数据不一致）。 */
export const currentBatch = computed<Batch | null>(
  () => dyfState.batches.find((b) => b.batchId === dyfState.batchId) ?? null
)

/** 是否已完成班级端审核（整班导出，决策 #17，响应式）。 */
export const isDyfExported = computed(() => !!currentBatch.value?.classReviewedAt)
