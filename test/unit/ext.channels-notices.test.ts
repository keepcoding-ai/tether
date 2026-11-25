// The texts the channels extension teaches an agent about speaking and reading (extensions/channels/daemon/notices.ts): a pane that
// does not hear inside gets the tool and the CLI, tool first; the `inside` road keeps its short forms. Pure: no daemon.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createdNotice, joinedNotice, mergedNotice, returnNotice, withReplyHint, type Tally } from '../../extensions/channels/daemon/notices.ts'

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

  test('the entry notices tell the name the agent has in the room', () => {
    assert.ok(joinedNotice('cena', undefined, ['a'], 'inside', false, 'Membro').startsWith('você entrou em #cena como «Membro» · members: a'))
    assert.ok(joinedNotice('cena', 'Guga', ['a'], 'terminal', false, 'Membro').startsWith('você entrou em #cena como «Membro» (por Guga) ·'))
    assert.equal(createdNotice('cena', 'Autor'), 'você abriu #cena como «Autor» e é o owner dele')
    assert.equal(createdNotice('cena'), 'você abriu #cena e é o owner dele')
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

  // `tools` true = the door KNOWS the client has the tether's tools (sticky): only the tool is taught, never the CLI.
  test('tools known: the reply footer teaches only the tool and keeps "what you write in your tab nobody sees"', () => {
    for (const path of ['terminal', 'wait'] as const) {
      const out = withReplyHint('@soul quero o resumo', 'cena', path, true)
      assert.equal(
        out.split('\n')[1],
        '(para responder no canal: o que você escreve na sua guia ninguém no canal vê; fale pela ferramenta channels_say (room "cena"))',
      )
      assert.ok(!out.includes('TETHER_CLI'), path)
    }
    assert.equal(withReplyHint('oi', 'cena', 'inside', true), 'oi', 'inside never changes')
  })

  test('tools known: the merged and the return notices teach only the read tool', () => {
    const want = 'ler: pela ferramenta channels_read (room "cena", since 4)'
    for (const path of ['terminal', 'wait'] as const) {
      assert.equal(mergedNotice('cena', tally, path, true), `#cena: 2 falas novas desde 19:05, de soul · bancada; ${want}`)
      assert.equal(returnNotice('cena', tally, path, true), `você voltou · #cena: 2 falas novas desde 19:05, de soul · bancada; ${want}`)
    }
    assert.equal(mergedNotice('cena', tally, 'inside', true), mergedNotice('cena', tally), 'inside never changes')
  })

  test('tools known: the join notice teaches only the tools, with no CLI and no PowerShell remark', () => {
    for (const path of ['terminal', 'wait'] as const) {
      const text = joinedNotice('cena', undefined, ['a'], path, true)
      assert.ok(text.includes('para falar: pela ferramenta channels_say (room "cena"); para ler o que perdeu: pela ferramenta channels_read (room "cena");'), path)
      assert.ok(!text.includes('TETHER_CLI') && !text.includes('PowerShell'), path)
      assert.ok(text.includes('o texto do seu turno não vai ao canal'), path)
    }
    assert.equal(joinedNotice('cena', undefined, ['a'], 'inside', true), joinedNotice('cena', undefined, ['a'], 'inside'), 'inside never changes')
  })
})
