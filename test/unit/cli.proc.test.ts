// `tether proc` without a daemon: usage errors (exit 2), the "tetherd is not running" message (exit 1), and the
// two commands that read the disk directly (logs with local time per line, --tail/--since/--run; history).
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { procLogPath, procLogsDir } from '../../src/core/paths.ts'
import { UsageError } from '../../src/cli/args.ts'
import { cmdProc, type ProcIo } from '../../src/cli/proc.ts'
import { appendProcEvent } from '../../src/daemon/procs.ts'
import { removeHome, tempHome } from './daemon.helpers.ts'

function io(home: string): ProcIo & { stdout: string; stderr: string } {
  const r = {
    stdout: '', stderr: '', env: {}, home, cwd: home,
    out: (t: string) => { r.stdout += t },
    err: (t: string) => { r.stderr += t },
    connect: async () => undefined,
  }
  return r
}

const hhmmss = (iso: string): string => {
  const d = new Date(iso)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

describe('cli: tether proc', () => {
  test('usage errors never need tetherd', async () => {
    const home = tempHome()
    try {
      await assert.rejects(cmdProc(['start'], io(home)), UsageError)
      await assert.rejects(cmdProc(['start', 'web', '--env', 'X=1'], io(home)), /opções da receita vêm com o comando/)
      await assert.rejects(cmdProc(['start', 'web', '--grace', 'logo', '--', 'node'], io(home)), /--grace/)
      await assert.rejects(cmdProc(['stop', 'web', '--', 'node'], io(home)), /só valem em proc start/)
      await assert.rejects(cmdProc(['voa'], io(home)), /subcomando desconhecido/)
    } finally { await removeHome(home) }
  })

  test('without tetherd: a clear message and exit 1', async () => {
    const home = tempHome()
    try {
      const r = io(home)
      assert.equal(await cmdProc(['ls'], r), 1)
      assert.match(r.stderr, /o tetherd não está rodando/)
    } finally { await removeHome(home) }
  })

  test('logs: latest run by default, local time per line, --tail, --since, --run', async () => {
    const home = tempHome()
    try {
      mkdirSync(procLogsDir(home, 'web'), { recursive: true })
      writeFileSync(procLogPath(home, 'web', 1), '2026-11-11T10:00:00.000Z velho\n')
      const t1 = '2026-11-11T12:00:00.000Z', t2 = '2026-11-11T12:30:00.000Z'
      writeFileSync(procLogPath(home, 'web', 2), `${t1} um\n${t1} dois\n${t2} três\n`)
      let r = io(home)
      assert.equal(await cmdProc(['logs', 'web'], r), 0)
      assert.equal(r.stdout, `${hhmmss(t1)} um\n${hhmmss(t1)} dois\n${hhmmss(t2)} três\n`)
      r = io(home)
      await cmdProc(['logs', 'web', '--tail', '1'], r)
      assert.equal(r.stdout, `${hhmmss(t2)} três\n`)
      r = io(home)
      await cmdProc(['logs', 'web', '--since', '2026-11-11T12:10:00Z'], r)
      assert.equal(r.stdout, `${hhmmss(t2)} três\n`)
      r = io(home)
      await cmdProc(['logs', 'web', '--run', '1'], r)
      assert.match(r.stdout, / velho\n$/)
      r = io(home)
      assert.equal(await cmdProc(['logs', 'nada'], r), 1)
    } finally { await removeHome(home) }
  })

  test('history: one Portuguese line per event, from the disk', async () => {
    const home = tempHome()
    try {
      appendProcEvent(home, 'web', { v: 1, ts: '2026-11-11T12:00:00.000Z', kind: 'restart-requested', run: 1, by: { kind: 'external', user: 'guga', label: 'kai' }, reason: 'corrigi o parser' })
      appendProcEvent(home, 'web', { v: 1, ts: '2026-11-11T12:00:01.000Z', kind: 'ended', run: 1, code: 7, at: '2026-11-11T12:00:01.000Z', cause: 'own' })
      const r = io(home)
      assert.equal(await cmdProc(['history', 'web'], r), 0)
      const lines = r.stdout.trimEnd().split('\n')
      assert.match(lines[0]!, /kai \(guga\)  pediu o reinício \(execução 1\)  motivo: corrigi o parser/)
      assert.match(lines[1]!, /tether  execução 1 encerrou sozinha .*código 7/)
    } finally { await removeHome(home) }
  })
})
