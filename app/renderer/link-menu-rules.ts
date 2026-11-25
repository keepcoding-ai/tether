// The rows of the context menu of a link, by kind of link (pure, unit-tested in test/unit/app.link-menu-rules.test.ts).
// One menu for every surface (terminal, markdown preview, channel): right-click on a link opens it; Ctrl+click still follows
// the link, and Alt+click on a link to a pane peeks at it. The hint on the right of a row names the gesture that does the same.
import type { LinkTarget } from '../shared/links.ts'
import { channelUrl, parseTetherUrl } from '../shared/tether-url.ts'

/** What a row does. `follow` is what Ctrl+click does; `follow-side` opens it beside; `peek` is Alt+click on a pane link. */
export type LinkMenuAction = 'follow' | 'follow-side' | 'peek' | 'copy' | 'reveal' | 'show-in-folder' | 'copy-relative' | 'bridge'

export interface LinkMenuRow { action: LinkMenuAction; label: string; icon: string; hint?: string }
export type LinkMenuLine = LinkMenuRow | 'sep'

export interface LinkMenuFacts {
  /** The link names a pane of a slot the app knows (only then can it be peeked at). */
  peekable: boolean
  mac: boolean
  /** The folders the explorer shows (agents' and pinned ones); undefined when the explorer is off. Only a file under one can be shown in its tree. */
  explorerRoots?: readonly string[]
  /** The folder of the tab the link came from; a file under it gets "Copiar caminho relativo". */
  baseDir?: string
  /** Paths compare without case (Windows, macOS). */
  caseInsensitive?: boolean
  /**
   * The name of the browser the Bridge has connected ("Chrome", "Edge"…); undefined when the web-bridge extension is off, its
   * daemon is down or no browser is connected. Only then does an http(s) link get "Abrir no <nome> pelo Bridge".
   */
  bridgeBrowser?: string
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
  if (target.kind === 'channel') return channelUrl(target.id)
  if (target.kind === 'file') return target.path
  return undefined
}

/**
 * A path relative to a folder, with `/` separators; undefined when the path is the folder itself or lies outside it (the
 * relative form would then be the absolute one again, or climb out with `..`).
 */
export function relativeToFolder(folder: string, path: string, caseInsensitive: boolean): string | undefined {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const base = norm(folder)
  const full = norm(path)
  if (base === '' || full === '') return undefined
  const key = (p: string): string => (caseInsensitive ? p.toLowerCase() : p)
  if (!key(full).startsWith(`${key(base)}/`)) return undefined
  return full.slice(base.length + 1)
}

/** What "copy relative" puts in the clipboard: the file's path under the folder the link came from; undefined when there is none. */
export function relativeCopyText(target: LinkTarget, facts: Pick<LinkMenuFacts, 'baseDir' | 'caseInsensitive'>): string | undefined {
  if (target.kind !== 'file' || !facts.baseDir) return undefined
  return relativeToFolder(facts.baseDir, target.path, facts.caseInsensitive === true)
}

/** Whether the explorer can reveal the file: it lies under one of the folders the explorer shows (the folder itself does not count). */
export function explorerCanReveal(target: LinkTarget, facts: Pick<LinkMenuFacts, 'explorerRoots' | 'caseInsensitive'>): boolean {
  if (target.kind !== 'file' || !facts.explorerRoots) return false
  const ci = facts.caseInsensitive === true
  return facts.explorerRoots.some(root => relativeToFolder(root, target.path, ci) !== undefined)
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
    case 'channel':
      return [
        { action: 'follow', label: 'Abrir canal', icon: 'arrow-square-out', hint: follow },
        'sep',
        { action: 'copy', label: 'Copiar link', icon: 'copy' },
      ]
    case 'external':
      return [
        { action: 'follow', label: 'Abrir no navegador do sistema', icon: 'arrow-square-out', hint: follow },
        ...(facts.bridgeBrowser ? [{ action: 'bridge', label: `Abrir no ${facts.bridgeBrowser} pelo Bridge`, icon: 'globe-simple' } satisfies LinkMenuRow] : []),
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
        ...(explorerCanReveal(target, facts) ? [{ action: 'reveal', label: 'Mostrar no explorador do tether', icon: 'target' } satisfies LinkMenuRow] : []),
        { action: 'show-in-folder', label: 'Mostrar na pasta do sistema', icon: 'arrow-square-out' },
        'sep',
        { action: 'copy', label: 'Copiar caminho', icon: 'copy' },
        ...(relativeCopyText(target, facts) !== undefined ? [{ action: 'copy-relative', label: 'Copiar caminho relativo', icon: 'copy' } satisfies LinkMenuRow] : []),
      ]
    default:
      return []
  }
}
