// The rules of the Regency's "Novo processo": the checks of each field, the secret-looking names by the repo's one rule
// (core/redact-args.ts), the question that asks first, the request (the CLI's proc-start recipe) and the daemon's refusal in
// plain words with every typed value masked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { looksSecretName, redactArgs } from '../../src/core/redact-args.ts'
import { PROC_NAME_RE } from '../../src/daemon/procs.ts'
import {
  checkNewProc, createRefusalText, ENV_WARNING, envError, isAbsoluteFolder, maskEcho, PROC_NAME, parsePorts, procNameError, refusalField,
  secretNames, secretQuestion, splitCommand, VALUE_MASK, type NewProcForm,
} from '../../extensions/regency/new-process-rules.ts'

const CANARY = 'canario-r7c-9f3a'
const form = (over: Partial<NewProcForm> = {}): NewProcForm => ({
  name: 'web', command: 'node server.js --port 3000', cwd: 'C:\\work', ports: '3000', description: '', env: [], ...over,
})

test('the name: tetherd\'s rule (the same regex as procs.ts), required, not one the list has', () => {
  assert.equal(PROC_NAME.source, PROC_NAME_RE.source, 'the renderer copy of the rule is the daemon\'s')
  assert.equal(procNameError('atrium-web', []), undefined)
  assert.equal(procNameError('  atrium-web ', []), undefined)
  assert.match(procNameError('', [])!, /Dê um nome/)
  assert.match(procNameError('Web', [])!, /letras minúsculas/)
  assert.match(procNameError('-web', [])!, /letras minúsculas/)
  assert.match(procNameError('a'.repeat(65), [])!, /até 64/)
  assert.match(procNameError('web', ['web'])!, /Já existe um processo "web"/)
})

test('the command: quotes group words; empty is an error', () => {
  assert.deepEqual(splitCommand('npm run dev'), { command: 'npm', args: ['run', 'dev'] })
  assert.deepEqual(splitCommand('node "C:\\Meus Projetos\\a.js" --x'), { command: 'node', args: ['C:\\Meus Projetos\\a.js', '--x'] })
  assert.ok('error' in splitCommand('   '))
})

test('the folder must be absolute', () => {
  for (const p of ['C:\\work', 'D:/x', '\\\\srv\\share\\x', '/home/a']) assert.equal(isAbsoluteFolder(p), true, p)
  for (const p of ['work', '.\\x', 'C:x']) assert.equal(isAbsoluteFolder(p), false, p)
})

test('ports: zero or more, by comma or space, 1 to 65535, repeated once', () => {
  assert.deepEqual(parsePorts(''), { ports: [] })
  assert.deepEqual(parsePorts('3000, 5173 3000'), { ports: [3000, 5173] })
  for (const bad of ['0', '65536', '30a0', '-1', '3.5']) assert.ok('error' in parsePorts(bad), bad)
})

test('variables: a name each, a good name, no repeated name (any case); blank rows do not count', () => {
  assert.equal(envError([{ name: '', value: '' }, { name: 'MODO', value: 'x' }]), undefined)
  assert.deepEqual(envError([{ name: '', value: CANARY }]), { index: 0, error: 'Dê um nome à variável (ou apague a linha).' })
  assert.match(envError([{ name: '1X', value: '' }])!.error, /não serve de nome/)
  assert.match(envError([{ name: 'modo', value: '' }, { name: 'MODO', value: '' }])!.error, /duas vezes/)
  // No error sentence carries a value.
  for (const rows of [[{ name: '', value: CANARY }], [{ name: 'A B', value: CANARY }], [{ name: 'X', value: CANARY }, { name: 'x', value: CANARY }]]) {
    assert.ok(!JSON.stringify(envError(rows)).includes(CANARY))
  }
})

test('secret-looking names: the SAME rule that masks arguments (core/redact-args.ts)', () => {
  const names = ['API_TOKEN', 'GITHUB_KEY', 'DB_PASSWORD', 'MY_SECRET', 'AUTH_HEADER', 'SESSION_COOKIE', 'PASSWD', 'CREDENTIALS', 'MODO', 'PORT', 'NODE_ENV', 'NOTA']
  for (const n of names) {
    const masked = redactArgs([`${n}=x`])[0] !== `${n}=x`
    assert.equal(looksSecretName(n), masked, `${n}: the name rule and the argument mask agree`)
  }
  assert.deepEqual(secretNames([{ name: 'MODO', value: 'a' }, { name: ' API_TOKEN ', value: '' }, { name: '', value: '' }, { name: 'DB_PASSWORD', value: 'b' }]), ['API_TOKEN', 'DB_PASSWORD'])
  assert.deepEqual(secretNames([{ name: 'MODO', value: 'a' }]), [])
})

test('the question names the variables and points the secret to the command', () => {
  assert.equal(secretQuestion(['API_TOKEN']), 'API_TOKEN parece um segredo. Segredo vai no próprio comando, por exemplo `dotenvx run -- …`. Criar mesmo assim?')
  assert.match(secretQuestion(['A_KEY', 'B_TOKEN', 'C_SECRET']), /^A_KEY, B_TOKEN e C_SECRET parecem segredos\. /)
  assert.equal(ENV_WARNING, 'Aqui não é lugar de senha nem chave.')
})

test('the whole form: field by field in the order drawn, then the request the CLI would send', () => {
  assert.deepEqual(checkNewProc(form({ name: '' }), []), { ok: false, field: 'name', error: 'Dê um nome ao processo.' })
  assert.equal((checkNewProc(form({ command: '' }), []) as { field: string }).field, 'command')
  assert.equal((checkNewProc(form({ cwd: '' }), []) as { field: string }).field, 'cwd')
  assert.equal((checkNewProc(form({ cwd: 'rel' }), []) as { field: string }).field, 'cwd')
  assert.equal((checkNewProc(form({ ports: 'x' }), []) as { field: string }).field, 'ports')
  assert.deepEqual(checkNewProc(form({ env: [{ name: 'A', value: '' }, { name: '', value: 'v' }] }), []), { ok: false, field: 'env', error: 'Dê um nome à variável (ou apague a linha).', envIndex: 1 })
  const c = checkNewProc(form({ description: '  servidor   de teste ', env: [{ name: ' MODO ', value: 'bancada' }, { name: '', value: '' }, { name: 'API_TOKEN', value: CANARY }] }), ['worker'])
  assert.deepEqual(c, {
    ok: true,
    request: {
      name: 'web',
      recipe: { command: 'node', args: ['server.js', '--port', '3000'], cwd: 'C:\\work', env: { MODO: 'bancada', API_TOKEN: CANARY }, ports: [3000], description: 'servidor de teste' },
    },
    secretNames: ['API_TOKEN'],
  })
  // No description, no ports: the keys stay out / empty, as the CLI sends them.
  const plain = checkNewProc(form({ ports: '' }), [])
  assert.ok(plain.ok && !('description' in plain.request.recipe) && plain.request.recipe.ports.length === 0)
})

test('maskEcho takes every typed value (long enough) out of a text, the longest first', () => {
  assert.equal(maskEcho(`falhou: MODO=${CANARY} e ${CANARY}`, [CANARY]), `falhou: MODO=${VALUE_MASK} e ${VALUE_MASK}`)
  assert.equal(maskEcho('abcdef', ['abcd', 'abcdef']), VALUE_MASK)
  assert.equal(maskEcho('a porta 3000', ['3']), 'a porta 3000', 'a short value is no secret and does not eat a sentence')
  assert.equal(maskEcho('nada aqui', []), 'nada aqui')
})

test('the daemon\'s refusals in plain words: the port says who holds it, without the CLI\'s advice; values masked', () => {
  const busy = 'não iniciei web: a porta 3000 já está ocupada por node (pid 4120). Escolha outra porta (tether proc ports mostra quem ouve onde), pare quem ocupa, ou inicie mesmo assim com --force'
  assert.equal(createRefusalText('port-busy', busy, []), 'Não iniciei: a porta 3000 já está ocupada por node (pid 4120). Escolha outra porta ou pare quem a ocupa.')
  const other = 'não iniciei web: a porta 3000 é declarada por api, que está rodando (iniciado por você (pelo app)). Escolha outra porta (tether proc ports mostra quem ouve onde), pare quem ocupa, ou inicie mesmo assim com --force'
  assert.match(createRefusalText('port-busy', other, []), /^Não iniciei: a porta 3000 é declarada por api, que está rodando/)
  assert.doesNotMatch(createRefusalText('port-busy', busy, []), /--force|tether proc/)
  assert.match(createRefusalText('proc-running', 'web já está rodando…', []), /Já existe um processo com esse nome rodando/)
  assert.equal(createRefusalText('bad-request', `receita inválida MODO=${CANARY}`, [CANARY]), `O tether recusou: receita inválida MODO=${VALUE_MASK}.`)
  assert.equal(createRefusalText('xyz', `eco ${CANARY}`, [CANARY]), `eco ${VALUE_MASK}.`)
  assert.equal(refusalField('port-busy'), 'ports')
  assert.equal(refusalField('proc-running'), 'name')
  assert.equal(refusalField('bad-request'), undefined)
})
