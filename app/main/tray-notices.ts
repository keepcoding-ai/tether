// The notices extensions put on the system tray (TetherMain.notices): the part of "attention" that is not a terminal's.
// A terminal's attention comes from the daemon's slot states; an extension's (a browser tab where an agent asks for help)
// comes from here. The tray reads `list()` and is told when it changes. Pure: main.ts feeds the tray.
import type { IDisposable } from '../shared/vscode-lifecycle.ts'
import type { TrayNotice } from '../shared/tray.ts'

export interface NoticeHandle extends IDisposable {
  update(message: string): void
  /** The notice is no longer needed. */
  resolve(): void
}

export interface MainNotices {
  raise(opts: { slotId?: string; message: string }): NoticeHandle
}

export class TrayNotices implements MainNotices {
  private readonly notices = new Map<number, TrayNotice>()
  private next = 1
  private readonly changed: () => void

  constructor(changed: () => void) { this.changed = changed }

  list(): TrayNotice[] { return [...this.notices.values()] }

  raise(opts: { slotId?: string; message: string }): NoticeHandle {
    const key = this.next++
    this.notices.set(key, { id: String(key), ...(opts.slotId ? { slotId: opts.slotId } : {}), message: opts.message })
    this.changed()
    const resolve = (): void => { if (this.notices.delete(key)) this.changed() }
    return {
      update: message => { const n = this.notices.get(key); if (n && n.message !== message) { this.notices.set(key, { ...n, message }); this.changed() } },
      resolve,
      dispose: resolve,
    }
  }
}
