// E2E of the surface panels (TetherUi.surfaces + app/main/surface-bridge.ts), with the app built with TETHER_TEST_EXTENSIONS=1:
// the probe extension (test/e2e/fixtures/surface-probe) has a pane type whose element is tied to a surface its main side
// creates (a local page at a fixed 1280×800). Hidden window, private home/pipe, real tetherd, CLAUDE* stripped.
//   1. a visible pane: the view sits on the pane's rectangle (state().rect equals the element's, effective is the fit), and
//      the pane is told `effective` and `scale`;
//   2. another desk → hidden; back → shown in place;
//   3. a tab behind another in the same frame → hidden; active again → shown;
//   4. window resize and a split with a dragged divider: the rectangle follows;
//   5. the pane moved to another desk and to the system desk: the same surface (same webContents), a new rectangle;
//   6. the drawer: a pane in it is shown only while the drawer is open;
//   7. the pane closed → hidden, the surface still the extension's (destroying it lets the webContents go);
//   8. the shield: a click on it reaches the owner's renderer in the host element's coordinates;
//   9. an extension cannot place the surface of another.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { SurfaceShieldInput, SurfaceState, TetherMain } from '../../app/main/ext-api.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

interface Rect { x: number; y: number; width: number; height: number }
interface PaneInfo { id: string; surface: string; rect: Rect; state: { visibility: string; effective?: Rect; scale: number } | undefined; states: number; shield: SurfaceShieldInput[] }
type Probe = { open(surface?: string, target?: { level: string; placement: string }): Promise<string>; panes(): PaneInfo[]; activate(id: string): void; close(id: string): void }
type Hooks = {
  connection(): { connected: boolean; pid?: number } | undefined
  createDesk(side: 'before' | 'after', relativeTo?: string): string
  switchDesk(id: string): void
  toggleSystemDesk(id: string): void
  movePaneToDesk(id: string, deskId: string): void
  movePaneToDrawer(id: string): void
  openDrawer(): void
  closeDrawer(): void
  activeDesk(): string
  ext: Record<string, unknown>
}
type G = { __surfaceProbe: TetherMain }
declare const window: { __tether: Hooks; innerWidth: number; tether: { surfacePlace(m: unknown): void } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-surface-panel-${process.pid}`
const SYS = 'system-desk-probe.main'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

async function launch(home: string, pagePath: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  env.TETHER_SURFACE_PROBE_PAGE = pagePath
  delete env.TETHER_CLAUDE_ARGS
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

async function until<T>(what: string, fn: () => Promise<T | false | undefined>, ms = 8_000): Promise<T> {
  const end = Date.now() + ms
  let last: unknown
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v } catch (e) { last = e }
    await sleep(100)
  }
  throw new Error(`timeout: ${what}${last ? ` (${(last as Error).message})` : ''}`)
}

const near = (a: Rect | undefined, b: Rect, tol = 1.5): boolean => !!a && (['x', 'y', 'width', 'height'] as const).every(k => Math.abs(a[k] - b[k]) <= tol)

test('surface panels: rect, visibility, tabs, resize, moves, drawer, close, shield, owner', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-surface-panel-'))
  const pagePath = join(home, 'page.html')
  writeFileSync(pagePath, '<!doctype html><html><body style="margin:0;background:#2a4"></body></html>')
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, pagePath))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const a = app

    const probe = <T>(name: keyof Probe, ...args: unknown[]): Promise<T> =>
      page.evaluate(({ name, args }) => ((window.__tether.ext['surface-probe'] as Record<string, (...x: unknown[]) => unknown>)[name]!(...args)) as never, { name, args })
    const panes = (): Promise<PaneInfo[]> => probe('panes')
    const pane = async (id: string): Promise<PaneInfo> => (await panes()).find(p => p.id === id)!
    const surfaceState = (sid: string): Promise<SurfaceState | undefined> => a.evaluate((_e, sid) => (globalThis as unknown as G).__surfaceProbe.surfaces.get(sid)?.state(), sid)
    const wcId = (sid: string): Promise<number | undefined> => a.evaluate((_e, sid) => (globalThis as unknown as G).__surfaceProbe.surfaces.get(sid)?.webContents.id, sid)
    const hook = <K extends keyof Hooks>(name: K, ...args: unknown[]): Promise<unknown> => page.evaluate(({ name, args }) => (window.__tether[name] as unknown as (...x: unknown[]) => unknown)(...args), { name, args })
    const zoomRatio = (): Promise<number> => a.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentSize()[0]!)
      .then(async w => w / (await page.evaluate(() => window.innerWidth)))
    /** The surface sits on the pane's element: `rect` is the element's box and `effective` the 1280×800 page fitted in it. */
    const placed = async (id: string, why: string): Promise<{ st: SurfaceState; info: PaneInfo }> => {
      const out = await until(why, async () => {
        const info = await pane(id)
        const st = await surfaceState(info.surface)
        return st && st.visibility === 'shown' && near(st.rect, info.rect) ? { st, info } : false
      })
      const fit = Math.min(1, out.st.rect!.width / 1280, out.st.rect!.height / 800)
      assert.ok(Math.abs(out.st.scale - fit) < 1e-6, `${why}: scale ${out.st.scale} vs fit ${fit}`)
      assert.ok(Math.abs(out.st.effective!.width - 1280 * fit) <= 1 && Math.abs(out.st.effective!.height - 800 * fit) <= 1, `${why}: effective ${JSON.stringify(out.st.effective)}`)
      return out
    }
    const hiddenSoon = (id: string, why: string): Promise<SurfaceState> => until(why, async () => {
      const st = await surfaceState((await pane(id)).surface)
      return st && st.visibility === 'hidden' ? st : false
    })

    assert.ok(Math.abs((await zoomRatio()) - 1) < 0.01, 'no interface zoom in the test')

    // ---- 1. a visible pane ----
    console.log('step 1')
    const sidA = await probe<string>('open')
    const A = (await panes()).find(p => p.surface === sidA)!.id
    const first = await placed(A, 'pane A shown on its element')
    const wcA = await wcId(sidA)
    const told = await until('the pane is told its state', async () => { const p = await pane(A); return p.state && p.state.visibility === 'shown' ? p : false })
    const eff = told.state!.effective!
    const expectedScale = Math.min(1, first.st.rect!.width / 1280, first.st.rect!.height / 800)
    assert.ok(Math.abs(told.state!.scale - expectedScale) < 1e-6, 'the pane gets the scale')
    assert.ok(eff.x >= -1 && eff.y >= -1 && eff.x + eff.width <= told.rect.width + 1 && eff.y + eff.height <= told.rect.height + 1, `effective inside the element: ${JSON.stringify(eff)}`)

    // ---- 2. another desk ----
    console.log('step 2')
    const d1 = await hook('activeDesk') as string
    const d2 = await hook('createDesk', 'after') as string
    await hook('switchDesk', d2)
    await hiddenSoon(A, 'desk switched away')
    await hook('switchDesk', d1)
    const back = await placed(A, 'back on the first desk')
    assert.deepEqual(back.st.rect, first.st.rect, 'back in the same place')

    // ---- 3. a tab behind another ----
    console.log('step 3')
    const sidB = await probe<string>('open')
    const B = (await panes()).find(p => p.surface === sidB)!.id
    await placed(B, 'pane B (new tab) shown')
    await hiddenSoon(A, 'A behind B')
    await probe('activate', A)
    await placed(A, 'A active again')
    await hiddenSoon(B, 'B behind A')

    // ---- 4. window resize, split and divider ----
    console.log('step 4')
    const size = await a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentSize())
    await a.evaluate(({ BrowserWindow }, s) => { BrowserWindow.getAllWindows()[0]!.setContentSize(s[0]! - 220, s[1]! - 140) }, size)
    await until('the element shrank', async () => (await pane(A)).rect.width < first.info.rect.width - 100)
    const small = await placed(A, 'window smaller')
    assert.ok(small.st.rect!.width < first.st.rect!.width, 'the rectangle shrank with the window')
    await a.evaluate(({ BrowserWindow }, s) => { BrowserWindow.getAllWindows()[0]!.setContentSize(s[0]!, s[1]!) }, size)
    await until('the element grew back', async () => (await pane(A)).rect.width > small.info.rect.width + 100)
    await placed(A, 'window back')
    // A split: B goes to a frame on the right of A's, the divider between them is dragged.
    await probe('close', B)
    const sidC = await probe<string>('open', undefined, { level: 'frame', placement: 'right' })
    const C = (await panes()).find(p => p.surface === sidC)!.id
    const split = await placed(A, 'A beside C')
    await placed(C, 'C beside A')
    const sash = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.desk-grid .dv-sash')].find(s => (s as HTMLElement).getBoundingClientRect().height > 100) as HTMLElement | undefined
      if (!el) return undefined
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    assert.ok(sash, 'a vertical divider exists')
    await page.mouse.move(sash.x, sash.y)
    await page.mouse.down()
    await page.mouse.move(sash.x - 120, sash.y, { steps: 6 })
    await page.mouse.up()
    const dragged = await placed(A, 'A after the divider moved')
    assert.ok(dragged.st.rect!.width < split.st.rect!.width - 50, `the divider moved A's rectangle: ${split.st.rect!.width} -> ${dragged.st.rect!.width}`)
    await placed(C, 'C after the divider moved')
    await probe('close', C)

    // ---- 5. moved to another desk and to the system desk ----
    console.log('step 5')
    await hook('movePaneToDesk', A, d2)
    await hiddenSoon(A, 'moved to the other desk (not the visible one)')
    assert.equal(await wcId(sidA), wcA, 'same webContents after the move')
    await hook('switchDesk', d2)
    const onD2 = await placed(A, 'visible on the second desk')
    assert.equal((await pane(A)).surface, sidA, 'same surface id')
    await hook('movePaneToDesk', A, SYS)
    await hiddenSoon(A, 'moved to the system desk (not active)')
    assert.equal(await wcId(sidA), wcA, 'same webContents after the second move')
    await hook('toggleSystemDesk', SYS)
    const onSys = await placed(A, 'visible on the system desk')
    assert.equal(onSys.info.surface, sidA)
    await hook('toggleSystemDesk', SYS)
    await hiddenSoon(A, 'system desk left')
    assert.ok(onD2.st.rect, 'rectangles were real')

    // ---- 6. the drawer ----
    console.log('step 6')
    await hook('switchDesk', d1)
    const sidD = await probe<string>('open')
    const D = (await panes()).find(p => p.surface === sidD)!.id
    await placed(D, 'D on the desk')
    await hook('movePaneToDrawer', D)
    await hiddenSoon(D, 'D in the closed drawer')
    await hook('openDrawer')
    await placed(D, 'D shown with the drawer open')
    await hook('closeDrawer')
    await hiddenSoon(D, 'drawer closed')
    await probe('close', D)

    // ---- 7. close ----
    console.log('step 7')
    await hook('toggleSystemDesk', SYS)
    await placed(A, 'A on the system desk again')
    await probe('close', A)
    await until('closed pane: the surface is hidden', async () => (await surfaceState(sidA))?.visibility === 'hidden')
    assert.equal((await surfaceState(sidA))?.destroyed, false, 'the surface outlives the pane')
    assert.equal(await wcId(sidA), wcA)
    await a.evaluate((_e, sid) => { (globalThis as unknown as G).__surfaceProbe.surfaces.get(sid)?.destroy() }, sidA)
    await until('webContents let go', async () => (await wcId(sidA)) === undefined)

    // ---- 8. the shield ----
    console.log('step 8')
    const sidE = await probe<string>('open')
    const E = (await panes()).find(p => p.surface === sidE)!.id
    const e = await placed(E, 'E shown')
    await a.evaluate(async (_e, sid) => { await (globalThis as unknown as G).__surfaceProbe.surfaces.get(sid)!.setInputShield(true) }, sidE)
    await a.evaluate(async ({ webContents }, wc) => {
      const shield = webContents.getAllWebContents().find(w => w.getURL().startsWith('data:text/html') && w.id !== wc)!
      shield.sendInputEvent({ type: 'mouseDown', x: 10, y: 20, button: 'left', clickCount: 1 })
      shield.sendInputEvent({ type: 'mouseUp', x: 10, y: 20, button: 'left', clickCount: 1 })
    }, (await wcId(sidE))!)
    const click = await until('shield input in the pane', async () => (await pane(E)).shield.find(i => i.kind === 'down'))
    const host = (await pane(E)).rect
    assert.ok(Math.abs(click.x - (e.st.effective!.x - host.x + 10)) <= 1.5 && Math.abs(click.y - (e.st.effective!.y - host.y + 20)) <= 1.5,
      `shield click in element coordinates: ${JSON.stringify(click)} vs effective ${JSON.stringify(e.st.effective)} host ${JSON.stringify(host)}`)

    // ---- 9. another owner's surface ----
    console.log('step 9')
    await probe('close', E)
    await a.evaluate(async (_e, sid) => { await (globalThis as unknown as G).__surfaceProbe.surfaces.get(sid)!.setInputShield(false) }, sidE)
    await until('E hidden', async () => (await surfaceState(sidE))?.visibility === 'hidden')
    await page.evaluate(sid => window.tether.surfacePlace({ owner: 'note', surface: sid, visible: true, viewportWidth: window.innerWidth, rect: { x: 50, y: 50, width: 300, height: 200 } }), sidE)
    await sleep(600)
    const stolen = await surfaceState(sidE)
    assert.equal(stolen?.visibility, 'hidden', 'another owner cannot show it')
    assert.equal(stolen?.rect?.x === 50 && stolen?.rect?.y === 50, false, 'nor move it')
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
