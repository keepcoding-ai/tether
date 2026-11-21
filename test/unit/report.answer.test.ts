// The reporters' last-answer file: `<home>/slots/<slot>.answer.json`, written when a turn ends with an answer.
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tempDirs } from './tmp.helpers.ts'

const CLAUDE = resolve(import.meta.dirname, '../../src/report/claude-hook.mjs')
const CODEX = resolve(import.meta.dirname, '../../src/report/codex-hook.mjs')
const homes = tempDirs('tether-answer-')
after(() => homes.cleanup())

const run = (script: string, args: string[], stdin: string | undefined, env: Record<string, string | undefined>) =>
  spawnSync(process.execPath, [script, ...args], { input: stdin, encoding: 'utf8', env: { ...process.env, TETHER_HOME: undefined, TETHER_SLOT_ID: undefined, ...env }, timeout: 20_000 })
const answerPath = (home: string) => join(home, 'slots', 's1.answer.json')
const read = (home: string) => JSON.parse(readFileSync(answerPath(home), 'utf8'))
const stop = (extra: Record<string, unknown> = {}) => JSON.stringify({ session_id: 'sess-1', hook_event_name: 'Stop', last_assistant_message: 'Done.\n\nSecond paragraph', ...extra })
const notify = (extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'th-1', 'turn-id': 'tu-1', cwd: 'x', 'input-messages': ['do it'], 'last-assistant-message': 'All done', ...extra })
const noTmp = (home: string) => readdirSync(join(home, 'slots')).filter((n) => n.endsWith('.tmp'))

describe('claude hook answer', () => {
  test('Stop with a message writes the file, atomically', () => {
    const home = homes.make()
    const r = run(CLAUDE, ['Stop'], stop(), { TETHER_HOME: home, TETHER_SLOT_ID: 's1' })
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
    const a = read(home)
    assert.equal(a.text, 'Done.\n\nSecond paragraph')
    assert.equal(a.sessionId, 'sess-1')
    assert.equal(a.from, 'claude-stop')
    assert.ok(a.ts)
    assert.deepEqual(noTmp(home), [])
  })
  test('the next turn replaces it', () => {
    const home = homes.make()
    const env = { TETHER_HOME: home, TETHER_SLOT_ID: 's1' }
    run(CLAUDE, ['Stop'], stop(), env)
    run(CLAUDE, ['Stop'], stop({ last_assistant_message: 'second' }), env)
    assert.equal(read(home).text, 'second')
  })
  test('a subagent Stop writes nothing', () => {
    const home = homes.make()
    run(CLAUDE, ['Stop'], stop({ agent_id: 'sub1' }), { TETHER_HOME: home, TETHER_SLOT_ID: 's1' })
    assert.equal(existsSync(answerPath(home)), false)
  })
  test('without a message, or on another hook, writes nothing', () => {
    const home = homes.make()
    const env = { TETHER_HOME: home, TETHER_SLOT_ID: 's1' }
    run(CLAUDE, ['Stop'], stop({ last_assistant_message: undefined }), env)
    run(CLAUDE, ['UserPromptSubmit'], stop(), env)
    assert.equal(existsSync(answerPath(home)), false)
  })
  test('without TETHER_SLOT_ID writes nothing', () => {
    const home = homes.make()
    const r = run(CLAUDE, ['Stop'], stop(), { TETHER_HOME: home })
    assert.equal(r.status, 0)
    assert.equal(existsSync(join(home, 'slots')), false)
  })
  test('a failed write changes neither output nor exit code', () => {
    const home = homes.make()
    writeFileSync(join(home, 'slots'), 'a file where the folder should be')
    const r = run(CLAUDE, ['Stop'], stop(), { TETHER_HOME: home, TETHER_SLOT_ID: 's1' })
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
  })
})

describe('codex hook answer', () => {
  test('a finished turn writes the file, with turnId, atomically', () => {
    const home = homes.make()
    const r = run(CODEX, ['notify', notify()], undefined, { TETHER_HOME: home, TETHER_SLOT_ID: 's1' })
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
    const a = read(home)
    assert.equal(a.text, 'All done')
    assert.equal(a.sessionId, 'th-1')
    assert.equal(a.turnId, 'tu-1')
    assert.equal(a.from, 'codex-notify')
    assert.deepEqual(noTmp(home), [])
  })
  test('the title notify does not write, nor overwrite', () => {
    const home = homes.make()
    const env = { TETHER_HOME: home, TETHER_SLOT_ID: 's1' }
    const title = notify({ 'thread-id': 'th-2', 'input-messages': ['Generate a concise, single-line task title for this'], 'last-assistant-message': '{"title":"x"}' })
    run(CODEX, ['notify', title], undefined, env)
    assert.equal(existsSync(answerPath(home)), false)
    run(CODEX, ['notify', notify()], undefined, env)
    run(CODEX, ['notify', title], undefined, env)
    assert.equal(read(home).text, 'All done')
  })
  test('other types, or without a message, write nothing', () => {
    const home = homes.make()
    const env = { TETHER_HOME: home, TETHER_SLOT_ID: 's1' }
    run(CODEX, ['notify', notify({ type: 'approval-requested' })], undefined, env)
    run(CODEX, ['notify', notify({ 'last-assistant-message': undefined })], undefined, env)
    assert.equal(existsSync(answerPath(home)), false)
  })
  test('without TETHER_SLOT_ID writes nothing', () => {
    const home = homes.make()
    const r = run(CODEX, ['notify', notify()], undefined, { TETHER_HOME: home })
    assert.equal(r.status, 0)
    assert.equal(existsSync(join(home, 'slots')), false)
  })
  test('a failed answer write keeps the exit code and the attention report', () => {
    const home = homes.make()
    const env = { TETHER_HOME: home, TETHER_SLOT_ID: 's1' }
    run(CODEX, ['notify', notify({ 'last-assistant-message': undefined })], undefined, env) // creates slots/
    mkdirSync(answerPath(home)) // a directory squats the final name: the rename fails
    const r = run(CODEX, ['notify', notify()], undefined, env)
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
    assert.ok(existsSync(join(home, 'slots', 's1.attention')))
  })
})
