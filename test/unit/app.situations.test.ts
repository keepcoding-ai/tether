// Remembered answers of the close-tab dialog (app/shared/dialog.ts) and the gentle-pause offer of quit-all
// (situations.ts imports icons, which node cannot load, so the pure parts live in shared/dialog.ts and sessions-rules.ts).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { choiceToRemember, rememberedClose, type DialogSpec } from '../../app/shared/dialog.ts'
import { pauseAction } from '../../app/renderer/pause-rules.ts'
import { pauseFirstConsequence } from '../../app/renderer/sessions-rules.ts'

const choices = ['detach', 'stop'].map(id => ({ id, icon: 'x', label: id, consequence: '', tone: 'neutral' as const }))
const live: DialogSpec = {
  situation: 'close-panel-live', tone: 'warn', icon: 'warning', title: 't', choices,
  remember: { choice: 'detach', label: 'Sempre só fechar a guia' }, rememberAlso: { choice: 'stop', label: 'Sempre encerrar o agente' },
}
const idle: DialogSpec = { ...live, situation: 'close-panel-idle', rememberAlso: undefined }

describe('close tab: remembered answers', () => {
  test('a stored answer is honoured only if the dialog offers it; forget/unknown asks again', () => {
    assert.equal(rememberedClose(live, 'detach'), 'detach')
    assert.equal(rememberedClose(live, 'stop'), 'stop')
    assert.equal(rememberedClose(live, 'forget'), undefined)
    assert.equal(rememberedClose(live, undefined), undefined)
  })
  test('the idle dialog never remembers stopping', () => {
    assert.equal(rememberedClose(idle, 'detach'), 'detach')
    assert.equal(rememberedClose(idle, 'stop'), undefined)
  })
  test('persists the ticked box only when it matches the clicked choice', () => {
    assert.equal(choiceToRemember(live, { choice: 'stop', remember: true, rememberChoice: 'stop' }), 'stop')
    assert.equal(choiceToRemember(live, { choice: 'detach', remember: true, rememberChoice: 'detach' }), 'detach')
    assert.equal(choiceToRemember(live, { choice: 'detach', remember: true, rememberChoice: 'stop' }), undefined)
    assert.equal(choiceToRemember(live, { choice: 'cancel', remember: true, rememberChoice: 'detach' }), undefined)
    assert.equal(choiceToRemember(live, { choice: 'detach', remember: false }), undefined)
    assert.equal(choiceToRemember(live, { choice: 'detach', remember: true }), 'detach', 'no rememberChoice: the first box')
  })
})

describe('quit all: gentle pause first', () => {
  test('the consequence agrees in number and says nothing quits', () => {
    assert.match(pauseFirstConsequence(1), /^Pede ao agente em andamento/)
    assert.match(pauseFirstConsequence(3), /^Pede aos 3 agentes em andamento/)
    assert.match(pauseFirstConsequence(2), /Nada é encerrado agora/)
  })
  test('menu button N=1 reads "ao agente"', () => {
    assert.equal(pauseAction([{ turn: 'busy' }], null).label, 'Pedir pausa ao agente em andamento')
    assert.equal(pauseAction([{ turn: 'busy' }, { turn: 'busy' }], null).label, 'Pedir pausa aos 2 em andamento')
  })
})
