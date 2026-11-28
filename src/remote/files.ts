// The files of a speech from afar (step 4.3): the ceilings both ends read, the type a file is by its first bytes (never by
// its name), the safe name an upload gets in the channel's folder, and the strict bodies of the three file lines
// (channels.file, channels.upload, channels.upload-cancel), checked field by field before anything touches the disk or the
// pipe. A device never names a path: it asks for a file by (channel, seq of the line, index of the file on it) and uploads
// under the actId of the speech the file goes with. Pure: no node:*, no DOM; the PWA reads the same ceilings.
import { fromB64url, type Bytes } from './bytes.ts'
import { sanitizeDeclaredName } from './content.ts'

/** The largest file a device sees or sends from afar (a bigger one is named and sized, never moved). */
export const FILE_MAX_BYTES = 10 * 1024 * 1024
/** Files one speech carries from afar. */
export const FILES_PER_SAY_MAX = 4
/**
 * Bytes of one chunk, either way. Its base64url (218 456 characters) and the JSON around it fit an answer's READ_BODY_MAX
 * (224 KiB) and one record of the relay (MAX_RECORD_CONTENT), so a chunk is always one frame.
 */
export const FILE_CHUNK_BYTES = 160 * 1024
/** Characters of one chunk's base64url, unpadded. */
export const FILE_CHUNK_B64_MAX = Math.ceil((FILE_CHUNK_BYTES * 4) / 3)
/**
 * Bytes of files one device moves in a minute, both ways together (each chunk request counts as a whole chunk, whatever
 * it carries). 32 MiB: four files of the ceiling in a little over a minute; a device that goes over is refused `slow-down`
 * like any other rate, and the PWA paces itself by the same number so it never is.
 */
export const FILE_BYTES_PER_DEVICE_PER_MIN = 32 * 1024 * 1024
/** Chunk requests a minute that the rate above allows: the chunk ops are counted here, not against the device's requests. */
export const FILE_CHUNKS_PER_DEVICE_PER_MIN = Math.floor(FILE_BYTES_PER_DEVICE_PER_MIN / FILE_CHUNK_BYTES)
/** An upload no chunk reached for this long is abandoned: its leftovers are deleted. */
export const UPLOAD_IDLE_MS = 10 * 60_000
/** The longest name a file gets in the channel's folder (the app's FILE_NAME_MAX, extensions/channels/attachments.ts). */
export const UPLOAD_NAME_MAX = 120

/** The types a device may draw: their signature is checked on the bytes, at the portal and again on the screen. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export type ImageType = (typeof IMAGE_TYPES)[number]
/** What every other file is called on the wire (SVG and HTML included: they are never drawn, only downloaded). */
export const OTHER_TYPE = 'application/octet-stream'
export type FileType = ImageType | typeof OTHER_TYPE
/** How many first bytes the signature needs. */
export const SNIFF_BYTES = 12

const starts = (b: Uint8Array, sig: readonly number[], at = 0): boolean => b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x)

/** The type of a file by its first bytes: one of the four images, or `application/octet-stream`. The name is never read. */
export function sniffType(head: Uint8Array): FileType {
  if (starts(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (starts(head, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (starts(head, [0x47, 0x49, 0x46, 0x38]) && (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61) return 'image/gif'
  if (starts(head, [0x52, 0x49, 0x46, 0x46]) && starts(head, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp'
  return OTHER_TYPE
}

export const isImageType = (t: unknown): t is ImageType => typeof t === 'string' && (IMAGE_TYPES as readonly string[]).includes(t)

// ---- the name an upload gets (the app's rules, extensions/channels/attachments.ts safeFileName, plus the hostile text)

const lastSegment = (name: string): string => { const p = name.split(/[\\/]/); return p[p.length - 1] ?? '' }
const extOf = (name: string): string => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i) : '' }

/** The app's INERT_SUFFIX and SHELL_TYPES (extensions/channels/attachments.ts): a test keeps both in step. */
export const UPLOAD_INERT_SUFFIX = '.download'
export const UPLOAD_SHELL_TYPES: ReadonlySet<string> = new Set([
  '.url', '.lnk', '.scf', '.library-ms', '.searchconnector-ms', '.search-ms', '.settingcontent-ms', '.appref-ms', '.website',
  '.theme', '.themepack', '.deskthemepack', '.hta', '.cpl', '.msc', '.pif', '.application', '.xbap', '.jnlp',
])
const SHELL_NAMES: ReadonlySet<string> = new Set(['desktop.ini', 'autorun.inf'])
const isReserved = (name: string): boolean =>
  /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i.test((name.split('.')[0] ?? '').replace(/ +$/, ''))
const isShellResolved = (name: string): boolean => { const n = name.toLowerCase(); return UPLOAD_SHELL_TYPES.has(extOf(n)) || SHELL_NAMES.has(n) }

/**
 * A name safe on every disk, as the app makes it (safeFileName): the last segment only, no control, bidi or zero-width
 * character (sanitizeDeclaredName), no character Windows refuses, no reserved device name by Windows' own rule (`con .txt`,
 * `COM¹`, `CONIN$`), no trailing dot or space, a type the Windows shell acts on by itself made inert (`a.url.download`),
 * bounded with its extension kept. Never empty (`arquivo`).
 */
export function uploadName(name: string): string {
  let n = sanitizeDeclaredName(lastSegment(sanitizeDeclaredName(name)))
  // eslint-disable-next-line no-control-regex
  n = n.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim().replace(/[. ]+$/, '')
  if (n === '' || /^\.+$/.test(n)) n = 'arquivo'
  if (isReserved(n)) n = `_${n}`
  let ext = extOf(n)
  if (n.length > UPLOAD_NAME_MAX) {
    const keep = ext.length < 20 ? ext : ''
    n = n.slice(0, UPLOAD_NAME_MAX - keep.length).replace(/[. ]+$/, '') + keep
    ext = extOf(n)
  }
  if (isShellResolved(n)) {
    if (n.length + UPLOAD_INERT_SUFFIX.length > UPLOAD_NAME_MAX) n = n.slice(0, UPLOAD_NAME_MAX - UPLOAD_INERT_SUFFIX.length - ext.length).replace(/[. ]+$/, '') + ext
    n += UPLOAD_INERT_SUFFIX
  }
  return n
}

/** A secret's name (the app's isSecretName): such a file never goes into a channel, from afar either. */
export function isSecretName(name: string): boolean {
  const n = lastSegment(name).trim().toLowerCase()
  return n === '.env' || n.startsWith('.env.') || n.endsWith('.keys') || n.endsWith('.pem') || n.endsWith('.key') || n.endsWith('.pfx')
    || n.startsWith('id_rsa') || n.startsWith('credentials')
}

// ---- the strict bodies

export type FileRefusal = 'bad-request' | 'too-large'

/** `channels.file {channel, seq, file, offset}`: one chunk of the `file`-th file of the line `seq`, from `offset`. */
export interface FileReadArgs { channel: string; seq: number; file: number; offset: number }
/**
 * `channels.upload {channel, act, file, name, size, offset, data}`: the chunk at `offset` of the `file`-th file of the
 * speech `act` in `channel`. `name` is the safe name already (uploadName); `secret` says it is a secret's name.
 */
export interface UploadArgs { channel: string; act: string; file: number; name: string; secret: boolean; size: number; offset: number; data: Bytes }
/** `channels.upload-cancel {act, file?}`: one file of the speech, or all of them. */
export interface CancelArgs { act: string; file?: number }

/**
 * A channel's id as the store makes them (`c_…`, `desk_…`): it begins with a word character, so it is never `.` nor `..`
 * (the portal joins it to the channels' folder: a dots-only id would name the folder above).
 */
const CHANNEL_RE = /^\w[\w.:-]{0,63}$/
const ACT_RE = /^[0-9a-f]{32}$/
const B64URL_RE = /^[A-Za-z0-9_-]*$/
/** The longest name a device may declare before it is made safe (a path pasted whole is still a name of one segment here). */
const DECLARED_NAME_MAX = 512

const int = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max

export function fileReadArgs(b: Record<string, unknown>): FileReadArgs | FileRefusal {
  const { channel, seq, file, offset } = b
  if (typeof channel !== 'string' || !CHANNEL_RE.test(channel)) return 'bad-request'
  if (!int(seq, 1, Number.MAX_SAFE_INTEGER) || !int(file, 0, 63)) return 'bad-request'
  const at = offset ?? 0
  if (!int(at, 0, FILE_MAX_BYTES) || at % FILE_CHUNK_BYTES !== 0) return 'bad-request'
  return { channel, seq, file, offset: at }
}

export function uploadArgs(b: Record<string, unknown>): UploadArgs | FileRefusal {
  const { channel, act, file, name, size, offset, data } = b
  if (typeof channel !== 'string' || !CHANNEL_RE.test(channel)) return 'bad-request'
  if (typeof act !== 'string' || !ACT_RE.test(act)) return 'bad-request'
  if (!int(file, 0, FILES_PER_SAY_MAX - 1)) return 'bad-request'
  if (typeof name !== 'string' || name === '' || name.length > DECLARED_NAME_MAX) return 'bad-request'
  if (!int(size, 1, Number.MAX_SAFE_INTEGER)) return 'bad-request'
  if (size > FILE_MAX_BYTES) return 'too-large'
  if (!int(offset, 0, size - 1) || offset % FILE_CHUNK_BYTES !== 0) return 'bad-request'
  if (typeof data !== 'string' || data.length > FILE_CHUNK_B64_MAX || !B64URL_RE.test(data)) return 'bad-request'
  let bytes: Bytes
  try { bytes = fromB64url(data) } catch { return 'bad-request' }
  // Every chunk but the last is whole: the offsets of a file are fixed, so a repeat lands on the same bytes.
  const want = Math.min(FILE_CHUNK_BYTES, size - offset)
  if (bytes.length !== want) return 'bad-request'
  const safe = uploadName(name)
  return { channel, act, file, name: safe, secret: isSecretName(safe) || isSecretName(sanitizeDeclaredName(name)), size, offset, data: bytes }
}

export function cancelArgs(b: Record<string, unknown>): CancelArgs | FileRefusal {
  const { act, file } = b
  if (typeof act !== 'string' || !ACT_RE.test(act)) return 'bad-request'
  if (file !== undefined && !int(file, 0, FILES_PER_SAY_MAX - 1)) return 'bad-request'
  return { act, ...(file !== undefined ? { file } : {}) }
}

/** The `files` of a speech: the distinct indexes of the files uploaded under its actId, 1 to FILES_PER_SAY_MAX, in order. */
export function sayFiles(v: unknown): number[] | 'bad-request' {
  if (!Array.isArray(v) || v.length === 0 || v.length > FILES_PER_SAY_MAX) return 'bad-request'
  if (!v.every((x) => int(x, 0, FILES_PER_SAY_MAX - 1))) return 'bad-request'
  const set = [...new Set(v as number[])]
  return set.length === v.length ? set : 'bad-request'
}

/** The number of chunks of a file of `size` bytes. */
export const chunksOf = (size: number): number => Math.ceil(size / FILE_CHUNK_BYTES)
