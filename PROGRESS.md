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
- Fase A (mesas/quadros/gaveta, PLAN.md "Fase 3"): **"Duplicar painel" é sessão nova** — copia agente, pasta e perfil, nunca a conversa (o `create` do daemon não leva vínculo; o Claude sobe com `--session-id` próprio). Alternativa descartada: `--fork-session` da conversa atual (seria "ramificar", outra operação; pode entrar depois no clique direito).
- Fase A: **atalho puro duplica; menu e seletor escolhem.** `Ctrl+Alt+←/→/↑/↓` duplica ao lado do painel em foco; `Ctrl+Shift+T` abre o seletor, que ganhou a linha "Onde, em relação a <painel>" (nesta aba por padrão). `Ctrl+Shift+D`/`E` seguem como sinônimos de duplicar à direita/abaixo (hábito e testes existentes). O botão "Duplicar painel" da barra duplica à direita; os outros lados ficam no teclado, no menu ≡ (direita/abaixo) e no clique direito da aba.
- Fase A: `Ctrl+Alt+seta` em alguns drivers Intel antigos gira a tela (hotkey do painel gráfico, desligada por padrão nos drivers atuais); se acontecer na máquina do Guga, desligar a hotkey no driver ou trocar o chord (`Ctrl+Shift+seta` está livre no xterm). `Ctrl+Alt+letra` foi evitado de propósito: no ABNT2 é AltGr.
- Fase 3: **`Ctrl+Win+seta` colide com o Windows** (`Win+Ctrl+←/→` troca a área de trabalho virtual; `Win+↑/↓` maximiza/minimiza): proposta `Alt+Shift+seta` para quadro na borda da mesa, com prefixo `Ctrl+Alt+F` + seta como alternativa. Mesa antes/depois: `Ctrl+Alt+Shift+N` / `Ctrl+Alt+N`. Validar com o Guga antes da fase B.
- Fase C: o selo "terminou / espera entrada" vem dos hooks `Stop` e `Notification` do Claude (mudança em `src/agents/claude.ts` + daemon: exige reiniciar o tetherd); soul e shell ficam com heurística (saída parada / BEL) até o soul ganhar aviso próprio.
- Fase B: **atalhos como propostos**, num registro único (`app/renderer/shortcuts.ts`: `SHORTCUTS`, `shortcutOf`, `shortcutHint`; menus e tooltips leem de lá): `Ctrl+Alt+Shift+seta` = painel na borda do quadro; `Alt+Shift+seta` = quadro novo na borda da mesa. Trocar um chord é uma linha na tabela. Risco conhecido: `Alt+Shift` com dois layouts de teclado instalados troca o layout no Windows (o chord ainda chega ao app, mas o layout muda junto); alternativa registrada no PLAN (`Ctrl+Alt+F` + seta).
- Fase B: **o "+" do mouse só nos níveis quadro e mesa** (pequeno na borda do quadro, maior na borda da mesa; aparece a ≤14 px / ≤8 px da borda; clique duplica, clique direito ou Shift+clique abre o seletor pré-marcado naquela borda). O "+" entre painéis (nível painel) ficou de fora: a borda interna já tem o sash do dockview e `Ctrl+Alt+setas` cobre o gesto.
- Fase B: **menu ≡ e clique direito da aba ganham "Novo painel na borda do quadro…" e "Novo quadro…"**, que abrem o seletor (escolher), com "Onde" já no nível certo (à direita por padrão); duplicar nesses níveis fica no teclado e no "+". A linha "Onde" do seletor tem três grupos (Painel / Quadro / Mesa); "nesta aba" só existe no nível painel.
- Fase B: **quadro vazio some sozinho** (quando o último painel sai, inclusive por `forget`), exceto o último quadro da mesa (fica com a marca d'água). Uma mesa nunca fica sem quadro.
- Fase B: **arrastar aba entre quadros não funciona ainda** (cada quadro é uma instância de dockview; o drop de outra instância exige tratar `onUnhandledDragOverEvent` + `onDidDrop` e mover o painel pela API). Pendência registrada.
- Fase B: o `layout.json` é gravado sempre em v2; a migração guarda `layout.v1.bak` (sobrescrito se um build antigo voltar a gravar v1 e houver nova migração: a cópia espelha o último v1 visto).

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

## 7.2 concluída — perfis de lançamento na interface (P2) e menu do app (2026-10-29)

Fable (high), branch `develop`. O usuário escolhe **como** o agente sobe (perfil), não só o tipo.

- **Novo painel** lista os perfis agrupados por agente (Claude / soul / Shell), com ícone, nome, argumentos em texto pequeno e selo "sem permissões" nos perfis com `--dangerously-skip-permissions`; pré-seleciona o perfil padrão do agente; a pasta padrão do perfil é sugerida; `create` leva `profileId`. "Gerenciar perfis…" abre a tela de perfis a partir do diálogo.
- **Perfis de lançamento** (botão "Perfis" na barra, menu do app e Exibir → Perfis de lançamento…): lista à esquerda, formulário à direita (nome, agente, executável do shell, argumentos em um campo com aspas e pré-visualização em chips, variáveis de ambiente em linhas chave/valor, pasta padrão com "Procurar…", "perfil padrão deste agente"); criar, editar, duplicar, apagar, definir padrão. Erros do validador (`src/core/profile.ts`, em português) aparecem ao lado do campo; o aviso de `CLAUDE_*` aparece enquanto se digita. Apagar passa pelo componente de diálogo (`delete-profile`): "Manter o perfil" é o padrão, "Apagar" é destrutivo e diz que os painéis que usam o perfil continuam com o último snapshot dos argumentos.
- **Selo "sem permissões"**: escudo (Phosphor `shield-warning`) na aba e, no cabeçalho do painel, pílula "sem permissões" + pílula com o nome do perfil; tooltip explica o `--dangerously-skip-permissions`.
- **Ctrl+Shift+D/E** e "Escolher outra pasta…" abrem o painel novo com o **mesmo perfil** do painel de origem.
- **Menu do app** (botão ≡ à direita da barra; a barra de menu nativa fica oculta e Alt não a alcança com o terminal em foco): Novo painel, Perfis de lançamento…, Tema (Claro/Automático/Escuro com marca), Voltar a perguntar antes de fechar painéis, Fechar a janela, Sair e encerrar tudo… (diálogo próprio). **Ctrl+Shift+Q** abre o "Sair e encerrar tudo" também com o foco dentro do xterm (T/D/E já passavam; Q entrou no mesmo tratador).
- **Migração do `profiles.json`: não feita, de propósito.** O `profiles.json` do Guga já tem os cinco padrões (inclusive Git Bash em `C:\Program Files\Git\bin\bash.exe`). Uma migração que "repõe padrões ausentes" ressuscitaria um perfil que o usuário apagou de propósito; se um dia for preciso, a regra certa é guardar no arquivo quais padrões já foram semeados.
- Decisão de produto para validar: no formulário, para perfis de shell, **um só campo de argumentos** cobre `shell.args` + `args` (na gravação tudo vai para `shell.args`; o lançamento é idêntico, `launchOf` concatena os dois). O executável do shell é digitado (sem seletor nativo de arquivo: só o "Procurar…" de pasta continua nativo).

Prova (minha, janela escondida, home/pipe privados, `TETHER_CLAUDE_ARGS=--model haiku`):

| Portão | Resultado |
|---|---|
| `npx tsc -p .`, `npx tsc -p app/renderer` | limpos |
| `npm test` | 232/232 (novo: `app.args` — parser de argumentos com aspas) |
| `app.profiles` (novo) | verde: grupos/padrão/args/selo no Novo painel; painel "Claude modo dev" → linha de comando do `claude.exe` com `--dangerously-skip-permissions` e `--model haiku`, selo na aba e no cabeçalho, nome do perfil no cabeçalho; Git Bash abre e responde `echo $BASH_VERSION` (5.3.15); Ctrl+Shift+D cria painel com `profileId: git-bash`; perfil "Bash de teste" (arg `--noediting` + env `PROFILE_MARK`) salvo no gerenciador → o bash recebe o arg na linha de comando e `echo $PROFILE_MARK` imprime o valor; `--resume` mostra o erro inline no campo e não é salvo; `CLAUDE_FOO` mostra o aviso; apagar o perfil pelo diálogo deixa o painel rodando; menu do app → "Sair e encerrar tudo…" → diálogo → Esc; Ctrl+Shift+Q de dentro do terminal idem; canário `fullscreenAutoDisabled` ausente |
| `app.dialogs`, `app.layout`, `app.instance` | verdes (seletor do diálogo mudou: `input[name=profile][value=<id>]`) |

Capturas em `test/e2e/artifacts/`: `profiles-new-panel-{light,dark}.png`, `profiles-manager-{light,dark}.png` (com o erro inline e o aviso), `profiles-unsafe-tab-{light,dark}.png`, `profiles-delete-dark.png`. Revisão como designer: a lista lê em três níveis (agente → nome → args em mono apagado), o selo "sem permissões" é âmbar e discreto (ícone só na aba; ícone + texto no cabeçalho e na lista), o erro fica colado ao campo que o causou com o rótulo em vermelho, o diálogo de apagar tem o neutro como padrão e o destrutivo por último. Corrigido na revisão: o campo "Executável do shell" aparecia para perfis do Claude (`.field[hidden]` perdia para `display:block`).
- Aprendido na prova: o bash lê as opções longas só **antes** das curtas (`--login -i --noediting` → "`--: invalid option`"); o teste usa `--login --noediting -i`.

## Trocar o perfil de um painel existente (prioridade do Guga, 2026-10-29)

Fable (high), branch `develop`. Caso do Guga: painéis do Claude criados sem perfil precisam passar a rodar com `--dangerously-skip-permissions` sem perder a conversa.

- **Protocolo:** `set-profile { slotId, profileId | null, restart? }`. Valida que o perfil é do agente do slot (`bad-request`) e existe (`unknown-profile`); reescreve o meta do slot (id + snapshot, ou sem campos de perfil para `null`), avisa todos os clientes. Sem `restart`, ou com o slot parado/na fila: só o meta muda e o próximo início o aplica.
- **Reinício (`restart` com processo vivo):** o slot ganha `restarting` no estado (cabeçalho mostra "reiniciando…"); o daemon espera o agente ter **12 s desde o spawn** (regra dos 11 s + 1 s de folga entre o spawn do PTY e o início do Claude); exige que o agente tenha **registrado a sessão desta execução** (`reportedThisRun`) — se não registrou (`running` pelo fallback de 15 s, ou ainda `starting` até o fallback), responde `unconfirmed` e **nada muda** (o meta é restaurado se já tinha sido escrito); mata a árvore do PTY e inicia o slot com `choice: 'resume'` do vínculo confirmado → `claude --resume <mesmo id>` com os args do perfil novo. Shell: mata e abre outro. `DAEMON_VERSION` 0.2.0.
- **Selo "sem permissões" honesto:** com processo vivo, `unsafe` descreve **o lançamento que está rodando** (`slot.runUnsafe`, fixado no spawn); sem processo, o que o próximo início recebe. Assim "trocar na próxima abertura" para um perfil seguro não faz um Claude que ainda pula permissões parecer seguro.
- **App:** a pílula do perfil no cabeçalho virou botão ("sem perfil", tracejada, nos painéis de agente sem perfil; "Trocar perfil…" no tooltip); clique direito na aba abre um menu próprio (`#ctx-menu`: "Trocar perfil…", "Fechar painel…"); entrada "Trocar perfil do painel…" no menu ≡ (age no painel ativo). O componente de diálogo ganhou um bloco **`options`** (lista de rádios entre o contexto e os cartões; `{option}` nas consequências é trocado pelo rótulo escolhido; o item `current` leva a etiqueta "atual" e deixa os cartões inertes; a resposta traz `option`). Situações novas em `situations.ts`: `switch-profile` (perfis DESTE agente + "Sem perfil"; cartões "Trocar e reiniciar agora" seguro/padrão — "O Claude reinicia agora com o perfil X e continua a mesma conversa (sessão 1a2b3c4d). Uma resposta em andamento é interrompida." — e "Trocar na próxima abertura" neutro; Esc cancela; com o slot parado, um só cartão "Trocar o perfil"), `switch-profile-unconfirmed` (o daemon recusou o reinício: oferece "Trocar na próxima abertura" como seguro, "Deixar como está" no Esc) e `switch-profile-failed` (outra recusa: "Entendi").
- **CLI:** `tether profile set <slot> <perfil|--none> [--now|--next]`; padrão `--next` (sem reinício implícito; a saída diz como reiniciar já); sem daemon grava o meta no disco e `--now` é recusado.
- Decisão de produto para validar: no diálogo, o perfil atual preselecionado deixa os cartões inertes (nada a fazer) — o foco inicial vai para a lista; escolher outro perfil acende o cartão padrão com a dica Enter.

Prova (minha, janela escondida, home/pipe privados, `TETHER_CLAUDE_ARGS=--model haiku`):

| Portão | Resultado |
|---|---|
| `npx tsc -p .`, `npx tsc -p app/renderer` | limpos |
| `npm test` | 240/240 (novos: `daemon.set-profile` 7 — meta/estado/null, recusas, próximo início aplica, reinício espera a idade mínima (1,5 s no teste) e retoma o MESMO id com os args novos, `restart:false` mantém o pid e o selo descreve o processo vivo, agente sem registro → `unconfirmed` sem mudar nada (pré-voo e após a espera), shell reinicia; `cli.profiles` +2 — `profile set` com e sem daemon) |
| `app.switch-profile` (novo) | verde: painel Claude criado SEM perfil (pílula "sem perfil", sem selo) responde "jabuticaba"; após ≥ 11 s a pílula abre o diálogo (opções `claude`, `claude-dev` com "sem permissões", `__none__` "atual"; cartões inertes até escolher outro; texto da consequência com o id da sessão); "Trocar e reiniciar agora" → pid 11220 → 37880, linha de comando nova `claude.exe --settings … --resume c1d1e0e3-bb28-4f40-a1c6-60978126ec74 --dangerously-skip-permissions --model haiku`, vínculo com o mesmo id, jsonl com `start/resume` do mesmo id, pílula "Claude modo dev", selo na aba e no cabeçalho, e o Claude responde "jabuticaba" ao "qual palavra você respondeu antes?"; "Trocar na próxima abertura" para "Claude" → meta no disco `profileId: claude`, mesmo pid, selo mantido; menu de contexto da aba e menu ≡ abrem o mesmo diálogo; canário `fullscreenAutoDisabled` ausente |
| `app.profiles`, `app.dialogs`, `app.layout` | verdes, um por vez, no build com a troca de perfil (o diálogo sem `options` é o mesmo de antes; a pílula do perfil continua dizendo o nome no cabeçalho) |
| `app.switch-profile` 2ª passada (build final, com a dica Enter) | verde: pid 34936 → 39024, mesma sessão `7bfbe2b2-…`, `--resume` + `--dangerously-skip-permissions` na linha de comando nova, "jabuticaba" lembrada; `~/.claude.json` sem `fullscreenAutoDisabled` |

Capturas em `test/e2e/artifacts/`: `switch-profile-{light,dark}.png` (diálogo com "Claude modo dev" escolhido), `switch-profile-after-light.png` (cabeçalho com a pílula do perfil + selo, aba com o escudo, as duas respostas). Revisão como designer: a lista lê em três níveis (ícone → nome → args em mono apagado), marca âmbar e etiqueta "atual" discretas, cartão seguro primeiro com a sessão na consequência, Esc no rodapé, temas corretos. Corrigido na revisão: ao escolher outro perfil os cartões acendiam sem a dica Enter no cartão padrão (o foco ficava na lista) — `.choices.armed` mostra a dica.

**Para o Guga usar:** o `tetherd` em execução (`D:\sources\localhost\agentic-terminal`) é anterior ao request `set-profile` — precisa ser reiniciado com este código (os slots retomam as sessões), e o app precisa do build novo (`npm run app:build`).

## Fase A — "Novo painel…" e "Duplicar painel" (pedido do Guga, 2026-10-29)

Fable (high), branch `develop`. O plano inteiro das mesas/quadros/painéis/gaveta está no PLAN.md ("Fase 3"); esta é a primeira fatia. Queixa de origem: os botões "Direita" e "Abaixo" clonavam os dois o painel atual sem dizer, e não havia como abrir o seletor ao lado de um painel.

- **Duas operações, em todo gesto de criar:** **"Novo painel…"** (`Ctrl+Shift+T`, botão da barra, menu ≡, clique direito na aba) abre o seletor, que ganhou a linha **"Onde, em relação a <painel>"** (nesta aba · à esquerda · à direita · acima · abaixo; escondida quando não há painel). **"Duplicar painel"** (`Ctrl+Alt+←/→/↑/↓` de dentro do terminal, botão da barra = à direita, menu ≡ = à direita/abaixo, clique direito na aba = à direita/abaixo) abre outro painel com o mesmo agente, perfil e pasta, ao lado do painel em foco, numa **sessão nova**. `Ctrl+Shift+D`/`E` continuam como sinônimos. Com o daemon recusando o `create` (pasta ou perfil sumiu), o seletor abre pré-preenchido no mesmo lugar.
- **Código:** `app/renderer/create.ts` (puro: `shortcutOf`, `duplicateRequest`, `PLACEMENTS`/`PLACEMENT_LABEL`, rótulos), `main.ts` (duplicatePanel/duplicateActive, linha "Onde" do seletor, menus, atalhos pelo `shortcutOf` também no filtro do xterm), `index.html`, `styles.css` (chips de posição), `icons.ts` (tabs, arrow-line-*), README. **Daemon intocado** (`src/daemon`, `src/agents`, `src/core` sem mudança): o tetherd do Guga não precisa reiniciar; só `npm run app:build`.

Prova (minha, janela escondida, home/pipe privados, `TETHER_CLAUDE_ARGS=--model haiku`, `CLAUDE*` retirados do ambiente do app):

| Portão | Resultado |
|---|---|
| `npx tsc -p .`, `npx tsc -p app/renderer` | limpos |
| `npm test` | 251/251 (novo: `app.create` 7 — chords Ctrl+Alt+setas, sinônimos Ctrl+Shift+T/D/E/Q, o que fica com o terminal (Ctrl+seta, Ctrl+Alt+letra, Win), corpo do `create` com/sem perfil e com perfil apagado, posições). Atenção: o shell desta sessão herda `TETHER_CLAUDE_ARGS=--dangerously-skip-permissions`; com ela, `daemon.set-profile` falha (todo slot vira `unsafe`) — rodar com a variável limpa |
| `app.duplicate` (novo) | verde (52 s): `Ctrl+Shift+T` sem painel abre o seletor sem a linha "Onde"; painel Claude pelo seletor responde "jabuticaba"; `Ctrl+Alt+→` de dentro do terminal → segundo painel à direita (caixa do painel), mesma pasta e perfil `claude`, **sessão nova** (`7851727e…` → `131856ef…`), linha de comando com `--session-id` próprio e sem `--resume`, `--model haiku` mantido, o primeiro painel guarda a sessão dele, o duplicado responde "pitanga"; seletor com a linha "Onde" (5 chips, "nesta aba" padrão) abre um PowerShell **abaixo** do painel 1; `Ctrl+Alt+←` no shell duplica à esquerda (perfil `powershell`, mesma pasta); hook duplica acima; menu ≡ com "Novo painel…", "Duplicar painel à direita/abaixo"; clique direito na aba: `Novo painel…`, `Duplicar painel à direita`, `Duplicar painel abaixo`, `Trocar perfil…`, `Fechar painel…`; o "Novo painel…" da aba abre o seletor relativo àquele painel; Esc não cria nada |
| Canário `fullscreenAutoDisabled` | **presente em `~/.claude.json` ANTES da primeira rodada** (`at` = 2026-10-30T01:46:16Z = 22:46 local, `strikes: 3`, v2.1.314; minha primeira rodada começou às 23:40 local e nenhum Claude dela viveu menos de 34 s). Não é desta fatia; o teste do canário fica vermelho até ser limpo. **Ação do Guga:** `/tui fullscreen` (ou remover a chave) e descobrir quem matou Claudes novos às 22:46 |
| `app.layout` (regressão dos sinônimos Ctrl+Shift+D/E) | verde (48 s): 4 shells por Ctrl+Shift+D/E sobrevivem à morte da janela (mesmos PIDs) e à do daemon. `app.profiles`, `app.dialogs`, `app.theme` e `app.claude` também usam só Ctrl+Shift+D (mantido): não rodados nesta fatia |

Capturas em `test/e2e/artifacts/`: `new-panel-chooser-first-dark.png` (seletor sem "Onde"), `duplicate-right-dark.png` (dois Claudes lado a lado, conversas distintas), `new-panel-chooser-placement-light.png` (seletor com a linha "Onde"), `duplicate-grid-light.png` (Claude | Claude em cima; shells abaixo/esquerda/acima). Revisão como designer: a barra lê "Novo painel… · Duplicar painel" sem direção escondida; os chips de "Onde" têm ícone por direção e o escolhido fica com a cor de destaque; o nome do painel de referência aparece em negrito na própria frase. Observado na captura (não é desta fatia): o Claude duplicado subiu em "auto mode" enquanto o primeiro ficou em "manual mode" — mesmo comando, mesma pasta; provavelmente o estado da pasta de confiança/modo gravado pelo primeiro; registrar se o Guga notar.

## Nunca matar um Claude jovem (2026-10-30)

Fable (high), branch `develop`. Caso do Guga: "Sair e encerrar tudo" mandava `stop` por slot e `shutdown`; o `stopSlot` matava o PTY sem a guarda de idade que só o reinício por perfil tinha. Um Claude morto antes de terminar de iniciar é um "strike" do Claude Code; com 3, ele grava `fullscreenAutoDisabled` em `~/.claude.json` e a tela cheia fica desligada na máquina inteira (slot 11a40042: spawn 02:59:26, saída -1 às 02:59:35).

- **Um caminho só de morte** (`awaitKillable` em `src/daemon/server.ts`): `stop`, `forget`, `shutdown`/`close()` e o reinício por perfil esperam o agente ter **≥ 12 s** (`MIN_AGENT_AGE_MS`) **e ter registrado a sessão desta execução** (evento de start do hook); teto de **30 s** por slot (`KILL_WAIT_CAP_MS`), slots em paralelo no `close()`, que agora só fecha o watcher de eventos depois das paradas (o registro precisa ser visto durante a espera). Shell nunca espera; `minAgentAgeMs: 0` desliga a guarda (daemons de teste). O estado ganha `stopping` enquanto a parada espera (o app pode mostrar "encerrando…"; não implementado no renderer, que está em obra na fase B). Constantes movidas para `protocol.ts` (a CLI não pode importar `server.ts`, que carrega o node-pty).
- **Decisão para validar — o fallback de 15 s NÃO libera a morte.** O brief dizia "registrou OU saiu de `starting`"; o E2E nesta máquina carregada (3 sessões do Claude + E2E do outro agente) mostrou o Claude registrando aos ~20 s, depois do `READY_FALLBACK_MS` de 15 s: com a regra do brief, a parada matava aos 16,5 s um Claude que ainda não tinha terminado de iniciar (exatamente o strike). Regra final: idade ≥ 12 s **e** registro, até o teto de 30 s; um agente que nunca registra (versão sem hook) só morre no teto, e fica `unconfirmed` como antes.
- **`taskkill /T` nunca no tetherd.** `killByPid` da CLI só é usado no fallback de `tether stop` sem daemon; agora: run de tetherd **vivo** (pid + horário de criação) → recusa com "o tetherd (pid N) está no ar mas não respondeu"; tetherd morto → mata só o `agentPid` (nunca o pid do daemon), conferindo identidade; run de `--here` (sem `by`) → mata a árvore do launcher. Antes de matar, espera a idade e o registro (`awaitKillable` da CLI, mesmo teto). A árvore do tetherd só cai pelo `shutdown` do pipe.
- **Fila de retomada (item opcional): não feito.** Hoje a fila libera a vaga quando o slot registra ou quando o fallback de 15 s vence (3 vagas); "liberar o próximo só depois do anterior registrar" é `MAX_STARTING = 1` com timeout, o que deixa a restauração de 10 painéis ~3× mais lenta. Com a guarda de morte, o cenário do quit-all já não mata jovens; fica para decidir com o Guga.

Prova (minha, `TETHER_CLAUDE_ARGS` vazio, home/pipe privados):

| O quê | Resultado |
|---|---|
| `npx tsc -p .` | limpo |
| `npm test` | 285/286 antes do ajuste final e novo `check` em curso ao registrar; a única falha é `app.layout` "layout real de 7 painéis" (território do outro agente, fase B, `fixtures/layout-v1-real.json` ainda não commitado). Novos: `daemon.stop-guard` 9 (stop logo após o spawn mata só após 1,5 s **e** o registro, cliente vê `stopping`; sem registro → morre no teto e fica `unconfirmed`; segundo `stop` entra na mesma espera; `forget` idem; shell imediato; já velho e registrado → imediato, sem `stopping`; fallback não libera; `minAgentAgeMs: 0` desliga; `close()` com dois Claudes jovens espera em paralelo e vê os registros durante o fechamento) e `cli.stop` 4 (tetherd vivo que não responde → recusa; tetherd morto → só o agente; agente já morto → "já está parado"; launcher `--here` → árvore). `daemon.confirm/queue/title` ganharam `minAgentAgeMs: 0`; `daemon.set-profile` ganhou `killWaitCapMs: 3_000` |
| `test/e2e/stop-guard` (Claude real, haiku) | verde: `stop` enviado logo após o pid aparecer; vivo aos 3 s; `stopping` visto; resposta aos **20 987 ms** com `exited` (não `unconfirmed`), vínculo com a sessão registrada, árvore inteira morta. Três rodadas anteriores (regra do brief) falharam com `unconfirmed` aos 16,5–17,2 s: a origem da decisão acima |
| canário `fullscreenAutoDisabled` | vermelho, **não por este trabalho**: `{version 2.1.314, at 03:06:16Z (00:06 local), strikes 3}`. O `at` mudou desde o registro anterior (01:46Z, fatia dos painéis): houve **novo episódio de 3 strikes às 00:06 local**, 23 min antes do primeiro E2E meu (00:29) e durante o meu primeiro `npm run check`, que não sobe Claude real (conferido: daemons com adapter real só criam shells; `new claude --profile 'Node aqui' --here` é recusado antes de lançar). Nenhum transcript de pasta de teste nesse horário (um Claude morto antes do primeiro prompt não deixa transcript). O `at` não mudou nas minhas quatro rodadas de E2E. **Ação do Guga:** `/tui fullscreen` para religar; o tetherd do app ainda roda o código antigo (mata jovens no "Sair e encerrar tudo") até ser reiniciado |
| `npm run app:build` | ok |

**Precisa reiniciar o tetherd** para chegar ao Guga (`src/daemon` e `src/cli` mudaram; os slots retomam).

## Fase B — quadros dentro da mesa + criação relativa (pedido do Guga, 2026-10-29/30)

Fable (high), branch `develop`, sem mudança no daemon. O que o Guga tinha (um dockview) vira **um quadro** de uma mesa; quadros novos nascem nas bordas da mesa, painéis novos nas bordas do quadro.

- **Modelo `layout.json` v2** (`app/renderer/layout.ts`): `{ v: 2, desks: [{ id, name, color, frames: { grid, views }, activeFrame }], activeDesk, drawer: null }`; `grid` é o `SerializedGridview` do dockview-core (quadros como folhas), `views[frameId]` o `SerializedDockview` de cada quadro. **Migração v1 → v2 na leitura** (`migrateLayout`): "Mesa 1", um quadro, `views['frame-1']` = o arquivo antigo **sem alterar um byte**; `layout.v1.bak` gravado antes da primeira escrita v2 (IPC `layout:backup`). `pruneDesk`/`pruneLayoutV2` podam painel a painel por quadro; quadro vazio sai da grade (raiz continua branch); nada sobrevivendo → um quadro vazio. `frameInsertion` planeja "quadro na borda da mesa" (irmão na raiz, ou embrulho ortogonal da raiz — o mesmo movimento que o dockview faz no drop de borda; o embrulho usa `insertOrthogonalSplitviewAtRoot`, privado no dockview-core 8, numa única chamada comentada).
- **`Desk`** (`app/renderer/desk.ts`): gridview de `Frame`s (`GridviewPanel` com um `createDockview` próprio); o renderer segue falando de painéis (`getPanel`, `addPanel(options, target, reference)`, `activePanel`, `removePanel`) e o Desk roteia ao dockview certo. Foco: quadro ativo segue o foco (gridview `onDidActivePanelChange`) e o último `addPanel`. Restauração à prova de perda: se o gridview recusar o JSON, os quadros são recriados lado a lado; se um dockview recusar, cada painel do `views` é reaberto um a um (`loadView`).
- **Criação relativa (`Target { level, placement }`)**: painel ao lado (`position` com `referencePanel`), painel na borda do quadro (`addPanel({ position: { direction } })` sem referência = raiz do grid do quadro, ocupa a altura/largura inteira), quadro na borda da mesa (`Desk.addFrame(direction)` + painel dentro). Shortcuts, "+" e menus em `main.ts`: `duplicateActive(target)`, `onEdge(target, op, frameId)`.
- **Testes:** unit `app.layout` (21: prune v1, migração com fixture real `test/unit/fixtures/layout-v1-real.json` — o `layout.json` da máquina do Guga, 8 painéis em 2 grupos, raiz com branch aninhado — v2 intacto, lixo é null, prune por quadro, quadro vazio some, nada sobrevive → quadro vazio, `frameInsertion` em cada borda, `nextFrameId`), `app.shortcuts` (3: chord único, ida e volta, dicas), `app.create` (ajustado aos níveis + `TARGETS`). E2E `app.frames` (shells, home/pipe privados, `CLAUDE*` retirados, `--model haiku`).

Prova (minha, janela escondida, `TETHER_CLAUDE_ARGS` desligado):

| O quê | Resultado |
|---|---|
| `npm run check` | typecheck limpo (`tsc -p .` e `tsc -p app/renderer`); `npm test` rodada completa 286 testes: 285 verdes, a única falha era a contagem fixa da fixture real (o Guga abriu um 8º painel entre a cópia e a rodada); corrigida (conta lida da fixture) e `app.layout` 21/21 em separado. A rodada completa não foi repetida (memória da máquina) |
| `app.frames` (novo) | **escrito, não concluído**: duas tentativas (janela escondida) foram mortas pelo harness por falta de memória da máquina (4,1 GB livres de 31,7 GB; o disco D: também chegou a 0 bytes livres durante a sessão — `PLAN.md` e `README.md` foram truncados por um `write` e restaurados do git). O teste cobre: v1 reescrito no `layout.json` → migração com os mesmos painéis, mesma disposição, mesmos PIDs, `layout.v1.bak` byte a byte, `layout.json` regravado em v2; `Ctrl+Alt+Shift+↓` → painel filho direto da raiz do quadro, largura do quadro; `Alt+Shift+→` → `frame-2` à direita com a altura da mesa, foco no quadro novo; "+" da mesa (clique) → `frame-3`; "+" do quadro (Shift+clique) → seletor com `frame:above` marcado e 3 grupos; seletor `desk:below` → `frame-4` com a largura da mesa; kill da janela → mesmos quadros, mesma atribuição painel→quadro, mesmos PIDs; `forget` do único painel de `frame-2` → quadro some e sai do arquivo. **Rodar quando a máquina tiver memória:** `$env:TETHER_E2E_HIDDEN=1; node --test --test-concurrency=1 test/e2e/app.frames.test.ts` (com `TETHER_CLAUDE_ARGS` desligado) |
| `app.layout`, `app.duplicate` | não rodados nesta sessão (mesma falta de memória que matou o `app.frames`); `app.layout` foi ajustado para ler o JSON do quadro (`frameLayout`) e precisa de uma rodada |
| `npm run app:build` | ok |

Capturas em `test/e2e/artifacts/`: `frames-migrated.png`, `frames-two.png`, `frames-plus-desk.png`, `frames-plus-frame.png`, `frames-chooser-levels.png`, `frames-four.png`, `frames-restored.png`.

**tetherd:** não precisa reiniciar (nada em `src/daemon`, `src/agents`, `src/core`). O app precisa de `npm run app:build` (feito) e reabrir; na primeira abertura o `layout.json` do Guga vira v2 e `layout.v1.bak` fica ao lado.
