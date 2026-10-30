// OSC 52 ("set clipboard"): a program writes `ESC ] 52 ; Pc ; Pd BEL` and Pd, base64 of the text, lands in the
// Windows clipboard. Pc names the selection (c, p, s, …): there is one clipboard here, so every Pc goes to it.
// Pure (no DOM, no xterm) so it is unit-tested under Node.

/** The text an OSC 52 payload (`Pc;Pd`) sets, or undefined for a query (`?`), an empty payload or bad base64. */
export function decodeOsc52(data: string): string | undefined {
  const sep = data.indexOf(';')
  const payload = sep >= 0 ? data.slice(sep + 1) : data
  if (payload === '' || payload === '?') return undefined
  // Base64 as the terminal protocols send it: standard alphabet, padding optional, no whitespace.
  const compact = payload.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return undefined
  try {
    const bin = atob(compact)
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}
