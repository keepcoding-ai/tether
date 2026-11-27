// `agents suspend`: the person's "Suspender guia" done by the owner, the alternative to hibernating. The same suspension the
// app's sweep does (layout `suspendedPanes`, the "Suspensa" seal): the process stops, the pane stays in place with its last
// screen, and it comes back on its own when anything uses it (a delivery, a verb, the person). Hibernation, by contrast, only
// returns with `agents wake`. The state lives in the app, so it goes through the same bridge as hibernate (event `suspend
// { ask, pane }`, answered with the request `hibernated`).
//
// Only an agent that resumes its session in place: not a shell, not a pane whose session was never confirmed, not one already
// hibernated. The `open-close` line of the inventory, like hibernate. An owner does not suspend its own pane.
import type { VerbCaller } from '../../../../src/daemon/ext-api.ts'
import { SUSPEND_EVENT, type SuspendAnswer, type SuspendEvent } from '../../sleep-names.ts'
import { commanded, GUIA_PROP, ok, paneName, refuse, touch, type VerbDef, type VerbDeps } from './common.ts'
import { askApp } from './hibernate.ts'
import { sleepMarkOf } from './list.ts'

async function suspendPane(deps: VerbDeps, caller: VerbCaller, guia: string) {
  const { paneId } = commanded(deps, caller, guia, 'open-close')
  const slot = deps.api.slots.get(paneId)
  if (!slot) refuse('no-conductor', 'só guias de agente têm processo para suspender')
  if (paneId === caller.slotId) refuse('bad-request', 'você não suspende a sua própria guia')
  const why = deps.gate.check(paneId, caller.slotId)
  if (why) refuse(why, 'a guia está com a pessoa agora; nada foi feito')
  const name = paneName(deps, paneId)
  if (slot.kind === 'shell') refuse('not-agent', `a guia ${name} é um terminal (shell): não há sessão para retomar, então ela não suspende; use hibernate`)
  const mark = sleepMarkOf(deps, paneId)
  if (mark.asleep) refuse('asleep', `a guia ${name} está hibernada; ela só volta com \`agents wake\``)
  if (mark.suspended) return ok(`Guia ${name} já estava suspensa.`, { state: 'suspended', already: true })
  if (slot.status === 'unconfirmed') refuse('unconfirmed', `a sessão da guia ${name} não foi confirmada: sem ela a guia não retoma sozinha, então não suspende; use hibernate`)
  if (slot.status !== 'running') refuse('not-running', `a guia ${name} não está rodando (${slot.status}); não há o que suspender`)
  if (slot.canRestart !== true) refuse('unconfirmed', `a guia ${name} ainda não pode retomar a sessão no lugar (sessão não confirmada, ou reiniciando); tente depois, ou use hibernate`)
  const answer = (await askApp(deps, SUSPEND_EVENT, { pane: paneId } satisfies Omit<SuspendEvent, 'ask'>)).state as SuspendAnswer | string
  if (answer === 'no-pane') refuse('no-pane', `a guia ${name} não está no app`)
  if (answer === 'cannot') refuse('cannot-suspend', `a guia ${name} não pode ser suspensa agora (terminal, hibernada ou sem sessão para retomar)`)
  const already = answer === 'already'
  if (!already) touch(deps, paneId, caller.slotId, 'suspend')
  return ok(already ? `Guia ${name} já estava suspensa.` : `Guia ${name} suspensa; volta sozinha quando for usada.`, { state: 'suspended', already })
}

export const suspendVerb: VerbDef = {
  name: 'suspend',
  description: "Suspend one of your agent panes (`guia`) to save resources, as the person's \"Suspender guia\": the process stops and the pane stays in place, marked suspended, and it comes back on its own when anything uses it (a send, a read, the person). Unlike `hibernate`, no `wake` is needed. Already suspended answers `already: true`. Refuses your own pane (`bad-request`), `with-user` when the person holds the pane, `no-conductor` when it has no process, `not-agent` for a shell and `unconfirmed` when its session was never confirmed; a hibernated pane answers `asleep`.",
  help: 'Suspende uma guia de agente sua para economizar recursos: ela volta sozinha ao ser usada (diferente de hibernar).',
  input: { type: 'object', properties: { guia: GUIA_PROP } },
  positional: ['guia'],
  async run(deps, caller, args) {
    const guia = typeof args.guia === 'string' ? args.guia : undefined
    if (!guia) refuse('bad-request', 'diga a guia (guia)')
    return suspendPane(deps, caller, guia)
  },
}
