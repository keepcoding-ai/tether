// `#name` of an existing channel as a link, and tether://channel/<id> (app/shared/links.ts, tether-url.ts, link-menu-rules.ts).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { linkCopyText, linkMenuPlan } from '../../app/renderer/link-menu-rules.ts'
import { type ChannelRef, detectChannelRefs, detectUrlLinks, linkTargetOfUrl } from '../../app/shared/links.ts'
import { channelUrl, parseTetherUrl } from '../../app/shared/tether-url.ts'

const CHANNELS: ChannelRef[] = [
  { id: 'c_abc1234', name: 'nosce-te-balanco' },
  { id: 'c_old0001', name: 'velho', closed: true },
  { id: 'desk_desk-1', name: 'obra' },
  { id: 'c_num0001', name: '123' },
]
const texts = (line: string): string[] => detectChannelRefs(line, CHANNELS).map(l => line.slice(l.start, l.end))

describe('#name as a link', () => {
  test('only names of existing channels, open or closed, case-blind', () => {
    assert.deepEqual(texts('O canal está aberto: #nosce-te-balanco'), ['#nosce-te-balanco'])
    assert.deepEqual(texts('kai entrou em #Nosce-Te-Balanco.'), ['#Nosce-Te-Balanco'])
    assert.deepEqual(texts('ver #velho e (#obra), mas não #nada'), ['#velho', '#obra'])
    const [l] = detectChannelRefs('em #nosce-te-balanco', CHANNELS)
    assert.equal(l!.url, 'tether://channel/c_abc1234')
  })

  test('#123, #fff, markdown headings, shell comments and fragments are not links', () => {
    const only = [{ id: 'c_x', name: 'obra' }]
    for (const line of ['cor #fff aqui', 'cor #123', '# Título', '## obra', 'ls # obra', 'a#obra', 'https://x.dev/page#obra', 'src/#obra', 'a=#obra'])
      assert.deepEqual(detectChannelRefs(line, only), [], line)
    assert.deepEqual(texts('numero #123'), ['#123'], 'a channel really called 123 is a link')
  })

  test('no channels, no links; the name must be whole', () => {
    assert.deepEqual(detectChannelRefs('#obra', []), [])
    assert.deepEqual(texts('#obra-2 e #obr e #nosce-te'), [])
  })

  test('an open channel wins over a closed one of the same name', () => {
    const list: ChannelRef[] = [{ id: 'old', name: 'obra', closed: true }, { id: 'new', name: 'obra' }]
    assert.equal(detectChannelRefs('#obra', list)[0]!.url, 'tether://channel/new')
  })
})

describe('tether://channel/<id>', () => {
  test('round trip, target and detection in text', () => {
    assert.equal(channelUrl('c_abc1234'), 'tether://channel/c_abc1234')
    assert.deepEqual(parseTetherUrl('tether://channel/c_abc1234'), { kind: 'channel', id: 'c_abc1234' })
    assert.deepEqual(parseTetherUrl(channelUrl('desk_desk-1')), { kind: 'channel', id: 'desk_desk-1' })
    assert.equal(parseTetherUrl('tether://channel/'), undefined)
    assert.equal(parseTetherUrl('tether://channel/a b'), undefined)
    assert.deepEqual(linkTargetOfUrl('tether://channel/c_abc1234'), { kind: 'channel', id: 'c_abc1234' })
    assert.deepEqual(detectUrlLinks('veja tether://channel/c_abc1234, ok').map(l => l.url), ['tether://channel/c_abc1234'])
  })

  test('the menu: open channel (with the key) and copy link; copy gives the stable address', () => {
    const target = { kind: 'channel', id: 'c_abc1234' } as const
    assert.deepEqual(linkMenuPlan(target, { peekable: false, mac: false }), [
      { action: 'follow', label: 'Abrir canal', icon: 'arrow-square-out', hint: 'Ctrl+clique' },
      'sep',
      { action: 'copy', label: 'Copiar link', icon: 'copy' },
    ])
    assert.equal(linkCopyText(target), 'tether://channel/c_abc1234')
  })
})
