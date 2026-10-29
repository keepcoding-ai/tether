# tether (nome provisório)

**Cada terminal sabe qual sessão de agente ele estava rodando, e a retoma depois de qualquer reinício.**

Funciona com **Claude Code** (`claude`) e **soul-cli** (`soul`).

> Status: **fase 1, em planejamento.** Nada abaixo está implementado ainda. Veja o [PRD](./PRD.md).

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
| soul-cli | Variável `SOUL_SESSION_REPORT` (a ser adicionada no soul-cli). |

## Como usar (app, Windows)

O app roda direto desta pasta do repositório; nada é instalado na máquina além de um atalho no Menu Iniciar do usuário.

1. **Instalar o atalho** (uma vez, dentro da pasta do repositório): `npm ci` e depois `npm run app:install`. Isso compila o app e cria **"tether"** no Menu Iniciar (`%APPDATA%\Microsoft\Windows\Start Menu\Programs\tether.lnk`), com ícone. Pode fixar na barra de tarefas. `npm run app:uninstall` remove o atalho.
2. **Abrir:** Menu Iniciar → tether. Não abre console nem precisa de terminal. O app sobe o `tetherd` sozinho (precisa do `node` ≥ 24 no PATH do usuário, ou da variável `TETHER_NODE` apontando para o `node.exe`). Abrir de novo com o app já aberto só traz a janela existente para frente.
3. **Novo painel:** `Ctrl+Shift+T` ou "+ Novo painel": escolha o tipo (Claude, soul ou shell) e a pasta (as recentes aparecem primeiro).
4. **Dividir:** "Direita" (`Ctrl+Shift+D`) ou "Abaixo" (`Ctrl+Shift+E`), ou arraste a aba de um painel para a borda de outro.
5. **Fechar um painel** pergunta: *encerrar o agente* (mata o processo) ou *só fechar o painel* (o agente continua no `tetherd` e aparece em "Slots fechados" para reabrir).
6. **Fechar a janela** (`Ctrl+Shift+W` ou o X) só desconecta: os terminais continuam vivos no `tetherd`, e ao reabrir o app o layout e os painéis voltam como estavam. **Arquivo → "Sair e encerrar tudo…"** (`Ctrl+Shift+Q`) mata todos os agentes, derruba o `tetherd` e fecha.
7. **Onde fica o estado:** `%LOCALAPPDATA%\tether` (`TETHER_HOME` sobrescreve): `slots\` (vínculos slot → sessão), `layout.json`, `recent-folders.json`, `tetherd.pid`, `tetherd.log` e `electron\` (cache do Electron).
8. **Depois de mudar o código:** o atalho nunca recompila. Rode `npm run app:build` (ou `npm run app:install` de novo) e reabra o app; `npm run app` compila e abre numa tacada só, para desenvolvimento.

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

## Onde fica o estado

```
%LOCALAPPDATA%\tether\slots\<slotId>.jsonl   eventos de sessão do slot (append-only)
%LOCALAPPDATA%\tether\slots\<slotId>.json    nome, agente e pasta do slot
```

São arquivos de texto simples, legíveis e fáceis de inspecionar. O tether nunca altera os arquivos de sessão do Claude ou do soul.

## Roteiro

1. **Fase 1: gestão de sessões (atual).** Provar, com testes de ponta a ponta contra os agentes reais, que o vínculo slot → sessão está sempre certo em todos os cenários do [PRD](./PRD.md#5-cenários-que-precisam-funcionar).
2. **Fase 2: a IDE.** Painéis divididos livremente com o mouse, robusta contra travamentos, usando o tether como base.

## Desenvolvimento

Stack prevista: TypeScript em Node, com `node-pty` para os testes de ponta a ponta. Comandos de build e teste serão definidos na etapa E1.
