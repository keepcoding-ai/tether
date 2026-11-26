// The pure halves of the S5 seams (R5a): the ronda on TetherUi.agents (agent-panes.ts), the launch profiles an extension
// sees (profile-views.ts: env names, never values) and the top bar's status icons as data (status-rules.ts statusViewsOf).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Reply, SlotState } from '../../src/daemon/protocol.ts'
import type { Profile } from '../../src/core/profile.ts'
import { agentPaneChanges, agentPaneOf, agentRondaOf, loosePaneOf, rondaAnswerOf, rondaSetRequest, type PanePlace } from '../../app/renderer/agent-panes.ts'
import { profileViewOf, profileViewsOf } from '../../app/renderer/profile-views.ts'
import { StatusRegistry, statusViewsOf } from '../../app/renderer/status-rules.ts'

const slot = (over: Partial<SlotState> = {}): SlotState => ({ slotId: 's1', kind: 'claude', cwd: '/work/proj/', status: 'running', ...over })
const place: PanePlace = { paneId: 's1', deskId: 'd1', deskTitle: 'Mesa 1', isSystemDesk: false, inDrawer: false }
const ronda = (over: Partial<NonNullable<SlotState['ronda']>> = {}): NonNullable<SlotState['ronda']> =>
  ({ v: 1, intervalMs: 600_000, createdAt: '2026-11-26T10:00:00.000Z', nextAt: '2026-11-26T10:10:00.000Z', ...over })

test('agentRondaOf: off is undefined; on keeps interval, next, last, nudge, criterion, due and channel, nothing else', () => {
  assert.equal(agentRondaOf(undefined), undefined)
  assert.equal(agentRondaOf(null), undefined)
  assert.deepEqual(agentRondaOf(ronda()), { intervalMs: 600_000, nextAt: '2026-11-26T10:10:00.000Z' })
  assert.deepEqual(agentRondaOf(ronda({ lastAt: '2026-11-26T10:00:00.000Z', nudge: 'olhe o build', criterion: 'testes verdes', due: true, channel: 'none' })), {
    intervalMs: 600_000, nextAt: '2026-11-26T10:10:00.000Z', lastAt: '2026-11-26T10:00:00.000Z', nudge: 'olhe o build', criterion: 'testes verdes', due: true, channel: 'none',
  })
  const r = agentRondaOf(ronda({ due: false, channel: 'listening' }))!
  assert.equal('due' in r, false, 'due only while true')
  assert.equal(r.channel, 'listening')
  assert.equal('createdAt' in r || 'v' in r, false)
})

test('the agent pane carries its ronda while on, placed or loose; a change of the ronda is a change of the pane', () => {
  assert.equal('ronda' in agentPaneOf(slot(), place)!, false)
  assert.deepEqual(agentPaneOf(slot({ ronda: ronda() }), place)!.ronda, { intervalMs: 600_000, nextAt: '2026-11-26T10:10:00.000Z' })
  assert.deepEqual(loosePaneOf(slot({ ronda: ronda({ channel: 'listening' }) }))!.ronda, { intervalMs: 600_000, nextAt: '2026-11-26T10:10:00.000Z', channel: 'listening' })
  const off = [agentPaneOf(slot(), place)!]
  const on = [agentPaneOf(slot({ ronda: ronda() }), place)!]
  const later = [agentPaneOf(slot({ ronda: ronda({ nextAt: '2026-11-26T10:20:00.000Z', due: true }) }), place)!]
  assert.equal(agentPaneChanges(off, on).length, 1, 'switched on')
  assert.equal(agentPaneChanges(on, later).length, 1, 'next nudge moved, due')
  assert.equal(agentPaneChanges(later, off).length, 1, 'switched off')
  assert.equal(agentPaneChanges(on, [agentPaneOf(slot({ ronda: ronda() }), place)!]).length, 0, 'same ronda: no event')
})

test('rondaSetRequest: only the fields given; an empty text clears', () => {
  assert.deepEqual(rondaSetRequest('s1', {}), { t: 'ronda-set', slotId: 's1' })
  assert.deepEqual(rondaSetRequest('s1', { interval: '1h', criterion: '' }), { t: 'ronda-set', slotId: 's1', interval: '1h', criterion: '' })
  assert.deepEqual(rondaSetRequest('s1', { nudge: 'x' }), { t: 'ronda-set', slotId: 's1', nudge: 'x' })
})

test('rondaAnswerOf: an ok reply gives the ronda and the outcome; a refusal is data with its code and sentence', () => {
  assert.deepEqual(rondaAnswerOf({ t: 'ok', id: 1, ronda: ronda(), rondaOutcome: 'created' }), { ok: true, ronda: { intervalMs: 600_000, nextAt: '2026-11-26T10:10:00.000Z' }, outcome: 'created' })
  assert.deepEqual(rondaAnswerOf({ t: 'ok', id: 1, ronda: null, rondaOutcome: 'off' }), { ok: true, ronda: undefined, outcome: 'off' })
  assert.deepEqual(rondaAnswerOf({ t: 'ok', id: 1, ronda: null, rondaOutcome: 'was-off' }), { ok: true, ronda: undefined, outcome: 'was-off' })
  const criterion: Reply = { t: 'error', id: 1, code: 'ronda-criterion', message: 'Esta ronda tem um critério de parada: testes verdes.' }
  assert.deepEqual(rondaAnswerOf(criterion), { ok: false, code: 'ronda-criterion', message: 'Esta ronda tem um critério de parada: testes verdes.' })
  assert.deepEqual(rondaAnswerOf({ t: 'error', id: 1, code: 'ronda-unavailable', message: 'um shell não ouve canal' }), { ok: false, code: 'ronda-unavailable', message: 'um shell não ouve canal' })
})

const SECRET = 'sk-valor-que-nunca-sai'
const profile = (over: Partial<Profile> = {}): Profile => ({ id: 'dev', name: 'Claude modo dev', agent: 'claude', args: ['--dangerously-skip-permissions'], ...over })

test('profileViewOf: engine, args, folder, default and unsafe; env only by its variable names, never a value', () => {
  const p = profile({ env: { ZED_TOKEN: SECRET, API_KEY: SECRET, CLAUDE_CONFIG_DIR: 'C:/cfg' }, cwd: 'C:/work', default: true })
  const v = profileViewOf(p)
  assert.deepEqual(v, { id: 'dev', name: 'Claude modo dev', agent: 'claude', args: ['--dangerously-skip-permissions'], cwd: 'C:/work', default: true, unsafe: true, envNames: ['API_KEY', 'CLAUDE_CONFIG_DIR', 'ZED_TOKEN'] })
  const text = JSON.stringify(profileViewsOf([p, profile({ id: 'b', env: { X: SECRET } })]))
  assert.equal(text.includes(SECRET), false, 'no env value in the view')
  assert.equal(text.includes('C:/cfg'), false, 'not even a harmless-looking one')
  assert.equal('env' in v, false)
  p.args.push('--x') // the view holds a copy: a later change to the profile does not reach it

  assert.deepEqual(v.args, ['--dangerously-skip-permissions'])
})

test('profileViewOf: a shell profile shows its executable and its args first; no env is an empty list; not unsafe stays out', () => {
  const v = profileViewOf({ id: 'pwsh', name: 'PowerShell', agent: 'shell', args: ['-NoLogo'], shell: { command: 'pwsh.exe', args: ['-NoProfile'] } })
  assert.deepEqual(v, { id: 'pwsh', name: 'PowerShell', agent: 'shell', args: ['-NoProfile', '-NoLogo'], shell: 'pwsh.exe', envNames: [] })
  assert.equal('unsafe' in profileViewOf(profile({ args: [] })), false)
})

test('statusViewsOf: the bar\'s icons in order with title, state and badge; a throwing callback does not break the list', () => {
  const reg = new StatusRegistry()
  reg.declare({ id: 'sync.status', icon: 'cloud', order: 20, extension: 'sync' })
  reg.declare({ id: 'web-bridge.status', icon: 'plug', order: 10, extension: 'web-bridge' })
  reg.declare({ id: 'late.status', icon: 'x', extension: 'late' })
  reg.register({ id: 'sync.status', title: () => 'Sync: em dia', render: () => {}, state: () => 'busy', badge: () => 3.7 })
  reg.register({ id: 'web-bridge.status', title: () => 'Bridge: desconectada', render: () => {}, state: () => 'warn', badge: () => 'dot' })
  assert.deepEqual(statusViewsOf(reg.all()), [
    { id: 'web-bridge.status', extension: 'web-bridge', icon: 'plug', title: 'Bridge: desconectada', state: 'warn', badge: 'dot' },
    { id: 'sync.status', extension: 'sync', icon: 'cloud', title: 'Sync: em dia', state: 'busy', badge: 3 },
  ], 'an undeclared-only or unregistered icon is not drawn, so not listed')
  reg.register({ id: 'late.status', title: () => { throw new Error('x') }, render: () => {}, state: () => { throw new Error('y') }, badge: () => 0 })
  const late = statusViewsOf(reg.all()).find(s => s.id === 'late.status')!
  assert.deepEqual(late, { id: 'late.status', extension: 'late', icon: 'x', title: 'late.status', state: 'normal' })
})
