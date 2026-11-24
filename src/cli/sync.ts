// `tether sync`: the person's profile (desks, profiles, agents' slots, preferences, shortcuts) kept in a git repo.
//   sync connect <url>      links this machine to the repo and runs the first sync
//   sync status [--json]    what is linked, what is pending, how the last sync went (no network)
//   sync now [--json]       one sync: send what changed here, bring what changed there
//   sync disconnect         unlinks (the files stay)
// The engine runs in THIS process (the app's main and tetherd must stay free of synchronous fs). The desk arrangement
// (layout.json) belongs to the renderer while the app is open, so with the app open and no `--from-app` the command does
// not run the engine: it hands `tether://sync/now` to the app and waits for the report the app's own run leaves in
// <home>/sync-last.json. The app calls `tether sync now --from-app --json` itself, after making sure the renderer will not
// overwrite the arrangement, and reloads the window afterwards.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { pidExists } from '../core/liveness.ts'
import { samePath, tetherHome, userDir } from '../core/paths.ts'
import { readProfiles } from '../core/profile-sync.ts'
import { storageRoots } from '../core/storage/areas.ts'
import { createDiskPorts } from '../core/sync/disk-ports.ts'
import { createSyncEngine, type SyncReport } from '../core/sync/engine.ts'
import { SyncError, type SyncProvider } from '../core/sync/provider.ts'
import { createGitProvider, maskUrl, type GitProviderOpts } from '../core/sync/providers/git.ts'
import type { DaemonClient } from '../daemon/client.ts'
import { parseArgs, UsageError } from './args.ts'
import { openTetherUrl } from './focus.ts'

export const SYNC_USAGE = 'uso: tether sync connect <url> [--machine <rótulo>] | status [--json] | now [--json] | disconnect'

export const SYNC_LINK = 'tether://sync/now'
/** How long a command that handed the work to the app waits for its report. */
export const DELEGATE_WAIT_MS = 120_000

export interface SyncConfig {
  provider: 'git'
  url: string
  machine: string
  /** Set by a first `connect` until its first run succeeds: a failure before that leaves no link behind. */
  pending?: true
  /** The sync folder this connection uses (userDir/sync when it was made). A command that resolves another folder refuses. */
  dir?: string
}

export interface SyncLast {
  at: string
  ok: boolean
  error?: { code: string; message: string }
  report: SyncReport | null
}

export interface SyncIo {
  out: (text: string) => void
  err: (text: string) => void
  env: NodeJS.ProcessEnv
  /** A connected tetherd, or undefined. Asked only when a run is about to start. */
  connect: () => Promise<DaemonClient | undefined>
  /** Defaults to tetherHome(env). */
  home?: string
  /** The person's home folder for the places that travel as "home"; default: the OS's (tests set their own). */
  homedir?: string
  /** Is the Electron app of this home open? Default: appIsOpen. */
  appRunning?: (home: string) => boolean
  /** Hands a tether:// link to the OS (the app). Default: openTetherUrl. */
  openLink?: (url: string) => Promise<void>
  createProvider?: (opts: GitProviderOpts) => SyncProvider
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** How long to wait for the app's report. */
  delegateWaitMs?: number
  pollMs?: number
}

// ---- files of the home -----------------------------------------------------------------------------------------------

const configPath = (home: string): string => join(home, 'sync.json')
const lastPath = (home: string): string => join(home, 'sync-last.json')
const lockPath = (home: string): string => join(home, 'sync.lock')
const trashDir = (home: string): string => join(home, 'sync-trash')

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined }
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmp, file)
}

export function readSyncConfig(home: string): SyncConfig | undefined {
  const doc = readJson(configPath(home))
  if (!isObject(doc) || doc.provider !== 'git' || typeof doc.url !== 'string' || !doc.url || typeof doc.machine !== 'string' || !doc.machine) return undefined
  return {
    provider: 'git', url: doc.url, machine: doc.machine,
    ...(doc.pending === true ? { pending: true as const } : {}),
    ...(typeof doc.dir === 'string' && doc.dir ? { dir: doc.dir } : {}),
  }
}

export function readSyncLast(home: string): SyncLast | undefined {
  const doc = readJson(lastPath(home))
  if (!isObject(doc) || typeof doc.at !== 'string' || typeof doc.ok !== 'boolean') return undefined
  return doc as unknown as SyncLast
}

/** A short label for this machine, made once (hostname, lower case, letters digits and dashes). */
export function machineLabel(host: string = hostname()): string {
  const label = host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  return label || 'maquina'
}

// ---- one run at a time ------------------------------------------------------------------------------------------------

class SyncBusy extends Error {}

/** `<home>/sync.lock`: exclusive create holding our pid; the lock of a dead process is taken over. Returns the release. */
export function acquireSyncLock(home: string, pid: number = process.pid): () => void {
  const file = lockPath(home)
  mkdirSync(home, { recursive: true })
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(file, String(pid), { flag: 'wx' })
      return () => { try { if (readFileSync(file, 'utf8').trim() === String(pid)) rmSync(file, { force: true }) } catch { /* gone */ } }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    let owner = NaN
    try { owner = Number.parseInt(readFileSync(file, 'utf8').trim(), 10) } catch { /* vanished: try again */ }
    if (Number.isInteger(owner) && owner > 0 && pidExists(owner)) throw new SyncBusy(`outra sincronização está em andamento (processo ${owner}); espere ela terminar`)
    rmSync(file, { force: true }) // stale: its process is gone
  }
  throw new SyncBusy('não consegui reservar a sincronização (outra execução disputou a vez); tente de novo')
}

// ---- is the app open? ---------------------------------------------------------------------------------------------------

/**
 * Whether the Electron app of this home is running, read from Chromium's single-instance lock in `<home>/electron`
 * (the app's userData): on Windows the `lockfile` is held open by the app (and its helpers) so opening it for writing
 * fails with EBUSY; on macOS/Linux `SingletonLock` is a symlink to `<host>-<pid>`.
 */
export function appIsOpen(home: string, platform: NodeJS.Platform = process.platform): boolean {
  const dir = join(home, 'electron')
  if (platform === 'win32') {
    try {
      closeSync(openSync(join(dir, 'lockfile'), 'r+'))
      return false
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
    }
  }
  try {
    const pid = Number.parseInt(readlinkSync(join(dir, 'SingletonLock')).split('-').pop() ?? '', 10)
    return pidExists(pid)
  } catch { return false }
}

// ---- words ---------------------------------------------------------------------------------------------------------------

function clock(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** A one-line message for what a person does about the failure; credentials in any URL are masked. */
export function describeSyncError(e: unknown): { code: string; message: string } {
  if (e instanceof SyncError) {
    switch (e.code) {
      case 'git-missing': return { code: e.code, message: 'o git não está instalado (ou não está no PATH): instale o git e tente de novo' }
      case 'auth': return { code: e.code, message: 'o remoto recusou o acesso: entre no git desta máquina (credencial ou chave SSH) e tente de novo' }
      case 'network': return { code: e.code, message: 'não consegui falar com o remoto: confira a URL e a conexão e tente de novo' }
      default: return { code: e.code, message: maskUrl(e.message) }
    }
  }
  return { code: 'error', message: maskUrl(e instanceof Error ? e.message : String(e)) }
}

export function describeReport(r: SyncReport, home: string, profileNames: ReadonlyMap<string, string> = new Map()): string {
  const lines: string[] = []
  if (r.connect) lines.push(r.connect.remoteEmpty ? 'Conectado. O remoto estava vazio: o seu perfil foi enviado.' : 'Conectado ao remoto.')
  const got: string[] = []
  if (r.applied.profiles) got.push('perfis')
  if (r.applied.layout) got.push(`mesas${r.arrivedDesks.length ? ` (${plural(r.arrivedDesks.length, 'nova', 'novas')})` : ''}`)
  if (r.applied.slots) got.push('terminais')
  if (r.applied.settings) got.push('preferências')
  if (r.applied.keybindings) got.push('atalhos')
  lines.push(got.length ? `Chegou: ${got.join(', ')}.` : 'Nada novo chegou.')
  const sent = r.written.length + r.removed.length
  lines.push(r.pushed ? `Enviado: ${plural(sent, 'item', 'itens')}.` : sent > 0 ? 'Nada foi enviado ainda (veja acima).' : 'Nada a enviar.')
  for (const c of r.conflicts) lines.push(`Conflito em ${c.path}: valeu a versão do remoto${c.trashed ? `; a sua ficou na lixeira (${trashDir(home)})` : ''}.`)
  if (r.pending.length) lines.push(`Aguardam uma pasta nesta máquina: ${r.pending.map((p) => `${p.slotId} (${p.place})`).join(', ')}.`)
  if (r.unmappedPlaces.length) lines.push(`Lugares sem pasta nesta máquina: ${r.unmappedPlaces.join(', ')}.`)
  for (const [id, names] of Object.entries(r.missingEnv)) {
    if (names.length) lines.push(`O perfil "${profileNames.get(id) ?? id}" precisa das variáveis de ambiente: ${names.join(', ')}.`)
  }
  if (r.behind) lines.push('O remoto continuou mudando durante o envio; rode de novo.')
  if (r.skipped.includes('layout')) lines.push('As mesas não foram sincronizadas: esta máquina ainda não tem um arranjo salvo (abra o app uma vez).')
  const others = r.skipped.filter((s) => s !== 'layout')
  if (others.length) lines.push(`Ignorados: ${others.join(', ')}.`)
  if (r.leaks.length) lines.push(`Atenção: caminhos desta máquina apareceram em ${plural(r.leaks.length, 'lugar', 'lugares')} enviados.`)
  return lines.join('\n') + '\n'
}

// ---- the command -----------------------------------------------------------------------------------------------------------

export async function cmdSync(argv: string[], io: SyncIo): Promise<number> {
  const a = parseArgs(argv, { valued: ['machine'], flags: ['json', 'from-app'] })
  const sub = a.positional[0]
  if (!sub) throw new UsageError(SYNC_USAGE)
  const home = io.home ?? tetherHome(io.env)
  const json = a.flags.has('json')
  const fromApp = a.flags.has('from-app')
  if (a.options.machine !== undefined && sub !== 'connect') throw new UsageError('--machine só vale com connect')
  if (fromApp && sub !== 'now' && sub !== 'connect') throw new UsageError('--from-app só vale com now')
  switch (sub) {
    case 'connect': {
      if (a.positional.length !== 2 || !a.positional[1]!.trim()) throw new UsageError(SYNC_USAGE)
      const url = a.positional[1]!.trim()
      const existing = readSyncConfig(home)
      if (existing && existing.url !== url) {
        io.err(`tether: esta máquina já está conectada a ${maskUrl(existing.url)}; rode "tether sync disconnect" antes de trocar\n`)
        return 1
      }
      const machine = a.options.machine?.trim() ? machineLabel(a.options.machine) : existing?.machine ?? machineLabel()
      if (existing && wrongDir(io, existing)) return 1
      if (!existing) writeJsonAtomic(configPath(home), { provider: 'git', url, machine, pending: true, dir: storageRoots(io.env).sync } satisfies SyncConfig)
      return await runNow(io, home, json, fromApp)
    }
    case 'now':
      return await runNow(io, home, json, fromApp)
    case 'status':
      return await cmdStatus(io, home, json)
    case 'disconnect':
      return await cmdDisconnect(io, home)
    default:
      throw new UsageError(`subcomando desconhecido: ${sub}. ${SYNC_USAGE}`)
  }
}

/** A connection made from one sync folder never syncs from another (a second folder would overwrite the person's data). */
function wrongDir(io: SyncIo, cfg: SyncConfig): boolean {
  const dir = storageRoots(io.env).sync
  if (!cfg.dir || samePath(cfg.dir, dir)) return false
  io.err(`tether: a sincronização desta máquina usa a pasta ${cfg.dir}, mas este processo resolveu ${dir}; nada foi sincronizado\n`)
  return true
}

function providerFor(io: SyncIo, home: string, cfg: SyncConfig): SyncProvider {
  const make = io.createProvider ?? createGitProvider
  return make({ dir: storageRoots(io.env).sync, url: cfg.url, trashDir: trashDir(home), machine: cfg.machine })
}

function show(io: SyncIo, home: string, last: SyncLast, json: boolean): number {
  if (json) io.out(maskUrl(JSON.stringify(last, null, 2)) + '\n')
  else if (last.ok && last.report) {
    const names = new Map(readProfiles(home).profiles.map((p) => [p.id, p.name]))
    io.out(maskUrl(describeReport(last.report, home, names)))
  } else io.err(`tether: a sincronização falhou: ${maskUrl(last.error?.message ?? 'erro desconhecido')}\n`)
  return last.ok ? 0 : 1
}

async function runNow(io: SyncIo, home: string, json: boolean, fromApp: boolean): Promise<number> {
  const cfg = readSyncConfig(home)
  if (!cfg) { io.err('tether: a sincronização não está configurada; rode "tether sync connect <url>"\n'); return 1 }
  if (wrongDir(io, cfg)) return 1
  if (!fromApp && (io.appRunning ?? appIsOpen)(home)) return await delegateToApp(io, home, json)
  let release: () => void
  try { release = acquireSyncLock(home) } catch (e) {
    if (e instanceof SyncBusy) { io.err(`tether: ${e.message}\n`); return 1 }
    throw e
  }
  const daemon = await io.connect()
  const now = io.now ?? Date.now
  try {
    const provider = providerFor(io, home, cfg)
    const engine = createSyncEngine({
      dir: storageRoots(io.env).sync,
      home,
      provider,
      ports: createDiskPorts({ home, userDir: userDir(io.env), daemon }),
      ...(io.homedir ? { opts: { homedir: io.homedir } } : {}),
    })
    let last: SyncLast
    try {
      // Connected = a repo with an origin; the first run, a vanished folder or a released origin go through connect.
      const linked = existsSync(join(storageRoots(io.env).sync, '.git')) && (await provider.status()).connected
      const report = linked ? await engine.sync() : await engine.connect()
      last = { at: new Date(now()).toISOString(), ok: true, report }
      // The first success fixes the folder: an old sync.json without `dir` gains it here.
      if (cfg.pending || !cfg.dir) writeJsonAtomic(configPath(home), { provider: 'git', url: cfg.url, machine: cfg.machine, dir: cfg.dir ?? storageRoots(io.env).sync } satisfies SyncConfig)
    } catch (e) {
      const error = describeSyncError(e)
      if (cfg.pending) {
        // A first connection that failed leaves no link: drop origin (the files stay) and sync.json.
        try { await engine.disconnect() } catch { /* nothing to unlink */ }
        rmSync(configPath(home), { force: true })
        error.message = `${error.message.replace(/[.\s]+$/, "")}. Nada ficou conectado.`
      }
      last = { at: new Date(now()).toISOString(), ok: false, error, report: null }
    }
    writeJsonAtomic(lastPath(home), last)
    return show(io, home, last, json)
  } finally {
    daemon?.close()
    release()
  }
}

/** The app owns the arrangement: ask it to run the sync (it calls us back with --from-app) and print what it reports. */
async function delegateToApp(io: SyncIo, home: string, json: boolean): Promise<number> {
  const now = io.now ?? Date.now
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const started = now()
  const deadline = started + (io.delegateWaitMs ?? DELEGATE_WAIT_MS)
  try { await (io.openLink ?? openTetherUrl)(SYNC_LINK) } catch (e) {
    io.err(`tether: não consegui pedir ao app para sincronizar: ${(e as Error).message}\n`)
    return 1
  }
  for (;;) {
    const last = readSyncLast(home)
    if (last && Date.parse(last.at) >= started) return show(io, home, last, json)
    if (now() >= deadline) {
      io.err(`tether: o app está aberto mas não respondeu em ${Math.round((io.delegateWaitMs ?? DELEGATE_WAIT_MS) / 1000)} s; confira se ele terminou de abrir e tente de novo\n`)
      return 1
    }
    await sleep(io.pollMs ?? 500)
  }
}

async function cmdStatus(io: SyncIo, home: string, json: boolean): Promise<number> {
  const cfg = readSyncConfig(home)
  const last = readSyncLast(home)
  if (!cfg) {
    io.out(json ? JSON.stringify({ connected: false }, null, 2) + '\n' : 'A sincronização não está configurada. Use: tether sync connect <url>\n')
    return 0
  }
  let st: { connected: boolean; dirty: number; ahead: number; behind: number } | undefined
  try { st = await providerFor(io, home, cfg).status() } catch { st = undefined }
  const url = maskUrl(cfg.url)
  if (json) {
    io.out(maskUrl(JSON.stringify({ connected: st?.connected ?? false, url, machine: cfg.machine, dirty: st?.dirty ?? 0, ahead: st?.ahead ?? 0, behind: st?.behind ?? 0, last: last ?? null }, null, 2)) + '\n')
    return 0
  }
  const lines = [
    `Sincronização: ${st?.connected ? 'conectada' : 'configurada, mas a pasta ainda não está ligada ao remoto (rode: tether sync now)'}`,
    `Remoto: ${url}`,
    `Máquina: ${cfg.machine}`,
  ]
  if (st) {
    lines.push(`Pendências locais: ${plural(st.dirty, 'arquivo', 'arquivos')}`)
    lines.push(`À frente do remoto: ${st.ahead} · atrás: ${st.behind}`)
  } else lines.push('Estado do repositório: indisponível agora.')
  if (last) lines.push(`Última sincronização: ${clock(last.at)} — ${last.ok ? 'deu certo' : `falhou: ${last.error?.message ?? 'erro desconhecido'}`}`)
  else lines.push('Última sincronização: nenhuma ainda.')
  io.out(maskUrl(lines.join('\n')) + '\n')
  return 0
}

async function cmdDisconnect(io: SyncIo, home: string): Promise<number> {
  const cfg = readSyncConfig(home)
  if (!cfg) { io.out('A sincronização já estava desconectada.\n'); return 0 }
  let release: () => void
  try { release = acquireSyncLock(home) } catch (e) {
    if (e instanceof SyncBusy) { io.err(`tether: ${e.message}\n`); return 1 }
    throw e
  }
  try {
    const engine = createSyncEngine({
      dir: storageRoots(io.env).sync,
      home,
      provider: providerFor(io, home, cfg),
      ports: createDiskPorts({ home, userDir: userDir(io.env) }),
    })
    await engine.disconnect()
    rmSync(configPath(home), { force: true })
    io.out('Desconectado. Os seus arquivos e a pasta de sincronização ficaram como estão.\n')
    return 0
  } catch (e) {
    io.err(`tether: não consegui desconectar: ${describeSyncError(e).message}\n`)
    return 1
  } finally { release() }
}
