// `agents answer`: answers the permission card (or question) that is on the pane's screen NOW. The card is read at the moment
// of the call (`detect`); with none on the screen the answer is `no-request`, so a late answer never lands as typing in the box.
import { buildContext } from '../context.ts'
import { commanded, conductorFor, GUIA_PROP, ok, refuse, touch, wantString, type VerbDef } from './common.ts'

const NAMED = ['yes', 'always', 'no']

export const answerVerb: VerbDef = {
  name: 'answer',
  description: "Answer a permission request (or question) that an agent in one of your panes is showing now: choice yes, always, no, or the option's number. It reads the screen first and refuses with `no-request` when there is no card. `card` in the result is the text of the option chosen.",
  help: 'Responde o pedido de permissão que está na tela de uma guia.',
  input: { type: 'object', properties: { guia: GUIA_PROP, choice: { type: 'string', description: "'yes', 'always', 'no' or an option number." } }, required: ['guia', 'choice'] },
  positional: ['guia', 'choice'],
  async run(deps, caller, args) {
    const choice = String(args.choice ?? '').trim()
    if (!NAMED.includes(choice) && !/^[1-9][0-9]*$/.test(choice)) refuse('bad-request', "choice: 'yes', 'always', 'no' ou o número da opção")
    const { paneId, target } = commanded(deps, caller, wantString(args, 'guia'), 'answer')
    const conductor = conductorFor(target, 'answer')
    const detector = conductorFor(target, 'detect')
    // Only this verb declares its typing a card answer: the door then counts it as activity, never as a draft.
    const ctx = buildContext(deps, caller.slotId, target, { answer: true })
    const why = deps.gate.check(paneId, caller.slotId)
    if (why) refuse(why, 'a guia está com a pessoa agora; nada foi enviado')
    const seen = await detector.detect!(ctx)
    if (seen.state !== 'permission' && seen.state !== 'question' && seen.state !== 'dialog') refuse('no-request', 'não há pedido na tela desta guia')
    const r = await conductor.answer!(ctx, choice)
    touch(deps, paneId, caller.slotId, 'answer')
    const option = seen.card.options.find((o) => o.id === choice)
    const card = option?.label ?? seen.card.title
    return ok(`Respondido: ${card}.`, { sent: true, card, proven: r.proven }, r.proven)
  },
}
