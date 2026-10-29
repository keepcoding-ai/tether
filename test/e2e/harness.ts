// E2E harness: drives a real TUI agent (Claude Code, soul-cli) inside a pseudo-terminal.
// Agent-agnostic: it receives a LaunchPlan and only knows how to read a screen and type.
// See test/e2e/README.md for how idle/command detection works and why.
import * as pty from 'node-pty'
import { execFile } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LaunchPlan } from '../../src/agents/types.ts'

// ---------- Virtual screen (minimal VT100/xterm emulator, enough for ConPTY output) ----------

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3fffd}]/u

class Buffer_ {
  rows: string[][]
  constructor(cols: number, nrows: number) {
    this.rows = Array.from({ length: nrows }, () => Array<string>(cols).fill(' '))
  }
}

export class Screen {
  private main: Buffer_
  private alt: Buffer_
  private buf: Buffer_
  private row = 0
  private col = 0
  private saved: [number, number] = [0, 0]
  private pending = ''
  title = ''
  /** Lines scrolled off the top of the main buffer (bounded). */
  scrollback: string[] = []

  readonly cols: number
  readonly rows: number

  constructor(cols = 120, rows = 40) {
    this.cols = cols; this.rows = rows
    this.main = new Buffer_(cols, rows)
    this.alt = new Buffer_(cols, rows)
    this.buf = this.main
  }

  text(): string {
    const lines = this.buf.rows.map(r => r.join('').replace(/\s+$/, ''))
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    return lines.join('\n')
  }

  write(data: string): void {
    const s = this.pending + data
    this.pending = ''
    let i = 0
    while (i < s.length) {
      const ch = s[i]!
      if (ch === '\x1b') {
        const n = this.escape(s, i)
        if (n < 0) { this.pending = s.slice(i); return } // incomplete sequence: wait for more data
        i += n
        continue
      }
      i++
      if (ch === '\r') { this.col = 0; continue }
      if (ch === '\n' || ch === '\x0b' || ch === '\x0c') { this.lineFeed(); continue }
      if (ch === '\b') { if (this.col > 0) this.col--; continue }
      if (ch === '\t') { this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8); continue }
      if (ch === '\x07' || (ch < ' ')) continue
      // surrogate pairs: take the full code point
      let cp = ch
      if (ch >= '\ud800' && ch <= '\udbff' && i < s.length) { cp += s[i]!; i++ }
      this.put(cp)
    }
  }

  private put(cp: string): void {
    if (this.col >= this.cols) { this.col = 0; this.lineFeed() } // deferred wrap
    const line = this.buf.rows[this.row]!
    line[this.col++] = cp
    if (WIDE.test(cp) && this.col < this.cols) line[this.col++] = ''
  }

  private lineFeed(): void {
    if (this.row < this.rows - 1) { this.row++; return }
    const gone = this.buf.rows.shift()!
    if (this.buf === this.main) { this.scrollback.push(gone.join('').replace(/\s+$/, '')); if (this.scrollback.length > 500) this.scrollback.shift() }
    this.buf.rows.push(Array<string>(this.cols).fill(' '))
  }

  private blank(r: number, from: number, to: number): void {
    const line = this.buf.rows[r]
    if (!line) return
    for (let c = Math.max(0, from); c < Math.min(this.cols, to); c++) line[c] = ' '
  }

  /** Parses one escape sequence at s[i]; returns its length, or -1 if incomplete. */
  private escape(s: string, i: number): number {
    const next = s[i + 1]
    if (next === undefined) return -1
    if (next === '[') {
      let j = i + 2
      while (j < s.length && s[j]! >= '0' && s[j]! <= '?') j++ // params 0-9 ; : < = > ?
      while (j < s.length && s[j]! >= ' ' && s[j]! <= '/') j++ // intermediates
      if (j >= s.length) return -1
      this.csi(s.slice(i + 2, j), s[j]!)
      return j - i + 1
    }
    if (next === ']' || next === 'P' || next === '^' || next === '_') { // OSC / DCS / PM / APC: until BEL or ST
      let j = i + 2
      while (j < s.length) {
        if (s[j] === '\x07') { if (next === ']') this.osc(s.slice(i + 2, j)); return j - i + 1 }
        if (s[j] === '\x1b' && s[j + 1] === '\\') { if (next === ']') this.osc(s.slice(i + 2, j)); return j - i + 2 }
        if (s[j] === '\x1b' && s[j + 1] === undefined) return -1
        j++
      }
      return -1
    }
    if (next === '(' || next === ')' || next === '*' || next === '+' || next === '#' || next === '%') return s[i + 2] === undefined ? -1 : 3
    if (next === '7') this.saved = [this.row, this.col]
    else if (next === '8') [this.row, this.col] = this.saved
    else if (next === 'D') this.lineFeed()
    else if (next === 'E') { this.col = 0; this.lineFeed() }
    else if (next === 'M') { if (this.row > 0) this.row--; else { this.buf.rows.pop(); this.buf.rows.unshift(Array<string>(this.cols).fill(' ')) } }
    else if (next === 'c') { this.main = new Buffer_(this.cols, this.rows); this.alt = new Buffer_(this.cols, this.rows); this.buf = this.main; this.row = this.col = 0 }
    return 2 // ESC + one char (also covers ESC \, ESC =, ESC >)
  }

  private osc(body: string): void {
    const m = /^([02]);(.*)$/s.exec(body)
    if (m) this.title = m[2]!
  }

  private csi(params: string, final: string): void {
    const priv = params[0] === '?' || params[0] === '<' || params[0] === '>' || params[0] === '='
    const nums = (priv ? params.slice(1) : params).split(';').map(x => (x === '' ? 0 : parseInt(x, 10)))
    const n = (k: number, dflt: number) => { const v = nums[k]; return v === undefined || v === 0 ? dflt : v }
    const clampRow = (r: number) => Math.max(0, Math.min(this.rows - 1, r))
    const clampCol = (c: number) => Math.max(0, Math.min(this.cols - 1, c))
    if (priv) {
      if (final === 'h' || final === 'l') for (const mode of nums) {
        if (mode === 1049 || mode === 1047 || mode === 47) {
          if (final === 'h') { this.saved = [this.row, this.col]; this.alt = new Buffer_(this.cols, this.rows); this.buf = this.alt; this.row = this.col = 0 }
          else { this.buf = this.main; [this.row, this.col] = this.saved }
        }
      }
      return
    }
    switch (final) {
      case 'H': case 'f': this.row = clampRow(n(0, 1) - 1); this.col = clampCol(n(1, 1) - 1); break
      case 'A': this.row = clampRow(this.row - n(0, 1)); break
      case 'B': this.row = clampRow(this.row + n(0, 1)); break
      case 'C': this.col = clampCol(this.col + n(0, 1)); break
      case 'D': this.col = clampCol(this.col - n(0, 1)); break
      case 'E': this.row = clampRow(this.row + n(0, 1)); this.col = 0; break
      case 'F': this.row = clampRow(this.row - n(0, 1)); this.col = 0; break
      case 'G': case '`': this.col = clampCol(n(0, 1) - 1); break
      case 'd': this.row = clampRow(n(0, 1) - 1); break
      case 'J': {
        const mode = nums[0] ?? 0
        if (mode === 2 || mode === 3) for (let r = 0; r < this.rows; r++) this.blank(r, 0, this.cols)
        else if (mode === 0) { this.blank(this.row, this.col, this.cols); for (let r = this.row + 1; r < this.rows; r++) this.blank(r, 0, this.cols) }
        else if (mode === 1) { this.blank(this.row, 0, this.col + 1); for (let r = 0; r < this.row; r++) this.blank(r, 0, this.cols) }
        break
      }
      case 'K': {
        const mode = nums[0] ?? 0
        if (mode === 0) this.blank(this.row, this.col, this.cols)
        else if (mode === 1) this.blank(this.row, 0, this.col + 1)
        else this.blank(this.row, 0, this.cols)
        break
      }
      case 'X': this.blank(this.row, this.col, this.col + n(0, 1)); break
      case 'P': { const line = this.buf.rows[this.row]!; line.splice(this.col, n(0, 1)); while (line.length < this.cols) line.push(' '); break }
      case '@': { const line = this.buf.rows[this.row]!; line.splice(this.col, 0, ...Array<string>(n(0, 1)).fill(' ')); line.length = this.cols; break }
      case 'L': for (let k = 0; k < n(0, 1); k++) { this.buf.rows.pop(); this.buf.rows.splice(this.row, 0, Array<string>(this.cols).fill(' ')) } break
      case 'M': for (let k = 0; k < n(0, 1); k++) { this.buf.rows.splice(this.row, 1); this.buf.rows.push(Array<string>(this.cols).fill(' ')) } break
      case 'S': for (let k = 0; k < n(0, 1); k++) { this.buf.rows.shift(); this.buf.rows.push(Array<string>(this.cols).fill(' ')) } break
      case 'T': for (let k = 0; k < n(0, 1); k++) { this.buf.rows.pop(); this.buf.rows.unshift(Array<string>(this.cols).fill(' ')) } break
      case 's': this.saved = [this.row, this.col]; break
      case 'u': [this.row, this.col] = this.saved; break
      default: break // SGR (m), modes, queries, DECSTBM (r): ignored
    }
  }
}

// ---------- Helpers ----------

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** process.env minus every CLAUDE* variable (PRD §4.1, discovery 1), plus `extra`. */
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^CLAUDE/i.test(k)) env[k] = v
  return Object.assign(env, extra)
}

/** A fresh directory under os.tmpdir(); `cleanup()` removes it (retrying, Windows holds locks briefly). */
export function tempDir(prefix = 'tether-e2e-'): { path: string; cleanup(): Promise<void> } {
  const path = mkdtempSync(join(tmpdir(), prefix))
  return {
    path,
    async cleanup() {
      for (let attempt = 0; attempt < 5; attempt++) {
        try { rmSync(path, { recursive: true, force: true }); return } catch { await sleep(300) }
      }
    },
  }
}

function ps(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 1 << 24, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })
}

/** A process identity: pid plus creation time, because Windows reuses pids within seconds. */
export interface Proc { pid: number; ppid: number; name: string; created: number }

async function allProcesses(): Promise<Proc[]> {
  if (process.platform !== 'win32') {
    const out = await new Promise<string>((res, rej) => execFile('ps', ['-eo', 'pid=,ppid=,lstart=,comm='], (e, so) => (e ? rej(e) : res(so))))
    return out.trim().split('\n').map(l => {
      const m = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/.exec(l)
      return m ? { pid: +m[1]!, ppid: +m[2]!, created: Date.parse(m[3]!) || 0, name: m[4]! } : { pid: -1, ppid: -1, created: 0, name: '' }
    }).filter(p => p.pid >= 0)
  }
  const out = await ps("Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,@{n='Created';e={$_.CreationDate.ToFileTime()}} | ConvertTo-Json -Compress")
  const arr = JSON.parse(out || '[]') as { ProcessId: number; ParentProcessId: number; Name: string; Created: number | null }[]
  return arr.map(p => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, created: p.Created ?? 0 }))
}

/** The process and all its live descendants (one CIM query, ~1 s). */
export async function processTree(root: number): Promise<Proc[]> {
  const all = await allProcesses()
  const out = new Map<number, Proc>()
  const walk = (p: number) => { for (const q of all) if (q.ppid === p && !out.has(q.pid)) { out.set(q.pid, q); walk(q.pid) } }
  const self = all.find(p => p.pid === root)
  if (self) out.set(root, self)
  walk(root)
  return [...out.values()]
}

/** Which of these pids are listed right now (tasklist, ~100 ms). Pid-only: a reused pid counts as alive. */
export async function alivePids(pids: number[]): Promise<number[]> {
  if (pids.length === 0) return []
  let all: Set<number>
  if (process.platform === 'win32') {
    const out = await new Promise<string>((res, rej) => execFile('tasklist', ['/FO', 'CSV', '/NH'], { maxBuffer: 1 << 24, windowsHide: true }, (e, so) => (e ? rej(e) : res(so))))
    all = new Set(out.split('\n').map(l => parseInt(l.split('","')[1] ?? '', 10)).filter(n => !Number.isNaN(n)))
  } else all = new Set((await allProcesses()).map(p => p.pid))
  return pids.filter(p => all.has(p))
}

/** Which of these processes still exist (same pid AND creation time; CIM, ~1 s). */
export async function aliveProcs(procs: Proc[]): Promise<Proc[]> {
  if (procs.length === 0) return []
  const all = await allProcesses()
  return procs.filter(p => all.some(q => q.pid === p.pid && q.created === p.created))
}

/** Polls (fast, by pid) until none of `procs` is listed or `ms` elapsed, then confirms leftovers by identity. */
async function waitGone(procs: Proc[], ms: number): Promise<Proc[]> {
  const deadline = Date.now() + ms
  const pids = procs.map(p => p.pid)
  while ((await alivePids(pids)).length && Date.now() < deadline) await sleep(200)
  return aliveProcs(procs)
}

const describe = (procs: Proc[]) => procs.map(p => `${p.pid} ${p.name}`).join(', ')

function killTree(pid: number): Promise<void> {
  return new Promise(resolve => {
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
    else execFile('pkill', ['-9', '-P', String(pid)], () => { try { process.kill(pid, 'SIGKILL') } catch {} resolve() })
  })
}

// ---------- Terminal ----------

export interface StartOptions {
  cols?: number
  rows?: number
  /** JSONL log: raw PTY chunks (replayable) plus marks with the screen at each harness step. */
  log?: string
  /** Max time for the TUI to show its input prompt (default 60 s). */
  startupTimeout?: number
  /** Accept the agent's "trust this folder?" dialog (default true). */
  trust?: boolean
  /** Delay between typed characters, ms (default 10). Faster bursts can be taken as a paste. */
  typeDelay?: number
  /** kill() waits until the TUI has been up this long (default 11 000 ms). Claude Code counts a fullscreen session
   *  that dies within 10 s of its first frame as a boot "strike"; two strikes turn fullscreen off for the whole
   *  machine (fullscreenAutoDisabled in ~/.claude.json; /tui fullscreen resets it). */
  minUptimeBeforeKill?: number
}

export interface WaitOptions { timeout?: number }
export interface IdleOptions extends WaitOptions { quietMs?: number }

const PROMPT = /^❯/
const TRUST = /trust this folder/i
const TRUST_YES = /^\s*❯\s*Yes, I trust/m // dialog options are indented
/** Visible while the agent is working (status bar hint; spinner line "✽ Doing…"; busy window-title glyphs). */
const BUSY_STATUS = /esc to interrupt/
const BUSY_SPINNER = /^[✽✻✶✢·*] \S[^\n]*…/m
const BUSY_TITLE = /^[◐◑◒◓]/

export class Terminal {
  readonly pid: number
  exitCode: number | undefined
  signal: number | undefined
  /** Session id the agent printed on exit ("claude --resume <id>"), when it did. */
  resumeId: string | undefined
  readonly exited: Promise<{ exitCode: number; signal?: number }>
  readonly screenBuf: Screen
  private readonly p: pty.IPty
  private readonly listeners = new Set<() => void>()
  private lastDataAt = Date.now()
  private lastTyped = ''
  private readonly t0 = Date.now()
  private readonly typeDelay: number
  readonly plan: LaunchPlan
  readonly opts: StartOptions

  constructor(plan: LaunchPlan, opts: StartOptions) {
    this.plan = plan; this.opts = opts
    const cols = opts.cols ?? 120, rows = opts.rows ?? 40
    this.screenBuf = new Screen(cols, rows)
    this.typeDelay = opts.typeDelay ?? 10
    this.p = pty.spawn(plan.command, plan.args, { cols, rows, cwd: plan.cwd, env: plan.env, useConpty: true, name: 'xterm-256color' })
    this.pid = this.p.pid
    this.p.onData(d => {
      this.lastDataAt = Date.now()
      this.screenBuf.write(d)
      if (opts.log) appendFileSync(opts.log, JSON.stringify({ t: Date.now() - this.t0, d }) + '\n')
      for (const l of this.listeners) l()
    })
    this.exited = new Promise(resolve => {
      this.p.onExit(e => {
        this.exitCode = e.exitCode; this.signal = e.signal
        const m = /--resume ([0-9a-f-]{36})/.exec(this.screenBuf.text())
        if (m) this.resumeId = m[1]
        this.mark('exit', { exitCode: e.exitCode, signal: e.signal })
        for (const l of this.listeners) l()
        resolve({ exitCode: e.exitCode, signal: e.signal })
        setTimeout(() => this.dispose(), 1_100) // after node-pty's own 1 s flush window
      })
    })
  }

  private disposed = false
  /** Releases the ConPTY (closes the pseudo console, its reader thread and pipes). node-pty 1.1 leaves these open
   *  after the child exits, which keeps the Node event loop alive; its kill() releases them but forks a helper
   *  that fails noisily ("AttachConsole failed") once the console is gone. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const agent = (this.p as unknown as { _agent?: Record<string, any> })._agent
    if (!agent) { try { this.p.kill() } catch {} return }
    const noop = () => {}
    const steps: (() => void)[] = [
      () => { for (const s of [agent._inSocket, agent._outSocket]) { s?.on('error', noop); if (s) s.readable = false } },
      () => agent._conoutSocketWorker?._worker?.on('error', noop), // its pipe into _outSocket may EPIPE while dying
      () => agent._ptyNative?.kill(agent._pty, agent._useConptyDll), // ClosePseudoConsole: ends conhost and the child
      () => agent._conoutSocketWorker?.dispose(), // terminates the reader thread; _outSocket then closes by itself
      () => agent._inSocket?.destroy(),
    ]
    for (const s of steps) { try { s() } catch {} }
  }

  get alive(): boolean { return this.exitCode === undefined }
  /** Current visible text (ANSI-free, trailing blanks trimmed). After exit: the main screen with the agent's farewell. */
  screen(): string { return this.screenBuf.text() }
  get title(): string { return this.screenBuf.title }
  /** Raw bytes to the PTY (keys: '\r' Enter, '\x1b[B' Down, '\x1b' Esc, '\x03' Ctrl+C). */
  write(data: string): void { this.p.write(data) }

  /** Writes a labelled marker (with the current screen) to the log. */
  mark(label: string, extra: Record<string, unknown> = {}): void {
    if (this.opts.log) appendFileSync(this.opts.log, JSON.stringify({ t: Date.now() - this.t0, mark: label, ...extra, title: this.title, screen: this.screen() }) + '\n')
  }

  /** Lines of the screen; `prompt` is the index of the input box (last line starting with ❯), -1 if none. */
  private layout(): { lines: string[]; prompt: number } {
    const lines = this.screen().split('\n')
    let prompt = -1
    for (let i = lines.length - 1; i >= 0; i--) if (PROMPT.test(lines[i]!)) { prompt = i; break }
    return { lines, prompt }
  }

  /** Text currently in the input box (from the ❯ line to the end of the screen, whitespace collapsed). */
  inputText(): string {
    const { lines, prompt } = this.layout()
    if (prompt < 0) return ''
    return lines.slice(prompt).join(' ').replace(/^❯/, '').replace(/\s+/g, ' ').trim()
  }

  /** The slash command highlighted in the autocomplete menu, if one is open. The menu is the block of non-blank
   *  lines right above the rule over the input box; its items are indented ("  ❯ /compact  …"), unlike the
   *  transcript echo of an earlier command ("❯ /compact" at column 0). */
  menuHighlight(): string | undefined {
    const { lines, prompt } = this.layout()
    let i = prompt - 1
    if (i < 0 || !/^─{10,}/.test(lines[i]!)) return undefined
    for (i--; i >= 0 && lines[i]!.trim() !== ''; i--) {
      const m = /^\s+❯ (\/\S+)/.exec(lines[i]!)
      if (m) return m[1]
    }
    return undefined
  }

  /** The agent is working: spinner, "esc to interrupt" hint or busy title glyph. */
  busy(): boolean {
    const s = this.screen()
    return BUSY_STATUS.test(s) || BUSY_SPINNER.test(s) || BUSY_TITLE.test(this.title)
  }

  /** Input prompt visible, nothing pending in it, agent not busy, and no output for `quietMs`. */
  isIdle(quietMs: number): boolean {
    const { prompt } = this.layout()
    if (prompt < 0 || this.busy()) return false
    if (this.lastTyped && this.inputText().includes(this.lastTyped)) return false
    return Date.now() - this.lastDataAt >= quietMs
  }

  /** Resolves when `cond` holds (checked on every PTY chunk and every 50 ms). Rejects on timeout or process exit (unless allowExit). */
  async waitFor(cond: RegExp | ((screen: string, t: Terminal) => boolean), opts: WaitOptions & { allowExit?: boolean; what?: string } = {}): Promise<string> {
    const timeout = opts.timeout ?? 30_000
    const test = typeof cond === 'function' ? () => cond(this.screen(), this) : () => cond.test(this.screen())
    const what = opts.what ?? (typeof cond === 'function' ? 'condition' : String(cond))
    return new Promise<string>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined, poll: NodeJS.Timeout | undefined
      const done = (fn: () => void) => { this.listeners.delete(check); clearTimeout(timer); clearInterval(poll); fn() }
      const check = () => {
        if (test()) return done(() => resolve(this.screen()))
        if (!this.alive) {
          if (opts.allowExit) return done(() => resolve(this.screen()))
          return done(() => reject(new Error(`process exited (code ${this.exitCode}) while waiting for ${what}\n--- screen ---\n${this.screen()}`)))
        }
      }
      this.listeners.add(check)
      poll = setInterval(check, 50)
      timer = setTimeout(() => done(() => reject(new Error(`timeout (${timeout} ms) waiting for ${what}\n--- screen ---\n${this.screen()}`))), timeout)
      check()
    })
  }

  /** Waits until no output has arrived for `ms` (regardless of what is on screen). */
  quiet(ms: number, timeout = 30_000): Promise<string> {
    return this.waitFor((_s, t) => Date.now() - t.lastDataAt >= ms, { timeout, allowExit: true, what: `${ms} ms of quiet` })
  }

  /** Waits until the TUI is idle: prompt box back and empty, no spinner/busy hint, quiet for `quietMs` (default 700). */
  async waitIdle(opts: IdleOptions = {}): Promise<void> {
    const quietMs = opts.quietMs ?? 700
    await this.waitFor((_s, t) => t.isIdle(quietMs), { timeout: opts.timeout ?? 60_000, what: `idle (quiet ${quietMs} ms)` })
    this.mark('idle')
  }

  /** Types `text` (then Enter unless enter:false), waiting for the echo and for the agent to accept the line.
   *  For slash commands it checks the autocomplete highlight is the command typed before pressing Enter. */
  async type(text: string, opts: { enter?: boolean; timeout?: number } = {}): Promise<void> {
    if (!this.alive) throw new Error(`cannot type "${text}": process exited (code ${this.exitCode})`)
    const timeout = opts.timeout ?? 15_000
    this.mark('type', { text })
    const norm = text.replace(/\s+/g, ' ').trim()
    for (const ch of text) { this.p.write(ch); await sleep(this.typeDelay) }
    await this.waitFor((_s, t) => t.inputText().includes(norm), { timeout: 5_000, what: `echo of "${text}"` })
    if (text.startsWith('/')) {
      // let the autocomplete menu settle (it closes once an argument is typed), then verify the highlight
      await this.quiet(250, 5_000)
      const cmd = norm.split(' ')[0]!
      const highlighted = this.menuHighlight()
      if (highlighted && highlighted !== cmd) throw new Error(`autocomplete highlights ${highlighted} instead of ${cmd}; refusing to press Enter\n--- screen ---\n${this.screen()}`)
    }
    if (opts.enter === false) return
    this.lastTyped = norm
    this.p.write('\r')
    // accepted = the text left the input box (or the process ended, e.g. /exit)
    await this.waitFor((_s, t) => !t.inputText().includes(norm), { timeout, allowExit: true, what: `"${text}" to be accepted` })
    this.mark('accepted', { text })
  }

  /** Types `/exit`, waits for the process to end and for its whole tree to be gone (helpers die a moment after
   *  the main process). Falls back to kill() if it does not exit. */
  async exit(opts: WaitOptions = {}): Promise<{ exitCode: number; signal?: number }> {
    if (!this.alive) return { exitCode: this.exitCode!, signal: this.signal }
    const procs = await this.tree()
    await this.type('/exit')
    const timeout = opts.timeout ?? 20_000
    const res = await Promise.race([this.exited, sleep(timeout).then(() => undefined)])
    if (!res) { await this.kill(); throw new Error(`process did not exit ${timeout} ms after /exit`) }
    const left = await waitGone(procs, 15_000)
    if (left.length) throw new Error(`processes still alive after /exit: ${describe(left)}`)
    return res
  }

  /** The agent and its descendants right now (Claude Code in fullscreen mode runs several helpers). */
  tree(): Promise<Proc[]> { return processTree(this.pid) }

  /** When the input prompt first became visible (set by startTerminal). */
  readyAt: number | undefined

  /** Kills the whole process tree and verifies every pid is gone (see minUptimeBeforeKill). */
  async kill(): Promise<void> {
    const minUp = this.opts.minUptimeBeforeKill ?? 11_000
    if (this.alive && this.readyAt !== undefined) { const wait = this.readyAt + minUp - Date.now(); if (wait > 0) { this.mark('kill: waiting for min uptime', { wait }); await sleep(wait) } }
    this.mark('kill')
    const procs = await this.tree()
    if (this.alive) await killTree(this.pid)
    this.dispose()
    const left = await waitGone(procs, 15_000)
    await Promise.race([this.exited, sleep(3_000)])
    if (this.alive) { this.exitCode = -1; for (const l of this.listeners) l() }
    if (left.length) throw new Error(`processes still alive after kill: ${describe(left)}`)
  }
}

/** Spawns the agent, accepts the trust dialog if it appears, and returns once the TUI is idle at its prompt. */
export async function startTerminal(plan: LaunchPlan, opts: StartOptions = {}): Promise<Terminal> {
  const t = new Terminal(plan, opts)
  const timeout = opts.startupTimeout ?? 60_000
  try {
    // the trust dialog's "❯ No, exit" is indented; the input box's ❯ is at column 0
    await t.waitFor(s => TRUST.test(s) || /^❯/m.test(s), { timeout, what: 'trust dialog or input prompt' })
    t.readyAt = Date.now()
    if (TRUST.test(t.screen())) {
      if (opts.trust === false) throw new Error('agent asked to trust the folder and trust:false was given')
      t.mark('trust')
      // The dialog re-renders shortly after it first appears and resets the selection to "No, exit",
      // so: let it settle, press Down, and only confirm once "Yes" has stayed highlighted through a quiet period.
      await t.quiet(500, timeout)
      for (let attempt = 1; ; attempt++) {
        t.write('\x1b[B')
        await t.waitFor(TRUST_YES, { timeout: 5_000, what: 'trust "Yes" highlighted' })
        await t.quiet(400, 5_000)
        if (TRUST_YES.test(t.screen())) break
        if (attempt === 3) throw new Error(`trust dialog keeps resetting its selection\n--- screen ---\n${t.screen()}`)
      }
      t.write('\r')
      await t.waitFor(s => !TRUST.test(s) && /^❯/m.test(s), { timeout, what: 'input prompt after trust' })
      t.readyAt = Date.now()
    }
    await t.waitIdle({ timeout })
    t.mark('ready')
    return t
  } catch (e) {
    await t.kill().catch(() => {})
    throw e
  }
}
