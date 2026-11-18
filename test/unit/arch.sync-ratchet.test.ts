// Ratchet: the tetherd loop and the Electron main loop must not touch synchronous fs / child_process. Walks the static
// import graph from the entries of each loop and counts uses of identifiers really imported from node:fs / node:child_process.
// The count per file may only go down. Two roots, two baselines:
//   tetherd: src/daemon/main.ts, the extensions' daemon.ts that ext-host loads, src/ptyd/main.ts when present
//            -> arch.sync-ratchet.baseline.json
//   main:    app/main/main.ts and every extensions/<id>/main.ts (the Electron main process)
//            -> arch.sync-ratchet.main.baseline.json
// TETHER_RATCHET_UPDATE=1 rewrites the baselines, lowering only (a missing baseline is created).
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const FS_MODULES = new Set(['node:fs', 'fs'])
const CP_MODULES = new Set(['node:child_process', 'child_process'])
const CP_NAMES = new Set(['execFileSync', 'execSync', 'spawnSync'])
const CODE_EXT = ['.ts', '.mts', '.js', '.mjs', '.cjs']

const isSyncName = (module: string, name: string): boolean =>
  FS_MODULES.has(module) ? name.endsWith('Sync') : CP_MODULES.has(module) && CP_NAMES.has(name)

/** Same-length copy of `src` with comments and string/template text blanked (quotes and `${}` code are kept). */
function mask(src: string): string {
  const out = src.split('')
  const blank = (from: number, to: number): void => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ' }
  const braces: number[] = [] // brace depth at each open template `${`
  let depth = 0
  let i = 0
  const scanTemplate = (): void => { // i is just past the opening backtick, or past the `}` closing a `${}`
    const start = i
    while (i < src.length) {
      const c = src[i]
      if (c === '\\') { i += 2; continue }
      if (c === '`') { blank(start, i); i++; return }
      if (c === '$' && src[i + 1] === '{') { blank(start, i); i += 2; braces.push(depth); depth++; return }
      i++
    }
  }
  while (i < src.length) {
    const c = src[i]!
    const n = src[i + 1]
    if (c === '/' && n === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? src.length : e; blank(i, end); i = end }
    else if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; blank(i, end); i = end }
    else if (c === "'" || c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
      blank(i + 1, j); i = j + 1
    } else if (c === '`') { i++; scanTemplate() }
    else if (c === '{') { depth++; i++ }
    else if (c === '}') {
      depth--; i++
      if (braces.length && braces[braces.length - 1] === depth) { braces.pop(); scanTemplate() }
    } else i++
  }
  return out.join('')
}

interface Binding { module: string; imported: string; local: string; kind: 'named' | 'namespace' }

function parseClause(clause: string, module: string): Binding[] {
  const out: Binding[] = []
  const ns = /\*\s*as\s+([\w$]+)/.exec(clause)
  if (ns) out.push({ module, imported: '*', local: ns[1]!, kind: 'namespace' })
  const named = /\{([^}]*)\}/.exec(clause)
  if (named) {
    for (const part of named[1]!.split(',')) {
      const t = part.trim()
      if (!t || /^type\s/.test(t)) continue
      const m = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(t)
      if (m) out.push({ module, imported: m[1]!, local: m[2] ?? m[1]!, kind: 'named' })
    }
  }
  const def = /^\s*([\w$]+)\s*(?:,|$)/.exec(clause.replace(/\{[^}]*\}|\*\s*as\s+[\w$]+/g, ''))
  if (def) out.push({ module, imported: 'default', local: def[1]!, kind: 'namespace' })
  return out
}

interface Analysis { specs: string[]; uses: Map<string, number> }

function analyze(file: string): Analysis {
  const src = readFileSync(file, 'utf8')
  const code = mask(src)
  const specs: string[] = []
  const bindings: Binding[] = []
  const stmts: Array<[number, number]> = []
  const each = (re: RegExp, fn: (m: RegExpExecArray) => void): void => { for (let m; (m = re.exec(code));) fn(m) }
  // import|export [clause] from 'x'. Type-only statements are erased, so they are not part of the runtime graph.
  each(/\b(import|export)\s+(type\s+)?([^;'"`]*?)\bfrom\s*(['"])/g, (m) => {
    const q = m.index + m[0].length
    const end = code.indexOf(m[4]!, q)
    if (end < 0 || m[2] || /^type\s*\{/.test(m[3]!)) return
    const spec = src.slice(q, end)
    specs.push(spec)
    stmts.push([m.index, end + 1])
    if (m[1] === 'import' && (FS_MODULES.has(spec) || CP_MODULES.has(spec))) bindings.push(...parseClause(m[3]!, spec))
  })
  each(/\bimport\s*(['"])/g, (m) => { const q = m.index + m[0].length; const e = code.indexOf(m[1]!, q); if (e > 0) specs.push(src.slice(q, e)) })
  each(/\bimport\s*\(\s*(['"])/g, (m) => { const q = m.index + m[0].length; const e = code.indexOf(m[1]!, q); if (e > 0) specs.push(src.slice(q, e)) })

  const uses = new Map<string, number>()
  if (bindings.length) {
    // Blank the import statements themselves so only real uses remain.
    const chars = code.split('')
    for (const [a, b] of stmts) for (let k = a; k < b; k++) if (chars[k] !== '\n') chars[k] = ' '
    const body = chars.join('')
    const bump = (id: string): void => { uses.set(id, (uses.get(id) ?? 0) + 1) }
    const esc = (s: string): string => s.replace(/\$/g, '\\$')
    for (const b of bindings) {
      if (b.kind === 'named') {
        if (!isSyncName(b.module, b.imported)) continue
        const re = new RegExp(`(?<![\\w$.])${esc(b.local)}(?![\\w$])`, 'g')
        for (let m; (m = re.exec(body));) {
          // `{ readFileSync: x }` is an object key, not a use.
          const after = body.slice(m.index + m[0].length, m.index + m[0].length + 3)
          if (/^\s*:/.test(after) && /[{,]\s*$/.test(body.slice(Math.max(0, m.index - 40), m.index))) continue
          bump(b.imported)
        }
      } else {
        const re = new RegExp(`(?<![\\w$.])${esc(b.local)}\\s*\\.\\s*([\\w$]+)`, 'g')
        for (let m; (m = re.exec(body));) if (isSyncName(b.module, m[1]!)) bump(`${b.local}.${m[1]}`)
      }
    }
  }
  return { specs, uses }
}

function resolveSpec(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(from), spec)
  const cands = [base, base.replace(/\.js$/, '.ts'), base.replace(/\.mjs$/, '.mts'), ...CODE_EXT.map((e) => base + e), ...CODE_EXT.map((e) => join(base, 'index' + e))]
  for (const c of cands) {
    if (CODE_EXT.some((e) => c.endsWith(e)) && existsSync(c) && statSync(c).isFile()) return c
  }
  return null
}

interface Loop { name: string; baseline: string; entries(): string[] }

function extensionEntries(file: string): string[] {
  const extDir = join(ROOT, 'extensions')
  return readdirSync(extDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(extDir, d.name, file))
}

// Roots: the daemon main plus every extensions/<id>/daemon.ts (ext-host loads them through extensions/index.daemon.ts).
const TETHERD: Loop = {
  name: 'tetherd',
  baseline: join(HERE, 'arch.sync-ratchet.baseline.json'),
  entries: () => [join(ROOT, 'src/daemon/main.ts'), join(ROOT, 'src/ptyd/main.ts'), ...extensionEntries('daemon.ts')].filter((f) => existsSync(f)),
}
// Roots: the Electron main process plus every extensions/<id>/main.ts (index.main.ts loads them in that process).
const MAIN: Loop = {
  name: 'main',
  baseline: join(HERE, 'arch.sync-ratchet.main.baseline.json'),
  entries: () => [join(ROOT, 'app/main/main.ts'), ...extensionEntries('main.ts')].filter((f) => existsSync(f)),
}

const rel = (f: string): string => relative(ROOT, f).split('\\').join('/')
const isVendor = (f: string): boolean => rel(f).split('/').includes('vendor')
// Exempt area: the executor's worker and its operation files (and the table that merges them) are where `*Sync` belongs.
// The coordinator graph must never reach them (see the guard test below); they are neither counted nor traversed.
const isExempt = (f: string): boolean => /^src\/exec\/(ops-[^/]+|worker|table)\.ts$/.test(rel(f))

function measure(loop: Loop): { counts: Record<string, number>; vendor: Record<string, number>; ids: Record<string, string[]>; reached: number; exempt: string[] } {
  const seen = new Set<string>()
  const exempt: string[] = []
  const queue = loop.entries()
  const counts: Record<string, number> = {}
  const vendor: Record<string, number> = {}
  const ids: Record<string, string[]> = {}
  while (queue.length) {
    const f = queue.pop()!
    if (seen.has(f)) continue
    seen.add(f)
    if (isExempt(f)) { exempt.push(rel(f)); continue }
    const a = analyze(f)
    const total = [...a.uses.values()].reduce((x, y) => x + y, 0)
    if (total) {
      ;(isVendor(f) ? vendor : counts)[rel(f)] = total
      ids[rel(f)] = [...a.uses].sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, v]) => `${k} x${v}`)
    }
    if (isVendor(f)) continue // vendored code is known debt: counted aside, never traversed
    for (const s of a.specs) { const r = resolveSpec(f, s); if (r && !seen.has(r)) queue.push(r) }
  }
  const sort = (o: Record<string, number>): Record<string, number> => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)))
  return { counts: sort(counts), vendor: sort(vendor), ids, reached: seen.size, exempt }
}

for (const loop of [TETHERD, MAIN]) {
  test(`the ${loop.name} import graph does not grow its synchronous fs / child_process use`, () => {
    const { counts, vendor, ids, reached } = measure(loop)
    assert.ok(reached > 20, `import graph looks too small (${reached} files): entries or resolution broke`)
    const update = process.env.TETHER_RATCHET_UPDATE === '1'
    const hasBaseline = existsSync(loop.baseline)
    const base: { files: Record<string, number>; vendor?: Record<string, number> } = hasBaseline
      ? JSON.parse(readFileSync(loop.baseline, 'utf8'))
      : { files: {} }
    if (!hasBaseline && !update) assert.fail(`missing ${rel(loop.baseline)}: create it with TETHER_RATCHET_UPDATE=1`)

    const grew: string[] = []
    const shrank: string[] = []
    if (hasBaseline) {
      for (const [f, n] of Object.entries(counts)) {
        const b = base.files[f] ?? 0
        if (n > b) grew.push(`${f}: ${n} sync use(s), baseline ${b} [${ids[f]!.join(', ')}]`)
        else if (n < b) shrank.push(`${f}: ${n}, baseline ${b}`)
      }
      for (const [f, b] of Object.entries(base.files)) if (!(f in counts)) shrank.push(`${f}: 0 (or no longer reached), baseline ${b}`)
    }

    if (grew.length) {
      assert.fail(`synchronous fs/child_process use grew in the ${loop.name} loop (the baseline only goes down; use async APIs or move the work off the loop):\n  ${grew.join('\n  ')}`)
    }
    if (update) {
      writeFileSync(loop.baseline, JSON.stringify({ files: counts, vendor }, null, 2) + '\n')
      return
    }
    if (shrank.length) {
      assert.fail(`sync use went down: lower the baseline with TETHER_RATCHET_UPDATE=1 (the ratchet only moves down):\n  ${shrank.join('\n  ')}`)
    }
  })

  test(`the ${loop.name} graph never imports the executor operations`, () => {
    const { exempt, reached } = measure(loop)
    assert.ok(reached > 20, `import graph looks too small (${reached} files)`)
    assert.deepEqual(exempt, [], `the loop must reach src/exec/ops-*.ts, worker.ts and table.ts only through a worker (or a computed path), never by import: ${exempt.join(', ')}`)
  })
}

test('the exempt pattern matches the executor operation files', () => {
  for (const name of ['ops-fs.ts', 'worker.ts', 'table.ts']) assert.ok(isExempt(join(ROOT, 'src/exec', name)), name)
  assert.ok(!isExempt(join(ROOT, 'src/exec/executor.ts')))
})
