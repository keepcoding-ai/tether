// Claude Code hook entry point. Claude runs it (via Git Bash on Windows) as:
//   node "<abs path>/src/report/claude-hook.mjs" SessionStart|SessionEnd|Stop|Notification|UserPromptSubmit
// with the hook payload on stdin and the slot's env (TETHER_SLOT_ID, TETHER_HOME).
//
// Rules (PRD RNF3): never write to stdout (SessionStart stdout is injected into Claude's
// context), except the polite-pause delivery on PostToolUse/UserPromptSubmit, never exit non-zero, swallow every error, finish fast. Only node:fs/path/os.
// Plain JS on purpose: Node's TypeScript loader added ~40% to the hook's run time.
// It does not import the core: it appends one JSON line itself.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** @typedef {import('../core/event.ts').TetherEvent} TetherEvent */
/** @typedef {Record<string, unknown>} Payload */

/** Same rule as the core: TETHER_HOME, else %LOCALAPPDATA%\tether, else ~/.local/state/tether.
 * @returns {string} */
function tetherHome() {
  const env = process.env.TETHER_HOME
  if (env) return env
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    return join(local, 'tether')
  }
  return join(homedir(), '.local', 'state', 'tether')
}

/** @param {string} home @param {string} msg */
function log(home, msg) {
  try {
    mkdirSync(home, { recursive: true })
    appendFileSync(join(home, 'tether.log'), `${new Date().toISOString()} claude-hook: ${msg}\n`)
  } catch {
    // nothing left to do
  }
}

/** @param {unknown} v @returns {string | undefined} */
function str(v) {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/** Maps a Claude hook payload to a v1 event; undefined when it is not one we record.
 * @param {string} hookName @param {Payload} payload @param {string} slotId @param {string} ts
 * @returns {TetherEvent | undefined} */
export function toEvent(hookName, payload, slotId, ts) {
  const sessionId = str(payload.session_id)
  if (!sessionId) return undefined
  const cwd = str(payload.cwd)
  if (hookName === 'SessionStart') {
    /** @type {TetherEvent} */
    const ev = {
      v: 1,
      ts,
      slotId,
      agent: 'claude',
      kind: 'start',
      source: str(payload.source) ?? 'unknown',
      sessionId,
    }
    const title = str(payload.session_title)
    if (title) ev.title = title
    if (cwd) {
      ev.cwd = cwd
      ev.resume = { cwd, args: ['--resume', sessionId] }
    }
    ev.raw = payload
    return ev
  }
  if (hookName === 'SessionEnd') {
    /** @type {TetherEvent} */
    const ev = {
      v: 1,
      ts,
      slotId,
      agent: 'claude',
      kind: 'end',
      source: str(payload.reason) ?? 'unknown',
      sessionId,
    }
    if (cwd) ev.cwd = cwd
    ev.raw = payload
    return ev
  }
  return undefined
}

/**
 * Maps Stop / Notification / UserPromptSubmit to an attention report (<home>/slots/<slot>.attention, read by tetherd):
 * UserPromptSubmit = a turn begins ('start', a turn signal only, never a badge); Stop = the turn is over ('done'); Notification = Claude waits for the user ('waiting': a permission prompt,
 * the idle prompt, a question). `auth_success` is only informative. Undefined for any other hook, and for
 * payloads with `agent_id` (a subagent's hook, not the main turn).
 * @param {string} hookName @param {Payload} payload @param {string} ts
 * @returns {{ ts: string, kind: 'start' | 'done' | 'waiting', sessionId?: string } | undefined} */
export function toAttention(hookName, payload, ts) {
  if (str(payload.agent_id)) return undefined
  /** @type {'start' | 'done' | 'waiting' | undefined} */
  let kind
  if (hookName === 'UserPromptSubmit') kind = 'start'
  else if (hookName === 'Stop') kind = 'done'
  else if (hookName === 'Notification') kind = str(payload.notification_type) === 'auth_success' ? undefined : 'waiting'
  if (!kind) return undefined
  const sessionId = str(payload.session_id)
  return sessionId ? { ts, kind, sessionId } : { ts, kind }
}


/**
 * Polite pause: when <home>/slots/<slot>.pause-request.json exists, PostToolUse / UserPromptSubmit hand its text to the
 * agent as additionalContext (stdout) and log `delivered` once per batch; Stop logs the agent's last message as `stop`.
 * @param {string} home @param {string} slotId @param {string} hookName @param {Payload} payload @param {string} ts */
function pauseStep(home, slotId, hookName, payload, ts) {
  if (str(payload.agent_id)) return
  const dir = join(home, 'slots')
  /** @type {{ batchId?: unknown, text?: unknown } | undefined} */
  let req
  try { req = JSON.parse(readFileSync(join(dir, `${slotId}.pause-request.json`), 'utf8')) } catch { return }
  const batchId = str(req?.batchId)
  if (!batchId) return
  const report = join(dir, `${slotId}.pause.jsonl`)
  if (hookName === 'Stop') {
    appendFileSync(report, JSON.stringify({ ts, batchId, kind: 'stop', text: str(payload.last_assistant_message) ?? '' }) + '\n')
    return
  }
  if (hookName !== 'PostToolUse' && hookName !== 'UserPromptSubmit') return
  const text = str(req?.text)
  if (!text) return
  let seen = ''
  try { seen = readFileSync(report, 'utf8') } catch { /* no report yet */ }
  if (seen.includes(`"batchId":${JSON.stringify(batchId)},"kind":"delivered"`)) return
  appendFileSync(report, JSON.stringify({ ts, batchId, kind: 'delivered' }) + '\n')
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: hookName, additionalContext: text } }))
}

/**
 * Background work: SubagentStart leaves a marker <home>/slots/<slot>.bg.<agentId>, SubagentStop removes it, SessionStart
 * removes them all (a new or resumed session owns none). tetherd counts the markers: while any is there, a Stop does not
 * mean "stopped", the agent is waiting for its subagents. Foreground subagents pass through too; they end before the turn does.
 * Returns true when the hook was one of these.
 * @param {string} home @param {string} slotId @param {string} hookName @param {Payload} payload @returns {boolean} */
export function backgroundStep(home, slotId, hookName, payload) {
  if (hookName !== 'SubagentStart' && hookName !== 'SubagentStop' && hookName !== 'SessionStart') return false
  const dir = join(home, 'slots')
  if (hookName === 'SessionStart') {
    try { for (const n of readdirSync(dir)) if (n.startsWith(`${slotId}.bg.`)) { try { unlinkSync(join(dir, n)) } catch { /* gone */ } } } catch { /* no dir */ }
    return false // SessionStart still reports the session
  }
  const id = (str(payload.agent_id) ?? '').replace(/[^A-Za-z0-9_-]/g, '')
  if (!id) return true
  const path = join(dir, `${slotId}.bg.${id}`)
  if (hookName === 'SubagentStart') { mkdirSync(dir, { recursive: true }); writeFileSync(path, '') }
  else { try { unlinkSync(path) } catch { /* never started here */ } }
  return true
}

/** @param {string} stdin */
function record(stdin) {
  const home = tetherHome()
  try {
    const slotId = process.env.TETHER_SLOT_ID
    if (!slotId) return // not launched by tether: nothing to do
    /** @type {Payload} */
    let payload
    try {
      /** @type {unknown} */
      const parsed = JSON.parse(stdin)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      payload = /** @type {Payload} */ (parsed)
    } catch (e) {
      log(home, `slot ${slotId}: bad stdin (${/** @type {Error} */ (e).message}): ${stdin.slice(0, 200)}`)
      return
    }
    const hookName = process.argv[2] ?? str(payload.hook_event_name) ?? ''
    const ts = new Date().toISOString()
    try { pauseStep(home, slotId, hookName, payload, ts) } catch (e) { log(home, `pause: ${/** @type {Error} */ (e).message}`) }
    if (hookName === 'PostToolUse') return
    try { if (backgroundStep(home, slotId, hookName, payload)) return } catch (e) { log(home, `background: ${/** @type {Error} */ (e).message}`) }
    const attention = toAttention(hookName, payload, ts)
    if (attention) {
      const dir = join(home, 'slots')
      mkdirSync(dir, { recursive: true })
      const path = join(dir, `${slotId}.attention`)
      const tmp = `${path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(attention))
      renameSync(tmp, path)
      return
    }
    const ev = toEvent(hookName, payload, slotId, ts)
    if (!ev) {
      log(home, `slot ${slotId}: ignored hook ${JSON.stringify(hookName)}`)
      return
    }
    const dir = join(home, 'slots')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, `${slotId}.jsonl`), JSON.stringify(ev) + '\n')
  } catch (e) {
    log(home, `error: ${/** @type {Error | undefined} */ (e)?.stack ?? String(e)}`)
  }
}

function main() {
  process.exitCode = 0
  process.on('uncaughtException', () => process.exit(0))
  process.on('unhandledRejection', () => process.exit(0))
  let data = ''
  let done = false
  const finish = () => {
    if (done) return
    done = true
    clearTimeout(timer)
    record(data)
    process.exit(0)
  }
  // Safety net: a stdin that never ends (TTY, odd host) must not hang Claude.
  const timer = setTimeout(finish, 3000)
  try {
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (/** @type {string} */ c) => { data += c })
    process.stdin.on('end', finish)
    process.stdin.on('error', finish)
    process.stdin.on('close', finish)
  } catch {
    finish()
  }
}

// Only run when executed directly, so tests can import toEvent().
const entry = process.argv[1]
if (entry && /claude-hook\.mjs$/i.test(entry)) main()
