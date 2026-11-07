// The Faults screen's channels between its renderer and main sides (the bus `ext:faults:<channel>`). Main is the only side
// that touches the registry's files (src/core/faults-ops.ts, under the registry's lock, like the CLI); the renderer gets
// plain data and asks for changes by verb. Main validates every argument: they come from the renderer.
import type { FaultDetail, FaultRow } from '../../src/core/faults-ops.ts'

/** What the screen may ask of a fault; main adds the author ("você"). */
export type ScreenAction =
  | { type: 'investigate' }
  | { type: 'done'; fix?: string }
  | { type: 'ignore' }
  | { type: 'reopen' }
  | { type: 'tag'; tags: string[]; remove?: boolean }
  | { type: 'note'; text: string }

export interface FaultsList {
  ok: true
  rows: FaultRow[]
  /** jsonl lines that could not be read (counted; the screen says so, it does not stop). */
  skipped: number
  /** The registry could not be read (permission, locked file): what it said. Rows are what could be read anyway. */
  readError?: string
  /** faults-state.json was unreadable or had to be recreated: status, tags and notes may not have loaded. */
  stateProblem?: string
  /** The registry folder (for "Abrir pasta"). */
  dir: string
  /** The running build: the Resolver form offers its commit as the fix. */
  build: { version: string; commit?: string }
  /** When the person last had the screen open (ISO); a fault first seen, or returned, after it is "nova". */
  seenAt: string | null
  /** Where "Novo painel" opens: the setting, else the tether source folder when it exists here, else the user's folder. */
  cwd: string
}

export type UpdateOutcome = { ok: true; id: string; changed: boolean } | { ok: false; message: string }

export interface FaultsChannels {
  invoke: {
    list(): FaultsList | { ok: false; message: string }
    /** The detail of one fault: the newest `limit` occurrences (default 20), all of them with `all`. */
    show(id: string, all?: boolean): { ok: true; fault: FaultDetail; skipped: number } | { ok: false; message: string }
    update(id: string, action: ScreenAction): UpdateOutcome
    /** The screen was opened: what is in the registry now stops being "nova". */
    markSeen(): void
  }
  events: {
    /** faults.jsonl or faults-state.json changed on disk (any writer: this app, the daemon, the CLI, an agent). */
    changed(): void
  }
}
