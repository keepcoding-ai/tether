// S1: a REAL Soul hears the channel from INSIDE. The tether launches it with the agent door's `tether` MCP server (HTTP) and
// `--channels tether`, so a channel line reaches it as `notifications/claude/channel` and opens a turn of its own, without one
// byte typed in its pane. The pane is the person's (no owner holds it): the case that heard nothing before (C13).
//   (a) the Soul idle: the line opens a turn and the Soul answers it on its own screen;
//   (b) the Soul busy (the person asked it for a slow shell command): the line is delivered at once and answered after that turn;
//   (c) a card open (the Soul asks the person a question): the line waits for the card's answer.
// A private tetherd (own home, pipe and pane host) with the real channels extension; the bench being is born new and empty by
// the engine's own verbs, outside the house, in a fresh temp folder (so `--yolo` touches nothing of anyone). Never the user's tether.
// Run alone: node --test test/e2e/channels.soul-inside.test.ts
// Env: S1_RUN_ROOT (where homes live, default os tmpdir), S1_EVIDENCE_DIR (evidence without keys; default a new folder under
// onda-3/soul-s1), E4S_SOUL_BIN (the soul-cli bin), S1_SKIP_CARD=1 skips (c).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DaemonClient } from '../../src/daemon/client.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { HostClient } from '../../src/procd/client.ts'
import { claim, killOwned } from '../kill.ts'
import { Screen } from './harness.ts'
import { pidAlive } from './daemon-driver.ts'

const MAIN = resolve(import.meta.dirname, '../../src/daemon/main.ts')
const SOUL_BIN = process.env.E4S_SOUL_BIN ?? 'C:/atrium/workspace/soul-cli/bin/soul'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const runRoot = process.env.S1_RUN_ROOT ?? tmpdir()
const evidenceDir = process.env.S1_EVIDENCE_DIR ?? `C:/atrium/.tmp/tether-agents/onda-3/soul-s1/run-${new Date().toISOString().replace(/[:.]/g, '-')}`

/** Evidence never carries a key: anything that looks like a secret token is replaced (uuids and paths are kept). */
function sanitized(text: string): string {
  assert.ok(!/TETHER_(SLOT|MCP)_KEY=/.test(text), 'evidence carries a key assignment')
  return text.replace(/([A-Za-z]:[\\/][^\s"']+)|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{32,}/g, (m, path: string | undefined) => {
    if (path || !/^(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}$/.test(m)) return m
    return `<redacted ${m.length} chars>`
  })
}
const evidence = (name: string, text: string): void => {
  mkdirSync(evidenceDir, { recursive: true })
  writeFileSync(join(evidenceDir, name), sanitized(text))
}

/** The test daemon's environment (and so its agents'): no CLAUDE*, no TETHER_* and no NODE_TEST_CONTEXT of where this test runs. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^CLAUDE/i.test(k) || /^TETHER_/i.test(k) || k === 'NODE_TEST_CONTEXT') continue
    env[k] = v
  }
  return Object.assign(env, extra)
}

const BEING_SOURCE = `---
persona_slug: sonda
persona_name: Sonda
persona_summary: Ser de bancada, descartavel.
persona_description: "Sonda is a bench being: a disposable agent that exists only to prove engine mechanisms. It speaks little, in plain Brazilian Portuguese, says when it does not know, and keeps nothing it was not asked to keep. It is created, exercised and thrown away."
persona_native_language: pt-BR
---

Eu sou a Sonda, um ser de bancada: existo para provar mecanismos do motor.
Falo pouco, em portugues claro, e digo quando nao sei.
Sou descartavel e sei disso; nao guardo nada que nao me peçam.
`

class Rig {
  readonly root: string
  readonly home: string
  readonly ser: string
  readonly pipe: string
  readonly ptydPipe: string
  client!: DaemonClient
  app!: DaemonClient
  readonly seen = new Set<number>()
  readonly screen = new Screen(120, 40)
  /** Everything the pane printed, raw (the screen scrolls; the order of the answers is read here). */
  raw = ''

  constructor() {
    mkdirSync(runRoot, { recursive: true })
    this.root = mkdtempSync(join(runRoot, 'tether-s1-'))
    this.home = join(this.root, 'home')
    this.ser = join(mkdtempSync(join(tmpdir(), 'tether-s1-bench-')), 'ser')
    mkdirSync(this.home); mkdirSync(this.ser)
    const id = randomBytes(4).toString('hex')
    const BS = String.fromCharCode(92)
    const winPipe = (n: string): string => [BS, BS, '.', BS, 'pipe', BS, n].join('')
    this.pipe = process.platform === 'win32' ? winPipe(`tether-s1-${id}`) : join(this.home, 'd.sock')
    this.ptydPipe = process.platform === 'win32' ? winPipe(`tether-s1-ptyd-${id}`) : join(this.home, 'ptyd.sock')
  }

  soul(...args: string[]): void {
    const r = spawnSync(process.execPath, [SOUL_BIN, ...args], { cwd: this.ser, encoding: 'utf8', env: cleanEnv({}), timeout: 120_000 })
    assert.equal(r.status, 0, `soul ${args.join(' ')} failed (${r.status}):\n${`${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-1500)}`)
  }

  async connect(): Promise<void> {
    writeFileSync(join(this.home, 'settings.json'), JSON.stringify({ extensions: { disabled: ['web-bridge', 'browser', 'conductor-claude'] } }))
    const env = cleanEnv({ TETHER_PANEL_HOST: '1', TETHER_PTYD_PIPE: this.ptydPipe, TETHER_SOUL_CMD: `node ${SOUL_BIN}` })
    this.client = await DaemonClient.connect({ home: this.home, pipe: this.pipe, client: 'test', mainPath: MAIN, env, startTimeoutMs: 45_000 })
    this.seen.add(this.client.hello.pid)
    await claim(this.client.hello.pid, { cmdIncludes: MAIN, what: 'tetherd (channels soul inside)' })
    this.client.on('data', (_slotId: string, data: string) => { this.screen.write(data); this.raw += data })
    this.app = await DaemonClient.open(this.pipe, 'app', { home: this.home })
  }

  async state(slotId: string): Promise<SlotState | undefined> {
    return ((await this.client.request({ t: 'list' })).slots ?? []).find((s: SlotState) => s.slotId === slotId)
  }
  daemonLog(): string { const p = join(this.home, 'tetherd.log'); return existsSync(p) ? readFileSync(p, 'utf8') : '' }
  /** The pane's text with no escape sequences and no whitespace (a TUI wraps and pads freely). */
  flat(): string { return this.raw.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Za-z0-9]|\x1b./g, '').replace(/\s+/g, '') }

  async waitFor<T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, timeout = 90_000): Promise<T> {
    const deadline = Date.now() + timeout
    for (;;) {
      const v = await fn()
      if (v) return v
      if (Date.now() > deadline) throw new Error(`timeout (${timeout} ms) waiting for ${what}\n--- daemon log (tail) ---\n${this.daemonLog().slice(-2000)}\n--- screen ---\n${this.screen.text()}`)
      await sleep(250)
    }
  }

  async ask<T = any>(name: string, args?: unknown): Promise<T> {
    return (await this.app.request({ t: 'ext-request', ext: 'channels', name, ...(args !== undefined ? { args } : {}) })).result as T
  }

  async teardown(): Promise<string[]> {
    try {
      const slots: SlotState[] = (await this.client.request({ t: 'list' })).slots ?? []
      for (const s of slots) if (s.pid) await this.client.request({ t: 'stop', slotId: s.slotId }).catch(() => undefined)
      for (const end = Date.now() + 40_000; Date.now() < end; await sleep(250)) {
        if (((await this.client.request({ t: 'list' }).catch(() => ({ slots: [] }))).slots ?? []).every((s: SlotState) => !s.pid)) break
      }
    } catch { /* daemon gone */ }
    try { this.app?.close() } catch { /* gone */ }
    try { await this.client.request({ t: 'shutdown' }) } catch { /* gone */ }
    try { this.client.close() } catch { /* gone */ }
    const host = await HostClient.ping(this.ptydPipe, this.home).catch(() => undefined)
    if (host) this.seen.add(host.pid)
    for (const end = Date.now() + 15_000; [...this.seen].some(pidAlive) && Date.now() < end; await sleep(200));
    for (const pid of [...this.seen].reverse()) {
      if (!pidAlive(pid)) continue
      const owned = await claim(pid, { what: 'channels soul inside e2e process' }).catch(() => undefined)
      if (owned) await killOwned(owned, { tree: true })
    }
    for (const end = Date.now() + 8_000; [...this.seen].some(pidAlive) && Date.now() < end; await sleep(150));
    const left = [...this.seen].filter(pidAlive).map(String)
    for (const dir of [resolve(this.ser, '..'), this.root]) {
      for (let i = 0; i < 5; i++) { try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) } }
    }
    return left
  }
}

const rigs: Rig[] = []
after(async () => { for (const r of rigs) await r.teardown().catch(() => undefined) })

const skip = existsSync(SOUL_BIN) ? false : `the Soul is not available (${SOUL_BIN})`

test('S1: a real Soul launched with --channels tether hears the channel inside: idle opens a turn, busy waits for the turn end, a card waits', { timeout: 1_200_000, skip }, async (t) => {
  const rig = new Rig(); rigs.push(rig)
  const t0 = Date.now()
  const log: string[] = []
  const note = (s: string): void => { const l = `[+${Math.round((Date.now() - t0) / 1000)}s] ${s}`; log.push(l); t.diagnostic(l) }
  const CHANNEL = 'bancada'
  let pane = ''
  const result: Record<string, string> = {}
  const dump = (extra: string): void => {
    evidence('summary.txt', `${log.join('\n')}\n${extra}\n`)
    evidence('daemon-log.txt', rig.daemonLog())
    evidence('soul-screen-final.txt', `${rig.screen.text()}\n`)
    evidence('soul-raw-flat.txt', `${rig.flat()}\n`)
  }
  let left: string[] = []
  try {
    writeFileSync(join(rig.root, 'soul.md'), BEING_SOURCE)
    rig.soul('init', '-f', join(rig.root, 'soul.md'), '--replace')
    rig.soul('profiles', 'create', 'ana-teste', '--name', 'Ana Teste')
    await rig.connect()
    const client = rig.client

    // The person's own Soul pane (no owner: nobody holds it). The default profile `soul` (-g) and the bench's cheap settings.
    // `-g` is load-bearing: without it the soul-cli reads its provider pool from `<ser>/.soul-local`, which a bench being has empty,
    // and every turn fails at the router with `strategy "…" does not offer text/reasoning` (the tether's `soul` profile carries it).
    const args = ['-g', '--model', 'cheap', '--effort', 'low', '-P', 'ana-teste', '--strategy', 'economy', '--yolo']
    pane = (await client.request({ t: 'create', kind: 'soul', cwd: rig.ser, name: 'soul · bancada', args, start: true })).slot!.slotId
    await client.request({ t: 'attach', slotId: pane, cols: 120, rows: 40 })
    const st = await rig.waitFor('the Soul running', async () => { const s = await rig.state(pane); return s?.pid ? s : undefined }, 60_000)
    rig.seen.add(st.pid!)
    // The launch as the OS sees it (the key travels in the env, never on the command line): the door's file and `--channels tether`.
    const cmdline = await rig.waitFor('the Soul command line', () => {
      const r = spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${st.pid} -or $_.ProcessId -eq ${st.pid} } | ForEach-Object { $_.CommandLine }`], { encoding: 'utf8' })
      return /--channels/.test(r.stdout) ? r.stdout : undefined
    }, 20_000).catch(() => '(not found)')
    evidence('launch-cmdline.txt', cmdline)
    note(`launch: --channels tether ${/--channels\s+tether/.test(cmdline)}; door file ${/door[\\/]mcp[\\/]/.test(cmdline)}`)
    const doorFile = join(rig.home, 'door', 'mcp', `${pane}.json`)
    if (existsSync(doorFile)) evidence('door-mcp-file.json', readFileSync(doorFile, 'utf8'))
    const idle = async (what: string, timeout = 150_000): Promise<void> => {
      await rig.waitFor(what, async () => { const s = await rig.state(pane); return s?.status === 'running' && s.turn !== 'busy' && s.attention !== 'waiting' && rig.flat().length > 0 }, timeout)
    }

    const { channel } = await rig.ask('create', { name: CHANNEL, title: 'Bancada de teste' })
    const CH: string = channel.id
    // The route is `inside` once the Soul's stream to the door is open: the launch took the door's server and the channel.
    const members = await rig.waitFor('the Soul joined with route inside', async () => {
      await rig.ask('join', { channel: CH, agent: pane }).catch(() => undefined)
      const m = await rig.ask('members', { channel: CH })
      const me = (m.members as { id: string; path?: string }[]).find((x) => x.id === pane)
      return me?.path === 'inside' ? m : undefined
    }, 120_000)
    note(`members: ${JSON.stringify((members.members as unknown[]).map((x: any) => ({ id: x.id, path: x.path })))}`)
    const launch = rig.daemonLog()
    assert.match(launch, /door: slot \S+: sessão do servidor tether \(era legada[^)]*cliente claude-code/, 'the Soul opened the door session')
    // The entry notice itself goes inside and opens a turn; let it settle.
    await sleep(3000)
    await idle('the Soul idle after the entry notice')
    evidence('0-entry-screen.txt', `${rig.screen.text()}\n`)

    // ---- (a) idle: the line opens a turn ----
    {
      const before = rig.flat().length
      const r = await rig.ask('say', { channel: CH, text: 'Teste de canal (a). Responda aqui na sua guia, sem ferramentas, só com a palavra formada juntando ALF e A.' })
      note(`(a) said; receipt ${JSON.stringify(r.receipts)}`)
      assert.equal(r.receipts[pane], 'inside')
      await rig.waitFor('(a) a turn opened', async () => (await rig.state(pane))?.turn === 'busy', 60_000)
      note('(a) turn busy')
      await rig.waitFor('(a) ALFA on the Soul screen', () => rig.flat().slice(before).includes('ALFA'), 120_000)
      await idle('(a) idle again')
      result.a = 'ok'
      note('(a) ALFA answered')
      evidence('a-screen.txt', `${rig.screen.text()}\n`)
    }

    // ---- (b) busy: the line is sent at once and answered after the turn ----
    {
      const before = rig.flat().length
      client.input(pane, 'Rode no shell o comando: sleep 25 && echo FIMSONO . Depois diga só FEITO.')
      await sleep(400)
      client.input(pane, '\r')
      await rig.waitFor('(b) the person\'s turn busy', async () => (await rig.state(pane))?.turn === 'busy', 60_000)
      await sleep(6000)
      const busy = (await rig.state(pane))?.turn === 'busy'
      const r = await rig.ask('say', { channel: CH, text: 'Teste de canal (b). Responda aqui na sua guia, sem ferramentas, só com a palavra formada juntando BET e A.' })
      note(`(b) said while busy=${busy}; receipt ${JSON.stringify(r.receipts)}`)
      assert.equal(busy, true, 'the Soul was busy when the line went')
      assert.equal(r.receipts[pane], 'inside')
      await rig.waitFor('(b) BETA on the Soul screen', () => rig.flat().slice(before).includes('BETA'), 180_000)
      await idle('(b) idle again')
      const flat = rig.flat().slice(before)
      const sono = flat.lastIndexOf('FIMSONO'), feito = flat.indexOf('FEITO'), beta = flat.lastIndexOf('BETA')
      note(`(b) order: FIMSONO@${sono} FEITO@${feito} BETA@${beta}`)
      assert.ok(feito >= 0 && beta > feito, 'BETA came after the busy turn ended (FEITO)')
      result.b = 'ok'
      evidence('b-screen.txt', `${rig.screen.text()}\n`)
    }

    // ---- (c) a card open: the line waits for the person's answer ----
    if (process.env.S1_SKIP_CARD !== '1') {
      const before = rig.flat().length
      client.input(pane, 'Use a sua ferramenta de perguntar ao usuário (com opções clicáveis) para me perguntar: "Cor?" com as opções Azul e Verde. Não responda nada antes da minha escolha.')
      await sleep(400)
      client.input(pane, '\r')
      const card = await rig.waitFor('(c) a card open', async () => (await rig.state(pane))?.attention === 'waiting', 120_000).catch(() => false)
      if (!card) {
        result.c = 'no card: the Soul did not open one'
        note(`(c) ${result.c}`)
        evidence('c-screen-nocard.txt', `${rig.screen.text()}\n`)
      } else {
        evidence('c-card-screen.txt', `${rig.screen.text()}\n`)
        const r = await rig.ask('say', { channel: CH, text: 'Teste de canal (c). Responda aqui na sua guia, sem ferramentas, só com a palavra formada juntando GAM e A.' })
        note(`(c) said with the card open; receipt ${JSON.stringify(r.receipts)}`)
        await sleep(15_000)
        const early = rig.flat().slice(before).includes('GAMA')
        const still = (await rig.state(pane))?.attention === 'waiting'
        note(`(c) 15 s later: GAMA on screen ${early}; card still open ${still}`)
        evidence('c-waiting-screen.txt', `${rig.screen.text()}\n`)
        client.input(pane, '1')
        await sleep(300)
        client.input(pane, '\r')
        await rig.waitFor('(c) GAMA after the card', () => rig.flat().slice(before).includes('GAMA'), 180_000)
        await idle('(c) idle again').catch(() => undefined)
        evidence('c-screen.txt', `${rig.screen.text()}\n`)
        assert.equal(early, false, 'the line did not jump the open card')
        result.c = still ? 'ok' : 'ok (card closed by itself before 15 s)'
        note(`(c) ${result.c}`)
      }
    }
    dump(JSON.stringify(result))
  } catch (e) {
    dump(`FAILED: ${(e as Error).message}\n${JSON.stringify(result)}`)
    throw e
  } finally {
    left = await rig.teardown()
    note(`left behind: ${JSON.stringify(left)}`)
    evidence('summary.txt', `${log.join('\n')}\n${JSON.stringify(result)}\n`)
  }
  assert.deepEqual(left, [], 'no process left behind')
})
