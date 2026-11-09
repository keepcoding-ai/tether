// The general rule of a suggested folder (Guga, 09/11): a folder inside a `.tether` folder (a note's own folder, the
// person's notes) is cut where `.tether` starts, so "Nova nota" there never makes `.tether/notes/.tether/notes`, and a
// terminal opened from a note starts in the project. Only for what the chooser suggests (the current folder, a recent
// one, a profile's); a folder the person types or picks is kept as chosen.

/** `d:\minha\pasta\.tether\alguma\pasta` → `d:\minha\pasta`; a folder without a `.tether` part is returned as is. */
export function stripTether(folder: string): string {
  const trimmed = folder.trim()
  const m = /^(.*?)[\\/]\.tether(?:[\\/].*)?$/i.exec(trimmed)
  if (!m) return folder
  const base = m[1]!
  if (base === '') return trimmed.slice(0, 1) // `/.tether/...`: the root
  // A drive alone (`d:`) keeps its separator: `d:\`.
  return /^[A-Za-z]:$/.test(base) ? base + trimmed.charAt(2) : base
}

/** The grey suffix shown after a typed folder: `.tether\notes` after a separator, `\.tether\notes` otherwise, in the separator the person types. */
export function folderSuffix(typed: string, segments: readonly string[]): string {
  if (!typed.trim() || segments.length === 0) return ''
  const sep = typed.includes('/') && !typed.includes('\\') ? '/' : '\\'
  const tail = segments.join(sep)
  return /[\\/]$/.test(typed) ? tail : sep + tail
}
