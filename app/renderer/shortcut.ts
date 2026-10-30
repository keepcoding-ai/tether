// The platform's own app chords, on top of the registry (app/renderer/shortcuts.ts, Ctrl-based and the same on
// every platform). On macOS the app chords are Cmd ones (Ctrl stays free for the terminal: Ctrl+C = SIGINT,
// Ctrl+V = Claude Code's image paste): Cmd+T/D/E open/duplicate, Cmd+C/V copy/paste, Cmd+=/-/0 step the font
// size. Elsewhere only the font size has its own chords here (Ctrl+Shift+=/-/0); the rest is the registry's.
import type { FontSizeCommand } from '../shared/font.ts'
import type { AppShortcut, KeyLike, PaneCommand } from './shortcuts.ts'

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(
  (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform,
)

/** True when the event carries the platform's app-shortcut modifier combo (the key itself is checked by the caller). */
export function isAppShortcut(ev: KeyLike, mac = IS_MAC): boolean {
  if (mac) return ev.metaKey && !ev.ctrlKey && !ev.altKey
  return ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey
}

/** macOS: Cmd+T / Cmd+D / Cmd+E as the registry's "choose" and "duplicate beside" (right / below). */
export function macShortcutOf(ev: KeyLike, mac = IS_MAC): AppShortcut | undefined {
  if (!mac || !isAppShortcut(ev, true) || ev.shiftKey) return undefined
  switch (ev.code) {
    case 'KeyT': return { op: 'choose' }
    case 'KeyD': return { op: 'duplicate', level: 'pane', direction: 'right' }
    case 'KeyE': return { op: 'duplicate', level: 'pane', direction: 'below' }
    default: return undefined
  }
}

/** macOS: Cmd+C copies the selection, Cmd+V pastes the clipboard text (keydown only). */
export function macPaneCommand(ev: KeyLike & { type?: string }, mac = IS_MAC): PaneCommand | undefined {
  if (ev.type !== undefined && ev.type !== 'keydown') return undefined
  if (!mac || !isAppShortcut(ev, true) || ev.shiftKey) return undefined
  if (ev.code === 'KeyC') return 'copy'
  if (ev.code === 'KeyV') return 'paste'
  return undefined
}

/** Cmd+= / Cmd++ / Cmd+- / Cmd+0 on macOS, Ctrl+Shift+= / - / 0 elsewhere; numpad keys too. */
export function fontSizeCommand(ev: KeyLike, mac = IS_MAC): FontSizeCommand | undefined {
  if (!isAppShortcut(ev, mac)) return undefined
  switch (ev.code) {
    case 'Equal': case 'NumpadAdd': return 'increase'
    case 'Minus': case 'NumpadSubtract': return 'decrease'
    case 'Digit0': case 'Numpad0': return 'reset'
    default: return undefined
  }
}
