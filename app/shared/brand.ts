// The product's identity, read by the three hosts (renderer, main, daemon) and handed to extensions as `api.brand`.
// Today a constant; if tether ever ships per tenant, this is the one file a build would generate. Pure, no imports.

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

export const BRAND: Brand = Object.freeze({
  name: 'Tether',
  slug: 'tether',
  appId: 'studio.codr.tether',
  accent: '#6aa6ff',
  icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6h14"/><path d="M12 6v13"/></svg>',
})
