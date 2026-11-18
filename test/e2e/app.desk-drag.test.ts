// E2E of reordering desks by dragging a segment of the capsule (Pointer Events), hidden window, private home/pipe,
// real tetherd, no shells needed. Real mouse drags (page.mouse):
//   1. M1..M4, M4 active: M4's segment dragged onto M1's centre → M4, M1, M2, M3; M4 stays active; layout.json agrees;
//   2. a plain click still switches desks; a double click still opens the rename box (Esc closes it);
//   3. a drag cancelled with Escape before the release changes nothing (and the release does not switch desks);
//   4. a drag shorter than the 4 px threshold changes nothing and the click switches desks;
//   5. Ctrl+1 goes to the desk that is now first;
//   6. Shift+→ on the focused segment moves the desk;
//   7. with the "+N" showing (10 desks at 900 px) a visible desk dropped after another visible one sits right after it
//      in the full queue (layout.json);
//   8. window kill + relaunch: the order persists.
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
import { stopPtyd } from './ptyd-driver.ts'

type Hooks = {
  desks(): { id: string; name: string }[]
  activeDesk(): string
  switchDesk(id: string): void
  createDesk(where: 'after' | 'before', id: string): string
  renameDesk(id: string, name: string): void
  switchState(): { visible: string[]; hidden: string[]; active: string }
  connection(): { connected: boolean; pid?: number } | undefined
}
declare const window: { __tether: Hooks; innerWidth: number }
declare const document: { querySelectorAll(selector: string): Iterable<{ dataset: Record<string, string> }> }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-desk-drag-${process.pid}`

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

/** The capsule's segments in DOM order, as desk ids. */
const domOrder = (page: Page): Promise<string[]> => page.evaluate(() => [...document.querySelectorAll('#desk-switch .seg[data-desk]')].map(s => s.dataset.desk!))
const activeSeg = (page: Page): Promise<string | undefined> => page.evaluate(() => [...document.querySelectorAll('#desk-switch .seg.on[data-desk]')].map(s => s.dataset.desk!)[0])
const seg = (id: string): string => `#desk-switch .seg[data-desk="${id}"]`
function savedOrder(home: string): { ids: string[]; names: string[] } {
  const f = JSON.parse(readFileSync(join(home, 'layout.json'), 'utf8')) as { desks: { id: string; name: string }[] }
  return { ids: f.desks.map(d => d.id), names: f.desks.map(d => d.name) }
}
/** layout.json is saved debounced: waits until it holds `ids` in this order. */
async function waitSaved(home: string, ids: string[]): Promise<void> {
  const deadline = Date.now() + 6000
  let last: string[] = []
  while (Date.now() < deadline) {
    try { last = savedOrder(home).ids; if (JSON.stringify(last) === JSON.stringify(ids)) return } catch { /* being written */ }
    await sleep(150)
  }
  assert.deepEqual(last, ids, 'layout.json order')
}
async function waitDom(page: Page, ids: string[]): Promise<void> {
  await page.waitForFunction(ids => JSON.stringify([...document.querySelectorAll('#desk-switch .seg[data-desk]')].map(s => s.dataset.desk)) === JSON.stringify(ids), ids)
}

type Pt = { x: number; y: number }
async function center(page: Page, selector: string): Promise<Pt> {
  const r = await page.locator(selector).boundingBox()
  assert.ok(r, `nothing at ${selector}`)
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
}
/** Pointer press, past the threshold, then to the target in steps. Returns before the release. */
async function dragTo(page: Page, from: Pt, to: Pt): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + (to.x < from.x ? -8 : 8), from.y, { steps: 3 })
  // A few px past the target's centre: the dragged centre must cross it (a tie does not).
  await page.mouse.move(to.x + (to.x < from.x ? -6 : 6), to.y, { steps: 15 })
  await sleep(150)
}
async function drag(page: Page, from: Pt, to: Pt, shot?: string): Promise<void> {
  await dragTo(page, from, to)
  if (shot) await page.screenshot({ path: shot })
  await page.mouse.up()
  await sleep(500) // the move, the FLIP and the debounced save
}

test('desk drag: reorder by dragging a capsule segment, cancel, threshold, keyboard, "+N", relaunch', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-desk-drag-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // ---- 1. M1..M4, M4 active; M4 dragged onto M1 ----
    console.log('step 1')
    const ids = await page.evaluate(() => {
      const t = window.__tether
      const out = [t.desks()[0]!.id]
      for (let i = 1; i < 4; i++) out.push(t.createDesk('after', out[i - 1]!))
      out.forEach((id, i) => t.renameDesk(id, `M${i + 1}`))
      t.switchDesk(out[3]!)
      return out
    })
    const [m1, m2, m3, m4] = ids as [string, string, string, string]
    await waitDom(page, [m1, m2, m3, m4])
    await page.waitForSelector(`${seg(m4)}.on`)
    assert.equal(await page.locator(`${seg(m4)} .seg-name`).innerText(), 'M4')
    await drag(page, await center(page, seg(m4)), await center(page, seg(m1)), join(artifacts, 'desk-drag-live.png'))
    await waitDom(page, [m4, m1, m2, m3])
    assert.equal(await activeSeg(page), m4, 'M4 stays active')
    assert.equal(await page.locator('#desk-switch .seg.dragging').count(), 0, 'dragging class gone')
    assert.equal(await page.locator('#desk-switch .drag-live').count(), 0, 'drag-live class gone')
    assert.equal(await page.evaluate(() => window.__tether.activeDesk()), m4)
    await waitSaved(home, [m4, m1, m2, m3])
    assert.deepEqual(savedOrder(home).names, ['M4', 'M1', 'M2', 'M3'])
    await page.screenshot({ path: join(artifacts, 'desk-drag-done.png') })

    // ---- 2. click switches, double click renames ----
    console.log('step 2')
    await page.click(seg(m2))
    await page.waitForFunction(id => window.__tether.activeDesk() === id, m2)
    await page.dblclick(seg(m3))
    await page.waitForSelector('#desk-switch input.desk-rename')
    await page.keyboard.press('Escape')
    await page.waitForSelector('#desk-switch input.desk-rename', { state: 'detached' })
    assert.equal(await page.locator(`${seg(m3)} .seg-name`).innerText(), 'M3', 'Esc kept the name')
    assert.deepEqual(await domOrder(page), [m4, m1, m2, m3])

    // ---- 3. Escape before the release ----
    console.log('step 3')
    await page.click(seg(m1))
    await page.waitForFunction(id => window.__tether.activeDesk() === id, m1)
    await dragTo(page, await center(page, seg(m3)), await center(page, seg(m4)))
    assert.equal(await page.locator('#desk-switch .seg.dragging').count(), 1, 'the drag is live')
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await sleep(500)
    assert.deepEqual(await domOrder(page), [m4, m1, m2, m3], 'order unchanged after Esc')
    assert.equal(await page.locator('#desk-switch .seg.dragging, #desk-switch .drag-live').count(), 0)
    assert.equal(await activeSeg(page), m1, 'the release after Esc does not switch desks')
    assert.equal(await page.evaluate(() => window.__tether.activeDesk()), m1)
    assert.deepEqual(savedOrder(home).ids, [m4, m1, m2, m3])

    // ---- 4. under the threshold ----
    console.log('step 4')
    const c2 = await center(page, seg(m2))
    await page.mouse.move(c2.x, c2.y)
    await page.mouse.down()
    await page.mouse.move(c2.x + 3, c2.y, { steps: 3 })
    await page.mouse.up()
    await sleep(400)
    assert.deepEqual(await domOrder(page), [m4, m1, m2, m3], 'nothing moved')
    await page.waitForFunction(id => window.__tether.activeDesk() === id, m2)

    // ---- 5. Ctrl+1 → the first desk ----
    console.log('step 5')
    await page.keyboard.press('Control+1')
    await page.waitForFunction(id => window.__tether.activeDesk() === id, m4)

    // ---- 6. Shift+→ on the focused segment ----
    console.log('step 6')
    await page.focus(`${seg(m4)}.on`)
    await page.keyboard.press('Shift+ArrowRight')
    await waitDom(page, [m1, m4, m2, m3])
    await waitSaved(home, [m1, m4, m2, m3])
    assert.equal(await activeSeg(page), m4)

    // ---- 7. "+N": 10 desks at 900 px ----
    console.log('step 7')
    await page.evaluate(() => { const t = window.__tether; for (let i = 0; i < 6; i++) { const all = t.desks(); t.createDesk('after', all[all.length - 1]!.id) } })
    await page.evaluate(id => window.__tether.switchDesk(id), m4)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(900, 800))
    await page.waitForFunction(() => Math.abs(window.innerWidth - 900) <= 2)
    await sleep(500)
    const st = await page.evaluate(() => window.__tether.switchState())
    assert.ok(st.hidden.length > 0, `"+N" at 900 px: ${JSON.stringify(st)}`)
    const vis = await domOrder(page)
    assert.ok(vis.length >= 3, `at least three visible: ${vis.join(',')}`)
    await waitSaved(home, (await page.evaluate(() => window.__tether.desks())).map(d => d.id))
    console.log(`visible ${vis.join(',')}; full ${savedOrder(home).ids.join(',')}; hidden ${st.hidden.join(',')}`)
    const mover = vis[0]!, target = vis[2]!
    await drag(page, await center(page, seg(mover)), await center(page, seg(target)))
    const after = await domOrder(page)
    const k = after.indexOf(mover)
    assert.ok(k > 0, `the moved desk is no longer first: ${after.join(',')}`)
    const left = after[k - 1]!
    const deadline = Date.now() + 6000
    let fullAfter: string[] = []
    while (Date.now() < deadline) {
      try { fullAfter = savedOrder(home).ids } catch { /* being written */ }
      if (fullAfter.indexOf(mover) === fullAfter.indexOf(left) + 1) break
      await sleep(150)
    }
    assert.equal(fullAfter.indexOf(mover), fullAfter.indexOf(left) + 1, `"${mover}" sits right after its visible left neighbour "${left}": ${fullAfter.join(',')}`)
    assert.equal(fullAfter.length, 10)
    await page.screenshot({ path: join(artifacts, 'desk-drag-more.png') })

    // ---- 8. relaunch ----
    console.log('step 8')
    await sleep(800)
    const orderBefore = savedOrder(home)
    await killElectron(app, root)
    app = undefined
    ;({ app, page } = await launch(home))
    await page.waitForFunction(n => window.__tether.desks().length === n, 10)
    assert.deepEqual((await page.evaluate(() => window.__tether.desks())).map(d => d.id), orderBefore.ids, 'the order came back')
    assert.deepEqual(savedOrder(home).ids, orderBefore.ids)
  } finally {
    console.log('teardown')
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    await stopPtyd(home)
    for (let i = 0; i < 20 && daemons.some(d => pidAlive(d.pid)); i++) await sleep(500)
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
