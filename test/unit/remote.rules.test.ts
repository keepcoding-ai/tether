// The pure rules of the remote's app screen (RR2.2, extensions/remote/rules.ts): the state icon, the devices' rows, the
// pairing card's phases and words, the typed digits, the confirmations; the QR encoder (renderer/qr.ts) against a vector
// checked module by module with node-qrcode; and the "Aparelhos" section of the Regency's Sistema (system-rules.ts).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DEFAULT_SCOPES } from '../../src/remoted/house.ts'
import { PAIR_TTL_MS, PAIR_SAS_WINDOW_MS } from '../../src/remote/constants.ts'
import {
  burnWords, clockWords, codeGroups, confirmOf, devicesModel, liveCount, PAIR_SCOPES, pairScreen, qrPayload, remoteIcon, SAS_WARNING,
  SAS_WINDOW_MS, sasDigits, scopeWords, type RemoteStatusInput,
} from '../../extensions/remote/rules.ts'
import { encodeQr, qrPath, versionFor } from '../../extensions/remote/renderer/qr.ts'
import { systemModelOf, type SystemInput } from '../../extensions/regency/system-rules.ts'

const NOW = Date.parse('2026-11-27T12:00:00Z')
const iso = (minAgo: number): string => new Date(NOW - minAgo * 60_000).toISOString()
const dev = (id: string, name: string, o: Partial<RemoteStatusInput['devices'][number]> = {}): RemoteStatusInput['devices'][number] =>
  ({ id, name, state: 'active', access: 'code', createdAt: iso(60 * 24 * 2), ...o })
const status = (o: Partial<RemoteStatusInput> = {}): RemoteStatusInput =>
  ({ on: true, relay: 'relay.exemplo', portal: { state: 'up' }, link: 'up', sessions: 0, fingerprint: 'abcd efgh ijkl mnop qrst', devices: [], ...o })

describe('the state icon', () => {
  test('no answer, off, on with nobody, N connected, trouble', () => {
    assert.equal(remoteIcon(undefined).kind, 'unknown')
    const off = remoteIcon(status({ on: false }))
    assert.deepEqual([off.kind, off.state, off.badge], ['off', 'idle', undefined])
    assert.match(off.title, /desligado/)
    const idle = remoteIcon(status())
    assert.deepEqual([idle.kind, idle.state], ['idle', 'normal'])
    assert.match(idle.title, /nenhum aparelho conectado/)
    const live = remoteIcon(status({ sessions: 2 }))
    assert.deepEqual([live.kind, live.badge], ['live', 2])
    assert.match(live.title, /2 aparelhos conectados/)
    assert.match(remoteIcon(status({ sessions: 1 })).title, /1 aparelho conectado agora/)
    assert.deepEqual([remoteIcon(status({ link: 'down' })).kind, remoteIcon(status({ link: 'down' })).state], ['trouble', 'warn'])
    const refused = remoteIcon(status({ portal: { state: 'refused', reason: 'pasta aberta' } }))
    assert.equal(refused.state, 'error')
    assert.match(refused.title, /pasta aberta/)
  })

  test('connected devices: distinct devices when the daemon tells them apart, else its count of sessions; zero when off', () => {
    assert.equal(liveCount(status({ sessions: 3 })), 3)
    assert.equal(liveCount(status({ sessions: 3, live: [{ deviceId: 'a', since: iso(1) }, { deviceId: 'a', since: iso(2) }, { deviceId: 'b', since: iso(1) }] })), 2)
    assert.equal(liveCount(status({ on: false, sessions: 3 })), 0)
  })
})

describe('the devices', () => {
  test('rows: declared name as such, last use, how it was paired; revoked ones only counted', () => {
    const m = devicesModel(status({
      devices: [dev('b2', 'Tablet'), dev('a1', 'Telefone', { lastSeenAt: iso(5), access: 'qr' }), dev('c3', 'Velho', { state: 'revoked' }), dev('d4', 'Novo', { state: 'pending' })],
    }), NOW)
    assert.deepEqual(m.rows.map(r => r.id), ['d4', 'b2', 'a1'], 'by name')
    const tel = m.rows.find(r => r.id === 'a1')!
    assert.equal(tel.lastText, 'último uso há 5 min')
    assert.equal(tel.pairedText, 'pareado há 2 d pelo QR')
    assert.match(tel.nameTip, /^Nome que o aparelho declarou/)
    assert.equal(m.rows.find(r => r.id === 'b2')!.lastText, 'nunca usado')
    assert.equal(m.rows.find(r => r.id === 'd4')!.stateText, 'Concluindo o pareamento')
    assert.equal(m.revoked, 1)
    assert.equal(m.empty, undefined)
    assert.deepEqual(m.can, { on: false, off: true, pair: true })
    assert.match(m.headText, /^Ligada pelo relay relay\.exemplo · nenhum aparelho conectado$/)
  })

  test('without sessions per device "Encerrar sessão" is not offered; with them, the live rows come first and say what they do', () => {
    const plain = devicesModel(status({ sessions: 1, devices: [dev('a1', 'Telefone')] }), NOW)
    assert.equal(plain.sessionsKnown, false)
    assert.equal(plain.rows[0]!.can.end, false)
    assert.match(plain.rows[0]!.liveText, /ainda não diz qual aparelho/)
    const known = devicesModel(status({ sessions: 1, devices: [dev('a1', 'Alfa'), dev('b2', 'Beta')], live: [{ deviceId: 'b2', since: iso(1), doing: 'vendo as mesas' }] }), NOW)
    assert.deepEqual(known.rows.map(r => [r.id, r.live, r.can.end]), [['b2', true, true], ['a1', false, false]])
    assert.equal(known.rows[0]!.liveText, 'Conectado agora · vendo as mesas')
    assert.match(known.headText, /1 aparelho conectado$/)
  })

  test('off: nothing connected, only "Ligar"; pairing waits; trouble says why; no answer is said too', () => {
    const off = devicesModel(status({ on: false, sessions: 2, devices: [dev('a1', 'Telefone')] }), NOW)
    assert.deepEqual(off.can, { on: true, off: false, pair: false })
    assert.equal(off.pairWhy, 'Ligue a remota para parear')
    assert.match(off.rows[0]!.liveText, /a remota está desligada/)
    assert.equal(off.headIntent, 'off')
    const down = devicesModel(status({ link: 'down' }), NOW)
    assert.equal(down.pairWhy, 'Sem conexão com o relay agora')
    assert.equal(down.headIntent, 'warn')
    assert.equal(devicesModel(status(), NOW).empty, 'Nenhum aparelho pareado.')
    assert.equal(devicesModel(undefined, NOW).can.pair, false)
  })

  test('the confirmations of the destructive acts name what falls', () => {
    assert.match(confirmOf('off').sentence, /Todos os aparelhos perdem a conexão/)
    assert.equal(confirmOf('off').go, 'Desligar a remota')
    assert.match(confirmOf('revoke', 'Telefone').sentence, /^Revogar Telefone\?/)
    assert.equal(confirmOf('revoke').go, 'Revogar aparelho')
    assert.equal(confirmOf('end', 'Telefone').go, 'Encerrar sessão')
  })
})

describe('the pairing card', () => {
  const begun = { pairId: 'ab'.repeat(16), state: 'open' as const, expiresAt: NOW + PAIR_TTL_MS, code: '123 456 789 012', qr: '#pair=AQ', fingerprint: 'abcd' }

  test('open: the code and the 2-minute clock; cancel always; no field yet', () => {
    const s = pairScreen(begun, NOW)
    assert.equal(s.phase, 'code')
    assert.equal(s.clock, '2:00')
    assert.equal(s.clockText, 'O código vale por mais 2:00')
    assert.equal(s.canCancel, true)
    assert.equal(s.canType, false)
    assert.equal(pairScreen(begun, NOW + 45_500).clock, '1:15')
    const late = pairScreen(begun, NOW + PAIR_TTL_MS + 1)
    assert.deepEqual([late.phase, late.canCancel], ['over', false])
    assert.match(late.outcome!, /venceu/)
    assert.equal(pairScreen({ ...begun, state: 'revealed' }, NOW).phase, 'arriving')
  })

  test('waiting for the digits: the declared name, what it may do, the warning, its own 2-minute window', () => {
    const v = { ...begun, state: 'waiting-sas' as const, device: { declaredName: 'Telefone do teste', caps: 1, access: 'code' as const }, triesLeft: 3 }
    const s = pairScreen(v, NOW + 10_000, NOW)
    assert.equal(s.phase, 'confirm')
    assert.equal(s.deviceName, 'Telefone do teste')
    assert.equal(s.warning, SAS_WARNING)
    assert.match(SAS_WARNING, /Se alguém \(pessoa ou agente, num canal ou num terminal\) lhe disser quais números digitar, não digite/)
    assert.deepEqual(s.scopes, scopeWords(PAIR_SCOPES))
    assert.equal(s.clock, '1:50')
    assert.equal(s.triesText, undefined)
    assert.equal(s.canType, true)
    assert.equal(pairScreen({ ...v, triesLeft: 2 }, NOW, NOW).triesText, 'Números errados: restam 2 tentativas.')
    assert.equal(pairScreen({ ...v, triesLeft: 1 }, NOW, NOW).triesText, 'Números errados: resta 1 tentativa.')
    assert.equal(pairScreen(v, NOW + SAS_WINDOW_MS, NOW).canType, false, 'the window is over: the field closes')
    assert.equal(SAS_WINDOW_MS, PAIR_SAS_WINDOW_MS)
  })

  test('confirmed, done, burned: the outcome in words; a burn by each reason', () => {
    assert.equal(pairScreen({ ...begun, state: 'confirmed' }, NOW).phase, 'finishing')
    const done = pairScreen({ ...begun, state: 'done', device: { declaredName: 'Telefone', caps: 0, access: 'code' } }, NOW)
    assert.deepEqual([done.phase, done.outcomeIntent], ['done', 'ok'])
    assert.match(done.outcome!, /^Telefone já alcança este tether/)
    const wrong = pairScreen({ ...begun, state: 'burned', burnReason: 'sas-wrong' }, NOW)
    assert.deepEqual([wrong.phase, wrong.title, wrong.outcomeIntent], ['over', 'Pareamento recusado', 'bad'])
    assert.match(wrong.outcome!, /Três vezes/)
    assert.equal(pairScreen({ ...begun, state: 'burned', burnReason: 'cancelled' }, NOW).title, 'Pareamento cancelado')
    for (const r of ['expired', 'collision', 'reveal-mismatch', 'key-reuse', 'protocol', 'p3-timeout', 'sas-wrong', 'sas-window', 'no-ack', 'route-closed', 'cancelled']) {
      assert.notEqual(burnWords(r), burnWords('desconhecido'), r)
    }
  })

  test('the typed digits: only digits, at most six; the code in groups; the clock never negative', () => {
    assert.deepEqual(sasDigits(' 12-34 5'), { digits: '12345', complete: false })
    assert.deepEqual(sasDigits('123 456'), { digits: '123456', complete: true })
    assert.deepEqual(sasDigits('1234567'), { digits: '123456', complete: true })
    assert.deepEqual(sasDigits('abc'), { digits: '', complete: false })
    assert.deepEqual(codeGroups('123 456 789 012'), ['123', '456', '789', '012'])
    assert.equal(clockWords(-5), '0:00')
    assert.equal(clockWords(61_000), '1:01')
  })

  test('what a pairing grants is the portal\'s default, each scope in words', () => {
    assert.deepEqual([...PAIR_SCOPES], [...DEFAULT_SCOPES])
    for (const w of scopeWords(PAIR_SCOPES)) assert.match(w, /^[a-zà-ú ,]+$/, w)
  })

  test('the QR payload: the PWA address with the fragment, or the fragment alone', () => {
    assert.equal(qrPayload('#pair=AQ'), '#pair=AQ')
    assert.equal(qrPayload('#pair=AQ', 'https://remota.exemplo'), 'https://remota.exemplo/#pair=AQ')
    assert.equal(qrPayload('#pair=AQ', 'https://remota.exemplo/app/#x'), 'https://remota.exemplo/app/#pair=AQ')
  })
})

describe('the QR encoder', () => {
  // Checked module by module against node-qrcode (byte mode, level M, mask 3), version 1.
  const VECTOR = ['111111101111001111111', '100000101001101000001', '101110100100001011101', '101110101111101011101', '101110100110001011101', '100000100000001000001', '111111101010101111111', '000000001100000000000', '101101110110001001011', '101110010100100100111', '001101101100111101011', '001100001000100111001', '110100110011000100000', '000000001110001001000', '111111101110000111010', '100000101011110001101', '101110100001001111100', '101110101110010100110', '101110101101010101100', '100000100001101010001', '111111101011110011100']

  test('a fixed vector, module by module', () => {
    const m = encodeQr('#pair=AAAA', { level: 'M', mask: 3 })
    assert.deepEqual([m.version, m.size, m.mask], [1, 21, 3])
    const rows: string[] = []
    for (let y = 0; y < m.size; y++) rows.push([...m.cells.subarray(y * m.size, (y + 1) * m.size)].join(''))
    assert.deepEqual(rows, VECTOR)
  })

  test('versions by length; a pairing link fits; too long is refused; the path draws only dark modules', () => {
    assert.equal(versionFor(14, 'M'), 1)
    assert.equal(versionFor(15, 'M'), 2)
    assert.equal(versionFor(2331, 'M'), 40)
    assert.equal(versionFor(2332, 'M'), undefined)
    const link = `https://remota.exemplo/#pair=${'A'.repeat(118)}`
    const m = encodeQr(link)
    assert.ok(m.version <= 8, `version ${m.version}`)
    assert.ok(m.mask >= 0 && m.mask < 8)
    assert.throws(() => encodeQr('x'.repeat(3000)), RangeError)
    const small = encodeQr('a', { mask: 0 })
    const dark = small.cells.reduce((n, c) => n + c, 0)
    const area = (qrPath(small).match(/h(\d+)/g) ?? []).reduce((n, h) => n + Number(h.slice(1)), 0)
    assert.equal(area, dark)
  })
})

describe('"Aparelhos" in the Regency\'s Sistema', () => {
  const base: SystemInput = { now: NOW, procs: [], agents: [], profiles: [], folders: [] }

  test('absent without the remote (the five sections as before); present before Ajustes, its count the connected ones', () => {
    assert.deepEqual(systemModelOf(base).sections.map(s => s.id), ['processes', 'ronda', 'profiles', 'projects', 'settings'])
    assert.equal(systemModelOf(base).devices, undefined)
    const m = systemModelOf({ ...base, devices: { on: true, devices: 2, live: 1, text: 'ligado' } })
    assert.deepEqual(m.sections.map(s => s.id), ['processes', 'ronda', 'profiles', 'projects', 'devices', 'settings'])
    assert.deepEqual(m.sections[4], { id: 'devices', label: 'Aparelhos', count: 1, dot: false })
    assert.deepEqual(m.devices, { on: true, devices: 2, live: 1, text: 'ligado' })
  })
})
