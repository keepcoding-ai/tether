// What an agent knows a tab by, kept WITH THE TAB (Tether Browser, MCP inside the daemon): the id the agent's browser tool
// calls it (`t1`, `t2`, ...), which of its tabs is the active one, and the number the next new tab gets. The tool's server
// asks the gatekeeper for them (`Tether.tabHandle`, `Tether.setActiveTab`) instead of numbering the tabs in its own memory, so
// a new server over the same tabs (the daemon restarted, the agent's session was resumed, the app reopened) calls each tab
// what it was called before. A tab's id goes away only when the tab is closed; an id is never given twice to an owner.
//
// On disk: `<home>/browser/agent-tabs.json` ({ v: 1, owners: { <slotId>: { seq, active?, handles: { <tabId>: "t3" } } } }),
// keyed by the tether's own tab id (stable across openings of the app, unlike the debugger's target id), written in one move
// with owner-only mode inside the owner-only folder (private-dir.ts). No address and no title is written here.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { isId } from './tab-rules.ts'

export const AGENT_TABS_FILE = 'agent-tabs.json'
const HANDLE = /^t([1-9]\d{0,8})$/

interface Owner { seq: number; active?: string; handles: Record<string, string> }
interface Doc { v: 1; owners: Record<string, Owner> }

/** The file's content read back (anything may be there): only well-formed owners, tabs and ids are kept. */
export function parseAgentTabs(raw: unknown): Doc {
  const out: Doc = { v: 1, owners: {} }
  const owners = raw && typeof raw === 'object' && (raw as { v?: unknown }).v === 1 ? (raw as { owners?: unknown }).owners : undefined
  if (!owners || typeof owners !== 'object') return out
  for (const [slotId, v] of Object.entries(owners as Record<string, unknown>)) {
    if (!isId(slotId) || !v || typeof v !== 'object') continue
    const o = v as { seq?: unknown; active?: unknown; handles?: unknown }
    const handles: Record<string, string> = {}
    const taken = new Set<string>()
    let highest = 0
    for (const [tabId, h] of Object.entries(o.handles && typeof o.handles === 'object' ? o.handles as Record<string, unknown> : {})) {
      const m = typeof h === 'string' ? HANDLE.exec(h) : null
      if (!isId(tabId) || !m || taken.has(h as string)) continue
      handles[tabId] = h as string
      taken.add(h as string)
      highest = Math.max(highest, Number(m[1]))
    }
    // The counter never sits below an id in use, whatever the file says.
    const seq = Math.max(Number.isSafeInteger(o.seq) && (o.seq as number) >= 0 ? o.seq as number : 0, highest)
    out.owners[slotId] = { seq, handles, ...(typeof o.active === 'string' && o.active in handles ? { active: o.active } : {}) }
  }
  return out
}

export class AgentTabs {
  private readonly file: string
  private readonly log: (msg: string) => void
  private doc: Doc

  constructor(file: string, log: (msg: string) => void = () => {}) {
    this.file = file
    this.log = log
    let raw: unknown
    try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch { raw = undefined }
    this.doc = parseAgentTabs(raw)
  }

  /** The id `owner`'s tool calls `tabId` by: the one kept with the tab, or the owner's next number (kept from now on). */
  handle(owner: string, tabId: string): { handle: string; active: boolean } {
    const o = (this.doc.owners[owner] ??= { seq: 0, handles: {} })
    let handle = o.handles[tabId]
    if (handle === undefined) {
      handle = `t${++o.seq}`
      o.handles[tabId] = handle
      this.save()
    }
    return { handle, active: o.active === tabId }
  }

  /** `tabId` is the tab `owner`'s tool acts on from now on. A tab the owner has no id for is ignored. */
  setActive(owner: string, tabId: string): void {
    const o = this.doc.owners[owner]
    if (!o || !(tabId in o.handles) || o.active === tabId) return
    o.active = tabId
    this.save()
  }

  /** The tab was closed (by the person or by its agent): what was kept with it goes. The owner's counter stays. */
  forget(tabId: string): void {
    let changed = false
    for (const o of Object.values(this.doc.owners)) {
      if (!(tabId in o.handles)) continue
      delete o.handles[tabId]
      if (o.active === tabId) delete o.active
      changed = true
    }
    if (changed) this.save()
  }

  /** What is kept for `owner` (tests, doctor). */
  view(owner: string): { seq: number; active?: string; handles: Record<string, string> } | undefined {
    const o = this.doc.owners[owner]
    return o ? { seq: o.seq, handles: { ...o.handles }, ...(o.active ? { active: o.active } : {}) } : undefined
  }

  private save(): void {
    const tmp = `${this.file}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(tmp, `${JSON.stringify(this.doc)}\n`, { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (e) {
      // Kept in memory for this opening of the app; the next one starts from what last reached the disk.
      this.log(`ids das guias dos agentes não gravados (${(e as Error).message})`)
    } finally { rmSync(tmp, { force: true }) }
  }
}
