// The layout file (<TETHER_HOME>/layout.json) is the person's arrangement of panels and the one file the app
// cannot rebuild. Every save keeps the previous content in layout.json.bak (an atomic rename), the new
// content lands by temp + rename, and a missing, empty or corrupt layout.json falls back to the backup.
// All disk work goes through the executor (the main loop never waits for it); saves of one file run one at a time, in order.
import { dirname } from 'node:path'
import type { Executor } from '../../src/exec/executor.ts'

export function layoutBackupPath(path: string): string {
  return `${path}.bak`
}

/** The parsed file, or null when it is missing, empty or not JSON. */
async function readLayout(ex: Executor, path: string): Promise<unknown | null> {
  try {
    const text = await ex.run('readText', [path])
    if (text.trim() === '') return null
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

export async function loadLayoutFile(ex: Executor, path: string): Promise<unknown | null> {
  return (await readLayout(ex, path)) ?? (await readLayout(ex, layoutBackupPath(path)))
}

const chains = new Map<string, Promise<void>>()

/** Resolves when this save (and every earlier one of the same file) is done. A failed save rejects its own caller only. */
export function saveLayoutFile(ex: Executor, path: string, layout: unknown): Promise<void> {
  const text = JSON.stringify(layout, null, 2)
  const run = async (): Promise<void> => {
    await ex.run('mkdirp', [dirname(path)])
    // Only a readable previous layout is worth keeping: a corrupt file must not replace a good backup.
    if ((await readLayout(ex, path)) !== null) await ex.run('rename', [path, layoutBackupPath(path)])
    await ex.run('writeTextAtomic', [path, text])
  }
  const prev = chains.get(path) ?? Promise.resolve()
  const mine = prev.then(run)
  const tail = mine.catch(() => {})
  chains.set(path, tail)
  void tail.then(() => { if (chains.get(path) === tail) chains.delete(path) })
  return mine
}
