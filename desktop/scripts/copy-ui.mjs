/**
 * copy-ui.mjs — copy the static plugin-manager UI into dist/ui/. tsc only
 * compiles TS/CTS to JS, so plain .html/.css/.js assets must be copied by hand.
 */

import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(new URL('.', import.meta.url)))
const src = join(ROOT, 'electron', 'ui')
const dest = join(ROOT, 'dist', 'ui')

mkdirSync(dest, { recursive: true })
cpSync(src, dest, { recursive: true })
console.log(`[copy-ui] ${src} -> ${dest}`)
