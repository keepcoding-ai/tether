// The search extension: "Pesquisar nos arquivos", a port of VS Code's Search view for the left side bar, over the window's
// projects. The pad id, the command ids and the replace preview's pane type are in people's layout.json and
// keybindings.json and never change.
import type { ExtensionManifest } from '../types.ts'
import { REPLACE_PREVIEW_LAYOUT } from './layouts.ts'

const SEARCH = 'Pesquisar'

export const manifest: ExtensionManifest = {
  id: 'search',
  version: '1.0.0',
  displayName: 'Pesquisar',
  description: 'Pesquisar e substituir texto nos arquivos dos projetos da janela, na barra lateral esquerda.',
  hosts: ['renderer', 'main'],
  optional: true,
  contributes: {
    paneTypes: [REPLACE_PREVIEW_LAYOUT],
    pads: [
      { id: 'search.view', title: 'Pesquisar', icon: 'magnifying-glass', defaultSide: 'left', scope: 'global', absorbsHeader: true, order: 20 },
    ],
    settings: {
      searchOnType: { type: 'boolean', default: true, title: 'Pesquisar enquanto digita', description: 'Roda a pesquisa a cada pausa na digitação, sem precisar apertar Enter.' },
      searchOnTypeDebouncePeriod: { type: 'integer', default: 300, min: 0, max: 5000, title: 'Atraso da pesquisa ao digitar (ms)', description: 'Quanto esperar depois da última tecla antes de pesquisar.' },
      smartCase: { type: 'boolean', default: false, title: 'Ignorar maiúsculas quando o termo é todo minúsculo', description: 'Se o termo está todo em minúsculas, a pesquisa não diferencia maiúsculas de minúsculas; se tem alguma maiúscula, diferencia.' },
      useIgnoreFiles: { type: 'boolean', default: true, title: 'Respeitar .gitignore e .ignore', description: 'Deixa de fora da pesquisa os arquivos ignorados pelos arquivos .gitignore e .ignore.' },
      useGlobalIgnoreFiles: { type: 'boolean', default: false, title: 'Respeitar o ignore global do git', description: 'Também deixa de fora o que o arquivo de ignore global do git ignora.' },
      useParentIgnoreFiles: { type: 'boolean', default: false, title: 'Respeitar .gitignore das pastas acima', description: 'Também considera os arquivos .gitignore e .ignore das pastas acima do projeto.' },
      followSymlinks: { type: 'boolean', default: false, title: 'Seguir links simbólicos', description: 'Entra em links simbólicos e junctions ao pesquisar.' },
      exclude: { type: 'string', default: '**/node_modules, **/bower_components, **/*.code-search', title: 'Excluir da pesquisa', description: 'Globs separados por vírgula que a pesquisa deixa de fora, além das pastas de controle de versão.' },
      collapseResults: { type: 'string', enum: ['alwaysExpand', 'auto', 'alwaysCollapse'], enumLabels: ['Sempre expandir', 'Automático (recolhe arquivo com mais de 10 resultados)', 'Sempre recolher'], default: 'alwaysExpand', title: 'Recolher resultados', description: 'Se os arquivos da lista de resultados aparecem abertos ou fechados.' },
      sortOrder: {
        type: 'string', enum: ['default', 'fileNames', 'type', 'modified', 'countDescending', 'countAscending'],
        enumLabels: ['Padrão (por pasta e nome)', 'Nome do arquivo', 'Tipo de arquivo', 'Modificado (trata como padrão)', 'Mais resultados primeiro', 'Menos resultados primeiro'],
        default: 'default', title: 'Ordem dos resultados', description: 'Como os arquivos e as pastas da lista de resultados são ordenados.',
      },
      defaultViewMode: { type: 'string', enum: ['list', 'tree'], enumLabels: ['Lista', 'Árvore'], default: 'list', title: 'Modo de exibição dos resultados', description: 'Mostrar os arquivos achados em lista ou agrupados por pasta, em árvore.' },
      showLineNumbers: { type: 'boolean', default: false, title: 'Mostrar números de linha', description: 'Mostra o número da linha ao lado de cada resultado.' },
      useReplacePreview: { type: 'boolean', default: true, title: 'Prévia ao substituir', description: 'Mostra a diferença no editor ao substituir uma ocorrência.' },
      maxResults: { type: 'integer', default: 20000, min: 1, max: 200000, title: 'Máximo de resultados', description: 'A pesquisa para ao chegar a esse número de ocorrências.' },
    },
    commands: [
      { command: 'search.focus', title: 'Pesquisar nos arquivos', category: SEARCH, icon: 'magnifying-glass' },
      { command: 'search.refresh', title: 'Atualizar pesquisa', category: SEARCH, icon: 'arrows-clockwise' },
      { command: 'search.clear', title: 'Limpar resultados da pesquisa', category: SEARCH, icon: 'broom' },
      { command: 'search.cancel', title: 'Cancelar pesquisa', category: SEARCH, icon: 'stop' },
      { command: 'search.collapse-all', title: 'Recolher todos os resultados', category: SEARCH, icon: 'arrows-in-line-vertical' },
      { command: 'search.expand-all', title: 'Expandir todos os resultados', category: SEARCH, icon: 'arrows-out-line-vertical' },
      { command: 'search.view-as-tree', title: 'Ver resultados como árvore', category: SEARCH, icon: 'tree-view' },
      { command: 'search.view-as-list', title: 'Ver resultados como lista', category: SEARCH, icon: 'list' },
      { command: 'search.toggle-details', title: 'Alternar detalhes da pesquisa', category: SEARCH, icon: 'dots-three' },
      { command: 'search.next-match', title: 'Ir para o próximo resultado da pesquisa', category: SEARCH, icon: 'arrow-down' },
      { command: 'search.previous-match', title: 'Ir para o resultado anterior da pesquisa', category: SEARCH, icon: 'arrow-up' },
      { command: 'search.clear-history', title: 'Limpar histórico de pesquisa', category: SEARCH, icon: 'broom' },
      // No default key: Ctrl+Shift+H belongs to another command of the app.
      { command: 'search.toggle-replace', title: 'Substituir nos arquivos', category: SEARCH, icon: 'swap' },
      { command: 'search.replace-all', title: 'Substituir tudo', category: SEARCH, icon: 'swap' },
      { command: 'search.replace', title: 'Substituir', category: SEARCH, icon: 'swap' },
      { command: 'search.open-editor', title: 'Abrir novo editor de pesquisa', category: SEARCH, icon: 'file-magnifying-glass' },
      { command: 'search.editor.rerun', title: 'Pesquisar de novo no editor de pesquisa', category: SEARCH, icon: 'arrows-clockwise' },
      { command: 'search.editor.go-to-file', title: 'Ir ao arquivo do resultado no editor de pesquisa', category: SEARCH, icon: 'arrow-square-out' },
    ],
    keybindings: [
      { key: 'ctrl+shift+f', command: 'search.focus' },
      // Not in a terminal: function keys belong to the programs running there (mc, htop, editors).
      { key: 'f4', command: 'search.next-match', where: ['window', 'note'] },
      { key: 'shift+f4', command: 'search.previous-match', where: ['window', 'note'] },
      // In a note only: they act on a `.code-search` document and do nothing in any other note.
      { key: 'ctrl+shift+r', command: 'search.editor.rerun', where: ['note'] },
      { key: 'f12', command: 'search.editor.go-to-file', where: ['note'] },
    ],
  },
}
