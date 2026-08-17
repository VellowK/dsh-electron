/**
 * Main process entry — app lifecycle, single-instance, window, menu, and the
 * HarnessManager that owns the dsh web server child process.
 */

import { app, BaseWindow, dialog, Menu, shell, ipcMain, WebContentsView } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { HarnessManager, type HarnessPaths } from './harness.js'
import { registerFileUpload } from './files.js'
import { createTitlebar, TITLEBAR_HEIGHT } from './titlebar.js'
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

let mainWindow: BaseWindow | undefined
let harnessView: WebContentsView | undefined
let titlebarView: WebContentsView | undefined
let appMenu: Menu | undefined
let manager: HarnessManager | undefined
let updater: UpdaterContext | undefined

/** Whether the current session is running in safe mode (only shipped plugins). */
let safeMode = false
/** Guards the startup-failure dialog so only one is ever shown at a time. */
let startupErrorDialogOpen = false

/**
 * Deep-link the harness view to the harness's settings dialog on the plugin
 * market section. The settings shell reads `#settings/<id>` (patched in
 * applySettingsDeepLinkPatch), so setting the hash opens it without a reload.
 */
function openMarket(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
  void harnessView?.webContents.executeJavaScript('location.hash = "#settings/market"')
}

/**
 * Restart the harness in (or out of) safe mode. Safe mode mounts only the
 * shipped web template (`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` +
 * bundled `dshmarket`), so a broken user-installed plugin cannot stop the app
 * from booting. The plugin inventory / market stay fully functional — the user
 * can still add or remove plugins here and reboot normally once the culprit is
 * gone. The menu is rebuilt so its "以安全模式启动" checkbox tracks the state.
 */
function setSafeMode(enabled: boolean): void {
  safeMode = enabled
  manager?.setSafeMode(enabled)
  void manager?.restart().catch((error) => {
    console.error('[harness] safe-mode restart failed:', error)
  })
  buildMenu()
}

/** Fill the window with the titlebar strip on top and the harness view below. */
function layoutContent(): void {
  if (!mainWindow || !harnessView || !titlebarView) return
  const [width, height] = mainWindow.getContentSize()
  titlebarView.setBounds({ x: 0, y: 0, width, height: TITLEBAR_HEIGHT })
  harnessView.setBounds({ x: 0, y: TITLEBAR_HEIGHT, width, height: height - TITLEBAR_HEIGHT })
}

function createWindow(): void {
  mainWindow = new BaseWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'DeepSeek Harness Desktop',
    backgroundColor: '#1a1a1a',
    // Frameless: the app draws its own titlebar strip (menu button + refresh +
    // min/fullscreen/close) above the harness view, so window chrome never
    // overlaps plugin UI rendered in the page's top-right corner.
    frame: false,
    ...(IS_DEV ? { icon: join(__dirname, '..', '..', 'resources', 'icon.ico') } : {}),
  })

  harnessView = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'harness.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow.contentView.addChildView(harnessView)

  titlebarView = createTitlebar(mainWindow)

  layoutContent()
  mainWindow.on('resize', layoutContent)

  const contents = harnessView.webContents

  // Keep the app pinned to the harness UI — never leave to external pages.
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      return { action: 'allow' }
    }
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    const allowed = url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')
    if (!allowed) event.preventDefault()
  })

  mainWindow.on('closed', () => {
    mainWindow = undefined
    harnessView = undefined
    titlebarView = undefined
  })

  contents.on('did-finish-load', () => {
    console.log('[shell] main window finished loading')
  })
  contents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`[shell] main window failed to load (${code}) ${description} — ${url}`)
  })
  contents.on('console-message', (details) => {
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
        {
          label: '以安全模式启动',
          type: 'checkbox',
          checked: safeMode,
          // Electron auto-toggles the checkbox before `click` fires, so
          // `menuItem.checked` is the new target state.
          click: (menuItem) => setSafeMode(menuItem.checked),
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
  appMenu = menu
  Menu.setApplicationMenu(menu)
}

function wireHarness(): void {
  const paths = resolveHarnessPaths()
  manager = new HarnessManager(paths)

  manager.on('ready', (url) => {
    if (harnessView && !mainWindow?.isDestroyed()) {
      void harnessView.webContents.loadURL(url)
      mainWindow?.setTitle(`DeepSeek Harness Desktop — ${url.replace('http://', '')}`)
    }
  })
  manager.on('state', (state) => {
    if (harnessView && !mainWindow?.isDestroyed()) {
      harnessView.webContents.send('harness:state', state)
    }
  })
  manager.on('error', (error) => {
    console.error('[harness] error:', error)
    // Only one startup-failure dialog at a time — the restart loop can fire
    // `error` repeatedly (spawn errors + 120s timeouts), and each used to stack
    // a new modal. The guard turns that into a single dialog with a recovery
    // path (safe mode / retry) instead of an unbounded pile of popups.
    if (startupErrorDialogOpen) return
    if (!mainWindow || mainWindow.isDestroyed()) return
    startupErrorDialogOpen = true
    const options: Electron.MessageBoxOptions = {
      type: 'error',
      title: 'Harness 启动失败',
      message: String((error as Error).message ?? error),
      detail: '启动超时或插件加载失败。可以安全模式启动（仅加载预置插件），或重试。',
      buttons: ['无插件启动模式', '重试', '退出'],
      defaultId: 0,
      cancelId: 1,
    }
    void dialog.showMessageBox(mainWindow, options).then(({ response }) => {
      if (response === 0) {
        setSafeMode(true)
      } else if (response === 1) {
        void manager?.restart().catch((err) => {
          console.error('[harness] retry restart failed:', err)
        })
      } else {
        app.quit()
      }
    }).finally(() => {
      startupErrorDialogOpen = false
    })
  })
  manager.on('log', (_stream, line) => {
    console.log(`[harness] ${line}`)
  })

  ipcMain.handle('harness:getState', () => manager?.getState() ?? 'stopped')
  ipcMain.handle('harness:getSafeMode', () => safeMode)
  ipcMain.handle('harness:restart', () => manager?.restart().catch((error) => {
    console.error('[harness] restart failed:', error)
    throw error
  }))

  // Titlebar window controls. The menu button pops the application menu at its
  // own position (the titlebar sits at the window origin, so its client coords
  // map 1:1 to window coords); the rest drive the frameless window directly.
  ipcMain.on('titlebar:menu', (_event, pos: { x: number; y: number }) => {
    if (!mainWindow || mainWindow.isDestroyed() || !appMenu) return
    appMenu.popup({ window: mainWindow, x: Math.round(pos?.x ?? 0), y: Math.round(pos?.y ?? TITLEBAR_HEIGHT) })
  })
  ipcMain.on('titlebar:refresh', () => {
    if (harnessView && !harnessView.webContents.isDestroyed()) harnessView.webContents.reload()
  })
  ipcMain.on('titlebar:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize()
  })
  ipcMain.on('titlebar:toggleFullscreen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setFullScreen(!mainWindow.isFullScreen())
  })
  ipcMain.on('titlebar:close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
  })

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
    createWindow()
    wireHarness()

    app.on('activate', () => {
      // macOS re-create window on dock click.
      if (BaseWindow.getAllWindows().length === 0) createWindow()
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
