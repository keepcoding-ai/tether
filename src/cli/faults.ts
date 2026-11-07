// `tether faults <verb>`: the fault registry (src/core/faults.ts) from the terminal, and the only way an agent writes to
// it (its skills call these verbs; nobody edits faults.jsonl or faults-state.json by hand). Verbs and flags in English,
// messages in Portuguese, exit codes 0 ok / 1 error / 2 usage (an ambiguous id lists its candidates). `--json` has
// fixed fields: the skills parse it. The writes go through src/core/faults-ops.ts, under the registry's lock.
import { faultsDir, type FaultStatus } from '../core/faults.ts'
import { applyAction, describeNotFound, listFaults, showFault, type FaultAction, type FaultDetail, type FaultRow } from '../core/faults-ops.ts'
import { kindLabel, normalizeTag, parseStatus, returnedText, STATUSES, statusLabel, statusPlural } from '../core/faults-labels.ts'
import { tetherHome } from '../core/paths.ts'
import { paneAuthor, paneDisplayName } from '../core/pane-name.ts'
import { readSlot } from '../core/store.ts'
import { ENV_SLOT } from '../agents/types.ts'
import { parseArgs, UsageError, type ParsedArgs } from './args.ts'
import { localTime, relativeTime, table, truncate } from './format.ts'

export const FAULTS_USAGE = `  faults [list] [--status aberta|investigando|resolvida|ignorada|all] [--tag t] [--json]
                                      lista as falhas por assinatura (padrão: abertas e investigando)
  faults show <id> [--all] [--json]   detalhe: stack, contexto, ocorrências (as 20 últimas; --all: todas), notas e fix
  faults investigate <id> [--by quem] marca como investigando
  faults done <id> [--fix <commit>] [--by quem]
                                      marca como resolvida (o commit é opcional)
  faults ignore <id>                  marca como ignorada
  faults reopen <id>                  volta para aberta
  faults tag <id> <tag>... [--remove] etiqueta (ou tira as etiquetas)
  faults note <id> <texto> [--by quem]
                                      anota`

export interface FaultsIo {
  out(text: string): void
  err(text: string): void
  env?: NodeJS.ProcessEnv
  /** The registry folder (default: the user's). */
  dir?: string
  now?: () => number
}

/** Occurrences `show --json` carries unless `--all`. */
export const SHOW_CAP = 20
const SHOW_HUMAN = 5

/**
 * Who a write is attributed to: --by, else the pane the command runs in (TETHER_SLOT_ID): its own name, else the display
 * name the bridge uses for it ("Claude · tether-faults", src/core/pane-name.ts), else "você". The slot is read from the
 * home's files, never over the pipe, so a daemon that is down changes nothing; a slot that cannot be read at all falls back
 * to "Claude · <this folder>".
 */
export function authorOf(by: string | undefined, env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  if (by?.trim()) return by.trim()
  const slotId = env[ENV_SLOT]?.trim()
  if (!slotId) return 'você'
  try {
    const meta = readSlot(tetherHome(env), slotId)
    if (meta) return paneAuthor(meta)
  } catch { /* an id that is not a slot id */ }
  return paneDisplayName('claude', { cwd })
}

export async function cmdFaults(argv: string[], io: FaultsIo): Promise<number> {
  const env = io.env ?? process.env
  const dir = io.dir ?? faultsDir(env)
  const verbs = new Set(['list', 'show', 'investigate', 'done', 'ignore', 'reopen', 'tag', 'note'])
  const [first, ...more] = argv
  // `tether faults` is `list`; so is `tether faults --status done`.
  const [verb, rest] = first !== undefined && verbs.has(first) ? [first, more] : first === undefined || first.startsWith('--') ? ['list', argv] : [first, more]
  switch (verb) {
    case 'list': return list(rest, dir, io)
    case 'show': return show(rest, dir, io)
    case 'investigate': return write(rest, dir, io, { valued: ['by'] }, (p) => ({ type: 'investigate', by: authorOf(p.options.by, env) }), (id, st) => `${id} ${statusLabel(st)}`)
    case 'done': return write(rest, dir, io, { valued: ['fix', 'by'] }, (p) => ({ type: 'done', by: authorOf(p.options.by, env), ...(p.options.fix ? { fix: p.options.fix } : {}) }), (id, st, f) => `${id} ${statusLabel(st)}${f.fix?.commit ? ` (fix ${f.fix.commit})` : ' (sem commit)'}`)
    case 'ignore': return write(rest, dir, io, {}, () => ({ type: 'ignore' }), (id, st) => `${id} ${statusLabel(st)}`)
    case 'reopen': return write(rest, dir, io, {}, () => ({ type: 'reopen' }), (id, st) => `${id} ${statusLabel(st)}`)
    case 'tag': return tag(rest, dir, io)
    case 'note': return note(rest, dir, io, env)
    default: throw new UsageError(`verbo desconhecido em faults: ${verb}`)
  }
}

// ---- list ---------------------------------------------------------------------------------------

function statusFilter(word: string | undefined): FaultStatus[] | 'all' | undefined {
  if (word === undefined) return undefined
  if (/^(all|todas?|todos)$/i.test(word)) return 'all'
  const s = parseStatus(word)
  if (!s) throw new UsageError(`--status inválido: ${word} (use aberta, investigando, resolvida, ignorada ou all)`)
  return [s]
}

function list(argv: string[], dir: string, io: FaultsIo): number {
  const p = parseArgs(argv, { valued: ['status', 'tag'], flags: ['json'] })
  const wanted = statusFilter(p.options.status)
  const tag = p.options.tag ? normalizeTag(p.options.tag) : undefined
  const snap = listFaults(dir)
  if (snap.problem) io.err(`tether: ${snap.problem}\n`)
  const all = snap.rows
  const shown = all.filter(r => (wanted === 'all' ? true : (wanted ?? ['open', 'investigating'] as FaultStatus[]).includes(r.status)) && (!tag || r.tags.includes(tag)))
  if (p.flags.has('json')) {
    io.out(JSON.stringify(shown.map(jsonRow), null, 2) + '\n')
    return 0
  }
  if (shown.length === 0) {
    io.out(all.length === 0 ? 'nenhuma falha registrada.\n' : `nenhuma falha ${wanted === undefined ? 'aberta' : 'com esse filtro'} (${all.length} no total: tether faults list --status all)\n`)
    return 0
  }
  const now = (io.now ?? Date.now)()
  const rows = shown.map(r => [
    r.id, statusLabel(r.status), String(r.count), relativeTime(r.last, now), r.proc, kindLabel(r.kind),
    truncate(r.message.split('\n')[0]!, 70) + (r.tags.length ? `  ${r.tags.map(t => `#${t}`).join(' ')}` : '') + (r.returned ? `  (voltou na v${r.returned.version.replace(/^v/, '')})` : ''),
  ])
  io.out(table(['ID', 'ESTADO', '×', 'ÚLTIMA', 'PROCESSO', 'TIPO', 'MENSAGEM'], rows))
  const by = (s: FaultStatus): number => shown.filter(r => r.status === s).length
  const parts = STATUSES.filter(s => by(s)).map(s => `${by(s)} ${by(s) > 1 ? statusPlural(s) : statusLabel(s)}`)
  io.out(`\n${shown.length} ${shown.length === 1 ? 'falha' : 'falhas'} (${parts.join(', ')}) · tether faults show <id>\n`)
  return 0
}

/** The fixed fields of `list --json`. */
function jsonRow(r: FaultRow): Record<string, unknown> {
  return { id: r.id, sig: r.sig, status: r.status, kind: r.kind, proc: r.proc, message: r.message, count: r.count, first: r.first, last: r.last, tags: r.tags, version: r.version, ...(r.returned ? { returned: r.returned } : {}) }
}

// ---- show ---------------------------------------------------------------------------------------

function show(argv: string[], dir: string, io: FaultsIo): number {
  const p = parseArgs(argv, { flags: ['json', 'all'] })
  const ref = p.positional[0]
  if (!ref) throw new UsageError('informe a falha (o id, como a3f9)')
  const cap = p.flags.has('all') ? undefined : p.flags.has('json') ? SHOW_CAP : SHOW_HUMAN
  const r = showFault(dir, ref, cap)
  if (!r.ok) return notFound(r, io)
  if (r.problem) io.err(`tether: ${r.problem}\n`)
  const f = r.fault
  if (p.flags.has('json')) {
    io.out(JSON.stringify(showJson(f), null, 2) + '\n')
    return 0
  }
  io.out(humanShow(f, (io.now ?? Date.now)()))
  return 0
}

/** The state entry (without the storm bookkeeping) plus the identity fields and the occurrences. */
function showJson(f: FaultDetail): Record<string, unknown> {
  return {
    id: f.id, sig: f.sig, status: f.status, kind: f.kind, proc: f.proc, message: f.message, count: f.count, first: f.first, last: f.last, tags: f.tags, version: f.version,
    ...(f.returned ? { returned: f.returned } : {}), notes: f.notes, ...(f.fix ? { fix: f.fix } : {}), ...(f.investigating ? { investigating: f.investigating } : {}),
    occurrences: f.occurrences.map(o => ({ ts: o.ts, version: o.version, commit: o.commit, proc: o.proc, kind: o.kind, stack: o.stack, context: o.context })),
  }
}

function humanShow(f: FaultDetail, now: number): string {
  const lines: string[] = []
  const row = (k: string, v: string): void => { lines.push(`${k.padEnd(11)}${v}`) }
  row('falha', f.id)
  row('assinatura', f.sig)
  row('estado', `${statusLabel(f.status)}${f.investigating ? ` (${f.investigating.by}, ${relativeTime(f.investigating.ts, now)})` : ''}`)
  const back = returnedText(f)
  if (back) row('', back)
  row('processo', f.proc)
  row('tipo', kindLabel(f.kind))
  row('ocorreu', `${f.count}×`)
  row('primeira', `${localTime(f.first)} (${relativeTime(f.first, now)})`)
  row('última', `${localTime(f.last)} (${relativeTime(f.last, now)})`)
  const versions = [...new Set(f.occurrences.map(o => o.version))]
  if (versions.length) row('versões', versions.join(', '))
  if (f.tags.length) row('etiquetas', f.tags.map(t => `#${t}`).join(' '))
  row('fix', f.fix ? `${f.fix.commit ?? 'sem commit'} (${localTime(f.fix.ts)}${f.fix.by ? `, ${f.fix.by}` : ''})` : '-')
  lines.push('', f.message, '')
  const latest = f.occurrences[0]
  if (latest) {
    lines.push('stack (da última ocorrência):', ...(latest.stack ? latest.stack.split('\n').map(l => `  ${l.trimEnd()}`) : ['  (sem stack)']), '')
    const ctx = Object.entries(latest.context)
    if (ctx.length) lines.push('contexto:', ...ctx.map(([k, v]) => `  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`), '')
  }
  lines.push(`ocorrências (${f.occurrences.length}${f.occurrenceTotal > f.occurrences.length ? ` de ${f.occurrenceTotal}; --all mostra todas` : ''}):`)
  for (const o of f.occurrences) lines.push(`  ${localTime(o.ts)}  v${o.version.replace(/^v/, '')}${o.commit ? `  ${o.commit.slice(0, 7)}` : ''}  ${o.proc}`)
  lines.push('', f.notes.length ? `notas (${f.notes.length}):` : 'notas: nenhuma')
  for (const n of f.notes) lines.push(`  ${localTime(n.ts)}  ${n.author}: ${n.text}`)
  return lines.join('\n') + '\n'
}

function notFound(r: Parameters<typeof describeNotFound>[0], io: FaultsIo): number {
  io.err(`tether: ${describeNotFound(r)}\n`)
  return r.code === 'ambiguous' ? 2 : 1
}

// ---- writes -------------------------------------------------------------------------------------

const STATUS_AFTER: Record<FaultAction['type'], FaultStatus | undefined> = { investigate: 'investigating', done: 'done', ignore: 'ignored', reopen: 'open', tag: undefined, note: undefined }

function write(
  argv: string[], dir: string, io: FaultsIo, spec: { valued?: string[] },
  action: (p: ParsedArgs) => FaultAction, say: (id: string, status: FaultStatus, f: { fix?: { commit?: string } }) => string,
): number {
  const p = parseArgs(argv, { ...spec, flags: ['json'] })
  const ref = p.positional[0]
  if (!ref) throw new UsageError('informe a falha (o id, como a3f9)')
  const act = action(p)
  const r = applyAction(dir, ref, act, io.now)
  if (!r.ok) return failed(r, io)
  const status = STATUS_AFTER[act.type]!
  if (p.flags.has('json')) {
    io.out(JSON.stringify(stateJson(r.id, r.sig, r.state), null, 2) + '\n')
    return 0
  }
  io.out(r.changed ? `${say(r.id, status, r.state)}\n` : `${r.id} já está ${statusLabel(status)}\n`)
  return 0
}

function stateJson(id: string, sig: string, f: import('../core/faults.ts').FaultState): Record<string, unknown> {
  const { storm: _storm, ...rest } = f
  return { id, sig, ...rest }
}

function failed(r: Exclude<ReturnType<typeof applyAction>, { ok: true }>, io: FaultsIo): number {
  if (!('message' in r)) return notFound(r, io)
  io.err(`tether: ${r.code === 'unreadable' ? `estado ilegível; nada foi gravado (${r.message})` : r.message}\n`)
  return r.code === 'invalid' ? 2 : 1
}

function tag(argv: string[], dir: string, io: FaultsIo): number {
  const p = parseArgs(argv, { flags: ['remove', 'json'] })
  const [ref, ...tags] = p.positional
  if (!ref) throw new UsageError('informe a falha (o id, como a3f9)')
  if (!tags.length) throw new UsageError('informe ao menos uma etiqueta')
  const normalized = tags.map(normalizeTag)
  tags.forEach((t, i) => { if (normalized[i] !== t) io.err(`tether: etiqueta "${t}" gravada como "${normalized[i] || '(vazia)'}"\n`) })
  const remove = p.flags.has('remove')
  const r = applyAction(dir, ref, { type: 'tag', tags, remove }, io.now)
  if (!r.ok) return failed(r, io)
  if (p.flags.has('json')) {
    io.out(JSON.stringify(stateJson(r.id, r.sig, r.state), null, 2) + '\n')
    return 0
  }
  if (!r.changed) io.out(`${r.id}: ${remove ? 'nenhuma dessas etiquetas estava na falha' : 'já tem essas etiquetas'}\n`)
  else io.out(`${r.id}: ${remove ? '- ' : '+ '}${(r.touchedTags ?? []).join(', ')}\n`)
  return 0
}

function note(argv: string[], dir: string, io: FaultsIo, env: NodeJS.ProcessEnv): number {
  const p = parseArgs(argv, { valued: ['by'], flags: ['json'] })
  const [ref, ...words] = p.positional
  if (!ref) throw new UsageError('informe a falha (o id, como a3f9)')
  const text = [...words, ...p.rest].join(' ').trim()
  if (!text) throw new UsageError('escreva a nota depois do id')
  const r = applyAction(dir, ref, { type: 'note', author: authorOf(p.options.by, env), text }, io.now)
  if (!r.ok) return failed(r, io)
  if (p.flags.has('json')) {
    io.out(JSON.stringify(stateJson(r.id, r.sig, r.state), null, 2) + '\n')
    return 0
  }
  io.out(`${r.id}: nota gravada\n`)
  return 0
}
