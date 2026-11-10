// The pad "Guias" rules (extensions/browser/pad-rules.ts, design §5.3, §12a): the tabs with the person on top, the groups by agent,
// the counts, the sentence for the agent's last action, and the number on the icon.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTION_FRESH_MS, actionKindOf, buildPad, endedTabIds, isEnded, lastActionText, logoutDialog, oldestAsking, padBadge, padCloseEnded, resolveAgent, shortAddress, type PadAgentInfo, type PadTab,
} from '../../extensions/browser/pad-rules.ts'

const tab = (tabId: string, ownerSlotId: string, over: Partial<PadTab> = {}): PadTab =>
  ({ tabId, ownerSlotId, title: tabId, url: `https://${tabId}.test/`, control: 'agent', asking: false, expired: false, ...over })
const agents: Record<string, PadAgentInfo> = { a: { name: 'Sonda', alive: true }, b: { name: 'Beta', alive: true }, c: { name: 'Gama', alive: false } }
const agentOf = (slot: string): PadAgentInfo | undefined => agents[slot]

describe('browser pad: the model', () => {
  const tabs = [tab('a1', 'a'), tab('b1', 'b'), tab('a2', 'a', { control: 'user' }), tab('c1', 'c'), tab('b2', 'b', { control: 'paused' }), tab('a3', 'a', { asking: true, control: 'user' })]
  const m = buildPad(tabs, agentOf)

  test('the tabs with the person are on top, in screen order; the rest stay with their agent', () => {
    assert.deepEqual(m.withPerson.map(t => t.tabId), ['a2', 'a3'])
    assert.deepEqual(m.groups.map(g => [g.slotId, g.tabs.map(t => t.tabId)]), [['a', ['a1']], ['b', ['b1', 'b2']], ['c', ['c1']]])
  })

  test('agents come in the order of their first tab; a group counts the tabs on top too', () => {
    assert.deepEqual(m.groups.map(g => g.slotId), ['a', 'b', 'c'])
    assert.deepEqual(m.groups.map(g => g.total), [3, 2, 1])
    assert.deepEqual(m.groups.map(g => g.paused), [0, 1, 0])
  })

  test('counts: all, paused, asking, the ended agents\' and the icon (with the person or asking)', () => {
    assert.equal(m.total, 6)
    assert.equal(m.paused, 1)
    assert.equal(m.asking, 1)
    assert.equal(m.endedTabs, 1)
    assert.equal(m.attention, 2)
    assert.deepEqual(m.groups.map(g => g.ended), [false, false, true])
  })

  test('an agent whose pane is gone counts as ended; the filter keeps one agent', () => {
    const lone = buildPad([tab('x1', 'ghost')], agentOf)
    assert.equal(lone.groups[0]!.ended, true)
    assert.equal(lone.groups[0]!.name, 'Agente')
    const only = buildPad(tabs, agentOf, 'b')
    assert.deepEqual(only.groups.map(g => g.slotId), ['b'])
    assert.equal(only.total, 2)
    assert.equal(only.attention, 0)
  })

  test('the ended agents\' tabs, for the clean-up', () => {
    assert.deepEqual(endedTabIds(tabs, agentOf), ['c1'])
    assert.equal(padCloseEnded(3), 'Fechar guias de agentes encerrados (3)')
  })

  test('the icon: nothing with nobody holding a tab; a plain count for a take; the flag when an agent asks', () => {
    assert.equal(padBadge(buildPad([tab('a1', 'a')], agentOf)), undefined)
    assert.deepEqual(padBadge(buildPad([tab('a1', 'a', { control: 'user' })], agentOf)), { count: 1, attention: false, tooltip: '1 guia está com você' })
    assert.deepEqual(padBadge(m), { count: 2, attention: true, tooltip: '1 guia pede sua ajuda' })
  })
})

describe('browser pad: the last action in words', () => {
  const now = 1_000_000
  const base = { control: 'agent', asking: false, expired: false, ended: false, name: 'Sonda', url: 'https://github.com/login', now } as const
  test('the kind of an action comes from the command, not its content', () => {
    assert.equal(actionKindOf('Input.insertText'), 'typing')
    assert.equal(actionKindOf('Input.dispatchKeyEvent'), 'typing')
    assert.equal(actionKindOf('Input.dispatchMouseEvent', 'mousePressed'), 'clicking')
    assert.equal(actionKindOf('Input.dispatchMouseEvent', 'mouseWheel'), 'scrolling')
    assert.equal(actionKindOf('Page.navigate'), 'navigating')
    assert.equal(actionKindOf('Accessibility.getFullAXTree'), 'reading')
    assert.equal(actionKindOf('Runtime.evaluate'), 'acting')
  })
  test('a fresh action: the verb and the tab\'s host', () => {
    assert.equal(lastActionText({ ...base, action: { kind: 'typing', at: now - 1000 } }), 'digitando em github.com')
    assert.equal(lastActionText({ ...base, action: { kind: 'acting', at: now } }), 'agindo em github.com')
    assert.equal(lastActionText({ ...base, url: '', action: { kind: 'clicking', at: now } }), 'clicando')
  })
  test('an old or no action says so; the person\'s states win', () => {
    assert.equal(lastActionText({ ...base, action: { kind: 'typing', at: now - ACTION_FRESH_MS - 1 } }), 'sem ação agora')
    assert.equal(lastActionText(base), 'sem ação agora')
    assert.equal(lastActionText({ ...base, asking: true, control: 'user' }), 'esperando você')
    assert.equal(lastActionText({ ...base, expired: true, control: 'user' }), 'Sonda desistiu de esperar')
    assert.equal(lastActionText({ ...base, control: 'user', action: { kind: 'typing', at: now } }), 'com você')
    assert.equal(lastActionText({ ...base, control: 'paused', action: { kind: 'typing', at: now } }), 'pausada')
    assert.equal(lastActionText({ ...base, ended: true }), 'Sonda encerrado')
  })
  test('the short address: no scheme, no query, cut', () => {
    assert.equal(shortAddress('https://github.com/login?x=1'), 'github.com/login')
    assert.equal(shortAddress('https://github.com/'), 'github.com')
    assert.equal(shortAddress(`https://a.test/${'x'.repeat(100)}`).length, 48)
    assert.equal(shortAddress('about:blank'), 'about:blank')
  })
})

describe('browser pad: the agent\'s real life (E12)', () => {
  const slot = (alive: boolean) => ({ slotId: 'a', name: 'Slot A', alive })

  test('closed pane with a live slot: the agent is not ended, and its tabs are not for "Fechar guias de agentes encerrados"', () => {
    const info = resolveAgent(undefined, slot(true), true)
    assert.deepEqual(info, { name: 'Slot A', alive: true })
    assert.equal(isEnded(info), false)
    assert.deepEqual(endedTabIds([tab('a1', 'a')], () => info), [])
  })

  test('open pane with an exited slot is ended; main\'s word on life wins over the pane\'s', () => {
    assert.equal(isEnded(resolveAgent({ name: 'Sonda', alive: true }, slot(false), true)), true)
    assert.equal(isEnded(resolveAgent({ name: 'Sonda', alive: false }, slot(true), true)), false)
  })

  test('no slot at all: ended, even with no pane (the slot is gone)', () => {
    const info = resolveAgent(undefined, undefined, true)
    assert.equal(isEnded(info), true)
    assert.equal(info?.name, 'Agente')
    assert.deepEqual(endedTabIds([tab('a1', 'a')], () => info), ['a1'])
  })

  test('the pane\'s name wins; before main answered the pane\'s word stands and nothing is ended by guess', () => {
    assert.equal(resolveAgent({ name: 'Sonda', alive: true }, slot(true), true)?.name, 'Sonda')
    assert.deepEqual(resolveAgent({ name: 'Sonda', alive: true }, undefined, false), { name: 'Sonda', alive: true })
    assert.equal(resolveAgent(undefined, undefined, false), undefined)
  })
})

describe('browser pad: where a pending request leads (E12)', () => {
  test('the oldest request; none when nothing pends', () => {
    assert.equal(oldestAsking([]), undefined)
    assert.equal(oldestAsking([{ tabId: 'b', at: 30 }, { tabId: 'a', at: 10 }, { tabId: 'c', at: 20 }]), 'a')
  })
})

describe('browser pad: logout of every account (E14)', () => {
  test('the dialog carries the confirmation of the design and defaults to cancelling', () => {
    const d = logoutDialog()
    assert.equal(d.message, 'Todos os agentes perdem o acesso às contas logadas.')
    assert.equal(d.title, 'Sair de todas as contas')
    assert.equal(d.defaultChoice, 'cancel')
    assert.equal(d.choices.find(c => c.id === 'logout')?.tone, 'destructive')
  })
})
