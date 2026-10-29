// Pure pieces of the CLI: argv parsing, slot reference resolution, relative times and the table.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseArgs, UsageError } from '../../src/cli/args.ts'
import { relativeTime, shortId, statusLabel, table, truncateStart } from '../../src/cli/format.ts'
import { resolveSlot, SlotNotFound } from '../../src/cli/slots.ts'

describe('cli: parseArgs', () => {
  test('positionals, valued options (both spellings), flags and the `--` tail', () => {
    const p = parseArgs(['claude', '--name', 'api', '--cwd=D:\\x', '--here', '--', '-c', '--model', 'haiku'], { valued: ['name', 'cwd'], flags: ['here'] })
    assert.deepEqual(p.positional, ['claude'])
    assert.deepEqual(p.options, { name: 'api', cwd: 'D:\\x' })
    assert.ok(p.flags.has('here'))
    assert.deepEqual(p.rest, ['-c', '--model', 'haiku'])
  })
  test('unknown option, missing value and a value on a flag are usage errors', () => {
    assert.throws(() => parseArgs(['--nope']), UsageError)
    assert.throws(() => parseArgs(['--name'], { valued: ['name'] }), /precisa de um valor/)
    assert.throws(() => parseArgs(['--json=1'], { flags: ['json'] }), /não aceita valor/)
  })
})

describe('cli: resolveSlot', () => {
  const slots = [
    { slotId: 'ab12cd34', name: 'api' },
    { slotId: 'ab99ff00', name: 'dup' },
    { slotId: 'ff00ab12', name: 'dup' },
  ]
  test('exact id, unique name, unique prefix', () => {
    assert.equal(resolveSlot(slots, 'ab12cd34').slotId, 'ab12cd34')
    assert.equal(resolveSlot(slots, 'api').slotId, 'ab12cd34')
    assert.equal(resolveSlot(slots, 'ff').slotId, 'ff00ab12')
  })
  test('ambiguous name, ambiguous prefix, unknown', () => {
    assert.throws(() => resolveSlot(slots, 'dup'), /nome ambíguo/)
    assert.throws(() => resolveSlot(slots, 'ab'), /prefixo ambíguo "ab": ab12cd34, ab99ff00/)
    assert.throws(() => resolveSlot(slots, 'zz'), SlotNotFound)
  })
})

describe('cli: format', () => {
  test('relative times in Portuguese', () => {
    const now = Date.parse('2026-10-29T12:00:00Z')
    assert.equal(relativeTime('2026-10-29T11:59:40Z', now), 'agora')
    assert.equal(relativeTime('2026-10-29T11:55:00Z', now), 'há 5 min')
    assert.equal(relativeTime('2026-10-29T10:00:00Z', now), 'há 2 h')
    assert.equal(relativeTime('2026-10-26T12:00:00Z', now), 'há 3 d')
    assert.equal(relativeTime(undefined, now), '-')
    assert.equal(relativeTime('banana', now), '?')
  })
  test('ids, status words, path truncation keeps the end', () => {
    assert.equal(shortId('0b6f1234-aaaa-bbbb'), '0b6f1234…')
    assert.equal(shortId(undefined), '-')
    assert.equal(statusLabel('unconfirmed'), 'não confirmado')
    assert.equal(truncateStart('D:\\sources\\localhost\\agentic-terminal', 12), '…ic-terminal')
  })
  test('table: columns padded to the widest cell, no trailing spaces', () => {
    const t = table(['A', 'BB'], [['xxx', 'y'], ['z', 'longer']])
    assert.equal(t, 'A    BB\nxxx  y\nz    longer\n')
  })
})
