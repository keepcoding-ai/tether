// The pure rules of the tab registry (Tether Browser E2): what a tab is, which addresses a tab may open, which ones may be
// written to layout.json and reloaded after a restart, where a new tab goes among the others (grouped by owner), and how
// the cookie-encryption fuse is read from the Electron executable (design §4.2, §5.2, §7.3, §12b rule 19).

/** A tab: the agent's page. `ownerSlotId` is the daemon's slot id of the agent that owns it; `surfaceId` is the core's view. */
export interface Tab {
  tabId: string
  ownerSlotId: string
  surfaceId: string
  url: string
  title: string
  createdAt: number
}

/** What the renderer is told about a tab (the registry's record plus whether its page is loading). */
export interface TabInfo extends Tab {
  loading: boolean
  /** E9: the page's history lets the bar go back / forward. */
  canGoBack?: boolean
  canGoForward?: boolean
  /** E9: the page's icon as an `data:image/` address, fetched by main (the interface never requests an address the page names). */
  favicon?: string
  /** E9: how many cookies the partition holds for the page's address (a count only: the sign that an account may be logged in). */
  cookies?: number
  /** E7c (H3): popups of this page refused by the limits (the tab's seal). */
  popupsRefused?: number
  /**
   * The page cannot be shown: its renderer process went away ('gone'), it stopped answering ('unresponsive'), or the whole
   * browser process stopped ('browser'). The pane shows the crash state with "Reabrir" (invoke `reopen`).
   */
  crashed?: TabCrash
}

/** 'suspect': the browser process went down twice in a row with this tab on screen or loading; it waits paused, not loaded. */
export type TabCrash = 'gone' | 'unresponsive' | 'browser' | 'suspect'

// ---- H3: popups and tabs have a ceiling (a page's `window.open` in a loop would exhaust the main process) ----

/** Popups one tab may open per window of time. */
export const POPUPS_PER_WINDOW = 3
export const POPUP_WINDOW_MS = 10_000
/** Tabs one owner may have (its agent's and its pages' popups together; a restored tab is not counted against). */
export const TABS_PER_OWNER = 30

/**
 * May a tab open one more popup at `now`? `recent` holds the times of its last popups and is kept here (old ones dropped, the new
 * one added when allowed). `ownerTabs` counts the owner's tabs, open and opening.
 */
export function popupVerdict(recent: number[], now: number, ownerTabs: number): 'ok' | 'rate' | 'owner' {
  while (recent.length > 0 && now - recent[0]! >= POPUP_WINDOW_MS) recent.shift()
  if (ownerTabs >= TABS_PER_OWNER) return 'owner'
  if (recent.length >= POPUPS_PER_WINDOW) return 'rate'
  recent.push(now)
  return 'ok'
}

/** What layout.json keeps of a `web:` pane (its params): enough to bring the tab back, never loaded on its own. */
export interface SavedTab {
  tabId: string
  ownerSlotId: string
  /** Absent when the address carried a credential (never written, never reloaded). */
  url?: string
  title: string
}

const ID = /^[\w.:-]{1,80}$/

export function isId(v: unknown): v is string {
  return typeof v === 'string' && ID.test(v)
}

/**
 * The owner of the person's own tabs (she opened them herself: the palette, the pad's "+", Ctrl+T). It never collides with an
 * agent: the daemon's slot ids are 8 hex characters. No agent ever reaches these tabs: the gate serves only the tabs whose owner
 * is the connection's slot, and no key file may name this owner (gate-rules.ts `slotOfKeyFile`).
 */
export const PERSON_OWNER = 'person'

export const isPersonOwned = (ownerSlotId: string | undefined): boolean => ownerSlotId === PERSON_OWNER

/**
 * May her tab go to the agent `to` ("Entregar a um agente…")? Only a tab she owns, only to a live agent (a slot id, never the
 * person), only while that agent is under its ceiling of tabs (the give opens him a new tab at the same address and closes hers).
 */
export function giveVerdict(tab: { ownerSlotId: string } | undefined, to: unknown, agent: { alive: boolean } | undefined, toTabs: number): 'ok' | 'no-tab' | 'not-hers' | 'no-agent' | 'full' {
  if (!tab) return 'no-tab'
  if (!isPersonOwned(tab.ownerSlotId)) return 'not-hers'
  if (!isId(to) || isPersonOwned(to) || !agent?.alive) return 'no-agent'
  if (toTabs >= TABS_PER_OWNER) return 'full'
  return 'ok'
}

/** The longest address the person may type in the bar. */
export const TYPED_URL_MAX = 8192

/**
 * What the person typed in the address bar, as the address the tab opens, or undefined when it may not open. Without a scheme it
 * gets `https://` ("example.com", "localhost:3000/x": a host and port is not a scheme); with one, only http and https pass
 * (`javascript:`, `file:`, `data:`, `about:`, `chrome:`… are refused). Spaces inside are refused: the bar is not a search box.
 */
export function typedUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  if (text === '' || text.length > TYPED_URL_MAX || /\s/.test(text)) return undefined
  const scheme = /^([a-z][a-z0-9+.-]*):(?!\d)/i.exec(text)
  const url = scheme ? text : `https://${text}`
  if (scheme && !/^https?$/i.test(scheme[1]!)) return undefined
  if (!isWebUrl(url)) return undefined
  try { if (new URL(url).hostname === '') return undefined } catch { return undefined }
  return url
}

/** An address a tab may open: http or https, nothing else (file:, data:, javascript:, chrome:, devtools: are refused). */
export function isWebUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 8192) return false
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch { return false }
}

/** A navigation the page may make: a web address, or the blank page. */
export function isNavigable(v: unknown): boolean {
  return v === 'about:blank' || isWebUrl(v)
}

/** Query parameter names that carry a secret (compared without case, `-` and `_`). */
const SECRET_PARAMS = new Set([
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'authtoken', 'auth', 'authorization', 'apikey', 'key', 'secret',
  'clientsecret', 'password', 'passwd', 'pwd', 'pass', 'session', 'sessionid', 'sid', 'code', 'sig', 'signature', 'jwt',
  'bearer', 'credential', 'credentials', 'otp', 'ticket', 'xamzsignature', 'xamzcredential', 'xamzsecuritytoken',
])
const norm = (name: string): string => name.toLowerCase().replace(/[-_]/g, '')

/**
 * Whether an address may be written to layout.json and loaded again after a restart: a web address with no user or password
 * in it and no query or fragment parameter whose name is a known secret (`?token=…`, `#access_token=…`).
 */
export function storableUrl(v: unknown): v is string {
  if (!isWebUrl(v)) return false
  const u = new URL(v)
  if (u.username || u.password) return false
  const names = [...u.searchParams.keys()]
  const hash = u.hash.replace(/^#/, '')
  if (hash.includes('=')) for (const k of new URLSearchParams(hash).keys()) names.push(k)
  return !names.some(n => SECRET_PARAMS.has(norm(n)))
}

/** A new tab record, validated (the owner and the ids come from other processes). */
export function makeTab(f: { tabId: unknown; ownerSlotId: unknown; surfaceId: unknown; url: unknown; title?: unknown; createdAt: number }): Tab | undefined {
  if (!isId(f.tabId) || !isId(f.ownerSlotId) || typeof f.surfaceId !== 'string' || !isNavigable(f.url)) return undefined
  return { tabId: f.tabId, ownerSlotId: f.ownerSlotId, surfaceId: f.surfaceId, url: f.url as string, title: cleanTitle(f.title), createdAt: f.createdAt }
}

export function cleanTitle(v: unknown): string {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 300) : ''
}

/** What a `web:` pane keeps in layout.json for a tab: the address only when storable. */
export function savedOf(t: { tabId: string; ownerSlotId: string; url: string; title: string }): SavedTab {
  return storableUrl(t.url) ? { tabId: t.tabId, ownerSlotId: t.ownerSlotId, url: t.url, title: t.title } : { tabId: t.tabId, ownerSlotId: t.ownerSlotId, title: t.title }
}

/** A pane's params read back from layout.json (anything may be there): the saved tab, or undefined. A credential address is dropped. */
export function savedTabOf(params: unknown): SavedTab | undefined {
  if (!params || typeof params !== 'object') return undefined
  const p = params as Record<string, unknown>
  if (!isId(p.tabId) || !isId(p.ownerSlotId)) return undefined
  const out: SavedTab = { tabId: p.tabId, ownerSlotId: p.ownerSlotId, title: cleanTitle(p.title) }
  if (storableUrl(p.url)) out.url = p.url
  return out
}

/**
 * Where a new tab of `owner` goes in a group whose tabs have these owners (in tab order): right after the owner's last tab,
 * so each agent's tabs stay together; an owner with no tab there goes at the end (groups in order of arrival).
 */
export function insertIndex(owners: readonly (string | undefined)[], owner: string): number {
  const last = owners.lastIndexOf(owner)
  return last >= 0 ? last + 1 : owners.length
}

/** Electron's fuse wire sentinel (@electron/fuses SENTINEL); the wire follows it: version, length, then one byte per fuse. */
export const FUSE_SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'
/** FuseV1Options.EnableCookieEncryption. */
export const FUSE_COOKIE_ENCRYPTION = 1
const FUSE_ENABLE = 0x31

/**
 * The fuse states after the sentinel found at `at` in `buf` (each '0' off, '1' on, 'r' removed), or undefined when the wire is
 * not there whole or its version is not 1.
 */
export function fuseWireAt(buf: Uint8Array, at: number): number[] | undefined {
  const pos = at + FUSE_SENTINEL.length
  if (at < 0 || pos + 2 > buf.length || buf[pos] !== 1) return undefined
  const len = buf[pos + 1]!
  if (pos + 2 + len > buf.length) return undefined
  return [...buf.subarray(pos + 2, pos + 2 + len)]
}

/** Whether a fuse wire has cookie encryption on (an unknown wire counts as off). */
export function cookieEncryptionOn(wire: readonly number[] | undefined): boolean {
  return wire?.[FUSE_COOKIE_ENCRYPTION] === FUSE_ENABLE
}

/** The largest icon the tab keeps (bytes of the data address / of the fetched body). */
export const FAVICON_MAX = 64 * 1024

/**
 * Which of the icons a page names the tab may use: a `data:image/` one as it comes (bounded), else the first one on the page's own
 * origin (fetched by main through the tab's session); an icon on another origin is never requested (it would be a request the
 * page did not make, outside the filter's view of the page).
 */
export function faviconPlan(pageUrl: string, candidates: readonly unknown[]): { kind: 'data' | 'fetch'; url: string } | undefined {
  let origin = ''
  try { origin = new URL(pageUrl).origin } catch { /* no page address */ }
  for (const c of candidates) {
    if (typeof c !== 'string') continue
    if (/^data:image\/(png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml)[;,]/i.test(c)) {
      if (c.length <= FAVICON_MAX) return { kind: 'data', url: c }
      continue
    }
    if (!isWebUrl(c) || origin === '' || origin === 'null') continue
    try { if (new URL(c).origin === origin) return { kind: 'fetch', url: c } } catch { /* next */ }
  }
  return undefined
}

/**
 * E15, rule 18: what the tabs' partition does at start. Fuse off: in memory (logins are never written in plain text). Fuse on:
 * the persistent partition, wiped first when it exists without the marker the first fused start leaves (a partition written by
 * an earlier build without the fuse would keep its plain-text cookies forever: the fuse only encrypts what is written anew).
 */
export type PartitionStep = 'memory' | 'use' | 'wipe-then-use'
export function partitionStep(fuseOn: boolean, partitionExists: boolean, markerExists: boolean): PartitionStep {
  if (!fuseOn) return 'memory'
  return partitionExists && !markerExists ? 'wipe-then-use' : 'use'
}
