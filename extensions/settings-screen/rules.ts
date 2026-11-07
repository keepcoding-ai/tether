/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The settings page's pure rules: how a key reads, what the query asks, which settings match it, how a typed value is
// validated, and how the entries group into the page's sections.
// Origin: https://github.com/microsoft/vscode, commit 7faf984945fefaceb533ca1d851697a2e72e4e68
//   src/vs/workbench/contrib/preferences/browser/settingsTreeModels.ts (settingKeyToDisplayFormat, wordifyKey,
//     trimCategoryForGroup, parseQuery with the `@modified` tag, isConfigured)
//   src/vs/workbench/services/preferences/common/preferencesModels.ts (SettingMatches: every word of the query is looked
//     for in the key as words, the title, the description and the enum values; a key/title hit outranks a description hit)
//   src/vs/base/common/filters.ts (matchesWords, matchesContiguousSubString: app/renderer/word-filter.ts, accent-blind)
//   src/vs/workbench/services/preferences/common/preferencesValidation.ts (createValidator: number and integer, with
//     minimum and maximum, the messages as the setting row shows them)
// Adapted: messages in Portuguese; the schema is the registry's (app/shared/vscode-configuration-registry.ts), not JSON
// Schema, so only number/integer bounds are validated (a string has no pattern or length); the tags are `@modified` and
// `@ext:<id>`; results keep the page's order (grouped by node and section) instead of a flat ranked list. Pure.
import type { SettingEntry } from '../../app/shared/api.ts'
import type { SettingSchema, SettingValue } from '../../app/shared/vscode-configuration-registry.ts'
import { fold, matchesWords, wordFilter, type Range } from '../../app/renderer/word-filter.ts'

// ---------- display (settingsTreeModels.ts) ----------

function wordifyKey(key: string): string {
  return key
    .replace(/\.([a-z0-9])/g, (_, p1: string) => ` › ${p1.toUpperCase()}`) // a dot becomes a spaced ›
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')                                 // camel case to words: fooBar → foo Bar
    .replace(/^[a-z]/g, m => m.toUpperCase())                               // first letter upper: foo → Foo
}

/** The category without the group's own prefix (`extensions.note` under the group `extensions.note` → ''). */
function trimCategoryForGroup(category: string, groupId: string): string {
  const doTrim = (forward: boolean): string | null => {
    const parts = groupId.split('.')
    while (parts.length) {
      const reg = new RegExp(`^${parts.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\.')}(\\.|$)`, 'i')
      if (reg.test(category)) return category.replace(reg, '')
      if (forward) parts.pop(); else parts.shift()
    }
    return null
  }
  return doTrim(true) ?? doTrim(false) ?? category
}

/** `ui.deskLine` → { category: 'Ui', label: 'Desk Line' }; the group's prefix is trimmed from the category. */
export function settingKeyToDisplayFormat(key: string, groupId = ''): { category: string; label: string } {
  const lastDot = key.lastIndexOf('.')
  let category = ''
  if (lastDot >= 0) { category = key.slice(0, lastDot); key = key.slice(lastDot + 1) }
  category = wordifyKey(trimCategoryForGroup(category, groupId.replace(/\//g, '.')))
  return { category, label: wordifyKey(key) }
}

/** The prefix a node's keys live under (the registry's default for an extension: `extensions.<id>`). */
export function nodePrefix(entry: Pick<SettingEntry, 'node'>): string {
  return entry.node === 'core' ? '' : `extensions.${entry.node}`
}

/** What the row's title says: the schema's title, or the key in words (VS Code's label) when there is none. */
export function settingTitle(entry: Pick<SettingEntry, 'key' | 'node' | 'schema'>): string {
  if (entry.schema.title) return entry.schema.title
  const { category, label } = settingKeyToDisplayFormat(entry.key, nodePrefix(entry))
  return category ? `${category}: ${label}` : label
}

/** The value is in settings.json (VS Code's isConfigured: a user value exists, even one equal to the default). */
export function isConfigured(entry: Pick<SettingEntry, 'configured'>): boolean {
  return entry.configured
}

// ---------- the query (settingsTreeModels.ts parseQuery) ----------

export interface ParsedQuery {
  /** The words left once the tags are taken out, trimmed. */
  query: string
  /** `@modified`: only the configured settings. */
  modified: boolean
  /** `@ext:<id>`: only that node's settings ('core' for the core's). */
  extensions: string[]
}

export const MODIFIED_TAG = '@modified'

export function parseQuery(text: string): ParsedQuery {
  let modified = false
  const extensions: string[] = []
  const query = text
    .replace(/@ext:("([^"]*)"|\S*)/g, (_, raw: string, quoted?: string) => { const id = (quoted ?? raw).trim(); if (id) extensions.push(id); return '' })
    .replace(/(^|\s)@modified(?=\s|$)/g, (_, pre: string) => { modified = true; return pre })
    .replace(/\s+/g, ' ')
    .trim()
  return { query, modified, extensions }
}

/** The query text with `@modified` on or off (the "Modificadas" filter writes the tag into the box, as VS Code does). */
export function withModifiedTag(text: string, on: boolean): string {
  const without = text.replace(/(^|\s)@modified(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim()
  return on ? `${MODIFIED_TAG}${without ? ` ${without}` : ''} ` : without
}

// ---------- matching (preferencesModels.ts SettingMatches) ----------

export interface SettingMatch {
  /** 2: every word hit the title or the key; 1: some word only in the description, enum or section. */
  score: number
  title: Range[]
  description: Range[]
  key: Range[]
}

function addAll(into: Range[], ranges: Range[] | null): void { if (ranges) into.push(...ranges) }

/** Every word of the query must hit the title, the key (as words or as id), the description, an enum label or the
 *  section/node name; null when one word hits nothing. The empty query matches everything with no ranges. */
export function matchSetting(query: string, entry: SettingEntry): SettingMatch | null {
  const words = [...new Set(query.split(' ').map(w => w.trim()).filter(Boolean))]
  const m: SettingMatch = { score: 2, title: [], description: [], key: [] }
  if (!words.length) return m
  const title = settingTitle(entry)
  const keyWords = wordifyKey(entry.key)
  const desc = entry.schema.description ?? ''
  const schema = entry.schema
  const enumTexts = schema.type === 'string' && schema.enum ? [...schema.enum, ...(schema.enumLabels ?? [])] : []
  const places = [schema.section ?? '', entry.nodeTitle]
  // The whole query as an id ("ui.desk") is a key hit.
  const idHit = fold(entry.key).indexOf(fold(query.trim()))
  if (idHit >= 0 && query.trim().includes('.')) return { ...m, key: [{ start: idHit, end: idHit + query.trim().length }] }
  for (const w of words) {
    const t = wordFilter(w, title)
    // The key as an id ("desk") or as words ("Desk Line"); the words' ranges index another text, so none is kept.
    const k = contiguous(w, entry.key) ?? (matchesWords(w, keyWords) ? [] : null)
    if (t || k) { addAll(m.title, t); addAll(m.key, k); continue }
    const d = contiguous(w, desc)
    if (d) { addAll(m.description, d); m.score = 1; continue }
    if (enumTexts.some(e => wordFilter(w, e)) || places.some(p => p && wordFilter(w, p))) { m.score = 1; continue }
    return null
  }
  return m
}

function contiguous(word: string, target: string): Range[] | null {
  if (!target) return null
  const i = fold(target).indexOf(fold(word))
  return i < 0 ? null : [{ start: i, end: i + word.length }]
}

// ---------- validation (preferencesValidation.ts createValidator) ----------

/** The row's validator: the text typed → an error message, or null when it can be written. */
export function createValidator(schema: SettingSchema): (text: string) => string | null {
  if (schema.type !== 'number' && schema.type !== 'integer') return () => null
  const integer = schema.type === 'integer'
  return text => {
    const t = text.trim()
    const n = t === '' ? NaN : Number(t)
    if (!Number.isFinite(n)) return integer ? 'O valor precisa ser um número inteiro.' : 'O valor precisa ser um número.'
    if (integer && !Number.isInteger(n)) return 'O valor precisa ser um número inteiro.'
    if (schema.min !== undefined && n < schema.min) return `O valor precisa ser maior ou igual a ${schema.min}.`
    if (schema.max !== undefined && n > schema.max) return `O valor precisa ser menor ou igual a ${schema.max}.`
    return null
  }
}

/** The value a valid text stands for (the validator said null). */
export function parseValue(schema: SettingSchema, text: string): SettingValue {
  return schema.type === 'number' || schema.type === 'integer' ? Number(text.trim()) : text
}

// ---------- the page's sections ----------

export interface PageSection {
  /** `<node>/<section>`: the TOC's anchor. */
  id: string
  node: string
  nodeTitle: string
  title: string
  entries: SettingEntry[]
}

/** The entries (already in the registry's page order: node, then `order`, then key) as the page's sections: by node,
 *  then by section in first-seen order; a property without a section goes under the node's title. */
export function sectionsOf(entries: readonly SettingEntry[]): PageSection[] {
  const out: PageSection[] = []
  const byId = new Map<string, PageSection>()
  for (const e of entries) {
    const title = e.schema.section ?? e.nodeTitle
    const id = `${e.node}/${title}`
    let s = byId.get(id)
    if (!s) { s = { id, node: e.node, nodeTitle: e.nodeTitle, title, entries: [] }; byId.set(id, s); out.push(s) }
    s.entries.push(e)
  }
  // Sections of one node stay together even when their properties interleave.
  const nodes = [...new Set(out.map(s => s.node))]
  return nodes.flatMap(n => out.filter(s => s.node === n))
}

/** What the page shows for a query: each section with its matching entries (sections left empty drop out). */
export function filterSections(sections: readonly PageSection[], text: string): { sections: PageSection[]; matches: Map<string, SettingMatch>; count: number } {
  const q = parseQuery(text)
  const matches = new Map<string, SettingMatch>()
  const out: PageSection[] = []
  for (const s of sections) {
    if (q.extensions.length && !q.extensions.includes(s.node)) continue
    const entries = s.entries.filter(e => {
      if (q.modified && !isConfigured(e)) return false
      const m = matchSetting(q.query, e)
      if (m) matches.set(e.key, m)
      return !!m
    })
    if (entries.length) out.push({ ...s, entries })
  }
  return { sections: out, matches, count: matches.size }
}
