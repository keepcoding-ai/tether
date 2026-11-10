// The "Sessões" popup: the place to see everything that is running and to manage it. Left: the live sessions (with a tab
// or without), grouped. Right: the selected one. Footer: without a pause, the preview of who would get the request and
// the button that asks; with a pause, "2 de 3 já pararam" and, once everyone stopped, the preview of who goes back.
//
// Without a pause the groups are the turn states (Pedem atenção, Em andamento, Ociosas; the dot is the turn: orange =
// attention, green = working, nothing = idle). With a pause the batch's sessions come first with the pause glyph (blue =
// stopping, green = stopped, grey = queued) and their timeline; the other live sessions stay in "Fora da pausa".
//
// Invariant: opening, looking and selecting never have an effect. Every effect is born from a labelled button (Abrir,
// Encerrar, Tirar da fila, Pedir pausa, Retomar, Cancelar pausa). It is a `dialog.ask`, so `dialogOpen()` keeps the
// app's shortcuts quiet. Four tiers by the window width (pause-rules tierOf): phone stacks the list over the detail with a
// fixed footer, narrow/desktop are two columns, wide scales type and spacing up. The list, the detail and nothing else
// scroll; the footer stays put. The rules live in sessions-rules.ts and pause-rules.ts; main.ts feeds the slots and the batch.
import type { SlotState } from '../../src/daemon/protocol.ts'
import type { PauseBatch, PauseEntry } from '../../src/daemon/pause.ts'
import type { RequestBody } from '../shared/api.ts'
import { agentUi } from './agent-ui.ts'
import { icon } from './icons.ts'
import {
  batchElapsedText, canRemoveEntry, canResume, entryText, entryTone, followSummary, hasBatch, tierOf, timeline,
} from './pause-rules.ts'
import {
  pausePreview, popupGroups, resolvePopupSelection, resumePreview, sessionRows, shortFolder, type SessionRow,
} from './sessions-rules.ts'

export interface SessionsDialogHost {
  slots(): Iterable<SlotState>
  batch(): PauseBatch | null
  /** A pane shows the session. */
  hasTab(slotId: string): boolean
  /** Where the session's tab is ("Mesa 1", "Gaveta"), or undefined when it has none. */
  placeOf(slotId: string): string | undefined
  /** The panel's title, or undefined when the app does not know the slot. */
  titleOf(slotId: string): string | undefined
  /** Runs the request; resolves with the error message, if any. */
  request(body: RequestBody): Promise<string | undefined>
  /** Brings the user to the session (the dialog closes first). */
  openSlot(slotId: string): void
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

interface Live {
  dlg: HTMLDialogElement
  schedule(): void
}

let live: Live | undefined

/** True while the dialog is on screen. */
export function sessionsDialogOpen(): boolean { return live !== undefined }

/** Called by main.ts on every `state` and `pause` event (and when a panel's title may have changed). */
export function refreshSessionsDialog(): void { live?.schedule() }

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

export function openSessionsDialog(host: SessionsDialogHost): void {
  if (live) { live.dlg.querySelector<HTMLElement>('.pd-row.sel, .pd-close')?.focus(); return }
  const state = { sel: undefined as string | undefined, notice: undefined as string | undefined, busy: false, stopping: new Set<string>() }

  const dlg = el('dialog', 'ask pause-dlg')
  dlg.dataset.dialog = 'sessions'
  dlg.setAttribute('aria-labelledby', 'pd-title')

  // ---- header ----
  const head = el('header')
  const badge = el('span', 'badge'); badge.append(icon('tray'))
  const title = el('h2', undefined, 'Sessões em andamento'); title.id = 'pd-title'
  const xBtn = el('button', 'pd-x pd-close'); xBtn.type = 'button'; xBtn.title = 'Fechar (Esc)'; xBtn.setAttribute('aria-label', 'Fechar'); xBtn.append(icon('x'))
  head.append(badge, title, el('span', 'spacer'), xBtn)

  // ---- body ----
  const body = el('div', 'pd-body')
  const left = el('aside', 'pd-left')
  const list = el('div', 'pd-list'); list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Sessões em andamento')
  left.append(list)
  const right = el('section', 'pd-right'); right.setAttribute('aria-live', 'polite')
  const detail = el('div', 'pd-detail')
  right.append(detail)
  body.append(left, right)

  // ---- footer ----
  const foot = el('footer', 'pd-foot')
  const sum = el('div', 'pd-sum'); sum.setAttribute('role', 'status')
  const line = el('div', 'pd-line')
  const sumMain = el('b'); const sumAge = el('span', 'pd-age')
  line.append(sumMain, sumAge)
  const prev = el('div', 'pd-prev')
  sum.append(line, prev)
  const start = el('button', 'primary pd-start'); start.type = 'button'; start.id = 'pd-pause-start'
  start.title = 'Pede a cada sessão em andamento que pare no seu passo; ninguém é interrompido'
  const cancel = el('button', 'pd-cancel'); cancel.type = 'button'; cancel.append('Cancelar pausa')
  cancel.title = 'Desfazer o pedido: as sessões seguem como estavam'
  const resume = el('button', 'primary pd-resume'); resume.type = 'button'; resume.append(icon('arrow-clockwise'), 'Retomar')
  foot.append(sum, el('span', 'spacer'), start, cancel, resume)

  dlg.append(head, body, foot)

  // ---- model ----
  interface View { rows: Map<string, SessionRow>; batch: PauseBatch | null; groups: ReturnType<typeof popupGroups> }
  function view(): View {
    const b = host.batch()
    const batch = hasBatch(b) ? b : null
    const rows = sessionRows(host.slots(), host.hasTab, Date.now())
    return { rows: new Map(rows.map(r => [r.slotId, r])), batch, groups: popupGroups(rows, batch) }
  }
  const entryOf = (v: View, slotId: string | undefined): PauseEntry | undefined => v.batch && slotId ? v.batch.entries.find(e => e.slotId === slotId && e.state !== 'removed') : undefined
  const nameOf = (v: View, slotId: string): string => host.titleOf(slotId) ?? v.rows.get(slotId)?.name ?? slotId

  /** The line under a name: a pause entry says its pause state; a session says its turn, where it is and its folder. */
  function lineOf(v: View, slotId: string, now: number): string {
    const e = entryOf(v, slotId)
    if (e) return entryText(e, now)
    const r = v.rows.get(slotId)
    if (!r) return ''
    return [r.text, host.placeOf(slotId) ?? 'sem guia', shortFolder(r.slot.cwd)].filter(Boolean).join(' · ')
  }

  // ---- drawing ----
  function drawList(v: View): void {
    const focused = list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.slot : undefined
    list.replaceChildren()
    const now = Date.now()
    for (const g of v.groups) {
      const grp = el('div', `pd-group g-${g.id}`); grp.setAttribute('role', 'group'); grp.setAttribute('aria-label', g.title)
      const gt = el('div', 'pd-gt'); gt.setAttribute('aria-hidden', 'true')
      gt.append(el('span', undefined, g.title), el('span', 'n', String(g.slotIds.length)))
      grp.append(gt)
      for (const slotId of g.slotIds) {
        const e = entryOf(v, slotId)
        const r = v.rows.get(slotId)
        const row = el('button', `pd-row ${e ? `pz ${entryTone(e)}` : `sess ${r?.state ?? 'idle'}`}`); row.type = 'button'
        row.dataset.slot = slotId
        row.setAttribute('role', 'option')
        const on = slotId === state.sel
        row.classList.toggle('sel', on)
        row.setAttribute('aria-selected', String(on))
        const mark = e ? el('span', 'pg') : el('span', 'led')
        if (e) mark.append(icon('pause'))
        const tx = el('span', 'tx')
        const cw = el('span', 'cw', lineOf(v, slotId, now)); cw.title = r?.slot.cwd ?? ''
        tx.append(el('span', 'nm', nameOf(v, slotId)), cw)
        row.append(mark, tx)
        grp.append(row)
      }
      list.append(grp)
    }
    if (focused) list.querySelector<HTMLElement>(`.pd-row[data-slot="${CSS.escape(focused)}"]`)?.focus()
  }

  /** Just the texts that depend on the clock: row lines, the pause timeline, the footer age. */
  function paintClock(v: View): void {
    const now = Date.now()
    for (const g of v.groups) for (const slotId of g.slotIds) {
      const cw = list.querySelector(`.pd-row[data-slot="${CSS.escape(slotId)}"] .cw`)
      const text = lineOf(v, slotId, now)
      if (cw && cw.textContent !== text) cw.textContent = text
    }
    sumAge.textContent = v.batch ? batchElapsedText(v.batch, now) : ''
    const e = entryOf(v, state.sel)
    const tl = detail.querySelector<HTMLElement>('.pd-tl')
    if (e && tl) tl.replaceChildren(...timelineRows(e, now))
    const cur = detail.querySelector('.pd-state')
    if (cur) cur.textContent = e ? timeline(e, now).at(-1)?.label ?? '' : cap(v.rows.get(state.sel ?? '')?.text ?? '')
  }

  function timelineRows(e: PauseEntry, now: number): HTMLElement[] {
    return timeline(e, now).map(it => {
      const li = el('li', `pd-step ${it.tone}${it.current ? ' now' : ''}`)
      li.append(el('span', 'dot'), el('span', 'what', it.label), el('time', 'clock', it.clock), el('span', 'span', it.spanText))
      if (it.current) li.setAttribute('aria-current', 'step')
      return li
    })
  }

  function note(label: string, text: string, cls: string): HTMLElement {
    const box = el('div', `pd-note ${cls}`)
    box.append(el('span', 'k', label), el('p', undefined, text))
    return box
  }

  function fact(dl: HTMLElement, k: string, v: string): void {
    dl.append(el('dt', undefined, k), el('dd', undefined, v))
  }

  function kindLabel(kind: string): string {
    return kind === 'shell' ? 'Shell' : agentUi(kind)?.label ?? kind
  }

  function stateSentence(r: SessionRow): string {
    if (r.state === 'attention') return r.slot.attention === 'waiting' ? 'Pede atenção: espera uma resposta sua' : 'Pede atenção: terminou o que estava fazendo'
    if (r.state === 'busy') return 'Trabalhando agora'
    return cap(r.text)
  }

  function drawDetail(v: View): void {
    detail.replaceChildren()
    const r = state.sel ? v.rows.get(state.sel) : undefined
    const e = entryOf(v, state.sel)
    if (!state.sel || (!r && !e)) {
      const empty = el('div', 'pd-empty')
      empty.append(icon('tray'), el('b', undefined, 'Nenhuma sessão em andamento'),
        el('p', undefined, 'As sessões que estiverem rodando aparecem aqui, com guia ou sem. De cada uma você vê onde está, o que faz e há quanto tempo.'))
      detail.append(empty)
      return
    }
    const slotId = state.sel
    const now = Date.now()
    const tone = e ? entryTone(e) : r!.state
    const hd = el('div', `pd-dh ${tone}`)
    hd.append(e ? (() => { const g = el('span', 'pg'); g.append(icon('pause')); return g })() : el('span', 'led'), el('h3', undefined, nameOf(v, slotId)),
      el('span', 'pd-state', e ? timeline(e, now).at(-1)?.label ?? '' : cap(r!.text)))
    detail.append(hd)

    if (r) {
      const dl = el('dl', 'pd-facts')
      fact(dl, 'Tipo', kindLabel(r.slot.kind ?? 'shell'))
      fact(dl, 'Onde', host.placeOf(slotId) ?? 'Sem guia')
      fact(dl, 'Pasta', r.slot.cwd)
      fact(dl, 'Sessão', r.slot.binding?.sessionId ?? 'Ainda sem sessão registrada')
      fact(dl, 'Estado', stateSentence(r))
      detail.append(dl)
    }
    if (e) {
      if (e.phrase && entryTone(e) === 'progress') detail.append(note('Agora', e.phrase, 'phrase'))
      if (e.note) detail.append(note('Nota para retomar', e.note, 'resume'))
      if (e.state === 'resume-skipped') detail.append(note('Por que não retomou', e.skipReason ?? 'Sem motivo registrado.', 'skip'))
      detail.append(el('h4', 'pd-h', 'Linha do tempo'))
      const tl = el('ol', 'pd-tl')
      tl.append(...timelineRows(e, now))
      detail.append(tl)
    }

    const acts = el('div', 'pd-acts')
    const open = el('button', 'pd-open'); open.type = 'button'
    open.append(icon('arrow-square-out'), 'Abrir')
    open.title = host.hasTab(slotId) ? 'Ir para a guia desta sessão' : 'Abrir esta sessão em uma guia (ela segue rodando)'
    open.disabled = !r
    open.addEventListener('click', () => { close(); host.openSlot(slotId) })
    acts.append(open)
    if (r && r.state !== 'ended') {
      const stop = el('button', 'pd-stop'); stop.type = 'button'
      stop.append(icon('power'), 'Encerrar')
      stop.title = 'Encerrar: o processo termina e a conversa fica guardada, podendo ser reaberta'
      stop.disabled = state.stopping.has(slotId)
      stop.addEventListener('click', () => { void stopSession(slotId) })
      acts.append(stop)
    }
    if (e && v.batch && canRemoveEntry(v.batch, e)) {
      const out = el('button', 'pd-out'); out.type = 'button'
      out.append(icon('x'), 'Tirar da fila')
      out.title = 'Esta sessão segue o trabalho e não entra na pausa'
      out.addEventListener('click', () => { void run({ t: 'pause-remove', slotId }) })
      acts.append(out)
    }
    detail.append(acts)
    if (state.notice) detail.append(note('Aviso', state.notice, 'warn-note'))
  }

  function drawFoot(v: View): void {
    const slots = [...host.slots()]
    if (!v.batch) {
      const p = pausePreview(slots)
      sumMain.textContent = p.text
      prev.textContent = state.notice ?? ''
      start.replaceChildren(icon('pause'), p.buttonLabel)
      start.disabled = !p.enabled || state.busy
      start.hidden = false; cancel.hidden = true; resume.hidden = true
      return
    }
    sumMain.textContent = followSummary(v.batch)
    const ok = canResume(v.batch)
    const rp = ok ? resumePreview(v.batch, slots) : undefined
    prev.textContent = state.notice ?? (rp ? [rp.text, rp.skippedText].filter(Boolean).join(' · ') : '')
    start.hidden = true; cancel.hidden = false; resume.hidden = false
    resume.disabled = !ok || state.busy
    resume.classList.toggle('ready', ok)
    resume.title = ok ? 'Pedir a cada sessão que continue de onde parou' : 'Fica disponível quando todas tiverem parado'
    cancel.disabled = state.busy
    prev.classList.toggle('notice', state.notice !== undefined)
  }

  function refresh(): void {
    const v = view()
    state.sel = resolvePopupSelection(v.groups, state.sel)
    dlg.dataset.empty = String(v.groups.length === 0)
    drawList(v)
    drawDetail(v)
    drawFoot(v)
    paintClock(v)
  }

  // Coalesces the bursts of `state` events into one redraw.
  let pending: ReturnType<typeof setTimeout> | undefined
  function schedule(): void {
    if (pending !== undefined) return
    pending = setTimeout(() => { pending = undefined; if (!done) refresh() }, 0)
  }

  async function run(body: RequestBody): Promise<void> {
    state.busy = true; state.notice = undefined
    drawFoot(view())
    state.notice = await host.request(body)
    state.busy = false
    refresh()
  }

  /** Stop = end the process and KEEP the conversation (it moves to Encerradas and can be reopened); nothing to confirm. */
  async function stopSession(slotId: string): Promise<void> {
    if (state.stopping.has(slotId)) return
    state.stopping.add(slotId); state.notice = undefined
    refresh()
    try { state.notice = await host.request({ t: 'stop', slotId }) } finally { state.stopping.delete(slotId); if (!done) refresh() }
  }

  // ---- tiers: by the window's width, kept live ----
  const applyTier = (): void => { dlg.dataset.tier = tierOf(document.documentElement.clientWidth || window.innerWidth) }
  const resizer = new ResizeObserver(applyTier)
  applyTier()

  // ---- events ----
  let done = false
  function close(): void {
    if (done) return
    done = true
    clearInterval(ticker)
    if (pending !== undefined) clearTimeout(pending)
    resizer.disconnect()
    live = undefined
    dlg.close()
    dlg.remove()
  }
  // Selecting is all a row click does.
  list.addEventListener('click', ev => {
    const row = (ev.target as Element).closest<HTMLElement>('.pd-row')
    if (!row) return
    state.sel = row.dataset.slot; state.notice = undefined
    refresh()
  })
  const step = (dir: number): void => {
    const rows = [...list.querySelectorAll<HTMLElement>('.pd-row')]
    if (rows.length === 0) return
    const i = rows.findIndex(r => r.classList.contains('sel'))
    state.sel = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + dir))]!.dataset.slot
    state.notice = undefined
    refresh()
    list.querySelector<HTMLElement>('.pd-row.sel')?.focus()
  }
  list.addEventListener('keydown', ev => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); step(1) } else if (ev.key === 'ArrowUp') { ev.preventDefault(); step(-1) }
  })
  start.addEventListener('click', () => { void run({ t: 'pause-start' }) })
  resume.addEventListener('click', () => { void run({ t: 'pause-resume' }) })
  cancel.addEventListener('click', () => { void run({ t: 'pause-cancel' }) })
  xBtn.addEventListener('click', close)
  dlg.addEventListener('cancel', ev => { ev.preventDefault(); close() })
  dlg.addEventListener('mousedown', ev => {
    if (ev.target !== dlg) return
    const r = dlg.getBoundingClientRect()
    if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) close()
  })
  // The clock: elapsed times move every second without redrawing anything focusable.
  const ticker = setInterval(() => paintClock(view()), 1000)

  live = { dlg, schedule }
  document.body.append(dlg)
  resizer.observe(document.documentElement)
  refresh()
  dlg.showModal()
  list.querySelector<HTMLElement>('.pd-row.sel')?.focus()
}
