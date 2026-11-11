// The app's own commands, declared as data over a narrow host (main.ts implements it): what used to be spread over
// the ≡ menu, the keyboard switch and the native menu now lives in this one list. Ids are stable (the CLI and
// the tests name them); titles are what the palette and the menu show. Add an action here first: the palette,
// the menu and the chord follow.
import type { Command } from './commands.ts'
import type { EmptyOrigin } from '../shared/empty.ts'
import { DIRECTIONS, DUPLICATE_LABEL, EMPTY_SUFFIX, NEW_EMPTY_DESK_LABEL, NEW_EMPTY_FRAME_LABEL, NEW_FRAME_LABEL, NEW_PANEL_LABEL, NEW_TAB_LABEL, PLACEMENT_LABEL, SPLIT_EMPTY_LABEL, type Direction, type Target } from './create.ts'
import type { FontSizeCommand } from '../shared/font.ts'
import type { ThemeSetting } from '../shared/theme.ts'
import type { DimLevel } from '../shared/ui-settings.ts'
import type { Level } from './shortcuts.ts'
import type { PaletteMode } from './palette-rules.ts'

export interface CommandHost {
  /** The contextless popup ("Novo painel…"): the chooser with the "Onde" row. */
  newPanel(opts?: { target?: Target }): void
  /** Ctrl+Shift+T: an empty pane as a new tab of the active group (origin `add`: Esc closes it), the chooser inside. */
  newTab(): void
  duplicateActive(target: Target): void
  /**
   * An empty pane (app/shared/empty.ts) relative to the active pane: beside it, at its frame's edge, or in a new frame at the
   * desk's edge. `origin`: from the chord it is a request (`add`: Esc closes it); from the palette it is layout (Esc only leaves).
   */
  splitEmpty(target: Target, origin: EmptyOrigin): void
  /** A new desk after the current one, holding one empty pane. */
  newEmptyDesk(): void
  /** The pane the pane-level commands act on (the current desk's active pane), or undefined. */
  activePane(): string | undefined
  renamePane(id: string): void
  switchProfile(id: string): void
  /** "Reiniciar agente": relaunch the pane's agent resuming the same session (the daemon refuses shells and unreported sessions). */
  restartAgent(id: string): void
  /** "Hibernar guia": stop the pane's process and keep it asleep (not started on launch) until woken. */
  hibernatePane(id: string): void
  toggleDetails(id: string): void
  /** "Copiar link do painel": a tether:// link to the pane (app/shared/tether-url.ts). */
  copyLink(id: string): void
  copyFolder(id: string): void
  openFolder(id: string): void
  movePane(id: string): void
  closePane(id: string): void
  createDesk(side: 'before' | 'after'): void
  cycleDesk(step: 1 | -1): void
  goToDesk(position: number): void
  /** Moves the active desk along the queue; at the edge it does nothing. */
  moveActiveDesk(where: 'left' | 'right' | 'first' | 'last'): void
  /** The builder mode (builder-mode.ts) on or off: the "+" at the borders of frames and desks, the content inert. */
  toggleBuilder(): void
  /** The current desk's menu (rename, colour, move…), opened under its chip. */
  deskActions(): void
  closeDesk(): void
  toggleDrawer(): void
  quickShell(): void
  setTheme(setting: ThemeSetting): void
  toggleDeskLine(): void
  toggleTabBorder(): void
  toggleDimUnfocused(): void
  /** Picks the strength of the dim and turns the dim on. */
  setDimLevel(level: DimLevel): void
  openTerminalTheme(): void
  fontSize(command: FontSizeCommand): void
  openProfiles(): void
  /** The "Sessões" popup: everything running, the polite pause and the resume. */
  sessionsManage(): void
  /** "Sessões…" / "Pedir pausa…": opens the Sessões menu (the second one with the focus on the pause button); never pauses by itself. */
  sessionsMenu(focusPause: boolean): void
  restoreConfirmations(): void
  /** "Associar links tether:// a este tether…". */
  associateLinks(): void
  closeWindow(): void
  quitAll(): void
  restartDaemon(): void
  /** Ends every agent (confirmed in the in-app dialog), restarts the tetherd and resumes the sessions. */
  reloadAll(): void
  /** A fresh main process; the tetherd and its agents stay. */
  relaunchApp(): void
  toggleDevTools(): void
  toggleFullscreen(): void
  showPalette(mode: PaletteMode, query?: string): void
  /** Ctrl+Shift+T: the last pane closed comes back (a slot resumes; a pane type says what else reopens). */
  reopenClosed(): void
  /** The tabs of the active group: next / previous (wrapping), the N-th, the last. */
  cycleTab(step: 1 | -1): void
  goToTab(position: number | 'last'): void
  /** Ctrl+K Ctrl+arrows: the keyboard to the visible pane next to the active one in that direction. */
  focusNeighbour(direction: Direction): void
  /** Ctrl+K W: every tab of the active group closes (each agent pane confirms as a single close does). */
  closeFrameTabs(): void
  /** The "Extensões" screen (a tab; one at a time). */
  showExtensions(): void
  /** Ctrl+B / Ctrl+Alt+B: a side bar opens (with the pad it had last) or closes (F10). */
  toggleSideBar(side: 'left' | 'right'): void
  /** The current pad (the open one most recently opened or focused) to the other side bar / back to its default side. */
  moveCurrentPad(): void
  restoreCurrentPad(): void
}

export const GROUP = { pane: 'Painel', frame: 'Quadro', desk: 'Mesa', drawer: 'Gaveta', sidebars: 'Barras laterais', look: 'Aparência', app: 'App', note: 'Nota' } as const

/** The level's wording in a duplicate title: "à direita" (pane), "na borda do quadro, à direita", "num quadro novo, à direita". */
const LEVEL_WORDING: Record<Level, string> = { pane: '', frame: 'na borda do quadro, ', desk: 'num quadro novo, ' }

const DESK_POSITIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9]
const TAB_POSITIONS = DESK_POSITIONS

export function appCommands(host: CommandHost): Command[] {
  const pane = { when: (ctx: { pane: boolean }) => ctx.pane }
  const withPane = (f: (id: string) => void) => (): void => { const id = host.activePane(); if (id) f(id) }
  const duplicates = (['pane', 'frame', 'desk'] as const).flatMap(level => DIRECTIONS.map((direction: Direction): Command => ({
    id: `pane.duplicate.${level}.${direction}`,
    title: `${DUPLICATE_LABEL} ${LEVEL_WORDING[level]}${PLACEMENT_LABEL[direction]}`,
    group: GROUP.pane, icon: 'copy',
   
    ...pane,
    run: () => host.duplicateActive({ level, placement: direction }),
  })))
  // The empty pane: "Dividir à direita (vazio)" beside the pane (the chord), "Dividir na borda do quadro, à direita (vazio)"
  // (no chord: the frame level's +Shift is taken), "Novo quadro vazio à direita" (a frame at the desk's edge).
  const splits = (['pane', 'frame'] as const).flatMap(level => DIRECTIONS.map((direction: Direction): Command => ({
    id: `pane.split-empty.${level}.${direction}`,
    title: `${SPLIT_EMPTY_LABEL} ${LEVEL_WORDING[level]}${PLACEMENT_LABEL[direction]} ${EMPTY_SUFFIX}`,
    group: GROUP.pane, icon: 'plus',
    run: source => host.splitEmpty({ level, placement: direction }, source === 'key' ? 'add' : 'layout'),
  })))
  const emptyFrames = DIRECTIONS.map((direction: Direction): Command => ({
    id: `frame.new-empty.${direction}`,
    title: `${NEW_EMPTY_FRAME_LABEL} ${PLACEMENT_LABEL[direction]}`,
    group: GROUP.frame, icon: 'columns',
    run: () => host.splitEmpty({ level: 'desk', placement: direction }, 'layout'),
  }))
  return [
    // ----- pane -----
    { id: 'pane.new-tab', title: NEW_TAB_LABEL, group: GROUP.pane, icon: 'plus', run: () => host.newTab() },
    { id: 'pane.new', title: NEW_PANEL_LABEL, group: GROUP.pane, icon: 'plus', run: () => host.newPanel() },
    { id: 'pane.reopen-closed', title: 'Reabrir o último painel fechado', group: GROUP.pane, icon: 'arrow-counter-clockwise', run: () => host.reopenClosed() },
    { id: 'pane.next-tab', title: 'Próxima aba do quadro', group: GROUP.pane, icon: 'arrow-right', ...pane, run: () => host.cycleTab(1) },
    { id: 'pane.previous-tab', title: 'Aba anterior do quadro', group: GROUP.pane, icon: 'arrow-left', ...pane, run: () => host.cycleTab(-1) },
    ...TAB_POSITIONS.map((position): Command => ({ id: `pane.go.${position}`, title: `Aba ${position} do quadro`, group: GROUP.pane, icon: 'tabs', ...pane, run: () => host.goToTab(position) })),
    { id: 'pane.last', title: 'Última aba do quadro', group: GROUP.pane, icon: 'tabs', ...pane, run: () => host.goToTab('last') },
    ...duplicates,
    ...splits,
    { id: 'pane.new-at-frame-edge', title: 'Novo painel na borda do quadro…', group: GROUP.pane, icon: 'square-half', run: () => host.newPanel({ target: { level: 'frame', placement: 'right' } }) },
    { id: 'frame.new', title: `${NEW_FRAME_LABEL}…`, group: GROUP.frame, icon: 'columns', run: () => host.newPanel({ target: { level: 'desk', placement: 'right' } }) },
    ...emptyFrames,
    ...DIRECTIONS.map((direction: Direction): Command => ({ id: `frame.focus.${direction}`, title: `Focar o painel vizinho ${PLACEMENT_LABEL[direction]}`, group: GROUP.frame, icon: 'arrow-square-out', ...pane, run: () => host.focusNeighbour(direction) })),
    { id: 'frame.close-tabs', title: 'Fechar todas as abas do quadro…', group: GROUP.frame, icon: 'x', ...pane, run: () => host.closeFrameTabs() },
    { id: 'pane.rename', title: 'Renomear painel…', group: GROUP.pane, icon: 'pencil-simple', ...pane, run: withPane(id => host.renamePane(id)) },
    { id: 'pane.switch-profile', title: 'Trocar perfil do painel…', group: GROUP.pane, icon: 'arrow-clockwise', ...pane, run: withPane(id => host.switchProfile(id)) },
    { id: 'pane.restart', title: 'Reiniciar agente do painel', group: GROUP.pane, icon: 'arrow-clockwise', ...pane, run: withPane(id => host.restartAgent(id)) },
    { id: 'pane.hibernate', title: 'Hibernar guia', group: GROUP.pane, icon: 'moon', ...pane, run: withPane(id => host.hibernatePane(id)) },
    { id: 'pane.details', title: 'Mostrar ou ocultar a barra de status do painel', group: GROUP.pane, icon: 'rows', ...pane, run: withPane(id => host.toggleDetails(id)) },
    { id: 'pane.copy-link', title: 'Copiar link do painel', group: GROUP.pane, icon: 'link', ...pane, run: withPane(id => host.copyLink(id)) },
    { id: 'pane.copy-folder', title: 'Copiar pasta do painel', group: GROUP.pane, icon: 'copy', ...pane, run: withPane(id => host.copyFolder(id)) },
    { id: 'pane.open-folder', title: 'Abrir pasta do painel no Explorer', group: GROUP.pane, icon: 'folder-open', ...pane, run: withPane(id => host.openFolder(id)) },
    { id: 'pane.move', title: 'Mover painel…', group: GROUP.pane, icon: 'arrow-square-out', ...pane, run: withPane(id => host.movePane(id)) },
    { id: 'pane.close', title: 'Fechar painel…', group: GROUP.pane, icon: 'x', ...pane, run: withPane(id => host.closePane(id)) },
    // (the note commands come from the note extension: extensions/note/manifest.ts)
    // ----- desk -----
    { id: 'desk.new', title: 'Nova mesa', group: GROUP.desk, icon: 'cards', when: ctx => !ctx.drawerOpen, run: () => host.createDesk('after') },
    { id: 'desk.new-before', title: 'Nova mesa antes desta', group: GROUP.desk, icon: 'arrow-line-left', when: ctx => !ctx.drawerOpen, run: () => host.createDesk('before') },
    { id: 'desk.new-empty', title: NEW_EMPTY_DESK_LABEL, group: GROUP.desk, icon: 'cards', when: ctx => !ctx.drawerOpen, run: () => host.newEmptyDesk() },
    { id: 'desk.next', title: 'Próxima mesa', group: GROUP.desk, icon: 'arrow-right', when: ctx => !ctx.drawerOpen && ctx.desks > 1, run: () => host.cycleDesk(1) },
    { id: 'desk.previous', title: 'Mesa anterior', group: GROUP.desk, icon: 'arrow-left', when: ctx => !ctx.drawerOpen && ctx.desks > 1, run: () => host.cycleDesk(-1) },
    ...DESK_POSITIONS.map((position): Command => ({
      id: `desk.go.${position}`, title: `Ir para a mesa ${position}`, group: GROUP.desk, icon: 'cards',
      when: ctx => !ctx.drawerOpen && ctx.desks >= position, run: () => host.goToDesk(position),
    })),
    { id: 'desk.move-left', title: 'Mover mesa para a esquerda', group: GROUP.desk, icon: 'arrow-line-left', when: ctx => !ctx.drawerOpen && ctx.desks > 1, run: () => host.moveActiveDesk('left') },
    { id: 'desk.move-right', title: 'Mover mesa para a direita', group: GROUP.desk, icon: 'arrow-line-right', when: ctx => !ctx.drawerOpen && ctx.desks > 1, run: () => host.moveActiveDesk('right') },
    { id: 'desk.move-first', title: 'Mover mesa para o início', group: GROUP.desk, icon: 'arrow-line-left', when: ctx => !ctx.drawerOpen && ctx.desks > 1, run: () => host.moveActiveDesk('first') },
    { id: 'desk.move-last', title: 'Mover mesa para o fim', group: GROUP.desk, icon: 'arrow-line-right', when: ctx => !ctx.drawerOpen && ctx.desks > 1, run: () => host.moveActiveDesk('last') },
    { id: 'desk.builder', title: 'Montar a mesa (modo builder)', group: GROUP.desk, icon: 'square-split-horizontal', ignoreRepeat: true, run: () => host.toggleBuilder() },
    { id: 'desk.actions', title: 'Mesa atual: renomear, cor, mover…', group: GROUP.desk, icon: 'pencil-simple', run: () => host.deskActions() },
    { id: 'desk.close', title: 'Fechar mesa…', group: GROUP.desk, icon: 'x', when: ctx => ctx.desks > 1, run: () => host.closeDesk() },
    // ----- drawer -----
    { id: 'drawer.toggle', title: 'Abrir ou fechar a gaveta', group: GROUP.drawer, icon: 'lightning', ignoreRepeat: true, run: () => host.toggleDrawer() },
    { id: 'drawer.quick-terminal', title: 'Terminal rápido na gaveta', group: GROUP.drawer, icon: 'terminal-window', run: () => host.quickShell() },
    // ----- side bars (F10); each pad's own toggle is registered from its manifest (pad.toggle.<id>) -----
    { id: 'sidebar.left.toggle', title: 'Alternar barra lateral esquerda', group: GROUP.sidebars, icon: 'sidebar-simple', ignoreRepeat: true, keepKeyWhenUnavailable: true, when: ctx => (ctx.pads ?? 0) > 0, run: () => host.toggleSideBar('left') },
    { id: 'sidebar.right.toggle', title: 'Alternar barra lateral direita', group: GROUP.sidebars, icon: 'sidebar-simple', ignoreRepeat: true, keepKeyWhenUnavailable: true, when: ctx => (ctx.pads ?? 0) > 0, run: () => host.toggleSideBar('right') },
    { id: 'pad.move-to-other-side', title: 'Mover prancheta para a outra barra', group: GROUP.sidebars, icon: 'arrows-left-right', when: ctx => !!ctx.pad, run: () => host.moveCurrentPad() },
    { id: 'pad.reset-location', title: 'Restaurar posição padrão da prancheta', group: GROUP.sidebars, icon: 'arrow-counter-clockwise', when: ctx => !!ctx.pad && !!ctx.padMoved, run: () => host.restoreCurrentPad() },
    // ----- look -----
    { id: 'theme.light', title: 'Tema: Claro', group: GROUP.look, icon: 'sun', run: () => host.setTheme('light') },
    { id: 'theme.auto', title: 'Tema: Automático', group: GROUP.look, icon: 'circle-half', run: () => host.setTheme('auto') },
    { id: 'theme.dark', title: 'Tema: Escuro', group: GROUP.look, icon: 'moon', run: () => host.setTheme('dark') },
    { id: 'theme.pick', title: 'Tema… (a paleta filtrada)', group: GROUP.look, icon: 'palette', run: () => host.showPalette('commands', 'Tema') },
    { id: 'ui.desk-line', title: 'Ligar ou desligar a linha da cor da mesa', group: GROUP.look, icon: 'minus', run: () => host.toggleDeskLine() },
    { id: 'ui.tab-border', title: 'Ligar ou desligar a borda na guia do painel com foco', group: GROUP.look, icon: 'folder-open', run: () => host.toggleTabBorder() },
    { id: 'ui.dim-unfocused', title: 'Ligar ou desligar o esmaecer dos quadros sem foco', group: GROUP.look, icon: 'square-half', run: () => host.toggleDimUnfocused() },
    { id: 'ui.dim-weak', title: 'Esmaecer: fraco', group: GROUP.look, icon: 'square-half', run: () => host.setDimLevel('weak') },
    { id: 'ui.dim-medium', title: 'Esmaecer: médio', group: GROUP.look, icon: 'square-half', run: () => host.setDimLevel('medium') },
    { id: 'ui.dim-strong', title: 'Esmaecer: forte', group: GROUP.look, icon: 'square-half', run: () => host.setDimLevel('strong') },
    { id: 'terminal.theme', title: 'Tema do terminal…', group: GROUP.look, icon: 'palette', run: () => host.openTerminalTheme() },
    { id: 'font.increase', title: 'Aumentar a fonte do terminal', group: GROUP.look, icon: 'text-aa', run: () => host.fontSize('increase') },
    { id: 'font.decrease', title: 'Diminuir a fonte do terminal', group: GROUP.look, icon: 'text-aa', run: () => host.fontSize('decrease') },
    { id: 'font.reset', title: 'Fonte do terminal no tamanho padrão', group: GROUP.look, icon: 'text-aa', run: () => host.fontSize('reset') },
    // ----- app -----
    { id: 'palette.show', title: 'Paleta de comandos', group: GROUP.app, icon: 'magnifying-glass', run: () => host.showPalette('commands') },
    // (Ctrl+P, 'palette.quick-open', comes from the quick-open extension: extensions/quick-open/manifest.ts)
    // (keybindings.show / keybindings.record, Ctrl+K Ctrl+S, come from the keybindings-screen extension)
    { id: 'extensions.show', title: 'Extensões', group: GROUP.app, icon: 'puzzle-piece', run: () => host.showExtensions() },
    { id: 'profiles.manage', title: 'Perfis de lançamento…', group: GROUP.app, icon: 'sliders-horizontal', run: () => host.openProfiles() },
    { id: 'sessions.menu', title: 'Sessões…', group: GROUP.app, icon: 'tray', run: () => host.sessionsMenu(false) },
    { id: 'pause.start', title: 'Pedir pausa aos agentes…', group: GROUP.app, icon: 'pause', run: () => host.sessionsMenu(true) },
    { id: 'sessions.manage', title: 'Sessões em andamento…', group: GROUP.app, icon: 'tray', run: () => host.sessionsManage() },
    { id: 'links.associate', title: 'Associar links tether:// a este tether…', group: GROUP.app, icon: 'link', run: () => host.associateLinks() },
    { id: 'confirmations.restore', title: 'Voltar a perguntar antes de fechar painéis', group: GROUP.app, icon: 'arrow-clockwise', run: () => host.restoreConfirmations() },
    { id: 'daemon.restart', title: 'Reiniciar o tetherd… (encerra os agentes e retoma as sessões)', group: GROUP.app, icon: 'plugs', run: () => host.restartDaemon() },
    { id: 'app.reload-all', title: 'Reiniciar tudo… (app e tetherd; encerra os agentes e retoma as sessões)', group: GROUP.app, icon: 'arrows-clockwise', danger: true, run: () => host.reloadAll() },
    { id: 'app.relaunch', title: 'Reiniciar o app (os agentes continuam rodando)', group: GROUP.app, icon: 'arrow-clockwise', run: () => host.relaunchApp() },
    { id: 'app.devtools', title: 'Ferramentas de desenvolvedor', group: GROUP.app, icon: 'bug', displayChord: { mod: true, shift: true, code: 'KeyI' }, run: () => host.toggleDevTools() },
    { id: 'window.fullscreen', title: 'Tela cheia', group: GROUP.app, icon: 'arrows-out-simple', displayChord: { code: 'F11' }, run: () => host.toggleFullscreen() },
    { id: 'window.close', title: 'Fechar a janela', group: GROUP.app, icon: 'app-window', displayChord: { mod: true, shift: true, code: 'KeyW' }, run: () => host.closeWindow() },
    { id: 'app.quit-all', title: 'Sair e encerrar tudo…', group: GROUP.app, icon: 'power', danger: true, run: () => host.quitAll() },
  ]
}
