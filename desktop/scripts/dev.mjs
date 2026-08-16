/**
 * dev.mjs — dev entrypoint: ensure the harness runtime is prepared, compile
 * the TypeScript main/preload, then launch Electron pointed at this app.
 *
 * Usage: node scripts/dev.mjs
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureHarness } from './prepare-harness.mjs'

const ROOT = dirname(fileURLToPath(new URL('.', import.meta.url)))
const HARNESS_BIN = join(ROOT, 'resources', 'harness', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

function log(prefix, message) {
  console.log(`\x1b[36m[dev]\x1b[0m ${prefix} ${message}`)
}

// 1. Make sure the harness runtime exists (installs @deepseek-ai/dsh + pnpm if
//    missing). If it's already at the pinned version this is a no-op.
if (!existsSync(HARNESS_BIN)) {
  log('preparing harness runtime…')
  ensureHarness()
} else {
  log(`harness present: ${HARNESS_BIN}`)
}

// 2. Compile electron/main + electron/preload → dist/.
log('compiling TypeScript…')
execFileSync('node', [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(ROOT, 'tsconfig.json')], {
  cwd: ROOT,
  stdio: 'inherit',
})

// 3. Launch Electron. npm's electron bin is a Node script that resolves the
//    real electron.exe and spawns it.
log('launching Electron…')
const electronBin = join(ROOT, 'node_modules', 'electron', 'cli.js')
// Strip ELECTRON_RUN_AS_NODE: if it leaks into the shell process, Electron
// boots as plain Node and require('electron') returns the npm package's path
// string instead of the API. Only the harness *child* should ever see it.
const launchEnv = { ...process.env }
delete launchEnv.ELECTRON_RUN_AS_NODE
const child = spawn(process.execPath, [electronBin, ROOT], {
  cwd: ROOT,
  stdio: 'inherit',
  env: launchEnv,
})
child.on('exit', (code) => {
  process.exit(code ?? 0)
})
