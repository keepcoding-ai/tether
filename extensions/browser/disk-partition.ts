// E15, design §12b rule 18: the persistent partition on disk, before Electron opens it. Free of Electron (unit-tested).
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { partitionStep } from './tab-rules.ts'

/** The tabs' persistent partition (session.ts re-exports it). */
export const PERSIST_PARTITION = 'persist:tether-browser'

/** The persistent partition's folder under Electron's userData (Electron keeps `persist:<name>` in Partitions/<name>). */
export const persistPartitionDir = (userData: string): string => join(userData, 'Partitions', PERSIST_PARTITION.slice('persist:'.length))
/** Left by the first start with the fuse on: from then on the partition only ever held encrypted cookies. */
export const fusedMarkerOf = (home: string): string => join(home, 'browser', 'partition-fuse.json')

/**
 * What the persistent partition keeps between starts (review N-M2): the cookies (encrypted by the fuse) and Chromium's network
 * state, so logins survive; nothing a page stored for itself. `Network` holds `Cookies` (and HSTS, the persistent network
 * state); `Cookies` at the top is where older Chromium kept them; `Preferences` is the profile's settings.
 */
export const PARTITION_KEEP: ReadonlySet<string> = new Set(['Network', 'Cookies', 'Cookies-journal', 'Preferences'])

/**
 * The storages Electron clears while running (session.clearStorageData): everything a page keeps but the cookies. IndexedDB
 * (Gmail's and WhatsApp's messages), CacheStorage and the service workers (response bodies), localStorage (bearer tokens).
 * WebSQL is gone from this Electron (its type no longer lists it).
 */
export const PAGE_STORAGES = ['indexdb', 'cachestorage', 'serviceworkers', 'localstorage', 'shadercache', 'filesystem'] as const

/**
 * N-M2: before Electron opens the partition, removes everything in it but PARTITION_KEEP (IndexedDB, Local Storage, Session
 * Storage, Service Worker, Cache, Code Cache, GPU caches, File System, blob storage...), so no page body or page-stored token
 * written by an earlier run (one that did not quit cleanly) is left on disk. Returns the names removed.
 */
export function wipePageStorage(dir: string, log: (msg: string) => void): string[] {
  const gone: string[] = []
  for (const name of readdirSync(dir)) {
    if (PARTITION_KEEP.has(name)) continue
    try { rmSync(join(dir, name), { recursive: true, force: true }); gone.push(name) } catch (e) {
      log(`não consegui apagar ${name} da partição do navegador (${(e as NodeJS.ErrnoException).code ?? 'erro'})`)
    }
  }
  return gone
}

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
  if (step === 'use' && existsSync(dir)) wipePageStorage(dir, opts.log)
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
