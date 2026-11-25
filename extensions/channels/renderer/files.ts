// The files of a speech in the conversation (slice A2): an image is a thumbnail (a small picture main makes from the file in the
// channel's folder: the renderer never holds a file, only that picture, and at most FILE_CACHE of them), any other file is a card
// with an icon, the name and the size. A click opens the file as every file link of the app does; the right button opens the
// link menu of a file. A file gone from the folder is a dimmed card that says so and opens nothing. No innerHTML.
import { GONE_TEXT, sizeLabel } from '../attachments.ts'
import { LOOK_MAX, type FileLook } from '../ipc.ts'
import { glyph, type GlyphName } from './glyphs.ts'
import type { ViewFile } from './view-model.ts'

/** What the conversation needs of the app and of main. */
export interface FileViewDeps {
  /** Main's look at files of speeches (gone or not, a thumbnail of an image). */
  look(paths: string[]): Promise<FileLook[]>
  /** Opens the file as a link to it does. */
  open(path: string): void
  /** The link menu of a file at page coordinates. */
  menu(x: number, y: number, path: string): void
}

/** Looks kept in memory (thumbnails are small data: URLs); the oldest goes first. */
export const FILE_CACHE = 150
/** How long a look is believed before the next paint asks again (a file may be deleted by hand). */
export const LOOK_TTL_MS = 10_000

const KIND_GLYPH: Record<ViewFile['kind'], GlyphName> = { image: 'file-image', pdf: 'file-pdf', code: 'file-code', other: 'file' }

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

export interface FileViews {
  /** The block of a speech's files: thumbnails together, then the cards. */
  block(files: readonly ViewFile[]): HTMLElement
  /** Test hook: forgets what was looked at. */
  forget(): void
}

export function createFileViews(deps: FileViewDeps, now: () => number = Date.now): FileViews {
  const cache = new Map<string, { at: number; look: FileLook }>()
  const waiting = new Map<string, Array<(l: FileLook) => void>>()
  let queued = false

  const flush = (): void => {
    queued = false
    const paths = [...waiting.keys()]
    for (let i = 0; i < paths.length; i += LOOK_MAX) {
      const chunk = paths.slice(i, i + LOOK_MAX)
      const asked = new Map(chunk.map(p => [p, waiting.get(p)!]))
      for (const p of chunk) waiting.delete(p)
      void deps.look(chunk).then(looks => {
        const by = new Map(looks.map(l => [l.path, l]))
        for (const [p, cbs] of asked) {
          const look = by.get(p) ?? { path: p, missing: true }
          cache.delete(p)
          cache.set(p, { at: now(), look })
          while (cache.size > FILE_CACHE) cache.delete(cache.keys().next().value as string)
          for (const cb of cbs) cb(look)
        }
      }, () => { /* main did not answer: the file keeps its icon and still opens */ })
    }
  }

  /** The look of a file now (what is known) and again when main has answered. */
  const lookAt = (path: string, got: (l: FileLook) => void): void => {
    const c = cache.get(path)
    if (c) got(c.look)
    if (c && now() - c.at < LOOK_TTL_MS) return
    const list = waiting.get(path) ?? []
    list.push(got)
    waiting.set(path, list)
    if (!queued) { queued = true; queueMicrotask(flush) }
  }

  const wire = (b: HTMLButtonElement, f: ViewFile): void => {
    b.type = 'button'
    b.dataset.path = f.path
    b.dataset.name = f.name
    b.setAttribute('aria-label', `${f.name}, ${f.label}`)
    b.addEventListener('click', ev => { ev.stopPropagation(); if (!b.classList.contains('gone')) deps.open(f.path) })
    b.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); deps.menu(ev.clientX, ev.clientY, f.path) })
  }

  const card = (f: ViewFile, gone: boolean): HTMLButtonElement => {
    const b = el('button', `ch-fcard ch-fk-${f.kind}${gone ? ' gone' : ''}`)
    wire(b, f)
    const fi = el('span', 'ch-fcard-fi')
    fi.append(glyph(gone ? 'file' : KIND_GLYPH[f.kind]))
    const nm = el('span', 'ch-fcard-nm')
    const name = el('b', '', f.name)
    name.title = f.name
    nm.append(name, el('small', '', gone ? GONE_TEXT : f.label))
    b.append(fi, nm)
    if (gone) { b.title = GONE_TEXT; b.setAttribute('aria-label', `${f.name}, ${GONE_TEXT}`) }
    return b
  }

  const shot = (f: ViewFile): HTMLButtonElement => {
    const b = el('button', 'ch-shot')
    wire(b, f)
    const th = el('span', 'ch-shot-th')
    th.append(glyph('file-image'))
    const cp = el('span', 'ch-shot-cp')
    const name = el('span', 'ch-shot-nm', f.name)
    name.title = f.name
    cp.append(name, el('span', '', sizeLabel(f.size)))
    b.append(th, cp)
    return b
  }

  /** What the look of a file does to its button: a gone file becomes a dimmed card, an image gets its thumbnail. Run once the button is in its block. */
  const settle = (b: HTMLButtonElement, f: ViewFile, l: FileLook): void => {
    if (l.missing) { if (!b.classList.contains('gone')) b.replaceWith(card(f, true)); return }
    const th = b.querySelector('.ch-shot-th')
    if (th && l.thumb && !th.querySelector('img')) {
      const img = el('img', '')
      img.alt = ''
      img.src = l.thumb
      th.replaceChildren(img)
    }
  }

  return {
    block(files) {
      const box = el('div', 'ch-msg-files')
      box.setAttribute('role', 'group')
      box.setAttribute('aria-label', 'Anexos da fala')
      const images = files.filter(f => f.kind === 'image')
      const others = files.filter(f => f.kind !== 'image')
      const made: Array<[HTMLButtonElement, ViewFile]> = []
      if (images.length) { const g = el('div', 'ch-shots'); for (const f of images) { const b = shot(f); made.push([b, f]); g.append(b) } box.append(g) }
      if (others.length) { const g = el('div', 'ch-atts'); for (const f of others) { const b = card(f, false); made.push([b, f]); g.append(b) } box.append(g) }
      for (const [b, f] of made) lookAt(f.path, l => settle(b, f, l))
      return box
    },
    forget() { cache.clear() },
  }
}
