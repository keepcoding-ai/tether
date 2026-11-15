// The terminal appearance shared by main and renderer: the preset registry, its mapping to xterm's theme and
// font options, and the tolerant parsing of what settings.json holds (unknown ids → defaults, numbers clamped).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  boldWeightOf, DEFAULT_APPEARANCE, DEFAULT_FONT_ID, DEFAULT_PRESET_ID, fontLoadSpecs, fontOf, normalizeAppearance, presetOf,
  TERMINAL_FONTS, TERMINAL_PRESETS, terminalFontOptions, terminalTheme, weightLabel,
} from '../../app/shared/terminal-theme.ts'
import { FRAME_BACKGROUND } from '../../app/shared/theme.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/
const KEYS = ['foreground', 'cursor', 'selectionBackground', 'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const

test('presets: unique ids, GitHub is the default, every colour of both schemes is a lowercase hex, each names its source', () => {
  const ids = TERMINAL_PRESETS.map(p => p.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(TERMINAL_PRESETS[0]!.id, DEFAULT_PRESET_ID)
  assert.deepEqual(ids, ['github', 'vscode', 'ubuntu', 'catppuccin', 'one', 'tokyo-night', 'tether-classic'])
  for (const p of TERMINAL_PRESETS) {
    assert.match(p.source, /https?:\/\/|panel\.ts/, `${p.id}: source`)
    assert.ok(p.license.length > 3, `${p.id}: license`)
    for (const scheme of ['light', 'dark'] as const) {
      for (const k of KEYS) assert.match(p[scheme][k], HEX, `${p.id}.${scheme}.${k}`)
      // Foreground and background must differ: the window background is what the text sits on.
      assert.notEqual(p[scheme].foreground.slice(0, 7), FRAME_BACKGROUND[scheme], `${p.id}.${scheme}: foreground equals the background`)
    }
  }
})

test('presets: a few verified upstream values (GitHub primer, VS Code registry, GNOME, Catppuccin, Tokyo Night)', () => {
  assert.equal(presetOf('github').light.yellow, '#4d2d00')
  assert.equal(presetOf('github').dark.brightWhite, '#ffffff')
  assert.equal(presetOf('vscode').light.brightRed, '#f14c4c') // light shares dark's bright red (hcLight is the one with #cd3131)
  assert.equal(presetOf('vscode').light.yellow, '#949800')
  assert.equal(presetOf('ubuntu').dark.yellow, '#a2734c')
  assert.equal(presetOf('ubuntu').light.foreground, '#171421')
  assert.equal(presetOf('catppuccin').dark.white, '#a6adc8')
  assert.equal(presetOf('catppuccin').dark.brightWhite, '#bac2de')
  assert.equal(presetOf('catppuccin').light.brightRed, '#de293e')
  assert.equal(presetOf('tokyo-night').light.black, '#b4b5b9')
  assert.equal(presetOf('tokyo-night').dark.brightGreen, '#9fe044')
  assert.equal(presetOf('tether-classic').dark.yellow, '#f5f543')
})

test('presetOf / fontOf: an unknown or missing id is the default', () => {
  assert.equal(presetOf('nope').id, DEFAULT_PRESET_ID)
  assert.equal(presetOf(undefined).id, DEFAULT_PRESET_ID)
  assert.equal(presetOf('one').id, 'one')
  assert.equal(fontOf('comic-sans').id, DEFAULT_FONT_ID)
  assert.equal(fontOf(42).id, DEFAULT_FONT_ID)
  assert.equal(fontOf('cascadia-mono').id, 'cascadia-mono')
})

test('terminalTheme: the preset colours over the frame background, cursorAccent = background, every key set', () => {
  const t = terminalTheme(DEFAULT_APPEARANCE, 'light')
  assert.equal(t.background, FRAME_BACKGROUND.light)
  assert.equal(t.cursorAccent, FRAME_BACKGROUND.light)
  assert.equal(t.red, presetOf('github').light.red)
  const d = terminalTheme({ ...DEFAULT_APPEARANCE, preset: 'catppuccin' }, 'dark')
  assert.equal(d.background, FRAME_BACKGROUND.dark)
  assert.equal(d.foreground, '#cdd6f4')
  for (const k of [...KEYS, 'background', 'cursorAccent'] as const) assert.ok(typeof d[k] === 'string' && d[k], k)
})

test('fonts: five bundled variable fonts, files and licences present, Fira Code the default', () => {
  assert.deepEqual(TERMINAL_FONTS.map(f => f.id), ['fira-code', 'jetbrains-mono', 'ubuntu-sans-mono', 'ibm-plex-mono', 'cascadia-mono'])
  assert.equal(DEFAULT_FONT_ID, 'fira-code')
  const dir = join(import.meta.dirname, '..', '..', 'app', 'renderer', 'fonts')
  for (const f of TERMINAL_FONTS) {
    assert.ok(existsSync(join(dir, f.file)), `${f.id}: ${f.file}`)
    assert.ok(f.minWeight < f.maxWeight && f.minWeight >= 100 && f.maxWeight <= 900, `${f.id}: wght axis`)
    assert.match(f.license, /OFL-1\.1|Ubuntu Font Licence/)
  }
  assert.equal(fontOf('ubuntu-sans-mono').license, 'Ubuntu Font Licence 1.0')
  for (const name of ['FiraCode-LICENSE.txt', 'JetBrainsMono-OFL.txt', 'UbuntuSansMono-LICENCE.txt', 'IBMPlexMono-LICENSE.txt', 'CascadiaMono-LICENSE.txt']) assert.ok(existsSync(join(dir, name)), name)
})

test('terminalFontOptions: family with the Windows fallbacks, bold = weight + 200 (at least 600, within the font), ligatures off, contrast 4.5', () => {
  const o = terminalFontOptions(DEFAULT_APPEARANCE)
  assert.match(o.fontFamily, /^"Fira Code", "Cascadia Mono", Consolas/)
  assert.equal(o.fontWeight, 350)
  assert.equal(o.fontWeightBold, 600)
  assert.equal(o.fontSize, 14)
  assert.equal(o.lineHeight, 1.2)
  assert.equal(o.letterSpacing, 0)
  assert.equal(o.minimumContrastRatio, 4.5)
  assert.equal(boldWeightOf(fontOf('jetbrains-mono'), 500), 700)
  assert.equal(boldWeightOf(fontOf('jetbrains-mono'), 700), 800)
  assert.equal(boldWeightOf(fontOf('cascadia-mono'), 700), 700) // the axis ends at 700
  assert.deepEqual(fontLoadSpecs(DEFAULT_APPEARANCE), ['350 14px "Fira Code"', '600 14px "Fira Code"'])
})

test('normalizeAppearance: missing, corrupt or unknown → defaults; numbers clamped to the font and the ranges', () => {
  assert.deepEqual(normalizeAppearance(undefined), DEFAULT_APPEARANCE)
  assert.deepEqual(normalizeAppearance('dark'), DEFAULT_APPEARANCE)
  assert.deepEqual(normalizeAppearance({ preset: 'solarized', font: 'fira' }), DEFAULT_APPEARANCE)
  assert.deepEqual(normalizeAppearance({ preset: 'one', font: 'ibm-plex-mono', fontWeight: 300, fontSize: 13, lineHeight: 1.1 }), { preset: 'one', font: 'ibm-plex-mono', fontWeight: 300, fontSize: 13, lineHeight: 1.1 })
  // Cascadia's axis starts at 200: a lighter saved weight is lifted; a weight past the axis is lowered.
  assert.equal(normalizeAppearance({ font: 'cascadia-mono', fontWeight: 100 }).fontWeight, 200)
  assert.equal(normalizeAppearance({ font: 'fira-code', fontWeight: 100 }).fontWeight, 300) // the Fira Code axis starts at 300
  assert.equal(normalizeAppearance({ font: 'ibm-plex-mono', fontWeight: 900 }).fontWeight, 700)
  assert.equal(normalizeAppearance({ fontWeight: 337 }).fontWeight, 325) // steps of 25
  assert.equal(normalizeAppearance({ fontSize: 3 }).fontSize, 9)
  assert.equal(normalizeAppearance({ fontSize: 99.7 }).fontSize, 28)
  assert.equal(normalizeAppearance({ fontSize: 'big' }).fontSize, 14)
  assert.equal(normalizeAppearance({ lineHeight: 0.5 }).lineHeight, 1)
  assert.equal(normalizeAppearance({ lineHeight: 1.333 }).lineHeight, 1.35)
  assert.equal(normalizeAppearance({ lineHeight: NaN }).lineHeight, 1.2)
})

test('weightLabel: named steps in Portuguese, in-between values name both neighbours', () => {
  assert.equal(weightLabel(400), '400 · normal')
  assert.equal(weightLabel(350), '350 · entre leve e normal')
  assert.equal(weightLabel(700), '700 · negrito')
})
