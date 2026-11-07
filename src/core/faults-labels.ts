// What a fault is called to the person (Portuguese) and the small pure rules shared by the CLI and the Faults screen:
// status and kind labels, the "voltou" sentence, tag normalization, status words typed on a command line. No file system
// here, so the renderer bundle can import it too. The words follow the design note's table (aberta / investigando /
// resolvida / ignorada; ao abrir / erro não tratado / processo morreu); English stays in `--status` and in the JSON.
import type { FaultKind, FaultState, FaultStatus } from './faults.ts'

export const STATUSES: readonly FaultStatus[] = ['open', 'investigating', 'done', 'ignored']

const STATUS_LABEL: Record<FaultStatus, string> = { open: 'aberta', investigating: 'investigando', done: 'resolvida', ignored: 'ignorada' }
const KIND_LABEL: Record<FaultKind, string> = { load: 'ao abrir', uncaught: 'erro não tratado', rejection: 'erro não tratado', gone: 'processo morreu' }

export const statusLabel = (s: FaultStatus): string => STATUS_LABEL[s] ?? String(s)
/** "2 abertas": the label for a count above one. */
export const statusPlural = (s: FaultStatus): string => (s === 'investigating' ? STATUS_LABEL[s] : `${STATUS_LABEL[s]}s`)
export const kindLabel = (k: FaultKind): string => KIND_LABEL[k] ?? String(k)

/** A status word as a person types it: the Portuguese label or the English id; undefined when it is neither. */
export function parseStatus(word: string): FaultStatus | undefined {
  const w = word.trim().toLowerCase()
  for (const s of STATUSES) if (w === s || w === STATUS_LABEL[s]) return s
  const alias: Record<string, FaultStatus> = { resolvido: 'done', resolvidas: 'done', fechada: 'done', ignorado: 'ignored', abertas: 'open', investigar: 'investigating' }
  return alias[w]
}

/** Tags are lowercase `a-z0-9-` with no `#`: anything else becomes a hyphen. Empty when nothing usable is left. */
export function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/^#+/, '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
}

/** "voltou na v0.9.4, depois do fix def4567": the detail always comes with the word. */
export function returnedText(f: Pick<FaultState, 'returned' | 'fix'>): string | undefined {
  if (!f.returned) return undefined
  const fix = f.fix?.commit ? `, depois do fix ${f.fix.commit.slice(0, 7)}` : f.fix ? ', depois de resolvida' : ''
  return `voltou na v${f.returned.version.replace(/^v/, '')}${fix}`
}
