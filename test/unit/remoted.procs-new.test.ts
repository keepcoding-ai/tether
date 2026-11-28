// RR5 step 5.5 (fio-spec 18): "Novo processo" from afar, with the three protections. Proved here:
// - procNewArgs (src/remoted/recipe.ts): the strict body, the command split as the Regency's form splits it, the folder by
//   id; a variable whose name or value looks like a secret, or a command that carries one, refused by its names (never a
//   value), with no "anyway";
// - remoteRecipeOk / remoteMayAct: tetherd admits from a `remote` client a recipe only in that form, by the same rules;
// - a real House (remoted.house-bench.ts): a proof of this very act before anything; the folder resolved against tetherd's
//   list (`create.options`), never a path from the device; a name some process has refused (`proc-exists`) before
//   `proc-start`; the answer with the env by names; and THE CANARY: a marker in a variable's value reaches no reply, no
//   audit line, no note, no log line and no answer the actId's cache gives back.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { DaemonError } from '../../src/daemon/client.ts'
import { assertionChallenge, OP_CODES, RES_STATUS } from '../../src/remote/index.ts'
import { ERROR_CODES } from '../../src/remote/projection.ts'
import { ENV_MAX, PROC_COMMAND_MAX, PROC_NEW_ERROR_CODES } from '../../src/remote/procs-new.ts'
import { folderId } from '../../src/remote/create.ts'
import { pipeActs } from '../../src/remoted/acts.ts'
import { remoteMayAct } from '../../src/remoted/reach.ts'
import { procNewArgs, remoteRecipeOk } from '../../src/remoted/recipe.ts'
import type { PipeReads } from '../../src/remoted/reads.ts'
import { act, actId, ORIGIN, registerAndUnlock, type SoftAuthenticator } from './remoted.authenticator.ts'
import { startHouseBench, type HouseBench } from './remoted.house-bench.ts'
import type { DeviceSession } from './remoted.helpers.ts'

const MARKER = `canary${randomBytes(10).toString('hex')}`
const has = (v: unknown): boolean => JSON.stringify(v).includes(MARKER)
const FOLDER = folderId('C:\\p\\web', true)
const BODY = { name: 'bench-web', command: 'node server.js --port 3000', folder: FOLDER, ports: [3000, 3000], description: 'o site\n', env: [{ name: 'BENCH_MODE', value: MARKER }] }

describe('procNewArgs: the body, and the secret rules with no "anyway"', () => {
  test('a recipe: the command split, ports once each, the description one line, the env by name and value', () => {
    assert.deepEqual(procNewArgs(BODY), {
      name: 'bench-web', folder: FOLDER,
      recipe: { command: 'node', args: ['server.js', '--port', '3000'], env: { BENCH_MODE: MARKER }, ports: [3000], description: 'o site' },
    })
    assert.deepEqual(procNewArgs({ name: 'x', command: '"C:\\Program Files\\node.exe" a.js', folder: FOLDER }), {
      name: 'x', folder: FOLDER, recipe: { command: 'C:\\Program Files\\node.exe', args: ['a.js'], env: {}, ports: [] },
    })
  })

  test('a name or a value that looks like a secret is refused by its names, never a value', () => {
    for (const [name, value] of [['API_TOKEN', 'x'], ['DB_PASS', 'x'], ['GITHUB_KEY', 'x'], ['CLIENT_SECRET', 'x'], ['PGPASSWORD', 'x'], ['AUTH_HEADER', 'x'], ['AWS_CREDENTIAL', 'x'], ['URL', `postgres://u:${MARKER}@db/x`], ['X', `sk-${MARKER}${MARKER}`]] as const) {
      const r = procNewArgs({ ...BODY, env: [{ name: 'BENCH_MODE', value: 'ok' }, { name, value }] })
      assert.deepEqual(r, { why: 'secret-env', names: [name] }, name)
      assert.equal(has(r), false, name)
    }
    assert.deepEqual(procNewArgs({ ...BODY, command: `curl --token ${MARKER} http://localhost:1` }), { why: 'secret-command' })
    assert.deepEqual(procNewArgs({ ...BODY, command: 'dotenvx run -- npm start' }).hasOwnProperty('why'), false, 'the secret in the command itself, as the screen says')
  })

  test('refused before anything: a path for the folder, a free name, controls, too long, a name twice, the wrong shapes', () => {
    for (const b of [
      { ...BODY, folder: 'C:\\p\\web' }, { ...BODY, name: 'Web App' }, { ...BODY, command: 'node a.js\nrm -rf /' }, { ...BODY, command: '' },
      { ...BODY, env: [{ name: 'A', value: 'x\u0000' }] }, { ...BODY, env: [{ name: 'A', value: '1' }, { name: 'a', value: '2' }] },
      { ...BODY, env: [{ name: '1A', value: 'x' }] }, { ...BODY, env: [{ name: 'A', value: 'x', extra: 1 }] }, { ...BODY, env: { A: 'x' } },
      { ...BODY, ports: [0] }, { ...BODY, ports: ['3000'] }, { ...BODY, env: Array.from({ length: ENV_MAX + 1 }, (_, i) => ({ name: `V${i}`, value: 'x' })) },
    ]) assert.deepEqual(procNewArgs(b as never), { why: 'bad-request' }, JSON.stringify(b).slice(0, 80))
    assert.deepEqual(procNewArgs({ ...BODY, command: 'x'.repeat(PROC_COMMAND_MAX + 1) }), { why: 'too-long' })
  })

  test('tetherd admits from afar only a recipe in that form: no info, no grace, no secret, an absolute folder', () => {
    const built = procNewArgs(BODY) as { name: string; recipe: Record<string, unknown> }
    const recipe = { ...built.recipe, cwd: 'C:\\p\\web' }
    assert.equal(remoteRecipeOk(recipe), true)
    assert.equal(remoteMayAct({ t: 'proc-start', name: 'bench-web', recipe }), true)
    for (const bad of [
      { ...recipe, info: { a: 'b' } }, { ...recipe, stopGraceMs: 1 }, { ...recipe, cwd: 'web' }, { ...recipe, env: { API_TOKEN: 'x' } },
      { ...recipe, args: ['--password', 'x'] }, { ...recipe, description: ' o site ' }, { ...recipe, ports: undefined },
    ]) assert.equal(remoteRecipeOk(bad), false, JSON.stringify(bad).slice(0, 80))
    assert.equal(remoteMayAct({ t: 'proc-start', name: 'bench-web', recipe, force: true }), false, 'never over a busy port')
    for (const c of PROC_NEW_ERROR_CODES) assert.ok((ERROR_CODES as readonly string[]).includes(c), c)
  })
})

describe('"Novo processo" through a real House', () => {
  let bench: HouseBench
  let s: DeviceSession
  let auth: SoftAuthenticator
  const logs: string[] = []
  const sent: Record<string, unknown>[] = []
  const reads: { op: string }[] = []
  const known = new Set<string>(['taken'])
  const pipeReads: PipeReads = {
    read: async (op) => {
      reads.push({ op })
      return { engines: [], profiles: [], desks: [], folders: [{ id: FOLDER, label: 'web', kind: 'project', path: 'C:\\p\\web' }] }
    },
  }
  const request = async (m: Record<string, unknown>): Promise<Record<string, unknown>> => {
    sent.push(m)
    if (m.t === 'proc-info') {
      if (!known.has(String(m.name))) throw new DaemonError('unknown-proc', `não há ${String(m.name)}`)
      return { proc: { name: m.name, status: 'stopped', card: { command: 'x', cwd: 'C:\\', env: {}, ports: [] } }, events: [] }
    }
    const recipe = m.recipe as { command: string; cwd: string; env: Record<string, string>; ports: number[] }
    known.add(String(m.name))
    // A tetherd that answers the whole card, its env values among it: only the names may pass.
    return { proc: { name: m.name, status: 'running', run: 1, card: { ...recipe, createdAt: '2026-11-28T10:00:00.000Z' }, env: recipe.env, args: [MARKER] } }
  }
  const audits = () => bench.audits()

  before(async () => {
    bench = await startHouseBench({
      origin: ORIGIN, reads: pipeReads, acts: pipeActs((m) => request(m as Record<string, unknown>), { timeoutMs: 1_000 }), actTimeoutMs: 1_000,
      limits: { reqPerDevicePerMin: 10_000, gesturesPerDevicePerMin: 10_000 }, log: (m) => logs.push(m),
    })
    auth = await registerAndUnlock(bench.fresh, bench.device.kD.pub)
    s = bench.fresh
  })
  after(async () => { await bench?.stop() })

  test('without a proof of this very act nothing is read nor sent', async () => {
    assert.equal((await s.request(OP_CODES['procs.new'], BODY, { actId: actId() })).status, RES_STATUS.presenceRequired)
    assert.equal((await act(s, auth, OP_CODES['procs.new'], BODY, { proof: false })).status, RES_STATUS.presenceRequired)
    assert.deepEqual([sent, reads], [[], []])
  })

  test('with it: the folder resolved, the name free, proc-start with the recipe; the answer names the env, never a value', async () => {
    const r = await act(s, auth, OP_CODES['procs.new'], BODY)
    assert.equal(r.status, RES_STATUS.ok, JSON.stringify(r.body))
    assert.deepEqual((r.body as { proc: { envNames: string[] } }).proc.envNames, ['BENCH_MODE'])
    assert.equal(has(r), false, 'the value never comes back')
    assert.deepEqual(reads, [{ op: 'create.options' }])
    assert.deepEqual(sent.map((m) => m.t), ['proc-info', 'proc-start'])
    assert.deepEqual(sent[1], { t: 'proc-start', name: 'bench-web', recipe: { command: 'node', args: ['server.js', '--port', '3000'], env: { BENCH_MODE: MARKER }, ports: [3000], description: 'o site', cwd: 'C:\\p\\web' } })
    const line = audits().filter((l) => l.act === 'procs.new').at(-1)!
    assert.deepEqual([line.result, line.target], ['ok', 'bench-web'])
  })

  test('the same act again (the actId replayed) is the kept answer, without the value; nothing is sent again', async () => {
    // The proof binds the body and the actId: a replay is the same request again, which the cache answers.
    const sentBefore = sent.length
    const body = { ...BODY, name: 'bench-two' }
    const raw = new TextEncoder().encode(JSON.stringify(body))
    const id = actId()
    const c = await s.request(0x0003, { purpose: 'act', op: OP_CODES['procs.new'] })
    const chal = await assertionChallenge(s.session.sessionId, c.body.uvCtr as number, { purpose: 'act', op: OP_CODES['procs.new'], actId: id, body: raw })
    const proof = await auth.assert(chal, c.body.uvCtr as number)
    const first = await s.request(OP_CODES['procs.new'], {}, { actId: id, raw, uvProof: proof })
    assert.equal(first.status, RES_STATUS.ok)
    const again = await s.request(OP_CODES['procs.new'], {}, { actId: id, raw, uvProof: proof })
    assert.deepEqual(again, first, 'the kept answer')
    assert.equal(sent.length, sentBefore + 2, 'one proc-info and one proc-start, once')
    assert.equal(has(again), false)
    assert.ok(audits().some((l) => l.act === 'procs.new' && l.result === 'replay'))
  })

  test('a name some process has, a folder not of the list, a secret: refused by code before proc-start', async () => {
    const before = sent.filter((m) => m.t === 'proc-start').length
    assert.deepEqual(await act(s, auth, OP_CODES['procs.new'], { ...BODY, name: 'taken' }), { status: RES_STATUS.failed, body: { error: 'proc-exists' } })
    assert.deepEqual(await act(s, auth, OP_CODES['procs.new'], { ...BODY, name: 'outro', folder: folderId('C:\\Windows', true) }), { status: RES_STATUS.notFound, body: { error: 'unknown-folder' } })
    const secret = await act(s, auth, OP_CODES['procs.new'], { ...BODY, name: 'outro', env: [{ name: 'API_TOKEN', value: MARKER }] })
    assert.deepEqual(secret, { status: RES_STATUS.failed, body: { error: 'secret-env', names: ['API_TOKEN'] } })
    assert.deepEqual(await act(s, auth, OP_CODES['procs.new'], { ...BODY, name: 'outro', command: `app --api-key ${MARKER}` }), { status: RES_STATUS.failed, body: { error: 'secret-command' } })
    assert.equal(sent.filter((m) => m.t === 'proc-start').length, before, 'nothing started')
    const results = audits().filter((l) => l.act === 'procs.new').map((l) => l.result)
    for (const r of ['refused:proc-exists', 'refused:unknown-folder', 'refused:secret-env', 'refused:secret-command']) assert.ok(results.includes(r), r)
  })

  test('THE CANARY: the value is in no audit line, no note of the house and no log line', () => {
    assert.equal(has(audits()), false, 'audit')
    assert.equal(has(bench.notes), false, 'notes')
    assert.equal(has(logs), false, 'logs')
    assert.equal(JSON.stringify(audits()).includes('API_TOKEN'), false, 'not even a refused name')
  })
})
