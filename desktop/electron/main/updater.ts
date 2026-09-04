/**
 * Simple version check updater. No silent auto-install. It checks two things
 * independently:
 *   - the *harness runtime* (`@deepseek-ai/dsh`) against the npm "latest",
 *     swapping it in place on explicit confirmation and restarting the child;
 *   - the *Electron shell* against the newest GitHub release, pointing at the
 *     download page (the NSIS-installed shell can't self-update).
 */

import { BaseWindow, dialog, ipcMain, Notification, shell } from 'electron'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'

export interface UpdateProgress {
  phase: 'preparing' | 'resolving' | 'downloading' | 'installing' | 'activating' | 'complete' | 'failed'
  percent: number
  message: string
}

export interface UpdaterContext {
  /** Root of the harness runtime install (`.../harness`). */
  harnessRoot: string
  /** The Electron shell version (`app.getVersion()`), for display only. */
  shellVersion: string
  /** Return the current main window so notifications can focus it. */
  getWindow?: () => BaseWindow | undefined
  /** npm registry used for Harness checks and installs. */
  registryUrl?: string
  /** Persist a changed npm registry source. */
  setRegistryUrl?: (url: string) => void
  /** Publish best-effort installation progress to the renderer. */
  onProgress?: (progress: UpdateProgress) => void
  /** Stop the harness before replacing its runtime files. */
  stop: () => Promise<void>
  /** Restart the harness child after an update; resolves to the new URL. */
  restart: () => Promise<string>
}

export interface UpdateStatus {
  current: string | undefined
  latest: string
  hasUpdate: boolean
}

/** Shell (Electron app) update status, sourced from GitHub releases. */
export interface ShellUpdateStatus {
  current: string
  latest: string
  hasUpdate: boolean
  url: string | undefined
}

const PNPM_VERSION = '11.7.0'

/** GitHub repo the shell is published to; shell updates come from its releases. */
const SHELL_REPO = 'VellowK/dsh-electron'

function githubApiBase(): string {
  return (process.env.DSH_GITHUB_API ?? 'https://api.github.com').replace(/\/+$/, '')
}

function registryBase(configured?: string): string {
  return (configured ?? process.env.DSH_NPM_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/+$/, '')
}

/** Bundled harness version: VERSION file first, else the installed package.json. */
function bundledVersion(ctx: UpdaterContext): string | undefined {
  const v = join(ctx.harnessRoot, 'VERSION')
  if (existsSync(v)) {
    const content = readFileSync(v, 'utf8').trim()
    if (content !== '') return content
  }
  const manifest = join(ctx.harnessRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  if (existsSync(manifest)) {
    try {
      return JSON.parse(readFileSync(manifest, 'utf8')).version as string | undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

async function fetchLatest(registry?: string): Promise<string> {
  const url = `${registryBase(registry)}/@deepseek-ai%2Fdsh/latest`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`registry HTTP ${response.status}`)
  const data = (await response.json()) as { version?: string }
  if (typeof data.version !== 'string' || data.version === '') throw new Error('registry returned no version')
  return data.version
}

/** Split a semver-ish version into numeric core + prerelease identifiers. */
function parseVersion(v: string): { core: number[]; pre: string[]; hasPre: boolean } {
  const [core, ...rest] = v.split('-')
  return {
    core: core.split('.').map((n) => parseInt(n, 10) || 0),
    pre: rest.join('-').split('.').filter((s) => s !== ''),
    hasPre: rest.length > 0,
  }
}

/** -1 | 0 | 1. Prereleases sort before their release; prerelease ids compare numerically when both numeric. */
function compareVersions(a: string, b: string): number {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  const len = Math.max(va.core.length, vb.core.length)
  for (let i = 0; i < len; i++) {
    const na = va.core[i] ?? 0
    const nb = vb.core[i] ?? 0
    if (na !== nb) return na > nb ? 1 : -1
  }
  if (va.hasPre !== vb.hasPre) return va.hasPre ? -1 : 1
  if (!va.hasPre) return 0
  const plen = Math.max(va.pre.length, vb.pre.length)
  for (let i = 0; i < plen; i++) {
    const pa = va.pre[i] ?? ''
    const pb = vb.pre[i] ?? ''
    if (pa === pb) continue
    const na = parseInt(pa, 10)
    const nb = parseInt(pb, 10)
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na > nb ? 1 : -1
    return pa > pb ? 1 : -1
  }
  return 0
}

/** Human-readable error message from any thrown value. */
function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Latest shell release from GitHub. All shell releases are plain `x.y.z` (no
 * prerelease), so `/releases/latest` returns the newest one directly.
 */
async function fetchLatestShell(): Promise<{ version: string; url: string }> {
  const url = `${githubApiBase()}/repos/${SHELL_REPO}/releases/latest`
  const response = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-electron-updater' },
  })
  if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`)
  const latest = (await response.json()) as { tag_name?: string; html_url?: string }
  if (!latest || typeof latest.tag_name !== 'string' || latest.tag_name === '') {
    throw new Error('GitHub returned no release')
  }
  return {
    version: latest.tag_name.replace(/^v/, ''),
    url: latest.html_url ?? `https://github.com/${SHELL_REPO}/releases`,
  }
}

/** Compare the running shell version against the newest GitHub release. Never prompts. */
export async function checkForShellUpdate(ctx: UpdaterContext): Promise<ShellUpdateStatus> {
  const latest = await fetchLatestShell()
  return {
    current: ctx.shellVersion,
    latest: latest.version,
    hasUpdate: compareVersions(latest.version, ctx.shellVersion) > 0,
    url: latest.url,
  }
}

/** Fetch latest, compare against bundled, and report. Never prompts. */
export async function checkForUpdate(ctx: UpdaterContext): Promise<UpdateStatus> {
  const current = bundledVersion(ctx)
  const latest = await fetchLatest(ctx.registryUrl)
  const hasUpdate = current === undefined ? true : compareVersions(latest, current) > 0
  return { current, latest, hasUpdate }
}

const UPDATE_TIMEOUT_MS = 10 * 60 * 1000
let updateInProgress = false

/** Run the bundled pnpm in a temporary runtime, then replace node_modules. */
function runBundledPnpmUpdate(ctx: UpdaterContext): Promise<string> {
  const packageManager = join(ctx.harnessRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
  if (!existsSync(packageManager)) throw new Error(`bundled pnpm not found: ${packageManager}`)

  const stagingRoot = mkdtempSync(join(ctx.harnessRoot, '.update-'))
  const stagingModules = join(stagingRoot, 'node_modules')
  mkdirSync(stagingModules, { recursive: true })
  ctx.onProgress?.({ phase: 'preparing', percent: 0, message: '准备更新环境…' })
  writeFileSync(join(stagingRoot, 'package.json'), JSON.stringify({
    name: 'dsh-harness-runtime',
    private: true,
    dependencies: {
      '@deepseek-ai/dsh': 'latest',
      dshmarket: '1.10.0',
      pnpm: PNPM_VERSION,
    },
  }, null, 2) + '\n')
  writeFileSync(join(stagingRoot, 'pnpm-workspace.yaml'), [
    'allowBuilds:',
    '  koffi: true',
    '  node-pty: true',
    '  "@deepseek-ai/dsh-subprocess-local": true',
    '  @google/genai: false',
    '  protobufjs: false',
    '',
  ].join('\n'))

  return new Promise((resolve, reject) => {
    const args = [packageManager, 'install', '--no-lockfile']
    if (ctx.registryUrl) args.push('--registry', ctx.registryUrl)
    const child: ChildProcessByStdio<null, Readable, Readable> = spawn(process.execPath, args, {
      cwd: stagingRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let output = ''
    let settled = false
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      child.stdout.removeAllListeners()
      child.stderr.removeAllListeners()
      child.removeAllListeners()
    }
    const reportProgress = (chunk: string): void => {
      const match = /Progress: resolved (\d+), reused (\d+), downloaded (\d+), added (\d+)/.exec(chunk)
      if (match === null) return
      const resolved = Number(match[1])
      const downloaded = Number(match[3])
      const added = Number(match[4])
      const phase = added > 0 ? 'installing' : downloaded > 0 ? 'downloading' : 'resolving'
      const percent = phase === 'resolving'
        ? Math.min(35, Math.max(5, Math.round(resolved / 2)))
        : phase === 'downloading'
          ? Math.min(70, 35 + Math.round(Math.min(35, downloaded / 2)))
          : Math.min(90, 70 + Math.round(Math.min(20, added / 25)))
      ctx.onProgress?.({ phase, percent, message: phase === 'resolving' ? `解析依赖（${resolved}）…` : phase === 'downloading' ? `下载依赖（${downloaded}）…` : `安装依赖（${added}）…` })
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      child.kill()
      reject(new Error(`pnpm update timed out after ${UPDATE_TIMEOUT_MS / 1000}s\n${output.trim()}`))
    }, UPDATE_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c: string) => {
      output += c
      reportProgress(output)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c: string) => {
      output += c
      reportProgress(output)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(`bundled pnpm unavailable: ${error.message}`))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      cleanup()
      if (code !== 0) {
        ctx.onProgress?.({ phase: 'failed', percent: 0, message: '依赖安装失败' })
        reject(new Error(`pnpm update exited ${code}\n${output.trim()}`))
        return
      }
      try {
        const stagedManifest = join(stagingRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
        const version = JSON.parse(readFileSync(stagedManifest, 'utf8')).version as string | undefined
        if (version === undefined) throw new Error('updated harness package has no version')
        const currentModules = join(ctx.harnessRoot, 'node_modules')
        const backupModules = join(ctx.harnessRoot, '.node_modules.backup')
        if (existsSync(backupModules)) rmSync(backupModules, { recursive: true, force: true })
        renameSync(currentModules, backupModules)
        try {
          renameSync(stagingModules, currentModules)
          writeFileSync(join(ctx.harnessRoot, 'VERSION'), `${version}\n`)
          rmSync(backupModules, { recursive: true, force: true })
        } catch (error) {
          if (existsSync(currentModules)) rmSync(currentModules, { recursive: true, force: true })
          if (!existsSync(currentModules) && existsSync(backupModules)) renameSync(backupModules, currentModules)
          throw error
        }
        resolve(version)
      } catch (error) {
        reject(new Error(`failed to activate harness update: ${errMsg(error)}\n${output.trim()}`))
      } finally {
        rmSync(stagingRoot, { recursive: true, force: true })
      }
    })
  })
}

/** Apply the update (already confirmed), restarting the harness around replacement. */
export async function applyUpdate(ctx: UpdaterContext): Promise<string> {
  if (updateInProgress) throw new Error('已有更新正在进行')
  updateInProgress = true
  ctx.onProgress?.({ phase: 'preparing', percent: 0, message: '准备停止 Harness…' })
  let stopped = false
  try {
    await ctx.stop()
    stopped = true
    const version = await runBundledPnpmUpdate(ctx)
    ctx.onProgress?.({ phase: 'complete', percent: 100, message: `已更新到 Harness ${version}` })
    return version
  } catch (error) {
    ctx.onProgress?.({ phase: 'failed', percent: 0, message: `更新失败：${errMsg(error)}` })
    throw error
  } finally {
    updateInProgress = false
    if (stopped) await ctx.restart()
  }
}

/** Check, then prompt via a native dialog; on confirm apply + restart (harness) or open the download page (shell). */
export async function checkAndPrompt(
  ctx: UpdaterContext,
  window: BaseWindow | undefined,
  target: 'all' | 'harness' = 'all',
): Promise<void> {
  const targetWindow = window && !window.isDestroyed() ? window : ctx.getWindow?.()
  if (targetWindow && !targetWindow.isDestroyed()) {
    if (targetWindow.isMinimized()) targetWindow.restore()
    targetWindow.focus()
  }
  const show = (options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> =>
    targetWindow && !targetWindow.isDestroyed() ? dialog.showMessageBox(targetWindow, options) : dialog.showMessageBox(options)

  // A notification already identifies its update target. Avoid checking the
  // unrelated shell again, which could otherwise consume the harness action.
  const [shellRes, harnessRes] = await Promise.allSettled([
    target === 'harness' ? Promise.resolve(undefined) : checkForShellUpdate(ctx),
    checkForUpdate(ctx),
  ])
  const shellStatus = shellRes.status === 'fulfilled' ? shellRes.value : undefined
  const harnessStatus = harnessRes.status === 'fulfilled' ? harnessRes.value : undefined
  const failures: string[] = []
  if (shellRes.status === 'rejected') failures.push(`外壳：${errMsg(shellRes.reason)}`)
  if (harnessRes.status === 'rejected') failures.push(`harness：${errMsg(harnessRes.reason)}`)

  // Shell update first — it's the app itself, and it can't self-update, so
  // point at the GitHub download page rather than an in-place install.
  if (shellStatus?.hasUpdate) {
    const options: Electron.MessageBoxOptions = {
      type: 'info',
      title: '发现新版本',
      message: `外壳有新版本可用：v${shellStatus.latest}`,
      detail: `当前 v${shellStatus.current} → 最新 v${shellStatus.latest}\n外壳通过安装包更新，请到 GitHub 下载新版安装包。`,
      buttons: ['打开下载页', '稍后'],
      defaultId: 0,
      cancelId: 1,
    }
    const choice = await show(options)
    if (choice.response === 0 && shellStatus.url) void shell.openExternal(shellStatus.url)
    return
  }

  if (harnessStatus?.hasUpdate) {
    const options: Electron.MessageBoxOptions = {
      type: 'info',
      title: '发现新版本',
      message: `harness 有新版本可用：${harnessStatus.latest}`,
      detail: `当前 ${harnessStatus.current ?? '未安装'} → 最新 ${harnessStatus.latest}\n（外壳 v${ctx.shellVersion}）${updateInProgress ? '\n正在更新，请稍候。' : ''}`,
      buttons: ['更新', '稍后'],
      defaultId: 0,
      cancelId: 1,
    }
    if (updateInProgress) {
      void show({ type: 'info', title: '更新', message: '已有更新正在进行，请稍候。' })
      return
    }
    const choice = await show(options)
    if (choice.response !== 0) return

    try {
      const version = await applyUpdate(ctx)
      const done: Electron.MessageBoxOptions = {
        type: 'info',
        title: '更新完成',
        message: `已更新到 harness ${version}`,
        detail: 'harness 已重启。',
      }
      void show(done)
    } catch (error) {
      const failed: Electron.MessageBoxOptions = {
        type: 'error',
        title: '更新失败',
        message: '更新 harness 失败',
        detail: errMsg(error),
        buttons: ['打开下载页', '关闭'],
        defaultId: 1,
        cancelId: 1,
      }
      const fallback = await show(failed)
      if (fallback.response === 0) void shell.openExternal('https://www.npmjs.com/package/@deepseek-ai/dsh')
    }
    return
  }

  // Nothing newer. If BOTH checks failed there's no "latest" to trust, so
  // report the failure; otherwise surface any partial failure as a note.
  if (!shellStatus && !harnessStatus) {
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      title: '检查更新',
      message: '检查更新失败',
      detail: failures.join('\n'),
    }
    void show(options)
    return
  }

  const note = failures.length > 0 ? `\n（部分检查失败：${failures.join('；')}）` : ''
  const options: Electron.MessageBoxOptions = {
    type: 'info',
    title: '检查更新',
    message: '已是最新版本',
    detail: `外壳 v${ctx.shellVersion} · harness ${harnessStatus?.current ?? '未知'}${note}`,
  }
  void show(options)
}

/** Background startup check: non-blocking, surfaces a system notification only. */
export function backgroundCheck(ctx: UpdaterContext): void {
  const activeNotifications = new Set<Notification>()
  const notify = (title: string, body: string, onClick: () => void): void => {
    if (Notification.isSupported()) {
      const notification = new Notification({ title, body })
      activeNotifications.add(notification)
      const cleanup = (): void => { activeNotifications.delete(notification) }
      notification.on('click', onClick)
      notification.on('close', cleanup)
      notification.show()
    } else {
      console.log(`[updater] ${title}: ${body}`)
    }
  }

  checkForShellUpdate(ctx)
    .then((status) => {
      if (!status.hasUpdate) return
      notify('外壳有新版本', `v${status.current} → v${status.latest}`, () => {
        if (status.url) void shell.openExternal(status.url)
      })
    })
    .catch((error) => console.log(`[updater] background shell check failed: ${errMsg(error)}`))

  checkForUpdate(ctx)
    .then((status) => {
      if (!status.hasUpdate) return
      notify('harness 有新版本', `${status.current ?? '?'} → ${status.latest}`, () => {
        void checkAndPrompt(ctx, ctx.getWindow?.(), 'harness')
      })
    })
    .catch((error) => console.log(`[updater] background check failed: ${errMsg(error)}`))
}

/** Register the update IPC surface and return a disposer. */
export function registerUpdater(ctx: UpdaterContext): () => void {
  ipcMain.handle('update:check', () => checkForUpdate(ctx))
  ipcMain.handle('update:apply', () => applyUpdate(ctx))
  return () => {
    ipcMain.removeHandler('update:check')
    ipcMain.removeHandler('update:apply')
  }
}
