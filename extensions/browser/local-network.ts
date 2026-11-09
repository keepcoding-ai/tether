// The local-network question on the main side (Tether Browser E4, design §4.1, Temper A3). An agent's request to open a
// local address (the gatekeeper's `requestLocalNetwork`, a tab created with a ticket, `allowOnce`) comes here before any
// ticket: the setting decides, or the person does. A question waits as long as the person takes (no short timeout); it is
// cancelled (refused) when its tab closes or the extension goes. The same tab asking twice for the same destination while a
// question is open shares that question. The renderer shows one question at a time and fetches the open ones when it starts,
// so a reloaded window does not lose them.
//
// "Sempre para este perfil" is kept in <TETHER_HOME>/browser/local-network.json (local-network-rules.ts): settings have no
// per-profile layer here. The file is read once and rewritten whole (temp file + rename) on each new grant.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  choiceOf, decideLocalNetwork, destinationOf, grantsOf, LOCAL_NETWORK_FILE, type LocalNetworkAsk, type LocalNetworkGrants,
  profileKeyOf, settingOf, withGrant,
} from './local-network-rules.ts'

export interface LocalNetworkRequest {
  tabId: string
  url: string
  agent: { name: string; profile?: { id: string; name: string } }
}

export interface LocalNetworkGateOptions {
  /** `<TETHER_HOME>/browser`. */
  dir: string
  /** The setting `extensions.browser.localNetwork`, read at each request. */
  setting(): unknown
  /** A new question for the renderer. */
  ask(ask: LocalNetworkAsk): void
  /** A question that no longer needs an answer (its tab closed). */
  cancelled(id: string): void
  log(msg: string): void
}

interface Pending { ask: LocalNetworkAsk; tabId: string; profileKey: string; resolve(ok: boolean): void; promise: Promise<boolean> }

export class LocalNetworkGate {
  private readonly opts: LocalNetworkGateOptions
  private readonly file: string
  private grants: LocalNetworkGrants | undefined
  private readonly pending = new Map<string, Pending>()
  private disposed = false

  constructor(opts: LocalNetworkGateOptions) {
    this.opts = opts
    this.file = join(opts.dir, LOCAL_NETWORK_FILE)
  }

  /** Resolves true when the agent may open the address once (the caller then gives the ticket), false when refused. */
  request(req: LocalNetworkRequest): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    const destination = destinationOf(req.url)
    if (destination === null) return Promise.resolve(false)
    const profileKey = profileKeyOf(req.agent.profile?.id)
    const verdict = decideLocalNetwork(settingOf(this.opts.setting()), this.load(), profileKey, destination)
    if (verdict !== 'ask') {
      this.opts.log(`rede local: ${verdict === 'allow' ? 'permitida' : 'recusada'} sem perguntar (guia ${req.tabId})`)
      return Promise.resolve(verdict === 'allow')
    }
    for (const p of this.pending.values()) if (p.tabId === req.tabId && p.ask.destination === destination) return p.promise
    const ask: LocalNetworkAsk = { id: randomUUID(), agent: req.agent.name, destination, ...(req.agent.profile ? { profile: req.agent.profile.name } : {}) }
    let resolve!: (ok: boolean) => void
    const promise = new Promise<boolean>(r => { resolve = r })
    this.pending.set(ask.id, { ask, tabId: req.tabId, profileKey, resolve, promise })
    this.opts.log(`rede local: perguntando à pessoa (guia ${req.tabId})`)
    this.opts.ask(ask)
    return promise
  }

  /** The person's answer; an unknown or already settled id is ignored. */
  answer(id: string, raw: unknown): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    const choice = choiceOf(raw)
    if (choice === 'always') this.save(withGrant(this.load(), p.profileKey, p.ask.destination))
    this.opts.log(`rede local: a pessoa ${choice === 'deny' ? 'recusou' : choice === 'once' ? 'permitiu uma vez' : 'permitiu sempre para o perfil'} (guia ${p.tabId})`)
    p.resolve(choice !== 'deny')
  }

  /** The open questions (the renderer asks for them when it starts). */
  open(): LocalNetworkAsk[] { return [...this.pending.values()].map(p => p.ask) }

  /** The tab closed: its questions are refused and withdrawn. */
  cancelTab(tabId: string): void {
    for (const [id, p] of [...this.pending]) {
      if (p.tabId !== tabId) continue
      this.pending.delete(id)
      p.resolve(false)
      this.opts.cancelled(id)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const p of this.pending.values()) p.resolve(false)
    this.pending.clear()
  }

  private load(): LocalNetworkGrants {
    if (this.grants) return this.grants
    try { this.grants = grantsOf(JSON.parse(readFileSync(this.file, 'utf8'))) } catch { this.grants = { profiles: {} } }
    return this.grants
  }

  private save(grants: LocalNetworkGrants): void {
    this.grants = grants
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(grants, null, 2)}\n`)
      renameSync(tmp, this.file)
    } catch (e) {
      // The answer still holds for this run; only its memory across restarts is lost.
      this.opts.log(`rede local: não consegui gravar ${LOCAL_NETWORK_FILE} (${(e as Error).message})`)
    }
  }
}
