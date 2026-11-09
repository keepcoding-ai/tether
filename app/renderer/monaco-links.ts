// The note editor's adapter of the app's links (app/shared/links.ts → app/renderer/link-open.ts), installed once for every
// Monaco editor of the app:
//   - a link provider that finds paths in the text with the terminal's own detection (VS Code's parser,
//     app/shared/vscode-terminal-link-parsing.ts) and keeps only those that exist, a relative path read against the
//     folder of the file being edited (the same resolver as the terminal, app/main/terminal-links-main.ts);
//   - tether:// links (app/shared/tether-url.ts), which Monaco's own detection does not know;
//   - one link opener for everything Monaco follows (these paths, tether:// and the http(s) URLs Monaco's own detection finds), so
//     nothing goes through Monaco's default `window.open`: it all lands on openLink, like the terminal and the preview.
// Monaco already follows a link only with Ctrl (Cmd) + click and underlines it on hover.
import { detectUrlLinks, isExternalUrl, linkTargetOfUrl, parsePositionFragment, positionFragment } from '../shared/links.ts'
import { detectLinks, getLinkSuffix, type LinkOs } from '../shared/vscode-terminal-link-parsing.ts'
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
      const jobs: Promise<void>[] = []
      for (let n = 1; n <= model.getLineCount(); n++) {
        const line = model.getLineContent(n)
        if (line.length === 0 || line.length > MAX_LINE) continue
        // tether:// links (Monaco's own detection only knows http(s)): no disk to ask.
        for (const u of detectUrlLinks(line)) {
          if (linkTargetOfUrl(u.url).kind === 'tether') links.push({ range: new monaco.Range(n, u.start + 1, n, u.end + 1), url: u.url })
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
      if (resource.scheme === 'file') {
        const position = parsePositionFragment(resource.fragment)
        openLink({ kind: 'file', path: resource.fsPath, isDirectory: resource.query === DIR_QUERY, ...(position ? { position } : {}) })
      } else {
        const url = resource.toString(true)
        if (isExternalUrl(url)) openLink({ kind: 'external', url })
        else if (linkTargetOfUrl(url).kind === 'tether') openLink({ kind: 'tether', url })
      }
      return true // handled (or refused): never Monaco's window.open
    },
  })
}
