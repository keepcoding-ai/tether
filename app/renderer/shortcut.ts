// App keyboard shortcuts: Cmd on macOS (Ctrl stays free for the terminal, e.g. Ctrl+C = SIGINT),
// Ctrl+Shift on Windows/Linux (plain Ctrl+C/V belong to the terminal there).

export const IS_MAC = /Mac|iPhone|iPad/i.test(
  (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform,
)

/** True when the event carries the platform's app-shortcut modifier combo (the key itself is checked by the caller). */
export function isAppShortcut(ev: KeyboardEvent): boolean {
  if (IS_MAC) return ev.metaKey && !ev.ctrlKey && !ev.altKey
  return ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey
}
