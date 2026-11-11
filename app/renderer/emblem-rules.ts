// Tab emblems (docs/tab-emblems-preview.html): the rules, no DOM. One emblem per tab at most; the tab keeps only the
// emblem's id (its dockview params, saved in layout.json), so editing an emblem changes every tab that wears it.
// The library lives in layout.json (`emblems`): the built-in ones plus the person's own. A built-in emblem can be edited,
// restored and hidden, never deleted, so an update of the app does not bring back one the person took away.
import { HUE_NAMES, type HueName } from '../shared/palette.ts'

export interface Emblem {
  id: string
  name: string
  color: HueName
  /** A Phosphor icon name (emblem-icons.ts). */
  icon: string
  /** Ships with the app: restorable, hidden instead of deleted. */
  builtin?: boolean
  /** A built-in the person hid: out of the tab's menu, still in the editor. */
  hidden?: boolean
}

export const BUILTIN_EMBLEMS: readonly Emblem[] = [
  { id: 'b-cliente', name: 'Cliente', color: 'blue', icon: 'briefcase', builtin: true },
  { id: 'b-pessoal', name: 'Pessoal', color: 'green', icon: 'house', builtin: true },
  { id: 'b-estudo', name: 'Estudo', color: 'purple', icon: 'book-open', builtin: true },
  { id: 'b-revisar', name: 'Revisar', color: 'yellow', icon: 'eye', builtin: true },
  { id: 'b-deploy', name: 'Deploy', color: 'teal', icon: 'rocket-launch', builtin: true },
  { id: 'b-bug', name: 'Bug', color: 'pink', icon: 'bug', builtin: true },
]

/** The hue names in Portuguese (the swatches' tooltips). */
export const HUE_LABELS: Readonly<Record<HueName, string>> = {
  red: 'vermelho', orange: 'laranja', yellow: 'amarelo', lime: 'lima', green: 'verde', teal: 'verde-azulado',
  cyan: 'ciano', sky: 'céu', blue: 'azul', purple: 'roxo', magenta: 'magenta', pink: 'rosa',
}

export const MAX_NAME = 32

const isHue = (x: unknown): x is HueName => typeof x === 'string' && (HUE_NAMES as readonly string[]).includes(x)

/**
 * The library from layout.json, read with tolerance: absent → the built-ins; a malformed entry is dropped; a built-in
 * missing from the file (new in this version of the app) is added at the end; an icon the catalog no longer has falls
 * back to the built-in's or to "tag".
 */
export function readEmblems(raw: unknown, knownIcon: (name: string) => boolean): Emblem[] {
  if (!Array.isArray(raw)) return BUILTIN_EMBLEMS.map(e => ({ ...e }))
  const out: Emblem[] = []
  const ids = new Set<string>()
  for (const x of raw) {
    if (typeof x !== 'object' || x === null) continue
    const r = x as Record<string, unknown>
    if (typeof r.id !== 'string' || !r.id || ids.has(r.id) || typeof r.name !== 'string' || !isHue(r.color) || typeof r.icon !== 'string') continue
    const builtin = BUILTIN_EMBLEMS.find(b => b.id === r.id)
    const icon = knownIcon(r.icon) ? r.icon : builtin?.icon ?? 'tag'
    ids.add(r.id)
    out.push({ id: r.id, name: r.name.slice(0, MAX_NAME), color: r.color, icon, ...(builtin ? { builtin: true } : {}), ...(builtin && r.hidden === true ? { hidden: true } : {}) })
  }
  for (const b of BUILTIN_EMBLEMS) if (!ids.has(b.id)) out.push({ ...b })
  return out
}

/** A built-in whose name, colour or icon differs from what the app ships. */
export function isModified(e: Emblem): boolean {
  const b = BUILTIN_EMBLEMS.find(x => x.id === e.id)
  return !!b && (b.name !== e.name || b.color !== e.color || b.icon !== e.icon)
}

/** The emblem a tab shows: undefined for none, an unknown id or a hidden built-in. */
export function shownEmblem(lib: readonly Emblem[], id: unknown): Emblem | undefined {
  if (typeof id !== 'string') return undefined
  const e = lib.find(x => x.id === id)
  return e && !e.hidden ? e : undefined
}

/** A fresh id for a person's emblem. */
export function newEmblemId(lib: readonly Emblem[], now = Date.now()): string {
  let n = now
  while (lib.some(e => e.id === `u-${n.toString(36)}`)) n++
  return `u-${n.toString(36)}`
}

/** The name shown for an emblem whose name was left empty. */
export const displayName = (e: Emblem): string => e.name.trim() || 'Sem nome'

// ---------- icon search ----------

/** Lower case, no accents: "Coração" and "coracao" are the same word. */
export const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export interface IconIndexEntry { n: string; name: string; words: readonly string[]; phrase: string }

/** One entry per icon, folded once (the search runs over this on every keystroke). */
export function buildIconIndex(icons: readonly { n: string; pt: string; en: string }[]): IconIndexEntry[] {
  return icons.map(i => {
    const name = fold(i.n.replace(/-/g, ' '))
    const words = [...new Set(fold(`${i.pt} ${i.en} ${name}`).split(/[\s,]+/).filter(Boolean))]
    return { n: i.n, name, words, phrase: fold(i.pt) }
  })
}

/**
 * The icons matching every word of `query`, best first. A word scores 0 when the icon's name starts with it, 1 for an
 * exact search word, 2 for a search word that starts with it, 3 when (3+ letters) it sits inside the Portuguese words;
 * an icon misses when any word scores nothing. Ties by name. Empty query → null (show the categories).
 */
export function searchIcons(index: readonly IconIndexEntry[], query: string): string[] | null {
  const terms = fold(query).trim().split(/\s+/).filter(Boolean)
  if (!terms.length) return null
  const hits: [number, string][] = []
  for (const it of index) {
    let score = 0
    for (const t of terms) {
      const s = it.name.startsWith(t) ? 0 : it.words.includes(t) ? 1 : it.words.some(w => w.startsWith(t)) ? 2 : t.length > 2 && it.phrase.includes(t) ? 3 : -1
      if (s < 0) { score = -1; break }
      score += s
    }
    if (score >= 0) hits.push([score, it.n])
  }
  return hits.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1])).map(h => h[1])
}
