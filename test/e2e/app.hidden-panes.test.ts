// E2E of "a hidden terminal does not process output" (E4.2), against the real app on a private home/pipe, hidden window:
//   1. two hosted shells printing numbered lines; one is a background tab for several seconds: it receives (almost) no
//      `data` while hidden, and once shown its text is complete, in order, with no duplicate;
//   2. nine panes producing, eight hidden: with `performance.hiddenPanes` on the renderer gets a fraction of the `data` events
//      (= xterm writes) of the setting off (the old behaviour); renderer CPU is printed for reference (it is noisy).
// Every kill goes through test/kill.ts (pid + creation time); the tether-ptyd of the test home goes through stopPtyd.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'
import { stopPtyd } from './ptyd-driver.ts'

declare const window: {
  tether: { request(b: unknown): Promise<{ t: string; slot?: { slotId: string; ptyHost?: boolean } }>; notice(n: unknown): void; onEvent(fn: (ev: { t: string; slotId?: string; data?: string }) => void): void }
  __tether: { connection(): { pid?: number } | undefined; openSlot(id: string): void; activate(id: string): void; text(id: string): string }
  __cnt: Record<string, number>
}
declare const document: { querySelector(s: string): { checkVisibility(o?: unknown): boolean } | null }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const daemonMain = join(root, 'src', 'daemon', 'main.ts')
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

/** Prints numbered lines (L000000, L000001, ...) up to N, then END: `per` lines every 20 ms (default 5 = 250 a second). */
const EMIT = [
  'const N = Number(process.argv[2]), P = Number(process.argv[3] || 5); let i = 0;',
  'const t = setInterval(() => { let o = ""; for (let k = 0; k < P && i < N; k++, i++) o += "L" + String(i).padStart(6, "0") + "\\n"; if (i >= N) { o += "END\\n"; clearInterval(t) } process.stdout.write(o) }, 20);',
].join('\n')

interface Session { app: ElectronApplication; page: Page; home: string; daemons: Owned[] }

async function open(tag: string, hiddenPanes: boolean): Promise<Session> {
  const home = mkdtempSync(join(tmpdir(), `tether-${tag}-`))
  writeFileSync(join(home, 'emit.cjs'), EMIT)
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ performance: { hiddenPanes } }))
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !k.toUpperCase().startsWith('CLAUDE')) env[k] = v
  env.TETHER_PIPE = `\\\\.\\pipe\\tether-${tag}-${process.pid}`; env.TETHER_HOME = home; env.TETHER_E2E_HIDDEN = '1'
  const app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
  const s: Session = { app, page: await app.firstWindow(), home, daemons: [] }
  s.page.setDefaultTimeout(20_000)
  s.page.on('pageerror', e => console.error('renderer error: ' + e.message))
  await s.page.waitForSelector('#conn.on', { timeout: 30_000 })
  const pid = (await s.page.evaluate(() => window.__tether.connection()))?.pid
  assert.ok(pid && pidAlive(pid), 'the app spawned a tetherd')
  s.daemons.push(await claim(pid, { cmdIncludes: daemonMain, what: 'tetherd' }))
  await s.page.evaluate(() => { window.__cnt = {}; window.tether.onEvent(ev => { if (ev.t === 'data' && ev.slotId) window.__cnt[ev.slotId] = (window.__cnt[ev.slotId] ?? 0) + 1 }) })
  return s
}

async function close(s: Session): Promise<void> {
  await killElectron(s.app, root).catch(e => console.error(String(e)))
  await stopPtyd(s.home).catch(e => console.error(String(e)))
  for (const d of s.daemons) await killOwned(d, { tree: true })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && s.daemons.some(d => pidAlive(d.pid))) await sleep(200)
  for (let i = 0; i < 5; i++) { try { rmSync(s.home, { recursive: true, force: true }); break } catch { await sleep(300) } }
}

/** A hosted shell in the window; returns its id. The newest pane is the active tab. */
async function shell(s: Session): Promise<string> {
  const made = await s.page.evaluate(cwd => window.tether.request({ t: 'create', kind: 'shell', cwd, start: true }), s.home)
  assert.equal(made.t, 'ok')
  const id = made.slot!.slotId
  await s.page.evaluate(id => window.__tether.openSlot(id), id)
  await s.page.waitForSelector(`.panel[data-slot-id="${id}"] .xterm-helper-textarea`, { state: 'attached' })
  return id
}

const run = (s: Session, id: string, n: number, per = 5): Promise<void> =>
  s.page.evaluate(([id, cmd]) => window.tether.notice({ t: 'input', slotId: id, data: cmd }), [id, `node "${join(s.home, 'emit.cjs')}" ${n}\r`] as const)

const shown = (s: Session, id: string): Promise<boolean> =>
  s.page.evaluate(id => document.querySelector(`.panel[data-slot-id="${id}"]`)?.checkVisibility({ visibilityProperty: true }) ?? false, id)

const counts = (s: Session): Promise<Record<string, number>> => s.page.evaluate(() => ({ ...window.__cnt }))

/** The numbered lines of a pane: exactly L000000..L<n-1>, each once, in order, then END once. */
async function assertComplete(s: Session, id: string, n: number): Promise<void> {
  const text = await s.page.evaluate(id => window.__tether.text(id), id)
  const rows = text.match(/L\d{6}(?!\d)/g) ?? []
  assert.equal(rows.length, n, `${id}: ${rows.length} numbered lines, expected ${n}`)
  for (let i = 0; i < n; i++) if (rows[i] !== 'L' + String(i).padStart(6, '0')) assert.fail(`${id}: row ${i} is ${rows[i]}`)
  assert.equal(text.split('END').length, 2, `${id}: END once`)
}


test('hidden pane: no data while hidden, complete text in order once shown', { timeout: 240_000 }, async () => {
  const s = await open('hp1', true)
  try {
    const a = await shell(s)
    const b = await shell(s) // b is the active tab now; a is behind it
    await sleep(3000) // prompts
    await s.page.evaluate(id => window.__tether.activate(id), a)
    await s.page.waitForFunction(id => document.querySelector(`.panel[data-slot-id="${id}"]`)?.checkVisibility({ visibilityProperty: true }) === true, a)
    assert.equal(await shown(s, b), false, 'b is a background tab')
    await sleep(1000) // the renderer tells the main after HIDE_DELAY_MS
    const before = await counts(s)
    await run(s, a, 4000)
    await run(s, b, 4000)
    await sleep(9000)
    const mid = await counts(s)
    const gotA = (mid[a] ?? 0) - (before[a] ?? 0)
    const gotB = (mid[b] ?? 0) - (before[b] ?? 0)
    console.log(`data events while b hidden: a=${gotA} b=${gotB}`)
    assert.ok(gotA > 20, 'the visible pane receives its output')
    assert.ok(gotB <= 3, `the hidden pane receives nothing (${gotB})`)
    await sleep(9000) // both finished (4000 lines at 250/s = 16 s)
    await s.page.evaluate(id => window.__tether.activate(id), b)
    await s.page.waitForFunction(id => window.__tether.text(id).includes('END'), b, { timeout: 20_000 })
    await sleep(500)
    await assertComplete(s, b, 4000)
    await s.page.evaluate(id => window.__tether.activate(id), a)
    await s.page.waitForFunction(id => window.__tether.text(id).includes('END'), a, { timeout: 60_000 })
    await sleep(500)
    await assertComplete(s, a, 4000)
    // Hidden again: it stays hidden and cheap; shown a second time: still exact (no duplicate on a second resume).
    await s.page.evaluate(id => window.__tether.activate(id), a)
    await sleep(1000)
    await run(s, b, 400) // a second burst while b is hidden: the text of b grows by 400 numbered lines after resume
    await sleep(3500)
    await s.page.evaluate(id => window.__tether.activate(id), b)
    await s.page.waitForFunction(id => (window.__tether.text(id).match(/END/g) ?? []).length >= 2, b, { timeout: 20_000 })
    const text = await s.page.evaluate(id => window.__tether.text(id), b)
    const rows = text.match(/L\d{6}(?!\d)/g) ?? []
    assert.equal(rows.length, 4400, 'b: 4000 + 400 numbered lines, none lost, none twice')
  } finally { await close(s) }
})

async function load(hiddenPanes: boolean): Promise<{ events: number; hiddenEvents: number; cpuMs: number }> {
  const s = await open(hiddenPanes ? 'hp2' : 'hp3', hiddenPanes)
  try {
    const ids: string[] = []
    for (let i = 0; i < 9; i++) ids.push(await shell(s))
    await sleep(3000)
    const visible = ids[0]!
    await s.page.evaluate(id => window.__tether.activate(id), visible)
    await sleep(1500)
    for (const id of ids) await run(s, id, 1_000_000, 40)
    await sleep(4000) // warm up; the hiding is reported 300 ms after the switch
    const cpu = (): Promise<number> => s.app.evaluate(({ app }) => {
      const m = app.getAppMetrics().filter(p => p.type === 'Tab')
      return m.reduce((n, p) => n + (p.cpu.cumulativeCPUUsage ?? 0), 0) * 1000
    })
    const c0 = await cpu(); const n0 = await counts(s)
    await sleep(15_000)
    const c1 = await cpu(); const n1 = await counts(s)
    const delta = (id: string): number => (n1[id] ?? 0) - (n0[id] ?? 0)
    const hiddenEvents = ids.filter(id => id !== visible).reduce((n, id) => n + delta(id), 0)
    const events = hiddenEvents + delta(visible)
    console.log(`hiddenPanes=${hiddenPanes}: events=${events} (hidden panes ${hiddenEvents}) renderer cpu=${Math.round(c1 - c0)} ms in 15 s`)
    return { events, hiddenEvents, cpuMs: c1 - c0 }
  } finally { await close(s) }
}

test('eight hidden panes producing: the renderer does less work with the setting on', { timeout: 600_000 }, async () => {
  const off = await load(false)
  const on = await load(true)
  assert.ok(off.hiddenEvents > 200, `the old behaviour delivers the hidden panes' output (${off.hiddenEvents})`)
  assert.ok(on.hiddenEvents <= 8 * 3, `hidden panes get (almost) nothing with the setting on (${on.hiddenEvents})`)
  assert.ok(on.events < off.events * 0.3, `data events (= term.write calls) delivered to the renderer: ${on.events} (on) vs ${off.events} (off)`)
  console.log(`renderer cpu (noisy, informational): ${Math.round(on.cpuMs)} ms on vs ${Math.round(off.cpuMs)} ms off`)
})
