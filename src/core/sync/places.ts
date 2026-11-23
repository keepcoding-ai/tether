// Places: how a folder travels between machines. An absolute path (`C:\atrium\workspace\x`) means nothing on
// another machine, so what travels is a PlaceRef (a logical place name plus a relative path inside it) and each
// machine keeps a local map place -> real folder in <tetherHome>/places.json.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { upperDrive } from '../paths.ts'

/** A folder as it travels: a logical place plus a path inside it ('/' separators, '' = the place's root). */
export interface PlaceRef { place: string; rel: string }
/** This machine's map: place name → absolute folder. */
export type PlaceMap = Record<string, string>
export const HOME_PLACE = 'home' // built in: always the user's home dir, never stored in the map

export interface PlaceOpts { platform?: NodeJS.Platform; homedir?: string }

const PLACE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/

export function isPlaceName(x: unknown): x is string {
  return typeof x === 'string' && PLACE_NAME_RE.test(x)
}

interface Ctx { p: typeof win32; win: boolean; home: string }

function ctx(opts?: PlaceOpts): Ctx {
  const win = (opts?.platform ?? process.platform) === 'win32'
  return { p: win ? win32 : posix, win, home: opts?.homedir ?? osHomedir() }
}

interface Parts { root: string; segs: string[] }

/** Root plus segments of an absolute path; separators normalized, case kept. */
function parts(c: Ctx, path: string): Parts {
  const norm = c.p.normalize(path)
  const root = c.p.parse(norm).root
  const segs = norm.slice(root.length).split(c.win ? /[\\/]/ : '/').filter(Boolean)
  return { root, segs }
}

const fold = (c: Ctx, s: string): string => (c.win ? s.toLowerCase() : s)

/** Whole-segment containment: `base` is `target` or one of its ancestors. */
function contains(c: Ctx, base: Parts, target: Parts): boolean {
  if (fold(c, base.root) !== fold(c, target.root)) return false
  if (base.segs.length > target.segs.length) return false
  return base.segs.every((s, i) => fold(c, s) === fold(c, target.segs[i]!))
}

/** The folder written back into a map: normalized, no trailing separator, upper-case drive on win32. */
function cleanDir(c: Ctx, path: string): string {
  const { root, segs } = parts(c, path)
  const out = root + segs.join(c.p.sep)
  return c.win ? upperDrive(out) : out
}

export function toRef(path: string, map: PlaceMap, opts?: PlaceOpts): PlaceRef | undefined {
  const c = ctx(opts)
  const target = parts(c, path)
  let best: { place: string; len: number } | undefined
  for (const [place, dir] of Object.entries(map)) {
    if (place === HOME_PLACE) continue
    const base = parts(c, dir)
    if (!contains(c, base, target)) continue
    if (!best || base.segs.length > best.len) best = { place, len: base.segs.length }
  }
  if (best) return { place: best.place, rel: target.segs.slice(best.len).join('/') }
  const home = parts(c, c.home)
  if (contains(c, home, target)) return { place: HOME_PLACE, rel: target.segs.slice(home.segs.length).join('/') }
  return undefined
}

export function fromRef(ref: PlaceRef, map: PlaceMap, opts?: PlaceOpts): string | undefined {
  const c = ctx(opts)
  const base = ref.place === HOME_PLACE ? c.home : map[ref.place]
  if (typeof base !== 'string' || base === '') return undefined
  const rel = ref.rel
  if (/^[\\/]/.test(rel) || /^[a-zA-Z]:/.test(rel)) return undefined // absolute
  const segs = rel.split(/[\\/]/).filter((s) => s !== '' && s !== '.')
  if (segs.includes('..')) return undefined // never escapes the place
  const out = c.p.join(base, ...segs)
  return c.win ? upperDrive(out) : out
}

/** A name for a new place: the folder's last segment, lower-case ASCII, `[a-z0-9-]`; `-2`, `-3`… when taken. */
export function placeName(path: string, taken: Iterable<string>, opts?: PlaceOpts): string {
  const c = ctx(opts)
  const { segs } = parts(c, path)
  const last = segs[segs.length - 1] ?? ''
  const slug = last
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  const base = slug || 'place'
  const used = new Set(taken)
  used.add(HOME_PLACE)
  if (!used.has(base)) return base
  for (let n = 2; ; n++) {
    const name = `${base}-${n}`
    if (!used.has(name)) return name
  }
}

export function ensureRef(path: string, map: PlaceMap, opts?: PlaceOpts): { ref: PlaceRef; map: PlaceMap; added?: string } {
  const found = toRef(path, map, opts)
  if (found) return { ref: found, map }
  const name = placeName(path, Object.keys(map), opts)
  return { ref: { place: name, rel: '' }, map: { ...map, [name]: cleanDir(ctx(opts), path) }, added: name }
}

/** The machine-local file: not synced, since its folders only mean something here. */
export function placesPath(home: string): string {
  return join(home, 'places.json') // a disk path of this machine, so the host's own join is the right one
}

export function readPlaceMap(home: string): PlaceMap {
  const out: PlaceMap = {}
  let doc: unknown
  try {
    doc = JSON.parse(readFileSync(placesPath(home), 'utf8'))
  } catch {
    return out
  }
  if (doc === null || typeof doc !== 'object') return out
  const places = (doc as { places?: unknown }).places
  if (places === null || typeof places !== 'object' || Array.isArray(places)) return out
  for (const [name, dir] of Object.entries(places)) {
    if (name === HOME_PLACE || !isPlaceName(name)) continue
    if (typeof dir !== 'string' || dir === '') continue
    out[name] = dir
  }
  return out
}

export function writePlaceMap(home: string, map: PlaceMap): void {
  const file = placesPath(home)
  const places: PlaceMap = {}
  for (const name of Object.keys(map).sort()) places[name] = map[name]!
  mkdirSync(home, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ v: 1, places }, null, 2) + '\n')
  renameSync(tmp, file)
}
