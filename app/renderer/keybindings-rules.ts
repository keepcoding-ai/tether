// The user's keybindings file (<TETHER_HOME>/keybindings.json), pure: how it is read, how it is laid over the
// defaults, and how the screen's edits are written back as the SMALLEST file (only what differs from the defaults).
//
// The format is VS Code's, with three differences: `where` (an array of "window" | "terminal" | "note") in the place
// of the `when` expression; chords with a space ("ctrl+k ctrl+s"); and the file is strict JSON after the comments
// are removed (a trailing comma is an error, as in a plain JSON file). `-command` removes a default binding, as in
// VS Code. A syntax error means NOTHING of the file applies (the defaults stay, the screen shows the error); an
// entry with an unknown command or an unreadable key is skipped alone, with a warning.
import { defaultWhere, formatKeys, parseKeys, resolvedDefaults, sameKeys, WHERE_ALL, type Chord, type Keybinding, type Where } from './shortcuts.ts'

/** One entry of the file. `-id` as the command removes the default binding(s) of `id` on `key` (any `key` when absent). */
export interface KeybindingEntry { key?: string; command: string; where?: Where[] }

export type ParsedFile =
  | { ok: true; entries: KeybindingEntry[]; warnings: string[] }
  | { ok: false; message: string; line?: number }

/** Strips line and block comments outside strings (VS Code's keybindings.json is JSONC); the rest must be strict JSON. */
export function stripJsonComments(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') { if (text[j] === '\\') j++; j++ }
      out += text.slice(i, j + 1); i = j + 1; continue
    }
    if (ch === '/' && text[i + 1] === '/') { const end = text.indexOf('\n', i); const to = end === -1 ? text.length : end; out += ' '.repeat(to - i); i = to; continue }
    if (ch === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); const to = end === -1 ? text.length : end + 2; out += text.slice(i, to).replace(/[^\n]/g, ' '); i = to; continue }
    out += ch; i++
  }
  return out
}

/** The 1-based line of a JSON.parse error ("… at position N" / "(line L column C)"), when the message carries one. */
function errorLine(message: string, text: string): number | undefined {
  const lc = /line (\d+) column \d+/.exec(message)
  if (lc) return Number(lc[1])
  const pos = /position (\d+)/.exec(message)
  if (pos) return text.slice(0, Number(pos[1])).split('\n').length
  // V8 (Node 22+): `Unexpected token ']', ..."<text before and including the token>" is not valid JSON`.
  const snip = /, (?:\.\.\.)?"([\s\S]*)" is not valid JSON$/.exec(message)
  if (snip) {
    const at = text.lastIndexOf(snip[1]!)
    if (at !== -1) return text.slice(0, at + snip[1]!.length).split('\n').length
  }
  return undefined
}

/** Reads the file's text. An empty or blank file is an empty list. */
export function parseKeybindingsFile(text: string): ParsedFile {
  if (text.trim() === '') return { ok: true, entries: [], warnings: [] }
  let raw: unknown
  try {
    raw = JSON.parse(stripJsonComments(text))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const line = errorLine(message, text)
    return { ok: false, message: `JSON inválido${line ? ` na linha ${line}` : ''}: ${message}`, ...(line ? { line } : {}) }
  }
  if (!Array.isArray(raw)) return { ok: false, message: 'O arquivo deve ser uma lista ([ … ]) de entradas { "key", "command", "where" }.' }
  const entries: KeybindingEntry[] = []
  const warnings: string[] = []
  raw.forEach((item, i) => {
    const n = i + 1
    if (!item || typeof item !== 'object' || Array.isArray(item)) { warnings.push(`entrada ${n}: não é um objeto; ignorada`); return }
    const { key, command, where } = item as { key?: unknown; command?: unknown; where?: unknown }
    if (typeof command !== 'string' || command.trim() === '') { warnings.push(`entrada ${n}: sem "command"; ignorada`); return }
    const entry: KeybindingEntry = { command: command.trim() }
    if (key !== undefined) {
      if (typeof key !== 'string' || !parseKeys(key)) { warnings.push(`entrada ${n} (${entry.command}): tecla "${String(key)}" ilegível; ignorada`); return }
      entry.key = key.trim().toLowerCase()
    } else if (!entry.command.startsWith('-')) { warnings.push(`entrada ${n} (${entry.command}): sem "key"; ignorada`); return }
    if (where !== undefined) {
      if (!Array.isArray(where) || !where.every(w => (WHERE_ALL as readonly unknown[]).includes(w)) || where.length === 0) {
        warnings.push(`entrada ${n} (${entry.command}): "where" deve ser uma lista com "window", "terminal" e/ou "note"; ignorada`); return
      }
      entry.where = [...new Set(where as Where[])]
    }
    entries.push(entry)
  })
  return { ok: true, entries, warnings }
}

/**
 * The defaults with the file laid over them, in order: `-id` removes; `{ key, command }` appends (a later binding wins
 * at dispatch, so an added key beats a default on the same key). `known` lists the command ids that exist; an entry
 * naming another is skipped with a warning (a `-id` of an unknown command is harmless and silent).
 */
export function mergeKeybindings(entries: readonly KeybindingEntry[], known: ReadonlySet<string>, mac?: boolean): { bindings: Keybinding[]; warnings: string[] } {
  const bindings = resolvedDefaults(mac)
  const warnings: string[] = []
  for (const e of entries) {
    const keys = e.key ? parseKeys(e.key)! : undefined
    if (e.command.startsWith('-')) {
      const id = e.command.slice(1)
      for (let i = bindings.length - 1; i >= 0; i--) {
        const b = bindings[i]!
        if (b.command === id && (!keys || sameKeys(b.keys, keys))) bindings.splice(i, 1)
      }
      continue
    }
    if (!known.has(e.command)) { warnings.push(`"${e.command}" não é um comando; a entrada ${e.key ?? ''} foi ignorada`); continue }
    const concreteKeys = keys!.map(c => ({ ...c, ...(c.mod ? (mac ? { meta: true } : { ctrl: true }) : {}) })).map(({ mod: _m, ...rest }) => rest)
    bindings.push({ keys: concreteKeys, command: e.command, where: e.where ? [...e.where] : defaultWhere(concreteKeys[0]!), source: 'user' })
  }
  return { bindings, warnings }
}

const sameWhere = (a: readonly Where[], b: readonly Where[]): boolean => a.length === b.length && a.every(w => b.includes(w))

/**
 * The file that turns the defaults into `current`: for every command whose bindings differ, a `-id` per default
 * binding that is gone and an entry per binding that is not a default (with `where` only when it is not the key's
 * default scope). Commands untouched produce nothing; an unchanged file is `[]`.
 */
export function overridesFor(current: readonly Keybinding[], mac?: boolean): KeybindingEntry[] {
  const defaults = resolvedDefaults(mac)
  const ids = [...new Set([...defaults.map(b => b.command), ...current.map(b => b.command)])]
  const out: KeybindingEntry[] = []
  for (const id of ids) {
    const def = defaults.filter(b => b.command === id)
    const now = current.filter(b => b.command === id)
    const same = (a: Keybinding, b: Keybinding): boolean => sameKeys(a.keys, b.keys) && sameWhere(a.where, b.where)
    for (const d of def) if (!now.some(n => same(n, d))) out.push({ key: formatKeys(d.keys), command: `-${id}` })
    for (const n of now) if (!def.some(d => same(d, n))) {
      const e: KeybindingEntry = { key: formatKeys(n.keys), command: id }
      if (!sameWhere(n.where, defaultWhere(n.keys[0]!))) e.where = [...n.where]
      out.push(e)
    }
  }
  return out
}

/** The file's text for a list of entries: one entry per line, a header comment, `[]` when empty. */
export function formatKeybindingsFile(entries: readonly KeybindingEntry[]): string {
  const head = '// Atalhos do tether que diferem do padrão (a tela "Atalhos de teclado" escreve aqui; editar à mão também vale).\n// Formato: { "key": "ctrl+k ctrl+s", "command": "id.do.comando", "where": ["window", "terminal", "note"] }; "-id" tira um padrão.\n'
  if (entries.length === 0) return `${head}[]\n`
  const lines = entries.map(e => {
    const parts = [e.key !== undefined ? `"key": ${JSON.stringify(e.key)}` : '', `"command": ${JSON.stringify(e.command)}`].filter(Boolean)
    if (e.where) parts.push(`"where": [${e.where.map(w => JSON.stringify(w)).join(', ')}]`)
    return `  { ${parts.join(', ')} }`
  })
  return `${head}[\n${lines.join(',\n')}\n]\n`
}

/** Two bindings lists describe the same table (order ignored within a command). */
export function sameBindings(a: readonly Keybinding[], b: readonly Keybinding[]): boolean {
  return overridesFor(a).length === overridesFor(b).length && a.length === b.length && a.every(x => b.some(y => x.command === y.command && sameKeys(x.keys, y.keys) && sameWhere(x.where, y.where)))
}

/** A prefix problem of keys in a scope: a single key that opens chords, or a chord whose first key is a single binding elsewhere. */
export function prefixIssue(table: readonly Keybinding[], keys: readonly Chord[], where: readonly Where[], except?: string): { kind: 'is-prefix' | 'first-is-single'; commands: string[] } | undefined {
  const overlap = (b: Keybinding): boolean => b.command !== except && b.command !== 'chord.prefix' && b.where.some(w => where.includes(w))
  if (keys.length === 1) {
    const chords = table.filter(b => overlap(b) && b.keys.length === 2 && sameKeys([b.keys[0]!], keys))
    if (chords.length) return { kind: 'is-prefix', commands: [...new Set(chords.map(c => c.command))] }
    return undefined
  }
  const single = table.find(b => overlap(b) && b.keys.length === 1 && sameKeys(b.keys, [keys[0]!]))
  return single ? { kind: 'first-is-single', commands: [single.command] } : undefined
}
