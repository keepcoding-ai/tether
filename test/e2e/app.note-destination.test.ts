// E2E of "Nova nota" destination (Guga, 09/11), against the real tetherd on a private home/pipe, hidden window:
//   1. a recent folder inside `.tether` is suggested cut at `.tether` (the general rule of the folder field);
//   2. "Nova nota" highlighted: "Salvar em" with Notas do projeto · Minhas notas · Outro; the project's is the first
//      default, with `\.tether\notes` grey right after the typed text (the field does not move);
//   3. Minhas notas: the field read only with the personal folder, the folder button is a gear that opens the settings
//      page on "Pasta das minhas notas" (the popup steps aside);
//   4. Outro: the note lands exactly in the chosen folder; the next chooser comes back on Outro with that folder;
//   5. the other items keep the band as it was (no "Salvar em", the field editable);
//   screenshots note-dest-{project,home,other}.png.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Snap = { highlight: string | undefined; folder: string; touched: boolean; effectiveFolder: string }
type Hooks = {
  panelIds(): string[]
  connection(): { connected: boolean; pid?: number } | undefined
  chooser(): Snap | undefined
  profiles(): { id: string }[]
}
declare const window: { __tether: Hooks }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-note-dest-${process.pid}`
const daemonMain = join(root, 'src', 'daemon', 'main.ts')

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
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  page.on('console', m => { if (m.type() === 'error') console.error(`renderer console: ${m.text().slice(0, 300)}`) })
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

const D = '#dlg-new'
const openPopup = async (page: Page): Promise<void> => { await page.click('#btn-new'); await page.waitForSelector(`${D}[open]`) }
const noDialog = (page: Page) => page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
/** "Nova nota" highlighted from the keyboard (a click would open it). */
async function highlightNewNote(page: Page): Promise<void> {
  await page.fill(`${D} .ch-q`, 'nova nota')
  await page.waitForFunction(() => window.__tether.chooser()?.highlight === 'kind:note-new')
  await page.waitForSelector(`${D} .ch-dest:not([hidden])`)
}
const chipOn = (page: Page) => page.locator(`${D} .ch-dest-chip.on`).innerText()

test('app note destination: .tether cut, Notas do projeto / Minhas notas / Outro, remembered', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-note-dest-'))
  const work = mkdtempSync(join(tmpdir(), 'tether-note-dest-work-'))
  const inside = join(work, '.tether', 'notes')
  const chosen = join(work, 'escolhida')
  mkdirSync(inside, { recursive: true })
  mkdirSync(chosen, { recursive: true })
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid, 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await page.waitForFunction(() => window.__tether.profiles().length >= 3)

    // A shell opened in a folder inside `.tether` (typed: kept as chosen) becomes the most recent folder.
    await openPopup(page)
    await page.fill(`${D} .ch-path-input`, inside)
    await page.click(`${D} .ch-item[data-id="powershell"]`)
    await noDialog(page)
    await page.waitForFunction(() => window.__tether.panelIds().length === 1)

    // 1. Suggested again, it comes cut at `.tether`.
    await openPopup(page)
    await page.waitForFunction(w => window.__tether.chooser()?.effectiveFolder === w, work)
    const s1 = (await page.evaluate(() => window.__tether.chooser()))!
    assert.equal(s1.touched, false, 'a suggestion, not a choice')

    // 5. Another item: no "Salvar em", the field editable.
    await page.fill(`${D} .ch-q`, 'powershell')
    assert.ok(await page.locator(`${D} .ch-dest`).isHidden(), 'no destination row for a shell')
    assert.equal(await page.locator(`${D} .ch-path-input`).getAttribute('readonly'), null)

    // 2. "Nova nota": the three options, the project's first, the grey suffix right after the text.
    await highlightNewNote(page)
    assert.deepEqual(await page.locator(`${D} .ch-dest-chip`).allInnerTexts(), ['Notas do projeto', 'Minhas notas', 'Outro'])
    assert.equal(await chipOn(page), 'Notas do projeto')
    assert.equal(await page.locator(`${D} .ch-sfx`).innerText(), '\\.tether\\notes')
    const inputBox = (await page.locator(`${D} .ch-path-input`).boundingBox())!
    const sfxBox = (await page.locator(`${D} .ch-sfx`).boundingBox())!
    assert.ok(Math.abs(sfxBox.x - (inputBox.x + inputBox.width)) <= 2, `the suffix follows the text (${sfxBox.x} vs ${inputBox.x + inputBox.width})`)
    assert.ok(Math.abs(sfxBox.y - inputBox.y) <= 4, 'on the same line: nothing moves below')
    const folderBand = (await page.locator(`${D} .ch-folder`).boundingBox())!
    await shot(app, 'note-dest-project')

    // 3. Minhas notas: read only with the personal folder, a gear; the band keeps its place.
    await page.click(`${D} .ch-dest-chip[data-dest="home"]`)
    assert.equal(await chipOn(page), 'Minhas notas')
    await page.waitForFunction(h => (document.querySelector('#dlg-new .ch-path-input') as HTMLInputElement | null)?.value === h, join(home, 'notes'))
    assert.notEqual(await page.locator(`${D} .ch-path-input`).getAttribute('readonly'), null, 'read only')
    assert.ok(await page.locator(`${D} .ch-sfx`).isHidden(), 'no suffix')
    assert.ok(await page.locator(`${D} .ch-rec`).isHidden(), 'no recent folders')
    assert.equal(await page.locator(`${D} .ch-browse`).getAttribute('title'), 'Configurar a pasta das minhas notas')
    assert.deepEqual(await page.locator(`${D} .ch-folder`).boundingBox(), folderBand, 'the field did not move')
    await shot(app, 'note-dest-home')
    await page.click(`${D} .ch-browse`)
    await noDialog(page)
    await page.waitForSelector('.st-item[data-key="extensions.note.personalFolder"].st-flash')
    await page.waitForFunction(() => (document.activeElement as HTMLElement | null)?.closest('.st-item')?.getAttribute('data-key') === 'extensions.note.personalFolder')

    // 4. Outro: exactly in the chosen folder; the next chooser comes back on Outro with it.
    await openPopup(page)
    await highlightNewNote(page)
    assert.equal(await chipOn(page), 'Notas do projeto', 'nothing was created: nothing remembered')
    await page.click(`${D} .ch-dest-chip[data-dest="other"]`)
    assert.ok(await page.locator(`${D} .ch-sfx`).isHidden(), 'Outro: no suffix')
    await page.fill(`${D} .ch-path-input`, chosen)
    await page.locator(`${D} .ch-q`).focus()
    await shot(app, 'note-dest-other')
    await page.keyboard.press('Enter')
    await noDialog(page)
    await page.waitForFunction(() => window.__tether.panelIds().length >= 3)
    assert.equal(readdirSync(chosen).filter(f => f.endsWith('.md')).length, 1, 'the note is in the chosen folder itself')
    assert.ok(!existsSync(join(chosen, '.tether')), 'no .tether/notes under it')

    await openPopup(page)
    await highlightNewNote(page)
    assert.equal(await chipOn(page), 'Outro', 'remembered')
    assert.equal(await page.locator(`${D} .ch-path-input`).inputValue(), chosen)

    // Notas do projeto from here: `<pasta>/.tether/notes`.
    await page.click(`${D} .ch-dest-chip[data-dest="project"]`)
    await page.fill(`${D} .ch-path-input`, work)
    await page.locator(`${D} .ch-q`).focus()
    await page.keyboard.press('Enter')
    await noDialog(page)
    await page.waitForFunction(() => window.__tether.panelIds().length >= 4)
    assert.equal(readdirSync(inside).filter(f => f.endsWith('.md')).length, 1, 'the note is in <pasta>/.tether/notes')
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) {
      const r = await killOwned(d, { tree: true })
      if (r === 'not-ours') console.error(`tetherd cleanup: pid ${d.pid} is no longer ours; not killed`)
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (const dir of [home, work]) {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch (e) { console.error(`cleanup ${dir}: ${String(e)}`) }
    }
  }
})
