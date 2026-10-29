// The Claude hook as Claude runs it: a child `node claude-hook.ts <event>` with the payload on stdin.
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { TetherEvent } from '../../src/core/event.ts'

const HOOK = resolve(import.meta.dirname, '../../src/report/claude-hook.ts')
const CAPTURED = resolve(import.meta.dirname, '../../spike/captured-claude-events.jsonl')

interface Captured {
  slot: string
  event: 'SessionStart' | 'SessionEnd'
  payload: Record<string, unknown>
}

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'tether-hook-'))
}

function runHook(args: string[], stdin: string | undefined, env: Record<string, string | undefined>) {
  return spawnSync(process.execPath, [HOOK, ...args], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, TETHER_HOME: undefined, TETHER_SLOT_ID: undefined, ...env },
    timeout: 20_000,
  })
}

function readEvents(home: string, slot: string): TetherEvent[] {
  const file = join(home, 'slots', `${slot}.jsonl`)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as TetherEvent)
}

describe('claude-hook: captured payloads', () => {
  const captured = readFileSync(CAPTURED, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Captured)
  const home = tmpHome()
  const results: { c: Captured; stdout: string; status: number | null; stderr: string }[] = []

  before(() => {
    for (const c of captured) {
      const r = runHook([c.event], JSON.stringify(c.payload), { TETHER_HOME: home, TETHER_SLOT_ID: c.slot })
      results.push({ c, stdout: r.stdout, status: r.status, stderr: r.stderr })
    }
  })

  test('there are captured payloads of every kind the PRD lists', () => {
    const sources = new Set(captured.filter(c => c.event === 'SessionStart').map(c => c.payload.source))
    const reasons = new Set(captured.filter(c => c.event === 'SessionEnd').map(c => c.payload.reason))
    for (const s of ['startup', 'resume', 'clear', 'compact', 'fork']) assert.ok(sources.has(s), `SessionStart source=${s}`)
    for (const r of ['clear', 'resume', 'prompt_input_exit', 'other']) assert.ok(reasons.has(r), `SessionEnd reason=${r}`)
  })

  test('every run exits 0, prints nothing to stdout and nothing to stderr', () => {
    for (const r of results) {
      assert.equal(r.status, 0, `${r.c.event} ${r.c.payload.source ?? r.c.payload.reason}: ${r.stderr}`)
      assert.equal(r.stdout, '')
      assert.equal(r.stderr, '')
    }
  })

  test('each slot file holds exactly its own events, in order, as v1 events', () => {
    const bySlot = new Map<string, Captured[]>()
    for (const c of captured) bySlot.set(c.slot, [...(bySlot.get(c.slot) ?? []), c])
    assert.ok(bySlot.size >= 3, 'captured data covers several slots')
    for (const [slot, list] of bySlot) {
      const events = readEvents(home, slot)
      assert.equal(events.length, list.length, `slot ${slot}`)
      list.forEach((c, i) => {
        const ev = events[i]!
        const p = c.payload
        assert.equal(ev.v, 1)
        assert.equal(ev.slotId, slot)
        assert.equal(ev.agent, 'claude')
        assert.equal(ev.sessionId, p.session_id)
        assert.equal(ev.cwd, p.cwd)
        assert.deepEqual(ev.raw, p)
        assert.ok(!Number.isNaN(Date.parse(ev.ts)), 'ts is ISO')
        if (c.event === 'SessionStart') {
          assert.equal(ev.kind, 'start')
          assert.equal(ev.source, p.source)
          assert.deepEqual(ev.resume, { cwd: p.cwd, args: ['--resume', p.session_id] })
          if (typeof p.session_title === 'string') assert.equal(ev.title, p.session_title)
        } else {
          assert.equal(ev.kind, 'end')
          assert.equal(ev.source, p.reason)
          assert.equal(ev.resume, undefined)
        }
      })
    }
  })

  test('the clear payload carried a session_title and it became the event title', () => {
    const events = readEvents(home, 'slotI')
    const clear = events.find(e => e.source === 'clear' && e.kind === 'start')
    assert.ok(clear)
    assert.equal(clear.title, 'tether-teste')
  })
})

describe('claude-hook: never breaks Claude', () => {
  const okPayload = JSON.stringify({ session_id: 'abc', cwd: 'D:\\x', hook_event_name: 'SessionStart', source: 'startup' })

  test('garbage stdin: exit 0, no stdout, nothing recorded, a log line', () => {
    const home = tmpHome()
    const r = runHook(['SessionStart'], '{not json', { TETHER_HOME: home, TETHER_SLOT_ID: 's1' })
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
    assert.deepEqual(readEvents(home, 's1'), [])
    assert.match(readFileSync(join(home, 'tether.log'), 'utf8'), /bad stdin/)
  })

  test('empty stdin: exit 0, no stdout', () => {
    const home = tmpHome()
    const r = runHook(['SessionStart'], '', { TETHER_HOME: home, TETHER_SLOT_ID: 's1' })
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
    assert.deepEqual(readEvents(home, 's1'), [])
  })

  test('a JSON array or a payload without session_id is ignored', () => {
    const home = tmpHome()
    for (const input of ['[1,2]', '{"cwd":"x","source":"startup"}', 'null']) {
      const r = runHook(['SessionStart'], input, { TETHER_HOME: home, TETHER_SLOT_ID: 's1' })
      assert.equal(r.status, 0)
      assert.equal(r.stdout, '')
    }
    assert.deepEqual(readEvents(home, 's1'), [])
  })

  test('missing TETHER_SLOT_ID: exit 0 and nothing is written at all', () => {
    const home = tmpHome()
    const r = runHook(['SessionStart'], okPayload, { TETHER_HOME: home })
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
    assert.ok(!existsSync(join(home, 'slots')))
    assert.ok(!existsSync(join(home, 'tether.log')))
  })

  test('unwritable TETHER_HOME (a regular file): exit 0, no stdout', () => {
    const file = join(tmpHome(), 'not-a-dir')
    writeFileSync(file, 'x')
    const r = runHook(['SessionStart'], okPayload, { TETHER_HOME: file, TETHER_SLOT_ID: 's1' })
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
  })

  test('unknown hook name: exit 0, nothing recorded', () => {
    const home = tmpHome()
    const r = runHook(['PreToolUse'], okPayload, { TETHER_HOME: home, TETHER_SLOT_ID: 's1' })
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
    assert.deepEqual(readEvents(home, 's1'), [])
  })

  test('no argv: falls back to hook_event_name from the payload', () => {
    const home = tmpHome()
    const r = runHook([], okPayload, { TETHER_HOME: home, TETHER_SLOT_ID: 's1' })
    assert.equal(r.status, 0)
    const [ev] = readEvents(home, 's1')
    assert.equal(ev?.kind, 'start')
    assert.equal(ev?.sessionId, 'abc')
  })

  test('TETHER_HOME unset: resolves the default home under LOCALAPPDATA on Windows', () => {
    const fakeLocal = tmpHome()
    const r = runHook(['SessionStart'], okPayload, {
      TETHER_SLOT_ID: 's1',
      LOCALAPPDATA: fakeLocal,
      HOME: fakeLocal,
      USERPROFILE: fakeLocal,
      XDG_STATE_HOME: undefined,
    })
    assert.equal(r.status, 0)
    const home = process.platform === 'win32' ? join(fakeLocal, 'tether') : join(fakeLocal, '.local', 'state', 'tether')
    assert.equal(readEvents(home, 's1').length, 1)
  })

  test('stdin that never closes: still exits 0 by itself', async () => {
    const home = tmpHome()
    const started = Date.now()
    const child = spawn(process.execPath, [HOOK, 'SessionStart'], {
      env: { ...process.env, TETHER_HOME: home, TETHER_SLOT_ID: 's1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    child.stdin.write(okPayload) // never ended
    const code = await new Promise<number | null>((res) => child.on('exit', res))
    assert.equal(code, 0)
    assert.equal(stdout, '')
    assert.ok(Date.now() - started < 10_000, 'gave up on stdin on its own')
    // what arrived was recorded anyway
    assert.equal(readEvents(home, 's1').length, 1)
  })
})
