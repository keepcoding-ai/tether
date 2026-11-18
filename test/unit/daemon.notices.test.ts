// Notices: appended one JSON line each to the slot's file, one line of text, capped; text from another agent quoted.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { slotNoticesPath } from '../../src/core/paths.ts'
import { leaveNotice, quoted, QUOTED_MAX } from '../../src/daemon/notices.ts'
import { pendingNotices } from '../../src/daemon/notices-read.ts'
import { removeHome, tempHome } from './daemon.helpers.ts'

test('leaveNotice appends {ts, text} lines; newlines flattened; long text cut', async () => {
  const home = tempHome()
  try {
    leaveNotice(home, 's1', 'primeiro\nrecado', new Date('2026-11-11T12:00:00Z'))
    leaveNotice(home, 's1', 'x'.repeat(2000))
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
