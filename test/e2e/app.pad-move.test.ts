// E2E of `tether focus <file> --pad` on a note already open on the desk: the note MOVES into the panel pad (it leaves the
// desk, it is not duplicated) and the pad is shown. The link goes in as the OS hands it (second-instance argv), the same
// path the CLI takes. Every kill goes through test/kill.ts (pid + creation time).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication } from 'playwright-core'
import { noteUrl } from '../../app/shared/tether-url.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Hooks = {
  notes(): { id: string }[]
  connection(): { connected: boolean; pid?: number } | undefined
  activeId(): string | undefined
  padFrames(): { pad: string; desk?: string; panes: string[]; shown: boolean }[]
}
declare const window: { __tether: Hooks }
declare const document: { querySelectorAll(sel: string): { length: number } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-padmove-${process.pid}`
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const PANEL_PAD = 'frame-pads.panel'

test('focus --pad: a note open on the desk moves into the panel pad', { timeout: 180_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-padmove-'))
  const repo = mkdtempSync(join(tmpdir(), 'tether-padmove-repo-'))
  mkdirSync(join(repo, '.git'))
  const file = join(repo, 'todo.md')
  writeFileSync(file, '# Todo: prova\n')
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
    env.TETHER_PIPE = pipe
    env.TETHER_HOME = home
    env.TETHER_E2E_HIDDEN = '1'
    app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
    const page = await app.firstWindow()
    page.setDefaultTimeout(15_000)
    page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
    await page.waitForSelector('#conn.on', { timeout: 30_000 })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid)
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))
    const follow = (url: string) => app!.evaluate(({ app }, url) => { app.emit('second-instance', {}, [process.execPath, url], process.cwd()) }, url)

    // A terminal pane: the panel whose pad receives the note.
    const before = await page.locator('.tether-tab').count()
    await page.click('#btn-new')
    await page.waitForSelector('#dlg-new[open]')
    await page.fill('#dlg-new .ch-path-input', repo)
    await page.click('#dlg-new .ch-item[data-id="powershell"]')
    await page.click('#dlg-new .btn.primary.go')
    await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
    await page.waitForFunction(n => document.querySelectorAll('.tether-tab').length === n, before + 1)
    const slot = (await page.evaluate(() => window.__tether.activeId()))!

    // The note opens on the desk (a plain focus).
    await follow(noteUrl(file))
    await page.waitForFunction(() => window.__tether.notes().length === 1)
    const note = (await page.evaluate(() => window.__tether.notes()))[0]!.id
    assert.ok(!(await page.evaluate(() => window.__tether.padFrames())).some(f => f.panes.includes(note)), 'the note starts on the desk')
    await page.screenshot({ path: join(process.env.TETHER_PROOF_DIR ?? home, 'pad-move-1-desk.png') })

    // focus --pad: it moves into the panel pad, which is shown; one note only.
    await follow(noteUrl(file, { scope: 'panel', slot }))
    await page.waitForFunction(([p, n]) => window.__tether.padFrames().some(f => f.pad === p && f.shown && f.panes.includes(n!)), [PANEL_PAD, note] as const)
    assert.equal((await page.evaluate(() => window.__tether.notes())).length, 1, 'moved, not duplicated')
    const onDesk = await page.evaluate(n => [...(globalThis as unknown as { document: { querySelectorAll(s: string): Iterable<{ closest(s: string): unknown }> } }).document.querySelectorAll(`.panel[data-slot-id="${n}"]`)].filter(el => !el.closest('.pad-frames')).length, note)
    assert.equal(onDesk, 0, 'the note left the desk')
    await page.screenshot({ path: join(process.env.TETHER_PROOF_DIR ?? home, 'pad-move-2-pad.png') })

    // Again: already in the pad, only focused (still one).
    await follow(noteUrl(file, { scope: 'panel', slot }))
    await page.waitForTimeout(500)
    assert.equal((await page.evaluate(() => window.__tether.notes())).length, 1)
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) await killOwned(d, { tree: true })
  }
})
