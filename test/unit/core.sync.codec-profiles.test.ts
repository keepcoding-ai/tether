import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Profile } from '../../src/core/profile.ts'
import { exportProfiles, importProfiles } from '../../src/core/sync/codecs/profiles.ts'

const WIN = { platform: 'win32', homedir: 'C:\\Users\\Ana' } as const
const NIX = { platform: 'linux', homedir: '/home/ana' } as const
const WIN_MAP = { atrium: 'C:\\atrium' }
const NIX_MAP = { atrium: '/srv/atrium' }

const SECRET = 'sk-super-secret-value'

function sample(): Profile[] {
  return [
    { id: 'claude', name: 'Claude', agent: 'claude', args: ['--model', 'opus'], env: { API_TOKEN: SECRET, CLAUDE_CONFIG_DIR: 'C:\\cfg' }, cwd: 'C:\\atrium\\workspace\\x', default: true, extensions: { browser: { serveToAgents: true } } },
    { id: 'powershell', name: 'PowerShell', agent: 'shell', args: [], shell: { command: 'C:\\Windows\\System32\\pwsh.exe', args: ['-NoLogo'] }, default: true },
    { id: 'pwsh', name: 'Pwsh', agent: 'shell', args: ['-x'], shell: { command: 'pwsh', args: ['-NoLogo'] }, cwd: 'C:\\Users\\Ana\\proj' },
  ]
}

describe('profiles codec', () => {
  test('round trip on the same machine returns the same profiles', () => {
    const profiles = sample()
    const ex = exportProfiles(profiles, WIN_MAP, WIN)
    const back = importProfiles(ex.entities, profiles, ex.map, WIN)
    assert.deepEqual(back.profiles, profiles)
    assert.deepEqual(back.missingEnv, {})
    assert.deepEqual(back.unmappedPlaces, [])
    assert.deepEqual(back.skipped, [])
  })

  test('no env value and no absolute path in the entities', () => {
    const text = JSON.stringify(exportProfiles(sample(), WIN_MAP, WIN).entities)
    assert.ok(!text.includes(SECRET))
    assert.ok(!text.includes('C:\\\\cfg'))
    assert.ok(text.includes('API_TOKEN'))
    assert.ok(!/[A-Za-z]:\\\\/.test(text), text)
    assert.ok(!text.includes('Windows'))
  })

  test('relative shell travels whole; absolute shell sets shellLocal', () => {
    const ents = exportProfiles(sample(), WIN_MAP, WIN).entities.profiles as Record<string, Record<string, unknown>>
    assert.deepEqual(ents.pwsh!.shell, { command: 'pwsh', args: ['-NoLogo'] })
    assert.equal(ents.pwsh!.shellLocal, undefined)
    assert.equal(ents.powershell!.shell, undefined)
    assert.equal(ents.powershell!.shellLocal, true)
  })

  test('optional fields stay absent and the order is recorded', () => {
    const ex = exportProfiles([{ id: 'a', name: 'A', agent: 'shell', args: [] }], {}, WIN)
    assert.deepEqual(ex.entities.profiles!.a, { id: 'a', name: 'A', agent: 'shell', args: [] })
    assert.deepEqual(ex.entities['profiles.meta'], { order: { ids: ['a'] } })
  })

  test('two machines: cwd resolves into the second machine folder', () => {
    const ex = exportProfiles(sample(), WIN_MAP, WIN)
    const back = importProfiles(ex.entities, [], NIX_MAP, NIX)
    const claude = back.profiles.find((p) => p.id === 'claude')!
    assert.equal(claude.cwd, '/srv/atrium/workspace/x')
    assert.equal(back.profiles.find((p) => p.id === 'pwsh')!.cwd, '/home/ana/proj')
  })

  test('missingEnv and unmappedPlaces', () => {
    const ex = exportProfiles(sample(), WIN_MAP, WIN)
    const local: Profile[] = [{ id: 'claude', name: 'Claude', agent: 'claude', args: [], env: { API_TOKEN: 'mine' } }]
    const back = importProfiles(ex.entities, local, {}, NIX)
    assert.deepEqual(back.missingEnv, { claude: ['CLAUDE_CONFIG_DIR'] })
    assert.deepEqual(back.profiles.find((p) => p.id === 'claude')!.env, { API_TOKEN: 'mine' })
    assert.deepEqual(back.unmappedPlaces, ['atrium'])
    assert.equal(back.profiles.find((p) => p.id === 'claude')!.cwd, undefined)
    // no value at all: no env
    const bare = importProfiles(ex.entities, [], NIX_MAP, NIX)
    assert.equal(bare.profiles.find((p) => p.id === 'claude')!.env, undefined)
    assert.deepEqual(bare.missingEnv.claude, ['API_TOKEN', 'CLAUDE_CONFIG_DIR'])
  })

  test('shellLocal takes the local shell, or none without a local profile', () => {
    const ex = exportProfiles(sample(), WIN_MAP, WIN)
    const local: Profile[] = [{ id: 'powershell', name: 'x', agent: 'shell', args: [], shell: { command: '/bin/zsh', args: [] } }]
    assert.deepEqual(importProfiles(ex.entities, local, NIX_MAP, NIX).profiles.find((p) => p.id === 'powershell')!.shell, { command: '/bin/zsh', args: [] })
    assert.equal(importProfiles(ex.entities, [], NIX_MAP, NIX).profiles.find((p) => p.id === 'powershell')!.shell, undefined)
  })

  test('the persistent folder rules set and order; local-only profiles go', () => {
    const ex = exportProfiles(sample(), WIN_MAP, WIN)
    ex.entities['profiles.meta'] = { order: { ids: ['pwsh', 'claude'] } }
    const local: Profile[] = [...sample(), { id: 'only-here', name: 'Here', agent: 'shell', args: [] }]
    const back = importProfiles(ex.entities, local, ex.map, WIN)
    assert.deepEqual(back.profiles.map((p) => p.id), ['pwsh', 'claude', 'powershell'])
  })

  test('invalid id is skipped on export', () => {
    const ex = exportProfiles([{ id: 'Bad Id', name: 'B', agent: 'shell', args: [] }, { id: 'ok', name: 'O', agent: 'shell', args: [] }], {}, WIN)
    assert.deepEqual(ex.skipped, ['Bad Id'])
    assert.deepEqual(Object.keys(ex.entities.profiles!), ['ok'])
    assert.deepEqual(ex.entities['profiles.meta'], { order: { ids: ['ok'] } })
  })

  test('malformed entity is ignored on import', () => {
    const ents = {
      profiles: { good: { id: 'good', name: 'G', agent: 'shell', args: [] }, bad: { id: 'bad', name: 3 }, nope: 'text', wrong: { id: 'other', name: 'W', agent: 'shell', args: [] } },
    }
    const back = importProfiles(ents, [], {}, NIX)
    assert.deepEqual(back.profiles.map((p) => p.id), ['good'])
    assert.deepEqual(back.skipped, ['bad', 'nope', 'wrong'])
  })

  test('two defaults of the same agent keep the first in order', () => {
    const ents = {
      profiles: {
        a: { id: 'a', name: 'A', agent: 'shell', args: [], default: true },
        b: { id: 'b', name: 'B', agent: 'shell', args: [], default: true },
      },
      'profiles.meta': { order: { ids: ['b', 'a'] } },
    }
    const back = importProfiles(ents, [], {}, NIX)
    assert.deepEqual(back.profiles.map((p) => [p.id, p.default]), [['b', true], ['a', undefined]])
  })

  test('export does not mutate the map it received', () => {
    const map = { ...WIN_MAP }
    const ex = exportProfiles([{ id: 'n', name: 'N', agent: 'shell', args: [], cwd: 'D:\\other\\folder' }], map, WIN)
    assert.deepEqual(map, WIN_MAP)
    assert.deepEqual(ex.map, { ...WIN_MAP, folder: 'D:\\other\\folder' })
    assert.deepEqual((ex.entities.profiles!.n as { cwd: unknown }).cwd, { place: 'folder', rel: '' })
  })
})
