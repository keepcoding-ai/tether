// E2E of the channel as a link: a tetherd in this process on a private home and pipe, the real app on the same pipe, hidden window,
// one PowerShell pane. Nothing touches the person's tether, no LLM.
//   1. `#name` of an existing channel printed in a terminal is a link: Ctrl+click opens the channel's pane; `#nada` and `#fff` are not
//      links (no menu, no pane); a closed channel opens too (to be read);
//   2. right click on it: "Abrir canal [Ctrl+clique]" and "Copiar link"; the copied text is tether://channel/<id>;
//   3. in a note: the address tether://channel/<id> and `#name` are links (Ctrl+click opens; the right click has the channel rows);
//   4. the channel's tab menu has "Copiar link do canal".
// Run alone: node --test test/e2e/app.link-channel.test.ts   (one E2E at a time: the build is remade)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import '../../src/agents/load.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import { fsIo } from '../../src/daemon/ext-io.ts'
import { startDaemon } from '../../src/daemon/server.ts'
import { createChannels, type Channels, type ChannelsApi } from '../../extensions/channels/daemon/fanout.ts'
import { registerChannelRequests } from '../../extensions/channels/daemon/requests.ts'
import { openStore } from '../../extensions/channels/daemon/store.ts'
import { USER } from '../../extensions/channels/rules.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  panelIds(): string[]
  activate(id: string): void
  activeId(): string | undefined
  text(slotId: string): string
  screenPos(id: string, needle: string): { row: number; col: number } | undefined
  cellSize(id: string): { width: number; height: number } | undefined
  openNote(path: string): Promise<void>
  notes(): { id: string; text: string }[]
}
declare const window: { __tether: Hooks }
declare const document: any

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const SHOTS = process.env.LINK_CHANNEL_SHOTS_DIR ?? 'C:/atrium/.tmp/tether-agents/onda-3/espiar/canal-link'
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function launch(home: string, pipe: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  delete env.NODE_TEST_CONTEXT
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
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

/** The pointer over the text, long enough for the link provider to answer. */
async function over(page: Page, p: { x: number; y: number }): Promise<void> {
  await page.mouse.move(5, 5)
  await page.mouse.move(p.x, p.y, { steps: 3 })
  await sleep(300)
  await page.mouse.move(p.x + 10, p.y); await sleep(100); await page.mouse.move(p.x, p.y)
  await sleep(400)
}

async function ctrlClick(page: Page): Promise<void> {
  await page.keyboard.down('Control')
  await page.mouse.down(); await page.mouse.up()
  await page.keyboard.up('Control')
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
const menuOpen = (page: Page): Promise<boolean> => page.evaluate(() => document.getElementById('ctx-menu') !== null)

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

/** Rows of Monaco's menu (it lives in a shadow root). */
const monacoRows = (page: Page): Promise<string[]> => page.evaluate(() => {
  for (const host of Array.from(document.querySelectorAll('.shadow-root-host')) as any[]) {
    const menu = host.shadowRoot?.querySelector('.monaco-menu')
    if (!menu) continue
    const out: string[] = []
    for (const li of Array.from(menu.querySelectorAll('li.action-item')) as any[]) {
      const label = li.querySelector('.action-label')
      if (!label || label.classList.contains('separator')) { out.push('-'); continue }
      const hint = li.querySelector('.keybinding')?.textContent
      out.push(hint ? `${label.textContent} [${hint}]` : String(label.textContent))
    }
    return out
  }
  return []
})

/** The centre of `needle` inside the rendered line of the note that holds it. */
async function notePoint(page: Page, noteId: string, needle: string): Promise<{ x: number; y: number }> {
  const p = await page.evaluate(([id, n]) => {
    for (const line of Array.from(document.querySelectorAll(`.note-panel[data-note-id="${id}"] .view-line`)) as any[]) {
      const text = String(line.textContent).replace(/\u00a0/g, ' ')
      const at = text.indexOf(n)
      if (at < 0) continue
      const walker = document.createTreeWalker(line, 4)
      let offset = 0
      for (let node = walker.nextNode() as any; node; node = walker.nextNode()) {
        const len = node.textContent.length
        const mid = at + Math.floor(n.length / 2)
        if (mid < offset + len) {
          const r = document.createRange()
          r.setStart(node, mid - offset); r.setEnd(node, mid - offset + 1)
          const b = r.getBoundingClientRect()
          return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
        }
        offset += len
      }
    }
    return undefined
  }, [noteId, needle] as [string, string])
  assert.ok(p, `${needle} is rendered in the note`)
  return p
}

test('canal como link: #nome de canal existente no terminal e na nota, tether://channel/<id>, menu de link', { timeout: 420_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(SHOTS, { recursive: true })
  const home = tempHome()
  const pipe = uniquePipe(home)
  const logs: string[] = []
  const door = new DoorHost({ log: m => logs.push(m) })
  const own = new DisposableStore()
  const daemon = await startDaemon({ home, pipe, memoryIntervalMs: 0, readyFallbackMs: 300, minAgentAgeMs: 0, channelOf: () => undefined, door, log: m => logs.push(m) })
  const doorApi = door.apiFor('channels', own)
  const api: ChannelsApi = { slots: doorApi.slots, attention: doorApi.attention, delivery: doorApi.delivery, events: doorApi.events, settings: { get: () => undefined }, log: m => logs.push(m) }
  const ch: Channels = createChannels(api, await openStore(fsIo, home))
  for (const d of registerChannelRequests(doorApi, Promise.resolve(ch))) own.add(d)

  let app: ElectronApplication | undefined
  let savedClip: string | undefined
  try {
    const obra = await ch.create(USER, { name: 'obra' })
    const velho = await ch.create(USER, { name: 'velho' })
    const outra = await ch.create(USER, { name: 'outra' })
    const conf = await ch.create(USER, { name: 'conferencia' })
    assert.ok(obra.ok && velho.ok && outra.ok && conf.ok)
    assert.ok((await ch.close(USER, velho.channel.id)).ok)
    const host = (await doorApi.slots.create({ kind: 'shell', cwd: home, name: 'prompt', desk: 'desk-1' })).slotId

    let page: Page
    ;({ app, page } = await launch(home, pipe))
    await page.waitForFunction(() => typeof (window.__tether as any).ext?.channels?.run === 'function')
    await page.waitForFunction(p => window.__tether.panelIds().includes(p), host)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
    savedClip = await app.evaluate(({ clipboard }) => clipboard.readText())
    const clip = (): Promise<string> => app!.evaluate(({ clipboard }) => clipboard.readText())
    const pane = (id: string) => page.locator(`.ch-pane[data-channel="${id}"]`)
    await page.waitForFunction(id => /PS .*>/.test(window.__tether.text(id)), host, { timeout: 30_000 })
    const focusHost = async (): Promise<void> => {
      await page.evaluate(id => window.__tether.activate(id), host)
      await page.locator(`.panel[data-slot-id="${host}"] .panel-term`).click()
      await page.waitForFunction(id => window.__tether.activeId() === id, host)
    }
    await focusHost()

    // ---- 1. in the terminal ----
    console.log('step 1')
    const ref = await print(page, host, '#ob', 'ra')
    const old = await print(page, host, '#ve', 'lho')
    const none = await print(page, host, '#na', 'da')
    const color = await print(page, host, '#ff', 'f')
    await sleep(800) // the extension's list has been read

    for (const text of [none, color]) {
      const p = await pointOf(page, host, text, 1)
      await over(page, p)
      await page.mouse.click(p.x, p.y, { button: 'right' })
      await sleep(400)
      assert.equal(await menuOpen(page), false, `${text} is not a link: no menu`)
      await ctrlClick(page)
      await sleep(400)
      assert.equal(await page.locator('.ch-pane').count(), 0, `${text} opens nothing`)
    }

    const rows = await rightClick(page, await pointOf(page, host, ref, 1))
    assert.deepEqual(rows, ['Abrir canal [Ctrl+clique]', '-', 'Copiar link'])
    await page.screenshot({ path: join(SHOTS, 'canal-menu-terminal.png') })
    await page.locator('#ctx-menu li', { hasText: 'Copiar link' }).first().click()
    for (let i = 0; i < 30 && (await clip()) !== `tether://channel/${obra.channel.id}`; i++) await sleep(100)
    assert.equal(await clip(), `tether://channel/${obra.channel.id}`)

    await over(page, await pointOf(page, host, ref, 1))
    await ctrlClick(page)
    await pane(obra.channel.id).waitFor({ state: 'visible' })
    await page.screenshot({ path: join(SHOTS, 'canal-aberto-do-terminal.png') })

    await focusHost()
    await over(page, await pointOf(page, host, old, 1))
    await ctrlClick(page)
    await pane(velho.channel.id).waitFor({ state: 'visible' })

    // ---- 4. the channel's tab menu ----
    console.log('step 4')
    await page.locator('.ch-tab', { hasText: '#velho' }).first().click({ button: 'right' })
    await page.waitForSelector('#ctx-menu')
    const tabRows = await menuRows(page)
    assert.ok(tabRows.includes('Copiar link do canal'), `tab menu: ${tabRows.join(' | ')}`)
    await page.locator('#ctx-menu li', { hasText: 'Copiar link do canal' }).first().click()
    for (let i = 0; i < 30 && (await clip()) !== `tether://channel/${velho.channel.id}`; i++) await sleep(100)
    assert.equal(await clip(), `tether://channel/${velho.channel.id}`)

    // ---- 3. in a note ----
    console.log('step 3')
    const mdPath = join(home, 'canais.md')
    writeFileSync(mdPath, `Texto simples sem ligacao\n\nendereco tether://channel/${outra.channel.id} fim\n\ncitado #conferencia aqui e #inexistente la\n`)
    await page.evaluate(path => window.__tether.openNote(path), mdPath)
    await page.waitForFunction(() => window.__tether.notes().length === 1 && window.__tether.notes()[0]!.text.length > 0)
    const noteId = (await page.evaluate(() => window.__tether.notes()))[0]!.id
    await page.locator(`.note-panel[data-note-id="${noteId}"] .monaco-editor`).click()
    await sleep(1500)

    // the right click on `#conferencia`: the channel's rows on top of the editor's own
    const p1 = await notePoint(page, noteId, '#conferencia')
    await page.mouse.move(5, 5); await page.mouse.move(p1.x, p1.y, { steps: 3 }); await sleep(300)
    await page.mouse.click(p1.x, p1.y, { button: 'right' })
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.shadow-root-host') as any[]).some(h => h.shadowRoot?.querySelector('.monaco-menu')))
    await sleep(200)
    assert.deepEqual((await monacoRows(page)).slice(0, 3), ['Abrir canal [Ctrl+clique]', '-', 'Copiar link'])
    await page.screenshot({ path: join(SHOTS, 'canal-menu-nota.png') })
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !Array.from(document.querySelectorAll('.shadow-root-host') as any[]).some(h => h.shadowRoot?.querySelector('.monaco-menu')))

    // Ctrl+click on the address opens the channel (by id), on `#conferencia` too
    const follow = async (needle: string): Promise<void> => {
      const p = await notePoint(page, noteId, needle)
      await page.keyboard.down('Control')
      await page.mouse.move(p.x, p.y, { steps: 3 })
      await sleep(300)
      await page.mouse.down(); await page.mouse.up()
      await page.keyboard.up('Control')
    }
    await follow(`channel/${outra.channel.id.slice(0, 6)}`)
    await pane(outra.channel.id).waitFor({ state: 'visible' })
    await page.evaluate(id => window.__tether.activate(id), noteId)
    await page.locator(`.note-panel[data-note-id="${noteId}"] .monaco-editor`).click()
    await sleep(800)
    await follow('#conferencia')
    await pane(conf.channel.id).waitFor({ state: 'visible' })
    await page.screenshot({ path: join(SHOTS, 'canal-aberto-da-nota.png') })
  } finally {
    if (app) {
      if (savedClip !== undefined) await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), savedClip).catch(() => {})
      await killElectron(app, root).catch(() => {})
    }
    ch.dispose()
    await door.delivery.flush().catch(() => {})
    own.dispose()
    door.delivery.dispose()
    await daemon.close()
    await door.mcp.close()
    await removeHome(home)
  }
})
