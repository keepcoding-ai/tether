// tether's long-lived Node processes run under their own executable names: the daemon as `tetherd.exe`, the
// background-process host as `tether-procd.exe` and each soul panel as `tether-soul.exe`. All are the node.exe
// that would have run them, placed in <home>/bin, so a "kill every node.exe" (the user's own killall, a stray
// cleanup script) leaves them alone and the Task Manager names them. node-pty keeps loading: it is built for the Node ABI and the binary is the same one.
//
// The copy follows its source: when the node it was made from changes (size or mtime), it is remade. A hard
// link is tried first (same volume: instant, no disk cost, the process name still comes from the link's name),
// then a plain copy. Both go to a temp name and are renamed into place, so a reader never sees a half-written
// executable. Windows refuses to replace an executable that is running: then the old one stays (logged) and
// is replaced on a later start. When nothing works, the caller runs the plain node (logged; `tether doctor`
// warns) rather than not running at all.
//
// macOS is the exception: no file is made there. Homebrew's `node` is a small stub that loads
// `@rpath/libnode.dylib` with an LC_RPATH of `@loader_path` (and `@loader_path/../lib`), so a link or copy of it
// anywhere else aborts in dyld at launch ("Library not loaded"). The process runs the real node and gets its
// name through argv[0] instead (`argv0` of child_process.spawn; `exec -a` for a pty), which is what `ps`
// shows. Processes are killed by pid there, so the killall motive does not apply.
import { type Stats, appendFileSync, copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export type ExeName = 'tetherd' | 'tether-soul' | 'tether-procd' | 'tether-ptyd'
export type ExeMethod = 'hardlink' | 'copy'
/** How the process gets its name: a renamed file, none at all (`fallback`), or argv[0] over the real node (`argv0`). */
export type ExeHow = ExeMethod | 'fallback' | 'argv0'

/** What <home>/bin/<name>.json remembers about the executable it sits next to. */
export interface ExeStamp {
  source: string
  size: number
  mtimeMs: number
  method: ExeHow
  reason?: string
}

export interface ExeResult {
  /** What to run: the renamed executable, or `source` itself when it could not be made (or must not be: argv0). */
  path: string
  method: ExeHow
  /** fresh = made now; current = already matched its source; stale = an older copy kept because it is in use. */
  state: 'fresh' | 'current' | 'stale'
  reason?: string
  /** Set with method 'argv0': the name to give the process (its argv[0]) when running `path`. */
  argv0?: ExeName
}

/** A logger for callers that have none: one line per message in <home>/tetherd.log, tagged with pid and `tag`. */
export function exeLog(home: string, tag: string): (msg: string) => void {
  return (msg) => {
    try {
      mkdirSync(home, { recursive: true })
      appendFileSync(join(home, 'tetherd.log'), `${new Date().toISOString()} [${process.pid} ${tag}] ${msg}\n`)
    } catch { /* best effort */ }
  }
}

export function exeDir(home: string): string {
  return join(home, 'bin')
}

export function exePath(home: string, name: ExeName): string {
  return join(exeDir(home), process.platform === 'win32' ? `${name}.exe` : name)
}

function stampPath(home: string, name: ExeName): string {
  return join(exeDir(home), `${name}.json`)
}

export function readStamp(home: string, name: ExeName): ExeStamp | undefined {
  try {
    const s = JSON.parse(readFileSync(stampPath(home, name), 'utf8')) as ExeStamp
    return typeof s.source === 'string' && typeof s.size === 'number' && typeof s.mtimeMs === 'number' ? s : undefined
  } catch {
    return undefined
  }
}

function writeStamp(home: string, name: ExeName, stamp: ExeStamp): void {
  const path = stampPath(home, name)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(stamp, null, 2) + '\n')
  renameSync(tmp, path)
}

/** True when the renamed executable is in place and its stamp matches the source as it is on disk now. */
function isCurrent(stamp: ExeStamp | undefined, source: string, size: number, mtimeMs: number, target: string): boolean {
  return stamp !== undefined && stamp.method !== 'fallback' && stamp.source === source && stamp.size === size && stamp.mtimeMs === mtimeMs && existsSync(target)
}

/** Is a name one of tether's own copies of node (so a command naming it is "node" for our purposes)? */
export function isRenamedNode(path: string): boolean {
  return /^(tetherd|tether-soul|tether-procd|tether-ptyd)(\.exe)?$/i.test(basename(path))
}

/** `node`, `node.exe`, or one of tether's own copies. */
export function isNodeExecutable(path: string): boolean {
  return /^node(\.exe)?$/i.test(basename(path)) || isRenamedNode(path)
}

/** The temp names ensureRenamedNode writes before renaming into place: <name>[.exe][.json].<pid>.tmp. */
const TEMP_NAME = /^(?:tetherd|tether-soul|tether-procd|tether-ptyd)(?:\.exe)?(?:\.json)?\.(\d+)\.tmp$/i

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Removes temp files left in <home>/bin by starts that died between writing and renaming (a crash, a kill). Only
 * ours by name, never this process's own, and never one whose writer is still alive. Never throws.
 */
export function sweepOrphanTemps(home: string, log: (msg: string) => void = () => {}): string[] {
  const removed: string[] = []
  let names: string[]
  try { names = readdirSync(exeDir(home)) } catch { return removed }
  for (const n of names) {
    const m = TEMP_NAME.exec(n)
    if (!m) continue
    const pid = Number.parseInt(m[1]!, 10)
    if (pid === process.pid || isAlive(pid)) continue
    const path = join(exeDir(home), n)
    try {
      rmSync(path, { force: true })
      removed.push(path)
      log(`bin: removido o temporário órfão ${path} (pid ${pid} já não existe)`)
    } catch (e) {
      log(`bin: não consegui remover o temporário órfão ${path}: ${(e as Error).message}`)
    }
  }
  return removed
}

/** Why no renamed executable is made on macOS (the stamp's reason and doctor's text). */
export function argv0Reason(source: string): string {
  return `no macOS o node (${source}) carrega @rpath/libnode.dylib por @loader_path: um link ou cópia fora de ${dirname(source)} aborta no dyld; o processo roda pelo node real e recebe o nome por argv0`
}

/**
 * Makes sure <home>/bin/<name>[.exe] is an up-to-date copy of `source` and returns what to run. Never throws:
 * a failure to make the copy returns `source` itself as 'fallback' (and records why in the stamp for doctor).
 * Cheap when nothing changed: one stat of the source and one read of the stamp. On darwin nothing is made
 * (see the header): `source` comes back with `argv0` set, for the caller to name the process.
 */
export function ensureRenamedNode(home: string, name: ExeName, source: string, log: (msg: string) => void = () => {}, platform: NodeJS.Platform = process.platform): ExeResult {
  const target = exePath(home, name)
  const found = statOrError(source)
  const src = found instanceof Error ? undefined : found
  // A copy this process already made or verified, with the source unchanged and the copy still there: two stats, no
  // directory sweep and no stamp read. Anything else (first call, changed source, missing copy) takes the full path below.
  const memoKey = `${home}|${name}|${source}|${platform}`
  const memo = settled.get(memoKey)
  if (memo && src && memo.size === src.size && memo.mtimeMs === src.mtimeMs && memo.stamp === fileSig(stampPath(home, name)) && (memo.result.method === 'argv0' || fileSig(target) !== undefined)) {
    return { ...memo.result, state: 'current' }
  }
  sweepOrphanTemps(home, log)
  const result = ensureRenamedNodeSlow(home, name, source, found, target, log, platform)
  if (src && (result.state === 'fresh' || result.state === 'current') && result.method !== 'fallback') {
    if (settled.size >= 32) settled.clear()
    settled.set(memoKey, { size: src.size, mtimeMs: src.mtimeMs, stamp: fileSig(stampPath(home, name)), result })
  } else settled.delete(memoKey)
  return result
}

const settled = new Map<string, { size: number; mtimeMs: number; stamp: string | undefined; result: ExeResult }>()

/** The one synchronous stat of this file: the file's stats, or the error that stopped it. */
function statOrError(path: string): Stats | Error {
  try { return statSync(path) } catch (e) { return e as Error }
}

/**
 * Size and mtime of a file as one comparable string; undefined when it is not there. What the launch-path caches
 * (claude settings, user settings, skills stamp, renamed node) compare instead of reading the file again.
 */
export function fileSig(path: string): string | undefined {
  const st = statOrError(path)
  return st instanceof Error ? undefined : `${st.size}:${st.mtimeMs}`
}

function ensureRenamedNodeSlow(home: string, name: ExeName, source: string, found: Stats | Error, target: string, log: (msg: string) => void, platform: NodeJS.Platform): ExeResult {
  if (found instanceof Error) return fallback(`${source} não existe ou não pode ser lido: ${found.message}`)
  const src = found
  const stamp = readStamp(home, name)
  if (platform === 'darwin') {
    const reason = argv0Reason(source)
    if (stamp?.method === 'argv0' && stamp.source === source && stamp.size === src.size && stamp.mtimeMs === src.mtimeMs) {
      return { path: source, method: 'argv0', state: 'current', reason, argv0: name }
    }
    try {
      mkdirSync(exeDir(home), { recursive: true })
      writeStamp(home, name, { source, size: src.size, mtimeMs: src.mtimeMs, method: 'argv0', reason })
    } catch (e) { log(`${name}: não consegui gravar ${stampPath(home, name)}: ${(e as Error).message}`) }
    log(`${name}: rodando pelo node real (${source}) com o nome por argv0`)
    return { path: source, method: 'argv0', state: 'fresh', reason, argv0: name }
  }
  const previous: ExeMethod | undefined = stamp?.method === 'copy' || stamp?.method === 'hardlink' ? stamp.method : undefined
  if (previous && isCurrent(stamp, source, src.size, src.mtimeMs, target)) return { path: target, method: previous, state: 'current' }

  let method: ExeMethod
  const tmp = `${target}.${process.pid}.tmp`
  try {
    mkdirSync(exeDir(home), { recursive: true })
    rmSync(tmp, { force: true })
    try {
      linkSync(source, tmp)
      method = 'hardlink'
    } catch {
      // Another volume, a file system without links, or a policy against them: a plain copy, with the source's
      // times so that a later stat-based check reads the same way whichever method was used.
      copyFileSync(source, tmp)
      utimesSync(tmp, src.atime, src.mtime)
      method = 'copy'
    }
  } catch (e) {
    rmSync(tmp, { force: true })
    return fallback(`não consegui criar ${target}: ${(e as Error).message}`)
  }
  try {
    // Over a running executable this still works on Windows 11 (the old file is unlinked, the running image keeps
    // it alive, measured in test/unit/core.exe.test.ts); the branch below is for a Windows or file system that refuses.
    renameSync(tmp, target)
  } catch (e) {
    rmSync(tmp, { force: true })
    if (existsSync(target)) {
      // The target is a running executable (ours from a previous start). Keep it; it is replaced next time.
      log(`${name}: ${target} está em uso e não pôde ser atualizado a partir de ${source} (${(e as Error).message}); mantendo a cópia anterior`)
      return { path: target, method: previous ?? method, state: 'stale', reason: (e as Error).message }
    }
    return fallback(`não consegui colocar ${target} no lugar: ${(e as Error).message}`)
  }
  const fresh: ExeStamp = { source, size: src.size, mtimeMs: src.mtimeMs, method }
  try { writeStamp(home, name, fresh) } catch (e) { log(`${name}: não consegui gravar ${stampPath(home, name)}: ${(e as Error).message}`) }
  log(`${name}: ${target} ${method === 'hardlink' ? 'ligado a' : 'copiado de'} ${source} (${src.size} bytes)`)
  return { path: target, method, state: 'fresh' }

  function fallback(reason: string): ExeResult {
    log(`${name}: rodando com o node original (${source}): ${reason}`)
    try {
      mkdirSync(exeDir(home), { recursive: true })
      writeStamp(home, name, { source, size: 0, mtimeMs: 0, method: 'fallback', reason })
    } catch { /* the stamp is only for doctor */ }
    return { path: source, method: 'fallback', state: 'fresh', reason }
  }
}

/** What doctor reports, without touching anything: the executable as it is on disk and how it got there. */
export interface ExeStatus {
  name: ExeName
  path: string
  present: boolean
  stamp: ExeStamp | undefined
  /** The stamp's source changed since the copy was made (or there is no stamp): the next start remakes it. */
  outdated: boolean
  /** argv0 is the method (macOS) and yet a renamed file sits at `path`: a leftover dyld refuses to run. */
  residue: boolean
}

export function inspectRenamedNode(home: string, name: ExeName, platform: NodeJS.Platform = process.platform): ExeStatus {
  const path = exePath(home, name)
  const present = existsSync(path)
  const stamp = readStamp(home, name)
  const argv0 = platform === 'darwin' || stamp?.method === 'argv0'
  let outdated = !stamp || stamp.method === 'fallback'
  if (stamp && stamp.method !== 'fallback') {
    const s = statOrError(stamp.source)
    outdated = s instanceof Error ? true : s.size !== stamp.size || s.mtimeMs !== stamp.mtimeMs || (!present && !argv0)
  }
  return { name, path, present, stamp, outdated, residue: argv0 && present }
}
