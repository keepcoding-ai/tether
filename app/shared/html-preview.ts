// Pure helpers of the HTML preview pane (app/renderer/html-preview-panel.ts), shared with the unit tests. The isolation
// policy itself lives in app/main/html-preview-policy.ts (main-only: it decides what the page may reach).

/** A local path as a `file:` URL: `D:\a b\x.html` → `file:///D:/a%20b/x.html`; `/home/a/x.html` → `file:///home/a/x.html`. */
export function toFileUrl(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  const encoded = slashed.split('/').map(part => encodeURIComponent(part).replace(/%3A$/i, ':')).join('/')
  if (/^[A-Za-z]:/.test(slashed)) return `file:///${encoded}`
  return `file://${encoded.startsWith('/') ? '' : '/'}${encoded}`
}

/** The local path a `file:` URL names (`file:///D:/a%20b/x.html` → `D:\a b\x.html`); undefined for anything else. */
export function fromFileUrl(url: string, windows: boolean = isWindowsPath(url)): string | undefined {
  let parsed: URL
  try { parsed = new URL(url) } catch { return undefined }
  if (parsed.protocol !== 'file:' || (parsed.hostname !== '' && parsed.hostname !== 'localhost')) return undefined
  let path: string
  try { path = decodeURIComponent(parsed.pathname) } catch { return undefined }
  if (windows || /^\/[A-Za-z]:/.test(path)) return path.replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\')
  return path
}

function isWindowsPath(url: string): boolean {
  return /^file:\/\/\/?[A-Za-z]:/i.test(url)
}

/** A path as a comparison key: slashes alike and case folded (Windows file names; also fine on a case-insensitive Mac). */
export function pathKey(path: string): string {
  return path.replace(/\//g, '\\').toLowerCase()
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b)
}

/** The in-memory session of a pane: letters, digits and dashes only (main validates the same shape). */
export function previewPartition(paneId: string, generation: number): string {
  return `htmlprev-${paneId.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)}-${generation}`
}

/** The pane strip's note about what the policy refused: "2 recursos bloqueados". */
export function blockedLabel(count: number): string {
  return count === 1 ? '1 recurso bloqueado' : `${count} recursos bloqueados`
}
