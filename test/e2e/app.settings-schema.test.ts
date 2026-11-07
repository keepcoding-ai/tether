// E2E of the settings.json schema in the note editor (Monaco's JSON language service, schema from the configuration registry):
//   1. the Settings page's "Abrir settings.json" opens the user's file; typing `"ui.deskLine": "x"` (a string for a boolean) raises an
//      error marker; comments and trailing commas raise nothing; a nested object still reads but is not described (the
//      schema is flat, like VS Code's); a dotted `"ui.deskLine": false` written in the file turns the desk line off live;
//   2. Ctrl+Space inside the file suggests extensions.note.minimap (a key the note extension registered), and only dotted keys;
//   3. an ordinary .json file opened as a note is still tokenized and coloured (several token classes), and gets no schema markers.
// Kills go through test/kill.ts by identity only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Marker = { severity: number; message: string; line: number }
type Hooks = {
  connection(): { connected: boolean; pid?: number } | undefined
  notes(): { id: string; path: string }[]
  openFile(path: string): Promise<unknown> | void
  modelMarkers(path: string): Marker[]
}
declare const window: { __tether: Hooks }
type El = { offsetParent: unknown; textContent: string | null; querySelectorAll(s: string): ArrayLike<{ className: string }> }
declare const document: { querySelectorAll(s: string): ArrayLike<El>; body: { classList: { contains(c: string): boolean } } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-settingsschema-${process.pid}`
const daemonMain = join(root, 'src', 'daemon', 'main.ts')

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
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  page.on('console', m => { if (m.type() === 'error') console.error(`renderer console: ${m.text()}`) })
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
  return { app, page }
}

async function until(what: string, fn: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await fn()) return; await sleep(100) }
  assert.fail(`never: ${what}`)
}

test('app settings schema: type errors become markers, Ctrl+Space suggests registry keys, ordinary .json stays coloured', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-settingsschema-home-'))
  const userDir = mkdtempSync(join(tmpdir(), 'tether-settingsschema-user-'))
  const settingsFile = join(userDir, 'settings.json')
  const otherFile = join(userDir, 'other.json')
  writeFileSync(settingsFile, '{\n  // mine\n  "theme": "dark"\n}\n')
  writeFileSync(otherFile, '{\n  "name": "x", "count": 3, "on": true, "none": null, // c\n  "list": ["a", 1]\n}\n')
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, userDir))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // 1. Open settings.json from the Settings page.
    await page.locator('body').click({ position: { x: 600, y: 400 } }).catch(() => {})
    await page.keyboard.press('Control+Comma')
    await page.waitForSelector('.st-pane [data-act="open-json"]')
    await page.click('.st-pane [data-act="open-json"]')
    await until('the note opens at the file', async () => (await page.evaluate(() => window.__tether.notes())).some(n => n.path.toLowerCase() === settingsFile.toLowerCase()))
    const editor = page.locator('.monaco-editor:visible').first()
    await editor.waitFor()
    const markers = (): Promise<Marker[]> => page.evaluate(p => window.__tether.modelMarkers(p), settingsFile)
    await until('the file text shows', async () => /mine/.test((await editor.textContent()) ?? ''))
    // The text lands from disk (typing a "{" would auto-close it); the editor reloads the file.
    writeFileSync(settingsFile, '{\n  // a comment is fine\n  "ui.deskLine": "x",\n}\n')
    await until('an error marker for the string in a boolean', async () => (await markers()).some(m => m.severity === 8 && /boolean/i.test(m.message)))
    assert.equal((await markers()).filter(m => m.severity === 8).length, 1, `only the type error: ${JSON.stringify(await markers())}`)
    writeFileSync(settingsFile, '{\n  // a comment is fine\n  "ui.deskLine": true,\n  "ui": { "tabBorder": "no" },\n}\n')
    await until('the boolean is fine', async () => /tabBorder/.test((await editor.textContent()) ?? '') && !(await markers()).some(m => m.line === 3))
    await sleep(1000)
    assert.ok(!(await markers()).some(m => m.severity === 8), `the nested object is not described, so not flagged: ${JSON.stringify(await markers())}`)
    assert.ok(!(await markers()).some(m => /comment|trailing|comma/i.test(m.message)), `comments and trailing commas are allowed: ${JSON.stringify(await markers())}`)

    // A dotted key written in the file is honoured live (the values tree of settings-file.ts).
    assert.equal(await page.evaluate(() => document.body.classList.contains('desk-line')), true)
    writeFileSync(settingsFile, '{\n  "ui.deskLine": false\n}\n')
    await until('desk line off from the dotted key', async () => !(await page.evaluate(() => document.body.classList.contains('desk-line'))))

    // 2. Ctrl+Space suggests the registered key, and only flat dotted keys.
    writeFileSync(settingsFile, '{\n  \n}\n')
    await until('the file reloaded', async () => !/deskLine/.test((await editor.textContent()) ?? ''))
    await editor.locator('.view-lines').click()
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('End')
    await page.keyboard.insertText('"ext')
    await page.keyboard.press('Control+Space')
    await page.waitForSelector('.suggest-widget.visible')
    await until('the suggestion', async () => /extensions\.note\.minimap/.test((await page.locator('.suggest-widget').textContent()) ?? ''))
    const labels = await page.locator('.suggest-widget .monaco-list-row .label-name').allTextContents()
    assert.ok(labels.length > 0 && labels.every(l => /^"?extensions\.\w/.test(l.trim())), `only dotted keys are suggested: ${JSON.stringify(labels)}`)
    await page.keyboard.press('Escape')

    // 3. An ordinary .json is coloured and carries no schema.
    await page.evaluate(p => window.__tether.openFile(p), otherFile)
    await until('the other file is open', async () => (await page.evaluate(() => window.__tether.notes())).some(n => n.path.toLowerCase() === otherFile.toLowerCase()))
    await until('coloured', async () => {
      const classes = await page.evaluate(() => {
        const out = new Set<string>()
        for (const ed of Array.from(document.querySelectorAll('.monaco-editor'))) {
          if (!ed.offsetParent || !/"name"/.test(ed.textContent ?? '')) continue
          for (const sp of Array.from(ed.querySelectorAll('.view-line span span'))) for (const c of sp.className.split(/\s+/)) if (/^mtk\d+$/.test(c)) out.add(c)
        }
        return [...out]
      })
      return classes.length >= 3
    })
    assert.deepEqual(await page.evaluate(p => window.__tether.modelMarkers(p), otherFile), [], 'no schema errors on an ordinary .json')
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) {
      const r = await killOwned(d, { tree: true })
      if (r === 'not-ours') console.error(`tetherd cleanup: pid ${d.pid} is no longer ours; not killed`)
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (const dir of [home, userDir]) {
      for (let i = 0; i < 5; i++) {
        try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) }
      }
    }
  }
})
