// `channels say`: I speak in a channel I am in. Every member hears it; `to` only marks whom it addresses (P8). It never waits for
// the delivery: the result says what became of the line for each member.
import { isAbsolute, resolve } from 'node:path'
import { ATTACH_MAX_PER_SAY, refusalText, type FileRefusal, type FileSource } from '../../attachments.ts'
import { sayRefusal } from '../../rules.ts'
import { CANAL_PROP, ok, optInt, optString, optStrings, refOf, refuse, resolveChannel, settle, wantString, whoByRef, type VerbDef, type VerbDeps } from './common.ts'
import type { Channel, Line } from '../../rules.ts'
import type { LineReceipt, Refusal } from '../fanout.ts'

const FILE_REFUSALS: ReadonlySet<string> = new Set<FileRefusal>(['secret-file', 'too-large', 'is-folder', 'not-found', 'too-many', 'copy-failed'])

/** The names a line addresses (whoByRef: the person or a member); anything else is `unknown-member`. */
function addressees(deps: VerbDeps, ch: Channel, refs: readonly string[]): string[] {
  const out: string[] = []
  for (const ref of refs) {
    const name = deps.channels.nameOf(whoByRef(deps, ch, ref))
    if (!out.includes(name)) out.push(name)
  }
  return out
}

export const sayVerb: VerbDef = {
  name: 'say',
  description: 'Speak in a channel you are in. Every member hears it; `to` (a list of member names or ids, or `usuário` for the person) only marks whom it addresses; `reply` is the seq of the line it answers; `files` attaches files by path (at most 10, 20 MB each; no folders, no secrets such as .env or keys): they are copied into the channel and every member gets their paths in the `anexos:` line. Returns at once with what became of the line for each member (`inside`, `typed`, `queued`, `away`). A muted member does not speak (`muted`).',
  help: 'Fala num canal em que você está (--to A --to usuário, --reply N, --files caminho).',
  input: {
    type: 'object',
    properties: { canal: CANAL_PROP, text: { type: 'string' }, to: { type: 'array', items: { type: 'string' } }, reply: { type: 'integer' }, files: { type: 'array', items: { type: 'string' }, description: 'Paths of the files to attach (absolute, or relative to the agent\'s folder).' } },
    required: ['canal'],
  },
  positional: ['canal', 'text'],
  async run(deps, caller, args) {
    const ch = resolveChannel(deps, wantString(args, 'canal'))
    const paths = optStrings(args, 'files') ?? []
    const text = optString(args, 'text') ?? ''
    if (text.trim() === '' && paths.length === 0) refuse('bad-request', 'text: texto obrigatório (ou files)')
    const refs = optStrings(args, 'to')
    const reply = optInt(args, 'reply')
    // Who may speak comes first, so a stranger learns `not-member` and not something about the members.
    const refusal = sayRefusal(caller.slotId, ch)
    if (refusal) refuse(refusal, refusal === 'closed' ? 'o canal está encerrado' : refusal === 'muted' ? 'você está calado neste canal' : 'o agente não está no canal')
    const to = refs?.length ? addressees(deps, ch, refs) : undefined
    // The same check and copy as the person's: the daemon's, never the caller's word. A relative path is the agent's own folder's.
    if (paths.length > ATTACH_MAX_PER_SAY) refuse('too-many', refusalText('too-many', '', { accepted: 0, tried: paths.length }).rest)
    const cwd = deps.api.slots.get(caller.slotId)?.cwd
    const files: FileSource[] = paths.map((p) => ({ path: isAbsolute(p) ? p : cwd ? resolve(cwd, p) : p }))
    if (files.some((f) => !isAbsolute(f.path))) refuse('bad-request', 'files: use caminhos absolutos')
    const r = await deps.channels.say(caller.slotId, ch.id, { body: text, ...(to ? { to } : {}), ...(reply !== undefined ? { replyTo: reply } : {}), ...(files.length ? { files } : {}) })
    const why = !r.ok && r.file !== undefined && FILE_REFUSALS.has(r.error) ? refusalText(r.error as FileRefusal, r.file) : undefined
    const done = settle<{ ok: true; line: Line; receipts: Record<string, LineReceipt> }>(r, why && !r.ok ? { [r.error as Refusal]: `${why.lead} ${why.rest}` } : undefined)
    const delivered = Object.entries(done.receipts).map(([id, state]) => ({ id, name: deps.channels.nameOf(id), state }))
    return ok(`Falou em #${ch.name} (${done.line.seq}).`, { channel: refOf(ch), ref: `${ch.name}#${done.line.seq}`, seq: done.line.seq, delivered, ...(done.line.files?.length ? { files: done.line.files.map((f) => f.path) } : {}) })
  },
}
