// Managing a channel from afar (RR5, fio-spec 18), the pure rules of the web: which gestures of the channel's view show by
// the device's scopes, the app's dialogs on the web's box (the line of the biometrics only on the choice that proves the
// act), the agents "Chamar agente…" offers, and the refusals in words, never the code.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { closeDialog, failedDialog, joinItems, muteDialog } from '../../extensions/channels/renderer/texts.ts'
import { agentChoicesOf, channelAfarOf, channelRefusal, doneText, failedAfar, joinedText, questionOf } from '../../remote/web/src/channel-afar-rules.ts'
import { capsOf, NO_CAPS } from '../../remote/web/src/manage-rules.ts'

describe('what the channel view manages from afar', () => {
  test('nothing without the channels scope; closing only with manage:destructive', () => {
    assert.equal(channelAfarOf(NO_CAPS), undefined)
    assert.equal(channelAfarOf(capsOf(['manage:desks', 'manage:destructive'], true)), undefined, 'no channels scope: no gesture at all')
    assert.deepEqual(channelAfarOf(capsOf(['channels'], true)), { close: false }, 'call, mute, take out, reopen, close a poll; no "Encerrar canal…"')
    assert.deepEqual(channelAfarOf(capsOf(['channels', 'manage:destructive'], true)), { close: true })
    assert.equal(channelAfarOf(capsOf(['channels', 'manage:destructive'], false)), undefined, 'a device without a presence credential acts on nothing')
  })
})

describe('the app\'s dialogs on the web\'s box', () => {
  test('closing a channel: the app\'s title, message and choice; the biometrics line only where the act is proved', () => {
    const q = questionOf(closeDialog({ channel: 'obra', members: 2 }), ['close'])
    assert.equal(q.title, 'Encerrar #obra?')
    assert.match(q.lead ?? '', /os 2 membros recebem um aviso da sala/)
    assert.deepEqual(q.choices.map(c => [c.id, c.label, c.tone, c.proof]), [['close', 'Encerrar canal', 'destructive', true]])
    assert.equal(q.cancel, 'Cancelar')
    const m = questionOf(muteDialog({ channel: 'obra', member: 'conferente', fromDesk: false }))
    assert.equal(m.title, 'Calar conferente em #obra?')
    assert.equal(m.choices[0]!.proof, undefined, 'muting proves nothing')
  })

  test('a notice with only "Entendi" has no cancel of its own', () => {
    const q = questionOf(failedDialog('Chamar agente', 'unknown-agent'))
    assert.equal(q.cancel, '')
    assert.deepEqual(q.choices.map(c => c.label), ['Entendi'])
  })

  test('the refusals in words: the channels\' for their codes, the distance\'s for the rest; never the code', () => {
    assert.equal(channelRefusal('name-taken'), 'Já há um canal aberto com esse nome.')
    assert.equal(channelRefusal('no-app'), 'O tether não está aberto na máquina. Nada foi feito.')
    assert.equal(channelRefusal('timeout'), 'A máquina não respondeu a tempo. Pode ter feito: a tela mostra quando ela contar.')
    for (const code of ['no-app', 'timeout', 'locked', 'slow-down', 'not-member', 'desk']) {
      const d = failedAfar('Calar agente', code)
      assert.doesNotMatch(d.message ?? '', new RegExp(`\\(${code}\\)`), `${code} is said in words`)
      assert.equal(d.title, 'Calar agente')
    }
  })
})

describe('"Chamar agente…" from afar', () => {
  const input = {
    agents: [{ id: 'a1', kind: 'claude', name: 'conferente' }, { id: 'a2', kind: 'soul', name: 'migra' }, { id: 'a3', kind: 'claude', name: 'solto' }],
    desks: {
      desks: [
        { id: 'd1', name: 'Obra', color: 'blue', kind: 'queue' as const, asleep: false, panes: [{ id: 'a1', type: 'terminal', icon: 'sparkle', title: 'conferente' }] },
        { id: 'd2', name: 'Migração', color: 'green', kind: 'queue' as const, asleep: true, panes: [{ id: 'a2', type: 'terminal', icon: 'ghost', title: 'migra', exited: true }] },
      ],
    },
  }

  test('the house\'s agents as the app\'s list: by desk, the stopped ones and the ones no desk shows', () => {
    const agents = agentChoicesOf(input as never)
    assert.deepEqual(agents, [
      { slotId: 'a1', kind: 'claude', name: 'conferente', alive: true, deskId: 'd1', deskTitle: 'Obra' },
      { slotId: 'a2', kind: 'soul', name: 'migra', alive: false, deskId: 'd2', deskTitle: 'Migração' },
      { slotId: 'a3', kind: 'claude', name: 'solto', alive: true, placed: false },
    ])
    // The app's own rows: who is in the channel is not offered; grouped by desk, the stopped ones last.
    const rows = joinItems(agents, new Set(['a3']), undefined, undefined, { desks: [{ id: 'd1', asleep: false }, { id: 'd2', asleep: true }] })
    assert.deepEqual(rows.map(r => [r.value, r.group]), [['a1', 'Mesa · Obra'], ['a2', 'Parados']])
  })

  test('the notices after the gestures', () => {
    assert.equal(joinedText(['conferente'], 'obra'), 'conferente chamado a #obra.')
    assert.equal(joinedText(['a', 'b', 'c'], 'obra'), 'a, b e c chamados a #obra.')
    assert.equal(joinedText([], 'obra'), undefined)
    assert.equal(doneText('mute', 'obra', 'conferente'), 'conferente calado em #obra.')
    assert.equal(doneText('unmute', 'obra', 'conferente'), 'conferente tem a voz de volta em #obra.')
    assert.equal(doneText('close', 'obra'), '#obra encerrado.')
  })
})
