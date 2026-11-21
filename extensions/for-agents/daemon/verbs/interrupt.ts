// `agents interrupt`: the engine's interrupt on a pane that is in a turn. The act is the conductor's; when it confirms on the
// screen that the agent stopped (`stopped: true`) the extension tells the door the turn is done (`attention.signal`), because
// no engine reports it after an interrupt and the turn would stay busy for ever.
import { conductorRegistry } from '../../conductor-api.ts'
import { buildContext } from '../context.ts'
import { commanded, conductorFor, GUIA_PROP, ok, refuse, touch, wantString, type VerbDef } from './common.ts'

export const interruptVerb: VerbDef = {
  name: 'interrupt',
  description: 'Interrupt what the agent in one of your panes is doing (Esc; Ctrl+C in a shell). It refuses with `not-busy` when the agent is idle and with `with-user` when the person is typing there.',
  help: 'Interrompe o que o agente de uma guia está fazendo.',
  input: { type: 'object', properties: { guia: GUIA_PROP }, required: ['guia'] },
  positional: ['guia'],
  async run(deps, caller, args) {
    const { paneId, target } = commanded(deps, caller, wantString(args, 'guia'), 'interrupt')
    const conductor = conductorFor(target, 'interrupt')
    const ctx = buildContext(deps, caller.slotId, target)
    const why = deps.gate.check(paneId, caller.slotId)
    if (why) refuse(why, 'a guia está com a pessoa agora; nada foi enviado')
    const detect = conductorRegistry.pick(target, 'detect')
    if (detect && (await detect.detect!(ctx)).state === 'idle') refuse('not-busy', 'o agente não está em turno')
    const r = await conductor.interrupt!(ctx)
    if (r.value.stopped) {
      try { deps.api.attention.signal(paneId, 'done') } catch (e) { deps.api.log(`attention.signal de ${paneId} falhou: ${(e as Error).message}`) }
    }
    touch(deps, paneId, caller.slotId, 'interrupt')
    const state = r.value.stopped ? 'stopped' : 'sent'
    return ok(r.value.stopped ? 'Interrompido: o agente parou.' : 'Interrupção enviada; a parada não foi confirmada.', { interrupted: true, state, proven: r.proven }, r.proven)
  },
}
