// Electron main for test/unit/app.cookie-runtime.electron.test.ts: hashes a folder (argv[2]) that holds a `.asar` file with
// hashTree, once with Electron's `original-fs` (what app/main/cookie-runtime-main.ts passes) and once with the default
// `node:fs` (which treats `.asar` as a folder), and writes both outcomes as JSON to argv[3].
//
//   electron cookie-runtime-hash.electron.mjs <folder> <out json path>
import { app } from 'electron'
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { hashTree } from '../../../app/shared/cookie-runtime.ts'

const [dir, outPath] = process.argv.slice(2)
const attempt = fs => { try { return { files: hashTree(dir, fs) } } catch (e) { return { error: e instanceof Error ? e.message : String(e) } } }
const originalFs = createRequire(import.meta.url)('original-fs')
writeFileSync(outPath, JSON.stringify({ electron: process.versions.electron, original: attempt(originalFs), shim: attempt(undefined) }))
app.exit(0)
