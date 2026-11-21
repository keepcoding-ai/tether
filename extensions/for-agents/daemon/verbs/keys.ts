// `agents keys`: the conductor's `keys` verb (the terminal's), through the registry (conducted.ts).
import { runConducted } from './conducted.ts'
import { GUIA_PROP, type VerbDef } from './common.ts'

export const keysVerb: VerbDef = {
  name: 'keys',
  description: 'Press named keys in one of your terminal panes, in order: enter, esc, tab, shift+tab, backspace, up, down, left, right, ctrl+c, ctrl+d, ctrl+u, ctrl+e, paste-start, paste-end. An unknown key makes the call send none.',
  help: 'Tecla as teclas nomeadas, em ordem.',
  input: { type: 'object', properties: { guia: GUIA_PROP, keys: { type: 'array', items: { type: 'string' } } }, required: ['guia', 'keys'] },
  positional: ['guia', 'keys'],
  run: (deps, caller, args) => runConducted(deps, caller, 'keys', args),
}
