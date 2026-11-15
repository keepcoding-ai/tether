// The pad "Guias" rules (extensions/browser/pad-rules.ts, design §5.3, §12a): the tabs with the person on top, the groups by agent,
// the counts, the sentence for the agent's last action, and the number on the icon.
import { pillMark } from '../../app/renderer/seal-rules.ts'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTION_FRESH_MS, actionKindOf, buildPad, isEnded, lastActionText, logoutDialog, oldestAsking, padBadge, pillBadgeCount, padSections, padMenu, padGroupMenu, rowStateText, PAD_ACTIVE, PAD_ENDED, PAD_CLOSE_ALL_ENDED, padOnlyAgent, type PadModel, type PadGroup, resolveAgent, shortAddress, type PadAgentInfo, type PadTab,
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
    assert.deepEqual(padSections(buildPad(tabs, agentOf)).endedIds, ['c1'])
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
    assert.deepEqual(padSections(buildPad([tab('a1', 'a')], () => info)).endedIds, [])
  })

  test('open pane with an exited slot is ended; main\'s word on life wins over the pane\'s', () => {
    assert.equal(isEnded(resolveAgent({ name: 'Sonda', alive: true }, slot(false), true)), true)
    assert.equal(isEnded(resolveAgent({ name: 'Sonda', alive: false }, slot(true), true)), false)
  })

  test('no slot at all: ended, even with no pane (the slot is gone)', () => {
    const info = resolveAgent(undefined, undefined, true)
    assert.equal(isEnded(info), true)
    assert.equal(info?.name, 'Agente')
    assert.deepEqual(padSections(buildPad([tab('a1', 'a')], () => info)).endedIds, ['a1'])
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

// V2b: one help request showed 2 on the Browser pill and 1 on the Mesa pill and the pad icon. The core adds the desk's pane seals
// and the extension's badge (pillMark); the request's tab pane is sealed in the Browser desk, so the badge must not count it again.
describe('browser: the Browser pill counts requests, not seals', () => {
  const one = [{ paneInBrowserDesk: true }]
  test('a request whose tab pane is in the Browser desk adds nothing to the badge; the pill says 1', () => {
    assert.equal(pillBadgeCount(one), 0)
    const mark = pillMark({ done: 0, waiting: 1 }, { count: pillBadgeCount(one), attention: true, tooltip: 't' })
    assert.equal(mark?.text, '1')
    assert.equal(mark?.tone, 'waiting')
  })
  test('with several requests the pill counts each once; one whose pane left the desk is counted by the badge, not twice', () => {
    const three = [{ paneInBrowserDesk: true }, { paneInBrowserDesk: true }, { paneInBrowserDesk: false }]
    assert.equal(pillBadgeCount(three), 1)
    // The desk seals two panes; the third request sits on another desk, so only the badge counts it here.
    assert.equal(pillMark({ done: 0, waiting: 2 }, { count: pillBadgeCount(three), attention: true })?.text, '3')
    assert.equal(pillBadgeCount([]), 0)
  })
  test('nothing in the desk but a request pending: the pill stays lit as a pip', () => {
    const mark = pillMark({ done: 0, waiting: 0 }, { count: pillBadgeCount([]), attention: true, tooltip: 't' })
    assert.deepEqual(mark, { text: '', tone: 'waiting', lines: ['t'] })
  })
})

describe('browser pad: sections, menus and row state', () => {
  const tabs = [tab('a1', 'a'), tab('a2', 'a', { control: 'user' }), tab('b1', 'b', { control: 'user' }), tab('b2', 'b', { asking: true }),
    tab('c1', 'c'), tab('c2', 'c', { control: 'paused' }), tab('a3', 'a', { control: 'paused' })]
  const m = buildPad(tabs, agentOf)

  test('brakeable counts unpaused tabs of alive agents only', () => {
    assert.equal(m.paused, 2)
    assert.equal(m.brakeable, 4) // a1, a2, b1, b2
  })

  test('sections: a group wholly with the person is in neither list; ended rows feed "Fechar todas"', () => {
    const s = padSections(m)
    assert.deepEqual(s.withPerson.map(t => t.tabId), ['a2', 'b1', 'b2'])
    assert.deepEqual(s.active.map(g => g.slotId), ['a'])
    assert.deepEqual(s.ended.map(g => g.slotId), ['c'])
    assert.deepEqual(s.endedIds, ['c1', 'c2'])
    assert.equal(PAD_ACTIVE, 'Com os agentes'); assert.equal(PAD_ENDED, 'De agentes encerrados')
    assert.equal(PAD_CLOSE_ALL_ENDED, 'Fechar todas'); assert.equal(padOnlyAgent('Sonda'), 'Só as guias do Sonda')
  })

  const model = (over: Partial<PadModel>): PadModel => ({ ...m, ...over })
  const pins = (x: PadModel, f = false) => Object.fromEntries(padMenu(x, f).filter(i => i !== 'sep').map(i => [(i as { id: string }).id, i])) as Record<string, { pin?: string; disabled?: boolean }>
  test('panel menu pins in the four brakeable/paused cases', () => {
    let p = pins(model({ brakeable: 3, paused: 0 }))
    assert.equal(p['pause-all']!.pin, 'primary'); assert.equal(p['resume-all']!.disabled, true); assert.equal(p['resume-all']!.pin, undefined)
    p = pins(model({ brakeable: 2, paused: 1 }))
    assert.equal(p['pause-all']!.pin, 'icon'); assert.equal(p['resume-all']!.pin, 'highlight')
    p = pins(model({ brakeable: 0, paused: 2 }))
    assert.equal(p['pause-all']!.disabled, true); assert.equal(p['pause-all']!.pin, undefined); assert.equal(p['resume-all']!.pin, 'highlight')
    p = pins(model({ brakeable: 0, paused: 0 }))
    assert.equal(p['pause-all']!.disabled, true); assert.equal(p['resume-all']!.disabled, true)
  })

  test('panel menu: order, labels, filter entry, one highlight, logout last and dangerous', () => {
    const list = padMenu(model({ brakeable: 1, paused: 1 }), true)
    assert.deepEqual(list.map(i => i === 'sep' ? 'sep' : i.id), ['show-all', 'sep', 'pause-all', 'resume-all', 'sep', 'logout-all'])
    const items = list.filter(i => i !== 'sep')
    assert.equal(items.filter(i => i.pin === 'highlight').length, 1)
    assert.equal(items[0]!.pin, 'primary')
    assert.deepEqual(items.map(i => i.label), ['Mostrar todas', 'Pausar todas as guias', 'Retomar todas', 'Sair de todas as contas…'])
    assert.equal(items.at(-1)!.danger, true)
    assert.equal((padMenu(m, false)[0] as { id: string }).id, 'pause-all')
  })

  const grp = (over: Partial<PadGroup>): PadGroup => ({ slotId: 'a', name: 'Sonda', ended: false, tabs: [], total: 2, paused: 0, ...over })
  const gids = (g: PadGroup) => padGroupMenu(g).map(i => i === 'sep' ? 'sep' : i.id)
  test('agent menu: brake follows the group; an ended agent has none', () => {
    assert.deepEqual(gids(grp({})), ['pause-agent', 'see-agent', 'sep', 'close-agent'])
    assert.deepEqual(gids(grp({ paused: 1 })), ['pause-agent', 'see-agent', 'sep', 'close-agent'])
    assert.deepEqual(gids(grp({ paused: 2 })), ['resume-agent', 'see-agent', 'sep', 'close-agent'])
    const brake = padGroupMenu(grp({})).find(i => i !== 'sep' && i.id === 'pause-agent')
    assert.equal((brake as { pin: string }).pin, 'icon')
    const ended = padGroupMenu(grp({ ended: true, paused: 2 }))
    assert.deepEqual(ended.map(i => i === 'sep' ? 'sep' : i.id), ['close-agent', 'see-agent'])
    assert.deepEqual([(ended[0] as { pin: string }).pin, (ended[0] as { danger: boolean }).danger], ['icon', true])
  })

  test('row state: one sentence per section', () => {
    const base = { control: 'agent', asking: false, expired: false, ended: false, name: 'Sonda', url: 'https://x.test/', now: 1 } as const
    assert.equal(rowStateText('ended', { ...base, ended: true }), '')
    assert.equal(rowStateText('user', { ...base, asking: true }), 'Sonda espera você')
    assert.equal(rowStateText('user', { ...base, expired: true }), 'Sonda desistiu de esperar')
    assert.equal(rowStateText('user', { ...base, control: 'user' }), 'com você, do Sonda')
    assert.equal(rowStateText('active', { ...base, control: 'paused' }), 'pausada')
  })
})
