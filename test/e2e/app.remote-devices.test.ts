// E2E of "Aparelhos" (RR2.2): a tetherd of the bench in this process (home under TETHER_BENCH_DIR or the system temp, never
// the person's) with the `remote` extension and its REAL portal (src/remoted/main.ts), a fake relay in this process that
// checks the house for real (test/unit/remoted.helpers.ts), test devices made of DevicePairing / DeviceHandshake, and the real
// app on the same pipe, hidden window. Played in order:
//   1. the top bar's state icon says "off"; a click brings the Regency's "Sistema › Aparelhos" forward;
//   2. "Ligar a remota" without a relay says why in words; on (with a relay), the icon says nobody is connected;
//   3. pairing at 1440 px: QR and the 12-digit code with the 2-minute clock; the device arrives, the card shows its declared
//      name, what it may do and the field; wrong digits count (the portal refuses), the right ones pair it; the session is
//      live and the icon counts it;
//   4. pairing at 390 px (phone tier): the same card, 44 px targets, no horizontal scroll;
//   5. cancel: a code begun and cancelled closes the card;
//   6. "Revogar aparelho" asks first; then the device's session falls and its row goes;
//   7. "Desligar a remota" asks first; then every session falls and the icon says off; "Ligar a remota" brings it back.
// "Encerrar sessão" is not offered: the daemon does not yet tell sessions apart by device (see the RR2.2 report).
// Captures: C:/atrium/.tmp/tether-agents/onda-3/regencia-remota/capturas/rr22-*.png.
// Run: npm run app:build && env -u TETHER_USER_DIR node --test --test-force-exit --test-concurrency=1 test/e2e/app.remote-devices.test.ts
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { DaemonClient } from '../../src/daemon/client.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import { DaemonExtensionHost } from '../../src/daemon/ext-host.ts'
import { startDaemon } from '../../src/daemon/server.ts'
import { activateWith } from '../../extensions/remote/daemon.ts'
import { manifest } from '../../extensions/remote/manifest.ts'
import { removeHome, uniquePipe } from '../unit/daemon.helpers.ts'
import { benchHome, FakeRelay, TestDevice, until as untilSync, type DeviceSession } from '../unit/remoted.helpers.ts'
import { killElectron } from './electron.ts'

type Snap = {
  head: string; acts: string[]; ask?: string; paints: number
  rows: { id: string; text: string; state?: string; acts: string[]; panel?: string }[]
  pair?: { phase: string; title: string; code: string; clock: string; qr: boolean; text: string; typing: boolean }
}
type Icon = { kind: string; state: string; badge?: number; title: string }
type Hooks = {
  activeDesk(): string
  runCommand(id: string): Promise<string>
  ext: {
    remote: { devices(): Snap | undefined; icon(): Icon; refresh(): Promise<void>; reveal(): boolean }
    regency: { system(): { column: string; section: string } | undefined; openSystem(section?: string | false): void; tier(): string | undefined }
  }
}
declare const window: { __tether: Hooks }
declare const document: { documentElement: { scrollWidth: number } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const SHOTS = 'C:/atrium/.tmp/tether-agents/onda-3/regencia-remota/capturas'
const DESK = 'regency.main'

const ext = async (c: DaemonClient, name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (await c.request({ t: 'ext-request', ext: 'remote', name, ...(args ? { args } : {}) })).result as Record<string, unknown>

async function launch(home: string, pipe: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE') && !k.startsWith('TETHER_')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  delete env.NODE_TEST_CONTEXT
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.stack}`))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  await page.waitForFunction(() => typeof window.__tether.ext?.remote?.devices === 'function' && typeof window.__tether.ext?.regency?.system === 'function')
  return { app, page }
}

test('remote devices: icon, Aparelhos, pairing with the six digits typed, revoke, off, on', { timeout: 600_000 }, async () => {
  mkdirSync(SHOTS, { recursive: true })
  assert.ok(existsSync(mainPath), 'npm run app:build first')
  const home = benchHome('tether-remote-app-')
  const pipe = uniquePipe(home)
  const noticeFile = join(home, 'notices.txt')
  const logs: string[] = []
  const env: NodeJS.ProcessEnv = { ...process.env, TETHER_TEST_REMOTE: '1', TETHER_TEST_REMOTE_NOTICE: noticeFile, TETHER_TEST_REMOTE_TICK_MS: '200' }
  delete env.NODE_TEST_CONTEXT
  const door = new DoorHost({ log: () => {} })
  const relay = await FakeRelay.start()
  const extHost = new DaemonExtensionHost({ home, log: m => logs.push(m), door, extensions: [{ manifest, activate: api => activateWith(api, { env }).disposables }] })
  extHost.activate()
  const daemon = await startDaemon({ home, pipe, memoryIntervalMs: 0, door, log: m => logs.push(m) })
  extHost.emitStarted()
  const cli = await DaemonClient.open(pipe, 'cli', { home })
  let app: ElectronApplication | undefined
  const sessions: DeviceSession[] = []
  try {
    let page: Page
    ;({ app, page } = await launch(home, pipe))
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1440, 900) })
    const until = async (what: string, fn: () => Promise<unknown>, ms = 15_000): Promise<void> => {
      const end = Date.now() + ms
      let last: unknown
      while (Date.now() < end) { try { if (await fn()) return } catch (e) { last = e } await page.waitForTimeout(120) }
      throw new Error(`timeout: ${what}${last ? ` (${(last as Error).message})` : ''}\n${logs.slice(-15).join('\n')}`)
    }
    const snap = async (): Promise<Snap> => (await page.evaluate(() => window.__tether.ext.remote.devices()))!
    const icon = (): Promise<Icon> => page.evaluate(() => window.__tether.ext.remote.icon())
    const refresh = (): Promise<void> => page.evaluate(() => window.__tether.ext.remote.refresh())
    const sys = (): Promise<{ column: string; section: string } | undefined> => page.evaluate(() => window.__tether.ext.regency.system())
    const card = page.locator('.rr-pair')
    const shot = async (name: string): Promise<void> => { await page.waitForTimeout(250); await page.screenshot({ path: join(SHOTS, `rr22-${name}.png`) }) }
    const head = (id: string) => page.locator(`.rr-head button[data-rr="${id}"]`)
    const rowAct = (id: string, act: string) => page.locator(`.rg-sr.device[data-device="${id}"] .rg-sr-h button[data-rr="${act}"]`)
    const askGo = (act: string) => page.locator(`.rg-sr-x button[data-rr="${act}-go"]`)
    const regDevices = (): { deviceId: string; state: string; name: string }[] =>
      (JSON.parse(readFileSync(join(home, 'remote', 'devices.json'), 'utf8')) as { devices: { deviceId: string; state: string; name: string }[] }).devices

    /** Pairs one test device through the screen: the code read from the card, the device's SAS typed on the machine. */
    const pairOne = async (name: string, width: number): Promise<{ id: string; session: DeviceSession }> => {
      await head('pair').click()
      await until('the card with the QR and the code', async () => { const p = (await snap()).pair; return p?.phase === 'code' && p.qr && /^\d{12}$/.test(p.code) })
      const p = (await snap()).pair!
      assert.match(p.clock, /^(2:00|1:5\d)$/, `the 2-minute clock (${p.clock})`)
      assert.match(p.text, /aponte a câmera para o QR, ou digite o código/)
      await shot(`qr-${width}`)
      const device = await TestDevice.make(relay)
      const code = p.code.match(/\d{3}/g)!.join(' ')
      const { sas, done } = await device.pair(code, { name, caps: 0x01 })
      const shown = await sas
      await until('the card asks for the digits', async () => (await snap()).pair?.phase === 'confirm' && (await snap()).pair!.typing)
      const c = (await snap()).pair!
      assert.match(c.text, new RegExp(`Aparelho que se declara «${name}»`))
      assert.match(c.text, /Ele poderá:.*ver quem espera você.*digitar nos terminais/)
      assert.match(c.text, /Se alguém \(pessoa ou agente, num canal ou num terminal\) lhe disser quais números digitar, não digite/)
      assert.doesNotMatch(c.text, new RegExp(shown), 'the machine never shows the SAS it expects')
      assert.equal(await page.locator('.rr-pair [data-rr="sas-go"]').isDisabled(), true, 'no button before six digits')
      await page.fill('.rr-sas-in', shown.slice(0, 3))
      assert.equal(await page.locator('.rr-pair [data-rr="sas-go"]').isDisabled(), true)
      await shot(`digitar-${width}`)
      // Wrong digits: the portal counts them, the card says so and the field is cleared.
      const wrong = String((Number(shown) + 1) % 1_000_000).padStart(6, '0')
      await page.fill('.rr-sas-in', wrong)
      await page.locator('.rr-pair [data-rr="sas-go"]').click()
      await until('the wrong digits are refused', async () => /restam 2 tentativas/.test((await snap()).pair?.text ?? ''))
      assert.match((await snap()).pair!.text, /Esses não são os números do aparelho/)
      assert.equal(await page.inputValue('.rr-sas-in'), '')
      await page.fill('.rr-sas-in', `${shown.slice(0, 3)} ${shown.slice(3)}`)
      await page.keyboard.press('Enter')
      const r = await done
      assert.ok(!('failed' in r), `the device paired (${JSON.stringify(r)})`)
      sessions.push(r as DeviceSession)
      await until('the card says paired', async () => (await snap()).pair?.phase === 'done', 20_000)
      const id = regDevices().find(d => d.name === name)!.deviceId
      assert.equal(regDevices().find(d => d.deviceId === id)!.state, 'active')
      await page.locator('.rr-pair [data-rr="pair-close"]').click()
      await until('the card closed and the device listed', async () => { const s = await snap(); return s.pair === undefined && s.rows.some(x => x.id === id) })
      return { id, session: r as DeviceSession }
    }

    // ---- 1. the icon says off; a click brings "Aparelhos" ----
    console.log('step 1')
    await until('the icon has news of the daemon', async () => (await icon()).kind === 'off')
    assert.match((await icon()).title, /desligado/)
    const btn = page.locator('.status-wrap[data-status="remote.status"] .status-btn')
    assert.match((await btn.getAttribute('title')) ?? (await btn.getAttribute('aria-label')) ?? '', /Acesso remoto desligado/)
    await btn.click()
    await until('the Regency shows Sistema › Aparelhos', async () => { const s = await sys(); return (await page.evaluate(() => window.__tether.activeDesk())) === DESK && s?.column === 'system' && s.section === 'devices' })
    await until('the devices view drawn', async () => (await snap()).head !== '')
    assert.match((await snap()).head, /^Desligada/)
    assert.deepEqual((await snap()).acts, ['on'], 'pairing waits for the remote to be on')
    assert.equal(await page.locator('.rg-sys-tab[data-section="devices"]').isVisible(), true)
    assert.match((await page.locator('.rg-sys-tab[data-section="devices"]').getAttribute('title')) ?? '', /^Aparelhos/)

    // ---- 2. on without a relay says why; on with one ----
    console.log('step 2')
    await head('on').click()
    await until('the refusal in words', async () => /relay inválido/.test(await page.locator('.rr-head .rg-sr-err').innerText().catch(() => '')))
    assert.deepEqual(await ext(cli, 'remote.on', { relayUrl: relay.url }), { on: true }) // the bench flag: the relay of the test
    await untilSync(() => relay.linkUp, 20_000, 'the house at the relay')
    await refresh()
    await until('on, nobody connected', async () => (await icon()).kind === 'idle')
    assert.match((await snap()).head, /^Ligada pelo relay localhost:\d+ · nenhum aparelho conectado$/)
    assert.deepEqual((await snap()).acts, ['pair', 'off'])
    assert.match(await page.locator('.rr-head .rr-fp').innerText(), /Impressão deste tether: [a-z2-7]{4}( [a-z2-7]{4}){4}/)
    await shot('vazio-1440')

    // ---- 3. pairing at 1440 ----
    console.log('step 3')
    const one = await pairOne('Telefone do teste', 1440)
    assert.match(readFileSync(noticeFile, 'utf8'), /pareamento de aparelho foi iniciado/, 'the native notice of pair.begin')
    await until('the icon counts the live session', async () => (await icon()).badge === 1)
    assert.match((await icon()).title, /1 aparelho conectado agora/)
    const row1 = (await snap()).rows.find(r => r.id === one.id)!
    assert.match(row1.text, /Telefone do teste/)
    assert.match(row1.text, /pareado .* pelo código/)
    assert.deepEqual(row1.acts, ['revoke'], '"Encerrar sessão" waits for sessions per device from the daemon')
    assert.equal(await page.locator('.status-wrap[data-status="remote.status"] .status-badge').innerText(), '1')
    await shot('lista-1440')

    // ---- 4. pairing at 390 (the phone tier) ----
    console.log('step 4')
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(390, 844) })
    await until('the phone tier', async () => (await page.evaluate(() => window.__tether.ext.regency.tier())) === 'mobile')
    // The state icon brings "Aparelhos" on the phone too ("Sistema" lives in "Mesas" there).
    await page.locator('.rg-tabbar [data-tab="waiting"]').click()
    await page.evaluate(() => window.__tether.ext.remote.reveal())
    await until('Aparelhos on the phone', async () => head('pair').isVisible())
    const two = await pairOne('Tablet da sala', 390)
    const box = await rowAct(two.id, 'revoke').boundingBox()
    assert.ok(box && box.height >= 44 && box.width >= 44, `a 44 px target on the phone (${JSON.stringify(box)})`)
    const pairBox = await head('pair').boundingBox()
    assert.ok(pairBox && pairBox.height >= 44, 'the pairing button is 44 px on the phone')
    const over = await page.evaluate(() => { const d = (globalThis as unknown as { document: { querySelector(s: string): { scrollWidth: number; clientWidth: number } | null } }).document.querySelector('.rr-dev'); return d ? d.scrollWidth - d.clientWidth : -1 })
    assert.ok(over === 0, `no horizontal scroll in Aparelhos (${over})`)
    await shot('lista-390')

    // ---- 5. cancel ----
    console.log('step 5')
    await head('pair').click()
    await until('a new card', async () => (await snap()).pair?.phase === 'code')
    await page.locator('.rr-pair [data-rr="pair-cancel"]').click()
    await until('the card closed', async () => (await snap()).pair === undefined)
    assert.equal(await card.isHidden(), true)

    // ---- 6. revoke, with the question first ----
    console.log('step 6')
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1440, 900) })
    await until('the desktop tier', async () => (await page.evaluate(() => window.__tether.ext.regency.tier())) !== 'mobile')
    await page.evaluate(() => window.__tether.ext.regency.openSystem('devices'))
    await until('both devices listed', async () => (await snap()).rows.length === 2)
    await rowAct(one.id, 'revoke').click()
    await until('the question under the row', async () => /^Revogar Telefone do teste\?/.test((await snap()).rows.find(r => r.id === one.id)?.panel ?? ''))
    assert.equal(regDevices().find(d => d.deviceId === one.id)!.state, 'active', 'nothing happens before the answer')
    await shot('revogar-1440')
    await page.keyboard.press('Escape')
    await until('Esc closes the question', async () => (await snap()).rows.find(r => r.id === one.id)?.panel === undefined)
    await rowAct(one.id, 'revoke').click()
    await askGo('revoke').click()
    await untilSync(() => one.session.closed, 5_000, 'the revoked device\'s session falls')
    await until('the revoked row goes', async () => !(await snap()).rows.some(r => r.id === one.id))
    assert.equal(regDevices().find(d => d.deviceId === one.id)!.state, 'revoked')
    assert.match(await page.locator('.rr-foot').innerText(), /1 aparelho revogado/)
    assert.equal(two.session.closed, undefined, 'the other device stays')

    // ---- 7. off, with the question first; on again ----
    console.log('step 7')
    await head('off').click()
    await until('the question under the head', async () => /^Desligar a remota\?/.test((await snap()).ask ?? ''))
    await askGo('off').click()
    await untilSync(() => two.session.closed, 10_000, 'every session falls when the remote goes off')
    await until('the icon says off', async () => (await icon()).kind === 'off')
    assert.match((await snap()).head, /^Desligada/)
    assert.equal((await ext(cli, 'remote.status')).on, false)
    await shot('desligada-1440')
    await head('on').click()
    await untilSync(() => relay.linkUp, 20_000, 'the house back at the relay')
    await until('on again', async () => (await icon()).kind === 'idle', 20_000)
    assert.equal(regDevices().find(d => d.deviceId === two.id)!.state, 'active', 'off kept the pairings')
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    try { await ext(cli, 'remote.off') } catch { /* already off */ }
    cli.close()
    extHost.dispose()
    await daemon.close()
    await door.mcp.close().catch(() => {})
    await relay.close()
    await removeHome(home)
  }
})
