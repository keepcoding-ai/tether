// The note editor's adapter of the app's links (app/shared/links.ts → app/renderer/link-open.ts), installed once for every
// Monaco editor of the app:
//   - a link provider that finds paths in the text with the terminal's own detection (VS Code's parser,
//     app/shared/vscode-terminal-link-parsing.ts) and keeps only those that exist, a relative path read against the
//     folder of the file being edited (the same resolver as the terminal, app/main/terminal-links-main.ts);
//   - tether:// links (app/shared/tether-url.ts), which Monaco's own detection does not know;
//   - one link opener for everything Monaco follows (these paths, tether:// and the http(s) URLs Monaco's own detection finds), so
//     nothing goes through Monaco's default `window.open`: it all lands on openLink, like the terminal and the preview.
// Monaco already follows a link only with Ctrl (Cmd) + click and underlines it on hover.
import { Action, Separator } from 'monaco-editor/base/common/actions.js'
import { channelRefs } from './channel-links.ts'
import { detectChannelRefs, detectUrlLinks, isExternalUrl, type LinkTarget, linkTargetOfUrl, parsePositionFragment, positionFragment } from '../shared/links.ts'
import { detectLinks, getLinkSuffix, type LinkOs } from '../shared/vscode-terminal-link-parsing.ts'
import { type LinkMenuAct, linkMenuRows } from './link-menu.ts'
import { openLink } from './link-open.ts'
import { monaco } from './monaco.ts'

/** Lines longer than this are not scanned for paths (a minified file); at most this many candidates per line. */
const MAX_LINE = 2000
const MAX_PER_LINE = 10
/** Query flag a path link carries when it names a folder. */
const DIR_QUERY = 'dir=1'

let installed = false

const folderOf = (path: string): string => path.replace(/[\\/][^\\/]*$/, '')

export function installMonacoLinks(): void {
  if (installed) return
  installed = true
  const os: LinkOs = /Windows/.test(navigator.userAgent) ? 'windows' : 'posix'

  monaco.languages.registerLinkProvider('*', {
    async provideLinks(model, token) {
      if (model.uri.scheme !== 'file') return { links: [] }
      const baseDir = folderOf(model.uri.fsPath)
      const links: monaco.languages.ILink[] = []
      const channels = channelRefs()
      const jobs: Promise<void>[] = []
      for (let n = 1; n <= model.getLineCount(); n++) {
        const line = model.getLineContent(n)
        if (line.length === 0 || line.length > MAX_LINE) continue
        // tether:// links (Monaco's own detection only knows http(s)): no disk to ask.
        for (const u of detectUrlLinks(line)) {
          if (isAppUrl(u.url)) links.push({ range: new monaco.Range(n, u.start + 1, n, u.end + 1), url: u.url })
        }
        // `#name` of an existing channel (the extension's own list: no request per line).
        for (const r of detectChannelRefs(line, channels)) {
          if (!detectUrlLinks(line).some(u => r.start < u.end && u.start < r.end)) links.push({ range: new monaco.Range(n, r.start + 1, n, r.end + 1), url: r.url })
        }
        for (const parsed of detectLinks(line, os).slice(0, MAX_PER_LINE)) {
          const start = parsed.prefix?.index ?? parsed.path.index
          const end = parsed.path.index + parsed.path.text.length + (parsed.suffix?.suffix.text.length ?? 0)
          const text = line.slice(start, end)
          if (/^(?:https?|tether):/i.test(text)) continue // a URL: found above, or by Monaco's own detection
          jobs.push((async () => {
            const hit = await window.tether.resolveTerminalLink(baseDir, [text]).catch(() => null)
            if (!hit || token.isCancellationRequested) return
            const suffix = getLinkSuffix(text)
            const position = suffix?.row !== undefined ? { line: suffix.row, ...(suffix.col !== undefined ? { column: suffix.col } : {}) } : undefined
            const url = monaco.Uri.file(hit.path).with({ fragment: positionFragment(position), query: hit.isDirectory ? DIR_QUERY : '' })
            links.push({ range: new monaco.Range(n, start + 1, n, end + 1), url })
          })())
        }
      }
      await Promise.all(jobs)
      return { links }
    },
  })

  monaco.editor.registerLinkOpener({
    open(resource) {
      const target = targetOfResource(resource)
      if (target) openLink(target)
      return true // handled (or refused): never Monaco's window.open
    },
  })
}

/** What a link of the editor (a path, a tether:// link, an http(s) URL) is for the app; undefined for what is not followed. The one rule of Ctrl+click and of the menu. */
function targetOfResource(resource: monaco.Uri): LinkTarget | undefined {
  if (resource.scheme === 'file') {
    const position = parsePositionFragment(resource.fragment)
    return { kind: 'file', path: resource.fsPath, isDirectory: resource.query === DIR_QUERY, ...(position ? { position } : {}) }
  }
  const url = resource.toString(true)
  if (isExternalUrl(url)) return { kind: 'external', url }
  const target = linkTargetOfUrl(url)
  return target.kind === 'tether' || target.kind === 'channel' ? target : undefined
}

/** A tether:// link (a pane, a note, a channel): Monaco's own detection does not know the scheme. */
function isAppUrl(url: string): boolean {
  const kind = linkTargetOfUrl(url).kind
  return kind === 'tether' || kind === 'channel'
}

/**
 * Right click on a link in the note editor: the rows of the link's menu (link-menu.ts, the same as every surface, with the key
 * hints) go on top of the menu Monaco already shows, apart by a separator; off a link the menu is Monaco's own. Monaco has no
 * hook for it, so the editor's context-menu contribution is wrapped: `_doShowContextMenu` gets the actions and `_keybindingFor`
 * the hint of a row. When Monaco's internals are not what this expects, the editor keeps its own menu.
 */
export function installNoteLinkMenu(editor: monaco.editor.IStandaloneCodeEditor, baseDir: () => string): void {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const menu = editor.getContribution('editor.contrib.contextmenu') as any
  const detector = editor.getContribution('editor.linkDetector') as any
  if (!menu || !detector || typeof menu._doShowContextMenu !== 'function' || typeof menu._keybindingFor !== 'function' || typeof detector.getLinkOccurrence !== 'function') {
    console.warn('links: the note editor menu cannot take link rows')
    return
  }
  const show = menu._doShowContextMenu.bind(menu) as (actions: unknown[], event: unknown) => void
  const keybindingFor = menu._keybindingFor.bind(menu) as (action: { id: string }) => unknown
  const hints = new Map<string, string>()
  menu._keybindingFor = (action: { id: string }) => {
    const hint = hints.get(action.id)
    return hint ? { getLabel: () => hint } : keybindingFor(action)
  }
  menu._doShowContextMenu = (actions: unknown[], event: { posx?: number; posy?: number; browserEvent?: MouseEvent } | null) => {
    hints.clear()
    const rows = event ? linkRowsAt(event, baseDir()) : []
    if (rows.length === 0) return show(actions, event)
    const mine = rows.map((row, i) => {
      if (row === 'sep') return new Separator()
      const id = `tether.link.${i}`
      if (row.hint) hints.set(id, row.hint)
      return new Action(id, row.label, undefined, true, () => { row.run() })
    })
    show([...mine, new Separator(), ...actions], event)
  }

  function linkRowsAt(event: { posx?: number; posy?: number; browserEvent?: MouseEvent }, dir: string): LinkMenuAct[] {
    const x = event.browserEvent?.clientX ?? event.posx
    const y = event.browserEvent?.clientY ?? event.posy
    if (x === undefined || y === undefined) return []
    const hit = editor.getTargetAtClientPoint(x, y)
    const url = hit?.position ? detector.getLinkOccurrence(hit.position)?.link?.url as monaco.Uri | string | undefined : undefined
    if (url === undefined) return []
    const target = targetOfResource(typeof url === 'string' ? monaco.Uri.parse(url) : url)
    return target ? linkMenuRows(target, { baseDir: dir }) : []
  }
}
