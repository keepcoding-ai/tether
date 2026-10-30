// E2E of "Trocar perfil…" on an existing panel (hidden windows, private home/pipe, real tetherd, real Claude on
// haiku). The user's case: a Claude panel created WITHOUT a profile must get --dangerously-skip-permissions
// without losing its conversation.
//   1. a Claude panel is created with no profile; it answers a seed word ("jabuticaba");
//   2. after ≥ 11 s of uptime the header pill "sem perfil" opens the dialog: this agent's profiles + "Sem perfil"
//      (current, cards inert), "Claude modo dev" marked "sem restrições"; screenshots light/dark;
//   3. "Trocar e reiniciar agora" with "Claude modo dev": the panel shows "reiniciando…", a NEW claude process
//      (different pid) runs with --dangerously-skip-permissions AND --resume <the same session id>, the binding
//      keeps the id, the tab shows the unsafe badge, the header names the profile, and Claude recalls the word;
//   4. "Trocar na próxima abertura" back to "Claude": the meta changes (slot + disk), the pid does not, the badge
//      stays (the running process still skips permissions);
//   5. the tab's right-click menu and the ≡ menu both open the same dialog.
// No Claude is killed before 11 s of life (the daemon itself waits 12 s from the spawn); kills via test/kill.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { readEvents, readSlot } from '../../src/core/store.ts'
import { DaemonClient } from '../../src/daemon/client.ts'
import type { Profile, SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { aliveProcs, CLAUDE_DIALECT, processTree, type Proc } from './harness.ts'

type Hooks = {
  panelIds(): string[]
  slots(): SlotState[]
  text(id: string): string
  connection(): { connected: boolean; pid?: number } | undefined
  activate(id: string): void
  openSlot(id: string): void
  profiles(): Profile[]
  switchProfile(id: string): void
}
declare const window: { __tether: Hooks; tether: { request(body: unknown): Promise<{ t: string; slot?: SlotState; message?: string }> } }
declare const document: { querySelectorAll(selector: string): { length: number }; querySelector(selector: string): { dataset: Record<string, string> } | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-switch-${process.pid}`
const MIN_UPTIME_MS = 11_000
const UNSAFE = '--dangerously-skip-permissions'
const SEED = 'jabuticaba'

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

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_')) env[k] = v
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
  text: (page: Page, id: string) => page.evaluate(id => window.__tether.text(id), id),
  slots: (page: Page) => page.evaluate(() => window.__tether.slots()),
  slot: async (page: Page, id: string) => (await hooks.slots(page)).find(s => s.slotId === id),
  daemonPid: async (page: Page) => (await page.evaluate(() => window.__tether.connection()))?.pid,
  activate: (page: Page, id: string) => page.evaluate(id => window.__tether.activate(id), id),
  dialog: (page: Page, situation: string) => page.locator(`dialog.ask[data-dialog="${situation}"][open]`),
}

async function waitRunning(page: Page, id: string): Promise<number> {
  await page.waitForFunction(id => { const s = window.__tether.slots().find(x => x.slotId === id); return s?.status === 'running' && typeof s.pid === 'number' && !s.restarting }, id, { timeout: 60_000 })
  return (await hooks.slot(page, id))!.pid!
}

// ---------- Claude's TUI off the panel ----------

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

/** Waits for Claude's idle prompt, accepting the trust and bypass-permissions dialogs when they show up. Returns when the prompt first appeared. */
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

/** Types `prompt` + Enter like the user and returns Claude's newest answer line (same dance as app.claude). */
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

/** The command line of the process a slot runs (claude.exe itself, not a wrapper). */
async function cmdOf(pid: number, trees: Proc[][]): Promise<string> {
  const tree = await processTree(pid)
  trees.push(tree)
  const self = tree.find(p => p.pid === pid)
  assert.ok(self?.cmd, `command line of pid ${pid}`)
  return self.cmd
}

test('switch profile: a Claude panel without a profile gets "Claude modo dev" now (same session, recalls the word) and "Claude" at the next start', async t => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-switch-'))
  const work = mkdtempSync(join(tmpdir(), 'tether-switch-work-'))
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

    // ---- 1. a Claude panel WITHOUT a profile (the dialog always picks one: create through the daemon, open the slot) ----
    const created = await page.evaluate(cwd => window.tether.request({ t: 'create', kind: 'claude', cwd, start: true }), work)
    assert.equal(created.t, 'ok', `create: ${created.message}`)
    const id = created.slot!.slotId
    await page.evaluate(id => window.__tether.openSlot(id), id)
    await page.waitForFunction(n => document.querySelectorAll('.tether-tab').length === n, 1, { timeout: 15_000 })
    const head = page.locator(`.panel[data-slot-id="${id}"] .panel-head`)
    await head.locator('.profile').waitFor()
    assert.equal(await head.locator('.profile').textContent(), 'sem perfil', 'the pill says the panel has no profile')
    assert.equal(await head.locator('.unsafe').isVisible(), false, 'no badge: plain launch')
    readyAt.set(id, await awaitClaude(page, id))
    const pid1 = await waitRunning(page, id)
    const cmd1 = await cmdOf(pid1, trees)
    assert.ok(!cmd1.includes(UNSAFE), `the first claude runs WITHOUT ${UNSAFE}: ${cmd1}`)
    const a1 = await ask(page, id, `responda apenas: ${SEED}`)
    assert.match(a1, new RegExp(SEED, 'i'), `answered the seed: ${JSON.stringify(a1)}`)
    const session = (await hooks.slot(page, id))!.binding!.sessionId
    assert.match(session, /^[0-9a-f-]{36}$/, 'a session id is bound')
    evidence.before = { pid: pid1, session, cmd: cmd1 }
    t.diagnostic(`panel ${id}: claude pid ${pid1}, session ${session}, answered ${JSON.stringify(a1)}`)

    // ---- 2. the dialog from the header pill (after ≥ 11 s of uptime: the daemon waits anyway, the test makes the rule visible) ----
    await untilUptime(readyAt)
    await head.locator('.profile').click()
    let dlg = hooks.dialog(page, 'switch-profile')
    await dlg.waitFor()
    const optionIds = await dlg.locator('.option').evaluateAll(els => els.map(e => (e as { dataset: { option?: string } }).dataset.option))
    assert.deepEqual(optionIds, ['claude', 'claude-dev', '__none__'], 'this agent\'s profiles, then "Sem perfil"')
    assert.ok(await dlg.locator('.option[data-option="__none__"] input').isChecked(), '"Sem perfil" is the current one')
    assert.equal(await dlg.locator('.option[data-option="__none__"] .o-current').textContent(), 'atual')
    assert.equal(await dlg.locator('.option[data-option="claude-dev"] .o-mark').textContent(), 'sem restrições')
    assert.equal(await dlg.locator('.option[data-option="claude-dev"] .o-detail').textContent(), UNSAFE)
    assert.ok(await dlg.locator('button.choice[data-choice="now"]').isDisabled(), 'the cards are inert on the current profile')
    assert.ok(await dlg.locator('button.choice[data-choice="next"]').isDisabled())
    await dlg.locator('.option[data-option="claude-dev"] input').check()
    assert.ok(await dlg.locator('button.choice[data-choice="now"]').isEnabled(), 'picking another profile enables the cards')
    const nowText = (await dlg.locator('button.choice[data-choice="now"] .choice-consequence').textContent())!
    assert.match(nowText, new RegExp(`O Claude reinicia agora com o perfil Claude modo dev e continua a mesma conversa \\(sessão ${session.slice(0, 8)}\\)\\. Uma resposta em andamento é interrompida\\.`), `consequence-first copy: ${nowText}`)
    assert.equal(await dlg.locator('button.choice.safe.default[data-choice="now"]').count(), 1, '"agora" is the safe default')
    assert.equal(await dlg.locator('button.choice.neutral[data-choice="next"]').count(), 1, '"próxima abertura" is neutral')
    await shoot(page, 'switch-profile-dark')
    await page.keyboard.press('Escape')
    await dlg.waitFor({ state: 'detached' })
    assert.equal((await hooks.slot(page, id))!.pid, pid1, 'Esc: nothing happened')
    await setTheme(page, 'light')
    await head.locator('.profile').click()
    dlg = hooks.dialog(page, 'switch-profile')
    await dlg.waitFor()
    await dlg.locator('.option[data-option="claude-dev"] input').check()
    await shoot(page, 'switch-profile-light')
    t.diagnostic('dialog: options, current, mark, inert cards, copy ok')

    // ---- 3. "Trocar e reiniciar agora": same session, new process with the flag, recalls the word ----
    await dlg.locator('button.choice[data-choice="now"]').click()
    await dlg.waitFor({ state: 'detached' })
    // The daemon waits for the agent's minimum age with `restarting` on, then kills and relaunches: the header says
    // "reiniciando…" meanwhile (the agent is already old enough here, so that moment can be too short to catch).
    await page.waitForFunction((args: { id: string; pid1: number }) => { const s = window.__tether.slots().find(x => x.slotId === args.id); return s?.restarting === true || (typeof s?.pid === 'number' && s.pid !== args.pid1) }, { id, pid1 }, { timeout: 15_000 })
    if ((await hooks.slot(page, id))?.restarting) assert.equal(await head.locator('.status').textContent(), 'reiniciando…', 'the header shows the restart')
    else t.diagnostic('restart too quick to catch the "reiniciando…" state (the agent was already past its minimum age)')
    await page.waitForFunction((args: { id: string; pid1: number }) => { const s = window.__tether.slots().find(x => x.slotId === args.id); return typeof s?.pid === 'number' && s.pid !== args.pid1 }, { id, pid1 }, { timeout: 60_000 })
    readyAt.set(id, await awaitClaude(page, id)) // the bypass-permissions dialog shows up on the first unsafe run
    const pid2 = await waitRunning(page, id)
    assert.notEqual(pid2, pid1, 'a new claude process')
    assert.ok(!pidAlive(pid1), 'the old one is gone')
    const cmd2 = await cmdOf(pid2, trees)
    assert.ok(cmd2.includes(UNSAFE), `the new claude got ${UNSAFE}: ${cmd2}`)
    assert.ok(cmd2.includes(`--resume ${session}`), `the new claude resumes the SAME session: ${cmd2}`)
    assert.ok(cmd2.includes('--model haiku'), `TETHER_CLAUDE_ARGS still applied: ${cmd2}`)
    const after = (await hooks.slot(page, id))!
    assert.deepEqual([after.profileId, after.profileName, after.unsafe, after.binding?.sessionId, after.restarting], ['claude-dev', 'Claude modo dev', true, session, undefined])
    const starts = readEvents(home, id).filter(e => e.kind === 'start')
    assert.equal(starts.at(-1)?.sessionId, session, 'the jsonl shows the new run started the same session')
    assert.equal(starts.at(-1)?.source, 'resume')
    assert.equal(await head.locator('.profile').textContent(), 'Claude modo dev', 'the header names the new profile')
    assert.ok(await head.locator('.unsafe').isVisible(), 'the header shows the unsafe badge')
    assert.equal(await page.locator('.tether-tab').filter({ has: page.locator('.unsafe:visible') }).count(), 1, 'the tab shows the unsafe badge')
    const recalled = await ask(page, id, 'qual palavra você respondeu antes? só ela')
    assert.match(recalled, new RegExp(SEED, 'i'), `the same conversation continues: ${JSON.stringify(recalled)}`)
    await shoot(page, 'switch-profile-after-light')
    evidence.afterNow = { pid: pid2, session: after.binding?.sessionId, cmd: cmd2, recalled }
    t.diagnostic(`restarted: pid ${pid1} → ${pid2}, same session ${session}, recalled ${JSON.stringify(recalled)}`)

    // ---- 4. "Trocar na próxima abertura" back to "Claude": meta changes, pid does not, badge stays (process still unsafe) ----
    await head.locator('.profile').click()
    dlg = hooks.dialog(page, 'switch-profile')
    await dlg.waitFor()
    assert.ok(await dlg.locator('.option[data-option="claude-dev"] input').isChecked(), 'the current profile is preselected')
    await dlg.locator('.option[data-option="claude"] input').check()
    const nextText = (await dlg.locator('button.choice[data-choice="next"] .choice-consequence').textContent())!
    assert.match(nextText, /Nada muda agora\. O perfil Claude vale quando o Claude for iniciado de novo neste painel\./, nextText)
    await dlg.locator('button.choice[data-choice="next"]').click()
    await dlg.waitFor({ state: 'detached' })
    await page.waitForFunction(id => window.__tether.slots().find(x => x.slotId === id)?.profileId === 'claude', id)
    const next = (await hooks.slot(page, id))!
    assert.equal(next.pid, pid2, 'no restart')
    assert.equal(next.profileName, 'Claude')
    assert.equal(next.unsafe, true, 'the badge still describes the running process')
    assert.deepEqual([readSlot(home, id)!.profileId, readSlot(home, id)!.profileArgs], ['claude', []], 'the meta on disk changed')
    assert.equal(await head.locator('.profile').textContent(), 'Claude')
    assert.ok(await head.locator('.unsafe').isVisible())
    t.diagnostic('next: meta changed, same pid, badge kept')

    // ---- 5. the tab's right-click menu and the ≡ menu open the same dialog ----
    await page.locator('.tether-tab').first().click({ button: 'right' })
    await page.waitForSelector('#ctx-menu')
    await page.click('#ctx-menu li:has-text("Trocar perfil…")')
    dlg = hooks.dialog(page, 'switch-profile')
    await dlg.waitFor()
    await page.keyboard.press('Escape')
    await dlg.waitFor({ state: 'detached' })
    await page.click('#btn-menu')
    await page.waitForSelector('#app-menu:not([hidden])')
    await page.click('#app-menu li[data-cmd="switch-profile"]')
    dlg = hooks.dialog(page, 'switch-profile')
    await dlg.waitFor()
    await page.keyboard.press('Escape')
    await dlg.waitFor({ state: 'detached' })
    assert.equal((await hooks.slot(page, id))!.pid, pid2)
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

test('fullscreen canary: ~/.claude.json has no fullscreenAutoDisabled after the switch-profile test', () => {
  const p = join(homedir(), '.claude.json')
  const cfg = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown> : {}
  assert.ok(!cfg.fullscreenAutoDisabled, 'fullscreenAutoDisabled is set: a Claude session died before 10 s of life; run /tui fullscreen')
})
