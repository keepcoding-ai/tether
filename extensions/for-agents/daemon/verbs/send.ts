// `agents send`: a message to the agent of a pane. By default it carries the owner's envelope (`role: 'owner'`) and takes one
// of three ways: inside, through the delivery, when the agent has a channel open; typed through the ENGINE'S CONDUCTOR when the
// only way is the terminal and the pane is idle and free (the conductor checks that the text left the box, which the core's
// typing does not: a long line may sit there with its Enter unaccepted); else through the delivery, which holds it (`queued`,
// with the hand with the person: `why: 'with-user'`). `raw: true` types the text as a person would,
// through the conductor and the gate: it serves to correct an agent mid-turn on an engine with no inside entry, and it refuses
// with `with-user` rather than write over the person.
import { randomBytes } from 'node:crypto'
import { terminalText } from '../../../../src/daemon/door/terminal-text.ts'
import type { VerbCaller, VerbResult } from '../../../../src/daemon/ext-api.ts'
import { EXT_ID } from '../../manifest.ts'
import { buildContext } from '../context.ts'
import { conductorRegistry, type Conductor, type ConductorContext, type ConductorTarget } from '../../conductor-api.ts'
import { awakeTarget, commanded, conductorFor, GUIA_PROP, ok, optFlag, paneName, refuse, touch, wantString, type VerbDef, type VerbDeps } from './common.ts'

/** Delivers `body` to a pane in the owner's envelope; the receipt as the verb's data. */
export async function deliverAsOwner(deps: VerbDeps, caller: VerbCaller, paneId: string, body: string): Promise<Record<string, unknown>> {
  const receipt = await deps.api.delivery.deliver(paneId, { kind: 'message', from: { name: paneName(deps, caller.slotId), id: caller.slotId, role: 'owner' }, body })
  const withUser = receipt.state === 'queued' && deps.store.effectiveOf(paneId).hand === 'user'
  return { id: receipt.id, state: receipt.state, ...(withUser ? { why: 'with-user' } : {}), ...(receipt.unsent ? { unsent: true } : {}) }
}

/** The pane shows no card or dialog: the conductor that reads the screen says `idle`. One that cannot read it gives no veto. */
async function idleOnScreen(target: ConductorTarget, ctx: ConductorContext): Promise<boolean> {
  const detector = conductorRegistry.pick(target, 'detect')
  if (!detector) return true
  try { return (await detector.detect!(ctx)).state === 'idle' } catch { return false }
}

/**
 * Types the envelope through the engine's conductor (which checks that the text left the box), through the gate. Undefined when
 * the person took the pane before a byte went (the gate's `with-user`): the caller then hands the message to the delivery,
 * which holds it. Any other failure is an error that says the message is not confirmed, so it is never lost in silence.
 */
async function typeThroughConductor(deps: VerbDeps, caller: VerbCaller, paneId: string, conductor: Conductor, ctx: ConductorContext, body: string): Promise<VerbResult | undefined> {
  const id = `m_${Date.now().toString(36)}${randomBytes(5).toString('hex')}`
  const text = terminalText({ kind: 'message', from: { name: paneName(deps, caller.slotId), id: caller.slotId, role: 'owner' }, body }, EXT_ID, id)
  try {
    const r = await conductor.send!(ctx, text)
    touch(deps, paneId, caller.slotId, 'send')
    return ok(`Mensagem digitada em ${paneName(deps, paneId)}.`, { id, state: 'typed' }, r.proven)
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code
    if (code === 'with-user') return undefined
    const why = (e as Error | null)?.message ?? String(e)
    deps.api.log(`send ${id} para ${paneId}: o condutor não confirmou o envio (${why})`)
    refuse(typeof code === 'string' && code ? code : 'conductor-failed', `a mensagem não foi confirmada em ${paneName(deps, paneId)} e pode estar na caixa do agente, sem ter sido enviada: ${why}`, { id })
  }
}

export const sendVerb: VerbDef = {
  name: 'send',
  description: "Send a message to the agent in one of your panes, as its owner (it arrives in your envelope; it does not touch what the person is typing). With the pane in the person's hands it waits (`queued`). `raw: true` types the text exactly as a person would, to correct an agent in the middle of a turn: it refuses with `with-user` when the person is typing. A shell pane always gets the plain text, with no header, so `raw` is not needed there.",
  help: 'Envia uma mensagem ao agente de uma guia (raw: digita como a pessoa).',
  input: { type: 'object', properties: { guia: GUIA_PROP, text: { type: 'string' }, raw: { type: 'boolean', description: 'Type the text raw instead of delivering it.' } }, required: ['guia', 'text'] },
  positional: ['guia', 'text'],
  async run(deps, caller, args) {
    const guia = wantString(args, 'guia')
    const text = wantString(args, 'text')
    const raw = optFlag(args, 'raw')
    const { paneId } = commanded(deps, caller, guia, 'send')
    const target = await awakeTarget(deps, paneId, 'send')
    const conductor = conductorFor(target, 'send')
    const ctx = buildContext(deps, caller.slotId, target)
    // The notices read this: a `done` that comes from the core's silence heuristic after a send that left the text in the box
    // is not a finished turn. `busy` and `with-user` say nothing about the box, so they do not count as a failed send.
    const endSend = deps.store.beginSend(paneId)
    let failed = false
    try {
      // A shell would run the envelope header as a command, so a shell pane always takes the plain text (raw).
      return await sendOn(deps, caller, paneId, target, conductor, ctx, text, raw || target.slot?.kind === 'shell')
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code
      failed = code !== 'busy' && code !== 'with-user'
      throw e
    } finally {
      endSend(failed)
    }
  },
}

async function sendOn(deps: VerbDeps, caller: VerbCaller, paneId: string, target: ConductorTarget, conductor: Conductor, ctx: ConductorContext, text: string, raw: boolean): Promise<VerbResult> {
  if (!raw) {
    // The core's `pathOf` already says 'terminal' only for a pane held, alive, out of a turn, with nothing waiting for an answer
    // and the person free (the delivery's own four conditions); the screen's veto is added here: no card or dialog showing.
    if (deps.api.delivery.pathOf(paneId) === 'terminal' && (await idleOnScreen(target, ctx))) {
      const typed = await typeThroughConductor(deps, caller, paneId, conductor, ctx, text)
      if (typed) return typed
    }
    const data = await deliverAsOwner(deps, caller, paneId, text)
    touch(deps, paneId, caller.slotId, 'send')
    if (data.unsent) refuse('unsent', `o texto ficou na caixa de ${paneName(deps, paneId)} sem o Enter (a guia mudou de mãos ou o usuário digitou); não foi enviado`, { id: data.id })
    return ok(`Mensagem ${String(data.state)} para ${paneName(deps, paneId)}.`, data)
  }
  const r = await conductor.send!(ctx, text)
  touch(deps, paneId, caller.slotId, 'send')
  return ok(`Texto digitado em ${paneName(deps, paneId)}.`, { state: 'typed', raw: true }, r.proven)
}
