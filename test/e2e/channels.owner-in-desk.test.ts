// The owner of a desk with its OWN pane inside that desk: does it fall into a loop? Suspicion: every turn of the owner tells the desk,
// and the desk tells the owner back. Reading the code says no (for-agents: the owner's own pane is never routed to itself, `ownPanePort`;
// channels: the speaker is skipped by the fan-out and no "finished" notice exists in a channel). This test MEASURES it, with no LLM.
// It also measures the cut of the loop a real LLM owner made: a turn a channel line opened in a guia of the desk does not send
// the posse's "terminou" to the owner (the channels extension clears that routed `done`).
//
// Rig: a PRIVATE tetherd (own home, own pipe, own pane host) as in channels.flow.test.ts; three fake `claude` agents A, B, C
// (test/fixtures/channels/agent-live.cjs) in one desk; the person gives the desk to A by the gestures the app writes (`desk-map`,
// then `object-set` of the desk's owner), so the desk channel is born by itself (A owner, B and C members). Every delivery that
// reaches a pane (the channel stream, or typed into the terminal) is sampled and time-stamped; the central assertion is that after
// each act the number of deliveries is finite and stops growing in a quiet window of 15 s.
//
// What it does NOT cover: a real LLM answers a notice by speaking in the channel (a new act each time); the fake agent only opens
// and ends a turn.
// Run alone: node --test test/e2e/channels.owner-in-desk.test.ts
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

/** The silence that proves a system stopped by itself. */
const QUIET_WINDOW_MS = 15_000

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

interface Note { method?: string; params?: { content: string; meta: Record<string, string> } }
interface Res { ok: boolean; data: Record<string, any>; code?: string }
/** One thing that reached a pane. */
interface Delivery { at: number; slot: string; via: 'stream' | 'terminal'; text: string; from?: string; kind?: string; room?: string }

class Rig {
  readonly root: string
  readonly home: string
  readonly work: string
  readonly shim: string
  readonly pipe: string
  readonly ptydPipe: string
  client!: DaemonClient
  app!: DaemonClient
  readonly seen = new Set<number>()
  /** Every delivery to every watched pane, in the order the sampler saw it. */
  readonly got: Delivery[] = []
  private readonly watched: string[] = []
  private readonly streamSeen = new Map<string, number>()
  private readonly stdinSeen = new Map<string, number>()
  private sampler: ReturnType<typeof setInterval> | undefined
  private nextId = 1
  private lastTs = 0

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), 'tether-ch-odesk-'))
    this.home = join(this.root, 'home')
    this.work = join(this.root, 'work')
    this.shim = join(this.root, 'shim')
    mkdirSync(this.home); mkdirSync(this.work); mkdirSync(this.shim)
    const id = randomBytes(4).toString('hex')
    const BS = String.fromCharCode(92)
    const winPipe = (n: string): string => [BS, BS, '.', BS, 'pipe', BS, n].join('')
    this.pipe = process.platform === 'win32' ? winPipe(`tether-ch-odesk-${id}`) : join(this.home, 'd.sock')
    this.ptydPipe = process.platform === 'win32' ? winPipe(`tether-ch-odesk-ptyd-${id}`) : join(this.home, 'ptyd.sock')
  }

  async connect(): Promise<void> {
    if (process.platform === 'win32') writeFileSync(join(this.shim, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${AGENT}" %*\r\n`)
    else writeFileSync(join(this.shim, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${AGENT}" "$@"\n`, { mode: 0o755 })
    // The desk's ownership (for-agents) and the channels are ON; what has side effects of its own is off.
    writeFileSync(join(this.home, 'settings.json'), JSON.stringify({ extensions: { disabled: ['web-bridge', 'browser', 'skills', 'conductor-terminal', 'conductor-claude', 'conductor-soul', 'conductor-codex'] } }))
    const env = cleanDaemonEnv({ TETHER_PANEL_HOST: '1', TETHER_PTYD_PIPE: this.ptydPipe }, this.shim)
    this.client = await DaemonClient.connect({ home: this.home, pipe: this.pipe, client: 'test', mainPath: MAIN, env, startTimeoutMs: 45_000 })
    const pid = this.client.hello.pid
    this.seen.add(pid)
    await claim(pid, { cmdIncludes: MAIN, what: 'tetherd (channels owner-in-desk)' })
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

  // ---- the agents ----
  private bench(slot: string, ext: string): string { return join(this.home, 'bench', `${slot}.${ext}`) }
  private lines<T>(slot: string, ext: string): T[] {
    const f = this.bench(slot, ext)
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T) : []
  }
  /** Everything of the pane's two doors: the stream notifications and what was typed into its terminal. */
  private doors(slot: string): { stream: Array<{ content: string; meta: Record<string, string> }>; typed: string[] } {
    return {
      stream: this.lines<Note>(slot, 'chan.jsonl').filter((n) => n.method === 'notifications/claude/channel').map((n) => n.params!),
      typed: this.lines<string>(slot, 'stdin.jsonl'),
    }
  }
  /** Starts sampling the doors of the panes every 100 ms (the time each delivery arrived is the evidence of a loop). */
  watch(slots: string[]): void {
    this.watched.push(...slots)
    this.sampler = setInterval(() => this.sample(), 100)
    this.sampler.unref()
  }
  private sample(): void {
    for (const slot of this.watched) {
      const { stream, typed } = this.doors(slot)
      const s0 = this.streamSeen.get(slot) ?? 0
      for (const n of stream.slice(s0)) this.got.push({ at: Date.now(), slot, via: 'stream', text: n.content, from: n.meta.from, kind: n.meta.kind, room: n.meta.room })
      this.streamSeen.set(slot, stream.length)
      const t0 = this.stdinSeen.get(slot) ?? 0
      for (const t of typed.slice(t0)) this.got.push({ at: Date.now(), slot, via: 'terminal', text: t })
      this.stdinSeen.set(slot, typed.length)
    }
  }
  stopWatching(): void { if (this.sampler) clearInterval(this.sampler); this.sampler = undefined }

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
  async ask<T = any>(name: string, args?: unknown): Promise<T> {
    return (await this.app.request({ t: 'ext-request', ext: 'channels', name, ...(args !== undefined ? { args } : {}) })).result as T
  }

  /** A turn the agent opens and ends ALONE, as its SessionStart/Stop hooks would report it (the fake does the same on a delivery). */
  async soloTurn(slot: string, ms = 400): Promise<void> {
    const write = (kind: 'start' | 'done'): void => {
      this.lastTs = Math.max(this.lastTs + 1, Date.now())
      writeFileSync(join(this.home, 'slots', `${slot}.attention`), JSON.stringify({ ts: new Date(this.lastTs).toISOString(), kind }) + '\n')
    }
    write('start')
    await sleep(ms)
    write('done')
  }

  /** Waits until nothing new reached any pane for `quietMs` (capped), so the next step starts from a still system. */
  async settle(quietMs = 3_000, cap = 60_000): Promise<void> {
    const end = Date.now() + cap
    let last = this.got.length
    let since = Date.now()
    while (Date.now() < end) {
      await sleep(200)
      if (this.got.length !== last) { last = this.got.length; since = Date.now() }
      else if (Date.now() - since >= quietMs) return
    }
  }

  async teardown(): Promise<string[]> {
    this.stopWatching()
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
      const owned = await claim(pid, { what: 'channels owner-in-desk process' }).catch(() => undefined)
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

test('owner of a desk with its own pane inside: every act ends, and the system is silent after it (no loop)', { timeout: 600_000 }, async (t) => {
  const rig = new Rig(); rigs.push(rig)
  await rig.connect()
  const say = (s: string): void => { console.log(`# ${s}`); t.diagnostic(s) }

  const [A, B, C] = await Promise.all([
    rig.agent('claude · dona', 'dona'),
    rig.agent('claude · bancada', 'bancada'),
    rig.agent('claude · conferencia', 'conferencia'),
  ]) as [string, string, string]
  const label: Record<string, string> = { [A]: 'A', [B]: 'B', [C]: 'C' }
  rig.watch([A, B, C])

  // ---- the person gives the desk to A, A's own pane being inside it (the gestures the app writes) ----
  const desk = (id: string, panes: string[], kind: 'queue' | 'system' = 'queue') => ({ id, name: id, kind, panes: panes.map((p) => ({ id: p, type: 'terminal' })) })
  await rig.client.request({ t: 'desk-map', map: { desks: [desk('mesa', [A, B, C]), desk('sistema', [], 'system')], drawer: [] } })
  await rig.client.request({ t: 'object-set', ext: 'for-agents', kind: 'desk', objectId: 'mesa', key: 'owner', value: { owner: A, since: new Date().toISOString(), givenBy: 'user' } })
  const deskChannel = await rig.waitFor('the desk channel is born with A, B and C', async () => {
    const list = (await rig.ask('list')).channels as Array<{ id: string; name: string }>
    const ch = list.find((c) => c.id === 'desk_mesa')
    if (!ch) return undefined
    const members = (await rig.ask('members', { channel: ch.id })).members as Array<{ id: string; role?: string }>
    return members.length === 3 ? { ch, members } : undefined
  }, 40_000)
  const NAME = deskChannel.ch.name
  say(`desk channel ${deskChannel.ch.id} (#${NAME}); members ${JSON.stringify(deskChannel.members.map((m) => [label[m.id], m.role]))}`)
  await rig.settle(4_000)
  const setup = rig.got.slice()
  say(`setup deliveries (baseline, not counted): ${setup.length}${setup.map((d) => `\n   ${label[d.slot]} <- [${d.via}] ${d.text.replace(/\s+/g, ' ').slice(0, 140)}`).join('')}`)

  /** The deliveries since a cursor, per pane. */
  const since = (cursor: number): Record<string, Delivery[]> => ({
    A: rig.got.slice(cursor).filter((d) => d.slot === A),
    B: rig.got.slice(cursor).filter((d) => d.slot === B),
    C: rig.got.slice(cursor).filter((d) => d.slot === C),
  })
  const counts = (cursor: number): Record<string, number> => Object.fromEntries(Object.entries(since(cursor)).map(([k, v]) => [k, v.length]))
  const dump = (cursor: number): string => rig.got.slice(cursor).map((d, i, all) => `   +${((d.at - (all[0]?.at ?? d.at)) / 1000).toFixed(1)}s ${label[d.slot]} <- [${d.via}${d.from ? ` from ${d.from}` : ''}${d.kind ? ` ${d.kind}` : ''}] ${d.text.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n')
  /** The central assertion: after the act, the total stops growing in a silent window. Returns the total when it stopped. */
  const silentAfter = async (step: string, cursor: number): Promise<void> => {
    await rig.settle(3_000)
    const before = rig.got.length
    await sleep(QUIET_WINDOW_MS)
    const grew = rig.got.slice(before)
    assert.equal(grew.length, 0, `${step}: the deliveries kept growing in ${QUIET_WINDOW_MS / 1000} s of silence (LOOP?):\n${dump(before)}`)
    say(`${step}: stable (total ${rig.got.length - cursor} deliveries after the act; none new in ${QUIET_WINDOW_MS / 1000} s)`)
  }

  // ---- 1. A opens and ends a turn alone, three times ----
  const c1 = rig.got.length
  for (let i = 0; i < 3; i++) { await rig.soloTurn(A); await sleep(1_200) }
  await silentAfter('1 solo turns of A', c1)
  say(`1. deliveries after 3 solo turns of A: ${JSON.stringify(counts(c1))}\n${dump(c1)}`)
  assert.deepEqual(counts(c1), { A: 0, B: 0, C: 0 }, 'a solo turn of the owner tells nobody')

  // ---- 2. A speaks once in the desk channel; B and C end the turn it opened without answering ----
  const c2 = rig.got.length
  const spoke = await rig.cli(A, 'say', NAME, 'Bom dia, mesa. Só aviso, não precisam responder.')
  assert.ok(spoke.ok, JSON.stringify(spoke))
  await silentAfter('2 A speaks once', c2)
  const s2 = since(c2)
  say(`2. deliveries after A spoke once: ${JSON.stringify(counts(c2))}\n${dump(c2)}`)
  const channelLines = (list: Delivery[]): Delivery[] => list.filter((d) => d.room === NAME && d.kind === 'message')
  assert.equal(channelLines(s2.B!).length, 1, 'B hears the line once')
  assert.equal(channelLines(s2.C!).length, 1, 'C hears the line once')
  assert.equal(channelLines(s2.A!).length, 0, 'A does not hear itself')
  // The turns of B and C were opened by a channel line: their "terminou" is silenced (the channels' rule C6 holds for a commanded
  // pane too), so nothing reaches A and no turn of A is opened by them.
  say(`2. what reached A after its line: ${s2.A!.length}${s2.A!.map((d) => `\n   [${d.via}] ${d.text.replace(/\s+/g, ' ')}`).join('')}`)
  assert.equal(s2.A!.length, 0, 'the turns a channel line opened tell A nothing ("terminou" silenced)')

  // ---- 3. nothing more, anywhere ----
  const total = rig.got.length
  await sleep(QUIET_WINDOW_MS)
  assert.equal(rig.got.length, total, `3: nothing new in ${QUIET_WINDOW_MS / 1000} s more:\n${dump(total)}`)
  say(`3. total ${rig.got.length - c2} deliveries since A's line, stable for ${QUIET_WINDOW_MS / 1000} s more; per pane: ${JSON.stringify(counts(c2))}`)
  assert.ok(!/error|uncaught/i.test(rig.daemonLog().split('\n').filter((l) => /channels|for-agents/.test(l)).join('\n')), 'the daemon log has no channels/for-agents error')
})
