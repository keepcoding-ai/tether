// The extension model's static discovery (F9 §2.5): every extensions/<id>/ entry file (renderer.ts, main.ts,
// daemon.ts) must be listed in its host's committed index, the manifest's `hosts` must match the files, and the
// import rule holds (an extension never imports app/renderer/main.ts; the core imports extensions only through the
// indexes). Also the renderer host's activation (app/renderer/ext-host.ts): order by `requires`, a failure is isolated.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { activateExtensions, activationOrder } from '../../app/renderer/ext-host.ts'
import { DisposableStore, toDisposable } from '../../app/shared/vscode-lifecycle.ts'
import { HOSTS, type ExtensionEntry, type Host } from '../../extensions/types.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const extDir = join(root, 'extensions')

export interface ExtFolder { id: string; files: string[]; hosts?: readonly Host[] }

/** What is wrong with the indexes, given the folders and each host's index text. */
export function auditIndexes(folders: ExtFolder[], indexText: Record<Host, string>): string[] {
  const problems: string[] = []
  for (const f of folders) {
    if (!f.files.includes('manifest.ts')) problems.push(`${f.id}: sem manifest.ts`)
    for (const host of HOSTS) {
      const has = f.files.includes(`${host}.ts`)
      if (has && !indexText[host].includes(`'./${f.id}/${host}.ts'`)) problems.push(`${f.id}: ${host}.ts fora de index.${host}.ts`)
      if (!has && indexText[host].includes(`'./${f.id}/${host}.ts'`)) problems.push(`${f.id}: index.${host}.ts aponta para ${host}.ts inexistente`)
      if (f.hosts && has !== f.hosts.includes(host)) problems.push(`${f.id}: manifest.hosts e ${host}.ts não batem`)
    }
  }
  return problems
}

function realFolders(): ExtFolder[] {
  return readdirSync(extDir).filter(n => statSync(join(extDir, n)).isDirectory()).map(id => {
    const files = readdirSync(join(extDir, id))
    const manifest = files.includes('manifest.ts') ? readFileSync(join(extDir, id, 'manifest.ts'), 'utf8') : ''
    const m = /hosts:\s*\[([^\]]*)\]/.exec(manifest)
    const hosts = m ? (m[1]!.match(/'(renderer|main|daemon)'/g) ?? []).map(s => s.slice(1, -1) as Host) : undefined
    return { id, files, ...(hosts ? { hosts } : {}) }
  })
}

const indexes = (): Record<Host, string> => ({
  renderer: readFileSync(join(extDir, 'index.renderer.ts'), 'utf8'),
  main: readFileSync(join(extDir, 'index.main.ts'), 'utf8'),
  daemon: readFileSync(join(extDir, 'index.daemon.ts'), 'utf8'),
})

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(f => f.endsWith('.ts')).map(f => join(dir, f))
}

describe('extension indexes', () => {
  test('every extensions/<id>/ entry is in its host index and matches its manifest', () => {
    assert.deepEqual(auditIndexes(realFolders(), indexes()), [])
  })

  test('the audit catches a missing entry, a dangling one and a hosts mismatch', () => {
    const empty = { renderer: '', main: '', daemon: '' }
    assert.deepEqual(auditIndexes([{ id: 'note', files: ['manifest.ts', 'renderer.ts'], hosts: ['renderer'] }], empty), ['note: renderer.ts fora de index.renderer.ts'])
    assert.deepEqual(auditIndexes([{ id: 'note', files: ['manifest.ts', 'renderer.ts'], hosts: ['renderer'] }], { ...empty, renderer: `import * as x from './note/renderer.ts'` }), [])
    assert.deepEqual(auditIndexes([{ id: 'x', files: ['manifest.ts'], hosts: [] }], { ...empty, main: `'./x/main.ts'` }), ['x: index.main.ts aponta para main.ts inexistente'])
    assert.deepEqual(auditIndexes([{ id: 'y', files: ['manifest.ts', 'daemon.ts'], hosts: [] }], { ...empty, daemon: `'./y/daemon.ts'` }), ['y: manifest.hosts e daemon.ts não batem'])
    assert.deepEqual(auditIndexes([{ id: 'z', files: [] }], empty), ['z: sem manifest.ts'])
  })

  test('no extension imports the renderer entry; the core imports extensions only through the indexes', () => {
    const importsOf = (file: string): string[] => [...readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)].map(m => m[1]!)
    for (const file of tsFiles(extDir)) {
      for (const spec of importsOf(file)) assert.ok(!/app\/renderer\/main\.ts$/.test(spec), `${relative(root, file)} importa ${spec}`)
    }
    for (const dir of ['app', 'src']) {
      for (const file of tsFiles(join(root, dir)).filter(f => !f.includes('node_modules') && !f.includes(`${join('app', 'dist')}`))) {
        for (const spec of importsOf(file)) {
          if (!spec.includes('extensions/')) continue
          assert.match(spec, /extensions\/(index\.(renderer|main|daemon)|types)\.ts$/, `${relative(root, file)} importa ${spec}`)
        }
      }
    }
  })
})

describe('renderer extension host', () => {
  const entry = (id: string, requires: string[] = [], activate: ExtensionEntry<string>['activate'] = () => []): ExtensionEntry<string> =>
    ({ manifest: { id, version: '0.0.1', displayName: id, hosts: ['renderer'], requires }, activate })

  test('activation follows `requires`, stable by index; unknown or circular requirements fail', () => {
    const { ordered, failed } = activationOrder([entry('b', ['a']), entry('a'), entry('c', ['zz']), entry('d', ['e']), entry('e', ['d'])])
    assert.deepEqual(ordered.map(e => e.manifest.id), ['a', 'b'])
    assert.deepEqual(failed.map(f => f.id).sort(), ['c', 'd', 'e'])
  })

  test('a throwing activate is isolated and its disposables released; the rest activate; the store disposes them', () => {
    const log: string[] = []
    const store = new DisposableStore()
    const orig = console.error
    console.error = () => {}
    try {
      const result = activateExtensions([
        entry('ok', [], api => [toDisposable(() => log.push(`off ${api}`))]),
        entry('bad', [], () => { throw new Error('quebrou') }),
        { ...entry('dep', ['ok'], () => []), deactivate: () => log.push('deactivate dep') },
      ], id => `api:${id}`, store)
      assert.deepEqual(result.active, ['ok', 'dep'])
      assert.deepEqual(result.failed, [{ id: 'bad', error: 'quebrou' }])
    } finally { console.error = orig }
    store.dispose()
    assert.deepEqual(log.sort(), ['deactivate dep', 'off api:ok'])
  })
})
