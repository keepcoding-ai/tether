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

const talk = q.get('fala') === '1' ? benchTalker() : undefined
const screen = mountRegency(root, { houseName: 'Máquina de casa', onRetry: () => { screen.retryIn(0) }, ...(talk ? { talk, onLock: () => {} } : {}) })

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
