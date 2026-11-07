// The send state machine of "Mandar para o agente" (extensions/faults/delivery.ts) on a fake clock and a fake slot: the
// wait for a pane that is not idle yet (a trust dialog), the check that the typed command made the pane busy, the one
// retype, and the revert when the pane never takes it.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { toDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { ACCEPT_TIMEOUT_MS, CLEAR_LINE, deliver, NOT_ACCEPTED_TEXT, READY_TIMEOUT_MS, SUBMIT_DELAY_MS, untilReady, WAITING_TEXT, type DeliveryIo } from '../../extensions/faults/delivery.ts'

class Fake implements DeliveryIo {
  state: { status: string; turn?: string } | undefined
  now = 0
  sent: string[] = []
  private listeners = new Set<() => void>()
  private timers: { at: number; fn: () => void; live: boolean }[] = []
  /** What the fake pane does with the lines it is given: how many Enters it ignores before it turns busy (Infinity = never). */
  ignoreEnters = 0
  /** The turn the pane shows once it takes a line. */
  takenAs = 'busy'
  private typed = ''
  constructor(state: { status: string; turn?: string } | undefined) { this.state = state }
  slot() { return this.state }
  onChange(l: () => void) { this.listeners.add(l); return toDisposable(() => { this.listeners.delete(l) }) }
  input(data: string): void {
    this.sent.push(data)
    if (data === CLEAR_LINE) this.typed = ''
    else if (data === '\r') {
      if (this.typed && this.ignoreEnters > 0) this.ignoreEnters--
      else if (this.typed) this.set({ status: 'running', turn: this.takenAs })
    } else this.typed += data
  }
  after(ms: number, fn: () => void): () => void {
    const t = { at: this.now + ms, fn, live: true }
    this.timers.push(t)
    return () => { t.live = false }
  }
  set(state: { status: string; turn?: string } | undefined): void { this.state = state; for (const l of [...this.listeners]) l() }
  /** Moves the clock, firing timers in order (microtasks settle between them). */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms
    for (;;) {
      await settle()
      const next = this.timers.filter(t => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      next.live = false
      this.now = next.at
      next.fn()
    }
    this.now = end
    await settle()
  }
}
const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve() }
const idle = { status: 'running', turn: 'idle' }

describe('untilReady', () => {
  test('an idle pane is ready at once and says nothing', async () => {
    const io = new Fake(idle)
    const said: string[] = []
    assert.equal(await untilReady(io, t => said.push(t)), true)
    assert.deepEqual(said, [])
  })

  test('a pane that is not idle (trust dialog) is waited for up to 5 minutes, and the row says to confirm in the pane', async () => {
    const io = new Fake({ status: 'running', turn: undefined })
    const said: string[] = []
    let result: boolean | undefined
    void untilReady(io, t => said.push(t)).then(r => { result = r })
    await io.advance(READY_TIMEOUT_MS - 1000)
    assert.equal(result, undefined, 'still waiting after 4 minutes 59 s (the old limit was 30 s)')
    assert.deepEqual(said, [WAITING_TEXT])
    assert.equal(WAITING_TEXT, 'aguardando o agente ficar pronto · confirme no painel')
    io.set(idle) // the person accepted the dialog
    await settle()
    assert.equal(result, true)
  })

  test('after 5 minutes it gives up', async () => {
    const io = new Fake({ status: 'running', turn: undefined })
    let result: boolean | undefined
    void untilReady(io).then(r => { result = r })
    await io.advance(READY_TIMEOUT_MS + 1)
    assert.equal(result, false)
  })

  test('a pane that is gone or has exited stops the wait at once', async () => {
    const io = new Fake({ status: 'starting' })
    let result: boolean | undefined
    void untilReady(io).then(r => { result = r })
    await settle()
    io.set({ status: 'exited' })
    await settle()
    assert.equal(result, false)
  })
})

describe('deliver', () => {
  test('typed, then Enter after the delay; accepted as soon as the pane turns busy', async () => {
    const io = new Fake(idle)
    let r: string | undefined
    void deliver(io, '/tether:fault-investigate a3f9').then(x => { r = x })
    await settle()
    assert.deepEqual(io.sent, ['/tether:fault-investigate a3f9'], 'the Enter waits')
    await io.advance(SUBMIT_DELAY_MS)
    assert.deepEqual(io.sent, ['/tether:fault-investigate a3f9', '\r'])
    assert.equal(r, 'accepted')
  })

  test('a pane that is not idle is refused without typing anything', async () => {
    const io = new Fake({ status: 'running', turn: 'busy' })
    assert.equal(await deliver(io, 'x'), 'not-free')
    assert.deepEqual(io.sent, [])
  })

  test('a pane that ignores the first Enter is cleared and retyped once, then accepted', async () => {
    const io = new Fake(idle)
    io.ignoreEnters = 1
    let r: string | undefined
    void deliver(io, 'cmd').then(x => { r = x })
    await io.advance(SUBMIT_DELAY_MS + ACCEPT_TIMEOUT_MS)
    assert.equal(r, undefined, 'the second attempt is under way')
    await io.advance(SUBMIT_DELAY_MS)
    assert.equal(r, 'accepted')
    assert.deepEqual(io.sent, ['cmd', '\r', CLEAR_LINE, 'cmd', '\r'])
  })

  test('a pane that stays idle after the retype is reverted: not accepted, exactly two attempts', async () => {
    const io = new Fake(idle)
    io.ignoreEnters = Infinity
    let r: string | undefined
    void deliver(io, 'cmd').then(x => { r = x })
    await io.advance(2 * (SUBMIT_DELAY_MS + ACCEPT_TIMEOUT_MS) + 10)
    assert.equal(r, 'not-accepted')
    assert.equal(NOT_ACCEPTED_TEXT, 'o comando não foi aceito pelo painel')
    assert.deepEqual(io.sent, ['cmd', '\r', CLEAR_LINE, 'cmd', '\r'])
  })

  test('a pane that dies while the line is being checked is not-free, not accepted', async () => {
    const io = new Fake(idle)
    io.ignoreEnters = Infinity
    let r: string | undefined
    void deliver(io, 'cmd').then(x => { r = x })
    await io.advance(SUBMIT_DELAY_MS + 100)
    io.set({ status: 'exited' })
    await io.advance(ACCEPT_TIMEOUT_MS)
    assert.equal(r, 'not-free')
  })

  test('blocked counts as taken (the agent stopped to ask the person something)', async () => {
    const io = new Fake(idle)
    io.takenAs = 'blocked'
    let r: string | undefined
    void deliver(io, 'cmd').then(x => { r = x })
    await io.advance(SUBMIT_DELAY_MS)
    assert.equal(r, 'accepted')
  })
})
