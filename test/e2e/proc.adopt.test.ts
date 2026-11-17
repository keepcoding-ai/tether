// Adoption of a process that already runs outside tether, with a REAL tetherd and a REAL tether-procd (both detached,
// in a home of their own), driven through the CLI. Only processes this test launched are adopted or killed.
// Covers: adopting a node that listens on a port (it shows in ls and ports, the card says it was adopted and by whom);
// refusals (no recipe, a pid that does not exist, the tetherd itself) that touch nothing; start refused while it runs
// outside; restart stops the external by pid and tether starts its own (same port, a log now exists); rm takes an
// adopted one off the board and leaves it answering; an adopted process killed from outside asks for attention and is
// never started again by itself.
// Run: node --test --test-concurrency=1 test/e2e/proc.adopt.test.ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { procAdoptPath, procLogPath } from '../../src/core/paths.ts'
import type { ProcEvent, ProcState } from '../../src/daemon/procs.ts'
import type { PortRow } from '../../src/daemon/ports.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { pidAlive, SuiteDaemon } from './daemon-driver.ts'

const ROOT = resolve(import.meta.dirname, '../..')
const CLI = join(ROOT, 'bin', 'tether.mjs')
const SERVER = join(ROOT, 'test', 'e2e', 'fixtures', 'proc', 'server.mjs')
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

const root = mkdtempSync(join(tmpdir(), 'tether-adopt-'))
const home = join(root, 'home')
const work = join(root, 'work')
mkdirSync(home); mkdirSync(work)
const tag = randomBytes(4).toString('hex')
const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\tether-adopt-e2e-${tag}` : join(home, 'd.sock')
const suite = new SuiteDaemon(home, pipe)
/** Every pid this suite launched or saw: none may be left at the end. */
const seen = new Set<number>()
const externals: Owned[] = []

function tether(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, TETHER_HOME: home, TETHER_PIPE: pipe }
  delete env.TETHER_SLOT_ID
  delete env.TETHER_PROCD_PIPE
  return new Promise((res) => {
    execFile(process.execPath, [CLI, ...args], { env, cwd: work, windowsHide: true, encoding: 'utf8', timeout: 60_000 }, (err, stdout, stderr) => {
      res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr })
    })
  })
}
async function freePort(): Promise<number> {
  return new Promise<number>((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)) }) })
}
async function http(port: number): Promise<string | undefined> {
  try { return await (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) })).text() } catch { return undefined }
}
async function waitFor<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`)
    await sleep(200)
  }
}
/** Launches a server outside tether (the test is its parent), once it answers; claims its identity for the final cleanup. */
async function launchExternal(port: number): Promise<number> {
  const child = spawn(process.execPath, [SERVER, String(port)], { stdio: 'ignore', windowsHide: true, cwd: work })
  child.unref()
  const pid = child.pid!
  seen.add(pid)
  externals.push(await claim(pid, { cmdIncludes: 'server.mjs', what: 'external server' }))
  await waitFor('external server answering', () => http(port))
  return pid
}
const proc = async (name: string): Promise<ProcState | undefined> => {
  const r = await tether(['proc', 'ls', '--json'])
  assert.equal(r.code, 0, r.stderr)
  return (JSON.parse(r.stdout) as ProcState[]).find(p => p.name === name)
}
async function history(name: string): Promise<ProcEvent[]> {
  const r = await tether(['proc', 'history', name, '--json'])
  assert.equal(r.code, 0, r.stderr)
  return JSON.parse(r.stdout) as ProcEvent[]
}
const recipe = (port: number): string[] => ['--port', String(port), '--env', 'MODO=adotado', '--desc', 'servidor de fora', '--', 'node', SERVER, String(port)]

before(async () => { await suite.connect() })

after(async () => {
  try {
    if (suite.pid && pidAlive(suite.pid)) {
      await tether(['proc', 'host', 'stop', '--force'])
      await suite.shutdown()
    }
    for (const o of externals) await killOwned(o, { tree: true })
    await waitFor('every pid gone', async () => [...seen].every(p => !pidAlive(p)), 10_000).catch(() => undefined)
    assert.deepEqual([...seen].filter(pidAlive), [], 'processes left after the suite')
  } finally {
    for (let i = 0; i < 5; i++) { try { rmSync(root, { recursive: true, force: true }); break } catch { await sleep(300) } }
  }
})

let port = 0
let extPid = 0

test('(a) refusals touch nothing: no recipe, a pid that does not exist, the tetherd itself', async () => {
  port = await freePort()
  extPid = await launchExternal(port)

  const bare = await tether(['proc', 'adopt', 'ext', '--pid', String(extPid), '--port', String(port)])
  assert.notEqual(bare.code, 0)
  assert.match(bare.stderr, /receita completa/)

  // a pid that existed and is gone
  const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true })
  const deadPid = dead.pid!
  await new Promise(r => dead.once('exit', r))
  await sleep(300)
  const gone = await tether(['proc', 'adopt', 'ext', '--pid', String(deadPid), ...recipe(port)])
  assert.equal(gone.code, 1)
  assert.match(gone.stderr, new RegExp(`pid ${deadPid} não existe`))

  const self = await tether(['proc', 'adopt', 'ext', '--pid', String(suite.pid), ...recipe(port)])
  assert.equal(self.code, 1)
  assert.match(self.stderr, /é o tetherd/)

  assert.equal(await proc('ext'), undefined, 'nothing was registered')
  assert.equal(existsSync(procAdoptPath(home, 'ext')), false)
  assert.match((await http(port)) ?? '', new RegExp(`ok ${extPid}`), 'the external server was not touched')
})

test('(b) adopting a node that already listens: ls, ports, the card says who adopted it', async () => {
  const r = await tether(['proc', 'adopt', 'ext', '--pid', String(extPid), ...recipe(port)])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, new RegExp(`ext adotado \\(pid ${extPid}\\)`))
  assert.ok(existsSync(procAdoptPath(home, 'ext')), 'the identity (pid + creation time) was written')

  const p = (await proc('ext'))!
  assert.equal(p.status, 'running')
  assert.equal(p.external, true)
  assert.equal(p.pid, extPid)
  assert.equal(p.run, undefined)
  assert.equal(p.startedBy?.kind, 'external')
  assert.match((await tether(['proc', 'ls'])).stdout, new RegExp(`ext\\s+externo \\(adotado\\)\\s+${extPid}`))

  const info = await tether(['proc', 'info', 'ext'])
  assert.match(info.stdout, /ext: externo \(adotado\)/)
  assert.match(info.stdout, /adotado por /)
  assert.match(info.stdout, /MODO=adotado/)
  const adopted = (await history('ext')).find(e => e.kind === 'adopted')!
  assert.equal(adopted.pid, extPid)
  assert.ok(adopted.by, 'the adoption names its author')
  assert.match((await tether(['proc', 'history', 'ext'])).stdout, new RegExp(`adotou o processo externo \\(pid ${extPid}\\)`))

  const ports = JSON.parse((await tether(['proc', 'ports', '--json'])).stdout) as PortRow[]
  const row = ports.find(x => x.port === port)!
  assert.equal(row.listening, true)
  assert.equal(row.owner?.proc, 'ext', 'the port is owned by the adopted process, not "fora do tether"')

  const logs = await tether(['proc', 'logs', 'ext'])
  assert.equal(logs.code, 1)
  assert.match(logs.stderr, /processo adotado: o tether não tem a saída dele/)
  assert.match((await http(port)) ?? '', new RegExp(`ok ${extPid}`), 'still the external one answering')
})

test('(c) the same name again and a pid already under the board are refused; start says it runs outside', async () => {
  const again = await tether(['proc', 'adopt', 'ext', '--pid', String(extPid), ...recipe(port)])
  assert.equal(again.code, 1)
  assert.match(again.stderr, /já existe um processo ext/)
  const other = await tether(['proc', 'adopt', 'ext2', '--pid', String(extPid), ...recipe(await freePort())])
  assert.equal(other.code, 1, 'a pid that is already adopted is not adopted twice')
  assert.match(other.stderr, /já está na árvore de ext/)
  const start = await tether(['proc', 'start', 'ext'])
  assert.equal(start.code, 1)
  assert.match(start.stderr, new RegExp(`roda fora do tether \\(pid ${extPid}`))
  assert.match(start.stderr, /use restart/)
})

test('(d) restart stops the external by its pid and tether starts its own on the same port', async () => {
  const r = await tether(['proc', 'restart', 'ext', '--reason', 'o tether assume'])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  await waitFor('external pid gone', async () => !pidAlive(extPid), 10_000)
  const p = (await proc('ext'))!
  assert.equal(p.status, 'running')
  assert.equal(p.external, undefined, 'now it is tether\'s own')
  assert.notEqual(p.pid, extPid)
  assert.equal(p.run, 2, 'execution 1 was the adoption; the first of tether is the next one')
  seen.add(p.pid!)
  assert.match(await waitFor('own server answering', () => http(port)), new RegExp(`ok ${p.pid}`))
  assert.equal(existsSync(procAdoptPath(home, 'ext')), false, 'the identity file is gone')
  const kinds = (await history('ext')).map(e => e.kind)
  assert.deepEqual(kinds.filter(k => k !== 'use-declared'), ['registered', 'adopted', 'restart-requested', 'ended', 'started'])
  const ended = (await history('ext')).find(e => e.kind === 'ended')!
  assert.equal(ended.cause, 'requested')
  assert.ok(existsSync(procLogPath(home, 'ext', p.run!)), 'a log exists from now on')
  assert.equal((await tether(['proc', 'logs', 'ext'])).code, 0)
  assert.equal((await tether(['proc', 'stop', 'ext'])).code, 0)
})

test('(e) rm takes an adopted process off the board and leaves it answering', async () => {
  const port2 = await freePort()
  const pid = await launchExternal(port2)
  assert.equal((await tether(['proc', 'adopt', 'keep', '--pid', String(pid), ...recipe(port2)])).code, 0)
  const rm = await tether(['proc', 'rm', 'keep'])
  assert.equal(rm.code, 0, rm.stderr)
  assert.match(rm.stdout, new RegExp(`segue rodando, intocado`))
  assert.equal(await proc('keep'), undefined)
  assert.equal(existsSync(procAdoptPath(home, 'keep')), false)
  assert.match((await http(port2)) ?? '', new RegExp(`ok ${pid}`))
})

test('(f) an adopted process killed from outside asks for attention and is not started again', async () => {
  const port3 = await freePort()
  const pid = await launchExternal(port3)
  assert.equal((await tether(['proc', 'adopt', 'frail', '--pid', String(pid), ...recipe(port3)])).code, 0)
  assert.equal(await killOwned(externals.at(-1)!, { tree: true }), 'killed')
  await waitFor('pid gone', async () => !pidAlive(pid))
  const p = (await proc('frail'))!
  assert.equal(p.status, 'exited')
  assert.equal(p.attention, true)
  assert.equal(p.exit?.cause, 'external')
  assert.equal(p.exit?.code, undefined, 'the exit code is unknown')
  assert.match((await tether(['proc', 'history', 'frail'])).stdout, new RegExp(`o processo externo adotado \\(pid ${pid}\\) não existe mais`))
  assert.equal(existsSync(procAdoptPath(home, 'frail')), false)
  await sleep(1_000)
  assert.equal((await history('frail')).filter(e => e.kind === 'started').length, 0, 'never started by itself')
  assert.equal(await http(port3), undefined)
})
