import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DmsApi } from './types'

// Custom APIs for renderer（白名单，仅暴露主进程所需能力）
const api: DmsApi = {
  app: {
    isDev: () => ipcRenderer.invoke('app:is-dev'),
    getCapabilities: () => ipcRenderer.invoke('app:get-capabilities'),
    getVersion: () => ipcRenderer.invoke('app:get-version')
  },
  theme: {
    getMode: () => ipcRenderer.invoke('theme:get-mode'),
    setMode: (mode) => ipcRenderer.invoke('theme:set-mode', mode),
    isDark: () => ipcRenderer.invoke('theme:is-dark'),
    onChanged: (callback) => {
      const listener = (_e: Electron.IpcRendererEvent, isDark: boolean): void => callback(isDark)
      ipcRenderer.on('theme:changed', listener)
      return () => {
        ipcRenderer.removeListener('theme:changed', listener)
      }
    }
  },
  unit: {
    isInitialized: () => ipcRenderer.invoke('unit:is-initialized'),
    get: () => ipcRenderer.invoke('unit:get'),
    getActivationInfo: () => ipcRenderer.invoke('unit:get-activation'),
    getLicense: () => ipcRenderer.invoke('unit:get-license'),
    getAccounts: () => ipcRenderer.invoke('unit:get-accounts'),
    activate: (input) => ipcRenderer.invoke('unit:activate', input),
    switchAccount: (accountId) => ipcRenderer.invoke('unit:switch-account', accountId),
    rebindDevice: (reason) => ipcRenderer.invoke('unit:rebind-device', reason),
    deactivate: () => ipcRenderer.invoke('unit:deactivate'),
    logout: () => ipcRenderer.invoke('unit:logout'),
    hasAccounts: () => ipcRenderer.invoke('unit:has-accounts'),
    resume: () => ipcRenderer.invoke('unit:resume'),
  },
  batch: {
    list: () => ipcRenderer.invoke('batch:list'),
    get: (id) => ipcRenderer.invoke('batch:get', id),
    create: (input) => ipcRenderer.invoke('batch:create', input),
    update: (id, input) => ipcRenderer.invoke('batch:update', id, input),
    activate: (id) => ipcRenderer.invoke('batch:activate', id),
    close: (id) => ipcRenderer.invoke('batch:close', id)
  },
  audit: {
    list: (options) => ipcRenderer.invoke('audit:list', options)
  },
  import: {
    pickFiles: () => ipcRenderer.invoke('import:pick-files'),
    run: (batchId, filePaths, options) =>
      ipcRenderer.invoke('import:run', batchId, filePaths, options),
    getPathForFile: (file) =>
      webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0]),
    listConflicts: (batchId) => ipcRenderer.invoke('import:list-conflicts', batchId),
    resolveConflict: (batchId, conflictId, choice) =>
      ipcRenderer.invoke('import:resolve-conflict', batchId, conflictId, choice),
    correctName: (batchId, studentId, newName) =>
      ipcRenderer.invoke('import:correct-name', batchId, studentId, newName)
  },
  parse: {
    pickFile: () => ipcRenderer.invoke('parse:pick-file'),
    studentFile: (filePath) => ipcRenderer.invoke('parse:student-file', filePath)
  },
  apply: {
    list: (batchId, options) => ipcRenderer.invoke('apply:list', batchId, options),
    detail: (batchId, applyId) => ipcRenderer.invoke('apply:detail', batchId, applyId),
    timeline: (batchId, applyId) => ipcRenderer.invoke('apply:timeline', batchId, applyId),
    fillBaseScores: (batchId) => ipcRenderer.invoke('apply:fill-base-scores', batchId),
    setScore: (batchId, applyId, itemCode, finalScore) =>
      ipcRenderer.invoke('apply:set-score', batchId, applyId, itemCode, finalScore),
    confirmBatchExport: (batchId) => ipcRenderer.invoke('apply:batch-export', batchId),
    computeRanking: (batchId) => ipcRenderer.invoke('apply:compute-ranking', batchId)
  },
  overview: {
    get: (batchId) => ipcRenderer.invoke('overview:get', batchId),
    scoreTable: (batchId, options) => ipcRenderer.invoke('overview:score-table', batchId, options)
  },
  export: {
    scoreTableXlsx: (batchId, options) =>
      ipcRenderer.invoke('export:score-table-xlsx', batchId, options),
    saveImage: (fileName, dataUrl) => ipcRenderer.invoke('export:save-image', fileName, dataUrl),
    batchData: (batchId) => ipcRenderer.invoke('export:batch-data', batchId),
    onBatchProgress: (callback) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        progress: Parameters<NonNullable<Parameters<DmsApi['export']['onBatchProgress']>[0]>>[0]
      ): void => callback(progress)
      ipcRenderer.on('export:batch-progress', listener)
      return () => ipcRenderer.removeListener('export:batch-progress', listener)
    }
  },
  evidence: {
    read: (filePath) => ipcRenderer.invoke('evidence:read', filePath)
  },
  data: {
    getInfo: () => ipcRenderer.invoke('data:get-info'),
    pickDir: () => ipcRenderer.invoke('data:pick-dir'),
    setDir: (target) => ipcRenderer.invoke('data:set-dir', target)
  },
  update: {
    check: (manual) => ipcRenderer.invoke('update:check', manual),
    onStatus: (callback) => ipcRenderer.on('update:status', (_e, payload) => callback(payload))
  },
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    // 仅暴露白名单 API（DmsApi）；不暴露原始 electronAPI/ipcRenderer，
    // 避免渲染层绕过白名单直连任意 IPC 通道（含 unit:deactivate / data:set-dir 等危险通道）。
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.api = api
}
