// Background processes with a REAL tetherd and a REAL tether-procd (both detached, in a home of their own), driven
// through the CLI as an agent would: a process outlives tetherd (and keeps logging), ends by itself while tetherd is
// down and is found ended with its real time and code, falls with its host, stops by tree kill when it ignores
// Ctrl+C; a missing command fails clearly; a .cmd shortcut gets an argument with a space intact. Ports: a port
// declared twice, a server outside tether in the ports view, `wait`. Declared uses between two real panels of this
// tetherd: refusal (exit 3), --wait, --force with its reason, a use that runs out (seconds: the ronda's test switch)
// across a tetherd restart, and a forgotten panel losing its use.
// Run: node --test --test-concurrency=1 test/e2e/proc.test.ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { procLogPath } from '../../src/core/paths.ts'
import type { ProcEvent, ProcState } from '../../src/daemon/procs.ts'
import { readRunFile } from '../../src/procd/run-store.ts'
import { claim, killOwned, type Owned } from '../kill.ts'
import { pidAlive, SuiteDaemon } from './daemon-driver.ts'
import { ENV_RONDA_TEST_SECONDS } from '../../src/daemon/ronda.ts'

const ROOT = resolve(import.meta.dirname, '../..')
const CLI = join(ROOT, 'bin', 'tether.mjs')
const FIX = join(ROOT, 'test', 'e2e', 'fixtures', 'proc')
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

const root = mkdtempSync(join(tmpdir(), 'tether-proc-'))
const home = join(root, 'home')
const work = join(root, 'dir com espaco')
mkdirSync(home); mkdirSync(work)
const tag = randomBytes(4).toString('hex')
// The tetherd this suite spawns accepts use durations in seconds (it inherits this environment).
process.env[ENV_RONDA_TEST_SECONDS] = '1'
const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\tether-proc-e2e-${tag}` : join(home, 'd.sock')
let suite = new SuiteDaemon(home, pipe)
/** Every pid this suite saw (host and processes): none may be left at the end. */
const seen = new Set<number>()
let port = 0

function tether(args: string[], extra: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, TETHER_HOME: home, TETHER_PIPE: pipe, ...extra }
  if (!extra.TETHER_SLOT_ID) delete env.TETHER_SLOT_ID
  delete env.TETHER_PROCD_PIPE
  return new Promise((res) => {
    execFile(process.execPath, [CLI, ...args], { env, cwd: work, windowsHide: true, encoding: 'utf8', timeout: 60_000 }, (err, stdout, stderr) => {
      res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr })
    })
  })
}

async function procs(): Promise<ProcState[]> {
  const r = await tether(['proc', 'ls', '--json'])
  assert.equal(r.code, 0, r.stderr)
  return JSON.parse(r.stdout) as ProcState[]
}
const proc = async (name: string): Promise<ProcState> => (await procs()).find(p => p.name === name)!
async function history(name: string): Promise<ProcEvent[]> {
  const r = await tether(['proc', 'history', name, '--json'])
  assert.equal(r.code, 0, r.stderr)
  return JSON.parse(r.stdout) as ProcEvent[]
}
async function hostPid(): Promise<number> {
  const r = await tether(['proc', 'host', '--json'])
  const h = JSON.parse(r.stdout) as { pid: number } | null
  assert.ok(h, 'host running')
  seen.add(h.pid)
  return h.pid
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
async function http(path = '/'): Promise<string | undefined> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2_000) })
    return await r.text()
  } catch { return undefined }
}
/** Kills this suite's tetherd by identity (pid + creation time + its command line). */
async function killDaemon(): Promise<void> {
  const owned = suite.owned!
  assert.equal(await killOwned(owned, { tree: false }), 'killed')
  await waitFor('tetherd gone', async () => !pidAlive(owned.pid))
  suite.client.close()
}
async function bootDaemon(): Promise<void> {
  suite = new SuiteDaemon(home, pipe)
  await suite.connect()
}

before(async () => {
  port = await new Promise<number>((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)) }) })
  await suite.connect()
})

after(async () => {
  try {
    if (suite.pid && pidAlive(suite.pid)) {
      const r = await tether(['proc', 'host', 'stop', '--force'])
      assert.equal(r.code, 0, r.stderr)
      await suite.shutdown()
    }
    await waitFor('every pid gone', async () => [...seen].every(p => !pidAlive(p)), 10_000).catch(() => undefined)
    const left = [...seen].filter(pidAlive)
    assert.deepEqual(left, [], 'processes left after the suite')
  } finally {
    for (let i = 0; i < 5; i++) { try { rmSync(root, { recursive: true, force: true }); break } catch { await sleep(300) } }
  }
})

test('(a) start an HTTP server: ls and info show it running', async () => {
  const r = await tether(['proc', 'start', 'web', '--desc', 'servidor de teste', '--env', 'API_KEY=segredo', '--', 'node', join(FIX, 'server.mjs'), String(port)])
  assert.equal(r.code, 0, r.stderr)
  const p = await proc('web')
  assert.equal(p.status, 'running')
  seen.add(p.pid!)
  assert.match(await waitFor('http', () => http()), new RegExp(`ok ${p.pid}`))
  const info = await tether(['proc', 'info', 'web'])
  assert.match(info.stdout, /web: rodando/)
  assert.match(info.stdout, /API_KEY=•••/)
  assert.doesNotMatch(info.stdout, /segredo/)
  assert.match((await tether(['proc', 'ls'])).stdout, /web\s+rodando\s+\d+/)
  await hostPid()
})

test('(b) another author restarts it: the history says who and why', async () => {
  const before = (await proc('web')).pid
  const r = await tether(['proc', 'restart', 'web', '--as', 'kai', '--reason', 'corrigi o parser'], { TETHER_SLOT_ID: 'painel-x' })
  assert.equal(r.code, 0, r.stderr)
  const p = await proc('web')
  assert.notEqual(p.pid, before)
  seen.add(p.pid!)
  const req = (await history('web')).find(e => e.kind === 'restart-requested')!
  assert.equal(req.by?.label, 'kai')
  assert.equal(req.by?.slotId, 'painel-x')
  assert.equal(req.reason, 'corrigi o parser')
  assert.match((await tether(['proc', 'history', 'web'])).stdout, /kai .*pediu o reinício \(execução 1\)  motivo: corrigi o parser/)
  await waitFor('http after restart', () => http())
})

test('(c) tetherd dies: the server keeps answering and logging; a new tetherd finds it running, same pid, history intact', async () => {
  const p = await proc('web')
  const events = (await history('web')).length
  const log = procLogPath(home, 'web', p.run!)
  await killDaemon()
  const size0 = statSync(log).size
  await sleep(1_500)
  assert.match((await http()) ?? '', new RegExp(`ok ${p.pid}`), 'still answering with tetherd dead')
  assert.ok(statSync(log).size > size0, 'the log kept growing while tetherd was down')
  await bootDaemon()
  const again = await proc('web')
  assert.equal(again.status, 'running')
  assert.equal(again.pid, p.pid)
  assert.equal((await history('web')).length, events, 'nothing added or lost')
})

test('(d) it ends by itself (code 7) while tetherd is down: the new tetherd records the real time and does not restart', async () => {
  const p = await proc('web')
  await killDaemon()
  await http('/exit?code=7')
  const exit = await waitFor('run.json exit', async () => readRunFile(home, 'web')?.exit)
  assert.equal(exit.code, 7)
  await sleep(2_000)
  await bootDaemon()
  const s = await proc('web')
  assert.equal(s.status, 'exited')
  assert.equal(s.attention, true)
  assert.equal(s.pid, undefined)
  const ended = (await history('web')).filter(e => e.kind === 'ended').at(-1)!
  assert.equal(ended.run, p.run)
  assert.equal(ended.cause, 'own')
  assert.equal(ended.code, 7)
  assert.equal(ended.at, exit.at, 'the real exit time, from run.json')
  assert.ok(Date.parse(ended.ts) - Date.parse(ended.at!) >= 1_500, 'recorded later than it happened')
  assert.match((await tether(['proc', 'ls'])).stdout, /encerrou sozinho \(7\)/)
  await sleep(1_000)
  assert.equal((await history('web')).filter(e => e.kind === 'started').length, 2, 'never restarted by itself')
})

test('(e) the host dies: the process falls with it, "caiu com o anfitrião", not restarted', async () => {
  assert.equal((await tether(['proc', 'start', 'web'])).code, 0)
  const p = await proc('web')
  seen.add(p.pid!)
  await waitFor('http', () => http())
  const hp = await hostPid()
  const owned: Owned = await claim(hp, { cmdIncludes: join(home, 'bin'), what: 'tether-procd' })
  assert.equal(await killOwned(owned, { tree: false }), 'killed')
  const s = await waitFor('host-lost', async () => { const x = await proc('web'); return x.status === 'host-lost' ? x : undefined })
  assert.equal(s.attention, true)
  assert.equal(await http(), undefined, 'the server died with its host')
  assert.equal(pidAlive(p.pid!), false)
  assert.match((await tether(['proc', 'ls'])).stdout, /caiu com o anfitrião/)
  assert.equal((await history('web')).filter(e => e.kind === 'started').length, 3)
})

test('(f) stop of a process that ignores Ctrl+C: tree kill after the grace', async () => {
  assert.equal((await tether(['proc', 'start', 'teimoso', '--grace', '2s', '--', 'node', join(FIX, 'sigint-ignore.mjs')])).code, 0)
  const p = await proc('teimoso')
  seen.add(p.pid!)
  await hostPid()
  const t0 = Date.now()
  const r = await tether(['proc', 'stop', 'teimoso', '--reason', 'teste'])
  const ms = Date.now() - t0
  assert.equal(r.code, 0, r.stderr)
  assert.ok(ms >= 2_000, `waited the grace (${ms} ms)`)
  const s = await proc('teimoso')
  assert.equal(s.status, 'stopped')
  assert.equal(s.reason, 'teste')
  assert.equal(pidAlive(p.pid!), false)
  assert.match((await tether(['proc', 'logs', 'teimoso'])).stdout, /ignorando SIGINT/, 'Ctrl+C came first')
})

test('(g) a command that does not exist: failed with a useful message', async () => {
  const r = await tether(['proc', 'start', 'ruim', '--', 'nao-existe-xyz'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /comando não encontrado: nao-existe-xyz/)
  assert.equal((await proc('ruim')).status, 'failed')
  assert.match((await tether(['proc', 'ls'])).stdout, /ruim\s+não subiu/)
})

test('(h) a .cmd shortcut in a folder with a space gets "a b" as one argument', { skip: process.platform !== 'win32' && 'Windows-only' }, async () => {
  const cmd = join(work, 'eco args.cmd')
  writeFileSync(cmd, `@node "${join(FIX, 'print-args.mjs')}" %*\r\n`)
  const r = await tether(['proc', 'start', 'eco', '--grace', '1s', '--', cmd, 'a b', 'c'])
  assert.equal(r.code, 0, r.stderr)
  const p = await proc('eco')
  seen.add(p.pid!)
  const line = await waitFor('ARGS line', async () => /ARGS (.*)/.exec(readFileSync(procLogPath(home, 'eco', 1), 'utf8'))?.[1])
  assert.deepEqual(JSON.parse(line), ['a b', 'c'])
  assert.equal((await tether(['proc', 'stop', 'eco'])).code, 0)
  assert.equal((await proc('eco')).status, 'stopped')
})

// ---- slices 2-3: ports and declared uses ---------------------------------------------------------

const freePort = () => new Promise<number>((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)) }) })
const SERVER = join(FIX, 'server.mjs')
let slotA = ''
let slotB = ''
const asA = () => ({ TETHER_SLOT_ID: slotA })
const asB = () => ({ TETHER_SLOT_ID: slotB })

test('(i) two processes declaring the same port: the second start is refused with the name of the first', async () => {
  const p = await freePort()
  assert.equal((await tether(['proc', 'start', 'um', '--port', String(p), '--', 'node', SERVER, String(p)])).code, 0)
  seen.add((await proc('um')).pid!)
  const r = await tether(['proc', 'start', 'dois', '--port', String(p), '--', 'node', SERVER, String(p)])
  assert.equal(r.code, 1)
  assert.match(r.stderr, new RegExp(`a porta ${p} é declarada por um, que está rodando`))
  assert.equal((await procs()).some(x => x.name === 'dois'), false, 'nothing registered')
  assert.equal((await tether(['proc', 'stop', 'um'])).code, 0)
})

test('(j) a server outside tether shows in proc ports with exe and pid; --check answers busy / free / declared', async () => {
  const p = await freePort()
  const outside = createServer()
  await new Promise<void>((r) => outside.listen(p, '127.0.0.1', () => r()))
  try {
    const rows = JSON.parse((await tether(['proc', 'ports', '--json'])).stdout) as { port: number; outside?: boolean; owner?: { pid: number; exe?: string } }[]
    const row = rows.find(x => x.port === p)!
    assert.equal(row.outside, true)
    assert.equal(row.owner?.pid, process.pid)
    assert.match(row.owner?.exe ?? '', /node/i)
    assert.match((await tether(['proc', 'ports'])).stdout, new RegExp(`${p}\\s+ouvindo\\s+fora do tether: node(\\.exe)?, pid ${process.pid}`))
    const busy = await tether(['proc', 'ports', '--check', String(p)])
    assert.equal(busy.code, 1)
    assert.match(busy.stdout, new RegExp(`porta ${p}: ocupada por fora do tether: .*pid ${process.pid}`))
  } finally {
    await new Promise<void>((r) => outside.close(() => r()))
  }
  const free = await tether(['proc', 'ports', '--check', String(p)])
  assert.equal(free.code, 0)
  assert.match(free.stdout, new RegExp(`porta ${p}: livre`))
  const declared = (await proc('um')).card.ports[0]!
  assert.match((await tether(['proc', 'ports', '--check', String(declared)])).stdout, new RegExp(`porta ${declared}: declarada por um \\(parado\\)`))
})

test('(k) wait returns when the port listens; when the process dies first it prints the end of the log', async () => {
  const p = await freePort()
  const late = `setTimeout(() => require("http").createServer().listen(${p}, "127.0.0.1", () => console.log("ouvindo")), 1500); setInterval(() => {}, 1000)`
  assert.equal((await tether(['proc', 'start', 'lento', '--port', String(p), '--', 'node', '-e', late])).code, 0)
  seen.add((await proc('lento')).pid!)
  const t0 = Date.now()
  const ok = await tether(['proc', 'wait', 'lento', '--timeout', '20s'])
  assert.equal(ok.code, 0, ok.stdout + ok.stderr)
  assert.match(ok.stdout, new RegExp(`lento pronto: ${p} ✓`))
  assert.ok(Date.now() - t0 >= 1_000, 'it waited for the port')
  assert.equal((await tether(['proc', 'stop', 'lento'])).code, 0)

  const q = await freePort()
  assert.equal((await tether(['proc', 'start', 'morre', '--port', String(q), '--', 'node', '-e', 'console.log("falhei: config ausente"); setTimeout(() => process.exit(2), 800)'])).code, 0)
  const dead = await tether(['proc', 'wait', 'morre', '--timeout', '20s'])
  assert.equal(dead.code, 1)
  assert.match(dead.stdout, /morre: encerrou sozinho \(2\); não vai ficar pronto/)
  assert.match(dead.stdout, /falhei: config ausente/)
})

test('(l) A declares a use; B is refused (exit 3, board, same pid, refused-in-use); --wait runs once A releases; --force records the reason', async () => {
  slotA = (await suite.client.request({ t: 'create', kind: 'shell', cwd: work, name: 'painel-a' })).slot!.slotId
  slotB = (await suite.client.request({ t: 'create', kind: 'shell', cwd: work, name: 'painel-b' })).slot!.slotId
  const p = await freePort()
  assert.equal((await tether(['proc', 'start', 'svc', '--port', String(p), '--', 'node', SERVER, String(p)], asA())).code, 0)
  const pid0 = (await proc('svc')).pid!
  seen.add(pid0)
  const use = await tether(['proc', 'use', 'svc', '10m', 'e2e do checkout'], asA())
  assert.equal(use.code, 0, use.stderr)
  assert.match((await tether(['proc', 'ls'])).stdout, /svc: em uso por painel-a \(shell\) até \d\d:\d\d:\d\d: e2e do checkout/)

  const refused = await tether(['proc', 'restart', 'svc'], asB())
  assert.equal(refused.code, 3)
  assert.match(refused.stdout, /svc está em uso; não vou reiniciar agora\./)
  assert.match(refused.stdout, /painel-a \(shell\) até .*: e2e do checkout/)
  assert.match(refused.stdout, /--force "motivo"/)
  assert.equal((await proc('svc')).pid, pid0, 'nothing restarted')
  assert.equal((await history('svc')).at(-1)!.kind, 'refused-in-use')

  const waiting = tether(['proc', 'restart', 'svc', '--wait', '30s'], asB())
  await sleep(1_500)
  assert.equal((await proc('svc')).pid, pid0, 'B is still waiting')
  assert.equal((await tether(['proc', 'release', 'svc'], asA())).code, 0)
  const waited = await waiting
  assert.equal(waited.code, 0, waited.stdout + waited.stderr)
  const pid1 = (await proc('svc')).pid!
  assert.notEqual(pid1, pid0)
  seen.add(pid1)

  assert.equal((await tether(['proc', 'use', 'svc', 'carga'], asA())).code, 0)
  const forced = await tether(['proc', 'restart', 'svc', '--force', 'corrigi o parser'], asB())
  assert.equal(forced.code, 0, forced.stdout + forced.stderr)
  const pid2 = (await proc('svc')).pid!
  assert.notEqual(pid2, pid1)
  seen.add(pid2)
  const ev = (await history('svc')).find(e => e.kind === 'forced')!
  assert.equal(ev.reason, 'corrigi o parser')
  assert.equal(ev.over![0]!.by.slotId, slotA)
  assert.match((await tether(['proc', 'history', 'svc'])).stdout, /painel-b \(shell\)  forçou reiniciar sobre o uso de painel-a \(shell\)  motivo: corrigi o parser/)
  const notices = readFileSync(join(home, 'slots', `${slotA}.notices.jsonl`), 'utf8')
  assert.match(notices, /svc foi reiniciado por painel-b \(shell\), à força sobre o seu uso, motivo: \\"corrigi o parser\\"/)
  assert.equal((await tether(['proc', 'release', 'svc'], asA())).code, 0)
})

test('(m) a use runs out by itself and survives a tetherd restart until then', async () => {
  assert.equal((await tether(['proc', 'use', 'svc', '10s', 'curto'], asA())).code, 0)
  await killDaemon()
  await bootDaemon()
  const s = await proc('svc')
  assert.equal(s.uses?.length, 1, 'the use outlived tetherd')
  assert.equal(s.uses![0]!.purpose, 'curto')
  await waitFor('use-expired', async () => (await history('svc')).at(-1)!.kind === 'use-expired', 20_000)
  assert.equal((await proc('svc')).uses, undefined)
})

test('(n) the panel of A is forgotten: its use is gone', async () => {
  assert.equal((await tether(['proc', 'use', 'svc', '10m', 'de novo'], asA())).code, 0)
  assert.equal((await proc('svc')).uses?.length, 1)
  await suite.client.request({ t: 'forget', slotId: slotA })
  assert.equal((await proc('svc')).uses, undefined)
  const last = (await history('svc')).at(-1)!
  assert.equal(last.kind, 'use-released')
  assert.equal(last.cause, 'panel-gone')
  assert.equal((await tether(['proc', 'stop', 'svc'], asB())).code, 0)
})
