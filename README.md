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

## Uso planejado

```powershell
# cria um slot e abre o Claude nele
tether new claude --name api --cwd D:\sources\api

# cria um slot com o soul
tether new soul --name pesquisa --cwd D:\atrium\workspace\agente-x

# depois de reiniciar: lista os slots e o que cada um estava fazendo
tether ls
#  SLOT    NOME      AGENTE  SESSÃO     TÍTULO              ESTADO      ÚLTIMA ATIVIDADE
#  a1b2    api       claude  0b6f…      refatorar parser    encerrado   há 2 h
#  c3d4    pesquisa  soul    7e21…      revisão do PRD      encerrado   há 5 min

# retoma um slot
tether open a1b2

# histórico de sessões de um slot
tether show a1b2

# confere o ambiente
tether doctor
```

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
