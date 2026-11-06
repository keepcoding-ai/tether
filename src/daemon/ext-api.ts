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
  /**
   * Which process activated the extension: `tetherd` (the long-lived daemon that owns the slots; the place for
   * side effects such as files written at startup or processes warmed up) or a `satellite` (the CLI, Electron main:
   * they activate the daemon extensions only to read their agents and doctor checks, and run many times).
   */
  readonly process: 'tetherd' | 'satellite'
  agents: { register(agent: AgentContribution): IDisposable }
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
