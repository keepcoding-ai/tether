// E2E of the two new-panel operations (hidden windows, private home/pipe, real tetherd, real Claude on haiku,
// CLAUDE* stripped from the environment):
//   1. "Novo painel…" (Ctrl+Shift+T, toolbar, ≡ menu, tab menu) opens the chooser; with no panel there is no
//      "Onde" row; a Claude panel is opened from it and answers a seed word;
//   2. "Duplicar painel" (Ctrl+Alt+→ from inside the terminal): a second Claude panel appears to the RIGHT of
//      the first with the same folder and profile, as a NEW session (different session id, `--session-id` and no
//      `--resume` on its command line), and answers its own seed;
//   3. the chooser's "Onde" row: a PowerShell panel opened BELOW the first panel;
//   4. Ctrl+Alt+← on the shell duplicates it to the LEFT (same profile, same folder); the test hook duplicates
//      ABOVE;
//   5. the ≡ menu and the tab's right-click menu carry both operations; the tab's "Novo painel…" opens the
//      chooser relative to that panel.
// No Claude is killed before 11 s of life; kills via test/kill.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { canonicalDir } from '../../src/core/paths.ts'
import { DaemonClient } from '../../src/daemon/client.ts'
import type { Profile, SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { aliveProcs, CLAUDE_DIALECT, processTree, type Proc } from './harness.ts'

type Hooks = {
  panelIds(): string[]
  activeId(): string | undefined
  slots(): SlotState[]
  text(id: string): string
  connection(): { connected: boolean; pid?: number } | undefined
  activate(id: string): void
  profiles(): Profile[]
  duplicate(id: string, direction: 'left' | 'right' | 'above' | 'below'): void
}
declare const window: { __tether: Hooks }
declare const document: { querySelectorAll(selector: string): { length: number }; querySelector(selector: string): { dataset: Record<string, string> } | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-dup-${process.pid}`
const MIN_UPTIME_MS = 11_000
const SEED1 = 'jabuticaba'
const SEED2 = 'pitanga'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timeout (${timeoutMs} ms) waiting for ${what}`)
    await sleep(150)
  }
}

/** The app with a private home/pipe, hidden, Claude on haiku, and no CLAUDE* inherited from a parent Claude session. */
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
  page.on('console', m => { if (m.type() === 'error') console.error(`renderer console: ${m.text()}`) })
  await page.waitForSelector('#conn.on', { timeout: 30_000 })
  return { app, page }
}

const hooks = {
  ids: (page: Page) => page.evaluate(() => window.__tether.panelIds()),
  active: (page: Page) => page.evaluate(() => window.__tether.activeId()),
  text: (page: Page, id: string) => page.evaluate(id => window.__tether.text(id), id),
  slots: (page: Page) => page.evaluate(() => window.__tether.slots()),
  slot: async (page: Page, id: string) => (await hooks.slots(page)).find(s => s.slotId === id),
  daemonPid: async (page: Page) => (await page.evaluate(() => window.__tether.connection()))?.pid,
  activate: (page: Page, id: string) => page.evaluate(id => window.__tether.activate(id), id),
}

async function waitRunning(page: Page, id: string): Promise<number> {
  await page.waitForFunction(id => { const s = window.__tether.slots().find(x => x.slotId === id); return s?.status === 'running' && typeof s.pid === 'number' }, id, { timeout: 60_000 })
  return (await hooks.slot(page, id))!.pid!
}

/** Waits for one more panel than `before` and returns the id of the newcomer. */
async function waitNewPanel(page: Page, before: string[]): Promise<string> {
  await page.waitForFunction(n => window.__tether.panelIds().length === n, before.length + 1, { timeout: 20_000 })
  const ids = await hooks.ids(page)
  const fresh = ids.filter(id => !before.includes(id))
  assert.equal(fresh.length, 1, `exactly one new panel: ${ids.join(', ')}`)
  return fresh[0]!
}

type Box = { x: number; y: number; width: number; height: number }
async function boxOf(page: Page, id: string): Promise<Box> {
  const box = await page.locator(`.panel[data-slot-id="${id}"]`).boundingBox()
  assert.ok(box, `panel ${id} is laid out`)
  return box
}
const rightOf = (a: Box, b: Box): boolean => a.x >= b.x + b.width - 2 && Math.abs(a.y - b.y) < 4
const leftOf = (a: Box, b: Box): boolean => a.x + a.width <= b.x + 2 && Math.abs(a.y - b.y) < 4
const belowOf = (a: Box, b: Box): boolean => a.y >= b.y + b.height - 2 && Math.abs(a.x - b.x) < 4
const aboveOf = (a: Box, b: Box): boolean => a.y + a.height <= b.y + 2 && Math.abs(a.x - b.x) < 4

// ---------- Claude's TUI off the panel (same dance as app.switch-profile) ----------

const TRUST = /trust this folder/i
const TRUST_YES = /^\s*❯\s*Yes, I trust/m
const BYPASS = /bypass permissions mode/i
const BYPASS_YES = /^\s*❯\s*(\d+\.\s*)?Yes, I accept/m
const hasPrompt = (text: string): boolean => { const lines = text.split('\n'); return lines.some((_, i) => CLAUDE_DIALECT.isPrompt(lines, i)) }
const busy = (text: string): boolean => CLAUDE_DIALECT.busy(text, '')
const answers = (text: string): string[] => text.split('\n').filter(l => /^●\s*\S/.test(l)).map(l => l.replace(/^●\s*/, '').trim())
function inputText(text: string): string {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) if (CLAUDE_DIALECT.isPrompt(lines, i)) return CLAUDE_DIALECT.inputText(lines, i)
  return ''
}

async function waitPanel(page: Page, id: string, cond: (text: string) => boolean, opts: { timeout?: number; quietMs?: number; what: string }): Promise<string> {
  const timeout = opts.timeout ?? 60_000, quietMs = opts.quietMs ?? 0
  const deadline = Date.now() + timeout
  let last = '', stableSince = Date.now()
  for (;;) {
    const text = await hooks.text(page, id)
    const now = Date.now()
    if (text !== last) { last = text; stableSince = now }
    if (cond(text) && now - stableSince >= quietMs) return text
    if (now > deadline) throw new Error(`timeout (${timeout} ms) waiting for ${opts.what} on panel ${id}\n--- panel ---\n${text}`)
    await sleep(150)
  }
}

async function focusPanel(page: Page, id: string): Promise<void> {
  await hooks.activate(page, id)
  await page.locator(`.panel[data-slot-id="${id}"] .panel-term`).click()
}

async function acceptDialog(page: Page, id: string, yes: RegExp, what: string): Promise<void> {
  await focusPanel(page, id)
  await waitPanel(page, id, () => true, { quietMs: 500, what: `${what} dialog to settle` })
  for (let attempt = 1; ; attempt++) {
    await page.keyboard.press('ArrowDown')
    await waitPanel(page, id, t => yes.test(t), { timeout: 5_000, what: `${what} "Yes" highlighted` })
    const t = await waitPanel(page, id, () => true, { quietMs: 400, what: `${what} selection to settle` })
    if (yes.test(t)) break
    if (attempt === 3) throw new Error(`${what} dialog keeps resetting its selection\n--- panel ---\n${t}`)
  }
  await page.keyboard.press('Enter')
}

async function awaitClaude(page: Page, id: string): Promise<number> {
  let readyAt = Date.now()
  for (let round = 0; round < 3; round++) {
    await waitPanel(page, id, t => TRUST.test(t) || BYPASS.test(t) || hasPrompt(t), { timeout: 90_000, what: 'trust/bypass dialog or input prompt' })
    const text = await hooks.text(page, id)
    if (TRUST.test(text)) { await acceptDialog(page, id, TRUST_YES, 'trust'); await waitPanel(page, id, t => !TRUST.test(t), { timeout: 90_000, what: 'trust dialog gone' }); readyAt = Date.now(); continue }
    if (BYPASS.test(text)) { await acceptDialog(page, id, BYPASS_YES, 'bypass'); await waitPanel(page, id, t => !BYPASS.test(t), { timeout: 90_000, what: 'bypass dialog gone' }); readyAt = Date.now(); continue }
    break
  }
  await waitPanel(page, id, t => hasPrompt(t) && !busy(t), { quietMs: 1_500, timeout: 90_000, what: 'idle prompt' })
  return readyAt
}

async function ask(page: Page, id: string, prompt: string): Promise<string> {
  const before = answers(await hooks.text(page, id)).length
  for (let attempt = 1; ; attempt++) {
    await focusPanel(page, id)
    const typed = inputText(await hooks.text(page, id))
    for (let i = 0; i < typed.length; i++) await page.keyboard.press('Backspace')
    await page.keyboard.type(prompt, { delay: 10 })
    try { await waitPanel(page, id, t => inputText(t).includes(prompt), { timeout: 5_000, what: `echo of "${prompt}"` }); break } catch (e) { if (attempt === 3) throw e }
  }
  for (let attempt = 1; ; attempt++) {
    await page.keyboard.press('Enter')
    try { await waitPanel(page, id, t => busy(t) || !inputText(t).includes(prompt), { timeout: 4_000, what: `"${prompt}" to be accepted` }); break } catch (e) { if (attempt === 3) throw e }
  }
  const text = await waitPanel(page, id, t => answers(t).length > before && hasPrompt(t) && !busy(t) && !inputText(t).includes(prompt), { quietMs: 700, timeout: 90_000, what: `an answer to "${prompt}"` })
  return answers(text).at(-1) ?? ''
}

async function untilUptime(readyAt: Map<string, number>): Promise<void> {
  const wait = Math.max(0, ...[...readyAt.values()].map(t => t + MIN_UPTIME_MS - Date.now()))
  if (wait > 0) await sleep(wait)
}

async function shoot(page: Page, name: string): Promise<void> {
  await sleep(300)
  await page.screenshot({ path: join(artifacts, `${name}.png`) })
}

async function setTheme(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  await page.click('#btn-menu')
  await page.waitForSelector('#app-menu:not([hidden])')
  await page.click(`#app-menu li[data-theme="${scheme}"]`)
  await page.waitForFunction(s => document.querySelector('html')?.dataset.theme === s, scheme)
}

async function cmdOf(pid: number, trees: Proc[][]): Promise<string> {
  const tree = await processTree(pid)
  trees.push(tree)
  const self = tree.find(p => p.pid === pid)
  assert.ok(self?.cmd, `command line of pid ${pid}`)
  return self.cmd
}

const placementChecked = (page: Page, placement: string): Promise<boolean> =>
  page.locator(`#dlg-new .placement[data-level="pane"][data-placement="${placement}"]`).getAttribute('aria-pressed').then(v => v === 'true')

/** In the open chooser popup: a folder and (when offered) a placement, then a click on the profile opens it; returns the new panel's id. */
async function newPanelViaChooser(page: Page, profileId: string, cwd: string, placement?: string): Promise<string> {
  const before = await hooks.ids(page)
  const dlg = page.locator('#dlg-new[open]')
  await dlg.waitFor()
  await page.fill('#dlg-new .ch-path-input', cwd)
  if (placement) {
    // "Onde" is one line until opened; the chips are buttons. Pane level: the same direction also exists at the frame and desk levels (phase B).
    await page.click('#dlg-new .where-sum')
    await page.click(`#dlg-new .placement[data-level="pane"][data-placement="${placement}"]`)
    assert.ok(await placementChecked(page, placement), `placement ${placement} chosen`)
  }
  await page.click(`#dlg-new .ch-item[data-id="${profileId}"]`)
  await dlg.waitFor({ state: 'hidden' })
  return waitNewPanel(page, before)
}

test('new panel: "Novo painel…" chooses; "Duplicar painel" clones profile + folder into a NEW session beside the focused panel', async t => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-dup-'))
  const work = canonicalDir(mkdtempSync(join(tmpdir(), 'tether-dup-work-')))
  const daemons: Owned[] = []
  const trees: Proc[][] = []
  const readyAt = new Map<string, number>()
  let app: ElectronApplication | undefined
  let failed = true
  const evidence: Record<string, unknown> = {}
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await hooks.daemonPid(page))!
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await setTheme(page, 'dark')
    await page.waitForFunction(() => window.__tether.profiles().length >= 3)

    // ---- 1. the toolbar names the two operations; Ctrl+Shift+T opens the chooser; no "Onde" row without a panel ----
    assert.equal(await page.locator('#btn-new').getAttribute('aria-label'), 'Novo painel…')
    assert.equal(await page.locator('#btn-duplicate').getAttribute('aria-label'), 'Duplicar painel')
    assert.equal(await page.locator('#btn-split-right, #btn-split-down').count(), 0, 'the old "Direita"/"Abaixo" clone buttons are gone')
    await page.click('#btn-new')
    await page.locator('#dlg-new[open]').waitFor()
    assert.equal(await page.locator('#dlg-new .where').count(), 0, 'nothing to be relative to: no "Onde" row')
    await shoot(page, 'new-panel-chooser-first-dark')
    const id1 = await newPanelViaChooser(page, 'claude', work)
    readyAt.set(id1, await awaitClaude(page, id1))
    const pid1 = await waitRunning(page, id1)
    const cmd1 = await cmdOf(pid1, trees)
    const a1 = await ask(page, id1, `responda apenas: ${SEED1}`)
    assert.match(a1, new RegExp(SEED1, 'i'), `answered the seed: ${JSON.stringify(a1)}`)
    const slot1 = (await hooks.slot(page, id1))!
    const session1 = slot1.binding!.sessionId
    assert.match(session1, /^[0-9a-f-]{36}$/, 'a session id is bound')
    assert.equal(slot1.profileId, 'claude')
    evidence.first = { id: id1, pid: pid1, session: session1, cmd: cmd1 }
    t.diagnostic(`panel 1 ${id1}: claude pid ${pid1}, session ${session1}`)

    // ---- 2. Ctrl+Alt+→ inside the terminal: a duplicate to the right, same folder + profile, NEW session ----
    await focusPanel(page, id1)
    const beforeDup = await hooks.ids(page)
    await page.keyboard.press('Control+Alt+ArrowRight')
    const id2 = await waitNewPanel(page, beforeDup)
    assert.notEqual(id2, id1)
    assert.equal(await hooks.active(page), id2, 'the duplicate takes the focus')
    const slot2 = (await hooks.slot(page, id2))!
    assert.deepEqual([slot2.kind, slot2.cwd, slot2.profileId], ['claude', work, 'claude'], 'same agent, folder and profile')
    assert.ok(rightOf(await boxOf(page, id2), await boxOf(page, id1)), 'the duplicate sits to the right of the source')
    readyAt.set(id2, await awaitClaude(page, id2))
    const pid2 = await waitRunning(page, id2)
    assert.notEqual(pid2, pid1)
    const cmd2 = await cmdOf(pid2, trees)
    await page.waitForFunction(id => /^[0-9a-f-]{36}$/.test(window.__tether.slots().find(x => x.slotId === id)?.binding?.sessionId ?? ''), id2, { timeout: 30_000 })
    const session2 = (await hooks.slot(page, id2))!.binding!.sessionId
    assert.notEqual(session2, session1, 'a duplicate is a NEW session')
    assert.ok(cmd2.includes(`--session-id ${session2}`), `the duplicate was launched with its own --session-id: ${cmd2}`)
    assert.ok(!cmd2.includes('--resume'), `the duplicate does not resume the source's session: ${cmd2}`)
    assert.ok(cmd2.includes('--model haiku'), `TETHER_CLAUDE_ARGS applied: ${cmd2}`)
    assert.equal((await hooks.slot(page, id1))!.binding!.sessionId, session1, 'the source keeps its session')
    const a2 = await ask(page, id2, `responda apenas: ${SEED2}`)
    assert.match(a2, new RegExp(SEED2, 'i'), `the duplicate answers on its own: ${JSON.stringify(a2)}`)
    await shoot(page, 'duplicate-right-dark')
    evidence.duplicate = { id: id2, pid: pid2, session: session2, cmd: cmd2 }
    t.diagnostic(`panel 2 ${id2}: claude pid ${pid2}, session ${session2} (≠ ${session1})`)

    // ---- 3. the chooser's "Onde" row: a PowerShell panel below panel 1 ----
    await setTheme(page, 'light')
    await focusPanel(page, id1)
    await page.click('#btn-new')
    await page.locator('#dlg-new[open]').waitFor()
    assert.ok(await page.locator('#dlg-new .where').isVisible(), 'the "Onde" row is offered relative to the active panel')
    assert.match(await page.locator('#dlg-new .where-sum .w').innerText(), /^como aba, ao lado de /, '"como aba" is the default, in one line')
    await page.click('#dlg-new .where-sum')
    assert.equal(await page.locator('#dlg-new .placement[data-level="pane"]').count(), 5, 'pane level: como aba + four directions')
    assert.equal(await page.locator('#dlg-new .placement-group').count(), 3, 'three levels (pane / frame / desk)')
    assert.ok(await placementChecked(page, 'within'), '"nesta aba" is the default')
    await shoot(page, 'new-panel-chooser-placement-light')
    const id3 = await newPanelViaChooser(page, 'powershell', work, 'below')
    const slot3 = (await hooks.slot(page, id3))!
    assert.deepEqual([slot3.kind, slot3.cwd, slot3.profileId], ['shell', work, 'powershell'])
    assert.ok(belowOf(await boxOf(page, id3), await boxOf(page, id1)), 'the shell sits below panel 1')
    await waitRunning(page, id3)
    t.diagnostic(`panel 3 ${id3}: powershell below panel 1`)

    // ---- 4. Ctrl+Alt+← on the shell duplicates it to the left; the hook duplicates above ----
    await focusPanel(page, id3)
    const beforeLeft = await hooks.ids(page)
    await page.keyboard.press('Control+Alt+ArrowLeft')
    const id4 = await waitNewPanel(page, beforeLeft)
    const slot4 = (await hooks.slot(page, id4))!
    assert.deepEqual([slot4.kind, slot4.cwd, slot4.profileId], ['shell', work, 'powershell'], 'the shell duplicate keeps profile and folder')
    assert.ok(leftOf(await boxOf(page, id4), await boxOf(page, id3)), 'the duplicate sits to the left of the shell')
    const beforeAbove = await hooks.ids(page)
    await page.evaluate(id => window.__tether.duplicate(id, 'above'), id4)
    const id5 = await waitNewPanel(page, beforeAbove)
    assert.ok(aboveOf(await boxOf(page, id5), await boxOf(page, id4)), 'the hook duplicate sits above its source')
    await waitRunning(page, id4)
    await waitRunning(page, id5)
    await shoot(page, 'duplicate-grid-light')
    t.diagnostic(`panels 4/5 ${id4}/${id5}: shells left of and above`)

    // ---- 5. both operations in the ≡ menu and in the tab menu; the tab's "Novo painel…" is relative to that tab ----
    await page.click('#btn-menu')
    await page.waitForSelector('#app-menu:not([hidden])')
    assert.equal(await page.locator('#app-menu li[data-command="pane.new"]').textContent(), 'Novo painel…')
    assert.equal(await page.locator('#app-menu li[data-command="pane.new-tab"]').textContent(), 'Nova aba neste grupoCtrl+Shift+T')
    assert.equal(await page.locator('#app-menu li[data-command="pane.duplicate.pane.right"]').getAttribute('aria-disabled'), 'false')
    assert.equal(await page.locator('#app-menu li[data-command="pane.duplicate.pane.below"]').count(), 1)
    await page.keyboard.press('Escape')
    await page.waitForSelector('#app-menu[hidden]', { state: 'attached' })
    // Panel 1 is alone in its group: its tab is the one in the group that holds its content.
    await page.locator(`.dv-groupview:has(.panel[data-slot-id="${id1}"]) .tether-tab`).click({ button: 'right' })
    await page.waitForSelector('#ctx-menu')
    const items = await page.locator('#ctx-menu li[role=menuitem]').allTextContents()
    // Grouped (separators between): open next to it; name and profile; the status bar; where it lives; close.
    const want = [
      'Novo painel…', 'Duplicar painel à direita', 'Duplicar painel abaixo', 'Novo painel na borda do quadro…', 'Novo quadro…',
      'Renomear…', 'Trocar perfil…',
      'Mostrar barra de status', 'Copiar pasta', 'Abrir pasta no Explorer',
      'Mover…',
      'Fechar painel…',
    ]
    assert.deepEqual(items, want)
    assert.equal(await page.locator('#ctx-menu li.sep').count(), 4)
    // "⋯" at the strip's right end opens the same menu (one source).
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('#ctx-menu'))
    await page.locator(`.dv-groupview:has(.panel[data-slot-id="${id1}"]) .dv-right-actions-container [data-action="pane-menu"]`).click()
    await page.waitForSelector('#ctx-menu')
    assert.deepEqual(await page.locator('#ctx-menu li[role=menuitem]').allTextContents(), want)
    await page.click('#ctx-menu li:has-text("Novo painel…")')
    await page.locator('#dlg-new[open]').waitFor()
    assert.ok(await page.locator('#dlg-new .where').isVisible())
    const s1 = (await hooks.slot(page, id1))!
    assert.equal(await page.locator('#dlg-new .where-sum .w').innerText(), `como aba, ao lado de ${s1.title ?? s1.name ?? basename(work)}`, 'relative to the right-clicked panel')
    await page.keyboard.press('Escape')
    await page.locator('#dlg-new[open]').waitFor({ state: 'hidden' })
    assert.equal((await hooks.ids(page)).length, 5, 'Esc opened nothing')
    t.diagnostic(`evidence: ${JSON.stringify(evidence)}`)
    failed = false
  } finally {
    if (failed) {
      try { console.error(`--- tetherd.log ---\n${readFileSync(join(home, 'tetherd.log'), 'utf8').slice(-3000)}`) } catch { /* no log */ }
      try { for (const f of readdirSync(join(home, 'slots'))) if (f.endsWith('.json')) console.error(`--- ${f} ---\n${readFileSync(join(home, 'slots', f), 'utf8')}`) } catch { /* no slots */ }
    }
    await untilUptime(readyAt)
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) {
      if (!pidAlive(d.pid)) continue
      try {
        const client = await DaemonClient.connect({ home, pipe, client: 'test', spawn: false })
        await client.request({ t: 'shutdown' }).catch(() => {})
        client.close()
      } catch { /* not answering */ }
      await waitUntil(() => !pidAlive(d.pid), 10_000, 'tetherd to exit').catch(async () => { await killOwned(d, { tree: true }) })
    }
    const deadline = Date.now() + 15_000
    let left = await aliveProcs(trees.flat())
    while (left.length && Date.now() < deadline) { await sleep(500); left = await aliveProcs(trees.flat()) }
    for (const p of left) await killOwned(p, { tree: true })
    for (const dir of [home, work]) {
      for (let i = 0; i < 5; i++) { try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) } }
    }
    assert.deepEqual(left.map(p => `${p.pid} ${p.name}`), [], 'orphan processes after the test')
  }
})

test('fullscreen canary: ~/.claude.json has no fullscreenAutoDisabled after the duplicate test', () => {
  const p = join(homedir(), '.claude.json')
  const cfg = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown> : {}
  assert.ok(!cfg.fullscreenAutoDisabled, 'fullscreenAutoDisabled is set: a Claude session died before 10 s of life; run /tui fullscreen')
})
