// "Tema do terminal": the dialog (app/renderer/index.html #dlg-term-theme) where the user picks the colour
// preset, the font, its weight, size and line height. Every change applies to every pane at once and is
// persisted through main (settings.json); the dialog carries a small sample terminal that shows the 16
// colours, bold/dim text and box drawing with the exact xterm options the panes get. The presets and the
// fonts themselves live in app/shared/terminal-theme.ts.
import { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import {
  DEFAULT_APPEARANCE, FONT_SIZE_RANGE, FONT_WEIGHT_STEP, fontLoadSpecs, fontOf, LINE_HEIGHT_RANGE, normalizeAppearance,
  TERMINAL_FONTS, TERMINAL_PRESETS, terminalFontOptions, terminalTheme, weightLabel, type TerminalAppearance,
} from '../shared/terminal-theme.ts'
import type { ColorScheme } from '../shared/theme.ts'

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
  private readonly sampleHost: HTMLElement
  private sample: Terminal | undefined
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

    for (const f of TERMINAL_FONTS) {
      const opt = document.createElement('option')
      opt.value = f.id
      opt.textContent = f.label
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
    this.font.addEventListener('change', () => this.change({ font: this.font.value as TerminalAppearance['font'] }))
    this.weight.addEventListener('input', () => { this.weightLabel.textContent = weightLabel(Number(this.weight.value)) })
    this.weight.addEventListener('change', () => this.change({ fontWeight: Number(this.weight.value) }))
    this.size.addEventListener('change', () => this.change({ fontSize: Number(this.size.value) }))
    this.lineHeight.addEventListener('input', () => { this.lineHeightLabel.textContent = Number(this.lineHeight.value).toFixed(2) })
    this.lineHeight.addEventListener('change', () => this.change({ lineHeight: Number(this.lineHeight.value) }))
    $('btn-term-theme-reset').addEventListener('click', () => this.change(DEFAULT_APPEARANCE))
    $('btn-term-theme-close').addEventListener('click', () => this.dlg.close())
    $('btn-term-theme-done').addEventListener('click', () => this.dlg.close())
    this.dlg.addEventListener('close', () => { this.sample?.dispose(); this.sample = undefined })
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
    if (this.sample) {
      applyAppearance(this.sample, a, scheme)
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
    // The same renderer the panes get (box glyphs drawn by xterm): what the sample shows is what the panes do.
    try { const webgl = new WebglAddon(true); webgl.onContextLoss(() => webgl.dispose()); term.loadAddon(webgl) } catch { /* DOM renderer */ }
    for (const line of SAMPLE_LINES) term.writeln(line)
  }

  /** The sample's xterm (tests read its options and buffer). */
  get sampleTerminal(): Terminal | undefined { return this.sample }
}
