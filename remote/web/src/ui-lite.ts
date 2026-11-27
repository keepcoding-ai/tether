// What the shared screen (the Regency's pane, the channel's view) needs of the app's shell, as the web has it. The app's
// own pieces draw through the dockview, the context menu, dialogs and the emblem editor; the web has none of them, and its
// page enforces Trusted Types. So:
//   - the build (build.mjs) puts this module in the place of app/renderer/tab-emblems.ts: `emblemBadge` here draws the
//     same chip from the same catalogue, with no sprite and no HTML sink;
//   - the engines (Claude, Codex, Soul, Hands) are named and drawn as in the app: the app's extensions register theirs
//     when they activate, the web registers the same descriptions here, once.
import type { PaneEmblem } from '../../../app/renderer/ext-api.ts'
import { registerAgentUi } from '../../../app/renderer/agent-ui.ts'
import { EMBLEM_ICONS } from '../../../app/renderer/emblem-icons.ts'
import { HUE_NAMES } from '../../../app/shared/palette.ts'
import { claudeUi } from '../../../extensions/claude/ui.ts'
import { codexUi } from '../../../extensions/codex/ui.ts'
import { handsUi } from '../../../extensions/hands/ui.ts'
import { soulUi } from '../../../extensions/soul/ui.ts'
import { appendSvg } from './svg-lite.ts'

const SVG_NS = 'http://www.w3.org/2000/svg'
const iconData = new Map(EMBLEM_ICONS.map(i => [i.n, i.d]))

/**
 * A detached chip of an emblem: the chip of the app's tab (`.emb-chip`), named in its title and aria-label. The colour is
 * one of the 12 hue names (anything else, from a house that sent something odd, gets the neutral chip); the name goes in
 * as text.
 */
export function emblemBadge(e: PaneEmblem): HTMLElement {
  const el = document.createElement('span')
  el.className = 'emb-chip pk-emblem'
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 256 256')
  const d = iconData.get(e.icon)
  if (d !== undefined) appendSvg(svg, d)
  const letter = document.createElement('span')
  letter.className = 'emb-l'
  el.append(svg, letter)
  if ((HUE_NAMES as readonly string[]).includes(e.color)) {
    el.style.background = `var(--x-${e.color})`
    el.style.color = `var(--x-${e.color}-foreground)`
  } else el.classList.add('emb-none')
  el.title = e.name
  el.setAttribute('role', 'img')
  el.setAttribute('aria-label', e.name)
  return el
}

let engines = false

/** Registers the engines' descriptions (label and icon), once: the lists then name and draw each agent as the app does. */
export function registerEngines(): void {
  if (engines) return
  engines = true
  for (const ui of [claudeUi, codexUi, soulUi, handsUi]) registerAgentUi(ui)
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}
