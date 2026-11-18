/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Adaptation of VS Code's configuration registry: contributions declare their settings (type, default, title) once;
// the registry knows every property, its default, and normalizes a stored value against the schema.
// Origin: https://github.com/microsoft/vscode, commit 7faf984945fefaceb533ca1d851697a2e72e4e68
//   src/vs/platform/configuration/common/configurationRegistry.ts (IConfigurationNode → registerConfiguration /
//     deregisterConfigurations, getConfigurationProperties, getDefaultValue by type, the property validation)
// Adapted: a property's full key is its storage path in settings.json (VS Code's dotted key: `ui.deskLine`,
// `extensions.note.minimap`). A node has a `prefix` its properties live under: '' for the core (app/shared/core-settings.ts),
// `extensions.<id>` for an extension (the default; F9 §4.6). The schema is the types tether needs (boolean, string with an
// optional enum and its labels, number and integer with optional bounds) instead of JSON Schema, plus what the settings
// page shows (title, description, section, order); an invalid stored value reads as the default, as VS Code's
// validation falls back. Also here: the `extensions.disabled` list (F9 decision 3).
// Left out: scopes, overrides by language, policy, the change event (settings.json is the store; main broadcasts). Pure.
import { toDisposable, type IDisposable } from './vscode-lifecycle.ts'

/** What every property carries besides its type (VS Code's IConfigurationPropertySchema): the page's texts and place. */
interface SchemaCommon {
  title: string
  /** A sentence under the title on the settings page. */
  description?: string
  /** The page's group inside the node (VS Code's category); the node's title when absent. */
  section?: string
  /** Order inside the node (lower first, VS Code's `order`); unordered properties follow by key. */
  order?: number
}

export type SettingSchema =
  | ({ type: 'boolean'; default: boolean } & SchemaCommon)
  | ({
    type: 'string'; default: string; enum?: readonly string[]; enumLabels?: readonly string[]
    /** A setting that used to be a boolean: what a stored `true` / `false` reads as now (a value of `enum`). */
    fromBoolean?: { true: string; false: string }
  } & SchemaCommon)
  | ({ type: 'number' | 'integer'; default: number; min?: number; max?: number } & SchemaCommon)

export type SettingValue = boolean | string | number

/** A group of settings (VS Code's IConfigurationNode): one extension's, or the core's. */
export interface ConfigurationNode {
  id: string
  /** Where its properties live in settings.json: '' (top level) or a dotted path. Default `extensions.<id>`. */
  prefix?: string
  /** The node's name on the settings page. */
  title?: string
  /** Order among nodes (lower first, then registration order). */
  order?: number
  properties: Readonly<Record<string, SettingSchema>>
}

/** One registered property by its full key (the storage path) and the node that declared it. */
export interface ConfigurationProperty {
  key: string
  schema: SettingSchema
  node: string
}

/** The `extensions` object of settings.json: `disabled` plus one object per extension id. */
export interface ExtensionsSettings {
  disabled: string[]
  values: Record<string, Record<string, unknown>>
}

/** VS Code's getDefaultValue by type: what a property without a usable default reads as. */
export function getDefaultValue(type: SettingSchema['type']): SettingValue {
  return type === 'boolean' ? false : type === 'number' || type === 'integer' ? 0 : ''
}

/** Whether a stored value is one the schema allows (VS Code's property validation). */
export function isValidSetting(schema: SettingSchema, value: unknown): value is SettingValue {
  switch (schema.type) {
    case 'boolean': return typeof value === 'boolean'
    case 'string': return typeof value === 'string' && (!schema.enum || schema.enum.includes(value))
    case 'number':
    case 'integer':
      return typeof value === 'number' && Number.isFinite(value) && (schema.type === 'number' || Number.isInteger(value))
        && (schema.min === undefined || value >= schema.min) && (schema.max === undefined || value <= schema.max)
  }
}

/** A stored value as the schema allows it, else the default. */
export function normalizeSetting(schema: SettingSchema, value: unknown): SettingValue {
  if (schema.type === 'string' && schema.fromBoolean && typeof value === 'boolean') return schema.fromBoolean[value ? 'true' : 'false']
  return isValidSetting(schema, value) ? value : schema.default
}

/**
 * One extension's settings as a consumer reads them: the value in force (normalized by the schema) and whether the person
 * set it (settings.json holds a valid value; a missing or invalid one means "the default", which for some settings is
 * "let the other side decide" rather than the default's number).
 */
export interface SettingReader {
  get(key: string): SettingValue | undefined
  isSet(key: string): boolean
}

/** A SettingReader over the stored values of one extension (settings.json `extensions.<id>`), by its manifest's schemas. */
export function settingReaderOf(schemas: Readonly<Record<string, SettingSchema>>, values: Readonly<Record<string, unknown>> | undefined): SettingReader {
  return {
    get: key => { const s = schemas[key]; return s ? normalizeSetting(s, values?.[key]) : undefined },
    isSet: key => { const s = schemas[key]; return !!s && isValidSetting(s, values?.[key]) },
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** The storage path of a full key (`ui.deskLine` → ['ui', 'deskLine']). */
export function settingPath(key: string): string[] { return key.split('.') }

/** The value at a full key of the settings.json object; undefined when a step is missing. */
export function valueAt(file: unknown, key: string): unknown {
  let v: unknown = file
  for (const seg of settingPath(key)) v = isObject(v) ? v[seg] : undefined
  return v
}

const prefixOf = (node: ConfigurationNode): string => node.prefix ?? `extensions.${node.id}`
const fullKey = (prefix: string, key: string): string => (prefix ? `${prefix}.${key}` : key)

export class ConfigurationRegistry {
  private readonly nodes = new Map<string, ConfigurationNode>()
  private readonly listeners = new Set<() => void>()

  /** VS Code's onDidSchemaChange: fires after a node is registered or taken back (the JSON schema of settings.json follows it). */
  onDidChange(listener: () => void): IDisposable {
    this.listeners.add(listener)
    return toDisposable(() => { this.listeners.delete(listener) })
  }

  private fire(): void { for (const l of [...this.listeners]) l() }

  registerConfiguration(node: ConfigurationNode): IDisposable {
    if (this.nodes.has(node.id)) throw new Error(`configurações duplicadas: ${node.id}`)
    const taken = this.getConfigurationProperties()
    for (const k of Object.keys(node.properties)) if (fullKey(prefixOf(node), k) in taken) throw new Error(`configuração duplicada: ${fullKey(prefixOf(node), k)}`)
    this.nodes.set(node.id, node)
    this.fire()
    return toDisposable(() => { if (this.nodes.get(node.id) === node) { this.nodes.delete(node.id); this.fire() } })
  }

  /** Every property by its full key (the storage path). */
  getConfigurationProperties(): Record<string, SettingSchema> {
    const out: Record<string, SettingSchema> = {}
    for (const node of this.nodes.values()) for (const [key, schema] of Object.entries(node.properties)) out[fullKey(prefixOf(node), key)] = schema
    return out
  }

  /** The nodes in page order: `order`, then registration. */
  getConfigurationNodes(): ConfigurationNode[] {
    return [...this.nodes.values()].map((n, i) => ({ n, i }))
      .sort((a, b) => (a.n.order ?? Infinity) - (b.n.order ?? Infinity) || a.i - b.i).map(x => x.n)
  }

  /** Every property in page order: by node, then `order`, then key. */
  properties(): ConfigurationProperty[] {
    const out: ConfigurationProperty[] = []
    for (const node of this.getConfigurationNodes()) {
      const entries = Object.entries(node.properties).sort(([ka, a], [kb, b]) => (a.order ?? Infinity) - (b.order ?? Infinity) || ka.localeCompare(kb))
      for (const [key, schema] of entries) out.push({ key: fullKey(prefixOf(node), key), schema, node: node.id })
    }
    return out
  }

  /** The schema of a full key. */
  schemaAt(key: string): SettingSchema | undefined {
    return this.getConfigurationProperties()[key]
  }

  /** The value of a full key read from the whole settings.json object, normalized; undefined when nobody declared it. */
  readAt(file: unknown, key: string): SettingValue | undefined {
    const schema = this.schemaAt(key)
    return schema ? normalizeSetting(schema, valueAt(file, key)) : undefined
  }

  /** Whether settings.json holds a value for the key (VS Code's isConfigured); an invalid one counts, it is the person's. */
  isConfigured(file: unknown, key: string): boolean {
    return valueAt(file, key) !== undefined
  }

  /** The schema of an extension node's `<key>`. */
  schemaOf(id: string, key: string): SettingSchema | undefined {
    return this.nodes.get(id)?.properties[key]
  }

  /** The value of `<id>.<key>` read from the `extensions` settings; undefined when nobody declared it. */
  read(settings: ExtensionsSettings, id: string, key: string): SettingValue | undefined {
    const schema = this.schemaOf(id, key)
    return schema ? normalizeSetting(schema, settings.values[id]?.[key]) : undefined
  }
}

const ID = /^[a-z0-9][a-z0-9-]*$/

/** settings.json's `extensions` object, tolerant: a missing or malformed one is "nothing disabled, nothing set". */
export function readExtensionsSettings(raw: unknown): ExtensionsSettings {
  const out: ExtensionsSettings = { disabled: [], values: {} }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === 'disabled') { if (Array.isArray(v)) out.disabled = [...new Set(v.filter((s): s is string => typeof s === 'string' && ID.test(s)))] }
    else if (ID.test(k) && v && typeof v === 'object' && !Array.isArray(v)) out.values[k] = { ...(v as Record<string, unknown>) }
  }
  return out
}

/** The `extensions` object to write back (`disabled` first, then each extension's values). */
export function writeExtensionsSettings(s: ExtensionsSettings): Record<string, unknown> {
  return { disabled: [...s.disabled], ...s.values }
}

/** `settings` with `<id>.<key>` set to `value` (normalized by the caller). */
export function withSetting(s: ExtensionsSettings, id: string, key: string, value: SettingValue): ExtensionsSettings {
  return { disabled: s.disabled, values: { ...s.values, [id]: { ...s.values[id], [key]: value } } }
}
