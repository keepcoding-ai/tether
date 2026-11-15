// Opening a file, main-process side (core, F9 slice 2): `file:inspect` says what a path is (text, binary, large, a
// folder, gone) and `file:open-external` hands a binary or too large file to the system's program, never one that
// would run (app/main/file-inspect.ts). The quick-open extension only lists and ranks files.
import type { IpcMain, Shell } from 'electron'
import { closeSync, openSync, readSync } from 'node:fs'
import type { FileTarget } from '../shared/file-open.ts'
import { inspectFile } from './file-inspect.ts'

/** How many bytes decide text vs binary (VS Code reads 512 for its NUL check; a little more costs nothing). */
const HEAD_BYTES = 4096

function readHead(path: string): Buffer {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(HEAD_BYTES)
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0)
    return buf.subarray(0, n)
  } finally { closeSync(fd) }
}

export function registerFileOpen(ipcMain: IpcMain, shell: Shell): void {
  ipcMain.handle('file:inspect', (_e, path: unknown): FileTarget =>
    typeof path === 'string' && path.trim() !== '' ? inspectFile(path, readHead) : { kind: 'missing' })
  ipcMain.handle('file:open-external', async (_e, path: unknown): Promise<{ ok: true } | { ok: false; message: string }> => {
    if (typeof path !== 'string' || path.trim() === '') return { ok: false, message: 'Caminho inválido.' }
    const target = inspectFile(path, readHead)
    if (target.kind === 'missing') return { ok: false, message: 'O arquivo não existe mais.' }
    if (target.kind === 'folder') return { ok: false, message: 'O caminho é uma pasta.' }
    if (target.kind === 'text') return { ok: false, message: 'Arquivo de texto: abre no editor do Tether.' }
    if (target.runnable) return { ok: false, message: 'Este tipo de arquivo é executável: o Tether não o abre.' }
    const err = await shell.openPath(path)
    return err ? { ok: false, message: err } : { ok: true }
  })
}
