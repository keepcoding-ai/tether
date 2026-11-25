// The channels extension's main side (slice A1): what the speaking box needs of the system to attach files. It looks at the
// files the person chose or pasted (size, folder, a small thumbnail of an image), opens the file picker, and stages a print
// pasted from the clipboard as a PNG under <home>/channels/.staging/ (cleared at start and once each print is sent or taken
// out). The copy into a channel is the daemon's, on `say`, with its own check: nothing here decides what a channel accepts.
import { randomUUID } from 'node:crypto'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { clipboard, dialog, nativeImage } from 'electron'
import type { TetherMain } from '../../app/main/ext-api.ts'
import type { IDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { ATTACH_MAX_BYTES, kindOf, safeFileName } from './attachments.ts'
import { INSPECT_MAX, LOOK_MAX, THUMB_PX, VIEWER_PX, VIEW_THUMB_PX, type AttachInfo, type ChannelsIpc, type FileLook, type FileView } from './ipc.ts'

export { manifest } from './manifest.ts'

/** A small data: URL of an image file, or undefined (not an image, too large to bother, or the system cannot read it). */
async function thumbOf(path: string, name: string, size: number, px = THUMB_PX): Promise<string | undefined> {
  if (kindOf(name) !== 'image' || size > ATTACH_MAX_BYTES) return undefined
  try {
    const img = await nativeImage.createThumbnailFromPath(path, { width: px, height: px })
    if (!img.isEmpty()) return img.toDataURL()
  } catch { /* not every system makes thumbnails: the file is read below */ }
  try {
    const img = nativeImage.createFromPath(path)
    if (img.isEmpty()) return undefined
    const { width, height } = img.getSize()
    return (width >= height ? img.resize({ width: Math.min(px, width) }) : img.resize({ height: Math.min(px, height) })).toDataURL()
  } catch {
    return undefined
  }
}

async function inspectOne(path: string, name?: string): Promise<AttachInfo> {
  const shown = name ?? basename(path)
  try {
    const s = await stat(path)
    const isDirectory = !s.isFile()
    const thumb = isDirectory ? undefined : await thumbOf(path, shown, s.size)
    return { path, name: shown, size: s.size, isDirectory, missing: false, ...(thumb ? { thumb } : {}) }
  } catch {
    return { path, name: shown, size: 0, isDirectory: false, missing: true }
  }
}

async function lookOne(path: string): Promise<FileLook> {
  try {
    const s = await stat(path)
    if (!s.isFile()) return { path, missing: true }
    const thumb = await thumbOf(path, basename(path), s.size, VIEW_THUMB_PX)
    return { path, missing: false, ...(thumb ? { thumb } : {}) }
  } catch {
    return { path, missing: true }
  }
}

/** The image at viewing size: read by the system's own decoder, shrunk when over VIEWER_PX, a JPEG stays a JPEG (small) and the rest is a PNG. */
async function viewOne(path: string): Promise<FileView> {
  try {
    const s = await stat(path)
    if (!s.isFile()) return { path, missing: true }
    if (kindOf(basename(path)) !== 'image' || s.size > ATTACH_MAX_BYTES) return { path, missing: false }
    let img = nativeImage.createFromPath(path)
    if (img.isEmpty()) {
      try { img = await nativeImage.createThumbnailFromPath(path, { width: VIEWER_PX, height: VIEWER_PX }) } catch { /* no thumbnailer for this type */ }
    }
    if (img.isEmpty()) return { path, missing: false }
    const { width, height } = img.getSize()
    const small = Math.max(width, height) > VIEWER_PX ? (width >= height ? img.resize({ width: VIEWER_PX }) : img.resize({ height: VIEWER_PX })) : img
    const jpeg = /\.jpe?g$/i.test(path)
    const url = jpeg ? `data:image/jpeg;base64,${small.toJPEG(90).toString('base64')}` : small.toDataURL()
    return { path, missing: false, url, width, height }
  } catch {
    return { path, missing: true }
  }
}

const isPathList =(v: unknown): v is string[] => Array.isArray(v) && v.every((p) => typeof p === 'string' && p !== '' && isAbsolute(p))

export function activate(main: TetherMain): IDisposable[] {
  const staging = resolve(main.home, 'channels', '.staging')
  const inStaging = (p: string): boolean => resolve(p).toLowerCase().startsWith(`${staging.toLowerCase()}${sep}`)
  const channelsRoot = resolve(main.home, 'channels').toLowerCase()
  const inChannelFiles = (p: string): boolean => {
    const rel = resolve(p).toLowerCase()
    if (!rel.startsWith(`${channelsRoot}${sep}`)) return false
    const parts = rel.slice(channelsRoot.length + 1).split(sep)
    return parts.length === 3 && parts[0] !== '.staging' && parts[1] === 'files'
  }
  // What a previous run left (a print pasted and never sent): gone at start.
  void rm(staging, { recursive: true, force: true }).catch(() => undefined)
  const ipc = main.ipc<ChannelsIpc>()
  return [
    ipc.handle('inspect', async (paths) => {
      if (!isPathList(paths)) return []
      return Promise.all(paths.slice(0, INSPECT_MAX).map((p) => inspectOne(p)))
    }),
    ipc.handle('pick', async () => {
      const win = main.window.current()
      const options = { title: 'Anexar arquivo', properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'> }
      const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      if (r.canceled) return []
      return Promise.all(r.filePaths.slice(0, INSPECT_MAX).map((p) => inspectOne(p)))
    }),
    ipc.handle('stageImage', async (name) => {
      const item = (await clipboard.read()).find((i) => i.types.includes('image/png'))
      if (!item) return undefined
      const blob = await item.getType('image/png')
      if (blob.size > ATTACH_MAX_BYTES) return { path: '', name: safeFileName(typeof name === 'string' && name !== '' ? name : 'Captura de tela.png'), size: blob.size, isDirectory: false, missing: false }
      const png = Buffer.from(await blob.arrayBuffer())
      const img = nativeImage.createFromBuffer(png)
      if (img.isEmpty()) return undefined
      const shown = safeFileName(typeof name === 'string' && name !== '' ? name : 'Captura de tela.png')
      await mkdir(staging, { recursive: true })
      const path = join(staging, `${randomUUID()}.png`)
      await writeFile(path, png)
      const { width, height } = img.getSize()
      const thumb = (width >= height ? img.resize({ width: Math.min(THUMB_PX, width) }) : img.resize({ height: Math.min(THUMB_PX, height) })).toDataURL()
      return { path, name: shown, size: png.length, isDirectory: false, missing: false, thumb, staged: true as const }
    }),
    // Only a channel's own folder of files is looked at: <home>/channels/<id>/files/<name>.
    ipc.handle('look', async (paths) => {
      if (!isPathList(paths)) return []
      return Promise.all(paths.slice(0, LOOK_MAX).map((p) => (inChannelFiles(p) ? lookOne(p) : { path: p, missing: true })))
    }),
    ipc.handle('view', async (path) => {
      if (typeof path !== 'string' || !isAbsolute(path) || !inChannelFiles(path)) return { path: String(path), missing: true }
      return viewOne(path)
    }),
    ipc.handle('discard',async (paths) => {
      if (!isPathList(paths)) return
      await Promise.all(paths.filter(inStaging).map((p) => rm(p, { force: true }).catch(() => undefined)))
    }),
  ]
}
