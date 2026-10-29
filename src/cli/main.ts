// CLI entry point (`bin/tether.mjs`): a client of tetherd. Every command talks to the daemon when it answers;
// `ls`/`show`/`stop`/`rm`/`rename` fall back to the store on disk, and `new`/`open` run the agent in this
// terminal (`--here`, or when there is no daemon). Output in Portuguese; exit codes 0 ok / 1 error / 2 usage.
import { execFile } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { exitCodeFor, formatReport, runDoctor } from '../doctor.ts'
import type { Binding, SlotMeta } from '../core/event.ts'
import { pidExists } from '../core/liveness.ts'
import { canonicalDir, slotMetaPath } from '../core/paths.ts'
import { createSlot, currentBinding, newSlotId, readEvents, readRun, readSlot, removeSlot } from '../core/store.ts'
import { DaemonClient, DaemonError } from '../daemon/client.ts'
import type { ErrorCode, SlotKind, SlotState } from '../daemon/protocol.ts'
import { parseArgs, UsageError } from './args.ts'
import { attach } from './attach.ts'
import { localTime, relativeTime, shortId, statusLabel, table, truncate, truncateStart } from './format.ts'
import { adapters, planFor, runHere } from './here.ts'
import { context, lastActivity, resolveSlot, SlotNotFound, statesFromStore, tryConnect, type Context } from './slots.ts'

export const USAGE = `uso: tether <comando> [opções]

  ls [--json]                         lista os slots (--json: estado bruto)
  show <slot>                         vínculo e histórico de eventos do slot
  new <claude|soul|shell> [--name n] [--cwd p] [--here] [-- args do agente]
                                      cria um slot e abre o agente nele
  open <slot> [--new|--resume-anyway] [--here]
                                      retoma o slot (--new: nova sessão)
  attach <slot>                       anexa este terminal ao slot (Ctrl+] solta)
  stop <slot>                         encerra o processo do slot (o vínculo fica)
  rm <slot> [--yes]                   esquece o slot (não apaga a sessão do agente)
  rename <slot> <nome>                renomeia o slot
  doctor                              confere o ambiente
  help                                esta ajuda

<slot> aceita o id, um prefixo único do id ou o nome. --here roda o agente neste
terminal em vez do tetherd (é o padrão quando o tetherd não está rodando).
`

const out = (text: string): void => { process.stdout.write(text) }
const err = (text: string): void => { process.stderr.write(text) }

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  try {
    switch (command) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        out(USAGE)
        return 0
      case 'doctor': {
        const results = await runDoctor()
        out(formatReport(results))
        return exitCodeFor(results)
      }
      case 'ls': return await cmdLs(rest)
      case 'show': return await cmdShow(rest)
      case 'new': return await cmdNew(rest)
      case 'open': return await cmdOpen(rest)
      case 'attach': return await cmdAttach(rest)
      case 'stop': return await cmdStop(rest)
      case 'rm': return await cmdRm(rest)
      case 'rename': return await cmdRename(rest)
      default:
        throw new UsageError(`comando desconhecido: ${command}`, true)
    }
  } catch (e) {
    if (e instanceof UsageError) {
      err(`tether: ${e.message}${e.showUsage ? `\n\n${USAGE}` : ' (veja: tether help)\n'}`)
      return 2
    }
    err(`tether: ${(e as Error).message}\n`)
    return 1
  }
}

// ---- helpers -----------------------------------------------------------------------------------

/** The slots as the daemon sees them, else from the store; the client stays open when there is one. */
async function loadSlots(ctx: Context): Promise<{ client: DaemonClient | undefined; slots: SlotState[] }> {
  const client = await tryConnect(ctx)
  if (!client) return { client: undefined, slots: statesFromStore(ctx.home) }
  const reply = await client.request({ t: 'list' })
  return { client, slots: reply.slots ?? [] }
}

function requireRef(positional: string[], what = 'slot'): string {
  const ref = positional[0]
  if (!ref) throw new UsageError(`informe o ${what}`)
  return ref
}

function daemonDown(): void {
  err('tetherd parado: lendo o estado do disco\n')
}

/** The daemon's refusal, with what to do about it. */
function explain(code: ErrorCode, message: string, slotId: string): string {
  switch (code) {
    case 'unconfirmed':
      return `vínculo não confirmado (a última execução não registrou a sessão).\n` +
        `  nova sessão:         tether open ${slotId} --new\n` +
        `  retomar mesmo assim: tether open ${slotId} --resume-anyway`
    case 'session-missing':
      return `${message}.\n  abra uma nova sessão: tether open ${slotId} --new`
    case 'cwd-missing':
      return `${message}.\n  recrie a pasta ou esqueça o slot: tether rm ${slotId}`
    case 'already-open':
      return `${message}.\n  veja com tether attach <slot>, ou encerre antes com tether stop <slot>`
    default:
      return message
  }
}

function slotCreatedLine(slot: Pick<SlotState, 'slotId' | 'kind' | 'status'> & { name?: string }): string {
  const name = slot.name ? ` "${slot.name}"` : ''
  return `slot ${slot.slotId}${name} criado (${slot.kind}, ${statusLabel(slot.status)}).\n` +
    `  abra no app, ou: tether attach ${slot.slotId}\n`
}

function resumeHint(slot: SlotState): string {
  return `slot ${slot.slotId} ${statusLabel(slot.status)}${slot.pid ? ` (pid ${slot.pid})` : ''}.\n` +
    `  abra no app, ou: tether attach ${slot.slotId}\n`
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await new Promise<string>((r) => rl.question(question, r))
    return /^s(im)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

/** Kills a process tree by pid (a `--here` run from another terminal). */
function killByPid(pid: number): Promise<void> {
  return new Promise((done) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => done())
    } else {
      try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
      done()
    }
  })
}

// ---- ls / show ---------------------------------------------------------------------------------

async function cmdLs(args: string[]): Promise<number> {
  const p = parseArgs(args, { flags: ['json'] })
  const ctx = context()
  const { client, slots } = await loadSlots(ctx)
  client?.close()
  if (p.flags.has('json')) {
    out(JSON.stringify(slots, null, 2) + '\n')
    return 0
  }
  if (!client) daemonDown()
  if (slots.length === 0) {
    out('nenhum slot. Crie um com: tether new claude\n')
    return 0
  }
  const rows = slots.map((s) => [
    s.slotId,
    s.name ?? '-',
    s.kind,
    truncateStart(s.cwd, 40),
    shortId(s.binding?.sessionId),
    truncate(s.title ?? '-', 32),
    statusLabel(s.status) + (s.error ? ` (${s.error.code})` : ''),
    relativeTime(lastActivity(ctx.home, s.slotId)),
  ])
  out(table(['SLOT', 'NOME', 'AGENTE', 'PASTA', 'SESSÃO', 'TÍTULO', 'ESTADO', 'ÚLTIMA ATIVIDADE'], rows))
  return 0
}

async function cmdShow(args: string[]): Promise<number> {
  const p = parseArgs(args)
  const ref = requireRef(p.positional)
  const ctx = context()
  const { client, slots } = await loadSlots(ctx)
  client?.close()
  if (!client) daemonDown()
  const slot = resolveSlot(slots, ref)
  const meta = readSlot(ctx.home, slot.slotId)
  const events = readEvents(ctx.home, slot.slotId)
  const lines: string[] = []
  const row = (k: string, v: string): void => { lines.push(`${k.padEnd(9)}${v}`) }
  row('slot', slot.slotId)
  row('nome', slot.name ?? '-')
  row('agente', slot.kind)
  row('pasta', slot.cwd)
  if (meta) row('criado', localTime(meta.createdAt))
  if (meta && meta.args.length) row('args', meta.args.join(' '))
  row('estado', statusLabel(slot.status) + (slot.pid ? ` (pid ${slot.pid})` : ''))
  if (slot.error) row('erro', `${slot.error.message} (${slot.error.code})`)
  const b = slot.binding
  if (b) {
    row('sessão', b.sessionId)
    row('título', slot.title ?? b.title ?? '-')
    row('desde', `${localTime(b.since)} (${relativeTime(b.since)})`)
    row('vínculo', `${b.confirmed ? 'confirmado' : 'não confirmado'}${b.ended ? ', sessão encerrada' : ''}`)
    if (b.resume) row('receita', `${b.agent} ${b.resume.args.join(' ')}  em ${b.resume.cwd}`)
  } else {
    row('sessão', slot.kind === 'shell' ? '- (shell não tem sessão)' : '- (nenhum evento ainda)')
  }
  lines.push('')
  lines.push(`eventos (${events.length}):`)
  for (const e of events) {
    const extra = [e.title ? `"${e.title}"` : '', e.cwd ?? ''].filter(Boolean).join('  ')
    lines.push(`  ${localTime(e.ts)}  ${e.kind.padEnd(6)} ${e.source.padEnd(8)} ${shortId(e.sessionId)}  ${extra}`.trimEnd())
  }
  out(lines.join('\n') + '\n')
  return 0
}

// ---- new / open --------------------------------------------------------------------------------

function parseKind(x: string | undefined): SlotKind {
  if (x === 'claude' || x === 'soul' || x === 'shell') return x
  throw new UsageError(`agente inválido: ${x ?? '(vazio)'} (use claude, soul ou shell)`)
}

async function cmdNew(args: string[]): Promise<number> {
  const p = parseArgs(args, { valued: ['name', 'cwd'], flags: ['here'] })
  const kind = parseKind(p.positional[0])
  const cwd = canonicalDir(p.options.cwd ?? process.cwd())
  if (!existsSync(cwd)) throw new Error(`a pasta não existe: ${cwd}`)
  const name = p.options.name
  const ctx = context()
  const here = p.flags.has('here')
  const client = here ? undefined : await tryConnect(ctx)
  if (client) {
    try {
      const reply = await client.request({ t: 'create', kind, cwd, ...(name ? { name } : {}), args: p.rest, start: true })
      out(slotCreatedLine(reply.slot!))
      return 0
    } finally {
      client.close()
    }
  }
  if (!here) err('tetherd parado: rodando neste terminal\n')
  const meta: SlotMeta = { v: 1, slotId: newSlotId(ctx.home), agent: kind, cwd, args: p.rest, createdAt: new Date().toISOString() }
  if (name) meta.name = name
  createSlot(ctx.home, meta)
  const plan = planFor(ctx.home, meta, undefined, [])
  err(`slot ${meta.slotId}${name ? ` "${name}"` : ''} criado; ${kind} neste terminal (${plan.command})\n`)
  const r = await runHere(ctx.home, meta.slotId, plan)
  return r.exitCode
}

async function cmdOpen(args: string[]): Promise<number> {
  const p = parseArgs(args, { flags: ['new', 'here', 'resume-anyway'] })
  const ref = requireRef(p.positional)
  if (p.flags.has('new') && p.flags.has('resume-anyway')) throw new UsageError('--new e --resume-anyway são excludentes')
  const choice = p.flags.has('new') ? 'new' : p.flags.has('resume-anyway') ? 'resume' : undefined
  const ctx = context()
  const here = p.flags.has('here')
  const { client, slots } = await loadSlots(ctx)
  const slot = resolveSlot(slots, ref)
  if (client && !here) {
    try {
      const reply = await client.request({ t: 'start', slotId: slot.slotId, ...(choice ? { choice } : {}) })
      out(resumeHint(reply.slot!))
      return 0
    } catch (e) {
      if (e instanceof DaemonError) {
        err(`tether: ${explain(e.code, e.message, slot.slotId)}\n`)
        return 1
      }
      throw e
    } finally {
      client.close()
    }
  }
  client?.close()
  if (!client && !here) err('tetherd parado: rodando neste terminal\n')
  return openHere(ctx, slot, slots, choice)
}

/** `open --here`: the daemon's trust rules, applied by the CLI before running in this terminal. */
async function openHere(ctx: Context, slot: SlotState, slots: SlotState[], choice: 'new' | 'resume' | undefined): Promise<number> {
  const meta = readSlot(ctx.home, slot.slotId)
  if (!meta) throw new Error(`slot sem metadados no disco: ${slot.slotId}`)
  if (slot.status === 'running' || slot.status === 'starting' || slot.status === 'queued') {
    throw new Error(`o slot ${slot.slotId} já está ${statusLabel(slot.status)}${slot.pid ? ` (pid ${slot.pid})` : ''}.\n  veja com: tether attach ${slot.slotId}`)
  }
  const fail = (code: ErrorCode, message: string): Error => new Error(explain(code, message, slot.slotId))
  if (slot.status === 'unconfirmed' && !choice) throw fail('unconfirmed', '')
  const binding: Binding | undefined = choice === 'new' ? undefined : currentBinding(readEvents(ctx.home, slot.slotId), meta)
  if (binding) {
    if (!binding.confirmed && !choice) throw fail('unconfirmed', '')
    if (!existsSync(binding.cwd)) throw fail('cwd-missing', `a pasta não existe: ${binding.cwd}`)
    const exists = await adapters[binding.agent].sessionExists(binding)
    if (exists === false) throw fail('session-missing', `a sessão ${binding.sessionId} não existe mais no ${binding.agent}`)
    const other = slots.find((s) => s.slotId !== slot.slotId && s.pid !== undefined && s.binding?.sessionId === binding.sessionId)
    if (other) throw fail('already-open', `a sessão já está aberta no slot ${other.slotId}`)
  } else if (meta.agent !== 'shell') {
    if (!existsSync(meta.cwd)) throw fail('cwd-missing', `a pasta não existe: ${meta.cwd}`)
    err(choice === 'new' ? 'iniciando nova sessão\n' : 'sem sessão registrada: iniciando nova\n')
  }
  const plan = planFor(ctx.home, meta, binding, [])
  err(`slot ${slot.slotId}: ${meta.agent} neste terminal (${plan.command}${binding ? `, retomando ${shortId(binding.sessionId)}` : ''})\n`)
  const r = await runHere(ctx.home, slot.slotId, plan)
  return r.exitCode
}

// ---- attach / stop / rm / rename ---------------------------------------------------------------

async function cmdAttach(args: string[]): Promise<number> {
  const p = parseArgs(args)
  const ref = requireRef(p.positional)
  const ctx = context()
  const client = await tryConnect(ctx)
  if (!client) throw new Error('tetherd parado: nada para anexar (abra o app, ou use tether open <slot> --here)')
  try {
    const slots = (await client.request({ t: 'list' })).slots ?? []
    const slot = resolveSlot(slots, ref)
    await attach(client, slot.slotId)
    return 0
  } finally {
    client.close()
  }
}

async function cmdStop(args: string[]): Promise<number> {
  const p = parseArgs(args)
  const ref = requireRef(p.positional)
  const ctx = context()
  const { client, slots } = await loadSlots(ctx)
  const slot = resolveSlot(slots, ref)
  if (client) {
    try {
      const reply = await client.request({ t: 'stop', slotId: slot.slotId })
      out(`slot ${slot.slotId} ${statusLabel(reply.slot!.status)}\n`)
      return 0
    } finally {
      client.close()
    }
  }
  daemonDown()
  const run = readRun(ctx.home, slot.slotId)
  if (!run || !pidExists(run.pid)) {
    out(`slot ${slot.slotId} já está parado\n`)
    return 0
  }
  await killByPid(run.agentPid ?? run.pid)
  out(`slot ${slot.slotId}: processo ${run.agentPid ?? run.pid} encerrado\n`)
  return 0
}

async function cmdRm(args: string[]): Promise<number> {
  const p = parseArgs(args, { flags: ['yes'] })
  const ref = requireRef(p.positional)
  const ctx = context()
  const { client, slots } = await loadSlots(ctx)
  try {
    const slot = resolveSlot(slots, ref)
    if (!p.flags.has('yes')) {
      if (!process.stdin.isTTY) throw new UsageError('sem terminal para confirmar: use --yes')
      const name = slot.name ? ` "${slot.name}"` : ''
      const ok = await confirm(`esquecer o slot ${slot.slotId}${name} (${slot.kind})? A sessão do agente não é apagada. [s/N] `)
      if (!ok) {
        out('cancelado\n')
        return 1
      }
    }
    if (client) {
      await client.request({ t: 'forget', slotId: slot.slotId })
    } else {
      const run = readRun(ctx.home, slot.slotId)
      if (run && pidExists(run.pid)) throw new Error(`o slot ${slot.slotId} está rodando (pid ${run.pid}); encerre-o antes: tether stop ${slot.slotId}`)
      removeSlot(ctx.home, slot.slotId)
    }
    out(`slot ${slot.slotId} esquecido\n`)
    return 0
  } finally {
    client?.close()
  }
}

async function cmdRename(args: string[]): Promise<number> {
  const p = parseArgs(args)
  const ref = requireRef(p.positional)
  const name = p.positional[1]
  if (name === undefined) throw new UsageError('informe o novo nome')
  const ctx = context()
  const { client, slots } = await loadSlots(ctx)
  try {
    const slot = resolveSlot(slots, ref)
    if (client) {
      await client.request({ t: 'rename-slot', slotId: slot.slotId, name })
    } else {
      const meta = readSlot(ctx.home, slot.slotId)
      if (!meta) throw new SlotNotFound(`slot sem metadados no disco: ${slot.slotId}`)
      if (name) meta.name = name
      else delete meta.name
      writeFileSync(slotMetaPath(ctx.home, meta.slotId), JSON.stringify(meta, null, 2) + '\n')
    }
    out(`slot ${slot.slotId} agora se chama "${name}"\n`)
    return 0
  } finally {
    client?.close()
  }
}
