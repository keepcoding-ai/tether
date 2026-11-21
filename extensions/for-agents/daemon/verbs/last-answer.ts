// `agents last-answer`: the agent's last answer, from the conductor's best source. `stale` when the pane's last act was an
// interrupt after that answer (no engine reports an interrupted turn). Reading it clears the attention rerouted to the caller.
import { OBJECT_KEYS, type LastAct } from '../../rules.ts'
import { buildContext } from '../context.ts'
import { conductorFor, GUIA_PROP, ok, paneName, poolOf, refuse, relation, resolveIn, targetOf, wantString, type VerbDef } from './common.ts'

export const lastAnswerVerb: VerbDef = {
  name: 'last-answer',
  description: 'Read the last answer of the agent in one of your panes (also a pane you only see). `source` says where it came from; `stale: true` means it is from before the last interrupt. Reading it clears the attention that came to you.',
  help: 'Lê a última resposta do agente de uma guia.',
  input: { type: 'object', properties: { guia: GUIA_PROP }, required: ['guia'] },
  positional: ['guia'],
  async run(deps, caller, args) {
    const guia = wantString(args, 'guia')
    const paneId = resolveIn(deps, poolOf(deps, caller.slotId), guia)
    if (paneId === undefined || relation(deps, caller.slotId, paneId).rel === undefined) refuse('not-mine', `nenhuma guia sua se chama ${JSON.stringify(guia)}`)
    const target = targetOf(deps, paneId)
    const c = conductorFor(target, 'lastAnswer')
    const r = await c.lastAnswer!(buildContext(deps, caller.slotId, target))
    if (!r) refuse('none', `${paneName(deps, paneId)} ainda não tem resposta`)
    const last = deps.api.objects.get<LastAct>('pane', paneId, OBJECT_KEYS.last)
    const stale = last?.verb === 'interrupt' && last.at > r.value.at
    if (deps.api.attention.routeOf(paneId) === caller.slotId) {
      try { deps.api.attention.seen(paneId) } catch (e) { deps.api.log(`attention.seen de ${paneId} falhou: ${(e as Error).message}`) }
    }
    return ok(r.value.text, { text: r.value.text, at: r.value.at, source: r.value.source, stale, proven: r.proven }, r.proven)
  },
}
