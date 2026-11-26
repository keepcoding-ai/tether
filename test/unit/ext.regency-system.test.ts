// The Regency's "Sistema" rules (extensions/regency/system-rules.ts) and its layout part (renderer/layout-rules.ts).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  dotText, forceReasonError, inUseRefusal, portsWords, procStateText, refusalText, spanWords, systemDot, systemModelOf, systemSignature, systemSummary,
  type SystemAgentInput, type SystemInput, type SystemProcInput,
} from '../../extensions/regency/system-rules.ts'
import {
  backToTether, DEFAULT_LAYOUT, layoutParams, openSystem, readLayout, rightColumnOf, setSystemSection, systemSectionOf,
} from '../../extensions/regency/renderer/layout-rules.ts'

const NOW = Date.parse('2026-11-26T12:00:00.000Z')
const at = (min: number): string => new Date(NOW + min * 60_000).toISOString()
const SECRET = 'sk-very-secret-value'

const proc = (name: string, over: Partial<SystemProcInput> = {}): SystemProcInput => ({
  name, status: 'running', card: { cwd: `C:\\work\\${name}` }, pid: 100, ...over,
})

const agent = (id: string, over: Partial<SystemAgentInput> = {}): SystemAgentInput => ({ id, name: id, kind: 'claude', alive: true, ...over })

const input = (over: Partial<SystemInput> = {}): SystemInput => ({ now: NOW, procs: [], agents: [], profiles: [], folders: [], ...over })

describe('Processos', () => {
  test('state sentences per status', () => {
    assert.equal(procStateText(proc('a'), NOW), 'Rodando')
    assert.equal(procStateText(proc('a', { status: 'stopping' }), NOW), 'Parando…')
    assert.equal(procStateText(proc('a', { status: 'stopped' }), NOW), 'Parado')
    assert.equal(procStateText(proc('a', { status: 'exited', exit: { code: 1, at: at(-4), cause: 'own' } }), NOW), 'Caiu (código 1) há 4 min')
    assert.equal(procStateText(proc('a', { status: 'exited', exit: { code: 0, at: at(-1), cause: 'own' } }), NOW), 'Terminou (código 0) há 1 min')
    assert.equal(procStateText(proc('a', { status: 'exited', exit: { at: at(0), cause: 'external' } }), NOW), 'Caiu há menos de 1 min')
    assert.match(procStateText(proc('a', { status: 'host-lost' }), NOW), /^Perdido/)
    assert.equal(procStateText(proc('a', { status: 'failed', error: 'porta ocupada' }), NOW), 'Não subiu: porta ocupada')
    assert.equal(procStateText(proc('a', { status: 'failed' }), NOW), 'Não subiu')
  })

  test('row: pid, ports, who started it, who uses it and until when', () => {
    const m = systemModelOf(input({
      procs: [proc('web', {
        startedBy: { kind: 'agent', name: 'Maria' }, ports: [{ port: 3000, listening: true }, { port: 5173, listening: false }],
        uses: [{ by: { kind: 'agent', name: 'Maria' }, until: at(12), purpose: 'rodar a prova' }, { by: { kind: 'app' }, until: at(30), purpose: 'olhar' }, { by: { kind: 'app' }, until: at(-1), purpose: 'velho' }],
      })],
    }))
    const r = m.processes[0]!
    assert.equal(r.pid, 100)
    // Beside "Rodando" a port says only whether it answers yet, never "parada" (it would read as the process's state).
    assert.equal(r.portsText, 'portas 3000 e 5173 (5173 ainda sem resposta)')
    assert.equal(portsWords([{ port: 53365, listening: true }], 'running'), 'porta 53365')
    assert.equal(portsWords([{ port: 53365, listening: false }], 'running'), 'porta 53365 ainda sem resposta')
    assert.equal(portsWords([{ port: 53365, listening: false }], 'stopped'), 'porta 53365')
    assert.equal(r.startedByText, 'Iniciado por Maria')
    assert.equal(r.uses.length, 2, 'an expired use is not shown')
    assert.equal(r.uses[0]!.text, 'Maria usa até daqui a 12 min, para: rodar a prova')
    assert.equal(r.uses[1]!.byName, 'Você')
    assert.equal(r.can.release, true)
  })

  test('what the person can do, by status; there is no "new process"', () => {
    const can = (status: SystemProcInput['status'], over: Partial<SystemProcInput> = {}) => systemModelOf(input({ procs: [proc('p', { status, ...over })] })).processes[0]!.can
    assert.deepEqual(can('running'), { start: false, stop: true, restart: true, hold: true, release: false, log: true })
    assert.deepEqual(can('stopped'), { start: true, stop: false, restart: true, hold: false, release: false, log: true })
    assert.equal(can('exited').start, true)
    assert.equal(can('failed').start, true)
    assert.deepEqual([can('stopping').stop, can('stopping').restart, can('stopping').start], [false, false, false])
    assert.equal(can('running', { external: true }).log, false)
    assert.equal('create' in can('running') || 'new' in can('running'), false)
  })

  test('order: attention first, live next, the rest; by name; stable', () => {
    const procs = [
      proc('zeta', { status: 'stopped' }), proc('beta'), proc('Alfa'), proc('queda', { status: 'exited', attention: true, exit: { code: 2, at: at(-1), cause: 'own' } }),
      proc('amber', { status: 'stopped' }),
    ]
    const order = systemModelOf(input({ procs })).processes.map(r => r.name)
    assert.deepEqual(order, ['queda', 'Alfa', 'beta', 'amber', 'zeta'])
    assert.deepEqual(systemModelOf(input({ procs: [...procs].reverse() })).processes.map(r => r.name), order)
  })

  test('the foot counts the marks, else the live ones', () => {
    assert.equal(systemModelOf(input()).procFoot, 'Nenhum processo')
    assert.equal(systemModelOf(input({ procs: [proc('a'), proc('b', { status: 'stopped' })] })).procFoot, '1 rodando de 2')
    assert.equal(systemModelOf(input({ procs: [proc('a', { attention: true })] })).procFoot, '1 processo pede atenção')
    assert.equal(systemModelOf(input({ procs: [proc('a', { attention: true }), proc('b', { attention: true })] })).procFoot, '2 processos pedem atenção')
  })
})

describe('systemDot', () => {
  test('red only with a mark; the tooltip names it; foot and edge, never the pill', () => {
    assert.deepEqual(systemDot({ procs: [proc('a'), proc('b', { attention: false })] }), { show: false, count: 0, text: '', tooltip: '', places: [] })
    const one = systemDot({ procs: [proc('web', { attention: true })] })
    assert.deepEqual(one, { show: true, count: 1, text: '1 processo pede atenção', tooltip: 'O processo "web" pede atenção', places: ['foot', 'edge'] })
    const two = systemDot({ procs: [proc('a', { attention: true }), proc('b', { attention: true }), proc('c')] })
    assert.equal(two.count, 2)
    assert.equal(two.tooltip, '2 processos pedem atenção')
    assert.equal((one.places as string[]).includes('pill'), false)
  })

  test('a process that fell is said so beside the dot: "1 processo caiu", the same words in the foot of Processos', () => {
    const fell = proc('web', { status: 'exited', attention: true, exit: { code: 1, at: at(-2), cause: 'own' } })
    const d = systemDot({ procs: [fell] })
    assert.equal(d.text, '1 processo caiu')
    assert.equal(d.tooltip, 'O processo "web" caiu')
    assert.equal(dotText([{ status: 'exited' }, { status: 'failed' }]), '2 processos caíram')
    assert.equal(dotText([{ status: 'exited' }, { status: 'running' }]), '2 processos pedem atenção')
    assert.equal(systemModelOf(input({ procs: [fell] })).procFoot, '1 processo caiu')
  })

  test('the Processos row of the ruler carries it', () => {
    const m = systemModelOf(input({ procs: [proc('a', { attention: true })] }))
    assert.deepEqual(m.sections.map(s => s.dot), [true, false, false, false, false])
    assert.equal(m.dot.show, true)
  })
})

describe('Ronda', () => {
  test('one line per living agent: on first, with interval, next, criterion and "sem canal"', () => {
    const m = systemModelOf(input({
      agents: [
        agent('zed'), agent('dead', { alive: false }),
        agent('ana', { ronda: { intervalMs: 20 * 60_000, nextAt: at(5), channel: 'listening' } }),
        agent('bia', { ronda: { intervalMs: 3_600_000, nextAt: at(1), criterion: 'testes verdes', channel: 'none' } }),
        agent('cai', { ronda: { intervalMs: 30_000, nextAt: at(-1), due: true } }),
      ],
    }))
    assert.deepEqual(m.ronda.map(r => r.name), ['ana', 'bia', 'cai', 'zed'])
    const [ana, bia, cai, zed] = m.ronda as [typeof m.ronda[0], typeof m.ronda[0], typeof m.ronda[0], typeof m.ronda[0]]
    assert.equal(ana.text, 'ana: ronda a cada 20 min · próxima em 5 min')
    assert.equal(ana.noChannel, false)
    assert.equal(bia.noChannel, true)
    assert.equal(bia.criterion, 'testes verdes')
    assert.equal(bia.text, 'bia: ronda a cada 1 h · próxima espera o canal · sem canal · critério: testes verdes')
    assert.equal(cai.intervalText, 'a cada 30 s')
    assert.equal(cai.nextText, 'assim que ficar parado')
    assert.equal('criterion' in ana, false)
    assert.deepEqual(ana.can, { on: false, remount: true, off: true })
    assert.deepEqual(zed.can, { on: true, remount: false, off: false })
    assert.equal(zed.text, 'zed: sem ronda')
    assert.equal(m.sections[1]!.count, 3)
  })
})

describe('Perfis', () => {
  test('engine, default, "N usam", env names only (never values)', () => {
    const m = systemModelOf(input({
      profiles: [
        { id: 'sh', name: 'PowerShell', agent: 'shell' },
        { id: 'c2', name: 'Claude modo dev', agent: 'claude', env: { ZED: SECRET, API_URL: SECRET } },
        { id: 'c1', name: 'Claude', agent: 'claude', default: true },
      ],
      agents: [agent('a', { profileId: 'c2' }), agent('b', { profileId: 'c2' }), agent('c', { profileId: 'c1' }), agent('d')],
    }))
    assert.deepEqual(m.profiles.map(p => p.id), ['c1', 'c2', 'sh'])
    assert.equal(m.profiles[0]!.isDefault, true)
    assert.equal(m.profiles[0]!.usersText, '1 agente usa')
    assert.equal(m.profiles[1]!.usersText, '2 agentes usam')
    assert.equal(m.profiles[2]!.usersText, 'Nenhum agente usa')
    // When no profile is used, "Nenhum agente usa" would be said of all of them: no line says it.
    const none = systemModelOf(input({ profiles: [{ id: 'sh', name: 'PowerShell', agent: 'shell' }, { id: 'c1', name: 'Claude', agent: 'claude' }] }))
    assert.deepEqual(none.profiles.map(p => p.usersText), ['', ''])
    assert.deepEqual(m.profiles[1]!.envNames, ['API_URL', 'ZED'])
    assert.equal(m.profiles[1]!.engine, 'Claude')
    assert.equal(m.profiles[2]!.engine, 'Terminal')
  })
})

describe('Projetos', () => {
  test('guias, processos por pasta (separators and case folded), pinned first, missing folder cannot host', () => {
    const m = systemModelOf(input({
      folders: [
        { path: 'C:\\work\\a', name: 'a', pinned: false, agents: ['p1', 'p2'] },
        { path: 'C:/work/b', name: 'b', pinned: true, agents: [] },
        { path: 'C:/gone', name: 'gone', pinned: true, agents: [], missing: true },
      ],
      procs: [proc('x', { card: { cwd: 'c:/WORK/a' } }), proc('y', { card: { cwd: 'C:\\work\\a\\sub' } }), proc('z', { card: { cwd: 'C:\\work\\ab' } })],
    }))
    assert.deepEqual(m.projects.map(p => p.name), ['b', 'gone', 'a'])
    const a = m.projects[2]!
    assert.equal(a.procs, 2, 'a sibling folder with the same prefix does not count')
    assert.equal(a.text, '2 guias · 2 processos')
    assert.deepEqual(a.can, { agentHere: true, terminalHere: true, pin: true, unpin: false })
    assert.equal(m.projects[0]!.text, '0 guias · 0 processos')
    assert.deepEqual(m.projects[1]!.can, { agentHere: false, terminalHere: false, pin: false, unpin: true })
    assert.match(m.projects[1]!.text, /não existe mais/)
  })
})

describe('Ajustes', () => {
  test('three screens and two status lines, with the state in one sentence', () => {
    const m = systemModelOf(input({ status: { bridge: { state: 'Conectado ao navegador\n com 2 abas', badge: '2' } } }))
    assert.deepEqual(m.settings.map(s => s.id), ['settings', 'extensions', 'keybindings', 'bridge', 'sync'])
    assert.deepEqual(m.settings[1], { id: 'extensions', label: 'Extensões', kind: 'screen', screenType: 'extensions' })
    assert.deepEqual(m.settings[3], { id: 'bridge', label: 'Bridge', kind: 'status', sentence: 'Conectado ao navegador com 2 abas', badge: '2' })
    assert.deepEqual(m.settings[4], { id: 'sync', label: 'Sync', kind: 'status', sentence: 'Sem informação agora' })
    const long = systemModelOf(input({ status: { sync: { state: 'x'.repeat(300) } } })).settings[4]!
    assert.equal(long.kind === 'status' && long.sentence.length, 120)
  })
})

describe('recusas', () => {
  const busy = proc('web', { uses: [{ by: { kind: 'agent', name: 'Maria' }, until: at(12), purpose: 'rodar a prova' }, { by: { kind: 'external', user: 'guga' }, until: at(2), purpose: 'demo' }, { by: { kind: 'app' }, until: at(-3), purpose: 'velho' }] })

  test('in use: who, until when, for what, and the three exits', () => {
    const r = inUseRefusal(busy, 'stop', NOW)!
    assert.equal(r.sentence, 'Não dá para parar "web" agora: 2 o usam.')
    assert.deepEqual(r.lines, ['Maria usa até daqui a 12 min, para: rodar a prova', 'guga usa até daqui a 2 min, para: demo'])
    assert.deepEqual(r.exits.map(e => e.id), ['wait', 'force', 'cancel'])
    assert.deepEqual(r.exits.map(e => e.label), ['Esperar', 'Forçar', 'Cancelar'])
    assert.equal(r.exits[0]!.waitMs, 5 * 60_000, 'capped by what the daemon holds')
    assert.equal(inUseRefusal(proc('p', { uses: [{ by: { kind: 'app' }, until: at(2), purpose: 'x' }] }), 'stop', NOW)!.exits[0]!.waitMs, 2 * 60_000)
    assert.equal(r.exits[1]!.needsReason, true)
    assert.equal('needsReason' in r.exits[0]!, false)
  })

  test('verb per act, one user, wait capped at 5 min, nobody using gives nothing', () => {
    const one = proc('web', { uses: [{ by: { kind: 'agent', name: 'Maria' }, until: at(90), purpose: 'x' }] })
    assert.equal(inUseRefusal(one, 'restart', NOW)!.sentence, 'Não dá para reiniciar "web" agora: outro o usa.')
    assert.match(inUseRefusal(one, 'forget', NOW)!.sentence, /esquecer/)
    assert.equal(inUseRefusal(one, 'stop', NOW)!.exits[0]!.waitMs, 5 * 60_000)
    assert.equal(inUseRefusal(proc('p'), 'stop', NOW), undefined)
    assert.equal(inUseRefusal(proc('p', { uses: [{ by: { kind: 'app' }, until: at(-1), purpose: 'x' }] }), 'stop', NOW), undefined)
  })

  test('forcing needs a reason', () => {
    assert.equal(forceReasonError('  '), 'Diga o motivo para forçar.')
    assert.match(forceReasonError('x'.repeat(201))!, /passa de 200/)
    assert.equal(forceReasonError('preciso liberar a porta'), undefined)
  })

  test('sentences by error code', () => {
    assert.equal(refusalText('ronda-unavailable'), 'Este agente não ouve a ronda.')
    assert.equal(refusalText('ronda-unavailable', 'um terminal não tem canal'), 'Este agente não ouve a ronda: um terminal não tem canal')
    assert.match(refusalText('ronda-criterion'), /critério de parada/)
    assert.equal(refusalText('unknown-proc'), 'Esse processo não existe mais.')
    assert.equal(refusalText('whatever'), 'Não deu certo.')
    assert.equal(refusalText('whatever', 'falhou assim'), 'falhou assim')
  })

  test('spanWords', () => {
    assert.equal(spanWords(10_000), 'menos de 1 min')
    assert.equal(spanWords(-5), 'menos de 1 min')
    assert.equal(spanWords(5 * 60_000), '5 min')
    assert.equal(spanWords(2 * 3_600_000), '2 h')
    assert.equal(spanWords(3 * 86_400_000), '3 d')
  })
})

describe('model: serialization and signature', () => {
  const full = (): SystemInput => input({
    procs: [
      proc('web', { startedBy: { kind: 'app' }, ports: [{ port: 3000, listening: true }], attention: true, status: 'exited', exit: { code: 1, at: at(-2), cause: 'own' }, error: 'e' }),
      // a real ProcState carries the card's env: the model must not
      { ...proc('api'), card: { cwd: 'C:\\work\\api', env: { TOKEN: SECRET } } } as SystemProcInput,
    ],
    agents: [agent('ana', { ronda: { intervalMs: 600_000, nextAt: at(3) } })],
    profiles: [{ id: 'c', name: 'Claude', agent: 'claude', args: ['--x'], env: { TOKEN: SECRET } }],
    folders: [{ path: 'C:\\work', name: 'work', pinned: true, agents: ['p'] }],
    status: { sync: { state: 'Em dia' } },
  })

  test('JSON round trip is lossless, with no undefined values', () => {
    const m = systemModelOf(full())
    const back = JSON.parse(JSON.stringify(m))
    assert.deepEqual(back, m)
    const hasUndefined = (v: unknown): boolean => v === undefined || (typeof v === 'object' && v !== null && Object.values(v).some(hasUndefined))
    assert.equal(hasUndefined(m), false)
  })

  test('no environment value appears anywhere in the model', () => {
    const json = systemSignature(systemModelOf(full()))
    assert.equal(json.includes(SECRET), false)
    assert.equal(json.includes('TOKEN'), true, 'the NAME of the variable of a profile is shown')
    assert.equal(json.includes('"env"'), false)
  })

  test('equal inputs give equal signatures; a change (or the clock) changes it', () => {
    const a = systemSignature(systemModelOf(full()))
    assert.equal(systemSignature(systemModelOf(full())), a)
    assert.notEqual(systemSignature(systemModelOf({ ...full(), now: NOW + 5 * 60_000 })), a)
    assert.notEqual(systemSignature(systemModelOf({ ...full(), procs: [] })), a)
  })

  test('the five sections in order', () => {
    assert.deepEqual(systemModelOf(input()).sections.map(s => s.id), ['processes', 'ronda', 'profiles', 'projects', 'settings'])
  })
})

describe('layout: the right column and the remembered section', () => {
  test('default: the tether column; the section is the first', () => {
    assert.equal(rightColumnOf(DEFAULT_LAYOUT), 'tether')
    assert.equal(systemSectionOf(DEFAULT_LAYOUT), 'processes')
    assert.equal('system' in DEFAULT_LAYOUT, false)
  })

  test('open, switch section, back to the tether keeps the section', () => {
    const opened = openSystem(DEFAULT_LAYOUT)
    assert.equal(rightColumnOf(opened), 'system')
    assert.equal(opened.system, 'processes')
    const ronda = setSystemSection(opened, 'ronda')
    assert.equal(ronda.system, 'ronda')
    const back = backToTether(ronda)
    assert.equal(rightColumnOf(back), 'tether')
    assert.equal('column' in back, false)
    assert.equal(back.system, 'ronda')
    assert.equal(rightColumnOf(openSystem(back)), 'system')
    assert.equal(openSystem(back).system, 'ronda')
    assert.equal(openSystem(back, 'profiles').system, 'profiles')
    assert.deepEqual(DEFAULT_LAYOUT.collapsed, [])
  })

  test('params: valid is kept and round trips; invalid falls to nothing', () => {
    const l = setSystemSection(DEFAULT_LAYOUT, 'projects')
    assert.deepEqual(readLayout(JSON.parse(JSON.stringify(layoutParams(l)))), l)
    for (const bad of ['nope', 3, null, '', 'PROCESSES']) {
      const r = readLayout({ system: bad, column: bad })
      assert.equal('system' in r, false)
      assert.equal('column' in r, false)
    }
    assert.deepEqual(readLayout({ system: 'bad', column: 'x' }), DEFAULT_LAYOUT)
  })
})

describe('the TV rail summary (systemSummary)', () => {
  test('empty: the words for no process and no ronda, no fall', () => {
    const s = systemSummary(systemModelOf(input()))
    assert.deepEqual(s, { procs: [], procsEmpty: 'Nenhum processo', rondas: [], rondasEmpty: 'Nenhuma ronda ligada' })
  })

  test('each process with its state and intent, in the sections order; a fall names the red dot', () => {
    const m = systemModelOf(input({
      procs: [
        proc('web'),
        proc('job', { status: 'exited', attention: true, exit: { code: 1, at: at(-4), cause: 'own' } }),
        proc('done', { status: 'exited', exit: { code: 0, at: at(-1), cause: 'own' } }),
        proc('halt', { status: 'stopping' }),
      ],
    }))
    const s = systemSummary(m)
    assert.deepEqual(s.procs.map(p => p.name), m.processes.map(p => p.name))
    const by = Object.fromEntries(s.procs.map(p => [p.name, p]))
    assert.equal(by.web!.intent, 'ok')
    assert.equal(by.job!.intent, 'bad')
    assert.equal(by.done!.intent, 'off')
    assert.equal(by.halt!.intent, 'warn')
    assert.equal(by.job!.state, 'Caiu (código 1) há 4 min')
    assert.equal(s.fell, m.dot.text)
    assert.equal(s.fell, '1 processo caiu')
    assert.equal('procsEmpty' in s, false)
  })

  test('only the rondas that are on, with interval and next', () => {
    const m = systemModelOf(input({
      agents: [agent('ana', { ronda: { intervalMs: 20 * 60_000, nextAt: at(5), channel: 'listening' } }), agent('zed')],
    }))
    const s = systemSummary(m)
    assert.deepEqual(s.rondas.map(r => r.name), ['ana'])
    assert.match(s.rondas[0]!.text, /20 min · próxima em 5 min$/)
    assert.equal('rondasEmpty' in s, false)
    assert.equal('fell' in s, false)
  })
})
