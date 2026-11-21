// The agent door's verbs (slice D4) in a real tetherd on a test home and test pipe: an extension registers a verb, `verb-list`
// shows it, `tether <ns> <verbo>` runs it with the right caller, and the slot key proves the identity without ever being
// written anywhere. The real user's home, pipe and tetherd are never touched.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import { main } from '../../src/cli/main.ts'
import { cmdVerb, type VerbIo } from '../../src/cli/verb.ts'
import { DaemonClient, DaemonError } from '../../src/daemon/client.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import type { LaunchContext } from '../../src/daemon/door/port.ts'
import { ENV_SLOT_KEY, type VerbCaller } from '../../src/daemon/door/types.ts'
import type { LaunchPlan } from '../../src/agents/types.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { Recorder, removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

/** A door that remembers the key it put in the last launch's env, only so the test can try it and hunt for it on disk. */
class SpyDoor extends DoorHost {
  lastKey: string | undefined
  override prepareLaunch(plan: LaunchPlan, ctx: LaunchContext) {
    const grant = super.prepareLaunch(plan, ctx)
    this.lastKey = grant.plan.env[ENV_SLOT_KEY]
    return grant
  }
}

function walk(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, into)
    else into.push(p)
  }
  return into
}

describe('agent door verbs (D4)', () => {
  let home: string
  let daemon: Daemon
  let rec: Recorder
  const logs: string[] = []
  const door = new SpyDoor({ log: (m) => logs.push(m) })
  const own = new DisposableStore()
  const calls: { caller: VerbCaller; args: Record<string, unknown> }[] = []

  before(async () => {
    home = tempHome()
    daemon = await startDaemon({ home, pipe: uniquePipe(home), memoryIntervalMs: 0, door, log: (m) => logs.push(m) })
    rec = await Recorder.connect(daemon.pipe)
    const api = door.apiFor('probe', own)
    api.verbs.register({
      ns: 'probe', name: 'echo', description: 'echo', help: 'repete o texto',
      input: { type: 'object', properties: { text: { type: 'string' }, loud: { type: 'boolean' } }, required: ['text'] },
      positional: ['text'],
      run: (caller, args) => { calls.push({ caller, args }); return { text: String(args.text), data: { echoed: args.text } } },
    })
    // A verb in the namespace of a built-in command: the built-in must win.
    api.verbs.register({ ns: 'ls', name: 'sombra', description: 'x', help: 'x', input: { type: 'object', properties: {} }, run: (caller, args) => { calls.push({ caller, args }); return { text: 'sombra' } } })
  })
  after(async () => {
    own.dispose()
    rec?.close()
    await daemon?.close()
    await removeHome(home)
  })

  const io = (env: NodeJS.ProcessEnv): VerbIo & { stdout: string; stderr: string } => {
    const r = {
      stdout: '', stderr: '', env,
      out: (t: string) => { r.stdout += t }, err: (t: string) => { r.stderr += t },
      connect: async () => await DaemonClient.open(daemon.pipe, 'cli'),
    }
    return r
  }

  test('verb-list shows the registered verb (and not a duplicate registration); a foreign namespace is refused', async () => {
    const reply = await rec.client.request({ t: 'verb-list' })
    const echo = reply.verbs?.find((v) => v.ns === 'probe' && v.name === 'echo')
    assert.deepEqual(echo?.positional, ['text'])
    assert.equal(echo?.help, 'repete o texto')
    const other = door.apiFor('other', new DisposableStore())
    assert.throws(() => other.verbs.register({ ns: 'probe', name: 'x', description: '', help: '', input: {}, run: () => ({ text: '' }) }), /é da extensão probe/)
    assert.throws(() => door.apiFor('probe', new DisposableStore()).verbs.register({ ns: 'probe', name: 'echo', description: '', help: '', input: {}, run: () => ({ text: '' }) }), /já está registrado/)
    assert.throws(() => door.apiFor('probe', new DisposableStore()).verbs.register({ ns: 'Probe', name: 'x', description: '', help: '', input: {}, run: () => ({ text: '' }) }), /inválido/)
  })

  test('over the pipe: unknown verb and unknown slot keep their codes; a disposed verb leaves the list', async () => {
    await assert.rejects(rec.client.request({ t: 'verb', ns: 'probe', name: 'nope', args: {}, slotId: 'x' }), (e: unknown) => e instanceof DaemonError && e.code === 'unknown-verb')
    await assert.rejects(rec.client.request({ t: 'verb', ns: 'probe', name: 'echo', args: {}, slotId: 'ghost' }), (e: unknown) => e instanceof DaemonError && e.code === 'unknown-slot')
    const tmp = door.apiFor('probe', new DisposableStore()).verbs.register({ ns: 'probe', name: 'brief', description: '', help: '', input: {}, run: () => ({ text: '' }) })
    assert.ok((await rec.client.request({ t: 'verb-list' })).verbs?.some((v) => v.name === 'brief'))
    tmp.dispose()
    assert.ok(!(await rec.client.request({ t: 'verb-list' })).verbs?.some((v) => v.name === 'brief'))
  })

  test('a real launch: the key is in the env, proves the slot, and appears in no log and no file; it dies with the run', async () => {
    const { slot } = await rec.client.request({ t: 'create', kind: 'shell', cwd: home, name: 'chave' })
    assert.ok(slot)
    await rec.client.request({ t: 'start', slotId: slot.slotId })
    await waitUntil(() => door.lastKey !== undefined, 15_000, 'launch with a slot key')
    const key = door.lastKey!
    assert.ok(key.length >= 32)
    await rec.state(slot.slotId, (s) => s.status === 'running', 20_000, 'running')

    const ok = io({ TETHER_SLOT_ID: slot.slotId, [ENV_SLOT_KEY]: key })
    assert.equal(await cmdVerb('probe', ['echo', 'olá', 'mundo', '--json'], ok), 0)
    assert.deepEqual(JSON.parse(ok.stdout), { echoed: 'olá mundo' })
    assert.equal(calls.at(-1)!.caller.proven, true)
    assert.equal(calls.at(-1)!.caller.slotId, slot.slotId)
    assert.equal(calls.at(-1)!.caller.via, 'cli')
    assert.equal(calls.at(-1)!.caller.state.slotId, slot.slotId)

    await cmdVerb('probe', ['echo', 'x'], io({ TETHER_SLOT_ID: slot.slotId, [ENV_SLOT_KEY]: key + 'x' }))
    assert.equal(calls.at(-1)!.caller.proven, false)
    await cmdVerb('probe', ['echo', 'x'], io({ TETHER_SLOT_ID: slot.slotId }))
    assert.equal(calls.at(-1)!.caller.proven, false)

    // The secret is nowhere: not in a log line, not in a file of the home.
    assert.ok(!logs.some((l) => l.includes(key)), 'key in a log line')
    const hits = walk(home).filter((f) => { try { return readFileSync(f).includes(key) } catch { return false } })
    assert.deepEqual(hits, [], 'key in a file')

    // It dies with the run: after forget, the same key proves nothing.
    await rec.client.request({ t: 'forget', slotId: slot.slotId })
    assert.equal(door.slotKeys.verify(slot.slotId, key), false)
  })

  test('a built-in command wins over a verb with the same namespace', async () => {
    const saved = { home: process.env.TETHER_HOME, pipe: process.env.TETHER_PIPE }
    process.env.TETHER_HOME = home
    process.env.TETHER_PIPE = daemon.pipe
    const written: string[] = []
    const realWrite = process.stdout.write
    // Keep only what `ls --json` prints; the test runner's own reporter output (also on stdout) goes through untouched.
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      const text = String(chunk)
      if (text.startsWith('[')) { written.push(text); return true }
      return (realWrite as (...a: unknown[]) => boolean).call(process.stdout, chunk, ...rest)
    }) as typeof process.stdout.write
    const before = calls.length
    let code: number
    try { code = await main(['ls', '--json']) } finally {
      process.stdout.write = realWrite
      if (saved.home === undefined) delete process.env.TETHER_HOME; else process.env.TETHER_HOME = saved.home
      if (saved.pipe === undefined) delete process.env.TETHER_PIPE; else process.env.TETHER_PIPE = saved.pipe
    }
    assert.equal(code, 0)
    const parsed = (t: string): unknown => { try { return JSON.parse(t) } catch { return undefined } }
    assert.ok(written.some((w) => Array.isArray(parsed(w))), 'ls printed the slot list')
    assert.equal(calls.length, before, 'the verb did not run')
  })
})
