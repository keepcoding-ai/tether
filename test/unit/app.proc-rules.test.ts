// The Processes pad's pure rules (extensions/processes/proc-rules.ts): groups and their order, the summary, the row's
// texts, the actions and "⋯" items per state, the badge, the board of the in-use dialog, the ports view, the timeline.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ProcCard, ProcEvent, ProcState, UseView } from '../../src/daemon/procs.ts'
import {
  chipOf, commandLine, EMPTY_TEXT, groupOf, inUseDialog, memoryText, menuActions, othersUses, portRowView, portViews, procBadge, procGroups,
  rowActions, runSeparator, summaryText, timelineItem, untilText, whenText,
} from '../../extensions/processes/proc-rules.ts'
import { clockTime } from '../../src/daemon/proc-texts.ts'

const card = (name: string, extra: Partial<ProcCard> = {}): ProcCard => ({
  v: 1, name, command: 'node', args: ['server.mjs', '3000'], cwd: 'C:\\w', env: {}, ports: [], stopGraceMs: 5000, info: {},
  registeredBy: { kind: 'app' }, createdAt: '2026-11-11T10:00:00.000Z', ...extra,
})
const proc = (name: string, extra: Partial<ProcState> = {}): ProcState => ({ name, card: card(name), status: 'running', ...extra })
const NOW = Date.parse('2026-11-11T12:00:00.000Z')

test('groups: attention, running, stopped, in that order, empty ones left out, each by name', () => {
  assert.equal(groupOf('exited'), 'attention')
  assert.equal(groupOf('host-lost'), 'attention')
  assert.equal(groupOf('failed'), 'attention')
  assert.equal(groupOf('stopping'), 'running')
  assert.equal(groupOf('stopped'), 'stopped')
  const g = procGroups([proc('web'), proc('b', { status: 'stopped' }), proc('dota', { status: 'exited' }), proc('api')])
  assert.deepEqual(g.map(x => [x.id, x.title, x.procs.map(p => p.name)]), [
    ['attention', 'Pedem atenção', ['dota']],
    ['running', 'Rodando', ['api', 'web']],
    ['stopped', 'Parados', ['b']],
  ])
  assert.deepEqual(procGroups([proc('a')]).map(x => x.id), ['running'])
  assert.deepEqual(procGroups([]), [])
  assert.match(EMPTY_TEXT, /^Nenhum processo\./)
})

test('summary: only the parts that are not zero; memory of live ones, in MB or GB with a comma', () => {
  const list = [
    ...['a', 'b', 'c', 'd', 'e'].map(n => proc(n, { memoryMB: 240 })),
    proc('x', { status: 'exited', memoryMB: 999 }),
    proc('s1', { status: 'stopped' }), proc('s2', { status: 'stopped' }),
  ]
  assert.equal(summaryText(list), '5 rodando · 1 pede atenção · 2 parados · ~1,2 GB')
  assert.equal(summaryText([proc('a', { memoryMB: 310 })]), '1 rodando · ~310 MB')
  assert.equal(summaryText([proc('a', { status: 'exited' }), proc('b', { status: 'failed' }), proc('c', { status: 'stopped' })]), '2 pedem atenção · 1 parado')
  assert.equal(summaryText([]), '')
  assert.equal(memoryText(1024), '1,0 GB')
})

test('row texts: time since it runs, how it ended with time and code, ports as links only while they listen', () => {
  assert.equal(whenText(proc('a', { startedAt: '2026-11-11T10:00:00.000Z' }), NOW), 'rodando há 2 h')
  assert.equal(whenText(proc('a', { startedAt: '2026-11-11T11:59:50.000Z' }), NOW), 'rodando agora')
  assert.equal(whenText(proc('a', { status: 'stopping' }), NOW), 'parando…')
  const at = '2026-11-11T13:41:00.000Z'
  const hm = clockTime(at).slice(0, 5)
  assert.equal(whenText(proc('a', { status: 'exited', exit: { code: 1, at, cause: 'own' } })), `encerrou sozinho ${hm} (1)`)
  assert.equal(whenText(proc('a', { status: 'stopped', exit: { code: 0, at, cause: 'requested' } })), `parado ${hm}`)
  assert.equal(whenText(proc('a', { status: 'host-lost', exit: { at, cause: 'host' } })), `caiu com o anfitrião ${hm}`)
  assert.equal(whenText(proc('a', { status: 'failed', error: 'x' })), 'não subiu')
  assert.deepEqual(portViews(proc('a', { ports: [{ port: 3000, listening: true }, { port: 27015, listening: false }] })), [
    { port: 3000, listening: true, text: 'localhost:3000 ✓', url: 'http://localhost:3000' },
    { port: 27015, listening: false, text: ':27015' },
  ])
  assert.deepEqual(portViews(proc('a', { card: card('a', { ports: [8080] }) })), [{ port: 8080, listening: false, text: ':8080' }])
})

test('chips: the pane\'s current name when it exists (focusable), else the portrait; the person is "você"', () => {
  const by = { kind: 'agent' as const, slotId: 's1', name: 'kai-velho', agent: 'claude' }
  assert.deepEqual(chipOf(by, { name: 'kai' }), { text: 'kai', slotId: 's1', focusable: true, icon: 'agent' })
  assert.deepEqual(chipOf(by, undefined), { text: 'kai-velho', slotId: 's1', focusable: false, icon: 'agent' })
  assert.deepEqual(chipOf({ kind: 'app' }, undefined), { text: 'você', focusable: false, icon: 'person' })
  assert.deepEqual(chipOf({ kind: 'external', label: 'ci', user: 'guga' }, undefined), { text: 'ci', focusable: false, icon: 'outside' })
  assert.deepEqual(chipOf({ kind: 'external', user: 'guga' }, undefined), { text: 'guga', focusable: false, icon: 'outside' })
  const until = '2026-11-11T14:20:00.000Z'
  assert.equal(untilText({ by, until, purpose: 'e2e' }), `até ${clockTime(until).slice(0, 5)}`)
})

test('actions: live → watch, restart, stop; ended → watch, start; the "⋯" holds or lets go and forgets only a stopped one', () => {
  assert.deepEqual(rowActions({ status: 'running' }), ['output', 'restart', 'stop'])
  assert.deepEqual(rowActions({ status: 'stopping' }), ['output'])
  for (const status of ['stopped', 'exited', 'host-lost', 'failed'] as const) assert.deepEqual(rowActions({ status }), ['output', 'start'])
  assert.deepEqual(menuActions(proc('a')), ['copy-command', 'history', 'hold'])
  const held: UseView = { by: { kind: 'app' }, until: '2026-11-11T14:20:00.000Z', purpose: 'segurado pela pessoa' }
  assert.deepEqual(menuActions(proc('a', { uses: [held] })), ['copy-command', 'history', 'release'])
  assert.deepEqual(menuActions(proc('a', { status: 'stopped' })), ['copy-command', 'history', 'forget'])
  assert.equal(commandLine({ command: 'node', args: ['dir com espaco/s.mjs', '3000', 'a"b'] }), 'node "dir com espaco/s.mjs" 3000 "a\\"b"')
})

test('badge: only what asks for attention counts; nothing when none', () => {
  assert.equal(procBadge([proc('a'), proc('b', { status: 'exited' })]), undefined)
  assert.deepEqual(procBadge([proc('b', { status: 'exited', attention: true }), proc('c', { status: 'host-lost', attention: true })]), { count: 2, attention: true, tooltip: '2 processos pedem atenção' })
  assert.equal(procBadge([proc('b', { status: 'exited', attention: true })])!.tooltip, '1 processo pede atenção')
})

test('in-use dialog: the board says who, until when, what for; waiting is the default, now is destructive', () => {
  const uses: UseView[] = [{ by: { kind: 'external', label: 'kai', user: 'guga' }, until: '2026-11-11T14:20:00.000Z', purpose: 'e2e do checkout' }]
  const d = inUseDialog('web', 'restart', uses)
  assert.equal(d.title, 'web está em uso')
  assert.deepEqual(d.context?.lines, [`kai (guga) até ${clockTime(uses[0]!.until)}: e2e do checkout`])
  assert.equal(d.defaultChoice, 'wait')
  assert.deepEqual(d.choices.map(c => [c.id, c.label, c.tone]), [['wait', 'Esperar o uso acabar', 'safe'], ['force', 'Reiniciar agora', 'destructive']])
  assert.ok(d.cancelLabel)
  assert.equal(inUseDialog('web', 'stop', uses).choices[1]!.label, 'Parar agora')
  assert.deepEqual(othersUses({ uses: [...uses, { by: { kind: 'app' }, until: uses[0]!.until, purpose: 'x' }] }), uses)
})

test('ports view: who listens (tether\'s process by name or "fora do tether"), free ports declared by stopped ones', () => {
  assert.deepEqual(portRowView({ port: 3000, listening: true, owner: { proc: 'web', pid: 10 }, declaredBy: [{ name: 'web', status: 'running' }] }),
    { port: 3000, listening: true, proc: 'web', who: 'web', declared: 'declarada por web (rodando)' })
  assert.deepEqual(portRowView({ port: 5432, listening: true, owner: { pid: 99, exe: 'postgres.exe' }, outside: true }),
    { port: 5432, listening: true, who: 'fora do tether: postgres.exe, pid 99', declared: '' })
  assert.deepEqual(portRowView({ port: 27015, listening: false, declaredBy: [{ name: 'dota', status: 'stopped' }] }),
    { port: 27015, listening: false, who: 'livre', declared: 'declarada por dota (parado)' })
})

test('timeline: time with seconds, who (tether for the system), the CLI\'s phrase, the reason', () => {
  const e: ProcEvent = { v: 1, ts: '2026-11-11T13:41:05.000Z', kind: 'restart-requested', run: 2, by: { kind: 'app' }, reason: 'travou' }
  assert.deepEqual(timelineItem(e), { time: clockTime(e.ts), who: 'você (pelo app)', what: 'pediu o reinício (execução 2)', reason: 'travou' })
  const end: ProcEvent = { v: 1, ts: '2026-11-11T13:41:06.000Z', kind: 'ended', run: 2, code: 0, cause: 'requested' }
  assert.equal(timelineItem(end).who, 'tether')
  assert.match(timelineItem(end).time, /^\d\d:\d\d:\d\d$/)
  assert.equal(runSeparator(3), '── execução 3 ──')
})
