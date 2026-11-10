// `tether focus <file> --pad` (app/shared/tether-url.ts `&pad=`): which pad, and whose view of it, a note link opens in.
// Pure (unit-tested in test/unit/app.pad-link-rules.test.ts); app/renderer/main.ts brings the owner forward and opens the file.
import type { NotePad, PadScopeName } from '../shared/tether-url.ts'

/** The ids of the frame pads (extensions/frame-pads/manifest.ts): written in people's layout.json, they never change. */
export const PAD_OF_SCOPE: Record<PadScopeName, string> = {
  panel: 'frame-pads.panel',
  desk: 'frame-pads.desk',
  global: 'frame-pads.global',
}

/** What the plan needs to know about the window. */
export interface PadLinkWorld {
  /** The desk a pane sits in (not a pad, not the drawer); undefined for any other place. */
  deskOf(paneId: string): string | undefined
  activeDeskId: string
  /** The pane the per-panel pads follow now (the Foco de Mesa's). */
  focusablePanelId: string | undefined
}

export type PadLinkPlan =
  | { ok: true; padId: string; deskId?: string; panelId?: string }
  | { ok: false; message: string }

/**
 * The pad a note link opens in and its owner: the global pad has none; the desk pad belongs to the desk of the named pane
 * (the active desk without one); the panel pad to the named pane — which must sit in a desk — or, without one, to the pane
 * in the Foco de Mesa.
 */
export function planPadLink(pad: NotePad, world: PadLinkWorld): PadLinkPlan {
  const padId = PAD_OF_SCOPE[pad.scope]
  if (pad.scope === 'global') return { ok: true, padId }
  if (pad.scope === 'desk') return { ok: true, padId, deskId: (pad.slot ? world.deskOf(pad.slot) : undefined) ?? world.activeDeskId }
  const panelId = pad.slot ?? world.focusablePanelId
  if (!panelId) return { ok: false, message: 'Não há painel em foco para abrir a prancheta do painel.' }
  if (!world.deskOf(panelId)) return { ok: false, message: 'A prancheta do painel só existe para painéis que estão numa mesa (não na gaveta nem em outra prancheta).' }
  return { ok: true, padId, panelId }
}
