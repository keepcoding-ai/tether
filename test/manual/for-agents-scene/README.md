# A cena do for-agents (V2)

Roteiro manual da seção 8 do contrato. U = você; A = o Claude Code real numa guia da mesa `atrium`; mesa `cena` começa vazia. Um tether à parte (home e pipe da bancada), janela visível, agentes em pastas de bancada fora de `D:/atrium`, `D:/agentes`, `D:/kai`.

Prints: `D:/atrium/.tmp/tether-agents/onda-2/cena/passo-NN.png`.

Abreviações: `CLI` = `node D:/atrium/.tmp/wt/tether-agents/bin/tether.mjs`. `$B` = a raiz de bancada que `setup.mjs` imprime (`scene.json` tem `dirs.c1`, `dirs.ser`, `dirs.c3`). Os comandos `agents ...` rodam DENTRO da guia de A (herda `TETHER_SLOT_ID`, `TETHER_SLOT_KEY`, home e pipe do tether da cena).

## Preparar (uma vez)

1. `node setup.mjs` e cole os três blocos que ele imprime num PowerShell novo (tira `CLAUDE*`/`TETHER_*`, sobe `tetherd` em modo serve, builda e abre o app visível; cada PID é registrado com `setup.mjs record`).
2. No app: crie as mesas `atrium` e `cena`. Em Configurações, ligue `for-agents` e os quatro condutores (terminal, claude, soul, codex).
3. Abra A (Claude Code) numa guia da mesa `atrium`, depois de ligar as extensões, com `CLAUDE*` limpo; a sessão de A é o "eu" da cena.

## Régua de TODO passo

Antes e depois de cada passo: `node check.mjs --before` ... passo ... `node check.mjs --after` (passe `--slot <id da guia de A>` se rodar fora da guia dela). Ele imprime mesa ativa e quadro ativo (de `layout.json`), `agents list` e os objetos de posse de `cena` (`objects/for-agents.json`), e diz se a mesa visível/guia ativa mudou.

Confira também a olho: janela não toma o foco, nenhum aviso do sistema, o sino não ganha linha por guia comandada.

Leitura de mesa visível e guia ativa: `ui.desks.activeId()`/`ui.panes.activeId()` só existem dentro do app (sonda de teste, build com `TETHER_TEST_EXTENSIONS=1`). O que existe hoje fora dele é `layout.json` (mesa ativa e quadro ativo; a guia ativa dentro do quadro não é lida). Ponto aberto: a guia ativa é conferida a olho/print.

## Passos

| # | Quem | Comando / gesto | Observar | Print |
|---|---|---|---|---|
| 0 | U | Extensões ligadas, A aberta depois. Em A: `CLI agents list` | `path: 'inside'` no canal de A | passo-00 |
| 1 | U | Menu da pílula de `cena` > "Dar a mesa a um agente..." > Atrium > "Dar a mesa" | Selo cheio "Atrium", cor de `agentHue(A)`; A recebe `você recebeu a mesa cena`; `check` mostra `desk.cena.owner = { owner: A, givenBy: 'user' }` | passo-01 |
| 2 | A | `CLI agents list` | Mesa `cena` sem guias; `relation` vazio | passo-02 |
| 3 | A | `CLI agents open claude $B/c1 --name "claude · conferente" --model haiku` (use `dirs.c1`) | Aba nova em `cena`, inativa, sublinhado na cor de A; confiança respondida pelo condutor; `running` | passo-03 |
| 4 | A | Ser (ver abaixo) e depois `CLI agents open soul $B/ser --name "soul · bancada" --model cheap --effort low --args -P --args <perfil>` | 2a aba com sublinhado; diálogos de confiança e perfil respondidos; nada em `.soul/` à mão | passo-04 |
| 5 | A | `CLI agents open codex $B/c3 --name "codex · conferência" --model gpt-5.6-luna --effort low --json '{"args":["-a","on-request","-s","read-only"]}'` | 3a aba; sem diálogo de atualização nem de confiança | passo-05 |
| 6 | A | `CLI agents send "claude · conferente" "<pedido>"` | Retorno `inside`; bolinha verde; turno de canal com `role="owner"` | passo-06 |
| 7 | -- | O Claude termina | Losango na cor de A (aba e pílula); contador laranja igual; A recebe `kind="notice"` `terminou · guia ... · mesa cena` | passo-07 |
| 8 | A | `CLI agents last-answer "claude · conferente"` | Texto inteiro, `source: 'hook'`; losango some | passo-08 |
| 9 | A | `CLI agents send "soul · bancada" "<pedido de várias linhas>"`, espere o aviso, `CLI agents last-answer "soul · bancada"`; depois 2o `send` | `typed`; cabeçalho `[tether · for-agents · de Atrium (owner) · ...]` e corpo colado; `source: 'session'`; 2o turno ok | passo-09 |
| 10 | A | `CLI agents send "codex · conferência" "<pedido que cria um arquivo>"` | `typed` (Enter 300 ms depois); cartão de aprovação | passo-10 |
| 11 | -- | A vigia vê o cartão | Losango na cor de A; sem laranja nem toast; A recebe `kind="request"` `pede permissão ...` com `Opções: yes · always · no` | passo-11 |
| 12 | A | `CLI agents read-screen "codex · conferência"` e `CLI agents answer "codex · conferência" yes` | Tela como texto, `state: 'permission'`; guia não pisca; cartão some, turno segue, chega o aviso de fim | passo-12 |
| 13 | U | Clique na aba `soul · bancada`, digite uma letra | Mão "com você"; sublinhado some; barra: "com você · antes: Atrium, pela mesa"; A recebe `o usuário tomou a guia soul · bancada` | passo-13 |
| 14 | A | `CLI agents send "soul · bancada" "<pedido>"` | `queued`, `why: 'with-user'`; o PTY não recebe byte do tether | passo-14 |
| 15 | U | Apague a letra; menu da aba > "Devolver a Atrium" | Mão some, sublinhado volta; A recebe `o usuário devolveu a guia soul · bancada`; após o silêncio, o pedido do 14 é digitado | passo-15 |
| 16 | A | `CLI agents list` | Três guias `relation: 'command'`, estado de cada uma, nada pendente | passo-16 |

### Passo 4: o ser Soul (verbos do motor, em pasta nova e vazia `dirs.ser`)

```
cd <dirs.ser>
soul init -f <fonte> --replace
soul profiles create <id> --name "<nome>"
```

`<fonte>` e `<id>` são seus (o roteiro não os fixa). O `-P` do `open` leva `<id>`. O perfil de lançamento padrão entra sozinho. Nada em `.soul/` à mão.

Nota de sintaxe: `--args` é repetível (um valor por ocorrência), então `-P <perfil>` se escreve `--args -P --args <perfil>`. A forma `--args -P <perfil>` deixaria `<perfil>` como posicional solto.

## Extensão da cena

| Gesto | Comando |
|---|---|
| Interromper no meio do turno | `CLI agents interrupt <guia>` (com a guia `busy`; `not-busy` se ociosa) |
| Compactar em cada motor | `CLI agents command <guia> compact` (claude, soul, codex) |
| U dá a A a própria guia ("de si") | menu da guia de A > dar a si; A: `CLI agents command compact` (sem `<guia>`: adiado ao fim do turno, aparece em `pending` do `list`) |
| A se reencontra | `CLI agents list` depois de compactar |
| Fechar | `CLI agents close <guia>` (em si mesma dá `bad-request`) |

## Fim

`node teardown.mjs`: encerra só os PIDs de `scene.json` (e o do `tetherd.pid` da bancada) e apaga a raiz; recusa se achar link.
