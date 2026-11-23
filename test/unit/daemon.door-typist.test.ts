// The delivery's typist per engine (contract N5, slice E3), unit: a DeliveryService on a fake port (one held, idle, running
// slot whose PTY writes are recorded) and a fake MCP that never wakes, so every delivery takes the terminal path. Then the
// Codex typist of conductor-codex against a fake Codex composer that swallows the first Enter after a long text, as the E2
// measure saw (~290 characters and more). No process, no daemon, no LLM.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { DisposableStore, toDisposable } from '../../app/shared/vscode-lifecycle.ts'
import '../../extensions/index.daemon.ts'
import { codexTypist } from '../../extensions/conductor-codex/daemon.ts'
import type { ScreenText } from '../../extensions/for-agents/conductor-api.ts'
import { DeliveryService } from '../../src/daemon/door/delivery.ts'
import type { SlotPort } from '../../src/daemon/door/port.ts'
import type { DeliveryMessage, DoorDelivery, Typist } from '../../src/daemon/door/types.ts'
import type { SlotMeta } from '../../src/core/event.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { removeHome, sleep, tempHome } from './daemon.helpers.ts'

const SLOT = 's_typist'

interface Rig {
  service: DeliveryService
  delivery: Omit<DoorDelivery, 'enable'>
  writes: string[]
  state: SlotState
  meta: { agent: string; held?: { ext: string; by: string } }
  /** Called on every PTY write, after it is recorded. */
  onWrite?: (data: string) => void
}

function rig(home: string, agent: string, own: DisposableStore): Rig {
  const writes: string[] = []
  const r = {} as Rig
  r.writes = writes
  r.state = { slotId: SLOT, kind: agent, name: 'p', cwd: home, status: 'running', turn: 'idle' } as unknown as SlotState
  r.meta = { agent, held: { ext: 'probe', by: 's_owner' } }
  const port = {
    home,
    meta: (id: string) => (id === SLOT ? (r.meta as unknown as SlotMeta) : undefined),
    isAlive: () => true,
    stateOf: (id: string) => (id === SLOT ? r.state : undefined),
    write: (_id: string, data: string) => { writes.push(data); r.onWrite?.(data) },
  } as unknown as SlotPort
  r.service = new DeliveryService({
    port: () => port,
    mcp: { connected: () => false, wakes: () => false, sendChannel: () => false, onDidStream: () => toDisposable(() => {}) },
    log: () => {},
    typingFor: () => ({ submit: (text) => [{ data: text }, { data: '\r', waitMs: 50 }] }),
  })
  r.delivery = r.service.apiFor('probe', own)
  return r
}

const msg = (body: string): DeliveryMessage => ({ kind: 'message', room: 'bancada', from: { name: 'usuário', id: 'user', role: 'moderator' }, body })

describe('delivery typist (N5)', () => {
  let home: string
  let own: DisposableStore
  let r: Rig
  beforeEach(() => { home = tempHome(); own = new DisposableStore() })
  afterEach(async () => { await r.service.flush(); r.service.dispose(); own.dispose(); removeHome(home) })

  test('no typist for the engine: the typing as before (text, then Enter in its own write); a disposed typist leaves the typing back', async () => {
    r = rig(home, 'claude', own)
    const codex = r.delivery.useTypist('codex', { type: async () => { throw new Error('not this engine') } })
    const a = await r.delivery.deliver(SLOT, msg('oi'))
    assert.equal(a.state, 'typed')
    assert.equal(a.unsent, undefined)
    assert.equal(r.writes.length, 2)
    assert.match(r.writes[0]!, /oi$/)
    assert.equal(r.writes[1], '\r')
    const mine = r.delivery.useTypist('claude', { type: async (ctx) => ((await ctx.write([{ data: 'X' }])) ? 'sent' : 'unsent') })
    mine.dispose()
    codex.dispose()
    await sleep(2_100) // the settle of the first delivery
    const b = await r.delivery.deliver(SLOT, msg('de novo'))
    assert.equal(b.state, 'typed')
    assert.match(r.writes[2]!, /de novo$/)
    assert.equal(r.writes[3], '\r')
  })

  test('the typist replaces the typing: its chunks, its answer; a typist "unsent" is a typed + unsent receipt', async () => {
    r = rig(home, 'codex', own)
    let answer: 'sent' | 'unsent' = 'sent'
    const seen: string[] = []
    r.delivery.useTypist('codex', { type: async (ctx, text) => { seen.push(text); await ctx.write([{ data: 'A' }, { data: 'B', waitMs: 20 }]); return answer } })
    const a = await r.delivery.deliver(SLOT, msg('um'))
    assert.deepEqual(r.writes, ['A', 'B'])
    assert.equal(a.state, 'typed')
    assert.equal(a.unsent, undefined)
    assert.match(seen[0]!, /^\[tether · probe · #bancada · de usuário \(moderator\) · m_\w+\] um$/)
    answer = 'unsent'
    await sleep(2_100)
    const b = await r.delivery.deliver(SLOT, msg('dois'))
    assert.equal(b.state, 'typed')
    assert.equal(b.unsent, true)
  })

  test('before the first byte the interlocks hold again: a typist that looks first and finds the turn busy writes nothing, and the item stays queued', async () => {
    r = rig(home, 'codex', own)
    let result: boolean | undefined
    r.delivery.useTypist('codex', {
      type: async (ctx) => {
        await sleep(30) // the typist reads the screen; meanwhile the turn starts
        r.state = { ...r.state, turn: 'busy' }
        result = await ctx.write([{ data: 'texto' }, { data: '\r', waitMs: 10 }])
        return 'sent'
      },
    })
    const a = await r.delivery.deliver(SLOT, msg('espera'))
    assert.equal(result, false)
    assert.equal(a.state, 'queued')
    assert.deepEqual(r.writes, [])
    assert.equal(r.delivery.pending(SLOT).length, 1)
  })

  test('the pane given back before the first byte, or a typist that throws before writing: nothing typed, still queued', async () => {
    r = rig(home, 'codex', own)
    let n = 0
    r.delivery.useTypist('codex', {
      type: async (ctx) => {
        if (n++ === 0) { delete r.meta.held; return (await ctx.write([{ data: 'x' }])) ? 'sent' : 'unsent' }
        throw new Error('falhou')
      },
    })
    assert.equal((await r.delivery.deliver(SLOT, msg('a'))).state, 'queued')
    r.meta.held = { ext: 'probe', by: 's_owner' }
    assert.equal((await r.delivery.deliver(SLOT, msg('b'))).state, 'queued')
    assert.deepEqual(r.writes, [])
  })

  test('after the first byte: the user types in a wait, the Enter is not written, the typist "sent" does not hide it (unsent), and later writes write nothing', async () => {
    r = rig(home, 'codex', own)
    const results: boolean[] = []
    r.delivery.useTypist('codex', {
      type: async (ctx) => {
        results.push(await ctx.write([{ data: 'texto' }]))
        r.service.input(SLOT, 'k', 'user')
        results.push(await ctx.write([{ data: '\r', waitMs: 20 }]))
        results.push(await ctx.write([{ data: '\r' }]))
        return 'sent'
      },
    })
    const a = await r.delivery.deliver(SLOT, msg('x'))
    assert.deepEqual(results, [true, false, false])
    assert.deepEqual(r.writes, ['texto'])
    assert.equal(a.state, 'typed')
    assert.equal(a.unsent, true)
  })
})

// ---- the Codex typist against a fake composer ----------------------------------------------------

const WORK = 'D:\\bench\\work'
/** The length from which the E2 measure saw the Enter not taken (295 and 287 characters stuck; 52 and 83 went). */
const LONG_FROM = 290

/** A Codex composer: text goes into the box; an Enter submits it, except the first Enter after a long text (the defect of E2). */
class FakeCodex {
  box = ''
  transcript: string[] = []
  busy = false
  enters = 0
  /** Each Enter, with whether the box held the text when it came and whether the screen had been read with that text in it since. */
  log: { draftBefore: boolean; seenStuck: boolean }[] = []
  private swallowed = false
  private readStuck = false
  /** Codex never takes an Enter (to see the typist give up). */
  deaf = false

  write(data: string): void {
    if (data === '\r') {
      this.enters++
      this.log.push({ draftBefore: this.box !== '', seenStuck: this.readStuck })
      this.readStuck = false
      if (this.box === '') return
      if (this.deaf || (this.box.length >= LONG_FROM && !this.swallowed)) { this.swallowed = true; return }
      this.transcript.push(`› ${this.box.split('\n')[0]}`, ...this.box.split('\n').slice(1).map((l) => `  ${l}`))
      this.box = ''
      this.busy = true
      return
    }
    const text = data.replace(/\x1b\[200~|\x1b\[201~/g, '').replace(/\x1b\[0;0;(\d+);1;0;1_/g, (_m, u: string) => String.fromCharCode(Number(u))).replace(/\r/g, '\n')
    this.box += text
  }

  screen(): ScreenText {
    const rows = this.box.split('\n')
    if (this.box !== '') this.readStuck = true
    const composer = this.box === '' ? ['› Ask Codex to do anything'] : [`› ${rows[0]}`, ...rows.slice(1).map((l) => `  ${l}`)]
    const screen = [
      '  >_ OpenAI Codex (v0.169.0)', `     ${WORK}`, '', ...this.transcript, '',
      ...(this.busy ? ['• Working (0s • esc to interrupt)', ''] : []),
      ...composer, '', `  GPT-5.6-Luna low · ${WORK}`,
    ]
    return { screen, history: [], cols: 400, rows: screen.length, end: 0 }
  }
}

describe('the Codex typist (conductor-codex) through the delivery', () => {
  let home: string
  let own: DisposableStore
  let r: Rig
  let codex: FakeCodex
  beforeEach(() => {
    home = tempHome()
    own = new DisposableStore()
    r = rig(home, 'codex', own)
    codex = new FakeCodex()
    r.onWrite = (d) => codex.write(d)
    const api = { slots: { get: () => r.state }, agents: { get: () => undefined }, io: {}, home } as unknown as Parameters<typeof codexTypist>[0]['api']
    r.delivery.useTypist('codex', codexTypist({ api, screen: async () => codex.screen() }))
  })
  afterEach(async () => { await r.service.flush(); r.service.dispose(); own.dispose(); removeHome(home) })

  const long = (n: number): string => `E3L01 · Conferência · revisão ${'palavra '.repeat(Math.ceil(n / 8))}`.slice(0, n)

  test('a short line: text, one Enter, submitted (typed)', async () => {
    const a = await r.delivery.deliver(SLOT, msg('E3S01 · curta, com acento: ação'))
    assert.equal(a.state, 'typed')
    assert.equal(a.unsent, undefined)
    assert.equal(codex.enters, 1)
    assert.equal(codex.box, '')
    assert.match(codex.transcript[0]!, /E3S01 · curta, com acento: ação$/)
  })

  test('a long line (~300 c), the defect of E2: the first Enter is swallowed, the typist reads the text still in the box and only then presses Enter again; submitted', async () => {
    const a = await r.delivery.deliver(SLOT, msg(long(300)))
    assert.equal(a.state, 'typed')
    assert.equal(a.unsent, undefined)
    assert.equal(codex.enters, 2)
    assert.equal(codex.box, '')
    assert.deepEqual(codex.log, [{ draftBefore: true, seenStuck: false }, { draftBefore: true, seenStuck: true }])
    assert.match(codex.transcript.join('\n'), /E3L01 · Conferência · revisão palavra/)
  })

  test('a long text of several lines (a bracketed paste) is submitted the same way', async () => {
    const a = await r.delivery.deliver(SLOT, msg(`${long(150)}\n${long(150)}\nfim`))
    assert.equal(a.state, 'typed')
    assert.equal(a.unsent, undefined)
    assert.equal(codex.enters, 2)
    assert.equal(codex.log[1]!.seenStuck, true)
    assert.ok(r.writes[0]!.startsWith('\x1b[200~'))
  })

  test('a Codex that never takes the Enter: at most three more Enters, then typed + unsent, the text left in the box', async () => {
    codex.deaf = true
    const a = await r.delivery.deliver(SLOT, msg(long(300)))
    assert.equal(a.state, 'typed')
    assert.equal(a.unsent, true)
    assert.equal(codex.enters, 4)
    assert.ok(codex.box.length > 0)
  })
})
