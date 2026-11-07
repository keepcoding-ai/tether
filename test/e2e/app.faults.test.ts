// E2E of fault capture (src/core/faults.ts + the hooks in each process), on a private TETHER_HOME/TETHER_USER_DIR:
//   1. TETHER_TEST_THROW injects a throw and a rejection in the main process and in the renderer; each ends in
//      <userDir>/faults/faults.jsonl with the right proc/kind, and faults-state.json counts them;
//   2. a launcher with no main-app.cjs next to it (the app cannot even load) files a `load` line from main and
//      still fails the way it did before (non-zero exit).
// Kills go through test/kill.ts by identity only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { claim, killOwned, type Owned } from '../kill.ts'
import { killElectron } from './electron.ts'

declare const window: { __tether: { connection(): { connected: boolean; pid?: number } | undefined } }

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..', '..')
const electronPath = require('electron') as string
const mainPath = join(root, 'app', 'dist', 'main.cjs')
const pipe = `\\\\.\\pipe\\tether-faultstest-${process.pid}`
const daemonMain = join(root, 'src', 'daemon', 'main.ts')

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

type Line = { proc: string; kind: string; message: string; sig: string; version: string; context: Record<string, unknown> }
function lines(userDir: string): Line[] {
  const file = join(userDir, 'faults', 'faults.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Line)
}
async function waitLines(userDir: string, want: (l: Line[]) => boolean): Promise<Line[]> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const l = lines(userDir)
    if (want(l)) return l
    await sleep(200)
  }
  return lines(userDir)
}
const cleanEnv = (): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_') && !/^(CLAUDE|TETHER_|ATRIUM_)/i.test(k)) env[k] = v
  return env
}

test('fault capture: injected throws in main and renderer reach faults.jsonl', async () => {
  const build = spawnSync(process.execPath, [join(root, 'app', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  assert.equal(build.status, 0, 'app build failed')
  const home = mkdtempSync(join(tmpdir(), 'tether-faultstest-home-'))
  const userDir = mkdtempSync(join(tmpdir(), 'tether-faultstest-user-'))
  const daemons: Owned[] = []
  let app: ElectronApplication | undefined
  try {
    const env = { ...cleanEnv(), TETHER_PIPE: pipe, TETHER_HOME: home, TETHER_USER_DIR: userDir, TETHER_E2E_HIDDEN: '1', TETHER_TEST_THROW: 'main,main-rejection,renderer,renderer-rejection' }
    app = await _electron.launch({ executablePath: electronPath, args: [mainPath], env })
    const page: Page = await app.firstWindow()
    await page.waitForSelector('#conn.on', { timeout: 30_000 })
    const daemonPid = (await page.evaluate(() => window.__tether.connection()))?.pid
    if (daemonPid) daemons.push(await claim(daemonPid, { cmdIncludes: daemonMain, what: 'tetherd' }))

    const got = await waitLines(userDir, l => l.length >= 4)
    const find = (proc: string, kind: string, text: string): Line | undefined => got.find(x => x.proc === proc && x.kind === kind && x.message.includes(text))
    assert.ok(find('main', 'uncaught', 'tether test throw (main)'), JSON.stringify(got.map(x => [x.proc, x.kind, x.message])))
    assert.ok(find('main', 'rejection', 'tether test rejection (main)'))
    const r = find('renderer', 'uncaught', 'tether test throw (renderer)')
    assert.ok(r, 'renderer window error')
    assert.equal(typeof r.context.windowId, 'number')
    assert.ok(find('renderer', 'rejection', 'tether test rejection (renderer)'))
    for (const l of got) assert.match(l.sig, /^[0-9a-f]{64}$/)
    const state = JSON.parse(readFileSync(join(userDir, 'faults', 'faults-state.json'), 'utf8')) as { faults: Record<string, { count: number; status: string; shortId: string }> }
    assert.ok(Object.keys(state.faults).length >= 4)
    assert.ok(Object.values(state.faults).every(f => f.status === 'open' && f.count >= 1 && f.shortId.length >= 4))
  } finally {
    if (app) await killElectron(app, root).catch(e => console.error(String(e)))
    for (const d of daemons) await killOwned(d, { tree: true })
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && daemons.some(d => pidAlive(d.pid))) await sleep(200)
    for (const dir of [home, userDir]) for (let i = 0; i < 5; i++) { try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) } }
  }
})

test('fault capture: a launcher whose main-app.cjs is missing files a load fault and still fails', () => {
  const dist = mkdtempSync(join(tmpdir(), 'tether-faultstest-launcher-'))
  const userDir = mkdtempSync(join(tmpdir(), 'tether-faultstest-user-'))
  try {
    copyFileSync(join(root, 'app', 'main', 'launcher.cjs'), join(dist, 'main.cjs')) // no main-app.cjs beside it
    // ELECTRON_RUN_AS_NODE: Electron's own binary as plain node, so the load failure does not raise a native box.
    const r = spawnSync(electronPath, [join(dist, 'main.cjs')], { env: { ...cleanEnv(), ELECTRON_RUN_AS_NODE: '1', TETHER_USER_DIR: userDir }, encoding: 'utf8', timeout: 30_000 })
    assert.notEqual(r.status, 0, 'the load error is rethrown')
    assert.match(r.stderr, /main-app/)
    const got = lines(userDir)
    assert.equal(got.length, 1)
    assert.equal(got[0]!.kind, 'load')
    assert.equal(got[0]!.proc, 'main')
    assert.match(got[0]!.message, /main-app/)
    assert.match(got[0]!.sig, /^[0-9a-f]{64}$/)
  } finally {
    rmSync(dist, { recursive: true, force: true })
    rmSync(userDir, { recursive: true, force: true })
  }
})
