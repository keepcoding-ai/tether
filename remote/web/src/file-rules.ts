// The rules of the files of a speech on the web (RR4 step 4.3), with no DOM and no wire: the reference the screen gives a
// file of a line (never a path: `rr:<seq>:<index>`), the pace of the chunks (the portal counts every chunk of the device,
// both ways, against one budget a minute: FILE_CHUNKS_PER_DEVICE_PER_MIN), what the screen may draw (an image whose bytes
// it checked itself, src/remote/files.ts sniffType, again after the portal), and the limits of the box from afar.
import {
  FILE_CHUNK_BYTES, FILE_CHUNKS_PER_DEVICE_PER_MIN, FILE_MAX_BYTES, FILES_PER_SAY_MAX, isImageType, OTHER_TYPE, sniffType, type FileType,
} from '../../../src/remote/files.ts'

export { FILE_CHUNK_BYTES, FILE_MAX_BYTES, FILES_PER_SAY_MAX, isImageType, OTHER_TYPE, sniffType, type FileType }

/** What the screen says of a file too big to come. */
export const TOO_BIG_TEXT = 'grande demais para ver de longe'

const REF_RE = /^rr\/(\w[\w.:-]{0,63})\/(\d{1,15})\/(\d{1,2})$/

/** The reference of the `index`-th file of the line `seq` of `channel`: what the shared screen holds in place of a path. */
export const fileRef = (channel: string, seq: number, index: number): string => `rr/${channel}/${seq}/${index}`

/** The channel, the line and the index of a reference, or undefined for anything else (a name, a path, a file of the box). */
export function parseFileRef(ref: string): { channel: string; seq: number; index: number } | undefined {
  const m = REF_RE.exec(ref)
  if (!m) return undefined
  const seq = Number(m[2])
  const index = Number(m[3])
  return Number.isSafeInteger(seq) && seq >= 1 && index < 64 ? { channel: m[1]!, seq, index } : undefined
}

/** The type the screen gives a file's bytes: an image only by its own signature; anything else is to download. */
export const drawableType = (bytes: Uint8Array): FileType => sniffType(bytes.subarray(0, 12))

/**
 * The pace of the chunks: at most `perMin` in a rolling minute (a margin under the portal's ceiling, so an honest device is
 * never refused), shared by the downloads and the uploads of the page. `take` resolves when the next chunk may go.
 */
export interface ChunkPace { take(): Promise<void>; readonly used: number }

export const CHUNKS_PER_MIN = Math.max(1, FILE_CHUNKS_PER_DEVICE_PER_MIN - 8)

export function chunkPace(o: { perMin?: number; now?: () => number; wait?: (ms: number) => Promise<void> } = {}): ChunkPace {
  const perMin = o.perMin ?? CHUNKS_PER_MIN
  const now = o.now ?? Date.now
  const wait = o.wait ?? ((ms: number) => new Promise<void>(done => setTimeout(done, ms)))
  const stamps: number[] = []
  return {
    get used() { return stamps.length },
    async take() {
      for (;;) {
        const t = now()
        while (stamps.length > 0 && stamps[0]! <= t - 60_000) stamps.shift()
        if (stamps.length < perMin) { stamps.push(t); return }
        await wait(stamps[0]! + 60_000 - t)
      }
    },
  }
}

/** The page's one pace (every download and upload of this device in this page). */
export const PAGE_PACE: ChunkPace = chunkPace()

/** The limits of the box from afar (the app's chips take them: extensions/channels/attachments.ts AttachLimits). */
export const REMOTE_ATTACH_LIMITS = { files: FILES_PER_SAY_MAX, bytes: FILE_MAX_BYTES } as const
