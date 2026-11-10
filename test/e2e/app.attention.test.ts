// E2E of the attention badge with the REAL Claude Code (--model haiku, CLAUDE* stripped, hidden window, private
// home/pipe): a Claude on desk 1 gets a prompt, the user switches to desk 2, Claude's Stop hook reports the end
// of the turn → the slot's `attention` is 'done', desk 1's chip shows the badge, the pane's tab shows the dot
// and the tray model says so; going back to desk 1 (the pane gets the focus) clears all of it.
// No Claude session is killed before 11 s of life (fullscreen canary).
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
  desks(): { id: string; panes: string[]; attention: { done: number; waiting: number } }[]
}
declare const window: { __tether: Hooks; tether: { notice(n: unknown): void } }
declare const document: { querySelectorAll(selector: string): { length: number } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-attention-${process.pid}`
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
  env.TETHER_TRAY = '1' // attention asserts the tray badge: opt back in (see trayWanted in app/main)
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

test('attention: a finished Claude turn badges its hidden desk, its tab and the tray; focusing the pane clears it', { timeout: 400_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-attn-'))
  const work = mkdtempSync(join(tmpdir(), 'tether-attn-work-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  let readyAt = Date.now()
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))

    // ---- Claude on desk 1 ----
    await page.click('#btn-new')
    await page.waitForSelector('#dlg-new[open]')
    await page.fill('#dlg-new .ch-path-input', work)
    await page.click('#dlg-new .ch-item[data-id=\"claude\"]')
    await page.click('#dlg-new .btn.primary.go') // two steps: the click selects, the button opens
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
    assert.equal((await slotOf(page, id))?.attention, undefined, 'no badge before any turn')

    // ---- type the prompt, then go to a new desk and send Enter from there ----
    const prompt = 'responda apenas: tamarindo'
    for (let i = 1; ; i++) {
      await term.click()
      await page.keyboard.type(prompt, { delay: 10 })
      try { await waitPanel(page, id, t => inputText(t).includes(prompt), { timeout: 5_000, what: 'echo' }); break } catch (e) { if (i === 3) throw e }
    }
    await page.keyboard.press('Control+Shift+N')
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-2')
    for (let i = 1; ; i++) {
      await page.evaluate(id => window.tether.notice({ t: 'input', slotId: id, data: '\r' }), id)
      try { await waitPanel(page, id, t => busy(t) || !inputText(t).includes(prompt), { timeout: 4_000, what: 'prompt accepted' }); break } catch (e) { if (i === 3) throw e }
    }

    // ---- the turn ends while desk 1 is hidden: badge on desk 1, dot on the tab, amber tray ----
    await page.waitForFunction(id => window.__tether.slots().find(s => s.slotId === id)?.attention === 'done', id, { timeout: 120_000 })
    assert.match(await text(page, id), /tamarindo/i)
    await page.waitForSelector('#desk-switch .seg[data-desk="desk-1"] .desk-badge.done')
    assert.equal(await page.locator('#desk-switch .seg[data-desk="desk-1"] .desk-badge').textContent(), '1')
    assert.equal(await page.locator('#desk-switch .seg[data-desk="desk-2"] .desk-badge').count(), 0)
    assert.equal(await page.locator(`.tether-tab[data-attention="done"] .attn.done`).count(), 1)
    const tray = await app.evaluate(() => (globalThis as unknown as { __tetherTray: { model(): { badge: string; tooltip: string; attention: number } } }).__tetherTray.model())
    assert.equal(tray.badge, 'attention')
    assert.equal(tray.attention, 1)
    assert.match(tray.tooltip, /1 esperando você/)
    const report = JSON.parse(readFileSync(join(home, 'slots', `${id}.attention`), 'utf8')) as { kind: string }
    assert.equal(report.kind, 'done', 'the Stop hook wrote the report')
    await page.screenshot({ path: join(artifacts, 'attention-badge.png') })

    // ---- back to desk 1: the pane gets the focus, the attention goes everywhere ----
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w?.focus(); w?.webContents.focus() })
    await page.keyboard.press('Control+1')
    await page.waitForFunction(() => window.__tether.activeDesk() === 'desk-1')
    try {
      await page.waitForFunction(id => window.__tether.slots().find(s => s.slotId === id)?.attention === undefined, id, { timeout: 5_000 })
    } catch {
      // The offscreen test window may never report document.hasFocus(): typing into the pane clears it too.
      console.log('attention: focus did not clear it in the offscreen window; typing does')
      await term.click()
      await page.keyboard.press('x')
      await page.keyboard.press('Backspace')
      await page.waitForFunction(id => window.__tether.slots().find(s => s.slotId === id)?.attention === undefined, id, { timeout: 5_000 })
    }
    await page.waitForFunction(() => document.querySelectorAll('#desk-switch .desk-segs .desk-badge').length === 0)
    assert.equal(await page.locator('.tether-tab .attn.done').count(), 0)
    const trayAfter = await app.evaluate(() => (globalThis as unknown as { __tetherTray: { model(): { badge: string } } }).__tetherTray.model())
    assert.equal(trayAfter.badge, 'active', 'the tray is back to "an agent runs"')
  } finally {
    const wait = readyAt + MIN_UPTIME_MS - Date.now()
    if (wait > 0) await sleep(wait)
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    for (let i = 0; i < 20 && daemons.some(d => pidAlive(d.pid)); i++) await sleep(500)
    for (const dir of [home, work]) for (let i = 0; i < 5; i++) { try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) } }
  }
})

test('fullscreen canary: ~/.claude.json has no fullscreenAutoDisabled after the attention test', () => {
  const cfg = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')) as { fullscreenAutoDisabled?: unknown }
  assert.ok(!cfg.fullscreenAutoDisabled, 'fullscreenAutoDisabled is set: a Claude session died before 10 s of life')
})
