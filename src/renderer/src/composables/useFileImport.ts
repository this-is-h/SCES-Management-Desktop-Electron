/**
 * 导入编排（选择框 / 拖放共用，德育分总体情况与审核页复用）：
 * 取本地路径（选择框或 webUtils 拖放 File）→ 调主进程导入 → toast 汇总 + 结果 → 回调刷新。
 */
import { ref } from 'vue'
import type { Ref } from 'vue'
import { useToast } from '@nuxt/ui/composables'
import { ipcErrorMessage } from '../utils/ipc'
import { useFileDrop } from './useFileDrop'
import type { ImportFileResult } from '../../../preload/types'

export function useFileImport(opts: {
  /** 取当前批次 id（拖放/选择时校验）。 */
  getBatchId: () => string
  /** 是否以覆盖方式导入（仅一级导入 .dxy 生效；渲染层据角色返回）。 */
  getOverwrite?: () => boolean
  /** 覆盖导入前的二次确认（仅一级 .dxy 拖放生效）。返回 false 则中止导入。 */
  confirmOverwrite?: () => Promise<boolean> | boolean
  /** 导入完成后回调（刷新列表/冲突/大表格）。 */
  onImported?: () => void | Promise<void>
}): {
  importing: Ref<boolean>
  results: Ref<ImportFileResult[]>
  dragging: Ref<boolean>
  pickAndImport: () => Promise<void>
  importFiles: (files: File[]) => Promise<void>
} {
  const toast = useToast()
  const importing = ref(false)
  const results = ref<ImportFileResult[]>([])
  const { dragging } = useFileDrop((files) => void importFiles(files))

  async function runPaths(paths: string[]): Promise<void> {
    const batchId = opts.getBatchId()
    if (!batchId) {
      toast.add({ title: '请先选择批次', color: 'warning' })
      return
    }
    importing.value = true
    try {
      results.value = await window.api.import.run(batchId, paths, {
        overwrite: opts.getOverwrite?.() ?? false
      })
      const ok = results.value.filter((r) => r.ok && r.decision === 'accept').length
      const reject = results.value.filter((r) => r.decision === 'reject').length
      const conflict = results.value.filter((r) => r.decision === 'conflict').length
      const err = results.value.filter((r) => r.decision === 'error').length
      toast.add({
        title: `导入完成：成功 ${ok}，拒绝 ${reject}，冲突 ${conflict}${err ? `，错误 ${err}` : ''}`,
        color: ok > 0 || conflict > 0 ? 'success' : 'warning'
      })
      await opts.onImported?.()
    } catch (err) {
      toast.add({ title: '导入失败', description: ipcErrorMessage(err), color: 'error' })
    } finally {
      importing.value = false
    }
  }

  async function pickAndImport(): Promise<void> {
    if (importing.value) return
    const paths = await window.api.import.pickFiles()
    if (!paths || paths.length === 0) return
    await runPaths(paths)
  }

  async function importFiles(files: File[]): Promise<void> {
    if (importing.value) return
    const paths = files
      .map((f) => window.api.import.getPathForFile(f))
      .filter((p): p is string => Boolean(p))
    if (!paths.length) {
      toast.add({ title: '未获取到文件路径', color: 'warning' })
      return
    }
    // 一级拖放导入 .dxy 会覆盖同学号旧数据：先弹二次确认（选择框路径已在 onImportClick 确认，此处仅兜底拖放）。
    if (opts.getOverwrite?.() && opts.confirmOverwrite) {
      const proceed = await opts.confirmOverwrite()
      if (!proceed) return
    }
    await runPaths(paths)
  }

  return { importing, results, dragging, pickAndImport, importFiles }
}