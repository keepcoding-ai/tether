// The command palette's rules, pure (app/renderer/palette.ts puts them on screen): what the text in the box
// means, and how the commands are ordered and filtered for it.
//
// One box, two modes, as in VS Code: text starting with `>` is a command search; anything else is quick open
// (files in the focused pane's folder), which arrives in a later delivery. Ctrl+Shift+P opens the box with `>`
// already typed; Ctrl+P opens it empty. Deleting the `>` turns one into the other.
import type { Command } from './commands.ts'
import { clipRanges, wordFilter, type Range } from './word-filter.ts'

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
  /** "recent": in the history (shown first, last run on top); "other": the rest, alphabetical by title. */
  section: 'recent' | 'other'
  /** Highlighted ranges in the title and in the group (the match may have come through "group: title"). */
  title: Range[]
  group: Range[]
}

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base' })

/**
 * The commands for a query, in the order of VS Code's palette: the history first (most recently run on top,
 * no frequency counting), then the other commands by title. A query only filters; it never reorders. A command
 * matches by its title or by "group: title" (the way VS Code matches "Category: Label").
 */
export function rankCommands(commands: readonly Command[], query: string, recents: readonly string[]): RankedCommand[] {
  const rank = new Map(recents.map((id, i) => [id, i]))
  const q = query.trim()
  const recent: RankedCommand[] = []
  const other: RankedCommand[] = []
  for (const command of commands) {
    let title: Range[] = [], group: Range[] = []
    if (q !== '') {
      const direct = wordFilter(q, command.title)
      if (direct) title = direct
      else {
        if (!command.group) continue
        const whole = `${command.group}: ${command.title}`
        const via = wordFilter(q, whole)
        if (!via) continue
        group = clipRanges(via, 0, command.group.length)
        title = clipRanges(via, command.group.length + 2, whole.length)
      }
    }
    const isRecent = rank.has(command.id)
    ;(isRecent ? recent : other).push({ command, section: isRecent ? 'recent' : 'other', title, group })
  }
  recent.sort((a, b) => rank.get(a.command.id)! - rank.get(b.command.id)!)
  other.sort((a, b) => collator.compare(a.command.title, b.command.title))
  return [...recent, ...other]
}
