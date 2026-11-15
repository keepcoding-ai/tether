// E2E of the browser's option in the profile editor (hidden window, private home/pipe, real tetherd, product build): the
// checkbox "Navegador para os agentes" is off on a default Claude profile, saving it on writes
// `extensions.browser.serve` into profiles.json (and only there), it is not offered for a shell profile, and the
// Guias pad's empty state (mode perProfile) leads to this editor.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

type Hooks = { connection(): { connected: boolean; pid?: number } | undefined; profiles(): Array<{ id: string; extensions?: Record<string, Record<string, unknown>> }> }
declare const window: { __tether: Hooks }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-brpo-${process.pid}`
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
  try { await page.waitForSelector('#conn.on', { timeout: 30_000 }) } catch (e) { await killElectron(app, root).catch(() => {}); throw e }
  return { app, page }
}

const OPTION = 'input[name="ext:browser.serve"]'

test('browser option in the profile editor', { timeout: 300_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '' } })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-brpo-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await page.waitForFunction(() => window.__tether.profiles().length >= 3)

    await page.click('#btn-profiles')
    await page.waitForSelector('#dlg-profiles[open]')
    await page.click('.profile-option[data-id="claude"]')
    await page.waitForSelector(OPTION, { state: 'visible' })
    assert.equal(await page.isChecked(OPTION), false, 'off by default')
    const hint = (await page.locator('#profile-ext-options').textContent()) ?? ''
    assert.match(hint, /Os agentes do Tether recebem as ferramentas do navegador e podem usar todas as contas logadas nas guias\./)
    assert.match(hint, /mesmos para todos os perfis/)
    await page.check(OPTION)
    await page.click('#btn-profile-save')
    await page.waitForSelector('#profile-saved:not([hidden])')
    await page.waitForFunction(() => window.__tether.profiles().find(p => p.id === 'claude')?.extensions?.browser?.serve === true)
    const file = JSON.parse(readFileSync(join(home, 'profiles.json'), 'utf8')) as { profiles: Array<{ id: string; extensions?: unknown }> }
    assert.deepEqual(file.profiles.find(p => p.id === 'claude')!.extensions, { browser: { serve: true } })
    assert.equal(file.profiles.find(p => p.id === 'soul')!.extensions, undefined, 'the other profiles are untouched')

    // Another profile, then back: the mark is per profile; turning it off removes the key.
    await page.click('.profile-option[data-id="soul"]')
    assert.equal(await page.isChecked(OPTION), false)
    await page.click('.profile-option[data-id="claude"]')
    assert.equal(await page.isChecked(OPTION), true)
    await page.uncheck(OPTION)
    await page.click('#btn-profile-save')
    await page.waitForFunction(() => window.__tether.profiles().find(p => p.id === 'claude')?.extensions === undefined)

    // A shell profile is not offered the option.
    await page.click('.profile-option[data-agent="shell"]')
    assert.equal(await page.isVisible(OPTION), false)
    await page.keyboard.press('Escape')
    await page.waitForSelector('#dlg-profiles', { state: 'hidden' })

    // The pad's empty state leads here.
    await page.click('#sidebar-left .sb-icon[data-pad="browser.tabs"]')
    await page.click('.br-pad button[data-action="open-profiles"]')
    await page.waitForSelector('#dlg-profiles[open]')
  } finally {
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    for (let i = 0; i < 20 && daemons.some(d => pidAlive(d.pid)); i++) await sleep(500)
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }
})
