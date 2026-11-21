// `agents type`: the conductor's `type` verb (the terminal's), through the registry (conducted.ts).
import { runConducted } from './conducted.ts'
import { GUIA_PROP, type VerbDef } from './common.ts'

export const typeVerb: VerbDef = {
  name: 'type',
  description: 'Type text into one of your terminal panes exactly as a person would, with no Enter (use `keys` for Enter). It refuses with `with-user` when the person is typing there.',
  help: 'Digita o texto na guia, sem Enter.',
  input: { type: 'object', properties: { guia: GUIA_PROP, text: { type: 'string' } }, required: ['guia', 'text'] },
  positional: ['guia', 'text'],
  run: (deps, caller, args) => runConducted(deps, caller, 'type', args),
}
