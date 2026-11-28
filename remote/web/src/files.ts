// The files of the speeches on the web (RR4 step 4.3): what the shared screen's `files` (extensions/channels/renderer/host.ts
// ChannelHostFiles) is on a device. Two halves:
//   - the conversation's files, by reference (file-rules.ts `rr/<channel>/<seq>/<index>`, never a path): an image of the
//     four types comes chunk by chunk through the session, its bytes are checked here by their signature (after the
//     portal), and only then it is drawn, from a `blob:` URL of those bytes (a thumbnail and the big picture); any other
//     file is a card that downloads it ("Baixar", always as application/octet-stream); over FILE_MAX_BYTES it is named,
//     sized and "grande demais para ver de longe";
//   - the box's files, from the system's picker (on a phone, the camera and the gallery), a paste or a drop: kept in this
//     page's memory as File objects under a local key, with a thumbnail of an image whose bytes are checked the same way.
// Memory: the files the conversation brought are kept up to CACHE_BYTES, the oldest let go of first (its URL revoked).
import type { AttachInfo, FileLook, FileView } from '../../../extensions/channels/ipc.ts'
import type { ChannelHostFiles } from '../../../extensions/channels/renderer/host.ts'
import { fromB64url } from '../../../src/remote/index.ts'
import {
  drawableType, FILE_MAX_BYTES, isImageType, OTHER_TYPE, parseFileRef, REMOTE_ATTACH_LIMITS, TOO_BIG_TEXT, type FileType,
} from './file-rules.ts'

/** Bytes of the conversation's files a page keeps (their `blob:` URLs live while they are kept). */
export const CACHE_BYTES = 64 * 1024 * 1024

export const FILE_TEXT = {
  download: 'Baixar',
  downloadTitle: 'Baixar o arquivo para este aparelho',
  unreadable: 'Esta imagem não pôde ser mostrada aqui. Use "Baixar".',
  notImage: 'Este arquivo não é uma imagem que se mostre aqui. Use "Baixar".',
  gone: 'O arquivo não está mais na máquina.',
} as const

/** What the page knows of a file of a line from the page it read: its name, its size, its type by the house's word. */
export interface KnownFile { name: string; size: number; type: string }

/** A file of the conversation as it came. */
export type Got =
  | { kind: 'image'; url: string; blob: Blob; type: FileType; size: number }
  | { kind: 'file'; blob: Blob; size: number }
  | { kind: 'too-big'; size: number }
  | { kind: 'missing' }

/** What the files need of the house: one chunk of a file of a line. */
export interface FileChunks {
  fileChunk(channel: string, seq: number, file: number, offset: number): Promise<{ size: number; type: string; offset: number; data: string }>
}

export interface RemoteFilesOptions {
  /** Saves a file to the device (an `<a download>`; a test gives its own). */
  save?: (blob: Blob, name: string) => void
  /** The system's picker (an `<input type="file" multiple>`; a test gives its own). */
  choose?: () => Promise<File[]>
}

export interface RemoteFiles extends ChannelHostFiles {
  /** The page read a line with files: what it says of them (by reference). */
  known(ref: string, f: KnownFile): void
  /** The files of the box under these keys (what `say` carries), in order; a key it does not hold is skipped. */
  local(paths: readonly string[]): Array<{ file: File; name: string }>
  /** Downloads a file of the conversation by its reference. */
  download(ref: string): Promise<void>
  /** A file of the conversation, as it came (tests and the viewer). */
  get(ref: string): Promise<Got>
  dispose(): void
}

const createObjectURL = (b: Blob): string => URL.createObjectURL(b)
const revoke = (u: string): void => { try { URL.revokeObjectURL(u) } catch { /* already gone */ } }

/** The system's picker: every type, many at once; on a phone it offers the camera and the gallery. */
export function systemPicker(): Promise<File[]> {
  return new Promise(done => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.hidden = true
    let settled = false
    const end = (files: File[]): void => { if (settled) return; settled = true; input.remove(); done(files) }
    input.addEventListener('change', () => end([...(input.files ?? [])]))
    input.addEventListener('cancel', () => end([]))
    document.body.append(input)
    input.click()
  })
}

function saveBlob(blob: Blob, name: string): void {
  const url = createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  a.hidden = true
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => revoke(url), 60_000)
}

export function remoteFiles(chunks: FileChunks, o: RemoteFilesOptions = {}): RemoteFiles {
  const save = o.save ?? saveBlob
  const choose = o.choose ?? systemPicker
  const known = new Map<string, KnownFile>()
  const cache = new Map<string, { got: Promise<Got>; bytes: number; url?: string }>()
  let cached = 0
  /** The downloads go one after the other (the chunks have the page's pace anyway). */
  let lane: Promise<unknown> = Promise.resolve()
  let disposed = false

  const drop = (ref: string): void => {
    const c = cache.get(ref)
    if (!c) return
    cache.delete(ref)
    cached -= c.bytes
    if (c.url) revoke(c.url)
  }

  const fetchBytes = async (ref: string): Promise<Got> => {
    const at = parseFileRef(ref)
    if (!at) return { kind: 'missing' }
    let size = -1
    let type = ''
    let buf: Uint8Array<ArrayBuffer> | undefined
    let offset = 0
    try {
      do {
        const c = await chunks.fileChunk(at.channel, at.seq, at.index, offset)
        if (size < 0) {
          size = c.size
          type = c.type
          if (size > FILE_MAX_BYTES) return { kind: 'too-big', size }
          buf = new Uint8Array(size)
        } else if (c.size !== size) return { kind: 'missing' }
        const data = fromB64url(c.data)
        if (data.length === 0 || offset + data.length > size) break
        buf!.set(data, offset)
        offset += data.length
      } while (offset < size && !disposed)
    } catch (e) {
      const why = (e as { why?: string }).why
      if (why === 'not-found') return { kind: 'missing' }
      if (why === 'too-large') return { kind: 'too-big', size: known.get(ref)?.size ?? 0 }
      throw e
    }
    if (!buf || offset !== size) throw new Error('incomplete')
    // Drawn only when the portal's word and the bytes' own signature agree on one of the four images.
    const mine = drawableType(buf)
    if (isImageType(type) && mine === type) {
      const blob = new Blob([buf], { type: mine })
      return { kind: 'image', url: createObjectURL(blob), blob, type: mine, size }
    }
    return { kind: 'file', blob: new Blob([buf], { type: OTHER_TYPE }), size }
  }

  const get = (ref: string): Promise<Got> => {
    const c = cache.get(ref)
    if (c) { cache.delete(ref); cache.set(ref, c); return c.got }
    const entry: { got: Promise<Got>; bytes: number; url?: string } = { got: Promise.resolve({ kind: 'missing' }), bytes: 0 }
    const got = lane.then(() => fetchBytes(ref), () => fetchBytes(ref))
    lane = got.catch(() => undefined)
    entry.got = got
    cache.set(ref, entry)
    void got.then(g => {
      if (cache.get(ref) !== entry) { if (g.kind === 'image') revoke(g.url); return }
      entry.bytes = g.kind === 'image' || g.kind === 'file' ? g.size : 0
      if (g.kind === 'image') entry.url = g.url
      cached += entry.bytes
      for (const k of [...cache.keys()]) { if (cached <= CACHE_BYTES || k === ref) break; drop(k) }
    }, () => { if (cache.get(ref) === entry) cache.delete(ref) })
    return got
  }

  /** A file the page says is one of the four images, within the ceiling: the only kind fetched without the person asking. */
  const thumbable = (ref: string): boolean => {
    const k = known.get(ref)
    return k !== undefined && isImageType(k.type) && k.size > 0 && k.size <= FILE_MAX_BYTES
  }

  // ---- the box
  const local = new Map<string, { file: File; thumb?: string }>()
  let nextLocal = 0
  const keyOf = (file: File): string => {
    for (const [k, v] of local) if (v.file === file) return k
    const k = `local/${++nextLocal}`
    local.set(k, { file })
    return k
  }
  const infoOf = async (path: string): Promise<AttachInfo> => {
    const l = local.get(path)
    if (!l) return { path, name: path, size: 0, isDirectory: false, missing: true }
    if (l.thumb === undefined && l.file.size > 0 && l.file.size <= FILE_MAX_BYTES) {
      const head = new Uint8Array(await l.file.slice(0, 12).arrayBuffer())
      const t = drawableType(head)
      if (isImageType(t)) l.thumb = createObjectURL(l.file.slice(0, l.file.size, t))
    }
    // An empty file has nothing to send: it is "not there" for the box.
    return { path, name: l.file.name || 'arquivo', size: l.file.size, isDirectory: false, missing: l.file.size === 0, staged: true, ...(l.thumb ? { thumb: l.thumb } : {}) }
  }

  const files: RemoteFiles = {
    limits: REMOTE_ATTACH_LIMITS,
    viewer: { openApp: FILE_TEXT.download, openAppTitle: FILE_TEXT.downloadTitle, unreadable: FILE_TEXT.unreadable, menu: false },
    inspect: paths => Promise.all(paths.map(infoOf)),
    pick: async () => Promise.all((await choose()).map(f => infoOf(keyOf(f)))),
    stageImage: async () => undefined,
    discard: paths => {
      for (const p of paths) {
        const l = local.get(p)
        if (l?.thumb) revoke(l.thumb)
        local.delete(p)
      }
    },
    pathOf: file => keyOf(file),
    look: async paths => Promise.all(paths.map(async (path): Promise<FileLook> => {
      const k = known.get(path)
      if (!k) return { path, missing: false }
      if (k.size > FILE_MAX_BYTES) return { path, missing: false, note: TOO_BIG_TEXT }
      if (!thumbable(path)) return { path, missing: false }
      try {
        const g = await get(path)
        if (g.kind === 'missing') return { path, missing: true }
        if (g.kind === 'too-big') return { path, missing: false, note: TOO_BIG_TEXT }
        return g.kind === 'image' ? { path, missing: false, thumb: g.url } : { path, missing: false }
      } catch { return { path, missing: false } }
    })),
    view: async path => {
      const k = known.get(path)
      if (k && k.size > FILE_MAX_BYTES) return { path, missing: false, note: `${k.name}: ${TOO_BIG_TEXT}.` }
      try {
        const g = await get(path)
        switch (g.kind) {
          case 'image': return { path, missing: false, url: g.url }
          case 'file': return { path, missing: false, note: FILE_TEXT.notImage }
          case 'too-big': return { path, missing: false, note: `${TOO_BIG_TEXT}.` }
          case 'missing': return { path, missing: true }
        }
      } catch { return { path, missing: false } }
    },
    known: (ref, f) => { known.set(ref, f) },
    local: paths => paths.flatMap(p => { const l = local.get(p); return l ? [{ file: l.file, name: l.file.name || 'arquivo' }] : [] }),
    get,
    download: async ref => {
      const k = known.get(ref)
      if (k && k.size > FILE_MAX_BYTES) return
      const g = await get(ref)
      if (g.kind === 'missing' || g.kind === 'too-big') return
      // Always as bytes to keep, never as something to open: an image too goes as application/octet-stream.
      save(g.kind === 'file' ? g.blob : new Blob([g.blob], { type: OTHER_TYPE }), k?.name ?? 'arquivo')
    },
    dispose: () => {
      disposed = true
      for (const k of [...cache.keys()]) drop(k)
      for (const l of local.values()) if (l.thumb) revoke(l.thumb)
      local.clear()
    },
  }
  return files
}
