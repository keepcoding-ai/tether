// The desk palette (phase 4, docs/desk-switcher-options.html): 12 hues in OKLCH, and for each one the three CSS
// values the capsule needs, derived by fixed rules so every pair is readable (WCAG >= 4.5:1) in both schemes:
//   --x-{hue}             the fill of the active segment and the desk line (the hue's own colour, or its "deep"
//                          variant, L - 0.08, when the base colour cannot carry a readable foreground);
//   --x-{hue}-foreground  the text on that fill (white for dark fills L < 0.55, near-black otherwise);
//   --x-{hue}-text        the name of an INACTIVE segment, painted straight on the desk background: same hue,
//                          lightness walked away from the background until it reaches 4.5:1.
// Pure (no DOM): the build writes `paletteCss()` to app/dist/palette.css and the unit tests recompute every ratio.
import { type ColorScheme, WINDOW_BACKGROUND } from './theme.ts'

/** The hue names in picker order (around the colour wheel). */
export const HUE_NAMES = ['red', 'orange', 'yellow', 'lime', 'green', 'teal', 'cyan', 'sky', 'blue', 'purple', 'magenta', 'pink'] as const
export type HueName = typeof HUE_NAMES[number]

/** Base colour of each hue: [L, C, h] in OKLCH. */
export const HUES: Readonly<Record<HueName, readonly [number, number, number]>> = {
  red: [0.62, 0.22, 25],
  orange: [0.70, 0.19, 50],
  yellow: [0.86, 0.17, 95],
  lime: [0.80, 0.22, 125],
  green: [0.70, 0.20, 148],
  teal: [0.72, 0.14, 178],
  cyan: [0.78, 0.13, 200],
  sky: [0.70, 0.16, 230],
  blue: [0.58, 0.22, 260],
  purple: [0.58, 0.24, 295],
  magenta: [0.65, 0.27, 322],
  pink: [0.68, 0.22, 355],
}

export const FOREGROUND_LIGHT = '#ffffff'
export const FOREGROUND_DARK = '#10131a'
export const MIN_CONTRAST = 4.5
/** Lightness taken off a base colour that fails its foreground (the "-deep" fill). */
export const DEEP_STEP = 0.08
/** Fills below this lightness take the light foreground. */
export const LIGHT_FOREGROUND_BELOW = 0.55

export interface Oklch { l: number; c: number; h: number }

export interface HueColors {
  fill: Oklch
  foreground: string
  text: Oklch
  /** The fill is the deep variant (the base colour failed 4.5:1 with its foreground). */
  deep: boolean
  /** Contrast of foreground on fill, and of text on the desk background. */
  fillRatio: number
  textRatio: number
}

// ---------- colour maths (the page's lin / Y / cr) ----------

/** OKLCH → linear sRGB, clipped to the gamut. */
export function oklchToLinear({ l: L, c: C, h }: Oklch): [number, number, number] {
  const rad = h * Math.PI / 180
  const a = C * Math.cos(rad)
  const b = C * Math.sin(rad)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s]
  return lin.map(v => Math.min(1, Math.max(0, v))) as [number, number, number]
}

/** WCAG relative luminance of linear sRGB. */
export const luminance = ([r, g, b]: readonly [number, number, number]): number => 0.2126 * r + 0.7152 * g + 0.0722 * b

/** Relative luminance of `#rrggbb`. */
export function hexLuminance(hex: string): number {
  const lin = [1, 3, 5].map(i => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return luminance(lin)
}

/** WCAG contrast ratio of two luminances. */
export const contrast = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)

export const oklchLuminance = (c: Oklch): number => luminance(oklchToLinear(c))

/** The CSS spelling: lightness and chroma to 3 decimals, hue as given. */
export const oklchCss = ({ l, c, h }: Oklch): string => `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h})`

/** The desk background each scheme's text must stand out against (the same constant the CSS token is). */
export function deskBackground(scheme: ColorScheme): string {
  return WINDOW_BACKGROUND[scheme]
}

// ---------- the rules ----------

export function hueColors(name: HueName, scheme: ColorScheme): HueColors {
  const [L, C, h] = HUES[name]
  let fill: Oklch = { l: L, c: C, h }
  let foreground = fill.l < LIGHT_FOREGROUND_BELOW ? FOREGROUND_LIGHT : FOREGROUND_DARK
  let fillRatio = contrast(oklchLuminance(fill), hexLuminance(foreground))
  let deep = false
  if (fillRatio < MIN_CONTRAST) {
    deep = true
    fill = { ...fill, l: L - DEEP_STEP }
    foreground = fill.l < LIGHT_FOREGROUND_BELOW ? FOREGROUND_LIGHT : FOREGROUND_DARK
    fillRatio = contrast(oklchLuminance(fill), hexLuminance(foreground))
  }
  if (fillRatio < MIN_CONTRAST) {
    // The lightness rule picked the weaker side: take the other foreground.
    foreground = foreground === FOREGROUND_LIGHT ? FOREGROUND_DARK : FOREGROUND_LIGHT
    fillRatio = contrast(oklchLuminance(fill), hexLuminance(foreground))
  }
  const bg = hexLuminance(deskBackground(scheme))
  const light = scheme === 'light'
  let tl = light ? 0.52 : 0.80
  let text: Oklch = { l: tl, c: C * 0.9, h }
  let textRatio = contrast(oklchLuminance(text), bg)
  while (textRatio < MIN_CONTRAST && tl > 0.2 && tl < 0.97) {
    tl += light ? -0.02 : 0.02
    text = { l: tl, c: C * 0.9, h }
    textRatio = contrast(oklchLuminance(text), bg)
  }
  return { fill, foreground, text, deep, fillRatio, textRatio }
}

/** The custom properties of one scheme, as one declaration list. */
export function schemeVars(scheme: ColorScheme): string {
  return HUE_NAMES.map(name => {
    const c = hueColors(name, scheme)
    return `--x-${name}:${oklchCss(c.fill)};--x-${name}-foreground:${c.foreground};--x-${name}-text:${oklchCss(c.text)};`
  }).join('')
}

/**
 * The generated stylesheet. Dark is the default `:root`; light applies on `data-theme="light"` and, before the
 * renderer sets the attribute, on `prefers-color-scheme: light` (the same three selectors as styles.css tokens).
 */
export function paletteCss(): string {
  const dark = schemeVars('dark')
  const light = schemeVars('light')
  return [
    '/* Generated by app/build.mjs from app/shared/palette.ts. Do not edit. */',
    `:root{${dark}}`,
    `@media (prefers-color-scheme: light){:root:not([data-theme]){${light}}}`,
    `:root[data-theme="light"]{${light}}`,
    `:root[data-theme="dark"]{${dark}}`,
    '',
  ].join('\n')
}
