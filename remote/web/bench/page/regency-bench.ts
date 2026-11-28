// The bench page of the Regency on the web: the real screen (src/regency.ts, the app's pane and channel view) over a made-up
// house (fake.ts), under the page's real CSP. To look at it by hand and to capture it. The state comes in the fragment:
//   #estado=offline | app-fechado     (default: the link is up and the app is open)
//   &aba=esperam | canal | mesas      the phone's place
//   &ficha=<pane id>                  the reading card of a pane (p6 is the one that waits)
//   &canal=<id>                       the channel in the centre (obra, extra, migra)
//   &tema=claro | escuro              (default: the system's)
//   &fala=1                           the device converses (the box, the speeches on their way, "Trancar")
// `data-ready` on <html> says the screen settled (what a capture waits for).
import { mountRegency } from '../../src/regency.ts'
import { createTalker, type Talker } from '../../src/talk.ts'
import { createManager, type Manager } from '../../src/manage.ts'
import { fakeHouse } from './fake.ts'

const q = new URLSearchParams(location.hash.slice(1))
const root = document.getElementById('app') as HTMLElement
root.dataset.view = 'regency'
const theme = q.get('tema')
if (theme === 'claro') document.documentElement.dataset.theme = 'light'
if (theme === 'escuro') document.documentElement.dataset.theme = 'dark'

const state = q.get('estado')

/**
 * `&fala=1`: the device converses. The talker goes over a made-up session that takes every act, and its storage (memory)
 * starts with two speeches on their way in #obra: one still "enviando" (the session answers it later), one "não enviada".
 */
function benchTalker(): Talker {
  const mem = new Map<string, string>()
  const store = { get: (k: string) => mem.get(k) ?? null, set: (k: string, v: string) => { mem.set(k, v) }, remove: (k: string) => { mem.delete(k) } }
  const at = Date.now() - 20_000
  mem.set('tether.remote.v1.bench.outbox', JSON.stringify({ v: 1, items: [
    { id: 'a'.repeat(32), channel: 'obra', text: 'Fica a de cima: é a que o time já usa.', to: ['conferente'], at, state: 'failed', why: 'slow-down' },
    { id: 'b'.repeat(32), channel: 'obra', text: 'E mandem a ata depois, por favor.', to: [], at: Date.now(), state: 'sending' },
  ] }))
  mem.set('tether.remote.v1.bench.drafts', JSON.stringify({ v: 1, drafts: { obra: 'Rascunho que sobreviveu ao recarregar' } }))
  const t = createTalker({ houseId: 'bench', store })
  // A session that never answers the speech "enviando" (it stays so for the capture) and takes every other act.
  t.attach({ ended: undefined, request: (op: number) => op === 0x0202 ? new Promise(() => {}) : Promise.resolve({ status: 0, body: { changed: true, seq: 1 } }) })
  return t
}

/**
 * `&gere=1` (with `&fala=1`): the device manages (step 5.4). Its made-up session holds every `manage:*` scope, lists two
 * processes (one an agent uses), has no ronda, and answers each act after a moment (the row says "fazendo…" meanwhile); the
 * biometrics always passes.
 */
function benchManager(): Manager {
  const m = createManager({
    credential: true,
    prover: {
      act: async () => ({ ok: true, uvProof: { uvCtr: 1, authenticatorData: new Uint8Array(37), clientDataJSON: new Uint8Array(1), signature: new Uint8Array(8) } }),
      window: async () => ({ ok: true }),
    },
  })
  const until = new Date(Date.now() + 25 * 60_000).toISOString()
  const procs = [
    { name: 'web', status: 'running', card: { command: '', cwd: 'C:/obra/web', ports: [5173], createdAt: '' }, envNames: [], ports: [{ port: 5173, listening: true }], startedBy: { kind: 'app' },
      uses: [{ by: { kind: 'agent', name: 'conferente' }, until, purpose: 'rodando a bateria de paginação' }] },
    { name: 'api', status: 'exited', card: { command: '', cwd: 'C:/obra/api', ports: [], createdAt: '' }, envNames: ['PORT'], exit: { code: 1, at: new Date(Date.now() - 4 * 60_000).toISOString(), cause: 'exit' }, attention: true },
  ]
  const answer = (op: number): { status: number; body: Record<string, unknown> } => {
    if (op === 0x0001) return { status: 0, body: { scopes: ['attention', 'channels', 'regency:read', 'manage:agents', 'manage:desks', 'manage:procs', 'manage:destructive'], deviceId: 'ab'.repeat(16) } }
    if (op === 0x0420) return { status: 0, body: { procs, more: 0 } }
    if (op === 0x0410) return { status: 0, body: { ronda: null } }
    if (op === 0x0423) return { status: 0x09, body: { error: 'proc-in-use', uses: procs[0]!.uses } }
    return { status: 0, body: { state: 'done' } }
  }
  m.attach({ ended: undefined, sessionId: new Uint8Array(16), request: (op: number) => new Promise(done => setTimeout(() => done(answer(op)), op >= 0x0430 ? 900 : 30)) })
  return m
}

const talk = q.get('fala') === '1' ? benchTalker() : undefined
const manage = talk && q.get('gere') === '1' ? benchManager() : undefined
const screen = mountRegency(root, { houseName: 'Máquina de casa', onRetry: () => { screen.retryIn(0) }, ...(talk ? { talk, onLock: () => {} } : {}), ...(manage ? { manage } : {}) })

const settle = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
const click = (selector: string): boolean => {
  const e = document.querySelector<HTMLElement>(selector)
  if (!e) return false
  e.click()
  return true
}

async function run(): Promise<void> {
  if (state === 'offline') {
    screen.offline({ lastContactMs: Date.now() - 3 * 60_000, retryInS: 12 })
  } else {
    screen.online(fakeHouse({ appClosed: state === 'app-fechado' }))
    // The readings are promises and the pane paints on a frame: wait for the tree, then drive what the fragment asks.
    await settle(300)
    const channel = q.get('canal')
    if (channel) click(`.rg-conv[data-target="channel:${CSS.escape(channel)}"]`)
    const tab = ({ esperam: 'waiting', canal: 'conversation', mesas: 'tether' } as Record<string, string>)[q.get('aba') ?? '']
    if (tab) click(`.rg-tab[data-tab="${tab}"]`)
    const card = q.get('ficha')
    if (card) {
      await settle(100)
      // An agent's pane is the target `agent:<id>`, any other pane `pane:<id>`.
      const id = CSS.escape(card)
      click(`.rg-tree [data-target="agent:${id}"], .rg-tree [data-target="pane:${id}"]`)
    }
    await settle(300)
    // `&sistema=processos|ronda`: "Sistema" open on that section. `&menu=<desk:x|pane:y|agent:y|session:z>`: the row's menu
    // (as a right click on it), then `&acao=<label>`: that row of the menu (its question, its sheet). `&fazendo=<label>`: the
    // row run and caught while its act is on its way.
    const sys = q.get('sistema')
    if (sys) {
      click('.rg-sys-open')
      await settle(200)
      click(`.rg-sys-tab[data-section="${sys === 'ronda' ? 'ronda' : 'processes'}"]`)
      await settle(300)
      if (q.get('parar')) { click(`.rg-sr.proc[data-proc="${CSS.escape(q.get('parar')!)}"] [data-sys="stop"]`); await settle(300) }
    }
    const menu = q.get('menu')
    if (menu) {
      const row = document.querySelector<HTMLElement>(`.rg-tree [data-target="${CSS.escape(menu)}"]`)
      const r = row?.getBoundingClientRect()
      row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: (r?.left ?? 0) + 60, clientY: (r?.top ?? 0) + 10 }))
      await settle(200)
      const label = q.get('acao') ?? q.get('fazendo')
      if (label) {
        const item = [...document.querySelectorAll<HTMLElement>('#ctx-menu .rr-mi')].find(b => b.textContent?.includes(label))
        item?.click()
        await settle(q.get('fazendo') ? 150 : 300)
      }
    }
  }
  // `&medir=1`: the boxes of the channel's column, for a capture that asks where the room went.
  if (q.get('medir') === '1') {
    const sizes = ['.rg-center', '.rg-embed', '.ch-pane', '.ch-conv', '.ch-msgs-wrap', '.ch-foot', '.rg-tabbar'].map(s => {
      const r = document.querySelector(s)?.getBoundingClientRect()
      return r ? `${s} ${Math.round(r.top)}-${Math.round(r.bottom)}` : `${s} -`
    })
    const fs = document.querySelector('.ch-foot')
    if (fs) { const cs = getComputedStyle(fs); sizes.push(`foot ${cs.display} ${cs.flex} h=${cs.height} pad=${cs.paddingBottom} zoom=${cs.zoom}`) }
    for (const e of [...document.querySelectorAll('.ch-foot > *, .ch-say > *')]) {
      const r = e.getBoundingClientRect()
      sizes.push(`${e.className || e.tagName} ${Math.round(r.top)}-${Math.round(r.bottom)}`)
    }
    document.documentElement.dataset.probe = sizes.join(' | ')
  }
  document.documentElement.dataset.ready = '1'
}

void run()
