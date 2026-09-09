import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { useWebCryptoProvider } from '@sces/shared'
import icon from '../../resources/icon.png?asset'
import { migrateLegacyIfNeeded, openActiveDb, closeDb } from './db'
import { registerIpcHandlers } from './ipc'
import { initTheme, isDark, onThemeUpdated, updateTitleBarOverlay } from './services/theme'
import { startStatusOutboxWorker } from './services/status-outbox'
import { initUpdater } from './services/updater'
// 应用产品名统一为「学生综合素质测评管理系统」（历史版本为「综测管理系统」）。
// userData 目录显式固定（不依赖打包期 app name 推导）：历史安装沿用旧目录
// %APPDATA%/综测管理系统（升级不丢数据），全新安装落到 %APPDATA%/学生综合素质测评管理系统。
// 开发模式数据隔离：未打包运行时（electron-vite dev / preview）默认与已安装正式版
// 共用同一 userData（settings.json、账号索引、SQLite 库、localStorage 全在其下），
// dev 读写会污染正式数据。在模块顶层、任何读取 userData 的代码之前重定向到独立目录。
if (!app.isPackaged) {
  app.setPath('userData', join(app.getPath('appData'), '学生综合素质测评管理系统-dev'))
} else {
  const legacyUserData = join(app.getPath('appData'), '综测管理系统')
  app.setPath(
    'userData',
    existsSync(legacyUserData)
      ? legacyUserData
      : join(app.getPath('appData'), '学生综合素质测评管理系统')
  )
}

// 单实例（issue：多次打开只保留一个窗口，后启动的实例把已打开窗口置前）。
// 必须在本进程做任何窗口/数据初始化之前获取锁：拿不到锁说明已有实例在运行，
// 本进程立即退出，由已运行实例的 second-instance 处理器把窗口置顶。
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

// 打包运行时 stdout/stderr 管道可能已断开（如父进程退出），此时 console 写入会抛
// EPIPE 未捕获异常并弹出主进程错误框。这里静默吞掉管道错误，避免影响正常功能。
function ignoreEpipe(stream: NodeJS.WriteStream): void {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') return
    throw err
  })
}
ignoreEpipe(process.stdout)
ignoreEpipe(process.stderr)

let mainWindow: BrowserWindow | null = null

/**
 * 单实例置前：再次启动应用（双击图标/快捷方式/文件关联等）时回调。
 * Windows 上窗口可能最小化或隐藏，需要还原后再聚焦，否则置前无效。
 */
function focusMainWindow(): void {
  const win = mainWindow ?? BrowserWindow.getAllWindows()[0]
  if (!win) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

function createWindow(): void {
  // Create the browser window.
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: isDark() ? '#18181b' : '#ffffff',
    ...(process.platform === 'linux' ? { icon } : {}),
    title: '学生综合素质测评管理系统',
    icon,
    // 自定义标题栏：隐藏系统标题栏，Windows 上保留窗口控制按钮覆盖层
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: isDark() ? '#18181b' : '#ffffff',
      symbolColor: isDark() ? '#ffffff' : '#000000',
      height: 35
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  mainWindow = win

  win.on('ready-to-show', () => {
    win.show()
  })

  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer-gone]', details.reason)
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
}

// 单实例置前：再次启动应用（双击图标/快捷方式/文件关联等）时回调。
if (gotSingleInstanceLock) {
  app.on('second-instance', () => {
    focusMainWindow()
  })
}

// 拿不到单实例锁的进程已在上方 quit，后续窗口/数据初始化仅首个实例执行。
if (gotSingleInstanceLock) {
  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  // Some APIs can only be used after this event occurs.
  app.whenReady().then(() => {
    // Set app user model id for windows（需与 electron-builder.json 的 appId 一致，
    // 否则 Windows 通知/任务栏图标会落到错误的 AUMID 上）
    electronApp.setAppUserModelId('cn.thisish.dms')

    // Default open or close DevTools by F12 in development
    // and ignore CommandOrControl + R in production.
    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    // 多账号：先迁移旧版单库，再打开当前激活账号的库（无激活账号则进入验证页）
    migrateLegacyIfNeeded()
    openActiveDb()
    useWebCryptoProvider()
    initTheme()
    registerIpcHandlers()
    startStatusOutboxWorker()

    // 主题变化（含系统主题切换）时更新窗口覆盖层并推送渲染层
    onThemeUpdated(() => {
      updateTitleBarOverlay()
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('theme:changed', isDark())
      }
    })

    createWindow()

    // 自动更新：打包态启动延迟 + 24h 节流自动检查（仅检查不下载，失败静默）。设置页可手动触发。
    initUpdater()

    app.on('activate', function () {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  // Quit when all windows are closed, except on macOS. There, it's common
  // for applications and their menu bar to stay active until the user quits
  // explicitly with Cmd + Q.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('will-quit', () => {
    closeDb()
  })
}
