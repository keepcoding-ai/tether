// E2E of the Regency's "Novo processo" (R7c): a tetherd in this process on a private home and pipe, the channels' record and
// requests on its door, a REAL tether-procd, and the real app on the same pipe, hidden window at 1500 px. Nothing touches
// the person's tether.
//   1. Processos' foot has "Novo processo" (no more "pela linha de comando"); the card opens with the fixed warning line;
//   2. a process with a port, a common variable and a CANARY value is created by the form and runs (its output proves both
//      variables reached it); the row shows the variables by name;
//   3. the canary is nowhere after creating: the page's DOM and inputs, the URL, the renderer's console, the renderer's JS
//      heap, the app's log, the daemon's log, every broadcast a listening client saw, every file of the home but the
//      process' own card (the stored recipe, as `tether proc start --env` stores it);
//   4. a secret-looking name asks first, "Voltar" is the default (Enter goes back, nothing made), "Criar mesmo assim" makes it;
//   5. a busy port answers in plain words on the ports field, saying who holds it; the values were emptied; a name in use
//      is refused on the name field;
//   6. the phone: the card is the whole screen, 44 px targets.
// Captures: C:/atrium/.tmp/tether-agents/onda-3/mesa-regencia/capturas/r7/novo-processo*.png.
// Run alone: npm run app:build && node --test --test-force-exit --test-concurrency=1 test/e2e/app.regency-new-process.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import '../../src/agents/load.ts'
import { procCardPath, procLogPath } from '../../src/core/paths.ts'
import { DaemonClient } from '../../src/daemon/client.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import { fsIo } from '../../src/daemon/ext-io.ts'
import type { ProcState } from '../../src/daemon/procs.ts'
import { startDaemon } from '../../src/daemon/server.ts'
import { createChannels, type Channels, type ChannelsApi } from '../../extensions/channels/daemon/fanout.ts'
import { registerChannelRequests } from '../../extensions/channels/daemon/requests.ts'
import { openStore } from '../../extensions/channels/daemon/store.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { removeHome, tempHome, uniquePipe } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type SysRow = { key: string; text: string; state?: string; acts: string[]; panel?: string }
type SysSnap = { column: string; section: string; view: { section: string; rows: SysRow[]; empty?: string; foot: string } }
type NpSnap = {
  open: boolean; phase: string; tier: string; name: string; command: string; cwd: string; ports: string; description: string
  env: { name: string; filled: boolean; shown: boolean }[]; warning: string; error?: string; errorField?: string; question?: string
}
type Hooks = {
  panelIds(): string[]
  activeDesk(): string
  runCommand(id: string): Promise<string>
  processesEmbed(op: string): Promise<{ json: string; hasEnv: boolean }>
  ext: { regency: { tier(): string | undefined; system(): SysSnap | undefined; openSystem(section?: string | false): void; newProcessView(): NpSnap } }
}
declare const window: { __tether: Hooks; location: { href: string } }
declare const document: {
  documentElement: { outerHTML: string }
  querySelectorAll(s: string): ArrayLike<{ value?: string; getAttributeNames(): string[]; getAttribute(n: string): string | null }>
  activeElement: { dataset?: Record<string, string> } | null
}

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const SHOTS = 'C:/atrium/.tmp/tether-agents/onda-3/mesa-regencia/capturas/r7'
const DESK = 'regency.main'
const PANE = 'regency:main'
const CARD = 'dialog.rg-np'
/** The canaries: fake values, typed into the form, that must never come back. */
const CANARY = 'canario-r7c-0b5e1d'
const CANARY_TOKEN = 'canario-r7c-token-77aa'
const CANARY_BUSY = 'canario-r7c-busy-c3f2'

/** A harmless process: listens on its port, says which variables it got (the canary by its length only), ticks. */
const FIXTURE = `
const http = require('node:http')
const port = Number(process.argv[2] || 0)
if (port) http.createServer((q, s) => s.end('ok')).listen(port, 'localhost')
console.log('modo ' + (process.env.MODO || '-') + ' nota ' + (process.env.NOTA || '').length)
setInterval(() => console.log('tick'), 500)
`

function freePort(): Promise<number> {
  return new Promise(res => { const s = createServer().listen(0, 'localhost', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)) }) })
}

/** Every file under `dir` (the home is the test's own). */
function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) out.push(...filesUnder(p))
    else out.push(p)
  }
  return out
}

async function launch(home: string, pipe: string, consoleLines: string[]): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  delete env.NODE_TEST_CONTEXT
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', e => { consoleLines.push(String(e.stack)); console.error(`renderer error: ${e.stack}`) })
  page.on('console', m => { consoleLines.push(m.text()); if (m.type() === 'error') console.error(`renderer console: ${m.text()}`) })
  app.process().stdout?.on('data', (d: Buffer) => consoleLines.push(d.toString()))
  app.process().stderr?.on('data', (d: Buffer) => consoleLines.push(d.toString()))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1500, 900) })
  await page.waitForFunction(() => typeof window.__tether.ext?.regency?.newProcessView === 'function')
  return { app, page }
}

test('regency: Novo processo (form, variables by name only, the canary nowhere, secret names ask, busy port, phone)', { timeout: 600_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(SHOTS, { recursive: true })
  const home = tempHome()
  const pipe = uniquePipe(home)
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  const fixture = join(work, 'r7.cjs')
  writeFileSync(fixture, FIXTURE)
  const webPort = await freePort()
  const logs: string[] = []
  const consoleLines: string[] = []
  const broadcasts: string[] = []
  const door = new DoorHost({ log: m => logs.push(m) })
  const own = new DisposableStore()
  const testContext = process.env.NODE_TEST_CONTEXT
  delete process.env.NODE_TEST_CONTEXT
  const owned: Owned[] = []
  let busyServer: Server | undefined
  let listener: DaemonClient | undefined

  const daemon = await startDaemon({ home, pipe, memoryIntervalMs: 0, readyFallbackMs: 300, minAgentAgeMs: 0, door, log: m => logs.push(m) })
  const doorApi = door.apiFor('channels', own)
  own.add(doorApi.delivery.enable())
  const api: ChannelsApi = { slots: doorApi.slots, attention: doorApi.attention, delivery: doorApi.delivery, events: doorApi.events, settings: { get: () => undefined }, log: m => logs.push(m) }
  const ch: Channels = createChannels(api, await openStore(fsIo, home))
  for (const d of registerChannelRequests(doorApi, Promise.resolve(ch))) own.add(d)

  const CLI = join(root, 'bin', 'tether.mjs')
  const cli = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    const env: NodeJS.ProcessEnv = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
    for (const k of ['NODE_TEST_CONTEXT', 'TETHER_SLOT_ID', 'TETHER_PROCD_PIPE', 'TETHER_CLAUDE_ARGS']) delete env[k]
    env.TETHER_HOME = home
    env.TETHER_PIPE = pipe
    return new Promise(res => execFile(process.execPath, [CLI, ...args], { env, cwd: work, windowsHide: true, encoding: 'utf8', timeout: 60_000 },
      (err, stdout, stderr) => res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr })))
  }
  const procs = async (): Promise<ProcState[]> => { const r = await cli(['proc', 'ls', '--json']); assert.equal(r.code, 0, r.stderr); return JSON.parse(r.stdout) as ProcState[] }
  const proc = async (name: string): Promise<ProcState | undefined> => (await procs()).find(p => p.name === name)
  /** Claimed while it is known to be the test's (its command line holds the fixture's path): only these are ever killed. */
  const track = async (name: string): Promise<void> => {
    const p = await proc(name)
    if (p?.pid) { const o = await claim(p.pid, { cmdIncludes: fixture, what: `${name} fixture` }).catch(() => undefined); if (o) owned.push(o) }
  }

  /** The files of the home (but `except` and the fixture) that hold a needle; a file locked by a live process is listed apart. */
  const homeLeaks = (needles: string[], except: string[]): { leaks: string[]; unreadable: string[]; read: number } => {
    const leaks: string[] = []
    const unreadable: string[] = []
    let read = 0
    for (const f of filesUnder(home)) {
      if (except.includes(f) || f === fixture) continue
      let data: Buffer
      try { data = readFileSync(f) } catch { unreadable.push(f.slice(home.length)); continue }
      read++
      if (needles.some(n => data.includes(n))) leaks.push(f.slice(home.length))
    }
    return { leaks, unreadable, read }
  }

  let app: ElectronApplication | undefined
  try {
    // A client of tetherd that only listens: every broadcast it sees is kept.
    listener = await DaemonClient.connect({ home, pipe, client: 'test', spawn: false })
    listener.on('proc', p => { broadcasts.push(JSON.stringify(p)) })
    listener.on('profiles', p => { broadcasts.push(JSON.stringify(p)) })

    let page: Page
    ;({ app, page } = await launch(home, pipe, consoleLines))
    const until = async (what: string, fn: () => Promise<unknown>, ms = 15_000): Promise<void> => {
      const end = Date.now() + ms
      let last: unknown
      while (Date.now() < end) { try { if (await fn()) return } catch (e) { last = e } await page.waitForTimeout(120) }
      throw new Error(`timeout: ${what}${last ? ` (${(last as Error).message})` : ''}`)
    }
    const sys = async (): Promise<SysSnap> => (await page.evaluate(() => window.__tether.ext.regency.system()))!
    const np = (): Promise<NpSnap> => page.evaluate(() => window.__tether.ext.regency.newProcessView())
    const rowOf = async (key: string): Promise<SysRow | undefined> => (await sys()).view.rows.find(r => r.key === key)
    const openCard = async (): Promise<void> => {
      await page.click('.rg-sys-foot [data-sys="proc-new"]')
      await page.waitForSelector(`${CARD}[open]`)
    }
    const pickFolder = async (path: string): Promise<void> => {
      await page.click(`${CARD} [data-do="folder"]`)
      await page.waitForSelector('dialog.picker[open]')
      await page.keyboard.type(path)
      await page.keyboard.press('Enter')
      await page.waitForSelector('dialog.picker[open]', { state: 'detached' })
      await until('the folder chosen', async () => (await np()).cwd === path)
    }
    const addVar = async (name: string, value: string): Promise<void> => {
      await page.click(`${CARD} [data-do="env-add"]`)
      const row = page.locator(`${CARD} .rg-np-env`).last()
      await row.locator('input[data-f="env-name"]').fill(name)
      await row.locator('input[data-f="env-value"]').fill(value)
    }
    /** Where a canary could still be in the page: the markup, every input's value and attribute, the URL. */
    const pageHas = (needle: string): Promise<string[]> => page.evaluate(n => {
      const found: string[] = []
      if (document.documentElement.outerHTML.includes(n)) found.push('outerHTML')
      if (window.location.href.includes(n)) found.push('url')
      const all = document.querySelectorAll('*')
      for (let i = 0; i < all.length; i++) {
        const e = all[i]!
        if (typeof e.value === 'string' && e.value.includes(n)) found.push('a value property')
        for (const a of e.getAttributeNames()) if ((e.getAttribute(a) ?? '').includes(n)) found.push(`attribute ${a}`)
      }
      return found
    }, needle)
    /** The renderer's JS heap after a collection: no live string holds the needle. */
    const heapHas = async (needles: string[]): Promise<string[]> => {
      const cdp = await page.context().newCDPSession(page)
      let snap = ''
      cdp.on('HeapProfiler.addHeapSnapshotChunk', (e: { chunk: string }) => { snap += e.chunk })
      await cdp.send('HeapProfiler.enable')
      await cdp.send('HeapProfiler.collectGarbage')
      await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
      await cdp.detach()
      return needles.filter(n => snap.includes(n))
    }

    // Into the Regency, Sistema › Processos.
    await page.evaluate(d => window.__tether.runCommand(`desk.system.${d}`), DESK)
    await page.waitForFunction(d => window.__tether.activeDesk() === d, DESK)
    await page.waitForFunction(p => window.__tether.panelIds().includes(p), PANE)
    await page.evaluate(() => window.__tether.ext.regency.openSystem('processes'))
    await until('Sistema › Processos', async () => { const s = await sys(); return s.column === 'system' && s.section === 'processes' })

    // ---- 1. the foot and the card ----
    console.log('step 1')
    const foot = (await sys()).view.foot
    assert.match(foot, /Novo processo/)
    assert.doesNotMatch(foot, /linha de comando/)
    await openCard()
    let v = await np()
    assert.equal(v.open, true)
    assert.equal(v.warning, 'Aqui não é lugar de senha nem chave.', 'the fixed line')
    assert.equal(await page.locator(`${CARD} .rg-np-warn[role="note"]`).isVisible(), true)
    await page.click(`${CARD} [data-do="create"]`)
    await until('the empty name refused', async () => (await np()).errorField === 'name')
    assert.equal((await np()).error, 'Dê um nome ao processo.')
    await page.screenshot({ path: join(SHOTS, 'novo-processo.png') })

    // ---- 2. create one with a port, a common variable and the canary; it runs ----
    console.log('step 2')
    await page.fill(`${CARD} input[data-f="name"]`, 'r7-web')
    await page.fill(`${CARD} input[data-f="command"]`, `node "${fixture}" ${webPort}`)
    await pickFolder(work)
    await page.fill(`${CARD} input[data-f="ports"]`, String(webPort))
    await page.fill(`${CARD} input[data-f="description"]`, 'servidor do r7')
    await addVar('MODO', 'bancada')
    await addVar('NOTA', CANARY)
    const noteValue = page.locator(`${CARD} .rg-np-env`).last().locator('input[data-f="env-value"]')
    assert.equal(await noteValue.getAttribute('type'), 'password', 'a value is a password while typed')
    // "Mostrar": text only while that field is edited; the keyboard leaving hides it again.
    await page.locator(`${CARD} .rg-np-env`).last().locator('[data-do="env-show"]').click()
    await until('shown', async () => (await np()).env[1]!.shown)
    assert.equal(await noteValue.getAttribute('type'), 'text')
    await page.focus(`${CARD} input[data-f="description"]`)
    await until('hidden again when the field is left', async () => !(await np()).env[1]!.shown)
    v = await np()
    assert.deepEqual(v.env, [{ name: 'MODO', filled: true, shown: false }, { name: 'NOTA', filled: true, shown: false }])
    assert.ok(!JSON.stringify(v).includes(CANARY), 'the card\'s snapshot never carries a value')
    await page.screenshot({ path: join(SHOTS, 'novo-processo-variaveis.png') })
    await page.click(`${CARD} [data-do="create"]`)
    await page.waitForSelector(CARD, { state: 'detached' })
    await until('the row is in the list, running', async () => (await rowOf('proc:r7-web'))?.state === 'ok', 30_000)
    const row = (await rowOf('proc:r7-web'))!
    assert.match(row.text, /variáveis: MODO, NOTA/, 'the variables by name')
    assert.ok(!row.text.includes(CANARY) && !row.text.includes('bancada'), 'no value on the row')
    const made = (await proc('r7-web'))!
    assert.equal(made.status, 'running')
    assert.deepEqual(made.card.ports, [webPort])
    assert.equal(made.card.description, 'servidor do r7')
    assert.equal(made.card.command, 'node')
    assert.deepEqual(made.card.args, [fixture, String(webPort)])
    await track('r7-web')
    await until('the process got both variables', async () => {
      try { return readFileSync(procLogPath(home, 'r7-web', 1), 'utf8').includes(`modo bancada nota ${CANARY.length}`) } catch { return false }
    }, 20_000)

    // ---- 3. the canary is nowhere ----
    console.log('step 3')
    assert.deepEqual(await pageHas(CANARY), [], 'not in the DOM, an input, an attribute or the URL')
    assert.ok(!(await page.evaluate(() => window.__tether.processesEmbed('read'))).json.includes(CANARY), 'not in the feed')
    assert.deepEqual(await heapHas([CANARY]), [], 'not in the renderer\'s JS heap')
    assert.ok(!consoleLines.join('\n').includes(CANARY), 'not in the renderer\'s console nor the app\'s output')
    assert.ok(!logs.join('\n').includes(CANARY), 'not in the daemon\'s log')
    assert.ok(broadcasts.some(b => b.includes('"NOTA"')), 'the listener saw the process (names)')
    assert.ok(!broadcasts.join('\n').includes(CANARY), 'not in any broadcast')
    const card = procCardPath(home, 'r7-web')
    assert.ok(readFileSync(card, 'utf8').includes(CANARY), 'the stored recipe has it (what tetherd launches with)')
    const early = homeLeaks([CANARY], [card])
    assert.deepEqual(early.leaks, [], 'no other file of the home (app log, daemon log, history, process log) has it')
    const history = readFileSync(join(home, 'procs', 'r7-web.jsonl'), 'utf8')
    assert.ok(!history.includes(CANARY) && !history.includes('bancada'), 'the history keeps no value')

    // ---- 4. a secret-looking name asks first; "Voltar" is the default ----
    console.log('step 4')
    await openCard()
    await page.fill(`${CARD} input[data-f="name"]`, 'r7-tok')
    await page.fill(`${CARD} input[data-f="command"]`, `node "${fixture}"`)
    await pickFolder(work)
    await addVar('API_TOKEN', CANARY_TOKEN)
    await page.click(`${CARD} [data-do="create"]`)
    await until('the question', async () => (await np()).phase === 'asking')
    v = await np()
    assert.equal(v.question, 'API_TOKEN parece um segredo. Segredo vai no próprio comando, por exemplo `dotenvx run -- …`. Criar mesmo assim?')
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.do), 'ask-back', '"Voltar" has the keyboard')
    await page.screenshot({ path: join(SHOTS, 'novo-processo-segredo.png') })
    await page.keyboard.press('Enter')
    await until('back to the form', async () => (await np()).phase === 'edit')
    assert.equal((await np()).env[0]!.filled, true, 'nothing was sent: the value is still in its field')
    assert.equal(await proc('r7-tok'), undefined, 'nothing made')
    await page.click(`${CARD} [data-do="create"]`)
    await until('asked again', async () => (await np()).phase === 'asking')
    await page.click(`${CARD} [data-do="ask-go"]`)
    await page.waitForSelector(CARD, { state: 'detached' })
    await until('r7-tok in the list', async () => (await rowOf('proc:r7-tok')) !== undefined, 30_000)
    assert.match((await rowOf('proc:r7-tok'))!.text, /variáveis: API_TOKEN/)
    await track('r7-tok')

    // ---- 5. a busy port in plain words; a name in use ----
    console.log('step 5')
    const busyPort = await freePort()
    busyServer = createServer()
    await new Promise<void>(res => busyServer!.listen(busyPort, 'localhost', () => res()))
    await openCard()
    await page.fill(`${CARD} input[data-f="name"]`, 'r7-web')
    await page.fill(`${CARD} input[data-f="command"]`, `node "${fixture}"`)
    await pickFolder(work)
    await page.click(`${CARD} [data-do="create"]`)
    await until('the name in use', async () => (await np()).errorField === 'name')
    assert.match((await np()).error ?? '', /^Já existe um processo "r7-web"/)
    await page.fill(`${CARD} input[data-f="name"]`, 'r7-busy')
    await page.fill(`${CARD} input[data-f="ports"]`, String(busyPort))
    await addVar('NOTA', CANARY_BUSY)
    await page.click(`${CARD} [data-do="create"]`)
    await until('the port refused', async () => (await np()).errorField === 'ports', 20_000)
    v = await np()
    assert.match(v.error ?? '', new RegExp(`^Não iniciei: a porta ${busyPort} já está ocupada`), v.error)
    assert.match(v.error ?? '', /Escolha outra porta ou pare quem a ocupa\. Os valores das variáveis foram apagados: digite-os de novo\.$/)
    assert.doesNotMatch(v.error ?? '', /--force|tether proc/)
    assert.equal(v.phase, 'edit')
    assert.deepEqual(v.env, [{ name: 'NOTA', filled: false, shown: false }], 'the value was emptied at the send')
    assert.equal(await page.locator(`${CARD} .rg-cr-fl[data-field="ports"] .rg-cr-err[role="alert"]`).isVisible(), true)
    assert.deepEqual(await pageHas(CANARY_BUSY), [])
    assert.equal(await proc('r7-busy'), undefined, 'refused before registering')
    await page.keyboard.press('Escape')
    await page.waitForSelector(CARD, { state: 'detached' })
    assert.deepEqual(await heapHas([CANARY, CANARY_TOKEN, CANARY_BUSY]), [], 'no canary in the renderer\'s heap')
    assert.ok(!broadcasts.join('\n').includes(CANARY_TOKEN) && !broadcasts.join('\n').includes(CANARY_BUSY), 'not in any broadcast')
    assert.ok(![...logs, ...consoleLines].join('\n').match(new RegExp(`${CANARY_TOKEN}|${CANARY_BUSY}`)), 'not in any log')

    // ---- 6. the phone: the whole screen, 44 px ----
    console.log('step 6')
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(420, 820) })
    await until('the phone', async () => (await page.evaluate(() => window.__tether.ext.regency.tier())) === 'mobile')
    await page.click('.rg-tabbar [data-tab="tether"]')
    await page.evaluate(() => window.__tether.ext.regency.openSystem('processes'))
    await until('Sistema on the phone', async () => page.locator('.rg-right .rg-sys').isVisible())
    await openCard()
    await page.click(`${CARD} [data-do="env-add"]`)
    assert.equal((await np()).tier, 'mobile')
    const vp = page.viewportSize() ?? (await page.evaluate(() => ({ width: 0, height: 0 })))
    const box = (await page.locator(CARD).boundingBox())!
    const inner = await page.evaluate(() => ({ w: (globalThis as unknown as { innerWidth: number }).innerWidth, h: (globalThis as unknown as { innerHeight: number }).innerHeight }))
    assert.ok(box.width >= inner.w - 1 && box.height >= inner.h - 1, `the whole screen (${box.width}x${box.height} of ${inner.w}x${inner.h}, ${vp.width})`)
    for (const sel of [`${CARD} [data-do="create"]`, `${CARD} [data-do="close"].rg-cr-btn`, `${CARD} [data-do="env-add"]`, `${CARD} [data-do="env-show"]`,
      `${CARD} [data-do="env-del"]`, `${CARD} [data-do="folder"]`, `${CARD} .rg-cr-fl[data-field="name"] .rg-cr-in`, `${CARD} .rg-np-en`]) {
      const b = (await page.locator(sel).first().boundingBox())!
      assert.ok(b.height >= 44, `${sel} is 44 px (${b.height})`)
    }
    await page.screenshot({ path: join(SHOTS, 'novo-processo-celular.png') })
    await page.keyboard.press('Escape')
    await page.waitForSelector(CARD, { state: 'detached' })

    // ---- the home once more, with the app closed (its own files no longer locked) ----
    console.log('step 7')
    await killElectron(app, root)
    app = undefined
    const late = homeLeaks([CANARY, CANARY_TOKEN, CANARY_BUSY], [procCardPath(home, 'r7-web'), procCardPath(home, 'r7-tok')])
    console.log(`[r7c] home scanned: ${late.read} files read, unreadable (locked): ${JSON.stringify(late.unreadable)}`)
    assert.deepEqual(late.leaks, [], 'no file of the home but the two stored recipes has a canary')
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    listener?.close()
    busyServer?.close()
    try {
      const h = await cli(['proc', 'host', '--json'])
      const host = h.code === 0 ? JSON.parse(h.stdout) as { pid: number } | null : null
      if (host?.pid) { const o = await claim(host.pid, { cmdIncludes: home, what: 'tether-procd' }).catch(() => undefined); if (o) owned.push(o) }
      await cli(['proc', 'host', 'stop', '--force'])
    } catch { /* the host goes with its processes below */ }
    for (const o of owned) await killOwned(o, { tree: true }).catch(() => {})
    ch.dispose()
    await door.delivery.flush().catch(() => {})
    own.dispose()
    door.delivery.dispose()
    await daemon.close()
    await door.mcp.close()
    if (testContext !== undefined) process.env.NODE_TEST_CONTEXT = testContext
    await removeHome(home)
  }
})
