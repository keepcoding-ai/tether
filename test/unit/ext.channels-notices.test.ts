// The texts the channels extension teaches an agent about speaking and reading (extensions/channels/daemon/notices.ts): a pane that
// does not hear inside gets the tool and the CLI, tool first; the `inside` road keeps its short forms. Pure: no daemon.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { joinedNotice, mergedNotice, returnNotice, withReplyHint, type Tally } from '../../extensions/channels/daemon/notices.ts'

const tally: Tally = { since: 5, at: '2026-11-23T19:05:00', messages: 2, notices: 0, speakers: ['soul · bancada'], fromUser: 0 }

describe('channels notices: how to answer and read, by road', () => {
  test('a spoken line typed in a terminal ends with ONE line: the own tab is unseen, and the way to speak (tool first, then CLI)', () => {
    for (const path of ['terminal', 'wait'] as const) {
      const out = withReplyHint('@soul quero o resumo', 'cena', path)
      const lines = out.split('\n')
      assert.equal(lines.length, 2, out)
      assert.equal(lines[0], '@soul quero o resumo', 'the body is untouched')
      assert.equal(
        lines[1],
        '(para responder no canal: o que você escreve na sua guia ninguém no canal vê; fale pela ferramenta channels_say (room "cena") ou node "$TETHER_CLI" channels say cena "<texto>")',
      )
      assert.ok(lines[1]!.indexOf('channels_say') < lines[1]!.indexOf('TETHER_CLI'), 'tool first')
    }
  })

  test('a body that already ends with line breaks does not leave a blank line before the hint', () => {
    assert.equal(withReplyHint('oi\n\n', 'cena', 'terminal').split('\n').length, 2)
  })

  test('the inside road does not change', () => {
    assert.equal(withReplyHint('oi', 'cena', 'inside'), 'oi')
  })

  test('the merged and the return notices: inside keeps the short form; terminal and wait teach the tool and the CLI', () => {
    assert.equal(mergedNotice('cena', tally), '#cena: 2 falas novas desde 19:05, de soul · bancada; ler: channels read cena --since 4')
    assert.equal(mergedNotice('cena', tally, 'inside'), mergedNotice('cena', tally))
    const want = 'ler: pela ferramenta channels_read (room "cena", since 4) ou node "$TETHER_CLI" channels read cena --since 4'
    for (const path of ['terminal', 'wait'] as const) {
      assert.ok(mergedNotice('cena', tally, path).endsWith(`; ${want}`), path)
      assert.ok(returnNotice('cena', tally, path).startsWith('você voltou · #cena:') && returnNotice('cena', tally, path).endsWith(`; ${want}`), path)
    }
    assert.ok(returnNotice('cena', tally).endsWith('; ler: channels read cena --since 4'))
  })

  test('the join notice: inside names the Claude tool; the other roads teach the tool and the CLI, tool first', () => {
    assert.ok(joinedNotice('cena', undefined, ['a'], 'inside').includes('mcp__tether__channels_say'))
    assert.ok(!joinedNotice('cena', undefined, ['a'], 'inside').includes('TETHER_CLI'))
    for (const path of ['terminal', 'wait'] as const) {
      const text = joinedNotice('cena', undefined, ['a'], path)
      assert.ok(text.includes('para falar: pela ferramenta channels_say (room "cena") ou node "$TETHER_CLI" channels say cena "<texto>"'), path)
      assert.ok(text.includes('para ler o que perdeu: pela ferramenta channels_read (room "cena") ou node "$TETHER_CLI" channels read cena'), path)
    }
  })
})
