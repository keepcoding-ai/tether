// The command registry: every action of the app is a command with a stable id (`pane.new`, `desk.next`,
// `theme.dark`), a title the user reads, an optional chord and an optional availability rule (`when`). The
// palette (Ctrl+Shift+P), the ≡ menu and the keyboard dispatch all read from here: one action, one place.
//
// Chords stay in app/renderer/shortcuts.ts (the key table, keyed by command id; the user's keybindings.json lays
// over it): the hint shown next to a command is the first key bound to its id on the platform. The registry is dynamic on
// purpose: a focused editor (the note tab) registers its own commands and removes them on blur with the
// function `register` returns; the CLI will be able to `tether run <id>` through `run`.
import { chordLabel, shortcutHint, type Chord } from './shortcuts.ts'
import type { CommandContribution } from '../../extensions/types.ts'
import { deserialize, evaluate, type ContextValue } from '../shared/vscode-contextkey.ts'

/** A Phosphor icon name of icons.ts (IconName). Not imported: icons.ts pulls the SVG assets, and this module stays pure for the unit tests. */
export type CommandIcon = string

/** What `when` rules read: a snapshot of the state the commands depend on, built by the app on demand. */
export interface CommandContext {
  /** The current desk has an active pane (the one toolbar and ≡ actions act on). */
  pane: boolean
  /** The active pane's type id (app/renderer/pane-registry.ts): 'terminal', 'note', 'md-preview'… */
  paneType?: string
  /** Context keys the active pane's type sets ('markdown.note', 'markdown.preview', 'keybindings.screen'). `keybindings` below is derived from them. */
  flags?: ReadonlySet<string>
  /** How many desks exist. */
  desks: number
  drawerOpen: boolean
  /** What owns the keyboard right now. */
  focus: 'terminal' | 'editor' | 'none'
  /** The active pane is the "Atalhos de teclado" screen (its own keys: record, delete). */
  keybindings?: boolean
  /** How many pads the side bars have (F10). */
  pads?: number
  /** The current pad: the open one most recently opened or focused. */
  pad?: string
  /** The current pad lives away from its default side. */
  padMoved?: boolean
}

export interface Command {
  /** Stable, dotted, lowercase: `area.action[.detail]`. Never shown; the palette, the menu and the CLI use it. */
  id: string
  /** What the user reads (Portuguese). */
  title: string
  /** The group shown after the title in the palette ("Painel", "Mesa"…). */
  group?: string
  icon?: CommandIcon
  /** A chord to show when the key is handled elsewhere (a native menu accelerator): display only, never dispatched here. */
  displayChord?: Chord
  /** Availability; absent = always. An unavailable command is hidden from the palette, greyed in the menu, and ignored by its chord. */
  when?: (ctx: CommandContext) => boolean
  /** A held key repeats the keydown: toggles opt out (one press, one toggle). */
  ignoreRepeat?: boolean
  /** The chord is a key another surface uses too (Ctrl+Shift+V pastes): while the command is unavailable the key is left alone, not swallowed. */
  keepKeyWhenUnavailable?: boolean
  /** Destructive: painted in the error colour, like the ≡ menu's "Sair e encerrar tudo…". */
  danger?: boolean
  /** `source`: where the run came from (a chord, the palette, the menu, the CLI); most commands ignore it. */
  run(source: RunSource): void | Promise<void>
}

/** Where the palette's "recently used" list is kept between sessions. */
export interface RecentStore { load(): string[]; save(ids: string[]): void }

export type RunSource = 'palette' | 'key' | 'menu' | 'cli' | 'test'

/** A command an extension declares (manifest `contributes.commands`, VS Code's package.json shape) with the handler its `activate` gives. */
export function commandFromContribution(c: CommandContribution, run: (source?: RunSource) => void): Command {
  const expr = c.when ? deserialize(c.when) : undefined
  return {
    id: c.command, title: c.title, group: c.category, icon: c.icon,
    ...(c.keepKeyWhenUnavailable ? { keepKeyWhenUnavailable: true } : {}),
    ...(expr ? { when: (ctx: CommandContext) => evaluate(expr, key => contextKey(ctx, key)) } : {}),
    run: source => run(source),
  }
}

/** A context key's value in the command context: the named fields, else one of the active pane's flags. */
export function contextKey(ctx: CommandContext, key: string): ContextValue {
  switch (key) {
    case 'pane': return ctx.pane
    case 'paneType': return ctx.paneType
    case 'focus': return ctx.focus
    case 'desks': return ctx.desks
    case 'drawerOpen': return ctx.drawerOpen
    case 'pads': return ctx.pads ?? 0
    case 'pad': return ctx.pad
    case 'padMoved': return ctx.padMoved ?? false
    default: return ctx.flags?.has(key) ?? false
  }
}
export type RunOutcome = 'ran' | 'unknown' | 'unavailable'

/** How many recently used commands the palette remembers. */
export const RECENT_LIMIT = 50

const ID_SHAPE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/

/** True for a well-formed id (`pane.new`, `desk.go.3`). */
export function isCommandId(id: string): boolean {
  return ID_SHAPE.test(id)
}

/** Ids that were renamed: the old id still runs (keybindings and scripts written for it keep working). */
export const COMMAND_ALIASES: Readonly<Record<string, string>> = { 'pause.manage': 'sessions.manage' }

export class CommandRegistry {
  private readonly commands = new Map<string, Command>()
  private readonly context: () => CommandContext
  private readonly store: RecentStore | undefined
  private recent: string[]

  constructor(context: () => CommandContext, store?: RecentStore) {
    this.context = context
    this.store = store
    this.recent = (store?.load() ?? []).filter(id => typeof id === 'string').slice(0, RECENT_LIMIT)
  }

  /** Adds commands; returns the function that removes exactly these again. A duplicate id is a programming error. */
  register(...commands: Command[]): () => void {
    for (const c of commands) {
      if (!isCommandId(c.id)) throw new Error(`command id malformed: ${c.id}`)
      if (this.commands.has(c.id)) throw new Error(`command registered twice: ${c.id}`)
    }
    for (const c of commands) this.commands.set(c.id, c)
    return () => { for (const c of commands) if (this.commands.get(c.id) === c) this.commands.delete(c.id) }
  }

  get(id: string): Command | undefined {
    return this.commands.get(id) ?? this.commands.get(COMMAND_ALIASES[id] ?? '')
  }

  /** Every command, in registration order. */
  all(): Command[] {
    return [...this.commands.values()]
  }

  isAvailable(command: Command, ctx: CommandContext = this.context()): boolean {
    return command.when ? command.when(ctx) : true
  }

  /** The commands the palette offers right now. */
  available(ctx: CommandContext = this.context()): Command[] {
    return this.all().filter(c => this.isAvailable(c, ctx))
  }

  /** The key hint shown next to a command ('' when it has none on this platform). */
  hint(command: Command | string, mac?: boolean): string {
    const c = typeof command === 'string' ? this.commands.get(command) : command
    if (!c) return ''
    const h = shortcutHint(c.id, mac)
    if (h) return h
    return c.displayChord ? chordLabel(c.displayChord, mac) : ''
  }

  /** Runs a command by id. Only a run from the palette counts as "recently used" (a chord held all day would flood it). */
  async run(id: string, source: RunSource = 'test'): Promise<RunOutcome> {
    const c = this.get(id)
    if (!c) return 'unknown'
    if (!this.isAvailable(c)) return 'unavailable'
    if (source === 'palette') this.markUsed(c.id)
    await c.run(source)
    return 'ran'
  }

  /** Recently used ids, most recent first. */
  recents(): readonly string[] {
    return this.recent
  }

  markUsed(id: string): void {
    this.recent = [id, ...this.recent.filter(r => r !== id)].slice(0, RECENT_LIMIT)
    this.store?.save(this.recent)
  }
}
