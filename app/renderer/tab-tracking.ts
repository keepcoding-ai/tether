// Keeps the map pane id → tab renderer in step with each tab's life. Pure (no DOM).
//
// dockview builds more than one tab renderer per panel: the header tab (`tabLocation: 'header'`) and, each time the
// overflow dropdown opens, a short-lived row (`'headerOverflow'`). Only the header tab is the pane's tab: if the row
// were tracked it would replace the header tab in the map and, when the dropdown closes, take the entry with it — the
// header tab then never re-renders on state events (the busy/attention dot stuck as it was).

/** Wraps `tab` so its init registers it in `map` (header tabs only) and its dispose removes it (if still its entry). */
export function trackedTab<T extends { init(params: never): void; dispose(): void }>(tab: T, map: Map<string, T>): T {
  const init = tab.init.bind(tab) as (params: { api: { id: string }; tabLocation?: string }) => void
  tab.init = ((params: { api: { id: string }; tabLocation?: string }) => {
    init(params)
    if (params.tabLocation === undefined || params.tabLocation === 'header') map.set(params.api.id, tab)
  }) as T['init']
  const dispose = tab.dispose.bind(tab)
  tab.dispose = () => { dispose(); for (const [id, t] of map) if (t === tab) map.delete(id) }
  return tab
}
