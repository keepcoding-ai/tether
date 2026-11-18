// Synchronous read of a slot's pending notices, for tests and diagnostics (never the daemon's loop).
import { readFileSync } from 'node:fs'
import { slotNoticesPath } from '../core/paths.ts'
import { parseNotices, type Notice } from './notices.ts'

/** The notices still waiting for the slot's agent (the hook is the consumer). */
export function pendingNotices(home: string, slotId: string): Notice[] {
  let text: string
  try { text = readFileSync(slotNoticesPath(home, slotId), 'utf8') } catch { return [] }
  return parseNotices(text)
}
