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
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'

export interface UpdaterContext {
  /** Root of the harness runtime install (`.../harness`). */
  harnessRoot: string
  /** The Electron shell version (`app.getVersion()`), for display only. */
  shellVersion: string
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

const PNPM_VERSION = 'pnpm@11.7.0'

/** GitHub repo the shell is published to; shell updates come from its releases. */
const SHELL_REPO = 'VellowK/dsh-electron'

function githubApiBase(): string {
  return (process.env.DSH_GITHUB_API ?? 'https://api.github.com').replace(/\/+$/, '')
}

function registryBase(): string {
  return (process.env.DSH_NPM_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/+$/, '')
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

async function fetchLatest(): Promise<string> {
  const url = `${registryBase()}/@deepseek-ai%2Fdsh/latest`
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
  const latest = await fetchLatest()
  const hasUpdate = current === undefined ? true : compareVersions(latest, current) > 0
  return { current, latest, hasUpdate }
}

/** Run `npm install` to move the harness to `@latest` in place. Resolves to the new version. */
function runNpmUpdate(ctx: UpdaterContext): Promise<string> {
  return new Promise((resolve, reject) => {
    const argv = ['install', '--no-audit', '--no-fund', '--no-save', '@deepseek-ai/dsh@latest', PNPM_VERSION]
    if (process.env.DSH_NPM_REGISTRY) argv.push('--registry', process.env.DSH_NPM_REGISTRY)
    // Build one command string (mirrors prepare-harness.mjs) so `npm` resolves
    // through cmd.exe as npm.cmd on Windows, without shell-arg concatenation.
    const command = ['npm', ...argv.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' ')
    const child: ChildProcessByStdio<null, Readable, Readable> = spawn(command, {
      cwd: ctx.harnessRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      windowsHide: true,
    })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c: string) => { output += c })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c: string) => { output += c })
    child.on('error', (error) => reject(new Error(`npm not available: ${error.message}`)))
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`npm install exited ${code}\n${output.trim()}`))
      else {
        const version = bundledVersion(ctx)
        if (version !== undefined) {
          try { writeFileSync(join(ctx.harnessRoot, 'VERSION'), `${version}\n`) } catch { /* non-fatal */ }
        }
        resolve(version ?? 'unknown')
      }
    })
  })
}

/** Apply the update (already confirmed) and restart the harness child. */
export async function applyUpdate(ctx: UpdaterContext): Promise<string> {
  const version = await runNpmUpdate(ctx)
  await ctx.restart()
  return version
}

/** Check, then prompt via a native dialog; on confirm apply + restart (harness) or open the download page (shell). */
export async function checkAndPrompt(ctx: UpdaterContext, window: BaseWindow | undefined): Promise<void> {
  const show = (options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> =>
    window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)

  // Check shell (GitHub) and harness (npm) independently — one network failure
  // shouldn't hide the other's result.
  const [shellRes, harnessRes] = await Promise.allSettled([
    checkForShellUpdate(ctx),
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
      detail: `当前 ${harnessStatus.current ?? '未安装'} → 最新 ${harnessStatus.latest}\n（外壳 v${ctx.shellVersion}）`,
      buttons: ['更新', '稍后'],
      defaultId: 0,
      cancelId: 1,
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
  const notify = (title: string, body: string, onClick: () => void): void => {
    if (Notification.isSupported()) {
      const n = new Notification({ title, body })
      n.on('click', onClick)
      n.show()
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
        void checkAndPrompt(ctx, undefined)
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
