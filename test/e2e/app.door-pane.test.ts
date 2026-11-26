// E2E of the pane the daemon asks for (agent door, slice R1), with shells only: a tetherd in this process on a private home and
// pipe (the door's SlotPort creates slots with a `desk`), the real app on the same pipe, hidden window. No agent, no LLM.
//   1. a slot created with `desk: desk-2` while the person is on desk-1 gets its pane in desk-2, not active, and nothing
//      switches: same visible desk, same active pane; the daemon is then told the map and clears the request;
//   2. the blank pane of the target desk stays where it is (the new pane is a tab beside it);
//   3. a stale request for a slot that already has a pane in another desk moves nothing and is cleared by the resent map;
//   4. a request for a desk that does not exist makes no pane, and the resent map makes the daemon drop it;
//   5. a request into a hibernated desk: the process runs now, the pane enters asleep (layout asleepPanes + deskSleptPanes);
//   6. close the app, ask a pane while it is closed, open it again: the pane is made on that start.
// Every kill goes through test/kill.ts (pid + creation time); the daemon here is closed in-process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { DisposableStore } from '../../app/shared/vscode-lifecycle.ts'
import { DaemonClient } from '../../src/daemon/client.ts'
import { DoorHost } from '../../src/daemon/door/host.ts'
import type { SlotPort } from '../../src/daemon/door/port.ts'
import type { DoorSlots } from '../../src/daemon/door/types.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { startDaemon } from '../../src/daemon/server.ts'
import { removeHome, tempHome, uniquePipe, waitUntil } from '../unit/daemon.helpers.ts'
import { killElectron } from './electron.ts'

type Layout = { asleepPanes?: string[]; deskSleptPanes?: string[]; desks: { id: string; asleep?: boolean }[] }
type Hooks = {
  panelIds(): string[]
  activeId(): string | undefined
  currentPane(): string | undefined
  slots(): SlotState[]
  connection(): { connected: boolean; pid?: number } | undefined
  desks(): { id: string; name: string; panes: string[] }[]
  activeDesk(): string
  deskOf(slotId: string): string | undefined
  switchDesk(id: string): void
  layout(): Layout
}
declare const window: { __tether: Hooks }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')

/** The door, keeping the SlotPort the daemon hands it: the test uses it to leave a stale request, as a race would. */
class CapturingDoor extends DoorHost {
  captured: SlotPort | undefined
  override attach(port: SlotPort): void { this.captured = port; super.attach(port) }
}

async function launch(home: string, pipe: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

const deskOf = (page: Page, id: string): Promise<string | undefined> => page.evaluate(id => window.__tether.deskOf(id), id)
const hasPane = (page: Page, id: string): Promise<boolean> => page.evaluate(id => window.__tether.panelIds().includes(id), id)

test('door pane: a pane the daemon asks for', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = tempHome()
  const pipe = uniquePipe(home)
  const logs: string[] = []
  const door = new CapturingDoor({ log: m => logs.push(m) })
  const own = new DisposableStore()
  const daemon = await startDaemon({ home, pipe, memoryIntervalMs: 0, readyFallbackMs: 60_000, minAgentAgeMs: 0, door, log: m => logs.push(m) })
  const slots: DoorSlots = door.apiFor('probe', own).slots
  const cwd = root
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, pipe))

    // Two more desks: desk-2 (awake) and desk-3 (hibernated); the person ends on desk-1.
    await page.keyboard.press('Control+Shift+N')
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-2')
    await page.keyboard.press('Control+Shift+N')
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-3')
    await page.click('#desk-switch .seg[data-desk="desk-3"]', { button: 'right' })
    await page.click('#ctx-menu li:has-text("Hibernar mesa")')
    await page.waitForFunction(() => window.__tether.layout().desks.find(d => d.id === 'desk-3')?.asleep === true)
    await page.evaluate(() => window.__tether.switchDesk('desk-1'))
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-1')
    // The first map reaches the daemon with the layout save: the desk ids are known there. The system desks are in the map
    // too (Browser, Regência), so it is the queue's desks that tell the map is the new one.
    await waitUntil(() => ['desk-1', 'desk-2', 'desk-3'].every(id => door.desks.map()?.desks.some(d => d.id === id)), 20_000, 'the desk map reached the daemon')

    const desk2Before = (await page.evaluate(() => window.__tether.desks())).find(d => d.id === 'desk-2')!.panes
    const activeBefore = await page.evaluate(() => ({ active: window.__tether.activeId(), current: window.__tether.currentPane() }))

    // ---- 1 + 2. a pane in desk-2, no switch, not active, the blank pane stays ----
    console.log('step 1')
    const a = await slots.create({ kind: 'shell', cwd, desk: 'desk-2' })
    await page.waitForFunction(id => window.__tether.panelIds().includes(id), a.slotId)
    assert.equal(await deskOf(page, a.slotId), 'desk-2')
    assert.equal(await page.evaluate(() => window.__tether.activeDesk()), 'desk-1', 'the visible desk did not change')
    assert.deepEqual(await page.evaluate(() => ({ active: window.__tether.activeId(), current: window.__tether.currentPane() })), activeBefore, 'the active pane did not change')
    const desk2After = (await page.evaluate(() => window.__tether.desks())).find(d => d.id === 'desk-2')!.panes
    for (const id of desk2Before) assert.ok(desk2After.includes(id), `the pane ${id} of desk-2 is still there`)
    await waitUntil(() => !slotState(a.slotId)?.paneRequest, 20_000, 'the daemon cleared the request')
    assert.equal(door.desks.deskOf(a.slotId)?.id, 'desk-2')
    // Switching to desk-2 later: the new pane is a tab beside, not the one in front.
    await page.evaluate(() => window.__tether.switchDesk('desk-2'))
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-2')
    assert.notEqual(await page.evaluate(() => window.__tether.currentPane()), a.slotId, 'the asked pane was not brought to the front')
    await page.evaluate(() => window.__tether.switchDesk('desk-1'))
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-1')

    // ---- 2b. the pipe's `create { desk }` (a remote client): born in that desk by its name, the person stays put ----
    console.log('step 2b')
    const remote = await DaemonClient.open(pipe, 'test', { home })
    try {
      const deskName = (await page.evaluate(() => window.__tether.desks())).find(d => d.id === 'desk-2')!.name
      const activeNow = await page.evaluate(() => ({ active: window.__tether.activeId(), current: window.__tether.currentPane() }))
      const made = (await remote.request({ t: 'create', kind: 'shell', cwd, desk: deskName })).slot!
      await page.waitForFunction(id => window.__tether.panelIds().includes(id), made.slotId)
      assert.equal(await deskOf(page, made.slotId), 'desk-2')
      assert.equal(await page.evaluate(() => window.__tether.activeDesk()), 'desk-1', 'the visible desk did not change')
      assert.deepEqual(await page.evaluate(() => ({ active: window.__tether.activeId(), current: window.__tether.currentPane() })), activeNow, 'the active pane did not change')
      await waitUntil(() => !slotState(made.slotId)?.paneRequest, 20_000, 'the daemon cleared the remote request')
      // A desk that sleeps is refused with a reason, and no slot is born.
      const count = slots.list().length
      await assert.rejects(remote.request({ t: 'create', kind: 'shell', cwd, desk: 'desk-3' }), /hibernando/)
      assert.equal(slots.list().length, count)
    } finally {
      remote.close()
    }

    // ---- 3. a stale request for a slot that has a pane elsewhere: nothing moves ----
    console.log('step 3')
    const port = door.captured!
    const meta = port.meta(a.slotId)!
    meta.paneRequest = { deskId: 'desk-1' }
    await port.saveMeta(a.slotId)
    port.broadcastState(a.slotId)
    await waitUntil(() => !slotState(a.slotId)?.paneRequest, 20_000, 'the stale request was cleared by a resent map')
    assert.equal(await deskOf(page, a.slotId), 'desk-2', 'the pane did not move')

    // ---- 4. a desk that is not there: no pane, the daemon drops the request ----
    console.log('step 4')
    const ghost = await slots.create({ kind: 'shell', cwd })
    port.meta(ghost.slotId)!.paneRequest = { deskId: 'desk-9' }
    await port.saveMeta(ghost.slotId)
    port.broadcastState(ghost.slotId)
    await waitUntil(() => !slotState(ghost.slotId)?.paneRequest, 20_000, 'the request for a missing desk was dropped')
    assert.equal(await hasPane(page, ghost.slotId), false)

    // ---- 5. a hibernated desk: the process runs, the pane sleeps ----
    console.log('step 5')
    const z = await slots.create({ kind: 'shell', cwd, desk: 'desk-3' })
    await page.waitForFunction(id => window.__tether.panelIds().includes(id), z.slotId)
    assert.equal(await deskOf(page, z.slotId), 'desk-3')
    await waitUntil(() => slotState(z.slotId)?.status === 'running', 30_000, 'the process of the asked pane runs')
    await page.waitForFunction(id => (window.__tether.layout().asleepPanes ?? []).includes(id) && (window.__tether.layout().deskSleptPanes ?? []).includes(id), z.slotId)
    assert.equal(await page.evaluate(() => window.__tether.activeDesk()), 'desk-1')

    // ---- 6. the app is closed; a pane is asked; the app opens and makes it ----
    console.log('step 6')
    await killElectron(app, root)
    app = undefined
    const c = await slots.create({ kind: 'shell', cwd, desk: 'desk-2' })
    assert.deepEqual(slotState(c.slotId)?.paneRequest, { deskId: 'desk-2' })
    ;({ app, page } = await launch(home, pipe))
    await page.waitForFunction(id => window.__tether.panelIds().includes(id), c.slotId)
    assert.equal(await deskOf(page, c.slotId), 'desk-2')
    await waitUntil(() => !slotState(c.slotId)?.paneRequest, 20_000, 'the daemon cleared the request after the restart')
    // The earlier panes came back where they were.
    assert.equal(await deskOf(page, a.slotId), 'desk-2')
    assert.equal(await deskOf(page, z.slotId), 'desk-3')
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    own.dispose()
    await daemon.close()
    await removeHome(home)
  }

  function slotState(slotId: string): SlotState | undefined { return slots.get(slotId) }
})
