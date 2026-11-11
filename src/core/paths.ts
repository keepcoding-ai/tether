// Where tether keeps its state. Everything lives under one folder (TETHER_HOME):
//   <home>/slots/<slotId>.json      SlotMeta (written once)
//   <home>/slots/<slotId>.jsonl     events (append-only)
//   <home>/slots/<slotId>.run.json  RunInfo (who is running the slot now)
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * The folder as the agent must see it: absolute, with the on-disk casing (realpath.native: Windows keeps
 * the casing it was typed with, but Claude Code matches a session's cwd string exactly, so `d:\atrium`
 * finds none of the sessions recorded under `D:\atrium`) and an upper-case drive letter. A folder that
 * does not exist keeps its path (the caller reports cwd-missing), only the drive letter is fixed.
 */
export function canonicalDir(path: string): string {
  let dir = resolve(path)
  try { dir = realpathSync.native(dir) } catch { /* missing or unreadable: keep what was given */ }
  return dir.replace(/^([a-z]):/, (_m, drive: string) => `${drive.toUpperCase()}:`)
}

export function tetherHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.TETHER_HOME?.trim()
  if (fromEnv) return fromEnv
  if (process.platform === 'win32') {
    const local = env.LOCALAPPDATA?.trim()
    return join(local || join(homedir(), 'AppData', 'Local'), 'tether')
  }
  return join(homedir(), '.local', 'state', 'tether')
}

/**
 * Where the person's own configuration lives (settings.json, keybindings.json), apart from the machine's state in
 * `tetherHome`: TETHER_USER_DIR, else TETHER_HOME when it is set (tests stay inside their temp home), else `~/.tether`.
 */
export function userDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromUser = env.TETHER_USER_DIR?.trim()
  if (fromUser) return fromUser
  const fromHome = env.TETHER_HOME?.trim()
  if (fromHome) return fromHome
  return join(homedir(), '.tether')
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
