// Managing from afar (RR5 5.4), on screen: the rows' menus of the Regency on the web (a desk, a pane, an agent, a closed
// session), the questions before an act (sheet.ts), the line "fazendo…" on the row while an act is on its way, the result in
// the Regency's brief notice (read aloud by its live region), and the "Sistema" of the web (Processos and Ronda over the
// portal's own ops). The rows come from manage-rules.ts by the device's scopes and the house's state; the acts go through
// manage.ts. Nothing is drawn as done before the house says so: the tree changes by `regency.changed`, the processes and the
// rondas by reading again.
import type { ContextMenuEntry, ContextMenuHeading, RondaAnswer, RondaChange } from '../../../app/renderer/ext-api.ts'
import { engineOf } from '../../../app/renderer/agent-ui.ts'
import type { HueName } from '../../../app/shared/palette.ts'
import type { Target } from '../../../extensions/regency/model.ts'
import type { Tier } from '../../../extensions/regency/renderer/layout-rules.ts'
import type { RegencyPane } from '../../../extensions/regency/renderer/pane.ts'
import type { SystemViewHost } from '../../../extensions/regency/renderer/system-view.ts'
import { RegencyToast } from '../../../extensions/regency/renderer/toast.ts'
import { inUseRefusal, systemModelOf, type SystemAuthorInput, type SystemModel, type SystemProcInput } from '../../../extensions/regency/system-rules.ts'
import type { RemoteProc, RemoteUse } from '../../../src/remote/projection.ts'
import type { OpName } from '../../../src/remote/scopes.ts'
import type { RemoteHouse } from './host.ts'
import type { ActOptions, ActOutcome, Manager } from './manage.ts'
import {
  ALREADY, closeDeskQuestion, closedMenu, closePaneQuestion, deskMenu, deskNameCheck, forgetClosedQuestion, forgetInUseQuestion,
  forgetProcQuestion, hibernateQuestion, isDeskColor, neighbourOf, paneMenu, PROVING, rondaCheck, refusalWords, slotNameCheck,
  stopAgentQuestion, type DeskFacts, type ManageAct, type MenuLine, type PaneFacts,
} from './manage-rules.ts'
import type { WebMenu } from './menu.ts'
import { ask, deskForm, pick, watchFocus } from './sheet.ts'
import { el } from './ui-lite.ts'

/** "Segurar" from afar is the app's: 15 minutes, said as the person's (extensions/processes/proc-rules.ts). */
const HOLD_DURATION = '15m'
const HOLD_PURPOSE = 'segurado pela pessoa'
/** The readings of "Sistema" are this old at most while it is on screen (its clock ticks every 30 s). */
const SYSTEM_STALE_MS = 15_000

export interface ManageUiDeps {
  house: RemoteHouse
  manager: Manager
  menu: WebMenu
  tier(): Tier
  pane(): RegencyPane | undefined
  /** The reading card of a pane ("Espiar"). */
  quick(target: Target): void
  /** Paint the casing again (the "fazendo…" lines, "Sistema"). */
  schedule(): void
  now(): number
}

type Desk = ReturnType<RemoteHouse['input']>['desks']['desks'][number]
type Pane = Desk['panes'][number]

interface Doing { target: string; text: string }

export class ManageUi {
  private readonly d: ManageUiDeps
  private readonly toast = new RegencyToast()
  /** The acts on their way, by the row's target (`desk:x`, `pane:y`): their row says "fazendo…" until the answer. */
  private readonly doing = new Map<string, Doing>()
  /** Why the last rename was refused (the pane only knows it was). */
  private renameWhy = ''
  private readOnce = { procs: 0, ronda: 0 }
  readonly system: SystemViewHost

  constructor(d: ManageUiDeps) {
    this.d = d
    this.system = this.systemHost()
    watchFocus()
  }

  dispose(): void { this.toast.dispose() }

  /** Whether any act shows: a device that may manage something, with the house's tree. */
  get active(): boolean {
    const c = this.d.manager.caps
    return c.desks || c.agents || c.procs || c.destructive
  }

  // ---------------------------------------------------------------- the facts of the house

  private input() { return this.d.house.input() }
  private queue(): Desk[] { return this.input().desks.desks.filter(x => x.kind === 'queue') }
  private desk(id: string): Desk | undefined { return this.input().desks.desks.find(x => x.id === id) }
  private paneAt(id: string): { pane: Pane; desk: Desk } | undefined {
    for (const desk of this.input().desks.desks) { const pane = desk.panes.find(p => p.id === id); if (pane) return { pane, desk } }
    return undefined
  }
  private agentOf(id: string) { return this.input().agents.find(a => a.id === id) }

  private deskFacts(desk: Desk): DeskFacts {
    const q = this.queue()
    const owner = this.input().owners.desk[desk.id]
    return { id: desk.id, name: desk.name, kind: desk.kind, asleep: desk.asleep, queue: q.length, awake: q.filter(x => !x.asleep).length, ...(owner ? { owner } : {}) }
  }

  private paneFacts(pane: Pane, desk: Desk): PaneFacts {
    const a = this.agentOf(pane.id)
    const owners = this.input().owners
    return {
      id: pane.id, deskId: desk.id, title: pane.title, type: pane.type,
      ...(a ? { agent: { name: a.name } } : {}),
      asleep: pane.asleep === true || desk.asleep, exited: pane.exited === true, busy: pane.busy === true,
      ...(owners.pane[pane.id] ? { owner: owners.pane[pane.id] } : {}),
      ...(owners.desk[desk.id] ? { deskOwner: owners.desk[desk.id] } : {}),
      moveTo: this.queue().filter(x => x.id !== desk.id && !x.asleep).length,
    }
  }

  private engine(paneId: string): string | undefined {
    const a = this.agentOf(paneId)
    return a ? engineOf(a.kind).label : undefined
  }

  private nameOf(paneId: string): string {
    return this.agentOf(paneId)?.name ?? this.paneAt(paneId)?.pane.title ?? paneId
  }

  // ---------------------------------------------------------------- the menus

  /** The one place that opens a row's menu from afar (the "⋯", a right click, a long press, the Menu key, the TV's OK). */
  rowMenu(target: Target, anchor: HTMLElement, at?: { x: number; y: number }): void {
    const box = anchor.getBoundingClientRect()
    const { x, y } = at ?? { x: Math.round(box.left + 24), y: Math.round(box.bottom) }
    const key = anchor.dataset.key ?? ''
    const caps = this.d.manager.caps
    const agents = this.input().agents.length
    let lines: MenuLine[] = []
    let run: (a: ManageAct) => void = () => {}
    if (target.kind === 'desk') {
      const desk = this.desk(target.id)
      if (!desk) return
      lines = deskMenu(this.deskFacts(desk), caps, agents)
      run = a => { void this.deskAct(a, desk, key) }
    } else if (target.kind === 'pane' || target.kind === 'agent') {
      const at2 = this.paneAt(target.id)
      if (!at2) return
      lines = paneMenu(this.paneFacts(at2.pane, at2.desk), caps, agents)
      run = a => { void this.paneAct(a, at2.pane, at2.desk, key, target) }
    } else if (target.kind === 'session') {
      const c = this.input().closed?.find(s => s.slotId === target.id)
      if (!c) return
      lines = closedMenu({ id: c.slotId, name: c.name, awakeDesks: this.queue().filter(q => !q.asleep).length }, caps)
      run = a => { void this.closedAct(a, c.slotId, c.name) }
    }
    if (lines.length === 0) return
    const rows: (ContextMenuEntry | ContextMenuHeading)[] = lines.map(l => {
      if (l === 'sep') return 'sep'
      if ('heading' in l) return { heading: l.heading }
      return { icon: l.icon, label: l.label, ...(l.danger ? { danger: true } : {}), run: () => run(l.act) }
    })
    this.d.menu.open(x, y, rows)
  }

  /** The desk's moon or sun on its row: the same as the menu's row. */
  sleepDesk(deskId: string, wake: boolean): void {
    const desk = this.desk(deskId)
    if (!desk || !this.d.manager.caps.desks) return
    void this.deskAct(wake ? 'desk.wake' : 'desk.hibernate', desk, '')
  }

  renameRefused(): void { this.say(this.renameWhy || 'O nome ficou como estava.') }

  /** "+ Nova mesa" in the heading of "Mesas": the name and the colour; the desk is born at the end of the queue. */
  async create(restore: () => void): Promise<void> {
    if (!this.d.manager.caps.desks) { restore(); return }
    const draft = await deskForm(this.d.tier(), { title: 'Nova mesa', submit: 'Criar mesa', color: 'blue', withName: true, check: n => { const r = deskNameCheck(n); return r.ok ? undefined : r.why } })
    if (!draft) { restore(); return }
    const name = deskNameCheck(draft.name)
    if (!name.ok) return
    await this.run('desk:new', 'desks.create', { name: name.value, color: draft.color }, `Mesa ${name.value} criada.`)
  }

  // ---------------------------------------------------------------- the acts

  private async deskAct(a: ManageAct, desk: Desk, key: string): Promise<void> {
    const t = `desk:${desk.id}`
    switch (a) {
      case 'desk.rename': {
        this.d.pane()?.startRename(key, async name => {
          const n = deskNameCheck(name)
          if (!n.ok) { this.renameWhy = n.why; return false }
          return this.runForRename(t, 'desks.rename', { deskId: desk.id, name: n.value }, `Mesa renomeada para ${n.value}.`)
        }, 'desk')
        return
      }
      case 'desk.color': {
        const draft = await deskForm(this.d.tier(), { title: `Cor da mesa ${desk.name}`, submit: 'Trocar a cor', color: isDeskColor(desk.color) ? desk.color as HueName : 'blue', withName: false, check: () => undefined })
        if (draft) await this.run(t, 'desks.color', { deskId: desk.id, color: draft.color }, `A mesa ${desk.name} trocou de cor.`)
        return
      }
      case 'desk.hibernate': {
        const busy = desk.panes.filter(p => p.busy && !p.asleep && !p.exited).map(p => this.nameOf(p.id))
        if (busy.length > 0 && !(await ask(this.d.tier(), hibernateQuestion(`da mesa "${desk.name}"`, busy)))) return
        await this.run(t, 'desks.hibernate', { deskId: desk.id }, `Mesa ${desk.name} hibernando.`)
        return
      }
      case 'desk.wake': await this.run(t, 'desks.wake', { deskId: desk.id }, `Mesa ${desk.name} desperta.`); return
      case 'desk.close': {
        const panes = desk.panes.map(p => this.paneFacts(p, desk))
        const next = neighbourOf(this.queue(), desk.id)
        const r = await ask(this.d.tier(), closeDeskQuestion(desk.name, panes, next?.name))
        if (!r) return
        await this.run(t, 'desks.close', { deskId: desk.id, panes: r.choice === 'stop' ? 'stop' : 'move' }, `Mesa ${desk.name} fechada.`, { proof: 'act' })
        return
      }
      case 'desk.give': {
        const to = await this.pickAgent(`Dar a mesa ${desk.name} a…`)
        if (to) await this.run(t, 'owners.give', { deskId: desk.id, to }, `Mesa ${desk.name} dada a ${this.nameOf(to)}.`, { proof: 'window' })
        return
      }
      case 'desk.take': await this.run(t, 'owners.take', { deskId: desk.id }, 'Você assumiu o comando da mesa.'); return
      case 'desk.return': await this.run(t, 'owners.return', { deskId: desk.id }, `Mesa devolvida a ${this.input().owners.desk[desk.id]?.name ?? 'o agente'}.`, { proof: 'window' }); return
      case 'desk.revoke': await this.run(t, 'owners.revoke', { deskId: desk.id }, `A mesa ${desk.name} voltou para você.`); return
      default: return
    }
  }

  private async paneAct(a: ManageAct, pane: Pane, desk: Desk, key: string, target: Target): Promise<void> {
    const t = `${target.kind}:${pane.id}`
    const where = { deskId: desk.id, paneId: pane.id }
    const name = this.nameOf(pane.id)
    switch (a) {
      case 'pane.peek': this.d.quick(target); return
      case 'pane.rename': {
        this.d.pane()?.startRename(key, async typed => {
          const n = slotNameCheck(typed)
          if (!n.ok) { this.renameWhy = n.why; return false }
          return this.runForRename(t, 'agents.rename', { slotId: pane.id }, `Renomeada para ${n.value}.`, n.value)
        }, 'pane')
        return
      }
      case 'pane.move': {
        const desks = this.queue().filter(x => x.id !== desk.id && !x.asleep)
        const to = await pick(this.d.tier(), `Mover ${name} para…`, desks.map(x => ({ value: x.id, label: x.name, color: x.color, detail: `${x.panes.length} guia${x.panes.length === 1 ? '' : 's'}` })), { empty: 'Nenhuma outra mesa desperta' })
        if (to) await this.run(t, 'panes.move', { ...where, to }, `${name} foi para ${this.desk(to)?.name ?? 'a outra mesa'}.`)
        return
      }
      case 'pane.hibernate': {
        if (pane.busy && !(await ask(this.d.tier(), hibernateQuestion(`da guia "${name}"`, [name])))) return
        await this.run(t, 'panes.hibernate', where, `${name}: hibernando.`)
        return
      }
      case 'pane.wake': await this.run(t, 'panes.wake', where, `${name}: desperta.`); return
      case 'pane.suspend': await this.run(t, 'panes.suspend', where, `${name}: suspensa.`); return
      case 'pane.close': {
        const r = await ask(this.d.tier(), closePaneQuestion(this.paneFacts(pane, desk), this.engine(pane.id)))
        if (!r) return
        await this.run(t, 'panes.close', { ...where, process: r.choice === 'stop' ? 'stop' : 'keep' }, `Guia ${name} fechada.`, { proof: 'act' })
        return
      }
      case 'agent.restart': await this.run(t, 'agents.restart', { slotId: pane.id }, `${name}: reiniciado.`); return
      case 'agent.start': await this.run(t, 'agents.start', { slotId: pane.id }, `${name}: retomado.`); return
      case 'agent.stop': {
        if (!(await ask(this.d.tier(), stopAgentQuestion(this.paneFacts(pane, desk), this.engine(pane.id))))) return
        await this.run(t, 'agents.stop', { slotId: pane.id }, `${name}: encerrado.`)
        return
      }
      case 'pane.give': {
        const to = await this.pickAgent(`Dar a guia ${pane.title} a…`)
        if (to) await this.run(t, 'owners.give', { ...where, to }, `Guia ${pane.title} dada a ${this.nameOf(to)}.`, { proof: 'window' })
        return
      }
      case 'pane.take': await this.run(t, 'owners.take', where, 'Você assumiu o comando da guia.'); return
      case 'pane.return': await this.run(t, 'owners.return', where, `Guia devolvida a ${this.input().owners.pane[pane.id]?.name ?? 'o agente'}.`, { proof: 'window' }); return
      case 'pane.revoke': await this.run(t, 'owners.revoke', where, `A guia ${pane.title} voltou para a mesa.`); return
      default: return
    }
  }

  private async closedAct(a: ManageAct, slotId: string, name: string): Promise<void> {
    const t = `session:${slotId}`
    if (a === 'closed.reopen') {
      const desks = this.queue().filter(x => !x.asleep)
      const to = await pick(this.d.tier(), `Reabrir ${name} em…`, desks.map(x => ({ value: x.id, label: x.name, color: x.color, detail: `${x.panes.length} guia${x.panes.length === 1 ? '' : 's'}` })), { empty: 'Nenhuma mesa desperta' })
      if (to) await this.run(t, 'closed.reopen', { slotId, deskId: to }, `${name} reaberta em ${this.desk(to)?.name ?? 'a mesa'}.`)
    } else if (a === 'closed.forget') {
      if (await ask(this.d.tier(), forgetClosedQuestion(name))) await this.run(t, 'closed.forget', { slotId }, `A sessão de ${name} foi esquecida.`, { proof: 'act' })
    }
  }

  /** "Dar … a…": the agents of the house (the pane's own included: the app gives a pane to the agent that runs in it too). */
  private pickAgent(title: string): Promise<string | undefined> {
    const agents = this.input().agents
    return pick(this.d.tier(), title, agents.map(a => ({ value: a.id, label: a.name, detail: engineOf(a.kind).label })), {
      note: 'Dar poder a um agente pode pedir a biometria deste aparelho.', empty: 'Nenhum agente na casa',
    })
  }

  /** A rename typed in its row: the answer is the row's (true: the house took it), and the notice says the rest. */
  private async runForRename(t: string, op: OpName, body: Record<string, unknown>, said: string, name?: string): Promise<boolean> {
    const r = await this.act(t, op, name === undefined ? body : { ...body, name })
    if (r.ok) { this.say(r.body.state === 'already' ? ALREADY : said); return true }
    this.renameWhy = refusalWords(r.code)
    return false
  }

  /** One act with its row's "fazendo…" and its notice. */
  private async run(t: string, op: OpName, body: Record<string, unknown>, said: string, o: ActOptions = {}): Promise<ActOutcome> {
    const r = await this.act(t, op, body, o)
    this.say(r.ok ? (r.body.state === 'already' ? ALREADY : said) : refusalWords(r.code))
    return r
  }

  private async act(t: string, op: OpName, body: Record<string, unknown>, o: ActOptions = {}): Promise<ActOutcome> {
    this.doing.set(t, { target: t, text: 'fazendo…' })
    this.d.schedule()
    try {
      return await this.d.manager.act(op, body, { ...o, proving: () => { this.doing.set(t, { target: t, text: 'confirme…' }); this.d.schedule(); this.say(PROVING) } })
    } finally {
      this.doing.delete(t)
      this.d.schedule()
    }
  }

  /** The brief notice of the Regency, on the live pane; its live region reads it aloud. */
  say(text: string): void {
    const pane = this.d.pane()
    if (!pane) return
    if (this.toast.element.parentElement !== pane.element) pane.element.append(this.toast.element)
    this.toast.show(text)
  }

  /** What a test reads: the notice and the rows on their way. */
  snapshot(): { notice: string | undefined; doing: string[] } {
    return { notice: this.toast.shown?.text, doing: [...this.doing.keys()] }
  }

  /** After each paint: the rows of the acts on their way say so (the pane drew them again without it). */
  afterPaint(root: HTMLElement): void {
    for (const r of root.querySelectorAll<HTMLElement>('.rg-tree [data-target][aria-busy="true"]')) {
      if (this.doing.has(r.dataset.target ?? '')) continue
      r.removeAttribute('aria-busy')
      r.querySelector(':scope > .rr-doing')?.remove()
    }
    for (const d of this.doing.values()) {
      const row = root.querySelector<HTMLElement>(`.rg-tree [data-target="${CSS.escape(d.target)}"]`)
      if (!row) continue
      row.setAttribute('aria-busy', 'true')
      let mark = row.querySelector<HTMLElement>(':scope > .rr-doing')
      if (!mark) {
        mark = el('span', 'rr-doing')
        const sp = row.querySelector(':scope > .rg-sp')
        if (sp) sp.after(mark)
        else row.append(mark)
      }
      if (mark.textContent !== d.text) mark.textContent = d.text
    }
  }

  // ---------------------------------------------------------------- "Sistema" from afar: Processos and Ronda

  /** The "⋯" of a process (the view's own lists the record, which lives on the machine): "Esquecer…" from afar. */
  procMenu(name: string, anchor: HTMLElement): void {
    const r = anchor.getBoundingClientRect()
    const rows: ContextMenuEntry[] = [{ icon: 'eye', label: 'O registro se vê na máquina', disabled: true, run: () => {} }]
    if (this.d.manager.caps.destructive) rows.push('sep', { icon: 'trash', label: 'Esquecer…', danger: true, run: () => { void this.forgetProc(name) } })
    this.d.menu.open(Math.round(r.left), Math.round(r.bottom + 2), rows)
  }

  private async forgetProc(name: string): Promise<void> {
    if (!(await ask(this.d.tier(), forgetProcQuestion(name)))) return
    const r = await this.d.manager.act('procs.forget', { name }, { proof: 'act', proving: () => this.say(PROVING) })
    if (!r.ok && r.code === 'proc-in-use') {
      const refusal = inUseRefusal({ name, uses: usesOf(r.body?.uses) }, 'forget', this.d.now())
      const again = await ask(this.d.tier(), forgetInUseQuestion(name, refusal?.lines ?? []))
      if (!again?.reason) { void this.d.manager.readProcs(); return }
      const f = await this.d.manager.act('procs.forget-force', { name, reason: again.reason }, { proof: 'act', proving: () => this.say(PROVING) })
      this.say(f.ok ? `O processo ${name} foi esquecido.` : refusalWords(f.code))
    } else this.say(r.ok ? `O processo ${name} foi esquecido.` : refusalWords(r.code))
    await this.d.manager.readProcs()
  }

  private systemModel(): SystemModel {
    const m = this.d.manager
    const now = this.d.now()
    const caps = m.caps
    // First look: read once; the view's clock (tick) reads again while it is on screen.
    if (caps.procs && m.procs() === undefined && now - this.readOnce.procs > SYSTEM_STALE_MS) { this.readOnce.procs = now; void m.readProcs() }
    const agents = this.agentsAlive()
    const unknown = agents.filter(a => m.ronda(a.id) === undefined).map(a => a.id)
    if (caps.agents && unknown.length > 0 && now - this.readOnce.ronda > SYSTEM_STALE_MS) { this.readOnce.ronda = now; void m.readRonda(unknown) }
    const model = systemModelOf({
      now,
      procs: (m.procs() ?? []).map(procInput),
      agents: agents.map(a => {
        const r = m.ronda(a.id)
        return { id: a.id, name: a.name, kind: a.kind, alive: true, ...(r ? { ronda: { intervalMs: r.intervalMs, nextAt: r.nextAt, ...(r.lastAt ? { lastAt: r.lastAt } : {}), ...(r.criterion ? { criterion: r.criterion } : {}), ...(r.due ? { due: true } : {}), ...(r.channel ? { channel: r.channel } : {}) } } : {}) }
      }),
      profiles: [], folders: [],
    })
    // From afar: Processos (manage:procs) and Ronda (manage:agents) only.
    return { ...model, sections: model.sections.filter(s => (s.id === 'processes' && caps.procs) || (s.id === 'ronda' && caps.agents)) }
  }

  /** The agents with a live pane (asleep or ended have no ronda to set). */
  private agentsAlive(): { id: string; name: string; kind: string }[] {
    const input = this.input()
    return input.agents.filter(a => {
      const at = this.paneAt(a.id)
      return at !== undefined && at.pane.asleep !== true && at.pane.exited !== true && !at.desk.asleep
    })
  }

  private async proc(act: 'start' | 'stop' | 'restart' | 'hold' | 'release', name: string, opts?: { force?: string }): Promise<{ ok: true } | { refusal: string; inUse?: ReturnType<typeof inUseRefusal> }> {
    const m = this.d.manager
    const forced = opts?.force !== undefined
    const call: [OpName, Record<string, unknown>] =
      act === 'start' ? ['procs.start', { name }]
      : act === 'stop' ? (forced ? ['procs.stop-force', { name, reason: opts!.force }] : ['procs.stop', { name }])
      : act === 'restart' ? (forced ? ['procs.restart-force', { name, reason: opts!.force }] : ['procs.restart', { name }])
      : act === 'hold' ? ['procs.use', { name, purpose: HOLD_PURPOSE, duration: HOLD_DURATION }]
      : ['procs.release', { name }]
    const r = await m.act(call[0], call[1])
    await m.readProcs()
    if (r.ok) return { ok: true }
    if (r.code === 'proc-in-use' && (act === 'stop' || act === 'restart')) {
      const refusal = inUseRefusal({ name, uses: usesOf(r.body?.uses) }, act, this.d.now())
      // From afar there is no waiting for the use to end (fio-spec 16 G6): the force with a reason, or nothing.
      if (refusal) return { refusal: refusalWords(r.code), inUse: { ...refusal, exits: refusal.exits.filter(x => x.id !== 'wait') } }
    }
    return { refusal: refusalWords(r.code) }
  }

  private async setRonda(id: string, change: RondaChange): Promise<RondaAnswer> {
    const c = rondaCheck(change)
    if (!c.ok) return { ok: false, code: 'bad-request', message: c.why }
    const r = await this.d.manager.act('ronda.set', { slotId: id, ...c.value })
    void this.d.manager.readRonda([id])
    if (!r.ok) return { ok: false, code: r.code, message: refusalWords(r.code) }
    return { ok: true, ronda: undefined, outcome: 'updated' }
  }

  private async offRonda(id: string, force: boolean): Promise<RondaAnswer> {
    // The app asks first when the ronda has a criterion (the portal always forces: the person switching it off is the person).
    const known = this.d.manager.ronda(id)
    if (!force && known?.criterion) return { ok: false, code: 'ronda-criterion', message: '' }
    const r = await this.d.manager.act('ronda.off', { slotId: id })
    void this.d.manager.readRonda([id])
    if (!r.ok) return { ok: false, code: r.code, message: refusalWords(r.code) }
    return { ok: true, ronda: undefined, outcome: 'off' }
  }

  private systemHost(): SystemViewHost {
    return {
      model: () => this.systemModel(),
      procsActive: () => this.d.manager.caps.procs,
      identity: paneId => { const a = this.agentOf(paneId); return a ? { kind: a.kind, name: a.name, seed: a.id } : undefined },
      proc: (act, name, opts) => this.proc(act, name, opts?.force !== undefined ? { force: opts.force } : undefined) as ReturnType<SystemViewHost['proc']>,
      // The record lives on the machine: a click on a process' head does nothing from afar (its button is not drawn).
      peekLog: () => ({ ok: true }),
      logOnDesk: async () => undefined,
      seen: () => {},
      setRonda: (id, change) => this.setRonda(id, change),
      offRonda: (id, force) => this.offRonda(id, force),
      editProfile: () => {},
      newProcess: restore => restore(),
      createHere: (_what, _cwd, restore) => restore(),
      togglePin: () => {},
      openScreen: () => {},
      showStatus: () => false,
      menu: (x, y, entries) => this.d.menu.open(x, y, entries),
      // Its clock, while it is on screen: the processes and the rondas are read again (there is no event of them).
      tick: () => {
        const m = this.d.manager
        void m.readProcs()
        void m.readRonda(this.agentsAlive().map(a => a.id))
        this.d.schedule()
      },
    }
  }
}

/** A process from afar as the model of "Sistema" reads it (its env by names only; the projection never carries a value). */
function procInput(p: RemoteProc): SystemProcInput {
  const status = (['running', 'stopping', 'stopped', 'exited', 'host-lost', 'failed'] as const).find(s => s === p.status) ?? 'stopped'
  return {
    name: p.name, status, card: { cwd: p.card?.cwd ?? '', ...(p.card?.description ? { description: p.card.description } : {}) },
    ...(p.pid !== undefined ? { pid: p.pid } : {}),
    ...(p.startedBy ? { startedBy: authorOf(p.startedBy) } : {}),
    ...(p.exit ? { exit: { at: p.exit.at, cause: p.exit.cause, ...(p.exit.code !== undefined ? { code: p.exit.code } : {}) } } : {}),
    ...(p.attention ? { attention: true } : {}),
    ...(p.error ? { error: p.error } : {}),
    ...(p.ports ? { ports: p.ports } : {}),
    ...(p.uses ? { uses: usesOf(p.uses) } : {}),
    ...(p.external ? { external: true } : {}),
    ...(p.envNames && p.envNames.length > 0 ? { envNames: p.envNames } : {}),
  }
}

function authorOf(a: { kind: string; name?: string; agent?: string }): SystemAuthorInput {
  const kind = a.kind === 'agent' || a.kind === 'shell' || a.kind === 'app' || a.kind === 'external' ? a.kind : 'external'
  return { kind, ...(a.name ? { name: a.name } : a.agent ? { name: a.agent } : {}) }
}

/** The uses of a refusal or of a process (the projection's `RemoteUse`), for the board "em uso por outro". */
function usesOf(v: unknown): { by: SystemAuthorInput; until: string; purpose: string }[] {
  if (!Array.isArray(v)) return []
  return (v as RemoteUse[]).flatMap(u => (u && typeof u === 'object' && typeof u.until === 'string' && typeof u.purpose === 'string' && u.by && typeof u.by.kind === 'string'
    ? [{ by: authorOf(u.by), until: u.until, purpose: u.purpose }] : []))
}
