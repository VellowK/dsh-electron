/**
 * Plugin management: list installed plugins from the web profile manifest,
 * search the npm registry, and run `dsh plugin --profile web <add|remove|update>`
 * (a thin pnpm forwarder) with the bundled pnpm on PATH. The harness child is
 * restarted after a change so the new layer stack loads.
 *
 * The harness exposes plugin *inventory* (loaded entries) as a Typert Remote,
 * not an `/api` RPC — so "what is installed" is read straight from the profile
 * directory the `dsh plugin` CLI itself reconciles:
 *   `<DSH_HOME>/profiles/web/package.json`
 *     .dependencies           → installed plugins (name → version)
 *     .dsh.profile.bundles    → bundle layers (template + user bundles)
 * A dependency listed in `bundles` is a bundle (auto-activated); anything else
 * is a plain dependency the loader does not auto-mount.
 */

import { ipcMain } from 'electron'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { Readable } from 'node:stream'

export interface PluginContext {
  /** `@deepseek-ai/dsh/lib/bin.js` — the CLI we drive. */
  binPath: string
  /** `$DSH_HOME` (profiles live under `<dshHome>/profiles/web`). */
  dshHome: string
  /** Working directory the plugin command runs from (anchors relative specs). */
  workspace: string
  /** Directory holding the bundled pnpm shim (`.bin`). */
  pnpmBinDir: string
  /** Restart the harness child and resolve to its new readiness URL. */
  restart: () => Promise<string>
}

export interface InstalledPlugin {
  name: string
  version: string
  /** True when the package is a `dsh.bundle` layer (in `dsh.profile.bundles`). */
  isBundle: boolean
}

export interface SearchResult {
  name: string
  version: string
  description: string
}

interface ProfileManifest {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

const PROFILE = 'web'

function profileDir(ctx: PluginContext): string {
  return join(ctx.dshHome, 'profiles', PROFILE)
}

function readProfile(ctx: PluginContext): ProfileManifest {
  const path = join(profileDir(ctx), 'package.json')
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ProfileManifest
  } catch {
    return {}
  }
}

/** Installed plugins from the profile manifest, plus the raw bundle list. */
export function listInstalled(ctx: PluginContext): { installed: InstalledPlugin[]; bundles: string[] } {
  const manifest = readProfile(ctx)
  const dependencies = manifest.dependencies ?? {}
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const installed = Object.entries(dependencies)
    .map(([name, version]) => ({ name, version, isBundle: bundles.includes(name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return { installed, bundles }
}

function registryBase(): string {
  // Allow a mirror (npmmirror) via env, consistent with scripts/prepare-harness.mjs.
  return (process.env.DSH_NPM_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/+$/, '')
}

/** Search the npm registry for installable plugins. */
export async function searchPlugins(ctx: PluginContext, query: string): Promise<SearchResult[]> {
  const q = query.trim() === '' ? '@deepseek-ai/dsh-' : query.trim()
  const url = `${registryBase()}/-/v1/search?text=${encodeURIComponent(q)}&size=20`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`registry search HTTP ${response.status}`)
  const data = (await response.json()) as {
    objects?: Array<{ package?: { name?: string; version?: string; description?: string } }>
  }
  return (data.objects ?? [])
    .map((o) => ({
      name: o.package?.name ?? '',
      version: o.package?.version ?? '',
      description: o.package?.description ?? '',
    }))
    .filter((o) => o.name !== '')
}

/** A completed `dsh plugin` invocation. */
export interface PluginCommandResult {
  code: number
  output: string
}

/** Run one `dsh plugin --profile web <args...>` command; resolve on exit. */
export function runPluginCommand(ctx: PluginContext, args: string[]): Promise<PluginCommandResult> {
  return new Promise((resolve) => {
    const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
      process.execPath,
      ['--expose-internals', ctx.binPath, 'plugin', '--profile', PROFILE, ...args],
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          DSH_HOME: ctx.dshHome,
          // pnpm resolves through its .cmd shim (shell:true in the CLI) — put the
          // bundled pnpm first so a user without a system pnpm can still manage plugins.
          PATH: `${ctx.pnpmBinDir}${delimiter}${process.env.PATH ?? ''}`,
        },
        cwd: ctx.workspace,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )

    const chunks: string[] = []
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c: string) => chunks.push(c))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c: string) => chunks.push(c))
    child.on('error', (error) => {
      chunks.push(`\n[spawn error] ${error.message}\n`)
      resolve({ code: 1, output: chunks.join('') })
    })
    child.on('close', (code) => {
      resolve({ code: code ?? 1, output: chunks.join('') })
    })
  })
}

/** Register the plugin-management IPC surface and return a disposer. */
export function registerPlugins(ctx: PluginContext): () => void {
  ipcMain.handle('plugins:list', () => listInstalled(ctx))
  ipcMain.handle('plugins:search', (_event, query: string) => searchPlugins(ctx, query))
  ipcMain.handle('plugins:install', async (_event, pkg: string) => {
    const run = await runPluginCommand(ctx, ['add', pkg])
    return { ...run, restarted: run.code === 0 ? await ctx.restart() : undefined }
  })
  ipcMain.handle('plugins:uninstall', async (_event, pkg: string) => {
    const run = await runPluginCommand(ctx, ['remove', pkg])
    return { ...run, restarted: run.code === 0 ? await ctx.restart() : undefined }
  })
  ipcMain.handle('plugins:update', async (_event, pkg: string) => {
    // `pnpm update <pkg>` in-place; `--latest` skips the profile's saved ranges.
    const run = await runPluginCommand(ctx, ['update', pkg, '--latest'])
    return { ...run, restarted: run.code === 0 ? await ctx.restart() : undefined }
  })

  return () => {
    for (const channel of ['plugins:list', 'plugins:search', 'plugins:install', 'plugins:uninstall', 'plugins:update']) {
      ipcMain.removeHandler(channel)
    }
  }
}
