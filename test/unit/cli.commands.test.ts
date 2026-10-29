// The CLI against a real tetherd (spawned detached on a temp home + unique pipe), shell slots only: ls/--json,
// new, show, open, stop, rename, rm, slot resolution, and the store fallback when nothing answers on the pipe.
// Each command runs `bin/tether.mjs` as the user would, so stdout/stderr/exit code are the real ones.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { defaultShell } from '../../src/agents/shell.ts'
import { createSlot, readSlot } from '../../src/core/store.ts'
import { DaemonClient } from '../../src/daemon/client.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { claim, killOwned } from '../kill.ts'
import { pidAlive, removeHome, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const BIN = resolve(import.meta.dirname, '../../bin/tether.mjs')
const DAEMON_MAIN = resolve(import.meta.dirname, '../../src/daemon/main.ts')

interface Run { status: number | null; stdout: string; stderr: string }

function tether(env: Record<string, string>, ...args: string[]): Run {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

function slotsOf(r: Run): SlotState[] {
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout) as SlotState[]
}

describe('tether CLI', () => {
  let home: string
  let pipe: string
  let cwd: string
  let env: Record<string, string>
  let daemonPid = 0
  let slotId = ''

  before(() => {
    home = tempHome()
    pipe = uniquePipe(home)
    cwd = join(home, 'work')
    mkdirSync(cwd)
    env = { TETHER_HOME: home, TETHER_PIPE: pipe }
  })
  after(async () => {
    if (daemonPid && pidAlive(daemonPid)) {
      try {
        const c = await DaemonClient.connect({ home, pipe, client: 'test', spawn: false })
        await c.request({ t: 'shutdown' })
        await waitUntil(() => !pidAlive(daemonPid), 15_000, 'daemon gone')
      } catch {
        await killOwned(await claim(daemonPid, { cmdIncludes: DAEMON_MAIN, what: 'tetherd' }), { tree: true })
      }
    }
    await removeHome(home)
  })

  test('help: no args prints the usage (exit 0); unknown command is a usage error (exit 2)', () => {
    const h = tether(env)
    assert.equal(h.status, 0)
    assert.match(h.stdout, /uso: tether <comando>/)
    const bad = tether(env, 'banana')
    assert.equal(bad.status, 2)
    assert.match(bad.stderr, /comando desconhecido: banana/)
  })

  test('without a daemon: ls says tetherd parado and reads the store; --json is the raw state', () => {
    const createdAt = new Date().toISOString()
    createSlot(home, { v: 1, slotId: 'aa000001', name: 'frio', agent: 'shell', cwd, args: [], createdAt })
    createSlot(home, { v: 1, slotId: 'aa000002', name: 'gelado', agent: 'shell', cwd, args: [], createdAt })
    const r = tether(env, 'ls')
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /tetherd parado/)
    assert.match(r.stdout, /SLOT\s+NOME\s+AGENTE/)
    assert.match(r.stdout, /aa000001\s+frio\s+shell/)
    const j = tether(env, 'ls', '--json')
    assert.doesNotMatch(j.stdout, /tetherd parado/)
    const slots = slotsOf(j)
    assert.deepEqual(slots.map((s) => [s.slotId, s.kind, s.status]), [['aa000001', 'shell', 'exited'], ['aa000002', 'shell', 'exited']])
  })

  test('new shell --here runs the shell in this terminal: exit code propagated, slot recorded', () => {
    const shell = defaultShell()
    const r = tether(env, 'new', 'shell', '--name', 'aqui', '--cwd', cwd, '--here', '--', shell.command, '-NoProfile', '-Command', 'exit 3')
    assert.equal(r.status, 3, r.stderr)
    assert.match(r.stderr, /criado; shell neste terminal/)
    const slots = slotsOf(tether(env, 'ls', '--json'))
    const mine = slots.find((s) => s.name === 'aqui')
    assert.ok(mine, 'slot recorded in the store')
    assert.equal(mine.status, 'exited')
    assert.equal(readSlot(home, mine.slotId)?.args[0], shell.command)
    assert.ok(!existsSync(join(home, 'slots', `${mine.slotId}.run.json`)), 'run file cleared after exit')
    // open --here re-runs the slot's own shell command (exit 3 again).
    const again = tether(env, 'open', 'aqui', '--here')
    assert.equal(again.status, 3, again.stderr)
    assert.equal(tether(env, 'rm', 'aqui', '--yes').status, 0)
  })

  test('with a daemon: new shell creates and starts the slot; ls shows it ativo', async () => {
    const c = await DaemonClient.connect({ home, pipe, client: 'test' })
    daemonPid = c.hello.pid
    c.close()
    const r = tether(env, 'new', 'shell', '--name', 'quente', '--cwd', cwd)
    assert.equal(r.status, 0, r.stderr)
    const m = /slot ([0-9a-f]{8}) "quente" criado \(shell, ativo\)/.exec(r.stdout)
    assert.ok(m, r.stdout)
    slotId = m[1]!
    assert.match(r.stdout, new RegExp(`tether attach ${slotId}`))
    const ls = tether(env, 'ls')
    assert.doesNotMatch(ls.stderr, /tetherd parado/)
    assert.match(ls.stdout, new RegExp(`${slotId}\\s+quente\\s+shell\\s+.*\\s+ativo`))
    const slots = slotsOf(tether(env, 'ls', '--json'))
    const mine = slots.find((s) => s.slotId === slotId)!
    assert.equal(mine.status, 'running')
    assert.ok(mine.pid && pidAlive(mine.pid))
  })

  test('show: meta, estado and the (empty) event list of a shell slot', () => {
    const r = tether(env, 'show', 'quente')
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, new RegExp(`slot\\s+${slotId}`))
    assert.match(r.stdout, /nome\s+quente/)
    assert.match(r.stdout, /estado\s+ativo \(pid \d+\)/)
    assert.match(r.stdout, /eventos \(0\):/)
  })

  test('slot resolution: unique prefix and name work; ambiguous or unknown refs fail with exit 1', () => {
    assert.equal(tether(env, 'show', slotId.slice(0, 4)).status, 0)
    const unknown = tether(env, 'show', 'zzzz')
    assert.equal(unknown.status, 1)
    assert.match(unknown.stderr, /slot não encontrado: zzzz/)
    const ambiguous = tether(env, 'show', 'aa0000')
    assert.equal(ambiguous.status, 1)
    assert.match(ambiguous.stderr, /prefixo ambíguo "aa0000": aa000001, aa000002/)
  })

  test('stop then open: the shell exits and comes back with a new pid', async () => {
    const before = slotsOf(tether(env, 'ls', '--json')).find((s) => s.slotId === slotId)!
    const st = tether(env, 'stop', slotId)
    assert.equal(st.status, 0, st.stderr)
    assert.match(st.stdout, new RegExp(`slot ${slotId} parado`))
    await waitUntil(() => !pidAlive(before.pid!), 10_000, 'shell gone')
    const op = tether(env, 'open', slotId)
    assert.equal(op.status, 0, op.stderr)
    assert.match(op.stdout, new RegExp(`slot ${slotId} ativo \\(pid \\d+\\)`))
    const after = slotsOf(tether(env, 'ls', '--json')).find((s) => s.slotId === slotId)!
    assert.equal(after.status, 'running')
    assert.notEqual(after.pid, before.pid)
  })

  test('open --here refuses a slot the daemon is already running', () => {
    const r = tether(env, 'open', slotId, '--here')
    assert.equal(r.status, 1)
    assert.match(r.stderr, /já está ativo/)
  })

  test('rename: the name changes on disk and in ls', () => {
    const r = tether(env, 'rename', 'quente', 'morno')
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readSlot(home, slotId)?.name, 'morno')
    assert.match(tether(env, 'ls').stdout, new RegExp(`${slotId}\\s+morno`))
  })

  test('rm: needs --yes without a terminal (exit 2); with it the slot is forgotten and its shell killed', async () => {
    const pid = slotsOf(tether(env, 'ls', '--json')).find((s) => s.slotId === slotId)!.pid!
    const ask = tether(env, 'rm', 'morno')
    assert.equal(ask.status, 2)
    assert.match(ask.stderr, /use --yes/)
    const r = tether(env, 'rm', 'morno', '--yes')
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /esquecido/)
    await waitUntil(() => !pidAlive(pid), 10_000, 'shell gone')
    assert.equal(readSlot(home, slotId), undefined)
    assert.ok(!slotsOf(tether(env, 'ls', '--json')).some((s) => s.slotId === slotId))
  })

  test('slots created straight in the store were adopted by the daemon: rm by name forgets them', () => {
    for (const [id, name] of [['aa000001', 'frio'], ['aa000002', 'gelado']] as const) {
      const r = tether(env, 'rm', name, '--yes')
      assert.equal(r.status, 0, r.stderr)
      assert.equal(readSlot(home, id), undefined)
    }
  })
})
