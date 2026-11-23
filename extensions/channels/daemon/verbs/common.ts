// What every verb of `channels` shares: the dependencies the verbs read, the results (`ok`, `fail`, `refuse`), the arguments,
// the resolution of a channel and of an agent by id or name, and the translation of the fan-out's refusal into the verb's
// error. A refusal is a `VerbError` thrown anywhere below a verb; `verbs.ts` turns it into the verb's error result
// (`isError`, `data.error` = the code), the same for the CLI and the MCP tool because both read the same `VerbResult`.
// The verbs never act on a pane: no `not-commanded`, `with-user` or `off` here (contract 3.1).
import { slotIsLive, slotTitle } from '../../../../app/shared/agent-info.ts'
import type { VerbCaller, VerbResult } from '../../../../src/daemon/ext-api.ts'
import type { SlotState } from '../../../../src/daemon/protocol.ts'
import { ownerOf, USER, type AgentId, type Channel } from '../../rules.ts'
import type { Channels, ChannelsApi, Refusal } from '../fanout.ts'
import type { TetherDaemon } from '../../../../src/daemon/ext-api.ts'

export type VerbApi = ChannelsApi & Pick<TetherDaemon, 'verbs'>

export interface VerbDeps {
  api: VerbApi
  channels: Channels
}

/** One verb of the `channels` namespace, before it is registered (verbs.ts adds the namespace and the shared handling). */
export interface VerbDef {
  name: string
  description: string
  help: string
  input: Record<string, unknown>
  positional?: readonly string[]
  run(deps: VerbDeps, caller: VerbCaller, args: Record<string, unknown>): Promise<VerbResult>
}

export const CANAL_PROP = { type: 'string', description: 'The channel: its id, or its name (a closed channel only by its id, or with `closed`).' }
export const AGENT_PROP = { type: 'string', description: "The agent: its slot id, or its pane's name when it is unique among the live agent panes." }

// ---- results ----------------------------------------------------------------------------------

export class VerbError extends Error {
  readonly code: string
  extra?: Record<string, unknown>
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export function ok(text: string, data: Record<string, unknown>): VerbResult {
  return { text, data }
}

export function fail(code: string, message: string, extra: Record<string, unknown> = {}): VerbResult {
  return { text: `${code}: ${message}`, data: { error: code, ...extra }, isError: true }
}

/** Any error becomes the verb's error result: one with a `code` keeps it, anything else is a bug and answers `internal`. */
export function failOf(e: unknown): VerbResult {
  const code = (e as { code?: unknown } | null)?.code
  const message = (e as Error | null)?.message ?? String(e)
  const extra = (e as { extra?: Record<string, unknown> } | null)?.extra
  return typeof code === 'string' && code ? fail(code, message, extra ?? {}) : fail('internal', message)
}

export function refuse(code: string, message: string, extra?: Record<string, unknown>): never {
  const e = new VerbError(code, message)
  if (extra) e.extra = extra
  throw e
}

// ---- arguments --------------------------------------------------------------------------------

export function wantString(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string' || v === '') refuse('bad-request', `${key}: texto obrigatório`)
  return v
}

export function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') refuse('bad-request', `${key}: esperava texto`)
  return v
}

export function optFlag(args: Record<string, unknown>, key: string): boolean {
  const v = args[key]
  if (v === undefined || v === null) return false
  if (typeof v !== 'boolean') refuse('bad-request', `${key}: esperava true ou false`)
  return v
}

/** A whole number >= 0 (a seq, a limit); the CLI may bring it as text. */
export function optInt(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  if (v === undefined || v === null || v === '') return undefined
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) refuse('bad-request', `${key}: esperava um número inteiro`)
  return n
}

/** A list of texts; a single text counts as a list of one. */
export function optStrings(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  const list = typeof v === 'string' ? [v] : v
  if (!Array.isArray(list) || list.some((x) => typeof x !== 'string' || x === '')) refuse('bad-request', `${key}: esperava uma lista de textos`)
  return list as string[]
}

// ---- agents and channels ----------------------------------------------------------------------

export function nameOfAgent(deps: VerbDeps, id: AgentId): string {
  return deps.channels.nameOf(id)
}

export function me(deps: VerbDeps, caller: VerbCaller): { id: string; name: string } {
  return { id: caller.slotId, name: nameOfAgent(deps, caller.slotId) }
}

const isAgentSlot = (s: SlotState): boolean => s.kind !== 'shell'

/**
 * An agent by `ref`: a slot id, else a pane's name unique among the live agent panes. `unknown-agent` when nothing matches,
 * `ambiguous` (with the options) when a name repeats.
 */
export function resolveAgent(deps: VerbDeps, ref: string): AgentId {
  const byId = deps.api.slots.get(ref)
  if (byId && isAgentSlot(byId)) return byId.slotId
  const named = deps.api.slots.list().filter((s) => isAgentSlot(s) && slotIsLive(s) && slotTitle(s) === ref)
  if (named.length > 1) refuse('ambiguous', `mais de um agente se chama ${JSON.stringify(ref)}`, { options: named.map((s) => ({ id: s.slotId, name: slotTitle(s) })) })
  if (named.length === 0) refuse('unknown-agent', `nenhum agente vivo se chama ${JSON.stringify(ref)}`)
  return named[0]!.slotId
}

/**
 * A channel by `ref`: an id (open or closed), else the name of an open channel; with `closed`, else the name of a closed one
 * (`ambiguous` with the options when more than one has it).
 */
export function resolveChannel(deps: VerbDeps, ref: string, opts: { closed?: boolean } = {}): Channel {
  const store = deps.channels.store
  const byId = store.get(ref)
  if (byId) return byId
  const open = store.findOpen(ref)
  if (open) return open
  if (opts.closed) {
    const shut = store.channels().filter((c) => c.closed && c.name === ref)
    if (shut.length > 1) refuse('ambiguous', `mais de um canal encerrado se chama ${JSON.stringify(ref)}`, { options: shut.map((c) => ({ id: c.id, name: c.name, closed: c.closed!.at })) })
    if (shut.length === 1) return shut[0]!
  }
  refuse('unknown-channel', `nenhum canal ${opts.closed ? '' : 'aberto '}tem o id ou o nome ${JSON.stringify(ref)}`)
}

const REFUSALS: Record<Refusal, string> = {
  'unknown-channel': 'o canal não existe',
  'name-taken': 'já existe um canal aberto com esse nome',
  'bad-name': 'nome de canal: letras minúsculas, números e hífens, de 1 a 40 caracteres',
  exists: 'o canal já existe',
  'not-member': 'o agente não está no canal',
  closed: 'o canal está encerrado',
  muted: 'você está calado neste canal',
  'not-owner': 'só o dono do canal (ou você, a pessoa) faz isto',
  removed: 'o agente foi tirado do canal; só o dono o junta de novo',
  desk: 'o canal da mesa só segue a mesa',
  'not-closed': 'o canal não está encerrado',
  'unknown-agent': 'não é um agente do tether',
  'bad-request': 'pedido inválido',
}

/** The fan-out's answer as the verb's: the success, or the refusal thrown with the verb's error code. */
export function settle<T extends { ok: true }>(r: T | { ok: false; error: Refusal }): T {
  if (!r.ok) refuse(r.error, REFUSALS[r.error] ?? r.error)
  return r
}

/** The channel as the results name it. */
export const refOf = (ch: Channel): { id: string; name: string } => ({ id: ch.id, name: ch.name })

/** Who commands the channel now, as the results show it. */
export function ownerRow(deps: VerbDeps, ch: Channel): { kind: 'user' | 'agent'; id?: string; name: string } {
  const o = ownerOf(ch)
  return o.kind === 'user' ? { kind: 'user', name: deps.channels.nameOf(USER) } : { kind: 'agent', id: o.id, name: deps.channels.nameOf(o.id) }
}
