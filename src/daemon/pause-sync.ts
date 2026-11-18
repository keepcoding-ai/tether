// pause.json written synchronously: for the tests and tools that build a batch on disk. tetherd writes it through its slot store.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pausePath } from '../core/paths.ts'
import type { PauseBatch } from './pause.ts'

/** Atomic: temp + rename. */
export function writePauseFile(home: string, batch: PauseBatch): void {
  const path = pausePath(home)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(batch, null, 2) + '\n')
  renameSync(tmp, path)
}
