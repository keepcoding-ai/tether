// The peek card's rules (app/renderer/peek-rules.ts), pure: where a peek goes, who owns Esc in the card, the header and
// foot texts; and the chord that closes the card.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  backButton, closeTip, DOCK_KEEP_BELOW, DOCK_MARGIN, DOCK_MAX_HEIGHT, DOCK_MAX_WIDTH, DOCK_MIN_HEIGHT, DOCK_MIN_WIDTH, DOCK_WIDTH_SHARE, dockedBox, lentNotice, PEEK_CLOSE_COMMAND,
  PEEK_SCREEN_COMMANDS, paneCardFoot, paneCardHead, paneRefusalText, paneRoute, peekDismiss, peekEscAction, peekFoot, peekHeader, peekKeeps, peekLabel, peekMenuPlan,
  peekOpenButton, peekRoute, quickEscCloses, screenFoot, screenMenuPlan, screenOpenButton, screenOpenPlan, screenOwns, tabInView, type PaneCardFacts,
  cardHoldsKeys, commandAim, isStructureCommand, paneOwns, PEEK_PANE_COMMANDS, type CommandAimInput,
  CARD_MUTED_CHORDS, cardMutesChord, type ChordPress,
} from '../../app/renderer/peek-rules.ts'
import { shortcutHint } from '../../app/renderer/shortcuts.ts'
import { commandFromContribution, type CommandContext } from '../../app/renderer/commands.ts'

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
    assert.equal(own.primary, false, 'the card\'s main action is "Fechar": opening is secondary')
    assert.equal(own.split, true)
  })
  test('the "⋯" has "Ir para a guia" in place of the two ways of opening', () => {
    const plan = peekMenuPlan('Ctrl+Shift+O', false, true)
    assert.deepEqual(plan.map(i => i.label), ['Ir para a guia', 'Emblema…', 'Copiar link do painel', 'Fechar'])
    assert.deepEqual(plan.map(i => i.action), ['go-tab', 'emblem', 'copy-link', 'close'])
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
  test('in the card\'s terminal Esc is always the program\'s: agent or shell, once or twice, full screen or not', () => {
    for (const kind of ['claude', 'soul', 'codex', 'shell'] as const) {
      for (const programOwnsScreen of [false, true]) {
        assert.equal(peekEscAction({ ...base, focus: { in: 'terminal', kind, programOwnsScreen } }), 'pass', kind)
        assert.equal(peekEscAction({ ...base, lastEsc: 9_900, focus: { in: 'terminal', kind, programOwnsScreen } }), 'pass', `${kind} twice`)
      }
    }
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
  test('the "Fechar" tip carries both keys (as bound); the label names the slot', () => {
    assert.equal(closeTip(['Ctrl+`', 'Ctrl+Shift+O']), 'Fechar (Ctrl+` ou Ctrl+Shift+O)')
    assert.equal(closeTip(['Ctrl+Shift+O']), 'Fechar (Ctrl+Shift+O)')
    assert.equal(closeTip([]), 'Fechar')
    assert.equal(peekLabel('conferente'), 'Espiando conferente')
  })
  test("the foot: how to close, and for an agent that Esc stays with the agent; one short line", () => {
    const both = ['Ctrl+`', 'Ctrl+Shift+O']
    assert.equal(peekFoot('claude', both, false), 'Feche pelo botão, pela margem ou por Ctrl+` ou Ctrl+Shift+O. O Esc fica com o agente.')
    assert.equal(peekFoot('claude', [], false), 'Feche pelo botão ou pela margem. O Esc fica com o agente.')
    assert.equal(peekFoot('shell', ['Ctrl+Shift+O'], false), 'Feche pelo botão, pela margem ou por Ctrl+Shift+O. O Esc fica com o terminal.')
    assert.equal(peekFoot('claude', both, true), 'Sessão encerrada. Feche pelo botão, pela margem ou por Ctrl+` ou Ctrl+Shift+O.')
    for (const kind of ['claude', 'soul', 'codex', 'shell'] as const) {
      const text = peekFoot(kind, both, false)
      assert.ok(text.length <= 95, kind)
      assert.doesNotMatch(text, /duas vezes/)
    }
  })
  test('with the card open only the palette, the card\'s own close and the drawer\'s toggle (which closes the card) keep their chords', () => {
    assert.equal(peekKeeps(PEEK_CLOSE_COMMAND), true)
    assert.equal(peekKeeps('palette.show'), true)
    assert.equal(peekKeeps('drawer.toggle'), true)
    for (const c of ['pane.next-tab', 'desk.next', 'desk.go.2', 'pane.close', 'palette.quick-open', 'app.quit-all']) assert.equal(peekKeeps(c), false, c)
  })
})

describe('the card\'s "⋯" menu', () => {
  test('open here, open elsewhere, copy the link, then close with the chord at the right', () => {
    const plan = peekMenuPlan('Ctrl+Shift+O', false)
    assert.deepEqual(plan.map(i => i.label), ['Abrir nesta mesa', 'Abrir em outra mesa', 'Copiar link do painel', 'Fechar'])
    assert.deepEqual(plan.filter(i => i.submenu).map(i => i.action), ['open-other'])
    assert.equal(plan.some(i => i.action === 'emblem'), false, 'no tab, no emblem: the emblem is the tab\'s')
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

describe('a system screen in the card', () => {
  test('the commands that open a screen keep their chords with the card open (the screen opens in the card)', () => {
    for (const c of PEEK_SCREEN_COMMANDS) assert.equal(peekKeeps(c), true, c)
    assert.deepEqual([...PEEK_SCREEN_COMMANDS], ['settings.show', 'keybindings.show', 'extensions.show'])
  })
  test("the screen's own commands: true only thanks to the screen's flags", () => {
    const record = (f: ReadonlySet<string>): boolean => f.has('keybindings.screen')
    assert.equal(screenOwns(record, new Set(), ['keybindings.screen']), true)
    assert.equal(screenOwns(record, new Set(['keybindings.screen']), ['keybindings.screen']), false, 'already true without the card: not the card\'s doing')
    assert.equal(screenOwns(record, new Set(), ['settings.screen']), false, 'another screen')
    assert.equal(screenOwns(undefined, new Set(), ['keybindings.screen']), false, 'no rule, nobody\'s own')
    assert.equal(screenOwns(() => true, new Set(), ['keybindings.screen']), false, 'always available: not the screen\'s')
    assert.equal(screenOwns(record, new Set(), []), false)
  })
  test('opening a screen: over an agent it stacks one level; over a screen it replaces; on a closed card it just opens', () => {
    assert.deepEqual(screenOpenPlan('slot'), { under: true, replace: false })
    assert.deepEqual(screenOpenPlan('screen'), { under: false, replace: true })
    assert.deepEqual(screenOpenPlan('none'), { under: false, replace: false })
  })
  test('closing a screen with an agent under it goes back to the agent; anything else closes the card', () => {
    assert.equal(peekDismiss('screen', true), 'back')
    assert.equal(peekDismiss('screen', false), 'close')
    assert.equal(peekDismiss('slot', false), 'close')
    assert.equal(peekDismiss('slot', true), 'close')
  })
  test('the header: "Abrir nesta mesa" secondary with the ▾; the "⋯": open here, open elsewhere, then close with the chord', () => {
    const b = screenOpenButton()
    assert.deepEqual([b.action, b.label, b.primary, b.split], ['open-here', 'Abrir nesta mesa', false, true])
    const plan = screenMenuPlan('Ctrl+Shift+O')
    assert.deepEqual(plan.map(i => i.label), ['Abrir nesta mesa', 'Abrir em outra mesa', 'Fechar'])
    assert.deepEqual(plan.filter(i => i.submenu).map(i => i.action), ['open-other'])
    assert.equal(plan[2]!.sepBefore, true)
    assert.equal(plan[2]!.trail, 'Ctrl+Shift+O')
    assert.equal(screenMenuPlan('')[2]!.trail, undefined)
  })
  test('the back button names the agent; the foot says where closing leads', () => {
    assert.deepEqual(backButton('conferente'), { label: 'conferente', title: 'Voltar para conferente (fechar a tela)', aria: 'Voltar para conferente' })
    assert.equal(screenFoot(['Ctrl+Shift+O']), 'Feche pelo botão, pela margem ou por Ctrl+Shift+O.')
    assert.equal(screenFoot([], 'conferente'), 'Feche pelo botão ou pela margem para voltar a conferente.')
  })
})

describe('the chord', () => {
  test('Ctrl+Shift+O closes the card (⇧⌘O on the Mac)', () => {
    assert.equal(shortcutHint(PEEK_CLOSE_COMMAND, false), 'Ctrl+Shift+O')
    assert.equal(shortcutHint(PEEK_CLOSE_COMMAND, true), '⇧⌘O')
  })
})

describe('the quick view of a pane', () => {
  const facts = (over: Partial<PaneCardFacts> = {}): PaneCardFacts => ({ title: 'plano.md', typeId: 'note', agent: false, place: 'Mesa 2', color: 'teal', asleep: false, deskAsleep: false, ...over })

  test('a tab out of view is lent (a fresh type: a copy); in view it only gets the keyboard; a type that does not lend is refused with its reason', () => {
    for (const plan of ['move', 'custom', 'fresh'] as const) assert.equal(paneRoute({ hasTab: true, inView: false, plan }), 'lend', plan)
    for (const plan of ['move', 'custom', 'none', 'fresh'] as const) assert.equal(paneRoute({ hasTab: true, inView: true, plan }), 'reveal', plan)
    assert.equal(paneRoute({ hasTab: true, inView: false, plan: 'none' }), 'refuse')
  })
  test('without a tab: a live slot keeps the agent\'s own card; anything else goes nowhere', () => {
    assert.equal(paneRoute({ hasTab: false, inView: false, slot: { status: 'running' }, plan: 'none' }), 'slot')
    assert.equal(paneRoute({ hasTab: false, inView: true, slot: { status: 'queued' }, plan: 'none' }), 'slot')
    assert.equal(paneRoute({ hasTab: false, inView: false, slot: { status: 'exited' }, plan: 'none' }), 'none')
    assert.equal(paneRoute({ hasTab: false, inView: false, plan: 'move' }), 'none')
  })
  test('the header is the same for every type: title, the type\'s tag, "em <mesa>" with its colour', () => {
    assert.deepEqual(paneCardHead(facts()), { title: 'plano.md', kind: 'nota', where: 'em Mesa 2', color: 'teal', state: undefined, label: 'Espiando plano.md' })
    assert.equal(paneCardHead(facts({ typeId: 'channel', title: '#obra' })).kind, 'canal')
    assert.equal(paneCardHead(facts({ typeId: 'md-preview' })).kind, 'prévia')
    assert.equal(paneCardHead(facts({ typeId: 'process' })).kind, 'processo')
    assert.equal(paneCardHead(facts({ typeId: 'terminal' })).kind, 'terminal')
    assert.equal(paneCardHead(facts({ typeId: 'terminal', agent: true })).kind, 'agente')
    assert.equal(paneCardHead(facts({ typeId: 'something-new' })).kind, 'guia', 'a type of the future still has a tag')
    assert.equal(paneCardHead(facts({ place: undefined })).where, undefined)
  })
  test('the state: the pane\'s one state, the words of the Regency\'s tree; a free pane that is not an agent\'s has none', () => {
    const agent = (over: Partial<PaneCardFacts>) => paneCardHead(facts({ typeId: 'terminal', agent: true, ...over })).state
    assert.deepEqual(agent({ busy: true }), { text: 'trabalhando', tone: 'busy' })
    assert.deepEqual(agent({ busy: true, asleep: true }), { text: 'dormindo', tone: 'asleep' })
    assert.deepEqual(paneCardHead(facts({ deskAsleep: true })).state, { text: 'dormindo', tone: 'asleep' })
    // the capture r3-cartao-regencia-terminal: a turn just done said "pede atenção" here and nothing waited in the tree
    assert.deepEqual(agent({ attention: 'done' }), { text: 'terminou', tone: 'idle' })
    assert.deepEqual(agent({ attention: 'waiting' }), { text: 'espera você', tone: 'attention' })
    assert.deepEqual(agent({}), { text: 'livre', tone: 'idle' })
    assert.deepEqual(agent({ exited: true }), { text: 'encerrado', tone: 'ended' })
    assert.equal(paneCardHead(facts()).state, undefined, 'a note at rest says nothing')
    assert.deepEqual(paneCardHead(facts({ attention: 'waiting' })).state, { text: 'espera você', tone: 'attention' }, 'a seal waits on any pane')
  })
  test('the foot: "Ir até a guia" always; "Acordar" only while it sleeps (the desk wakes whole); how to close in one line', () => {
    const awake = paneCardFoot(facts(), ['Ctrl+Shift+O'])
    assert.equal(awake.wake, undefined)
    assert.equal(awake.go.label, 'Ir até a guia')
    assert.equal(awake.hint, 'Esc aqui fecha · Ctrl+Shift+O')
    assert.equal(paneCardFoot(facts(), []).hint, 'Esc aqui fecha')
    assert.equal(paneCardFoot(facts({ deskAsleep: true }), [])!.wake?.what, 'desk')
    assert.match(paneCardFoot(facts({ deskAsleep: true }), [])!.wake?.title ?? '', /Mesa 2/)
    assert.equal(paneCardFoot(facts({ asleep: true }), [])!.wake?.what, 'pane')
    assert.equal(paneCardFoot(facts({ asleep: true, deskAsleep: true }), [])!.wake?.what, 'desk')
    assert.equal(paneCardFoot(facts({ asleep: true }), [])!.wake?.label, 'Acordar')
    assert.equal(paneCardFoot(facts({ deskAsleep: true }), [])!.wake?.band, 'Mesa dormindo: o que você vê não está rodando')
    assert.equal(paneCardFoot(facts({ asleep: true }), [])!.wake?.band, 'Guia dormindo: o que você vê não está rodando')
  })
  test('a refusal says why in a sentence', () => {
    assert.equal(paneRefusalText('none'), 'Ainda não dá para espiar este tipo de guia.')
    assert.equal(paneRefusalText('unknown'), 'Esta guia não existe mais.')
    assert.match(paneRefusalText('lent'), /sendo espiada/)
  })
  test('Esc: the content keeps it; modal, the rest closes; docked, only the header, the foot and the row that opened it', () => {
    assert.equal(quickEscCloses(true, 'content'), false)
    assert.equal(quickEscCloses(false, 'content'), false)
    for (const at of ['chrome', 'opener', 'outside'] as const) assert.equal(quickEscCloses(true, at), true, at)
    assert.equal(quickEscCloses(false, 'chrome'), true)
    assert.equal(quickEscCloses(false, 'opener'), true)
    assert.equal(quickEscCloses(false, 'outside'), false, 'an Esc in the conversation stays the conversation\'s')
  })
  test('docked: at the top right of what it sits over, never outside it, the bottom left free', () => {
    const over = { left: 300, top: 40, width: 760, height: 840 }
    const b = dockedBox(over)
    assert.equal(b.top, 40 + DOCK_MARGIN)
    assert.equal(b.left + b.width, 300 + 760 - DOCK_MARGIN, 'flush with the right edge, a margin in')
    assert.equal(b.width, Math.round(760 * DOCK_WIDTH_SHARE))
    assert.equal(b.height, DOCK_MAX_HEIGHT)
    assert.ok(over.top + over.height - (b.top + b.height) >= DOCK_KEEP_BELOW, 'the box of speech stays in view')
    // Wide: the width stops at the ceiling; narrow: the floor, but never wider than the room.
    assert.equal(dockedBox({ left: 0, top: 0, width: 1600, height: 900 }).width, DOCK_MAX_WIDTH)
    assert.equal(dockedBox({ left: 0, top: 0, width: 500, height: 900 }).width, DOCK_MIN_WIDTH)
    const tiny = dockedBox({ left: 10, top: 10, width: 300, height: 300 })
    assert.equal(tiny.width, 300 - 2 * DOCK_MARGIN)
    assert.ok(tiny.left >= 10 && tiny.top >= 10 && tiny.left + tiny.width <= 310 && tiny.top + tiny.height <= 310, JSON.stringify(tiny))
    assert.equal(tiny.height, DOCK_MIN_HEIGHT, 'short: the floor height, the box of speech may be covered')
  })
})

describe('the command target with a tab in the card', () => {
  const aim = (o: Partial<CommandAimInput> & { command: string }): string =>
    commandAim({ lent: true, modal: true, focusInCard: true, key: true, paneOwn: false, ...o })

  test('the card holds the keys only with a lent tab, and with the keyboard in it unless modal', () => {
    assert.equal(cardHoldsKeys({ lent: false, modal: true, focusInCard: true }), false, 'no lent tab (closed, an agent card, a screen)')
    assert.equal(cardHoldsKeys({ lent: true, modal: true, focusInCard: false }), true, 'modal: nothing else takes the keyboard')
    assert.equal(cardHoldsKeys({ lent: true, modal: false, focusInCard: true }), true, 'docked, keyboard in the card')
    assert.equal(cardHoldsKeys({ lent: true, modal: false, focusInCard: false }), false, 'docked, keyboard in the conversation or the tree')
  })

  test('without the card holding the keys every command aims at the desk, as before', () => {
    for (const command of ['note.save', 'pane.close', 'pane.new-tab', 'font.increase', 'desk.next']) {
      assert.equal(aim({ command, lent: false, paneOwn: true }), 'desk', `closed: ${command}`)
      assert.equal(aim({ command, modal: false, focusInCard: false, paneOwn: true }), 'desk', `docked, outside: ${command}`)
    }
  })

  test('the tab\'s own commands and the pane-level ones aim at the card, by chord and by pick', () => {
    assert.equal(aim({ command: 'note.save', paneOwn: true }), 'card')
    assert.equal(aim({ command: 'markdown.preview', paneOwn: true, modal: false }), 'card', 'docked, keyboard in the card')
    for (const command of PEEK_PANE_COMMANDS) assert.equal(aim({ command }), 'card', command)
    assert.equal(aim({ command: 'pane.rename', key: false }), 'card', 'a pick from the palette aims at the card')
  })

  test('the structure is quiet by chord and stays on the desk when picked', () => {
    for (const command of ['pane.new-tab', 'pane.new', 'pane.reopen-closed', 'pane.duplicate.pane.right', 'pane.split-empty.pane.left', 'pane.close', 'pane.move', 'pane.next-tab', 'pane.go.3', 'frame.close-tabs', 'desk.new', 'desk.next']) {
      assert.equal(isStructureCommand(command), true, command)
      assert.equal(aim({ command, paneOwn: true }), 'mute', `chord, modal: ${command}`)
      assert.equal(aim({ command, modal: false }), 'mute', `chord, docked in the card: ${command}`)
      assert.equal(aim({ command, key: false }), 'desk', `pick: ${command}`)
    }
    for (const command of ['note.save', 'font.increase', 'pane.copy-link', 'peek.close']) assert.equal(isStructureCommand(command), false, command)
  })

  test('the card\'s own few run as always; the rest of the table is quiet by chord', () => {
    for (const command of ['peek.close', 'palette.show', 'drawer.toggle']) assert.equal(aim({ command }), 'desk', command)
    for (const command of ['theme.pick', 'sessions.search', 'app.quit-all', 'pane.rename']) assert.equal(aim({ command }), 'mute', command)
  })

  test('a command is the pane\'s own when its rule needs the pane\'s type, flags or focus, not just "a pane"', () => {
    const ctx = (o: Partial<CommandContext>): CommandContext => ({ pane: true, desks: 1, drawerOpen: false, focus: 'none', flags: new Set(), ...o })
    const save = commandFromContribution({ command: 'note.save', title: 's', category: 'Nota', icon: 'floppy-disk', when: 'focus == editor' }, () => {}).when
    assert.equal(paneOwns(save, ctx({ focus: 'editor', paneType: 'note' })), true, 'Ctrl+S in the card\'s editor')
    assert.equal(paneOwns(save, ctx({ focus: 'terminal', paneType: 'terminal' })), false, 'not in a terminal')
    const preview = commandFromContribution({ command: 'markdown.preview', title: 'p', category: 'Nota', icon: 'eye', when: 'markdown.note' }, () => {}).when
    assert.equal(paneOwns(preview, ctx({ flags: new Set(['markdown.note']) })), true, 'a flag of the type')
    assert.equal(paneOwns(c => c.paneType === 'channel', ctx({ paneType: 'channel' })), true, 'the type itself')
    assert.equal(paneOwns(c => c.pane, ctx({ paneType: 'note', focus: 'editor' })), false, 'only "a pane": everybody\'s')
    assert.equal(paneOwns(undefined, ctx({ paneType: 'note' })), false, 'no rule: nobody\'s')
  })
})

describe('the document chords of extensions with a tab in the card (Ctrl+L, Ctrl+T)', () => {
  const press = (key: string, o: Partial<ChordPress> = {}): ChordPress => ({ key, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, ...o })
  const holds = { lent: true, modal: true, focusInCard: true }

  test('the card holding the keyboard swallows Ctrl+L and Ctrl+T: they would act on the tab behind it', () => {
    assert.deepEqual([...CARD_MUTED_CHORDS], ['l', 't'])
    assert.equal(cardMutesChord(holds, press('l')), true)
    assert.equal(cardMutesChord(holds, press('L')), true, 'Caps Lock')
    assert.equal(cardMutesChord(holds, press('t')), true)
    assert.equal(cardMutesChord({ lent: true, modal: false, focusInCard: true }, press('l')), true, 'docked, keyboard in the card')
  })

  test('without the card holding the keyboard, other chords, or in a terminal, nothing is swallowed', () => {
    assert.equal(cardMutesChord({ lent: false, modal: true, focusInCard: true }, press('l')), false, 'no lent tab')
    assert.equal(cardMutesChord({ lent: true, modal: false, focusInCard: false }, press('l')), false, 'docked, keyboard in the conversation')
    assert.equal(cardMutesChord(holds, press('l', { shiftKey: true })), false)
    assert.equal(cardMutesChord(holds, press('l', { altKey: true })), false)
    assert.equal(cardMutesChord(holds, press('l', { ctrlKey: false })), false)
    assert.equal(cardMutesChord(holds, press('k')), false)
    assert.equal(cardMutesChord(holds, press('l', { inTerminal: true })), false, 'the program owns it (clear screen)')
  })
})
