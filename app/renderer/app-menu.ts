// The ≡ app menu (F9 §4.3): built from the menu registry (app/shared/vscode-menu-registry.ts) fed by the core's items
// below and by extensions (TetherUi.menus). The core fixes the group order; separators fall between groups. The
// rendering keeps the markup the static index.html list had (roles, data-command, data-theme, aria-checked, classes,
// data-icon spans), so the hint painting, greying, keys and check syncing in main.ts work unchanged. Pure, no DOM.
import { MenuId, MenuRegistryImpl, type MenuEntry, type MenuItem } from '../shared/vscode-menu-registry.ts'
import type { MenuItemContribution } from '../../extensions/types.ts'

/**
 * The groups of the ≡ menu, in the order the core shows them; an extension's unknown group goes after, lexically.
 * Root rows: palette | open | (pane, note, desk, tools: submenus) | settings | exit.
 */
export const APP_MENU_GROUPS = ['palette', 'open', 'pane', 'note', 'desk', 'tools', 'settings', 'exit'] as const

/** The groups that open as a submenu: an extension's item lands in the submenu of its `group`. They share one separator-free section. */
export const APP_MENU_SUBMENUS: readonly { group: string; label: string; icon: string }[] = [
  { group: 'pane', label: 'Painel', icon: 'square-half' },
  { group: 'note', label: 'Nota', icon: 'note-pencil' },
  { group: 'desk', label: 'Mesa', icon: 'cards' },
  { group: 'tools', label: 'Ferramentas', icon: 'sliders-horizontal' },
]

type Item = MenuItem
/** Orders 10, 20, 30… in list order; an item with its own `order` keeps it (a gap left for an extension's item). */
const items = (group: string, list: (Omit<Item, 'group' | 'order'> & { order?: number })[]): Item[] => list.map((item, i) => ({ ...item, group, order: item.order ?? (i + 1) * 10 }))

/** The core's items. Extensions add theirs by group (explorer "Abrir pasta…" in open, the note extension's three in note,
 *  the shortcuts screen / web bridge in tools, "Configurações…" in settings). Appearance toggles live on the Settings page and in the palette. */
export const CORE_APP_MENU: readonly Item[] = [
  ...items('palette', [{ command: 'palette.show', icon: 'magnifying-glass', label: 'Paleta de comandos…' }]),
  // order 20: the explorer's "Abrir pasta…".
  ...items('open', [
    { command: 'pane.new', icon: 'plus', label: 'Novo painel…' },
    { command: 'drawer.toggle', icon: 'lightning', label: 'Abrir gaveta', order: 30 },
  ]),
  ...items('pane', [
    { command: 'pane.new-tab', icon: 'plus', label: 'Nova aba' },
    { command: 'pane.duplicate.pane.right', icon: 'copy', label: 'Duplicar painel à direita' },
    { command: 'pane.duplicate.pane.below', icon: 'copy', label: 'Duplicar painel abaixo' },
    { command: 'pane.new-at-frame-edge', icon: 'square-half', label: 'Novo painel na borda do quadro…' },
    { command: 'frame.new', icon: 'columns', label: 'Novo quadro…' },
    { command: 'pane.switch-profile', icon: 'arrow-clockwise', label: 'Trocar perfil do painel…' },
    { command: 'pane.asleep', icon: 'moon', label: 'Guias hibernadas…' },
  ]),
  // The 'note' group is the note extension's (extensions/note/manifest.ts: Nova nota, Abrir nota…, Salvar nota como…).
  ...items('desk', [
    { command: 'desk.new', icon: 'cards', label: 'Nova mesa' },
    { command: 'desk.builder', icon: 'square-split-horizontal', label: 'Montar a mesa (modo builder)' },
    { command: 'pane.move', icon: 'arrow-square-out', label: 'Mover…' },
    { command: 'desk.actions', icon: 'pencil-simple', label: 'Mesa atual: renomear, cor, mover…' },
    { command: 'desk.close', icon: 'x', label: 'Fechar mesa…' },
  ]),
  // order 20: keybindings-screen "Atalhos de teclado"; 30: "Extensões"; 40: web-bridge install; 45: the tether:// links.
  ...items('tools', [
    { command: 'profiles.manage', icon: 'sliders-horizontal', label: 'Perfis de lançamento…' },
    { command: 'sessions.search', icon: 'magnifying-glass', label: 'Buscar sessão…', order: 12 },
    { command: 'sessions.menu', icon: 'tray', label: 'Sessões…', order: 15 },
    { command: 'extensions.show', icon: 'puzzle-piece', label: 'Extensões', order: 30 },
    { command: 'daemon.restart', icon: 'plugs', label: 'Reiniciar o tetherd…', order: 35 },
    { command: 'theme.pick', icon: 'circle-half', label: 'Tema: claro, escuro ou automático…', order: 36 },
    { command: 'links.associate', icon: 'link', label: 'Associar links tether:// a este Tether…', order: 45 },
  ]),
  // The settings screen's "Configurações…" (group 'settings', order 10) comes after the core's "Tema do Tether…".
  ...items('settings', [{ command: 'terminal.theme', icon: 'palette', label: 'Tema do Tether…', order: 5 }]),
  ...items('exit', [
    { command: 'window.close', icon: 'app-window', label: 'Fechar a janela' },
    { command: 'app.quit-all', icon: 'power', danger: true, label: 'Sair e encerrar tudo…' },
  ]),
]

/** A registry holding the core's ≡ menu (order, groups); main.ts adds the extensions' items to it. */
export function coreMenuRegistry(): MenuRegistryImpl {
  const r = new MenuRegistryImpl()
  r.setGroupOrder(MenuId.App, APP_MENU_GROUPS)
  for (const g of APP_MENU_SUBMENUS) r.appendMenuGroup(MenuId.App, { id: g.group, section: 'submenus', submenu: { label: g.label, icon: g.icon } })
  for (const item of CORE_APP_MENU) r.appendMenuItem(MenuId.App, item)
  return r
}

/** An extension's ≡ item (manifest `contributes.menus.app`); `toggled` reads the setting its `toggled` names. */
export function menuItemOf(m: MenuItemContribution, toggled?: () => boolean): MenuItem {
  return {
    command: m.command, group: m.group,
    ...(m.order !== undefined ? { order: m.order } : {}), ...(m.label ? { label: m.label } : {}), ...(m.icon ? { icon: m.icon } : {}), ...(m.kind ? { kind: m.kind } : {}),
    ...(m.toggled && toggled ? { toggled } : {}),
  }
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * The menu's <li> rows. Icons are `<span class="i" data-icon="…">` placeholders (main.ts swaps them for the SVG, as for
 * the rest of index.html). `titleOf` gives the label of an item that declares none (the command's title).
 */
export function appMenuHtml(entries: readonly MenuEntry[], titleOf: (command: string) => string | undefined = () => undefined): string {
  const iconSpan = (name: string, extra = ''): string => `<span class="i${extra}" data-icon="${esc(name)}"></span>`
  const row = (i: MenuItem): string => {
    const role = i.kind === 'radio' ? 'menuitemradio' : i.kind === 'checkbox' ? 'menuitemcheckbox' : 'menuitem'
    const data = Object.entries(i.data ?? {}).map(([k, v]) => ` data-${esc(k)}="${esc(v)}"`).join('')
    const checked = i.kind === 'checkbox' ? ` aria-checked="${(i.toggled ? i.toggled() : i.checked) === true}"` : ''
    const cls = i.danger ? ' class="danger"' : ''
    const lead = i.kind ? iconSpan('check', ' check') : i.icon ? iconSpan(i.icon) : ''
    return `<li role="${role}"${data} data-command="${esc(i.command)}"${checked}${cls}>${lead}${esc(i.label ?? titleOf(i.command) ?? i.command)}</li>`
  }
  return entries.map(e => {
    if (e.type === 'separator') return '<li class="sep" role="separator"></li>'
    if (e.type === 'submenu') {
      return `<li class="sub" role="menuitem" aria-haspopup="menu" aria-expanded="false" data-submenu="${esc(e.group)}">${e.icon ? iconSpan(e.icon) : ''}${esc(e.label)}${iconSpan('caret-right', ' sub-arrow')}<ul class="submenu" role="menu" hidden>${e.items.map(row).join('')}</ul></li>`
    }
    if (e.type === 'heading') return `<li class="label">${e.icon ? iconSpan(e.icon) : ''}${esc(e.label)}</li>`
    return row(e.item)
  }).join('\n')
}
