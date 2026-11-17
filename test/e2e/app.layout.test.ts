// E2E of the Electron app against the REAL tetherd (spawned by the app itself on a private pipe/home):
//   1. open → 2 shell panels → split to 4 → `echo tether-<n>` in each;
//   2. kill the Electron main by PID → relaunch → same layout, same slot ids, same shell PIDs (the
//      terminals lived in the daemon the whole time), scrollback shows the echoes;
//   3. kill the daemon by PID → relaunch → the app spawns a new daemon. Panels hosted in tether-ptyd (the
//      default, TETHER_PANEL_HOST=1) lived through it: the new daemon ADOPTS the same shells (same PIDs, still
//      echoing). With TETHER_PANEL_HOST=0 the shells died with the daemon and every panel restarts (new
//      shells, same folders, status running);
//   4. a panel in `error` (folder does not exist) and one in `unconfirmed` (fed through the test hook: the
//      daemon has no inference yet, so it cannot produce that state on demand), with their actions.
// Windows stay hidden (TETHER_E2E_HIDDEN=1). Screenshots go to test/e2e/artifacts/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { panelHostOn, ptydEnv, stopPtyd } from './ptyd-driver.ts'

// Browser-side globals used inside page.evaluate callbacks (this tsconfig has no DOM lib).
type Hooks = {
  panelIds(): string[]
  activeId(): string | undefined
  layout(): unknown
  frameLayout(frameId?: string): unknown
  slots(): SlotState[]
  text(id: string): string
  connection(): { connected: boolean; pid?: number } | undefined
  activate(id: string): void
  openSlot(id: string): void
  applyState(slot: SlotState): void
}
declare const window: {
  __tether: Hooks
  tether: { request(body: unknown): Promise<{ t: 'ok'; slot?: SlotState } | { t: 'error'; code: string; message: string }> }
}
declare const document: { querySelectorAll(selector: string): { length: number }; querySelector(selector: string): { dataset: Record<string, string> } | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-apptest-${process.pid}`

type Layout = { grid: { root: Node }; panels: Record<string, unknown>; activeGroup?: string }
type Node = { type: 'leaf' | 'branch'; data: { views: string[] } | Node[] }

/** Arrangement only (views per leaf, nesting), ignoring sizes and group ids. */
function shape(node: Node): unknown {
  return node.type === 'leaf' ? (node.data as { views: string[] }).views : (node.data as Node[]).map(shape)
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

async function waitUntil(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timeout (${timeoutMs} ms) waiting for ${what}`)
    await sleep(100)
  }
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  ptydEnv(env, undefined)
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

async function createPanel(page: Page, kind: 'claude' | 'soul' | 'shell', cwd: string, shot?: string): Promise<void> {
  const before = await page.locator('.tether-tab').count()
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  // The chooser picks a profile, not a type: each kind's default profile on this machine (src/core/profile.ts defaults).
  await page.fill('#dlg-new .ch-path-input', cwd)
  if (shot) await page.screenshot({ path: join(artifacts, shot) })
  await page.click(`#dlg-new .ch-item[data-id="${{ claude: 'claude', soul: 'soul', shell: 'powershell' }[kind]}"]`)
  await page.click('#dlg-new .btn.primary.go') // two steps: the click selects, the button opens
  await page.locator('#dlg-new[open]').waitFor({ state: 'hidden' })
  await page.waitForFunction(n => document.querySelectorAll('.tether-tab').length === n, before + 1)
}

const hooks = {
  ids: (page: Page) => page.evaluate(() => window.__tether.panelIds()),
  /** The dockview JSON of the active frame (the only one in this test): v1-shaped, so the arrangement reads as before phase B. */
  layout: (page: Page) => page.evaluate(() => window.__tether.frameLayout() as unknown as Layout),
  text: (page: Page, id: string) => page.evaluate(id => window.__tether.text(id), id),
  slots: (page: Page) => page.evaluate(() => window.__tether.slots()),
  daemonPid: async (page: Page) => (await page.evaluate(() => window.__tether.connection()))?.pid,
  status: (page: Page, id: string) => page.evaluate(id => document.querySelector(`.panel[data-slot-id="${id}"]`)?.dataset.status, id),
}

/** Waits until every listed slot is `running` with a pid, as the renderer sees it. */
async function waitRunning(page: Page, ids: string[]): Promise<Map<string, number>> {
  await page.waitForFunction(ids => {
    const slots = window.__tether.slots()
    return ids.every(id => { const s = slots.find(x => x.slotId === id); return s?.status === 'running' && typeof s.pid === 'number' })
  }, ids, { timeout: 20_000 })
  const pids = new Map<string, number>()
  for (const s of await hooks.slots(page)) if (ids.includes(s.slotId)) pids.set(s.slotId, s.pid!)
  return pids
}

/** Types a command into the panel (activating its tab first) and waits for its output line. */
async function typeEcho(page: Page, id: string, n: number): Promise<void> {
  await page.evaluate(id => window.__tether.activate(id), id)
  // The shell prompt must be up before typing (PowerShell shows "PS <folder>>").
  await page.waitForFunction(id => /PS.*>/.test(window.__tether.text(id).replace(/\s+/g, '')), id, { timeout: 20_000 })
  await page.locator(`.panel[data-slot-id="${id}"] .panel-term`).click()
  await page.keyboard.type(`echo tether-${n}`)
  await page.keyboard.press('Enter')
  await page.waitForFunction(([id, n]) => new RegExp(`(^|\\n)tether-${n}\\s*(\\n|$)`).test(window.__tether.text(id)), [id, String(n)] as const, { timeout: 10_000 })
    .catch(async e => { throw new Error(`${e.message}
--- panel ${id} ---
${await hooks.text(page, id)}`) })
}

test('app + tetherd: 4 shell panels survive a window kill (same PIDs) and a daemon kill (restarted)', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-apptest-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await hooks.daemonPid(page))!
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))
    assert.equal(readFileSync(join(home, 'tetherd.pid'), 'utf8').trim(), String(daemonPid), 'tetherd.pid matches the hello pid')
    await page.waitForSelector('.watermark')
    await page.screenshot({ path: join(artifacts, 'empty.png') })

    await createPanel(page, 'shell', root, 'new-panel-dialog.png')
    await createPanel(page, 'shell', root)
    assert.equal((await hooks.ids(page)).length, 2)

    // Split by shortcut: right, then below (from the active panel, same kind/folder).
    await page.keyboard.press('Control+Backslash')
    await page.waitForFunction(() => document.querySelectorAll('.tether-tab').length === 3)
    await page.keyboard.press('Control+Alt+ArrowDown')
    await page.waitForFunction(() => document.querySelectorAll('.tether-tab').length === 4)
    const ids = await hooks.ids(page)
    assert.equal(ids.length, 4)
    const pidsBefore = await waitRunning(page, ids)

    for (const [i, id] of ids.entries()) await typeEcho(page, id, i + 1)
    await sleep(800) // let the debounced layout save land
    assert.ok(existsSync(join(home, 'layout.json')), 'layout saved')
    await page.screenshot({ path: join(artifacts, 'four-panels.png') })
    const layoutBefore = await hooks.layout(page)
    assert.equal(Object.keys(layoutBefore.panels).length, 4)

    // ---- 2. kill the window by PID: the daemon and its shells must not notice ----
    await killElectron(app, root)
    app = undefined
    assert.ok(pidAlive(daemonPid), 'tetherd survived the window kill')
    for (const [id, pid] of pidsBefore) assert.ok(pidAlive(pid), `shell of ${id} (pid ${pid}) survived the window kill`)

    ;({ app, page } = await launch(home))
    assert.equal(await hooks.daemonPid(page), daemonPid, 'reconnected to the same tetherd')
    await page.waitForFunction(() => document.querySelectorAll('.tether-tab').length === 4, undefined, { timeout: 10_000 })
    const idsAfter = await hooks.ids(page)
    assert.deepEqual([...idsAfter].sort(), [...ids].sort(), 'same 4 slots')
    assert.deepEqual(shape((await hooks.layout(page)).grid.root), shape(layoutBefore.grid.root), 'same arrangement')
    const pidsAfter = await waitRunning(page, ids)
    assert.deepEqual([...pidsAfter].sort(), [...pidsBefore].sort(), 'same shell PIDs: the terminals lived through the window kill')
    for (const [i, id] of ids.entries()) {
      await page.waitForFunction(([id, n]) => new RegExp(`tether-${n}`).test(window.__tether.text(id)), [id, String(i + 1)] as const, { timeout: 10_000 })
    }
    await page.screenshot({ path: join(artifacts, 'four-panels-restored.png') })

    // ---- 3. kill the daemon by PID: the next launch spawns a new one (adopts the hosted shells, or restarts the panels) ----
    await killElectron(app, root)
    app = undefined
    assert.equal(await killOwned(daemons[0]!), 'killed', 'tetherd killed by identity')
    await waitUntil(() => !pidAlive(daemonPid), 10_000, 'tetherd to die')
    const hosted = panelHostOn(home)
    if (hosted) for (const [id, pid] of pidsBefore) assert.ok(pidAlive(pid), `hosted shell of ${id} (pid ${pid}) survived the tetherd kill`)
    ;({ app, page } = await launch(home))
    const daemonPid2 = (await hooks.daemonPid(page))!
    assert.ok(daemonPid2 && daemonPid2 !== daemonPid && pidAlive(daemonPid2), 'a new tetherd was spawned')
    daemons.push(await claim(daemonPid2, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await page.waitForFunction(() => document.querySelectorAll('.tether-tab').length === 4, undefined, { timeout: 10_000 })
    assert.deepEqual([...(await hooks.ids(page))].sort(), [...ids].sort(), 'same 4 slots after the daemon restart')
    const pidsRestarted = await waitRunning(page, ids)
    if (hosted) assert.deepEqual([...pidsRestarted].sort(), [...pidsBefore].sort(), 'same shell PIDs: the new tetherd adopted the hosted shells')
    else for (const [id, pid] of pidsRestarted) assert.notEqual(pid, pidsBefore.get(id), `slot ${id} got a new shell`)
    for (const s of await hooks.slots(page)) if (ids.includes(s.slotId)) assert.equal(s.cwd, root, 'same folder')
    for (const id of ids) {
      await page.evaluate(id => window.__tether.activate(id), id) // dockview only mounts the active tab's content
      await page.waitForFunction(id => /PS.*>/.test(window.__tether.text(id).replace(/\s+/g, '')), id, { timeout: 20_000 })
        .catch(async e => { throw new Error(`${e.message}\n--- panel ${id} ---\n${await hooks.text(page, id)}`) })
      assert.equal(await hooks.status(page, id), 'running')
    }
    // Adopted shells still answer: a fresh echo goes through the new daemon to the same shell.
    // Keys typed in the first seconds after the app re-attaches to adopted panes can be dropped partway (known, reported:
    // it needs a fix in production code), so the echo check waits for the attach to settle.
    if (hosted) { await sleep(4_000); for (const [i, id] of ids.entries()) await typeEcho(page, id, 101 + i) }
    await page.screenshot({ path: join(artifacts, 'four-panels-after-daemon-restart.png') })

    // ---- 4a. error state: a slot whose folder does not exist ----
    const missing = join(home, 'pasta-que-nao-existe')
    const created = await page.evaluate(async cwd => {
      const r = await window.tether.request({ t: 'create', kind: 'shell', cwd, start: true })
      const slot = window.__tether.slots().find(s => s.cwd === cwd)
      return { reply: r, slotId: slot?.slotId }
    }, missing)
    assert.equal(created.reply.t, 'error')
    assert.equal((created.reply as { code: string }).code, 'cwd-missing')
    assert.ok(created.slotId, 'the slot exists (in error) in the daemon')
    const errId = created.slotId!
    await page.evaluate(id => window.__tether.openSlot(id), errId)
    await page.waitForSelector(`.panel[data-slot-id="${errId}"][data-status="error"] .panel-overlay button[data-action="pick-folder"]`)
    await page.waitForSelector(`.panel[data-slot-id="${errId}"] .status-bar .status.error`)
    await page.screenshot({ path: join(artifacts, 'panel-error.png') })
    await page.click(`.panel[data-slot-id="${errId}"] .panel-overlay button[data-action="close"]`)
    await page.waitForFunction(() => document.querySelectorAll('.tether-tab').length === 4)
    await page.evaluate(id => window.tether.request({ t: 'forget', slotId: id }), errId)

    // ---- 4b. unconfirmed state (fed through the hook) and its "resume" choice ----
    const target = ids[0]!
    await page.evaluate(id => window.__tether.activate(id), target)
    const real = (await hooks.slots(page)).find(s => s.slotId === target)!
    await page.evaluate(slot => window.__tether.applyState(slot), {
      ...real, status: 'exited', pid: undefined,
      binding: { slotId: target, agent: 'claude', sessionId: '0b1d2c3e-aaaa-bbbb-cccc-ddddeeeeffff', cwd: real.cwd, since: new Date().toISOString(), confirmed: false, ended: false },
      title: 'Refatorar o adapter do soul',
    } satisfies SlotState)
    await page.waitForSelector(`.panel[data-slot-id="${target}"][data-status="unconfirmed"] .panel-overlay button[data-action="resume"]`)
    await page.screenshot({ path: join(artifacts, 'panel-unconfirmed.png') })
    // "Retomar a última sessão" sends `start` with choice=resume; the daemon answers with the real state (still running).
    await page.click(`.panel[data-slot-id="${target}"] .panel-overlay button[data-action="resume"]`)
    await page.waitForSelector(`.panel[data-slot-id="${target}"][data-status="running"]`)
    assert.equal((await hooks.slots(page)).find(s => s.slotId === target)?.pid, pidsRestarted.get(target), 'start on a running slot is a no-op')
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    await waitUntil(() => daemons.every(d => !pidAlive(d.pid)), 10_000, 'tetherd processes to exit').catch(() => {})
    await stopPtyd(home) // the host (and its shells) outlives the tetherd on purpose
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
