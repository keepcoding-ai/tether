// The refusal of a permission card on the screen of an unsafe guia nobody commands (extensions/for-agents/daemon/deny-on-screen.ts).
// The door is faked in memory (a screen per slot, writes that record, a delivery that records); the conductor is a fake that reads
// the same screens and types its digit through the context, so the order "no, the card leaves, then the message" is observed.
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { conductorRegistry, type Conductor, type Detected } from '../../extensions/for-agents/conductor-api.ts'
import { DENY_MESSAGE, ScreenDenier, SETTING_KEY } from '../../extensions/for-agents/daemon/deny-on-screen.ts'
import type { DeliveryMessage } from '../../src/daemon/ext-api.ts'
import type { ScreenRead, SlotState } from '../../src/daemon/protocol.ts'
import { sleep } from './daemon.helpers.ts'

const CARD = ['Bash command', ' rm -rf build', ' Do you want to proceed?', ' ? waiting for your answer'].join('\n')
const QUESTION = ['Qual banco usamos?', 'QUESTION-MARK'].join('\n')
const DIALOG = ['Trust this folder?', 'DIALOG-MARK'].join('\n')
const IDLE = ['> ', '  ? for shortcuts'].join('\n')

const fake: Conductor = {
  id: 'fake-deny',
  match: (t) => (t.slot ? 10 : undefined),
  capabilities: [],
  detect: async (ctx): Promise<Detected> => {
    const text = (await ctx.screen()).screen.join('\n')
    if (text.includes('waiting for your answer')) return { state: 'permission', card: { title: 'Bash command', text, options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] } }
    if (text.includes('QUESTION-MARK')) return { state: 'question', card: { title: 'Pergunta', text, options: [] } }
    if (text.includes('DIALOG-MARK')) return { state: 'dialog', card: { title: 'Trust', text, options: [] } }
    return { state: 'idle' }
  },
  answer: async (ctx, choice) => {
    assert.equal(choice, 'no')
    await ctx.write([{ data: '2' }])
    return { value: undefined, proven: true }
  },
}

class World {
  readonly states = new Map<string, SlotState>()
  readonly screens = new Map<string, string>()
  readonly log: string[] = []
  readonly events: string[] = []
  readonly delivered: { to: string; msg: DeliveryMessage }[] = []
  readonly commanders = new Map<string, string>()
  settings: Record<string, unknown> = {}
  free = true
  /** The card stays on the screen after the digit (a card that does not leave). */
  stuck = false
  private listener: ((s: SlotState) => void) | undefined

  /** The terminal is a byte stream: a new screen is a clear and a redraw appended to what came before. */
  show(id: string, text: string): void {
    this.screens.set(id, (this.screens.get(id) ?? '') + '\x1b[2J\x1b[H' + text.replace(/\n/g, '\r\n'))
  }

  add(id: string, patch: Partial<SlotState> = {}): void {
    this.states.set(id, { slotId: id, kind: 'soul', name: id, cwd: 'C:/x', status: 'running', unsafe: true, ...patch } as SlotState)
    this.show(id, IDLE)
  }

  /** The core's state for a pane that waits for the person. */
  wait(id: string, patch: Partial<SlotState> = {}): void {
    const next = { ...this.states.get(id)!, attention: 'waiting', idleSince: 'T1', ...patch } as SlotState
    this.states.set(id, next)
    this.listener?.(next)
  }

  readonly api = {
    home: 'C:/home',
    log: (m: string): void => { this.log.push(m) },
    agents: { get: () => undefined },
    io: {},
    desks: { map: () => ({ desks: [], drawer: [] }) },
    settings: { get: (k: string): unknown => this.settings[k] },
    slots: {
      get: (id: string): SlotState | undefined => this.states.get(id),
      userFree: (): boolean => this.free,
      readScreen: (id: string, opts?: { since?: number }): ScreenRead => {
        const raw = this.screens.get(id) ?? ''
        return { data: raw.slice(opts?.since ?? 0), cols: 120, rows: 40, start: 0, end: raw.length, reset: false }
      },
      write: async (id: string, data: string, opts?: { answer?: boolean }): Promise<void> => {
        this.events.push(`write:${data}:${opts?.answer ? 'answer' : 'plain'}`)
        if (!this.stuck) this.show(id, IDLE)
      },
      keys: async (): Promise<void> => { this.events.push('keys') },
    },
    delivery: {
      deliver: async (to: string, msg: DeliveryMessage) => {
        this.events.push('deliver')
        this.delivered.push({ to, msg })
        return { id: 'r1', slotId: to, state: 'inside' as const, at: 'now' }
      },
    },
  }
  readonly store = { effectiveOf: (id: string) => ({ commander: this.commanders.get(id) }) }

  denier(): ScreenDenier {
    const d = new ScreenDenier(this.api as never, this.store as never, { cardWaitMs: 150, cardPollMs: 10, goneWaitMs: 150, gonePollMs: 10 })
    this.listener = (s) => d.stateChanged(s)
    return d
  }
}

const settle = (ms = 120): Promise<void> => sleep(ms)

describe('for-agents: deny a permission card on the screen of an unsafe guia without owner', () => {
  let w: World
  let d: ScreenDenier
  let unregister: { dispose(): void }
  before(() => { unregister = conductorRegistry.register(fake) })
  after(() => unregister.dispose())
  beforeEach(() => { w = new World(); d = w.denier() })

  test('unsafe soul in permission: "no" is typed as an answer, then the message is delivered', async () => {
    w.add('s1'); w.show('s1', CARD)
    w.wait('s1')
    await settle()
    assert.deepEqual(w.events, ['write:2:answer', 'deliver'])
    assert.equal(w.delivered[0]!.to, 's1')
    assert.equal(w.delivered[0]!.msg.body, DENY_MESSAGE)
    assert.match(w.log.join('\n'), /recusa na tela: guia s1 \(soul · .*\) "Bash command"/)
    d.dispose()
  })

  test('codex too', async () => {
    w.add('c1', { kind: 'codex' }); w.show('c1', CARD)
    w.wait('c1')
    await settle()
    assert.deepEqual(w.events, ['write:2:answer', 'deliver'])
    d.dispose()
  })

  test('a card drawn after the signal is still refused', async () => {
    w.add('s1')
    w.wait('s1')
    await sleep(40)
    w.show('s1', CARD)
    await settle()
    assert.deepEqual(w.events, ['write:2:answer', 'deliver'])
    d.dispose()
  })

  test('the same edge is handled once', async () => {
    w.add('s1'); w.show('s1', CARD)
    w.wait('s1'); w.wait('s1')
    await settle()
    assert.equal(w.delivered.length, 1)
    d.dispose()
  })

  test('not unsafe: nothing', async () => {
    w.add('s1', { unsafe: false }); w.show('s1', CARD)
    w.wait('s1')
    await settle()
    assert.deepEqual(w.events, [])
    d.dispose()
  })

  test('setting false: nothing', async () => {
    w.settings[SETTING_KEY] = false
    w.add('s1'); w.show('s1', CARD)
    w.wait('s1')
    await settle()
    assert.deepEqual(w.events, [])
    d.dispose()
  })

  test('a question or a dialog is for the person: nothing', async () => {
    w.add('s1'); w.show('s1', QUESTION)
    w.add('s2'); w.show('s2', DIALOG)
    w.wait('s1'); w.wait('s2')
    await settle()
    assert.deepEqual(w.events, [])
    d.dispose()
  })

  test('the person is there (userFree false): nothing typed, nothing delivered', async () => {
    w.free = false
    w.add('s1'); w.show('s1', CARD)
    w.wait('s1')
    await settle()
    assert.deepEqual(w.events, [])
    assert.match(w.log.join('\n'), /não feita/)
    d.dispose()
  })

  test('Claude has its own hook: nothing', async () => {
    w.add('k1', { kind: 'claude' }); w.show('k1', CARD)
    w.wait('k1')
    await settle()
    assert.deepEqual(w.events, [])
    d.dispose()
  })

  test('a guia with an owner: nothing (the owner answers)', async () => {
    w.add('s1'); w.show('s1', CARD)
    w.commanders.set('s1', 'boss')
    w.wait('s1')
    await settle()
    assert.deepEqual(w.events, [])
    d.dispose()
  })

  test('the card does not leave: the message is not delivered over it', async () => {
    w.stuck = true
    w.add('s1'); w.show('s1', CARD)
    w.wait('s1')
    await settle(300)
    assert.deepEqual(w.events, ['write:2:answer'])
    assert.match(w.log.join('\n'), /o cartão não saiu/)
    d.dispose()
  })
})
