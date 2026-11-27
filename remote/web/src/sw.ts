// The service worker: the shell only (index.html, app.js, app.css, the manifest, the icons), so the installed app opens with no
// network and says "seu tether está offline" itself. The build writes two constants into this file: the list of files it
// produced and a version (the hash of their bytes). One cache per version; the file is never cached by name of a path the
// build did not list, and nothing of a session or of the house passes through here.
//
// Update: a new worker installs in the background, waits (no skipWaiting) and takes over when the page is next opened with
// no tab on the old one. A screen in use is never swapped under the person.
import { cacheName, CACHE_PREFIX, shellKey } from './shell-cache.ts'

declare const __SHELL_FILES__: readonly string[]
declare const __SHELL_VERSION__: string

/** The few members of the worker's scope this file uses (the page's DOM types are the ones the program has). */
interface Wait { waitUntil(p: Promise<unknown>): void }
interface FetchEv extends Wait { request: Request; respondWith(r: Promise<Response>): void }
interface Scope {
  registration: { scope: string }
  addEventListener(type: 'install' | 'activate', fn: (e: Wait) => void): void
  addEventListener(type: 'fetch', fn: (e: FetchEv) => void): void
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
