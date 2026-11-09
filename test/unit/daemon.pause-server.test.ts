// The polite pause in the daemon: pause-start writes the request file, the agent's reports (jsonl) fold into the
// batch in order, a stop without `done` is stopped-silent, and a restarted daemon reloads the batch.
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { pausePath, slotAttentionPath, slotPauseReportPath, slotPauseRequestPath } from '../../src/core/paths.ts'
import { DaemonError } from '../../src/daemon/client.ts'
import type { PauseBatch } from '../../src/daemon/pause.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { Recorder, removeHome, sleep, tempHome, uniquePipe, waitUntil } from './daemon.helpers.ts'

const homes: string[] = []
const daemons: Daemon[] = []
after(async () => {
  for (const d of daemons) await d.close()
  for (const h of homes) await removeHome(h)
})

async function boot(home?: string): Promise<{ home: string; daemon: Daemon; rec: Recorder; events: PauseBatch[] }> {
  const h = home ?? tempHome()
  if (!home) { homes.push(h); mkdirSync(join(h, 'work')) }
  const daemon = await startDaemon({ home: h, pipe: uniquePipe(h) })
  daemons.push(daemon)
  const rec = await Recorder.connect(daemon.pipe)
  const events: PauseBatch[] = []
  rec.client.on('pause', (b) => events.push(structuredClone(b)))
  return { home: h, daemon, rec, events }
}

async function shell(rec: Recorder, home: string, name: string, start = false): Promise<string> {
  return (await rec.client.request({ t: 'create', kind: 'shell', cwd: join(home, 'work'), name, ...(start ? { start: true } : {}) })).slot!.slotId
}

const report = (home: string, slotId: string, batchId: string, kind: string, text?: string): void => {
  appendFileSync(slotPauseReportPath(home, slotId), JSON.stringify({ ts: new Date().toISOString(), batchId, kind, ...(text ? { text } : {}) }) + '\n')
}
const states = (events: PauseBatch[], slotId: string): string[] => events.map((b) => b.entries.find((e) => e.slotId === slotId)!.state)
const isErr = (code: string) => (e: unknown): boolean => e instanceof DaemonError && e.code === code

describe('pause in the daemon', () => {
  test('start writes the request and persists; reports fold in order; done clears the request; the batch becomes paused', async () => {
    const { home, rec, events } = await boot()
    const a = await shell(rec, home, 'a')
    const b = await shell(rec, home, 'b')

    await assert.rejects(rec.client.request({ t: 'pause-start' }), isErr('bad-request'))
    await assert.rejects(rec.client.request({ t: 'pause-start', slotIds: ['nope'] }), isErr('unknown-slot'))
    assert.equal((await rec.client.request({ t: 'pause-get' })).pause, null)

    const batch = (await rec.client.request({ t: 'pause-start', slotIds: [a, b] })).pause!
    assert.equal(batch.state, 'pausing')
    assert.deepEqual(batch.entries.map((e) => e.state), ['listening', 'listening'])
    for (const id of [a, b]) {
      const req = JSON.parse(readFileSync(slotPauseRequestPath(home, id), 'utf8'))
      assert.equal(req.batchId, batch.id)
      assert.match(req.text, /node "[^"\\]*bin\/tether\.mjs" pause ack/, 'absolute command with forward slashes')
    }
    assert.equal(JSON.parse(readFileSync(pausePath(home), 'utf8')).id, batch.id)
    await assert.rejects(rec.client.request({ t: 'pause-start', slotIds: [a] }), isErr('pause-active'))
    await waitUntil(() => events.length >= 1, 3_000, 'pause event at start')

    report(home, a, batch.id, 'delivered')
    await waitUntil(() => states(events, a).includes('delivered'), 5_000, 'delivered')
    report(home, a, batch.id, 'ack', 'terminando o teste')
    report(home, a, batch.id, 'done', 'continuar do passo 3')
    await waitUntil(() => states(events, a).includes('stopped'), 5_000, 'stopped')
    assert.deepEqual([...new Set(states(events, a))], ['listening', 'delivered', 'preparing', 'stopped'])
    const last = events.at(-1)!
    const ea = last.entries.find((e) => e.slotId === a)!
    assert.equal(ea.phrase, 'terminando o teste')
    assert.equal(ea.note, 'continuar do passo 3')
    assert.ok(!existsSync(slotPauseRequestPath(home, a)), 'request cleared once stopped')
    assert.ok(existsSync(slotPauseRequestPath(home, b)), 'other slot keeps listening')
    assert.equal(last.state, 'pausing')

    // stop without done
    report(home, b, batch.id, 'delivered')
    report(home, b, batch.id, 'stop', 'última mensagem')
    await waitUntil(() => events.at(-1)!.state === 'paused', 5_000, 'batch paused')
    const eb = events.at(-1)!.entries.find((e) => e.slotId === b)!
    assert.equal(eb.state, 'stopped-silent')
    assert.equal(eb.note, 'última mensagem')
    assert.ok(!existsSync(slotPauseRequestPath(home, b)))
    assert.equal((await rec.client.request({ t: 'pause-get' })).pause!.state, 'paused')
    assert.equal(JSON.parse(readFileSync(pausePath(home), 'utf8')).state, 'paused')
  })

  test('lines of another batch or before the request are ignored', async () => {
    const { home, rec, events } = await boot()
    const a = await shell(rec, home, 'a')
    appendFileSync(slotPauseReportPath(home, a), JSON.stringify({ ts: '2020-01-01T00:00:00.000Z', batchId: 'old', kind: 'done', text: 'x' }) + '\n')
    const batch = (await rec.client.request({ t: 'pause-start', slotIds: [a] })).pause!
    report(home, a, 'other-batch', 'done', 'y')
    await sleep(500)
    assert.equal((await rec.client.request({ t: 'pause-get' })).pause!.entries[0]!.state, 'listening')
    assert.equal(events.at(-1)!.id, batch.id)
  })

  test('a restarted daemon reloads the batch and rewrites the request of listening entries', async () => {
    const first = await boot()
    const a = await shell(first.rec, first.home, 'a')
    const b = await shell(first.rec, first.home, 'b')
    const batch = (await first.rec.client.request({ t: 'pause-start', slotIds: [a, b] })).pause!
    report(first.home, b, batch.id, 'delivered')
    report(first.home, b, batch.id, 'done', 'nota')
    await waitUntil(() => first.events.some((x) => x.entries.find((e) => e.slotId === b)!.state === 'stopped'), 5_000, 'b stopped')
    const before = JSON.parse(readFileSync(pausePath(first.home), 'utf8')) as PauseBatch
    await first.daemon.close()
    rmSync(slotPauseRequestPath(first.home, a), { force: true })

    const second = await boot(first.home)
    const got = (await second.rec.client.request({ t: 'pause-get' })).pause!
    assert.deepEqual(got, before)
    assert.equal(got.id, batch.id)
    assert.deepEqual(got.entries.map((e) => e.state), ['listening', 'stopped'])
    assert.equal(JSON.parse(readFileSync(slotPauseRequestPath(first.home, a), 'utf8')).batchId, batch.id)
    assert.ok(!existsSync(slotPauseRequestPath(first.home, b)), 'stopped entry gets no request')
    // and it keeps folding reports after the reboot
    report(first.home, a, batch.id, 'done', 'depois do reboot')
    await waitUntil(() => second.events.some((x) => x.state === 'paused'), 5_000, 'paused after reboot')
  })
})

describe('pause: remove, cancel, resume', () => {
  /** Starts a batch over `ids` and brings each to `stopped` with a note. */
  async function stopped(rec: Recorder, home: string, events: PauseBatch[], ids: string[]): Promise<PauseBatch> {
    const batch = (await rec.client.request({ t: 'pause-start', slotIds: ids })).pause!
    for (const id of ids) {
      report(home, id, batch.id, 'delivered')
      report(home, id, batch.id, 'done', `nota de ${id}`)
    }
    await waitUntil(() => events.at(-1)!.state === 'paused', 5_000, 'batch paused')
    return batch
  }

  test('remove takes an entry out, clears its request; the last removal closes the batch; no batch = no-pause', async () => {
    const { home, rec, events } = await boot()
    const a = await shell(rec, home, 'a')
    const b = await shell(rec, home, 'b')
    await assert.rejects(rec.client.request({ t: 'pause-remove', slotId: a }), isErr('no-pause'))
    const batch = (await rec.client.request({ t: 'pause-start', slotIds: [a, b] })).pause!
    await assert.rejects(rec.client.request({ t: 'pause-remove', slotId: 'nope' }), isErr('unknown-slot'))

    const after = (await rec.client.request({ t: 'pause-remove', slotId: a })).pause!
    assert.equal(after.entries.find((e) => e.slotId === a)!.state, 'removed')
    assert.ok(!existsSync(slotPauseRequestPath(home, a)))
    assert.ok(existsSync(slotPauseRequestPath(home, b)))
    assert.equal(JSON.parse(readFileSync(pausePath(home), 'utf8')).entries[0].state, 'removed')
    await assert.rejects(rec.client.request({ t: 'pause-remove', slotId: a }), isErr('bad-request'))

    const last = (await rec.client.request({ t: 'pause-remove', slotId: b })).pause!
    assert.equal(last.state, 'closed')
    assert.equal(last.id, batch.id)
    assert.equal((await rec.client.request({ t: 'pause-get' })).pause, null)
    assert.equal(events.at(-1)!.state, 'closed')
  })

  test('cancel deletes every request and closes the batch', async () => {
    const { home, rec, events } = await boot()
    const a = await shell(rec, home, 'a')
    const b = await shell(rec, home, 'b')
    await assert.rejects(rec.client.request({ t: 'pause-cancel' }), isErr('no-pause'))
    const batch = (await rec.client.request({ t: 'pause-start', slotIds: [a, b] })).pause!
    report(home, a, batch.id, 'done', 'x')
    await waitUntil(() => states(events, a).includes('stopped'), 5_000, 'a stopped')
    const res = (await rec.client.request({ t: 'pause-cancel' })).pause!
    assert.equal(res.state, 'closed')
    assert.ok(!existsSync(slotPauseRequestPath(home, a)) && !existsSync(slotPauseRequestPath(home, b)))
    assert.equal((await rec.client.request({ t: 'pause-get' })).pause, null)
    assert.equal(JSON.parse(readFileSync(pausePath(home), 'utf8')).state, 'closed')
    assert.equal(events.at(-1)!.state, 'closed')
    await assert.rejects(rec.client.request({ t: 'pause-resume' }), isErr('no-pause'))
    // a new batch is allowed again
    assert.equal((await rec.client.request({ t: 'pause-start', slotIds: [a] })).pause!.state, 'pausing')
  })

  test('resume types the note then Enter into idle slots, skips a busy one, and closes the batch when none is left', async () => {
    const { home, rec, events } = await boot()
    const a = await shell(rec, home, 'a', true)
    const b = await shell(rec, home, 'b', true)
    for (const id of [a, b]) await rec.client.request({ t: 'attach', slotId: id, cols: 100, rows: 30 })
    const batch = await stopped(rec, home, events, [a, b])
    // b becomes mid-turn (the hook says a turn started)
    writeFileSync(slotAttentionPath(home, b), JSON.stringify({ ts: new Date().toISOString(), kind: 'start' }))
    await rec.state(b, (s) => s.turn === 'busy', 5_000, 'busy')

    const res = (await rec.client.request({ t: 'pause-resume' })).pause!
    assert.equal(res.id, batch.id)
    assert.equal(res.state, 'resuming')
    await waitUntil(() => events.at(-1)!.state === 'closed', 8_000, 'batch closed')

    const last = events.at(-1)!
    assert.equal(last.state, 'closed')
    assert.equal(last.entries.find((e) => e.slotId === a)!.state, 'resumed')
    const eb = last.entries.find((e) => e.slotId === b)!
    assert.equal(eb.state, 'resume-skipped')
    assert.match(eb.skipReason!, /ocupado/)
    // the shell echoes the typed line (it may wrap at the terminal width, so match the parts)
    await rec.see(a, /Retomando a pausa/, 10_000)
    await rec.see(a, /nota de/, 10_000)
    assert.ok(!rec.text(b).includes('Retomando a pausa'), 'busy slot got nothing')
    assert.equal((await rec.client.request({ t: 'pause-get' })).pause, null)
  })

  test('resume with slotIds only takes those; the batch goes back to paused with the rest', async () => {
    const { home, rec, events } = await boot()
    const a = await shell(rec, home, 'a', true)
    const b = await shell(rec, home, 'b', true)
    for (const id of [a, b]) await rec.client.request({ t: 'attach', slotId: id, cols: 100, rows: 30 })
    await stopped(rec, home, events, [a, b])
    await assert.rejects(rec.client.request({ t: 'pause-resume', slotIds: ['nope'] }), isErr('bad-request'))
    await rec.client.request({ t: 'pause-resume', slotIds: [a] })
    await waitUntil(() => events.at(-1)!.entries.find((e) => e.slotId === a)!.state === 'resumed' && events.at(-1)!.state === 'paused', 8_000, 'a resumed, batch paused')
    assert.equal(events.at(-1)!.entries.find((e) => e.slotId === b)!.state, 'stopped')
    assert.ok(!rec.text(b).includes('Retomando a pausa'))
  })
})
