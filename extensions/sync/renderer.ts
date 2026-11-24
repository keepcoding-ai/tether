// The sync extension's renderer side: the status icon on the top bar while there is a link (registered while statusVisible,
// disposed otherwise: a function that is off takes no room), its popover (remote, machine, when, the result in one line and
// what needs a look; "Sincronizar agora", "Desconectar…"), and the two palette commands, each registered with its `when` in
// code so it shows only when it serves. The state comes from main's `state` event: no polling here. The texts and rules
// are rules.ts (unit-tested).
import type { TetherUi } from '../../app/renderer/ext-api.ts'
import type { StatusHandle } from '../../app/renderer/status-rules.ts'
import { icon } from '../../app/renderer/icons.ts'
import { commandFromContribution } from '../../app/renderer/commands.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { toDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { SyncChannels } from './ipc.ts'
import { CMD, STATUS_ID, manifest } from './manifest.ts'
import { EMPTY_VIEW, URL_PICK, connectAvailable, disconnectDialog, failedDialog, looksLikeGitUrl, nowAvailable, popoverOf, stateOf, statusVisible, titleOf, urlRow, type SyncView } from './rules.ts'

export { manifest } from './manifest.ts'

export function activate(ui: TetherUi): IDisposable[] {
  const ipc = ui.ipc<SyncChannels>()
  let view: SyncView = { ...EMPTY_VIEW }
  let handle: StatusHandle | undefined
  let acting = false

  const el = (tag: string, className?: string, text?: string): HTMLElement => {
    const e = document.createElement(tag)
    if (className) e.className = className
    if (text !== undefined) e.textContent = text
    return e
  }
  /** The status popover has no close call of its own: the core closes it on Escape. */
  const closePopover = (): void => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) }

  const render = (pop: HTMLElement): void => {
    const now = Date.now()
    const m = popoverOf(view, now)
    pop.classList.add('sync-pop')
    pop.dataset.state = m.state

    const head = el('div', 'sync-pop-head')
    head.append(icon('arrows-clockwise'), el('span', 'sync-pop-title', 'Sincronização'), el('span', 'sync-pop-when', m.when))
    pop.append(head)

    const facts = el('dl', 'sync-facts')
    facts.append(el('dt', '', 'Repositório'), el('dd', 'sync-remote', m.remote), el('dt', '', 'Esta máquina'), el('dd', 'sync-machine', m.machine))
    pop.append(facts)

    if (m.headline) { const h = el('p', `sync-result ${m.tone}`, m.headline); h.setAttribute('role', 'status'); pop.append(h) }
    if (m.details.length) {
      const ul = el('ul', 'sync-details')
      for (const d of m.details) { const li = el('li', `sync-detail ${d.kind}`, d.text); ul.append(li) }
      pop.append(ul)
    }

    const foot = el('div', 'sync-foot')
    const now$ = el('button', 'sync-now', view.running ? 'Sincronizando…' : 'Sincronizar agora') as HTMLButtonElement
    now$.type = 'button'
    now$.dataset.action = 'now'
    now$.disabled = view.running || acting
    now$.addEventListener('click', ev => { ev.stopPropagation(); void syncNow() })
    const off = el('button', 'sync-disconnect', 'Desconectar…') as HTMLButtonElement
    off.type = 'button'
    off.dataset.action = 'disconnect'
    off.disabled = view.running || acting
    off.addEventListener('click', ev => { ev.stopPropagation(); closePopover(); void disconnect() })
    foot.append(now$, off)
    pop.append(foot)
  }

  const syncIcon = (): void => {
    if (statusVisible(view)) {
      handle ??= ui.status.register({ id: STATUS_ID, title: () => titleOf(view, Date.now()), state: () => stateOf(view), render })
      handle.update()
    } else if (handle) { handle.dispose(); handle = undefined }
  }

  const apply = (v: SyncView): void => { view = v; syncIcon() }

  const act = async <T>(fn: () => Promise<T>): Promise<T> => {
    acting = true
    handle?.update()
    try { return await fn() } finally { acting = false; handle?.update() }
  }

  const syncNow = async (): Promise<void> => {
    const r = await act(() => ipc.invoke('now'))
    if (r.ok) apply(r.view)
    else await ui.dialogs.ask(failedDialog('Não deu para sincronizar', r.message))
  }

  const connect = async (): Promise<void> => {
    const url = await ui.pick.list<string>({ title: URL_PICK.title, placeholder: URL_PICK.placeholder, emptyText: URL_PICK.empty, items: [], create: urlRow })
    if (url === undefined) return
    if (!looksLikeGitUrl(url)) { await ui.dialogs.ask(failedDialog('Endereço não reconhecido', 'Isso não parece o endereço de um repositório git: use https://…, ssh://… ou git@servidor:caminho.')); return }
    const r = await act(() => ipc.invoke('connect', url))
    if (r.ok) apply(r.view)
    else await ui.dialogs.ask(failedDialog('Não deu para conectar', r.message))
  }

  const disconnect = async (): Promise<void> => {
    const a = await ui.dialogs.ask(disconnectDialog(view))
    if (a.choice !== 'disconnect') return
    const r = await act(() => ipc.invoke('disconnect'))
    if (r.ok) apply(r.view)
    else await ui.dialogs.ask(failedDialog('Não deu para desconectar', r.message))
  }

  // Each command is shown only when it serves: the manifest's title/category/icon with a `when` over the link's state.
  const declared = (id: string) => manifest.contributes!.commands!.find(c => c.command === id)!
  const commands = ui.commands.register(
    { ...commandFromContribution(declared(CMD.connect), () => { void connect() }), when: () => connectAvailable(view) },
    { ...commandFromContribution(declared(CMD.now), () => { void syncNow() }), when: () => nowAvailable(view) },
  )

  const onState = ipc.on('state', apply)
  void ipc.invoke('state').then(apply).catch(() => undefined)

  ui.test.expose('sync', { view: (): SyncView => view, visible: (): boolean => handle !== undefined })

  return [commands, onState, toDisposable(() => { handle?.dispose(); handle = undefined })]
}
