// The web's question box (RR5 5.4): where a gesture from afar asks before it acts, the same questions as the app's dialogs.
// On the phone a sheet from the bottom over a veil; elsewhere a dialog in the middle (an act's question is short and
// predictable). Modal: the keyboard is held inside it (Tab walks its buttons and fields and comes round), Esc or the TV's
// Back closes it as a cancel, a press on the veil too, and the keyboard goes back to where it was when it closes. Every text
// goes in as a text node. Three forms: a question with its choices (and a reason, when one is asked), a list to pick from
// (a desk), and a desk's name and colour.
import type { PickItem as ListItem, PickManySpec, PickSpec } from '../../../app/renderer/ext-api.ts'
import { HUE_NAMES, type HueName } from '../../../app/shared/palette.ts'
import { HUE_LABELS } from '../../../app/renderer/emblem-rules.ts'
import type { Tier } from '../../../extensions/regency/renderer/layout-rules.ts'
import { PROOF_LINE, reasonCheck, type Question } from './manage-rules.ts'
import { el } from './ui-lite.ts'

const BACK = new Set(['Escape', 'GoBack', 'BrowserBack'])
let seq = 0

const focusables = (box: HTMLElement): HTMLElement[] =>
  [...box.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]')].filter(e => e.getClientRects().length > 0)

const editable = (e: EventTarget | null): boolean => e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement

/**
 * The last element of the page that held the keyboard outside a menu or a box: a box opened from a menu's row finds the
 * menu gone (and the keyboard on the body), and gives the keyboard back to the row the menu was opened on.
 */
let lastHeld: HTMLElement | undefined
let watching = false
export function watchFocus(): void {
  if (watching) return
  watching = true
  document.addEventListener('focusin', ev => {
    const t = ev.target
    if (t instanceof HTMLElement && !t.closest('#ctx-menu, .rr-ask')) lastHeld = t
  })
}

/** Where the keyboard goes back: the opener, or the row of the tree a repaint put in its place (by its key). */
function backTo(e: HTMLElement | undefined): HTMLElement | undefined {
  if (!e) return undefined
  if (e.isConnected) return e
  const key = e.dataset.key
  return key ? [...document.querySelectorAll<HTMLElement>('[data-key]')].find(x => x.dataset.key === key) : undefined
}

/** The box, its veil, the trap and the way back; `build` fills the body and says who takes the keyboard first. */
export function openSheet<T>(tier: Tier, title: string, build: (body: HTMLElement, done: (v: T | undefined) => void) => HTMLElement | undefined): Promise<T | undefined> {
  watchFocus()
  return new Promise(resolve => {
    const active = document.activeElement
    const opener = active instanceof HTMLElement && active !== document.body && !active.closest('#ctx-menu') ? active : lastHeld
    // A modal <dialog>: it lives in the page's top layer, so it stacks over another modal box (the card of "+ Novo" asks
    // its pickers here) and leaves the rest of the page inert while it is open. Its backdrop is the veil.
    const box = el('dialog', 'rr-ask')
    box.setAttribute('aria-modal', 'true')
    box.dataset.form = tier === 'mobile' ? 'sheet' : 'dialog'
    box.dataset.tier = tier
    const h = el('h2', 'rr-ask-t', title)
    h.id = `rr-ask-${++seq}`
    box.setAttribute('aria-labelledby', h.id)
    const body = el('div', 'rr-ask-b')
    box.append(el('div', 'rr-ask-grab'), h, body)
    let settled = false
    const done = (v: T | undefined): void => {
      if (settled) return
      settled = true
      if (box.open) box.close()
      box.remove()
      backTo(opener)?.focus({ preventScroll: true })
      resolve(v)
    }
    const first = build(body, done)
    // A press on the backdrop (outside the box's own rectangle) is a cancel; Esc is the box's own key, below.
    box.addEventListener('click', ev => {
      if (ev.target !== box) return
      const r = box.getBoundingClientRect()
      if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) done(undefined)
    })
    box.addEventListener('cancel', ev => { ev.preventDefault(); done(undefined) })
    box.addEventListener('keydown', ev => {
      if (BACK.has(ev.key) || (ev.key === 'Backspace' && !editable(ev.target))) { ev.preventDefault(); ev.stopPropagation(); done(undefined); return }
      if (ev.key !== 'Tab') { ev.stopPropagation(); return }
      const all = focusables(box)
      if (all.length === 0) return
      const at = all.indexOf(document.activeElement as HTMLElement)
      const next = ev.shiftKey ? (at <= 0 ? all.length - 1 : at - 1) : (at < 0 || at === all.length - 1 ? 0 : at + 1)
      ev.preventDefault()
      ev.stopPropagation()
      all[next]!.focus()
    })
    document.body.append(box)
    box.showModal()
    ;(first ?? focusables(box)[0])?.focus()
  })
}

function button(cls: string, label: string, tone?: string): HTMLButtonElement {
  const b = el('button', cls, label)
  b.type = 'button'
  if (tone) b.dataset.tone = tone
  return b
}

/** The arrows walk a list of buttons (the TV's remote, a keyboard): up and down, and Home and End. */
function arrowsWalk(list: HTMLElement): void {
  list.addEventListener('keydown', ev => {
    const all = [...list.querySelectorAll<HTMLElement>('button:not([disabled])')]
    const at = all.indexOf(document.activeElement as HTMLElement)
    const go = (i: number): void => { ev.preventDefault(); ev.stopPropagation(); all[(i + all.length) % all.length]?.focus() }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') go(at + 1)
    else if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') go(at - 1)
    else if (ev.key === 'Home') go(0)
    else if (ev.key === 'End') go(-1)
  })
}

export interface Answer { choice: string; reason?: string }

/**
 * A question of the app's (manage-rules.ts): what is at stake, each choice with its consequence, the cancel. When a choice
 * needs the biometrics, the line that says so comes before the buttons; when a reason is asked, it is checked here (required,
 * at most the portal's ceiling) before the answer goes.
 */
export function ask(tier: Tier, q: Question): Promise<Answer | undefined> {
  return openSheet<Answer>(tier, q.title, (body, done) => {
    if (q.context) {
      const c = el('div', 'rr-ask-ctx')
      c.append(el('b', 'rr-ask-n', q.context.name))
      if (q.context.status) c.append(el('span', 'rr-ask-st', q.context.status))
      if (q.context.lines.length > 0) {
        const ul = el('ul', 'rr-ask-l')
        for (const l of q.context.lines) ul.append(el('li', '', l))
        c.append(ul)
      }
      body.append(c)
    }
    if (q.lead) body.append(el('p', 'rr-ask-p', q.lead))
    let reason: HTMLInputElement | undefined
    let err: HTMLElement | undefined
    if (q.reason) {
      const label = el('label', 'rr-ask-f', q.reason.label)
      reason = el('input', 'rr-ask-in')
      reason.type = 'text'
      reason.placeholder = q.reason.placeholder
      reason.dataset.field = 'reason'
      label.append(reason)
      err = el('p', 'rr-ask-err')
      err.setAttribute('role', 'alert')
      err.hidden = true
      body.append(label, err)
    }
    if (q.choices.some(c => c.proof)) {
      const p = el('p', 'rr-ask-proof', PROOF_LINE)
      body.append(p)
    }
    const list = el('div', 'rr-ask-cs')
    let first: HTMLElement | undefined
    for (const c of q.choices) {
      const b = button('rr-ask-c', '', c.tone)
      b.dataset.choice = c.id
      b.append(el('span', 'rr-ask-cl', c.label), el('span', 'rr-ask-cc', c.consequence))
      b.addEventListener('click', () => {
        if (reason && err) {
          const r = reasonCheck(reason.value)
          if (!r.ok) { err.textContent = r.why; err.hidden = false; reason.focus(); return }
          done({ choice: c.id, reason: r.value })
          return
        }
        done({ choice: c.id })
      })
      list.append(b)
      // The safe way takes the keyboard first; with a reason, its field does.
      if (!first && c.tone !== 'destructive') first = b
    }
    arrowsWalk(list)
    body.append(list)
    // A notice with one answer ("Entendi") has no cancel of its own: Esc and the veil close it the same.
    let cancel: HTMLButtonElement | undefined
    if (q.cancel !== '') {
      cancel = button('rr-ask-x', q.cancel)
      cancel.dataset.choice = 'cancel'
      cancel.addEventListener('click', () => done(undefined))
      body.append(cancel)
    }
    reason?.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); list.querySelector<HTMLElement>('button')?.click() } })
    return reason ?? first ?? cancel ?? list.querySelector<HTMLElement>('button') ?? undefined
  })
}

/** A list longer than this gets a field that filters it (the app's pickers always have one; a short list reads at a glance). */
const FILTER_FROM = 8

const matches = (it: ListItem<unknown>, q: string): boolean => {
  const t = q.trim().toLowerCase()
  return t === '' || it.label.toLowerCase().includes(t) || (it.detail ?? '').toLowerCase().includes(t) || (it.group ?? '').toLowerCase().includes(t)
}

/** The rows of a picker, in their groups (the order in which each group first appears), each row a button. */
function pickRows<T>(list: HTMLElement, items: readonly ListItem<T>[], row: (it: ListItem<T>, i: number) => HTMLElement): void {
  const groups: string[] = []
  for (const it of items) if (!groups.includes(it.group ?? '')) groups.push(it.group ?? '')
  const out: HTMLElement[] = []
  for (const g of groups) {
    if (g !== '') out.push(el('div', 'rr-ask-g', g))
    items.forEach((it, i) => { if ((it.group ?? '') === g) out.push(row(it, i)) })
  }
  list.replaceChildren(...out)
}

/** An agent's initial in the row's icon place, as the app's picker draws it (its hue is the app's palette, not a token: plain here). */
function rowMark(it: ListItem<unknown>): HTMLElement | undefined {
  if (!it.letter) return undefined
  const m = el('span', 'rr-ask-mk', it.letter.charAt(0))
  m.setAttribute('aria-hidden', 'true')
  return m
}

/** The items of a spec, as they are or as its reader gives them. */
async function itemsOf<T>(spec: PickSpec<T>): Promise<ListItem<T>[]> {
  const raw = typeof spec.items === 'function' ? await spec.items().catch(() => [] as readonly ListItem<T>[]) : spec.items
  return [...(spec.featured ? [spec.featured] : []), ...raw]
}

/** The app's list picker (`pick.list`), on the web's box: its groups, its rows and, for a long list, its filter. */
export async function pickList<T>(tier: Tier, spec: PickSpec<T>): Promise<T | undefined> {
  const items = await itemsOf(spec)
  return openSheet<T>(tier, spec.title, (body, done) => {
    const list = el('div', 'rr-ask-pick')
    list.setAttribute('role', 'group')
    list.setAttribute('aria-label', spec.title)
    const paint = (q: string): void => {
      const shown = items.filter(it => matches(it, q))
      pickRows(list, shown, it => {
        const b = button('rr-ask-o', '')
        const mk = rowMark(it)
        if (mk) b.append(mk)
        b.append(el('span', 'rr-ask-ol', it.label))
        if (it.detail) b.append(el('span', 'rr-ask-od', it.detail))
        b.addEventListener('click', () => done(it.value))
        return b
      })
      if (shown.length === 0) list.append(el('p', 'rr-ask-p', spec.emptyText ?? 'Nada aqui.'))
    }
    const filter = items.length > FILTER_FROM ? filterField(spec.placeholder ?? 'Buscar', paint) : undefined
    paint('')
    arrowsWalk(list)
    const cancel = button('rr-ask-x', 'Cancelar')
    cancel.addEventListener('click', () => done(undefined))
    body.append(...(filter ? [filter] : []), list, cancel)
    return filter?.querySelector('input') ?? list.querySelector<HTMLElement>('button') ?? cancel
  })
}

/**
 * The app's picker of several (`pick.many`): each row marks and unmarks (a checkbox to the screen reader), the confirm
 * button counts the marks ("Chamar 2") and answers with the marked ones in the list's order.
 */
export async function pickMany<T>(tier: Tier, spec: PickManySpec<T>): Promise<T[] | undefined> {
  const items = await itemsOf(spec)
  const marked = new Set<number>()
  return openSheet<T[]>(tier, spec.title, (body, done) => {
    const verb = spec.confirmLabel ?? 'Confirmar'
    const go = button('rr-ask-c', verb, 'safe')
    go.dataset.choice = 'confirm'
    const count = (): void => {
      go.textContent = marked.size > 0 ? `${verb} ${marked.size}` : verb
      go.disabled = marked.size === 0
    }
    const list = el('div', 'rr-ask-pick')
    list.setAttribute('role', 'group')
    list.setAttribute('aria-label', spec.title)
    const paint = (q: string): void => {
      const shown = items.map((it, i) => ({ it, i })).filter(x => matches(x.it, q))
      pickRows(list, shown.map(x => x.it), (it, j) => {
        const i = shown[j]!.i
        const b = button('rr-ask-o rr-ask-ck', '')
        b.setAttribute('role', 'checkbox')
        b.setAttribute('aria-checked', String(marked.has(i)))
        b.dataset.value = String(i)
        const box = el('span', 'rr-ask-box')
        box.setAttribute('aria-hidden', 'true')
        b.append(box)
        const mk = rowMark(it)
        if (mk) b.append(mk)
        b.append(el('span', 'rr-ask-ol', it.label))
        if (it.detail) b.append(el('span', 'rr-ask-od', it.detail))
        b.addEventListener('click', () => {
          if (marked.has(i)) marked.delete(i); else marked.add(i)
          b.setAttribute('aria-checked', String(marked.has(i)))
          count()
        })
        return b
      })
      if (shown.length === 0) list.append(el('p', 'rr-ask-p', spec.emptyText ?? 'Nada aqui.'))
    }
    const filter = items.length > FILTER_FROM ? filterField(spec.placeholder ?? 'Buscar', paint) : undefined
    paint('')
    arrowsWalk(list)
    count()
    go.addEventListener('click', () => { if (marked.size > 0) done(items.filter((_, i) => marked.has(i)).map(it => it.value)) })
    const row = el('div', 'rr-ask-cs')
    row.append(go)
    const cancel = button('rr-ask-x', 'Cancelar')
    cancel.addEventListener('click', () => done(undefined))
    body.append(...(filter ? [filter] : []), list, row, cancel)
    return filter?.querySelector('input') ?? list.querySelector<HTMLElement>('button') ?? cancel
  })
}

/** The field that filters a long list (it calls `paint` with what is typed). */
function filterField(placeholder: string, paint: (q: string) => void): HTMLElement {
  const label = el('label', 'rr-ask-f')
  const input = el('input', 'rr-ask-in')
  input.type = 'search'
  input.placeholder = placeholder
  input.autocomplete = 'off'
  input.spellcheck = false
  input.setAttribute('aria-label', placeholder)
  input.addEventListener('input', () => paint(input.value))
  label.append(input)
  return label
}

export interface PickItem { value: string; label: string; detail?: string; color?: string }

/** A list to choose one from (the desk a pane goes to, the desk a session reopens in); the cancel at its foot. */
export function pick(tier: Tier, title: string, items: readonly PickItem[], o: { note?: string; empty: string; cancel?: string }): Promise<string | undefined> {
  return openSheet<string>(tier, title, (body, done) => {
    if (o.note) body.append(el('p', 'rr-ask-p', o.note))
    const list = el('div', 'rr-ask-pick')
    list.setAttribute('role', 'group')
    list.setAttribute('aria-label', title)
    for (const it of items) {
      const b = button('rr-ask-o', '')
      b.dataset.value = it.value
      if (it.color) {
        const sw = el('span', 'rr-swatch')
        sw.style.setProperty('--rr-desk', `var(--x-${it.color}, var(--accent))`)
        b.append(sw)
      }
      b.append(el('span', 'rr-ask-ol', it.label))
      if (it.detail) b.append(el('span', 'rr-ask-od', it.detail))
      b.addEventListener('click', () => done(it.value))
      list.append(b)
    }
    if (items.length === 0) list.append(el('p', 'rr-ask-p', o.empty))
    arrowsWalk(list)
    const cancel = button('rr-ask-x', o.cancel ?? 'Cancelar')
    cancel.addEventListener('click', () => done(undefined))
    body.append(list, cancel)
    return list.querySelector<HTMLElement>('button') ?? cancel
  })
}

export interface DeskDraft { name: string; color: HueName }

/**
 * A desk's name and colour (a new desk), or the colour alone ("Cor…"). The colours are the app's twelve, a group of radios
 * the arrows walk; `check` says why a name is refused (the portal's ceiling) before anything goes.
 */
export function deskForm(tier: Tier, o: { title: string; submit: string; name?: string; color: HueName; withName: boolean; check(name: string): string | undefined }): Promise<DeskDraft | undefined> {
  return openSheet<DeskDraft>(tier, o.title, (body, done) => {
    let color: HueName = o.color
    let input: HTMLInputElement | undefined
    const err = el('p', 'rr-ask-err')
    err.setAttribute('role', 'alert')
    err.hidden = true
    if (o.withName) {
      const label = el('label', 'rr-ask-f', 'Nome')
      input = el('input', 'rr-ask-in')
      input.type = 'text'
      input.value = o.name ?? ''
      input.placeholder = 'Nome da mesa'
      input.autocomplete = 'off'
      input.spellcheck = false
      input.dataset.field = 'name'
      label.append(input)
      body.append(label)
    }
    const group = el('div', 'rr-ask-hues')
    group.setAttribute('role', 'radiogroup')
    group.setAttribute('aria-label', 'Cor')
    const paint = (): void => {
      for (const b of group.querySelectorAll<HTMLButtonElement>('button')) {
        const on = b.dataset.hue === color
        b.setAttribute('aria-checked', String(on))
        b.tabIndex = on ? 0 : -1
      }
    }
    for (const h of HUE_NAMES) {
      const b = el('button', 'rr-ask-hue')
      b.type = 'button'
      b.setAttribute('role', 'radio')
      b.dataset.hue = h
      b.title = HUE_LABELS[h]
      b.setAttribute('aria-label', HUE_LABELS[h])
      b.style.setProperty('--rr-desk', `var(--x-${h})`)
      b.addEventListener('click', () => { color = h; paint() })
      group.append(b)
    }
    group.addEventListener('keydown', ev => {
      const i = HUE_NAMES.indexOf(color)
      const step = ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? -1 : 0
      if (step === 0) return
      ev.preventDefault()
      ev.stopPropagation()
      color = HUE_NAMES[(i + step + HUE_NAMES.length) % HUE_NAMES.length]!
      paint()
      group.querySelector<HTMLElement>(`[data-hue="${color}"]`)?.focus()
    })
    paint()
    const lab = el('span', 'rr-ask-f', 'Cor')
    lab.setAttribute('aria-hidden', 'true')
    body.append(lab, group, err)
    const go = button('rr-ask-c', o.submit, 'neutral')
    go.dataset.choice = 'submit'
    const submit = (): void => {
      const name = input?.value ?? o.name ?? ''
      const why = o.withName ? o.check(name) : undefined
      if (why) { err.textContent = why; err.hidden = false; input?.focus(); return }
      done({ name, color })
    }
    go.addEventListener('click', submit)
    input?.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); submit() } })
    const cancel = button('rr-ask-x', 'Cancelar')
    cancel.addEventListener('click', () => done(undefined))
    const row = el('div', 'rr-ask-cs')
    row.append(go)
    body.append(row, cancel)
    return input ?? group.querySelector<HTMLElement>('[tabindex="0"]') ?? go
  })
}
