# Progresso — tether fase 1

Fonte da verdade do andamento do [PLAN.md](./PLAN.md). Atualizado a cada tarefa.

| Tarefa | Estado | Prova |
|---|---|---|
| Onda 0 — preparação | concluída | commits d7478f5, ae0a488 |
| T1 Núcleo de estado | concluída | merge 53f0acb; tsc ok; 32/32 testes isolados (liveness lenta sob carga, ver decisão) |
| T2 Adapter Claude | em andamento (fable, high) | |
| T3 Harness E2E | em andamento (fable, high) | |
| T4 CLI e lançamento | pendente | |
| T5 soul-cli `SOUL_SESSION_REPORT` | em andamento (fable, high; worktree soul-cli-tether, branch feat/session-report) | |
| T6 Cenários E2E Claude | pendente | |
| T7 Adapter + cenários soul | pendente | |
| T8 Robustez e doctor | pendente | |
| Onda 4 — suíte 3x verde, docs | pendente | |

## Critério de parada (fase 1, parte automatizável)

- [ ] `npm run check` verde (typecheck + unitários)
- [ ] `npm run test:e2e` verde 3 vezes seguidas (Claude e soul)
- [ ] soul-cli: `bun run check` verde no branch da mudança
- [ ] README com uso real; PRD atualizado
- [ ] Todas as linhas acima = concluída, com prova

A semana de uso real (PRD §8) é do usuário.

## Decisões para validar

- Autorizado pelo usuário a tocar o projeto sem parar: `git init` feito; soul-cli será alterado num branch próprio (`tether-session-report`), sem push.
- T1: verificação de processo vivo via PowerShell (start time) leva 0,7–6 s e falha sob carga. Substituir por canal nomeado por slot (`\.\pipe\tether-slot-<id>`) mantido pelo processo dono do slot (launcher da CLI ou tetherd): conectar = vivo. Instantâneo e imune a PID reaproveitado. Entra na A2/T4.
- soul-cli em worktree (`D:\atrium\workspace\soul-cli-tether`, branch `feat/session-report`) em vez de commitar direto no develop: o checkout principal está em uso. Merge no develop depois de provado.
- App em Electron + xterm.js + dockview (sem Rust na máquina; Tauri exigiria MSVC/Visual Studio, vetado). Dependências só por projeto.
- Limite de 2 agentes em paralelo: a onda 1 começou com 4 antes de eu ler esse acordo; não interrompi os que estavam rodando e não lanço novos até sobrarem 2.
