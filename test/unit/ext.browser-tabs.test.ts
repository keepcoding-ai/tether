// The browser extension's tab rules (extensions/browser/tab-rules.ts): the record, the addresses a tab may open, the ones
// layout.json may keep, where a new tab goes among its owner's, and the cookie-encryption fuse read from the wire.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { cookieEncryptionOn, FUSE_SENTINEL, fuseWireAt, insertIndex, isNavigable, isWebUrl, makeTab, savedOf, savedTabOf, storableUrl } from '../../extensions/browser/tab-rules.ts'
import { ownerLabel } from '../../extensions/browser/rules.ts'

describe('browser: tab rules', () => {
  test('only http and https open; the blank page is a navigation, not a tab address', () => {
    assert.ok(isWebUrl('https://example.com/a?b=1'))
    assert.ok(isWebUrl('http://127.0.0.1:5173/'))
    for (const u of ['file:///C:/x', 'data:text/html,hi', 'javascript:alert(1)', 'chrome://gpu', 'devtools://x', 'about:blank', 'nonsense', '', 42, undefined]) assert.equal(isWebUrl(u), false, String(u))
    assert.ok(isNavigable('about:blank'))
    assert.equal(isNavigable('file:///etc/passwd'), false)
  })

  test('makeTab validates ids, owner and address, and cleans the title', () => {
    const t = makeTab({ tabId: 't1', ownerSlotId: 'slot-a', surfaceId: 's', url: 'https://a.test/', title: ' A\nB ', createdAt: 5 })
    assert.deepEqual(t, { tabId: 't1', ownerSlotId: 'slot-a', surfaceId: 's', url: 'https://a.test/', title: 'A B', createdAt: 5 })
    assert.equal(makeTab({ tabId: 't 1', ownerSlotId: 'a', surfaceId: 's', url: 'https://a.test/', createdAt: 0 }), undefined)
    assert.equal(makeTab({ tabId: 't1', ownerSlotId: '../x', surfaceId: 's', url: 'https://a.test/', createdAt: 0 }), undefined)
    assert.equal(makeTab({ tabId: 't1', ownerSlotId: 'a', surfaceId: 's', url: 'file:///x', createdAt: 0 }), undefined)
  })

  test('an address with a credential is never storable', () => {
    assert.ok(storableUrl('https://a.test/path?q=cats&page=2#top'))
    for (const u of ['https://user:pw@a.test/', 'https://user@a.test/', 'https://a.test/?token=x', 'https://a.test/?access_token=x', 'https://a.test/?Api-Key=x',
      'https://a.test/cb#access_token=x&state=1', 'https://a.test/?X-Amz-Signature=abc', 'https://a.test/?password=1', 'file:///x']) assert.equal(storableUrl(u), false, u)
  })

  test('savedOf drops the credential address; savedTabOf reads params back, defensively', () => {
    assert.deepEqual(savedOf({ tabId: 't', ownerSlotId: 'o', url: 'https://a.test/', title: 'A' }), { tabId: 't', ownerSlotId: 'o', url: 'https://a.test/', title: 'A' })
    assert.deepEqual(savedOf({ tabId: 't', ownerSlotId: 'o', url: 'https://a.test/?token=1', title: 'A' }), { tabId: 't', ownerSlotId: 'o', title: 'A' })
    assert.deepEqual(savedTabOf({ tabId: 't', ownerSlotId: 'o', url: 'https://u:p@a.test/', title: 'A' }), { tabId: 't', ownerSlotId: 'o', title: 'A' })
    assert.deepEqual(savedTabOf({ tabId: 't', ownerSlotId: 'o', url: 'https://a.test/', title: 7 }), { tabId: 't', ownerSlotId: 'o', url: 'https://a.test/', title: '' })
    for (const p of [undefined, null, 'x', {}, { tabId: 't' }, { tabId: 't', ownerSlotId: 'a b' }]) assert.equal(savedTabOf(p), undefined)
  })

  test('a new tab goes right after its owner\'s last tab, a new owner at the end', () => {
    assert.equal(insertIndex([], 'a'), 0)
    assert.equal(insertIndex(['a', 'a', 'b'], 'a'), 2)
    assert.equal(insertIndex(['a', 'b', 'b', 'c'], 'b'), 3)
    assert.equal(insertIndex(['a', undefined, 'b'], 'c'), 3)
  })

  test('the fuse wire: cookie encryption is byte 1 after version and length; anything else counts as off', () => {
    const wire = (fuses: string, version = 1): Uint8Array => new Uint8Array([...Buffer.from('xx' + FUSE_SENTINEL, 'latin1'), version, fuses.length, ...Buffer.from(fuses, 'latin1'), 0])
    const on = wire('01010')
    assert.deepEqual(fuseWireAt(on, 2), [0x30, 0x31, 0x30, 0x31, 0x30])
    assert.ok(cookieEncryptionOn(fuseWireAt(on, 2)))
    assert.equal(cookieEncryptionOn(fuseWireAt(wire('00010'), 2)), false)
    assert.equal(cookieEncryptionOn(fuseWireAt(wire('0r010'), 2)), false)
    assert.equal(fuseWireAt(wire('01', 2), 2), undefined, 'unknown wire version')
    assert.equal(fuseWireAt(on.subarray(0, 2 + FUSE_SENTINEL.length + 3), 2), undefined, 'cut wire')
    assert.equal(cookieEncryptionOn(undefined), false)
  })

  test('owner label', () => {
    assert.equal(ownerLabel({ name: 'Claude', alive: true }, 's'), 'Claude')
    assert.equal(ownerLabel({ name: 'Claude', alive: false }, 's'), 'Claude encerrado')
    assert.equal(ownerLabel(undefined, 's'), 'Agente')
  })
})

test('tab rules (E7c, H3): a tab opens at most 3 popups per 10 s, an owner has at most 30 tabs', async () => {
  const { popupVerdict, POPUPS_PER_WINDOW, POPUP_WINDOW_MS, TABS_PER_OWNER } = await import('../../extensions/browser/tab-rules.ts')
  const recent: number[] = []
  for (let i = 0; i < POPUPS_PER_WINDOW; i++) assert.equal(popupVerdict(recent, 1000 + i, 1 + i), 'ok')
  assert.equal(popupVerdict(recent, 1100, 4), 'rate', 'the fourth inside the window')
  assert.equal(recent.length, POPUPS_PER_WINDOW, 'a refused popup takes no place in the bucket')
  assert.equal(popupVerdict(recent, 1000 + POPUP_WINDOW_MS, 4), 'ok', 'the oldest left the window')
  assert.equal(popupVerdict([], 0, TABS_PER_OWNER), 'owner')
  assert.equal(popupVerdict([], 0, TABS_PER_OWNER - 1), 'ok')
})
