// The tabs' downloads on the main side (Tether Browser E13, design §4.3): each one lands in `<TETHER_HOME>/browser/downloads/
// <slotId>/` of the agent that owns the tab (the folder made the owner's alone, private-dir.ts), under a safe name that never
// overwrites, within the package's ceilings (files-rules.ts): over one it is cancelled, the partial file removed. The pad's
// "Baixados" is read from the folders (so it survives a restart); "Mostrar na pasta" opens the system's file browser on the
// file, never the file itself. Listeners hear every download's progress (the gate tells the owner's agent connections).
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DownloadItem } from 'electron'
import { type DownloadEntry, downloadOver, safeDownloadName, uniqueName } from './files-rules.ts'
import { ensurePrivateDir } from './private-dir.ts'
import { isId } from './tab-rules.ts'

/** A download's progress, as the agent hears it (`Browser.downloadWillBegin` / `Browser.downloadProgress`). */
export interface DownloadEvent {
  guid: string
  slotId: string
  tabId: string
  /** The final name in the agent's folder (never the folder: the path is the tether's). */
  name: string
  url: string
  state: 'begin' | 'inProgress' | 'completed' | 'canceled'
  received: number
  total: number
  /** Why it was cancelled (a ceiling, or the download failed). */
  reason?: string
}

interface Active { slotId: string; name: string; received: number }

export class DownloadStore {
  private readonly root: string
  private readonly log: (msg: string) => void
  private readonly listeners = new Set<(e: DownloadEvent) => void>()
  private readonly active = new Map<string, Active>()

  constructor(browserDir: string, log: (msg: string) => void) {
    this.root = join(browserDir, 'downloads')
    this.log = log
  }

  onEvent(l: (e: DownloadEvent) => void): { dispose(): void } {
    this.listeners.add(l)
    return { dispose: () => { this.listeners.delete(l) } }
  }

  private emit(e: DownloadEvent): void {
    for (const l of [...this.listeners]) { try { l(e) } catch { /* a listener's failure is its own */ } }
  }

  /** The agent's folder (made private on first use); undefined for a slot id that is not one. */
  folderOf(slotId: string): string | undefined {
    return isId(slotId) ? join(this.root, slotId) : undefined
  }

  /** What the agent keeps: its folder on disk plus its downloads still arriving. */
  private usedBy(slotId: string, except?: string): number {
    let n = 0
    for (const e of this.filesOf(slotId)) n += e.bytes
    for (const [guid, a] of this.active) if (a.slotId === slotId && guid !== except) n += a.received
    return n
  }

  private filesOf(slotId: string): DownloadEntry[] {
    const dir = this.folderOf(slotId)
    if (!dir || !existsSync(dir)) return []
    const out: DownloadEntry[] = []
    const arriving = new Set([...this.active.values()].filter(a => a.slotId === slotId).map(a => a.name))
    for (const name of readdirSync(dir)) {
      if (arriving.has(name)) continue
      try {
        const st = statSync(join(dir, name))
        if (st.isFile()) out.push({ slotId, name, bytes: st.size, at: st.mtimeMs })
      } catch { /* gone meanwhile */ }
    }
    return out
  }

  /** Every agent's finished files (the pad's "Baixados"). */
  list(): DownloadEntry[] {
    if (!existsSync(this.root)) return []
    return readdirSync(this.root).filter(isId).flatMap(slotId => this.filesOf(slotId))
  }

  /** The file's full path for "Mostrar na pasta"; undefined unless it is a file of that agent's folder. */
  pathOf(slotId: string, name: string): string | undefined {
    const dir = this.folderOf(slotId)
    if (!dir || name !== safeDownloadName(name)) return undefined
    const p = join(dir, name)
    try { return statSync(p).isFile() ? p : undefined } catch { return undefined }
  }

  /**
   * `will-download` of a tab owned by `slotId`: the path is set now (Electron asks it synchronously), the ceilings are watched
   * as the bytes arrive.
   */
  take(item: DownloadItem, slotId: string, tabId: string): void {
    const dir = this.folderOf(slotId)
    if (!dir) { item.cancel(); return }
    try { ensurePrivateDir(this.root); ensurePrivateDir(dir) } catch (e) {
      item.cancel()
      this.log(`download recusado: a pasta de downloads não ficou privada (${(e as Error).message})`)
      return
    }
    const guid = randomUUID()
    const busy = new Set([...this.active.values()].filter(a => a.slotId === slotId).map(a => a.name))
    const name = uniqueName(safeDownloadName(item.getFilename()), c => busy.has(c) || existsSync(join(dir, c)))
    const path = join(dir, name)
    item.setSavePath(path)
    const url = item.getURL()
    const a: Active = { slotId, name, received: 0 }
    this.active.set(guid, a)
    const base = { guid, slotId, tabId, name, url }
    let cancelled: string | undefined
    const check = (bytes: number): boolean => {
      const over = downloadOver(bytes, this.usedBy(slotId, guid))
      if (!over) return true
      cancelled = over === 'file' ? 'over the 50 MB limit per file' : 'over the 200 MB limit per agent'
      this.log(`download cancelado: ${over === 'file' ? 'acima de 50 MB' : 'o agente passaria de 200 MB baixados'}`)
      item.cancel()
      return false
    }
    item.on('updated', () => {
      if (cancelled) return
      a.received = item.getReceivedBytes()
      if (!check(Math.max(a.received, item.getTotalBytes()))) return
      this.emit({ ...base, state: 'inProgress', received: a.received, total: item.getTotalBytes() })
    })
    item.once('done', (_e, state) => {
      this.active.delete(guid)
      const received = item.getReceivedBytes()
      if (state === 'completed' && !cancelled) {
        this.log('download concluído')
        this.emit({ ...base, state: 'completed', received, total: received })
      } else {
        rmSync(path, { force: true })
        this.emit({ ...base, state: 'canceled', received, total: item.getTotalBytes(), reason: cancelled ?? `the download ${state}` })
      }
    })
    this.emit({ ...base, state: 'begin', received: 0, total: item.getTotalBytes() })
    check(item.getTotalBytes())
  }

  dispose(): void { this.listeners.clear() }
}
