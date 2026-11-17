// Background subagents keep the agent "working": AttentionState.setBackground and the Claude hook's markers.
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { AttentionState, WAKE_MS } from '../../src/daemon/attention.ts'
import { tempDirs } from './tmp.helpers.ts'

const HOOK = resolve(import.meta.dirname, '../../src/report/claude-hook.mjs')
const homes = tempDirs('tether-bg-')
after(() => homes.cleanup())

const claude = () => new AttentionState({ idle: false, bel: false })

describe('background subagents', () => {
  test('a Stop with a subagent running keeps the turn busy and shows no badge', () => {
    const a = claude()
    a.hook('start')
    a.setBackground(1, 0)
    a.hook('done')
    assert.equal(a.turn, 'busy')
    assert.equal(a.value, undefined)
  })

  test('the agent wakes after its subagent and its Stop ends the turn', () => {
    const a = claude()
    a.hook('start'); a.setBackground(1, 0); a.hook('done')
    a.setBackground(0, 1000)
    assert.equal(a.turn, 'busy')
    assert.equal(a.wakeDueAt(), 1000 + WAKE_MS)
    a.hook('done')
    assert.equal(a.turn, 'idle')
    assert.equal(a.value, 'done')
    assert.equal(a.wakeDueAt(), undefined)
  })

  test('no Stop after the last subagent: the wake fallback ends the turn', () => {
    const a = claude()
    a.hook('start'); a.setBackground(2, 0); a.hook('done'); a.setBackground(0, 5)
    assert.equal(a.wakeExpired(5 + WAKE_MS - 1), false)
    assert.equal(a.wakeExpired(5 + WAKE_MS), true)
    assert.equal(a.turn, 'idle')
  })

  test('a marker seen after the Stop (debounce) still turns it busy', () => {
    const a = claude()
    a.hook('start'); a.hook('done')
    assert.equal(a.turn, 'idle')
    a.setBackground(1, 0)
    assert.equal(a.turn, 'busy')
  })

  test('a foreground subagent that ends before the Stop changes nothing', () => {
    const a = claude()
    a.hook('start'); a.setBackground(1, 0); a.setBackground(0, 1); a.hook('done')
    assert.equal(a.turn, 'idle')
    assert.equal(a.value, 'done')
  })

  test('reset forgets the subagents', () => {
    const a = claude()
    a.hook('start'); a.setBackground(1, 0); a.hook('done'); a.reset()
    assert.equal(a.turn, 'idle'); assert.equal(a.background, 0)
  })
})

describe('claude hook markers', () => {
  const run = (home: string, event: string, payload: object) =>
    spawnSync(process.execPath, [HOOK, event], { input: JSON.stringify(payload), env: { ...process.env, TETHER_HOME: home, TETHER_SLOT_ID: 's1' }, encoding: 'utf8' })

  test('SubagentStart leaves a marker, SubagentStop removes it, SessionStart clears all', () => {
    const home = homes.make()
    run(home, 'SubagentStart', { session_id: 'x', agent_id: 'a-1', hook_event_name: 'SubagentStart' })
    run(home, 'SubagentStart', { session_id: 'x', agent_id: 'a/2', hook_event_name: 'SubagentStart' })
    const dir = join(home, 'slots')
    assert.deepEqual(readdirSync(dir).filter(n => n.startsWith('s1.bg.')).sort(), ['s1.bg.a-1', 's1.bg.a2'])
    const r = run(home, 'SubagentStop', { session_id: 'x', agent_id: 'a-1', hook_event_name: 'SubagentStop' })
    assert.equal(r.stdout, '')
    assert.equal(existsSync(join(dir, 's1.bg.a-1')), false)
    run(home, 'SessionStart', { session_id: 'y', source: 'clear', cwd: home })
    assert.deepEqual(readdirSync(dir).filter(n => n.startsWith('s1.bg.')), [])
    assert.equal(existsSync(join(dir, 's1.attention')), false)
  })
})
