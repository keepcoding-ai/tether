// Who has a tab (Tether Browser E7): the pure control machine (take, give back, ask, time out, dismiss, pause, popup), the clean
// hand-off trigger, the help request's limits, and the hub's settling of requests (returned, declined, timeout, dismissed by
// close, by the agent leaving, by the agent exiting), the person's note on a hand-back or a decline, and the hub's listeners.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ASK_MESSAGE_MAX, ASK_NOTE_MAX, ASK_TIMEOUT_DEFAULT_MS, ASK_TIMEOUT_MAX_MS, ASK_TIMEOUT_MIN_MS, ASKS_PER_AGENT, checkAsk, cleanAskMessage, cleanAskNote, controlOf,
  controlTexts, handoffKeepsScript, heldError, helpLine, INITIAL, needsCleanHandoff, reasonOf, reloadsOnGiveBack, type TabControl, transition,
} from '../../extensions/browser/control-rules.ts'
import { ControlHub, type ControlView } from '../../extensions/browser/control.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VENDOR = join(fileURLToPath(new URL('.', import.meta.url)), '../../extensions/browser/vendor/tether-browser')

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

test('control: "Não consigo ajudar" hands the tab back and settles the request declined; a note rides on either answer', () => {
  const asked = transition(INITIAL, ask('a1')).state
  const declined = transition(asked, { type: 'decline' })
  assert.deepEqual(declined.settle, { id: 'a1', outcome: 'declined' })
  assert.equal(controlOf(declined.state), 'agent')
  assert.equal(declined.state.ask, undefined)
  assert.deepEqual(transition(asked, { type: 'decline', note: '  sem acesso\u0000 a essa conta ' }).settle, { id: 'a1', outcome: 'declined', note: 'sem acesso a essa conta' })
  assert.deepEqual(transition(asked, { type: 'giveBack', note: 'feito, usei a conta de teste' }).settle, { id: 'a1', outcome: 'returned', note: 'feito, usei a conta de teste' })
  assert.deepEqual(transition(asked, { type: 'giveBack', note: '   ' }).settle, { id: 'a1', outcome: 'returned' }, 'a blank note is no note')
  assert.deepEqual(transition(asked, { type: 'giveBack', note: 42 }).settle, { id: 'a1', outcome: 'returned' }, 'only text is a note')
  // Without an open request a decline is a plain hand-back: nothing to settle.
  const taken = transition(INITIAL, { type: 'take' }).state
  const plain = transition(taken, { type: 'decline', note: 'x' })
  assert.equal(controlOf(plain.state), 'agent')
  assert.equal(plain.settle, undefined)
})

test('askUser note: plain text, cleaned as the message, cut at its ceiling', () => {
  assert.equal(cleanAskNote('<b>entrei</b>, mas\tpediu   2FA'), '<b>entrei</b>, mas pediu 2FA')
  assert.equal(cleanAskNote('x'.repeat(900)).length, ASK_NOTE_MAX)
  assert.equal(ASK_NOTE_MAX, 500)
  assert.equal(cleanAskNote(undefined), '')
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

test('control: the clean hand-off keeps a script with no code (the client\'s own world) and removes every script with code', () => {
  // The vendored playwright-core registers its utility world exactly so, once per page session, and never again: removed by a
  // hand-off, every later document lacks the world and the page's title (read in it, with no deadline) waits forever.
  const core = readFileSync(join(VENDOR, 'node_modules/playwright-core/lib/coreBundle.js'), 'utf8')
  assert.match(core, /"Page\.addScriptToEvaluateOnNewDocument", \{\s*source: "",\s*worldName: this\._crPage\.utilityWorldName/, 'the shape the rule protects')
  assert.match(core, /const context = await this\.utilityContext\(\);\s*return await context\.evaluate\(\(\) => document\.title\);/, 'title() reads in that world')
  assert.equal(handoffKeepsScript({ source: '', worldName: '__playwright_utility_world_page@1' }), true)
  assert.equal(handoffKeepsScript({ source: '  \n\t', worldName: 'w' }), true, 'whitespace runs nothing')
  assert.equal(handoffKeepsScript({ source: '' }), true)
  assert.equal(handoffKeepsScript({ source: 'document.addEventListener("keydown", e => steal(e.key))' }), false)
  assert.equal(handoffKeepsScript({ source: ' x', worldName: 'w' }), false, 'code in an isolated world still runs in her turn')
  assert.equal(handoffKeepsScript({}), false, 'no source: removed (fails closed)')
  assert.equal(handoffKeepsScript({ source: 42 }), false)
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
  assert.equal(t.ignored, 'O Claude está usando esta página, por isso o seu clique não chegou.')
  assert.equal(t.userAsked, 'Com você · pedido do Claude')
  assert.equal(t.userExpired, 'Com você · Claude desistiu de esperar')
})

test('askUser limits: plain text, ceiling, one per tab, a few per agent, timeout clamped', () => {
  assert.equal(cleanAskMessage('  a\u0000b‮ c\t\td  '), 'a b c d')
  assert.equal(cleanAskMessage('<b>x</b>'), '<b>x</b>', 'markup stays text')
  assert.equal(cleanAskMessage('x'.repeat(900)).length, ASK_MESSAGE_MAX)
  assert.equal(cleanAskMessage(42), '')
  const none = { tab: false, agent: 0 }
  assert.equal(typeof checkAsk({ message: '   ' }, none), 'string')
  assert.match(checkAsk({ message: 'x' }, { tab: true, agent: 1 }) as string, /already/)
  assert.match(checkAsk({ message: 'x' }, { tab: true, agent: 1, own: false }) as string, /already/, "another asker's request is refused")
  assert.equal(typeof checkAsk({ message: 'x' }, { tab: true, agent: 1, own: true }), 'object', "the asker's own open request is replaced")
  assert.equal(typeof checkAsk({ message: 'x' }, { tab: true, agent: ASKS_PER_AGENT, own: true }), 'object', 'the replaced request frees its place in the limit')
  assert.match(checkAsk({ message: 'x' }, { tab: false, agent: ASKS_PER_AGENT, own: true }) as string, /at most/)
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
  assert.deepEqual(h.openAsks('t1', 'agent-a'), { tab: true, agent: 1, own: true })
  assert.deepEqual(h.openAsks('t1', 'agent-b'), { tab: true, agent: 0, own: false })
  await h.giveBack('t1', 'feito')
  assert.deepEqual(await req.answer, { outcome: 'returned', note: 'feito' })
  assert.deepEqual(reloaded, ['t1'], 'a login hand-back reloads')
  assert.equal(h.control('t1'), 'agent')
  assert.deepEqual(h.openAsks('t1', 'agent-a'), { tab: false, agent: 0 })
})

test('control hub: timeout, dismissed by close, by the agent giving up, by the agent exiting', async () => {
  const { h, cleaned, reloaded } = hub()
  const other = h.ask('t0', 'agent-a', { message: 'entre na sua conta', kind: 'other', timeoutMs: 60_000 })
  assert.deepEqual(cleaned, ['t0'], "kind 'other': the clean hand-off runs")
  await h.giveBack('t0')
  assert.deepEqual(await other.answer, { outcome: 'returned' })
  assert.deepEqual(reloaded, ['t0'], "kind 'other': the hand-back reloads")
  const short = h.ask('t1', 'agent-a', { message: 'x', kind: 'other', timeoutMs: 20 })
  assert.deepEqual(await short.answer, { outcome: 'timeout' })
  assert.equal(h.view('t1').askExpired, true)
  assert.equal(h.control('t1'), 'user')
  const closed = h.ask('t2', 'agent-a', { message: 'x', kind: 'other', timeoutMs: 60_000 })
  h.closed('t2')
  assert.deepEqual(await closed.answer, { outcome: 'dismissed' })
  const gaveUp = h.ask('t3', 'agent-a', { message: 'x', kind: 'other', timeoutMs: 60_000 })
  gaveUp.cancel()
  assert.deepEqual(await gaveUp.answer, { outcome: 'dismissed' })
  const exited = h.ask('t4', 'agent-a', { message: 'x', kind: 'other', timeoutMs: 60_000 })
  h.agentExited('agent-a')
  assert.deepEqual(await exited.answer, { outcome: 'dismissed' })
  assert.equal(h.control('t4'), 'user', 'the tab stays with the person')
})

test('control hub: decline reloads like a hand-back, gives the tab back and settles declined with the note', async () => {
  const { h, seen, reloaded } = hub()
  const req = h.ask('t1', 'agent-a', { message: 'login', kind: 'login', timeoutMs: 60_000 })
  assert.equal(typeof seen.at(-1)?.ask?.id, 'string', 'the view carries the request id (the card collapses per request)')
  await h.decline('t1', 'não tenho acesso a essa conta')
  assert.deepEqual(await req.answer, { outcome: 'declined', note: 'não tenho acesso a essa conta' })
  assert.deepEqual(reloaded, ['t1'])
  assert.equal(h.control('t1'), 'agent')
  await h.decline('t1')
  assert.deepEqual(reloaded, ['t1'], 'a tab the agent already has: nothing happens')
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

test('control hub: a new ask of the same owner replaces the open one (dismissed); another owner is refused by the check', async () => {
  const { h, seen, cleaned, reloaded } = hub()
  const first = h.ask('t1', 'agent-a', { message: 'primeiro', kind: 'other', timeoutMs: 60_000 })
  assert.equal(typeof checkAsk({ message: 'segundo' }, h.openAsks('t1', 'agent-a')), 'object', 'the same owner may replace')
  assert.match(checkAsk({ message: 'segundo' }, h.openAsks('t1', 'agent-b')) as string, /already/, 'another owner is refused')
  const second = h.ask('t1', 'agent-a', { message: 'segundo', kind: 'other', timeoutMs: 60_000 })
  assert.deepEqual(await first.answer, { outcome: 'dismissed' }, 'the orphan ends, its promise never hangs')
  assert.equal(h.view('t1').ask?.message, 'segundo')
  assert.equal(seen.at(-1)?.ask?.message, 'segundo')
  assert.deepEqual(h.openAsks('t1', 'agent-a'), { tab: true, agent: 1, own: true })
  assert.deepEqual(cleaned, ['t1'], 'no second clean hand-off: the tab was already with the person')
  first.cancel() // the orphan's late cancel must not touch the new request
  assert.equal(h.view('t1').ask?.message, 'segundo')
  await h.giveBack('t1', 'feito')
  assert.deepEqual(await second.answer, { outcome: 'returned', note: 'feito' })
  assert.deepEqual(reloaded, ['t1'], 'the hand-back still reloads')
})
