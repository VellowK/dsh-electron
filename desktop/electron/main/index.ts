/**
 * Main process entry — app lifecycle, single-instance, window, menu, and the
 * HarnessManager that owns the dsh web server child process.
 */

import { app, BrowserWindow, dialog, Menu, shell, ipcMain } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { HarnessManager, type HarnessPaths } from './harness.js'
import { registerFileUpload } from './files.js'
import { backgroundCheck, checkAndPrompt, registerUpdater, type UpdaterContext } from './updater.js'

// CJS build (no "type": "module" in package.json) — `__dirname` is available.

/** Devtools only in dev; packaged builds keep them off. */
const IS_DEV = !app.isPackaged

function resolveHarnessPaths(): HarnessPaths {
  // In dev the runtime lives under the repo's resources/harness (checked out by
  // scripts/prepare-harness.mjs). In a packaged build it is copied outside the
  // asar via electron-builder extraResources → process.resourcesPath/harness.
  const root = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  const harnessRoot = join(root, 'harness')
  const binPath = join(harnessRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const pnpmBinDir = join(harnessRoot, 'node_modules', '.bin')
  const dshHome = join(app.getPath('userData'), 'dsh-home')
  const workspace = join(app.getPath('userData'), 'workspace')
  mkdirSync(dshHome, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  return { binPath, dshHome, workspace, pnpmBinDir, harnessRoot }
}

let mainWindow: BrowserWindow | undefined
let manager: HarnessManager | undefined
let updater: UpdaterContext | undefined

/**
 * Deep-link the main window to the harness's settings dialog on the plugin
 * market section. The settings shell reads `#settings/<id>` (patched in
 * applySettingsDeepLinkPatch), so setting the hash opens it without a reload.
 */
function openMarket(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
  void mainWindow.webContents.executeJavaScript('location.hash = "#settings/market"')
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'DeepSeek Harness Desktop',
    backgroundColor: '#1a1a1a',
    // Frameless: no OS title bar / menu bar. The harness UI is full-bleed; the
    // preload injects a slim drag strip + window controls (min/max/close) and a
    // menu button that pops the application menu.
    frame: false,
    ...(IS_DEV ? { icon: join(__dirname, '..', '..', 'resources', 'icon.ico') } : {}),
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'harness.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // Keep the app pinned to the harness UI — never leave to external pages.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      return { action: 'allow' }
    }
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')
    if (!allowed) event.preventDefault()
  })

  // Keep the injected maximize/restore button in sync.
  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized', false))

  mainWindow.on('closed', () => {
    mainWindow = undefined
  })

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[shell] main window finished loading')
  })
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`[shell] main window failed to load (${code}) ${description} — ${url}`)
  })
  mainWindow.webContents.on('console-message', (details) => {
    if (details.level === 'error' || details.level === 'warning') {
      console.log(`[renderer:${details.level}] ${details.message}`)
    }
  })
}

function buildMenu(): void {
  const menu = Menu.buildFromTemplate([
    {
      label: '视图',
      submenu: [
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具', visible: IS_DEV },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '工具',
      submenu: [
        {
          label: '插件市场',
          click: () => openMarket(),
        },
        {
          label: '重启服务',
          click: () => {
            if (manager) void manager.restart().catch((error) => {
              console.error('[shell] restart failed:', error)
            })
          },
        },
        { type: 'separator' },
        {
          label: '打开工作区目录',
          click: () => {
            if (manager) void shell.openPath(manager.paths.workspace)
          },
        },
        {
          label: '打开数据目录',
          click: () => {
            if (manager) void shell.openPath(manager.paths.dshHome)
          },
        },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '检查更新',
          click: () => {
            if (updater) void checkAndPrompt(updater, mainWindow)
          },
        },
        { type: 'separator' },
        {
          label: '关于',
          click: () => {
            const options: Electron.MessageBoxOptions = {
              type: 'info',
              title: '关于',
              message: `DeepSeek Harness Desktop ${app.getVersion()}`,
              detail: 'Electron 封装的 dsh web 界面',
            }
            if (mainWindow && !mainWindow.isDestroyed()) {
              void dialog.showMessageBox(mainWindow, options)
            } else {
              void dialog.showMessageBox(options)
            }
          },
        },
      ],
    },
  ])
  Menu.setApplicationMenu(menu)
}

function registerWindowControls(): void {
  ipcMain.on('app:menu-popup', () => {
    const menu = Menu.getApplicationMenu()
    if (menu && mainWindow && !mainWindow.isDestroyed()) {
      menu.popup({ window: mainWindow })
    }
  })
  ipcMain.on('app:reload', () => { mainWindow?.webContents.reload() })
  ipcMain.on('window:minimize', () => { mainWindow?.minimize() })
  ipcMain.on('window:maximize-toggle', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('window:close', () => { mainWindow?.close() })
}

function wireHarness(): void {
  const paths = resolveHarnessPaths()
  manager = new HarnessManager(paths)

  manager.on('ready', (url) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      void mainWindow.loadURL(url)
      mainWindow.setTitle(`DeepSeek Harness Desktop — ${url.replace('http://', '')}`)
    }
  })
  manager.on('state', (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('harness:state', state)
    }
  })
  manager.on('error', (error) => {
    console.error('[harness] error:', error)
    if (mainWindow && !mainWindow.isDestroyed()) {
      void dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'Harness 启动失败',
        message: String((error as Error).message ?? error),
      })
    }
  })
  manager.on('log', (_stream, line) => {
    console.log(`[harness] ${line}`)
  })

  ipcMain.handle('harness:getState', () => manager?.getState() ?? 'stopped')
  ipcMain.handle('harness:restart', () => manager?.restart().catch((error) => {
    console.error('[harness] restart failed:', error)
    throw error
  }))

  registerFileUpload({
    workspace: paths.workspace,
    getUrl: () => manager?.getUrl(),
  })

  updater = {
    harnessRoot: paths.harnessRoot,
    shellVersion: app.getVersion(),
    restart: () => manager?.restart() ?? Promise.reject(new Error('harness manager not ready')),
  }
  registerUpdater(updater)
  // Non-blocking startup check; a system notification (not a modal) is shown
  // when a newer harness exists.
  backgroundCheck(updater)

  // Start now; the window loads the URL once 'ready' fires.
  manager.start().catch((error) => {
    console.error('[harness] start failed:', error)
  })
}

// Single-instance: a second launch focuses the existing window instead.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  // Windows requires an explicit AppUserModelID for notifications to surface.
  app.setAppUserModelId('com.deepseek.dsh-desktop')
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    buildMenu()
    registerWindowControls()
    createWindow()
    wireHarness()

    app.on('activate', () => {
      // macOS re-create window on dock click.
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  // Shut the harness down before we exit so no orphan server lingers.
  app.on('before-quit', (event) => {
    if (manager && manager.getState() !== 'stopped') {
      event.preventDefault()
      void manager.stop().then(() => app.quit())
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
