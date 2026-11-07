/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The JSON Schema of settings.json, generated from the configuration registry; the note editor hands it to Monaco's JSON
// language service (validation, completion, hover) when the file open is the user's settings.json.
// Origin: https://github.com/microsoft/vscode, commit 7faf984945fefaceb533ca1d851697a2e72e4e68
//   src/vs/platform/configuration/common/configurationRegistry.ts   (the `allSettings` schema: every property by its full key)
//   src/vs/workbench/services/configuration/common/configurationEditing.ts + preferences contribution
//     (registerJSONConfigurationSchema: the schema is registered under a URI and re-generated when the registry changes)
// Adapted: tether's SettingSchema (boolean, string with enum and labels, number, integer) maps to the JSON Schema keywords
// VS Code emits (type, default, description, enum, enumDescriptions, minimum, maximum). Like VS Code's, the file is flat
// (`"ui.deskLine"`, what the app writes, app/shared/settings-file.ts): only the dotted keys are properties; a nested object
// still reads (toValuesTree) but is not suggested. `extensions.disabled` is the one property no node declares. Pure.
import type { ConfigurationNode, SettingSchema } from './vscode-configuration-registry.ts'

export const SETTINGS_SCHEMA_URI = 'tether://schemas/settings'

type Json = Record<string, unknown>

/** One registry property as a JSON Schema fragment. */
export function propertySchema(s: SettingSchema): Json {
  const out: Json = { type: s.type, default: s.default, description: s.description ? `${s.title}: ${s.description}` : s.title }
  if (s.type === 'string' && s.enum) {
    out.enum = [...s.enum]
    if (s.enumLabels) out.enumDescriptions = [...s.enumLabels]
  }
  if (s.type === 'number' || s.type === 'integer') {
    if (s.min !== undefined) out.minimum = s.min
    if (s.max !== undefined) out.maximum = s.max
  }
  return out
}

const EXTENSIONS_DISABLED: Json = {
  type: 'array', items: { type: 'string' }, default: [],
  description: 'Extensões desativadas (valem a partir do próximo início do app).',
}

/** The schema of settings.json for the nodes registered now (core first, then extensions, as the registry orders them). */
export function generateSettingsSchema(nodes: readonly ConfigurationNode[]): Json {
  const flat: Record<string, Json> = { 'extensions.disabled': EXTENSIONS_DISABLED }
  for (const node of nodes) {
    const prefix = node.prefix ?? `extensions.${node.id}`
    for (const [key, s] of Object.entries(node.properties)) {
      flat[prefix ? `${prefix}.${key}` : key] = propertySchema(s)
    }
  }
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Configurações do Tether',
    type: 'object',
    properties: flat,
    // Unknown keys are the person's (a note in the file, a setting of an extension that is off); only declared ones are checked.
    additionalProperties: true,
  }
}
