// canonicalDir for the CLI, Electron main and the executor's operations: the same as paths.ts, with the realpath done
// synchronously. tetherd's coordinator awaits the async one.
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { upperDrive } from './paths.ts'

export function canonicalDir(path: string): string {
  let dir = resolve(path)
  try { dir = realpathSync.native(dir) } catch { /* missing or unreadable: keep what was given */ }
  return upperDrive(dir)
}
