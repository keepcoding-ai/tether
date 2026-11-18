// Tab emblems on screen (docs/tab-emblems-preview.html): the chip in every tab, the "Emblema…" popover, the "Emblemas"
// editor and its icon picker. The rules live in emblem-rules.ts; main.ts owns the panels and layout.json (EmblemHost).
//
// Performance: the tab chip is static DOM written only when its value changes (no observers, timers or animation, so the
// tab strip's measurement never loops on it). Icons are <symbol>s in one hidden sprite, injected the first time
// something shows them; the editor injects all of them once. The editor and its grid are built once, on first open, and
// reused; every list uses event delegation; the category highlight comes from an IntersectionObserver; the search is
// coalesced to one pass per frame over a prebuilt index.
import { HUE_NAMES } from '../shared/palette.ts'
import { EMBLEM_CATEGORIES, EMBLEM_ICONS } from './emblem-icons.ts'
import { BUILTIN_EMBLEMS, buildIconIndex, displayName, type Emblem, HUE_LABELS, isModified, MAX_NAME, newEmblemId, readEmblems, searchIcons, shownEmblem, type IconIndexEntry } from './emblem-rules.ts'
import { icon, type IconName } from './icons.ts'

/** What the emblems need from the app: the panels (to count and clear wearers), writing a tab's emblem, saving the library. */
export interface EmblemHost {
  panels(): readonly { id: string; params: unknown }[]
  /** Writes the tab's `emblem` param (undefined removes it) and schedules the layout save. */
  setParam(panelId: string, emblemId: string | undefined): void
  /** The library changed: keep it in layout.json. */
  saveLibrary(lib: Emblem[]): void
}

let host: EmblemHost | undefined
let lib: Emblem[] = BUILTIN_EMBLEMS.map(e => ({ ...e }))
const iconData = new Map(EMBLEM_ICONS.map(i => [i.n, i]))

/** The library from layout.json's `emblems` (read with tolerance); call once the layout is loaded. */
export function initEmblems(raw: unknown, h: EmblemHost): void {
  host = h
  lib = readEmblems(raw, n => iconData.has(n))
  repaintAll()
}

const emblemParam = (params: unknown): string | undefined => {
  const v = (params as { emblem?: unknown } | undefined)?.emblem
  return typeof v === 'string' ? v : undefined
}
const usesOf = (id: string): number => host?.panels().filter(p => emblemParam(p.params) === id).length ?? 0
const guias = (n: number): string => `${n} guia${n === 1 ? '' : 's'}`
const esc = (s: string): string => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

// ---------- sprite ----------

let sprite: SVGSVGElement | undefined
const injected = new Set<string>()

function addSymbols(names: readonly string[]): void {
  const todo = names.filter(n => !injected.has(n) && iconData.has(n))
  if (!todo.length) return
  if (!sprite) {
    sprite = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    sprite.setAttribute('aria-hidden', 'true')
    sprite.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden'
    document.body.append(sprite)
  }
  const tpl = document.createElement('template')
  tpl.innerHTML = `<svg>${todo.map(n => `<symbol id="emb-${n}" viewBox="0 0 256 256">${iconData.get(n)!.d}</symbol>`).join('')}</svg>`
  sprite.append(...tpl.content.firstElementChild!.children)
  for (const n of todo) injected.add(n)
}

/** Chip markup for the editor and the picker (the sprite has every symbol by then). */
const chipHtml = (e: Emblem, cls = ''): string =>
  `<span class="emb-chip ${cls}" style="background:var(--x-${e.color});color:var(--x-${e.color}-foreground)"><svg><use href="#emb-${e.icon}"/></svg></span>`

// ---------- the chip in a tab ----------

type Chip = HTMLSpanElement & { embKey?: string }
const chips = new Map<string, Set<Chip>>()
/** The emblem id each mounted tab wears (its params' `emblem`). */
const worn = new Map<string, string | undefined>()

function newChip(): Chip {
  const el = document.createElement('span') as Chip
  el.className = 'emb-chip'
  el.hidden = true
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.append(document.createElementNS('http://www.w3.org/2000/svg', 'use'))
  el.append(svg)
  return el
}

/** Writes the chip only when what it shows differs. */
function paint(el: Chip, e: Emblem | undefined): void {
  const key = e ? `${e.color}|${e.icon}|${displayName(e)}` : ''
  if (el.embKey === key) return
  el.embKey = key
  if (!e) { el.hidden = true; return }
  addSymbols([e.icon])
  el.style.background = `var(--x-${e.color})`
  el.style.color = `var(--x-${e.color}-foreground)`
  el.firstElementChild!.firstElementChild!.setAttribute('href', `#emb-${e.icon}`)
  el.title = displayName(e)
  el.hidden = false
}

/** A detached chip with the emblem a tab wears (a menu row's right end), or undefined when it wears none. */
export function emblemChip(panelId: string): HTMLElement | undefined {
  const e = shownEmblem(lib, worn.get(panelId))
  if (!e) return undefined
  const el = newChip()
  paint(el, e)
  el.classList.add('menu-emblem')
  return el
}

function repaintPanel(panelId: string): void {
  const set = chips.get(panelId)
  if (!set) return
  const e = shownEmblem(lib, worn.get(panelId))
  for (const c of set) paint(c, e)
}

function repaintAll(): void { for (const id of chips.keys()) repaintPanel(id) }

/** Puts the emblem chip right after the tab's `.kind` icon; the returned function unmounts it (the tab's dispose). */
export function mountTabEmblem(kind: HTMLElement, api: { id: string }, params: unknown): () => void {
  const el = newChip()
  kind.after(el)
  const id = api.id
  worn.set(id, emblemParam(params))
  let set = chips.get(id)
  if (!set) chips.set(id, set = new Set())
  set.add(el)
  paint(el, shownEmblem(lib, worn.get(id)))
  return () => {
    el.remove()
    const s = chips.get(id)
    if (!s) return
    s.delete(el)
    if (!s.size) { chips.delete(id); worn.delete(id) }
  }
}

function setTabEmblem(panelId: string, emblemId: string | undefined): void {
  worn.set(panelId, emblemId)
  host?.setParam(panelId, emblemId)
  repaintPanel(panelId)
}

function libraryChanged(): void {
  host?.saveLibrary(lib.map(e => ({ ...e })))
  repaintAll()
}

// ---------- "Emblema…" popover ----------

/** The emblem popover of a tab at (x, y): the visible emblems, "Nenhum", "Gerenciar emblemas…". Arrows, Enter, Esc. */
export function openEmblemMenu(panelId: string, x: number, y: number): void {
  document.getElementById('ctx-menu')?.remove()
  const panel = host?.panels().find(p => p.id === panelId)
  const current = shownEmblem(lib, panel ? emblemParam(panel.params) : worn.get(panelId))?.id
  const shown = lib.filter(e => !e.hidden)
  addSymbols(shown.map(e => e.icon))
  const menu = document.createElement('ul')
  menu.id = 'ctx-menu'; menu.className = 'menu emb-menu'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Emblema')
  const owner = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : undefined
  const item = (role: string, html: string, checked: boolean | undefined, run: () => void): void => {
    const li = document.createElement('li'); li.setAttribute('role', role); li.tabIndex = -1
    if (checked !== undefined) li.setAttribute('aria-checked', String(checked))
    li.innerHTML = html
    if (checked) li.append(icon('check', 'ctx-check'))
    li.addEventListener('click', ev => { ev.stopPropagation(); close(false); run() })
    menu.append(li)
  }
  const hd = document.createElement('li'); hd.className = 'hd'; hd.setAttribute('role', 'presentation'); hd.textContent = 'Emblema'; menu.append(hd)
  for (const e of shown) item('menuitemradio', `${chipHtml(e)}<span class="emb-mname">${esc(displayName(e))}</span>`, current === e.id, () => setTabEmblem(panelId, e.id))
  item('menuitemradio', '<span class="emb-chip emb-none"></span><span class="emb-dim">Nenhum</span>', current === undefined, () => setTabEmblem(panelId, undefined))
  const sep = document.createElement('li'); sep.className = 'sep'; sep.setAttribute('role', 'separator'); menu.append(sep)
  item('menuitem', '', undefined, () => openEmblemEditor(current))
  const manage = menu.lastElementChild!
  manage.append(icon('tag'), document.createTextNode('Gerenciar emblemas…'))

  const close = (refocus: boolean): void => {
    menu.remove(); document.removeEventListener('click', onDoc, true); document.removeEventListener('keydown', onKey, true)
    if (refocus && owner?.isConnected) owner.focus()
  }
  const onDoc = (ev: Event): void => { if (!menu.contains(ev.target as Node)) close(false) }
  const onKey = (ev: KeyboardEvent): void => {
    const lis = [...menu.querySelectorAll<HTMLElement>('li[role^=menuitem]')]
    const i = lis.indexOf(document.activeElement as HTMLElement)
    if (ev.key === 'Escape' || ev.key === 'Tab') { ev.preventDefault(); close(true) }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); lis[(i + 1) % lis.length]?.focus() }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); lis[(i - 1 + lis.length) % lis.length]?.focus() }
    else if (ev.key === 'Home') { ev.preventDefault(); lis[0]?.focus() }
    else if (ev.key === 'End') { ev.preventDefault(); lis[lis.length - 1]?.focus() }
    else if ((ev.key === 'Enter' || ev.key === ' ') && i >= 0) { ev.preventDefault(); lis[i]!.click() }
  }
  document.body.append(menu)
  const r = menu.getBoundingClientRect()
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`
  document.addEventListener('click', onDoc, true)
  document.addEventListener('keydown', onKey, true)
  ;(menu.querySelector<HTMLElement>('li[aria-checked="true"]') ?? menu.querySelector<HTMLElement>('li[role^=menuitem]'))?.focus()
}

// ---------- the editor ----------

interface Editor {
  dlg: HTMLDialogElement
  list: HTMLElement; name: HTMLInputElement; preview: HTMLElement; swatches: HTMLElement
  q: HTMLInputElement; rail: HTMLElement; grid: HTMLElement; res: HTMLElement; recent: HTMLElement; hover: HTMLElement; foot: HTMLElement
}
let ed: Editor | undefined
let sel = ''
let askingDelete = false
let index: IconIndexEntry[] | undefined
const LABEL = new Map(EMBLEM_ICONS.map(i => [i.n, i.pt.split(' ').slice(0, 3).join(', ')]))
const cur = (): Emblem => lib.find(e => e.id === sel) ?? lib[0]!
const cell = (n: string): string => `<button type="button" class="emb-c" role="option" data-i="${n}" title="${n}"><svg><use href="#emb-${n}"/></svg></button>`

/** Opens the "Emblemas" editor on `id` (or the first emblem). Built on first open, reused after. */
export function openEmblemEditor(id?: string): void {
  const e = build()
  sel = id && lib.some(x => x.id === id) ? id : lib[0]?.id ?? ''
  askingDelete = false
  renderList(); renderForm()
  if (!e.dlg.open) e.dlg.showModal()
}

function build(): Editor {
  if (ed) return ed
  addSymbols(EMBLEM_ICONS.map(i => i.n))
  const dlg = document.createElement('dialog')
  dlg.className = 'ask emb-dlg'
  dlg.setAttribute('aria-label', 'Emblemas')
  dlg.innerHTML = `<div class="emb-ed">
  <div class="emb-h"><span data-ic="tag"></span><span>Emblemas</span><span class="emb-sp"></span><button type="button" class="emb-ib" data-x title="Fechar (Esc)" aria-label="Fechar"><span data-ic="x"></span></button></div>
  <div class="emb-lst"></div>
  <div class="emb-fm">
   <div class="emb-row"><span class="emb-lbl">Nome</span><input class="emb-inp" maxlength="${MAX_NAME}" autocomplete="off" spellcheck="false" placeholder="ex.: Cliente, Urgente, Leitura"><div class="emb-pv"></div></div>
   <div class="emb-row"><span class="emb-lbl">Cor</span><div class="emb-sw" role="radiogroup" aria-label="Cor">${HUE_NAMES.map(c => `<button type="button" class="emb-s" role="radio" aria-checked="false" title="${HUE_LABELS[c]}" aria-label="${HUE_LABELS[c]}" style="background:var(--x-${c})" data-c="${c}"></button>`).join('')}</div></div>
   <div class="emb-pk">
    <label class="emb-pk-s"><span data-ic="magnifying-glass"></span><input placeholder="buscar ícone em português ou inglês…" autocomplete="off" spellcheck="false"></label>
    <nav class="emb-rail" aria-label="Categorias"><button type="button" data-cat="recent" title="Em uso"><span data-ic="clock-counter-clockwise"></span></button>${EMBLEM_CATEGORIES.map(c => `<button type="button" data-cat="${c.id}" title="${esc(c.label)}"><svg><use href="#emb-${c.icon}"/></svg></button>`).join('')}</nav>
    <div class="emb-grid" role="listbox" aria-label="Ícones"><section class="emb-sec" data-sec="recent"><h4>Em uso</h4><div class="emb-cells" data-recent></div></section>${EMBLEM_CATEGORIES.map(c => `<section class="emb-sec" data-sec="${c.id}"><h4>${esc(c.label)}</h4><div class="emb-cells">${EMBLEM_ICONS.filter(i => i.c === c.id).map(i => cell(i.n)).join('')}</div></section>`).join('')}</div>
    <div class="emb-grid" role="listbox" aria-label="Resultados" hidden></div>
    <div class="emb-pk-f">&nbsp;</div>
   </div>
   <div class="emb-ft"></div>
  </div>
 </div>`
  for (const s of dlg.querySelectorAll<HTMLElement>('[data-ic]')) s.replaceWith(icon(s.dataset.ic as IconName))
  document.body.append(dlg)
  const [grid, res] = [...dlg.querySelectorAll<HTMLElement>('.emb-grid')] as [HTMLElement, HTMLElement]
  const e: Editor = {
    dlg, list: dlg.querySelector('.emb-lst')!, name: dlg.querySelector('.emb-inp')!, preview: dlg.querySelector('.emb-pv')!,
    swatches: dlg.querySelector('.emb-sw')!, q: dlg.querySelector('.emb-pk-s input')!, rail: dlg.querySelector('.emb-rail')!,
    grid, res, recent: dlg.querySelector('[data-recent]')!, hover: dlg.querySelector('.emb-pk-f')!, foot: dlg.querySelector('.emb-ft')!,
  }
  ed = e
  wire(e)
  return e
}

function wire(e: Editor): void {
  e.dlg.querySelector('[data-x]')!.addEventListener('click', () => e.dlg.close())
  e.dlg.addEventListener('close', () => { askingDelete = false })
  e.list.addEventListener('click', ev => {
    const b = (ev.target as Element).closest<HTMLElement>('.emb-li')
    if (!b) return
    askingDelete = false
    if (b.hasAttribute('data-new')) {
      const n: Emblem = { id: newEmblemId(lib), name: '', color: 'blue', icon: 'tag' }
      lib.push(n); sel = n.id
      libraryChanged(); renderList(); renderForm(); e.name.focus()
      return
    }
    sel = b.dataset.sel!; renderList(); renderForm()
  })
  e.name.addEventListener('input', () => { cur().name = e.name.value.slice(0, MAX_NAME); renderPreview(); renderFooter(); libraryChanged() })
  e.swatches.addEventListener('click', ev => {
    const b = (ev.target as Element).closest<HTMLElement>('.emb-s')
    if (!b) return
    cur().color = b.dataset.c as Emblem['color']
    markSwatch(); renderPreview(); renderFooter(); libraryChanged()
  })
  e.swatches.addEventListener('keydown', ev => {
    const d = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[ev.key]
    if (d === undefined) return
    ev.preventDefault()
    const all = [...e.swatches.children] as HTMLElement[]
    const i = all.findIndex(s => s.getAttribute('aria-checked') === 'true')
    const next = all[(i + d + all.length) % all.length]!
    next.click(); next.focus()
  })
  e.foot.addEventListener('click', ev => {
    const a = (ev.target as Element).closest<HTMLElement>('[data-a]')?.dataset.a
    const em = cur()
    if (!a) return
    if (a === 'del') { askingDelete = true; renderFooter() }
    else if (a === 'cancel') { askingDelete = false; renderFooter() }
    else if (a === 'confirm') {
      askingDelete = false
      for (const p of host?.panels() ?? []) if (emblemParam(p.params) === em.id) setTabEmblem(p.id, undefined)
      if (em.builtin) em.hidden = true
      else { lib = lib.filter(x => x !== em); sel = lib[0]?.id ?? '' }
      libraryChanged(); renderList(); renderForm()
    } else if (a === 'show') { em.hidden = false; libraryChanged(); renderList(); renderFooter() }
    else if (a === 'reset') {
      const b = BUILTIN_EMBLEMS.find(x => x.id === em.id)
      if (b) { em.name = b.name; em.color = b.color; em.icon = b.icon }
      libraryChanged(); renderList(); renderForm()
    } else if (a === 'done') e.dlg.close()
  })

  // Picker. The category highlight: whichever section crosses the grid's top band.
  const spy = new IntersectionObserver(entries => {
    for (const en of entries) if (en.isIntersecting) {
      const id = (en.target as HTMLElement).dataset.sec
      for (const b of e.rail.children as HTMLCollectionOf<HTMLElement>) b.classList.toggle('on', b.dataset.cat === id)
    }
  }, { root: e.grid, rootMargin: '0px 0px -85% 0px' })
  for (const s of e.grid.children) spy.observe(s)
  e.rail.addEventListener('click', ev => {
    const b = (ev.target as Element).closest<HTMLElement>('[data-cat]')
    if (!b) return
    if (e.q.value) { e.q.value = ''; runSearch() }
    const s = e.grid.querySelector<HTMLElement>(`[data-sec="${b.dataset.cat}"]`)
    if (s) e.grid.scrollTo({ top: s.offsetTop - e.grid.offsetTop })
  })
  const pick = (ev: Event): void => {
    const b = (ev.target as Element).closest<HTMLElement>('.emb-c')
    if (!b) return
    cur().icon = b.dataset.i!
    markIcon(); renderPreview(); renderFooter(); libraryChanged()
  }
  let lastHover = ''
  const hover = (ev: Event): void => {
    const n = (ev.target as Element).closest<HTMLElement>('.emb-c')?.dataset.i ?? ''
    if (n === lastHover) return
    lastHover = n
    e.hover.innerHTML = n ? `<b>${n}</b> · ${esc(LABEL.get(n) ?? '')}` : '&nbsp;'
  }
  for (const g of [e.grid, e.res]) {
    g.addEventListener('click', pick)
    g.addEventListener('pointerover', hover)
    g.addEventListener('focusin', hover)
    g.addEventListener('keydown', ev => {
      const b = (ev.target as Element).closest<HTMLElement>('.emb-c')
      if (!b) return
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); b.click(); return }
      const all = [...g.querySelectorAll<HTMLElement>('.emb-c')]
      const i = all.indexOf(b)
      const cols = Math.max(1, Math.floor(b.parentElement!.clientWidth / 36))
      const d = ({ ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols } as Record<string, number>)[ev.key]
      if (d === undefined) return
      ev.preventDefault()
      ;(all[i + d] ?? b).focus()
    })
  }
  e.q.addEventListener('input', runSearch)
  e.q.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); if (!e.res.hidden) e.res.querySelector<HTMLElement>('.emb-c')?.click() }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); (e.res.hidden ? e.grid : e.res).querySelector<HTMLElement>('.emb-c')?.focus() }
  })
}

let raf = 0
function runSearch(): void {
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(() => {
    const e = ed!
    index ??= buildIconIndex(EMBLEM_ICONS)
    const q = e.q.value
    const r = searchIcons(index, q)
    if (!r) { e.res.hidden = true; e.grid.hidden = false; e.rail.classList.remove('dim'); return }
    e.grid.hidden = true; e.res.hidden = false; e.rail.classList.add('dim')
    e.res.innerHTML = r.length
      ? `<section class="emb-sec"><h4>${r.length} resultado${r.length > 1 ? 's' : ''}</h4><div class="emb-cells">${r.map(cell).join('')}</div></section>`
      : `<div class="emb-empty">Nenhum ícone para “${esc(q)}”.</div>`
    markIcon()
  })
}

function renderList(): void {
  const e = ed!
  e.list.innerHTML = lib.map(x => `<button type="button" class="emb-li${x.id === sel ? ' sel' : ''}${x.hidden ? ' hid' : ''}" data-sel="${x.id}">${chipHtml(x, 'lg')}<span class="emb-nm">${esc(displayName(x))}</span><span class="emb-meta">${x.hidden ? 'oculto' : x.builtin ? 'padrão' : ''}</span></button>`).join('')
    + `<button type="button" class="emb-li new" data-new><span class="emb-chip lg emb-new"></span><span class="emb-nm">Novo emblema</span></button>`
  e.list.querySelector('.emb-new')!.append(icon('plus'))
}

function renderForm(): void {
  const e = ed!
  const em = cur()
  e.name.value = em.name
  markSwatch(); renderPreview(); markIcon(); renderFooter()
}

function markSwatch(): void {
  const c = cur().color
  for (const s of ed!.swatches.children as HTMLCollectionOf<HTMLElement>) {
    const on = s.dataset.c === c
    s.setAttribute('aria-checked', String(on)); s.tabIndex = on ? 0 : -1
  }
}

/** The preview chips and the selected row of the list, updated in place. */
function renderPreview(): void {
  const e = ed!
  const em = cur()
  e.preview.innerHTML = `<span class="emb-pvt d">${chipHtml(em)}<span>atrium</span></span><span class="emb-pvt l">${chipHtml(em)}<span>atrium</span></span>`
  const li = e.list.querySelector<HTMLElement>(`[data-sel="${em.id}"]`)
  if (li) { li.querySelector('.emb-chip')!.outerHTML = chipHtml(em, 'lg'); li.querySelector('.emb-nm')!.textContent = displayName(em) }
}

function markIcon(): void {
  const e = ed!
  e.recent.innerHTML = [...new Set(lib.map(x => x.icon))].map(cell).join('')
  const n = cur().icon
  for (const b of e.dlg.querySelectorAll('.emb-c[aria-selected="true"]')) b.removeAttribute('aria-selected')
  for (const b of e.dlg.querySelectorAll(`.emb-c[data-i="${n}"]`)) b.setAttribute('aria-selected', 'true')
}

function renderFooter(): void {
  const e = ed!
  const em = cur()
  const n = usesOf(em.id)
  const verb = em.builtin ? 'Ocultar' : 'Excluir'
  if (askingDelete) {
    e.foot.innerHTML = `<span class="emb-msg">${verb} “${esc(displayName(em))}”?${n ? ` Está em ${guias(n)}, que ficam sem emblema.` : ''}</span><span class="emb-sp"></span><button type="button" class="emb-bt" data-a="cancel">Cancelar</button><button type="button" class="emb-bt dng solid" data-a="confirm">${verb}</button>`
    e.foot.querySelector<HTMLElement>('[data-a="confirm"]')?.focus()
    return
  }
  e.foot.innerHTML = (em.builtin && em.hidden ? '<button type="button" class="emb-bt" data-a="show">Mostrar de novo</button>' : `<button type="button" class="emb-bt dng" data-a="del"><span data-ic="trash"></span>${verb}</button>`)
    + (isModified(em) ? '<button type="button" class="emb-bt" data-a="reset"><span data-ic="arrow-counter-clockwise"></span>Restaurar padrão</button>' : '')
    + `<span class="emb-sp"></span><span class="emb-msg dim">${n ? `Em ${guias(n)}` : 'Em nenhuma guia'}</span><button type="button" class="emb-bt pri" data-a="done">Pronto</button>`
  for (const s of e.foot.querySelectorAll<HTMLElement>('[data-ic]')) s.replaceWith(icon(s.dataset.ic as IconName))
}
