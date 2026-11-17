// brand/brand.json, the one source of the product's identity (F7 T1, f7-bridge-marca §3):
//   - it is valid against brand/brand.schema.json (the Atrium Bridge's schema, copied here), checked by a small
//     structural validator of the JSON Schema subset that file uses: zod never runs inside the tether (zero runtime deps);
//   - the public key still yields the extension id the installs are pinned to (sha256 of the DER key → a–p);
//   - app/shared/brand.ts derives the app's identity from it (name = shortName, appId = host.id, slug, accent);
//   - the colours come from the SVGs (ink = the mask's fill; paper is the creative's background);
//   - brand/assets/app/mask.json is in step with brand/src/light/mask.svg and is the 24x24 currentColor monogram;
//   - the schema copy is strict and the file points at it.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BRAND } from '../../app/shared/brand.ts'
import { maskAsset, maskIcon, MASK_ASSET, MASK_SOURCE } from '../../app/brand-mask.ts'
import { VENDOR_BUILD_INFO } from '../../extensions/web-bridge/vendor-rules.ts'

const root = resolve(import.meta.dirname, '..', '..')
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')
const brand = JSON.parse(read('brand/brand.json')) as Record<string, unknown>
const schema = JSON.parse(read('brand/brand.schema.json')) as Schema

/** The id Chrome gives an extension whose manifest carries this public key. */
const EXPECTED_EXTENSION_ID = 'injmgjkjjfjeamlnnpacjcfnfkjgpmnk'
function extensionIdOf(spkiBase64: string): string {
  const hex = createHash('sha256').update(Buffer.from(spkiBase64, 'base64')).digest('hex').slice(0, 32)
  return [...hex].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('')
}

// ---- a validator for the subset of JSON Schema 2020-12 that brand.schema.json uses ----
type Schema = {
  type?: string; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean
  pattern?: string; minLength?: number; maxLength?: number; enum?: unknown[]; format?: string; default?: unknown
}
function validate(value: unknown, s: Schema, path: string, out: string[]): void {
  const at = path || '(raiz)'
  if (s.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) { out.push(`${at}: esperado objeto`); return }
    const obj = value as Record<string, unknown>
    for (const key of s.required ?? []) if (!(key in obj)) out.push(`${path ? `${path}.` : ''}${key}: obrigatório`)
    for (const [key, v] of Object.entries(obj)) {
      const sub = s.properties?.[key]
      if (!sub) { if (s.additionalProperties === false) out.push(`${path ? `${path}.` : ''}${key}: campo desconhecido`); continue }
      validate(v, sub, path ? `${path}.${key}` : key, out)
    }
    return
  }
  if (s.type === 'string') {
    if (typeof value !== 'string') { out.push(`${at}: esperado texto`); return }
    if (s.minLength !== undefined && value.length < s.minLength) out.push(`${at}: menor que ${s.minLength}`)
    if (s.maxLength !== undefined && value.length > s.maxLength) out.push(`${at}: maior que ${s.maxLength}`)
    if (s.pattern !== undefined && !new RegExp(s.pattern).test(value)) out.push(`${at}: fora do padrão ${s.pattern}`)
    if (s.enum && !s.enum.includes(value)) out.push(`${at}: fora de ${s.enum.join(', ')}`)
    if (s.format === 'uri') { try { new URL(value) } catch { out.push(`${at}: URL inválida`) } }
    return
  }
  if (s.type === 'boolean') { if (typeof value !== 'boolean') out.push(`${at}: esperado booleano`); return }
  out.push(`${at}: tipo de schema não suportado pelo teste (${s.type})`)
}
const problems = (value: unknown): string[] => { const out: string[] = []; validate(value, schema, '', out); return out }

describe('brand/brand.json', () => {
  test('is valid against brand/brand.schema.json', () => {
    assert.deepEqual(problems(brand), [])
  })

  test('the validator does catch what the bridge would refuse (so a green run means something)', () => {
    const bad = structuredClone(brand) as Record<string, unknown> & { extension: Record<string, unknown>; tabs: Record<string, unknown>; colors: Record<string, unknown> }
    bad.slug = 'Tether'
    bad.extension.key = 'short'
    bad.tabs.groupColor = 'magenta'
    bad.colors.accent = 'blue'
    bad.unknown = 1
    delete bad.name
    const out = problems(bad)
    for (const needle of ['slug: fora do padrão', 'extension.key: menor que 200', 'tabs.groupColor: fora de', 'colors.accent: fora do padrão', 'unknown: campo desconhecido', 'name: obrigatório']) {
      assert.ok(out.some(p => p.startsWith(needle)), `${needle} in ${out.join(' | ')}`)
    }
  })

  test('the schema copy is strict at every level and the file points at it', () => {
    assert.equal(schema.additionalProperties, false)
    for (const [k, s] of Object.entries(schema.properties ?? {})) if (s.type === 'object') assert.equal(s.additionalProperties, false, k)
    assert.equal(brand.$schema, './brand.schema.json')
    assert.ok(existsSync(join(root, 'brand', 'brand.schema.json')))
  })

  test('names the Tether Bridge, its host and its MCP server as the extension expects', () => {
    assert.equal(brand.slug, 'tether')
    assert.equal(brand.name, 'Tether Bridge')
    assert.equal(brand.shortName, 'Tether')
    assert.deepEqual(brand.host, { name: 'tether', id: 'studio.codr.tether' })
    assert.deepEqual(brand.mcp, { serverName: 'tether-bridge' })
    assert.equal((brand.extension as { locale: string }).locale, 'pt-BR')
    // Defaults the installer seeds into the bridge home agree with the extension's own settings (manifest.ts).
    assert.deepEqual(brand.capabilities, { evaluate: 'own-tabs', download: true, upload: true, pdf: true, readNetwork: true, windowPerAgent: false })
    assert.deepEqual(brand.tabs, { groupTitle: '{shortName}', agentTitle: '{shortName} · {agent}', groupColor: 'blue' })
    assert.deepEqual(brand.assets, { src: './src', out: './assets/bridge' })
  })

  test('the public key keeps the extension id the installs are pinned to', () => {
    const key = (brand.extension as { key: string }).key
    assert.equal(extensionIdOf(key), EXPECTED_EXTENSION_ID)
    const info = JSON.parse(read(`extensions/web-bridge/vendor/${VENDOR_BUILD_INFO}`)) as { extensionId?: string }
    assert.equal(info.extensionId, EXPECTED_EXTENSION_ID, 'the vendored build carries the same id')
  })

  test('its colours are the SVGs\' colours: ink is the mask fill, paper the creative background', () => {
    const colors = brand.colors as { accent: string; light: { ink: string; paper: string }; dark: { ink: string; paper: string } }
    for (const theme of ['light', 'dark'] as const) {
      const fills = [...read(`brand/src/${theme}/mask.svg`).matchAll(/fill="(#[0-9a-fA-F]{6})"/g)].map(m => m[1]!.toLowerCase())
      assert.ok(fills.length > 0 && fills.every(f => f === colors[theme].ink), `${theme} ink ${colors[theme].ink} = mask fills ${[...new Set(fills)].join(',')}`)
      assert.ok(read(`brand/src/${theme}/creative.svg`).toLowerCase().includes(`fill="${colors[theme].paper}"`), `${theme} paper in creative.svg`)
      assert.ok(read(`brand/src/${theme}/logo.svg`).toLowerCase().includes(`fill="${colors.accent}"`), `${theme} accent in logo.svg`)
    }
  })
})

describe('app/shared/brand.ts', () => {
  test('derives the app identity from brand.json: short name, host id, slug, accent', () => {
    assert.equal(BRAND.name, 'Tether')
    assert.equal(BRAND.product, 'Tether Bridge')
    assert.equal(BRAND.product, brand.name)
    assert.equal(BRAND.slug, brand.slug)
    assert.equal(BRAND.appId, (brand.host as { id: string }).id)
    assert.equal(BRAND.accent, (brand.colors as { accent: string }).accent)
    assert.ok(Object.isFrozen(BRAND))
  })

  test('the icon is the committed monogram, derived from brand/src/light/mask.svg and in step with it', () => {
    const svg = read(MASK_SOURCE)
    const committed = JSON.parse(read(MASK_ASSET)) as { source: string; sha256: string; icon: string }
    assert.deepEqual(committed, maskAsset(svg), `${MASK_ASSET} is older than ${MASK_SOURCE}: run npm run brand:derive and commit it`)
    assert.equal(BRAND.icon, committed.icon)
    assert.ok(BRAND.icon.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">'))
    assert.doesNotMatch(BRAND.icon, /#[0-9a-fA-F]{3,8}\b/, 'no hard-coded colour')
    assert.doesNotMatch(BRAND.icon, /\bid=|<title|<desc|<\?xml/, 'no ids, title, desc or prolog (it is inlined in the DOM)')
    assert.doesNotMatch(BRAND.icon, />\s+</, 'compact')
  })

  test('maskIcon fits the drawing tight and centred; recolours fills and styles; falls back to the viewBox for paths', () => {
    const tight = maskIcon('<svg viewBox="0 0 100 100"><g id="brand"><rect x="10" y="40" width="80" height="20" fill="#123456"/></g></svg>')
    assert.match(tight, /translate\(-3 -3\) scale\(0\.3\)/) // 80 wide → 24: scale .3; x: -10*.3; y: (24-6)/2 - 40*.3 = -3
    assert.ok(tight.includes('fill="currentColor"') && !tight.includes('#123456'))
    const styled = maskIcon('<svg viewBox="0 0 10 10"><path d="M0 0h10v10z" style="fill:#000;stroke:none"/></svg>')
    assert.match(styled, /translate\(0 0\) scale\(2\.4\)/) // a path: the viewBox is the box
    assert.ok(styled.includes('style="fill:currentColor;stroke:none"'))
    assert.throws(() => maskIcon('<svg><rect width="1" height="1"/></svg>'), /viewBox/)
  })
})
