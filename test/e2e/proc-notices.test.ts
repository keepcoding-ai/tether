// E2E of process notices with REAL Claude Code (haiku) in a PRIVATE tetherd (temp home, unique pipe), molded on
// pause.test.ts: a Claude panel (A) declares a use of a background process through the CLI of its own panel
// (`node "$TETHER_CLI" proc use …`, as the skill teaches); a second author forces a restart with a reason; on A's next
// step the notice arrives through the hook (never typed into its terminal) and A can tell who restarted it and why.
// Then the process is killed from outside (by pid) and A, on its next step, can tell the exit code.
// Run: node --test --test-concurrency=1 test/e2e/proc-notices.test.ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { findTranscript } from '../../src/agents/claude-sync.ts'
import { slotNoticesPath } from '../../src/core/paths.ts'
import type { ProcEvent, ProcState } from '../../src/daemon/procs.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { openSlot, pidAlive, SuiteDaemon } from './daemon-driver.ts'
import { aliveProcs, type Proc, type Terminal } from './harness.ts'

const ROOT = resolve(import.meta.dirname, '../..')
const CLI = join(ROOT, 'bin', 'tether.mjs')
const SERVER = join(ROOT, 'test', 'e2e', 'fixtures', 'proc', 'server.mjs')
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const root = mkdtempSync(join(tmpdir(), 'tether-proc-notices-'))
const home = join(root, 'home')
const work = join(root, 'work')
mkdirSync(home); mkdirSync(work)
const tag = randomBytes(4).toString('hex')
const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\tether-proc-notices-${tag}` : join(home, 'd.sock')
const suite = new SuiteDaemon(home, pipe)
const terminals: Terminal[] = []
const trees: Proc[][] = []
const seen = new Set<number>()

function tether(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, TETHER_HOME: home, TETHER_PIPE: pipe }
  delete env.TETHER_SLOT_ID
  delete env.TETHER_PROCD_PIPE
  return new Promise((res) => {
    execFile(process.execPath, [CLI, ...args], { env, cwd: work, windowsHide: true, encoding: 'utf8', timeout: 60_000 }, (err, stdout, stderr) => {
      res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr })
    })
  })
}
const proc = async (name: string): Promise<ProcState> => (JSON.parse((await tether(['proc', 'ls', '--json'])).stdout) as ProcState[]).find(p => p.name === name)!
const history = async (name: string): Promise<ProcEvent[]> => JSON.parse((await tether(['proc', 'history', name, '--json'])).stdout) as ProcEvent[]
async function states(): Promise<SlotState[]> { return (await suite.client.request({ t: 'list' })).slots! }
async function waitFor<T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, timeout = 120_000): Promise<T> {
  const deadline = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timeout (${timeout} ms) waiting for ${what}\n--- daemon log ---\n${suite.log().slice(-1500)}`)
    await sleep(250)
  }
}

/** The assistant's texts in the session's transcript, oldest first. */
function assistantTexts(sessionId: string): string[] {
  const file = findTranscript({ sessionId, cwd: work })
  if (!file || !existsSync(file)) return []
  const out: string[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"type":"assistant"')) continue
    try {
      const o = JSON.parse(line) as { type?: string; message?: { content?: { type?: string; text?: string }[] } }
      for (const c of o.message?.content ?? []) if (c.type === 'text' && c.text) out.push(c.text)
    } catch { /* a torn line */ }
  }
  return out
}

before(async () => {
  await suite.connect()
})

after(async () => {
  for (const t of terminals) if (t.alive) await t.ensureMinUptime()
  try {
    await tether(['proc', 'host', 'stop', '--force'])
    await suite.shutdown()
  } finally {
    for (const t of terminals) t.dispose()
    const left = await aliveProcs(trees.flat())
    await waitFor('process pids gone', () => [...seen].every(p => !pidAlive(p)), 10_000).catch(() => undefined)
    for (let i = 0; i < 5; i++) { try { rmSync(root, { recursive: true, force: true }); break } catch { await sleep(300) } }
    assert.deepEqual(left.map(p => `${p.pid} ${p.name}`), [], 'orphan processes after the suite')
    assert.deepEqual([...seen].filter(pidAlive), [], 'background processes left after the suite')
  }
})

test('notices: A declares a use from its panel, a forced restart reaches A on its next step (who and why), and so does an exit by a kill from outside (the code)', { timeout: 900_000 }, async () => {
  const port = await new Promise<number>((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)) }) })
  assert.equal((await tether(['proc', 'start', 'svc', '--port', String(port), '--', 'node', SERVER, String(port)])).code, 0)
  seen.add((await proc('svc')).pid!)

  // ---- A: a real Claude panel declares a use through its own panel's CLI ----
  const { slot } = await suite.client.request({ t: 'create', kind: 'claude', cwd: work, name: 'painel-a', args: ['--model', 'haiku', '--allowedTools', 'Bash'] })
  const A = slot!.slotId
  const term = await openSlot(suite.client, A)
  terminals.push(term)
  trees.push(await term.tree())
  await term.type('Rode exatamente este comando no Bash, uma vez: node "$TETHER_CLI" proc use svc 30m "testes de recados" — depois responda apenas: uso-declarado.')
  const declared = await waitFor('use-declared by A', async () => (await history('svc')).find(e => e.kind === 'use-declared' && e.by?.slotId === A), 180_000)
  assert.equal(declared.purpose, 'testes de recados')
  assert.equal(declared.by?.kind, 'agent')
  await waitFor('A idle after declaring', async () => (await states()).find(s => s.slotId === A)?.turn === undefined ? true : undefined, 120_000)
  const sessionId = (await states()).find(s => s.slotId === A)!.binding!.sessionId
  console.log(`# A (${A}) declared: ${JSON.stringify(declared.purpose)} until ${declared.until}`)

  // ---- a second author forces a restart with a reason: the notice waits in A's file ----
  const refused = await tether(['proc', 'restart', 'svc', '--as', 'lia'])
  assert.equal(refused.code, 3, 'without --force the restart is refused')
  const forced = await tether(['proc', 'restart', 'svc', '--as', 'lia', '--force', 'migrei o banco de dados'])
  assert.equal(forced.code, 0, forced.stdout + forced.stderr)
  seen.add((await proc('svc')).pid!)
  const noticeFile = slotNoticesPath(home, A)
  assert.ok(existsSync(noticeFile), 'the notice waits for A\'s next step (nothing typed into its terminal)')
  const waiting = readFileSync(noticeFile, 'utf8')
  assert.match(waiting, /lia \(.*\) quer reiniciar svc/)
  assert.match(waiting, /svc foi reiniciado por lia \(.*\), à força sobre o seu uso, motivo: \\"migrei o banco de dados\\"/)
  await sleep(2_000)
  assert.equal((await states()).find(s => s.slotId === A)?.turn, undefined, 'the notice did not wake A')

  // ---- A's next step: the hook hands the notice over; A says who and why ----
  const before1 = assistantTexts(sessionId).length
  await term.type('Pergunta rápida, sem usar ferramentas: o tether te deu algum recado sobre processos? Se sim, diga numa linha quem reiniciou o svc e qual foi o motivo.')
  const answer1 = await waitFor('A answers who and why', () => {
    const fresh = assistantTexts(sessionId).slice(before1).join('\n')
    return /lia/i.test(fresh) && /banco/i.test(fresh) ? fresh : undefined
  }, 180_000)
  console.log(`# A answered: ${JSON.stringify(answer1)}`)
  assert.equal(existsSync(noticeFile), false, 'the hook consumed the notice')
  await waitFor('A idle after answering', async () => (await states()).find(s => s.slotId === A)?.turn === undefined ? true : undefined, 120_000)

  // ---- the process is killed from outside (by pid): A hears the exit code on its next step ----
  const victim = (await proc('svc')).pid!
  process.kill(victim)
  const ended = await waitFor('ended by itself', async () => (await history('svc')).find(e => e.kind === 'ended' && e.cause === 'own'), 30_000)
  assert.equal(typeof ended.code, 'number')
  assert.match(readFileSync(noticeFile, 'utf8'), new RegExp(`svc encerrou sozinho às .* com código ${ended.code}`))
  const before2 = assistantTexts(sessionId).length
  await term.type('Mais uma, sem usar ferramentas: chegou recado novo do tether sobre o svc? Diga numa linha o que aconteceu e o código de saída.')
  const answer2 = await waitFor('A answers the exit code', () => {
    const fresh = assistantTexts(sessionId).slice(before2).join('\n')
    return fresh.includes(String(ended.code)) ? fresh : undefined
  }, 180_000)
  console.log(`# exit code ${ended.code}; A answered: ${JSON.stringify(answer2)}`)
  assert.equal(existsSync(noticeFile), false)
})
