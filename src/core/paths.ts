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
