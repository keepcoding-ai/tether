// Pure rules of the context extension, shared by its main service and its renderer: number formatting, thresholds,
// ordering, the chart's geometry, the stacked composition, what changed between two snapshots, and the policy that drops
// idle transcript readers. No Electron, no DOM, no clock of its own.
import type { ContextCategory } from '../../src/context/context-report.ts'
import type { InventoryView, JumpView, SnapshotReply, TurnRow, SkillView } from './ipc.ts'

// ---------- formatting (pt-BR) ----------

const nf1 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 })
const nf0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 })

/** 950 -> "950", 12_345 -> "12,3k", 1_250_000 -> "1,3M". */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return '–'
  const a = Math.abs(n)
  if (a < 1000) return nf0.format(n)
  if (a < 1_000_000) return `${nf1.format(n / 1000)}k`
  return `${nf1.format(n / 1_000_000)}M`
}

/** 0.5 -> "0,5%", 42.04 -> "42%": one decimal under 10, none above. */
export function fmtPct(p: number): string {
  if (!Number.isFinite(p)) return '–'
  return `${p < 10 ? nf1.format(p) : nf0.format(p)}%`
}

export function fmtUsd(v: number): string {
  if (!Number.isFinite(v)) return '–'
  return `US$ ${v < 1 ? v.toFixed(3) : v.toFixed(2)}`.replace('.', ',')
}

// ---------- thresholds ----------

export type UsageLevel = 'ok' | 'warn' | 'crit'

/** The usage bar's colour point: warn from 80%, crit from 90%. */
export function usageLevel(pct: number | undefined): UsageLevel {
  if (pct === undefined || !Number.isFinite(pct)) return 'ok'
  return pct >= 90 ? 'crit' : pct >= 80 ? 'warn' : 'ok'
}

// ---------- ordering ----------

export type SortDir = 'asc' | 'desc'
export interface SortState { key: string; dir: SortDir }

/** Next state of a column header click: a new column starts descending (biggest first; names ascending), the same one flips. */
export function nextSort(cur: SortState, key: string): SortState {
  return cur.key === key ? { key, dir: cur.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: key === 'name' ? 'asc' : 'desc' }
}

/** A new array ordered by a column (numbers numerically, text with pt-BR collation); ties keep the name order. */
export function sortRows<T>(rows: readonly T[], sort: SortState, get: (row: T, key: string) => number | string): T[] {
  const sign = sort.dir === 'asc' ? 1 : -1
  const coll = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' })
  return [...rows].sort((a, b) => {
    const x = get(a, sort.key)
    const y = get(b, sort.key)
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : coll.compare(String(x), String(y))
    return c !== 0 ? sign * c : coll.compare(String(get(a, 'name')), String(get(b, 'name')))
  })
}

export interface Consumer { label: string; tokens: number; group: string }

/** The `n` biggest permanent consumers across the inventory (what stays in the prompt, never an invoked body). */
export function topConsumers(inv: InventoryView, n = 5, mcpTokens?: ReadonlyMap<string, number>): Consumer[] {
  const all: Consumer[] = [
    ...inv.memory.map(m => ({ label: baseName(m.path), tokens: m.tokens, group: 'Memória' })),
    ...inv.skills.map(s => ({ label: s.name, tokens: s.promptTokens, group: 'Skill' })),
    ...inv.agents.map(a => ({ label: a.name, tokens: a.promptTokens, group: 'Agente' })),
    ...(mcpTokens ? [...mcpTokens].map(([server, tokens]) => ({ label: server, tokens, group: 'MCP' })) : []),
  ]
  return all.sort((a, b) => b.tokens - a.tokens).slice(0, n)
}

export function baseName(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/** Tokens per MCP server from a measured report (an item's `source` is its server; else it is read from "mcp__server__tool"). */
export function mcpByServer(items: readonly { name: string; source: string; tokens: number }[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const it of items) {
    const server = it.source || /^mcp__(.+?)__/.exec(it.name)?.[1] || 'MCP'
    out.set(server, (out.get(server) ?? 0) + it.tokens)
  }
  return out
}

// ---------- composition ----------

export interface Segment { name: string; tokens: number; pct: number; kind: 'free' | 'buffer' | 'used' }

/** The stacked bar's segments: each category's share of the window (`pct` 0..100); free space and the autocompact buffer are told apart. */
export function compositionSegments(categories: readonly ContextCategory[], windowSize: number | undefined): Segment[] {
  const sum = categories.reduce((s, c) => s + c.tokens, 0)
  const total = windowSize && windowSize > 0 ? windowSize : sum
  if (total <= 0) return []
  return categories.filter(c => c.tokens > 0).map(c => ({
    name: c.name,
    tokens: c.tokens,
    pct: (c.tokens / total) * 100,
    kind: /free/i.test(c.name) ? 'free' as const : /autocompact|buffer/i.test(c.name) ? 'buffer' as const : 'used' as const,
  }))
}

/** Estimated composition from the disk inventory (the fixed weight only): memory, skills' prompt, agents' prompt. */
export function estimatedCategories(inv: InventoryView): ContextCategory[] {
  const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0)
  return [
    { name: 'Memory files', tokens: sum(inv.memory.map(m => m.tokens)), percent: undefined, approx: true },
    { name: 'Skills', tokens: sum(inv.skills.map(s => s.promptTokens)), percent: undefined, approx: true },
    { name: 'Custom agents', tokens: sum(inv.agents.map(a => a.promptTokens)), percent: undefined, approx: true },
  ]
}

// ---------- the curve ----------

export interface CurveGeometry {
  /** SVG polyline points. */
  line: string
  /** Pixel positions of the large jumps. */
  marks: { x: number; y: number; index: number; delta: number }[]
  max: number
  /** Index of the turn nearest to an x in the chart's box (hover/keyboard). */
  indexAt(x: number): number
}

export function curveGeometry(turns: readonly TurnRow[], jumps: readonly JumpView[], w: number, h: number, pad = 4): CurveGeometry {
  const n = turns.length
  const max = Math.max(1, ...turns.map(t => t[1]))
  const xOf = (i: number): number => (n <= 1 ? w / 2 : pad + (i * (w - 2 * pad)) / (n - 1))
  const yOf = (v: number): number => h - pad - (v / max) * (h - 2 * pad)
  const round = (v: number): number => Math.round(v * 10) / 10
  return {
    line: turns.flatMap((t, i) => (t[6] ? [] : [`${round(xOf(i))},${round(yOf(t[1]))}`])).join(' '),
    marks: jumps.filter(j => j.index >= 0 && j.index < n).map(j => ({ x: round(xOf(j.index)), y: round(yOf(turns[j.index]![1])), index: j.index, delta: j.delta })),
    max,
    indexAt: x => (n <= 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((x - pad) * (n - 1)) / (w - 2 * pad))))),
  }
}

/** "turno 42 · 14:03 · 123k (+34k)": the label of one point of the curve. */
export function turnLabel(turns: readonly TurnRow[], index: number, firstTurnNumber: number): string {
  const t = turns[index]
  if (!t) return ''
  const prev = index > 0 ? turns[index - 1] : undefined
  const when = t[0] > 0 ? new Date(t[0]).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '–'
  const delta = prev && prev[6] === t[6] ? t[1] - prev[1] : undefined
  const d = delta !== undefined && delta !== 0 ? ` (${delta > 0 ? '+' : '−'}${fmtTokens(Math.abs(delta))})` : ''
  return `turno ${firstTurnNumber + index} · ${when} · ${fmtTokens(t[1])}${d}`
}

// ---------- what changed ----------

export type Section = 'head' | 'compose' | 'fixed' | 'curve'
const SECTIONS: readonly Section[] = ['head', 'compose', 'fixed', 'curve']

/** Cheap content signatures per section; the renderer repaints only the sections whose signature differs. */
export function sectionSigs(r: Extract<SnapshotReply, { supported: true }>, held: { inventoryKey: string; transcriptRev: string }): Record<Section, string> {
  const l = r.live
  const head = l ? [l.modelId, l.effort, l.usedPct, l.windowSize, l.usedTokens, l.costUsd, l.exceeds200k].join('|') : '-'
  const t = r.transcript
  const tr = t === 'same' ? held.transcriptRev : t?.rev ?? '-'
  const inv = r.inventory === 'same' ? held.inventoryKey : r.inventory?.key ?? '-'
  return { head: `${head}#${tr}`, compose: `${inv}|${l?.windowSize ?? ''}`, fixed: inv, curve: tr }
}

/** Sections whose signature changed since `prev` (all of them for the first snapshot). */
export function diffSections(prev: Record<Section, string> | undefined, next: Record<Section, string>): Section[] {
  return prev ? SECTIONS.filter(k => prev[k] !== next[k]) : [...SECTIONS]
}

// ---------- the service's policies ----------

export const READER_TTL_MS = 60_000
export const MAX_READERS = 16
export const MAX_TURNS_SENT = 200

export interface PoolEntry { key: string; lastUsed: number }

/** Keys to drop from the reader pool: idle for `ttl`, then the least recently used beyond `max` (the `keep` key is never dropped). */
export function readersToDrop(entries: readonly PoolEntry[], now: number, opts: { ttl?: number; max?: number; keep?: string } = {}): string[] {
  const ttl = opts.ttl ?? READER_TTL_MS
  const max = opts.max ?? MAX_READERS
  const drop = new Set<string>()
  for (const e of entries) if (e.key !== opts.keep && now - e.lastUsed >= ttl) drop.add(e.key)
  const live = entries.filter(e => !drop.has(e.key)).sort((a, b) => a.lastUsed - b.lastUsed)
  let over = live.length - max
  for (const e of live) {
    if (over <= 0) break
    if (e.key === opts.keep) continue
    drop.add(e.key)
    over--
  }
  return [...drop]
}

/** The inventory goes on the wire only when the key the renderer holds differs from the current one. */
export function inventoryForWire<T extends { key: string }>(held: string | undefined, current: T): T | 'same' {
  return held !== undefined && held === current.key ? 'same' : current
}

export function skillSortValue(row: SkillView, key: string): number | string {
  switch (key) {
    case 'prompt': return row.promptTokens
    case 'body': return row.bodyTokens
    case 'scope': return row.scope
    default: return row.name
  }
}

// ---------- which panel the pad follows ----------

export type Target =
  | { kind: 'agent'; slotId: string; cwd: string }
  | { kind: 'unsupported'; why: 'shell' | 'agent'; agent?: string }
  | undefined

/**
 * The pad follows the focused panel: a Claude pane becomes the target; a plain terminal or another agent says it is not
 * supported; anything else (a note, a preview, the pad itself, nothing) keeps the current target.
 */
export function nextTarget(prev: Target, info: { id: string; type: string; cwd?: string; agent?: string } | undefined): Target {
  if (!info) return prev
  if (info.agent === 'claude') return info.cwd ? { kind: 'agent', slotId: info.id, cwd: info.cwd } : prev
  if (info.agent) return { kind: 'unsupported', why: 'agent', agent: info.agent }
  if (info.type === 'terminal') return { kind: 'unsupported', why: 'shell' }
  return prev
}

export function sameTarget(a: Target, b: Target): boolean {
  if (a === b) return true
  if (!a || !b || a.kind !== b.kind) return false
  return a.kind === 'agent' ? b.kind === 'agent' && a.slotId === b.slotId && a.cwd === b.cwd : b.kind === 'unsupported' && a.why === b.why && a.agent === b.agent
}
