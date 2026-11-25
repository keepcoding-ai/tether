// The page in the person's hands, on the main side (navegador da pessoa, F3; rules in page-rules.ts). Everything goes through
// the core's own (root) debugger session of each tab, where Page is enabled and the file chooser intercepted (tabs.ts,
// holdNativeSurfaces), and through the page's `before-input-event`:
//   - JavaScript dialogs: every one the page opens is known here; while she holds the tab it goes to the band of its pane
//     (`ask`), and her answer goes back as `Page.handleJavaScriptDialog`. A dialog opened while the agent had the tab stays the
//     agent's until she takes the tab (the agent can no longer answer it then); one opened while she held it is dismissed when
//     the tab leaves her (the agent never saw it open).
//   - the file chooser: while she holds the tab the tether's chooser opens (`chooseFiles`) and the files go to the input
//     (`DOM.setFileInputFiles`), unless the tab changed hands meanwhile. With the agent, nothing here: its own session answers.
//   - Ctrl+T and Ctrl+L typed in the page: kept from the page and handed to the interface (`key`), the keyboard back on it.
import { randomUUID } from 'node:crypto'
import type { Event as ElectronEvent } from 'electron'
import type { Surface } from '../../app/main/ext-api.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import type { Control } from './control-rules.ts'
import {
  choiceStands, chooserProperties, chosenFiles, dialogReply, type PageDialogAsk, pageDialogOf, type PageInput, type PageKey, pageKeyOf,
  servesPerson,
} from './page-rules.ts'

export interface PersonPageOptions {
  surface(tabId: string): Surface | undefined
  control(tabId: string): Control
  /** A dialog for the band of the tab's pane. */
  ask(ask: PageDialogAsk): void
  /** The band's dialog is gone (answered elsewhere, closed by the page, the tab left her). */
  cancelled(id: string): void
  /** A shortcut she typed in the page. */
  key(tabId: string, key: PageKey): void
  /** The tether's file chooser: the paths she chose ([] when she cancelled). */
  chooseFiles(properties: ('openFile' | 'multiSelections')[]): Promise<string[]>
  log(msg: string): void
}

interface OpenDialog { ask: PageDialogAsk; shown: boolean; /** Opened while she held the tab. */ hers: boolean }
interface TabState { subs: IDisposable[]; dialog?: OpenDialog; epoch: number; choosing: boolean }

export class PersonPage {
  private readonly opts: PersonPageOptions
  private readonly tabs = new Map<string, TabState>()

  constructor(opts: PersonPageOptions) { this.opts = opts }

  /** A tab exists (its surface is up): its root session and keys are followed until it closes. */
  added(tabId: string): void {
    const surface = this.opts.surface(tabId)
    if (!surface || this.tabs.has(tabId)) return
    const t: TabState = { subs: [], epoch: 0, choosing: false }
    this.tabs.set(tabId, t)
    t.subs.push(surface.debugger.onMessage((method, params, sessionId) => {
      if (sessionId !== undefined || this.tabs.get(tabId) !== t) return
      if (method === 'Page.javascriptDialogOpening') this.opened(tabId, t, params)
      else if (method === 'Page.javascriptDialogClosed') this.gone(t)
      else if (method === 'Page.fileChooserOpened') void this.choose(tabId, t, surface, params)
    }))
    const wc = surface.webContents
    const onKey = (e: ElectronEvent, input: PageInput): void => {
      const key = pageKeyOf(input, this.opts.control(tabId))
      if (!key) return
      e.preventDefault()
      surface.focusInterface()
      this.opts.key(tabId, key)
    }
    wc.on('before-input-event', onKey as never)
    t.subs.push({ dispose: () => { if (!wc.isDestroyed()) wc.off('before-input-event', onKey as never) } })
  }

  closed(tabId: string): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    this.tabs.delete(tabId)
    this.gone(t)
    for (const s of t.subs) s.dispose()
  }

  /** The tab's control changed: a chooser still open loses its right to answer; the dialog follows who holds the tab. */
  controlChanged(tabId: string, control: Control): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    t.epoch++
    const d = t.dialog
    if (!d) return
    if (servesPerson(control)) { if (!d.shown) this.show(d); return }
    if (d.shown) { d.shown = false; this.opts.cancelled(d.ask.id) }
    // Opened while she held the tab: the agent never saw it open and could not answer it; the page goes on, cancelled.
    if (d.hers) this.reply(tabId, t, false)
  }

  /** Her answer from the band; ignored unless that dialog is still open and she still holds the tab. */
  answer(id: unknown, accept: unknown, text?: unknown): void {
    if (typeof id !== 'string') return
    for (const [tabId, t] of this.tabs) {
      if (t.dialog?.ask.id !== id) continue
      if (!servesPerson(this.opts.control(tabId))) return
      this.reply(tabId, t, accept, text)
      return
    }
  }

  /** The dialogs her bands show now (the renderer asks when it starts). */
  open(): PageDialogAsk[] {
    return [...this.tabs.values()].flatMap(t => (t.dialog?.shown ? [t.dialog.ask] : []))
  }

  dispose(): void {
    for (const id of [...this.tabs.keys()]) this.closed(id)
  }

  private opened(tabId: string, t: TabState, params: unknown): void {
    const d = pageDialogOf(params)
    if (!d) return
    if (t.dialog?.shown) this.opts.cancelled(t.dialog.ask.id)
    const hers = servesPerson(this.opts.control(tabId))
    t.dialog = { ask: { id: randomUUID(), tabId, ...d }, shown: false, hers }
    if (hers) this.show(t.dialog)
  }

  private show(d: OpenDialog): void {
    d.shown = true
    // A dialog she inherits from the agent counts as hers from now on.
    d.hers = true
    this.opts.ask(d.ask)
  }

  /** The page closed its dialog (answered, navigated, the tab went): the band lets it go. */
  private gone(t: TabState): void {
    const d = t.dialog
    if (!d) return
    t.dialog = undefined
    if (d.shown) this.opts.cancelled(d.ask.id)
  }

  private reply(tabId: string, t: TabState, accept: unknown, text?: unknown): void {
    const d = t.dialog
    if (!d) return
    t.dialog = undefined
    const surface = this.opts.surface(tabId)
    if (!surface) return
    surface.debugger.send('Page.handleJavaScriptDialog', dialogReply(d.ask.kind, accept, text))
      .catch(e => this.opts.log(`guia ${tabId}: diálogo da página não respondido (${(e as Error).message})`))
  }

  private async choose(tabId: string, t: TabState, surface: Surface, params: unknown): Promise<void> {
    if (t.choosing || !servesPerson(this.opts.control(tabId))) return
    const p = (params && typeof params === 'object' ? params : {}) as { mode?: unknown; backendNodeId?: unknown }
    if (typeof p.backendNodeId !== 'number') return
    const at = { tab: t, epoch: t.epoch }
    const properties = chooserProperties(p.mode)
    t.choosing = true
    try {
      const files = chosenFiles(await this.opts.chooseFiles(properties).catch(() => []), properties.includes('multiSelections'))
      if (!choiceStands(at, { tab: this.tabs.get(tabId), epoch: t.epoch, control: this.opts.control(tabId) })) {
        if (files.length) this.opts.log(`guia ${tabId}: arquivos escolhidos recusados (a guia mudou de mão enquanto o seletor estava aberto)`)
        return
      }
      if (files.length === 0 || surface.webContents.isDestroyed()) return
      await surface.debugger.send('DOM.setFileInputFiles', { files, backendNodeId: p.backendNodeId })
      this.opts.log(`guia ${tabId}: ${files.length === 1 ? '1 arquivo entregue' : `${files.length} arquivos entregues`} à página pelo seletor do tether`)
    } catch (e) {
      this.opts.log(`guia ${tabId}: arquivos não entregues à página (${(e as Error).message})`)
    } finally {
      t.choosing = false
    }
  }
}
