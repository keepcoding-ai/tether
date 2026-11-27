// RR1 step 1.3 on the bench: a tetherd of its own (home under TETHER_BENCH_DIR or the system temp, never the person's),
// the `remote` extension, the real portal process (src/remoted/main.ts), a fake relay in this process that checks the
// house and repasses frames, and a test device made of DevicePairing / DeviceHandshake. Played in order: switch on,
// pair with the SAS typed on the house's side, persist, open sessions, list who waits (a fake slot in `waiting`), the
// gate of the operations table, renewal, reconnection after a network cut, revocation, the portal's credential, the
// canary, idle expiry and off. Numbers in [brackets] are the negative tests of fio-spec 9.2.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { DaemonClient, DaemonError } from '../../src/daemon/client.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import { DaemonExtensionHost } from '../../src/daemon/ext-host.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { b64url, fromB64url, generateRoleKey, PRESENCE, RES_STATUS, toHex } from '../../src/remote/index.ts'
import { manifest } from '../../extensions/remote/manifest.ts'
import { activateWith } from '../../extensions/remote/daemon.ts'
import { removeHome, uniquePipe } from './daemon.helpers.ts'
import { benchHome, FakeRelay, TestDevice, until, type DeviceSession } from './remoted.helpers.ts'

const OP = { info: 0x0001, renew: 0x0002, register: 0x0005, revokeSelf: 0x0006, list: 0x0100, watch: 0x0101, deviceList: 0x0600, deviceRevoke: 0x0601 }
const CANARY = `canario-${randomBytes(6).toString('hex')}`

const ext = async (c: DaemonClient, name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (await c.request({ t: 'ext-request', ext: 'remote', name, ...(args ? { args } : {}) })).result as Record<string, unknown>

describe('remote portal on the bench (RR1.3)', () => {
  const home = benchHome()
  const pipe = uniquePipe(home)
  const noticeFile = join(home, 'notices.txt')
  const logs: string[] = []
  const env: NodeJS.ProcessEnv = {
    ...process.env, TETHER_TEST_REMOTE: '1', TETHER_TEST_REMOTE_NOTICE: noticeFile, TETHER_TEST_REMOTE_TICK_MS: '200',
    TETHER_TEST_REMOTE_DENY_AFTER_MS: '1500', API_SECRET_TOKEN: CANARY, NODE_TLS_REJECT_UNAUTHORIZED: '0',
  }
  const door = new DoorHost({ log: () => {} })
  let daemon: Daemon
  let extHost: DaemonExtensionHost
  let relay: FakeRelay
  let app: DaemonClient
  let cli: DaemonClient
  let device: TestDevice
  let fresh: DeviceSession
  let pairCode = ''
  let sasShown = ''
  const pipeLines: string[] = []

  before(async () => {
    relay = await FakeRelay.start()
    extHost = new DaemonExtensionHost({
      home, log: (m) => logs.push(m), door,
      extensions: [{ manifest, activate: (api) => activateWith(api, { env }).disposables }],
    })
    extHost.activate()
    daemon = await startDaemon({ home, pipe, memoryIntervalMs: 0, door, log: (m) => logs.push(m) })
    extHost.emitStarted()
    app = await DaemonClient.open(pipe, 'app', { home })
    cli = await DaemonClient.open(pipe, 'cli', { home })
    // A spy of the pipe: a greeted client that keeps every transmission it gets (E-7 (c), test 52).
    const spy = await DaemonClient.open(pipe, 'test', { home })
    for (const ev of ['state', 'removed', 'profiles', 'proc', 'desks', 'object', 'ext-event'] as const) {
      spy.on(ev as 'state', (...a: unknown[]) => pipeLines.push(JSON.stringify(a)))
    }
    device = await TestDevice.make(relay)
  })

  after(async () => {
    try { await ext(cli, 'remote.off') } catch { /* already off */ }
    app?.close()
    cli?.close()
    extHost?.dispose()
    await daemon?.close()
    await relay?.close()
    await removeHome(home)
  })

  test('remote.on from the app: <home>/remote/ is made private, the portal comes up and the relay admits the house', async () => {
    assert.deepEqual(await ext(app, 'remote.on', { relayUrl: relay.url }), { on: true })
    await until(() => relay.linkUp, 20_000, 'the house authenticated at the relay')
    const status = await ext(cli, 'remote.status')
    assert.equal(status.on, true)
    assert.equal((status.portal as { state: string }).state, 'up')
    assert.equal(status.link, 'up')
    assert.match(String(status.fingerprint), /^[a-z2-7]{4}( [a-z2-7]{4}){4}$/)
    // M-7: the folder grants nothing to anyone but the user (Windows: protected DACL, no inherited entry).
    if (process.platform === 'win32') {
      const dir = join(home, 'remote')
      const acl = execFileSync('icacls', [dir], { encoding: 'utf8' }).replace(dir, '') // the entries, not the path
      assert.doesNotMatch(acl, /\(I\)/, 'no inherited entry')
      assert.doesNotMatch(acl, /Everyone|Todos|Users|Usuários|Authenticated/i)
    }
    for (const f of ['house.key', 'relay.key', 'ticket.key', 'config.json']) assert.ok(existsSync(join(home, 'remote', f)), f)
  })

  test('the portal is the pipe client `remote` because it holds the credential; a hello as remote without it is cli [45]', async () => {
    const none = await DaemonClient.open(pipe, 'remote', { home })
    assert.equal(none.hello.client, 'cli')
    none.close()
    const wrong = await DaemonClient.open(pipe, 'remote', { home, cred: randomBytes(32).toString('hex') })
    assert.equal(wrong.hello.client, 'cli')
    wrong.close()
  })

  test('pairing: begun on the app (a native notice), the device shows the SAS, a wrong entry counts, the right one pairs and persists', async () => {
    const begun = await ext(app, 'pair.begin')
    pairCode = String(begun.code)
    assert.match(pairCode, /^\d{3} \d{3} \d{3} \d{3}$/)
    assert.match(String(begun.qr), /^#pair=[A-Za-z0-9_-]+$/)
    assert.equal(begun.state, 'open')
    await until(() => existsSync(noticeFile) && /pareamento de aparelho foi iniciado/.test(readFileSync(noticeFile, 'utf8')), 5_000, 'the native notice of pair.begin')
    // Another connection, even the app's kind, does not see or drive this ticket (E-7 (c)).
    const otherApp = await DaemonClient.open(pipe, 'app', { home })
    await assert.rejects(ext(otherApp, 'pair.state', { pairId: begun.pairId }), (e: unknown) => e instanceof DaemonError && e.code === 'door-denied')
    otherApp.close()

    const { sas, done } = await device.pair(pairCode, { name: 'Telefone‮de teste', caps: 0x01 })
    sasShown = await sas
    assert.match(sasShown, /^\d{6}$/)
    let view: Record<string, unknown> = {}
    for (let i = 0; i < 100 && view.state !== 'waiting-sas'; i++) { view = await ext(app, 'pair.state', { pairId: begun.pairId }); await new Promise((r) => setTimeout(r, 100)) }
    assert.equal(view.state, 'waiting-sas')
    assert.equal((view.device as { declaredName: string }).declaredName, 'Telefonede teste', 'the declared name is shown sanitized (no RLO)')
    const wrong = sasShown === '000000' ? '111111' : '000000'
    const afterWrong = await ext(app, 'pair.sas', { pairId: begun.pairId, digits: wrong })
    assert.equal(afterWrong.triesLeft, 2)
    await ext(app, 'pair.sas', { pairId: begun.pairId, digits: `${sasShown.slice(0, 3)} ${sasShown.slice(3)}` })
    const s = await done
    assert.ok(!('failed' in s), `paired: ${JSON.stringify(s)}`)
    fresh = s as DeviceSession
    for (let i = 0; i < 50 && view.state !== 'done'; i++) { view = await ext(app, 'pair.state', { pairId: begun.pairId }); await new Promise((r) => setTimeout(r, 100)) }
    assert.equal(view.state, 'done')
    const reg = JSON.parse(readFileSync(join(home, 'remote', 'devices.json'), 'utf8')) as { devices: { deviceId: string; state: string; pubD: string; name: string }[] }
    assert.equal(reg.devices.length, 1)
    assert.equal(reg.devices[0]!.state, 'active')
    assert.equal(reg.devices[0]!.deviceId, toHex(device.result!.deviceId))
    assert.equal(reg.devices[0]!.pubD, toHex(device.kD.pub))
    assert.match(readFileSync(noticeFile, 'utf8'), /foi pareado/)
  })

  test('the session that concluded the pairing answers session.info; uv.register is only for it, and without the PWA origin it registers nothing [42]', async () => {
    const info = await fresh.request(OP.info)
    assert.equal(info.status, RES_STATUS.ok)
    assert.equal(info.body.deviceId, toHex(device.result!.deviceId))
    const reg = await fresh.request(OP.register, {}, { actId: randomBytes(16) })
    assert.deepEqual([reg.status, reg.body.error], [RES_STATUS.failed, 'refused'])
  })

  let slotA = ''
  let session: DeviceSession

  test('a normal session: presence comes from the registry, not from `caps` [57]; uv.register outside fresh-pair is refused [42]', async () => {
    const s = await device.connect()
    assert.ok(!('failed' in s), `connected: ${JSON.stringify(s)}`)
    session = s as DeviceSession
    assert.equal(session.info!.presence, PRESENCE.noCredential, 'caps said "I have an authenticator", the registry has no credential')
    const reg = await session.request(OP.register, {}, { actId: randomBytes(16) })
    assert.equal(reg.status, RES_STATUS.presenceRequired)
  })

  test('attention.list and attention.watch: a fake slot in `waiting` shows by id, name, kind and since; nothing else of it', async () => {
    const profile = (await cli.request({ t: 'profile-save', profile: { name: 'Perfil canário', agent: 'shell', args: [CANARY], env: { API_TOKEN: CANARY } } })).profile!
    const cwd = join(home, `projeto-${CANARY}`)
    mkdirSync(cwd)
    slotA = (await cli.request({ t: 'create', kind: 'shell', cwd, name: 'Revisor', args: [CANARY], start: false, profileId: profile.id })).slot!.slotId
    await cli.request({ t: 'ronda-set', slotId: slotA, interval: '20m', nudge: `pedido ${CANARY}`, criterion: `pare ${CANARY}` }).catch(() => undefined)
    const watch = await session.request(OP.watch)
    assert.equal(watch.status, RES_STATUS.ok)
    door.port!.signal(slotA, 'waiting')
    const evt = await until(() => session.events.find((e) => (e.body.items as { id: string }[]).some((i) => i.id === slotA)), 10_000, 'attention.changed with the slot')
    assert.equal(evt.evt, 0x0100)
    const list = await session.request(OP.list)
    assert.equal(list.status, RES_STATUS.ok)
    const items = list.body.items as Record<string, unknown>[]
    const item = items.find((i) => i.id === slotA)!
    assert.deepEqual(Object.keys(item).sort(), ['id', 'kind', 'name', 'since'])
    assert.deepEqual([item.name, item.kind], ['Revisor', 'shell'])
    assert.doesNotMatch(JSON.stringify(list.body), new RegExp(CANARY))
  })

  test('the gate of the table: no line → 0x02, per-act without a credential → 0x05 [40], a line not served yet → not-implemented, strict body', async () => {
    assert.equal((await session.request(0x7777)).status, RES_STATUS.unknownOp)
    assert.equal((await session.request(OP.deviceRevoke, { deviceId: '00' }, { actId: randomBytes(16) })).status, RES_STATUS.presenceRequired)
    const dl = await session.request(OP.deviceList)
    assert.deepEqual([dl.status, dl.body.error], [RES_STATUS.failed, 'not-implemented'])
    assert.equal((await session.request(OP.list, { extra: 1 })).status, RES_STATUS.badRequest)
    assert.equal((await session.request(OP.renew, { pubA: 'x' })).status, RES_STATUS.badRequest, 'a mutating line without actId')
    assert.equal((await session.request(OP.info, {}, { raw: new TextEncoder().encode('[1]') })).status, RES_STATUS.badRequest)
  })

  test('admit.renew: one act per actId, the same answer [44]; the old ticket is refused once its deny is due [61]', async () => {
    const kA2 = (await generateRoleKey('admission')).key
    const actId = new Uint8Array(randomBytes(16))
    const a = await session.request(OP.renew, { pubA: b64url(kA2.pub) }, { actId })
    const b = await session.request(OP.renew, { pubA: b64url(kA2.pub) }, { actId })
    assert.equal(a.status, RES_STATUS.ok)
    assert.deepEqual(b, a)
    const reuse = await session.request(OP.renew, { pubA: b64url(device.kD.pub) }, { actId: randomBytes(16) })
    assert.equal(reuse.status, RES_STATUS.failed, 'pub_A = pub_D refused [47]')
    const oldTicket = device.result!.admitTicket
    const oldKA = device.kA
    device.renewed(fromB64url(String(a.body.ticket)), kA2)
    await new Promise((r) => setTimeout(r, 2_500)) // TETHER_TEST_REMOTE_DENY_AFTER_MS = 1500
    const withOld = new TestDevice(relay)
    withOld.kD = device.kD
    withOld.kA = oldKA
    withOld.result = { ...device.result!, admitTicket: oldTicket }
    assert.deepEqual(await withOld.connect(), { failed: 'relay-refused' })
    const ok = await device.connect()
    assert.ok(!('failed' in ok))
    ;(ok as DeviceSession).leg.close()
  })

  test('the network drops: the portal dials again, the house is admitted again and a device connects again', async () => {
    const before = relay.houseAuths
    relay.dropHouse()
    await until(() => session.closed, 5_000, 'the old session ends with its route')
    await until(() => relay.houseAuths > before && relay.linkUp, 20_000, 'the house back at the relay')
    const s = await device.connect()
    assert.ok(!('failed' in s), `reconnected: ${JSON.stringify(s)}`)
    session = s as DeviceSession
    assert.equal((await session.request(OP.info)).status, RES_STATUS.ok)
  })

  test('the fourth session of one device is refused (SESSIONS_PER_DEVICE) [62]', async () => {
    // The sessions closed by earlier tests must be gone from the house's count first (a ROUTE_CLOSE travels).
    for (let i = 0; i < 100 && (await ext(cli, 'remote.status')).sessions !== 1; i++) await new Promise((r) => setTimeout(r, 50))
    assert.equal((await ext(cli, 'remote.status')).sessions, 1)
    const two = await device.connect()
    const three = await device.connect()
    assert.ok(!('failed' in two) && !('failed' in three))
    assert.deepEqual(await device.connect(), { failed: 'hs-fail' })
    ;(two as DeviceSession).leg.close()
    ;(three as DeviceSession).leg.close()
  })

  test('revocation from the CLI: the live session falls in under a second with CLOSE(0x04), the next admission gets R_FAIL [37]', async () => {
    const id = toHex(device.result!.deviceId)
    const t0 = Date.now()
    const r = await ext(cli, 'device.revoke', { device: id.slice(0, 8) })
    assert.equal((r.device as { state: string }).state, 'revoked')
    await until(() => session.closed, 2_000, 'the session closed by the house')
    assert.ok(Date.now() - t0 < 1_000, `fell in ${Date.now() - t0} ms`)
    assert.deepEqual(session.closed, { by: 'peer', code: 0x04 })
    assert.deepEqual(await device.connect(), { failed: 'relay-refused' })
    const reg = JSON.parse(readFileSync(join(home, 'remote', 'devices.json'), 'utf8')) as { devices: { state: string }[] }
    assert.equal(reg.devices[0]!.state, 'revoked')
  })

  test('the canary and the secrets: no frame in clear, no log, no transmission of the pipe carries them [12, 25, 52]', async () => {
    const wire = relay.allBytes()
    const has = (b: Buffer, s: string | Uint8Array): boolean => b.includes(typeof s === 'string' ? Buffer.from(s, 'utf8') : Buffer.from(s))
    assert.ok(!has(wire, CANARY), 'canary on the wire')
    assert.ok(!has(wire, 'Revisor'), 'a slot name on the wire in clear')
    assert.ok(!has(wire, 'Telefone'), 'the device name on the wire in clear')
    assert.ok(!has(wire, device.result!.deviceId), 'deviceId on the wire in clear')
    assert.ok(!has(wire, device.kD.pub), 'pub_D on the wire in clear')
    const portalLog = readFileSync(join(home, 'tether-remoted.log'), 'utf8')
    const audit = existsSync(join(home, 'remote', 'audit.jsonl')) ? readFileSync(join(home, 'remote', 'audit.jsonl'), 'utf8') : ''
    // The canary: never on the remote wire nor in the logs of the remote side. (The pipe's own broadcasts of slots carry
    // args and folders to its greeted clients, with env values masked: that is the pipe's contract, not the remote's.)
    for (const text of [portalLog, logs.join('\n'), audit]) assert.doesNotMatch(text, new RegExp(CANARY), 'canary in a log')
    // The pairing's secrets: never in a log, the audit or any transmission a spy of the pipe gets (E-7 (c)).
    const digits = pairCode.replace(/ /g, '')
    for (const text of [portalLog, logs.join('\n'), audit, pipeLines.join('\n')]) {
      assert.ok(!text.includes(pairCode) && !text.includes(digits), 'the pairing code in a log or a transmission')
      assert.ok(!new RegExp(`(^|\\D)${sasShown}(\\D|$)`).test(text), 'the SAS in a log or a transmission')
    }
    assert.ok(!pipeLines.some((l) => /"pair|sas"|pairId|"code"/i.test(l)), 'no transmission names the pairing at all')
    assert.ok(audit.length > 0 && /"act":"pair.begin"/.test(audit), 'the audit has the acts')
  })

  test('idle: a session with no request for the idle time is closed with CLOSE(0x03); remote.off ends the rest with CLOSE(0x06)', async () => {
    await ext(cli, 'remote.off')
    env.TETHER_TEST_REMOTE_IDLE_MS = '1500'
    await ext(app, 'remote.on', { relayUrl: relay.url })
    await until(() => relay.linkUp, 20_000, 'the house back at the relay')
    const d2 = await TestDevice.make(relay)
    const begun = await ext(app, 'pair.begin')
    const { sas, done } = await d2.pair(String(begun.code))
    const digits = await sas
    for (let i = 0; i < 100; i++) { if ((await ext(app, 'pair.state', { pairId: begun.pairId })).state === 'waiting-sas') break; await new Promise((r) => setTimeout(r, 100)) }
    await ext(app, 'pair.sas', { pairId: begun.pairId, digits })
    const s = await done as DeviceSession
    await until(() => s.closed, 6_000, 'the idle session closed')
    assert.deepEqual(s.closed, { by: 'peer', code: 0x03 })
    delete env.TETHER_TEST_REMOTE_IDLE_MS
    const live = await d2.connect() as DeviceSession
    assert.equal((await live.request(OP.info)).status, RES_STATUS.ok)
    await ext(cli, 'remote.off')
    await until(() => live.closed, 3_000, 'the live session closed by remote.off')
    assert.deepEqual(live.closed, { by: 'peer', code: 0x06 })
    await until(() => !relay.linkUp, 5_000, 'the house left the relay')
    const st = await ext(cli, 'remote.status')
    assert.deepEqual([st.on, (st.portal as { state: string }).state], [false, 'off'])
  })
})
