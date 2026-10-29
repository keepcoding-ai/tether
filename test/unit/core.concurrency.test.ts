// Several processes appending to the same slot file (and to different slots) at once: no torn lines, exact counts.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { after, before, test } from 'node:test'
import { parseEventLine, readEvents } from '../../src/core/store.ts'

const execFileP = promisify(execFile)
const STORE_URL = pathToFileURL(fileURLToPath(new URL('../../src/core/store.ts', import.meta.url))).href
const PER_WRITER = 500

let home: string
before(() => {
  home = mkdtempSync(join(tmpdir(), 'tether-conc-'))
})
after(() => {
  rmSync(home, { recursive: true, force: true })
})

/** A child node process that appends PER_WRITER events with a chunky payload to `slotId`, tagged with `writer`. */
function writer(slotId: string, writerId: number): Promise<unknown> {
  const script = `
    const { appendEvent } = await import(${JSON.stringify(STORE_URL)})
    const pad = 'x'.repeat(300 + ${writerId} * 37)
    for (let i = 0; i < ${PER_WRITER}; i++) {
      appendEvent(${JSON.stringify(home)}, {
        v: 1, ts: new Date().toISOString(), slotId: ${JSON.stringify(slotId)}, agent: 'claude', kind: 'start',
        source: 'startup', sessionId: 'w${writerId}-' + i, cwd: pad,
        resume: { cwd: pad, args: ['--resume', 'w${writerId}-' + i] },
      })
    }
  `
  return execFileP(process.execPath, ['--input-type=module', '-e', script], { timeout: 60_000 })
}

test('4 writers on the SAME slot: every line parses, counts exact per writer', async () => {
  const slotId = 'samefile'
  await Promise.all([0, 1, 2, 3].map((w) => writer(slotId, w)))
  const events = readEvents(home, slotId)
  assert.equal(events.length, 4 * PER_WRITER)
  const seen = new Map<string, Set<number>>()
  for (const ev of events) {
    const m = /^w(\d)-(\d+)$/.exec(ev.sessionId)
    assert.ok(m, `unexpected sessionId ${ev.sessionId}`)
    const set = seen.get(m![1]!) ?? new Set<number>()
    set.add(Number(m![2]))
    seen.set(m![1]!, set)
    assert.equal(ev.resume?.args[1], ev.sessionId, 'line content is intact')
  }
  for (const w of ['0', '1', '2', '3']) assert.equal(seen.get(w)?.size, PER_WRITER, `writer ${w}`)
})

test('3 writers on DIFFERENT slots: each file has exactly its own events', async () => {
  const slots = ['diff0001', 'diff0002', 'diff0003']
  await Promise.all(slots.map((s, i) => writer(s, i)))
  slots.forEach((s, i) => {
    const events = readEvents(home, s)
    assert.equal(events.length, PER_WRITER)
    assert.ok(events.every((e) => e.slotId === s && e.sessionId.startsWith(`w${i}-`)))
  })
})

test('a torn line (writer killed mid-write) never breaks the lines around it', () => {
  const line = JSON.stringify({ v: 1, ts: 't', slotId: 's', agent: 'claude', kind: 'start', source: 'x', sessionId: 'ok' })
  assert.equal(parseEventLine(line)?.sessionId, 'ok')
  assert.equal(parseEventLine(line.slice(0, 20)), undefined)
  assert.equal(parseEventLine(''), undefined)
  assert.equal(parseEventLine('\r'), undefined)
})
