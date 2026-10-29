# MANIFEST — tether

Documento de passagem: tudo o que é preciso para continuar o projeto a partir do estado de 2026-10-29. Leitura obrigatória antes de qualquer ação; os demais documentos são referências citadas aqui.

## 1. O que é

**tether** (nome provisório) é um app de terminais para agentes de código no Windows. Cada painel roda um agente (Claude Code, soul-cli) ou um shell. Duas promessas:

1. **Cada painel sabe qual sessão de agente está rodando e a retoma** depois de fechar, travar ou reiniciar. A sessão nunca é deduzida por data ou pasta: o próprio agente informa o ID a cada troca.
2. **Robustez:** a janela pode travar ou ser morta sem matar os agentes; os painéis são livres pelo mouse (split vertical/horizontal, arrastar abas), como no VSCodium.

Público: um desenvolvedor que abre vários agentes ao mesmo tempo e precisa voltar exatamente onde estava.

## 2. Estado atual

**Funcionando e provado** (testes de ponta a ponta contra Claude e soul reais):

| Área | Estado |
|---|---|
| Gestão de sessão Claude (17 cenários: `/clear`, `/resume`, `/compact`, `/rename`, fork, kill, daemon morto, 2 slots na mesma pasta, sessão/pasta inexistente, não confirmado…) | verde 3× |
| Gestão de sessão soul (14 cenários, com o build `feat/session-report`) | verde 3× |
| Carga: 10 slots, kill do daemon, retomada | verde 3× |
| App: layout, kill da janela (mesmos PIDs), kill do daemon (retomada), Claude real pela UI | verde |
| Pasta canônica (`d:\atrium` → `D:\atrium`, exigido pelo `/resume` do Claude) | integrado |
| Tema Claro / Automático (padrão) / Escuro | integrado |
| R1 gestão de processos (daemon fora da árvore do app, um daemon por pipe, órfãos por identidade, autoproteção) | integrado |
| R3 `killall node` não atinge o tether (`tetherd.exe`, `tether-soul.exe`) | integrado |
| Perfis de lançamento — núcleo (store, validação, daemon, CLI) | integrado |
| Diálogos próprios (sem caixas nativas) + ícones Phosphor | integrado, **prova incompleta** (§7.1) |
| CLI `tether` (ls, show, new, open, attach, stop, rm, rename, profiles, doctor) | integrado |
| Atalho no Menu Iniciar, ícone, instância única | integrado |

Última verificação no `main` (commit `70f21b6` + este documento): `npx tsc -p .` e `npx tsc -p app/renderer` limpos, `npm test` 230/230, `npm run app:build` ok. O app instalado no Menu Iniciar roda esse build.

**Não há remote git.** O repositório é local (`D:\sources\localhost\agentic-terminal`, branch `main`). Publicar exige criar o remote; nenhuma decisão foi tomada sobre onde.

## 3. Onde está cada coisa

| O quê | Onde |
|---|---|
| Repositório | `D:\sources\localhost\agentic-terminal` (branch `main`) |
| Requisitos e cenários | `PRD.md` (§5 cenários C1–C18, §11–15 app) |
| Plano original | `PLAN.md` |
| Histórico, provas e decisões | `PROGRESS.md` (seção "Decisões para validar" é obrigatória) |
| Regras de trabalho do projeto | `CLAUDE.md` |
| Uso e desenvolvimento | `README.md` |
| Testes E2E (harness, dialetos Claude/soul) | `test/e2e/README.md` |
| Mudança no soul-cli | worktree `D:\atrium\workspace\soul-cli-tether`, branch `feat/session-report`, commit `0155b7a` (não integrado ao `develop`) |
| Estado em execução do usuário | `%LOCALAPPDATA%\tether` (slots, layout, settings, profiles, logs, `bin\tetherd.exe`) |
| Atalho | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\tether.lnk` |

## 4. Arquitetura

```
app (Electron: dockview + xterm.js + Phosphor)  ──named pipe──►  tetherd.exe (Node: um ConPTY por slot)  ──►  claude / tether-soul.exe / shell
                                                                       ▲
                     hooks SessionStart/End do Claude  /  SOUL_SESSION_REPORT do soul  →  <home>\slots\<slot>.jsonl
```

- **TypeScript executado direto pelo Node 24** (type stripping; imports com `.ts`; só sintaxe apagável). Sem build fora do app. Única dependência de runtime: `node-pty`.
- `src/core` — contratos (`event.ts`), store por slot (JSONL append-only), paths (`canonicalDir`), liveness (ajudante PowerShell residente para horário de início), `exe.ts` (cópias renomeadas do node), `profile.ts`.
- `src/agents` — adaptadores `claude`, `soul`, `shell` (plano de lançamento, retomada, título, existência de sessão).
- `src/report/claude-hook.mjs` — hook do Claude; nunca escreve em stdout, sempre sai 0.
- `src/daemon` — `tetherd`: protocolo NDJSON (`protocol.ts` é o contrato), PTY por slot, scrollback, fila (máx. 3 iniciando), vínculos, perfis, órfãos, autoproteção; `client.ts` com `spawnDaemon` (via `Start-Process`, fora da árvore e sem herdar handles).
- `src/cli` — CLI `tether`; `src/doctor.ts`.
- `app/` — Electron: `main` (janela, conexão, menu, tema, perfis IPC, instância única), `preload`, `renderer` (dockview, painéis xterm, diálogos `dialog.ts` + `situations.ts`, ícones `icons.ts`), `build.mjs` (esbuild one-shot; extrai o CSS do dockview do UMD), `install.mjs` (atalho).

## 5. Como rodar e testar

```powershell
npm ci                        # se faltar binário: node node_modules/electron/install.js ; node node_modules/esbuild/install.js
npm run check                 # typecheck + unitários
npm run app:build ; npm run app:install   # compila e (re)instala o atalho
node bin/tether.mjs doctor
$env:TETHER_E2E_HIDDEN=1; node --test --test-concurrency=1 test/e2e/app.<nome>.test.ts   # um arquivo por vez
node --test --test-concurrency=1 test/e2e/claude.scenarios.test.ts
$env:TETHER_SOUL_CMD="node D:/atrium/workspace/soul-cli-tether/bin/soul"; node --test --test-concurrency=1 test/e2e/soul.scenarios.test.ts
```

Variáveis: `TETHER_HOME`, `TETHER_PIPE` (testes sempre privados), `TETHER_CLAUDE_ARGS` / `TETHER_SOUL_ARGS` (args extras em todo lançamento; testes usam `--model haiku` / modelo barato), `TETHER_SOUL_CMD`, `TETHER_NODE`, `TETHER_E2E_HIDDEN=1` (janela offscreen).

**Depois de mudar `src/daemon`, `src/agents` ou `src/core`:** o `tetherd` em execução continua com o código antigo; reiniciá-lo (os slots retomam as sessões). Depois de mudar `app/`: `npm run app:build`.

## 6. Regras que não podem ser quebradas

1. **Nunca tocar o estado real do usuário em testes:** home `%LOCALAPPDATA%\tether`, pipe `\\.\pipe\tether-gugac`, o app e o `tetherd` dele. Testes usam home e pipe próprios.
2. **Matar processo só por identidade** (PID + horário de criação, e linha de comando com a home/caminho do teste) via `test/kill.ts`. PIDs são reaproveitados no Windows: já houve falso órfão (`csrss`, `dwm`) e suspeita de um teste ter matado o daemon real.
3. **Remover todas as variáveis `CLAUDE*` ao lançar o `claude`** (exceto `CLAUDE_CONFIG_DIR` vindo de perfil). Herdadas de outra sessão do Claude, impedem a gravação do transcript.
4. **Nunca matar uma sessão do Claude com menos de 11 s de vida.** Duas mortes assim desligam a tela cheia do Claude em toda a máquina (`fullscreenAutoDisabled` em `~/.claude.json`). Conferir ao fim de toda suíte.
5. **Claude ≥ 2.1.312 recusa `--session-id` junto de `-c`/`--resume`** sem `--fork-session`; o adaptador já trata.
6. **`/resume` do Claude compara o cwd letra por letra:** toda pasta passa por `canonicalDir`.
7. **Nenhuma caixa nativa do Windows no app** (só o seletor "Procurar…" de pasta). Diálogos novos são declarações em `situations.ts`, escritas a partir do que a situação comunica: situação, contexto, escolhas como cartões com consequência, tom seguro/neutro/destrutivo, destrutivo nunca é padrão.
8. **Ícones só Phosphor** (`@phosphor-icons/core`, SVG embutido, `currentColor`).
9. **Código em inglês; tudo que a pessoa lê em português.** Commits em português, frequentes, arquivos adicionados pelo nome; sem force push.
10. **Testes E2E com agentes reais rodam um por vez.** A máquina chegou a ~3 GB livres com outras suítes rodando; o runner chegou a ser morto por memória.
11. **"Abrir o app" = versão mais nova:** build atual e `tetherd` reiniciado se o código dele mudou; avisar antes de abrir se algo ainda não entrou.

## 7. Trabalho pendente (em ordem)

### 7.1 Fechar a prova dos diálogos próprios
Integrado sem a rodada final completa (interrompida por falta de memória e depois pausada). Rodar, um arquivo por vez com `TETHER_E2E_HIDDEN=1`: `app.dialogs`, `app.instance`, `app.layout`, `app.tree`, `app.theme`, e por último `app.claude` (Claude real). Gerar `test/e2e/artifacts/dialog-still-closing-light.png` (faltou). Revisar as capturas claro/escuro dos diálogos. Corrigir o que falhar.

### 7.2 Perfis — interface (P2)
O núcleo está pronto (`src/core/profile.ts`; protocolo `profiles-list`, `profile-save`, `profile-delete`, evento `profiles`; `create` aceita `profileId`; `SlotState` traz `profileName` e `unsafe`; API do app `listProfiles/saveProfile/deleteProfile`). Falta:
- **Novo painel:** escolher o perfil (pré-selecionar o `default` do agente) e passar `profileId` no `create`.
- **Tela de perfis:** criar, editar, apagar, definir padrão; mostrar avisos de validação em português; usar o componente de diálogo e os ícones.
- **Selo "sem permissões"** na aba/cabeçalho quando `unsafe` (perfil com `--dangerously-skip-permissions`).
- Padrões já criados: "Claude", "Claude modo dev" (`--dangerously-skip-permissions`), "soul" (`-g`), "PowerShell", "Git Bash".
- E2E com janela escondida.

### 7.3 R2 — tratamento de erros
Auditar todo caminho de falha no daemon, no app e na CLI: nada falha em silêncio; toda falha tem mensagem em português com ação possível (usando o componente de diálogo no app) e linha em log. Testes com injeção de falha (pipe ocupado, node ausente, pasta sumida, agente que não sobe, disco sem permissão, `profiles.json` corrompido, daemon morto no meio de uma requisição).

### 7.4 soul-cli: aviso de sessão como recurso oficial, depois integrar e instalar
O aviso sai do **cliente** do soul (camada certa: só ele sabe qual conversa está na tela, inclusive com `-H`). A mudança está pronta em `feat/session-report` (`src/resume/session-report.ts` + pontos de chamada em `src/entrypoints/screen.tsx` e `src/ui/App.tsx`), 22/22 testes, prova ao vivo no agente Serpente. Antes de integrar:
1. **Contrato oficial:** schema Zod do evento (v1) e documentação no soul-cli (regra da casa: interface nasce com contrato).
2. **Nome neutro** da variável e do formato, para servir a qualquer orquestrador de terminais (manter compatibilidade com `SOUL_SESSION_REPORT` ou atualizar `src/agents/soul.ts` junto).
3. Integrar ao `develop` (o `develop` já avançou: `4412977` soul-sdk 1.6.26), rebuild, instalar guardando o anterior, provar no soul instalado e no app (suíte `soul.scenarios` sem `TETHER_SOUL_CMD`).
- Evolução, não necessária: `--session-id` que cria a sessão (hoje o canal do engine, `SessionIntent`, não permite escolher o ID; exige mudança nos pacotes do Atrium).
- Conhecido no soul (não do tether): `/rename` digitado enquanto `/branch` ainda roda renomeia a conversa antiga; `/compact` não emite evento.
- O `bun run check` do soul-cli não fica verde nem no `develop` limpo (28 erros de tipo e 4 testes); critério usado: nenhuma falha nova.

### 7.5 Limpeza
- Worktrees de agentes em `.claude\worktrees\` (todos já integrados ao `main`): remover. Antes de remover qualquer pasta, procurar links que saem dela (`find <pasta> -type l` + `readlink -f`) e desfazê-los primeiro.
- `D:\atrium\workspace\soul-cli-tether`: tem **junctions** em `node_modules\@atrium` apontando para os pacotes reais — desfazer as junctions antes de apagar a pasta, senão a remoção atravessa e apaga os originais.
- Branches de worktree no repositório do tether podem ser apagadas depois.

### 7.6 Melhorias registradas (não bloqueiam)
- `tether ps` / doctor listando quais processos são do tether.
- Request para trocar a pasta de um slot (hoje "escolher outra pasta" cria slot novo e esquece o antigo).
- Retomar soul remoto (`-H`) nunca foi testado (sem servidor disponível).
- Hook do Claude leva ~0,15 s (meta original de 0,1 s inalcançável nesta máquina) e roda em `node`: um `killall node` exatamente nessa janela perde um evento (o próximo corrige).
- Sessões antigas criadas pelo WSL (`/mnt/d/...`) são outro projeto para o Claude do Windows; só aparecem com Ctrl+A no `/resume`.
- Nome definitivo do produto.

## 8. Critério de "pronto" para a próxima fase

1. §7.1 a §7.4 concluídos, cada um com prova registrada em `PROGRESS.md` (o que foi rodado, resultado, quem rodou).
2. Suítes verdes: `npm run check`; E2E Claude, soul (com o soul instalado), carga e app, cada uma 3× seguidas.
3. App aberto pelo atalho no build atual, usado pela interface: novo painel com perfil "Claude modo dev", fechar painel pelo diálogo, sair e reabrir, retomada certa; capturas revisadas.
4. Limpeza §7.5 feita.
