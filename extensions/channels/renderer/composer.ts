// The speaking box of the channel's pane (slice U1b): "falar como moderador · para [todos ▾]", a text field, Enter sends,
// Shift+Enter breaks the line. The recipient is an address, not a lock (P8): everyone hears, `to` only marks who it speaks to.
// The line comes back through the channel's `line` event; this file only asks `say` and keeps the text when the ask fails.
import { glyph } from './glyphs.ts'
import { addresseesOf } from './mentions.ts'

export interface ComposerOptions {
  /** Asks the daemon's `say`; rejects with the daemon's error. */
  send(text: string, to: string[]): Promise<void>
}

/** What a test reads of the box. */
export interface ComposerSnapshot { text: string; picked: string; options: string[]; error: string; busy: boolean }

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

export interface Composer {
  readonly element: HTMLElement
  /** The display names of the members the box may address (the person's own box never lists the person). */
  setMembers(names: readonly string[]): void
  snapshot(): ComposerSnapshot
  focus(): void
}

export function createComposer(opts: ComposerOptions): Composer {
  const element = el('div', 'ch-say')
  const head = el('div', 'ch-say-to')
  const pick = el('select', 'ch-dsel')
  pick.setAttribute('aria-label', 'Destinatário')
  const field = el('textarea', 'ch-field')
  field.rows = 2
  field.placeholder = 'Escreva para o canal…'
  field.setAttribute('aria-label', 'Mensagem para o canal')
  const error = el('div', 'ch-say-error')
  error.setAttribute('role', 'alert')
  error.hidden = true
  const row = el('div', 'ch-say-row')
  const hint = el('span', 'ch-say-hint')
  const kbd = (t: string): HTMLElement => el('kbd', '', t)
  hint.append(kbd('Enter'), ' envia · ', kbd('Shift'), '+', kbd('Enter'), ' nova linha')
  const sendBtn = el('button', 'ch-send')
  sendBtn.type = 'button'
  sendBtn.append(glyph('paper-plane-tilt'), document.createTextNode('Enviar'))
  const who = el('span', 'ch-role mod', 'moderador')
  head.append('falar como ', who, ' · para ', pick, el('span', 'ch-say-or', 'ou escolha um membro'))
  row.append(hint, el('span', 'ch-say-sp'), sendBtn)
  element.append(head, field, error, row)

  let names: readonly string[] = []
  let busy = false

  const paintPick = (): void => {
    const was = pick.value
    pick.replaceChildren(new Option('todos', ''), ...names.map(n => new Option(n, n)))
    pick.value = names.includes(was) ? was : ''
  }
  paintPick()

  const submit = async (): Promise<void> => {
    const text = field.value.trim()
    if (text === '' || busy) return
    busy = true
    sendBtn.disabled = true
    error.hidden = true
    try {
      await opts.send(text, addresseesOf(pick.value, text, names))
      field.value = ''
    } catch (e) {
      error.textContent = `Não consegui enviar: ${(e as Error).message}`
      error.hidden = false
    }
    busy = false
    sendBtn.disabled = false
    field.focus()
  }

  field.addEventListener('keydown', ev => {
    if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing) return
    ev.preventDefault()
    void submit()
  })
  field.addEventListener('input', () => { error.hidden = true })
  sendBtn.addEventListener('click', () => void submit())

  return {
    element,
    setMembers(next) {
      if (next.length === names.length && next.every((n, i) => n === names[i])) return
      names = next
      paintPick()
    },
    snapshot: () => ({ text: field.value, picked: pick.value, options: [...pick.options].map(o => o.value), error: error.hidden ? '' : error.textContent ?? '', busy }),
    focus: () => field.focus(),
  }
}
