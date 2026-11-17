// PanelRouter (main process): a live hosted pane goes through the link (scrollback, output, keystrokes, resize) and the
// rest through tetherd; output that arrives during a link attach lands after the scrollback, once; a launch seen with
// the window attached is followed from 0; an exit detaches after the grace; a link down drops hosted keystrokes.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { PanelRouter, TERMINAL_RESET, type RouteLink } from '../../app/main/panel-route.ts'
import type { Reply, SlotState } from '../../src/daemon/protocol.ts'
import type { RequestBody } from '../../app/shared/api.ts'

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

function slot(over: Partial<SlotState> = {}): SlotState {
  return { slotId: 's1', kind: 'shell', cwd: 'C:\\', status: 'running', pid: 100, ptyHost: true, ...over } as SlotState
}

class FakeLink implements RouteLink {
  connected = true
  attached = new Map<string, number | undefined>()
  writes: [string, string][] = []
  resizes: [string, number, number][] = []
  detaches: string[] = []
  scrollback = 'RING'
  /** Called after the attach is answered and before it resolves (output arriving meanwhile). */
  during: (() => void) | undefined
  writeOk = true
  has(id: string): boolean { return this.attached.has(id) }
  async attach(id: string, from?: number): Promise<{ scrollback: string }> {
    if (!this.connected) throw new Error('down')
    this.attached.set(id, from)
    await tick()
    this.during?.()
    return { scrollback: this.scrollback }
  }
  async detach(id: string): Promise<void> { this.attached.delete(id); this.detaches.push(id) }
  write(id: string, data: string): boolean { if (this.writeOk) this.writes.push([id, data]); return this.writeOk }
  resize(id: string, cols: number, rows: number): void { this.resizes.push([id, cols, rows]) }
}

function setup(attachReply: (body: RequestBody) => Reply) {
  const link = new FakeLink()
  const out: [string, string][] = []
  const typed: [string, string][] = []
  const requests: RequestBody[] = []
  const timers: (() => void)[] = []
  const logs: string[] = []
  const router = new PanelRouter({
    link,
    daemon: () => ({ typed: (id, d) => typed.push([id, d]) }),
    request: async (body) => { requests.push(body); return body.t === 'attach' ? attachReply(body) : { t: 'ok', id: 1 } },
    emit: (id, d) => out.push([id, d]),
    log: (m) => logs.push(m),
    schedule: (fn) => { timers.push(fn); return () => { const i = timers.indexOf(fn); if (i >= 0) timers.splice(i, 1) } },
  })
  return { link, out, typed, requests, timers, logs, router }
}

const hostedReply = (s = slot()): Reply => ({ t: 'ok', id: 1, slot: s })
const plainReply = (s = slot({ ptyHost: undefined })): Reply => ({ t: 'ok', id: 1, slot: s, scrollback: 'DAEMON' })

describe('PanelRouter', () => {
  test('attach of a live hosted pane: scrollback from the link, then output held meanwhile, exactly once', async () => {
    const t = setup(() => hostedReply())
    t.link.during = () => t.router.onLinkData('s1', '+held')
    const r = await t.router.request({ t: 'attach', slotId: 's1', cols: 80, rows: 24 })
    assert.equal(r.t, 'ok')
    assert.equal((r as { scrollback?: string }).scrollback, 'RING+held')
    assert.deepEqual(t.out, [], 'held output went into the reply, not the event stream')
    t.router.onLinkData('s1', 'next')
    assert.deepEqual(t.out, [['s1', 'next']])
  })

  test('attach of an in-process pane (or tetherd sent the scrollback): tetherd as before, link untouched', async () => {
    const t = setup(() => plainReply())
    const r = await t.router.request({ t: 'attach', slotId: 's1', cols: 80, rows: 24 })
    assert.equal((r as { scrollback?: string }).scrollback, 'DAEMON')
    assert.equal(t.link.has('s1'), false)
    assert.equal(t.router.input('s1', 'a'), 'daemon')
  })

  test('keystrokes: hosted -> link then typed; resize -> link and tetherd; detach -> both', async () => {
    const t = setup(() => hostedReply())
    await t.router.request({ t: 'attach', slotId: 's1', cols: 80, rows: 24 })
    assert.equal(t.router.input('s1', 'ls\r'), 'link')
    assert.deepEqual(t.link.writes, [['s1', 'ls\r']])
    assert.deepEqual(t.typed, [['s1', 'ls\r']])
    await t.router.request({ t: 'resize', slotId: 's1', cols: 100, rows: 30 })
    assert.deepEqual(t.link.resizes, [['s1', 100, 30]])
    assert.equal(t.requests.filter((b) => b.t === 'resize').length, 1)
    await t.router.request({ t: 'detach', slotId: 's1' })
    assert.equal(t.link.has('s1'), false)
    assert.equal(t.requests.filter((b) => b.t === 'detach').length, 1)
  })

  test('link down: hosted keystrokes are dropped (never sent to tetherd), logged once', async () => {
    const t = setup(() => hostedReply())
    await t.router.request({ t: 'attach', slotId: 's1', cols: 80, rows: 24 })
    t.link.writeOk = false
    assert.equal(t.router.input('s1', 'a'), 'dropped')
    assert.equal(t.router.input('s1', 'b'), 'dropped')
    assert.deepEqual(t.typed, [])
    assert.equal(t.logs.filter((l) => l.includes('dropped')).length, 1)
  })

  test('host unreachable at attach: empty scrollback, keystrokes dropped, attached when the link comes up', async () => {
    const t = setup(() => hostedReply())
    t.link.connected = false
    const r = await t.router.request({ t: 'attach', slotId: 's1', cols: 80, rows: 24 })
    assert.equal((r as { scrollback?: string }).scrollback, '')
    assert.equal(t.router.input('s1', 'a'), 'dropped')
    t.link.connected = true
    t.router.onLinkState(true)
    await tick(); await tick()
    assert.equal(t.link.attached.get('s1'), 0)
    assert.deepEqual(t.out, [['s1', 'RING']])
  })

  test('a launch in the host with the window attached is followed from 0; output held meanwhile comes after the ring', async () => {
    const t = setup(() => plainReply(slot({ ptyHost: undefined, status: 'exited', pid: undefined })))
    await t.router.request({ t: 'attach', slotId: 's1', cols: 80, rows: 24 })
    t.link.during = () => t.router.onLinkData('s1', '+held')
    t.router.onState(slot({ status: 'starting', pid: 200 }))
    t.router.onState(slot({ status: 'running', pid: 200 })) // same run: no second attach
    await tick(); await tick()
    assert.equal(t.link.attached.get('s1'), 0)
    assert.deepEqual(t.out, [['s1', 'RING+held']])
  })

  test('exit: detached after the grace; a relaunch within the grace re-attaches the new run instead', async () => {
    const t = setup(() => hostedReply())
    await t.router.request({ t: 'attach', slotId: 's1', cols: 80, rows: 24 })
    t.router.onState(slot({ status: 'exited', pid: undefined }))
    assert.equal(t.link.has('s1'), true, 'still attached during the grace')
    assert.equal(t.timers.length, 1)
    t.timers[0]!()
    assert.equal(t.link.has('s1'), false)

    const u = setup(() => hostedReply())
    await u.router.request({ t: 'attach', slotId: 's1', cols: 80, rows: 24 })
    u.router.onState(slot({ status: 'exited', pid: undefined }))
    u.router.onState(slot({ status: 'running', pid: 300 }))
    assert.equal(u.timers.length, 0, 'the grace timer was cancelled')
    await tick(); await tick()
    assert.equal(u.link.attached.get('s1'), 0)
    assert.deepEqual(u.out, [['s1', 'RING']])
  })

  test('removed slot and reset detach; a reset ring repaints with RIS first', async () => {
    const t = setup(() => hostedReply())
    await t.router.request({ t: 'attach', slotId: 's1', cols: 80, rows: 24 })
    t.router.onLinkReset('s1', 'WHOLE')
    assert.deepEqual(t.out, [['s1', TERMINAL_RESET + 'WHOLE']])
    t.router.onRemoved('s1')
    assert.equal(t.link.has('s1'), false)
    await t.router.request({ t: 'attach', slotId: 's1', cols: 80, rows: 24 })
    t.router.reset()
    assert.equal(t.link.has('s1'), false)
    assert.equal(t.router.input('s1', 'a'), 'daemon', 'after a reset nothing is known: tetherd decides')
  })

  test('a slot the window does not show is never attached in the link', async () => {
    const t = setup(() => hostedReply())
    t.router.onState(slot({ pid: 400 }))
    await tick()
    assert.equal(t.link.has('s1'), false)
    assert.equal(t.router.input('s1', 'a'), 'daemon')
  })
})
