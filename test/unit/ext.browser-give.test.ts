// "Entregar a um agente…" (navegador da pessoa, N4): her own tab goes to an agent and becomes an agent's tab like any other.
// The pure rules (the control's `give`, the clean give, who may receive the tab), the hub's order (the state flips to the agent,
// then the page reloads, before the caller hands the tab over), her popups staying hers, and what the N3 fixed at birth for her
// own tab following the new owner: no background throttling, dialogs and keys left to the agent, the saved owner. The registry's
// own `give` (the owner, throttling, her local-network questions withdrawn, the gate's targetCreated so the agent sees it) is
// proven end to end in test/e2e/app.browser-person-give.test.ts: a tab cannot be created outside Electron.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { controlOf, INITIAL, OWN, reasonOf, reloadsOnGive, transition } from '../../extensions/browser/control-rules.ts'
import { ControlHub, type ControlView } from '../../extensions/browser/control.ts'
import { giveVerdict, PERSON_OWNER, savedOf, TABS_PER_OWNER } from '../../extensions/browser/tab-rules.ts'
import { pageKeyOf, servesPerson, throttlesInBackground } from '../../extensions/browser/page-rules.ts'
import { canGive, GIVE_TAB, giveItems, giveTabDialog, tabActions } from '../../extensions/browser/tab-actions.ts'

const AGENT = 'a1b2c3d4'

test('give (rule): her own tab becomes an agent tab with the agent, unpaused; nothing else is hers to give', () => {
  const given = transition(OWN, { type: 'give' })
  assert.deepEqual(given.state, INITIAL)
  assert.equal(controlOf(given.state), 'agent', 'own → agent')
  assert.equal(given.state.why, undefined)
  assert.equal(reasonOf(given.state), undefined, 'no reason: an agent tab like any other')
  assert.equal(given.settle, undefined)
  for (const t of [INITIAL, { holder: 'user' as const, paused: false, why: 'taken' as const }, { holder: 'agent' as const, paused: true }]) {
    assert.equal(transition(t, { type: 'give' }).state, t, `${JSON.stringify(t)}: unchanged`)
  }
  assert.equal(reloadsOnGive(OWN), true, 'the clean give always reloads her tab')
  assert.equal(reloadsOnGive(INITIAL), false)
})

test('give (rule): after the give the tab answers every gesture of an agent tab (pause, take back with "Assumir", a help request)', () => {
  const given = transition(OWN, { type: 'give' }).state
  assert.equal(controlOf(transition(given, { type: 'pause' }).state), 'paused')
  const taken = transition(given, { type: 'take' }).state
  assert.equal(controlOf(taken), 'user')
  assert.equal(taken.why, 'taken', '"Assumir" is the way back; the tab stays the agent\'s')
  assert.equal(transition(given, { type: 'ask', ask: { id: 'q', message: 'login', kind: 'login' } }).state.why, 'login')
})

function hub(order: string[]): { h: ControlHub; seen: ControlView[] } {
  const seen: ControlView[] = []
  const h = new ControlHub({
    ownerOf: () => PERSON_OWNER,
    cleanHandoff: async () => { order.push('clean-handoff') },
    beforeGiveBack: async () => { order.push('give-back-reload') },
    beforeGive: async id => { order.push(`reload:${id}:${h.control(id)}`) },
    log: () => {},
  })
  h.onChange(v => { seen.push(v); order.push(`state:${v.tabId}:${v.control}`) })
  return { h, seen }
}

test('give (hub): the state flips to the agent first (shield on), the page reloads next; a second give does nothing', async () => {
  const order: string[] = []
  const { h, seen } = hub(order)
  h.added('mine', undefined, PERSON_OWNER)
  order.length = 0
  assert.equal(await h.give('mine'), true)
  assert.deepEqual(order, ['state:mine:agent', 'reload:mine:agent'], 'the reload runs with the tab already out of her hands')
  assert.equal(h.view('mine').why, undefined)
  assert.equal(h.view('mine').holder, 'agent')
  assert.equal(seen.at(-1)!.control, 'agent')
  order.length = 0
  assert.equal(await h.give('mine'), false, 'no longer hers')
  assert.deepEqual(order, [], 'no second reload')
  assert.equal(await h.give('never-seen'), false, 'an unknown tab is no one\'s to give')
  // From now on it is an agent tab: pausing counts it, "Assumir" takes it, giving it back hands it to the agent.
  h.pauseMany(['mine'])
  assert.equal(h.control('mine'), 'paused')
  h.resume('mine')
  h.take('mine')
  assert.equal(h.control('mine'), 'user')
  await h.giveBack('mine')
  assert.equal(h.control('mine'), 'agent')
})

test('give (hub): her popups opened before the give stay hers', async () => {
  const { h } = hub([])
  h.added('mine', undefined, PERSON_OWNER)
  h.added('pop', 'mine', PERSON_OWNER)
  await h.give('mine')
  assert.equal(h.control('mine'), 'agent')
  assert.equal(h.view('pop').why, 'own', 'the popup is a tab of her own: it does not go along')
  assert.equal(h.control('pop'), 'user')
  // A popup the given tab opens later is the agent's (the registry gives it the tab's owner now): an ordinary agent tab.
  h.added('later', 'mine', AGENT)
  assert.equal(h.control('later'), 'agent')
})

test('give (verdict): only her tab, only to a live agent under its ceiling', () => {
  const hers = { ownerSlotId: PERSON_OWNER }
  const live = { alive: true }
  assert.equal(giveVerdict(hers, AGENT, live, 0), 'ok')
  assert.equal(giveVerdict(undefined, AGENT, live, 0), 'no-tab')
  assert.equal(giveVerdict({ ownerSlotId: AGENT }, 'b2c3d4e5', live, 0), 'not-hers', 'an agent tab is not given from here')
  assert.equal(giveVerdict(hers, AGENT, { alive: false }, 0), 'no-agent', 'an ended agent')
  assert.equal(giveVerdict(hers, AGENT, undefined, 0), 'no-agent', 'an unknown slot')
  assert.equal(giveVerdict(hers, PERSON_OWNER, live, 0), 'no-agent', 'never to the person')
  assert.equal(giveVerdict(hers, '../x', live, 0), 'no-agent')
  assert.equal(giveVerdict(hers, AGENT, live, TABS_PER_OWNER), 'full')
})

test('give: what the N3 fixed at birth follows the new owner (throttling off, the page left to the agent, the saved owner)', () => {
  assert.equal(throttlesInBackground(PERSON_OWNER), true, 'her tab slows down out of view')
  assert.equal(throttlesInBackground(AGENT), false, 'given to an agent: no throttling (the registry sets it again)')
  const given = controlOf(transition(OWN, { type: 'give' }).state)
  assert.equal(servesPerson(given), false, 'dialogs and the file chooser wait for the agent')
  assert.equal(pageKeyOf({ type: 'keyDown', key: 't', control: true }, given), undefined, 'Ctrl+T goes to the page')
  // layout.json keeps the agent as owner: a restart restores it as his tab.
  assert.equal(savedOf({ tabId: 't', ownerSlotId: AGENT, url: 'https://a.test/', title: 'A' }).ownerSlotId, AGENT)
})

test('give (interface): offered on her loaded tab only; the picker lists live agents; one question, cancel by default', () => {
  assert.equal(canGive({ holder: 'user', paused: false, loaded: true, agentAlive: true, own: true }), true)
  assert.equal(canGive({ holder: 'user', paused: false, loaded: false, agentAlive: true, own: true }), false, 'not loaded yet')
  assert.equal(canGive({ holder: 'agent', paused: false, loaded: true, agentAlive: true }), false, 'an agent tab')
  assert.deepEqual(tabActions({ holder: 'user', paused: false, loaded: true, agentAlive: true, own: true }, 'Você').map(a => a.id), ['close'], 'the shared actions are unchanged')
  assert.equal(GIVE_TAB, 'Entregar a um agente…')
  const rows = giveItems([
    { slotId: 'b', name: 'Beta', kind: 'claude', alive: true, deskTitle: 'obra' },
    { slotId: 'z', name: 'Zumbi', kind: 'soul', alive: false },
    { slotId: 'a', name: 'alfa', kind: 'soul', alive: true, placed: false },
  ], id => (id === 'a' ? 10 : 20), id => (id === 'b' ? 'emb' : undefined))
  assert.deepEqual(rows.map(r => [r.value, r.label, r.detail, r.engine, r.letter, r.hue, r.emblem]), [
    ['a', 'alfa', 'sem guia', 'soul', 'A', 10, undefined],
    ['b', 'Beta', 'na mesa obra', 'claude', 'B', 20, 'emb'],
  ], 'live only, by name, with engine, initial, hue and emblem')
  const d = giveTabDialog('Sonda', 'Página dela')
  assert.equal(d.title, 'Entregar esta guia a Sonda?')
  assert.equal(d.message, 'A página recarrega e as contas em que você entrou ficam com ele.')
  assert.equal(d.defaultChoice, 'cancel')
  assert.equal(d.escChoice, 'cancel')
  assert.deepEqual(d.choices.map(c => c.id), ['cancel', 'give'])
})
