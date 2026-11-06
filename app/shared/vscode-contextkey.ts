/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Adaptation of VS Code's context key expressions: a `when` clause is a string over named context keys, so a manifest
// stays data (the core reads manifests of disabled extensions too) and the core evaluates it against its own state.
// Origin: https://github.com/microsoft/vscode, commit 7faf984945fefaceb533ca1d851697a2e72e4e68
//   src/vs/platform/contextkey/common/contextkey.ts (ContextKeyExpr.deserialize: `||` splits into ORs, `&&` into ANDs;
//     `!key` is NOT, `key == value` / `key != value` are EQUALS / NOT_EQUALS, a bare `key` is DEFINED (truthy))
// Adapted: only those forms (no parentheses, regex `=~`, `in`, comparisons); values are bare words or single-quoted;
// a key's value comes from a lookup function. An expression that does not parse throws (the manifest is wrong). Pure.

export type ContextValue = string | number | boolean | undefined
export type ContextLookup = (key: string) => ContextValue

type Term = { kind: 'defined'; key: string } | { kind: 'not'; key: string } | { kind: 'equals' | 'notEquals'; key: string; value: string }
/** An OR of ANDs (VS Code normalizes to this shape too). */
export type ContextKeyExpr = Term[][]

const KEY = /^[A-Za-z_][\w.-]*$/

function parseTerm(raw: string, source: string): Term {
  const t = raw.trim()
  const eq = /^(.+?)\s*(==|!=)\s*(.+)$/.exec(t)
  if (eq) {
    const key = eq[1]!.trim()
    const value = eq[3]!.trim().replace(/^'(.*)'$/, '$1')
    if (!KEY.test(key)) throw new Error(`when inválido: ${JSON.stringify(source)}`)
    return { kind: eq[2] === '==' ? 'equals' : 'notEquals', key, value }
  }
  const not = t.startsWith('!')
  const key = not ? t.slice(1).trim() : t
  if (!KEY.test(key)) throw new Error(`when inválido: ${JSON.stringify(source)}`)
  return not ? { kind: 'not', key } : { kind: 'defined', key }
}

/** VS Code's ContextKeyExpr.deserialize, for the forms above. */
export function deserialize(when: string): ContextKeyExpr {
  return when.split('||').map(or => or.split('&&').map(and => parseTerm(and, when)))
}

function evalTerm(t: Term, lookup: ContextLookup): boolean {
  const v = lookup(t.key)
  switch (t.kind) {
    case 'defined': return !!v
    case 'not': return !v
    case 'equals': return String(v) === t.value
    case 'notEquals': return String(v) !== t.value
  }
}

export function evaluate(expr: ContextKeyExpr, lookup: ContextLookup): boolean {
  return expr.some(and => and.every(t => evalTerm(t, lookup)))
}
