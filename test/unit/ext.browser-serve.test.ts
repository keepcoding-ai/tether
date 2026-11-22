// Who gets the browser (serveToAgents: perProfile | all | off, plus the profile's mark), through the daemon entry's own
// decision (extensions/browser/daemon.ts serveFor) and the profile field that carries it.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import '../../extensions/index.daemon.ts'
import { serveFor, serveMode } from '../../extensions/browser/daemon.ts'
import { offHelpFor, serveModeOf, servesAgent } from '../../extensions/browser/rules.ts'
import { upsertProfile, isProfile, validateProfile, profileOption, type Profile } from '../../src/core/profile.ts'

const profile = (id: string, browser?: unknown): Profile => ({ id, name: id, agent: 'claude', args: [], ...(browser === undefined ? {} : { extensions: { browser: { serve: browser } } }) })
const profiles = [profile('marked', true), profile('unmarked'), profile('off-flag', false)]
const api = (serveToAgents?: unknown) => ({
  settings: { get: <T,>(key: string) => (key === 'extensions' && serveToAgents !== undefined ? ({ browser: { serveToAgents } } as T) : undefined) },
  profiles: { get: (id: string) => profiles.find(p => p.id === id), defaultFor: () => undefined },
})
const marked = { profileId: 'marked' }
const unmarked = { profileId: 'unmarked' }
const none = {}

describe('serveFor: the three modes against a marked profile, an unmarked one and no profile', () => {
  test('perProfile (also the default): only the marked profile', () => {
    for (const a of [api('perProfile'), api(undefined), api('garbage')]) {
      assert.equal(serveFor(a, marked), true)
      assert.equal(serveFor(a, unmarked), false)
      assert.equal(serveFor(a, { profileId: 'off-flag' }), false)
      assert.equal(serveFor(a, none), false)
      assert.equal(serveFor(a, { profileId: 'gone' }), false, 'a deleted profile carries no mark')
    }
  })
  test('all: everyone, profile or not', () => {
    const a = api('all')
    for (const s of [marked, unmarked, none]) assert.equal(serveFor(a, s), true)
  })
  test('off: no one, even a marked profile', () => {
    const a = api('off')
    for (const s of [marked, unmarked, none]) assert.equal(serveFor(a, s), false)
  })
})

describe('migration of the old boolean', () => {
  test('true is all; false, absent and junk are perProfile', () => {
    assert.equal(serveModeOf(true), 'all')
    assert.equal(serveModeOf(false), 'perProfile')
    assert.equal(serveModeOf(undefined), 'perProfile')
    assert.equal(serveModeOf(1), 'perProfile')
    assert.equal(serveMode(api(true)), 'all')
    assert.equal(serveMode(api(false)), 'perProfile')
    assert.equal(serveFor(api(true), none), true, 'a user who had it on keeps serving agents without a profile')
  })
  test('the pure rule', () => {
    assert.equal(servesAgent('perProfile', true), true)
    assert.equal(servesAgent('perProfile', false), false)
    assert.equal(servesAgent('all', false), true)
    assert.equal(servesAgent('off', true), false)
    assert.equal(offHelpFor('all'), undefined)
    assert.match(offHelpFor('off')!, /desligado/)
    assert.match(offHelpFor('perProfile')!, /perfil marcado/)
  })
})

describe('the profile field `extensions`', () => {
  test('is validated, stored, read by extension id and dropped when empty', () => {
    const input = { name: 'Com navegador', agent: 'claude' as const, args: [], extensions: { browser: { serve: true }, empty: {} } }
    assert.deepEqual(validateProfile(input).errors, [])
    const { profile: saved } = upsertProfile([], input)
    assert.deepEqual(saved.extensions, { browser: { serve: true } })
    assert.equal(profileOption(saved, 'browser', 'serve'), true)
    assert.equal(profileOption(saved, 'other', 'serve'), undefined)
    assert.equal(isProfile(JSON.parse(JSON.stringify(saved))), true)
    assert.equal(upsertProfile([], { name: 'x', agent: 'claude', args: [] }).profile.extensions, undefined)
    assert.ok(validateProfile({ ...input, extensions: { browser: 'yes' } as never }).errors.length > 0)
    assert.equal(isProfile({ ...saved, extensions: [] }), false)
  })
})
