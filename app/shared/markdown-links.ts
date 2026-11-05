// Where a link or an image of a markdown preview points, decided without touching the disk or the DOM (unit-tested):
//   - a link is classified (`classifyLink`): http(s) goes to the browser, `#id` scrolls the preview, a relative path
//     is a file of the note's folder (opened like Quick Open opens it), anything else is ignored;
//   - an image is allowed only when it is a small inline `data:` image or a relative path that stays inside the note's
//     folder (`resolveImageSource`); a remote image is never fetched (the page's CSP says the same).
// Paths are handled lexically with both separators, so a Windows note path works the same in a unit test on any OS.

export type LinkTarget =
  | { kind: 'external'; url: string }
  | { kind: 'anchor'; id: string }
  | { kind: 'file'; path: string; line?: number }
  | { kind: 'ignore' }

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/
const DRIVE = /^[a-zA-Z]:([\\/]|$)/

function decode(text: string): string | undefined {
  try { return decodeURIComponent(text) } catch { return undefined }
}

/** A path as segments plus the separator and root it was written with; `..` above the root is an error (undefined). */
function parts(path: string): { root: string; segs: string[]; sep: string } | undefined {
  const sep = path.includes('\\') || DRIVE.test(path) ? '\\' : '/'
  const flat = path.replace(/\\/g, '/')
  let root = ''
  let rest = flat
  const drive = /^([a-zA-Z]:)(\/|$)/.exec(flat)
  if (drive) { root = drive[1]!.toUpperCase(); rest = flat.slice(drive[0].length) }
  else if (flat.startsWith('//')) return undefined // a network share is never resolved
  else if (flat.startsWith('/')) { root = ''; rest = flat.slice(1) }
  const segs: string[] = []
  for (const s of rest.split('/')) {
    if (s === '' || s === '.') continue
    if (s === '..') { if (segs.length === 0) return undefined; segs.pop(); continue }
    segs.push(s)
  }
  return { root, segs, sep }
}

function render(p: { root: string; segs: string[]; sep: string }): string {
  const lead = p.root !== '' ? p.root + p.sep : p.sep === '/' ? '/' : ''
  return lead + p.segs.join(p.sep)
}

/** `rel` read against the folder `dir`; undefined when it climbs above the root or `dir` is not an absolute path. */
export function resolveAgainst(dir: string, rel: string): string | undefined {
  const base = parts(dir)
  if (!base || (base.root === '' && !dir.startsWith('/') && !dir.startsWith('\\'))) return undefined
  const joined = parts(`${render(base)}${base.sep}${rel}`)
  return joined ? render(joined) : undefined
}

/** Whether `path` is `dir` itself or below it (case-insensitive on a Windows drive path, as the file system is). */
export function isInside(dir: string, path: string): boolean {
  const a = parts(dir)
  const b = parts(path)
  if (!a || !b || a.root.toLowerCase() !== b.root.toLowerCase()) return false
  const fold = a.root !== '' // a drive letter: a Windows path
  const same = (x: string, y: string): boolean => (fold ? x.toLowerCase() === y.toLowerCase() : x === y)
  if (b.segs.length < a.segs.length) return false
  return a.segs.every((s, i) => same(s, b.segs[i]!))
}

/** `file:///C:/a%20b/x.png` for an absolute path. */
export function fileUrl(path: string): string {
  const p = parts(path)
  if (!p) return ''
  const body = p.segs.map(encodeURIComponent).join('/')
  return p.root !== '' ? `file:///${p.root}/${body}` : `file:///${body}`
}

/** The target of a link of a preview of the note whose folder is `noteDir`. */
export function classifyLink(href: string, noteDir: string): LinkTarget {
  const link = href.trim()
  if (link === '') return { kind: 'ignore' }
  if (link.startsWith('#')) {
    const id = decode(link.slice(1))
    return id ? { kind: 'anchor', id } : { kind: 'ignore' }
  }
  const scheme = SCHEME.exec(link)
  if (scheme) {
    // `C:\x` looks like a scheme; only http(s) goes anywhere.
    return /^https?$/i.test(scheme[1]!) ? { kind: 'external', url: link } : { kind: 'ignore' }
  }
  if (link.startsWith('//')) return { kind: 'ignore' } // protocol-relative: a remote host, not a file
  const cut = link.search(/[?#]/)
  const rawPath = cut < 0 ? link : link.slice(0, cut)
  const fragment = cut < 0 ? '' : link.slice(cut).replace(/^\?[^#]*/, '').replace(/^#/, '')
  const path = decode(rawPath)
  if (!path || path.includes('\0')) return { kind: 'ignore' }
  // A path starting with a separator is the root of the note's folder, as a repository's README reads it.
  const resolved = resolveAgainst(noteDir, path.replace(/^[\\/]+/, ''))
  if (!resolved) return { kind: 'ignore' }
  const line = /^L(\d+)(?:C\d+)?$/i.exec(fragment) ?? /^(\d+)$/.exec(fragment)
  return { kind: 'file', path: resolved, ...(line ? { line: Number(line[1]) } : {}) }
}

export type ImageSource = { kind: 'ok'; src: string } | { kind: 'blocked'; reason: 'remote' | 'outside' | 'invalid' }

/** The `src` an image of the preview is given: a data image, a file inside the note's folder, or blocked (with why). */
export function resolveImageSource(src: string, noteDir: string): ImageSource {
  const value = src.trim()
  if (/^data:image\/(png|gif|jpe?g|webp);/i.test(value)) return { kind: 'ok', src: value }
  const scheme = SCHEME.exec(value)
  if (scheme && !DRIVE.test(value)) return /^https?$/i.test(scheme[1]!) ? { kind: 'blocked', reason: 'remote' } : { kind: 'blocked', reason: 'invalid' }
  if (value.startsWith('//')) return { kind: 'blocked', reason: 'remote' }
  const cut = value.search(/[?#]/)
  const path = decode(cut < 0 ? value : value.slice(0, cut))
  if (!path || path === '' || path.includes('\0')) return { kind: 'blocked', reason: 'invalid' }
  // Absolute paths (`/x.png`, `C:\x.png`) are not the note's neighbourhood: relative only.
  if (path.startsWith('/') || path.startsWith('\\') || DRIVE.test(path)) return { kind: 'blocked', reason: 'outside' }
  const resolved = resolveAgainst(noteDir, path)
  if (!resolved || !isInside(noteDir, resolved)) return { kind: 'blocked', reason: 'outside' }
  return { kind: 'ok', src: fileUrl(resolved) }
}
