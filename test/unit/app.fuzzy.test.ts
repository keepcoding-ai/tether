// Approximate matching (app/renderer/fuzzy.ts) and the palette's ranking and input rules (app/renderer/palette-rules.ts).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Command } from '../../app/renderer/commands.ts'
import { foldChars, fuzzyMatch, highlightRuns } from '../../app/renderer/fuzzy.ts'
import { initialInput, parsePaletteInput, rankCommands } from '../../app/renderer/palette-rules.ts'

const hits = (q: string, t: string): string => { const m = fuzzyMatch(q, t); return m ? m.positions.map(p => t[p]).join('') : '∅' }
const score = (q: string, t: string): number => fuzzyMatch(q, t)?.score ?? -1

describe('fuzzy match', () => {
  test('letters apart, in order; the matched letters come back as positions in the original text', () => {
    assert.equal(hits('nvmesa', 'Nova mesa'), 'Nvmesa')
    assert.equal(hits('fpn', 'Fechar painel…'), 'Fpn')
    assert.equal(hits('mesa', 'Nova mesa'), 'mesa')
    assert.equal(fuzzyMatch('xyz', 'Nova mesa'), undefined)
    assert.equal(fuzzyMatch('mesan', 'Nova mesa'), undefined, 'order matters')
  })

  test('case and accents do not matter; spaces in the query are ignored', () => {
    assert.equal(hits('proxima', 'Próxima mesa'), 'Próxima')
    assert.equal(hits('PRÓX', 'proxima'), 'prox')
    assert.equal(hits('nova mesa', 'Nova mesa'), 'Novamesa')
    assert.deepEqual(foldChars('Ação'), ['a', 'c', 'a', 'o'])
  })

  test('the empty query matches everything with score 0', () => {
    assert.deepEqual(fuzzyMatch('', 'Qualquer'), { score: 0, positions: [] })
    assert.deepEqual(fuzzyMatch('   ', 'Qualquer'), { score: 0, positions: [] })
  })

  test('ranking: consecutive letters and word starts win; a match at the start of the text wins a tie', () => {
    assert.ok(score('mesa', 'Nova mesa') > score('mesa', 'Mostrar a sala'), 'a run beats scattered letters')
    assert.ok(score('nm', 'Nova mesa') > score('nm', 'Renomear'), 'two word starts beat an inner pair')
    assert.ok(score('n', 'Nova mesa') > score('n', 'Renomear mesa'), 'the start of the text')
    assert.ok(score('fechar', 'Fechar painel…') > score('fechar', 'Voltar a fechar depois'), 'start of text beats a later word')
  })

  test('highlight runs split the title into plain and matched pieces, no HTML involved', () => {
    const m = fuzzyMatch('nm', 'Nova mesa')!
    assert.deepEqual(highlightRuns('Nova mesa', m.positions), [{ text: 'N', hit: true }, { text: 'ova ', hit: false }, { text: 'm', hit: true }, { text: 'esa', hit: false }])
    assert.deepEqual(highlightRuns('abc', []), [{ text: 'abc', hit: false }])
  })

  test('astral characters keep the positions aligned with the string', () => {
    const t = '😀 Ir para…'
    const m = fuzzyMatch('ir', t)!
    assert.equal(m.positions.map(p => t[p]).join(''), 'Ir')
  })
})

describe('palette rules', () => {
  const cmd = (id: string, title: string): Command => ({ id, title, run: () => {} })
  const list = [cmd('pane.new', 'Novo painel…'), cmd('desk.new', 'Nova mesa'), cmd('desk.next', 'Próxima mesa'), cmd('pane.close', 'Fechar painel…'), cmd('theme.dark', 'Tema: Escuro')]

  test('">" is the command mode; anything else is quick open; the prefix and the space after it are not part of the query', () => {
    assert.deepEqual(parsePaletteInput('>'), { mode: 'commands', query: '' })
    assert.deepEqual(parsePaletteInput('> nova'), { mode: 'commands', query: 'nova' })
    assert.deepEqual(parsePaletteInput('>nova'), { mode: 'commands', query: 'nova' })
    assert.deepEqual(parsePaletteInput('main.ts'), { mode: 'quick-open', query: 'main.ts' })
    assert.deepEqual(parsePaletteInput(''), { mode: 'quick-open', query: '' })
    assert.equal(initialInput('commands'), '>')
    assert.equal(initialInput('quick-open'), '')
  })

  const ids = (r: ReturnType<typeof rankCommands>): string[] => r.map(x => x.command.id)

  test('empty query: the history first (last run on top), then the rest by title; two sections', () => {
    const r = rankCommands(list, '', ['theme.dark', 'desk.next'])
    assert.deepEqual(ids(r), ['theme.dark', 'desk.next', 'pane.close', 'desk.new', 'pane.new'])
    assert.deepEqual(r.map(x => x.section), ['recent', 'recent', 'other', 'other', 'other'])
    assert.deepEqual(ids(rankCommands(list, '', [])), ['pane.close', 'desk.new', 'pane.new', 'desk.next', 'theme.dark'].sort((a, b) => list.find(c => c.id === a)!.title.localeCompare(list.find(c => c.id === b)!.title, 'pt-BR')))
    assert.ok(rankCommands(list, '', []).every(x => x.section === 'other'))
  })

  test('a recent id that is not offered is ignored', () => {
    assert.deepEqual(ids(rankCommands(list, '', ['gone.x', 'desk.new'])).slice(0, 2), ['desk.new', 'pane.close'])
  })

  test('with a query: only filters; recents that match stay on top in history order, the rest alphabetical', () => {
    const r = rankCommands(list, 'mesa', ['desk.next', 'desk.new'])
    assert.deepEqual(ids(r), ['desk.next', 'desk.new'])
    const r2 = rankCommands(list, 'pa', ['theme.dark', 'pane.new'])
    assert.deepEqual(ids(r2), ['pane.new', 'pane.close'], 'prefix of the words: both panels; the recent one first')
    assert.deepEqual(r2.map(x => x.section), ['recent', 'other'])
    assert.ok(!ids(rankCommands(list, 'mesa', [])).includes('theme.dark'))
  })

  test('multi-word, accent-free and group matching', () => {
    const dup: Command[] = [
      { id: 'pane.dup-right', title: 'Duplicar à direita', group: 'Painel', run: () => {} },
      { id: 'pane.dup-left', title: 'Duplicar à esquerda', group: 'Painel', run: () => {} },
      { id: 'desk.new', title: 'Nova mesa', group: 'Mesa', run: () => {} },
    ]
    assert.deepEqual(ids(rankCommands(dup, 'dup dir', [])), ['pane.dup-right'])
    assert.deepEqual(ids(rankCommands(dup, 'direita', [])), ['pane.dup-right'])
    assert.deepEqual(ids(rankCommands(dup, 'DUPLICAR A ESQ', [])), ['pane.dup-left'])
    // "group: title": the query reaches the group, and both get their ranges
    const g = rankCommands(dup, 'mesa nova', [])
    assert.deepEqual(ids(g), ['desk.new'])
    assert.deepEqual(g[0]!.group, [{ start: 0, end: 4 }])
    assert.deepEqual(rankCommands(dup, 'painel dup', []).map(x => x.command.id), ['pane.dup-right', 'pane.dup-left'])
    assert.deepEqual(rankCommands(dup, 'dup dir', [])[0]!.title, [{ start: 0, end: 3 }, { start: 8, end: 9 }, { start: 11, end: 14 }])
    assert.deepEqual(rankCommands(dup, 'nvmesa', []), [], 'letters apart do not match here')
  })
})
