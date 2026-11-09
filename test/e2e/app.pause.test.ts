// E2E of the polite pause in the app with the REAL Claude Code (--model haiku, CLAUDE* stripped, hidden window, private
// home/pipe): a Claude runs a long task (turn busy -> the tab ball), the "Pedir pausa" button in the Sessões menu starts the batch, the counter goes
// 0/1 -> 1/1 as the agent stops by itself, the menu lists it, the pause.manage command opens the "Acompanhar a pausa"
// popup, whose light/dark captures at 900 and 1280 px go to PAUSE_SHOTS_DIR (default D:/atrium/.tmp/pause-proof, outside the repo);
// Retomar brings the turn back. No Claude session is killed before 11 s of life (fullscreen canary).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { CLAUDE_DIALECT } from './harness.ts'

type Hooks = {
  panelIds(): string[]
  slots(): SlotState[]
  text(id: string): string
  connection(): { connected: boolean; pid?: number } | undefined
  activeDesk(): string
  runCommand(id: string): Promise<'ran' | 'unknown' | 'unavailable'>
}
declare const window: { __tether: Hooks; tether: { notice(n: unknown): void } }
declare const document: { querySelectorAll(selector: string): { length: number }; querySelector(selector: string): { textContent: string | null; hasAttribute(n: string): boolean } | null; documentElement: { dataset: Record<string, string> } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const shots = process.env.PAUSE_SHOTS_DIR ?? 'D:/atrium/.tmp/pause-proof'
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-pause-${process.pid}`
const MIN_UPTIME_MS = 11_000

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
  env.TETHER_CLAUDE_ARGS = '--model haiku'
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

const text = (page: Page, id: string) => page.evaluate(id => window.__tether.text(id), id)
const slotOf = async (page: Page, id: string) => (await page.evaluate(() => window.__tether.slots())).find(s => s.slotId === id)

const TRUST = /trust this folder/i
const TRUST_YES = /^\s*❯\s*Yes, I trust/m
const hasPrompt = (t: string): boolean => { const lines = t.split('\n'); return lines.some((_, i) => CLAUDE_DIALECT.isPrompt(lines, i)) }
const busy = (t: string): boolean => CLAUDE_DIALECT.busy(t, '')
function inputText(t: string): string {
  const lines = t.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) if (CLAUDE_DIALECT.isPrompt(lines, i)) return CLAUDE_DIALECT.inputText(lines, i)
  return ''
}

async function waitPanel(page: Page, id: string, cond: (t: string) => boolean, opts: { timeout?: number; quietMs?: number; what: string }): Promise<string> {
  const timeout = opts.timeout ?? 60_000, quietMs = opts.quietMs ?? 0
  const deadline = Date.now() + timeout
  let last = '', since = Date.now()
  for (;;) {
    const t = await text(page, id)
    const now = Date.now()
    if (t !== last) { last = t; since = now }
    if (cond(t) && now - since >= quietMs) return t
    if (now > deadline) throw new Error(`timeout (${timeout} ms) waiting for ${opts.what}\n--- panel ---\n${t}`)
    await sleep(150)
  }
}


const TASK = 'Faça este trabalho em 10 passos, UM de cada vez, cada passo numa chamada Bash separada e sequencial (nunca em paralelo, nunca junte passos): '
  + 'no passo N rode `sleep 6; echo passo-N` trocando N pelo número. Depois do passo 10 responda apenas: tudo-pronto.'

async function openMenuIfClosed(page: Page): Promise<void> {
  if (await page.locator('#sessions-list').isHidden()) await page.click('#btn-sessions')
}

async function setTheme(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  await page.click('#btn-theme')
  await page.click(`#theme-menu li[data-theme="${scheme}"]`)
  await page.waitForFunction(s => document.documentElement.dataset.theme === s, scheme)
}

test('app pause: busy ball, Pausar button + counter, menu, pause.manage popup (light/dark, 900/1280), Retomar', { timeout: 600_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shots, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-pause-'))
  const work = mkdtempSync(join(tmpdir(), 'tether-pause-work-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  let readyAt = Date.now()
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))

    // ---- Claude on desk 1 ----
    await page.click('#btn-new')
    await page.waitForSelector('#dlg-new[open]')
    await page.fill('#dlg-new .ch-path-input', work)
    await page.click('#dlg-new .ch-item[data-id="claude"]')
    await page.click('#dlg-new .btn.primary.go')
    await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
    await page.waitForFunction(() => document.querySelectorAll('.tether-tab').length === 1)
    const id = (await page.evaluate(() => window.__tether.panelIds()))[0]!
    await waitPanel(page, id, t => TRUST.test(t) || hasPrompt(t), { timeout: 90_000, what: 'trust dialog or prompt' })
    readyAt = Date.now()
    const term = page.locator(`.panel[data-slot-id="${id}"] .panel-term`)
    if (TRUST.test(await text(page, id))) {
      await term.click()
      await waitPanel(page, id, () => true, { quietMs: 500, what: 'trust to settle' })
      for (let i = 1; ; i++) {
        await page.keyboard.press('ArrowDown')
        const t = await waitPanel(page, id, () => true, { quietMs: 400, what: 'trust selection' })
        if (TRUST_YES.test(t)) break
        if (i === 3) throw new Error(`trust selection\n${t}`)
      }
      await page.keyboard.press('Enter')
    }
    await waitPanel(page, id, t => !TRUST.test(t) && hasPrompt(t) && !busy(t), { quietMs: 1_500, timeout: 90_000, what: 'idle prompt' })

    // ---- the button is there, idle: no counter, no batch ----
    assert.equal(await page.locator('#btn-sessions').count(), 1, 'the Sessões icon exists')
    assert.equal(await page.locator('#btn-pause, #btn-closed').count(), 0, 'the two old icons are gone')
    assert.equal(await page.locator('#sessions-count').isVisible(), false, 'no counter pill without a batch or a call to action (hidden, not just empty)')
    await page.screenshot({ path: join(shots, 'app-idle-no-batch.png') })

    // ---- long task: the ball (turn busy) ----
    for (let i = 1; ; i++) {
      await term.click()
      await page.keyboard.type(TASK, { delay: 4 })
      try { await waitPanel(page, id, t => inputText(t).includes('tudo-pronto'), { timeout: 8_000, what: 'echo' }); break } catch (e) { if (i === 3) throw e }
    }
    await page.keyboard.press('Enter')
    await page.waitForFunction(id => window.__tether.slots().find(s => s.slotId === id)?.turn === 'busy', id, { timeout: 60_000 })
    await page.waitForSelector('.tether-tab .attn[data-mark="busy"]')
    await waitPanel(page, id, t => /passo-1\b/.test(t), { timeout: 90_000, what: 'first step' })
    await page.screenshot({ path: join(shots, 'app-busy-ball.png') })

    // ---- Pausar: counter 0/1 then 1/1 when the agent stops itself ----
    // The icon alone never pauses: open the menu, press Enter right away, nothing starts.
    await page.click('#btn-sessions')
    await page.waitForSelector('#sessions-list:not([hidden]) #pause-start:not([disabled])')
    assert.match((await page.locator('#pause-start').textContent())!, /^Pedir pausa aos 1 em andamento$/)
    await page.keyboard.press('Enter')
    await sleep(800)
    assert.equal(await page.locator('#sessions-count').isVisible(), false, 'clicking the icon and pressing Enter creates no batch')
    assert.equal(await page.locator('#sessions-list .pz-row').count(), 0, 'no batch rows')
    await page.click('#pause-start')
    await page.waitForFunction(() => document.querySelector('#sessions-count')?.textContent === '0/1' || document.querySelector('#sessions-count')?.textContent === '1/1')
    await page.waitForSelector('#sessions-list:not([hidden]) .pz-row')
    console.log(`# app: counter after click = ${JSON.stringify(await page.locator('#sessions-count').textContent())}; row = ${JSON.stringify(await page.locator('#sessions-list .pz-row .cw').first().textContent())}`)
    await page.screenshot({ path: join(shots, 'app-menu-waiting.png') })
    await page.waitForFunction(() => document.querySelector('#sessions-count')?.textContent === '1/1', undefined, { timeout: 180_000 })
    const rowText = await page.locator('#sessions-list .pz-row .cw').first().textContent()
    console.log(`# app: counter = 1/1; row text = ${JSON.stringify(rowText)}`)
    assert.equal(await page.locator('#sessions-list .sx-hd').count(), 1)
    assert.equal(await page.locator('#btn-sessions .i svg').count(), 1, 'one glyph; the pause glyph shows while the batch is on screen')
    assert.equal(await page.locator('#btn-sessions .i').getAttribute('data-icon'), 'pause')
    await page.screenshot({ path: join(shots, 'app-menu-stopped.png') })
    assert.equal(await page.locator('#pause-resume:not([disabled])').count(), 1, 'Retomar is enabled once everybody stopped')
    await page.waitForFunction(id => window.__tether.slots().find(s => s.slotId === id)?.turn === undefined, id, { timeout: 60_000 })
    assert.equal(await page.locator('.tether-tab .attn[data-mark="busy"]').count(), 0, 'the ball is gone after the Stop')

    // ---- pause.manage opens the popup; captures light/dark at 1280 and 900 ----
    await page.keyboard.press('Escape')
    for (const width of [1280, 900]) {
      await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0]?.setContentSize(w, 800), width)
      for (const scheme of ['light', 'dark'] as const) {
        await setTheme(page, scheme)
        assert.equal(await page.evaluate(() => window.__tether.runCommand('pause.manage')), 'ran')
        await page.waitForSelector('dialog[data-dialog="pause"][open]')
        await sleep(400)
        const tier = await page.locator('dialog[data-dialog="pause"]').getAttribute('data-tier')
        console.log(`# app: popup at ${width}px (${scheme}) tier=${tier}`)
        await page.screenshot({ path: join(shots, `app-popup-${width}-${scheme}.png`) })
        await page.locator('dialog[data-dialog="pause"] .pd-close').click()
        await page.waitForFunction(() => document.querySelectorAll('dialog[data-dialog="pause"][open]').length === 0)
      }
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))

    // ---- Retomar (from the menu): the turn comes back ----
    await openMenuIfClosed(page)
    await page.waitForSelector('#sessions-list:not([hidden]) #pause-resume:not([disabled])')
    await page.click('#pause-resume')
    await page.waitForFunction(id => window.__tether.slots().find(s => s.slotId === id)?.turn === 'busy', id, { timeout: 90_000 })
    console.log('# app: after Retomar the turn is busy again')
    await page.waitForFunction(() => document.querySelector('#sessions-count')?.hasAttribute('hidden') === true, undefined, { timeout: 60_000 })
    await page.screenshot({ path: join(shots, 'app-resumed.png') })
  } finally {
    const wait = readyAt + MIN_UPTIME_MS - Date.now()
    if (wait > 0) await sleep(wait)
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    for (let i = 0; i < 20 && daemons.some(d => pidAlive(d.pid)); i++) await sleep(500)
    for (const dir of [home, work]) for (let i = 0; i < 5; i++) { try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) } }
  }
})

test('fullscreen canary: ~/.claude.json has no fullscreenAutoDisabled after the pause test', () => {
  const cfg = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')) as { fullscreenAutoDisabled?: unknown }
  assert.ok(!cfg.fullscreenAutoDisabled, 'fullscreenAutoDisabled is set: a Claude session died before 10 s of life')
})
