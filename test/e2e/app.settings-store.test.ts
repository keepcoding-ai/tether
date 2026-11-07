// E2E of the settings store (app/main/settings-store.ts) in the Electron app, on a private TETHER_HOME and TETHER_USER_DIR:
//   1. settings.json and keybindings.json seeded in the home move to the user folder at start (old ones renamed
//      `.migrated`, nothing deleted); the seeded theme is in force;
//   2. an edit of the file on disk takes effect live (theme) and the person's comment survives;
//   3. a change made through the app is a text edit: the comment is still there;
//   4. a file with errors: the app's write is refused (the file is untouched); fixing it on disk is picked up again.
// Kills go through test/kill.ts by identity only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type ThemeState = { setting: 'light' | 'auto' | 'dark'; scheme: 'light' | 'dark' }
declare const window: { __tether: { theme(): ThemeState; connection(): { connected: boolean; pid?: number } | undefined } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-settingstest-${process.pid}`
const daemonMain = join(root, 'src', 'daemon', 'main.ts')

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

async function launch(home: string, userDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_USER_DIR = userDir
  env.TETHER_E2E_HIDDEN = '1'
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

const theme = (page: Page): Promise<ThemeState> => page.evaluate(() => window.__tether.theme())
const clickMenu = (app: ElectronApplication, id: string): Promise<void> =>
  app.evaluate(({ Menu }, id) => { Menu.getApplicationMenu()?.getMenuItemById(id)?.click() }, id)

const deskLine = (page: Page): Promise<boolean> => page.evaluate(() => (globalThis as unknown as { document: { body: { classList: { contains(c: string): boolean } } } }).document.body.classList.contains('desk-line'))
async function waitDeskLine(page: Page, on: boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) { if ((await deskLine(page)) === on) return; await sleep(100) }
  assert.equal(await deskLine(page), on, `desk line never became ${on}`)
}

async function waitTheme(page: Page, setting: ThemeState['setting']): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if ((await theme(page)).setting === setting) return
    await sleep(100)
  }
  assert.equal((await theme(page)).setting, setting, `theme setting never became ${setting}`)
}

test('settings store: migration to the user folder, live edits on disk, comments survive, a broken file is not overwritten', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-settingstest-home-'))
  const userDir = mkdtempSync(join(tmpdir(), 'tether-settingstest-user-'))
  const seeded = '{\n  // my own note\n  "theme": "dark"\n}\n'
  const seededKeys = '[\n  // my keys\n]\n'
  writeFileSync(join(home, 'settings.json'), seeded)
  writeFileSync(join(home, 'keybindings.json'), seededKeys)
  const settingsFile = join(userDir, 'settings.json')
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, userDir))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // 1. Migration: copied, old renamed, nothing deleted; the seeded theme is in force.
    assert.equal(readFileSync(settingsFile, 'utf8'), seeded)
    assert.equal(readFileSync(join(userDir, 'keybindings.json'), 'utf8'), seededKeys)
    assert.ok(!existsSync(join(home, 'settings.json')) && existsSync(join(home, 'settings.json.migrated')))
    assert.ok(!existsSync(join(home, 'keybindings.json')) && existsSync(join(home, 'keybindings.json.migrated')))
    assert.equal((await theme(page)).setting, 'dark')

    // 2. An edit on disk is live; the comment is the person's and stays.
    writeFileSync(settingsFile, seeded.replace('"dark"', '"light"'))
    await waitTheme(page, 'light')
    // Both forms read, applied in order and the last wins (VS Code's values tree): a nested object, then a dotted key after it.
    writeFileSync(settingsFile, '{\n  // my own note\n  "theme": "light",\n  "ui": { "deskLine": false }\n}\n')
    await waitDeskLine(page, false)
    writeFileSync(settingsFile, '{\n  // my own note\n  "theme": "light",\n  "ui": { "deskLine": false },\n  "ui.deskLine": true\n}\n')
    await waitDeskLine(page, true)
    writeFileSync(settingsFile, seeded.replace('"dark"', '"light"'))
    await sleep(500)

    // 3. A change through the app edits the text in place.
    await clickMenu(app, 'theme-dark')
    await waitTheme(page, 'dark')
    const afterApp = readFileSync(settingsFile, 'utf8')
    assert.match(afterApp, /\/\/ my own note/)
    assert.match(afterApp, /"theme": "dark"/)

    // 4. A broken file: the app's write is refused and the file stays as the person left it.
    const broken = '{\n  // half written\n  "theme": '
    writeFileSync(settingsFile, broken)
    await sleep(1000)
    await clickMenu(app, 'theme-light')
    await sleep(500)
    assert.equal(readFileSync(settingsFile, 'utf8'), broken, 'a file with errors is never overwritten')
    assert.equal((await theme(page)).setting, 'dark', 'the values in force are the last good ones')
    // Fixed on disk: picked up again.
    writeFileSync(settingsFile, '{\n  // fixed\n  "theme": "light"\n}\n')
    await waitTheme(page, 'light')
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
