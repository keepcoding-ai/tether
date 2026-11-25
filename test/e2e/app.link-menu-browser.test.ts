// E2E of "Abrir no navegador do tether" and "Abrir ao lado" in the right-click menu of an http link (link-menu-rules.ts, browser
// extension provideBrowser), against the real app (built with TETHER_TEST_EXTENSIONS=1) and the real tetherd on a private
// home/pipe (hidden window). A page this test serves at http://localhost:<port> is printed in a terminal:
//   1. the menu reads system browser, the two tether rows, copy;
//   2. "Abrir no navegador do tether" opens the address in a tab of the person's (owner `person`, pill "Você") in the Browser
//      desk, with no local-network question;
//   3. "Abrir ao lado" opens another tab of hers in the desk of the terminal the link was clicked in, not in the Browser desk;
//   4. with the browser extension off the two rows are gone;
//   5. capture: menu.png (the menu with the two rows).
// Every kill goes through test/kill.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { daemonMain, inBrowser, launchHidden, pidAlive, root, sleep } from './browser-kit.ts'

type Pane = { id: string; tabId?: string; owner?: string; url: string; controlText: string; own: boolean; place?: string; front: boolean }
declare const window: {
  __tether: {
    connection(): { connected: boolean; pid?: number } | undefined
    panelIds(): string[]
    activate(id: string): void
    activeId(): string | undefined
    text(slotId: string): string
    screenPos(id: string, needle: string): { row: number; col: number } | undefined
    cellSize(id: string): { width: number; height: number } | undefined
    browserPanes(): Pane[]
  }
}
declare const document: any
type Tabs = { registry: { list(): { tabId: string; ownerSlotId: string; url: string }[] } }

const shots = process.env.N2_SHOTS_DIR ?? 'C:/atrium/.tmp/tether-agents/onda-3/navegador-pessoa/n2'
const PLAIN = 'Abrir no navegador do sistema [Ctrl+clique]'
const TETHER_ROWS = ['Abrir no navegador do tether', 'Abrir ao lado']

function servePage(): Promise<{ server: Server; base: string; hits: Record<string, number> }> {
  const hits: Record<string, number> = {}
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    hits[path] = (hits[path] ?? 0) + 1
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><title>Pagina ${path}</title><link rel="icon" href="data:,"><h1 style="padding:24px">PAGE ${path}</h1>`)
  })
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, hits, base: `http://localhost:${(server.address() as AddressInfo).port}` })))
}

async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms
  let last: unknown
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v as T } catch (e) { last = e }
    await sleep(150)
  }
  throw new Error(`timed out: ${what}${last ? ` (${(last as Error).message})` : ''}`)
}

async function createShell(page: Page, cwd: string): Promise<string> {
  const before = await page.evaluate(() => window.__tether.panelIds())
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  await page.click('#dlg-new .ch-item[data-id="powershell"]')
  await page.click('#dlg-new .btn.primary.go')
  await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
  await page.waitForFunction(n => window.__tether.panelIds().length === n, before.length + 1)
  const id = (await page.evaluate(() => window.__tether.panelIds())).find(x => !before.includes(x))!
  await page.waitForFunction(id => /PS .*>/.test(window.__tether.text(id)), id, { timeout: 30_000 })
  return id
}

async function focusPane(page: Page, id: string): Promise<void> {
  await page.evaluate(id => window.__tether.activate(id), id)
  await page.locator(`.panel[data-slot-id="${id}"] .panel-term`).waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator(`.panel[data-slot-id="${id}"] .panel-term`).click()
  await page.waitForFunction(id => window.__tether.activeId() === id, id)
}

/** Prints `parts` joined (the typed command never holds the printed text) and waits for it on the screen. */
async function print(page: Page, id: string, ...parts: string[]): Promise<string> {
  const printed = parts.join('')
  await page.keyboard.type(`Write-Output (${parts.map(p => `'${p}'`).join('+')})`)
  await page.keyboard.press('Enter')
  await page.waitForFunction(([id, needle]) => window.__tether.screenPos(id!, needle!) !== undefined, [id, printed] as [string, string])
  return printed
}

async function pointOf(page: Page, id: string, needle: string, offset = 2): Promise<{ x: number; y: number }> {
  const pos = await page.evaluate(([id, n]) => window.__tether.screenPos(id!, n!), [id, needle])
  assert.ok(pos, `${needle} is on screen`)
  const cell = (await page.evaluate(id => window.__tether.cellSize(id), id))!
  const box = (await page.locator(`.panel[data-slot-id="${id}"] .xterm-screen`).boundingBox())!
  return { x: box.x + (pos.col + offset + 0.5) * cell.width, y: box.y + (pos.row + 0.5) * cell.height }
}

async function over(page: Page, p: { x: number; y: number }): Promise<void> {
  await page.mouse.move(5, 5)
  await page.mouse.move(p.x, p.y, { steps: 3 })
  await sleep(300)
  await page.mouse.move(p.x + 10, p.y); await sleep(100); await page.mouse.move(p.x, p.y)
  await sleep(400)
}

const menuRows = (page: Page): Promise<string[]> => page.evaluate(() => {
  const out: string[] = []
  for (const li of document.querySelectorAll('#ctx-menu > li') as any[]) {
    if (li.classList.contains('sep')) { out.push('-'); continue }
    const label = [...li.childNodes].filter((n: any) => n.nodeType === 3).map((n: any) => n.textContent).join('')
    const hint = li.querySelector('kbd')?.textContent
    out.push(hint ? `${label} [${hint}]` : label)
  }
  return out
})
async function rightClick(page: Page, p: { x: number; y: number }): Promise<string[]> {
  await over(page, p)
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await page.waitForSelector('#ctx-menu')
  return menuRows(page)
}
async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.getElementById('ctx-menu') === null)
  await page.mouse.move(5, 5)
}

test('menu de link http: duas linhas do navegador do tether, abrem guia da pessoa na mesa Browser e ao lado; extensao desligada, somem', { timeout: 400_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shots, { recursive: true })
  mkdirSync(tmpdir(), { recursive: true })
  const pages = await servePage()
  const daemons: Owned[] = []
  const dirs: string[] = []
  let app: ElectronApplication | undefined
  try {
    // ---- the extension on ----
    const home = mkdtempSync(join(tmpdir(), 'tether-lmbrowser-'))
    const base = mkdtempSync(join(tmpdir(), 'tether-lmb-files-'))
    dirs.push(home, base)
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { browser: { localNetwork: 'ask' } } }))
    let win: Page
    ;({ app, page: win } = await launchHidden(home, `\\\\.\\pipe\\tether-lmbrowser-${process.pid}`))
    daemons.push(await claim((await win.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const T = app
    const tabs = (): Promise<{ tabId: string; ownerSlotId: string; url: string }[]> => inBrowser(T, () => (globalThis as unknown as { __browserTabs: Tabs }).__browserTabs.registry.list())
    const panes = (): Promise<Pane[]> => win.evaluate(() => window.__tether.browserPanes())
    const dialogs = (): Promise<string[]> => win.evaluate(() => [...document.querySelectorAll('dialog[open]')].map(d => (d as HTMLElement).dataset.dialog ?? '?'))

    const host = await createShell(win, base)
    await focusPane(win, host)
    const url = await print(win, host, 'http://local', `host:${pages.base.split(':').pop()}/n2/primeira`)

    console.log('step 1: the menu')
    const rows = await rightClick(win, await pointOf(win, host, url))
    assert.deepEqual(rows, [PLAIN, ...TETHER_ROWS, '-', 'Copiar link'])
    await sleep(300)
    await win.screenshot({ path: join(shots, 'menu.png') })

    console.log('step 2: in the Browser desk')
    await win.locator('#ctx-menu li', { hasText: 'navegador do tether' }).first().click()
    const first = await until('her first tab', async () => (await tabs()).find(t => t.ownerSlotId === 'person' && t.url.includes('/n2/primeira')))
    const firstPane = await until('her first pane', async () => (await panes()).find(p => p.tabId === first.tabId))
    assert.equal(firstPane.owner, 'person')
    assert.equal(firstPane.controlText, 'Você')
    assert.equal(firstPane.place, 'Browser')
    assert.equal(firstPane.front, true, 'brought to the front')
    assert.deepEqual(await dialogs(), [], 'a local address from her gesture opens with no question')
    await until('the page was served', async () => pages.hits['/n2/primeira'] === 1)

    console.log('step 3: beside')
    await win.click('#desk-switch .seg.sys[data-system="browser.desk"]') // the Browser desk is in front: back to the terminal's
    await focusPane(win, host)
    const url2 = await print(win, host, 'http://local', `host:${pages.base.split(':').pop()}/n2/segunda`)
    assert.deepEqual((await rightClick(win, await pointOf(win, host, url2)))[2], 'Abrir ao lado')
    await win.locator('#ctx-menu li', { hasText: /^Abrir ao lado/ }).first().click()
    const second = await until('her second tab', async () => (await tabs()).find(t => t.ownerSlotId === 'person' && t.url.includes('/n2/segunda')))
    const secondPane = await until('her second pane', async () => (await panes()).find(p => p.tabId === second.tabId))
    assert.equal(secondPane.owner, 'person')
    assert.notEqual(secondPane.place, 'Browser', 'it is in the terminal\'s desk, not in the Browser desk')
    assert.equal((await panes()).filter(p => p.place === 'Browser').length, 1, 'the Browser desk keeps only the first tab')
    await until('the second page was served', async () => pages.hits['/n2/segunda'] === 1)
    await win.screenshot({ path: join(shots, 'beside.png') })

    // ---- the extension off ----
    console.log('step 4: extension off')
    await killElectron(app, root).catch(e => console.error(String(e)))
    app = undefined
    const home2 = mkdtempSync(join(tmpdir(), 'tether-lmbrowser-'))
    dirs.push(home2)
    writeFileSync(join(home2, 'settings.json'), JSON.stringify({ extensions: { disabled: ['browser'] } }))
    ;({ app, page: win } = await launchHidden(home2, `\\\\.\\pipe\\tether-lmbrowser2-${process.pid}`))
    daemons.push(await claim((await win.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const host2 = await createShell(win, base)
    await focusPane(win, host2)
    const url3 = await print(win, host2, 'http://local', `host:${pages.base.split(':').pop()}/n2/terceira`)
    assert.deepEqual(await rightClick(win, await pointOf(win, host2, url3)), [PLAIN, '-', 'Copiar link'])
    await closeMenu(win)
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) {
      const r = await killOwned(d, { tree: true })
      if (r === 'not-ours') console.error(`tetherd cleanup: pid ${d.pid} is no longer ours; not killed`)
    }
    pages.server.close()
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (const dir of dirs) for (let i = 0; i < 5; i++) {
      try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
