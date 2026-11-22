// The Codex conductor (C3), unit: the screens of the sonda of 21/11 (Codex 0.169.0) and of the dialog probe through `detect`, and the acts
// against a fake context that records what is written (the gate's side is the daemon's, proven in the E2E). No process, no daemon, no LLM.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { codexConductor, sendChunks } from '../../extensions/conductor-codex/conductor.ts'
import { manifest } from '../../extensions/conductor-codex/daemon.ts'
import { alnum, composerDraft, echoedAbove, readCodexScreen } from '../../extensions/conductor-codex/screen.ts'
import type { ConductorContext, ScreenText } from '../../extensions/for-agents/conductor-api.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'

const WORK = 'D:\\bench\\work'
const HEAD = ['  >_ OpenAI Codex (v0.169.0)', `     ${WORK}`, '']
const composer = (draft = 'Ask Codex to do anything', model = 'GPT-5.6-Luna low'): string[] => [
  `› ${draft}`, '', `  ${model} · ${WORK}`, '  ← for agents · ? for shortcuts                                                              ⚠ 5 warnings · f2 to view',
]

const IDLE = [...HEAD, '› Responda apenas com a palavra OK-300', '', '• OK-300', '  Worked for 2s • 13:25', '', ...composer()]
const WORKING = [...HEAD, '› Responda apenas com a palavra OK-300', '', '• Working (0s • esc to interrupt)', '', ...composer()]
// The text streams and the "Working" line is not on the screen (s3-enter-busy): only the slot's turn tells.
const STREAMING = [...HEAD, '› Escreva um texto de 400 palavras sobre o mar', '', '• O mar é uma presença imensa, viva e misteriosa. D', '', ...composer()]
const QUEUED = [...HEAD, '› Escreva um texto', '• O mar é uma presença imensa.', '• Messages to be submitted after next tool call (press esc to interrupt and send immediately)', '  ↳ Agora diga apenas CHEGOU-enter', '', ...composer()]
const INTERRUPTED = [...HEAD, '› Escreva um texto de 600 palavras sobre o mar, sem ferramentas.', '• O mar é uma presença que parece não caber', '■ Conversation interrupted - use /feedback if something went wrong', '', ...composer()]
const COMPACTING = [...HEAD, '• Compacting context (0s • esc to interrupt)', '  └ Making room to continue.', '', ...composer()]
const COMPACTED = [...HEAD, '› Responda apenas OK-PRIMEIRO', '• OK-PRIMEIRO', '  Worked for 3s • 13:34', '• Context compacted · 3s', '  Worked for 3s • 13:34', '', ...composer()]
const FRESH = [...HEAD, '', '                  ⣀⣤⣤⣤⣀⣀', '', ...composer()]
const PERMISSION = [
  ...HEAD, '› Use o shell para criar o arquivo probe-look.txt contendo a palavra x.', '', '• Vou criar o arquivo solicitado usando o shell.', '',
  '• Running cmd /c "echo x> probe-look.txt"', '  Would you like to run the following command?', '', '  Environment: local',
  '  Reason: Você autoriza criar o arquivo probe-look.txt no diretório de trabalho?', '', '  $ cmd /c "echo x> probe-look.txt"', '',
  '› 1. Yes, proceed (y)', "  2. Yes, and don't ask again for commands that start with `cmd /c 'echo x> probe-look.txt'` (p)",
  '  3. No, and tell Codex what to do differently (esc)', '', '  Press enter to confirm or esc to cancel',
]
// The same card with the second option wrapped over two rows (a long command).
const PERMISSION_WRAPPED = PERMISSION.flatMap((l) => l.startsWith('  2. ') ? ["  2. Yes, and don't ask again for commands that start with `cmd /c 'echo x> probe-look.txt'`", '     in this project (p)'] : [l])
const LONG = 'Use the shell to create the file probe-c3.txt containing the word x (for example with: cmd /c echo x> probe-c3.txt). Then reply only: pronto'
// The Enter 300 ms after a 137-character line was not taken (C3 diagnostic): the text stays in the box, wrapped over two rows.
const STUCK = [...HEAD, '› Reply only with: alfa-ok', '', '• alfa-ok', '', '› Use the shell to create the file probe-c3.txt containing the word x (for example with: cmd /c echo x> probe-c3.txt).', '  Then reply only: pronto', '', `  GPT-5.6-Luna low · ${WORK}`]
const UPDATE = ['', '  Update available · 0.169.0 → 0.171.0', '  Release notes: https://github.com/openai/codex/releases/latest', '', '› 1. Update now (runs `npm install -g @openai/codex`)', '  2. Skip', '  3. Skip until next version', '', '  enter continue · esc skip']
const NEW_DIALOG = [...HEAD, '• Context compacted · 3s', '', '  Where should the new conversation run?', '› 1. Use current Git worktree  Keep using the current working directory', '  2. Create new Git worktree   Create a separate checkout of this repository in another directory', '', '  enter select · esc back']

describe('conductor-codex: the screens of the sonda', () => {
  test('approval card: yes, always and no, with the keys the screen names; the title and the command are in the text', () => {
    const s = readCodexScreen(PERMISSION)
    assert.equal(s.kind, 'permission')
    if (s.kind !== 'permission') return
    assert.equal(s.card.title, 'Would you like to run the following command?')
    assert.deepEqual(s.card.options.map((o) => o.id), ['yes', 'always', 'no'])
    assert.deepEqual(s.options.map((o) => o.key), ['y', 'p', 'esc'])
    assert.match(s.card.text, /\$ cmd \/c "echo x> probe-look\.txt"/)
    assert.match(s.card.text, /Environment: local/)
    assert.doesNotMatch(s.card.text, /Press enter to confirm/)
    assert.doesNotMatch(s.card.text, /Vou criar o arquivo/)
  })

  test('a wrapped option joins its continuation and keeps its key', () => {
    const s = readCodexScreen(PERMISSION_WRAPPED)
    assert.equal(s.kind, 'permission')
    if (s.kind !== 'permission') return
    assert.equal(s.options.length, 3)
    assert.match(s.options[1]!.label, /in this project \(p\)$/)
    assert.equal(s.options[1]!.key, 'p')
    assert.equal(s.options[1]!.role, 'always')
  })

  test('the update dialog and the new-conversation dialog are dialogs, with numbered options', () => {
    const u = readCodexScreen(UPDATE)
    assert.equal(u.kind, 'dialog')
    if (u.kind === 'dialog') assert.deepEqual(u.card.options.map((o) => o.id), ['1', '2', '3'])
    const n = readCodexScreen(NEW_DIALOG)
    assert.equal(n.kind, 'dialog')
    if (n.kind === 'dialog') assert.equal(n.card.title, 'Where should the new conversation run?')
  })

  test('busy (working, compacting, a queued message), idle, interrupted, a fresh screen, and a text it does not know', () => {
    for (const [name, rows, kind] of [
      ['working', WORKING, 'busy'], ['compacting', COMPACTING, 'busy'], ['queued', QUEUED, 'busy'], ['idle', IDLE, 'idle'], ['compacted', COMPACTED, 'idle'],
      ['fresh', FRESH, 'idle'], ['interrupted', INTERRUPTED, 'interrupted'], ['streaming', STREAMING, 'idle'],
    ] as const) assert.equal(readCodexScreen(rows).kind, kind, name)
    assert.equal(readCodexScreen(['', '']).kind, 'unknown')
    assert.equal(readCodexScreen(['PS C:\\> dir']).kind, 'unknown')
  })

  test('composerDraft: the text left in the box, and nothing for the placeholder, a card or no composer', () => {
    assert.match(composerDraft(STUCK) ?? '', /^Use the shell to create the file probe-c3\.txt/)
    assert.equal(composerDraft(IDLE), undefined)
    assert.equal(composerDraft(WORKING), undefined)
    assert.equal(composerDraft(PERMISSION), undefined)
    assert.equal(composerDraft(['x']), undefined)
    assert.equal(composerDraft([...HEAD, ...composer('um rascunho')]), 'um rascunho')
  })

  test('a draft in the box is not a card and not a turn; an old card in the scrollback above an idle screen is not a card', () => {
    assert.equal(readCodexScreen([...HEAD, ...composer('um rascunho')]).kind, 'idle')
    assert.equal(readCodexScreen([...PERMISSION, ...IDLE]).kind, 'idle')
  })
})

// ---- the acts, against a fake context ----------------------------------------------------------------------------
function fakeCtx(screens: string[][], files: Record<string, string> = {}, turn?: 'busy'): { ctx: ConductorContext; writes: { data: string; waitMs?: number }[]; keys: { keys: string[]; gapMs?: number }[] } {
  let i = 0
  const writes: { data: string; waitMs?: number }[] = []
  const keys: { keys: string[]; gapMs?: number }[] = []
  const slot = { slotId: 'p1', kind: 'codex', status: 'running', cwd: WORK, ...(turn ? { turn } : {}) } as unknown as SlotState
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

describe('conductor-codex: the acts', () => {
  test('matches a codex pane only; type, keys and read are left to the terminal conductor', () => {
    assert.equal(manifest.id, 'conductor-codex')
    assert.deepEqual(manifest.requires, ['for-agents'])
    assert.equal(codexConductor.match({ paneId: 'a', type: 'terminal', slot: { kind: 'codex' } as SlotState }), 10)
    assert.equal(codexConductor.match({ paneId: 'a', type: 'terminal', slot: { kind: 'claude' } as SlotState }), undefined)
    assert.equal(codexConductor.match({ paneId: 'a', type: 'note' }), undefined)
    assert.equal(codexConductor.watch, true)
    for (const absent of ['read', 'type', 'keys']) assert.equal((codexConductor as unknown as Record<string, unknown>)[absent], undefined)
    assert.deepEqual(codexConductor.capabilities.map((c) => c.id), ['send', 'interrupt', 'answer', 'command'])
  })

  /** The text as the conductor types it: the envelope's `·` is a win32-input-mode key press. */
  const keyed = (s: string): string => s.replaceAll('·', '\x1b[0;0;183;1;0;1_')

  test('send: non-ASCII goes as win32-input-mode key presses (the ConPTY drops what the layout lacks, as `·`), one per UTF-16 unit', () => {
    const key = (u: number) => `\x1b[0;0;${u};1;0;1_`
    assert.deepEqual(sendChunks('a · b'), [{ data: `a ${key(0xb7)} b` }, { data: '\r', waitMs: 300 }])
    assert.deepEqual(sendChunks('ç\n€'), [{ data: `\x1b[200~${key(0xe7)}\r${key(0x20ac)}\x1b[201~` }, { data: '\r', waitMs: 400 }])
    assert.deepEqual(sendChunks('😀')[0], { data: `${key(0xd83d)}${key(0xde00)}` }, 'a surrogate pair is two events')
  })

  test('send: one line is the text, then Enter 300 ms later in its own write; several lines are a bracketed paste, 400 ms, Enter', async () => {
    assert.deepEqual(sendChunks('ola'), [{ data: 'ola' }, { data: '\r', waitMs: 300 }])
    assert.deepEqual(sendChunks('a\nb\n'), [{ data: '\x1b[200~a\rb\x1b[201~' }, { data: '\r', waitMs: 400 }])
    assert.deepEqual(sendChunks('x\x1b[201~y'), [{ data: 'x[201~y' }, { data: '\r', waitMs: 300 }], 'an escape in the text never reaches the terminal')
    assert.throws(() => sendChunks('  \n'), { code: 'bad-request' })
    const f = fakeCtx([[...HEAD, '› um', '  dois', '', '• Working (0s • esc to interrupt)', '', ...composer()]])
    const r = await codexConductor.send!(f.ctx, 'um\ndois')
    assert.equal(r.proven, true)
    assert.equal(f.writes.length, 2)
    const busy = fakeCtx([QUEUED], {}, 'busy')
    await codexConductor.send!(busy.ctx, 'mais uma')
    assert.equal(busy.writes.length, 2, 'a busy agent queues the message: it is sent')
  })

  test('send: an Enter that Codex did not take is pressed again, only while the text stays in the box; never twice when it went', async () => {
    const f = fakeCtx([STUCK])
    const original = f.ctx.write
    // After the first lone Enter the box is empty (the second Enter was taken).
    let stuck = true
    f.ctx.screen = async (): Promise<ScreenText> => ({ screen: stuck ? STUCK : WORKING, history: [], cols: 120, rows: 40, end: 0 })
    f.ctx.write = async (c) => { await original(c); if (c.length === 1 && c[0]!.data === '\r') stuck = false }
    await codexConductor.send!(f.ctx, LONG)
    assert.deepEqual(f.writes.map((w) => w.data), [LONG, '\r', '\r'])
    const ok = fakeCtx([WORKING])
    await codexConductor.send!(ok.ctx, LONG)
    assert.equal(ok.writes.length, 2, 'went at the first Enter: no extra Enter')
    const never = fakeCtx([STUCK])
    assert.equal(await codeOf(codexConductor.send!(never.ctx, LONG)), 'unsent')
    assert.equal(never.writes.filter((w) => w.data === '\r').length, 4, 'the Enter of the send and three more')
  })

  test('send: the envelope header whose `·` Codex shows as blanks still counts as the text stuck in the box (Enter pressed again)', async () => {
    const envelope = '[tether · for-agents · de atrium (owner) · m_abc123] Crie um arquivo ola.txt com a palavra ola nesta pasta.'
    const stuckScreen = [...HEAD, '', ...composer('[tether  for-agents  de atrium (owner)  m_abc123] Crie um arquivo ola.txt com a palavra ola nesta pasta.')]
    const f = fakeCtx([stuckScreen])
    const original = f.ctx.write
    let stuck = true
    f.ctx.screen = async (): Promise<ScreenText> => ({ screen: stuck ? stuckScreen : WORKING, history: [], cols: 120, rows: 40, end: 0 })
    f.ctx.write = async (c) => { await original(c); if (c.length === 1 && c[0]!.data === '\r') stuck = false }
    await codexConductor.send!(f.ctx, envelope)
    assert.deepEqual(f.writes.map((w) => w.data), [keyed(envelope), '\r', '\r'])
  })

  // The screen of the owner's scene (22/11, Codex 0.169.0, resumed session, narrow terminal), read right after a `send` that answered
  // `typed`: the envelope wrapped over two rows in the box, no Enter taken, the previous turn's history above.
  const SCENE_ENVELOPE = '[tether · for-agents · de atrium (owner) · m_mws4vas17f453fcf58] Crie um arquivo ola2.txt com a palavra ola nesta pasta.'
  const SCENE = [
    '• Arquivo criado com sucesso: ola.txt (ola.txt) contendo ola.                   ',
    '',
    '  Worked for 34s • 13:58                                                        ',
    '',
    '                                                                                ',
    '› [tether  for-agents  de atrium (owner)  m_mws4vas17f453fcf58] Crie um arquivo',
    '  ola2.txt com a palavra ola nesta pasta.',
    '',
    '',
    '  GPT-5.6-Luna low · ~\\AppData\\Local\\Temp\\tether-cena-J3ZmtN\\c3',
    '                                                      ⚠ 3 warnings · f2 to view ',
  ]
  // Earlier in the scrollback: the previous message of the same owner (another id), which is not this one's echo.
  const SCENE_HISTORY = ['› [tether  for-agents  de atrium (owner)  m_mws4old000000000000] Crie um arquivo', '  ola.txt com a palavra ola nesta pasta.', '']
  const SCENE_TAKEN = [
    ...SCENE.slice(0, 4),
    '› [tether  for-agents  de atrium (owner)  m_mws4vas17f453fcf58] Crie um arquivo',
    '  ola2.txt com a palavra ola nesta pasta.',
    '',
    '› Ask Codex to do anything',
    '',
    '  GPT-5.6-Luna low · ~\\AppData\\Local\\Temp\\tether-cena-J3ZmtN\\c3',
  ]

  test('the scene: the envelope wrapped over two rows is still in the box; the message is not echoed above the composer', () => {
    assert.match(composerDraft(SCENE) ?? '', /^\[tether {2}for-agents {2}de atrium \(owner\) {2}m_mws4vas17f453fcf58\] Crie um arquivo$/)
    assert.equal(echoedAbove(SCENE, SCENE_HISTORY, alnum(SCENE_ENVELOPE).slice(0, 60)), false, 'the draft and an older message are not the echo')
    assert.equal(echoedAbove(SCENE_TAKEN, SCENE_HISTORY, alnum(SCENE_ENVELOPE).slice(0, 60)), true)
  })

  test('the scene: the stuck envelope gets its Enter again and the send ends only when the message shows taken', async () => {
    const f = fakeCtx([SCENE])
    const original = f.ctx.write
    let stuck = true
    f.ctx.screen = async (): Promise<ScreenText> => ({ screen: stuck ? SCENE : SCENE_TAKEN, history: SCENE_HISTORY, cols: 80, rows: 40, end: 0 })
    f.ctx.write = async (c) => { await original(c); if (c.length === 1 && c[0]!.data === '\r') stuck = false }
    await codexConductor.send!(f.ctx, SCENE_ENVELOPE)
    assert.deepEqual(f.writes.map((w) => w.data), [keyed(SCENE_ENVELOPE), '\r', '\r'])
  })

  test('send: an empty box with no sign of the turn is not a sent message: it waits for one, and fails `unsent` past the deadline', async () => {
    // The box looks empty first (the text not drawn yet), then shows the stuck text: the Enter is pressed then, and the turn shows.
    const late = fakeCtx([IDLE])
    let phase = 0
    late.ctx.screen = async (): Promise<ScreenText> => ({ screen: phase === 0 ? IDLE : phase === 1 ? SCENE : SCENE_TAKEN, history: [], cols: 80, rows: 40, end: 0 })
    const original = late.ctx.write
    late.ctx.write = async (c) => { await original(c); if (c.length === 1 && c[0]!.data === '\r') phase = 2 }
    setTimeout(() => { if (phase === 0) phase = 1 }, 1000)
    await codexConductor.send!(late.ctx, SCENE_ENVELOPE)
    assert.deepEqual(late.writes.map((w) => w.data), [keyed(SCENE_ENVELOPE), '\r', '\r'], 'the late draft got its Enter')
    // Never a sign: `unsent`, never `typed`, and no Enter pressed into an empty box.
    const never = fakeCtx([IDLE])
    assert.equal(await codeOf(codexConductor.send!(never.ctx, SCENE_ENVELOPE)), 'unsent')
    assert.deepEqual(never.writes.map((w) => w.data), [keyed(SCENE_ENVELOPE), '\r'])
  })

  test('send and command write nothing over a card (a `y` in the text would approve)', async () => {
    const f = fakeCtx([PERMISSION])
    assert.equal(await codeOf(codexConductor.send!(f.ctx, 'yes please')), 'busy')
    assert.equal(await codeOf(codexConductor.command!(f.ctx, 'compact')), 'busy')
    assert.deepEqual(f.writes, [])
    assert.equal(await codeOf(codexConductor.send!(fakeCtx([UPDATE]).ctx, 'oi')), 'busy')
  })

  test('answer: yes is `y`, always is `p`, no is Esc; a number is the key of that option; no card is no-request', async () => {
    for (const [choice, data] of [['yes', 'y'], ['always', 'p'], ['1', 'y'], ['2', 'p']] as const) {
      const f = fakeCtx([PERMISSION])
      const r = await codexConductor.answer!(f.ctx, choice)
      assert.deepEqual(f.writes, [{ data }], choice)
      assert.equal(r.proven, true)
    }
    for (const choice of ['no', '3']) {
      const f = fakeCtx([PERMISSION])
      await codexConductor.answer!(f.ctx, choice)
      assert.deepEqual(f.keys, [{ keys: ['esc'] }], choice)
      assert.deepEqual(f.writes, [])
    }
    const wrapped = fakeCtx([PERMISSION_WRAPPED])
    await codexConductor.answer!(wrapped.ctx, 'always')
    assert.deepEqual(wrapped.writes, [{ data: 'p' }])
    assert.equal(await codeOf(codexConductor.answer!(fakeCtx([PERMISSION]).ctx, '9')), 'bad-request')
    assert.equal(await codeOf(codexConductor.answer!(fakeCtx([IDLE]).ctx, 'yes')), 'no-request')
    // A dialog that is not an approval: a number is its digit, unproven; yes is not a choice there; the update dialog is never answered with Enter.
    const d = fakeCtx([UPDATE])
    const r = await codexConductor.answer!(d.ctx, '2')
    assert.deepEqual([d.writes, r.proven], [[{ data: '2' }], false])
    assert.equal(await codeOf(codexConductor.answer!(fakeCtx([UPDATE]).ctx, 'yes')), 'bad-request')
  })

  test('interrupt: one esc, then rereads the screen: stopped when the turn is no longer running', async () => {
    const f = fakeCtx([WORKING, INTERRUPTED])
    const r = await codexConductor.interrupt!(f.ctx)
    assert.deepEqual(r, { value: { stopped: true }, proven: true })
    assert.deepEqual(f.keys, [{ keys: ['esc'] }])
  })

  test('command: the slash line, 500 ms, Enter; compact is proven; busy (by the screen or by the turn) is refused with nothing typed', async () => {
    const f = fakeCtx([IDLE])
    assert.deepEqual(await codexConductor.command!(f.ctx, 'compact'), { value: undefined, proven: true })
    assert.deepEqual(f.writes, [{ data: '/compact' }, { data: '\r', waitMs: 500 }])
    for (const [name, ctx] of [['working', fakeCtx([WORKING])], ['compacting', fakeCtx([COMPACTING])], ['turn busy, no marker', fakeCtx([STREAMING], {}, 'busy')]] as const) {
      assert.equal(await codeOf(codexConductor.command!(ctx.ctx, 'compact')), 'busy', name)
      assert.deepEqual(ctx.writes, [], name)
    }
    assert.equal((await codexConductor.command!(fakeCtx([IDLE]).ctx, 'model', 'gpt')).proven, false)
    assert.equal(await codeOf(codexConductor.command!(fakeCtx([IDLE]).ctx, '../x')), 'bad-request')
  })

  test('detect: card, dialog, busy (also by the turn), idle (also after an interrupt), unknown', async () => {
    const d = async (s: string[], turn?: 'busy'): Promise<string> => (await codexConductor.detect!(fakeCtx([s], {}, turn).ctx)).state
    assert.deepEqual(
      [await d(PERMISSION), await d(UPDATE), await d(WORKING), await d(STREAMING, 'busy'), await d(STREAMING), await d(IDLE), await d(INTERRUPTED), await d(['x'])],
      ['permission', 'dialog', 'busy', 'busy', 'idle', 'idle', 'idle', 'unknown'],
    )
    const card = await codexConductor.detect!(fakeCtx([PERMISSION]).ctx)
    assert.equal('card' in card && card.card.options.map((o) => o.id).join(','), 'yes,always,no')
  })

  test('launchArgs: the update check and the folder trust are off; model and effort are -c overrides; low is the sonda\'s effort', () => {
    const r = codexConductor.launchArgs!({ model: 'gpt-5.6-luna', effort: 'low', cwd: 'd:\\bench\\work' })
    assert.deepEqual(r.value, [
      '-c', 'check_for_update_on_startup=false',
      '-c', 'projects."D:\\\\bench\\\\work".trust_level="trusted"',
      '-c', 'model="gpt-5.6-luna"', '-c', 'model_reasoning_effort="low"',
    ])
    assert.equal(r.proven, true)
    assert.equal(codexConductor.launchArgs!({ model: 'm', effort: 'high', cwd: 'x' }).proven, false)
  })

  test('boot: skips the update dialog once with Esc and never Enter, and ends at the composer; with no dialog it sends no key', async () => {
    const f = fakeCtx([UPDATE, FRESH])
    await codexConductor.boot!(f.ctx)
    assert.deepEqual(f.keys, [{ keys: ['esc'] }])
    const g = fakeCtx([FRESH])
    await codexConductor.boot!(g.ctx)
    assert.deepEqual(g.keys, [])
  })

  test('lastAnswer: the file of the pane that the notify reporter wrote; `at` is its ts, `turn` its turnId', async () => {
    const ts = '2026-11-21T20:00:00.000Z'
    const f = fakeCtx([IDLE], { 'p1.answer.json': JSON.stringify({ ts, sessionId: 's1', turnId: 't1', text: 'feito', from: 'codex-notify' }) })
    assert.deepEqual(await codexConductor.lastAnswer!(f.ctx), { value: { text: 'feito', at: ts, source: 'codex-notify', turn: 't1' }, proven: true })
    assert.equal(await codexConductor.lastAnswer!(fakeCtx([IDLE]).ctx), undefined)
    assert.equal(await codexConductor.lastAnswer!(fakeCtx([IDLE], { 'p1.answer.json': '{half' }).ctx), undefined)
  })
})
