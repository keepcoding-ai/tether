// RR5 step 5.1, end to end: the gestures only the app knows, asked from afar, with no screen on the device. A tetherd of the
// bench in this process (home under TETHER_BENCH_DIR or the system temp, never the person's) with its daemon extensions
// (remote and its REAL portal, regency, for-agents), a fake relay in this process, a test device of the protocol holding a
// presence credential of a software authenticator, two fake `claude` agents (test/fixtures/channels/agent-live.cjs, no LLM),
// and the real app on the same pipe, hidden window. Played in order:
//   1. pair and register the credential;
//   2. a desk hibernates from afar WITHOUT changing the desk in view, and wakes; the desk in view answers `in-view`;
//   3. a desk is created at the end of the queue and renamed, the desk in view unchanged;
//   4. a pane moves to the new desk (the device names the desk it saw it in; the old desk then says unknown-pane);
//   5. a desk is given to an agent (with the elevation window) and taken from it;
//   6. a pane closes only with a proof of this very act;
//   7. every act in the audit with the device, the op, the target id and the result; the machine said "Feito de longe";
//   8. with the app closed: `no-app`, nothing kept for when it opens.
// Run: npm run app:build && TETHER_BENCH_DIR=C:/atrium/.tmp/.tmp env -u TETHER_USER_DIR node --test --test-force-exit --test-concurrency=1 --test-timeout=180000 test/e2e/app.remote-acts.test.ts
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { DaemonClient } from '../../src/daemon/client.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import { DaemonExtensionHost } from '../../src/daemon/ext-host.ts'
import { startDaemon } from '../../src/daemon/server.ts'
import { OP_CODES, RES_STATUS, toHex, type Bytes } from '../../src/remote/index.ts'
import { removeHome, uniquePipe } from '../unit/daemon.helpers.ts'
import { act, actId, ORIGIN, present, registerAndUnlock } from '../unit/remoted.authenticator.ts'
import { benchHome, FakeRelay, TestDevice, until as untilSync, type DeviceSession } from '../unit/remoted.helpers.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  createDesk(side: 'before' | 'after', relativeTo?: string): string
  activeDesk(): string
  switchDesk(id: string): void
  deskOf(slotId: string): string | undefined
  panelIds(): string[]
  desks(): { id: string; name: string; color: string; asleep?: boolean; panes: string[] }[]
  ext: { regency: { remoteSaid(): string[] } }
}
declare const window: { __tether: Hooks }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const AGENT = resolve(import.meta.dirname, '../fixtures/channels/agent-live.cjs')
const OP = OP_CODES
const OFF = ['web-bridge', 'browser', 'skills', 'conductor-terminal', 'conductor-claude', 'conductor-soul', 'conductor-codex']

const ext = async (c: DaemonClient, name: string, args?: Record<string, unknown>): Promise<Record<string, any>> =>
  (await c.request({ t: 'ext-request', ext: 'remote', name, ...(args ? { args } : {}) })).result as Record<string, any>

test('remote acts: the app does from afar what only it knows, with no screen on the device', { timeout: 600_000 }, async () => {
  assert.ok(existsSync(mainPath), 'npm run app:build first')
  const home = benchHome('tether-remote-acts-')
  const pipe = uniquePipe(home)
  const shim = join(home, 'shim')
  const logs: string[] = []
  // The bench's environment in this process (the extensions read it): nothing of the person's tether, the remote's bench on.
  for (const k of Object.keys(process.env)) if (/^(TETHER_|CLAUDE)/i.test(k) || k === 'NODE_TEST_CONTEXT') delete process.env[k]
  Object.assign(process.env, { TETHER_TEST_REMOTE: '1', TETHER_TEST_REMOTE_NOTICE: join(home, 'notices.txt'), TETHER_TEST_REMOTE_TICK_MS: '200' })
  mkdirSync(shim, { recursive: true })
  if (process.platform === 'win32') writeFileSync(join(shim, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${AGENT}" %*\r\n`)
  else writeFileSync(join(shim, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${AGENT}" "$@"\n`, { mode: 0o755 })
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  process.env[pathKey] = `${shim}${process.platform === 'win32' ? ';' : ':'}${process.env[pathKey] ?? ''}`

  const relay = await FakeRelay.start()
  const door = new DoorHost({ log: (m) => logs.push(m) })
  const extHost = new DaemonExtensionHost({ home, log: (m) => logs.push(m), door, disabled: OFF })
  extHost.activate()
  const daemon = await startDaemon({
    home, pipe, memoryIntervalMs: 0, door, log: (m) => logs.push(m), panelHost: false, minAgentAgeMs: 1_000,
    transformPlan: extHost.transformPlan, onSlot: extHost.emitSlot,
  })
  extHost.emitStarted()
  const cli = await DaemonClient.open(pipe, 'cli', { home })
  // The pairing's half on the machine is the app's (pair.begin, pair.sas): a second `app` connection of the test does it
  // instead of the screen. It never answers an act (only the connection that publishes the tree may).
  const pairer = await DaemonClient.open(pipe, 'app', { home })
  let app: ElectronApplication | undefined
  let s: DeviceSession | undefined
  try {
    assert.deepEqual(await ext(pairer, 'remote.on', { relayUrl: relay.url, webUrl: `${ORIGIN}/` }), { on: true })
    await untilSync(() => relay.linkUp || undefined, 20_000, 'the house at the relay')

    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE') && !k.startsWith('TETHER_')) env[k] = v
    Object.assign(env, { TETHER_PIPE: pipe, TETHER_HOME: home, TETHER_E2E_HIDDEN: '1' })
    app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
    const page: Page = await app.firstWindow()
    page.setDefaultTimeout(15_000)
    page.on('pageerror', (e) => console.error(`renderer error: ${e.stack}`))
    await page.waitForSelector('#conn.on', { timeout: 30_000 })
    await page.waitForFunction(() => typeof window.__tether.ext?.regency?.remoteSaid === 'function')
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1440, 900) })
    const until = async (what: string, fn: () => Promise<unknown>, ms = 20_000): Promise<void> => {
      const end = Date.now() + ms
      let last: unknown
      while (Date.now() < end) { try { if (await fn()) return } catch (e) { last = e } await page.waitForTimeout(150) }
      throw new Error(`timeout: ${what}${last ? ` (${(last as Error).message})` : ''}\n${logs.slice(-20).join('\n')}`)
    }
    const desks = () => page.evaluate(() => window.__tether.desks().map((d) => ({ id: d.id, name: d.name, color: d.color, asleep: d.asleep === true, panes: d.panes })))
    const active = () => page.evaluate(() => window.__tether.activeDesk())
    const deskOf = (id: string) => page.evaluate((x) => window.__tether.deskOf(x), id)
    const panelIds = () => page.evaluate(() => window.__tether.panelIds())

    // Two desks, an agent on each; the person looks at the first.
    const first = (await desks())[0]!.id
    const second = await page.evaluate((x) => window.__tether.createDesk('after', x), first)
    await page.evaluate((x) => window.__tether.switchDesk(x), first)
    const agent = async (name: string, desk: string): Promise<string> => {
      mkdirSync(join(home, name), { recursive: true })
      const created = await cli.request({ t: 'create', kind: 'claude', cwd: join(home, name), name, start: true, desk }) as { slot?: { slotId: string } }
      const id = created.slot!.slotId
      await until(`${name} running with its pane on ${desk}`, async () =>
        ((await cli.request({ t: 'list' })).slots ?? []).some((x) => x.slotId === id && x.status === 'running') && existsSync(join(home, 'bench', `${id}.ready`)) && (await deskOf(id)) === desk, 60_000)
      return id
    }
    const conferente = await agent('conferente', first)
    const bancada = await agent('bancada', second)
    assert.equal(await active(), first)

    // ---- 1. pairing and the credential ----
    console.log('step 1')
    const device = await TestDevice.make(relay)
    const begun = await ext(pairer, 'pair.begin')
    const { sas, done } = await device.pair(String(begun.code), { name: 'Telefone que gere' })
    const digits = await sas
    for (let i = 0; i < 100 && (await ext(pairer, 'pair.state', { pairId: begun.pairId })).state !== 'waiting-sas'; i++) await new Promise((r) => setTimeout(r, 100))
    await ext(pairer, 'pair.sas', { pairId: begun.pairId, digits })
    const fresh = await done
    assert.ok(!('failed' in fresh), `pairing: ${JSON.stringify(fresh)}`)
    for (let i = 0; i < 100 && (await ext(pairer, 'pair.state', { pairId: begun.pairId })).state !== 'done'; i++) await new Promise((r) => setTimeout(r, 100))
    const auth = await registerAndUnlock(fresh as DeviceSession, device.kD.pub)
    ;(fresh as DeviceSession).leg.close()
    const c = await device.connect()
    assert.ok(!('failed' in c), `session: ${JSON.stringify(c)}`)
    s = c as DeviceSession
    assert.equal((await present(s, auth)).status, RES_STATUS.ok)
    const call = (op: number, body: Record<string, unknown>, id: Bytes = actId()) => s!.request(op, body, { actId: id })
    const ok = async (op: number, body: Record<string, unknown>): Promise<Record<string, any>> => {
      const r = await call(op, body)
      assert.equal(r.status, RES_STATUS.ok, `op 0x${op.toString(16)}: ${JSON.stringify(r.body)}`)
      return r.body as Record<string, any>
    }

    // ---- 2. hibernate a desk from afar without changing the desk in view; wake it ----
    console.log('step 2')
    assert.deepEqual(await call(OP['desks.hibernate'], { deskId: first }), { status: RES_STATUS.failed, body: { error: 'in-view' } }, 'the desk in view is not taken from her')
    assert.deepEqual(await ok(OP['desks.hibernate'], { deskId: second }), { state: 'done' })
    await until('the desk asleep', async () => (await desks()).find((d) => d.id === second)?.asleep === true)
    await until('its agent stopped', async () => ((await cli.request({ t: 'list' })).slots ?? []).find((x) => x.slotId === bancada)?.status !== 'running')
    assert.equal(await active(), first, 'the desk in view never changed')
    assert.deepEqual(await ok(OP['desks.wake'], { deskId: second }), { state: 'done' })
    await until('the desk awake', async () => (await desks()).find((d) => d.id === second)?.asleep !== true)
    // The app's wake starts the pane again (`start`); the fake agent's session was never confirmed, so it waits for the
    // person's choice in the pane, as a wake in the app would.
    let woke = ''
    await until('its agent started again (or asking for the choice)', async () => {
      const sl = ((await cli.request({ t: 'list' })).slots ?? []).find((x) => x.slotId === bancada)
      woke = `${sl?.status}/${sl?.want}`
      return ['running', 'starting', 'unconfirmed'].includes(sl?.status ?? '')
    }, 60_000).catch((e: Error) => { throw new Error(`${e.message} [slot ${woke}]`) })
    assert.equal(await active(), first)

    // ---- 3. create a desk and rename it ----
    console.log('step 3')
    const made = await ok(OP['desks.create'], { name: '  Obra\u202E nova ', color: 'teal' })
    assert.match(made.deskId, /^[\w.:-]+$/)
    const third = made.deskId as string
    await until('the new desk at the end of the queue', async () => { const d = await desks(); return d.at(-1)?.id === third && d.at(-1)?.name === 'Obra nova' && d.at(-1)?.color === 'teal' })
    assert.equal(await active(), first, 'created without switching')
    assert.deepEqual(await ok(OP['desks.rename'], { deskId: third, name: 'Obra da casa' }), { state: 'done' })
    await until('renamed', async () => (await desks()).find((d) => d.id === third)?.name === 'Obra da casa')

    // ---- 4. move a pane to the new desk ----
    console.log('step 4')
    // The answers of the create and the move came once tetherd's map showed them: the next act on them goes at once.
    assert.deepEqual(await ok(OP['panes.move'], { deskId: second, paneId: bancada, to: third }), { state: 'done' })
    assert.equal(await deskOf(bancada), third)
    assert.equal(await active(), first)
    assert.deepEqual(await call(OP['panes.hibernate'], { deskId: second, paneId: bancada }), { status: RES_STATUS.notFound, body: { error: 'unknown-pane' } }, 'the desk the device saw it in is no longer its desk')

    // ---- 5. give a desk to an agent and take it back ----
    console.log('step 5')
    const ownerOf = async (deskId: string): Promise<string | undefined> => {
      const r = await cli.request({ t: 'object-get', ext: 'for-agents' }) as { objects?: { desk: Record<string, Record<string, any>> } }
      const o = r.objects?.desk[deskId]?.owner as { owner?: string } | undefined
      return o?.owner
    }
    assert.equal((await call(OP['owners.give'], { deskId: third, to: conferente })).status, RES_STATUS.presenceRequired, 'giving power needs the window')
    assert.equal((await present(s, auth, 'elevate')).status, RES_STATUS.ok)
    assert.deepEqual(await ok(OP['owners.give'], { deskId: third, to: conferente }), { state: 'done' })
    assert.equal(await ownerOf(third), conferente, 'the owner written by the app, for-agents\' own write')
    assert.deepEqual(await ok(OP['owners.revoke'], { deskId: third }), { state: 'done' })
    assert.equal(await ownerOf(third), undefined, 'taken from the agent')
    assert.deepEqual(await call(OP['owners.revoke'], { deskId: third }), { status: RES_STATUS.failed, body: { error: 'not-given' } })

    // ---- 6. close a pane: only with a proof of this very act ----
    console.log('step 6')
    assert.equal((await call(OP['panes.close'], { deskId: third, paneId: bancada, process: 'stop' })).status, RES_STATUS.presenceRequired)
    assert.ok((await panelIds()).includes(bancada), 'nothing was closed')
    const closed = await act(s, auth, OP['panes.close'], { deskId: third, paneId: bancada, process: 'stop' })
    assert.deepEqual(closed, { status: RES_STATUS.ok, body: { state: 'done' } })
    await until('the pane gone', async () => !(await panelIds()).includes(bancada))
    await until('its agent stopped', async () => ((await cli.request({ t: 'list' })).slots ?? []).find((x) => x.slotId === bancada)?.status !== 'running')
    assert.equal(await active(), first)

    // ---- 6b. "+ Novo" from afar (RR5 5.3): a note the app makes in a known folder, an agent tetherd makes; nothing forward ----
    console.log('step 6b')
    const options = await ok(OP['create.options'], {})
    const folder = (options.folders as { id: string; label: string }[]).find((f) => f.label === 'conferente')
    assert.ok(folder, JSON.stringify(options.folders))
    assert.equal(JSON.stringify(options).includes(home), false, 'no path reaches the device')
    const note = await ok(OP['create.note'], { deskId: second, folder: folder.id })
    assert.equal(note.state, 'done')
    assert.match(String(note.paneId), /^[\w.:-]+$/)
    await until('the note on that desk', async () => (await deskOf(String(note.paneId))) === second)
    assert.equal(await active(), first, 'created behind, the desk in view unchanged')
    const born = await ok(OP['create.agent'], { engine: 'claude', deskId: second, folder: folder.id, name: 'nascido de longe' })
    await until('the agent born with its pane on that desk', async () => (await deskOf(String(born.slotId))) === second, 60_000)
    assert.equal(await active(), first)
    assert.deepEqual(await call(OP['create.note'], { deskId: second, folder: '0123456789abcdef' }), { status: RES_STATUS.notFound, body: { error: 'unknown-folder' } })

    // ---- 7. the audit, and what the machine said ----
    console.log('step 7')
    const said = await page.evaluate(() => window.__tether.ext.regency.remoteSaid())
    assert.ok(said.includes('Feito de longe: mesa Obra nova criada.'), JSON.stringify(said))
    assert.ok(said.some((t) => /^Feito de longe: guia .* fechada\.$/.test(t)), JSON.stringify(said))
    const read = () => readFileSync(join(home, 'remote', 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { act: string; device?: string; target?: string; result: string })
    const dev = toHex(device.result!.deviceId)
    let lines = read()
    const has = (a: string, result: string, target?: string) => lines.some((l) => l.act === a && l.result === result && l.device === dev && (target === undefined || l.target === target))
    // The audit is written by the extension a moment after each answer (its writes are coalesced).
    await untilSync(() => { lines = read(); return has('panes.close', 'ok', bancada) || undefined }, 10_000, 'the last act in the audit')
    assert.ok(has('desks.hibernate', 'refused:in-view', first))
    assert.ok(has('desks.hibernate', 'ok', second))
    assert.ok(has('desks.wake', 'ok', second))
    assert.ok(has('desks.create', 'ok'))
    assert.ok(has('desks.rename', 'ok', third))
    assert.ok(has('panes.move', 'ok', bancada))
    assert.ok(has('owners.give', 'ok', third))
    assert.ok(has('owners.revoke', 'ok', third))
    assert.ok(has('panes.close', 'ok', bancada))
    await untilSync(() => { lines = read(); return has('create.agent', 'ok', second) || undefined }, 10_000, 'the creation in the audit')
    assert.ok(has('create.note', 'ok', second))
    assert.ok(has('create.note', 'refused:unknown-folder', second))
    const secondName = (await desks()).find((d) => d.id === second)?.name
    assert.ok(said.includes(`Feito de longe: nota criada na mesa ${secondName}.`), JSON.stringify(said))
    const text = JSON.stringify(lines)
    for (const t of ['Obra nova', 'Obra da casa']) assert.equal(text.includes(t), false, `${t}: never in the audit`)

    // ---- 8. the app closed: no-app, nothing kept ----
    console.log('step 8')
    await killElectron(app, root)
    app = undefined
    const t0 = Date.now()
    assert.deepEqual(await call(OP['desks.hibernate'], { deskId: third }), { status: RES_STATUS.noApp, body: { error: 'no-app' } })
    assert.ok(Date.now() - t0 < 6_000, `no-app within the claim's wait (${Date.now() - t0} ms)`)
    // The audit is written by the extension a moment after the answer (its writes are coalesced).
    await untilSync(() => /"desks\.hibernate"[^\n]*"target":"[^"]+","result":"refused:no-app"/.test(readFileSync(join(home, 'remote', 'audit.jsonl'), 'utf8')) || undefined, 10_000, 'the no-app line')
  } finally {
    s?.leg.close()
    if (app) await killElectron(app, root).catch(() => {})
    try { await ext(cli, 'remote.off') } catch { /* already off */ }
    try {
      const slots = (await cli.request({ t: 'list' })).slots ?? []
      await Promise.all(slots.filter((x) => x.pid).map((x) => cli.request({ t: 'stop', slotId: x.slotId }).catch(() => undefined)))
    } catch { /* tetherd gone */ }
    pairer.close()
    cli.close()
    extHost.dispose()
    await daemon.close()
    await door.mcp.close().catch(() => {})
    await relay.close()
    await removeHome(home)
  }
})
