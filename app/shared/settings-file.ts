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
//     → the keys that changed; ConfigurationModelParser.doParseRaw turns the raw object into the values tree)
//   src/vs/platform/configuration/common/configuration.ts (toValuesTree / addToValueTree: a dotted top-level key is a
//     path into the tree, so `"ui.deskLine": false` and `"ui": { "deskLine": false }` read the same)
// Adapted: no scopes or language overrides; arrays count as leaf values. Precedence differs on purpose: VS Code applies the
// file's keys in order (the last one wins, and a nested object placed after a dotted key replaces that subtree); here nested
// objects are merged first and dotted keys after (shorter before longer), so a dotted key wins whatever the order. Writes
// follow configurationEditing.ts: the key is written flat at the top level (`"ui.deskLine": false`), and any other occurrence
// of it (nested, or a dotted parent/child) is removed so the file keeps a single source. Pure.
import { applyEdits, modify, parse, printParseErrorCode, type FormattingOptions, type ParseError } from 'jsonc-parser'

export interface SettingsError {
  message: string
  offset: number
  length: number
}

export interface ParsedSettings {
  /** The values tree (dotted keys expanded, nested objects merged); `{}` for an empty file or when the text is invalid (use `errors` to tell). */
  value: Record<string, unknown>
  /** The file's top-level object as written (keys not expanded). */
  raw: Record<string, unknown>
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
  if (text.trim() === '') return { value: {}, raw: {}, errors: [] }
  const errors: ParseError[] = []
  const value: unknown = parse(text, errors, PARSE_OPTIONS)
  if (errors.length) return { value: {}, raw: {}, errors: toErrors(errors) }
  if (!isObject(value)) return { value: {}, raw: {}, errors: [{ message: 'ExpectedObject', offset: 0, length: text.length }] }
  return { value: toValuesTree(value), raw: value, errors: [] }
}

const clone = (v: unknown): unknown =>
  isObject(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) : Array.isArray(v) ? v.map(clone) : v

/** `value` merged into `target[key]`: two objects merge key by key, anything else replaces. */
function mergeInto(target: Record<string, unknown>, key: string, value: unknown): void {
  const cur = target[key]
  if (isObject(cur) && isObject(value)) { for (const [k, v] of Object.entries(value)) mergeInto(cur, k, v) }
  else target[key] = clone(value)
}

/**
 * The values tree of the file's top-level object (VS Code's toValuesTree): each top-level key is split on dots and its value
 * placed at that path. Keys with fewer segments go first, so nested objects lay the base and dotted keys win; a dotted key
 * under a non-object value is ignored, as VS Code's addToValueTree reports and skips it.
 */
export function toValuesTree(raw: Record<string, unknown>): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  const keys = Object.keys(raw).map((k, i) => ({ k, i, n: k.split('.').length })).sort((a, b) => a.n - b.n || a.i - b.i)
  outer: for (const { k } of keys) {
    const segs = k.split('.')
    const last = segs.pop()!
    let at = root
    for (const s of segs) {
      if (at[s] === undefined) at[s] = {}
      if (!isObject(at[s])) continue outer
      at = at[s] as Record<string, unknown>
    }
    mergeInto(at, last, raw[k])
  }
  return root
}

/** The value at a dotted key of a values tree; undefined when a step is missing. */
export function treeValueAt(tree: unknown, key: string): unknown {
  let v: unknown = tree
  for (const seg of key.split('.')) v = isObject(v) ? v[seg] : undefined
  return v
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

const startsWith = (a: readonly string[], b: readonly string[]): boolean => b.length <= a.length && b.every((s, i) => a[i] === s)

/** `text` with `sub` removed inside the top-level key `name`, and the objects that removal left empty removed too. */
function removeInside(text: string, name: string, sub: readonly string[]): string {
  const fmt = { formattingOptions: formattingOf(text) }
  text = applyEdits(text, modify(text, [name, ...sub], undefined, fmt))
  for (let n = sub.length - 1; n >= 0; n--) {
    const at = [name, ...sub.slice(0, n)]
    let v: unknown = parseSettings(text).raw
    for (const s of at) v = isObject(v) ? v[s] : undefined
    if (!isObject(v) || Object.keys(v).length) break
    text = applyEdits(text, modify(text, at, undefined, fmt))
  }
  return text
}

/**
 * `text` with the setting `key` (its dotted segments) changed at `rest` inside its value (`rest` empty: the whole value;
 * `value` undefined removes it). The setting is written flat at the top level (`"a.b": …`), as VS Code's configurationEditing
 * writes it, and every other occurrence goes: a nested one (`"a": { "b": … }`, with the parents it leaves empty) and a dotted
 * one deeper or shallower (`"a.b.c"`, `"a"`'s `"b"` inside `"a"`). When the flat key is the only occurrence and holds an
 * object, the edit is made inside it (its comments survive); otherwise the merged value is written whole. An invalid text
 * is returned as an error and never edited.
 */
export function setSettingText(text: string, key: readonly string[], rest: readonly (string | number)[], value: unknown): SettingsEdit {
  const parsed = parseSettings(text)
  if (parsed.errors.length) return { ok: false, errors: parsed.errors }
  const flat = key.join('.')
  const others = Object.keys(parsed.raw).filter(name => {
    if (name === flat) return false
    const segs = name.split('.')
    return startsWith(key, segs) || startsWith(segs, key)
  })
  let base = text.trim() === '' ? '{}' : text
  const fmt = (): { formattingOptions: FormattingOptions } => ({ formattingOptions: formattingOf(base) })
  if (rest.length && !others.length && isObject(parsed.raw[flat])) {
    return { ok: true, text: applyEdits(base, modify(base, [flat, ...rest], value, fmt())) }
  }
  let next: unknown = value
  if (rest.length) {
    const root: Record<string, unknown> = { v: clone(treeValueAt(parsed.value, flat)) }
    const path = ['v', ...rest.map(String)]
    let at = root
    for (const s of path.slice(0, -1)) { if (!isObject(at[s])) at[s] = {}; at = at[s] as Record<string, unknown> }
    if (value === undefined) delete at[path[path.length - 1]!]
    else at[path[path.length - 1]!] = value
    next = root.v
  }
  for (const name of others) {
    const segs = name.split('.')
    base = segs.length < key.length ? removeInside(base, name, key.slice(segs.length)) : applyEdits(base, modify(base, [name], undefined, fmt()))
  }
  return { ok: true, text: applyEdits(base, modify(base, [flat], next, fmt())) }
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
