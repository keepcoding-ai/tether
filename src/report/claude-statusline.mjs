// Claude Code status line for every Claude launched by tether (injected via --settings).
// Claude pipes a JSON object on stdin; we print one line: model (strong alert when it is Fable), effort, cwd.
// Then the user's own statusLine.command (if any) runs with the same stdin and its output follows on the same line.
// Plain Node, no dependencies, never throws and never exits non-zero.

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** How long the user's own status line command may run before it is dropped. */
const CHAIN_TIMEOUT_MS = 1000

/** One status line from Claude's stdin payload (any value; garbage yields a line with placeholders). */
export function formatStatusLine(payload) {
  const j = payload && typeof payload === 'object' ? payload : {}
  const model = j.model && typeof j.model === 'object' ? j.model : {}
  const name = typeof model.display_name === 'string' && model.display_name ? model.display_name : (typeof model.id === 'string' && model.id) || '?'
  const probe = `${typeof model.id === 'string' ? model.id : ''} ${name}`
  const level = j.effort && typeof j.effort === 'object' && typeof j.effort.level === 'string' ? j.effort.level : ''
  const ws = j.workspace && typeof j.workspace === 'object' ? j.workspace : {}
  const dir = typeof ws.current_dir === 'string' ? ws.current_dir : ''
  let s
  if (/fable/i.test(probe)) s = `\x1b[1;97;41m  ⚠ FABLE ATIVO: ${name.toUpperCase()} ⚠  \x1b[0m`
  else if (/opus/i.test(probe)) s = `\x1b[1;92m${name}\x1b[0m`
  else s = `\x1b[1;93m${name}\x1b[0m`
  if (level) s += `  \x1b[37meffort: ${level}\x1b[0m`
  if (dir) s += `  \x1b[2m${dir}\x1b[0m`
  return s
}

/** Same rule as the core's tetherHome(): TETHER_HOME, else %LOCALAPPDATA%\tether, else ~/.local/state/tether.
 * @returns {string} */
function tetherHome() {
  const env = process.env.TETHER_HOME
  if (env) return env
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'tether')
  }
  return join(homedir(), '.local', 'state', 'tether')
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

/** Copies the listed keys whose value has the wanted type ('number' | 'string' | 'boolean'); undefined when none.
 * @param {unknown} src @param {Record<string, string>} spec */
function pick(src, spec) {
  if (!isObj(src)) return undefined
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [k, t] of Object.entries(spec)) {
    const v = src[k]
    if (typeof v === t && (t !== 'number' || Number.isFinite(v))) out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

/** Small JSON-safe object kept as-is (rate limits / prompt cache have no fixed shape); undefined when oversized.
 * @param {unknown} v */
function plain(v) {
  if (!isObj(v)) return undefined
  try {
    const s = JSON.stringify(v)
    return s.length <= 4096 ? JSON.parse(s) : undefined
  } catch { return undefined }
}

/** The small, validated subset of Claude's payload that the context panel needs (no `at`). Garbage yields {}.
 * @param {unknown} payload @returns {Record<string, unknown>} */
export function summarizePayload(payload) {
  const j = isObj(payload) ? payload : {}
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @param {string} k @param {unknown} v */
  const put = (k, v) => { if (v !== undefined) out[k] = v }
  if (typeof j.session_id === 'string') out.session_id = j.session_id
  if (typeof j.transcript_path === 'string') out.transcript_path = j.transcript_path
  if (typeof j.version === 'string') out.version = j.version
  put('model', pick(j.model, { id: 'string', display_name: 'string' }))
  const cw = isObj(j.context_window) ? j.context_window : undefined
  if (cw) {
    const w = pick(cw, {
      context_window_size: 'number', used_percentage: 'number', remaining_percentage: 'number',
      total_input_tokens: 'number', total_output_tokens: 'number',
    }) ?? {}
    const cu = pick(cw.current_usage, {
      input_tokens: 'number', output_tokens: 'number', cache_creation_input_tokens: 'number', cache_read_input_tokens: 'number',
    })
    if (cu) w.current_usage = cu
    if (Object.keys(w).length) out.context_window = w
  }
  if (typeof j.exceeds_200k_tokens === 'boolean') out.exceeds_200k_tokens = j.exceeds_200k_tokens
  put('cost', pick(j.cost, { total_cost_usd: 'number', total_duration_ms: 'number', total_api_duration_ms: 'number' }))
  put('prompt_cache', plain(j.prompt_cache))
  put('rate_limits', plain(j.rate_limits))
  put('effort', pick(j.effort, { level: 'string' }))
  return out
}

/** Writes <home>/context/<slotId>.json atomically, only when the summary changed. Never throws.
 * @param {unknown} payload @param {string} [home] @param {string | undefined} [slotId] */
export function persistContext(payload, home = tetherHome(), slotId = process.env.TETHER_SLOT_ID) {
  try {
    if (!slotId || /[\\/]|\.\./.test(slotId)) return
    const summary = summarizePayload(payload)
    if (!Object.keys(summary).length) return
    const body = JSON.stringify(summary)
    const dir = join(home, 'context')
    const file = join(dir, `${slotId}.json`)
    try {
      const prev = JSON.parse(readFileSync(file, 'utf8'))
      if (isObj(prev)) {
        delete prev.at
        if (JSON.stringify(prev) === body) return
      }
    } catch { /* absent or corrupt: write */ }
    mkdirSync(dir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ ...summary, at: new Date().toISOString() }))
    try { renameSync(tmp, file) } catch (e) { try { unlinkSync(tmp) } catch { /* ignore */ } throw e }
  } catch { /* the status line must never fail */ }
}

/** The user's own `statusLine.command`: user settings (CLAUDE_CONFIG_DIR or ~/.claude), then the project's settings.json and
 * settings.local.json; the last one that defines a command wins, as in Claude. Undefined when none.
 * @param {unknown} payload @param {NodeJS.ProcessEnv} [env] @returns {string | undefined} */
export function userStatusLineCommand(payload, env = process.env) {
  const j = isObj(payload) ? payload : {}
  const ws = isObj(j.workspace) ? j.workspace : {}
  const cwd = typeof ws.current_dir === 'string' && ws.current_dir ? ws.current_dir : typeof j.cwd === 'string' ? j.cwd : ''
  const files = [join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json')]
  if (cwd) files.push(join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json'))
  /** @type {string | undefined} */
  let command
  for (const f of files) {
    try {
      const sl = JSON.parse(readFileSync(f, 'utf8'))?.statusLine
      if (isObj(sl) && typeof sl.command === 'string' && sl.command.trim()) command = sl.command
    } catch { /* absent or malformed: skip */ }
  }
  return command
}

/** Runs the user's status line command with the same stdin; resolves to its trimmed stdout, or '' on any failure, timeout or
 * empty output. Never runs this very script (no recursion). Async on purpose: on timeout we stop waiting at once, even when a
 * grandchild keeps the pipe open (a sync spawn would block until it closes), and kill the process tree.
 * @param {string | undefined} command @param {string} stdin @param {string} [self] @param {number} [timeoutMs]
 * @returns {Promise<string>} */
export function runUserStatusLine(command, stdin, self = fileURLToPath(import.meta.url), timeoutMs = CHAIN_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!command) return resolve('')
    const norm = (/** @type {string} */ x) => x.split(String.fromCharCode(92)).join('/').toLowerCase()
    if (norm(command).includes('claude-statusline.mjs') || norm(command).includes(norm(self))) return resolve('')
    let done = false
    let out = ''
    /** @type {import('node:child_process').ChildProcess | undefined} */
    let child
    /** @param {string} v */
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v) } }
    const kill = () => {
      try {
        if (!child?.pid) return
        if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref()
        else process.kill(-child.pid, 'SIGKILL')
      } catch { /* already gone */ }
    }
    const timer = setTimeout(() => { kill(); finish('') }, timeoutMs)
    try {
      child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, detached: process.platform !== 'win32' })
      child.on('error', () => finish(''))
      child.stdin?.on('error', () => {})
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (c) => { out += c })
      child.on('close', (code) => finish(code === 0 ? out.trim() : ''))
      child.stdin?.end(stdin)
    } catch { finish('') }
  })
}

function main() {
  let data = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (c) => { data += c })
  process.stdin.on('error', () => {})
  process.stdin.on('end', async () => {
    let payload
    try { payload = JSON.parse(data) } catch { payload = undefined }
    let out = ''
    try { out = formatStatusLine(payload) } catch { /* nothing to show */ }
    persistContext(payload)
    try {
      const chained = await runUserStatusLine(userStatusLineCommand(payload), data)
      if (chained) out += '  ' + chained.split(/\r?\n/).filter(Boolean).join(' · ')
    } catch { /* ours alone */ }
    // exit once flushed: a timed-out command's orphan pipe must not keep us alive
    try { process.stdout.write(out, () => process.exit(0)) } catch { process.exit(0) }
  })
}

// Only run when executed directly, so tests can import formatStatusLine().
const entry = process.argv[1]
if (entry && /claude-statusline\.mjs$/i.test(entry)) main()
