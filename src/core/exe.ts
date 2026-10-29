// tether's long-lived Node processes run under their own executable names: the daemon as `tetherd.exe` and
// each soul panel as `tether-soul.exe`. Both are the node.exe that would have run them, placed in <home>/bin,
// so a "kill every node.exe" (the user's own killall, a stray cleanup script) leaves them alone and the Task
// Manager names them. node-pty keeps loading: it is built for the Node ABI and the binary is the same one.
//
// The copy follows its source: when the node it was made from changes (size or mtime), it is remade. A hard
// link is tried first (same volume: instant, no disk cost, the process name still comes from the link's name),
// then a plain copy. Both go to a temp name and are renamed into place, so a reader never sees a half-written
// executable. Windows refuses to replace an executable that is running: then the old one stays (logged) and
// is replaced on a later start. When nothing works, the caller runs the plain node (logged; `tether doctor`
// warns) rather than not running at all.
import { appendFileSync, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export type ExeName = 'tetherd' | 'tether-soul'
export type ExeMethod = 'hardlink' | 'copy'

/** What <home>/bin/<name>.json remembers about the executable it sits next to. */
export interface ExeStamp {
  source: string
  size: number
  mtimeMs: number
  method: ExeMethod | 'fallback'
  reason?: string
}

export interface ExeResult {
  /** What to run: the renamed executable, or `source` itself when it could not be made. */
  path: string
  method: ExeMethod | 'fallback'
  /** fresh = made now; current = already matched its source; stale = an older copy kept because it is in use. */
  state: 'fresh' | 'current' | 'stale'
  reason?: string
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
  return /^(tetherd|tether-soul)(\.exe)?$/i.test(basename(path))
}

/** `node`, `node.exe`, or one of tether's own copies. */
export function isNodeExecutable(path: string): boolean {
  return /^node(\.exe)?$/i.test(basename(path)) || isRenamedNode(path)
}

/**
 * Makes sure <home>/bin/<name>[.exe] is an up-to-date copy of `source` and returns what to run. Never throws:
 * a failure to make the copy returns `source` itself as 'fallback' (and records why in the stamp for doctor).
 * Cheap when nothing changed: one stat of the source and one read of the stamp.
 */
export function ensureRenamedNode(home: string, name: ExeName, source: string, log: (msg: string) => void = () => {}): ExeResult {
  const target = exePath(home, name)
  let src: ReturnType<typeof statSync>
  try {
    src = statSync(source)
  } catch (e) {
    return fallback(`${source} não existe ou não pode ser lido: ${(e as Error).message}`)
  }
  const stamp = readStamp(home, name)
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
}

export function inspectRenamedNode(home: string, name: ExeName): ExeStatus {
  const path = exePath(home, name)
  const present = existsSync(path)
  const stamp = readStamp(home, name)
  let outdated = !stamp || stamp.method === 'fallback'
  if (stamp && stamp.method !== 'fallback') {
    try {
      const s = statSync(stamp.source)
      outdated = s.size !== stamp.size || s.mtimeMs !== stamp.mtimeMs || !present
    } catch {
      outdated = true
    }
  }
  return { name, path, present, stamp, outdated }
}
