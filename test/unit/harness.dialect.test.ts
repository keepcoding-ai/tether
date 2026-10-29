// The harness dialects against screens captured from the real TUIs (test/e2e/README.md): what the input box, the
// placeholder, the slash menu, the busy state and the farewell look like. A TUI change breaks this before it
// breaks a live run.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { CLAUDE_DIALECT, SOUL_DIALECT, type AgentDialect } from '../../test/e2e/harness.ts'

const promptOf = (d: AgentDialect, screen: string): { lines: string[]; prompt: number } => {
  const lines = screen.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) if (d.isPrompt(lines, i)) return { lines, prompt: i }
  return { lines, prompt: -1 }
}

describe('soul dialect', () => {
  const framed = [
    ' ▪ connected',
    '╭──────────────────────────────────────────╮',
    '│ ❯ Try "fix typecheck errors"             │',
    '╰──────────────────────────────────────────╯',
    '  ? for shortcuts',
    '  Agent Serpente │ Model cheap │ Effort ◐ medium │ Mode ● careful',
  ].join('\n')

  test('framed box: prompt found, placeholder counts as empty', () => {
    const { lines, prompt } = promptOf(SOUL_DIALECT, framed)
    assert.equal(prompt, 2)
    assert.equal(SOUL_DIALECT.inputText(lines, prompt), '')
    assert.equal(SOUL_DIALECT.menuHighlight(lines, prompt), undefined)
    assert.equal(SOUL_DIALECT.busy(framed, '✳ Serpente'), false)
  })

  test('framed box with text and the slash menu below it', () => {
    const screen = [
      ' ● abacaxi',
      ' ▪ connected',
      '╭──────────────────────────────────────────╮',
      '│ ❯ /exit                                  │',
      '╰──────────────────────────────────────────╯',
      '  ❯ /exit                Exit the REPL',
      '    /export              Export the conversation',
      '',
      '  Tab completes │ Enter runs │ Esc closes the list',
    ].join('\n')
    const { lines, prompt } = promptOf(SOUL_DIALECT, screen)
    assert.equal(prompt, 3, 'the box, not the menu item below it')
    assert.equal(SOUL_DIALECT.inputText(lines, prompt), '/exit')
    assert.equal(SOUL_DIALECT.menuHighlight(lines, prompt), '/exit')
  })

  test('titled box (after /rename): two rules, indented ❯', () => {
    const screen = [
      ' ❯ /rename titulo-c8',
      '   └  Session renamed to: titulo-c8',
      ' ▪ connected',
      '──────────────────────────────────────────────────────────── titulo-c8 ──',
      '  ❯ oi',
      '─────────────────────────────────────────────────────────────────────────',
      '  ? for shortcuts',
    ].join('\n')
    const { lines, prompt } = promptOf(SOUL_DIALECT, screen)
    assert.equal(prompt, 4, 'the box line, not the transcript echo of /rename')
    assert.equal(SOUL_DIALECT.inputText(lines, prompt), 'oi')
    assert.equal(SOUL_DIALECT.menuHighlight(lines, prompt), undefined)
  })

  test('busy: status hint, spinner line, braille title', () => {
    assert.equal(SOUL_DIALECT.busy('  Esc stops │ Enter queues after this turn', '✳ Serpente'), true)
    assert.equal(SOUL_DIALECT.busy(' ● Schlepping…\n   └  Tip: Run soul --continue', '✳ Serpente'), true)
    assert.equal(SOUL_DIALECT.busy(' ● abacaxi', '⠂ Serpente'), true)
    assert.equal(SOUL_DIALECT.busy(' ● abacaxi\n  ? for shortcuts', '✳ Serpente'), false)
  })

  test('farewell: the title in quotes', () => {
    const m = SOUL_DIALECT.exitHint.exec('Resume this session with:\nsoul --resume "Respuesta sobre abacaxi"\n')
    assert.equal(m?.[1], 'Respuesta sobre abacaxi')
  })
})

describe('claude dialect (unchanged behaviour)', () => {
  test('❯ at column 0 is the box; the menu sits above the rule', () => {
    const screen = [
      '  ❯ /compact             Clear conversation history',
      '    /config              Open config',
      '────────────────────────────────────────',
      '❯ /compact',
    ].join('\n')
    const { lines, prompt } = promptOf(CLAUDE_DIALECT, screen)
    assert.equal(prompt, 3)
    assert.equal(CLAUDE_DIALECT.inputText(lines, prompt), '/compact')
    assert.equal(CLAUDE_DIALECT.menuHighlight(lines, prompt), '/compact')
    assert.equal(CLAUDE_DIALECT.busy('esc to interrupt', ''), true)
    assert.equal(CLAUDE_DIALECT.busy('', '◐ x'), true)
    assert.equal(CLAUDE_DIALECT.exitHint.exec('claude --resume 0b6f0b6f-0b6f-0b6f-0b6f-0b6f0b6f0b6f')?.[1], '0b6f0b6f-0b6f-0b6f-0b6f-0b6f0b6f0b6f')
  })
})
