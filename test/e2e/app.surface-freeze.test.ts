// E2E of the surface freeze (design §2.3, §12b rules 6–8; app/shared/freeze-rules.ts, app/renderer/overlay-freeze.ts,
// app/renderer/surface-host.ts, app/main/surface-bridge.ts), with the probe extension (test/e2e/fixtures/surface-probe):
// a pane tied to a surface whose page counts frames. Hidden window, private home/pipe, real tetherd, CLAUDE* stripped.
//   1. the palette open: a picture on the effective rectangle and the surface parked; the page keeps counting; closed:
//      shown again and the picture gone;
//   2. the ≡ menu, a modal dialog, an extension's own freezeWhile: the same;
//   3. nested (menu + extension hold): only the last release thaws;
//   4. open-and-close fast (ten times, no wait): no picture left, the surface shown;
//   5. a passing notice (role=status, the chord pill's kind of element) does not freeze;
//   6. the drawer open: the desk's surface freezes, the drawer's own stays shown;
//   7. a tab drag: frozen while the drag is on, back after the drop;
//   8. a picture left behind (the main side made to fail the thaw): a click on it restores;
//   9. the freeze and thaw times (logged for the report).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { SurfaceState, TetherMain } from '../../app/main/ext-api.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

interface Rect { x: number; y: number; width: number; height: number }
interface PaneInfo { id: string; surface: string; rect: Rect; state: { visibility: string; effective?: Rect; scale: number } | undefined }
type Probe = 'open' | 'panes' | 'close' | 'freezeWhile' | 'unfreeze'
type Freeze = { reasons: string[]; pictures: number; timings: { surface: string; freezeMs?: number; thawMs?: number }[] }
type Hooks = {
  connection(): { connected: boolean; pid?: number } | undefined
  movePaneToDrawer(id: string): void
  openDrawer(): void
  closeDrawer(): void
  freeze(): Freeze
  palette(): { open: boolean }
  ext: Record<string, unknown>
}
type G = { __surfaceProbe: TetherMain }
declare const window: { __tether: Hooks }
declare const document: {
  querySelector(s: string): { getBoundingClientRect(): Rect; showModal(): void; close(): void; remove(): void; parentElement: { getBoundingClientRect(): Rect } } | null
  querySelectorAll(s: string): ArrayLike<{ textContent: string | null; getBoundingClientRect(): Rect }>
  createElement(t: string): { setAttribute(k: string, v: string): void; textContent: string; style: { cssText: string }; remove(): void }
  body: { appendChild(e: unknown): void }
}

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-surface-freeze-${process.pid}`

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
    await sleep(50)
  }
  throw new Error(`timeout: ${what}${last ? ` (${(last as Error).message})` : ''}`)
}

const near = (a: Rect | undefined, b: Rect | undefined, tol = 1.5): boolean => !!a && !!b && (['x', 'y', 'width', 'height'] as const).every(k => Math.abs(a[k] - b[k]) <= tol)

test('surface freeze: overlays swap the shown surfaces for their picture and park them; notices never do', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-surface-freeze-'))
  const pagePath = join(home, 'page.html')
  // The page counts animation frames and timer ticks: alive while frozen means the timer counter advances.
  writeFileSync(pagePath, '<!doctype html><html><body style="margin:0;background:#2a4"><div id="n" style="font:40px sans-serif;color:#fff;padding:20px">0</div>'
    + '<script>window.ticks=0;setInterval(()=>{window.ticks++;document.getElementById("n").textContent=String(window.ticks)},20)</script></body></html>')
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, pagePath))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const a = app

    const probe = <T>(name: Probe, ...args: unknown[]): Promise<T> =>
      page.evaluate(({ name, args }) => ((window.__tether.ext['surface-probe'] as Record<string, (...x: unknown[]) => unknown>)[name]!(...args)) as never, { name, args })
    const pane = async (id: string): Promise<PaneInfo> => (await probe<PaneInfo[]>('panes')).find(p => p.id === id)!
    const surfaceState = (sid: string): Promise<SurfaceState | undefined> => a.evaluate((_e, sid) => (globalThis as unknown as G).__surfaceProbe.surfaces.get(sid)?.state(), sid)
    const ticks = (sid: string): Promise<number> => a.evaluate((_e, sid) => (globalThis as unknown as G).__surfaceProbe.surfaces.get(sid)!.webContents.executeJavaScript('window.ticks'), sid) as Promise<number>
    const freeze = (): Promise<Freeze> => page.evaluate(() => window.__tether.freeze())
    /** The picture of `sid` in the page, in viewport px, or undefined. */
    const picture = (sid: string): Promise<Rect | undefined> => page.evaluate(s => {
      const img = document.querySelector(`img[data-surface-freeze="${s}"]`)
      if (!img) return undefined
      const r = img.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    }, sid)

    const shown = (id: string, why: string): Promise<SurfaceState> => until(why, async () => {
      const info = await pane(id)
      const st = await surfaceState(info.surface)
      return st && st.visibility === 'shown' && near(st.rect, info.rect) && (await picture(info.surface)) === undefined ? st : false
    })
    /** Frozen: parked, and the picture sits on the effective rectangle (window px; no interface zoom in the test). */
    const frozen = async (id: string, why: string): Promise<{ st: SurfaceState; pic: Rect }> => {
      let seen = ''
      try {
        return await until(why, async () => {
          const info = await pane(id)
          const st = await surfaceState(info.surface)
          const pic = await picture(info.surface)
          seen = JSON.stringify({ vis: st?.visibility, eff: st?.effective, pic, freeze: await freeze() })
          return st && st.visibility === 'parked' && pic && near(pic, st.effective, 1.5) ? { st, pic } : false
        })
      } catch (e) { throw new Error(`${(e as Error).message}; last seen ${seen}`) }
    }
    const thawed = async (id: string, why: string): Promise<void> => {
      await shown(id, why)
      assert.equal((await freeze()).pictures, 0, `${why}: no picture left`)
    }

    // ---- 1. the palette ----
    console.log('step 1: palette')
    const sidA = await probe<string>('open')
    const A = (await probe<PaneInfo[]>('panes')).find(p => p.surface === sidA)!.id
    await shown(A, 'A shown')
    await sleep(300)
    await page.keyboard.press('Control+Shift+P')
    await page.waitForFunction(() => window.__tether.palette().open)
    const f1 = await frozen(A, 'palette: A frozen')
    assert.ok((await freeze()).reasons.includes('dialog'), 'the palette holds the signal as a modal dialog')
    const t0 = await ticks(sidA)
    await sleep(400)
    const t1 = await ticks(sidA)
    assert.ok(t1 > t0 + 3, `the page is alive while frozen: ${t0} -> ${t1}`)
    assert.ok(f1.pic.width > 100 && f1.pic.height > 60, 'a real picture')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !window.__tether.palette().open)
    await thawed(A, 'palette closed: A back')
    assert.deepEqual((await freeze()).reasons, [])

    // ---- 2. the ≡ menu, a modal dialog, the extension's own hold ----
    console.log('step 2: menu, dialog, extension')
    await page.click('#btn-menu')
    await frozen(A, 'menu: A frozen')
    assert.ok((await freeze()).reasons.includes('menu'))
    await page.keyboard.press('Escape')
    await thawed(A, 'menu closed')
    await page.evaluate(() => document.querySelector('#dlg-term-theme')!.showModal())
    await frozen(A, 'modal dialog: A frozen')
    await page.evaluate(() => document.querySelector('#dlg-term-theme')!.close())
    await thawed(A, 'dialog closed')
    const h1 = await probe<number>('freezeWhile', 'upload')
    await frozen(A, 'extension hold: A frozen')
    assert.ok((await freeze()).reasons.some(r => r.endsWith(':upload')), 'the reason carries the extension id')
    await probe('unfreeze', h1)
    await thawed(A, 'extension hold released')

    // ---- 3. nested ----
    console.log('step 3: nested')
    const h2 = await probe<number>('freezeWhile', 'outer')
    await frozen(A, 'outer hold')
    await page.click('#btn-menu')
    await until('two holds', async () => (await freeze()).reasons.length === 2)
    await page.keyboard.press('Escape')
    await until('menu let go', async () => (await freeze()).reasons.length === 1)
    await sleep(300)
    await frozen(A, 'still frozen under the outer hold')
    await probe('unfreeze', h2)
    await thawed(A, 'last hold released')

    // ---- 4. open-and-close fast ----
    console.log('step 4: fast')
    for (let i = 0; i < 10; i++) {
      const h = await probe<number>('freezeWhile', 'blink')
      if (i % 2) await sleep(15)
      await probe('unfreeze', h)
    }
    await sleep(800)
    await thawed(A, 'after ten fast blinks')

    // ---- 5. a passing notice does not freeze ----
    console.log('step 5: notice')
    await page.evaluate(() => {
      const n = document.createElement('div')
      n.setAttribute('role', 'status')
      n.setAttribute('id', 'test-notice')
      n.textContent = 'Arquivo salvo'
      n.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9999;padding:8px;background:#333;color:#fff'
      document.body.appendChild(n)
    })
    await sleep(500)
    assert.equal((await surfaceState(sidA))?.visibility, 'shown', 'a notice leaves the surface shown')
    assert.deepEqual((await freeze()).reasons, [], 'and holds nothing')
    await page.evaluate(() => document.querySelector('#test-notice')!.remove())

    // ---- 6. the drawer ----
    console.log('step 6: drawer')
    const sidD = await probe<string>('open', undefined, { level: 'frame', placement: 'right' })
    const D = (await probe<PaneInfo[]>('panes')).find(p => p.surface === sidD)!.id
    await shown(D, 'D shown on the desk')
    await page.evaluate(id => window.__tether.movePaneToDrawer(id), D)
    await until('D hidden in the closed drawer', async () => (await surfaceState(sidD))?.visibility === 'hidden')
    await shown(A, 'A shown again')
    await page.evaluate(() => window.__tether.openDrawer())
    await frozen(A, 'drawer open: the desk surface frozen')
    await shown(D, 'drawer open: its own surface alive')
    assert.deepEqual((await freeze()).reasons, ['drawer'])
    await page.evaluate(() => window.__tether.closeDrawer())
    await thawed(A, 'drawer closed: A back')
    await until('D hidden again', async () => (await surfaceState(sidD))?.visibility === 'hidden')
    await probe('close', D)

    // ---- 7. a tab drag ----
    console.log('step 7: drag')
    // The probe's own tab does not start an HTML5 drag under Playwright here (no dragstart reaches the document), so the
    // drag is the one dockview's tabs fire: dragstart on the tab, dragend at the end. The real mouse drags of tabs and frames
    // are app.frame-drag's; this checks the freeze follows the drag.
    await page.evaluate(() => {
      const t = [...(document.querySelectorAll('.dv-tab') as unknown as { textContent: string | null; dispatchEvent(e: unknown): void }[])].find(e => (e.textContent ?? '').includes('Superfície'))!
      ;(window as unknown as { __tab: unknown }).__tab = t
      t.dispatchEvent(new (globalThis as unknown as { DragEvent: new (t: string, o: object) => unknown }).DragEvent('dragstart', { bubbles: true }))
    })
    await frozen(A, 'dragging: A frozen')
    assert.ok((await freeze()).reasons.includes('drag'))
    await page.evaluate(() => { (window as unknown as { __tab: { dispatchEvent(e: unknown): void } }).__tab.dispatchEvent(new (globalThis as unknown as { DragEvent: new (t: string, o: object) => unknown }).DragEvent('dragend', { bubbles: true })) })
    await thawed(A, 'drag over: A back')

    // ---- 9. times (logged before step 8, whose thaw never answers) ----
    console.log(`freeze timings: ${JSON.stringify((await freeze()).timings)}`)

    // ---- 8. a picture left behind: a click restores ----
    console.log('step 8: stuck picture')
    // The main side made to never answer the thaw: the picture would stay; the click on it is the way out.
    await a.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('surface:freeze')
      ipcMain.handle('surface:freeze', (_e, raw: { frozen?: boolean }) => (raw?.frozen ? true : new Promise(() => {})))
    })
    const h3 = await probe<number>('freezeWhile', 'stuck')
    await until('picture up', async () => (await picture(sidA)) !== undefined)
    await probe('unfreeze', h3)
    await sleep(300)
    const stuck = await picture(sidA)
    assert.ok(stuck, 'the picture is stuck (the thaw never answers)')
    await page.mouse.click(stuck.x + stuck.width / 2, stuck.y + stuck.height / 2)
    await until('the click took the picture off', async () => (await picture(sidA)) === undefined, 1_500)
    assert.equal((await freeze()).pictures, 0)
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
