/**
 * Titlebar view — a thin custom window-chrome strip for the frameless window.
 *
 * The menu button, the refresh button, and the window controls (minimize /
 * fullscreen / close) live in their own WebContentsView above the harness view,
 * so they never overlap plugin UI rendered inside the page.
 */

import { BaseWindow, WebContentsView } from 'electron'
import { join } from 'node:path'

/** Height (in DIP) of the titlebar strip. */
export const TITLEBAR_HEIGHT = 40

// The preload builds the whole DOM; the page itself is just an empty shell.
const TITLEBAR_HTML = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>'

/**
 * Create the titlebar view and attach it to the window. Returns the view so the
 * caller can lay it out alongside the harness view.
 */
export function createTitlebar(mainWindow: BaseWindow): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'titlebar.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  view.setBackgroundColor('#202124')
  void view.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(TITLEBAR_HTML))
  mainWindow.contentView.addChildView(view)

  // Keep the fullscreen button's icon (enter ↔ exit) in sync with the window.
  const syncFullscreen = (): void => {
    if (!view.webContents.isDestroyed()) {
      view.webContents.send('titlebar:fullscreen', mainWindow.isFullScreen())
    }
  }
  mainWindow.on('enter-full-screen', syncFullscreen)
  mainWindow.on('leave-full-screen', syncFullscreen)
  view.webContents.on('did-finish-load', syncFullscreen)

  return view
}
