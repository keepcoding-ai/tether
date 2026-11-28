// RR5, the processes created from afar, at tetherd itself (a bench tetherd with a portal credential of its own and a
// tether-procd host in this process; never the person's tether). Proved here, on the pipe the portal uses:
// - M-2: a `remote` client's `proc-start` with a recipe counts against the ceilings of src/daemon/afar-caps.ts: six new
//   processes an hour per device, twelve for the house, refused `too-many` past them; its card is marked `fromAfar`; what
//   the person starts on the machine (`cli`) is not counted.
// - B-3: a `remote` `proc-start` with a recipe for a name that has a process (stopped or running) is `proc-exists`, refused
//   in the name's lock: the card stays, the history gets no `recipe-changed`, and no env value of the act reaches either.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { procCardPath } from '../../src/core/paths.ts'
import { DaemonClient, DaemonError } from '../../src/daemon/client.ts'
import { setPortalCredential } from '../../src/daemon/handshake.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { HostClient } from '../../src/procd/client.ts'
import { ProcHost } from '../../src/procd/host.ts'
import { hostStore } from '../../src/procd/run-store.ts'
import { removeHome, uniquePipe } from './daemon.helpers.ts'
import { benchHome } from './remoted.helpers.ts'

const refused = (c: string) => (e: unknown): boolean => e instanceof DaemonError && e.code === c
const dev = (ch: string): string => ch.repeat(32)

describe('tetherd: processes created from afar', () => {
  const home = benchHome('tether-procs-afar-')
  const hostPipe = uniquePipe(home)
  const cred = randomBytes(32)
  let host: ProcHost
  let daemon: Daemon
  let remote: DaemonClient
  let cli: DaemonClient
  // A process that ends at once: the ceilings count what is created, not what runs (the live one is proved by AfarCaps).
  const recipe = (over: Record<string, unknown> = {}) => ({ command: 'node', args: ['-e', ''], cwd: home, env: {}, ports: [], ...over })

  before(async () => {
    host = new ProcHost({ home, pipe: hostPipe, store: hostStore })
    await host.listen()
    const pipe = uniquePipe(home)
    daemon = await startDaemon({ home, pipe, memoryIntervalMs: 0, connectProcHost: () => HostClient.open(hostPipe), procHostReconnectMs: 300, log: () => {} })
    setPortalCredential(home, cred)
    remote = await DaemonClient.open(pipe, 'remote', { home, cred: cred.toString('hex') })
    cli = await DaemonClient.open(pipe, 'cli', { home })
  })
  after(async () => {
    remote?.close(); cli?.close()
    setPortalCredential(home, undefined)
    await daemon?.close()
    await host?.close()
    await removeHome(home)
  })

  /** A new process from afar, and its end (so the live ceiling, eight, is not what refuses here). */
  const make = async (name: string, device?: string): Promise<void> => {
    const r = await remote.request({ t: 'proc-start', name, recipe: recipe(), ...(device ? { device } : {}) } as never)
    assert.equal(r.proc!.name, name)
    for (let i = 0; i < 100; i++) {
      if ((await cli.request({ t: 'proc-info', name })).proc!.status !== 'running') return
      await new Promise((res) => setTimeout(res, 50))
    }
    throw new Error(`${name} did not end`)
  }

  test('M-2: six new processes an hour per device, twelve for the house; past them too-many, nothing registered', async () => {
    for (let i = 1; i <= 6; i++) await make(`a${i}`, dev('a'))
    await assert.rejects(remote.request({ t: 'proc-start', name: 'a7', recipe: recipe(), device: dev('a') } as never), refused('too-many'))
    await assert.rejects(cli.request({ t: 'proc-info', name: 'a7' }), refused('unknown-proc'), 'nothing registered')
    const card = JSON.parse(readFileSync(procCardPath(home, 'a1'), 'utf8')) as { fromAfar?: unknown }
    assert.equal(card.fromAfar, true, 'the card says it came from afar')
    for (let i = 1; i <= 6; i++) await make(`b${i}`, dev('b'))
    await assert.rejects(remote.request({ t: 'proc-start', name: 'c1', recipe: recipe(), device: dev('c') } as never), refused('too-many'), 'the house took twelve this hour')
    await assert.rejects(remote.request({ t: 'proc-start', name: 'c2', recipe: recipe() } as never), refused('too-many'), 'a remote without a device is the unnamed one, same house')
    // The person on the machine is not counted, and her card has no mark.
    const mine = await cli.request({ t: 'proc-start', name: 'meu', recipe: { command: 'node', args: ['-e', ''], cwd: home } })
    assert.equal(mine.proc!.name, 'meu')
    assert.equal((JSON.parse(readFileSync(procCardPath(home, 'meu'), 'utf8')) as { fromAfar?: unknown }).fromAfar, undefined)
  })

  test('B-3: a recipe from afar never replaces an existing process\'s, stopped or running: proc-exists, the card and history untouched', async () => {
    const CANARY = 'canario-da-bancada'
    // The agent's (or the person's) process, stopped: its recipe on the card.
    await cli.request({ t: 'proc-start', name: 'web', recipe: { command: 'node', args: ['-e', ''], cwd: home } })
    for (let i = 0; i < 100 && (await cli.request({ t: 'proc-info', name: 'web' })).proc!.status === 'running'; i++) await new Promise((res) => setTimeout(res, 50))
    const card = readFileSync(procCardPath(home, 'web'), 'utf8')
    await assert.rejects(remote.request({ t: 'proc-start', name: 'web', recipe: recipe({ env: { BENCH_MODE: CANARY } }), device: dev('d') } as never), refused('proc-exists'))
    assert.equal(readFileSync(procCardPath(home, 'web'), 'utf8'), card, 'the card is the same')
    const info = await cli.request({ t: 'proc-info', name: 'web' })
    assert.equal(info.events!.some((e) => e.kind === 'recipe-changed'), false, 'no recipe-changed in the history')
    assert.equal(JSON.stringify(info).includes(CANARY), false, 'no value of the env from afar reaches the history nor the card')
    // Running: the same refusal (never `proc-running`, which would tell less).
    await cli.request({ t: 'proc-start', name: 'vivo', recipe: { command: 'node', args: ['-e', 'setInterval(() => {}, 1000)'], cwd: home } })
    try {
      await assert.rejects(remote.request({ t: 'proc-start', name: 'vivo', recipe: recipe({ env: { BENCH_MODE: CANARY } }) } as never), refused('proc-exists'))
    } finally { await cli.request({ t: 'proc-stop', name: 'vivo' }) }
    // From afar, starting the stored recipe (no recipe in the act) is still what `procs.start` does.
    const started = await remote.request({ t: 'proc-start', name: 'web' } as never)
    assert.equal(started.proc!.name, 'web')
    assert.equal(JSON.stringify(await cli.request({ t: 'proc-info', name: 'web' })).includes(CANARY), false)
  })
})
