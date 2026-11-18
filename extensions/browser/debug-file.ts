// The browser's debug mode, the tether's side (tether-bridge-debug T1): the person's settings (`extensions.browser.debug`,
// `debugActionTimeoutSec`, `debugSnapshotTimeoutSec`) become <home>/browser/debug.json, next to endpoint.json, which the
// vendored server re-reads by mtime at every call (packages/browser call-trace.ts DebugState). So the mode turns on and off
// live, with no agent or app relaunch. The contract:
//   { "enabled": boolean, "actionTimeoutMs"?: number, "snapshotTimeoutMs"?: number }
// `0` = no deadline; a field left out = the server's own default (a setting the person never set, or reset); a missing
// file = off. Turned off, the file says `{ "enabled": false }` alone. Written atomically, and only when its text changed.
// The debug mode relaxes deadlines only: the consent gates (tab control, local network, upload, egress) stay as they are.
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SettingReader } from '../../app/shared/vscode-configuration-registry.ts'
import { writeAtomicRetry } from './atomic-file.ts'
import { debugOn } from './rules.ts'

export const DEBUG_FILE = 'debug.json'

/** <home>/browser/debug.json. */
export const debugFileOf = (home: string): string => join(home, 'browser', DEBUG_FILE)

/** What the file holds (the server's DebugState, with `enabled: false` for off). */
export interface BrowserDebugState {
  enabled: boolean
  actionTimeoutMs?: number
  snapshotTimeoutMs?: number
}

/** Seconds as typed on the settings page → whole milliseconds (0 stays 0: no deadline). */
const msOf = (sec: number): number => Math.max(0, Math.round(sec * 1000))

/** The settings → the file's content. A timeout only counts when the person set it; off carries no timeout. */
export function debugStateOf(s: SettingReader): BrowserDebugState {
  if (!debugOn(s)) return { enabled: false }
  const out: BrowserDebugState = { enabled: true }
  const action = s.get('debugActionTimeoutSec')
  const snapshot = s.get('debugSnapshotTimeoutSec')
  if (s.isSet('debugActionTimeoutSec') && typeof action === 'number') out.actionTimeoutMs = msOf(action)
  if (s.isSet('debugSnapshotTimeoutSec') && typeof snapshot === 'number') out.snapshotTimeoutMs = msOf(snapshot)
  return out
}

/** The doctor's words for the state: "desligada", or "ligada" with the deadlines in force. */
export function debugSummary(state: BrowserDebugState): string {
  if (!state.enabled) return 'desligada'
  const t = (ms: number | undefined): string => (ms === undefined ? 'o normal' : ms === 0 ? 'sem prazo' : `${ms / 1000} s`)
  return `ligada (prazo de cada ação: ${t(state.actionTimeoutMs)}; para ler a página: ${t(state.snapshotTimeoutMs)})`
}

/** The file's text for a state (one line, the contract's field order). */
export const debugFileText = (state: BrowserDebugState): string => JSON.stringify(state) + '\n'

/** Writes <home>/browser/debug.json when its text changed. Returns whether it was written. */
export async function writeDebugFile(home: string, state: BrowserDebugState): Promise<boolean> {
  const file = debugFileOf(home)
  const text = debugFileText(state)
  let current: string | undefined
  try { current = await readFile(file, 'utf8') } catch { /* missing */ }
  if (current === text) return false
  await mkdir(join(home, 'browser'), { recursive: true })
  await writeAtomicRetry(file, text)
  return true
}

/** The keys whose change rewrites the file. */
export const DEBUG_KEYS = ['debug', 'debugActionTimeoutSec', 'debugSnapshotTimeoutSec'] as const

/**
 * The live writer: `sync()` writes the file from the settings in force, one write at a time (a burst of changes ends with the
 * last state on disk). Called at activation and at every change of a DEBUG_KEYS setting. A failed write is logged, never thrown.
 */
export function createDebugWriter(o: { home: string; settings: SettingReader; log(msg: string): void }): { sync(): Promise<void> } {
  let chain: Promise<void> = Promise.resolve()
  // A missing file is "off": the start of an app that has the mode off logs nothing.
  let last = false
  const once = async (): Promise<void> => {
    const state = debugStateOf(o.settings)
    try {
      const written = await writeDebugFile(o.home, state)
      if (written && last !== state.enabled) o.log(`modo de depuração ${state.enabled ? 'ligado' : 'desligado'} (${DEBUG_FILE} gravado)`)
      last = state.enabled
    } catch (e) {
      o.log(`${DEBUG_FILE} não gravado: ${(e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : String(e))}`)
    }
  }
  return { sync: () => (chain = chain.then(once)) }
}
