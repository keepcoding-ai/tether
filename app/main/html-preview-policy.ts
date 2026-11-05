// What the HTML preview's page may reach (F5, "prévia de HTML"). Pure functions (no Electron): the main process applies
// them to every request and navigation of the isolated webview (app/main/html-preview-main.ts), the unit tests run them
// under plain Node.
//
// The model, as the Simple Browser of VS Code draws it, with the page's own folder as the only door to the disk:
//   - a `file:` URL is reachable only inside the folder of the opened file and below (the root). `..`, encoded dots,
//     backslashes, drive switches, UNC paths and links (symlinks, junctions) that point out of the root are refused;
//   - top-level navigation: a file inside the root moves the preview; `http(s)` leaves for the system browser; the rest is refused;
//   - sub-resources (scripts, styles, images, fonts, fetches, frames) may come from `https:` (CDNs, web fonts: the previews
//     the agents write use them), `wss:`, `data:` and `blob:`. Plain `http:`/`ws:` and any host that names this machine or its
//     network (localhost, loopback, private ranges, link-local, `.local`) are refused: a page of ours must not probe services
//     the person runs, and a referer-less request over plain text is not worth the risk;
//   - everything else (`ftp:`, `devtools:`, `chrome-extension:`, `view-source:`…) is refused.
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { isHtmlPath } from '../shared/preview.ts'

/** Paths compare case-insensitively where the file system does (Windows, macOS default). */
export function pathsAreCaseInsensitive(platform: string = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin'
}

export interface PolicyOptions {
  /** Resolves links; the path as given when it does not exist. Absent: the lexical check only. */
  realpath?: (path: string) => string
  caseInsensitive?: boolean
}

/** A `file:` URL as a local path, or undefined when it names anything else (another scheme, a host, a UNC share, a bad escape). */
export function fileUrlPath(url: string): string | undefined {
  let parsed: URL
  try { parsed = new URL(url) } catch { return undefined }
  if (parsed.protocol !== 'file:') return undefined
  // `file://host/share/x` is a network share: reading it would send the user's credentials to whoever named the host.
  if (parsed.hostname !== '' && parsed.hostname.toLowerCase() !== 'localhost') return undefined
  let path: string
  try { path = fileURLToPath(parsed) } catch { return undefined }
  if (path.startsWith('\\\\') || path.startsWith('//')) return undefined // `file:////host/share`, `file:///\\host\share`
  if (path.includes('\0')) return undefined
  return path
}

function fold(path: string, caseInsensitive: boolean): string {
  return caseInsensitive ? path.toLowerCase() : path
}

/** Whether `file` is `root` itself or inside it (lexically, after resolving `.` and `..`). */
export function isInside(root: string, file: string, caseInsensitive: boolean = pathsAreCaseInsensitive()): boolean {
  if (!isAbsolute(root) || !isAbsolute(file)) return false
  const rel = relative(fold(resolve(root), caseInsensitive), fold(resolve(file), caseInsensitive))
  if (rel === '') return true
  if (isAbsolute(rel)) return false // another drive
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

/**
 * Whether the local path may be read by a page whose door is `root`: inside it lexically and, when the file exists, inside it
 * once links are followed (a junction in the folder that leads out does not).
 */
export function pathAllowed(root: string, file: string, opts: PolicyOptions = {}): boolean {
  const ci = opts.caseInsensitive ?? pathsAreCaseInsensitive()
  if (!isInside(root, file, ci)) return false
  if (!opts.realpath) return true
  let realRoot = root
  let realFile = file
  try { realRoot = opts.realpath(root) } catch { /* the root itself is gone: the lexical answer stands */ }
  try { realFile = opts.realpath(file) } catch { return true } // a file that does not exist cannot leak; the load just fails
  return isInside(realRoot, realFile, ci)
}

/** The root a page opened from `file` gets: its own folder. */
export function rootOf(file: string): string {
  return dirname(resolve(file))
}

/** A page whose URL is `url`: a local `.html` file (the only thing the preview is opened on). */
export function previewablePageUrl(url: string): string | undefined {
  const path = fileUrlPath(url)
  return path && isHtmlPath(path) ? path : undefined
}

/** Hosts that mean "this machine or its network". `hostname` as the URL parser prints it (IPv4 numeric forms are already dotted). */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === '' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return true
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  }
  if (host.includes(':')) { // IPv6 literal
    if (host === '::' || host === '::1') return true
    if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true // unique-local, link-local
    const mapped = /^::ffff:(.+)$/.exec(host) // IPv4-mapped: judged as the IPv4 it carries
    if (mapped) {
      const tail = mapped[1]!
      const dotted = /^\d+\.\d+\.\d+\.\d+$/.test(tail) ? tail : hexPairToV4(tail)
      return dotted === undefined ? true : isLocalHost(dotted)
    }
  }
  return false
}

function hexPairToV4(tail: string): string | undefined {
  const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail)
  if (!m) return undefined
  const hi = parseInt(m[1]!, 16)
  const lo = parseInt(m[2]!, 16)
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
}

export type RequestDecision = { allow: true } | { allow: false; reason: string }

/** A sub-resource request of the page (or of a frame in it). */
export function decideRequest(url: string, root: string, opts: PolicyOptions = {}): RequestDecision {
  let parsed: URL
  try { parsed = new URL(url) } catch { return { allow: false, reason: 'URL inválida' } }
  switch (parsed.protocol) {
    case 'file:': {
      const path = fileUrlPath(url)
      if (!path) return { allow: false, reason: 'caminho de rede ou inválido' }
      return pathAllowed(root, path, opts) ? { allow: true } : { allow: false, reason: 'fora da pasta da página' }
    }
    case 'https:':
    case 'wss:':
      return isLocalHost(parsed.hostname) ? { allow: false, reason: 'endereço da máquina ou da rede local' } : { allow: true }
    case 'data:':
    case 'blob:':
    case 'about:':
    case 'chrome-error:':
      return { allow: true }
    case 'http:':
    case 'ws:':
      return { allow: false, reason: 'sem criptografia (use https)' }
    default:
      return { allow: false, reason: `protocolo ${parsed.protocol} não permitido` }
  }
}

export type NavigationDecision =
  | { kind: 'allow' }
  /** Leaves for the system browser; nothing navigates in the preview. */
  | { kind: 'external'; url: string }
  | { kind: 'block'; reason: string }

/** The page (top level) wants to go to `url`: a click, a redirect, `location=`, a `window.open`. */
export function decideNavigation(url: string, root: string, opts: PolicyOptions = {}): NavigationDecision {
  let parsed: URL
  try { parsed = new URL(url) } catch { return { kind: 'block', reason: 'URL inválida' } }
  if (parsed.protocol === 'file:') {
    const d = decideRequest(url, root, opts)
    return d.allow ? { kind: 'allow' } : { kind: 'block', reason: d.reason }
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return { kind: 'external', url: parsed.href }
  if (parsed.href === 'about:blank') return { kind: 'allow' }
  return { kind: 'block', reason: `protocolo ${parsed.protocol} não permitido` }
}

/** Partition names of the previews: in memory (no `persist:`), one per pane, nothing shared with the app's session. */
export const PREVIEW_PARTITION_PREFIX = 'htmlprev-'

export function isPreviewPartition(name: unknown): name is string {
  return typeof name === 'string' && /^htmlprev-[A-Za-z0-9_-]{1,80}$/.test(name)
}
