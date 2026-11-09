// The app's links core (app/shared/links.ts): the one policy every surface (terminal, note editor, preview) follows.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { detectWebLinks, followLinkTip, isExternalUrl, isFollowModifier, parsePositionFragment, positionFragment } from '../../app/shared/links.ts'

describe('links core', () => {
  test('isExternalUrl: http(s) with a host only', () => {
    assert.equal(isExternalUrl('https://a.example/x'), true)
    assert.equal(isExternalUrl('HTTP://a.example'), true)
    assert.equal(isExternalUrl('https://'), false)
    assert.equal(isExternalUrl('javascript:alert(1)'), false)
    assert.equal(isExternalUrl('file:///C:/x'), false)
    assert.equal(isExternalUrl('mailto:a@b.example'), false)
  })

  test('detectWebLinks: ranges, and closing punctuation left out', () => {
    assert.deepEqual(detectWebLinks('veja https://a.example/x?y=1.'), [{ start: 5, end: 28, url: 'https://a.example/x?y=1' }])
    assert.deepEqual(detectWebLinks('(https://a.example) e http://b.example/c'), [
      { start: 1, end: 18, url: 'https://a.example' },
      { start: 22, end: 40, url: 'http://b.example/c' },
    ])
    assert.deepEqual(detectWebLinks('sem link aqui'), [])
  })

  test('the follow modifier and the tip are the same on every surface', () => {
    assert.equal(followLinkTip(false), 'Seguir link (Ctrl + clique)')
    assert.equal(followLinkTip(true), 'Seguir link (Cmd + clique)')
    assert.equal(isFollowModifier({ ctrlKey: true, metaKey: false }, false), true)
    assert.equal(isFollowModifier({ ctrlKey: true, metaKey: false }, true), false)
    assert.equal(isFollowModifier({ ctrlKey: false, metaKey: true }, true), true)
  })

  test('position fragment round-trip', () => {
    assert.equal(positionFragment(undefined), '')
    assert.equal(positionFragment({ line: 12 }), 'L12')
    assert.equal(positionFragment({ line: 12, column: 5 }), 'L12,5')
    assert.deepEqual(parsePositionFragment('L12'), { line: 12 })
    assert.deepEqual(parsePositionFragment('L12,5'), { line: 12, column: 5 })
    assert.deepEqual(parsePositionFragment('L12C5'), { line: 12, column: 5 })
    assert.equal(parsePositionFragment('L0'), undefined)
    assert.equal(parsePositionFragment('x'), undefined)
  })
})
