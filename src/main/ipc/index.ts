/**
 * IPC handler 注册：主进程服务 → 渲染进程白名单 API。
 * 所有 handler 用 ipcMain.handle（invoke/handle 模式），错误直接抛出由渲染进程捕获。
 * 写操作（batch:*）在服务层统一做授权校验（过期只读）。
 */
import { ipcMain, BrowserWindow, app, dialog } from 'electron'
import { is } from '@electron-toolkit/utils'
import { capabilities } from '../gateway'
import { writeFileSync } from 'fs'
import { listAudit } from '../services/audit'
import { getThemeMode, isDark, setThemeMode } from '../services/theme'
import { checkForUpdates } from '../services/updater'
import { getDataDirInfo, setDataDir } from '../services/data-dir'
import {
  activateBatch,
  closeBatch,
  createBatch,
  getBatch,
  listBatches,
  toPublicBatch,
  updateBatch
} from '../services/batch'
import {
  getUnit,
  activateUnit,
  isInitialized,
  getActivationInfo,
  getAccounts,
  getLicense,
  switchAccount,
  rebindDevice,
  logoutToVerify,
  hasAnyAccount,
  resumeLastAccount,
  deactivateCurrent
} from '../services/unit'
import { importApplyFiles } from '../services/import'
import { parseStudentDyfFile } from '../services/dyf-parse'
import { correctName, listConflicts, resolveConflict } from '../services/conflict'
import {
  confirmBatchExport,
  getApplyDetail,
  listApplies,
  setScore,
  fillBaseScores
} from '../services/apply'
import { computeRanking } from '../services/ranking'
import { getScoreTableXlsxFileName, writeScoreTableXlsx } from '../services/export-table'
import { getBatchOverview, getScoreTable } from '../services/overview'
import { readEvidenceAsDataUrl } from '../services/evidence'
import { listTimelineEvents } from '../services/timeline'

/** 让当前窗口整体重载（切库后渲染层需全新加载，避免脏状态）。 */
function reloadAll(): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.reload()
}

/** 注册全部 IPC handler（应用 ready 后调用一次）。 */
export function registerIpcHandlers(): void {
  // 应用信息
  ipcMain.handle('app:is-dev', () => is.dev)
  // 能力矩阵（渲染层视图分支唯一依据）
  ipcMain.handle('app:get-capabilities', () => capabilities)
  ipcMain.handle('app:get-version', () => app.getVersion())
  // 自动更新：轻量版本检查（manual=true 手动强制，false 遵循 24h 节流）。返回 null 静默（网络失败/无更新通道）。
  ipcMain.handle('update:check', (_e, manual: boolean) => checkForUpdates(manual === true))

  // 主题
  ipcMain.handle('theme:get-mode', () => getThemeMode())
  ipcMain.handle('theme:set-mode', (_e, mode: 'light' | 'dark' | 'system') => setThemeMode(mode))
  ipcMain.handle('theme:is-dark', () => isDark())

  // 单位 / 账号 / 授权
  ipcMain.handle('unit:is-initialized', () => isInitialized())
  ipcMain.handle('unit:get', () => getUnit())
  ipcMain.handle('unit:get-activation', () => getActivationInfo())
  ipcMain.handle('unit:get-license', () => getLicense())
  ipcMain.handle('unit:get-accounts', () => getAccounts())
  ipcMain.handle('unit:activate', (_e, input) => activateUnit(input))
  ipcMain.handle('unit:switch-account', (_e, accountId: string) => {
    switchAccount(accountId)
    reloadAll()
  })
  ipcMain.handle('unit:rebind-device', async (_e, reason?: string) => {
    await rebindDevice(reason)
    reloadAll()
  })
  ipcMain.handle('unit:logout', () => {
    logoutToVerify()
    reloadAll()
  })
  ipcMain.handle('unit:has-accounts', () => hasAnyAccount())
  ipcMain.handle('unit:resume', () => {
    resumeLastAccount()
    reloadAll()
  })
  ipcMain.handle('unit:deactivate', () => {
    deactivateCurrent()
    reloadAll()
  })

  // 批次（写操作内部已做授权校验）。
  // 密钥最小暴露：渲染层可见的批次一律剥离申请私钥（toPublicBatch），
  // 解密/签名只在主进程服务层发生。
  ipcMain.handle('batch:list', () => listBatches().map((b) => toPublicBatch(b)!))
  ipcMain.handle('batch:get', (_e, id: string) => toPublicBatch(getBatch(id)))
  ipcMain.handle('batch:create', async (_e, input) => {
    const res = await createBatch(input)
    res.batch = toPublicBatch(res.batch)!
    return res
  })
  ipcMain.handle('batch:update', async (_e, id: string, input) => {
    const b = await updateBatch(id, input)
    return toPublicBatch(b)
  })
  ipcMain.handle('batch:activate', async (_e, id: string) => toPublicBatch(await activateBatch(id)))
  ipcMain.handle('batch:close', async (_e, id: string) => toPublicBatch(await closeBatch(id)))

  // 审计日志
  ipcMain.handle('audit:list', (_e, options) => listAudit(options))

  // M3 导入（.dyf 学生申请文件）
  ipcMain.handle('import:pick-files', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const res = await dialog.showOpenDialog(win!, {
      title: '选择德育分文件（.dyf）',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '德育分文件', extensions: ['dyf'] }]
    })
    return res.canceled ? null : res.filePaths
  })
  ipcMain.handle('import:run', (_e, batchId: string, filePaths: string[]) =>
    importApplyFiles(batchId, filePaths)
  )
  ipcMain.handle('import:list-conflicts', (_e, batchId: string) => listConflicts(batchId))
  ipcMain.handle(
    'import:resolve-conflict',
    (_e, batchId: string, conflictId: number, choice: 'existing' | 'incoming') =>
      resolveConflict(batchId, conflictId, choice)
  )
  ipcMain.handle('import:correct-name', (_e, batchId: string, studentId: string, newName: string) =>
    correctName(batchId, studentId, newName)
  )

  // 设置 → 文件解析（.dyf，仅展示不改库）
  ipcMain.handle('parse:pick-file', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const res = await dialog.showOpenDialog(win!, {
      title: '选择德育分文件（.dyf）',
      properties: ['openFile'],
      filters: [{ name: '德育分文件', extensions: ['dyf'] }]
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  ipcMain.handle('parse:student-file', (_e, filePath: string) => parseStudentDyfFile(filePath))

  // M3 审核（扣分/加分/整班确认导出）与排名
  ipcMain.handle('apply:list', (_e, batchId: string, options) => listApplies(batchId, options))
  ipcMain.handle('apply:detail', (_e, batchId: string, applyId: string) =>
    getApplyDetail(batchId, applyId)
  )
  ipcMain.handle('apply:timeline', (_e, batchId: string, applyId: string) =>
    listTimelineEvents(batchId, applyId)
  )
  ipcMain.handle('apply:fill-base-scores', (_e, batchId: string) => fillBaseScores(batchId))
  ipcMain.handle(
    'apply:set-score',
    async (_e, batchId: string, applyId: string, itemCode: string, finalScore: number) =>
      setScore(batchId, applyId, itemCode, finalScore)
  )
  // 整班最终确认（确认即锁定；状态经 outbox 同步服务端。管理端间 .dxy 数据交换已下线）
  ipcMain.handle('apply:batch-export', async (_e, batchId: string) => {
    const r = await confirmBatchExport(batchId)
    return { confirmedCount: r.confirmedCount, syncPending: r.syncPending, path: null }
  })
  // 决策 #47：手动计算排名（重算 final_grade 与班排/专排，落 ranked_at）
  ipcMain.handle('apply:compute-ranking', (_e, batchId: string) => computeRanking(batchId))

  // 德育分总览
  ipcMain.handle('overview:get', (_e, batchId: string) => getBatchOverview(batchId))
  // 总体情况大表格（模板条目为列，全量滚动呈现；支持搜索与班级筛选，决策 #19）
  ipcMain.handle('overview:score-table', (_e, batchId: string, options) =>
    getScoreTable(batchId, options)
  )

  // 导出总体情况表格（.xlsx；主进程按批次+当前筛选生成，多行表头+合并单元格+大标题）
  ipcMain.handle(
    'export:score-table-xlsx',
    async (
      e,
      batchId: string,
      options: { search?: string; classes?: string[]; categories?: string[] }
    ) => {
      const exportOptions = options ?? {}
      const fileName = getScoreTableXlsxFileName(batchId, exportOptions)
      const win = BrowserWindow.fromWebContents(e.sender)
      const res = await dialog.showSaveDialog(win!, {
        title: '导出总体情况表格',
        defaultPath: fileName,
        filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
      })
      if (res.canceled || !res.filePath) return null
      await writeScoreTableXlsx(batchId, res.filePath, exportOptions)
      return res.filePath
    }
  )

  // 导出图片（确认单/证明材料另存为；data URL → 文件）
  ipcMain.handle('export:save-image', async (e, fileName: string, dataUrl: string) => {
    const comma = dataUrl.indexOf(',')
    const header = comma >= 0 ? dataUrl.slice(0, comma) : ''
    const mime = /^data:image\/([a-zA-Z0-9.+-]+);base64$/.exec(header)
    if (!mime) throw new Error('无效的图片数据')
    const ext = mime[1] === 'jpeg' ? 'jpg' : mime[1]
    const win = BrowserWindow.fromWebContents(e.sender)
    const res = await dialog.showSaveDialog(win!, {
      title: '保存图片',
      defaultPath: fileName,
      filters: [{ name: '图片', extensions: [ext, 'png', 'jpg'] }]
    })
    if (res.canceled || !res.filePath) return null
    writeFileSync(res.filePath, Buffer.from(dataUrl.slice(comma + 1), 'base64'))
    return res.filePath
  })

  // 证明材料（审核详情展示）
  ipcMain.handle('evidence:read', (_e, filePath: string) => readEvidenceAsDataUrl(filePath))

  // 数据存储目录
  ipcMain.handle('data:get-info', () => getDataDirInfo())
  ipcMain.handle('data:pick-dir', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const res = await dialog.showOpenDialog(win!, {
      title: '选择数据存储目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  ipcMain.handle('data:set-dir', async (_e, target: string | null) => {
    await setDataDir(target)
    // 迁移成功：重启应用使新路径全量生效（关闭的数据库由启动流程重新打开）
    app.relaunch()
    app.exit(0)
  })
}
