// Acceptance proof of the app with the REAL Claude Code, driven the way the user drives it (clicks and keys in
// the renderer; the daemon is never asked anything by the test):
//   1. fresh home → "+ Novo painel" → Claude in a temp folder → trust dialog accepted with the keyboard →
//      "responda apenas: tamarindo" → the answer shows up in the panel's xterm;
//   2. Ctrl+Shift+D → a second Claude panel in the same folder → "responda apenas: carambola";
//   3. kill the Electron main by PID (window crash) → relaunch → both panels back, same slot ids, same claude
//      PIDs (the agents never died), scrollback shows the answers, panel 1 recalls tamarindo;
//   4. kill the daemon by PID (reboot) → relaunch → both panels resume (running) on their previous session ids
//      (the slot jsonl says so), panel 2 recalls carambola.
// Claude runs with --model haiku through TETHER_CLAUDE_ARGS; no Claude session is killed before 11 s of life
// (fullscreen canary, see harness.ts). Windows stay hidden. Screenshots go to test/e2e/artifacts/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { readEvents } from '../../src/core/store.ts'
import { DaemonClient } from '../../src/daemon/client.ts'
import { killTree } from '../../src/daemon/pty.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { aliveProcs, CLAUDE_DIALECT, processTree, type Proc } from './harness.ts'

// Browser-side globals used inside page.evaluate callbacks (this tsconfig has no DOM lib).
type Hooks = {
  panelIds(): string[]
  slots(): SlotState[]
  text(id: string): string
  connection(): { connected: boolean; pid?: number } | undefined
}
declare const window: { __tether: Hooks }
declare const document: { querySelectorAll(selector: string): { length: number }; querySelector(selector: string): { dataset: Record<string, string> } | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-appclaude-${process.pid}`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** Claude Code counts a fullscreen session that dies within 10 s as a boot strike (see harness.ts). */
const MIN_UPTIME_MS = 11_000

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

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise(res => { if (child.exitCode !== null) res(); else child.once('exit', () => res()) })
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_')) env[k] = v
  env.TETHER_PIPE = pipe
  env.TETHER_HOME = home
  env.TETHER_E2E_HIDDEN = '1'
  env.TETHER_CLAUDE_ARGS = '--model haiku'
  for (let attempt = 1; ; attempt++) {
    try {
      const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
      const page = await app.firstWindow()
      page.setDefaultTimeout(10_000)
      await page.waitForSelector('#conn.on', { timeout: 30_000 })
      return { app, page }
    } catch (e) {
      // A relaunch right after a window kill can still find Chromium's single-instance lock held by a dying
      // helper of the old instance; the app then quits as a "second instance". Once more, after a pause.
      if (attempt === 2 || !/Lock file can not be created|ECONNRESET|Target page, context or browser has been closed/.test(String(e))) throw e
      await sleep(2_000)
    }
  }
}

/** Kills the Electron main process by PID (see app.layout.test.ts for why the launcher is handled apart), then
 *  waits for its helper processes (GPU, renderer, network) to be gone too: they hold the user-data lock and
 *  cache for a moment, and the next launch must not race them. The detached tetherd is a child of main as well
 *  and is left alone. */
async function killElectron(app: ElectronApplication, keep: number[] = []): Promise<void> {
  const mainPid = await app.evaluate(() => process.pid)
  // The daemon (spawned by main) and everything under it (conhost, claude and its helpers) are not helpers of the window.
  const spare = new Set<number>()
  for (const p of await processTree(mainPid)) if (keep.includes(p.pid) || /src[\\/]daemon[\\/]main\.ts/.test(p.cmd ?? '')) for (const q of await processTree(p.pid)) spare.add(q.pid)
  const tree = (await processTree(mainPid)).filter(p => !spare.has(p.pid))
  const launcher = app.process()
  process.kill(mainPid)
  if (launcher.pid && launcher.pid !== mainPid) {
    await Promise.race([waitForExit(launcher), sleep(3000)])
    if (launcher.exitCode === null) process.kill(launcher.pid)
  }
  await waitForExit(launcher)
  const left = await waitGone(tree, 10_000)
  for (const p of left) { try { process.kill(p.pid) } catch { /* gone meanwhile */ } }
}

const hooks = {
  ids: (page: Page) => page.evaluate(() => window.__tether.panelIds()),
  text: (page: Page, id: string) => page.evaluate(id => window.__tether.text(id), id),
  slots: (page: Page) => page.evaluate(() => window.__tether.slots()),
  daemonPid: async (page: Page) => (await page.evaluate(() => window.__tether.connection()))?.pid,
  status: (page: Page, id: string) => page.evaluate(id => document.querySelector(`.panel[data-slot-id="${id}"]`)?.dataset.status, id),
}

async function tabCount(page: Page, n: number): Promise<void> {
  await page.waitForFunction(n => document.querySelectorAll('.tether-tab').length === n, n, { timeout: 15_000 })
}

/** Waits until every listed slot is `running` with a pid, as the renderer sees it. */
async function waitRunning(page: Page, ids: string[]): Promise<Map<string, number>> {
  await page.waitForFunction(ids => {
    const slots = window.__tether.slots()
    return ids.every(id => { const s = slots.find(x => x.slotId === id); return s?.status === 'running' && typeof s.pid === 'number' })
  }, ids, { timeout: 60_000 })
  const pids = new Map<string, number>()
  for (const s of await hooks.slots(page)) if (ids.includes(s.slotId)) pids.set(s.slotId, s.pid!)
  return pids
}

// ---------- reading Claude's TUI off the panel's xterm buffer ----------

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

/** Polls the panel text until `cond` holds and the text has not changed for `quietMs`; rejects with the text on timeout. */
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

/** Clicks into the panel's terminal so keys go to its xterm (the panels are side by side: no tab switching). */
async function focusPanel(page: Page, id: string): Promise<void> {
  await page.locator(`.panel[data-slot-id="${id}"] .panel-term`).click()
}

/** Waits for Claude's TUI in the panel: accepts the trust dialog with the keyboard when it shows up, then the idle prompt.
 *  Returns when the prompt first appeared (for the 11 s rule). */
async function awaitClaude(page: Page, id: string): Promise<number> {
  await waitPanel(page, id, t => TRUST.test(t) || hasPrompt(t), { timeout: 90_000, what: 'trust dialog or input prompt' })
  let readyAt = Date.now()
  if (TRUST.test(await hooks.text(page, id))) {
    await focusPanel(page, id)
    // The dialog re-renders shortly after it appears and resets its selection: settle, press Down, confirm only
    // once "Yes" stays highlighted (same dance as harness.ts awaitReady).
    await waitPanel(page, id, () => true, { quietMs: 500, what: 'trust dialog to settle' })
    for (let attempt = 1; ; attempt++) {
      await page.keyboard.press('ArrowDown')
      await waitPanel(page, id, t => TRUST_YES.test(t), { timeout: 5_000, what: 'trust "Yes" highlighted' })
      const t = await waitPanel(page, id, () => true, { quietMs: 400, what: 'trust selection to settle' })
      if (TRUST_YES.test(t)) break
      if (attempt === 3) throw new Error(`trust dialog keeps resetting its selection\n--- panel ---\n${t}`)
    }
    await page.keyboard.press('Enter')
    await waitPanel(page, id, t => !TRUST.test(t) && hasPrompt(t), { timeout: 90_000, what: 'input prompt after trust' })
    readyAt = Date.now()
  }
  await waitPanel(page, id, t => hasPrompt(t) && !busy(t), { quietMs: 1_500, timeout: 90_000, what: 'idle prompt' })
  return readyAt
}

/** Types `prompt` + Enter in the panel like the user and returns Claude's newest answer line.
 *  Keys typed right after the TUI (re)started can be dropped by it, so the echo is checked and the line retyped. */
async function ask(page: Page, id: string, prompt: string): Promise<string> {
  const before = answers(await hooks.text(page, id)).length
  for (let attempt = 1; ; attempt++) {
    await focusPanel(page, id)
    const typed = inputText(await hooks.text(page, id))
    for (let i = 0; i < typed.length; i++) await page.keyboard.press('Backspace')
    await page.keyboard.type(prompt, { delay: 10 })
    try {
      await waitPanel(page, id, t => inputText(t).includes(prompt), { timeout: 5_000, what: `echo of "${prompt}"` })
      break
    } catch (e) {
      if (attempt === 3) throw e
    }
  }
  // Accepted = the line left the input box (or Claude went busy). An Enter that lands while the TUI is still
  // settling is dropped: press it again, as the user would.
  for (let attempt = 1; ; attempt++) {
    await page.keyboard.press('Enter')
    try {
      await waitPanel(page, id, t => busy(t) || !inputText(t).includes(prompt), { timeout: 4_000, what: `"${prompt}" to be accepted` })
      break
    } catch (e) {
      if (attempt === 3) throw e
    }
  }
  const text = await waitPanel(page, id, t => answers(t).length > before && hasPrompt(t) && !busy(t) && !inputText(t).includes(prompt),
    { quietMs: 700, timeout: 90_000, what: `an answer to "${prompt}"` })
  return answers(text).at(-1) ?? ''
}

/** Session id of the slot's last start event in its jsonl (what the daemon bound). */
function lastSessionId(home: string, slotId: string): string | undefined {
  return readEvents(home, slotId).filter(e => e.kind === 'start').at(-1)?.sessionId
}

async function untilUptime(readyAt: Map<string, number>): Promise<void> {
  const wait = Math.max(0, ...[...readyAt.values()].map(t => t + MIN_UPTIME_MS - Date.now()))
  if (wait > 0) await sleep(wait)
}

test('app + tetherd + Claude: two panels answer, survive a window kill (same PIDs) and resume after a daemon kill (same sessions)', async t => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-appclaude-'))
  const work = mkdtempSync(join(tmpdir(), 'tether-appclaude-work-'))
  const daemonPids: number[] = []
  const trees: Proc[][] = []
  /** When each running Claude's prompt first appeared (never kill one younger than MIN_UPTIME_MS). */
  const readyAt = new Map<string, number>()
  let app: ElectronApplication | undefined
  const evidence: Record<string, unknown> = {}
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await hooks.daemonPid(page))!
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemonPids.push(daemonPid)

    // ---- 1. "+ Novo painel" → Claude in the temp folder ----
    await page.click('#btn-new')
    await page.waitForSelector('#dlg-new[open]')
    await page.check('input[name=kind][value=claude]')
    await page.fill('#new-cwd', work)
    await page.click('#btn-create')
    await tabCount(page, 1)
    const [id1] = await hooks.ids(page)
    assert.ok(id1, 'panel 1 exists')
    readyAt.set(id1, await awaitClaude(page, id1))
    await waitRunning(page, [id1])
    const a1 = await ask(page, id1, 'responda apenas: tamarindo')
    assert.match(a1, /tamarindo/i, `panel 1 answered: ${JSON.stringify(a1)}`)

    // ---- 2. Ctrl+Shift+D → second Claude panel, same folder ----
    await focusPanel(page, id1)
    await page.keyboard.press('Control+Shift+D')
    await tabCount(page, 2)
    const id2 = (await hooks.ids(page)).find(id => id !== id1)!
    assert.ok(id2, 'panel 2 exists')
    readyAt.set(id2, await awaitClaude(page, id2))
    const pidsBefore = await waitRunning(page, [id1, id2])
    const a2 = await ask(page, id2, 'responda apenas: carambola')
    assert.match(a2, /carambola/i, `panel 2 answered: ${JSON.stringify(a2)}`)
    for (const s of await hooks.slots(page)) {
      assert.equal(s.kind, 'claude'); assert.equal(s.cwd, work)
      assert.match(s.binding?.sessionId ?? '', UUID, `slot ${s.slotId} has a session id`)
      assert.equal(s.binding!.sessionId, lastSessionId(home, s.slotId), `binding of ${s.slotId} = last start event of its jsonl`)
    }
    const sessions = new Map((await hooks.slots(page)).map(s => [s.slotId, s.binding!.sessionId]))
    assert.notEqual(sessions.get(id1), sessions.get(id2), 'two different sessions')
    for (const pid of pidsBefore.values()) trees.push(await processTree(pid))
    await sleep(800) // let the debounced layout save land
    assert.ok(existsSync(join(home, 'layout.json')), 'layout saved')
    await page.screenshot({ path: join(artifacts, 'claude-two-panels.png') })
    evidence.before = { daemonPid, slots: [id1, id2], pids: Object.fromEntries(pidsBefore), sessions: Object.fromEntries(sessions) }

    // ---- 3. window crash: kill the Electron main by PID; the agents must not notice ----
    await untilUptime(readyAt)
    await killElectron(app, daemonPids)
    app = undefined
    assert.ok(pidAlive(daemonPid), 'tetherd survived the window kill')
    for (const [id, pid] of pidsBefore) assert.ok(pidAlive(pid), `claude of ${id} (pid ${pid}) survived the window kill`)
    ;({ app, page } = await launch(home))
    assert.equal(await hooks.daemonPid(page), daemonPid, 'reconnected to the same tetherd')
    await tabCount(page, 2)
    assert.deepEqual([...(await hooks.ids(page))].sort(), [id1, id2].sort(), 'same 2 slots')
    const pidsAfter = await waitRunning(page, [id1, id2])
    assert.deepEqual([...pidsAfter].sort(), [...pidsBefore].sort(), 'same claude PIDs: the agents lived through the window kill')
    await waitPanel(page, id1, t => /tamarindo/.test(t) && hasPrompt(t), { what: 'scrollback with tamarindo' })
    await waitPanel(page, id2, t => /carambola/.test(t) && hasPrompt(t), { what: 'scrollback with carambola' })
    const r1 = await ask(page, id1, 'qual palavra você respondeu antes? só ela')
    assert.match(r1, /tamarindo/i, `panel 1 recalls after the window crash: ${JSON.stringify(r1)}`)
    await page.screenshot({ path: join(artifacts, 'claude-after-window-crash.png') })
    evidence.afterWindowCrash = { daemonPid: await hooks.daemonPid(page), pids: Object.fromEntries(pidsAfter), recalled: r1 }

    // ---- 4. reboot: kill the daemon by PID; the next launch spawns a new one and resumes both sessions ----
    await untilUptime(readyAt)
    await killElectron(app, daemonPids)
    app = undefined
    process.kill(daemonPid)
    await waitUntil(() => !pidAlive(daemonPid), 10_000, 'tetherd to die')
    // The PTYs go with the daemon; the agents die once their console is gone (a real reboot kills them anyway).
    const orphans = await waitGone(trees.flat(), 15_000)
    evidence.claudeAfterDaemonKill = orphans.length ? `still alive, killed by the test: ${orphans.map(p => `${p.pid} ${p.name}`).join(', ')}` : 'gone with the daemon'
    for (const p of orphans) await killTree(p.pid)
    ;({ app, page } = await launch(home))
    const daemonPid2 = (await hooks.daemonPid(page))!
    assert.ok(daemonPid2 && daemonPid2 !== daemonPid && pidAlive(daemonPid2), 'a new tetherd was spawned')
    daemonPids.push(daemonPid2)
    await tabCount(page, 2)
    assert.deepEqual([...(await hooks.ids(page))].sort(), [id1, id2].sort(), 'same 2 slots after the daemon restart')
    for (const id of [id1, id2]) readyAt.set(id, await awaitClaude(page, id))
    const pidsResumed = await waitRunning(page, [id1, id2])
    for (const [id, pid] of pidsResumed) { assert.notEqual(pid, pidsBefore.get(id), `slot ${id} got a new claude`); trees.push(await processTree(pid)) }
    for (const s of await hooks.slots(page)) {
      assert.equal(s.binding?.sessionId, sessions.get(s.slotId), `slot ${s.slotId} resumed its previous session`)
      assert.equal(lastSessionId(home, s.slotId), sessions.get(s.slotId), `the jsonl of ${s.slotId} shows a start of the same session`)
      assert.equal(readEvents(home, s.slotId).filter(e => e.kind === 'start').at(-1)?.source, 'resume')
      assert.equal(await hooks.status(page, s.slotId), 'running')
    }
    const r2 = await ask(page, id2, 'qual palavra você respondeu antes? só ela')
    assert.match(r2, /carambola/i, `panel 2 recalls after the daemon restart: ${JSON.stringify(r2)}`)
    await page.screenshot({ path: join(artifacts, 'claude-after-daemon-restart.png') })
    evidence.afterDaemonRestart = { daemonPid: daemonPid2, pids: Object.fromEntries(pidsResumed), sessions: Object.fromEntries((await hooks.slots(page)).map(s => [s.slotId, s.binding!.sessionId])), recalled: r2 }
    t.diagnostic(`evidence: ${JSON.stringify(evidence)}`)
  } finally {
    await untilUptime(readyAt)
    if (app) await killElectron(app, daemonPids).catch(() => {})
    // Graceful shutdown first (the daemon kills its PTY trees); by PID when it does not answer.
    for (const pid of daemonPids) {
      if (!pidAlive(pid)) continue
      try {
        const client = await DaemonClient.connect({ home, pipe, client: 'test', spawn: false })
        await client.request({ t: 'shutdown' }).catch(() => {})
        client.close()
      } catch { /* not answering */ }
      await waitUntil(() => !pidAlive(pid), 10_000, 'tetherd to exit').catch(() => { try { process.kill(pid) } catch { /* gone */ } })
    }
    const left = await waitGone(trees.flat(), 15_000)
    for (const p of left) await killTree(p.pid)
    for (const dir of [home, work]) {
      for (let i = 0; i < 5; i++) { try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) } }
    }
    assert.deepEqual(left.map(p => `${p.pid} ${p.name}`), [], 'orphan processes after the test')
  }
})

/** Polls until none of `procs` exists (pid + creation time) or `ms` elapsed; returns the leftovers. */
async function waitGone(procs: Proc[], ms: number): Promise<Proc[]> {
  const deadline = Date.now() + ms
  let left = await aliveProcs(procs)
  while (left.length && Date.now() < deadline) { await sleep(500); left = await aliveProcs(procs) }
  return left
}

test('fullscreen canary: ~/.claude.json has no fullscreenAutoDisabled after the app test', () => {
  const p = join(homedir(), '.claude.json')
  const cfg = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown> : {}
  assert.ok(!cfg.fullscreenAutoDisabled, 'fullscreenAutoDisabled is set: a Claude session died before 10 s of life; run /tui fullscreen')
})
