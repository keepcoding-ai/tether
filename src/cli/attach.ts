// `tether attach <slot>`: this terminal becomes a window on a tetherd slot. Raw stdin → `input`, `data` →
// stdout, terminal resizes → `resize`. Ctrl+] detaches (the slot keeps running in the daemon).
import type { DaemonClient } from '../daemon/client.ts'
import type { SlotState } from '../daemon/protocol.ts'

export const DETACH_KEY = '\x1d' // Ctrl+]

export interface AttachIo {
  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
}

/** Resolves when the user detaches or the slot's process exits. */
export async function attach(client: DaemonClient, slotId: string, io: AttachIo = { stdin: process.stdin, stdout: process.stdout }): Promise<void> {
  const { stdin, stdout } = io
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('attach precisa de um terminal interativo (stdin e stdout)')
  const size = (): { cols: number; rows: number } => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 })
  const reply = await client.request({ t: 'attach', slotId, ...size() })
  stdout.write(`[tether] anexado ao slot ${slotId} — Ctrl+] para desanexar\n`)
  if (reply.scrollback) stdout.write(reply.scrollback)

  await new Promise<void>((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      stdin.off('data', onKey)
      stdout.off('resize', onResize)
      client.off('data', onData)
      client.off('state', onState)
      client.off('close', onClose)
      try { stdin.setRawMode(false) } catch { /* not a tty any more */ }
      stdin.pause()
      resolve()
    }
    const onKey = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      const at = text.indexOf(DETACH_KEY)
      if (at >= 0) {
        if (at > 0) client.input(slotId, text.slice(0, at))
        stdout.write(`\n[tether] desanexado do slot ${slotId}\n`)
        finish()
        return
      }
      client.input(slotId, text)
    }
    const onResize = (): void => { void client.request({ t: 'resize', slotId, ...size() }).catch(() => {}) }
    const onData = (id: string, data: string): void => { if (id === slotId) stdout.write(data) }
    const onState = (slot: SlotState): void => {
      if (slot.slotId !== slotId) return
      if (slot.status === 'exited' || slot.status === 'unconfirmed' || slot.status === 'error') {
        stdout.write(`\n[tether] o slot ${slotId} encerrou (${slot.status})\n`)
        finish()
      }
    }
    const onClose = (): void => {
      stdout.write('\n[tether] conexão com o tetherd fechada\n')
      finish()
    }
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onKey)
    stdout.on('resize', onResize)
    client.on('data', onData)
    client.on('state', onState)
    client.on('close', onClose)
  })
  try { await client.request({ t: 'detach', slotId }) } catch { /* connection may be gone */ }
}
