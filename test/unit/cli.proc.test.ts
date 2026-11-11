// `tether proc` without a daemon: usage errors (exit 2), the "tetherd is not running" message (exit 1), and the
// two commands that read the disk directly (logs with local time per line, --tail/--since/--run; history).
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { procLogPath, procLogsDir } from '../../src/core/paths.ts'
import { UsageError } from '../../src/cli/args.ts'
import { cmdProc, type ProcIo } from '../../src/cli/proc.ts'
import { DaemonError, type DaemonClient } from '../../src/daemon/client.ts'
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
      await assert.rejects(cmdProc(['restart', 'web', '--force'], io(home)), /--force precisa de um valor/)
      await assert.rejects(cmdProc(['restart', 'web', '--force', ' '], io(home)), /pede um motivo/)
      await assert.rejects(cmdProc(['stop', 'web', '--wait', '--force', 'x'], io(home)), /--wait ou --force/)
      await assert.rejects(cmdProc(['stop', 'web', '--wait', '10m'], io(home)), /o máximo é 5m/)
      await assert.rejects(cmdProc(['use', 'web'], io(home)), /uso: tether proc use/)
      await assert.rejects(cmdProc(['use', 'web', '15m'], io(home)), /diga para quê/)
      await assert.rejects(cmdProc(['ls', '--check', '80'], io(home)), /só vale em proc ports/)
      await assert.rejects(cmdProc(['ports', '--check', 'x'], io(home)), /--check inválido/)
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

  test('what goes to tetherd: --wait (bare = 60s) and --force "motivo" on stop/restart/rm; use with or without a time', async () => {
    const home = tempHome()
    try {
      const sent: Record<string, unknown>[] = []
      const r = io(home)
      r.env = { TETHER_SLOT_ID: 'painel-b' }
      r.connect = async () => ({ request: async (req: Record<string, unknown>) => { sent.push(req); return { proc: { name: 'web', status: 'running', card: {} }, released: true } }, close: () => {} }) as unknown as DaemonClient
      await cmdProc(['restart', 'web', '--wait'], r)
      await cmdProc(['stop', 'web', '--wait', '30s'], r)
      await cmdProc(['rm', 'web', '--force', 'limpeza'], r)
      await cmdProc(['use', 'web', 'e2e do checkout'], r)
      await cmdProc(['use', 'web', '30m', 'carga'], r)
      assert.deepEqual(sent.map((q) => [q.t, q.waitMs, q.force, q.duration, q.purpose]), [
        ['proc-restart', 60_000, undefined, undefined, undefined],
        ['proc-stop', 30_000, undefined, undefined, undefined],
        ['proc-forget', undefined, 'limpeza', undefined, undefined],
        ['proc-use', undefined, undefined, undefined, 'e2e do checkout'],
        ['proc-use', undefined, undefined, '30m', 'carga'],
      ])
      assert.equal((sent[0]!.by as { slotId: string }).slotId, 'painel-b')
    } finally { await removeHome(home) }
  })

  test('a refusal by uses: the board on stdout and exit 3 (not an error on stderr)', async () => {
    const home = tempHome()
    try {
      const r = io(home)
      r.connect = async () => ({ request: async () => { throw new DaemonError('proc-in-use', 'web está em uso; não vou reiniciar agora.') }, close: () => {} }) as unknown as DaemonClient
      assert.equal(await cmdProc(['restart', 'web'], r), 3)
      assert.match(r.stdout, /web está em uso/)
      assert.equal(r.stderr, '')
    } finally { await removeHome(home) }
  })
})
