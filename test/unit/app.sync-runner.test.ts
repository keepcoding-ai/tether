// The app's sync runner (app/main/sync-runner.ts): one cycle at a time, the renderer's saves held while the child runs, the
// debounce after changes, echoes that do not feed back, the child's deadline, the bounded wait at open, the detached push at exit.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, test } from 'node:test'
import {
  CHANGE_DEBOUNCE_MS, CHILD_TIMEOUT_MS, ECHO_MS, FLUSH_WAIT_MS, OPEN_WAIT_MS, PERIODIC_MS, SYNC_ARGS, SYNC_EXIT_ARGS,
  SyncRunner, rendererLayoutFlusher, withoutUrls, type ChildLike, type Clock, type SyncRunnerDeps,
} from '../../app/main/sync-runner.ts'

const tick = async (n = 10): Promise<void> => { for (let i = 0; i < n; i++) await new Promise<void>(r => setImmediate(r)) }

class FakeClock implements Clock {
  t = 1_000_000
  private seq = 0
  timers = new Map<number, { at: number; fn: () => void }>()
  now(): number { return this.t }
  setTimeout(fn: () => void, ms: number): unknown { const id = ++this.seq; this.timers.set(id, { at: this.t + ms, fn }); return id }
  clearTimeout(h: unknown): void { this.timers.delete(h as number) }
  async advance(ms: number): Promise<void> {
    const end = this.t + ms
    for (;;) {
      await tick()
      const due = [...this.timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      this.timers.delete(due[0])
      this.t = Math.max(this.t, due[1].at)
      due[1].fn()
    }
    this.t = end
    await tick()
  }
}

class FakeChild extends EventEmitter implements ChildLike {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  unrefed = false
  readonly pid: number
  readonly args: readonly string[]
  readonly detached: boolean
  constructor(pid: number, args: readonly string[], detached: boolean) { super(); this.pid = pid; this.args = args; this.detached = detached }
  unref(): void { this.unrefed = true }
  /** Ends like `tether sync now --json` does. */
  finish(applied: Record<string, boolean> = {}, ok = true): void {
    this.stdout.emit('data', JSON.stringify({ at: new Date().toISOString(), ok, ...(ok ? {} : { error: { code: 'network', message: 'falhou em https://x.test/r.git' } }), report: ok ? { applied } : null }))
    this.emit('close', ok ? 0 : 1)
  }
}

function harness(opts: { configured?: boolean; flushAnswers?: boolean } = {}, override: (runner: () => SyncRunner) => Partial<SyncRunnerDeps> = () => ({})) {
  const clock = new FakeClock()
  const children: FakeChild[] = []
  const written: unknown[] = []
  const killed: number[] = []
  const logs: string[] = []
  const lasts: unknown[] = []
  let reloads = 0
  let flushes = 0
  let configured = opts.configured ?? true
  let configChecks = 0
  const deps: SyncRunnerDeps = {
    configExists: async () => { configChecks++; return configured },
    spawnChild: (args, detached) => { const c = new FakeChild(100 + children.length, args, detached); children.push(c); return c },
    kill: async pid => { killed.push(pid); return null },
    flushLayout: () => { flushes++; return opts.flushAnswers === false ? new Promise(() => {}) : Promise.resolve() },
    writeLayout: async l => { written.push(l) },
    reload: () => { reloads++ },
    writeLast: async l => { lasts.push(l) },
    log: l => logs.push(l),
    clock,
  }
  const runner: SyncRunner = new SyncRunner({ ...deps, ...override(() => runner) })
  return {
    runner, clock, children, written, killed, logs, lasts,
    get reloads() { return reloads }, get flushes() { return flushes }, get configChecks() { return configChecks },
    setConfigured: (v: boolean) => { configured = v },
    childNow: async () => { await tick(); const c = children.at(-1); assert.ok(c, 'a child was started'); return c },
  }
}

describe('sync runner: the cycle', () => {
  test('one cycle at a time: requests during a cycle merge into ONE next cycle', async () => {
    const h = harness()
    const first = h.runner.run('link')
    const c1 = await h.childNow()
    assert.deepEqual(c1.args, SYNC_ARGS)
    assert.equal(c1.detached, false)
    assert.equal(h.runner.state().running, true)
    const a = h.runner.run('link')
    const b = h.runner.run('mudança')
    assert.equal(a, b, 'the two requests share the following cycle')
    assert.equal(h.children.length, 1, 'no second child while the first runs')
    c1.finish()
    assert.equal((await first)?.ok, true)
    const c2 = await h.childNow()
    assert.equal(h.children.length, 2)
    c2.finish()
    const r = await a
    assert.equal(r?.ok, true)
    assert.equal(r?.reason, 'link', 'the first request names the merged cycle')
    await tick()
    assert.equal(h.children.length, 2)
    assert.equal(h.runner.state().running, false)
    assert.equal(h.flushes, 2, 'each cycle asks the renderer to save first')
  })

  test('without sync.json nothing starts: one existence check and no child, no flush', async () => {
    const h = harness({ configured: false })
    assert.equal(await h.runner.run('periódico'), undefined)
    h.runner.changed('layout')
    await h.clock.advance(CHANGE_DEBOUNCE_MS)
    assert.equal(h.children.length, 0)
    assert.equal(h.flushes, 0)
    assert.equal(h.configChecks, 2)
    assert.deepEqual(h.runner.state(), { connected: false, running: false, last: null })
    assert.equal(h.runner.pushOnExit(), false)
    assert.equal(h.children.length, 0)
  })

  test('hold: saves during the child are kept (only the last) and written when the arrangement was not applied', async () => {
    const h = harness()
    const p = h.runner.run('link')
    const c = await h.childNow()
    await h.runner.saveLayout({ n: 1 })
    await h.runner.saveLayout({ n: 2 })
    assert.deepEqual(h.written, [], 'nothing reaches the disk while the child runs')
    c.finish({ settings: true })
    await p
    assert.deepEqual(h.written, [{ n: 2 }])
    assert.equal(h.reloads, 0)
  })

  test('hold: the arrangement applied by the child drops the held save and reloads the window', async () => {
    const h = harness()
    const p = h.runner.run('link')
    const c = await h.childNow()
    await h.runner.saveLayout({ n: 1 })
    c.finish({ layout: true })
    const r = await p
    assert.equal(r?.report?.applied?.layout, true)
    assert.deepEqual(h.written, [])
    assert.equal(h.reloads, 1)
    assert.ok(h.logs.some(l => l.includes('descartada')))
  })

  test('the flush\'s own save is written at once and is not a change', async () => {
    // The renderer answers the flush by saving (preload: the answer goes after saveLayout resolved).
    const h = harness({}, runner => ({ flushLayout: () => runner().saveLayout({ flushed: true }) }))
    const p = h.runner.run('link')
    const c = await h.childNow()
    assert.deepEqual(h.written, [{ flushed: true }], 'written before the child starts, not held')
    c.finish()
    await p
    await h.clock.advance(CHANGE_DEBOUNCE_MS + 1)
    assert.equal(h.children.length, 1, 'no cycle fed by the flush save')
    assert.equal(h.runner.pushOnExit(), false, 'nor a pending change at exit')
  })

  test('a renderer that never answers the flush delays the cycle by at most FLUSH_WAIT_MS', async () => {
    const h = harness({ flushAnswers: false })
    const p = h.runner.run('link')
    await tick()
    assert.equal(h.children.length, 0)
    await h.clock.advance(FLUSH_WAIT_MS)
    const c = await h.childNow()
    c.finish()
    assert.equal((await p)?.ok, true)
  })

  test('a child past its deadline is killed by pid and the failure is recorded (and left for a waiting terminal)', async () => {
    const h = harness()
    const p = h.runner.run('link')
    const c = await h.childNow()
    await h.runner.saveLayout({ held: true })
    await h.clock.advance(CHILD_TIMEOUT_MS)
    const r = await p
    assert.deepEqual(h.killed, [c.pid])
    assert.equal(r?.ok, false)
    assert.equal(r?.error?.code, 'timeout')
    assert.equal(h.runner.state().last?.error?.code, 'timeout')
    assert.equal(h.runner.state().running, false)
    assert.deepEqual(h.written, [{ held: true }], 'the hold is released even on failure')
    assert.equal(h.lasts.length, 1)
  })

  test('a failing child does not throw: logged without its URL, kept in memory; the child wrote its own sync-last.json', async () => {
    const h = harness()
    const p = h.runner.run('periódico')
    const c = await h.childNow()
    c.finish({}, false)
    const r = await p
    assert.equal(r?.ok, false)
    assert.equal(r?.error?.code, 'network')
    const line = h.logs.find(l => l.startsWith('sync: periódico: falhou'))
    assert.ok(line)
    assert.ok(!line.includes('https://'), line)
    assert.equal(h.lasts.length, 0)
  })

  test('a child that cannot start (no node) is a failure, not an exception', async () => {
    const h = harness({}, () => ({ spawnChild: () => { throw new Error('não encontrei o node') } }))
    const r = await h.runner.run('link')
    assert.equal(r?.ok, false)
    assert.equal(r?.error?.code, 'spawn')
  })

  test('stdout without a report (a lock held elsewhere): the stderr line is the message', async () => {
    const h = harness()
    const p = h.runner.run('link')
    const c = await h.childNow()
    c.stderr.emit('data', 'tether: outra sincronização está em curso\n')
    c.emit('close', 1)
    const r = await p
    assert.equal(r?.error?.code, 'child')
    assert.equal(r?.error?.message, 'outra sincronização está em curso')
  })
})

describe('sync runner: when it runs', () => {
  test('debounce: one cycle CHANGE_DEBOUNCE_MS after the LAST change', async () => {
    const h = harness()
    await h.runner.saveLayout({ a: 1 })
    await h.clock.advance(20_000)
    h.runner.changed('profiles')
    await h.clock.advance(20_000)
    assert.equal(h.children.length, 0, 'the second change pushed the cycle back')
    h.runner.settingsChanged(['window'])
    await h.clock.advance(CHANGE_DEBOUNCE_MS - 20_000)
    const c = await h.childNow()
    assert.equal(h.children.length, 1)
    c.finish()
    await tick()
    assert.equal(h.runner.state().last?.reason, 'mudança')
  })

  test('machine-local settings (window geometry) never schedule a cycle', async () => {
    const h = harness()
    h.runner.settingsChanged(['window', 'trayNoticeShown', 'extensionState.x'])
    await h.clock.advance(CHANGE_DEBOUNCE_MS * 2)
    assert.equal(h.children.length, 0)
    h.runner.settingsChanged(['window', 'theme'])
    await h.clock.advance(CHANGE_DEBOUNCE_MS)
    assert.equal(h.children.length, 1)
  })

  test('echo: what the child wrote (settings, keybindings, the reloaded arrangement) does not feed a new cycle', async () => {
    const h = harness()
    const p = h.runner.run('periódico')
    const c = await h.childNow()
    h.runner.settingsChanged(['theme']) // the watcher saw the child's write while it ran
    c.finish({ settings: true, keybindings: true, layout: true })
    await p
    h.runner.settingsChanged(['theme']) // ... or right after
    h.runner.changed('keybindings')
    await h.runner.saveLayout({ reloaded: true })
    await h.clock.advance(CHANGE_DEBOUNCE_MS * 2)
    assert.equal(h.children.length, 1, 'no cycle fed by its own writes')
    // After the echo window, a change is a change again.
    await h.clock.advance(ECHO_MS)
    h.runner.changed('settings')
    await h.clock.advance(CHANGE_DEBOUNCE_MS)
    assert.equal(h.children.length, 2)
  })

  test('a change of a kind the cycle did NOT apply, made while it ran, schedules the next cycle', async () => {
    const h = harness()
    const p = h.runner.run('periódico')
    const c = await h.childNow()
    h.runner.changed('profiles')
    c.finish({ settings: true })
    await p
    await h.clock.advance(CHANGE_DEBOUNCE_MS)
    assert.equal(h.children.length, 2)
  })

  test('periodic: every PERIODIC_MS after open', async () => {
    const h = harness()
    const open = h.runner.atOpen()
    ;(await h.childNow()).finish()
    assert.equal(await open, 'done')
    await h.clock.advance(PERIODIC_MS)
    ;(await h.childNow()).finish()
    await h.clock.advance(PERIODIC_MS)
    ;(await h.childNow()).finish()
    assert.equal(h.children.length, 3)
    assert.equal(h.runner.state().last?.reason, 'periódico')
  })

  test('open: the window waits at most OPEN_WAIT_MS; the cycle goes on and reloads if it applied the arrangement', async () => {
    const h = harness()
    const open = h.runner.atOpen()
    const c = await h.childNow()
    await h.clock.advance(OPEN_WAIT_MS)
    assert.equal(await open, 'timeout')
    assert.equal(h.runner.state().running, true)
    c.finish({ layout: true })
    await tick()
    assert.equal(h.reloads, 1)
    assert.equal(h.runner.state().running, false)
  })

  test('open without sync.json returns at once', async () => {
    const h = harness({ configured: false })
    assert.equal(await h.runner.atOpen(), 'done')
    assert.equal(h.children.length, 0)
  })
})

describe('sync runner: exit', () => {
  test('nothing changed since the last good cycle: no child at exit', async () => {
    const h = harness()
    const p = h.runner.run('abertura')
    ;(await h.childNow()).finish()
    await p
    assert.equal(h.runner.pushOnExit(), false)
    assert.equal(h.children.length, 1)
  })

  test('a change since the last good cycle: a detached child, unref\'d, not waited for; no more cycles afterwards', async () => {
    const h = harness()
    const p = h.runner.run('abertura')
    ;(await h.childNow()).finish()
    await p
    await h.runner.saveLayout({ moved: true })
    h.runner.stop()
    assert.equal(h.runner.pushOnExit(), true)
    const c = h.children.at(-1)!
    assert.deepEqual(c.args, SYNC_EXIT_ARGS)
    assert.equal(c.detached, true)
    assert.equal(c.unrefed, true)
    assert.equal(h.runner.pushOnExit(), false, 'once')
    await h.clock.advance(PERIODIC_MS + CHANGE_DEBOUNCE_MS)
    assert.equal(h.children.length, 2)
  })

  test('a failed last cycle leaves the change pending for the exit push', async () => {
    const h = harness()
    await h.runner.saveLayout({ moved: true })
    const p = h.runner.run('link')
    ;(await h.childNow()).finish({}, false)
    await p
    assert.equal(h.runner.pushOnExit(), true)
  })

  test('stop during a cycle writes the held save (the person\'s latest arrangement is not lost)', async () => {
    const h = harness()
    void h.runner.run('link')
    await h.childNow()
    await h.runner.saveLayout({ last: true })
    h.runner.stop()
    await tick()
    assert.deepEqual(h.written, [{ last: true }])
  })
})

describe('sync runner: helpers', () => {
  test('withoutUrls cuts URLs and scp-like remotes', () => {
    assert.equal(withoutUrls('falhou em https://user:tok@x.test/r.git agora'), 'falhou em <url> agora')
    assert.equal(withoutUrls('git@github.com:me/repo.git recusou'), '<url> recusou')
  })

  test('rendererLayoutFlusher: answered by id, false without a window or an answer', async () => {
    const ipc = new EventEmitter()
    let sent: number | undefined
    const win = { send: (_ch: string, id: number) => { sent = id } }
    let target: typeof win | undefined = win
    const flush = rendererLayoutFlusher({ on: (ch, fn) => ipc.on(ch, fn) }, () => target, 30)
    const p = flush()
    assert.equal(typeof sent, 'number')
    ipc.emit('tether:layout-flushed', {}, sent)
    assert.equal(await p, true)
    assert.equal(await flush(), false, 'no answer: false after the wait')
    target = undefined
    assert.equal(await flush(), false)
  })
})
