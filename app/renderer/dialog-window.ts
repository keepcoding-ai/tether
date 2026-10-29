// Entry of the standalone dialog window (app/renderer/dialog.html): the same dialog component, in a small
// frameless window, for the situations that happen before the main window exists (today: the launch
// that finds the previous instance still closing). Main names the situation; the answer goes back by IPC.
import type { DialogSpec } from '../shared/dialog.ts'
import { askDialog } from './dialog.ts'
import { STANDALONE_SITUATIONS } from './situations.ts'

async function main(): Promise<void> {
  const theme = await window.tether.getTheme()
  document.documentElement.dataset.theme = theme.scheme
  window.tether.onTheme(state => { document.documentElement.dataset.theme = state.scheme })
  const name = await window.tether.standaloneDialog()
  const build = name ? STANDALONE_SITUATIONS[name] : undefined
  const spec: DialogSpec = build ? build() : {
    situation: 'unknown', tone: 'warn', icon: 'warning', title: 'Situação desconhecida',
    message: `O app pediu um diálogo que não existe (${name ?? 'nenhum'}).`,
    choices: [{ id: 'close', icon: 'x', label: 'Fechar', consequence: 'Fecha esta janela.', tone: 'neutral' }],
  }
  const pending = askDialog(spec, document.body)
  const dlg = document.querySelector<HTMLDialogElement>('dialog.ask')
  if (dlg) window.tether.standaloneSize(Math.ceil(dlg.getBoundingClientRect().height))
  window.tether.answerStandalone(await pending)
}

void main()
