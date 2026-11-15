// Terminal appearance shared by the main process (settings.json) and the renderer (xterm options, the
// "Tema do tether" dialog): the colour presets (16 ANSI + foreground, cursor, selection, one pair per
// scheme), the bundled fonts, and the user's choice (preset, font, weight, size, line height, ligatures). Fonts
// that draw programming ligatures carry a default for the ligatures switch: on for Fira Code, off for any other;
// fonts without them always run with ligatures off. The panel background is not part of a preset: it is always
// the frame card's (app/shared/theme.ts), so the terminal sits flush in its card in both schemes.
import { FRAME_BACKGROUND, type ColorScheme } from './theme.ts'
import { FIRA_CODE_LIGATURES } from './terminal-ligatures.ts'

export interface TerminalColors {
  foreground: string
  cursor: string
  /** May carry alpha (#rrggbbaa): xterm blends it over the cell. */
  selectionBackground: string
  black: string; red: string; green: string; yellow: string; blue: string; magenta: string; cyan: string; white: string
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string; brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string
}

export type TerminalPresetId = 'github' | 'vscode' | 'ubuntu' | 'catppuccin' | 'one' | 'tokyo-night' | 'tether-classic'

export interface TerminalPreset {
  id: TerminalPresetId
  label: string
  /** One line for the dialog: where it comes from and how it reads on white. */
  note: string
  /** Licence of the upstream theme the values were read from. */
  license: string
  /** Where the hex values were verified (kept as data, not code: a palette is a list of numbers). */
  source: string
  light: TerminalColors
  dark: TerminalColors
}

const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const

function colors(foreground: string, cursor: string, selectionBackground: string, ansi: readonly string[]): TerminalColors {
  if (ansi.length !== 16) throw new Error('a palette has 16 ANSI colors')
  const out = { foreground, cursor, selectionBackground } as TerminalColors
  ANSI.forEach((k, i) => { out[k] = ansi[i]! })
  return out
}

/**
 * Every hex below was read from the upstream source named in `source` (2026-10-30). Order of each list:
 * black, red, green, yellow, blue, magenta, cyan, white, then the eight bright ones.
 */
export const TERMINAL_PRESETS: readonly TerminalPreset[] = [
  {
    // @primer/primitives 7.10.0 dist/json/colors/{light,dark}.json `ansi` (what primer/github-vscode-theme
    // 6.3.5 maps to terminal.ansi*); foreground = the theme's fg.default override (src/colors.js: light
    // #1f2328, dark #e6edf3); selection = accent.muted (rgba 0.4) of each theme.
    id: 'github', label: 'GitHub', license: 'MIT (primer/github-vscode-theme, @primer/primitives)',
    source: 'https://github.com/primer/github-vscode-theme/blob/main/src/theme.js · https://unpkg.com/@primer/primitives@7.10.0/dist/json/colors/light.json (e dark.json)',
    note: 'Paleta Primer do tema oficial do GitHub; o melhor contraste no claro.',
    light: colors('#1f2328', '#1f2328', '#54aeff66', ['#24292f', '#cf222e', '#116329', '#4d2d00', '#0969da', '#8250df', '#1b7c83', '#6e7781', '#57606a', '#a40e26', '#1a7f37', '#633c01', '#218bff', '#a475f9', '#3192aa', '#8c959f']),
    dark: colors('#e6edf3', '#e6edf3', '#388bfd66', ['#484f58', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#b1bac4', '#6e7681', '#ffa198', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#ffffff']),
  },
  {
    // vscode src/vs/workbench/contrib/terminal/common/terminalColorRegistry.ts (`ansiColorMap`, light/dark
    // defaults); foreground = Light Modern #3b3b3b / Dark Modern #cccccc; selection = the editor's
    // selectionBackground defaults (#add6ff / #264f78). Made to run with minimumContrastRatio 4.5.
    id: 'vscode', label: 'VS Code Modern', license: 'MIT (microsoft/vscode)',
    source: 'https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/common/terminalColorRegistry.ts',
    note: 'O terminal integrado do VS Code (Light+/Dark+ e os temas Modern).',
    light: colors('#3b3b3b', '#3b3b3b', '#add6ff', ['#000000', '#cd3131', '#107c10', '#949800', '#0451a5', '#bc05bc', '#0598bc', '#555555', '#666666', '#f14c4c', '#14ce14', '#b5ba00', '#3b8eea', '#d670d6', '#29b8db', '#a5a5a5']),
    dark: colors('#cccccc', '#cccccc', '#264f78', ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5', '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#e5e5e5']),
  },
  {
    // gnome-terminal src/profile-editor.cc: the built-in "GNOME" palette (same 16 for both schemes) and the
    // "GNOME light" / "GNOME dark" schemes' foregrounds (#171421 / #d0cfcc). It is what Ubuntu's terminal
    // (Yaru) ships. The source file is GPL-3.0-or-later; the 16 values are used as data.
    id: 'ubuntu', label: 'Ubuntu (GNOME)', license: 'GPL-3.0-or-later (gnome-terminal; valores usados como dados)',
    source: 'https://sources.debian.org/data/main/g/gnome-terminal/3.56.2-2/src/profile-editor.cc',
    note: 'O terminal do Ubuntu (paleta GNOME); no claro o amarelo vira marrom.',
    light: colors('#171421', '#171421', '#2a7bde55', ['#171421', '#c01c28', '#26a269', '#a2734c', '#12488b', '#a347ba', '#2aa1b3', '#d0cfcc', '#5e5c64', '#f66151', '#33d17a', '#e9ad0c', '#2a7bde', '#c061cb', '#33c7de', '#ffffff']),
    dark: colors('#d0cfcc', '#d0cfcc', '#5e5c64', ['#171421', '#c01c28', '#26a269', '#a2734c', '#12488b', '#a347ba', '#2aa1b3', '#d0cfcc', '#5e5c64', '#f66151', '#33d17a', '#e9ad0c', '#2a7bde', '#c061cb', '#33c7de', '#ffffff']),
  },
  {
    // catppuccin/palette palette.json: flavors latte / mocha, `ansiColors` (normal and bright), text as
    // foreground, rosewater as cursor, surface2 as selection (the ports' convention).
    id: 'catppuccin', label: 'Catppuccin Latte / Mocha', license: 'MIT (catppuccin/palette)',
    source: 'https://github.com/catppuccin/palette/blob/main/palette.json',
    note: 'Pastel; Mocha no escuro, Latte no claro (amarelo e verde fracos, corrigidos pelo contraste mínimo).',
    light: colors('#4c4f69', '#dc8a78', '#acb0be', ['#5c5f77', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#acb0be', '#6c6f85', '#de293e', '#49af3d', '#eea02d', '#456eff', '#fe85d8', '#2d9fa8', '#bcc0cc']),
    dark: colors('#cdd6f4', '#f5e0dc', '#585b70', ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8', '#585b70', '#f37799', '#89d88b', '#ebd391', '#74a8fc', '#f2aede', '#6bd7ca', '#bac2de']),
  },
  {
    // atom/one-light-syntax and atom/one-dark-syntax styles/colors.less: hue-5 red, hue-4 green, hue-6-2
    // yellow, hue-2 blue, hue-3 magenta, hue-1 cyan, mono-1 foreground, mono-3 as the grey. Atom defines no
    // ANSI table of its own; black/white and the brights follow the common One terminal ports.
    id: 'one', label: 'One Light / One Dark', license: 'MIT (atom/one-light-syntax, atom/one-dark-syntax)',
    source: 'https://github.com/atom/one-dark-syntax/blob/master/styles/colors.less · https://github.com/atom/one-light-syntax/blob/master/styles/colors.less',
    note: 'As cores do Atom, suaves e familiares; no claro, amarelo e cinza dependem do contraste mínimo.',
    light: colors('#383a42', '#383a42', '#e5e5e6', ['#383a42', '#e45649', '#50a14f', '#c18401', '#4078f2', '#a626a4', '#0184bc', '#a0a1a7', '#4f525e', '#e45649', '#50a14f', '#c18401', '#4078f2', '#a626a4', '#0184bc', '#ffffff']),
    dark: colors('#abb2bf', '#abb2bf', '#3e4451', ['#3f4451', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#d7dae0', '#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff']),
  },
  {
    // folke/tokyonight.nvim extras/alacritty/tokyonight_{night,day}.toml (generated from the palette:
    // brights are Util.brighten of the normal ones, white = fg_dark, bright white = fg). Selection =
    // bg_visual of each style. Day's "black" is a light grey on purpose; minimumContrastRatio keeps it readable.
    id: 'tokyo-night', label: 'Tokyo Night / Day', license: 'Apache-2.0 (folke/tokyonight.nvim)',
    source: 'https://github.com/folke/tokyonight.nvim/blob/main/extras/alacritty/tokyonight_night.toml · tokyonight_day.toml',
    note: 'Saturado e moderno; Night no escuro, Day (o par oficial) no claro.',
    light: colors('#3760bf', '#3760bf', '#b7c1e3', ['#b4b5b9', '#f52a65', '#587539', '#8c6c3e', '#2e7de9', '#9854f1', '#007197', '#6172b0', '#a1a6c5', '#ff4774', '#5c8524', '#a27629', '#358aff', '#a463ff', '#007ea8', '#3760bf']),
    dark: colors('#c0caf5', '#c0caf5', '#283457', ['#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6', '#414868', '#ff899d', '#9fe044', '#faba4a', '#8db0ff', '#c7a9ff', '#a4daff', '#c0caf5']),
  },
  {
    // What tether painted before presets existed (app/renderer/panel.ts TERMINAL_THEME): Dark+ brights used
    // as normal colours in the dark scheme; Light+ with yellow and cyan darkened by hand in the light one.
    id: 'tether-classic', label: 'Tether clássico', license: 'MIT (microsoft/vscode, ajustado)',
    source: 'Tether, app/renderer/panel.ts antes de 2026-10-30',
    note: 'O que o Tether usava até aqui: no escuro, as brilhantes do VS Code como normais.',
    light: colors('#24292f', '#24292f', '#b4d5fe', ['#000000', '#cd3131', '#107c10', '#8a6d00', '#0451a5', '#bc05bc', '#0a7f99', '#555555', '#5f6368', '#cd3131', '#0f8a0f', '#946f00', '#0451a5', '#bc05bc', '#0a7f99', '#777777']),
    dark: colors('#d8d8dc', '#d8d8dc', '#3a5a8a', ['#1b1b1f', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#e5e5e5', '#6b6b75', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff']),
  },
]

export const DEFAULT_PRESET_ID: TerminalPresetId = 'github'

export function presetOf(id: unknown): TerminalPreset {
  return TERMINAL_PRESETS.find(p => p.id === id) ?? TERMINAL_PRESETS.find(p => p.id === DEFAULT_PRESET_ID)!
}

// ---------- fonts ----------

export type TerminalFontId = 'fira-code' | 'jetbrains-mono' | 'ubuntu-sans-mono' | 'ibm-plex-mono' | 'cascadia-mono'

export interface TerminalFont {
  id: TerminalFontId
  label: string
  /** The @font-face family name (app/renderer/styles.css); the file is a variable woff2 in app/renderer/fonts. */
  family: string
  file: string
  /** The `wght` axis the variable font covers. */
  minWeight: number
  maxWeight: number
  license: string
  version: string
  source: string
  /** Whether the font draws programming ligatures (`=>`, `!=`) through its OpenType features. */
  hasLigatures: boolean
  /** What the ligatures switch takes when this font is chosen (always false without ligatures). */
  ligaturesByDefault: boolean
  /**
   * The sequences the terminal joins for the font when it cannot read the font file itself (the addon's
   * fallback); undefined = the addon's own list.
   */
  ligatureList?: readonly string[]
}

/** Bundled with the app (woff2 + licence text in app/renderer/fonts); no network. */
export const TERMINAL_FONTS: readonly TerminalFont[] = [
  { id: 'fira-code', label: 'Fira Code', family: 'Fira Code', file: 'FiraCode-VF.woff2', minWeight: 300, maxWeight: 700, license: 'OFL-1.1', version: '6.2', source: 'https://github.com/tonsky/FiraCode/releases/tag/6.2 (woff2/FiraCode-VF.woff2)', hasLigatures: true, ligaturesByDefault: true, ligatureList: FIRA_CODE_LIGATURES },
  { id: 'jetbrains-mono', label: 'JetBrains Mono', family: 'JetBrains Mono', file: 'JetBrainsMono-wght.woff2', minWeight: 100, maxWeight: 800, license: 'OFL-1.1', version: '2.304', source: 'https://github.com/JetBrains/JetBrainsMono/releases/tag/v2.304 (fonts/variable/JetBrainsMono[wght].ttf → woff2)', hasLigatures: true, ligaturesByDefault: false },
  { id: 'ubuntu-sans-mono', label: 'Ubuntu Sans Mono', family: 'Ubuntu Sans Mono', file: 'UbuntuSansMono-wght.woff2', minWeight: 100, maxWeight: 700, license: 'Ubuntu Font Licence 1.0', version: '1.0 (2023)', source: 'https://github.com/canonical/Ubuntu-Sans-Mono-fonts (fonts/variable/UbuntuSansMono[wght].ttf → woff2)', hasLigatures: false, ligaturesByDefault: false },
  { id: 'ibm-plex-mono', label: 'IBM Plex Mono', family: 'IBM Plex Mono', file: 'IBMPlexMonoVar-Roman.woff2', minWeight: 100, maxWeight: 700, license: 'OFL-1.1', version: '@ibm/plex-mono-variable 1.0.0', source: 'https://github.com/IBM/plex (npm @ibm/plex-mono-variable, fonts/complete/woff2)', hasLigatures: false, ligaturesByDefault: false },
  { id: 'cascadia-mono', label: 'Cascadia Mono', family: 'Cascadia Mono Bundled', file: 'CascadiaMono-wght.woff2', minWeight: 200, maxWeight: 700, license: 'OFL-1.1', version: '2407.24', source: 'https://github.com/microsoft/cascadia-code/releases/tag/v2407.24 (woff2/CascadiaMono.woff2)', hasLigatures: false, ligaturesByDefault: false },
]

export const DEFAULT_FONT_ID: TerminalFontId = 'fira-code'

export function fontOf(id: unknown): TerminalFont {
  return TERMINAL_FONTS.find(f => f.id === id) ?? TERMINAL_FONTS.find(f => f.id === DEFAULT_FONT_ID)!
}

// ---------- the user's choice ----------

export interface TerminalAppearance {
  preset: TerminalPresetId
  font: TerminalFontId
  /** Regular text weight on the font's `wght` axis. */
  fontWeight: number
  fontSize: number
  lineHeight: number
  /** Programming ligatures on (only ever true for a font that has them). */
  ligatures: boolean
}

export const DEFAULT_APPEARANCE: TerminalAppearance = { preset: DEFAULT_PRESET_ID, font: DEFAULT_FONT_ID, fontWeight: 350, fontSize: 14, lineHeight: 1.2, ligatures: true }

/** Ranges the dialog offers; anything outside (an edited settings.json) is clamped, never refused. */
export const FONT_SIZE_RANGE = { min: 9, max: 28 } as const
export const LINE_HEIGHT_RANGE = { min: 1, max: 1.8, step: 0.05 } as const
export const FONT_WEIGHT_STEP = 25

/** Bold text: clearly heavier than the regular weight, within what the font has (350 → 600, 500 → 700). */
export function boldWeightOf(font: TerminalFont, weight: number): number {
  return Math.min(font.maxWeight, Math.max(600, weight + 200))
}

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))
const round = (v: number, step: number): number => Math.round(v / step) * step

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * Whatever is in settings.json (missing, corrupt, from a newer build) becomes a valid appearance; unknown ids fall
 * back to the defaults. `ligatures` missing or not a boolean takes the font's default; a font without ligatures
 * is always `false`.
 */
export function normalizeAppearance(value: unknown): TerminalAppearance {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const preset = presetOf(raw.preset).id
  const font = fontOf(raw.font)
  const fontWeight = clamp(round(num(raw.fontWeight) ?? DEFAULT_APPEARANCE.fontWeight, FONT_WEIGHT_STEP), font.minWeight, font.maxWeight)
  const fontSize = clamp(Math.round(num(raw.fontSize) ?? DEFAULT_APPEARANCE.fontSize), FONT_SIZE_RANGE.min, FONT_SIZE_RANGE.max)
  const lineHeight = clamp(Number(round(num(raw.lineHeight) ?? DEFAULT_APPEARANCE.lineHeight, LINE_HEIGHT_RANGE.step).toFixed(2)), LINE_HEIGHT_RANGE.min, LINE_HEIGHT_RANGE.max)
  const ligatures = font.hasLigatures && (typeof raw.ligatures === 'boolean' ? raw.ligatures : font.ligaturesByDefault)
  return { preset, font: font.id, fontWeight, fontSize, lineHeight, ligatures }
}

/** The xterm `theme` for a scheme: the preset's colours over the window's own background. Every key set (a missing one would fall back to xterm's dark defaults). */
export function terminalTheme(appearance: TerminalAppearance, scheme: ColorScheme): TerminalColors & { background: string; cursorAccent: string } {
  const c = presetOf(appearance.preset)[scheme]
  return { ...c, background: FRAME_BACKGROUND[scheme], cursorAccent: FRAME_BACKGROUND[scheme] }
}

export interface TerminalFontOptions {
  fontFamily: string
  fontWeight: number
  fontWeightBold: number
  fontSize: number
  lineHeight: number
  letterSpacing: number
  /** WCAG AA: xterm nudges the luminance of any colour that falls short against the background (how VS Code keeps #949800 readable on white). */
  minimumContrastRatio: number
}

export const MINIMUM_CONTRAST_RATIO = 4.5

/** The fallback chain after the bundled family: what Windows has, so a glyph the font lacks still renders. */
const FALLBACK_FAMILIES = '"Cascadia Mono", Consolas, "Courier New", monospace'

/** The xterm font options for an appearance. Ligatures are no xterm option: the ligatures addon carries them (app/renderer/terminal-theme.ts). */
export function terminalFontOptions(appearance: TerminalAppearance): TerminalFontOptions {
  const font = fontOf(appearance.font)
  return {
    fontFamily: `"${font.family}", ${FALLBACK_FAMILIES}`,
    fontWeight: appearance.fontWeight,
    fontWeightBold: boldWeightOf(font, appearance.fontWeight),
    fontSize: appearance.fontSize,
    lineHeight: appearance.lineHeight,
    letterSpacing: 0,
    minimumContrastRatio: MINIMUM_CONTRAST_RATIO,
  }
}

/** The `document.fonts.load` specs (regular and bold) to await before xterm measures the font. */
export function fontLoadSpecs(appearance: TerminalAppearance): string[] {
  const font = fontOf(appearance.font)
  return [appearance.fontWeight, boldWeightOf(font, appearance.fontWeight)].map(w => `${w} ${appearance.fontSize}px "${font.family}"`)
}

/** The weight as the dialog names it (the CSS steps in Portuguese; in-between values say which two they sit between). */
export function weightLabel(weight: number): string {
  const names: Record<number, string> = { 100: 'fino', 200: 'extraleve', 300: 'leve', 400: 'normal', 500: 'médio', 600: 'seminegrito', 700: 'negrito', 800: 'extranegrito', 900: 'preto' }
  if (names[weight]) return `${weight} · ${names[weight]}`
  const lo = Math.floor(weight / 100) * 100
  return `${weight} · entre ${names[lo] ?? lo} e ${names[lo + 100] ?? lo + 100}`
}
