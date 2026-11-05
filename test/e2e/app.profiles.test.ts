// E2E of the launch profiles in the app (hidden windows, private home/pipe, real tetherd, real Claude on haiku):
//   1. "Novo painel" lists the profiles grouped by agent (Claude / soul / Shell), preselects Claude's default,
//      shows each profile's args small and the "sem restrições" mark on "Claude modo dev";
//   2. a panel opened with "Claude modo dev": the claude process' command line carries
//      --dangerously-skip-permissions (+ --model haiku from TETHER_CLAUDE_ARGS), the tab and the header show
//      the unsafe badge and the header names the profile;
//   3. a Git Bash panel opens from the dialog and runs `echo $BASH_VERSION`; Ctrl+Shift+D splits it with the
//      SAME profile;
//   4. the manager: a custom shell profile with an extra arg and an env var is saved; a panel opened with it
//      has both (command line + `echo $VAR`); an invalid arg (--resume) shows the inline error and is not
//      saved; a CLAUDE_* env var shows the validator's warning; deleting a profile asks through the in-app
//      dialog and leaves the panel that used it running;
//   5. the in-app menu (toolbar) opens, "Sair e encerrar tudo…" shows the quit-all dialog, Esc keeps everything;
//      Ctrl+Shift+Q from inside a terminal does the same.
// Screenshots (light and dark) of the dialog, the manager and a tab with the badge land in test/e2e/artifacts.
// No Claude session is killed before 11 s of life; every kill goes through test/kill.ts (identity).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { gitBashPath } from '../../src/core/profile.ts'
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
  profiles(): Profile[]
  chooser(): { highlight: string | undefined } | undefined
  openProfiles(id?: string): void
}
declare const window: { __tether: Hooks; tether: { request(body: unknown): Promise<unknown> } }
declare const document: { querySelectorAll(selector: string): { length: number }; querySelector(selector: string): unknown }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const artifacts = join(root, 'test', 'e2e', 'artifacts')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const pipe = `\\\\.\\pipe\\tether-profiles-${process.pid}`
/** Claude Code counts a fullscreen session that dies within 10 s as a boot strike (see harness.ts). */
const MIN_UPTIME_MS = 11_000
const UNSAFE = '--dangerously-skip-permissions'

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
  profiles: (page: Page) => page.evaluate(() => window.__tether.profiles()),
  daemonPid: async (page: Page) => (await page.evaluate(() => window.__tether.connection()))?.pid,
  activate: (page: Page, id: string) => page.evaluate(id => window.__tether.activate(id), id),
  dialog: (page: Page, situation: string) => page.locator(`dialog.ask[data-dialog="${situation}"][open]`),
}

async function tabCount(page: Page, n: number): Promise<void> {
  await page.waitForFunction(n => document.querySelectorAll('.tether-tab').length === n, n, { timeout: 15_000 })
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

async function focusPanel(page: Page, id: string): Promise<void> {
  await hooks.activate(page, id)
  await page.locator(`.panel[data-slot-id="${id}"] .panel-term`).click()
}

/** Opens "Novo painel", picks a profile by id, fills the folder and creates; returns the new panel's id. */
async function createPanel(page: Page, profileId: string, cwd: string): Promise<string> {
  const before = await hooks.ids(page)
  await page.click('#btn-new')
  await page.waitForSelector('#dlg-new[open]')
  await page.fill('#dlg-new .ch-path-input', cwd)
  await page.click(`#dlg-new .ch-item[data-id="${profileId}"]`)
  await page.waitForFunction(() => document.querySelectorAll('#dlg-new[open]').length === 0)
  await tabCount(page, before.length + 1)
  const id = (await hooks.ids(page)).find(i => !before.includes(i))!
  assert.ok(id, 'new panel')
  return id
}

// ---------- Git Bash ----------

const BASH_PROMPT = /MINGW64|^\$\s*$/m
const BASH_VERSION = /^\d+\.\d+\.\d+\(\d+\)-release/m

async function awaitBash(page: Page, id: string): Promise<void> {
  await waitPanel(page, id, t => BASH_PROMPT.test(t), { timeout: 30_000, quietMs: 500, what: 'the bash prompt' })
}

async function bashEcho(page: Page, id: string, expr: string, expect: RegExp): Promise<string> {
  await focusPanel(page, id)
  await page.keyboard.type(`echo ${expr}`, { delay: 10 })
  await page.keyboard.press('Enter')
  return waitPanel(page, id, t => expect.test(t), { timeout: 15_000, what: `output of echo ${expr}` })
}

// ---------- Claude's TUI off the panel ----------

const TRUST = /trust this folder/i
const TRUST_YES = /^\s*❯\s*Yes, I trust/m
const BYPASS = /bypass permissions mode/i
const BYPASS_YES = /^\s*❯\s*(\d+\.\s*)?Yes, I accept/m
const hasPrompt = (text: string): boolean => { const lines = text.split('\n'); return lines.some((_, i) => CLAUDE_DIALECT.isPrompt(lines, i)) }
const busy = (text: string): boolean => CLAUDE_DIALECT.busy(text, '')

/** Accepts a selectable dialog (trust / bypass) with the keyboard: Down until "Yes" stays highlighted, then Enter. */
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

/** Waits for Claude's idle prompt in the panel, accepting the trust and bypass-permissions dialogs when they show up. Returns when the prompt first appeared. */
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

async function untilUptime(readyAt: Map<string, number>): Promise<void> {
  const wait = Math.max(0, ...[...readyAt.values()].map(t => t + MIN_UPTIME_MS - Date.now()))
  if (wait > 0) await sleep(wait)
}

async function shoot(page: Page, name: string): Promise<void> {
  await sleep(300)
  await page.screenshot({ path: join(artifacts, `${name}.png`) })
}

async function setTheme(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  // Through the in-app menu (the native menu bar is hidden; the toolbar menu is how the user gets there).
  await page.click('#btn-menu')
  await page.waitForSelector('#app-menu:not([hidden])')
  await page.click(`#app-menu li[data-theme="${scheme}"]`)
  await page.waitForFunction(s => (document.querySelector('html') as { dataset: { theme?: string } }).dataset.theme === s, scheme)
}

/** Fills the manager form for a new profile (the manager must be open). */
async function fillProfileForm(page: Page, p: { name: string; agent: 'claude' | 'soul' | 'shell'; shell?: string; args: string; env?: Record<string, string> }): Promise<void> {
  await page.click('#btn-profile-new')
  await page.fill('#form-profile input[name=name]', p.name)
  await page.check(`#form-profile input[name=agent][value=${p.agent}]`)
  if (p.shell !== undefined) await page.fill('#form-profile input[name=shell]', p.shell)
  await page.fill('#form-profile input[name=args]', p.args)
  for (const [k, v] of Object.entries(p.env ?? {})) {
    await page.click('#btn-profile-env-add')
    const rows = page.locator('#profile-env .env-row')
    const row = rows.nth((await rows.count()) - 1)
    await row.locator('.env-key').fill(k)
    await row.locator('.env-value').fill(v)
  }
}

test('profiles in the app: Novo painel by profile, unsafe badge, Git Bash, manager (create/invalid/delete), in-app menu', async t => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const bash = gitBashPath()
  assert.ok(existsSync(bash), `Git Bash at ${bash} (the Git Bash profile and this test need it)`)
  const home = mkdtempSync(join(tmpdir(), 'tether-profiles-'))
  const work = mkdtempSync(join(tmpdir(), 'tether-profiles-work-'))
  const daemons: Owned[] = []
  const trees: Proc[][] = []
  const readyAt = new Map<string, number>()
  let app: ElectronApplication | undefined
  let failed = true
  try {
    let page: Page
    ;({ app, page } = await launch(home))
    const daemonPid = (await hooks.daemonPid(page))!
    assert.ok(daemonPid && pidAlive(daemonPid), 'the app spawned a tetherd')
    daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await setTheme(page, 'dark')

    // ---- 1. Novo painel: profiles grouped by agent, Claude's default preselected, args and the unsafe mark ----
    await page.waitForFunction(() => window.__tether.profiles().length >= 5)
    await page.click('#btn-new')
    await page.waitForSelector('#dlg-new[open]')
    const groups = await page.locator('#dlg-new .ch-sep').allInnerTexts().then(l => l.map(s => s.trim().toLowerCase()))
    assert.deepEqual(groups, ['claude', 'soul', 'shell', 'nota', 'vazio'], 'one group per agent, in that order, then the notes and the empty pane')
    assert.equal((await page.evaluate(() => window.__tether.chooser()))?.highlight, 'claude', 'the Claude default profile is highlighted')
    const dev = page.locator('#dlg-new .ch-item[data-id="claude-dev"]')
    assert.equal(await dev.locator('.ch-hint').textContent(), UNSAFE, 'the args are shown on the item')
    assert.ok(await dev.locator('.ch-unsafe').isVisible(), '"sem restrições" on the dev profile')
    assert.equal(await page.locator('#dlg-new .ch-item[data-id="claude"] .ch-unsafe').count(), 0, 'no mark on the plain profile')
    assert.ok(await page.locator('#dlg-new .ch-item[data-id="git-bash"]').isVisible(), 'Git Bash is offered')
    assert.equal(await page.locator('#dlg-new .ch-item[data-id="powershell"] .selo').count(), 1, 'the shell default is marked')
    await shoot(page, 'profiles-new-panel-dark')
    await page.keyboard.press('Escape')
    await page.waitForSelector('#dlg-new', { state: 'hidden' })
    t.diagnostic('Novo painel: groups, default, args, unsafe mark ok')

    // ---- 2. "Claude modo dev" (boots in the background while the shell steps run) ----
    const idClaude = await createPanel(page, 'claude-dev', work)
    const claudeSlot = (await hooks.slot(page, idClaude))!
    assert.equal(claudeSlot.kind, 'claude')
    assert.equal(claudeSlot.profileId, 'claude-dev')
    assert.equal(claudeSlot.profileName, 'Claude modo dev')
    assert.equal(claudeSlot.unsafe, true, 'the slot state flags the launch unsafe')

    // ---- 3. Git Bash from the dialog; Ctrl+Shift+D keeps the profile ----
    const idBash = await createPanel(page, 'git-bash', work)
    const bashSlot = (await hooks.slot(page, idBash))!
    assert.deepEqual([bashSlot.kind, bashSlot.profileId, bashSlot.profileName, bashSlot.unsafe ?? false], ['shell', 'git-bash', 'Git Bash', false])
    await awaitBash(page, idBash)
    const ver = await bashEcho(page, idBash, '$BASH_VERSION', BASH_VERSION)
    t.diagnostic(`Git Bash: ${BASH_VERSION.exec(ver)![0]}`)
    await focusPanel(page, idBash)
    await page.keyboard.press('Control+Shift+D')
    await tabCount(page, 3)
    const idSplit = (await hooks.ids(page)).find(i => i !== idClaude && i !== idBash)!
    const split = (await hooks.slot(page, idSplit))!
    assert.deepEqual([split.kind, split.profileId, split.cwd], ['shell', 'git-bash', bashSlot.cwd], 'the split panel uses the same profile and folder')
    await awaitBash(page, idSplit)
    t.diagnostic('split: same profile (git-bash)')

    // ---- 4. the Claude panel: badge in tab and header, profile name, process command line ----
    readyAt.set(idClaude, await awaitClaude(page, idClaude))
    await page.waitForFunction(id => { const s = window.__tether.slots().find(x => x.slotId === id); return s?.status === 'running' && typeof s.pid === 'number' }, idClaude, { timeout: 30_000 })
    const running = (await hooks.slot(page, idClaude))!
    assert.equal(running.unsafe, true)
    const tree = await processTree(running.pid!)
    trees.push(tree)
    const self = tree.find(p => p.pid === running.pid)
    assert.ok(self?.cmd, `command line of claude pid ${running.pid}`)
    assert.ok(self.cmd.includes(UNSAFE), `claude got ${UNSAFE}: ${self.cmd}`)
    assert.ok(self.cmd.includes('--model haiku'), `claude got TETHER_CLAUDE_ARGS too: ${self.cmd}`)
    const tab = page.locator(`.tether-tab:has(.text)`).filter({ has: page.locator('.unsafe:visible') })
    assert.equal(await tab.count(), 1, 'exactly one tab shows the unsafe badge')
    await hooks.activate(page, idClaude)
    const head = page.locator(`.panel[data-slot-id="${idClaude}"] .status-bar`)
    assert.ok(await head.locator('.unsafe').isVisible(), 'the header shows the unsafe badge')
    assert.equal(await head.locator('.info-profile').textContent(), 'Claude modo dev', 'the header names the profile')
    assert.match((await head.locator('.unsafe').getAttribute('title'))!, /sem restrições/i)
    assert.equal(await page.locator(`.panel[data-slot-id="${idBash}"] .status-bar .unsafe`).isVisible(), false, 'no badge on the shell')
    await shoot(page, 'profiles-unsafe-tab-dark')
    await setTheme(page, 'light')
    await shoot(page, 'profiles-unsafe-tab-light')
    await page.click('#btn-new')
    await page.waitForSelector('#dlg-new[open]')
    await shoot(page, 'profiles-new-panel-light')
    await page.keyboard.press('Escape')
    t.diagnostic(`claude cmd: ${self.cmd}`)

    // ---- 5. manager: a custom shell profile with an extra arg and an env var ----
    await page.click('#btn-profiles')
    await page.waitForSelector('#dlg-profiles[open]')
    await fillProfileForm(page, { name: 'Bash de teste', agent: 'shell', shell: bash, args: '--login --noediting -i', env: { PROFILE_MARK: 'tether-marca-7' } })
    assert.deepEqual(await page.locator('#profile-args-preview .chip').allTextContents(), ['--login', '--noediting', '-i'], 'chips preview the parsed args')
    await page.click('#btn-profile-save')
    await page.waitForSelector('#profile-saved:not([hidden])')
    await page.waitForFunction(() => window.__tether.profiles().some(p => p.id === 'bash-de-teste'))
    const saved = (await hooks.profiles(page)).find(p => p.id === 'bash-de-teste')!
    assert.deepEqual([saved.agent, saved.shell?.command, saved.shell?.args, saved.args, saved.env], ['shell', bash, ['--login', '--noediting', '-i'], [], { PROFILE_MARK: 'tether-marca-7' }])
    await page.keyboard.press('Escape')
    await page.waitForSelector('#dlg-profiles', { state: 'hidden' })
    const idCustom = await createPanel(page, 'bash-de-teste', work)
    await awaitBash(page, idCustom)
    await bashEcho(page, idCustom, '$PROFILE_MARK', /^tether-marca-7\s*$/m)
    const custom = (await hooks.slot(page, idCustom))!
    const customTree = await processTree(custom.pid!)
    const customSelf = customTree.find(p => p.pid === custom.pid)
    assert.ok(customSelf?.cmd?.includes('--noediting'), `the custom arg is on the shell's command line: ${customSelf?.cmd}`)
    t.diagnostic(`custom profile: env and arg reached the process (${customSelf!.cmd})`)

    // ---- 6. manager: an invalid arg is refused inline; a CLAUDE_* var warns ----
    await page.click('#btn-profiles')
    await page.waitForSelector('#dlg-profiles[open]')
    await fillProfileForm(page, { name: 'Inválido', agent: 'claude', args: '--resume --model haiku', env: { CLAUDE_FOO: '1' } })
    assert.match((await page.locator('.field-warning[data-for=env]').textContent())!, /CLAUDE_FOO.*transcript/, 'the CLAUDE_* warning shows while typing')
    await page.click('#btn-profile-save')
    const argsError = page.locator('.field-error[data-for=args]:not([hidden])')
    await argsError.waitFor()
    assert.match((await argsError.textContent())!, /--resume não pode ficar no perfil/, 'the validator error lands next to the args field')
    assert.ok(await page.locator('#form-profile input[name=args]').evaluate(el => el === (el as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement), 'focus goes to the field with the error')
    assert.equal(await page.locator('#profile-saved:not([hidden])').count(), 0, 'nothing saved')
    assert.ok(!(await hooks.profiles(page)).some(p => p.name === 'Inválido'), 'the invalid profile was not saved')
    await shoot(page, 'profiles-manager-light')
    // The manager is modal (the toolbar is inert behind it): the native menu item switches the theme here.
    await app.evaluate(({ Menu }, id) => { Menu.getApplicationMenu()?.getMenuItemById(id)?.click() }, 'theme-dark')
    await page.waitForFunction(() => (document.querySelector('html') as { dataset: { theme?: string } }).dataset.theme === 'dark')
    await shoot(page, 'profiles-manager-dark')
    t.diagnostic('invalid profile refused inline')

    // ---- 7. delete the custom profile: in-app dialog, consequence names the panel; the panel keeps running ----
    await page.click('.manager-list .profile-option[data-id="bash-de-teste"]')
    await page.waitForFunction(() => (document.querySelector('#form-profile input[name=name]') as { value: string }).value === 'Bash de teste')
    await page.click('#btn-profile-delete')
    const del = hooks.dialog(page, 'delete-profile')
    await del.waitFor()
    assert.match((await del.locator('.ctx-status').textContent())!, /1 painel usa/)
    assert.equal(await del.locator('button.choice.destructive[data-choice="delete"]').count(), 1)
    assert.ok(await del.locator('button.choice.neutral[data-choice="keep"]').evaluate(el => el === (el as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement), 'the safe choice has the focus, never the destructive one')
    await shoot(page, 'profiles-delete-dark')
    await del.locator('button.choice[data-choice="delete"]').click()
    await del.waitFor({ state: 'detached' })
    await page.waitForFunction(() => !window.__tether.profiles().some(p => p.id === 'bash-de-teste'))
    await page.waitForFunction(id => { const s = window.__tether.slots().find(x => x.slotId === id); return s?.status === 'running' && s.profileName === undefined }, idCustom)
    assert.equal((await hooks.slot(page, idCustom))!.profileId, 'bash-de-teste', 'the slot keeps the reference (and its snapshot of the args)')
    await page.keyboard.press('Escape')
    await page.waitForSelector('#dlg-profiles', { state: 'hidden' })
    t.diagnostic('delete: dialog, panel kept running')

    // ---- 8. in-app menu: quit-all through the menu and through Ctrl+Shift+Q from inside a terminal; Esc keeps all ----
    await page.click('#btn-menu')
    await page.waitForSelector('#app-menu:not([hidden])')
    assert.equal(await page.getAttribute('#btn-menu', 'aria-expanded'), 'true')
    await page.click('#app-menu li[data-command="app.quit-all"]')
    let quit = hooks.dialog(page, 'quit-all')
    await quit.waitFor()
    assert.equal(await quit.locator('button.choice.safe.default[data-choice="close-window"]').count(), 1)
    await page.keyboard.press('Escape')
    await quit.waitFor({ state: 'detached' })
    await focusPanel(page, idBash)
    await page.keyboard.press('Control+Shift+Q')
    quit = hooks.dialog(page, 'quit-all')
    await quit.waitFor()
    await page.keyboard.press('Escape')
    await quit.waitFor({ state: 'detached' })
    assert.equal((await hooks.ids(page)).length, 4, 'Esc: every panel still there')
    assert.ok(pidAlive(daemonPid), 'Esc: the tetherd is still there')
    t.diagnostic('in-app menu + Ctrl+Shift+Q: quit-all dialog shown and cancelled')
    failed = false
  } finally {
    if (failed) {
      // What the daemon did and what each slot was launched with: the first thing to read when a panel misbehaves.
      try { console.error(`--- tetherd.log ---
${readFileSync(join(home, 'tetherd.log'), 'utf8').slice(-3000)}`) } catch { /* no log */ }
      try { for (const f of readdirSync(join(home, 'slots'))) if (f.endsWith('.json')) console.error(`--- ${f} ---
${readFileSync(join(home, 'slots', f), 'utf8')}`) } catch { /* no slots */ }
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

test('fullscreen canary: ~/.claude.json has no fullscreenAutoDisabled after the profiles test', () => {
  const p = join(homedir(), '.claude.json')
  const cfg = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown> : {}
  assert.ok(!cfg.fullscreenAutoDisabled, 'fullscreenAutoDisabled is set: a Claude session died before 10 s of life; run /tui fullscreen')
})
