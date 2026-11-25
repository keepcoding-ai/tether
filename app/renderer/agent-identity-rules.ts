// How an agent is told apart wherever the app lists it: [engine icon] [emblem OR letter] name, in the order of its tab.
// The engine is the kind of the CLI (Claude, Soul, Codex, the terminal for a shell); the emblem is the one the person put
// on the tab ("Emblema…"); the letter is the square with the agent's initial and its own hue, standing in the emblem's
// place when the agent wears none. Pure (no DOM): agent-identity.ts draws it, and lists that only need the facts read it.
import { agentHue } from '../shared/agent-color.ts'
import { engineOf } from './agent-ui.ts'
import type { PaneEmblem } from './ext-api.ts'

/** What a list knows about the agent it draws. `seed` is the slot id (the hue's source); `emblem` is `panes.personEmblem`. */
export interface IdentityInput {
  kind: string
  name: string
  seed: string
  emblem?: PaneEmblem | undefined
}

export type IdentityMark =
  | { type: 'emblem'; emblem: PaneEmblem }
  | { type: 'letter'; letter: string; hue: number }

export interface Identity {
  kind: string
  engine: { icon: string; label: string }
  mark: IdentityMark
  name: string
}

/** The initial of a name: its first character (a whole code point), upper-cased; "?" for an empty name. */
export function letterOf(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?'
}

/** The agent's identity as a list draws it: its engine and, in the emblem's place, the emblem or the letter. */
export function identityOf(input: IdentityInput): Identity {
  const mark: IdentityMark = input.emblem
    ? { type: 'emblem', emblem: input.emblem }
    : { type: 'letter', letter: letterOf(input.name), hue: agentHue(input.seed) }
  return { kind: input.kind, engine: engineOf(input.kind), mark, name: input.name }
}

/** The pair read aloud: engine, emblem when there is one, then the name ("Claude, emblema Revisor: conferente"). */
export function identityLabel(id: Identity): string {
  const emblem = id.mark.type === 'emblem' ? `, emblema ${id.mark.emblem.name}` : ''
  return `${id.engine.label}${emblem}: ${id.name}`
}
