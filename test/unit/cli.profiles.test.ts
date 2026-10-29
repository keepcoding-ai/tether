// The CLI and the launch profiles, without a daemon (the file) and with one (the protocol): `tether profiles`,
// `profile add|edit|rm`, `new --profile` (the profile names the agent), `show` with the profile line.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { profilesPath, type Profile } from '../../src/core/profile.ts'
import { readSlot } from '../../src/core/store.ts'
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

function profilesOf(r: Run): Profile[] {
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout) as Profile[]
}

describe('tether profiles (CLI)', () => {
  let home: string
  let pipe: string
  let cwd: string
  let env: Record<string, string>
  let daemonPid = 0

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

  test('without a daemon: profiles lists the defaults (created on first read); --json is the raw list', () => {
    const r = tether(env, 'profiles')
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /claude-dev\s+Claude modo dev\s+claude\s+-\s+--dangerously-skip-permissions/)
    assert.match(r.stdout, /^soul\s+soul\s+soul\s+sim\s+-g/m)
    const list = profilesOf(tether(env, 'profiles', '--json'))
    assert.ok(list.some((p) => p.id === 'claude' && p.default))
  })

  test('profile add: validation refuses --resume with the reason (exit 1); a good one lands in the file with env and default', () => {
    const bad = tether(env, 'profile', 'add', 'claude', 'Ruim', '--', '--resume')
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /o argumento --resume não pode ficar no perfil/)
    const ok = tether(env, 'profile', 'add', 'claude', 'Conta 2', '--default', '--env', 'CLAUDE_CONFIG_DIR=D:\\c2', '--env', 'CLAUDECODE=1', '--', '--model', 'haiku')
    assert.equal(ok.status, 0, ok.stderr)
    assert.match(ok.stdout, /perfil "Conta 2" \(conta-2, claude, padrão\) criado: claude --model haiku/)
    assert.match(ok.stderr, /atenção: a variável CLAUDECODE/)
    const file = JSON.parse(readFileSync(profilesPath(home), 'utf8')) as { profiles: Profile[] }
    const mine = file.profiles.find((p) => p.id === 'conta-2')!
    assert.deepEqual(mine.env, { CLAUDE_CONFIG_DIR: 'D:\\c2', CLAUDECODE: '1' })
    assert.deepEqual(file.profiles.filter((p) => p.agent === 'claude' && p.default).map((p) => p.id), ['conta-2'])
    const dup = tether(env, 'profile', 'add', 'claude', 'conta 2')
    assert.equal(dup.status, 1)
    assert.match(dup.stderr, /já existe um perfil chamado "Conta 2"/)
  })

  test('profile edit: rename, replace args, drop env, give the default back; profile rm needs --yes without a terminal', () => {
    const r = tether(env, 'profile', 'edit', 'Conta 2', '--name', 'Conta dois', '--no-env', '--no-default', '--', '--model', 'opus')
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /perfil "Conta dois" \(conta-2, claude\) alterado: claude --model opus/)
    const edited = profilesOf(tether(env, 'profiles', '--json')).find((p) => p.id === 'conta-2')!
    assert.equal(edited.env, undefined)
    assert.equal(edited.default, undefined)
    assert.equal(tether(env, 'profile', 'edit', 'claude', '--default').status, 0)
    const rm = tether(env, 'profile', 'rm', 'conta-2')
    assert.equal(rm.status, 2)
    assert.match(rm.stderr, /use --yes/)
    assert.equal(tether(env, 'profile', 'rm', 'Conta dois', '--yes').status, 0)
    assert.ok(!profilesOf(tether(env, 'profiles', '--json')).some((p) => p.id === 'conta-2'))
    assert.equal(tether(env, 'profile', 'rm', 'nada', '--yes').status, 1)
  })

  test('new --profile --here: the profile names the agent, its shell runs, the slot keeps the snapshot; show prints the profile', () => {
    const add = tether(env, 'profile', 'add', 'shell', 'Node aqui', '--shell', `"${process.execPath}" --no-warnings`, '--env', 'PROFILE_TEST_VAR=sim', '--', '-e', 'process.exit(process.env.PROFILE_TEST_VAR === "sim" ? 7 : 1)')
    assert.equal(add.status, 0, add.stderr)
    const r = tether(env, 'new', '--profile', 'Node aqui', '--name', 'perfilado', '--cwd', cwd, '--here')
    assert.equal(r.status, 7, r.stderr)
    assert.match(r.stderr, /criado; shell \(perfil "Node aqui"\) neste terminal/)
    const slots = JSON.parse(tether(env, 'ls', '--json').stdout) as SlotState[]
    const mine = slots.find((s) => s.name === 'perfilado')!
    assert.equal(mine.profileId, 'node-aqui')
    assert.equal(mine.profileName, 'Node aqui')
    const meta = readSlot(home, mine.slotId)!
    assert.equal(meta.profileArgs![0], process.execPath)
    assert.deepEqual(meta.profileEnv, { PROFILE_TEST_VAR: 'sim' })
    const show = tether(env, 'show', 'perfilado')
    assert.match(show.stdout, /perfil\s+Node aqui \(node-aqui\)/)
    const mismatch = tether(env, 'new', 'claude', '--profile', 'Node aqui', '--cwd', cwd, '--here')
    assert.equal(mismatch.status, 2)
    assert.match(mismatch.stderr, /é de shell, não de claude/)
    const unknown = tether(env, 'new', '--profile', 'inexistente', '--cwd', cwd, '--here')
    assert.equal(unknown.status, 1)
    assert.match(unknown.stderr, /perfil não encontrado: inexistente/)
    // the profile deleted: open --here still runs from the snapshot (exit 7 again), ls says so
    assert.equal(tether(env, 'profile', 'rm', 'node-aqui', '--yes').status, 0)
    const again = tether(env, 'open', 'perfilado', '--here')
    assert.equal(again.status, 7, again.stderr)
    assert.match(tether(env, 'ls').stdout, /node-aqui \(apagado\)/)
    assert.equal(tether(env, 'rm', 'perfilado', '--yes').status, 0)
  })

  test('with a daemon: profile add/rm go through it; new --profile creates the slot with the profile and ls shows "!" for unsafe', async () => {
    const c = await DaemonClient.connect({ home, pipe, client: 'test' })
    daemonPid = c.hello.pid
    const add = tether(env, 'profile', 'add', 'claude', 'Haiku dev', '--', '--dangerously-skip-permissions', '--model', 'haiku')
    assert.equal(add.status, 0, add.stderr)
    const viaDaemon = (await c.request({ t: 'profiles-list' })).profiles!
    assert.ok(viaDaemon.some((p) => p.id === 'haiku-dev'), 'the daemon sees the profile the CLI saved through it')
    const bad = tether(env, 'profile', 'add', 'soul', 'Ruim', '--', '-c')
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /o argumento -c não pode ficar no perfil/)
    // a shell slot with the default PowerShell profile (the agent comes from the profile)
    const r = tether(env, 'new', '--profile', 'PowerShell', '--name', 'ps', '--cwd', cwd)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /criado \(shell, perfil "PowerShell", ativo\)/)
    const slots = (await c.request({ t: 'list' })).slots!
    const ps = slots.find((s) => s.name === 'ps')!
    assert.equal(ps.profileId, 'powershell')
    assert.equal(ps.status, 'running')
    // a claude slot with an unsafe profile, not started (create only): ls marks it
    const { slot } = await c.request({ t: 'create', kind: 'claude', cwd, name: 'dev', profileId: 'haiku-dev' })
    assert.equal(slot!.unsafe, true)
    assert.match(tether(env, 'ls').stdout, /dev\s+claude\s+Haiku dev !/)
    assert.match(tether(env, 'show', 'dev').stdout, /atenção\s+roda sem confirmação de permissões/)
    assert.equal(tether(env, 'profile', 'rm', 'haiku-dev', '--yes').status, 0)
    assert.ok(!(await c.request({ t: 'profiles-list' })).profiles!.some((p) => p.id === 'haiku-dev'))
    await c.request({ t: 'forget', slotId: ps.slotId })
    await c.request({ t: 'forget', slotId: slot!.slotId })
    c.close()
  })
})
