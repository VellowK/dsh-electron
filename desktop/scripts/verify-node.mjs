/**
 * verify-node.mjs — assert that Electron's bundled Node meets the harness
 * requirement (>= 22.19, the harness bin's engine floor). Run under Electron:
 *
 *   electron scripts/verify-node.mjs
 *
 * No Electron API is needed here — the bundled Node version is visible on
 * `process.versions.node`, and `process.exit` ends the app.
 */

const MIN = [22, 19, 0]
const current = process.versions.node.split('.').map(Number)

const ok =
  current[0] > MIN[0] ||
  (current[0] === MIN[0] && current[1] > MIN[1]) ||
  (current[0] === MIN[0] && current[1] === MIN[1] && current[2] >= MIN[2])

console.log(`Electron-as-Node runtime: node ${process.versions.node} (electron ${process.versions.electron})`)
if (!ok) {
  console.error(`FATAL: bundled Node < ${MIN.join('.')} — harness will not run`)
  process.exit(1)
} else {
  console.log('OK: bundled Node meets the harness requirement')
  process.exit(0)
}
