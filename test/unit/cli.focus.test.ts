// `tether link` / `tether focus` (src/cli/focus.ts) and the pane's own environment (src/core/tab-env.ts).
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { noteUrl, parseTetherUrl } from '../../app/shared/tether-url.ts'
import { focusTarget, ownTabUrl } from '../../src/cli/focus.ts'
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

  test('every terminal gets its slot, link and opening folder, over the profile', () => {
    const plan = withTabEnv({ command: 'x', args: [], cwd: 'C:/w', env: { TETHER_TAB_URL: 'tether://tab/forged', KEEP: '1' } } as never, { slotId: '1a2b3c4d', cwd: 'C:/open' })
    assert.equal(plan.env.KEEP, '1')
    assert.equal(plan.env.TETHER_SLOT_ID, '1a2b3c4d')
    assert.deepEqual(parseTetherUrl(plan.env.TETHER_TAB_URL!), { kind: 'tab', id: '1a2b3c4d' })
    assert.equal(plan.env.TETHER_OPEN_CWD, 'C:/open')
    assert.ok(existsSync(plan.env.TETHER_CLI!), 'TETHER_CLI is the real CLI script')
  })
})
