// The bar of a browser tab (extensions/browser/bar-rules.ts): per state, the owner pill (tone, phrase and its short form for a narrow pane), the "Sua vez" card,
// the notices as a list and the bar's pins over the tab menu's actions; and the facts behind the address's ⓘ.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { tabFacts, tabView, type TabViewInput } from '../../extensions/browser/bar-rules.ts'
import { POPUPS_REFUSED } from '../../extensions/browser/rules.ts'

const ask = { id: 'a1', message: 'Faça login no Sandbox nesta guia.' }
const at = (over: Partial<TabViewInput> = {}): TabViewInput => ({
  loaded: true, agent: { name: 'Sonda', alive: true }, ignored: false, popupsRefused: 0, acting: false, ...over,
})
/** The bar's pinned actions as [label, pin] (close and the unpinned stay in the menu). */
const pinned = (i: TabViewInput): [string, string][] => tabView(i).actions.filter(a => a.pin).map(a => [a.label, a.pin!])

describe('browser bar: the owner pill and the pins per state', () => {
  test('the agent is using it: "‹Agente› usando" in its colour, live while it acts; "Assumir" highlighted, "Pausar" an icon', () => {
    const v = tabView(at())
    assert.deepEqual(v.owner, { tone: 'agent', text: 'Sonda usando', short: 'Sonda', live: false })
    assert.equal(tabView(at({ acting: true })).owner.live, true)
    assert.deepEqual(pinned(at()), [['Assumir', 'highlight'], ['Pausar', 'icon']])
    assert.equal(v.nav, false)
    assert.equal(v.ask, undefined)
    assert.deepEqual(v.notices, [])
  })

  test('a click on the shield: the notice says why it did not land and offers "Assumir"', () => {
    const v = tabView(at({ ignored: true }))
    assert.deepEqual(v.notices, [{ kind: 'ignored', text: 'O Sonda está usando esta página, por isso o seu clique não chegou.', action: { id: 'take', label: 'Assumir' } }])
    assert.deepEqual(tabView(at({ ignored: true, control: { holder: 'user', paused: false, why: 'taken' } })).notices.map(n => n.kind), ['scripts'], 'only while the agent uses it')
  })

  test('a help request: the pill asks, the card opens, "Pronto, devolver" highlighted and "Não consigo ajudar" with text', () => {
    const v = tabView(at({ control: { holder: 'user', paused: false, why: 'login', ask } }))
    assert.deepEqual(v.owner, { tone: 'ask', text: 'Com você · pedido do Sonda', short: 'Com você', live: false, toggle: { mark: '▴', word: '', title: 'Recolher o pedido' } })
    assert.deepEqual(pinned(at({ control: { holder: 'user', paused: false, why: 'login', ask } })), [['Pronto, devolver', 'highlight'], ['Não consigo ajudar', 'primary']])
    assert.equal(v.nav, true)
    assert.equal(v.ask?.id, 'a1')
    assert.equal(v.ask?.message, ask.message)
    assert.equal(v.ask?.title, 'O Sonda precisa de você')
    assert.equal(v.ask?.tag, 'SUA VEZ')
    assert.equal(v.ask?.hint, 'Faça isto aqui mesmo, nesta guia. Enquanto ela está com você, o agente não vê nem mexe em nada.')
    assert.equal(v.ask?.write, 'Escrever ao Sonda')
    assert.equal(v.ask?.say, 'Mensagem ao Sonda')
    assert.deepEqual([v.ask?.decline, v.ask?.done], ['Não consigo ajudar', 'Pronto, devolver'])
    assert.equal(v.ask?.collapsed, false)
  })

  test('the card collapses per request (the pill brings it back); a new request opens expanded', () => {
    const control = { holder: 'user' as const, paused: false, why: 'asked' as const, ask }
    const slim = tabView(at({ control, collapsedAsk: 'a1' }))
    assert.equal(slim.ask!.collapsed, true)
    assert.deepEqual(slim.owner.toggle, { mark: '▾', word: 'ver pedido', title: 'Ver o pedido' })
    assert.equal(slim.ask!.collapse, 'recolher')
    assert.equal(tabView(at({ control: { ...control, ask: { ...ask, id: 'a2' } }, collapsedAsk: 'a1' })).ask!.collapsed, false)
    assert.equal(tabView(at({ control: { holder: 'user', paused: false, why: 'taken' } })).owner.toggle, undefined, 'no request: the pill goes to the agent')
  })

  test('the person took it: "Com você", the scripts notice, "Devolver ao ‹agente›" highlighted and "Recarregar limpo" with text', () => {
    const i = at({ control: { holder: 'user', paused: false, why: 'taken' } })
    const v = tabView(i)
    assert.deepEqual(v.owner, { tone: 'you', text: 'Com você', short: 'Com você', live: false })
    assert.deepEqual(pinned(i), [['Devolver ao Sonda', 'highlight'], ['Recarregar limpo', 'primary']])
    assert.deepEqual(v.notices, [{ kind: 'scripts', text: 'O Sonda pode ter deixado scripts nesta página. Antes de digitar uma senha, use Recarregar limpo.' }])
  })

  test('the request ran out: the pill tells it, "Devolver mesmo assim" highlighted, no card', () => {
    const i = at({ control: { holder: 'user', paused: false, why: 'asked', askExpired: true } })
    const v = tabView(i)
    assert.deepEqual(v.owner, { tone: 'you', text: 'Com você · Sonda desistiu de esperar', short: 'Com você', live: false })
    assert.deepEqual(pinned(i), [['Devolver mesmo assim', 'highlight']])
    assert.equal(v.ask, undefined)
  })

  test('paused: "Pausada" and "Retomar" highlighted, also on a tab not loaded yet', () => {
    const i = at({ control: { holder: 'agent', paused: true } })
    assert.deepEqual(tabView(i).owner, { tone: 'paused', text: 'Pausada', short: 'Pausada', live: false })
    assert.deepEqual(pinned(i), [['Retomar', 'highlight']])
    assert.deepEqual(pinned({ ...i, loaded: false }), [['Retomar', 'highlight']])
  })

  test('the agent ended: "‹Agente› encerrado" and nothing pinned; held by the person, the pill says it too', () => {
    const i = at({ agent: { name: 'Sonda', alive: false } })
    assert.deepEqual(tabView(i).owner, { tone: 'ended', text: 'Sonda encerrado', short: 'Encerrado', live: false })
    assert.deepEqual(pinned(i), [])
    assert.equal(tabView({ ...i, control: { holder: 'user', paused: false, why: 'taken' } }).owner.text, 'Com você · Sonda encerrado')
  })

  test('a tab not loaded yet: the name alone, nothing to take', () => {
    const i = at({ loaded: false })
    assert.deepEqual(tabView(i).owner, { tone: 'agent', text: 'Sonda', short: 'Sonda', live: false })
    assert.deepEqual(pinned(i), [['Pausar', 'icon']])
  })

  test('close is never pinned on the bar, but stays in its menu; at most one highlight', () => {
    for (const i of [at(), at({ control: { holder: 'user', paused: false, why: 'login', ask } }), at({ control: { holder: 'agent', paused: true } })]) {
      const acts = tabView(i).actions
      assert.equal(acts.at(-1)!.id, 'close')
      assert.equal(acts.at(-1)!.pin, undefined)
      assert.ok(acts.filter(a => a.pin === 'highlight').length <= 1)
    }
  })

  test('notices stack: the scripts warning and the refused popups together', () => {
    const v = tabView(at({ control: { holder: 'user', paused: false, why: 'taken' }, popupsRefused: 2 }))
    assert.deepEqual(v.notices.map(n => n.kind), ['scripts', 'popups'])
    assert.equal(v.notices[1]!.text, POPUPS_REFUSED)
    assert.equal(v.notices[1]!.action, undefined)
  })
})

describe('browser bar: the facts behind the ⓘ', () => {
  test('cookies, logins in memory, debug, an address not kept, in that order; none: nothing to flag', () => {
    assert.deepEqual(tabFacts({ cookies: 0, persistentLogins: true, debug: false, addressLost: false }), [])
    assert.deepEqual(tabFacts({ cookies: 3, persistentLogins: false, debug: true, addressLost: true }), ['cookies', 'memory', 'debug', 'address'])
    assert.deepEqual(tabFacts({ cookies: 1, persistentLogins: true, debug: false, addressLost: false }), ['cookies'])
  })
})
