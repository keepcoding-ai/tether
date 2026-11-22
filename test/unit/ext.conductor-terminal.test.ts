// The terminal conductor (C0) in a real tetherd on a test home and test pipe. Fake processes in .cjs files log every stdin chunk
// and print what they got: a fake `claude` agent (no conductor of its own) and a fake shell. The gate is the test's: one that
// lets everything pass and one that refuses (`with-user`); with the refusing one no byte reaches the process.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import '../../src/agents/load.ts'
import { agentRegistry, type AgentContribution } from '../../src/agents/registry.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import type { DoorSlots } from '../../src/daemon/door/types.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { lastBlock, terminalConductor, terminalVerbs } from '../../extensions/conductor-terminal/conductor.ts'
import { conductorRegistry, ConductorRegistry, type Conductor, type ConductorContext, type ConductorTarget } from '../../extensions/for-agents/conductor-api.ts'
import { createScreenReaders } from '../../extensions/for-agents/screen/index.ts'
import { removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

// Logs every stdin chunk (JSON per line) and prints it back, so the screen shows what the process got.
const FAKE_PROC = String.raw`
const fs = require('node:fs')
process.stdout.write('READY\r\n')
if (process.stdin.setRawMode) process.stdin.setRawMode(true)
process.stdin.on('data', (d) => {
  fs.appendFileSync(process.env.ECHO_LOG, JSON.stringify(d.toString()) + '\n')
  process.stdout.write('GOT ' + JSON.stringify(d.toString()) + '\r\n')
})
setInterval(() => {}, 60000)
`

const readLines = (file: string): string[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string) : [])
const codeOf = (e: unknown): string | undefined => (e as { code?: string }).code

describe('conductor-terminal (C0)', () => {
  let home: string
  let daemon: Daemon
  let door: DoorHost
  let own: DisposableStore
  let slots: DoorSlots
  const readers = createScreenReaders({ joinWrapped: false })
  const logs: string[] = []

  const echoLog = (name: string): string => join(home, `echo-${name}.log`)
  const received = (name: string): string => readLines(echoLog(name)).join('')

  const fake: AgentAdapter = {
    name: 'claude',
    plan: (input): LaunchPlan => {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
      delete env.NODE_TEST_CONTEXT
      env.ECHO_LOG = echoLog(input.slot.name ?? '')
      return { command: process.execPath, args: [join(home, 'fake-proc.cjs')], cwd: input.slot.cwd, env }
    },
    sessionExists: async () => 'unknown',
    title: async (b) => b.title,
  }

  // The door's channel flag would be read by node: these tests are about the terminal path.
  const contribution = agentRegistry.get('claude')! as { channels?: AgentContribution['channels'] }
  const savedChannels = contribution.channels
  before(() => { contribution.channels = () => [] })
  after(() => { contribution.channels = savedChannels })

  before(async () => {
    home = tempHome()
    writeFileSync(join(home, 'fake-proc.cjs'), FAKE_PROC)
    door = new DoorHost({ log: (m) => logs.push(m) })
    own = new DisposableStore()
    daemon = await startDaemon({ home, pipe: uniquePipe(home), memoryIntervalMs: 0, readyFallbackMs: 300, minAgentAgeMs: 0, adapters: { claude: fake }, channelOf: () => undefined, door, log: (m) => logs.push(m) })
    slots = door.apiFor('probe', own).slots
  })
  after(async () => {
    readers.dispose()
    own.dispose()
    await door.delivery.flush().catch(() => {})
    door.delivery.dispose()
    await daemon.close().catch(() => {})
    await door.mcp.close().catch(() => {})
    await removeHome(home)
  })

  const spawn = async (kind: 'claude' | 'shell', name: string): Promise<SlotState> => {
    // A shell is launched by its args, with no adapter to set the env: its script carries the log path of its name.
    const script = join(home, `shell-${name}.cjs`)
    if (kind === 'shell') writeFileSync(script, `process.env.ECHO_LOG = ${JSON.stringify(echoLog(name))}
${FAKE_PROC}`)
    const args = kind === 'shell' ? [process.execPath, script] : undefined
    const id = (await slots.create({ kind, cwd: home, name, ...(args ? { args } : {}) })).slotId
    await waitUntil(() => slots.get(id)?.status === 'running' && slots.readScreen(id).data.includes('READY'), 30_000, `${name} running`)
    return slots.get(id)!
  }

  /** The context the extension builds, with the test's gate: `open` lets through, closed refuses with `with-user` before any byte. */
  const ctxOf = (slot: SlotState, gate: { open: boolean }): ConductorContext => {
    const refuse = (): never => { throw Object.assign(new Error('with-user'), { code: 'with-user' }) }
    return {
      target: { paneId: slot.slotId, type: 'terminal', slot },
      slot: () => slots.get(slot.slotId),
      agent: slot.kind === 'shell' ? undefined : agentRegistry.get(slot.kind),
      screen: () => readers.read(slot.slotId, (since) => slots.readScreen(slot.slotId, since === undefined ? undefined : { since })),
      write: async (chunks) => {
        for (const c of chunks) {
          if (!gate.open) refuse()
          if (c.waitMs) await sleep(c.waitMs)
          await slots.write(slot.slotId, c.data)
        }
      },
      keys: async (keys, opts) => {
        if (!gate.open) refuse()
        await slots.keys(slot.slotId, keys, opts)
      },
      io: {} as ConductorContext['io'],
      home,
      log: (m) => logs.push(m),
    }
  }

  const verb = (name: string) => terminalVerbs.find((v) => v.name === name)!

  test('send: uma linha vai com o Enter em escrita separada, pelo typing do motor', async () => {
    const slot = await spawn('claude', 'send-1')
    const r = await terminalConductor.send!(ctxOf(slot, { open: true }), 'ola mundo')
    assert.equal(r.proven, true)
    await waitUntil(() => received(slot.name!) === 'ola mundo\r', 10_000, 'linha e Enter')
    const chunks = readLines(echoLog(slot.name!))
    assert.deepEqual(chunks, ['ola mundo', '\r'])
  })

  test('send: várias linhas vão por colagem entre colchetes, depois o Enter', async () => {
    const slot = await spawn('claude', 'send-n')
    await terminalConductor.send!(ctxOf(slot, { open: true }), 'um\ndois\ntres')
    await waitUntil(() => received(slot.name!) === '\x1b[200~um\rdois\rtres\x1b[201~\r', 10_000, 'colagem e Enter')
  })

  test('type digita sem Enter; keys tecla em ordem; tecla inválida não envia nenhuma', async () => {
    const slot = await spawn('shell', 'typing')
    const ctx = ctxOf(slot, { open: true })
    const t = await verb('type').run(ctx, { guia: slot.slotId, text: 'abc' })
    assert.deepEqual(t.data, { sent: true })
    await waitUntil(() => received(slot.name!) === 'abc', 10_000, 'abc')
    await verb('keys').run(ctx, { guia: slot.slotId, keys: ['up', 'enter'] })
    await waitUntil(() => received(slot.name!) === 'abc\x1b[A\r', 10_000, 'teclas')
    await assert.rejects(verb('keys').run(ctx, { guia: slot.slotId, keys: ['enter', 'f13'] }), (e) => codeOf(e) === 'bad-request')
    await assert.rejects(verb('type').run(ctx, { guia: slot.slotId, text: '' }), (e) => codeOf(e) === 'bad-request')
    await sleep(300)
    assert.equal(received(slot.name!), 'abc\x1b[A\r', 'a tecla inválida não pode enviar a anterior')
  })

  test('interrupt: shell recebe ctrl+c (provado); agente sem condutor recebe esc, proven false', async () => {
    const sh = await spawn('shell', 'int-shell')
    const a = await terminalConductor.interrupt!(ctxOf(sh, { open: true }))
    assert.equal(a.proven, true)
    await waitUntil(() => received(sh.name!) === '\x03', 10_000, 'ctrl+c')

    const ag = await spawn('claude', 'int-agent')
    const b = await terminalConductor.interrupt!(ctxOf(ag, { open: true }))
    assert.equal(b.proven, false)
    assert.equal(b.value.stopped, false)
    await waitUntil(() => received(ag.name!) === '\x1b', 10_000, 'esc')
  })

  test('read: a tela, o histórico, as últimas linhas e o end', async () => {
    const slot = await spawn('shell', 'read')
    const ctx = ctxOf(slot, { open: true })
    await verb('type').run(ctx, { guia: slot.slotId, text: 'xyz' })
    await waitUntil(() => slots.readScreen(slot.slotId).data.includes('GOT'), 10_000, 'eco na tela')
    const r = await terminalConductor.read!(ctx, {})
    assert.match(r.text, /READY/)
    assert.match(r.text, /GOT "xyz"/)
    assert.equal(typeof r.meta?.cols, 'number')
    assert.equal(typeof r.meta?.end, 'number')
    const last = await terminalConductor.read!(ctx, { lines: 1 })
    assert.equal(last.text.split('\n').length, 1)
    assert.match(last.text, /GOT/)
    const hist = await terminalConductor.read!(ctx, { part: 'history' })
    assert.equal(hist.text, '')
  })

  test('detect e lastAnswer: busy/idle pelo turn do slot; a última resposta sai da tela e vem proven false', async () => {
    const ag = await spawn('claude', 'detect')
    const ctx = ctxOf(ag, { open: true })
    assert.deepEqual(await terminalConductor.detect!(ctx), { state: 'idle' })
    assert.deepEqual(await terminalConductor.detect!({ ...ctx, target: { ...ctx.target, slot: { ...ag, turn: 'busy' } } }), { state: 'busy' })
    const sh = await spawn('shell', 'detect-sh')
    assert.deepEqual(await terminalConductor.detect!(ctxOf(sh, { open: true })), { state: 'unknown' })
    const last = await terminalConductor.lastAnswer!(ctx)
    assert.equal(last?.proven, false)
    assert.equal(last?.value.source, 'screen')
    assert.match(last!.value.text, /READY/)
    assert.equal(lastBlock(['a', 'b', '', 'c', 'd', '', '']), 'c\nd')
    assert.equal(lastBlock(['', '']), '')
  })

  test('com o portão que recusa, nenhum byte chega ao processo, em cada ato', async () => {
    const slot = await spawn('claude', 'gate')
    const closed = ctxOf(slot, { open: false })
    const refused = (e: unknown): boolean => codeOf(e) === 'with-user'
    await assert.rejects(terminalConductor.send!(closed, 'nao'), refused)
    await assert.rejects(terminalConductor.interrupt!(closed), refused)
    await assert.rejects(verb('type').run(closed, { text: 'nao' }), refused)
    await assert.rejects(verb('keys').run(closed, { keys: ['enter'] }), refused)
    await sleep(500)
    assert.deepEqual(readLines(echoLog(slot.name!)), [])
    // Reading is not writing: the gate does not cover it.
    assert.match((await terminalConductor.read!(closed, {})).text, /READY/)
  })

  test('o registro: sem condutor próprio o agente cai no do terminal; com um do motor, o dele ganha e o que falta cai aqui', async () => {
    const slot = await spawn('claude', 'registry')
    const target: ConductorTarget = { paneId: slot.slotId, type: 'terminal', slot }
    // A registry of the test's own: the process-wide one also holds the engines' conductors (conductor-claude answers for kind claude).
    {
      const registry = new ConductorRegistry()
      registry.register(terminalConductor)
      assert.deepEqual(registry.chain(target).map((c) => c.id), ['terminal'])
      for (const act of ['send', 'interrupt', 'read', 'detect', 'lastAnswer'] as const) assert.equal(registry.pick(target, act)?.id, 'terminal', act)
      assert.equal(registry.pick(target, 'launchArgs'), undefined)
      assert.deepEqual(registry.verbsOf(target).map((v) => v.verb.name), ['type', 'keys'])
      assert.deepEqual(registry.capabilitiesOf(target).map((c) => c.id), ['send', 'interrupt', 'type', 'keys'])
      // Not a slot pane, not a terminal: not its pane.
      assert.deepEqual(registry.chain({ paneId: 'n1', type: 'note' }), [])
      assert.deepEqual(registry.chain({ paneId: 't1', type: 'terminal' }), [])

      const own10: Conductor = {
        id: 'claude',
        match: (t) => (t.slot?.kind === 'claude' ? 10 : undefined),
        capabilities: [],
        launchArgs: () => ({ value: ['--model', 'x'], proven: true }),
        interrupt: async () => ({ value: { stopped: true }, proven: true }),
      }
      const d2 = registry.register(own10)
      try {
        assert.equal(registry.pick(target, 'interrupt')?.id, 'claude')
        assert.equal(registry.pick(target, 'launchArgs')?.id, 'claude')
        assert.equal(registry.pick(target, 'send')?.id, 'terminal')
        assert.equal(registry.pick(target, 'read')?.id, 'terminal')
      } finally { d2.dispose() }
    }
    assert.equal(conductorRegistry.get('terminal'), terminalConductor)
  })
})
