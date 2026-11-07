// The agent registry and tetherd's extension host (F9 slice 0c): built-ins register through the registry, default
// profiles and reserved args come from the contributions, persisted slot metas and profiles.json keep their format
// (fixtures), a slot whose agent is not registered stays listed as agent-unavailable, and a daemon extension can
// register an agent, a launch middleware and a slot listener. Isolated daemons on unique pipes; no real agent.
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { TetherDaemon } from '../../src/daemon/ext-api.ts'
import type { ExtensionEntry } from '../../extensions/types.ts'
import { extensions as daemonIndex } from '../../extensions/index.daemon.ts'
import { AgentRegistry, agentRegistry, isAgentName, type AgentContribution } from '../../src/agents/registry.ts'
import type { AgentAdapter, LaunchPlan } from '../../src/agents/types.ts'
import { slotMetaPath, slotsDir } from '../../src/core/paths.ts'
import { defaultProfiles, parseProfilesFile, readProfiles, validateProfile } from '../../src/core/profile.ts'
import { listSlots, readSlot } from '../../src/core/store.ts'
import { attentionOptions } from '../../src/daemon/attention.ts'
import { DaemonExtensionHost } from '../../src/daemon/ext-host.ts'
import { defaultAgentArgs, startDaemon, type Daemon } from '../../src/daemon/server.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { Recorder, removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const fixtures = fileURLToPath(new URL('./fixtures/agents/', import.meta.url))

function inertPlan(cwd: string): LaunchPlan {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  return { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd, env }
}

function fakeAdapter(name: string): AgentAdapter {
  return { name, plan: (input) => inertPlan(input.resume?.cwd ?? input.slot.cwd), sessionExists: async () => 'unknown', title: async (b) => b.title }
}

function contribution(name: string): AgentContribution {
  return {
    name,
    adapter: fakeAdapter(name),
    attention: { idle: true, bel: true },
    defaultProfiles: () => [{ id: name, name: `Agente ${name}`, agent: name, args: [] }],
    reservedArgs: { '--resume': 'o tether escolhe a sessão' },
    envArgsVar: 'TETHER_TESTAGENT_ARGS',
  }
}

/** Copies a fixture slot meta into home with the cwd placeholder filled. */
function installSlot(home: string, file: string, cwd: string): void {
  mkdirSync(slotsDir(home), { recursive: true })
  const meta = JSON.parse(readFileSync(join(fixtures, file), 'utf8').replace('__CWD__', cwd.replace(/\\/g, '\\\\')))
  writeFileSync(slotMetaPath(home, meta.slotId), JSON.stringify(meta, null, 2))
}

describe('agent registry', () => {
  test('claude and soul are registered by their extensions, with their adapters', () => {
    assert.deepEqual(agentRegistry.names().slice(0, 2), ['claude', 'soul'])
    assert.equal(agentRegistry.get('claude')!.adapter.name, 'claude')
    assert.equal(agentRegistry.get('soul')!.adapter.name, 'soul')
  })

  test('register refuses duplicates, shell and bad names; dispose unregisters', () => {
    const r = new AgentRegistry()
    const d = r.register(contribution('codex'))
    assert.throws(() => r.register(contribution('codex')), /já está registrado/)
    assert.throws(() => r.register({ ...contribution('shell') }), /inválido/)
    assert.throws(() => r.register(contribution('Codex X')), /inválido/)
    assert.throws(() => r.register({ ...contribution('a'), adapter: fakeAdapter('b') }), /adaptador/)
    d.dispose()
    assert.equal(r.has('codex'), false)
  })

  test('isAgentName accepts any plausible name (readers never lose a slot), never shell', () => {
    assert.ok(isAgentName('claude'))
    assert.ok(isAgentName('codex'))
    assert.ok(!isAgentName('shell'))
    assert.ok(!isAgentName(''))
    assert.ok(!isAgentName(42))
  })

  test('default profiles come from the contributions, in the same order and content as before', () => {
    const ids = defaultProfiles({}, 'linux').map((p) => p.id)
    assert.deepEqual(ids, ['claude', 'claude-dev', 'soul', 'shell'])
    const dev = defaultProfiles({}, 'linux').find((p) => p.id === 'claude-dev')!
    assert.deepEqual(dev.args, ['--dangerously-skip-permissions'])
  })

  test('reserved args come from the contribution', () => {
    assert.match(validateProfile({ name: 'x', agent: 'claude', args: ['--settings=a'] }).errors.join(), /--settings=a/)
    assert.deepEqual(validateProfile({ name: 'x', agent: 'soul', args: ['--settings'] }).errors, [])
  })

  test('saving a profile of an unregistered agent is refused (reading keeps it: see the fixtures)', () => {
    assert.match(validateProfile({ name: 'Codex', agent: 'codex', args: [] }).errors.join(), /agente inválido: codex/)
  })

  test('attention options and TETHER_*_ARGS come from the contribution', () => {
    assert.deepEqual(attentionOptions('claude'), { idle: false, bel: false })
    assert.deepEqual(attentionOptions('soul'), { idle: true, bel: true })
    assert.deepEqual(attentionOptions('shell'), { idle: false, bel: true })
    assert.deepEqual(attentionOptions('codex'), { idle: false, bel: true })
    assert.deepEqual(defaultAgentArgs('claude', { TETHER_CLAUDE_ARGS: '--model haiku' }), ['--model', 'haiku'])
    assert.deepEqual(defaultAgentArgs('soul', { TETHER_SOUL_ARGS: ' -g ' }), ['-g'])
  })
})

describe('persisted format stays compatible (fixtures)', () => {
  let home: string
  before(() => { home = tempHome() })
  after(async () => { await removeHome(home) })

  test('profiles.json with an unregistered agent parses whole', () => {
    const parsed = parseProfilesFile(readFileSync(join(fixtures, 'profiles.json'), 'utf8'))
    assert.ok(parsed.ok)
    assert.deepEqual(parsed.profiles.map((p) => p.id), ['claude', 'soul', 'codex', 'powershell'])
    assert.equal(parsed.skipped, 0)
    copyFileSync(join(fixtures, 'profiles.json'), join(home, 'profiles.json'))
    const read = readProfiles(home)
    assert.equal(read.problem, undefined)
    assert.deepEqual(read.profiles.map((p) => p.id), ['claude', 'soul', 'codex', 'powershell'])
  })

  test('slot metas of a registered and an unregistered agent both read', () => {
    installSlot(home, 'slot-claude.json', home)
    installSlot(home, 'slot-codex.json', home)
    assert.equal(readSlot(home, 'a1b2c3d4')!.agent, 'claude')
    assert.deepEqual(readSlot(home, 'e5f6a7b8')!.args, ['--model', 'x'])
    assert.deepEqual(listSlots(home).map((m) => m.slotId).sort(), ['a1b2c3d4', 'e5f6a7b8'])
  })
})

describe('tetherd with an unregistered agent', () => {
  let home: string
  let daemon: Daemon
  before(async () => {
    home = tempHome()
    installSlot(home, 'slot-claude.json', home)
    installSlot(home, 'slot-codex.json', home)
    daemon = await startDaemon({ home, pipe: uniquePipe(home), adapters: { claude: fakeAdapter('claude') }, readyFallbackMs: 60_000, minAgentAgeMs: 0 })
  })
  after(async () => {
    await daemon.close()
    await removeHome(home)
  })

  test('the slot stays listed as agent-unavailable; start is refused with that code; others are untouched', async () => {
    const c = await Recorder.connect(daemon.pipe)
    try {
      const slots = (await c.client.request({ t: 'list' })).slots!
      const codex = slots.find((s) => s.slotId === 'e5f6a7b8')!
      assert.equal(codex.kind, 'codex')
      assert.equal(codex.status, 'error')
      assert.equal(codex.error?.code, 'agent-unavailable')
      assert.equal(slots.find((s) => s.slotId === 'a1b2c3d4')!.status, 'exited')
      await assert.rejects(c.client.request({ t: 'start', slotId: 'e5f6a7b8' }), (e: Error & { code?: string }) => e.code === 'agent-unavailable')
      await assert.rejects(c.client.request({ t: 'create', kind: 'codex', cwd: home }), (e: Error & { code?: string }) => e.code === 'bad-request')
      assert.ok(readSlot(home, 'e5f6a7b8'), 'the meta is still on disk')
    } finally {
      c.close()
    }
  })
})

describe('daemon extension host', () => {
  test('the committed index holds the built-in agents, claude then soul (slice 4), then web-bridge (F7 C2)', () => {
    assert.deepEqual(daemonIndex.map((e) => e.manifest.id), ['claude', 'soul', 'faults', 'web-bridge'])
  })

  test('an extension registers an agent, a launch middleware and a slot listener; dispose undoes them', async () => {
    const registry = agentRegistry
    const seen: Array<{ kind: string; slot: SlotState }> = []
    const ext: ExtensionEntry<TetherDaemon> = {
      manifest: { id: 'testagent', version: '0.0.1', displayName: 'Test agent', hosts: ['daemon'] },
      activate: (api) => [
        api.agents.register(contribution('testagent')),
        api.launch.use((plan) => ({ ...plan, env: { ...plan.env, TETHER_TEST_MW: '1' } })),
        api.onSlot((ev) => seen.push(ev)),
      ],
    }
    const broken: ExtensionEntry<TetherDaemon> = {
      manifest: { id: 'broken', version: '0.0.1', displayName: 'Broken', hosts: ['daemon'], requires: ['missing'] },
      activate: () => { throw new Error('never') },
    }
    const logs: string[] = []
    const host = new DaemonExtensionHost({ home: fixtures, log: (m) => logs.push(m), extensions: [broken, ext] })
    host.activate()
    assert.deepEqual(host.activated, ['testagent'])
    assert.deepEqual(host.failed.map((f) => f.id), ['broken'])
    assert.ok(registry.has('testagent'))

    const home = tempHome()
    let plans: LaunchPlan[] = []
    const daemon = await startDaemon({
      home, pipe: uniquePipe(home), readyFallbackMs: 60_000, minAgentAgeMs: 0,
      transformPlan: (plan, meta) => { const out = host.transformPlan(plan, meta); plans.push(out); return out },
      onSlot: host.emitSlot,
    })
    const c = await Recorder.connect(daemon.pipe)
    try {
      const { slot } = await c.client.request({ t: 'create', kind: 'testagent', cwd: home, start: true })
      assert.equal(slot!.kind, 'testagent')
      assert.equal(slot!.status, 'starting')
      assert.equal(plans[0]!.env.TETHER_TEST_MW, '1')
      await waitUntil(() => seen.some((e) => e.kind === 'spawned' && e.slot.slotId === slot!.slotId), 5_000, 'spawned event')
      await c.client.request({ t: 'stop', slotId: slot!.slotId })
      await waitUntil(() => seen.some((e) => e.kind === 'exited' && e.slot.slotId === slot!.slotId), 10_000, 'exited event')
    } finally {
      c.close()
      await daemon.close()
      host.dispose()
      await removeHome(home)
    }
    assert.equal(registry.has('testagent'), false)
    plans = []
  })
})
