// Public surface of the remote wire module (spec: fio-spec v1). Pure: crypto.subtle, Uint8Array, no node:*, no DOM.
// The same file is imported by the portal (Node 24), the relay and the PWA. `testing.ts` is deliberately not
// exported from here: it holds the fixed-entropy seam of the vectors and must not reach a production bundle.

// Bytes and errors
export { WireError, toHex, fromHex, b64url, fromB64url, base32, concat, equal, ctEqual, randomBytes } from './bytes.ts'
export type { Bytes, WireErrorCode } from './bytes.ts'
export * from './constants.ts'
export { audBytes, audFromBytes, isValidAudBytes, relayUrlAllowed } from './aud.ts'

// Frames (spec 2)
export {
  encodeOuter, decodeOuter, encodeInner, decodeInner, innerTypeOf, HS_FAIL_FRAME, OTYPE, ITYPE, INNER_SIZE, P3_MAX,
  R_AUTH_FAIL_CODE, PAIR_STATE, NOTICE, ROUTE_KIND, KEY_CERT_SIZE,
} from './frames.ts'
export type { OuterFrame, OuterType, InnerFrame, InnerType, Leg, Sender, DenyEntry } from './frames.ts'
export {
  CTYPE, CTYPE_SENDER, RES_STATUS, CAPS, paddedSize, encodeReq, decodeReq, encodeRes, decodeRes, encodeEvt, decodeEvt,
  encodeBin, decodeBin, parseJsonObject, sanitizeDeclaredName, parseTypedCode, formatTypedCode, encodeQrBlob,
  decodeQrBlob, qrFragment, parseQrFragment,
} from './content.ts'
export type { ContentType, CloseCode, Req, Res, Evt, Bin, UvProof, ResStatus, DeviceHello, QrBlob, HsDone, PairDone } from './content.ts'

// Keys, identifiers, certificates and tickets (spec 1, 5.1, 5.2, 6.4)
export { selfTest, generateRoleKey, roleKey, verifyLabeled, isValidPoint, ROLE_LABELS } from './crypto.ts'
export type { RoleKey, KeyRole, SignLabel } from './crypto.ts'
export {
  houseIdOf, deviceIdOf, keyIdOf, houseIdText, houseFingerprint, issueKeyCert, parseKeyCert, verifyKeyCert,
  houseKeysDistinct, issueAdmitTicket, parseAdmitTicket, encodeKeyRotateBody, parseKeyRotateBody, verifyKeyRotate,
} from './keys.ts'
export type { KeyCert, CertRole, AdmitTicket, KeyRotate } from './keys.ts'

// Session and its handshake (spec 4). A session is only ever handed out by a handshake or a pairing.
export { DeviceHandshake, HouseHandshake } from './session.ts'
export type {
  Session, SessionEffect, SessionRole, AppContentType, DeviceHsEffect, DeviceHsFailure, HsDoneInfo, DeviceHandshakeInit,
  HouseHsEffect, HouseHandshakeInit, DeviceRecord, DeviceLookup,
} from './session.ts'

// Pairing (spec 3)
export { DevicePairing, HousePairing, PairLockout, accessFromCode, accessFromQr } from './pairing.ts'
export type {
  PairAccess, DevicePairEffect, DevicePairFailure, PairResult, DevicePairingInit, HousePairEffect, HousePairingInit,
  PairState, BurnReason, PendingDevice, PairedDevice,
} from './pairing.ts'

// Admission at the relay (spec 5)
export {
  buildHouseAuth, verifyHouseAuth, buildDeviceAdmit, verifyDeviceAdmit, DenyList, admitRenewKeyAllowed,
} from './admission.ts'
export type { RelayHouse, HouseAuthFailure, AdmitCheck, AdmitVerdict } from './admission.ts'

// Operations and presence on the wire (spec 7)
export { OPS, OP_CODES, OP_TABLE, opByCode, opByName, EVT, evtByCode, SCOPE_FAMILIES, RANGE_SCOPES, knownScopes } from './scopes.ts'
export type { OpLine, OpName, OpRule, OpScope, ScopeFamily, PresenceClass, EvtLine, EvtName } from './scopes.ts'
export { ActCache } from './ops.ts'
// What a device receives (the projectors themselves are the portal's: src/remote/projection.ts, imported where they run).
export type {
  SessionInfo, AdmitRenewed, AttentionItem, AttentionList, RemoteProc, RemoteProfile, RemoteAuthor, ErrorCode,
} from './projection.ts'
export {
  UV_PURPOSE, uvChallenge, unlockDigest, elevateDigest, actDigest, uvRegChallenge, derToP1363,
} from './presence.ts'
export type { UvPurpose, PresenceVerifier } from './presence.ts'
