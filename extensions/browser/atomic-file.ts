// A file written in one move, for the files the vendored server reads while the tether writes them (endpoint.json,
// debug.json): a reader never sees half a file. Electron-free, so the unit tests import it.
import { randomBytes } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'

/** `text` to `file` through a randomly named temp file and a rename, tried again a few times (EPERM/EBUSY on Windows). */
export async function writeAtomicRetry(file: string, text: string, tries = 5): Promise<void> {
  for (let i = 1; ; i++) {
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await writeFile(tmp, text)
      await rename(tmp, file)
      return
    } catch (e) {
      await rm(tmp, { force: true })
      const code = (e as NodeJS.ErrnoException).code
      if (i >= tries || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e
      await new Promise(r => setTimeout(r, 50 * i))
    }
  }
}
