// The Regency's remote floor (extensions/regency/remote-input.ts): a minimal input from what tetherd knows through the pipe.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { regencyModelOf } from '../../extensions/regency/model.ts'
import { lastSegment, remoteInputOf } from '../../extensions/regency/remote-input.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'

const slot = (slotId: string, extra: Partial<SlotState> = {}): SlotState =>
  ({ slotId, kind: 'claude', cwd: 'C:\\work\\proj', status: 'running', ...extra }) as SlotState

describe('remoteInputOf', () => {
  test('empty state gives an empty valid model', () => {
    for (const m of [regencyModelOf(remoteInputOf()), regencyModelOf(remoteInputOf({ slots: [] }))]) {
      assert.deepEqual(m.waiting, [])
      assert.deepEqual(m.tree, [])
      assert.deepEqual(m.byAgent.filter(g => !g.you), [])
      assert.deepEqual(m.closed.rows, [])
    }
  })

  test('a slot waiting for the person is in waiting, by attention or by rerouted attention', () => {
    const m = regencyModelOf(remoteInputOf({ slots: [
      slot('a', { attention: 'waiting', title: 'Ask me' }),
      slot('b', { attentionFor: { slotId: 'x', value: 'waiting' } }),
      slot('c', { turn: 'busy' }),
    ] }))
    assert.deepEqual(m.waiting.map(w => [w.target.id, w.reason]), [['a', 'agent-waiting'], ['b', 'agent-waiting']])
    assert.equal(m.waiting[0]!.label, 'Ask me')
  })

  test('busy, idle, done, ended and asleep land in the right states', () => {
    const m = regencyModelOf(remoteInputOf({
      slots: [
        slot('busy', { turn: 'busy' }), slot('idle'), slot('done', { attention: 'done' }),
        slot('gone', { status: 'exited' }), slot('sleep'),
      ],
      deskMap: { desks: [{ id: 'd1', name: 'Mesa', kind: 'queue', panes: [
        { id: 'busy', type: 'terminal' }, { id: 'idle', type: 'terminal' }, { id: 'done', type: 'terminal' },
        { id: 'gone', type: 'terminal' }, { id: 'sleep', type: 'terminal', asleep: true }, { id: 'n1', type: 'note' },
      ] }], drawer: [] },
    }))
    const rows = Object.fromEntries(m.tree.flatMap(d => d.panes).map(p => [p.target.id, p]))
    assert.equal(rows.busy!.state, 'busy')
    assert.equal(rows.idle!.state, 'idle')
    assert.equal(rows.done!.state, 'idle'); assert.equal(rows.done!.mark, 'done')
    assert.equal(rows.gone!.state, 'idle'); assert.equal(rows.gone!.mark, 'ended')
    assert.equal(rows.sleep!.state, 'asleep')
    assert.equal(rows.n1!.type, 'note')
    assert.equal(m.tree[0]!.name, 'Mesa')
  })

  test('slots the map does not place stay visible in one neutral desk; the title falls back to the last folder segment', () => {
    const input = remoteInputOf({ slots: [slot('a'), slot('s', { kind: 'shell', cwd: '/home/u/secret/dir' })] })
    assert.equal(input.desks.desks.length, 1)
    assert.deepEqual(input.desks.desks[0]!.panes.map(p => p.title), ['proj', 'dir'])
    assert.deepEqual(input.agents.map(a => a.id), ['a'])
    assert.equal(lastSegment('C:\\a\\b\\'), 'b')
    assert.equal(lastSegment(undefined), undefined)
  })

  test('nothing outside the allow list leaves: env, args and request text never show up', () => {
    const dirty = {
      ...slot('a', { attention: 'waiting', title: 'T' }),
      env: { SECRET: 'CANARY-ENV-9f3' }, args: ['--token', 'CANARY-ARGS-7c1'], prompt: 'CANARY-TEXT-2b8',
      binding: { sessionId: 's', title: 'x', transcript: 'CANARY-BINDING' },
    }
    const dirtyMap = { desks: [{ id: 'd', name: 'D', kind: 'queue', env: { K: 'CANARY-ENV-9f3' }, panes: [{ id: 'a', type: 'terminal', args: ['CANARY-ARGS-7c1'] }] }], drawer: [] }
    const out = JSON.stringify(remoteInputOf({ slots: [dirty as unknown as SlotState], deskMap: dirtyMap as never }))
    assert.ok(!/CANARY/.test(out), out)
    assert.ok(!out.includes('C:\\\\work'), 'the full cwd does not leave')
  })

  test('the source imports nothing of renderer/ nor node:', () => {
    const src = readFileSync(new URL('../../extensions/regency/remote-input.ts', import.meta.url), 'utf8')
    const specs = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map(m => m[1]!)
    assert.ok(specs.length > 0)
    for (const s of specs) {
      assert.ok(!s.includes('renderer/'), s)
      assert.ok(!s.startsWith('node:'), s)
    }
    assert.ok(!/\.\.\.\s*(slot|s|d|p)\b/.test(src), 'no spread of a pipe object')
  })
})
