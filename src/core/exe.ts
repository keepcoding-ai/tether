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
// This file is the part tetherd may import (names, paths, types, the log). Everything that touches the disk synchronously is in
// exe-sync.ts: the executor operations and the CLI/doctor use it, the coordinator never does.
//
// macOS is the exception: no file is made there. Homebrew's `node` is a small stub that loads
// `@rpath/libnode.dylib` with an LC_RPATH of `@loader_path` (and `@loader_path/../lib`), so a link or copy of it
// anywhere else aborts in dyld at launch ("Library not loaded"). The process runs the real node and gets its
// name through argv[0] instead (`argv0` of child_process.spawn; `exec -a` for a pty), which is what `ps`
// shows. Processes are killed by pid there, so the killall motive does not apply.
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

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

let logSink: ((line: string) => void) | undefined
/** The tetherd routes every `exeLog` line (already formatted, newline included) into its append batch; other processes keep appending directly. */
export function setExeLogSink(sink: ((line: string) => void) | undefined): void { logSink = sink }

/** A logger for callers that have none: one line per message in <home>/tetherd.log, tagged with pid and `tag`. */
export function exeLog(home: string, tag: string): (msg: string) => void {
  return (msg) => {
    const line = `${new Date().toISOString()} [${process.pid} ${tag}] ${msg}\n`
    if (logSink) { logSink(line); return }
    // Best effort and off the caller's thread (the CLI's lines land a moment later; the tetherd uses the sink above).
    void mkdir(home, { recursive: true }).then(() => appendFile(join(home, 'tetherd.log'), line)).catch(() => { /* best effort */ })
  }
}

export function exeDir(home: string): string {
  return join(home, 'bin')
}

export function exePath(home: string, name: ExeName): string {
  return join(exeDir(home), process.platform === 'win32' ? `${name}.exe` : name)
}

