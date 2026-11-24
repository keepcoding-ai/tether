// R1 end to end WITHOUT an LLM and without the screen: a PRIVATE tetherd (own home, own pipe) with two fake `claude` agents
// (test/fixtures/channels/agent-live.cjs) in a channel. One speaks; the other reacts by the CLI and by the MCP tool; the person
// (the `app` client) reacts too. Proves: the reaction is on the line in `channels read` (CLI and MCP), the five names and an emoji
// of the CLI work, a take away works, the sum survives a restart of tetherd, and NOBODY got a delivery, a note, a queue entry or
// a turn from a reaction (the iron rule).
// Run alone: node --test test/e2e/channels.reactions.test.ts
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
  readonly root = mkdtempSync(join(tmpdir(), 'tether-ch-react-'))
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
    this.pipe = process.platform === 'win32' ? winPipe(`tether-ch-react-${id}`) : join(this.home, 'd.sock')
    this.ptydPipe = process.platform === 'win32' ? winPipe(`tether-ch-react-ptyd-${id}`) : join(this.home, 'ptyd.sock')
  }

  async connect(): Promise<void> {
    if (process.platform === 'win32') writeFileSync(join(this.shim, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${AGENT}" %*\r\n`)
    else writeFileSync(join(this.shim, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${AGENT}" "$@"\n`, { mode: 0o755 })
    writeFileSync(join(this.home, 'settings.json'), JSON.stringify({ extensions: { disabled: ['web-bridge', 'browser', 'skills', 'for-agents', 'conductor-terminal', 'conductor-claude', 'conductor-soul', 'conductor-codex'] } }))
    const env = cleanDaemonEnv({ TETHER_PANEL_HOST: '1', TETHER_PTYD_PIPE: this.ptydPipe }, this.shim)
    this.client = await DaemonClient.connect({ home: this.home, pipe: this.pipe, client: 'test', mainPath: MAIN, env, startTimeoutMs: 45_000 })
    this.seen.add(this.client.hello.pid)
    await claim(this.client.hello.pid, { cmdIncludes: MAIN, what: 'tetherd (channels reactions)' })
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
      await sleep(100)
    }
  }

  private bench(slot: string, ext: string): string { return join(this.home, 'bench', `${slot}.${ext}`) }
  private lines<T>(slot: string, ext: string): T[] {
    const f = this.bench(slot, ext)
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T) : []
  }
  /** The channel notifications an agent got through its stream. */
  notes(slot: string): Array<{ content: string; meta: Record<string, string> }> {
    return this.lines<{ method?: string; params?: { content: string; meta: Record<string, string> } }>(slot, 'chan.jsonl').filter((n) => n.method === 'notifications/claude/channel').map((n) => n.params!)
  }
  /** What the delivery keeps waiting for a pane (its queue file). */
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
  /** `node "$TETHER_CLI" channels <argv> --json`, run by the agent in its own pane environment. */
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
  /** The channels verb straight on the pipe (what the CLI sends), with the identity of `slot`: for after a restart. */
  async verb(slot: string, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
    const r = (await this.client.request({ t: 'verb', ns: 'channels', name, slotId: slot, args } as never)) as unknown as { verb: { data: Record<string, any>; text: string } }
    return { ...r.verb.data, text: r.verb.text }
  }
  async ask<T = any>(name: string, args?: unknown): Promise<T> {
    return (await this.app.request({ t: 'ext-request', ext: 'channels', name, ...(args !== undefined ? { args } : {}) })).result as T
  }

  /** Everything that says "something reached an agent or woke it": its notes, its queue file and its turn clock. */
  async footprint(slot: string): Promise<string> {
    const s = await this.state(slot)
    return JSON.stringify({ notes: this.notes(slot).length, inbox: this.inbox(slot).length, turn: s?.turn, busySince: s?.busySince, idleSince: s?.idleSince, attention: s?.attention ?? null, attentionFor: s?.attentionFor ?? null })
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
      const owned = await claim(pid, { what: 'channels reactions process' }).catch(() => undefined)
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

test('channels reactions: react, read, take away, restart tetherd and read again; nobody is delivered or woken', { timeout: 300_000 }, async () => {
  const rig = new Rig(); rigs.push(rig)
  await rig.connect()
  const NAME_A = 'claude · conferente'
  const NAME_B = 'claude · bancada'
  const [A, B] = await Promise.all([rig.agent(NAME_A, 'conferente'), rig.agent(NAME_B, 'bancada')]) as [string, string]

  // A channel with both, and one line from A.
  const made = await rig.cli(A, 'create', 'horizontes')
  assert.ok(made.ok, JSON.stringify(made))
  assert.ok((await rig.cli(A, 'join', 'horizontes', NAME_B)).ok)
  const said = await rig.cli(A, 'say', 'horizontes', 'Terminei a revisão. Posso subir?')
  assert.ok(said.ok, JSON.stringify(said))
  const SEQ: number = said.data.seq
  await rig.waitFor('B heard the line', () => rig.notes(B).some((n) => n.content.includes('Terminei a revisão')))
  await sleep(SETTLE_MS)

  // From here on, nothing may reach either agent: take the footprint of both.
  const before = { A: await rig.footprint(A), B: await rig.footprint(B) }

  // B reacts by name on the CLI, A by emoji on the MCP exit, the person by the app; B's second one is a free emoji.
  const r1 = await rig.cli(B, 'react', 'horizontes', String(SEQ), 'agree')
  assert.ok(r1.ok, JSON.stringify(r1))
  assert.equal(r1.data.emoji, '👍')
  assert.equal(r1.data.name, 'agree')
  assert.equal(r1.data.changed, true)
  const r2 = await rig.mcp(A, 'react', { canal: 'horizontes', seq: SEQ, reaction: '❓' })
  assert.ok(r2.ok, JSON.stringify(r2))
  assert.equal(r2.data.name, 'question')
  assert.ok((await rig.cli(B, 'react', 'horizontes', String(SEQ), '🎉')).ok)
  assert.equal((await rig.cli(B, 'react', 'horizontes', String(SEQ), '🎉')).data.changed, false, 'putting twice is not a second one')

  // Refusals, each with its code, on both exits.
  assert.equal((await rig.cli(B, 'react', 'horizontes', String(SEQ), 'ok')).code, 'bad-reaction')
  assert.equal((await rig.mcp(B, 'react', { canal: 'horizontes', seq: 9999, reaction: 'done' })).code, 'unknown-line')
  assert.equal((await rig.mcp(B, 'react', { canal: 'horizontes', seq: 1, reaction: 'done' })).code, 'not-a-message', 'line 1 is the notice of the channel being born')

  // Read, on both exits: the reaction is on the line, reaction lines are not lines.
  const read = await rig.cli(B, 'read', 'horizontes')
  assert.ok(read.ok, JSON.stringify(read))
  const shown = (read.data.lines as Array<{ seq: number; kind: string; reactions?: Array<{ emoji: string; name?: string; by: string[] }> }>)
  assert.ok(shown.every((l) => l.kind !== 'reaction'))
  const mine = shown.find((l) => l.seq === SEQ)!
  assert.deepEqual(mine.reactions?.map((r) => [r.emoji, r.by]), [['👍', [NAME_B]], ['❓', [NAME_A]], ['🎉', [NAME_B]]])
  assert.equal(read.data.end, SEQ + 3, 'three reactions took a number each; the repeated 🎉 and the refusals wrote nothing')
  const viaMcp = await rig.mcp(A, 'read', { canal: 'horizontes', since: SEQ - 1 })
  assert.ok(viaMcp.ok)
  assert.equal((viaMcp.data.lines as Array<{ seq: number; reactions?: unknown[] }>).find((l) => l.seq === SEQ)?.reactions?.length, 3)

  // Take away.
  const gone = await rig.cli(B, 'react', 'horizontes', String(SEQ), 'agree', '--remove')
  assert.ok(gone.ok, JSON.stringify(gone))
  assert.equal(gone.data.changed, true)
  const afterTake = (await rig.cli(A, 'read', 'horizontes')).data.lines as Array<{ seq: number; reactions?: Array<{ emoji: string }> }>
  assert.deepEqual(afterTake.find((l) => l.seq === SEQ)!.reactions!.map((r) => r.emoji), ['❓', '🎉'])

  // The pane that draws the conversation never gets reaction lines.
  const hist = await rig.ask('history', { channel: made.data.channel.id })
  assert.ok((hist.lines as Array<{ kind: string }>).every((l) => l.kind !== 'reaction'))

  // The iron rule: no note, no queue entry, no turn, no attention, for anyone.
  await sleep(SETTLE_MS)
  assert.equal(await rig.footprint(A), before.A, 'A was not reached or woken by a reaction')
  assert.equal(await rig.footprint(B), before.B, 'B was not reached or woken by a reaction')
  const people = await rig.ask('members', { channel: made.data.channel.id })
  assert.equal(people.members.length, 2)

  // Restart tetherd: same home, same pipe; the sum comes back from the record.
  const oldPid = rig.client.hello.pid
  rig.app.close()
  await rig.client.request({ t: 'shutdown' }).catch(() => undefined)
  rig.client.close()
  for (const end = Date.now() + 30_000; pidAlive(oldPid) && Date.now() < end; await sleep(200));
  assert.equal(pidAlive(oldPid), false, 'the old tetherd is gone')
  await rig.connect()
  await rig.waitFor('the channels record open again', async () => {
    try { return (await rig.verb(A, 'read', { canal: 'horizontes' })).lines } catch { return undefined }
  }, 30_000)
  const again = await rig.verb(A, 'read', { canal: 'horizontes' })
  const back = (again.lines as Array<{ seq: number; reactions?: Array<{ emoji: string; by: string[] }> }>).find((l) => l.seq === SEQ)!
  assert.deepEqual(back.reactions?.map((r) => [r.emoji, r.by]), [['❓', [NAME_A]], ['🎉', [NAME_B]]])
  assert.match(String(again.text), /\[❓ .* · 🎉 .*\]/)
})
