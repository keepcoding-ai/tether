// Notices: appended one JSON line each to the slot's file, one line of text, capped; text from another agent quoted.
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { test } from 'node:test'
import { slotNoticesPath } from '../../src/core/paths.ts'
import { noticeLine, quoted, QUOTED_MAX } from '../../src/daemon/notices.ts'
import { pendingNotices } from '../../src/daemon/notices-read.ts'
import { removeHome, tempHome } from './daemon.helpers.ts'

test('noticeLine makes {ts, text} lines; newlines flattened; long text cut', async () => {
  const home = tempHome()
  try {
    const leave = (text: string, now?: Date): void => { const p = slotNoticesPath(home, 's1'); mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, noticeLine(text, now)) }
    leave('primeiro\nrecado', new Date('2026-11-11T12:00:00Z'))
    leave('x'.repeat(2000))
    const lines = readFileSync(slotNoticesPath(home, 's1'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    assert.deepEqual(JSON.parse(lines[0]!), { ts: '2026-11-11T12:00:00.000Z', text: 'primeiro recado' })
    const all = pendingNotices(home, 's1')
    assert.ok(all[1]!.text.length < 600)
    assert.ok(all[1]!.text.endsWith('…'))
    assert.deepEqual(pendingNotices(home, 'outro'), [])
  } finally { await removeHome(home) }
})

test('quoted: one line between quotes, inner quotes softened, capped', () => {
  assert.equal(quoted('corrigi\no "parser"'), `"corrigi o 'parser'"`)
  const long = quoted('a'.repeat(QUOTED_MAX + 10))
  assert.equal(long.length, QUOTED_MAX + 3)
})
