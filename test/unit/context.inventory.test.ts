import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { inventoryKey, parseFrontmatter, readInventory, redactSecrets } from '../../src/context/inventory.ts'

const SECRET = 'sk-SUPERSECRETVALUE1234567890'

function build() {
  const root = mkdtempSync(join(tmpdir(), 'tether-inv-'))
  const home = join(root, 'home')
  const proj = join(root, 'proj', 'sub')
  const w = (p: string, c: string) => {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, c)
  }
  w(join(home, '.claude', 'CLAUDE.md'), 'u'.repeat(400))
  w(join(root, 'proj', 'CLAUDE.md'), 'parent\nsee @docs/extra.md and `@ignored.md`\n```\n@fenced.md\n```\n')
  w(join(root, 'proj', 'docs', 'extra.md'), 'x'.repeat(80))
  w(join(root, 'proj', 'fenced.md'), 'no')
  w(join(proj, 'CLAUDE.md'), 'child')
  w(join(proj, 'CLAUDE.local.md'), 'local')
  w(join(proj, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: >\n  Ship the thing\n  safely\n---\n' + 'b'.repeat(400))
  w(join(home, '.claude', 'skills', 'lint', 'SKILL.md'), '---\nname: "lint"\ndescription: Lints\n---\nbody')
  w(join(proj, '.claude', 'agents', 'rev.md'), '---\nname: rev\ndescription: Reviews\n---\n' + 'a'.repeat(40))
  w(join(proj, '.claude', 'commands', 'go.md'), '---\ndescription: Go\n---\nrun')
  w(join(proj, '.mcp.json'), JSON.stringify({ mcpServers: {
    docs: { command: 'npx', args: ['-y', 'x', `--token=${SECRET}`], env: { API_KEY: SECRET } },
    remote: { type: 'http', url: 'https://x.test/?k=' + SECRET, headers: { Authorization: 'Bearer ' + SECRET } },
  } }))
  w(join(home, '.claude.json'), JSON.stringify({
    mcpServers: { glob: { command: 'g', env: { T: SECRET } } },
    projects: { [proj.replaceAll('\\', '/')]: { mcpServers: { pj: { type: 'sse', url: 'https://p.test/' + SECRET } } }, other: { mcpServers: { no: {} } } },
  }))
  w(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'a@m': true, 'b@m': false }, statusLine: { type: 'command', command: `node s.js --api-key ${SECRET}` } }))
  w(join(proj, '.claude', 'settings.json'), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `GH_TOKEN=${SECRET} node h.js` }, { type: 'command', command: 'node ok.js' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'node stop.js' }] }],
  } }))
  return { root, home, proj }
}

test('inventory reads the chain, skills, agents, commands, mcp, hooks, plugins', async () => {
  const { root, home, proj } = build()
  try {
    const inv = await readInventory(proj, { home, claudeVersion: '9.9.9' })
    const kinds = inv.memory.map((m) => m.kind)
    assert.deepEqual(kinds.filter((k) => k !== 'import'), ['user', 'project', 'project', 'local'])
    const imports = inv.memory.filter((m) => m.kind === 'import')
    assert.equal(imports.length, 1)
    assert.ok(imports[0]!.path.endsWith('extra.md'))
    assert.equal(imports[0]!.tokens, 20)
    assert.equal(inv.memory[0]!.tokens, 100)
    assert.ok(inv.memory.every((m) => m.estimated === true))

    const deploy = inv.skills.find((s) => s.name === 'deploy')!
    assert.equal(deploy.scope, 'project')
    assert.equal(deploy.description, 'Ship the thing safely')
    assert.equal(deploy.bodyTokens, 100)
    assert.ok(deploy.promptTokens < 10)
    assert.equal(inv.skills.find((s) => s.name === 'lint')!.scope, 'user')
    assert.equal(inv.agents[0]!.name, 'rev')
    assert.equal(inv.commands[0]!.name, 'go')

    const names = inv.mcpServers.map((s) => `${s.source}:${s.name}:${s.transport}`).sort()
    assert.deepEqual(names, ['claude-json-project:pj:sse', 'claude-json-user:glob:stdio', 'project-file:docs:stdio', 'project-file:remote:http'])

    assert.equal(inv.hooks.find((h) => h.event === 'PreToolUse')!.count, 2)
    assert.equal(inv.hooks.find((h) => h.event === 'Stop')!.count, 1)
    assert.deepEqual(inv.plugins, ['a@m'])
    assert.ok(inv.statusLine!.command.startsWith('node s.js'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('no secret value reaches the returned objects', async () => {
  const { root, home, proj } = build()
  try {
    const dump = JSON.stringify(await readInventory(proj, { home, claudeVersion: '1' }))
    assert.ok(!dump.includes('SUPERSECRET'), 'secret leaked')
    assert.ok(!dump.includes('Bearer'))
    assert.ok(!dump.includes('API_KEY'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('inventoryKey is stable and reacts only to relevant changes', async () => {
  const { root, home, proj } = build()
  try {
    const key = async (v = '1') => inventoryKey(await readInventory(proj, { home, claudeVersion: v }))
    const a = await key()
    assert.equal(await key(), a)
    // Claude rewrites ~/.claude.json on every session: touching it must not change the key.
    const later = new Date(Date.now() + 5000)
    utimesSync(join(home, '.claude.json'), later, later)
    assert.equal(await key(), a)
    assert.notEqual(await key('2'), a)
    writeFileSync(join(proj, 'CLAUDE.md'), 'child changed a lot')
    const c = await key()
    assert.notEqual(c, a)
    writeFileSync(join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { only: { command: 'x' } } }))
    assert.notEqual(await key(), c)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('missing everything yields an empty inventory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tether-inv-empty-'))
  try {
    const inv = await readInventory(join(root, 'nope'), { home: join(root, 'h'), claudeVersion: 'x' })
    assert.equal(inv.skills.length + inv.agents.length + inv.mcpServers.length + inv.hooks.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('redactSecrets and frontmatter helpers', () => {
  assert.ok(!redactSecrets('curl -H "Authorization: Bearer abc123def" x').includes('abc123def'))
  assert.ok(!redactSecrets('MY_SECRET=hunter2 run').includes('hunter2'))
  assert.equal(redactSecrets('node a.js --port 3000'), 'node a.js --port 3000')
  assert.deepEqual(parseFrontmatter('no front').fields, {})
  assert.equal(parseFrontmatter('---\r\nname: x\r\n---\r\nbody').fields.name, 'x')
})
