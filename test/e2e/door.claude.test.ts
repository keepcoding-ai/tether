// D8: the agent door end to end with REAL Claude Code (haiku) in a PRIVATE tetherd (own home, pipe and terminal-pane host).
// The daemon is test/fixtures/door-ext/main.ts: the real tetherd plus a `doortest` extension (verb `ping` on both exits, the
// delivery on). Two Claude launches, one at a time:
//   A. ronda AND `tether` offered, one slot: (1) the channels dialog is answered once and lists both servers; (2) a delivery
//      shows up in the transcript as a channel turn with the attributes of deliveryMeta; (3) the tool mcp__tether__doortest_ping
//      reaches the handler with the slot, via 'mcp', proven; (4) `node "$TETHER_CLI" doortest ping` from the agent's shell
//      reaches it proven; (7) the MCP file says http://localhost and Claude got there; (8) with the slot's attention routed to
//      another slot the ronda still sees the turn (waits while busy, nudges when idle); (5) the ronda works in the same slot;
//      (9) tetherd is killed and restarted with the agent alive, and the old slot key is still proven by the CLI.
//   B. delivery on, ronda NOT offered (6): the plan carries only `server:tether`, the dialog is answered, the delivery arrives.
// Run alone: node --test --test-concurrency=1 test/e2e/door.claude.test.ts
// Env: D8_RUN_ROOT (where homes live, default os tmpdir), D8_EVIDENCE_DIR (keeps evidence without keys; default none).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { findTranscript } from '../../src/agents/claude-sync.ts'
import { DaemonClient } from '../../src/daemon/client.ts'
import { deliveryMeta } from '../../src/daemon/door/channel-meta.ts'
import type { DeliveryMessage } from '../../src/daemon/door/types.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { HostClient } from '../../src/procd/client.ts'
import { claim, identify, killOwned, type Owned } from '../kill.ts'
import { Screen } from './harness.ts'
import { pidAlive } from './daemon-driver.ts'
import { openSlot } from './daemon-driver.ts'

const MAIN = resolve(import.meta.dirname, '../fixtures/door-ext/main.ts')
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

const runRoot = process.env.D8_RUN_ROOT ?? tmpdir()
const evidenceDir = process.env.D8_EVIDENCE_DIR
if (evidenceDir) mkdirSync(evidenceDir, { recursive: true })
const evidence = (name: string, text: string): void => { if (evidenceDir) writeFileSync(join(evidenceDir, name), text) }

/** The environment of the test daemon (and so of its agents): no CLAUDE* and no TETHER_* of the tether this test may run in. */
function cleanDaemonEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^CLAUDE/i.test(k) && !/^TETHER_/i.test(k)) env[k] = v
  return Object.assign(env, extra)
}

/** A private tetherd (own home, pipe, pane host) running the door fixture; restartable. */
class Rig {
  readonly root: string
  readonly home: string
  readonly work: string
  readonly pipe: string
  readonly ptydPipe: string
  readonly log: string
  readonly noRondaFlag: string
  client!: DaemonClient
  daemon: Owned | undefined
  daemonPid = 0
  readonly seen = new Set<number>()
  /** The channels dialog as the terminal showed it (ConPTY repaints with cursor moves, so the text comes from a screen), per slot. */
  readonly dialogBy = new Map<string, string>()
  private readonly screens = new Map<string, Screen>()

  constructor(tag: string) {
    this.root = mkdtempSync(join(runRoot, `door-${tag}-`))
    this.home = join(this.root, 'home')
    this.work = mkdtempSync(join(tmpdir(), `tether-door-${tag}-work-`)) // outside the house: no CLAUDE.md up the tree
    mkdirSync(this.home)
    const id = randomBytes(4).toString('hex')
    const BS = String.fromCharCode(92)
    const winPipe = (n: string): string => [BS, BS, '.', BS, 'pipe', BS, n].join('')
    this.pipe = process.platform === 'win32' ? winPipe(`tether-door-${id}`) : join(this.home, 'd.sock')
    this.ptydPipe = process.platform === 'win32' ? winPipe(`tether-door-ptyd-${id}`) : join(this.home, 'ptyd.sock')
    this.log = join(this.root, 'doortest.jsonl')
    this.noRondaFlag = join(this.root, 'no-ronda.flag')
  }

  env(): NodeJS.ProcessEnv {
    return cleanDaemonEnv({
      TETHER_PANEL_HOST: '1', TETHER_PTYD_PIPE: this.ptydPipe, TETHER_RONDA_TEST_SECONDS: '1',
      DOORTEST_LOG: this.log, DOORTEST_NO_RONDA_FLAG: this.noRondaFlag,
    })
  }

  async connect(): Promise<DaemonClient> {
    this.client = await DaemonClient.connect({ home: this.home, pipe: this.pipe, client: 'test', mainPath: MAIN, env: this.env() })
    this.daemonPid = this.client.hello.pid
    this.seen.add(this.daemonPid)
    this.daemon = await claim(this.daemonPid, { cmdIncludes: MAIN, what: 'tetherd (door fixture)' })
    this.client.on('data', (slotId: string, data: string) => {
      const screen = this.screens.get(slotId) ?? new Screen(120, 40)
      this.screens.set(slotId, screen)
      screen.write(data)
      const text = screen.text()
      if (text.includes('Loading development channels')) this.dialogBy.set(slotId, text)
    })
    return this.client
  }

  async states(): Promise<SlotState[]> { return (await this.client.request({ t: 'list' })).slots ?? [] }
  async state(slotId: string): Promise<SlotState | undefined> { return (await this.states()).find(s => s.slotId === slotId) }

  /** Types a line the way the app does: text, a pause, Enter. */
  async say(slotId: string, text: string): Promise<void> {
    this.client.input(slotId, text)
    await sleep(150)
    this.client.input(slotId, '\r')
  }

  /** Every line of the fixture's log, parsed. */
  entries(): Record<string, any>[] {
    if (!existsSync(this.log)) return []
    return readFileSync(this.log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, any>)
  }

  async waitFor<T>(what: string, fn: () => Promise<T | undefined> | T | undefined, timeout = 90_000): Promise<T> {
    const deadline = Date.now() + timeout
    for (;;) {
      const v = await fn()
      if (v) return v
      if (Date.now() > deadline) throw new Error(`timeout (${timeout} ms) waiting for ${what}\n--- daemon log (tail) ---\n${this.daemonLog().slice(-2000)}`)
      await sleep(250)
    }
  }

  /** The turn is over: no `turn` for three polls in a row (call it after the thing that proves the turn started). */
  async idle(slotId: string, timeout = 90_000): Promise<void> {
    let quiet = 0
    await this.waitFor(`${slotId} idle`, async () => { quiet = (await this.state(slotId))?.turn ? 0 : quiet + 1; return quiet >= 3 ? true : undefined }, timeout)
  }

  daemonLog(): string { const p = join(this.home, 'tetherd.log'); return existsSync(p) ? readFileSync(p, 'utf8') : '' }

  /** The transcript's text of the slot's session, read fresh. */
  transcript(state: SlotState): string {
    const b = state.binding
    if (!b) return ''
    const file = findTranscript({ sessionId: b.sessionId, cwd: b.cwd })
    return file && existsSync(file) ? readFileSync(file, 'utf8') : ''
  }

  /** The `<channel ...>` tags of a transcript: attributes and body, newest last. */
  static channelTurns(raw: string, source: string): { attrs: Record<string, string>; body: string }[] {
    const out: { attrs: Record<string, string>; body: string }[] = []
    for (const line of raw.split('\n')) {
      if (!line.includes('"type":"user"')) continue
      let content: unknown
      try { content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content } catch { continue }
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: { text?: string }) => c.text ?? '').join('\n') : ''
      const m = new RegExp(`<channel source="${source}"([^>]*)>([\\s\\S]*?)</channel>`).exec(text)
      if (!m) continue
      const attrs: Record<string, string> = {}
      for (const a of m[1]!.matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]!] = a[2]!
      out.push({ attrs, body: m[2]!.trim() })
    }
    return out
  }

  /** Stops what is running (the daemon waits out the agent's minimum age), then ends tetherd and the pane host by identity. */
  async teardown(): Promise<string[]> {
    try {
      for (const s of await this.states()) if (s.pid) await this.client.request({ t: 'stop', slotId: s.slotId }).catch(() => undefined)
      for (const end = Date.now() + 40_000; Date.now() < end; await sleep(250)) {
        if ((await this.states().catch(() => [])).every(s => !s.pid)) break
      }
    } catch { /* daemon gone */ }
    try { this.client.close() } catch { /* gone */ }
    const host = await HostClient.ping(this.ptydPipe, this.home).catch(() => undefined)
    if (host) this.seen.add(host.pid)
    for (const pid of [...this.seen].reverse()) {
      if (!pidAlive(pid)) continue
      const owned = await claim(pid, { what: 'door e2e process' }).catch(() => undefined)
      if (owned) await killOwned(owned, { tree: true })
    }
    for (const end = Date.now() + 8_000; [...this.seen].some(pidAlive) && Date.now() < end; await sleep(150));
    const left = [...this.seen].filter(pidAlive).map(String)
    for (const dir of [this.work, evidenceDir ? undefined : this.root]) {
      if (!dir) continue
      for (let i = 0; i < 5; i++) { try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) } }
    }
    return left
  }
}

const rigs: Rig[] = []
after(async () => { for (const r of rigs) await r.teardown().catch(() => undefined) })

const MSG: DeliveryMessage = { kind: 'message', room: 'kai', from: { name: 'Atrium', id: 'a1b2c3', role: 'member' }, body: 'Reply only with: canal-ok' }
const ALLOWED = ['--model', 'haiku', '--allowedTools', 'mcp__tether__doortest_ping,Bash(node:*),Bash(sleep:*)']

async function push(rig: Rig, slotId: string, body = MSG.body): Promise<{ id: string; state: string }> {
  const reply = await rig.client.request({ t: 'verb', ns: 'doortest', name: 'push', args: { slot: slotId, body, room: 'kai' }, slotId })
  assert.ok(reply.verb && !reply.verb.isError, `push verb: ${JSON.stringify(reply.verb)}`)
  return reply.verb!.data as { id: string; state: string }
}


/** The channel turn of the delivery is in the transcript with exactly the attributes of deliveryMeta. */
async function assertDelivered(rig: Rig, slotId: string, receipt: { id: string }, label: string): Promise<void> {
  const turn = await rig.waitFor(`${label}: channel turn in the transcript`, async () => {
    const st = await rig.state(slotId)
    return st ? Rig.channelTurns(rig.transcript(st), 'tether').find(t => t.attrs.id === receipt.id) : undefined
  })
  const expected = deliveryMeta(MSG, 'doortest', receipt.id)
  assert.deepEqual(turn.attrs, expected, `${label}: the tag carries deliveryMeta`)
  assert.equal(turn.body, MSG.body)
  console.log(`# ${label}: <channel source="tether" ${Object.entries(turn.attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}>${turn.body}</channel>`)
  evidence(`${label}-channel-turn.txt`, `<channel source="tether" ${Object.entries(turn.attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}>${turn.body}</channel>\n`)
}

function sanitized(text: string): string {
  // evidence never carries a key: refuse anything that looks like a secret token (32+ url-safe characters mixing letters and digits) once uuids are set aside
  const probe = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '')
  assert.ok(!/(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}/.test(probe), 'evidence looks like it carries a token')
  assert.ok(!/TETHER_(SLOT|MCP)_KEY/.test(text), 'evidence names a key variable')
  return text
}

test('A: ronda + tether offered: one dialog, delivery, tool, CLI, localhost, routed attention, ronda, restart', { timeout: 1_500_000 }, async () => {
  const rig = new Rig('a'); rigs.push(rig)
  const client = await rig.connect()
  const { slot } = await client.request({ t: 'create', kind: 'claude', cwd: rig.work, args: ALLOWED })
  const id = slot!.slotId
  await openSlot(client, id) // attach + start + trust dialog + first idle

  // ---- 1. one channels dialog, answered once, both servers listed ----
  const dialog = rig.dialogBy.get(id) ?? ''
  assert.ok(dialog, 'the channels dialog was shown')
  assert.ok(dialog.includes('server:tether-ronda'), 'the dialog lists the ronda server')
  assert.ok(/server:tether(?![-\w])/.test(dialog), 'the dialog lists the tether server')
  const answers = rig.daemonLog().split('\n').filter(l => l.includes(`slot ${id}: channel confirmation recognized`))
  assert.equal(answers.length, 1, 'the daemon answered the dialog once')
  console.log(`# 1. dialog answered once (daemon log), lists both servers`)
  evidence('1-dialog.txt', sanitized(dialog + '\n---\n' + answers.map(l => l.replace(/^\S+ \[\d+\] /, '')).join('\n') + '\n'))

  // ---- 7. the MCP file says localhost, and Claude got there (the tool below proves the connection) ----
  const mcpFile = join(rig.home, 'door', 'mcp', `${id}.json`)
  const mcpText = readFileSync(mcpFile, 'utf8')
  const urlHost = /"url":\s*"(http:\/\/[^/"]+)/.exec(mcpText)?.[1]
  assert.match(urlHost ?? '', /^http:\/\/localhost:\d+$/, 'the door MCP file points at http://localhost:<port>')
  console.log(`# 7. MCP file url host: ${urlHost}`)

  // ---- 2. a delivery arrives as a channel turn ----
  const r1 = await push(rig, id)
  console.log(`# 2. push receipt state: ${r1.state}`)
  await assertDelivered(rig, id, r1, '2')
  await rig.idle(id)

  // ---- 3. the tool, over MCP ----
  await rig.say(id, 'Call the tool mcp__tether__doortest_ping with mark "mcp-1", then reply only: feito.')
  const viaMcp = await rig.waitFor('the handler saw the mcp call', () => rig.entries().find(e => e.event === 'verb' && e.mark === 'mcp-1'))
  assert.equal(viaMcp.slotId, id, 'the handler got the right slot')
  assert.equal(viaMcp.via, 'mcp')
  assert.equal(viaMcp.proven, true)
  console.log(`# 3. mcp: ${JSON.stringify({ slotId: viaMcp.slotId, via: viaMcp.via, proven: viaMcp.proven, mark: viaMcp.mark })}`)
  await rig.idle(id)

  // ---- 4. the CLI from inside the agent ----
  await rig.say(id, 'Run in the shell: node "$TETHER_CLI" doortest ping --mark cli-1   Then reply only: feito.')
  const viaCli = await rig.waitFor('the handler saw the cli call', () => rig.entries().find(e => e.event === 'verb' && e.mark === 'cli-1'))
  assert.equal(viaCli.slotId, id)
  assert.equal(viaCli.via, 'cli')
  assert.equal(viaCli.proven, true)
  console.log(`# 4. cli: ${JSON.stringify({ slotId: viaCli.slotId, via: viaCli.via, proven: viaCli.proven, mark: viaCli.mark })}`)
  await rig.idle(id)

  // ---- 8 + 5. attention routed to another slot; the ronda still sees the turn, and works in the same slot ----
  const dest = (await client.request({ t: 'create', kind: 'shell', cwd: rig.work, start: true })).slot!.slotId
  await rig.waitFor('the destination shell runs', async () => (await rig.state(dest))?.status === 'running' ? true : undefined)
  rig.seen.add((await rig.state(dest))!.pid!)
  const routed = await client.request({ t: 'verb', ns: 'doortest', name: 'route', args: { slot: id, to: dest }, slotId: id })
  assert.ok(routed.verb && !routed.verb.isError, `route verb: ${JSON.stringify(routed.verb)}`)
  const before = (await client.request({ t: 'ronda-get', slotId: id })).ronda
  assert.equal(before, null, 'no ronda yet')
  await rig.say(id, 'Run in the shell: sleep 12   Then reply only: dormi.')
  await rig.waitFor('turn busy', async () => (await rig.state(id))?.turn === 'busy' ? true : undefined)
  await client.request({ t: 'ronda-set', slotId: id, interval: '3s', nudge: 'Reply only with: ronda-ok' })
  // while busy and routed: the turn is visible, nothing is shown to the person, the ronda is due and waits
  const during = await rig.waitFor('ronda due while busy', async () => {
    const s = await rig.state(id)
    return s?.turn === 'busy' && s.ronda?.due ? s : undefined
  }, 20_000)
  assert.equal(during.attention, undefined, 'routed: the slot shows no attention of its own')
  assert.equal(during.ronda?.lastAt, undefined, 'the ronda has not nudged a busy agent')
  console.log('# 8. while routed and busy: turn=busy visible, attention absent, ronda due and waiting')
  await rig.waitFor('turn over', async () => { const s = await rig.state(id); return s && !s.turn ? s : undefined }, 60_000)
  const afterTurn = await rig.waitFor('the ronda nudged after the turn', async () => {
    const s = await rig.state(id)
    return s?.ronda?.lastAt ? s : undefined
  }, 30_000)
  assert.equal(afterTurn.attention, undefined, 'still routed after the turn')
  assert.deepEqual(afterTurn.attentionFor, { slotId: dest, value: 'done' }, 'the finished turn is shown at the destination')
  console.log(`# 8. after the turn: attentionFor=${JSON.stringify(afterTurn.attentionFor)}, ronda nudged at ${afterTurn.ronda?.lastAt}`)
  const nudge = await rig.waitFor('the ronda nudge turn in the transcript', async () => {
    const st = await rig.state(id)
    return st ? Rig.channelTurns(rig.transcript(st), 'tether-ronda')[0] : undefined
  })
  console.log(`# 5. ronda turn in the transcript: <channel source="tether-ronda" ${Object.entries(nudge.attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}>${nudge.body}</channel>`)
  evidence('5-ronda-turn.txt', sanitized(`<channel source="tether-ronda" ${Object.entries(nudge.attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}>${nudge.body}</channel>\n`))
  await rig.waitFor('the nudge turn answered', async () => { const s = await rig.state(id); return s && !s.turn ? true : undefined })
  await client.request({ t: 'ronda-off', slotId: id, force: true })
  await rig.idle(id)

  // ---- 9. tetherd dies hard with the agent alive; a new one adopts it; the old slot key still proves the CLI ----
  const agentPid = (await rig.state(id))!.pid!
  rig.seen.add(agentPid)
  const oldDaemon = rig.daemonPid
  assert.equal(await killOwned(rig.daemon!, { tree: false }), 'killed')
  for (const end = Date.now() + 10_000; pidAlive(oldDaemon) && Date.now() < end; await sleep(100));
  assert.equal(pidAlive(oldDaemon), false, 'tetherd is dead')
  rig.client.close()
  await rig.connect()
  assert.notEqual(rig.daemonPid, oldDaemon)
  const adopted = await rig.waitFor('the agent adopted by the new tetherd', async () => {
    const s = await rig.state(id)
    return s?.status === 'running' && s.pid === agentPid ? s : undefined
  }, 40_000)
  console.log(`# 9. tetherd ${oldDaemon} -> ${rig.daemonPid}; agent pid ${adopted.pid} kept (ptyHost=${adopted.ptyHost})`)
  await rig.say(id, 'Run in the shell: node "$TETHER_CLI" doortest ping --mark cli-after-restart   Then reply only: feito.')
  const afterRestart = await rig.waitFor('the handler saw the cli call after the restart', () => rig.entries().find(e => e.event === 'verb' && e.mark === 'cli-after-restart'), 120_000)
  assert.equal(afterRestart.slotId, id)
  assert.equal(afterRestart.via, 'cli')
  assert.equal(afterRestart.proven, true, 'the old key still proves the slot after tetherd restarted')
  console.log(`# 9. cli after restart: ${JSON.stringify({ slotId: afterRestart.slotId, via: afterRestart.via, proven: afterRestart.proven })}`)
  await rig.idle(id)

  // ---- evidence and shutdown (the agent was alive far longer than 11 s) ----
  evidence('doortest-log.jsonl', sanitized(rig.entries().map(e => JSON.stringify(e)).join('\n') + '\n'))
  evidence('daemon-log-door-lines.txt', sanitized(rig.daemonLog().split('\n').filter(l => /channel confirmation|ronda channel|door:|extensions:|started pid/.test(l)).map(l => l.replace(/^\S+ \[\d+\] /, '')).join('\n') + '\n'))
  const left = await rig.teardown()
  assert.deepEqual(left, [], 'no process left behind')
})

test('B: delivery without the ronda: the plan carries only server:tether, the dialog is answered, the delivery arrives inside', { timeout: 600_000 }, async () => {
  const rig = new Rig('b'); rigs.push(rig)
  writeFileSync(rig.noRondaFlag, 'on\n')
  const client = await rig.connect()
  const { slot } = await client.request({ t: 'create', kind: 'claude', cwd: rig.work, args: ['--model', 'haiku'] })
  const id = slot!.slotId
  await openSlot(client, id)

  const st = (await rig.state(id))!
  const proc = await identify(st.pid!)
  rig.seen.add(st.pid!)
  const cmd = proc?.cmd ?? ''
  assert.ok(/--dangerously-load-development-channels\s+server:tether(\s|$)/.test(cmd), `claude was launched with the channel flag of server:tether alone; cmd: ${cmd.replace(/\s+/g, ' ').slice(0, 300)}`)
  assert.ok(!cmd.includes('tether-ronda'), 'the ronda server is not in the launch')
  const dialog = rig.dialogBy.get(id) ?? ''
  assert.ok(dialog, 'the channels dialog was shown')
  assert.ok(/server:tether(?![-\w])/.test(dialog) && !dialog.includes('tether-ronda'), 'the dialog lists only the tether server')
  const answers = rig.daemonLog().split('\n').filter(l => l.includes(`slot ${id}: channel confirmation recognized`))
  assert.equal(answers.length, 1, 'answered once')
  assert.equal((await client.request({ t: 'ronda-get', slotId: id })).ronda, null)
  const roundMsg = await client.request({ t: 'ronda-set', slotId: id, interval: '1m' }).then(() => 'accepted', (e: Error) => e.message)
  console.log(`# 6. launch args hold only server:tether; dialog once; ronda-set answer: ${roundMsg.slice(0, 120)}`)
  await client.request({ t: 'ronda-off', slotId: id, force: true }).catch(() => undefined)

  const receipt = await push(rig, id)
  console.log(`# 6. push receipt state: ${receipt.state}`)
  await assertDelivered(rig, id, receipt, '6')
  await rig.idle(id)
  evidence('6-dialog.txt', sanitized(dialog + '\n'))
  const left = await rig.teardown()
  assert.deepEqual(left, [], 'no process left behind')
})
