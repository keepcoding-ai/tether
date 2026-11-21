// `agents close`: the end of a pane or of its process; the `open-close` line of the desk's inventory. An owner does not close
// its own pane (that would end the very call): the person does that.
import { commanded, GUIA_PROP, mustBeSlot, ok, optString, paneName, refuse, touch, wantString, type VerbDef } from './common.ts'

export const closeVerb: VerbDef = {
  name: 'close',
  description: "Close one of your panes. `mode: forget` (default) stops it and removes the pane; `stop` only stops the process and leaves the pane to be reused. Refuses to close your own pane.",
  help: 'Fecha uma guia: forget (padrão) apaga, stop só para o processo.',
  input: { type: 'object', properties: { guia: GUIA_PROP, mode: { type: 'string', enum: ['forget', 'stop'] } }, required: ['guia'] },
  positional: ['guia'],
  async run(deps, caller, args) {
    const mode = optString(args, 'mode') ?? 'forget'
    if (mode !== 'forget' && mode !== 'stop') refuse('bad-request', 'mode: forget ou stop')
    const { paneId } = commanded(deps, caller, wantString(args, 'guia'), 'open-close')
    mustBeSlot(deps, paneId, caller.slotId)
    const name = paneName(deps, paneId)
    if (mode === 'forget') {
      await deps.api.slots.forget(paneId)
      return ok(`Guia ${name} fechada.`, { state: 'forgotten' })
    }
    const s = await deps.api.slots.stop(paneId)
    touch(deps, paneId, caller.slotId, 'close')
    return ok(`Guia ${name} parada.`, { state: s.status })
  },
}
