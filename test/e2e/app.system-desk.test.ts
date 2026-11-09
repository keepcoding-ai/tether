// E2E of the system desk (a desk an owner declares, outside the queue), with shells only (hidden window, private
// home/pipe, real tetherd, CLAUDE* stripped). The test declares one through the e2e hook:
//   1. without a declaration the capsule has no extra pill and layout.json has no system desk;
//   2. declared: a pill after the Gaveta's, a "Ir para <title>" command, an empty entry in layout.json; the queue is unchanged;
//   3. the pill enters it (no queue segment is on) and, pressed again, goes back to the desk the person was on;
//   4. it is not in the Ctrl+1…9 / next-previous cycle, and cannot be renamed, reordered or closed;
//   5. a pane moves into it (same PID) and is saved under `systemDesks`;
//   6. relaunch with it active: declared again, it reopens there with the pane; relaunch without declaring: the first
//      queue desk is active and the file keeps the system desk's data through a save.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type FileLayout = { activeDesk: string; desks: { id: string; name: string }[]; systemDesks: Record<string, { frames: { views: Record<string, { panels: Record<string, unknown> }> } }> }
type Hooks = {
  panelIds(): string[]
  slots(): SlotState[]
  connection(): { connected: boolean; pid?: number } | undefined
  activeDesk(): string
  desks(): { id: string; name: string }[]
  deskOf(slotId: string): string | undefined
  switchDesk(id: string): void
  createDesk(side: 'before' | 'after', relativeTo?: string): string
  renameDesk(id: string, name: string): void
  moveDesk(id: string, to: number): void
  closeDesk(id: string): void
  movePaneToDesk(slotId: string, deskId: string): void
  declareSystemDesk(decl: { id: string; title: string; icon?: string }): () => void
  toggleSystemDesk(id: string): void
  systemDesks(): { id: string; name: string; panes: string[]; active: boolean }[]
  commands(): { id: string; title: string }[]
  runCommand(id: string): void
  layout(): FileLayout
}
type El = { textContent: string | null; getAttribute(n: string): string | null; previousElementSibling: { id: string } | null; classList: { contains(c: string): boolean } }
type Doc = { querySelectorAll(selector: string): { length: number } & Iterable<El> }
declare const window: { __tether: Hooks }
declare const document: Doc

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-sysdesk-${process.pid}`
const SYS = 'test-sys'

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
  page.on('console', m => { if (m.type() === 'error') console.error(`renderer console: ${m.text()}`) })
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

const h = {
  active: (page: Page) => page.evaluate(() => window.__tether.activeDesk()),
  deskIds: (page: Page) => page.evaluate(() => window.__tether.desks().map(d => d.id)),
  pills: (page: Page) => page.evaluate(() => [...document.querySelectorAll('#desk-switch .seg.sys')].map(el => ({ id: el.getAttribute('data-system'), text: el.textContent, pressed: el.getAttribute('aria-pressed'), after: el.previousElementSibling?.id ?? '' }))),
  segsOn: (page: Page) => page.evaluate(() => document.querySelectorAll('#desk-switch .desk-segs .seg.on').length),
  file: (home: string) => JSON.parse(readFileSync(join(home, 'layout.json'), 'utf8')) as FileLayout,
  filePanes: (home: string) => Object.values(h.file(home).systemDesks[SYS]!.frames.views).flatMap(v => Object.keys(v.panels)),
}

async function createShell(page: Page, cwd: string): Promise<string> {
  const before = await page.evaluate(() => window.__tether.panelIds())
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  await page.click('#dlg-new .ch-item[data-id="powershell"]')
  await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
  await page.waitForFunction(n => window.__tether.panelIds().length === n, before.length + 1)
  const added = (await page.evaluate(() => window.__tether.panelIds())).filter(id => !before.includes(id))
  assert.equal(added.length, 1)
  return added[0]!
}

async function pidOf(page: Page, id: string): Promise<number> {
  await page.waitForFunction(id => { const s = window.__tether.slots().find(x => x.slotId === id); return s?.status === 'running' && typeof s.pid === 'number' }, id, { timeout: 20_000 })
  return (await page.evaluate(() => window.__tether.slots())).find(s => s.slotId === id)!.pid!
}

test('system desk: pill, toggle, outside the queue, moves, persistence', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-sysdesk-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // ---- 1. nothing declared: today's interface ----
    console.log('step 1')
    assert.deepEqual(await h.pills(page), [])
    assert.deepEqual(await page.evaluate(() => Object.keys(window.__tether.layout().systemDesks)), [])
    assert.deepEqual(await page.evaluate(() => window.__tether.systemDesks()), [])

    // ---- 2. declared ----
    console.log('step 2')
    const [d1] = await h.deskIds(page) as [string]
    const d2 = await page.evaluate(() => window.__tether.createDesk('after'))
    await page.evaluate(id => window.__tether.switchDesk(id), d1)
    await page.evaluate(id => { window.__tether.declareSystemDesk({ id, title: 'Teste', icon: 'terminal-window' }) }, SYS)
    assert.deepEqual(await h.pills(page), [{ id: SYS, text: 'Teste', pressed: 'false', after: 'btn-drawer' }])
    assert.deepEqual(await h.deskIds(page), [d1, d2], 'the queue does not list it')
    assert.ok(await page.evaluate(() => window.__tether.commands().some(c => c.id === 'desk.system.test-sys' && c.title === 'Ir para Teste')))
    assert.deepEqual(await page.evaluate(() => Object.keys(window.__tether.layout().systemDesks)), [SYS])

    // ---- 3. enter and leave ----
    console.log('step 3')
    await page.click(`#desk-switch .seg.sys[data-system="${SYS}"]`)
    assert.equal(await h.active(page), SYS)
    assert.equal((await h.pills(page))[0]!.pressed, 'true')
    assert.equal(await h.segsOn(page), 0, 'no queue segment is on while the system desk shows')
    assert.equal(await page.evaluate(id => document.querySelectorAll(`.desk-layer[data-desk="${id}"]:not(.inactive)`).length, SYS), 1)
    await page.screenshot({ path: join(artifacts, 'system-desk-on.png') })
    await page.click(`#desk-switch .seg.sys[data-system="${SYS}"]`)
    assert.equal(await h.active(page), d1, 'back to the desk the person was on')
    assert.equal((await h.pills(page))[0]!.pressed, 'false')
    await page.evaluate(id => window.__tether.switchDesk(id), d2)
    await page.evaluate(() => window.__tether.runCommand('desk.system.test-sys'))
    assert.equal(await h.active(page), SYS, 'the command enters it too')
    await page.evaluate(() => window.__tether.runCommand('desk.system.test-sys'))
    assert.equal(await h.active(page), d2, 'and leaves it for the last queue desk')

    // ---- 4. outside the queue ----
    console.log('step 4')
    await page.evaluate(() => window.__tether.toggleSystemDesk('test-sys'))
    await page.keyboard.press('Control+Tab')
    assert.equal(await h.active(page), d1, 'next counts from the desk it came from (d2), wrapping to d1')
    await page.keyboard.press('Control+1')
    assert.equal(await h.active(page), d1)
    await page.evaluate(() => window.__tether.toggleSystemDesk('test-sys'))
    await page.keyboard.press('Control+3')
    assert.equal(await h.active(page), SYS, 'there is no desk 3: the system desk has no number and Ctrl+3 does nothing')
    await page.evaluate(id => { window.__tether.renameDesk(id, 'Outro'); window.__tether.moveDesk(id, 0); window.__tether.closeDesk(id) }, SYS)
    assert.equal((await page.evaluate(() => window.__tether.systemDesks()))[0]!.name, 'Teste')
    assert.deepEqual(await h.deskIds(page), [d1, d2])
    await page.evaluate(() => window.__tether.toggleSystemDesk('test-sys'))

    // ---- 5. moving a pane in ----
    console.log('step 5')
    const a = await createShell(page, root)
    const pid = await pidOf(page, a)
    await page.evaluate(([id, to]) => window.__tether.movePaneToDesk(id, to), [a, SYS] as const)
    assert.equal(await page.evaluate(id => window.__tether.deskOf(id), a), SYS)
    await page.evaluate(() => window.__tether.toggleSystemDesk('test-sys'))
    assert.equal(await pidOf(page, a), pid, 'same process')
    await sleep(900)
    assert.deepEqual(h.filePanes(home), [a], 'saved under systemDesks')
    assert.equal(h.file(home).activeDesk, SYS, 'the active desk is saved')
    assert.ok(!h.file(home).desks.some(d => d.id === SYS), 'never in the queue')

    // ---- 6. relaunch ----
    console.log('step 6')
    await killElectron(app, root)
    app = undefined
    ;({ app, page } = await launch(home))
    await page.waitForFunction(() => window.__tether.desks().length > 0)
    assert.equal(await h.active(page), d1, 'not declared yet: the first queue desk')
    await page.evaluate(id => { window.__tether.declareSystemDesk({ id, title: 'Teste' }) }, SYS)
    assert.equal(await h.active(page), SYS, 'declared: it reopens active')
    await page.waitForFunction(id => window.__tether.deskOf(id) === 'test-sys', a)
    assert.equal(await pidOf(page, a), pid)

    await killElectron(app, root)
    app = undefined
    ;({ app, page } = await launch(home))
    await page.waitForFunction(() => window.__tether.desks().length > 0)
    await page.evaluate(([id, name]) => window.__tether.renameDesk(id, name), [d1, 'Primeira'] as const) // a save without the system desk declared
    await sleep(900)
    assert.equal(h.file(home).desks[0]!.name, 'Primeira')
    assert.deepEqual(h.filePanes(home), [a], 'the file keeps its data')
    assert.equal(await h.active(page), d1)
    assert.deepEqual(await h.pills(page), [])
  } finally {
    console.log('teardown')
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    for (let i = 0; i < 20 && daemons.some(d => pidAlive(d.pid)); i++) await sleep(500)
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
