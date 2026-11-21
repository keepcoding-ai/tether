// `agents restart`: the agent of a pane relaunched, resuming its session or a new one. The `open-close` line of the desk's inventory.
import { commanded, GUIA_PROP, mustBeSlot, ok, optFlag, paneName, touch, wantString, type VerbDef } from './common.ts'

export const restartVerb: VerbDef = {
  name: 'restart',
  description: 'Restart the agent in one of your panes, resuming its session. `fresh: true` starts a new session instead. Refuses to restart your own pane.',
  help: 'Reinicia o agente de uma guia (fresh: sessão nova).',
  input: { type: 'object', properties: { guia: GUIA_PROP, fresh: { type: 'boolean' } }, required: ['guia'] },
  positional: ['guia'],
  async run(deps, caller, args) {
    const fresh = optFlag(args, 'fresh')
    const { paneId } = commanded(deps, caller, wantString(args, 'guia'), 'open-close')
    mustBeSlot(deps, paneId, caller.slotId)
    if (fresh) await deps.api.slots.stop(paneId)
    const s = fresh ? await deps.api.slots.start(paneId, 'new') : await deps.api.slots.restart(paneId)
    touch(deps, paneId, caller.slotId, 'restart')
    return ok(`Guia ${paneName(deps, paneId)} reiniciada.`, { state: s.status })
  },
}
