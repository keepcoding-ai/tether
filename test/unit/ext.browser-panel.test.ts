// The browser extension's panel rules (E9): the owner's stable colour, the short name and the chip, the address cut, the
// letterbox bands, and which icon a tab may take from the page.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { displayUrl, hasBands, ownerChip, ownerHue, shortName, ADDRESS_MAX, SHORT_NAME_MAX } from '../../extensions/browser/rules.ts'
import { faviconPlan, FAVICON_MAX } from '../../extensions/browser/tab-rules.ts'

describe('browser: panel rules', () => {
  test('the owner hue is stable, in range, and spreads over different slots', () => {
    assert.equal(ownerHue('slot-a'), ownerHue('slot-a'))
    const ids = Array.from({ length: 40 }, (_, i) => `slot-${i}-${i * 7919}`)
    const hues = ids.map(ownerHue)
    for (const h of hues) assert.ok(Number.isInteger(h) && h >= 0 && h < 360, String(h))
    assert.ok(new Set(hues).size >= 30, `spread: ${new Set(hues).size} distinct hues of 40`)
    // Pinned values: the colour of an owner never changes between versions.
    assert.deepEqual(['a', 'slot-1', '0f8d2c3e-aaaa'].map(ownerHue), [340, 263, 43])
  })

  test('the short name is one line and bounded; the chip says "encerrado" and is dimmed once the agent ended', () => {
    assert.equal(shortName('  Claude\n code '), 'Claude code')
    assert.equal(shortName(undefined), 'Agente')
    assert.equal(shortName('   '), 'Agente')
    const long = shortName('Um agente com um nome muito comprido mesmo')
    assert.ok(long.length <= SHORT_NAME_MAX && long.endsWith('…'), long)
    assert.deepEqual(ownerChip({ name: 'Sonda', alive: true }), { text: 'Sonda', ended: false, known: true })
    assert.deepEqual(ownerChip({ name: 'Sonda', alive: false }), { text: 'Sonda encerrado', ended: true, known: true })
    assert.deepEqual(ownerChip(undefined), { text: 'Agente', ended: false, known: false })
  })

  test('the address is cut: short ones whole, long ones keep start and end, data: never whole', () => {
    assert.equal(displayUrl('https://a.test/x?y=1'), 'https://a.test/x?y=1')
    const long = `https://a.test/${'p'.repeat(400)}?end=1`
    const cut = displayUrl(long)
    assert.ok(cut.length <= ADDRESS_MAX, String(cut.length))
    assert.ok(cut.startsWith('https://a.test/') && cut.endsWith('?end=1') && cut.includes('…'))
    const data = `data:text/html;base64,${'QUJD'.repeat(50_000)}`
    const d = displayUrl(data)
    assert.ok(d.length < 50 && d.startsWith('data:text/html;base64') && d.endsWith('…'), d)
    assert.equal(displayUrl('data:,x'), 'data:,x')
    assert.equal(displayUrl(''), '')
  })

  test('the bands show when the fitted page is smaller than its area; never when it fills it', () => {
    assert.equal(hasBands({ width: 1600, height: 900 }, { width: 1440, height: 900 }), true)
    assert.equal(hasBands({ width: 1280, height: 800 }, { width: 1280, height: 800 }), false)
    assert.equal(hasBands({ width: 1280, height: 800 }, undefined), false)
  })

  test('the icon: data:image as it comes (bounded); the page\'s own origin fetched; another origin never', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo='
    assert.deepEqual(faviconPlan('https://a.test/p', [png]), { kind: 'data', url: png })
    assert.deepEqual(faviconPlan('https://a.test/p', ['https://a.test/favicon.ico']), { kind: 'fetch', url: 'https://a.test/favicon.ico' })
    assert.equal(faviconPlan('https://a.test/p', ['https://cdn.other.test/i.png']), undefined)
    assert.equal(faviconPlan('https://a.test/p', ['http://a.test/favicon.ico']), undefined, 'another scheme is another origin')
    assert.equal(faviconPlan('https://a.test/p', ['data:text/html,<script>1</script>', 'javascript:1', 'file:///x', 42]), undefined)
    assert.equal(faviconPlan('https://a.test/p', [`data:image/png;base64,${'A'.repeat(FAVICON_MAX)}`]), undefined)
    assert.deepEqual(faviconPlan('https://a.test/p', ['https://cdn.other.test/i.png', 'https://a.test/i.png']), { kind: 'fetch', url: 'https://a.test/i.png' })
    assert.equal(faviconPlan('about:blank', ['https://a.test/i.png']), undefined)
  })
})
