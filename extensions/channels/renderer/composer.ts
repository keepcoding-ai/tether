// The speaking box of the channel's pane (slice U1b): "falar como moderador · para [todos ▾]", a text field, Enter sends,
// Shift+Enter breaks the line. The recipient is an address, not a lock (P8): everyone hears, `to` only marks who it speaks to.
// The line comes back through the channel's `line` event; this file only asks `say` and keeps the text when the ask fails.
import { glyph } from './glyphs.ts'
import { addresseesOf, applyMention, filterMentionOptions, mentionToken, mentionTrigger, type MentionOption, type MentionTrigger } from './mentions.ts'
import { MENTION_TEXT } from './texts.ts'

export interface ComposerOptions {
  /** Asks the daemon's `say`; rejects with the daemon's error. */
  send(text: string, to: string[]): Promise<void>
}

/** What a test reads of the box. */
export interface ComposerSnapshot {
  text: string; picked: string; options: string[]; error: string; busy: boolean
  /** False while nobody is in the channel to hear (the field and the send button are off); true once a member is. */
  enabled: boolean
  /** The field's placeholder as drawn. */
  placeholder: string
  /** What a screen reader says of the field (it says why it is off) and the live note that announces the switch. */
  label: string
  note: string
  /** The "@" list: whether it is open, its rows (name and discreet mark) and the highlighted one. */
  mention: { open: boolean; rows: Array<{ name: string; mark: string }>; active: number }
}

/** The field's placeholders: the usual one, and the one while nobody is in the channel to hear. */
export const SAY_PLACEHOLDER = { on: 'Escreva para o canal…', off: 'Escreva para o canal… ninguém ouve ainda' } as const
/** The field's accessible name, and what is announced when it goes off (a disabled field cannot take the focus to say it itself). */
export const SAY_LABEL = { on: 'Mensagem para o canal', off: 'Mensagem para o canal, desligada: ninguém ouve ainda' } as const
export const SAY_OFF_NOTE = 'A caixa de fala está desligada: ninguém ouve ainda. Junte um agente para falar.'

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
  /** A discreet mark per member name for the "@" list ("calado", "não ouve agora"); a name without one has none. */
  setMarks(marks: ReadonlyMap<string, string>): void
  /** How many members hear the channel: with none the box is off (its draft is kept), with one or more it is on. */
  setAudience(n: number): void
  snapshot(): ComposerSnapshot
  focus(): void
  /** Puts the member as the recipient ("para …") and focuses the field; a name nobody in the box answers to is ignored. */
  address(name: string): void
}

let composerSeq = 0

/** Where the caret is, as pixels inside the box's offset parent: a hidden copy of the field's text up to the `@`, measured at a marker. */
function caretSpot(field: HTMLTextAreaElement, index: number): { left: number; top: number } {
  const cs = getComputedStyle(field)
  const mirror = document.createElement('div')
  for (const p of ['boxSizing', 'width', 'padding', 'border', 'font', 'letterSpacing', 'lineHeight', 'whiteSpace', 'overflowWrap', 'wordBreak'] as const) mirror.style[p] = cs[p]
  mirror.style.whiteSpace = 'pre-wrap'
  mirror.style.overflowWrap = 'break-word'
  mirror.style.position = 'absolute'
  mirror.style.visibility = 'hidden'
  mirror.style.top = '0'
  mirror.style.left = '-9999px'
  const marker = document.createElement('span')
  marker.textContent = '@'
  mirror.append(document.createTextNode(field.value.slice(0, index)), marker)
  document.body.append(mirror)
  const spot = { left: field.offsetLeft + marker.offsetLeft - field.scrollLeft, top: field.offsetTop + marker.offsetTop - field.scrollTop }
  mirror.remove()
  return spot
}

export function createComposer(opts: ComposerOptions): Composer {
  const element = el('div', 'ch-say')
  const head = el('div', 'ch-say-to')
  const pick = el('select', 'ch-dsel')
  pick.setAttribute('aria-label', 'Destinatário')
  const field = el('textarea', 'ch-field')
  field.rows = 2
  field.placeholder = SAY_PLACEHOLDER.on
  field.setAttribute('aria-label', SAY_LABEL.on)
  // Always there (a live region must exist before its text changes); empty while the box is on. Visually hidden: the placeholder says it to the eyes.
  const note = el('div', 'ch-sr')
  note.setAttribute('role', 'status')
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
  head.append('falar como ', who, ' · para ', pick)
  row.append(hint, el('span', 'ch-say-sp'), sendBtn)
  // The "@" list floats over the box, anchored on the caret; the field keeps the focus and points at the active row.
  const listId = `ch-mention-${++composerSeq}`
  const list = el('ul', 'ch-mention-list')
  list.id = listId
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', MENTION_TEXT.listLabel)
  list.hidden = true
  field.setAttribute('aria-autocomplete', 'list')
  element.append(head, field, note, error, row, list)

  let names: readonly string[] = []
  let marks: ReadonlyMap<string, string> = new Map()
  let options: MentionOption[] = []
  let active = 0
  let trigger: MentionTrigger | undefined
  /** The `@` the person dismissed with Esc: the list stays shut for it until the text moves to another `@`. */
  let dismissedAt = -1
  let busy = false
  let enabled = true

  const paintEnabled = (): void => {
    field.disabled = !enabled
    pick.disabled = !enabled
    sendBtn.disabled = !enabled || busy
    field.placeholder = enabled ? SAY_PLACEHOLDER.on : SAY_PLACEHOLDER.off
    field.setAttribute('aria-label', enabled ? SAY_LABEL.on : SAY_LABEL.off)
    note.textContent = enabled ? '' : SAY_OFF_NOTE
    sendBtn.title = enabled ? '' : 'Ninguém ouve ainda'
    head.hidden = !enabled
    element.classList.toggle('off', !enabled)
  }

  const paintPick = (): void => {
    const was = pick.value
    pick.replaceChildren(new Option('todos', ''), ...names.map(n => new Option(n, n)))
    pick.value = names.includes(was) ? was : ''
  }
  paintPick()

  const submit = async (): Promise<void> => {
    const text = field.value.trim()
    if (text === '' || busy || !enabled) return
    busy = true
    sendBtn.disabled = true
    error.hidden = true
    try {
      await opts.send(text, addresseesOf(pick.value, text, names))
      field.value = ''
      pick.value = ''
    } catch (e) {
      error.textContent = `Não consegui enviar: ${(e as Error).message}`
      error.hidden = false
    }
    busy = false
    paintEnabled()
    if (enabled) field.focus()
  }

  const isOpen = (): boolean => !list.hidden

  const close = (): void => {
    list.hidden = true
    list.replaceChildren()
    options = []
    trigger = undefined
    field.removeAttribute('aria-activedescendant')
    field.removeAttribute('aria-controls')
  }

  const paintActive = (): void => {
    list.querySelectorAll('[role="option"]').forEach((o, i) => o.setAttribute('aria-selected', String(i === active)))
    const cur = list.children[active] as HTMLElement | undefined
    if (cur) { field.setAttribute('aria-activedescendant', cur.id); cur.scrollIntoView?.({ block: 'nearest' }) } else field.removeAttribute('aria-activedescendant')
  }

  const place = (): void => {
    if (!trigger) return
    const spot = caretSpot(field, trigger.start)
    const w = list.offsetWidth
    list.style.left = `${Math.max(0, Math.min(spot.left, element.clientWidth - w - 8))}px`
    // Above the caret's line: the box sits at the foot of the pane, so there is no room below it.
    list.style.bottom = `${Math.max(0, element.clientHeight - spot.top + 2)}px`
  }

  const choose = (i: number): void => {
    const o = options[i]
    if (!o || !trigger) return
    const next = applyMention(field.value, trigger, field.selectionStart, mentionToken(o.name, names))
    field.value = next.text
    field.setSelectionRange(next.caret, next.caret)
    close()
    dismissedAt = -1
    error.hidden = true
    field.focus()
  }

  /** Opens, refreshes or closes the list for the `@` the caret is in. */
  const refresh = (): void => {
    const t = enabled && field.selectionStart === field.selectionEnd ? mentionTrigger(field.value, field.selectionStart) : undefined
    if (!t) { dismissedAt = -1; close(); return }
    if (t.start === dismissedAt) { close(); return }
    const found = filterMentionOptions(t.term, names)
    if (found.length === 0) { close(); return }
    const same = trigger !== undefined && trigger.start === t.start && isOpen()
    trigger = t
    options = found
    if (!same || active >= found.length) active = 0
    list.replaceChildren(...found.map((o, i) => {
      const li = el('li', `ch-mention-opt${o.all ? ' all' : ''}`)
      li.id = `${listId}-${i}`
      li.setAttribute('role', 'option')
      li.append(el('span', 'ch-mention-name', o.all ? MENTION_TEXT.everyone : o.name))
      const mark = o.all ? '' : marks.get(o.name) ?? ''
      if (mark !== '') li.append(el('span', 'ch-mention-mark', mark))
      // mousedown would blur the field; the choice is taken on click.
      li.addEventListener('mousedown', ev => ev.preventDefault())
      li.addEventListener('click', () => choose(i))
      return li
    }))
    list.hidden = false
    field.setAttribute('aria-controls', listId)
    paintActive()
    place()
  }

  field.addEventListener('keydown', ev => {
    if (isOpen() && !ev.isComposing) {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault()
        active = (active + (ev.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length
        paintActive()
        return
      }
      if ((ev.key === 'Enter' && !ev.shiftKey) || ev.key === 'Tab') { ev.preventDefault(); choose(active); return }
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); dismissedAt = trigger?.start ?? -1; close(); return }
    }
    if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing) return
    ev.preventDefault()
    void submit()
  })
  field.addEventListener('input', () => { error.hidden = true; refresh() })
  field.addEventListener('keyup', ev => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) refresh() })
  field.addEventListener('click', refresh)
  field.addEventListener('blur', () => { close() })
  sendBtn.addEventListener('click', () => void submit())

  return {
    element,
    setMembers(next) {
      if (next.length === names.length && next.every((n, i) => n === names[i])) return
      names = next
      paintPick()
    },
    setMarks(next) { marks = next },
    setAudience(n) {
      const next = n > 0
      if (next === enabled) return
      enabled = next
      paintEnabled()
    },
    snapshot: () => ({
      text: field.value, picked: pick.value, options: [...pick.options].map(o => o.value), error: error.hidden ? '' : error.textContent ?? '', busy,
      enabled, placeholder: field.placeholder, label: field.getAttribute('aria-label') ?? '', note: note.textContent ?? '',
      mention: {
        open: isOpen(),
        rows: [...list.children].map(li => ({ name: li.querySelector('.ch-mention-name')?.textContent ?? '', mark: li.querySelector('.ch-mention-mark')?.textContent ?? '' })),
        active,
      },
    }),
    focus: () => field.focus(),
    address(name) {
      if (!enabled || !names.includes(name)) return
      pick.value = name
      field.focus()
    },
  }
}
