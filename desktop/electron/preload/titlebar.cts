/**
 * Titlebar preload — builds the custom window chrome for a frameless window:
 * a menu button, a refresh button, and the minimize / fullscreen / close
 * controls, all in one row.
 *
 * This runs in its own dedicated WebContentsView (the top strip), so its
 * buttons never overlap plugin UI that renders inside the harness view. It
 * exposes nothing to the page (the page has no app content); it talks to the
 * main process over a few fire-and-forget IPC channels.
 */

import { ipcRenderer } from 'electron'

const ICONS = {
  menu:
    '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  refresh:
    '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.9M13.5 2.5v2.7h-2.7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  minimize:
    '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M3 8.5h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  maximize:
    '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">' +
    '<rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  restore:
    '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">' +
    '<rect x="3.5" y="5.5" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
    '<path d="M6.5 5.5V4.5a1 1 0 0 1 1-1H11.5a1 1 0 0 1 1 1V9a1 1 0 0 1-1 1h-1" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  close:
    '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
}

function makeButton(icon: string, title: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.className = 'tb-btn'
  btn.type = 'button'
  btn.title = title
  btn.setAttribute('aria-label', title)
  btn.innerHTML = icon
  btn.addEventListener('click', onClick)
  return btn
}

function onReady(fn: () => void): void {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn)
  else fn()
}

onReady(() => {
  const style = document.createElement('style')
  style.textContent = [
    'html,body{margin:0;height:100%;overflow:hidden}',
    'body{background:#202124;font:12px/1 system-ui,sans-serif;color:#e8eaed;user-select:none}',
    '#tb{display:flex;align-items:center;height:100%;-webkit-app-region:drag}',
    '.tb-btn{display:flex;align-items:center;justify-content:center;width:44px;height:100%;border:none;background:transparent;color:#c8cbd1;cursor:pointer;-webkit-app-region:no-drag}',
    '.tb-btn:hover{background:rgba(255,255,255,0.1);color:#fff}',
    '.tb-btn:active{background:rgba(255,255,255,0.16)}',
    '.tb-btn.tb-close:hover{background:#e81123;color:#fff}',
    '.tb-drag{flex:1;height:100%;display:flex;align-items:center;padding:0 8px;color:#9aa0a6;letter-spacing:0.3px;overflow:hidden;white-space:nowrap}',
    '.tb-refresh-wrap{position:relative;display:flex;height:100%;-webkit-app-region:no-drag}',
    '.tb-confirm{position:absolute;top:42px;right:0;z-index:10;width:190px;padding:12px;background:#2b2d31;border:1px solid #45484f;border-radius:6px;box-shadow:0 6px 18px rgba(0,0,0,.35);color:#e8eaed;line-height:1.4}',
    '.tb-confirm[hidden]{display:none}',
    '.tb-confirm-text{margin:0 0 10px}',
    '.tb-confirm-actions{display:flex;justify-content:flex-end;gap:6px}',
    '.tb-confirm-btn{padding:5px 10px;border:1px solid #555a63;border-radius:4px;background:#363940;color:#e8eaed;cursor:pointer;font:inherit}',
    '.tb-confirm-btn:hover{background:#454951}',
    '.tb-confirm-btn-primary{border-color:#5b8def;background:#4472c4;color:#fff}',
    '.tb-confirm-btn-primary:hover{background:#5283d8}',
  ].join('\n')
  document.head.appendChild(style)

  const bar = document.createElement('div')
  bar.id = 'tb'

  const menuBtn = makeButton(ICONS.menu, '菜单', () => {
    const r = menuBtn.getBoundingClientRect()
    ipcRenderer.send('titlebar:menu', { x: Math.round(r.left), y: Math.round(r.bottom) })
  })
  const drag = document.createElement('div')
  drag.className = 'tb-drag'
  drag.textContent = ''

  const refreshWrap = document.createElement('div')
  refreshWrap.className = 'tb-refresh-wrap'
  const refreshBtn = makeButton(ICONS.refresh, '刷新', () => {
    refreshConfirm.hidden = !refreshConfirm.hidden
    if (!refreshConfirm.hidden) cancelBtn.focus()
  })
  refreshWrap.appendChild(refreshBtn)

  const refreshConfirm = document.createElement('div')
  refreshConfirm.className = 'tb-confirm'
  refreshConfirm.setAttribute('role', 'dialog')
  refreshConfirm.setAttribute('aria-label', '确认刷新')
  refreshConfirm.hidden = true
  const confirmText = document.createElement('p')
  confirmText.className = 'tb-confirm-text'
  confirmText.textContent = '确定要刷新页面吗？未提交的内容可能会丢失。'
  const confirmActions = document.createElement('div')
  confirmActions.className = 'tb-confirm-actions'
  const cancelBtn = document.createElement('button')
  cancelBtn.className = 'tb-confirm-btn'
  cancelBtn.type = 'button'
  cancelBtn.textContent = '取消'
  cancelBtn.addEventListener('click', () => {
    refreshConfirm.hidden = true
    refreshBtn.focus()
  })
  const confirmBtn = document.createElement('button')
  confirmBtn.className = 'tb-confirm-btn tb-confirm-btn-primary'
  confirmBtn.type = 'button'
  confirmBtn.textContent = '刷新'
  confirmBtn.addEventListener('click', () => {
    refreshConfirm.hidden = true
    ipcRenderer.send('titlebar:refresh')
  })
  confirmActions.append(cancelBtn, confirmBtn)
  refreshConfirm.append(confirmText, confirmActions)
  refreshWrap.appendChild(refreshConfirm)

  const minBtn = makeButton(ICONS.minimize, '最小化', () => ipcRenderer.send('titlebar:minimize'))
  const fullBtn = makeButton(ICONS.maximize, '全屏', () => ipcRenderer.send('titlebar:toggleFullscreen'))
  const closeBtn = makeButton(ICONS.close, '关闭', () => ipcRenderer.send('titlebar:close'))
  closeBtn.classList.add('tb-close')

  bar.append(drag, refreshWrap, menuBtn, minBtn, fullBtn, closeBtn)
  document.body.appendChild(bar)

  document.addEventListener('pointerdown', (event) => {
    if (!refreshWrap.contains(event.target as Node)) refreshConfirm.hidden = true
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !refreshConfirm.hidden) {
      refreshConfirm.hidden = true
      refreshBtn.focus()
    }
  })

  // Swap the fullscreen icon to "restore" while the window is fullscreen so the
  // button doubles as the exit control.
  ipcRenderer.on('titlebar:fullscreen', (_event, fs: boolean) => {
    fullBtn.innerHTML = fs ? ICONS.restore : ICONS.maximize
    fullBtn.title = fs ? '退出全屏' : '全屏'
  })
})
