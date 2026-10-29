# Plano de implementação — tether, fase 1

**Base:** [PRD.md](./PRD.md) · **Data:** 2026-10-29

**Como vai ser executado:** cada tarefa abaixo é entregue a um agente rodando o modelo **Claude Fable 5.1**. A sessão principal orquestra: dispara as tarefas de cada onda em paralelo, revisa, roda os testes e só então libera a próxima onda.

## 1. Decisões técnicas

| Tema | Decisão | Por quê |
|---|---|---|
| Linguagem | TypeScript, executado direto pelo Node 24 (type stripping, `erasableSyntaxOnly`) | Sem passo de build; mesmo ambiente do soul-cli |
| Dependências de runtime | **Nenhuma** | O hook roda a cada troca de sessão e precisa ser rápido e à prova de falhas |
| Dependências de teste | `node-pty` (já validado no spike) | Dirigir o `claude` e o `soul` reais |
| Testes | `node --test` | Nativo, sem framework |
| Estado | `%LOCALAPPDATA%\tether\` (sobrescrevível por `TETHER_HOME`) | Os testes usam um `TETHER_HOME` temporário |
| Lançamento | O tether lança o agente como processo filho, com `stdio: inherit`, e fica vivo enquanto ele roda | É assim que sabemos o PID real do agente (descoberta 3 do E0) |
| Repositório | `git init` no início, um commit por tarefa aprovada | Permite revisar e reverter por tarefa |

## 2. Estrutura

```
bin/tether                  atalho: node src/cli/main.ts
src/
  core/
    paths.ts                onde fica o estado (TETHER_HOME)
    event.ts                formato do evento v1 + leitura tolerante a linha corrompida
    store.ts                slots: criar, acrescentar evento, ler histórico, vínculo atual
    liveness.ts             o processo do slot está vivo? (PID + horário de início)
  agents/
    types.ts                interface AgentAdapter
    claude.ts               montar comando, settings com hooks, limpar CLAUDE*, receita de retomada, título, sessão existe?
    soul.ts                 idem para o soul (SOUL_SESSION_REPORT)
  report/
    claude-hook.ts          entrada do hook: stdin → evento (mínimo de imports; nunca falha alto)
  launch.ts                 lança o agente no slot e registra o PID
  cli/
    main.ts                 new, open, ls, show, rm, doctor, report
test/
  unit/                     core e adapters, sem agentes reais
  e2e/
    harness.ts              driver node-pty (evoluído do spike)
    claude.scenarios.test.ts
    soul.scenarios.test.ts
spike/                      prova do E0 (mantida como referência)
```

### Interface de agente (contrato entre o núcleo e cada agente)

```ts
interface AgentAdapter {
  name: 'claude' | 'soul'
  launch(slot: Slot, opts: { cwd: string; args: string[]; resume?: Binding }): { cmd: string; args: string[]; env: Record<string, string> }
  sessionExists(binding: Binding): Promise<boolean | 'unknown'>
  title(binding: Binding): Promise<string | undefined>
}
```

Adicionar um terceiro agente no futuro = escrever outro adapter.

## 3. Ondas e tarefas

Cada tarefa tem escopo fechado, arquivos definidos e critério de aceite verificável. Tarefas da mesma onda rodam em paralelo.

### Onda 0 — preparação (sessão principal, ~15 min)

- `git init`, `package.json`, `tsconfig.json` (só checagem de tipos), `.gitignore`, `bin/tether`.
- Mover o driver do spike para `test/e2e/harness.ts` como ponto de partida.
- Escrever `src/agents/types.ts` e os tipos de `event.ts` (o contrato que as tarefas paralelas compartilham).

### Onda 1 — fundações (3 agentes Fable em paralelo)

**T1. Núcleo de estado** — `src/core/*`
- Evento v1 conforme PRD §6.3; leitura ignora linhas corrompidas.
- `store`: criar slot (`<id>.json`), append atômico por linha, histórico, **vínculo atual** = último evento de sessão (`SessionStart`/equivalente do soul); `rename` atualiza só o título.
- `liveness`: PID vivo **e** horário de início igual ao registrado (evita PID reaproveitado no Windows).
- **Aceite:** testes unitários de concorrência (2 processos escrevendo em slots diferentes e no mesmo slot), linha corrompida no meio, vínculo correto após `clear`/`resume`/`fork`, PID reaproveitado detectado.

**T2. Adapter do Claude** — `src/agents/claude.ts`, `src/report/claude-hook.ts`
- Gera o JSON de `--settings` com `SessionStart`/`SessionEnd` chamando `node "<tether>/src/report/claude-hook.ts"`.
- Remove todas as variáveis `CLAUDE*` do ambiente; define `TETHER_SLOT_ID`, `TETHER_HOME`.
- Sessão nova: gera UUID e passa `--session-id`. Retomada: `--resume <id>` na pasta do vínculo.
- `title`: última linha `custom-title` do transcript. `sessionExists`: o arquivo do transcript existe.
- O hook: lê stdin, grava o evento e sai com 0 **sempre**, em menos de 100 ms.
- **Aceite:** unitários com payloads reais capturados no E0 (startup, resume, fork, compact, clear, exit, other); medição de tempo do hook; hook com `TETHER_HOME` inválido não quebra.

**T3. Harness E2E** — `test/e2e/harness.ts`
- API: `const s = await slot.start('claude', { cwd })`, `await s.type('/clear')`, `await s.waitIdle()`, `s.kill()`, `s.events()`, `s.screen()`.
- Esperas por estado da tela em vez de `sleep` fixo; aceita a pergunta de confiança da pasta; ambiente limpo; pasta temporária e `TETHER_HOME` temporário por teste.
- **Aceite:** um teste de fumaça que abre o Claude (haiku), responde a uma mensagem e sai, 5 vezes seguidas sem falhar.

### Onda 2 — produto utilizável (2 agentes em paralelo)

**T4. CLI e lançamento** — `src/launch.ts`, `src/cli/main.ts`
- Comandos do PRD §6.5: `new`, `open`, `ls`, `show`, `rm`, `doctor`, `report`.
- `open` aplica as regras de confiança (PRD §6.6): sessão existe, pasta existe, slot não está vivo em outro lugar; vínculo "não confirmado" pede escolha.
- `ls` em tabela legível; `--json` para a IDE da fase 2.
- Funciona igual em PowerShell, Git Bash (Windows Terminal) e mintty (orientar `winpty` no `doctor`).
- **Aceite:** unitários de CLI + uso manual roteirizado: criar 2 slots, fechar, `ls`, `open` cada um.

**T5. soul-cli: `SOUL_SESSION_REPORT`** — no repositório `D:\atrium\workspace\soul-cli` ⚠️ **depende de aprovação**
- Com a variável definida, o cliente acrescenta uma linha a cada sessão ativa (abertura, `-r`, `-c`, `/resume`, `/new`, `/clear`, `/branch`, fork), a cada rename, quando a sessão ganha ID, e no encerramento.
- Inclui a receita de retomada (pasta, `-a`, `-H`, `-g`/`--config-dir`, `-P`).
- Escrita nunca quebra o soul. Segue as convenções e o `bun run check` do próprio repositório.
- **Opcional:** `--session-id <uuid>` cria a sessão quando ela não existe.
- **Aceite:** testes no próprio soul-cli para cada origem; `bun run check` verde.

### Onda 3 — prova (3 agentes em paralelo)

**T6. Cenários E2E do Claude** — `test/e2e/claude.scenarios.test.ts`
- C1–C5, C7–C16 e C18 do PRD, via `tether new`/`open` de verdade (não pelos scripts do spike).
- C11: kill no meio da resposta → `open` → o agente lembra a conversa.
- C12: simulado (matar tudo + apagar qualquer estado em memória + `open` de todos).

**T7. Adapter + cenários do soul** — `src/agents/soul.ts`, `test/e2e/soul.scenarios.test.ts` (depende de T5)
- C1–C18 aplicáveis, incluindo C6 (`/new`) e C17 (`-H`, `-g`, `--config-dir`, `-P`).

**T8. Robustez e `doctor`**
- C13 em carga: 10 slots, metade na mesma pasta, trocas aleatórias, zero vínculos errados.
- `doctor`: versões dos agentes, suporte do soul a `SOUL_SESSION_REPORT`, escrita em `TETHER_HOME`, hook do Claude executando de fato, aviso sobre `CLAUDE*` e mintty.

### Onda 4 — fechamento (sessão principal)

- Suíte completa 3 vezes seguidas, 100% verde.
- README atualizado com uso real; PRD marcado com o que mudou.
- Começa a semana de uso real (critério final do PRD §8).

## 4. Como cada tarefa é conduzida

1. **Briefing do agente Fable:** PRD, este plano, os contratos da onda 0, os arquivos do spike, a tarefa e o critério de aceite. Instrução explícita: não sair do escopo; dúvidas viram nota no relatório, não decisões silenciosas.
2. **Isolamento:** cada agente trabalha num git worktree próprio, e os merges são feitos na ordem da onda.
3. **Verificação pela sessão principal:** ler o diff, rodar os testes da tarefa e os unitários de tudo, e fazer uma revisão de código antes do merge.
4. **Falhou o aceite:** volta para o mesmo agente com o problema concreto. Não é aceito "funciona na minha máquina".

## 5. Custos e cuidados

- **E2E gasta tokens.** O Claude roda com `--model haiku` e prompts de uma palavra; o soul usa o modelo mais barato. A suíte completa deve ficar em poucas dezenas de chamadas curtas.
- **E2E não roda em paralelo dentro do mesmo agente** (o Claude real é sensível a carga); só T8 testa concorrência, de propósito.
- **Nada global é alterado:** nem `~/.claude/settings.json`, nem `~/.soul/settings.json`.
- **O soul-cli é outro repositório:** T5 só começa com aprovação explícita; o resto do plano segue sem ele.

## 6. Ordem e paralelismo

```
Onda 0 ──► Onda 1: T1 ║ T2 ║ T3 ──► Onda 2: T4 ║ T5* ──► Onda 3: T6 ║ T7* ║ T8 ──► Onda 4
                                                 * T5 e T7 dependem da aprovação do soul-cli
```

No máximo 3 agentes Fable ao mesmo tempo; 8 tarefas no total.

## 7. Pendências para começar

1. Aprovação para alterar `D:\atrium\workspace\soul-cli` (T5). Sem ela, o plano entrega o Claude completo e deixa o soul para depois.
2. Ok para `git init` nesta pasta.
