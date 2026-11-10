// Options an extension adds to the profile editor (a checkbox per option, for the profiles of AI agents), stored in the
// profile as `extensions.<extensionId>.<key>` (src/core/profile.ts). The editor shows only the options of extensions that
// are on; the values of the others stay in the profile untouched when it is saved.
import type { IDisposable } from '../shared/vscode-lifecycle.ts'
import { toDisposable } from '../shared/vscode-lifecycle.ts'

export interface ProfileOption {
  /** The key inside the extension's object in the profile. */
  key: string
  /** The checkbox's text. */
  label: string
  /** A sentence under it. */
  hint?: string
}

export interface RegisteredProfileOption extends ProfileOption {
  extensionId: string
}

const options: RegisteredProfileOption[] = []

export function registerProfileOption(extensionId: string, option: ProfileOption): IDisposable {
  if (options.some(o => o.extensionId === extensionId && o.key === option.key)) throw new Error(`a opção de perfil ${extensionId}.${option.key} já existe`)
  const entry = { ...option, extensionId }
  options.push(entry)
  return toDisposable(() => { const i = options.indexOf(entry); if (i >= 0) options.splice(i, 1) })
}

export function profileOptions(): readonly RegisteredProfileOption[] {
  return options
}
