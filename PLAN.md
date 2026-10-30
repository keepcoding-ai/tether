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

---

# Fase 2 — o app (ver PRD §11–15)

Objetivo final: **entregar o app**. A fase 1 é a base dele e continua em paralelo.

## Contrato

`src/daemon/protocol.ts`: mensagens entre o `tetherd` (dono dos PTYs) e os clientes (app, CLI). NDJSON sobre named pipe.

## Tarefas

| Tarefa | Depende de | Arquivos | Modelo/esforço |
|---|---|---|---|
| **A1. App shell** — Electron + dockview + xterm.js; sobe/conecta ao tetherd; layout salvo; cabeçalho dos painéis; novo painel (tipo + pasta); desenvolvido contra um tetherd falso que segue o protocolo | protocolo | `app/**` | fable, high |
| **A2. tetherd** — servidor do protocolo; PTY por slot (node-pty); buffer de rolagem (anel ~1 MB/slot); lança via adapters; observa os `.jsonl` e emite `state`; fila de retomada (3 por vez); sobe destacado; um só por usuário | T1, T2 | `src/daemon/**`, `test/unit/daemon.*` | fable, high |
| **A3. Integração** — app ↔ tetherd real; E2E do tetherd (sem janela) e do app (Playwright Electron): split 4, kill da janela, reabrir = mesmo layout e mesmos agentes vivos; kill do tetherd = retomada certa | A1, A2, T6 | `test/e2e/app.*`, `test/e2e/daemon.*` | fable, high |
| **A4. Empacotar** — `npm run app`, atalho no Menu Iniciar (sem instalador por enquanto), ícone | A3 | `scripts/`, `package.json` | fable, medium |

**T4 (CLI) muda de papel:** vira cliente do tetherd (`tether ls/open/new` falam com o daemon; sem daemon, `new/open` rodam o agente no terminal atual) — útil fora do app e para depuração.

## Ordem

```
agora:   T1 ║ T2 ║ T3 ║ T5 ║ A1 (contra tetherd falso)
depois:  A2 (após T1+T2) ║ T4 ║ T6
depois:  A3 ║ T7 ║ T8 ──► A4 ──► uso real
```

Entrega para o Guga usar, uma etapa por vez: (1) CLI com Claude; (2) app com painéis e reconexão; (3) app completo com soul.

---

# Fase 3 — mesas, quadros, painéis e gaveta (2026-10-29)

Modelo de agrupamento do app, decidido com o Guga. Nomes fixos (interface em português, código em inglês):

| Interface | Código | O que é |
|---|---|---|
| **Mesa** | `desk` | um contexto inteiro; agrupamento livre (não é "cliente"). As mesas ficam numa fila, como áreas de trabalho do Linux: troca rápida pela faixa na tela (nome + cor) e por atalho. Trocar de mesa nunca para nada; a mesa mostra um selo quando um agente dela terminou ou espera entrada. |
| **Quadro** | `frame` | uma região da mesa com divisão interna própria (ex.: um grande à esquerda, um pequeno à direita). O app de hoje inteiro é UM quadro. |
| **Painel** | `pane` (`slot` continua sendo o processo no daemon) | o terminal, com abas e divisões, como hoje. |
| **Gaveta** | `drawer` | um espaço rápido chamado por atalho ou botão: desliza por cima do app a 8 px das bordas, com fundo escurecido; contém quadros e painéis; fecha com Esc e guarda o conteúdo (os agentes seguem rodando). Uma só gaveta, compartilhada por todas as mesas. |

**Um gesto só — "novo na direção X" — em cada nível, sempre relativo ao foco:** painel ao lado do painel em foco (a divisão de hoje); painel na borda do quadro atual, ocupando a altura ou a largura inteira do quadro; quadro na borda da mesa; mesa antes ou depois da atual na fila.

**Duas operações de "novo terminal", em todo gesto de criar:** **"Novo painel…"** abre o seletor (perfil / agente / pasta / onde) e **"Duplicar painel"** abre outro painel com o mesmo perfil, agente e pasta, numa **sessão nova**. Regra fixa em todos os níveis: **o atalho puro e o "+" do mouse duplicam; a entrada de menu (≡, clique direito) e o seletor escolhem.** O seletor sempre traz a escolha de "onde" relativa ao painel em foco.

## Atalhos (proposta; ver "Decisões para validar" no PROGRESS.md)

| Gesto | Atalho | Observação |
|---|---|---|
| Painel ao lado do painel em foco (duplicar) | `Ctrl+Alt+←/→/↑/↓` | `Ctrl+Shift+D` (direita) e `Ctrl+Shift+E` (abaixo) continuam como sinônimos |
| Novo painel… (seletor, com "onde") | `Ctrl+Shift+T` | o seletor tem a linha "Onde" |
| Painel na borda do quadro (duplicar) | `Ctrl+Alt+Shift+←/→/↑/↓` | fase B |
| Quadro na borda da mesa (duplicar) | `Alt+Shift+←/→/↑/↓` | **`Ctrl+Win+←/→` é do próprio Windows (troca de área de trabalho virtual) e `Win+↑/↓` maximiza/minimiza: o sistema intercepta antes do app.** `Alt+Shift+seta` está livre nos shells e na TUI do Claude; alternativa, se colidir com a troca de layout de teclado (Alt+Shift com dois layouts instalados): prefixo `Ctrl+Alt+F` e depois a seta |
| Mesa antes/depois da atual | `Ctrl+Alt+Shift+N` / `Ctrl+Alt+N` | fase C |
| Trocar de mesa | `Ctrl+Tab` / `Ctrl+Shift+Tab` (ciclo) e `Ctrl+1…9` (direta) | fase C |
| Gaveta | `` Ctrl+` `` | fase D |

Com o mouse, um "+" fino aparece perto das bordas; o tamanho diz o nível (painel < quadro < mesa). Clique = duplicar; clique direito (ou Shift+clique) = seletor.

## Fase A — as duas operações de novo terminal (entregue)

- **Modelo:** nada muda no `layout.json` (um `SerializedDockview`). Daemon: nada (o `create` já cria slot sem vínculo = sessão nova).
- **UI:** `app/renderer/create.ts` (puro: `shortcutOf`, `duplicateRequest`, `PLACEMENTS`); barra: "Novo painel…" e "Duplicar painel" (os botões "Direita"/"Abaixo", que clonavam os dois, saem); seletor com a linha **"Onde, em relação a <painel>"** (nesta aba / à esquerda / à direita / acima / abaixo; escondida sem painel); menu ≡: "Novo painel…", "Duplicar painel à direita/abaixo"; clique direito na aba: as duas operações relativas àquela aba; `Ctrl+Alt+setas` duplica ao lado do painel em foco.
- **Duplicar =** mesmo `kind`, mesma `cwd`, mesmo `profileId` (se o perfil ainda existe), **sessão nova** (sem `name`, sem vínculo; o Claude sobe com `--session-id` novo, nunca `--resume`). Se o daemon recusa (pasta/perfil sumiu), o seletor abre pré-preenchido no mesmo lugar.
- **Testes:** unit `app.create` (atalhos, corpo do `create`, posições); E2E `app.duplicate` (seletor, duplicar à direita com Claude real em sessão nova, "Onde" abaixo com PowerShell, duplicar à esquerda/acima, menus).
- **Aceite:** no app, Ctrl+Alt+→ num painel do Claude abre outro Claude na mesma pasta e perfil, com conversa própria; "Novo painel…" pergunta perfil, pasta e onde; nenhuma entrada chamada "Direita"/"Abaixo" clona sem dizer.

## Fase B — quadros dentro da mesa única + criação relativa

- **Modelo (`layout.json` v2):** `{ v: 2, desks: [{ id, name, color, frames: { grid: SerializedGridview, views: Record<frameId, SerializedDockview> }, activeFrame }], activeDesk, drawer: null }`. Um quadro = uma instância própria de dockview (`createDockview`) dentro de uma célula de um **gridview** (`createGridview` do dockview-core) que é a mesa. Migração v1 → v2 na leitura: o `SerializedDockview` de hoje vira a mesa "Mesa 1" com um único quadro cujo `views[frame-1]` é o JSON antigo **byte a byte**; `pruneLayout` passa a rodar por quadro; gravação sempre em v2 (com cópia `layout.v1.bak` na primeira migração). Teste unitário da migração com o layout real do Guga como fixture.
- **Daemon:** nada.
- **UI:** `Desk` (gridview de quadros) e `Frame` (dockview + foco); foco único no app (painel em foco → quadro em foco); "novo na borda do quadro" = `addPanel` com posição relativa à raiz do grid do quadro (dockview aceita `direction` sem `referencePanel`/`referenceGroup`: ocupa a altura/largura inteira); "novo quadro na borda da mesa" = célula nova no gridview na direção; quadro vazio some. Linha "Onde" do seletor ganha os níveis (painel / quadro / mesa) como grupos. "+" fino ao passar o mouse perto das bordas internas (painel) e das bordas do quadro (um pouco maior). Arrastar aba entre quadros: dockview suporta drag entre instâncias; se o custo passar de uma fatia, vira pendência.
- **Testes:** unit (`layout.v2`: migração, inserir quadro em cada borda, remover quadro vazio, prune por quadro); E2E `app.frames` com shells: Ctrl+Alt+Shift+→ ocupa a altura inteira; Alt+Shift+→ cria quadro; matar a janela e reabrir devolve mesas/quadros/painéis iguais (mesmos PIDs); o layout v1 do Guga reabre com o mesmo conjunto de painéis.
- **Aceite:** o layout atual do Guga abre igual (um quadro); ele cria um quadro à direita e dois painéis nele; fecha e reabre o app e está tudo no lugar.

## Fase C — mesas, troca rápida e selos

- **Modelo:** `desks[]` já existe desde B; cada mesa guarda `name`, `color` (paleta de 8 cores), `frames`; `activeDesk`. Mesa nova = uma mesa com um quadro vazio (marca d'água "Nenhum painel"). Apagar mesa só se vazia (senão o diálogo próprio oferece mover os painéis para a mesa vizinha ou encerrar).
- **Daemon (precisa reiniciar o tetherd):** **atenção por slot.** O adaptador do Claude passa a injetar também os hooks `Stop` (resposta terminada) e `Notification` (`permission_prompt`/`idle_prompt`: espera entrada) no `--settings`; o hook grava um evento `attention: 'done' | 'input'` no `.jsonl`; o daemon o expõe em `SlotState.attention` e o limpa quando chega `input` do cliente ou um request novo `seen { slotId }` (o painel ganhou foco). soul: sem hook ainda; heurística no daemon — saída que parou depois de uma rajada com o slot sem foco → `done`; BEL (`\x07`) → `input`. Shell: só BEL. `PROTOCOL_VERSION` sobe.
- **UI:** faixa de mesas acima dos quadros (nome + cor + selo com contagem; clique troca; clique direito: renomear, cor, mover, apagar); troca sem desmontar nada (as mesas inativas ficam no DOM com `visibility:hidden` e tamanho mantido, para os xterms continuarem recebendo `data` sem `resize` nos agentes); `Ctrl+Tab`/`Ctrl+Shift+Tab`/`Ctrl+1…9`; `Ctrl+Alt+N`/`Ctrl+Alt+Shift+N` criam depois/antes; selo na aba e no painel também (`attention`), some ao focar.
- **Testes:** unit (ordem das mesas, inserir antes/depois, apagar vazia, `attention` no store/daemon com payloads reais dos hooks); E2E `app.desks` (shells: criar 3 mesas, trocar por atalho, kill da janela e reabrir na mesma mesa ativa) e `app.attention` (Claude real: pergunta numa mesa, troca de mesa, selo aparece ao terminar; volta → selo some).
- **Aceite:** o Guga separa os painéis em duas mesas, troca com Ctrl+Tab e vê o selo quando o Claude da outra mesa termina.

## Fase D — gaveta

- **Modelo:** `drawer: { frames: {...} }` no `layout.json` (mesmo formato de uma mesa, sem nome/cor); `drawerOpen` não é persistido (abre sempre fechada).
- **Daemon:** nada.
- **UI:** camada fixa a 8 px das bordas com fundo escurecido, contendo um `Desk` sem faixa; `` Ctrl+` `` e botão na barra alternam; Esc fecha (se nenhum diálogo estiver aberto); o conteúdo fica montado e escondido quando fechada (`visibility:hidden`, mesmo tamanho); o foco volta ao painel que tinha foco na mesa. Um painel só existe num lugar: "Mover para a gaveta" / "Mover para a mesa" no clique direito da aba.
- **Testes:** unit (modelo: mover painel mesa ↔ gaveta); E2E `app.drawer` (shell na gaveta segue vivo e recebendo saída com a gaveta fechada; Esc fecha; reabrir o app mantém a gaveta e seus painéis).
- **Aceite:** o Guga guarda um shell de utilidades na gaveta, chama com `` Ctrl+` `` de qualquer mesa, fecha com Esc e o shell continua onde estava.

Ordem: A → B → C → D, cada fase usada pelo Guga antes da seguinte. B e C mudam o formato do layout: a migração nunca descarta um painel que o daemon conhece.
