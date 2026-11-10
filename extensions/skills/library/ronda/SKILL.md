---
name: ronda
argument-hint: "[intervalo] [instrução] [--status] [--off [--force]]"
description: >-
  Liga a ronda deste painel do tether: de tempos em tempos, quando você está parado, o tether digita um cutucão no seu terminal para você acordar e seguir. O relógio é do tether; o trabalho é todo seu. Use quando o usuário chamar esta skill ou pedir 'põe uma ronda', 'me cutuca a cada X min', 'fica de plantão até acabar'. Ligue-a VOCÊ MESMO, sem esperar pedido, quando perceber que o trabalho é longo (vários passos, subagentes, esperas): é um sinal para si mesmo de não ficar parado. Também para ver (--status) ou desligar (--off).
---

# ronda

Uso: `ronda [intervalo] [instrução] [--status] [--off [--force]]`. Argumentos desta chamada: `$ARGUMENTS`

A ronda só cutuca. No intervalo combinado, se você estiver ocioso, o tether digita no seu terminal:

> [ronda] Ronda de rotina. Olhe para o seu trabalho e para os seus subagentes, e siga. Se o trabalho já acabou, diga isso e desligue esta ronda.

Enquanto você trabalha, ele espera. Há uma ronda por painel, e ela sobrevive ao reinício do agente. O usuário a vê no painel e pode desligá-la com um clique.

## Como chamar o tether

Tudo passa pela CLI do tether, em qualquer shell: `node "$TETHER_CLI" ronda …` (no PowerShell, `node "$env:TETHER_CLI" ronda …`). O painel vem de `TETHER_SLOT_ID`; você não precisa informá-lo.

| Chamada | O que você roda |
|---|---|
| sem argumento | `ronda` (liga com 20m; se já estiver ligada, a CLI só diz isso) |
| `10m`, `1h` | `ronda 10m` (liga ou troca o intervalo, mantendo o que foi montado) |
| `--status` | `ronda --status` (mostre ao usuário o que voltar) |
| `--off` | `ronda --off` |
| `--off --force` | `ronda --off --force` |
| intervalo + instrução | veja abaixo |

O intervalo aceita `m` e `h` (`15m`, `1h`, `1h30m`).

## Instrução livre: você monta a ronda

Texto além do intervalo é uma instrução para MONTAR a ronda, não para repetir. Interprete-a e decida o que ela muda:

- o cutucão: texto que se soma ao padrão, `--nudge "<texto>"`;
- o critério de parada: quando a ronda pode ser desligada, `--criterion "<critério>"`;
- outro comportamento da ronda (o intervalo, por exemplo).

Exemplo: `ronda 30m aceite como pronto somente se o merge tiver sido feito para o develop` vira `ronda 30m --criterion "merge feito no develop"`, sem mudar o cutucão. Já `ronda se houver decisão a tomar, tome e registre` vira `ronda --nudge "Se houver decisão a tomar, tome e registre."`. Para tirar o texto ou o critério montados, passe `""`.

Depois de rodar, diga ao usuário em poucas linhas o que ficou montado (a CLI devolve intervalo, próximo cutucão, cutucão extra e critério).

## Desligar

`ronda --off` desliga. Se a ronda tem critério de parada, o tether não desliga e devolve uma pergunta sobre o critério. Leve a pergunta a sério: se o critério não foi cumprido, volte ao trabalho. Use `--off --force` só quando houver razão para parar mesmo assim, e diga qual é.
