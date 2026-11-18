// The closed tabs on disk: `<home>/browser/closed-tabs.json` ({ v: 1, items: [...] }, newest first), written in one move with
// owner-only mode inside the owner-only folder. The rules (entries, expiry, ceiling, credentials) live in closed-rules.ts, which
// the renderer uses too; this file imports node and stays on the main side.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { type ClosedHistoryKeep, type ClosedTab, parseClosed, pruneClosed } from './closed-rules.ts'

export const CLOSED_HISTORY_FILE = 'closed-tabs.json'

/** The closed tabs, on disk. Every read applies the expiry the setting says now. */
export class ClosedHistory {
  private readonly file: string
  private readonly keep: () => ClosedHistoryKeep
  private readonly log: (msg: string) => void
  private readonly now: () => number
  private items: ClosedTab[]

  /** The writes, one after the other; each writes the list as it is when its turn comes. */
  private writing: Promise<void> = Promise.resolve()

  private constructor(o: ClosedHistoryOptions, items: ClosedTab[]) {
    this.file = o.file
    this.keep = o.keep
    this.log = o.log ?? (() => {})
    this.now = o.now ?? Date.now
    this.items = items
  }

  /** The history read from its file (off the loop), the expired entries gone and the file written back without them. */
  static async open(o: ClosedHistoryOptions): Promise<ClosedHistory> {
    let raw: unknown
    try { raw = JSON.parse(await readFile(o.file, 'utf8')) } catch { raw = undefined }
    const read = parseClosed(raw)
    const h = new ClosedHistory(o, pruneClosed(read, (o.now ?? Date.now)(), o.keep()))
    if (h.items.length !== read.length) h.save()
    return h
  }

  /** Resolves once every change so far reached the disk (or failed to, logged). */
  flush(): Promise<void> { return this.writing }

  /** The list, newest first, with the expiry applied (written back when something expired). */
  list(): ClosedTab[] {
    const kept = pruneClosed(this.items, this.now(), this.keep())
    if (kept.length !== this.items.length) { this.items = kept; this.save() }
    return kept.map(it => ({ ...it }))
  }

  /** Keeps a tab that closed; false when it is not kept (credential, no web address) or already is. */
  record(e: ClosedTab | undefined): boolean {
    if (!e || this.items.some(it => it.id === e.id)) return false
    this.items = pruneClosed([e, ...this.items], this.now(), this.keep())
    this.save()
    return true
  }

  get(id: string): ClosedTab | undefined { return this.list().find(it => it.id === id) }

  /** Takes one entry out (it was opened again). */
  remove(id: string): void {
    const kept = this.items.filter(it => it.id !== id)
    if (kept.length === this.items.length) return
    this.items = kept
    this.save()
  }

  /** "Limpar histórico". */
  clear(): void {
    if (this.items.length === 0) return
    this.items = []
    this.save()
  }

  private save(): void {
    this.writing = this.writing.then(async () => {
      const tmp = `${this.file}.${process.pid}.tmp`
      try {
        await mkdir(dirname(this.file), { recursive: true })
        await writeFile(tmp, `${JSON.stringify({ v: 1, items: this.items })}\n`, { mode: 0o600 })
        await rename(tmp, this.file)
      } catch (e) {
        // Kept in memory for this opening of the app; the next one starts from what last reached the disk.
        this.log(`histórico de guias fechadas não gravado (${(e as Error).message})`)
        await rm(tmp, { force: true }).catch(() => {})
      }
    })
  }
}

export interface ClosedHistoryOptions { file: string; keep: () => ClosedHistoryKeep; log?: (msg: string) => void; now?: () => number }
