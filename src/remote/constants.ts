// Constants of the remote wire, v1 (spec 0.2) and the domain labels (spec 1.4). Durations carry their unit in the
// name: `_MS` for local timers, `_S` for values compared with Unix seconds that travel on the wire.
import { ascii, concat, u8, type Bytes } from './bytes.ts'

export const WIRE_VERSION = 0x01
export const SUITE = 0x01
/** Versions this build speaks on the wire. A new suite is a new version (spec 2.5 rule 1). */
export const SUPPORTED_VERSIONS: readonly number[] = [WIRE_VERSION]

export const MAX_PRE_AUTH = 4096
export const MAX_HS_INNER = 1024
export const MAX_INNER = 262_144
export const MAX_OUTER = MAX_INNER + 8
/** Largest padded record plaintext that fits MAX_INNER (type 1 + ctr 8 + tag 16), and the content it carries. */
export const MAX_RECORD_PLAINTEXT = 261_120
export const MAX_RECORD_CONTENT = MAX_RECORD_PLAINTEXT - 5

export const AUTH_DEADLINE_MS = 10_000
export const HS_DEADLINE_MS = 10_000
export const FAIL_DELAY_MS = 500
export const HB_INTERVAL_MS = 20_000
export const HB_TIMEOUT_MS = 60_000

export const REKEY_FRAMES = 2 ** 31
export const REKEY_BYTES = 2 ** 36
export const REKEY_AGE_MS = 24 * 3600 * 1000

export const PAIR_TTL_S = 120
export const PAIR_TTL_MS = PAIR_TTL_S * 1000
export const PAIR_SAS_WINDOW_MS = 120_000
export const PAIR_SAS_TRIES = 3
export const PAIR_REVEALS = 1
export const PAIR_ACK_WAIT_MS = 30_000
export const PAIR_LOCKOUT_FAILURES = 5
export const PAIR_LOCKOUT_WINDOW_MS = 60 * 60 * 1000
export const PAIR_LOCKOUT_BLOCK_MS = 60 * 60 * 1000
export const PAIR_CODE_DIGITS = 6
export const DEVICE_NAME_MAX = 64

const DAY_S = 86_400
export const ADMIT_TTL_S = 30 * DAY_S
export const ADMIT_RENEW_AGE_S = DAY_S
export const KEYCERT_TTL_R_S = 30 * DAY_S
export const KEYCERT_TTL_T_S = 90 * DAY_S
export const DENY_MAX = 1024
export const CLOCK_SKEW_S = 300
export const KEY_ROTATE_MIN_OVERLAP_S = ADMIT_TTL_S + DAY_S

export const IDLE_LOCK_MS = 15 * 60 * 1000
export const ABS_LOCK_MS = 12 * 3600 * 1000
export const ELEV_WINDOW_S = 15 * 60
export const UV_CHALLENGE_TTL_MS = 120_000
export const ROUTES_PER_HOUSE = 32
export const SESSIONS_PER_DEVICE = 3
export const ACT_CACHE_MAX = 1024
export const ACT_CACHE_TTL_MS = 15 * 60 * 1000

export const AUD_MAX = 253
export const WS_SUBPROTOCOL = 'tether-remote.v1'

/** Every label name of spec 1.4. `pair-ticket` is reserved and never used. */
export const LABEL_NAMES = [
  'house-id', 'device-id', 'key-id', 'th', 'pair-rv', 'pair-commit',
  'k-hs-d2h', 'k-hs-h2d', 'k-d2h', 'k-h2d', 'sas', 'pair-confirm', 'rec',
  'house-hs', 'device-hs', 'house-pair', 'device-pair', 'key-cert', 'key-rotate', 'key-rotate-accept',
  'relay-auth', 'relay-admit', 'relay-pop', 'uv', 'uv-reg', 'uv-window', 'act', 'pair-ticket',
] as const
export type LabelName = (typeof LABEL_NAMES)[number]

const LABEL_PREFIX = 'tether-remote/v1/'
const labelCache = new Map<LabelName, Bytes>()

/** `LBL(name) = ASCII("tether-remote/v1/" + name) ‖ 0x00`. The final zero keeps one label from prefixing another. */
export function LBL(name: LabelName): Bytes {
  let b = labelCache.get(name)
  if (!b) { b = concat(ascii(LABEL_PREFIX + name), u8(0)); labelCache.set(name, b) }
  return concat(b)
}

/** Transcript modes (spec 3.5 and 4.2). */
export const MODE_PAIR = 0x01
export const MODE_SESSION = 0x02

/** Record directions (spec 4.5). */
export const DIR_D2H = 0x01
export const DIR_H2D = 0x02

/** Key certificate roles (spec 5.1). */
export const CERT_ROLE_RELAY = 0x01
export const CERT_ROLE_TICKET = 0x02

/** CLOSE codes (spec 4.7). */
export const CLOSE = {
  normal: 0x01,
  rekey: 0x02,
  idle: 0x03,
  revoked: 0x04,
  protocol: 0x05,
  remoteOff: 0x06,
  limit: 0x07,
} as const

/** `presence` byte of HS_DONE (spec 2.4). */
export const PRESENCE = { locked: 0x00, unlocked: 0x01, noCredential: 0x02 } as const
export type Presence = (typeof PRESENCE)[keyof typeof PRESENCE]
