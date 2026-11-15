// The search pad's replace rules (replace.ts, view.ts): the guard over an open editor's text before it is edited, the new
// text in the editor's line ending, which files go to the editor and which to the disk, what leaves the results model
// once the files are written, and the texts of the confirmation and of the summary. No DOM, no Monaco: structural types.
// Origin (behaviour): https://github.com/microsoft/vscode, commit 9cc2376778e1
//   src/vs/workbench/contrib/search/browser/searchView.ts       (replaceAll, buildReplaceAllConfirmationMessage,
//                                                                buildAfterReplaceAllMessage)
//   src/vs/workbench/contrib/search/browser/replaceService.ts   (replace: the edits of a file applied as one undo step)
// Not in VS Code: every range is checked against the text the search found before anything is edited (all or nothing per
// file), so a file that changed after the search is skipped and named, never half replaced.
import type { DialogSpec } from '../../../app/shared/dialog.ts'
import type { MessageLine } from './view-rules.ts'

export interface ReplaceRange { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }
export interface ReplaceEdit { range: ReplaceRange; expected: string; text: string }
export interface ReplaceFile { path: string; edits: ReplaceEdit[] }

/** How replacing in one file ended (the same shape for the editor and the disk). */
export type ReplaceOutcome =
  | { path: string; status: 'replaced'; count: number }
  | { path: string; status: 'changed' }
  | { path: string; status: 'missing' }
  | { path: string; status: 'refused' }
  | { path: string; status: 'failed'; message: string }

/** The part of Monaco's ITextModel the guard reads; lines and columns are one-based. */
export interface GuardModel {
  getLineCount(): number
  getLineMaxColumn(lineNumber: number): number
  getValueInRange(range: ReplaceRange): string
  getEOL(): string
}

const lf = (s: string): string => s.replaceAll('\r\n', '\n')

/** The found text and the text there now are the same, up to "\r\n" against "\n". */
export function sameText(found: string, expected: string): boolean {
  return found === expected || lf(found) === lf(expected)
}

/** The replacement in the model's line ending. */
export function toEol(text: string, eol: string): string {
  return text.replace(/\r?\n/g, eol)
}

const before = (a: ReplaceRange, b: ReplaceRange): number =>
  a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn || a.endLineNumber - b.endLineNumber || a.endColumn - b.endColumn

/** Two ranges share text (touching ends do not). */
export function overlaps(ranges: readonly ReplaceRange[]): boolean {
  const sorted = [...ranges].sort(before)
  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i - 1]
    const c = sorted[i]
    if (!p || !c) continue
    if (c.startLineNumber < p.endLineNumber || (c.startLineNumber === p.endLineNumber && c.startColumn < p.endColumn)) return true
  }
  return false
}

function inside(model: GuardModel, line: number, column: number): boolean {
  return Number.isInteger(line) && Number.isInteger(column) && line >= 1 && line <= model.getLineCount() &&
    column >= 1 && column <= model.getLineMaxColumn(line)
}

/**
 * The edits to make in an open editor's model, the new texts in its line ending; undefined when any range is outside the
 * text, the ranges overlap or a range no longer holds the found text: then nothing is edited.
 */
export function guardModel(model: GuardModel, edits: readonly ReplaceEdit[]): { range: ReplaceRange; text: string }[] | undefined {
  if (edits.length === 0 || overlaps(edits.map(e => e.range))) return undefined
  const eol = model.getEOL()
  const out: { range: ReplaceRange; text: string }[] = []
  for (const e of edits) {
    const r = e.range
    const reversed = r.endLineNumber < r.startLineNumber || (r.endLineNumber === r.startLineNumber && r.endColumn < r.startColumn)
    if (reversed || !inside(model, r.startLineNumber, r.startColumn) || !inside(model, r.endLineNumber, r.endColumn)) return undefined
    if (!sameText(model.getValueInRange(r), e.expected)) return undefined
    out.push({ range: r, text: toEol(e.text, eol) })
  }
  return out
}

/** The files open in an editor (replaced in the editor's text) and the rest (replaced on disk), in the order given. */
export function splitByEditor<F extends { path: string }>(files: readonly F[], isOpen: (path: string) => boolean): { open: F[]; disk: F[] } {
  const open: F[] = []
  const disk: F[] = []
  for (const f of files) (isOpen(f.path) ? open : disk).push(f)
  return { open, disk }
}

/** The outcomes in the order of `files`; a file with no outcome (main dropped it) is reported as failed. */
export function inOrder(files: readonly { path: string }[], outcomes: readonly ReplaceOutcome[]): ReplaceOutcome[] {
  const byPath = new Map(outcomes.map(o => [o.path, o]))
  return files.map(f => byPath.get(f.path) ?? { path: f.path, status: 'failed', message: 'O arquivo não foi processado.' })
}

/** What leaves the results model: the targets (a match, or files) whose file was replaced; skipped files stay. */
export function toRemove<T>(targets: readonly { path: string; element: T }[], outcomes: readonly ReplaceOutcome[]): T[] {
  const replaced = new Set(outcomes.filter(o => o.status === 'replaced').map(o => o.path))
  return targets.filter(t => replaced.has(t.path)).map(t => t.element)
}

const n = (v: number): string => v.toLocaleString('pt-BR')
const plural = (v: number, one: string, many: string): string => (v === 1 ? one : many)

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** Names shown in a summary line before "e mais X". */
export const NAMES_SHOWN = 5

function names(paths: readonly string[]): string {
  const shown = paths.slice(0, NAMES_SHOWN).map(baseName).join(', ')
  const rest = paths.length - NAMES_SHOWN
  return rest > 0 ? `${shown} e mais ${n(rest)}` : shown
}

/** "N ocorrência(s) substituída(s) em M arquivo(s)." */
export function replacedLine(occurrences: number, files: number): string {
  return `${n(occurrences)} ${plural(occurrences, 'ocorrência substituída', 'ocorrências substituídas')} em ${n(files)} ${plural(files, 'arquivo', 'arquivos')}.`
}

export const NOTHING_REPLACED = 'Nenhuma ocorrência foi substituída.'

/** The message line after a replace: what was replaced, then one line per reason a file was skipped. */
export function replaceSummary(outcomes: readonly ReplaceOutcome[]): MessageLine[] {
  let occurrences = 0
  let files = 0
  const changed: string[] = []
  const missing: string[] = []
  const refused: string[] = []
  const failed: { path: string; message: string }[] = []
  for (const o of outcomes) {
    if (o.status === 'replaced') { occurrences += o.count; files++ }
    else if (o.status === 'changed') changed.push(o.path)
    else if (o.status === 'missing') missing.push(o.path)
    else if (o.status === 'refused') refused.push(o.path)
    else failed.push(o)
  }
  const lines: MessageLine[] = [{ text: files > 0 ? replacedLine(occurrences, files) : NOTHING_REPLACED, tone: 'info' }]
  if (changed.length > 0) {
    const k = changed.length
    lines.push({
      text: `${n(k)} ${plural(k, 'arquivo mudou', 'arquivos mudaram')} depois da pesquisa e ${plural(k, 'foi pulado', 'foram pulados')}: ${names(changed)}. Pesquise de novo para atualizar.`,
      tone: 'warning',
    })
  }
  if (missing.length > 0) lines.push({ text: `${plural(missing.length, 'Não encontrado', 'Não encontrados')}: ${names(missing)}.`, tone: 'warning' })
  if (refused.length > 0) lines.push({ text: `Fora das pastas pesquisadas, não ${plural(refused.length, 'alterado', 'alterados')}: ${names(refused)}.`, tone: 'warning' })
  for (const f of failed.slice(0, NAMES_SHOWN)) lines.push({ text: `Não foi possível gravar ${baseName(f.path)}: ${f.message}`, tone: 'warning' })
  const rest = failed.length - NAMES_SHOWN
  if (rest > 0) lines.push({ text: `Mais ${n(rest)} ${plural(rest, 'arquivo não pôde ser gravado', 'arquivos não puderam ser gravados')}.`, tone: 'warning' })
  return lines
}

/** A single match replaced as asked: the pad keeps its usual count line (VS Code shows no summary for it). */
export function isQuietSingle(target: 'match' | 'many', outcomes: readonly ReplaceOutcome[]): boolean {
  return target === 'match' && outcomes.length === 1 && outcomes[0]?.status === 'replaced'
}

export const REPLACE_ALL_SITUATION = 'search.replace-all'
export const UNDO_NOTE = 'Arquivos abertos no editor podem ser desfeitos com Ctrl+Z; os demais são gravados em disco.'

/** The replace value as shown in the confirmation: at most 10 lines (buildReplaceAllConfirmationMessage). */
function shownValue(value: string): string {
  const lines = value.split('\n')
  return lines.length > 10 ? `${lines.slice(0, 10).join('\n')}\n…` : value
}

export function replaceAllTitle(occurrences: number, files: number): string {
  return `Substituir ${n(occurrences)} ${plural(occurrences, 'ocorrência', 'ocorrências')} em ${n(files)} ${plural(files, 'arquivo', 'arquivos')}?`
}

/** "Substituir tudo" asks first, with the counts and the new text. */
export function replaceAllConfirmation(occurrences: number, files: number, replaceValue: string): DialogSpec {
  const what = replaceValue === ''
    ? 'O texto encontrado será apagado.'
    : `${plural(occurrences, 'A ocorrência será trocada', 'Cada ocorrência será trocada')} por '${shownValue(replaceValue)}'.`
  return {
    situation: REPLACE_ALL_SITUATION,
    tone: 'warn',
    icon: 'swap',
    title: replaceAllTitle(occurrences, files),
    message: `${what} ${UNDO_NOTE}`,
    choices: [
      { id: 'cancel', icon: 'x', label: 'Cancelar', consequence: 'Nada muda.', tone: 'safe' },
      { id: 'replace', icon: 'swap', label: 'Substituir', consequence: 'Troca o texto nos arquivos; o que mudou depois da pesquisa é pulado.', tone: 'destructive' },
    ],
    defaultChoice: 'cancel',
    escChoice: 'cancel',
  }
}
