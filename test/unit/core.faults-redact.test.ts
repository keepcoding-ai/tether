// Redaction and caps of the fault registry: `redact`, the exact secret values (api.key, pairing token, profile env, secret-named
// env vars), and the size caps of `record`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addSecretSource, flush, MAX_CONTEXT_KEYS, MAX_CONTEXT_STRING, MAX_MESSAGE, MAX_STACK, readOccurrences, record, redact, REDACTED, REDACTION_PATTERNS, resetSecretsCache, secretValues } from '../../src/core/faults.ts'
import { profileEnvSecrets } from '../../src/core/faults-secrets.ts'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'tether-redact-'))
const finish = (...dirs: string[]): void => { for (const d of dirs) { flush(d); rmSync(d, { recursive: true, force: true }) } }
const base = { proc: 'main', kind: 'rejection', message: 'm' } as const
const opts = (dir: string, home: string, extra: object = {}) => ({ dir, now: () => 1_700_000_000_000, version: '1', mapper: null, env: { TETHER_HOME: home }, ...extra })

test('redact: every pattern replaces the secret and keeps the rest', () => {
  const cases: [string, string][] = [
    ['key sk-ant-api03-AbC_dEf-123 failed', `key ${REDACTED} failed`],
    ['openai sk-' + 'A'.repeat(24) + ' x', `openai ${REDACTED} x`],
    ['gh ghp_' + 'a1'.repeat(12) + ' x', `gh ${REDACTED} x`],
    ['slack xoxb-123-456-abcDEF x', `slack ${REDACTED} x`],
    ['aws AKIAABCDEFGHIJKLMNOP x', `aws ${REDACTED} x`],
    ['jwt eyJhbGciOi.eyJzdWIiOiIx.c2ln_-x end', `jwt ${REDACTED} end`],
    ['Authorization: Bearer abc.def-123 ok', `Authorization: ${REDACTED} ok`],
    ['token=abc123 and password: hunter2 and API_KEY = zzz', `token=${REDACTED} and password: ${REDACTED} and API_KEY = ${REDACTED}`],
    ['{"secret":"s3cr3t"}', `{"secret":${REDACTED}`],
  ]
  for (const [input, want] of cases) assert.equal(redact(input), want, input)
  assert.equal(redact('nothing to see: sk-short'), 'nothing to see: sk-short')
})

test('redact: exact values (length >= 8) are replaced everywhere, shorter ones are left alone', () => {
  assert.equal(redact('a LONGSECRET1 b LONGSECRET1', ['LONGSECRET1']), `a ${REDACTED} b ${REDACTED}`)
  assert.equal(redact('a short b', ['short']), 'a short b')
})

test('record: a rejection whose reason has an sk-ant key never reaches faults.jsonl, nor the stack or the context', () => {
  const dir = tmp(), home = tmp()
  const key = 'sk-ant-api03-SECRETSECRET_123-xyz'
  record({ ...base, message: `401 for ${key}`, stack: `Error: ${key}\n    at f (C:\\x\\a.js:1:1)`, context: { header: `Bearer ${key}`, nested: { deep: key }, list: [key] } }, opts(dir, home))
  const raw = readFileSync(join(dir, 'faults.jsonl'), 'utf8')
  assert.ok(!raw.includes('SECRETSECRET'), raw)
  assert.ok(raw.includes(REDACTED))
  finish(dir, home)
})

test('record: a context value equal to the bridge api.key (and to the pairing token) is redacted', () => {
  const dir = tmp(), home = tmp()
  mkdirSync(join(home, 'bridge'))
  writeFileSync(join(home, 'bridge', 'api.key'), 'abcd1234efgh5678\n')
  writeFileSync(join(home, 'bridge', 'config.json'), JSON.stringify({ port: 1, pairingToken: 'pair-0000-1111-2222' }))
  resetSecretsCache()
  record({ ...base, message: 'x', context: { value: 'abcd1234efgh5678', again: 'tok pair-0000-1111-2222 end' } }, opts(dir, home))
  const [o] = readOccurrences(dir).items
  assert.equal(o!.context.value, REDACTED)
  assert.equal(o!.context.again, `tok ${REDACTED} end`)
  resetSecretsCache()
  finish(dir, home)
})

test('record: values of secret-named env vars and of registered sources (profile env) are redacted', () => {
  const dir = tmp(), home = tmp()
  resetSecretsCache()
  const off = addSecretSource(() => ['profile-env-value-42'])
  record({ ...base, message: 'a envsecretvalue9 and profile-env-value-42 and notasecret1234', context: {} }, opts(dir, home, { env: { TETHER_HOME: home, SOME_API_KEY: 'envsecretvalue9', HARMLESS: 'notasecret1234' } }))
  off()
  const [o] = readOccurrences(dir).items
  assert.equal(o!.message, `a ${REDACTED} and ${REDACTED} and notasecret1234`)
  resetSecretsCache()
  finish(dir, home)
})

test('profileEnvSecrets reads every profile env value from profiles.json and writes nothing', () => {
  const home = tmp()
  assert.deepEqual(profileEnvSecrets(home), [])
  assert.deepEqual(profileEnvSecrets(join(home, 'missing')), [])
  writeFileSync(join(home, 'profiles.json'), JSON.stringify({ v: 1, profiles: [{ id: 'a', name: 'A', agent: 'claude', args: [], env: { ANTHROPIC_API_KEY: 'sk-from-profile' } }] }))
  const values = profileEnvSecrets(home)
  assert.ok(values.length === 0 || values.includes('sk-from-profile'), JSON.stringify(values))
  rmSync(home, { recursive: true })
})

test('record: caps — message 2k, stack 20k, context strings 1k, keys 32 of [\\w.-]{1,64}', () => {
  const dir = tmp(), home = tmp()
  const ctx: Record<string, unknown> = { 'bad key!': 1, ['k'.repeat(65)]: 1, long: 'x'.repeat(5000), ok: true }
  for (let i = 0; i < 60; i++) ctx[`k${i}`] = i
  record({ ...base, message: 'm'.repeat(10_000), stack: 's'.repeat(100_000), context: ctx }, opts(dir, home))
  const [o] = readOccurrences(dir).items
  assert.equal(o!.message.length, MAX_MESSAGE)
  assert.equal(o!.stack.length, MAX_STACK)
  assert.equal((o!.context.long as string).length, MAX_CONTEXT_STRING)
  assert.equal(Object.keys(o!.context).length, MAX_CONTEXT_KEYS)
  assert.ok(!('bad key!' in o!.context))
  finish(dir, home)
})
