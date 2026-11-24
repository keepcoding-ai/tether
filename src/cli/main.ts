// CLI entry point (`bin/tether.mjs`): a client of tetherd. Every command talks to the daemon when it answers;
// `ls`/`show`/`stop`/`rm`/`rename` fall back to the store on disk, and `new`/`open` run the agent in this
// terminal (`--here`, or when there is no daemon). Output in Portuguese; exit codes 0 ok / 1 error / 2 usage.
import { focusLink, openTetherUrl, ownTabUrl, parseFocusArgs } from './focus.ts'
import { execFile } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { exitCodeFor, formatReport, runDoctor } from '../doctor.ts'
import type { Binding, RunInfo, SlotMeta } from '../core/event.ts'
import { isSameProcess, pidExists } from '../core/liveness.ts'
import { slotMetaPath } from '../core/paths.ts'
import { canonicalDir } from '../core/paths-sync.ts'
import { findProfile, ProfileError, removeProfile, snapshotProfile, upsertProfile, type Profile, type ProfileAgent, type ProfileInput } from '../core/profile.ts'
import { readProfiles, writeProfiles } from '../core/profile-sync.ts'
import { createSlot, newSlotId, readEvents, readRun, readSlot, removeSlot, writeSlotMeta } from '../core/store-sync.ts'
import { currentBinding } from '../core/store-model.ts'
import { splitCommandLine } from '../agents/soul.ts'
import { DaemonClient, DaemonError } from '../daemon/client.ts'
import { KILL_WAIT_CAP_MS, MIN_AGENT_AGE_MS, type ErrorCode, type SlotKind, type SlotState } from '../daemon/protocol.ts'
import { parseArgs, UsageError } from './args.ts'
import { attach } from './attach.ts'
import { localTime, relativeTime, shortId, statusLabel, table, truncate, truncateStart } from './format.ts'
import { ownSlotOf, restartDaemon, selfShutdownMessage } from '../daemon/restart.ts'
import { agentChoices, agentRegistry } from '../agents/registry.ts'
import { cmdPause } from './pause.ts'
import { cmdRonda } from './ronda.ts'
import { cmdProc } from './proc.ts'
import { cmdVerb, helpWithVerbs } from './verb.ts'
import { adapterOf, planFor, profileFor, runHere } from './here.ts'
import { cmdUsage } from './usage.ts'
import { cmdTrace } from './trace.ts'
import { contributedTraceSources } from '../agents/load.ts'
import '../agents/load-sync.ts'
import { connectWithCause, context, lastActivity, resolveSlot, SlotNotFound, statesFromStore, tryConnect, type Context } from './slots.ts'

export const USAGE = `uso: tether <comando> [opções]

  ls [--json]                         lista os slots (--json: estado bruto)
  show <slot>                         vínculo e histórico de eventos do slot
  new <claude|soul|hands|shell> [--profile p] [--name n] [--cwd p] [--here] [-- args do agente]
                                      cria um slot e abre o agente nele (--profile: perfil de
                                      lançamento, pelo nome ou id; dispensa o agente)
  open <slot> [--new|--resume-anyway] [--here]
                                      retoma o slot (--new: nova sessão)
  attach <slot>                       anexa este terminal ao slot (Ctrl+] solta)
  stop <slot>                         encerra o processo do slot (o vínculo fica)
  rm <slot> [--yes]                   esquece o slot (não apaga a sessão do agente)
  rename <slot> <nome>                renomeia o slot
  profiles [--json]                   lista os perfis de lançamento
  profile add <claude|soul|hands|shell> <nome> [--default] [--env K=V]... [--cwd p]
              [--shell "exe args"] [-- args do agente]
                                      cria um perfil
  profile edit <perfil> [--name n] [--default|--no-default] [--env K=V]...
              [--cwd p] [--shell "exe args"] [-- args do agente]
                                      altera um perfil (args e env dados substituem os atuais)
  profile rm <perfil> [--yes]         apaga um perfil (os slots que o usam guardam uma cópia)
  profile set <slot> <perfil|--none> [--now|--next]
                                      troca o perfil de um slot (--none: nenhum). Com o agente
                                      rodando, --now reinicia já e retoma a mesma sessão;
                                      --next (padrão) deixa para o próximo início
  daemon <status|restart|stop> [--force]
                                      gerencia o tetherd (restart/stop encerram todos os agentes; os apps
                                      reconectam; recusado de dentro de um slot dele sem --force)
  pause ack "<frase>"                 avisa que você está preparando a parada (pausa gentil;
                                      dentro de um painel, ou com --slot)
  pause done "<nota>"                 registra a parada, com a nota de retomada
  pause status [--json]               mostra a pausa em andamento, slot a slot
  ronda [intervalo] [--nudge "<texto>"] [--criterion "<critério>"]
                                      liga a ronda deste painel (padrão 20m) ou a remonta: o
                                      tether cutuca o agente pelo canal da ronda quando ele está ocioso
  ronda --status [--json]             mostra a ronda deste painel
  ronda --off [--force]               desliga (com critério de parada, pergunta antes; --force
                                      desliga mesmo assim)
  proc <ls|info|start|wait|stop|restart|rm|use|release|ports|logs|history|host> …
                                      processos de fundo geridos pelo tether (servidores, workers):
                                      sobrevivem ao painel e ao tetherd (veja: tether proc help)
  <ns> <verbo> [args]                 verbo contribuído por uma extensão (precisa do tetherd; sem
                                      <verbo>, lista os do <ns>)
  link                                imprime o link tether:// deste painel (só dentro do tether)
  focus [arquivo|link] [--pad [panel|desk|global]] [--slot id]
                                      traz para a frente: o arquivo como nota (abre se não estiver
                                      aberta; relativo à pasta de abertura do painel), um link
                                      tether://, ou, sem nada, este painel.
                                      --pad abre a nota DENTRO de uma prancheta, abrindo-a na barra
                                      lateral se preciso: panel (padrão) = a do painel deste
                                      terminal, desk = a da mesa dele, global = a global. Uma nota
                                      aberta em outro lugar (mesa, outra prancheta, gaveta) MUDA
                                      para a prancheta; já lá, só vem para a frente. --slot: o painel
                                      (padrão: o deste terminal, TETHER_SLOT_ID)
  usage [--json] [--fresh]            uso de LLM do plano do Claude Code (limites e renovação)
  doctor                              confere o ambiente
  trace <id> [--json|--replay]        a linha do tempo de uma chamada do tether-bridge ou do
                                      tether-browser, pelo id que o erro mostra ("(call <id>…)")
  trace --last [n] [--json]           as últimas n chamadas com erro, para achar o id
  help                                esta ajuda

<slot> aceita o id, um prefixo único do id ou o nome; <perfil>, o id ou o nome.
--here roda o agente neste terminal em vez do tetherd (é o padrão quando o
tetherd não está rodando). O perfil vale a cada início do slot, inclusive na
retomada: editar o perfil muda o próximo início.
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
        out(await helpWithVerbs(USAGE, () => tryConnect(context())))
        return 0
      case 'doctor': {
        const results = await runDoctor()
        out(formatReport(results))
        return exitCodeFor(results)
      }
      case 'ls': return await cmdLs(rest)
      case 'link': out(`${ownTabUrl()}
`); return 0
      case 'focus': await openTetherUrl(focusLink(parseFocusArgs(rest))); return 0
      case 'usage': return await cmdUsage(rest, { out, err })
      case 'trace': return await cmdTrace(rest, { out, err, sources: contributedTraceSources })
      case 'show': return await cmdShow(rest)
      case 'new': return await cmdNew(rest)
      case 'open': return await cmdOpen(rest)
      case 'attach': return await cmdAttach(rest)
      case 'stop': return await cmdStop(rest)
      case 'rm': return await cmdRm(rest)
      case 'rename': return await cmdRename(rest)
      case 'profiles': return await cmdProfiles(rest)
      case 'profile': return await cmdProfile(rest)
      case 'daemon': return await cmdDaemon(rest)
      case 'pause': return await cmdPause(rest, { out, err, env: process.env })
      case 'ronda': return await cmdRonda(rest, { out, err, env: process.env, connect: () => tryConnect(context()) })
      case 'proc': return await cmdProc(rest, { out, err, env: process.env, home: context().home, cwd: process.cwd(), connect: () => tryConnect(context()) })
      default:
        // Not a built-in: a verb an extension contributed (`tether <ns> <verbo>`); the built-ins above always win.
        let failed: { pipe: string; cause: string } | undefined
        return await cmdVerb(command, rest, {
          out, err, env: process.env,
          connect: async () => {
            const r = await connectWithCause(context())
            if (!r.client) failed = { pipe: r.pipe, cause: r.cause ?? 'sem resposta' }
            return r.client
          },
          failure: () => failed,
        })
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
  if (!client) return { client: undefined, slots: statesFromStore(ctx.home, readProfiles(ctx.home).profiles) }
  const reply = await client.request({ t: 'list' })
  return { client, slots: reply.slots ?? [] }
}

/** The profiles as the daemon sees them, else from the file; the client stays open when there is one. */
async function loadProfiles(ctx: Context): Promise<{ client: DaemonClient | undefined; profiles: Profile[]; problem?: string }> {
  const client = await tryConnect(ctx)
  if (!client) {
    const read = readProfiles(ctx.home)
    return { client: undefined, profiles: read.profiles, ...(read.problem ? { problem: read.problem } : {}) }
  }
  const reply = await client.request({ t: 'profiles-list' })
  return { client, profiles: reply.profiles ?? [], ...(reply.problem ? { problem: reply.problem } : {}) }
}

function requireProfile(profiles: Profile[], ref: string): Profile {
  const p = findProfile(profiles, ref)
  if (!p) throw new Error(`perfil não encontrado: ${ref} (veja \`tether profiles\`)`)
  return p
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

function slotCreatedLine(slot: Pick<SlotState, 'slotId' | 'kind' | 'status'> & { name?: string; profileName?: string }): string {
  const name = slot.name ? ` "${slot.name}"` : ''
  const profile = slot.profileName ? `, perfil "${slot.profileName}"` : ''
  return `slot ${slot.slotId}${name} criado (${slot.kind}${profile}, ${statusLabel(slot.status)}).\n` +
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

/**
 * Kills a process tree by pid. Only ever pointed at a `--here` launcher (pid = the CLI that runs one agent) or
 * at an agent left by a dead tetherd; NEVER at a live tetherd, whose tree is every agent of every slot (that
 * one goes down through the pipe's `shutdown` only).
 */
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

/**
 * Waits until the run's agent is at least MIN_AGENT_AGE_MS old and has reported this run (start event at/after
 * the launch), capped at KILL_WAIT_CAP_MS: a Claude killed before it finishes starting counts as a boot strike.
 */
async function awaitKillable(home: string, slotId: string, run: RunInfo, meta: SlotMeta | undefined): Promise<void> {
  if (meta?.agent === 'shell') return
  const launchedAt = run.agentStartedAt ?? run.startedAt
  const ageDeadline = Date.parse(launchedAt) + MIN_AGENT_AGE_MS
  const cap = Date.now() + KILL_WAIT_CAP_MS
  let warned = false
  for (;;) {
    const now = Date.now()
    const binding = meta ? currentBinding(readEvents(home, slotId), meta) : undefined
    if (now >= ageDeadline && binding && binding.since >= launchedAt) return
    if (now >= cap || !pidExists(run.agentPid ?? run.pid)) return
    if (!warned) {
      warned = true
      out(`aguardando o agente terminar de iniciar antes de encerrar (até ${Math.round(KILL_WAIT_CAP_MS / 1000)} s)…\n`)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
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
    truncate(s.profileName ?? (s.profileId ? `${s.profileId} (apagado)` : '-'), 24) + (s.unsafe ? ' !' : ''),
    truncateStart(s.cwd, 40),
    shortId(s.binding?.sessionId),
    truncate(s.title ?? '-', 32),
    statusLabel(s.status) + (s.error ? ` (${s.error.code})` : ''),
    relativeTime(lastActivity(ctx.home, s.slotId)),
  ])
  out(table(['SLOT', 'NOME', 'AGENTE', 'PERFIL', 'PASTA', 'SESSÃO', 'TÍTULO', 'ESTADO', 'ÚLTIMA ATIVIDADE'], rows))
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
  if (slot.profileId) {
    row('perfil', slot.profileName ? `${slot.profileName} (${slot.profileId})` : `${slot.profileId} (apagado; usando a cópia guardada no slot)`)
    const snapshot = meta?.profileArgs ?? []
    if (snapshot.length) row('', `args do perfil: ${snapshot.join(' ')}`)
    if (meta?.profileEnv) row('', `env do perfil: ${Object.entries(meta.profileEnv).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  }
  if (slot.unsafe) row('atenção', 'roda sem confirmação de permissões (--dangerously-skip-permissions)')
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
  if (x !== undefined && (x === 'shell' || agentRegistry.has(x))) return x
  throw new UsageError(`agente inválido: ${x ?? '(vazio)'} (use ${agentChoices()})`)
}

async function cmdNew(args: string[]): Promise<number> {
  const p = parseArgs(args, { valued: ['name', 'cwd', 'profile'], flags: ['here'] })
  const ctx = context()
  const here = p.flags.has('here')
  const client = here ? undefined : await tryConnect(ctx)
  try {
    // The profile names the agent; a kind given as well must agree with it.
    let profile: Profile | undefined
    if (p.options.profile !== undefined) {
      const profiles = client ? (await client.request({ t: 'profiles-list' })).profiles ?? [] : readProfiles(ctx.home).profiles
      profile = requireProfile(profiles, p.options.profile)
      if (p.positional[0] !== undefined && p.positional[0] !== profile.agent) {
        throw new UsageError(`o perfil "${profile.name}" é de ${profile.agent}, não de ${p.positional[0]}`)
      }
    }
    const kind = profile?.agent ?? parseKind(p.positional[0])
    const cwd = canonicalDir(p.options.cwd ?? profile?.cwd ?? process.cwd())
    if (!existsSync(cwd)) throw new Error(`a pasta não existe: ${cwd}`)
    const name = p.options.name
    if (client) {
      const reply = await client.request({ t: 'create', kind, cwd, ...(name ? { name } : {}), args: p.rest, start: true, ...(profile ? { profileId: profile.id } : {}) })
      out(slotCreatedLine(reply.slot!))
      return 0
    }
    if (!here) err('tetherd parado: rodando neste terminal\n')
    const meta: SlotMeta = { v: 1, slotId: newSlotId(ctx.home), agent: kind, cwd, args: p.rest, createdAt: new Date().toISOString() }
    if (name) meta.name = name
    if (profile) meta.profileId = profile.id // planFor takes the snapshot
    createSlot(ctx.home, meta)
    const plan = await planFor(ctx.home, meta, undefined, [])
    err(`slot ${meta.slotId}${name ? ` "${name}"` : ''} criado; ${kind}${profile ? ` (perfil "${profile.name}")` : ''} neste terminal (${plan.command})\n`)
    const r = await runHere(ctx.home, meta.slotId, plan)
    return r.exitCode
  } finally {
    client?.close()
  }
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
    const env = profileFor(ctx.home, meta).launch?.env
    const exists = await adapterOf(binding.agent).sessionExists(binding, env ? { env } : {})
    if (exists === false) throw fail('session-missing', `a sessão ${binding.sessionId} não existe mais no ${binding.agent}`)
    const other = slots.find((s) => s.slotId !== slot.slotId && s.pid !== undefined && s.binding?.sessionId === binding.sessionId)
    if (other) throw fail('already-open', `a sessão já está aberta no slot ${other.slotId}`)
  } else if (meta.agent !== 'shell') {
    if (!existsSync(meta.cwd)) throw fail('cwd-missing', `a pasta não existe: ${meta.cwd}`)
    err(choice === 'new' ? 'iniciando nova sessão\n' : 'sem sessão registrada: iniciando nova\n')
  }
  const plan = await planFor(ctx.home, meta, binding, [])
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
  if (!run) {
    out(`slot ${slot.slotId} já está parado\n`)
    return 0
  }
  // A run of tetherd: run.pid is the daemon itself, whose tree is every agent of every slot. It is never killed
  // from here; a live daemon that does not answer is reported, a dead one may have left the agent alone.
  if (run.by === 'tetherd') {
    if (await isSameProcess(run.pid, run.startedAt)) throw new Error(`o tetherd (pid ${run.pid}) está no ar mas não respondeu; encerre pelo app, ou reinicie o tetherd`)
    const agentAlive = run.agentPid !== undefined && (run.agentStartedAt ? await isSameProcess(run.agentPid, run.agentStartedAt) : pidExists(run.agentPid))
    if (!agentAlive) {
      out(`slot ${slot.slotId} já está parado\n`)
      return 0
    }
  } else if (!(await isSameProcess(run.pid, run.startedAt))) {
    out(`slot ${slot.slotId} já está parado\n`)
    return 0
  }
  const target = run.agentPid ?? run.pid
  await awaitKillable(ctx.home, slot.slotId, run, readSlot(ctx.home, slot.slotId))
  await killByPid(target)
  out(`slot ${slot.slotId}: processo ${target} encerrado\n`)
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

// ---- profiles ----------------------------------------------------------------------------------

function envLine(env: Record<string, string> | undefined): string {
  return env ? Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ') : '-'
}

async function cmdProfiles(args: string[]): Promise<number> {
  const p = parseArgs(args, { flags: ['json'] })
  const ctx = context()
  const { client, profiles, problem } = await loadProfiles(ctx)
  client?.close()
  if (p.flags.has('json')) {
    out(JSON.stringify(profiles, null, 2) + '\n')
    return 0
  }
  if (problem) err(`atenção: ${problem}\n`)
  if (profiles.length === 0) {
    out('nenhum perfil. Crie um com: tether profile add claude "Claude" --default\n')
    return 0
  }
  const rows = profiles.map((x) => [
    x.id,
    x.name,
    x.agent,
    x.default ? 'sim' : '-',
    truncate((x.shell ? [x.shell.command, ...x.shell.args, ...x.args] : x.args).join(' ') || '-', 48),
    truncate(envLine(x.env), 32),
    truncateStart(x.cwd ?? '-', 32),
  ])
  out(table(['ID', 'NOME', 'AGENTE', 'PADRÃO', 'ARGS', 'ENV', 'PASTA'], rows))
  return 0
}

function parseAgent(x: string | undefined): ProfileAgent {
  if (x !== undefined && (x === 'shell' || agentRegistry.has(x))) return x
  throw new UsageError(`agente inválido: ${x ?? '(vazio)'} (use ${agentChoices()})`)
}

function parseEnv(pairs: string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const pair of pairs) {
    const eq = pair.indexOf('=')
    if (eq <= 0) throw new UsageError(`--env espera NOME=valor, recebeu ${JSON.stringify(pair)}`)
    env[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return env
}

function parseShell(line: string): { command: string; args: string[] } {
  const [command, ...args] = splitCommandLine(line)
  if (!command) throw new UsageError('--shell espera o executável (e seus args) entre aspas')
  return { command, args }
}

/** Saves through the daemon when it answers (it validates and tells every client), else straight to the file. */
async function saveProfile(ctx: Context, client: DaemonClient | undefined, input: ProfileInput): Promise<{ profile: Profile; warnings: string[] }> {
  if (client) {
    try {
      const reply = await client.request({ t: 'profile-save', profile: input })
      return { profile: reply.profile!, warnings: reply.warnings ?? [] }
    } catch (e) {
      if (e instanceof DaemonError) throw new Error(e.message)
      throw e
    }
  }
  try {
    const r = upsertProfile(readProfiles(ctx.home).profiles, input)
    writeProfiles(ctx.home, r.profiles)
    return { profile: r.profile, warnings: r.warnings }
  } catch (e) {
    if (e instanceof ProfileError) throw new Error(e.message)
    throw e
  }
}

async function cmdProfile(args: string[]): Promise<number> {
  const [sub, ...rest] = args
  switch (sub) {
    case 'add': return await cmdProfileAdd(rest)
    case 'edit': return await cmdProfileEdit(rest)
    case 'rm': return await cmdProfileRm(rest)
    case 'set': return await cmdProfileSet(rest)
    default: throw new UsageError(`subcomando de profile desconhecido: ${sub ?? '(vazio)'} (use add, edit, rm ou set)`)
  }
}

/** `profile set <slot> <perfil|--none> [--now|--next]`: through the daemon when it answers (only it can restart), else the meta on disk. */
async function cmdProfileSet(args: string[]): Promise<number> {
  const p = parseArgs(args, { flags: ['none', 'now', 'next'] })
  const ref = requireRef(p.positional)
  if (p.flags.has('now') && p.flags.has('next')) throw new UsageError('--now e --next são excludentes')
  const none = p.flags.has('none')
  const profileRef = p.positional[1]
  if (!none && !profileRef) throw new UsageError('informe o perfil (ou --none)')
  if (none && profileRef) throw new UsageError('--none dispensa o perfil')
  const ctx = context()
  const { client, slots } = await loadSlots(ctx)
  try {
    const slot = resolveSlot(slots, ref)
    const profiles = client ? (await client.request({ t: 'profiles-list' })).profiles ?? [] : readProfiles(ctx.home).profiles
    const profile = none ? undefined : requireProfile(profiles, profileRef!)
    if (profile && profile.agent !== slot.kind) throw new UsageError(`o perfil "${profile.name}" é de ${profile.agent}, não de ${slot.kind}`)
    const live = slot.status === 'running' || slot.status === 'starting'
    const restart = p.flags.has('now')
    const label = profile ? `perfil "${profile.name}"` : 'nenhum perfil'
    if (client) {
      try {
        const reply = await client.request({ t: 'set-profile', slotId: slot.slotId, profileId: profile ? profile.id : null, restart })
        const s = reply.slot!
        if (restart && live) out(`slot ${slot.slotId}: ${label}; ${slot.kind} reiniciado${s.binding ? `, sessão ${shortId(s.binding.sessionId)} retomada` : ''} (${statusLabel(s.status)}${s.pid ? `, pid ${s.pid}` : ''})\n`)
        else if (live) out(`slot ${slot.slotId}: ${label}; vale no próximo início (o ${slot.kind} continua rodando; para reiniciar já: tether profile set ${slot.slotId} ${none ? '--none' : profile!.id} --now)\n`)
        else out(`slot ${slot.slotId}: ${label}; vale no próximo início\n`)
        return 0
      } catch (e) {
        if (e instanceof DaemonError) {
          err(`tether: ${e.code === 'unconfirmed' ? `${e.message}.\n  na próxima abertura: tether profile set ${slot.slotId} ${none ? '--none' : profile!.id} --next` : e.message}\n`)
          return 1
        }
        throw e
      }
    }
    if (restart) throw new Error('tetherd parado: não há processo para reiniciar (sem --now o perfil é gravado para o próximo início)')
    daemonDown()
    const meta = readSlot(ctx.home, slot.slotId)
    if (!meta) throw new SlotNotFound(`slot sem metadados no disco: ${slot.slotId}`)
    if (profile) snapshotProfile(meta, profile)
    else { delete meta.profileId; delete meta.profileArgs; delete meta.profileEnv }
    writeSlotMeta(ctx.home, meta)
    out(`slot ${slot.slotId}: ${label}; vale no próximo início\n`)
    return 0
  } finally {
    client?.close()
  }
}

function printSaved(profile: Profile, warnings: string[], verb: string): void {
  for (const w of warnings) err(`atenção: ${w}\n`)
  const what = profile.shell ? [profile.shell.command, ...profile.shell.args, ...profile.args] : profile.args
  out(`perfil "${profile.name}" (${profile.id}, ${profile.agent}${profile.default ? ', padrão' : ''}) ${verb}` +
    `${what.length ? `: ${profile.agent} ${what.join(' ')}` : ''}\n`)
}

async function cmdProfileAdd(args: string[]): Promise<number> {
  const p = parseArgs(args, { valued: ['cwd', 'shell'], flags: ['default'], multi: ['env'] })
  const agent = parseAgent(p.positional[0])
  const name = p.positional[1]
  if (!name) throw new UsageError('informe o nome do perfil')
  const input: ProfileInput = { name, agent, args: p.rest }
  if (p.multi.env) input.env = parseEnv(p.multi.env)
  if (p.options.cwd) input.cwd = canonicalDir(p.options.cwd)
  if (p.options.shell) {
    if (agent !== 'shell') throw new UsageError('--shell só vale para perfis de shell')
    input.shell = parseShell(p.options.shell)
  }
  if (p.flags.has('default')) input.default = true
  const ctx = context()
  const client = await tryConnect(ctx)
  try {
    const { profile, warnings } = await saveProfile(ctx, client, input)
    printSaved(profile, warnings, 'criado')
    return 0
  } finally {
    client?.close()
  }
}

async function cmdProfileEdit(args: string[]): Promise<number> {
  const p = parseArgs(args, { valued: ['name', 'cwd', 'shell'], flags: ['default', 'no-default', 'no-cwd', 'no-env'], multi: ['env'] })
  const ref = requireRef(p.positional, 'perfil')
  if (p.flags.has('default') && p.flags.has('no-default')) throw new UsageError('--default e --no-default são excludentes')
  const ctx = context()
  const { client, profiles } = await loadProfiles(ctx)
  try {
    const current = requireProfile(profiles, ref)
    const input: ProfileInput = { ...current }
    if (p.options.name !== undefined) input.name = p.options.name
    if (args.includes('--')) input.args = p.rest
    if (p.multi.env) input.env = parseEnv(p.multi.env)
    if (p.flags.has('no-env')) delete input.env
    if (p.options.cwd !== undefined) input.cwd = canonicalDir(p.options.cwd)
    if (p.flags.has('no-cwd')) delete input.cwd
    if (p.options.shell !== undefined) {
      if (current.agent !== 'shell') throw new UsageError('--shell só vale para perfis de shell')
      input.shell = parseShell(p.options.shell)
    }
    if (p.flags.has('default')) input.default = true
    if (p.flags.has('no-default')) delete input.default
    const { profile, warnings } = await saveProfile(ctx, client, input)
    printSaved(profile, warnings, 'alterado')
    return 0
  } finally {
    client?.close()
  }
}

async function cmdProfileRm(args: string[]): Promise<number> {
  const p = parseArgs(args, { flags: ['yes'] })
  const ref = requireRef(p.positional, 'perfil')
  const ctx = context()
  const { client, profiles } = await loadProfiles(ctx)
  try {
    const profile = requireProfile(profiles, ref)
    if (!p.flags.has('yes')) {
      if (!process.stdin.isTTY) throw new UsageError('sem terminal para confirmar: use --yes')
      const ok = await confirm(`apagar o perfil "${profile.name}" (${profile.agent})? Os slots que o usam guardam uma cópia. [s/N] `)
      if (!ok) {
        out('cancelado\n')
        return 1
      }
    }
    if (client) {
      await client.request({ t: 'profile-delete', profileId: profile.id })
    } else {
      writeProfiles(ctx.home, removeProfile(profiles, profile.id))
    }
    out(`perfil "${profile.name}" apagado\n`)
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

// ---- daemon ------------------------------------------------------------------------------------

async function cmdDaemon(args: string[]): Promise<number> {
  const p = parseArgs(args, { flags: ['force'] })
  const sub = p.positional[0]
  const ctx = context()
  switch (sub) {
    case 'status': {
      const client = await tryConnect(ctx)
      if (!client) { out(`tetherd parado (${ctx.pipe})\n`); return 1 }
      const slots = (await client.request({ t: 'list' })).slots ?? []
      client.close()
      const running = slots.filter((s) => s.status === 'running').length
      out(`tetherd pid ${client.hello.pid} (${client.hello.version}), ${running} de ${slots.length} slots rodando\n  ${ctx.pipe}\n`)
      return 0
    }
    case 'restart': {
      if (await refusesSelfShutdown(ctx, 'restart', p.flags.has('force'))) return 1
      const procs = await liveProcs(ctx)
      const { previous, current } = await restartDaemon({ home: ctx.home, pipe: ctx.pipe })
      out(previous
        ? `tetherd reiniciado: pid ${previous.pid} → ${current.pid}\n  os agentes foram encerrados; os apps abertos reconectam e retomam as sessões\n${procsKeepRunning(procs)}`
        : `tetherd estava parado; subiu o pid ${current.pid}\n`)
      return 0
    }
    case 'stop': {
      if (await refusesSelfShutdown(ctx, 'stop', p.flags.has('force'))) return 1
      const client = await tryConnect(ctx)
      if (!client) { out('tetherd já está parado\n'); return 0 }
      const procs = await liveProcs(ctx)
      await client.request({ t: 'shutdown' })
      client.close()
      out(`tetherd (pid ${client.hello.pid}) encerrando; os agentes dos slots foram parados\n${procsKeepRunning(procs)}`)
      return 0
    }
    default:
      throw new UsageError('use: tether daemon status | restart | stop [--force]')
  }
}

/** How many background processes run (they live in tether-procd, not in tetherd); 0 when tetherd cannot tell. */
async function liveProcs(ctx: Context): Promise<number> {
  const client = await tryConnect(ctx)
  if (!client) return 0
  try {
    const procs = (await client.request({ t: 'proc-list' })).procs ?? []
    return procs.filter((p) => p.status === 'running' || p.status === 'stopping').length
  } catch {
    return 0 // an older tetherd without proc-list
  } finally {
    client.close()
  }
}

function procsKeepRunning(n: number): string {
  if (!n) return ''
  return n === 1 ? '  1 processo de fundo segue rodando no anfitrião (tether proc ls)\n' : `  ${n} processos de fundo seguem rodando no anfitrião (tether proc ls)\n`
}

/**
 * A restart/stop asked from a terminal that the target daemon itself runs (one of its slots) would kill the
 * session asking for it: refused unless --force. Nothing to refuse when no daemon answers.
 */
async function refusesSelfShutdown(ctx: Context, action: 'restart' | 'stop', force: boolean): Promise<boolean> {
  if (force) return false
  const client = await tryConnect(ctx)
  if (!client) return false
  try {
    const slotId = ownSlotOf((await client.request({ t: 'list' })).slots ?? [])
    if (!slotId) return false
    err(selfShutdownMessage(action, slotId))
    return true
  } finally {
    client.close()
  }
}
