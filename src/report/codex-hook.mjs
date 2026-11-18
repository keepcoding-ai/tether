// Codex notify entry point. Codex runs it (no shell) as:
//   node "<abs path>/src/report/codex-hook.mjs" notify '<json>'
// with the JSON as the last argument and the slot's env (TETHER_SLOT_ID, TETHER_HOME, TETHER_CODEX_NOTIFY).
// Payload: { type: 'agent-turn-complete' | 'approval-requested' | ..., 'thread-id', 'turn-id', cwd, ... }.
//
// Per run: (1) the session: when `thread-id` is not the one last reported for this slot (<slot>.codex-session), one
// `start` event goes to <home>/slots/<slot>.jsonl (a new session binds on its first turn; /new or /resume inside Codex
// switch it on the next turn); (2) the attention report (<slot>.attention): a finished turn is 'done', a prompt for
// the person is 'waiting'; (3) the user's own notify program (TETHER_CODEX_NOTIFY, a JSON argv) gets the same JSON.
// Never writes to stdout, never exits non-zero. Only node built-ins; plain JS for start-up time.
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** @typedef {import('../core/event.ts').TetherEvent} TetherEvent */
/** @typedef {Record<string, unknown>} Payload */

/** @returns {string} */
function tetherHome() {
  const env = process.env.TETHER_HOME
  if (env) return env
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'tether')
  return join(homedir(), '.local', 'state', 'tether')
}

/** @param {string} home @param {string} msg */
function log(home, msg) {
  try {
    mkdirSync(home, { recursive: true })
    appendFileSync(join(home, 'tether.log'), `${new Date().toISOString()} codex-hook: ${msg}\n`)
  } catch { /* nothing left to do */ }
}

/** @param {unknown} v @returns {string | undefined} */
function str(v) {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/** Notify types that mean "Codex waits for the person". */
const WAITING = new Set(['approval-requested', 'plan-mode-prompt', 'async-question'])

/** The attention value of a notify payload, or undefined.
 * @param {Payload} payload @returns {'done' | 'waiting' | undefined} */
export function attentionOf(payload) {
  const type = str(payload.type)
  if (type === 'agent-turn-complete') return 'done'
  if (type && WAITING.has(type)) return 'waiting'
  return undefined
}

/** The `start` event for the payload's session, when it is not the one last reported (`last`).
 * @param {Payload} payload @param {string} slotId @param {string} ts @param {string | undefined} last
 * @returns {TetherEvent | undefined} */
export function startEventOf(payload, slotId, ts, last) {
  const sessionId = str(payload['thread-id'])
  if (!sessionId || sessionId === last) return undefined
  /** @type {TetherEvent} */
  const ev = { v: 1, ts, slotId, agent: 'codex', kind: 'start', source: 'notify', sessionId }
  const cwd = str(payload.cwd)
  if (cwd) {
    ev.cwd = cwd
    ev.resume = { cwd, args: ['resume', sessionId] }
  }
  ev.raw = payload
  return ev
}

/** @param {string} path @param {string} content */
function writeAtomic(path, content) {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}

/** @param {string} json */
function record(json) {
  const home = tetherHome()
  const slotId = process.env.TETHER_SLOT_ID
  if (!slotId) return
  try {
    /** @type {unknown} */
    const parsed = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    const payload = /** @type {Payload} */ (parsed)
    const ts = new Date().toISOString()
    const dir = join(home, 'slots')
    mkdirSync(dir, { recursive: true })
    const marker = join(dir, `${slotId}.codex-session`)
    /** @type {string | undefined} */
    let last
    try { last = readFileSync(marker, 'utf8').trim() } catch { /* first report of this slot */ }
    const ev = startEventOf(payload, slotId, ts, last)
    if (ev) {
      appendFileSync(join(dir, `${slotId}.jsonl`), JSON.stringify(ev) + '\n')
      writeAtomic(marker, ev.sessionId)
    }
    const kind = attentionOf(payload)
    if (kind) {
      const sessionId = str(payload['thread-id'])
      writeAtomic(join(dir, `${slotId}.attention`), JSON.stringify(sessionId ? { ts, kind, sessionId } : { ts, kind }))
    } else if (!ev) {
      log(home, `slot ${slotId}: ignored notify ${JSON.stringify(str(payload.type) ?? '')}`)
    }
  } catch (e) {
    log(home, `slot ${slotId}: ${/** @type {Error} */ (e)?.message ?? String(e)}: ${json.slice(0, 200)}`)
  }
}

/** Runs the user's own notify program with the same JSON, detached (Codex does not wait for us either).
 * @param {string} json */
function chain(json) {
  const raw = process.env.TETHER_CODEX_NOTIFY
  if (!raw) return
  try {
    const argv = JSON.parse(raw)
    if (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === 'string')) return
    const child = spawn(argv[0], [...argv.slice(1), json], { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.unref()
  } catch (e) {
    log(tetherHome(), `chain: ${/** @type {Error} */ (e)?.message ?? String(e)}`)
  }
}

function main() {
  process.exitCode = 0
  process.on('uncaughtException', () => process.exit(0))
  const json = process.argv[process.argv.length - 1] ?? ''
  if (process.argv.length < 4) return
  record(json)
  chain(json)
}

// Only run when executed directly, so tests can import the mappers.
const entry = process.argv[1]
if (entry && /codex-hook\.mjs$/i.test(entry)) main()
