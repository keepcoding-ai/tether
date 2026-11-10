// E15 (design §4.3): what the browser extension writes to a log never carries a page address, an agent's key or what
// `endpoint.json` holds (the gate's port and instance). Every log line of the extension passes through `scrubLogLine`, also
// the error texts it quotes (Chromium's load errors carry the address). Slot and tab ids stay: they are what makes a line useful.

export const ADDRESS = '[endereço]'
export const PORT = '[porta]'
export const KEY = '[chave]'

const URL_WITH_AUTHORITY = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>`)\]]+/gi
const URL_WITHOUT_AUTHORITY = /\b(?:data|javascript|blob|about|mailto|file|chrome|devtools):[^\s'"`]+/gi
const LOOPBACK_PORT = /\b(127\.0\.0\.1|localhost|\[::1\]):\d+/gi
const ENDPOINT_PORT = /("port"\s*:\s*)\d+/g
const ENDPOINT_INSTANCE = /("instance"\s*:\s*)"[^"]*"/g
/** A run of base64url of 32+ characters: the agents' keys are 192 bits (32 characters). */
const KEY_LIKE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function scrubLogLine(line: string): string {
  return line
    .replace(URL_WITH_AUTHORITY, ADDRESS)
    .replace(URL_WITHOUT_AUTHORITY, ADDRESS)
    .replace(LOOPBACK_PORT, `$1:${PORT}`)
    .replace(ENDPOINT_PORT, `$1${PORT}`)
    .replace(ENDPOINT_INSTANCE, `$1"${KEY}"`)
    .replace(KEY_LIKE, m => (UUID.test(m) ? m : KEY))
}
