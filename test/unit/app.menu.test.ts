// The ≡ menu built from the menu registry (app/renderer/app-menu.ts, app/shared/vscode-menu-registry.ts): the PO-approved
// structure (root rows + the Painel / Nota / Mesa / Ferramentas submenus) is pinned row for row in
// test/unit/fixtures/app-menu-static.html; plus the registry's ordering (core group order, then order, then registration),
// submenus by group, headings, separators, `when` and contributions from extensions.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appMenuHtml, APP_MENU_GROUPS, CORE_APP_MENU, coreMenuRegistry as coreOnly, menuItemOf } from '../../app/renderer/app-menu.ts'
import { manifest as noteManifest } from '../../extensions/note/manifest.ts'
import { manifest as keybindingsManifest } from '../../extensions/keybindings-screen/manifest.ts'
import { manifest as settingsManifest } from '../../extensions/settings-screen/manifest.ts'
import { manifest as webBridgeManifest } from '../../extensions/web-bridge/manifest.ts'
import { manifest as explorerManifest } from '../../extensions/explorer/manifest.ts'
import { flatItems, MenuId, MenuRegistryImpl, sortMenuItems, type MenuEntry } from '../../app/shared/vscode-menu-registry.ts'

// The registry as the app builds it: the core's items plus every extension that contributes to the ≡ menu (note word wrap on, the default).
const ALL_MANIFESTS = [noteManifest, keybindingsManifest, settingsManifest, webBridgeManifest, explorerManifest]
const EXTENSION_ITEMS = ALL_MANIFESTS.flatMap(x => x.contributes?.menus?.app ?? [])
function fullRegistry(): ReturnType<typeof coreOnly> {
  const r = coreOnly()
  for (const m of EXTENSION_ITEMS) r.appendMenuItem(MenuId.App, menuItemOf(m, () => true))
  return r
}
const coreMenuRegistry = fullRegistry

const fixture = (): string[] => readFileSync(join(import.meta.dirname, 'fixtures', 'app-menu-static.html'), 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
/** The built menu as text: root rows by label; a submenu as "Label ›" followed by its items indented. */
const outline = (entries: readonly MenuEntry[]): string[] => entries.flatMap(e =>
  e.type === 'separator' ? ['---'] : e.type === 'heading' ? [`# ${e.label}`] : e.type === 'submenu' ? [`${e.label} ›`, ...e.items.map(i => `  ${i.label}`)] : [e.item.label ?? e.item.command])

describe('the ≡ menu from the registry', () => {
  test('PO structure: root rows, separators and the four submenus, exactly', () => {
    assert.deepEqual(outline(fullRegistry().build(MenuId.App)), [
      'Paleta de comandos…',
      '---',
      'Novo painel…', 'Abrir pasta…', 'Abrir gaveta',
      '---',
      'Painel ›', '  Nova aba neste grupo', '  Duplicar painel à direita', '  Duplicar painel abaixo', '  Novo painel na borda do quadro…', '  Novo quadro…', '  Trocar perfil do painel…',
      'Nota ›', '  Nova nota', '  Abrir nota…', '  Salvar nota como…',
      'Mesa ›', '  Nova mesa', '  Mover…', '  Mesa atual: renomear, cor, mover…', '  Fechar mesa…',
      'Ferramentas ›', '  Perfis de lançamento…', '  Atalhos de teclado', '  Extensões', '  Instalar Tether Bridge…',
      '---',
      'Configurações…',
      '---',
      'Fechar a janela', 'Sair e encerrar tudo…',
    ])
  })

  test('no appearance toggles in the menu (they live on the Settings page and in the palette)', () => {
    const cmds = flatItems(fullRegistry().build(MenuId.App)).map(i => i.command)
    assert.ok(!(APP_MENU_GROUPS as readonly string[]).includes('look'))
    for (const gone of ['theme.light', 'theme.auto', 'theme.dark', 'ui.desk-line', 'ui.tab-border', 'ui.dim-unfocused', 'ui.dim-weak', 'ui.dim-medium', 'ui.dim-strong', 'ui.word-wrap', 'ui.minimap', 'ui.line-numbers', 'terminal.theme', 'confirmations.restore']) assert.ok(!cmds.includes(gone), gone)
    assert.ok(!fullRegistry().build(MenuId.App).some(e => e.type === 'heading'))
  })

  test('generates the fixture row for row (labels, icons, order, danger, separators, submenu markup)', () => {
    assert.deepEqual(appMenuHtml(fullRegistry().build(MenuId.App)).split('\n'), fixture())
  })

  test('every command of the previous flat menu is still reachable (root or submenu)', () => {
    const cmds = new Set(flatItems(fullRegistry().build(MenuId.App)).map(i => i.command))
    for (const c of ['palette.show', 'pane.new', 'explorer.open-folder', 'drawer.toggle', 'pane.new-tab', 'pane.duplicate.pane.right', 'pane.duplicate.pane.below', 'pane.new-at-frame-edge', 'frame.new', 'pane.switch-profile',
      'note.new', 'note.open', 'note.save-as', 'desk.new', 'pane.move', 'desk.actions', 'desk.close', 'profiles.manage', 'keybindings.show', 'extensions.show', 'web-bridge.install', 'settings.show', 'window.close', 'app.quit-all']) assert.ok(cmds.has(c), c)
    assert.equal(cmds.size, 24)
  })

  test('an extension item with a submenu group lands inside that submenu, by order', () => {
    const r = fullRegistry()
    r.appendMenuItem(MenuId.App, { command: 'x.note-extra', group: 'note', order: 5, label: 'Extra' })
    const note = r.build(MenuId.App).find(e => e.type === 'submenu' && e.group === 'note')
    assert.ok(note && note.type === 'submenu')
    assert.equal(note.items[0]!.command, 'x.note-extra')
  })

  test('every core item is in a core group, and the groups are the fixed order', () => {
    for (const i of [...CORE_APP_MENU, ...EXTENSION_ITEMS]) assert.ok((APP_MENU_GROUPS as readonly string[]).includes(i.group), i.command)
    const seen = new Set([...CORE_APP_MENU, ...EXTENSION_ITEMS].map(i => i.group))
    assert.deepEqual([...APP_MENU_GROUPS].filter(g => seen.has(g)), [...APP_MENU_GROUPS], 'every core group is filled (note, settings and tools partly by extensions)')
  })

  test('an extension item lands in its group by order; an unknown group goes after the core groups', () => {
    const r = coreMenuRegistry()
    const d1 = r.appendMenuItem(MenuId.App, { command: 'x.first-note', group: 'note', order: 5, label: 'Primeiro' })
    r.appendMenuItem(MenuId.App, { command: 'x.tail', group: 'zz-ext', label: 'Fim' })
    const commands = flatItems(r.build(MenuId.App)).map(i => i.command)
    assert.equal(commands[commands.indexOf('note.new') - 1], 'x.first-note')
    assert.equal(commands.at(-1), 'x.tail')
    const rows = r.build(MenuId.App)
    assert.deepEqual(rows.at(-2), { type: 'separator' }, 'a new group is separated')
    d1.dispose()
    assert.ok(!flatItems(r.build(MenuId.App)).some(i => i.command === 'x.first-note'), 'disposing removes the item')
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
