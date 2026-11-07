/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The single writer of the person's settings.json (main process; no Electron here, so the unit and e2e tests run it under Node).
// Origin: https://github.com/microsoft/vscode, commit 7faf984945fefaceb533ca1d851697a2e72e4e68
//   src/vs/workbench/services/configuration/common/configurationEditing.ts (writes are text edits of the file; an
//     unparsable file is refused, never overwritten)
//   src/vs/platform/configuration/common/configurationModels.ts (the model re-read on a file change, `compare` → changed keys)
// Adapted: the text is kept in memory (the last read or written one), edits go through settings-file.ts (comments and layout
// survive), a write is temp file + rename, and a watcher (the notes' NoteWatchers) re-reads the file after an outside edit and
// reports the dotted keys that changed. While the file does not parse the last good values stay in force and writes are refused.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { diffSettings, parseSettings, setSettingText, type SettingsError } from '../shared/settings-file.ts'
import { NoteWatchers, writeTextAtomic } from './note-files.ts'

export type SettingsPath = readonly (string | number)[]
export type SetResult = { ok: true } | { ok: false; errors: SettingsError[] }

export interface SettingsStoreOptions {
  path: string
  /** The keys that changed after a write of ours (`self`) or an edit of the file by someone else (`disk`). */
  onChange?(keys: string[], source: 'self' | 'disk'): void
  /** The file's parse state changed: errors when it does not parse, an empty list once it does again. */
  onErrors?(errors: SettingsError[]): void
  log?(msg: string): void
  /**
   * How many leading segments of a path name the setting it belongs to (the key written flat, `"ui.deskLine"`); the rest is a
   * path inside that setting's value (`terminal` holds an object). Default: the whole path, every leaf its own key.
   */
  keyOf?(path: readonly string[]): number
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export class SettingsStore {
  readonly path: string
  private readonly opts: SettingsStoreOptions
  private watchers: NoteWatchers | undefined
  private text = ''
  private good: Record<string, unknown> = {}
  private errs: SettingsError[] = []

  constructor(opts: SettingsStoreOptions) {
    this.path = opts.path
    this.opts = opts
    this.load()
  }

  /** The values in force: the last read of the file that parsed. */
  get value(): Record<string, unknown> { return this.good }
  /** The file's current text as the store knows it. */
  get fileText(): string { return this.text }
  /** Parse errors of the file now; empty when it is valid (or absent). */
  get errors(): readonly SettingsError[] { return this.errs }

  private readDisk(): string {
    try { return readFileSync(this.path, 'utf8') } catch { return '' }
  }

  private load(): void {
    this.text = this.readDisk()
    const parsed = parseSettings(this.text)
    this.errs = parsed.errors
    if (!parsed.errors.length) this.good = parsed.value
  }

  /** Starts the watcher on the file's folder (created when absent). Edits from outside are picked up after a short debounce. */
  watch(): void {
    if (this.watchers) return
    try {
      mkdirSync(join(this.path, '..'), { recursive: true })
      this.watchers = new NoteWatchers(() => this.reload())
      this.watchers.watch(this.path)
    } catch (err) {
      this.opts.log?.(`configurações: sem observador (${err instanceof Error ? err.message : String(err)})`)
    }
  }

  close(): void { this.watchers?.close(); this.watchers = undefined }

  /** Re-reads the file; reports what changed (the last good values against the new ones). Our own writes read back equal: no event. */
  reload(): void {
    const text = this.readDisk()
    if (text === this.text) return
    const before = this.good
    const hadErrors = this.errs.length > 0
    this.text = text
    const parsed = parseSettings(text)
    this.errs = parsed.errors
    if (parsed.errors.length) {
      this.opts.log?.(`configurações: ${this.path} não é um JSON válido; valores anteriores mantidos`)
      this.opts.onErrors?.(parsed.errors)
      return
    }
    this.good = parsed.value
    if (hadErrors) this.opts.onErrors?.([])
    const keys = diffSettings(before, this.good)
    if (keys.length) this.opts.onChange?.(keys, 'disk')
  }

  /** Sets (or, with undefined, removes) one value. Refused while the file does not parse; the file is not touched then. */
  set(path: SettingsPath, value: unknown): SetResult {
    return this.setMany([[path, value]])
  }

  /** Applies several edits to the text and writes once. */
  setMany(entries: ReadonlyArray<readonly [SettingsPath, unknown]>): SetResult {
    if (this.errs.length) return { ok: false, errors: [...this.errs] }
    // A path shorter than its setting's key with an object value is spread into the keys under it.
    const keyLen = (path: readonly string[]): number => this.opts.keyOf?.(path) ?? Infinity
    const flat: Array<[string[], unknown]> = []
    const expand = (path: string[], value: unknown): void => {
      if (isObject(value) && Object.keys(value).length && keyLen(path) > path.length) {
        for (const [k, v] of Object.entries(value)) expand([...path, k], v)
      } else flat.push([path, value])
    }
    for (const [path, value] of entries) expand(path.map(String), value)
    let text = this.text
    for (const [path, value] of flat) {
      const n = Math.max(1, Math.min(keyLen(path), path.length))
      const r = setSettingText(text, path.slice(0, n), path.slice(n), value)
      if (!r.ok) return r
      text = r.text
    }
    if (text === this.text) return { ok: true }
    const parsed = parseSettings(text)
    if (parsed.errors.length) return { ok: false, errors: parsed.errors }
    writeTextAtomic(this.path, text)
    const keys = diffSettings(this.good, parsed.value)
    this.text = text
    this.good = parsed.value
    if (keys.length) this.opts.onChange?.(keys, 'self')
    return { ok: true }
  }

  /**
   * Makes the object at `path` equal to `value` with the fewest edits: objects are compared key by key (a key missing from
   * `value` is removed), anything else is replaced when it differs. The person's comments around untouched keys stay.
   */
  assign(path: SettingsPath, value: unknown): SetResult {
    const entries: Array<[SettingsPath, unknown]> = []
    const walk = (p: SettingsPath, current: unknown, wanted: unknown): void => {
      if (isObject(wanted) && isObject(current)) {
        for (const k of Object.keys(current)) if (!(k in wanted)) entries.push([[...p, k], undefined])
        for (const [k, v] of Object.entries(wanted)) walk([...p, k], current[k], v)
      } else if (JSON.stringify(current) !== JSON.stringify(wanted) || (current === undefined) !== (wanted === undefined)) {
        entries.push([p, wanted])
      }
    }
    let current: unknown = this.good
    for (const seg of path) current = isObject(current) ? current[String(seg)] : undefined
    walk(path, current, value)
    return entries.length ? this.setMany(entries) : { ok: true }
  }
}

/**
 * One-time move of the person's files from the machine's home to the user folder: when the new file does not exist and the old
 * one does, the old is copied over (temp + rename) and renamed to `<name>.migrated`. Never deletes; running again changes nothing.
 * Returns the names moved.
 */
export function migrateUserFiles(oldDir: string, newDir: string, names: readonly string[], log?: (msg: string) => void): string[] {
  const moved: string[] = []
  if (oldDir === newDir) return moved
  for (const name of names) {
    const from = join(oldDir, name)
    const to = join(newDir, name)
    try {
      if (existsSync(to) || !existsSync(from)) continue
      mkdirSync(newDir, { recursive: true })
      const tmp = `${to}.${process.pid}.tmp`
      copyFileSync(from, tmp)
      renameSync(tmp, to)
      const kept = `${from}.migrated`
      renameSync(from, kept)
      moved.push(name)
      log?.(`configurações: ${name} movido para ${newDir} (o antigo ficou como ${name}.migrated)`)
    } catch (err) {
      log?.(`configurações: não foi possível migrar ${name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return moved
}
