// What an agent's tool knows each tab by, kept with the tab (extensions/browser/agent-tabs.ts): ids given once and never again,
// the active tab, both back after a new opening of the app (a new AgentTabs over the same file), gone when the tab is closed,
// each owner apart, and a file that is not what it should be read as nothing.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentTabs, parseAgentTabs } from '../../extensions/browser/agent-tabs.ts'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tether-agtabs-'))
  const file = join(dir, 'browser', 'agent-tabs.json')
  return { file, done: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('AgentTabs', () => {
  test('ids are given in order, kept with the tab and never given twice, also after the tab is closed', () => {
    const t = setup()
    try {
      const a = new AgentTabs(t.file)
      assert.deepEqual(a.handle('slot1', 'tabA'), { handle: 't1', active: false })
      assert.deepEqual(a.handle('slot1', 'tabB'), { handle: 't2', active: false })
      assert.deepEqual(a.handle('slot1', 'tabA'), { handle: 't1', active: false }, 'asked again: the same')
      a.forget('tabB')
      assert.deepEqual(a.handle('slot1', 'tabC'), { handle: 't3', active: false }, 't2 is not given again')
      assert.deepEqual(a.view('slot1'), { seq: 3, handles: { tabA: 't1', tabC: 't3' } })
    } finally { t.done() }
  })

  test('a new opening of the app reads the same ids and the active tab back', () => {
    const t = setup()
    try {
      const a = new AgentTabs(t.file)
      a.handle('slot1', 'tabA')
      a.handle('slot1', 'tabB')
      a.setActive('slot1', 'tabB')
      a.handle('slot2', 'tabZ')
      const b = new AgentTabs(t.file)
      assert.deepEqual(b.handle('slot1', 'tabA'), { handle: 't1', active: false })
      assert.deepEqual(b.handle('slot1', 'tabB'), { handle: 't2', active: true })
      assert.deepEqual(b.handle('slot2', 'tabZ'), { handle: 't1', active: false }, 'each owner counts apart')
      assert.deepEqual(b.handle('slot1', 'tabNew'), { handle: 't3', active: false })
      // No address, no title: only ids.
      assert.doesNotMatch(readFileSync(t.file, 'utf8'), /http|title/)
    } finally { t.done() }
  })

  test('closing the active tab clears the active mark; setActive ignores a tab the owner has no id for', () => {
    const t = setup()
    try {
      const a = new AgentTabs(t.file)
      a.handle('s', 'tabA')
      a.setActive('s', 'tabA')
      a.setActive('s', 'unknown')
      a.setActive('other', 'tabA')
      assert.equal(a.view('s')!.active, 'tabA')
      a.forget('tabA')
      assert.equal(new AgentTabs(t.file).view('s')!.active, undefined)
      assert.equal(new AgentTabs(t.file).view('s')!.seq, 1, 'the counter outlives the last tab')
    } finally { t.done() }
  })

  test('a file that is not what it should be is read as nothing, and what is malformed in it is dropped', () => {
    const t = setup()
    try {
      assert.deepEqual(parseAgentTabs('x'), { v: 1, owners: {} })
      assert.deepEqual(parseAgentTabs({ v: 2, owners: { s: { seq: 1, handles: { a: 't1' } } } }), { v: 1, owners: {} })
      const doc = parseAgentTabs({ v: 1, owners: { s: { seq: 1, active: 'gone', handles: { a: 't1', b: 't1', c: 'x9', d: 't7', 'bad id!': 't8' } }, 'bad owner!': { seq: 1, handles: {} }, n: 'x' } })
      assert.deepEqual(doc, { v: 1, owners: { s: { seq: 7, handles: { a: 't1', d: 't7' } } } }, 'a repeated or malformed id goes; the counter never sits below an id in use')
      const a = new AgentTabs(t.file)
      a.handle('s', 'tabA')
      writeFileSync(t.file, '{ not json')
      assert.equal(new AgentTabs(t.file).view('s'), undefined)
    } finally { t.done() }
  })
})
