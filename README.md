# tether (nome provisório)

**Cada terminal sabe qual sessão de agente ele estava rodando, e a retoma depois de qualquer reinício.**

Funciona com **Claude Code** (`claude`) e **soul-cli** (`soul`), num app de terminais com painéis livres (Electron) e numa linha de comando.

> Status: **app e gestão de sessões funcionando**, provados com testes de ponta a ponta contra o Claude e o soul reais. O soul precisa da versão com `SOUL_SESSION_REPORT` instalada (branch `feat/session-report` do soul-cli). Detalhes em [PROGRESS.md](./PROGRESS.md).

## O problema

Você abre vários terminais, cada um com um agente numa pasta. O terminal reinicia ou trava, e todos voltam vazios. As sessões continuam salvas em disco, mas você não sabe mais qual era qual.

## Como o tether resolve

- Cada terminal é um **slot**, com um ID que não muda.
- O tether lança o agente no slot, e **o próprio agente avisa** o tether sempre que a sessão muda (sessão nova, `/clear`, `/resume`, `/new`, `/branch`, `/rename`…).
- O tether guarda esse vínculo em disco. Depois de fechar, travar ou reiniciar, `tether open <slot>` retoma exatamente a sessão certa.

O tether nunca deduz a sessão pela data ou pela pasta. Se o agente não confirmou, o slot aparece como **"não confirmado"** e o tether pergunta antes de retomar.

| Agente | Como avisa o tether |
|---|---|
| Claude Code | Hooks `SessionStart` / `SessionEnd`, injetados via `--settings` apenas nos processos lançados pelo tether. Suas configurações globais não mudam. |
| soul-cli | Variável `SOUL_SESSION_REPORT`: o cliente do soul grava cada troca de sessão no arquivo do slot (branch `feat/session-report`). |

## Como usar (app, Windows)

O app roda direto desta pasta do repositório; nada é instalado na máquina além de um atalho no Menu Iniciar do usuário.

1. **Instalar o atalho** (uma vez, dentro da pasta do repositório): `npm ci` e depois `npm run app:install`. Isso compila o app e cria **"tether"** no Menu Iniciar (`%APPDATA%\Microsoft\Windows\Start Menu\Programs\tether.lnk`), com ícone. Pode fixar na barra de tarefas. `npm run app:uninstall` remove o atalho.
2. **Abrir:** Menu Iniciar → tether. Não abre console nem precisa de terminal. O app sobe o `tetherd` sozinho (precisa do `node` ≥ 24 no PATH do usuário, ou da variável `TETHER_NODE` apontando para o `node.exe`). Abrir de novo com o app já aberto só traz a janela existente para frente.
3. **Novo painel:** `Ctrl+N` (ou o "+" da faixa de abas) abre uma aba vazia no grupo com o seletor dentro — digite (`claude`, `soul`, `bash`, `nota`…), `1`–`9` ou clique, e o painel vira aquilo no mesmo lugar; Esc fecha a aba. O "+" das bordas faz o mesmo na borda do quadro ou da mesa (clique direito: duplicar). "+ Novo painel…" (topo, ≡, paleta) é o mesmo seletor numa janela, com a linha "Onde" (como aba, ao lado, na borda do quadro, num quadro novo).
4. **Duplicar painel:** `Ctrl+Alt+←/→/↑/↓` abre, ao lado do painel em foco, outro painel com o mesmo perfil e a mesma pasta — numa **sessão nova** (a conversa do painel de origem não é compartilhada). Também no botão "Duplicar painel" (à direita), no menu ≡ e no clique direito da aba. `Ctrl+` (à direita) e `Ctrl+K Ctrl+` (abaixo) são os apelidos do VS Code ("dividir editor"). Para mover um painel, arraste a aba para a borda de outro (dentro do mesmo quadro).
   **Copiar e colar no terminal:** `Ctrl+C` com texto selecionado copia (e limpa a seleção) sem mandar nada ao processo; sem seleção, `Ctrl+C` é o `^C` de sempre (interrompe o Claude, servidores, shells). `Ctrl+Shift+C` sempre copia. `Ctrl+V` e `Ctrl+Shift+V` colam o texto da área de transferência (com *bracketed paste* quando o programa pede); com a área de transferência sem texto (uma captura de tela), `Ctrl+V` manda o `^V` ao processo, e o Claude cola a imagem sozinho. Com o programa em modo mouse (o Claude em tela cheia), selecione com `Shift` + arrastar. Um programa que escreve OSC 52 (tmux, neovim) também chega à área de transferência do Windows.
5. **Quadros:** a mesa é dividida em quadros, cada um com sua própria divisão de painéis. `Ctrl+Alt+Shift+seta` duplica o painel em foco na **borda do quadro** (ocupa a altura ou a largura inteira); `Alt+Shift+seta` duplica num **quadro novo na borda da mesa**. Com o mouse, um "+" aparece perto das bordas (pequeno = borda do quadro, maior = borda da mesa): clique duplica, clique direito ou Shift+clique abre o seletor. No seletor ("Novo painel…"), a linha "Onde" tem os três níveis: Painel / Quadro / Mesa. Um quadro some quando o último painel dele fecha. Os atalhos vivem num só lugar: `app/renderer/shortcuts.ts`; a tela **Atalhos de teclado** (`Ctrl+K Ctrl+S`, também no ≡ e na paleta) lista todos e grava outros.
6. **Layout:** `layout.json` passou para a versão 2 (mesas → quadros → painéis). Um arquivo antigo é migrado na primeira abertura sem perder nenhum painel; a cópia fica em `layout.v1.bak`.
7. **Fechar um painel** pergunta: *encerrar o agente* (mata o processo) ou *só fechar o painel* (o agente continua no `tetherd` e aparece em "Slots fechados" para reabrir).
8. **Fechar a janela** (`Ctrl+Shift+W` ou o X) só desconecta: os terminais continuam vivos no `tetherd`, e ao reabrir o app o layout e os painéis voltam como estavam. **Arquivo → "Sair e encerrar tudo…"** (`Ctrl+Shift+Q`) mata todos os agentes, derruba o `tetherd` e fecha.
9. **Onde fica o estado:** `%LOCALAPPDATA%\tether` (`TETHER_HOME` sobrescreve): `slots\` (vínculos slot → sessão), `layout.json`, `recent-folders.json`, `tetherd.pid`, `tetherd.log` e `electron\` (cache do Electron).
10. **Depois de mudar o código:** o atalho nunca recompila. Rode `npm run app:build` (ou `npm run app:install` de novo) e reabra o app; `npm run app` compila e abre numa tacada só, para desenvolvimento.

## A janela

Tudo o que se vê vive sobre uma superfície só (a cor da mesa), com os quadros como cartões arredondados em cima dela e um respiro de 8 px em volta e entre eles. O tema (Claro / Automático / Escuro) troca ao vivo.

- **Barra do topo:** à esquerda só ícones (novo painel, duplicar, perfis, slots fechados); no centro a **cápsula de mesas**; à direita o estado da conexão (clique abre o painel com serviço, canal, processo, versão e agentes, e "Reiniciar serviço"), o menu de tema e o menu ≡. A cápsula fica sempre no centro verdadeiro da janela.
- **Mesas (cápsula):** cada mesa é um segmento com a sua cor (12 matizes). `Ctrl+Tab` / `Ctrl+Shift+Tab` percorrem, `Ctrl+1…9` vão direto, `Ctrl+Shift+N` cria, `Ctrl+K F` fecha (confirma). Clique troca; duplo clique renomeia; clique direito (ou a tecla de menu) abre as ações da mesa (renomear, cor, mover, fechar). O selo no segmento conta painéis que terminaram ou esperam você. Quando as mesas não cabem, um **"+N"** fixo à direita lista as outras: a escolhida entra no lugar da mesa usada há mais tempo (as demais não se mexem; a mesa ativa nunca sai) e a cápsula anima a troca. Uma linha fina da cor da mesa ativa marca o topo da mesa (liga e desliga no menu ≡). **Reordenar:** arraste um segmento na cápsula; as vizinhas abrem espaço, soltar encaixa e `Esc` cancela (arraste menor que 4 px é clique). Com o **"+N"** à mostra, a mesa solta fica logo depois da vizinha visível à esquerda na fila completa. Pelo teclado: `Shift+←/→/Home/End` com o foco na cápsula e `Ctrl+K Shift+←/→` (mesa ativa); no menu da mesa, "Mover para o início" e "Mover para o fim".
- **Quadros e painéis:** a mesa é um conjunto de quadros; cada quadro tem seus painéis em abas (e pode dividi-los). Cada faixa de abas tem à direita, fixos, o **"+N"** das abas que não cabem (a escolhida entra no lugar da usada há mais tempo), o botão da **barra de status** e o **⋯** (o menu do painel, o mesmo do clique direito). A **barra de status** (recolhida por padrão; `Ctrl+Shift+H`) mostra o estado como ícone, o perfil, a pasta e "sem restrições" quando for o caso, com três ações só de ícone: trocar perfil, abrir a pasta no Explorer e copiar a pasta.
- **Gaveta:** ``Ctrl+` `` (ou `Ctrl+Shift+G`, ou a pílula "Gaveta" da cápsula) abre uma mesa rápida, **a mesma para todas as mesas**, num cartão por cima de tudo (16 px das bordas, sem fundo escurecido: os cartões de trás esmaecem). Ela tem barra própria (novo painel, duplicar, a pílula pressionada que fecha, e o X) e, por dentro, quadros e painéis como qualquer mesa. Fecha pela pílula, pelo X, pela margem de 16 px, por `Esc` (a regra do terminal vem antes) e por ``Ctrl+` ``. Sem painéis, mostra um convite ("Novo painel…" e "Terminal rápido").
- **Prancheta acompanha o painel/mesa:** a configuração `ui.padsFollowFocus` ("Prancheta acompanha o painel/mesa", em Configurações > Janela, ou `"ui": { "padsFollowFocus": true }` no `settings.json`; desligada por padrão) faz a prancheta do painel e a da mesa ficarem abertas só no painel ou na mesa em que foram abertas: fecha ao sair do painel ou mesa e reabre ao voltar. O ícone abre e fecha só para o painel ou mesa atual. Desligada, a barra lateral fica aberta e troca o conteúdo junto com o painel ou a mesa. A prancheta global não muda.
- **Atalhos:** o esquema do VS Code (Windows) traduzido: aba = painel, grupo de editores = quadro, janela = mesa, painel do terminal = gaveta. Vivem num só registro, `app/renderer/shortcuts.ts` (as teclas, os rótulos dos tooltips e dos menus saem dele), por id de comando. **`Ctrl+K Ctrl+S` abre a tela "Atalhos de teclado"** (uma aba): busca por nome ou pela tecla, duplo clique grava outra tecla (chord de duas teclas vale; um conflito é resolvido no ato: o outro comando perde a tecla, ↺ devolve), os chips **Janela · Terminal · Nota** dizem onde o atalho é do app (Terminal desligado = a tecla passa ao programa), ↺ volta ao padrão. O que você muda vai para `keybindings.json` na pasta do tether (formato do VS Code, com `where` no lugar de `when`; `-id` tira um padrão; editar à mão aplica na hora; arquivo inválido mostra um aviso e os padrões valem). **Ctrl+K é o prefixo dos atalhos de duas teclas**, também no terminal (como no VS Code): uma pílula no rodapé mostra a espera e, depois de ~800 ms, o que pode vir; `Ctrl+K` duas vezes manda o `^K` ao programa; Esc cancela. Dentro de um terminal, `Ctrl+letra` pura é do programa (`Ctrl+W` apaga a palavra, `Ctrl+O` é o modo detalhado do Claude), salvo `Ctrl+P`, `Ctrl+N` e `Ctrl+K`; `Ctrl+F4` fecha o painel em todo lugar, `Ctrl+W` fecha fora do terminal; `Ctrl+Shift+T` reabre o último painel fechado (o slot retoma); `Ctrl+PgUp/PgDn` e `Alt+1…9`/`Alt+0` andam nas abas do quadro; `Ctrl+K Ctrl+setas` focam o painel vizinho; `Ctrl+=` / `Ctrl+-` / `Ctrl+0` mudam a fonte do terminal; `F2` renomeia; `Ctrl+O` abre uma nota; `Ctrl+S` salva a nota agora; `Ctrl+Shift+V` abre a prévia da nota (`Ctrl+K V` ao lado).
- **Comandos e paleta:** toda ação do app é um comando com id estável (`app/renderer/app-commands.ts`); o menu ≡, as teclas e a paleta leem do mesmo registro. `Ctrl+Shift+P` abre a paleta (busca aproximada, atalho ao lado, recentes primeiro, Enter executa, Esc fecha); `Ctrl+P` abre a mesma caixa no modo "Ir para…" (arquivos chegam numa próxima entrega; `>` vira comandos). Dentro de um terminal, Ctrl+letra é do programa, exceto Ctrl+P (lista explícita em `app/renderer/key-capture.ts`).
- **Teclado:** tudo o que a barra tem se alcança com `Tab`, com foco visível. Na cápsula, `←/→/Home/End` movem o foco entre as mesas e `Enter` troca; nos menus (tema, ≡, "+N", ⋯) `↑/↓/Home/End` navegam, `Enter` escolhe e `Esc` fecha devolvendo o foco ao botão. Com "reduzir movimento" no sistema, as animações (a da cápsula, a da gaveta, o esmaecer) ficam desligadas.

## Pausa gentil

O botão **Pausar** (barra do topo, ao lado dos slots fechados) pede a cada agente em andamento que **pare no seu próprio passo**, sabendo que é temporário. Nada é forçado: sem Esc, sem prazo punitivo. Parar à força continua sendo o tether (Parar o slot).

- **Como o pedido chega:** o hook do Claude entrega o texto como contexto no próximo passo do agente (depois de uma ferramenta ou de um prompt). O agente responde pela CLI: \`tether pause ack "<o que está fazendo>"\` ao receber e \`tether pause done "<nota para retomar>"\` ao parar. \`tether pause status\` mostra o pedido.
- **Estados de cada agente:** na fila, ouvindo, pedido enviado, pedido recebido, preparando para parar, **parou** (com a nota dele) ou **parou sem nota** (o agente terminou o turno sem avisar: vale a última mensagem dele). Passados 5 min em "enviado/preparando", o rótulo vira "ainda finalizando".
- **Acompanhar:** o contador "2/5" ao lado do ícone e o menu do botão listam os agentes (Abrir painel, Tirar da fila); **Acompanhar…** (ou o comando \`pause.manage\`) abre o popup com a lista, a nota de cada um e a linha do tempo ao vivo.
- **Retomar:** escreve no terminal de cada agente que parou pelo pedido \`[tether] Retomando a pausa. Sua nota: "…". Continue de onde parou.\` (3 por vez, só com o agente ocioso). **Cancelar pausa** desfaz o pedido.
- **A bolinha da guia:** laranja sólido = pede sua atenção (terminou ou espera você; vence tudo), verde discreto = em andamento (sem pulso), nada = ocioso.
- Um lote por vez. Soul ainda não participa (a leitura do pedido pelo soul é a fatia C).

## Tether Bridge

O **Tether Bridge** é a extensão de navegador que deixa os agentes dos painéis (Claude, soul) usarem o **seu** Chrome, Edge ou Brave — só nas abas que eles abriram ou que você entregou — por um serviço local (o daemon do bridge, em `127.0.0.1:47831`) que o tetherd sobe sozinho. Ele vem **dentro do tether** (`extensions/web-bridge/vendor/`): nada para baixar, nenhuma loja.

- **Instalar (uma vez por navegador):** menu ≡ → **"Instalar Tether Bridge…"** (ou na paleta). Escolha o navegador; o tether copia a extensão para `%LOCALAPPDATA%\tether\web-bridge\current`, abre a página de extensões do navegador e mostra os três passos: ligue o **Modo do desenvolvedor**, clique em **"Carregar sem compactação"** e escolha a pasta (o botão **Copiar caminho** está ali). A extensão encontra o daemon sozinha (porta e token ficam no `bridge.json` da pasta) e o tether confirma "conectado". Enquanto a extensão vier por esta pasta, o navegador pode avisar ao abrir que há extensões no modo do desenvolvedor: é o preço de não vir da loja.
- **O que os agentes ganham:** todo `claude`/`soul` lançado pelo tether recebe o servidor MCP `tether-bridge` (`%LOCALAPPDATA%\tether\mcp\tether-bridge.json`, via `--mcp-config`), com as ferramentas de navegar, ler, clicar, digitar, tirar print, rodar código na página (`evaluate`, por padrão só nas abas do próprio agente), baixar, enviar arquivo, PDF e ler a rede. Cada painel é um cliente com nome (`Claude · api`): o navegador agrupa as abas dele numa janela própria, e quando o painel encerra as abas são soltas (ficam abertas, saem do controle).
- **O ícone de status** (barra do topo, à direita): cinza sem navegador conectado; normal com o número de navegadores; um ponto enquanto algum agente está usando o navegador (últimos 10 s); âmbar pausado; vermelho se o daemon caiu (a próxima chamada o reergue). Clique abre o popover: navegadores (abas sob controle), agentes (clique na linha leva ao painel), **Pausar/Retomar**, **Retomar todas as abas**, **Instalar em outro navegador…**, **Opções da extensão** e a versão da extensão.
- **Pausar** é o botão de emergência: o daemon solta **todas** as abas sob controle em todos os navegadores (ficam abertas, as faixas somem) e toda chamada de agente é recusada com `BRIDGE_PAUSED` até **Retomar** — o agente recebe a mensagem e espera. O mesmo botão existe no popup da extensão.
- **Desligar para os agentes:** a configuração `extensions.web-bridge.serveToAgents` (em `%LOCALAPPDATA%\tether\settings.json`, `false`) deixa de oferecer o MCP aos agentes lançados a partir daí; o daemon e a extensão continuam disponíveis para o resto. `agentWindows` (janela própria por agente) e `evaluate` (`own-tabs` / `all` / `off`) são as outras duas.
- **Atualizações:** quando um tether novo traz um bridge novo, o tetherd ao subir troca os arquivos da pasta instalada (arquivo a arquivo, o `bridge.json` fica), grava a versão nova para o daemon, reinicia o daemon antigo (só depois de provar que o processo é o do bridge e dono da porta) e a extensão, ao reconectar, **se recarrega sozinha** uma vez. Se o navegador tiver desativado a extensão (acontece com o Modo do desenvolvedor desligado), `tether doctor` e o rodapé do popover pedem "Recarregar" em `chrome://extensions`.
- **`tether doctor`** tem três checks do bridge: a cópia vendorizada e a instalação (`%LOCALAPPDATA%\tether\bridge`: `config.json`, `api.key`, o arquivo MCP), o daemon respondendo na porta, e a extensão instalada no navegador (não instalada / na versão X / AVISO "recarregue").
- **Onde fica:** `%LOCALAPPDATA%\tether\bridge\` (config, chave, `daemon.pid`, `daemon.log`, `daemon.build.json`), `web-bridge\current\` (a extensão) e `web-bridge\update-pending.json` (o aviso de recarregar). `TETHER_BRIDGE_PORT` muda a porta (os testes usam uma livre).

**Marca e revendorização (desenvolvimento).** A marca do app e da extensão nasce de `brand/brand.json` + `brand/src/{light,dark}/*.svg`. O ciclo: edite um SVG no Inkscape → `npm run brand:derive` (regenera `brand/assets/app/` e, com o fonte do bridge na máquina, `brand/assets/bridge/`) → `npm run app:build` e `npm run bridge:build`. O `bridge:build` roda a toolchain do bridge (`scripts/brand-derive.ts` + `scripts/build.ts --brand`) e copia o resultado para `vendor/`; o fonte vem de `--bridge <pasta>`, `TETHER_BRIDGE_SRC` ou `../../chrome-extensions/bridge`, com `npm ci` feito. **Vendorize sempre de um commit fixado, nunca de uma árvore em edição:** a versão da extensão é `<bridge>.<nº de commits até o HEAD>` (ex.: `0.1.0.5739`), então a cópia precisa de `.git` — `git clone --no-hardlinks --no-checkout <repo> <pasta>` + `git sparse-checkout set --cone chrome-extensions/bridge packages/browser` + `git checkout --detach <sha>` + `npm ci` no bridge (um `git archive` sairia sem carimbo, `0.1.0`, e a extensão instalada nunca se recarregaria). Commite `brand/assets/`, `extensions/web-bridge/vendor/` e reinicie o tetherd.

## Linha de comando (`tether`)

`node bin/tether.mjs <comando>` (ou `tether` depois de `npm link`). A CLI é um cliente do `tetherd`: com o daemon rodando (o app o sobe sozinho), `new`/`open` criam e retomam slots dentro dele, visíveis no app; sem daemon, `ls`/`show`/`rm`/`rename` leem o disco e `new`/`open` rodam o agente **neste terminal** (`--here` força isso mesmo com o daemon de pé). Saída em português; código de saída 0 ok, 1 erro, 2 uso.

```powershell
# cria um slot e abre o Claude nele (no tetherd; veja no app ou com `tether attach`)
tether new claude --name api --cwd D:\sources\api

# a mesma coisa, mas rodando o Claude aqui neste terminal (args depois de `--` vão para o agente)
tether new claude --name api --cwd D:\sources\api --here -- --model haiku

# cria um slot com o soul, ou com um shell puro
tether new soul --name pesquisa --cwd D:\atrium\workspace\agente-x
tether new shell --name term --cwd D:\sources

# depois de reiniciar: lista os slots e o que cada um estava fazendo (--json: estado bruto)
tether ls
#  SLOT      NOME      AGENTE  PASTA            SESSÃO     TÍTULO            ESTADO          ÚLTIMA ATIVIDADE
#  a1b2c3d4  api       claude  …\sources\api    0b6f1234…  refatorar parser  parado          há 2 h
#  c3d4e5f6  pesquisa  soul    …\agente-x       7e21aaaa…  revisão do PRD    não confirmado  há 5 min

# retoma um slot (id, prefixo único do id ou nome); --new abre sessão nova; --here retoma neste terminal
tether open api
tether open c3d4 --new

# anexa este terminal a um slot do tetherd (Ctrl+] solta; o slot continua rodando)
tether attach api

# vínculo e histórico de eventos; encerrar; renomear; esquecer (pede confirmação, --yes pula)
tether show api
tether stop api
tether rename api backend
tether rm backend

# confere o ambiente
tether doctor
```

Regras de confiança na retomada (PRD §6.6): o `open` recusa, com a correção na mensagem, um vínculo **não confirmado** (use `--new` ou `--resume-anyway`), uma sessão que o agente não tem mais (`--new`), uma pasta que sumiu (`tether rm`) e uma sessão já aberta em outro slot (`tether attach`). Variáveis: `TETHER_HOME` (pasta de estado), `TETHER_PIPE` (pipe do daemon) e `TETHER_CLAUDE_ARGS` / `TETHER_SOUL_ARGS` (argumentos acrescentados pelo `tetherd` a todo lançamento do agente, ex.: `--model haiku` nos testes).

## Tether Browser (extensão `browser`)

Uma mesa "Browser" onde os agentes dos painéis abrem guias de um navegador de verdade (uma `WebContentsView` do Electron por guia), que você acompanha, assume e devolve. A prancheta "Guias" (barra esquerda) lista as guias por agente, com pausa, fechamento e o que foi baixado.

- **Ligar.** Desligado por padrão. Em Configurações, `extensions.browser.serveToAgents` ("Oferecer o navegador aos agentes dos painéis") injeta o servidor MCP `tether-browser` nos agentes lançados depois da mudança. O texto da chave diz o alcance: "Os agentes do tether recebem as ferramentas do navegador e podem usar todas as contas logadas nas guias." Há uma partição só, para todos os agentes. `extensions.browser.evaluate` (desligado) libera JavaScript na página. Ligar ou desligar a extensão inteira pede reiniciar o app.
- **Rede local.** A página nunca alcança `localhost`, a rede local nem `file:`. Quando o agente pede um endereço local, o tether pergunta a você ("Permitir que o agente abra localhost:5173?"); `extensions.browser.localNetwork` guarda a resposta (`ask`, `allow`, `deny`).
- **O que o agente pode.** Navegar, ler, clicar, digitar, tirar print, baixar arquivos (para `<home>/browser/downloads/<agente>/`, com teto) e enviar arquivos só com o seu OK por envio, mostrando o site dono do campo. Só enxerga as guias que ele mesmo abriu.
- **O que não pode.** Ler ou exportar cookies e credenciais (o porteiro filtra os eventos de rede), usar um depurador do Chromium aberto (não existe porta aberta), redimensionar ou emular a guia, abrir permissões de site (câmera, localização e notificações são negadas), agir numa guia que você assumiu. Um agente enganado por uma página ainda pode **usar** as contas logadas; ele não as leva.
- **Logins guardados.** Só com o runtime de cookies cifrados, que o `npm run app:install` prepara (o atalho do Menu Iniciar o usa). Fora dele (`npm run app`, testes) as guias ficam numa partição em memória e os logins acabam com o app. Mesmo com a trava, o cache HTTP das guias fica desligado, e o que as páginas guardam para si (IndexedDB, localStorage, caches de service worker) é apagado ao abrir e ao fechar o app: só os cookies passam de uma abertura para a outra. Com o app aberto esses dados ficam no disco em texto puro, protegidos só pela pasta do seu perfil; um site que dependa do localStorage entre aberturas começa do zero a cada vez. Downloads com tipo que executa ou que o Explorer lê ao listar a pasta (`.exe`, `.url`, `.lnk`...) chegam com `.download` no fim, e todo download leva a marca da web. Limite: a trava cifra só o valor do cookie (nome e site seguem legíveis) e não protege de um programa rodando na sua conta.

## Onde fica o estado

```
%LOCALAPPDATA%\tether\slots\<slotId>.jsonl   eventos de sessão do slot (append-only)
%LOCALAPPDATA%\tether\slots\<slotId>.json    nome, agente e pasta do slot
%LOCALAPPDATA%\tether\layout.json            layout dos painéis do app
```

São arquivos de texto simples, legíveis e fáceis de inspecionar. O tether nunca altera os arquivos de sessão do Claude ou do soul, nem as configurações globais deles.

## Arquitetura

```
app (Electron: dockview + xterm.js)  ──pipe──►  tetherd (Node: um PTY por slot)  ──►  claude / soul / shell
                                                       ▲
                       hooks do Claude / SOUL_SESSION_REPORT gravam <slot>.jsonl
```

- **tetherd** segura os terminais num processo separado da janela: fechar ou travar o app não mata os agentes.
- Se o tetherd morrer (ou a máquina reiniciar), cada slot é retomado pela sessão registrada no seu `.jsonl`.
- Ao reabrir muitos painéis, no máximo 3 agentes sobem ao mesmo tempo; os outros esperam "na fila".

## Desenvolvimento

TypeScript executado direto pelo Node 24 (sem build), zero dependências de runtime além do `node-pty`.

| Comando | O quê |
|---|---|
| `npm run check` | typecheck + testes unitários |
| `npm run test:e2e` | ponta a ponta com o Claude real (`--model haiku`); a suíte do soul precisa de `TETHER_SOUL_CMD` apontando para o soul com `SOUL_SESSION_REPORT` |
| `npm run test:app` | app + tetherd reais, janela escondida |
| `npm run daemon` | sobe o tetherd à mão |
| `npm run app` | compila e abre o app |
| `npm run brand:derive` | regenera os assets da marca a partir de `brand/src` (app e, com o fonte do bridge, extensão) |
| `npm run bridge:build` | compila o Tether Bridge do fonte fixado (`TETHER_BRIDGE_SRC`) e revendoriza em `extensions/web-bridge/vendor/` |

Requisitos, cenários e decisões: [PRD.md](./PRD.md), [PLAN.md](./PLAN.md), [PROGRESS.md](./PROGRESS.md).
