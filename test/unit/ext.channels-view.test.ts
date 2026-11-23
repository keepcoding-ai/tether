// The channel pane's view model (extensions/channels/renderer/view-model.ts, slice U1a): pure functions, no DOM, no daemon.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentHue } from '../../app/shared/agent-color.ts'
import type { Line } from '../../extensions/channels/rules.ts'
import type { ChannelSummary, MemberInfo } from '../../extensions/channels/daemon/requests.ts'
import { channelIdOfPane, channelPaneId, manifest } from '../../extensions/channels/manifest.ts'
import {
  applyLine, applyPage, emptyTimeline, headerOf, idByName, isNearBottom, memberRows, mergeNewest, muteBar, olderCursor, rowsOf, dayLabel,
  type MembersAnswer, type SayRow,
} from '../../extensions/channels/renderer/view-model.ts'

const at = (h: number, m = 0): string => new Date(2026, 10, 23, h, m).toISOString()
const say = (seq: number, id: string, name: string, role: 'owner' | 'member' | 'moderator', body: string, extra: Partial<Line> = {}): Line =>
  ({ seq, at: at(14, seq), kind: 'message', from: { id, name, role }, body, ...extra })
const notice = (seq: number, type: NonNullable<Line['event']>['type'], body: string): Line =>
  ({ seq, at: at(14, seq), kind: 'notice', from: { id: 'tether', name: 'tether', role: 'system' }, body, event: { type } })

const summary = (extra: Partial<ChannelSummary> = {}): ChannelSummary => ({
  id: 'c1', name: 'obra', title: 'Obra', owner: { kind: 'agent', id: 'a1', name: 'Atrium' }, members: 3, seenByUser: 0, createdAt: at(13), ...extra,
})
const member = (id: string, name: string, extra: Partial<MemberInfo> = {}): MemberInfo =>
  ({ id, name, muted: false, since: at(13), by: 'user', alive: true, path: 'inside', ...extra })
const answer = (extra: Partial<MembersAnswer> = {}): MembersAnswer => ({
  channel: summary(),
  members: [member('b2', 'claude · conferente'), member('a1', 'Atrium'), member('c3', 'codex · conferência', { muted: true, path: 'wait' })],
  removed: [],
  ...extra,
})

test('the pane type: id channel:<id>, params carry the channel id', () => {
  assert.equal(channelPaneId('c1'), 'channel:c1')
  assert.equal(channelIdOfPane('channel:c1'), 'c1')
  const t = manifest.contributes!.paneTypes![0]!
  assert.equal(t.idPrefix, 'channel:')
  const o = t.optionsOf({ id: 'channel:c9', title: '#obra', params: {} })
  assert.equal(o.title, '#obra')
  assert.deepEqual(o.params, { channelId: 'c9' })
})

test('rows: a say and a system notice are drawn apart; a day separator opens the list', () => {
  const now = new Date(2026, 10, 23, 18)
  const rows = rowsOf([
    notice(1, 'create', 'Atrium criou o canal'),
    say(2, 'a1', 'Atrium', 'owner', 'oi', { to: ['claude · conferente'] }),
    notice(3, 'mute', 'Atrium calou codex'),
    say(4, 'user', 'usuário', 'moderator', 'ok', { to: ['Atrium'] }),
  ], { idByName: new Map([['Atrium', 'a1'], ['claude · conferente', 'b2']]), now })
  assert.deepEqual(rows.map(r => r.kind), ['day', 'notice', 'say', 'notice', 'say'])
  assert.equal((rows[0] as { label: string }).label, 'hoje')
  const n = rows[1] as { glyph: string; text: string; time: string }
  assert.equal(n.glyph, 'create')
  assert.equal(n.text, 'Atrium criou o canal')
  assert.match(n.time, /^\d\d:\d\d$/)
  assert.equal((rows[3] as { glyph: string }).glyph, 'mute')
  const owner = rows[2] as SayRow
  assert.deepEqual([owner.name, owner.role, owner.crown, owner.mine, owner.hue], ['Atrium', 'dono', true, false, agentHue('a1')])
  assert.deepEqual(owner.to, [{ name: 'claude · conferente', you: false, hue: agentHue('b2') }])
  const me = rows[4] as SayRow
  assert.deepEqual([me.name, me.role, me.mine, me.crown, me.hue], ['Você', 'moderador', true, false, undefined])
})

test('rows: "para todos" has no addressee, "usuário" in `to` reads "você"; same author, same addressees: one header', () => {
  const rows = rowsOf([
    say(1, 'b2', 'claude · conferente', 'member', 'um'),
    say(2, 'b2', 'claude · conferente', 'member', 'dois'),
    say(3, 'b2', 'claude · conferente', 'member', 'três', { to: ['usuário'] }),
    say(4, 'a1', 'Atrium', 'owner', 'quatro'),
    notice(5, 'join', 'entrou'),
    say(6, 'a1', 'Atrium', 'owner', 'cinco'),
  ])
  const says = rows.filter((r): r is SayRow => r.kind === 'say')
  assert.deepEqual(says.map(s => s.continued), [false, true, false, false, false], 'a notice or another author breaks the group')
  assert.deepEqual(says[0]!.to, [])
  assert.deepEqual(says[2]!.to, [{ name: 'você', you: true }])
  assert.equal(says[0]!.role, 'membro')
})

test('rows: a day change opens a separator; ontem and a date', () => {
  const now = new Date(2026, 10, 23, 9)
  const old: Line = { ...say(1, 'b2', 'x', 'member', 'a'), at: new Date(2026, 10, 22, 23, 50).toISOString() }
  const older: Line = { ...say(2, 'b2', 'x', 'member', 'b'), at: new Date(2026, 9, 3, 10).toISOString() }
  const rows = rowsOf([older, old, say(3, 'b2', 'x', 'member', 'c')], { now })
  assert.deepEqual(rows.filter(r => r.kind === 'day').map(r => (r as { label: string }).label), ['03/10', 'ontem', 'hoje'])
  assert.equal(dayLabel(new Date(2025, 0, 2).toISOString(), now), '02/01/2025')
})

test('timeline: the newest page, then older pages by `before`, never a repeat', () => {
  const page1 = { lines: [say(3, 'b2', 'x', 'member', 'c'), say(4, 'b2', 'x', 'member', 'd')], more: true, last: 4 }
  let t = applyPage(emptyTimeline(), page1, false)
  assert.deepEqual(t.lines.map(l => l.seq), [3, 4])
  assert.equal(olderCursor(t), 3)
  t = applyPage(t, { lines: [say(1, 'b2', 'x', 'member', 'a'), say(2, 'b2', 'x', 'member', 'b'), say(3, 'b2', 'x', 'member', 'c')], more: false, last: 4 }, true)
  assert.deepEqual(t.lines.map(l => l.seq), [1, 2, 3, 4])
  assert.equal(olderCursor(t), undefined, 'nothing older: no cursor')
  assert.equal(t.last, 4)
})

test('timeline: a new line appends; a repeat is ignored; a hole asks for the newest page again', () => {
  let t = applyPage(emptyTimeline(), { lines: [say(1, 'b2', 'x', 'member', 'a'), say(2, 'b2', 'x', 'member', 'b')], more: false, last: 2 }, false)
  const next = applyLine(t, say(3, 'b2', 'x', 'member', 'c'))
  assert.deepEqual([next.added, next.gap, next.timeline.last, next.timeline.lines.length], [true, false, 3, 3])
  t = next.timeline
  const again = applyLine(t, say(3, 'b2', 'x', 'member', 'c'))
  assert.deepEqual([again.added, again.timeline === t], [false, true])
  const hole = applyLine(t, say(6, 'b2', 'x', 'member', 'f'))
  assert.deepEqual([hole.added, hole.gap], [true, true])
})

test('timeline: the newest page over what is held fills the end; a page that does not touch it replaces', () => {
  const held = applyPage(emptyTimeline(), { lines: [say(3, 'b2', 'x', 'member', 'c'), say(4, 'b2', 'x', 'member', 'd')], more: true, last: 4 }, false)
  const filled = mergeNewest(held, { lines: [say(4, 'b2', 'x', 'member', 'd'), say(5, 'b2', 'x', 'member', 'e')], more: true, last: 5 })
  assert.deepEqual(filled.lines.map(l => l.seq), [3, 4, 5])
  assert.equal(olderCursor(filled), 3, 'the held older end is kept')
  const far = mergeNewest(held, { lines: [say(9, 'b2', 'x', 'member', 'i'), say(10, 'b2', 'x', 'member', 'j')], more: true, last: 10 })
  assert.deepEqual(far.lines.map(l => l.seq), [9, 10])
  assert.deepEqual(mergeNewest(emptyTimeline(), { lines: [], more: false, last: 0 }).lines, [])
})

test('members: the owner first, the state of each, muted marked', () => {
  const rows = memberRows(answer())
  assert.deepEqual(rows.map(r => r.name), ['Atrium', 'claude · conferente', 'codex · conferência'])
  assert.deepEqual(rows.map(r => r.role), ['dono', 'membro', 'membro'])
  assert.deepEqual(rows.map(r => r.crown), [true, false, false])
  assert.deepEqual(rows.map(r => r.muted), [false, false, true])
  assert.deepEqual(rows.map(r => r.tone), ['on', 'on', 'wait'])
  assert.equal(rows[0]!.state, 'ouvindo')
  assert.equal(rows[2]!.state, 'ouve quando a guia ficar livre')
  const away = memberRows(answer({ members: [member('b2', 'x', { path: 'away', alive: false }), member('t', 'term', { path: 'terminal' })] }))
  assert.deepEqual(away.map(r => [r.state, r.tone]), [['parado', 'off'], ['ouve pelo terminal', 'on']])
})

test('header: title with #, count, owner, closed; the person owns: "Você"', () => {
  const h = headerOf(answer())
  assert.equal(h.title, '#obra')
  assert.equal(h.sub, '3 membros · dono: Atrium')
  assert.equal(h.mutedCount, 1)
  assert.equal(h.ownerHue, agentHue('a1'))
  const mine = headerOf(answer({ channel: summary({ owner: { kind: 'user' }, closed: { at: at(15), by: 'user' } as ChannelSummary['closed'] }), members: [member('b2', 'x')] }))
  assert.equal(mine.sub, '1 membro · dono: Você · encerrado')
  assert.equal(mine.closed, true)
  assert.equal(mine.ownerHue, undefined)
})

test('mute bar and the name → id map', () => {
  assert.equal(muteBar(answer()), '1 calado neste canal: codex · conferência. Ouve tudo e não fala.')
  assert.equal(muteBar(answer({ members: [member('a', 'x')] })), '')
  assert.equal(idByName(answer()).get('Atrium'), 'a1')
})

test('scroll: near the bottom only inside the slack', () => {
  assert.equal(isNearBottom(900, 100, 1000), true)
  assert.equal(isNearBottom(880, 100, 1000), true)
  assert.equal(isNearBottom(500, 100, 1000), false)
})
