// E2E of "Tema do terminal…" in the Electron app, against the real tetherd on a private home/pipe, hidden window:
//   1. a shell panel comes up with the defaults (GitHub, JetBrains Mono 350/14px/1.2, contrast 4.5, bundled
//      font loaded before xterm measured it);
//   2. the dialog opens from the ≡ menu and from the native menu; its sample shows the colours and box drawing;
//   3. preset, font, weight, size and line height change every pane at once and land in settings.json;
//   4. the light/dark pair follows the app theme; "Restaurar padrão" brings the defaults back;
//   5. a choice survives killing the window by PID and relaunching.
// Screenshots are clipped to the dialog / the pane (disk is tight). Every kill goes through test/kill.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { DEFAULT_APPEARANCE, presetOf, type TerminalAppearance } from '../../app/shared/terminal-theme.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type TermOptions = { fontFamily: string; fontWeight: number | string; fontWeightBold: number | string; fontSize: number; lineHeight: number; letterSpacing: number; minimumContrastRatio: number; renderer: string }
type Hooks = {
  panelIds(): string[]
  text(id: string): string
  connection(): { connected: boolean; pid?: number } | undefined
  activate(id: string): void
  theme(): { setting: string; scheme: 'light' | 'dark' }
  termTheme(id: string): Record<string, string | undefined> | undefined
  termOptions(id: string): TermOptions | undefined
  terminalAppearance(): TerminalAppearance
  openTerminalTheme(): void
  fontLoaded(spec: string): boolean
  sample(): { text: string; fontFamily: string; background: string | undefined } | undefined
  paint(selector: string, maxW: number, maxH: number): { png: string; painted: number; width: number; height: number } | undefined
  inject(id: string, data: string): void
}
declare const window: { __tether: Hooks }
declare const document: { querySelectorAll(selector: string): { length: number }; querySelector(selector: string): { open?: boolean } | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-termtheme-${process.pid}`
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

async function createShellPanel(page: Page, cwd: string): Promise<string> {
  const before = await page.locator('.tether-tab').count()
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  await page.click('#dlg-new .ch-item[data-id=\"powershell\"]')
  await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
  await page.waitForFunction(n => document.querySelectorAll('.tether-tab').length === n, before + 1)
  const ids = await page.evaluate(() => window.__tether.panelIds())
  const id = ids[ids.length - 1]!
  await page.waitForFunction(id => /PS.*>/.test(window.__tether.text(id).replace(/\s+/g, '')), id, { timeout: 20_000 })
  return id
}

const hooks = {
  appearance: (page: Page) => page.evaluate(() => window.__tether.terminalAppearance()),
  options: (page: Page, id: string) => page.evaluate(id => window.__tether.termOptions(id), id),
  theme: (page: Page, id: string) => page.evaluate(id => window.__tether.termTheme(id), id),
  scheme: (page: Page) => page.evaluate(() => window.__tether.theme().scheme),
  fontLoaded: (page: Page, spec: string) => page.evaluate(spec => window.__tether.fontLoaded(spec), spec),
  sample: (page: Page) => page.evaluate(() => window.__tether.sample()),
  paint: (page: Page, selector: string, w: number, h: number) => page.evaluate(([s, w, h]) => window.__tether.paint(s as string, w as number, h as number), [selector, w, h]),
  daemonPid: async (page: Page) => (await page.evaluate(() => window.__tether.connection()))?.pid,
  clickMenu: (app: ElectronApplication, id: string) => app.evaluate(({ Menu }, id) => { Menu.getApplicationMenu()?.getMenuItemById(id)?.click() }, id),
  dialogOpen: (page: Page) => page.evaluate(() => document.querySelector('#dlg-term-theme')?.open === true),
}

function saved(home: string): unknown {
  return (JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as { terminal?: unknown }).terminal
}

/** Sets a range/number input the way a user would and fires the events the dialog listens to. */
async function setInput(page: Page, selector: string, value: string): Promise<void> {
  await page.locator(selector).evaluate((el, v) => {
    const input = el as unknown as { value: string; dispatchEvent(ev: unknown): void }
    input.value = v
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
}

async function waitAppearance(page: Page, want: Partial<TerminalAppearance>): Promise<void> {
  await page.waitForFunction(want => {
    const a = window.__tether.terminalAppearance() as unknown as Record<string, unknown>
    return Object.entries(want).every(([k, v]) => a[k] === v)
  }, want)
}

/** Every pane's xterm carries the appearance: palette of the preset for the scheme, font options, contrast. */
async function assertPanes(page: Page, ids: string[], a: TerminalAppearance, family: string): Promise<void> {
  const scheme = await hooks.scheme(page)
  const want = presetOf(a.preset)[scheme]
  for (const id of ids) {
    const t = (await hooks.theme(page, id))!
    assert.equal(t.red, want.red, `${id}: red of ${a.preset} (${scheme})`)
    assert.equal(t.foreground, want.foreground, `${id}: foreground`)
    assert.equal(t.brightYellow, want.brightYellow, `${id}: bright yellow`)
    const o = (await hooks.options(page, id))!
    assert.ok(o.fontFamily.startsWith(`"${family}"`), `${id}: font family ${o.fontFamily}`)
    assert.equal(o.fontWeight, a.fontWeight, `${id}: weight`)
    assert.equal(o.fontSize, a.fontSize, `${id}: size`)
    assert.equal(o.lineHeight, a.lineHeight, `${id}: line height`)
    assert.equal(o.minimumContrastRatio, 4.5, `${id}: contrast`)
    assert.equal(o.letterSpacing, 0, `${id}: letter spacing`)
  }
}

const BOX = '\r\n╭──────────────╮ ┌───┬───┐\r\n│ caixa  ▀▄█░▒▓ │ ├───┼───┤\r\n╰──────────────╯ └───┴───┘\r\n'

/**
 * A WebGL canvas is invisible to a window capture in the offscreen window, so the rendering is read back from
 * the canvas itself (pixels, cropped) and saved as the artifact; the count of painted pixels proves it drew.
 */
async function savePaint(page: Page, selector: string, file: string, w: number, h: number): Promise<number> {
  const paint = await hooks.paint(page, selector, w, h)
  assert.ok(paint, `${selector}: no canvas (DOM renderer?)`)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(artifacts, file), Buffer.from(paint.png.split(',')[1]!, 'base64'))
  return paint.painted
}

test('terminal theme: presets and fonts apply live to every pane, persist, follow the scheme and survive a relaunch', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-termtheme-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await hooks.daemonPid(page))!
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // 1. Defaults, with the bundled font loaded before the terminal opened.
    assert.deepEqual(await hooks.appearance(page), DEFAULT_APPEARANCE)
    const first = await createShellPanel(page, root)
    await page.keyboard.press('Control+Alt+ArrowRight')
    await page.waitForFunction(() => document.querySelectorAll('.tether-tab').length === 2)
    const ids = await page.evaluate(() => window.__tether.panelIds())
    assert.equal(ids.length, 2)
    await assertPanes(page, ids, DEFAULT_APPEARANCE, 'JetBrains Mono')
    assert.equal(await hooks.fontLoaded(page, '350 14px "JetBrains Mono"'), true, 'JetBrains Mono regular face loaded')
    assert.equal(await hooks.fontLoaded(page, '600 14px "JetBrains Mono"'), true, 'JetBrains Mono bold face loaded')
    const renderer = (await hooks.options(page, first))!.renderer
    console.error(`renderer: ${renderer}`)
    assert.ok(renderer === 'webgl' || renderer === 'dom')
    assert.equal((await hooks.options(page, first))!.fontWeightBold, 600)

    // Box drawing at line height 1.2 in a pane (reviewed by eye in the screenshot).
    await page.evaluate(id => window.__tether.activate(id), first)
    await page.evaluate(([id, box]) => window.__tether.inject(id!, box!), [first, BOX])
    await sleep(400)
    if (renderer === 'webgl') {
      const painted = await savePaint(page, `.panel[data-slot-id="${first}"] .xterm-screen`, 'terminal-theme-box-default.png', 420, 170)
      assert.ok(painted > 500, `the WebGL renderer painted glyphs (${painted} px)`)
    }

    // 2. The dialog from the ≡ menu; the sample shows the palette and the box drawing.
    await page.click('#btn-menu')
    await page.click('#app-menu li[data-command="terminal.theme"]')
    await page.waitForSelector('#dlg-term-theme[open]')
    const sample = (await hooks.sample(page))!
    assert.match(sample.text, /vermelho .*verde .*amarelo/)
    assert.match(sample.text, /╭─+╮/)
    assert.ok(sample.fontFamily.startsWith('"JetBrains Mono"'))
    assert.equal(await page.locator('#term-presets .preset-option').count(), 7)
    assert.equal(await page.locator('input[name=term-preset]:checked').getAttribute('value'), 'github')
    assert.equal(await page.inputValue('#term-font'), 'jetbrains-mono')
    assert.equal(await page.inputValue('#term-weight'), '350')
    assert.equal(await page.inputValue('#term-size'), '14')
    assert.equal(await page.inputValue('#term-line-height'), '1.2')
    const scheme0 = await hooks.scheme(page)
    await sleep(300)
    const box = (await page.locator('#dlg-term-theme').boundingBox())!
    await page.screenshot({ path: join(artifacts, `terminal-theme-dialog-${scheme0}.png`), clip: box })
    assert.ok(await savePaint(page, '#term-sample .xterm-screen', `terminal-theme-sample-${scheme0}.png`, 700, 130) > 500, 'the sample painted')

    // 3. Preset, font, weight, size, line height: every pane follows, settings.json remembers.
    await page.check('input[name=term-preset][value=catppuccin]')
    await waitAppearance(page, { preset: 'catppuccin' })
    await assertPanes(page, ids, { ...DEFAULT_APPEARANCE, preset: 'catppuccin' }, 'JetBrains Mono')
    assert.equal((saved(home) as TerminalAppearance).preset, 'catppuccin', 'settings.json has the preset')
    assert.equal((await hooks.sample(page))!.background, (await hooks.theme(page, first))!.background, 'the sample sits on the panes\' background')

    await page.selectOption('#term-font', 'ibm-plex-mono')
    await waitAppearance(page, { font: 'ibm-plex-mono' })
    assert.equal(await hooks.fontLoaded(page, '350 14px "IBM Plex Mono"'), true, 'IBM Plex Mono loaded on switch')
    await assertPanes(page, ids, { ...DEFAULT_APPEARANCE, preset: 'catppuccin', font: 'ibm-plex-mono' }, 'IBM Plex Mono')
    assert.equal((saved(home) as TerminalAppearance).font, 'ibm-plex-mono')

    await setInput(page, '#term-weight', '500')
    await waitAppearance(page, { fontWeight: 500 })
    assert.equal((await hooks.options(page, first))!.fontWeight, 500)
    assert.equal((await hooks.options(page, first))!.fontWeightBold, 700, 'bold follows the weight')
    assert.equal(await page.locator('#term-weight-label').textContent(), '500 · médio')

    await setInput(page, '#term-size', '16')
    await waitAppearance(page, { fontSize: 16 })
    assert.equal((await hooks.options(page, first))!.fontSize, 16)
    assert.equal(await hooks.fontLoaded(page, '500 16px "IBM Plex Mono"'), true)

    await setInput(page, '#term-line-height', '1')
    await waitAppearance(page, { lineHeight: 1 })
    assert.equal((await hooks.options(page, first))!.lineHeight, 1)
    assert.deepEqual(saved(home), { preset: 'catppuccin', font: 'ibm-plex-mono', fontWeight: 500, fontSize: 16, lineHeight: 1 })

    // Switching to Cascadia clamps the weight to its axis (200–700): 500 stays; the dialog shows the new range.
    await page.selectOption('#term-font', 'cascadia-mono')
    await waitAppearance(page, { font: 'cascadia-mono' })
    assert.equal(await page.locator('#term-weight').getAttribute('min'), '200')
    assert.ok((await hooks.options(page, first))!.fontFamily.startsWith('"Cascadia Mono Bundled"'))

    // 4. The pair follows the app theme (dark ↔ light), with the dialog open.
    const other = scheme0 === 'dark' ? 'light' : 'dark'
    await hooks.clickMenu(app, `theme-${other}`)
    await page.waitForFunction(s => window.__tether.theme().scheme === s, other)
    await page.waitForFunction(([id, red]) => window.__tether.termTheme(id!)?.red === red, [first, presetOf('catppuccin')[other].red])
    await assertPanes(page, ids, { preset: 'catppuccin', font: 'cascadia-mono', fontWeight: 500, fontSize: 16, lineHeight: 1 }, 'Cascadia Mono Bundled')
    await sleep(300)
    const box2 = (await page.locator('#dlg-term-theme').boundingBox())!
    await page.screenshot({ path: join(artifacts, `terminal-theme-dialog-${other}.png`), clip: box2 })
    assert.ok(await savePaint(page, '#term-sample .xterm-screen', `terminal-theme-sample-${other}.png`, 700, 130) > 500, 'the sample painted (other scheme)')

    // "Restaurar padrão".
    await page.click('#btn-term-theme-reset')
    await waitAppearance(page, DEFAULT_APPEARANCE)
    await assertPanes(page, ids, DEFAULT_APPEARANCE, 'JetBrains Mono')
    assert.deepEqual(saved(home), DEFAULT_APPEARANCE)
    assert.equal(await page.locator('input[name=term-preset]:checked').getAttribute('value'), 'github')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelector('#dlg-term-theme')?.open === false)

    // The native menu opens it too; Esc closes it and the app shortcut guard is off again.
    await hooks.clickMenu(app, 'terminal-theme')
    await page.waitForSelector('#dlg-term-theme[open]')
    assert.equal(await hooks.dialogOpen(page), true)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelector('#dlg-term-theme')?.open === false)

    // 5. A choice survives a relaunch: Tokyo Night + Ubuntu Sans Mono 300.
    await page.evaluate(() => window.__tether.openTerminalTheme())
    await page.waitForSelector('#dlg-term-theme[open]')
    await page.check('input[name=term-preset][value=tokyo-night]')
    await page.selectOption('#term-font', 'ubuntu-sans-mono')
    await setInput(page, '#term-weight', '300')
    await waitAppearance(page, { preset: 'tokyo-night', font: 'ubuntu-sans-mono', fontWeight: 300 })
    await page.keyboard.press('Escape')
    const chosen: TerminalAppearance = { preset: 'tokyo-night', font: 'ubuntu-sans-mono', fontWeight: 300, fontSize: 14, lineHeight: 1.2 }
    assert.deepEqual(saved(home), chosen)
    await assertPanes(page, ids, chosen, 'Ubuntu Sans Mono')
    await killElectron(app, root)
    app = undefined
    ;({ app, page } = await launch(home))
    assert.deepEqual(await hooks.appearance(page), chosen, 'comes back with the saved appearance')
    await page.waitForFunction(n => window.__tether.panelIds().length === n, ids.length)
    const restored = await page.evaluate(() => window.__tether.panelIds())
    assert.deepEqual(restored.sort(), [...ids].sort(), 'layout restored')
    assert.equal(await hooks.fontLoaded(page, '300 14px "Ubuntu Sans Mono"'), true, 'the saved font is loaded before the panes open')
    await assertPanes(page, restored, chosen, 'Ubuntu Sans Mono')

    // A corrupt or foreign value in settings.json falls back to the defaults.
    await killElectron(app, root)
    app = undefined
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ terminal: { preset: 'solarized', font: 'fira', fontSize: 'huge' } }))
    ;({ app, page } = await launch(home))
    assert.deepEqual(await hooks.appearance(page), DEFAULT_APPEARANCE, 'unknown ids → defaults')
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
