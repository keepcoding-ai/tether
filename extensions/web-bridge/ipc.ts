// The web-bridge extension's bus (ext:web-bridge:*): the renderer asks main for the browsers, for the install and
// for who is connected. No secret ever crosses: the pairing token goes to bridge.json on disk, the api.key is read by
// main only and never leaves it (the renderer gets counts and names).
import type { DetectedBrowser } from './browsers.ts'
import type { ActionOutcome } from './status-poll.ts'
import type { StatusSnapshot } from './status.ts'

export type { ActionOutcome } from './status-poll.ts'
export type { StatusSnapshot } from './status.ts'

export type InstallOutcome =
  | {
      ok: true
      /** The folder to "Load unpacked" (the fixed `current` folder). */
      dir: string
      extensionId: string
      port: number
      browser: DetectedBrowser
      /** The daemon was already up, was started now, or could not be started (the guide keeps waiting; a later call retries). */
      daemon: 'running' | 'started' | 'failed'
      /** The browsers connected before this install: anything else that shows up afterwards is the new one. */
      before: string[]
      /** The browser could not be opened (the folder is ready anyway). */
      openError?: string
    }
  | { ok: false; message: string }

export type ConnectedOutcome =
  | { ok: true; browsers: { id: string; name: string }[] }
  | { ok: false; reason: 'daemon-down' | 'no-key' | 'refused' | 'error'; message?: string }

export interface WebBridgeChannels {
  invoke: {
    /** The Chromium browsers on this machine, in the picker's order. */
    browsers(): Promise<DetectedBrowser[]>
    /** Copies the extension to the fixed folder, seeds its pairing, pins its id, warms the daemon up and opens the browser's extensions page. */
    install(browserId: string): Promise<InstallOutcome>
    /** Who is connected to the daemon now (polled by the guide, once a second). */
    connected(): Promise<ConnectedOutcome>
    /** The status icon's last snapshot (C4); main polls /status by itself and pushes `status` events. */
    status(): Promise<StatusSnapshot>
    /** POST /pause or /resume on the daemon (a 404 is "indisponível nesta versão"). */
    pause(on: boolean): Promise<ActionOutcome>
    /** "Retomar todas as abas": POST /clients/<id>/release for every client the last snapshot listed. */
    releaseAll(): Promise<ActionOutcome>
    /** "Opções da extensão": opens chrome://extensions/?id=<id> in the snapshot's `options` browser. */
    openOptions(): Promise<ActionOutcome>
  }
  send: {
    /** The popover opened (poll every 2 s) or closed (every 15 s). */
    watch(open: boolean): void
  }
  events: {
    /** A snapshot that differs from the last one. */
    status(snapshot: StatusSnapshot): void
  }
}
