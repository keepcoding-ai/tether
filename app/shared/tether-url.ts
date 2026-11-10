// The tether:// link: an address of a place in the app that anyone (an agent writing a note, the person pasting it in a
// chat) can follow from anywhere — the OS hands it to the app, which brings the window up and reveals that place,
// wherever it lives (a desk, a pad, the drawer). Two kinds:
//   tether://tab/<pane id>          a pane (a terminal's slot id, or any pane's id)
//   tether://note?path=<abs path>   a file: the note open on it is revealed, or the file is opened as a note
//       &pad=panel|desk|global     opened INSIDE that pad (a note already open elsewhere MOVES into it, never duplicated)
//       &slot=<pane id>            the pane the pad belongs to (panel pad: that panel; desk pad: that panel's desk)
// A link only ever FOCUSES or OPENS: it never runs a command, never passes arguments to an agent (any program can fire a
// tether:// link, so nothing in it may be an action). Pure (unit-tested in test/unit/app.tether-url.test.ts); shared
// by the app, the daemon (TETHER_TAB_URL in each terminal) and the CLI (`tether link`, `tether focus`).

export const TETHER_SCHEME = 'tether'

/** The pad a note link asks to open in: its scope, and the pane that owns it (the panel of a panel pad, the panel whose desk a desk pad is of). */
export type PadScopeName = 'panel' | 'desk' | 'global'
export const PAD_SCOPES: readonly PadScopeName[] = ['panel', 'desk', 'global']
export interface NotePad { scope: PadScopeName; slot?: string }

export type TetherLink =
  | { kind: 'tab'; id: string }
  | { kind: 'note'; path: string; pad?: NotePad }

/** Pane ids the link accepts: slot ids (8 hex) and the app's panel ids (`note-…`, `empty-…`), never anything with a path or a query in it. */
const PANE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const ABSOLUTE = /^(?:[a-zA-Z]:[\\/]|\/(?!\/))/

export function tabUrl(id: string): string {
  return `${TETHER_SCHEME}://tab/${encodeURIComponent(id)}`
}

export function noteUrl(path: string, pad?: NotePad): string {
  const base = `${TETHER_SCHEME}://note?path=${encodeURIComponent(path)}`
  if (!pad) return base
  return `${base}&pad=${pad.scope}${pad.slot ? `&slot=${encodeURIComponent(pad.slot)}` : ''}`
}

/** The place a tether:// link names; undefined for anything else (another scheme, a malformed or unsafe link). */
export function parseTetherUrl(text: string): TetherLink | undefined {
  const raw = text.trim()
  if (!/^tether:\/\//i.test(raw) || raw.length > 4096) return undefined
  let url: URL
  try { url = new URL(raw) } catch { return undefined }
  const host = url.hostname.toLowerCase()
  if (host === 'tab') {
    let id: string
    try { id = decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, '')) } catch { return undefined }
    return PANE_ID.test(id) ? { kind: 'tab', id } : undefined
  }
  if (host === 'note') {
    const path = url.searchParams.get('path')
    if (!path || path.includes('\0') || !ABSOLUTE.test(path)) return undefined // relative or a network share (\\host, //host): refused
    const scope = url.searchParams.get('pad')
    const slot = url.searchParams.get('slot')
    if (scope === null) return slot === null ? { kind: 'note', path } : undefined
    if (!(PAD_SCOPES as readonly string[]).includes(scope)) return undefined
    if (slot !== null && !PANE_ID.test(slot)) return undefined
    return { kind: 'note', path, pad: { scope: scope as PadScopeName, ...(slot ? { slot } : {}) } }
  }
  return undefined
}

/** The first tether:// link among a process's arguments (how the OS hands one to the app). */
export function tetherUrlInArgv(argv: readonly string[]): string | undefined {
  return argv.find(a => /^tether:\/\//i.test(a))
}
