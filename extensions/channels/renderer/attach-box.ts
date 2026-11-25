// The files of the speaking box before they are sent (slice A1): a chip per file above the box (a thumbnail for an image; an
// icon, the name and the size for the others; ✕ takes it out), the room's warning while there is one, and the reasons a file
// did not go in, in plain words (the texts of the approved preview, screen 10). A file comes by pasting (Ctrl+V of a print or
// of files copied in the system's explorer) or by the clip (the system's picker): the clip is the menu path of pasting.
// Memory: the renderer never holds a file, only main's small thumbnail; at most ATTACH_MAX_PER_SAY chips.
import { admit, kindOf, KIND_LABEL, refusalText, roomNote, screenshotName, sizeLabel, type FileRefusal, type FileSource } from '../attachments.ts'
import type { AttachInfo } from '../ipc.ts'
import { glyph, type GlyphName } from './glyphs.ts'

/** What the box needs of main and of the preload. */
export interface AttachDeps {
  inspect(paths: string[]): Promise<AttachInfo[]>
  pick(): Promise<AttachInfo[]>
  stageImage(name: string): Promise<AttachInfo | undefined>
  discard(paths: string[]): void
  /** The path on disk of a pasted File; '' when there is none (a print). */
  pathOf(file: File): string
}

/** The clip's tooltip (dragging comes with its own slice and is said there). */
export const CLIP_TITLE = 'Anexar arquivo · também: cole com Ctrl+V'
export const SECRET_SMALL = 'Recusado: parece conter segredos'

/** What a test reads of the chips. */
export interface AttachSnapshot {
  chips: Array<{ name: string; size: number; label: string; thumb: boolean; bad: boolean }>
  notes: string[]
  room: string
}

export interface AttachBox {
  /** The chips, the notes and the room's warning, in that order, to go above the box's head. */
  readonly parts: HTMLElement[]
  /** What `say` carries: the files that went in. */
  sources(): FileSource[]
  count(): number
  /** Asks the picker and adds what was chosen. */
  pick(): Promise<void>
  /** A paste in the field: files or a print become chips (true: the paste was the box's, the default must not run). */
  paste(ev: ClipboardEvent): boolean
  /** Adds files main looked at (the picker's or the paste's). */
  add(infos: readonly AttachInfo[]): void
  /** The speech went: the chips go, the staged prints are deleted. */
  sent(): void
  snapshot(): AttachSnapshot
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

const KIND_GLYPH: Record<ReturnType<typeof kindOf>, GlyphName> = { image: 'file-image', pdf: 'file-pdf', code: 'file-code', other: 'file' }

interface Note { why: FileRefusal; lead: string; rest: string; name?: string }

export function createAttachBox(deps: AttachDeps, changed: () => void): AttachBox {
  const chipsEl = el('div', 'ch-fchips')
  chipsEl.setAttribute('role', 'list')
  chipsEl.setAttribute('aria-label', 'Anexos da fala')
  const notesEl = el('div', 'ch-fnotes')
  notesEl.setAttribute('role', 'alert')
  const roomEl = el('div', 'ch-roomnote')
  let files: AttachInfo[] = []
  /** Files refused by their name (a secret): shown as a red chip until ✕ or the next attaching. */
  let bad: AttachInfo[] = []
  let notes: Note[] = []

  const label = (f: AttachInfo): string => `${KIND_LABEL[kindOf(f.name)]} · ${sizeLabel(f.size)}`

  const chip = (f: AttachInfo, refused: boolean): HTMLElement => {
    const c = el('div', `ch-fchip${refused ? ' bad' : ''}`)
    c.setAttribute('role', 'listitem')
    c.dataset.name = f.name
    const th = el('span', `ch-fchip-th ch-fchip-${kindOf(f.name)}`)
    if (refused) th.append(glyph('key'))
    else if (f.thumb) { const img = el('img', ''); img.src = f.thumb; img.alt = ''; th.append(img) } else th.append(glyph(KIND_GLYPH[kindOf(f.name)]))
    const nm = el('span', 'ch-fchip-nm')
    const b = el('b', '', f.name)
    b.title = f.name
    nm.append(b, el('small', '', refused ? SECRET_SMALL : label(f)))
    const rm = el('button', 'ch-act ch-fchip-rm')
    rm.type = 'button'
    rm.title = refused ? 'Tirar' : 'Tirar anexo'
    rm.setAttribute('aria-label', `${refused ? 'Tirar' : 'Tirar anexo'} ${f.name}`)
    rm.append(glyph('x'))
    rm.addEventListener('click', () => {
      if (refused) { bad = bad.filter(x => x !== f); notes = notes.filter(n => !(n.why === 'secret-file' && n.name === f.name)) } else {
        files = files.filter(x => x !== f)
        if (f.staged) deps.discard([f.path])
      }
      paint()
    })
    c.append(th, nm, rm)
    return c
  }

  const paint = (notify = true): void => {
    chipsEl.replaceChildren(...files.map(f => chip(f, false)), ...bad.map(f => chip(f, true)))
    chipsEl.hidden = files.length + bad.length === 0
    notesEl.replaceChildren(...notes.map(n => {
      const d = el('div', `ch-ferr${n.why === 'too-many' ? ' warn' : ''}`)
      d.append(el('b', '', n.lead), ` ${n.rest}`)
      return d
    }))
    notesEl.hidden = notes.length === 0
    const room = roomNote(files.length)
    roomEl.replaceChildren(...(room ? [glyph('lock'), el('span', '', room)] : []))
    roomEl.hidden = room === ''
    if (notify) changed()
  }

  const add = (infos: readonly AttachInfo[]): void => {
    // A file already on the speech is not added twice.
    const fresh = infos.filter(i => !files.some(f => f.path.toLowerCase() === i.path.toLowerCase()))
    const r = admit(files.length, fresh)
    bad = []
    notes = []
    for (const { file, why } of r.refused) {
      if (why === 'secret-file') bad.push(file)
      notes.push({ why, name: file.name, ...refusalText(why, file.name, { size: file.size }) })
      if (file.staged) deps.discard([file.path])
    }
    if (r.over > 0) notes.push({ why: 'too-many', ...refusalText('too-many', '', { accepted: r.accepted.length, tried: r.tried }) })
    files = [...files, ...r.accepted]
    // A staged print over the count is deleted with the rest that did not go in.
    const out = fresh.filter(i => i.staged && !files.includes(i) && !r.refused.some(x => x.file === i))
    if (out.length) deps.discard(out.map(i => i.path))
    paint()
  }

  // The first paint tells nobody: the box that owns these parts is still being built.
  paint(false)
  return {
    parts: [chipsEl, notesEl, roomEl],
    sources: () => files.map(f => ({ path: f.path, name: f.name })),
    count: () => files.length,
    async pick() { add(await deps.pick()) },
    paste(ev) {
      const dt = ev.clipboardData
      if (!dt) return false
      const pasted = [...dt.files]
      if (pasted.length === 0) return false
      const paths = pasted.map(f => deps.pathOf(f)).filter(p => p !== '')
      if (paths.length > 0) { void deps.inspect(paths).then(add); return true }
      // A print (an image with no file behind it): main stages the clipboard's image. Text pasted with an image stays text.
      if (pasted.some(f => f.type.startsWith('image/')) && dt.getData('text/plain') === '') {
        void deps.stageImage(screenshotName(new Date())).then(i => { if (i) add([i]) })
        return true
      }
      return false
    },
    add,
    sent() {
      const staged = files.filter(f => f.staged).map(f => f.path)
      if (staged.length) deps.discard(staged)
      files = []
      bad = []
      notes = []
      paint()
    },
    snapshot: () => ({
      chips: [...files.map(f => ({ name: f.name, size: f.size, label: label(f), thumb: f.thumb !== undefined, bad: false })),
        ...bad.map(f => ({ name: f.name, size: f.size, label: SECRET_SMALL, thumb: false, bad: true }))],
      notes: notes.map(n => `${n.lead} ${n.rest}`),
      room: roomEl.hidden ? '' : roomEl.textContent ?? '',
    }),
  }
}
