// The image viewer's disk read (extensions/note/main.ts `readImage`): the bytes of one image file, asynchronously (libuv's
// thread pool, so the main process never blocks on a big picture). The caller has checked the extension.
import { readFile, stat } from 'node:fs/promises'
import type { ImageRead } from '../shared/api.ts'

/** Above this a picture is not read into the app (the page would hold the bytes and a decoded copy). */
export const MAX_IMAGE_BYTES = 100 * 1024 * 1024

export async function readImage(path: string): Promise<ImageRead> {
  try {
    const st = await stat(path)
    if (!st.isFile()) return { ok: false, missing: false, message: 'O caminho não é um arquivo.' }
    if (st.size > MAX_IMAGE_BYTES) return { ok: false, missing: false, message: `Imagem grande demais para o visualizador (${Math.round(st.size / 1024 / 1024)} MB).` }
    const bytes = await readFile(path)
    return { ok: true, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), size: bytes.byteLength }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    return { ok: false, missing: e.code === 'ENOENT', message: e.message }
  }
}
