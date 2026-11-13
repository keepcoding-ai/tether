// The actions on one tab (extensions/browser/tab-actions.ts): the single definition the tab menu, the tab's × and each row of
// the pad read — what is offered by who has the tab, the brake and whether it is loaded; when closing asks; the question asked.
// Also the frame's layout rule that keeps the tab strip on screen (browser.css).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CLOSE_TAB, CLOSE_TAB_SITUATION, TAB_ACTION_ICON, agentUsing, closeNeedsConfirm, closeTabDialog, padRowActions, tabActions, type TabActionState,
} from '../../extensions/browser/tab-actions.ts'

const st = (over: Partial<TabActionState> = {}): TabActionState => ({ holder: 'agent', paused: false, loaded: true, agentAlive: true, ...over })
const ids = (s: TabActionState): string[] => tabActions(s, 'Sonda').map(a => a.id)

describe('browser tab actions: what each state offers', () => {
  test('the agent has it: take, pause, close (close asks)', () => {
    assert.deepEqual(ids(st()), ['take', 'pause', 'close'])
    const acts = tabActions(st(), 'Sonda')
    assert.deepEqual(acts.map(a => a.label), ['Assumir o controle', 'Pausar', `${CLOSE_TAB}…`])
  })

  test('the person has it: give back to the agent, pause, the clean reload, close (no question)', () => {
    const acts = tabActions(st({ holder: 'user' }), 'Sonda')
    assert.deepEqual(acts.map(a => a.id), ['give-back', 'pause', 'clean-reload', 'close'])
    assert.equal(acts[0]!.label, 'Devolver ao Sonda')
    assert.equal(acts.at(-1)!.label, CLOSE_TAB)
  })

  test('paused: resume instead of pause; close does not ask (the agent is not using it)', () => {
    assert.deepEqual(ids(st({ paused: true })), ['take', 'resume', 'close'])
    assert.equal(tabActions(st({ paused: true }), 'Sonda').find(a => a.id === 'resume')!.label, 'Retomar')
    assert.equal(closeNeedsConfirm(st({ paused: true })), false)
  })

  test('a tab not loaded yet: only the brake and close (nothing to take)', () => {
    assert.deepEqual(ids(st({ loaded: false })), ['pause', 'close'])
    assert.deepEqual(ids(st({ loaded: false, paused: true })), ['resume', 'close'])
    assert.equal(closeNeedsConfirm(st({ loaded: false })), false)
  })

  test('the agent ended: closing does not ask', () => {
    assert.equal(agentUsing(st({ agentAlive: false })), false)
    assert.equal(tabActions(st({ agentAlive: false }), 'Sonda').at(-1)!.label, CLOSE_TAB)
  })

  test('close is always last and the only danger', () => {
    for (const s of [st(), st({ holder: 'user' }), st({ paused: true }), st({ loaded: false })]) {
      const acts = tabActions(s, 'Sonda')
      assert.equal(acts.at(-1)!.id, 'close')
      assert.deepEqual(acts.filter(a => a.danger).map(a => a.id), ['close'])
    }
  })

  test('every action has one icon, the same everywhere, and the icon exists', () => {
    for (const s of [st(), st({ holder: 'user' }), st({ paused: true })]) for (const a of tabActions(s, 'Sonda')) assert.equal(a.icon, TAB_ACTION_ICON[a.id])
    // icons.ts imports SVG files (the bundler's job): its table is read as text.
    const table = readFileSync(join(import.meta.dirname, '..', '..', 'app', 'renderer', 'icons.ts'), 'utf8')
    for (const name of Object.values(TAB_ACTION_ICON)) assert.ok(table.includes(`'${name}':`) || new RegExp(`^\\s+${name},$`, 'm').test(table), name)
  })
})

describe('browser tab actions: the pad row', () => {
  test('the row offers the menu\'s actions, same names and icons, without the clean reload', () => {
    for (const s of [st(), st({ holder: 'user' }), st({ paused: true }), st({ loaded: false })]) {
      const menu = tabActions(s, 'Sonda')
      assert.deepEqual(padRowActions(s, 'Sonda'), menu.filter(a => a.id !== 'clean-reload'))
    }
    assert.deepEqual(padRowActions(st({ holder: 'user' }), 'Sonda').map(a => a.id), ['give-back', 'pause', 'close'])
  })
})

describe('browser tab actions: the question before closing', () => {
  const d = closeTabDialog('Sonda', 'Página A')
  test('the app\'s dialog: keeping it open is the default and Esc; closing is the destructive choice', () => {
    assert.equal(d.situation, CLOSE_TAB_SITUATION)
    assert.equal(d.defaultChoice, 'cancel')
    assert.equal(d.escChoice, 'cancel')
    assert.deepEqual(d.choices.map(c => [c.id, c.tone]), [['cancel', 'safe'], ['close', 'destructive']])
    assert.match(d.title, /Sonda/)
    assert.equal(d.context?.name, 'Página A')
    assert.equal(closeTabDialog('Sonda', '').context?.name, 'Guia')
  })
})

describe('browser frame: the tab strip stays on screen', () => {
  test('the web frame sits in the flow of the content container, never absolute over the group', () => {
    const css = readFileSync(join(import.meta.dirname, '..', '..', 'extensions', 'browser', 'browser.css'), 'utf8')
    const rule = css.match(/^\.br-web \{([^}]*)\}/m)?.[1] ?? ''
    assert.ok(rule, 'the .br-web rule exists')
    assert.doesNotMatch(rule, /position:\s*absolute/)
    assert.doesNotMatch(rule, /inset:/)
    assert.match(rule, /height:\s*100%/)
  })
})
