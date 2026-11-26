// P2 (slice E1.10a): panes hosted in tether-ptyd survive a hard kill of tetherd. A real tetherd (own home and pipes,
// panel host on) runs 3 echo panes; it is killed by force by pid (no `shutdown`); typing straight to the host keeps
// echoing with the same pane pids; a new tetherd on the same home and pipes adopts the 3 panes (`running`, same pids,
// `ptyHost`) and typing still echoes. Everything started is killed by identity at the end; nothing may be left.
// Run: node --test --test-timeout=180000 test/e2e/ptyd.survive.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PanelLink } from '../../app/main/panel-link.ts'
import type { DaemonClient } from '../../src/daemon/client.ts'
import { HostClient } from '../../src/procd/client.ts'
import { claim, killOwned } from '../kill.ts'
import { pidAlive, SuiteDaemon } from './daemon-driver.ts'

const ROOT = resolve(import.meta.dirname, '../..')
const ECHO = join(ROOT, 'test', 'e2e', 'fixtures', 'perf', 'echo.mjs')
const PANES = 3
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const root = mkdtempSync(join(tmpdir(), 'tether-survive-'))
const home = join(root, 'home')
const work = join(root, 'work')
mkdirSync(home); mkdirSync(work)
const tag = randomBytes(4).toString('hex')
const BS = String.fromCharCode(92)
const winPipe = (name: string): string => [BS, BS, '.', BS, 'pipe', BS, name].join('')
const pipe = process.platform === 'win32' ? winPipe('tether-survive-e2e-' + tag) : join(home, 'd.sock')
const ptydPipe = process.platform === 'win32' ? winPipe('tether-survive-ptyd-' + tag) : join(home, 'ptyd.sock')

const ESC = String.fromCharCode(27), BEL = String.fromCharCode(7)
const ANSI = new RegExp(ESC + '[[][0-9;?]*[ -/]*[@-~]|' + ESC + '[]][^' + BEL + ESC + ']*(?:' + BEL + '|' + ESC + '.)', 'g')
const stripAnsi = (s: string): string => s.replace(ANSI, '')

test('P2: 3 hosted panes outlive a force-killed tetherd and a new tetherd adopts them', async (t) => {
  process.env.TETHER_PANEL_HOST = '1'
  process.env.TETHER_PTYD_PIPE = ptydPipe
  const seen = new Set<number>()
  const suite1 = new SuiteDaemon(home, pipe)
  let suite2: SuiteDaemon | undefined
  let link: PanelLink | undefined
  try {
    const c1 = await suite1.connect()
    seen.add(suite1.pid)
    const listSlots = async (c: DaemonClient) => (await c.request({ t: 'list' })).slots ?? []

    const sinceLaunch = Date.now()
    const ids: string[] = []
    for (let i = 0; i < PANES; i++) {
      const created = await c1.request({ t: 'create', kind: 'shell', cwd: work, args: [process.execPath, ECHO], start: false })
      ids.push(created.slot!.slotId)
      await c1.request({ t: 'start', slotId: created.slot!.slotId })
    }
    // P3 (reported only): tetherd's loop delay while the panes launched.
    const snap = (await c1.request({ t: 'perf', since: sinceLaunch })).perf
    t.diagnostic(`P3 pane launches: tetherd loop-delay samples=${snap?.samples.length ?? 0} max=${Math.max(0, ...(snap?.samples ?? []).map(s => s.maxMs)).toFixed(1)}ms (host loop not measured yet)`)

    const pids = new Map<string, number>()
    for (const end = Date.now() + 30_000; pids.size < PANES; await sleep(100)) {
      assert.ok(Date.now() < end, 'panes never all ran')
      for (const s of await listSlots(c1)) if (ids.includes(s.slotId) && s.status === 'running' && s.pid) { assert.equal(s.ptyHost, true); pids.set(s.slotId, s.pid) }
    }
    for (const p of pids.values()) seen.add(p)
    const ptyd = await HostClient.ping(ptydPipe, home)
    assert.ok(ptyd, 'tether-ptyd answers on its isolated pipe')
    seen.add(ptyd.pid)

    // The app's way: straight to the host.
    const out = new Map<string, string>(ids.map(id => [id, '']))
    link = new PanelLink({ pipe: ptydPipe, onData: (id, d) => { if (out.has(id)) out.set(id, out.get(id)! + d) } })
    await link.start()
    assert.ok(link.connected)
    for (const id of ids) out.set(id, (await link.attach(id)).scrollback)
    const echoes = async (marker: string): Promise<void> => {
      for (const id of ids) assert.ok(link!.write(id, marker + id.slice(0, 4) + String.fromCharCode(13, 10)), 'write dropped')
      for (const end = Date.now() + 15_000; !ids.every(id => stripAnsi(out.get(id)!).includes(marker + id.slice(0, 4))); await sleep(50)) {
        assert.ok(Date.now() < end, `echo of ${marker} missing`)
      }
    }
    for (const end = Date.now() + 20_000; !ids.every(id => out.get(id)!.includes('ECHO-READY')); await sleep(50)) assert.ok(Date.now() < end, 'echo never ready')
    await echoes('BEFORE')

    // Force-kill tetherd (taskkill /F by pid, no shutdown, panes untouched).
    const oldPid = suite1.pid
    assert.ok(suite1.owned, 'tetherd identity claimed')
    assert.equal(await killOwned(suite1.owned, { tree: false }), 'killed')
    for (const end = Date.now() + 10_000; pidAlive(oldPid) && Date.now() < end; await sleep(100));
    assert.equal(pidAlive(oldPid), false, 'tetherd is dead')
    suite1.client.close()
    await echoes('AFTERKILL')
    const runs = (await (async () => { const h = await HostClient.open(ptydPipe, 5_000, { home }); try { return (await h.request({ t: 'list' })).runs ?? [] } finally { h.close() } })())
    for (const id of ids) assert.equal(runs.find(r => r.name === id && !r.exit)?.pid, pids.get(id), `host pid of ${id} unchanged`)
    for (const p of pids.values()) assert.ok(pidAlive(p), `pane pid ${p} alive`)

    // A new tetherd on the same home and pipes adopts the panes.
    suite2 = new SuiteDaemon(home, pipe)
    const c2 = await suite2.connect()
    seen.add(suite2.pid)
    assert.notEqual(suite2.pid, oldPid)
    for (const end = Date.now() + 30_000; ; await sleep(200)) {
      const now = (await listSlots(c2)).filter(s => ids.includes(s.slotId))
      if (now.length === PANES && now.every(s => s.status === 'running')) {
        for (const s of now) { assert.equal(s.pid, pids.get(s.slotId), `slot ${s.slotId} keeps its pid`); assert.equal(s.ptyHost, true, 'adopted slot is ptyHost') }
        break
      }
      assert.ok(Date.now() < end, `slots not adopted: ${now.map(s => s.status).join(',')}`)
    }
    await echoes('ADOPTED')
    t.diagnostic(`pane pids ${[...pids.values()].join(',')} unchanged; tetherd ${oldPid} -> ${suite2.pid}; ptyd ${ptyd.pid}`)
  } finally {
    try { link?.stop() } catch { /* gone */ }
    try { suite2?.client.close() } catch { /* gone */ }
    // Kill by identity (pid + creation time), never by name: the new tetherd, the host, the panes.
    const host = await HostClient.ping(ptydPipe, home)
    if (host) seen.add(host.pid)
    for (const pid of [...seen].reverse()) {
      if (!pidAlive(pid)) continue
      const owned = await claim(pid, { what: 'e2e process' }).catch(() => undefined)
      if (owned) await killOwned(owned, { tree: true })
    }
    for (const end = Date.now() + 5_000; [...seen].some(pidAlive) && Date.now() < end; await sleep(100));
    for (let i = 0; i < 5; i++) { try { rmSync(root, { recursive: true, force: true }); break } catch { await sleep(300) } }
    const left = [...seen].filter(pidAlive)
    t.diagnostic(`pids started: ${[...seen].join(', ')}; left: ${left.join(', ') || 'none'}`)
    assert.deepEqual(left, [], `processes left behind: ${left.join(', ')}`)
  }
})
