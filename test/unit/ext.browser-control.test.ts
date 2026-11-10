// Who has a tab (Tether Browser E7): the pure control machine (take, give back, ask, time out, dismiss, pause, popup), the clean
// hand-off trigger, the help request's limits, and the hub's settling of requests (returned, timeout, dismissed by close, by the
// agent leaving, by the agent exiting) with its listeners.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ASK_MESSAGE_MAX, ASK_TIMEOUT_DEFAULT_MS, ASK_TIMEOUT_MAX_MS, ASK_TIMEOUT_MIN_MS, ASKS_PER_AGENT, checkAsk, cleanAskMessage, controlOf,
  controlTexts, heldError, helpLine, INITIAL, needsCleanHandoff, reasonOf, reloadsOnGiveBack, type TabControl, transition,
} from '../../extensions/browser/control-rules.ts'
import { ControlHub, type ControlView } from '../../extensions/browser/control.ts'

const ask = (id: string, kind: 'login' | 'other' = 'other') => ({ type: 'ask' as const, ask: { id, message: 'faça login', kind } })

test('control: a tab starts with the agent; take, give back', () => {
  assert.equal(controlOf(INITIAL), 'agent')
  const taken = transition(INITIAL, { type: 'take' }).state
  assert.equal(controlOf(taken), 'user')
  assert.equal(taken.why, 'taken')
  assert.equal(transition(taken, { type: 'take' }).state, taken, 'taking twice changes nothing')
  const back = transition(taken, { type: 'giveBack' })
  assert.equal(controlOf(back.state), 'agent')
  assert.equal(back.settle, undefined, 'no request to settle')
})

test('control: pausing does not take the tab from the person; giving back a paused tab leaves it paused', () => {
  const paused = transition(INITIAL, { type: 'pause' }).state
  assert.equal(controlOf(paused), 'paused')
  const held = transition(paused, { type: 'take' }).state
  assert.equal(controlOf(held), 'user')
  assert.equal(controlOf(transition(held, { type: 'giveBack' }).state), 'paused')
  assert.equal(controlOf(transition(paused, { type: 'resume' }).state), 'agent')
  assert.equal(transition(INITIAL, { type: 'resume' }).state, INITIAL)
  assert.equal(controlOf(transition(transition(INITIAL, { type: 'take' }).state, { type: 'pause' }).state), 'user')
})

test('control: a help request puts the tab with the person at once; giving back settles it returned', () => {
  const asked = transition(INITIAL, ask('a1'))
  assert.equal(controlOf(asked.state), 'user')
  assert.equal(asked.state.why, 'asked')
  assert.equal(asked.state.ask?.id, 'a1')
  const back = transition(asked.state, { type: 'giveBack' })
  assert.deepEqual(back.settle, { id: 'a1', outcome: 'returned' })
  assert.equal(back.state.ask, undefined)
  assert.equal(controlOf(back.state), 'agent')
})

test('control: time out keeps the tab with the person and marks it expired; dismiss keeps it too', () => {
  const asked = transition(INITIAL, ask('a1')).state
  const out = transition(asked, { type: 'askTimeout', id: 'a1' })
  assert.deepEqual(out.settle, { id: 'a1', outcome: 'timeout' })
  assert.equal(controlOf(out.state), 'user')
  assert.equal(out.state.askExpired, true)
  assert.equal(out.state.ask, undefined)
  assert.equal(transition(out.state, { type: 'giveBack' }).state.askExpired, undefined, 'giving back clears the mark')
  const gone = transition(asked, { type: 'askDismissed', id: 'a1' })
  assert.deepEqual(gone.settle, { id: 'a1', outcome: 'dismissed' })
  assert.equal(controlOf(gone.state), 'user')
  // A stale id (an earlier request) changes nothing.
  assert.equal(transition(asked, { type: 'askTimeout', id: 'old' }).state, asked)
  assert.equal(transition(asked, { type: 'askDismissed', id: 'old' }).settle, undefined)
})

test('control: a new request on the same tab dismisses the earlier one', () => {
  const first = transition(INITIAL, ask('a1')).state
  const second = transition(first, ask('a2', 'login'))
  assert.deepEqual(second.settle, { id: 'a1', outcome: 'dismissed' })
  assert.equal(second.state.ask?.id, 'a2')
  assert.equal(second.state.why, 'login')
})

test('control: the clean hand-off runs from the agent to the person for EVERY help request, whatever its kind (H1)', () => {
  assert.equal(needsCleanHandoff(INITIAL, transition(INITIAL, ask('a', 'login')).state), true)
  assert.equal(needsCleanHandoff(INITIAL, transition(INITIAL, ask('a')).state), true, "kind 'other' is the agent's word: cleaned too")
  assert.equal(needsCleanHandoff(INITIAL, transition(INITIAL, { type: 'take' }).state), false)
  const held = transition(INITIAL, { type: 'take' }).state
  assert.equal(needsCleanHandoff(held, transition(held, ask('a', 'login')).state), false, 'already with the person')
})

test('control: every help request hand-back reloads; a manual take does not (H1, M1)', () => {
  assert.equal(reloadsOnGiveBack(transition(INITIAL, ask('a', 'login')).state), true)
  assert.equal(reloadsOnGiveBack(transition(INITIAL, ask('a')).state), true)
  const expired = transition(transition(INITIAL, ask('a')).state, { type: 'askTimeout', id: 'a' }).state
  assert.equal(reloadsOnGiveBack(expired), true, 'a request that ran out still reloads when handed back')
  assert.equal(reloadsOnGiveBack(transition(INITIAL, { type: 'take' }).state), false)
  assert.equal(reloadsOnGiveBack(INITIAL), false)
})

test('control: a popup of a tab the person holds is hers from birth', () => {
  const held: TabControl = transition(INITIAL, { type: 'take' }).state
  const pop = transition(INITIAL, { type: 'popupOf', opener: held }).state
  assert.equal(controlOf(pop), 'user')
  assert.equal(pop.why, 'popup')
  assert.equal(transition(INITIAL, { type: 'popupOf', opener: INITIAL }).state, INITIAL)
})

test('control: reasons and named errors', () => {
  assert.equal(reasonOf(INITIAL), undefined)
  assert.match(reasonOf(transition(INITIAL, { type: 'take' }).state)!, /took control/)
  assert.match(reasonOf(transition(INITIAL, { type: 'pause' }).state)!, /paused/)
  assert.match(heldError('user').message, /^TAB_WITH_USER/)
  assert.match(heldError('paused').message, /^TAB_PAUSED/)
  const t = controlTexts('Claude')
  assert.equal(t.agent, 'Claude usando')
  assert.equal(t.giveBack, 'Devolver ao Claude')
  assert.equal(t.ignored, 'O Claude está usando esta página. Assumir o controle?')
  assert.equal(t.ask('fazer login'), 'Claude pede sua ajuda: fazer login')
  assert.equal(t.expired, 'O Claude desistiu de esperar. Devolver mesmo assim?')
})

test('askUser limits: plain text, ceiling, one per tab, a few per agent, timeout clamped', () => {
  assert.equal(cleanAskMessage('  a\u0000b‮ c\t\td  '), 'a b c d')
  assert.equal(cleanAskMessage('<b>x</b>'), '<b>x</b>', 'markup stays text')
  assert.equal(cleanAskMessage('x'.repeat(900)).length, ASK_MESSAGE_MAX)
  assert.equal(cleanAskMessage(42), '')
  const none = { tab: false, agent: 0 }
  assert.equal(typeof checkAsk({ message: '   ' }, none), 'string')
  assert.match(checkAsk({ message: 'x' }, { tab: true, agent: 1 }) as string, /already/)
  assert.match(checkAsk({ message: 'x' }, { tab: false, agent: ASKS_PER_AGENT }) as string, /at most/)
  assert.deepEqual(checkAsk({ message: 'entrar', kind: 'login', timeoutMs: 5000 }, none), { message: 'entrar', kind: 'login', timeoutMs: 5000 })
  assert.equal((checkAsk({ message: 'x', kind: 'weird' }, none) as { kind: string }).kind, 'other')
  assert.equal((checkAsk({ message: 'x' }, none) as { timeoutMs: number }).timeoutMs, ASK_TIMEOUT_DEFAULT_MS)
  assert.equal((checkAsk({ message: 'x', timeoutMs: 1 }, none) as { timeoutMs: number }).timeoutMs, ASK_TIMEOUT_MIN_MS)
  assert.equal((checkAsk({ message: 'x', timeoutMs: 1e12 }, none) as { timeoutMs: number }).timeoutMs, ASK_TIMEOUT_MAX_MS)
})

function hub(): { h: ControlHub; seen: ControlView[]; cleaned: string[]; reloaded: string[] } {
  const cleaned: string[] = []
  const reloaded: string[] = []
  const h = new ControlHub({
    ownerOf: () => 'agent-a',
    cleanHandoff: async id => { cleaned.push(id) },
    beforeGiveBack: async id => { reloaded.push(id) },
    log: () => {},
  })
  const seen: ControlView[] = []
  h.onChange(v => seen.push(v))
  return { h, seen, cleaned, reloaded }
}

test('control hub: ask → returned on give back, with the login clean hand-off and the hand-back check', async () => {
  const { h, seen, cleaned, reloaded } = hub()
  const req = h.ask('t1', 'agent-a', { message: 'login', kind: 'login', timeoutMs: 60_000 })
  assert.equal(h.control('t1'), 'user')
  assert.deepEqual(cleaned, ['t1'])
  assert.equal(seen.at(-1)?.ask?.message, 'login')
  assert.deepEqual(h.openAsks('t1', 'agent-a'), { tab: true, agent: 1 })
  await h.giveBack('t1')
  assert.equal(await req.outcome, 'returned')
  assert.deepEqual(reloaded, ['t1'], 'a login hand-back reloads')
  assert.equal(h.control('t1'), 'agent')
  assert.deepEqual(h.openAsks('t1', 'agent-a'), { tab: false, agent: 0 })
})

test('control hub: timeout, dismissed by close, by the agent giving up, by the agent exiting', async () => {
  const { h, cleaned, reloaded } = hub()
  const other = h.ask('t0', 'agent-a', { message: 'entre na sua conta', kind: 'other', timeoutMs: 60_000 })
  assert.deepEqual(cleaned, ['t0'], "kind 'other': the clean hand-off runs")
  await h.giveBack('t0')
  assert.equal(await other.outcome, 'returned')
  assert.deepEqual(reloaded, ['t0'], "kind 'other': the hand-back reloads")
  const short = h.ask('t1', 'agent-a', { message: 'x', kind: 'other', timeoutMs: 20 })
  assert.equal(await short.outcome, 'timeout')
  assert.equal(h.view('t1').askExpired, true)
  assert.equal(h.control('t1'), 'user')
  const closed = h.ask('t2', 'agent-a', { message: 'x', kind: 'other', timeoutMs: 60_000 })
  h.closed('t2')
  assert.equal(await closed.outcome, 'dismissed')
  const gaveUp = h.ask('t3', 'agent-a', { message: 'x', kind: 'other', timeoutMs: 60_000 })
  gaveUp.cancel()
  assert.equal(await gaveUp.outcome, 'dismissed')
  const exited = h.ask('t4', 'agent-a', { message: 'x', kind: 'other', timeoutMs: 60_000 })
  h.agentExited('agent-a')
  assert.equal(await exited.outcome, 'dismissed')
  assert.equal(h.control('t4'), 'user', 'the tab stays with the person')
})

test('control hub: pause many, resume many, popup inherits, listeners hear only changes', () => {
  const { h, seen } = hub()
  h.pauseMany(['a', 'b'])
  assert.equal(h.control('a'), 'paused')
  assert.equal(h.control('b'), 'paused')
  const n = seen.length
  h.pause('a')
  assert.equal(seen.length, n, 'no change, no event')
  h.resumeMany(['a', 'b'])
  assert.equal(h.control('a'), 'agent')
  h.take('a')
  h.added('pop', 'a')
  assert.equal(h.control('pop'), 'user')
  h.added('other', undefined)
  assert.equal(h.control('other'), 'agent')
})

test('helpLine: the line of a pending request where the person looks (seals, badges, tray)', () => {
  assert.equal(helpLine('Sonda', 'github.com', { message: 'fazer login' }), 'Sonda pede ajuda em github.com: fazer login')
  assert.equal(helpLine('Sonda', '', { message: 'fazer login' }), 'Sonda pede ajuda: fazer login')
  assert.equal(helpLine('Sonda', 'github.com', undefined), 'Sonda espera você devolver a página')
})
