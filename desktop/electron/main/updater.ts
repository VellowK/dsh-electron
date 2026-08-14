/**
 * Simple version check updater. No silent auto-install: it compares the
 * bundled harness version against the npm "latest", surfaces a prompt, and only
 * on explicit confirmation swaps `@deepseek-ai/dsh` in place (mirroring
 * scripts/prepare-harness.mjs) and restarts the harness child.
 *
 * Versions compared: the *harness runtime* (`@deepseek-ai/dsh`), not the
 * Electron shell. The shell's own version is surfaced for context.
 */

import { BrowserWindow, dialog, ipcMain, Notification } from 'electron'
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

const PNPM_VERSION = 'pnpm@11.7.0'

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

/** Check, then prompt via a native dialog; on confirm apply + restart. */
export async function checkAndPrompt(ctx: UpdaterContext, window: BrowserWindow | undefined): Promise<void> {
  let status: UpdateStatus
  try {
    status = await checkForUpdate(ctx)
  } catch (error) {
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      title: '检查更新',
      message: '检查更新失败',
      detail: error instanceof Error ? error.message : String(error),
    }
    if (window && !window.isDestroyed()) void dialog.showMessageBox(window, options)
    else void dialog.showMessageBox(options)
    return
  }

  if (!status.hasUpdate) {
    const options: Electron.MessageBoxOptions = {
      type: 'info',
      title: '检查更新',
      message: '已是最新版本',
      detail: `harness ${status.current ?? '未安装'}（外壳 v${ctx.shellVersion}）`,
    }
    if (window && !window.isDestroyed()) void dialog.showMessageBox(window, options)
    else void dialog.showMessageBox(options)
    return
  }

  const options: Electron.MessageBoxOptions = {
    type: 'info',
    title: '发现新版本',
    message: `harness 有新版本可用：${status.latest}`,
    detail: `当前 ${status.current ?? '未安装'} → 最新 ${status.latest}\n（外壳 v${ctx.shellVersion}）`,
    buttons: ['更新', '稍后'],
    defaultId: 0,
    cancelId: 1,
  }
  const choice = window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
  if (choice.response !== 0) return

  try {
    const version = await applyUpdate(ctx)
    const done: Electron.MessageBoxOptions = {
      type: 'info',
      title: '更新完成',
      message: `已更新到 harness ${version}`,
      detail: 'harness 已重启。',
    }
    if (window && !window.isDestroyed()) void dialog.showMessageBox(window, done)
    else void dialog.showMessageBox(done)
  } catch (error) {
    const failed: Electron.MessageBoxOptions = {
      type: 'error',
      title: '更新失败',
      message: '更新 harness 失败',
      detail: error instanceof Error ? error.message : String(error),
      buttons: ['打开下载页', '关闭'],
      defaultId: 1,
      cancelId: 1,
    }
    const fallback = window && !window.isDestroyed() ? await dialog.showMessageBox(window, failed) : await dialog.showMessageBox(failed)
    if (fallback.response === 0) {
      void import('electron').then(({ shell }) => {
        shell.openExternal('https://www.npmjs.com/package/@deepseek-ai/dsh')
      })
    }
  }
}

/** Background startup check: non-blocking, surfaces a system notification only. */
export function backgroundCheck(ctx: UpdaterContext): void {
  checkForUpdate(ctx)
    .then((status) => {
      if (!status.hasUpdate) return
      if (Notification.isSupported()) {
        const n = new Notification({
          title: 'harness 有新版本',
          body: `${status.current ?? '?'} → ${status.latest}`,
        })
        n.on('click', () => { void checkAndPrompt(ctx, undefined) })
        n.show()
      } else {
        console.log(`[updater] update available: ${status.current} → ${status.latest}`)
      }
    })
    .catch((error) => console.log(`[updater] background check failed: ${error instanceof Error ? error.message : error}`))
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
