// What the service worker keeps, pure (no worker globals, so a test runs it): the name of a version's cache and which request
// is a file of the shell. The shell is the files of the build and nothing else; every other request (and every non-GET) is
// not the worker's and goes to the network as if it were not there. The house's data never goes through here: it travels on
// the WebSocket, which a service worker does not see.

export const CACHE_PREFIX = 'tether-shell-'

export const cacheName = (version: string): string => `${CACHE_PREFIX}${version}`

/**
 * The shell file a request asks for, by its published path (`index.html`, `app.js`, `icons/icon.svg`), or `undefined` when it
 * is not one. `scope` is the worker's scope (the folder the page is served from); the address's query and fragment do not
 * count (`./?c=c_abc` is still the page), and a path outside the scope or on another origin never matches.
 */
export function shellKey(method: string, url: string, scope: string, files: readonly string[]): string | undefined {
  if (method !== 'GET') return undefined
  let u: URL
  let base: URL
  try { u = new URL(url); base = new URL(scope) } catch { return undefined }
  if (u.origin !== base.origin || !u.pathname.startsWith(base.pathname)) return undefined
  const rel = u.pathname.slice(base.pathname.length)
  const key = rel === '' ? 'index.html' : rel
  return files.includes(key) ? key : undefined
}
