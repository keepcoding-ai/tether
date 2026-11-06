// The note extension's dialogs (moved from app/renderer/situations.ts, F9 slice 1), one declarative definition each
// (app/shared/dialog.ts), written from what each has to communicate.
import type { DialogSpec } from '../../app/shared/dialog.ts'
import { folderName } from '../../app/renderer/situations.ts'

/**
 * The first note of a repository whose `.gitignore` does not keep `.tether/` out. What it communicates: "your
 * notes are about to live inside this repository; git will see them unless the folder is ignored."
 */
export function noteGitignoreSituation(repoRoot: string): DialogSpec {
  return {
    situation: 'note-gitignore',
    tone: 'info',
    icon: 'note-pencil',
    title: 'Manter as notas fora do git?',
    message: 'As notas deste repositório ficam em .tether/notes/. Sem uma linha no .gitignore, o git passa a listar essa pasta como mudança.',
    context: { icon: 'folder', name: folderName(repoRoot), lines: [repoRoot] },
    choices: [
      { id: 'add', icon: 'check', label: 'Adicionar .tether/ ao .gitignore', consequence: 'Uma linha ".tether/" entra no fim do .gitignore do repositório (criado se não existir).', tone: 'safe' },
      { id: 'skip', icon: 'minus-circle', label: 'Deixar como está', consequence: 'Nada muda no repositório; a pergunta não volta para este repositório.', tone: 'neutral' },
    ],
    escChoice: 'skip',
  }
}

/**
 * The note's file changed on disk while the editor holds edits not yet written. What it communicates: "two
 * versions exist; keeping one loses the other."
 */
export function noteConflictSituation(path: string): DialogSpec {
  return {
    situation: 'note-conflict',
    tone: 'warn',
    icon: 'warning',
    title: 'Esta nota mudou fora do tether',
    message: 'O arquivo foi alterado por outro programa enquanto você editava aqui. As duas versões são diferentes.',
    context: { icon: 'note-pencil', name: folderName(path), lines: [path] },
    choices: [
      { id: 'keep', icon: 'pencil-simple', label: 'Manter o que está no editor', consequence: 'O texto daqui é gravado por cima do arquivo; a versão de fora se perde.', tone: 'safe' },
      { id: 'reload', icon: 'arrow-clockwise', label: 'Carregar a versão do disco', consequence: 'O editor passa a mostrar o arquivo como está; o que você digitou e não foi gravado se perde.', tone: 'destructive' },
    ],
  }
}
