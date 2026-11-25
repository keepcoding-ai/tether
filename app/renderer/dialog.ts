// The in-app dialog (app/shared/dialog.ts): a <dialog> over the whole window with a fixed structure —
// situation (icon, title, message), context (which panel, which state), choices as cards (action +
// consequence, coloured by tone), footer (remember box, cancel). Modal: the rest of the page is inert,
// focus stays inside, Esc cancels, Enter takes the default (never a destructive choice), arrows move
// between cards. Also exports the choice-card renderer, shared with the panel overlays.
import type { ChoiceTone, DialogAnswer, DialogChoice, DialogSpec } from '../shared/dialog.ts'
import { icon, ICON_NAMES, type IconName } from './icons.ts'
import { markOf } from './agent-identity.ts'
import type { HueName } from '../shared/palette.ts'

const ICON_SET = new Set<string>(ICON_NAMES)

/** The spec names icons as strings (shared types); an unknown name falls back to a neutral mark. */
function iconEl(name: string): SVGSVGElement {
  return icon((ICON_SET.has(name) ? name : 'question') as IconName)
}

/** The agent's emblem or letter as the context block carries it (the spec is plain data: it may cross windows). */
function contextMark(m: NonNullable<NonNullable<DialogSpec['context']>['mark']>): HTMLElement {
  return markOf(m.type === 'emblem' ? { mark: { type: 'emblem', emblem: { name: m.emblem.name, color: m.emblem.color as HueName, icon: m.emblem.icon } } } : { mark: m })
}

const TONE_ORDER: Record<ChoiceTone, number> = { safe: 0, neutral: 1, destructive: 2 }

export interface ChoiceCardOptions {
  /** The choice Enter takes: gets the accent ring and the "Enter" hint. */
  defaultId?: string
  /** Marks the Esc choice (when it is a card rather than the footer button). */
  escId?: string
}

/** Choice cards, safe first, destructive last. Each card is a button: the consequence is part of its name. */
export function renderChoices(choices: DialogChoice[], onPick: (id: string) => void, opts: ChoiceCardOptions = {}): HTMLElement {
  const list = document.createElement('div')
  list.className = 'choices'
  list.setAttribute('role', 'group')
  const ordered = [...choices].sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone])
  for (const c of ordered) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `choice ${c.tone}`
    btn.dataset.choice = c.id
    if (c.id === opts.defaultId) btn.classList.add('default')
    if (c.id === opts.escId) btn.classList.add('esc')
    const icon = document.createElement('span'); icon.className = 'choice-icon'; icon.append(iconEl(c.icon))
    const text = document.createElement('span'); text.className = 'choice-text'
    const label = document.createElement('span'); label.className = 'choice-label'; label.textContent = c.label
    const consequence = document.createElement('span'); consequence.className = 'choice-consequence'; consequence.textContent = c.consequence
    text.append(label, consequence)
    btn.append(icon, text)
    // Enter takes the focused card: every card carries the hint, CSS shows it on the one with the focus.
    const kbd = document.createElement('kbd'); kbd.className = 'choice-key'; kbd.textContent = c.id === opts.escId ? 'Esc' : 'Enter'; kbd.setAttribute('aria-hidden', 'true')
    btn.append(kbd)
    btn.addEventListener('click', ev => { ev.stopPropagation(); onPick(c.id) })
    list.append(btn)
  }
  return list
}

/** Arrow keys move the focus between the cards of a group (wrapping); Home/End jump. */
export function roveWithArrows(group: HTMLElement, ev: KeyboardEvent): boolean {
  const cards = [...group.querySelectorAll<HTMLButtonElement>('button.choice')]
  if (cards.length === 0) return false
  const current = cards.indexOf(document.activeElement as HTMLButtonElement)
  let next: number
  switch (ev.key) {
    case 'ArrowDown': case 'ArrowRight': next = current < 0 ? 0 : (current + 1) % cards.length; break
    case 'ArrowUp': case 'ArrowLeft': next = current < 0 ? cards.length - 1 : (current - 1 + cards.length) % cards.length; break
    case 'Home': next = 0; break
    case 'End': next = cards.length - 1; break
    default: return false
  }
  ev.preventDefault()
  cards[next]?.focus()
  return true
}

let seq = 0

/** The first safe choice, else the first neutral one: Enter never takes a destructive choice. */
export function defaultChoice(spec: DialogSpec): string | undefined {
  const wanted = spec.choices.find(c => c.id === spec.defaultChoice && c.tone !== 'destructive')
  if (wanted) return wanted.id
  return (spec.choices.find(c => c.tone === 'safe') ?? spec.choices.find(c => c.tone === 'neutral'))?.id
}

/** Shows the dialog and resolves with the answer. Enter = the default choice, Esc = 'cancel' (always, even without a cancel button). */
export function askDialog(spec: DialogSpec, host: HTMLElement = document.body): Promise<DialogAnswer> {
  return new Promise(resolve => {
    const id = `dlg-${++seq}`
    const dlg = document.createElement('dialog')
    dlg.className = `ask ${spec.tone}`
    dlg.dataset.dialog = spec.situation
    dlg.setAttribute('aria-labelledby', `${id}-title`)
    dlg.setAttribute('aria-describedby', `${id}-desc`)

    const head = document.createElement('header')
    const badge = document.createElement('span'); badge.className = 'badge'; badge.append(iconEl(spec.icon))
    const title = document.createElement('h2'); title.id = `${id}-title`; title.textContent = spec.title
    head.append(badge, title)

    const desc = document.createElement('div'); desc.className = 'desc'; desc.id = `${id}-desc`
    if (spec.message) { const p = document.createElement('p'); p.className = 'message'; p.textContent = spec.message; desc.append(p) }
    if (spec.context) {
      const ctx = document.createElement('div'); ctx.className = 'context'
      const icon = document.createElement('span'); icon.className = 'ctx-icon'; icon.append(iconEl(spec.context.icon))
      const text = document.createElement('div'); text.className = 'ctx-text'
      const name = document.createElement('div'); name.className = 'ctx-name'; name.textContent = spec.context.name
      text.append(name)
      for (const line of spec.context.lines) { const l = document.createElement('div'); l.className = 'ctx-line'; l.textContent = line; text.append(l) }
      // An agent: the engine's icon, then its emblem or letter, then the name (agent-identity.ts).
      if (spec.context.mark) ctx.append(icon, contextMark(spec.context.mark), text)
      else ctx.append(icon, text)
      if (spec.context.status) {
        const st = document.createElement('span'); st.className = `ctx-status ${spec.context.status.tone}`; st.textContent = spec.context.status.label
        ctx.append(st)
      }
      desc.append(ctx)
    }
    if (spec.image && spec.image.src.startsWith('data:image/')) {
      const img = document.createElement('img'); img.className = 'ask-image'; img.src = spec.image.src; img.alt = spec.image.alt
      desc.append(img)
    }

    const remembers: { box: HTMLInputElement; choice: string }[] = []
    let picked = spec.options?.selected
    const finish = (choice: string): void => {
      dlg.removeEventListener('keydown', onKey)
      dlg.close()
      dlg.remove()
      const ticked = remembers.find(r => r.box.checked)
      resolve({ choice, remember: ticked !== undefined, ...(ticked ? { rememberChoice: ticked.choice } : {}), ...(spec.options ? { option: picked } : {}) })
    }

    const def = defaultChoice(spec)
    const esc = spec.choices.find(c => c.id === spec.escChoice && c.tone !== 'destructive')?.id
    const choices = renderChoices(spec.choices, finish, { defaultId: def, escId: esc })

    // The option list: a radio group; the cards say what happens with the picked option, and do nothing on the current one.
    let options: HTMLElement | undefined
    if (spec.options) {
      const templates = new Map(spec.choices.map(c => [c.id, c.consequence]))
      const apply = (): void => {
        const item = spec.options!.items.find(o => o.id === picked)
        for (const btn of choices.querySelectorAll<HTMLButtonElement>('button.choice')) {
          const text = templates.get(btn.dataset.choice!) ?? ''
          btn.querySelector('.choice-consequence')!.textContent = text.replace(/\{option\}/g, item?.label ?? '')
          btn.disabled = btn.dataset.choice !== esc && !!item?.current
        }
        choices.classList.toggle('inert', !!item?.current)
        // The cards just came alive while the focus is on the list: the default one shows its Enter hint anyway.
        choices.classList.toggle('armed', !item?.current)
      }
      options = document.createElement('fieldset'); options.className = 'options'
      const legend = document.createElement('legend'); legend.textContent = spec.options.label
      options.append(legend)
      for (const o of spec.options.items) {
        const row = document.createElement('label'); row.className = 'option'; row.dataset.option = o.id
        const input = document.createElement('input'); input.type = 'radio'; input.name = `${id}-option`; input.value = o.id; input.checked = o.id === picked
        input.addEventListener('change', () => { if (input.checked) { picked = o.id; apply() } })
        const ic = document.createElement('span'); ic.className = 'o-icon'; ic.append(iconEl(o.icon))
        const text = document.createElement('span'); text.className = 'o-text'
        const label = document.createElement('span'); label.className = 'o-label'; label.textContent = o.label
        if (o.current) { const cur = document.createElement('span'); cur.className = 'o-current'; cur.textContent = 'atual'; label.append(cur) }
        text.append(label)
        if (o.detail) { const d = document.createElement('span'); d.className = 'o-detail'; d.textContent = o.detail; d.title = o.detail; text.append(d) }
        row.append(input, ic, text)
        if (o.mark) { const m = document.createElement('span'); m.className = 'o-mark'; m.append(iconEl('shield-warning'), document.createTextNode(o.mark)); row.append(m) }
        options.append(row)
      }
      apply()
    }

    const foot = document.createElement('footer')
    if (spec.remember) {
      const defs = [{ ...spec.remember, name: 'remember' }, ...(spec.rememberAlso ? [{ ...spec.rememberAlso, name: 'remember-also' }] : [])]
      const group = document.createElement('div'); group.className = 'remembers'
      for (const def of defs) {
        const lbl = document.createElement('label'); lbl.className = 'remember'
        const box = document.createElement('input'); box.type = 'checkbox'; box.name = def.name
        // The boxes remember opposite answers: never both.
        box.addEventListener('change', () => { if (box.checked) for (const r of remembers) if (r.box !== box) r.box.checked = false })
        remembers.push({ box, choice: def.choice })
        lbl.append(box, document.createTextNode(def.label))
        group.append(lbl)
      }
      foot.append(group)
    }
    const spacer = document.createElement('span'); spacer.className = 'spacer'; foot.append(spacer)
    if (spec.cancelLabel) {
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'cancel'; cancel.dataset.choice = 'cancel'
      const kbd = document.createElement('kbd'); kbd.textContent = 'Esc'; kbd.setAttribute('aria-hidden', 'true')
      cancel.append(document.createTextNode(spec.cancelLabel + ' '), kbd)
      cancel.addEventListener('click', () => finish('cancel'))
      foot.append(cancel)
    }

    const onKey = (ev: KeyboardEvent): void => {
      const target = ev.target as HTMLElement
      // Arrows inside the option list move the radio selection (native); they rove the cards everywhere else.
      if (!(target instanceof HTMLInputElement) && roveWithArrows(choices, ev)) return
      if (ev.key === 'Enter') {
        if (target instanceof HTMLButtonElement) return // the focused card/button takes it (native click)
        ev.preventDefault()
        const card = def ? choices.querySelector<HTMLButtonElement>(`button.choice[data-choice="${CSS.escape(def)}"]`) : undefined
        if (def && !card?.disabled) finish(def)
      }
    }
    dlg.addEventListener('keydown', onKey)
    // Esc: the browser raises `cancel` on a modal dialog and would close it on its own; it is ours.
    dlg.addEventListener('cancel', ev => { ev.preventDefault(); finish(esc ?? 'cancel') })

    dlg.append(head, desc)
    if (options) dlg.append(options)
    dlg.append(choices)
    if (spec.remember || spec.cancelLabel) dlg.append(foot)
    host.append(dlg)
    dlg.showModal()
    const first = def ? choices.querySelector<HTMLButtonElement>(`button.choice[data-choice="${CSS.escape(def)}"]`) : choices.querySelector<HTMLButtonElement>('button.choice')
    // With an option list whose cards are inert (the current option is picked), the list is what needs the user first.
    if (first && !first.disabled) first.focus()
    else options?.querySelector<HTMLInputElement>('input:checked')?.focus()
  })
}

/** True while an in-app dialog is open (app shortcuts stay quiet). */
export function dialogOpen(): boolean {
  return document.querySelector('dialog.ask[open]') !== null
}
