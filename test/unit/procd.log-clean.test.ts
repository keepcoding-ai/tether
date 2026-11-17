// The clean log: ConPTY output (as the bench recorded it) becomes plain text lines, one per output line.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { makeLineCleaner, resolveCr, stripAnsi } from '../../src/procd/log-clean.ts'

const ESC = '\x1b'

describe('log-clean', () => {
  test('ConPTY session start, colours, title and cursor-forward spaces', () => {
    const c = makeLineCleaner()
    const raw = `${ESC}[?9001h${ESC}[?1004h${ESC}[?25l${ESC}[2J${ESC}[m${ESC}[H${ESC}]0;C:\\node.exe\x07listening${ESC}[33m${ESC}[1C47811${ESC}[m\r\ntick 1\r\n`
    assert.deepEqual(c.push(raw), ['listening 47811', 'tick 1'])
  })

  test('absolute positioning stands for a line break (npm)', () => {
    assert.deepEqual(makeLineCleaner().push(`> node servidor.mjs 47814${ESC}[5;1Hlistening 47814\r\n`), ['> node servidor.mjs 47814', 'listening 47814'])
  })

  test('an escape split between chunks is held until it completes', () => {
    const c = makeLineCleaner()
    assert.deepEqual(c.push(`abc${ESC}[3`), [])
    assert.deepEqual(c.push(`3mdef\r\n`), ['abcdef'])
  })

  test('a lone \\r rewrites from column 0; trailing spaces go; last line only on flush', () => {
    assert.equal(resolveCr('progresso 10%\rprogresso 100%'), 'progresso 100%')
    assert.equal(resolveCr('abc\rXY'), 'XYc')
    const c = makeLineCleaner()
    assert.deepEqual(c.push('linha   \r\nsem fim'), ['linha'])
    assert.deepEqual(c.flush(), ['sem fim'])
    assert.deepEqual(c.flush(), [])
  })

  test('UTF-8 and tabs survive; OSC 8 hyperlinks lose their markup', () => {
    assert.equal(stripAnsi('ação\tok 🚀'), 'ação\tok 🚀')
    assert.equal(stripAnsi(`${ESC}]8;;https://x.y${ESC}\\link${ESC}]8;;${ESC}\\`), 'link')
  })
})
