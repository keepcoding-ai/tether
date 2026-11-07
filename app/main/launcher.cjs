// The tiny entry Electron actually starts (copied by app/build.mjs to app/dist/main.cjs; the real main process is
// the bundle next to it, main-app.cjs). A failure to LOAD the app (a missing module, a syntax error in the bundle)
// cannot be caught by a handler inside the bundle itself, so it is caught here: the failure is written to the
// fault registry (kind "load") and rethrown, so Electron still reports it as before. Hand-written on purpose: node
// core modules only, no imports from the app, so it works when everything else is broken. The registry folder is
// resolved with the rule of src/core/paths.ts userDir(): TETHER_USER_DIR, else TETHER_HOME, else ~/.tether.
// The sig is a simplified twin of src/core/faults.ts faultSig (no source maps); the main process folds these lines
// into faults-state.json at its next start (reconcileState). What it writes passes through the same redaction patterns and
// size caps as src/core/faults.ts `record` (the pattern list below is a COPY of REDACTION_PATTERNS there: change both together,
// test/unit/core.faults-redact.test.ts compares them), and a line is skipped when the last one in the file has the same sig
// and is less than 60 s old, so a crash loop at start does not fill the registry.
'use strict'
const BUILD = { version: '@@VERSION@@', commit: '@@COMMIT@@' }

// REDACTION-PATTERNS-BEGIN
const REDACTION_PATTERNS = [
  ['sk-ant-[A-Za-z0-9_-]+', 'g', '[redigido]'],
  ['sk-[A-Za-z0-9_-]{20,}', 'g', '[redigido]'],
  ['gh[pousr]_[A-Za-z0-9]{20,}', 'g', '[redigido]'],
  ['xox[abp]-[A-Za-z0-9-]+', 'g', '[redigido]'],
  ['AKIA[A-Z0-9]{16}', 'g', '[redigido]'],
  ['eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+', 'g', '[redigido]'],
  ['Bearer \\S+', 'gi', '[redigido]'],
  ['(token|key|secret|passw?o?r?d?)(["\']?\\s*[:=]\\s*)\\S+', 'gi', '$1$2[redigido]'],
]
// REDACTION-PATTERNS-END
const MAX_MESSAGE = 2000
const MAX_STACK = 20000
const SAME_SIG_WINDOW_MS = 60000
const TAIL_BYTES = 65536

try {
  require('./main-app.cjs')
} catch (e) {
  try { recordLoadFailure(e) } catch { /* the original error is what matters */ }
  throw e
}

function redact(text) {
  let out = text
  for (const [source, flags, replacement] of REDACTION_PATTERNS) out = out.replace(new RegExp(source, flags), replacement)
  return out
}

// The sig of the newest line of the file when it is younger than SAME_SIG_WINDOW_MS (only the tail is read).
function recentSig(fs, file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const len = Math.min(size, TAIL_BYTES)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    const lines = buf.toString('utf8').split('\n').filter(l => l.trim())
    const last = lines[lines.length - 1]
    if (!last) return undefined
    const o = JSON.parse(last)
    return o && typeof o.sig === 'string' && Date.now() - Date.parse(o.ts) < SAME_SIG_WINDOW_MS ? o.sig : undefined
  } catch { return undefined } finally { if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* closed */ } } }
}

function recordLoadFailure(e) {
  const fs = require('node:fs')
  const path = require('node:path')
  const crypto = require('node:crypto')
  const os = require('node:os')
  const env = process.env
  const user = (env.TETHER_USER_DIR || '').trim() || (env.TETHER_HOME || '').trim() || path.join(os.homedir(), '.tether')
  const dir = path.join(user, 'faults')
  const message = redact(String(e instanceof Error ? e.message : e)).slice(0, MAX_MESSAGE)
  const stack = redact(e instanceof Error ? e.stack || '' : '').slice(0, MAX_STACK)
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
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, 'faults.jsonl')
  if (recentSig(fs, file) === sig) return
  fs.appendFileSync(file, JSON.stringify(line) + '\n', { mode: 0o600 })
}
