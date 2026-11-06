// The explorer's pure rules (F8 slice 1a): the root row's texts, the root menu by state, the recent folders to offer; and its
// manifest (pad id and side, the Ctrl+K E chord that collides with nothing in the core table).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { manifest } from '../../extensions/explorer/manifest.ts'
import { agentsHint, agentsTooltip, pinLabel, recentRow, recentToOffer, rootMenu, rootTitle, type RootInfo } from '../../extensions/explorer/renderer/rules.ts'
import { parseKeys, resolvedDefaults } from '../../app/renderer/shortcuts.ts'

const root = (over: Partial<RootInfo> = {}): RootInfo => ({ path: 'C:\\proj\\alpha', name: 'alpha', pinned: false, agents: [], ...over })
const actions = (m: ReturnType<typeof rootMenu>): string[] => m.map(i => (i === 'sep' ? '-' : i.action))

describe('explorer root row', () => {
  test('the agents hint is singular, plural, or absent', () => {
    assert.equal(agentsHint(0), '')
    assert.equal(agentsHint(1), '1 agente')
    assert.equal(agentsHint(2), '2 agentes')
  })

  test('the tooltip lists one line per agent pane with where it lives', () => {
    assert.equal(agentsTooltip([{ agent: 'claude', place: 'Mesa 2' }, { agent: 'soul', place: 'Gaveta' }, {}]), 'Claude · Mesa 2\nsoul · Gaveta\nAgente')
  })

  test('the pin label says what the click does', () => {
    assert.equal(pinLabel(root()), 'Fixar projeto')
    assert.match(pinLabel(root({ pinned: true, agents: ['a'] })), /^Desafixar projeto/)
    assert.equal(pinLabel(root({ pinned: true })), 'Desafixar e fechar o projeto')
  })

  test('the row title is the path; an inferred root says what holds it', () => {
    assert.equal(rootTitle({ path: 'C:\\p', pinned: true }), 'C:\\p')
    assert.match(rootTitle({ path: 'C:\\p', pinned: false }), /^C:\\p\nInferido dos agentes/)
  })
})

describe('explorer root menu', () => {
  test('an inferred root: pin, the disabled note, no close', () => {
    const m = rootMenu(root({ agents: ['a'] }), 0, 1)
    assert.deepEqual(actions(m), ['pin', 'auto-close', '-', 'copy-path', 'reveal'])
    assert.equal((m[1] as { disabled?: boolean }).disabled, true)
  })

  test('a pinned root with agents unpins but cannot be closed; without agents it closes', () => {
    assert.deepEqual(actions(rootMenu(root({ pinned: true, agents: ['a'] }), 0, 1)), ['unpin', '-', 'copy-path', 'reveal'])
    assert.deepEqual(actions(rootMenu(root({ pinned: true }), 0, 1)), ['unpin', 'close', '-', 'copy-path', 'reveal'])
  })

  test('moving up needs a root above, moving down one below', () => {
    assert.deepEqual(actions(rootMenu(root({ pinned: true }), 0, 3)), ['unpin', 'close', '-', 'move-down', '-', 'copy-path', 'reveal'])
    assert.deepEqual(actions(rootMenu(root({ pinned: true }), 1, 3)), ['unpin', 'close', '-', 'move-up', 'move-down', '-', 'copy-path', 'reveal'])
    assert.deepEqual(actions(rootMenu(root({ pinned: true }), 2, 3)), ['unpin', 'close', '-', 'move-up', '-', 'copy-path', 'reveal'])
  })
})

describe('explorer empty state', () => {
  test('a recent folder shows its name and where it is', () => {
    assert.deepEqual(recentRow('C:\\work\\tether'), { name: 'tether', parent: 'C:\\work' })
    assert.deepEqual(recentRow('C:\\work\\tether\\'), { name: 'tether', parent: 'C:\\work' })
    assert.deepEqual(recentRow('/home/guga/tether'), { name: 'tether', parent: '/home/guga' })
    assert.deepEqual(recentRow('C:\\proj'), { name: 'proj', parent: 'C:\\' })
  })

  test('the recent folders offered skip the open ones (case-insensitively on Windows), newest first, a few', () => {
    const recent = ['C:\\a', 'C:\\B', 'C:\\c', 'C:\\d', 'C:\\e', 'C:\\f', 'C:\\g', 'C:\\h']
    assert.deepEqual(recentToOffer(recent, ['c:\\b/'], true), ['C:\\a', 'C:\\c', 'C:\\d', 'C:\\e', 'C:\\f', 'C:\\g'])
    assert.deepEqual(recentToOffer(['/a', '/A'], ['/a'], false), ['/A'])
  })
})

describe('explorer manifest', () => {
  const c = manifest.contributes!

  test('one global pad on the left, the id the layout will keep', () => {
    assert.deepEqual(c.pads, [{ id: 'explorer.files', title: 'Explorador', icon: 'files', defaultSide: 'left', scope: 'global', order: 10 }])
    assert.deepEqual([...manifest.hosts], ['renderer'])
    assert.equal(manifest.optional, true)
  })

  test('Ctrl+K E focuses the explorer and the core key table has no such chord', () => {
    assert.deepEqual(c.keybindings!.map(k => [k.key, k.command]), [['ctrl+k e', 'explorer.focus']])
    const chord = JSON.stringify(parseKeys('ctrl+k e'))
    assert.ok(chord !== undefined && resolvedDefaults(false).length > 20)
    assert.ok(!resolvedDefaults(false).some(b => JSON.stringify(b.keys) === chord), 'no core binding on Ctrl+K E')
    assert.ok(c.commands!.some(x => x.command === 'explorer.focus'))
  })
})
