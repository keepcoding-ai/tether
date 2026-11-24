// The core's door to "which channels exist" and "open a channel's pane" for the links of every surface. The channels extension
// registers a source (ext-api `links.provideChannels`); the core never imports it. The list is the extension's own cache,
// kept fresh by the events it already hears: a surface asks it on every scan, never the daemon.
import { type ChannelRef, detectChannelRefs } from '../shared/links.ts'

export interface ChannelSource {
  /** Every channel known now, open or closed. Synchronous: a cache. */
  list(): readonly ChannelRef[]
  /** Opens the channel's pane, or brings the existing one forward. */
  open(channelId: string): void
}

let source: ChannelSource | undefined

/** The extension registers its source; returns the way to take it back. */
export function setChannelSource(next: ChannelSource): { dispose(): void } {
  source = next
  return { dispose: () => { if (source === next) source = undefined } }
}

/** The channels links can name now (empty while the extension is off). */
export function channelRefs(): readonly ChannelRef[] {
  return source?.list() ?? []
}

/** Follows a channel link; false when no extension serves channels. */
export function openChannelLink(channelId: string): boolean {
  if (!source) return false
  source.open(channelId)
  return true
}

const SKIP = new Set(['A', 'CODE', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA'])

/**
 * Turns each `#name` of an existing channel in the text of `root` (a rendered markdown) into an `<a href="tether://channel/<id>">`.
 * Links, code and preformatted text are left as they are. Text nodes only: nothing is ever written as HTML.
 */
export function linkifyChannelRefs(root: Element): void {
  const channels = channelRefs()
  if (channels.length === 0) return
  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */, {
    acceptNode: node => {
      for (let p = node.parentElement; p && p !== root; p = p.parentElement) if (SKIP.has(p.tagName)) return 2 /* FILTER_REJECT */
      return node.nodeValue?.includes('#') ? 1 /* FILTER_ACCEPT */ : 3 /* FILTER_SKIP */
    },
  })
  const nodes: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text)
  for (const node of nodes) {
    const text = node.nodeValue ?? ''
    const found = detectChannelRefs(text, channels)
    if (found.length === 0) continue
    const frag = doc.createDocumentFragment()
    let at = 0
    for (const l of found) {
      if (l.start > at) frag.append(text.slice(at, l.start))
      const a = doc.createElement('a')
      a.setAttribute('href', l.url)
      a.textContent = text.slice(l.start, l.end)
      frag.append(a)
      at = l.end
    }
    if (at < text.length) frag.append(text.slice(at))
    node.replaceWith(frag)
  }
}
