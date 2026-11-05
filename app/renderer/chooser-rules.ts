// The chooser's data, pure (unit-tested): what it offers (the launch profiles, the two ways a note is born, the
// empty pane in the contextless popup), how a typed query ranks them (prefix → start of a word → subsequence →
// alias: "bash", "pwsh", "nota", "dev"), how the list is laid out (Recentes first, then the groups in the profile
// manager's order, numbered 1–9 as shown), which folder applies (the profile's own until the field is touched),
// what the open button says, and the Esc ladder. app/renderer/chooser.ts renders it; main.ts resolves a Choice.
import type { Profile } from '../../src/daemon/protocol.ts'
import type { ProfileAgent } from '../../src/core/profile.ts'
import { foldChars, foldQuery, fuzzyMatch } from './fuzzy.ts'

/** A Phosphor icon name of icons.ts (IconName). Not imported: icons.ts pulls the SVG assets, and this module stays pure for the unit tests. */
type IconName = string

export const CHOICE_PREFIX = 'kind:'

export type ChoiceKind = 'empty' | 'note-new' | 'note-open'

/** What the person picked in the chooser. */
export type Choice =
  | { kind: 'profile'; profile: Profile }
  | { kind: ChoiceKind }

/** The choice an item id names, or undefined for nothing / an unknown profile. */
export function choiceOf(value: string | undefined, profiles: readonly Profile[]): Choice | undefined {
  if (!value) return undefined
  if (value.startsWith(CHOICE_PREFIX)) {
    const kind = value.slice(CHOICE_PREFIX.length)
    return kind === 'empty' || kind === 'note-new' || kind === 'note-open' ? { kind } : undefined
  }
  const profile = profiles.find(p => p.id === value)
  return profile ? { kind: 'profile', profile } : undefined
}

/** Whether a choice needs the folder field filled: a process needs a cwd; a note and an empty pane fall back to the person's folder. */
export function choiceNeedsFolder(choice: Choice): boolean {
  return choice.kind === 'profile'
}

// ---------- items ----------

export type ItemGroup = ProfileAgent | 'note' | 'empty'
/** The groups in reading order: the profile manager's order, then the notes, then (popup only) the empty pane. */
export const ITEM_GROUPS: readonly ItemGroup[] = ['claude', 'soul', 'shell', 'note', 'empty']
export const GROUP_LABEL: Record<ItemGroup, string> = { claude: 'Claude', soul: 'soul', shell: 'Shell', note: 'Nota', empty: 'Vazio' }
export const GROUP_ICON: Record<ItemGroup, IconName> = { claude: 'sparkle', soul: 'ghost', shell: 'terminal-window', note: 'note-pencil', empty: 'plus' }

const UNSAFE_ARG = '--dangerously-skip-permissions'

export interface ChooserItem {
  /** A profile id, or `kind:<kind>` (the value `choiceOf` reads). */
  id: string
  kind: 'profile' | ChoiceKind
  group: ItemGroup
  name: string
  /** The small line under the name: the args of a profile, a description otherwise. */
  hint: string
  /** The hint is a placeholder ("sem argumentos"), shown muted. */
  hintNone: boolean
  icon: IconName
  /** Folded words the alias match reads (never shown). */
  keywords: string[]
  unsafe: boolean
  default: boolean
  /** The profile's own folder, suggested while the folder field is untouched. */
  cwd?: string
}

const fold = (s: string): string => foldChars(s).join('')
const words = (s: string): string[] => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean)

/** Aliases by what the profile is: shell names people type, the unsafe flag's nicknames, the agent's. */
function profileKeywords(p: Profile, unsafe: boolean): string[] {
  const out = [...words(p.name), ...words(GROUP_LABEL[p.agent]), p.agent]
  const name = fold(p.name)
  if (p.agent === 'claude') out.push('cc', 'agente', 'code')
  if (p.agent === 'soul') out.push('agente')
  if (p.agent === 'shell') out.push('terminal', 'console', 'prompt')
  if (name.includes('powershell') || name.includes('pwsh')) out.push('pwsh', 'ps', 'powershell')
  if (name.includes('bash')) out.push('sh', 'git', 'bash')
  if (name.includes('cmd')) out.push('prompt', 'dos')
  if (unsafe) out.push('dev', 'yolo', 'sem', 'restricoes', 'dangerously', 'skip', 'permissions')
  return [...new Set(out)]
}

function formatArgs(args: readonly string[]): string {
  return args.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')
}

/** A profile as an item: the args line (a shell profile shows its executable's args too), the unsafe and default marks. */
export function profileItem(p: Profile): ChooserItem {
  const args = p.agent === 'shell' && p.shell ? [...p.shell.args, ...p.args] : p.args
  const unsafe = p.args.includes(UNSAFE_ARG)
  const hint = args.length ? formatArgs(args) : p.agent === 'shell' && !p.shell ? 'shell padrão' : 'sem argumentos'
  return { id: p.id, kind: 'profile', group: p.agent, name: p.name, hint, hintNone: args.length === 0, icon: GROUP_ICON[p.agent], keywords: profileKeywords(p, unsafe), unsafe, default: !!p.default, ...(p.cwd ? { cwd: p.cwd } : {}) }
}

export const NOTE_NEW_ITEM: ChooserItem = { id: `${CHOICE_PREFIX}note-new`, kind: 'note-new', group: 'note', name: 'Nova nota', hint: 'arquivo .md novo em <pasta>/.tether/notes', hintNone: false, icon: 'note-pencil', keywords: ['nota', 'note', 'nova', 'novo', 'md', 'markdown', 'arquivo', 'texto'], unsafe: false, default: false }
export const NOTE_OPEN_ITEM: ChooserItem = { id: `${CHOICE_PREFIX}note-open`, kind: 'note-open', group: 'note', name: 'Abrir nota…', hint: 'um arquivo existente, pelo seletor de arquivos', hintNone: false, icon: 'folder-open', keywords: ['nota', 'note', 'abrir', 'md', 'markdown', 'arquivo', 'existente'], unsafe: false, default: false }
export const EMPTY_ITEM: ChooserItem = { id: `${CHOICE_PREFIX}empty`, kind: 'empty', group: 'empty', name: 'Vazio — escolher depois', hint: 'só o espaço, na posição escolhida; o que abre nele se decide lá dentro', hintNone: false, icon: 'plus', keywords: ['vazio', 'espaco', 'depois', 'empty', 'lugar'], unsafe: false, default: false }

/** Everything a chooser offers: the profiles, the notes, and the empty pane where it makes sense (the contextless popup). */
export function chooserItems(profiles: readonly Profile[], opts: { empty: boolean }): ChooserItem[] {
  const out: ChooserItem[] = []
  for (const agent of ['claude', 'soul', 'shell'] as const) for (const p of profiles) if (p.agent === agent) out.push(profileItem(p))
  out.push(NOTE_NEW_ITEM, NOTE_OPEN_ITEM)
  if (opts.empty) out.push(EMPTY_ITEM)
  return out
}

// ---------- matching ----------

export interface ItemMatch {
  /** 0 prefix of the name · 1 start of a word of the name · 2 subsequence of the name · 3 an alias. Lower ranks first. */
  score: 0 | 1 | 2 | 3
  /** UTF-16 indexes into the name, for the highlight (empty for an alias match). */
  positions: number[]
}

const isWordChar = (c: string): boolean => c !== '' && /[\p{L}\p{N}]/u.test(c)

/** The item against a query (case and accents folded, spaces of the query ignored), or undefined when it does not match. */
export function matchItem(item: ChooserItem, query: string): ItemMatch | undefined {
  if (foldQuery(query).length === 0) return { score: 0, positions: [] }
  // Prefix and word start keep the query's inner spaces ("claude modo" is a prefix of "Claude modo dev"); the subsequence drops them.
  const q = foldChars(query.trim()).filter(c => c !== '')
  const t = foldChars(item.name)
  const offsets: number[] = []
  let off = 0
  for (const ch of item.name) { offsets.push(off); off += ch.length }
  const at = (start: number): boolean => q.every((c, i) => t[start + i] === c)
  const span = (start: number): number[] => q.map((_, i) => offsets[start + i]!)
  if (at(0)) return { score: 0, positions: span(0) }
  for (let i = 1; i + q.length <= t.length; i++) if (!isWordChar(t[i - 1]!) && at(i)) return { score: 1, positions: span(i) }
  const fuzzy = fuzzyMatch(query, item.name)
  if (fuzzy) return { score: 2, positions: fuzzy.positions }
  const terms = fold(query).split(/\s+/).filter(Boolean)
  if (terms.length && terms.every(w => item.keywords.some(k => k.startsWith(w)))) return { score: 3, positions: [] }
  return undefined
}

// ---------- the list ----------

export const MAX_RECENT = 3

export type ChooserRow =
  | { kind: 'sep'; label: string; icon: IconName; recent: boolean }
  | { kind: 'item'; item: ChooserItem; positions: number[]; recent: boolean; n: number | undefined }

/**
 * The rows the list shows. Without a query: Recentes (the last profiles opened, up to 3, profiles only, not
 * repeated below) then the groups in order. With a query: the matches by rank, recents first among equals, no
 * separators. Items are numbered 1–9 in the order shown (what the person sees is what the digit opens).
 */
export function chooserRows(items: readonly ChooserItem[], query: string, recentIds: readonly string[]): ChooserRow[] {
  const rows: ChooserRow[] = []
  const recentRank = (id: string): number => { const i = recentIds.indexOf(id); return i < 0 ? Number.MAX_SAFE_INTEGER : i }
  if (foldQuery(query).length === 0) {
    const recent = recentIds.map(id => items.find(it => it.id === id && it.kind === 'profile')).filter((it): it is ChooserItem => !!it).slice(0, MAX_RECENT)
    if (recent.length) {
      rows.push({ kind: 'sep', label: 'Recentes', icon: 'clock-counter-clockwise', recent: true })
      for (const item of recent) rows.push({ kind: 'item', item, positions: [], recent: true, n: undefined })
    }
    for (const group of ITEM_GROUPS) {
      const list = items.filter(it => it.group === group && !recent.includes(it))
      if (list.length === 0) continue
      rows.push({ kind: 'sep', label: GROUP_LABEL[group], icon: GROUP_ICON[group], recent: false })
      for (const item of list) rows.push({ kind: 'item', item, positions: [], recent: false, n: undefined })
    }
  } else {
    const hits = items.map((item, order) => ({ item, order, m: matchItem(item, query) })).filter((h): h is { item: ChooserItem; order: number; m: ItemMatch } => !!h.m)
    hits.sort((a, b) => a.m.score - b.m.score || recentRank(a.item.id) - recentRank(b.item.id) || a.order - b.order)
    for (const h of hits) rows.push({ kind: 'item', item: h.item, positions: h.m.positions, recent: recentIds.includes(h.item.id), n: undefined })
  }
  let n = 0
  for (const r of rows) if (r.kind === 'item') { n++; r.n = n <= 9 ? n : undefined }
  return rows
}

/** The items of the rows, in order (what ↑/↓ and the digits walk). */
export function rowItems(rows: readonly ChooserRow[]): ChooserItem[] {
  return rows.flatMap(r => (r.kind === 'item' ? [r.item] : []))
}

/** The item a digit key (1–9) opens in the list as shown, or undefined. */
export function itemForDigit(rows: readonly ChooserRow[], key: string): ChooserItem | undefined {
  if (!/^[1-9]$/.test(key)) return undefined
  const n = Number(key)
  for (const r of rows) if (r.kind === 'item' && r.n === n) return r.item
  return undefined
}

/** The recents after opening `id`: most recent first, no repeats, at most MAX_RECENT. Only profiles count. */
export function rememberProfile(recent: readonly string[], id: string): string[] {
  return [id, ...recent.filter(x => x !== id)].slice(0, MAX_RECENT)
}

// ---------- folder, button, Esc ----------

/** The folder that applies to an item: the profile's own while the field is untouched, else what the field holds. */
export function effectiveFolder(item: ChooserItem | undefined, folder: string, touched: boolean): { folder: string; fromProfile: boolean } {
  if (!touched && item?.cwd) return { folder: item.cwd, fromProfile: true }
  return { folder, fromProfile: false }
}

/** What the primary button says for the highlighted item ("Abrir Claude", "Criar nota", "Abrir nota…"; the busy form while opening). */
export function openLabel(item: ChooserItem | undefined, busy = false): { verb: string; name: string } {
  if (!item) return { verb: busy ? 'Abrindo' : 'Abrir', name: '' }
  const create = item.kind === 'note-new' || item.kind === 'empty'
  const verb = busy ? (create ? 'Criando' : 'Abrindo') : create ? 'Criar' : 'Abrir'
  const name = item.kind === 'note-new' ? 'nota' : item.kind === 'note-open' ? 'nota…' : item.kind === 'empty' ? 'vazio' : item.name
  return { verb, name: busy ? `${name}…` : name }
}

/** The Esc ladder: text in the search clears it; an open folder list closes; else the chooser cancels (what that means is the host's: the origin). */
export function escLayer(state: { query: string; recentsOpen: boolean }): 'clear' | 'close-recents' | 'cancel' {
  if (state.query) return 'clear'
  if (state.recentsOpen) return 'close-recents'
  return 'cancel'
}

/** The recent folders that contain the typed text (folded), all of them for an empty filter. */
export function filterFolders(folders: readonly string[], filter: string): string[] {
  const f = fold(filter.trim())
  return f ? folders.filter(x => fold(x).includes(f)) : [...folders]
}
