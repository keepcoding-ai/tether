// The command palette's rules, pure (app/renderer/palette.ts puts them on screen): what the text in the box
// means, and how the commands are ranked for it.
//
// One box, two modes, as in VS Code: text starting with `>` is a command search; anything else is quick open
// (files in the focused pane's folder), which arrives in a later delivery. Ctrl+Shift+P opens the box with `>`
// already typed; Ctrl+P opens it empty. Deleting the `>` turns one into the other.
import type { Command } from './commands.ts'
import { fuzzyMatch, type FuzzyMatch } from './fuzzy.ts'

export type PaletteMode = 'commands' | 'quick-open'

export const COMMAND_PREFIX = '>'

/** What the user wrote means: the mode and the query without the prefix (trimmed at the start). */
export function parsePaletteInput(text: string): { mode: PaletteMode; query: string } {
  if (text.startsWith(COMMAND_PREFIX)) return { mode: 'commands', query: text.slice(COMMAND_PREFIX.length).trimStart() }
  return { mode: 'quick-open', query: text }
}

/** The text the box opens with for a mode. */
export function initialInput(mode: PaletteMode): string {
  return mode === 'commands' ? COMMAND_PREFIX : ''
}

export interface RankedCommand {
  command: Command
  match: FuzzyMatch
  /** Among the recently used (shown with the "recente" tag when the query is empty). */
  recent: boolean
}

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base' })

/**
 * The commands for a query, best first. Empty query: the recently used ones first (most recent first), then the
 * others by title (as VS Code lists them: a scannable catalogue). With a query: by score, a recent one wins a tie,
 * then by title.
 */
export function rankCommands(commands: readonly Command[], query: string, recents: readonly string[]): RankedCommand[] {
  const rank = new Map(recents.map((id, i) => [id, i]))
  const out: RankedCommand[] = []
  for (const command of commands) {
    const match = fuzzyMatch(query, command.title)
    if (match) out.push({ command, match, recent: rank.has(command.id) })
  }
  const recency = (r: RankedCommand): number => rank.get(r.command.id) ?? Number.POSITIVE_INFINITY
  out.sort((a, b) => (b.match.score - a.match.score) || (recency(a) - recency(b)) || collator.compare(a.command.title, b.command.title))
  return out
}
