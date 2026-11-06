// The ≡ app menu (F9 §4.3): built from the menu registry (app/shared/vscode-menu-registry.ts) fed by the core's items
// below and by extensions (TetherUi.menus). The core fixes the group order; separators fall between groups. The
// rendering keeps the markup the static index.html list had (roles, data-command, data-theme, aria-checked, classes,
// data-icon spans), so the hint painting, greying, keys and check syncing in main.ts work unchanged. Pure, no DOM.
import { MenuId, MenuRegistryImpl, type MenuEntry, type MenuItem } from '../shared/vscode-menu-registry.ts'
import type { MenuItemContribution } from '../../extensions/types.ts'

/** The groups of the ≡ menu, in the order the core shows them; an extension's unknown group goes after, lexically. */
export const APP_MENU_GROUPS = ['palette', 'pane', 'note', 'desk', 'drawer', 'profiles', 'look', 'app', 'exit'] as const

type Item = MenuItem
/** Orders 10, 20, 30… in list order; an item with its own `order` keeps it (a gap left for an extension's item). */
const items = (group: string, list: (Omit<Item, 'group' | 'order'> & { order?: number })[]): Item[] => list.map((item, i) => ({ ...item, group, order: item.order ?? (i + 1) * 10 }))

/** The core's items: the same list, labels, icons and initial checks the static menu had, minus what extensions contribute. */
export const CORE_APP_MENU: readonly Item[] = [
  ...items('palette', [{ command: 'palette.show', icon: 'magnifying-glass', label: 'Paleta de comandos…' }]),
  ...items('pane', [
    { command: 'pane.new', icon: 'plus', label: 'Novo painel…' },
    { command: 'pane.new-tab', icon: 'plus', label: 'Nova aba neste grupo' },
    { command: 'pane.duplicate.pane.right', icon: 'copy', label: 'Duplicar painel à direita' },
    { command: 'pane.duplicate.pane.below', icon: 'copy', label: 'Duplicar painel abaixo' },
    { command: 'pane.new-at-frame-edge', icon: 'square-half', label: 'Novo painel na borda do quadro…' },
    { command: 'frame.new', icon: 'columns', label: 'Novo quadro…' },
  ]),
  // The 'note' group is the note extension's (extensions/note/manifest.ts: Nova nota, Abrir nota…, Salvar nota como…).
  ...items('desk', [
    { command: 'desk.new', icon: 'cards', label: 'Nova mesa' },
    { command: 'pane.move', icon: 'arrow-square-out', label: 'Mover…' },
    { command: 'desk.actions', icon: 'pencil-simple', label: 'Mesa atual: renomear, cor, mover…' },
    { command: 'desk.close', icon: 'x', label: 'Fechar mesa…' },
  ]),
  ...items('drawer', [{ command: 'drawer.toggle', icon: 'lightning', label: 'Abrir gaveta' }]),
  ...items('profiles', [
    { command: 'profiles.manage', icon: 'sliders-horizontal', label: 'Perfis de lançamento…' },
    { command: 'pane.switch-profile', icon: 'arrow-clockwise', label: 'Trocar perfil do painel…' },
  ]),
  ...items('look', [
    { command: 'theme.light', kind: 'radio', data: { theme: 'light' }, label: 'Claro' },
    { command: 'theme.auto', kind: 'radio', data: { theme: 'auto' }, label: 'Automático' },
    { command: 'theme.dark', kind: 'radio', data: { theme: 'dark' }, label: 'Escuro' },
    { command: 'ui.desk-line', kind: 'checkbox', checked: true, label: 'Linha da cor da mesa' },
    { command: 'ui.tab-border', kind: 'checkbox', checked: false, label: 'Borda na guia do painel com foco' },
    { command: 'ui.dim-unfocused', kind: 'checkbox', checked: false, label: 'Esmaecer quadros sem foco' },
    // order 70: the note extension's "Quebra de linha no editor".
    { command: 'terminal.theme', icon: 'palette', label: 'Tema do terminal…', order: 80 },
  ]),
  ...items('app', [
    { command: 'keybindings.show', icon: 'keyboard', label: 'Atalhos de teclado' },
    { command: 'extensions.show', icon: 'puzzle-piece', label: 'Extensões' },
    { command: 'confirmations.restore', icon: 'arrow-clockwise', label: 'Voltar a perguntar antes de fechar painéis' },
  ]),
  ...items('exit', [
    { command: 'window.close', icon: 'app-window', label: 'Fechar a janela' },
    { command: 'app.quit-all', icon: 'power', danger: true, label: 'Sair e encerrar tudo…' },
  ]),
]

/** A registry holding the core's ≡ menu (order, groups, the "Tema" heading); main.ts adds the extensions' items to it. */
export function coreMenuRegistry(): MenuRegistryImpl {
  const r = new MenuRegistryImpl()
  r.setGroupOrder(MenuId.App, APP_MENU_GROUPS)
  r.appendMenuGroup(MenuId.App, { id: 'look', heading: { label: 'Tema', icon: 'circle-half' } })
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
  return entries.map(e => {
    if (e.type === 'separator') return '<li class="sep" role="separator"></li>'
    if (e.type === 'heading') return `<li class="label">${e.icon ? iconSpan(e.icon) : ''}${esc(e.label)}</li>`
    const i = e.item
    const role = i.kind === 'radio' ? 'menuitemradio' : i.kind === 'checkbox' ? 'menuitemcheckbox' : 'menuitem'
    const data = Object.entries(i.data ?? {}).map(([k, v]) => ` data-${esc(k)}="${esc(v)}"`).join('')
    const checked = i.kind === 'checkbox' ? ` aria-checked="${(i.toggled ? i.toggled() : i.checked) === true}"` : ''
    const cls = i.danger ? ' class="danger"' : ''
    const lead = i.kind ? iconSpan('check', ' check') : i.icon ? iconSpan(i.icon) : ''
    return `<li role="${role}"${data} data-command="${esc(i.command)}"${checked}${cls}>${lead}${esc(i.label ?? titleOf(i.command) ?? i.command)}</li>`
  }).join('\n')
}
