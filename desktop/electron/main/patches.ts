/**
 * patches.ts — runtime patches applied to the bundled harness (which lives
 * outside the asar and is swapped in place by the updater) so it behaves
 * correctly inside the Electron shell. Applied idempotently before every spawn,
 * so a patch survives an `npm install`-driven harness update.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The harness's Windows "open text document" path uses `Invoke-Item`, which
 * respects the file-type association. An unassociated `.yaml` therefore pops
 * the "open with" picker instead of opening the file, so the settings
 * "打开配置文件" button looks broken. Mirror the macOS `open -t` behaviour and
 * open text documents in Notepad on Windows instead.
 */
export function applyHarnessPatches(harnessRoot: string): void {
  const target = join(
    harnessRoot,
    'node_modules', '@deepseek-ai', 'dsh-host-apiproxy', 'lib', 'index.js',
  )
  if (!existsSync(target)) {
    console.warn('[patches] apiproxy bundle missing — skipping opener patch')
    return
  }
  let src = readFileSync(target, 'utf8')
  if (src.includes('Start-Process notepad.exe')) return // already patched

  // Anchor on the unique win32 dispatch line inside openNativePathWithIntent.
  const needle = /([ \t]*)await openWindowsPath\(path, signal, run\);/
  if (!needle.test(src)) {
    console.warn('[patches] openWindowsPath anchor not found — harness layout changed?')
    return
  }
  src = src.replace(needle, (match, indent: string) => [
    `${indent}if (intent === "text-editor") {`,
    `${indent}\tawait run("powershell.exe", [`,
    `${indent}\t\t"-NoProfile",`,
    `${indent}\t\t"-Command",`,
    `${indent}\t\t\`Start-Process notepad.exe -ArgumentList \${powershellLiteral(path)}\``,
    `${indent}\t], signal);`,
    `${indent}\treturn;`,
    `${indent}}`,
    `${indent}await openWindowsPath(path, signal, run);`,
  ].join('\n'))
  writeFileSync(target, src)
  console.log('[patches] Windows text-document opener → notepad (Start-Process)')
}
