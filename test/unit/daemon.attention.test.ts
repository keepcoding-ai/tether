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

describe('attention: a pending waiting survives focus', () => {
  const mk = () => new AttentionState(attentionOptions('claude'))
  test('seen leaves a pending waiting; the owner force clears it', () => {
    const a = mk()
    a.hook('waiting', 'permission_prompt')
    assert.equal(a.seen(), false)
    assert.equal(a.value, 'waiting')
    assert.equal(a.seen(true), true)
    assert.equal(a.value, undefined)
    assert.equal(a.pending, false)
  })
  test('a pending waiting falls on input, start, done and reset', () => {
    for (const end of [(a: AttentionState) => a.input('x'), (a: AttentionState) => a.hook('start'), (a: AttentionState) => a.hook('done'), (a: AttentionState) => a.reset()]) {
      const a = mk()
      a.hook('waiting', 'elicitation_dialog')
      assert.equal(end(a), true)
      assert.equal(a.value === 'done' ? 'done' : a.value, a.value)
      assert.equal(a.pending, false)
      a.hook('waiting', 'idle_prompt')
      assert.equal(a.seen(), true, 'a later idle wait is not pending')
    }
  })
  test('idle_prompt, no reason and BEL are not pending; idle_prompt does not downgrade a pending one', () => {
    const a = mk()
    a.hook('waiting', 'idle_prompt')
    assert.equal(a.pending, false)
    a.hook('waiting')
    assert.equal(a.pending, false)
    assert.equal(a.seen(), true)
    const s = new AttentionState({ idle: false, bel: true })
    s.output('', 0)
    assert.equal(s.value, 'waiting')
    assert.equal(s.pending, false)
    assert.equal(s.seen(), true)
    a.hook('waiting', 'permission_prompt')
    assert.equal(a.hook('waiting', 'idle_prompt'), false)
    assert.equal(a.pending, true)
    assert.equal(a.seen(), false)
  })
  test('a lone ESC clears done and a pending waiting without touching the turn; sequences do nothing', () => {
    const a = mk()
    a.hook('done')
    assert.equal(a.input('\x1b'), true)
    assert.equal(a.value, undefined)
    a.hook('waiting', 'permission_prompt')
    const turn = a.turn
    assert.equal(a.input('\x1b'), true)
    assert.equal(a.value, undefined)
    assert.equal(a.pending, false)
    assert.equal(a.turn, turn)
    a.hook('waiting', 'permission_prompt')
    assert.equal(a.input('\x1b[I'), false)
    assert.equal(a.input('\x1b[A'), false)
    assert.equal(a.value, 'waiting')
  })
  test('parseAttentionReport carries reason when present', () => {
    assert.equal(parseAttentionReport('{"ts":"x","kind":"waiting","reason":"permission_prompt"}')?.reason, 'permission_prompt')
    assert.deepEqual(parseAttentionReport('{"ts":"x","kind":"waiting"}'), { ts: 'x', kind: 'waiting' })
  })
})

describe('attention: marked unread (defer)', () => {
  const mk = () => new AttentionState(attentionOptions('claude'))
  test('from nothing it shows done; done and waiting keep their value; all are pending', () => {
    const a = mk()
    assert.equal(a.defer(), true)
    assert.equal([a.value, a.pending].join(), 'done,true')
    assert.equal(a.defer(), false, 'again: nothing changed')
    const d = mk(); d.hook('done')
    assert.equal(d.defer(), true)
    assert.equal([d.value, d.pending].join(), 'done,true')
    const w = mk(); w.hook('waiting', 'idle_prompt')
    assert.equal(w.defer(), true)
    assert.equal([w.value, w.pending].join(), 'waiting,true')
  })
  test('does not touch the turn', () => {
    const a = mk(); a.hook('start')
    a.defer()
    assert.equal(a.turn, 'busy')
  })
  test('focus does not clear it; the owner force does', () => {
    const a = mk(); a.defer()
    assert.equal(a.seen(), false)
    assert.equal(a.value, 'done')
    assert.equal(a.seen(true), true)
    assert.equal([a.value, a.pending].join(), ',false')
  })
  test('falls on input, a lone ESC, start and reset', () => {
    for (const end of [(a: AttentionState) => a.input('x'), (a: AttentionState) => a.input(''), (a: AttentionState) => a.hook('start'), (a: AttentionState) => a.reset()]) {
      const a = mk(); a.defer()
      assert.equal(end(a), true)
      assert.equal([a.value, a.pending].join(), ',false')
    }
  })
  test('a new done is an ordinary notice: done without pending, and focus clears it', () => {
    const a = mk(); a.defer()
    assert.equal(a.hook('done'), true, 'pending dropped counts as a change')
    assert.equal([a.value, a.pending].join(), 'done,false')
    assert.equal(a.seen(), true)
    assert.equal(a.value, undefined)
  })
  test('idle_prompt and BEL do not downgrade it; permission_prompt turns it into a pending waiting', () => {
    const a = mk(); a.defer()
    assert.equal(a.hook('waiting', 'idle_prompt'), false)
    assert.equal([a.value, a.pending].join(), 'done,true')
    const s = new AttentionState(attentionOptions('shell')); s.defer()
    assert.equal(s.output('', 0), false)
    assert.equal([s.value, s.pending].join(), 'done,true')
    assert.equal(a.hook('waiting', 'permission_prompt'), true)
    assert.equal([a.value, a.pending].join(), 'waiting,true')
  })
})

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

describe('attention: a new turn voids the previous attention', () => {
  test('claude: done then start clears it and the turn is busy', () => {
    const a = new AttentionState(attentionOptions('claude'))
    a.hook('done')
    assert.equal(a.hook('start'), true)
    assert.equal(a.value, undefined)
    assert.equal(a.turn, 'busy')
  })
  test('claude: waiting during the turn stands; the next start clears it', () => {
    const a = new AttentionState(attentionOptions('claude'))
    a.hook('start')
    a.hook('waiting')
    assert.equal(a.value, 'waiting')
    assert.equal(a.turn, 'busy')
    a.hook('start')
    assert.equal(a.value, undefined)
  })
  test('soul: signal busy clears a previous done', () => {
    const a = new AttentionState(attentionOptions('soul'))
    a.signal('busy'); a.signal('idle')
    assert.equal(a.value, 'done')
    assert.equal(a.signal('busy'), true)
    assert.equal(a.value, undefined)
    assert.equal(a.turn, 'busy')
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
    assert.deepEqual(toAttention('Notification', perm, ts), { ts, kind: 'waiting', sessionId: 'abc', reason: 'permission_prompt' })
    assert.equal(toAttention('Notification', { ...perm, notification_type: 'idle_prompt' }, ts)?.reason, 'idle_prompt')
    assert.equal(toAttention('Notification', { ...perm, notification_type: '' }, ts)?.reason, undefined)
    assert.equal(toAttention('UserPromptSubmit', { session_id: 'abc', notification_type: 'x' }, ts)?.reason, undefined)
    assert.deepEqual(toAttention('Notification', { message: 'x' }, ts), { ts, kind: 'waiting' }, 'older Claude without notification_type')
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

describe('attention: idleSince', () => {
  test('never changed: absent (the daemon falls back to spawn time / last event)', () => {
    assert.equal(new AttentionState(attentionOptions('claude')).idleSince, undefined)
  })
  test('start: absent; done: set to now; the next start clears it', () => {
    const a = new AttentionState(attentionOptions('claude'))
    a.hook('start')
    assert.equal(a.idleSince, undefined)
    const before = Date.now()
    a.hook('done')
    assert.ok(a.idleSince && Date.parse(a.idleSince) >= before - 5 && Date.parse(a.idleSince) <= Date.now() + 5)
    a.hook('start')
    assert.equal(a.idleSince, undefined)
  })
  test('signal idle sets it; reset sets it even when already idle', () => {
    const a = new AttentionState(attentionOptions('soul'))
    a.signal('busy')
    assert.equal(a.idleSince, undefined)
    a.signal('idle')
    assert.ok(a.idleSince)
    const b = new AttentionState(attentionOptions('claude'))
    b.reset()
    assert.ok(b.idleSince)
  })
})
