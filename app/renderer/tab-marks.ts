// Two marks a tab can carry, DOM only (which tab is the core's decision, app/renderer/main.ts):
//   - the keyboard mark (`.keyboard-tab`): ONE tab in the whole app, the tab of the pane that has the keyboard — in a desk,
//     a pad or the drawer. A bar on its top (styles.css). Moving the keyboard moves the mark; no other tab ever has it.
//   - attention (`.attention-tab`): a short pulse that draws the eye to a tab, for anyone who brings a pane up from far
//     away (a tether:// link, today). It knows nothing about who calls it; the keyboard mark stays as it is.
// A tab element is dockview's `.dv-tab` (the strip's cell around the tab's own content).

export const KEYBOARD_TAB_CLASS = 'keyboard-tab'
export const ATTENTION_TAB_CLASS = 'attention-tab'
/** How long the attention pulse lasts (styles.css runs the same length). */
export const ATTENTION_MS = 1200

/** The strip cell of a tab, from any element inside it. */
export function tabCell(el: Element | null | undefined): HTMLElement | undefined {
  return (el?.closest('.dv-tab') as HTMLElement | null) ?? undefined
}

let marked: HTMLElement | undefined

/** The keyboard mark on `cell` and on no other tab (undefined: on none). */
export function markKeyboardTab(cell: HTMLElement | undefined): void {
  if (marked === cell && cell?.classList.contains(KEYBOARD_TAB_CLASS)) return
  // A tab moved between frames is a new element: clear every old mark, not only the one remembered.
  for (const el of document.querySelectorAll(`.${KEYBOARD_TAB_CLASS}`)) if (el !== cell) el.classList.remove(KEYBOARD_TAB_CLASS)
  cell?.classList.add(KEYBOARD_TAB_CLASS)
  marked = cell
}

const pulses = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()

/** A short pulse on `cell` (again from the start when it was already pulsing). */
export function pulseTab(cell: HTMLElement | undefined): void {
  if (!cell) return
  clearTimeout(pulses.get(cell))
  cell.classList.remove(ATTENTION_TAB_CLASS)
  void cell.offsetWidth // restart the animation
  cell.classList.add(ATTENTION_TAB_CLASS)
  pulses.set(cell, setTimeout(() => { cell.classList.remove(ATTENTION_TAB_CLASS); pulses.delete(cell) }, ATTENTION_MS))
}
