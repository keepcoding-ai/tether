// The files of a speech from afar at the portal (step 4.3): the one place that touches the disk for a device.
//
// Seeing: a device names a file by (channel, seq, index), never by a path. The path comes from the line tetherd keeps (the
// house reads it by EXT_READS `history`) and is given only when, after every link and `..` is resolved, it is a regular
// file directly inside that channel's folder (`<home>/channels/<id>/files`), whose folder is no link itself. Anything else
// is `not-found`, the same answer as a file that is not there. The type is the first bytes' (src/remote/files.ts
// sniffType), the file is read one chunk at a time from a handle opened on the resolved path, and a file over
// FILE_MAX_BYTES is never read.
//
// Sending: each file of a speech is written, chunk by chunk at fixed offsets, to a temporary file in the channel's folder
// (`files/.remote-upload/`), never anywhere else; it is renamed only when it is whole and its size on disk is the one
// announced. The speech then hands tetherd the ready files' paths (`say` with `files`, as the app does: tetherd checks and
// copies them under the safe name) and the temporary ones go. A repeat of a chunk changes nothing (the offset already
// passed answers what is held); a device that comes back after a cut goes on from `received`. Abandoned uploads go after
// UPLOAD_IDLE_MS; what a previous portal left goes at start. Memory: one chunk per request in flight, never a whole file;
// at most UPLOADS_MAX uploads at once for the portal and UPLOADS_PER_DEVICE_MAX for one device, FILE_READS_MAX reads.
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { join, relative, sep, isAbsolute } from 'node:path'
import { FILE_CHUNK_BYTES, FILE_MAX_BYTES, FILES_PER_SAY_MAX, SNIFF_BYTES, sniffType, UPLOAD_IDLE_MS, type FileType, type UploadArgs } from '../remote/files.ts'

/** Chunks read at once, every device together. */
export const FILE_READS_MAX = 4
/** Uploads not yet said (being written, or whole and waiting for their speech), every device together. */
export const UPLOADS_MAX = 16
/** The same, for one device: two speeches' worth. */
export const UPLOADS_PER_DEVICE_MAX = 2 * FILES_PER_SAY_MAX
/** The folder of the temporary files, inside the channel's folder of files. */
export const UPLOAD_DIR = '.remote-upload'

const code = (e: unknown): string | undefined => (e as { code?: string } | undefined)?.code

/** Whether `child` is directly inside `folder` (both resolved): one segment, no `..`, not absolute. */
const directChild = (folder: string, child: string): boolean => {
  const r = relative(folder, child)
  return r !== '' && !isAbsolute(r) && !r.startsWith('..') && !r.includes(sep) && !r.includes('/')
}

/** A chunk of a file as the projector takes it. */
export interface ChunkRead { size: number; type: FileType; offset: number; data: string }

/** Why a file of a line is not given: not there (or not allowed: the same), over the ceiling, an offset past its end. */
export type FileReadRefusal = 'not-found' | 'too-large' | 'bad-request' | 'busy'

/** Where a line keeps its files, from the answer of tetherd's `history` (one line asked). Undefined: no such file. */
export function linePathOf(answer: unknown, seq: number, index: number): string | undefined {
  const lines = (answer as { lines?: unknown } | undefined)?.lines
  if (!Array.isArray(lines)) return undefined
  const line = lines.find((l) => (l as { seq?: unknown } | undefined)?.seq === seq) as { kind?: unknown; files?: unknown } | undefined
  if (!line || line.kind !== 'message' || !Array.isArray(line.files)) return undefined
  const path = (line.files[index] as { path?: unknown } | undefined)?.path
  return typeof path === 'string' && path !== '' && isAbsolute(path) ? path : undefined
}

export interface PortalFilesDeps {
  /** tetherd's home (core/paths.ts tetherHome): the channels live in `<home>/channels/<id>`. */
  home: string
  now(): number
  log(m: string): void
}

interface Upload {
  device: string
  act: string
  file: number
  channel: string
  name: string
  size: number
  received: number
  tmp: string
  ready?: string
  /** `part`: being written; `ready`: whole and checked; `said`: handed to a speech, waiting for its outcome. */
  state: 'part' | 'ready' | 'said'
  touchedMs: number
  /** The writes of this upload, one after the other. */
  lane: Promise<unknown>
}

export type UploadOutcome = { received: number; done: boolean } | 'busy' | 'not-found' | 'bad-request' | 'secret-file' | 'failed'

export class PortalFiles {
  readonly #d: PortalFilesDeps
  readonly #uploads = new Map<string, Upload>()
  #reads = 0

  constructor(d: PortalFilesDeps) { this.#d = d }

  /** Uploads held now (diagnostics and tests). */
  get uploads(): number { return this.#uploads.size }

  #channelsRoot(): string { return join(this.#d.home, 'channels') }

  /**
   * The channel's folder of files, resolved, when the channel's own folder is there and neither it nor `files` (when it
   * exists) is a link: a link there would carry every file of the channel somewhere else.
   */
  async #channelFolder(channel: string, make: boolean): Promise<string | undefined> {
    // One segment that begins with a word character: never `.`, `..` nor a path (the bodies already say so; this is the disk's own guard).
    if (!/^\w[\w.:-]{0,63}$/.test(channel)) return undefined
    try {
      const root = await realpath(this.#channelsRoot())
      const dir = join(this.#channelsRoot(), channel)
      const st = await lstat(dir)
      if (!st.isDirectory() || st.isSymbolicLink()) return undefined
      const realDir = await realpath(dir)
      if (realDir !== join(root, channel)) return undefined
      const files = join(realDir, 'files')
      if (make) await mkdir(files, { recursive: true })
      const fst = await lstat(files)
      if (!fst.isDirectory() || fst.isSymbolicLink() || (await realpath(files)) !== files) return undefined
      return files
    } catch (e) {
      if (code(e) !== 'ENOENT' && code(e) !== 'ENOTDIR') this.#d.log(`files: channel folder: ${code(e) ?? (e as Error).message}`)
      return undefined
    }
  }

  /**
   * The file at `path` (as the line says it), when it is a regular file directly inside the channel's folder once every
   * link and `..` is resolved. Undefined otherwise: the caller answers it as a file that is not there.
   */
  async resolve(channel: string, path: string): Promise<{ path: string; ino: number; dev: number } | undefined> {
    const folder = await this.#channelFolder(channel, false)
    if (!folder) return undefined
    try {
      const real = await realpath(path)
      if (!directChild(folder, real)) return undefined
      // A hard link resolves to itself: a file of the folder with another name elsewhere is refused by its link count (the
      // daemon's copies always make a file of its own).
      const st = await lstat(real)
      return st.isFile() && st.nlink === 1 ? { path: real, ino: st.ino, dev: st.dev } : undefined
    } catch { return undefined }
  }

  /** One chunk of the file at `path` of the line (already the line's), from `offset`. */
  async chunk(channel: string, path: string, offset: number): Promise<ChunkRead | FileReadRefusal> {
    if (this.#reads >= FILE_READS_MAX) return 'busy'
    this.#reads++
    try {
      const real = await this.resolve(channel, path)
      if (!real) return 'not-found'
      let h
      try { h = await open(real.path, 'r') } catch { return 'not-found' }
      try {
        // The file opened is the one resolved (a swap for a link between the two is refused).
        const st = await h.stat()
        if (!st.isFile() || st.nlink !== 1 || st.ino !== real.ino || st.dev !== real.dev) return 'not-found'
        if (st.size > FILE_MAX_BYTES) return 'too-large'
        if (offset > 0 && offset >= st.size) return 'bad-request'
        const head = Buffer.alloc(Math.min(SNIFF_BYTES, st.size))
        if (head.length) await h.read(head, 0, head.length, 0)
        const want = Math.min(FILE_CHUNK_BYTES, st.size - offset)
        const buf = Buffer.alloc(Math.max(0, want))
        let got = 0
        while (got < want) {
          const r = await h.read(buf, got, want - got, offset + got)
          if (r.bytesRead === 0) break
          got += r.bytesRead
        }
        return { size: st.size, type: sniffType(head), offset, data: buf.subarray(0, got).toString('base64url') }
      } finally { await h.close().catch(() => undefined) }
    } finally { this.#reads-- }
  }

  // ---- uploads

  #key(device: string, act: string, file: number): string { return `${device}:${act}:${file}` }

  /** One chunk of an upload (the body already checked by src/remote/files.ts uploadArgs). */
  async upload(device: string, a: UploadArgs): Promise<UploadOutcome> {
    if (a.secret) return 'secret-file'
    const key = this.#key(device, a.act, a.file)
    let u = this.#uploads.get(key)
    if (u && (u.channel !== a.channel || u.name !== a.name || u.size !== a.size)) return 'bad-request'
    if (!u) {
      // An upload the portal does not hold starts at 0: a device that comes back after a restart starts that file over.
      if (a.offset !== 0) return { received: 0, done: false }
      if (this.#uploads.size >= UPLOADS_MAX) return 'busy'
      if ([...this.#uploads.values()].filter((x) => x.device === device).length >= UPLOADS_PER_DEVICE_MAX) return 'busy'
      const folder = await this.#channelFolder(a.channel, true)
      if (!folder) return 'not-found'
      const staging = join(folder, UPLOAD_DIR)
      try {
        await mkdir(staging, { recursive: true })
        const st = await lstat(staging)
        if (!st.isDirectory() || st.isSymbolicLink() || (await realpath(staging)) !== staging) return 'not-found'
      } catch { return 'failed' }
      // Another request of the same file may have made it meanwhile.
      u = this.#uploads.get(key)
      if (!u) {
        u = {
          device, act: a.act, file: a.file, channel: a.channel, name: a.name, size: a.size, received: 0,
          tmp: join(staging, `${a.act}-${a.file}-${device.slice(0, 8)}.part`), state: 'part', touchedMs: this.#d.now(), lane: Promise.resolve(),
        }
        this.#uploads.set(key, u)
        u.lane = rm(u.tmp, { force: true }).catch(() => undefined)
      }
    }
    const up = u
    const run = up.lane.then(() => this.#write(key, up, a))
    up.lane = run.catch(() => undefined)
    return run
  }

  async #write(key: string, u: Upload, a: UploadArgs): Promise<UploadOutcome> {
    if (this.#uploads.get(key) !== u) return { received: 0, done: false }
    u.touchedMs = this.#d.now()
    if (u.state !== 'part') return { received: u.size, done: true }
    if (a.offset !== u.received) return { received: u.received, done: false }
    try {
      const h = await open(u.tmp, u.received === 0 ? 'w' : 'r+')
      try { await h.write(a.data, 0, a.data.length, a.offset) } finally { await h.close() }
      u.received += a.data.length
      if (u.received < u.size) return { received: u.received, done: false }
      // Whole: only the size on disk that was announced makes it ready, and only then is it renamed.
      const st = await stat(u.tmp)
      if (st.size !== u.size) { await this.#drop(key); return 'failed' }
      const ready = u.tmp.replace(/\.part$/, '.ready')
      await rename(u.tmp, ready)
      u.ready = ready
      u.state = 'ready'
      return { received: u.size, done: true }
    } catch (e) {
      this.#d.log(`files: upload write: ${code(e) ?? (e as Error).message}`)
      await this.#drop(key)
      return code(e) === 'ENOENT' ? { received: 0, done: false } : 'failed'
    }
  }

  async #drop(key: string): Promise<void> {
    const u = this.#uploads.get(key)
    if (!u) return
    this.#uploads.delete(key)
    await rm(u.tmp, { force: true }).catch(() => undefined)
    if (u.ready) await rm(u.ready, { force: true }).catch(() => undefined)
  }

  /**
   * The ready files of a speech for tetherd's `say` (`[{path, name}]`), marked as said: every index must be whole and of
   * that channel, else undefined (`unknown-file`). A speech already handed its files gets them again (a resend of the act
   * whose first try never reached tetherd).
   */
  forSpeech(device: string, act: string, channel: string, files: readonly number[]): Array<{ path: string; name: string }> | undefined {
    const out: Array<{ path: string; name: string }> = []
    const ups: Upload[] = []
    for (const i of files) {
      const u = this.#uploads.get(this.#key(device, act, i))
      if (!u || u.channel !== channel || u.state === 'part' || !u.ready) return undefined
      ups.push(u)
      out.push({ path: u.ready, name: u.name })
    }
    for (const u of ups) { u.state = 'said'; u.touchedMs = this.#d.now() }
    return out
  }

  /** The speech's outcome is known: its temporary files go (`keep`: it never reached tetherd, they wait for a resend). */
  async settled(device: string, act: string, keep: boolean): Promise<void> {
    for (let i = 0; i < FILES_PER_SAY_MAX; i++) {
      const key = this.#key(device, act, i)
      const u = this.#uploads.get(key)
      if (!u) continue
      if (keep && u.state === 'said') { u.state = 'ready'; u.touchedMs = this.#d.now(); continue }
      if (!keep) await this.#drop(key)
    }
  }

  /** The person gave up one file of a speech, or all of them. A file already handed to its speech stays its. */
  async cancel(device: string, act: string, file?: number): Promise<void> {
    for (let i = 0; i < FILES_PER_SAY_MAX; i++) {
      if (file !== undefined && i !== file) continue
      const key = this.#key(device, act, i)
      const u = this.#uploads.get(key)
      if (u && u.state !== 'said') { await u.lane; await this.#drop(key) }
    }
  }

  /**
   * Every upload of a device goes (it was revoked or forgotten). A chunk being written finishes first (its lane), so it
   * never makes the `.part` again after the delete (RR4 B-4).
   */
  async forgetDevice(device: string): Promise<void> {
    for (const [key, u] of [...this.#uploads]) {
      if (u.device !== device) continue
      for (let lane = u.lane; ; lane = u.lane) { await lane; if (u.lane === lane) break }
      await this.#drop(key)
    }
  }

  /** Uploads no chunk reached for UPLOAD_IDLE_MS go, with their files (a speech's are kept while it waits for tetherd). */
  async sweep(nowMs: number, idleMs = UPLOAD_IDLE_MS): Promise<void> {
    for (const [key, u] of [...this.#uploads]) {
      if (nowMs - u.touchedMs >= idleMs && u.state !== 'said') { await u.lane; await this.#drop(key) }
    }
  }

  /**
   * At start: the temporary files a previous portal left in every channel's folder go (this portal holds none of them).
   * One read of the channels' folder; the staging folder of a channel is only read when it is there.
   */
  async sweepDisk(): Promise<void> {
    let ids: string[]
    try { ids = (await readdir(this.#channelsRoot(), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return }
    for (const id of ids) {
      const folder = await this.#channelFolder(id, false)
      if (!folder) continue
      const staging = join(folder, UPLOAD_DIR)
      try {
        const st = await lstat(staging)
        if (!st.isDirectory() || st.isSymbolicLink()) continue
        for (const f of await readdir(staging)) if (/\.(part|ready)$/.test(f)) await rm(join(staging, f), { force: true }).catch(() => undefined)
      } catch { /* no staging folder: nothing left */ }
    }
  }
}
