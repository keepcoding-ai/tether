// The zero-click update (F7 C5, design §1.3), run by the daemon host at every tetherd start when the tether vendors a
// bridge newer than the one installed on this machine. Three independent pieces, each a no-op when nothing changed:
//   1. the extension folder <TETHER_HOME>/web-bridge/current, when it exists, is brought to the vendored build FILE BY
//      FILE (temp + rename per file; files the build no longer has are removed): its tree hash, with the seed left out,
//      must equal build-info.json `extension.sha256`. The seed (bridge.json: port, token, host) is never touched here —
//      the host rewrites it right after, with the same token. The folder is fixed, so the browser keeps pointing at it;
//      a marker (<TETHER_HOME>/web-bridge/update-pending.json) records that the files under a loaded extension changed,
//      for the doctor (and C4's status) to say "clique em recarregar" until the extension can reload itself;
//   2. `extensionVersion` (the manifest version of the folder's build) is written into the bridge home's config.json, the
//      field the daemon carries in its `welcome` so the extension can compare with chrome.runtime.getManifest().version
//      and call chrome.runtime.reload() once per version (the bridge's side of the contract, since bridge 782d3ea55).
//      Written through the bundle's own `setExtensionVersion` (under the bridge's config.lock): the host writes none of
//      the bridge's files by hand;
//   3. the daemon, when the tether's record says it runs a bundle other than the vendored one (warmup.ts daemon.build.json),
//      is ended and started again. The kill follows the tests' safety rule (test/kill.ts): the pid of daemon.pid must be
//      alive, its command line must name the bridge bundle and `start`, and it must be the process listening on the
//      bridge's port; any doubt keeps the daemon running and logs why. No record (a daemon started before this code) counts
//      as outdated: the person's daemon predates the vendored bundle by definition.
// Nothing here reads a secret out: the seed is left alone, config.json is read only to compare one field, and no log
// line carries a token.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { identifyProcess, killProcess, listeningOwner, pidAlive } from './process-info.ts'
import { hashTree, relPath, sha256, walk, type BuildInfo } from './vendor-rules.ts'
import { bundleSha256Of, readDaemonRecord, type Warmup } from './warmup.ts'

/** The seed the install flow writes into the folder (chrome-extensions/bridge daemon/src/install.ts SEED_FILE). */
export const SEED_FILE = 'bridge.json'
const KEEP = new Set([SEED_FILE])

// ---- 1. the folder ---------------------------------------------------------------------------------------------------

/** The manifest version of an extension folder (what chrome.runtime.getManifest().version returns for it). */
export function extensionVersionOf(dir: string): string | undefined {
  try {
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { version?: unknown }
    return typeof m.version === 'string' ? m.version : undefined
  } catch { return undefined }
}

/** Whether the installed folder (seed left out) is a build other than the vendored one. A missing folder is not outdated: it is absent. */
export function extensionOutdated(currentDir: string, info: BuildInfo): boolean {
  if (!existsSync(join(currentDir, 'manifest.json'))) return false
  return hashTree(currentDir, KEEP) !== info.extension.sha256
}

export interface FolderUpdate { written: string[]; removed: string[] }

/** Copies `text` into `path` in one move (temp + rename), creating the folders. */
function placeFile(path: string, data: Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, data)
  try { renameSync(tmp, path) } finally { rmSync(tmp, { force: true }) }
}

/** Removes the folders under `dir` that became empty, deepest first; `dir` itself stays. */
function pruneEmptyDirs(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const p = join(dir, e.name)
    pruneEmptyDirs(p)
    if (readdirSync(p).length === 0) rmSync(p, { recursive: true, force: true })
  }
}

/**
 * Brings `dir` to the files of `source`, file by file: a file whose content differs (or is missing) is written next to
 * its place and renamed over it; a file `source` does not have is removed, the seed excepted. Files equal already are
 * not touched. Returns the relative paths written and removed.
 */
export function updateExtensionDir(source: string, dir: string): FolderUpdate {
  const written: string[] = []
  const removed: string[] = []
  const wanted = new Set<string>()
  for (const f of walk(source)) {
    const r = relPath(source, f)
    wanted.add(r)
    const data = readFileSync(f)
    const target = join(dir, r)
    if (existsSync(target) && statSync(target).isFile() && sha256(readFileSync(target)) === sha256(data)) continue
    placeFile(target, data)
    written.push(r)
  }
  if (existsSync(dir)) {
    for (const f of walk(dir)) {
      const r = relPath(dir, f)
      if (wanted.has(r) || KEEP.has(r)) continue
      rmSync(f, { force: true })
      removed.push(r)
    }
    pruneEmptyDirs(dir)
  }
  return { written, removed }
}

// ---- the marker ------------------------------------------------------------------------------------------------------

export const UPDATE_MARKER = 'update-pending.json'
export interface UpdateMarker { version: string; at: string }
export const updateMarkerPath = (home: string): string => join(home, 'web-bridge', UPDATE_MARKER)

export function readUpdateMarker(home: string): UpdateMarker | undefined {
  try {
    const m = JSON.parse(readFileSync(updateMarkerPath(home), 'utf8')) as Partial<UpdateMarker>
    return typeof m.version === 'string' && typeof m.at === 'string' ? { version: m.version, at: m.at } : undefined
  } catch { return undefined }
}

export function writeUpdateMarker(home: string, marker: UpdateMarker): void {
  placeFile(updateMarkerPath(home), Buffer.from(`${JSON.stringify(marker, null, 2)}\n`))
}

export function clearUpdateMarker(home: string): void {
  rmSync(updateMarkerPath(home), { force: true })
}

// ---- 2. extensionVersion in config.json ------------------------------------------------------------------------------

/** The one bundle export this step needs (bridge-home.ts BridgeBundle): the bridge writes its own config, under its own lock. */
export interface ExtensionVersionWriter { setExtensionVersion(home: string, version: string | null): void }

/** What config.json says the installed extension's version is (undefined when absent or unreadable). Reads no secret out. */
export function storedExtensionVersion(bridgeHome: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(bridgeHome, 'config.json'), 'utf8')) as { extensionVersion?: unknown }
    return typeof raw.extensionVersion === 'string' ? raw.extensionVersion : undefined
  } catch { return undefined }
}

/**
 * Keeps `extensionVersion` in <bridgeHome>/config.json equal to `version` through the bundle's own `setExtensionVersion`
 * (bridge 782d3ea55+: the field is part of its config, written under its config.lock, so the host and the daemon never
 * interleave and the host writes none of the bridge's files by hand). Only when it differs; returns whether it was
 * written. The daemon rereads its config by mtime and carries the field in its `welcome`.
 */
export function syncExtensionVersion(b: ExtensionVersionWriter, bridgeHome: string, version: string): boolean {
  if (storedExtensionVersion(bridgeHome) === version) return false
  b.setExtensionVersion(bridgeHome, version)
  return true
}

// ---- 3. the daemon ---------------------------------------------------------------------------------------------------

export interface RestartDeps {
  port: number
  /** vendor/atrium-bridge.mjs. */
  bundlePath: string
  bridgeHome: string
  warmup: Warmup
  log(msg: string): void
  /** Injected in the unit test. */
  identify?(pid: number): Promise<{ cmd?: string } | undefined>
  portOwner?(port: number): Promise<number | undefined>
  kill?(pid: number): Promise<void>
  alive?(pid: number): boolean
  sleep?(ms: number): Promise<void>
  bundleSha256?: string
}

/**
 * `current`: the daemon runs the vendored bundle (or no daemon.pid exists: nothing to restart; the warm-up decides).
 * `kept`: outdated or unknown, but its identity could not be proven (not the port's owner, not a bridge command line): left running.
 * `restarted` / `failed`: the old one ended and the new one answers /health (or did not within the wait).
 */
export type RestartOutcome = 'current' | 'kept' | 'restarted' | 'failed'

const KILL_WAIT_MS = 8_000

export async function restartIfOutdated(deps: RestartDeps): Promise<RestartOutcome> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const alive = deps.alive ?? pidAlive
  let pid: number | undefined
  try { const n = Number(readFileSync(join(deps.bridgeHome, 'daemon.pid'), 'utf8').trim()); pid = Number.isInteger(n) && n > 0 ? n : undefined } catch { /* no daemon.pid */ }
  if (pid === undefined || !alive(pid)) return 'current'
  // Nothing answering: there is no daemon to replace (a stale daemon.pid, a pid reused by another program); the warm-up decides.
  if (!(await deps.warmup.health())) return 'current'
  const vendored = deps.bundleSha256 ?? bundleSha256Of(deps.bundlePath)
  if (!vendored) return 'current'
  const record = readDaemonRecord(deps.bridgeHome)
  if (record && record.pid === pid && record.bundleSha256 === vendored) return 'current'
  const why = record && record.pid === pid ? 'o bundle vendorizado mudou desde que ele subiu' : 'não há registro do bundle com que ele subiu'
  // Identity, three ways, before any kill.
  const info = await (deps.identify ?? identifyProcess)(pid)
  const cmd = (info?.cmd ?? '').toLowerCase()
  if (!info || !cmd.includes('atrium-bridge.mjs') || !/\bstart\b/.test(cmd)) {
    deps.log(`daemon do bridge (pid ${pid}) mantido: ${why}, mas a linha de comando do processo não é a do bundle do bridge`)
    return 'kept'
  }
  const owner = await (deps.portOwner ?? listeningOwner)(deps.port)
  if (owner !== pid) {
    deps.log(`daemon do bridge (pid ${pid}) mantido: ${why}, mas a porta ${deps.port} ${owner === undefined ? 'não tem dono visível' : `pertence ao pid ${owner}`}`)
    return 'kept'
  }
  deps.log(`daemon do bridge (pid ${pid}) encerrado para atualizar: ${why}`)
  await (deps.kill ?? killProcess)(pid)
  const deadline = Date.now() + KILL_WAIT_MS
  while (Date.now() < deadline && (alive(pid) || await deps.warmup.health())) await sleep(200)
  if (alive(pid)) { deps.log(`daemon do bridge (pid ${pid}) não encerrou em ${KILL_WAIT_MS} ms; o novo não foi iniciado`); return 'failed' }
  const started = await deps.warmup.ensure()
  return started === 'failed' ? 'failed' : 'restarted'
}
