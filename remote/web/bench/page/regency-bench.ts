// The bench page of the Regency on the web: the real screen (src/regency.ts, the app's pane and channel view) over a made-up
// house (fake.ts), under the page's real CSP. To look at it by hand and to capture it. The state comes in the fragment:
//   #estado=offline | app-fechado     (default: the link is up and the app is open)
//   &aba=esperam | canal | mesas      the phone's place
//   &ficha=<pane id>                  the reading card of a pane (p6 is the one that waits)
//   &canal=<id>                       the channel in the centre (obra, extra, migra)
//   &tema=claro | escuro              (default: the system's)
// `data-ready` on <html> says the screen settled (what a capture waits for).
import { mountRegency } from '../../src/regency.ts'
import { fakeHouse } from './fake.ts'

const q = new URLSearchParams(location.hash.slice(1))
const root = document.getElementById('app') as HTMLElement
root.dataset.view = 'regency'
const theme = q.get('tema')
if (theme === 'claro') document.documentElement.dataset.theme = 'light'
if (theme === 'escuro') document.documentElement.dataset.theme = 'dark'

const state = q.get('estado')
const screen = mountRegency(root, { houseName: 'Máquina de casa', onRetry: () => { screen.retryIn(0) } })

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
  document.documentElement.dataset.ready = '1'
}

void run()
