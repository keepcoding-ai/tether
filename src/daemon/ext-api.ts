// The API tetherd hands to each daemon extension's `activate` (F9 §3.4); the daemon's counterpart of
// app/renderer/ext-api.ts (TetherUi). Lives with the daemon because it speaks the daemon's own types.
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { Brand } from '../../app/shared/brand.ts'
import type { AgentContribution, AgentMcp } from '../agents/registry.ts'
import type { LaunchPlan } from '../agents/types.ts'
import type { SlotMeta } from '../core/event.ts'
import type { Profile } from '../core/profile.ts'
import type { SlotState } from './protocol.ts'
import type { TraceSource } from '../trace/timeline.ts'

export type { AgentContribution, AgentMcp, TraceSource }

/** A doctor check an extension contributes (same shape `tether doctor` prints). */
export interface DaemonCheck {
  level: 'OK' | 'AVISO' | 'ERRO'
  name: string
  detail: string
  hint?: string
}

/**
 * `removed`: the slot was forgotten (its pane closed for good); after it no event of that slot comes. `changed`: the text
 * the pane's tab shows (app/shared/agent-info.ts slotTitle: the slot's name, else its session title, else its folder)
 * changed, live (a rename, a title the agent set); an agent slot only.
 */
export type SlotEventKind = 'spawned' | 'exited' | 'bound' | 'removed' | 'changed'

/**
 * The disk, as an extension may touch it (`api.io`): every call is asynchronous and, inside tetherd, runs on the executor's
 * worker, in order (one FIFO lane). Reads that find nothing reject with `code: 'ENOENT'`; `tryReadText` answers undefined.
 * `writeTextAtomic` creates the parent folders and writes temp + rename with owner-only mode.
 */
export interface DaemonIo {
  readText(path: string): Promise<string>
  tryReadText(path: string): Promise<string | undefined>
  writeTextAtomic(path: string, text: string): Promise<void>
  appendText(path: string, text: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** Recursive and forgiving: a missing path is not an error. */
  rm(path: string): Promise<void>
  mkdirp(path: string): Promise<void>
  stat(path: string): Promise<{ size: number; mtimeMs: number; isFile: boolean; isDirectory: boolean }>
  readdir(path: string): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean }>>
  exists(path: string): Promise<boolean>
}

export interface TetherDaemon {
  /** The extension's id (manifest.id). */
  readonly id: string
  /** The product's identity (app/shared/brand.ts). */
  readonly brand: Brand
  /** TETHER_HOME. */
  readonly home: string
  agents: {
    register(agent: AgentContribution): IDisposable
    /** The contribution registered under `name` (any extension's), undefined for 'shell' or an unknown agent. */
    get(name: string): AgentContribution | undefined
  }
  /**
   * Runs `listener` once tetherd owns its pipe and pid file (after every extension activated): the place for side effects
   * such as files written at startup or a helper process warmed up. The loser of a pipe race never gets here, and the
   * CLI and Electron main (which activate the daemon extensions only to read their agents and checks) never fire it.
   * A listener registered after the start runs at once.
   */
  onStarted(listener: () => void): IDisposable
  /**
   * Rewrites every launch plan (agents and shells), in registration order. F7 C3: web-bridge adds its --mcp-config to every
   * agent. `state` is the slot as the app sees it at that launch (its tab's text, a resumed session's title).
   * A middleware may return a promise: the next one waits for it. One that takes longer than the host's ceiling (10 s) is
   * logged and skipped (the launch goes on with the plan it was given).
   */
  launch: { use(mw: (plan: LaunchPlan, slot: SlotMeta, state?: SlotState) => LaunchPlan | Promise<LaunchPlan>): IDisposable }
  /** Checks `tether doctor` runs after the core's (src/doctor.ts, through src/agents/load.ts). */
  doctor: { register(check: () => Promise<DaemonCheck>): IDisposable }
  /** The logs `tether trace` reads (src/trace/timeline.ts, through src/agents/load.ts): the agents' browser tools register theirs. */
  traces: { register(source: TraceSource): IDisposable }
  /** Reads a key of <home>/settings.json (undefined when absent or unreadable). */
  settings: { get<T>(key: string): T | undefined }
  /** The launch profiles (<home>/profiles.json, re-read when it changes on disk). */
  profiles: { get(id: string): Profile | undefined }
  /** The disk facade: the only way a daemon extension reads or writes files. */
  io: DaemonIo
  /** tetherd.log, prefixed with the extension's id. */
  log(msg: string): void
  onSlot(listener: (ev: { kind: SlotEventKind; slot: SlotState }) => void): IDisposable
}
