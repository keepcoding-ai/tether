import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SlotMeta } from '../../src/core/event.ts'
import { exportSlots, importSlots } from '../../src/core/sync/codecs/slots.ts'

const WIN = { platform: 'win32', homedir: 'C:\\Users\\ana' } as const
const POSIX = { platform: 'linux', homedir: '/home/bob' } as const
const SECRET = 's3cr3t-value'

function meta(slotId: string, over: Partial<SlotMeta> = {}): SlotMeta {
  return { v: 1, slotId, agent: 'claude', cwd: 'C:\\work\\proj\\app', args: [], createdAt: '2026-01-01T00:00:00.000Z', ...over }
}

test('only slots in keep travel; forbidden fields and absolute cwd never appear', () => {
  const full = meta('a', {
    name: 'Alpha', profileId: 'p1', profileArgs: ['--x'], profileEnv: { TOKEN: SECRET },
    endedAt: 'z', createdBy: { ext: 'e' }, paneRequest: { deskId: 'd' }, held: { ext: 'e', by: 'b' }, attentionTo: 'q',
  })
  const r = exportSlots([full, meta('b')], new Set(['a']), { work: 'C:\\work' }, WIN)
  assert.deepEqual(Object.keys(r.entities.slots!), ['a'])
  const json = JSON.stringify(r.entities)
  for (const bad of ['profileEnv', 'profileArgs', 'held', 'endedAt', 'createdBy', 'paneRequest', 'attentionTo', SECRET, 'C:\\\\work', '"v"']) {
    assert.ok(!json.includes(bad), bad)
  }
  assert.deepEqual((r.entities.slots!.a as { cwd: unknown }).cwd, { place: 'work', rel: 'proj/app' })
  assert.deepEqual(exportSlots([], new Set(), {}, WIN).entities, { slots: {} })
})

test('optional fields stay absent', () => {
  const r = exportSlots([meta('a')], new Set(['a']), {}, WIN)
  const s = r.entities.slots!.a as Record<string, unknown>
  assert.ok(!('name' in s) && !('profileId' in s))
})

test('two machines: export win32, import posix with another map', () => {
  const ex = exportSlots([meta('a', { name: 'Alpha', profileId: 'p' })], new Set(['a']), { work: 'C:\\work' }, WIN)
  const im = importSlots(ex.entities, [], { work: '/srv/w' }, POSIX)
  assert.equal(im.create.length, 1)
  assert.deepEqual(im.create[0], {
    v: 1, slotId: 'a', agent: 'claude', cwd: '/srv/w/proj/app', args: [], createdAt: '2026-01-01T00:00:00.000Z', name: 'Alpha', profileId: 'p',
  })
})

test('place without a map goes to pending', () => {
  const ex = exportSlots([meta('a')], new Set(['a']), { work: 'C:\\work' }, WIN)
  const im = importSlots(ex.entities, [], {}, POSIX)
  assert.deepEqual(im.create, [])
  assert.deepEqual(im.pending, [{ slotId: 'a', place: 'work' }])
})

test('existing slot is never created or overwritten; rename only when the name differs', () => {
  const ex = exportSlots([meta('a', { name: 'New' }), meta('b', { name: 'Same' }), meta('c')], new Set(['a', 'b', 'c']), { work: 'C:\\work' }, WIN)
  const local = [meta('a', { name: 'Old', cwd: '/mine' }), meta('b', { name: 'Same' }), meta('c', { name: 'Named' }), meta('z')]
  const im = importSlots(ex.entities, local, { work: '/srv/w' }, POSIX)
  assert.deepEqual(im.create, [])
  assert.deepEqual(im.rename, [{ slotId: 'a', name: 'New' }, { slotId: 'c', name: undefined }])
  assert.deepEqual(im.skipped, [])
})

test('leaks flag absolute-path args, not flags', () => {
  const m = meta('a', { args: ['-a', '--model', 'opus', '/c', 'C:\\x\\y', 'D:/q', '/home/x', '--dir=/home/x'] })
  const r = exportSlots([m], new Set(['a']), {}, WIN)
  assert.deepEqual(r.leaks, ['slots/a/args[4]', 'slots/a/args[5]', 'slots/a/args[6]'])
  assert.deepEqual((r.entities.slots!.a as { args: string[] }).args, m.args)
})

test('relative cwd and invalid id are skipped', () => {
  const r = exportSlots([meta('a', { cwd: 'rel/dir' }), meta('Bad Id'), meta('ok')], new Set(['a', 'Bad Id', 'ok']), {}, WIN)
  assert.deepEqual(r.skipped, ['a', 'Bad Id'])
  assert.deepEqual(Object.keys(r.entities.slots!), ['ok'])
})

test('malformed entities are skipped; outputs sorted', () => {
  const good = (id: string) => ({ slotId: id, agent: 'claude', cwd: { place: 'work', rel: '' }, args: [], createdAt: 't' })
  const im = importSlots({
    slots: {
      z: good('z'), a: good('a'),
      mismatch: good('other'), noagent: { ...good('noagent'), agent: '' }, badargs: { ...good('badargs'), args: [1] },
      badcwd: { ...good('badcwd'), cwd: { place: 'work' } }, junk: 'x',
    },
  }, [], { work: '/w' }, POSIX)
  assert.deepEqual(im.create.map((m) => m.slotId), ['a', 'z'])
  assert.deepEqual(im.skipped, ['badargs', 'badcwd', 'junk', 'mismatch', 'noagent'])
})

test('the received map is not mutated', () => {
  const map = { work: 'C:\\work' }
  const r = exportSlots([meta('a', { cwd: 'C:\\other\\x' })], new Set(['a']), map, WIN)
  assert.deepEqual(map, { work: 'C:\\work' })
  assert.ok(Object.keys(r.map).length === 2)
})
