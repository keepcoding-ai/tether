// The tabs' downloads on the main side (Tether Browser E13, design §4.3): each one lands in `<TETHER_HOME>/browser/downloads/
// <slotId>/` of the agent that owns the tab (the folder made the owner's alone, private-dir.ts), under a safe name that never
// overwrites, within the package's ceilings (files-rules.ts): over one it is cancelled, the partial file removed. The person's
// own tabs download like any browser: to the system's Downloads folder, outside the agents' tree, with no ceiling; the pad
// remembers which files were hers (PERSON_DOWNLOADS_FILE), never listing the folder itself. The pad's
// "Baixados" is read from the folders (so it survives a restart); "Mostrar na pasta" opens the system's file browser on the
// file, never the file itself. Listeners hear every download's progress (the gate tells the owner's agent connections).
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import type { DownloadItem } from 'electron'
import { type DownloadEntry, downloadOver, safeDownloadName, uniqueName, zoneIdentifier } from './files-rules.ts'
import { ensurePrivateDir } from './private-dir.ts'
import { isId, isPersonOwned, PERSON_OWNER } from './tab-rules.ts'

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

/** Her downloads the pad lists (newest last), kept in PERSON_DOWNLOADS_FILE: the file's full path, never a folder listing. */
interface PersonFile { name: string; path: string; at: number }

/** The list of her downloads, next to the closed history (the tether's own folder, never her Downloads folder). */
export const PERSON_DOWNLOADS_FILE = 'person-downloads.json'
/** How many of her downloads the pad remembers. */
export const PERSON_DOWNLOADS_MAX = 200

export class DownloadStore {
  private readonly root: string
  private readonly personFile: string
  private readonly personDir: string | undefined
  private readonly log: (msg: string) => void
  private readonly listeners = new Set<(e: DownloadEvent) => void>()
  private readonly active = new Map<string, Active>()

  /**
   * `personDir`: where her own tabs' downloads go, the system's Downloads folder like any browser's (outside the agents' tree;
   * a test build passes a folder of its home). Without it (the list read while the browser process is down) her downloads are
   * listed but none is taken.
   */
  constructor(browserDir: string, log: (msg: string) => void, personDir?: string) {
    this.root = join(browserDir, 'downloads')
    this.personFile = join(browserDir, PERSON_DOWNLOADS_FILE)
    this.personDir = personDir
    this.log = log
  }

  /** Her downloads the pad remembers, as recorded (paths not checked). */
  private personRecords(): PersonFile[] {
    let raw: unknown
    try { raw = JSON.parse(readFileSync(this.personFile, 'utf8')) } catch { return [] }
    if (!Array.isArray(raw)) return []
    return raw.filter((r): r is PersonFile => !!r && typeof r === 'object' && typeof r.name === 'string' && typeof r.path === 'string' && typeof r.at === 'number'
      && r.name === safeDownloadName(r.name) && isAbsolute(r.path) && basename(r.path) === r.name)
  }

  private recordPerson(name: string, path: string): void {
    const kept = this.personRecords().filter(r => r.path !== path)
    kept.push({ name, path, at: Date.now() })
    try { writeFileSync(this.personFile, JSON.stringify(kept.slice(-PERSON_DOWNLOADS_MAX))) } catch (e) {
      this.log(`download da pessoa fora da lista de baixados (${(e as NodeJS.ErrnoException).code ?? 'erro'})`)
    }
  }

  /** Her finished files that are still where they landed (she may have moved or deleted them). */
  private personFiles(): (DownloadEntry & { path: string })[] {
    const out: (DownloadEntry & { path: string })[] = []
    for (const r of this.personRecords()) {
      try {
        const st = statSync(r.path)
        if (st.isFile()) out.push({ slotId: PERSON_OWNER, name: r.name, bytes: st.size, at: st.mtimeMs, path: r.path })
      } catch { /* gone */ }
    }
    return out
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

  /** Every agent's finished files and hers (the pad's "Baixados"). */
  list(): DownloadEntry[] {
    const hers = this.personFiles().map(({ path: _p, ...e }) => e)
    if (!existsSync(this.root)) return hers
    return [...readdirSync(this.root).filter(id => isId(id) && !isPersonOwned(id)).flatMap(slotId => this.filesOf(slotId)), ...hers]
  }

  /** The file's full path for "Mostrar na pasta"; undefined unless it is a file of that agent's folder (or one of her downloads). */
  pathOf(slotId: string, name: string): string | undefined {
    if (isPersonOwned(slotId)) return this.personFiles().filter(f => f.name === name).at(-1)?.path
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
    // Hers: the system's Downloads folder as in any browser (never made private, it is her own folder), with no tether ceiling.
    const hers = isPersonOwned(slotId)
    const dir = hers ? this.personDir : this.folderOf(slotId)
    if (!dir) { item.cancel(); return }
    try {
      if (hers) mkdirSync(dir, { recursive: true })
      else { ensurePrivateDir(this.root); ensurePrivateDir(dir) }
    } catch (e) {
      item.cancel()
      this.log(hers ? `download recusado: a pasta Downloads não está disponível (${(e as NodeJS.ErrnoException).code ?? 'erro'})` : `download recusado: a pasta de downloads não ficou privada (${(e as Error).message})`)
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
      if (hers) return true
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
        this.log(`download concluído${markOfTheWeb(path, url)}`)
        if (hers) this.recordPerson(name, path)
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

/**
 * Gives the finished file the Mark of the Web (`<file>:Zone.Identifier`, the Internet zone, the origin only), so Windows warns
 * before running it and Office opens it protected. Chromium writes it itself when its quarantine service runs; when it is
 * missing the tether writes it. Returns the log's note (which of the two, or that it could not).
 */
function markOfTheWeb(path: string, url: string): string {
  if (process.platform !== 'win32') return ''
  const ads = `${path}:Zone.Identifier`
  if (existsSync(ads)) return ' (marca da web do Chromium)'
  try { writeFileSync(ads, zoneIdentifier(url)); return ' (marca da web gravada pelo tether)' } catch (e) {
    return ` (marca da web não gravada: ${(e as NodeJS.ErrnoException).code ?? 'erro'})`
  }
}
