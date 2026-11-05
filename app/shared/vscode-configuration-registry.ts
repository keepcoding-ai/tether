/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Adaptation of VS Code's configuration registry: contributions declare their settings (type, default, title) once;
// the registry knows every property, its default, and normalizes a stored value against the schema.
// Origin: https://github.com/microsoft/vscode, commit 7faf984945fefaceb533ca1d851697a2e72e4e68
//   src/vs/platform/configuration/common/configurationRegistry.ts (IConfigurationNode → registerConfiguration /
//     deregisterConfigurations, getConfigurationProperties, getDefaultValue by type, the property validation)
// Adapted: a node is one extension's settings (`id` = extension id) and a property's full key is `<id>.<key>`, stored in
// settings.json under `extensions.<id>.<key>` (F9 §4.6). The schema is the three types tether needs (boolean, string
// with an optional enum, number with optional bounds) instead of JSON Schema; an invalid stored value reads as the
// default, as VS Code's validation falls back. Also here: the `extensions.disabled` list (F9 decision 3).
// Left out: scopes, overrides by language, policy, the change event (settings.json is the store; main broadcasts). Pure.
import { toDisposable, type IDisposable } from './vscode-lifecycle.ts'

export type SettingSchema =
  | { type: 'boolean'; default: boolean; title: string }
  | { type: 'string'; default: string; title: string; enum?: readonly string[] }
  | { type: 'number'; default: number; title: string; min?: number; max?: number }

export type SettingValue = boolean | string | number

/** One extension's settings (VS Code's IConfigurationNode). */
export interface ConfigurationNode {
  id: string
  properties: Readonly<Record<string, SettingSchema>>
}

/** The `extensions` object of settings.json: `disabled` plus one object per extension id. */
export interface ExtensionsSettings {
  disabled: string[]
  values: Record<string, Record<string, unknown>>
}

/** VS Code's getDefaultValue by type: what a property without a usable default reads as. */
export function getDefaultValue(type: SettingSchema['type']): SettingValue {
  return type === 'boolean' ? false : type === 'number' ? 0 : ''
}

/** A stored value as the schema allows it, else the default. */
export function normalizeSetting(schema: SettingSchema, value: unknown): SettingValue {
  switch (schema.type) {
    case 'boolean': return typeof value === 'boolean' ? value : schema.default
    case 'string': return typeof value === 'string' && (!schema.enum || schema.enum.includes(value)) ? value : schema.default
    case 'number': return typeof value === 'number' && Number.isFinite(value) && (schema.min === undefined || value >= schema.min) && (schema.max === undefined || value <= schema.max) ? value : schema.default
  }
}

export class ConfigurationRegistry {
  private readonly nodes = new Map<string, ConfigurationNode>()

  registerConfiguration(node: ConfigurationNode): IDisposable {
    if (this.nodes.has(node.id)) throw new Error(`configurações duplicadas: ${node.id}`)
    this.nodes.set(node.id, node)
    return toDisposable(() => { if (this.nodes.get(node.id) === node) this.nodes.delete(node.id) })
  }

  /** Every property by its full key `<id>.<key>`. */
  getConfigurationProperties(): Record<string, SettingSchema> {
    const out: Record<string, SettingSchema> = {}
    for (const node of this.nodes.values()) for (const [key, schema] of Object.entries(node.properties)) out[`${node.id}.${key}`] = schema
    return out
  }

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
