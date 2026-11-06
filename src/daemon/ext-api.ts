// The API tetherd hands to each daemon extension's `activate` (F9 §3.4); the daemon's counterpart of
// app/renderer/ext-api.ts (TetherUi). Lives with the daemon because it speaks the daemon's own types.
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { Brand } from '../../app/shared/brand.ts'
import type { AgentContribution } from '../agents/registry.ts'
import type { LaunchPlan } from '../agents/types.ts'
import type { SlotMeta } from '../core/event.ts'
import type { SlotState } from './protocol.ts'

export type { AgentContribution }

/** A doctor check an extension contributes (same shape `tether doctor` prints). */
export interface DaemonCheck {
  level: 'OK' | 'AVISO' | 'ERRO'
  name: string
  detail: string
  hint?: string
}

export type SlotEventKind = 'spawned' | 'exited' | 'bound'

export interface TetherDaemon {
  /** The extension's id (manifest.id). */
  readonly id: string
  /** The product's identity (app/shared/brand.ts). */
  readonly brand: Brand
  /** TETHER_HOME. */
  readonly home: string
  agents: { register(agent: AgentContribution): IDisposable }
  /**
   * Runs `listener` once tetherd owns its pipe and pid file (after every extension activated): the place for side effects
   * such as files written at startup or a helper process warmed up. The loser of a pipe race never gets here, and the
   * CLI and Electron main (which activate the daemon extensions only to read their agents and checks) never fire it.
   * A listener registered after the start runs at once.
   */
  onStarted(listener: () => void): IDisposable
  /** Rewrites every launch plan (agents and shells), in registration order. F7: inject --mcp-config in every agent. */
  launch: { use(mw: (plan: LaunchPlan, slot: SlotMeta) => LaunchPlan): IDisposable }
  /** Checks `tether doctor` runs after the core's (src/doctor.ts, through src/agents/load.ts). */
  doctor: { register(check: () => Promise<DaemonCheck>): IDisposable }
  /** Reads a key of <home>/settings.json (undefined when absent or unreadable). */
  settings: { get<T>(key: string): T | undefined }
  /** tetherd.log, prefixed with the extension's id. */
  log(msg: string): void
  onSlot(listener: (ev: { kind: SlotEventKind; slot: SlotState }) => void): IDisposable
}
