// Ctrl+click on a path printed in a terminal (xterm link provider). Detection is VS Code's (app/shared/
// vscode-terminal-link-detector.ts); whether a candidate exists is asked of main (app/main/terminal-links-main.ts),
// which reads a relative path against the folder the pane was OPENED in. Only a path that exists becomes a link.
// Like VS Code: a path is underlined as soon as the pointer is over it and says "Seguir link (Ctrl + clique)" (the pane's
// tooltip); the hand pointer shows only while Ctrl (Cmd on macOS) is down, and only a click with it follows the link. A
// click without it does nothing here (the web links of @xterm/addon-web-links are another provider and are untouched).
import type { IBufferRange, ILink, ILinkDecorations, ILinkProvider, Terminal } from '@xterm/xterm'
import type { LineColumn } from '../shared/file-open.ts'
import { type DetectedLink, provideLocalLinks } from '../shared/vscode-terminal-link-detector.ts'

export interface TerminalLinkTarget {
  /** Absolute path of the file or folder. */
  path: string
  isDirectory: boolean
  position?: LineColumn
}

export interface TerminalLinkHost {
  /** The folder this pane was opened in (relative paths are read against it); undefined when not known yet. */
  openingCwd(): string | undefined
  /** A link was Ctrl+clicked. */
  open(target: TerminalLinkTarget): void
}

const IS_MAC = /Macintosh/.test(navigator.userAgent)
const isModifierDown = (ev: MouseEvent | KeyboardEvent): boolean => (IS_MAC ? ev.metaKey : ev.ctrlKey)

/** The tooltip VS Code shows over a link ("Follow link (ctrl + click)"). */
export const FOLLOW_LINK_TIP = `Seguir link (${IS_MAC ? 'Cmd' : 'Ctrl'} + clique)`

class PathLink implements ILink {
  readonly range: IBufferRange
  readonly text: string
  // xterm replaces this object with one wired to its renderer while the link is hovered (so set() works then)
  decorations: ILinkDecorations = { pointerCursor: false, underline: false }
  private cleanup: (() => void) | undefined
  private readonly detected: DetectedLink
  private readonly open: (target: TerminalLinkTarget) => void
  private readonly tip: (text: string | undefined) => void

  constructor(detected: DetectedLink, open: (target: TerminalLinkTarget) => void, tip: (text: string | undefined) => void) {
    this.detected = detected
    this.open = open
    this.tip = tip
    this.range = detected.bufferRange
    this.text = detected.text
  }

  activate(event: MouseEvent): void {
    if (!isModifierDown(event)) return
    const { path, isDirectory, position } = this.detected
    this.open({ path, isDirectory, ...(position ? { position } : {}) })
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
    // initial values: apply the state of Ctrl then, or a pointer already over the path with Ctrl down would show nothing.
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

export function terminalLinkProvider(term: Terminal, host: TerminalLinkHost): ILinkProvider {
  const os = /Windows/.test(navigator.userAgent) ? 'windows' : 'posix'
  // xterm has no tooltip of its own for a link: the pane's element carries it while a path is hovered.
  const tip = (text: string | undefined): void => { if (text) term.element?.setAttribute('title', text); else term.element?.removeAttribute('title') }
  return {
    provideLinks(bufferLineNumber, callback) {
      const cwd = host.openingCwd()
      provideLocalLinks(term, bufferLineNumber, os, async candidates => {
        try { return await window.tether.resolveTerminalLink(cwd, candidates) } catch (err) { console.error('terminal links:', err); return null }
      }).then(
        links => callback(links.length > 0 ? links.map(l => new PathLink(l, t => host.open(t), tip)) : undefined),
        err => { console.error('terminal links:', err); callback(undefined) },
      )
    },
  }
}
