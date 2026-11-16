// One "Contexto" board, one data provider per agent kind. A provider says where the slot's session usage lives (a
// transcript/rollout path), builds the incremental reader for it, turns what it read into the board's header (LiveView)
// and reads the folder's fixed-weight inventory. The service owns the pools (readers, inventories) and the wire format;
// providers hold only small caches keyed by slot or session (bounded, re-validated by a stat).
import { statSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { readLiveSummary, TranscriptUsageReader, type LiveSummary, type UsageTotals, type UsageTurn } from '../../src/context/live.ts'
import { readInventory, type Inventory } from '../../src/context/inventory.ts'
import { codexHome, CodexRolloutReader, findCodexRollout, readCodexInventory, type CodexSessionInfo } from '../../src/context/codex.ts'
import { slotEventsPath } from '../../src/core/paths.ts'
import { parseEvents } from '../../src/core/store.ts'
import type { LiveView } from './ipc.ts'

export interface ReaderLike {
  poll(): number
  turns(): readonly UsageTurn[]
  last(): UsageTurn | undefined
  totals(): UsageTotals
}

/** What one snapshot needs from a provider about a slot's current session. */
export interface SessionHandle {
  /** The usage file to read incrementally; undefined before the session wrote one. */
  path: string | undefined
  /** The header, computed after the reader (if any) polled. */
  live(reader: ReaderLike | undefined): LiveView | undefined
}

export interface ContextProvider {
  /** The board offers "Medir" (Claude's /context); other kinds hide it. */
  readonly canMeasure: boolean
  session(slotId: string): SessionHandle
  makeReader(path: string): ReaderLike
  readInventory(cwd: string): Promise<Inventory>
}

// ---------- claude ----------

export interface ClaudeProviderDeps {
  home: string
  readInventory?: (cwd: string) => Promise<Inventory>
  makeReader?: (path: string) => ReaderLike
}

export function claudeProvider(deps: ClaudeProviderDeps): ContextProvider {
  return {
    canMeasure: true,
    session(slotId) {
      const s = readLiveSummary(deps.home, slotId)
      return { path: s?.transcript_path, live: reader => (s ? liveView(s, reader?.last()?.model ?? '') : undefined) }
    },
    makeReader: deps.makeReader ?? (p => new TranscriptUsageReader(p)),
    readInventory: deps.readInventory ?? (c => readInventory(c)),
  }
}

export function liveView(s: LiveSummary, fallbackModel: string): LiveView {
  const cw = s.context_window
  const u = cw?.current_usage
  const fromUsage = u ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) : undefined
  const size = cw?.context_window_size
  const pct = cw?.used_percentage
  const used = fromUsage !== undefined && fromUsage > 0 ? fromUsage : size !== undefined && pct !== undefined ? Math.round((size * pct) / 100) : undefined
  const at = s.at ? Date.parse(s.at) : NaN
  const modelId = s.model?.id || fallbackModel
  return {
    model: s.model?.display_name || modelId || 'modelo desconhecido',
    modelId,
    effort: s.effort?.level ?? '',
    usedPct: pct,
    windowSize: size,
    usedTokens: used,
    costUsd: s.cost?.total_cost_usd,
    exceeds200k: s.exceeds_200k_tokens === true,
    sessionId: s.session_id ?? '',
    at: Number.isFinite(at) ? at : 0,
  }
}

// ---------- codex ----------

export interface CodexProviderDeps {
  /** tether's home (slot events live in <home>/slots). */
  home: string
  codexHome?: string
  /** The slot's current session id; default: the last `start` event in the slot's events file. */
  sessionOf?: (slotId: string) => string | undefined
  readInventory?: (cwd: string) => Promise<Inventory>
  now?: () => number
}

/** A rollout not found yet is looked up again after this long (the file appears with the first turn). */
const MISS_RETRY_MS = 5_000
const MAX_CACHED = 64

const cap = <K, V>(m: Map<K, V>): void => { while (m.size > MAX_CACHED) m.delete(m.keys().next().value as K) }

export function codexProvider(deps: CodexProviderDeps): ContextProvider {
  const ch = deps.codexHome ?? codexHome()
  const now = deps.now ?? Date.now
  const bindings = new Map<string, { size: number; mtimeMs: number; sessionId: string | undefined }>()
  const rollouts = new Map<string, { path: string | undefined; at: number }>()

  const sessionFromEvents = (slotId: string): string | undefined => {
    if (!/^[\w-]+$/.test(slotId)) return undefined
    const p = slotEventsPath(deps.home, slotId)
    let st
    try { st = statSync(p) } catch { return undefined }
    const hit = bindings.get(slotId)
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.sessionId
    let sessionId: string | undefined
    try {
      const events = parseEvents(readFileSync(p, 'utf8'))
      for (let i = events.length - 1; i >= 0; i--) if (events[i]!.kind === 'start') { sessionId = events[i]!.sessionId; break }
    } catch { /* unreadable: no session */ }
    bindings.set(slotId, { size: st.size, mtimeMs: st.mtimeMs, sessionId })
    cap(bindings)
    return sessionId
  }

  const rolloutOf = (sessionId: string): string | undefined => {
    const hit = rollouts.get(sessionId)
    if (hit && (hit.path || now() - hit.at < MISS_RETRY_MS)) return hit.path
    const path = findCodexRollout(sessionId, ch)
    rollouts.set(sessionId, { path, at: now() })
    cap(rollouts)
    return path
  }

  return {
    canMeasure: false,
    session(slotId) {
      const id = (deps.sessionOf ?? sessionFromEvents)(slotId)
      const path = id ? rolloutOf(id) : undefined
      return { path, live: reader => (reader && 'info' in reader ? codexLiveView((reader as CodexRolloutReader).info()) : undefined) }
    },
    makeReader: p => new CodexRolloutReader(p),
    readInventory: deps.readInventory ?? (c => readCodexInventory(c, { codexHome: ch })),
  }
}

export function codexLiveView(s: CodexSessionInfo): LiveView | undefined {
  if (!s.model && s.usedTokens === undefined) return undefined
  const pct = s.usedTokens !== undefined && s.windowSize ? (s.usedTokens / s.windowSize) * 100 : undefined
  return {
    model: s.model || 'modelo desconhecido',
    modelId: s.model,
    effort: s.effort,
    usedPct: pct,
    windowSize: s.windowSize,
    usedTokens: s.usedTokens,
    // The rollout carries no price: no cost is shown for Codex.
    costUsd: undefined,
    exceeds200k: false,
    sessionId: s.sessionId,
    at: s.at,
  }
}
