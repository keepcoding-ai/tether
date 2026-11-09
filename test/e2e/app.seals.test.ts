// E2E of the extensions' seals (hidden window, private home/pipe, real tetherd, shells only; the renderer is built with
// TETHER_TEST_EXTENSIONS=1, which adds test/e2e/fixtures/system-desk-probe):
//   1. a badge on a pad's icon and on a system desk's pill: count (99+ past two digits), flag alone as a pip, tooltip; zero clears;
//   2. an attention seal on a pane: on its tab (the terminal's dot) and on its desk's pill, with the message in the tooltips;
//      it goes out when the pane gets the focus;
//   3. sticky: focusing does not clear it; the text can be swapped; resolving clears it;
//   4. clicking the seal tells the extension that raised it; several seals on a pane live together;
//   5. a seal on a pane of a system desk shows on that desk's pill;
//   6. the extension going takes its badges and seals with it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  panelIds(): string[]
  slots(): SlotState[]
  connection(): { connected: boolean; pid?: number } | undefined
  activeDesk(): string
  activate(id: string): void
  movePaneToDesk(slotId: string, deskId: string): void
  disposeExtension(id: string): void
  desks(): { id: string; attention: { done: number; waiting: number; lines?: string[] } }[]
  ext: Record<string, Record<string, (...args: unknown[]) => unknown>>
}
type El = { textContent: string | null; className: string; title: string }
type Doc = { querySelector(selector: string): El | null }
declare const window: { __tether: Hooks }
declare const document: Doc

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-seals-${process.pid}`
const SYS = 'system-desk-probe.main'
const PAD = 'system-desk-probe.pad'
const EXT = 'system-desk-probe'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  delete env.TETHER_CLAUDE_ARGS
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

async function createShell(page: Page, cwd: string): Promise<string> {
  const before = await page.evaluate(() => window.__tether.panelIds())
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  await page.click('#dlg-new .ch-item[data-id="powershell"]')
  await page.waitForFunction(() => document.querySelector('#dlg-new[open]') === null)
  await page.waitForFunction(n => window.__tether.panelIds().length === n, before.length + 1)
  const added = (await page.evaluate(() => window.__tether.panelIds())).filter(id => !before.includes(id))
  assert.equal(added.length, 1)
  return added[0]!
}

const probe = <T>(page: Page, name: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(([n, a]) => window.__tether.ext['system-desk-probe']![n as string]!(...(a as unknown[])) as never, [name, args] as const)
const tab = (id: string): string => `.tether-tab[data-slot="${id}"]`
const dot = (page: Page, id: string): Promise<string | null> => page.evaluate(sel => document.querySelector(sel)?.className ?? null, `${tab(id)} .attn`)
const dotTitle = (page: Page, id: string): Promise<string | null> => page.evaluate(sel => document.querySelector(sel)?.title ?? null, `${tab(id)} .attn`)
const text = (page: Page, sel: string): Promise<string | null> => page.evaluate(s => { const e = document.querySelector(s); return e ? e.textContent : null }, sel)
const klass = (page: Page, sel: string): Promise<string | null> => page.evaluate(s => document.querySelector(s)?.className ?? null, sel)
const titleOf = (page: Page, sel: string): Promise<string | null> => page.evaluate(s => document.querySelector(s)?.title ?? null, sel)
const gone = (page: Page, sel: string): Promise<unknown> => page.waitForFunction(s => document.querySelector(s) === null, sel)
const lit = (page: Page, id: string): Promise<unknown> => page.waitForFunction(sel => document.querySelector(sel)?.className.includes('waiting') === true, `${tab(id)} .attn`)
const unlit = (page: Page, id: string): Promise<unknown> => page.waitForFunction(sel => !document.querySelector(sel)?.className.includes('waiting'), `${tab(id)} .attn`)

test('seals: badges on pads and system desk pills, attention seals on panes', { timeout: 420_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-seals-'))
  const daemons: Owned[] = []
  const pids: number[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const d1 = await page.evaluate(() => window.__tether.activeDesk())
    const padIcon = `.sb-icon[data-pad="${PAD}"]`
    const padBadge = `${padIcon} .sb-badge`
    const sysPill = `#desk-switch .seg.sys[data-system="${SYS}"]`
    const deskBadge = `${sysPill} .sys-badge`

    // ---- 1. badges ----
    console.log('step 1: badges')
    await page.waitForSelector(padIcon)
    assert.equal(await text(page, padBadge), null, 'no badge to begin with')
    await probe(page, 'padBadge', { count: 3, tooltip: 'tres coisas' })
    await page.waitForSelector(padBadge)
    assert.equal(await text(page, padBadge), '3')
    assert.ok((await klass(page, padBadge))!.includes('plain'))
    assert.ok((await titleOf(page, padIcon))!.includes('tres coisas'))
    await probe(page, 'padBadge', { count: 250, attention: true })
    await page.waitForFunction(sel => document.querySelector(sel)?.textContent === '99+', padBadge)
    assert.ok((await klass(page, padBadge))!.includes('waiting'))
    await probe(page, 'padBadge', { attention: true })
    await page.waitForFunction(sel => document.querySelector(sel)?.className.includes('pip') === true, padBadge)
    assert.equal(await text(page, padBadge), '')
    await probe(page, 'padBadge', { count: 0 })
    await gone(page, padBadge)
    await probe(page, 'deskBadge', { count: 2, tooltip: 'duas na mesa' })
    await page.waitForSelector(deskBadge)
    assert.equal(await text(page, deskBadge), '2')
    assert.ok((await titleOf(page, sysPill))!.includes('duas na mesa'))
    await probe(page, 'deskBadge', undefined)
    await gone(page, deskBadge)

    // ---- 2. a normal seal on a pane ----
    console.log('step 2: normal seal')
    const a = await createShell(page, root)
    const b = await createShell(page, root) // b is in front now
    for (const id of [a, b]) {
      await page.waitForFunction(id => window.__tether.slots().some(s => s.slotId === id && s.status === 'running' && typeof s.pid === 'number'), id, { timeout: 20_000 })
      pids.push((await page.evaluate(() => window.__tether.slots())).find(s => s.slotId === id)!.pid!)
    }
    assert.notEqual(await dot(page, a), null)
    await probe<number>(page, 'raise', a, 'o agente pede ajuda', false)
    await lit(page, a)
    assert.ok((await dotTitle(page, a))!.includes('o agente pede ajuda'), 'the message is in the tab dot tooltip')
    assert.ok((await titleOf(page, tab(a)))!.includes('o agente pede ajuda'))
    await page.waitForFunction(d => window.__tether.desks().find(x => x.id === d)!.attention.waiting === 1, d1)
    const lines = await page.evaluate(d => window.__tether.desks().find(x => x.id === d)!.attention.lines, d1)
    assert.deepEqual(lines, ['o agente pede ajuda'])
    assert.ok((await titleOf(page, `#desk-switch .seg[data-desk="${d1}"]`))!.includes('o agente pede ajuda'), "the desk pill's tooltip carries the message")
    assert.equal(await text(page, `#desk-switch .seg[data-desk="${d1}"] .desk-badge`), '1')
    await page.evaluate(id => window.__tether.activate(id), a)
    await unlit(page, a)
    await page.waitForFunction(d => window.__tether.desks().find(x => x.id === d)!.attention.waiting === 0, d1)

    // ---- 3. sticky ----
    console.log('step 3: sticky')
    await page.evaluate(id => window.__tether.activate(id), b)
    const i2 = await probe<number>(page, 'raise', a, 'faca o login', true)
    await lit(page, a)
    await page.evaluate(id => window.__tether.activate(id), a)
    await sleep(600)
    assert.ok((await dot(page, a))!.includes('waiting'), 'focusing does not clear a sticky seal')
    await probe(page, 'update', i2, 'espera voce devolver')
    await page.waitForFunction(sel => document.querySelector(sel)?.title.includes('espera voce devolver') === true, `${tab(a)} .attn`)

    // ---- 4. click, and seals living together ----
    console.log('step 4: click and company')
    const i3 = await probe<number>(page, 'raise', a, 'segunda', true)
    await page.click(`${tab(a)} .attn`)
    await page.waitForFunction(() => (window.__tether.ext['system-desk-probe']!.activations!() as number[]).length >= 1)
    assert.deepEqual((await probe<number[]>(page, 'activations')).sort(), [i2, i3])
    const title = (await dotTitle(page, a))!
    assert.ok(title.includes('espera voce devolver') && title.includes('segunda'))
    await probe(page, 'resolve', i2)
    assert.ok((await dot(page, a))!.includes('waiting'), 'the other seal is still there')
    await probe(page, 'resolve', i3)
    await unlit(page, a)

    // ---- 5. a pane of a system desk ----
    console.log('step 5: system desk pill')
    await page.evaluate(([id, to]) => window.__tether.movePaneToDesk(id, to), [b, SYS] as const)
    await page.evaluate(id => window.__tether.activate(id), a)
    await probe<number>(page, 'raise', b, 'da mesa de sistema', true)
    await page.waitForSelector(deskBadge)
    assert.equal(await text(page, deskBadge), '1')
    assert.ok((await klass(page, deskBadge))!.includes('waiting'))
    assert.ok((await titleOf(page, sysPill))!.includes('da mesa de sistema'))

    // ---- 6. the extension goes ----
    console.log('step 6: extension gone')
    await probe(page, 'padBadge', { count: 5 })
    await page.waitForSelector(padBadge)
    await page.evaluate(id => window.__tether.disposeExtension(id), EXT)
    await gone(page, padBadge)
    await page.waitForFunction(() => window.__tether.desks().every(d => d.attention.waiting === 0))
    await unlit(page, b)
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const pid of pids) if (pidAlive(pid)) { try { process.kill(pid) } catch { /* gone */ } }
    for (const d of daemons) await killOwned(d, { tree: true })
    rmSync(home, { recursive: true, force: true })
  }
})
