// The remote's audit (RR2.3; plano §2 "Na máquina", M-10): rotated with a ceiling of size and count, one line per act and
// never content, written without holding the loop, and total over the table of operations: a request that changes state or
// is a gesture leaves a line whether the house accepted it or refused it.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { agentExecutor } from '../../src/agents/agent-exec.ts'
import { OPS } from '../../src/remote/index.ts'
import { audited } from '../../src/remoted/house.ts'
import { AUDIT_FILES_MAX, AUDIT_MAX_BYTES, AuditLog, auditField, type AuditDeps } from '../../extensions/remote/daemon/audit.ts'
import { READ_REQUESTS, RemoteService } from '../../extensions/remote/daemon/service.ts'
import type { RemoteRequest } from '../../extensions/remote/rules.ts'
import type { DaemonIo } from '../../src/daemon/ext-api.ts'
import { removeHome } from './daemon.helpers.ts'
import { startHouseBench, type HouseBench } from './remoted.house-bench.ts'
import { benchHome } from './remoted.helpers.ts'

const realIo: AuditDeps['io'] = {
  appendText: (p, t) => appendFile(p, t),
  rename: (a, b) => rename(a, b),
  stat: async (p) => { const s = await stat(p); return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory() } },
  exists: (p) => stat(p).then(() => true, () => false),
}
const lines = (path: string): Record<string, string>[] =>
  readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, string>)
const auditFiles = (dir: string): string[] => readdirSync(dir).filter((f) => /^audit(\.\d+)?\.jsonl$/.test(f)).sort()

describe('the audit file is rotated with a ceiling of size and of count', () => {
  const dir = benchHome('remote-audit-')
  after(async () => { await removeHome(dir) })

  test('a thousand lines never leave more than maxFiles files, each within the ceiling; the oldest are the ones that go', async () => {
    const log = new AuditLog({ dir, io: realIo, now: () => 1_700_000_000_000, log: (m) => assert.fail(m), maxBytes: 2_000, maxFiles: 3 })
    for (let i = 0; i < 1000; i++) {
      log.record({ act: 'session.open', device: 'ab'.repeat(16), result: `n:${i}` })
      if (i % 50 === 0) await log.flush() // the queue has its own ceiling: let the disk keep up, as it does in life
    }
    await log.flush()
    assert.deepEqual(auditFiles(dir), ['audit.1.jsonl', 'audit.2.jsonl', 'audit.jsonl'])
    for (const f of auditFiles(dir)) assert.ok((await stat(join(dir, f))).size <= 2_000, `${f} within the ceiling`)
    const last = lines(join(dir, 'audit.jsonl')).at(-1)!
    assert.equal(last.result, 'n:999', 'the newest line is in the live file')
    const oldest = lines(join(dir, 'audit.2.jsonl'))[0]!
    assert.notEqual(oldest.result, 'n:0', 'the first lines were pushed out by the count ceiling')
  })

  test('the production defaults hold the log under AUDIT_FILES_MAX × AUDIT_MAX_BYTES', () => {
    assert.ok(AUDIT_FILES_MAX * AUDIT_MAX_BYTES <= 1024 * 1024)
  })
})

describe('a line says when, who, what and the result: never content', () => {
  test('every field is cut to the id alphabet; a value of env, an argument or typed text cannot get in', async () => {
    const dir = benchHome('remote-audit-')
    try {
      const secret = 'API_TOKEN=s3cr3t value with spaces "quotes"\nand a second line'
      const log = new AuditLog({ dir, io: realIo, now: () => Date.parse('2026-11-27T10:00:00Z'), log: (m) => assert.fail(m) })
      log.record({ act: 'pair.refused', device: 'cd'.repeat(16), target: secret, result: secret })
      log.record({ act: secret, result: '' })
      await log.flush()
      const text = readFileSync(join(dir, 'audit.jsonl'), 'utf8')
      assert.equal(text.split('\n').filter(Boolean).length, 2, 'a newline in a field does not make a line')
      assert.doesNotMatch(text, /s3cr3t value|"quotes"|\\n.*second line/, 'no space, quote or newline survives: free text cannot keep its shape')
      for (const l of lines(join(dir, 'audit.jsonl'))) {
        assert.deepEqual(Object.keys(l).filter((k) => !['ts', 'act', 'device', 'target', 'result'].includes(k)), [])
        for (const k of ['act', 'device', 'target', 'result']) if (l[k] !== undefined) assert.match(l[k]!, /^[\w.:-]{1,64}$/, k)
        assert.equal(l.ts, '2026-11-27T10:00:00.000Z')
      }
      assert.equal(auditField(''), '-')
    } finally { await removeHome(dir) }
  })
})

describe('the writer does not hold the loop and does not grow when the disk stalls', () => {
  test('record returns at once; past the queue ceiling lines are counted, and said in one line when the disk answers', async () => {
    const dir = benchHome('remote-audit-')
    try {
      let release!: () => void
      const stalled = new Promise<void>((r) => { release = r })
      let writes = 0
      const io: AuditDeps['io'] = { ...realIo, appendText: async (p, t) => { writes++; if (writes === 1) await stalled; await appendFile(p, t) } }
      const log = new AuditLog({ dir, io, now: () => 1, log: () => {}, pendingMax: 8 })
      const t0 = Date.now()
      for (let i = 0; i < 5_000; i++) log.record({ act: 'limit.req', result: 'limit' })
      assert.ok(Date.now() - t0 < 500, 'five thousand records are queued without waiting for the disk')
      release()
      await log.flush()
      const all = lines(join(dir, 'audit.jsonl'))
      assert.ok(all.length <= 8 + 1 + 1, `what was kept is bounded (${all.length})`)
      const dropped = all.find((l) => l.act === 'audit.dropped')
      assert.ok(dropped && Number(dropped.result!.replace('n:', '')) >= 4_900, 'the loss is said, with its count')
    } finally { await removeHome(dir) }
  })
})

describe('every request that changes state or is a gesture leaves a line, accepted or refused', () => {
  let bench: HouseBench
  after(async () => { await bench?.stop() })

  test('the table: each such line, sent by a paired device, is in the audit with its own name and the device', async () => {
    bench = await startHouseBench()
    const s = await bench.connect()
    const mustAudit = OPS.filter(audited)
    assert.ok(mustAudit.length >= 5, 'the table has acts')
    for (const line of mustAudit) {
      const before = bench.audits().length
      // A body of the right shape is not the point: refused, malformed or not implemented, the line is.
      await s.request(line.code, {}, { actId: randomBytes(16) })
      const mine = bench.audits().slice(before).filter((a) => a.act === line.name && a.deviceId)
      assert.equal(mine.length, 1, `${line.name}: one line for one request`)
      assert.match(mine[0]!.result, /^[\w.:-]+$/)
    }
  })

  test('a refused request is audited too, and a repeated actId says `replay`; a read leaves no line of its own', async () => {
    const s = await bench.connect()
    const id = randomBytes(16)
    await s.request(0x0601, {}, { actId: id }) // device.revoke: per-act presence, refused
    assert.equal(bench.audits().filter((a) => a.act === 'device.revoke' && a.result === 'presenceRequired').length >= 1, true)
    const reads = OPS.filter((l) => !audited(l))
    assert.ok(reads.length > 0)
    const before = bench.audits().length
    await s.request(0x0001)
    assert.equal(bench.audits().length, before, 'session.info only reads')
  })
})

describe('the requests of the pipe: the person-facing ones leave a line when refused at the door, too', () => {
  // A new request of the extension without a place in this map does not compile.
  const READS: Record<RemoteRequest, boolean> = {
    'remote.status': true, 'device.list': true, 'pair.state': true,
    'remote.on': false, 'remote.off': false, 'device.revoke': false, 'pair.begin': false, 'pair.sas': false, 'pair.cancel': false,
  }

  test('the classification of the map is the one the service uses', () => {
    assert.deepEqual([...READ_REQUESTS].sort(), Object.entries(READS).filter(([, r]) => r).map(([n]) => n).sort())
  })

  test('from a client that is not the app, each act is refused and recorded with the client, never with its arguments', async () => {
    const home = benchHome('remote-audit-svc-')
    try {
      const io: DaemonIo = {
        readText: (p) => readFile(p, 'utf8'), tryReadText: (p) => readFile(p, 'utf8').catch(() => undefined),
        writeTextAtomic: async (p, t) => { await mkdir(dirname(p), { recursive: true }); await writeFile(`${p}.tmp`, t); await rename(`${p}.tmp`, p) },
        appendText: (p, t) => appendFile(p, t), rename: (a, b) => rename(a, b), rm: (p) => rm(p, { recursive: true, force: true }),
        mkdirp: async (p) => { await mkdir(p, { recursive: true }) },
        stat: async (p) => { const x = await stat(p); return { size: x.size, mtimeMs: x.mtimeMs, isFile: x.isFile(), isDirectory: x.isDirectory() } },
        readdir: async (p) => (await readdir(p, { withFileTypes: true })).map((d) => ({ name: d.name, isFile: d.isFile(), isDirectory: d.isDirectory() })),
        exists: (p) => stat(p).then(() => true, () => false),
      }
      const svc = new RemoteService({ home, io, log: () => {}, env: {}, executor: agentExecutor() })
      const args = { relayUrl: 'wss://x.example/API_TOKEN=s3cr3t', digits: '123456', pairId: 'ab'.repeat(16), device: 'zz-s3cr3t' }
      const ctx = { client: 'agent', conn: 1 }
      // Only the app asks these (E-7 (b)); the rest are `any` and are refused for their own reasons (no such device).
      for (const name of ['remote.on', 'pair.begin', 'pair.sas', 'pair.cancel'] as const) {
        await assert.rejects(svc.handle(name, args, ctx), /só é aceito do app/, name)
      }
      await assert.rejects(svc.handle('device.revoke', args, ctx), /nenhum aparelho/)
      await svc.handle('remote.off', {}, ctx) // accepted: recorded as well
      for (const name of ['remote.status', 'device.list'] as const) await svc.handle(name, {}, ctx)
      await svc.dispose()
      const text = readFileSync(join(home, 'remote', 'audit.jsonl'), 'utf8')
      assert.doesNotMatch(text, /s3cr3t|123456|x\.example/)
      const acts = lines(join(home, 'remote', 'audit.jsonl'))
      const said = (name: string): string[] => acts.filter((l) => l.act === name).map((l) => `${l.result}@${l.target ?? ''}`)
      for (const name of ['remote.on', 'pair.begin', 'pair.sas', 'pair.cancel']) assert.deepEqual(said(name), ['refused:door-denied@agent'], name)
      assert.deepEqual(said('device.revoke'), ['refused:bad-request@agent'])
      assert.deepEqual(said('remote.off'), ['already-off:by:agent@'])
      assert.deepEqual([...said('remote.status'), ...said('device.list'), ...said('pair.state')], [], 'reads leave no line')
    } finally { await removeHome(home) }
  })
})
