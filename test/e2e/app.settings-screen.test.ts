// E2E of the "Configurações" page (extensions/settings-screen) on a private TETHER_HOME and TETHER_USER_DIR:
//   1. Ctrl+, opens the page as a tab; closed, "Configurações…" in ≡ opens it again;
//   2. the ui.deskLine switch: the DOM (the desk line goes off), the file (only that key), the modified bar;
//   3. ↺ removes the key from the file and the bar goes away;
//   4. the search "minimapa" leaves only the note's minimap;
//   5. a number setting (added by the test hook: no shipped node declares one yet): "abc" shows the validator's message
//      and nothing is written; a valid value is written;
//   6. "Abrir settings.json" opens <userDir>/settings.json as a note;
//   7. the file edited on disk (the editor's save lands the same way) repaints the page; a broken file shows the banner;
//   8. screenshots light and dark.
// Kills go through test/kill.ts by identity only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Row = { key: string; value: unknown; configured: boolean; visible: boolean; modifiedBar: boolean; error: string | null; text: string; disabled: boolean }
type Snap = { id: string; query: string; count: number; banner?: string; sections: string[]; toc: string[]; empty: boolean; rows: Row[] }
type Hooks = {
  connection(): { connected: boolean; pid?: number } | undefined
  settingsScreen(): Snap[]
  settingsScreenRefresh(): Promise<void>
  settingsAddTestEntry(e: unknown): Promise<void>
  settingsTestWrites(): { key: string; value: unknown }[]
  notes(): { id: string; path: string }[]
  panelIds(): string[]
  runCommand(id: string): Promise<string>
}
declare const window: { __tether: Hooks; tether: { settingsSet(k: string, v: unknown): Promise<{ ok: boolean }>; settingsReset(k: string): Promise<{ ok: boolean }> } }
declare const document: { body: { classList: { contains(c: string): boolean } }; documentElement: { dataset: Record<string, string> }; querySelectorAll(s: string): { length: number } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const shotsOut = resolve(root, '..', '..', '.tmp')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-settingsscreen-${process.pid}`
const daemonMain = join(root, 'src', 'daemon', 'main.ts')

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}
const stripComments = (s: string): string => s.replace(/\/\/.*$/gm, '')

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

async function shot(app: ElectronApplication, name: string): Promise<void> {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => {
    const img = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()
    return img.toPNG().toString('base64')
  })
  const file = join(artifacts, `${name}.png`)
  writeFileSync(file, Buffer.from(b64, 'base64'))
  mkdirSync(shotsOut, { recursive: true })
  copyFileSync(file, join(shotsOut, `tether-${name}.png`))
}

async function until(what: string, fn: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await fn()) return; await sleep(100) }
  assert.fail(`never: ${what}`)
}

const snap = async (page: Page): Promise<Snap | undefined> => (await page.evaluate(() => window.__tether.settingsScreen()))[0]
const row = async (page: Page, key: string): Promise<Row | undefined> => (await snap(page))?.rows.find(r => r.key === key)

test('app settings screen: Ctrl+, and ≡ open it; a switch writes one key with the modified bar; ↺ removes it; search; an invalid number is not written; settings.json opens; the file\'s edits repaint; light and dark', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-settingsscreen-home-'))
  const userDir = mkdtempSync(join(tmpdir(), 'tether-settingsscreen-user-'))
  const settingsFile = join(userDir, 'settings.json')
  writeFileSync(settingsFile, '{\n  // mine\n  "theme": "dark"\n}\n')
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home, userDir))
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // 1. Ctrl+, opens the page; closed, ≡ "Configurações…" opens it again.
    await page.locator('body').click({ position: { x: 600, y: 400 } }).catch(() => {})
    await page.keyboard.press('Control+Comma')
    await page.waitForSelector('.st-pane .st-item[data-key="ui.deskLine"]')
    await until('the page is listed', async () => !!(await snap(page)))
    await page.click('.tether-tab.settings .close')
    await until('the page closed', async () => !(await snap(page)))
    await page.click('#btn-menu')
    await page.waitForSelector('#app-menu:not([hidden])')
    assert.equal(await page.locator('#app-menu li[data-command="settings.show"] svg').count(), 1, 'the gear icon')
    await page.click('#app-menu li[data-command="settings.show"]')
    await page.waitForSelector('.st-pane .st-item[data-key="ui.deskLine"]')
    let s = (await snap(page))!
    assert.ok(s.toc.includes('core/Janela') && s.toc.includes('note/Nota'), `the TOC: ${s.toc.join(', ')}`)
    assert.ok(s.sections.includes('core/Confirmações'), 'the confirmations action section')
    assert.equal((await row(page, 'theme'))?.modifiedBar, true, 'the seeded theme is modified')
    assert.equal((await row(page, 'ui.deskLine'))?.modifiedBar, false)

    // 2. The switch.
    assert.equal(await page.evaluate(() => document.body.classList.contains('desk-line')), true)
    await page.click('.st-item[data-key="ui.deskLine"] .st-switch')
    await until('desk line off', async () => !(await page.evaluate(() => document.body.classList.contains('desk-line'))))
    await until('the file has ui.deskLine false', async () => (JSON.parse(stripComments(readFileSync(settingsFile, 'utf8'))) as Record<string, unknown>)['ui.deskLine'] === false)
    const written = JSON.parse(stripComments(readFileSync(settingsFile, 'utf8'))) as Record<string, unknown>
    delete written.window // the core's window state, written on its own
    assert.deepEqual(written, { theme: 'dark', 'ui.deskLine': false })
    assert.match(readFileSync(settingsFile, 'utf8'), /\/\/ mine/, 'the comment survives')
    await until('the modified bar', async () => (await row(page, 'ui.deskLine'))?.modifiedBar === true)
    assert.equal(await page.locator('.st-item[data-key="ui.deskLine"] .st-switch').getAttribute('aria-checked'), 'false')

    // 3. ↺ removes the key.
    await page.click('.st-item[data-key="ui.deskLine"] .st-reset')
    await until('the key is gone', async () => { const f = JSON.parse(stripComments(readFileSync(settingsFile, 'utf8'))) as { ui?: Record<string, unknown> } & Record<string, unknown>; return !('ui.deskLine' in f) && (!f.ui || !('deskLine' in f.ui)) })
    await until('the bar is gone', async () => (await row(page, 'ui.deskLine'))?.modifiedBar === false)
    await until('desk line on', () => page.evaluate(() => document.body.classList.contains('desk-line')))
    assert.equal(await page.locator('.st-item[data-key="ui.deskLine"] .st-switch').getAttribute('aria-checked'), 'true')

    // 4. Search.
    await page.fill('.st-q', 'minimapa')
    await until('only the minimap', async () => { const r = (await snap(page))!.rows.filter(x => x.visible).map(x => x.key); return r.length === 1 && r[0] === 'extensions.note.minimap' })
    assert.equal(await page.locator('.st-item[data-key="extensions.note.minimap"] .st-title mark').count(), 1, 'the hit is highlighted')
    await page.fill('.st-q', 'zzzz nada')
    await until('the empty state', async () => (await snap(page))!.empty)
    await page.fill('.st-q', '')
    await until('everything back', async () => (await snap(page))!.rows.every(r => r.visible))

    // 5. A number setting: invalid text is not written.
    await page.evaluate(() => window.__tether.settingsAddTestEntry({ key: 'test.fontSize', node: 'core', nodeTitle: 'Aparência', schema: { type: 'integer', default: 12, title: 'Tamanho de teste', description: 'Só do teste.', section: 'Janela', order: 99, min: 6, max: 40 }, value: 12, configured: false }))
    const num = page.locator('.st-item[data-key="test.fontSize"] input')
    await num.fill('abc')
    await until('the error', async () => (await row(page, 'test.fontSize'))?.error === 'O valor precisa ser um número inteiro.')
    assert.equal(await page.locator('.st-item[data-key="test.fontSize"] .st-err').textContent(), 'O valor precisa ser um número inteiro.')
    await num.fill('99')
    await until('the bound error', async () => (await row(page, 'test.fontSize'))?.error === 'O valor precisa ser menor ou igual a 40.')
    await num.press('Enter')
    await sleep(900)
    assert.deepEqual(await page.evaluate(() => window.__tether.settingsTestWrites()), [], 'nothing written while invalid')
    await num.fill('20')
    await num.press('Enter')
    await until('written once valid', async () => JSON.stringify(await page.evaluate(() => window.__tether.settingsTestWrites())) === JSON.stringify([{ key: 'test.fontSize', value: 20 }]))
    assert.equal((await row(page, 'test.fontSize'))?.error, null)

    // 6. "Abrir settings.json".
    await page.click('.st-pane [data-act="open-json"]')
    await until('the note opens at the file', async () => (await page.evaluate(() => window.__tether.notes())).some(n => n.path.toLowerCase() === settingsFile.toLowerCase()))

    // 7. The file edited on disk repaints; a broken file shows the banner; fixed, it goes.
    writeFileSync(settingsFile, '{\n  // mine\n  "theme": "dark",\n  "ui": { "tabBorder": true }\n}\n')
    await until('tabBorder on in the page', async () => { const r = await row(page, 'ui.tabBorder'); return r?.value === true && r.modifiedBar })
    writeFileSync(settingsFile, '{\n  "theme": "dark",\n  "ui": { "tabBorder": tru \n}\n')
    await until('the banner', async () => /settings\.json tem erros; corrija para voltar a salvar/.test((await snap(page))?.banner ?? ''))
    assert.equal((await row(page, 'ui.deskLine'))?.disabled, true, 'controls wait')
    writeFileSync(settingsFile, '{\n  "theme": "dark"\n}\n')
    await until('the banner goes', async () => (await snap(page))?.banner === undefined)
    await until('tabBorder back to default', async () => (await row(page, 'ui.tabBorder'))?.configured === false)

    // 8. Screenshots: the page in front, light and dark.
    await page.evaluate(() => window.__tether.runCommand('settings.show'))
    await page.click('.tether-tab.settings')
    await page.click('.st-item[data-key="ui.dimUnfocused"] .st-switch')
    await until('dim configured', async () => (await row(page, 'ui.dimUnfocused'))?.modifiedBar === true)
    await page.evaluate(() => window.tether.settingsSet('theme', 'light'))
    await until('light', async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light')
    await sleep(300)
    await shot(app, 'settings-light')
    await page.evaluate(() => window.tether.settingsSet('theme', 'dark'))
    await until('dark', async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark')
    await sleep(300)
    await shot(app, 'settings-dark')
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
