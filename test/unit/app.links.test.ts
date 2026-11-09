// The app's links core (app/shared/links.ts): the one policy every surface (terminal, note editor, preview) follows.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { detectUrlLinks, followLinkTip, linkTargetOfUrl, isExternalUrl, isFollowModifier, parsePositionFragment, positionFragment } from '../../app/shared/links.ts'

describe('links core', () => {
  test('isExternalUrl: http(s) with a host only', () => {
    assert.equal(isExternalUrl('https://a.example/x'), true)
    assert.equal(isExternalUrl('HTTP://a.example'), true)
    assert.equal(isExternalUrl('https://'), false)
    assert.equal(isExternalUrl('javascript:alert(1)'), false)
    assert.equal(isExternalUrl('file:///C:/x'), false)
    assert.equal(isExternalUrl('mailto:a@b.example'), false)
  })

  test('detectUrlLinks: ranges, and closing punctuation left out', () => {
    assert.deepEqual(detectUrlLinks('veja https://a.example/x?y=1.'), [{ start: 5, end: 28, url: 'https://a.example/x?y=1' }])
    assert.deepEqual(detectUrlLinks('(https://a.example) e http://b.example/c'), [
      { start: 1, end: 18, url: 'https://a.example' },
      { start: 22, end: 40, url: 'http://b.example/c' },
    ])
    assert.deepEqual(detectUrlLinks('sem link aqui'), [])
    assert.deepEqual(detectUrlLinks('guia: tether://tab/1a2b3c4d.'), [{ start: 6, end: 27, url: 'tether://tab/1a2b3c4d' }])
    assert.deepEqual(detectUrlLinks('tether://nada/x'), [], 'a tether link that names nothing is no link')
  })

  test('linkTargetOfUrl: browser, a place in the app, or nothing', () => {
    assert.deepEqual(linkTargetOfUrl('https://a.example'), { kind: 'external', url: 'https://a.example' })
    assert.deepEqual(linkTargetOfUrl('tether://tab/1a2b3c4d'), { kind: 'tether', url: 'tether://tab/1a2b3c4d' })
    assert.deepEqual(linkTargetOfUrl('javascript:alert(1)'), { kind: 'ignore' })
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
