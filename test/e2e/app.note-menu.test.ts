// E2E of the note editor's context menu (right click): Monaco paints it inside a shadow root from the theme's
// menu.* colours, so the editor theme must define them. Against the real tetherd on a private home/pipe, hidden window.
//   for light and dark: right click in a note -> the menu is in the DOM, its computed background is opaque (alpha 1),
//   it has a border and a shadow; screenshots note-menu-{light,dark}.png (TETHER_SHOT_DIR overrides the folder).
// Every kill goes through test/kill.ts (pid + creation time).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  panelIds(): string[]
  notes(): { id: string }[]
  connection(): { connected: boolean; pid?: number } | undefined
}
type MenuLook = { background: string; color: string; border: string; shadow: string; itemColor: string }
type ShadowHost = { shadowRoot: { querySelector(s: string): unknown } | null }
declare const window: { __tether: Hooks; tether: { setTheme(s: string): Promise<unknown> }; getComputedStyle(el: unknown): Record<string, string> }
declare const document: {
  querySelectorAll(sel: string): { length: number } & ArrayLike<ShadowHost>
  documentElement: { dataset: Record<string, string | undefined> }
}

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-notemenu-${process.pid}`
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const outDir = process.env.TETHER_SHOT_DIR ?? artifacts

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
  page.setDefaultTimeout(15_000)
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
  return { app, page }
}

async function shot(app: ElectronApplication, file: string): Promise<void> {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => {
    const img = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()
    return img.toPNG().toString('base64')
  })
  writeFileSync(file, Buffer.from(b64, 'base64'))
}

/** The context menu's computed look, read from inside Monaco's shadow root. */
const menuLook = (page: Page): Promise<MenuLook | undefined> => page.evaluate(() => {
  for (const host of Array.from(document.querySelectorAll('.shadow-root-host'))) {
    const menu = host.shadowRoot?.querySelector('.monaco-menu') as { querySelector(s: string): unknown } | null | undefined
    if (!menu) continue
    // Monaco paints the background and the shadow on wrappers around .monaco-menu (inside the shadow root): take the
    // first of menu and its ancestors that paints each.
    type El = { parentElement: El | null; querySelector(s: string): unknown }
    const chain: El[] = []
    for (let e = menu as El | null; e; e = e.parentElement) chain.push(e)
    const styles = chain.map(e => window.getComputedStyle(e))
    const cs = styles[0]!
    const item = menu.querySelector('.action-item .action-label')
    return {
      background: styles.find(x => x.backgroundColor !== 'rgba(0, 0, 0, 0)')?.backgroundColor ?? 'rgba(0, 0, 0, 0)',
      color: cs.color ?? '', border: `${cs.borderTopWidth} ${cs.borderTopColor}`,
      shadow: styles.find(x => x.boxShadow !== 'none')?.boxShadow ?? 'none', itemColor: item ? window.getComputedStyle(item).color ?? '' : '',
    }
  }
  return undefined
})

function alphaOf(css: string): number {
  const m = /^rgba?\(([^)]+)\)$/.exec(css.trim())
  if (!m) return css === 'transparent' ? 0 : NaN
  const p = m[1]!.split(/[ ,/]+/).filter(Boolean)
  return p.length > 3 ? Number(p[3]) : 1
}

test('app note menu: the editor context menu is opaque, bordered and shadowed in light and dark', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(outDir, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-notemenu-'))
  const cwd = mkdtempSync(join(tmpdir(), 'tether-notemenu-cwd-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    await page.click('#btn-new')
    await page.waitForSelector('#dlg-new[open]')
    await page.fill('#dlg-new .ch-path-input', cwd)
    await page.click('#dlg-new .ch-item[data-id="powershell"]')
    await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
    await page.waitForFunction(() => document.querySelectorAll('.tether-tab').length === 1)
    const [shell] = await page.evaluate(() => window.__tether.panelIds())
    await page.locator(`.panel[data-slot-id="${shell}"] .panel-term`).click()

    await page.click('#btn-menu')
    await page.waitForSelector('#app-menu:not([hidden])')
    await page.click('#app-menu li[data-command="note.new"]')
    await page.waitForFunction(() => window.__tether.notes().length === 1)
    const noteId = (await page.evaluate(() => window.__tether.notes()))[0]!.id
    await page.locator(`.note-panel[data-note-id="${noteId}"] .monaco-editor`).click()
    await page.keyboard.type('alpha one two three')

    for (const scheme of ['light', 'dark'] as const) {
      await page.evaluate(async s => { await window.tether.setTheme(s) }, scheme)
      await page.waitForFunction(s => document.documentElement.dataset.theme === s, scheme)
      await sleep(300)
      await page.locator(`.note-panel[data-note-id="${noteId}"] .view-lines`).click({ button: 'right', position: { x: 40, y: 10 } })
      await page.waitForFunction(() => Array.from(document.querySelectorAll('.shadow-root-host')).some(h => h.shadowRoot?.querySelector('.monaco-menu')))
      await sleep(300)
      const look = await menuLook(page)
      console.log(scheme, JSON.stringify(look))
      await shot(app, join(outDir, `note-menu-${scheme}.png`))
      assert.ok(look, `${scheme}: the context menu is in the DOM`)
      assert.equal(alphaOf(look.background), 1, `${scheme}: menu background is opaque (${look.background})`)
      assert.notEqual(look.background, look.itemColor, `${scheme}: text differs from the background`)
      assert.ok(parseFloat(look.border) > 0, `${scheme}: menu has a border (${look.border})`)
      assert.notEqual(look.shadow, 'none', `${scheme}: menu has a shadow`)
      await page.keyboard.press('Escape')
      await sleep(200)
    }
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) {
      const r = await killOwned(d, { tree: true })
      if (r === 'not-ours') console.error(`tetherd cleanup: pid ${d.pid} is no longer ours; not killed`)
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (const dir of [home, cwd]) for (let i = 0; i < 5; i++) {
      try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
