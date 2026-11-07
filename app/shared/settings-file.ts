/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The text of settings.json as VS Code treats its user settings file: JSONC (comments, trailing commas), edited in place so
// the person's comments and layout survive, refused when it does not parse.
// Origin: https://github.com/microsoft/vscode, commit 7faf984945fefaceb533ca1d851697a2e72e4e68
//   src/vs/base/common/json.ts, jsonEdit.ts, jsonFormatter.ts (here the npm package `jsonc-parser`, the same code: parse
//     with errors, modify + applyEdits)
//   src/vs/workbench/services/configuration/common/configurationEditing.ts (the write rules: an unparsable file is not
//     written; an empty one starts as `{}`; formatting options come from the file)
//   src/vs/platform/configuration/common/configurationModels.ts (tolerant parse into a model, `compare` of two models
//     → the keys that changed)
// Adapted: no scopes or language overrides; keys are dotted paths of the plain object; arrays count as leaf values. Pure.
import { applyEdits, modify, parse, printParseErrorCode, type FormattingOptions, type ParseError } from 'jsonc-parser'

export interface SettingsError {
  message: string
  offset: number
  length: number
}

export interface ParsedSettings {
  /** The settings object; `{}` for an empty file or when the text is invalid (use `errors` to tell). */
  value: Record<string, unknown>
  /** Parse problems with their offsets; empty when the text is valid. */
  errors: SettingsError[]
}

const PARSE_OPTIONS = { allowTrailingComma: true, disallowComments: false, allowEmptyContent: true } as const

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function toErrors(errors: ParseError[]): SettingsError[] {
  return errors.map(e => ({ message: printParseErrorCode(e.error), offset: e.offset, length: e.length }))
}

/** Parses the file's text tolerantly (comments, trailing commas). An empty file is `{}`; a root that is not an object is an error. */
export function parseSettings(text: string): ParsedSettings {
  if (text.trim() === '') return { value: {}, errors: [] }
  const errors: ParseError[] = []
  const value: unknown = parse(text, errors, PARSE_OPTIONS)
  if (errors.length) return { value: {}, errors: toErrors(errors) }
  if (!isObject(value)) return { value: {}, errors: [{ message: 'ExpectedObject', offset: 0, length: text.length }] }
  return { value, errors: [] }
}

/** Indentation and line ending as the file already has them (two spaces and LF by default). */
export function formattingOf(text: string): FormattingOptions {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const indent = /^([ \t]+)\S/m.exec(text)?.[1]
  if (!indent) return { insertSpaces: true, tabSize: 2, eol }
  if (indent.startsWith('\t')) return { insertSpaces: false, tabSize: 1, eol }
  return { insertSpaces: true, tabSize: indent.length, eol }
}

export type SettingsEdit = { ok: true; text: string } | { ok: false; errors: SettingsError[] }

/**
 * `text` with the value at `path` set (undefined removes the key), everything else as it was. An invalid text is
 * returned as an error and never edited; an empty one starts from `{}`.
 */
export function setValueText(text: string, path: readonly (string | number)[], value: unknown): SettingsEdit {
  const parsed = parseSettings(text)
  if (parsed.errors.length) return { ok: false, errors: parsed.errors }
  const base = text.trim() === '' ? '{}' : text
  const edits = modify(base, [...path], value, { formattingOptions: formattingOf(text) })
  return { ok: true, text: applyEdits(base, edits) }
}

/** The dotted paths of every leaf (non-empty plain objects recurse; arrays, empty objects and scalars are leaves). */
function leaves(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (isObject(value) && Object.keys(value).length > 0) {
    for (const [k, v] of Object.entries(value)) leaves(v, prefix ? `${prefix}.${k}` : k, out)
  } else if (prefix) {
    out.set(prefix, value)
  }
}

/** The keys (dotted paths, sorted) whose value differs between two settings objects, added or removed ones included. */
export function diffSettings(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const a = new Map<string, unknown>()
  const b = new Map<string, unknown>()
  leaves(before, '', a)
  leaves(after, '', b)
  const changed: string[] = []
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    if (!a.has(key) || !b.has(key) || JSON.stringify(a.get(key)) !== JSON.stringify(b.get(key))) changed.push(key)
  }
  return changed.sort()
}
