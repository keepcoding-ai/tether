// The tether:// association with the OS (app/main/protocol-association.ts): reading reg.exe's answer, comparing commands.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { commandLineFor, describeCommand, parseRegDefault, sameCommand } from '../../app/main/protocol-association.ts'

const EXE = String.raw`D:\atrium\workspace\tether\node_modules\electron\dist\electron.exe`
const MAIN = String.raw`D:\atrium\workspace\tether\app\dist\main.cjs`

describe('tether:// association', () => {
  test('the command line Electron writes', () => {
    assert.equal(commandLineFor(EXE, [MAIN]), `"${EXE}" "${MAIN}" "%1"`)
    assert.equal(commandLineFor(String.raw`C:\T\Tether.exe`, []), String.raw`"C:\T\Tether.exe" "%1"`)
  })

  test('reg query output, English and Portuguese Windows, or nothing', () => {
    const out = `\r\nHKEY_CURRENT_USER\\Software\\Classes\\tether\\shell\\open\\command\r\n    (Default)    REG_SZ    "${EXE}" "${MAIN}" "%1"\r\n\r\n`
    assert.equal(parseRegDefault(out), `"${EXE}" "${MAIN}" "%1"`)
    assert.equal(parseRegDefault(out.replace('(Default)', '(Padrão)')), `"${EXE}" "${MAIN}" "%1"`)
    assert.equal(parseRegDefault('ERRO: o sistema não conseguiu localizar a chave'), undefined)
  })

  test('same command whatever the case and separators; another checkout is not', () => {
    const mine = commandLineFor(EXE, [MAIN])
    assert.equal(sameCommand(mine.toUpperCase().replace(/\\/g, '/'), mine), true)
    assert.equal(sameCommand(mine.replace(String.raw`workspace\tether`, String.raw`workspace\tether\.claude\worktrees\links`), mine), false)
    assert.equal(sameCommand(undefined, mine), false)
  })

  test('what the person is shown: the tether folder from sources, the executable when packaged', () => {
    assert.equal(describeCommand(`"${EXE}" "${MAIN}" "%1"`), String.raw`D:\atrium\workspace\tether`)
    assert.equal(describeCommand(String.raw`"C:\T\Tether.exe" "%1"`), String.raw`C:\T\Tether.exe`)
  })
})
