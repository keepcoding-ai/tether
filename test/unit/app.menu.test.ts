// The ≡ menu built from the menu registry (app/renderer/app-menu.ts, app/shared/vscode-menu-registry.ts): the core's
// generated markup is the static list index.html had before F9 0b (test/unit/fixtures/app-menu-static.html), plus the one
// item 0b adds ("Extensões"); the registry's ordering (core group order, then order, then registration), headings,
// separators, `when` and contributions from extensions.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appMenuHtml, APP_MENU_GROUPS, CORE_APP_MENU, coreMenuRegistry as coreOnly, menuItemOf } from '../../app/renderer/app-menu.ts'
import { manifest as noteManifest } from '../../extensions/note/manifest.ts'
import { manifest as keybindingsManifest } from '../../extensions/keybindings-screen/manifest.ts'
import { MenuId, MenuRegistryImpl, sortMenuItems } from '../../app/shared/vscode-menu-registry.ts'

// The registry as the app builds it: the core's items plus the note extension's (its word wrap on, the default) and the shortcuts screen's.
const NOTE_MENU = [noteManifest, keybindingsManifest].flatMap(m => m.contributes?.menus?.app ?? []).map(m => menuItemOf(m, () => true))
function coreMenuRegistry(): ReturnType<typeof coreOnly> {
  const r = coreOnly()
  for (const item of NOTE_MENU) r.appendMenuItem(MenuId.App, item)
  return r
}

const fixture = (): string[] => readFileSync(join(import.meta.dirname, 'fixtures', 'app-menu-static.html'), 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
const EXTENSIONS_ROW = '<li role="menuitem" data-command="extensions.show"><span class="i" data-icon="puzzle-piece"></span>Extensões</li>'

describe('the ≡ menu from the registry', () => {
  test('generates the static menu it replaced, row for row (labels, icons, order, radios, checks, danger, separators, heading)', () => {
    const generated = appMenuHtml(coreMenuRegistry().build(MenuId.App)).split('\n')
    const expected = fixture()
    // 0b's only addition: "Extensões" right after "Atalhos de teclado".
    const at = expected.findIndex(l => l.includes('data-command="keybindings.show"'))
    assert.ok(at > 0, 'the fixture has the shortcuts row')
    expected.splice(at + 1, 0, EXTENSIONS_ROW)
    assert.deepEqual(generated, expected)
  })

  test('without the addition, the fixture is exactly the core minus "Extensões"', () => {
    const r = coreMenuRegistry()
    const html = appMenuHtml(r.build(MenuId.App)).split('\n').filter(l => l !== EXTENSIONS_ROW)
    assert.deepEqual(html, fixture())
  })

  test('every core item is in a core group, and the groups are the fixed order', () => {
    for (const i of [...CORE_APP_MENU, ...NOTE_MENU]) assert.ok((APP_MENU_GROUPS as readonly string[]).includes(i.group), i.command)
    const seen = new Set([...CORE_APP_MENU, ...NOTE_MENU].map(i => i.group))
    assert.deepEqual([...APP_MENU_GROUPS].filter(g => seen.has(g)), [...APP_MENU_GROUPS], 'every core group is filled (the note group by the note extension)')
  })

  test('an extension item lands in its group by order; an unknown group goes after the core groups', () => {
    const r = coreMenuRegistry()
    const d1 = r.appendMenuItem(MenuId.App, { command: 'x.first-note', group: 'note', order: 5, label: 'Primeiro' })
    r.appendMenuItem(MenuId.App, { command: 'x.tail', group: 'zz-ext', label: 'Fim' })
    const commands = r.build(MenuId.App).flatMap(e => e.type === 'item' ? [e.item.command] : [])
    assert.equal(commands[commands.indexOf('note.new') - 1], 'x.first-note')
    assert.equal(commands.at(-1), 'x.tail')
    const rows = r.build(MenuId.App)
    assert.deepEqual(rows.at(-2), { type: 'separator' }, 'a new group is separated')
    d1.dispose()
    assert.ok(!r.build(MenuId.App).some(e => e.type === 'item' && e.item.command === 'x.first-note'), 'disposing removes the item')
  })

  test('`when` filters with a context; without one every item is built (the renderer hides at open time)', () => {
    const r = new MenuRegistryImpl<{ on: boolean }>()
    r.appendMenuItem(MenuId.App, { command: 'a', group: 'g' })
    r.appendMenuItem(MenuId.App, { command: 'b', group: 'g', when: c => c.on })
    const names = (ctx?: { on: boolean }): string[] => r.build(MenuId.App, ctx).flatMap(e => e.type === 'item' ? [e.item.command] : [])
    assert.deepEqual(names(), ['a', 'b'])
    assert.deepEqual(names({ on: false }), ['a'])
    assert.deepEqual(names({ on: true }), ['a', 'b'])
  })

  test('sort: core group order, then order, then registration (VS Code compareMenuItems with a fixed group order)', () => {
    const items = [{ group: 'b', order: 2, n: 1 }, { group: 'zz', n: 2 }, { group: 'a', order: 1, n: 3 }, { group: 'b', order: 1, n: 4 }, { group: 'b', order: 1, n: 5 }, { group: 'yy', n: 6 }]
    assert.deepEqual(sortMenuItems(items, ['b', 'a']).map(i => i.n), [4, 5, 1, 3, 6, 2])
  })

  test('a label falls back to the command title; text is escaped', () => {
    const r = new MenuRegistryImpl()
    r.appendMenuItem(MenuId.App, { command: 'c', group: 'g', icon: 'x' })
    r.appendMenuItem(MenuId.App, { command: 'd', group: 'g', label: '<b>&' })
    assert.deepEqual(appMenuHtml(r.build(MenuId.App), id => id === 'c' ? 'Título' : undefined).split('\n'), [
      '<li role="menuitem" data-command="c"><span class="i" data-icon="x"></span>Título</li>',
      '<li role="menuitem" data-command="d">&lt;b&gt;&amp;</li>',
    ])
  })
})
