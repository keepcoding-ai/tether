// The in-app dialog (app/shared/dialog.ts): a <dialog> over the whole window with a fixed structure —
// situation (icon, title, message), context (which panel, which state), choices as cards (action +
// consequence, coloured by tone), footer (remember box, cancel). Modal: the rest of the page is inert,
// focus stays inside, Esc cancels, Enter takes the default (never a destructive choice), arrows move
// between cards. Also exports the choice-card renderer, shared with the panel overlays.
import type { ChoiceTone, DialogAnswer, DialogChoice, DialogSpec } from '../shared/dialog.ts'
import { icon, ICON_NAMES, type IconName } from './icons.ts'

const ICON_SET = new Set<string>(ICON_NAMES)

/** The spec names icons as strings (shared types); an unknown name falls back to a neutral mark. */
function iconEl(name: string): SVGSVGElement {
  return icon((ICON_SET.has(name) ? name : 'question') as IconName)
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
      ctx.append(icon, text)
      if (spec.context.status) {
        const st = document.createElement('span'); st.className = `ctx-status ${spec.context.status.tone}`; st.textContent = spec.context.status.label
        ctx.append(st)
      }
      desc.append(ctx)
    }

    let remember: HTMLInputElement | undefined
    const finish = (choice: string): void => {
      dlg.removeEventListener('keydown', onKey)
      dlg.close()
      dlg.remove()
      resolve({ choice, remember: remember?.checked ?? false })
    }

    const def = defaultChoice(spec)
    const esc = spec.choices.find(c => c.id === spec.escChoice && c.tone !== 'destructive')?.id
    const choices = renderChoices(spec.choices, finish, { defaultId: def, escId: esc })

    const foot = document.createElement('footer')
    if (spec.remember) {
      const lbl = document.createElement('label'); lbl.className = 'remember'
      remember = document.createElement('input'); remember.type = 'checkbox'; remember.name = 'remember'
      lbl.append(remember, document.createTextNode(spec.remember.label))
      foot.append(lbl)
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
      if (roveWithArrows(choices, ev)) return
      if (ev.key === 'Enter') {
        const target = ev.target as HTMLElement
        if (target instanceof HTMLButtonElement) return // the focused card/button takes it (native click)
        ev.preventDefault()
        if (def) finish(def)
      }
    }
    dlg.addEventListener('keydown', onKey)
    // Esc: the browser raises `cancel` on a modal dialog and would close it on its own; it is ours.
    dlg.addEventListener('cancel', ev => { ev.preventDefault(); finish(esc ?? 'cancel') })

    dlg.append(head, desc, choices)
    if (spec.remember || spec.cancelLabel) dlg.append(foot)
    host.append(dlg)
    dlg.showModal()
    const first = def ? choices.querySelector<HTMLButtonElement>(`button.choice[data-choice="${CSS.escape(def)}"]`) : choices.querySelector<HTMLButtonElement>('button.choice')
    first?.focus()
  })
}

/** True while an in-app dialog is open (app shortcuts stay quiet). */
export function dialogOpen(): boolean {
  return document.querySelector('dialog.ask[open]') !== null
}
