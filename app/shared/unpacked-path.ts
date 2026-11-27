/**
 * Path to hand to a process outside Electron (the system `node` running tetherd, rg, ...). Electron reads inside
 * `app.asar` transparently, but an external process does not: the files it needs live in `app.asar.unpacked`
 * (electron-builder `asarUnpack`). Without asar (dev) the path comes back unchanged; an existing
 * `app.asar.unpacked` segment is left alone. Both separators are matched (\x5c is the Windows backslash).
 */
export function externalPath(p: string): string {
  return p.replace(/([\x5c/])app\.asar(?=[\x5c/]|$)/, '$1app.asar.unpacked')
}
