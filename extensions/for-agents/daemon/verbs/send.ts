// `agents send`: a message to the agent of a pane. By default it goes through the delivery with the owner's envelope
// (`role: 'owner'`): inside when the agent has a channel open, typed into the terminal when the pane is held, idle and free,
// else it waits (with the hand with the person: `queued`, `why: 'with-user'`). `raw: true` types the text as a person would,
// through the conductor and the gate: it serves to correct an agent mid-turn on an engine with no inside entry, and it refuses
// with `with-user` rather than write over the person.
import type { VerbCaller } from '../../../../src/daemon/ext-api.ts'
import { buildContext } from '../context.ts'
import { commanded, conductorFor, GUIA_PROP, ok, optFlag, paneName, touch, wantString, type VerbDef, type VerbDeps } from './common.ts'

/** Delivers `body` to a pane in the owner's envelope; the receipt as the verb's data. */
export async function deliverAsOwner(deps: VerbDeps, caller: VerbCaller, paneId: string, body: string): Promise<Record<string, unknown>> {
  const receipt = await deps.api.delivery.deliver(paneId, { kind: 'message', from: { name: paneName(deps, caller.slotId), id: caller.slotId, role: 'owner' }, body })
  const withUser = receipt.state === 'queued' && deps.store.effectiveOf(paneId).hand === 'user'
  return { id: receipt.id, state: receipt.state, ...(withUser ? { why: 'with-user' } : {}), ...(receipt.unsent ? { unsent: true } : {}) }
}

export const sendVerb: VerbDef = {
  name: 'send',
  description: "Send a message to the agent in one of your panes, as its owner (it arrives in your envelope; it does not touch what the person is typing). With the pane in the person's hands it waits (`queued`). `raw: true` types the text exactly as a person would, to correct an agent in the middle of a turn: it refuses with `with-user` when the person is typing.",
  help: 'Envia uma mensagem ao agente de uma guia (raw: digita como a pessoa).',
  input: { type: 'object', properties: { guia: GUIA_PROP, text: { type: 'string' }, raw: { type: 'boolean', description: 'Type the text raw instead of delivering it.' } }, required: ['guia', 'text'] },
  positional: ['guia', 'text'],
  async run(deps, caller, args) {
    const guia = wantString(args, 'guia')
    const text = wantString(args, 'text')
    const raw = optFlag(args, 'raw')
    const { paneId, target } = commanded(deps, caller, guia, 'send')
    const conductor = conductorFor(target, 'send')
    if (!raw) {
      const data = await deliverAsOwner(deps, caller, paneId, text)
      touch(deps, paneId, caller.slotId, 'send')
      return ok(`Mensagem ${String(data.state)} para ${paneName(deps, paneId)}.`, data)
    }
    const r = await conductor.send!(buildContext(deps, caller.slotId, target), text)
    touch(deps, paneId, caller.slotId, 'send')
    return ok(`Texto digitado em ${paneName(deps, paneId)}.`, { state: 'typed', raw: true }, r.proven)
  },
}
