// E1 of the polls end to end WITHOUT an LLM and without the screen: a PRIVATE tetherd (own home, own pipe) with three fake `claude`
// agents (test/fixtures/channels/agent-live.cjs) in a channel. Proves, on both exits (CLI and MCP tool):
//   1. a poll opens, votes come in (one changes), the last vote closes it by "all voted"; `channels read` shows it;
//   2. its author closes another one (`channels_poll_close`), a non-author is refused;
//   3. another closes by its deadline on the live clock (1 min), with "sem resposta"; who owes a vote may not open one;
//   4. a third one's deadline passes with tetherd STOPPED: it comes back closed as soon as tetherd is up, marked as such;
//   and the deliveries of E2: each agent called gets ONE request (kind request, poll, options, closes), a vote reaches no one, the
//   author alone gets ONE result (none when it closed the poll itself); a called whose process is stopped gets the request when
//   it runs again; a tetherd restart in the middle asks no one twice and delivers no second result.
// Run alone: node --test test/e2e/channels.polls.test.ts (about 4 min: two deadlines of 1 min are waited for real).
// Never touches the person's tether: home and pipe are the test's, every process is killed by pid + identity (test/kill.ts).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DaemonClient } from '../../src/daemon/client.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { HostClient } from '../../src/procd/client.ts'
import { claim, killOwned } from '../kill.ts'
import { pidAlive } from './daemon-driver.ts'

const MAIN = resolve(import.meta.dirname, '../../src/daemon/main.ts')
const AGENT = resolve(import.meta.dirname, '../fixtures/channels/agent-live.cjs')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** The agent's fake turn lasts this long (agent-live.cjs); a quiet moment is once it is over and the daemon had time to react. */
const SETTLE_MS = 1500

function cleanDaemonEnv(extra: Record<string, string>, shimDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^CLAUDE/i.test(k) || /^TETHER_/i.test(k) || k === 'NODE_TEST_CONTEXT') continue
    env[k] = v
  }
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  env[pathKey] = `${shimDir}${process.platform === 'win32' ? ';' : ':'}${env[pathKey] ?? ''}`
  return Object.assign(env, extra)
}

interface Res { ok: boolean; data: Record<string, any>; code?: string }

class Rig {
  readonly root = mkdtempSync(join(tmpdir(), 'tether-ch-poll-'))
  readonly home = join(this.root, 'home')
  readonly work = join(this.root, 'work')
  readonly shim = join(this.root, 'shim')
  readonly pipe: string
  readonly ptydPipe: string
  client!: DaemonClient
  app!: DaemonClient
  readonly seen = new Set<number>()
  private nextId = 1

  constructor() {
    mkdirSync(this.home); mkdirSync(this.work); mkdirSync(this.shim)
    const id = randomBytes(4).toString('hex')
    const BS = String.fromCharCode(92)
    const winPipe = (n: string): string => [BS, BS, '.', BS, 'pipe', BS, n].join('')
    this.pipe = process.platform === 'win32' ? winPipe(`tether-ch-poll-${id}`) : join(this.home, 'd.sock')
    this.ptydPipe = process.platform === 'win32' ? winPipe(`tether-ch-poll-ptyd-${id}`) : join(this.home, 'ptyd.sock')
  }

  async connect(): Promise<void> {
    if (process.platform === 'win32') writeFileSync(join(this.shim, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${AGENT}" %*\r\n`)
    else writeFileSync(join(this.shim, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${AGENT}" "$@"\n`, { mode: 0o755 })
    const off = ['web-bridge', 'browser', 'skills', 'for-agents', 'conductor-terminal', 'conductor-claude', 'conductor-soul', 'conductor-codex']
    writeFileSync(join(this.home, 'settings.json'), JSON.stringify({ extensions: { disabled: off } }))
    const env = cleanDaemonEnv({ TETHER_PANEL_HOST: '1', TETHER_PTYD_PIPE: this.ptydPipe }, this.shim)
    this.client = await DaemonClient.connect({ home: this.home, pipe: this.pipe, client: 'test', mainPath: MAIN, env, startTimeoutMs: 45_000 })
    this.seen.add(this.client.hello.pid)
    await claim(this.client.hello.pid, { cmdIncludes: MAIN, what: 'tetherd (channels polls)' })
    this.app = await DaemonClient.open(this.pipe, 'app')
  }

  daemonLog(): string { const p = join(this.home, 'tetherd.log'); return existsSync(p) ? readFileSync(p, 'utf8') : '' }
  async states(): Promise<SlotState[]> { return (await this.client.request({ t: 'list' })).slots ?? [] }
  async state(slotId: string): Promise<SlotState | undefined> { return (await this.states()).find((s) => s.slotId === slotId) }

  async waitFor<T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, timeout = 30_000): Promise<T> {
    const deadline = Date.now() + timeout
    for (;;) {
      const v = await fn()
      if (v) return v
      if (Date.now() > deadline) throw new Error(`timeout (${timeout} ms) waiting for ${what}\n--- daemon log (tail) ---\n${this.daemonLog().slice(-2500)}`)
      await sleep(200)
    }
  }

  private bench(slot: string, ext: string): string { return join(this.home, 'bench', `${slot}.${ext}`) }
  private lines<T>(slot: string, ext: string): T[] {
    const f = this.bench(slot, ext)
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T) : []
  }
  notes(slot: string): Array<{ content: string; meta: Record<string, string> }> {
    return this.lines<{ method?: string; params?: { content: string; meta: Record<string, string> } }>(slot, 'chan.jsonl').filter((n) => n.method === 'notifications/claude/channel').map((n) => n.params!)
  }
  typed(slot: string): string { return this.lines<string>(slot, 'stdin.jsonl').join('') }
  inbox(slot: string): unknown[] {
    const f = join(this.home, 'slots', `${slot}.inbox.jsonl`)
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  }

  async agent(name: string, folder: string): Promise<string> {
    const cwd = join(this.work, folder)
    mkdirSync(cwd, { recursive: true })
    const slot = (await this.client.request({ t: 'create', kind: 'claude', cwd, name, start: true })).slot!.slotId
    await this.waitFor(`${slot} running with its stream`, async () => {
      const s = await this.state(slot)
      if (s?.pid) this.seen.add(s.pid)
      return s?.status === 'running' && existsSync(this.bench(slot, 'ready'))
    }, 45_000)
    return slot
  }

  private async command(slot: string, c: Record<string, unknown>): Promise<Record<string, any>> {
    const id = this.nextId++
    mkdirSync(join(this.home, 'bench'), { recursive: true })
    appendFileSync(this.bench(slot, 'cmd.jsonl'), JSON.stringify({ id, ...c }) + '\n')
    return this.waitFor(`the outcome of command ${id}`, () => this.lines<{ id: number }>(slot, 'out.jsonl').find((o) => o.id === id), 60_000) as Promise<Record<string, any>>
  }
  async cli(slot: string, ...argv: string[]): Promise<Res> {
    const o = await this.command(slot, { via: 'cli', argv })
    const parse = (s: string): Record<string, any> => { try { return JSON.parse(s) as Record<string, any> } catch { return { text: s.trim() } } }
    return o.status === 0 ? { ok: true, data: parse(o.stdout) } : { ok: false, data: parse(o.stderr), code: parse(o.stderr).error ?? `exit-${o.status}` }
  }
  async mcp(slot: string, verb: string, args: Record<string, unknown> = {}): Promise<Res> {
    const o = await this.command(slot, { via: 'mcp', tool: `channels_${verb}`, arguments: args })
    assert.ok(!o.failed, `mcp ${verb}: ${o.failed}`)
    const r = o.result as { structuredContent?: Record<string, any>; isError?: boolean }
    const data = r.structuredContent ?? {}
    return r.isError ? { ok: false, data, code: data.error } : { ok: true, data }
  }
  /** The channels verb straight on the pipe (what the CLI sends), with the identity of `slot`. */
  async verb(slot: string, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
    const r = (await this.client.request({ t: 'verb', ns: 'channels', name, slotId: slot, args } as never)) as unknown as { verb: { data: Record<string, any>; text: string } }
    return { ...r.verb.data, text: r.verb.text }
  }
  async ask<T = any>(name: string, args?: unknown): Promise<T> {
    return (await this.app.request({ t: 'ext-request', ext: 'channels', name, ...(args !== undefined ? { args } : {}) })).result as T
  }

  /** What of a poll reached `slot`, inside (its notes) or still waiting (its queue file: its stream died with a tetherd). */
  got(slot: string): Array<{ kind?: string; ref?: string; poll?: string; closedBy?: string; options?: string; closes?: string; body: string }> {
    return [
      ...this.notes(slot).map((n) => ({ kind: n.meta.kind, ref: n.meta.ref, poll: n.meta.poll, closedBy: n.meta.closed_by, options: n.meta.options, closes: n.meta.closes, body: n.content })),
      ...(this.inbox(slot) as Array<{ msg: { kind: string; ref?: string; body: string; poll?: { poll: string; closedBy?: string; options?: string; closes?: string } } }>)
        .map((i) => ({ kind: i.msg.kind, ref: i.msg.ref, poll: i.msg.poll?.poll, closedBy: i.msg.poll?.closedBy, options: i.msg.poll?.options, closes: i.msg.poll?.closes, body: i.msg.body })),
    ]
  }
  asks(slot: string, room: string, seq: number) { return this.got(slot).filter((g) => g.kind === 'request' && g.ref === `${room}#${seq}`) }
  results(slot: string, room: string, seq: number) { return this.got(slot).filter((g) => g.closedBy !== undefined && g.poll === `${room}#${seq}`) }
  /** Every poll delivery `slot` got: requests and results. */
  pollCount(slot: string): number { return this.got(slot).filter((g) => g.kind === 'request' || g.closedBy !== undefined).length }

  /** Everything that says "something reached an agent or woke it": its notes, what was typed, its queue file and its turn clock. */
  async footprint(slot: string): Promise<string> {
    const s = await this.state(slot)
    return JSON.stringify({ notes: this.notes(slot).length, typed: this.typed(slot).length, inbox: this.inbox(slot).length, turn: s?.turn, busySince: s?.busySince, idleSince: s?.idleSince, attention: s?.attention ?? null, attentionFor: s?.attentionFor ?? null })
  }

  async teardown(): Promise<string[]> {
    try {
      await Promise.all((await this.states()).filter((s) => s.pid).map((s) => this.client.request({ t: 'stop', slotId: s.slotId }).catch(() => undefined)))
      for (const end = Date.now() + 30_000; Date.now() < end; await sleep(250)) {
        if ((await this.states().catch(() => [])).every((s) => !s.pid)) break
      }
    } catch { /* daemon gone */ }
    try { this.app?.close() } catch { /* gone */ }
    try { await this.client.request({ t: 'shutdown' }) } catch { /* gone */ }
    try { this.client.close() } catch { /* gone */ }
    const host = await HostClient.ping(this.ptydPipe).catch(() => undefined)
    if (host) this.seen.add(host.pid)
    for (const end = Date.now() + 15_000; [...this.seen].some(pidAlive) && Date.now() < end; await sleep(200));
    for (const pid of [...this.seen].reverse()) {
      if (!pidAlive(pid)) continue
      const owned = await claim(pid, { what: 'channels polls process' }).catch(() => undefined)
      if (owned) await killOwned(owned, { tree: true })
    }
    for (const end = Date.now() + 8_000; [...this.seen].some(pidAlive) && Date.now() < end; await sleep(150));
    const left = [...this.seen].filter(pidAlive).map(String)
    for (let i = 0; i < 5; i++) { try { rmSync(this.root, { recursive: true, force: true }); break } catch { await sleep(300) } }
    return left
  }
}

const rigs: Rig[] = []
after(async () => { for (const r of rigs) await r.teardown().catch(() => undefined) })

test('channels polls: open, vote by CLI and MCP, close by all, by author, by deadline, and by a deadline passed with tetherd stopped; nobody is delivered or woken', { timeout: 480_000 }, async () => {
  const rig = new Rig(); rigs.push(rig)
  await rig.connect()
  const NAME_A = 'claude · regente'
  const NAME_B = 'claude · bancada'
  const NAME_C = 'claude · conferência'
  const [A, B, C] = await Promise.all([rig.agent(NAME_A, 'regente'), rig.agent(NAME_B, 'bancada'), rig.agent(NAME_C, 'conferencia')]) as [string, string, string]

  const made = await rig.cli(A, 'create', 'horizontes')
  assert.ok(made.ok, JSON.stringify(made))
  const CH: string = made.data.channel.id
  assert.ok((await rig.cli(A, 'join', 'horizontes', NAME_B)).ok)
  assert.ok((await rig.cli(A, 'join', 'horizontes', NAME_C)).ok)
  assert.ok((await rig.cli(A, 'say', 'horizontes', 'Bom dia. Vou pedir um ok.')).ok)
  await rig.waitFor('B and C heard the line', () => [B, C].every((s) => rig.notes(s).some((n) => n.content.includes('Vou pedir um ok'))))
  await sleep(SETTLE_MS)

  // From here on, only a poll's request or result may reach an agent, and nothing is ever typed.
  const before = { A: rig.notes(A).length, B: rig.notes(B).length, C: rig.notes(C).length, typed: [A, B, C].map((s) => rig.typed(s).length) }

  // 1. A opens by the CLI; B votes by the CLI and changes; C votes by the MCP tool (by number) and closes it.
  const p1 = await rig.cli(A, 'poll', 'horizontes', 'Posso fechar o seminário e subir a ata?')
  assert.ok(p1.ok, JSON.stringify(p1))
  const S1: number = p1.data.seq
  assert.deepEqual(p1.data.options, ['ok', 'não ok'])
  // Sorted: the members are keyed by slot id, and an id made of digits only goes first in a JS object.
  assert.deepEqual((p1.data.to as Array<{ name: string }>).map((t) => t.name).sort(), [NAME_B, NAME_C])
  await rig.waitFor('B and C got the request', () => [B, C].every((s) => rig.asks(s, 'horizontes', S1).length === 1))
  for (const s of [B, C]) {
    const [r] = rig.asks(s, 'horizontes', S1)
    assert.equal(r!.body, 'Posso fechar o seminário e subir a ata?', 'inside: the question alone')
    assert.equal(r!.poll, 'ok')
    assert.equal(r!.options, '1 ok | 2 não ok')
    assert.match(r!.closes!, /^\d\d:\d\d \(em 10 min\)$/)
  }
  assert.equal(rig.asks(A, 'horizontes', S1).length, 0, 'the author is not asked')
  await sleep(SETTLE_MS)
  const afterAsk = { B: rig.notes(B).length, C: rig.notes(C).length }
  const b1 = await rig.cli(B, 'vote', 'horizontes', String(S1), '1')
  assert.ok(b1.ok, JSON.stringify(b1))
  const b2 = await rig.cli(B, 'vote', 'horizontes', String(S1), '2', '--reason', 'a ata ainda não tem os riscos')
  assert.ok(b2.ok, JSON.stringify(b2))
  assert.equal(b2.data.text, 'não ok')
  assert.equal(b2.data.changed, true)
  assert.equal(b2.data.closed, undefined)
  assert.equal((await rig.cli(A, 'vote', 'horizontes', String(S1), '1')).code, 'not-called', 'the author does not vote')
  assert.equal((await rig.mcp(C, 'vote', { canal: 'horizontes', poll: S1, vote: 3 })).code, 'bad-option')
  const c1 = await rig.mcp(C, 'vote', { canal: 'horizontes', poll: S1, vote: 1 })
  assert.ok(c1.ok, JSON.stringify(c1))
  assert.equal(c1.data.closed?.by, 'all-voted')
  assert.equal(c1.data.closed?.tally, 'ok 1 · não ok 1')
  assert.equal((await rig.cli(B, 'vote', 'horizontes', String(S1), '1')).code, 'poll-closed')
  const res1 = await rig.waitFor('A got the result', () => (rig.results(A, 'horizontes', S1).length ? rig.results(A, 'horizontes', S1) : undefined))
  assert.equal(res1[0]!.closedBy, 'all-voted')
  assert.match(res1[0]!.body, new RegExp(`^Enquete horizontes#${S1} fechou: todos votaram\\.\\nok 1: ${NAME_C} · não ok 1: ${NAME_B} \\("a ata ainda não tem os riscos"\\)$`))
  await sleep(SETTLE_MS)
  assert.equal(rig.results(A, 'horizontes', S1).length, 1, 'one result')
  assert.deepEqual({ B: rig.notes(B).length, C: rig.notes(C).length }, afterAsk, 'the votes and the close reached neither voter')
  const read1 = await rig.cli(B, 'read', 'horizontes')
  assert.ok(read1.ok, JSON.stringify(read1))
  const pollLine = (read1.data.lines as Array<{ seq: number; kind: string; pollState?: { state: string; result?: { by: string; tally: Array<{ voters: Array<{ name: string; reason?: string }> }> } } }>).find((l) => l.seq === S1)!
  assert.equal(pollLine.kind, 'poll')
  assert.equal(pollLine.pollState?.state, 'closed')
  assert.equal(pollLine.pollState?.result?.by, 'all-voted')
  assert.deepEqual(pollLine.pollState?.result?.tally.map((t) => t.voters.map((v) => [v.name, v.reason ?? null])), [[[NAME_C, null]], [[NAME_B, 'a ata ainda não tem os riscos']]])
  assert.ok((read1.data.lines as Array<{ kind: string }>).every((l) => l.kind !== 'vote'), 'votes are not lines')
  const text1 = String((await rig.verb(B, 'read', { canal: 'horizontes' })).text)
  assert.match(text1, new RegExp(`${S1} ${NAME_A} → ${NAME_B}, ${NAME_C}: \\[enquete · fechada · todos votaram\\] Posso fechar o seminário e subir a ata\\?  \\[ok 1: ${NAME_C} · não ok 1: ${NAME_B} \\("a ata ainda não tem os riscos"\\)\\]`))
  assert.match(text1, new RegExp(`\\d+ tether: \\[enquete ${S1} fechou · todos votaram\\] ok 1 · não ok 1`))

  // 2. A opens another and closes it by the MCP tool; B may not.
  const p2 = await rig.mcp(A, 'poll', { canal: 'horizontes', question: 'Revisão terça ou quarta?', options: ['terça', 'quarta'] })
  assert.ok(p2.ok, JSON.stringify(p2))
  const S2: number = p2.data.seq
  assert.equal((await rig.cli(B, 'poll-close', 'horizontes', String(S2))).code, 'not-author')
  assert.ok((await rig.mcp(B, 'vote', { canal: 'horizontes', poll: S2, vote: 'quarta' })).ok)
  const closed2 = await rig.mcp(A, 'poll_close', { canal: 'horizontes', poll: S2 })
  assert.ok(closed2.ok, JSON.stringify(closed2))
  assert.equal(closed2.data.by, 'author')
  assert.deepEqual(closed2.data.missing, [{ name: NAME_C, why: 'no-answer' }])
  await sleep(SETTLE_MS)
  assert.equal(rig.results(A, 'horizontes', S2).length, 0, 'the author who closed it has the result in the answer')
  assert.equal(rig.asks(C, 'horizontes', S2).length, 1)

  // 3. B opens one of 1 min by the CLI; C owes it a vote, so C may not open one; only A votes; the live clock closes it.
  const p3 = await rig.cli(B, 'poll', 'horizontes', 'Subo a ata agora?', '--timeout', '1m')
  assert.ok(p3.ok, JSON.stringify(p3))
  const S3: number = p3.data.seq
  assert.equal((await rig.mcp(C, 'poll', { canal: 'horizontes', question: 'E a minha?' })).code, 'vote-first')
  assert.ok((await rig.cli(A, 'vote', 'horizontes', String(S3), 'ok')).ok)
  const opened3 = await rig.verb(C, 'read', { canal: 'horizontes' })
  assert.match(String(opened3.text), new RegExp(`${S3} ${NAME_B} → ${NAME_A}, ${NAME_C}: \\[enquete · aberta · fecha \\d\\d:\\d\\d · 1 ok, 2 não ok\\] Subo a ata agora\\?  \\[ok 1: ${NAME_A} · faltam: ${NAME_C}\\]`))
  assert.match(String(opened3.text).split('\n').at(-1)!, new RegExp(`^enquetes esperando seu voto: ${S3} \\(fecha \\d\\d:\\d\\d; 1 ok, 2 não ok\\)`), 'the last line (the pipe call carries no proof: a mark follows)')
  const read3 = await rig.waitFor('the deadline closed the poll', async () => {
    const r = await rig.verb(C, 'read', { canal: 'horizontes' })
    return String(r.text).includes(`[enquete ${S3} fechou · o prazo venceu]`) ? r : undefined
  }, 100_000)
  assert.match(String(read3.text), new RegExp(`\\[enquete · fechada · o prazo venceu\\] Subo a ata agora\\?  \\[ok 1: ${NAME_A} · sem resposta 1: ${NAME_C} \\(não respondeu\\)\\]`))
  assert.ok(!String(read3.text).includes('enquetes esperando seu voto'), 'nothing owed any more')

  const res3 = await rig.waitFor('B, the author, got the result', () => (rig.results(B, 'horizontes', S3).length ? rig.results(B, 'horizontes', S3) : undefined))
  assert.equal(res3[0]!.closedBy, 'timeout')

  // The pane that draws the conversation gets the opening of each poll but no vote and no close; what reached each agent is the
  // polls' requests and results and nothing else (2 requests and 1 result for A's polls... counted per agent), never typed.
  const hist = await rig.ask('history', { channel: CH })
  assert.ok((hist.lines as Array<{ kind: string; event?: { type: string } }>).every((l) => (l.kind === 'message' || l.kind === 'notice' || l.kind === 'poll') && l.event?.type !== 'poll-close'))
  await sleep(SETTLE_MS)
  // A: the request of S3 and the result of S1. B: the requests of S1 and S2 and the result of S3. C: the requests of S1, S2, S3.
  assert.deepEqual({ A: rig.notes(A).length - before.A, B: rig.notes(B).length - before.B, C: rig.notes(C).length - before.C }, { A: 2, B: 3, C: 3 })
  assert.deepEqual({ A: rig.pollCount(A), B: rig.pollCount(B), C: rig.pollCount(C) }, { A: 2, B: 3, C: 3 }, 'every note was a request or a result')
  assert.deepEqual([A, B, C].map((s) => rig.typed(s).length), before.typed, 'nothing typed')

  // 5. A called whose process is stopped, and a tetherd restart in the middle. D stops; A asks B and D; B gets the request, D
  // nothing. tetherd restarts: nobody is asked again. D runs again: it gets the request, once. Both vote: A gets one result;
  // another restart delivers it no second one.
  const NAME_D = 'claude · dorme'
  const D = await rig.agent(NAME_D, 'dorme')
  assert.ok((await rig.cli(A, 'join', 'horizontes', NAME_D)).ok)
  await rig.client.request({ t: 'stop', slotId: D })
  await rig.waitFor('D stopped', async () => (await rig.state(D))?.status === 'exited')
  const p5 = await rig.cli(A, 'poll', 'horizontes', 'Subo a versão?', '--to', 'bancada', '--to', 'dorme')
  assert.ok(p5.ok, JSON.stringify(p5))
  const S5: number = p5.data.seq
  assert.deepEqual((p5.data.deaf as Array<{ name: string; why: string }>).map((d) => [d.name, d.why]), [[NAME_D, 'stopped']])
  await rig.waitFor('B got the request of S5', () => rig.asks(B, 'horizontes', S5).length === 1)
  assert.equal(rig.asks(D, 'horizontes', S5).length, 0, 'a stopped process gets nothing')
  const restart = async (): Promise<void> => {
    const oldPid = rig.client.hello.pid
    rig.app.close()
    await rig.client.request({ t: 'shutdown' }).catch(() => undefined)
    rig.client.close()
    for (const end = Date.now() + 30_000; pidAlive(oldPid) && Date.now() < end; await sleep(200));
    assert.equal(pidAlive(oldPid), false, 'the old tetherd is gone')
    await rig.connect()
  }
  await restart()
  await sleep(3 * SETTLE_MS)
  assert.equal(rig.asks(B, 'horizontes', S5).length, 1, 'no second request to B after the restart')
  assert.equal(rig.asks(D, 'horizontes', S5).length, 0)
  await rig.client.request({ t: 'start', slotId: D, choice: 'new' })
  await rig.waitFor('D, back, got the request', () => rig.asks(D, 'horizontes', S5).length === 1, 45_000)
  await sleep(3 * SETTLE_MS)
  assert.equal(rig.asks(D, 'horizontes', S5).length, 1, 'once')
  assert.ok((await rig.cli(D, 'vote', 'horizontes', String(S5), '1')).ok)
  // B's own process may not have outlived the tetherd restart: its vote goes straight on the pipe with its identity.
  assert.equal((await rig.verb(B, 'vote', { canal: 'horizontes', poll: S5, vote: 1 })).error, undefined)
  await rig.waitFor('A got the result of S5', () => rig.results(A, 'horizontes', S5).length === 1)
  await restart()
  await sleep(3 * SETTLE_MS)
  assert.equal(rig.results(A, 'horizontes', S5).length, 1, 'no second result after another restart')
  assert.equal(rig.asks(B, 'horizontes', S5).length + rig.asks(D, 'horizontes', S5).length, 2, 'no request again')

  // 4. C opens one of 1 min and tetherd stops before its deadline; it comes back after it and closes the poll at once.
  // On the pipe with C's identity: C's own process may not have outlived the restarts of step 5.
  const p4 = await rig.verb(C, 'poll', { canal: 'horizontes', question: 'Fecha com o tether parado?', timeout: '1m', to: ['bancada'] })
  assert.equal(p4.error, undefined, JSON.stringify(p4))
  const S4: number = p4.seq
  const closesAt = Date.parse(p4.closesAt)
  const oldPid = rig.client.hello.pid
  rig.app.close()
  await rig.client.request({ t: 'shutdown' }).catch(() => undefined)
  rig.client.close()
  for (const end = Date.now() + 30_000; pidAlive(oldPid) && Date.now() < end; await sleep(200));
  assert.equal(pidAlive(oldPid), false, 'the old tetherd is gone')
  assert.ok(Date.now() < closesAt, 'stopped before the deadline')
  await sleep(closesAt - Date.now() + 3_000)
  await rig.connect()
  const back = await rig.waitFor('the poll closed on start', async () => {
    try {
      const r = await rig.verb(A, 'read', { canal: 'horizontes' })
      return String(r.text).includes(`[enquete ${S4} fechou`) ? r : undefined
    } catch { return undefined }
  }, 30_000)
  assert.match(String(back.text), new RegExp(`${S4 + 1} tether: \\[enquete ${S4} fechou · o prazo venceu enquanto o tether estava fora\\] ok 0 · não ok 0`))
  assert.match(String(back.text), new RegExp(`\\[enquete · fechada · o prazo venceu enquanto o tether estava fora\\] Fecha com o tether parado\\?  \\[nenhum voto · sem resposta 1: ${NAME_B} \\((parado|não respondeu|com a pessoa)\\)\\]`))
  const index = JSON.parse(readFileSync(join(rig.home, 'channels', 'index.json'), 'utf8')) as { channels: Record<string, { polls?: unknown; pollsClosed?: Array<{ poll: number }> }> }
  assert.equal(index.channels[CH]!.polls, undefined, 'no open poll left in the index')
  assert.deepEqual(index.channels[CH]!.pollsClosed!.map((c) => c.poll), [S1, S2, S3, S5, S4])
  // Its author C gets the result once (queued: its stream died with the first tetherd); B's request was taken out of the queue.
  await rig.waitFor('C got the result of S4', () => rig.results(C, 'horizontes', S4).length === 1)
  await rig.waitFor('no old request left waiting for B', () => !rig.inbox(B).some((i) => (i as { msg: { ref?: string } }).msg.ref === `horizontes#${S4}`), 10_000)
})
