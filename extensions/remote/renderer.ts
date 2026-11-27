// The remote extension in the app (RR2.2): the state icon of the top bar (off / on with nobody / N devices connected; a
// click brings the Regency's "Sistema › Aparelhos" forward), and the "Aparelhos" view the Regency embeds through the feed
// (renderer/embed.ts). The status is asked of the daemon half (`remote.status`): every few seconds, faster while the view
// is on screen, and right after each act. The pairing requests (pair.*) go only from this screen (E-7): the daemon refuses
// them from anything but the app.
import type { Disposable, TetherUi } from '../../app/renderer/ext-api.ts'
import { STATUS_ID } from './manifest.ts'
import { liveCount, remoteIcon, type RemoteStatusInput } from './rules.ts'
import { DevicesView } from './renderer/devices-view.ts'
import { remoteEmbeds } from './renderer/embed.ts'

export { manifest } from './manifest.ts'

const POLL_MS = 5_000
const POLL_SHOWN_MS = 1_500
const PAIR_TICK_MS = 500

export function activate(ui: TetherUi): Disposable[] {
  let status: RemoteStatusInput | undefined
  let shown = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let feed: { dispose(): void } | undefined
  let view: DevicesView | undefined
  let disposed = false
  const listeners = new Set<() => void>()
  const changed = (): void => { handle.update(); view?.paint(); for (const l of [...listeners]) l() }

  const refresh = async (): Promise<void> => {
    try {
      status = await ui.daemon.request<RemoteStatusInput>('remote.status')
      // The daemon half answers: the "Aparelhos" section exists from now on.
      feed ??= remoteEmbeds.publish(source)
    } catch {
      status = undefined
    }
    changed()
  }
  const loop = (): void => {
    clearTimeout(timer)
    if (disposed) return
    timer = setTimeout(() => { void refresh().finally(loop) }, shown ? POLL_SHOWN_MS : POLL_MS)
  }

  const viewOf = (): DevicesView => {
    view ??= new DevicesView({
      status: () => status,
      request: (name, args) => ui.daemon.request(name, args),
      refresh,
      webUrl: () => status?.webUrl,
      now: () => Date.now(),
      pairTickMs: PAIR_TICK_MS,
    })
    return view
  }

  const source = {
    summary: () => {
      const i = remoteIcon(status)
      return { on: status?.on === true, devices: (status?.devices ?? []).filter(d => d.state !== 'revoked').length, live: status ? liveCount(status) : 0, text: i.title }
    },
    element: () => { const v = viewOf(); v.paint(); return v.element },
    setShown: (on: boolean) => {
      if (shown === on) return
      shown = on
      if (on) void refresh().finally(loop)
    },
    onDidChange: (l: () => void) => { listeners.add(l); return { dispose: () => { listeners.delete(l) } } },
  }

  const closePopover = (): void => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) }
  const handle = ui.status.register({
    id: STATUS_ID,
    title: () => remoteIcon(status).title,
    state: () => remoteIcon(status).state,
    badge: () => remoteIcon(status).badge,
    // A click goes to "Aparelhos" (the Regency's Sistema); without the Regency, the popover says the state.
    render: pop => {
      pop.replaceChildren()
      const p = document.createElement('p')
      p.className = 'rr-pop'
      p.textContent = remoteIcon(status).title
      pop.append(p)
      if (remoteEmbeds.reveal()) queueMicrotask(closePopover)
    },
  })

  ui.test.expose('devices', () => view?.snapshot())
  ui.test.expose('icon', () => remoteIcon(status))
  ui.test.expose('refresh', () => refresh())
  ui.test.expose('reveal', () => remoteEmbeds.reveal())

  void refresh().finally(loop)
  return [
    handle,
    { dispose: () => { disposed = true; clearTimeout(timer); feed?.dispose(); view?.dispose() } },
  ]
}
