// The note tab's files, main-process side (no Electron here: the unit tests run it under plain Node):
//   - where a new note goes: `<pane cwd>/.tether/notes/` with a pane in focus, else the person's own folder
//     (`~/.tether/notes/`; under TETHER_HOME when it is set, so a test home never writes into the real one);
//   - the first note in a git repository: whether `.gitignore` already keeps `.tether/` out (the renderer asks
//     the person when it does not; the answer is remembered per repository by the caller);
//   - reading and writing: UTF-8, atomic write (temp file + rename) so a kill mid-write never leaves half a note;
//   - watching: one `fs.watch` on the note's folder per open path (a replaced file keeps its name; watching the
//     file itself breaks across the rename our own save makes), debounced, reported to the renderer by path.
import { existsSync, type FSWatcher, mkdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { gitignoreCovers, gitignoreWithTether, noteFileName, NOTES_SUBDIR, uniqueFileName } from '../shared/notes.ts'

/** The notes folder without a pane: the person's own, or the test home's. */
export function userNotesDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const fromEnv = env.TETHER_HOME?.trim()
  return fromEnv ? join(fromEnv, 'notes') : join(home, '.tether', 'notes')
}

/** The default of the setting "Pasta das minhas notas" (extensions.note.personalFolder). */
export const PERSONAL_FOLDER_DEFAULT = '~/.tether/notes'

/**
 * "Minhas notas": the folder of the setting (a leading `~` is the person's home), or, at its default or empty, the
 * person's own folder (under TETHER_HOME when it is set, so a test home never writes into the real one).
 */
export function personalNotesDir(setting: string | undefined, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const raw = (setting ?? '').trim()
  if (!raw || raw === PERSONAL_FOLDER_DEFAULT) return userNotesDir(env, home)
  return resolve(/^~(?=$|[\\/])/.test(raw) ? join(home, raw.slice(1)) : raw)
}

/** The destination of a new note picked in the chooser: the project's `.tether/notes`, "Minhas notas", or a folder as chosen. */
export type NoteDestinationId = 'project' | 'home' | 'other'
export const isDestinationId = (v: unknown): v is NoteDestinationId => v === 'project' || v === 'home' || v === 'other'

/** Where a note born now goes: the pane's folder when there is one, else the person's. */
export function notesDirFor(paneCwd: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return paneCwd ? join(paneCwd, ...NOTES_SUBDIR.split('/')) : userNotesDir(env)
}

/** The repository root `dir` is in (the nearest ancestor with a `.git`), or undefined outside any repository. */
export function findGitRoot(dir: string): string | undefined {
  let current = resolve(dir)
  for (;;) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

export type GitignoreStatus = 'covered' | 'missing'

/** Whether the repository's `.gitignore` keeps `.tether/` out (a missing file counts as not covering). */
export function gitignoreStatus(repoRoot: string): GitignoreStatus {
  const path = join(repoRoot, '.gitignore')
  let text = ''
  try { text = readFileSync(path, 'utf8') } catch { return 'missing' }
  return gitignoreCovers(text) ? 'covered' : 'missing'
}

/** Adds the `.tether/` line to the repository's `.gitignore` (created when absent), atomically. */
export function addTetherToGitignore(repoRoot: string): void {
  const path = join(repoRoot, '.gitignore')
  let text = ''
  try { text = readFileSync(path, 'utf8') } catch { /* no file yet */ }
  writeTextAtomic(path, gitignoreWithTether(text))
}

export type NoteRead = { ok: true; text: string; mtimeMs: number } | { ok: false; missing: boolean; message: string }

export function readNote(path: string): NoteRead {
  try {
    const text = readFileSync(path, 'utf8')
    const mtimeMs = statSync(path).mtimeMs
    return { ok: true, text, mtimeMs }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    return { ok: false, missing: e.code === 'ENOENT', message: e.message }
  }
}

/** Temp file in the same folder + rename: the file on disk is always a whole note (the last one written). */
export function writeTextAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, path)
  } catch (err) {
    // A failed write or rename (read-only target, file in use) must not leave the temp file next to the user's file.
    try { rmSync(tmp, { force: true }) } catch { /* best effort */ }
    throw err
  }
}

export type NoteWrite = { ok: true; mtimeMs: number } | { ok: false; message: string }

export function writeNote(path: string, text: string): NoteWrite {
  try {
    writeTextAtomic(path, text)
    return { ok: true, mtimeMs: statSync(path).mtimeMs }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

export interface PreparedNote {
  /** The new file, created empty. */
  path: string
  /** The repository whose `.gitignore` does not keep `.tether/` out yet (the renderer asks); undefined when nothing to ask. */
  askGitignore?: string
}

/**
 * A new note file for a pane's folder (or none): the folder is created, the name is `AAAA-MM-DD-HHmm.md` made
 * unique, the empty file is written (the tab has a name and the watcher a file from the first moment). In a
 * repository without `.tether/` in `.gitignore`, says which repository, unless `declined` has it.
 */
export function prepareNote(paneCwd: string | undefined, opts: { env?: NodeJS.ProcessEnv; now?: Date; declined?: readonly string[]; dir?: string } = {}): PreparedNote {
  // `dir`: the folder exactly ("Minhas notas", "Outro"); the `.gitignore` question is only for a project's own `.tether/`.
  const dir = opts.dir ?? notesDirFor(paneCwd, opts.env)
  mkdirSync(dir, { recursive: true })
  const name = uniqueFileName(noteFileName(opts.now), candidate => existsSync(join(dir, candidate)))
  const path = join(dir, name)
  writeTextAtomic(path, '')
  const out: PreparedNote = { path }
  if (paneCwd && !opts.dir) {
    const root = findGitRoot(paneCwd)
    if (root && gitignoreStatus(root) === 'missing' && !(opts.declined ?? []).some(d => sameDir(d, root))) out.askGitignore = root
  }
  return out
}

/** Case-insensitive on Windows (paths come from different sources). */
function sameDir(a: string, b: string): boolean {
  const norm = (p: string): string => resolve(p).replace(/[\\/]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/** Renames a note within its folder or to another; refuses to overwrite. */
export function renameNote(from: string, to: string): { ok: true } | { ok: false; message: string } {
  try {
    if (existsSync(to)) return { ok: false, message: 'Já existe um arquivo com esse nome.' }
    mkdirSync(dirname(to), { recursive: true })
    renameSync(from, to)
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/** How long after the last event of a file the change is reported (an editor writing in two steps, our own temp + rename). */
export const WATCH_DEBOUNCE_MS = 150

/**
 * One watcher per folder, with the open note paths of that folder; a change of one of them (by name) is reported
 * once the events settle. `fs.watch` is not guaranteed everywhere: a failure to watch is logged and the note just
 * does not learn about outside changes.
 */
export class NoteWatchers {
  private readonly dirs = new Map<string, { watcher: FSWatcher; names: Map<string, { path: string; refs: number }>; timers: Map<string, ReturnType<typeof setTimeout>> }>()
  private readonly onChange: (path: string) => void

  constructor(onChange: (path: string) => void) {
    this.onChange = onChange
  }

  watch(path: string): void {
    const dir = dirname(path)
    const name = basename(path)
    let entry = this.dirs.get(dir)
    if (!entry) {
      let watcher: FSWatcher
      try {
        watcher = watch(dir, { persistent: false }, (_event, filename) => this.onEvent(dir, filename == null ? undefined : String(filename)))
        watcher.on('error', err => console.error(`notas: o observador de ${dir} falhou: ${err.message}`))
      } catch (err) {
        console.error(`notas: não foi possível observar ${dir}: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      entry = { watcher, names: new Map(), timers: new Map() }
      this.dirs.set(dir, entry)
    }
    // A note and its preview watch the same file: the watch ends when the last of them lets go.
    const key = name.toLowerCase()
    const known = entry.names.get(key)
    if (known) known.refs++
    else entry.names.set(key, { path, refs: 1 })
  }

  unwatch(path: string): void {
    const dir = dirname(path)
    const entry = this.dirs.get(dir)
    if (!entry) return
    const key = basename(path).toLowerCase()
    const known = entry.names.get(key)
    if (known && --known.refs > 0) return
    entry.names.delete(key)
    const t = entry.timers.get(key)
    if (t) { clearTimeout(t); entry.timers.delete(key) }
    if (entry.names.size === 0) { entry.watcher.close(); this.dirs.delete(dir) }
  }

  private onEvent(dir: string, filename: string | undefined): void {
    const entry = this.dirs.get(dir)
    if (!entry) return
    // No name (some platforms): every open note of the folder may have changed.
    const keys = filename ? [filename.toLowerCase()] : [...entry.names.keys()]
    for (const key of keys) {
      const path = entry.names.get(key)?.path
      if (!path) continue
      const old = entry.timers.get(key)
      if (old) clearTimeout(old)
      entry.timers.set(key, setTimeout(() => { entry.timers.delete(key); this.onChange(path) }, WATCH_DEBOUNCE_MS))
    }
  }

  close(): void {
    for (const e of this.dirs.values()) { e.watcher.close(); for (const t of e.timers.values()) clearTimeout(t) }
    this.dirs.clear()
  }
}
