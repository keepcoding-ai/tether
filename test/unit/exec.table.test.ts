// The executor's closed table lists, by hand, which operations each lazy module (ops-agents / ops-ext / ops-os) serves. A name
// added to a module and forgotten in the list would be a missing operation at run time (only the types of the call sites say
// so, and only for names already in OpTypes); a name in the list that the module does not export would fail on its first call.
// This test imports the modules and compares both ways, and checks the merged table against the protocol's closed list.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { OP_META } from '../../src/exec/protocol.ts'
import { agentOps } from '../../src/exec/ops-agents.ts'
import { extOps } from '../../src/exec/ops-ext.ts'
import { fsOps } from '../../src/exec/ops-fs.ts'
import { osOps } from '../../src/exec/ops-os.ts'
import { handsOps } from '../../src/exec/ops-hands.ts'
import { lazyNames, table } from '../../src/exec/table.ts'

const modules = { agents: agentOps, ext: extOps, os: osOps, hands: handsOps } as const

describe('exec table', () => {
  for (const group of Object.keys(modules) as (keyof typeof modules)[]) {
    test(`${group}: the listed names are exactly what the module exports`, () => {
      const exported = Object.keys(modules[group]).sort()
      const listed = [...(lazyNames[group] as readonly string[])].sort()
      assert.deepEqual(listed.filter((n) => !exported.includes(n)), [], `listed in table.ts but not exported by ops-${group}.ts`)
      assert.deepEqual(exported.filter((n) => !listed.includes(n)), [], `exported by ops-${group}.ts but missing from lazyNames.${group} in table.ts`)
      for (const name of exported) assert.equal(typeof (modules[group] as Record<string, unknown>)[name], 'function', `${group}.${name}`)
    })
  }

  test('no name is served by two modules', () => {
    const all = [...Object.keys(fsOps), ...lazyNames.agents, ...lazyNames.ext, ...lazyNames.os, ...lazyNames.hands]
    assert.deepEqual(all.filter((n, i) => all.indexOf(n) !== i), [])
  })

  test('the merged table serves exactly the operations of the protocol (OP_META)', () => {
    assert.deepEqual(Object.keys(table).sort(), Object.keys(OP_META).sort())
    for (const name of Object.keys(OP_META)) assert.equal(typeof (table as unknown as Record<string, unknown>)[name], 'function', name)
  })
})
