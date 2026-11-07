// Features (src/core/features.ts): the declared list from the manifests (invalid and repeated ids skipped), the
// resolution profile explicit > settings.json `agents.features.<id>` > the extension's default, the settings page's node,
// and the migration that turned `extensions.web-bridge.serveToAgents` into the general switch `agents.features.bridge`.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { extensions as daemonIndex } from '../../extensions/index.daemon.ts'
import type { ExtensionManifest } from '../../extensions/types.ts'
import { manifest as webBridge } from '../../extensions/web-bridge/manifest.ts'
import { applyMigrations } from '../../app/shared/ext-migrations.ts'
import { ConfigurationRegistry } from '../../app/shared/vscode-configuration-registry.ts'
import { declaredFeatures, enabledFeatures, featureInfos, featureSettingKey, featuresConfigurationNode, generalSwitch, isFeatureMap, resolveFeature } from '../../src/core/features.ts'

const m = (id: string, features: NonNullable<ExtensionManifest['contributes']>['features']): ExtensionManifest => ({ id, version: '0.0.1', displayName: id, hosts: ['daemon'], contributes: { features } })

describe('declared features', () => {
  test('in manifest order, with the extension that declared them; an invalid or repeated id is skipped and said', () => {
    const { features, problems } = declaredFeatures([
      m('a', { bridge: { title: 'B', default: true }, 'Bad.Id': { title: 'x', default: false } }),
      m('b', { faults: { title: 'F', default: false, share: 'share' }, bridge: { title: 'again', default: false } }),
    ])
    assert.deepEqual(features.map(f => [f.id, f.ext, f.default, f.share]), [['bridge', 'a', true, undefined], ['faults', 'b', false, 'share']])
    assert.equal(problems.length, 2)
    assert.match(problems[0]!, /inválido/); assert.match(problems[1]!, /já é da extensão a/)
  })

  test('the committed daemon index declares the bridge feature, on by default, from web-bridge', () => {
    const { features, problems } = declaredFeatures(daemonIndex.map(e => e.manifest))
    assert.deepEqual(problems, [])
    const bridge = features.find(f => f.id === 'bridge')
    assert.ok(bridge); assert.equal(bridge.ext, 'web-bridge'); assert.equal(bridge.default, true)
    assert.match(bridge.title, /Tether Bridge para os agentes/)
  })
})

describe('resolution: profile explicit > general > default', () => {
  const on = { id: 'bridge', default: true }
  const off = { id: 'faults', default: false }
  test('nothing said: the default', () => {
    assert.equal(resolveFeature(on, {}), true)
    assert.equal(resolveFeature(off, {}), false)
    assert.equal(resolveFeature(on, undefined, {}), true)
  })
  test('the general switch beats the default; a non-boolean reads as unsaid', () => {
    assert.equal(resolveFeature(on, { agents: { features: { bridge: false } } }), false)
    assert.equal(resolveFeature(off, { agents: { features: { faults: true } } }), true)
    assert.equal(resolveFeature(on, { agents: { features: { bridge: 'no' } } }), true)
    assert.equal(generalSwitch({ agents: [] }, 'bridge'), undefined)
    assert.equal(generalSwitch({ agents: { features: null } }, 'bridge'), undefined)
  })
  test('the profile beats both; a profile that does not name the feature inherits', () => {
    const settings = { agents: { features: { bridge: false, faults: true } } }
    assert.equal(resolveFeature(on, settings, { bridge: true }), true)
    assert.equal(resolveFeature(off, settings, { faults: false }), false)
    assert.equal(resolveFeature(on, settings, { faults: false }), false, 'bridge not named: general')
  })
  test('enabledFeatures: the ids on, sorted', () => {
    const list = [{ id: 'zeta', default: true }, on, off]
    assert.deepEqual(enabledFeatures(list, {}), ['bridge', 'zeta'])
    assert.deepEqual(enabledFeatures(list, { agents: { features: { faults: true } } }, { zeta: false }), ['bridge', 'faults'])
  })
  test('featureInfos carries the general switch in force', () => {
    const { features } = declaredFeatures([m('a', { bridge: { title: 'B', description: 'd', default: true } })])
    assert.deepEqual(featureInfos(features, { agents: { features: { bridge: false } } }), [{ id: 'bridge', title: 'B', description: 'd', default: true, general: false }])
  })
  test('isFeatureMap: booleans only', () => {
    assert.equal(isFeatureMap({ a: true, b: false }), true)
    assert.equal(isFeatureMap({ a: 'yes' }), false)
    assert.equal(isFeatureMap([]), false)
  })
})

describe('the settings node', () => {
  test('agents.features.<id> booleans with the declared default, readable through the registry', () => {
    const { features } = declaredFeatures([webBridge])
    const reg = new ConfigurationRegistry()
    reg.registerConfiguration(featuresConfigurationNode(features))
    assert.deepEqual(reg.properties().map(p => p.key), [featureSettingKey('bridge')])
    assert.equal(reg.schemaAt('agents.features.bridge')?.type, 'boolean')
    assert.equal(reg.readAt({}, 'agents.features.bridge'), true)
    assert.equal(reg.readAt({ agents: { features: { bridge: false } } }, 'agents.features.bridge'), false)
    assert.equal(reg.getConfigurationNodes()[0]!.title, 'Agentes')
  })
})

describe('migration: serveToAgents → agents.features.bridge', () => {
  test('an explicit value moves, the old key goes (and its emptied parents)', () => {
    const { file, moved } = applyMigrations({ extensions: { disabled: [], 'web-bridge': { serveToAgents: false } } }, [webBridge])
    assert.deepEqual(file, { extensions: { disabled: [] }, agents: { features: { bridge: false } } })
    assert.deepEqual(moved, ['extensions.web-bridge.serveToAgents → agents.features.bridge'])
  })
  test('a value already at the destination wins; the old key goes anyway', () => {
    const { file } = applyMigrations({ extensions: { 'web-bridge': { serveToAgents: false, agentWindows: true } }, agents: { features: { bridge: true } } }, [webBridge])
    assert.deepEqual(file, { extensions: { 'web-bridge': { agentWindows: true } }, agents: { features: { bridge: true } } })
  })
  test('a non-boolean old value is dropped (it read as the default before); nothing to move: nothing changes', () => {
    assert.deepEqual(applyMigrations({ extensions: { 'web-bridge': { serveToAgents: 'x' } } }, [webBridge]).file, {})
    const same = { theme: 'dark' }
    const r = applyMigrations(same, [webBridge])
    assert.equal(r.file, same); assert.deepEqual(r.moved, [])
  })
  test('the old setting is no longer in the manifest', () => {
    assert.equal(webBridge.contributes?.settings?.serveToAgents, undefined)
  })
})
