// E2E of the explorer extension: a click on a row is not lost when the disk watcher redraws the folder in the middle of it
// (the pointer goes down, the folder's rows are replaced, the pointer goes up: the browser drops such a click). Hidden window on a
// private home/pipe, real tetherd, no agent. The native folder picker is replaced in main (ipcMain 'folder:pick').
//   1. the pointer is held on a folder row for 700 ms while files keep being created in the folder that holds it: on release
//      the row is selected and toggled (open, then closed, then open again), and the redraw that waited then shows every new file;
//   2. the same with a plain click on a row while the burst runs (no hold): selected and toggled.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Row = { root: string; path: string; name: string; level: number; kind: string; expanded: boolean; selected: boolean; focused: boolean }
type Snapshot = { mode: 'empty' | 'roots'; rows: Row[] }
type Hooks = { connection(): { pid?: number } | undefined; explorer(): Snapshot | undefined }
declare const window: { __tether: Hooks }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-appexplorerpress-${process.pid}`
const atriumTmp = resolve(root, '..', '..', '.tmp')
const tmpBase = existsSync(atriumTmp) ? atriumTmp : tmpdir()
const PAD = 'explorer.files'
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }

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

const snap = async (page: Page): Promise<Snapshot> => (await page.evaluate(() => window.__tether.explorer()))!
const rowOf = async (page: Page, name: string): Promise<Row | undefined> => (await snap(page)).rows.find(r => r.name === name)
const rowSel = (name: string): string => `.pad.shown .xp-row:has(> .xp-name:text-is("${name}"))`

async function until(page: Page, what: string, ok: (s: Snapshot) => boolean, timeout = 8_000): Promise<void> {
  const t0 = Date.now()
  let last: Snapshot | undefined
  while (Date.now() - t0 < timeout) {
    last = await snap(page)
    if (ok(last)) return
    await sleep(40)
  }
  assert.fail(`${what} (rows: ${last?.rows.map(r => r.name).slice(0, 40).join(', ')})`)
}

/** Creates a file every ~20 ms in `dir` until stopped; the returned function stops it and says how many it made. */
function burst(dir: string, prefix: string): () => number {
  let n = 0
  const t = setInterval(() => writeFileSync(join(dir, `${prefix}${String(n++).padStart(4, '0')}.txt`), ''), 20)
  const stop = (): number => { clearInterval(t); return n }
  bursts.push(stop)
  return stop
}
/** Every burst started, so a failing assertion cannot leave one writing files (and the process alive). */
const bursts: (() => number)[] = []

test('explorer: a click is not lost when the watcher redraws the folder during it', { timeout: 240_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpBase, 'tether-explorer-press-'))
  const F = join(home, 'proj', 'pressed')
  for (const d of ['src', 'docs', 'lib']) mkdirSync(join(F, d), { recursive: true })
  writeFileSync(join(F, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(F, 'docs', 'd1.md'), '# d1\n')
  writeFileSync(join(F, 'lib', 'l1.ts'), 'export const l = 1\n')
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await app.evaluate(({ ipcMain }, f) => { ipcMain.removeHandler('folder:pick'); ipcMain.handle('folder:pick', () => f) }, F)
    await page.click(`#sidebar-left .sb-icon[data-pad="${PAD}"]`)
    await page.waitForSelector('.pad[data-pad="explorer.files"].shown .xp-empty')
    await page.click('.xp-primary')
    await until(page, 'root expanded', s => s.rows.some(r => r.name === 'docs'))

    // ---- 1. the pointer held on a row while the folder that holds it is redrawn by the watcher ----
    const stop = burst(F, 'hold-')
    await sleep(150) // the burst is running before the press
    for (const [i, expected] of [true, false, true].entries()) {
      const box = (await page.locator(rowSel('docs')).boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await sleep(700) // longer than the watcher's quiet time: its redraw lands while the pointer is down
      await page.mouse.up()
      await until(page, `press ${i + 1}: docs is selected and ${expected ? 'open' : 'closed'}`, s => {
        const r = s.rows.find(x => x.name === 'docs')
        return !!r && r.selected && r.expanded === expected
      })
      await page.mouse.move(box.x - 150, box.y - 20) // away from the row, so the next press starts clean
    }
    const made = stop()
    assert.ok(made > 60, `the burst made ${made} files`)
    const last = `hold-${String(made - 1).padStart(4, '0')}.txt`
    await until(page, 'the redraw that waited shows the last new file', s => s.rows.some(r => r.name === last), 12_000)

    // ---- 2. a plain click while the burst runs ----
    const stop2 = burst(F, 'click-')
    await sleep(150)
    await page.click(rowSel('src'))
    await until(page, 'click: src is selected and open', s => { const r = s.rows.find(x => x.name === 'src'); return !!r && r.selected && r.expanded })
    await page.click(rowSel('lib'))
    await until(page, 'click: lib is selected and open', s => { const r = s.rows.find(x => x.name === 'lib'); return !!r && r.selected && r.expanded })
    stop2()
    assert.equal((await rowOf(page, 'src'))?.expanded, true)
  } finally {
    for (const stop of bursts) stop()
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    const deadline = Date.now() + 10_000
    while (daemons.some(d => pidAlive(d.pid)) && Date.now() < deadline) await sleep(100)
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
    assert.equal(existsSync(home), false, 'test home removed')
  }
})
