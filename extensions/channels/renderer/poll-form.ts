// The form that opens a poll (slice E4), pinned above the speaking box: question, kind (ok / não ok, or a choice of 2 to 6), who votes,
// the deadline, the warning of who does not hear now. Enter opens, Esc cancels and gives the focus back to the box. The limits are
// checked here (poll-form-rules.ts); the tether's refusals come back as a warning in the form and nothing typed is lost.
import { glyph } from './glyphs.ts'
import {
  DEADLINES, deafOf, deafText, deadlineMs, emptyDraft, footText, POLL_OPTIONS_MAX, POLL_OPTIONS_MIN, refusalText, validateDraft,
  type DeadlineId, type PollArgs, type PollDraft, type PollMember,
} from './poll-form-rules.ts'

export interface PollFormOptions {
  /** The members the form may call (read each time the form opens). */
  members(): readonly PollMember[]
  /** Asks the daemon to open the poll; rejects with the daemon's error (its `code` says why). */
  open(args: PollArgs): Promise<void>
  /** The form closed (Esc, cancel, or the poll opened): the box takes the focus back. */
  closed(): void
}

/** What a test reads of the form. */
export interface PollFormSnapshot {
  open: boolean
  question: string
  kind: 'ok' | 'choice'
  options: string[]
  /** The agents ticked (names), and whether "incluir você" is on. */
  called: string[]
  includeYou: boolean
  deadline: DeadlineId
  other: string
  deaf: string
  error: string
  foot: string
  busy: boolean
  /** The field the focus is in. */
  focus: string
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

const codeOf = (e: unknown): string => (e !== null && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : 'unknown')

let formSeq = 0

export interface PollForm {
  readonly element: HTMLElement
  /** Opens the form (a question may come typed after `/enquete`). Already open: keeps what is there and takes the focus. */
  show(question?: string): void
  hide(): void
  isOpen(): boolean
  snapshot(): PollFormSnapshot
}

export function createPollForm(opts: PollFormOptions): PollForm {
  const id = `ch-pf-${++formSeq}`
  const root = el('div', 'ch-pf')
  root.hidden = true
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', 'Nova enquete')

  let members: readonly PollMember[] = []
  let draft: PollDraft = emptyDraft()
  let busy = false
  let error = ''
  // Fields that were touched: an empty field says nothing before the person tried to open.
  let tried = false

  const head = el('h4', 'ch-pf-head')
  head.append(glyph('chart-bar'), 'Nova enquete')
  const esc = el('span', 'ch-pf-x')
  const kbd = el('kbd', '', 'Esc')
  esc.append(kbd, ' cancela')
  head.append(esc)

  const row = (label: string, forId?: string): { line: HTMLElement; body: HTMLElement } => {
    const line = el('div', 'ch-pf-row')
    const l = el(forId ? 'label' : 'span', 'ch-pf-lbl', label)
    if (forId) (l as HTMLLabelElement).htmlFor = forId
    const body = el('div', 'ch-pf-body')
    line.append(l, body)
    return { line, body }
  }

  // question
  const q = el('input', 'ch-pf-q')
  q.type = 'text'
  q.id = `${id}-q`
  q.placeholder = 'O que você quer saber?'
  q.autocomplete = 'off'
  const qRow = row('Pergunta', q.id)
  qRow.body.append(q)
  const qErr = el('div', 'ch-pf-fe')
  qRow.body.append(qErr)

  // kind
  const kinds = el('div', 'ch-pf-seg')
  kinds.setAttribute('role', 'radiogroup')
  kinds.setAttribute('aria-label', 'Tipo da enquete')
  const kindBtn = (kind: 'ok' | 'choice', label: string): HTMLButtonElement => {
    const b = el('button', 'ch-pf-kind', label)
    b.type = 'button'
    b.dataset.kind = kind
    b.setAttribute('role', 'radio')
    b.addEventListener('click', () => { draft = { ...draft, kind }; paint(); if (kind === 'choice') focusOption(0) })
    return b
  }
  const okBtn = kindBtn('ok', 'ok / não ok')
  const choiceBtn = kindBtn('choice', 'escolha entre opções')
  kinds.append(okBtn, choiceBtn)
  const kRow = row('Tipo')
  kRow.body.append(kinds)

  // options (choice only)
  const optList = el('div', 'ch-pf-opts')
  const addOpt = el('button', 'ch-pf-add')
  addOpt.type = 'button'
  addOpt.append(glyph('plus'), 'opção')
  addOpt.addEventListener('click', () => {
    if (draft.options.length >= POLL_OPTIONS_MAX) return
    draft = { ...draft, options: [...draft.options, ''] }
    paint()
    focusOption(draft.options.length - 1)
  })
  const oErr = el('div', 'ch-pf-fe')
  const oRow = row('Opções')
  oRow.body.append(optList, addOpt, oErr)

  // who votes
  const chips = el('div', 'ch-pf-chips')
  chips.setAttribute('role', 'group')
  chips.setAttribute('aria-label', 'Quem vota')
  const wRow = row('Quem vota')
  const wErr = el('div', 'ch-pf-fe')
  wRow.body.append(chips, wErr)

  // deadline
  const dls = el('div', 'ch-pf-seg')
  dls.setAttribute('role', 'radiogroup')
  dls.setAttribute('aria-label', 'Prazo')
  const dlBtn = (idv: DeadlineId, label: string): HTMLButtonElement => {
    const b = el('button', 'ch-pf-dl', label)
    b.type = 'button'
    b.dataset.dl = idv
    b.setAttribute('role', 'radio')
    b.addEventListener('click', () => { draft = { ...draft, deadline: idv }; paint(); if (idv === 'other') other.focus() })
    return b
  }
  const dlBtns = [...DEADLINES.map(d => dlBtn(d.id, d.label)), dlBtn('other', 'outro…')]
  dls.append(...dlBtns)
  const other = el('input', 'ch-pf-other')
  other.type = 'text'
  other.placeholder = 'min (ex.: 1, 90m, 2h)'
  other.setAttribute('aria-label', 'Prazo em minutos')
  other.autocomplete = 'off'
  other.size = 12
  other.addEventListener('input', () => { draft = { ...draft, other: other.value }; paintFoot() })
  const dRow = row('Prazo')
  const dErr = el('div', 'ch-pf-fe')
  dRow.body.append(dls, other, dErr)

  const deaf = el('div', 'ch-pf-warn')
  deaf.setAttribute('role', 'status')
  deaf.hidden = true
  const err = el('div', 'ch-pf-err')
  err.setAttribute('role', 'alert')
  err.hidden = true

  const foot = el('div', 'ch-pf-foot')
  const footText_ = el('span', 'ch-pf-foottext')
  const cancel = el('button', 'ch-pf-cancel', 'Cancelar')
  cancel.type = 'button'
  const go = el('button', 'ch-pf-go')
  go.type = 'button'
  go.append(glyph('chart-bar'), 'Abrir enquete')
  foot.append(footText_, cancel, go)

  root.append(head, qRow.line, kRow.line, oRow.line, wRow.line, dRow.line, deaf, err, foot)

  const focusOption = (i: number): void => { optList.querySelectorAll<HTMLInputElement>('.ch-pf-opt')[i]?.focus() }

  const paintOptions = (): void => {
    optList.replaceChildren(...draft.options.map((text, i) => {
      const line = el('div', 'ch-pf-optline')
      const input = el('input', 'ch-pf-opt')
      input.type = 'text'
      input.value = text
      input.autocomplete = 'off'
      input.placeholder = `Opção ${i + 1}`
      input.setAttribute('aria-label', `Opção ${i + 1}`)
      input.addEventListener('input', () => { draft = { ...draft, options: draft.options.map((o, j) => (j === i ? input.value : o)) }; paintErrors(); paintFoot() })
      line.append(input)
      if (draft.options.length > POLL_OPTIONS_MIN) {
        const rm = el('button', 'ch-pf-rm')
        rm.type = 'button'
        rm.setAttribute('aria-label', `Tirar a opção ${i + 1}`)
        rm.title = 'Tirar'
        rm.append(glyph('x'))
        rm.addEventListener('click', () => { draft = { ...draft, options: draft.options.filter((_, j) => j !== i) }; paint(); focusOption(Math.max(0, i - 1)) })
        line.append(rm)
      }
      return line
    }))
    addOpt.hidden = draft.options.length >= POLL_OPTIONS_MAX
  }

  const paintChips = (): void => {
    const mk = (who: string, label: string, on: boolean, you: boolean): HTMLButtonElement => {
      const b = el('button', `ch-pf-chip${on ? ' on' : ''}${you ? ' you' : ''}`)
      b.type = 'button'
      b.dataset.who = who
      b.setAttribute('aria-pressed', String(on))
      b.append(el('span', 'ch-pf-chip-box', on ? '✓' : ''), label)
      b.addEventListener('click', () => {
        draft = you
          ? { ...draft, includeYou: !draft.includeYou }
          : { ...draft, called: draft.called.includes(who) ? draft.called.filter(c => c !== who) : [...draft.called, who] }
        paint()
        chips.querySelector<HTMLElement>(`[data-who="${CSS.escape(who)}"]`)?.focus()
      })
      return b
    }
    chips.replaceChildren(
      ...members.map(m => mk(m.id, m.name, draft.called.includes(m.id), false)),
      mk('you', 'incluir você', draft.includeYou, true),
    )
  }

  const paintErrors = (): void => {
    const errors = tried ? validateDraft(draft).errors : {}
    const put = (box: HTMLElement, msg: string | undefined): void => { box.textContent = msg ?? ''; box.hidden = msg === undefined }
    put(qErr, errors.question)
    put(oErr, errors.options)
    put(wErr, errors.called)
    put(dErr, errors.deadline)
    q.setAttribute('aria-invalid', String(errors.question !== undefined))
  }

  const paintFoot = (): void => {
    const ms = deadlineMs(draft)
    const voters = draft.called.length + (draft.includeYou ? 1 : 0)
    footText_.textContent = footText(Date.now(), ms, voters)
    const gone = deafText(deafOf(members, draft.called), Date.now(), ms)
    deaf.textContent = gone
    deaf.hidden = gone === ''
    err.textContent = error
    err.hidden = error === ''
    go.disabled = busy
  }

  const paint = (): void => {
    for (const b of [okBtn, choiceBtn]) { const on = b.dataset.kind === draft.kind; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)) }
    oRow.line.hidden = draft.kind !== 'choice'
    for (const b of dlBtns) { const on = b.dataset.dl === draft.deadline; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)) }
    other.hidden = draft.deadline !== 'other'
    if (document.activeElement !== other) other.value = draft.other
    paintOptions()
    paintChips()
    paintErrors()
    paintFoot()
  }

  const hide = (): void => {
    const was = !root.hidden
    root.hidden = true
    error = ''
    busy = false
    tried = false
    if (was) opts.closed()
  }

  const submit = async (): Promise<void> => {
    if (busy) return
    tried = true
    error = ''
    const { errors, args } = validateDraft(draft)
    if (!args) {
      paintErrors()
      paintFoot()
      // The focus goes to the first field that says what is wrong.
      if (errors.question) q.focus(); else if (errors.options) focusOption(Math.max(0, draft.options.findIndex(o => o.trim() === ''))); else if (errors.deadline) other.focus()
      return
    }
    busy = true
    paintFoot()
    try {
      await opts.open(args)
      busy = false
      draft = emptyDraft()
      hide()
    } catch (e) {
      busy = false
      error = refusalText(codeOf(e))
      paintFoot()
      go.focus()
    }
  }

  root.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); hide(); return }
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && ev.target instanceof HTMLInputElement) { ev.preventDefault(); void submit() }
  })
  q.addEventListener('input', () => { draft = { ...draft, question: q.value }; paintErrors(); paintFoot() })
  cancel.addEventListener('click', () => { draft = emptyDraft(); hide() })
  go.addEventListener('click', () => void submit())

  return {
    element: root,
    show(question) {
      members = opts.members()
      if (root.hidden) {
        draft = emptyDraft(members.map(m => m.id))
        error = ''
        tried = false
      } else draft = { ...draft, called: draft.called.filter(c => members.some(m => m.id === c)) }
      if (question !== undefined && question !== '') draft = { ...draft, question }
      q.value = draft.question
      root.hidden = false
      paint()
      q.focus()
      q.setSelectionRange(q.value.length, q.value.length)
    },
    hide,
    isOpen: () => !root.hidden,
    snapshot: () => ({
      open: !root.hidden, question: q.value, kind: draft.kind, options: [...draft.options], includeYou: draft.includeYou,
      called: members.filter(m => draft.called.includes(m.id)).map(m => m.name), deadline: draft.deadline, other: draft.other,
      deaf: deaf.hidden ? '' : deaf.textContent ?? '', error: err.hidden ? '' : err.textContent ?? '', foot: footText_.textContent ?? '', busy,
      focus: (document.activeElement as HTMLElement | null)?.className ?? '',
    }),
  }
}
