// A file of the Quick Open list, its label and description computed once (the scorer asks for them on every comparison).
import { basename, dirname } from 'node:path'
import type { IItemAccessor } from '../shared/vscode-fuzzy-scorer.ts'

export interface FileEntry { rel: string; label: string; description: string }

export function fileEntry(rel: string): FileEntry {
  return { rel, label: basename(rel), description: dirname(rel) }
}

/** VS Code's FileMatchItemAccessor (rawSearchService): scored on the path relative to the root. */
export const relAccessor: IItemAccessor<FileEntry> = {
  getItemLabel: m => m.label,
  getItemDescription: m => m.description,
  getItemPath: m => m.rel,
}
