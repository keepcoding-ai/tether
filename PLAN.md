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
| Aba vazia no grupo em foco (o seletor dentro dela) | `Ctrl+Shift+T` | F5: "Novo painel…" (o mesmo seletor numa janela, com a linha "Onde") ficou sem chord: ≡, "+" do topo, paleta |
| Painel na borda do quadro (duplicar) | `Ctrl+Alt+Shift+←/→/↑/↓` | fase B (entregue; registro único em `app/renderer/shortcuts.ts`) |
| Quadro na borda da mesa (duplicar) | `Alt+Shift+←/→/↑/↓` | fase B (entregue). **`Ctrl+Win+←/→` é do próprio Windows (troca de área de trabalho virtual) e `Win+↑/↓` maximiza/minimiza: o sistema intercepta antes do app.** `Alt+Shift+seta` está livre nos shells e na TUI do Claude; alternativa, se colidir com a troca de layout de teclado (Alt+Shift com dois layouts instalados): prefixo `Ctrl+Alt+F` e depois a seta |
| Mesa antes/depois da atual | `Ctrl+Alt+Shift+N` / `Ctrl+Alt+N` | fase C |
| Trocar de mesa | `Ctrl+Tab` / `Ctrl+Shift+Tab` (ciclo) e `Ctrl+1…9` (direta) | fase C |
| Gaveta | `` Ctrl+` `` | fase D |

Com o mouse, um "+" fino aparece perto das bordas; o tamanho diz o nível (painel < quadro < mesa). Clique = painel vazio ali, com o seletor dentro (F5); clique direito = menu (novo painel aqui, duplicar o painel em foco aqui, seletor em modo foco).

## Fase A — as duas operações de novo terminal (entregue)

- **Modelo:** nada muda no `layout.json` (um `SerializedDockview`). Daemon: nada (o `create` já cria slot sem vínculo = sessão nova).
- **UI:** `app/renderer/create.ts` (puro: `shortcutOf`, `duplicateRequest`, `PLACEMENTS`); barra: "Novo painel…" e "Duplicar painel" (os botões "Direita"/"Abaixo", que clonavam os dois, saem); seletor com a linha **"Onde, em relação a <painel>"** (nesta aba / à esquerda / à direita / acima / abaixo; escondida sem painel); menu ≡: "Novo painel…", "Duplicar painel à direita/abaixo"; clique direito na aba: as duas operações relativas àquela aba; `Ctrl+Alt+setas` duplica ao lado do painel em foco.
- **Duplicar =** mesmo `kind`, mesma `cwd`, mesmo `profileId` (se o perfil ainda existe), **sessão nova** (sem `name`, sem vínculo; o Claude sobe com `--session-id` novo, nunca `--resume`). Se o daemon recusa (pasta/perfil sumiu), o seletor abre pré-preenchido no mesmo lugar.
- **Testes:** unit `app.create` (atalhos, corpo do `create`, posições); E2E `app.duplicate` (seletor, duplicar à direita com Claude real em sessão nova, "Onde" abaixo com PowerShell, duplicar à esquerda/acima, menus).
- **Aceite:** no app, Ctrl+Alt+→ num painel do Claude abre outro Claude na mesma pasta e perfil, com conversa própria; "Novo painel…" pergunta perfil, pasta e onde; nenhuma entrada chamada "Direita"/"Abaixo" clona sem dizer.

## Fase B — quadros dentro da mesa única + criação relativa (entregue)

- **Modelo (`layout.json` v2):** `{ v: 2, desks: [{ id, name, color, frames: { grid: SerializedGridview, views: Record<frameId, SerializedDockview> }, activeFrame }], activeDesk, drawer: null }`. Um quadro = uma instância própria de dockview (`createDockview`) dentro de uma célula de um **gridview** (`createGridview` do dockview-core) que é a mesa. Migração v1 → v2 na leitura: o `SerializedDockview` de hoje vira a mesa "Mesa 1" com um único quadro cujo `views[frame-1]` é o JSON antigo **byte a byte**; `pruneLayout` passa a rodar por quadro; gravação sempre em v2 (com cópia `layout.v1.bak` na primeira migração). Teste unitário da migração com o layout real do Guga como fixture.
- **Daemon:** nada.
- **UI:** `Desk` (gridview de quadros) e `Frame` (dockview + foco); foco único no app (painel em foco → quadro em foco); "novo na borda do quadro" = `addPanel` com posição relativa à raiz do grid do quadro (dockview aceita `direction` sem `referencePanel`/`referenceGroup`: ocupa a altura/largura inteira); "novo quadro na borda da mesa" = célula nova no gridview na direção; quadro vazio some. Linha "Onde" do seletor ganha os níveis (painel / quadro / mesa) como grupos. "+" fino ao passar o mouse perto das bordas internas (painel) e das bordas do quadro (um pouco maior). Arrastar aba entre quadros: dockview suporta drag entre instâncias; se o custo passar de uma fatia, vira pendência.
- **Testes:** unit (`layout.v2`: migração, inserir quadro em cada borda, remover quadro vazio, prune por quadro); E2E `app.frames` com shells: Ctrl+Alt+Shift+→ ocupa a altura inteira; Alt+Shift+→ cria quadro; matar a janela e reabrir devolve mesas/quadros/painéis iguais (mesmos PIDs); o layout v1 do Guga reabre com o mesmo conjunto de painéis.
- **Aceite:** o layout atual do Guga abre igual (um quadro); ele cria um quadro à direita e dois painéis nele; fecha e reabre o app e está tudo no lugar.
- **Como ficou:** `app/renderer/layout.ts` (modelo v2, `migrateLayout`, `pruneDesk`/`pruneLayoutV2`, `frameInsertion`), `app/renderer/desk.ts` (`Desk` = gridview de `Frame`s, cada um com seu dockview; foco por quadro; "+" nas bordas), `app/renderer/shortcuts.ts` (registro único dos atalhos; `shortcutOf`/`shortcutHint`), `create.ts` ganhou `Target { level, placement }`. O "+" entre painéis (nível painel) ficou para depois: `Ctrl+Alt+setas` cobre. Arrastar aba entre quadros: pendência (dockview recusa o drop de outra instância sem `onUnhandledDragOverEvent`).

## Fase C — mesas, troca rápida e selos (entregue)

- **Modelo:** `desks[]` já existe desde B; cada mesa guarda `name`, `color` (paleta de 8 cores), `frames`; `activeDesk`. Mesa nova = uma mesa com um quadro vazio (marca d'água "Nenhum painel"). Apagar mesa só se vazia (senão o diálogo próprio oferece mover os painéis para a mesa vizinha ou encerrar).
- **Daemon (precisa reiniciar o tetherd):** **atenção por slot.** O adaptador do Claude passa a injetar também os hooks `Stop` (resposta terminada) e `Notification` (`permission_prompt`/`idle_prompt`: espera entrada) no `--settings`; o hook grava um evento `attention: 'done' | 'input'` no `.jsonl`; o daemon o expõe em `SlotState.attention` e o limpa quando chega `input` do cliente ou um request novo `seen { slotId }` (o painel ganhou foco). soul: sem hook ainda; heurística no daemon — saída que parou depois de uma rajada com o slot sem foco → `done`; BEL (`\x07`) → `input`. Shell: só BEL. `PROTOCOL_VERSION` sobe.
- **UI:** faixa de mesas acima dos quadros (nome + cor + selo com contagem; clique troca; clique direito: renomear, cor, mover, apagar); troca sem desmontar nada (as mesas inativas ficam no DOM com `visibility:hidden` e tamanho mantido, para os xterms continuarem recebendo `data` sem `resize` nos agentes); `Ctrl+Tab`/`Ctrl+Shift+Tab`/`Ctrl+1…9`; `Ctrl+Alt+N`/`Ctrl+Alt+Shift+N` criam depois/antes; selo na aba e no painel também (`attention`), some ao focar.
- **Testes:** unit (ordem das mesas, inserir antes/depois, apagar vazia, `attention` no store/daemon com payloads reais dos hooks); E2E `app.desks` (shells: criar 3 mesas, trocar por atalho, kill da janela e reabrir na mesma mesa ativa) e `app.attention` (Claude real: pergunta numa mesa, troca de mesa, selo aparece ao terminar; volta → selo some).
- **Aceite:** o Guga separa os painéis em duas mesas, troca com Ctrl+Tab e vê o selo quando o Claude da outra mesa termina.
- **Como ficou:** `app/renderer/desks.ts` (fila pura), `desk-set.ts` (`DeskSet`, camadas empilhadas), `desk-strip.ts` (faixa), `Desk` reutilizável sem faixa (base da gaveta). Ctrl+Tab sequencial (não MRU). O hook grava `<slot>.attention` (não o `.jsonl`); `SlotState.attention` e `seen` opcionais, DAEMON_VERSION 0.3.0 (PROTOCOL_VERSION segue 1: nada quebra para clientes antigos). Atenção do soul = heurística de turno (Enter → ≥ 512 B → 4 s quieto) + BEL; shell = BEL. Fechar mesa com painéis sempre pergunta (mover é o padrão). Detalhes e provas no PROGRESS.md.

## Fase D — gaveta (entregue)

- **Modelo:** `drawer: { frames: {...} }` no `layout.json` (mesmo formato de uma mesa, sem nome/cor); `drawerOpen` não é persistido (abre sempre fechada).
- **Daemon:** nada.
- **UI:** camada fixa a 8 px das bordas com fundo escurecido, contendo um `Desk` sem faixa; `` Ctrl+` `` e botão na barra alternam; Esc fecha (se nenhum diálogo estiver aberto); o conteúdo fica montado e escondido quando fechada (`visibility:hidden`, mesmo tamanho); o foco volta ao painel que tinha foco na mesa. Um painel só existe num lugar: "Mover para a gaveta" / "Mover para a mesa" no clique direito da aba.
- **Testes:** unit (modelo: mover painel mesa ↔ gaveta); E2E `app.drawer` (shell na gaveta segue vivo e recebendo saída com a gaveta fechada; Esc fecha; reabrir o app mantém a gaveta e seus painéis).
- **Aceite:** o Guga guarda um shell de utilidades na gaveta, chama com `` Ctrl+` `` de qualquer mesa, fecha com Esc e o shell continua onde estava.
- **Como ficou:** `app/renderer/drawer-rules.ts` (puro: estado aberta/fechada + foco de volta, regra do Esc, pasta do shell padrão, contagem de atenção), `drawer.ts` (`Drawer`: um `Desk` dentro do painel `#drawer`; fechada fica montada com `visibility:hidden` + `inert`, mesmo tamanho), `layout.ts` (`drawer: DrawerLayout | null`; `null` lê como gaveta vazia; `pruneDrawer`; um painel mora em um lugar só), `desk.ts` (`transferPanel`/`transferFrame`, usados também pelas mesas). `` Ctrl+` `` alterna (alias `Ctrl+Shift+G` para o teclado ABNT2); botão "Gaveta" na barra com selo de atenção; "Abrir gaveta" na bandeja (`TrayCommand` `open-drawer`); "Mover para a gaveta" / "Mover para a mesa atual" (painel e quadro) pelo clique direito da aba e pelo menu ≡. Daemon: nada. Regra do Esc, gaveta vazia e demais decisões: PROGRESS.md, "Fase D".

Ordem: A → B → C → D, cada fase usada pelo Guga antes da seguinte. B e C mudam o formato do layout: a migração nunca descarta um painel que o daemon conhece.

---

# Fase 4 — Redesenho visual (2026-10-30)

Aprovado pelo Guga em 30/10 (decisões em `mind/effort/on/tether/tether.md`, "Redesenho visual"). **A especificação é `docs/tether-preview.html`** (HTML/CSS/JS da prévia: tokens, barra, cápsula, cartões, faixa de abas, barra de status, gaveta); o estudo de cor e contraste é `docs/desk-switcher-options.html` (paleta de 12 matizes `--x-{cor}` com os pares `-foreground` e `-text`; azul e roxo usam o preenchimento `-deep`). Nada do daemon muda: a fase inteira é `app/renderer` (+ `app/main` só para guardar preferências novas no `settings.json`).

## O que fica aprovado (resumo operacional)

| Área | Alvo |
|---|---|
| Superfícies | mesa = fundo (`--desk-bg`, também a barra); quadros = cartões flutuantes (`--frame-bg`, `--frame-border`, `--frame-radius`, respiro `--gap` 8px); painéis dentro do quadro separados por linha fina. Tudo token, nenhum valor fixo no código |
| Barra do topo | esquerda: ações fixadas só ícone · **centro verdadeiro da janela**: cápsula com a pílula fixa "⚡ Gaveta" à esquerda, as mesas, e um único "+N" fixo à direita · direita: ícones de estado (conexão com popover, tema com menu de ícone) e o ≡ com todas as ações · sem o nome "tether" |
| Cápsula | inativa = só texto na cor da mesa (`--x-{cor}-text`); ativa = preenchimento forte (`--x-{cor}` / `-foreground`); selo de atenção com anel na cor da barra; sem fase de iniciais: nomes inteiros enquanto cabem, depois "+N" (menu); escolher no "+N" segue uso recente (entra no lugar da visível usada há mais tempo; as outras não se mexem); a mesa ativa nunca vai para o "+N" |
| Linha da cor da mesa | 2px no topo da mesa, na cor da ativa; ligada por padrão; toggle no ≡ |
| Faixa de abas do painel | as abas; fixos à direita: "+N" (abas que não cabem, uso recente), toggle da barra de status, ⋯ (menu do painel com todas as ações do painel) |
| Barra de status | o cabeçalho recolhível de hoje, reestruturado em selos: só ícone para estados, só texto para informação, ícone+texto só para "sem restrições"; ações fixadas só ícone à direita; recolhida por padrão, por painel |
| Gaveta | janela inteira por cima da barra, inset 16px (`--drawer-inset`), cartão elevado sem backdrop, cartões de trás esmaecidos; barra fina própria (ícones à esquerda, pílula "Gaveta" pressionada ao centro — clicar fecha, como o X — e X à direita); dentro, uma mini-mesa com os mesmos cartões e faixas; estado vazio com convite |

## 1. Mapa do código atual → alvo

| Arquivo | Hoje | Alvo | Veredito |
|---|---|---|---|
| `app/renderer/styles.css` (661 l.) | tokens `--bg/--bg-2/--bg-3/--bg-hover/--fg/--fg-dim/--accent/--border/--ok/--warn/--err/…` em `:root`, `prefers-color-scheme` e `[data-theme]`; `#toolbar` flex com botões de texto; `#desk-strip` chips; `.desk/.frame/.frame-dock/.edge-plus`; `.panel/.panel-details/.panel-head/.status/.unsafe/.profile`; `.tether-tab`; `.drawer/.drawer-backdrop/.drawer-panel/.drawer-head`; menus `#app-menu/#ctx-menu`; diálogos | mesmos tokens **mais** `--desk-bg`, `--frame-bg`, `--frame-border`, `--frame-radius`, `--gap`, `--drawer-inset`, `--pane-divider`, `--x-alert`/`-foreground` e a paleta `--x-{cor}` (gerada); barra em grid `1fr auto 1fr`; cápsula `.desk-switch/.seg/.cnt`; cartões; tema dockview próprio (`.dv-theme-tether` com as variáveis `--dv-*` lidas dos tokens); faixa de abas e barra de status novas; gaveta `.drawer-card/.drawer-bar`; diálogos e menus **intocados** | **reescrito em partes** (fatias 1, 2, 4, 5, 6); a metade dos diálogos/perfis/tema do terminal fica |
| `app/renderer/index.html` | `#toolbar` com `#brand`, `#btn-new/#btn-duplicate/#btn-profiles` (texto), `#btn-closed` + `#closed-list`, `#btn-drawer` + `#drawer-badge`, `#spacer`, `#theme` + `#theme-select`, `#conn`, `#btn-menu` + `#app-menu`; `<nav id="desk-strip">`; `#dock`; `#drawer` com backdrop, `.drawer-head` (h2, nota, `#drawer-new/#drawer-duplicate/#drawer-close`) e `.drawer-body`; `#overlay`; diálogos | `#toolbar` em três zonas (`.tb-left`, `#desk-switch`, `.tb-right`), botões só ícone com `title` + `aria-label`; `#desk-strip` **sai**; `#conn` vira botão com popover `#conn-pop`; `#theme-select` vira `#btn-theme` + menu `#theme-menu` (rádios); `#drawer` vira `.drawer-card` com `.drawer-bar` (mesmas três zonas) e `.drawer-empty`; diálogos intocados | **reescrito** (barra, gaveta); diálogos ficam |
| `app/renderer/desk-strip.ts` (181 l.) | `DeskStrip`: chips com barra de cor, selo, "+", renomear in-place, arrastar para reordenar, paleta `pickColor` (8 cores) | **`desk-switch.ts`** (novo): cápsula com pílula da Gaveta, segmentos, "+N" com menu MRU, medição de caber/não caber (`ResizeObserver`), rename in-place (mantido), menu de contexto (mantido via host), paleta com os 12 matizes; **arrastar para reordenar sai** (fica "Mover para a esquerda/direita" no menu, que já existe) | **substituído** |
| `app/renderer/desks.ts` (121 l.) | fila pura; `DESK_COLORS` (8, hex), `colorOf`, `nextDeskColor`, `recolorDesk(color: number)`, MRU (`touchMru`) só para fechar | mesma fila; paleta de 12 matizes por **nome** (`DeskHue`), `nextDeskColor` espalha nos 12; **novo módulo puro `desk-switch-rules.ts`**: `fitDesks(order, active, visible, widths, avail)` (quem cabe), `pickFromOverflow(visible, picked, active, lastUsed)` (MRU: entra no lugar da usada há mais tempo), `touchUsed` | **mantido + estendido** |
| `app/renderer/layout.ts` (263 l.) | `DeskLayout.color: number`; migração v1→v2; poda | `color` passa a aceitar número (paleta antiga, mapeado) **ou** nome de matiz; grava sempre nome. Nenhuma outra mudança: `frames/views/drawer` intactos | **mantido + leitura tolerante** |
| `app/renderer/desk.ts` (362 l.) | `Desk` = gridview de `Frame`s (cada um `createDockview` com `theme` do dockview); `.desk` padding 4px; `.frame-dock` inset 0; "+" nas bordas com `FRAME_EDGE_PX 14` / `DESK_EDGE_PX 6` | mesma estrutura; o cartão é o `.frame-dock` com inset `calc(var(--gap)/2)` e o `.desk` com padding `calc(var(--gap)/2)`; tema dockview único `tether` (as cores vêm dos tokens, não da classe `dv-theme-dark/light`); os "+" seguem as bordas do cartão (constantes retunadas) | **mantido** (CSS + constantes + tema) |
| `app/renderer/desk-set.ts` (239 l.) | camadas por mesa, `visibility:hidden` + `inert`, `setTheme` | igual; `setTheme` continua existindo mas o tema é um só (a chamada vira no-op ou some) | **mantido** |
| `app/renderer/drawer.ts` (77 l.) + `drawer-rules.ts` (92 l.) | `Drawer` = `Desk` dentro de `#drawer` (backdrop + painel a 8px); regras puras (Esc, foco de volta, pasta do shell, contagem) | mesmo `Drawer`; a casca muda (cartão a 16px, sem backdrop, barra própria, estado vazio); regras puras **intocadas** | **mantido** (casca reescrita no HTML/CSS; `drawer.ts` ganha `setEmpty(boolean)`) |
| `app/renderer/panel.ts` (719 l.) | `TerminalPanel`: `.panel-details` (grid-row 0fr/1fr, param `details`) com `.panel-head` (ícone, título, pílula do perfil, `unsafe`, cwd, `status` com ponto + texto), overlays de situação, loading, xterm; `SlotTab`: ícone, `attn`, texto, `unsafe`, `dot` de status, `details-toggle`, ×, clique direito | `TerminalPanel`: a mesma dobra (`pane-details.ts` inalterado) com a **barra de status** reestruturada (`.status-bar`: selos por regra + ações fixadas só ícone à direita); `SlotTab`: ícone, texto, `attn`, `unsafe` (só escudo), × (visível na ativa/hover), **sem `details-toggle`** (vai para a faixa) e com o ponto de estado só para estados não-"running" (ver decisões) | **reescrito em parte** (cabeçalho e aba); xterm, overlays, loading, clipboard, OSC 52, fit: intocados |
| `app/renderer/pane-details.ts` (25 l.) | `detailsOpen/withDetails/detailsLabel` | iguais; rótulos viram "Mostrar/Ocultar barra de status" | **mantido** |
| `app/renderer/main.ts` (1528 l.) | `setupDock` cria `DeskStrip` + `DeskSet` + `Drawer`; `renderStrip`, `renderDrawerButton`, `setDrawerOpen` (menus fecham, `BEHIND_DRAWER` inert, `quickShell`), `showDeskMenu/showMoveMenu/showTabMenu/showContextMenu`, `setupMenu` (≡), `setupUi` (botões, `theme-select`, `closed-list`, atalhos), `onConnection` (texto do `#conn`), `refreshClosedMenu`, `applyTheme` (dockview + select + rádios), ganchos `__tether` | mesmas funções com outros alvos: `setupDock` cria `DeskSwitch`; `renderStrip` → `renderSwitch` (passa também a atenção da gaveta e o estado aberta); `renderDrawerButton` some (a pílula é da cápsula); `onConnection` alimenta o popover; `applyTheme` marca o menu de tema; `setupMenu` ganha "Linha da cor da mesa" (toggle persistido); `deskHost().dockviewOptions` ganha `createRightHeaderActionComponent` (faixa: "+N", toggle da barra, ⋯) e o watermark perde o nome; `showTabMenu` vira a fonte única do menu ⋯ (mesmos itens no clique direito); ganchos `__tether` ganham `switchState()`, `deskLine()`, `chrome()` | **mantido, editado por fatia** |
| `app/renderer/shortcuts.ts` (153 l.) | registro único; `pane-details` = Ctrl+Shift+H | igual; a dica de `pane-details` segue "barra de status"; nenhum chord novo | **mantido** |
| `app/renderer/icons.ts` (149 l.) | Phosphor embutido, `icon(name)` | + ícones que faltarem: `rows` (barra de status), `dots-three`, `bell`, `arrows-left-right`, `folder-open`; `lightning`, `plugs`, `plugs-connected`, `circle-half` já existem | **mantido + entradas** |
| `app/renderer/create.ts`, `dialog.ts`, `situations.ts`, `profiles.ts`, `terminal-theme.ts`, `clipboard.ts`, `loading.ts`, `args.ts`, `tray-situations.ts` | — | **intocados** | — |
| `app/shared/theme.ts` | `WINDOW_BACKGROUND` por esquema (`#1b1b1f`/`#fbfbfd`) | o fundo da janela passa a ser o **`--desk-bg`** de cada esquema (`#141418`/`#e7e9ed`): é o que aparece antes do renderer pintar | **editado (2 valores)** |
| **novo** `app/shared/palette.ts` | — | os 12 matizes em OKLCH (`H` da prévia), a regra do `-foreground` (L<0,55 → claro; senão escuro; `-deep` quando falha 4,5:1) e do `-text` (anda em L até 4,5:1 contra `--desk-bg`), os conversores `lin/Y/cr` da prévia e um `paletteCss(scheme)` que devolve o bloco `:root[data-theme=…]{--x-…}`; puro, unit-testado (contraste ≥ 4,5:1 em todos os pares, nos dois esquemas) | **novo** |
| `app/build.mjs` | extrai o CSS do dockview para `app/dist/dockview.css` | também grava `app/dist/palette.css` a partir de `palette.ts` (o `index.html` o referencia; sem CSS gerado em runtime) | **editado** |
| `app/main/main.ts` | `settings.json` (`theme`, `terminal`, `confirmations`, `trayNoticeShown`); IPC `theme:*`, `terminal:*`, `confirmations:*`; menu nativo oculto | + `ui` (`{ deskLine: boolean }`) normalizado em `app/shared/ui-settings.ts`; IPC `ui:get`/`ui:set` + evento `tether:ui`; IPC `shell:open-path` (fatia 5); `WINDOW_BACKGROUND` novo; nada mais | **editado (pequeno)** |
| `app/shared/api.ts`, `app/preload` | — | `getUi/setUi/onUi`, `openPath` | **editado (4 linhas)** |
| dockview-core 8.8 (uso) | `themeDark/themeLight` trocados por esquema; tab custom (`SlotTab`), watermark custom, sem header actions; overflow nativo de abas ativo (`.dv-tabs-overflow-dropdown-default`) | tema próprio `{ name: 'tether', className: 'dv-theme-tether', colorScheme }` (variáveis `--dv-group-view-background-color`, `--dv-tabs-and-actions-container-background-color/height`, `--dv-activegroup-visiblepanel-tab-*`, `--dv-inactivegroup-*`, `--dv-separator-border`, `--dv-tab-divider-color`, `--dv-sash-color`, `--dv-border-radius`, `--dv-icon-hover-background-color` lidas dos tokens); `createRightHeaderActionComponent` por grupo (faixa fixa à direita); overflow de abas: nativo do dockview **restilizado** como "+N" ou próprio (ver riscos da fatia 4) | — |

## 2. Fatias, em ordem

Cada fatia fecha sozinha, é testável e dá ao Guga algo visível para usar. Nenhuma toca `src/`. Todas: `npm run check` verde, `npm run app:build`, E2E citados um por vez com `TETHER_E2E_HIDDEN=1`, capturas em `test/e2e/artifacts/`. A comparação com a prévia é feita com `test/e2e/preview-shot.ts` (novo na fatia 1): abre `docs/tether-preview.html` numa `BrowserWindow` nua do Electron no mesmo tamanho (1280×800) nos dois temas e grava `preview-{light,dark}.png`; a revisão lado a lado é minha (coordenação), com os desvios anotados no PROGRESS.

### Fatia 1 — Tokens, superfícies e cartões

- **Escopo:** tokens novos (`--desk-bg`, `--frame-bg`, `--frame-border`, `--frame-radius`, `--gap`, `--pane-divider`, `--drawer-inset`, `--x-alert`, `--x-alert-foreground`) nos dois esquemas; fundo da janela = `--desk-bg` (e `WINDOW_BACKGROUND`); a barra de hoje passa a `--desk-bg` sem borda (só a cor; a estrutura fica para a fatia 2); `.desk` e `.frame-dock` com o respiro de `--gap` e o quadro como cartão (fundo, borda 1px, raio, `overflow:hidden`); painéis separados por `--pane-divider`; **tema dockview próprio** `dv-theme-tether` com as `--dv-*` lidas dos tokens (um só tema; `applyTheme` deixa de trocar a classe); `.desk-grid .dv-view { outline }` sai; os "+" das bordas seguem o cartão. Prévia: `.desk`, `.frame`, `.pane+.pane`, `--gap`, `--frame-*`.
- **Arquivos:** `styles.css`, `desk.ts` (constantes, tema), `desk-set.ts`/`drawer.ts` (`setTheme` → no-op ou removido), `main.ts` (`DOCK_THEME`), `app/shared/theme.ts`, `test/e2e/preview-shot.ts` + `test/e2e/preview-main.cjs` (novos).
- **Riscos:** internals do dockview 8 — a lista de variáveis `--dv-*` está em `app/dist/dockview.css` (as que importam: group view, tabs container, tabs ativa/inativa, separator, sash, border-radius); o `gap` do `DockviewTheme` é entre **grupos** do mesmo dockview, não entre quadros (o respiro dos quadros é nosso, no `.frame-dock`); o sash do gridview fica na calha entre cartões (tem de continuar arrastável: conferir `.dv-sash` largura ≥ `--gap`); os "+" (`FRAME_EDGE_PX`/`DESK_EDGE_PX`) medem contra o `.frame`/`.desk` — recalibrar contra o cartão; `visibility:hidden` das mesas inativas e da gaveta não muda.
- **Testes:** `app.frames`, `app.layout`, `app.theme`, `app.drawer` (regressão: nada de comportamento muda); **novo `app.chrome`** nasce aqui com: tokens resolvidos (`getComputedStyle` de `--desk-bg`/`--frame-bg` por esquema), cartão com raio e borda, divisor entre painéis, "+" ainda aparece na borda do cartão; capturas `chrome-cards-{light,dark}.png`.
- **Aceite:** o layout do Guga abre igual (mesmos painéis, mesmos PIDs) sobre cartões; claro/escuro trocam ao vivo; `grep -nE "#[0-9a-f]{3,8}" app/renderer/styles.css` só acha definições de tokens em `:root`/`[data-theme]`; captura lado a lado com `preview-*.png`: mesma hierarquia (fundo, cartão, divisor, raio, respiro).
- **Executor:** Fable, high (o tema do dockview e os "+" exigem ler o CSS gerado).

### Fatia 2 — Barra do topo e cápsula de mesas (a faixa sai)

- **Escopo:** `#toolbar` em grid `1fr auto 1fr` (centro verdadeiro: as laterais são trilhas iguais e o meio é `auto`); esquerda só ícone (`#btn-new`, `#btn-duplicate`, `#btn-profiles`, `#btn-closed` com o `#closed-list` de hoje) com `title` e `aria-label`; **`#brand` sai**; direita: `#conn` vira botão-ícone com popover `#conn-pop` (serviço, canal, pid/versão do `hello`, "N rodando · M aguardando" dos slots), `#btn-theme` com menu de ícone `#theme-menu` (rádios Claro/Automático/Escuro, mesma marca do ≡), `#btn-menu` + `#app-menu` como hoje; `#desk-strip` **removido** e substituído por **`#desk-switch`** (`desk-switch.ts`): pílula fixa "⚡ Gaveta" (mantém `id="btn-drawer"` e `#drawer-badge` para os testes), divisor, segmentos das mesas (inativa = `--x-{cor}-text`; ativa = `--x-{cor}` + `-foreground`; selo `.cnt` com anel `--desk-bg`), **"+N" único e fixo à direita** com menu MRU; cabe/não cabe por medição (`ResizeObserver` na barra: `avail = largura − 2·max(esq, dir) − margens`, como a prévia), a ativa nunca sai, o "+N" nunca muda de lugar; duplo clique renomeia, clique direito = menu da mesa (o de hoje, menos "arrastar"); **linha da cor da mesa** (`.desk::before`, 2px, `--desk-color` da ativa) ligada por padrão com toggle "Linha da cor da mesa" no ≡, persistido em `settings.json` → `ui.deskLine` (IPC `ui:get/set`). Até a fatia 3 a cápsula usa as **8 cores de hoje** mapeadas provisoriamente para `--x-*` (tabela fixa em `desks.ts`).
- **Arquivos:** `index.html`, `styles.css`, **`desk-switch.ts`** (novo), **`desk-switch-rules.ts`** (novo, puro), `desk-strip.ts` (apagado), `main.ts` (`setupDock`, `renderSwitch`, `onConnection`, `applyTheme`, `setupMenu`, `setupUi`, ganchos), `app/main/main.ts` + `app/shared/ui-settings.ts` (novo) + `api.ts`/preload (`ui`).
- **Riscos:** **centro verdadeiro com laterais variáveis**: `1fr auto 1fr` só centra enquanto cada lateral cabe na sua trilha; a medição do "cabe" tem de usar `max(esq, dir)` dos dois lados (não a soma), senão a cápsula descentra antes de encolher; `ResizeObserver` + repintura podem oscilar (medir num frame, pintar no seguinte; nunca medir dentro do callback de pintura); nomes longos (`MAX_DESK_NAME` 40) → `max-width` + ellipsis no segmento; rename in-place dentro de um segmento colorido precisa de contraste no input; o popover de conexão e o menu de tema são os mesmos padrões do `#app-menu` (fecham com clique fora/Esc); o `#closed-list` continua ancorado ao botão; a gaveta aberta já deixa a barra `inert` (`BEHIND_DRAWER` troca `desk-strip` por `desk-switch`); `focusActivePane` consulta `#desk-strip, #desk-colors` → atualizar.
- **Testes a atualizar:** `app.desks` (`#desk-strip .desk-chip` → `#desk-switch .seg[data-desk]`; arrastar para reordenar sai do teste, "Mover para a direita" pelo menu entra), `app.theme` (`#theme-select` → `#btn-theme` + `#theme-menu li[data-theme]`), `app.attention` (selo no segmento), `app.drawer` (mantém `#btn-drawer`/`#drawer-badge`; a nota "compartilhada…" sai), `app.layout`/`app.restore`/`app.profiles`/`app.switch-profile`/`app.pane-details` só onde leem `#desk-strip` ou a barra. **Unit novo** `app.desk-switch` (regras puras: cabe/não cabe, ativa nunca sai, "+N" conta certo, MRU troca a usada há mais tempo e as outras não se mexem, `touchUsed`). **`app.chrome`** ganha: sem texto "tether" na barra; botões da esquerda sem texto e com `aria-label`; centro da cápsula = centro da janela ±1px em duas larguras (1280 e 900) com laterais assimétricas; 10 mesas a 900px → "+N" presente, ativa visível, escolher no "+N" troca a usada há mais tempo; linha da cor segue a mesa ativa, o toggle apaga e persiste após relançar; popover de conexão mostra o pipe; menu de tema troca o esquema; capturas `chrome-bar-{light,dark}.png`.
- **Aceite:** o Guga troca de mesa pela cápsula e por Ctrl+Tab, vê o selo com anel, cria 10 mesas e o "+N" aparece sem a ativa sumir; a cápsula fica no centro com 4 ícones à esquerda e 3 à direita; a linha da cor liga/desliga pelo ≡ e lembra; captura lado a lado com a prévia (`.tb`, `.sw`, `.seg`, `.cnt`).
- **Executor:** Fable, high.

### Fatia 3 — Paleta `--x-*` (12 matizes) e migração das cores das mesas

- **Escopo:** `app/shared/palette.ts` (puro): os 12 matizes OKLCH da prévia, regra do `-foreground` (`-deep` quando o par falha 4,5:1), regra do `-text` (contra `--desk-bg` de cada esquema), `paletteCss(scheme)`; `app/build.mjs` grava `app/dist/palette.css` (referenciado no `index.html`); `desks.ts`: `DESK_HUES` (12, por nome, rótulos em português: Vermelho, Laranja, Amarelo, Lima, Verde, Verde-água, Ciano, Céu, Azul, Roxo, Magenta, Rosa), `colorOf(hue)`, `nextDeskColor` espalha nos 12; `layout.ts`: `color` lê número (paleta antiga: 0 Azul→`blue`, 1 Verde→`green`, 2 Âmbar→`orange`, 3 Vermelho→`red`, 4 Roxo→`purple`, 5 Ciano→`cyan`, 6 Rosa→`pink`, 7 Cinza→`sky`) ou nome; grava sempre nome; paleta do menu "Cor…" com os 12 (`pickColor`); a tabela provisória da fatia 2 some; o selo de atenção usa `--x-alert` (laranja) com anel, e a mesa laranja continua distinguível (a prévia prova).
- **Arquivos:** `app/shared/palette.ts` (novo), `app/build.mjs`, `index.html` (link do `palette.css`), `desks.ts`, `layout.ts`, `desk-switch.ts` (paleta), `main.ts` (ganchos `recolorDesk(id, hue)`), `styles.css` (`--x-alert`).
- **Riscos:** OKLCH no Chromium do Electron 45: suportado; `color-mix` já é usado; o `-text` calculado contra `--desk-bg` fixo deixa de valer se alguém trocar o token (o teste unitário amarra os dois: `palette.ts` e o CSS leem a mesma constante); migração: um `layout.json` v2 com `color: 3` tem de virar `red`, não `lime` (número = paleta antiga, sempre); backup não é preciso (o campo é o único que muda e a leitura continua aceitando número).
- **Testes:** unit `app.palette` (novo: 24 pares ≥ 4,5:1, `-deep` em `blue` e `purple` como na prévia, `-text` ≥ 4,5:1 contra o fundo nos dois esquemas, CSS gerado bem formado), `app.desks` unit (12 cores sem repetir, `colorOf` por nome, nomes inválidos → padrão), `app.layout` unit (número → nome pela tabela antiga; nome fica; lixo → `blue`), `app.desks` E2E (`#desk-colors .swatch[data-color="cyan"]`; `__tether.desks()` devolve `color: string`), `app.chrome` (segmento ativo com `background` = `--x-{cor}`; inativo com `color` = `--x-{cor}-text`); capturas `chrome-palette-{light,dark}.png` com 12 mesas.
- **Aceite:** as mesas do Guga abrem com as cores equivalentes; "Cor…" oferece 12; ativa/inativa legíveis nos dois temas (os números da prévia §1 batem com o teste).
- **Executor:** Fable, medium (puro e bem especificado pela prévia). Pode correr em paralelo com a fatia 4 (territórios disjuntos).

### Fatia 4 — Faixa de abas do painel e o menu ⋯

- **Escopo:** `createRightHeaderActionComponent` por grupo (dockview): à direita da faixa, fixos, **"+N"** (abas que não cabem, com ponto se alguma tem atenção; menu lista as escondidas; escolher uma segue uso recente: a escolhida entra no lugar da visível usada há mais tempo — `panel.api.moveTo({ group, index })` — e vira ativa), **toggle da barra de status** (`rows`, pressionado quando a barra do painel ativo está aberta) e **⋯** (menu do painel ativo do grupo = o mesmo `showTabMenu` do clique direito, fonte única). Abas (`SlotTab`): ícone do agente, título, ponto de atenção (`--x-alert`), escudo `unsafe`, × só na ativa/hover; o `details-toggle` sai da aba; `min-width`/`max-width` e `flex` como a prévia (`.tab`, `.tab.on{flex-shrink:0}`); altura 32px (`--dv-tabs-and-actions-container-height`). Watermark sem o nome "tether".
- **Arquivos:** `panel.ts` (`SlotTab`), `main.ts` (`deskHost().dockviewOptions`), **`tab-strip.ts`** (novo: renderer de ações do grupo) + **`tab-strip-rules.ts`** (novo, puro: cabe/não cabe, MRU), `styles.css`, `icons.ts`, `shortcuts.ts` (rótulo).
- **Riscos:** **medição do overflow de abas**: o dockview 8 já tem um `OverflowObserver` e um dropdown nativo (`.dv-tabs-overflow-dropdown-default`, lista `.dv-tabs-overflow-container`), com predicado para abas que nunca saem; caminho A (padrão): **restilizar o nativo** como "+N" e tratar a escolha com `moveTo` para o MRU; caminho B: `disableTabsOverflowList: true` e medir nós mesmos (`ResizeObserver` no `.dv-tabs-container`), escondendo abas com `display:none` — perde o scroll nativo e mexe em DOM do dockview. Decidir num spike de 30 min dentro da fatia; o critério é "a ativa nunca fica escondida e o '+N' não muda de lugar". `moveTo` reordena a aba **no layout** (persistido): aceitável (é o que a prévia faz) — registrar. As ações da direita são **por grupo**: o toggle e o ⋯ agem no `group.activePanel`; com o grupo vazio nada aparece (o grupo some). O `IHeaderActionsRenderer` recebe `group` e precisa ouvir `onDidActivePanelChange` do grupo e `onDidParametersChange` do painel ativo para o estado pressionado do toggle. Status na aba: o ponto de estado some para "running" e fica para `starting/queued/exited/unconfirmed/error` (ver decisões).
- **Testes a atualizar:** `app.pane-details` (`.details-toggle` → `.dv-right-actions-container [data-action="status-bar"]`; menu da aba com o rótulo novo), `app.duplicate` (itens do menu da aba: mesma lista + "Mostrar barra de status"), `app.attention` (ponto na aba = `.attn`), `app.switch-profile`/`app.profiles` (escudo na aba mantido). **Unit novo** `app.tab-strip` (regras: cabe/não cabe, ativa nunca sai, MRU). **`app.chrome`** ganha: 9 abas num painel estreito → "+N" presente e ativa visível; escolher no "+N" traz a aba e tira a usada há mais tempo; ⋯ abre o mesmo menu do clique direito; toggle abre/fecha a barra do painel ativo e segue Ctrl+Shift+H; capturas `chrome-tabs-{light,dark}.png`.
- **Aceite:** com 9 abas no quadro grande da prévia o Guga vê "+6" fixo à direita, troca pela lista, e o ⋯ tem tudo o que o clique direito tem; captura lado a lado com `.tabs/.tl/.tr/.tmore`.
- **Executor:** Fable, high (internals do dockview: header actions e overflow).

### Fatia 5 — Barra de status (cabeçalho recolhível reestruturado)

- **Escopo:** `.panel-head` vira `.status-bar` dentro da mesma dobra (`.panel-details`, param `details`, recolhida por padrão, por painel — `pane-details.ts` intacto): **só ícone para estados** (ponto `running/starting/queued/exited/unconfirmed/error` com `title`; sino `--x-alert` quando `attention`; "reiniciando…"/"encerrando…" como ponto âmbar com `title`), **só texto para informação** (nome do perfil ou "sem perfil" em itálico, pasta em mono com ellipsis; o título do painel já está na aba e sai daqui), **ícone+texto só para "sem restrições"**; **ações fixadas só ícone à direita**: "Trocar perfil…" (a pílula-botão de hoje vira ícone; mesmo `onSwitchProfile`), "Abrir pasta no Explorer" (`shell.openPath` via IPC novo `shell:open-path`), "Copiar pasta" (`writeClipboard`). Overlays de situação, loading e o xterm não mudam. Altura 26px.
- **Arquivos:** `panel.ts` (`TerminalPanel` cabeçalho), `styles.css`, `icons.ts`, `main.ts` (menu ⋯/clique direito ganham "Copiar pasta" e "Abrir pasta no Explorer"), `app/main/main.ts` + `api.ts`/preload (`openPath`).
- **Riscos:** o `fit` do xterm depende do `transitionend` da dobra (já tratado em `setDetails`); o `app.pane-details` mede linhas antes/depois — a altura muda (26px) e o teste tem de medir, não assumir; `unsafe` "honesto" (`runUnsafe`) continua vindo do `SlotState`; o botão da pílula tinha `aria-label` com o nome do perfil — manter no ícone (`title` + `aria-label` com "Perfil: X · Trocar perfil…").
- **Testes a atualizar:** `app.pane-details` (seletores `.status-bar`, medição), `app.profiles` e `app.switch-profile` (`.panel-head .profile` → `.status-bar [data-action="switch-profile"]`; o texto do perfil em `.status-bar .info-profile`), `app.attention` (sino). **`app.chrome`** ganha: barra recolhida por padrão; aberta mostra ponto, perfil, pasta, "sem restrições" só em perfil inseguro; os três ícones à direita com `title`; "Copiar pasta" põe a pasta na área de transferência; capturas `chrome-status-{light,dark}.png`.
- **Aceite:** o Guga abre a barra com o toggle da faixa e lê: estado, perfil, pasta, "sem restrições" quando for o caso; troca o perfil pelo ícone; captura lado a lado com `.stb/.bd`.
- **Executor:** Sonnet, high (ou Fable, medium): escopo fechado, sem internals.

### Fatia 6 — Gaveta reestruturada

- **Escopo:** `#drawer` vira **cartão elevado** a `--drawer-inset` (16px) das bordas, sobre a barra, **sem backdrop** (a camada externa fica transparente; clicar na margem de 16px fecha, como o backdrop fazia); enquanto aberta, os cartões de trás esmaecem (`body.drawer-open .desk-set .frame-dock { opacity:.45; filter:blur(1.5px) }`, com `prefers-reduced-motion` sem blur); barra fina própria `.drawer-bar` no mesmo grid da barra do topo: esquerda ícones "Novo painel na gaveta" (`#drawer-new`) e "Duplicar painel" (`#drawer-duplicate`), centro a pílula "⚡ Gaveta" **pressionada** (`#drawer-pill`, clicar fecha), direita o X (`#drawer-close`); dentro, o `Desk` de sempre (cartões, faixas, barra de status, "+"); **estado vazio** `.drawer-empty` ("A gaveta está vazia" + "Novo painel… Ctrl+Shift+T" + "Terminal rápido Ctrl+`") mostrado quando a gaveta aberta fica sem painéis (ver decisões sobre o shell automático); sombra elevada por esquema; animação de entrada 160ms (`dIn` da prévia), reduzida quando pedido.
- **Arquivos:** `index.html`, `styles.css`, `drawer.ts` (`setEmpty`, hooks dos botões da barra), `main.ts` (`setDrawerOpen`: classe `drawer-open` no body, foco inicial na pílula quando vazia, `quickShell` conforme a decisão), `drawer-rules.ts` **intocado**.
- **Riscos:** o `visibility:hidden` + `inert` fechada continua (os xterms da gaveta não podem mudar de tamanho: o inset passa de 8 para 16px → os painéis da gaveta redimensionam **uma vez** no primeiro build novo, aceitável); sem backdrop, o clique "fora" é a margem de 16px — pequena; o `escAction` (regra do Esc) não muda; `BEHIND_DRAWER` = `toolbar`, `desk-switch`, `dock`; o blur nos cartões de trás custa GPU com muitos xterms (WebGL) — medir; se pesar, só `opacity`.
- **Testes a atualizar:** `app.drawer` (nota "compartilhada…" sai; `#drawer-close` fica; "clique no fundo fecha" → clique na margem de 16px; `.drawer-panel` → `.drawer-card`). **`app.chrome`** ganha: gaveta cobre a barra (rect do cartão = janela − 16px em cada lado); pílula pressionada fecha; X fecha; cartões de trás com `opacity` < 1 enquanto aberta e 1 depois; estado vazio aparece ao fechar o último painel com a gaveta aberta; capturas `chrome-drawer-{light,dark}.png` e `chrome-drawer-empty-dark.png`.
- **Aceite:** o Guga abre com Ctrl+`, vê o cartão por cima de tudo com a barra própria, fecha pela pílula, pelo X, por Esc (regra de hoje) e pela margem; o shell da gaveta segue vivo; captura lado a lado com `.dcard/.dbar/.ddesk/.empty`.
- **Executor:** Sonnet, high (como a fase D).

### Fatia 7 — Polimento e acessibilidade

- **Escopo:** foco visível em todo botão-ícone (`:focus-visible` com `--accent`); `aria-label` em todo controle só ícone e `aria-pressed` nos toggles (pílula da gaveta, toggle da barra de status, "+N" com `aria-expanded`); `role="tablist"/"tab"/"aria-selected"` na cápsula; navegação por teclado nos menus novos (popover de conexão, menu de tema, "+N" das mesas e das abas) igual ao `#app-menu` (setas, Enter, Esc); animação FLIP da cápsula ao trocar quem está visível (a da prévia, 320ms, desligada em `prefers-reduced-motion`); hover/active dos segmentos; tooltips revisados em português; `README.md` (barra, cápsula, "+N", barra de status, gaveta) e `MANIFEST.md` §4 (arquivos novos); varredura de valores fixos no CSS (`grep` de hex/px fora de tokens) e de `console.error` novos.
- **Arquivos:** `styles.css`, `desk-switch.ts`, `tab-strip.ts`, `main.ts`, `README.md`, `MANIFEST.md`.
- **Riscos:** FLIP com `ResizeObserver` pode disparar durante a animação (medir só em `finish`); nenhum risco funcional.
- **Testes:** `app.chrome` ganha a passada de acessibilidade (todo `button` sem texto tem `aria-label`; Tab percorre barra → cápsula → ações sem cair em `inert`; Esc fecha cada menu novo); rodada completa do app um arquivo por vez (`app.chrome`, `app.desks`, `app.drawer`, `app.frames`, `app.layout`, `app.restore`, `app.pane-details`, `app.profiles`, `app.switch-profile`, `app.theme`, `app.attention`, `app.duplicate`, `app.dialogs`, `app.tray`, `app.terminal-theme`, `app.clipboard`, `app.instance`, `app.tree`, e `app.claude` por último).
- **Aceite:** capturas finais `chrome-{light,dark}.png` lado a lado com `preview-{light,dark}.png` e os desvios listados (aceitos ou corrigidos) no PROGRESS; suíte do app verde; o Guga usa um dia inteiro.
- **Executor:** Fable, medium.

## 3. Ordem, paralelismo e portões

```
F1 tokens/cartões ──► F2 barra + cápsula ──► F3 paleta/migração ──► F4 faixa de abas + ⋯ ──► F5 barra de status ──► F6 gaveta ──► F7 polimento
                                              (F3 ║ F4 podem correr em paralelo: palette/desks/layout vs panel/tab-strip)
```

- Máximo 2 agentes em paralelo; território declarado por fatia (acima). F2 depende de F1 (tokens e grid da barra); F4 e F5 dependem de F1 (tema dockview); F6 depende de F2 (a pílula) e de F5 (a barra de status dentro da gaveta já vem pronta).
- Portão de cada fatia: `npx tsc -p .` e `npx tsc -p app/renderer` limpos; `npm test`; E2E citados um por vez com janela escondida; `npm run app:build`; capturas revisadas por mim contra a prévia; PROGRESS atualizado (prova e decisões); commit temático por fatia, arquivos pelo nome.
- O `tetherd` do Guga **não precisa reiniciar** em nenhuma fatia (nada em `src/`); o app precisa de `npm run app:build` e reabrir.
- Orçamento por fatia: ~30 min de agente (regra de parada em 2×); F2 e F4 podem precisar de duas rodadas (a segunda só para o spike de medição).

## 4. Decisões para validar (defaults adotados; copiadas para o PROGRESS.md)

1. **Cor da mesa no `layout.json`:** vira **nome do matiz** (`"blue"`); número continua lido como a paleta antiga de 8 (tabela fixa: Cinza → `sky`, o único sem equivalente). Alternativa: manter número e índice de 12 (impossível distinguir arquivos antigos sem marcador).
2. **Paleta gerada no build**, não em runtime: `palette.ts` → `app/dist/palette.css`; o teste unitário garante os 4,5:1. Alternativa: injetar `<style>` no renderer como a prévia (mais simples, mas CSS fora do arquivo).
3. **Visibilidade da cápsula não é persistida:** ao abrir, as visíveis são as primeiras da fila que cabem, com a ativa garantida; o MRU é da sessão. Alternativa: guardar `lastUsed` por mesa no layout.
4. **Overflow de abas pelo nativo do dockview restilizado** (caminho A); a escolha no "+N" **reordena a aba no layout** (`moveTo` para o lugar da usada há mais tempo). Alternativa: só ativar, sem mover (a ativa some do espaço visível em alguns casos).
5. **Ponto de estado na aba só para estados não-"running"** (starting/queued/exited/unconfirmed/error); rodando, a aba fica limpa como na prévia. A barra de status (recolhida por padrão) é onde o estado vive; sem o ponto para "exited", um painel morto passaria despercebido.
6. **"Reiniciar sessão" não entra nesta fase** (a prévia o mostra no ⋯ e na barra): hoje não há request de reinício puro (só `set-profile … restart`, com a guarda dos 12 s); fica registrado como melhoria. "Renomear…" também não (há `rename-slot` no protocolo, mas o título vem do agente) — pendência para decidir depois.
7. **Gaveta vazia ao abrir continua abrindo um shell** (decisão da fase D: Ctrl+` e já digitando); o **estado vazio com convite** aparece quando o último painel da gaveta é fechado com ela aberta ou quando o shell automático não pode abrir (sem perfil de shell/pasta ou daemon recusou). Alternativa: sempre o convite (um clique a mais no gesto mais frequente).
8. **Sem toggle "Borda dos quadros"** (a prévia tem; só a linha foi aprovada); `--frame-border` fica como token (um toggle depois é trivial).
9. **Fechar a gaveta pela margem de 16px** substitui o clique no backdrop (não há mais backdrop). Alternativa: só pílula, X, Esc e Ctrl+`.
10. **Popover de conexão ao passar o mouse e ao clicar** (hover na prévia; clique para teclado), com serviço, canal, pid e versão (do `hello`), e "N rodando · M aguardando" contados dos slots. O `#overlay` "Sem conexão" continua igual.
11. **Watermark sem o nome "tether"** ("Nenhum painel" + dica), coerente com a barra sem nome.
12. **Arrastar chip para reordenar mesas sai** com a faixa; reordenar fica no menu da mesa ("Mover para a esquerda/direita"), que já existe. Alternativa: arrastar segmentos na cápsula (conflita com a medição/MRU; voltar se o Guga sentir falta).
13. **Fundo da janela (`WINDOW_BACKGROUND`) passa a `--desk-bg`**: a primeira pintura do Electron já é a cor da mesa.
14. **Esmaecer os cartões de trás com `opacity` + `blur(1.5px)`**; se o blur pesar com muitos xterms WebGL, só `opacity` (medir na F6).
