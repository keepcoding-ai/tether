// The sync extension's pure rules (extensions/sync/rules.ts): the status icon (visible, state, tooltip), the popover's text for
// each case, the palette's `when`, the remote's shape, the tray's notice and the dialogs.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  connectAvailable, disconnectDialog, failedDialog, looksLikeGitUrl, maskUrl, noticeAction, nowAvailable, popoverOf, profileNamesOf,
  stateOf, statusVisible, titleOf, urlRow, type SyncLastView, type SyncView,
} from '../../extensions/sync/rules.ts'

const NOW = Date.parse('2026-11-23T12:00:00Z')
const at = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString()
const base: SyncView = { connected: true, running: false, remote: 'https://***@git.test/me/perfil.git', machine: 'casa', last: null, trashDir: 'H/sync-trash' }
const ok = (report: SyncLastView['report'], minutesAgo = 3): SyncView => ({ ...base, last: { at: at(minutesAgo), ok: true, report } })
const failed = (code: string, message: string): SyncView => ({ ...base, last: { at: at(1), ok: false, error: { code, message }, report: null } })
const empty = { applied: {}, written: [], removed: [], pushed: false, conflicts: [], pending: [], unmappedPlaces: [], missingEnv: {}, arrivedDesks: [] }

describe('sync rules: the status icon', () => {
  test('without a link: hidden and idle; the commands offer only "Conectar…"', () => {
    const v: SyncView = { connected: false, running: false, last: null }
    assert.equal(statusVisible(v), false)
    assert.equal(stateOf(v), 'idle')
    assert.equal(titleOf(v, NOW), 'Sincronização: desligada')
    assert.equal(connectAvailable(v), true)
    assert.equal(nowAvailable(v), false)
  })

  test('connecting (running without sync.json yet): visible, busy, no command offered twice', () => {
    const v: SyncView = { connected: false, running: true, last: null }
    assert.equal(statusVisible(v), true)
    assert.equal(stateOf(v), 'busy')
    assert.equal(titleOf(v, NOW), 'Sincronização: conectando…')
    assert.equal(connectAvailable(v), false)
    assert.equal(nowAvailable(v), false)
  })

  test('linked and up to date: normal, "em dia"; only "Sincronizar agora"', () => {
    const v = ok(empty)
    assert.equal(statusVisible(v), true)
    assert.equal(stateOf(v), 'normal')
    assert.equal(titleOf(v, NOW), 'Sincronização: em dia (última há 3 min)')
    assert.equal(connectAvailable(v), false)
    assert.equal(nowAvailable(v), true)
  })

  test('running: busy; "Sincronizar agora" stays (a request merges into the next cycle)', () => {
    const v = { ...ok(empty), running: true }
    assert.equal(stateOf(v), 'busy')
    assert.equal(titleOf(v, NOW), 'Sincronização: sincronizando…')
    assert.equal(nowAvailable(v), true)
  })

  test('network failure: warn; authentication and git missing: error', () => {
    assert.equal(stateOf(failed('network', 'não consegui falar com o remoto')), 'warn')
    assert.equal(stateOf(failed('timeout', 'passou de 120 s')), 'warn')
    assert.equal(stateOf(failed('auth', 'o remoto recusou o acesso')), 'error')
    assert.equal(stateOf(failed('git-missing', 'o git não está instalado')), 'error')
    assert.match(titleOf(failed('auth', 'o remoto recusou o acesso'), NOW), /^Sincronização: falhou há 1 min: o remoto recusou o acesso$/)
  })
})

describe('sync rules: the popover', () => {
  test('up to date: remote, machine, when, and the result in one line', () => {
    const m = popoverOf(ok({ ...empty, applied: { profiles: true, layout: true }, arrivedDesks: ['d1', 'd2'], written: ['a', 'b'], removed: ['c'], pushed: true }), NOW)
    assert.equal(m.remote, 'https://***@git.test/me/perfil.git')
    assert.equal(m.machine, 'casa')
    assert.equal(m.when, 'Última sincronização há 3 min')
    assert.equal(m.headline, 'Chegou: perfis, mesas (2 novas) · Subiram 3 itens')
    assert.equal(m.tone, 'ok')
    assert.deepEqual(m.details, [])
  })

  test('nothing new: a calm line', () => {
    assert.equal(popoverOf(ok(empty), NOW).headline, 'Nada novo chegou · Nada a enviar')
  })

  test('running: "Sincronizando…"', () => {
    assert.equal(popoverOf({ ...ok(empty), running: true }, NOW).when, 'Sincronizando…')
  })

  test('no cycle yet: says so, no result line', () => {
    const m = popoverOf(base, NOW)
    assert.equal(m.when, 'Ainda não sincronizou nesta máquina')
    assert.equal(m.headline, '')
  })

  test('network and authentication errors: the one line, with its tone', () => {
    const n = popoverOf(failed('network', 'não consegui falar com o remoto: confira a URL e a conexão e tente de novo'), NOW)
    assert.equal(n.tone, 'warn')
    assert.match(n.headline, /^não consegui falar com o remoto/)
    const a = popoverOf(failed('auth', 'o remoto recusou o acesso em https://user:tok@git.test/x.git'), NOW)
    assert.equal(a.tone, 'error')
    assert.equal(a.headline, 'o remoto recusou o acesso em https://***@git.test/x.git', 'no credential ever')
  })

  test('conflict: where the local version went', () => {
    const m = popoverOf(ok({ ...empty, conflicts: [{ path: 'settings/settings.json', trashed: true }, { path: 'layout/layout.json', trashed: false }] }), NOW)
    assert.equal(m.tone, 'warn')
    assert.deepEqual(m.details.map(d => d.text), [
      'Conflito em settings/settings.json: valeu a versão do remoto; a sua ficou em H/sync-trash.',
      'Conflito em layout/layout.json: valeu a versão do remoto.',
    ])
  })

  test('a place without a folder: the desks that arrived pointing at it', () => {
    const m = popoverOf(ok({ ...empty, pending: [{ slotId: 's1', place: 'obra' }, { slotId: 's2', place: 'obra' }], unmappedPlaces: ['obra'] }), NOW)
    assert.deepEqual(m.details, [{ kind: 'place', text: 'A pasta obra não está mapeada nesta máquina (2 painéis esperam).' }])
    const two = popoverOf(ok({ ...empty, unmappedPlaces: ['obra', 'site'] }), NOW)
    assert.equal(two.details[0]!.text, 'As pastas obra, site não estão mapeadas nesta máquina.')
  })

  test('missing env: by profile name', () => {
    const v = { ...ok({ ...empty, missingEnv: { 'claude-work': ['ANTHROPIC_API_KEY', 'X'], empty: [] } }), profileNames: { 'claude-work': 'Claude trabalho' } }
    assert.deepEqual(popoverOf(v, NOW).details, [{ kind: 'env', text: 'O perfil "Claude trabalho" precisa das variáveis de ambiente: ANTHROPIC_API_KEY, X.' }])
    assert.match(popoverOf(ok({ ...empty, missingEnv: { other: ['Y'] } }), NOW).details[0]!.text, /"other"/, 'the id stands in without a name')
  })

  test('the first connect says what happened', () => {
    assert.match(popoverOf(ok({ ...empty, connect: { remoteEmpty: true }, written: ['a'], pushed: true }), NOW).headline, /^Conectado: o remoto estava vazio e recebeu o seu perfil · Nada novo chegou · Subiu 1 item$/)
  })

  test('profile names from profiles.json; unreadable is empty', () => {
    assert.deepEqual(profileNamesOf(JSON.stringify({ v: 1, profiles: [{ id: 'a', name: 'A' }, { id: 3 }] })), { a: 'A' })
    assert.deepEqual(profileNamesOf('{'), {})
    assert.deepEqual(profileNamesOf(undefined), {})
  })
})

describe('sync rules: the remote typed in the palette', () => {
  test('git remotes are accepted', () => {
    for (const u of ['https://github.com/me/perfil.git', 'http://git.local:8080/r', 'ssh://git@host.test/me/r.git', 'git@github.com:me/perfil.git', 'file:///C:/repos/perfil.git', ' https://github.com/me/p '])
      assert.equal(looksLikeGitUrl(u), true, u)
  })

  test('anything else is refused, an option-looking text included', () => {
    for (const u of ['', 'perfil', 'https://', 'https://github.com', 'github.com/me/p', 'https://a b/c', '--upload-pack=x', '-x@h:p', 'mailto:x@y'])
      assert.equal(looksLikeGitUrl(u), false, u)
  })

  test('the picker row: masked label, a hint when it does not look like a remote', () => {
    assert.equal(urlRow('  '), undefined)
    assert.deepEqual(urlRow('https://u:t@git.test/r.git'), { value: 'https://u:t@git.test/r.git', label: 'Conectar a https://***@git.test/r.git', icon: 'link' })
    assert.match(urlRow('perfil')!.detail ?? '', /Não parece um endereço git/)
  })

  test('maskUrl hides credentials only', () => {
    assert.equal(maskUrl('https://user:token@host/x and ssh://git@h/y'), 'https://***@host/x and ssh://***@h/y')
    assert.equal(maskUrl('git@github.com:me/p.git'), 'git@github.com:me/p.git')
  })
})

describe('sync rules: the tray and the dialogs', () => {
  test('a notice only for authentication and git missing; a good cycle or the link gone resolves it; network keeps it as it is', () => {
    assert.ok(typeof noticeAction(failed('auth', 'x')) === 'object')
    assert.ok(typeof noticeAction(failed('git-missing', 'x')) === 'object')
    assert.equal(noticeAction(failed('network', 'x')), 'keep')
    assert.equal(noticeAction(failed('timeout', 'x')), 'keep')
    assert.equal(noticeAction(ok(empty)), 'resolve')
    assert.equal(noticeAction({ connected: false, running: false, last: null }), 'resolve')
    assert.equal(noticeAction({ ...failed('auth', 'x'), running: true }), 'keep', 'a cycle in progress decides nothing yet')
  })

  test('disconnect asks, says the files stay, and is the destructive choice', () => {
    const d = disconnectDialog(base)
    assert.match(d.message ?? '', /https:\/\/\*\*\*@git\.test\/me\/perfil\.git/)
    assert.match(d.message ?? '', /ficam como estão; só o vínculo sai/)
    assert.deepEqual(d.choices.map(c => [c.id, c.tone]), [['disconnect', 'destructive']])
    assert.ok(d.cancelLabel)
  })

  test('a failure dialog carries the one line, masked', () => {
    assert.equal(failedDialog('Não deu para conectar', 'falhou em https://u:p@h/r').message, 'falhou em https://***@h/r')
  })
})
