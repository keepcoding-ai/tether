// The page in the person's hands (navegador da pessoa, F3): the pure rules (page-rules.ts), the main side over a fake surface
// (person-page.ts: dialogs to the band only while she holds the tab, the chooser refused when the tab changes hands, Ctrl+T and
// Ctrl+L only on her tab), her own local-network question (asked as "Você", her "always" apart from the agents'), and the queue
// rule: her dialogs never reach the agents' question queue.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Surface } from '../../app/main/ext-api.ts'
import type { Control } from '../../extensions/browser/control-rules.ts'
import { LocalNetworkGate } from '../../extensions/browser/local-network.ts'
import { localNetworkDialog, PERSON_GRANT_KEY, type LocalNetworkAsk } from '../../extensions/browser/local-network-rules.ts'
import {
  CHOSEN_FILES_MAX, choiceStands, chooserProperties, chosenFiles, dialogReply, PAGE_DIALOG_TEXT_MAX, type PageDialogAsk, pageDialogHead, pageDialogOf,
  pageKeyOf, servesPerson, throttlesInBackground,
} from '../../extensions/browser/page-rules.ts'
import { PersonPage } from '../../extensions/browser/person-page.ts'
import { PERSON_OWNER } from '../../extensions/browser/tab-rules.ts'

describe('page rules', () => {
  test('the tether serves the page only while the person holds the tab', () => {
    assert.equal(servesPerson('user'), true)
    assert.equal(servesPerson('agent'), false)
    assert.equal(servesPerson('paused'), false)
    assert.equal(servesPerson(undefined), false)
  })

  test('a CDP dialog becomes the band\'s: kinds, origin only, clipped text; beforeunload never', () => {
    assert.deepEqual(pageDialogOf({ type: 'alert', message: 'oi', url: 'http://localhost:9/a/b?c=1' }), { kind: 'alert', message: 'oi', origin: 'http://localhost:9' })
    assert.deepEqual(pageDialogOf({ type: 'prompt', message: 'nome?', url: 'https://x.test/p', defaultPrompt: 'Ana' }), { kind: 'prompt', message: 'nome?', origin: 'https://x.test', defaultText: 'Ana' })
    assert.equal(pageDialogOf({ type: 'confirm', message: 'ok?', url: 'about:blank' })?.origin, '')
    assert.equal(pageDialogOf({ type: 'beforeunload', message: '' }), undefined)
    assert.equal(pageDialogOf(null), undefined)
    assert.equal(pageDialogOf({ type: 'alert', message: 'x'.repeat(PAGE_DIALOG_TEXT_MAX + 50) })?.message.length, PAGE_DIALOG_TEXT_MAX)
    assert.equal(pageDialogOf({ type: 'confirm', message: 'a', defaultPrompt: 'z' })?.defaultText, undefined, 'only a prompt carries a default text')
    assert.equal(pageDialogHead('http://localhost:9'), 'http://localhost:9 diz')
    assert.equal(pageDialogHead(''), 'A página diz')
  })

  test('the reply: alert always OK; prompt sends her text only when accepted', () => {
    assert.deepEqual(dialogReply('alert', false), { accept: true })
    assert.deepEqual(dialogReply('confirm', true), { accept: true })
    assert.deepEqual(dialogReply('confirm', 'yes'), { accept: false }, 'only true accepts')
    assert.deepEqual(dialogReply('prompt', true, 'Ana'), { accept: true, promptText: 'Ana' })
    assert.deepEqual(dialogReply('prompt', true), { accept: true, promptText: '' })
    assert.deepEqual(dialogReply('prompt', false, 'Ana'), { accept: false })
  })

  test('throttling: on for her tabs, never for an agent\'s', () => {
    assert.equal(throttlesInBackground(PERSON_OWNER), true)
    assert.equal(throttlesInBackground('1a2b3c4d'), false)
  })

  test('Ctrl+T and Ctrl+L reach the tether only from a tab she holds', () => {
    const down = (key: string, extra: object = {}) => ({ type: 'keyDown', key, control: true, ...extra })
    assert.equal(pageKeyOf(down('t'), 'user'), 'new-tab')
    assert.equal(pageKeyOf(down('L'), 'user'), 'address')
    assert.equal(pageKeyOf(down('l'), 'agent'), undefined, 'an agent\'s tab keeps its keys')
    assert.equal(pageKeyOf(down('l'), 'paused'), undefined)
    assert.equal(pageKeyOf(down('l', { shift: true }), 'user'), undefined)
    assert.equal(pageKeyOf(down('l', { alt: true }), 'user'), undefined)
    assert.equal(pageKeyOf(down('l', { isAutoRepeat: true }), 'user'), undefined)
    assert.equal(pageKeyOf({ type: 'keyUp', key: 'l', control: true }, 'user'), undefined)
    assert.equal(pageKeyOf({ type: 'keyDown', key: 'l' }, 'user'), undefined)
    assert.equal(pageKeyOf(down('a'), 'user'), undefined)
  })

  test('the chooser: several files only when asked; the choice stands only if the tab never left her', () => {
    assert.deepEqual(chooserProperties('selectSingle'), ['openFile'])
    assert.deepEqual(chooserProperties('selectMultiple'), ['openFile', 'multiSelections'])
    assert.deepEqual(chooserProperties(undefined), ['openFile'])
    assert.deepEqual(chosenFiles(['a', 'b'], false), ['a'])
    assert.deepEqual(chosenFiles(['a', 3, '', 'b'], true), ['a', 'b'])
    assert.equal(chosenFiles(Array.from({ length: CHOSEN_FILES_MAX + 5 }, (_, i) => `f${i}`), true).length, CHOSEN_FILES_MAX)
    assert.deepEqual(chosenFiles('a', true), [])
    const tab = {}
    assert.equal(choiceStands({ tab, epoch: 2 }, { tab, epoch: 2, control: 'user' }), true)
    assert.equal(choiceStands({ tab, epoch: 2 }, { tab, epoch: 3, control: 'user' }), false, 'a control change in between (even back to her)')
    assert.equal(choiceStands({ tab, epoch: 2 }, { tab, epoch: 2, control: 'agent' }), false)
    assert.equal(choiceStands({ tab, epoch: 2 }, { tab: {}, epoch: 2, control: 'user' }), false, 'another tab under the same id')
    assert.equal(choiceStands({ tab, epoch: 2 }, { tab: undefined, epoch: 2, control: 'user' }), false, 'the tab closed')
  })
})

// ---- the main side over a fake surface ----

type Listener = (method: string, params: unknown, sessionId: string | undefined) => void
function fakeSurface() {
  const listeners = new Set<Listener>()
  const sent: { method: string; params?: Record<string, unknown>; sessionId?: string }[] = []
  const keyListeners = new Set<(e: { preventDefault(): void; prevented?: boolean }, input: object) => void>()
  let focusedInterface = 0
  const surface = {
    id: 's1',
    webContents: {
      isDestroyed: () => false,
      on: (ev: string, fn: never) => { if (ev === 'before-input-event') keyListeners.add(fn) },
      off: (ev: string, fn: never) => { if (ev === 'before-input-event') keyListeners.delete(fn) },
    },
    debugger: {
      send: async (method: string, params?: Record<string, unknown>, sessionId?: string) => { sent.push({ method, params, sessionId }); return {} },
      onMessage: (l: Listener) => { listeners.add(l); return { dispose: () => { listeners.delete(l) } } },
    },
    focusInterface: () => { focusedInterface++ },
  }
  return {
    surface: surface as unknown as Surface,
    sent,
    emit: (method: string, params: unknown, sessionId?: string) => { for (const l of [...listeners]) l(method, params, sessionId) },
    key: (input: object): boolean => { let prevented = false; for (const l of [...keyListeners]) l({ preventDefault: () => { prevented = true } }, input); return prevented },
    focused: () => focusedInterface,
    listening: () => listeners.size + keyListeners.size,
  }
}

function setup(initial: Control) {
  const f = fakeSurface()
  let control: Control = initial
  const asks: PageDialogAsk[] = []
  const cancelled: string[] = []
  const keys: [string, string][] = []
  let chooser: (props: string[]) => Promise<string[]> = async () => []
  const page = new PersonPage({
    surface: id => (id === 't1' ? f.surface : undefined),
    control: () => control,
    ask: a => asks.push(a),
    cancelled: id => cancelled.push(id),
    key: (tabId, key) => keys.push([tabId, key]),
    chooseFiles: props => chooser(props),
    log: () => {},
  })
  page.added('t1')
  return {
    f, page, asks, cancelled, keys,
    setControl: (c: Control) => { control = c; page.controlChanged('t1', c) },
    setChooser: (fn: (props: string[]) => Promise<string[]>) => { chooser = fn },
    replies: () => f.sent.filter(s => s.method === 'Page.handleJavaScriptDialog').map(s => s.params),
  }
}

const tick = (): Promise<void> => new Promise(r => setImmediate(r))

describe('the page in her hands (main side)', () => {
  test('her tab: a dialog goes to the band and her answer back to the page; a prompt carries her text', () => {
    const s = setup('user')
    s.f.emit('Page.javascriptDialogOpening', { type: 'prompt', message: 'nome?', url: 'http://localhost:1/x', defaultPrompt: 'Ana' })
    assert.equal(s.asks.length, 1)
    assert.deepEqual({ ...s.asks[0], id: '' }, { id: '', tabId: 't1', kind: 'prompt', message: 'nome?', origin: 'http://localhost:1', defaultText: 'Ana' })
    assert.deepEqual(s.page.open().map(a => a.id), [s.asks[0]!.id])
    s.page.answer(s.asks[0]!.id, true, 'Bia')
    assert.deepEqual(s.replies(), [{ accept: true, promptText: 'Bia' }])
    assert.equal(s.f.sent[0]!.sessionId, undefined, 'answered on the core\'s root session')
    assert.deepEqual(s.page.open(), [])
    s.page.answer(s.asks[0]!.id, true, 'again')
    assert.equal(s.replies().length, 1, 'an answer to a dialog already answered is ignored')
  })

  test('an agent\'s session event is not the tether\'s; the page closing its dialog withdraws the band', () => {
    const s = setup('user')
    s.f.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'x' }, 'agent-session')
    assert.equal(s.asks.length, 0, 'only the root session counts')
    s.f.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'x' })
    s.f.emit('Page.javascriptDialogClosed', { result: true })
    assert.deepEqual(s.cancelled, [s.asks[0]!.id])
    assert.deepEqual(s.page.open(), [])
  })

  test('an agent\'s tab: nothing is answered by the tether; taking the tab hands her the open dialog', () => {
    const s = setup('agent')
    s.f.emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'sure?' })
    assert.equal(s.asks.length, 0, 'with the agent the dialog waits for its CDP')
    s.page.answer('whatever', true)
    assert.deepEqual(s.replies(), [])
    s.setControl('user')
    assert.equal(s.asks.length, 1, 'she took the tab: the dialog is hers now (the agent can no longer answer it)')
    s.page.answer(s.asks[0]!.id, false)
    assert.deepEqual(s.replies(), [{ accept: false }])
  })

  test('her dialog when the tab leaves her: withdrawn and dismissed (the agent never saw it open); her late answer is ignored', () => {
    const s = setup('user')
    s.f.emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'sure?' })
    const id = s.asks[0]!.id
    s.setControl('agent')
    assert.deepEqual(s.cancelled, [id])
    assert.deepEqual(s.replies(), [{ accept: false }])
    s.page.answer(id, true)
    assert.equal(s.replies().length, 1)
  })

  test('an answer while she no longer holds the tab is ignored', () => {
    const s = setup('user')
    s.f.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'x' })
    const id = s.asks[0]!.id
    // The control flips without the hub telling (the answer races the change): main checks again.
    s.setControl('paused')
    s.page.answer(id, true)
    assert.deepEqual(s.replies(), [{ accept: true }], 'only the dismissal of the change, nothing from her answer')
  })

  test('the chooser: her files go to the input; with the agent it never opens', async () => {
    const s = setup('user')
    let props: string[] = []
    s.setChooser(async p => { props = p; return ['C:/f.txt'] })
    s.f.emit('Page.fileChooserOpened', { frameId: 'f', mode: 'selectSingle', backendNodeId: 7 })
    await tick(); await tick()
    assert.deepEqual(props, ['openFile'])
    assert.deepEqual(s.f.sent.filter(x => x.method === 'DOM.setFileInputFiles').map(x => x.params), [{ files: ['C:/f.txt'], backendNodeId: 7 }])
    const a = setup('agent')
    let opened = 0
    a.setChooser(async () => { opened++; return ['C:/f.txt'] })
    a.f.emit('Page.fileChooserOpened', { frameId: 'f', mode: 'selectSingle', backendNodeId: 7 })
    await tick()
    assert.equal(opened, 0, 'the agent\'s chooser is its own (upload consent)')
    assert.deepEqual(a.f.sent, [])
  })

  test('the chooser: refused when the tab changes hands while it is open (even back to her); cancelled sends nothing', async () => {
    const s = setup('user')
    let release!: (p: string[]) => void
    s.setChooser(() => new Promise(r => { release = r }))
    s.f.emit('Page.fileChooserOpened', { mode: 'selectMultiple', backendNodeId: 9 })
    await tick()
    s.setControl('agent')
    s.setControl('user')
    release(['C:/secret.txt'])
    await tick(); await tick()
    assert.deepEqual(s.f.sent.filter(x => x.method === 'DOM.setFileInputFiles'), [], 'the files never reach the page')
    s.setChooser(async () => [])
    s.f.emit('Page.fileChooserOpened', { mode: 'selectSingle', backendNodeId: 9 })
    await tick(); await tick()
    assert.deepEqual(s.f.sent.filter(x => x.method === 'DOM.setFileInputFiles'), [], 'she cancelled')
  })

  test('Ctrl+L in her page: kept from the page, the keyboard back on the interface; an agent\'s page keeps it', () => {
    const s = setup('user')
    assert.equal(s.f.key({ type: 'keyDown', key: 'l', control: true }), true)
    assert.deepEqual(s.keys, [['t1', 'address']])
    assert.equal(s.f.focused(), 1)
    assert.equal(s.f.key({ type: 'keyDown', key: 'x', control: true }), false, 'other keys go to the page')
    s.setControl('agent')
    assert.equal(s.f.key({ type: 'keyDown', key: 't', control: true }), false)
    assert.deepEqual(s.keys, [['t1', 'address']])
  })

  test('a closed tab lets everything go', () => {
    const s = setup('user')
    s.f.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'x' })
    s.page.closed('t1')
    assert.deepEqual(s.cancelled, [s.asks[0]!.id])
    assert.equal(s.f.listening(), 0)
  })
})

describe('her local-network question', () => {
  test('asked as "Você", with its own words; her "always" is kept apart from the agents\'', async () => {
    mkdirSync(tmpdir(), { recursive: true })
    const dir = mkdtempSync(join(tmpdir(), 'tether-page-ln-'))
    try {
      const asked: LocalNetworkAsk[] = []
      const gate = new LocalNetworkGate({ dir, setting: () => 'ask', ask: a => asked.push(a), cancelled: () => {}, log: () => {} })
      const p = gate.request({ tabId: 't1', url: 'http://localhost:5000/', agent: { name: 'Você', person: true } })
      assert.equal(asked.length, 1)
      assert.deepEqual({ ...asked[0], id: '' }, { id: '', agent: 'Você', destination: 'localhost:5000', person: true })
      const spec = localNetworkDialog(asked[0]!)
      assert.equal(spec.title, 'Abrir localhost:5000 na sua guia?')
      assert.ok(!/agente/.test(spec.title) && !/o agente/.test(spec.message), 'no word of an agent asking')
      assert.deepEqual(spec.choices.map(c => c.id), ['once', 'always', 'deny'])
      assert.equal(spec.escChoice, 'deny')
      gate.answer(asked[0]!.id, 'always')
      assert.equal(await p, true)
      const file = JSON.parse(readFileSync(join(dir, 'local-network.json'), 'utf8')) as { profiles: Record<string, string[]> }
      assert.deepEqual(file.profiles, { [PERSON_GRANT_KEY]: ['localhost:5000'] })
      // An agent without a profile is still asked for the same destination; she is not asked again.
      void gate.request({ tabId: 't2', url: 'http://localhost:5000/', agent: { name: 'claude' } })
      assert.equal(asked.length, 2, 'the agent is asked: her "always" is hers')
      assert.equal(await gate.request({ tabId: 't1', url: 'http://localhost:5000/', agent: { name: 'Você', person: true } }), true)
      assert.equal(asked.length, 2)
      gate.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('an agent\'s question is unchanged', () => {
    const spec = localNetworkDialog({ id: 'x', agent: 'claude', destination: 'localhost:1' })
    assert.equal(spec.title, 'Permitir que claude abra localhost:1?')
  })
})

describe('her dialogs and the agents\' questions', () => {
  test('the band\'s dialogs travel on channels of their own, never the agents\' question channels', () => {
    // The agents' questions (local network, uploads) share one queue in the renderer (`enqueueQuestion`); her page dialogs come
    // on `pageDialog` and live in the pane: nothing of hers is ever put in that queue, so nothing of hers goes in front of an
    // agent's question or holds it.
    const src = readFileSync(join(import.meta.dirname, '..', '..', 'extensions', 'browser', 'renderer.ts'), 'utf8')
    const queued = [...src.matchAll(/enqueueQuestion\(\{[^}]*situation: (\w+)/g)].map(m => m[1])
    assert.deepEqual(queued.sort(), ['LOCAL_NETWORK_SITUATION', 'UPLOAD_SITUATION'])
    assert.match(src, /ipc\.on\('pageDialog', onPageDialog\)/)
    assert.doesNotMatch(src.slice(src.indexOf('const onPageDialog'), src.indexOf('const onPageDialogClosed')), /enqueueQuestion|asks\./)
  })
})
