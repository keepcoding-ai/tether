// The "Sessões" model (app/renderer/sessions-rules.ts), pure: grouping, rows, bulk close, counter, summary, texts.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { SlotState, SlotStatus } from '../../src/daemon/protocol.ts'
import type { PauseBatch, PauseEntry, PauseEntryState } from '../../src/daemon/pause.ts'
import {
  CHOOSE_PLACE_LABEL, deskChoices, rowMenuPlan, bulkCloseAction, bulkCloseSituation, forgetEndedSituation, formatAgo, formatMemory, liveMemoryTotal, groupClosed, isIdleForCleanup, pauseAction, pausePreview, popupGroups,
  resolvePopupSelection, resumePreview, shortFolder, sessionRows, sessionsCounter, stopHeldSituation,
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
  test('a held session (owner, channel member) is spared: not listed, not counted, and the hint says how many', () => {
    const slots: SessionSlot[] = [
      mk('free', { name: 'Livre', idleSince: ago(20 * MIN) }),
      mk('boss', { name: 'Dona', idleSince: ago(60 * MIN) }),
      mk('boss2', { name: 'Dono2', idleSince: ago(60 * MIN) }),
      mk('fresh-boss', { idleSince: ago(2 * MIN) }),
    ]
    const heldOf = (id: string): string | undefined => (id.includes('boss') ? 'dono de 2 mesas' : undefined)
    const rows = sessionRows(slots, none, NOW, heldOf)
    const a = bulkCloseAction(rows)
    assert.deepEqual([a.n, a.names, a.spared], [1, ['Livre'], 2])
    assert.equal(a.hint, '2 poupados: são donos ou membros de canal')
    assert.equal(rows.find(r => r.slotId === 'boss')!.held, 'dono de 2 mesas')
    assert.equal(rows.find(r => r.slotId === 'fresh-boss')!.spared, false, 'not idle enough: nothing to spare')
    const only = bulkCloseAction(sessionRows(slots.slice(1, 2), none, NOW, heldOf))
    assert.deepEqual([only.n, only.enabled, only.hint], [0, false, '1 poupado: é dono ou membro de canal'])
    assert.equal(bulkCloseAction(sessionRows(slots, none, NOW)).hint, '')
  })
  test('stopHeldSituation names the session and what it holds', () => {
    const s = stopHeldSituation('Atrium', 'dono de 2 mesas e 1 guia')
    assert.equal(s.title, 'Atrium é dono de 2 mesas e 1 guia. Encerrar mesmo assim?')
    assert.equal(s.choices[0]!.id, 'close')
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
    assert.deepEqual(sessionsCounter([mk('a', { status: 'exited' })], none, null), [])
    assert.deepEqual(sessionsCounter([mk('a', { turn: 'busy' }), mk('b', { attention: 'done' }), mk('c')], t('a', 'b', 'c'), null), [])
  })
  test('one idle session without a tab: neutral 1', () => {
    assert.deepEqual(sessionsCounter([mk('a'), mk('b', { status: 'exited' })], none, null), [{ tone: 'idle', text: '1' }])
  })
  test('busy sessions without a tab: green, the text is the total including idle ones', () => {
    assert.deepEqual(sessionsCounter([mk('a', { turn: 'busy' }), mk('b', { turn: 'busy' }), mk('c')], none, null), [{ tone: 'running', text: '3' }])
  })
  test('attention wins the tone and the text is still the total', () => {
    assert.deepEqual(sessionsCounter([mk('a', { turn: 'busy' }), mk('b', { attention: 'waiting' }), mk('c')], none, null), [{ tone: 'attention', text: '3' }])
  })
  test('pause going: blue x/y; pause ready: green y/y', () => {
    assert.deepEqual(sessionsCounter([], none, batchOf('stopped', 'listening', 'stopped')), [{ tone: 'progress', text: '2/3' }])
    assert.deepEqual(sessionsCounter([], none, batchOf('stopped', 'stopped-silent')), [{ tone: 'done', text: '2/2' }])
  })
  test('removed entries are out of the pause count; a closed batch is not shown', () => {
    assert.deepEqual(sessionsCounter([], none, batchOf('stopped', 'removed')), [{ tone: 'done', text: '1/1' }])
    assert.deepEqual(sessionsCounter([], none, { ...batchOf('stopped'), state: 'closed' } as PauseBatch), [])
  })
  test('pause plus sessions without a tab: two segments, sem guia first; pause alone: one segment', () => {
    const slots = [mk('a', { turn: 'busy' }), mk('b', { attention: 'done' }), mk('c')]
    assert.deepEqual(sessionsCounter(slots, none, batchOf('listening')), [{ tone: 'attention', text: '3' }, { tone: 'progress', text: '0/1' }])
    assert.deepEqual(sessionsCounter([mk('a')], none, batchOf('listening')), [{ tone: 'idle', text: '1' }, { tone: 'progress', text: '0/1' }])
    assert.deepEqual(sessionsCounter([mk('a')], t('a'), batchOf('listening')), [{ tone: 'progress', text: '0/1' }])
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

describe('popup: groups and previews', () => {
  const rowsOf = (slots: SessionSlot[]) => sessionRows(slots, none, NOW)
  const mixed = [
    mk('i1', { idleSince: ago(30 * MIN) }), mk('b1', { turn: 'busy' }), mk('a1', { attention: 'waiting' }),
    mk('b2', { turn: 'busy' }), mk('i2', { idleSince: ago(5 * MIN) }), mk('x', { status: 'exited', endedAt: ago(MIN) }),
  ]

  test('shortFolder keeps the last two segments', () => {
    assert.equal(shortFolder('D:\\atrium\\workspace\\tether'), 'workspace/tether')
    assert.equal(shortFolder('/work/x'), 'work/x')
    assert.equal(shortFolder('/x'), 'x')
    assert.equal(shortFolder('/'), '/')
  })

  test('without a pause: attention, busy, idle; ended and empty groups left out', () => {
    const g = popupGroups(rowsOf(mixed), null)
    assert.deepEqual(g.map(x => [x.id, x.title]), [['attention', 'Pedem atenção'], ['busy', 'Em andamento'], ['idle', 'Ociosas']])
    assert.deepEqual(g[1]!.slotIds, ['b1', 'b2'])
    assert.deepEqual(g[2]!.slotIds, ['i1', 'i2'])
    assert.deepEqual(popupGroups(rowsOf([mk('b1', { turn: 'busy' })]), null).map(x => x.id), ['busy'])
    assert.deepEqual(popupGroups([], null), [])
  })

  test('with a pause: the batch first, every other live session under Fora da pausa', () => {
    const batch = batchOf('stopped', 'preparing')
    const slots = [mk('p0'), mk('p1', { turn: 'busy' }), mk('o1', { turn: 'busy' }), mk('o2', { idleSince: ago(MIN) })]
    const g = popupGroups(rowsOf(slots), batch)
    assert.deepEqual(g.map(x => x.id), ['pause', 'outside'])
    assert.deepEqual(g[0]!.slotIds, ['p1', 'p0'])
    assert.deepEqual(g[1]!.slotIds, ['o1', 'o2'])
    assert.deepEqual(popupGroups(rowsOf([mk('p0'), mk('p1')]), batch).map(x => x.id), ['pause'])
  })

  test('selection stays while the session is listed, else the first row', () => {
    const g = popupGroups(rowsOf(mixed), null)
    assert.equal(resolvePopupSelection(g, 'b2'), 'b2')
    assert.equal(resolvePopupSelection(g, 'gone'), 'a1')
    assert.equal(resolvePopupSelection([], 'a1'), undefined)
  })

  test('pause preview: who gets the request, who does not, singular and plural', () => {
    const p = pausePreview(mixed)
    assert.equal(p.n, 2)
    assert.equal(p.enabled, true)
    assert.equal(p.text, 'Vão receber o pedido: 2 em andamento · 2 ociosas e 1 pedindo atenção não são afetadas')
    assert.equal(p.buttonLabel, 'Pedir pausa aos 2 em andamento')
    const one = pausePreview([mk('b', { turn: 'busy' }), mk('i')])
    assert.equal(one.text, 'Vai receber o pedido: 1 em andamento · 1 ociosa não é afetada')
    assert.equal(one.buttonLabel, 'Pedir pausa ao agente em andamento')
    assert.equal(pausePreview([mk('b', { turn: 'busy' })]).text, 'Vai receber o pedido: 1 em andamento')
  })

  test('pause preview: nobody busy disables the button', () => {
    const p = pausePreview([mk('i'), mk('a', { attention: 'done' })])
    assert.deepEqual([p.n, p.enabled], [0, false])
    assert.match(p.text, /Ninguém em andamento/)
    assert.equal(pausePreview([mk('x', { status: 'exited' })]).text, 'Nenhuma sessão rodando agora')
  })

  test('resume preview: everyone with a note returns', () => {
    const batch = batchOf('stopped', 'stopped')
    ;(batch.entries[0] as PauseEntry).note = 'a'; (batch.entries[1] as PauseEntry).note = 'b'
    const r = resumePreview(batch, [mk('p0'), mk('p1')])
    assert.deepEqual([r.returning, r.withNote, r.skipped.length], [2, 2, 0])
    assert.equal(r.text, 'Vão voltar: 2, cada uma com sua nota')
    assert.equal(r.skippedText, '')
  })

  test('resume preview: busy, waiting and gone are skipped with the reason; silent stops return without a note', () => {
    const batch = batchOf('stopped', 'stopped', 'stopped-silent', 'stopped', 'stopped')
    ;(batch.entries[0] as PauseEntry).note = 'a'
    const r = resumePreview(batch, [mk('p0'), mk('p1', { turn: 'busy' }), mk('p2'), mk('p3', { attention: 'waiting' })])
    assert.deepEqual([r.returning, r.withNote], [2, 1])
    assert.equal(r.text, 'Vão voltar: 2 · 1 com nota')
    assert.deepEqual(r.skipped.map(s => [s.slotId, s.reason]), [['p1', 'ocupada'], ['p3', 'esperando você'], ['p4', 'não existe mais']])
    assert.equal(r.skippedText, '3 não voltam: 1 ocupada, 1 esperando você, 1 não existe mais')
    const one = resumePreview(batchOf('stopped'), [mk('p0', { turn: 'busy' })])
    assert.equal(one.text, 'Nenhuma sessão volta agora')
    assert.equal(one.skippedText, '1 não volta: ocupada')
  })
})

describe('memory and time texts', () => {
  test('formatMemory: MB rounded, GB with one decimal and comma', () => {
    assert.equal(formatMemory(420.4), '420 MB')
    assert.equal(formatMemory(1023.4), '1023 MB')
    assert.equal(formatMemory(1229), '1,2 GB')
    assert.equal(formatMemory(3277), '3,2 GB')
    assert.equal(formatMemory(0), '')
    assert.equal(formatMemory(undefined), '')
    assert.equal(formatMemory(Number.NaN), '')
  })
  test('busySince and endedAt phrase the row', () => {
    const rows = sessionRows([
      mk('b1', { turn: 'busy', busySince: ago(12 * MIN) }), mk('b2', { turn: 'busy', busySince: ago(10_000) }), mk('b3', { turn: 'busy' }),
      mk('e1', { status: 'exited', endedAt: ago(2 * 60 * MIN) }), mk('e2', { status: 'exited', endedAt: ago(20 * 24 * 60 * MIN) }),
    ], none, NOW)
    const t = (id: string) => rows.find(r => r.slotId === id)!.text
    assert.equal(t('b1'), 'trabalhando há 12 min')
    assert.equal(t('b2'), 'trabalhando agora')
    assert.equal(t('b3'), 'trabalhando agora')
    assert.equal(t('e1'), 'encerrada há 2 h')
    assert.match(t('e2'), /^encerrada em \d{1,2} out$/)
  })
  test('row memory: live only', () => {
    const rows = sessionRows([mk('a', { memoryMB: 420 }), mk('b', { status: 'exited', memoryMB: 99 }), mk('c')], none, NOW)
    assert.deepEqual(rows.map(r => [r.slotId, r.memory]), [['a', '420 MB'], ['c', ''], ['b', '']])
  })
  test('idle ties go to the heavier one first', () => {
    const at = ago(30 * MIN)
    const rows = sessionRows([mk('a', { idleSince: at, memoryMB: 100 }), mk('b', { idleSince: at, memoryMB: 900 }), mk('c', { idleSince: at })], none, NOW)
    assert.deepEqual(rows.map(r => r.slotId), ['b', 'a', 'c'])
  })
  test('summary adds the total of the sessions without a tab; tooltip too', () => {
    const slots = [mk('t', { turn: 'busy', memoryMB: 5000 }), mk('a', { memoryMB: 1500 }), mk('b', { memoryMB: 1777 })]
    const s = sessionsSummary(slots, tabs('t'), null)
    assert.equal(s.header, '1 em andamento · 2 sem guia · 3,2 GB')
    assert.equal(s.tooltip, `Sessões: ${s.header}`)
    assert.equal(sessionsSummary([mk('a')], none, null).header, '1 sem guia')
  })
  test('liveMemoryTotal sums live sessions only', () => {
    assert.equal(liveMemoryTotal([mk('a', { memoryMB: 500 }), mk('b', { memoryMB: 600 }), mk('c', { status: 'exited', memoryMB: 9000 })]), '1,1 GB')
    assert.equal(liveMemoryTotal([mk('a')]), '')
  })
})

describe('the rows\' right-click menus and the desk list', () => {
  test('"Sem guia": peek, open here, open elsewhere (a submenu), rename, then stop', () => {
    const plan = rowMenuPlan('free')
    assert.deepEqual(plan.map(i => i.label), ['Espiar', 'Abrir nesta mesa', 'Abrir em outra mesa', 'Renomear…', 'Encerrar…'])
    assert.deepEqual(plan.map(i => i.action), ['peek', 'open-here', 'open-other', 'rename', 'stop'])
    assert.deepEqual(plan.filter(i => i.submenu).map(i => i.action), ['open-other'])
    assert.deepEqual(plan.filter(i => i.sepBefore).map(i => i.action), ['rename', 'stop'])
    assert.equal(plan.find(i => i.action === 'stop')?.danger, true)
  })
  test('"Encerradas": reopen, reopen here, reopen elsewhere (a submenu), a separator, then forget', () => {
    const plan = rowMenuPlan('ended')
    assert.deepEqual(plan.map(i => i.label), ['Reabrir', 'Reabrir nesta mesa', 'Reabrir em outra mesa', 'Esquecer'])
    assert.deepEqual(plan.filter(i => i.submenu).map(i => i.action), ['reopen-other'])
    assert.deepEqual(plan.filter(i => i.sepBefore).map(i => i.action), ['forget'])
  })
  test('the desk list marks the current desk, keeps the order and names a nameless desk', () => {
    const list = deskChoices([{ id: 'a', name: 'obra' }, { id: 'b', name: '  ' }, { id: 'c', name: 'casa' }], 'c')
    assert.deepEqual(list, [
      { id: 'a', label: 'obra', current: false },
      { id: 'b', label: 'Mesa 2', current: false },
      { id: 'c', label: 'casa', current: true },
    ])
    assert.equal(CHOOSE_PLACE_LABEL, 'Escolher o lugar…')
  })
})
