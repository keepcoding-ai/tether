// The tabs' session (Tether Browser E2, design §4.1–§4.2 and §12b rules 17–19): one partition for every agent's tab, made
// once. Every site permission is refused without asking (camera, microphone, location, notifications…), downloads are
// cancelled until the downloads slice decides them by origin, and the cookies are forced to disk on a short interval, after
// each finished navigation and at quit, so a login survives an abrupt end.
//
// Rule 19: the cookies may live on disk only when the running executable has the `EnableCookieEncryption` fuse on (cookies
// written without it stay in plain text forever, and turning it on later does not encrypt them). The fuse is read from the
// executable's fuse wire (the same bytes @electron/fuses flips); unreadable counts as off. Off: the partition is in memory
// (`tether-browser`, no `persist:`), logged once, and `persistentLogins` is false so the interface can say logins are not kept.
import { app, session as electronSession, type Session, type WebContents } from 'electron'
import { open } from 'node:fs/promises'
import { cookieEncryptionOn, FUSE_SENTINEL, fuseWireAt } from './tab-rules.ts'

export const PERSIST_PARTITION = 'persist:tether-browser'
export const MEMORY_PARTITION = 'tether-browser'
const FLUSH_MS = 5_000

export interface TabSession {
  readonly partition: string
  readonly session: Session
  /** False when the partition is in memory (the fuse is off): logins end with the app. */
  readonly persistentLogins: boolean
  /** What every tab's webContents gets once (WebRTC without UDP outside the proxy). */
  prepare(wc: WebContents): void
  /** Forces the cookies to disk now (a no-op in memory). */
  flush(): void
  dispose(): void
}

/** The fuse wire of an executable, read in chunks (the sentinel sits somewhere in a ~200 MB file); undefined when not found. */
export async function readFuseWire(exe: string): Promise<number[] | undefined> {
  const sentinel = Buffer.from(FUSE_SENTINEL, 'latin1')
  const chunk = 8 * 1024 * 1024
  const keep = sentinel.length + 2 + 255
  const fh = await open(exe, 'r')
  try {
    let carry = Buffer.alloc(0)
    let offset = 0
    for (;;) {
      const buf = Buffer.alloc(chunk)
      const { bytesRead } = await fh.read(buf, 0, chunk, offset)
      if (bytesRead === 0) return undefined
      offset += bytesRead
      const data = Buffer.concat([carry, buf.subarray(0, bytesRead)])
      const at = data.indexOf(sentinel)
      if (at >= 0) {
        if (at + keep > data.length && bytesRead === chunk) { carry = data.subarray(at); continue }
        return fuseWireAt(data, at)
      }
      carry = data.subarray(Math.max(0, data.length - keep))
    }
  } finally { await fh.close() }
}

/** Whether the running executable has cookie encryption on; any failure counts as off. */
export async function cookieEncryptionInForce(): Promise<boolean> {
  try { return cookieEncryptionOn(await readFuseWire(process.execPath)) } catch { return false }
}

export function createTabSession(persistentLogins: boolean, log: (msg: string) => void): TabSession {
  const partition = persistentLogins ? PERSIST_PARTITION : MEMORY_PARTITION
  const ses = electronSession.fromPartition(partition)
  if (!persistentLogins) log('fuse EnableCookieEncryption desligado neste executável: guias numa partição em memória, logins não são guardados')
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
  ses.setDisplayMediaRequestHandler((_req, callback) => callback({}))
  const onDownload = (_e: unknown, item: { cancel(): void }): void => { item.cancel(); log('download recusado (a fatia de downloads ainda não existe)') }
  ses.on('will-download', onDownload)
  const flush = (): void => { if (persistentLogins) ses.cookies.flushStore().catch(() => {}) }
  const timer = persistentLogins ? setInterval(flush, FLUSH_MS) : undefined
  timer?.unref?.()
  const onQuit = (): void => flush()
  app.on('before-quit', onQuit)
  let disposed = false
  return {
    partition, session: ses, persistentLogins,
    prepare: wc => { wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp') },
    flush,
    dispose: () => {
      if (disposed) return
      disposed = true
      flush()
      if (timer) clearInterval(timer)
      app.removeListener('before-quit', onQuit)
      ses.removeListener('will-download', onDownload as never)
      // The permission handlers stay: a refusal never turns into Electron's default (grant) while views may still exist.
    },
  }
}
