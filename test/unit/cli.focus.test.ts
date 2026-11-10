// `tether link` / `tether focus` (src/cli/focus.ts) and the pane's own environment (src/core/tab-env.ts).
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { noteUrl, parseTetherUrl } from '../../app/shared/tether-url.ts'
import { focusLink, focusTarget, ownTabUrl, parseFocusArgs } from '../../src/cli/focus.ts'
import { withTabEnv } from '../../src/core/tab-env.ts'

const dir = mkdtempSync(join(tmpdir(), 'tether-focus-'))
after(() => rmSync(dir, { recursive: true, force: true }))
mkdirSync(join(dir, 'open', '.tether', 'notes'), { recursive: true })
mkdirSync(join(dir, 'moved'))
writeFileSync(join(dir, 'open', '.tether', 'notes', 'todo.md'), '# t')
writeFileSync(join(dir, 'moved', 'here.md'), '# h')
const env = { TETHER_TAB_URL: 'tether://tab/1a2b3c4d', TETHER_OPEN_CWD: join(dir, 'open') }

describe('tether link / focus', () => {
  test('a pane knows its own link; outside tether it is an error', () => {
    assert.equal(ownTabUrl(env), 'tether://tab/1a2b3c4d')
    assert.throws(() => ownTabUrl({}), /não é um painel do tether/)
  })

  test('focus: nothing is this pane; a link as is; a bad link refused', () => {
    assert.equal(focusTarget(undefined, env), 'tether://tab/1a2b3c4d')
    assert.equal(focusTarget('tether://tab/ffff0000', env), 'tether://tab/ffff0000')
    assert.throws(() => focusTarget('tether://run/x', env), /link inválido/)
  })

  test('focus: a file is read against the OPENING folder first, then the current one', () => {
    assert.equal(focusTarget('.tether/notes/todo.md', env, join(dir, 'moved')), noteUrl(join(dir, 'open', '.tether', 'notes', 'todo.md')))
    assert.equal(focusTarget('here.md', env, join(dir, 'moved')), noteUrl(join(dir, 'moved', 'here.md')))
    assert.throws(() => focusTarget('nope.md', env, join(dir, 'moved')), /não encontrado/)
  })

  test('focus --pad: the option, its optional scope and --slot', () => {
    assert.deepEqual(parseFocusArgs(['todo.md']), { target: 'todo.md' })
    assert.deepEqual(parseFocusArgs(['todo.md', '--pad']), { target: 'todo.md', pad: 'panel' })
    assert.deepEqual(parseFocusArgs(['--pad', 'todo.md']), { target: 'todo.md', pad: 'panel' })
    assert.deepEqual(parseFocusArgs(['todo.md', '--pad', 'desk']), { target: 'todo.md', pad: 'desk' })
    assert.deepEqual(parseFocusArgs(['todo.md', '--pad=global']), { target: 'todo.md', pad: 'global' })
    assert.deepEqual(parseFocusArgs(['todo.md', '--pad', '--slot', 'ab12']), { target: 'todo.md', pad: 'panel', slot: 'ab12' })
    assert.throws(() => parseFocusArgs(['todo.md', '--pad=gaveta']), /panel, desk ou global/)
    assert.throws(() => parseFocusArgs(['todo.md', '--slot', 'ab12']), /só vale junto de --pad/)
    assert.throws(() => parseFocusArgs(['a.md', 'b.md']), /um só/)
    assert.throws(() => parseFocusArgs(['--nope']), /desconhecida/)
  })

  test('focus --pad: the link names the pad and this terminal\'s slot', () => {
    const file = join(dir, 'open', '.tether', 'notes', 'todo.md')
    const withSlot = { ...env, TETHER_SLOT_ID: '1a2b3c4d' }
    assert.equal(focusLink(parseFocusArgs([file]), withSlot), noteUrl(file))
    assert.deepEqual(parseTetherUrl(focusLink(parseFocusArgs([file, '--pad']), withSlot)), { kind: 'note', path: file, pad: { scope: 'panel', slot: '1a2b3c4d' } })
    assert.deepEqual(parseTetherUrl(focusLink(parseFocusArgs([file, '--pad', '--slot', 'ffff0000']), withSlot)), { kind: 'note', path: file, pad: { scope: 'panel', slot: 'ffff0000' } })
    assert.deepEqual(parseTetherUrl(focusLink(parseFocusArgs([file, '--pad=desk']), withSlot)), { kind: 'note', path: file, pad: { scope: 'desk', slot: '1a2b3c4d' } })
    assert.deepEqual(parseTetherUrl(focusLink(parseFocusArgs([file, '--pad=global']), env)), { kind: 'note', path: file, pad: { scope: 'global' } })
  })

  test('focus --pad: the panel pad needs a slot; only a file goes into a pad', () => {
    const file = join(dir, 'open', '.tether', 'notes', 'todo.md')
    assert.throws(() => focusLink(parseFocusArgs([file, '--pad']), env), /de qual painel/)
    assert.throws(() => focusLink(parseFocusArgs(['--pad']), { ...env, TETHER_SLOT_ID: '1a2b3c4d' }), /vale para um arquivo/)
    assert.throws(() => focusLink(parseFocusArgs(['tether://tab/ffff0000', '--pad']), { ...env, TETHER_SLOT_ID: '1a2b3c4d' }), /vale para um arquivo/)
    assert.throws(() => focusLink(parseFocusArgs([file, '--pad', '--slot', 'a b']), env), /id de painel inválido/)
  })

  test('every terminal gets its slot, link and opening folder, over the profile', () => {
    const plan = withTabEnv({ command: 'x', args: [], cwd: 'C:/w', env: { TETHER_TAB_URL: 'tether://tab/forged', KEEP: '1' } } as never, { slotId: '1a2b3c4d', cwd: 'C:/open' })
    assert.equal(plan.env.KEEP, '1')
    assert.equal(plan.env.TETHER_SLOT_ID, '1a2b3c4d')
    assert.deepEqual(parseTetherUrl(plan.env.TETHER_TAB_URL!), { kind: 'tab', id: '1a2b3c4d' })
    assert.equal(plan.env.TETHER_OPEN_CWD, 'C:/open')
    assert.ok(existsSync(plan.env.TETHER_CLI!), 'TETHER_CLI is the real CLI script')
  })
})
