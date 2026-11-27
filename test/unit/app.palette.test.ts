// The desk palette (app/shared/palette.ts): 12 hues, the foreground and text rules, the generated stylesheet.
// Every pair is recomputed here with the page's own maths (WCAG relative luminance of the OKLCH colour) and must
// reach 4.5:1: the active fill with its foreground, and the inactive text on --desk-bg, in light and dark.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { contrast, deskBackground, FOREGROUND_DARK, FOREGROUND_LIGHT, hexLuminance, HUE_NAMES, HUES, hueColors, MIN_CONTRAST, oklchLuminance, paletteCss, schemeVars } from '../../app/shared/palette.ts'
import { WINDOW_BACKGROUND } from '../../app/shared/theme.ts'

const SCHEMES = ['light', 'dark'] as const

describe('palette rules', () => {
  test('12 distinct hues, the names the picker and the layout use', () => {
    assert.equal(HUE_NAMES.length, 12)
    assert.equal(new Set(HUE_NAMES).size, 12)
    assert.deepEqual(Object.keys(HUES).sort(), [...HUE_NAMES].sort())
  })

  for (const scheme of SCHEMES) {
    test(`${scheme}: every active fill/foreground pair reaches 4.5:1`, () => {
      for (const name of HUE_NAMES) {
        const c = hueColors(name, scheme)
        assert.ok(c.foreground === FOREGROUND_LIGHT || c.foreground === FOREGROUND_DARK, name)
        const ratio = contrast(oklchLuminance(c.fill), hexLuminance(c.foreground))
        assert.ok(ratio >= MIN_CONTRAST, `${scheme} ${name}: fill/foreground ${ratio.toFixed(2)}`)
        assert.equal(ratio, c.fillRatio, `${name}: the reported ratio is the real one`)
      }
    })

    test(`${scheme}: every inactive text reaches 4.5:1 on --desk-bg`, () => {
      const bg = hexLuminance(WINDOW_BACKGROUND[scheme])
      assert.equal(deskBackground(scheme), WINDOW_BACKGROUND[scheme])
      for (const name of HUE_NAMES) {
        const c = hueColors(name, scheme)
        const ratio = contrast(oklchLuminance(c.text), bg)
        assert.ok(ratio >= MIN_CONTRAST, `${scheme} ${name}: text ${ratio.toFixed(2)}`)
        assert.ok(c.text.l > 0.2 && c.text.l < 0.97, `${scheme} ${name}: the walk stayed in range`)
        assert.equal(c.text.h, HUES[name][2], 'same hue as the fill')
      }
    })
  }

  test('-deep: only the hues whose base colour cannot carry a foreground use it (blue and purple, as in the page)', () => {
    const deep = HUE_NAMES.filter(n => hueColors(n, 'dark').deep)
    assert.deepEqual(deep, ['blue', 'purple'])
    for (const name of deep) assert.ok(Math.abs(hueColors(name, 'dark').fill.l - (HUES[name][0] - 0.08)) < 1e-9, `${name}: L - 0.08`)
    for (const name of HUE_NAMES.filter(n => !deep.includes(n))) assert.equal(hueColors(name, 'dark').fill.l, HUES[name][0], `${name}: the base colour`)
  })

  test('foreground rule: fills darker than L 0.55 take white, the others near-black', () => {
    for (const name of HUE_NAMES) {
      const c = hueColors(name, 'dark')
      assert.equal(c.foreground, c.fill.l < 0.55 ? FOREGROUND_LIGHT : FOREGROUND_DARK, name)
    }
    assert.equal(hueColors('red', 'dark').foreground, FOREGROUND_DARK)
    assert.equal(hueColors('blue', 'dark').foreground, FOREGROUND_LIGHT)
  })

  test('the fill and foreground do not depend on the scheme; the text does (lighter on dark, darker on light)', () => {
    for (const name of HUE_NAMES) {
      const d = hueColors(name, 'dark'), l = hueColors(name, 'light')
      assert.deepEqual(d.fill, l.fill)
      assert.equal(d.foreground, l.foreground)
      assert.ok(d.text.l > l.text.l, `${name}: text lightness`)
    }
  })
})

describe('generated stylesheet', () => {
  const css = paletteCss()

  test('defines the three variables of every hue in both schemes', () => {
    for (const scheme of SCHEMES) {
      const vars = schemeVars(scheme)
      for (const name of HUE_NAMES) {
        assert.match(vars, new RegExp(`--x-${name}:oklch\\(\\d\\.\\d{3} \\d\\.\\d{3} \\d+\\);`), `${scheme} ${name} fill`)
        assert.match(vars, new RegExp(`--x-${name}-foreground:#[0-9a-f]{6};`), `${scheme} ${name} foreground`)
        assert.match(vars, new RegExp(`--x-${name}-text:oklch\\(\\d\\.\\d{3} \\d\\.\\d{3} \\d+\\);`), `${scheme} ${name} text`)
      }
      assert.equal(vars.split(';').filter(Boolean).length, 36)
    }
  })

  test('the same three selectors as the theme tokens: dark root, light on prefers-color-scheme and on data-theme', () => {
    assert.ok(css.startsWith('/* Generated'))
    assert.ok(css.includes(`:root{${schemeVars('dark')}}`))
    assert.ok(css.includes(`@media (prefers-color-scheme: light){:root:not([data-theme]){${schemeVars('light')}}}`))
    assert.ok(css.includes(`:root[data-theme="light"]{${schemeVars('light')}}`))
    assert.ok(css.includes(`:root[data-theme="dark"]{${schemeVars('dark')}}`))
    assert.equal((css.match(/\{/g) ?? []).length, (css.match(/\}/g) ?? []).length, 'balanced braces')
  })

  test('the first row matches the page: --x-red fill and foreground', () => {
    assert.ok(schemeVars('dark').startsWith('--x-red:oklch(0.620 0.220 25);--x-red-foreground:#10131a;--x-red-text:'), schemeVars('dark').slice(0, 120))
  })

  test('tokens.css keeps the desk background the text is checked against (one constant, two spellings)', () => {
    const styles = readFileSync(join(import.meta.dirname, '..', '..', 'app', 'renderer', 'tokens.css'), 'utf8')
    assert.ok(styles.includes(`--desk-bg: ${WINDOW_BACKGROUND.dark};`), 'dark --desk-bg')
    assert.ok(styles.includes(`--desk-bg: ${WINDOW_BACKGROUND.light};`), 'light --desk-bg')
  })
})
