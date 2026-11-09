// E2E of the `systemDesks` contribution point (a manifest declares a system desk; the core knows nothing of its owner) and of
// taking a system desk back, with shells only (hidden window, private home/pipe, real tetherd, CLAUDE* stripped). The renderer
// is built with TETHER_TEST_EXTENSIONS=1, which adds the probe extension (test/e2e/fixtures/system-desk-probe):
//   1. extension on: its pill is in the capsule, with its "Ir para" command, an entry in layout.json and its colour on the
//      workbench line; the extension API (toggle, isActive, onDidChangeActive) enters and leaves the desk;
//   2. undeclare in run (the disposer of declareSystemDesk, what turning the owner off does): pill and command go, the person
//      goes back to the desk they came from, the panes stop being shown, the content stays in layout.json; declaring again
//      brings it back with the content (the same process);
//   3. extension off (settings.json `extensions.disabled`, takes effect at the next start): no pill, no command, the first
//      queue desk is active, a save keeps the desk's content in the file; on again (restart): pill and content are back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  renameDesk(id: string, name: string): void
  movePaneToDesk(slotId: string, deskId: string): void
  declareSystemDesk(decl: { id: string; title: string; icon?: string; color?: string }): () => void
  toggleSystemDesk(id: string): void
  commands(): { id: string; title: string }[]
  layout(): FileLayout
  ext: Record<string, Record<string, () => unknown>>
}
type El = { textContent: string | null; getAttribute(n: string): string | null; previousElementSibling: { id: string } | null }
type Doc = { querySelectorAll(selector: string): { length: number } & Iterable<El>; getElementById(id: string): { style: { getPropertyValue(n: string): string } } | null }
declare const window: { __tether: Hooks; __off?: () => void }
declare const document: Doc

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-sysdesk-ext-${process.pid}`
const SYS = 'system-desk-probe.main'
const LOOSE = 'test-loose'

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
  line: (page: Page) => page.evaluate(() => document.getElementById('workbench')!.style.getPropertyValue('--desk-line-color')),
  file: (home: string) => JSON.parse(readFileSync(join(home, 'layout.json'), 'utf8')) as FileLayout,
  filePanes: (home: string, id = SYS) => Object.values(h.file(home).systemDesks[id]!.frames.views).flatMap(v => Object.keys(v.panels)),
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

const probe = <T>(page: Page, name: string): Promise<T> => page.evaluate(n => window.__tether.ext['system-desk-probe']![n]!() as never, name)
const setDisabled = (home: string, ids: string[]): void => writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { disabled: ids } }))
const shown = (page: Page): Promise<string[]> => page.evaluate(() => window.__tether.panelIds())

test('systemDesks: contribution point, undeclare, extension off and on', { timeout: 420_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-sysdesk-ext-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const [d1] = await h.deskIds(page) as [string]

    // ---- 1. extension on ----
    console.log('step 1')
    assert.deepEqual(await h.pills(page), [{ id: SYS, text: 'Prova', pressed: 'false', after: 'btn-drawer' }])
    assert.ok(await page.evaluate(id => window.__tether.commands().some(c => c.id === `desk.system.${id}` && c.title === 'Ir para Prova'), SYS))
    assert.deepEqual(await page.evaluate(() => Object.keys(window.__tether.layout().systemDesks)), [SYS])
    assert.deepEqual(await h.deskIds(page), [d1], 'the queue does not list it')
    const queueLine = await h.line(page)
    assert.equal(await probe(page, 'isActive'), false)
    await page.click(`#desk-switch .seg.sys[data-system="${SYS}"]`)
    assert.equal(await h.active(page), SYS)
    assert.equal(await probe(page, 'isActive'), true)
    assert.notEqual(await h.line(page), queueLine, 'the workbench line takes the system desk colour (green), not the last queue desk')
    await probe(page, 'toggle')
    assert.equal(await h.active(page), d1, 'the extension API toggles it back')
    assert.equal(await h.line(page), queueLine)
    await probe(page, 'toggle')
    assert.equal(await h.active(page), SYS)
    assert.deepEqual(await probe(page, 'changes'), [{ id: SYS, active: true }, { id: SYS, active: false }, { id: SYS, active: true }])
    const a = await createShell(page, root)
    const pid = await pidOf(page, a)
    await page.evaluate(([id, to]) => window.__tether.movePaneToDesk(id, to), [a, SYS] as const)
    assert.equal(await page.evaluate(id => window.__tether.deskOf(id), a), SYS)
    await probe(page, 'toggle')
    await sleep(900)
    assert.deepEqual(h.filePanes(home), [a], 'saved under systemDesks')

    // ---- 2. undeclare in run (a desk declared through the hook, with a pane) ----
    console.log('step 2')
    await page.evaluate(id => { window.__off = window.__tether.declareSystemDesk({ id, title: 'Solta', color: 'red' }) }, LOOSE)
    const b = await createShell(page, root)
    const pidB = await pidOf(page, b)
    await page.evaluate(([id, to]) => window.__tether.movePaneToDesk(id, to), [b, LOOSE] as const)
    await page.evaluate(id => window.__tether.toggleSystemDesk(id), LOOSE)
    assert.equal(await h.active(page), LOOSE)
    await page.evaluate(() => window.__off!())
    assert.equal(await h.active(page), d1, 'the person goes back to the desk they came from')
    assert.deepEqual((await h.pills(page)).map(p => p.id), [SYS], 'its pill is gone')
    assert.ok(!await page.evaluate(id => window.__tether.commands().some(c => c.id === `desk.system.${id}`), LOOSE), 'and its command')
    assert.ok(!(await shown(page)).includes(b), 'its panes stop being shown')
    assert.equal(await page.evaluate(id => window.__tether.layout().systemDesks[id] !== undefined, LOOSE), true, 'the layout still holds it')
    await page.evaluate(([id, name]) => window.__tether.renameDesk(id, name), [d1, 'Primeira'] as const) // a save with it undeclared
    await sleep(900)
    assert.deepEqual(h.filePanes(home, LOOSE), [b], 'the file keeps its content')
    await page.evaluate(id => { window.__tether.declareSystemDesk({ id, title: 'Solta', color: 'red' }) }, LOOSE)
    assert.equal(await page.evaluate(id => window.__tether.deskOf(id), b), LOOSE, 'declared again: the content is back')
    assert.equal(await pidOf(page, b), pidB, 'same process')

    // ---- 3. extension off, then on (restart) ----
    console.log('step 3')
    await killElectron(app, root)
    app = undefined
    setDisabled(home, ['system-desk-probe'])
    ;({ app, page } = await launch(home))
    await page.waitForFunction(() => window.__tether.desks().length > 0)
    assert.deepEqual(await h.pills(page), [], 'off: no pill')
    assert.ok(!await page.evaluate(id => window.__tether.commands().some(c => c.id === `desk.system.${id}`), SYS), 'no command')
    assert.equal(await h.active(page), d1)
    assert.ok(!(await shown(page)).includes(a), 'its panes are not shown')
    await page.evaluate(([id, name]) => window.__tether.renameDesk(id, name), [d1, 'Segunda'] as const)
    await sleep(900)
    assert.equal(h.file(home).desks[0]!.name, 'Segunda')
    assert.deepEqual(h.filePanes(home), [a], 'the file keeps the desk content through a save')
    await killElectron(app, root)
    app = undefined
    setDisabled(home, [])
    ;({ app, page } = await launch(home))
    await page.waitForFunction(() => window.__tether.desks().length > 0)
    assert.deepEqual((await h.pills(page)).map(p => p.id), [SYS], 'on again: the pill is back')
    await page.waitForFunction(id => window.__tether.deskOf(id) === 'system-desk-probe.main', a)
    assert.equal(await pidOf(page, a), pid, 'with its content, the same process')
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
