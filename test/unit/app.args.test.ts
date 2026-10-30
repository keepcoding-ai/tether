// The argument field of the profile form: text ⇄ argv with quoting (app/renderer/args.ts).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatArgs, parseArgs } from '../../app/renderer/args.ts'

test('parseArgs: whitespace split, quotes keep spaces, backslashes are literal (Windows paths)', () => {
  assert.deepEqual(parseArgs(''), [])
  assert.deepEqual(parseArgs('   '), [])
  assert.deepEqual(parseArgs('--dangerously-skip-permissions'), ['--dangerously-skip-permissions'])
  assert.deepEqual(parseArgs('  --model   haiku '), ['--model', 'haiku'])
  assert.deepEqual(parseArgs('--add-dir "C:\\Meus Projetos\\app" -g'), ['--add-dir', 'C:\\Meus Projetos\\app', '-g'])
  assert.deepEqual(parseArgs("--name 'com espaço'"), ['--name', 'com espaço'])
  assert.deepEqual(parseArgs('--x "a \\"b\\" c"'), ['--x', 'a "b" c'])
  assert.deepEqual(parseArgs('""'), [''], 'an empty quoted arg is kept')
  assert.deepEqual(parseArgs('--x "unbalanced'), ['--x', 'unbalanced'], 'an open quote runs to the end')
  assert.deepEqual(parseArgs('a"b c"d'), ['ab cd'], 'quotes glue to the surrounding text')
})

test('formatArgs: round-trips through parseArgs', () => {
  for (const args of [[], ['--login', '-i'], ['--add-dir', 'C:\\Meus Projetos'], ['x', 'a "b" c'], [''], ["it's"]]) {
    assert.deepEqual(parseArgs(formatArgs(args)), args, formatArgs(args))
  }
  assert.equal(formatArgs(['--login', '-i']), '--login -i')
  assert.equal(formatArgs(['C:\\Meus Projetos']), '"C:\\Meus Projetos"')
})
