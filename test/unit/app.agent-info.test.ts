// The agent view extensions get (app/shared/agent-info.ts, app/renderer/agent-panes.ts) and main's tracker (app/main/agents.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { agentInfoOf, diffAgents, slotIsLive, slotTitle } from '../../app/shared/agent-info.ts'
import { agentPaneChanges, agentPaneOf, type PanePlace } from '../../app/renderer/agent-panes.ts'
import { AgentTracker, type AgentExit } from '../../app/main/agents.ts'

const slot = (over: Partial<SlotState> = {}): SlotState => ({ slotId: 's1', kind: 'claude', cwd: '/work/proj/', status: 'running', ...over })
const place = (over: Partial<PanePlace> = {}): PanePlace => ({ paneId: 's1', deskId: 'd1', deskTitle: 'Mesa 1', isSystemDesk: false, inDrawer: false, ...over })

test('slotTitle: name, else session title, else the folder name', () => {
  assert.equal(slotTitle(slot({ name: 'api', title: 'T' })), 'api')
  assert.equal(slotTitle(slot({ title: 'Refatorar' })), 'Refatorar')
  assert.equal(slotTitle(slot()), 'proj')
})

test('slotIsLive: running, starting and queued; not exited, unconfirmed or error', () => {
  for (const status of ['running', 'starting', 'queued'] as const) assert.equal(slotIsLive({ status }), true)
  for (const status of ['exited', 'unconfirmed', 'error'] as const) assert.equal(slotIsLive({ status }), false)
})

test('agentInfoOf: an agent has kind, name, profile and alive; a shell is no agent', () => {
  assert.equal(agentInfoOf(slot({ kind: 'shell' })), undefined)
  assert.deepEqual(agentInfoOf(slot({ profileId: 'work', profileName: 'Trabalho' })), { slotId: 's1', kind: 'claude', name: 'proj', profile: { id: 'work', name: 'Trabalho' }, alive: true })
  assert.deepEqual(agentInfoOf(slot({ status: 'exited', profileId: 'gone' })), { slotId: 's1', kind: 'claude', name: 'proj', profile: { id: 'gone', name: 'gone' }, alive: false })
  assert.equal('profile' in agentInfoOf(slot())!, false)
})

test('agentPaneOf: adds where the pane lives; optional place fields stay out when absent', () => {
  assert.deepEqual(agentPaneOf(slot(), place()), { slotId: 's1', kind: 'claude', name: 'proj', alive: true, paneId: 's1', deskId: 'd1', deskTitle: 'Mesa 1', isSystemDesk: false, inDrawer: false })
  const drawer = agentPaneOf(slot(), { paneId: 's1', isSystemDesk: false, inDrawer: true })!
  assert.equal('deskId' in drawer, false)
  assert.equal(drawer.inDrawer, true)
  assert.equal(agentPaneOf(slot({ kind: 'shell' }), place()), undefined)
})

test('diffAgents: added, removed, changed and exited', () => {
  const a = agentInfoOf(slot({ slotId: 'a' }))!, b = agentInfoOf(slot({ slotId: 'b' }))!, c = agentInfoOf(slot({ slotId: 'c' }))!
  const d = diffAgents([a, b], [a, c])
  assert.deepEqual(d.added.map(x => x.slotId), ['c'])
  assert.deepEqual(d.removed.map(x => x.slotId), ['b'])
  assert.deepEqual(d.exited.map(x => x.slotId), ['b'], 'a live agent that vanished exited')
  assert.deepEqual(d.changed, [])
  const renamed = { ...a, name: 'novo' }
  assert.deepEqual(diffAgents([a], [renamed]).changed, [renamed])
  const dead = { ...a, alive: false }
  const e = diffAgents([a], [dead])
  assert.deepEqual(e.changed, [dead])
  assert.deepEqual(e.exited, [dead])
  assert.deepEqual(diffAgents([dead], [dead]), { added: [], removed: [], changed: [], exited: [] })
  assert.deepEqual(diffAgents([dead], []).exited, [], 'a dead agent that vanished did not exit again')
})

test('agentPaneChanges: moves and renames are changes; a closed pane is told as not alive', () => {
  const p = agentPaneOf(slot(), place())!
  assert.deepEqual(agentPaneChanges([], [p]), [p])
  assert.deepEqual(agentPaneChanges([p], [p]), [])
  const moved = agentPaneOf(slot(), place({ deskId: 'sys', deskTitle: 'Browser', isSystemDesk: true }))!
  assert.deepEqual(agentPaneChanges([p], [moved]), [moved])
  assert.deepEqual(agentPaneChanges([p], []), [{ ...p, alive: false }])
})

test('AgentTracker: exit fires once when a live agent ends, with the reason', () => {
  const t = new AgentTracker()
  const changes: string[] = []
  const exits: AgentExit[] = []
  t.onDidChange(a => changes.push(`${a.slotId}:${a.alive}`))
  t.onDidExit(e => exits.push(e))
  t.apply(slot())
  t.apply(slot({ name: 'api' }))
  t.apply(slot({ kind: 'shell', slotId: 'sh' }))
  assert.deepEqual(changes, ['s1:true', 's1:true'])
  assert.deepEqual(t.list().map(a => a.name), ['api'])
  t.apply(slot({ name: 'api', status: 'exited' }))
  t.apply(slot({ name: 'api', status: 'exited' }))
  assert.deepEqual(exits.map(e => [e.slotId, e.reason, e.alive]), [['s1', 'exited', false]])
  assert.equal(t.get('s1')?.alive, false)
  t.apply(slot({ name: 'api' })) // started again
  t.remove('s1')
  assert.deepEqual(exits.map(e => e.reason), ['exited', 'removed'])
  assert.equal(t.get('s1'), undefined)
})

test('AgentTracker: a lost daemon ends the live agents only; reset ends nothing; a throwing listener does not stop the others', () => {
  const t = new AgentTracker()
  const exits: AgentExit[] = []
  t.reset([slot({ slotId: 'a' }), slot({ slotId: 'b', status: 'exited' })])
  t.onDidExit(() => { throw new Error('boom') })
  const off = t.onDidExit(e => exits.push(e))
  const quiet = console.error
  console.error = () => {}
  try { t.lost() } finally { console.error = quiet }
  assert.deepEqual(exits.map(e => [e.slotId, e.reason]), [['a', 'daemon-lost']])
  assert.deepEqual(t.list(), [])
  off.dispose()
  t.apply(slot({ slotId: 'z' }))
  t.remove('z')
  assert.equal(exits.length, 1, 'a disposed listener hears nothing')
})

test('AgentTracker: reset announces the list the daemon answered as changes (a listener that read the list earlier hears it), never as exits', () => {
  const t = new AgentTracker()
  const heard: [string, boolean][] = []
  const exits: AgentExit[] = []
  t.onDidChange(a => heard.push([a.slotId, a.alive]))
  t.onDidExit(e => exits.push(e))
  t.reset([slot({ slotId: 'a' }), slot({ slotId: 'b', status: 'exited' }), slot({ slotId: 'sh', kind: 'shell' })])
  assert.deepEqual(heard, [['a', true], ['b', false]], 'every agent of the list, the shell is no agent')
  heard.length = 0
  t.reset([slot({ slotId: 'a' }), slot({ slotId: 'c', name: 'novo' })])
  assert.deepEqual(heard, [['c', true], ['b', false]], 'a is unchanged: not repeated; b left the list: announced as not alive')
  assert.deepEqual(exits, [], 'a fresh connection ends nothing')
  heard.length = 0
  t.lost()
  t.reset([slot({ slotId: 'a' })])
  assert.deepEqual(heard.slice(-1), [['a', true]], 'after a lost daemon the agent that came back is announced alive again')
})
