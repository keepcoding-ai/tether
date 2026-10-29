// `killall node` does not reach tether (PROGRESS R3): the daemon runs as <home>/bin/tetherd.exe and a soul panel
// as <home>/bin/tether-soul.exe, both copies of the node that would have run them.
//   1. a tetherd of its own (private TETHER_HOME + pipe, spawned through spawnDaemon the way the app does) +
//      a shell slot + a "soul" slot whose CLI is a stub (TETHER_SOUL_CMD = "<node> <home>/soul-stub.mjs": no model,
//      but the adapter path that swaps the node for tether-soul.exe is the real one);
//   2. a sentinel: a plain node.exe child running a script in the test home;
//   3. the killall, emulated so that it cannot touch anyone else's node: every node.exe whose command line names
//      THIS test's home, killed by identity (pid + creation time, test/kill.ts);
//   4. the sentinel is dead (a tetherd on plain node would be too); tetherd.exe and tether-soul.exe are alive by
//      identity, the daemon still answers, the shell slot still echoes, the soul stub still has its pid.
// Windows-only: the renamed executables are about Windows' kill-by-image-name tools.
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { exePath } from '../../src/core/exe.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, findProcesses, identify, killAllOwned, killOwned, stillOurs, type Owned } from '../kill.ts'
import { SuiteDaemon } from './daemon-driver.ts'

const isWin = process.platform === 'win32'
const root = resolve(import.meta.dirname, '..', '..')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const home = mkdtempSync(join(tmpdir(), 'tether-killall-'))
const pipe = `\\\\.\\pipe\\tether-killall-${process.pid}`
const work = join(home, 'work')
const stub = join(home, 'soul-stub.mjs')
const sentinelScript = join(home, 'sentinel.mjs')

const suite = new SuiteDaemon(home, pipe)
let sentinel: ChildProcess | undefined
let sentinelOwned: Owned | undefined
let daemonOwned: Owned | undefined
let soulOwned: Owned | undefined
let shellOwned: Owned | undefined
let shellId = ''
let soulId = ''
const output = new Map<string, string>()
const states = new Map<string, SlotState>()

async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}\n--- tetherd.log ---\n${suite.log()}`)
    await sleep(100)
  }
}

before(async () => {
  mkdirSync(work, { recursive: true })
  // The stub "soul": prints a banner, reports a session like the real client does (SOUL_SESSION_REPORT), stays up.
  writeFileSync(stub, [
    "import { appendFileSync } from 'node:fs'",
    "process.stdout.write('soul-stub up as ' + process.execPath + '\\n')",
    "const report = process.env.SOUL_SESSION_REPORT",
    "if (report) appendFileSync(report, JSON.stringify({ v: 1, ts: new Date().toISOString(), slotId: process.env.TETHER_SLOT_ID, agent: 'soul', kind: 'start', source: 'startup', sessionId: 'stub-' + process.pid, cwd: process.cwd(), resume: { cwd: process.cwd(), args: ['-r', 'stub-' + process.pid] } }) + '\\n')",
    "setInterval(() => {}, 1000)",
    "if (process.stdin.isTTY) process.stdin.setRawMode(true)", // ConPTY: keystrokes arrive at once, no Enter needed
    "process.stdin.on('data', (d) => process.stdout.write('stub got ' + d))",
  ].join('\n'))
  writeFileSync(sentinelScript, 'setInterval(() => {}, 1000)\n')
  process.env.TETHER_SOUL_CMD = `"${process.execPath}" "${stub}"`
  await suite.connect()
  daemonOwned = suite.owned
  suite.client.on('data', (id, d) => output.set(id, (output.get(id) ?? '') + d))
  suite.client.on('state', (s) => states.set(s.slotId, s))
})

after(async () => {
  delete process.env.TETHER_SOUL_CMD
  if (sentinelOwned) await killOwned(sentinelOwned)
  try { await suite.shutdown() } catch (e) { console.error(String(e)) }
  if (daemonOwned && await stillOurs(daemonOwned)) await killOwned(daemonOwned, { tree: true })
  for (let i = 0; i < 10; i++) { try { rmSync(home, { recursive: true, force: true }); break } catch { await sleep(500) } }
})

test('tetherd runs as tetherd.exe (a copy of the node that would have run it) and serves a shell through node-pty', { skip: !isWin && 'Windows-only' }, async () => {
  assert.equal(basename(suite.client.hello.exec ?? ''), 'tetherd.exe', `hello.exec = ${suite.client.hello.exec}`)
  assert.equal(suite.client.hello.exec, exePath(home, 'tetherd'))
  const daemon = await identify(suite.pid)
  assert.equal(daemon?.name, 'tetherd.exe')
  assert.match(suite.log(), /tetherd: .*(ligado a|copiado de) .*node\.exe/)

  const { slot } = await suite.client.request({ t: 'create', kind: 'shell', cwd: work, args: [] })
  shellId = slot!.slotId
  await suite.client.request({ t: 'attach', slotId: shellId, cols: 100, rows: 30 })
  const started = await suite.client.request({ t: 'start', slotId: shellId })
  assert.ok(started.slot?.pid, 'the shell has a pid: node-pty spawned a ConPTY under tetherd.exe')
  shellOwned = await claim(started.slot!.pid!, { what: 'shell' })
  suite.client.input(shellId, 'echo tether-before-$([int]7*6)\r')
  await waitFor(() => (output.get(shellId) ?? '').includes('tether-before-42'), 20_000, 'the shell to echo')
})

test('a soul slot runs its CLI under tether-soul.exe, made from the node named in TETHER_SOUL_CMD', { skip: !isWin && 'Windows-only' }, async () => {
  const { slot } = await suite.client.request({ t: 'create', kind: 'soul', cwd: work, args: [] })
  soulId = slot!.slotId
  await suite.client.request({ t: 'attach', slotId: soulId, cols: 100, rows: 30 })
  const started = await suite.client.request({ t: 'start', slotId: soulId })
  assert.ok(started.slot?.pid, 'the stub soul has a pid')
  await waitFor(() => (output.get(soulId) ?? '').includes('soul-stub up as'), 20_000, 'the stub to print its banner')
  assert.match(output.get(soulId)!, /soul-stub up as .*\\bin\\tether-soul\.exe/)
  soulOwned = await claim(started.slot!.pid!, { cmdIncludes: stub, what: 'soul stub' })
  assert.equal(soulOwned.name, 'tether-soul.exe')
  assert.ok(existsSync(exePath(home, 'tether-soul')))
  assert.match(suite.log(), /tether-soul: .*(ligado a|copiado de) .*node\.exe/)
  await waitFor(() => states.get(soulId)?.status === 'running', 20_000, 'the soul slot to be running (its start event read)')
  assert.match(readFileSync(join(home, 'slots', `${soulId}.jsonl`), 'utf8'), /"kind":"start"/)
})

test('killall node (every node.exe of this test) kills the sentinel and leaves tetherd.exe, tether-soul.exe and the slots serving', { skip: !isWin && 'Windows-only' }, async () => {
  sentinel = spawn(process.execPath, [sentinelScript], { stdio: 'ignore', windowsHide: true })
  await sleep(300)
  sentinelOwned = await claim(sentinel.pid!, { cmdIncludes: sentinelScript, what: 'sentinel' })
  assert.equal(sentinelOwned.name, 'node.exe')

  // The emulated `killall node`: every node.exe whose command line names this test's home. Nothing else on the
  // machine qualifies (the user's and other agents' node processes do not mention this folder).
  const victims = await findProcesses({ name: 'node.exe', cmdIncludes: home })
  assert.ok(victims.some((v) => v.pid === sentinel!.pid), `the sentinel is among the node.exe of this test: ${JSON.stringify(victims)}`)
  assert.ok(!victims.some((v) => v.pid === suite.pid || v.pid === soulOwned!.pid), 'tetherd and the soul are not node.exe')
  const outcome = await killAllOwned(victims)
  assert.equal(outcome.get(sentinel.pid!), 'killed')
  await sleep(500)
  assert.equal(await identify(sentinel.pid!).then((p) => p?.created === sentinelOwned!.created), false, 'the sentinel (plain node.exe) is dead')
  sentinelOwned = undefined

  // Survivors, by identity.
  assert.ok(await stillOurs(daemonOwned!), 'tetherd.exe is alive')
  assert.ok(await stillOurs(soulOwned!), 'tether-soul.exe is alive')
  assert.ok(await stillOurs(shellOwned!), 'the shell is alive')
  const remaining = await findProcesses({ name: 'node.exe', cmdIncludes: home })
  assert.deepEqual(remaining, [], 'no node.exe of this test survived')
  const survivors = [...await findProcesses({ name: 'tetherd.exe', cmdIncludes: root }), ...await findProcesses({ name: 'tether-soul.exe', cmdIncludes: home })]
  assert.ok(survivors.some((p) => p.pid === suite.pid) && survivors.some((p) => p.pid === soulOwned!.pid), 'both renamed processes listed under their own names')

  // ... and serving: the daemon answers, the shell echoes, the soul stub reacts to input.
  const ls = await suite.client.request({ t: 'list' })
  assert.equal(ls.slots?.find((s) => s.slotId === soulId)?.pid, soulOwned!.pid)
  suite.client.input(shellId, 'echo tether-after-$([int]6*7)\r')
  await waitFor(() => (output.get(shellId) ?? '').includes('tether-after-42'), 20_000, 'the shell to echo after the killall')
  suite.client.input(soulId, 'ping\r')
  await waitFor(() => (output.get(soulId) ?? '').includes('stub got ping'), 20_000, 'the soul stub to answer after the killall')
})
