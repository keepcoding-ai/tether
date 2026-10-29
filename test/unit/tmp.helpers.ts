// Temp folders for the unit tests, removed when the file's tests are done: `const tmp = tempDirs('tether-x-')`,
// `tmp.make()` per folder, `after(() => tmp.cleanup())` once. Removal retries: Windows keeps handles open briefly.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface TempDirs {
  make(): string
  cleanup(): Promise<void>
  readonly made: readonly string[]
}

export function tempDirs(prefix: string): TempDirs {
  const made: string[] = []
  return {
    made,
    make() {
      const dir = mkdtempSync(join(tmpdir(), prefix))
      made.push(dir)
      return dir
    },
    async cleanup() {
      for (const dir of made.splice(0)) {
        for (let i = 0; i < 5; i++) {
          try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) }
        }
      }
    },
  }
}
