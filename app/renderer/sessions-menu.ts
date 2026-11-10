// The "Sessões" menu (DOM): ONE icon, ONE menu. Top to bottom: the summary, the polite pause (a batch on screen, or the
// button that starts one), the sessions with no tab ("Sem guia": open, stop), the ended ones (reopen, forget), and the
// footer ("Acompanhar…", "Esquecer todas as encerradas"). The model is sessions-rules.ts (and pause-rules.ts for the
// pause rows); main.ts feeds it through the host below and calls `refresh()` wherever the slots or the batch change.
//
// Invariant: opening, looking and navigating never have an effect. Clicking the icon only opens/closes; the focus lands
// on the container (Enter by reflex does nothing); every effect is born from a labelled button inside the menu.
import type { SlotState } from '../../src/daemon/protocol.ts'
import type { PauseBatch } from '../../src/daemon/pause.ts'
import type { RequestBody } from '../shared/api.ts'
import { icon, KIND_ICON, type IconName } from './icons.ts'
import { canResume, entryText, entryTone, hasBatch, orderedEntries, summaryText } from './pause-rules.ts'
import { bulkCloseAction, pauseAction, sessionRows, sessionsCounter, sessionsSummary, type SessionRow } from './sessions-rules.ts'

export interface SessionsMenuHost {
  slots(): Iterable<SlotState>
  /** A pane shows the session. */
  hasTab(slotId: string): boolean
  batch(): PauseBatch | null
  /** The panel's title, or undefined when the app does not know the slot. */
  titleOf(slotId: string): string | undefined
  /** Brings the user to the session (starts it again when it ended). The menu closes first. */
  openSlot(slotId: string): void
  /** Runs the request; resolves with the error message, if any. */
  request(body: RequestBody): Promise<string | undefined>
  /** The single confirmation of the bulk close; true = go ahead. */
  confirmBulkClose(names: string[]): Promise<boolean>
  /** The single confirmation of "Esquecer todas as encerradas"; true = go ahead. */
  confirmForgetAll(count: number): Promise<boolean>
  /** Opens the "Acompanhar…" popup. */
  openFollow(): void
  /** A dialog is on screen (then the footer buttons do not stack another one). */
  dialogOpen(): boolean
}

export interface SessionsMenu {
  refresh(): void
  isOpen(): boolean
  setOpen(open: boolean): void
  toggle(): void
  contains(node: Node): boolean
  /** Opens the menu with the focus on the pause button (the palette's "Pedir pausa…"): it still does not pause by itself. */
  openOnPause(): void
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

function button(cls: string, label: string, iconName?: IconName, title?: string): HTMLButtonElement {
  const b = el('button', cls)
  b.type = 'button'
  if (iconName) b.append(icon(iconName))
  if (label) b.append(document.createTextNode(label))
  if (title) b.title = title
  return b
}

function iconButton(cls: string, iconName: IconName, label: string): HTMLButtonElement {
  const b = button(cls, '', iconName, label)
  b.setAttribute('aria-label', label)
  return b
}

function sectionTitle(text: string, count?: number): HTMLElement {
  const gt = el('div', 'sx-gt')
  gt.append(el('span', undefined, text))
  if (count !== undefined) gt.append(el('span', 'n', String(count)))
  return gt
}

export function createSessionsMenu(host: SessionsMenuHost): SessionsMenu {
  const btn = document.getElementById('btn-sessions') as HTMLButtonElement
  const list = document.getElementById('sessions-list') as HTMLElement
  const count = document.getElementById('sessions-count') as HTMLElement
  const glyph = btn.querySelector<HTMLElement>('.i')!
  /** Sessions with a stop / forget in flight (the daemon may wait for a young Claude before ending it). */
  const busy = new Set<string>()
  /** The ended row whose trash was clicked: its actions are replaced by "Esquecer esta sessão? [Esquecer] [Não]" (forgetting cannot be undone). */
  let askingForget: string | undefined
  /** A gentle one-off message in the pause section (e.g. the daemon refused). */
  let notice: string | undefined
  let bulking = false
  let ticker: ReturnType<typeof setInterval> | undefined

  const isOpen = (): boolean => !list.hidden

  function setOpen(open: boolean): void {
    if (open === isOpen()) return
    list.hidden = !open
    btn.setAttribute('aria-expanded', String(open))
    if (!open) notice = undefined
    // "ocioso há X" and "Ainda finalizando" depend on the clock: re-render while the menu is open.
    if (open && !ticker) ticker = setInterval(refresh, 15_000)
    if (!open && ticker) { clearInterval(ticker); ticker = undefined }
    if (open) {
      refresh()
      list.tabIndex = -1
      list.focus({ preventScroll: true })
    }
  }

  function close(): void { askingForget = undefined; setOpen(false) }

  async function run(body: RequestBody): Promise<void> {
    const err = await host.request(body)
    if (err) notice = err
    refresh()
  }

  /** Stop = end the process and KEEP the conversation: the session moves to "Encerradas" and can be reopened. */
  async function stopSession(slotId: string): Promise<void> {
    if (busy.has(slotId)) return
    busy.add(slotId)
    refresh()
    try { await host.request({ t: 'stop', slotId }) } finally { busy.delete(slotId); refresh() }
  }

  async function forgetSession(slotId: string): Promise<void> {
    if (busy.has(slotId)) return
    busy.add(slotId)
    try { await host.request({ t: 'forget', slotId }) } finally { busy.delete(slotId); refresh() }
  }

  /** The bulk close: one confirmation listing the names; only what is still eligible when the answer comes is stopped. */
  async function bulkClose(): Promise<void> {
    if (bulking || host.dialogOpen()) return
    const names = bulkCloseAction(rowsNow()).names
    if (names.length === 0) return
    bulking = true
    close()
    try {
      if (!(await host.confirmBulkClose(names))) return
      const ids = rowsNow().filter(r => r.cleanup).map(r => r.slotId)
      await Promise.all(ids.map(id => stopSession(id)))
    } finally { bulking = false; refresh() }
  }

  async function forgetAllEnded(): Promise<void> {
    const ids = endedRows(rowsNow()).map(r => r.slotId)
    if (ids.length === 0 || host.dialogOpen()) return
    close()
    if (!(await host.confirmForgetAll(ids.length))) return
    const still = new Set(endedRows(rowsNow()).map(r => r.slotId))
    await Promise.all(ids.filter(id => still.has(id)).map(id => forgetSession(id)))
  }

  const rowsNow = (): SessionRow[] => sessionRows(host.slots(), host.hasTab, Date.now())
  const freeRows = (rows: readonly SessionRow[]): SessionRow[] => rows.filter(r => r.noTab)
  const endedRows = (rows: readonly SessionRow[]): SessionRow[] => rows.filter(r => r.state === 'ended' && !host.hasTab(r.slotId))

  function sessionRow(r: SessionRow, group: 'free' | 'ended'): HTMLElement {
    const row = el('div', `sx-row ${group} ${r.state}`)
    row.dataset.slot = r.slotId
    const led = el('span', 'led')
    const kindName = r.slot.kind ?? 'shell'
    const kind = el('span', `kind ${kindName}`); kind.append(icon(KIND_ICON[kindName] ?? 'terminal-window'))
    const tx = el('div', 'tx')
    const tt = el('span', 'tt', r.name)
    const cw = el('span', 'cw', r.memory ? `${r.text} · ${r.memory}` : r.text); cw.title = r.slot.cwd
    tx.append(tt, cw)
    const acts = el('div', 'acts')
    const open = group === 'free'
      ? button('open primary', 'Abrir', 'arrow-square-out', 'Abrir em uma guia (a sessão segue rodando)')
      : button('open', 'Reabrir', 'arrow-clockwise', 'Reabrir em uma guia, retomando a conversa')
    open.addEventListener('click', ev => { ev.stopPropagation(); close(); host.openSlot(r.slotId) })
    acts.append(open)
    if (group === 'free') {
      const stop = button('stop', 'Encerrar', 'power', 'Encerrar: o processo termina e a conversa fica guardada em Encerradas')
      stop.setAttribute('aria-label', 'Encerrar a sessão')
      stop.disabled = busy.has(r.slotId)
      stop.addEventListener('click', ev => { ev.stopPropagation(); void stopSession(r.slotId) })
      acts.append(stop)
    } else if (askingForget === r.slotId) {
      acts.replaceChildren()
      row.classList.add('asking')
      const q = el('span', 'sx-ask', 'Esquecer esta sessão?')
      const yes = button('danger forget-yes', 'Esquecer', undefined, 'Esquecer: some da lista. Não dá para desfazer')
      yes.disabled = busy.has(r.slotId)
      yes.addEventListener('click', ev => { ev.stopPropagation(); askingForget = undefined; void forgetSession(r.slotId) })
      const no = button('forget-no', 'Não', undefined, 'Manter a sessão em Encerradas')
      no.addEventListener('click', ev => { ev.stopPropagation(); askingForget = undefined; refresh() })
      acts.append(q, yes, no)
      queueMicrotask(() => no.focus({ preventScroll: true }))
    } else {
      const forget = iconButton('ic forget', 'trash', 'Esquecer a sessão')
      forget.title = 'Esquecer: some da lista. Não dá para desfazer'
      forget.disabled = busy.has(r.slotId)
      forget.addEventListener('click', ev => { ev.stopPropagation(); askingForget = r.slotId; refresh() })
      acts.append(forget)
    }
    row.append(led, kind, tx, acts)
    return row
  }

  function pauseRow(batch: PauseBatch, e: PauseBatch['entries'][number]): HTMLElement {
    const slotId = e.slotId
    const known = host.titleOf(slotId)
    const row = el('div', `sx-row pz-row ${entryTone(e)}`)
    row.dataset.slot = slotId
    const pg = el('span', 'pg'); pg.append(icon('pause'))
    const tx = el('div', 'tx')
    const text = entryText(e, Date.now())
    const cw = el('span', 'cw', text); cw.title = text
    tx.append(el('span', 'tt', known ?? slotId), cw)
    const acts = el('div', 'acts')
    const open = button('open', 'Abrir', 'arrow-square-out', 'Abrir a guia deste agente')
    open.disabled = known === undefined
    open.addEventListener('click', ev => { ev.stopPropagation(); close(); host.openSlot(slotId) })
    acts.append(open)
    if (batch.state !== 'resuming' && e.state !== 'resumed' && e.state !== 'resume-skipped') {
      const out = iconButton('ic', 'x', 'Tirar da fila')
      out.title = 'Tirar da fila: este agente segue o trabalho e não entra na pausa'
      out.addEventListener('click', ev => { ev.stopPropagation(); void run({ t: 'pause-remove', slotId }) })
      acts.append(out)
    }
    row.append(pg, tx, acts)
    return row
  }

  function pauseSection(batch: PauseBatch | null): HTMLElement {
    const sec = el('section', 'sx-pause')
    sec.append(sectionTitle('Pausa'))
    if (notice) sec.append(el('div', 'sx-note', notice))
    if (!batch) {
      const act = pauseAction(host.slots(), null)
      const go = button('primary', act.label, 'pause', 'Pede a cada agente em andamento que pare no seu passo; ninguém é interrompido')
      go.id = 'pause-start'
      go.disabled = !act.enabled
      go.addEventListener('click', ev => { ev.stopPropagation(); void run({ t: 'pause-start' }) })
      const wrap = el('div', 'sx-actions'); wrap.append(go)
      sec.append(wrap)
      return sec
    }
    sec.append(el('div', 'sx-note', summaryText(batch, Date.now())))
    const rows = el('div', 'sx-rows pz-rows')
    for (const e of orderedEntries(batch)) rows.append(pauseRow(batch, e))
    sec.append(rows)
    const ok = canResume(batch)
    const resume = button('primary', 'Retomar', 'arrow-clockwise', ok ? 'Pedir a cada agente que continue de onde parou' : 'Fica disponível quando todos tiverem parado')
    resume.id = 'pause-resume'
    resume.disabled = !ok
    resume.addEventListener('click', ev => { ev.stopPropagation(); void run({ t: 'pause-resume' }) })
    const cancel = button('', 'Cancelar pausa', undefined, 'Desfazer o pedido: os agentes seguem como estavam')
    cancel.id = 'pause-cancel'
    cancel.addEventListener('click', ev => { ev.stopPropagation(); void run({ t: 'pause-cancel' }) })
    const wrap = el('div', 'sx-actions'); wrap.append(resume, cancel)
    sec.append(wrap)
    return sec
  }

  function refresh(): void {
    const slots = [...host.slots()]
    const batch = hasBatch(host.batch()) ? host.batch() : null
    const summary = sessionsSummary(slots, host.hasTab, batch)

    // The icon: a tray, or a pause glyph while a batch is on screen; the counter shows only what asks for action.
    const name: IconName = batch ? 'pause' : 'tray'
    if (glyph.dataset.icon !== name) { glyph.dataset.icon = name; glyph.replaceChildren(icon(name)) }
    btn.classList.toggle('active', batch !== null)
    btn.title = summary.tooltip
    btn.setAttribute('aria-label', summary.tooltip)
    count.replaceChildren(...sessionsCounter(slots, host.hasTab, batch).map(seg => el('b', `c-${seg.tone}`, seg.text)))
    count.hidden = count.childElementCount === 0
    if (!isOpen()) return

    // Keep the scroll of the lists across the live re-renders.
    const scrolls = new Map<string, number>()
    for (const sel of ['.sx-pause .sx-rows', '.sx-ended .sx-rows']) scrolls.set(sel, list.querySelector(sel)?.scrollTop ?? 0)
    list.replaceChildren()
    list.append(el('div', 'sx-hd', summary.header))

    list.append(pauseSection(batch))

    const rows = rowsNow()
    const free = freeRows(rows)
    if (free.length > 0) {
      const sec = el('section', 'sx-free'); sec.dataset.group = 'free'
      sec.append(sectionTitle('Sem guia', free.length))
      const bulk = bulkCloseAction(rows)
      const bulkBtn = button('bulk', bulk.label, 'power', 'Encerra de uma vez as sessões sem guia que estão ociosas há 10 minutos ou mais; as conversas ficam guardadas')
      bulkBtn.id = 'sessions-bulk-close'
      bulkBtn.disabled = !bulk.enabled || bulking
      bulkBtn.addEventListener('click', ev => { ev.stopPropagation(); void bulkClose() })
      const wrap = el('div', 'sx-actions'); wrap.append(bulkBtn)
      const body = el('div', 'sx-rows')
      body.append(...free.map(r => sessionRow(r, 'free')))
      sec.append(wrap, body)
      list.append(sec)
    }
    const ended = endedRows(rows)
    if (ended.length > 0) {
      const sec = el('section', 'sx-ended'); sec.dataset.group = 'ended'
      sec.append(sectionTitle('Encerradas', ended.length))
      const body = el('div', 'sx-rows')
      body.append(...ended.map(r => sessionRow(r, 'ended')))
      sec.append(body)
      list.append(sec)
      body.scrollTop = scrolls.get('.sx-ended .sx-rows') ?? 0
    }
    const pauseRows = list.querySelector('.sx-pause .sx-rows')
    if (pauseRows) pauseRows.scrollTop = scrolls.get('.sx-pause .sx-rows') ?? 0

    const ft = el('div', 'sx-ft')
    const follow = button('follow', 'Acompanhar…', undefined, 'Abrir o acompanhamento')
    follow.id = 'sessions-follow'
    follow.addEventListener('click', ev => { ev.stopPropagation(); close(); host.openFollow() })
    ft.append(follow)
    if (ended.length > 0) {
      const all = button('forget-all', 'Esquecer todas as encerradas', 'trash')
      all.id = 'sessions-forget-all'
      all.addEventListener('click', ev => { ev.stopPropagation(); void forgetAllEnded() })
      ft.append(all)
    }
    list.append(ft)
  }

  // The icon only opens/closes: a click out of curiosity must have no effect.
  btn.addEventListener('click', ev => { ev.stopPropagation(); setOpen(!isOpen()) })
  // A click anywhere but on the question cancels it.
  list.addEventListener('click', ev => {
    if (askingForget && !(ev.target as Element).closest('.sx-row.asking')) { askingForget = undefined; refresh() }
  })
  list.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape') return
    ev.stopPropagation()
    if (askingForget) { askingForget = undefined; refresh(); return }
    close()
    btn.focus({ preventScroll: true })
  })

  return {
    refresh,
    isOpen,
    setOpen,
    toggle: () => setOpen(!isOpen()),
    contains: node => list.contains(node) || btn.contains(node),
    openOnPause: () => {
      setOpen(true)
      list.querySelector<HTMLButtonElement>('#pause-start:not([disabled]), #pause-resume:not([disabled])')?.focus({ preventScroll: true })
    },
  }
}
