// The product's identity, read by the three hosts (renderer, main, daemon) and handed to extensions as `api.brand`.
// One source: brand/brand.json (the host's brand file of the Atrium Bridge, validated by brand/brand.schema.json) and
// brand/assets/app/mask.json (the 24x24 `currentColor` monogram app/brand-mask.mjs derives from brand/src/light/mask.svg).
// Both are JSON so the same import works in Node 24 (`with { type: 'json' }`), in tsc and in the esbuild bundles.
//
// brand.json names the Bridge product ("Tether Bridge"); the app's own name is its `shortName` ("Tether"), and it
// keeps feeding app.setName, the window titles, the AUMID (`host.id`) and the install name. Pure, no other imports.
import brand from '../../brand/brand.json' with { type: 'json' }
import mask from '../../brand/assets/app/mask.json' with { type: 'json' }

export interface Brand {
  /** The name people read ("Tether"). */
  readonly name: string
  /** Lowercase, safe in file names, MCP server names and CLI commands. */
  readonly slug: string
  /** The OS application id (taskbar grouping on Windows, CFBundleIdentifier on macOS). */
  readonly appId: string
  /** The brand colour: the dark theme's `--accent` (app/renderer/styles.css). */
  readonly accent: string
  /** A square monogram, 24x24 viewBox, `currentColor`. */
  readonly icon: string
}

/** `shortName` when the brand file has one, else the product name without its " Bridge" suffix (the bridge's own rule). */
const shortName = (b: { name: string; shortName?: string }): string => b.shortName ?? b.name.replace(/\s+Bridge$/i, '')

export const BRAND: Brand = Object.freeze({
  name: shortName(brand),
  slug: brand.slug,
  appId: brand.host.id,
  accent: brand.colors.accent,
  icon: mask.icon,
})
