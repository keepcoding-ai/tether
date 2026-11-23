// `agents hibernate`: the person's "Hibernar guia" and "Hibernar mesa" done by the owner. The sleep lives in the app (the
// layout's `asleepPanes`, `deskSleptPanes` and the desk's `asleep`: the pane goes to the moon and is not started on launch),
// so the verb asks the app through the extension's own bridge: the daemon emits an event (`hibernate { ask, pane }`,
// `hibernate-desk { ask, desk, spare }`, `wake-desk`) to every client; the app's half of for-agents (renderer/sleep.ts) does
// it with no dialog and nothing brought forward, and answers with the request `hibernated { ask, state, panes? }`. The first
// answer wins; none in time = `no-app`, nothing changed.
//
// A desk: only one the caller owns. Its panes the caller does not command right now are spared and listed: its own pane (then
// the desk is not marked asleep, only the other panes sleep), the ones with the person (`with-user`), the ones given to
// another agent. The `open-close` line of the inventory, like close and restart. An owner does not hibernate its own pane.
import type { IDisposable } from '../../../../app/shared/vscode-lifecycle.ts'
import type { TetherDaemon, VerbCaller } from '../../../../src/daemon/ext-api.ts'
import { capabilityOn, OBJECT_KEYS, type Inventory } from '../../rules.ts'
import {
  HIBERNATE_DESK_EVENT, HIBERNATE_EVENT, HIBERNATED_REQUEST, SLEEP_STATES,
  type DeskSleepAnswer, type DeskSleepEvent, type HibernatedArgs, type HibernateEvent, type SleepAnswer,
} from '../../sleep-names.ts'
import { commanded, GUIA_PROP, ok, optString, paneName, refuse, relation, touch, type VerbDef, type VerbDeps } from './common.ts'

export { HIBERNATE_EVENT, HIBERNATED_REQUEST, type HibernatedArgs, type HibernateEvent, type SleepAnswer }

/** How long the verb waits for the app's answer before saying there is no app to do it. */
export const SLEEP_ANSWER_MS = 10_000

/** The app's answer: the state it reached and, for a desk, the panes it put to sleep or woke. */
export interface SleepReply { state: string; panes: string[] }

/**
 * The asks in flight: one entry and one timer per pending call (bounded by the calls, never by agents or panes). An answer
 * for an ask nobody waits for (late, or a second window) is dropped.
 */
export class SleepBridge {
  private readonly api: Pick<TetherDaemon, 'events' | 'requests'>
  private readonly timeoutMs: number
  private readonly waiting = new Map<string, { done: (a: SleepReply | undefined) => void; timer: ReturnType<typeof setTimeout> }>()
  private seq = 0

  constructor(api: Pick<TetherDaemon, 'events' | 'requests'>, timeoutMs = SLEEP_ANSWER_MS) {
    this.api = api
    this.timeoutMs = timeoutMs
  }

  /** Registers the app's answer; only the app's client may answer. */
  listen(): IDisposable {
    return this.api.requests.handle<HibernatedArgs>(HIBERNATED_REQUEST, (args, ctx) => {
      if (ctx.client !== 'app') refuse('not-app', 'só o app responde a um pedido de hibernar')
      const a = (args ?? {}) as Partial<HibernatedArgs>
      const panes = a.panes ?? []
      if (typeof a.ask !== 'string' || !SLEEP_STATES.includes(a.state as string) || !Array.isArray(panes) || !panes.every((p) => typeof p === 'string')) {
        refuse('bad-request', 'hibernated: { ask, state, panes? }')
      }
      this.settle(a.ask, { state: a.state as string, panes })
      return {}
    })
  }

  /** Emits `event` with `payload` plus a fresh `ask`; resolves with the app's answer, undefined when none came in time. */
  ask(event: string, payload: Record<string, unknown>): Promise<SleepReply | undefined> {
    const ask = `s${++this.seq}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(ask, undefined), this.timeoutMs)
      this.waiting.set(ask, { done: resolve, timer })
      this.api.events.emit(event, { ...payload, ask })
    })
  }

  private settle(ask: string, answer: SleepReply | undefined): void {
    const w = this.waiting.get(ask)
    if (!w) return
    this.waiting.delete(ask)
    clearTimeout(w.timer)
    w.done(answer)
  }

  dispose(): void {
    for (const ask of [...this.waiting.keys()]) this.settle(ask, undefined)
  }
}

/** The app's answer, or `no-app` when there was none. */
export async function askApp(deps: VerbDeps, event: string, payload: Record<string, unknown>): Promise<SleepReply> {
  const r = await deps.sleep.ask(event, payload)
  if (r === undefined) refuse('no-app', 'o app não respondeu: sem o app aberto não há quem faça a guia dormir ou acordar; nada foi feito')
  return r
}

/** A desk the caller owns (id or name), with `open-close` on: `unknown-desk`, `not-owner`, `off`. */
export function ownedDesk(deps: VerbDeps, caller: VerbCaller, ref: string): { id: string; name: string; asleep: boolean; panes: string[] } {
  const map = deps.api.desks.map()
  const d = map?.desks.find((x) => x.id === ref) ?? map?.desks.find((x) => x.name === ref)
  if (!d || d.kind !== 'queue') refuse('unknown-desk', `a mesa ${ref} não existe`)
  const mine = deps.store.ownedDesks().some(([id, o]) => id === d.id && o.owner === caller.slotId && !o.ended)
  if (!mine) refuse('not-owner', `a mesa ${d.name} não é sua`)
  if (!capabilityOn('open-close', deps.api.objects.get<Inventory>('desk', d.id, OBJECT_KEYS.inventory))) refuse('off', 'abrir e fechar guias está desligado nesta mesa')
  return { id: d.id, name: d.name, asleep: d.asleep === true, panes: d.panes.filter((p) => deps.api.slots.get(p.id) !== undefined).map((p) => p.id) }
}

/** What of a desk the caller leaves as it is: its own pane, the panes with the person, the panes it does not command. */
export function sparedOf(deps: VerbDeps, caller: VerbCaller, panes: readonly string[]): { own?: string; withUser: string[]; others: string[] } {
  const withUser: string[] = []
  const others: string[] = []
  let own: string | undefined
  for (const p of panes) {
    if (p === caller.slotId) { own = p; continue }
    if (relation(deps, caller.slotId, p).rel !== 'command') { others.push(p); continue }
    if (deps.gate.check(p, caller.slotId) === 'with-user') withUser.push(p)
  }
  return { ...(own ? { own } : {}), withUser, others }
}

export const names = (deps: VerbDeps, ids: readonly string[]): string => ids.map((id) => paneName(deps, id)).join(', ')

/** `guia` or `desk`, exactly one. */
export function targetArg(args: Record<string, unknown>): { guia: string } | { desk: string } {
  const guia = optString(args, 'guia')
  const desk = optString(args, 'desk')
  if ((guia === undefined) === (desk === undefined)) refuse('bad-request', 'diga a guia ou a mesa (desk), uma só')
  return guia !== undefined ? { guia } : { desk: desk! }
}

export const SLEEP_INPUT = {
  type: 'object',
  properties: { guia: GUIA_PROP, desk: { type: 'string', description: 'A desk of yours (id or name), instead of a pane.' } },
}

async function hibernatePane(deps: VerbDeps, caller: VerbCaller, guia: string) {
  const { paneId } = commanded(deps, caller, guia, 'open-close')
  if (!deps.api.slots.get(paneId)) refuse('no-conductor', 'só guias de agente ou de terminal têm processo para hibernar')
  if (paneId === caller.slotId) refuse('bad-request', 'você não hiberna a sua própria guia')
  const why = deps.gate.check(paneId, caller.slotId)
  if (why) refuse(why, 'a guia está com a pessoa agora; nada foi feito')
  const name = paneName(deps, paneId)
  const answer = (await askApp(deps, HIBERNATE_EVENT, { pane: paneId } satisfies Omit<HibernateEvent, 'ask'>)).state as SleepAnswer
  if (answer === 'no-pane') refuse('no-pane', `a guia ${name} não está no app`)
  const already = answer === 'already'
  if (!already) touch(deps, paneId, caller.slotId, 'hibernate')
  return ok(already ? `Guia ${name} já estava hibernada.` : `Guia ${name} hibernada.`, { state: 'asleep', already })
}

async function hibernateDesk(deps: VerbDeps, caller: VerbCaller, ref: string) {
  const desk = ownedDesk(deps, caller, ref)
  if (desk.asleep) return ok(`A mesa ${desk.name} já estava hibernada.`, { desk: desk.id, state: 'asleep', already: true, slept: [], spared: { withUser: [], others: [] } })
  const spared = sparedOf(deps, caller, desk.panes)
  const spare = [...(spared.own ? [spared.own] : []), ...spared.withUser, ...spared.others]
  const r = await askApp(deps, HIBERNATE_DESK_EVENT, { desk: desk.id, spare } satisfies Omit<DeskSleepEvent, 'ask'>)
  const state = r.state as DeskSleepAnswer
  if (state === 'no-desk') refuse('unknown-desk', `a mesa ${desk.name} não está no app`)
  if (state === 'last-desk') refuse('last-desk', `a mesa ${desk.name} é a última acordada e não hiberna; nada foi feito`)
  if (state === 'in-view') refuse('in-view', `a pessoa está olhando a mesa ${desk.name}; hibernar a tiraria da frente dela; nada foi feito`)
  for (const p of r.panes) touch(deps, p, caller.slotId, 'hibernate')
  const asleep = state === 'asleep'
  const parts = [
    state === 'already' ? `Nenhuma guia a hibernar na mesa ${desk.name}.` : asleep ? `Mesa ${desk.name} hibernada (${r.panes.length} guia(s) dormiram).` : `${r.panes.length} guia(s) da mesa ${desk.name} dormiram.`,
    ...(spared.own ? [`A mesa segue acordada porque a sua guia está nela.`] : !asleep && spare.length > 0 ? ['A mesa segue acordada por causa das guias poupadas.'] : []),
    ...(spared.withUser.length ? [`Com a pessoa, não tocadas: ${names(deps, spared.withUser)}.`] : []),
    ...(spared.others.length ? [`Não comandadas por você, não tocadas: ${names(deps, spared.others)}.`] : []),
  ]
  return ok(parts.join(' '), { desk: desk.id, state: asleep ? 'asleep' : 'awake', already: state === 'already', slept: r.panes, spared })
}

export const hibernateVerb: VerbDef = {
  name: 'hibernate',
  description: "Hibernate one of your panes (`guia`) or a desk of yours (`desk`), as the person's \"Hibernar guia\" / \"Hibernar mesa\": the processes stop and the panes sleep (the moon), not started when the tether starts, until woken (`agents wake`). Already asleep answers `already: true`. Refuses your own pane, and `with-user` when the person holds the pane. A desk spares and lists your own pane (the desk then stays awake), the panes with the person and the ones you do not command; the last awake desk does not sleep.",
  help: 'Hiberna uma guia ou uma mesa sua: para os processos e elas dormem (não sobem no início) até serem acordadas.',
  input: SLEEP_INPUT,
  positional: ['guia'],
  async run(deps, caller, args) {
    const t = targetArg(args)
    return 'guia' in t ? hibernatePane(deps, caller, t.guia) : hibernateDesk(deps, caller, t.desk)
  },
}
