// The pure rules of the image viewer and of dropping files on the channel's pane (slice A3). No DOM: a test reads them as they are.
import { ATTACH_MAX_BYTES, ATTACH_MAX_PER_SAY, sizeLabel } from '../attachments.ts'

/** The image before or after `current` among the conversation's images (it stops at the ends); undefined when there is none there. */
export function neighbourOf(paths: readonly string[], current: string, dir: -1 | 1): string | undefined {
  const i = paths.indexOf(current)
  if (i < 0) return undefined
  return paths[i + dir]
}

/** "3 de 7" for the viewer's footer; '' while the image is alone (nothing to walk). */
export function positionText(paths: readonly string[], current: string): string {
  const i = paths.indexOf(current)
  return i < 0 || paths.length < 2 ? '' : `${i + 1} de ${paths.length}`
}

/** The viewer's subtitle: "Imagem · 412 KB · 1280 x 800" (the size of the picture only when it is known). */
export function viewerSubtitle(label: string, dims?: { width: number; height: number }): string {
  return dims && dims.width > 0 && dims.height > 0 ? `${label} · ${dims.width} x ${dims.height}` : label
}

/** Whether a drag carries files of the system (a tab or a panel of the app, or selected text, carries none: only `Files` counts). */
export function dragHasFiles(types: readonly string[] | undefined): boolean {
  return !!types && Array.prototype.includes.call(types, 'Files')
}

export const DROP_TITLE = (channel: string): string => `Solte para anexar ao #${channel}`
export const DROP_SUB = `Até ${ATTACH_MAX_PER_SAY} arquivos, ${sizeLabel(ATTACH_MAX_BYTES)} cada. Todos os membros poderão ler.`
/** What a drop on a closed channel says (screen 12: no box, no clip, no dropping). */
export const DROP_CLOSED = 'Canal encerrado: não dá para anexar arquivos.'
/** A dropped thing with no file behind it on disk (a picture dragged from a web page, say). */
export const DROP_NO_FILE = 'Só arquivos do computador podem ser anexados. Salve o conteúdo e solte o arquivo.'
