/**
 * prune-harness.mjs — strip dead weight from resources/harness/node_modules
 * before packaging. The harness runtime is installed as a plain npm dependency
 * tree, which ships a lot that never runs at runtime: source maps (.map),
 * TypeScript sources/types (.ts/.mts/.cts/.tsx), type stubs (@types), and
 * native prebuilds for platforms we don't ship (node-pty's win32-arm64,
 * darwin-*, plus its build/deps C sources).
 *
 * Removing these shrinks the installer AND, more importantly, cuts ~9k files —
 * NSIS install time is dominated by creating tens of thousands of small
 * node_modules files, so fewer files installs noticeably faster.
 *
 * Idempotent: safe to run again (missing paths are skipped).
 * Usage: node scripts/prune-harness.mjs
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(new URL('.', import.meta.url)))
const NM = join(ROOT, 'resources', 'harness', 'node_modules')

// Compile-time-only extensions. `.ts` also matches `.d.ts` (extension is `.ts`).
const TS_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.map'])

let removedFiles = 0
let removedBytes = 0

function sizeOf(p) {
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}

function rm(p) {
  if (!existsSync(p)) return
  const bytes = sizeOf(p)
  removedBytes += bytes
  try {
    rmSync(p, { recursive: true, force: true })
  } catch (error) {
    console.warn(`[prune] failed to remove ${p}: ${error.message}`)
    return
  }
  removedFiles += 1
  if (process.env.DSH_PRUN_VERBOSE) console.log(`[prune] - ${p}`)
}

/** Recursively remove compile-time-only files under a directory. */
function walk(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(p)
    } else if (TS_EXT.has(extnameLower(entry.name))) {
      rm(p)
    }
  }
}

function extnameLower(name) {
  const i = name.lastIndexOf('.')
  return i === -1 ? '' : name.slice(i).toLowerCase()
}

export function pruneHarness() {
  if (!existsSync(NM)) {
    console.warn('[prune] harness node_modules missing — run prepare-harness first')
    return
  }

  // 1. Type stubs — never required at runtime.
  rm(join(NM, '@types'))

  // 2. node-pty: keep only the x64 Windows native prebuilds; drop every other
  //    platform plus the build-time C sources.
  const nodePty = join(NM, 'node-pty')
  if (existsSync(nodePty)) {
    const prebuilds = join(nodePty, 'prebuilds')
    if (existsSync(prebuilds)) {
      for (const dir of readdirSync(prebuilds)) {
        if (dir !== 'win32-x64') rm(join(prebuilds, dir))
      }
    }
    for (const dir of ['deps', 'build', 'src', 'scripts']) rm(join(nodePty, dir))
    // ConPTY binaries ship one OpenConsole per arch; keep only win10-x64.
    const conpty = join(nodePty, 'third_party', 'conpty')
    if (existsSync(conpty)) {
      for (const version of readdirSync(conpty)) {
        const vDir = join(conpty, version)
        if (!statSync(vDir).isDirectory()) continue
        for (const arch of readdirSync(vDir)) {
          if (arch !== 'win10-x64') rm(join(vDir, arch))
        }
      }
    }
  }

  // 3. Source maps + TS sources/types across the whole tree.
  walk(NM)

  console.log(
    `[prune] removed ${removedFiles} files / ${(removedBytes / 1048576).toFixed(1)} MB from harness runtime`,
  )
}

// CLI entry
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  pruneHarness()
}
