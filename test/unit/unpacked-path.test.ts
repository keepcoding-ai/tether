import { test } from 'node:test'
import assert from 'node:assert/strict'
import { externalPath } from '../../app/shared/unpacked-path.ts'

const B = String.fromCharCode(92) // Windows separator
const win = (...parts: string[]): string => parts.join(B)

test('externalPath: Windows asar path', () => {
  assert.equal(externalPath(win('C:', 'x', 'resources', 'app.asar', 'src', 'daemon', 'main.ts')), win('C:', 'x', 'resources', 'app.asar.unpacked', 'src', 'daemon', 'main.ts'))
})
test('externalPath: already unpacked is unchanged', () => {
  assert.equal(externalPath(win('C:', 'x', 'app.asar.unpacked', 'a')), win('C:', 'x', 'app.asar.unpacked', 'a'))
})
test('externalPath: POSIX asar path', () => {
  assert.equal(externalPath('/x/app.asar/src'), '/x/app.asar.unpacked/src')
})
test('externalPath: no asar (dev) is unchanged', () => {
  assert.equal(externalPath(win('C:', 'dev', 'repo', 'src')), win('C:', 'dev', 'repo', 'src'))
})
