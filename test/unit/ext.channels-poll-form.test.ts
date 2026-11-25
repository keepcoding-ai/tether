// The pure rules of the form that opens a poll (slice E4): validation before asking, the deadline, the options, the arguments sent,
// the `/enquete` command, the warning of who does not hear now and the words of the tether's refusals.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { USER } from '../../extensions/channels/rules.ts'
import {
  deadlineMs, deafOf, deafText, DEADLINES, emptyDraft, filledOptions, footText, pollCommand, refusalText, validateDraft, type PollDraft, type PollMember,
} from '../../extensions/channels/renderer/poll-form-rules.ts'

const draft = (over: Partial<PollDraft> = {}): PollDraft => ({ ...emptyDraft(['a', 'b']), question: 'Posso subir a ata?', ...over })

test('defaults: ok / não ok, every member called, 10 minutes, nobody else', () => {
  const d = emptyDraft(['a', 'b'])
  assert.deepEqual([d.kind, d.called, d.includeYou, d.deadline], ['ok', ['a', 'b'], false, '10'])
  const v = validateDraft(draft())
  assert.deepEqual(v.errors, {})
  assert.deepEqual(v.args, { question: 'Posso subir a ata?', to: ['a', 'b'], timeoutMs: 600_000 })
})

test('question: blank and over 300 characters are refused; whitespace is one line', () => {
  assert.equal(validateDraft(draft({ question: '   ' })).errors.question, 'Escreva a pergunta.')
  assert.match(validateDraft(draft({ question: 'x'.repeat(301) })).errors.question!, /300/)
  assert.equal(validateDraft(draft({ question: 'x'.repeat(300) })).errors.question, undefined)
  assert.equal(validateDraft(draft({ question: 'Qual\n  dia?' })).args?.question, 'Qual dia?')
})

test('choice: 2 to 6 options of up to 60, blank rows dropped, no repeat (case and accents do not tell them apart)', () => {
  const choice = (options: string[]): ReturnType<typeof validateDraft> => validateDraft(draft({ kind: 'choice', options }))
  assert.ok(choice(['terça', 'quarta']).args)
  assert.deepEqual(choice(['terça', '', 'quarta', '  ']).args?.options, ['terça', 'quarta'])
  assert.match(choice(['terça', '']).errors.options!, /ao menos 2/)
  assert.match(choice(['1', '2', '3', '4', '5', '6', '7']).errors.options!, /máximo 6/)
  assert.ok(choice(['1', '2', '3', '4', '5', '6']).args)
  assert.match(choice(['a'.repeat(61), 'b']).errors.options!, /60/)
  assert.ok(choice(['a'.repeat(60), 'b']).args)
  assert.match(choice(['Terça', 'terca']).errors.options!, /repetidas/)
  // The options of an ok poll are not sent, whatever is left in the rows.
  assert.equal(validateDraft(draft({ kind: 'ok', options: ['x', 'y'] })).args?.options, undefined)
  assert.deepEqual(filledOptions([' a  b ', '']), ['a b'])
})

test('who votes: at least one; "incluir você" adds the person and counts alone', () => {
  assert.match(validateDraft(draft({ called: [] })).errors.called!, /ao menos um/)
  assert.deepEqual(validateDraft(draft({ called: ['a'], includeYou: true })).args?.to, ['a', USER])
  assert.deepEqual(validateDraft(draft({ called: [], includeYou: true })).args?.to, [USER])
})

test('deadline: the chips, and "outro" from 1 min to 24 h in minutes or with units', () => {
  assert.deepEqual(DEADLINES.map(d => d.ms / 60_000), [5, 10, 30, 60])
  assert.equal(deadlineMs({ deadline: '30', other: '' }), 30 * 60_000)
  assert.equal(deadlineMs({ deadline: 'other', other: '1' }), 60_000)
  assert.equal(deadlineMs({ deadline: 'other', other: '90m' }), 90 * 60_000)
  assert.equal(deadlineMs({ deadline: 'other', other: '24h' }), 24 * 3_600_000)
  assert.equal(deadlineMs({ deadline: 'other', other: '0' }), undefined)
  assert.equal(deadlineMs({ deadline: 'other', other: '30s' }), undefined)
  assert.equal(deadlineMs({ deadline: 'other', other: '25h' }), undefined)
  assert.equal(deadlineMs({ deadline: 'other', other: 'logo' }), undefined)
  assert.match(validateDraft(draft({ deadline: 'other', other: '' })).errors.deadline!, /1 min a 24 h/)
  assert.equal(validateDraft(draft({ deadline: 'other', other: '1' })).args?.timeoutMs, 60_000)
})

test('every error at once, and no args while there is one', () => {
  const v = validateDraft(draft({ question: '', kind: 'choice', options: ['a', ''], called: [], deadline: 'other', other: 'x' }))
  assert.deepEqual(Object.keys(v.errors).sort(), ['called', 'deadline', 'options', 'question'])
  assert.equal(v.args, undefined)
})

test('/enquete: alone or with a question opens the form; any other text is a speech', () => {
  assert.deepEqual(pollCommand('/enquete'), { question: '' })
  assert.deepEqual(pollCommand('  /ENQUETE  '), { question: '' })
  assert.deepEqual(pollCommand('/enquete Qual dia?'), { question: 'Qual dia?' })
  assert.equal(pollCommand('/enquetes'), undefined)
  assert.equal(pollCommand('veja /enquete'), undefined)
  assert.equal(pollCommand('oi'), undefined)
})

test('who does not hear now: only the called, only the ones whose path is not inside or terminal', () => {
  const m = (id: string, name: string, path: string): PollMember => ({ id, name, muted: false, path })
  const all = [m('a', 'nic', 'inside'), m('b', 'conferência', 'terminal'), m('c', 'bancada', 'away'), m('d', 'mesa', 'wait')]
  assert.deepEqual(deafOf(all, ['a', 'b', 'c']).map(x => x.name), ['bancada'])
  assert.deepEqual(deafOf(all, ['c', 'd']).map(x => x.name), ['bancada', 'mesa'])
  assert.deepEqual(deafOf(all, ['a']), [])
  const now = Date.parse('2026-11-24T10:32:00')
  assert.match(deafText(deafOf(all, ['c']), now, 600_000), /^bancada não ouve agora: recebe se voltar antes de \d\d:\d\d\.$/)
  assert.match(deafText(deafOf(all, ['c', 'd']), now, 600_000), /^bancada, mesa não ouvem agora: recebem se voltar/)
  assert.equal(deafText([], now, 600_000), '')
})

test('foot: when it closes and how many are asked', () => {
  const now = Date.parse('2026-11-24T10:32:00')
  assert.match(footText(now, 600_000, 4), /^Fecha às \d\d:\d\d ou quando os 4 votarem$/)
  assert.match(footText(now, 600_000, 1), /ou quando o voto chegar$/)
  assert.match(footText(now, undefined, 4), /prazo/)
})

test('the tether refuses: each code has its words, an unknown one still says its code', () => {
  for (const code of ['vote-first', 'limit', 'slow-down', 'nobody-called', 'closed', 'too-long', 'bad-request']) assert.doesNotMatch(refusalText(code), /recusou/)
  assert.match(refusalText('vote-first'), /vote nela antes/)
  assert.match(refusalText('weird'), /\(weird\)/)
})
