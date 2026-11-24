// The peek card's rules (app/renderer/peek-rules.ts), pure: where a peek goes, who owns Esc in the card, the header and
// foot texts; and the chord that closes the card.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { closeTip, lentNotice, PEEK_CLOSE_COMMAND, peekEscAction, peekFoot, peekHeader, peekKeeps, peekLabel, peekMenuPlan, peekOpenButton, peekRoute, tabInView } from '../../app/renderer/peek-rules.ts'
import { DOUBLE_ESC_MS } from '../../app/renderer/drawer-rules.ts'
import { shortcutHint } from '../../app/renderer/shortcuts.ts'

describe('where a peek goes', () => {
  test('a live slot without a tab opens the card', () => {
    for (const status of ['running', 'starting', 'queued'] as const) assert.equal(peekRoute({ status }, false), 'card', status)
  })
  test('a slot with a tab goes to its tab, live or not', () => {
    assert.equal(peekRoute({ status: 'running' }, true), 'reveal')
    assert.equal(peekRoute({ status: 'exited' }, true), 'reveal')
  })
  test('an unknown slot, or an ended one without a tab, goes nowhere', () => {
    assert.equal(peekRoute(undefined, false), 'none')
    assert.equal(peekRoute({ status: 'exited' }, false), 'none')
  })
  test('a live slot whose tab is not in view: the card borrows the tab\'s terminal', () => {
    for (const status of ['running', 'starting', 'queued'] as const) assert.equal(peekRoute({ status }, true, false), 'lend', status)
  })
  test('a tab in view only gets the keyboard; an ended slot with a tab out of view still goes to its tab', () => {
    assert.equal(peekRoute({ status: 'running' }, true, true), 'reveal')
    assert.equal(peekRoute({ status: 'exited' }, true, false), 'reveal')
    assert.equal(peekRoute({ status: 'error' }, true, false), 'reveal')
  })
  test('without a tab, "in view" does not count', () => {
    assert.equal(peekRoute({ status: 'running' }, false, false), 'card')
    assert.equal(peekRoute({ status: 'running' }, false, true), 'card')
  })
})

describe('whether a tab is in view', () => {
  const shown = { inDrawer: false, placeShown: true, activeInFrame: true, drawerOpen: false }
  test('the active tab of a frame on the active desk, drawer closed', () => {
    assert.equal(tabInView(shown), true)
  })
  test('another desk (or a closed pad), a background tab: not in view', () => {
    assert.equal(tabInView({ ...shown, placeShown: false }), false)
    assert.equal(tabInView({ ...shown, activeInFrame: false }), false)
  })
  test('the open drawer covers the desks and pads, not its own tabs', () => {
    assert.equal(tabInView({ ...shown, drawerOpen: true }), false)
    assert.equal(tabInView({ ...shown, inDrawer: true, drawerOpen: true }), true)
    assert.equal(tabInView({ ...shown, inDrawer: true, drawerOpen: true, activeInFrame: false }), false)
  })
  test('the closed drawer: its tabs are out of view', () => {
    assert.equal(tabInView({ ...shown, inDrawer: true, placeShown: false }), false)
  })
})

describe('a slot with a tab in the card', () => {
  test('the main button is "Ir para a guia", secondary and without the ▾', () => {
    assert.deepEqual(peekOpenButton(true), { action: 'go-tab', label: 'Ir para a guia', title: 'Ir para a guia: fecha o cartão, devolve o terminal à guia e mostra a guia', icon: 'arrow-square-out', primary: false, split: false })
    const own = peekOpenButton(false)
    assert.equal(own.label, 'Abrir nesta mesa')
    assert.equal(own.primary, true)
    assert.equal(own.split, true)
  })
  test('the "⋯" has "Ir para a guia" in place of the two ways of opening', () => {
    const plan = peekMenuPlan('Ctrl+Shift+O', false, true)
    assert.deepEqual(plan.map(i => i.label), ['Ir para a guia', 'Copiar link do painel', 'Fechar'])
    assert.deepEqual(plan.map(i => i.action), ['go-tab', 'copy-link', 'close'])
    assert.equal(plan.some(i => i.submenu), false)
  })
  test('the tab says who is being peeked, with no buttons (the card covers them)', () => {
    const n = lentNotice('claude · nic')
    assert.equal(n.title, 'claude · nic está sendo espiado')
    assert.equal(n.text, 'O terminal dele está no cartão aberto na tela. Quando você fechar o cartão, ele volta para cá.')
    assert.deepEqual(Object.keys(n).sort(), ['text', 'tip', 'title'])
  })
})

describe('Esc inside the card', () => {
  const base = { blocked: false, now: 10_000, lastEsc: undefined }
  test("an agent's terminal never gives Esc away (Claude interrupts with it), not even twice", () => {
    for (const kind of ['claude', 'soul', 'codex'] as const) {
      assert.equal(peekEscAction({ ...base, focus: { in: 'terminal', kind, programOwnsScreen: false } }), 'pass', kind)
      assert.equal(peekEscAction({ ...base, lastEsc: 9_900, focus: { in: 'terminal', kind, programOwnsScreen: false } }), 'pass', `${kind} twice`)
    }
  })
  test('a shell at its prompt: the first Esc arms, a second within the window closes, a late one arms again', () => {
    const shell = { in: 'terminal' as const, kind: 'shell' as const, programOwnsScreen: false }
    assert.equal(peekEscAction({ ...base, focus: shell }), 'arm')
    assert.equal(peekEscAction({ ...base, lastEsc: base.now - DOUBLE_ESC_MS, focus: shell }), 'close')
    assert.equal(peekEscAction({ ...base, lastEsc: base.now - DOUBLE_ESC_MS - 1, focus: shell }), 'arm')
  })
  test('a shell running a full-screen program (vim, less) keeps Esc', () => {
    assert.equal(peekEscAction({ ...base, lastEsc: 9_900, focus: { in: 'terminal', kind: 'shell', programOwnsScreen: true } }), 'pass')
  })
  test("outside the terminal (the card's header) Esc closes; a dialog or menu up keeps its own", () => {
    assert.equal(peekEscAction({ ...base, focus: { in: 'chrome' } }), 'close')
    assert.equal(peekEscAction({ ...base, blocked: true, focus: { in: 'chrome' } }), 'pass')
  })
})

describe('texts', () => {
  const now = Date.parse('2026-11-24T12:00:00Z')
  test("the header: the tab's name and the sessions menu's state line", () => {
    const busy = peekHeader({ slotId: 's', cwd: 'C:/obra/bancada', status: 'running', kind: 'claude', turn: 'busy', name: 'conferente' }, now)
    assert.deepEqual(busy, { title: 'conferente', state: 'busy', text: 'trabalhando agora' })
    const idle = peekHeader({ slotId: 's', cwd: 'C:/obra/bancada', status: 'running', kind: 'shell', idleSince: new Date(now - 2 * 3_600_000).toISOString() }, now)
    assert.deepEqual(idle, { title: 'bancada', state: 'idle', text: 'ocioso há 2 h' })
    assert.equal(peekHeader({ slotId: 's', cwd: 'C:/x', status: 'running', attention: 'waiting' }, now).text, 'pede atenção')
    assert.equal(peekHeader({ slotId: 's', cwd: 'C:/x', status: 'exited' }, now).state, 'ended')
  })
  test('the ✕ tip carries the key; the label names the slot', () => {
    assert.equal(closeTip('Ctrl+Shift+O'), 'Fechar (Ctrl+Shift+O)')
    assert.equal(closeTip(''), 'Fechar')
    assert.equal(peekLabel('conferente'), 'Espiando conferente')
  })
  test("the foot: how to close, and for an agent that Esc stays with the agent; one short line", () => {
    assert.equal(peekFoot('claude', 'Ctrl+Shift+O', false), 'Fechar: ✕ ou Ctrl+Shift+O. O Esc fica com o agente.')
    assert.equal(peekFoot('claude', '', false), 'Fechar: ✕. O Esc fica com o agente.')
    assert.equal(peekFoot('shell', 'Ctrl+Shift+O', false), 'Fechar: ✕, Ctrl+Shift+O ou Esc duas vezes.')
    assert.equal(peekFoot('shell', '', false), 'Fechar: ✕ ou Esc duas vezes.')
    assert.equal(peekFoot('claude', 'Ctrl+Shift+O', true), 'Sessão encerrada. Fechar: ✕ ou Ctrl+Shift+O.')
    for (const kind of ['claude', 'soul', 'codex', 'shell'] as const) assert.ok(peekFoot(kind, 'Ctrl+Shift+O', false).length <= 60, kind)
  })
  test('with the card open only the palette and the card\'s own close keep their chords', () => {
    assert.equal(peekKeeps(PEEK_CLOSE_COMMAND), true)
    assert.equal(peekKeeps('palette.show'), true)
    for (const c of ['pane.next-tab', 'desk.next', 'desk.go.2', 'drawer.toggle', 'pane.close', 'palette.quick-open', 'app.quit-all']) assert.equal(peekKeeps(c), false, c)
  })
})

describe('the card\'s "⋯" menu', () => {
  test('open here, open elsewhere, copy the link, then close with the chord at the right', () => {
    const plan = peekMenuPlan('Ctrl+Shift+O', false)
    assert.deepEqual(plan.map(i => i.label), ['Abrir nesta mesa', 'Abrir em outra mesa', 'Copiar link do painel', 'Fechar'])
    assert.deepEqual(plan.filter(i => i.submenu).map(i => i.action), ['open-other'])
    const close = plan.find(i => i.action === 'close')!
    assert.equal(close.sepBefore, true)
    assert.equal(close.trail, 'Ctrl+Shift+O')
  })
  test('no chord, no hint; an ended session cannot be opened from the card', () => {
    assert.equal(peekMenuPlan('', false).find(i => i.action === 'close')!.trail, undefined)
    const ended = peekMenuPlan('', true)
    assert.deepEqual(ended.filter(i => i.disabled).map(i => i.action), ['open-here', 'open-other'])
  })
})

describe('the chord', () => {
  test('Ctrl+Shift+O closes the card (⇧⌘O on the Mac)', () => {
    assert.equal(shortcutHint(PEEK_CLOSE_COMMAND, false), 'Ctrl+Shift+O')
    assert.equal(shortcutHint(PEEK_CLOSE_COMMAND, true), '⇧⌘O')
  })
})
