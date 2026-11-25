// Markdown of a channel message body for the pane (parse and DOM are apart).
// markdownTree: pure, no DOM; every rule lives here (allowed link schemes, images, headings, tables).
// markdownNodes: thin shell that walks the tree with createElement/textContent/append (never innerHTML).
// markdownPlain: the same text without markdown marks, for summaries and screen readers.
import MarkdownIt from 'markdown-it'
import type { Token } from 'markdown-it'

export type MdTag = 'p' | 'strong' | 'em' | 's' | 'code' | 'pre' | 'ul' | 'ol' | 'li' | 'blockquote' | 'table' | 'thead' | 'tbody' | 'tr' | 'th' | 'td' | 'div'
export type MdNode =
  | { t: 'text'; text: string; code?: boolean }
  | { t: 'br' }
  | { t: 'hr' }
  | { t: 'el'; tag: MdTag; cls?: string; start?: number; kids: MdNode[] }
  | { t: 'link'; href: string; kids: MdNode[] }

export interface MarkdownHooks {
  leaf(text: string, parent: HTMLElement): void
  link(href: string, parent: HTMLElement): HTMLElement | undefined
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false })

const allowedHref = (href: string): boolean => /^(https?:\/\/|tether:\/\/)/i.test(href.trim())

const ELEMENTS: Record<string, MdTag> = {
  paragraph_open: 'p', strong_open: 'strong', em_open: 'em', s_open: 's', bullet_list_open: 'ul', ordered_list_open: 'ol',
  list_item_open: 'li', blockquote_open: 'blockquote', thead_open: 'thead', tbody_open: 'tbody', tr_open: 'tr', th_open: 'th', td_open: 'td',
}

interface Frame { kids: MdNode[]; tag?: MdTag; cls?: string; start?: number; href?: string; wrap?: boolean }

export function markdownTree(body: string): MdNode[] {
  const root: Frame = { kids: [] }
  const stack: Frame[] = [root]
  const top = (): Frame => stack[stack.length - 1]!
  const add = (node: MdNode): void => { top().kids.push(node) }
  const push = (frame: Frame): void => { stack.push(frame) }
  const pop = (): void => {
    const f = stack.pop()
    if (!f) return
    if (f.href !== undefined) {
      if (allowedHref(f.href)) add({ t: 'link', href: f.href.trim(), kids: f.kids })
      else top().kids.push(...f.kids)
    } else if (f.wrap === false) top().kids.push(...f.kids)
    else add({ t: 'el', tag: f.tag!, ...(f.cls ? { cls: f.cls } : {}), ...(f.start !== undefined ? { start: f.start } : {}), kids: f.kids })
  }
  const walk = (tokens: Token[]): void => {
    for (const tk of tokens) {
      switch (tk.type) {
        case 'inline': walk(tk.children ?? []); break
        case 'text': if (tk.content) add({ t: 'text', text: tk.content }); break
        case 'softbreak': case 'hardbreak': add({ t: 'br' }); break
        case 'hr': add({ t: 'hr' }); break
        case 'code_inline': add({ t: 'el', tag: 'code', kids: [{ t: 'text', text: tk.content, code: true }] }); break
        case 'fence': case 'code_block':
          add({ t: 'el', tag: 'pre', kids: [{ t: 'el', tag: 'code', kids: [{ t: 'text', text: tk.content, code: true }] }] }); break
        case 'image': {
          const alt = tk.content
          const src = String(tk.attrGet('src') ?? '')
          if (allowedHref(src)) add({ t: 'link', href: src.trim(), kids: alt ? [{ t: 'text', text: alt }] : [] })
          else if (alt) add({ t: 'text', text: alt })
          break
        }
        case 'link_open': push({ kids: [], href: String(tk.attrGet('href') ?? '') }); break
        case 'link_close': pop(); break
        case 'heading_open': push({ kids: [], tag: 'div', cls: `ch-md-h ch-md-h${tk.tag.slice(1)}` }); break
        case 'table_open':
          push({ kids: [], tag: 'div', cls: 'ch-md-table' }); push({ kids: [], tag: 'table' }); break
        case 'table_close': pop(); pop(); break
        case 'ordered_list_open': {
          const start = Number(tk.attrGet('start') ?? 1)
          push({ kids: [], tag: 'ol', ...(start !== 1 && Number.isFinite(start) ? { start } : {}) }); break
        }
        default: {
          const tag = ELEMENTS[tk.type]
          if (tag) push({ kids: [], tag, ...(tk.type === 'paragraph_open' && tk.hidden ? { wrap: false } : {}) })
          else if (tk.type.endsWith('_close')) pop()
        }
      }
    }
  }
  walk(md.parse(body, {}))
  while (stack.length > 1) pop()
  return root.kids
}

export function markdownNodes(body: string, hooks: MarkdownHooks): DocumentFragment {
  const frag = document.createDocumentFragment()
  const build = (nodes: MdNode[], parent: HTMLElement | DocumentFragment): void => {
    for (const n of nodes) {
      if (n.t === 'text') {
        if (n.code || !(parent instanceof HTMLElement)) parent.append(n.text)
        else hooks.leaf(n.text, parent)
      } else if (n.t === 'br') parent.append(document.createElement('br'))
      else if (n.t === 'hr') parent.append(document.createElement('hr'))
      else if (n.t === 'el') {
        const el = document.createElement(n.tag)
        if (n.cls) el.className = n.cls
        if (n.start !== undefined) el.setAttribute('start', String(n.start))
        build(n.kids, el)
        parent.append(el)
      } else {
        const holder = parent instanceof HTMLElement ? parent : document.createElement('span')
        const a = hooks.link(n.href, holder)
        if (a) { build(n.kids, a); parent.append(a) } else build(n.kids, parent)
      }
    }
  }
  build(markdownTree(body), frag)
  return frag
}

const BLOCK = new Set<MdTag>(['p', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'div', 'thead', 'tbody', 'tr'])

function plainOf(nodes: MdNode[]): string {
  let out = ''
  for (const n of nodes) {
    if (n.t === 'text') out += n.text
    else if (n.t === 'br') out += '\n'
    else if (n.t === 'hr') out += '\n'
    else if (n.t === 'link') out += plainOf(n.kids) || n.href
    else if (n.tag === 'th' || n.tag === 'td') out += `${plainOf(n.kids)} `
    else if (BLOCK.has(n.tag)) out += `\n${plainOf(n.kids)}\n`
    else out += plainOf(n.kids)
  }
  return out
}

export function markdownPlain(body: string): string {
  return plainOf(markdownTree(body)).replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim()
}
