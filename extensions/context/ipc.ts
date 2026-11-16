// The context extension's channels between its renderer and main sides (the bus `ext:context:<channel>`). Payloads are
// small and carry no secret: the inventory view holds names, sizes and token estimates only (hook commands arrive
// already redacted by src/context/inventory.ts).
import type { ContextReport } from '../../src/context/context-report.ts'

export type { ContextReport }

export interface LiveView {
  model: string
  modelId: string
  effort: string
  /** 0..100 as the statusline printed it; undefined before the first API response. */
  usedPct: number | undefined
  windowSize: number | undefined
  usedTokens: number | undefined
  costUsd: number | undefined
  exceeds200k: boolean
  sessionId: string
  /** Epoch ms of the statusline write. */
  at: number
}

/** One turn, compact: [ts, ctxTokens, cacheRead, cacheCreate, input, output, sidechain(0|1)]. */
export type TurnRow = readonly [number, number, number, number, number, number, number]

export interface JumpView {
  /** Index into `turns`. */
  index: number
  delta: number
}

export interface TranscriptView {
  /** Identity of this content; the renderer sends it back and gets 'same' when nothing changed. */
  rev: string
  turns: TurnRow[]
  /** The 1-based number of the first sent turn in the session. */
  firstTurn: number
  jumps: JumpView[]
  totals: { turns: number; input: number; cacheRead: number; cacheCreate: number; output: number }
  /** Cache hit share of the last turn, 0..1; undefined without turns. */
  cacheHit: number | undefined
  /** The last turn read nothing from the cache. */
  cold: boolean
}

export interface SkillView { name: string; scope: string; promptTokens: number; bodyTokens: number }
export interface MemoryView { path: string; kind: string; tokens: number }

export interface InventoryView {
  key: string
  memory: MemoryView[]
  skills: SkillView[]
  agents: SkillView[]
  commands: number
  mcpServers: { name: string; transport: string }[]
  hooks: { event: string; count: number; commands: string[] }[]
  plugins: number
}

export type SnapshotReply =
  | { supported: false; reason: 'not-claude' | 'unknown-slot' }
  | {
      supported: true
      live: LiveView | undefined
      transcript: TranscriptView | 'same' | undefined
      inventory: InventoryView | 'same' | undefined
    }

export type MeasureReply =
  | { supported: false; reason: 'not-claude' | 'unknown-slot' }
  | { supported: true; ok: true; report: ContextReport; measuredAt: number; fromCache: boolean; inventoryKey: string }
  | { supported: true; ok: false; message: string }

export interface SnapshotRequest {
  slotId: string
  cwd: string
  /** The `rev` / inventory key the renderer already holds: unchanged content is answered 'same'. */
  rev?: string
  invKey?: string
}

export interface ContextChannels {
  invoke: {
    snapshot(req: SnapshotRequest): Promise<SnapshotReply>
    measure(req: { slotId: string; cwd: string; force?: boolean }): Promise<MeasureReply>
  }
}
