// The layout file (<TETHER_HOME>/layout.json) is the person's arrangement of panels and the one file the app
// cannot rebuild. Every save keeps the previous content in layout.json.bak (an atomic rename), the new
// content lands by temp + rename, and a missing, empty or corrupt layout.json falls back to the backup.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function layoutBackupPath(path: string): string {
  return `${path}.bak`
}

/** The parsed file, or null when it is missing, empty or not JSON. */
function readLayout(path: string): unknown | null {
  try {
    const text = readFileSync(path, 'utf8')
    if (text.trim() === '') return null
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

export function loadLayoutFile(path: string): unknown | null {
  return readLayout(path) ?? readLayout(layoutBackupPath(path))
}

export function saveLayoutFile(path: string, layout: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  // Only a readable previous layout is worth keeping: a corrupt file must not replace a good backup.
  if (readLayout(path) !== null) renameSync(path, layoutBackupPath(path))
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(layout, null, 2))
  renameSync(tmp, path)
}
