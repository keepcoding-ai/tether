# Progresso — tether fase 1

Fonte da verdade do andamento do [PLAN.md](./PLAN.md). Atualizado a cada tarefa.

| Tarefa | Estado | Prova |
|---|---|---|
| Onda 0 — preparação | concluída | commits d7478f5, ae0a488 |
| T1 Núcleo de estado | concluída | merge 53f0acb; tsc ok; 32/32 testes isolados (liveness lenta sob carga, ver decisão) |
| T2 Adapter Claude | concluída | merge 44c1fe6; 31/31 unit; smoke real (novo + resume) pelo agente |
| T3 Harness E2E | concluída | merge ed10f0a; smoke E2E rodado por mim: 2/2 (51 s); fullscreen intacto |
| T4 CLI e lançamento | pendente | |
| T5 soul-cli `SOUL_SESSION_REPORT` | feita, aguarda OK do Guga p/ merge no develop + instalar | branch feat/session-report 0155b7a; 22/22 testes rodados por mim; prova ao vivo no agente serpente (startup, resume, continue, fork) |
| T6 Cenários E2E Claude (via tetherd) | concluída | merge; 101/101 unit; suíte E2E 17/17 rodada por mim (313 s) + 2 execuções verdes pelo agente = 3 seguidas; fullscreen intacto |
| T7 Adapter + cenários soul | pendente | |
| T8 Robustez e doctor | pendente | |
| Onda 4 — suíte 3x verde, docs | pendente | |
| A1 App shell (Electron + dockview + xterm) | concluída (A1a) | merge 19b068a; typecheck ok; screenshots revisados por mim: 4 painéis ocupam a janela (defeito de layout do Guga corrigido: faltava o CSS do dockview) |
| A2 tetherd | concluída (A2a + A2b) | A2a: 81/81 unit; prova real com Claude pelo agente; minha prova: shell sobrevive à desconexão do cliente (mesmo PID), histórico no novo cliente, shutdown sem órfãos ; A2b: 95/95 unit; minha prova: soul pelo tetherd, stop + start retoma a mesma sessão (source=resume, mesmo id) |
| A3 Integração app ↔ tetherd + E2E | em andamento (fable, high) | |
| A4 Empacotar (npm run app, atalho) | pendente | |

## Critério de parada (fase 1, parte automatizável)

- [ ] `npm run check` verde (typecheck + unitários)
- [ ] `npm run test:e2e` verde 3 vezes seguidas (Claude e soul)
- [ ] soul-cli: `bun run check` verde no branch da mudança
- [ ] README com uso real; PRD atualizado
- [ ] App (A1–A4): E2E do tetherd e do app verdes (split 4, kill da janela, reabrir = mesmo layout e agentes vivos; kill do tetherd = retomada certa)
- [ ] App aberto e usado por mim como o Guga usaria (screenshot), com `npm run app` e atalho no Menu Iniciar
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
