// The API tetherd hands to each daemon extension's `activate` (F9 §3.4); the daemon's counterpart of
// app/renderer/ext-api.ts (TetherUi). Lives with the daemon because it speaks the daemon's own types.
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { Brand } from '../../app/shared/brand.ts'
import type { AgentContribution, AgentMcp, AgentShare } from '../agents/registry.ts'
import type { LaunchPlan } from '../agents/types.ts'
import type { SlotMeta } from '../core/event.ts'
import type { SlotState } from './protocol.ts'

export type { AgentContribution, AgentMcp, AgentShare }

/** A doctor check an extension contributes (same shape `tether doctor` prints). */
export interface DaemonCheck {
  level: 'OK' | 'AVISO' | 'ERRO'
  name: string
  detail: string
  hint?: string
}

export type SlotEventKind = 'spawned' | 'exited' | 'bound'

/** What a launch middleware knows besides the plan and the slot. */
export interface LaunchContext {
  /** The features enabled for this launch (src/core/features.ts: profile > settings.json > default); empty for a shell. */
  features: ReadonlySet<string>
}

export type LaunchMiddleware = (plan: LaunchPlan, slot: SlotMeta, ctx: LaunchContext) => LaunchPlan

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
   * Rewrites every launch plan (agents and shells), in registration order, before the composed share folder is handed to
   * the agent. web-bridge adds the agent's identity for the bridge while its feature is on.
   */
  launch: { use(mw: LaunchMiddleware): IDisposable }
  /**
   * The content of a feature this extension declares (`contributes.features`), produced at run time: `shareDir()` is
   * asked at every launch that has the feature on and answers the folder (Soul shared-folder layout) or undefined when
   * there is nothing to offer now. Wins over the manifest's static `share`.
   */
  features: { provide(id: string, shareDir: () => string | undefined): IDisposable }
  /** Checks `tether doctor` runs after the core's (src/doctor.ts, through src/agents/load.ts). */
  doctor: { register(check: () => Promise<DaemonCheck>): IDisposable }
  /** Reads a key of <home>/settings.json (undefined when absent or unreadable). */
  settings: { get<T>(key: string): T | undefined }
  /** tetherd.log, prefixed with the extension's id. */
  log(msg: string): void
  onSlot(listener: (ev: { kind: SlotEventKind; slot: SlotState }) => void): IDisposable
}
