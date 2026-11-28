// "+ Novo" from afar (RR5 5.3, fio-spec 18), on screen: the app's own card of steps (extensions/regency/renderer/
// create-view.ts, O quê › Onde › Detalhes) over the house, with what this device may make and from what. The choices come
// from `create.options` (engines and profiles by name, the queue's desks, the folders by id and label: never a path); the
// card's plan (create-rules.ts planOf, the same list the app runs) goes act by act through the portal's ops. On the phone
// the card is a sheet with one step at a time and "Voltar"; on the tablet and the desk a dialog; on the TV the same dialog,
// walked by the arrows (box-keys.ts). Once made, the person stays where she was: the new row shows when the tree comes.
import type { CreateAct } from '../../../extensions/regency/create-rules.ts'
import { createdText, NEW_DESK, planOf, runPlan, type ActResult, type CreateFixed, type CreateState, type CreateWhat } from '../../../extensions/regency/create-rules.ts'
import type { Tier } from '../../../extensions/regency/renderer/layout-rules.ts'
import { CreateCard, type CreateRunEnd, type CreateViewHost } from '../../../extensions/regency/renderer/create-view.ts'
import type { RegencyPane } from '../../../extensions/regency/renderer/pane.ts'
import { createOptionsView, type CreateOptions } from '../../../src/remote/create.ts'
import { walkBoxByArrows } from './box-keys.ts'
import { callsOf, defaultFolderOf, foldersOf, itemsOf, tilesOf } from './create-afar-rules.ts'
import type { RemoteHouse } from './host.ts'
import type { Manager } from './manage.ts'
import { refusalWords } from './manage-rules.ts'
import { pickList, pickMany } from './sheet.ts'

export interface CreateAfarDeps {
  house: RemoteHouse
  manager: Manager
  tier(): Tier
  pane(): RegencyPane | undefined
  /** The Regency's brief notice. */
  say(text: string): void
}

/** How long a new channel is awaited in the house's list before the centre is left as it was. */
const CHANNEL_WAIT_MS = 10_000
/** The codes that end a plan where nothing was made with their own sentence (said whole, not as "Não consegui …"). */
const WHOLE = new Set(['no-app', 'desk-asleep', 'locked', 'cancelled', 'no-scope', 'no-credential'])

export class CreateAfar {
  private readonly d: CreateAfarDeps
  private readonly card: CreateCard
  private options: CreateOptions | undefined
  private reading = false

  constructor(d: CreateAfarDeps) {
    this.d = d
    this.card = new CreateCard(this.host())
  }

  get isOpen(): boolean { return this.card.isOpen }
  snapshot() { return this.card.snapshot() }
  dispose(): void { this.card.close(false) }

  /** "+ Novo", a desk row's "+", the empty centre's "Criar canal": the choices are read first, then the card opens. */
  async open(fixed: CreateFixed, restore: () => void, what?: 'channel'): Promise<void> {
    if (this.reading) return
    const tiles = tilesOf(this.d.manager.caps)
    if (tiles.length === 0 || (what === 'channel' && !tiles.includes('channel'))) { restore(); return }
    this.reading = true
    try {
      // The channel needs no choice of the machine; anything else reads them now (the desks and folders of this moment).
      if (what !== 'channel') {
        const r = await this.d.manager.read('create.options', {})
        if (!r.ok) { this.d.say(refusalWords(r.code)); restore(); return }
        this.options = createOptionsView(r.body)
      }
    } finally { this.reading = false }
    this.card.open(fixed, restore, what)
    const dialog = [...document.querySelectorAll<HTMLElement>('dialog.rg-cr')].pop()
    if (dialog) walkBoxByArrows(dialog, () => this.d.tier() === 'wide')
  }

  private host(): CreateViewHost {
    const o = (): CreateOptions => this.options ?? { engines: [], profiles: [], desks: [], folders: [] }
    const input = () => this.d.house.input()
    // The scopes are read at every paint of the card (they are the session's, and the card outlives none).
    const m = this.d.manager
    return {
      items: () => itemsOf(o()),
      desks: () => input().desks,
      owners: () => input().owners,
      channels: () => input().channels,
      agents: () => input().agents.filter(a => input().desks.desks.some(d => d.panes.some(p => p.id === a.id && p.exited !== true && p.asleep !== true))),
      projects: () => [],
      recentFolders: async () => [],
      pickFolder: async () => null,
      defaultFolder: () => defaultFolderOf(o()),
      pickList: spec => pickList(this.d.tier(), spec),
      pickMany: spec => pickMany(this.d.tier(), spec),
      tier: () => this.d.tier(),
      run: state => this.run(state),
      afar: {
        get tiles(): CreateWhat[] { return tilesOf(m.caps) },
        get newDesk(): boolean { return m.caps.desks },
        get joinChannel(): boolean { return m.caps.channels },
        folders: async () => foldersOf(o()),
        folderLabel: value => o().folders.find(f => f.id === value)?.label,
      },
    }
  }

  /** The card's plan, act by act over the portal's ops; the sentence of how it ended, and the notice after. */
  private async run(state: CreateState): Promise<CreateRunEnd> {
    const ctx = { desks: this.d.house.input().desks, channels: this.d.house.input().channels }
    const acts = planOf(state, ctx)
    let lastCode = ''
    const exec = async (act: CreateAct): Promise<ActResult> => {
      if (act.act === 'show') { this.showChannel(act.channel); return { ok: true } }
      const refused: string[] = []
      let result: ActResult = { ok: true }
      for (const call of callsOf(act)) {
        if ('error' in call) return { ok: false, error: call.error }
        const r = await this.d.manager.act(call.op, call.body)
        if (!r.ok) {
          // One agent a channel refused does not stop the others (the app joins each in order and tells who did not come).
          if (act.act === 'join') { refused.push(this.agentName(String(call.body.agent))); continue }
          lastCode = r.code
          return { ok: false, error: refusalWords(r.code) }
        }
        const b = r.body
        const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
        if (act.act === 'desk') result = { ok: true, ...(str(b.deskId) ? { deskId: str(b.deskId)! } : {}) }
        else if (act.act === 'slot') result = { ok: true, deskId: act.deskId, ...(str(b.slotId) ? { paneId: str(b.slotId)! } : {}) }
        else if (act.act === 'item' || act.act === 'browser') result = { ok: true, deskId: act.deskId, ...(str(b.paneId) ? { paneId: str(b.paneId)! } : {}) }
        else if (act.act === 'channel') result = { ok: true, ...(str(b.channel) ? { channelId: str(b.channel)! } : {}) }
      }
      return act.act === 'join' ? { ok: true, refused } : result
    }
    const run = await runPlan(acts, exec)
    const what = state.draft.what
    const deskName = this.deskNameOf(state)
    const after = (): void => {
      const said = createdText(what, deskName)
      if (said) this.d.say(`${said}.`)
    }
    if (!run.ok && run.done === 0 && WHOLE.has(lastCode)) return { ok: false, text: refusalWords(lastCode), after: () => {} }
    if (!run.ok) return { ok: false, ...(run.text !== undefined ? { text: run.text } : {}), after: () => {} }
    return { ok: true, ...(run.text !== undefined ? { text: run.text } : {}), after }
  }

  private agentName(id: string): string { return this.d.house.input().agents.find(a => a.id === id)?.name ?? id }

  private deskNameOf(state: CreateState): string | undefined {
    const d = state.draft
    if (d.what === 'desk' || d.deskId === NEW_DESK) return d.newDesk?.name
    return d.deskId ? this.d.house.input().desks.desks.find(x => x.id === d.deskId)?.name : undefined
  }

  /** The new channel in the centre, as the app opens it, once the house's list has it (the marks come a moment later). */
  private showChannel(id: string): void {
    const end = Date.now() + CHANNEL_WAIT_MS
    const tryShow = (): boolean => {
      if (!this.d.house.input().channels.some(c => c.id === id)) return false
      this.d.pane()?.select(id)
      return true
    }
    if (tryShow()) return
    const sub = this.d.house.onDidChange(() => { if (tryShow() || Date.now() > end) sub.dispose() })
    setTimeout(() => sub.dispose(), CHANNEL_WAIT_MS)
  }
}
