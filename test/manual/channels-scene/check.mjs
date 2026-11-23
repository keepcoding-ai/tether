// The ruler of the channels scene (contract section 8, slice S1): at every step, what the disk of the bench home and the CLI say.
//   node check.mjs [--slot <slot id of Atrium's guide>] [--before | --after [--step N]]
//   (no flag)  prints the board
//   --before   prints the board and saves it (visible desk, last seq of each channel) for --after
//   --after    prints the board, says what changed against --before and, with --step N (0..15), checks what step N of the
//              table promises that the disk can show; what only the eye or the app screen can see is marked "n/a".
// The board comes from files of the bench home (channels/index.json, channels/<id>/*.jsonl, desks.json, layout.json,
// objects/for-agents.json, settings.json). The CLI (`agents list`, `channels list`, `channels members`) is called only when the
// scene is up and a slot is known (--slot, or the owner of the desk channel read from index.json): it proves the slot with its
// own environment, which this script never reads or forwards, so a refusal is printed as it came.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { CLI, DESK_NAME, GUIDE_NAMES, OUT, readJson, readScene } from './lib.mjs'

const argv = process.argv.slice(2)
const mode = argv.includes('--before') ? 'before' : argv.includes('--after') ? 'after' : 'plain'
const valueOf = flag => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined }
const step = valueOf('--step') === undefined ? undefined : Number(valueOf('--step'))
if (step !== undefined && !(Number.isInteger(step) && step >= 0 && step <= 15)) { console.error('--step: um numero de 0 a 15'); process.exit(2) }
const scene = readScene()

// ---- the disk ----
const settings = readJson(join(scene.home, 'settings.json'))
const index = readJson(join(scene.home, 'channels', 'index.json'))
const channels = Object.values(index?.channels ?? {})
const layout = readJson(join(scene.home, 'layout.json'))
const deskMap = readJson(join(scene.home, 'desks.json'))
const objects = readJson(join(scene.home, 'objects', 'for-agents.json'))
const cena = deskMap?.desks?.find(d => d.name === DESK_NAME)
const active = layout?.desks?.find(d => d.id === layout.activeDesk)

function linesOf(id) {
  const dir = join(scene.home, 'channels', id)
  if (!existsSync(dir)) return []
  const out = []
  for (const f of readdirSync(dir).filter(n => /^\d{6}\.jsonl$/.test(n)).sort()) {
    for (const raw of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!raw.trim()) continue
      try { out.push(JSON.parse(raw)) } catch { /* a half-written last line */ }
    }
  }
  return out
}

const byName = name => channels.filter(c => c.name === name || c.name.startsWith(`${name}-`)).sort((a, b) => Number(!!a.closed) - Number(!!b.closed))[0]
const deskChannel = (cena ? channels.find(c => c.desk === cena.id) : undefined) ?? channels.find(c => c.desk !== undefined)
const revisao = byName('revisao')
const ownerId = c => (c?.owner?.kind === 'agent' ? c.owner.id : undefined)
const slot = valueOf('--slot') ?? ownerId(deskChannel)
const memberByName = (c, name) => Object.entries(c?.members ?? {}).find(([, m]) => m.name === name)

// ---- the CLI (best effort) ----
const env = {}
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLAUDE|TETHER_)/i.test(k)) env[k] = v
env.TETHER_HOME = scene.home
env.TETHER_PIPE = scene.pipe
const daemonUp = spawnSync(process.execPath, [CLI, 'daemon', 'status'], { env, stdio: 'ignore', timeout: 10_000 }).status === 0

function cli(args) {
  if (!daemonUp) return { skipped: 'o daemon da bancada nao responde' }
  if (!slot) return { skipped: 'sem guia de Atrium ainda (passe --slot <id>)' }
  const r = spawnSync(process.execPath, [CLI, ...args, '--json', '--slot', slot], { env, encoding: 'utf8', timeout: 30_000 })
  const text = (r.stdout || r.stderr || '').trim()
  try { return { json: JSON.parse(text) } } catch { return { text: text.slice(0, 400), status: r.status } }
}
const cliLists = { agents: cli(['agents', 'list']), channels: cli(['channels', 'list']) }
const cliMembers = deskChannel ? cli(['channels', 'members', deskChannel.name]) : { skipped: 'nao ha canal da mesa ainda' }

// ---- the board ----
const when = iso => (iso ?? '').slice(11, 19)
const short = (s, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s).replaceAll('\n', ' ')
const out = []
const say = (s = '') => { out.push(s); console.log(s) }

say(`== bancada ${scene.root}`)
say(`   daemon: ${daemonUp ? 'responde' : 'nao responde'}   extensoes desligadas no settings: ${JSON.stringify(settings?.extensions?.disabled ?? 'settings.json ausente')}`)
say(`== mesa visivel (layout.json): ${layout ? `${active?.name ?? '?'} (${layout.activeDesk}), quadro ativo ${active?.activeFrame ?? '?'}` : 'layout.json ainda nao existe: o app nao abriu ou ainda nao gravou o layout'}`)
say(`   a guia ativa dentro do quadro NAO esta no disco: confira a olho ou pelo print (ui.panes.activeId so existe dentro do app)`)
say(`== mesa ${DESK_NAME}: ${cena ? `${cena.id}, ${(cena.panes ?? []).length} guia(s): ${(cena.panes ?? []).map(p => `${p.type}:${p.id}`).join(', ') || 'vazia'}` : 'ainda nao existe em desks.json'}`)
say(`   posse (objects/for-agents.json): ${cena && objects?.desk?.[cena.id] ? JSON.stringify(objects.desk[cena.id]) : 'sem dono'}`)
say(`== channels/index.json: ${index ? `${channels.length} canal(is)` : 'ainda nao gravado'}`)
for (const c of channels) {
  const lines = linesOf(c.id)
  const own = c.owner?.kind === 'agent' ? `${c.owner.name} (${c.owner.id})${c.ownerEnded ? ` [abdicou: ${c.ownerEnded.why}]` : ''}` : 'usuario'
  say(`-- #${c.name}${c.desk ? `  (da mesa ${c.desk})` : ''}${c.closed ? `  ENCERRADO ${when(c.closed.at)}` : ''}  id ${c.id}`)
  say(`   dono: ${own}   titulo: ${c.title}   visto pelo usuario ate seq ${c.seenByUser}   linhas: ${lines.length}`)
  for (const [id, m] of Object.entries(c.members ?? {})) say(`   - ${m.name} (${id})  entrou por ${m.by} as ${when(m.since)}${m.muted ? '  CALADO' : ''}`)
  if (c.removed?.length) say(`   tirados: ${c.removed.join(', ')}`)
  for (const l of lines.slice(-6)) say(`   ${String(l.seq).padStart(3)} ${when(l.at)} ${l.kind === 'notice' ? 'aviso ' : ''}${l.from?.name} (${l.from?.role})${l.to?.length ? ` -> ${l.to.join(', ')}` : ''}: ${short(l.body ?? '')}`)
}
const show = (title, r) => {
  say(`== ${title}`)
  if (r.skipped) say(`   pulado: ${r.skipped}`)
  else if (r.json !== undefined) say(JSON.stringify(r.json, null, 2).split('\n').map(l => `   ${l}`).join('\n'))
  else say(`   ${r.text ?? ''}${r.status ? `  (status ${r.status})` : ''}`)
}
show('agents list (a visao do dono)', cliLists.agents)
show('channels list (a visao do dono)', cliLists.channels)
show(`channels members ${deskChannel?.name ?? DESK_NAME}`, cliMembers)

// ---- the snapshot ----
const snap = {
  at: new Date().toISOString(),
  visible: layout ? { activeDesk: layout.activeDesk, name: active?.name, activeFrame: active?.activeFrame } : null,
  channels: Object.fromEntries(channels.map(c => [c.name + (c.closed ? '(encerrado)' : ''), { id: c.id, last: linesOf(c.id).at(-1)?.seq ?? 0, members: Object.keys(c.members ?? {}).length }])),
  lastById: Object.fromEntries(channels.map(c => [c.id, linesOf(c.id).at(-1)?.seq ?? 0])),
}
const beforeFile = join(OUT, 'check-before.json')
if (mode === 'before') { writeFileSync(beforeFile, JSON.stringify(snap, null, 2)); say(`\nsalvo em ${beforeFile}`) }

// ---- the expectations of --after --step N ----
let failed = 0
const tick = (label, ok, detail = '') => {
  if (ok === null) say(`   [n/a]   ${label}${detail ? `  (${detail})` : ''}`)
  else if (ok) say(`   [ok]    ${label}${detail ? `  (${detail})` : ''}`)
  else { failed++; say(`   [FALTA] ${label}${detail ? `  (${detail})` : ''}`) }
}

if (mode === 'after') {
  const was = existsSync(beforeFile) ? JSON.parse(readFileSync(beforeFile, 'utf8')) : undefined
  say('\n== o que mudou desde o --before')
  if (!was) say('   sem --before salvo')
  else {
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
    tick('mesa visivel e quadro ativo iguais ao antes', same(was.visible, snap.visible), same(was.visible, snap.visible) ? '' : `antes ${JSON.stringify(was.visible)}, depois ${JSON.stringify(snap.visible)}`)
    for (const [name, s] of Object.entries(snap.channels)) {
      const b = was.channels?.[name]
      say(`   #${name}: ${b ? `ultima linha ${b.last} -> ${s.last}, membros ${b.members} -> ${s.members}` : `novo (ultima linha ${s.last}, membros ${s.members})`}`)
    }
    for (const name of Object.keys(was.channels ?? {})) if (!snap.channels[name]) say(`   #${name}: sumiu do index`)
  }

  if (step !== undefined) {
    say(`\n== passo ${step}: o que o disco pode provar`)
    const A = ownerId(deskChannel)
    const C = deskChannel
    const cl = C ? linesOf(C.id) : []
    const rl = revisao ? linesOf(revisao.id) : []
    const newer = (lines, seq) => lines.filter(l => l.seq > seq)
    const names = Object.values(GUIDE_NAMES)
    const disabled = settings?.extensions?.disabled ?? []
    const eye = 'so a tela mostra'
    const guideId = name => memberByName(C, name)?.[0]
    const viaCli = (name) => cliMembers.json?.members?.find(m => m.name === name)?.path
    const beforeLast = was && C ? (was.lastById?.[C.id] ?? 0) : undefined

    if (step === 0) {
      tick('for-agents, channels e skills ligadas', !['for-agents', 'channels', 'skills'].some(e => disabled.includes(e)))
      tick('nenhum canal ainda (`channels list` de A vazio)', channels.length === 0 || channels.every(c => c.closed))
      tick('o `initialize` de A traz o paragrafo [channels]', null, 'olhe a sessao de A; ate o M3 nao ha tela, mas a skill `channels` lista os verbos')
    }
    if (step === 1) {
      tick('a mesa cena existe', !!cena)
      tick(`nasceu o canal da mesa (nome ${DESK_NAME}, sem prefixo mesa-: decisao C14)`, !!C && C.name.startsWith(DESK_NAME), C?.name)
      tick('o canal e da mesa (campo desk) e esta aberto', !!C && C.desk === cena?.id && !C.closed)
      tick('o dono do canal e A, o dono da mesa', !!A && A === objects?.desk?.[cena?.id]?.owner, A)
      tick('o historico abre com o aviso de criacao', cl[0]?.kind === 'notice' && cl[0]?.event?.type === 'create', short(cl[0]?.body ?? '', 60))
      tick('A recebeu o aviso por dentro', null, 'confira na sessao de A: kind="notice", role="system"')
    }
    if (step === 2) {
      for (const n of names) tick(`${n} esta no canal, entrou pela mesa`, memberByName(C, n)?.[1]?.by === 'desk')
      tick('Claude ouve por dentro', viaCli(GUIDE_NAMES.claude) === undefined ? null : viaCli(GUIDE_NAMES.claude) === 'inside', viaCli(GUIDE_NAMES.claude) ?? 'sem `channels members` pela CLI')
      for (const n of [GUIDE_NAMES.soul, GUIDE_NAMES.codex]) tick(`${n} ouve pelo terminal`, viaCli(n) === undefined ? null : viaCli(n) === 'terminal', viaCli(n) ?? 'sem `channels members` pela CLI')
    }
    if (step === 3) {
      const say3 = cl.filter(l => l.kind === 'message' && l.from.id === A && /^Bom dia/.test(l.body)).at(-1)
      tick('a fala de Atrium esta no historico', !!say3, say3 ? `seq ${say3.seq}, papel gravado ${say3.from.role}` : '')
      tick('os tres recibos (inside, typed, typed)', null, 'saem no retorno do `channels say`: confira no terminal de A; o Codex deve mostrar o · do cabecalho (N4)')
    }
    if (step === 4) {
      const mark = cl.filter(l => /^Bom dia/.test(l.body)).at(-1)?.seq ?? 0
      for (const n of names) {
        const l = newer(cl, mark).find(x => x.kind === 'message' && x.from.name === n)
        tick(`${n} respondeu no canal`, !!l, l ? `seq ${l.seq}, papel ${l.from.role}` : '')
      }
      tick('nenhuma das tres guias ficou laranja', null, 'a olho; so a marca de "terminou" vai a A pela for-agents (C12)')
    }
    if (step === 5) {
      tick('o seletor abre com o canal em destaque e a guia do canal abre com o historico', null, 'depende da guia do canal (M3); equivalente: `channels read cena`')
    }
    if (step === 6) {
      const l = cl.filter(x => x.from.id === 'user' && x.from.role === 'moderator').at(-1)
      tick('a fala do moderator esta no historico, dirigida ao Soul', !!l && (l.to ?? []).includes(GUIDE_NAMES.soul), l ? `seq ${l.seq}, to ${JSON.stringify(l.to ?? [])}` : 'sem fala do moderator (a tela do canal e o M3; equivalente pela CLI nao existe: o moderator so fala pelo app)')
      tick('o Soul a recebeu pelo terminal com o cabecalho `de usuario (moderator)`', null, 'a olho, na guia do Soul')
    }
    if (step === 7) {
      tick('#revisao existe, aberto, dono A', !!revisao && !revisao.closed && ownerId(revisao) === A)
      tick('Claude e Soul estao em #revisao', !!memberByName(revisao, GUIDE_NAMES.claude) && !!memberByName(revisao, GUIDE_NAMES.soul))
      tick('o Codex nao esta em #revisao', !memberByName(revisao, GUIDE_NAMES.codex))
    }
    if (step === 8) {
      tick('ha fala de A em #revisao', rl.some(l => l.kind === 'message' && l.from.id === A))
      const lastUser = cl.filter(l => l.from.id === 'user').at(-1)?.seq ?? 0
      tick('ha fala nova de A em #cena depois da do passo 6', newer(cl, lastUser).some(l => l.kind === 'message' && l.from.id === A))
      tick('Claude recebeu as duas com o room certo; Soul a segunda so no fim do turno', null, 'a olho, nas duas sessoes')
    }
    if (step === 9) {
      const l = cl.filter(x => x.kind === 'message' && x.from.name === GUIDE_NAMES.codex && (x.to ?? []).includes('usuário')).at(-1)
      tick('a fala do Codex dirigida ao usuario esta no historico', !!l, l ? `seq ${l.seq}` : 'veja se o moderatorName do settings nao e outro')
      tick('a guia do canal e o icone de canais ganham a marca laranja; a marca some ao ver', null, 'depende da guia do canal (M3) e do icone na barra de topo (U3)')
    }
    if (step === 10) {
      const [, m] = memberByName(C, GUIDE_NAMES.codex) ?? []
      tick('o Codex esta calado', !!m?.muted)
      tick('ha aviso de "calar" no historico', cl.some(l => l.event?.type === 'mute'))
      tick('o `channels_say` seguinte do Codex responde `muted`', null, 'confira no retorno do Codex; ele continua recebendo as falas')
    }
    if (step === 11) {
      const mine = beforeLast === undefined ? null : newer(cl, beforeLast).filter(l => l.kind === 'message' && l.from.id === A).length
      tick('tres falas novas de A no historico desde o --before', mine === null ? null : mine >= 3, mine === null ? 'rode --before antes do passo' : `${mine} falas`)
      tick('nada foi digitado na guia do Soul (offset do anel); fusao na fila; devolvida a guia, o Soul recebe a fala e o aviso', null, 'a olho e pelo anel; a fila e em memoria do daemon')
    }
    if (step === 12) {
      tick('Claude saiu de #revisao (tirado)', !!revisao && !memberByName(revisao, GUIDE_NAMES.claude) && (revisao.removed ?? []).length > 0)
      tick('aviso de "tirar" no historico de #revisao', rl.some(l => l.event?.type === 'remove'))
      tick('#revisao esta encerrado e o historico segue lido', !!revisao?.closed && rl.length > 0, revisao?.closed ? `por ${revisao.closed.by}` : 'encerrar e gesto do usuario na guia do canal (M3); a CLI tem `channels close revisao` para o dono')
      tick('o encerramento sai do seletor e a guia mostra o historico', null, 'depende da guia do canal (M3)')
    }
    if (step === 13) {
      tick('#cena segue aberto, dono A', !!C && !C.closed && ownerId(C) === A)
      tick('`channels list` de A mostra so #cena como dono', cliLists.channels.json === undefined ? null : JSON.stringify(cliLists.channels.json).includes(`"${C?.name}"`) && !JSON.stringify(cliLists.channels.json).includes('"revisao"'), cliLists.channels.json === undefined ? 'sem CLI' : '')
    }
    if (step === 14) {
      tick('o Codex nao esta mais em #cena', !memberByName(C, GUIDE_NAMES.codex))
      tick('aviso de saida no historico', cl.some(l => l.event?.type === 'leave'))
    }
    if (step === 15) {
      tick('#cena esta encerrado', !!C?.closed, C?.closed ? `por ${C.closed.by}` : '')
      tick('o historico fica', cl.length > 3, `${cl.length} linhas`)
      tick('a mesa nao tem mais dono', !!cena && !objects?.desk?.[cena.id]?.owner)
    }
    say(failed ? `\n${failed} item(ns) FALTA` : '\nsem item FALTA (os [n/a] pedem o olho ou a tela do M3)')
  }
}
process.exit(0)
