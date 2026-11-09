// The pure rules of the tabs' files (Tether Browser E13, design §4.3, §12a, review M1): where a download lands and under what
// name, the ceilings (the package's: 50 MB per file and 200 MB per agent, the package's "per session" being here the agent's
// folder), the "Baixados" lines of the pad, the upload consent's dialog (the agent, the file and its folder, and the site that
// OWNS THE FIELD, which may be a frame of another site inside the page), and how the gate recognises the package's attach.
import type { DialogSpec } from '../../app/shared/dialog.ts'

/** The package's ceilings (`@atrium/browser` downloads.ts: MAX_DOWNLOAD_BYTES, MAX_SESSION_DOWNLOAD_BYTES). */
export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024
export const MAX_AGENT_DOWNLOAD_BYTES = 200 * 1024 * 1024

/** How long the person's yes waits for the attach it allows (the package attaches right after the answer). */
export const UPLOAD_GRANT_MS = 15_000

/**
 * A download's file name: no folder (the last part of a path, either slash), no character Windows refuses, no trailing dot or
 * space, at most 200 characters, never empty nor dots only, never a reserved device name (`con`, `nul`, `com1`...: prefixed).
 * The same rule as the package's `safeFilename`.
 */
export function safeDownloadName(suggested: string): string {
  let name = (suggested.replace(/\\/g, '/').split('/').pop() ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .slice(0, 200)
  if (name === '' || /^\.+$/.test(name)) name = 'download'
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) name = `_${name}`
  return name
}

/** `name`, or `name-1.ext`, `name-2.ext`... the first one `taken` says is free (never overwrites). */
export function uniqueName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 1; ; i++) {
    const c = `${stem}-${i}${ext}`
    if (!taken(c)) return c
  }
}

export type DownloadOver = 'file' | 'agent'

/**
 * Whether a download may go on: `bytes` is what is known of it (the announced total, or what arrived so far), `others` what the
 * agent already keeps (its folder plus its other downloads still arriving). Over a ceiling it is cancelled.
 */
export function downloadOver(bytes: number, others: number): DownloadOver | null {
  if (bytes > MAX_DOWNLOAD_BYTES) return 'file'
  if (others + bytes > MAX_AGENT_DOWNLOAD_BYTES) return 'agent'
  return null
}

/** Bytes as the person reads them ("12 KB", "3,4 MB"). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  const mb = n / (1024 * 1024)
  return `${(mb < 10 ? mb.toFixed(1) : String(Math.round(mb))).replace('.', ',')} MB`
}

/** One file an agent downloaded, as the pad lists it. */
export interface DownloadEntry {
  slotId: string
  name: string
  bytes: number
  /** When it finished (ms since the epoch). */
  at: number
}

export const PAD_DOWNLOADS = 'Baixados'
export const PAD_SHOW_IN_FOLDER = 'Mostrar na pasta'

/** "agora", "há 5 min", "há 2 h", or the date. */
export function whenText(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'agora'
  if (s < 3600) return `há ${Math.round(s / 60)} min`
  if (s < 86_400) return `há ${Math.round(s / 3600)} h`
  const d = new Date(at)
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** The pad's "Baixados" by agent, the newest first in each group; agents in the order of their newest file. */
export function downloadGroups(entries: readonly DownloadEntry[]): { slotId: string; files: DownloadEntry[] }[] {
  const sorted = [...entries].sort((a, b) => b.at - a.at)
  const groups = new Map<string, DownloadEntry[]>()
  for (const e of sorted) {
    const g = groups.get(e.slotId) ?? []
    g.push(e)
    groups.set(e.slotId, g)
  }
  return [...groups].map(([slotId, files]) => ({ slotId, files }))
}

// ---- the upload consent ----

/** One upload waiting for the person. `frameOrigin` owns the field; `pageOrigin` is the tab's. */
export interface UploadAsk {
  id: string
  tabId: string
  agent: string
  fileName: string
  folder: string
  frameOrigin: string
  pageOrigin: string
  /** The page as it is now (a `data:image/jpeg` address), when it could be drawn. */
  image?: string
}

export const UPLOAD_SITUATION = 'browser-upload'

/** Splits a path the package gave into folder and name (either slash; the name never empty). */
export function splitPath(path: string): { folder: string; name: string } {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i < 0 ? { folder: '', name: path } : { folder: path.slice(0, i) || path.slice(0, 1), name: path.slice(i + 1) || path }
}

/**
 * The origin as the person reads it: `https://host` or `http://host:port`; text that is not an http(s) origin is shown quoted
 * (a crafted value with a line break cannot forge lines).
 */
export function originText(origin: string): string {
  try {
    const u = new URL(origin)
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin === origin.replace(/\/$/, '')) return u.origin
  } catch { /* not a URL */ }
  return JSON.stringify(origin)
}

/** Where the field is, in words: the frame's site, and the page's when it is another. */
export function fieldOwnerText(frameOrigin: string, pageOrigin: string): string {
  const frame = originText(frameOrigin)
  const page = originText(pageOrigin)
  return frame === page ? `O campo é de ${frame}.` : `O campo é de ${frame}, dentro de ${page}.`
}

export function uploadDialog(ask: UploadAsk): DialogSpec {
  const site = originText(ask.frameOrigin)
  const other = originText(ask.frameOrigin) !== originText(ask.pageOrigin)
  return {
    situation: UPLOAD_SITUATION,
    tone: 'warn',
    icon: 'tray-arrow-up',
    title: `Permitir que ${ask.agent} envie ${ask.fileName} para ${site}?`,
    message: `${fieldOwnerText(ask.frameOrigin, ask.pageOrigin)}${other ? ' É outro site, embutido na página.' : ''} O conteúdo do arquivo vai para esse site.`,
    context: { icon: 'file', name: ask.fileName, lines: [ask.folder || '(pasta desconhecida)', `Pedido por ${ask.agent}`] },
    ...(ask.image ? { image: { src: ask.image, alt: 'A página agora' } } : {}),
    choices: [
      { id: 'allow', icon: 'tray-arrow-up', label: 'Permitir', consequence: `${ask.fileName} é anexado ao campo de ${site}; só este arquivo, só desta vez.`, tone: 'neutral' },
      { id: 'deny', icon: 'shield-warning', label: 'Não permitir', consequence: `Nada é enviado e ${ask.agent} recebe a recusa.`, tone: 'safe' },
    ],
    defaultChoice: 'deny',
    escChoice: 'deny',
  }
}

// ---- the gate's view of the attach ----

/**
 * Whether a `Runtime.callFunctionOn` is playwright-core's file attach carrying files: the function it evaluates names
 * `setInputFiles(` (`injected.setInputFiles(node, files)`, passed as the declaration or as a string argument of the utility
 * script) and its arguments carry a file's `buffer`. The empty list (the package clearing the field) carries none. Code of
 * the agent's own that builds a File some other way is JavaScript the gate cannot read for intent: this recognises only the
 * package's path.
 */
export function attachCarriesFiles(params: { functionDeclaration?: unknown; arguments?: unknown }): boolean {
  const args = Array.isArray(params.arguments) ? params.arguments : []
  const strings = args.map(a => (a && typeof a === 'object' ? (a as { value?: unknown }).value : undefined))
  const names = [params.functionDeclaration, ...strings].some(v => typeof v === 'string' && v.includes('setInputFiles('))
  if (!names) return false
  return JSON.stringify(args).includes('"buffer"')
}

/** A grant the person gave: one attach, on this tab, into a frame of this origin, before `until`. */
export interface UploadGrant { origin: string; until: number }

/** Why the attach may not go (null: it may), given the grant of the tab and the origin of the frame it lands in. */
export function attachRefusal(grant: UploadGrant | undefined, frameOrigin: string | undefined, now: number): string | null {
  if (!grant) return 'no consent of the person for this tab'
  if (grant.until < now) return 'the consent ran out'
  if (frameOrigin === undefined) return 'the frame of the field could not be read'
  if (frameOrigin !== grant.origin) return `the field is now in ${frameOrigin}, the consent was for ${grant.origin}`
  return null
}
