/**
 * version.mjs — derive the shell version as `<harness-major>.<harness-minor>.<iteration>`
 * from the bundled harness version plus a monotonic release counter, and write it
 * to package.json. `--bump` increments the counter first.
 *
 * The harness version lives in resources/harness/VERSION (e.g. "0.1.0-rc.6"); we
 * take its major.minor ("0.1") as the shell's version prefix, and put the shell's
 * own release counter in the patch slot ("0.1.0", "0.1.1", "0.1.2", …). This keeps
 * the shell's "front" version aligned to the harness minor line while the last
 * number counts shell iterations — no `-dev` prerelease, so GitHub's "Latest
 * release" badge and standard SemVer comparison both work out of the box.
 *
 * Why the counter lives in the patch slot: electron-builder validates `version`
 * with `semver.valid(..., { loose: true })`, so a 4th numeric component like
 * "0.1.0.3" is rejected and `+003` build metadata is ignored by comparison (can't
 * bump). That leaves exactly three numeric components, and the last one is the
 * shell's iteration counter.
 *
 * Usage:
 *   node scripts/version.mjs          # re-derive the harness prefix, keep the counter
 *   node scripts/version.mjs --bump   # +1 the iteration counter, then set
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(new URL('.', import.meta.url)))
const pkgPath = join(ROOT, 'package.json')
const lockPath = join(ROOT, 'package-lock.json')
const versionPath = join(ROOT, 'resources', 'harness', 'VERSION')

const bump = process.argv.includes('--bump')

// "0.1.0-rc.6" -> "0.1" (major.minor, dropping the harness's own patch)
const base = readFileSync(versionPath, 'utf8').trim().split('-')[0]
const m = /^(\d+)\.(\d+)\.\d+$/.exec(base)
if (!m) {
  console.error(`[version] harness VERSION "${base}" is not a semver-like major.minor.patch; aborting`)
  process.exit(1)
}
const prefix = `${m[1]}.${m[2]}.`

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const current = String(pkg.version ?? '0.0.0')
let iteration = 0
if (current.startsWith(prefix)) {
  const tail = current.slice(prefix.length)
  if (/^\d+$/.test(tail)) iteration = Number.parseInt(tail, 10)
}
if (bump) iteration += 1

const version = `${prefix}${iteration}`

// Keep package-lock.json's top-level version in sync — `npm ci` compares it
// against package.json and errors on a mismatch. Runs even on the "unchanged"
// path so a previously-drifted lock is repaired, not just future bumps.
try {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  if (lock.version !== version) {
    lock.version = version
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n')
    console.log(`[version] package-lock.json -> ${version}`)
  }
} catch {
  // No lock file (never installed) — nothing to sync.
}

if (version === current && !bump) {
  console.log(`[version] unchanged: ${current}`)
  process.exit(0)
}
pkg.version = version
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log(`[version] ${current} -> ${version}${bump ? ' (bumped)' : ''}`)
console.log(`[version] tag: v${version}`)
