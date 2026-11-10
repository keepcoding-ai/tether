// E2E of the native surfaces (app/main/surfaces.ts) through the extension API of main, with the app built with
// TETHER_TEST_EXTENSIONS=1 (the probe test/e2e/fixtures/surface-probe hands its TetherMain to the test as
// globalThis.__surfaceProbe). Hidden window, private home/pipe, real tetherd, CLAUDE* stripped. A local page at a fixed
// 1280×800:
//   1. hidden (initial): the page sees 1280×800, capture is not empty;
//   2. shown in rectangles of different proportions: the page still sees 1280×800, scale and effective rectangle are the fit
//      (never enlarged), a sendInputEvent click at a view coordinate lands on the right element under scale;
//   3. shield on: it sits right above the surface, the owner gets `shield-input` in window coordinates and the page nothing;
//      off: hidden again;
//   4. capture in shown, parked and hidden; the core's emulation methods are refused to the owner;
//   5. reapplyEmulation restores the scale after a clipped Page.captureScreenshot;
//   6. destroy lets the webContents go.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { Surface, SurfaceShieldInput, SurfaceState, TetherMain } from '../../app/main/ext-api.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type G = { __surfaceProbe: TetherMain; __s: Surface; __shieldIn: SurfaceShieldInput[] }
declare const window: { __tether: { connection(): { connected: boolean; pid?: number } | undefined } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-surfaces-${process.pid}`

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

const PAGE = `<!doctype html><html><head><style>
html,body{margin:0;height:100%;background:#2a4}
#t{position:absolute;left:1000px;top:600px;width:100px;height:60px;background:#e60}
</style></head><body><div id="t"></div><script>
window.__clicks = []
document.addEventListener('mousedown', e => { window.__clicks.push(e.target.id || e.target.tagName) }, true)
</script></body></html>`

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

test('surfaces: fixed page size, fit, states, shield, capture, reapply, destroy', { timeout: 240_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-surfaces-'))
  const pagePath = join(home, 'page.html')
  writeFileSync(pagePath, PAGE)
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const a = app

    const metrics = () => a.evaluate(() => (globalThis as unknown as G).__s.webContents.executeJavaScript('[innerWidth, innerHeight, Math.round(devicePixelRatio * 1000) / 1000]') as Promise<number[]>)
    const state = () => a.evaluate(() => (globalThis as unknown as G).__s.state())
    const clicks = () => a.evaluate(() => (globalThis as unknown as G).__s.webContents.executeJavaScript('window.__clicks.splice(0)') as Promise<string[]>)
    const clickView = async (x: number, y: number): Promise<void> => {
      await a.evaluate((_e, { x, y }) => {
        const wc = (globalThis as unknown as G).__s.webContents
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
      }, { x, y })
      await sleep(250)
    }
    const captureSize = () => a.evaluate(async () => { const img = await (globalThis as unknown as G).__s.capture(); return { empty: img.isEmpty(), ...img.getSize() } })
    const setRect = (r: { x: number; y: number; width: number; height: number }) => a.evaluate((_e, r) => (globalThis as unknown as G).__s.setRect(r), r)
    const setVis = (v: 'hidden' | 'shown' | 'parked') => a.evaluate((_e, v) => (globalThis as unknown as G).__s.setVisibility(v), v)
    /** The window's child views, top last: 'S' for the surface, 'H' for its shield, '-' for anything else. */
    const children = () => a.evaluate(({ BrowserWindow, webContents }) => {
      const g = globalThis as unknown as G
      const win = BrowserWindow.getAllWindows().find(w => w.contentView.children.some(c => 'webContents' in c && (c as { webContents: { id: number } }).webContents.id === g.__s.webContents.id))!
      return win.contentView.children.map(c => {
        const id = 'webContents' in c ? (c as { webContents: { id: number } }).webContents.id : -1
        if (id === g.__s.webContents.id) return 'S'
        return webContents.fromId(id)?.getURL().startsWith('data:text/html') ? 'H' : '-'
      }).join('')
    })

    // ---- 1. hidden ----
    console.log('step 1')
    const content = await a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentSize())
    console.log('window content', content)
    const created: SurfaceState = await a.evaluate(async (_e, path) => {
      const g = globalThis as unknown as G
      g.__s = await g.__surfaceProbe.surfaces.create({ pageSize: { width: 1280, height: 800 }, webPreferences: { partition: 'surface-probe' } })
      await g.__s.webContents.loadFile(path)
      return g.__s.state()
    }, pagePath)
    assert.equal(created.visibility, 'hidden')
    assert.deepEqual(created.pageSize, { width: 1280, height: 800 })
    assert.deepEqual(await metrics(), [1280, 800, 1], 'hidden: the page sees 1280×800')
    const hiddenShot = await captureSize()
    assert.ok(!hiddenShot.empty && hiddenShot.width >= 1280 && hiddenShot.height >= 800, `hidden capture: ${JSON.stringify(hiddenShot)}`)
    await assert.rejects(a.evaluate(() => (globalThis as unknown as G).__s.setVisibility('parked')), /mostrada/, 'a hidden surface cannot park')
    await assert.rejects(a.evaluate(() => (globalThis as unknown as G).__surfaceProbe.surfaces.create({ webPreferences: { nodeIntegration: true } })), /nodeIntegration/)

    // ---- 2. shown, rectangles of different proportions ----
    console.log('step 2')
    const wide = { x: 100, y: 50, width: 1000, height: 400 }
    await setRect(wide)
    let st = await setVis('shown')
    assert.equal(st.scale, 0.5)
    assert.deepEqual(st.effective, { x: 280, y: 50, width: 640, height: 400 })
    assert.deepEqual(await metrics(), [1280, 800, 1], 'shown wide: 1280×800')
    await clickView(1050 * st.scale, 630 * st.scale)
    await clickView(100 * st.scale, 100 * st.scale)
    assert.deepEqual(await clicks(), ['t', 'BODY'], 'wide: the click lands on the target under scale 0.5')

    const tall = { x: 0, y: 0, width: 500, height: 600 }
    st = await setRect(tall)
    assert.equal(st.scale, 500 / 1280)
    assert.deepEqual(st.effective, { x: 0, y: 144, width: 500, height: 313 })
    assert.deepEqual(await metrics(), [1280, 800, 1], 'shown tall: 1280×800')
    await clickView(1050 * st.scale, 630 * st.scale)
    await clickView(950 * st.scale, 630 * st.scale)
    assert.deepEqual(await clicks(), ['t', 'BODY'], 'tall: the click lands on the target under scale 0.39')

    st = await setRect({ x: 0, y: 0, width: 1440, height: 900 })
    assert.equal(st.scale, 1, 'never enlarges')
    assert.deepEqual(st.effective, { x: 80, y: 50, width: 1280, height: 800 })
    await clickView(1050, 630)
    assert.deepEqual(await clicks(), ['t'])

    // ---- 3. shield ----
    console.log('step 3')
    st = await setRect(wide)
    await a.evaluate(async () => {
      const g = globalThis as unknown as G
      g.__shieldIn = []
      g.__s.onShieldInput(i => { g.__shieldIn.push(i) })
      await g.__s.setInputShield(true)
    })
    assert.match(await children(), /SH$/, 'the shield is right above the surface, on top')
    assert.equal((await state()).shield, true)
    await a.evaluate(async ({ webContents }) => {
      const g = globalThis as unknown as G
      const shield = webContents.getAllWebContents().find(w => w.getURL().startsWith('data:text/html') && w.id !== g.__s.webContents.id)!
      shield.sendInputEvent({ type: 'mouseDown', x: 10, y: 20, button: 'left', clickCount: 1 })
      shield.sendInputEvent({ type: 'mouseUp', x: 10, y: 20, button: 'left', clickCount: 1 })
      shield.sendInputEvent({ type: 'keyDown', keyCode: 'b' })
    })
    await sleep(400)
    const got = await a.evaluate(() => (globalThis as unknown as G).__shieldIn)
    const down = got.find(i => i.kind === 'down')
    assert.deepEqual(down && { x: down.x, y: down.y }, { x: 280 + 10, y: 50 + 20 }, `shield-input in window coordinates: ${JSON.stringify(got)}`)
    assert.ok(got.some(i => i.kind === 'key' && i.key === 'b'), 'the key reaches the owner')
    assert.deepEqual(await clicks(), [], 'the page gets nothing')
    await setVis('hidden')
    await setVis('shown')
    await a.evaluate(() => (globalThis as unknown as G).__s.setInputShield(false))
    assert.equal((await state()).shield, false)
    await clickView(1050 * 0.5, 630 * 0.5)
    assert.deepEqual(await clicks(), ['t'], 'shield off: the page takes input again')

    // ---- 4. capture in the three states; the core's methods ----
    console.log('step 4')
    const shownShot = await captureSize()
    assert.ok(!shownShot.empty && shownShot.width > 1, `shown capture: ${JSON.stringify(shownShot)}`)
    st = await setVis('parked')
    assert.equal(st.visibility, 'parked')
    const parkedShot = await captureSize()
    assert.ok(!parkedShot.empty && parkedShot.width > 1, `parked capture: ${JSON.stringify(parkedShot)}`)
    assert.deepEqual(await metrics(), [1280, 800, 1], 'parked: 1280×800')
    await setVis('hidden')
    const hiddenShot2 = await captureSize()
    assert.ok(!hiddenShot2.empty && hiddenShot2.width >= 1280, `hidden capture again: ${JSON.stringify(hiddenShot2)}`)
    console.log('captures', { hiddenShot, shownShot, parkedShot, hiddenShot2 })
    await assert.rejects(a.evaluate(() => (globalThis as unknown as G).__s.debugger.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false })), /núcleo/)

    // ---- 5. reapplyEmulation after a clipped screenshot ----
    console.log('step 5')
    st = await setVis('shown')
    assert.equal(st.scale, 0.5)
    const clipped = await a.evaluate(async () => {
      const shot = (globalThis as unknown as G).__s.debugger.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 200, height: 100, scale: 1 } }) as Promise<{ data?: string }>
      return Promise.race([shot.then(s => s.data?.length ?? 0), new Promise<string>(res => setTimeout(() => res('timeout'), 8_000))])
    })
    console.log('clipped screenshot:', clipped)
    if (clipped === 'timeout') {
      // The never-shown E2E window does not always produce a CDP screenshot (the bench saw the same: S1, "show:false"). The
      // scale loss the clip causes is then reproduced at the source: the override cleared behind the core's back.
      await a.evaluate(() => (globalThis as unknown as G).__s.webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride'))
    }
    await clickView(1050 * 0.5, 630 * 0.5)
    const broken = await clicks()
    console.log('scale lost, before reapply:', broken)
    if (clipped === 'timeout') assert.notDeepEqual(broken, ['t'], 'without the override the click misses')
    await a.evaluate(() => (globalThis as unknown as G).__s.reapplyEmulation())
    await clickView(1050 * 0.5, 630 * 0.5)
    assert.deepEqual(await clicks(), ['t'], 'reapplied: the scale is back')
    assert.deepEqual(await metrics(), [1280, 800, 1])

    // ---- 6. destroy ----
    console.log('step 6')
    const gone = await a.evaluate(async ({ webContents }) => {
      const g = globalThis as unknown as G
      const id = g.__s.webContents.id
      let fired = false
      g.__s.onDidDestroy(() => { fired = true })
      g.__s.destroy()
      await new Promise(r => setTimeout(r, 300))
      const wc = webContents.fromId(id)
      return { fired, alive: wc !== undefined && !wc.isDestroyed(), state: g.__s.state().destroyed, listed: g.__surfaceProbe.surfaces.list().length, shields: webContents.getAllWebContents().filter(w => w.getURL().startsWith('data:text/html')).length }
    })
    assert.deepEqual(gone, { fired: true, alive: false, state: true, listed: 0, shields: 0 })
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
