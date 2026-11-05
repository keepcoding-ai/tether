// Markdown to HTML for the preview tab (app/renderer/preview-panel.ts): markdown-it, the engine VS Code's preview
// uses, with the same GFM set (tables, strikethrough, task lists shown but not clickable, linkify) and the same
// two stamps VS Code adds: `data-line` on every block (the source line it came from, for scroll sync) and an
// `id` on every heading (the GitHub slug, for `#anchor` links).
//
// The text may come from any file, so the HTML is never trusted:
//   - raw HTML in the markdown is not passed through: it is re-read by a small allow-list sanitizer (`sanitizeHtml`)
//     that rebuilds only the tags and attributes it knows; everything else (script, style, iframe, on* handlers,
//     javascript: URLs…) is shown as plain text;
//   - links keep only http(s), mailto and relative targets; images only inline data images or files inside the
//     note's folder (app/shared/markdown-links.ts); a remote image is shown as its alt text, never fetched;
//   - the preview itself renders in a sandboxed frame without scripts (preview-panel.ts), so a bug here still runs nothing.
// Pure and DOM-free: the unit tests run it in Node.
import MarkdownIt from 'markdown-it'
import type { StateCore, Token } from 'markdown-it'
import { resolveImageSource } from './markdown-links.ts'

type Md = InstanceType<typeof MarkdownIt>

export interface RenderOptions {
  /** The folder of the note: relative images are read against it and may not leave it. */
  noteDir: string
  /** Colours a fenced block: the inner HTML of the `<code>`, or undefined to show it plain. */
  highlight?: (code: string, lang: string) => Promise<string | undefined>
}

interface Env {
  [key: string | symbol]: unknown
  noteDir: string
  /** Heading slugs already used (the second "Intro" is `intro-1`). */
  slugs: Map<string, number>
  /** Elements the sanitizer opened and the document has not closed yet. */
  open: string[]
}

const escape = (text: string): string => MarkdownIt().utils.escapeHtml(text)

// ---------- the sanitizer ----------

const TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em',
  'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre',
  'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr',
  'u', 'ul', 'var',
])
const VOID = new Set(['br', 'hr', 'img'])

const ALIGN = /^(left|right|center|justify)$/i
const SIZE = /^\d{1,4}(px|%)?$/
const COUNT = /^\d{1,3}$/
/** Attribute name → how its value is checked (the value is returned cleaned, or undefined to drop the attribute). */
const ATTRIBUTES: Record<string, (value: string, tag: string) => string | undefined> = {
  title: v => v.slice(0, 500),
  align: v => (ALIGN.test(v) ? v.toLowerCase() : undefined),
  dir: v => (/^(ltr|rtl|auto)$/i.test(v) ? v.toLowerCase() : undefined),
  lang: v => (/^[a-zA-Z-]{1,12}$/.test(v) ? v : undefined),
  width: v => (SIZE.test(v) ? v : undefined),
  height: v => (SIZE.test(v) ? v : undefined),
  colspan: v => (COUNT.test(v) ? v : undefined),
  rowspan: v => (COUNT.test(v) ? v : undefined),
  start: v => (/^-?\d{1,6}$/.test(v) ? v : undefined),
  open: () => '',
  alt: v => v.slice(0, 500),
  href: v => safeHref(v),
  src: v => v,
}
const PER_TAG: Record<string, string[]> = {
  a: ['href'], img: ['src', 'alt', 'width', 'height'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'], ol: ['start'], details: ['open'],
}
const COMMON = ['title', 'align', 'dir', 'lang']

/** A link target worth keeping: http(s), mailto, a fragment or a relative path. Control characters are removed first (browsers ignore them inside a scheme). */
function safeHref(value: string): string | undefined {
  const compact = value.replace(/[\u0000- \u007f]+/g, '')
  if (compact === '') return undefined
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(compact)
  if (scheme && !/^(https?|mailto)$/i.test(scheme[1]!) && !/^[a-zA-Z]:[\\/]/.test(compact)) return undefined
  if (/^[a-zA-Z]:[\\/]/.test(compact)) return undefined // a drive path is no link
  return value.trim()
}

const ENTITY = /&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
function decodeEntities(text: string): string {
  return text.replace(ENTITY, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''
    }
    return NAMED[body] ?? whole
  })
}

/** Text between tags: `<` and `>` become entities, `&` stays when it already starts a valid entity. */
function escapeText(text: string): string {
  return text.replace(/&(?!(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

interface ReadTag { name: string; closing: boolean; attrs: Array<[string, string]>; end: number }

/** Reads a tag starting at `s[at] === '<'`; undefined when it is not well-formed. */
function readTag(s: string, at: number): ReadTag | undefined {
  let i = at + 1
  const closing = s[i] === '/'
  if (closing) i++
  const nameMatch = /^[a-zA-Z][a-zA-Z0-9-]{0,31}/.exec(s.slice(i, i + 40))
  if (!nameMatch) return undefined
  const name = nameMatch[0].toLowerCase()
  i += nameMatch[0].length
  const attrs: Array<[string, string]> = []
  for (let guard = 0; guard < 64; guard++) {
    while (i < s.length && /\s/.test(s[i]!)) i++
    const c = s[i]
    if (c === undefined) return undefined
    if (c === '>') return { name, closing, attrs, end: i + 1 }
    if (c === '/' && s[i + 1] === '>') return { name, closing, attrs, end: i + 2 }
    if (closing) return undefined
    const attr = /^[^\s"'<>/=]+/.exec(s.slice(i, i + 80))
    if (!attr) return undefined
    i += attr[0].length
    let value = ''
    let j = i
    while (j < s.length && /\s/.test(s[j]!)) j++
    if (s[j] === '=') {
      j++
      while (j < s.length && /\s/.test(s[j]!)) j++
      const quote = s[j]
      if (quote === '"' || quote === "'") {
        const close = s.indexOf(quote, j + 1)
        if (close < 0) return undefined
        value = s.slice(j + 1, close)
        i = close + 1
      } else {
        const bare = /^[^\s"'=<>`]+/.exec(s.slice(j, j + 2000))
        if (!bare) return undefined
        value = bare[0]
        i = j + bare[0].length
      }
    }
    attrs.push([attr[0].toLowerCase(), decodeEntities(value)])
  }
  return undefined
}

function imageHtml(src: string, alt: string, title: string, size: { width?: string; height?: string }, env: Env): string {
  const resolved = resolveImageSource(src, env.noteDir)
  if (resolved.kind === 'blocked') {
    const why = resolved.reason === 'remote' ? 'Imagem remota não carregada (a prévia não acessa a rede)' : resolved.reason === 'outside' ? 'Imagem fora da pasta da nota não carregada' : 'Imagem não carregada'
    return `<span class="img-blocked" title="${escape(`${why}: ${src}`)}">${escape(alt || 'imagem')}</span>`
  }
  const attrs = [`src="${escape(resolved.src)}"`, `alt="${escape(alt)}"`]
  if (title) attrs.push(`title="${escape(title)}"`)
  if (size.width) attrs.push(`width="${escape(size.width)}"`)
  if (size.height) attrs.push(`height="${escape(size.height)}"`)
  return `<img ${attrs.join(' ')}>`
}

/**
 * The HTML fragment `html` (from the markdown) rebuilt from its allowed parts. Elements left open are tracked in
 * `env.open` across fragments (markdown-it hands inline tags one by one) and closed by `closeOpen`.
 */
function sanitizeFragment(html: string, env: Env): string {
  let out = ''
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt < 0) { out += escapeText(html.slice(i)); break }
    out += escapeText(html.slice(i, lt))
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      if (end < 0) break
      i = end + 3
      continue
    }
    const tag = readTag(html, lt)
    if (!tag) { out += '&lt;'; i = lt + 1; continue }
    i = tag.end
    if (!TAGS.has(tag.name)) { out += escapeText(html.slice(lt, tag.end)); continue }
    if (tag.closing) {
      const at = env.open.lastIndexOf(tag.name)
      if (at < 0) continue // nothing of ours to close
      while (env.open.length > at) out += `</${env.open.pop()}>`
      continue
    }
    const allowed = new Set([...COMMON, ...(PER_TAG[tag.name] ?? [])])
    const given = new Map<string, string>()
    for (const [name, raw] of tag.attrs) {
      if (!allowed.has(name) || given.has(name)) continue
      const value = ATTRIBUTES[name]?.(raw, tag.name)
      if (value !== undefined) given.set(name, value)
    }
    if (tag.name === 'img') {
      out += imageHtml(given.get('src') ?? '', given.get('alt') ?? '', given.get('title') ?? '', { ...(given.has('width') ? { width: given.get('width')! } : {}), ...(given.has('height') ? { height: given.get('height')! } : {}) }, env)
      continue
    }
    const attrs = [...given].map(([k, v]) => (k === 'open' ? 'open' : `${k}="${escape(v)}"`)).join(' ')
    out += `<${tag.name}${attrs ? ' ' + attrs : ''}>`
    if (!VOID.has(tag.name)) env.open.push(tag.name)
  }
  return out
}

/** Raw HTML of markdown as the preview shows it (exported for the unit tests); `noteDir` resolves its images. */
export function sanitizeHtml(html: string, noteDir: string): string {
  const env: Env = { noteDir, slugs: new Map(), open: [] }
  return sanitizeFragment(html, env) + closeOpen(env)
}

function closeOpen(env: Env): string {
  let out = ''
  while (env.open.length > 0) out += `</${env.open.pop()}>`
  return out
}

// ---------- markdown-it ----------

/** The GitHub-style anchor of a heading's text: lowercase, punctuation out, spaces to hyphens. */
export function slugify(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s+/g, '-')
}

function inlineText(token: Token): string {
  let out = ''
  for (const c of token.children ?? []) if (c.type === 'text' || c.type === 'code_inline') out += c.content
  return out
}

/** Stamps each block with its source lines, gives headings their ids and turns `[ ]` / `[x]` into disabled checkboxes. */
function tetherCore(state: StateCore): void {
  const env = state.env as unknown as Env
  const tokens = state.tokens
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.map && t.block && (t.nesting === 1 || t.type === 'fence' || t.type === 'code_block' || t.type === 'hr')) {
      t.attrSet('data-line', String(t.map[0]))
      t.attrSet('data-line-end', String(t.map[1]))
      t.attrJoin('class', 'code-line')
    }
    if (t.type === 'heading_open') {
      const next = tokens[i + 1]
      const base = next ? slugify(inlineText(next)) : ''
      if (base !== '') {
        const seen = env.slugs.get(base) ?? 0
        env.slugs.set(base, seen + 1)
        t.attrSet('id', seen === 0 ? base : `${base}-${seen}`)
      }
    }
    if (t.type === 'inline' && i >= 2 && tokens[i - 1]!.type === 'paragraph_open' && tokens[i - 2]!.type === 'list_item_open') {
      const first = t.children?.[0]
      const m = first && first.type === 'text' ? /^\[([ xX])\](?:\s+|$)/.exec(first.content) : null
      if (!first || !m) continue
      first.content = first.content.slice(m[0].length)
      const box = new state.Token('task_checkbox', '', 0)
      box.meta = { checked: m[1] !== ' ' }
      t.children!.unshift(box)
      tokens[i - 2]!.attrJoin('class', 'task-list-item')
      for (let j = i - 3; j >= 0; j--) {
        const p = tokens[j]!
        if (p.nesting === 1 && p.level === tokens[i - 2]!.level - 1) {
          if (!String(p.attrGet('class') ?? '').includes('contains-task-list')) p.attrJoin('class', 'contains-task-list')
          break
        }
      }
    }
  }
}

const envOf = (env: unknown): Env => env as Env

function createMarkdown(): Md {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false, breaks: false })
  md.validateLink = url => {
    const compact = url.replace(/[\u0000- \u007f]+/g, '').toLowerCase()
    return !/^(vbscript|javascript|file|data):/.test(compact) || /^data:image\/(gif|png|jpeg|webp);/.test(compact)
  }
  md.core.ruler.push('tether', tetherCore)
  const rules = md.renderer.rules
  rules.html_block = (tokens, idx, _o, env) => sanitizeFragment(tokens[idx]!.content, envOf(env))
  rules.html_inline = (tokens, idx, _o, env) => sanitizeFragment(tokens[idx]!.content, envOf(env))
  rules.task_checkbox = (tokens, idx) => `<input class="task-list-item-checkbox" type="checkbox" disabled${(tokens[idx]!.meta as { checked: boolean }).checked ? ' checked' : ''}> `
  rules.image = (tokens, idx, options, env, self) => {
    const t = tokens[idx]!
    return imageHtml(String(t.attrGet('src') ?? ''), self.renderInlineAsText(t.children ?? [], options, env), String(t.attrGet('title') ?? ''), {}, envOf(env))
  }
  rules.fence = (tokens, idx, _o, _env, self) => {
    const t = tokens[idx]!
    const lang = t.info.trim().split(/\s+/)[0]?.replace(/[^\w+#.-]/g, '') ?? ''
    const meta = t.meta as { html?: string } | null
    const body = meta?.html ?? escape(t.content)
    return `<pre${self.renderAttrs(t)}><code${lang ? ` class="language-${escape(lang)}"` : ''}>${body}</code></pre>\n`
  }
  return md
}

let shared: Md | undefined
const markdown = (): Md => (shared ??= createMarkdown())

/** Fenced blocks above this are shown plain (colouring is for reading, not for a log dump). */
const HIGHLIGHT_MAX_CHARS = 60_000

/** The preview's HTML for `text`. */
export async function renderMarkdown(text: string, options: RenderOptions): Promise<string> {
  const md = markdown()
  const env: Env = { noteDir: options.noteDir, slugs: new Map(), open: [] }
  const tokens = md.parse(text, env)
  if (options.highlight) {
    for (const t of tokens) {
      if (t.type !== 'fence' || t.content.length > HIGHLIGHT_MAX_CHARS) continue
      const lang = t.info.trim().split(/\s+/)[0] ?? ''
      if (lang === '') continue
      try { const html = await options.highlight(t.content.replace(/\n$/, ''), lang); if (html !== undefined) t.meta = { html } } catch { /* shown plain */ }
    }
  }
  return md.renderer.render(tokens, md.options, env) + closeOpen(env)
}

/** Same as `renderMarkdown` without colouring (the unit tests). */
export function renderMarkdownSync(text: string, options: Pick<RenderOptions, 'noteDir'>): string {
  const md = markdown()
  const env: Env = { noteDir: options.noteDir, slugs: new Map(), open: [] }
  return md.render(text, env) + closeOpen(env)
}
