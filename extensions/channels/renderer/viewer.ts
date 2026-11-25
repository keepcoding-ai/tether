// The image viewer over the channel's pane (slice A3, screen 6 of the approved preview): a click on a thumbnail of the conversation
// opens the picture big, over the pane and still inside the channel. ✕, Esc and a click on the margin close it; the arrows walk to
// the image before and after in the conversation; "Abrir no app" opens it in a preview tab as before; "⋯" is the file's menu.
// Memory: the picture is asked of main only when shown (one at a time, shrunk to VIEWER_PX there) and let go of at once when the
// viewer moves on or closes: the renderer holds a single data: URL while the viewer is open and none after. No innerHTML.
import { GONE_TEXT } from '../attachments.ts'
import type { FileView } from '../ipc.ts'
import { glyph } from './glyphs.ts'
import { neighbourOf, positionText, viewerSubtitle } from './viewer-rules.ts'

/** An image of the conversation, as its thumbnail says it. */
export interface ViewerItem { path: string; name: string; label: string }

export interface ViewerDeps {
  /** The pane's element: the viewer covers it. */
  host: HTMLElement
  /** The conversation's images that are still there, in order (read each time the viewer opens or moves). */
  items(): ViewerItem[]
  /** Main's picture of an image at viewing size. */
  load(path: string): Promise<FileView>
  /** Opens the file in the app (a preview tab), as a click on it did before the viewer. */
  open(path: string): void
  /** The file's menu at page coordinates. */
  menu(x: number, y: number, path: string): void
  /** The viewer closed: the focus goes back to the thumbnail of `path`. */
  restore(path: string): void
}

/** What a test reads of the viewer. */
export interface ViewerSnapshot {
  path: string
  name: string
  subtitle: string
  position: string
  /** 'loading', 'ready' (the picture is shown), 'gone' (the file left the folder) or 'unreadable' (the system could not read it as an image). */
  state: 'loading' | 'ready' | 'gone' | 'unreadable'
  hasPrev: boolean
  hasNext: boolean
  /** Whether the picture is held right now (it is let go of when the viewer moves on or closes). */
  holding: boolean
  /** The class of the element that has the focus inside the viewer ('' when none). */
  focus: string
}

export interface Viewer {
  open(path: string): void
  /** Closes it; the focus goes back to the thumbnail unless `back` is false (the file opened in the app). */
  close(back?: boolean): void
  isOpen(): boolean
  step(dir: -1 | 1): void
  snapshot(): ViewerSnapshot | undefined
}

export const VIEWER_TEXT = {
  loading: 'Carregando a imagem…',
  unreadable: 'Não foi possível mostrar esta imagem aqui. Use "Abrir no app".',
  openApp: 'Abrir no app',
  openAppTitle: 'Abrir no app (numa prévia ao lado)',
  menu: 'Menu do arquivo',
  close: 'Fechar',
  prev: 'Imagem anterior',
  next: 'Próxima imagem',
} as const

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

export function createViewer(deps: ViewerDeps): Viewer {
  let root: HTMLElement | undefined
  let current: ViewerItem | undefined
  let state: ViewerSnapshot['state'] = 'loading'
  let dims: { width: number; height: number } | undefined
  let token = 0
  let shown: HTMLElement | undefined
  /** What was inert before the viewer opened (the pane's other children), to give back exactly that. */
  let held: HTMLElement[] = []
  // The parts of the open viewer.
  let nameEl: HTMLElement
  let subEl: HTMLElement
  let stage: HTMLElement
  let prevBtn: HTMLButtonElement
  let nextBtn: HTMLButtonElement
  let posEl: HTMLElement
  let appBtn: HTMLButtonElement
  let menuBtn: HTMLButtonElement
  let closeBtn: HTMLButtonElement

  const paths = (): string[] => deps.items().map(i => i.path)

  /** Lets go of the picture on screen (the img's source goes first so the decoded data is not kept by the element). */
  const release = (): void => {
    if (shown instanceof HTMLImageElement) shown.removeAttribute('src')
    shown?.remove()
    shown = undefined
  }

  const paintHead = (): void => {
    if (!current) return
    nameEl.textContent = current.name
    nameEl.title = current.name
    subEl.textContent = viewerSubtitle(current.label, dims)
    root?.setAttribute('aria-label', current.name)
    const ps = paths()
    prevBtn.disabled = neighbourOf(ps, current.path, -1) === undefined
    nextBtn.disabled = neighbourOf(ps, current.path, 1) === undefined
    posEl.textContent = positionText(ps, current.path)
    appBtn.disabled = menuBtn.disabled = state === 'gone'
  }

  const message = (text: string): void => {
    release()
    const m = el('div', 'ch-vmsg', text)
    stage.append(m)
    shown = m
  }

  const show = (item: ViewerItem): void => {
    current = item
    dims = undefined
    state = 'loading'
    const mine = ++token
    release()
    message(VIEWER_TEXT.loading)
    paintHead()
    void deps.load(item.path).then(v => {
      if (mine !== token || !root) return
      dims = v.width !== undefined && v.height !== undefined ? { width: v.width, height: v.height } : undefined
      release()
      if (v.missing) { state = 'gone'; message(GONE_TEXT) } else if (!v.url) { state = 'unreadable'; message(VIEWER_TEXT.unreadable) } else {
        state = 'ready'
        const img = el('img', 'ch-vimg')
        img.alt = item.name
        img.draggable = false
        img.src = v.url
        stage.append(img)
        shown = img
      }
      paintHead()
    }, () => {
      if (mine !== token || !root) return
      state = 'unreadable'
      message(VIEWER_TEXT.unreadable)
      paintHead()
    })
  }

  const step = (dir: -1 | 1): void => {
    if (!root || !current) return
    const next = neighbourOf(paths(), current.path, dir)
    const item = next === undefined ? undefined : deps.items().find(i => i.path === next)
    if (item) show(item)
  }

  const close = (back = true): void => {
    if (!root) return
    const last = current
    token++
    release()
    root.remove()
    root = undefined
    current = undefined
    for (const h of held) h.inert = false
    held = []
    if (back && last) deps.restore(last.path)
  }

  const trap = (ev: KeyboardEvent): void => {
    if (!root) return
    const items = [...root.querySelectorAll<HTMLElement>('button:not([disabled])')]
    if (items.length === 0) { ev.preventDefault(); return }
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next = ev.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : (at < 0 || at === items.length - 1 ? 0 : at + 1)
    ev.preventDefault()
    items[next]!.focus()
  }

  const openMenu = (x: number, y: number): void => { if (current && state !== 'gone') deps.menu(x, y, current.path) }

  const build = (): HTMLElement => {
    const r = el('div', 'ch-viewer')
    r.setAttribute('role', 'dialog')
    r.setAttribute('aria-modal', 'true')
    r.tabIndex = -1
    const box = el('div', 'ch-vbox')
    const head = el('div', 'ch-vh')
    const nm = el('span', 'ch-vnm')
    nameEl = el('b', 'ch-vname')
    subEl = el('small', 'ch-vsub')
    nm.append(nameEl, subEl)
    appBtn = el('button', 'ch-act ch-vapp')
    appBtn.type = 'button'
    appBtn.title = VIEWER_TEXT.openAppTitle
    appBtn.setAttribute('aria-label', VIEWER_TEXT.openApp)
    appBtn.append(glyph('arrow-square-out'), el('span', 'ch-vapp-lbl', VIEWER_TEXT.openApp))
    menuBtn = el('button', 'ch-act ch-vmenu')
    menuBtn.type = 'button'
    menuBtn.title = VIEWER_TEXT.menu
    menuBtn.setAttribute('aria-label', VIEWER_TEXT.menu)
    menuBtn.setAttribute('aria-haspopup', 'menu')
    menuBtn.append(glyph('dots-three'))
    closeBtn = el('button', 'ch-act ch-vclose')
    closeBtn.type = 'button'
    closeBtn.title = `${VIEWER_TEXT.close} (Esc)`
    closeBtn.setAttribute('aria-label', VIEWER_TEXT.close)
    closeBtn.append(glyph('x'))
    head.append(nm, appBtn, menuBtn, closeBtn)
    const body = el('div', 'ch-vb')
    prevBtn = el('button', 'ch-act ch-vnav ch-vprev')
    prevBtn.type = 'button'
    prevBtn.title = `${VIEWER_TEXT.prev} (←)`
    prevBtn.setAttribute('aria-label', VIEWER_TEXT.prev)
    prevBtn.append(glyph('arrow-left'))
    nextBtn = el('button', 'ch-act ch-vnav ch-vnext')
    nextBtn.type = 'button'
    nextBtn.title = `${VIEWER_TEXT.next} (→)`
    nextBtn.setAttribute('aria-label', VIEWER_TEXT.next)
    nextBtn.append(glyph('arrow-right'))
    stage = el('div', 'ch-vstage')
    stage.setAttribute('aria-live', 'polite')
    body.append(prevBtn, stage, nextBtn)
    const foot = el('div', 'ch-vf')
    posEl = el('span', 'ch-vpos')
    const keys = el('span', 'ch-vkeys')
    keys.append(el('kbd', '', 'Esc'), ' ou ✕ fecha · ', el('kbd', '', '←'), ' ', el('kbd', '', '→'), ' mudam de imagem')
    foot.append(keys, posEl)
    box.append(head, body, foot)
    r.append(box)

    appBtn.addEventListener('click', () => { const p = current?.path; if (p) { close(false); deps.open(p) } })
    menuBtn.addEventListener('click', () => { const b = menuBtn.getBoundingClientRect(); openMenu(b.left, b.bottom + 2) })
    closeBtn.addEventListener('click', () => close())
    prevBtn.addEventListener('click', () => step(-1))
    nextBtn.addEventListener('click', () => step(1))
    // The margin (the dim around the box, and the empty part of the stage) closes it.
    r.addEventListener('click', ev => { if (ev.target === r || ev.target === body || ev.target === stage) close() })
    r.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); openMenu(ev.clientX, ev.clientY) })
    r.addEventListener('keydown', ev => {
      if (ev.ctrlKey || ev.altKey || ev.metaKey) return
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); return }
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') { ev.preventDefault(); ev.stopPropagation(); step(ev.key === 'ArrowLeft' ? -1 : 1); return }
      if (ev.key === 'Tab') { ev.stopPropagation(); trap(ev); return }
      if (ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey)) {
        ev.preventDefault()
        ev.stopPropagation()
        const b = (document.activeElement instanceof HTMLElement && r.contains(document.activeElement) ? document.activeElement : closeBtn).getBoundingClientRect()
        openMenu(b.left, b.bottom + 2)
      }
    })
    return r
  }

  return {
    open(path) {
      const item = deps.items().find(i => i.path === path)
      if (!item) return
      if (!root) {
        root = build()
        held = [...deps.host.children].filter((c): c is HTMLElement => c instanceof HTMLElement && !c.inert)
        for (const h of held) h.inert = true
        deps.host.append(root)
        closeBtn.focus()
      }
      show(item)
    },
    close,
    isOpen: () => root !== undefined,
    step,
    snapshot() {
      if (!root || !current) return undefined
      const ps = paths()
      const at = document.activeElement
      return {
        path: current.path, name: current.name, subtitle: subEl.textContent ?? '', position: posEl.textContent ?? '', state,
        hasPrev: neighbourOf(ps, current.path, -1) !== undefined, hasNext: neighbourOf(ps, current.path, 1) !== undefined,
        holding: shown instanceof HTMLImageElement && shown.hasAttribute('src'),
        focus: at instanceof HTMLElement && root.contains(at) ? at.className : '',
      }
    },
  }
}
