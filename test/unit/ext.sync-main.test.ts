// The sync extension's main side (extensions/sync/main.ts createSyncMain) over a fake runner, and its doctor line
// (extensions/sync/daemon.ts syncCheck) over a fake disk: the view main sends, the three acts, the tray notice raised and
// resolved, and the four doctor cases.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { SyncResult, SyncState } from '../../app/main/sync-runner.ts'
import { createSyncMain, type RunnerLike } from '../../extensions/sync/main.ts'
import { gitOnPath, syncCheck } from '../../extensions/sync/daemon.ts'
import type { SyncView } from '../../extensions/sync/rules.ts'

const tick = async (n = 10): Promise<void> => { for (let i = 0; i < n; i++) await new Promise<void>(r => setImmediate(r)) }
const HOME = join('H', 'home')

class FakeRunner implements RunnerLike {
  s: SyncState = { connected: false, running: false, last: null }
  listeners = new Set<(s: SyncState) => void>()
  calls: string[] = []
  next: SyncResult | undefined
  state(): SyncState { return this.s }
  set(s: Partial<SyncState>): void { this.s = { ...this.s, ...s }; for (const l of this.listeners) l(this.s) }
  async run(reason: string): Promise<SyncResult | undefined> { this.calls.push(`run:${reason}`); return this.s.connected ? this.next : undefined }
  async connect(url: string): Promise<SyncResult | undefined> { this.calls.push(`connect:${url}`); if (this.next?.ok) this.set({ connected: true, last: this.next }); return this.next }
  async disconnect(): Promise<{ ok: boolean; message: string }> { this.calls.push('disconnect'); this.set({ connected: false, last: null }); return { ok: true, message: 'Desconectado.' } }
  onDidChange(l: (s: SyncState) => void): () => void { this.listeners.add(l); return () => this.listeners.delete(l) }
}

const result = (ok: boolean, code?: string, message = ''): SyncResult => ({ at: '2026-11-23T12:00:00.000Z', ok, ...(code ? { error: { code, message } } : {}), report: ok ? { applied: {} } : null, reason: 'x', ms: 10 })

function harness(files: Record<string, string> = {}) {
  const runner = new FakeRunner()
  const pushed: SyncView[] = []
  const notices: { message: string; resolved: boolean; updates: string[] }[] = []
  const core = createSyncMain({
    home: HOME,
    runner: () => runner,
    readText: async p => files[p],
    notices: { raise: ({ message }) => { const n = { message, resolved: false, updates: [] as string[] }; notices.push(n); return { resolve: () => { n.resolved = true }, update: (m: string) => { n.updates.push(m) }, dispose: () => { n.resolved = true } } } },
    push: v => pushed.push(v),
    log: () => undefined,
  })
  return { runner, pushed, notices, core, files }
}

describe('sync main: the view', () => {
  test('without a link: the empty view, nothing read', async () => {
    const h = harness()
    assert.deepEqual(await h.core.view(), { connected: false, running: false, last: null })
  })

  test('linked: masked remote and machine from sync.json; before the first cycle, sync-last.json', async () => {
    const h = harness({
      [join(HOME, 'sync.json')]: JSON.stringify({ provider: 'git', url: 'https://me:tok@git.test/p.git', machine: 'casa' }),
      [join(HOME, 'sync-last.json')]: JSON.stringify({ at: '2026-11-23T11:00:00Z', ok: true, report: { applied: {}, missingEnv: { w: ['K'] } } }),
      [join(HOME, 'profiles.json')]: JSON.stringify({ v: 1, profiles: [{ id: 'w', name: 'Trabalho' }] }),
    })
    h.runner.s = { connected: true, running: false, last: null }
    const v = await h.core.view()
    assert.equal(v.remote, 'https://***@git.test/p.git')
    assert.equal(v.machine, 'casa')
    assert.equal(v.last?.at, '2026-11-23T11:00:00Z')
    assert.deepEqual(v.profileNames, { w: 'Trabalho' })
    assert.equal(v.trashDir, join(HOME, 'sync-trash'))
    assert.ok(!JSON.stringify(v).includes('tok'), 'no credential crosses to the renderer')
  })

  test('every runner change is pushed to the renderer', async () => {
    const h = harness()
    await tick()
    const before = h.pushed.length
    h.runner.set({ connected: true, running: true })
    await tick()
    assert.equal(h.pushed.length, before + 1)
    assert.equal(h.pushed.at(-1)?.running, true)
  })
})

describe('sync main: the acts', () => {
  test('connect refuses what does not look like a remote, without touching the runner', async () => {
    const h = harness()
    assert.deepEqual(await h.core.connect('--upload-pack=evil'), { ok: false, message: 'isso não parece o endereço de um repositório git' })
    assert.deepEqual(await h.core.connect(42), { ok: false, message: 'isso não parece o endereço de um repositório git' })
    assert.deepEqual(h.runner.calls, [])
  })

  test('connect goes through the runner; a failure is the one line, masked', async () => {
    const h = harness()
    h.runner.next = result(false, 'auth', 'o remoto recusou o acesso a https://u:p@git.test/r.git')
    assert.deepEqual(await h.core.connect(' https://git.test/r.git '), { ok: false, message: 'o remoto recusou o acesso a https://***@git.test/r.git' })
    assert.deepEqual(h.runner.calls, ['connect:https://git.test/r.git'])
    h.runner.next = result(true)
    const r = await h.core.connect('https://git.test/r.git')
    assert.equal(r.ok, true)
    assert.equal(r.ok && r.view.connected, true)
  })

  test('now and disconnect go through the runner', async () => {
    const h = harness()
    assert.equal((await h.core.now()).ok, false, 'without a link there is nothing to run')
    h.runner.s = { connected: true, running: false, last: null }
    h.runner.next = result(true)
    assert.equal((await h.core.now()).ok, true)
    const d = await h.core.disconnect()
    assert.equal(d.ok && d.view.connected, false)
    assert.deepEqual(h.runner.calls, ['run:agora', 'run:agora', 'disconnect'])
  })
})

describe('sync main: the tray notice', () => {
  test('raised for authentication, kept through a network failure, resolved by a good cycle', async () => {
    const h = harness()
    h.runner.set({ connected: true, last: result(false, 'auth', 'recusado') })
    await tick()
    assert.equal(h.notices.length, 1)
    assert.match(h.notices[0]!.message, /recusou o acesso/)
    h.runner.set({ last: result(false, 'network', 'sem rede') })
    await tick()
    assert.equal(h.notices[0]!.resolved, false, 'network neither raises nor resolves')
    assert.equal(h.notices.length, 1)
    h.runner.set({ last: result(true) })
    await tick()
    assert.equal(h.notices[0]!.resolved, true)
  })

  test('git missing raises; a network failure alone never does; the link gone resolves', async () => {
    const h = harness()
    h.runner.set({ connected: true, last: result(false, 'network', 'sem rede') })
    await tick()
    assert.equal(h.notices.length, 0)
    h.runner.set({ last: result(false, 'git-missing', 'sem git') })
    await tick()
    assert.equal(h.notices.length, 1)
    assert.match(h.notices[0]!.message, /git não está instalado/)
    h.runner.set({ connected: false, last: null })
    await tick()
    assert.equal(h.notices[0]!.resolved, true)
  })
})

describe('sync doctor', () => {
  const io = (files: Record<string, string>, exe: string[] = []) => ({
    tryReadText: async (p: string) => files[p],
    exists: async (p: string) => exe.includes(p),
  })
  const now = Date.parse('2026-11-23T12:00:00Z')
  const cfg = { [join(HOME, 'sync.json')]: JSON.stringify({ provider: 'git', url: 'https://me:tok@git.test/p.git', machine: 'casa' }) }
  const bin = join('B', 'bin')
  const env = { PATH: bin }
  const git = [join(bin, process.platform === 'win32' ? 'git.exe' : 'git')]

  test('not configured: a quiet OK', async () => {
    assert.deepEqual(await syncCheck({ home: HOME, io: io({}), env, now }), { level: 'OK', name: 'sincronização', detail: 'não configurada' })
  })

  test('connected with a good last cycle: OK with its age, the remote masked', async () => {
    const c = await syncCheck({ home: HOME, io: io({ ...cfg, [join(HOME, 'sync-last.json')]: JSON.stringify({ at: '2026-11-23T11:55:00Z', ok: true, report: {} }) }, git), env, now })
    assert.equal(c.level, 'OK')
    assert.equal(c.detail, 'conectada a https://***@git.test/p.git como "casa"; última sincronização há 5 min')
  })

  test('last cycle failed: AVISO with a hint', async () => {
    const c = await syncCheck({ home: HOME, io: io({ ...cfg, [join(HOME, 'sync-last.json')]: JSON.stringify({ at: '2026-11-23T11:59:00Z', ok: false, error: { code: 'auth', message: 'recusado por https://me:tok@git.test' }, report: null }) }, git), env, now })
    assert.equal(c.level, 'AVISO')
    assert.match(c.detail, /^o último ciclo falhou há 1 min: recusado por https:\/\/\*\*\*@git\.test$/)
    assert.match(c.hint ?? '', /credencial ou chave SSH/)
  })

  test('git missing with sync configured: ERRO; no credential anywhere', async () => {
    const c = await syncCheck({ home: HOME, io: io(cfg, []), env, now })
    assert.equal(c.level, 'ERRO')
    assert.match(c.hint ?? '', /instale o git/)
    assert.ok(!JSON.stringify(c).includes('tok'))
  })

  test('gitOnPath walks PATH asynchronously', async () => {
    assert.equal(await gitOnPath({ exists: async p => p === join('b', 'git') }, { PATH: ['a', 'b'].join(process.platform === 'win32' ? ';' : ':') }, 'linux'), true)
    assert.equal(await gitOnPath({ exists: async () => false }, { PATH: 'a' }, 'linux'), false)
  })
})
