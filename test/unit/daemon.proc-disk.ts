// Synchronous views of the background-process files, for tests that read the disk after a reply (the daemon itself never does).
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { procEventsPath } from '../../src/core/paths.ts'
import { parseProcEvents, type ProcEvent } from '../../src/daemon/procs.ts'

export function readProcEvents(home: string, name: string): ProcEvent[] {
  try { return parseProcEvents(readFileSync(procEventsPath(home, name), 'utf8')) } catch { return [] }
}

export function appendProcEvent(home: string, name: string, e: ProcEvent): void {
  const path = procEventsPath(home, name)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(e) + '\n')
}
