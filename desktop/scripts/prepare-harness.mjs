/**
 * prepare-harness.mjs — install (or update) the DeepSeek Harness runtime into
 * resources/harness/ as a standalone, updatable node_modules. This is NOT an
 * npm dependency of the app: it lives outside the asar (electron-builder
 * extraResources) so the "simple version check" updater can swap it in place.
 *
 * Usage: node scripts/prepare-harness.mjs [@deepseek-ai/dsh@<version>]
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(new URL('.', import.meta.url)))
const HARNESS_DIR = join(ROOT, 'resources', 'harness')

// The pinned harness core. Bump here to roll the bundled harness forward; the
// updater compares this against the npm "latest" at runtime.
const DEFAULT_DSH_VERSION = '@deepseek-ai/dsh@0.1.0-rc.6'
const PNPM_VERSION = 'pnpm@11.7.0'

/** Optional registry override, e.g. DSH_NPM_REGISTRY=https://registry.npmmirror.com */
const REGISTRY = process.env.DSH_NPM_REGISTRY

function npm(args, cwd = HARNESS_DIR) {
  const argv = ['install', '--no-audit', '--no-fund', '--no-save']
  if (REGISTRY) argv.push('--registry', REGISTRY)
  argv.push(...args)
  // On Windows `npm` is npm.cmd; execSync resolves it through cmd.exe (unlike
  // execFileSync which can only spawn true executables).
  const cmd = ['npm', ...argv.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' ')
  execSync(cmd, { cwd, stdio: 'inherit' })
}

function installedDshVersion() {
  const manifestPath = join(HARNESS_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  if (!existsSync(manifestPath)) return undefined
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8')).version
  } catch {
    return undefined
  }
}

export function ensureHarness(pinned = DEFAULT_DSH_VERSION) {
  mkdirSync(HARNESS_DIR, { recursive: true })
  const manifestPath = join(HARNESS_DIR, 'package.json')
  if (!existsSync(manifestPath)) {
    writeFileSync(manifestPath, JSON.stringify({ name: 'dsh-harness-runtime', private: true }, null, 2) + '\n')
  }

  const pinnedName = pinned.replace(/^.*@/, '') // strip scope marker, keep package@ver
  const want = pinnedName // e.g. 0.1.0-rc.6
  const have = installedDshVersion()
  if (have === want) {
    console.log(`prepare-harness: harness already at ${pinned} — skipping`)
    return have
  }

  console.log(`prepare-harness: installing ${pinned} + ${PNPM_VERSION} into ${HARNESS_DIR}`)
  console.log(`  (had ${have ?? 'nothing'})`)
  npm([pinned, PNPM_VERSION])
  const version = installedDshVersion()
  writeFileSync(join(HARNESS_DIR, 'VERSION'), `${version}\n`)
  console.log(`prepare-harness: done, harness version = ${version}`)
  return version
}

// CLI entry: `node scripts/prepare-harness.mjs [version]`
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  ensureHarness(process.argv[2] ?? DEFAULT_DSH_VERSION)
}
