// The pane header (the status bar: state, profile, folder, unsafe badge, pinned actions) is collapsible per pane. The state
// lives in the pane's layout params (`details`), so it is saved with the layout and survives a relaunch.
// Absent or anything but `true` means collapsed: panes saved before the feature come back collapsed too.
// Pure on purpose (no DOM): unit-tested.

/** Params as dockview hands them over; only `details` is read here. */
type Params = Record<string, unknown> | undefined

/** The header is expanded only when the pane's params say so explicitly. */
export function detailsOpen(params: Params): boolean {
  return params?.details === true
}

/**
 * The params with the header state set. Written as an explicit boolean (never dropped): dockview merges the
 * parameters it is given, so a missing key would not clear a previous `true`.
 */
export function withDetails(params: Params, open: boolean): Record<string, unknown> {
  return { ...params, details: open }
}

/** The label of the tab menu entry and of the toggle button for the next state. */
export function detailsLabel(open: boolean): string {
  return open ? 'Ocultar barra de status' : 'Mostrar barra de status'
}
