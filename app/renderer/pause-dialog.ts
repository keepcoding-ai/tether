// The "Acompanhar…" dialog of the polite pause: the place to sit and watch while the agents stop at their own safe
// points. Left: the agents (state dot, name, label). Right: the selected one (its state timeline with the clock and a
// live elapsed time, the phrase it is working on, the resume note, why a resume was skipped, and its actions).
// Footer: the summary, "Retomar" (highlighted once everyone stopped) and "Cancelar pausa". It is a `dialog.ask`, so
// `dialogOpen()` keeps the app's shortcuts quiet. Four tiers by the window width (pause-rules tierOf): phone stacks the
// list over the detail with a fixed footer, narrow/desktop are two columns, wide scales type and spacing up.
// The rules live in pause-rules.ts; main.ts feeds the batch (event `pause`) and runs the requests.
import type { PauseBatch, PauseEntry } from '../../src/daemon/pause.ts'
import type { RequestBody } from '../shared/api.ts'
import { icon } from './icons.ts'
import {
  batchElapsedText, canRemoveEntry, canResume, entryText, entryTone, followSummary, hasBatch, orderedEntries,
  resolveSelection, tierOf, timeline,
} from './pause-rules.ts'

export interface PauseDialogHost {
  batch(): PauseBatch | null
  /** The panel's title, or undefined when the app does not know the slot. */
  titleOf(slotId: string): string | undefined
  /** Runs the request; resolves with the error message, if any. */
  request(body: RequestBody): Promise<string | undefined>
  /** Brings the user to the agent's panel (the dialog closes first). */
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
  refresh(): void
}

let live: Live | undefined

/** True while the dialog is on screen. */
export function pauseDialogOpen(): boolean { return live !== undefined }

/** Called by main.ts on every `pause` event (and when a panel's title may have changed). */
export function refreshPauseDialog(): void { live?.refresh() }

export function openPauseDialog(host: PauseDialogHost): void {
  if (live) { live.dlg.querySelector<HTMLElement>('.pd-row.sel, .pd-close')?.focus(); return }
  const state = { sel: undefined as string | undefined, notice: undefined as string | undefined, busy: false }

  const dlg = el('dialog', 'ask pause-dlg')
  dlg.dataset.dialog = 'pause'
  dlg.setAttribute('aria-labelledby', 'pd-title')

  // ---- header ----
  const head = el('header')
  const badge = el('span', 'badge'); badge.append(icon('pause'))
  const title = el('h2', undefined, 'Acompanhar a pausa'); title.id = 'pd-title'
  const xBtn = el('button', 'pd-x pd-close'); xBtn.type = 'button'; xBtn.title = 'Fechar (Esc)'; xBtn.setAttribute('aria-label', 'Fechar'); xBtn.append(icon('x'))
  head.append(badge, title, el('span', 'spacer'), xBtn)

  // ---- body ----
  const body = el('div', 'pd-body')
  const left = el('aside', 'pd-left')
  const list = el('div', 'pd-list'); list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Agentes na pausa')
  left.append(list)
  const right = el('section', 'pd-right'); right.setAttribute('aria-live', 'polite')
  const detail = el('div', 'pd-detail')
  right.append(detail)
  body.append(left, right)

  // ---- footer ----
  const foot = el('footer', 'pd-foot')
  const sum = el('div', 'pd-sum'); sum.setAttribute('role', 'status')
  const sumMain = el('b'); const sumAge = el('span', 'pd-age')
  sum.append(sumMain, sumAge)
  const cancel = el('button', 'pd-cancel'); cancel.type = 'button'; cancel.append('Cancelar pausa')
  cancel.title = 'Desfazer o pedido: os agentes seguem como estavam'
  const resume = el('button', 'primary pd-resume'); resume.type = 'button'; resume.append(icon('arrow-clockwise'), 'Retomar')
  foot.append(sum, el('span', 'spacer'), cancel, resume)

  dlg.append(head, body, foot)

  // ---- drawing ----
  const entryOf = (batch: PauseBatch | null): PauseEntry | undefined => batch && state.sel ? batch.entries.find(e => e.slotId === state.sel) : undefined
  const nameOf = (slotId: string): string => host.titleOf(slotId) ?? slotId

  function drawList(batch: PauseBatch | null): void {
    const focused = list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.slot : undefined
    list.replaceChildren()
    const now = Date.now()
    for (const e of batch ? orderedEntries(batch) : []) {
      const row = el('button', `pd-row ${entryTone(e)}`); row.type = 'button'
      row.dataset.slot = e.slotId
      row.setAttribute('role', 'option')
      const on = e.slotId === state.sel
      row.classList.toggle('sel', on)
      row.setAttribute('aria-selected', String(on))
      const led = el('span', 'led')
      const tx = el('span', 'tx')
      tx.append(el('span', 'nm', nameOf(e.slotId)), el('span', 'cw', entryText(e, now)))
      row.append(led, tx)
      list.append(row)
    }
    if (focused) list.querySelector<HTMLElement>(`.pd-row[data-slot="${CSS.escape(focused)}"]`)?.focus()
  }

  /** Just the texts that depend on the clock: rows ("Ainda finalizando"), the timeline, the footer age. */
  function paintClock(batch: PauseBatch | null): void {
    const now = Date.now()
    if (batch) {
      for (const e of orderedEntries(batch)) {
        const cw = list.querySelector(`.pd-row[data-slot="${CSS.escape(e.slotId)}"] .cw`)
        if (cw && cw.textContent !== entryText(e, now)) cw.textContent = entryText(e, now)
      }
      sumAge.textContent = hasBatch(batch) ? batchElapsedText(batch, now) : ''
    } else sumAge.textContent = ''
    const e = entryOf(batch)
    const tl = detail.querySelector<HTMLElement>('.pd-tl')
    if (e && tl) tl.replaceChildren(...timelineRows(e, now))
    const cur = detail.querySelector('.pd-state')
    if (e && cur) cur.textContent = timeline(e, now).at(-1)?.label ?? ''
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

  function drawDetail(batch: PauseBatch | null): void {
    detail.replaceChildren()
    const e = entryOf(batch)
    if (!batch || !e) {
      const empty = el('div', 'pd-empty')
      empty.append(icon('pause'), el('b', undefined, hasBatch(batch) ? 'Ninguém na pausa agora' : 'Nenhuma pausa em andamento'),
        el('p', undefined, hasBatch(batch) ? 'Todos os agentes saíram da fila.' : 'Ela começa em Sessões › "Pedir pausa aos N em andamento". Quando você pedir, os agentes aparecem aqui.'))
      detail.append(empty)
      return
    }
    const now = Date.now()
    const hd = el('div', `pd-dh ${entryTone(e)}`)
    hd.append(el('span', 'led'), el('h3', undefined, nameOf(e.slotId)), el('span', 'pd-state', timeline(e, now).at(-1)?.label ?? ''))
    detail.append(hd)
    if (e.phrase && entryTone(e) === 'progress') detail.append(note('Agora', e.phrase, 'phrase'))
    if (e.note) detail.append(note('Nota para retomar', e.note, 'resume'))
    if (e.state === 'resume-skipped') detail.append(note('Por que não retomou', e.skipReason ?? 'Sem motivo registrado.', 'skip'))
    detail.append(el('h4', 'pd-h', 'Linha do tempo'))
    const tl = el('ol', 'pd-tl')
    tl.append(...timelineRows(e, now))
    detail.append(tl)

    const acts = el('div', 'pd-acts')
    const open = el('button', 'pd-open'); open.type = 'button'
    open.append(icon('arrow-square-out'), 'Abrir painel')
    open.title = 'Ir para o painel deste agente'
    open.disabled = host.titleOf(e.slotId) === undefined
    open.addEventListener('click', () => { const id = e.slotId; close(); host.openSlot(id) })
    acts.append(open)
    if (canRemoveEntry(batch, e)) {
      const out = el('button', 'pd-out'); out.type = 'button'
      out.append(icon('x'), 'Tirar da fila')
      out.title = 'Este agente segue o trabalho e não entra na pausa'
      out.addEventListener('click', () => { void run({ t: 'pause-remove', slotId: e.slotId }) })
      acts.append(out)
    }
    detail.append(acts)
    if (state.notice) detail.append(note('Aviso', state.notice, 'warn-note'))
  }

  function drawFoot(batch: PauseBatch | null): void {
    const has = hasBatch(batch)
    sumMain.textContent = followSummary(batch)
    const ok = canResume(batch)
    resume.disabled = !ok || state.busy
    resume.classList.toggle('ready', ok)
    resume.title = ok ? 'Pedir a cada agente que continue de onde parou' : 'Fica disponível quando todos tiverem parado'
    cancel.disabled = !has || state.busy
  }

  function refresh(): void {
    const batch = host.batch()
    const view = hasBatch(batch) ? batch : null
    state.sel = resolveSelection(view, state.sel)
    dlg.dataset.empty = String(view === null)
    drawList(view)
    drawDetail(view)
    drawFoot(view)
    paintClock(view)
  }

  async function run(body: RequestBody): Promise<void> {
    state.busy = true; state.notice = undefined
    drawFoot(hasBatch(host.batch()) ? host.batch() : null)
    state.notice = await host.request(body)
    state.busy = false
    refresh()
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
    resizer.disconnect()
    live = undefined
    dlg.close()
    dlg.remove()
  }
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
  const ticker = setInterval(() => { const b = host.batch(); paintClock(hasBatch(b) ? b : null) }, 1000)

  live = { dlg, refresh }
  document.body.append(dlg)
  resizer.observe(document.documentElement)
  refresh()
  dlg.showModal()
  list.querySelector<HTMLElement>('.pd-row.sel')?.focus()
}
