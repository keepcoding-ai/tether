// E2E of the settings registry channels (app/main/main.ts settings:*, preload, TetherUi.configuration's transport) on a
// private TETHER_HOME and TETHER_USER_DIR:
//   1. settings:list holds the core's ui.deskLine (default true, not configured) and the note's extensions.note.minimap;
//   2. settings:set writes that key alone (the person's comment and other keys untouched) and tether:ui arrives;
//   3. settings:reset removes the key: back to the default, tether:ui again;
//   4. an unknown key or an invalid value is refused and the file is untouched.
// Kills go through test/kill.ts by identity only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'


const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-settingsregtest-${process.pid}`
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


type Entry = { key: string; node: string; value: unknown; configured: boolean; schema: { type: string; default: unknown; title: string; description?: string } }
type Api = {
  settingsList(): Promise<{ entries: Entry[]; errors: unknown[] }>
  settingsSet(key: string, value: unknown): Promise<{ ok: boolean }>
  settingsReset(key: string): Promise<{ ok: boolean }>
  onUi(l: (ui: { deskLine: boolean }) => void): () => void
  onSettingsChanged(l: (keys: string[]) => void): () => void
}
declare const window: { tether: Api; __uiSeen: Array<{ deskLine: boolean }>; __keysSeen: string[][]; __tether: { connection(): { connected: boolean; pid?: number } | undefined } }
declare const document: { body: { classList: { contains(c: string): boolean } } }

async function until(what: string, fn: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) { if (await fn()) return; await sleep(100) }
  assert.fail(`never: ${what}`)
}

test('settings registry: list, set writes only that key, reset removes it, tether:ui arrives', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-settingsregtest-home-'))
  const userDir = mkdtempSync(join(tmpdir(), 'tether-settingsregtest-user-'))
  const settingsFile = join(userDir, 'settings.json')
  const seeded = '{\n  // mine\n  "theme": "dark"\n}\n'
  writeFileSync(settingsFile, seeded)
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, userDir))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await page.evaluate(() => {
      window.__uiSeen = []; window.__keysSeen = []
      window.tether.onUi(ui => window.__uiSeen.push(ui))
      window.tether.onSettingsChanged(keys => window.__keysSeen.push(keys))
    })

    // 1. The list.
    const list = await page.evaluate(() => window.tether.settingsList())
    const desk = list.entries.find(e => e.key === 'ui.deskLine')
    assert.ok(desk, 'ui.deskLine is listed')
    assert.equal(desk.value, true)
    assert.equal(desk.configured, false)
    assert.equal(desk.node, 'core')
    assert.ok(desk.schema.description)
    const minimap = list.entries.find(e => e.key === 'extensions.note.minimap')
    assert.ok(minimap, 'extensions.note.minimap is listed')
    assert.equal(minimap.value, true)
    assert.equal(list.entries.find(e => e.key === 'theme')?.configured, true)
    assert.deepEqual(list.errors, [])
    assert.equal(await page.evaluate(() => document.body.classList.contains('desk-line')), true)

    // 2. Set: that key alone, as a text edit; the renderer gets tether:ui.
    assert.deepEqual(await page.evaluate(() => window.tether.settingsSet('ui.deskLine', false)), { ok: true })
    const afterSet = JSON.parse(readFileSync(settingsFile, 'utf8').replace(/\/\/.*$/gm, '')) as Record<string, unknown>
    assert.deepEqual(afterSet, { theme: 'dark', 'ui.deskLine': false }, 'only ui.deskLine was written, as a flat key (VS Code)')
    assert.match(readFileSync(settingsFile, 'utf8'), /\/\/ mine/)
    await until('tether:ui with deskLine false', () => page.evaluate(() => window.__uiSeen.some(u => u.deskLine === false)))
    await until('desk line off', async () => !(await page.evaluate(() => document.body.classList.contains('desk-line'))))
    await until('settings-changed names the key', () => page.evaluate(() => window.__keysSeen.some(k => k.includes('ui.deskLine'))))
    const listed = (await page.evaluate(() => window.tether.settingsList())).entries.find(e => e.key === 'ui.deskLine')
    assert.equal(listed?.value, false)
    assert.equal(listed?.configured, true)
    // An extension key goes under extensions.<id>.
    assert.deepEqual(await page.evaluate(() => window.tether.settingsSet('extensions.note.minimap', false)), { ok: true })
    assert.equal((JSON.parse(readFileSync(settingsFile, 'utf8').replace(/\/\/.*$/gm, '')) as Record<string, unknown>)['extensions.note.minimap'], false)

    // 3. Reset removes the key.
    const uiBefore = await page.evaluate(() => window.__uiSeen.length)
    assert.deepEqual(await page.evaluate(() => window.tether.settingsReset('ui.deskLine')), { ok: true })
    const afterReset = JSON.parse(readFileSync(settingsFile, 'utf8').replace(/\/\/.*$/gm, '')) as { ui?: Record<string, unknown> } & Record<string, unknown>
    assert.ok(!('ui.deskLine' in afterReset) && (!afterReset.ui || !('deskLine' in afterReset.ui)), 'ui.deskLine is gone from the file')
    await until('tether:ui with deskLine true', () => page.evaluate(n => window.__uiSeen.slice(n).some(u => u.deskLine === true), uiBefore))
    await until('desk line on', () => page.evaluate(() => document.body.classList.contains('desk-line')))
    const relisted = (await page.evaluate(() => window.tether.settingsList())).entries.find(e => e.key === 'ui.deskLine')
    assert.equal(relisted?.configured, false)
    assert.equal(relisted?.value, true)

    // 4. Refusals leave the file as it is.
    const text = readFileSync(settingsFile, 'utf8')
    assert.equal((await page.evaluate(() => window.tether.settingsSet('nope.key', true))).ok, false)
    assert.equal((await page.evaluate(() => window.tether.settingsSet('ui.dimLevel', 'huge'))).ok, false)
    assert.equal((await page.evaluate(() => window.tether.settingsSet('ui.deskLine', 'yes'))).ok, false)
    assert.equal(readFileSync(settingsFile, 'utf8'), text)
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
