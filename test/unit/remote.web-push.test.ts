// "Avisos neste aparelho" (RR4 step 4.4): what the item says (remote/web/src/push-rules.ts), and the service worker's two
// new handlers, which show only what parses as a notice and keep nothing (remote/web/src/sw.ts).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isIos, pushModel, PUSH_TEXT, sameKey, type PushFacts } from '../../remote/web/src/push-rules.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const base: PushFacts = { tv: false, supported: true, ios: false, standalone: false, permission: 'default', on: false, busy: false }

describe('the item of the session', () => {
  test('off, on, blocked, and the one gesture of each', () => {
    assert.deepEqual(pushModel(base).action, { label: PUSH_TEXT.turnOn, turn: 'on' })
    assert.equal(pushModel(base).lead, 'Avisa quando um agente espera você ou quando falam com você num canal.')
    const on = pushModel({ ...base, permission: 'granted', on: true })
    assert.equal(on.phase, 'on')
    assert.deepEqual(on.action, { label: PUSH_TEXT.turnOff, turn: 'off' })
    const blocked = pushModel({ ...base, permission: 'denied' })
    assert.equal(blocked.phase, 'blocked')
    assert.equal(blocked.action, undefined, 'only the browser unblocks it')
    assert.equal(pushModel({ ...base, busy: true }).action, undefined)
  })

  test('iOS outside the home screen: install the app; the TV and a browser without push: not available here', () => {
    assert.equal(pushModel({ ...base, ios: true, supported: false }).phase, 'install')
    assert.equal(pushModel({ ...base, ios: true, supported: true }).phase, 'install')
    assert.equal(pushModel({ ...base, ios: true, standalone: true }).phase, 'off')
    assert.equal(pushModel({ ...base, supported: false }).phase, 'unavailable')
    assert.equal(pushModel({ ...base, tv: true, on: true }).phase, 'unavailable')
    assert.equal(pushModel({ ...base, tv: true }).state, 'Não disponível aqui.')
  })

  test('a failed attempt says why and offers the gesture again', () => {
    assert.equal(pushModel({ ...base, permission: 'granted', fail: 'service' }).state, PUSH_TEXT.service)
    assert.equal(pushModel({ ...base, permission: 'granted', fail: 'failed' }).action?.turn, 'on')
  })

  test('iOS by its user agent, the iPad that says it is a Mac by its touch', () => {
    assert.equal(isIos('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 'iPhone', 5), true)
    assert.equal(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 5), true)
    assert.equal(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 0), false)
    assert.equal(isIos('Mozilla/5.0 (Linux; Android 14)', 'Linux armv8l', 5), false)
  })

  test('the browser\'s subscription is this house\'s only with the same VAPID key', () => {
    const key = new Uint8Array([4, 250, 251, 252, 1, 2, 3])
    assert.equal(sameKey(key.buffer, 'BPr7_AECAw'), true)
    assert.equal(sameKey(key.buffer, 'BPr7_AECAx'), false)
    assert.equal(sameKey(null, 'BPr7_AECAw'), false)
  })
})

describe('the service worker shows notices and keeps nothing', () => {
  const src = readFileSync(join(ROOT, 'remote', 'web', 'src', 'sw.ts'), 'utf8').replace(/\/\/.*$/gm, '')
  test('push goes through parsePushNotice, and a tap opens only the app\'s own scope with a known query', () => {
    assert.match(src, /addEventListener\('push'/)
    assert.match(src, /addEventListener\('notificationclick'/)
    assert.match(src, /parsePushNotice\(raw\)/)
    // B-6: a notice that does not parse falls back to the house's fixed title too.
    assert.match(src, /n\?\.title \?\? PUSH_TITLE\b/)
    assert.match(src, /\^\\\?\(\?:c=\[A-Za-z0-9_\.:-\]\{1,80\}\|tab=waiting\)\$/)
    assert.doesNotMatch(src, /localStorage|indexedDB|postMessage|importScripts|fetch\([^)]*data/)
  })
})
