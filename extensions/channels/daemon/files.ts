// A speech's files into the channel's folder (slice A1): the daemon checks every file again by the pure rules (the app's check
// is not trusted) and copies each one into <home>/channels/<id>/files/ under a safe name that never covers another one.
// The copy is the system's (copyFile with COPYFILE_EXCL): nothing of the file passes through this process's memory, and the
// exclusive flag makes the unique name race-free. Nothing here opens a file to read its content.
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { ATTACH_MAX_PER_SAY, baseName, fileRefusal, mimeOf, numberedName, safeFileName, type FileRefusal, type FileSource, type LineFile } from '../attachments.ts'

export type { FileSource }

/** Names tried before a copy gives up (`x (2).png` … `x (999).png`). */
export const NAME_TRIES = 999

export type FilesOutcome = { ok: true; files: LineFile[] } | { ok: false; error: FileRefusal; file: string }

/** The disk the copier uses; tests give a fake one. */
export interface FilesDisk {
  stat(path: string): Promise<{ size: number; isFile: boolean; isDirectory: boolean } | undefined>
  mkdirp(path: string): Promise<void>
  /** Copies only when `to` does not exist; false when it does. */
  copyNew(from: string, to: string): Promise<boolean>
  rm(path: string): Promise<void>
  /** Marks a copy as come from another computer (the Internet zone), where the disk can carry the mark; never fails. */
  markFromAfar?(path: string): Promise<void>
}

/** The mark of origin Windows reads (Attachment Manager, SmartScreen): zone 3, the Internet. */
export const ZONE_IDENTIFIER = '[ZoneTransfer]\r\nZoneId=3\r\n'

const code = (e: unknown): string | undefined => (e as { code?: string } | undefined)?.code

export const nodeDisk: FilesDisk = {
  stat: async (p) => {
    try {
      const s = await stat(p)
      return { size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory() }
    } catch (e) {
      if (code(e) === 'ENOENT' || code(e) === 'ENOTDIR') return undefined
      throw e
    }
  },
  mkdirp: async (p) => { await mkdir(p, { recursive: true }) },
  copyNew: async (from, to) => {
    try {
      await copyFile(from, to, constants.COPYFILE_EXCL)
      return true
    } catch (e) {
      if (code(e) === 'EEXIST') return false
      throw e
    }
  },
  rm: async (p) => { await rm(p, { force: true }) },
  // An alternate data stream: only on Windows, and only a disk that has streams (NTFS) takes it; elsewhere nothing is marked.
  markFromAfar: async (p) => {
    if (process.platform !== 'win32') return
    await writeFile(`${p}:Zone.Identifier`, ZONE_IDENTIFIER, { flag: 'w' }).catch(() => undefined)
  },
}

/** The sources as the request carries them: a list of `{ path, name? }`, at most ATTACH_MAX_PER_SAY, every path absolute. */
export function parseSources(v: unknown): FileSource[] | 'bad-request' | 'too-many' {
  if (v === undefined) return []
  if (!Array.isArray(v)) return 'bad-request'
  if (v.length > ATTACH_MAX_PER_SAY) return 'too-many'
  const out: FileSource[] = []
  for (const x of v) {
    if (!x || typeof x !== 'object') return 'bad-request'
    const { path, name } = x as { path?: unknown; name?: unknown }
    if (typeof path !== 'string' || path === '' || !isAbsolute(path)) return 'bad-request'
    if (name !== undefined && (typeof name !== 'string' || name === '')) return 'bad-request'
    out.push({ path, ...(typeof name === 'string' ? { name } : {}) })
  }
  return out
}

/** The portal's staging folder inside a channel's `files` (src/remoted/files.ts UPLOAD_DIR) and the name of a whole upload there. */
export const REMOTE_UPLOAD_DIR = '.remote-upload'
const REMOTE_READY_RE = /^[0-9a-f]{32}-[0-3]-[0-9a-f]{8}\.ready$/

/**
 * Whether every source is a whole upload the portal wrote for THIS channel (RR4 B-1): once every link is resolved, a regular
 * file with one link, directly inside `<files>/.remote-upload/`, named `<act>-<i>-<dev8>.ready`. The portal is not trusted
 * (RR3 B-8): a `remote` that names any other path (a key, another channel's file) gets nothing copied.
 */
export async function onlyRemoteUploads(filesDir: string, sources: readonly FileSource[]): Promise<boolean> {
  let staging: string
  try { staging = await realpath(join(filesDir, REMOTE_UPLOAD_DIR)) } catch { return sources.length === 0 }
  if (staging !== join(await realpath(filesDir).catch(() => ''), REMOTE_UPLOAD_DIR)) return false
  for (const s of sources) {
    try {
      const real = await realpath(s.path)
      if (dirname(real) !== staging || !REMOTE_READY_RE.test(basename(real))) return false
      const st = await lstat(real)
      if (!st.isFile() || st.nlink !== 1) return false
    } catch { return false }
  }
  return true
}

/**
 * Checks every source (gone, a folder, a secret's name by the source's name AND the name it goes by, too large) and only then
 * copies them all into `dir`; a copy that fails takes back the ones already made. The line gets each file's absolute path.
 * `fromAfar`: the files came from a device (the portal's uploads), so every copy gets the mark of origin.
 */
export async function storeFiles(dir: string, sources: readonly FileSource[], disk: FilesDisk = nodeDisk, opts: { fromAfar?: boolean } = {}): Promise<FilesOutcome> {
  if (sources.length > ATTACH_MAX_PER_SAY) return { ok: false, error: 'too-many', file: '' }
  const checked: Array<{ from: string; name: string; size: number }> = []
  for (const s of sources) {
    const shown = s.name ?? baseName(s.path)
    const facts = await disk.stat(s.path).catch(() => undefined)
    const why = fileRefusal({ name: shown, size: facts?.size ?? 0, ...(facts ? { isDirectory: !facts.isFile } : { missing: true }) })
      ?? (fileRefusal({ name: baseName(s.path), size: 0 }) === 'secret-file' ? 'secret-file' : undefined)
    if (why) return { ok: false, error: why, file: shown }
    checked.push({ from: s.path, name: safeFileName(shown), size: facts!.size })
  }
  if (checked.length === 0) return { ok: true, files: [] }
  const folder = resolve(dir)
  const made: LineFile[] = []
  try {
    await disk.mkdirp(folder)
    for (const c of checked) {
      let to: string | undefined
      for (let n = 1; n <= NAME_TRIES && to === undefined; n++) {
        const name = numberedName(c.name, n)
        const target = resolve(folder, name)
        if (await disk.copyNew(c.from, target)) { to = target; made.push({ name, path: target, size: c.size, type: mimeOf(name) }) }
      }
      if (to === undefined) throw new Error('no free name')
      if (opts.fromAfar) await disk.markFromAfar?.(to)
    }
  } catch {
    for (const f of made) await disk.rm(f.path).catch(() => undefined)
    return { ok: false, error: 'copy-failed', file: checked[made.length]?.name ?? '' }
  }
  return { ok: true, files: made }
}
