// The Claude conductor (C1), unit: the screens of the sonda of 21/11 (Claude Code 2.1.330) through `detect`, and the acts against a fake
// context that records what is written (the gate's side is the daemon's, proven in the E2E). No process, no daemon, no LLM.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { claudeConductor, sendChunks } from '../../extensions/conductor-claude/conductor.ts'
import { manifest } from '../../extensions/conductor-claude/daemon.ts'
import { readClaudeScreen } from '../../extensions/conductor-claude/screen.ts'
import type { ConductorContext, ScreenText } from '../../extensions/for-agents/conductor-api.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'

const RULE = '─'.repeat(112)
const DASH = '╌'.repeat(112)
const HEAD = [' ▐▛███▛█   Claude Code v2.1.330', '▝▜██████▀  Haiku 5.5 · Claude Ultra', ' ▝▝   ▝▝   ~\\work\\bench']
const prompt = (footer: string, draft = ''): string[] => [RULE, `❯ ${draft}`, RULE, `  ${footer}`]

const IDLE = [...HEAD, '❯ Reply with only the word TWO', '● TWO', '✻ Baked for 1s · done 13:46', ...prompt('⏵⏵ auto mode on (shift+tab to cycle)')]
const BUSY = [...HEAD, '❯ Use the Bash tool to run exactly this command: node -e "setTimeout(()=>{},40000)"', '● Running node sleep command for 40 seconds', '  ⎿  $ node -e "setTimeout(()=>{},40000)"', '· Clauding… (6s · ↓ 99 tokens)', ...prompt('⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt')]
const INTERRUPTED = [...HEAD, '❯ Use the Bash tool to run exactly this command: node -e "setTimeout(()=>{},40000)"', '  No result recorded for 1 call', '  ⎿  $ node -e "setTimeout(()=>{},40000)"', '  ⎿  Interrupted · What should Claude do instead?', ...prompt('⏵⏵ auto mode on (shift+tab to cycle)')]
const PERMISSION = [
  ...HEAD, '❯ Use the Bash tool to run exactly: mkdir probe-dir-A', '● Creating directory probe-dir-A', '  ⎿  $ mkdir probe-dir-A',
  RULE, ' Bash command', ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below', ' Create directory probe-dir-A', DASH, ' mkdir probe-dir-A', DASH,
  ' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, and always allow access to', '      \\work\\bench', '      from this project',
  '   3. Yes, and switch to auto mode · auto mode handles these prompts for you', '   4. No', '', ' Esc to cancel · Tab to amend',
]
const PERMISSION_NPM = [
  ...HEAD, RULE, ' Bash command', ' Print npm version', DASH, ' npm --version', DASH, ' This command requires approval', ' Do you want to proceed?',
  ' ❯ 1. Yes', '   2. Yes, and don’t ask again for: npm *', '   3. Yes, and switch to auto mode · auto mode handles these prompts for you', '   4. No', ' Esc to cancel · Tab to amend',
]
const PERMISSION_NO_ALWAYS = [
  ...HEAD, RULE, ' Bash command', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, and switch to auto mode · auto mode handles these prompts for you', '   3. No', ' Esc to cancel · Tab to amend',
]
const QUESTION = [
  ...HEAD, '❯ Use the AskUserQuestion tool to ask me whether I prefer red or blue. Do nothing else.',
  RULE, ' ☐ Color', '', 'Do you prefer red or blue?', '', '❯ 1. Red', '     Choose red', '  2. Blue', '     Choose blue', '  3. Type something.', RULE, '  4. Chat about this', '', 'Enter to select · ↑/↓ to navigate · Esc to cancel',
]
const TRUST = [
  RULE, ' Accessing workspace:', ' \\work\\bench', '', ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source', " project, or work from your team). If not, take a moment to review what's in this folder first.",
  '', " Claude Code'll be able to read, edit, and execute files here.", '', ' Security guide', '', ' ❯ No, exit', '   Yes, I trust this folder', '', ' Enter to confirm · Esc to cancel',
]
const PASTED = [...HEAD, RULE, '❯ [Pasted text #1 +14 lines]', RULE, '  paste again to expand']

describe('conductor-claude: the screens of the sonda', () => {
  test('permission card: the options are yes, always (the text varies) and no; the auto-mode option is not offered', () => {
    const s = readClaudeScreen(PERMISSION)
    assert.equal(s.kind, 'permission')
    if (s.kind !== 'permission') return
    assert.equal(s.card.title, 'Bash command')
    assert.deepEqual(s.card.options.map((o) => o.id), ['yes', 'always', 'no'])
    assert.match(s.card.options[1]!.label, /^Yes, and always allow access to .*from this project$/)
    assert.match(s.card.text, /mkdir probe-dir-A/)
    assert.match(s.card.text, /Do you want to proceed\?/)
    assert.doesNotMatch(s.card.text, /Esc to cancel/)
    assert.doesNotMatch(s.card.text, /Creating directory/)
  })

  test("the \"don't ask again\" wording of the sonda's first screen is also `always`", () => {
    const s = readClaudeScreen(PERMISSION_NPM)
    assert.equal(s.kind, 'permission')
    if (s.kind === 'permission') assert.deepEqual(s.card.options.map((o) => o.id), ['yes', 'always', 'no'])
  })

  test('question of the agent: numbered options with the descriptions, told from a permission by the footer', () => {
    const s = readClaudeScreen(QUESTION)
    assert.equal(s.kind, 'question')
    if (s.kind !== 'question') return
    assert.equal(s.card.title, 'Color')
    assert.deepEqual(s.card.options.map((o) => o.id), ['1', '2', '3', '4'])
    assert.equal(s.card.options[0]!.label, 'Red Choose red')
    assert.equal(s.card.options[3]!.label, 'Chat about this')
  })

  test('trust dialog: a dialog, with its two unnumbered options', () => {
    const s = readClaudeScreen(TRUST)
    assert.equal(s.kind, 'dialog')
    if (s.kind === 'dialog') assert.deepEqual(s.card.options.map((o) => o.label), ['No, exit', 'Yes, I trust this folder'])
  })

  test('busy, idle, interrupted, and a text it does not know', () => {
    assert.equal(readClaudeScreen(BUSY).kind, 'busy')
    assert.equal(readClaudeScreen(IDLE).kind, 'idle')
    assert.equal(readClaudeScreen(INTERRUPTED).kind, 'interrupted')
    assert.equal(readClaudeScreen(PASTED).kind, 'idle', 'a draft pasted in the box and not sent: nothing is running')
    assert.equal(readClaudeScreen(['', '']).kind, 'unknown')
    assert.equal(readClaudeScreen(['PS C:\\> dir']).kind, 'unknown')
  })

  test('an old card in the scrollback above an idle screen is not a card', () => {
    const rows = ['  Do you want to proceed?', '  ❯ 1. Yes', '    2. No', ' Esc to cancel · Tab to amend', ...IDLE]
    assert.equal(readClaudeScreen(rows).kind, 'idle')
  })
})

// ---- the acts, against a fake context ----------------------------------------------------------------------------
function fakeCtx(screens: string[][], files: Record<string, string> = {}): { ctx: ConductorContext; writes: { data: string; waitMs?: number }[]; keys: { keys: string[]; gapMs?: number }[] } {
  let i = 0
  const writes: { data: string; waitMs?: number }[] = []
  const keys: { keys: string[]; gapMs?: number }[] = []
  const slot = { slotId: 'p1', kind: 'claude', status: 'running', cwd: '\\work' } as unknown as SlotState
  const ctx: ConductorContext = {
    target: { paneId: 'p1', type: 'terminal', slot },
    slot: () => slot,
    agent: undefined,
    screen: async (): Promise<ScreenText> => ({ screen: screens[Math.min(i, screens.length - 1)]!, history: [], cols: 120, rows: 40, end: 0 }),
    write: async (c) => { writes.push(...c) },
    // The next screen of the script appears after a key (the agent reacting).
    keys: async (k, o) => { keys.push({ keys: [...k], ...(o?.gapMs !== undefined ? { gapMs: o.gapMs } : {}) }); i++ },
    io: { tryReadText: async (p: string) => files[p.split(/[\\/]/).pop()!] } as unknown as ConductorContext['io'],
    home: 'C:\\home',
    log: () => {},
  }
  return { ctx, writes, keys }
}
const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => p.then(() => undefined, (e: { code?: string }) => e.code)

describe('conductor-claude: the acts', () => {
  test('matches a claude pane only; type, keys and read are left to the terminal conductor', () => {
    assert.equal(manifest.id, 'conductor-claude')
    assert.deepEqual(manifest.requires, ['for-agents'])
    assert.equal(claudeConductor.match({ paneId: 'a', type: 'terminal', slot: { kind: 'claude' } as SlotState }), 10)
    assert.equal(claudeConductor.match({ paneId: 'a', type: 'terminal', slot: { kind: 'soul' } as SlotState }), undefined)
    assert.equal(claudeConductor.match({ paneId: 'a', type: 'note' }), undefined)
    assert.equal(claudeConductor.watch, true)
    for (const absent of ['read', 'type', 'keys']) assert.equal((claudeConductor as unknown as Record<string, unknown>)[absent], undefined)
    assert.deepEqual(claudeConductor.capabilities.map((c) => c.id), ['send', 'interrupt', 'answer', 'command'])
  })

  test('send: one line is the text, then Enter 150 ms later in its own write; several lines are a bracketed paste, 400 ms, Enter', async () => {
    assert.deepEqual(sendChunks('olá'), [{ data: 'olá' }, { data: '\r', waitMs: 150 }])
    assert.deepEqual(sendChunks('a\nb\n'), [{ data: '\x1b[200~a\rb\x1b[201~' }, { data: '\r', waitMs: 400 }])
    assert.deepEqual(sendChunks('x\x1b[201~y'), [{ data: 'x[201~y' }, { data: '\r', waitMs: 150 }], 'an escape in the text never reaches the terminal')
    assert.throws(() => sendChunks('  \n'), { code: 'bad-request' })
    const f = fakeCtx([IDLE])
    const r = await claudeConductor.send!(f.ctx, 'um\ndois')
    assert.equal(r.proven, true)
    assert.equal(f.writes.length, 2)
  })

  test('send and command write nothing over a card', async () => {
    const f = fakeCtx([PERMISSION])
    assert.equal(await codeOf(claudeConductor.send!(f.ctx, '1')), 'busy')
    assert.equal(await codeOf(claudeConductor.command!(f.ctx, 'compact')), 'busy')
    assert.deepEqual(f.writes, [])
  })

  test('answer: yes, always and no are the digits of the options as read on the screen; a number is itself; no card is no-request', async () => {
    for (const [choice, digit] of [['yes', '1'], ['always', '2'], ['no', '4'], ['3', '3']] as const) {
      const f = fakeCtx([PERMISSION])
      await claudeConductor.answer!(f.ctx, choice)
      assert.deepEqual(f.writes, [{ data: digit }], choice)
    }
    assert.equal(await codeOf(claudeConductor.answer!(fakeCtx([PERMISSION]).ctx, '9')), 'bad-request')
    assert.equal(await codeOf(claudeConductor.answer!(fakeCtx([IDLE]).ctx, 'yes')), 'no-request')
    const q = fakeCtx([QUESTION])
    await claudeConductor.answer!(q.ctx, '2')
    assert.deepEqual(q.writes, [{ data: '2' }])
    const no = fakeCtx([QUESTION])
    await claudeConductor.answer!(no.ctx, 'no')
    assert.deepEqual(no.keys, [{ keys: ['esc'] }])
    assert.equal(await codeOf(claudeConductor.answer!(fakeCtx([QUESTION]).ctx, 'yes')), 'bad-request')
    assert.equal(await codeOf(claudeConductor.answer!(fakeCtx([PERMISSION_NO_ALWAYS]).ctx, 'always')), 'unsupported')
    const s = fakeCtx([PERMISSION])
    assert.equal(await codeOf(claudeConductor.answer!(s.ctx, 'session')), 'unsupported')
    assert.deepEqual([s.writes, s.keys], [[], []])
    const npm = fakeCtx([PERMISSION_NPM])
    await claudeConductor.answer!(npm.ctx, 'always')
    assert.deepEqual(npm.writes, [{ data: '2' }])
  })

  test('interrupt: one esc, then rereads the screen: stopped when the turn is no longer running', async () => {
    const f = fakeCtx([BUSY, INTERRUPTED])
    const r = await claudeConductor.interrupt!(f.ctx)
    assert.deepEqual(r, { value: { stopped: true }, proven: true })
    assert.deepEqual(f.keys, [{ keys: ['esc'] }])
  })

  test('command: the slash line, then Enter; compact idle and clear are proven, the rest is not', async () => {
    const f = fakeCtx([IDLE])
    assert.deepEqual(await claudeConductor.command!(f.ctx, 'compact'), { value: undefined, proven: true })
    assert.deepEqual(f.writes, [{ data: '/compact' }, { data: '\r', waitMs: 150 }])
    assert.equal((await claudeConductor.command!(fakeCtx([BUSY]).ctx, 'compact')).proven, false)
    assert.equal((await claudeConductor.command!(fakeCtx([BUSY]).ctx, 'clear')).proven, true)
    assert.equal((await claudeConductor.command!(fakeCtx([IDLE]).ctx, 'model', 'haiku')).proven, false)
    assert.equal(await codeOf(claudeConductor.command!(fakeCtx([IDLE]).ctx, '../x')), 'bad-request')
  })

  test('detect: card, question, idle (also after an interrupt), busy, dialog', async () => {
    const d = async (s: string[]): Promise<string> => (await claudeConductor.detect!(fakeCtx([s]).ctx)).state
    assert.deepEqual([await d(PERMISSION), await d(QUESTION), await d(IDLE), await d(INTERRUPTED), await d(BUSY), await d(TRUST)], ['permission', 'question', 'idle', 'idle', 'busy', 'dialog'])
  })

  test('launchArgs: --model is proven; the effort flag is not', () => {
    assert.deepEqual(claudeConductor.launchArgs!({ model: 'haiku', cwd: 'x' }), { value: ['--model', 'haiku'], proven: true })
    assert.deepEqual(claudeConductor.launchArgs!({ model: 'haiku', effort: 'low', cwd: 'x' }), { value: ['--model', 'haiku', '--effort', 'low'], proven: false })
  })

  test('boot: answers the trust dialog once (down, 400 ms, enter) and ends at the prompt; with no dialog it sends no key', async () => {
    const f = fakeCtx([TRUST, IDLE])
    await claudeConductor.boot!(f.ctx)
    assert.deepEqual(f.keys, [{ keys: ['down', 'enter'], gapMs: 400 }])
    const g = fakeCtx([IDLE])
    await claudeConductor.boot!(g.ctx)
    assert.deepEqual(g.keys, [])
  })

  test('lastAnswer: the file of the pane that the Stop hook wrote; `at` is its ts', async () => {
    const ts = '2026-11-21T20:00:00.000Z'
    const f = fakeCtx([IDLE], { 'p1.answer.json': JSON.stringify({ ts, sessionId: 's1', text: 'feito', from: 'claude-stop' }) })
    assert.deepEqual(await claudeConductor.lastAnswer!(f.ctx), { value: { text: 'feito', at: ts, source: 'claude-stop', turn: 's1' }, proven: true })
    assert.equal(await claudeConductor.lastAnswer!(fakeCtx([IDLE]).ctx), undefined)
    assert.equal(await claudeConductor.lastAnswer!(fakeCtx([IDLE], { 'p1.answer.json': '{half' }).ctx), undefined)
  })
})
