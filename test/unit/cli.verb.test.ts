// `tether <ns> <verbo>` (src/cli/verb.ts) against a real VerbRegistry behind a fake client: no daemon, no pipe. The args the
// handler gets (positionals, flags, --json), the caller it sees (slot, proven) and the output.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { UsageError } from '../../src/cli/args.ts'
import { cmdVerb, verbsHelp, type VerbIo } from '../../src/cli/verb.ts'
import type { DaemonClient } from '../../src/daemon/client.ts'
import { SlotKeys } from '../../src/daemon/door/slot-key.ts'
import type { VerbCaller } from '../../src/daemon/door/types.ts'
import { VerbRegistry } from '../../src/daemon/door/verbs.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'

const state = (slotId: string): SlotState => ({ slotId, kind: 'shell', cwd: '.', folder: '.', status: 'running' })

function rig() {
  const keys = new SlotKeys()
  const reg = new VerbRegistry({ keys, stateOf: (id) => (id === 'ghost' ? undefined : state(id)) })
  const calls: { caller: VerbCaller; args: Record<string, unknown> }[] = []
  reg.register('x', {
    ns: 'agents', name: 'send', description: 'send', help: 'envia uma mensagem',
    input: { type: 'object', properties: { slot: { type: 'string' }, text: { type: 'string' }, n: { type: 'integer' }, loud: { type: 'boolean' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['slot', 'text'] },
    positional: ['slot', 'text'],
    run: (caller, args) => { calls.push({ caller, args }); return { text: 'enviado', data: { ok: true, args } } },
  })
  reg.register('x', {
    ns: 'agents', name: 'boom', description: 'boom', help: 'falha', input: { type: 'object', properties: {} },
    run: () => ({ text: 'deu ruim', isError: true }),
  })
  reg.register('x', { ns: 'agents', name: 'mcp-only', description: 'm', help: 'só tool', input: {}, exits: ['mcp'], run: () => ({ text: 'm' }) })
  const client = {
    request: async (req: { t: string }) => {
      const h = req.t === 'verb-list' ? reg.handleList : reg.handleRun
      return { t: 'ok', ...(await h(req as never, { client: 'cli' })) }
    },
    close: () => {},
  } as unknown as DaemonClient
  const io = (env: NodeJS.ProcessEnv): VerbIo & { stdout: string; stderr: string } => {
    const r = { stdout: '', stderr: '', env, out: (t: string) => { r.stdout += t }, err: (t: string) => { r.stderr += t }, connect: async () => client }
    return r
  }
  return { keys, reg, calls, io }
}

describe('cli: tether <ns> <verbo>', () => {
  test('positionals, flags and --json input reach the handler; the last text positional takes the rest of the words', async () => {
    const { calls, io } = rig()
    const r = io({ TETHER_SLOT_ID: 'me' })
    assert.equal(await cmdVerb('agents', ['send', 'alvo', 'olá,', 'tudo', 'bem?', '--n', '3', '--loud', '--tags', 'a', '--tags', 'b'], r), 0)
    assert.equal(r.stdout, 'enviado\n')
    assert.deepEqual(calls[0]!.args, { slot: 'alvo', text: 'olá, tudo bem?', n: 3, loud: true, tags: ['a', 'b'] })
    assert.equal(calls[0]!.caller.slotId, 'me')
    assert.equal(calls[0]!.caller.via, 'cli')

    // --json '{...}' is the args; positionals and flags override its keys.
    const r2 = io({ TETHER_SLOT_ID: 'me' })
    assert.equal(await cmdVerb('agents', ['send', '--json', '{"slot":"a","text":"t","n":1}', '--n', '2'], r2), 0)
    assert.deepEqual(calls[1]!.args, { slot: 'a', text: 't', n: 2 })
  })

  test('a bare --json prints the structured data', async () => {
    const { io } = rig()
    const r = io({ TETHER_SLOT_ID: 'me' })
    assert.equal(await cmdVerb('agents', ['send', 'a', 'b', '--json'], r), 0)
    assert.deepEqual(JSON.parse(r.stdout), { ok: true, args: { slot: 'a', text: 'b' } })
  })

  test('the right key proves the slot; a wrong or missing key still runs, unproven', async () => {
    const { keys, calls, io } = rig()
    const key = keys.issue('me')
    await cmdVerb('agents', ['send', 'a', 'b'], io({ TETHER_SLOT_ID: 'me', TETHER_SLOT_KEY: key }))
    await cmdVerb('agents', ['send', 'a', 'b'], io({ TETHER_SLOT_ID: 'me', TETHER_SLOT_KEY: 'errada' }))
    await cmdVerb('agents', ['send', 'a', 'b'], io({ TETHER_SLOT_ID: 'me' }))
    // The key of another slot does not prove this one.
    await cmdVerb('agents', ['send', 'a', 'b', '--slot', 'other'], io({ TETHER_SLOT_ID: 'me', TETHER_SLOT_KEY: key }))
    assert.deepEqual(calls.map((c) => c.caller.proven), [true, false, false, false])
    assert.equal(calls[3]!.caller.slotId, 'other')
    keys.revoke('me')
    await cmdVerb('agents', ['send', 'a', 'b'], io({ TETHER_SLOT_ID: 'me', TETHER_SLOT_KEY: key }))
    assert.equal(calls[4]!.caller.proven, false)
  })

  test('usage errors: unknown ns, unknown verb, missing required, no slot, bad number; CLI-hidden verbs do not exist', async () => {
    const { io } = rig()
    const env = { TETHER_SLOT_ID: 'me' }
    await assert.rejects(cmdVerb('nada', ['x'], io(env)), (e: unknown) => e instanceof UsageError && /comando desconhecido: nada/.test(e.message) && e.showUsage)
    await assert.rejects(cmdVerb('agents', ['voa'], io(env)), /verbo desconhecido: agents voa/)
    await assert.rejects(cmdVerb('agents', ['mcp-only'], io(env)), /verbo desconhecido/)
    await assert.rejects(cmdVerb('agents', ['send', 'a'], io(env)), /falta <text>/)
    await assert.rejects(cmdVerb('agents', ['send', 'a', 'b', '--n', 'x'], io(env)), /esperava um inteiro/)
    await assert.rejects(cmdVerb('agents', ['send', 'a', 'b'], io({})), /não sei qual é o painel/)
    await assert.rejects(cmdVerb('agents', ['send', 'a', 'b', '--zzz', '1'], io(env)), /opção desconhecida/)
  })

  test('an error result goes to stderr with exit 1; `tether <ns>` lists the namespace', async () => {
    const { io } = rig()
    const r = io({ TETHER_SLOT_ID: 'me' })
    assert.equal(await cmdVerb('agents', ['boom'], r), 1)
    assert.equal(r.stderr, 'deu ruim\n')
    const l = io({})
    assert.equal(await cmdVerb('agents', [], l), 0)
    assert.match(l.stdout, /agents send <slot> <text>/)
    assert.match(l.stdout, /agents boom/)
    assert.doesNotMatch(l.stdout, /mcp-only/)
  })

  test('without tetherd: an unknown command that says what a verb needs (usage error); verbsHelp is empty then', async () => {
    const r = { stdout: '', stderr: '', env: {}, out: () => {}, err: (t: string) => { r.stderr += t }, connect: async () => undefined }
    await assert.rejects(cmdVerb('agents', ['send'], r), (e: unknown) => e instanceof UsageError && /comando desconhecido: agents.*o tether precisa estar rodando/.test(e.message))
    assert.equal(await verbsHelp(async () => undefined), '')
  })
})
