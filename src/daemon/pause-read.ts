// Synchronous read of <home>/pause.json for the CLI and tests (processes that are not the daemon's loop). The daemon reads the
// file through its executor and parses it with parsePauseFile.
import { readFileSync } from 'node:fs'
import { pausePath } from '../core/paths.ts'
import { parsePauseFile, type PauseBatch } from './pause.ts'

/** Reads <home>/pause.json; undefined when missing, unreadable or not a batch. */
export function readPauseFile(home: string): PauseBatch | undefined {
  try { return parsePauseFile(readFileSync(pausePath(home), 'utf8')) } catch { return undefined }
}
