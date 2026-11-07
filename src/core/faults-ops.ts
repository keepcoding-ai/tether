// Reading and editing the fault registry as people see it: one row per fault (signature), the detail of one, and the
// verbs that change its state (investigate, done, ignore, reopen, tag, note). Used by the CLI (`tether faults`) and by the
// Faults screen through Electron main, so both write through the same code under the registry's lock: the screen and an
// agent running `tether faults note` never overwrite each other. Occurrences are only ever read here (src/core/faults.ts
// is the one that appends them).
import { readOccurrences, readState, reconcileState, resolveId, withLock, writeState, type FaultKind, type FaultNote, type FaultOccurrence, type FaultProc, type FaultState, type FaultStatus, type StateFile } from './faults.ts'
import { normalizeTag } from './faults-labels.ts'

/** The fields the JSON of `tether faults list` has, and the screen's rows; stable, the skills parse them. */
export interface FaultRow {
  id: string
  sig: string
  status: FaultStatus
  kind: FaultKind
  proc: FaultProc
  message: string
  count: number
  first: string
  last: string
  tags: string[]
  version: string
  returned?: { ts: string; version: string; fix?: string }
}

export interface FaultsSnapshot {
  rows: FaultRow[]
  /** jsonl lines that could not be read (counted, never fatal). */
  skipped: number
  /** The state file was unreadable or had to be recreated. */
  problem?: string
}

/** One occurrence as `show --json` has it. */
export interface OccurrenceView { ts: string; version: string; commit?: string; proc: FaultProc; kind: FaultKind; stack: string; context: Record<string, unknown> }

export interface FaultDetail extends FaultRow {
  notes: FaultNote[]
  fix?: FaultState['fix']
  investigating?: FaultState['investigating']
  /** Newest first, capped by the caller. */
  occurrences: OccurrenceView[]
  /** How many occurrences the registry holds in all (the state's count can be higher: storms stop writing lines). */
  occurrenceTotal: number
}

const viewOf = (o: FaultOccurrence): OccurrenceView => ({ ts: o.ts, version: o.version, ...(o.commit ? { commit: o.commit } : {}), proc: o.proc, kind: o.kind, stack: o.stack, context: o.context })

function rowOf(sig: string, f: FaultState, latest: FaultOccurrence | undefined): FaultRow {
  const returned = f.returned ? { ts: f.returned.ts, version: f.returned.version, ...(f.fix?.commit ? { fix: f.fix.commit } : {}) } : undefined
  return {
    id: f.shortId, sig, status: f.status, kind: latest?.kind ?? 'uncaught', proc: latest?.proc ?? 'main', message: latest?.message ?? '(sem ocorrência no registro)',
    count: f.count, first: f.first, last: f.last, tags: f.tags ?? [], version: latest?.version ?? 'unknown', ...(returned ? { returned } : {}),
  }
}

/** Every fault, the one that occurred last first. Lines the launcher wrote without a state entry are folded in first. */
export function listFaults(dir: string): FaultsSnapshot {
  const occ = readOccurrences(dir)
  let read = readState(dir)
  const latest = new Map<string, FaultOccurrence>()
  for (const o of occ.items) latest.set(o.sig, o)
  if ([...latest.keys()].some(s => !read.state.faults[s])) {
    reconcileState(dir)
    read = readState(dir)
  }
  const rows = Object.entries(read.state.faults).map(([sig, f]) => rowOf(sig, f, latest.get(sig)))
  rows.sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0))
  return { rows, skipped: occ.skipped, ...(read.problem ? { problem: read.problem } : {}) }
}

export type NotFound = { ok: false; code: 'unknown' | 'ambiguous'; ref: string; candidates: string[] }
export type Lookup = { ok: true; sig: string } | NotFound

/** `ref` is a short id, a unique prefix of a sig, or a whole sig (candidates come back as short ids). */
export function lookupFault(state: StateFile, ref: string): Lookup {
  const r = resolveId(state.faults, ref)
  if ('sig' in r) return { ok: true, sig: r.sig }
  return { ok: false, code: r.candidates.length ? 'ambiguous' : 'unknown', ref, candidates: r.candidates.map(s => state.faults[s]!.shortId) }
}

export function describeNotFound(l: NotFound): string {
  return l.code === 'ambiguous'
    ? `prefixo ambíguo "${l.ref}": ${l.candidates.join(', ')}`
    : `falha não encontrada: ${l.ref} (veja \`tether faults\`)`
}

/** The detail of one fault; `limit` caps the occurrences (undefined = all). */
export function showFault(dir: string, ref: string, limit?: number): { ok: true; fault: FaultDetail; skipped: number; problem?: string } | NotFound {
  listFaults(dir)
  const read = readState(dir)
  const found = lookupFault(read.state, ref)
  if (!found.ok) return found
  const f = read.state.faults[found.sig]!
  const occ = readOccurrences(dir)
  const mine = occ.items.filter(o => o.sig === found.sig)
  const newest = mine.slice().reverse()
  const row = rowOf(found.sig, f, mine[mine.length - 1])
  const fault: FaultDetail = {
    ...row, notes: f.notes ?? [], ...(f.fix ? { fix: f.fix } : {}), ...(f.investigating ? { investigating: f.investigating } : {}),
    occurrences: (limit === undefined ? newest : newest.slice(0, limit)).map(viewOf), occurrenceTotal: mine.length,
  }
  return { ok: true, fault, skipped: occ.skipped, ...(read.problem ? { problem: read.problem } : {}) }
}

export type FaultAction =
  | { type: 'investigate'; by: string }
  | { type: 'done'; by: string; fix?: string }
  | { type: 'ignore' }
  | { type: 'reopen' }
  | { type: 'tag'; tags: string[]; remove?: boolean }
  | { type: 'note'; author: string; text: string }

export type ActionResult =
  | { ok: true; sig: string; id: string; changed: boolean; state: FaultState; /** Tags actually added or removed (normalized). */ touchedTags?: string[] }
  | NotFound
  | { ok: false; code: 'unreadable' | 'invalid'; message: string }

/** Applies one verb under the registry lock. A verb that finds the fault already so is `changed: false` (nothing written). */
export function applyAction(dir: string, ref: string, action: FaultAction, now: () => number = Date.now): ActionResult {
  listFaults(dir)
  return withLock(dir, (): ActionResult => {
    const read = readState(dir)
    if (read.problem && !read.backup) return { ok: false, code: 'unreadable', message: read.problem }
    const found = lookupFault(read.state, ref)
    if (!found.ok) return found
    const f = read.state.faults[found.sig]!
    const ts = new Date(now()).toISOString()
    let changed = false
    let touchedTags: string[] | undefined
    switch (action.type) {
      case 'investigate':
        if (f.status !== 'investigating' || f.investigating?.by !== action.by) { f.status = 'investigating'; f.investigating = { by: action.by, ts }; delete f.returned; changed = true }
        break
      case 'done': {
        const fix = action.fix?.trim()
        const same = f.status === 'done' && (!fix || f.fix?.commit === fix)
        if (!same) { f.status = 'done'; f.fix = { ...(fix ? { commit: fix } : {}), ts, by: action.by }; delete f.returned; delete f.investigating; changed = true }
        break
      }
      case 'ignore':
        if (f.status !== 'ignored') { f.status = 'ignored'; delete f.investigating; changed = true }
        break
      case 'reopen':
        if (f.status !== 'open') { f.status = 'open'; delete f.returned; delete f.investigating; changed = true }
        break
      case 'tag': {
        const wanted = action.tags.map(normalizeTag).filter(Boolean)
        if (!wanted.length) return { ok: false, code: 'invalid', message: 'nenhuma etiqueta válida (use letras, números e hífen)' }
        const next = new Set(f.tags ?? [])
        const touched: string[] = []
        for (const t of wanted) {
          if (action.remove ? next.delete(t) : !next.has(t) && !!next.add(t)) touched.push(t)
        }
        changed = touched.length > 0
        f.tags = [...next]
        touchedTags = touched
        break
      }
      case 'note': {
        const text = action.text.trim()
        if (!text) return { ok: false, code: 'invalid', message: 'a nota está vazia' }
        f.notes = [...(f.notes ?? []), { ts, author: action.author, text }]
        changed = true
        break
      }
    }
    if (changed) writeState(dir, read.state)
    return { ok: true, sig: found.sig, id: f.shortId, changed, state: f, ...(touchedTags ? { touchedTags } : {}) }
  })
}
