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
function applyOpenerPatch(harnessRoot: string): void {
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

/**
 * The harness's Win32 folder picker (`Select Workspace Directory`) drives
 * IFileOpenDialog through a koffi FFI worker spawned via `process.execPath`.
 * Under Electron-as-Node that worker crashes in the packaged app with
 * `FATAL ERROR: Error::New napi_get_last_error_info`, so the pick rejects
 * with "win32 folder dialog worker exited before reporting a result".
 * Replace the win32 branch with a PowerShell FolderBrowserDialog driven
 * through the same `run` (execFile) helper the Linux zenity branch uses —
 * no koffi, no child worker, and it blocks until the user picks (cancels → null).
 */
function applyDirectoryPickerPatch(harnessRoot: string): void {
  const target = join(
    harnessRoot,
    'node_modules', '@deepseek-ai', 'dsh-host-directory-picker-native', 'lib', 'index.js',
  )
  if (!existsSync(target)) {
    console.warn('[patches] directory-picker bundle missing — skipping picker patch')
    return
  }
  let src = readFileSync(target, 'utf8')
  // Newest patch already applied? (UTF-8 stdout so non-ASCII folder names survive)
  if (src.includes('[Console]::OutputEncoding')) return

  // Upgrade a pre-encoding-fix patch in place: prepend the UTF-8 console
  // encoding line to the PowerShell script string, keeping the rest.
  const oldScriptStart = 'const script = "Add-Type -AssemblyName System.Windows.Forms;'
  if (src.includes(oldScriptStart)) {
    src = src.replace(
      oldScriptStart,
      'const script = "Add-Type -AssemblyName System.Windows.Forms; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
    )
    writeFileSync(target, src)
    console.log('[patches] Win32 folder picker → added UTF-8 stdout encoding')
    return
  }

  const needle = /([ \t]*)if \(platform === "win32"\) return await \(internals\.pickWin32Dialog \?\? pickWin32Directory\)\(signal\);/
  if (!needle.test(src)) {
    console.warn('[patches] win32 directory-picker anchor not found — harness layout changed?')
    return
  }
  src = src.replace(needle, (match, indent: string) => [
    `${indent}if (platform === "win32") {`,
    `${indent}\tconst script = "Add-Type -AssemblyName System.Windows.Forms; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $o = New-Object System.Windows.Forms.Form; $o.TopMost = $true; $o.ShowInTaskbar = $false; $o.Opacity = 0; $o.Show(); $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Select Workspace Directory'; $d.ShowNewFolderButton = $true; $r = $d.ShowDialog($o); $o.Close(); if ($r -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }";`,
    `${indent}\treturn outputPath((await run("powershell.exe", ["-NoProfile", "-Command", script], signal)).stdout);`,
    `${indent}}`,
  ].join('\n'))
  writeFileSync(target, src)
  console.log('[patches] Win32 folder picker → PowerShell FolderBrowserDialog (UTF-8)')
}

/**
 * Bundle the dsh-market plugin (`dshmarket`) as an in-box web-profile layer and
 * disable its detached self-restart. The market's own "restart" relaunches the
 * exact DSH entry via `process.execPath` — under Electron-as-Node that spawns a
 * headless electron process and orphans the shell's window, so the shell owns
 * restarts instead (see the "重启服务" menu item). In-box bundling (present in
 * the harness node_modules + listed in the profile template) means a fresh
 * profile mounts the market with no first-run network install.
 */
function applyMarketBundlePatch(harnessRoot: string): void {
  // (a) Add dshmarket to the shipped web profile template.
  const bootTarget = join(
    harnessRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js',
  )
  if (existsSync(bootTarget)) {
    let bootSrc = readFileSync(bootTarget, 'utf8')
    let changed = false

    // Fresh-profile path: PROFILE_TEMPLATES.web gains the market bundle.
    const templateNeedle = 'web: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],'
    if (!bootSrc.includes('"dshmarket"')) {
      if (bootSrc.includes(templateNeedle)) {
        bootSrc = bootSrc.replace(
          templateNeedle,
          'web: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dshmarket"],',
        )
        console.log('[patches] web profile template → + dshmarket bundle')
        changed = true
      } else {
        console.warn('[patches] web profile template anchor not found — harness layout changed?')
      }
    }

    // Existing-profile path: mark the pre-market [base, web-app] tuple as
    // installation-owned so normalizeShippedProfile rewrites a profile created
    // before the market was bundled to the new template on next boot.
    const tupleNeedle = 'const INSTALLATION_OWNED_PROFILE_TUPLES = { headless: [\n\t"@deepseek-ai/dsh-base",\n\t"@deepseek-ai/dsh-web-app",\n\t"@deepseek-ai/dsh-headless"\n] };'
    if (!bootSrc.includes('], web: [')) {
      if (bootSrc.includes(tupleNeedle)) {
        bootSrc = bootSrc.replace(
          tupleNeedle,
          'const INSTALLATION_OWNED_PROFILE_TUPLES = { headless: [\n\t"@deepseek-ai/dsh-base",\n\t"@deepseek-ai/dsh-web-app",\n\t"@deepseek-ai/dsh-headless"\n], web: [\n\t"@deepseek-ai/dsh-base",\n\t"@deepseek-ai/dsh-web-app"\n] };',
        )
        console.log('[patches] web profile upgrade tuple → existing profiles gain dshmarket')
        changed = true
      } else {
        console.warn('[patches] installation-owned tuple anchor not found — harness layout changed?')
      }
    }

    if (changed) writeFileSync(bootTarget, bootSrc)
  } else {
    console.warn('[patches] app-boot bundle missing — skipping market template patch')
  }

  // (b) Disable the market's detached self-restart.
  const marketPatch = join(harnessRoot, 'node_modules', 'dshmarket', 'cordis.patch.yml')
  if (!existsSync(marketPatch)) {
    console.warn('[patches] dshmarket bundle missing — skipping allowRestart patch')
    return
  }
  let marketSrc = readFileSync(marketPatch, 'utf8')
  if (!marketSrc.includes('allowRestart')) {
    const entryNeedle = "      name: 'dshmarket'\n"
    if (!marketSrc.includes(entryNeedle)) {
      console.warn('[patches] dshmarket insert entry anchor not found — market layout changed?')
    } else {
      marketSrc = marketSrc.replace(
        entryNeedle,
        "      name: 'dshmarket'\n      config:\n        allowRestart: false\n",
      )
      writeFileSync(marketPatch, marketSrc)
      console.log('[patches] dshmarket → allowRestart: false (shell owns restart)')
    }
  }
}

/**
 * Register dshmarket in the installation's dependency closure so the profile
 * module fallback (`$DSH_HOME/profiles/node_modules`, healed on boot by
 * `healProfilesModuleFallback(INSTALL_ANCHOR)`) symlinks it. The web profile's
 * loader `baseUrl` is the profile directory, and in-box plugin bare specifiers
 * resolve only through that parent-walk farm — so a bundle merely present in
 * `resources/harness/node_modules` (and listed in the profile template) is not
 * enough; it must also be a dependency key of `@deepseek-ai/dsh` (the install
 * anchor) for the fallback to link it. Without this the market entry fails
 * with `ERR_MODULE_NOT_FOUND: Cannot find package 'dshmarket' imported from
 * .../profiles/web/`.
 */
function applyMarketClosurePatch(harnessRoot: string): void {
  const dshPkg = join(harnessRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const marketPkg = join(harnessRoot, 'node_modules', 'dshmarket', 'package.json')
  if (!existsSync(dshPkg) || !existsSync(marketPkg)) {
    console.warn('[patches] dsh or dshmarket package.json missing — skipping module-fallback closure patch')
    return
  }
  const manifest = JSON.parse(readFileSync(dshPkg, 'utf8'))
  const marketVersion = JSON.parse(readFileSync(marketPkg, 'utf8')).version ?? '1.10.0'
  const deps = (manifest.dependencies ??= {}) as Record<string, string>
  if (deps.dshmarket !== undefined) return // already registered
  deps.dshmarket = marketVersion
  writeFileSync(dshPkg, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`[patches] dsh installation → depends on dshmarket@${marketVersion} (module fallback)`)
}

/**
 * Deep-link into the settings dialog: read `#settings/<section-id>` from the
 * URL hash so the shell's "插件市场" menu can open the market section directly.
 * The settings shell keeps open state in component-local React state with no
 * external hook, so we inject a tiny hash listener into the compiled
 * SettingsRoot. The section id may register after mount; the panel re-derives
 * its active section from `activeId` + the ledger, so an early call self-corrects.
 */
function applySettingsDeepLinkPatch(harnessRoot: string): void {
  const target = join(
    harnessRoot, 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings-general', 'lib', 'client.js',
  )
  if (!existsSync(target)) {
    console.warn('[patches] settings-general client bundle missing — skipping deep-link patch')
    return
  }
  let src = readFileSync(target, 'utf8')
  if (src.includes('applyHash')) return

  const needle = "const openSection = (0, react.useCallback)((id) => {\n\t\t\t\tsetActiveId(id);\n\t\t\t\tsetOpen(true);\n\t\t\t}, []);"
  if (!src.includes(needle)) {
    console.warn('[patches] SettingsRoot openSection anchor not found — harness layout changed?')
    return
  }
  src = src.replace(needle, [
    needle,
    "\t\t\t(0, react.useEffect)(() => {",
    "\t\t\t\tconst applyHash = () => {",
    "\t\t\t\t\tconst match = /^#settings\\/([A-Za-z0-9_-]+)/.exec(location.hash);",
    "\t\t\t\t\tif (match) openSection(match[1]);",
    "\t\t\t\t};",
    "\t\t\t\tapplyHash();",
    "\t\t\t\twindow.addEventListener(\"hashchange\", applyHash);",
    "\t\t\t\treturn () => window.removeEventListener(\"hashchange\", applyHash);",
    "\t\t\t}, []);",
  ].join('\n'))
  writeFileSync(target, src)
  console.log('[patches] settings shell → #settings/<id> deep-link listener')
}

export function applyHarnessPatches(harnessRoot: string): void {
  applyOpenerPatch(harnessRoot)
  applyDirectoryPickerPatch(harnessRoot)
  applyMarketBundlePatch(harnessRoot)
  applyMarketClosurePatch(harnessRoot)
  applySettingsDeepLinkPatch(harnessRoot)
}
