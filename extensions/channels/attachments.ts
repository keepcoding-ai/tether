// The pure rules of a speech's attachments (slice A1), read by both hosts: the app checks a file before it becomes a chip, the
// daemon checks it again before it copies it into the channel's folder (<home>/channels/<id>/files/). No runtime import, like
// rules.ts: nothing of one host is pulled into the other and nothing runs at load beyond declarations.
//
// A file is refused by its NAME and its kind, never by its content: the tether does not open a file to decide. Someone who
// renames a secret gets past the refusal; the room's warning on the chips is the second guard.

import type { LineFile } from './rules.ts'

export type { LineFile }

/** The largest file one speech may carry. */
export const ATTACH_MAX_BYTES = 20 * 1024 * 1024
/** The most files one speech may carry. */
export const ATTACH_MAX_PER_SAY = 10
/** The channel's folder of files, beside its record. */
export const FILES_DIR = 'files'
/** The longest name a copied file gets (the extension is kept). */
export const FILE_NAME_MAX = 120
/** The line that opens the paths of a speech's files, for the agents and in `channels read`. */
export const ANEXOS_LINE = 'anexos:'

/** A file a speech carries, as `say` asks it: where it is now and, optionally, the name it goes by (a pasted print's generated name). */
export interface FileSource { path: string; name?: string }

/** Why a file did not go into a speech. */
export type FileRefusal = 'secret-file' | 'too-large' | 'is-folder' | 'not-found' | 'too-many' | 'copy-failed'

/** The last segment of a path (either separator). */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

/** The extension with its dot ('.png'), '' when the name has none (a leading dot alone, as in '.gitignore', is no extension). */
export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i) : ''
}

/** Whether a file's name looks like a secret: `.env`, `.env.*`, `*.keys`, `*.pem`, `*.key`, `*.pfx`, `id_rsa*`, `credentials*`. */
export function isSecretName(name: string): boolean {
  const n = baseName(name).trim().toLowerCase()
  return n === '.env' || n.startsWith('.env.') || n.endsWith('.keys') || n.endsWith('.pem') || n.endsWith('.key') || n.endsWith('.pfx')
    || n.startsWith('id_rsa') || n.startsWith('credentials')
}

/** What the rules know of a file before it goes in: its name, its size and whether it is a folder or is gone. */
export interface FileFacts { name: string; size: number; isDirectory?: boolean; missing?: boolean }

/** Why one file cannot go in, by itself (the count is `admit`'s): gone, a folder, a secret's name, too large. */
export function fileRefusal(f: FileFacts): FileRefusal | undefined {
  if (f.missing) return 'not-found'
  if (f.isDirectory) return 'is-folder'
  if (isSecretName(f.name)) return 'secret-file'
  if (f.size > ATTACH_MAX_BYTES) return 'too-large'
  return undefined
}

/**
 * Which of `incoming` go in when `have` files are on the speech already: each refused one with its reason, then the first ones
 * that fit under ATTACH_MAX_PER_SAY; `over` is how many fit-able ones were left out by the count.
 */
export function admit<T extends FileFacts>(have: number, incoming: readonly T[]): { accepted: T[]; refused: Array<{ file: T; why: FileRefusal }>; over: number; tried: number } {
  const accepted: T[] = []
  const refused: Array<{ file: T; why: FileRefusal }> = []
  let over = 0
  for (const f of incoming) {
    const why = fileRefusal(f)
    if (why) { refused.push({ file: f, why }); continue }
    if (have + accepted.length >= ATTACH_MAX_PER_SAY) { over++; continue }
    accepted.push(f)
  }
  return { accepted, refused, over, tried: incoming.length - refused.length }
}

/** A name safe on every disk: no folder, no character Windows refuses, no reserved device name, no trailing dot or space, bounded. */
export function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  let n = baseName(name).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim().replace(/[. ]+$/, '')
  if (n === '' || /^\.+$/.test(n)) n = 'arquivo'
  const ext = extOf(n)
  const stem = ext ? n.slice(0, -ext.length) : n
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(stem)) n = `_${n}`
  if (n.length > FILE_NAME_MAX) {
    const keep = ext.length < 20 ? ext : ''
    n = n.slice(0, FILE_NAME_MAX - keep.length).replace(/[. ]+$/, '') + keep
  }
  return n
}

/** The n-th name of a file whose name is taken: `contrato-v3 (2).pdf`; n = 1 is the name itself. */
export function numberedName(name: string, n: number): string {
  if (n <= 1) return name
  const ext = extOf(name)
  return `${ext ? name.slice(0, -ext.length) : name} (${n})${ext}`
}

const two = (n: number): string => String(n).padStart(2, '0')

/** The name of a print pasted from the clipboard: `Captura de tela 2026-11-24 09.41.07.png` (local time; dots, a name has no colon). */
export function screenshotName(d: Date): string {
  return `Captura de tela ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}.${two(d.getMinutes())}.${two(d.getSeconds())}.png`
}

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.csv': 'text/csv', '.html': 'text/html',
  '.zip': 'application/zip', '.ts': 'text/plain', '.js': 'text/javascript', '.mp4': 'video/mp4', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}
/** The type by the extension; `application/octet-stream` when unknown. */
export function mimeOf(name: string): string {
  return MIME[extOf(name).toLowerCase()] ?? 'application/octet-stream'
}

/** The kind a chip draws: an image (thumbnail), a PDF, code, or any other file. */
export type FileKind = 'image' | 'pdf' | 'code' | 'other'
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.cs', '.css', '.html', '.sql', '.sh', '.ps1', '.yml', '.yaml', '.toml', '.md'])
export function kindOf(name: string): FileKind {
  const e = extOf(name).toLowerCase()
  return IMAGE_EXT.has(e) ? 'image' : e === '.pdf' ? 'pdf' : CODE_EXT.has(e) ? 'code' : 'other'
}
export const KIND_LABEL: Record<FileKind, string> = { image: 'Imagem', pdf: 'PDF', code: 'Código', other: 'Arquivo' }

/** A size in words: `12 bytes`, `412 KB`, `2,3 MB`, `148 MB`. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  const mb = bytes / (1024 * 1024)
  return mb < 10 ? `${mb.toFixed(1).replace('.', ',')} MB` : `${Math.round(mb)} MB`
}

/**
 * The text of a speech with its files, as the agents get it and as `channels read` shows it: the text, then the line `anexos:`
 * and one absolute path per line. A speech with no text is the block alone; with no files, the text alone.
 */
export function withFiles(body: string, files: readonly Pick<LineFile, 'path'>[] | undefined): string {
  if (!files?.length) return body
  const block = [ANEXOS_LINE, ...files.map((f) => f.path)].join('\n')
  const text = body.replace(/\s+$/, '')
  return text === '' ? block : `${text}\n${block}`
}

/** What the screen says of a refused file: a bold lead and the rest (the texts of the approved preview, screen 10). */
export function refusalText(why: FileRefusal, name: string, extra: { size?: number; accepted?: number; tried?: number } = {}): { lead: string; rest: string } {
  switch (why) {
    case 'too-large':
      return { lead: `${name} não entrou.`, rest: `Tem ${sizeLabel(extra.size ?? 0)} e o limite é ${sizeLabel(ATTACH_MAX_BYTES)} por arquivo. Envie um trecho menor ou comprima o arquivo.` }
    case 'secret-file':
      return { lead: `${name} não entrou.`, rest: 'Arquivos de variáveis, chaves e certificados não são anexados, porque todos os membros do canal poderiam lê-los. Se for um arquivo comum com outro nome, renomeie e anexe de novo.' }
    case 'is-folder':
      return { lead: `${name} não entrou.`, rest: 'Pastas não podem ser anexadas. Compacte em .zip e anexe de novo.' }
    case 'not-found':
      return { lead: `${name} não entrou.`, rest: 'O arquivo não está mais onde estava. Confira e anexe de novo.' }
    case 'copy-failed':
      return { lead: `${name} não foi enviado.`, rest: 'Não consegui copiar o arquivo para a pasta do canal. Confira se o disco tem espaço e tente de novo.' }
    case 'too-many':
      return { lead: `Entraram ${extra.accepted ?? 0} de ${extra.tried ?? 0} arquivos.`, rest: `O limite é ${ATTACH_MAX_PER_SAY} por fala. Envie estes e anexe o resto na fala seguinte.` }
  }
}

/** The room's warning while the box holds files, and the count when there is more than one. */
export function roomNote(n: number): string {
  if (n <= 0) return ''
  return n === 1 ? 'Todos os membros do canal poderão ler este arquivo.' : `Todos os membros do canal poderão ler estes arquivos. · ${n} de ${ATTACH_MAX_PER_SAY}`
}
