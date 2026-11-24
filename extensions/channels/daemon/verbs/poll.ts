// `channels poll`: I ask every member (or the ones I name) for an answer by a deadline, instead of asking in a message. The
// tether writes the poll from the arguments (type, options, who is called, the absolute deadline) and closes it by itself when
// everyone called voted or the deadline passed. In this version nobody is told of it: `channels read` shows it.
import { parsePollTimeout, POLL_TIMEOUT_DEFAULT_MS } from '../../rules.ts'
import { CANAL_PROP, clockText, ok, optStrings, refOf, refuse, resolveChannel, settle, wantString, whoByRef, type VerbDef } from './common.ts'

export const pollVerb: VerbDef = {
  name: 'poll',
  description: 'Open a poll to get an answer from each member by a deadline, instead of asking in a message. Without `options` it is ok / não ok; with 2 to 6 `options`, a single choice. `to` names who is called (default: every agent member but you; the person only when named, as `usuário`). `timeout`: 1m to 24h, default 10m. One open poll per author per channel, 3 per channel; who owes a vote there votes first.',
  help: 'Abre uma enquete (--options A --options B, --to nome, --timeout 10m).',
  input: {
    type: 'object',
    properties: {
      canal: CANAL_PROP,
      question: { type: 'string', description: 'The question, up to 300 characters.' },
      options: { type: 'array', items: { type: 'string' }, description: '2 to 6 options of up to 60 characters; none: ok / não ok.' },
      to: { type: 'array', items: { type: 'string' }, description: 'Who is called: member names or ids, `usuário` for the person.' },
      timeout: { type: 'string', description: 'The deadline from now: 90s, 10m, 1h (1m to 24h). Default 10m.' },
    },
    required: ['canal', 'question'],
  },
  positional: ['canal', 'question'],
  async run(deps, caller, args) {
    const ch = resolveChannel(deps, wantString(args, 'canal'))
    const question = wantString(args, 'question')
    const options = optStrings(args, 'options')
    const raw = args.timeout
    let timeoutMs = POLL_TIMEOUT_DEFAULT_MS
    if (raw !== undefined && raw !== null && raw !== '') {
      const ms = parsePollTimeout(raw)
      if (ms === undefined) refuse('bad-request', 'timeout: de 1m a 24h (ex.: 90s, 10m, 1h)')
      timeoutMs = ms
    }
    const refs = optStrings(args, 'to')
    const to = refs?.length ? [...new Set(refs.map((r) => whoByRef(deps, ch, r)))] : undefined
    const done = settle(await deps.channels.poll(caller.slotId, ch.id, { question, ...(options ? { options } : {}), ...(to ? { to } : {}), timeoutMs }), {
      limit: 'enquetes abertas demais: 1 por autor e 3 por canal; espere uma fechar',
      'slow-down': 'enquetes demais em pouco tempo: 5 por hora neste canal',
      'bad-request': 'pergunta vazia, opções fora de 2 a 6 (vazias ou repetidas) ou prazo fora de 1m a 24h',
    })
    const p = done.poll
    const ref = `${ch.name}#${p.seq}`
    const opts = p.options.map((o, i) => `${i + 1} ${o}`).join(', ')
    const text = `Enquete ${ref} aberta (opções: ${opts}). Chamou ${p.to.map((t) => t.name).join(', ')}. Fecha às ${clockText(p.closesAt, Date.parse(p.closesAt) - timeoutMs)}. Ninguém é avisado nesta versão; veja votos e resultado com channels_read.`
    return ok(text, {
      channel: refOf(ch), ref, seq: p.seq, type: p.type, question: p.question, options: p.options,
      to: p.to.map((t) => ({ id: t.id, name: t.name })), closesAt: p.closesAt,
    })
  },
}
