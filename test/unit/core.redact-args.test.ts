// The one rule that keeps a secret out of what a view shows (src/core/redact-args.ts): which names look secret, which values
// have the shape of a credential, and what a launch's arguments look like once masked. The 34 forms of Temper r7 (T6) are
// the floor; a list of ordinary command lines proves the rule does not eat what a person needs to read (ports, paths, flags).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { looksSecretName, looksSecretValue, redactArgs } from '../../src/core/redact-args.ts'
import { parseArgs } from '../../app/renderer/args.ts'

/** Temper r7, T6: every value is `v<n>`; none may survive the mask. */
const T6: string[][] = [
  ['--token', 'v1'], ['--token=v2'], ['-pv4secret'], ['--pass', 'v5'], ['--pwd', 'v6'], ['--auth', 'v7'],
  ['--api-key', 'v8'], ['--apikey=v9'], ['--key', 'v10'], ['--secret', 'v11'], ['--client-secret', 'v12'],
  ['postgres://user:v13pass@db.local:5432/app'], ['--database-url', 'postgres://u:v14@h/db'], ['https://user:v15@example.com/x'],
  ['-H', 'Authorization: Bearer v16zzzzzz'], ['-H', 'X-Api-Key: v17'], ['--header=Cookie: session=v18'],
  ['-e', 'TOKEN=v19'], ['-e', 'MY_PASS=v20'], ['--env', 'DB_PASSWORD=v21'], ['-c', 'export TOKEN=v22 && run'], ['-c', 'set PASSWORD=v23&& run'],
  ['--password', '"v24 with space"'], ['--access_token', 'v25'], ['--bearer', 'v26'], ['/p:v27'], ['/password:v28'],
  ['-u', 'admin:v29'], ['--user=admin:v30'], ['--cred', 'v31'], ['--credentials', 'v32'], ['--private-key', 'v33'], ['--session', 'v34'],
  // a value that starts with "-" after a secret option
  ['--password', '-v35x'], ['--token', '-v36'],
]

/** Command lines that hold no secret: masking any word of them is a regression. */
const INNOCENT = [
  'npm run dev',
  'node server.js --port 3000',
  'serve -p 3000',
  'vite --host 0.0.0.0 --port 5173 --strictPort',
  'tsc -p tsconfig.json',
  'docker run -p 8080:80 -u 1000:1000 -v C:\\data:/data nginx',
  'git push -u origin main',
  'find . -name "*.ts" -print',
  'gcc -pthread -pedantic -O2 main.c -o main',
  'msbuild app.sln /p:Configuration=Release /m',
  'python -m http.server 8000',
  'curl https://example.com/api?x=1 -H "Accept: application/json" -H "Content-Type: application/json"',
  'node --inspect=9229 app.js',
  'app --config C:\\proj\\cfg.json --log-level debug',
  'cmd /c echo hi',
  'npm run build -- --bypass-cache src/',
  'rsync --passthrough a b',
  'ssh user@host.local',
  'open http://localhost:3000/x --url http://localhost:5173',
  'npx playwright test --project=chromium --workers 2',
  'cross-env NODE_ENV=production PORT=4000 node dist/main.js',
  'git log --format=%H -n 5',
  '"C:\\Program Files\\nodejs\\node.exe" "C:\\my app\\index.js"',
]

describe('redactArgs', () => {
  test('Temper r7 T6: no form of a secret in the arguments survives', () => {
    const leaked = T6.filter(c => { const v = /v\d+/.exec(c.join(' '))![0]; return redactArgs(c).join(' ').includes(v) })
    assert.deepEqual(leaked.map(c => c.join(' ')), [])
  })

  test('the option names stay: what was masked is only the value', () => {
    assert.deepEqual(redactArgs(['--pass', 'v5']), ['--pass', '[redacted]'])
    assert.deepEqual(redactArgs(['-pv4secret']), ['-p[redacted]'])
    assert.deepEqual(redactArgs(['postgres://user:v13pass@db.local:5432/app']), ['postgres://user:[redacted]@db.local:5432/app'])
    assert.deepEqual(redactArgs(['-H', 'X-Api-Key: v17']), ['-H', 'X-Api-Key: [redacted]'])
    assert.deepEqual(redactArgs(['/p:v27']), ['/p:[redacted]'])
    assert.deepEqual(redactArgs(['-u', 'admin:v29']), ['-u', 'admin:[redacted]'])
    assert.deepEqual(redactArgs(['--user=admin:v30']), ['--user=admin:[redacted]'])
    assert.deepEqual(redactArgs(['--password', '-v35x']), ['--password', '[redacted]'])
  })

  test('ambiguity, decided: "-p <value>" apart is a port, a project or a database name (kept); glued and not a number, a password', () => {
    assert.deepEqual(redactArgs(['-p', '3000']), ['-p', '3000'])
    assert.deepEqual(redactArgs(['-p', 'tsconfig.json']), ['-p', 'tsconfig.json'])
    assert.deepEqual(redactArgs(['-p3000']), ['-p3000'])
    assert.deepEqual(redactArgs(['-p8080:80']), ['-p8080:80'])
    assert.deepEqual(redactArgs(['-pHunter2']), ['-p[redacted]'])
  })

  test('ordinary command lines come back as they went', () => {
    for (const line of INNOCENT) {
      const argv = parseArgs(line)
      assert.deepEqual(redactArgs(argv), argv, line)
    }
  })
})

describe('looksSecretName', () => {
  test('Temper r7 T8: the common names of a secret', () => {
    const names = ['DB_PASS', 'SMTP_PASS', 'MYSQL_PWD', 'PGPASS', 'PGPASSWORD', 'SENTRY_DSN', 'PRIVATE_PEM', 'SESSION_SIGNING', 'JWT_SIGNING',
      'OTP_SEED', 'PIN', 'SALT', 'CERT_PEM', 'TLS_CERT', 'PRIVATE_KEY', 'GPG_PASSPHRASE', 'API_TOKEN', 'APIKEY', 'CLIENT_SECRET', 'NPM_AUTH',
      'dbPass', 'smtpPwd', 'AWS_CREDS']
    assert.deepEqual(names.filter(n => !looksSecretName(n)), [])
  })

  test('ordinary names are not secrets; PWD exact is the working folder', () => {
    const names = ['PWD', 'PORT', 'HOST', 'NODE_ENV', 'PATH', 'HOME', 'LOG_LEVEL', 'PASSTHROUGH', 'BYPASS_CACHE', 'COMPASS_DIR', 'SPINNER',
      'PINNED', 'DATABASE_URL', 'REDIS_URL', 'WEBHOOK_URL', 'NOTA', 'DEBUG']
    assert.deepEqual(names.filter(n => looksSecretName(n)), [])
  })
})

describe('looksSecretValue', () => {
  test('the shape of a credential, whatever the name', () => {
    const values = [
      'postgres://app:hunter22@db.local:5432/app', 'redis://:s3cr3t@cache:6379', 'https://hook:abc123@example.com/x',
      '-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----', '-----BEGIN OPENSSH PRIVATE KEY-----',
      'sk-live-abcdefghijklmnop', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'xoxb-1234-5678-abcdef', 'AKIAABCDEFGHIJKLMNOP',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij', 'Qx7vT2mN9pL4sR8wK1zY6bH3cJ5dF0gA',
    ]
    assert.deepEqual(values.filter(v => !looksSecretValue(v)), [])
  })

  test('ordinary values are not', () => {
    const values = ['production', '3000', 'http://localhost:3000', 'https://example.com/a/b?c=d', 'C:\\Users\\me\\projects\\web',
      '/usr/local/bin', 'debug', 'true', 'pt-BR', 'node_modules/.bin', 'ssh://git@github.com/org/repo.git', 'a b c d e f g h i j k l m n o p',
      'abcdefghijklmnopqrstuvwxyzabcdefghij']
    assert.deepEqual(values.filter(v => looksSecretValue(v)), [])
  })
})
