// `npm run emblems:derive`: regenerates app/renderer/emblem-icons.ts, the icons a tab emblem can wear (docs/tab-emblems-preview.html).
// The CATALOG below is the curation: categories in picker order, each icon with its Portuguese search words. The English
// words come from Phosphor's own tags (@phosphor-icons/core); the drawing is the fill weight, inlined as the SVG's inner
// markup so the renderer can put each one in a <symbol> only when something shows it.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const { icons: phosphor } = require('@phosphor-icons/core')
const FILL = join(here, '..', 'node_modules', '@phosphor-icons', 'core', 'assets', 'fill')

/** [category id, label, category icon, [[phosphor name, Portuguese words], …]] */
const CATALOG = [
 ['trabalho','Trabalho','briefcase',[
  ['briefcase','maleta pasta trabalho cliente negócio emprego'],['handshake','aperto de mão acordo negócio parceria cliente'],['buildings','prédio empresa escritório cidade'],['building-office','escritório empresa sede'],['storefront','loja comércio vitrine'],['money','dinheiro grana pagamento'],['currency-dollar','dólar dinheiro preço custo'],['coins','moedas dinheiro custo'],['wallet','carteira dinheiro'],['credit-card','cartão crédito pagamento'],['receipt','recibo nota fiscal conta'],['invoice','fatura cobrança nota'],['chart-line-up','gráfico crescimento alta métrica'],['chart-bar','gráfico barras relatório métrica'],['chart-pie','gráfico pizza relatório'],['presentation-chart','apresentação reunião slide'],['target','alvo meta objetivo foco'],['trophy','troféu vitória prêmio conquista'],['medal','medalha prêmio conquista'],['crown','coroa rei vip principal'],['calendar','calendário agenda data prazo'],['calendar-check','calendário feito agendado'],['clock','relógio hora tempo'],['hourglass','ampulheta espera tempo prazo'],['timer','cronômetro tempo prazo'],['kanban','kanban quadro tarefas'],['list-checks','lista tarefas checklist feito'],['clipboard-text','prancheta lista nota'],['note','nota anotação'],['notebook','caderno anotações'],['folder','pasta arquivo projeto'],['archive','arquivo guardar caixa'],['stamp','carimbo aprovado oficial'],['seal-check','selo verificado aprovado'],['scales','balança justiça jurídico lei'],['gavel','martelo juiz jurídico lei'],
 ]],
 ['comunicacao','Comunicação','chat-circle',[
  ['chat-circle','conversa chat mensagem balão'],['chats','conversas chat grupo'],['chat-text','mensagem texto conversa'],['envelope','email carta correio mensagem'],['envelope-open','email aberto lido'],['paper-plane-tilt','enviar avião papel mensagem'],['phone','telefone ligação'],['video-camera','vídeo câmera chamada reunião'],['megaphone','megafone anúncio aviso divulgação'],['bell','sino notificação aviso'],['at','arroba email menção'],['hash','hashtag canal número'],['quotes','aspas citação'],['translate','tradução idioma língua'],['microphone','microfone voz áudio gravar'],['broadcast','transmissão ao vivo sinal'],['rss','rss feed notícias'],['share-network','compartilhar rede'],
 ]],
 ['pessoas','Pessoas','user',[
  ['user','pessoa usuário perfil'],['users','pessoas grupo equipe time'],['users-three','equipe time grupo'],['user-circle','perfil pessoa conta'],['identification-card','crachá identidade documento'],['baby','bebê criança filho'],['person','pessoa corpo'],['person-simple-run','correr corrida pressa exercício'],['student','estudante aluno escola'],['chalkboard-teacher','professor aula ensino'],['detective','detetive investigar espião'],['smiley','sorriso feliz alegre'],['smiley-sad','triste chateado'],['heart','coração amor favorito'],['hand-waving','acenar oi olá'],['hands-clapping','palmas aplauso parabéns'],['thumbs-up','joinha positivo curtir aprovado'],['thumbs-down','negativo descurtir reprovado'],['house','casa lar pessoal família'],['dog','cachorro cão pet'],['cat','gato pet'],
 ]],
 ['codigo','Código','code',[
  ['code','código programação dev'],['terminal-window','terminal console linha de comando shell'],['bug','bug erro defeito inseto'],['git-branch','git ramo branch versão'],['git-merge','git merge juntar'],['git-pull-request','pull request revisão pr'],['github-logo','github git repositório'],['database','banco de dados dados'],['cloud','nuvem servidor'],['cloud-arrow-up','nuvem enviar upload deploy'],['hard-drives','servidor disco armazenamento'],['cpu','processador cpu chip'],['robot','robô bot agente ia automação'],['brain','cérebro ia inteligência mente'],['sparkle','brilho ia mágica novidade'],['rocket','foguete lançamento deploy produção'],['rocket-launch','lançamento deploy subir'],['flask','frasco teste experimento laboratório'],['test-tube','tubo ensaio teste'],['wrench','chave inglesa ferramenta conserto manutenção'],['gear','engrenagem configuração ajuste'],['plug','tomada plugin conexão integração'],['puzzle-piece','quebra-cabeça peça extensão plugin'],['package','pacote caixa entrega módulo'],['stack','pilha camadas stack'],['brackets-curly','chaves json código objeto'],['file-code','arquivo código'],['browser','navegador web site'],['globe','globo internet mundo web'],['wifi-high','wifi rede internet'],['key','chave senha acesso'],['lock','cadeado trancado seguro privado'],['lock-open','cadeado aberto destrancado'],['shield-check','escudo seguro proteção segurança'],['fingerprint','digital identidade biometria'],
 ]],
 ['status','Estado','flag',[
  ['flag','bandeira marca sinal'],['flag-checkered','bandeira chegada fim concluído'],['check-circle','feito pronto concluído ok certo'],['x-circle','erro cancelado fechar errado'],['warning','aviso atenção cuidado alerta'],['warning-octagon','pare atenção perigo'],['info','informação info'],['question','pergunta dúvida ajuda'],['prohibit','proibido bloqueado não'],['pause-circle','pausa pausado esperando'],['play-circle','tocar rodando iniciar'],['stop-circle','parar parado'],['spinner','carregando em andamento processando'],['hourglass-medium','esperando aguardando'],['eye','olho ver revisar observar'],['eye-slash','oculto escondido privado'],['push-pin','alfinete fixar fixado importante'],['bookmark-simple','marcador salvar favorito'],['star','estrela favorito destaque importante'],['lightning','raio rápido urgente energia'],['fire','fogo urgente quente prioridade'],['siren','sirene urgência emergência alarme'],['seal-warning','selo atenção'],['circle-dashed','rascunho incompleto pendente'],['trash','lixo apagar excluir'],
 ]],
 ['midia','Mídia e design','image',[
  ['image','imagem foto figura'],['camera','câmera foto'],['film-strip','filme vídeo cinema'],['music-notes','música notas som'],['headphones','fone ouvir áudio'],['palette','paleta cor design arte'],['paint-brush','pincel pintar arte design'],['pen-nib','caneta design desenho vetor'],['pencil-simple','lápis editar escrever'],['ruler','régua medida'],['figma-logo','figma design'],['shapes','formas geometria design'],['magic-wand','varinha mágica'],['book-open','livro ler estudo leitura'],['books','livros biblioteca estudo'],['newspaper','jornal notícia'],['article','artigo texto blog'],['text-aa','texto fonte tipografia'],['youtube-logo','youtube vídeo'],['television','televisão tv'],
 ]],
 ['lugares','Lugares e viagem','map-pin',[
  ['map-pin','pino local mapa endereço'],['map-trifold','mapa'],['compass','bússola direção navegar'],['globe-hemisphere-west','globo mundo brasil américa'],['airplane','avião viagem voo'],['car','carro automóvel'],['bicycle','bicicleta bike'],['train','trem metrô'],['boat','barco navio'],['suitcase','mala viagem'],['tent','barraca acampar'],['mountains','montanha natureza trilha'],['island','ilha praia férias'],['flag-banner','faixa bandeira evento'],['signpost','placa caminho direção'],['warehouse','galpão armazém estoque'],['hospital','hospital saúde'],['bank','banco instituição'],
 ]],
 ['natureza','Natureza e tempo','leaf',[
  ['leaf','folha natureza verde ecologia'],['plant','planta crescer broto'],['tree','árvore natureza'],['flower','flor'],['sun','sol dia claro'],['moon','lua noite escuro'],['cloud-rain','chuva nuvem'],['snowflake','neve floco frio gelo'],['drop','gota água'],['wind','vento'],['rainbow','arco-íris'],['butterfly','borboleta'],['bird','pássaro ave'],['fish','peixe'],['paw-print','pata animal pet'],['planet','planeta espaço'],['atom','átomo ciência física'],
 ]],
 ['objetos','Objetos','cube',[
  ['cube','cubo objeto 3d bloco'],['gift','presente aniversário'],['shopping-cart','carrinho compras'],['bag','sacola compras'],['tag','etiqueta tag preço rótulo'],['lightbulb','lâmpada ideia'],['coffee','café pausa'],['pizza','pizza comida'],['hamburger','hambúrguer lanche comida'],['wine','vinho bebida'],['cake','bolo aniversário festa'],['game-controller','controle jogo game'],['dice-five','dado jogo sorte'],['soccer-ball','bola futebol esporte'],['barbell','academia peso treino'],['first-aid','primeiros socorros saúde médico'],['pill','remédio pílula saúde'],['heartbeat','batimento saúde coração'],['anchor','âncora'],['hammer','martelo ferramenta construir'],['scissors','tesoura cortar'],['paperclip','clipe anexo'],['magnifying-glass','lupa buscar pesquisar'],['diamond','diamante valioso premium'],['infinity','infinito'],['ghost','fantasma'],['skull','caveira perigo morto'],['alien','alien et'],['umbrella','guarda-chuva proteção'],
 ]],
]


const tags = new Map(phosphor.map(i => [i.name, i.tags.filter(t => !t.startsWith('*'))]))
const inner = n => {
  const file = join(FILL, n + '-fill.svg')
  if (!existsSync(file)) throw new Error('no Phosphor fill icon: ' + n)
  return readFileSync(file, 'utf8').replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<rect[^>]*fill="none"[^>]*\/>/g, '').trim()
}
const seen = new Set()
const icons = []
for (const [cat, , , items] of CATALOG) for (const [n, pt] of items) {
  if (seen.has(n)) continue
  seen.add(n)
  icons.push({ n, c: cat, pt, en: (tags.get(n) ?? []).join(' '), d: inner(n) })
}
for (const [, , ci] of CATALOG) if (!seen.has(ci)) throw new Error('category icon outside the catalog: ' + ci)
const out = `// GENERATED by app/emblem-icons-derive.mjs (npm run emblems:derive). Do not edit: change the catalog there.
// Phosphor Icons (@phosphor-icons/core, MIT), fill weight: the inner markup of each 256x256 SVG.

export interface EmblemCategory { id: string; label: string; icon: string }
/** n: Phosphor name · c: category · pt / en: search words · d: SVG inner markup (viewBox 0 0 256 256). */
export interface EmblemIcon { n: string; c: string; pt: string; en: string; d: string }

export const EMBLEM_CATEGORIES: readonly EmblemCategory[] = [
${CATALOG.map(([id, label, icon]) => ' ' + JSON.stringify({ id, label, icon }) + ',').join('\n')}
]

export const EMBLEM_ICONS: readonly EmblemIcon[] = [
${icons.map(i => ' ' + JSON.stringify(i) + ',').join('\n')}
]
`
writeFileSync(join(here, 'renderer', 'emblem-icons.ts'), out)
console.log('emblem-icons.ts:', icons.length, 'icons,', Math.round(out.length / 1024), 'KB')
