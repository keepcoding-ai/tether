// Profile.features (src/core/profile.ts): an optional map feature → boolean, validated (shape, ids, no features on a shell,
// a warning for an id no extension declares), kept by the normalizer, read by a v:1 file and absent ones unchanged; and
// the round trip over tetherd's protocol (profile-save → the `profiles` reply and profiles.json → profiles-list); and the
// server handing the slot's current profile's switches to the launch (DaemonOptions.transformPlan).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import type { AgentAdapter } from '../../src/agents/types.ts'
import { isProfile, parseProfilesFile, profilesPath, upsertProfile, validateProfile, type Profile } from '../../src/core/profile.ts'
import { DaemonError } from '../../src/daemon/client.ts'
import { startDaemon, type Daemon } from '../../src/daemon/server.ts'
import { Recorder, removeHome, tempHome, uniquePipe } from './daemon.helpers.ts'

describe('Profile.features: validation and normalization', () => {
  test('a map of booleans for a known feature is valid; the normalizer keeps it', () => {
    const v = validateProfile({ name: 'Sem ponte', agent: 'claude', args: [], features: { bridge: false } })
    assert.deepEqual(v, { errors: [], warnings: [] })
    const { profile } = upsertProfile([], { name: 'Sem ponte', agent: 'claude', args: [], features: { bridge: false } })
    assert.deepEqual(profile.features, { bridge: false })
  })
  test('an empty map is dropped; no field means inherit everything', () => {
    assert.equal(upsertProfile([], { name: 'X', agent: 'claude', args: [], features: {} }).profile.features, undefined)
    assert.equal(upsertProfile([], { name: 'X', agent: 'claude', args: [] }).profile.features, undefined)
  })
  test('shape and ids: non-boolean values, malformed ids and features on a shell are errors; an unknown id is a warning', () => {
    assert.match(validateProfile({ name: 'X', agent: 'claude', args: [], features: { bridge: 'yes' as unknown as boolean } }).errors.join('\n'), /mapa de feature/)
    assert.match(validateProfile({ name: 'X', agent: 'claude', args: [], features: { 'Bad.Id': true } }).errors.join('\n'), /feature inválida/)
    assert.match(validateProfile({ name: 'X', agent: 'shell', args: [], features: { bridge: true } }).errors.join('\n'), /só vale para perfis de agente/)
    const unknown = validateProfile({ name: 'X', agent: 'soul', args: [], features: { someday: true } })
    assert.deepEqual(unknown.errors, [])
    assert.match(unknown.warnings[0]!, /someday não é declarada/)
  })
  test('the file stays v:1: features are read back; a malformed features field skips that entry only', () => {
    const good: Profile = { id: 'p', name: 'P', agent: 'claude', args: [], features: { bridge: true } }
    assert.ok(isProfile(good))
    const parsed = parseProfilesFile(JSON.stringify({ v: 1, profiles: [good, { ...good, id: 'q', name: 'Q', features: { bridge: 1 } }, { id: 'r', name: 'R', agent: 'soul', args: [] }] }))
    assert.ok(parsed.ok)
    if (parsed.ok) {
      assert.deepEqual(parsed.profiles.map(p => [p.id, p.features]), [['p', { bridge: true }], ['r', undefined]])
      assert.equal(parsed.skipped, 1)
    }
  })
})

describe('Profile.features over the protocol', () => {
  let home: string
  let daemon: Daemon
  before(async () => { home = tempHome(); daemon = await startDaemon({ home, pipe: uniquePipe(home) }) })
  after(async () => { await daemon.close(); await removeHome(home) })

  test('profile-save keeps features; profiles-list and profiles.json carry them; an edit back to inherit drops them', async () => {
    const c = await Recorder.connect(daemon.pipe)
    try {
      const saved = await c.client.request({ t: 'profile-save', profile: { name: 'Claude sem ponte', agent: 'claude', args: [], features: { bridge: false } } })
      assert.deepEqual(saved.profile!.features, { bridge: false })
      const { profiles } = await c.client.request({ t: 'profiles-list' })
      assert.deepEqual(profiles!.find(p => p.id === saved.profile!.id)!.features, { bridge: false })
      const file = JSON.parse(readFileSync(profilesPath(home), 'utf8')) as { v: number; profiles: Profile[] }
      assert.equal(file.v, 1)
      assert.deepEqual(file.profiles.find(p => p.id === saved.profile!.id)!.features, { bridge: false })
      const edited = await c.client.request({ t: 'profile-save', profile: { id: saved.profile!.id, name: 'Claude sem ponte', agent: 'claude', args: [] } })
      assert.equal(edited.profile!.features, undefined)
      await assert.rejects(
        c.client.request({ t: 'profile-save', profile: { name: 'Ruim', agent: 'claude', args: [], features: { bridge: 'x' as unknown as boolean } } }),
        (e: DaemonError) => e.code === 'invalid-profile' && /features/.test(e.message),
      )
    } finally { c.close() }
  })
})

describe('the launch carries the slot profile\'s features to transformPlan', () => {
  test('a slot of a profile with features: transformPlan gets them; without a profile: none', async () => {
    const home = tempHome()
    const seen: Array<Readonly<Record<string, boolean>> | undefined> = []
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    const inert: AgentAdapter = { name: 'claude', plan: input => ({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: input.slot.cwd, env }), sessionExists: async () => true, title: async () => undefined }
    const d = await startDaemon({ home, pipe: uniquePipe(home), adapters: { claude: inert }, readyFallbackMs: 60_000, minAgentAgeMs: 0, transformPlan: (plan, _meta, info) => { seen.push(info?.profileFeatures); return plan } })
    const c = await Recorder.connect(d.pipe)
    try {
      const { profile } = await c.client.request({ t: 'profile-save', profile: { name: 'Sem ponte', agent: 'claude', args: [], features: { bridge: false } } })
      const a = await c.client.request({ t: 'create', kind: 'claude', cwd: home, profileId: profile!.id, start: true })
      const b = await c.client.request({ t: 'create', kind: 'claude', cwd: home, start: true })
      assert.deepEqual(seen, [{ bridge: false }, undefined])
      await c.client.request({ t: 'stop', slotId: a.slot!.slotId })
      await c.client.request({ t: 'stop', slotId: b.slot!.slotId })
    } finally { c.close(); await d.close(); await removeHome(home) }
  })
})
