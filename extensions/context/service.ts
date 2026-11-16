// The context extension's service (Electron main side): what `snapshot` and `measure` answer. It holds no timer per agent
// and does no work while nobody asks: a transcript reader is created on the first snapshot of a slot, polled only inside
// a snapshot call (it reads the bytes appended since), and dropped after READER_TTL_MS without a request or beyond
// MAX_READERS (one shared sweep timer, alive only while there are readers). The inventory is read once per folder and
// re-validated by the files' stat, so a call without changes costs a few stats. Secrets: only the inventory view's
// names, sizes and estimates and the live summary's numbers leave this file (the statusline's other fields do not).
// What differs per agent kind (where the session's usage lives, how it is read, what the fixed weight is) comes from a
// provider (providers.ts); a kind without a provider is answered 'not-claude' (kept on the wire: "no context for it").
import { isAbsolute } from 'node:path'
import { statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { cacheHitRatio, detectContextJumps } from '../../src/context/live.ts'
import { inventoryKey, type Inventory } from '../../src/context/inventory.ts'
import { ContextMeter, type MeasureInput, type MeasureResult } from '../../src/context/measure.ts'
import { claudeProvider, codexProvider, soulProvider, liveView, type ContextProvider, type ReaderLike } from './providers.ts'
import type { InventoryView, JumpView, MeasureReply, SnapshotReply, SnapshotRequest, TranscriptView, TurnRow } from './ipc.ts'
import { inventoryForWire, MAX_READERS, MAX_TURNS_SENT, READER_TTL_MS, readersToDrop } from './rules.ts'

/** The inventory is trusted unchanged for this long without even a stat; then its files are re-statted. */
const INVENTORY_TRUST_MS = 5_000
/** A full rescan at least this often (finds files that did not exist before). */
const INVENTORY_RESCAN_MS = 60_000
const MAX_INVENTORIES = 8
const SWEEP_MS = 30_000

export type { ReaderLike }
export { liveView }

export interface ServiceDeps {
  home: string
  /** The agent kind behind a slot id ('claude'…), undefined when unknown (also for a plain shell). */
  agentKind(slotId: string): string | undefined
  now?: () => number
  /** Claude provider overrides (tests). */
  readInventory?: (cwd: string) => Promise<Inventory>
  makeReader?: (path: string) => ReaderLike
  /** Providers by agent kind; default: claude, codex and soul. */
  providers?: Record<string, ContextProvider>
  meter?: { measure(input: MeasureInput): Promise<MeasureResult> }
  isDirectory?: (path: string) => boolean
  /** Replaces the sweep timer in tests: receives the sweep and returns its disposer. */
  schedule?: (fn: () => void, ms: number) => () => void
}

interface ReaderEntry { reader: ReaderLike; path: string; lastUsed: number }
type Gate = { supported: false; reason: 'not-claude' | 'unknown-slot' } | { kind: string; provider: ContextProvider }
interface InvEntry { inv: Inventory; key: string; view: InventoryView; readAt: number; checkedAt: number }

export class ContextService {
  private readonly readers = new Map<string, ReaderEntry>()
  private readonly inventories = new Map<string, InvEntry>()
  private readonly inflightInv = new Map<string, Promise<InvEntry>>()
  private readonly meter: { measure(input: MeasureInput): Promise<MeasureResult> }
  private stopSweep: (() => void) | undefined
  private readonly now: () => number
  private readonly deps: ServiceDeps
  private readonly providers: Record<string, ContextProvider>

  constructor(deps: ServiceDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.providers = deps.providers ?? {
      claude: claudeProvider({ home: deps.home, ...(deps.readInventory ? { readInventory: deps.readInventory } : {}), ...(deps.makeReader ? { makeReader: deps.makeReader } : {}) }),
      codex: codexProvider({ home: deps.home, now: this.now }),
      soul: soulProvider({ home: deps.home }),
    }
    this.meter = deps.meter ?? new ContextMeter({ inventory: async cwd => (await this.inventoryFor('claude', cwd)).inv })
  }

  /** Readers currently held (tests and diagnostics). */
  get readerCount(): number { return this.readers.size }

  async snapshot(req: SnapshotRequest): Promise<SnapshotReply> {
    const gate = this.gate(req.slotId, req.cwd)
    if ('supported' in gate) return gate
    const { kind, provider } = gate
    const session = provider.session(req.slotId)
    const transcript = this.transcriptFor(req.slotId, provider, session.path, req.rev)
    let inventory: InventoryView | 'same' | undefined
    try {
      inventory = inventoryForWire(req.invKey, (await this.inventoryFor(kind, req.cwd)).view)
    } catch {
      inventory = undefined
    }
    const reader = session.path ? this.readers.get(req.slotId)?.reader : undefined
    this.sweep(req.slotId)
    const measured = session.measured?.(reader)
    return { supported: true, agent: kind, canMeasure: provider.canMeasure, live: session.live(reader), transcript, inventory, ...(measured ? { measured } : {}) }
  }

  async measure(req: { slotId: string; cwd: string; force?: boolean }): Promise<MeasureReply> {
    const gate = this.gate(req.slotId, req.cwd)
    if ('supported' in gate) return gate
    if (!gate.provider.canMeasure) return { supported: true, ok: false, message: 'Medir não está disponível para este agente.' }
    const model = gate.provider.session(req.slotId).live(this.readers.get(req.slotId)?.reader)?.modelId || this.lastModel(req.slotId)
    if (!model) return { supported: true, ok: false, message: 'Ainda não sei o modelo desta sessão: espere a primeira resposta do agente e meça de novo.' }
    let key: string
    try {
      key = (await this.inventoryFor(gate.kind, req.cwd)).key
    } catch {
      return { supported: true, ok: false, message: 'Não consegui ler os arquivos da pasta do agente.' }
    }
    const r = await this.meter.measure({ cwd: req.cwd, model, slotKey: req.slotId, ...(req.force ? { force: true } : {}) })
    if (!r.ok) return { supported: true, ok: false, message: r.message }
    return { supported: true, ok: true, report: { ...r.report, unknownSections: [] }, measuredAt: r.measuredAt, fromCache: r.fromCache, inventoryKey: key }
  }

  dispose(): void {
    this.stopSweep?.()
    this.stopSweep = undefined
    this.readers.clear()
    this.inventories.clear()
  }

  // ---------- internals ----------

  private gate(slotId: string, cwd: string): Gate {
    const kind = this.deps.agentKind(slotId)
    if (kind === undefined) return { supported: false, reason: 'unknown-slot' }
    const provider = Object.hasOwn(this.providers, kind) ? this.providers[kind] : undefined
    if (!provider) return { supported: false, reason: 'not-claude' }
    const isDir = this.deps.isDirectory ?? ((p: string) => { try { return statSync(p).isDirectory() } catch { return false } })
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || !isDir(cwd)) return { supported: false, reason: 'unknown-slot' }
    return { kind, provider }
  }

  private lastModel(slotId: string): string {
    return this.readers.get(slotId)?.reader.last()?.model ?? ''
  }

  private transcriptFor(slotId: string, provider: ContextProvider, path: string | undefined, heldRev: string | undefined): TranscriptView | 'same' | undefined {
    if (!path) return undefined
    const now = this.now()
    let e = this.readers.get(slotId)
    if (e && e.path !== path) { this.readers.delete(slotId); e = undefined } // the session changed (clear, resume)
    if (!e) {
      e = { reader: provider.makeReader(path), path, lastUsed: now }
      this.readers.set(slotId, e)
      this.armSweep()
    }
    e.lastUsed = now
    e.reader.poll()
    const ring = e.reader.turns()
    const totals = e.reader.totals()
    const last = e.reader.last()
    const rev = `${path}|${totals.turns}|${last?.id ?? ''}|${last?.ctxTokens ?? 0}|${last?.cacheRead ?? 0}`
    if (heldRev === rev) return 'same'
    const start = Math.max(0, ring.length - MAX_TURNS_SENT)
    const slice = ring.slice(start)
    const turns: TurnRow[] = slice.map(t => [t.ts, t.ctxTokens, t.cacheRead, t.cacheCreate, t.input, t.output, t.sidechain ? 1 : 0])
    const jumps: JumpView[] = detectContextJumps(slice).map(j => ({ index: j.index, delta: j.delta }))
    return {
      rev,
      turns,
      jumps,
      firstTurn: Math.max(0, totals.turns - ring.length) + start + 1,
      totals,
      cacheHit: last ? cacheHitRatio(last) : undefined,
      cold: !!last && last.ctxTokens > 0 && last.cacheRead === 0,
    }
  }

  private sweep(keep?: string): void {
    const now = this.now()
    const drop = readersToDrop([...this.readers].map(([key, e]) => ({ key, lastUsed: e.lastUsed })), now, { ttl: READER_TTL_MS, max: MAX_READERS, ...(keep ? { keep } : {}) })
    for (const k of drop) this.readers.delete(k)
    if (this.readers.size === 0) { this.stopSweep?.(); this.stopSweep = undefined }
  }

  private armSweep(): void {
    if (this.stopSweep) return
    if (this.deps.schedule) { this.stopSweep = this.deps.schedule(() => this.sweep(), SWEEP_MS); return }
    const t = setInterval(() => this.sweep(), SWEEP_MS)
    t.unref()
    this.stopSweep = () => clearInterval(t)
  }

  /** The folder's inventory: trusted for a few seconds, re-statted after that, rescanned when a file changed or after a minute. */
  private async inventoryFor(kind: string, cwd: string): Promise<InvEntry> {
    const now = this.now()
    const id = `${kind} ${cwd}`
    const hit = this.inventories.get(id)
    if (hit) {
      this.inventories.delete(id)
      this.inventories.set(id, hit) // recency
      if (now - hit.checkedAt < INVENTORY_TRUST_MS) return hit
      if (now - hit.readAt < INVENTORY_RESCAN_MS && (await unchanged(hit.inv))) { hit.checkedAt = now; return hit }
    }
    const pending = this.inflightInv.get(id)
    if (pending) return pending
    const job = (async (): Promise<InvEntry> => {
      const inv = await this.providers[kind]!.readInventory(cwd)
      const t = this.now()
      const entry: InvEntry = { inv, key: inventoryKey(inv), view: inventoryView(inv), readAt: t, checkedAt: t }
      entry.view.key = entry.key
      this.inventories.set(id, entry)
      while (this.inventories.size > MAX_INVENTORIES) this.inventories.delete(this.inventories.keys().next().value as string)
      return entry
    })()
    this.inflightInv.set(id, job)
    try { return await job } finally { this.inflightInv.delete(id) }
  }
}

async function unchanged(inv: Inventory): Promise<boolean> {
  try {
    const stats = await Promise.all(inv.files.map(f => stat(f.path)))
    return stats.every((s, i) => s.size === inv.files[i]!.bytes && Math.round(s.mtimeMs) === Math.round(inv.files[i]!.mtimeMs))
  } catch {
    return false // a file vanished
  }
}

export function inventoryView(inv: Inventory): InventoryView {
  return {
    key: '',
    memory: inv.memory.map(m => ({ path: m.path, kind: m.kind, tokens: m.tokens })),
    skills: inv.skills.map(s => ({ name: s.name, scope: s.scope, promptTokens: s.promptTokens, bodyTokens: s.bodyTokens })),
    agents: inv.agents.map(a => ({ name: a.name, scope: a.scope, promptTokens: a.promptTokens, bodyTokens: a.bodyTokens })),
    commands: inv.commands.length,
    mcpServers: inv.mcpServers.map(s => ({ name: s.name, transport: s.transport })),
    hooks: inv.hooks.map(h => ({ event: h.event, count: h.count, commands: h.commands })),
    plugins: inv.plugins.length,
  }
}
