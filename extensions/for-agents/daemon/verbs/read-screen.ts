// `agents read-screen`: the pane's screen as text, as the person sees it. Reading needs only that the pane is the caller's to
// see (commanded or only seen); it does not attach, resize or write. `state` is the conductor's `detect`.
import { buildContext } from '../context.ts'
import { conductorFor, GUIA_PROP, ok, optNumber, optString, paneName, poolOf, refuse, relation, resolveIn, targetOf, wantString, type VerbDef } from './common.ts'

const PARTS = ['screen', 'history', 'both']

export const readScreenVerb: VerbDef = {
  name: 'read-screen',
  description: 'Read the screen of one of your panes as text (also a pane you only see). `part`: screen (default), history or both; `lines` keeps the last N lines; `since` is the `end` of an earlier read. `state`: busy, idle, permission, question, dialog or unknown.',
  help: 'Lê a tela de uma guia como texto.',
  input: {
    type: 'object',
    properties: {
      guia: GUIA_PROP,
      part: { type: 'string', enum: PARTS },
      lines: { type: 'integer', description: 'Keep only the last N lines.' },
      since: { type: 'integer', description: 'The `end` an earlier read returned.' },
    },
    required: ['guia'],
  },
  positional: ['guia'],
  async run(deps, caller, args) {
    const guia = wantString(args, 'guia')
    const part = optString(args, 'part')
    if (part !== undefined && !PARTS.includes(part)) refuse('bad-request', `part: ${PARTS.join(', ')}`)
    const lines = optNumber(args, 'lines')
    const since = optNumber(args, 'since')
    const paneId = resolveIn(deps, poolOf(deps, caller.slotId), guia)
    if (paneId === undefined || relation(deps, caller.slotId, paneId).rel === undefined) refuse('not-mine', `nenhuma guia sua se chama ${JSON.stringify(guia)}`)
    const target = targetOf(deps, paneId)
    const reader = conductorFor(target, 'read')
    const ctx = buildContext(deps, caller.slotId, target)
    const r = await reader.read!(ctx, { ...(part ? { part } : {}), ...(lines !== undefined ? { lines } : {}), ...(since !== undefined ? { since } : {}) })
    const detector = conductorFor(target, 'detect')
    const state = (await detector.detect!(ctx)).state
    const meta = r.meta ?? {}
    return ok(r.text === '' ? `(a tela de ${paneName(deps, paneId)} está vazia)` : r.text, { text: r.text, cols: meta.cols ?? null, rows: meta.rows ?? null, end: meta.end ?? null, state })
  },
}
