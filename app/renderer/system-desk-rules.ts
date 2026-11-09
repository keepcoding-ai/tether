// The system desks extensions contribute (`contributes.systemDesks`) as pure rules (no DOM, unit-tested): the manifest
// declares a desk, the registry holds what is declared now, and the workbench (main.ts) mirrors it into the DeskSet.
// A declaration lasts as long as its disposable: an extension that is off, or failed, declares nothing, and its desk
// stays unshown (its content waits in layout.json `systemDesks`).
//
// The effective id is the manifest's id, which must be prefixed by the extension id ('my-ext.main'), the same rule as
// pads and status icons: two extensions cannot collide by construction, and the id is the key in layout.json.
import { toDisposable, type IDisposable } from '../shared/vscode-lifecycle.ts'

/** The manifest's entry plus the extension that declared it. */
export interface SystemDeskDescriptor {
  id: string
  title: string
  icon?: string
  color?: string
  extension: string
}

export type SystemDeskChange = { type: 'add' | 'remove'; desk: SystemDeskDescriptor }

const SYSTEM_DESK_ID = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/

/** What is wrong with a manifest entry of extension `extension` (empty when valid). */
export function systemDeskProblems(extension: string, entry: { id?: unknown; title?: unknown; icon?: unknown; color?: unknown }): string[] {
  const out: string[] = []
  if (typeof entry.id !== 'string' || !SYSTEM_DESK_ID.test(entry.id)) out.push(`id de mesa de sistema malformado: ${String(entry.id)}`)
  else if (!entry.id.startsWith(`${extension}.`)) out.push(`o id da mesa de sistema ${entry.id} deve começar com "${extension}."`)
  if (typeof entry.title !== 'string' || !entry.title.trim()) out.push(`mesa de sistema ${String(entry.id)} sem título`)
  if (entry.icon !== undefined && typeof entry.icon !== 'string') out.push(`ícone da mesa de sistema ${String(entry.id)} deve ser texto`)
  if (entry.color !== undefined && typeof entry.color !== 'string') out.push(`cor da mesa de sistema ${String(entry.id)} deve ser texto`)
  return out
}

export class SystemDeskRegistry {
  private readonly descs: SystemDeskDescriptor[] = []
  private readonly listeners = new Set<(c: SystemDeskChange) => void>()

  /** Declares a desk; the disposable takes it back. Throws for a malformed entry or an id declared twice. */
  declare(desc: SystemDeskDescriptor): IDisposable {
    const problems = systemDeskProblems(desc.extension, desc)
    if (problems.length) throw new Error(problems[0])
    if (this.descs.some(d => d.id === desc.id)) throw new Error(`mesa de sistema declarada duas vezes: ${desc.id}`)
    this.descs.push(desc)
    this.fire({ type: 'add', desk: desc })
    return toDisposable(() => {
      const i = this.descs.indexOf(desc)
      if (i === -1) return
      this.descs.splice(i, 1)
      this.fire({ type: 'remove', desk: desc })
    })
  }

  all(): readonly SystemDeskDescriptor[] { return [...this.descs] }
  get(id: string): SystemDeskDescriptor | undefined { return this.descs.find(d => d.id === id) }

  onDidChange(listener: (c: SystemDeskChange) => void): IDisposable {
    this.listeners.add(listener)
    return toDisposable(() => { this.listeners.delete(listener) })
  }

  private fire(c: SystemDeskChange): void { for (const l of [...this.listeners]) l(c) }
}
