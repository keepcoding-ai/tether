// The processes' feed for the Regency's "Sistema": inactive answers in words; publishing reads the list without `env`, forwards
// the acts, and the acts keep the pad's rules (others' uses refuse with who, until when and what for; waiting and forcing are the ways out).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Reply } from '../../src/daemon/protocol.ts'
import type { ProcState } from '../../src/daemon/procs.ts'
import { createProcessActs, createProcessEmbeds, type ProcessActsDeps, type ProcessEmbedSource } from '../../extensions/processes/embed.ts'
import { procRowsOf } from '../../extensions/regency/system-rules.ts'

const NOW = Date.parse('2026-11-26T12:00:00.000Z')
const SECRET = 'hunter2-do-not-leak'

const proc = (name: string, extra: Partial<ProcState> = {}): ProcState => ({
  name,
  status: 'running',
  run: 1,
  card: {
    v: 1, name, command: 'node', args: ['x.mjs'], cwd: 'C:/work', env: { API_TOKEN: SECRET }, ports: [3000], stopGraceMs: 2000, info: {},
    registeredBy: { kind: 'app' }, createdAt: '2026-11-26T11:00:00.000Z',
  },
  ...extra,
})
const ok = { t: 'ok', id: 1 } as unknown as Reply
const error = (code: string, message = ''): Reply => ({ t: 'error', id: 1, code, message }) as unknown as Reply

interface Rig { calls: string[]; deps: ProcessActsDeps; procs: Map<string, ProcState>; tabs: Set<string>; replies: Map<string, Reply> }
function rig(): Rig {
  const calls: string[] = []
  const procs = new Map([proc('web'), proc('worker', { status: 'stopped' })].map(p => [p.name, p]))
  const tabs = new Set<string>()
  const replies = new Map<string, Reply>()
  const reply = (key: string): Reply => replies.get(key) ?? ok
  const deps: ProcessActsDeps = {
    get: n => procs.get(n),
    now: () => NOW,
    start: async n => { calls.push(`start ${n}`); return reply('start') },
    stop: async (n, o) => { calls.push(`stop ${n} ${JSON.stringify(o)}`); return reply('stop') },
    restart: async (n, o) => { calls.push(`restart ${n} ${JSON.stringify(o)}`); return reply('restart') },
    use: async (n, d, p) => { calls.push(`use ${n} ${d} ${p}`); return reply('use') },
    release: async n => { calls.push(`release ${n}`); return reply('release') },
    paneIdOf: n => `process:${n}`,
    panes: {
      has: id => tabs.has(id),
      openOnDesk: (n, desk, tl) => { calls.push(`open ${n} ${desk} ${tl}`); return desk !== 'nope' },
      peekPane: id => { calls.push(`peekPane ${id}`) },
      peekNew: (n, id) => { calls.push(`peekNew ${n} ${id}`); return true },
    },
  }
  return { calls, deps, procs, tabs, replies }
}

test('the feed off: empty list, every act refuses in words; publishing turns it on and a stale handle leaves the newer source', async () => {
  const feed = createProcessEmbeds()
  assert.equal(feed.active, false)
  assert.deepEqual(feed.list(), [])
  assert.equal(feed.get('web'), undefined)
  for (const r of [await feed.start('web'), await feed.stop('web'), await feed.restart('web'), await feed.hold('web'), await feed.release('web'), feed.output('web', { deskId: 'd' }), feed.peekOutput('web')]) {
    assert.deepEqual(r, { refusal: 'Os processos estão desligados.' })
  }
  let changes = 0
  feed.onDidChange(() => { changes++ })
  const listeners = new Set<() => void>()
  const source = (name: string): ProcessEmbedSource => ({
    ...createProcessActs({ ...rig().deps }),
    list: () => [proc(name)],
    onDidChange: l => { listeners.add(l); return { dispose: () => { listeners.delete(l) } } },
  })
  const first = feed.publish(source('a'))
  assert.equal(feed.active, true)
  assert.equal(changes, 1, 'turning on tells the listeners')
  listeners.forEach(l => l())
  assert.equal(changes, 2, 'a change of the source reaches the listeners')
  const second = feed.publish(source('b'))
  first.dispose()
  assert.equal(feed.active, true)
  assert.deepEqual(feed.list().map(p => p.name), ['b'])
  second.dispose()
  assert.equal(feed.active, false)
  assert.equal(listeners.size, 0)
})

test('the list never carries the values of env, only what the model reads', () => {
  const feed = createProcessEmbeds()
  feed.publish({ ...createProcessActs(rig().deps), list: () => [proc('web')], onDidChange: () => ({ dispose() {} }) })
  const [web] = feed.list()
  assert.equal('env' in web!.card, false)
  assert.ok(!JSON.stringify(feed.list()).includes(SECRET))
  assert.ok(!JSON.stringify(feed.get('web')).includes(SECRET))
  assert.equal(web!.card.cwd, 'C:/work')
  // and it is what the Regency's model consumes
  assert.deepEqual(procRowsOf(feed.list(), NOW).map(p => p.name), ['web'])
})

test('start, stop, restart, hold and release forward the requests and answer ok', async () => {
  const r = rig()
  const acts = createProcessActs(r.deps)
  assert.deepEqual(await acts.start('worker'), { ok: true })
  assert.deepEqual(await acts.stop('web'), { ok: true })
  assert.deepEqual(await acts.restart('web'), { ok: true })
  assert.deepEqual(await acts.hold('web'), { ok: true })
  assert.deepEqual(await acts.hold('web', { duration: '5m', purpose: '  e2e  ' }), { ok: true })
  assert.deepEqual(await acts.release('web'), { ok: true })
  assert.deepEqual(r.calls, ['start worker', 'stop web {}', 'restart web {}', 'use web 15m segurado pela pessoa', 'use web 5m e2e', 'release web'])
})

test('an unknown process and the daemon\'s refusals come back as words', async () => {
  const r = rig()
  const acts = createProcessActs(r.deps)
  for (const p of [await acts.start('x'), await acts.stop('x'), await acts.restart('x'), await acts.hold('x'), await acts.release('x'), acts.output('x', { deskId: 'd' }), acts.peekOutput('x')]) {
    assert.deepEqual(p, { refusal: 'Esse processo não existe mais.' })
  }
  assert.deepEqual(r.calls, [], 'nothing was asked of the daemon')
  r.replies.set('start', error('proc-running'))
  assert.deepEqual(await acts.start('web'), { refusal: 'O processo já está rodando.' })
  r.replies.set('start', error('port-busy'))
  assert.deepEqual(await acts.start('web'), { refusal: 'Uma porta do processo está ocupada por outro.' })
})

test('in use by others: the refusal says who, until when and what for, with the ways out; the person\'s own hold does not refuse', async () => {
  const r = rig()
  const until = new Date(NOW + 10 * 60_000).toISOString()
  r.procs.set('web', proc('web', { uses: [
    { by: { kind: 'agent', name: 'Kai' }, until, purpose: 'e2e do checkout' },
    { by: { kind: 'app' }, until, purpose: 'segurado pela pessoa' },
  ] }))
  r.replies.set('stop', error('proc-in-use', 'board\nopções'))
  const acts = createProcessActs(r.deps)
  const out = await acts.stop('web')
  assert.ok('refusal' in out && out.inUse)
  assert.match(out.refusal, /parar "web".*outro o usa/)
  assert.equal(out.inUse!.lines.length, 1, 'only the uses of others')
  assert.match(out.inUse!.lines[0]!, /Kai usa até daqui a 10 min.*e2e do checkout/)
  assert.deepEqual(out.inUse!.exits.map(e => e.id), ['wait', 'force', 'cancel'])
  assert.equal(out.inUse!.exits[1]!.needsReason, true)
  r.replies.set('restart', error('proc-in-use'))
  const again = await acts.restart('web')
  assert.ok('inUse' in again && /reiniciar "web"/.test(again.refusal))
})

test('waiting and forcing: the wait is capped, the force needs a reason and carries it trimmed', async () => {
  const r = rig()
  const acts = createProcessActs(r.deps)
  assert.deepEqual(await acts.stop('web', { waitMs: 99 * 60_000 }), { ok: true })
  assert.deepEqual(await acts.restart('web', { waitMs: 1000 }), { ok: true })
  assert.deepEqual(await acts.stop('web', { force: '  o uso era meu  ' }), { ok: true })
  assert.deepEqual(r.calls, ['stop web {"waitMs":300000}', 'restart web {"waitMs":1000}', 'stop web {"force":"o uso era meu"}'])
  assert.deepEqual(await acts.stop('web', { force: '   ' }), { refusal: 'Diga o motivo para forçar.' })
  assert.equal(r.calls.length, 3, 'a force without a reason asks nothing')
})

test('output opens the record on a desk; refuses when it already has a tab or the desk is unknown; peekOutput lends the tab or builds none', async () => {
  const r = rig()
  const acts = createProcessActs(r.deps)
  assert.deepEqual(acts.output('web', { deskId: 'desk-2' }), { ok: true })
  assert.deepEqual(acts.output('web', { deskId: 'desk-2', timeline: false }), { ok: true })
  assert.deepEqual(acts.output('web', { deskId: 'nope' }), { refusal: 'Não foi possível abrir o registro nessa mesa.' })
  r.tabs.add('process:web')
  assert.deepEqual(acts.output('web', { deskId: 'desk-2' }), { refusal: 'O registro de "web" já está aberto como guia.' })
  assert.deepEqual(acts.peekOutput('web'), { ok: true })
  assert.deepEqual(acts.peekOutput('worker'), { ok: true })
  assert.deepEqual(r.calls, ['open web desk-2 true', 'open web desk-2 false', 'open web nope true', 'peekPane process:web', 'peekNew worker process:worker'])
})
