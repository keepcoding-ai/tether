// The speaking box of the channel's pane (slice U1b): "falar como moderador · para [todos ▾]", a text field, Enter sends,
// Shift+Enter breaks the line. The recipient is an address, not a lock (P8): everyone hears, `to` only marks who it speaks to.
// The line comes back through the channel's `line` event; this file only asks `say` and keeps the text when the ask fails.
import { engineOf } from '../../../app/renderer/agent-ui.ts'
import { ICON_NAMES, type IconName } from '../../../app/renderer/icons.ts'
import { glyph } from './glyphs.ts'
import { addresseesOf, applyPick, filterChannelOptions, filterMentionOptions, HASH_TEXT, listTrigger, mentionToken, type ChannelChoice, type ListTrigger } from './mentions.ts'
import { createPollForm, type PollFormSnapshot } from './poll-form.ts'
import { pollCommand, type PollArgs, type PollMember } from './poll-form-rules.ts'
import { MENTION_TEXT } from './texts.ts'
import type { FileSource } from '../attachments.ts'
import { CLIP_TITLE, createAttachBox, type AttachDeps, type AttachSnapshot } from './attach-box.ts'

export interface ComposerOptions {
  /** Opening a poll from the box (E4): the members the form may call, and the daemon's `poll`. Absent: no button, `/enquete` is a speech. */
  poll?: { members(): readonly PollMember[]; open(args: PollArgs): Promise<void> }
  /** Asks the daemon's `say` (with the files that went in, when any); rejects with the daemon's error. */
  send(text: string, to: string[], files?: FileSource[]): Promise<void>
  /** Attaching files (A1): the clip and pasting. Absent: neither. */
  attach?: AttachDeps
  /** The open channels the "#" list offers, read when the list opens (the current one is marked). */
  channels?(): readonly ChannelChoice[]
}

/** One row of whichever list is open: its text, the discreet mark and what goes after the mark when it is picked. */
interface Row { label: string; mark: string; token: string; all: boolean; /** The member's engine (its agent kind), when the app knows it. */ kind?: string | undefined }

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
  /** The "@" or "#" list: whether it is open, which mark opened it, its rows (name and discreet mark) and the highlighted one. */
  mention: { open: boolean; mark: '@' | '#' | ''; rows: Array<{ name: string; mark: string }>; active: number }
  /** The poll form pinned above the box (E4). */
  poll: PollFormSnapshot
  /** The files on the speech (A1): chips, the reasons a file did not go in, the room's warning; whether the clip is there. */
  attach: AttachSnapshot & { clip: boolean }
}

/** The field's placeholder while the speech has a file: the text is optional then. */
export const SAY_PLACEHOLDER_FILES = 'Escreva para o canal… (opcional com anexo)'

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
  /** The engine (agent kind: 'claude', 'soul'…) per member name: the "@" list draws its icon in a fixed column before the name. */
  setEngines(kinds: ReadonlyMap<string, string>): void
  /** How many members hear the channel: with none the box is off (its draft is kept), with one or more it is on. */
  setAudience(n: number): void
  snapshot(): ComposerSnapshot
  focus(): void
  /** Puts the member as the recipient ("para …") and focuses the field; a name nobody in the box answers to is ignored. */
  address(name: string): void
  /** Opens the poll form above the box (the draft in the field stays); `question` pre-fills it. */
  openPoll(question?: string): void
  /** Files dropped on the pane (A3): chips by the paste's road; 'off' while nobody hears (the box is off), 'no-file' when nothing dropped is a file on disk. */
  drop(dt: DataTransfer): 'added' | 'off' | 'no-file'
}

let composerSeq = 0

/** The fixed column of the "@" list that holds an engine's icon (named by title and label); an empty column of the same width when there is none. */
function engineCell(kind: string | undefined): HTMLElement {
  const cell = el('span', 'ch-mention-eng')
  if (kind === undefined) { cell.setAttribute('aria-hidden', 'true'); return cell }
  const e = engineOf(kind)
  cell.append(glyph((ICON_NAMES as readonly string[]).includes(e.icon) ? e.icon as IconName : 'robot'))
  cell.title = e.label
  cell.setAttribute('role', 'img')
  cell.setAttribute('aria-label', e.label)
  cell.dataset.engine = kind
  return cell
}

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
  // The poll: a button next to "Enviar" and the form pinned above the whole box. The box and its draft are not touched by it.
  const pollBtn = el('button', 'ch-pollbtn')
  pollBtn.type = 'button'
  pollBtn.append(glyph('chart-bar'), document.createTextNode('Enquete'))
  pollBtn.title = 'Abrir enquete (/enquete)'
  const form = createPollForm({
    members: () => opts.poll?.members() ?? [],
    open: args => opts.poll!.open(args),
    closed: () => { if (enabled) field.focus() },
  })
  // The files (A1): the clip at the left of the row (the menu path of pasting) and the chips above the head.
  const clipBtn = el('button', 'ch-act ch-clip')
  clipBtn.type = 'button'
  clipBtn.title = CLIP_TITLE
  clipBtn.setAttribute('aria-label', 'Anexar arquivo')
  clipBtn.append(glyph('paperclip'))
  const box = opts.attach ? createAttachBox(opts.attach, () => paintFiles()) : undefined
  row.append(...(box ? [clipBtn] : []), hint, el('span', 'ch-say-sp'), ...(opts.poll ? [pollBtn] : []), sendBtn)
  // The "@" list floats over the box, anchored on the caret; the field keeps the focus and points at the active row.
  const listId = `ch-mention-${++composerSeq}`
  const list = el('ul', 'ch-mention-list')
  list.id = listId
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', MENTION_TEXT.listLabel)
  list.hidden = true
  field.setAttribute('aria-autocomplete', 'list')
  element.append(...(opts.poll ? [form.element] : []), ...(box?.parts ?? []), head, field, note, error, row, list)

  let names: readonly string[] = []
  let marks: ReadonlyMap<string, string> = new Map()
  let engines: ReadonlyMap<string, string> = new Map()
  let options: Row[] = []
  let active = 0
  let trigger: ListTrigger | undefined
  /** The `@` the person dismissed with Esc: the list stays shut for it until the text moves to another `@`. */
  let dismissedAt = -1
  let busy = false
  let enabled = true

  const paintEnabled = (): void => {
    field.disabled = !enabled
    pick.disabled = !enabled
    sendBtn.disabled = !enabled || busy
    pollBtn.disabled = !enabled
    clipBtn.disabled = !enabled
    if (!enabled) form.hide()
    field.placeholder = !enabled ? SAY_PLACEHOLDER.off : box && box.count() > 0 ? SAY_PLACEHOLDER_FILES : SAY_PLACEHOLDER.on
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

  /** The chips changed: the placeholder says the text is optional while there is a file. */
  function paintFiles(): void { if (enabled) paintEnabled() }

  const submit = async (): Promise<void> => {
    const text = field.value.trim()
    const files = box?.sources() ?? []
    if ((text === '' && files.length === 0) || busy || !enabled) return
    // `/enquete` is the command of the poll form, not a speech: the command is consumed, a question after it goes into the form.
    const asked = opts.poll && files.length === 0 ? pollCommand(text) : undefined
    if (asked) { field.value = ''; error.hidden = true; close(); form.show(asked.question); return }
    busy = true
    sendBtn.disabled = true
    error.hidden = true
    try {
      await opts.send(text, addresseesOf(pick.value, text, names), ...(files.length ? [files] : []))
      field.value = ''
      pick.value = ''
      box?.sent()
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
    const next = applyPick(field.value, trigger, field.selectionStart, o.token, trigger.mark)
    field.value = next.text
    field.setSelectionRange(next.caret, next.caret)
    close()
    dismissedAt = -1
    error.hidden = true
    field.focus()
  }

  /** The rows the trigger asks for: the members for `@` ("todos" first), the open channels for `#`. */
  const rowsFor = (t: ListTrigger): Row[] => t.mark === '@'
    ? filterMentionOptions(t.term, names).map(o => ({
      label: o.all ? MENTION_TEXT.everyone : o.name, mark: o.all ? '' : marks.get(o.name) ?? '', token: mentionToken(o.name, names), all: o.all, kind: o.all ? undefined : engines.get(o.name),
    }))
    : filterChannelOptions(t.term, opts.channels?.() ?? []).map(c => ({ label: `#${c.name}`, mark: c.current ? HASH_TEXT.current : '', token: c.name, all: false }))

  /** Opens, refreshes or closes the list for the `@` or `#` the caret is in. */
  const refresh = (): void => {
    const t = enabled && field.selectionStart === field.selectionEnd ? listTrigger(field.value, field.selectionStart) : undefined
    if (!t) { dismissedAt = -1; close(); return }
    if (t.start === dismissedAt) { close(); return }
    const found = rowsFor(t)
    if (found.length === 0) { close(); return }
    const same = trigger !== undefined && trigger.start === t.start && trigger.mark === t.mark && isOpen()
    trigger = t
    options = found
    list.setAttribute('aria-label', t.mark === '@' ? MENTION_TEXT.listLabel : HASH_TEXT.listLabel)
    if (!same || active >= found.length) active = 0
    list.replaceChildren(...found.map((o, i) => {
      const li = el('li', `ch-mention-opt${o.all ? ' all' : ''}`)
      li.id = `${listId}-${i}`
      li.setAttribute('role', 'option')
      // The "@" list of members: the engine's icon in a fixed column, empty for "todos" and for a member whose engine is unknown.
      if (t.mark === '@') li.append(engineCell(o.kind))
      li.append(el('span', 'ch-mention-name', o.label))
      if (o.mark !== '') li.append(el('span', 'ch-mention-mark', o.mark))
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
  clipBtn.addEventListener('click', () => { if (enabled && box) void box.pick().finally(() => field.focus()) })
  // Ctrl+V of a print or of copied files: chips, and the focus stays in the field. Plain text pastes as always.
  field.addEventListener('paste', ev => { if (enabled && box?.paste(ev)) ev.preventDefault() })
  pollBtn.addEventListener('click', () => form.show())

  return {
    element,
    setMembers(next) {
      if (next.length === names.length && next.every((n, i) => n === names[i])) return
      names = next
      paintPick()
    },
    setMarks(next) { marks = next },
    setEngines(next) { engines = next },
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
        mark: isOpen() ? trigger?.mark ?? '' : '',
        rows: [...list.children].map(li => ({ name: li.querySelector('.ch-mention-name')?.textContent ?? '', mark: li.querySelector('.ch-mention-mark')?.textContent ?? '' })),
        active,
      },
      poll: form.snapshot(),
      attach: { ...(box?.snapshot() ?? { chips: [], notes: [], room: '' }), clip: box !== undefined },
    }),
    openPoll(question) { if (enabled && opts.poll) form.show(question) },
    drop(dt) {
      if (!enabled || !box) return 'off'
      return box.drop(dt) ? 'added' : 'no-file'
    },
    focus: () => field.focus(),
    address(name) {
      if (!enabled || !names.includes(name)) return
      pick.value = name
      field.focus()
    },
  }
}
