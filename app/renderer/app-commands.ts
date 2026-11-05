// The app's own commands, declared as data over a narrow host (main.ts implements it): what used to be spread over
// the ≡ menu, the keyboard switch and the native menu now lives in this one list. Ids are stable (the CLI and
// the tests name them); titles are what the palette and the menu show. Add an action here first: the palette,
// the menu and the chord follow.
import type { Command } from './commands.ts'
import type { EmptyOrigin } from '../shared/empty.ts'
import { DIRECTIONS, DUPLICATE_LABEL, EMPTY_SUFFIX, NEW_EMPTY_DESK_LABEL, NEW_EMPTY_FRAME_LABEL, NEW_FRAME_LABEL, NEW_PANEL_LABEL, NEW_TAB_LABEL, PLACEMENT_LABEL, SPLIT_EMPTY_LABEL, type Direction, type Target } from './create.ts'
import type { FontSizeCommand } from '../shared/font.ts'
import type { ThemeSetting } from '../shared/theme.ts'
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
  toggleDetails(id: string): void
  copyFolder(id: string): void
  openFolder(id: string): void
  movePane(id: string): void
  closePane(id: string): void
  createDesk(side: 'before' | 'after'): void
  cycleDesk(step: 1 | -1): void
  goToDesk(position: number): void
  /** The current desk's menu (rename, colour, move…), opened under its chip. */
  deskActions(): void
  closeDesk(): void
  toggleDrawer(): void
  quickShell(): void
  setTheme(setting: ThemeSetting): void
  toggleDeskLine(): void
  openTerminalTheme(): void
  fontSize(command: FontSizeCommand): void
  openProfiles(): void
  restoreConfirmations(): void
  closeWindow(): void
  quitAll(): void
  restartDaemon(): void
  /** Ends every agent (confirmed in the in-app dialog), restarts the tetherd and resumes the sessions. */
  reloadAll(): void
  /** A fresh main process; the tetherd and its agents stay. */
  relaunchApp(): void
  toggleDevTools(): void
  toggleFullscreen(): void
  showPalette(mode: PaletteMode): void
  /** Notes (F5): a new note next to the active pane, a file picked from the disk, the focused note saved under another name. */
  newNote(): void
  openNote(): void
  saveNoteAs(): void
}

export const GROUP = { pane: 'Painel', frame: 'Quadro', desk: 'Mesa', drawer: 'Gaveta', look: 'Aparência', app: 'App', note: 'Nota' } as const

/** The level's wording in a duplicate title: "à direita" (pane), "na borda do quadro, à direita", "num quadro novo, à direita". */
const LEVEL_WORDING: Record<Level, string> = { pane: '', frame: 'na borda do quadro, ', desk: 'num quadro novo, ' }

const DESK_POSITIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9]

export function appCommands(host: CommandHost): Command[] {
  const pane = { when: (ctx: { pane: boolean }) => ctx.pane }
  const withPane = (f: (id: string) => void) => (): void => { const id = host.activePane(); if (id) f(id) }
  const duplicates = (['pane', 'frame', 'desk'] as const).flatMap(level => DIRECTIONS.map((direction: Direction): Command => ({
    id: `pane.duplicate.${level}.${direction}`,
    title: `${DUPLICATE_LABEL} ${LEVEL_WORDING[level]}${PLACEMENT_LABEL[direction]}`,
    group: GROUP.pane, icon: 'copy',
    shortcut: { op: 'duplicate', level, direction },
    ...pane,
    run: () => host.duplicateActive({ level, placement: direction }),
  })))
  // The empty pane: "Dividir à direita (vazio)" beside the pane (the chord), "Dividir na borda do quadro, à direita (vazio)"
  // (no chord: the frame level's +Shift is taken), "Novo quadro vazio à direita" (a frame at the desk's edge).
  const splits = (['pane', 'frame'] as const).flatMap(level => DIRECTIONS.map((direction: Direction): Command => ({
    id: `pane.split-empty.${level}.${direction}`,
    title: `${SPLIT_EMPTY_LABEL} ${LEVEL_WORDING[level]}${PLACEMENT_LABEL[direction]} ${EMPTY_SUFFIX}`,
    group: GROUP.pane, icon: 'plus',
    ...(level === 'pane' ? { shortcut: { op: 'split-empty', direction } as const } : {}),
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
    { id: 'pane.new-tab', title: NEW_TAB_LABEL, group: GROUP.pane, icon: 'plus', shortcut: { op: 'new-tab' }, run: () => host.newTab() },
    { id: 'pane.new', title: NEW_PANEL_LABEL, group: GROUP.pane, icon: 'plus', run: () => host.newPanel() },
    ...duplicates,
    ...splits,
    { id: 'pane.new-at-frame-edge', title: 'Novo painel na borda do quadro…', group: GROUP.pane, icon: 'square-half', run: () => host.newPanel({ target: { level: 'frame', placement: 'right' } }) },
    { id: 'frame.new', title: `${NEW_FRAME_LABEL}…`, group: GROUP.frame, icon: 'columns', run: () => host.newPanel({ target: { level: 'desk', placement: 'right' } }) },
    ...emptyFrames,
    { id: 'pane.rename', title: 'Renomear painel…', group: GROUP.pane, icon: 'pencil-simple', ...pane, run: withPane(id => host.renamePane(id)) },
    { id: 'pane.switch-profile', title: 'Trocar perfil do painel…', group: GROUP.pane, icon: 'arrow-clockwise', ...pane, run: withPane(id => host.switchProfile(id)) },
    { id: 'pane.details', title: 'Mostrar ou ocultar a barra de status do painel', group: GROUP.pane, icon: 'rows', shortcut: { op: 'pane-details' }, ...pane, run: withPane(id => host.toggleDetails(id)) },
    { id: 'pane.copy-folder', title: 'Copiar pasta do painel', group: GROUP.pane, icon: 'copy', ...pane, run: withPane(id => host.copyFolder(id)) },
    { id: 'pane.open-folder', title: 'Abrir pasta do painel no Explorer', group: GROUP.pane, icon: 'folder-open', ...pane, run: withPane(id => host.openFolder(id)) },
    { id: 'pane.move', title: 'Mover painel…', group: GROUP.pane, icon: 'arrow-square-out', ...pane, run: withPane(id => host.movePane(id)) },
    { id: 'pane.close', title: 'Fechar painel…', group: GROUP.pane, icon: 'x', ...pane, run: withPane(id => host.closePane(id)) },
    // ----- note -----
    { id: 'note.new', title: 'Nova nota', group: GROUP.note, icon: 'note-pencil', run: () => host.newNote() },
    { id: 'note.open', title: 'Abrir nota…', group: GROUP.note, icon: 'folder-open', run: () => host.openNote() },
    { id: 'note.save-as', title: 'Salvar nota como…', group: GROUP.note, icon: 'floppy-disk', when: ctx => ctx.focus === 'editor', run: () => host.saveNoteAs() },
    // ----- desk -----
    { id: 'desk.new', title: 'Nova mesa', group: GROUP.desk, icon: 'cards', shortcut: { op: 'desk-new', side: 'after' }, when: ctx => !ctx.drawerOpen, run: () => host.createDesk('after') },
    { id: 'desk.new-before', title: 'Nova mesa antes desta', group: GROUP.desk, icon: 'arrow-line-left', shortcut: { op: 'desk-new', side: 'before' }, when: ctx => !ctx.drawerOpen, run: () => host.createDesk('before') },
    { id: 'desk.new-empty', title: NEW_EMPTY_DESK_LABEL, group: GROUP.desk, icon: 'cards', when: ctx => !ctx.drawerOpen, run: () => host.newEmptyDesk() },
    { id: 'desk.next', title: 'Próxima mesa', group: GROUP.desk, icon: 'arrow-right', shortcut: { op: 'desk-cycle', step: 1 }, when: ctx => !ctx.drawerOpen && ctx.desks > 1, run: () => host.cycleDesk(1) },
    { id: 'desk.previous', title: 'Mesa anterior', group: GROUP.desk, icon: 'arrow-left', shortcut: { op: 'desk-cycle', step: -1 }, when: ctx => !ctx.drawerOpen && ctx.desks > 1, run: () => host.cycleDesk(-1) },
    ...DESK_POSITIONS.map((position): Command => ({
      id: `desk.go.${position}`, title: `Ir para a mesa ${position}`, group: GROUP.desk, icon: 'cards',
      shortcut: { op: 'desk-go', position }, when: ctx => !ctx.drawerOpen && ctx.desks >= position, run: () => host.goToDesk(position),
    })),
    { id: 'desk.actions', title: 'Mesa atual: renomear, cor, mover…', group: GROUP.desk, icon: 'pencil-simple', run: () => host.deskActions() },
    { id: 'desk.close', title: 'Fechar mesa…', group: GROUP.desk, icon: 'x', when: ctx => ctx.desks > 1, run: () => host.closeDesk() },
    // ----- drawer -----
    { id: 'drawer.toggle', title: 'Abrir ou fechar a gaveta', group: GROUP.drawer, icon: 'lightning', shortcut: { op: 'drawer-toggle' }, ignoreRepeat: true, run: () => host.toggleDrawer() },
    { id: 'drawer.quick-terminal', title: 'Terminal rápido na gaveta', group: GROUP.drawer, icon: 'terminal-window', run: () => host.quickShell() },
    // ----- look -----
    { id: 'theme.light', title: 'Tema: Claro', group: GROUP.look, icon: 'sun', run: () => host.setTheme('light') },
    { id: 'theme.auto', title: 'Tema: Automático', group: GROUP.look, icon: 'circle-half', run: () => host.setTheme('auto') },
    { id: 'theme.dark', title: 'Tema: Escuro', group: GROUP.look, icon: 'moon', run: () => host.setTheme('dark') },
    { id: 'ui.desk-line', title: 'Ligar ou desligar a linha da cor da mesa', group: GROUP.look, icon: 'minus', run: () => host.toggleDeskLine() },
    { id: 'terminal.theme', title: 'Tema do terminal…', group: GROUP.look, icon: 'palette', run: () => host.openTerminalTheme() },
    { id: 'font.increase', title: 'Aumentar a fonte do terminal', group: GROUP.look, icon: 'text-aa', shortcut: { op: 'font-size', command: 'increase' }, run: () => host.fontSize('increase') },
    { id: 'font.decrease', title: 'Diminuir a fonte do terminal', group: GROUP.look, icon: 'text-aa', shortcut: { op: 'font-size', command: 'decrease' }, run: () => host.fontSize('decrease') },
    { id: 'font.reset', title: 'Fonte do terminal no tamanho padrão', group: GROUP.look, icon: 'text-aa', shortcut: { op: 'font-size', command: 'reset' }, run: () => host.fontSize('reset') },
    // ----- app -----
    { id: 'palette.show', title: 'Paleta de comandos', group: GROUP.app, icon: 'magnifying-glass', shortcut: { op: 'palette' }, run: () => host.showPalette('commands') },
    { id: 'palette.quick-open', title: 'Ir para…', group: GROUP.app, icon: 'magnifying-glass', shortcut: { op: 'quick-open' }, run: () => host.showPalette('quick-open') },
    { id: 'profiles.manage', title: 'Perfis de lançamento…', group: GROUP.app, icon: 'sliders-horizontal', run: () => host.openProfiles() },
    { id: 'confirmations.restore', title: 'Voltar a perguntar antes de fechar painéis', group: GROUP.app, icon: 'arrow-clockwise', run: () => host.restoreConfirmations() },
    { id: 'daemon.restart', title: 'Reiniciar o tetherd… (encerra os agentes e retoma as sessões)', group: GROUP.app, icon: 'plugs', run: () => host.restartDaemon() },
    { id: 'app.reload-all', title: 'Reiniciar tudo… (app e tetherd; encerra os agentes e retoma as sessões)', group: GROUP.app, icon: 'arrows-clockwise', danger: true, run: () => host.reloadAll() },
    { id: 'app.relaunch', title: 'Reiniciar o app (os agentes continuam rodando)', group: GROUP.app, icon: 'arrow-clockwise', run: () => host.relaunchApp() },
    { id: 'app.devtools', title: 'Ferramentas de desenvolvedor', group: GROUP.app, icon: 'bug', run: () => host.toggleDevTools() },
    { id: 'window.fullscreen', title: 'Tela cheia', group: GROUP.app, icon: 'arrows-out-simple', run: () => host.toggleFullscreen() },
    { id: 'window.close', title: 'Fechar a janela', group: GROUP.app, icon: 'app-window', displayChord: { mod: true, shift: true, code: 'KeyW' }, run: () => host.closeWindow() },
    { id: 'app.quit-all', title: 'Sair e encerrar tudo…', group: GROUP.app, icon: 'power', shortcut: { op: 'quit-all' }, danger: true, run: () => host.quitAll() },
  ]
}
