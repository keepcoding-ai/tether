// The browser process lives on demand: not started with the app, started by the first need (a tab to restore, an agent's call),
// asked to quit when it has served nothing for a while, started again by the next need. The idle quit is not a crash.
// BrowserLife (lazy-life.ts) is tested with a manual clock; process-host.ts itself runs against a stand-in process
// (support/fake-browser-child.cjs) that speaks the real line, with 'electron' replaced by a stub.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserLife, IDLE_STOP_MS, type Timers } from '../../extensions/browser/lazy-life.ts'
import { endpointUp, isToolCallLine, requestWake, serveWake, toolCallGate, wakePipeOf } from '../../extensions/browser/wake.ts'

/** A clock the test turns by hand. */
function clock(): Timers & { advance(ms: number): void } {
  let now = 0
  let next = 1
  const pending = new Map<number, { at: number; fn: () => void }>()
  return {
    set: (fn, ms) => { const id = next++; pending.set(id, { at: now + ms, fn }); return id },
    clear: h => { pending.delete(h as number) },
    advance(ms) {
      const to = now + ms
      for (;;) {
        const due = [...pending.entries()].filter(([, p]) => p.at <= to).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        pending.delete(due[0]); now = due[1].at; due[1].fn()
      }
      now = to
    },
  }
}

function life(o: { busy?: () => number } = {}): { life: BrowserLife<string>; timers: ReturnType<typeof clock>; quits: string[]; kills: string[] } {
  const timers = clock()
  const quits: string[] = []
  const kills: string[] = []
  const l = new BrowserLife<string>({ busy: o.busy ?? (() => 0), quit: p => quits.push(p), kill: p => kills.push(p), log: () => {}, timers, idleMs: IDLE_STOP_MS, quitGraceMs: 5_000 })
  return { life: l, timers, quits, kills }
}

test('BrowserLife: the idle clock runs only while the process is up and nothing keeps it busy', () => {
  let busy = 1
  const t = life({ busy: () => busy })
  t.life.touch()
  t.timers.advance(IDLE_STOP_MS * 2)
  assert.deepEqual(t.quits, [], 'no process: nothing to quit')
  t.life.began('p1')
  t.life.touch()
  t.timers.advance(IDLE_STOP_MS * 2)
  assert.deepEqual(t.quits, [], 'a live tab keeps it')
  busy = 0
  t.life.changed()
  t.timers.advance(IDLE_STOP_MS - 1)
  assert.deepEqual(t.quits, [])
  t.timers.advance(1)
  assert.deepEqual(t.quits, ['p1'], 'quits after the idle time')
})

test('BrowserLife: a tab arriving or a need served before the time cancels and restarts it', () => {
  let busy = 0
  const t = life({ busy: () => busy })
  t.life.began('p1')
  t.life.touch()
  t.timers.advance(IDLE_STOP_MS - 10)
  busy = 1; t.life.changed()
  t.timers.advance(IDLE_STOP_MS)
  assert.deepEqual(t.quits, [])
  busy = 0; t.life.changed()
  t.timers.advance(IDLE_STOP_MS - 10)
  t.life.touch()
  t.timers.advance(IDLE_STOP_MS - 10)
  assert.deepEqual(t.quits, [], 'touch restarted the clock')
  t.timers.advance(10)
  assert.deepEqual(t.quits, ['p1'])
})

test('BrowserLife: the idle quit is not a crash and does not hold agents back; a surprise exit is and does', () => {
  const t = life()
  t.life.began('p1')
  t.life.touch()
  t.timers.advance(IDLE_STOP_MS)
  assert.equal(t.life.ended('p1'), 'idle')
  assert.equal(t.life.permits('agent'), true)
  t.life.began('p2')
  assert.equal(t.life.ended('p2'), 'crash')
  assert.equal(t.life.permits('agent'), false, 'after a crash an agent does not restart it')
  assert.equal(t.life.permits('person'), true, 'the person does')
  assert.equal(t.life.permits('agent'), true, 'and her need lifts the hold')
})

test('BrowserLife: keepUp holds the process even when idle', () => {
  let keep = true
  const timers = clock()
  const quits: string[] = []
  const l = new BrowserLife<string>({ busy: () => 0, keepUp: () => keep, quit: p => quits.push(p), kill: () => {}, log: () => {}, timers, idleMs: 100 })
  l.began('p1')
  l.touch()
  timers.advance(1_000)
  assert.deepEqual(quits, [])
  keep = false
  l.touch()
  timers.advance(100)
  assert.deepEqual(quits, ['p1'])
})

test('BrowserLife: a need during the quit waits for it; a quit that hangs is killed and is still an idle exit', async () => {
  const t = life()
  t.life.began('p1')
  t.life.touch()
  t.timers.advance(IDLE_STOP_MS)
  let settled = false
  void t.life.settled().then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false)
  t.timers.advance(5_000)
  assert.deepEqual(t.kills, ['p1'])
  assert.equal(t.life.ended('p1'), 'idle')
  await t.life.settled()
  assert.equal(settled, true)
})

test('tool call gate: only tools/call waits for the wake, and the order is kept', async () => {
  assert.equal(isToolCallLine('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{}}'), true)
  assert.equal(isToolCallLine('{"jsonrpc":"2.0","id":1,"method":"tools/list"}'), false)
  assert.equal(isToolCallLine('not json tools/call'), false)
  let release!: () => void
  const wakes: string[] = []
  const gate = toolCallGate(() => { wakes.push('wake'); return new Promise<void>(r => { release = r }) })
  const seen: string[] = []
  const deliver = (m: unknown): void => { seen.push((m as { id: string }).id) }
  gate.push({ id: 'list', method: 'tools/list' }, undefined, deliver)
  gate.push({ id: 'call', method: 'tools/call' }, undefined, deliver)
  gate.push({ id: 'ping', method: 'ping' }, undefined, deliver)
  assert.deepEqual(seen, ['list'], 'before the call: at once; after it: behind it')
  await new Promise(r => setTimeout(r, 5))
  release()
  await new Promise(r => setTimeout(r, 10))
  assert.deepEqual(seen, ['list', 'call', 'ping'])
  assert.deepEqual(wakes, ['wake'])
})

test('wake pipe: the answer comes once the process is up and its endpoint written; nobody listening is a plain no', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tether-wake-'))
  const endpoint = join(home, 'browser', 'endpoint.json')
  assert.equal(await requestWake(endpoint, 500), false, 'no app')
  mkdirSync(join(home, 'browser'), { recursive: true })
  const brought: number[] = []
  const server = serveWake(endpoint, async () => { brought.push(1); return process.pid }, { log: () => {}, endpointWaitMs: 300, pollMs: 10 })
  try {
    await new Promise(r => setTimeout(r, 50))
    assert.equal(await requestWake(endpoint, 2000), false, 'the process is up but no endpoint of its pid yet')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(endpoint, JSON.stringify({ v: 1, port: 1, pid: process.pid, instance: 'x' }))
    assert.equal(await endpointUp(endpoint, process.pid), true)
    assert.equal(await requestWake(endpoint, 2000), true)
    assert.equal(brought.length, 2)
  } finally { server.close(); rmSync(home, { recursive: true, force: true }) }
  assert.notEqual(wakePipeOf(endpoint), wakePipeOf(join(home, 'other', 'endpoint.json')))
})

// ---- process-host.ts against a stand-in process ----

type Handler = (...args: unknown[]) => unknown
interface Rig {
  home: string
  handlers: Map<string, Handler>
  sent: Array<{ channel: string; args: unknown[] }>
  logs: string[]
  endpoint: string
  pid(): number | undefined
  dispose(): void
}

const stub = pathToFileURL(join(import.meta.dirname, 'support', 'electron-stub.ts')).href
registerHooks({ resolve: (specifier, context, next) => (specifier === 'electron' ? { url: stub, shortCircuit: true } : next(specifier, context)) })

async function rig(idleMs: number, persistentLogins = true): Promise<Rig> {
  const { activateRemote } = await import('../../extensions/browser/process-host.ts')
  const home = mkdtempSync(join(tmpdir(), 'tether-lazy-'))
  const dist = mkdtempSync(join(tmpdir(), 'tether-lazy-dist-'))
  const { copyFileSync } = await import('node:fs')
  copyFileSync(join(import.meta.dirname, 'support', 'fake-browser-child.cjs'), join(dist, 'browser-child.cjs'))
  process.env.FAKE_WIRE_URL = pathToFileURL(join(import.meta.dirname, '..', '..', 'app', 'main', 'browser-wire.ts')).href
  const handlers = new Map<string, Handler>()
  const sent: Rig['sent'] = []
  const logs: string[] = []
  const none = { dispose() {} }
  const ipc = { handle: (c: string, fn: Handler) => { handlers.set(c, fn); return none }, on: () => none, send: (channel: string, ...args: unknown[]) => { sent.push({ channel, args }) } }
  const main = {
    id: 'browser', brand: {}, home, userDir: home, dist,
    ipc: () => ipc,
    settings: { get: () => undefined, set() {}, isSet: () => false, onChange: () => none },
    state: { get: () => undefined, update() {} },
    window: { current: () => undefined },
    surfaces: { forwardTo: () => none },
    agents: { list: () => [], get: () => undefined, onDidChange: () => none, onDidExit: () => none, onDidRemove: () => none },
    notices: { raise: () => ({ update() {}, resolve() {}, dispose() {} }) },
    shell: { trash: async () => {} },
    log: (m: string) => { logs.push(m) },
  }
  const subs = activateRemote(main as never, { idleMs, quitGraceMs: 2_000, persistentLogins: async () => persistentLogins })
  const proc = (): { pid(): number | undefined } => (globalThis as unknown as { __browserProcess: { pid(): number | undefined } }).__browserProcess
  return {
    home, handlers, sent, logs, endpoint: join(home, 'browser', 'endpoint.json'),
    pid: () => proc().pid(),
    dispose: () => { const p = proc().pid(); for (const s of subs) s.dispose(); if (p) { try { process.kill(p) } catch { /* gone */ } } rmSync(home, { recursive: true, force: true }); rmSync(dist, { recursive: true, force: true }) },
  }
}

async function until(what: string, ok: () => boolean, ms = 8_000): Promise<void> {
  const end = Date.now() + ms
  while (!ok()) { if (Date.now() > end) throw new Error(`timeout: ${what}`); await new Promise(r => setTimeout(r, 25)) }
}

test('process-host: nothing starts with the app; the first need starts it, idle without tabs ends it cleanly, the next need starts it again', { skip: process.platform !== 'win32', timeout: 60_000 }, async () => {
  const r = await rig(400)
  try {
    // Activation: no process, and the queries the interface makes at start are answered without one.
    await new Promise(res => setTimeout(res, 300))
    assert.equal(r.pid(), undefined, 'not launched at activation')
    assert.deepEqual(await r.handlers.get('list')!(), [])
    assert.deepEqual(await r.handlers.get('closedList')!(), [])
    assert.deepEqual(await r.handlers.get('downloads')!(), [])
    assert.equal(typeof ((await r.handlers.get('status')!()) as { persistentLogins: boolean }).persistentLogins, 'boolean')
    assert.equal(r.pid(), undefined, 'the start-up queries do not wake it')

    // First need: a tab restored from the last session.
    const info = await r.handlers.get('restore')!({ tabId: 'tab1', url: 'http://example.test/', ownerSlotId: 'slot1' }) as { tabId: string }
    assert.equal(info.tabId, 'tab1')
    const first = r.pid()
    assert.ok(first, 'started by the first need')
    await until('tab event reached the interface', () => r.sent.some(e => e.channel === 'tab'))

    // A tab is open: it stays up well past the idle time.
    await new Promise(res => setTimeout(res, 900))
    assert.equal(r.pid(), first, 'a live tab keeps it')

    // The last tab closes: idle, then it leaves, cleanly.
    await r.handlers.get('close')!('tab1', 'user')
    await until('idle exit', () => r.pid() === undefined)
    assert.equal(existsSync(r.endpoint), false, 'the endpoint went with it')
    assert.ok(r.logs.some(l => l.includes('encerrado por ociosidade')))
    assert.ok(r.logs.some(l => l.includes('encerrado (ocioso)')))
    assert.ok(!r.logs.some(l => l.includes('processo do navegador parou')), 'not treated as a crash')
    assert.ok(!r.sent.some(e => e.channel === 'tab' && (e.args[0] as { crashed?: string }).crashed), 'no tab was shown crashed')

    // The next need starts it again: an agent's call (the wake pipe) now, as an agent does.
    assert.equal(await requestWake(r.endpoint, 10_000), true)
    const second = r.pid()
    assert.ok(second && second !== first, 'a new process')
    assert.equal(await endpointUp(r.endpoint, second), true)
  } finally { r.dispose() }
})

test('process-host: without persistent logins (no fuse) the process stays up once started; with them it leaves', { skip: process.platform !== 'win32', timeout: 60_000 }, async () => {
  const r = await rig(300, false)
  try {
    assert.equal(await requestWake(r.endpoint, 10_000), true, 'still starts on demand')
    const pid = r.pid()
    assert.ok(pid)
    await new Promise(res => setTimeout(res, 1_200))
    assert.equal(r.pid(), pid, 'idle, but its logins live only in its memory: it stays')
    assert.ok(!r.logs.some(l => l.includes('ociosidade')))
  } finally { r.dispose() }
  // With the fuse on (the other tests' rig) the same idle time ends it: see the first host test.
})

test('process-host: a question waiting for the person keeps the process; a crash holds agents back until the person acts', { skip: process.platform !== 'win32', timeout: 60_000 }, async () => {
  const r = await rig(300)
  try {
    assert.equal(await requestWake(r.endpoint, 10_000), true, 'an agent call starts it')
    const pid = r.pid()!
    const run = (globalThis as unknown as { __browserRun(src: string, arg: unknown): Promise<unknown> }).__browserRun
    await run('', { channel: 'localNetworkAsk', args: [{ id: 'q1' }] })
    await new Promise(res => setTimeout(res, 900))
    assert.equal(r.pid(), pid, 'no tab, but the person has not answered')
    await run('', { channel: 'localNetworkCancelled', args: ['q1'] })
    await until('idle exit after the question went', () => r.pid() === undefined)

    assert.equal(await requestWake(r.endpoint, 10_000), true)
    const victim = r.pid()!
    process.kill(victim)
    await until('crash seen', () => r.pid() === undefined)
    assert.ok(r.logs.some(l => l.includes('processo do navegador parou')), 'this one is a crash')
    assert.equal(await requestWake(r.endpoint, 3_000), false, 'an agent does not restart a crashed browser')
    assert.equal(r.pid(), undefined)
    await r.handlers.get('reopenClosed')!('nothing')
    assert.ok(r.pid(), 'the person\'s action does')
    assert.equal(await requestWake(r.endpoint, 3_000), true, 'and agents are served again')
  } finally { r.dispose() }
})
