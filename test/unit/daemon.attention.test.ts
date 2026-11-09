// The attention state machine (src/daemon/attention.ts) and the Claude hook's Stop / Notification reports.
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { AttentionState, attentionOptions, BURST_BYTES, IDLE_MS, parseAttentionReport } from '../../src/daemon/attention.ts'
// @ts-expect-error plain JS module without declarations (JSDoc only)
import { toAttention } from '../../src/report/claude-hook.mjs'
import { tempDirs } from './tmp.helpers.ts'

const HOOK = resolve(import.meta.dirname, '../../src/report/claude-hook.mjs')
const homes = tempDirs('tether-attn-')
after(() => homes.cleanup())

describe('attention: claude (hooks only)', () => {
  test('a hook sets the value; typing clears it; seen clears it; a reset clears it', () => {
    const a = new AttentionState(attentionOptions('claude'))
    assert.equal(a.hook('done'), true)
    assert.equal(a.value, 'done')
    assert.equal(a.hook('done'), false, 'same value: no change')
    assert.equal(a.input('x'), true)
    assert.equal(a.value, undefined)
    a.hook('waiting')
    assert.equal(a.seen(), true)
    assert.equal(a.value, undefined)
    a.hook('done')
    assert.equal(a.reset(), true)
    assert.equal(a.value, undefined)
  })
  test('terminal replies (input starting with ESC) do not count as typing', () => {
    const a = new AttentionState(attentionOptions('claude'))
    a.hook('done')
    assert.equal(a.input('\x1b[?1;2c'), false)
    assert.equal(a.input('\x1b[I'), false)
    assert.equal(a.value, 'done')
  })
  test('claude ignores BEL and never goes idle by itself', () => {
    const a = new AttentionState(attentionOptions('claude'))
    a.input('oi\r')
    assert.equal(a.output('x'.repeat(BURST_BYTES * 2) + '\x07', 0), false)
    assert.equal(a.dueAt(), undefined)
    assert.equal(a.poll(IDLE_MS * 10), false)
    assert.equal(a.value, undefined)
  })
})

describe('attention: turn signal', () => {
  test('claude: start=busy, waiting keeps busy, done=idle; start leaves no badge', () => {
    const a = new AttentionState(attentionOptions('claude'))
    assert.equal(a.turn, 'idle')
    assert.equal(a.hook('start'), true)
    assert.equal(a.turn, 'busy')
    assert.equal(a.value, undefined)
    assert.equal(a.hook('start'), false)
    assert.equal(a.hook('waiting'), true)
    assert.equal(a.turn, 'busy')
    assert.equal(a.hook('done'), true)
    assert.equal(a.turn, 'idle')
    assert.equal(a.value, 'done')
    a.hook('start')
    assert.equal(a.reset(), true)
    assert.equal(a.turn, 'idle')
  })
  test('claude: Enter in the terminal does not make it busy (hooks only)', () => {
    const a = new AttentionState(attentionOptions('claude'))
    a.input('oi\r')
    assert.equal(a.turn, 'idle')
  })
  test('soul: Enter=busy, quiet after a burst=idle', () => {
    const a = new AttentionState(attentionOptions('soul'))
    assert.equal(a.input('oi\r'), true)
    assert.equal(a.turn, 'busy')
    a.output('x'.repeat(BURST_BYTES), 1000)
    assert.equal(a.poll(1000 + IDLE_MS), true)
    assert.equal(a.turn, 'idle')
    assert.equal(a.value, 'done')
  })
  test('shell never goes busy', () => {
    const a = new AttentionState(attentionOptions('shell'))
    a.input('ls\r')
    assert.equal(a.turn, 'idle')
  })
  test('toAttention: UserPromptSubmit = start; subagent payloads (agent_id) are ignored', () => {
    const ts = '2026-10-30T10:00:00.000Z'
    const p = { session_id: 'abc', hook_event_name: 'UserPromptSubmit', prompt: 'oi' }
    assert.deepEqual(toAttention('UserPromptSubmit', p, ts), { ts, kind: 'start', sessionId: 'abc' })
    assert.equal(toAttention('UserPromptSubmit', { ...p, agent_id: 'sub1' }, ts), undefined)
    assert.equal(toAttention('Stop', { session_id: 'abc', agent_id: 'sub1' }, ts), undefined)
    assert.equal(parseAttentionReport(JSON.stringify({ ts, kind: 'start' }))?.kind, 'start')
  })
})

describe('attention: BEL', () => {
  test('a bare BEL means waiting (shell)', () => {
    const a = new AttentionState(attentionOptions('shell'))
    assert.equal(a.output('beep\x07', 0), true)
    assert.equal(a.value, 'waiting')
  })
  test('the BEL that ends an OSC (window title, hyperlink) is not a bell, even split across chunks', () => {
    const a = new AttentionState(attentionOptions('shell'))
    assert.equal(a.output('\x1b]0;PS D:\\atrium\x07prompt> ', 0), false)
    assert.equal(a.output('\x1b]8;;http://x', 0), false)
    assert.equal(a.output('\x07link\x1b]8;;\x07', 0), false)
    assert.equal(a.output('\x1b]2;title\x1b\\', 0), false, 'ST-terminated OSC')
    assert.equal(a.output('\x1bP+q\x07', 0), false, 'DCS')
    assert.equal(a.value, undefined)
    assert.equal(a.output('\x1b[31mred\x1b[0m\x07', 0), true, 'CSI then a real bell')
  })
  test('shells never get the idle heuristic', () => {
    const a = new AttentionState(attentionOptions('shell'))
    a.input('dir\r')
    a.output('x'.repeat(BURST_BYTES * 4), 0)
    assert.equal(a.dueAt(), undefined)
    assert.equal(a.poll(IDLE_MS * 2), false)
  })
})

describe('attention: soul idle heuristic', () => {
  test('Enter, a burst, then silence → done; disarmed afterwards', () => {
    const a = new AttentionState(attentionOptions('soul'))
    a.input('olá\r')
    a.output('x'.repeat(BURST_BYTES / 2), 1000)
    assert.equal(a.dueAt(), undefined, 'below the burst: nothing pending')
    a.output('x'.repeat(BURST_BYTES), 2000)
    assert.equal(a.dueAt(), 2000 + IDLE_MS)
    assert.equal(a.poll(2000 + IDLE_MS - 1), false)
    a.output('more', 3000) // still talking: the deadline moves
    assert.equal(a.poll(2000 + IDLE_MS), false)
    assert.equal(a.poll(3000 + IDLE_MS), true)
    assert.equal(a.value, 'done')
    a.output('x'.repeat(BURST_BYTES * 2), 9000)
    assert.equal(a.dueAt(), undefined, 'one turn, one badge')
  })
  test('output without a submitted line (startup paint, typing echo) never arms', () => {
    const a = new AttentionState(attentionOptions('soul'))
    a.output('x'.repeat(BURST_BYTES * 4), 0)
    a.input('abc')
    a.output('x'.repeat(BURST_BYTES * 4), 10)
    assert.equal(a.dueAt(), undefined)
  })
  test('a reset disarms a pending turn', () => {
    const a = new AttentionState(attentionOptions('soul'))
    a.input('\r'); a.output('x'.repeat(BURST_BYTES), 0)
    a.reset()
    assert.equal(a.poll(IDLE_MS * 2), false)
  })
})

describe('attention report', () => {
  test('parse: valid, unknown kind, garbage', () => {
    assert.deepEqual(parseAttentionReport('{"ts":"2026-10-30T10:00:00.000Z","kind":"done","sessionId":"s"}'), { ts: '2026-10-30T10:00:00.000Z', kind: 'done', sessionId: 's' })
    assert.equal(parseAttentionReport('{"ts":"x","kind":"other"}'), undefined)
    assert.equal(parseAttentionReport('nope'), undefined)
    assert.equal(parseAttentionReport('[]'), undefined)
  })
  test('toAttention: Stop = done, Notification = waiting (auth_success ignored), others nothing', () => {
    const ts = '2026-10-30T10:00:00.000Z'
    const stop = { session_id: 'abc', transcript_path: 'x', cwd: 'D:\\w', hook_event_name: 'Stop', stop_hook_active: false }
    assert.deepEqual(toAttention('Stop', stop, ts), { ts, kind: 'done', sessionId: 'abc' })
    const perm = { session_id: 'abc', hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' }
    assert.deepEqual(toAttention('Notification', perm, ts), { ts, kind: 'waiting', sessionId: 'abc' })
    assert.equal(toAttention('Notification', { ...perm, notification_type: 'idle_prompt' }, ts)?.kind, 'waiting')
    assert.equal(toAttention('Notification', { message: 'x' }, ts)?.kind, 'waiting', 'older Claude without notification_type')
    assert.equal(toAttention('Notification', { ...perm, notification_type: 'auth_success' }, ts), undefined)
    assert.equal(toAttention('SessionStart', stop, ts), undefined)
  })
  test('the hook process writes <slot>.attention (and nothing in the jsonl), silently', () => {
    const home = homes.make()
    const r = spawnSync(process.execPath, [HOOK, 'Stop'], {
      input: JSON.stringify({ session_id: 'abc', hook_event_name: 'Stop', stop_hook_active: false }),
      encoding: 'utf8', env: { ...process.env, TETHER_HOME: home, TETHER_SLOT_ID: 'slot1' }, timeout: 20_000,
    })
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
    const report = parseAttentionReport(readFileSync(join(home, 'slots', 'slot1.attention'), 'utf8'))
    assert.equal(report?.kind, 'done')
    assert.equal(report?.sessionId, 'abc')
    assert.ok(!existsSync(join(home, 'slots', 'slot1.jsonl')))
  })
})
