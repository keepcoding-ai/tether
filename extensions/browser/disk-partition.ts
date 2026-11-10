// E15, design §12b rule 18: the persistent partition on disk, before Electron opens it. Free of Electron (unit-tested).
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { partitionStep } from './tab-rules.ts'

/** The tabs' persistent partition (session.ts re-exports it). */
export const PERSIST_PARTITION = 'persist:tether-browser'

/** The persistent partition's folder under Electron's userData (Electron keeps `persist:<name>` in Partitions/<name>). */
export const persistPartitionDir = (userData: string): string => join(userData, 'Partitions', PERSIST_PARTITION.slice('persist:'.length))
/** Left by the first start with the fuse on: from then on the partition only ever held encrypted cookies. */
export const fusedMarkerOf = (home: string): string => join(home, 'browser', 'partition-fuse.json')

/**
 * E15, rule 18: before the partition is opened, a persistent partition found without the fused marker (written by an earlier
 * build without the fuse) is removed, and the marker is written. Fuse off: nothing on disk is touched (the partition is in
 * memory). Returns the step taken.
 */
export function prepareDiskPartition(opts: { fuseOn: boolean, home: string, userData: string, log: (msg: string) => void }): ReturnType<typeof partitionStep> {
  const dir = persistPartitionDir(opts.userData)
  const marker = fusedMarkerOf(opts.home)
  const step = partitionStep(opts.fuseOn, existsSync(dir), existsSync(marker))
  if (step === 'memory') return step
  if (step === 'wipe-then-use') {
    rmSync(dir, { recursive: true, force: true })
    opts.log('partição do navegador gravada sem o fuse de cookies apagada (primeiro início com o fuse)')
  }
  if (!existsSync(marker)) {
    try {
      mkdirSync(join(opts.home, 'browser'), { recursive: true })
      writeFileSync(marker, `${JSON.stringify({ v: 1, fuse: 'EnableCookieEncryption', at: new Date().toISOString() })}\n`)
    } catch (e) { opts.log(`não consegui gravar a marca da partição com o fuse (${(e as Error).message})`) }
  }
  return step
}
