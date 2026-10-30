// Screenshots of the visual spec (docs/tether-preview.html) in both schemes, to review next to the app's
// chrome-cards-{light,dark}.png (app.chrome.test.ts): `node test/e2e/preview-shot.ts [outDir]`
// (default test/e2e/artifacts). Runs Electron on preview-main.cjs and waits for it to exit.
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const electronPath = require('electron') as string
const out = resolve(process.argv[2] ?? join(import.meta.dirname, 'artifacts'))
mkdirSync(out, { recursive: true })
const env: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_')) env[k] = v
const r = spawnSync(electronPath, [join(import.meta.dirname, 'preview-main.cjs'), out], { stdio: 'inherit', env, timeout: 60_000 })
if (r.status !== 0) { console.error(`preview-shot: electron exited with ${r.status ?? r.signal}`); process.exit(1) }
console.log(`preview-shot: ${join(out, 'preview-light.png')}, ${join(out, 'preview-dark.png')}`)
