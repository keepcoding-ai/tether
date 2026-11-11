// E2E of the tab emblems (app/renderer/tab-emblems.ts), hidden window, private home/pipe, real tetherd, PowerShell slots:
//   1. right-click a slot tab → "Emblema…" → the popover lists the 6 built-ins → "Cliente" → the tab shows its chip with
//      the briefcase symbol; layout.json gets the tab's params.emblem;
//   2. an empty pane's tab has "Emblema…" too and applying works there;
//   3. "Gerenciar emblemas…": Cliente's colour and icon (search "foguete", Enter) repaint the tab live; "Restaurar padrão"
//      shows and restores;
//   4. a new emblem "Meu" (colour + an icon picked through the rail) on a second tab, deleted from the editor: the inline
//      confirmation says "Está em 1 guia", the tab loses its chip; a built-in is hidden and another recoloured;
//   5. relaunch with the same home: the library (edited and hidden state) and the remaining emblems come back;
//   6. a tab with an emblem closed and reopened from its slot comes back without one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { buildIconIndex, searchIcons } from '../../app/renderer/emblem-rules.ts'
import { EMBLEM_ICONS } from '../../app/renderer/emblem-icons.ts'

type Hooks = {
  connection(): { connected: boolean; pid?: number } | undefined
  panelIds(): string[]
  activate(id: string): void
  activeId(): string | undefined
  openSlot(id: string): void
  closePanel(id: string): void
}
declare const window: { __tether: Hooks }
declare const document: { querySelector(s: string): { dataset: { theme?: string } } | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-tab-emblems-${process.pid}`

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

const clickMenu = (app: ElectronApplication, id: string) => app.evaluate(({ Menu }, id) => { Menu.getApplicationMenu()?.getMenuItemById(id)?.click() }, id)
const tab = (id: string): string => `.tether-tab[data-slot="${id}"]`
const chip = (id: string): string => `${tab(id)} .emb-chip:not([hidden])`
const shot = (page: Page, name: string): Promise<Buffer> => page.screenshot({ path: join(artifacts, `tab-emblems-${name}.png`) })

async function createShellPanel(page: Page, cwd: string): Promise<string> {
  const before = await page.evaluate(() => window.__tether.panelIds())
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  await page.click('#dlg-new .ch-item[data-id="powershell"]')
  await page.click('#dlg-new .btn.primary.go')
  await page.locator('#dlg-new[open]').waitFor({ state: 'hidden' })
  await page.waitForFunction(n => window.__tether.panelIds().length === n, before.length + 1)
  return (await page.evaluate(() => window.__tether.panelIds())).find(i => !before.includes(i))!
}

async function focusShell(page: Page, id: string): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await page.evaluate(id => window.__tether.activate(id), id)
    await page.locator(`.panel[data-slot-id="${id}"] .panel-term`).click()
    try { await page.waitForFunction(id => window.__tether.activeId() === id, id, { timeout: 2000 }); return } catch { await sleep(150) }
  }
}

/** Right-click on the tab → "Emblema…" → the popover. */
async function openPopover(page: Page, id: string, shotMenu?: string): Promise<void> {
  await page.click(tab(id), { button: 'right' })
  const item = page.locator('#ctx-menu li[role^=menuitem]', { hasText: 'Emblema…' })
  await item.waitFor()
  if (shotMenu) await shot(page, shotMenu)
  await item.click()
  await page.waitForSelector('#ctx-menu.emb-menu')
}
async function pick(page: Page, id: string, name: string): Promise<void> {
  await openPopover(page, id)
  await page.locator('#ctx-menu.emb-menu li[role=menuitemradio]', { hasText: name }).click()
  await page.locator('#ctx-menu').waitFor({ state: 'detached' })
}
async function openEditor(page: Page, id: string): Promise<void> {
  await openPopover(page, id)
  await page.locator('#ctx-menu.emb-menu li', { hasText: 'Gerenciar emblemas…' }).click()
  await page.waitForSelector('dialog.emb-dlg[open]')
}
const chipIcon = (page: Page, id: string): Promise<string | null> => page.locator(`${chip(id)} use`).getAttribute('href')
const chipBg = (page: Page, id: string): Promise<string | null> => page.locator(chip(id)).getAttribute('style')

type Json = Record<string, unknown>
function readLayout(home: string): Json { return JSON.parse(readFileSync(join(home, 'layout.json'), 'utf8')) as Json }
/** The params of panel `id` anywhere in layout.json (dockview's serialized panels). */
function savedParams(layout: unknown, id: string): Json | undefined {
  if (typeof layout !== 'object' || layout === null) return undefined
  const o = layout as Json
  if (o.id === id && typeof o.params === 'object' && o.params !== null) return o.params as Json
  for (const v of Object.values(o)) { const r = savedParams(v, id); if (r) return r }
  return undefined
}
async function waitSaved(home: string, ok: (l: Json) => boolean, what: string): Promise<Json> {
  const deadline = Date.now() + 8000
  let last: Json = {}
  while (Date.now() < deadline) {
    try { last = readLayout(home); if (ok(last)) return last } catch { /* absent or being written */ }
    await sleep(200)
  }
  assert.fail(`layout.json: ${what}\n${JSON.stringify(last).slice(0, 2000)}`)
}

test('tab emblems: menu, popover, editor, search, new/delete, relaunch, close', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-emblems-'))
  const work = mkdtempSync(join(tmpdir(), 'tether-emblems-work-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await clickMenu(app, 'theme-dark')
    await page.waitForFunction(() => document.querySelector('html')?.dataset.theme === 'dark')
    const a = await createShellPanel(page, work)
    const b = await createShellPanel(page, work)

    // ---- 1. slot tab: "Emblema…" → popover → Cliente ----
    console.log('step 1')
    await openPopover(page, a, 'menu-dark')
    const names = await page.locator('#ctx-menu.emb-menu li[role=menuitemradio]').allInnerTexts()
    assert.deepEqual(names.map(s => s.trim()), ['Cliente', 'Pessoal', 'Estudo', 'Revisar', 'Deploy', 'Bug', 'Nenhum'])
    assert.equal(await page.locator('#ctx-menu.emb-menu li[aria-checked="true"]').innerText(), 'Nenhum', 'no emblem yet')
    await shot(page, 'popover-dark')
    await page.locator('#ctx-menu.emb-menu li[role=menuitemradio]', { hasText: 'Cliente' }).click()
    await page.waitForSelector(chip(a))
    assert.equal(await chipIcon(page, a), '#emb-briefcase')
    assert.match((await chipBg(page, a))!, /--x-blue\)/)
    assert.equal(await page.locator(chip(a)).getAttribute('title'), 'Cliente')
    await waitSaved(home, l => savedParams(l, a)?.emblem === 'b-cliente', `params.emblem of ${a}`)

    // ---- 2. an empty pane's tab ----
    console.log('step 2')
    await focusShell(page, b)
    const before = await page.evaluate(() => window.__tether.panelIds())
    await page.keyboard.press('Control+Shift+ArrowRight')
    await page.waitForFunction(n => window.__tether.panelIds().length === n, before.length + 1)
    const empty = (await page.evaluate(() => window.__tether.panelIds())).find(i => !before.includes(i))!
    assert.ok(empty.startsWith('empty:'), empty)
    await pick(page, empty, 'Estudo')
    await page.waitForSelector(chip(empty))
    assert.equal(await chipIcon(page, empty), '#emb-book-open')
    await waitSaved(home, l => savedParams(l, empty)?.emblem === 'b-estudo', `params.emblem of ${empty}`)

    // ---- 3. editor: colour + icon by search repaint live; Restaurar padrão ----
    console.log('step 3')
    await openEditor(page, a)
    assert.equal(await page.locator('dialog.emb-dlg .emb-li.sel .emb-nm').innerText(), 'Cliente', 'the editor opens on the tab\'s emblem')
    assert.equal(await page.locator('dialog.emb-dlg [data-a="reset"]').count(), 0, 'unmodified: no restore')
    await shot(page, 'editor-dark')
    await page.click('dialog.emb-dlg .emb-s[data-c="red"]')
    await page.waitForFunction(sel => /--x-red\)/.test((globalThis as unknown as { document: { querySelector(s: string): { getAttribute(n: string): string | null } | null } }).document.querySelector(sel)?.getAttribute('style') ?? ''), chip(a))
    const expected = searchIcons(buildIconIndex(EMBLEM_ICONS), 'foguete')![0]!
    await page.fill('dialog.emb-dlg .emb-pk-s input', 'foguete')
    await page.waitForSelector('dialog.emb-dlg .emb-grid:not([hidden]) .emb-sec h4')
    assert.match(await page.locator('dialog.emb-dlg .emb-grid:not([hidden]) h4').innerText(), /resultado/i)
    await shot(page, 'search-dark')
    await page.press('dialog.emb-dlg .emb-pk-s input', 'Enter')
    await page.waitForFunction(([sel, href]) => (globalThis as unknown as { document: { querySelector(s: string): { getAttribute(n: string): string | null } | null } }).document.querySelector(sel)?.getAttribute('href') === href, [`${chip(a)} use`, `#emb-${expected}`] as const)
    await page.locator('dialog.emb-dlg [data-a="reset"]').click()
    await page.waitForFunction(([sel]) => (globalThis as unknown as { document: { querySelector(s: string): { getAttribute(n: string): string | null } | null } }).document.querySelector(sel)?.getAttribute('href') === '#emb-briefcase', [`${chip(a)} use`] as const)
    assert.match((await chipBg(page, a))!, /--x-blue\)/)
    assert.equal(await page.locator('dialog.emb-dlg [data-a="reset"]').count(), 0, 'restored: the button goes away')

    // ---- 4. a new emblem on a second tab, then deleted; a built-in hidden, another recoloured ----
    console.log('step 4')
    await page.click('dialog.emb-dlg .emb-li[data-new]')
    await page.keyboard.type('Meu')
    await page.click('dialog.emb-dlg .emb-s[data-c="green"]')
    await page.click('dialog.emb-dlg .emb-rail [data-cat="natureza"]')
    const natIcon = await page.locator('dialog.emb-dlg .emb-sec[data-sec="natureza"] .emb-c').first().getAttribute('data-i')
    await page.locator('dialog.emb-dlg .emb-sec[data-sec="natureza"] .emb-c').first().click()
    assert.equal(await page.locator('dialog.emb-dlg .emb-li.sel .emb-nm').innerText(), 'Meu')
    await page.click('dialog.emb-dlg [data-a="done"]')
    await page.waitForSelector('dialog.emb-dlg[open]', { state: 'hidden' })
    await pick(page, b, 'Meu')
    await page.waitForSelector(chip(b))
    assert.equal(await chipIcon(page, b), `#emb-${natIcon}`)
    assert.match((await chipBg(page, b))!, /--x-green\)/)
    await shot(page, 'tabs-dark')
    await openEditor(page, b)
    assert.equal(await page.locator('dialog.emb-dlg .emb-li.sel .emb-nm').innerText(), 'Meu')
    await page.click('dialog.emb-dlg [data-a="del"]')
    assert.match(await page.locator('dialog.emb-dlg .emb-ft .emb-msg').innerText(), /Está em 1 guia, que ficam sem emblema/)
    await page.click('dialog.emb-dlg [data-a="confirm"]')
    await page.waitForSelector(chip(b), { state: 'detached' })
    assert.equal(await page.locator('dialog.emb-dlg .emb-li', { hasText: 'Meu' }).count(), 0, 'gone from the library')
    // Hide Bug, recolour Pessoal.
    await page.click('dialog.emb-dlg .emb-li[data-sel="b-bug"]')
    await page.click('dialog.emb-dlg [data-a="del"]')
    await page.click('dialog.emb-dlg [data-a="confirm"]')
    await page.waitForSelector('dialog.emb-dlg .emb-li.hid[data-sel="b-bug"]')
    await page.click('dialog.emb-dlg .emb-li[data-sel="b-pessoal"]')
    await page.click('dialog.emb-dlg .emb-s[data-c="orange"]')
    await page.click('dialog.emb-dlg [data-a="done"]')
    await waitSaved(home, l => {
      const e = l.emblems as { id: string; color?: string; hidden?: boolean }[] | undefined
      return !!e && !e.some(x => x.id.startsWith('u-')) && e.find(x => x.id === 'b-bug')?.hidden === true && e.find(x => x.id === 'b-pessoal')?.color === 'orange' && savedParams(l, b)?.emblem === undefined
    }, 'library saved (Meu deleted, Bug hidden, Pessoal orange) and b without emblem')
    await clickMenu(app, 'theme-light')
    await page.waitForFunction(() => document.querySelector('html')?.dataset.theme === 'light')
    await shot(page, 'tabs-light')
    await clickMenu(app, 'theme-dark')

    // ---- 5. relaunch ----
    console.log('step 5')
    await sleep(800)
    await killElectron(app, root)
    app = undefined
    ;({ app, page } = await launch(home))
    await page.waitForSelector(chip(a))
    assert.equal(await chipIcon(page, a), '#emb-briefcase')
    await page.waitForSelector(chip(empty))
    assert.equal(await page.locator(chip(b)).count(), 0)
    await openPopover(page, a)
    const after = (await page.locator('#ctx-menu.emb-menu li[role=menuitemradio]').allInnerTexts()).map(s => s.trim())
    assert.deepEqual(after, ['Cliente', 'Pessoal', 'Estudo', 'Revisar', 'Deploy', 'Nenhum'], 'Bug stays hidden, Meu stays deleted')
    assert.match((await page.locator('#ctx-menu.emb-menu li', { hasText: 'Pessoal' }).locator('.emb-chip').getAttribute('style'))!, /--x-orange\)/)
    await page.keyboard.press('Escape')
    await page.locator('#ctx-menu').waitFor({ state: 'detached' })

    // ---- 6. close the tab (detach) and reopen its slot: no emblem ----
    console.log('step 6')
    await page.evaluate(id => window.__tether.closePanel(id), a)
    const dlg = page.locator('dialog.ask[data-dialog="close-panel-live"][open]')
    await dlg.waitFor()
    await dlg.locator('button.choice[data-choice="detach"]').click()
    await page.waitForFunction(id => !window.__tether.panelIds().includes(id), a)
    await page.evaluate(id => window.__tether.openSlot(id), a)
    await page.waitForSelector(tab(a))
    await sleep(300)
    assert.equal(await page.locator(chip(a)).count(), 0, 'reopened without an emblem')
    await waitSaved(home, l => !!savedParams(l, a) && savedParams(l, a)!.emblem === undefined, `${a} reopened without params.emblem`)
  } finally {
    console.log('teardown')
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    for (let i = 0; i < 20 && daemons.some(d => pidAlive(d.pid)); i++) await sleep(500)
    for (const dir of [home, work]) for (let i = 0; i < 5; i++) {
      try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
