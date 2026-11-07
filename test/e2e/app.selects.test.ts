// E2E of the dialog <select>s (customizable select, appearance: base-select) in the Electron app, against the real
// tetherd on a private home/pipe, hidden window:
//   1. this Chromium supports base-select, and the dialog select renders with it (selectedcontent);
//   2. the terminal font (in "Tema do terminal…") opens, the keyboard picks a font and it lands in the appearance;
//   3. disabled is muted; screenshots, light and dark: closed, hover, focused, open (clipped, disk is tight).
// Every kill goes through test/kill.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  connection(): { connected: boolean; pid?: number } | undefined
  theme(): { setting: string; scheme: 'light' | 'dark' }
  terminalAppearance(): { font: string }
}
type El = {
  matches(s: string): boolean
  querySelector(s: string): unknown
  querySelectorAll(s: string): ArrayLike<{ getBoundingClientRect(): { top: number; bottom: number; left: number; right: number } }>
  blur(): void
  disabled: boolean
}
declare const window: { __tether: Hooks; innerWidth: number; innerHeight: number }
declare const document: { documentElement: { dataset: Record<string, string | undefined> } }
declare const CSS: { supports(p: string, v: string): boolean }
declare function getComputedStyle(el: unknown): { appearance: string; opacity: string }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-selects-${process.pid}`
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

const isOpen = (page: Page, sel: string): Promise<boolean> => page.locator(sel).evaluate(el => (el as unknown as El).matches(':open'))

/** Clip around the select and, when open, its picker (top layer, outside the select's own box). */
async function shot(page: Page, sel: string, name: string, pad = 10): Promise<void> {
  const box = (await page.locator(sel).boundingBox())!
  const picker = await page.locator(sel).evaluate(node => {
    const el = node as unknown as El
    if (!el.matches(':open')) return null
    const rs = Array.from(el.querySelectorAll('option')).map(o => o.getBoundingClientRect())
    return { top: Math.min(...rs.map(r => r.top)) - 6, bottom: Math.max(...rs.map(r => r.bottom)) + 6, left: Math.min(...rs.map(r => r.left)) - 6, right: Math.max(...rs.map(r => r.right)) + 6 }
  })
  let x0 = box.x, y0 = box.y, x1 = box.x + box.width, y1 = box.y + box.height
  if (picker) { x0 = Math.min(x0, picker.left); y0 = Math.min(y0, picker.top); x1 = Math.max(x1, picker.right); y1 = Math.max(y1, picker.bottom) }
  const vp = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const x = Math.max(0, x0 - pad), y = Math.max(0, y0 - pad)
  const clip = { x, y, width: Math.min(vp.width - x, x1 - x + pad), height: Math.min(vp.height - y, y1 - y + pad) }
  await page.screenshot({ path: join(artifacts, name), clip })
}

async function shoot(page: Page, sel: string, prefix: string, scheme: string, optionIndex: number): Promise<void> {
  await page.mouse.move(1, 500)
  await page.locator(sel).evaluate(el => (el as unknown as El).blur())
  await sleep(200)
  await shot(page, sel, `${prefix}-closed-${scheme}.png`)
  await page.hover(sel); await sleep(250)
  await shot(page, sel, `${prefix}-hover-${scheme}.png`)
  await page.mouse.move(1, 500)
  await page.locator(sel).focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab'); await sleep(200)
  await shot(page, sel, `${prefix}-focus-${scheme}.png`)
  await page.click(sel); await sleep(300)
  assert.equal(await isOpen(page, sel), true, `${sel} opens on click`)
  await page.locator(`${sel} option`).nth(optionIndex).hover(); await sleep(200)
  await shot(page, sel, `${prefix}-open-${scheme}.png`)
  await page.keyboard.press('Escape'); await sleep(200)
  assert.equal(await isOpen(page, sel), false, `${sel} closes on Escape`)
}

async function pick(page: Page, sel: string, opener: string, key: string): Promise<void> {
  await page.locator(sel).focus()
  await page.keyboard.press(opener); await sleep(250)
  assert.equal(await isOpen(page, sel), true, `${opener} opens ${sel}`)
  await page.keyboard.press(key)
  await page.keyboard.press('Enter'); await sleep(150)
}

test('selects: base-select dialog trigger + menu-like picker, keyboard selection applies, light and dark', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-selectstest-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // 1. Support in this Electron's Chromium, and the dialog select actually uses it.
    assert.equal(await page.evaluate(() => CSS.supports('appearance', 'base-select')), true, 'appearance: base-select')
    const s = await page.locator('#term-font').evaluate(el => ({ app: getComputedStyle(el).appearance, sc: !!(el as unknown as El).querySelector('selectedcontent') }))
    assert.equal(s.app, 'base-select', '#term-font renders as base-select')
    assert.ok(s.sc, '#term-font has a selectedcontent')

    // 2. Terminal font, in its dialog.
    await page.evaluate(() => (globalThis as unknown as { __tether: { runCommand(id: string): Promise<unknown> } }).__tether.runCommand('terminal.theme'))
    await page.waitForSelector('#dlg-term-theme[open]')
    const font = '#term-font'
    const before = (await page.evaluate(() => window.__tether.terminalAppearance())).font
    const last = (await page.locator(`${font} option`).last().getAttribute('value'))!
    assert.notEqual(last, before)
    await pick(page, font, 'Enter', 'End')
    await page.waitForFunction(f => window.__tether.terminalAppearance().font === f, last)
    assert.equal(await page.inputValue(font), last, 'keyboard pick lands in the select and the appearance')
    await page.selectOption(font, before)
    await page.waitForFunction(f => window.__tether.terminalAppearance().font === f, before)

    // 3. Disabled: muted.
    await page.locator(font).evaluate(el => { (el as unknown as El).disabled = true })
    assert.equal(await page.locator(font).evaluate(el => getComputedStyle(el).opacity), '0.45', 'disabled is muted')
    await page.locator(font).evaluate(el => { (el as unknown as El).disabled = false })

    for (const scheme of ['light', 'dark'] as const) {
      await page.evaluate(s => { document.documentElement.dataset.theme = s }, scheme) // the dialog stays open
      await shoot(page, font, 'select-font', scheme, 1)
    }
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
