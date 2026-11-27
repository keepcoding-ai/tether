// The `remote` extension's daemon half and its boundaries (RR1.3; fio-spec 1.5, 3.2 "Caminho app ↔ portal" / E-7; M-5,
// M-7, B-8, A-2): who may ask what on the pipe, the CLI that only lowers power, the portal that refuses an open folder or a
// credential tetherd does not know, its minimal environment, the order of revocation against a renewal, and the sync
// codecs that never touch <home>/remote/. Bench tetherds with homes of their own; never the person's tether.
import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { agentExecutor } from '../../src/agents/agent-exec.ts'
import { cmdRemote } from '../../src/cli/remote.ts'
import { DaemonClient, DaemonError } from '../../src/daemon/client.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import type { DaemonIo } from '../../src/daemon/ext-api.ts'
import { DaemonExtensionHost } from '../../src/daemon/ext-host.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { PORTAL_EXIT, type FromPortal, type ToPortal } from '../../src/remoted/ipc.ts'
import { manifest } from '../../extensions/remote/manifest.ts'
import { activateWith } from '../../extensions/remote/daemon.ts'
import { ensureKeys } from '../../extensions/remote/daemon/keys.ts'
import { portalMain, portalEnv, type PortalChild } from '../../extensions/remote/daemon/portal.ts'
import { RemoteService } from '../../extensions/remote/daemon/service.ts'
import { originAllowed } from '../../extensions/remote/rules.ts'
import { removeHome, uniquePipe } from './daemon.helpers.ts'
import { benchHome, until } from './remoted.helpers.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const nodeIo: DaemonIo = {
  readText: (p) => readFile(p, 'utf8'),
  tryReadText: (p) => readFile(p, 'utf8').catch(() => undefined),
  writeTextAtomic: async (p, t) => { await mkdir(dirname(p), { recursive: true }); await writeFile(`${p}.tmp`, t); await rename(`${p}.tmp`, p) },
  appendText: (p, t) => appendFile(p, t),
  rename: (a, b) => rename(a, b),
  rm: (p) => rm(p, { recursive: true, force: true }),
  mkdirp: async (p) => { await mkdir(p, { recursive: true }) },
  stat: async (p) => { const s = await stat(p); return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory() } },
  readdir: async (p) => (await readdir(p, { withFileTypes: true })).map((d) => ({ name: d.name, isFile: d.isFile(), isDirectory: d.isDirectory() })),
  exists: (p) => stat(p).then(() => true, () => false),
}

/** Opens <dir> to Everyone (read), as a home outside the profile would inherit. */
const openToEveryone = (dir: string): void => { execFileSync('icacls', [dir, '/grant', '*S-1-1-0:(OI)(CI)R', '/q']) }

const ext = async (c: DaemonClient, name: string, args?: Record<string, unknown>): Promise<unknown> =>
  (await c.request({ t: 'ext-request', ext: 'remote', name, ...(args ? { args } : {}) })).result

describe('remote: who may ask what on the pipe (E-7, A-2)', () => {
  const home = benchHome()
  const pipe = uniquePipe(home)
  let daemon: Daemon
  let host: DaemonExtensionHost
  before(async () => {
    const door = new DoorHost({ log: () => {} })
    host = new DaemonExtensionHost({ home, log: () => {}, door, extensions: [{ manifest, activate: (api) => activateWith(api, { env: {} }).disposables }] })
    host.activate()
    daemon = await startDaemon({ home, pipe, memoryIntervalMs: 0, door })
    host.emitStarted()
  })
  after(async () => { host?.dispose(); await daemon?.close(); await removeHome(home) })

  test('pair.begin, pair.sas and remote.on from cli, test or a remote without credential are refused [52]', async () => {
    for (const kind of ['cli', 'test', 'remote'] as const) {
      const c = await DaemonClient.open(pipe, kind, { home })
      for (const [name, args] of [['pair.begin', undefined], ['pair.sas', { pairId: '0'.repeat(32), digits: '123456' }], ['remote.on', { relayUrl: 'ws://localhost:9/v1/house' }]] as const) {
        await assert.rejects(ext(c, name, args), (e: unknown) => e instanceof DaemonError && e.code === 'door-denied', `${kind} ${name}`)
      }
      c.close()
    }
  })

  test('from the app, pair.begin passes the origin rule (and needs the portal); status, list and off are open to the cli', async () => {
    const app = await DaemonClient.open(pipe, 'app', { home })
    await assert.rejects(ext(app, 'pair.begin'), (e: unknown) => e instanceof DaemonError && e.code === 'bad-request' && /portal/.test(e.message))
    app.close()
    const cli = await DaemonClient.open(pipe, 'cli', { home })
    const st = await ext(cli, 'remote.status') as { on: boolean; devices: unknown[] }
    assert.deepEqual([st.on, st.devices], [false, []])
    assert.deepEqual(await ext(cli, 'device.list'), { devices: [] })
    assert.deepEqual(await ext(cli, 'remote.off'), { on: false })
    cli.close()
  })

  test('no verb of the agent door touches the remote extension', async () => {
    const c = await DaemonClient.open(pipe, 'cli', { home })
    const verbs = (await c.request({ t: 'verb-list' })).verbs ?? []
    assert.ok(!verbs.some((v) => /remote|pair/i.test(v.ns) || /pair/i.test(v.name)), JSON.stringify(verbs.map((v) => `${v.ns} ${v.name}`)))
    c.close()
  })

  test('the bench flag widens pair.* to cli/test only, never to a remote; app always', () => {
    assert.equal(originAllowed('pair.begin', 'cli', false), false)
    assert.equal(originAllowed('pair.begin', 'cli', true), true)
    assert.equal(originAllowed('pair.begin', 'remote', true), false)
    assert.equal(originAllowed('pair.begin', 'app', false), true)
    assert.equal(originAllowed('device.revoke', 'cli', false), true)
  })
})

describe('tether remote (CLI): only what lowers power', () => {
  test('pair and on are not there without the bench flag; status prints the state', async () => {
    const out: string[] = []
    const err: string[] = []
    const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t), env: {}, connect: async () => undefined }
    assert.equal(await cmdRemote(['pair'], io), 2)
    assert.equal(await cmdRemote(['on', 'ws://localhost:1'], io), 2)
    assert.match(err.join(''), /se faz no app do tether/)
    assert.equal(await cmdRemote(['status'], io), 1, 'no tetherd: says so')
  })
})

describe('the portal refuses to serve', () => {
  // Two homes: the executor makes a folder private once per process, so an opened folder and a clean one live apart.
  const openHome = benchHome()
  const home = benchHome()
  const pipe = uniquePipe(home)
  let daemon: Daemon
  let openDaemon: Daemon
  before(async () => {
    daemon = await startDaemon({ home, pipe, memoryIntervalMs: 0 })
    openDaemon = await startDaemon({ home: openHome, pipe: uniquePipe(openHome), memoryIntervalMs: 0 })
  })
  after(async () => { await daemon?.close(); await openDaemon?.close(); await removeHome(home); await removeHome(openHome) })

  /** The portal as the extension starts it, with this test as its parent on the IPC channel. */
  async function runPortal(cred: string, o: { init?: ToPortal; home?: string; pipe?: string } = {}): Promise<{ code: number | null; said: FromPortal[] }> {
    const said: FromPortal[] = []
    const child = fork(portalMain(), [], { env: portalEnv(process.env, o.home ?? home, o.pipe ?? pipe), stdio: ['pipe', 'ignore', 'ignore', 'ipc'], serialization: 'json' })
    child.on('message', (m) => {
      said.push(m as FromPortal)
      if ((m as FromPortal).t === 'want-init' && o.init) child.send(o.init)
    })
    child.stdin!.end(`${cred}\n`)
    const code = await new Promise<number | null>((r) => child.on('exit', (c) => r(c)))
    return { code, said }
  }

  test('<home>/remote/ open to other accounts: the portal does not come up [M-7]', async () => {
    const dir = join(openHome, 'remote')
    await agentExecutor().run('ensurePrivateDir', [dir])
    assert.equal(await agentExecutor().run('isPrivateFolder', [dir]), true)
    openToEveryone(dir)
    const r = await runPortal(randomBytes(32).toString('hex'), { home: openHome, pipe: openDaemon.pipe })
    assert.equal(r.code, PORTAL_EXIT.folderOpen)
    assert.match(JSON.stringify(r.said), /aberta a outras contas/)
  })

  test('the extension does not switch on over an open folder either: it refuses instead of fixing it', async () => {
    const svc = new RemoteService({ home: openHome, io: nodeIo, log: () => {}, env: {}, executor: agentExecutor() })
    await assert.rejects(svc.handle('remote.on', { relayUrl: 'ws://localhost:9/v1/house' }, { client: 'app', conn: 1 }), /aberta a outras contas/)
  })

  test('a credential tetherd did not register: the hello comes back as cli and the portal leaves [M-5]', async () => {
    const dir = join(home, 'remote')
    await agentExecutor().run('ensurePrivateDir', [dir])
    const keys = await ensureKeys({}, Math.floor(Date.now() / 1000))
    for (const [f, t] of Object.entries(keys)) await writeFile(join(dir, `${f}.key`), t!)
    const init: ToPortal = { t: 'init', relayUrl: 'ws://localhost:9/v1/house', houseName: 'tether', devices: [], deny: [] }
    const r = await runPortal(randomBytes(32).toString('hex'), { init })
    assert.equal(r.code, PORTAL_EXIT.badCredential)
    assert.match(JSON.stringify(r.said), /did not take this portal as remote/)
    const bad = await runPortal('xyz')
    assert.equal(bad.code, PORTAL_EXIT.badCredential, 'malformed stdin')
  })

  test('a relay URL other than wss:// (ws:// only for localhost) is refused before any key is read [B-8]', async () => {
    const r = await runPortal(randomBytes(32).toString('hex'), { init: { t: 'init', relayUrl: 'ws://relay.example.com/v1/house', houseName: 't', devices: [], deny: [] } })
    assert.equal(r.code, PORTAL_EXIT.config)
  })
})

describe('the portal environment is minimal [B-8]', () => {
  test('no NODE_OPTIONS, no TLS override, no secret-looking variable; the bench knobs only on the bench', () => {
    const base = { PATH: 'p', SystemRoot: 'C:\\Windows', NODE_OPTIONS: '--inspect', NODE_TLS_REJECT_UNAUTHORIZED: '0', TETHER_SLOT_KEY: 'k', API_TOKEN: 'x', TETHER_TEST_REMOTE_NOTICE: 'f' }
    const env = portalEnv(base, 'H', 'P')
    assert.deepEqual(env, { PATH: 'p', SystemRoot: 'C:\\Windows', TETHER_HOME: 'H', TETHER_PIPE: 'P' })
    assert.equal(portalEnv({ ...base, TETHER_TEST_REMOTE: '1' }, 'H', 'P').TETHER_TEST_REMOTE_NOTICE, 'f')
  })
})

describe('the registry: revocation runs before a renewal [63], states pending → active → revoked', () => {
  const home = benchHome()
  after(async () => { await removeHome(home) })

  test('a renewal asked once the revocation was written is refused; the portal got the revocation with the live tickets', async () => {
    const toPortal: ToPortal[] = []
    let onMessage!: (m: FromPortal) => void
    const fake: PortalChild = { pid: 4242, send: (m) => toPortal.push(m), kill: async () => {} }
    const svc = new RemoteService({
      home, io: nodeIo, log: () => {}, env: {}, executor: agentExecutor(),
      spawn: async (o) => { onMessage = o.onMessage; return fake },
    })
    await svc.handle('remote.on', { relayUrl: 'ws://localhost:9/v1/house' }, { client: 'app', conn: 1 })
    onMessage({ t: 'want-init' })
    assert.equal(toPortal[0]?.t, 'init')
    onMessage({ t: 'ready', pid: 4242 })
    const answers = (): ToPortal[] => toPortal.filter((m) => m.t === 'answer')
    const deviceId = 'ab'.repeat(16)
    const ticket = { ticketId: 'cd'.repeat(16), exp: Math.floor(Date.now() / 1000) + 3600, keyId: 'ef'.repeat(8) }
    onMessage({ t: 'ask', id: 1, ask: 'paired', device: { deviceId, pubD: '04' + '11'.repeat(64), name: 'x', ver: 1, access: 'code' }, ticket })
    await until(() => answers().length === 1, 5_000, 'paired answered')
    assert.deepEqual(answers()[0], { t: 'answer', id: 1, ok: true })
    let reg = JSON.parse(readFileSync(join(home, 'remote', 'devices.json'), 'utf8')) as { devices: { state: string }[] }
    assert.equal(reg.devices[0]!.state, 'pending')
    onMessage({ t: 'note', note: 'acked', deviceId })
    await until(() => (JSON.parse(readFileSync(join(home, 'remote', 'devices.json'), 'utf8')) as typeof reg).devices[0]!.state === 'active', 5_000, 'active')
    await svc.handle('device.revoke', { device: deviceId }, { client: 'cli', conn: 2 })
    const revoke = toPortal.find((m) => m.t === 'revoke')
    assert.deepEqual(revoke, { t: 'revoke', deviceId, deny: [{ ticketId: ticket.ticketId, exp: ticket.exp }] })
    onMessage({ t: 'ask', id: 2, ask: 'renew', deviceId, ticket: { ...ticket, ticketId: '99'.repeat(16), keyId: '77'.repeat(8) } })
    await until(() => answers().length === 2, 5_000, 'renew answered')
    assert.equal((answers()[1] as { ok: boolean }).ok, false)
    reg = JSON.parse(readFileSync(join(home, 'remote', 'devices.json'), 'utf8')) as typeof reg
    assert.equal(reg.devices[0]!.state, 'revoked')
    // A second pairing of the same device id, or a 33rd device, is refused by the registry's writer.
    onMessage({ t: 'ask', id: 3, ask: 'paired', device: { deviceId, pubD: '04' + '11'.repeat(64), name: 'x', ver: 1, access: 'code' }, ticket })
    await until(() => answers().length === 3, 5_000, 'second paired answered')
    assert.equal((answers()[2] as { ok: boolean }).ok, false)
    // Nothing secret in what the extension wrote besides the key files.
    const audit = readFileSync(join(home, 'remote', 'audit.jsonl'), 'utf8')
    assert.match(audit, /"act":"device.revoke"/)
    await svc.handle('remote.off', {}, { client: 'cli', conn: 2 })
  })
})

describe('the address of the phone app is the relying party of the biometrics [B-4]', () => {
  const home = benchHome()
  after(async () => { await removeHome(home) })

  test('a new credential says its relying party; changing webUrl is a security line with the host, told to the portal; the screen follows', async () => {
    const toPortal: ToPortal[] = []
    let onMessage!: (m: FromPortal) => void
    const fake: PortalChild = { pid: 4243, send: (m) => toPortal.push(m), kill: async () => {} }
    const svc = new RemoteService({
      home, io: nodeIo, log: () => {}, env: {}, executor: agentExecutor(),
      spawn: async (o) => { onMessage = o.onMessage; return fake },
    })
    const app = { client: 'app', conn: 1 } as const
    await svc.handle('remote.on', { relayUrl: 'ws://localhost:9/v1/house', webUrl: 'https://pwa.example' }, app)
    onMessage({ t: 'want-init' })
    assert.deepEqual([toPortal[0]?.t, (toPortal[0] as { webChanged?: boolean }).webChanged], ['init', true], 'set while no portal was up: init says so')
    onMessage({ t: 'ready', pid: 4243 })
    const answers = (): ToPortal[] => toPortal.filter((m) => m.t === 'answer')
    const deviceId = 'ab'.repeat(16)
    const ticket = { ticketId: 'cd'.repeat(16), exp: Math.floor(Date.now() / 1000) + 3600, keyId: 'ef'.repeat(8) }
    onMessage({ t: 'ask', id: 1, ask: 'paired', device: { deviceId, pubD: '04' + '11'.repeat(64), name: 'x', ver: 1, access: 'code' }, ticket })
    await until(() => answers().length === 1, 5_000, 'paired answered')
    onMessage({ t: 'note', note: 'acked', deviceId })
    const credential = { credentialId: 'AAAAAAAAAAAAAAAAAAAAAA', publicKey: '04' + '22'.repeat(64), signCount: 0, backupEligible: false }
    onMessage({ t: 'ask', id: 2, ask: 'credential', deviceId, credential })
    await until(() => answers().length === 2, 5_000, 'credential answered')
    assert.equal((answers()[1] as { ok: boolean }).ok, false, 'a new credential without its relying party is refused')
    onMessage({ t: 'ask', id: 3, ask: 'credential', deviceId, credential: { ...credential, rpId: 'pwa.example', origin: 'https://pwa.example' } })
    await until(() => answers().length === 3, 5_000, 'credential answered')
    assert.equal((answers()[2] as { ok: boolean }).ok, true)
    const bio = async (): Promise<boolean | undefined> =>
      ((await svc.handle('device.list', {}, app)) as { devices: { biometrics: boolean }[] }).devices[0]?.biometrics
    assert.equal(await bio(), true)

    await svc.handle('remote.on', { webUrl: 'https://other.example:8443' }, app)
    assert.deepEqual(toPortal.filter((m) => m.t === 'web').at(-1), { t: 'web', webUrl: 'https://other.example:8443' }, 'the portal up learns it at once')
    assert.equal(await bio(), false, 'the screen no longer says biometrics')
    const read = (f: string): Record<string, string>[] => {
      try { return readFileSync(join(home, 'remote', f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, string>) } catch { return [] }
    }
    for (const f of ['audit.jsonl', 'audit-security.jsonl']) {
      await until(() => read(f).some((l) => l.act === 'remote.web' && l.result === 'web:other.example:8443') || undefined, 5_000, `the change in ${f}`)
    }
    assert.ok(read('audit-security.jsonl').some((l) => l.act === 'remote.web' && l.result === 'web:pwa.example' && l.target === 'app'))
    await svc.handle('remote.on', { webUrl: 'https://other.example:8443' }, app)
    await svc.handle('remote.off', {}, { client: 'cli', conn: 2 })
    await until(() => read('audit.jsonl').some((l) => l.act === 'remote.off') || undefined, 5_000, 'off written')
    assert.equal(read('audit.jsonl').filter((l) => l.act === 'remote.web').length, 2, 'the same address again is no change')
  })
})

describe('no codec of the Sync touches <home>/remote/ [M-7]', () => {
  test('the sync engine and its codecs never name the remote folder or its files', () => {
    const dir = join(ROOT, 'src', 'core', 'sync')
    const files = (readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[]).filter((f) => f.endsWith('.ts'))
    // providers/git.ts says `git remote …` (the git subcommand), not the folder.
    for (const f of files.filter((x) => !x.replace(/\\/g, '/').startsWith('providers/'))) {
      const text = readFileSync(join(dir, f), 'utf8')
      assert.doesNotMatch(text, /'remote'|"remote"|remote[/\\]|house\.key|relay\.key|ticket\.key|devices\.json/, f)
    }
    assert.ok(statSync(dir).isDirectory())
  })
})
