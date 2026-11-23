# A cena dos canais (S2)

Roteiro manual da seção 8 do contrato dos canais (`D:/atrium/.tmp/tether-agents/onda-3/canais.md`). Quem roda é a regência, com o Guga na tela.

Atores: **U** = o Guga (moderador, na tela); **A** = a Atrium, um Claude Code numa guia da mesa `atrium` (dona da mesa `cena`); os três agentes que A abre: `claude · conferente`, `soul · bancada`, `codex · conferência`. Um tether à parte (home e pipe da bancada), janela visível, agentes em pastas de bancada fora de `D:/atrium`, `D:/agentes`, `D:/kai` e `workspace/lar`. O ser Soul nasce novo e vazio pelos verbos do motor. A cena usa mais de um agente de LLM vivo (exceção C11, haiku onde o motor deixa).

Evidência (prints, logs): `D:/atrium/.tmp/tether-agents/onda-3/cena/`.

## Nomes que valem (decisões da regência, onde diferem do contrato)

- O canal da mesa chama-se `cena`, não `mesa-cena` (C14): é o slug do nome da mesa, sem prefixo. O que diz que ele é da mesa é o campo `desk`. Onde o contrato diz `mesa-cena`, leia `cena`.
- O dono do canal fala como `member` (C2); a linha gravada guarda `role: owner`.
- Na tela: dono, membro, moderador, calado. Nos verbos: `owner`, `member`, `moderator`, `muted`.

## Como rodar

Abreviações: `CLI` = `node D:/atrium/.tmp/wt/tether-channels/bin/tether.mjs`. `$B` = a raiz de agentes que `setup.mjs` imprime (`scene.json` tem `dirs.c1`, `dirs.ser`, `dirs.c3`). Os comandos `agents ...` e `channels ...` de A rodam DENTRO da guia de A (herda `TETHER_SLOT_ID`, `TETHER_SLOT_KEY`, home e pipe da bancada).

```
cd D:/atrium/.tmp/wt/tether-channels
node test/manual/channels-scene/setup.mjs            # cria a bancada, liga for-agents, channels e skills, diz as pastas
node test/manual/channels-scene/setup.mjs up         # daemon (modo serve) + build + app visível, tudo por spawn com home e pipe da bancada
node test/manual/channels-scene/check.mjs --before   # antes do passo
node test/manual/channels-scene/check.mjs --after --step N   # depois do passo N
node test/manual/channels-scene/teardown.mjs         # ao terminar: desmonta só o que o setup criou
```

Ensaio sem tela: `setup.mjs up --no-app` sobe só o daemon.

`check.mjs` lê, do home da bancada, `channels/index.json`, as linhas de cada canal, `desks.json`, `layout.json`, `objects/for-agents.json` e `settings.json`; e chama pela CLI `agents list`, `channels list` e `channels members <canal da mesa>` quando sabe o slot de A (`--slot <id>`, ou o dono do canal da mesa lido do `index.json`). Os verbos provam o slot com o ambiente da guia: de fora da guia a CLI pode recusar, e a recusa aparece impressa; o quadro do disco vale de qualquer jeito. `--after --step N` marca cada item como `[ok]`, `[FALTA]` ou `[n/a]` (só o olho ou a tela do M3 mostram).

## Régua de TODO passo

Antes e depois: `check.mjs --before` ... passo ... `check.mjs --after --step N`. Confira em todo passo que a mesa visível e a guia ativa de U não mudam (o `check` compara a mesa e o quadro ativos pelo disco; a guia ativa dentro do quadro e `ui.panes.activeId()` só se leem a olho ou pelo print), a janela não toma o foco, nenhum aviso do sistema sai, e nenhuma guia fica laranja por fala de canal, salvo no passo 9 e num pedido de permissão.

## Preparar

1. `setup.mjs`, depois `setup.mjs up`.
2. No app, crie as mesas `atrium` e `cena` pelo "+" da barra de mesas (duplo clique no nome para renomear). `for-agents`, `channels`, `skills` e os condutores já estão ligados.
3. Abra A (Claude Code) numa guia da mesa `atrium`, depois de tudo ligado, com `CLAUDE*` limpo. A sessão de A é o "eu" da cena. Prints: `passo-NN.png` na pasta de evidência.

## Os 15 passos

"Roda hoje" = dá para fazer e conferir com o que existe (CLI, daemon, menu da pílula da onda 2). "Espera M3/F2" = depende da guia do canal (M3) ou da parte de tela da mesa (F2), que ainda não existem no app; onde há equivalente pela CLI, está na coluna.

| # | Quem age | O que faz | O que conferir | Hoje |
|---|---|---|---|---|
| 0 | U | Liga `for-agents`, os condutores e `channels` (já vêm ligados na bancada); abre A depois disso. | Em A: `CLI channels list` vazio. O `initialize` de A traz o parágrafo `[channels]`. `check --after --step 0`. | Roda hoje pela CLI |
| 1 | U | Dá a mesa `cena` a A (menu da pílula de `cena` > "Dar a mesa a um agente...", como na cena da onda 2). | Nasce `#cena`, dono A, com o aviso de criação. A recebe por dentro `você abriu #cena…` (sistema). `channels/index.json` tem `desk_<id>`. `check --after --step 1`. | Roda hoje pela CLI. A parte de tela da mesa (selo, lista de canais em "Painéis da mesa") espera F2 |
| 2 | A | `CLI agents open claude $B/c1 --name "claude · conferente" --model haiku`; o ser Soul (abaixo) e `CLI agents open soul $B/ser --name "soul · bancada" --model cheap --effort low --args -P --args <perfil>`; `CLI agents open codex $B/c3 --name "codex · conferência" --model gpt-5.6-luna --effort low --json '{"args":["-a","on-request","-s","read-only"]}'` | Cada guia entra no canal (`by: desk`) e recebe o aviso de entrada; Soul e Codex com a linha de como falar pela CLI. `CLI channels members cena`: Claude `inside`, Soul e Codex `terminal` (guias `held` por A). `check --after --step 2`. | Roda hoje pela CLI |
| 3 | A | `CLI channels say cena "Bom dia. Cada um diga em uma linha o que vê na sua pasta."` | O retorno traz três recibos: `inside`, `typed`, `typed`. No Codex o cabeçalho chega com o `·`. `check --after --step 3`. | Roda hoje pela CLI |
| 4 | Os três | Respondem: Claude por `channels_say`, Codex por `channels_say`, Soul por `node "$TETHER_CLI" channels say cena "…"`. | A recebe três falas por dentro, `room="cena"`, `role="member"`. Nenhuma das três guias fica laranja. Como as três são comandadas por A, o fim de cada turno vai a A pela `for-agents` (losango na cor de A e o aviso `terminou · guia …`): é a C12, e a cena mede se pesa (A recebe duas vezes a mesma resposta). `check --after --step 4`. | Roda hoje pela CLI |
| 5 | U | Comando `channels.open` sem argumento; escolhe `#cena` no seletor. | O seletor abre com `#cena` em destaque no topo; a guia do canal abre (gesto de U) com o histórico dos passos 1 a 4. Equivalente: `CLI channels read cena`. | Espera M3 (depende da guia do canal). Equivalente pela CLI roda hoje |
| 6 | U | Escreve na guia do canal: `@soul quero o resumo em português`. | Soul recebe pelo terminal `[tether · channels · #cena · de usuário (moderator) → soul · bancada · cena#N] …`. A e os outros recebem a mesma fala com `role="moderator"`. `check --after --step 6`. | Espera M3 (o moderador só fala pela guia do canal; não há equivalente pela CLI) |
| 7 | A | `CLI channels create revisao --members "claude · conferente" --members "soul · bancada"` | `#revisao` nasce, dono A. Claude e Soul em dois canais. `check --after --step 7`. | Roda hoje pela CLI |
| 8 | A | `CLI channels say revisao "…"` e, logo depois, `CLI channels say cena "…"` | Claude recebe as duas, cada uma com o seu `room`. Soul, ocupado com a primeira, recebe a segunda quando o turno acaba. `check --after --step 8`. | Roda hoje pela CLI |
| 9 | Codex | `channels_say cena "preciso que o usuário escolha entre A e B" --to usuário` | A guia do canal ganha a marca laranja (precisa do usuário); o ícone de canais na barra de topo também; nenhuma outra guia muda; a marca some quando U vê. A fala fica no histórico (`check --after --step 9`). | Espera M3 (a marca na guia e no ícone). A fala em si roda hoje pela CLI |
| 10 | A | `CLI channels mute cena "codex · conferência"` | Codex recebe `você foi calado…`; o `channels_say` seguinte dele responde `muted`; ele continua recebendo as falas. `check --after --step 10`. | Roda hoje pela CLI |
| 11 | U e A | U clica na guia `soul · bancada` e digita uma letra (toma a guia). A fala três vezes em `cena`. | Nada é digitado na guia do Soul (offset do anel). Na fila, uma fala e, no lugar das outras duas, um aviso de fusão. U apaga a letra e devolve a guia ("Devolver a Atrium"): o Soul recebe a fala e o aviso, em dois turnos no máximo. `check --before` antes das falas e `check --after --step 11` depois (três falas novas no histórico). | Roda hoje (tomar a guia e devolver é da onda 2; as falas são pela CLI) |
| 12 | A, depois U | A: `CLI channels remove revisao "claude · conferente"`. Depois U encerra `#revisao` na guia do canal. | Claude recebe `você foi tirado…`; o encerramento chega a quem ficou; `#revisao` some do seletor e o histórico continua legível pela guia. `check --after --step 12`. | Metade roda hoje pela CLI (`remove`; e `CLI channels close revisao` como dono). O gesto de U, o seletor e a leitura pela guia esperam M3 |
| 13 | A | Compacta a si (`CLI agents command compact`, guia "de si") e roda `CLI channels list`. | A se reencontra: `#cena` como dono, nenhum outro. `check --after --step 13`. | Roda hoje pela CLI |
| 14 | A | `CLI agents close "codex · conferência"` | O Codex sai do canal da mesa (`saiu… a guia foi fechada`). `check --after --step 14`. | Roda hoje pela CLI |
| 15 | U | Revoga a mesa de A (menu da pílula). | `#cena` é encerrado (C8); o histórico fica; a mesa perde o dono. `check --after --step 15`. A leitura do histórico encerrado pela guia espera M3. | Roda hoje pela CLI (o encerramento e o histórico). A leitura pela guia espera M3 |

Resumo: roda hoje pela CLI nos passos 0, 2, 3, 4, 7, 8, 10, 11, 13, 14 e 15; roda em parte nos 1 e 12; esperam M3/F2 os passos 5, 6 e 9 (e a leitura pela guia nos 12 e 15, a tela da mesa no 1).

### O ser Soul (passo 2; verbos do motor, em pasta nova e vazia `dirs.ser`)

```
cd <dirs.ser>
soul init -f <fonte> --replace
soul profiles create <id> --name "<nome>"
```

`<fonte>` e `<id>` são seus. O `-P` do `open` leva `<id>`. Nada em `.soul/` à mão. `--args` é repetível: `-P <perfil>` escreve-se `--args -P --args <perfil>`.

## Fim

`node teardown.mjs`: encerra o app e seus relançamentos, depois o daemon (`daemon stop` incluso), depois o que tem as raízes da bancada na linha de comando; repete por até 20 s; apaga a pasta de trabalho dos agentes (system temp, `tether-canais-*`) e a raiz da bancada em `.tmp/.../cena/bench-*`, o `scene.json` e o `check-before.json`. Recusa se achar link ou raízes fora do esperado. Se uma pasta continuar presa, imprime quem a segura e sai com código 1.

Nunca toca o tether real do Guga (home, pipe e processos próprios), nem `D:/agentes`, `D:/kai`, `workspace/lar`.
