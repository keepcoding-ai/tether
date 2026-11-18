import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { slotPauseReportPath } from '../../src/core/paths.ts'
import { cmdPause } from '../../src/cli/pause.ts'
import { newEntry, type PauseBatch } from '../../src/daemon/pause.ts'
import { writePauseFile } from '../../src/daemon/pause-sync.ts'

const homes: string[] = []
async function run(home: string, args: string[], env: Record<string, string> = {}) {
  let out = ''
  let err = ''
  try {
    const code = await cmdPause(args, { out: (t) => { out += t }, err: (t) => { err += t }, env: { TETHER_HOME: home, ...env } })
    return { code, out, err }
  } catch (e) {
    return { code: -1, out, err: (e as Error).message }
  }
}
function home(withBatch: boolean): string {
  const h = mkdtempSync(join(tmpdir(), 'tether-pause-'))
  homes.push(h)
  if (withBatch) {
    const now = new Date().toISOString()
    const batch: PauseBatch = { v: 1, id: 'b1', createdAt: now, state: 'pausing', entries: [newEntry('s1', 'claude', now)] }
    batch.entries[0]!.phrase = 'fechando o teste'
    writePauseFile(h, batch)
  }
  return h
}
after(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }) })

describe('tether pause', () => {
  test('ack and done append the right lines', async () => {
    const h = home(true)
    const a = await run(h, ['ack', 'preparando'], { TETHER_SLOT_ID: 's1' })
    assert.equal(a.code, 0)
    assert.match(a.out, /Anotado/)
    const d = await run(h, ['done', 'parei no passo 3', '--slot', 's1'])
    assert.equal(d.code, 0)
    const lines = readFileSync(slotPauseReportPath(h, 's1'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(lines.length, 2)
    assert.deepEqual([lines[0].kind, lines[0].batchId, lines[0].text], ['ack', 'b1', 'preparando'])
    assert.deepEqual([lines[1].kind, lines[1].text], ['done', 'parei no passo 3'])
    assert.ok(!Number.isNaN(Date.parse(lines[0].ts)))
  })
  test('no slot is a friendly error', async () => {
    const r = await run(home(true), ['ack', 'x'])
    assert.equal(r.code, -1)
    assert.match(r.err, /slot/)
  })
  test('empty text is an error', async () => {
    const r = await run(home(true), ['done', '  '], { TETHER_SLOT_ID: 's1' })
    assert.equal(r.code, -1)
    assert.match(r.err, /nota/)
  })
  test('no batch is an error and writes nothing', async () => {
    const h = home(false)
    const r = await run(h, ['ack', 'x'], { TETHER_SLOT_ID: 's1' })
    assert.equal(r.code, 1)
    assert.match(r.err, /não há pausa em andamento/)
    assert.throws(() => readFileSync(slotPauseReportPath(h, 's1')))
  })
  test('status lists entries, json too', async () => {
    const h = home(true)
    const r = await run(h, ['status'])
    assert.equal(r.code, 0)
    assert.match(r.out, /s1/)
    assert.match(r.out, /Na fila/)
    assert.match(r.out, /fechando o teste/)
    const j = await run(h, ['status', '--json'])
    assert.equal(JSON.parse(j.out).id, 'b1')
    assert.match((await run(home(false), ['status'])).out, /Nenhuma pausa/)
  })
})
