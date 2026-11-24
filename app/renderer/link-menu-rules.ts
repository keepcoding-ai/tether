// The rows of the context menu of a link, by kind of link (pure, unit-tested in test/unit/app.link-menu-rules.test.ts).
// One menu for every surface (terminal, markdown preview, channel): right-click on a link opens it; Ctrl+click still follows
// the link, and Alt+click on a link to a pane peeks at it. The hint on the right of a row names the gesture that does the same.
import type { LinkTarget } from '../shared/links.ts'
import { parseTetherUrl } from '../shared/tether-url.ts'

/** What a row does. `follow` is what Ctrl+click does; `follow-side` opens it beside; `peek` is Alt+click on a pane link. */
export type LinkMenuAction = 'follow' | 'follow-side' | 'peek' | 'copy'

export interface LinkMenuRow { action: LinkMenuAction; label: string; icon: string; hint?: string }
export type LinkMenuLine = LinkMenuRow | 'sep'

export interface LinkMenuFacts {
  /** The link names a pane of a slot the app knows (only then can it be peeked at). */
  peekable: boolean
  mac: boolean
}

/** The follow modifier as the person reads it. */
export const followKey = (mac: boolean): string => (mac ? 'Cmd+clique' : 'Ctrl+clique')
/** The peek modifier as the person reads it. */
export const peekKey = (mac: boolean): string => (mac ? 'Opção+clique' : 'Alt+clique')

/**
 * Alt (Option on macOS) alone with the main button: Ctrl, Cmd or Shift with it are other gestures (Ctrl+click follows, dockview's
 * Shift+drag on a tab floats a group). Used by a tab's header for "Espiar".
 */
export function isPeekClick(ev: { button: number; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): boolean {
  return ev.button === 0 && ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey
}

/** The id of the pane a tether://tab link names; undefined for any other target. */
export function paneOfLink(target: LinkTarget): string | undefined {
  if (target.kind !== 'tether') return undefined
  const link = parseTetherUrl(target.url)
  return link?.kind === 'tab' ? link.id : undefined
}

/** What "copy" puts in the clipboard: the link, or the path of a file. */
export function linkCopyText(target: LinkTarget): string | undefined {
  if (target.kind === 'external' || target.kind === 'tether') return target.url
  if (target.kind === 'file') return target.path
  return undefined
}

/** The rows of a link's menu; empty for what is not followed (an anchor, an ignored link). */
export function linkMenuPlan(target: LinkTarget, facts: LinkMenuFacts): LinkMenuLine[] {
  const follow = followKey(facts.mac)
  switch (target.kind) {
    case 'tether': {
      const link = parseTetherUrl(target.url)
      if (!link) return []
      if (link.kind === 'tab') {
        return [
          { action: 'follow', label: 'Ir para a guia', icon: 'arrow-square-out', hint: follow },
          ...(facts.peekable ? [{ action: 'peek', label: 'Espiar', icon: 'eye', hint: peekKey(facts.mac) } satisfies LinkMenuRow] : []),
          'sep',
          { action: 'copy', label: 'Copiar link', icon: 'copy' },
        ]
      }
      return [
        { action: 'follow', label: 'Abrir nota', icon: 'arrow-square-out', hint: follow },
        { action: 'follow-side', label: 'Abrir ao lado', icon: 'columns' },
        'sep',
        { action: 'copy', label: 'Copiar link', icon: 'copy' },
      ]
    }
    case 'external':
      return [
        { action: 'follow', label: 'Abrir no navegador do sistema', icon: 'arrow-square-out', hint: follow },
        'sep',
        { action: 'copy', label: 'Copiar link', icon: 'copy' },
      ]
    case 'file':
      if (target.isDirectory) {
        return [
          { action: 'follow', label: 'Abrir pasta', icon: 'folder-open', hint: follow },
          'sep',
          { action: 'copy', label: 'Copiar caminho', icon: 'copy' },
        ]
      }
      return [
        { action: 'follow', label: 'Abrir', icon: 'file', hint: follow },
        { action: 'follow-side', label: 'Abrir ao lado', icon: 'columns' },
        'sep',
        { action: 'copy', label: 'Copiar caminho', icon: 'copy' },
      ]
    default:
      return []
  }
}
