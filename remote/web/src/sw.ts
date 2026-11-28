// The service worker: the shell only (index.html, app.js, app.css, the manifest, the icons), so the installed app opens with no
// network and says "seu tether está offline" itself. The build writes two constants into this file: the list of files it
// produced and a version (the hash of their bytes). One cache per version; the file is never cached by name of a path the
// build did not list, and nothing of a session or of the house passes through here.
//
// Update: a new worker installs in the background, waits (no skipWaiting) and takes over when the page is next opened with
// no tab on the old one. A screen in use is never swapped under the person.
//
// Notices (RR4 step 4.4): a push from the house arrives here already opened by the browser (it holds the subscription's
// keys; this file never sees one). What passes parsePushNotice is shown, and nothing is kept: no key of a session, no
// record of the house, no cache write. A tap opens (or brings forward) the app at the place the notice names, by its query.
import { cacheName, CACHE_PREFIX, shellKey } from './shell-cache.ts'
import { parsePushNotice } from '../../../src/remote/webpush.ts'

declare const __SHELL_FILES__: readonly string[]
declare const __SHELL_VERSION__: string

/** The few members of the worker's scope this file uses (the page's DOM types are the ones the program has). */
interface Wait { waitUntil(p: Promise<unknown>): void }
interface FetchEv extends Wait { request: Request; respondWith(r: Promise<Response>): void }
interface PushEv extends Wait { data: { json(): unknown } | null }
interface ShownNotice { data: unknown; close(): void }
interface ClickEv extends Wait { notification: ShownNotice }
interface WindowClient { url: string; focus(): Promise<unknown>; navigate(url: string): Promise<unknown> }
interface Scope {
  registration: { scope: string; showNotification(title: string, o: { body: string; tag: string; icon: string; badge: string; data: { url: string }; renotify: boolean }): Promise<void> }
  clients: { matchAll(o: { type: 'window'; includeUncontrolled: boolean }): Promise<readonly WindowClient[]>; openWindow(url: string): Promise<unknown> }
  addEventListener(type: 'install' | 'activate', fn: (e: Wait) => void): void
  addEventListener(type: 'fetch', fn: (e: FetchEv) => void): void
  addEventListener(type: 'push', fn: (e: PushEv) => void): void
  addEventListener(type: 'notificationclick', fn: (e: ClickEv) => void): void
}
const sw = self as unknown as Scope

const NAME = cacheName(__SHELL_VERSION__)
const at = (file: string): string => new URL(file, sw.registration.scope).href

sw.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(NAME)
    for (const file of __SHELL_FILES__) {
      // `reload`: the copy is the one the server has now, not one the browser's HTTP cache kept from another version.
      const res = await fetch(new Request(at(file), { cache: 'reload' }))
      if (!res.ok) throw new Error(`${file}: ${res.status}`)
      await cache.put(at(file), res)
    }
  })())
})

sw.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith(CACHE_PREFIX) && name !== NAME) await caches.delete(name)
  })())
})

sw.addEventListener('fetch', e => {
  const key = shellKey(e.request.method, e.request.url, sw.registration.scope, __SHELL_FILES__)
  if (key === undefined) return
  e.respondWith((async () => {
    const hit = await (await caches.open(NAME)).match(at(key))
    if (hit) return hit
    // Not kept (an install cut short): the network answers, and nothing is put in the cache from here.
    try { return await fetch(e.request) } catch { return Response.error() }
  })())
})

/** The address a notice opens: the app's own scope with the notice's query, never anything else. */
function placeOf(query: unknown): string {
  const scope = sw.registration.scope
  return typeof query === 'string' && /^\?(?:c=[A-Za-z0-9_.:-]{1,80}|tab=waiting)$/.test(query) ? `${scope}${query}` : scope
}

sw.addEventListener('push', e => {
  let raw: unknown
  try { raw = e.data?.json() } catch { raw = undefined }
  const n = parsePushNotice(raw)
  // A push must show something (userVisibleOnly): one that does not parse says only that the tether called.
  const title = n?.title ?? 'Tether'
  const body = n?.body ?? 'Há algo para você no tether.'
  e.waitUntil(sw.registration.showNotification(title, {
    body, tag: n?.tag ?? 'tether', icon: at('icons/icon-192.png'), badge: at('icons/icon-192.png'), data: { url: placeOf(n?.url) }, renotify: true,
  }))
})

sw.addEventListener('notificationclick', e => {
  e.notification.close()
  const d = e.notification.data as { url?: unknown } | null
  const url = placeOf(typeof d?.url === 'string' ? d.url.slice(sw.registration.scope.length) : undefined)
  e.waitUntil((async () => {
    const open = (await sw.clients.matchAll({ type: 'window', includeUncontrolled: true })).find(c => c.url.startsWith(sw.registration.scope))
    if (!open) { await sw.clients.openWindow(url); return }
    await open.focus()
    if (open.url !== url) await open.navigate(url).catch(() => undefined)
  })())
})
