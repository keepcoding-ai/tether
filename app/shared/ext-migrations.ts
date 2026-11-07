// One-time moves of a value from where the core kept it into an extension (F9 §4.6), in the spirit of VS Code's
// ConfigurationMigrationRegistry (src/vs/workbench/common/configuration.ts @7faf984: a migration names the old key and
// writes the new one, and the old key goes). Each manifest declares its own (`contributes.migrations`); main applies
// them at startup, before the extensions activate, to every extension in the index, enabled or not, so a value is
// never lost while an extension is off. A value already at the destination wins; the old key is removed either way.
// A destination may also be a full key outside the extension's own settings (`{ key }`): the general switch of one of its
// features (`agents.features.<id>`, a boolean), where only a boolean moves (anything else read as the default before).
// Pure: the settings.json object in, the new object out.
import type { ExtensionManifest } from '../../extensions/types.ts'
import { normalizeSetting, readExtensionsSettings, withSetting, writeExtensionsSettings } from './vscode-configuration-registry.ts'

type Json = Record<string, unknown>

/** The key of settings.json that holds the extensions' remembered state (TetherMain.state). */
export const EXTENSION_STATE_KEY = 'extensionState'

const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

function getPath(file: Json, path: string): unknown {
  let cur: unknown = file
  for (const part of path.split('.')) { if (!isObject(cur)) return undefined; cur = cur[part] }
  return cur
}

/** `file` with `value` at the dotted `path` (missing or non-object steps become objects). */
function withPath(file: Json, path: string, value: unknown): Json {
  const [head, ...rest] = path.split('.')
  if (!head) return file
  if (rest.length === 0) return { ...file, [head]: value }
  const child = isObject(file[head]) ? file[head] as Json : {}
  return { ...file, [head]: withPath(child, rest.join('.'), value) }
}

/** `file` without `path`; a parent object left empty goes too. */
function withoutPath(file: Json, path: string): Json {
  const [head, ...rest] = path.split('.')
  if (!head || !(head in file)) return file
  const { [head]: child, ...others } = file
  if (rest.length === 0) return others
  if (!isObject(child)) return file
  const next = withoutPath(child, rest.join('.'))
  return Object.keys(next).length ? { ...others, [head]: next } : others
}

/** One extension's remembered state in the settings file. */
export function stateOf(file: Json, id: string): Json {
  const all = file[EXTENSION_STATE_KEY]
  const own = isObject(all) ? all[id] : undefined
  return isObject(own) ? own : {}
}

/** The settings file with `<id>.<key>` of the state set (undefined removes it). */
export function withState(file: Json, id: string, key: string, value: unknown): Json {
  const all = isObject(file[EXTENSION_STATE_KEY]) ? file[EXTENSION_STATE_KEY] as Json : {}
  const own = { ...stateOf(file, id) }
  if (value === undefined) delete own[key]
  else own[key] = value
  return { ...file, [EXTENSION_STATE_KEY]: { ...all, [id]: own } }
}

/** Applies every manifest's migrations to the settings file; `moved` names what moved ("ui.wordWrap → note.wordWrap"). */
export function applyMigrations(file: Json, manifests: readonly ExtensionManifest[]): { file: Json; moved: string[] } {
  let out = file
  const moved: string[] = []
  for (const m of manifests) {
    for (const mig of m.contributes?.migrations ?? []) {
      const old = getPath(out, mig.from)
      if (old === undefined) continue
      if ('setting' in mig.to) {
        const schema = m.contributes?.settings?.[mig.to.setting]
        const ext = readExtensionsSettings(out.extensions)
        if (schema && ext.values[m.id]?.[mig.to.setting] === undefined) {
          out = { ...out, extensions: writeExtensionsSettings(withSetting(ext, m.id, mig.to.setting, normalizeSetting(schema, old))) }
        }
        moved.push(`${mig.from} → extensions.${m.id}.${mig.to.setting}`)
      } else if ('key' in mig.to) {
        if (typeof old === 'boolean' && getPath(out, mig.to.key) === undefined) out = withPath(out, mig.to.key, old)
        moved.push(`${mig.from} → ${mig.to.key}`)
      } else {
        if (stateOf(out, m.id)[mig.to.state] === undefined) out = withState(out, m.id, mig.to.state, old)
        moved.push(`${mig.from} → ${EXTENSION_STATE_KEY}.${m.id}.${mig.to.state}`)
      }
      out = withoutPath(out, mig.from)
    }
  }
  return { file: out, moved }
}
