// Tether for agents, slice X3: the verbs of the owner. A real tetherd on a test home and test pipe, for-agents activated by the
// real extension host with `registerVerbs`, fake agents in a .cjs file that echo what reaches their stdin, and a FAKE conductor
// (the engine of the fake agents) in the conductor registry. The person's gestures are written the way the app writes them
// (`object-set` on the pipe); the agents' verbs run through the door's registry (the MCP exit) and through the pipe's `verb`
// request (the CLI exit). The user's home, pipe and tetherd are never touched.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import { conductorRegistry, ConductError, type Conductor, type Detected } from '../../extensions/for-agents/conductor-api.ts'
import { wire } from '../../extensions/for-agents/daemon.ts'
import { AGENT_VERBS } from '../../extensions/for-agents/daemon/verbs.ts'
import { EXT_ID, manifest } from '../../extensions/for-agents/manifest.ts'
import type { Ownership } from '../../extensions/for-agents/rules.ts'
import type { ExtensionEntry } from '../../extensions/types.ts'
import '../../src/agents/load.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import { inboxPath } from '../../src/daemon/door/delivery.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import type { DoorAttention, DoorSlots, VerbResult } from '../../src/daemon/door/types.ts'
import { DaemonExtensionHost } from '../../src/daemon/ext-host.ts'
import type { TetherDaemon } from '../../src/daemon/ext-api.ts'
import type { DeskMap, ObjectKind } from '../../src/daemon/protocol.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { Recorder, removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const ECHO = [
  "if (process.stdin.isTTY) process.stdin.setRawMode(true)",
  "process.stdin.on('data', (d) => process.stdout.write('IN:' + JSON.stringify(d.toString()) + '\\r\\n'))",
  "process.stdout.write('READY\\r\\n')",
  'setInterval(() => {}, 1000)',
].join('\n')

function fakeAdapter(home: string): AgentAdapter {
  return {
    name: 'soul',
    plan: (input): LaunchPlan => {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
      delete env.NODE_TEST_CONTEXT
      return { command: process.execPath, args: [join(home, 'echo.cjs')], cwd: input.resume?.cwd ?? input.slot.cwd, env }
    },
    sessionExists: async () => 'unknown',
    title: async (b) => b.title,
  }
}

const desk = (id: string, panes: { id: string; type?: string }[], kind: 'queue' | 'system' = 'queue') => ({ id, name: id, kind, panes: panes.map((p) => ({ id: p.id, type: p.type ?? 'terminal' })) })
const data = (r: VerbResult): Record<string, unknown> => r.data as Record<string, unknown>
const codeOf = (r: VerbResult): unknown => (r.data as { error?: string } | undefined)?.error

describe('for-agents: the verbs of the owner (X3)', () => {
  let home: string
  let daemon: Daemon
  let door: DoorHost
  let rec: Recorder
  let slots: DoorSlots
  let attention: DoorAttention
  let fa: ReturnType<typeof wire>['forAgents']
  const probe = new DisposableStore()
  const logs: string[] = []
  // The fake conductor's knobs and what it saw.
  const seen = { launch: [] as unknown[], boot: [] as string[], commands: [] as string[] }
  let detected: Detected = { state: 'idle' }
  let stopped = false
  let lastText: string | undefined
  let unregister: { dispose(): void }
  let A: string, K: string, p1: string, p2: string, p3: string

  const fake: Conductor = {
    id: 'fake',
    match: (t) => (t.type === 'terminal' && t.slot?.kind === 'soul' ? 10 : undefined),
    capabilities: [
      { id: 'send', label: 'Enviar' }, { id: 'interrupt', label: 'Interromper' }, { id: 'answer', label: 'Responder' },
      { id: 'command', label: 'Comandos' }, { id: 'type', label: 'Digitar' }, { id: 'keys', label: 'Teclar' },
    ],
    launchArgs: (req) => { seen.launch.push(req); return { value: ['--model', req.model ?? ''], proven: req.effort === undefined } },
    boot: async (ctx) => { seen.boot.push(ctx.target.paneId) },
    send: async (ctx, text) => { await ctx.write([{ data: text }, { data: '\r', waitMs: 20 }]); return { value: undefined, proven: true } },
    interrupt: async (ctx) => { await ctx.keys(['esc']); return { value: { stopped }, proven: true } },
    detect: async () => detected,
    answer: async (ctx, choice) => { await ctx.write([{ data: choice }]); return { value: undefined, proven: choice !== 'always' } },
    command: async (ctx, name) => {
      if (name === 'busy') throw new ConductError('busy', 'o motor não aceita isso em turno')
      await ctx.write([{ data: `/${name}` }, { data: '\r', waitMs: 20 }])
      seen.commands.push(name)
      return { value: undefined, proven: true }
    },
    lastAnswer: async () => (lastText === undefined ? undefined : { value: { text: lastText, at: '2000-01-01T00:00:00.000Z', source: 'hook' }, proven: true }),
    read: async (ctx, opts) => {
      const t = await ctx.screen()
      const lines = t.screen.join('\n').trimEnd().split('\n')
      return { text: (opts.lines ? lines.slice(-opts.lines) : lines).join('\n'), meta: { cols: t.cols, rows: t.rows, end: t.end } }
    },
    verbs: [
      {
        name: 'type', capability: 'type', description: 'type', help: 'type', input: { type: 'object', properties: {} },
        run: async (ctx, args) => { await ctx.write([{ data: String(args.text) }]); return { text: 'digitado', data: { sent: true } } },
      },
      {
        name: 'keys', capability: 'keys', description: 'keys', help: 'keys', input: { type: 'object', properties: {} },
        run: async (ctx, args) => {
          const keys = args.keys as string[]
          if (keys.includes('f13')) throw new ConductError('bad-request', 'tecla desconhecida')
          await ctx.keys(keys as never)
          return { text: 'teclado', data: { sent: true } }
        },
      },
    ],
  }

  before(async () => {
    home = tempHome()
    writeFileSync(join(home, 'echo.cjs'), ECHO)
    unregister = conductorRegistry.register(fake)
    const entry: ExtensionEntry<TetherDaemon> = {
      manifest,
      activate: (api) => { const w = wire(api); fa = w.forAgents; return w.disposables },
    }
    door = new DoorHost({ log: (m) => logs.push(m) })
    const host = new DaemonExtensionHost({ home, log: (m) => logs.push(m), door, extensions: [entry] })
    host.activate()
    daemon = await startDaemon({
      home, pipe: uniquePipe(home), memoryIntervalMs: 0, readyFallbackMs: 300, minAgentAgeMs: 0, adapters: { soul: fakeAdapter(home) }, door,
      transformPlan: host.transformPlan, onSlot: host.emitSlot, log: (m) => logs.push(m),
    })
    await door.releaseInactive(host.activated)
    host.emitStarted()
    rec = await Recorder.connect(daemon.pipe)
    const api = door.apiFor('probe', probe)
    slots = api.slots
    attention = api.attention
    const make = async (name: string): Promise<string> => {
      const id = (await slots.create({ kind: 'soul', cwd: home, name })).slotId
      await waitUntil(() => slots.readScreen(id).data.includes('READY'), 30_000, `READY in ${name}`)
      return id
    }
    A = await make('Atrium'); K = await make('Kai'); p1 = await make('p1'); p2 = await make('p2'); p3 = await make('p3')
    await sendMap(map([A, p1, p2], [K, p3]))
    await appSet('desk', 'cena', 'owner', { owner: A, since: new Date().toISOString(), givenBy: 'user' } satisfies Ownership)
  })
  after(async () => {
    unregister.dispose()
    probe.dispose()
    rec.close()
    await daemon.close().catch(() => {})
    await removeHome(home)
  })

  const map = (cena: string[], casa: string[], notes: string[] = []): DeskMap => ({
    desks: [desk('cena', [...cena.map((id) => ({ id })), ...notes.map((id) => ({ id, type: 'note' }))]), desk('casa', casa.map((id) => ({ id }))), desk('sistema', [], 'system')],
    drawer: [],
  })
  const appSet = async (kind: ObjectKind, objectId: string, key: string, value?: unknown): Promise<void> => {
    await rec.client.request({ t: 'object-set', ext: EXT_ID, kind, objectId, key, ...(value === undefined ? {} : { value }) })
    await fa.idle()
  }
  const sendMap = async (m: DeskMap): Promise<void> => { await rec.client.request({ t: 'desk-map', map: m }); await fa.idle() }
  /** The MCP exit: the door's registry runs the verb with the caller the tool would carry. */
  const call = async (owner: string, name: string, args: Record<string, unknown> = {}, o: { proven?: boolean } = {}): Promise<VerbResult> => {
    const entry = door.verbs.find('agents', name)
    assert.ok(entry, `verb ${name} registered`)
    return door.verbs.run(entry, { slotId: owner, state: slots.get(owner)!, via: 'mcp', proven: o.proven ?? true }, args)
  }
  const screenOf = (id: string): string => slots.readScreen(id).data
  const quiet = async (): Promise<void> => { await sleep(250) }
  // The notices of the owner (notices.ts) are on: A is no pane "de si" in most cases, so what is told to A waits in its queue,
  // which is the inbox file of the delivery. A case that expects a notice waits for it there, and a case that makes a message
  // wait for a pane waits for it to be typed before the next one starts, so no case leaves anything in another's way.
  const inboxOf = (id: string): string => { try { return readFileSync(inboxPath(home, id), 'utf8') } catch { return '' } }
  const toldTo = (id: string, text: string, what: string): Promise<void> => waitUntil(() => inboxOf(id).includes(text), 20_000, what)
  /**
   * Empties a queue that waits for the pane to be typed into. The fake agent has no report of its own, so each typed message
   * leaves its turn open; the pane takes the next one only when the turn is closed, and the test closes it with the same signal
   * the engines' reports give. Ends with the pane quiet and out of a turn.
   */
  const drainInto = async (id: string, what: string): Promise<void> => {
    const deadline = Date.now() + 90_000
    while (inboxOf(id).trim() !== '' || slots.get(id)?.turn === 'busy') {
      if (Date.now() > deadline) throw new Error(`timeout (90000 ms) waiting for ${what}`)
      if (slots.get(id)?.turn === 'busy') attention.signal(id, 'done')
      await sleep(400)
    }
  }

  test('the table: every verb of 3.1 is registered with both exits, an English description and a Portuguese help', () => {
    const names = ['list', 'open', 'send', 'interrupt', 'read-screen', 'last-answer', 'answer', 'command', 'type', 'keys', 'close', 'restart', 'give', 'revoke']
    assert.deepEqual(AGENT_VERBS.map((v) => v.name), names)
    for (const exit of ['mcp', 'cli'] as const) {
      const listed = door.verbs.list(exit).filter((v) => v.verb.ns === 'agents').map((v) => v.verb.name)
      assert.deepEqual(listed, names, exit)
    }
    for (const { verb } of door.verbs.list('mcp')) assert.ok(verb.description.length > 20 && verb.help.length > 5, verb.name)
    assert.ok(door.verbs.instructionParagraphs().some((p) => p.ext === EXT_ID && p.texts.join('').includes('agents list')))
  })

  test('list: the owner sees its desk with the panes and what it may do; one that owns nothing gets an empty list', async () => {
    const r = await call(A, 'list')
    const d = data(r)
    const desks = d.desks as { id: string; hand: string; panes: Record<string, unknown>[] }[]
    assert.equal(desks.length, 1)
    assert.equal(desks[0]!.id, 'cena')
    const by = Object.fromEntries(desks[0]!.panes.map((p) => [p.id as string, p]))
    assert.equal(by[p1]!.relation, 'command')
    assert.equal(by[p1]!.conductor, 'fake')
    assert.equal(by[p1]!.hand, 'owner')
    assert.equal(by[A]!.relation, 'see', 'the owner\'s own pane in its desk is only seen')
    assert.deepEqual(by[p1]!.off, [])
    assert.equal(typeof by[p1]!.path, 'string')
    assert.equal(by[p3], undefined)
    const empty = data(await call(K, 'list'))
    assert.deepEqual(empty.desks, [])
    assert.deepEqual(empty.panes, [])
  })

  test('send: through the delivery with the owner\'s envelope; with the hand with the person it queues', async () => {
    const r = await call(A, 'send', { guia: p1, text: 'olá p1' })
    assert.equal(r.isError, undefined, r.text)
    assert.ok(['typed', 'inside', 'queued'].includes(String(data(r).state)))
    await waitUntil(() => screenOf(p1).includes('(owner)'), 20_000, 'the envelope typed in p1')
    assert.match(screenOf(p1), /de Atrium \(owner\)/)
    assert.match(screenOf(p1), /olá p1/)

    await appSet('pane', p1, 'hand', { with: 'user', why: 'taken', by: 'gesture', since: new Date().toISOString() })
    await toldTo(A, 'o usuário tomou a guia p1', 'the owner told that p1 was taken')
    const q = await call(A, 'send', { guia: p1, text: 'espera' })
    assert.equal(data(q).state, 'queued')
    assert.equal(data(q).why, 'with-user')
    await appSet('pane', p1, 'hand')
    await toldTo(A, 'o usuário devolveu a guia p1', 'the owner told that p1 was given back')
    // The fake agent has no report of its own: its turn ends only by a signal, and the delivery types into an agent that is not in
    // a turn. The case ends the turn itself and waits for the message that waited to be typed, so it does not come in the middle
    // of a later case.
    attention.signal(p1, 'done')
    await waitUntil(() => screenOf(p1).includes('espera'), 30_000, 'the message that waited, typed in p1 once its turn ended')
  })

  test('send raw: types through the conductor and the gate, and refuses with-user without a byte', async () => {
    await quiet()
    const r = await call(A, 'send', { guia: p2, text: 'cru', raw: true })
    assert.equal(r.isError, undefined, r.text)
    assert.deepEqual([data(r).state, data(r).raw], ['typed', true])
    await waitUntil(() => screenOf(p2).includes('IN:"cru"') && screenOf(p2).includes('IN:"\\r"'), 10_000, 'the raw text and its Enter')
    assert.doesNotMatch(screenOf(p2), /\(owner\)/, 'raw has no envelope')

    await appSet('pane', p2, 'hand', { with: 'user', why: 'taken', by: 'gesture', since: new Date().toISOString() })
    const refused = await call(A, 'send', { guia: p2, text: 'nao', raw: true })
    assert.equal(codeOf(refused), 'with-user')
    await quiet()
    assert.doesNotMatch(screenOf(p2), /nao/)
    await appSet('pane', p2, 'hand')
    await toldTo(A, 'o usuário devolveu a guia p2', 'the owner told that p2 was given back')
  })

  test('errors of ownership: a pane of another desk, a pane only seen, an unknown name', async () => {
    assert.equal(codeOf(await call(A, 'send', { guia: p3, text: 'x' })), 'not-commanded')
    assert.equal(codeOf(await call(A, 'send', { guia: 'nao-existe', text: 'x' })), 'not-commanded')
    assert.equal(codeOf(await call(A, 'send', { guia: A, text: 'x' })), 'not-commanded', 'its own pane in its desk')
    assert.equal(codeOf(await call(K, 'send', { guia: p1, text: 'x' })), 'not-commanded')
    assert.equal(codeOf(await call(K, 'read-screen', { guia: p1 })), 'not-mine')
    assert.equal(codeOf(await call(K, 'last-answer', { guia: p1 })), 'not-mine')
    assert.equal(codeOf(await call(A, 'read-screen', { guia: p3 })), 'not-mine')
  })

  test('the inventory: a line turned off answers off, on the desk and on the pane (and the pane can turn it on again)', async () => {
    await appSet('desk', 'cena', 'inventory', { send: false })
    assert.equal(codeOf(await call(A, 'send', { guia: p1, text: 'x' })), 'off')
    await appSet('pane', p1, 'inventory', { send: true })
    assert.notEqual(codeOf(await call(A, 'send', { guia: p1, text: 'x' })), 'off', 'the pane\'s own value wins')
    assert.equal(codeOf(await call(A, 'send', { guia: p2, text: 'x' })), 'off')
    const listed = (data(await call(A, 'list')).desks as { panes: { id: string; off: string[] }[] }[])[0]!.panes
    assert.deepEqual(listed.find((p) => p.id === p2)!.off, ['send'])
    await appSet('pane', p1, 'inventory')
    await appSet('desk', 'cena', 'inventory')

    await appSet('desk', 'cena', 'inventory', { 'open-close': false, 'give-revoke': false, type: false })
    assert.equal(codeOf(await call(A, 'open', { kind: 'soul', cwd: home })), 'off')
    assert.equal(codeOf(await call(A, 'close', { guia: p1 })), 'off')
    assert.equal(codeOf(await call(A, 'restart', { guia: p1 })), 'off')
    assert.equal(codeOf(await call(A, 'give', { guia: p1, to: K })), 'off')
    assert.equal(codeOf(await call(A, 'revoke', { guia: p1 })), 'off')
    assert.equal(codeOf(await call(A, 'type', { guia: p1, text: 'x' })), 'off')
    await appSet('desk', 'cena', 'inventory')
  })

  test('no-conductor and unsupported: a pane with no conductor, and an act the conductor lacks', async () => {
    await sendMap(map([A, p1, p2], [K, p3], ['n1']))
    assert.equal(codeOf(await call(A, 'send', { guia: 'n1', text: 'x' })), 'no-conductor', 'a note is commanded by the desk, but nothing conducts it yet')
    const answer = fake.answer
    delete (fake as { answer?: unknown }).answer
    assert.equal(codeOf(await call(A, 'answer', { guia: p1, choice: 'yes' })), 'unsupported')
    fake.answer = answer
    await sendMap(map([A, p1, p2], [K, p3]))
  })

  test('interrupt: not-busy when idle; sends the key; confirms and tells the door the turn is done; with-user without a byte', async () => {
    await quiet()
    assert.equal(codeOf(await call(A, 'interrupt', { guia: p1 })), 'not-busy')
    detected = { state: 'busy' }
    const r = await call(A, 'interrupt', { guia: p1 })
    assert.equal(r.isError, undefined, r.text)
    assert.deepEqual([data(r).interrupted, data(r).state, data(r).proven], [true, 'sent', true])
    await waitUntil(() => screenOf(p1).includes('IN:"\\u001b"'), 10_000, 'esc')

    stopped = true
    await quiet()
    const done = await call(A, 'interrupt', { guia: p1 })
    assert.equal(data(done).state, 'stopped')
    await waitUntil(() => slots.get(p1)?.attentionFor?.value === 'done' && slots.get(p1)?.attentionFor?.slotId === A, 10_000, 'the done signal, routed to the owner')
    await toldTo(A, `terminou · guia ${p1} · mesa cena`, 'the owner told that the turn ended')
    attention.seen(p1)

    await appSet('pane', p1, 'hand', { with: 'user', why: 'paused', by: 'gesture', since: new Date().toISOString() })
    await toldTo(A, 'p1 foi pausada para você', 'the owner told that p1 was paused')
    const before = screenOf(p1)
    assert.equal(codeOf(await call(A, 'interrupt', { guia: p1 })), 'with-user')
    await quiet()
    assert.equal(screenOf(p1), before)
    await appSet('pane', p1, 'hand')
    await toldTo(A, 'p1 foi retomada', 'the owner told that p1 was resumed')
    stopped = false
    detected = { state: 'idle' }
  })

  test('read-screen: the screen as text, with the state; also a pane the owner only sees', async () => {
    const r = await call(A, 'read-screen', { guia: p1 })
    assert.equal(r.isError, undefined, r.text)
    const d = data(r)
    assert.match(String(d.text), /READY/)
    assert.equal(typeof d.cols, 'number')
    assert.equal(typeof d.end, 'number')
    assert.equal(d.state, 'idle')
    const last = await call(A, 'read-screen', { guia: p1, lines: 1 })
    assert.equal(String(data(last).text).split('\n').length, 1)
    assert.equal(codeOf(await call(A, 'read-screen', { guia: p1, part: 'banana' })), 'bad-request')
    // Only seen: the pane is given to K, and A still reads it.
    await call(A, 'give', { guia: p2, to: K })
    assert.equal(data(await call(A, 'read-screen', { guia: p2 })).state, 'idle')
    assert.equal(codeOf(await call(A, 'send', { guia: p2, text: 'x' })), 'not-commanded')
    await call(A, 'revoke', { guia: p2 })
  })

  test('last-answer: none, then the text with its source; stale after an interrupt; reading clears the rerouted attention', async () => {
    assert.equal(codeOf(await call(A, 'last-answer', { guia: p1 })), 'none')
    lastText = 'a resposta'
    await appSet('pane', p1, 'last', { by: A, verb: 'send', at: new Date().toISOString() })
    const r = await call(A, 'last-answer', { guia: p1 })
    assert.deepEqual([data(r).text, data(r).source, data(r).stale, data(r).proven], ['a resposta', 'hook', false, true])
    detected = { state: 'busy' }
    await quiet()
    await call(A, 'interrupt', { guia: p1 })
    detected = { state: 'idle' }
    assert.equal(data(await call(A, 'last-answer', { guia: p1 })).stale, true)
    lastText = undefined
  })

  test('answer: only with the card on the screen now; always comes back unproven; bad choice and no support', async () => {
    assert.equal(codeOf(await call(A, 'answer', { guia: p1, choice: 'yes' })), 'no-request')
    assert.equal(codeOf(await call(A, 'answer', { guia: p1, choice: 'talvez' })), 'bad-request')
    detected = { state: 'permission', card: { title: 'Run it?', text: 'rm', options: [{ id: 'yes', label: 'Yes' }, { id: 'always', label: 'Yes, and do not ask again' }, { id: 'no', label: 'No' }] } }
    await quiet()
    const yes = await call(A, 'answer', { guia: p1, choice: 'yes' })
    assert.deepEqual([data(yes).sent, data(yes).card, data(yes).proven], [true, 'Yes', true])
    await waitUntil(() => screenOf(p1).includes('IN:"yes"'), 10_000, 'the answer typed')
    const always = await call(A, 'answer', { guia: p1, choice: 'always' })
    assert.equal(data(always).card, 'Yes, and do not ask again')
    assert.equal(data(always).proven, false)
    assert.match(always.text, /não provado pela sonda/)
    await appSet('pane', p1, 'hand', { with: 'user', why: 'taken', by: 'gesture', since: new Date().toISOString() })
    assert.equal(codeOf(await call(A, 'answer', { guia: p1, choice: 'no' })), 'with-user')
    await appSet('pane', p1, 'hand')
    await toldTo(A, 'o usuário devolveu a guia p1', 'the owner told that p1 was given back')
    detected = { state: 'idle' }
  })

  test('command: on a pane of the owner at once; busy from the conductor; on its own pane deferred to the end of the turn', async () => {
    await quiet()
    const r = await call(A, 'command', { guia: p1, name: 'compact' })
    assert.deepEqual([data(r).sent, data(r).proven], [true, true])
    await waitUntil(() => screenOf(p1).includes('IN:"/compact"'), 10_000, '/compact typed')
    assert.equal(codeOf(await call(A, 'command', { guia: p1, name: 'busy' })), 'busy')
    assert.equal(codeOf(await call(A, 'command', { name: 'compact' })), 'not-commanded', 'no pane "de si"')

    await appSet('pane', A, 'owner', { owner: A, since: new Date().toISOString(), givenBy: 'user' } satisfies Ownership)
    // A is "de si" now, so what waited for it (the notices of the cases before) is typed into it, one at a time; the deferred
    // command is measured from when that queue is empty and the pane is quiet.
    await drainInto(A, "the owner's queue to empty into its own pane")
    await quiet()
    const own = await call(A, 'command', { name: 'clear' })
    assert.equal(data(own).deferred, true)
    assert.equal(seen.commands.includes('clear'), false, 'not run inside the call')
    await waitUntil(() => screenOf(A).includes('IN:"/clear"'), 15_000, 'the deferred command typed in its own pane')
    const mine = ((data(await call(A, 'list')).desks as { panes: unknown[] }[])[0]!.panes as { id: string; relation: string; pending: number }[]).find((p) => p.id === A)
    assert.equal(mine?.relation, 'self')
    assert.equal(mine?.pending, 0)
    await appSet('pane', A, 'owner')
  })

  test('type and keys: through the conductor\'s own verbs; an invalid key sends none; with-user without a byte', async () => {
    await quiet()
    const t = await call(A, 'type', { guia: p1, text: 'abc' })
    assert.deepEqual(data(t), { sent: true })
    await waitUntil(() => screenOf(p1).includes('IN:"abc"'), 10_000, 'abc')
    const k = await call(A, 'keys', { guia: p1, keys: ['up', 'enter'] })
    assert.deepEqual(data(k), { sent: true })
    // The two keys reach the process as one chunk or as two, whatever the pty coalesces.
    await waitUntil(() => /IN:"\\u001b\[A(\\r)?"/.test(screenOf(p1)) && /IN:"(\\u001b\[A)?\\r"/.test(screenOf(p1)), 10_000, 'the keys')
    assert.equal(codeOf(await call(A, 'keys', { guia: p1, keys: ['enter', 'f13'] })), 'bad-request')
    assert.equal(codeOf(await call(A, 'type', { guia: p3, text: 'x' })), 'not-commanded')
    await appSet('pane', p1, 'hand', { with: 'user', why: 'taken', by: 'gesture', since: new Date().toISOString() })
    assert.equal(codeOf(await call(A, 'type', { guia: p1, text: 'nope' })), 'with-user')
    await appSet('pane', p1, 'hand')
    await toldTo(A, 'o usuário devolveu a guia p1', 'the owner told that p1 was given back')
    await quiet()
    assert.doesNotMatch(screenOf(p1), /nope/)
  })

  test('give and revoke: the desk owner gives to an agent, to itself, and takes back; the errors of the table', async () => {
    const given = await call(A, 'give', { guia: p2, to: K })
    assert.equal(given.isError, undefined, given.text)
    const own = data(given).ownership as Ownership
    assert.deepEqual([own.owner, own.givenBy], [K, A])
    const kList = data(await call(K, 'list'))
    assert.deepEqual((kList.panes as { id: string; relation: string }[]).map((p) => [p.id, p.relation]), [[p2, 'command']])
    assert.equal(codeOf(await call(K, 'give', { guia: p2, to: K })), 'not-owner', 'the owner of a pane does not pass it on')
    assert.equal(codeOf(await call(A, 'give', { guia: p2, to: 'ninguem' })), 'unknown-agent')
    assert.equal(codeOf(await call(A, 'give', { guia: p3, to: K })), 'not-owner', 'a pane of another desk')
    const revoked = await call(A, 'revoke', { guia: p2 })
    assert.equal(data(revoked).ownership, null)
    assert.equal(codeOf(await call(A, 'revoke', { guia: p2 })), 'not-given')
    const self = await call(A, 'give', { guia: p1, to: 'self' })
    assert.equal((data(self).ownership as Ownership).owner, p1)
    await call(A, 'revoke', { guia: p1 })
  })

  test('open: the pane is born in the owner\'s desk on its behalf, with model and effort by the conductor; the errors of the table', async () => {
    const r = await call(A, 'open', { kind: 'soul', cwd: home, name: 'filha', model: 'm1', brief: 'comece' })
    assert.equal(r.isError, undefined, r.text)
    const child = String(data(r).pane)
    const slot = slots.get(child)!
    assert.deepEqual(slot.createdBy, { ext: EXT_ID, slotId: A })
    assert.deepEqual(slot.paneRequest, { deskId: 'cena' })
    assert.equal(data(r).proven, true)
    assert.doesNotMatch(r.text, /sonda/, 'proven launch: nothing marked')
    assert.deepEqual(seen.launch[0], { model: 'm1', cwd: home })
    assert.deepEqual(seen.boot, [child])
    const unproven = await call(A, 'open', { kind: 'soul', cwd: home, name: 'filha2', effort: 'high' })
    assert.equal(data(unproven).proven, false)
    assert.match(unproven.text, /não provado pela sonda/)
    await call(A, 'close', { guia: String(data(unproven).pane) }).catch(() => undefined)

    // The pane appears in the desk map: it is commanded by inheritance, and the brief reaches it through the delivery.
    await sendMap(map([A, p1, p2, child], [K, p3]))
    assert.deepEqual(data(await call(A, 'read-screen', { guia: 'filha' })).state, 'idle')
    await waitUntil(() => screenOf(child).includes('comece'), 30_000, 'the brief delivered to the new pane')
    assert.match(screenOf(child), /de Atrium \(owner\)/)

    assert.equal(codeOf(await call(A, 'open', { kind: 'soul', cwd: home, desk: 'nenhuma' })), 'unknown-desk')
    assert.equal(codeOf(await call(A, 'open', { kind: 'soul', cwd: home, desk: 'casa' })), 'not-owner')
    assert.equal(codeOf(await call(K, 'open', { kind: 'soul', cwd: home })), 'no-desk', 'owns no desk')
    assert.equal(codeOf(await call(A, 'open', { kind: 'zzz', cwd: home })), 'agent-unavailable')
    assert.equal(codeOf(await call(A, 'open', { kind: 'shell', cwd: home, model: 'x' })), 'bad-request')
    assert.equal(codeOf(await call(A, 'open', { kind: 'soul' })), 'bad-request')
    await appSet('desk', 'casa', 'owner', { owner: A, since: new Date().toISOString(), givenBy: 'user' } satisfies Ownership)
    assert.equal(codeOf(await call(A, 'open', { kind: 'soul', cwd: home })), 'no-desk', 'two desks and none named')
    await appSet('desk', 'casa', 'owner')
  })

  test('ambiguous: a name that two panes share lists them', async () => {
    const mk = async (name: string): Promise<string> => {
      const id = (await slots.create({ kind: 'soul', cwd: home, name })).slotId
      await waitUntil(() => screenOf(id).includes('READY'), 30_000, name)
      return id
    }
    const d1 = await mk('dup'), d2 = await mk('dup')
    await sendMap(map([A, p1, p2, d1, d2], [K, p3]))
    const r = await call(A, 'type', { guia: 'dup', text: 'x' })
    assert.equal(codeOf(r), 'ambiguous')
    assert.deepEqual((data(r).options as { id: string }[]).map((o) => o.id).sort(), [d1, d2].sort())
    assert.equal(data(await call(A, 'read-screen', { guia: d1 })).state, 'idle', 'by id it is fine')
  })

  test('close and restart: stop keeps the pane, forget removes it, fresh restarts; never its own pane', async () => {
    const id = (await slots.create({ kind: 'soul', cwd: home, name: 'efemera' })).slotId
    await waitUntil(() => screenOf(id).includes('READY'), 30_000, 'efemera')
    await sendMap(map([A, p1, p2, id], [K, p3]))
    const stopped = await call(A, 'close', { guia: id, mode: 'stop' })
    assert.equal(stopped.isError, undefined, stopped.text)
    assert.ok(slots.get(id), 'the pane stays')
    assert.notEqual(slots.get(id)?.status, 'running')
    const again = await call(A, 'restart', { guia: id, fresh: true })
    assert.equal(again.isError, undefined, again.text)
    await waitUntil(() => slots.get(id)?.status === 'running', 30_000, 'restarted')
    assert.equal(codeOf(await call(A, 'close', { guia: id, mode: 'banana' })), 'bad-request')
    assert.equal(codeOf(await call(A, 'close', { guia: A })), 'not-commanded')
    const gone = await call(A, 'close', { guia: id })
    assert.equal(data(gone).state, 'forgotten')
    await waitUntil(() => slots.get(id) === undefined, 10_000, 'forgotten')
  })

  test('the caller without proof runs and leaves marked; the CLI exit and the MCP exit give the same answer', async () => {
    const mcp = await call(A, 'list')
    const unproven = await call(A, 'list', {}, { proven: false })
    assert.equal(unproven.isError, undefined)
    assert.equal(data(unproven).proven, false)
    assert.match(unproven.text, /sem prova de identidade/)
    assert.deepEqual({ ...data(unproven), proven: undefined }, { ...data(mcp), proven: undefined })

    // The CLI exit is the pipe's `verb` request; with no slot key the identity is not proven.
    const viaPipe = (await rec.client.request({ t: 'verb', ns: 'agents', name: 'list', slotId: A, args: {} })) as unknown as { verb: VerbResult }
    assert.equal(data(viaPipe.verb).proven, false)
    assert.deepEqual({ ...data(viaPipe.verb), proven: undefined }, { ...data(mcp), proven: undefined })
    const err = (await rec.client.request({ t: 'verb', ns: 'agents', name: 'send', slotId: A, args: { guia: p3, text: 'x' } })) as unknown as { verb: VerbResult }
    assert.equal(codeOf(err.verb), 'not-commanded')
    assert.equal(err.verb.isError, true)
    assert.equal(codeOf(await call(A, 'send', { guia: p3, text: 'x' })), 'not-commanded', 'the same code on the other exit')
  })

  test('each act that works records the last act on the pane', async () => {
    await call(A, 'send', { guia: p1, text: 'marca' })
    await fa.idle()
    await sleep(100)
    const last = ((await call(A, 'list')).data as { desks: { panes: { id: string; last?: { by: string; verb: string } }[] }[] }).desks[0]!.panes.find((p) => p.id === p1)!.last
    assert.equal(last?.by, A)
    assert.ok(last?.verb)
  })
})
