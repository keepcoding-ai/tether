// The private channel between the `remote` extension (in tetherd) and the portal process it spawned: Node's IPC channel of
// that child (fd 3), which no other process can open. It carries the extension's commands (pairing gestures of the app,
// revocations, registry changes) and the portal's asks (write this device, this ticket) and notes. Nothing here goes on
// the tetherd pipe, so no client of the pipe, greeted or not, ever sees a pairing code, a typed SAS or a ticket state.
// The credential is NOT on this channel: it goes on stdin, once, as fio-spec 1.5 says.
// Pure module (no node:*): both sides import it; the messages are JSON (Node's 'json' serialization).

/** A device as the portal needs it: identity, state and the tickets the deny list is made of. Hex for bytes. */
export interface PortalDevice {
  deviceId: string
  pubD: string
  /** `pending`: written at the SAS, waiting for PAIR_ACK; `active`; `revoked`. */
  state: 'pending' | 'active' | 'revoked'
  maxVerUsed: number
  scopes: string[]
  tickets: TicketRow[]
  /** keyId(pub_A) of every admission key this device ever had (E-2: a renewal never reuses one). */
  usedKeyIds: string[]
  /** The presence credential registered in the pairing session (spec 7.4 point 1). Absent: the device only reads (E-8). */
  credential?: CredentialRow
}

/**
 * A WebAuthn credential as the registry keeps it: the id (base64url, the device keeps it too), the uncompressed P-256 key
 * (hex), the last signature counter seen, and whether it is a synced passkey (fixed at registration).
 */
export interface CredentialRow { credentialId: string; publicKey: string; signCount: number; backupEligible: boolean }

export interface TicketRow { ticketId: string; exp: number; keyId: string }
export interface DenyRow { ticketId: string; exp: number }

export type PairCmd =
  | { cmd: 'pair.begin' }
  | { cmd: 'pair.sas'; pairId: string; digits: string }
  | { cmd: 'pair.cancel'; pairId: string }
  | { cmd: 'pair.state'; pairId: string }
  | { cmd: 'status' }
  /** The person ends the live sessions of one device on the machine; the device is not revoked and may come back. */
  | { cmd: 'session.end'; deviceId: string }

/** extension → portal */
export type ToPortal =
  /** `webUrl`: the address of the phone's app; its origin is the relying party of WebAuthn. Absent: no presence credential. */
  | { t: 'init'; relayUrl: string; houseName: string; webUrl?: string; devices: PortalDevice[]; deny: DenyRow[] }
  /** The address of the phone's app changed while the portal was up. */
  | { t: 'web'; webUrl?: string }
  | ({ t: 'cmd'; id: number } & PairCmd)
  | { t: 'device'; device: PortalDevice }
  | { t: 'forget'; deviceId: string }
  /** Revocation, after the registry was written (spec 6.1 order): close its sessions with CLOSE(0x04), deny its tickets. */
  | { t: 'revoke'; deviceId: string; deny: DenyRow[] }
  | { t: 'answer'; id: number; ok: boolean; error?: string }
  | { t: 'stop' }

/** What the portal asks the registry's only writer to do; the portal goes on only after `answer ok`. */
export type PortalAsk =
  /** The SAS matched: write the device as `pending` with its first ticket. */
  | { ask: 'paired'; device: { deviceId: string; pubD: string; name: string; ver: number; access: 'code' | 'qr' }; ticket: TicketRow }
  /** admit.renew: record the new ticket; refused when the device is not active (a revocation runs first) or the key was used. */
  | { ask: 'renew'; deviceId: string; ticket: TicketRow }
  /** uv.register verified: keep the credential; refused when the device already has one or is revoked. */
  | { ask: 'credential'; deviceId: string; credential: CredentialRow }
  /** An assertion verified with a new signature counter: written before the answer goes (one device at a time). */
  | { ask: 'sign-count'; deviceId: string; signCount: number }

export type PortalNote =
  | { note: 'acked'; deviceId: string }
  | { note: 'erase'; deviceId: string }
  | { note: 'seen'; deviceId: string; ver: number }
  | { note: 'revoke-self'; deviceId: string }
  /** device.revoke with its proof checked: `deviceId` revokes `target` (spec 6.1, from another device). */
  | { note: 'revoke-device'; deviceId: string; target: string }
  | { note: 'link'; state: 'up' | 'down' }
  /** The sessions changed (opened, ended, or what one does): the count and the devices live now. */
  | { note: 'sessions'; count: number; live: LiveDevice[] }
  /** One audit line: the kind of act, the device by id, the target by id or operation name, the result. Never content (M-10). */
  | { note: 'audit'; act: string; deviceId?: string; target?: string; result: string }

/** portal → extension */
export type FromPortal =
  /** The credential was read and the folder is private: the portal listens now and waits for `init`. */
  | { t: 'want-init' }
  | { t: 'ready'; pid: number }
  | { t: 'reply'; id: number; ok: true; result: unknown }
  | { t: 'reply'; id: number; ok: false; error: string; code?: string }
  | ({ t: 'ask'; id: number } & PortalAsk)
  | ({ t: 'note' } & PortalNote)
  /** The portal refuses to serve (folder open, bad config, missing keys): the reason, then it exits. */
  | { t: 'fatal'; reason: string }

/** The pairing ticket as the screen that asked may see it. Never the expected SAS; the code only while `open`. */
export interface PairView {
  pairId: string
  state: 'open' | 'revealed' | 'waiting-sas' | 'confirmed' | 'done' | 'burned'
  expiresAt: number
  /** While `waiting-sas`: what the device declares (sanitized) and the access it used. A declared name is no identity. */
  device?: { declaredName: string; caps: number; access: 'code' | 'qr' }
  triesLeft?: number
  burnReason?: string
}

/** The answer of `pair.begin`: secret, for the connection that asked only. */
export interface PairBegun extends PairView {
  /** `123 456 789 012`. */
  code: string
  /** `#pair=<base64url>` for the PWA's URL fragment. */
  qr: string
  /** The house's fingerprint, to show next to the code. */
  fingerprint: string
}

/**
 * What a device does in its live sessions, as one word of a closed vocabulary: never content, never a request's
 * argument. `watching`: it follows who waits (attention.watch).
 */
export const LIVE_DOING = ['watching'] as const
export type LiveDoing = (typeof LIVE_DOING)[number]

/** One device with at least one live session: since when (ISO, its oldest live session) and what it does, if anything. */
export interface LiveDevice { deviceId: string; since: string; doing?: LiveDoing }

export interface PortalStatus {
  link: 'up' | 'down'
  sessions: number
  houseFingerprint: string
  live: LiveDevice[]
}

/** The answer of `session.end`: how many sessions of the device were closed. */
export interface SessionEnded { deviceId: string; ended: number }

/** Exit codes of the portal: why it did not serve. */
export const PORTAL_EXIT = { ok: 0, crashed: 1, badCredential: 2, folderOpen: 3, config: 4, keys: 5, pipe: 6 } as const
