// The command registry (app/renderer/commands.ts) and the app's command list (app/renderer/app-commands.ts):
// stable ids, one command per chord, availability rules, recents, and the ≡ menu naming only commands that exist.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appCommands, type CommandHost } from '../../app/renderer/app-commands.ts'
import { CommandRegistry, isCommandId, RECENT_LIMIT, type Command, type CommandContext } from '../../app/renderer/commands.ts'
import { chordLabel, chordOn, SHORTCUTS } from '../../app/renderer/shortcuts.ts'

const CTX: CommandContext = { pane: true, desks: 3, drawerOpen: false, focus: 'terminal' }

function stubHost(calls: string[]): CommandHost {
  const log = (name: string) => (...args: unknown[]): void => { calls.push([name, ...args.map(a => JSON.stringify(a))].join(' ')) }
  return {
    newPanel: log('newPanel'), duplicateActive: log('duplicateActive'), activePane: () => 'slot-1',
    renamePane: log('renamePane'), switchProfile: log('switchProfile'), toggleDetails: log('toggleDetails'),
    copyFolder: log('copyFolder'), openFolder: log('openFolder'), movePane: log('movePane'), closePane: log('closePane'),
    createDesk: log('createDesk'), cycleDesk: log('cycleDesk'), goToDesk: log('goToDesk'), deskActions: log('deskActions'), closeDesk: log('closeDesk'),
    toggleDrawer: log('toggleDrawer'), quickShell: log('quickShell'),
    setTheme: log('setTheme'), toggleDeskLine: log('toggleDeskLine'), openTerminalTheme: log('openTerminalTheme'), fontSize: log('fontSize'),
    openProfiles: log('openProfiles'), restoreConfirmations: log('restoreConfirmations'), closeWindow: log('closeWindow'), quitAll: log('quitAll'),
    restartDaemon: log('restartDaemon'), showPalette: log('showPalette'),
  }
}

describe('command registry', () => {
  const cmd = (id: string, extra: Partial<Command> = {}): Command => ({ id, title: id, run: () => {}, ...extra })

  test('ids are dotted and lowercase; a duplicate or malformed id is refused', () => {
    assert.ok(isCommandId('pane.new'))
    assert.ok(isCommandId('desk.go.3'))
    assert.ok(!isCommandId('pane'))
    assert.ok(!isCommandId('Pane.New'))
    assert.ok(!isCommandId('pane..new'))
    const r = new CommandRegistry(() => CTX)
    r.register(cmd('a.b'))
    assert.throws(() => r.register(cmd('a.b')), /twice/)
    assert.throws(() => r.register(cmd('bad')), /malformed/)
  })

  test('register returns the function that removes exactly those commands (the editor injects and withdraws its own)', () => {
    const r = new CommandRegistry(() => CTX)
    r.register(cmd('app.one'))
    const off = r.register(cmd('editor.copy-line'), cmd('editor.move-line'))
    assert.deepEqual(r.all().map(c => c.id), ['app.one', 'editor.copy-line', 'editor.move-line'])
    off()
    assert.deepEqual(r.all().map(c => c.id), ['app.one'])
    off() // idempotent
    assert.deepEqual(r.all().map(c => c.id), ['app.one'])
  })

  test('when: unavailable commands are hidden from `available`, and `run` reports it without running', async () => {
    const ran: string[] = []
    let ctx: CommandContext = { ...CTX, pane: false }
    const r = new CommandRegistry(() => ctx)
    r.register(cmd('pane.close', { when: c => c.pane, run: () => { ran.push('close') } }), cmd('desk.new', { run: () => { ran.push('new') } }))
    assert.deepEqual(r.available().map(c => c.id), ['desk.new'])
    assert.equal(await r.run('pane.close'), 'unavailable')
    assert.equal(await r.run('nope.nope'), 'unknown')
    assert.equal(await r.run('desk.new'), 'ran')
    ctx = { ...ctx, pane: true }
    assert.equal(await r.run('pane.close'), 'ran')
    assert.deepEqual(ran, ['new', 'close'])
  })

  test('byShortcut finds the command of a shortcut op, payload included; hint reads the chord table', () => {
    const r = new CommandRegistry(() => CTX)
    r.register(
      cmd('pane.duplicate.pane.right', { shortcut: { op: 'duplicate', level: 'pane', direction: 'right' } }),
      cmd('pane.duplicate.pane.below', { shortcut: { op: 'duplicate', level: 'pane', direction: 'below' } }),
      cmd('window.close', { displayChord: { mod: true, shift: true, code: 'KeyW' } }),
      cmd('plain.one'),
    )
    assert.equal(r.byShortcut({ op: 'duplicate', level: 'pane', direction: 'below' })?.id, 'pane.duplicate.pane.below')
    assert.equal(r.byShortcut({ op: 'duplicate', level: 'frame', direction: 'below' }), undefined)
    assert.equal(r.hint('pane.duplicate.pane.right', false), 'Ctrl+Alt+→')
    assert.equal(r.hint('pane.duplicate.pane.right', true), '⌥⌘→')
    assert.equal(r.hint('window.close', false), 'Ctrl+Shift+W', 'display-only chord')
    assert.equal(r.hint('plain.one'), '')
  })

  test('recents: only palette runs count, most recent first, no duplicates, capped, persisted through the store', async () => {
    const saved: string[][] = []
    const r = new CommandRegistry(() => CTX, { load: () => ['b.b', 'a.a'], save: ids => { saved.push([...ids]) } })
    for (const id of ['a.a', 'b.b', 'c.c', 'd.d']) r.register(cmd(id))
    assert.deepEqual(r.recents(), ['b.b', 'a.a'], 'loaded from the store')
    await r.run('c.c', 'key')
    assert.deepEqual(r.recents(), ['b.b', 'a.a'], 'a chord does not touch the list')
    await r.run('a.a', 'palette')
    assert.deepEqual(r.recents(), ['a.a', 'b.b'])
    await r.run('d.d', 'palette')
    assert.deepEqual(r.recents(), ['d.d', 'a.a', 'b.b'])
    assert.deepEqual(saved[saved.length - 1], ['d.d', 'a.a', 'b.b'])
    for (let i = 0; i < RECENT_LIMIT + 3; i++) { r.register(cmd(`x.n${i}`)); await r.run(`x.n${i}`, 'palette') }
    assert.equal(r.recents().length, RECENT_LIMIT)
  })
})

describe('the app commands', () => {
  const calls: string[] = []
  const list = appCommands(stubHost(calls))
  const byId = new Map(list.map(c => [c.id, c]))

  test('well-formed, unique ids; every title is for a person (non-empty, no id leaking)', () => {
    const ids = list.map(c => c.id)
    assert.equal(new Set(ids).size, ids.length, 'unique ids')
    for (const c of list) {
      assert.ok(isCommandId(c.id), c.id)
      assert.ok(c.title.trim().length > 0, `${c.id} has a title`)
      assert.ok(!/\w+\.\w+/.test(c.title) || /…$/.test(c.title), `${c.id}: the title reads like text: ${c.title}`)
    }
  })

  test('every chord of the shortcut table reaches exactly one command (no orphan key, no two commands on one op)', () => {
    const r = new CommandRegistry(() => CTX)
    r.register(...list)
    for (const mac of [false, true]) {
      for (const e of SHORTCUTS) {
        const chord = chordOn(e, mac)
        if (!chord) continue
        const owners = list.filter(c => c.shortcut && r.byShortcut(e.command) === c)
        assert.equal(owners.length, 1, `${chordLabel(chord, mac)} → ${owners.map(c => c.id).join(', ') || 'nobody'}`)
      }
    }
  })

  test('the key commands exist with the ids the CLI and the palette will use', () => {
    for (const id of ['pane.new', 'pane.duplicate.pane.right', 'pane.close', 'desk.new', 'desk.next', 'desk.previous', 'desk.go.1', 'desk.go.9', 'drawer.toggle', 'theme.dark', 'theme.light', 'theme.auto', 'font.increase', 'palette.show', 'palette.quick-open', 'app.quit-all', 'window.close']) {
      assert.ok(byId.has(id), id)
    }
    assert.equal(byId.get('palette.show')!.shortcut?.op, 'palette')
    assert.equal(byId.get('palette.quick-open')!.shortcut?.op, 'quick-open')
    assert.equal(byId.get('drawer.toggle')!.ignoreRepeat, true, 'a held Ctrl+` is one toggle')
    assert.equal(byId.get('app.quit-all')!.danger, true)
  })

  test('availability: pane commands need a pane, desk.go.N needs N desks, desk.close needs two desks, desk moves wait for the drawer', () => {
    const r = new CommandRegistry(() => CTX)
    r.register(...list)
    const avail = (ctx: CommandContext) => new Set(r.available(ctx).map(c => c.id))
    const noPane = avail({ pane: false, desks: 1, drawerOpen: false, focus: 'none' })
    for (const id of ['pane.close', 'pane.rename', 'pane.move', 'pane.duplicate.pane.right', 'pane.switch-profile', 'pane.details']) assert.ok(!noPane.has(id), `${id} hidden without a pane`)
    assert.ok(noPane.has('pane.new'), 'a new pane is always possible')
    assert.ok(!noPane.has('desk.close'), 'the last desk cannot be closed')
    assert.ok(!noPane.has('desk.go.2'), 'no second desk to go to')
    assert.ok(!noPane.has('desk.next'), 'nothing to cycle with one desk')
    const three = avail({ pane: true, desks: 3, drawerOpen: false, focus: 'terminal' })
    for (const id of ['desk.go.1', 'desk.go.2', 'desk.go.3', 'desk.close', 'desk.next', 'pane.close']) assert.ok(three.has(id), id)
    assert.ok(!three.has('desk.go.4'))
    const drawer = avail({ pane: true, desks: 3, drawerOpen: true, focus: 'terminal' })
    for (const id of ['desk.next', 'desk.go.1', 'desk.new']) assert.ok(!drawer.has(id), `${id} waits while the drawer is open`)
    assert.ok(drawer.has('drawer.toggle'))
  })

  test('running goes to the host with the payload (duplicate target, desk position, theme)', async () => {
    calls.length = 0
    const r = new CommandRegistry(() => CTX)
    r.register(...list)
    await r.run('pane.duplicate.frame.below')
    await r.run('desk.go.3')
    await r.run('theme.dark')
    await r.run('pane.close')
    await r.run('palette.quick-open')
    assert.deepEqual(calls, ['duplicateActive {"level":"frame","placement":"below"}', 'goToDesk 3', 'setTheme "dark"', 'closePane "slot-1"', 'showPalette "quick-open"'])
  })

  test('the ≡ menu (index.html) names only commands that exist', () => {
    const html = readFileSync(join(import.meta.dirname, '..', '..', 'app', 'renderer', 'index.html'), 'utf8')
    const named = [...html.matchAll(/data-command="([^"]+)"/g)].map(m => m[1]!)
    assert.ok(named.length >= 20, `menu items found: ${named.length}`)
    for (const id of named) assert.ok(byId.has(id), `menu item without a command: ${id}`)
    assert.ok(named.includes('palette.show'), 'the palette is reachable from the menu')
  })
})

describe('the app commands and the icon set', () => {
  test('every icon a command names exists in icons.ts (read as text: icons.ts pulls the SVG assets)', () => {
    const src = readFileSync(join(import.meta.dirname, '..', '..', 'app', 'renderer', 'icons.ts'), 'utf8')
    const names = new Set([...src.matchAll(/^\s+(?:'([a-z-]+)'|([a-z]+))(?::\s*\w+)?,\s*$/gm)].map(m => m[1] ?? m[2]!))
    assert.ok(names.has('plus') && names.has('magnifying-glass'), `icons.ts parsed: ${names.size} names`)
    for (const c of appCommands(stubHost([]))) if (c.icon) assert.ok(names.has(c.icon), `${c.id}: icon "${c.icon}" is not in icons.ts`)
  })
})
