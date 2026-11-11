// Notices: a line tetherd leaves for a panel's agent, delivered on the agent's next step and never typed into its
// terminal (a notice never wakes an idle agent). Generic: any part of tetherd may leave one. The file is
// <home>/slots/<slot>.notices.jsonl, one `{ts, text}` per line; Claude's hook (src/report/claude-hook.mjs) takes the
// whole file atomically (rename, read, delete) on PostToolUse / UserPromptSubmit and hands the lines to the agent.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { slotNoticesPath } from '../core/paths.ts'
import { flatText } from './ronda.ts'

/** Text that came from another agent (a reason, a purpose) is cut to this and quoted. */
export const QUOTED_MAX = 200

export interface Notice {
  ts: string
  text: string
}

/** Text written by someone else, as data: one line, at most QUOTED_MAX characters, between quotes. */
export function quoted(text: string | undefined): string {
  const flat = flatText(text).replaceAll('"', "'")
  return `"${flat.length > QUOTED_MAX ? flat.slice(0, QUOTED_MAX).trimEnd() + '…' : flat}"`
}

/** Appends a notice for the slot's agent: one line, cut like any text tether hands to an agent (flatText). */
export function leaveNotice(home: string, slotId: string, text: string, now = new Date()): void {
  const line: Notice = { ts: now.toISOString(), text: flatText(text) }
  const path = slotNoticesPath(home, slotId)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(line) + '\n')
}

/** The notices still waiting for the slot's agent (tests and diagnostics; the hook is the consumer). */
export function pendingNotices(home: string, slotId: string): Notice[] {
  let text: string
  try { text = readFileSync(slotNoticesPath(home, slotId), 'utf8') } catch { return [] }
  const out: Notice[] = []
  for (const l of text.split('\n')) {
    if (!l.trim()) continue
    try {
      const n = JSON.parse(l) as Notice
      if (typeof n?.text === 'string') out.push(n)
    } catch { /* a torn line */ }
  }
  return out
}
