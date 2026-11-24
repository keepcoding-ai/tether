// `tether sync` in process: temporary homes, a local bare repo as the remote, no daemon, no network.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { UsageError } from '../../src/cli/args.ts'
import { acquireSyncLock, appIsOpen, cmdSync, machineLabel, readSyncConfig, readSyncLast, type SyncIo } from '../../src/cli/sync.ts'
import { writePlaceMap } from '../../src/core/sync/places.ts'

let root: string
let seq = 0
before(() => { root = mkdtempSync(join(tmpdir(), 'tether-cli-sync-')) })
after(() => { rmSync(root, { recursive: true, force: true }) })

interface Box {
  home: string
  user: string
  env: NodeJS.ProcessEnv
  out: string
  err: string
  io: SyncIo & { out: (t: string) => void }
}

function box(over: Partial<SyncIo> = {}): Box {
  const base = join(root, `m${++seq}`)
  const home = join(base, 'home')
  const user = join(base, 'user')
  mkdirSync(home, { recursive: true })
  mkdirSync(user, { recursive: true })
  const env = { TETHER_HOME: home, TETHER_USER_DIR: user } as NodeJS.ProcessEnv
  const b = { home, user, env, out: '', err: '' } as Box
  b.io = {
    env, home, homedir: user,
    out: (t: string) => { b.out += t },
    err: (t: string) => { b.err += t },
    connect: async () => undefined,
    appRunning: () => false,
    ...over,
  }
  return b
}

async function run(b: Box, ...argv: string[]): Promise<number> {
  b.out = ''
  b.err = ''
  return await cmdSync(argv, b.io)
}

function bareRemote(): string {
  const dir = join(root, `remote${++seq}.git`)
  execFileSync('git', ['init', '--bare', '-b', 'main', dir], { stdio: 'ignore' })
  return dir
}

const remoteCommits = (remote: string): number => Number(execFileSync('git', ['-C', remote, 'rev-list', '--count', 'main']).toString().trim())

const terminal = (slot: string, cwd: string): Record<string, unknown> => ({ id: slot, contentComponent: 'terminal', params: { slotId: slot, hint: { kind: 'claude', cwd } }, title: slot })
function desk(id: string, name: string, panels: Record<string, unknown>): Record<string, unknown> {
  return {
    id, name,
    frames: {
      grid: { root: { type: 'leaf', data: { id: 'f1' } } },
      views: { f1: { grid: { root: { type: 'leaf', data: { views: Object.keys(panels) } } }, panels } },
    },
  }
}

/** A machine that has run the app once: an empty arrangement on disk. */
function seedEmptyLayout(m: Box): void {
  writeFileSync(join(m.home, 'layout.json'), JSON.stringify({ v: 4, desks: [], activeDesk: '' }))
}

/** Machine A: one desk with a terminal, its slot, a profile and a theme. */
function seedA(a: Box, proj: string): void {
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(a.home, 'layout.json'), JSON.stringify({ v: 4, desks: [desk('desk-1', 'Mesa A', { s1: terminal('s1', proj) })], activeDesk: 'desk-1' }))
  mkdirSync(join(a.home, 'slots'), { recursive: true })
  writeFileSync(join(a.home, 'slots', 's1.json'), JSON.stringify({ v: 1, slotId: 's1', agent: 'claude', cwd: proj, args: [], createdAt: '2026-11-23T10:00:00.000Z', name: 'Alfa' }))
  writeFileSync(join(a.home, 'profiles.json'), JSON.stringify({ v: 1, profiles: [{ id: 'main', name: 'Principal', agent: 'claude', args: [], env: { API_KEY: 'v4lue-never-synced' } }] }))
  writeFileSync(join(a.user, 'settings.json'), JSON.stringify({ theme: 'dark' }))
}

describe('cli: tether sync', () => {
  test('machineLabel is short, lower case and safe', () => {
    assert.equal(machineLabel('DESKTOP-ABC.local'), 'desktop-abc-local')
    assert.equal(machineLabel('***'), 'maquina')
  })

  test('usage errors', async () => {
    const b = box()
    await assert.rejects(run(b), UsageError)
    await assert.rejects(run(b, 'connect'), UsageError)
    await assert.rejects(run(b, 'voa'), /subcomando desconhecido/)
    await assert.rejects(run(b, 'status', '--machine', 'x'), /--machine só vale com connect/)
    await assert.rejects(run(b, 'status', '--from-app'), /--from-app só vale com now/)
  })

  test('now and status before connecting say what to do', async () => {
    const b = box()
    assert.equal(await run(b, 'now'), 1)
    assert.match(b.err, /tether sync connect <url>/)
    assert.equal(await run(b, 'status'), 0)
    assert.match(b.out, /não está configurada/)
    assert.equal(await run(b, 'disconnect'), 0)
  })

  test('connect to an empty remote sends the profile; sync.json and sync-last.json have their shape', async () => {
    const remote = bareRemote()
    const a = box()
    seedA(a, join(a.user, 'proj'))
    assert.equal(await run(a, 'connect', remote, '--machine', 'Maq A'), 0, a.err)
    assert.match(a.out, /o seu perfil foi enviado/)
    assert.match(a.out, /Enviado: \d+ itens/)
    assert.ok(remoteCommits(remote) >= 1)
    assert.deepEqual(readSyncConfig(a.home), { provider: 'git', url: remote, machine: 'maq-a' })
    assert.deepEqual(JSON.parse(readFileSync(join(a.home, 'sync.json'), 'utf8')), { provider: 'git', url: remote, machine: 'maq-a' })
    const last = readSyncLast(a.home)!
    assert.equal(last.ok, true)
    assert.equal(last.report?.pushed, true)
    assert.equal(last.report?.connect?.remoteEmpty, true)
    assert.ok(!Number.isNaN(Date.parse(last.at)))
    assert.ok(existsSync(join(a.user, 'sync', '.git')))
    assert.ok(!existsSync(join(a.home, 'sync.lock')), 'the lock is released')
  })

  test('a second machine connects and gets the desk, the profile and the slot in its working files', async () => {
    const remote = bareRemote()
    const a = box()
    seedA(a, join(a.home, 'outside', 'proj')) // outside the home dir: it travels under a place name
    assert.equal(await run(a, 'connect', remote), 0, a.err)

    const b = box()
    seedEmptyLayout(b)
    const projB = join(b.home, 'elsewhere', 'proj')
    mkdirSync(projB, { recursive: true })
    writePlaceMap(b.home, { proj: projB })
    assert.equal(await run(b, 'connect', remote), 0, b.err)
    assert.match(b.out, /Chegou: .*perfis/)
    const layout = JSON.parse(readFileSync(join(b.home, 'layout.json'), 'utf8')) as { desks: { name: string }[] }
    assert.deepEqual(layout.desks.map((d) => d.name), ['Mesa A'])
    const profiles = JSON.parse(readFileSync(join(b.home, 'profiles.json'), 'utf8')) as { profiles: { id: string }[] }
    assert.ok(profiles.profiles.some((p) => p.id === 'main'))
    assert.deepEqual(JSON.parse(readFileSync(join(b.user, 'settings.json'), 'utf8')), { theme: 'dark' })
    const slotFiles = JSON.parse(readFileSync(join(b.home, 'slots', 's1.json'), 'utf8')) as { cwd: string; name: string }
    assert.equal(slotFiles.cwd, projB)
    assert.equal(slotFiles.name, 'Alfa')
    assert.match(b.out, /variáveis de ambiente: API_KEY/)
    assert.match(b.out, /perfil "Principal"/)
    assert.ok(!readFileSync(join(a.user, 'sync', 'profiles', 'main.json'), 'utf8').includes('v4lue-never-synced'), 'env values never travel')
  })

  test('a slot whose place has no folder here is reported as waiting', async () => {
    const remote = bareRemote()
    const a = box()
    seedA(a, join(a.home, 'outside', 'proj'))
    await run(a, 'connect', remote)
    const b = box()
    seedEmptyLayout(b)
    assert.equal(await run(b, 'connect', remote), 0, b.err)
    assert.match(b.out, /Aguardam uma pasta nesta máquina: s1 \(proj\)/)
    assert.match(b.out, /Lugares sem pasta nesta máquina: proj/)
  })

  test('a machine that never ran the app is told why the desks did not come', async () => {
    const remote = bareRemote()
    const a = box()
    seedA(a, join(a.user, 'proj'))
    await run(a, 'connect', remote)
    const b = box()
    assert.equal(await run(b, 'connect', remote), 0, b.err)
    assert.match(b.out, /As mesas não foram sincronizadas: esta máquina ainda não tem um arranjo salvo/)
    assert.ok(!existsSync(join(b.home, 'layout.json')))
  })

  test('now with nothing new is idempotent and sends nothing', async () => {
    const remote = bareRemote()
    const a = box()
    seedA(a, join(a.user, 'proj'))
    await run(a, 'connect', remote)
    const commits = remoteCommits(remote)
    assert.equal(await run(a, 'now'), 0, a.err)
    assert.match(a.out, /Nada novo chegou\./)
    assert.match(a.out, /Nada a enviar\./)
    assert.equal(remoteCommits(remote), commits)
    assert.equal(await run(a, 'now'), 0)
    assert.equal(remoteCommits(remote), commits)
  })

  test('a change on one machine reaches the other with now', async () => {
    const remote = bareRemote()
    const a = box()
    seedA(a, join(a.user, 'proj'))
    await run(a, 'connect', remote)
    const b = box()
    await run(b, 'connect', remote)
    writeFileSync(join(a.user, 'settings.json'), JSON.stringify({ theme: 'light' }))
    assert.equal(await run(a, 'now'), 0, a.err)
    assert.match(a.out, /Enviado: 1 item/)
    assert.equal(await run(b, 'now'), 0, b.err)
    assert.match(b.out, /Chegou: preferências/)
    assert.deepEqual(JSON.parse(readFileSync(join(b.user, 'settings.json'), 'utf8')), { theme: 'light' })
  })

  test('settings.json keeps its comments when a sync changes a value', async () => {
    const remote = bareRemote()
    const a = box()
    seedA(a, join(a.user, 'proj'))
    await run(a, 'connect', remote)
    const b = box()
    const mine = '// my notes\n{\n  // the theme\n  "theme": "light",\n  "mine.only": 1 // stays\n}\n'
    writeFileSync(join(b.user, 'settings.json'), mine)
    assert.equal(await run(b, 'connect', remote), 0, b.err)
    const text = readFileSync(join(b.user, 'settings.json'), 'utf8')
    assert.match(text, /\/\/ my notes/)
    assert.match(text, /\/\/ the theme/)
    assert.match(text, /\/\/ stays/)
    assert.match(text, /"theme": "dark"/)
  })

  test('status shows the masked URL, the machine, the pending files and the last sync; --json too', async () => {
    const remote = bareRemote()
    const a = box()
    seedA(a, join(a.user, 'proj'))
    await run(a, 'connect', remote, '--machine', 'casa')
    assert.equal(await run(a, 'status'), 0, a.err)
    assert.match(a.out, /Sincronização: conectada/)
    assert.match(a.out, /Máquina: casa/)
    assert.match(a.out, /Pendências locais: 0 arquivos/)
    assert.match(a.out, /À frente do remoto: 0 · atrás: 0/)
    assert.match(a.out, /Última sincronização: .* — deu certo/)
    writeFileSync(join(a.user, 'sync', 'stray.txt'), 'x')
    await run(a, 'status')
    assert.match(a.out, /Pendências locais: 1 arquivo\b/)
    assert.equal(await run(a, 'status', '--json'), 0)
    const doc = JSON.parse(a.out) as { connected: boolean; machine: string; dirty: number; last: { ok: boolean } }
    assert.equal(doc.connected, true)
    assert.equal(doc.machine, 'casa')
    assert.equal(doc.dirty, 1)
    assert.equal(doc.last.ok, true)
  })

  test('a credential in the URL is never printed', async () => {
    const b = box()
    const url = 'https://someone:topsecret@localhost:1/none.git'
    assert.equal(await run(b, 'connect', url), 1)
    assert.ok(!b.out.includes('topsecret') && !b.err.includes('topsecret'))
    await run(b, 'status')
    assert.ok(!b.out.includes('topsecret'))
    assert.match(b.out, /https:\/\/\*\*\*@localhost:1\/none\.git/)
    await run(b, 'status', '--json')
    assert.ok(!b.out.includes('topsecret'))
    await run(b, 'connect', 'https://other:topsecret@localhost:1/x.git')
    assert.ok(!b.err.includes('topsecret'))
    assert.match(b.err, /já está conectada a https:\/\/\*\*\*@localhost:1\/none\.git/)
  })

  test('an unreachable remote exits 1 with a one-line message and still writes sync-last.json', async () => {
    const b = box()
    seedA(b, join(b.user, 'proj'))
    assert.equal(await run(b, 'connect', join(root, 'does-not-exist.git')), 1)
    assert.match(b.err, /^tether: a sincronização falhou: não consegui falar com o remoto/)
    assert.equal(b.err.trim().split('\n').length, 1)
    const last = readSyncLast(b.home)!
    assert.equal(last.ok, false)
    assert.equal(last.error?.code, 'network')
    assert.equal(last.report, null)
    assert.ok(!existsSync(join(b.home, 'sync.lock')))
  })

  test('--json prints the whole record (success and failure)', async () => {
    const remote = bareRemote()
    const a = box()
    seedA(a, join(a.user, 'proj'))
    assert.equal(await run(a, 'connect', remote, '--json'), 0)
    const ok = JSON.parse(a.out) as { ok: boolean; at: string; report: { pushed: boolean } }
    assert.equal(ok.ok, true)
    assert.equal(ok.report.pushed, true)
    assert.equal(await run(a, 'now', '--json'), 0)
    assert.equal((JSON.parse(a.out) as { report: { pushed: boolean } }).report.pushed, false)

    const bad = box()
    assert.equal(await run(bad, 'connect', join(root, 'nope.git'), '--json'), 1)
    const doc = JSON.parse(bad.out) as { ok: boolean; error: { code: string } }
    assert.equal(doc.ok, false)
    assert.equal(doc.error.code, 'network')
  })

  test('disconnect unlinks, removes sync.json and keeps the files', async () => {
    const remote = bareRemote()
    const a = box()
    seedA(a, join(a.user, 'proj'))
    await run(a, 'connect', remote)
    assert.equal(await run(a, 'disconnect'), 0)
    assert.match(a.out, /Desconectado/)
    assert.equal(readSyncConfig(a.home), undefined)
    assert.ok(!existsSync(join(a.home, 'sync.json')))
    assert.ok(existsSync(join(a.user, 'sync', 'profiles', 'main.json')))
    assert.ok(existsSync(join(a.home, 'profiles.json')))
    assert.equal(execFileSync('git', ['-C', join(a.user, 'sync'), 'remote']).toString().trim(), '')
    assert.equal(await run(a, 'now'), 1)
  })

  test('one run at a time: a live lock refuses, a dead one is taken over', async () => {
    const remote = bareRemote()
    const a = box()
    seedA(a, join(a.user, 'proj'))
    await run(a, 'connect', remote)
    writeFileSync(join(a.home, 'sync.lock'), String(process.pid))
    assert.equal(await run(a, 'now'), 1)
    assert.match(a.err, /outra sincronização está em andamento/)
    assert.equal(readFileSync(join(a.home, 'sync.lock'), 'utf8'), String(process.pid), 'the live lock is left alone')
    assert.throws(() => acquireSyncLock(a.home), /em andamento/)

    const dead = spawnSync(process.execPath, ['-e', ''])
    writeFileSync(join(a.home, 'sync.lock'), String(dead.pid))
    assert.equal(await run(a, 'now'), 0, a.err)
    assert.ok(!existsSync(join(a.home, 'sync.lock')))
    const release = acquireSyncLock(a.home)
    assert.equal(readFileSync(join(a.home, 'sync.lock'), 'utf8'), String(process.pid))
    release()
    assert.ok(!existsSync(join(a.home, 'sync.lock')))
  })

  describe('with the app open', () => {
    test('now hands the work to the app through tether://sync/now and prints its report', async () => {
      const remote = bareRemote()
      const a = box()
      seedA(a, join(a.user, 'proj'))
      await run(a, 'connect', remote)
      const links: string[] = []
      const before = readFileSync(join(a.home, 'sync-last.json'), 'utf8')
      a.io.appRunning = () => true
      a.io.pollMs = 1
      a.io.openLink = async (url) => {
        links.push(url)
        const report = { ...(readSyncLast(a.home)!.report!), pushed: true, written: ['settings/settings'] }
        writeFileSync(join(a.home, 'sync-last.json'), JSON.stringify({ at: new Date().toISOString(), ok: true, report }))
      }
      const commits = remoteCommits(remote)
      assert.equal(await run(a, 'now'), 0, a.err)
      assert.deepEqual(links, ['tether://sync/now'])
      assert.match(a.out, /Enviado: 1 item\b/)
      assert.notEqual(readFileSync(join(a.home, 'sync-last.json'), 'utf8'), before)
      assert.equal(remoteCommits(remote), commits, 'this process did not run the engine')
    })

    test('connect writes sync.json first, then delegates; an app failure is exit 1', async () => {
      const a = box()
      a.io.appRunning = () => true
      a.io.pollMs = 1
      a.io.openLink = async () => {
        assert.deepEqual(readSyncConfig(a.home)?.url, 'x://remote')
        writeFileSync(join(a.home, 'sync-last.json'), JSON.stringify({ at: new Date().toISOString(), ok: false, error: { code: 'network', message: 'sem rede' }, report: null }))
      }
      assert.equal(await run(a, 'connect', 'x://remote'), 1)
      assert.match(a.err, /sem rede/)
      assert.ok(!existsSync(join(a.user, 'sync', '.git')), 'no engine here')
    })

    test('a report older than the command does not count; the wait ends in a clear error', async () => {
      const a = box()
      writeFileSync(join(a.home, 'sync.json'), JSON.stringify({ provider: 'git', url: 'x://remote', machine: 'm' }))
      writeFileSync(join(a.home, 'sync-last.json'), JSON.stringify({ at: new Date(Date.now() - 60_000).toISOString(), ok: true, report: null }))
      let t = Date.now()
      a.io.appRunning = () => true
      a.io.openLink = async () => {}
      a.io.now = () => t
      a.io.sleep = async (ms) => { t += ms }
      a.io.delegateWaitMs = 5000
      assert.equal(await run(a, 'now'), 1)
      assert.match(a.err, /o app está aberto mas não respondeu em 5 s/)
    })

    test('a link the OS could not deliver is an error', async () => {
      const a = box()
      writeFileSync(join(a.home, 'sync.json'), JSON.stringify({ provider: 'git', url: 'x://remote', machine: 'm' }))
      a.io.appRunning = () => true
      a.io.openLink = async () => { throw new Error('sem handler') }
      assert.equal(await run(a, 'now'), 1)
      assert.match(a.err, /não consegui pedir ao app para sincronizar: sem handler/)
    })

    test('--from-app runs the engine here even though the app is open', async () => {
      const remote = bareRemote()
      const a = box()
      seedA(a, join(a.user, 'proj'))
      a.io.appRunning = () => true
      a.io.openLink = async () => { throw new Error('must not be called') }
      writeFileSync(join(a.home, 'sync.json'), JSON.stringify({ provider: 'git', url: remote, machine: 'm' }))
      assert.equal(await run(a, 'now', '--from-app', '--json'), 0, a.err)
      assert.equal((JSON.parse(a.out) as { report: { pushed: boolean } }).report.pushed, true)
    })
  })

  describe('is the app open?', () => {
    test('no electron folder: closed', () => {
      const b = box()
      assert.equal(appIsOpen(b.home), false)
      assert.equal(appIsOpen(b.home, 'linux'), false)
    })

    test('unix: SingletonLock names a pid', (t) => {
      const b = box()
      mkdirSync(join(b.home, 'electron'), { recursive: true })
      try { symlinkSync(`host-${process.pid}`, join(b.home, 'electron', 'SingletonLock')) } catch { t.skip('no symlinks here'); return }
      assert.equal(appIsOpen(b.home, 'linux'), true)
      rmSync(join(b.home, 'electron', 'SingletonLock'))
      const dead = spawnSync(process.execPath, ['-e', ''])
      symlinkSync(`host-${dead.pid}`, join(b.home, 'electron', 'SingletonLock'))
      assert.equal(appIsOpen(b.home, 'linux'), false)
    })

    test('windows: a lockfile nobody holds is a closed app', { skip: process.platform !== 'win32' }, () => {
      const b = box()
      mkdirSync(join(b.home, 'electron'), { recursive: true })
      writeFileSync(join(b.home, 'electron', 'lockfile'), '')
      assert.equal(appIsOpen(b.home), false)
    })
  })
})
