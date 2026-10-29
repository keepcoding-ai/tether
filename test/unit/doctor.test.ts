// `tether doctor`: the pure checks (facts in, OK/AVISO/ERRO + hint out), the report format, and the real hook
// probe (it runs claude-hook.mjs into a temp home and removes it).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  checkClaude,
  checkClaudeEnv,
  checkDaemon,
  checkHome,
  checkHook,
  checkNode,
  checkSoul,
  checkTerminal,
  exitCodeFor,
  formatReport,
  isMintty,
  MIN_NODE_MAJOR,
  parseClaudeVersion,
  probeHook,
  type CheckResult,
  type HookProbe,
} from '../../src/doctor.ts'

describe('doctor: node', () => {
  test(`>= ${MIN_NODE_MAJOR} is OK, older is ERRO with a hint, garbage is ERRO`, () => {
    assert.equal(checkNode('v24.22.1').level, 'OK')
    assert.equal(checkNode(`v${MIN_NODE_MAJOR}.0.0`).level, 'OK')
    const old = checkNode('v22.12.0')
    assert.equal(old.level, 'ERRO')
    assert.match(old.hint!, new RegExp(`Node ${MIN_NODE_MAJOR}`))
    assert.equal(checkNode('banana').level, 'ERRO')
  })
})

describe('doctor: claude', () => {
  test('version parsed from "2.1.312 (Claude Code)"', () => {
    assert.equal(parseClaudeVersion('2.1.312 (Claude Code)\n'), '2.1.312')
    assert.equal(parseClaudeVersion(undefined), undefined)
    assert.equal(parseClaudeVersion('nope'), undefined)
  })
  test('not found → ERRO with install hint; found with version → OK naming the executable', () => {
    const missing = checkClaude('claude', false, undefined)
    assert.equal(missing.level, 'ERRO')
    assert.match(missing.hint!, /PATH/)
    const ok = checkClaude('C:\\bin\\claude.exe', true, '2.1.312 (Claude Code)')
    assert.equal(ok.level, 'OK')
    assert.match(ok.detail, /2\.1\.312 \(C:\\bin\\claude\.exe\)/)
    assert.equal(checkClaude('claude.exe', true, '').level, 'ERRO')
  })
})

describe('doctor: hook', () => {
  const base: HookProbe = {
    lines: ['{"v":1,"ts":"2026-10-29T00:00:00.000Z","slotId":"doctor","agent":"claude","kind":"start","source":"startup","sessionId":"abc","cwd":"D:\\\\x"}'],
    sessionId: 'abc',
    slotId: 'doctor',
    ms: 120,
    stdout: '',
    exitCode: 0,
    nodeOnPath: true,
  }
  test('event written back with the same ids → OK with the time', () => {
    const r = checkHook(base)
    assert.equal(r.level, 'OK')
    assert.match(r.detail, /120 ms/)
  })
  test('non-zero exit, stdout output, no line, other ids → ERRO; node off PATH → AVISO', () => {
    assert.equal(checkHook({ ...base, exitCode: 1 }).level, 'ERRO')
    assert.equal(checkHook({ ...base, stdout: 'oops' }).level, 'ERRO')
    assert.equal(checkHook({ ...base, lines: [] }).level, 'ERRO')
    assert.equal(checkHook({ ...base, lines: ['not json'] }).level, 'ERRO')
    assert.equal(checkHook({ ...base, sessionId: 'other' }).level, 'ERRO')
    const noNode = checkHook({ ...base, nodeOnPath: false })
    assert.equal(noNode.level, 'AVISO')
    assert.match(noNode.hint!, /Git Bash/)
  })
  test('probeHook runs the real hook into a temp home, reads the event back and removes the home', () => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('tether-doctor-')).length
    const p = probeHook()
    assert.equal(p.exitCode, 0)
    assert.equal(p.stdout, '')
    assert.equal(p.lines.length, 1)
    assert.equal(checkHook(p).level, p.nodeOnPath ? 'OK' : 'AVISO')
    assert.ok(p.ms > 0 && p.ms < 20_000)
    assert.equal(readdirSync(tmpdir()).filter((n) => n.startsWith('tether-doctor-')).length, before, 'temp home removed')
  })
})

describe('doctor: home, daemon, soul', () => {
  test('home', () => {
    assert.equal(checkHome('D:\\t', true).level, 'OK')
    const bad = checkHome('D:\\t', false, 'EACCES')
    assert.equal(bad.level, 'ERRO')
    assert.match(bad.detail, /EACCES/)
  })
  test('daemon: hello → OK with pid and version; nothing → AVISO', () => {
    const up = checkDaemon('\\\\.\\pipe\\tether-x', { v: 1, pid: 4242, version: '0.1.0' })
    assert.equal(up.level, 'OK')
    assert.match(up.detail, /pid 4242/)
    assert.match(up.detail, /0\.1\.0/)
    assert.equal(checkDaemon('\\\\.\\pipe\\tether-x', undefined).level, 'AVISO')
  })
  test('soul: missing → AVISO; no version → ERRO; source with/without SOUL_SESSION_REPORT; unreadable → "não verificável"', () => {
    assert.equal(checkSoul({ command: 'soul', found: false, versionOutput: undefined, sourceText: undefined }).level, 'AVISO')
    assert.equal(checkSoul({ command: 'soul', found: true, versionOutput: '', sourceText: 'x' }).level, 'ERRO')
    const ok = checkSoul({ command: 'D:/soul-cli/bin/soul', found: true, versionOutput: '0.1.187', sourceText: 'const X = "SOUL_SESSION_REPORT"' })
    assert.equal(ok.level, 'OK')
    assert.match(ok.detail, /0\.1\.187/)
    const without = checkSoul({ command: 'D:/soul-cli/bin/soul', found: true, versionOutput: 'soul 0.1.187', sourceText: 'nothing here' })
    assert.equal(without.level, 'AVISO')
    assert.match(without.hint!, /session-report/)
    const unknown = checkSoul({ command: 'soul', found: true, versionOutput: '0.1.187', sourceText: undefined })
    assert.equal(unknown.level, 'AVISO')
    assert.match(unknown.detail, /não verificável sem conversa/)
  })
})

describe('doctor: environment and terminal', () => {
  test('CLAUDE* variables → AVISO listing them (case-insensitive); none → OK', () => {
    const r = checkClaudeEnv({ CLAUDECODE: '1', ClaudeCodeX: 'y', PATH: 'x', NOT_CLAUDE: '1' })
    assert.equal(r.level, 'AVISO')
    assert.match(r.detail, /2 no ambiente \(CLAUDECODE, ClaudeCodeX\)/)
    assert.equal(checkClaudeEnv({ PATH: 'x' }).level, 'OK')
  })
  test('mintty detection and the winpty warning', () => {
    assert.equal(isMintty({ env: { TERM_PROGRAM: 'mintty' }, stdoutIsTTY: true }), true)
    assert.equal(isMintty({ env: { WT_SESSION: 'x', MSYSTEM: 'UCRT64' }, stdoutIsTTY: false }), false)
    assert.equal(isMintty({ env: { TERM_PROGRAM: 'vscode', MSYSTEM: 'UCRT64' }, stdoutIsTTY: false }), false)
    const warn = checkTerminal({ env: { TERM_PROGRAM: 'mintty' }, stdoutIsTTY: false, winptyOnPath: false })
    assert.equal(warn.level, 'AVISO')
    assert.match(warn.hint!, /winpty/)
    assert.equal(checkTerminal({ env: { TERM_PROGRAM: 'mintty' }, stdoutIsTTY: false, winptyOnPath: true }).level, 'OK')
    const wt = checkTerminal({ env: { WT_SESSION: 'x' }, stdoutIsTTY: true, winptyOnPath: false })
    assert.equal(wt.level, 'OK')
    assert.equal(wt.detail, 'Windows Terminal')
  })
})

describe('doctor: report', () => {
  const results: CheckResult[] = [
    { level: 'OK', name: 'node', detail: 'v24.22.1' },
    { level: 'AVISO', name: 'tetherd', detail: 'não está em execução', hint: 'npm run daemon' },
    { level: 'ERRO', name: 'claude', detail: 'não encontrado', hint: 'instale' },
  ]
  test('one line per check, hint lines only for AVISO/ERRO, totals at the end', () => {
    const text = formatReport(results)
    assert.match(text, /^OK {5}node: v24\.22\.1$/m)
    assert.match(text, /^AVISO {2}tetherd: não está em execução\n {7}→ npm run daemon$/m)
    assert.match(text, /^ERRO {3}claude: não encontrado\n {7}→ instale$/m)
    assert.match(text, /1 erro\(s\), 1 aviso\(s\)\.\n$/)
    assert.match(formatReport([results[0]!]), /Tudo certo\.\n$/)
  })
  test('exit code 1 only with an ERRO', () => {
    assert.equal(exitCodeFor(results), 1)
    assert.equal(exitCodeFor(results.slice(0, 2)), 0)
  })
})
