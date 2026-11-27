// Where tether keeps its state. Everything lives under one folder (TETHER_HOME):
//   <home>/slots/<slotId>.json      SlotMeta (written once)
//   <home>/slots/<slotId>.jsonl     events (append-only)
//   <home>/slots/<slotId>.run.json  RunInfo (who is running the slot now)
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, posix, resolve, win32 } from 'node:path'

/**
 * The folder as the agent must see it: absolute, with the on-disk casing (realpath.native: Windows keeps
 * the casing it was typed with, but Claude Code matches a session's cwd string exactly, so `d:\atrium`
 * finds none of the sessions recorded under `D:\atrium`) and an upper-case drive letter. A folder that
 * does not exist keeps its path (the caller reports cwd-missing), only the drive letter is fixed.
 */
export async function canonicalDir(path: string): Promise<string> {
  let dir = resolve(path)
  try { dir = await realpath(dir) } catch { /* missing or unreadable: keep what was given */ } // fs/promises' realpath is the native one
  return upperDrive(dir)
}

/** Upper-case drive letter, the one half of `canonicalDir` that needs no disk (paths-sync.ts does the other half synchronously). */
export function upperDrive(dir: string): string {
  return dir.replace(/^([a-z]):/, (_m, drive: string) => `${drive.toUpperCase()}:`)
}

/** The OS facts the default folders depend on; tests inject their own. */
export interface PlatformInfo {
  platform?: NodeJS.Platform
  homedir?: string
}

export function tetherHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.TETHER_HOME?.trim()
  if (fromEnv) return fromEnv
  return defaultTetherHome(env)
}

/** The platform's tetherHome when TETHER_HOME is not set. */
export function defaultTetherHome(env: NodeJS.ProcessEnv = process.env, os: PlatformInfo = {}): string {
  const platform = os.platform ?? process.platform
  const home = os.homedir ?? homedir()
  const p = platform === 'win32' ? win32 : posix
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA?.trim()
    return p.join(local || p.join(home, 'AppData', 'Local'), 'tether')
  }
  return p.join(home, '.local', 'state', 'tether')
}

/** The remote's bench variables: the flag and its knobs (idle, tick, notice file, deny-after). */
export const REMOTE_BENCH_ENV = /^TETHER_TEST_REMOTE(_[A-Z_]+)?$/i

/**
 * The one decision on the remote's bench flag: it counts only with TETHER_TEST_REMOTE=1 AND an explicit bench home. Under the
 * person's default home it is ignored, so a variable set by a script cannot put the real tetherd in bench mode.
 */
export function remoteBenchOn(env: NodeJS.ProcessEnv, home: string | undefined, os: PlatformInfo = {}): boolean {
  if (env.TETHER_TEST_REMOTE !== '1') return false
  const h = home?.trim()
  if (!h) return false
  return !samePath(h, defaultTetherHome(env, os), os.platform ?? process.platform)
}

/** An environment without any remote bench variable: what tetherd inherits when a CLI or the app starts it. */
export function withoutRemoteBench(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) if (!REMOTE_BENCH_ENV.test(k)) out[k] = v
  return out
}

/** Same folder by its spelling: normalized, no trailing separator, case-insensitive on Windows. No disk access. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = platform === 'win32' ? win32 : posix
  const norm = (s: string): string => {
    let n = p.normalize(s.trim())
    while (n.length > 1 && /[\\/]$/.test(n) && !/^[A-Za-z]:[\\/]$/.test(n)) n = n.slice(0, -1)
    return platform === 'win32' ? n.toLowerCase() : n
  }
  return norm(a) === norm(b)
}

/**
 * Where the person's own configuration lives (settings.json, keybindings.json, sync/), apart from the machine's state in
 * `tetherHome`: TETHER_USER_DIR, else TETHER_HOME when it overrides the platform default (tests, a dev instance stay
 * inside their own home), else `~/.tether`. A TETHER_HOME that spells the default home is no override: the panes get it
 * explicitly, and every process of one tether must resolve the same folder.
 */
export function userDir(env: NodeJS.ProcessEnv = process.env, os: PlatformInfo = {}): string {
  const fromUser = env.TETHER_USER_DIR?.trim()
  if (fromUser) return fromUser
  const platform = os.platform ?? process.platform
  const home = os.homedir ?? homedir()
  const fromHome = env.TETHER_HOME?.trim()
  if (fromHome && !samePath(fromHome, defaultTetherHome(env, os), platform)) return fromHome
  return (platform === 'win32' ? win32 : posix).join(home, '.tether')
}

export function slotsDir(home: string): string {
  return join(home, 'slots')
}

export function slotMetaPath(home: string, slotId: string): string {
  return join(slotsDir(home), `${slotId}.json`)
}

export function slotEventsPath(home: string, slotId: string): string {
  return join(slotsDir(home), `${slotId}.jsonl`)
}

export function slotRunPath(home: string, slotId: string): string {
  return join(slotsDir(home), `${slotId}.run.json`)
}

export function logPath(home: string): string {
  return join(home, 'tether.log')
}

/** The Claude hook's last attention report (Stop / Notification): one small JSON object, rewritten each time. */
export function slotAttentionPath(home: string, slotId: string): string {
  return join(slotsDir(home), `${slotId}.attention`)
}

/** The last answer of the slot's agent (Claude Stop / Codex notify), written by the reporters: `{ ts, sessionId?, text, from }`, replaced each turn.
 * The reporters (`src/report/*.mjs`) cannot import this file and spell the name `<slot>.answer.json` themselves; a test holds both to it. */
export function slotAnswerPath(home: string, slotId: string): string {
  return join(slotsDir(home), `${slotId}.answer.json`)
}

/** The pause batch (one active at a time): <home>/pause.json. */
export function pausePath(home: string): string {
  return join(home, 'pause.json')
}

/** The pending polite pause request for a slot, read by the Claude hook. */
export function slotPauseRequestPath(home: string, slotId: string): string {
  return join(slotsDir(home), `${slotId}.pause-request.json`)
}

/** The agent's pause reports for a slot (jsonl: delivered, ack, done, stop). */
export function slotPauseReportPath(home: string, slotId: string): string {
  return join(slotsDir(home), `${slotId}.pause.jsonl`)
}

// Background processes managed by tether (tether proc):
//   <home>/procs/<name>.json            ProcCard (the recipe; tetherd writes it)
//   <home>/procs/<name>.jsonl           history (append-only; tetherd is its only writer)
//   <home>/procs/<name>.run.json        the current run (pid, start time, exit; only tether-procd writes it)
//   <home>/procs/<name>/logs/run-<n>.log clean text, one line per output line (only tether-procd writes it)
//   <home>/procs/<name>.uses.json       declared uses in force (who, until when, what for; tetherd writes it)
//   <home>/procs/<name>.adopt.json      identity of an adopted outside process: pid + creation time (tetherd writes it)

export function procsDir(home: string): string {
  return join(home, 'procs')
}

export function procCardPath(home: string, name: string): string {
  return join(procsDir(home), `${name}.json`)
}

export function procEventsPath(home: string, name: string): string {
  return join(procsDir(home), `${name}.jsonl`)
}

export function procRunPath(home: string, name: string): string {
  return join(procsDir(home), `${name}.run.json`)
}

export function procUsesPath(home: string, name: string): string {
  return join(procsDir(home), `${name}.uses.json`)
}

export function procAdoptPath(home: string, name: string): string {
  return join(procsDir(home), `${name}.adopt.json`)
}

export function procLogsDir(home: string, name: string): string {
  return join(procsDir(home), name, 'logs')
}

export function procLogPath(home: string, name: string, run: number): string {
  return join(procLogsDir(home, name), `run-${run}.log`)
}

/** The slot's ronda (tether's nudge clock): interval, extra nudge, stop criterion, next due time. */
export function slotRondaPath(home: string, slotId: string): string {
  return join(slotsDir(home), `${slotId}.ronda.json`)
}

/** Notices tetherd leaves for the slot's agent (one JSON line each); the agent's hook takes them on its next step. */
export function slotNoticesPath(home: string, slotId: string): string {
  return join(slotsDir(home), `${slotId}.notices.jsonl`)
}
