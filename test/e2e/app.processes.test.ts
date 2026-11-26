// The pad "Processos" and the `process` pane (slices 5 and 6 of background processes), against the real app built with
// TETHER_TEST_EXTENSIONS=1 (hidden window, private home and pipe), a REAL tetherd and a REAL tether-procd; processes are
// started through the CLI as an agent would:
//   - the empty state; a process started by the CLI shows up without a reload; summary and groups;
//   - Parar and Iniciar by the buttons (the history says "você (pelo app)");
//   - a process killed from outside goes to "Pedem atenção" with its code, the icon counts 1, and seeing the pad clears it;
//   - looking never acts: opening the pad, switching views, the "⋯", opening and closing the output pane change no pid,
//     no run, and add no event to any history;
//   - a restart over someone else's use opens the dialog with the board, waiting is the default (and waits), "Reiniciar
//     agora" forces and records the reason;
//   - the ports view shows the process' port and a server outside tether as "fora do tether";
//   - the output pane shows the output live, takes no key (typing reaches nothing), shows the new run after Reiniciar,
//     keeps the output when moved to the drawer, and says "processo esquecido" when its process is forgotten;
//   - Esquecer confirms on the row.
// Captures (light and dark) of the pad with the three groups, of the ports view and of the output pane go to
// test/e2e/artifacts/processes-*.png. The teardown stops the test's host and checks by pid that nothing is left.
// Run: TETHER_TEST_EXTENSIONS=1 node app/build.mjs && node --test test/e2e/app.processes.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import type { ProcEvent, ProcState } from '../../src/daemon/procs.ts'
import { procLogPath } from '../../src/core/paths.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { cleanEnv, daemonMain, launchHidden, pidAlive, root, sleep } from './browser-kit.ts'
import { EMPTY_TEXT, FORGET_CONFIRM } from '../../extensions/processes/proc-rules.ts'

type Row = { name: string; status: string; title: string; when: string; facts: string; people: string; error: string; waiting: string; actions: string[]; confirm: string }
type PadSnap = {
  visible: boolean; view: string; summary: string; empty: string; badge: { count: number } | null
  groups: { id: string; title: string; rows: Row[] }[]
  ports: { port: number; listening: boolean; who: string; declared: string }[]
}
type OutSnap = { text: string; run: string; card: string; timeline: string[]; forgotten: boolean; stdinDisabled: boolean }
declare const window: {
  __tether: {
    connection(): { connected: boolean; pid?: number } | undefined
    processesPad(): PadSnap | null
    processesOpenPad(): void
    processesOutput(name: string): OutSnap | null
    togglePad(id: string): void
    runCommand(id: string): Promise<'ran' | 'unknown' | 'unavailable'>
    closePanel(id: string): void
    movePaneToDrawer(id: string): void
    drawer(): { open: boolean; panes: string[] }
    processesEmbed(op: string, name?: string, arg?: Record<string, unknown>): Promise<EmbedAnswer>
    activeDesk(): string
    createDesk(side: 'before' | 'after', relativeTo?: string): string
    switchDesk(id: string): void
    desks(): { id: string; panes: string[] }[]
    panelIds(): string[]
    peekState(): { open: boolean; screen?: string; screenType?: string }
  }
}
type EmbedAnswer = { ok?: true; refusal?: string; active?: boolean; names?: string[]; hasEnv?: boolean; json?: string }
declare const document: { documentElement: { dataset: Record<string, string> }; activeElement: { dataset?: Record<string, string> } | null; querySelector(s: string): unknown }

const CLI = join(root, 'bin', 'tether.mjs')
const PAD = '#pads div[data-pad="processes.list"]'
const PAD_SECTION = '#pads section[data-pad="processes.list"]'
const pipe = `\\\\.\\pipe\\tether-procs-app-${process.pid}`
const artifacts = join(root, 'test', 'e2e', 'artifacts')

/** A process that prints "pronto", a tick every 300 ms, echoes what it reads, and listens on a port when given one. */
const FIXTURE = `
import { createServer } from 'node:http'
const port = Number(process.argv[2] || 0)
if (port) createServer((q, s) => s.end('ok')).listen(port, 'localhost')
console.log('pronto ' + process.pid)
let n = 0
setInterval(() => console.log('tick ' + n++), 300)
process.stdin.on('data', d => console.log('got:' + String(d).trim()))
`

function freePort(): Promise<number> {
  return new Promise(res => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)) }) })
}

async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms
  let last: unknown
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v as T } catch (e) { last = e }
    await sleep(150)
  }
  throw new Error(`timed out: ${what}${last ? ` (${(last as Error).message})` : ''}`)
}

test('processes pad and output pane: empty, live list, acts, attention, looking never acts, in-use dialog, ports, output, forget', { timeout: 480_000 }, async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, TETHER_TEST_EXTENSIONS: '1' } })
  assert.equal(build.status, 0, 'app build failed')
  mkdirSync(artifacts, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'tether-procs-app-'))
  const work = mkdtempSync(join(tmpdir(), 'tether-procs-work-'))
  const fixture = join(work, 'proc.mjs')
  writeFileSync(fixture, FIXTURE)
  const webPort = await freePort()
  const outsidePort = await freePort()
  const daemons: Owned[] = []
  /** Every pid of the test's host and processes: none may be left at the end. */
  const seen = new Set<number>()
  let outside: Server | undefined
  let app: ElectronApplication | undefined

  const cli = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    const env: NodeJS.ProcessEnv = { ...cleanEnv(), TETHER_HOME: home, TETHER_PIPE: pipe }
    for (const k of ['TETHER_SLOT_ID', 'TETHER_PROCD_PIPE', 'TETHER_CLAUDE_ARGS']) delete env[k]
    return new Promise(res => execFile(process.execPath, [CLI, ...args], { env, cwd: work, windowsHide: true, encoding: 'utf8', timeout: 60_000 },
      (err, stdout, stderr) => res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr })))
  }
  const ok = async (args: string[]): Promise<string> => { const r = await cli(args); assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}${r.stdout}`); return r.stdout }
  const list = async (): Promise<ProcState[]> => JSON.parse(await ok(['proc', 'ls', '--json'])) as ProcState[]
  const proc = async (name: string): Promise<ProcState | undefined> => (await list()).find(p => p.name === name)
  const history = async (name: string): Promise<ProcEvent[]> => JSON.parse(await ok(['proc', 'history', name, '--json'])) as ProcEvent[]
  const track = async (name: string): Promise<ProcState> => { const p = (await proc(name))!; if (p.pid) seen.add(p.pid); return p }

  try {
    let win: Page
    ;({ app, page: win } = await launchHidden(home, pipe))
    win.on('pageerror', e => console.error(`renderer error: ${e.message}`))
    daemons.push(await claim((await win.evaluate(() => window.__tether.connection()))!.pid!, { cmdIncludes: daemonMain, what: 'tetherd' }))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 820))
    const pad = async (): Promise<PadSnap> => (await win.evaluate(() => window.__tether.processesPad()))!
    const rowOf = async (name: string): Promise<Row | undefined> => (await pad()).groups.flatMap(g => g.rows).find(r => r.name === name)
    const groupOf = async (name: string): Promise<string | undefined> => (await pad()).groups.find(g => g.rows.some(r => r.name === name))?.id
    const click = async (name: string, action: string): Promise<void> => { await win.locator(`${PAD} .pr-row[data-proc="${name}"] button[data-action="${action}"]`).click() }
    const output = async (name: string): Promise<OutSnap> => (await win.evaluate(n => window.__tether.processesOutput(n), name))!
    const setTheme = async (scheme: 'light' | 'dark'): Promise<void> => {
      await win.click('#btn-theme')
      await win.click(`#theme-menu li[data-theme="${scheme}"]`)
      await win.waitForFunction(s => document.documentElement.dataset.theme === s, scheme)
      await sleep(300)
    }

    // ---- empty state, opened by the palette's command ----
    assert.equal(await win.evaluate(() => window.__tether.runCommand('processes.open')), 'ran')
    await win.waitForSelector(`${PAD} .pr-empty`)
    let v = await pad()
    assert.equal(v.visible, true)
    assert.equal(v.empty, EMPTY_TEXT)
    assert.equal(v.summary, '')
    assert.equal(v.badge, null)

    // ---- started by the CLI: shows up without a reload, summary and groups ----
    await ok(['proc', 'start', 'web', '--port', String(webPort), '--desc', 'servidor de teste', '--', 'node', fixture, String(webPort)])
    await track('web')
    await until('web in "Rodando"', async () => (await groupOf('web')) === 'running')
    const web = await until('web listens', async () => { const r = await rowOf('web'); return r?.facts.includes(`localhost:${webPort} ✓`) ? r : undefined })
    assert.match(web.when, /^rodando/)
    assert.equal(web.title, 'servidor de teste')
    assert.match(web.people, /^iniciado por /)
    assert.deepEqual(web.actions, ['Ver saída', 'Reiniciar', 'Parar', 'more'])
    await ok(['proc', 'start', 'worker', '--', 'node', fixture])
    await ok(['proc', 'start', 'crash', '--', 'node', fixture])
    await track('worker')
    const crash = await track('crash')
    await until('three running', async () => (await pad()).summary.startsWith('3 rodando'))

    // ---- Parar and Iniciar by the buttons: "você (pelo app)" ----
    await click('worker', 'stop')
    await until('worker in "Parados"', async () => (await groupOf('worker')) === 'stopped')
    assert.equal((await history('worker')).filter(e => e.kind === 'stop-requested').at(-1)?.by?.kind, 'app')
    await click('worker', 'start')
    await until('worker running again', async () => (await groupOf('worker')) === 'running')
    const started = (await history('worker')).filter(e => e.kind === 'started').at(-1)!
    assert.equal(started.by?.kind, 'app')
    assert.match(await ok(['proc', 'history', 'worker']), /você \(pelo app\)\s+iniciou \(execução 2/)
    await track('worker')
    await until('worker row says "iniciado por você"', async () => (await rowOf('worker'))?.people.includes('iniciado por você'))
    await click('worker', 'stop')
    await until('worker stopped', async () => (await groupOf('worker')) === 'stopped')

    // ---- killed from outside, with the pad hidden: "Pedem atenção" with its code, the badge counts 1, seeing clears it ----
    await win.evaluate(() => window.__tether.togglePad('processes.list'))
    await until('pad hidden', async () => !(await pad()).visible)
    assert.equal(await killOwned(await claim(crash.pid!, { what: 'crash fixture' }), { tree: true }), 'killed')
    const crashed = await until('crash asks for attention', async () => { const p = await pad(); const r = p.groups.find(g => g.id === 'attention')?.rows.find(x => x.name === 'crash'); return r && p.badge?.count === 1 ? r : undefined })
    assert.match(crashed.when, /^encerrou sozinho \d\d:\d\d \(\d+\)$/)
    assert.deepEqual(crashed.actions, ['Ver saída', 'Iniciar', 'more'])
    assert.equal((await proc('crash'))!.attention, true)
    await win.evaluate(() => window.__tether.processesOpenPad())
    await until('badge cleared by seeing the pad', async () => (await pad()).badge === null)
    await until('attention cleared in tetherd', async () => !(await proc('crash'))!.attention)
    v = await pad()
    assert.deepEqual(v.groups.map(g => g.title.replace(/\d+$/, '')), ['Pedem atenção', 'Rodando', 'Parados'])
    assert.match(v.summary, /^1 rodando · 1 pede atenção · 1 parado/)

    // ---- looking never acts ----
    const snapshot = async (): Promise<string> => JSON.stringify(await Promise.all(['web', 'worker', 'crash'].map(async n => {
      const p = (await proc(n))!
      return [n, p.pid ?? null, p.run ?? null, p.status, (await history(n)).length]
    })))
    const before = await snapshot()
    await win.locator(`${PAD} button[data-view="ports"]`).click()
    await until('ports view', async () => (await pad()).ports.length > 0)
    await win.locator(`${PAD} button[data-view="procs"]`).click()
    await win.locator(`${PAD} .pr-row[data-proc="web"] button[data-action="more"]`).click()
    await win.waitForSelector('#ctx-menu')
    await win.keyboard.press('Escape')
    await win.locator(`${PAD} .pr-row[data-proc="web"]`).hover()
    await click('web', 'output')
    await until('output pane shows web', async () => (await output('web'))?.text.includes('pronto'))
    await click('crash', 'output')
    await until('output pane shows crash', async () => (await output('crash')) !== null)
    await win.evaluate(() => { window.__tether.closePanel('process:web'); window.__tether.closePanel('process:crash') })
    await until('output panes closed', async () => (await output('web')) === null && (await output('crash')) === null)
    await sleep(500)
    assert.equal(await snapshot(), before, 'looking changed a process or its history')

    // ---- a restart over someone else's use: the board, waiting by default, then "Reiniciar agora" forces ----
    await ok(['proc', 'use', 'web', '10m', 'e2e do checkout', '--as', 'kai'])
    await until('the use shows on the row', async () => (await rowOf('web'))?.people.includes('em uso por'))
    const run1 = (await proc('web'))!.run!
    await click('web', 'restart')
    const dlg = win.locator('dialog[data-dialog="processes-in-use"][open]')
    await dlg.waitFor()
    const board = await dlg.innerText()
    assert.match(board, /web está em uso/)
    assert.match(board, /kai .* e2e do checkout/)
    assert.equal(await win.evaluate(() => document.activeElement?.dataset?.choice), 'wait', 'waiting is the default')
    await win.keyboard.press('Enter')
    await until('the row waits', async () => (await rowOf('web'))?.waiting.startsWith('esperando o uso acabar'))
    assert.equal((await proc('web'))!.run, run1, 'nothing restarted while the use holds')
    await ok(['proc', 'release', 'web', '--as', 'kai'])
    await until('restarted once the use ended', async () => { const p = await proc('web'); return p?.status === 'running' && p.run === run1 + 1 })
    await track('web')
    await until('the row no longer waits', async () => (await rowOf('web'))?.waiting === '')
    await ok(['proc', 'use', 'web', '10m', 'e2e do checkout', '--as', 'kai'])
    await click('web', 'restart')
    await dlg.waitFor()
    await dlg.locator('button.choice[data-choice="force"]').click()
    await until('forced restart', async () => (await proc('web'))?.run === run1 + 2)
    await track('web')
    const forced = (await history('web')).filter(e => e.kind === 'forced').at(-1)!
    assert.equal(forced.reason, 'decisão da pessoa, pelo app')
    assert.equal(forced.by?.kind, 'app')
    await ok(['proc', 'release', 'web', '--as', 'kai'])

    // ---- the ports view: the process' port and a server outside tether ----
    outside = createServer(() => {}).listen(outsidePort, '127.0.0.1')
    await new Promise(r => outside!.once('listening', r))
    await win.locator(`${PAD} button[data-view="ports"]`).click()
    await win.locator(`${PAD} .pr-ports-bar button`).click()
    v = await until('both ports listed', async () => { const p = await pad(); return p.ports.some(r => r.port === outsidePort) && p.ports.some(r => r.port === webPort && r.who === 'web') ? p : undefined })
    const out = v.ports.find(r => r.port === outsidePort)!
    assert.match(out.who, new RegExp(`^fora do tether: .*pid ${process.pid}$`))

    // ---- captures: the three groups, the ports view, light and dark ----
    await setTheme('light')
    await win.locator(PAD_SECTION).screenshot({ path: join(artifacts, 'processes-ports-light.png') })
    await setTheme('dark')
    await win.locator(PAD_SECTION).screenshot({ path: join(artifacts, 'processes-ports-dark.png') })
    await win.locator(`${PAD} button[data-view="procs"]`).click()
    await win.waitForSelector(`${PAD} .pr-group[data-group="stopped"]`)
    await win.locator(PAD_SECTION).screenshot({ path: join(artifacts, 'processes-pad-dark.png') })
    await setTheme('light')
    await win.locator(PAD_SECTION).screenshot({ path: join(artifacts, 'processes-pad-light.png') })

    // ---- the output pane: live, read only, the new run after Reiniciar, moved to the drawer, its timeline ----
    await click('web', 'output')
    let o = await until('live output', async () => { const x = await output('web'); return x && /tick \d+/.test(x.text) ? x : undefined })
    assert.equal(o.stdinDisabled, true)
    assert.match(o.run, /^── execução \d+ ──$/)
    const ticks = (t: string): number => Math.max(-1, ...[...t.matchAll(/tick (\d+)/g)].map(m => Number(m[1])))
    const t0 = ticks(o.text)
    await until('ticks keep coming', async () => ticks((await output('web')).text) > t0 + 2)
    await win.locator('.pr-out[data-proc="web"] .pr-term').click()
    await win.keyboard.type('segredo')
    await win.keyboard.press('Enter')
    await sleep(1500)
    const runNow = (await proc('web'))!.run!
    const log = readFileSync(procLogPath(home, 'web', runNow), 'utf8')
    assert.doesNotMatch(log, /got:/, 'a key reached the process')
    assert.doesNotMatch((await output('web')).text, /got:/)
    assert.deepEqual((await output('web')).timeline, [], '"Ver saída" opens with the timeline folded')
    await win.locator('.pr-out[data-proc="web"] .pr-card button[data-action="timeline"]').click()
    await until('the timeline shows the forced restart', async () => (await output('web')).timeline.some(t => /você \(pelo app\)forçou reiniciar sobre o uso de kai/.test(t)))
    await setTheme('dark')
    await win.locator('.pr-out[data-proc="web"]').screenshot({ path: join(artifacts, 'processes-output-dark.png') })
    await setTheme('light')
    await win.locator('.pr-out[data-proc="web"]').screenshot({ path: join(artifacts, 'processes-output-light.png') })
    await win.locator('.pr-out[data-proc="web"] .pr-card button[data-action="restart"]').click()
    o = await until('the new run in the pane', async () => { const x = await output('web'); return x && x.run === `── execução ${runNow + 1} ──` && /pronto \d+/.test(x.text) ? x : undefined })
    const newPid = (await track('web')).pid!
    assert.ok(o.text.includes(`pronto ${newPid}`), 'the new run\'s output')
    assert.equal(o.text.match(/pronto \d+/g)?.length, 1, 'the screen was cleared for the new run')
    await win.evaluate(() => window.__tether.movePaneToDrawer('process:web'))
    await until('pane in the drawer', async () => (await win.evaluate(() => window.__tether.drawer())).panes.includes('process:web'))
    await until('output kept after the move', async () => { const x = await output('web'); return x && x.text.includes('pronto') && /tick \d+/.test(x.text) })

    // ---- Esquecer confirms on the row; a forgotten process' pane says so ----
    await win.evaluate(() => window.__tether.processesOpenPad())
    await click('worker', 'output')
    await until('worker pane', async () => (await output('worker')) !== null)
    await win.locator(`${PAD} .pr-row[data-proc="worker"] button[data-action="more"]`).click()
    await win.locator('#ctx-menu li[role^=menuitem]', { hasText: 'Esquecer' }).click()
    const confirmRow = await until('confirmation on the row', async () => { const r = await rowOf('worker'); return r?.confirm ? r : undefined })
    assert.equal(confirmRow.confirm, FORGET_CONFIRM)
    assert.ok(await proc('worker'), 'nothing forgotten before the confirmation')
    await win.locator(`${PAD} .pr-row[data-proc="worker"] .pr-actions button`, { hasText: 'Esquecer' }).click()
    await until('worker gone from the pad', async () => !(await rowOf('worker')))
    assert.equal(await proc('worker'), undefined)
    await until('the pane says forgotten', async () => (await output('worker'))?.forgotten)
    assert.match((await output('worker')).card, /processo esquecido/)

    // ---- the feed (the Regency's "Sistema"): the list without env, the record on another desk, a peek with no tab, stop and start ----
    const feed = (op: string, name?: string, arg?: Record<string, unknown>): Promise<EmbedAnswer> => win.evaluate(a => window.__tether.processesEmbed(a.op, a.name, a.arg), { op, name, arg })
    const read = await feed('read')
    assert.equal(read.active, true)
    assert.ok(read.names!.includes('web') && !read.names!.includes('worker'), 'the feed lists what the pad lists')
    assert.equal(read.hasEnv, false, 'no env in the feed')
    const here = await win.evaluate(() => window.__tether.activeDesk())
    const other = await win.evaluate(h => window.__tether.createDesk('after', h), here)
    await win.evaluate(h => window.__tether.switchDesk(h), here)
    await win.waitForFunction(h => window.__tether.activeDesk() === h, here)
    await win.evaluate(() => window.__tether.closePanel('process:web'))
    await until('web record closed', async () => (await output('web')) === null)
    const panesOf = (deskId: string): Promise<string[]> => win.evaluate(d => window.__tether.desks().find(x => x.id === d)?.panes ?? [], deskId)
    // The record as a tab on the other desk: the desk in view does not change.
    assert.deepEqual(await feed('output', 'web', { deskId: other }), { ok: true })
    assert.ok((await panesOf(other)).includes('process:web'), 'the record is a tab on the other desk')
    assert.equal(await win.evaluate(() => window.__tether.activeDesk()), here, 'the person was not moved')
    assert.match((await feed('output', 'web', { deskId: other })).refusal ?? '', /já está aberto como guia/)
    assert.match((await feed('output', 'nope-proc', { deskId: other })).refusal ?? '', /não existe mais/)
    await win.evaluate(() => window.__tether.closePanel('process:web'))
    await until('the tab left the other desk', async () => !(await panesOf(other)).includes('process:web'))
    // A peek with no tab: the card shows the lines arriving, and no `process:` pane is in the layout.
    assert.deepEqual(await feed('peekOutput', 'web'), { ok: true })
    await until('the card is the record', async () => { const s = await win.evaluate(() => window.__tether.peekState()); return s.open && s.screenType === 'process' })
    const first = await until('lines in the card', async () => { const x = await output('web'); return x && /tick \d+/.test(x.text) ? x : undefined })
    await until('lines keep arriving in the card', async () => ticks((await output('web')).text) > ticks(first.text) + 2)
    assert.ok(!(await win.evaluate(() => window.__tether.panelIds())).includes('process:web'), 'no pane of the record in the layout')
    assert.ok(!(await win.evaluate(() => window.__tether.drawer())).panes.includes('process:web'), 'nor in the drawer')
    assert.equal(await win.evaluate(() => window.__tether.activeDesk()), here)
    await win.click('#peek .peek-close')
    await win.waitForSelector('#peek', { state: 'hidden' })
    await until('the card record is gone', async () => (await output('web')) === null)
    // Stop and start by the feed, as the person.
    const runBefore = (await proc('web'))!.run!
    assert.deepEqual(await feed('stop', 'web'), { ok: true })
    await until('web stopped by the feed', async () => (await proc('web'))?.status === 'stopped')
    assert.equal((await history('web')).filter(e => e.kind === 'stop-requested').at(-1)?.by?.kind, 'app')
    assert.deepEqual(await feed('start', 'web'), { ok: true })
    await until('web started by the feed', async () => { const p = await proc('web'); return p?.status === 'running' && p.run === runBefore + 1 })
    await track('web')
    // Others' uses refuse with who, until when and what for; waiting is not forced.
    await ok(['proc', 'use', 'web', '10m', 'e2e do checkout', '--as', 'kai'])
    await until('the use is in the feed', async () => JSON.parse((await feed('read')).json!).some((p: { name: string; uses?: unknown[] }) => p.name === 'web' && p.uses?.length))
    const refused = await feed('stop', 'web') as { refusal: string; inUse?: { lines: string[]; exits: { id: string }[] } }
    assert.match(refused.refusal, /parar "web"/)
    assert.match(refused.inUse!.lines.join('\n'), /kai usa até daqui a .*e2e do checkout/)
    assert.deepEqual(refused.inUse!.exits.map(e => e.id), ['wait', 'force', 'cancel'])
    assert.equal((await proc('web'))!.status, 'running', 'the refusal stopped nothing')
    assert.match((await feed('stop', 'web', { force: ' ' })).refusal ?? '', /motivo/)
    assert.deepEqual(await feed('stop', 'web', { force: 'e2e do feed' }), { ok: true })
    await until('web stopped over the use', async () => (await proc('web'))?.status === 'stopped')
    assert.equal((await history('web')).filter(e => e.kind === 'forced').at(-1)?.reason, 'e2e do feed')
    await ok(['proc', 'release', 'web', '--as', 'kai'])
  } finally {
    outside?.close()
    try {
      const h = await cli(['proc', 'host', '--json'])
      const host = h.code === 0 ? JSON.parse(h.stdout) as { pid: number } | null : null
      if (host) seen.add(host.pid)
      await cli(['proc', 'host', 'stop', '--force'])
    } catch { /* tetherd gone: the host goes when its processes are stopped below */ }
    if (app) await killElectron(app, root).catch(() => {})
    for (const d of daemons) await killOwned(d, { tree: true })
    for (let i = 0; i < 20 && (daemons.some(d => pidAlive(d.pid)) || [...seen].some(pidAlive)); i++) await sleep(500)
    const left = [...seen].filter(pidAlive)
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
    assert.deepEqual(left, [], 'processes left after the test')
  }
})
