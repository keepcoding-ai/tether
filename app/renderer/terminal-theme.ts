// "Tema do terminal": the dialog (app/renderer/index.html #dlg-term-theme) where the user picks the colour
// preset, the font, its weight, size and line height. Every change applies to every pane at once and is
// persisted through main (settings.json); the dialog carries a small sample terminal that shows the 16
// colours, bold/dim text and box drawing with the exact xterm options the panes get. The presets and the
// fonts themselves live in app/shared/terminal-theme.ts.
import { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import { LigaturesAddon } from '@xterm/addon-ligatures'
import {
  DEFAULT_APPEARANCE, FONT_SIZE_RANGE, FONT_WEIGHT_STEP, fontLoadSpecs, fontOf, LINE_HEIGHT_RANGE, normalizeAppearance,
  TERMINAL_FONTS, TERMINAL_PRESETS, terminalFontOptions, terminalTheme, weightLabel, type TerminalAppearance, type TerminalFontId,
} from '../shared/terminal-theme.ts'
import type { ColorScheme } from '../shared/theme.ts'

/** Which xterm renderer a terminal ended up with: WebGL draws box/block glyphs itself (no gaps at line height 1.2); DOM is the fallback. */
export type TerminalRenderer = 'webgl' | 'dom'

/**
 * The renderer and the ligatures of one xterm (a pane or the dialog's sample), kept in the order xterm needs.
 *
 * WebGL after `open()`: xterm then draws box drawing and block glyphs itself (`customGlyphs`), so they join at
 * any line height; the texture atlas also keeps a tall scrollback cheap. When the GPU is not there (software
 * rendering, a lost context later) the DOM renderer carries on with the font's glyphs.
 *
 * Ligatures: the addon registers a character joiner (runs like `=>` become one cell range, drawn as one string, so
 * the font's `calt`/`liga` can shape them) and sets `font-feature-settings` on the terminal element. It reads the
 * font file through the Local Font Access API when it can, else joins the font's own sequence list (fallback).
 * The WebGL addon is loaded again after every ligatures change, so its atlas is built with the joiner and the
 * feature settings in place. The `ligatures` class on the element is what styles.css keys on: without it every
 * ligature feature is off, which is what keeps the DOM renderer (it shapes whole spans) from ligating anyway.
 */
export class TerminalAddons {
  private readonly term: Terminal
  private webgl: WebglAddon | undefined
  private ligatures: LigaturesAddon | undefined
  private ligatureFont: TerminalFontId | undefined
  /** The WebGL context was lost once: the terminal stays on the DOM renderer from then on. */
  private lost = false

  constructor(term: Terminal) { this.term = term }

  get renderer(): TerminalRenderer { return this.webgl ? 'webgl' : 'dom' }
  /** True while the ligatures addon is loaded (the state the terminal really is in). */
  get ligaturesActive(): boolean { return this.ligatures !== undefined }

  /** After `term.open()`: the ligatures the appearance asks for, then the renderer. */
  start(appearance: TerminalAppearance): void {
    this.setLigatures(appearance)
    this.loadWebgl()
  }

  /** An appearance change: when the ligatures change (on/off, or another font's list), WebGL is reloaded after them. */
  update(appearance: TerminalAppearance): void {
    if (!this.term.element) return
    const want = wantsLigatures(appearance)
    if (want === this.ligaturesActive && (!want || appearance.font === this.ligatureFont)) return
    const hadWebgl = this.webgl !== undefined
    this.webgl?.dispose()
    this.webgl = undefined
    this.setLigatures(appearance)
    if (hadWebgl) this.loadWebgl()
  }

  private setLigatures(appearance: TerminalAppearance): void {
    this.ligatures?.dispose()
    this.ligatures = undefined
    this.ligatureFont = undefined
    const want = wantsLigatures(appearance)
    if (want) {
      const list = fontOf(appearance.font).ligatureList
      const addon = new LigaturesAddon(list ? { fallbackLigatures: [...list] } : {})
      this.term.loadAddon(addon)
      this.ligatures = addon
      this.ligatureFont = appearance.font
    }
    this.term.element?.classList.toggle('ligatures', want)
  }

  private loadWebgl(): void {
    if (this.lost) return
    const webgl = loadWebglRenderer(this.term, () => {
      if (this.webgl === webgl) this.webgl = undefined
      this.lost = true
    })
    this.webgl = webgl
  }
}

/**
 * Loads the WebGL renderer on an opened xterm; undefined when the GPU is not there (the DOM renderer stays).
 * On a lost context the addon is disposed (xterm falls back to DOM) and `onLost` runs.
 */
function loadWebglRenderer(term: Terminal, onLost: () => void): WebglAddon | undefined {
  try {
    // preserveDrawingBuffer: the canvas keeps its last frame, so a window capture (E2E screenshots) sees it.
    const webgl = new WebglAddon(true)
    webgl.onContextLoss(() => { webgl.dispose(); onLost() })
    term.loadAddon(webgl)
    return webgl
  } catch {
    return undefined
  }
}

function wantsLigatures(appearance: TerminalAppearance): boolean {
  return appearance.ligatures && fontOf(appearance.font).hasLigatures
}

/**
 * Loads the regular and bold faces of the appearance's font so xterm measures the real glyphs (measuring the
 * fallback font leaves every cell the wrong size). Resolves even when a face fails: the fallback is used then.
 */
export async function loadTerminalFonts(appearance: TerminalAppearance): Promise<void> {
  await Promise.all(fontLoadSpecs(appearance).map(spec => document.fonts.load(spec).catch(() => [])))
}

/** True when both faces of the appearance's font are already loaded. */
export function terminalFontsLoaded(appearance: TerminalAppearance): boolean {
  return fontLoadSpecs(appearance).every(spec => document.fonts.check(spec))
}

/** Puts an appearance on a terminal: the palette for the scheme and the font options. The caller refits afterwards. */
export function applyAppearance(term: Terminal, appearance: TerminalAppearance, scheme: ColorScheme): void {
  term.options.theme = terminalTheme(appearance, scheme)
  const font = terminalFontOptions(appearance)
  term.options.fontFamily = font.fontFamily
  term.options.fontWeight = font.fontWeight
  term.options.fontWeightBold = font.fontWeightBold
  term.options.fontSize = font.fontSize
  term.options.lineHeight = font.lineHeight
  term.options.letterSpacing = font.letterSpacing
  term.options.minimumContrastRatio = font.minimumContrastRatio
}

export interface TerminalThemeHost {
  appearance(): TerminalAppearance
  scheme(): ColorScheme
  /** The user changed something: apply it everywhere and persist it. */
  apply(appearance: TerminalAppearance): void
}

const ESC = '\x1b['
const COLOR_WORDS = ['preto', 'vermelho', 'verde', 'amarelo', 'azul', 'magenta', 'ciano', 'branco']
export const SAMPLE_COLS = 80

/** What the sample shows: the 8 + 8 colours as words, bold/dim/italic, and the box drawing agents print. */
export const SAMPLE_LINES: string[] = [
  COLOR_WORDS.map((w, i) => `${ESC}${30 + i}m${w}${ESC}0m`).join(' '),
  COLOR_WORDS.map((w, i) => `${ESC}${90 + i}m${w}${ESC}0m`).join(' '),
  `normal  ${ESC}1mnegrito${ESC}0m  ${ESC}2mapagado${ESC}0m  ${ESC}3mitálico${ESC}0m  ${ESC}4msublinhado${ESC}0m  ${ESC}7minverso${ESC}0m  0O 1lI {} => !=`,
  // Caixas só com glifos de largura 1, cada linha com a mesma largura (16 + 2 + 9 colunas); os símbolos
  // de largura ambígua (✻ ✓ ✗) ficam em linhas próprias, depois das caixas, para não deslocar colunas.
  '╭──────────────╮  ┌───┬───┐',
  '│ caixa ▀▄█░▒▓ │  ├───┼───┤',
  '╰──────────────╯  └───┴───┘',
  `${ESC}38;2;215;119;87m✻${ESC}0m Claude  ${ESC}32m✓${ESC}0m ok  ${ESC}31m✗${ESC}0m erro`,
  '$ npm run check',
  `${ESC}2m> _${ESC}0m`,
]

export class TerminalThemeDialog {
  private readonly dlg: HTMLDialogElement
  private readonly presets: HTMLElement
  private readonly font: HTMLSelectElement
  private readonly weight: HTMLInputElement
  private readonly weightLabel: HTMLElement
  private readonly size: HTMLInputElement
  private readonly lineHeight: HTMLInputElement
  private readonly lineHeightLabel: HTMLElement
  private readonly ligatures: HTMLInputElement
  private readonly sampleHost: HTMLElement
  private sample: Terminal | undefined
  private sampleAddons: TerminalAddons | undefined
  private readonly host: TerminalThemeHost
  /** The appearance the dialog shows; equals the host's unless a change is in flight (fonts loading). */
  private current: TerminalAppearance

  constructor(host: TerminalThemeHost) {
    this.host = host
    this.current = host.appearance()
    const $ = <T extends HTMLElement>(id: string): T => {
      const el = document.getElementById(id)
      if (!el) throw new Error(`elemento #${id} não existe`)
      return el as T
    }
    this.dlg = $('dlg-term-theme')
    this.presets = $('term-presets')
    this.font = $('term-font')
    this.weight = $('term-weight')
    this.weightLabel = $('term-weight-label')
    this.size = $('term-size')
    this.lineHeight = $('term-line-height')
    this.lineHeightLabel = $('term-line-height-label')
    this.sampleHost = $('term-sample')
    this.ligatures = $('term-ligatures')

    for (const f of TERMINAL_FONTS) {
      const opt = document.createElement('option')
      opt.value = f.id
      opt.textContent = f.label
      opt.style.fontFamily = `"${f.family}", var(--mono)` // the picker previews each face
      opt.title = `${f.label} ${f.version} · ${f.license}`
      this.font.append(opt)
    }
    this.size.min = String(FONT_SIZE_RANGE.min); this.size.max = String(FONT_SIZE_RANGE.max); this.size.step = '1'
    this.lineHeight.min = String(LINE_HEIGHT_RANGE.min); this.lineHeight.max = String(LINE_HEIGHT_RANGE.max); this.lineHeight.step = String(LINE_HEIGHT_RANGE.step)
    this.weight.step = String(FONT_WEIGHT_STEP)

    this.presets.addEventListener('change', ev => {
      const input = ev.target as HTMLInputElement
      if (input.name === 'term-preset') this.change({ preset: input.value as TerminalAppearance['preset'] })
    })
    // A font change puts the ligatures switch on that font's default (one change, one save); the switch can be flipped after.
    this.font.addEventListener('change', () => {
      const font = fontOf(this.font.value)
      this.change({ font: font.id, ligatures: font.ligaturesByDefault })
    })
    this.ligatures.addEventListener('change', () => this.change({ ligatures: this.ligatures.checked }))
    this.weight.addEventListener('input', () => { this.weightLabel.textContent = weightLabel(Number(this.weight.value)) })
    this.weight.addEventListener('change', () => this.change({ fontWeight: Number(this.weight.value) }))
    this.size.addEventListener('change', () => this.change({ fontSize: Number(this.size.value) }))
    this.lineHeight.addEventListener('input', () => { this.lineHeightLabel.textContent = Number(this.lineHeight.value).toFixed(2) })
    this.lineHeight.addEventListener('change', () => this.change({ lineHeight: Number(this.lineHeight.value) }))
    $('btn-term-theme-reset').addEventListener('click', () => this.change(DEFAULT_APPEARANCE))
    $('btn-term-theme-close').addEventListener('click', () => this.dlg.close())
    $('btn-term-theme-done').addEventListener('click', () => this.dlg.close())
    this.dlg.addEventListener('close', () => { this.sample?.dispose(); this.sample = undefined; this.sampleAddons = undefined })
  }

  get open(): boolean { return this.dlg.open }

  /** A control changed: the new appearance (normalized: a font change clamps the weight to its axis) goes to the host. */
  private change(patch: Partial<TerminalAppearance>): void {
    const next = normalizeAppearance({ ...this.current, ...patch })
    this.current = next
    this.render()
    this.host.apply(next)
  }

  show(): void {
    this.current = this.host.appearance()
    this.render()
    if (!this.dlg.open) this.dlg.showModal()
    this.openSample()
    this.presets.querySelector<HTMLInputElement>('input:checked')?.focus()
  }

  /** The host's appearance or scheme changed (the dialog's own change echoed by main, or the theme switched). */
  refresh(): void {
    if (!this.dlg.open) return
    this.current = this.host.appearance()
    this.render()
  }

  private render(): void {
    const a = this.current
    const scheme = this.host.scheme()
    this.renderPresets(a, scheme)
    const font = fontOf(a.font)
    this.font.value = font.id
    this.weight.min = String(font.minWeight); this.weight.max = String(font.maxWeight); this.weight.value = String(a.fontWeight)
    this.weightLabel.textContent = weightLabel(a.fontWeight)
    this.size.value = String(a.fontSize)
    this.lineHeight.value = String(a.lineHeight)
    this.lineHeightLabel.textContent = a.lineHeight.toFixed(2)
    this.ligatures.checked = a.ligatures
    this.ligatures.disabled = !font.hasLigatures
    if (this.sample) {
      applyAppearance(this.sample, a, scheme)
      this.sampleAddons?.update(a)
      this.sampleHost.style.background = terminalTheme(a, scheme).background
    }
  }

  /** One row per preset: radio, name, note, the eight normal colours of the current scheme as a strip, the licence. */
  private renderPresets(a: TerminalAppearance, scheme: ColorScheme): void {
    const checked = this.presets.querySelector<HTMLInputElement>('input:checked')?.value
    if (checked === a.preset && this.presets.dataset.scheme === scheme && this.presets.childElementCount === TERMINAL_PRESETS.length) return
    this.presets.dataset.scheme = scheme
    this.presets.replaceChildren()
    for (const p of TERMINAL_PRESETS) {
      const row = document.createElement('label')
      row.className = 'preset-option'
      row.dataset.preset = p.id
      const input = document.createElement('input'); input.type = 'radio'; input.name = 'term-preset'; input.value = p.id; input.checked = p.id === a.preset
      const text = document.createElement('span'); text.className = 'preset-text'
      const name = document.createElement('span'); name.className = 'preset-name'; name.textContent = p.label
      if (p.id === DEFAULT_APPEARANCE.preset) { const d = document.createElement('span'); d.className = 'preset-default'; d.textContent = 'padrão'; name.append(d) }
      const note = document.createElement('span'); note.className = 'preset-note'; note.textContent = p.note
      text.append(name, note)
      const strip = document.createElement('span'); strip.className = 'preset-strip'
      strip.style.background = terminalTheme({ ...a, preset: p.id }, scheme).background
      const c = p[scheme]
      for (const hex of [c.black, c.red, c.green, c.yellow, c.blue, c.magenta, c.cyan, c.white]) {
        const sw = document.createElement('i'); sw.style.background = hex; strip.append(sw)
      }
      strip.title = `${p.license}\n${p.source}`
      row.append(input, text, strip)
      this.presets.append(row)
    }
  }

  /** The sample terminal is created on every show (xterm measures on open; the dialog is hidden between shows). */
  private openSample(): void {
    if (this.sample) return
    const a = this.current
    // Wide enough for the longest line (no wrapping: there is no scrollback to hide a wrapped row in).
    const term = new Terminal({ ...terminalFontOptions(a), theme: terminalTheme(a, this.host.scheme()), rows: SAMPLE_LINES.length, cols: SAMPLE_COLS, cursorBlink: false, disableStdin: true, allowProposedApi: true, scrollback: 0 })
    this.sample = term
    this.sampleHost.replaceChildren()
    this.sampleHost.style.background = terminalTheme(a, this.host.scheme()).background
    term.open(this.sampleHost)
    // The same renderer and ligatures the panes get (TerminalAddons): what the sample shows is what the panes do.
    this.sampleAddons = new TerminalAddons(term)
    this.sampleAddons.start(a)
    for (const line of SAMPLE_LINES) term.writeln(line)
  }

  /** The sample's xterm (tests read its options and buffer). */
  get sampleTerminal(): Terminal | undefined { return this.sample }
  /** Whether the sample has the ligatures addon loaded (false while the dialog is closed). */
  get sampleLigatures(): boolean { return this.sampleAddons?.ligaturesActive ?? false }
}
