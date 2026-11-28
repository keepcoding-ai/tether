// "Novo processo" from afar (RR5 5.5), the pure rules of the web's form and its act: each field as the app's form checks it
// and within the portal's ceilings, a secret BARRED before anything goes (the advice, never "create anyway"), the sentence
// of what runs (no value in it), the portal's refusals in words at their field, and the canary: a variable's value goes
// only in the request's bytes, never to the browser's storage, a log or what the manager keeps after the answer.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { opByName, RES_STATUS, type Bytes, type UvProof } from '../../src/remote/index.ts'
import { ENV_MAX, ENV_VALUE_MAX, PORTS_MAX, PROC_COMMAND_MAX } from '../../src/remote/procs-new.ts'
import { createManager, type ManageSession } from '../../remote/web/src/manage.ts'
import { refusalWords } from '../../remote/web/src/manage-rules.ts'
import { afarProcRefusal, checkAfarProc, ENV_WARNING, runLine, secretBar, type AfarProcForm } from '../../remote/web/src/new-proc-afar-rules.ts'

const FOLDER = '0123456789abcdef'
const form = (o: Partial<AfarProcForm> = {}): AfarProcForm => ({ name: 'bench-web', command: 'npm run dev', folder: FOLDER, ports: '', description: '', env: [], ...o })

describe('the form\'s fields, before anything is sent', () => {
  test('a good form is the portal\'s body, exactly its keys', () => {
    const r = checkAfarProc(form({ ports: '3000, 5173', description: '  o  site ', env: [{ name: 'NODE_ENV', value: 'production' }, { name: '', value: '' }] }), [])
    assert.deepEqual(r, { ok: true, body: { name: 'bench-web', command: 'npm run dev', folder: FOLDER, ports: [3000, 5173], description: 'o site', env: [{ name: 'NODE_ENV', value: 'production' }] } })
    assert.equal(ENV_WARNING, 'Aqui não é lugar de senha nem chave.')
  })

  test('the app\'s checks: the name, a known name, the command, the folder from the list (never a path), the ports', () => {
    const err = (f: AfarProcForm, existing: string[] = []) => { const r = checkAfarProc(f, existing); return r.ok ? undefined : [r.field, r.error] }
    assert.equal(err(form({ name: 'Bad Name' }))![0], 'name')
    assert.deepEqual(err(form(), ['bench-web'])![0], 'name')
    assert.deepEqual(err(form({ command: '  ' }))![0], 'command')
    assert.deepEqual(err(form({ folder: 'C:\\obra' })), ['cwd', 'Escolha a pasta em que o processo roda.'])
    assert.deepEqual(err(form({ ports: '70000' }))![0], 'ports')
    assert.deepEqual(err(form({ env: [{ name: '1X', value: 'a' }] }))![0], 'env')
  })

  test('the portal\'s ceilings: command, ports, variables, value, a line break in a value', () => {
    const err = (f: AfarProcForm) => { const r = checkAfarProc(f, []); return r.ok ? undefined : r.field }
    assert.equal(err(form({ command: `node ${'x'.repeat(PROC_COMMAND_MAX)}` })), 'command')
    assert.equal(err(form({ command: 'npm\nrun' })), 'command')
    assert.equal(err(form({ ports: Array.from({ length: PORTS_MAX + 1 }, (_, i) => 3000 + i).join(',') })), 'ports')
    assert.equal(err(form({ env: Array.from({ length: ENV_MAX + 1 }, (_, i) => ({ name: `V${i}`, value: 'x' })) })), 'env')
    assert.equal(err(form({ env: [{ name: 'BIG', value: 'x'.repeat(ENV_VALUE_MAX + 1) }] })), 'env')
    assert.equal(err(form({ env: [{ name: 'NL', value: 'a\nb' }] })), 'env')
    assert.equal(err(form({ description: 'x'.repeat(201) })), 'description')
  })
})

describe('a secret is barred, never asked', () => {
  test('a name that looks like a secret: the advice to put it in the command, and no "create anyway"', () => {
    const r = checkAfarProc(form({ env: [{ name: 'NODE_ENV', value: 'dev' }, { name: 'API_TOKEN', value: 'abc' }] }), [])
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.field, 'env')
    assert.equal(r.envIndex, 1)
    assert.equal(r.error, 'API_TOKEN parece um segredo. Segredo não vai por aqui: ponha-o no próprio comando, por exemplo `dotenvx run -- …`.')
    assert.doesNotMatch(r.error, /mesmo assim/)
    assert.doesNotMatch(r.error, /abc/, 'never the value')
  })

  test('a value with the shape of a secret, and a command that carries one', () => {
    const v = checkAfarProc(form({ env: [{ name: 'DATABASE_URL', value: 'postgres://u:senhaforte@db/x' }] }), [])
    assert.equal(!v.ok && v.field, 'env')
    assert.doesNotMatch(!v.ok ? v.error : '', /senhaforte/)
    const c = checkAfarProc(form({ command: 'node app.js --token sk-abcdefghijklmnop' }), [])
    assert.equal(!c.ok && c.field, 'command')
    assert.equal(!c.ok && c.error, secretBar([], true))
    assert.doesNotMatch(!c.ok ? c.error : '', /sk-abc/)
  })

  test('the portal\'s refusals become the same advice, at their field', () => {
    assert.deepEqual(afarProcRefusal('secret-env', { names: ['DB_PASS'] }, refusalWords), { field: 'env', text: secretBar(['DB_PASS'], false) })
    assert.deepEqual(afarProcRefusal('secret-command', {}, refusalWords), { field: 'command', text: secretBar([], true) })
    assert.equal(afarProcRefusal('proc-exists', {}, refusalWords).field, 'name')
    assert.equal(afarProcRefusal('unknown-folder', {}, refusalWords).field, 'cwd')
    assert.equal(afarProcRefusal('no-app', {}, refusalWords).text, 'O tether não está aberto na máquina. Nada foi feito.')
  })

  test('the sentence of what runs names the variables, never a value', () => {
    assert.equal(runLine({ name: 'web', command: 'npm run dev', env: [{ name: 'MODE', value: 'segredo-nao' }] }, 'obra'), '"web" vai rodar npm run dev na pasta obra com 1 variável (MODE).')
  })
})

describe('the canary: the value goes in the request and nowhere else', () => {
  test('after the answer, no storage of the browser, no log and nothing the manager shows holds it', async () => {
    const MARKER = `canary${Math.random().toString(16).slice(2)}${Date.now()}`
    // The browser's two storages, made up (Node has none): the test sweeps them after the act.
    const store = (): Storage => {
      const m = new Map<string, string>()
      return { get length() { return m.size }, clear: () => m.clear(), getItem: k => m.get(k) ?? null, key: i => [...m.keys()][i] ?? null, removeItem: k => { m.delete(k) }, setItem: (k, v) => { m.set(k, String(v)) } }
    }
    const g = globalThis as unknown as { localStorage?: Storage; sessionStorage?: Storage }
    const had = { local: g.localStorage, session: g.sessionStorage }
    g.localStorage = store()
    g.sessionStorage = store()
    const logged: string[] = []
    const keep = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug }
    for (const k of Object.keys(keep) as (keyof typeof keep)[]) console[k] = (...a: unknown[]) => { logged.push(a.map(String).join(' ')) }
    try {
      const sent: string[] = []
      const NEW = opByName('procs.new')!.code
      const info = opByName('session.info')!.code
      const s: ManageSession = {
        ended: undefined, sessionId: new Uint8Array(16),
        request: async (op, body?: Record<string, unknown> | Bytes) => {
          if (op === info) return { status: RES_STATUS.ok, body: { scopes: ['manage:procs'], deviceId: 'ab'.repeat(16) } }
          if (op === NEW) sent.push(body instanceof Uint8Array ? new TextDecoder().decode(body) : JSON.stringify(body))
          // The portal answers the process by names only (remoteProc).
          return { status: RES_STATUS.ok, body: { proc: { name: 'bench-new', status: 'running', envNames: ['BENCH_MODE'] } } }
        },
      }
      const proof: UvProof = { uvCtr: 1, authenticatorData: new Uint8Array([1]), clientDataJSON: new Uint8Array([1]), signature: new Uint8Array([1]) }
      const m = createManager({ credential: true, prover: { act: async () => ({ ok: true, uvProof: proof }), window: async () => ({ ok: true }) } })
      m.attach(s)
      const checked = checkAfarProc(form({ name: 'bench-new', env: [{ name: 'BENCH_MODE', value: MARKER }] }), [])
      assert.ok(checked.ok)
      const r = await m.act('procs.new', checked.body as unknown as Record<string, unknown>, { proof: 'act' })
      assert.equal(r.ok, true)
      assert.equal(sent.length, 1)
      assert.ok(sent[0]!.includes(MARKER), 'the value went, in the one request')
      const sweep = (st: Storage): string => Array.from({ length: st.length }, (_, i) => `${st.key(i)}=${st.getItem(st.key(i)!)}`).join('\n')
      assert.equal(sweep(g.localStorage).includes(MARKER), false, 'not in localStorage')
      assert.equal(sweep(g.sessionStorage).includes(MARKER), false, 'not in sessionStorage')
      assert.equal(logged.join('\n').includes(MARKER), false, 'not in a log')
      assert.equal(JSON.stringify(r).includes(MARKER), false, 'not in the answer the screen holds')
      assert.equal(JSON.stringify(m.procs() ?? null).includes(MARKER), false, 'not in what the manager shows')
    } finally {
      Object.assign(console, keep)
      g.localStorage = had.local
      g.sessionStorage = had.session
    }
  })
})
