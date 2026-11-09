// The terminal's adapter of the app's links (app/shared/links.ts → app/renderer/link-open.ts): one xterm link provider
// for both kinds a terminal shows — http(s) URLs (app/shared/links.ts detectWebLinks) and paths (VS Code's detection,
// app/shared/vscode-terminal-link-detector.ts; whether a candidate exists is asked of main, app/main/terminal-links-main.ts,
// which reads a relative path against the folder the pane was OPENED in — only a path that exists becomes a link).
// Like VS Code, and like every other surface of the app: a link is underlined as soon as the pointer is over it and says
// "Seguir link (Ctrl + clique)" (the pane's tooltip); the hand pointer shows only while Ctrl (Cmd on macOS) is down, and
// only a click with it follows the link.
import type { IBufferRange, ILink, ILinkDecorations, ILinkProvider, Terminal } from '@xterm/xterm'
import type { LinkTarget } from '../shared/links.ts'
import { detectWebLinks } from '../shared/links.ts'
import {
  convertLinkRangeToBuffer, getXtermLineContent, type LinkBufferLine, provideLocalLinks,
} from '../shared/vscode-terminal-link-detector.ts'
import { FOLLOW_LINK_TIP, isModifierDown } from './link-open.ts'

export { FOLLOW_LINK_TIP } from './link-open.ts'

export interface TerminalLinkHost {
  /** The folder this pane was opened in (relative paths are read against it); undefined when not known yet. */
  openingCwd(): string | undefined
  /** A link was Ctrl+clicked. */
  open(target: LinkTarget): void
}

class FollowLink implements ILink {
  // xterm replaces this object with one wired to its renderer while the link is hovered (so set() works then)
  decorations: ILinkDecorations = { pointerCursor: false, underline: false }
  private cleanup: (() => void) | undefined
  readonly range: IBufferRange
  readonly text: string
  private readonly target: LinkTarget
  private readonly open: (target: LinkTarget) => void
  private readonly tip: (text: string | undefined) => void

  constructor(range: IBufferRange, text: string, target: LinkTarget, open: (target: LinkTarget) => void, tip: (text: string | undefined) => void) {
    this.range = range
    this.text = text
    this.target = target
    this.open = open
    this.tip = tip
  }

  activate(event: MouseEvent): void {
    if (isModifierDown(event)) this.open(this.target)
  }

  hover(event: MouseEvent): void {
    this.cleanup?.()
    // Underlined while hovered, whatever the keys; the hand only with the modifier.
    const set = (hand: boolean): void => {
      if (this.decorations.pointerCursor !== hand) this.decorations.pointerCursor = hand
      if (!this.decorations.underline) this.decorations.underline = true
    }
    const onKey = (e: KeyboardEvent): void => { if (!e.repeat) set(isModifierDown(e)) }
    const onMove = (e: MouseEvent): void => set(isModifierDown(e))
    this.tip(FOLLOW_LINK_TIP)
    document.addEventListener('keydown', onKey)
    document.addEventListener('keyup', onKey)
    document.addEventListener('mousemove', onMove)
    this.cleanup = () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('keyup', onKey)
      document.removeEventListener('mousemove', onMove)
    }
    // xterm swaps `decorations` for an object wired to its renderer right after this call returns, taking the
    // initial values: apply the state of Ctrl then, or a pointer already over the link with Ctrl down would show nothing.
    const initial = isModifierDown(event)
    setTimeout(() => { if (this.cleanup) set(initial) }, 0)
  }

  leave(): void {
    this.cleanup?.()
    this.cleanup = undefined
    this.tip(undefined)
    this.decorations.pointerCursor = false
    this.decorations.underline = false
  }
}

/** The URLs of the wrapped line the buffer line (1-based) belongs to, as buffer ranges (a URL that wraps is one link). */
function webLinksAt(term: Terminal, bufferLineNumber: number): { range: IBufferRange; url: string }[] {
  const buffer = term.buffer.active
  let start = bufferLineNumber - 1
  let end = start
  const first = buffer.getLine(start)
  if (!first) return []
  const lines: LinkBufferLine[] = [first]
  while (start > 0 && buffer.getLine(start)?.isWrapped) { const prev = buffer.getLine(start - 1); if (!prev) break; lines.unshift(prev); start-- }
  while (end + 1 < buffer.length && buffer.getLine(end + 1)?.isWrapped) { const next = buffer.getLine(end + 1); if (!next) break; lines.push(next); end++ }
  const text = getXtermLineContent(buffer, start, end, term.cols)
  return detectWebLinks(text).map(l => ({
    url: l.url,
    range: convertLinkRangeToBuffer(lines, term.cols, { startColumn: l.start + 1, startLineNumber: 1, endColumn: l.end + 1, endLineNumber: 1 }, start),
  }))
}

const overlaps = (a: IBufferRange, b: IBufferRange): boolean => {
  const before = (p: { x: number; y: number }, q: { x: number; y: number }): boolean => p.y < q.y || (p.y === q.y && p.x < q.x)
  return !(before(a.end, b.start) || before(b.end, a.start))
}

export function terminalLinkProvider(term: Terminal, host: TerminalLinkHost): ILinkProvider {
  const os = /Windows/.test(navigator.userAgent) ? 'windows' : 'posix'
  // xterm has no tooltip of its own for a link: the pane's element carries it while a link is hovered.
  const tip = (text: string | undefined): void => { if (text) term.element?.setAttribute('title', text); else term.element?.removeAttribute('title') }
  const open = (t: LinkTarget): void => host.open(t)
  return {
    provideLinks(bufferLineNumber, callback) {
      const web = webLinksAt(term, bufferLineNumber).map(w => new FollowLink(w.range, w.url, { kind: 'external', url: w.url }, open, tip))
      const cwd = host.openingCwd()
      provideLocalLinks(term, bufferLineNumber, os, async candidates => {
        try { return await window.tether.resolveTerminalLink(cwd, candidates) } catch (err) { console.error('terminal links:', err); return null }
      }).then(
        found => {
          // A URL wins over a path read inside it (`https://x/a.ts` is the URL, not `a.ts`).
          const paths = found
            .filter(l => !web.some(w => overlaps(w.range, l.bufferRange)))
            .map(l => new FollowLink(l.bufferRange, l.text, { kind: 'file', path: l.path, isDirectory: l.isDirectory, ...(l.position ? { position: l.position } : {}) }, open, tip))
          const all = [...web, ...paths]
          callback(all.length > 0 ? all : undefined)
        },
        err => { console.error('terminal links:', err); callback(web.length > 0 ? web : undefined) },
      )
    },
  }
}
