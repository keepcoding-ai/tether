// The top bar's status area as pure rules (app/renderer/status-rules.ts) and the manifest/brand contracts around it:
//   - declare (manifest half) and register (activate half): both are needed to be drawn; ids are checked;
//   - order by `order` then id; dispose of either half takes the icon back; update() tells which item changed;
//   - the badge and state views are tolerant;
//   - every status a real manifest declares is well formed; the brand is complete and the three host APIs expose it.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { badgeView, StatusRegistry, stateView, type StatusChange, type StatusItem } from '../../app/renderer/status-rules.ts'
import { BRAND } from '../../app/shared/brand.ts'
import { manifest as framePads } from '../../extensions/frame-pads/manifest.ts'
import { manifest as explorer } from '../../extensions/explorer/manifest.ts'
import { manifest as note } from '../../extensions/note/manifest.ts'
import { manifest as webBridge } from '../../extensions/web-bridge/manifest.ts'

const manifests = [framePads, explorer, note, webBridge]

const item = (id: string): StatusItem => ({ id, title: () => id, render: () => {} })
const desc = (id: string, order?: number) => ({ id, icon: 'plugs', ...(order === undefined ? {} : { order }), extension: id.split('.')[0]! })

describe('status registry', () => {
  test('an icon is drawn only with both halves, ordered by order then id', () => {
    const r = new StatusRegistry()
    r.declare(desc('b.status', 2)); r.declare(desc('a.status', 2)); r.declare(desc('c.status', 1)); r.declare(desc('d.status'))
    assert.deepEqual(r.all(), [], 'declared only: nothing to draw (extension failed to activate)')
    for (const id of ['b.status', 'a.status', 'c.status', 'd.status']) r.register(item(id))
    assert.deepEqual(r.all().map(e => e.desc.id), ['c.status', 'a.status', 'b.status', 'd.status'])
  })

  test('refuses a malformed id, a double declaration, an undeclared or double registration', () => {
    const r = new StatusRegistry()
    assert.throws(() => r.declare(desc('Bad Id')), /malformado/)
    r.declare(desc('x.status'))
    assert.throws(() => r.declare(desc('x.status')), /duas vezes/)
    assert.throws(() => r.register(item('y.status')), /não declarado/)
    r.register(item('x.status'))
    assert.throws(() => r.register(item('x.status')), /duas vezes/)
  })

  test('disposing the registration or the declaration takes the icon back (a disabled extension declares nothing)', () => {
    const r = new StatusRegistry()
    const d = r.declare(desc('x.status'))
    const h = r.register(item('x.status'))
    assert.equal(r.all().length, 1)
    h.dispose()
    assert.equal(r.all().length, 0)
    const h2 = r.register(item('x.status'))
    assert.equal(r.all().length, 1)
    d.dispose()
    assert.equal(r.all().length, 0)
    assert.throws(() => r.register(item('x.status')), /não declarado/)
    h2.update() // a stale handle is inert
  })

  test('update() names the item that changed; a list change names none; a stale handle says nothing', () => {
    const r = new StatusRegistry()
    r.declare(desc('x.status'))
    const seen: StatusChange[] = []
    r.onDidChange(c => seen.push(c))
    const h = r.register(item('x.status'))
    h.update()
    h.dispose()
    h.update()
    assert.deepEqual(seen, [{}, { id: 'x.status' }, {}])
  })
})

describe('status views', () => {
  test('badge: a count (99+), a dot, or nothing', () => {
    assert.deepEqual(badgeView(3), { text: '3', dot: false })
    assert.deepEqual(badgeView(150), { text: '99+', dot: false })
    assert.deepEqual(badgeView('dot'), { text: '', dot: true })
    for (const b of [0, -1, NaN, undefined]) assert.equal(badgeView(b), undefined)
  })

  test('state: the five states, anything else is normal', () => {
    for (const s of ['idle', 'normal', 'busy', 'warn', 'error'] as const) assert.equal(stateView(s), s)
    assert.equal(stateView(undefined), 'normal')
    assert.equal(stateView('purple' as never), 'normal')
  })
})

describe('contracts', () => {
  test('every status a manifest declares is prefixed by its extension id and well formed', () => {
    for (const m of manifests) for (const s of m.contributes?.status ?? []) {
      assert.ok(s.id.startsWith(`${m.id}.`), `${s.id} is prefixed by ${m.id}`)
      assert.ok(s.icon, `${s.id} has an icon`)
    }
  })

  test('the brand is complete and the three host APIs expose it', () => {
    assert.deepEqual(Object.keys(BRAND).sort(), ['accent', 'appId', 'icon', 'name', 'product', 'slug'])
    assert.match(BRAND.slug, /^[a-z][a-z0-9-]*$/)
    assert.match(BRAND.accent, /^#[0-9a-f]{6}$/i)
    assert.ok(BRAND.icon.startsWith('<svg') && BRAND.icon.includes('currentColor'))
    const root = join(import.meta.dirname, '..', '..')
    assert.ok(readFileSync(join(root, 'app/renderer/main.ts'), 'utf8').includes('brand: BRAND'), 'renderer')
    assert.ok(readFileSync(join(root, 'app/main/ext-host.ts'), 'utf8').includes('brand: BRAND'), 'main')
    assert.ok(readFileSync(join(root, 'src/daemon/ext-host.ts'), 'utf8').includes('brand: BRAND'), 'daemon')
  })
})
