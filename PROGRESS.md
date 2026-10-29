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
- P1 núcleo (store, validação, daemon, CLI): em andamento (fable, high).
- P2 interface (escolha no Novo painel, tela de perfis, selo "sem permissões"): depois dos diálogos próprios.
