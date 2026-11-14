// The vendored bundles (extensions/browser/vendor, extensions/web-bridge/vendor) are checked against sha256 manifests made
// over the bytes the build wrote; a line-ending conversion on checkout changes those bytes and the audit refuses the bundle
// (the daemon then never loads it). Every tracked file under them is either `-text` in .gitattributes (`git check-attr text`
// answers `unset`) or one git itself sees as binary (no attribute, index content `-text` in `git ls-files --eol`: the icons).
// Skipped outside a git checkout (an exported tree has no attributes to check).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const git = (args: string[], input?: string) => spawnSync('git', args, { cwd: root, encoding: 'utf8', input, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
const VENDORS = ['extensions/browser/vendor', 'extensions/web-bridge/vendor']

test('no vendored file is subject to line-ending conversion', t => {
  const files = git(['ls-files', '-z', '--', ...VENDORS])
  if (files.status !== 0) { t.skip('not a git checkout'); return }
  const list = files.stdout.split('\0').filter(Boolean)
  assert.ok(list.length > 100, `the vendors are tracked (${list.length} files)`)
  const attrs = git(['check-attr', '-z', '--stdin', 'text'], list.join('\0'))
  assert.equal(attrs.status, 0, attrs.stderr)
  const text = new Map<string, string>()
  const parts = attrs.stdout.split('\0') // path NUL attribute NUL value NUL, repeated
  for (let i = 0; i + 2 < parts.length; i += 3) text.set(parts[i]!, parts[i + 2]!)
  // `git ls-files --eol`: "i/<index eol> w/<worktree eol> attr/<attrs> \t<path>"; `i/-text` = git sees binary content.
  const binary = new Set<string>()
  for (const line of git(['ls-files', '--eol', '--', ...VENDORS]).stdout.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab > 0 && /^i\/-text\s/.test(line)) binary.add(line.slice(tab + 1))
  }
  const converted = list.filter(f => text.get(f) !== 'unset' && !(text.get(f) === 'unspecified' && binary.has(f))).map(f => `${f}: text=${text.get(f)}`)
  assert.deepEqual(converted, [], 'mark them -text in .gitattributes')
})
