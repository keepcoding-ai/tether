// `agents wake`: the person's pick in "Guias hibernadas…" (a pane) or her switch to a sleeping desk (a desk) done by the owner,
// without bringing anything to the front.
// - A pane: waking is the slot's `start` (resuming its session). The app clears a pane's sleep on any stopped → live change
//   of its slot, whoever started it, so this needs no answer from the app. A live pane answers `already: true`.
// - A desk: the app's own wake of a desk (`wake-desk`, through the bridge of hibernate.ts): only the panes the desk's sleep put
//   down start again, the ones hibernated one by one stay asleep; the panes with the person are spared and listed.
// A suspended pane (`agents suspend`, or the app's sweep) is a stopped one: waking it resumes it like any other.
// The `open-close` line of the inventory, like hibernate.
import type { VerbCaller } from '../../../../src/daemon/ext-api.ts'
import { WAKE_DESK_EVENT, type DeskSleepEvent, type DeskWakeAnswer } from '../../sleep-names.ts'
import { commanded, ok, paneName, refuse, touch, type VerbDef, type VerbDeps } from './common.ts'
import { askApp, names, ownedDesk, SLEEP_INPUT, sparedOf, targetArg } from './hibernate.ts'

const LIVE = new Set(['running', 'starting', 'queued'])

/** What the agent can do when a pane's session was never confirmed (the daemon will not guess it). */
export const UNCONFIRMED_HINT = 'a sessão desta guia não foi confirmada, então ela não volta sem uma escolha: peça à pessoa que escolha na guia retomar ou começar sessão nova, ou use `agents restart <guia> --fresh` para começar uma sessão nova (a conversa anterior não volta)'

async function wakePane(deps: VerbDeps, caller: VerbCaller, guia: string) {
  const { paneId } = commanded(deps, caller, guia, 'open-close')
  const slot = deps.api.slots.get(paneId)
  if (!slot) refuse('no-conductor', 'só guias de agente ou de terminal têm processo para acordar')
  const why = deps.gate.check(paneId, caller.slotId)
  if (why) refuse(why, 'a guia está com a pessoa agora; nada foi feito')
  const name = paneName(deps, paneId)
  if (LIVE.has(slot.status)) return ok(`Guia ${name} já estava acordada.`, { state: slot.status, already: true })
  if (slot.status === 'unconfirmed') refuse('unconfirmed', `guia ${name}: ${UNCONFIRMED_HINT}`)
  const s = await deps.api.slots.start(paneId).catch((e: unknown) => {
    if ((e as { code?: string } | null)?.code === 'unconfirmed') refuse('unconfirmed', `guia ${name}: ${UNCONFIRMED_HINT}`)
    throw e
  })
  touch(deps, paneId, caller.slotId, 'wake')
  return ok(`Guia ${name} acordada.`, { state: s.status, already: false })
}

async function wakeDesk(deps: VerbDeps, caller: VerbCaller, ref: string) {
  const desk = ownedDesk(deps, caller, ref)
  const spared = sparedOf(deps, caller, desk.panes)
  const spare = [...spared.withUser, ...spared.others]
  const r = await askApp(deps, WAKE_DESK_EVENT, { desk: desk.id, spare } satisfies Omit<DeskSleepEvent, 'ask'>)
  const state = r.state as DeskWakeAnswer
  if (state === 'no-desk') refuse('unknown-desk', `a mesa ${desk.name} não está no app`)
  for (const p of r.panes) touch(deps, p, caller.slotId, 'wake')
  const parts = [
    state === 'already' ? `Nada a acordar na mesa ${desk.name}.` : `Mesa ${desk.name} acordada (${r.panes.length} guia(s) voltando).`,
    ...(spared.withUser.length ? [`Com a pessoa, não tocadas: ${names(deps, spared.withUser)}.`] : []),
    ...(spared.others.length ? [`Não comandadas por você, não tocadas: ${names(deps, spared.others)}.`] : []),
  ]
  return ok(parts.join(' '), { desk: desk.id, state: 'awake', already: state === 'already', woke: r.panes, spared: { withUser: spared.withUser, others: spared.others } })
}

export const wakeVerb: VerbDef = {
  name: 'wake',
  description: 'Wake one of your hibernated panes (`guia`: its process starts again, resuming its session) or a desk of yours (`desk`: the panes its hibernation put to sleep start again; panes hibernated one by one stay asleep). Nothing takes the front from the person. Already awake answers `already: true`; `with-user` when the person holds the pane (a desk spares and lists those).',
  help: 'Acorda uma guia hibernada (retomando a sessão) ou uma mesa sua.',
  input: SLEEP_INPUT,
  positional: ['guia'],
  async run(deps, caller, args) {
    const t = targetArg(args)
    return 'guia' in t ? wakePane(deps, caller, t.guia) : wakeDesk(deps, caller, t.desk)
  },
}
