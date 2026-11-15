// The explorer's pure rules (F8 slice 1a): the root row's texts, the root menu by state, the recent folders to offer; and its
// manifest (pad id and side, the Ctrl+K E chord that collides with nothing in the core table).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { manifest } from '../../extensions/explorer/manifest.ts'
import { ActivityGate, agentsHint, agentsTooltip, itemMenu, pinLabel, recentRow, recentToOffer, rootMenu, rootTitle, type RootInfo } from '../../extensions/explorer/renderer/rules.ts'
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
    assert.deepEqual(actions(m), ['pin', 'auto-close', '-', 'new-file', 'new-folder', 'new-pane', '-', 'copy-path', 'reveal'])
    assert.equal((m[1] as { disabled?: boolean }).disabled, true)
  })

  test('a pinned root with agents unpins but cannot be closed; without agents it closes', () => {
    assert.deepEqual(actions(rootMenu(root({ pinned: true, agents: ['a'] }), 0, 1)), ['unpin', '-', 'new-file', 'new-folder', 'new-pane', '-', 'copy-path', 'reveal'])
    assert.deepEqual(actions(rootMenu(root({ pinned: true }), 0, 1)), ['unpin', 'close', '-', 'new-file', 'new-folder', 'new-pane', '-', 'copy-path', 'reveal'])
  })

  test('moving up needs a root above, moving down one below', () => {
    assert.deepEqual(actions(rootMenu(root({ pinned: true }), 0, 3)), ['unpin', 'close', '-', 'new-file', 'new-folder', 'new-pane', '-', 'move-down', '-', 'copy-path', 'reveal'])
    assert.deepEqual(actions(rootMenu(root({ pinned: true }), 1, 3)), ['unpin', 'close', '-', 'new-file', 'new-folder', 'new-pane', '-', 'move-up', 'move-down', '-', 'copy-path', 'reveal'])
    assert.deepEqual(actions(rootMenu(root({ pinned: true }), 2, 3)), ['unpin', 'close', '-', 'new-file', 'new-folder', 'new-pane', '-', 'move-up', '-', 'copy-path', 'reveal'])
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
    assert.deepEqual(c.pads, [{ id: 'explorer.files', title: 'Explorador', icon: 'files', defaultSide: 'left', scope: 'global', absorbsHeader: true, order: 10 }])
    assert.deepEqual([...manifest.hosts], ['renderer', 'main'])
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

describe('ActivityGate (the disk is watched only while a view is shown)', () => {
  test('active while some view is shown and the window is not hidden; sends only changes', () => {
    const sent: boolean[] = []
    const g = new ActivityGate(a => sent.push(a))
    const v1 = {}, v2 = {}
    g.setView(v1, true)
    g.setView(v2, true)
    g.setView(v1, false)
    assert.deepEqual(sent, [true], 'one view still shown')
    g.setDocument(false)
    g.setView(v1, true)
    assert.deepEqual(sent, [true, false], 'a hidden window stays inactive')
    g.setDocument(true)
    g.setView(v1, false)
    g.setView(v2, false)
    assert.deepEqual(sent, [true, false, true, false])
    assert.equal(g.active, false)
  })

  test('a window hidden at start sends nothing until shown', () => {
    const sent: boolean[] = []
    const g = new ActivityGate(a => sent.push(a), false)
    g.setView({}, true)
    assert.deepEqual(sent, [])
  })
})

describe('explorer: Pesquisar na pasta…', () => {
  const acts = (m: ReturnType<typeof itemMenu>): string[] => m.map(i => (i === 'sep' ? '-' : i.action))
  const rootActs = (m: ReturnType<typeof rootMenu>): string[] => m.map(i => (i === 'sep' ? '-' : i.action))

  test('a project root offers it only while the search is active, after the create group', () => {
    assert.equal(rootActs(rootMenu(root({ pinned: true }), 0, 1)).includes('find-in-folder'), false)
    assert.equal(rootActs(rootMenu(root({ pinned: true }), 0, 1, { search: false })).includes('find-in-folder'), false)
    assert.deepEqual(rootActs(rootMenu(root({ pinned: true }), 0, 1, { search: true })),
      ['unpin', 'close', '-', 'new-file', 'new-folder', 'new-pane', '-', 'find-in-folder', '-', 'copy-path', 'reveal'])
  })

  test('a folder offers it, a file never does', () => {
    assert.equal(acts(itemMenu('dir')).includes('find-in-folder'), false)
    assert.deepEqual(acts(itemMenu('dir', { search: true })).slice(0, 6), ['new-file', 'new-folder', 'new-pane', '-', 'find-in-folder', '-'])
    assert.equal(acts(itemMenu('file', { search: true })).includes('find-in-folder'), false)
    const item = itemMenu('dir', { search: true }).find(i => i !== 'sep' && i.action === 'find-in-folder')
    assert.deepEqual(item, { action: 'find-in-folder', label: 'Pesquisar na pasta…', icon: 'magnifying-glass' })
  })
})
