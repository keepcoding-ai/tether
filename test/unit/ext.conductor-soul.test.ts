// The Soul conductor (C2), unit: the screens of the sonda of 21/11 (soul 0.1.188) through `detect`, and the acts against a fake context
// that records what is written (the gate's side is the daemon's, proven in the E2E). No process, no daemon, no LLM.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { join } from 'node:path'
import { lastAssistantText, sendChunks, soulConductor } from '../../extensions/conductor-soul/conductor.ts'
import { activate, manifest } from '../../extensions/conductor-soul/daemon.ts'
import { readSoulScreen } from '../../extensions/conductor-soul/screen.ts'
import { conductorRegistry, type ConductorContext, type ScreenText } from '../../extensions/for-agents/conductor-api.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'

const W = 120
const RULE = '─'.repeat(W)
const DASH = '  ' + '╌'.repeat(W - 4)
const BOX = ['╭' + '─'.repeat(W - 2) + '╮', '│ ❯' + ' '.repeat(W - 5) + '│', '╰' + '─'.repeat(W - 2) + '╯']
const box = (draft: string): string[] => [BOX[0]!, `│ ❯ ${draft}`.padEnd(W - 1) + '│', BOX[2]!]
const STATUS = '  Agent — │ Model cheap │ Effort ○ low │ Mode ● careful │ 26%'
const HEAD = [' ▌ soul v0.1.188 — by KeepCoding', '   agent    — · operator · mirror · ana-teste', '   hands    workspace', '   › type and Enter to talk │ Esc stops │ Ctrl+U clears │ Ctrl+C twice exits']

const IDLE = [...HEAD, ' ▌ Responda apenas com a palavra OK-UM.', ' ● OK-UM', ' ▪ connected', ...box(''), '  ? for shortcuts                                       2 MCP servers failed · /mcp', STATUS]
const BUSY = [...HEAD, ' ▌ Responda apenas com a palavra OK-UM.', ' ∘ Julienning…', '   └  Tip: Lend the agent another folder with /mount', ...box(''), '  Esc stops │ Enter queues after this turn', STATUS]
const QUEUED = [...HEAD, ' ● Bash(node -e "setTimeout(()=>{},25000)") (7s)', '  1 message queued for next turn', '  ❯ Depois diga so: FILA2', ...box(''), '  Esc stops │ Enter queues after this turn', STATUS]
const INTERRUPTED = [...HEAD, ' ▌ Escreva uma historia longa de 1500 palavras sobre um farol.', ' ● Aqui está a história.', '   └  Interrupted · What should Soul do instead?', ' ▪ connected', ...box(''), '  ? for shortcuts', STATUS]
const PERMISSION = [
  ...HEAD, ' ▌ Use a ferramenta Bash para rodar: node -e "setTimeout(()=>{},20000)" e depois diga PRONTO.', ' ● Bash(node -e "setTimeout(()=>{},20000)")', RULE,
  ' Bash command', '  node -e "setTimeout(()=>{},20000)"', '  Espera de 20 segundos com node', '', ' This command requires approval', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '',
  ' Esc to cancel · Tab to amend · ctrl+e to explain · Ctrl+d to show debug info', ' ? waiting for your answer', ...box('answer the card above'), STATUS,
]
const PERMISSION_WRITE = [
  ...HEAD, ' ● Write(workspace/a.txt)', RULE, ' Create file', ' workspace/a.txt', DASH, '  oi', DASH, ' Do you want to create a.txt?', ' ❯ 1. Yes', '   2. No',
  ' Esc to cancel · Tab to amend · Ctrl+d to show debug info', ' ? waiting for your answer', ...box('answer the card above'), STATUS,
]
const TRUST = [
  '╭' + '─'.repeat(W - 2) + '╮', '│ Accessing workspace:', '│', '│ \\work\\bench', '│', "│ Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source",
  "│ project, or work from your team). If not, take a moment to review what's in this folder first.", '│', "│ Soul'll be able to read, edit, and execute files here.", '│', '│ Security guide', '│',
  '│ ❯ Yes, I trust this folder', '│   No, exit', '│', '│ Enter to confirm · Esc to cancel', '╰' + '─'.repeat(W - 2) + '╯',
]
const PROFILE = [
  ' boot · profile selection', '', ' ███████╗   ██████╗   ██╗   ██╗  ██╗', ' ────────────────────────────────────────', '', ' Soul — how do you want to enter?', ' A profile keeps your own memory separate from anyone else\'s.', '',
  ' ❯ 1  Ana Teste              ana-teste · used 1m ago', '   ────────────────────────────────────────', "   7  Continue as gugac      this computer's login, no setup", '   8  Create a new profile', '   9  User Agent Mode        the agent\'s own self — maintenance',
  '   ────────────────────────────────────────', '   0  Exit                   leave without opening a session', '', ' i  [ ] Open isolated   own worktree for this session',
]
const SLASH_MENU = [...HEAD, ...box('/c'), '  ❯ /copy                Copy the latest agent response to the clipboard', '    /cost                Show the total cost and duration of the current session', '  Tab completes │ Enter runs │ Esc closes the list', STATUS]

describe('conductor-soul: the screens of the sonda', () => {
  test('permission card: Bash, with only yes and no (there is no always); the card text is what is under the rule', () => {
    const s = readSoulScreen(PERMISSION)
    assert.equal(s.kind, 'permission')
    if (s.kind !== 'permission') return
    assert.equal(s.card.title, 'Bash command')
    assert.deepEqual(s.card.options.map((o) => o.id), ['yes', 'no'])
    assert.deepEqual(s.options.map((o) => o.n), [1, 2])
    assert.match(s.card.text, /setTimeout/)
    assert.match(s.card.text, /Do you want to proceed\?/)
    assert.doesNotMatch(s.card.text, /Esc to cancel/)
    assert.doesNotMatch(s.card.text, /Bash\(node/, 'the transcript above the rule is not the card')
  })

  test('permission card: Write has its own title and question', () => {
    const s = readSoulScreen(PERMISSION_WRITE)
    assert.equal(s.kind, 'permission')
    if (s.kind === 'permission') {
      assert.equal(s.card.title, 'Create file')
      assert.match(s.card.text, /Do you want to create a\.txt\?/)
    }
  })

  test('busy, queued, idle, interrupted (idle), a slash menu and a text it does not know', () => {
    assert.equal(readSoulScreen(BUSY).kind, 'busy')
    assert.equal(readSoulScreen(QUEUED).kind, 'busy')
    assert.equal(readSoulScreen(IDLE).kind, 'idle')
    assert.equal(readSoulScreen(INTERRUPTED).kind, 'idle')
    assert.equal(readSoulScreen(SLASH_MENU).kind, 'unknown')
    assert.equal(readSoulScreen(['', '']).kind, 'unknown')
    assert.equal(readSoulScreen(['PS C:\\> dir']).kind, 'unknown')
  })

  test('first-open dialogs: trust and profile', () => {
    const t = readSoulScreen(TRUST)
    assert.equal(t.kind, 'dialog')
    if (t.kind === 'dialog') assert.deepEqual([t.dialog, t.card.options.map((o) => o.label)], ['trust', ['Yes, I trust this folder', 'No, exit']])
    const p = readSoulScreen(PROFILE)
    assert.equal(p.kind, 'dialog')
    if (p.kind === 'dialog') assert.deepEqual([p.dialog, p.onProfile], ['profile', true])
    const other = readSoulScreen(PROFILE.map((l) => l.replace('❯ 1', '  1').replace('  8  Create', '❯ 8  Create')))
    if (other.kind === 'dialog') assert.equal(other.onProfile, false, 'a highlighted row that is not a named profile is not answered')
  })

  test('an old card in the scrollback above an idle screen is not a card', () => {
    const old = [' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel · Tab to amend', ' ? waiting for your answer', ...Array.from({ length: 20 }, () => '   texto'), ...IDLE]
    assert.equal(readSoulScreen(old).kind, 'idle')
  })
})

// ---- the acts, against a fake context ----------------------------------------------------------------------------
type Files = Record<string, string>
function fakeCtx(screens: string[][], files: Files = {}, slotOver: Partial<SlotState> = {}): { ctx: ConductorContext; writes: { data: string; waitMs?: number }[]; keys: { keys: string[]; gapMs?: number }[] } {
  let i = 0
  const writes: { data: string; waitMs?: number }[] = []
  const keys: { keys: string[]; gapMs?: number }[] = []
  const slot = { slotId: 'p1', kind: 'soul', status: 'running', cwd: '\\work\\ser', ...slotOver } as unknown as SlotState
  const ctx: ConductorContext = {
    target: { paneId: 'p1', type: 'terminal', slot },
    slot: () => slot,
    agent: undefined,
    screen: async (): Promise<ScreenText> => ({ screen: screens[Math.min(i, screens.length - 1)]!, history: [], cols: 120, rows: 40, end: 0 }),
    write: async (c) => { writes.push(...c) },
    // The next screen of the script appears after a key (the agent reacting).
    keys: async (k, o) => { keys.push({ keys: [...k], ...(o?.gapMs !== undefined ? { gapMs: o.gapMs } : {}) }); i++ },
    io: {
      tryReadText: async (p: string) => files[p],
      exists: async (p: string) => p in files,
      stat: async (p: string) => ({ size: 1, mtimeMs: files[p] === undefined ? 0 : Date.now() - 60_000, isFile: true, isDirectory: false }),
      readdir: async (p: string) => {
        const names = new Set(Object.keys(files).filter((f) => f.startsWith(p + '\\')).map((f) => f.slice(p.length + 1).split('\\')[0]!))
        if (names.size === 0) throw new Error('ENOENT')
        return [...names].map((name) => ({ name, isFile: false, isDirectory: true }))
      },
    } as unknown as ConductorContext['io'],
    home: 'C:\\home',
    log: () => {},
  }
  return { ctx, writes, keys }
}
const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => p.then(() => undefined, (e: { code?: string }) => e.code)

describe('conductor-soul: the acts', () => {
  test('matches a soul pane only, watches, and leaves type, keys and read to the terminal conductor', () => {
    assert.equal(manifest.id, 'conductor-soul')
    assert.deepEqual(manifest.requires, ['for-agents'])
    assert.equal(soulConductor.match({ paneId: 'a', type: 'terminal', slot: { kind: 'soul' } as SlotState }), 10)
    assert.equal(soulConductor.match({ paneId: 'a', type: 'terminal', slot: { kind: 'claude' } as SlotState }), undefined)
    assert.equal(soulConductor.match({ paneId: 'a', type: 'note' }), undefined)
    assert.equal(soulConductor.watch, true)
    for (const absent of ['read', 'type', 'keys']) assert.equal((soulConductor as unknown as Record<string, unknown>)[absent], undefined)
    assert.deepEqual(soulConductor.capabilities.map((c) => c.id), ['send', 'interrupt', 'answer', 'command'])
  })

  test('activate registers once, even activated twice', () => {
    const d = activate(undefined as never)
    try {
      assert.equal(conductorRegistry.get('soul'), soulConductor)
      assert.deepEqual(activate(undefined as never), [])
    } finally { for (const x of d) x.dispose() }
  })

  test('send: one line is text, 130 ms, Enter; several lines are a bracketed paste, then Enter; no escape reaches the terminal', async () => {
    assert.deepEqual(sendChunks('olá'), [{ data: 'olá' }, { data: '\r', waitMs: 130 }])
    assert.deepEqual(sendChunks('a\nb\n'), [{ data: '\x1b[200~a\rb\x1b[201~' }, { data: '\r', waitMs: 130 }])
    assert.deepEqual(sendChunks('x\x1b[201~y'), [{ data: 'x[201~y' }, { data: '\r', waitMs: 130 }])
    assert.throws(() => sendChunks('  \n'), { code: 'bad-request' })
    const f = fakeCtx([IDLE])
    assert.equal((await soulConductor.send!(f.ctx, 'um\ndois')).proven, true)
    assert.equal(f.writes.length, 2)
    const busy = fakeCtx([BUSY])
    await soulConductor.send!(busy.ctx, 'depois')
    assert.equal(busy.writes.length, 2, 'typing while a turn runs is allowed: it queues')
  })

  test('send and command write nothing over a card or a dialog', async () => {
    for (const screen of [PERMISSION, TRUST]) {
      const f = fakeCtx([screen])
      assert.equal(await codeOf(soulConductor.send!(f.ctx, '1')), 'busy')
      assert.equal(await codeOf(soulConductor.command!(f.ctx, 'compact')), 'busy')
      assert.deepEqual(f.writes, [])
    }
  })

  test('answer: yes is 1, no is 2, a number is itself, always is unsupported and types nothing; no card is no-request', async () => {
    for (const [choice, digit] of [['yes', '1'], ['no', '2'], ['2', '2']] as const) {
      const f = fakeCtx([PERMISSION])
      assert.deepEqual(await soulConductor.answer!(f.ctx, choice), { value: undefined, proven: true })
      assert.deepEqual(f.writes, [{ data: digit }], choice)
    }
    const a = fakeCtx([PERMISSION])
    assert.equal(await codeOf(soulConductor.answer!(a.ctx, 'always')), 'unsupported')
    assert.deepEqual(a.writes, [])
    assert.deepEqual(a.keys, [])
    assert.equal(await codeOf(soulConductor.answer!(fakeCtx([PERMISSION]).ctx, '3')), 'bad-request')
    assert.equal(await codeOf(soulConductor.answer!(fakeCtx([IDLE]).ctx, 'yes')), 'no-request')
  })

  test('interrupt: one esc, then rereads the screen: stopped when the composer is back with no turn', async () => {
    const f = fakeCtx([BUSY, INTERRUPTED])
    assert.deepEqual(await soulConductor.interrupt!(f.ctx), { value: { stopped: true }, proven: true })
    assert.deepEqual(f.keys, [{ keys: ['esc'] }])
  })

  test('command: Ctrl+U, the slash line, Enter; compact and clear are proven, the rest is not', async () => {
    const f = fakeCtx([IDLE])
    assert.deepEqual(await soulConductor.command!(f.ctx, 'compact'), { value: undefined, proven: true })
    assert.deepEqual(f.writes, [{ data: '\x15' }, { data: '/compact' }, { data: '\r', waitMs: 130 }])
    assert.equal((await soulConductor.command!(fakeCtx([BUSY]).ctx, 'compact')).proven, true, 'busy: it queues, the sonda proved it')
    assert.equal((await soulConductor.command!(fakeCtx([IDLE]).ctx, 'clear')).proven, true)
    assert.equal((await soulConductor.command!(fakeCtx([IDLE]).ctx, 'model', 'cheap')).proven, false)
    assert.equal(await codeOf(soulConductor.command!(fakeCtx([IDLE]).ctx, '../x')), 'bad-request')
  })

  test('detect: card, idle (also after an interrupt), busy, dialog', async () => {
    const d = async (s: string[]): Promise<string> => (await soulConductor.detect!(fakeCtx([s]).ctx)).state
    assert.deepEqual([await d(PERMISSION), await d(IDLE), await d(INTERRUPTED), await d(BUSY), await d(TRUST), await d(PROFILE)], ['permission', 'idle', 'idle', 'busy', 'dialog', 'dialog'])
  })

  test('launchArgs: --model and --effort, both proven by the sonda', () => {
    assert.deepEqual(soulConductor.launchArgs!({ model: 'cheap', effort: 'low', cwd: 'x' }), { value: ['--model', 'cheap', '--effort', 'low'], proven: true })
    assert.deepEqual(soulConductor.launchArgs!({ cwd: 'x' }), { value: [], proven: true })
  })

  test('boot: answers the trust dialog and the profile dialog once each (Enter), and ends at the composer; with none it sends no key', async () => {
    const f = fakeCtx([TRUST, PROFILE, IDLE])
    await soulConductor.boot!(f.ctx)
    assert.deepEqual(f.keys, [{ keys: ['enter'] }, { keys: ['enter'] }])
    const g = fakeCtx([IDLE])
    await soulConductor.boot!(g.ctx)
    assert.deepEqual(g.keys, [])
    const other = fakeCtx([PROFILE.map((l) => l.replace('❯ 1', '  1').replace('  8  Create', '❯ 8  Create'))])
    await soulConductor.boot!(other.ctx)
    assert.deepEqual(other.keys, [], 'a highlighted row that is not a named profile is the person\'s')
  })

  test('lastAnswer: the last assistant text of the local session, found by the binding; `at` is that line\'s timestamp', async () => {
    const dir = join('\\work\\ser', '.soul', 'profiles', 'ana-teste', 'sessions', 's1')
    const line = (type: string, content: unknown[], timestamp: string): string => JSON.stringify({ type, timestamp, message: { content } })
    const jsonl = [
      line('assistant', [{ type: 'text', text: 'primeira' }], '2026-11-21T16:00:00.000Z'),
      line('user', [{ type: 'text', text: 'oi' }], '2026-11-21T16:01:00.000Z'),
      line('assistant', [{ type: 'thinking', thinking: 'x' }], '2026-11-21T16:01:05.000Z'),
      line('assistant', [{ type: 'text', text: 'a resposta' }, { type: 'text', text: 'fim' }], '2026-11-21T16:01:09.000Z'),
      line('assistant', [{ type: 'tool_use', name: 'Bash' }], '2026-11-21T16:01:10.000Z'),
      '{half',
    ].join('\n')
    const files = { [join(dir, 'session.jsonl')]: jsonl }
    const f = fakeCtx([IDLE], files, { binding: { sessionId: 's1', cwd: '\\work\\ser' } as SlotState['binding'] })
    assert.deepEqual(await soulConductor.lastAnswer!(f.ctx), { value: { text: 'a resposta\nfim', at: '2026-11-21T16:01:09.000Z', source: 'session', turn: 's1' }, proven: true })
    assert.equal(await soulConductor.lastAnswer!(fakeCtx([IDLE], files).ctx), undefined, 'no binding yet')
    assert.equal(await soulConductor.lastAnswer!(fakeCtx([IDLE], {}, { binding: { sessionId: 's1', cwd: '\\work\\ser' } as SlotState['binding'] }).ctx), undefined, 'no local session (a server-held one)')
    assert.equal(lastAssistantText('{"type":"user"}'), undefined)
    const named = fakeCtx([IDLE], files, { binding: { sessionId: 's1', cwd: '\\work\\ser', resume: { cwd: 'x', args: ['-P', 'ana-teste', '-g'] } } as SlotState['binding'] })
    assert.equal((await soulConductor.lastAnswer!(named.ctx))?.value.text, 'a resposta\nfim')
  })

  test('lastAnswer right after a turn waits for the answer of that turn (the report comes before the file); long after, it does not wait', async () => {
    const dir = join('\\work\\ser', '.soul', 'profiles', 'ana-teste', 'sessions', 's1')
    const file = join(dir, 'session.jsonl')
    const line = (text: string, at: number): string => JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { content: [{ type: 'text', text }] } })
    const now = Date.now()
    const old = line('anterior', now - 60_000)
    const fresh = `${old}
${line('desta vez', now - 300)}`
    const files: Files = { [file]: old }
    const f = fakeCtx([IDLE], files, { binding: { sessionId: 's1', cwd: '\\work\\ser' } as SlotState['binding'], idleSince: new Date(now).toISOString() })
    let reads = 0
    const base = f.ctx.io.tryReadText
    f.ctx.io.tryReadText = async (p: string) => { reads++; if (reads === 3) files[file] = fresh; return base(p) }
    assert.equal((await soulConductor.lastAnswer!(f.ctx))?.value.text, 'desta vez')
    assert.ok(reads >= 3)
    const late = fakeCtx([IDLE], { [file]: old }, { binding: { sessionId: 's1', cwd: '\\work\\ser' } as SlotState['binding'], idleSince: new Date(now - 60_000).toISOString() })
    const t0 = Date.now()
    assert.equal((await soulConductor.lastAnswer!(late.ctx))?.value.text, 'anterior')
    assert.ok(Date.now() - t0 < 500, 'a turn that ended a minute ago is not waited for')
  })
})
