// The tiny entry Electron actually starts (copied by app/build.mjs to app/dist/main.cjs; the real main process is
// the bundle next to it, main-app.cjs). A failure to LOAD the app (a missing module, a syntax error in the bundle)
// cannot be caught by a handler inside the bundle itself, so it is caught here: the failure is written to the
// fault registry (kind "load") and rethrown, so Electron still reports it as before. Hand-written on purpose: node
// core modules only, no imports from the app, so it works when everything else is broken. The registry folder is
// resolved with the rule of src/core/paths.ts userDir(): TETHER_USER_DIR, else TETHER_HOME, else ~/.tether.
// The sig is a simplified twin of src/core/faults.ts faultSig (no source maps); the main process folds these lines
// into faults-state.json at its next start (reconcileState).
'use strict'
const BUILD = { version: '@@VERSION@@', commit: '@@COMMIT@@' }

try {
  require('./main-app.cjs')
} catch (e) {
  try { recordLoadFailure(e) } catch { /* the original error is what matters */ }
  throw e
}

function recordLoadFailure(e) {
  const fs = require('node:fs')
  const path = require('node:path')
  const crypto = require('node:crypto')
  const os = require('node:os')
  const env = process.env
  const user = (env.TETHER_USER_DIR || '').trim() || (env.TETHER_HOME || '').trim() || path.join(os.homedir(), '.tether')
  const dir = path.join(user, 'faults')
  const message = e instanceof Error ? e.message : String(e)
  const stack = e instanceof Error ? e.stack || '' : ''
  const frames = []
  for (const line of stack.split('\n')) {
    const m = /^\s*at (?:(.*?) \()?(.*?):\d+:\d+\)?\s*$/.exec(line)
    if (!m) continue
    frames.push(path.basename(m[2].replace(/\\/g, '/')) + ':' + ((m[1] || '<anon>').replace(/^async /, '').replace(/^new /, '')))
    if (frames.length >= 5) break
  }
  const norm = message.slice(0, 500)
    .replace(/(?<=^|[\s'"(\[=])(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s'"`)\]]*/g, '<path>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\d+/g, '<n>').replace(/\s+/g, ' ').trim()
  const sig = crypto.createHash('sha256').update(norm + '\n' + frames.join('\n')).digest('hex')
  const known = (v) => (v && !v.startsWith('@@') ? v : undefined)
  const line = {
    id: crypto.randomUUID(), ts: new Date().toISOString(), proc: 'main', version: known(BUILD.version) || 'unknown',
    ...(known(BUILD.commit) ? { commit: known(BUILD.commit) } : {}),
    kind: 'load', message, stack, sig, context: { launcher: true },
  }
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(path.join(dir, 'faults.jsonl'), JSON.stringify(line) + '\n')
}
