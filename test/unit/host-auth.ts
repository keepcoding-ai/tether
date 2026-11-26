// The host handshake done by hand, for tests that speak the host protocol over a raw socket (daemon/pipe-key.ts, scope
// 'tether-host'): `auth` with a nonce, then `hello` with the proof made from the host's key file.
import { clientProof, hostKeyPath, newNonce, readKeyFile } from '../../src/daemon/pipe-key.ts'
import { PROCD_PROTOCOL_VERSION, type HostReply } from '../../src/procd/protocol.ts'

type Ok = Extract<HostReply, { t: 'ok' }>

/** `request` sends one request and resolves with its `ok` reply. */
export async function identifyHost(request: (body: Record<string, unknown>) => Promise<Ok>, pipe: string, home: string): Promise<Ok> {
  const nonce = newNonce()
  const auth = await request({ t: 'auth', nonce })
  const key = await readKeyFile(hostKeyPath(home, pipe))
  if (!key) throw new Error(`no host key at ${hostKeyPath(home, pipe)}`)
  return request({ t: 'hello', v: PROCD_PROTOCOL_VERSION, proof: clientProof(key, nonce, auth.auth!.nonce, 'tether-host') })
}
