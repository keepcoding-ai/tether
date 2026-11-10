// `tether usage`: Claude plan usage (src/usage, src/cli/usage.ts). Fetch, clock and macOS `security` are simulated.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { cmdUsage } from '../../src/cli/usage.ts'
import { KEYCHAIN_SERVICE, readClaudeToken, type CredentialDeps } from '../../src/usage/claude-credential.ts'
import { normalize, readClaudeUsage, type UsageDeps, type UsageFailure, type UsageReport } from '../../src/usage/claude.ts'

const SECRET = 'sk-ant-oat01-SECRET-TOKEN-VALUE-1234567890'
const NOW = Date.parse('2026-11-10T12:00:00Z')
const dirs: string[] = []
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'tether-usage-')); dirs.push(d); return d }
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const BODY = {
  five_hour: null,
  seven_day: { utilization: 42.5, resets_at: '2026-11-14T12:00:00Z' },
  seven_day_opus: { utilization: 10, resets_at: '2026-11-14T12:00:00Z' },
  extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1250, utilization: 25, currency: 'USD' },
  brand_new_thing: { foo: 1 },
}
const reply = (status: number, body: unknown, headers: Record<string, string> = {}): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status, headers })) as typeof fetch

function deps(f: typeof fetch, cacheFile = join(tmp(), 'c.json'), token = async () => SECRET): UsageDeps {
  return { token, fetch: f, now: () => NOW, cacheFile }
}
const ok = (r: UsageReport | UsageFailure): UsageReport => { assert.equal(r.state, 'ok', JSON.stringify(r)); return r as UsageReport }

function credDeps(over: Partial<CredentialDeps>): CredentialDeps {
  return { env: {}, platform: 'linux', home: tmp(), now: NOW, security: async () => { throw new Error('unexpected') }, ...over }
}
const credJson = (extra: object = {}): string => JSON.stringify({ claudeAiOauth: { accessToken: SECRET, expiresAt: NOW + 3_600_000, ...extra } })

describe('usage: normalize and report', () => {
  test('limits, windows not computed, extra credits and new fields', async () => {
    const r = ok(await readClaudeUsage(deps(reply(200, BODY))))
    assert.deepEqual(r.notComputed, ['five_hour'])
    assert.deepEqual(r.newFields, ['brand_new_thing'])
    assert.equal(r.limits.length, 2)
    assert.equal(r.limits[0]!.percent, 42.5)
    assert.equal(r.limits[0]!.resetsIn, 'em 4d')
    assert.equal(r.extraUsage?.usedCredits, 1250)
    assert.equal(r.source, 'live')
  })

  test('the limits[] list absorbs the top-level window it already represents', () => {
    const m = normalize({
      limits: [{ kind: 'seven_day', group: 'weekly_all', percent: 30, resets_at: '2026-11-14T12:00:00Z' }],
      seven_day: { utilization: 30, resets_at: '2026-11-14T12:00:00Z' },
    })
    assert.equal(m.limits.length, 1)
    assert.equal(m.limits[0]!.label, 'Semana · todos os modelos')
  })

  test('nothing recognizable is "format-changed", not made-up numbers', async () => {
    const r = await readClaudeUsage(deps(reply(200, { surprise: 'x' })))
    assert.equal(r.state, 'format-changed')
  })

  test('cache: a fresh reading is reused; --fresh and old readings ask again', async () => {
    const cacheFile = join(tmp(), 'c.json')
    let calls = 0
    const f = (async () => { calls++; return new Response(JSON.stringify(BODY)) }) as typeof fetch
    ok(await readClaudeUsage(deps(f, cacheFile)))
    assert.equal(ok(await readClaudeUsage(deps(f, cacheFile))).source, 'cache')
    assert.equal(calls, 1)
    ok(await readClaudeUsage(deps(f, cacheFile), { fresh: true }))
    assert.equal(calls, 2)
  })

  test('HTTP 429 with a cache falls back to it and says so; without a cache it is a network failure', async () => {
    const cacheFile = join(tmp(), 'c.json')
    ok(await readClaudeUsage(deps(reply(200, BODY), cacheFile)))
    const late: UsageDeps = { ...deps(reply(429, {}, { 'retry-after': '30' }), cacheFile), now: () => NOW + 600_000 }
    const r = ok(await readClaudeUsage(late))
    assert.equal(r.source, 'cache')
    assert.match(r.note ?? '', /pediu intervalo.*30s/)
    const none = await readClaudeUsage(deps(reply(429, {})))
    assert.equal(none.state, 'network')
  })

  test('the cache holds the normalized result only, never the token', async () => {
    const cacheFile = join(tmp(), 'c.json')
    ok(await readClaudeUsage(deps(reply(200, BODY), cacheFile)))
    assert.ok(!readFileSync(cacheFile, 'utf8').includes(SECRET))
  })
})

describe('usage: credential by platform', () => {
  test('env wins on any platform', async () => {
    assert.equal(await readClaudeToken(credDeps({ env: { CLAUDE_CODE_OAUTH_TOKEN: ` ${SECRET} ` }, platform: 'darwin' })), SECRET)
  })

  test('Linux/Windows: .credentials.json under the home; CLAUDE_CONFIG_DIR moves it', async () => {
    const home = tmp()
    mkdirSync(join(home, '.claude'))
    writeFileSync(join(home, '.claude', '.credentials.json'), credJson())
    assert.equal(await readClaudeToken(credDeps({ home, platform: 'win32' })), SECRET)
    const cfg = tmp()
    writeFileSync(join(cfg, '.credentials.json'), credJson())
    assert.equal(await readClaudeToken(credDeps({ home: tmp(), env: { CLAUDE_CONFIG_DIR: cfg } })), SECRET)
    await assert.rejects(readClaudeToken(credDeps({ home: tmp() })), /não encontradas/)
  })

  test('expired token is refused with a fixed message', async () => {
    const home = tmp()
    mkdirSync(join(home, '.claude'))
    writeFileSync(join(home, '.claude', '.credentials.json'), credJson({ expiresAt: NOW - 1 }))
    await assert.rejects(readClaudeToken(credDeps({ home })), (e: Error) => /expirado/.test(e.message) && !e.message.includes(SECRET))
  })

  test('macOS: asks the Keychain with an argument array (no shell), plain or hex-encoded', async () => {
    const seen: string[][] = []
    const plain = credDeps({ platform: 'darwin', security: async (a) => { seen.push(a); return `${credJson()}\n` } })
    assert.equal(await readClaudeToken(plain), SECRET)
    assert.deepEqual(seen[0], ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'])
    assert.equal(KEYCHAIN_SERVICE, 'Claude Code-credentials')
    const hex = credDeps({ platform: 'darwin', security: async () => Buffer.from(credJson()).toString('hex') })
    assert.equal(await readClaudeToken(hex), SECRET)
  })

  test('macOS: Keychain failure or garbage is a fixed-text error', async () => {
    await assert.rejects(readClaudeToken(credDeps({ platform: 'darwin', security: async () => { throw new Error(`boom ${SECRET}`) } })), (e: Error) => /Keychain/.test(e.message) && !e.message.includes(SECRET))
    await assert.rejects(readClaudeToken(credDeps({ platform: 'darwin', security: async () => 'not json' })), /ilegíveis/)
  })
})

describe('usage: the token never leaks', () => {
  async function runAll(d: UsageDeps): Promise<string> {
    let all = ''
    const io = { out: (t: string) => { all += t }, err: (t: string) => { all += t }, deps: d }
    await cmdUsage([], io)
    await cmdUsage(['--json'], io)
    return all
  }

  test('success output (text and json)', async () => {
    assert.ok(!(await runAll(deps(reply(200, BODY)))).includes(SECRET))
  })

  test('HTTP error whose body echoes the token', async () => {
    const out = await runAll(deps(reply(401, { error: SECRET }, { 'x-echo': SECRET })))
    assert.match(out, /HTTP 401/)
    assert.ok(!out.includes(SECRET))
  })

  test('network exception whose message carries the token', async () => {
    const boom = (async () => { throw Object.assign(new Error(`connect failed Bearer ${SECRET}`), { cause: { code: 'ECONNREFUSED' } }) }) as typeof fetch
    const out = await runAll(deps(boom))
    assert.match(out, /ECONNREFUSED/)
    assert.ok(!out.includes(SECRET))
  })

  test('unexpected exception from the token reader or from the body', async () => {
    const weird = await runAll(deps(reply(200, BODY), join(tmp(), 'c.json'), async () => { throw new Error(SECRET) }))
    assert.match(weird, /credenciais indisponíveis/)
    assert.ok(!weird.includes(SECRET))
    const badJson = (async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => { throw new Error(SECRET) } })) as unknown as typeof fetch
    assert.ok(!(await runAll(deps(badJson))).includes(SECRET))
  })

  test('the request carries the token only in the Authorization header, to the official URL', async () => {
    let url = ''
    let init: RequestInit | undefined
    const f = (async (u: string, i: RequestInit) => { url = u; init = i; return new Response(JSON.stringify(BODY)) }) as unknown as typeof fetch
    ok(await readClaudeUsage(deps(f)))
    assert.equal(url, 'https://api.anthropic.com/api/oauth/usage')
    assert.equal((init!.headers as Record<string, string>).Authorization, `Bearer ${SECRET}`)
    assert.equal(init!.redirect, 'manual')
  })

  test('nothing is written next to the cache but the normalized file', async () => {
    const d = tmp()
    ok(await readClaudeUsage(deps(reply(200, BODY), join(d, 'c.json'))))
    assert.deepEqual(readdirSync(d), ['c.json'])
  })
})

describe('usage: CLI', () => {
  test('exit codes: ok 0, no credential 3, network 4, format 5; unknown option throws a usage error', async () => {
    const run = async (d: UsageDeps, args: string[] = []) => { let o = ''; const code = await cmdUsage(args, { out: (t) => { o += t }, err: (t) => { o += t }, deps: d }); return { code, o } }
    assert.equal((await run(deps(reply(200, BODY)))).code, 0)
    const noCred = await run(deps(reply(200, BODY), join(tmp(), 'c.json'), async () => { throw new Error('x') }))
    assert.equal(noCred.code, 3)
    assert.equal((await run(deps(reply(500, {})))).code, 4)
    assert.equal((await run(deps(reply(200, { x: 1 })))).code, 5)
    await assert.rejects(run(deps(reply(200, BODY)), ['--bogus']), /desconhecida|--bogus/)
  })
})
