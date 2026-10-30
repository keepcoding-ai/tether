# Progresso — tether fase 1

Fonte da verdade do andamento do [PLAN.md](./PLAN.md). Atualizado a cada tarefa.

| Tarefa | Estado | Prova |
|---|---|---|
| Onda 0 — preparação | concluída | commits d7478f5, ae0a488 |
| T1 Núcleo de estado | concluída | merge 53f0acb; tsc ok; 32/32 testes isolados (liveness lenta sob carga, ver decisão) |
| T2 Adapter Claude | concluída | merge 44c1fe6; 31/31 unit; smoke real (novo + resume) pelo agente |
| T3 Harness E2E | concluída | merge ed10f0a; smoke E2E rodado por mim: 2/2 (51 s); fullscreen intacto |
| T4 CLI (cliente do tetherd) | concluída | merge; 139/139 unit; prova manual pelo agente de todos os comandos; `attach` interativo ainda não provado em TTY |
| T5 soul-cli `SOUL_SESSION_REPORT` | feita, aguarda OK do Guga p/ merge no develop + instalar | branch feat/session-report 0155b7a; 22/22 testes rodados por mim; prova ao vivo no agente serpente (startup, resume, continue, fork) |
| T6 Cenários E2E Claude (via tetherd) | concluída | merge; 101/101 unit; suíte E2E 17/17 rodada por mim (313 s) + 2 execuções verdes pelo agente = 3 seguidas; fullscreen intacto |
| T7 Adapter + cenários soul | concluída | merge; suíte soul 14/14 rodada por mim (324 s) + 2 verdes pelo agente = 3 seguidas; C7 sem equivalente no soul; -H não testado (sem host) |
| T8 Robustez e doctor | concluída | merge; 114/114 unit; doctor rodado por mim (0 erros, 3 avisos esperados); carga pelo agente: 10 slots, máx. 3 iniciando, kill do tetherd, 0 vínculos errados, 101 s ; carga: conserto do teste (PID reaproveitado, recordação) + verde 2x pelo agente + 1x por mim = 3 seguidas, 0 vínculos errados |
| Onda 4 — suíte 3x verde, docs | pendente | |
| A1 App shell (Electron + dockview + xterm) | concluída (A1a) | merge 19b068a; typecheck ok; screenshots revisados por mim: 4 painéis ocupam a janela (defeito de layout do Guga corrigido: faltava o CSS do dockview) |
| A2 tetherd | concluída (A2a + A2b) | A2a: 81/81 unit; prova real com Claude pelo agente; minha prova: shell sobrevive à desconexão do cliente (mesmo PID), histórico no novo cliente, shutdown sem órfãos ; A2b: 95/95 unit; minha prova: soul pelo tetherd, stop + start retoma a mesma sessão (source=resume, mesmo id) |
| A3 Integração app ↔ tetherd + E2E | concluída | merge; 101/101 unit; test:app rodado por mim no main combinado: 4 painéis sobrevivem ao kill da janela (mesmos PIDs) e ao kill do tetherd (reiniciados); janela escondida, nenhuma janela na tela; screenshots revisados |
| A4 Empacotar (npm run app, atalho) | concluída | merge; atalho reinstalado por mim apontando para o checkout principal (lido de volta: alvo electron.exe, ícone, AUMID studio.codr.tether); unit e test:app verdes no main |

## Critério de parada (fase 1, parte automatizável)

- [x] `npm run check` verde (typecheck + unitários): 146/146, tsc ok (rodado por mim após a A5)
- [x] `npm run test:e2e` verde 3 vezes seguidas (Claude e soul): Claude 17/17 ×3, soul 14/14 ×3, carga ×3, app+Claude ×3 (a última de cada, rodada por mim)
- [x] soul-cli: nenhuma falha nova em relação ao develop (critério ajustado; develop limpo já tem 28 erros de tipo e 4 testes quebrados); testes da mudança 22/22 rodados por mim
- [x] README com uso real; PRD atualizado (commits de docs de 2026-10-29)
- [x] App: E2E verdes — layout (4 painéis, kill da janela = mesmos PIDs, kill do tetherd = reiniciados) e app+Claude real (kill da janela = mesmos PIDs e memória; kill do tetherd = mesmas sessões e memória)
- [x] App usado pela interface como o Guga usaria (Novo painel, dividir, digitar no Claude; janela escondida), screenshots revisados por mim; atalho no Menu Iniciar instalado e lido de volta
- [ ] soul instalado na máquina com `SOUL_SESSION_REPORT` (anterior guardado), provado no app
- [ ] Todas as linhas da tabela = concluída, com prova

A semana de uso real (PRD §8) é do usuário.

## Decisões para validar

- Autorizado pelo usuário a tocar o projeto sem parar: `git init` feito; soul-cli será alterado num branch próprio (`tether-session-report`), sem push.
- T1: verificação de processo vivo via PowerShell (start time) leva 0,7–6 s e falha sob carga. Substituir por canal nomeado por slot (`\.\pipe\tether-slot-<id>`) mantido pelo processo dono do slot (launcher da CLI ou tetherd): conectar = vivo. Instantâneo e imune a PID reaproveitado. Entra na A2/T4.
- soul-cli em worktree (`D:\atrium\workspace\soul-cli-tether`, branch `feat/session-report`) em vez de commitar direto no develop: o checkout principal está em uso. Merge no develop depois de provado.
- App em Electron + xterm.js + dockview (sem Rust na máquina; Tauri exigiria MSVC/Visual Studio, vetado). Dependências só por projeto.
- Limite de 2 agentes em paralelo: a onda 1 começou com 4 antes de eu ler esse acordo; não interrompi os que estavam rodando e não lanço novos até sobrarem 2.
- Hook do Claude em `.ts` custa ~0,2 s por troca de sessão (loader de TypeScript do Node). Converter para `.mjs` (≈ −40%). Meta de <100 ms do PRD é inalcançável nesta máquina (Node vazio já leva ~0,1 s); nova meta: <250 ms medidos via bash, sem impacto perceptível.
- E2E: matar o Claude antes de 10 s de vida desliga a tela cheia de todas as sessões da máquina (canário do Claude Code). O harness espera 11 s antes de matar; T6 deve respeitar.
- soul-cli: `--session-id` não pode criar sessão (o canal não permite escolher id); fica como sinônimo de `--resume`. Sem impacto: o aviso a cada troca resolve.
- soul-cli worktree `D:\atrium\workspace\soul-cli-tether` tem junctions em `node_modules\@atrium` para os pacotes reais: desfazer as junctions antes de remover a pasta.
- soul-cli: `bun run check` não fica verde nem no develop limpo (28 erros de tipo e 4 testes já quebrados lá). Critério ajustado: nenhuma falha nova em relação ao develop.

## Ações do Guga

- OK para fazer merge de `feat/session-report` no `develop` do soul-cli e instalar o soul novo na máquina (guardando o anterior).
- Hook do Claude convertido para `.mjs`: mediana 227 ms → 152 ms via bash.
- O `tetherd` considera o agente "rodando" pelo PTY que ele próprio segura; a verificação por PowerShell (liveness.ts) fica só para a CLI sem daemon.
- Visto pelo Guga numa janela de teste da A1a (2026-10-29): (1) o terminal ocupa só a metade de baixo da janela e a aba aparece duplicada/sobreposta no topo; (2) as janelas dos testes E2E aparecem na tela dele. Na verificação da A1a: conferir os dois na tela; testes E2E do app devem rodar com a janela escondida ou fora da tela.
- soul: na retomada o tetherd usa só a receita reportada pelo soul (`-r <id>` + flags de contexto); flags que o servidor não guarda (ex.: `--strategy`) não são reaplicadas. Provado que retoma sem elas no agente serpente; se aparecer caso que precise, reaplicar `slot.args` na retomada (uma linha em soul.ts).
- `soul` instalado é um script bash; o tetherd lê as linhas `NODE=`/`CLI=` dele e roda `node <cli>` direto no PTY (ConPTY não executa script bash). `TETHER_SOUL_CMD` sobrescreve.
- A1a: o E2E do app não foi rodado por mim porque ainda abre janelas na tela do Guga; a A3 traz o modo de janela escondida e eu rodo tudo na verificação dela.
- Claude 2.1.312 recusa `--session-id` junto de `-c`/`--resume` sem `--fork-session`; o adapter não passa `--session-id` nesses casos.
- Daemon: antes de retomar o Claude, confere se o transcript existe (`session-missing`, vínculo preservado, "nova sessão" resolve). Execução que nunca reportou sessão vira `unconfirmed` e o start exige escolha. Esse estado não é persistido: um daemon novo carrega o slot como `exited`.
- Os testes unitários deixam centenas de pastas `tether-*` em %TEMP%; limpar na T8.
- App: fechar a janela só desconecta (os agentes seguem no tetherd); "Arquivo → Sair e encerrar tudo…" (Ctrl+Shift+Q) para tudo. O tetherd falso foi aposentado: o app sobe o daemon real sozinho.
- App: o tetherd é lançado com o `node` do sistema (o Node do Electron tem ABI diferente e não carrega node-pty).
- Daemon a melhorar (não bloqueia): request para trocar a pasta de um slot; `spawnDaemon` aceitar `execPath`/`mainPath` para o app reaproveitar; daemon herda handles do pai no Windows (só afeta testes com Playwright).
- Fila do daemon: o evento `running` do slot que libera vaga agora sai antes do `starting` do próximo (antes o cliente via 4 "iniciando" por um instante). A contagem real sempre foi 3.
- 648 pastas `tether-*` antigas de testes removidas do %TEMP%; os testes agora limpam o que criam.
- Teste de carga rodado por mim 2x: vínculos 100% corretos nas duas (todos os slots voltaram na própria sessão após kill do tetherd). Falhas foram do teste: (1) Haiku respondeu "ok" em vez da palavra; (2) falso órfão — PID reaproveitado faz csrss/winlogon/dwm parecerem filhos do Claude. Correção delegada.
- soul: os prompts da suíte usam o tom da persona do agente Serpente (mestre de jogo), que recusa "responda só X". Se a persona mudar, esses prompts precisam de ajuste (`E2E_SOUL_DIR` troca o agente).
- soul (não é defeito do tether): `/rename` digitado enquanto `/branch` ainda roda renomeia a conversa antiga. Registrado para o soul-cli.
- A5: `TETHER_CLAUDE_ARGS` / `TETHER_SOUL_ARGS` acrescentam argumentos a todo lançamento (usado nos testes para `--model haiku`; o diálogo de novo painel não tem campo de argumentos).
- A5: `tether attach` repassava o pedido de "win32-input-mode" do ConPTY e quebrava o teclado (Ctrl+] nunca chegava). Corrigido.
- Reabrir o tether logo depois de a janela travar: o app agora espera a trava de instância única ser liberada (até ~15 s) e, se não liberar, avisa em português em vez de fechar mudo. Corrigido também: layout com um único painel voltava vazio. Provado por mim (app.instance + app.layout verdes, 150/150 unit).

## Encerramento da ronda (2026-10-29)

Tudo o que é provável sem o Guga está fechado com prova. Restam apenas os itens que dependem dele: OK para merge de `feat/session-report` no develop do soul-cli e instalação do soul novo; depois disso, provar o soul instalado no app e marcar a T5 como concluída. As pastas de worktree dos agentes em `.claude/worktrees/` e `D:\atrium\workspace\soul-cli-tether` continuam no disco (remover só com autorização; a do soul tem junctions a desfazer antes).
- Uso real (Guga, 2026-10-29): `/resume` no painel do Claude em `d:\atrium` não mostrava as 62 sessões gravadas como `D:\atrium`: o Claude compara o cwd letra por letra. Correção em andamento: o tether passa a usar a grafia real do disco (drive maiúsculo) em toda pasta. Contorno: Ctrl+A no seletor do `/resume`. Observação: há 40 sessões antigas do WSL (`/mnt/d/atrium`), que o Claude do Windows trata como outro projeto.
- Pasta canônica: integrada e conferida por mim (`d:\atrium` e `d:\ATRIUM\` → `D:\atrium`; prova real do agente: o Claude recebe `D:\...` no hook). Slots antigos com `d:\` são lançados com a grafia certa na próxima retomada.
- Incidente (2026-10-29 ~17:05): o tetherd do Guga (pid 34036) morreu à força, sem linha de saída no log, com um Claude rodando; o app também não estava mais aberto. Causa não provada; suspeita: testes do app matam por PID só checando "está vivo" (`if (pidAlive(pid)) process.kill(pid)`), o que pode atingir um processo do Guga se o PID foi reaproveitado. Correção: todo kill em teste confere que o processo é do próprio teste (linha de comando com a home/pipe do teste e criação depois do início do teste). Os slots do Guga continuam salvos e voltam na próxima abertura do app.

## Robustez (prioridade do Guga, 2026-10-29)

| Fatia | Estado | Prova |
|---|---|---|
| R1 Gestão de processos: tetherd fora da árvore do app (matar o app não mata agentes), um daemon por home sob corrida, pidfile/pipe velhos, limpeza de órfãos por identidade, autoproteção do daemon, kills de teste só por identidade | concluída (fable, high); integrada no main em 2026-10-29 | unit (daemon.spawn, daemon.guard); E2E app.tree (taskkill /T no electron → daemon e shells vivos → relançar reanexa), app.theme/app.layout/app.instance verdes; Claude real 1x (app.claude) |
| R3 `killall node` não atinge o tether: tetherd roda como `tetherd.exe` e os painéis do soul como `tether-soul.exe` (cópias do node.exe em `<home>bin`, atualizadas quando o node muda); teste: `killall node` com app aberto → painéis seguem vivos; e horário de início de processo sem abrir PowerShell a cada consulta (hoje passa de 5 s sob carga e volta vazio: teste de liveness instável, limpeza de órfãos da R1 fica cega) | concluída | minha prova: killall E2E 3/3 (killall dos node.exe do teste mata o sentinela e deixa tetherd.exe, tether-soul.exe e slots servindo); 230/230 unit; ajudante de horário: p50 9 ms ocioso, 64 ms sob carga (antes 1,1–6 s) |
| R2 Tratamento de erros: auditoria de todo caminho de falha (daemon, app, CLI), mensagens em português com ação, log, testes com injeção de falha | pendente | |
- Tema Claro / Automático (padrão) / Escuro: integrado e verificado por mim (160/160 unit, app.theme + app.layout verdes; screenshot claro revisado: cores ANSI, texto dim e o laranja do Claude legíveis). Menu Exibir → Tema e seletor na barra; lembrado em `settings.json`; Automático segue o Windows ao vivo.

### R1 — gestão de processos: integrada (2026-10-29)

- **tetherd fora da árvore do app.** `spawnDaemon` (src/daemon/client.ts, usado pelo app e pela CLI; recebe `execPath`/`mainPath`/`env`) sobe o daemon por um `powershell Start-Process` de vida curta: ShellExecuteEx cria o processo **sem herdar handles** e o PowerShell sai na hora, deixando o tetherd com pai morto, fora de qualquer árvore que um "Finalizar tarefa"/`taskkill /T` percorra. Medido (test/unit/daemon.spawn.test.ts): um intermediário em Node puro NÃO resolve a herança (o Node só desfaz a herança dos fds da CRT; o pipe CDP do Playwright é handle bruto e passava adiante — EOF só com a morte do neto, 8 s); com Start-Process o handle fica para trás (EOF logo após o intermediário sair). Custo: ~1,3 s por subida do daemon. O daemon fica com um console oculto (sem efeito observado).
- **Um daemon por pipe.** O próprio pipe é a trava (`FILE_FLAG_FIRST_PIPE_INSTANCE` → EADDRINUSE no segundo): o perdedor da corrida confere quem respondeu e sai 0 com linha no log; pipe ocupado por programa estranho → cliente falha rápido em português sem subir daemon, `main.ts` sai 2 com linha no log; pidfile obsoleto (PID reaproveitado) → linha no log e substituição, sem tocar no processo.
- **Órfãos.** O tetherd grava `<home>/slots/<id>.run.json` (`by: tetherd`, pid e hora de início do daemon, pid e hora de início do agente). O daemon seguinte mata **só** o que casa pid + hora de início e cujo dono está morto; PID reaproveitado ou dono vivo → não toca, com linha no log.
- **Autoproteção.** `uncaughtException`/`unhandledRejection` logam com stack; segue servindo enquanto o servidor escuta e os erros são raros (máx. 5 em 60 s), senão sai com linha clara (o próximo cliente sobe outro). Falha de spawn de um slot → `error spawn-failed`, daemon segue. SIGINT/SIGTERM/SIGHUP (console fechado)/SIGBREAK → fecha PTYs, remove pidfile (só se ainda é o seu), loga. Não provável por teste no Windows: a entrega dos sinais (`process.kill` no Windows mata sem sinal; CTRL_BREAK exige console compartilhado).
- **Kill nos testes só por identidade.** `test/kill.ts`: `claim` guarda pid + hora de criação e confere a linha de comando com um caminho só do teste; `killOwned` mata só se a identidade ainda bate. Todo kill em `test/**` passa por ele; os `process.kill` restantes são sinal 0.
- Prova: unit (daemon.spawn, daemon.guard), E2E app.tree (taskkill /T no electron → daemon e shells vivos por identidade → relançar reanexa → `app.close()` volta com o daemon vivo), suíte do app 2x, Claude real 1x (app.claude).

## Diálogos próprios (pedido do Guga, 2026-10-29)

Nenhuma caixa nativa do Windows no app; ícones Phosphor (`@phosphor-icons/core`, SVG embutido) no lugar dos caracteres de texto em toda a interface. Um componente de diálogo com estrutura fixa (situação com ícone/título/contexto; escolhas como cartões com ícone, ação e consequência; tom seguro/neutro/destrutivo; teclado; tema) e uma declaração por situação, escrita a partir do problema que ela comunica. Situações: fechar painel, sair e encerrar tudo, "ainda está fechando", fluxo de pasta (só o "Procurar…" continua nativo). Em andamento (fable, high).

## Perfis de lançamento (pedido do Guga, 2026-10-29)

Perfis nomeados (agente + argumentos + ambiente + pasta padrão) em `profiles.json`, com padrões "Claude", "Claude modo dev" (`--dangerously-skip-permissions`), "soul" (`-g`), PowerShell, Git Bash. O painel guarda o perfil e o reaplica ao retomar; argumentos que o tether controla são recusados.
- P1 núcleo (store, validação, daemon, CLI): integrado. Prova minha: profiles E2E com Claude real 2/2 (painel "Claude modo dev" recebe --dangerously-skip-permissions e o mantém ao retomar a mesma sessão); 218/219 unit (a falha é o teste de liveness por PowerShell sob carga, ver R3).
- P2 interface (escolha no Novo painel, tela de perfis, selo "sem permissões"): depois dos diálogos próprios.
- R3: o hook do Claude continua em `node` (vive ~150 ms; um killall nessa janela perde no máximo um evento, e o próximo reporta de novo). Atualizar o Node com o tetherd no ar deixa a cópia desatualizada até o próximo start (o doctor avisa).

## Passagem para o Atrium (2026-10-29)

Diálogos próprios + ícones Phosphor integrados ao `main` (merge com perfis/R1/R3/tema resolvido; typecheck limpo, 230/230 unit, app compilado e aberto no atalho). A rodada final de E2E do app não foi completada (memória baixa, depois pausa). Continuação descrita em [MANIFEST.md](./MANIFEST.md) §7.

## 7.1 concluída — prova dos diálogos próprios (2026-10-29)

Rodada final de E2E do app feita um arquivo por vez, janela escondida (`TETHER_E2E_HIDDEN=1`), após `npm run app:build`:

| Arquivo | Resultado |
|---|---|
| app.dialogs | verde (2x: antes e depois das correções abaixo); 10 capturas em `test/e2e/artifacts/`, incluindo `dialog-still-closing-light.png` que faltava |
| app.instance | verde (relançamento imediato 3/3, lock preso, segunda instância, lock travado → diálogo → "Fechar" encerra) |
| app.layout | verde (4 shells sobrevivem à morte da janela e do daemon) |
| app.tree | verde (tetherd fora da árvore; `taskkill /T` no electron deixa daemon e shells vivos; relançar reanexa) |
| app.theme | verde (claro/automático/escuro ao vivo e lembrados) |
| app.claude | verde (Claude real, haiku: duas sessões respondem, mesmos PIDs após matar a janela, mesmas sessões após matar o daemon; canário `fullscreenAutoDisabled` ausente) |

Revisão das capturas claro/escuro como designer: título diz a situação, contexto legível (nome, pasta, sessão, selo de estado), cartões com ícone + ação + consequência, destrutivo sempre por último e nunca padrão, tema correto nos dois esquemas. Dois defeitos pequenos corrigidos (commit `6a34fbb`): o cartão padrão ficava sem anel de foco quando o diálogo era aberto com o mouse (`:focus-visible` só após teclado; agora `.choice.default:focus` também desenha o anel) e o cartão "Fechar" do "ainda está fechando" fazia o papel do Esc sem dizê-lo (`DialogSpec.escChoice`: cartão de "não fazer nada", nunca destrutivo, mostra a dica Esc e recebe o Esc). Portões: `npx tsc -p .`, `npx tsc -p app/renderer`, 230/230 unit, `grep showMessageBox|showErrorBox` em `app/**/*.ts` vazio.

## Mac: o tetherd que não nascia, e o layout que se apagava (2026-10-30)

A Francine relatou o Tether "fechando sozinho e abrindo sem nenhum painel". São dois defeitos independentes.

**1. O executável renomeado não nasce no Mac.** `ensureRenamedNode` hardlinka o node em `<home>/bin/tetherd` para dar nome próprio ao processo — desenho de Windows (Task Manager, `killall node.exe`). O `node` do Homebrew é um stub de 68 KB que carrega `@rpath/libnode.141.dylib` com `LC_RPATH` só `@loader_path` e `@loader_path/../lib`: fora da pasta original, o dyld aborta no launch. Reproduzido (`~/.local/state/tether/bin/tetherd -e …` → `Library not loaded`, inclusive com `env -i`), com 27 relatórios `tetherd-*.ips` em `~/Library/Logs/DiagnosticReports` (`termination.namespace: DYLD`, "terminated at launch"). Conserto (`f861c89`): no darwin nada é copiado para `bin/` — roda o node real e o nome vai pelo `argv0` do `spawn`; o soul usa `/bin/sh -c 'exec -a tether-soul "$0" "$@"'` porque o node-pty não aceita `argv0` (`src/unix/pty.cc:383` faz `argv[0] = strdup(file)`). `.tmp` órfão é varrido; o doctor aponta o hardlink residual. Prova minha: `argv0=tetherd` e `argv0=tether-soul` com `execPath` do node real, e `ensureRenamedNode` em home temporária devolve `method: 'argv0'` deixando só o stamp em `bin/`.

**2. O layout era destruído pela ausência do daemon.** Às 14:23:30Z um `shutdown` (prova do `tether daemon restart` em construção) parou os 15 agentes — inclusive a sessão que falava com ela. O daemon ficou 10 min fora; na volta o app podou o layout contra uma lista de slots vazia e **gravou** o resultado: ~15 painéis lado a lado viraram um. Os 19 slots no disco sobreviveram; só a disposição morreu. Conserto (`faf39a9`): poda só na exibição, `known` vazio não poda nada, nenhuma gravação sem ação da pessoa, `layout.json.bak` atômico com fallback. E (`a834d1d`): `tether daemon restart|stop` recusam de dentro de um slot do próprio daemon (`--force` para insistir), o item "Recarregar" perdeu o `Cmd+Shift+R` e pede confirmação dizendo quantos agentes encerra. Prova minha: 19 unitários novos verdes; `ownSlotOf` contra a lista do daemon vivo reconhece o slot `861509e8` e recusaria.

Dívida que ficou (anterior a hoje): 5 unitários falham no Mac por fixture de caminho Windows (`C:\…`, `D:\…`) e pelo `spawn-failed` do node-pty, que no Mac não rejeita síncrono. Linha de base em `a834d1d` falhava 8; nenhuma falha nova. Prova viva (reiniciar o tetherd) é da Francine: reiniciar mata todas as sessões abertas.

## Instalador do Mac: Tether.app (2026-10-30)

Pedido da Francine: abrir o Tether sem linha de comando. `app/install.mjs` ganhou o lado macOS (o Windows segue no atalho do Menu Iniciar): `node app/install.mjs install|uninstall|read [--prefix <dir>]` monta `~/Applications/Tether.app` — bundle leve (Info.plist + lançador `/bin/sh` + `tether.icns`), **sem empacotar o Electron**, lançando o Electron do repo com `app/dist/main.cjs`. Mesmo contrato do Windows: o atalho nunca builda. Idempotente por tmp+rename, recusa bundle alheio pelo `CFBundleIdentifier`, `uninstall` só apaga o nosso. `app/icon.mjs` passou a emitir `.icns` (container escrito à mão, 10 tamanhos até 1024, sem dependência) e `app/main/main.ts` faz `app.setName('tether')` + `app.dock.setIcon` no darwin. Commits `fea04ce`, `1d1ec4a`, `fedb0fb`.

**Identidade no Dock — medido, não escolhido por gosto.** `Contents/MacOS/tether` como symlink para o binário do Electron dá a identidade certa (LaunchServices lê `tether`/`studio.codr.tether`), mas **mata todos os helpers** (GPU, rede, renderer): o sandbox dos helpers é escrito contra o caminho do bundle principal e eles vivem de verdade dentro do `Electron.app`; só `--no-sandbox` revive, o que não se aceita. Ficou o lançador com `exec -a`, que roda limpo e deixa o SO atribuir o processo ao `Electron.app` — daí o `setName`/`setIcon` no runtime. Copiar o binário está fora: é o mesmo defeito de dyld/@rpath consertado hoje no `tetherd`. Se o nome "Electron" no Dock incomodar, o caminho completo é empacotar o Electron dentro do bundle (pacote grande) — decisão da Francine.

Provas minhas: `plutil -lint` OK no plist instalado, `file` → "Mac OS X icon" (39 KB), 8/8 unitários novos (`app.icon`, `app.install-mac`), typecheck limpo, instalado de verdade em `~/Applications/Tether.app`. A prova visual (ícone, nome, abrir pelo Launchpad) é da Francine.
