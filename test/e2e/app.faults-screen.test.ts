// E2E of the "Falhas" screen (extensions/faults) on a private TETHER_HOME and TETHER_USER_DIR, with a seeded registry and
// three stand-in soul panes (test/fixtures/fake-soul.mjs: it reports its session like the soul and echoes what is typed):
//   1. the screen opens from the app (≡ command), rows are one per fault with the Portuguese labels, "nova" and the
//      "voltou na vX, depois do fix …" mark; the status icon says "N falhas novas no tether";
//   2. detail: stack (with the bundle note), occurrences; "Marcar como resolvida" with a fix, a tag and a note persist to
//      faults-state.json (author "você") and the tabs recount;
//   3. a fault recorded while the screen is open shows up by itself (the folder watcher), marked "nova";
//   4. "Mandar para o agente": the chooser lists the idle pane (selected, "livre"), the busy one ("trabalhando") and the one
//      whose profile has the feature off ("feature faults desligada neste perfil · Ligar"); sending types the command into
//      the idle pane's terminal and the row says "enviada para …" until `tether faults investigate` makes it investigando;
//   5. the narrow layout (list and detail take turns); screenshots in test/e2e/artifacts/faults-*.png (dark).
// Kills go through test/kill.ts by identity only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { applyAction } from '../../src/core/faults-ops.ts'
import { record, readState } from '../../src/core/faults.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Snap = {
  id: string; tab: string; view: string; banner?: string; empty?: string; toast?: string
  counts: Record<string, number>
  rows: { id: string; status: string; message: string; count: number; tags: string[]; isNew: boolean; returned?: string; sent?: string; selected: boolean }[]
  detail?: { id: string; status: string; tags: string[]; notes: { author: string; text: string }[]; fix?: string; occurrences: number; stackNote?: string }
  chooser?: { choices: { key: string; label: string; state: string; enabled: boolean; reason?: string; checked: boolean }[]; selected?: string; sending: boolean }
}
type Hooks = {
  connection(): { connected: boolean; pid?: number } | undefined
  faults(): Snap[]
  faultsStatus(): { visible: boolean; badge: number; title: string }
  openFaults(): void
  panelIds(): string[]
  slots(): { slotId: string; kind: string; status: string; turn?: string; profileId?: string; cwd: string }[]
  text(id: string): string
  runCommand(id: string): Promise<string>
}
declare const window: { __tether: Hooks; tether: { notice(n: unknown): void; saveProfile(p: unknown): Promise<{ ok: boolean; profile?: { id: string } }>; settingsSet(k: string, v: unknown): Promise<{ ok: boolean }> } }
declare const document: { querySelectorAll(selector: string): { length: number }; documentElement: { dataset: Record<string, string> } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const fakeSoul = join(root, 'test', 'fixtures', 'fake-soul.mjs')
const bin = join(root, 'bin', 'tether.mjs')
const pipe = `\\\\.\\pipe\\tether-faultsscreen-${process.pid}`

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

async function launch(home: string, userDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_USER_DIR = userDir
  env.TETHER_E2E_HIDDEN = '1'
  env.TETHER_SOUL_CMD = `"${process.execPath}" "${fakeSoul}"`
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  page.on('console', m => { if (m.type() === 'error') console.error(`renderer console: ${m.text()}`) })
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
  return { app, page }
}

async function shot(app: ElectronApplication, name: string): Promise<void> {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => {
    const img = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()
    return img.toPNG().toString('base64')
  })
  writeFileSync(join(artifacts, `${name}.png`), Buffer.from(b64, 'base64'))
}

async function until(what: string, fn: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await fn()) return; await sleep(100) }
  assert.fail(`never: ${what}`)
}

const snap = async (page: Page): Promise<Snap | undefined> => (await page.evaluate(() => window.__tether.faults()))[0]

/** A new soul pane through the "Novo painel" dialog (the real flow), in `cwd`, with the profile `profileId`. */
async function newPane(page: Page, cwd: string, profileId: string): Promise<string> {
  const before = await page.evaluate(() => window.__tether.panelIds())
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  await page.click(`#dlg-new .ch-item[data-id="${profileId}"]`)
  await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
  let id = ''
  await until('the new pane', async () => { const now = await page.evaluate(() => window.__tether.panelIds()); id = now.find(x => !before.includes(x)) ?? ''; return !!id })
  return id
}

test('app faults screen: rows, detail, resolve/tag/note persist, live refresh, the agent chooser and the typed command, narrow layout, screenshots', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-faultsscreen-home-'))
  const userDir = mkdtempSync(join(tmpdir(), 'tether-faultsscreen-user-'))
  const work = mkdtempSync(join(tmpdir(), 'tether-faultsscreen-work-'))
  const dir = join(userDir, 'faults')
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined

  // The seeded registry: A open (a load failure in the bundle), B being investigated, C resolved with a fix and back in v0.9.4.
  const T = Date.now() - 3_600_000
  const bundleStack = (fn: string): string => `Error: boom\n    at ${fn} (D:\\x\\app\\dist\\main-app.cjs:1204:17)\n    at Module._load (node:internal/modules/cjs/loader:1:1)`
  const seed = (message: string, over: { kind?: 'load' | 'uncaught' | 'gone'; proc?: 'main' | 'renderer'; version?: string; at?: number } = {}) =>
    record({ proc: over.proc ?? 'main', kind: over.kind ?? 'uncaught', message, stack: bundleStack(message.replace(/\W+/g, '_')), context: { slot: 's-1', window: 1 } }, { dir, now: () => over.at ?? T, version: over.version ?? '0.9.3', commit: 'abc1234def', mapper: null })!
  const a = seed("Cannot find module './impl/format'", { kind: 'load', at: T })
  seed("Cannot find module './impl/format'", { kind: 'load', at: T + 70_000 })
  const b = seed("TypeError: Cannot read properties of undefined (reading 'cols')", { proc: 'renderer', at: T + 200_000 })
  const c = seed('PTY exited 3221225477', { kind: 'gone', at: T + 300_000 })
  applyAction(dir, b.shortId, { type: 'investigate', by: 'Claude · tether' })
  applyAction(dir, c.shortId, { type: 'done', by: 'você', fix: 'def4567890' })
  seed('PTY exited 3221225477', { kind: 'gone', at: T + 400_000, version: '0.9.4' }) // comes back: reopened by the registry

  try {
    let page: Page
    ;({ app, page } = await launch(home, userDir))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await page.evaluate(() => window.__tether.runCommand('theme.dark'))
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')

    // The feature on in general; one soul profile with it explicitly off.
    assert.ok((await page.evaluate(() => window.tether.settingsSet('agents.features.faults', true))).ok)
    const off = await page.evaluate(() => window.tether.saveProfile({ name: 'soul sem falhas', agent: 'soul', args: ['-g'], features: { faults: false } }))
    assert.ok(off.ok && off.profile, 'profile saved')

    // 1. The status icon announces the new faults before the screen is ever opened.
    await until('the status icon', async () => (await page.evaluate(() => window.__tether.faultsStatus())).visible)
    const status = await page.evaluate(() => window.__tether.faultsStatus())
    assert.equal(status.badge, 2, '2 open faults (one of them back), never looked at')
    assert.equal(status.title, '2 falhas novas no tether')

    // Three agent panes: free, busy (a line submitted, the fake never ends the turn), and the profile with the feature off.
    const idle = await newPane(page, work, 'soul')
    await until('idle pane', async () => (await page.evaluate(() => window.__tether.slots())).find(s => s.slotId === idle)?.turn === 'idle')
    const busy = await newPane(page, work, 'soul')
    await until('second pane up', async () => (await page.evaluate(() => window.__tether.slots())).find(s => s.slotId === busy)?.turn === 'idle')
    await page.evaluate(id => window.tether.notice({ t: 'input', slotId: id, data: 'think\r' }), busy)
    await until('busy pane', async () => (await page.evaluate(() => window.__tether.slots())).find(s => s.slotId === busy)?.turn === 'busy')
    const nofeature = await newPane(page, work, off.profile!.id)
    await until('third pane up', async () => (await page.evaluate(() => window.__tether.slots())).find(s => s.slotId === nofeature)?.turn === 'idle')

    // 2. The screen.
    await page.evaluate(() => window.__tether.openFaults())
    await until('the screen', async () => (await snap(page))?.rows.length === 2)
    let s = (await snap(page))!
    assert.equal(s.tab, 'open')
    assert.deepEqual(s.counts, { open: 2, investigating: 1, done: 0, ignored: 0, all: 3 })
    const ra = s.rows.find(r => r.id === a.shortId)!
    const rc = s.rows.find(r => r.id === c.shortId)!
    assert.equal(ra.count, 2)
    assert.equal(ra.isNew, true)
    assert.equal(rc.returned, 'voltou na v0.9.4, depois do fix def4567')
    assert.match(await page.locator(`.fl-row[data-id="${a.shortId}"] .fl-r2`).textContent() ?? '', /main · ao abrir · ×2 · /, 'kind in Portuguese')
    await page.click('.fl-tab[data-tab="all"]')
    await until('all tab', async () => (await snap(page))?.rows.length === 3)
    assert.match(await page.locator(`.fl-row[data-id="${b.shortId}"] .fl-st`).textContent() ?? '', /investigando/)
    await page.click('.fl-tab[data-tab="open"]')

    // 2b. Detail of A: stack with the bundle note, occurrences.
    await page.click(`.fl-row[data-id="${a.shortId}"]`)
    await until('detail A', async () => (await snap(page))?.detail?.id === a.shortId)
    s = (await snap(page))!
    assert.equal(s.detail!.occurrences, 2)
    assert.equal(s.detail!.stackNote, 'mostrando a stack do bundle: sem source map da v0.9.3')
    assert.match(await page.locator('.fl-stack').textContent() ?? '', /main-app\.cjs:1204:17/)
    await shot(app, 'faults-list-dark')

    // 2c. Tag, note, resolve: each lands in faults-state.json.
    await page.fill('.fl-tag-in', 'Build')
    await page.press('.fl-tag-in', 'Enter')
    await until('tag persisted', async () => readState(dir).state.faults[a.sig]?.tags.join() === 'build')
    await until('tag shown', async () => (await snap(page))?.detail?.tags.join() === 'build')
    await page.fill('.fl-note-in', 'jsonc-parser UMD no bundle do main')
    await page.press('.fl-note-in', 'Control+Enter')
    await until('note persisted', async () => (readState(dir).state.faults[a.sig]?.notes.length ?? 0) === 1)
    assert.equal(readState(dir).state.faults[a.sig]!.notes[0]!.author, 'você')
    assert.equal(readState(dir).state.faults[a.sig]!.notes[0]!.text, 'jsonc-parser UMD no bundle do main')
    await until('note shown', async () => (await snap(page))?.detail?.notes.length === 1)
    await shot(app, 'faults-detail-dark')
    await page.click('.fl-actions [data-act="resolve"]')
    await page.fill('.fl-fix', 'abc1234')
    await page.press('.fl-fix', 'Enter')
    await until('resolved persisted', async () => readState(dir).state.faults[a.sig]?.status === 'done')
    assert.equal(readState(dir).state.faults[a.sig]!.fix?.commit, 'abc1234')
    await until('open tab recounted', async () => (await snap(page))?.counts.open === 1)
    await page.click('.fl-tab[data-tab="all"]')
    await page.click(`.fl-row[data-id="${a.shortId}"]`)
    await until('reopen offered', async () => (await page.locator('.fl-actions [data-act="reopen"]').count()) === 1)
    await page.click('.fl-actions [data-act="reopen"]')
    await until('reopened', async () => readState(dir).state.faults[a.sig]?.status === 'open')
    await page.click('.fl-tab[data-tab="open"]')

    // 3. A fault recorded now (by anyone) appears by itself.
    const d = seed('Error: late failure', { at: Date.now() })
    await until('live row', async () => !!(await snap(page))?.rows.find(r => r.id === d.shortId))
    assert.equal((await snap(page))!.rows.find(r => r.id === d.shortId)!.isNew, true, 'new while open, without stealing the selection')
    assert.equal((await snap(page))!.rows.find(r => r.selected)?.id, a.shortId)

    // 4. "Mandar para o agente".
    await page.click('.fl-actions [data-act="send"]')
    await until('chooser', async () => !!(await snap(page))?.chooser)
    const ch = (await snap(page))!.chooser!
    const byKey = (k: string) => ch.choices.find(x => x.key === k)!
    assert.equal(ch.selected, `pane:${idle}`, 'the first free pane is already marked')
    assert.deepEqual([byKey(`pane:${idle}`).enabled, byKey(`pane:${idle}`).state], [true, 'livre'])
    assert.deepEqual([byKey(`pane:${busy}`).enabled, byKey(`pane:${busy}`).reason], [false, 'trabalhando'])
    assert.deepEqual([byKey(`pane:${nofeature}`).enabled, byKey(`pane:${nofeature}`).reason], [false, 'feature faults desligada neste perfil'])
    assert.ok(await page.locator('.fl-choice[data-key="pane:' + nofeature + '"] [data-act="link"]').count(), 'a "Ligar" link on the feature-off pane')
    assert.ok(ch.choices.some(x => x.key.startsWith('new:') && x.label.startsWith('Novo painel')), 'a new-pane row')
    assert.equal(await page.locator('.fl-choice[data-key="pane:' + busy + '"] input').isDisabled(), true)
    await shot(app, 'faults-chooser-dark')
    await page.click('.fl-chooser [data-act="confirm-send"]')
    await until('typed into the free pane', async () => /got: \/tether-fault-investigate /.test(await page.evaluate(id => window.__tether.text(id), idle)), 20_000)
    assert.match(await page.evaluate(id => window.__tether.text(id), idle), new RegExp(`got: /tether-fault-investigate ${a.shortId}`))
    assert.doesNotMatch(await page.evaluate(id => window.__tether.text(id), busy), /tether-fault-investigate/, 'the busy pane got nothing')
    // Back to the screen: the row says where it went, until the fault is investigando.
    await page.evaluate(() => window.__tether.openFaults())
    await until('sent mark', async () => !!(await snap(page))?.rows.find(r => r.id === a.shortId)?.sent)
    assert.match((await snap(page))!.rows.find(r => r.id === a.shortId)!.sent!, /soul/)
    await page.click('.fl-tab[data-tab="all"]')
    const cli = spawnSync(process.execPath, [bin, 'faults', 'investigate', a.shortId, '--by', 'soul · e2e'], { env: { ...process.env, TETHER_USER_DIR: userDir, TETHER_HOME: home }, encoding: 'utf8', windowsHide: true })
    assert.equal(cli.status, 0, cli.stderr)
    await until('investigating by the CLI, live', async () => (await snap(page))?.rows.find(r => r.id === a.shortId)?.status === 'investigating')
    assert.equal((await snap(page))!.rows.find(r => r.id === a.shortId)?.sent, undefined, 'the mark goes when the agent takes it')
    await page.click('.fl-tab[data-tab="investigating"]')
    await shot(app, 'faults-investigating-dark')

    // 4b. "Novo painel": no pane is free any more for the fault D; the new-pane row opens a pane in the tether source folder,
    // waits for its agent and types the command once it is up.
    await page.evaluate(() => window.__tether.openFaults())
    await page.click('.fl-tab[data-tab="all"]')
    await page.click(`.fl-row[data-id="${d.shortId}"]`)
    await page.click('.fl-actions [data-act="send"]')
    await until('chooser again', async () => !!(await snap(page))?.chooser)
    const again = (await snap(page))!.chooser!
    assert.equal(again.choices.find(x => x.key === `pane:${idle}`)?.enabled, false, 'the pane that took the command is not free now')
    assert.equal(again.selected, 'new:claude', 'no free pane: the first new-pane row is the one marked')
    await page.check('.fl-choice[data-key="new:soul"] input') // the stand-in agent, never a real Claude
    const panesBefore = await page.evaluate(() => window.__tether.panelIds())
    await page.click('.fl-chooser [data-act="confirm-send"]')
    let fresh = ''
    await until('the new pane', async () => { fresh = (await page.evaluate(() => window.__tether.panelIds())).find(x => !panesBefore.includes(x) && !x.startsWith('faults:')) ?? ''; return !!fresh })
    await until('typed into the new pane once its agent was up', async () => new RegExp(`got: /tether-fault-investigate ${d.shortId}`).test(await page.evaluate(id => window.__tether.text(id), fresh)), 40_000)
    const created = (await page.evaluate(() => window.__tether.slots())).find(x => x.slotId === fresh)!
    assert.equal(created.cwd.toLowerCase(), root.toLowerCase(), 'the new pane opens in the tether source folder')
    await page.evaluate(() => window.__tether.openFaults())
    await until('sent mark on the second fault', async () => !!(await snap(page))?.rows.find(r => r.id === d.shortId)?.sent)

    // 5. Narrow: list and detail take turns.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(480, 800))
    await sleep(500)
    await page.click('.fl-back') // the wide screen was showing a detail: narrow, it is a page of its own with a way back
    await page.selectOption('.fl-tabselect', 'all')
    await until('narrow list view', async () => (await snap(page))?.view === 'list')
    assert.equal(await page.locator('.fl-detail').isVisible(), false, 'the detail waits its turn')
    await shot(app, 'faults-narrow-list-dark')
    await page.click(`.fl-row[data-id="${b.shortId}"]`)
    await until('narrow detail view', async () => (await snap(page))?.view === 'detail')
    assert.equal(await page.locator('.fl-list').isVisible(), false)
    await shot(app, 'faults-narrow-detail-dark')
    await page.click('.fl-back')
    await until('back to the list', async () => (await snap(page))?.view === 'list')
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) {
      const r = await killOwned(d, { tree: true })
      if (r === 'not-ours') console.error(`tetherd cleanup: pid ${d.pid} is no longer ours; not killed`)
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(x => pidAlive(x.pid))) await sleep(200)
    for (const dirPath of [home, userDir, work]) {
      for (let i = 0; i < 5; i++) {
        try { rmSync(dirPath, { recursive: true, force: true }); break } catch { await sleep(300) }
      }
    }
  }
})
