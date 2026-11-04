// What the chooser offers besides the launch profiles, as pure data shared by the "Novo painel…" dialog and the
// chooser inside an empty pane (app/renderer/empty-panel.ts): an empty pane (decide later) and the two ways a
// note is born. Each is a radio in the same grouped list as the profiles (app/renderer/profiles.ts renders them
// as leading groups); its value carries a prefix no profile id has, so one `choiceOf` reads the whole list.
import type { Profile } from '../../src/daemon/protocol.ts'
/** A Phosphor icon name of icons.ts (IconName). Not imported: icons.ts pulls the SVG assets, and this module stays pure for the unit tests. */
type IconName = string

export const CHOICE_PREFIX = 'kind:'

export type ChoiceKind = 'empty' | 'note-new' | 'note-open'

export interface ChoiceItem {
  /** The radio value (`kind:<kind>`). */
  value: string
  kind: ChoiceKind
  name: string
  /** The small muted line under the name (what the profiles show their args in). */
  hint: string
  icon: IconName
}

export interface ChoiceGroup {
  label: string
  icon: IconName
  items: ChoiceItem[]
}

export const EMPTY_CHOICE: ChoiceItem = { value: `${CHOICE_PREFIX}empty`, kind: 'empty', name: 'Vazio — escolher depois', hint: 'só o espaço, na posição escolhida; o que abre nele se decide lá dentro', icon: 'plus' }
export const NOTE_NEW_CHOICE: ChoiceItem = { value: `${CHOICE_PREFIX}note-new`, kind: 'note-new', name: 'Nova nota', hint: 'arquivo .md novo em <pasta>/.tether/notes', icon: 'note-pencil' }
export const NOTE_OPEN_CHOICE: ChoiceItem = { value: `${CHOICE_PREFIX}note-open`, kind: 'note-open', name: 'Abrir nota…', hint: 'um arquivo existente, pelo seletor de arquivos', icon: 'folder-open' }

const EMPTY_GROUP: ChoiceGroup = { label: 'Vazio', icon: 'plus', items: [EMPTY_CHOICE] }
const NOTE_GROUP: ChoiceGroup = { label: 'Nota', icon: 'note-pencil', items: [NOTE_NEW_CHOICE, NOTE_OPEN_CHOICE] }

/** The groups before the profiles: the dialog offers the empty pane too; inside an empty pane only the notes make sense. */
export function leadingChoices(where: 'dialog' | 'empty'): ChoiceGroup[] {
  return where === 'dialog' ? [EMPTY_GROUP, NOTE_GROUP] : [NOTE_GROUP]
}

/** What the person picked in the chooser. */
export type Choice =
  | { kind: 'profile'; profile: Profile }
  | { kind: ChoiceKind }

/** The choice a radio value names, or undefined for nothing / an unknown profile. */
export function choiceOf(value: string | undefined, profiles: readonly Profile[]): Choice | undefined {
  if (!value) return undefined
  if (value.startsWith(CHOICE_PREFIX)) {
    const kind = value.slice(CHOICE_PREFIX.length)
    return kind === 'empty' || kind === 'note-new' || kind === 'note-open' ? { kind } : undefined
  }
  const profile = profiles.find(p => p.id === value)
  return profile ? { kind: 'profile', profile } : undefined
}

/** Whether a choice needs the folder field filled: a process needs a cwd; a note and an empty pane fall back to the person's folder. */
export function choiceNeedsFolder(choice: Choice): boolean {
  return choice.kind === 'profile'
}
