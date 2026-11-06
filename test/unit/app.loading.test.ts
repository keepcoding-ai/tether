// The pane loading stages (app/renderer/loading.ts): what each pane says between "painted from the layout" and "terminal has output".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SlotState } from '../../src/daemon/protocol.ts'
import { hintOf, loadingStage, QueueOrder, sameHint, type LoadingInput } from '../../app/renderer/loading.ts'
import { registerAgentUi } from '../../app/renderer/agent-ui.ts'
import { claudeUi } from '../../extensions/claude/ui.ts'
import { soulUi } from '../../extensions/soul/ui.ts'

// The agent extensions' AgentUi, as the renderer host registers them at startup.
registerAgentUi(claudeUi)
registerAgentUi(soulUi)

const slot = (over: Partial<SlotState> = {}): SlotState => ({ slotId: 's1', kind: 'claude', cwd: 'C:/w', status: 'starting', ...over })
const input = (over: Partial<LoadingInput> = {}): LoadingInput => ({ daemonReady: true, slot: slot(), startPending: false, startError: false, ready: false, ...over })
const stageOf = (over: Partial<LoadingInput> = {}): string | undefined => loadingStage(input(over))?.text
const bind = (confirmed: boolean): NonNullable<SlotState['binding']> => ({ slotId: 's1', agent: 'claude', sessionId: 'abc', cwd: 'C:/w', since: '2026-10-30T00:00:00Z', ended: false, confirmed })

test('before the daemon answers every pane says it is connecting', () => {
  assert.equal(stageOf({ daemonReady: false, slot: undefined }), 'Conectando ao serviço…')
  assert.equal(loadingStage(input({ daemonReady: false }))?.id, 'connecting')
})

test('an agent with a session resumes it; without one it starts fresh', () => {
  const binding = bind(true)
  assert.equal(stageOf({ slot: slot({ binding }) }), 'Retomando sessão do Claude…')
  assert.equal(stageOf({ slot: slot({ kind: 'soul', binding: { ...binding, agent: 'soul' as const } }) }), 'Retomando sessão do soul…')
  assert.equal(stageOf({ slot: slot() }), 'Iniciando o Claude…')
  assert.equal(stageOf({ slot: slot({ status: 'exited', binding }), startPending: true }), 'Retomando sessão do Claude…')
})

test('a shell opens its terminal', () => {
  assert.equal(stageOf({ slot: slot({ kind: 'shell' }) }), 'Abrindo terminal…')
  assert.equal(stageOf({ slot: slot({ kind: 'shell', status: 'running' }) }), 'Abrindo terminal…')
})

test('queued shows its place when known', () => {
  assert.equal(stageOf({ slot: slot({ status: 'queued' }), queuePosition: 2 }), 'Na fila (Nº 2)')
  assert.equal(stageOf({ slot: slot({ status: 'queued' }) }), 'Na fila')
  assert.equal(stageOf({ slot: slot({ status: 'queued' }), ready: true }), 'Na fila')
})

test('nothing to show: ready, errors, unconfirmed, exited and unknown panes leave it to the terminal or the overlay', () => {
  assert.equal(stageOf({ slot: slot({ status: 'running' }), ready: true }), undefined)
  assert.equal(stageOf({ slot: slot({ status: 'error', error: { code: 'cwd-missing', message: 'x' } }) }), undefined)
  assert.equal(stageOf({ startError: true }), undefined)
  assert.equal(stageOf({ slot: slot({ status: 'exited', binding: bind(false) }), startPending: true }), undefined)
  assert.equal(stageOf({ slot: slot({ status: 'exited' }) }), undefined)
  assert.equal(stageOf({ slot: undefined }), undefined)
  assert.equal(stageOf({ slot: slot({ restarting: true }) }), undefined)
})

test('hint keeps only what the chrome paints', () => {
  const s = slot({ profileName: 'Max', unsafe: true, title: 't', pid: 4 })
  assert.deepEqual(hintOf(s), { kind: 'claude', cwd: 'C:/w', profileName: 'Max', unsafe: true })
  assert.deepEqual(hintOf(slot({ kind: 'shell' })), { kind: 'shell', cwd: 'C:/w' })
  assert.ok(sameHint(hintOf(s), hintOf(s)))
  assert.ok(!sameHint(undefined, hintOf(s)))
  assert.ok(!sameHint(hintOf(s), hintOf(slot())))
})

test('queue order follows the queued events', () => {
  const q = new QueueOrder()
  q.update('a', true); q.update('b', true); q.update('c', true)
  assert.deepEqual(['a', 'b', 'c'].map(id => q.position(id)), [1, 2, 3])
  q.update('a', false)
  assert.deepEqual(['a', 'b', 'c'].map(id => q.position(id)), [undefined, 1, 2])
  q.update('b', true) // repeated event: same place
  assert.equal(q.position('b'), 1)
  q.clear()
  assert.equal(q.position('c'), undefined)
})
