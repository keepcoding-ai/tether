// E2: measures what a channel line becomes when it reaches a Soul or a Codex BY THE TERMINAL (the delivery of the core).
// Not a test and not product code: a bench run, one engine per run, never both alive together.
//   node test/manual/channels-terminal/run.mjs <codex|soul> [reps] [evidenceDir]
// A PRIVATE tetherd (own home, own pipe, own pane host) is started the way the tests start it; the real tether is never touched.
// The agent runs in a pane commanded by an owner shell (the owner script below), so the pane is `held` and the delivery may type.
// The person (moderator, an `app` client) creates a channel, joins the agent and says lines of four kinds, `reps` times each:
//   short-1 (one line)   short-n (three lines)   long-1 (~300 chars, one line)   long-n (~300 chars, three lines); all with accents and "·".
// For each line: what the delivery says (receipts) and what the pane shows. Nothing here reads a key or a credential.
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, appendFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'

for (const k of Object.keys(process.env)) if (/^(CLAUDE|TETHER_|CODEX_HOME$|NODE_TEST_CONTEXT$)/i.test(k)) delete process.env[k]
const WT = process.env.E2_WORKTREE ?? 'D:/atrium/.tmp/wt/tether-channels'
const SOUL_BIN = process.env.E2_SOUL_BIN ?? 'D:/atrium/workspace/soul-cli/bin/soul'
const [engine, repsArg, evArg] = [process.argv[2], process.argv[3], process.argv[4]]
if (engine !== 'codex' && engine !== 'soul') { console.error('usage: run.mjs <codex|soul> [reps] [evidenceDir]'); process.exit(2) }
const REPS = Number(repsArg ?? 2)
const ONE_PANE = process.env.E2_ONE_PANE === '1' // one new pane per line, no Enter rescue
const EV = evArg ?? `D:/atrium/.tmp/tether-agents/onda-3/e2/${engine}`
mkdirSync(EV, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const imp = (p) => import(pathToFileURL(join(WT, p)).href)
const { DaemonClient } = await imp('src/daemon/client.ts')
const { HostClient } = await imp('src/procd/client.ts')
const { claim, killOwned } = await imp('test/kill.ts')
const { Screen } = await imp('test/e2e/harness.ts')

const root = mkdtempSync(join(tmpdir(), `tether-e2-${engine}-`))
const home = join(root, 'home'), work = join(root, 'owner'), bench = join(mkdtempSync(join(tmpdir(), 'tether-e2-bench-')), 'ser')
mkdirSync(home); mkdirSync(work); mkdirSync(bench)
const BS = String.fromCharCode(92)
const id = randomBytes(4).toString('hex')
const winPipe = (n) => [BS, BS, '.', BS, 'pipe', BS, n].join('')
const pipe = winPipe(`tether-e2-${id}`), ptydPipe = winPipe(`tether-e2-ptyd-${id}`)
const logf = join(EV, 'run.log')
writeFileSync(logf, '')
const note = (s) => { const l = `${new Date().toISOString()} ${s}`; appendFileSync(logf, l + '\n'); console.log(l) }

// The owner: a node process in a shell slot; runs each command of cmd.jsonl as `tether agents ...` with the slot's own environment.
const ownerScript = String.raw`
const fs = require('node:fs'), path = require('node:path')
const { spawnSync } = require('node:child_process')
const dir = ${JSON.stringify(work)}
const cmdFile = path.join(dir, 'cmd.jsonl'), outFile = path.join(dir, 'out.jsonl'), toldFile = path.join(dir, 'told.log')
let offset = 0
process.stdout.write('OWNER READY\r\n')
if (process.stdin.setRawMode) process.stdin.setRawMode(true)
process.stdin.on('data', (d) => fs.appendFileSync(toldFile, d.toString().replace(/\r/g, '\n')))
setInterval(() => {
  let size = 0
  try { size = fs.statSync(cmdFile).size } catch { return }
  if (size <= offset) return
  const chunk = fs.readFileSync(cmdFile).subarray(offset, size).toString('utf8'); offset = size
  for (const line of chunk.split('\n').filter(Boolean)) {
    const { id, argv } = JSON.parse(line)
    const r = spawnSync(process.execPath, [process.env.TETHER_CLI, 'agents', ...argv, '--json'], { encoding: 'utf8', env: process.env, timeout: 120000 })
    fs.appendFileSync(outFile, JSON.stringify({ id, argv, status: r.status, stdout: r.stdout, stderr: r.stderr }) + '\n')
  }
}, 150)
`

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

const cleanEnv = (extra) => Object.assign({ ...process.env }, extra)
const soul = (...args) => {
  const r = spawnSync(process.execPath, [SOUL_BIN, ...args], { cwd: bench, encoding: 'utf8', env: cleanEnv({}), timeout: 120_000 })
  if (r.status !== 0) throw new Error(`soul ${args.join(' ')} failed: ${(r.stdout ?? '') + (r.stderr ?? '')}`.slice(-1200))
  return `${r.stdout ?? ''}${r.stderr ?? ''}`
}

// The four kinds of line. Every body starts with its own tag (so the pane can be searched for it) and asks for a bare answer, to keep turns cheap.
const FILL = 'Conferência · revisão do relatório, ação pendente, atenção às coerências e às sessões já concluídas; ainda não há nenhum impedimento, só observações. '
const pad = (s, n) => { let o = s; while (o.length < n) o += FILL; return o.slice(0, n).trimEnd() }
function body(kind, tag) {
  const ask = 'Responda só: ok.'
  if (kind === 'short-1') return `${tag} · olá, conferência concluída. ${ask}`
  if (kind === 'short-n') return `${tag} · olá, conferência concluída.\nSegunda linha: ação · atenção.\n${ask}`
  if (kind === 'long-1') return `${tag} · ${pad(FILL.repeat(3), 270)} ${ask}`
  return `${tag} · ${pad(FILL, 90)}\n${pad(FILL, 90)}\n${pad(FILL, 80)} ${ask}`
}

const env = cleanEnv({ TETHER_PANEL_HOST: '1', TETHER_PTYD_PIPE: ptydPipe, ...(engine === 'soul' ? { TETHER_SOUL_CMD: `node ${SOUL_BIN}` } : {}) })
writeFileSync(join(home, 'settings.json'), JSON.stringify({ extensions: { disabled: ['web-bridge', 'browser'] } }))
const MAIN = join(WT, 'src/daemon/main.ts').replace(/\//g, BS)
const seen = new Set()
const screens = new Map()
let client, app
const states = async () => (await client.request({ t: 'list' })).slots ?? []
const stateOf = async (slot) => (await states()).find((s) => s.slotId === slot)
const track = (s) => { if (s?.pid) seen.add(s.pid) }
async function waitFor(what, fn, timeout = 60_000, every = 250) {
  const end = Date.now() + timeout
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timeout waiting for ${what}`); await sleep(every) }
}

async function teardown() {
  try { for (const s of await states()) if (s.pid) await client.request({ t: 'stop', slotId: s.slotId }).catch(() => {}) } catch {}
  await sleep(4000)
  try { app?.close() } catch {}
  try { await client.request({ t: 'shutdown' }) } catch {}
  try { client.close() } catch {}
  const host = await HostClient.ping(ptydPipe).catch(() => undefined); if (host) seen.add(host.pid)
  await sleep(2000)
  for (const pid of [...seen].reverse()) { const o = await claim(pid, { what: 'e2 bench process' }).catch(() => undefined); if (o) await killOwned(o, { tree: true }).catch(() => {}) }
  for (const dir of [join(bench, '..'), root]) for (let i = 0; i < 5; i++) { try { rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(300) } }
}

const results = []
try {
  if (engine === 'soul') {
    const source = join(root, 'soul.md'); writeFileSync(source, BEING_SOURCE)
    soul('init', '-f', source, '--replace'); soul('profiles', 'create', 'ana-teste', '--name', 'Ana Teste')
    note('soul bench being born by the engine verbs (init, profiles create)')
  }
  client = await DaemonClient.connect({ home, pipe, client: 'test', mainPath: MAIN, env, startTimeoutMs: 45_000 })
  seen.add(client.hello.pid); await claim(client.hello.pid, { cmdIncludes: MAIN, what: 'tetherd (e2)' })
  app = await DaemonClient.open(pipe, 'app')
  client.on('data', (slotId, data) => { const s = screens.get(slotId) ?? new Screen(120, 40); screens.set(slotId, s); s.write(data) })
  const req = (name, args) => app.request({ t: 'ext-request', ext: 'channels', name, ...(args !== undefined ? { args } : {}) }).then((r) => r.result)
  let nextId = 1
  const verb = async (...argv) => {
    const id = nextId++
    appendFileSync(join(work, 'cmd.jsonl'), JSON.stringify({ id, argv }) + '\n')
    const out = await waitFor(`owner outcome of agents ${argv[0]}`, () => {
      const f = join(work, 'out.jsonl'); if (!existsSync(f)) return
      return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((o) => o.id === id)
    }, 150_000)
    const parse = (s) => { try { return JSON.parse(s) } catch { return {} } }
    return { ok: out.status === 0, data: parse(out.status === 0 ? out.stdout : out.stderr), err: out.stderr.trim() }
  }

  // the owner shell, owner of the desk "cena" and of itself
  const ownerFile = join(root, 'owner.cjs'); writeFileSync(ownerFile, ownerScript)
  const owner = (await client.request({ t: 'create', kind: 'shell', cwd: work, name: 'dono', args: [process.execPath, ownerFile], start: true })).slot.slotId
  track(await waitFor('owner running', async () => { const s = await stateOf(owner); return s?.status === 'running' ? s : undefined }))
  const mapOf = (cena, casa) => ({ desks: [{ id: 'cena', name: 'cena', kind: 'queue', panes: cena.map((p) => ({ id: p, type: 'terminal' })) }, { id: 'casa', name: 'casa', kind: 'queue', panes: casa.map((p) => ({ id: p, type: 'terminal' })) }, { id: 'sistema', name: 'sistema', kind: 'system', panes: [] }], drawer: [] })
  await client.request({ t: 'desk-map', map: mapOf([], [owner]) })
  const since = new Date().toISOString()
  for (const [kind, objectId] of [['desk', 'cena'], ['pane', owner]]) await client.request({ t: 'object-set', ext: 'for-agents', kind, objectId, key: 'owner', value: { owner, since, givenBy: 'user' } })
  await waitFor('owner sees its desk', async () => { const v = await verb('list'); return v.ok && v.data.desks?.some((d) => d.id === 'cena') ? v : undefined }, 60_000)

  // the agent, opened by the owner (so its pane is commanded, hence `held`)
  const opened = engine === 'codex'
    ? await verb('open', 'codex', bench, '--model', 'gpt-5.6-luna', '--effort', 'low', '--name', 'codex · conferência', '--json', '{"args":["-a","never","-s","read-only"]}')
    : await verb('open', 'soul', bench, '--profile', 'soul', '--model', 'cheap', '--effort', 'low', '--name', 'soul · bancada', '--json', '{"args":["--strategy","economy","-P","ana-teste"]}')
  if (!opened.ok) throw new Error(`open: ${opened.err}`)
  let pane = String(opened.data.pane), channel = '', panes = 0
  const openArgs = () => engine === 'codex'
    ? ['open', 'codex', bench, '--model', 'gpt-5.6-luna', '--effort', 'low', '--name', 'codex · conferência', '--json', '{"args":["-a","never","-s","read-only"]}']
    : ['open', 'soul', bench, '--profile', 'soul', '--model', 'cheap', '--effort', 'low', '--name', 'soul · bancada', '--json', '{"args":["--strategy","economy","-P","ana-teste"]}']
  // Takes `pane` to its prompt, then makes a NEW channel and joins it (a pane that held a stuck line is never reused: its box is dirty).
  async function ready() {
    track(await waitFor('pane pid', async () => { const s = await stateOf(pane); return s?.pid ? s : undefined }))
    await client.request({ t: 'desk-map', map: mapOf([pane], [owner]) })
    await client.request({ t: 'attach', slotId: pane, cols: 120, rows: 40 })
    const booted = await waitFor('agent at its prompt', async () => { const v = await verb('read-screen', pane); return v.ok && v.data.state === 'idle' ? v : undefined }, 150_000)
    panes++
    if (panes === 1) writeFileSync(join(EV, 'screen-0-booted.txt'), `${booted.data.text ?? JSON.stringify(booted.data)}\n`)
    note(`pane ${pane} (${engine}) booted and idle`)
    const created = await req('create', { name: `bancada-${panes}`, title: `Bancada E2 ${panes}` })
    channel = created.channel?.id ?? created.channel
    const joined = await req('join', { channel, agent: pane })
    note(`channel ${JSON.stringify(channel)} created; join: ${JSON.stringify(joined)}`)
    const members = await req('members', { channel })
    note(`members: ${JSON.stringify(members.members?.map((m) => ({ name: m.name, path: m.path, alive: m.alive })))}`)
  }
  await ready()

  // What one delivery became: SUBMITTED when the agent answered below the tag, STUCK when the tag is still in the box with nothing of
  // the agent's own after it, GONE when it scrolled away. Read from the pane, not from the daemon's busy flag (a heuristic).
  // A stuck line is RESCUED with one Enter (so the daemon sees a real turn and its state stays coherent) and the run goes on.
  async function measure(kind, tag, text, send) {
    const t0 = Date.now()
    let busySeen = false, busyAt
    const watch = setInterval(async () => { try { const s = await stateOf(pane); if (s?.turn === 'busy' && !busySeen) { busySeen = true; busyAt = Date.now() - t0 } } catch {} }, 300)
    const receipt = await send()
    await waitFor('the line on the screen', async () => (screens.get(pane)?.text() ?? '').includes(tag), 60_000, 300).catch(() => undefined)
    // a turn may start; wait for it to end, then calm
    await sleep(5000)
    // a stuck line leaves the daemon's turn mark busy: never fail the run on it, the verdict comes from the screen
    await waitFor('turn end', async () => { const s = await stateOf(pane); return s && s.turn !== 'busy' }, ONE_PANE ? 60_000 : 150_000, 500).catch(() => undefined)
    await sleep(4000)
    clearInterval(watch)
    const screen = screens.get(pane)?.text() ?? '(none)'
    const lines = screen.split('\n')
    const tagLines = lines.map((l, i) => [i, l]).filter(([, l]) => l.includes(tag)).map(([i]) => i)
    const lastAnswer = lines.map((l, i) => [i, l]).filter(([, l]) => /Worked for|^\s*[•●]\s/.test(l)).map(([i]) => i).at(-1) ?? -1
    const verdict = tagLines.length === 0 ? 'gone' : tagLines[0] < lastAnswer ? 'submitted' : 'stuck'
    const rec = { n: results.length + 1, tag, kind, chars: text?.length, lines: text?.split('\n').length, receipt, verdict, daemonBusySeen: busySeen, busyAfterMs: busyAt, tagOnScreenLines: tagLines, lastAnswerRow: lastAnswer }
    results.push(rec)
    writeFileSync(join(EV, `screen-${String(rec.n).padStart(2, '0')}-${kind}.txt`), `# ${JSON.stringify(rec)}\n# sent text (JSON): ${JSON.stringify(text ?? null)}\n${screen}\n`)
    if (verdict === 'stuck' && !ONE_PANE) {
      client.input(pane, '\r')
      await sleep(8000)
      await waitFor('turn end after the rescue', async () => { const s = await stateOf(pane); return s && s.turn !== 'busy' }, 150_000, 500)
      await sleep(6000)
      const after = screens.get(pane)?.text() ?? ''
      rec.rescuedByEnter = true
      rec.answeredAfterEnter = after.split('\n').some((l, i, a) => i > a.findIndex((x) => x.includes(tag)) && /Worked for|^\s*[•●]\s/.test(l))
      writeFileSync(join(EV, `screen-${String(rec.n).padStart(2, '0')}-${kind}-after-enter.txt`), `${after}\n`)
    }
    note(JSON.stringify(rec))
    writeFileSync(join(EV, 'results.json'), JSON.stringify(results, null, 2))
    return rec
  }

  // the entry notice (long, several sentences): a delivery of its own, measured first; it arrives by itself after the join
  await measure('entry', 'você entrou em', undefined, async () => { await req('join', { channel, agent: pane }).catch(() => undefined); return 'n/a (join notice)' })

  const kinds = ['short-1', 'short-n', 'long-1', 'long-n']
  let n = 0
  for (let rep = 1; rep <= REPS; rep++) {
    for (const kind of kinds) {
      n++
      const tag = `E2${engine === 'codex' ? 'C' : 'S'}${String(n).padStart(2, '0')}`
      const text = body(kind, tag)
      if (ONE_PANE && n > 1) {
        // a brand-new pane (and channel) per line, no rescue: the entry notice is measured on each, then the line
        await client.request({ t: 'stop', slotId: pane }).catch(() => {})
        const again = await verb(...openArgs())
        if (!again.ok) throw new Error(`open: ${again.err}`)
        pane = String(again.data.pane)
        await ready()
        await measure('entry', 'você entrou em', undefined, async () => 'n/a (join notice)')
      }
      await measure(kind, tag, text, async () => {
        const said = await req('say', { channel, text })
        return Object.values(said.receipts ?? {})[0]
      })
    }
  }
  note('done')
} catch (e) {
  note(`ERROR ${e?.stack ?? e}`)
  try { if (typeof pane !== 'undefined') writeFileSync(join(EV, 'screen-error.txt'), screens.get(pane)?.text() ?? '') } catch {}
  process.exitCode = 1
} finally {
  await teardown().catch((e) => note(`teardown: ${e}`))
  note(`left alive: ${[...seen].length} tracked pids were handled`)
}
