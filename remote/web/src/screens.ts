// The screens of the skeleton, one thing per screen (designed at 390 px; the wider tiers are derived in app.css).
// Each one is a function of what it shows and of the handlers it calls; nothing here talks to the wire.
import { kindLabel, waitedFor, type WaitingList } from './attention.ts'
import { h, type Child } from './dom.ts'
import type { PairFailKind } from './pair.ts'

export type PairNotice = 'bad-code' | 'used-code' | 'unreachable' | 'not-accepted' | 'revoked' | 'pending-failed'

const PAIR_NOTICE: Record<PairNotice, { tone: 'warn' | 'err'; text: string }> = {
  'bad-code': { tone: 'warn', text: 'O código tem 12 dígitos. Confira e digite de novo.' },
  'used-code': { tone: 'warn', text: 'Este código já foi usado. Peça um código novo na máquina.' },
  unreachable: { tone: 'warn', text: 'Não consegui chegar ao serviço de conexão. Confira a internet e tente de novo.' },
  'not-accepted': { tone: 'warn', text: 'A máquina não reconheceu este código: ele pode estar errado ou ter expirado, ou a máquina pode estar offline.' },
  revoked: { tone: 'err', text: 'Este aparelho foi desconectado na máquina. Para usar de novo, pareie outra vez.' },
  'pending-failed': { tone: 'warn', text: 'O pareamento não se completou na máquina. Peça um código novo.' },
}

const PAIR_FAIL: Record<Exclude<PairFailKind, PairNotice>, { title: string; text: string }> = {
  refused: {
    title: 'A máquina recusou o pareamento',
    text: 'Os números podem ter sido digitados errado, o tempo pode ter acabado ou o pareamento foi cancelado na máquina. Peça um código novo na máquina.',
  },
  expired: { title: 'O tempo do pareamento acabou', text: 'Peça um código novo na máquina e tente de novo.' },
  'not-confirmed': { title: 'A máquina não confirmou este pareamento', text: 'Nada foi guardado neste aparelho. Peça um código novo na máquina.' },
  cut: { title: 'A conexão caiu durante o pareamento', text: 'Este código não vale mais. Peça um código novo na máquina.' },
}

export const isPairNotice = (k: PairFailKind): k is PairFailKind & PairNotice => k in PAIR_NOTICE

function screen(name: string, ...children: Child[]): HTMLElement {
  return h('section', { class: `screen screen--${name}`, 'data-screen': name }, ...children)
}

function head(title: string, eyebrow = 'Tether remoto'): HTMLElement {
  return h('header', { class: 'screen-head' }, h('p', { class: 'eyebrow' }, eyebrow), h('h1', {}, title))
}

function notice(tone: 'ok' | 'warn' | 'err', text: string): HTMLElement {
  return h('p', { class: `notice notice--${tone}`, role: tone === 'ok' ? 'status' : 'alert' }, text)
}

function button(label: string, onClick: () => void, kind: 'primary' | 'quiet' = 'primary'): HTMLButtonElement {
  const b = h('button', { type: 'button', class: `btn btn--${kind}` }, label)
  b.addEventListener('click', onClick)
  return b
}

export function pairScreen(o: { notice?: PairNotice; value?: string; onSubmit: (code: string) => void }): HTMLElement {
  const input = h('input', {
    id: 'pair-code', name: 'code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', autocapitalize: 'off',
    spellcheck: 'false', enterkeyhint: 'go', maxlength: '40', placeholder: '000 000 000 000', 'aria-describedby': 'pair-help',
  })
  if (o.value) input.value = o.value
  const form = h('form', { class: 'stack', 'aria-label': 'Código de pareamento' },
    h('label', { for: 'pair-code', class: 'field-label' }, 'Código de 12 dígitos'),
    input,
    h('button', { type: 'submit', class: 'btn btn--primary' }, 'Continuar'),
  )
  form.addEventListener('submit', (ev) => { ev.preventDefault(); o.onSubmit(input.value) })
  const n = o.notice ? PAIR_NOTICE[o.notice] : undefined
  return screen('pair',
    head('Parear este aparelho'),
    n && notice(n.tone, n.text),
    h('p', { class: 'lead', id: 'pair-help' }, 'Na máquina, peça no tether um código de pareamento e digite aqui os 12 dígitos que aparecem.'),
    form,
  )
}

export function pairWaitScreen(o: { sas?: string }): HTMLElement {
  if (o.sas === undefined) {
    return screen('pair-wait', head('Parear este aparelho'), h('p', { class: 'status', role: 'status' }, 'Falando com a máquina…'))
  }
  const shown = `${o.sas.slice(0, 3)} ${o.sas.slice(3)}`
  return screen('sas',
    head('Digite na máquina'),
    h('p', { class: 'lead' }, 'Na tela do tether, digite estes seis números:'),
    h('p', { class: 'sas', 'aria-label': o.sas.split('').join(' ') }, shown),
    h('p', { class: 'status', role: 'status' }, h('span', { class: 'dot dot--wait', 'aria-hidden': 'true' }), 'Esperando a máquina confirmar…'),
    h('p', { class: 'fine' }, 'Digite-os você mesmo, só na sua máquina. Se alguém pedir estes números, não os passe adiante.'),
  )
}

export function pairFailedScreen(kind: Exclude<PairFailKind, PairNotice>, onAgain: () => void): HTMLElement {
  const f = PAIR_FAIL[kind]
  return screen('pair-failed', head(f.title), h('p', { class: 'lead' }, f.text), button('Digitar outro código', onAgain))
}

export function connectingScreen(): HTMLElement {
  return screen('connecting', head('Esperam você'), h('p', { class: 'status', role: 'status' }, 'Conectando ao seu tether…'))
}

/** The relay refused or the link fell: the device cannot tell why (spec 5.3), so it says it without certainty. */
export function offlineScreen(o: { retryInS: number | undefined; onRetry: () => void }): HTMLElement {
  return screen('offline',
    head('Seu tether está offline'),
    h('p', { class: 'lead' }, 'Não consegui falar com a máquina. Ela pode estar desligada, dormindo ou sem rede.'),
    h('p', { class: 'status' }, h('span', { class: 'dot dot--warn', 'aria-hidden': 'true' }), h('span', { class: 'status-text' }, retryText(o.retryInS))),
    button('Tentar agora', o.onRetry),
  )
}

/** Hard error (spec 4.2 rule 3): the house did not prove its key. No "pair again" here; only a later retry. */
export function hardScreen(o: { retryInS: number | undefined; onRetry: () => void }): HTMLElement {
  return screen('hard',
    head('A máquina não provou quem é'),
    h('p', { class: 'lead' }, 'A resposta não veio da máquina que este aparelho conhece. Pode ser um problema de rede, ou alguém tentando se passar por ela. Nada deste aparelho foi revelado.'),
    h('p', { class: 'status' }, h('span', { class: 'dot dot--err', 'aria-hidden': 'true' }), h('span', { class: 'status-text' }, retryText(o.retryInS))),
    button('Tentar agora', o.onRetry),
  )
}

export function idleScreen(onConnect: () => void): HTMLElement {
  return screen('idle', head('A sessão fechou por falta de uso'), h('p', { class: 'lead' }, 'Para ver quem espera você, conecte de novo.'), button('Conectar', onConnect))
}

export function unsupportedScreen(): HTMLElement {
  return screen('unsupported',
    head('Este navegador não serve'),
    h('p', { class: 'lead' }, 'Ele não tem a criptografia ou o armazenamento de que o tether precisa para guardar a chave deste aparelho com segurança.'),
  )
}

export function retryText(s: number | undefined): string {
  return s === undefined || s <= 0 ? 'Tentando agora…' : `Tento de novo em ${s} s.`
}

export function listScreen(o: { list: WaitingList; nowMs: number; houseName: string; notice?: string; problem?: string }): HTMLElement {
  const where = o.houseName ? `Conectado a ${o.houseName}` : 'Conectado'
  const items = o.list.items.map((w) =>
    h('li', { class: 'waiting-item', 'data-id': w.id, 'data-since': String(w.sinceMs) },
      h('span', { class: 'wi-name' }, w.name),
      h('span', { class: 'wi-meta' }, h('span', { class: 'wi-kind' }, kindLabel(w.kind)), h('span', { class: 'wi-sep', 'aria-hidden': 'true' }, '·'), h('span', { class: 'wi-since' }, waitedFor(w.sinceMs, o.nowMs))),
    ))
  const body: Child = o.problem
    ? notice('warn', o.problem)
    : items.length === 0
      ? h('div', { class: 'empty' }, h('p', { class: 'empty-title' }, 'Ninguém espera você agora.'), h('p', { class: 'fine' }, 'Quando um agente pedir a sua atenção, ele aparece aqui.'))
      : h('ul', { class: 'waiting', 'aria-live': 'polite' }, ...items)
  return screen('list',
    h('header', { class: 'screen-head list-head' },
      h('h1', {}, 'Esperam você'),
      h('p', { class: 'meta' }, h('span', { class: 'dot dot--ok', 'aria-hidden': 'true' }), h('span', { class: 'meta-text' }, where)),
    ),
    o.notice && notice('ok', o.notice),
    body,
    o.list.more > 0 && h('p', { class: 'fine more' }, `e mais ${o.list.more} esperando`),
  )
}
