// The tether:// link (app/shared/tether-url.ts): build, parse, refuse what is unsafe.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { noteUrl, parseTetherUrl, tabUrl, tetherUrlInArgv } from '../../app/shared/tether-url.ts'

describe('tether:// links', () => {
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
