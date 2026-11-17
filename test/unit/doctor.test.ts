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
  checkProcHost,
  checkExecutables,
  checkStartTime,
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
  test('executáveis: tetherd.exe + tether-soul.exe in place → OK naming the method; plain node running or fallback → AVISO', () => {
    const ok = (name: 'tetherd' | 'tether-soul', method: 'hardlink' | 'copy') =>
      ({ name, path: `C:\\h\\bin\\${name}.exe`, present: true, outdated: false, residue: false, stamp: { source: 'C:\\n\\node.exe', size: 1, mtimeMs: 1, method } })
    const up = checkExecutables({ tetherd: ok('tetherd', 'hardlink'), soul: ok('tether-soul', 'copy'), daemonExec: 'C:\\h\\bin\\tetherd.exe', soulIsNode: true, platform: 'win32' })
    assert.equal(up.level, 'OK')
    assert.match(up.detail, /tetherd: link de C:\\n\\node\.exe; tether-soul: cópia de/)
    assert.match(up.detail, /em execução como C:\\h\\bin\\tetherd\.exe/)
    const noSoul = checkExecutables({ tetherd: ok('tetherd', 'hardlink'), soul: ok('tether-soul', 'copy'), daemonExec: undefined, soulIsNode: false, platform: 'win32' })
    assert.equal(noSoul.level, 'OK')
    assert.ok(!noSoul.detail.includes('tether-soul'))
    const plain = checkExecutables({ tetherd: ok('tetherd', 'copy'), soul: ok('tether-soul', 'copy'), daemonExec: 'C:\\n\\node.exe', soulIsNode: true, platform: 'win32' })
    assert.equal(plain.level, 'AVISO')
    assert.match(plain.detail, /em execução como C:\\n\\node\.exe/)
    const fallback = checkExecutables({ tetherd: { name: 'tetherd', path: 'x', present: false, outdated: true, residue: false, stamp: { source: 'C:\\n\\node.exe', size: 0, mtimeMs: 0, method: 'fallback', reason: 'EACCES' } }, soul: ok('tether-soul', 'copy'), daemonExec: undefined, soulIsNode: false, platform: 'win32' })
    assert.equal(fallback.level, 'AVISO')
    assert.match(fallback.detail, /node original \(EACCES\)/)
    const outdated = checkExecutables({ tetherd: { ...ok('tetherd', 'copy'), outdated: true }, soul: ok('tether-soul', 'copy'), daemonExec: undefined, soulIsNode: false, platform: 'win32' })
    assert.equal(outdated.level, 'OK')
    assert.match(outdated.detail, /desatualizada/)
  })
  test('executáveis no macOS: node real com nome por argv0 → OK; tetherd/tether-soul sobrando em bin → AVISO nomeando o resíduo', () => {
    const argv0 = (name: 'tetherd' | 'tether-soul', present: boolean) =>
      ({ name, path: `/h/bin/${name}`, present, outdated: false, residue: present, stamp: { source: '/opt/homebrew/bin/node', size: 1, mtimeMs: 1, method: 'argv0' as const, reason: 'dyld' } })
    const ok = checkExecutables({ tetherd: argv0('tetherd', false), soul: argv0('tether-soul', false), daemonExec: '/opt/homebrew/bin/node', soulIsNode: true, platform: 'darwin' })
    assert.equal(ok.level, 'OK')
    assert.match(ok.detail, /node real \(\/opt\/homebrew\/bin\/node\) com o nome por argv0/)
    assert.match(ok.detail, /tether-soul idem \(exec -a\)/)
    const noSoul = checkExecutables({ tetherd: argv0('tetherd', false), soul: argv0('tether-soul', true), daemonExec: undefined, soulIsNode: false, platform: 'darwin' })
    assert.equal(noSoul.level, 'OK', 'a soul that is not a node does not count, even with a file there')
    assert.doesNotMatch(noSoul.detail, /tether-soul/)
    const residue = checkExecutables({ tetherd: argv0('tetherd', true), soul: argv0('tether-soul', false), daemonExec: '/opt/homebrew/bin/node', soulIsNode: true, platform: 'darwin' })
    assert.equal(residue.level, 'AVISO')
    assert.match(residue.detail, /resíduo que o dyld recusa: \/h\/bin\/tetherd$/)
    assert.match(residue.hint!, /Library not loaded/)
  })

  test('horário de início: helper → OK with ms; one-shot → AVISO; nothing answered → ERRO', () => {
    assert.equal(checkStartTime({ method: 'helper', ms: 12, answered: true }).level, 'OK')
    assert.match(checkStartTime({ method: 'helper', ms: 12, answered: true }).detail, /residente \(12 ms/)
    assert.equal(checkStartTime({ method: 'one-shot', ms: 1200, answered: true }).level, 'AVISO')
    assert.equal(checkStartTime({ method: 'one-shot', ms: 1200, answered: false }).level, 'ERRO')
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

describe('doctor: background processes', () => {
  test('host running: pid, version, how many run and ask attention', () => {
    const r = checkProcHost({ host: { pid: 42, version: '0.1.0' }, running: 2, attention: 1 })
    assert.equal(r.level, 'OK')
    assert.match(r.detail, /anfitrião pid 42, versão 0\.1\.0; 2 processo\(s\) rodando, 1 pede\(m\) atenção/)
  })
  test('no host: OK, it starts on the next proc start', () => {
    assert.match(checkProcHost({ host: null, running: 0 }).detail, /anfitrião parado/)
  })
  test('another protocol version: AVISO with the action', () => {
    const r = checkProcHost({ host: null, running: 0, versionProblem: 'o anfitrião rodando (pid 7) fala a versão 2 do protocolo; esta é a 1' })
    assert.equal(r.level, 'AVISO')
    assert.match(r.hint ?? '', /tether proc host stop/)
  })
})
