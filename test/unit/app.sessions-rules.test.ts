// The "Sessões" model (app/renderer/sessions-rules.ts), pure: grouping, rows, bulk close, counter, summary, texts.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { SlotState, SlotStatus } from '../../src/daemon/protocol.ts'
import type { PauseBatch, PauseEntry, PauseEntryState } from '../../src/daemon/pause.ts'
import {
  bulkCloseAction, bulkCloseSituation, forgetEndedSituation, formatAgo, groupClosed, isIdleForCleanup, pauseAction, sessionRows, sessionsCounter,
  sessionsSummary, type SessionSlot,
} from '../../app/renderer/sessions-rules.ts'

const NOW = Date.parse('2026-11-09T12:00:00Z')
const MIN = 60_000
const ago = (ms: number): string => new Date(NOW - ms).toISOString()

const mk = (slotId: string, extra: Partial<SessionSlot> = {}): SessionSlot => ({ slotId, cwd: `/work/${slotId}`, status: 'running', ...extra })
const none = (): boolean => false
const tabs = (...ids: string[]) => (id: string): boolean => ids.includes(id)

const batchOf = (...states: PauseEntryState[]): PauseBatch => ({
  v: 1, id: 'b', createdAt: ago(MIN), state: 'collecting',
  entries: states.map((state, i) => ({ slotId: `p${i}`, state, since: ago(MIN), history: [] }) as unknown as PauseEntry),
}) as unknown as PauseBatch

describe('formatAgo', () => {
  test('short Portuguese spans', () => {
    assert.equal(formatAgo(0), 'agora')
    assert.equal(formatAgo(59_000), 'agora')
    assert.equal(formatAgo(5 * MIN), 'há 5 min')
    assert.equal(formatAgo(59 * MIN), 'há 59 min')
    assert.equal(formatAgo(2 * 60 * MIN), 'há 2 h')
    assert.equal(formatAgo(23 * 60 * MIN), 'há 23 h')
    assert.equal(formatAgo(30 * 60 * MIN), 'ontem')
    assert.equal(formatAgo(3 * 24 * 60 * MIN), 'há 3 dias')
  })
  test('negative and invalid read as now', () => {
    assert.equal(formatAgo(-5), 'agora')
    assert.equal(formatAgo(Number.NaN), 'agora')
  })
})

describe('grouping (moved from closed-slots)', () => {
  const slot = (slotId: string, status: SlotStatus): SlotState => ({ slotId, kind: 'shell', cwd: '/work/x', status })
  test('pane-less slots split in running and ended, daemon order kept', () => {
    const g = groupClosed([slot('a', 'running'), slot('b', 'exited'), slot('c', 'starting'), slot('d', 'queued'), slot('e', 'error'), slot('g', 'running')], id => id === 'g')
    assert.deepEqual(g.running.map(s => s.slotId), ['a', 'c', 'd'])
    assert.deepEqual(g.ended.map(s => s.slotId), ['b', 'e'])
    assert.deepEqual(groupClosed([], none), { running: [], ended: [] })
  })
  test('forget-all dialog: one destructive choice and the count in the title', () => {
    const spec = forgetEndedSituation(12)
    assert.match(spec.title, /12 sessões encerradas/)
    assert.deepEqual(spec.choices.map(c => [c.id, c.tone]), [['forget', 'destructive']])
    assert.match(forgetEndedSituation(1).title, /1 sessão encerrada\?/)
  })
})

describe('bulkCloseSituation', () => {
  test('lists the names and has one non-destructive choice', () => {
    const spec = bulkCloseSituation(['a', 'b', 'c'])
    assert.match(spec.title, /3 sessões ociosas sem guia/)
    assert.deepEqual(spec.context?.lines, ['a', 'b', 'c'])
    assert.deepEqual(spec.choices.map(c => [c.id, c.tone]), [['close', 'neutral']])
  })
  test('long lists are cut with "e mais K"', () => {
    const spec = bulkCloseSituation(Array.from({ length: 15 }, (_, i) => `s${i}`))
    assert.equal(spec.context?.lines.length, 13)
    assert.equal(spec.context?.lines.at(-1), 'e mais 3')
  })
})

describe('isIdleForCleanup', () => {
  const idle = (ms: number, extra: Partial<SessionSlot> = {}): SessionSlot => mk('a', { idleSince: ago(ms), ...extra })
  test('live, no tab, idle for 10 min or more', () => {
    assert.equal(isIdleForCleanup(idle(10 * MIN), NOW), true)
    assert.equal(isIdleForCleanup(idle(3 * 60 * MIN), NOW), true)
  })
  test('under 10 minutes is not eligible', () => assert.equal(isIdleForCleanup(idle(10 * MIN - 1000), NOW), false))
  test('without idleSince (or an invalid one) is not eligible', () => {
    assert.equal(isIdleForCleanup(mk('a'), NOW), false)
    assert.equal(isIdleForCleanup(mk('a', { idleSince: 'garbage' }), NOW), false)
  })
  test('busy, attention, with a tab and ended are not eligible', () => {
    assert.equal(isIdleForCleanup(idle(60 * MIN, { turn: 'busy' }), NOW), false)
    assert.equal(isIdleForCleanup(idle(60 * MIN, { attention: 'done' }), NOW), false)
    assert.equal(isIdleForCleanup(idle(60 * MIN), NOW, tabs('a')), false)
    assert.equal(isIdleForCleanup(idle(60 * MIN, { status: 'exited' }), NOW), false)
  })
})

describe('sessionRows', () => {
  const slots: SessionSlot[] = [
    mk('ended-old', { status: 'exited', endedAt: ago(5 * 24 * 60 * MIN) }),
    mk('idle-new', { idleSince: ago(2 * MIN) }),
    mk('busy', { turn: 'busy' }),
    mk('idle-old', { idleSince: ago(2 * 60 * MIN) }),
    mk('ended-new', { status: 'exited', endedAt: ago(30 * 60 * MIN) }),
    mk('att', { attention: 'waiting' }),
    mk('tabbed-idle', { idleSince: ago(60 * MIN) }),
  ]
  const rows = sessionRows(slots, tabs('tabbed-idle'), NOW)
  const by = (id: string) => rows.find(r => r.slotId === id)!

  test('order: attention, busy, idle (longest first), ended (newest first)', () => {
    assert.deepEqual(rows.map(r => r.slotId), ['att', 'busy', 'idle-old', 'tabbed-idle', 'idle-new', 'ended-new', 'ended-old'])
  })
  test('turn states', () => {
    assert.deepEqual(['att', 'busy', 'idle-old', 'ended-new'].map(id => by(id).state), ['attention', 'busy', 'idle', 'ended'])
  })
  test('attention beats busy', () => {
    assert.equal(sessionRows([mk('x', { attention: 'done', turn: 'busy' })], none, NOW)[0]!.state, 'attention')
  })
  test('noTab: live without tab only', () => {
    assert.equal(by('tabbed-idle').noTab, false)
    assert.equal(by('idle-old').noTab, true)
    assert.equal(by('ended-new').noTab, false)
  })
  test('texts', () => {
    assert.equal(by('att').text, 'pede atenção')
    assert.equal(by('busy').text, 'trabalhando agora')
    assert.equal(by('idle-old').text, 'ocioso há 2 h')
    assert.equal(by('idle-new').text, 'ocioso há 2 min')
    assert.equal(by('ended-new').text, 'encerrada ontem')
    assert.equal(by('ended-old').text, 'encerrada há 5 dias')
  })
  test('without timestamps the text stays plain and the order is stable', () => {
    const r = sessionRows([mk('a'), mk('b', { status: 'exited' }), mk('c')], none, NOW)
    assert.deepEqual(r.map(x => [x.slotId, x.text]), [['a', 'ocioso'], ['c', 'ocioso'], ['b', 'encerrada']])
  })
  test('name: name, then title, then folder', () => {
    const r = sessionRows([mk('a', { name: 'Meu' }), mk('b', { title: 'Titulo' }), mk('c', { cwd: 'C:\\work\\pasta' })], none, NOW)
    assert.deepEqual(r.map(x => x.name), ['Meu', 'Titulo', 'pasta'])
  })
  test('cleanup flag follows isIdleForCleanup', () => {
    assert.deepEqual(rows.filter(r => r.cleanup).map(r => r.slotId), ['idle-old'])
  })
})

describe('bulkCloseAction', () => {
  test('lists the eligible names; excludes busy, attention, tab, under 10 min and no idleSince', () => {
    const slots: SessionSlot[] = [
      mk('ok1', { name: 'Um', idleSince: ago(20 * MIN) }),
      mk('ok2', { name: 'Dois', idleSince: ago(3 * 60 * MIN) }),
      mk('busy', { turn: 'busy', idleSince: ago(60 * MIN) }),
      mk('att', { attention: 'done', idleSince: ago(60 * MIN) }),
      mk('tab', { idleSince: ago(60 * MIN) }),
      mk('fresh', { idleSince: ago(5 * MIN) }),
      mk('unknown'),
      mk('gone', { status: 'exited', idleSince: ago(60 * MIN) }),
    ]
    const a = bulkCloseAction(sessionRows(slots, tabs('tab'), NOW))
    assert.equal(a.n, 2)
    assert.deepEqual(a.names, ['Dois', 'Um'])
    assert.equal(a.label, 'Encerrar os 2 ociosos sem guia')
    assert.equal(a.enabled, true)
  })
  test('nothing eligible is disabled', () => {
    const a = bulkCloseAction(sessionRows([mk('x', { turn: 'busy' })], none, NOW))
    assert.deepEqual([a.n, a.names, a.enabled], [0, [], false])
  })
  test('singular label', () => {
    assert.equal(bulkCloseAction(sessionRows([mk('x', { idleSince: ago(15 * MIN) })], none, NOW)).label, 'Encerrar o ocioso sem guia')
  })
})

describe('pauseAction (from pause-rules)', () => {
  test('counts the busy ones; nobody busy is disabled; a batch on screen disables the start', () => {
    assert.deepEqual(pauseAction([mk('a', { turn: 'busy' }), mk('b'), mk('c', { turn: 'busy' })], null), { label: 'Pedir pausa aos 2 em andamento', n: 2, enabled: true })
    assert.equal(pauseAction([mk('a')], null).enabled, false)
    assert.equal(pauseAction([mk('a', { turn: 'busy' })], batchOf('listening')).enabled, false)
  })
})

describe('sessionsCounter', () => {
  const t = (...ids: string[]) => tabs(...ids)
  test('calm shows nothing; ended and tabbed sessions do not count', () => {
    assert.deepEqual(sessionsCounter([mk('a'), mk('b', { status: 'exited' })], none, null), [])
    assert.deepEqual(sessionsCounter([mk('a', { turn: 'busy' }), mk('b', { attention: 'done' })], t('a', 'b'), null), [])
  })
  test('N sem guia running: green N', () => {
    assert.deepEqual(sessionsCounter([mk('a', { turn: 'busy' }), mk('b', { turn: 'busy' }), mk('c')], none, null), [{ tone: 'running', text: '2' }])
  })
  test('K sem guia asking attention: orange K, which beats the green N', () => {
    assert.deepEqual(sessionsCounter([mk('a', { turn: 'busy' }), mk('b', { attention: 'waiting' }), mk('c', { attention: 'done' })], none, null), [{ tone: 'attention', text: '2' }])
  })
  test('pause going: blue x/y; pause ready: green y/y', () => {
    assert.deepEqual(sessionsCounter([], none, batchOf('stopped', 'listening', 'stopped')), [{ tone: 'progress', text: '2/3' }])
    assert.deepEqual(sessionsCounter([], none, batchOf('stopped', 'stopped-silent')), [{ tone: 'done', text: '2/2' }])
  })
  test('removed entries are out of the pause count; a closed batch is not shown', () => {
    assert.deepEqual(sessionsCounter([], none, batchOf('stopped', 'removed')), [{ tone: 'done', text: '1/1' }])
    assert.deepEqual(sessionsCounter([], none, { ...batchOf('stopped'), state: 'closed' } as PauseBatch), [])
  })
  test('pause plus attention: two segments, orange first; pause hides the green N', () => {
    const slots = [mk('a', { turn: 'busy' }), mk('b', { attention: 'done' })]
    assert.deepEqual(sessionsCounter(slots, none, batchOf('listening')), [{ tone: 'attention', text: '1' }, { tone: 'progress', text: '0/1' }])
    assert.deepEqual(sessionsCounter([mk('a', { turn: 'busy' })], none, batchOf('listening')), [{ tone: 'progress', text: '0/1' }])
  })
})

describe('sessionsSummary', () => {
  test('header with all the parts', () => {
    const slots: SessionSlot[] = [
      mk('t1', { turn: 'busy' }), mk('t2', { turn: 'busy' }), mk('t3', { turn: 'busy' }), mk('t4', { attention: 'done' }),
      mk('s1'), mk('s2', { attention: 'waiting' }), mk('s3', { turn: 'busy' }),
      ...Array.from({ length: 59 }, (_, i) => mk(`e${i}`, { status: 'exited' })),
    ]
    const s = sessionsSummary(slots, tabs('t1', 't2', 't3', 't4'), null)
    assert.equal(s.header, '4 em andamento · 2 pedem atenção · 3 sem guia · 59 encerradas')
    assert.equal(s.tooltip, `Sessões: ${s.header}`)
  })
  test('the plan example and singular forms', () => {
    const slots = [mk('a', { turn: 'busy' }), mk('b', { turn: 'busy' }), mk('c', { turn: 'busy' }), mk('d', { attention: 'done' }), mk('e'), mk('f', { status: 'exited' })]
    assert.equal(sessionsSummary(slots, tabs('a', 'b', 'c', 'd'), null).header, '3 em andamento · 1 pede atenção · 1 sem guia · 1 encerrada')
  })
  test('empty, and the tooltip carries the pause state', () => {
    assert.equal(sessionsSummary([], none, null).header, 'Nenhuma sessão')
    assert.match(sessionsSummary([], none, batchOf('stopped', 'listening')).tooltip, /Pausa em andamento: 1 de 2 pararam/)
  })
})
