// The chooser's rules (app/renderer/chooser-rules.ts): the items (profiles with their aliases, the notes, the empty
// pane only when offered), the ranking (prefix → start of a word → subsequence → alias), the rows (Recentes first,
// profiles only, not repeated; the groups in the manager's order; 1–9 numbered as shown, renumbered on filter),
// the digit keys, the recents memory, the folder that applies, the button's words, the Esc ladder; and the empty
// pane's origin in its params (app/shared/empty.ts) with the new-tab command and chord.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Profile } from '../../src/daemon/protocol.ts'
import { appCommands, type CommandHost } from '../../app/renderer/app-commands.ts'
import { chooserItems, chooserRows, effectiveFolder, EMPTY_ITEM, escLayer, filterFolders, itemForDigit, matchItem, NOTE_NEW_ITEM, NOTE_OPEN_ITEM, openLabel, profileItem, rememberProfile, rowItems } from '../../app/renderer/chooser-rules.ts'
import { CommandRegistry, type CommandContext } from '../../app/renderer/commands.ts'
import { shortcutOf, type KeyLike } from '../../app/renderer/shortcuts.ts'
import { emptyOrigin, emptyParams, withEmpty } from '../../app/shared/empty.ts'

const UNSAFE = '--dangerously-skip-permissions'
const PROFILES: Profile[] = [
  { id: 'claude', name: 'Claude', agent: 'claude', args: [], default: true },
  { id: 'claude-dev', name: 'Claude modo dev', agent: 'claude', args: [UNSAFE] },
  { id: 'soul', name: 'soul', agent: 'soul', args: ['-g'], default: true, cwd: 'D:\\atrium' },
  { id: 'powershell', name: 'PowerShell', agent: 'shell', args: ['-NoLogo'], default: true },
  { id: 'git-bash', name: 'Git Bash', agent: 'shell', args: [], shell: { command: 'bash.exe', args: ['--login', '-i'] } },
] as Profile[]
const ITEMS = chooserItems(PROFILES, { empty: false })
const ids = (rows: ReturnType<typeof chooserRows>): string[] => rowItems(rows).map(i => i.id)
const numbers = (rows: ReturnType<typeof chooserRows>): Array<[string, number | undefined]> => rows.flatMap(r => (r.kind === 'item' ? [[r.item.id, r.n] as [string, number | undefined]] : []))

describe('items', () => {
  test('profiles in the manager order, then the notes; the empty pane only when offered', () => {
    assert.deepEqual(ITEMS.map(i => i.id), ['claude', 'claude-dev', 'soul', 'powershell', 'git-bash', NOTE_NEW_ITEM.id, NOTE_OPEN_ITEM.id])
    assert.deepEqual(chooserItems(PROFILES, { empty: true }).at(-1), EMPTY_ITEM)
    assert.ok(ITEMS.every(i => i.id === NOTE_NEW_ITEM.id || i.id === NOTE_OPEN_ITEM.id || i.kind === 'profile'))
  })

  test('a profile item: args line, the shell executable\'s args, unsafe and default marks, its own folder', () => {
    const dev = profileItem(PROFILES[1]!)
    assert.deepEqual([dev.hint, dev.unsafe, dev.default, dev.hintNone], [UNSAFE, true, false, false])
    const bash = profileItem(PROFILES[4]!)
    assert.equal(bash.hint, '--login -i')
    assert.equal(profileItem(PROFILES[0]!).hint, 'sem argumentos')
    assert.ok(profileItem(PROFILES[0]!).hintNone)
    assert.equal(profileItem(PROFILES[2]!).cwd, 'D:\\atrium')
    assert.ok(profileItem(PROFILES[2]!).default)
  })
})

describe('matching', () => {
  const by = (id: string) => ITEMS.find(i => i.id === id)!
  test('prefix beats a word start beats a subsequence beats an alias', () => {
    assert.equal(matchItem(by('claude'), 'cla')!.score, 0)
    assert.deepEqual(matchItem(by('claude'), 'cla')!.positions, [0, 1, 2])
    assert.equal(matchItem(by('claude-dev'), 'dev')!.score, 1, '"dev" starts the last word of "Claude modo dev"')
    assert.deepEqual(matchItem(by('claude-dev'), 'dev')!.positions, [12, 13, 14])
    assert.equal(matchItem(by('powershell'), 'psh')!.score, 2, 'a subsequence of PowerShell')
    assert.equal(matchItem(by('powershell'), 'pwsh')!.score, 2, 'p-w-s-h is a subsequence of PowerShell too')
    assert.equal(matchItem(by('git-bash'), 'sh')!.score, 2)
    assert.equal(matchItem(by('git-bash'), 'terminal')!.score, 3, 'an alias of every shell')
    assert.equal(matchItem(by('claude-dev'), 'yolo')!.score, 3, 'an alias of the unsafe flag')
    assert.equal(matchItem(NOTE_NEW_ITEM, 'nota')!.score, 1, '"nota" starts the second word of "Nova nota"')
    assert.equal(matchItem(NOTE_NEW_ITEM, 'nova')!.score, 0)
    assert.equal(matchItem(NOTE_OPEN_ITEM, 'md')!.score, 3)
    assert.equal(matchItem(by('claude'), 'xyz'), undefined)
  })

  test('case, accents and spaces do not matter', () => {
    assert.equal(matchItem(by('claude-dev'), 'CLAUDE MODO')!.score, 0)
    assert.equal(matchItem(by('git-bash'), 'Bash')!.score, 1)
    assert.equal(matchItem(by('claude-dev'), 'sem restrições')!.score, 3)
  })
})

describe('rows', () => {
  test('without a query: Recentes (profiles only, up to 3, not repeated), then Claude · soul · Shell · Nota; numbered 1–9', () => {
    const rows = chooserRows(ITEMS, '', ['powershell', NOTE_NEW_ITEM.id, 'claude', 'soul', 'git-bash'])
    const seps = rows.flatMap(r => (r.kind === 'sep' ? [r.label] : []))
    assert.deepEqual(seps, ['Recentes', 'Claude', 'Shell', 'Nota'], 'soul is wholly in Recentes, so its group is gone')
    assert.deepEqual(ids(rows), ['powershell', 'claude', 'soul', 'claude-dev', 'git-bash', NOTE_NEW_ITEM.id, NOTE_OPEN_ITEM.id])
    assert.deepEqual(numbers(rows).map(([, n]) => n), [1, 2, 3, 4, 5, 6, 7])
    assert.ok(rows[0]!.kind === 'sep' && rows[0]!.recent)
  })

  test('without history: no Recentes group', () => {
    const rows = chooserRows(ITEMS, '', [])
    assert.deepEqual(rows.flatMap(r => (r.kind === 'sep' ? [r.label] : [])), ['Claude', 'soul', 'Shell', 'Nota'])
    assert.equal(ids(rows)[0], 'claude')
  })

  test('with a query: ranked, no separators, renumbered from 1; recents first among equals', () => {
    const rows = chooserRows(ITEMS, 'sh', ['git-bash'])
    assert.ok(rows.every(r => r.kind === 'item'))
    // "sh": PowerShell (word start? no: "Shell" inside "PowerShell" is not a word) → subsequence; Git Bash → subsequence; both shells by alias too. Recent first among equals.
    assert.deepEqual(ids(rows), ['git-bash', 'powershell'])
    assert.deepEqual(numbers(rows), [['git-bash', 1], ['powershell', 2]])
    const dev = chooserRows(ITEMS, 'dev', [])
    assert.deepEqual(ids(dev), ['claude-dev'])
    assert.equal(ids(chooserRows(ITEMS, 'nota', []))[0], NOTE_NEW_ITEM.id)
  })

  test('only the first nine get a number; the digit opens the item shown with it', () => {
    const many = [...ITEMS, ...Array.from({ length: 5 }, (_, i) => profileItem({ id: `p${i}`, name: `Perfil ${i}`, agent: 'claude', args: [] } as Profile))]
    const rows = chooserRows(many, '', [])
    const ns = numbers(rows)
    assert.equal(ns.filter(([, n]) => n !== undefined).length, 9)
    assert.equal(ns[9]![1], undefined)
    assert.equal(itemForDigit(rows, '1')!.id, 'claude')
    assert.equal(itemForDigit(rows, '9')!.id, ns[8]![0])
    assert.equal(itemForDigit(rows, '0'), undefined)
    assert.equal(itemForDigit(chooserRows(ITEMS, 'bash', []), '1')!.id, 'git-bash', 'renumbered under a filter')
    assert.equal(itemForDigit(chooserRows(ITEMS, 'bash', []), '2'), undefined)
  })

  test('recents memory: most recent first, no repeats, three at most', () => {
    assert.deepEqual(rememberProfile([], 'a'), ['a'])
    assert.deepEqual(rememberProfile(['a', 'b'], 'b'), ['b', 'a'])
    assert.deepEqual(rememberProfile(['a', 'b', 'c'], 'd'), ['d', 'a', 'b'])
  })
})

describe('folder, button, Esc', () => {
  test('the profile\'s own folder applies until the field is touched', () => {
    const soul = ITEMS.find(i => i.id === 'soul')!
    assert.deepEqual(effectiveFolder(soul, 'D:\\x', false), { folder: 'D:\\atrium', fromProfile: true })
    assert.deepEqual(effectiveFolder(soul, 'D:\\x', true), { folder: 'D:\\x', fromProfile: false })
    assert.deepEqual(effectiveFolder(ITEMS[0], 'D:\\x', false), { folder: 'D:\\x', fromProfile: false })
    assert.deepEqual(effectiveFolder(undefined, '', false), { folder: '', fromProfile: false })
  })

  test('the button says what Enter does', () => {
    assert.deepEqual(openLabel(ITEMS[0]), { verb: 'Abrir', name: 'Claude' })
    assert.deepEqual(openLabel(NOTE_NEW_ITEM), { verb: 'Criar', name: 'nota' })
    assert.deepEqual(openLabel(NOTE_OPEN_ITEM), { verb: 'Abrir', name: 'nota…' })
    assert.deepEqual(openLabel(EMPTY_ITEM), { verb: 'Criar', name: 'vazio' })
    assert.deepEqual(openLabel(ITEMS[0], true), { verb: 'Abrindo', name: 'Claude…' })
    assert.deepEqual(openLabel(undefined), { verb: 'Abrir', name: '' })
  })

  test('Esc in layers: clear the text, close the folder list, cancel', () => {
    assert.equal(escLayer({ query: 'cl', recentsOpen: true }), 'clear')
    assert.equal(escLayer({ query: '', recentsOpen: true }), 'close-recents')
    assert.equal(escLayer({ query: '', recentsOpen: false }), 'cancel')
  })

  test('the recent folders filter by the typed text', () => {
    const list = ['D:\\atrium\\workspace\\tether', 'D:\\atrium', 'C:\\Users\\x\\projetos']
    assert.deepEqual(filterFolders(list, 'teth'), ['D:\\atrium\\workspace\\tether'])
    assert.deepEqual(filterFolders(list, 'ATRIUM'), list.slice(0, 2))
    assert.deepEqual(filterFolders(list, ''), list)
  })
})

describe('the empty pane\'s origin and the new-tab command', () => {
  test('origin travels in the params; saved panes without one are layout', () => {
    assert.deepEqual(withEmpty('D:\\p', 'add'), { empty: { cwd: 'D:\\p', origin: 'add' } })
    assert.deepEqual(withEmpty('D:\\p'), { empty: { cwd: 'D:\\p' } })
    assert.deepEqual(withEmpty(undefined, 'add'), { empty: { origin: 'add' } })
    assert.equal(emptyOrigin({ empty: { cwd: 'D:\\p' } }), 'layout')
    assert.equal(emptyOrigin({ empty: { origin: 'add' } }), 'add')
    assert.equal(emptyOrigin({ empty: { origin: 'what' } }), 'layout')
    assert.equal(emptyOrigin(undefined), 'layout')
    assert.deepEqual(emptyParams({ empty: { cwd: '', origin: 'add' } }), { origin: 'add' })
  })

  test('Ctrl+Shift+T is pane.new-tab; pane.new (the popup) has no chord', async () => {
    const calls: string[] = []
    const host = new Proxy({} as CommandHost, { get: (_t, p) => (p === 'activePane' ? () => undefined : (...a: unknown[]) => { calls.push([String(p), ...a.map(x => JSON.stringify(x))].join(' ')) }) })
    const list = appCommands(host)
    const r = new CommandRegistry(() => ({ pane: false, desks: 1, drawerOpen: false, focus: 'none' } satisfies CommandContext))
    r.register(...list)
    const key: KeyLike = { code: 'KeyT', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }
    assert.deepEqual(shortcutOf(key, false), { op: 'new-tab' })
    assert.equal(r.byShortcut({ op: 'new-tab' })?.id, 'pane.new-tab')
    assert.equal(r.hint(list.find(c => c.id === 'pane.new-tab')!), 'Ctrl+Shift+T')
    assert.equal(r.hint(list.find(c => c.id === 'pane.new')!), '')
    assert.equal(list.find(c => c.id === 'pane.new-tab')!.title, 'Nova aba neste grupo')
    await r.run('pane.new-tab')
    await r.run('pane.new')
    assert.deepEqual(calls, ['newTab', 'newPanel'])
  })
})
