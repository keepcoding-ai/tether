// The pad "Contexto" (extensions/context) against the real app, a REAL tetherd and a REAL Claude (--model haiku):
//   1. a Claude panel answers a short prompt; 2. `context.open` opens the pad on the right bar;
//   3. the header shows model, usage % and cost from the statusline file <home>/context/<slotId>.json;
//   4. "Medir" runs /context and the categories show with "medido pelo /context"; 5. focusing a plain terminal says
//   the pad does not apply; 6. with the pad hidden nobody asks for snapshots (counted on the main's ipc handler for 6 s).
// Captures (light and dark) go to .tmp/context-e2e/. Windows stay hidden. No Claude is killed before 11 s of life.
// Run: node --test --test-concurrency=1 test/e2e/app.context.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron, type ElectronApplication } from 'playwright-core'
import { DaemonClient } from '../../src/daemon/client.ts'
import { claim, killOwned, killTestPtyd, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { cleanEnv, daemonMain, electronPath, mainPath, pidAlive, root, sleep } from './browser-kit.ts'
import { aliveProcs, CLAUDE_DIALECT, processTree, type Proc } from './harness.ts'

declare const window: { __tether: {
  panelIds(): string[]
  text(id: string): string
  connection(): { connected: boolean; pid?: number } | undefined
  runCommand(id: string): Promise<'ran' | 'unknown' | 'unavailable'>
  sidebars(): { right: { open?: string } }
  togglePad(id: string): void
  slots(): { slotId: string; status: string; pid?: number }[]
} }
declare const document: { documentElement: { dataset: Record<string, string> }; querySelector(s: string): unknown }

const PAD_ID = 'context.inspector'
const PAD = `#pads div[data-pad="${PAD_ID}"]`
const shots = join(root, '.tmp', 'context-e2e')
const pipe = `\\\\.\\pipe\\tether-appcontext-${process.pid}`
const MIN_UPTIME_MS = 11_000

const TRUST = /trust this folder/i
const TRUST_YES = /^\s*❯\s*Yes, I trust/m
const hasPrompt = (text: string): boolean => { const lines = text.split('\n'); return lines.some((_, i) => CLAUDE_DIALECT.isPrompt(lines, i)) }
const busy = (text: string): boolean => CLAUDE_DIALECT.busy(text, '')
const answers = (text: string): string[] => text.split('\n').filter(l => /^●\s*\S/.test(l)).map(l => l.replace(/^●\s*/, '').trim())
function inputText(text: string): string {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) if (CLAUDE_DIALECT.isPrompt(lines, i)) return CLAUDE_DIALECT.inputText(lines, i)
  return ''
}

async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms
  let last: unknown
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v as T } catch (e) { last = e }
    await sleep(200)
  }
  throw new Error(`timed out: ${what}${last ? ` (${(last as Error).message})` : ''}`)
}

test('context pad: statusline header, /context measure, plain terminal, no polling when hidden', { timeout: 600_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(shots, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-appcontext-'))
  const work = mkdtempSync(join(tmpdir(), 'tether-appcontext-work-'))
  const daemons: Owned[] = []
  const trees: Proc[][] = []
  let readyAt = 0
  let app: ElectronApplication | undefined
  try {
    const env = cleanEnv()
    env.TETHER_PIPE = pipe; env.TETHER_HOME = home; env.TETHER_E2E_HIDDEN = '1'; env.TETHER_CLAUDE_ARGS = '--model haiku'
    app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
    app.context().on('dialog', () => {})
    const page = await app.firstWindow()
    page.setDefaultTimeout(10_000)
    await page.waitForSelector('#conn.on', { timeout: 30_000 })
    page.on('pageerror', e => console.error(`renderer error: ${e.message}`))
    page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.error('renderer ' + m.type() + ': ' + m.text()) })
    daemons.push(await claim((await page.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1400, 900))

    // The extension must activate in the real app: its icon is on the right bar and its command is known (regression: activeId() threw at activation).
    assert.ok((await page.evaluate(() => (window.__tether.sidebars() as unknown as { right: { strip: string[] } }).right.strip)).includes(PAD_ID), 'context.inspector is on the right bar')
    const text = (id: string) => page.evaluate(id => window.__tether.text(id), id)
    const waitPanel = async (id: string, cond: (t: string) => boolean, what: string, timeout = 90_000, quietMs = 0): Promise<string> => {
      const deadline = Date.now() + timeout
      let last = '', since = Date.now()
      for (;;) {
        const t = await text(id)
        if (t !== last) { last = t; since = Date.now() }
        if (cond(t) && Date.now() - since >= quietMs) return t
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}\n--- panel ---\n${t}`)
        await sleep(150)
      }
    }
    const focusPanel = (id: string) => page.locator(`.panel[data-slot-id="${id}"] .panel-term`).click()
    const newPanel = async (kind: string): Promise<void> => {
      await page.click('#btn-new')
      await page.waitForSelector('#dlg-new[open]')
      await page.fill('#dlg-new .ch-path-input', work)
      await page.click(`#dlg-new .ch-item[data-id="${kind}"]`)
      await page.click('#dlg-new .btn.primary.go')
      await page.waitForFunction(() => !document.querySelector('#dlg-new[open]'))
    }

    // ---- 1. Claude panel, short prompt, answer ----
    await newPanel('claude')
    const [id1] = await until('panel', async () => { const i = await page.evaluate(() => window.__tether.panelIds()); return i.length ? i : undefined })
    await waitPanel(id1!, t => TRUST.test(t) || hasPrompt(t), 'trust or prompt')
    if (TRUST.test(await text(id1!))) {
      await focusPanel(id1!)
      await waitPanel(id1!, () => true, 'trust settle', 10_000, 500)
      for (let a = 1; ; a++) {
        await page.keyboard.press('ArrowDown')
        await waitPanel(id1!, t => TRUST_YES.test(t), 'Yes highlighted', 5_000)
        if (TRUST_YES.test(await waitPanel(id1!, () => true, 'settle', 5_000, 400))) break
        if (a === 3) throw new Error('trust dialog keeps resetting')
      }
      await page.keyboard.press('Enter')
      await waitPanel(id1!, t => !TRUST.test(t) && hasPrompt(t), 'prompt after trust')
    }
    readyAt = Date.now()
    await waitPanel(id1!, t => hasPrompt(t) && !busy(t), 'idle prompt', 90_000, 1_500)
    const prompt = 'responda apenas: tamarindo'
    const before = answers(await text(id1!)).length
    for (let a = 1; ; a++) {
      await focusPanel(id1!)
      await page.keyboard.type(prompt, { delay: 10 })
      try { await waitPanel(id1!, t => inputText(t).includes(prompt), 'echo', 5_000); break } catch (e) { if (a === 3) throw e }
    }
    for (let a = 1; ; a++) {
      await page.keyboard.press('Enter')
      try { await waitPanel(id1!, t => busy(t) || !inputText(t).includes(prompt), 'accepted', 4_000); break } catch (e) { if (a === 3) throw e }
    }
    const done = await waitPanel(id1!, t => answers(t).length > before && hasPrompt(t) && !busy(t), 'answer', 90_000, 700)
    assert.match(answers(done).at(-1) ?? '', /tamarindo/i)
    const slot = (await page.evaluate(() => window.__tether.slots())).find(s => s.slotId === id1)!
    trees.push(await processTree(slot.pid!))

    // ---- count the main's snapshot handler calls (Electron keeps the invoke handlers in a Map) ----
    const installed = await app.evaluate(({ ipcMain }) => {
      const m = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers
      const orig = m.get('ext:context:snapshot')
      if (!orig) return false
      const g = globalThis as unknown as { __snapCalls: number }
      g.__snapCalls = 0
      m.set('ext:context:snapshot', (...a: unknown[]) => { g.__snapCalls++; return orig(...a) })
      return true
    })
    assert.ok(installed, 'ext:context:snapshot handler registered in main')
    const calls = (): Promise<number> => app!.evaluate(() => (globalThis as unknown as { __snapCalls: number }).__snapCalls)

    // ---- 2. open the pad by the command ----
    assert.equal(await page.evaluate(() => window.__tether.runCommand('context.open')), 'ran')
    await page.waitForSelector(PAD)
    assert.equal((await page.evaluate(() => window.__tether.sidebars())).right.open, PAD_ID)
    await focusPanel(id1!) // the pad follows the focused panel

    // ---- 3. header from the statusline ----
    const file = join(home, 'context', `${id1}.json`)
    await until('statusline file', async () => existsSync(file), 15_000).catch(() => { throw new Error(`statusline file ${file} was never written`) })
    const sum = JSON.parse(readFileSync(file, 'utf8')) as { model?: { display_name?: string } }
    assert.ok(sum.model?.display_name, 'statusline file has the model')
    const head = await until('header with model, % and cost', async () => {
      const t = await page.locator(`${PAD} .cx-head`).innerText()
      return /tokens \(/.test(t) && /sessão/.test(t) ? t : undefined
    }, 30_000)
    assert.ok(head.includes(sum.model!.display_name!), `header shows the model: ${head}`)
    assert.match(head, /\d+(,\d+)?\s?%/)
    assert.match(head, /sessão .*\d/)
    await page.screenshot({ path: join(shots, 'context-header.png') })

    // ---- 4. Medir ----
    const setTheme = async (scheme: 'light' | 'dark'): Promise<void> => {
      await page.click('#btn-theme')
      await page.click(`#theme-menu li[data-theme="${scheme}"]`)
      await page.waitForFunction(s => document.documentElement.dataset.theme === s, scheme)
      await sleep(300)
    }
    await page.locator(`${PAD} .cx-btn`, { hasText: /^Medir$/ }).click()
    const note = await until('measured note', async () => {
      const t = await page.locator(`${PAD} .cx-note`).allInnerTexts()
      return t.find(x => /medido pelo \/context/.test(x))
    }, 90_000)
    assert.match(note, /medido pelo \/context/)
    const legend = await page.locator(`${PAD} .cx-legend`).innerText()
    assert.match(legend, /System prompt/i)
    assert.match(legend, /Free space/i)
    await sleep(500)
    await setTheme('dark')
    await page.screenshot({ path: join(shots, 'context-measured-dark.png') })
    await page.locator(PAD).screenshot({ path: join(shots, 'context-pad-dark.png') })
    await setTheme('light')
    await page.screenshot({ path: join(shots, 'context-measured-light.png') })
    await page.locator(PAD).screenshot({ path: join(shots, 'context-pad-light.png') })

    // ---- visible pad polls ----
    const c0 = await calls(); await sleep(5_000); const c1 = await calls()
    assert.ok(c1 - c0 >= 1, `visible pad polls (${c1 - c0} calls in 5 s)`)

    // ---- 5. a plain terminal ----
    await newPanel('powershell')
    const id2 = (await until('second panel', async () => { const i = await page.evaluate(() => window.__tether.panelIds()); return i.length > 1 ? i : undefined })).find(i => i !== id1)!
    await focusPanel(id2)
    await until('terminal message', async () => /terminal comum/.test(await page.locator(PAD).innerText()), 10_000)
    await page.screenshot({ path: join(shots, 'context-unsupported.png') })
    await page.locator('.tether-tab').first().click()
    await focusPanel(id1!)
    await until('header back', async () => /tokens \(/.test(await page.locator(`${PAD} .cx-head`).innerText()), 15_000)

    // ---- 6. hidden: no polling for 6 s ----
    await page.evaluate(id => window.__tether.togglePad(id), PAD_ID)
    await until('pad closed', async () => (await page.evaluate(() => window.__tether.sidebars())).right.open !== PAD_ID, 5_000)
    await sleep(700)
    const h0 = await calls(); await sleep(6_000); const h1 = await calls()
    assert.equal(h1 - h0, 0, `hidden pad made ${h1 - h0} snapshot calls in 6 s`)
  } finally {
    if (readyAt) { const w = readyAt + MIN_UPTIME_MS - Date.now(); if (w > 0) await sleep(w) }
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) {
      if (!pidAlive(d.pid)) continue
      try {
        const client = await DaemonClient.connect({ home, pipe, client: 'test', spawn: false })
        await client.request({ t: 'shutdown' }).catch(() => {})
        client.close()
      } catch { /* not answering */ }
      const end = Date.now() + 10_000
      while (pidAlive(d.pid) && Date.now() < end) await sleep(300)
      if (pidAlive(d.pid)) await killOwned(d, { tree: true })
    }
    await killTestPtyd(home) // the pane host outlives its daemon by design
    let left = await aliveProcs(trees.flat())
    for (let i = 0; i < 20 && left.length; i++) { await sleep(500); left = await aliveProcs(trees.flat()) }
    for (const p of left) await killOwned(p, { tree: true })
    for (const dir of [home, work]) for (let i = 0; i < 5; i++) { try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) } }
    assert.deepEqual(left.map(p => `${p.pid} ${p.name}`), [], 'orphan processes after the test')
  }
})
