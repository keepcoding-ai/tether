// How each agent takes the composed share folder: Claude Code as a session-only plugin generated next to it
// (src/agents/claude-plugin.ts: .claude-plugin/plugin.json, skills/ merged from the loose skills and each MCP's own,
// .mcp.json merged from every mcps/<slug>/mcp.json, `--plugin-dir` on the plan), the soul (src/agents/soul-share.ts) as one
// more shared folder holding REAL copies of the skills (`-S <share>/soul`, after the SOUL_CLI_SHARED_FOLDERS list when no -S
// was typed, before a `--`) plus the merged servers as `--mcp-config <share>/soul.mcp.json`.
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
// The daemon index first: it is the entry the agent extensions are loaded through (claude/daemon.ts alone closes a cycle via core/profile.ts).
import '../../extensions/index.daemon.ts'
import { claudeAgent } from '../../extensions/claude/daemon.ts'
import { soulAgent } from '../../extensions/soul/daemon.ts'
import { CLAUDE_PLUGIN_DIR, ensureClaudePlugin, mergedMcpServers, PLUGIN_DIR_FLAG, withClaudePlugin } from '../../src/agents/claude-plugin.ts'
import { ENV_SOUL_SHARED, withSharedFolder } from '../../src/agents/soul.ts'
import { ensureSoulView, SOUL_MCP_FILE, SOUL_VIEW_DIR } from '../../src/agents/soul-share.ts'
import type { LaunchPlan } from '../../src/agents/types.ts'
import { cleanShares, composeShare } from '../../src/daemon/share.ts'
import { removeHome, tempHome } from './daemon.helpers.ts'

let root: string
let home: string
let shareDir: string

const write = (path: string, text: string): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text) }
const server = (arg: string) => ({ type: 'stdio', command: 'node', args: [arg], env: { X: arg } })

before(() => {
  root = tempHome()
  home = join(root, 'home')
  const a = join(root, 'feat-a')
  write(join(a, 'skills', 'tether-faults', 'SKILL.md'), '---\nname: tether-faults\n---\n')
  write(join(a, 'mcps', 'tether-bridge', 'mcp.json'), JSON.stringify({ mcpServers: { 'tether-bridge': server('bridge') } }))
  write(join(a, 'mcps', 'tether-bridge', 'skills', 'browse', 'SKILL.md'), '---\nname: browse\n---\n')
  const b = join(root, 'feat-b')
  write(join(b, 'mcps', 'other', 'mcp.json'), JSON.stringify({ mcpServers: { other: server('other') } }))
  write(join(b, 'mcps', 'off', 'mcp.json'), JSON.stringify({ mcpServers: { off: server('off') } }))
  write(join(b, 'mcps', 'off', 'mcp.meta.json'), JSON.stringify({ enabled: false }))
  shareDir = composeShare(home, [{ id: 'a', dir: a }, { id: 'b', dir: b }]).dir
})
after(async () => { cleanShares(home); await removeHome(root) })

const plan = (args: string[] = ['--settings', 's.json', '--model', 'haiku'], env: Record<string, string> = { PATH: 'p' }): LaunchPlan => ({ command: 'x', args, cwd: 'C:\\w', env })

describe('Claude: the share folder as a plugin', () => {
  test('.claude-plugin/plugin.json names the plugin "tether" and the features', () => {
    const dir = ensureClaudePlugin(shareDir)
    assert.equal(dir, join(shareDir, CLAUDE_PLUGIN_DIR))
    const manifest = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')) as { name: string; version: string; description: string }
    assert.equal(manifest.name, 'tether')
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
    assert.match(manifest.description, /a, b/)
    assert.deepEqual(readdirSync(join(dir, '.claude-plugin')), ['plugin.json'])
  })

  test('.mcp.json merges every mcps/<slug>/mcp.json, leaving out a connection with enabled:false', () => {
    const dir = ensureClaudePlugin(shareDir)
    const merged = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> }
    assert.deepEqual(Object.keys(merged.mcpServers).sort(), ['other', 'tether-bridge'])
    assert.deepEqual(merged.mcpServers['tether-bridge'], server('bridge'))
    assert.deepEqual(mergedMcpServers(shareDir), merged.mcpServers)
  })

  test("skills/ holds the loose skills and each MCP's own, as links to the real folders", () => {
    const dir = ensureClaudePlugin(shareDir)
    assert.deepEqual(readdirSync(join(dir, 'skills')).sort(), ['browse', 'tether-faults'])
    for (const [name, src] of [['tether-faults', join(root, 'feat-a', 'skills', 'tether-faults')], ['browse', join(root, 'feat-a', 'mcps', 'tether-bridge', 'skills', 'browse')]] as const) {
      const p = join(dir, 'skills', name)
      assert.ok(lstatSync(p).isSymbolicLink(), `${name} linked`)
      assert.equal(realpathSync(p).toLowerCase(), realpathSync(src).toLowerCase())
      assert.ok(existsSync(join(p, 'SKILL.md')))
    }
  })

  test('the plan gains --plugin-dir <share>/claude-plugin last; the rest is kept and the input not mutated', () => {
    const input = plan()
    const out = withClaudePlugin(input, shareDir)
    assert.deepEqual(out.args, [...input.args, PLUGIN_DIR_FLAG, join(shareDir, CLAUDE_PLUGIN_DIR)])
    assert.deepEqual(input, plan())
    assert.equal(claudeAgent.share?.inject(plan(), shareDir).args.at(-2), PLUGIN_DIR_FLAG, 'the claude contribution uses it')
    assert.ok(!out.args.includes('--mcp-config'))
  })

  test('idempotent: a second launch rewrites nothing (same mtimes)', () => {
    const dir = ensureClaudePlugin(shareDir)
    const stamp = (f: string): number => lstatSync(join(dir, f)).mtimeMs
    const before = [stamp('.mcp.json'), stamp(join('.claude-plugin', 'plugin.json'))]
    ensureClaudePlugin(shareDir)
    assert.deepEqual([stamp('.mcp.json'), stamp(join('.claude-plugin', 'plugin.json'))], before)
  })
})

describe('Soul: the share folder as -S', () => {
  test('-S <folder> appended', () => {
    const out = withSharedFolder(plan(['/x/cli.js', '-g']), 'C:\\h\\share\\bridge')
    assert.deepEqual(out.args, ['/x/cli.js', '-g', '-S', 'C:\\h\\share\\bridge'])
  })
  test('the contribution: -S <share>/soul and --mcp-config <share>/soul.mcp.json, before a `--`', () => {
    const out = soulAgent.share!.inject(plan(['-g', '--', 'oi']), shareDir)
    assert.deepEqual(out.args, ['-g', '-S', join(shareDir, SOUL_VIEW_DIR), '--mcp-config', join(shareDir, SOUL_MCP_FILE), '--', 'oi'])
  })
  test("the soul's view: real copies of every skill (no link: soul-sdk refuses one resolving outside skills/), the merged servers", () => {
    const { viewDir, mcpFile } = ensureSoulView(shareDir)
    assert.deepEqual(readdirSync(join(viewDir, 'skills')).sort(), ['browse', 'tether-faults'])
    for (const name of ['browse', 'tether-faults']) {
      const p = join(viewDir, 'skills', name)
      assert.ok(!lstatSync(p).isSymbolicLink() && lstatSync(p).isDirectory(), `${name}: a real folder`)
      assert.ok(!lstatSync(join(p, 'SKILL.md')).isSymbolicLink())
    }
    assert.deepEqual(Object.keys((JSON.parse(readFileSync(mcpFile!, 'utf8')) as { mcpServers: object }).mcpServers).sort(), ['other', 'tether-bridge'])
    // A skill edited at its source reaches the copy at the next launch.
    writeFileSync(join(root, 'feat-a', 'skills', 'tether-faults', 'SKILL.md'), '---\nname: tether-faults\n---\nv2\n')
    ensureSoulView(shareDir)
    assert.match(readFileSync(join(viewDir, 'skills', 'tether-faults', 'SKILL.md'), 'utf8'), /v2/)
  })
  test('before a `--` (after it every word is the prompt)', () => {
    assert.deepEqual(withSharedFolder(plan(['-g', '--', 'fix', '-S']), 'D:\\s').args, ['-g', '-S', 'D:\\s', '--', 'fix', '-S'])
  })
  test('SOUL_CLI_SHARED_FOLDERS is spelled out as -S first when no -S was typed (a typed -S replaces the list)', () => {
    const env = { [ENV_SOUL_SHARED]: 'C:\\one; C:\\two' }
    assert.deepEqual(withSharedFolder(plan(['-g'], env), 'D:\\s', 'win32').args, ['-g', '-S', 'C:\\one', '-S', 'C:\\two', '-S', 'D:\\s'])
    assert.deepEqual(withSharedFolder(plan(['-S', 'E:\\mine'], env), 'D:\\s', 'win32').args, ['-S', 'E:\\mine', '-S', 'D:\\s'])
    assert.deepEqual(withSharedFolder(plan(['--shared-folder=E:\\mine'], env), 'D:\\s', 'win32').args, ['--shared-folder=E:\\mine', '-S', 'D:\\s'])
    assert.deepEqual(withSharedFolder(plan([], { [ENV_SOUL_SHARED]: '/a:/b' }), '/s', 'linux').args, ['-S', '/a', '-S', '/b', '-S', '/s'])
  })
})
