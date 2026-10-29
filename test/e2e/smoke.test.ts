// Smoke test for the E2E harness: drive the real Claude Code once through start → answer → /exit,
// and once through start → kill. Both must leave no process behind.
// Run: npm run test:e2e   (set E2E_LOG_DIR to keep the PTY logs)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { startTerminal, cleanEnv, tempDir, aliveProcs, type Proc } from './harness.ts'
import type { LaunchPlan } from '../../src/agents/types.ts'

const CLAUDE = process.platform === 'win32' ? 'claude.exe' : 'claude'
const logDir = process.env.E2E_LOG_DIR
if (logDir) mkdirSync(logDir, { recursive: true })
const logFile = (name: string) => (logDir ? join(logDir, `${name}-${Date.now()}.jsonl`) : undefined)
const names = (procs: Proc[]) => procs.map(p => p.name).join(' ')

function plan(cwd: string): LaunchPlan {
  return { command: CLAUDE, args: ['--model', 'haiku'], cwd, env: cleanEnv() }
}

test('smoke: start claude (haiku), get an answer, /exit, no orphans', async t => {
  const dir = tempDir('tether-smoke-')
  const times: Record<string, number> = {}
  const since = (from: number) => Math.round(Date.now() - from)
  const t0 = Date.now()
  const term = await startTerminal(plan(dir.path), { log: logFile('smoke') })
  times.startup = since(t0)
  try {
    assert.match(term.screen(), /Claude Code/, 'header visible')

    const t1 = Date.now()
    await term.type('responda apenas: ok')
    await term.waitIdle()
    times.answer = since(t1)
    assert.match(term.screen(), /^●\s*ok\b/im, `assistant answered "ok"\n${term.screen()}`)

    const tree = await term.tree()
    assert.ok(tree.some(p => p.pid === term.pid), 'process tree includes the agent pid')
    t.diagnostic(`tree: ${names(tree)}`)

    const t2 = Date.now()
    const res = await term.exit() // also waits until the whole tree is gone
    times.exit = since(t2)
    assert.equal(res.exitCode, 0, 'clean exit code')
    assert.equal(term.exitCode, 0)
    assert.match(term.resumeId ?? '', /^[0-9a-f-]{36}$/, 'exit banner printed the session id')

    const left = await aliveProcs(tree)
    assert.deepEqual(left, [], `orphan processes after /exit: ${names(left)}`)
  } finally {
    if (term.alive) await term.kill().catch(() => {})
    await dir.cleanup()
    times.total = since(t0)
    t.diagnostic(`timings ms: ${JSON.stringify(times)}`)
  }
})

test('smoke: kill() takes the whole tree down', async t => {
  const dir = tempDir('tether-kill-')
  const t0 = Date.now()
  const term = await startTerminal(plan(dir.path), { log: logFile('kill') })
  try {
    const t1 = Date.now()
    await term.kill() // verifies its own (fresh) tree snapshot is gone
    t.diagnostic(`kill ms: ${Date.now() - t1} (includes the min-uptime wait), startup ms: ${t1 - t0}`)
    assert.equal(term.alive, false)
    assert.deepEqual(await aliveProcs(await term.tree()), [])
  } finally {
    if (term.alive) await term.kill().catch(() => {})
    await dir.cleanup()
  }
})
