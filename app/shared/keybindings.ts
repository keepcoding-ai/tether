// The "Atalhos de teclado" screen (F5, delivery 5): a pane like a note or a preview, with no slot behind it and no
// file; its identity is the pane id (a prefix the layout code recognizes) so a restart brings the tab back. The
// user's own bindings live in <TETHER_HOME>/keybindings.json (app/renderer/keybindings-rules.ts); main reads,
// writes and watches that file (app/main/main.ts), the renderer owns the format.
export const KEYBINDINGS_COMPONENT = 'keybindings'
export const KEYBINDINGS_TAB = 'keybindings-tab'
export const KEYBINDINGS_PANEL_PREFIX = 'keybindings:'
/** What the tab shows. */
export const KEYBINDINGS_TITLE = 'Atalhos de teclado'
/** The file's name under TETHER_HOME. */
export const KEYBINDINGS_FILE = 'keybindings.json'

export function isKeybindingsPanelId(id: string): boolean {
  return id.startsWith(KEYBINDINGS_PANEL_PREFIX)
}

/** A fresh pane id (one screen at a time is the rule, but the id stays unique for the layout). */
export function newKeybindingsPanelId(now: number = Date.now()): string {
  return `${KEYBINDINGS_PANEL_PREFIX}${now.toString(36)}`
}

/** What main hands the renderer about the file: its path, its text (null when it does not exist). */
export interface KeybindingsFileState { path: string; text: string | null }
