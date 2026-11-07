// `tether faults` (src/cli/faults.ts): every verb against a temp registry, the id rules (exact short id before prefix,
// ambiguous = exit 2 with the candidates, unknown = exit 1), the fixed --json fields, authors, tag normalization and the
// states a repeated verb finds. A last test runs the real bin to prove the wiring and the exit codes.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, describe, test } from 'node:test'
import { faultsDir, flush, readState, record, statePath, writeState, type FaultInput } from '../../src/core/faults.ts'
import { createSlot } from '../../src/core/store.ts'
import { authorOf, cmdFaults, SHOW_CAP } from '../../src/cli/faults.ts'
import { UsageError } from '../../src/cli/args.ts'

const BIN = resolve(import.meta.dirname, '../../bin/tether.mjs')
const dirs: string[] = []
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'tether-clifaults-')); dirs.push(d); return d }
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const input = (message: string, over: Partial<FaultInput> = {}): FaultInput => ({ proc: 'main', kind: 'uncaught', message, stack: `Error: ${message}\n    at fn (C:\\x\\dist\\m.cjs:1:2)`, ...over })
const T0 = Date.parse('2026-11-07T12:00:00Z')
function seed(dir: string, message: string, over: Partial<FaultInput> = {}, at = T0, version = '0.9.3') {
  const r = record(input(message, over), { dir, now: () => at, version, commit: 'abc1234def', mapper: null })!
  flush(dir) // the state write is debounced; the CLI and the assertions read it right away
  return r
}

async function run(dir: string, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '', err = ''
  let code: number
  try { code = await cmdFaults(argv, { out: t => { out += t }, err: t => { err += t }, dir, env: { ...process.env, TETHER_SLOT_ID: '' }, now: () => T0 + 120_000 }) } catch (e) {
    if (!(e instanceof UsageError)) throw e
    code = 2
    err += e.message
  }
  return { code, out, err }
}
const json = <T>(s: string): T => JSON.parse(s) as T

describe('tether faults list', () => {
  test('empty registry says so; no verb means list', async () => {
    const dir = tmp()
    const r = await run(dir)
    assert.equal(r.code, 0)
    assert.match(r.out, /nenhuma falha registrada/)
  })

  test('the table has the Portuguese labels, tags and the returned mark; default hides done and ignored', async () => {
    const dir = tmp()
    const a = seed(dir, 'Cannot find module ./impl/format', { kind: 'load' })
    const b = seed(dir, 'TypeError: reading cols', { proc: 'renderer' }, T0 - 3_600_000)
    const c = seed(dir, 'old noise', {}, T0 - 7_200_000)
    await run(dir, 'tag', a.shortId, '#Build')
    await run(dir, 'ignore', c.shortId)
    await run(dir, 'done', b.shortId, '--fix', 'def4567890')
    seed(dir, 'TypeError: reading cols', { proc: 'renderer' }, T0 + 1000, '0.9.4')
    const r = await run(dir)
    assert.equal(r.code, 0)
    assert.match(r.out, /ID\s+ESTADO\s+×\s+ÚLTIMA\s+PROCESSO\s+TIPO\s+MENSAGEM/)
    assert.match(r.out, new RegExp(`${a.shortId}\\s+aberta\\s+1\\s+há 2 min\\s+main\\s+ao abrir\\s+Cannot find module ./impl/format\\s+#build`))
    assert.match(r.out, /renderer\s+erro não tratado\s+TypeError: reading cols\s+\(voltou na v0\.9\.4\)/)
    assert.doesNotMatch(r.out, /old noise/)
    assert.match(r.out, /2 falhas \(2 abertas\) · tether faults show <id>/)
    const ign = await run(dir, '--status', 'ignorada')
    assert.match(ign.out, /old noise/)
    assert.doesNotMatch(ign.out, /Cannot find/)
    const all = await run(dir, 'list', '--status', 'all')
    assert.match(all.out, /old noise/)
    assert.match(all.out, /Cannot find/)
    const none = await run(dir, '--status', 'investigating')
    assert.match(none.out, /nenhuma falha com esse filtro \(3 no total/)
  })

  test('status accepts the Portuguese word and the English id; an invalid one is a usage error', async () => {
    const dir = tmp()
    const a = seed(dir, 'x1')
    await run(dir, 'investigate', a.shortId)
    for (const word of ['investigando', 'investigating']) assert.match((await run(dir, 'list', '--status', word)).out, new RegExp(a.shortId))
    const bad = await run(dir, 'list', '--status', 'quebrada')
    assert.equal(bad.code, 2)
    assert.match(bad.err, /--status inválido/)
  })

  test('--tag filters by the normalized tag', async () => {
    const dir = tmp()
    const a = seed(dir, 'one')
    seed(dir, 'two')
    await run(dir, 'tag', a.shortId, 'pty')
    const r = await run(dir, 'list', '--tag', '#PTY')
    assert.match(r.out, /one/)
    assert.doesNotMatch(r.out, /two/)
  })

  test('--json has the fixed fields, newest first', async () => {
    const dir = tmp()
    const a = seed(dir, 'older', {}, T0 - 5000)
    const b = seed(dir, 'newer', { kind: 'gone', proc: 'ext:web-bridge' }, T0)
    const rows = json<Record<string, unknown>[]>((await run(dir, 'list', '--json')).out)
    assert.deepEqual(rows.map(r => r.id), [b.shortId, a.shortId])
    assert.deepEqual(Object.keys(rows[0]!).sort(), ['count', 'first', 'id', 'kind', 'last', 'message', 'proc', 'sig', 'status', 'tags', 'version'])
    assert.equal(rows[0]!.kind, 'gone')
    assert.equal(rows[0]!.proc, 'ext:web-bridge')
    assert.equal(rows[0]!.version, '0.9.3')
    assert.match(String(rows[0]!.sig), /^[0-9a-f]{64}$/)
  })

  test('the launcher\'s lines without a state entry still list (reconciled)', async () => {
    const dir = tmp()
    mkdirSync(dir, { recursive: true })
    const line = { id: 'u1', ts: '2026-11-07T11:00:00.000Z', proc: 'main', version: '0.9.3', kind: 'load', message: 'Cannot find module x', stack: '', sig: 'ab'.repeat(32), context: {} }
    writeFileSync(join(dir, 'faults.jsonl'), JSON.stringify(line) + '\n')
    const rows = json<{ id: string; kind: string }[]>((await run(dir, 'list', '--json')).out)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.id, 'abab')
    assert.equal(rows[0]!.kind, 'load')
  })
})

describe('tether faults show', () => {
  test('human output: header, stack, context, occurrences, notes, fix', async () => {
    const dir = tmp()
    const a = seed(dir, 'boom', { context: { slot: 's1' } })
    seed(dir, 'boom', { context: { slot: 's2' } }, T0 + 1000, '0.9.4')
    await run(dir, 'note', a.shortId, 'jsonc', 'UMD', '--by', 'Claude · tether')
    await run(dir, 'done', a.shortId)
    const r = await run(dir, 'show', a.shortId)
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, new RegExp(`falha\\s+${a.shortId}`))
    assert.match(r.out, /assinatura\s+[0-9a-f]{64}/)
    assert.match(r.out, /estado\s+resolvida/)
    assert.match(r.out, /ocorreu\s+2×/)
    assert.match(r.out, /versões\s+0\.9\.4, 0\.9\.3/)
    assert.match(r.out, /fix\s+sem commit/)
    assert.match(r.out, /at fn \(C:\\x\\dist\\m\.cjs:1:2\)/)
    assert.match(r.out, /slot: s2/, 'context of the latest occurrence')
    assert.match(r.out, /Claude · tether: jsonc UMD/)
  })

  test('--json: state entry plus occurrences newest first, capped at 20 unless --all', async () => {
    const dir = tmp()
    const a = seed(dir, 'loop', {}, T0)
    for (let i = 1; i <= 24; i++) seed(dir, 'loop', {}, T0 + i * 70_000) // outside the storm window
    const capped = json<{ occurrences: { ts: string }[]; count: number; id: string; notes: unknown[] }>((await run(dir, 'show', a.shortId, '--json')).out)
    assert.equal(capped.id, a.shortId)
    assert.equal(capped.count, 25)
    assert.equal(capped.occurrences.length, SHOW_CAP)
    assert.ok(capped.occurrences[0]!.ts > capped.occurrences[1]!.ts)
    const all = json<{ occurrences: unknown[] }>((await run(dir, 'show', a.shortId, '--json', '--all')).out)
    assert.equal(all.occurrences.length, 25)
    assert.deepEqual(Object.keys(capped.occurrences[0]!).sort(), ['commit', 'context', 'kind', 'proc', 'stack', 'ts', 'version'])
    assert.ok(!('storm' in capped))
  })
})

describe('ids', () => {
  test('exact short id wins over a prefix of another sig; unique prefix and whole sig resolve', async () => {
    const dir = tmp()
    const a = seed(dir, 'first')
    const sig = a.sig
    assert.equal((await run(dir, 'show', sig.slice(0, 5), '--json')).code, 0, 'prefix longer than the short id')
    assert.equal((await run(dir, 'show', sig, '--json')).code, 0, 'whole sig')
    assert.equal((await run(dir, 'show', a.shortId.toUpperCase(), '--json')).code, 0, 'case does not matter')
    // A second sig whose full hash starts with the first one's short id: the short id still means the first.
    const s = readState(dir).state
    const other = a.shortId + 'f'.repeat(60)
    s.faults[other] = { ...s.faults[sig]!, shortId: a.shortId + 'ffff' }
    writeState(dir, s)
    const exact = json<{ sig: string }>((await run(dir, 'show', a.shortId, '--json')).out)
    assert.equal(exact.sig, sig)
  })

  test('an ambiguous prefix lists the candidates and exits 2; an unknown id exits 1', async () => {
    const dir = tmp()
    mkdirSync(dir, { recursive: true })
    const base = { status: 'open', tags: [], notes: [], count: 1, first: '2026-11-07T10:00:00.000Z', last: '2026-11-07T10:00:00.000Z' }
    writeState(dir, { v: 1, faults: { ['a3f9' + '0'.repeat(60)]: { ...base, shortId: 'a3f9' }, ['a31c' + '0'.repeat(60)]: { ...base, shortId: 'a31c' } } } as never)
    const amb = await run(dir, 'show', 'a3')
    assert.equal(amb.code, 2)
    assert.match(amb.err, /prefixo ambíguo "a3": a3f9, a31c/)
    const unk = await run(dir, 'show', 'zz')
    assert.equal(unk.code, 1)
    assert.match(unk.err, /falha não encontrada: zz \(veja `tether faults`\)/)
    const w = await run(dir, 'done', 'zz')
    assert.equal(w.code, 1)
    const none = await run(dir, 'show')
    assert.equal(none.code, 2)
  })
})

describe('tether faults writes', () => {
  test('investigate records who; done records fix and clears it; messages are one line', async () => {
    const dir = tmp()
    const a = seed(dir, 'w1')
    const inv = await run(dir, 'investigate', a.shortId, '--by', 'Claude · tether-faults')
    assert.equal(inv.out, `${a.shortId} investigando\n`)
    const st = readState(dir).state.faults[a.sig]!
    assert.equal(st.status, 'investigating')
    assert.equal(st.investigating?.by, 'Claude · tether-faults')
    assert.equal((await run(dir, 'investigate', a.shortId, '--by', 'Claude · tether-faults')).out, `${a.shortId} já está investigando\n`)
    const done = await run(dir, 'done', a.shortId, '--fix', 'def4567', '--by', 'Claude')
    assert.equal(done.out, `${a.shortId} resolvida (fix def4567)\n`)
    const after = readState(dir).state.faults[a.sig]!
    assert.equal(after.status, 'done')
    assert.equal(after.fix?.commit, 'def4567')
    assert.equal(after.fix?.by, 'Claude')
    assert.equal(after.investigating, undefined)
    assert.equal((await run(dir, 'done', a.shortId)).out, `${a.shortId} já está resolvida\n`)
    const fixed = await run(dir, 'done', a.shortId, '--fix', '999aaaa')
    assert.match(fixed.out, /resolvida \(fix 999aaaa\)/, 'a new commit on a done fault is a change')
  })

  test('done without a fix is accepted and says so', async () => {
    const dir = tmp()
    const a = seed(dir, 'w2')
    assert.equal((await run(dir, 'done', a.shortId)).out, `${a.shortId} resolvida (sem commit)\n`)
    assert.equal(readState(dir).state.faults[a.sig]!.fix?.commit, undefined)
  })

  test('ignore and reopen; the returned mark stays until someone acts on the fault', async () => {
    const dir = tmp()
    const a = seed(dir, 'w3')
    assert.equal((await run(dir, 'ignore', a.shortId)).out, `${a.shortId} ignorada\n`)
    assert.equal((await run(dir, 'ignore', a.shortId)).out, `${a.shortId} já está ignorada\n`)
    assert.equal((await run(dir, 'reopen', a.shortId)).out, `${a.shortId} aberta\n`)
    assert.equal((await run(dir, 'reopen', a.shortId)).out, `${a.shortId} já está aberta\n`)
    await run(dir, 'done', a.shortId, '--fix', 'aaa1111')
    seed(dir, 'w3', {}, T0 + 100_000, '0.9.4')
    assert.ok(readState(dir).state.faults[a.sig]!.returned)
    assert.equal((await run(dir, 'reopen', a.shortId)).out, `${a.shortId} já está aberta
`, 'it came back open by itself')
    assert.ok(readState(dir).state.faults[a.sig]!.returned, 'the mark stays until someone acts on the fault')
    await run(dir, 'investigate', a.shortId)
    assert.equal(readState(dir).state.faults[a.sig]!.returned, undefined)
  })

  test('tag normalizes (and warns), adds once, --remove takes off', async () => {
    const dir = tmp()
    const a = seed(dir, 'w4')
    const t = await run(dir, 'tag', a.shortId, '#Build', 'Windows PTY', 'build')
    assert.equal(t.code, 0)
    assert.match(t.err, /etiqueta "#Build" gravada como "build"/)
    assert.match(t.err, /etiqueta "Windows PTY" gravada como "windows-pty"/)
    assert.equal(t.out, `${a.shortId}: + build, windows-pty\n`)
    assert.deepEqual(readState(dir).state.faults[a.sig]!.tags, ['build', 'windows-pty'])
    assert.equal((await run(dir, 'tag', a.shortId, 'build')).out, `${a.shortId}: já tem essas etiquetas\n`)
    assert.equal((await run(dir, 'tag', a.shortId, 'build', '--remove')).out, `${a.shortId}: - build\n`)
    assert.deepEqual(readState(dir).state.faults[a.sig]!.tags, ['windows-pty'])
    assert.equal((await run(dir, 'tag', a.shortId, 'nada', '--remove')).out, `${a.shortId}: nenhuma dessas etiquetas estava na falha\n`)
    assert.equal((await run(dir, 'tag', a.shortId, '###')).code, 2)
    assert.equal((await run(dir, 'tag', a.shortId)).code, 2)
  })

  test('note joins the words, takes --by, rejects an empty text', async () => {
    const dir = tmp()
    const a = seed(dir, 'w5')
    assert.equal((await run(dir, 'note', a.shortId, 'causa:', 'jsonc-parser', 'UMD', '--by', 'Soul · atrium')).out, `${a.shortId}: nota gravada\n`)
    const n = readState(dir).state.faults[a.sig]!.notes
    assert.equal(n.length, 1)
    assert.equal(n[0]!.author, 'Soul · atrium')
    assert.equal(n[0]!.text, 'causa: jsonc-parser UMD')
    assert.equal((await run(dir, 'note', a.shortId, '--by', 'x')).code, 2)
    assert.equal((await run(dir, 'note', a.shortId, 'ok')).code, 0)
    assert.equal(readState(dir).state.faults[a.sig]!.notes[1]!.author, 'você')
  })

  test('write verbs with --json print the changed entry (no storm bookkeeping)', async () => {
    const dir = tmp()
    const a = seed(dir, 'w6')
    const r = json<{ id: string; status: string; tags: string[]; storm?: unknown }>((await run(dir, 'tag', a.shortId, 'x', '--json')).out)
    assert.equal(r.id, a.shortId)
    assert.deepEqual(r.tags, ['x'])
    assert.ok(!('storm' in r))
  })

  test('an unreadable state file blocks a write and says nothing was written', async () => {
    const dir = tmp()
    const a = seed(dir, 'w7')
    // A directory where the file should be: readFileSync fails with EISDIR, not ENOENT.
    rmSync(statePath(dir))
    mkdirSync(statePath(dir))
    const r = await run(dir, 'done', a.shortId)
    assert.equal(r.code, 1)
    assert.match(r.err, /estado ilegível; nada foi gravado/)
  })
})

describe('author', () => {
  test('--by wins; a slot in TETHER_SLOT_ID gives its name; otherwise "você"', () => {
    const home = tmp()
    createSlot(home, { v: 1, slotId: 's-aaaa1111', name: 'tether-faults', agent: 'claude', cwd: home, args: [], createdAt: new Date().toISOString() })
    const env = { TETHER_HOME: home, TETHER_SLOT_ID: 's-aaaa1111' }
    assert.equal(authorOf('Outro', env), 'Outro')
    assert.equal(authorOf(undefined, env), 'tether-faults')
    assert.equal(authorOf(undefined, { TETHER_HOME: home }), 'você')
    assert.equal(authorOf(undefined, { TETHER_HOME: home, TETHER_SLOT_ID: 'nao-existe' }), 'você')
  })
})

describe('bin', () => {
  test('tether faults through the real entry point: exit codes and --json', () => {
    const user = tmp()
    const dir = faultsDir({ TETHER_USER_DIR: user })
    const a = seed(dir, 'bin test')
    const env = { ...process.env, TETHER_USER_DIR: user, TETHER_HOME: user, TETHER_SLOT_ID: '' }
    const sh = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 60_000 })
    const ls = sh('faults', 'list', '--json')
    assert.equal(ls.status, 0, ls.stderr)
    assert.equal((JSON.parse(ls.stdout) as { id: string }[])[0]!.id, a.shortId)
    assert.equal(sh('faults', 'done', a.shortId, '--fix', 'abc1234').stdout, `${a.shortId} resolvida (fix abc1234)\n`)
    assert.equal(sh('faults', 'show', 'zz').status, 1)
    assert.equal(sh('faults', 'bogus').status, 2)
    assert.match(sh('help').stdout, /faults \[list\]/)
  })
})
