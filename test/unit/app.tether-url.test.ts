// The tether:// link (app/shared/tether-url.ts): build, parse, refuse what is unsafe.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { isSyncNowUrl, noteUrl, parseTetherUrl, SYNC_NOW_URL, tabUrl, tetherUrlInArgv } from '../../app/shared/tether-url.ts'
import { SYNC_LINK } from '../../src/cli/sync.ts'

describe('tether:// links', () => {
  test('tether://sync/now: the CLI\'s link, recognized by main and never a place for the renderer', () => {
    assert.equal(SYNC_NOW_URL, SYNC_LINK)
    assert.equal(isSyncNowUrl(SYNC_LINK), true)
    assert.equal(isSyncNowUrl('TETHER://SYNC/NOW/'), true)
    assert.equal(parseTetherUrl(SYNC_LINK), undefined)
    assert.equal(isSyncNowUrl('tether://sync/now?x=1'), false)
    assert.equal(isSyncNowUrl('tether://sync/now/more'), false)
    assert.equal(isSyncNowUrl('tether://sync'), false)
    assert.equal(isSyncNowUrl('https://sync/now'), false)
    assert.equal(tetherUrlInArgv(['electron', '.', SYNC_LINK]), SYNC_LINK)
  })

  test('a pane, round-trip', () => {
    assert.equal(tabUrl('1a2b3c4d'), 'tether://tab/1a2b3c4d')
    assert.deepEqual(parseTetherUrl(tabUrl('1a2b3c4d')), { kind: 'tab', id: '1a2b3c4d' })
    assert.deepEqual(parseTetherUrl(tabUrl('note-0abc-12xy')), { kind: 'tab', id: 'note-0abc-12xy' })
    assert.deepEqual(parseTetherUrl('TETHER://TAB/1a2b3c4d/'), { kind: 'tab', id: '1a2b3c4d' })
  })

  test('a note, round-trip with spaces and accents', () => {
    const p = String.raw`D:\atrium\.tether\notes\minha nota ção.md`
    assert.deepEqual(parseTetherUrl(noteUrl(p)), { kind: 'note', path: p })
    assert.deepEqual(parseTetherUrl(noteUrl('/home/u/n.md')), { kind: 'note', path: '/home/u/n.md' })
  })

  test('refused: other schemes, unknown places, unsafe ids and paths', () => {
    assert.equal(parseTetherUrl('https://tab/1a2b'), undefined)
    assert.equal(parseTetherUrl('tether://run/x'), undefined)
    assert.equal(parseTetherUrl('tether://tab/'), undefined)
    assert.equal(parseTetherUrl('tether://tab/..%2F..%2Fx'), undefined)
    assert.equal(parseTetherUrl('tether://tab/a b'), undefined)
    assert.equal(parseTetherUrl(noteUrl(String.raw`rel\a.md`)), undefined)
    assert.equal(parseTetherUrl(noteUrl(String.raw`\\host\share\a.md`)), undefined)
    assert.equal(parseTetherUrl(noteUrl('//host/share/a.md')), undefined)
    assert.equal(parseTetherUrl('tether://note'), undefined)
  })

  test('found among the arguments the OS passes', () => {
    assert.equal(tetherUrlInArgv(['electron.exe', 'main.cjs', 'tether://tab/1a2b3c4d']), 'tether://tab/1a2b3c4d')
    assert.equal(tetherUrlInArgv(['electron.exe', '--x']), undefined)
  })
})

describe('tether:// note links into a pad', () => {
  const p = String.raw`D:\work\.tether\notes\todo.md`

  test('round-trip with the pad scope and the owning pane', () => {
    assert.equal(noteUrl(p), `tether://note?path=${encodeURIComponent(p)}`)
    assert.deepEqual(parseTetherUrl(noteUrl(p, { scope: 'panel', slot: '1a2b3c4d' })), { kind: 'note', path: p, pad: { scope: 'panel', slot: '1a2b3c4d' } })
    assert.deepEqual(parseTetherUrl(noteUrl(p, { scope: 'global' })), { kind: 'note', path: p, pad: { scope: 'global' } })
    assert.deepEqual(parseTetherUrl(noteUrl(p)), { kind: 'note', path: p })
  })

  test('refused: an unknown scope, an unsafe slot, a slot with no pad', () => {
    assert.equal(parseTetherUrl(`${noteUrl(p)}&pad=drawer`), undefined)
    assert.equal(parseTetherUrl(`${noteUrl(p)}&pad=panel&slot=..%2Fx`), undefined)
    assert.equal(parseTetherUrl(`${noteUrl(p)}&slot=1a2b3c4d`), undefined)
  })
})
