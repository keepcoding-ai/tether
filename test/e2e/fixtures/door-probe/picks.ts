// Subject: the list picker (`ui.pick`, slice R4) and a command that takes an argument. The hooks are in
// `window.__tether.ext['door-probe']`: `pickStart(kind)` opens a picker without waiting (the test drives the keys), `pickResults()`
// lists how each one resolved, `pickBuilt()` lists the first choices the second step was built from, and `runJoin(arg?)` runs the
// command `door-probe.join` the way a caller does: with an argument it takes it, without one it opens the picker itself.
import type { PickItem, TetherUi } from '../../../../app/renderer/ext-api.ts'
import type { IDisposable } from '../../../../app/shared/vscode-lifecycle.ts'

const channels: PickItem<string>[] = [
  { value: 'geral', label: 'Canal geral', icon: 'plugs-connected', detail: '3 agentes' },
  { value: 'obras', label: 'Obras da casa', icon: 'tag', hue: 160, detail: '1 agente' },
  { value: 'cozinha', label: 'Cozinha', icon: 'sun', hue: 330 },
]
const agents: PickItem<string>[] = [
  { value: 'claude-1', label: 'Agente Um', icon: 'sparkle', hue: 200 },
  { value: 'claude-2', label: 'Agente Dois', icon: 'sparkle', hue: 300, detail: 'em outra mesa' },
]

export function picks(ui: TetherUi): IDisposable[] {
  const results: unknown[] = []
  const built: string[] = []
  const record = (p: Promise<unknown>): void => { void p.then(r => { results.push(r ?? null) }) }
  ui.test.expose('pickResults', () => results)
  ui.test.expose('pickBuilt', () => built)
  ui.test.expose('pickStart', (kind: 'list' | 'steps' | 'slow' | 'failing') => {
    if (kind === 'list') {
      record(ui.pick.list({ title: 'Juntar ao canal', placeholder: 'Procurar canal', featured: { value: 'mesa', label: 'Canal da mesa', icon: 'plugs-connected', hue: 180, detail: 'esta mesa' }, items: channels }))
    } else if (kind === 'steps') {
      record(ui.pick.steps(
        { title: 'Dar a guia a um agente', placeholder: 'Procurar agente', items: agents },
        a => { built.push(a); return { title: `Canal de ${a}`, featured: { value: 'mesa', label: 'Canal da mesa' }, items: channels } },
      ))
    } else if (kind === 'slow') {
      record(ui.pick.list({ title: 'Lista lenta', items: () => new Promise(resolve => setTimeout(() => resolve(channels), 600)) }))
    } else {
      record(ui.pick.list({ title: 'Lista que falha', items: () => Promise.reject(new Error('sonda: a lista falha')) }))
    }
  })
  // pick.many: how each one resolved (the values, or null).
  const manyResults: unknown[] = []
  ui.test.expose('pickManyResults', () => manyResults)
  ui.test.expose('pickManyStart', () => {
    void ui.pick.many({
      title: 'Juntar a #canal',
      placeholder: 'Buscar agente',
      confirmLabel: 'Juntar',
      confirmHint: 'junta',
      items: [
        { value: 'um', label: 'claude · conferente', letter: 'C', hue: 200, group: 'Nesta mesa · obra' },
        { value: 'dois', label: 'soul · bancada', letter: 'S', hue: 300, group: 'Nesta mesa · obra' },
        { value: 'tres', label: 'codex · conferência', letter: 'X', hue: 40, group: 'Mesa · pesquisa', detail: 'parado' },
      ],
    }).then(r => { manyResults.push(r ?? null) })
  })
  ui.test.expose('runJoin', (arg?: unknown) => { record(ui.commands.run('door-probe.join', arg).then(r => `command:${r}`)) })
  return [
    ui.commands.register({
      id: 'door-probe.join',
      title: 'Juntar ao canal (sonda)',
      run: async (_source, arg) => {
        if (arg !== undefined) { results.push(`direct:${String(arg)}`); return }
        const chosen = await ui.pick.list({ title: 'Juntar ao canal', items: channels })
        results.push(`picked:${chosen ?? 'nothing'}`)
      },
    }),
  ]
}
