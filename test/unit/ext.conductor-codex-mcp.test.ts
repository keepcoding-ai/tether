// The Codex approval card of an MCP tool (`Field 1/1`), from screens recorded with the real Codex 0.169.0 (E4c).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { codexConductor } from '../../extensions/conductor-codex/conductor.ts'
import { readCodexScreen } from '../../extensions/conductor-codex/screen.ts'
import type { ConductorContext, ScreenText } from '../../extensions/for-agents/conductor-api.ts'
import type { SlotState } from '../../src/daemon/protocol.ts'

const load = (name: string): string[] => readFileSync(new URL(`../fixtures/codex/${name}`, import.meta.url), 'utf8').split('\n')
const CARD = load('mcp-card-screen.txt')
const CARD_AFTER_TURN = load('mcp-card-screen-2.txt')
// The same card with the selection (`›`) moved to another row.
const selecting = (n: number): string[] => CARD.map((l) => {
  const m = /^(\s*)(?:›\s)?(\d)\. (.*)$/.exec(l)
  return m ? `${m[1]!.length >= 2 ? '  ' : ''}${Number(m[2]) === n ? '› ' : '  '}${m[2]}. ${m[3]}` : l
})

function fakeCtx(screen: string[]): { ctx: ConductorContext; writes: unknown[]; keys: { keys: string[]; gapMs?: number }[] } {
  const writes: unknown[] = []
  const keys: { keys: string[]; gapMs?: number }[] = []
  const slot = { slotId: 'p1', kind: 'codex', status: 'running', cwd: 'D:\\bench' } as unknown as SlotState
  const ctx: ConductorContext = {
    target: { paneId: 'p1', type: 'terminal', slot },
    slot: () => slot,
    agent: undefined,
    screen: async (): Promise<ScreenText> => ({ screen, history: [], cols: 120, rows: 40, end: 0 }),
    write: async (c) => { writes.push(...c) },
    keys: async (k, o) => { keys.push({ keys: [...k], ...(o?.gapMs !== undefined ? { gapMs: o.gapMs } : {}) }) },
    io: {} as unknown as ConductorContext['io'],
    home: 'C:\\home',
    log: () => {},
  }
  return { ctx, writes, keys }
}

describe('conductor-codex: the MCP tool approval card', () => {
  test('both recorded screens are a permission card with the four options', () => {
    for (const screen of [CARD, CARD_AFTER_TURN]) {
      const s = readCodexScreen(screen)
      assert.equal(s.kind, 'permission')
      if (s.kind !== 'permission') return
      assert.equal(s.card.title, 'Allow the tether MCP server to run tool "channels_say"?')
      assert.deepEqual(s.card.options.map((o) => o.id), ['yes', 'session', 'always', 'no'])
      assert.deepEqual(s.card.options.map((o) => o.label.split(/\s{2,}/)[0]), ['Allow','Allow for this session', 'Always allow', 'Cancel'])
      assert.match(s.card.text, /canal: conferencia/)
      assert.match(s.card.text, /text: Olá, pessoal/)
      assert.doesNotMatch(s.card.text, /enter to submit/)
      assert.deepEqual(s.list, { selected: 1 })
    }
  })

  test('the selected row is read from the marker', () => {
    const s = readCodexScreen(selecting(3))
    assert.equal(s.kind, 'permission')
    if (s.kind === 'permission') assert.deepEqual(s.list, { selected: 3 })
  })

  test('detect reports the card as a permission request', async () => {
    const d = await codexConductor.detect!(fakeCtx(CARD).ctx)
    assert.equal('state' in d && d.state, 'permission')
    assert.equal('card' in d && d.card.options.map((o) => o.id).join(','), 'yes,session,always,no')
  })

  test('answer moves the selection and presses Enter; Cancel is Esc; nothing is typed as text', async () => {
    const cases: [string, string[]][] = [
      ['yes', ['enter']], ['1', ['enter']],
      ['session', ['down', 'enter']], ['2', ['down', 'enter']],
      ['always', ['down', 'down', 'enter']], ['3', ['down', 'down', 'enter']],
      ['no', ['esc']], ['4', ['esc']],
    ]
    for (const [choice, expected] of cases) {
      const f = fakeCtx(CARD)
      const r = await codexConductor.answer!(f.ctx, choice)
      assert.deepEqual(f.keys.map((k) => k.keys), [expected], choice)
      assert.deepEqual(f.writes, [], choice)
      assert.equal(r.proven, false, choice)
    }
  })

  test('answer counts from the selected row (selection already on 3: up for 1, none for always)', async () => {
    const on3 = fakeCtx(selecting(3))
    await codexConductor.answer!(on3.ctx, 'always')
    assert.deepEqual(on3.keys.map((k) => k.keys), [['enter']])
    const up = fakeCtx(selecting(3))
    await codexConductor.answer!(up.ctx, 'yes')
    assert.deepEqual(up.keys.map((k) => k.keys), [['up', 'up', 'enter']])
  })

  test('a number that is not on the card is refused; send and command write nothing over it', async () => {
    const f = fakeCtx(CARD)
    await assert.rejects(codexConductor.answer!(f.ctx, '9'), (e: { code?: string }) => e.code === 'bad-request')
    await assert.rejects(codexConductor.send!(f.ctx, 'oi'), (e: { code?: string }) => e.code === 'busy')
    await assert.rejects(codexConductor.command!(f.ctx, 'compact'), (e: { code?: string }) => e.code === 'busy')
    assert.deepEqual([f.writes, f.keys], [[], []])
  })

  test('an ordinary Codex screen is still not a card', () => {
    const idle = [...CARD.slice(0, 22), '', '• Pronto.', '', '› Ask Codex to do anything', '', '  GPT-5.6-Luna low · D:\\bench']
    assert.equal(readCodexScreen(idle).kind, 'idle')
    // The same card text without its footer on the last row is not a card either.
    assert.notEqual(readCodexScreen([...CARD.slice(0, -2), '', '• Working (1s • esc to interrupt)']).kind, 'permission')
  })
})
