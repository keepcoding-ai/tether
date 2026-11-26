// The background-process model: names, recipes, the secret mask, the recipe diff, state from history, files.
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { procEventsPath } from '../../src/core/paths.ts'
import { SlotStore } from '../../src/core/slot-store.ts'
import { createExecutor, type ExecutorMode } from '../../src/exec/executor.ts'
import {
  authorText,
  checkName,
  deriveState,
  historyLine,
  maskEnv,
  normalizeRecipe,
  ProcError,
  ProcFiles,
  recipeDiff,
  statusText,
  type ProcCard,
  type ProcEvent,
} from '../../src/daemon/procs.ts'
import { removeHome, tempHome } from './daemon.helpers.ts'
import { readProcEvents } from './daemon.proc-disk.ts'

const cwd = process.platform === 'win32' ? 'C:\\work' : '/work'
const card = (over: Partial<ProcCard> = {}): ProcCard => ({
  v: 1, name: 'web', ...normalizeRecipe({ command: 'node', args: ['s.mjs'], cwd }), registeredBy: { kind: 'external', user: 'u' }, createdAt: '2026-11-11T10:00:00.000Z', ...over,
})
let t = 0
const ev = (e: Omit<ProcEvent, 'v' | 'ts'>): ProcEvent => ({ v: 1, ts: new Date(Date.parse('2026-11-11T10:00:00.000Z') + 1000 * ++t).toISOString(), ...e })

describe('procs: model', () => {
  test('names: lower case, digits, - and _', () => {
    assert.equal(checkName('atrium-dev-web'), 'atrium-dev-web')
    for (const bad of ['Web', '-x', 'a b', '', 'a.b', 'x'.repeat(65), 7]) assert.throws(() => checkName(bad), ProcError, String(bad))
  })

  test('recipe: required fields, defaults, refusals', () => {
    const r = normalizeRecipe({ command: 'node', args: ['a'], cwd, description: '  um   servidor ' })
    assert.deepEqual(r, { command: 'node', args: ['a'], cwd, env: {}, ports: [], stopGraceMs: 5000, description: 'um servidor', info: {} })
    assert.throws(() => normalizeRecipe({ command: '', args: [], cwd }), /comando/)
    assert.throws(() => normalizeRecipe({ command: 'x', args: [], cwd: 'rel' }), /absoluta/)
    assert.throws(() => normalizeRecipe({ command: 'x', args: [], cwd, ports: [70000] }), /portas/)
    assert.throws(() => normalizeRecipe({ command: 'x', args: [1], cwd }), /args/)
  })

  test('secrets show by name only, in the card and in the recipe diff', () => {
    assert.deepEqual(maskEnv({ API_KEY: 'k', db_password: 'p', GH_TOKEN: 't', PORT: '3000' }), { API_KEY: '•••', db_password: '•••', GH_TOKEN: '•••', PORT: '3000' })
    // Temper r7 (B-2): the repo's one name rule, and the shape of the value (a URL with a password in it).
    assert.deepEqual(maskEnv({ DB_PASS: 'p', MYSQL_PWD: 'p', PGPASS: 'p', SENTRY_DSN: 'd', PIN: '1234', DATABASE_URL: 'postgres://u:pw@h/db', REDIS_URL: 'redis://h:6379', PWD: '/home/a' }),
      { DB_PASS: '•••', MYSQL_PWD: '•••', PGPASS: '•••', SENTRY_DSN: '•••', PIN: '•••', DATABASE_URL: '•••', REDIS_URL: 'redis://h:6379', PWD: '/home/a' })
    const before = normalizeRecipe({ command: 'node', args: ['a'], cwd, env: { API_KEY: 'old' } })
    const after = normalizeRecipe({ command: 'node', args: ['b'], cwd, env: { API_KEY: 'new' } })
    const d = recipeDiff(before, after)!
    assert.deepEqual(d.before, { args: ['a'], env: { API_KEY: '•••' } })
    assert.deepEqual(d.after, { args: ['b'], env: { API_KEY: '•••' } })
    assert.equal(recipeDiff(before, before), undefined)
  })

  test('state from history: running, stopped by whom, exited own (attention until seen), host-lost, failed, restart', () => {
    const kai = { kind: 'agent' as const, slotId: 's1', name: 'kai', agent: 'claude' }
    const base = [ev({ kind: 'registered', by: kai }), ev({ kind: 'started', by: kai, run: 1, pid: 10 })]
    const running = deriveState(card(), base, { runFile: { v: 1, name: 'web', run: 1, pid: 10, startedAt: 'S', spawnedAt: 'S', hostPid: 1, hostStartedAt: 'H' } })
    assert.equal(running.status, 'running')
    assert.equal(running.pid, 10)
    assert.equal(running.startedAt, 'S')
    assert.equal(deriveState(card(), base, { stopping: true }).status, 'stopping')

    const stopped = deriveState(card(), [...base, ev({ kind: 'stop-requested', by: kai, run: 1, reason: 'fim' }), ev({ kind: 'ended', run: 1, code: -1073741510, at: 'A', cause: 'requested' })], {})
    assert.equal(stopped.status, 'stopped')
    assert.equal(stopped.stoppedBy?.name, 'kai')
    assert.equal(stopped.reason, 'fim')
    assert.equal(stopped.attention, undefined, 'a requested stop never asks for attention, whatever the code')

    const own = [...base, ev({ kind: 'ended', run: 1, code: 7, at: '2026-11-11T10:05:00.000Z', cause: 'own' })]
    const exited = deriveState(card(), own, {})
    assert.equal(exited.status, 'exited')
    assert.deepEqual(exited.exit, { code: 7, at: '2026-11-11T10:05:00.000Z', cause: 'own' })
    assert.equal(exited.attention, true)
    assert.equal(deriveState(card(), own, { seenRun: 1 }).attention, undefined)
    assert.equal(statusText(exited), 'encerrou sozinho (7)')

    const lost = deriveState(card(), [...base, ev({ kind: 'ended', run: 1, at: 'A', cause: 'host' })], {})
    assert.equal(lost.status, 'host-lost')
    assert.equal(statusText(lost), 'caiu com o anfitrião')

    const restarted = [...base, ev({ kind: 'restart-requested', by: kai, run: 1 }), ev({ kind: 'ended', run: 1, code: 0, at: 'A', cause: 'requested' }), ev({ kind: 'started', run: 2, pid: 20 })]
    const r2 = deriveState(card(), restarted, {})
    assert.equal(r2.status, 'running')
    assert.equal(r2.run, 2)
    assert.equal(r2.pid, 20)

    const failed = deriveState(card(), [...base, ev({ kind: 'ended', run: 1, code: 0, at: 'A', cause: 'requested' }), ev({ kind: 'start-failed', run: 2, message: 'comando não encontrado: x' })], {})
    assert.equal(failed.status, 'failed')
    assert.equal(failed.error, 'comando não encontrado: x')
  })

  test('texts: authors and history lines in Portuguese', () => {
    assert.equal(authorText({ kind: 'app' }), 'você (pelo app)')
    assert.equal(authorText({ kind: 'external', user: 'guga', label: 'kai' }), 'kai (guga)')
    assert.equal(authorText({ kind: 'agent', slotId: 's1', name: 'Atrium', agent: 'claude' }), 'Atrium (claude)')
    assert.match(historyLine(ev({ kind: 'restart-requested', by: { kind: 'external', user: 'guga', label: 'kai' }, run: 3, reason: 'corrigi o parser' })), /kai \(guga\)  pediu o reinício \(execução 3\)  motivo: corrigi o parser$/)
  })

  for (const mode of ['inline', 'worker'] as ExecutorMode[]) {
    test(`files (${mode}): cards listed, a corrupt history line skipped, uses and adoption, forget removes everything`, async () => {
      const home = tempHome()
      const ex = createExecutor({ mode })
      const store = new SlotStore(ex)
      const files = new ProcFiles(home, ex, store)
      try {
        files.writeCard(card())
        files.writeCard(card({ name: 'api' }))
        files.appendEvent('web', ev({ kind: 'registered' }))
        files.appendEvent('web', ev({ kind: 'started', run: 1, pid: 1 }))
        await files.flush('web')
        appendFileSync(procEventsPath(home, 'web'), '{"meio linha\n')
        files.appendEvent('web', ev({ kind: 'ended', run: 1, cause: 'own', code: 0 }))
        files.writeUses('web', [{ key: 'app', by: { kind: 'app' }, until: '2999-01-01T00:00:00.000Z', purpose: 'p', declaredAt: '2026-11-11T10:00:00.000Z' }])
        files.writeAdopt('api', { v: 1, pid: 9, startedAt: 'S', adoptedAt: 'A' })
        await Promise.all([files.flush('web'), files.flush('api')])
        const all = await files.loadAll()
        assert.deepEqual(all.map((l) => l.card.name), ['api', 'web'])
        const web = all.find((l) => l.card.name === 'web')!
        assert.deepEqual(web.events.map((e) => e.kind), ['registered', 'started', 'ended'])
        assert.equal(web.uses.length, 1)
        assert.equal((await files.readAdopt('api'))?.pid, 9)
        assert.equal(await files.readAdopt('web'), undefined)
        files.writeUses('web', [])
        files.removeAdopt('api')
        files.removeAll('web')
        await Promise.all([files.flush('web'), files.flush('api')])
        assert.deepEqual((await files.loadAll()).map((l) => l.card.name), ['api'])
        assert.equal(await files.readAdopt('api'), undefined)
        assert.deepEqual(readProcEvents(home, 'web'), [])
      } finally {
        await store.drain()
        await ex.close()
        await removeHome(home)
      }
    })
  }
})
