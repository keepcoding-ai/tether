// E2E of F6, the desk and focus signals: three independent, combinable modes (settings ui.deskLine, ui.tabBorder,
// ui.dimUnfocused), against the real tetherd on a private home/pipe, hidden window, shells only:
//   1. defaults: line on, folder border off, dim off;
//   2. the folder border (computed styles): the focused frame's active tab has top/left/right edges in the desk colour, the
//      tab strip draws its bottom edge, the content draws left/right/bottom; the unfocused frame and the tab strip's
//      action buttons have none; it follows the focus and a desk recolour; in the drawer it is not the desk colour;
//   3. the dim: an unfocused frame gets the veil, the focused one does not, the toolbar is untouched;
//   4. each toggle through the ≡ menu and the palette command, saved in settings.json;
//   4b. the dim has three levels (fraco .20, médio .32 default, forte .45) picked from the ≡ menu and the palette, the veil
//      colour stays the desk background, the level is saved in settings.json; screenshots in <repo>/../../.tmp/dim3 (6 files);
//   5. screenshots (<repo>/../../.tmp/f6): each mode alone and the three together, light and dark (8 files).
// Every kill goes through test/kill.ts (pid + creation time).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  panelIds(): string[]
  frameIds(): string[]
  activate(id: string): void
  activeId(): string | undefined
  desks(): { id: string; name: string; color: string }[]
  recolorDesk(id: string, color: string): void
  renameDesk(id: string, name: string): void
  deskLine(): boolean
  signals(): { tabBorder: boolean; dimUnfocused: boolean; dimLevel: string }
  connection(): { connected: boolean; pid?: number } | undefined
  drawer(): { open: boolean; panes: string[] }
}
declare const window: { __tether: Hooks; getComputedStyle(el: unknown, pseudo?: string): { boxShadow: string; opacity: string; backgroundColor: string; backgroundImage: string; content: string; borderTopWidth: string; borderLeftWidth: string; borderRightWidth: string; borderBottomWidth: string; borderTopColor: string; borderLeftColor: string; borderBottomColor: string } }
declare const document: { querySelector(s: string): unknown; querySelectorAll(s: string): ArrayLike<unknown> & { length: number } }
type Q = { querySelector(s: string): unknown }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const shots = resolve(root, '..', '..', '.tmp', 'f6')
const shots3 = resolve(root, '..', '..', '.tmp', 'dim3')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-signals-${process.pid}`
const daemonMain = join(root, 'src', 'daemon', 'main.ts')

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !/^(CLAUDE|TETHER_|ATRIUM_)/i.test(k)) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
  return { app, page }
}

async function createShell(page: Page, cwd: string): Promise<void> {
  const before = await page.locator('.tether-tab').count()
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  await page.click('#dlg-new .ch-item[data-id="powershell"]')
  await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
  await page.waitForFunction(n => document.querySelectorAll('.tether-tab').length === n, before + 1)
}

/** Focuses a frame of the visible desk by clicking the terminal of its visible pane. */
async function focusFrame(page: Page, index: number): Promise<void> {
  await page.locator('.desk-layer:not(.inactive) .frame:has(> .frame-dock)').nth(index).locator('.panel-term:visible').first().click()
  await sleep(150)
}

async function setTheme(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  await page.click('#btn-theme')
  await page.waitForSelector('#theme-menu:not([hidden])')
  await page.click(`#theme-menu li[data-theme="${scheme}"]`)
  await page.waitForFunction(s => (document.querySelector('html') as { dataset: Record<string, string> }).dataset.theme === s, scheme)
  await sleep(300)
}

type Command = 'ui.desk-line' | 'ui.tab-border' | 'ui.dim-unfocused'

/** Toggles a setting through its command (the ≡ menu no longer carries them) and waits for the renderer to apply it. */
async function toggle(page: Page, command: Command, want: boolean): Promise<void> {
  await page.evaluate(c => (globalThis as unknown as { __tether: { runCommand(id: string): Promise<unknown> } }).__tether.runCommand(c), command)
  await page.waitForFunction(([c, w]) => {
    const s = window.__tether.signals()
    return (c === 'ui.desk-line' ? window.__tether.deskLine() : c === 'ui.tab-border' ? s.tabBorder : s.dimUnfocused) === w
  }, [command, want] as const)
  await page.mouse.move(640, 400)
  await sleep(350) // the dim veil fades over --motion-fast
}

async function setModes(page: Page, modes: { line: boolean; border: boolean; dim: boolean }): Promise<void> {
  if ((await page.evaluate(() => window.__tether.deskLine())) !== modes.line) await toggle(page, 'ui.desk-line', modes.line)
  const s = await page.evaluate(() => window.__tether.signals())
  if (s.tabBorder !== modes.border) await toggle(page, 'ui.tab-border', modes.border)
  if (s.dimUnfocused !== modes.dim) await toggle(page, 'ui.dim-unfocused', modes.dim)
}

async function shot(app: ElectronApplication, name: string): Promise<string> {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString('base64'))
  const file = join(shots, `${name}.png`)
  writeFileSync(file, Buffer.from(b64, 'base64'))
  return file
}

/** What the signals paint on one frame of the visible desk, from computed styles. */
function frameBorder(page: Page, frameIndex: number) {
  return page.evaluate(i => {
    const frame = document.querySelectorAll('.desk-layer:not(.inactive) .frame:has(> .frame-dock)')[i] as Q & { classList: { contains(c: string): boolean } }
    const g = (el: unknown, pseudo?: string) => el ? window.getComputedStyle(el, pseudo) : undefined
    // A solid border (the folder's pieces are borders, never shadows): its colour and which sides it has, or 'none'.
    const border = (el: unknown, pseudo: string) => {
      const s = g(el, pseudo)
      if (!s) return 'none'
      const sides = ([['t', s.borderTopWidth], ['l', s.borderLeftWidth], ['r', s.borderRightWidth], ['b', s.borderBottomWidth]] as const).filter(([, w]) => parseFloat(w) > 0)
      if (!sides.length) return 'none'
      const colour = parseFloat(s.borderLeftWidth) > 0 ? s.borderLeftColor : s.borderTopWidth !== '0px' ? s.borderTopColor : s.borderBottomColor
      return `${colour} ${sides.map(([k, w]) => `${k}:${w}`).join(' ')}`
    }
    const group = frame.querySelector('.dv-groupview.dv-active-group') as Q
    return {
      focused: frame.classList.contains('focused'),
      strip: g(group.querySelector(':scope > .dv-tabs-and-actions-container'))?.backgroundImage ?? '',
      tab: border(group.querySelector('.dv-tab.dv-active-tab'), '::before'),
      otherTab: border(group.querySelector('.dv-tab.dv-inactive-tab'), '::before'),
      actions: g(group.querySelector('.tab-actions'))?.boxShadow ?? 'none',
      content: border(group.querySelector(':scope > .dv-content-container'), '::after'),
      veil: g(frame, '::after')?.opacity ?? '',
    }
  }, frameIndex)
}

test('app signals: line, folder border and dim are independent and combinable (F6)', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shots, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-signals-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // Two tabs in the first frame, then a second frame on its right; a coloured desk.
    await createShell(page, root)
    await createShell(page, root)
        await page.locator('.panel-term:visible').first().click()
    await page.keyboard.press('Alt+Shift+ArrowRight')
    await page.waitForFunction(() => window.__tether.frameIds().length === 2)
    await page.waitForFunction(() => document.querySelectorAll('.tether-tab').length === 3)
    await page.evaluate(() => { const id = window.__tether.desks()[0]!.id; window.__tether.renameDesk(id, 'Cliente A'); window.__tether.recolorDesk(id, 'purple') })
    await sleep(500)
    // Frames by tab count: the new frame holds one tab, the first holds two. Each is focused through its visible pane.
    const frameInfo = await page.evaluate(() => Array.from(document.querySelectorAll('.desk-layer:not(.inactive) .frame:has(> .frame-dock)')).map(f => ({
      tabs: (f as unknown as { querySelectorAll(s: string): { length: number } }).querySelectorAll('.dv-tab').length,
    })))
    assert.equal(frameInfo.length, 2, 'two frames')
    const fLone = frameInfo.findIndex(f => f.tabs === 1), fCrowd = frameInfo.findIndex(f => f.tabs === 2)
    assert.notEqual(fLone, fCrowd, 'two frames')

    // 1. Defaults.
    assert.equal(await page.evaluate(() => window.__tether.deskLine()), true, 'the line is on by default')
    assert.deepEqual(await page.evaluate(() => window.__tether.signals()), { tabBorder: false, dimUnfocused: false, dimLevel: 'medium' })
    const fill = await page.locator('#desk-switch .seg.on').evaluate(el => window.getComputedStyle(el).backgroundColor)
    const plain = await frameBorder(page, fCrowd)
    for (const k of ['strip', 'tab', 'content'] as const) assert.equal(plain[k], 'none', `no folder border by default (${k})`)
    assert.equal(plain.veil, '0', 'no veil by default')

    // 2. Folder border.
    await setModes(page, { line: true, border: true, dim: false })
    await focusFrame(page, fLone)
    const on = await frameBorder(page, fLone)
    assert.equal(on.focused, true, 'the focused frame is marked')
    assert.ok(on.tab.includes(fill), `active tab outlined in the desk colour: ${on.tab}`)
    assert.ok(/ t:\S+ l:\S+ r:\S+$/.test(on.tab), `tab: top, left and right only: ${on.tab}`)
    assert.ok(on.strip.includes(fill), `the strip draws the folder's bottom edge: ${on.strip}`)
    assert.ok(on.content.includes(fill) && / l:\S+ r:\S+ b:\S+$/.test(on.content), `content: left, right and bottom: ${on.content}`)
    assert.equal(on.actions, 'none', 'the action buttons stay outside the outline')
    assert.equal(on.otherTab, 'none', 'other tabs stay outside')
    const off = await frameBorder(page, fCrowd)
    assert.equal(off.focused, false)
    for (const k of ['strip', 'tab', 'content'] as const) assert.equal(off[k], 'none', `unfocused frame has no outline (${k})`)
    // It follows the focus...
    await focusFrame(page, fCrowd)
    assert.equal((await frameBorder(page, fCrowd)).focused, true)
    assert.ok((await frameBorder(page, fCrowd)).tab.includes(fill))
    assert.equal((await frameBorder(page, fLone)).tab, 'none', 'the outline left the other frame')
    // ... and the desk colour.
    await page.evaluate(() => window.__tether.recolorDesk(window.__tether.desks()[0]!.id, 'orange'))
    await sleep(300)
    const fill2 = await page.locator('#desk-switch .seg.on').evaluate(el => window.getComputedStyle(el).backgroundColor)
    assert.notEqual(fill2, fill)
    assert.ok((await frameBorder(page, fCrowd)).tab.includes(fill2), 'the outline takes the new desk colour')
    await page.evaluate(() => window.__tether.recolorDesk(window.__tether.desks()[0]!.id, 'purple'))
    await sleep(300)
    await setModes(page, { line: true, border: false, dim: false })
    assert.equal((await frameBorder(page, fCrowd)).tab, 'none', 'off again: nothing left')

    // 3. Dim.
    await setModes(page, { line: true, border: false, dim: true })
    const veilOther = await frameBorder(page, fLone)
    const veilFocused = await frameBorder(page, fCrowd)
    assert.ok(Number(veilOther.veil) > 0.1 && Number(veilOther.veil) < 0.4, `the unfocused frame is veiled: ${veilOther.veil}`)
    assert.equal(veilFocused.veil, '0', 'the focused frame is not')
    assert.equal(await page.locator('#toolbar').evaluate(el => window.getComputedStyle(el).opacity), '1', 'the toolbar is not dimmed')
    await setModes(page, { line: true, border: false, dim: false })
    assert.equal((await frameBorder(page, fLone)).veil, '0')
    // The line is independent of the other two.
    await setModes(page, { line: false, border: true, dim: false })
    assert.equal(await page.locator('#dock').evaluate(el => window.getComputedStyle(el, '::before').content), 'none')
    assert.ok((await frameBorder(page, fCrowd)).tab.includes(fill), 'border works with the line off')
    await setModes(page, { line: true, border: false, dim: false })

    // 4. Palette commands and persistence.
    for (const [query, key] of [['borda na guia', 'tabBorder'], ['esmaecer', 'dimUnfocused']] as const) {
      await page.keyboard.press('Control+Shift+P')
      await page.waitForFunction(() => (window.__tether as unknown as { palette(): { open: boolean } }).palette().open)
      await page.keyboard.type(query)
      await sleep(300)
      await page.keyboard.press('Enter')
      await page.waitForFunction(k => window.__tether.signals()[k as 'tabBorder'], key)
    }
    await sleep(500)
    const ui = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).ui
    assert.equal(ui.tabBorder, true, 'settings.json ui.tabBorder')
    assert.equal(ui.dimUnfocused, true, 'settings.json ui.dimUnfocused')
    await setModes(page, { line: true, border: false, dim: false })

    // 4b. Three dim levels.
    const level = async (cmd: 'ui.dim-weak' | 'ui.dim-medium' | 'ui.dim-strong', want: string): Promise<void> => {
      await page.evaluate(c => (globalThis as unknown as { __tether: { runCommand(id: string): Promise<unknown> } }).__tether.runCommand(c), cmd)
      await page.waitForFunction(w => window.__tether.signals().dimLevel === w, want)
      await page.mouse.move(640, 400)
      await sleep(350)
    }
    const veilOf = async (): Promise<{ opacity: number; color: string }> => page.evaluate(i => {
      const frame = document.querySelectorAll('.desk-layer:not(.inactive) .frame:has(> .frame-dock)')[i]
      const st = window.getComputedStyle(frame, '::after')
      return { opacity: Number(st.opacity), color: st.backgroundColor }
    }, fLone)
    await focusFrame(page, fCrowd)
    assert.equal((await page.evaluate(() => window.__tether.signals())).dimUnfocused, false, 'dim is off before the levels')
    await level('ui.dim-weak', 'weak') // picking a level also turns the dim on
    assert.equal((await page.evaluate(() => window.__tether.signals())).dimUnfocused, true, 'picking a level turns the dim on')
    const weak = await veilOf()
    assert.ok(Math.abs(weak.opacity - 0.2) < 0.01, `fraco is .20: ${weak.opacity}`)
    await level('ui.dim-medium', 'medium')
    const medium = await veilOf()
    assert.ok(Math.abs(medium.opacity - 0.32) < 0.01, `médio is .32: ${medium.opacity}`)
    await level('ui.dim-strong', 'strong')
    const strong = await veilOf()
    assert.ok(Math.abs(strong.opacity - 0.45) < 0.01, `forte is .45: ${strong.opacity}`)
    assert.equal(weak.color, strong.color, 'the veil colour does not change with the level')
    assert.notEqual(strong.color, 'rgb(0, 0, 0)', 'the veil is the desk background, not black')
    assert.equal(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).ui.dimLevel, 'strong', 'settings.json ui.dimLevel')
    // Palette: "Esmaecer: fraco" picks the level too.
    await page.keyboard.press('Control+Shift+P')
    await page.waitForFunction(() => (window.__tether as unknown as { palette(): { open: boolean } }).palette().open)
    await page.keyboard.type('Esmaecer: fraco')
    await sleep(300)
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => window.__tether.signals().dimLevel === 'weak')
    // Turning the dim off keeps the level; turning it on again brings it back.
    await setModes(page, { line: true, border: false, dim: false })
    assert.equal((await page.evaluate(() => window.__tether.signals())).dimLevel, 'weak', 'the level survives the toggle')
    // Screenshots: light and dark x three levels.
    mkdirSync(shots3, { recursive: true })
    const dim3: string[] = []
    for (const scheme of ['light', 'dark'] as const) {
      await setTheme(page, scheme)
      for (const [cmd, name] of [['ui.dim-weak', 'weak'], ['ui.dim-medium', 'medium'], ['ui.dim-strong', 'strong']] as const) {
        await level(cmd, name)
        await page.mouse.move(900, 20)
        await sleep(300)
        const b64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString('base64'))
        const file = join(shots3, `dim-${name}-${scheme}.png`)
        writeFileSync(file, Buffer.from(b64, 'base64'))
        dim3.push(file)
      }
    }
    console.log(dim3.join(String.fromCharCode(10)))
    await setTheme(page, 'light')
    await setModes(page, { line: true, border: false, dim: false })

    // 5. The drawer is desk-like with its own Foco (`.drawer-focused`, never the desk's `.focused`): the folder border in the neutral --drawer-line, 2px.
    await setModes(page, { line: true, border: true, dim: false })
    await page.click('#btn-drawer')
    await page.waitForFunction(() => window.__tether.drawer().open && window.__tether.drawer().panes.length === 1, undefined, { timeout: 20_000 })
    await sleep(800)
    const drawerFrame = await page.evaluate(() => {
      const tab = document.querySelector('.drawer-card .frame.drawer-focused .dv-groupview.dv-active-group .dv-tab.dv-active-tab') as Q | null
      const line = (window.getComputedStyle(document.querySelector('#workbench') as Q as never, '::before') as unknown as { height: string }).height
      const b = tab ? window.getComputedStyle(tab as never, '::before') : undefined
      return { tab: b ? `${b.borderTopColor} ${b.borderTopWidth}` : '', foco: document.querySelectorAll('.drawer-card .frame.focused').length, kbd: document.querySelectorAll('.drawer-card .frame.kbd-focused').length, line }
    })
    assert.equal(drawerFrame.foco, 0, 'no Foco de Mesa in the drawer')
    assert.equal(drawerFrame.kbd, 0, 'the drawer never wears the pad keyboard marker')
    assert.match(drawerFrame.tab, /^rgb\((61, 61, 61|208, 208, 208)\) 2px$/, 'the drawer active tab has the folder border in --drawer-line at 2px')
    assert.ok(!drawerFrame.tab.includes(fill), 'the drawer does not use the desk colour')
    assert.equal(drawerFrame.line, '2px', 'the top line is as thick as the border (--desk-line-width)')
    await shot(app, 'drawer-border')
    await page.click('#drawer-pill')
    await page.waitForFunction(() => !window.__tether.drawer().open)
    await sleep(500)
    await setModes(page, { line: true, border: false, dim: false })

    // 6. Screenshots: each mode alone and the three together, both themes.
    const files: string[] = []
    await focusFrame(page, fCrowd)
    const combos: [string, { line: boolean; border: boolean; dim: boolean }][] = [
      ['line', { line: true, border: false, dim: false }],
      ['border', { line: false, border: true, dim: false }],
      ['dim', { line: false, border: false, dim: true }],
      ['all', { line: true, border: true, dim: true }],
    ]
    for (const scheme of ['light', 'dark'] as const) {
      await setTheme(page, scheme)
      for (const [name, modes] of combos) {
        await setModes(page, modes)
        await page.mouse.move(900, 20)
        await sleep(300)
        files.push(await shot(app, `${name}-${scheme}`))
      }
    }
    console.log(files.join('\n'))
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) {
      const r = await killOwned(d, { tree: true })
      if (r === 'not-ours') console.error(`tetherd cleanup: pid ${d.pid} is no longer ours; not killed`)
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
