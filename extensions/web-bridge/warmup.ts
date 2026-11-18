// Warming the bridge daemon up, shared by the daemon host (steady state: at every tetherd start, design §1.1-e) and the
// install flow in Electron main (fallback: the guide needs the daemon now, and the tetherd may predate this code or the
// daemon may have died since). The policy is the bridge shell's own (ensure.ts): GET /health; silent → spawn
// `node atrium-bridge.mjs start --port N` detached, with a minimal environment (an allowlist of the system's variables
// plus ATRIUM_BRIDGE_HOME: nothing of the shell becomes the daemon's config), cwd in the bridge home, stdout/stderr
// appended to its daemon.log; then /health is awaited up to 15 s. Two warm-ups racing is fine: the loser of the port
// exits with EADDRINUSE. Electron's own binary cannot run the bundle (a Node program), hence `findNode`.
// Nothing here reads or logs a secret: /health is public and the spawn carries only the port and the home.
import { spawn } from 'node:child_process'
import { mkdir, open } from 'node:fs/promises'
import { delimiter, join, resolve } from 'node:path'
import type { DaemonIo } from '../../src/daemon/ext-api.ts'
import { fsIo } from '../../src/daemon/ext-io.ts'
import { healthUrl } from './paths.ts'
import { sha256File } from './vendor-rules.ts'

/**
 * The tether's own record of which bundle it started the daemon from: <bridgeHome>/daemon.build.json, written at every
 * spawn. The bridge's daemon.pid says WHO listens; this says WHAT it runs, which /health does not tell. At the next
 * tetherd start, a record whose sha differs from the vendored bundle's means the daemon runs an older build (update.ts).
 */
export const DAEMON_RECORD = 'daemon.build.json'
export interface DaemonRecord { pid: number; bundleSha256: string; startedAt: string }
export const daemonRecordPath = (bridgeHome: string): string => join(bridgeHome, DAEMON_RECORD)

export async function readDaemonRecord(bridgeHome: string, io: DaemonIo = fsIo): Promise<DaemonRecord | undefined> {
  try {
    const r = JSON.parse(await io.readText(daemonRecordPath(bridgeHome))) as Partial<DaemonRecord>
    return typeof r.pid === 'number' && typeof r.bundleSha256 === 'string' ? { pid: r.pid, bundleSha256: r.bundleSha256, startedAt: typeof r.startedAt === 'string' ? r.startedAt : '' } : undefined
  } catch { return undefined }
}

export async function writeDaemonRecord(bridgeHome: string, record: DaemonRecord, io: DaemonIo = fsIo): Promise<void> {
  await io.writeTextAtomic(daemonRecordPath(bridgeHome), `${JSON.stringify(record, null, 2)}\n`)
}

/** The sha256 of the bundle file, or undefined when it cannot be read. */
export async function bundleSha256Of(bundlePath: string): Promise<string | undefined> {
  try { return await sha256File(bundlePath) } catch { return undefined }
}

/** The places `findNode` looks, in order: `TETHER_NODE`, npm's node, then every `node` on PATH (the rule app/main/main.ts uses for tetherd). */
export function nodeCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = []
  if (env.TETHER_NODE) out.push(env.TETHER_NODE)
  if (env.npm_node_execpath) out.push(env.npm_node_execpath)
  const name = process.platform === 'win32' ? 'node.exe' : 'node'
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (dir) out.push(join(dir.replace(/^"|"$/g, ''), name))
  }
  return out
}

/** The first candidate `exists` accepts. The synchronous default (find-node-sync.ts) is for the CLI and Electron main. */
export function findNode(env: NodeJS.ProcessEnv, exists: (p: string) => boolean): string | undefined {
  return nodeCandidates(env).find(exists)
}

/** `findNode` through `api.io`, for tetherd: one probe at a time, in order. */
export async function findNodeAsync(io: DaemonIo, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  for (const c of nodeCandidates(env)) if (await io.exists(c).catch(() => false)) return c
  return undefined
}

/** The daemon's environment: a fixed allowlist of the system's variables plus its home. Nothing else of this process. */
const DAEMON_ENV_KEYS = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'COMSPEC', 'OS', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'LANG', 'LC_ALL']
export function daemonEnv(bridgeHome: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of DAEMON_ENV_KEYS) if (env[k] !== undefined) out[k] = env[k]!
  out.ATRIUM_BRIDGE_HOME = resolve(bridgeHome)
  return out
}

/** Starts the bridge daemon detached (survives the app and tetherd, no window), its output appended to <bridgeHome>/daemon.log. */
export async function spawnBridgeDaemon(node: string, bundle: string, port: number, bridgeHome: string): Promise<number | undefined> {
  await mkdir(bridgeHome, { recursive: true })
  const log = await open(join(bridgeHome, 'daemon.log'), 'a')
  try {
    const child = spawn(node, [bundle, 'start', '--port', String(port)], { cwd: resolve(bridgeHome), env: daemonEnv(bridgeHome), detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd] })
    child.on('error', () => {})
    child.unref()
    return child.pid
  } finally { await log.close() }
}

export interface WarmupDeps {
  port: number
  /** vendor/atrium-bridge.mjs. */
  bundlePath: string
  bridgeHome: string
  nodeExe(): string | undefined | Promise<string | undefined>
  log(msg: string): void
  /** The disk (`api.io`); default node's async file API. */
  io?: DaemonIo
  /** Injected in the unit tests. */
  fetch?: typeof fetch
  spawnDaemon?(node: string, bundle: string, port: number, bridgeHome: string): number | undefined | Promise<number | undefined>
  sleep?(ms: number): Promise<void>
}

export interface Warmup {
  /** GET /health answers `{ ok: true }` within 1.5 s. */
  health(): Promise<boolean>
  /** The daemon up: already answering, or started now and answering within the wait. */
  ensure(): Promise<'running' | 'started' | 'failed'>
}

export const HEALTH_WAIT_MS = 15_000

export function createWarmup(deps: WarmupDeps): Warmup {
  const doFetch = deps.fetch ?? fetch
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))

  const health = async (): Promise<boolean> => {
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 1500)
      const r = await doFetch(healthUrl(deps.port), { signal: ctl.signal, headers: { connection: 'close' } }).finally(() => clearTimeout(t))
      if (!r.ok) return false
      const body = (await r.json().catch(() => null)) as { ok?: unknown } | null
      return body?.ok === true
    } catch { return false }
  }

  const ensure = async (): Promise<'running' | 'started' | 'failed'> => {
    if (await health()) return 'running'
    const node = await deps.nodeExe()
    if (!node) { deps.log('daemon do bridge: node não encontrado (TETHER_NODE ou PATH); não iniciado'); return 'failed' }
    const pid = await (deps.spawnDaemon ?? spawnBridgeDaemon)(node, deps.bundlePath, deps.port, deps.bridgeHome)
    deps.log(`daemon do bridge iniciado (pid ${pid ?? '?'}, porta ${deps.port}, home ${deps.bridgeHome})`)
    // The record of what was started (C5 reads it at the next start); a failure to write it is not a failure to start.
    const sha = pid !== undefined ? await bundleSha256Of(deps.bundlePath) : undefined
    if (pid !== undefined && sha) {
      try { await writeDaemonRecord(deps.bridgeHome, { pid, bundleSha256: sha, startedAt: new Date().toISOString() }, deps.io) } catch (e) { deps.log(`registro ${DAEMON_RECORD} não gravado: ${e instanceof Error ? e.message : String(e)}`) }
    }
    const deadline = Date.now() + HEALTH_WAIT_MS
    while (Date.now() < deadline) {
      await sleep(250)
      if (await health()) return 'started'
    }
    deps.log(`daemon do bridge: /health não respondeu em ${HEALTH_WAIT_MS} ms na porta ${deps.port}`)
    return 'failed'
  }

  return { health, ensure }
}
