// Which pad and owner a `tether focus <file> --pad` link opens in (app/renderer/pad-link-rules.ts).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { PAD_OF_SCOPE, planPadLink, type PadLinkWorld } from '../../app/renderer/pad-link-rules.ts'

const world: PadLinkWorld = {
  deskOf: id => ({ aaaa1111: 'desk-1', bbbb2222: 'desk-2' } as Record<string, string>)[id],
  activeDeskId: 'desk-1',
  focusablePanelId: 'bbbb2222',
}

describe('planPadLink', () => {
  test('the pad ids are the extension manifest\'s', () => {
    assert.deepEqual(PAD_OF_SCOPE, { panel: 'frame-pads.panel', desk: 'frame-pads.desk', global: 'frame-pads.global' })
  })

  test('global: no owner', () => {
    assert.deepEqual(planPadLink({ scope: 'global' }, world), { ok: true, padId: 'frame-pads.global' })
  })

  test('panel: the named pane, else the one in the Foco de Mesa', () => {
    assert.deepEqual(planPadLink({ scope: 'panel', slot: 'aaaa1111' }, world), { ok: true, padId: 'frame-pads.panel', panelId: 'aaaa1111' })
    assert.deepEqual(planPadLink({ scope: 'panel' }, world), { ok: true, padId: 'frame-pads.panel', panelId: 'bbbb2222' })
  })

  test('panel: refused for a pane outside the desks, or with nothing in focus', () => {
    assert.equal(planPadLink({ scope: 'panel', slot: 'cccc3333' }, world).ok, false)
    assert.equal(planPadLink({ scope: 'panel' }, { ...world, focusablePanelId: undefined }).ok, false)
  })

  test('desk: the desk of the named pane, else the active desk', () => {
    assert.deepEqual(planPadLink({ scope: 'desk', slot: 'bbbb2222' }, world), { ok: true, padId: 'frame-pads.desk', deskId: 'desk-2' })
    assert.deepEqual(planPadLink({ scope: 'desk', slot: 'cccc3333' }, world), { ok: true, padId: 'frame-pads.desk', deskId: 'desk-1' })
    assert.deepEqual(planPadLink({ scope: 'desk' }, world), { ok: true, padId: 'frame-pads.desk', deskId: 'desk-1' })
  })
})
