// Theme setting shared by the main process (settings.json, nativeTheme, menu) and the renderer (CSS,
// dockview, xterm). `auto` follows the OS (Electron's nativeTheme); `scheme` is what is actually painted.

export type ThemeSetting = 'light' | 'auto' | 'dark'
export type ColorScheme = 'light' | 'dark'

export const THEME_SETTINGS: readonly ThemeSetting[] = ['light', 'auto', 'dark']
export const DEFAULT_THEME: ThemeSetting = 'auto'

/** Labels shown in the menu and the toolbar. */
export const THEME_LABEL: Record<ThemeSetting, string> = { light: 'Claro', auto: 'Automático', dark: 'Escuro' }

/** Window chrome background per scheme: the BrowserWindow color (no flash on load) and the CSS `--bg`. */
export const WINDOW_BACKGROUND: Record<ColorScheme, string> = { light: '#fbfbfd', dark: '#1b1b1f' }

/** Anything that is not one of the three settings (missing, corrupt file, old value) becomes the default. */
export function normalizeTheme(value: unknown): ThemeSetting {
  return (THEME_SETTINGS as readonly unknown[]).includes(value) ? (value as ThemeSetting) : DEFAULT_THEME
}

/** What the setting paints, given what the OS currently prefers. */
export function resolveScheme(setting: ThemeSetting, osPrefersDark: boolean): ColorScheme {
  if (setting === 'auto') return osPrefersDark ? 'dark' : 'light'
  return setting
}

/** What main sends to the renderer whenever the theme changes. */
export interface ThemeState { setting: ThemeSetting; scheme: ColorScheme }
