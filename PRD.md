# PRD — tether

**Versão:** 0.2 · **Data:** 2026-10-29 · **Fases:** 1 (gestão de sessões) e 2 (o app), as duas implementadas

> **O que mudou na implementação em relação a este texto:** a CLI virou cliente do `tetherd` (§6.5); "rodando" vem do PTY que o tetherd segura, não de PID + horário (§6.4); a meta de <100 ms do hook (RNF3) é inalcançável nesta máquina (Node vazio ≈ 0,1 s) e o hook ficou em ~0,15 s; o soul não reporta `/compact` (C7 não se aplica a ele); `-H` (soul remoto) não foi testado. Registro completo em [PROGRESS.md](./PROGRESS.md).

## 1. Contexto e problema

O trabalho do dia a dia acontece em vários terminais abertos ao mesmo tempo (Windows Terminal ou VSCodium). Cada terminal roda um agente: **Claude Code** (`claude`) ou **soul-cli** (`soul`), geralmente em pastas diferentes.

Quando o terminal ou o VSCodium reinicia (ou trava), todos os painéis voltam como shells vazios. A sessão de cada agente continua salva em disco, mas:

- ninguém sabe mais **qual sessão estava em qual painel**;
- muitas vezes a pessoa nem lembra **qual era a sessão**;
- retomar exige procurar manualmente em `/resume`, um painel por vez.

Esse é o problema crítico. A IDE (painéis divididos com o mouse, robustez contra travamentos) é a fase 2 e será construída **em cima** da solução desta fase.

## 2. Objetivo da fase 1

> Implementar e **provar** uma gestão de sessões de Claude Code e soul-cli em que, para cada painel, sabemos **com certeza** qual sessão está ativa agora, e conseguimos retomá-la depois de qualquer reinício.

"Com certeza" significa: o ID vem do próprio agente, no momento em que a sessão muda. Não é deduzido por data, pasta ou "a mais recente".

### Fora do escopo (fase 2 ou depois)

- Interface gráfica, splits, layout de janelas.
- Manter processos vivos depois que a janela fecha (daemon de PTY / multiplexador).
- Outros agentes além de Claude Code e soul-cli (mas o desenho não deve impedir isso).

## 3. Conceitos

| Termo | Significado |
|---|---|
| **Slot** | Um lugar estável onde um agente roda. Na fase 2 vira um painel da IDE. Tem um `slotId` fixo que sobrevive a reinícios. |
| **Agente** | `claude` ou `soul`. |
| **Sessão** | Uma conversa do agente, identificada por um UUID (`sessionId`). |
| **Vínculo** | "O slot X está agora na sessão Y do agente Z, na pasta P". É o que o tether guarda. |
| **Evento de sessão** | Aviso emitido pelo agente sempre que a sessão ativa do slot muda ou é renomeada. |

## 4. Fatos levantados

### 4.1 Claude Code

- Sessões ficam em `~/.claude/projects/<pasta-codificada>/<sessionId>.jsonl`.
- `claude --session-id <uuid>` **cria** uma sessão com esse ID.
- `claude --resume <uuid>` retoma; `claude -c` continua a mais recente da pasta.
- O hook **`SessionStart`** recebe pela entrada padrão um JSON com `session_id`, `transcript_path`, `cwd` e `source` (`startup`, `resume`, `clear`, `compact`). Ele dispara em todas as trocas de sessão.
- O hook **`SessionEnd`** dispara ao encerrar.
- Hooks herdam as variáveis de ambiente do processo `claude`, então dá para saber de qual slot vieram.
- `--settings <arquivo|json>` injeta configurações (inclusive hooks) **sem alterar** o `settings.json` da pessoa.
- **Conclusão:** dá para fazer sem mudar o Claude Code.

**Resultados do spike E0 (Claude Code 2.1.312, Windows 11, 2026-10-28):**

| Ação | Eventos recebidos | ID |
|---|---|---|
| Sessão nova (`--session-id X`) | `SessionStart source=startup` | X (o ID que passamos) |
| `--resume X` | `SessionStart source=resume` | X |
| `-c` | `SessionStart source=resume` | ID escolhido pelo Claude |
| `--fork-session` | `SessionStart source=fork` | novo |
| `/compact` | `SessionStart source=compact` | **mesmo ID** |
| `/clear` | `SessionEnd reason=clear` (antigo) + `SessionStart source=clear` (novo) | novo |
| `/resume <id>` dentro da sessão | `SessionEnd reason=resume` (antigo) + `SessionStart source=resume` | o escolhido |
| `/rename` | nenhum hook | mesmo ID; transcript ganha `{"type":"custom-title","customTitle":"…"}` (vale a última) |
| `/exit` | `SessionEnd reason=prompt_input_exit` | — |
| Kill do processo | `SessionEnd reason=other` **às vezes**; às vezes nada | — |
| Dois slots na mesma pasta, ao mesmo tempo | cada um recebe só os seus eventos | distintos |
| Retomar sessão morta por kill | funciona, com o contexto preservado | mesmo ID |

**Descobertas que viram requisitos:**

1. **Limpar o ambiente.** Se o `claude` for lançado com variáveis `CLAUDE*` herdadas de outra sessão do Claude (por exemplo, o tether rodando dentro de um terminal do Claude Code), ele **não grava o transcript** e a sessão não pode ser retomada. O tether remove todas as variáveis `CLAUDE*` antes de lançar.
2. **`SessionEnd` não é confiável** em kill. O estado "encerrado" vem do PID do processo, não do evento.
3. **O PID do hook não é o do Claude** (o hook roda num shell filho). O PID do agente vem do tether, que é quem lança o processo.
4. O hook roda de verdade via Git Bash no Windows, com `node "<script>"`, e herda as variáveis do slot.

### 4.2 soul-cli (`D:\atrium\workspace\soul-cli`, v0.1.187)

- `soul -r <uuid>` / `--resume <uuid>` retoma por ID; `soul -r "<título exato>"` retoma por título; `soul -c` continua a última da pasta.
- `--session-id <id>` hoje é **igual a `--resume <id>`**: só abre uma sessão existente e não cria (`src/entrypoints/args-core.ts:729`).
- `-n <nome>` dá nome à sessão.
- `/rename` **não muda o ID**: chama `api.rename(live.id, name)` (`src/ui/App.tsx:5130`).
- `/new`, `/clear`, `/resume` (dentro da sessão), `/branch` e `--fork-session` **trocam** a sessão ativa.
- Registro local das conversas abertas por pasta: `<config>/profiles/<perfil>/sessions.jsonl` (`src/resume/registry.ts`), com `sessionId`, `agent`, `folder`, `ts` e `branch`. Esse registro diz o que foi aberto na pasta, mas **não diz em qual slot**.
- As sessões pertencem ao engine/servidor (em processo, ou remoto com `-H <url>`). Para retomar é preciso repetir o mesmo contexto: pasta, `-a`, `-H`, `-g`/`--config-dir`, `-P`.
- O engine do soul tem hooks no mesmo formato do Claude (`SessionStart` etc., `src/ui/hooks-list.ts`), mas eles só são lidos de `~/.soul/settings.json` e de `<agente>/.soul/settings*.json`. Não há `--settings` para injetá-los por processo, e com `-H` o engine (e os hooks) roda no servidor, longe do slot.
- **Conclusão:** precisa de uma mudança pequena no **cliente** soul-cli (seção 6.2). O cliente é o único lugar que conhece todas as trocas de sessão, inclusive no modo remoto.

## 5. Cenários que precisam funcionar

Cada cenário vira um teste automatizado (seção 8). "Vínculo correto" = o tether aponta para a sessão que está de fato ativa no slot.

| # | Cenário | Claude | soul | Esperado |
|---|---|---|---|---|
| C1 | Abrir sessão nova no slot | ✓ | ✓ | Vínculo criado com o ID real |
| C2 | Abrir com `--resume <id>` | ✓ | ✓ | Vínculo = esse ID |
| C3 | Abrir com `-c` | ✓ | ✓ | Vínculo = ID que o agente escolheu |
| C4 | `/resume` dentro da sessão, escolhendo outra | ✓ | ✓ | Vínculo troca para a nova |
| C5 | `/clear` | ✓ | ✓ | Vínculo troca para o novo ID |
| C6 | `/new` | — | ✓ | Vínculo troca para o novo ID |
| C7 | `/compact` | ✓ | ✓ | Vínculo continua correto (mesmo ID ou o novo, conforme o agente) |
| C8 | `/rename` | ✓ | ✓ | Mesmo ID; título atualizado no vínculo |
| C9 | `/branch` / `--fork-session` | ✓ | ✓ | Vínculo = ID da cópia |
| C10 | Saída normal (`/exit`, Ctrl+D) | ✓ | ✓ | Vínculo mantido e marcado "encerrado" (ainda retomável) |
| C11 | Processo morto (fechar janela, kill, travamento do host) | ✓ | ✓ | Vínculo mantido; retomável |
| C12 | Reinício da máquina | ✓ | ✓ | Todos os slots retomáveis |
| C13 | Dois slots na mesma pasta, ao mesmo tempo | ✓ | ✓ | Cada slot com sua própria sessão, sem trocar |
| C14 | Mesma sessão aberta em dois slots | ✓ | ✓ | Detectado e avisado (não corromper) |
| C15 | Sessão apagada ou inexistente ao retomar | ✓ | ✓ | Erro claro; oferecer nova sessão ou outra |
| C16 | Pasta do slot movida ou apagada | ✓ | ✓ | Erro claro; não abrir em pasta errada |
| C17 | soul remoto (`-H <url>`) e variações de config (`-g`, `--config-dir`, `-P`, `-a`) | — | ✓ | Retomar com o mesmo contexto |
| C18 | Agente que não reporta (versão antiga, hook removido) | ✓ | ✓ | Vínculo marcado "não confirmado"; nunca chutar em silêncio |

## 6. Solução

### 6.1 Visão geral

```
 slot (painel)                                   tether
 ┌────────────────────────────┐                  ┌──────────────────────────┐
 │ TETHER_SLOT_ID=abc         │  evento          │ estado por slot          │
 │ TETHER_EVENTS=<arquivo>    │ ───────────────► │  slots/abc.jsonl         │
 │                            │  (append JSONL)  │  (último evento = vínculo)│
 │ claude ...  ou  soul ...   │                  └──────────────────────────┘
 └────────────────────────────┘
```

1. O tether **lança** o agente no slot, definindo variáveis de ambiente que identificam o slot.
2. O agente **emite um evento** sempre que a sessão do slot muda (ou é renomeada).
3. O tether guarda os eventos por slot. O **último evento é o vínculo atual**.
4. Para **retomar**, o tether monta o comando certo a partir do vínculo e o executa no slot.

### 6.2 Como cada agente emite eventos

**Claude Code (sem mudanças no Claude):**

- O tether lança `claude --settings <json gerado>`, com hooks `SessionStart` e `SessionEnd` que rodam `tether report --agent claude`.
- `tether report` lê o JSON do hook pela entrada padrão, junta com `TETHER_SLOT_ID` e grava o evento.
- Sessão nova: o tether pode passar `--session-id <uuid>` gerado por ele. É uma confirmação extra, não a fonte principal.
- Título (`/rename`): o hook não dispara. O tether lê a última linha `custom-title` do transcript (`transcript_path`) quando precisar exibi-lo.
- Antes de lançar, o tether remove do ambiente todas as variáveis `CLAUDE*` (seção 4.1, descoberta 1).

**soul-cli (mudança pequena no soul):**

- Nova variável **`SOUL_SESSION_REPORT=<arquivo>`**. Quando definida, o soul **acrescenta uma linha JSON** nesse arquivo sempre que:
  - uma sessão fica ativa (abertura, `-r`, `-c`, `/resume`, `/new`, `/clear`, `/branch`, fork);
  - a sessão é renomeada (`/rename`, inclusive o nome guardado antes da primeira resposta);
  - a sessão ganha ID no servidor (sessão nova que ainda não tinha ID);
  - o processo encerra normalmente.
- Formato da linha (igual ao do tether, seção 6.3), com `source` em `startup | resume | continue | new | clear | branch | fork | rename | end`.
- Inclui o **contexto de retomada**: pasta, agente (`-a`), host (`-H`), config (`-g` / `--config-dir`), perfil (`-P`).
- **Opcional:** `--session-id <uuid>` passa a **criar** a sessão quando ela não existe, como no Claude. Melhora o C1, mas não é obrigatório.

### 6.3 Formato do evento

Uma linha JSON por evento, apenas acrescentada (append-only), no arquivo do slot:

```json
{
  "v": 1,
  "ts": "2026-10-28T14:03:11.402Z",
  "slotId": "abc",
  "agent": "claude",
  "source": "clear",
  "sessionId": "0b6f…",
  "title": "refatorar parser",
  "cwd": "D:\\sources\\projeto",
  "pid": 12345,
  "resume": { "args": ["--resume", "0b6f…"], "cwd": "D:\\sources\\projeto", "env": {} }
}
```

- `resume` é a receita exata para retomar. Para o soul inclui `-H`, `-a`, `-g` etc.
- Linhas corrompidas (escrita interrompida) são ignoradas, nunca viram erro.

### 6.4 Estado do tether

```
%LOCALAPPDATA%\tether\
  slots\<slotId>.jsonl      eventos do slot (append-only)
  slots\<slotId>.json       metadados do slot: nome, agente, pasta inicial, criado em
  tether.log                diagnóstico
```

- Gravação só por append + arquivo por slot: dois slots nunca escrevem no mesmo arquivo.
- Sem servidor e sem banco: tudo sobrevive a qualquer travamento, porque não há nada em memória.

### 6.5 Interface de linha de comando (fase 1)

| Comando | O que faz |
|---|---|
| `tether new <agent> [--name n] [--cwd p] [-- args do agente]` | Cria um slot e lança o agente nele |
| `tether open <slotId>` | Retoma o slot: roda o agente com a receita `resume` do último vínculo |
| `tether ls` | Lista os slots: nome, agente, pasta, sessão, título, estado (ativo / encerrado / não confirmado), última atividade |
| `tether show <slotId>` | Histórico de eventos do slot |
| `tether report --agent claude` | Usado pelo hook do Claude (interno) |
| `tether rm <slotId>` | Esquece o slot (não apaga a sessão do agente) |
| `tether doctor` | Verifica o ambiente: versões dos agentes, suporte do soul a `SOUL_SESSION_REPORT`, permissões de escrita |

Na fase 2, a IDE usa exatamente essas operações (como biblioteca ou via CLI).

### 6.6 Regras de confiança

1. **A fonte da verdade é o evento do agente.** Pasta, data e "mais recente" nunca decidem sozinhos.
2. **Sem evento = "não confirmado".** O tether mostra isso e pede escolha. Ele pode **sugerir** um candidato (registro do soul, arquivos do Claude por pasta e horário), mas nunca retoma sem confirmação.
3. **Antes de retomar, verificar:** a sessão existe, a pasta existe, a sessão não está aberta em outro slot ativo (C14, via `pid` vivo).
4. **Nunca alterar os arquivos de sessão dos agentes.** O tether só lê.
5. **Nunca alterar as configurações globais da pessoa.** Os hooks do Claude entram via `--settings`, só nos processos lançados pelo tether.

## 7. Requisitos

### Funcionais

- **RF1** Criar slots com ID estável e lançar `claude` ou `soul` neles.
- **RF2** Registrar cada troca de sessão do slot com o ID real vindo do agente (C1–C9).
- **RF3** Manter o vínculo depois de saída normal, kill, travamento e reinício (C10–C12).
- **RF4** Retomar um slot com um comando, no mesmo contexto (pasta, flags, host).
- **RF5** Isolar slots: vários slots na mesma pasta não se misturam (C13).
- **RF6** Detectar sessão aberta em dois slots, sessão inexistente e pasta inexistente (C14–C16).
- **RF7** Exibir título/nome da sessão (C8).
- **RF8** Marcar vínculos não confirmados e nunca chutar em silêncio (C18).

### Não funcionais

- **RNF1** Windows primeiro (Windows Terminal, VSCodium, PowerShell, Git Bash). Sem bloquear macOS/Linux depois.
- **RNF2** Zero mudança nas configurações globais do Claude e do soul.
- **RNF3** Reportar não pode atrasar o agente: o hook roda em menos de 100 ms e falha em silêncio (o agente nunca quebra por causa do tether).
- **RNF4** Estado legível por humanos (JSONL/JSON) e fácil de depurar.
- **RNF5** Stack: TypeScript em Node (mesmo ambiente do soul-cli); `node-pty` para os testes.

## 8. Como provar (critério de saída da fase 1)

Uma **suíte de testes de ponta a ponta** que dirige os agentes reais num pseudo-terminal (`node-pty`):

1. Para cada cenário C1–C18 e cada agente aplicável: lança pelo tether, executa as ações (digita `/clear`, `/resume`, `/rename` etc.) e confere que o vínculo do tether é igual ao ID real da sessão.
2. Para C11/C12: mata a árvore de processos no meio da conversa, roda `tether open` e confere que a sessão retomada é a mesma. Prova: o agente reporta `source=resume` com o mesmo ID, e a conversa anterior está lá.
3. Teste de carga leve: 10 slots simultâneos, metade na mesma pasta, trocas aleatórias de sessão. Zero vínculos errados.
4. Para não gastar tokens à toa, os testes usam prompts mínimos, e o soul usa um modelo ou estratégia barata.

**A fase 1 termina quando** a suíte passa 100% em Windows para os dois agentes, em 3 execuções seguidas, e o uso diário por uma semana não tiver nenhum vínculo errado.

## 9. Plano

| Etapa | Entrega |
|---|---|
| **E0. Spikes** | ✅ Claude concluído (seção 4.1). soul: decidir entre hooks do engine e `SOUL_SESSION_REPORT` no cliente (recomendado o cliente) |
| **E1. Núcleo** | Formato de evento, estado por slot, `tether report`, `ls`, `show` |
| **E2. Claude** | `tether new claude` com hooks via `--settings`; `open`; cenários Claude |
| **E3. soul** | Implementar `SOUL_SESSION_REPORT` no soul-cli (+ testes no próprio soul); `tether new soul`; cenários soul |
| **E4. Robustez** | C13–C18, `doctor`, mensagens de erro |
| **E5. Prova** | Suíte E2E completa + uma semana de uso real |

## 10. Riscos e perguntas em aberto

- **Mudanças no Claude Code:** o formato dos hooks ou dos transcripts pode mudar entre versões. Mitigação: `doctor` checa a versão; os testes E2E rodam a cada atualização.
- **soul remoto (`-H`):** a sessão pode deixar de existir no servidor; tratar como C15.
- **Mesma sessão em dois slots (C14):** apenas avisar, ou bloquear? Proposta: avisar e pedir confirmação.
- **Retomar tudo de uma vez ao abrir a IDE** gasta recursos (vários agentes subindo juntos). Isso é decisão da fase 2: retomar sob demanda ou em lote.

---

# Fase 2 — o app

## 11. Objetivo

Um app de terminais para agentes, com:

1. **Painéis livres pelo mouse:** dividir na vertical e na horizontal, arrastar painéis entre grupos, redimensionar, como no VSCodium.
2. **Robustez:** a janela pode travar ou fechar sem matar os terminais. Se até o processo dos terminais morrer, cada painel volta na sessão certa (fase 1).
3. **Cada painel lembra a sessão:** ao reabrir o app, o layout volta igual e cada painel retoma a sessão de Claude ou soul que estava nele.
4. **Saber o que é cada painel:** cabeçalho com agente, título da sessão, pasta e estado.

## 12. Arquitetura

```
┌──────────────── app (Electron) ────────────────┐        ┌────────── tetherd (Node) ───────────┐
│ renderer: dockview (layout) + xterm.js/painel  │  pipe  │ um PTY (node-pty/ConPTY) por slot    │
│ main: conecta ao tetherd; sobe se não existir  │◄──────►│ buffer de rolagem por slot           │
│ layout salvo em <home>/layout.json             │ \.\pipe│ lança via adapters da fase 1         │
└────────────────────────────────────────────────┘ tether │ observa <home>/slots/*.jsonl         │
                                                          └──────────────────────────────────────┘
```

- **tetherd** é um processo separado e destacado da janela. Ele é dono dos PTYs. Fechar ou travar a janela não afeta os agentes; ao reabrir, o app **reconecta** e recebe o buffer de rolagem de cada painel.
- Se o tetherd morrer (ou a máquina reiniciar), os PTYs morrem junto. Ao subir de novo, ele **retoma** cada slot pelo vínculo da fase 1.
- O id do painel no layout **é** o `slotId`. Layout e vínculo ficam ligados sem tabela extra.
- Stack: Electron (sem toolchain nativa: node-pty já tem binários prontos; Tauri exigiria Rust + MSVC, e Visual Studio está vetado), xterm.js, dockview-core. Tudo por projeto, nada instalado na máquina.

## 13. Tipos de painel

| Tipo | Lança | Retomada |
|---|---|---|
| Claude | `claude` via adapter | sessão exata (fase 1) |
| soul | `soul` via adapter | sessão exata (fase 1) |
| Shell | PowerShell ou Git Bash | novo shell na mesma pasta (sem sessão) |

## 14. Requisitos do app

- **RA1** Novo painel: botão/atalho → escolher tipo e pasta (pastas recentes primeiro).
- **RA2** Split por arrastar a aba para as bordas de outro painel; split por atalho; fechar painel pergunta se encerra o agente ou só desanexa.
- **RA3** Reabrir o app restaura layout + todos os painéis (reconectando se o tetherd vive; retomando se não).
- **RA4** Cabeçalho do painel: ícone do agente, título da sessão (atualiza com `/rename`), pasta, estado (rodando / encerrado / não confirmado).
- **RA5** Painel "não confirmado" mostra a escolha antes de retomar (regra 6.6.2).
- **RA6** Desempenho: digitar sem atraso perceptível; 12 painéis abertos sem travar.
- **RA7** Copiar/colar, links clicáveis, fonte e tema configuráveis no mínimo do VSCodium.
- **RA8** Retomada em lote não sobe 12 agentes de uma vez: sobe em fila (no máximo 3 ao mesmo tempo); os outros aparecem como "retomando…".

## 15. Prova da fase 2

- E2E do tetherd (sem janela): criar slots, anexar, matar o cliente, reanexar → buffer e processo intactos; matar o tetherd → subir → slots retomados nas sessões certas.
- E2E do app (Electron dirigido por Playwright): abrir, dividir em 4, fechar a janela à força, reabrir → mesmo layout, mesmos agentes vivos.
- Uso real pelo Guga, uma etapa por vez.
