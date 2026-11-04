// The tray menu model (app/shared/tray.ts): built from the daemon's slot states, in Portuguese.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SlotState, SlotStatus } from '../../src/daemon/protocol.ts'
import { TRAY_PANE_LIMIT, trayModel, trayWanted, type TrayItem } from '../../app/shared/tray.ts'

function slot(slotId: string, status: SlotStatus, extra: Partial<SlotState> = {}): SlotState {
  return { slotId, kind: 'shell', cwd: `D:/work/${slotId}`, status, ...extra }
}
const panes = (items: TrayItem[]) => items.flatMap(i => (i.kind === 'pane' ? [i] : []))
const commands = (items: TrayItem[]) => items.flatMap(i => (i.kind === 'command' ? [i.id] : []))

test('no slots: only the commands, tooltip says nothing runs, no badge', () => {
  const m = trayModel([])
  assert.deepEqual(commands(m.items), ['open', 'open-drawer', 'restart-daemon', 'quit-keep', 'quit-all'])
  assert.equal(m.items[0]!.kind === 'command' && m.items[0]!.label, 'Abrir tether')
  assert.equal(panes(m.items).length, 0)
  assert.equal(m.tooltip, 'tether: nenhum agente rodando')
  assert.equal(m.running, 0)
  assert.equal(m.badge, 'none')
})

test('commands are labelled in Portuguese and the pane list sits between two separators', () => {
  const m = trayModel([slot('a', 'running')])
  const labels = m.items.map(i => (i.kind === 'separator' ? '---' : i.label))
  assert.deepEqual(labels, ['Abrir tether', 'Abrir gaveta', '---', 'a (rodando)', '---', 'Reiniciar o tetherd… (encerra os agentes e retoma as sessões)', 'Sair (manter agentes)', 'Sair e encerrar tudo…'])
})

test('panes: live first, then the rest; the label is title, else name, else folder, with the state', () => {
  const m = trayModel([
    slot('s1', 'exited', { name: 'velho' }),
    slot('s2', 'running', { title: 'Corrigir login', name: 'ignorado' }),
    slot('s3', 'starting'),
    slot('s4', 'queued'),
    slot('s5', 'unconfirmed'),
    slot('s6', 'error'),
  ])
  assert.deepEqual(panes(m.items).map(p => [p.slotId, p.label]), [
    ['s2', 'Corrigir login (rodando)'],
    ['s3', 's3 (iniciando)'],
    ['s4', 's4 (na fila)'],
    ['s5', 's5 (aguardando escolha)'],
    ['s6', 's6 (com erro)'],
    ['s1', 'velho (encerrado)'],
  ])
})

test('running count and tooltip: running and starting count, exited does not; singular and plural', () => {
  const one = trayModel([slot('a', 'running'), slot('b', 'exited')])
  assert.equal(one.running, 1)
  assert.equal(one.tooltip, 'tether: 1 agente rodando')
  assert.equal(one.badge, 'active')
  const two = trayModel([slot('a', 'running'), slot('b', 'starting'), slot('c', 'queued')])
  assert.equal(two.running, 2)
  assert.equal(two.tooltip, 'tether: 2 agentes rodando')
  assert.equal(trayModel([slot('a', 'exited')]).badge, 'none')
})

test('a long list is cut at the limit with a disabled "e mais N" line', () => {
  const many = Array.from({ length: TRAY_PANE_LIMIT + 3 }, (_, i) => slot(`p${i}`, 'exited'))
  const m = trayModel(many)
  assert.equal(panes(m.items).length, TRAY_PANE_LIMIT)
  assert.ok(m.items.some(i => i.kind === 'info' && i.label === 'e mais 3'))
})

test('the folder name tolerates a trailing separator and a bare drive', () => {
  for (const sep of ['/', String.fromCharCode(92)]) {
    assert.equal(panes(trayModel([slot('a', 'exited', { cwd: `D:${sep}atrium${sep}` })]).items)[0]!.label, 'atrium (encerrado)')
    assert.equal(panes(trayModel([slot('a', 'exited', { cwd: `D:${sep}` })]).items)[0]!.label, 'D: (encerrado)')
  }
})

test('trayWanted: tests (private home/pipe, hidden window) get no tray unless they opt in; the user\'s app does', () => {
  assert.equal(trayWanted({}), true, 'a plain launch has the tray')
  assert.equal(trayWanted({ TETHER_HOME: 'C://x' }), false)
  assert.equal(trayWanted({ TETHER_PIPE: 'pipe-x' }), false)
  assert.equal(trayWanted({ TETHER_E2E_HIDDEN: '1' }), false)
  assert.equal(trayWanted({ TETHER_HOME: 'C://x', TETHER_E2E_HIDDEN: '1', TETHER_TRAY: '1' }), true, 'the tray suite opts back in')
  assert.equal(trayWanted({ TETHER_NO_TRAY: '1', TETHER_TRAY: '1' }), false, 'the explicit off wins')
})
