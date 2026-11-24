// The sync engine's ports over the files on disk: what `tether sync` (the CLI process) reads and writes. Profiles, slots,
// settings.json (JSONC: edited in place, comments survive), keybindings.json and layout.json (atomic, with its .bak).
// Where tetherd is up it owns an in-memory copy of the profiles and learns of slot renames only through its own requests,
// so those writes go through it (`daemon`); a slot created on disk is adopted by it. The arrangement (layout.json) is
// the renderer's while the app is open: the CLI decides whether that is safe before it calls `apply`.
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parse, type ParseError } from 'jsonc-parser'
import { parseSettings, setSettingText, treeValueAt, diffSettings } from '../../../app/shared/settings-file.ts'
import type { OkReply, RequestBody } from '../../daemon/client.ts'
import type { Profile } from '../profile.ts'
import { readProfiles, writeProfiles } from '../profile-sync.ts'
import { createSlot, listSlots, writeSlotMeta } from '../store-sync.ts'
import type { ApplyPlan, SyncPorts, Working } from './engine.ts'

/** The part of a daemon client the ports use. */
export interface DaemonRequester {
  request(body: RequestBody): Promise<OkReply>
}

export interface DiskPortsOpts {
  /** TETHER_HOME: profiles, slots, layout.json. */
  home: string
  /** The person's folder: settings.json, keybindings.json. */
  userDir: string
  /** A connected tetherd, when there is one. */
  daemon?: DaemonRequester | undefined
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

function readText(file: string): string | undefined {
  try { return readFileSync(file, 'utf8') } catch { return undefined }
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

export const layoutPath = (home: string): string => join(home, 'layout.json')
export const settingsPath = (userDir: string): string => join(userDir, 'settings.json')
export const keybindingsPath = (userDir: string): string => join(userDir, 'keybindings.json')

function parseJsonFile(text: string | undefined): unknown {
  if (text === undefined || text.trim() === '') return undefined
  try { return JSON.parse(text) as unknown } catch { return undefined }
}

/** layout.json as the app loads it: the file, else its .bak, else an empty arrangement (which the engine leaves alone). */
export function readLayoutFile(home: string): Record<string, unknown> {
  const path = layoutPath(home)
  for (const file of [path, `${path}.bak`]) {
    const doc = parseJsonFile(readText(file))
    if (isObject(doc)) return doc
  }
  return {}
}

/** Same as the app's save: the previous readable content stays in layout.json.bak, the new one lands by temp + rename. */
export function writeLayoutFile(home: string, layout: unknown): void {
  const path = layoutPath(home)
  if (parseJsonFile(readText(path)) !== undefined) copyFileSync(path, `${path}.bak`)
  writeAtomic(path, JSON.stringify(layout, null, 2))
}

/**
 * `text` (the person's settings.json, comments and all) turned into the settings tree `next`: only the keys that differ
 * are edited, each in place. An empty or missing file simply gets the tree. A text that does not parse is refused
 * (throws): it is never rewritten.
 */
export function rewriteSettingsText(text: string | undefined, next: Record<string, unknown>): string {
  if (text === undefined || text.trim() === '') return JSON.stringify(next, null, 2) + '\n'
  const parsed = parseSettings(text)
  if (parsed.errors.length) throw new Error('o settings.json não está válido (JSON com comentários); corrija o arquivo e tente de novo')
  let out = text
  for (const key of diffSettings(parsed.value, next)) {
    const edit = setSettingText(out, key.split('.'), [], treeValueAt(next, key))
    if (!edit.ok) throw new Error('o settings.json não está válido; corrija o arquivo e tente de novo')
    out = edit.text
  }
  return out
}

function readKeybindings(text: string | undefined): unknown {
  if (text === undefined || text.trim() === '') return undefined
  const errors: ParseError[] = []
  const value: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false })
  return errors.length ? undefined : value
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

export function createDiskPorts(opts: DiskPortsOpts): SyncPorts {
  const { home, userDir } = opts

  async function applyProfiles(next: Profile[]): Promise<void> {
    const daemon = opts.daemon
    if (!daemon) { writeProfiles(home, next); return }
    const current = readProfiles(home).profiles
    const keep = new Set(next.map((p) => p.id))
    for (const p of next) {
      if (!same(current.find((c) => c.id === p.id), p)) await daemon.request({ t: 'profile-save', profile: p })
    }
    for (const c of current) if (!keep.has(c.id)) await daemon.request({ t: 'profile-delete', profileId: c.id })
  }

  async function applySlots(plan: NonNullable<ApplyPlan['slots']>): Promise<void> {
    for (const meta of plan.create) createSlot(home, meta)
    const metas = new Map(listSlots(home).map((m) => [m.slotId, m]))
    for (const r of plan.rename) {
      if (opts.daemon) { await opts.daemon.request({ t: 'rename-slot', slotId: r.slotId, name: r.name ?? '' }); continue }
      const meta = metas.get(r.slotId)
      if (!meta) continue
      const { name: _old, ...rest } = meta
      writeSlotMeta(home, r.name === undefined || r.name === '' ? rest : { ...rest, name: r.name })
    }
  }

  return {
    async read(): Promise<Working> {
      const settings = parseSettings(readText(settingsPath(userDir)) ?? '').value
      return {
        profiles: readProfiles(home).profiles,
        layout: readLayoutFile(home),
        slots: listSlots(home),
        settings,
        keybindings: readKeybindings(readText(keybindingsPath(userDir))),
      }
    },

    async apply(plan: ApplyPlan): Promise<void> {
      if (plan.profiles) await applyProfiles(plan.profiles)
      if (plan.slots) await applySlots(plan.slots)
      if (plan.settings) {
        const file = settingsPath(userDir)
        writeAtomic(file, rewriteSettingsText(readText(file), plan.settings))
      }
      if (plan.keybindings !== undefined) writeAtomic(keybindingsPath(userDir), JSON.stringify(plan.keybindings, null, 2) + '\n')
      if (plan.layout) writeLayoutFile(home, plan.layout)
    },
  }
}
