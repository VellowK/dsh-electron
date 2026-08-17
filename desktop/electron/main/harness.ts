/**
 * HarnessManager — spawns the DeepSeek Harness web server as a child Node
 * process (Electron-as-Node in both dev and prod), watches stdout for the
 * readiness line `dsh web: http://127.0.0.1:PORT`, and owns restart/shutdown.
 *
 * The harness is a plain Node program (`@deepseek-ai/dsh` lib/bin.js); running
 * it with `process.execPath` + `ELECTRON_RUN_AS_NODE=1` reuses Electron's
 * bundled Node so a packaged app needs no external runtime.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter } from 'node:path'
import { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'
import { applyHarnessPatches } from './patches.js'

/** Where the harness runtime lives. */
export interface HarnessPaths {
  /** Absolute path to `@deepseek-ai/dsh/lib/bin.js`. */
  binPath: string
  /** `$DSH_HOME` for the child (profiles, sessions, attachments). */
  dshHome: string
  /** Working directory — also the agent's workspace (sandbox workspaceRoot). */
  workspace: string
  /** Directory holding the pnpm shim (`harness/node_modules/.bin`). */
  pnpmBinDir: string
  /** Root of the harness runtime install (`.../harness`) — the updater's target. */
  harnessRoot: string
}

export type HarnessState = 'stopped' | 'starting' | 'running' | 'stopping'

/** The readiness line printed by the web-app bundle once the server binds. */
const READY_RE = /dsh web: (https?:\/\/\S+)/

const SHUTDOWN_GRACE_MS = 5_000

export class HarnessManager extends EventEmitter {
  private child: ChildProcessByStdio<null, Readable, Readable> | undefined
  private state: HarnessState = 'stopped'
  private stopping = false
  private readyUrl: string | undefined
  private restartDelayMs = 1_000
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  /** Settles a pending `start()` readiness wait (clears its timeout + rejects). */
  private settleStart: { cleanup: () => void; reject: (error: Error) => void } | undefined
  private safeMode = false

  constructor(readonly paths: HarnessPaths) {
    super()
  }

  /** Whether the next spawn boots only the shipped plugins (safe mode). */
  setSafeMode(enabled: boolean): void {
    this.safeMode = enabled
  }

  getState(): HarnessState {
    return this.state
  }

  /** The last readiness URL, or undefined while not running. */
  getUrl(): string | undefined {
    return this.readyUrl
  }

  /** Spawn the harness and wait for (or fail) readiness. */
  async start(): Promise<string> {
    if (this.child !== undefined) return this.readyUrl ?? ''
    if (!existsSync(this.paths.binPath)) {
      throw new Error(`harness bin not found: ${this.paths.binPath}\nRun: npm run prepare:harness`)
    }
    // Re-apply any shell-specific harness patches before (re)spawn — survives
    // `npm install`-driven harness updates that overwrite the patched files.
    applyHarnessPatches(this.paths.harnessRoot)
    this.stopping = false
    this.restartDelayMs = 1_000
    this.set('starting')
    // `--expose-internals` lets the loader reach Node internals without the
    // native `node-addon-require-builtin` addon — the base bundle always mounts
    // the HMR plugin, whose service throws without it. Electron-as-Node honours
    // the flag (verified), so no native build is needed.
    const child = spawn(process.execPath, ['--expose-internals', this.paths.binPath, 'web', '--port', '0', '--host', '127.0.0.1'], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DSH_HOME: this.paths.dshHome,
        DSH_TELEMETRY_DISABLED: '1',
        // Safe mode boots only the shipped web template (patched into
        // dsh-app-boot); user-installed bundles are skipped.
        DSH_SAFE_MODE: this.safeMode ? '1' : '0',
        // The bundled pnpm must be on PATH so in-host plugin installs (the
        // dsh-market plugin) resolve it without a system pnpm.
        PATH: `${this.paths.pnpmBinDir}${delimiter}${process.env.PATH ?? ''}`,
      },
      cwd: this.paths.workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onOutput('stdout', chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.onOutput('stderr', chunk))

    child.on('error', (error) => {
      this.emit('log', 'stderr', `harness spawn error: ${error.message}`)
      // The child never spawned — drop the stale handle so a later restart (or
      // `stop()`) does not try to kill a process that does not exist.
      this.child = undefined
      this.emit('error', error)
    })
    child.on('exit', (code, signal) => {
      this.emit('log', 'stderr', `harness exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`)
      const wasRunning = this.state === 'running' || this.state === 'starting'
      // Settle any pending readiness wait so its timeout cannot fire after the
      // child is gone (which would emit a spurious "did not become ready").
      if (this.settleStart !== undefined) {
        const { cleanup, reject } = this.settleStart
        cleanup()
        reject(new Error(`harness exited before ready (code=${code ?? 'null'} signal=${signal ?? 'null'})`))
      }
      this.child = undefined
      this.readyUrl = undefined
      this.set('stopped')
      if (!this.stopping && wasRunning) this.scheduleRestart()
    })

    return new Promise<string>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      const onReady = (url: string): void => {
        cleanup()
        resolve(url)
      }
      const onError = (error: unknown): void => {
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      const cleanup = (): void => {
        this.off('ready', onReady)
        this.off('error', onError)
        if (timeout !== undefined) clearTimeout(timeout)
        if (this.settleStart === settle) this.settleStart = undefined
      }
      const settle = { cleanup, reject }
      this.settleStart = settle
      timeout = setTimeout(() => {
        cleanup()
        const error = new Error(`harness did not become ready within 120s`)
        // Surface the timeout through the same 'error' channel as a spawn
        // failure, so the shell shows its (single) startup-failure dialog.
        this.emit('error', error)
        reject(error)
      }, 120_000)
      this.once('ready', onReady)
      this.once('error', onError)
    })
  }

  private onOutput(stream: 'stdout' | 'stderr', chunk: string): void {
    const lines = chunk.split(/\r?\n/)
    for (const line of lines) {
      if (line === '') continue
      this.emit('log', stream, line)
      const match = READY_RE.exec(line)
      if (match?.[1] !== undefined && this.state !== 'running') {
        this.readyUrl = match[1]
        this.set('running')
        this.emit('ready', this.readyUrl)
      }
    }
  }

  /** Stop the harness. Tries graceful, falls back to force after the grace window. */
  async stop(): Promise<void> {
    // Settle any in-flight readiness wait (and clear its timeout) so a
    // stop/restart while a spawn is still "starting" cannot fire a spurious
    // timeout error afterwards.
    if (this.settleStart !== undefined) {
      const { cleanup, reject } = this.settleStart
      cleanup()
      reject(new Error('harness stop requested before ready'))
    }
    if (this.child === undefined) {
      this.stopping = true
      return
    }
    this.stopping = true
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    const child = this.child
    this.set('stopping')
    child.kill('SIGTERM') // graceful on POSIX; force on Windows (no deliverable SIGTERM)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, SHUTDOWN_GRACE_MS)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    this.child = undefined
    this.readyUrl = undefined
    this.set('stopped')
  }

  /** Stop, then start again — used after plugin/profile changes. Resolves to the new readiness URL. */
  async restart(): Promise<string> {
    await this.stop()
    return this.start()
  }

  private scheduleRestart(): void {
    if (this.stopping) return
    const delay = this.restartDelayMs
    this.restartDelayMs = Math.min(this.restartDelayMs * 2, 30_000)
    this.emit('log', 'stderr', `harness will restart in ${Math.round(delay / 1000)}s`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      // The failure already surfaced through the 'error' channel (spawn error
      // or the 120s timeout in `start()`), so just log here instead of
      // re-emitting — that re-emission is what stacked the error dialog.
      this.start().catch((error) => this.emit('log', 'stderr', `harness restart failed: ${error instanceof Error ? error.message : String(error)}`))
    }, delay)
  }

  private set(state: HarnessState): void {
    this.state = state
    this.emit('state', state)
  }
}
