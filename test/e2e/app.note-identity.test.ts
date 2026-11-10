// E2E: one note pane = one file. Regression of 09/11 (data loss): a note renamed in its tab kept its Monaco model under
// the OLD file's URI; a note later opened on a file with that old name (a tether:// link, `tether focus`) picked the same
// model, so the two panes shared one buffer and each one's autosave wrote the other's text — every outside change of
// one file was copied into the other. Against the real tetherd on a private home/pipe, hidden window:
//   1. a note opened on nucleo.md; its tab renamed to "tether" (the file becomes tether.md, our text in it);
//   2. a new nucleo.md is written outside (another agent) and followed as a link: a second note opens on it;
//   3. tether.md still holds our text; an outside write to nucleo.md reaches its note and never tether.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { noteUrl } from '../../app/shared/tether-url.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Note = { id: string; path: string; text: string }
type Hooks = { connection(): { connected: boolean; pid?: number } | undefined; notes(): Note[]; activate(id: string): void }
declare const window: { __tether: Hooks }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-note-identity-${process.pid}`
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
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
  return { app, page }
}

const follow = (app: ElectronApplication, url: string): Promise<void> =>
  app.evaluate(({ app }, url) => { app.emit('second-instance', {}, [process.execPath, url], process.cwd()) }, url)

test('note identity: a renamed note never shares its buffer with the note later opened on its old name', { timeout: 240_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-noteid-'))
  const base = mkdtempSync(join(tmpdir(), 'tether-noteid-files-'))
  const nucleo = join(base, 'nucleo.md'), tether = join(base, 'tether.md')
  writeFileSync(nucleo, '# texto que vai virar tether\n')
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid))
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // ---- 1. a note on nucleo.md, renamed to tether.md in its tab ----
    await follow(app, noteUrl(nucleo))
    await page.waitForFunction(p => window.__tether.notes().some(n => n.path === p && n.text.includes('tether')), nucleo)
    const first = (await page.evaluate(() => window.__tether.notes()))[0]!
    await page.evaluate(id => window.__tether.activate(id), first.id)
    await page.locator('.tether-tab.note').first().dblclick()
    const rename = page.locator('.tether-tab.note input.rename')
    await rename.waitFor()
    await rename.fill('tether')
    await rename.press('Enter')
    await page.waitForFunction(p => window.__tether.notes().some(n => n.path.toLowerCase().endsWith('tether.md')), tether)
    assert.ok(existsSync(tether) && !existsSync(nucleo), 'the file was renamed')
    const ours = '# texto que vai virar tether\n'
    assert.equal(readFileSync(tether, 'utf8'), ours)

    // ---- 2. another agent writes a new nucleo.md, and its link opens it as a second note ----
    writeFileSync(nucleo, '# nucleo v1 do outro agente\n')
    await follow(app, noteUrl(nucleo))
    await page.waitForFunction(p => window.__tether.notes().some(n => n.path === p), nucleo)
    await page.waitForFunction(p => window.__tether.notes().find(n => n.path === p)?.text === '# nucleo v1 do outro agente\n', nucleo)
    await sleep(1500) // past the autosave debounce: a shared buffer would have been written by now
    assert.equal(readFileSync(tether, 'utf8'), ours, 'opening nucleo.md left tether.md alone')
    assert.equal(readFileSync(nucleo, 'utf8'), '# nucleo v1 do outro agente\n', 'and nucleo.md as written')

    // ---- 3. an outside write to nucleo.md reaches its note, never tether.md ----
    writeFileSync(nucleo, '# nucleo v2 do outro agente\n')
    await page.waitForFunction(p => window.__tether.notes().find(n => n.path === p)?.text === '# nucleo v2 do outro agente\n', nucleo)
    await sleep(1500)
    assert.equal(readFileSync(tether, 'utf8'), ours, 'an outside change of nucleo.md is not copied into tether.md')
    const tetherNote = (await page.evaluate(() => window.__tether.notes())).find(n => n.path.toLowerCase().endsWith('tether.md'))
    assert.equal(tetherNote?.text, ours, 'the tether.md tab still shows its own text')
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) await killOwned(d, { tree: true })
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (const dir of [home, base]) for (let i = 0; i < 5; i++) { try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) } }
  }
})
