/**
 * Harness view preload — contextBridge surface + upload affordances for the
 * dsh web UI.
 *
 * Exposes:
 *   - `dshHarness`: harness lifecycle state (about/status affordances).
 *   - `dshUpload`: arbitrary-file upload (pick dialog + drag/drop). Images alone
 *     fall through to the harness's native attachment flow; any non-image file
 *     in a drop is claimed and routed through the workspace `uploads/` path.
 *
 * Window controls are NOT injected here — the shell uses the native window
 * frame (title bar + min/max/close) and the native application menu bar, so
 * plugin UI in the page's top-right corner never collides with them.
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

  /** Whether the shell booted in safe mode (only the shipped plugins). */
  getSafeMode: (): Promise<boolean> => ipcRenderer.invoke('harness:getSafeMode'),

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

function onReady(fn: () => void): void {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn)
  else fn()
}

// ---- Safe-mode banner: a bottom fade-to-black with a hint line ----

/** Inject the "以安全模式启动" gradient footer. Idempotent. */
function showSafeModeBanner(): void {
  if (document.getElementById('dsh-safe-mode-banner') !== null) return
  const banner = document.createElement('div')
  banner.id = 'dsh-safe-mode-banner'
  banner.style.cssText = [
    'position:fixed', 'left:0', 'right:0', 'bottom:0', 'height:120px',
    'z-index:2147483000', 'pointer-events:none', 'box-sizing:border-box',
    'background:linear-gradient(to top, rgba(0,0,0,0.92), rgba(0,0,0,0))',
    'display:flex', 'align-items:flex-end', 'justify-content:center',
    'padding-bottom:14px',
  ].join(';')
  const text = document.createElement('div')
  text.textContent = '以安全模式启动'
  text.style.cssText = [
    'color:#fff', 'font:13px/1.4 system-ui, sans-serif', 'letter-spacing:0.5px',
    'opacity:0.9', 'text-shadow:0 1px 4px rgba(0,0,0,0.8)',
  ].join(';')
  banner.appendChild(text)
  document.body.appendChild(banner)
}

onReady(() => {
  injectUploadButton()
  interceptDrops()
  // Ask the shell whether this session is in safe mode; when it is, draw the
  // footer hint. Querying on load avoids any IPC race with the banner state.
  void (window as unknown as { dshHarness: { getSafeMode: () => Promise<boolean> } })
    .dshHarness.getSafeMode().then((active) => {
      if (active) showSafeModeBanner()
    })
})
