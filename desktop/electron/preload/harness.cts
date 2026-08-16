/**
 * Harness window preload — contextBridge surface + DOM shell for the dsh web UI.
 *
 * Exposes:
 *   - `dshHarness`: harness lifecycle state (about/status affordances).
 *   - `dshUpload`: arbitrary-file upload (pick dialog + drag/drop). Images alone
 *     fall through to the harness's native attachment flow; any non-image file
 *     in a drop is claimed and routed through the workspace `uploads/` path.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron'

export type HarnessState = 'stopped' | 'starting' | 'running' | 'stopping'

export interface UploadResult {
  ok: boolean
  files?: string[]
  sessionId?: string
  error?: string
}

contextBridge.exposeInMainWorld('dshHarness', {
  /** Current harness state. */
  getState: (): Promise<HarnessState> => ipcRenderer.invoke('harness:getState'),

  /** Subscribe to harness state changes; returns an unsubscribe fn. */
  onState: (cb: (state: HarnessState) => void): (() => void) => {
    const listener = (_event: unknown, state: HarnessState): void => cb(state)
    ipcRenderer.on('harness:state', listener)
    return () => {
      ipcRenderer.removeListener('harness:state', listener)
    }
  },
})

contextBridge.exposeInMainWorld('dshUpload', {
  /** Open the native file picker and upload the chosen files. */
  pick: (): Promise<UploadResult> => ipcRenderer.invoke('files:pick'),
  /** Upload files by absolute path (from a drag/drop). */
  uploadPaths: (paths: string[]): Promise<UploadResult> => ipcRenderer.invoke('files:upload', paths),
})

// ---- DOM shell: floating upload button + drag/drop interception ----

const isImage = (file: File): boolean => file.type.startsWith('image/')
const hasNonImage = (files: FileList): boolean => {
  for (const file of Array.from(files)) if (!isImage(file)) return true
  return false
}

/** Transient toast for upload outcome, so success/failure is visible. */
function toast(message: string, kind: 'ok' | 'error' = 'ok'): void {
  const el = document.createElement('div')
  el.textContent = message
  el.style.cssText = [
    'position:fixed', 'right:20px', 'bottom:84px', 'z-index:2147483647',
    'max-width:320px', 'padding:10px 14px', 'border-radius:8px',
    'font:13px/1.4 system-ui, sans-serif', 'color:#fff',
    'background:rgba(0,0,0,0.82)', 'box-shadow:0 4px 16px rgba(0,0,0,0.35)',
    'pointer-events:none', 'transition:opacity 0.3s',
  ].join(';')
  if (kind === 'error') el.style.background = 'rgba(200,50,50,0.92)'
  document.body.appendChild(el)
  setTimeout(() => {
    el.style.opacity = '0'
    setTimeout(() => el.remove(), 350)
  }, 4000)
}

function describeResult(result: UploadResult): void {
  if (!result.ok) toast(`上传失败：${result.error ?? '未知错误'}`, 'error')
  else toast(`已上传 ${result.files?.length ?? 0} 个文件到工作区`)
}

function injectUploadButton(): void {
  const btn = document.createElement('button')
  btn.textContent = '＋'
  btn.title = '上传文件到工作区'
  btn.setAttribute('aria-label', '上传文件')
  btn.style.cssText = [
    'position:fixed', 'right:20px', 'bottom:20px', 'z-index:2147483646',
    'width:44px', 'height:44px', 'border:none', 'border-radius:50%',
    'background:rgba(30,30,30,0.85)', 'color:#fff', 'font-size:22px',
    'line-height:1', 'cursor:pointer', 'box-shadow:0 4px 16px rgba(0,0,0,0.4)',
    'backdrop-filter:blur(6px)',
  ].join(';')
  btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(60,60,60,0.9)' })
  btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(30,30,30,0.85)' })
  btn.addEventListener('click', () => {
    void (window as unknown as { dshUpload: { pick: () => Promise<UploadResult> } })
      .dshUpload.pick().then(describeResult)
  })
  document.body.appendChild(btn)
}

function interceptDrops(): void {
  // Capture phase runs before the React app's own handlers.
  window.addEventListener('dragover', (event) => {
    if (event.dataTransfer?.files !== undefined && hasNonImage(event.dataTransfer.files)) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }
  }, true)

  window.addEventListener('drop', (event) => {
    const files = event.dataTransfer?.files
    if (files === undefined || !hasNonImage(files)) return // all-image → harness native
    event.preventDefault()
    event.stopPropagation()
    const paths = Array.from(files)
      .map((file) => webUtils.getPathForFile(file))
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
    if (paths.length === 0) return
    void (window as unknown as { dshUpload: { uploadPaths: (p: string[]) => Promise<UploadResult> } })
      .dshUpload.uploadPaths(paths).then(describeResult)
  }, true)
}

let closeReloadConfirm: (() => void) | undefined

/**
 * Inline reload confirmation, popped below the ↻ button in the titlebar. The
 * app's native menus are out of the harness UI's control, so a system dialog
 * would clash with the frameless look; this keeps it in-page and styled like
 * the rest of the injected shell (dark, blurred, DeepSeek-blue primary).
 */
function showReloadConfirm(anchor: HTMLButtonElement): void {
  closeReloadConfirm?.()

  const pop = document.createElement('div')
  pop.className = 'dsh-reload-popover'
  pop.style.cssText = [
    'position:fixed', 'z-index:2147483647', 'min-width:236px', 'padding:12px 14px',
    'border-radius:10px', 'background:rgba(30,30,30,0.96)', 'border:1px solid rgba(255,255,255,0.08)',
    'color:#e8e8e8', 'font:13px/1.5 system-ui, sans-serif',
    'box-shadow:0 8px 28px rgba(0,0,0,0.5)', 'backdrop-filter:blur(8px)',
  ].join(';')

  const msg = document.createElement('div')
  msg.textContent = '确定要重新加载界面吗？'
  msg.style.marginBottom = '4px'

  const hint = document.createElement('div')
  hint.textContent = '未发送的输入内容可能会丢失。'
  hint.style.cssText = 'margin-bottom:12px;color:#9a9a9a;font-size:12px;'

  const actions = document.createElement('div')
  actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;'

  const mkBtn = (label: string, primary: boolean): HTMLButtonElement => {
    const b = document.createElement('button')
    b.textContent = label
    b.style.cssText = [
      'padding:5px 14px', 'border-radius:6px', 'border:1px solid transparent',
      'font:13px system-ui, sans-serif', 'cursor:pointer', 'transition:filter 0.12s',
      primary ? 'background:#4d6bfe;color:#fff' : 'background:rgba(255,255,255,0.08);color:#e8e8e8',
    ].join(';')
    b.addEventListener('mouseenter', () => { b.style.filter = 'brightness(1.15)' })
    b.addEventListener('mouseleave', () => { b.style.filter = 'none' })
    return b
  }

  const cancelBtn = mkBtn('取消', false)
  const confirmBtn = mkBtn('重新加载', true)

  const onDocDown = (event: MouseEvent): void => {
    if (!pop.contains(event.target as Node)) close()
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close()
  }
  const close = (): void => {
    document.removeEventListener('mousedown', onDocDown)
    window.removeEventListener('keydown', onKeyDown)
    pop.remove()
    closeReloadConfirm = undefined
  }
  closeReloadConfirm = close

  cancelBtn.addEventListener('click', close)
  confirmBtn.addEventListener('click', () => {
    close()
    ipcRenderer.send('app:reload')
  })

  actions.append(cancelBtn, confirmBtn)
  pop.append(msg, hint, actions)
  document.body.appendChild(pop)

  const r = anchor.getBoundingClientRect()
  pop.style.top = `${r.bottom + 6}px`
  pop.style.right = `${window.innerWidth - r.right}px`

  // Defer so the click that opened it doesn't immediately dismiss it.
  setTimeout(() => {
    document.addEventListener('mousedown', onDocDown)
    window.addEventListener('keydown', onKeyDown)
  }, 0)
}

function injectTitlebar(): void {
  const bar = document.createElement('div')
  bar.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'right:0', 'height:26px',
    'display:flex', 'align-items:stretch', 'justify-content:flex-end',
    'z-index:2147483630', '-webkit-app-region:drag', 'user-select:none',
    'background:transparent',
  ].join(';')

  const mk = (label: string, title: string, onClick: () => void, danger = false): HTMLButtonElement => {
    const b = document.createElement('button')
    b.textContent = label
    b.title = title
    b.setAttribute('aria-label', title)
    b.style.cssText = [
      '-webkit-app-region:no-drag', 'width:42px', 'height:100%', 'border:none',
      'background:transparent', 'color:#c8c8c8', 'font-size:13px', 'line-height:1',
      'cursor:pointer', 'padding:0', 'display:inline-flex', 'align-items:center',
      'justify-content:center', 'font-family:system-ui,sans-serif',
    ].join(';')
    b.addEventListener('mouseenter', () => {
      b.style.background = danger ? '#e81123' : 'rgba(255,255,255,0.12)'
      b.style.color = '#fff'
    })
    b.addEventListener('mouseleave', () => {
      b.style.background = 'transparent'
      b.style.color = '#c8c8c8'
    })
    b.addEventListener('click', onClick)
    return b
  }

  const reloadBtn = mk('↻', '重新加载', () => {
    if (closeReloadConfirm) closeReloadConfirm()
    else showReloadConfirm(reloadBtn)
  })
  const menuBtn = mk('☰', '菜单', () => ipcRenderer.send('app:menu-popup'))
  const minBtn = mk('─', '最小化', () => ipcRenderer.send('window:minimize'))
  const maxBtn = mk('▢', '最大化', () => ipcRenderer.send('window:maximize-toggle'))
  const closeBtn = mk('✕', '关闭', () => ipcRenderer.send('window:close'), true)

  ipcRenderer.on('window:maximized', (_event, maximized: boolean) => {
    maxBtn.textContent = maximized ? '❐' : '▢'
    maxBtn.title = maximized ? '还原' : '最大化'
  })

  bar.append(reloadBtn, menuBtn, minBtn, maxBtn, closeBtn)
  document.body.appendChild(bar)
}

function onReady(fn: () => void): void {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn)
  else fn()
}

onReady(() => {
  injectTitlebar()
  injectUploadButton()
  interceptDrops()
})
