/**
 * version.mjs — derive the shell version as `<dsh-major.minor.patch>-dev.<count>`
 * from the bundled harness version plus a dev counter, and write it to
 * package.json. `--bump` increments the counter first.
 *
 * The harness version lives in resources/harness/VERSION (e.g. "0.1.0-rc.6");
 * we take its major.minor.patch and append a `-dev.<count>` prerelease
 * (e.g. "0.1.0-dev.3"). The prerelease form — not a 4th dot component like
 * "0.1.0.3" — is required because electron-builder validates `version` with
 * `semver.valid(..., { loose: true })` and rejects a non-SemVer string
 * (`Invalid version: "0.1.0.3"`). `-dev.N` is valid, ordered (0.1.0-dev.3 <
 * 0.1.0-dev.4), and still encodes "the dsh 0.1.0 line, dev iteration N".
 *
 * Usage:
 *   node scripts/version.mjs          # re-derive the dsh base, keep the count
 *   node scripts/version.mjs --bump   # +1 the dev count, then set
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(new URL('.', import.meta.url)))
const pkgPath = join(ROOT, 'package.json')
const lockPath = join(ROOT, 'package-lock.json')
const versionPath = join(ROOT, 'resources', 'harness', 'VERSION')

const bump = process.argv.includes('--bump')

// "0.1.0-rc.6" -> "0.1.0" (drop any prerelease suffix)
const base = readFileSync(versionPath, 'utf8').trim().split('-')[0]
if (!/^\d+\.\d+\.\d+$/.test(base)) {
  console.error(`[version] harness VERSION "${base}" is not a semver-like major.minor.patch; aborting`)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const current = String(pkg.version ?? '0.0.0')
const prefix = `${base}-dev.`
let count = 0
if (current.startsWith(prefix)) count = Number.parseInt(current.slice(prefix.length), 10) || 0
if (bump) count += 1

const version = `${prefix}${count}`

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
