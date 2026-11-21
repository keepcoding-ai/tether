// The single colour function of an agent: every host (app, browser extension, daemon panels) reads its hue from here.
// Pure, no runtime dependency, so the renderer and the main process share the same answer.

/** Teal: the first hue an agent may take. Red, orange ("needs you") and yellow stay outside the range. */
export const AGENT_HUE_FROM = 170
/** Rose: the last hue an agent may take. Green ("in progress") and the turn dot stay outside the range. */
export const AGENT_HUE_TO = 330

const HUE_SPAN = AGENT_HUE_TO - AGENT_HUE_FROM + 1

/**
 * The hue of an agent, derived from its slot id (FNV-1a, 32 bits): stable across runs and machines, always within
 * AGENT_HUE_FROM..AGENT_HUE_TO. Only the hue is derived; saturation and lightness belong to the theme (the CSS).
 */
export function agentHue(slotId: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < slotId.length; i++) { h ^= slotId.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return AGENT_HUE_FROM + (h % HUE_SPAN)
}
