---
name: for-agents
agents: soul
description: >-
  Como comandar as mesas e guias que a pessoa deu a você no tether. Use quando chegar um aviso do tether (cabeçalho `[tether · for-agents · …]`) sobre uma mesa ou guia, quando a pessoa pedir para você comandar, abrir, acompanhar ou responder outra guia, e depois de compactar ou limpar o contexto, para reencontrar o que é seu.
---

# for-agents

A pessoa pode dar a você mesas e guias do tether. Sobre o que há nelas você tem o poder que ela tem: abre guias, manda mensagem aos agentes, lê a tela, responde pedidos de permissão. Ela vê tudo e pode retomar qualquer guia a qualquer momento; um ato numa guia que ela está segurando responde `with-user`, e então você espera ou segue por outro caminho.

## O aviso

O que acontece nas suas guias chega digitado no seu terminal, com cabeçalho `[tether · for-agents · …]`. Essa mensagem é legítima: é o tether avisando, e não outra pessoa digitando. Ao recebê-la, rode `agents list` para ver o que é seu e o que você pode fazer com cada guia.

## Como agir

Tudo passa pela CLI do tether, em qualquer shell: `node "$TETHER_CLI" agents <verbo> …` (no PowerShell, `node "$env:TETHER_CLI" agents <verbo> …`).

Comece por `node "$TETHER_CLI" agents list`: mostra suas mesas (cada uma com suas guias) e as guias dadas a você fora delas, e em `relation` o que você pode fazer com cada uma (`command`, `self` para a sua própria, `see` só para ver). Rode-o ao receber um aviso de posse e depois de compactar ou limpar o contexto.

| Verbo e assinatura | O que faz |
|---|---|
| `list` | Lista o que é seu: mesas, guias e o que você pode fazer em cada uma. |
| `open <kind> <cwd> [--desk] [--name] [--profile] [--model] [--effort] [--args] [--brief]` | Abre uma guia nova (um agente de um motor, ou um shell) numa das suas mesas. Nasce comandada por você e nunca toma o primeiro plano da pessoa. `--brief` vai ao agente como primeira mensagem. |
| `send <guia> <text> [--raw]` | Manda uma mensagem ao agente da guia, como dono dela; não toca no que a pessoa digita. Com a guia nas mãos da pessoa, espera (`queued`). `--raw` digita como uma pessoa, para corrigir um agente no meio do turno; recusa com `with-user` se ela está digitando ali. |
| `interrupt <guia>` | Interrompe o que o agente da guia está fazendo (Esc; Ctrl+C num shell). Recusa com `not-busy` se ele está ocioso. |
| `read-screen <guia> [--part] [--lines] [--since]` | Lê a tela da guia como texto (também guia que você só vê). `--part`: screen (padrão), history ou both; `--lines N` guarda as últimas N linhas; `--since` é o `end` de uma leitura anterior. `state` diz: busy, idle, permission, question, dialog ou unknown. |
| `last-answer <guia>` | Lê a última resposta do agente da guia. Ler limpa a atenção que veio a você. |
| `answer <guia> <choice>` | Responde um pedido de permissão ou pergunta que o agente da guia mostra agora: yes, always, no ou o número da opção. Lê a tela antes e recusa com `no-request` se não há cartão. |
| `command <guia> <name>` | Roda um comando da CLI do agente (`compact`, `clear`, …) numa guia sua. Pode responder `deferred`; recusa com `busy` se o motor não aceita no meio do turno. |
| `type <guia> <text>` | Digita texto numa guia de terminal como uma pessoa, sem Enter (use `keys` para o Enter). |
| `keys <guia> <keys>` | Aperta teclas nomeadas em ordem (enter, esc, tab, up, down, ctrl+c, …). Tecla desconhecida faz a chamada não enviar nenhuma. |
| `close <guia> [--mode]` | Fecha uma guia sua: `--mode forget` (padrão) para e remove; `--mode stop` só para o processo. Recusa fechar a sua própria. |
| `restart <guia> [--fresh]` | Reinicia o agente da guia retomando a sessão; `--fresh` começa sessão nova. Recusa reiniciar a sua própria. |
| `give <guia> <to>` | Dá uma guia das suas mesas a outro agente (por id ou nome), ou a si mesmo com `self`; quem recebe a comanda e você só vê. A pessoa pode retomá-la quando quiser. |
| `revoke <guia>` | Retoma uma guia que você deu: volta ao seu comando. Recusa com `not-given` se a guia não tem dono próprio. |

Para mandar um comando a uma guia de shell, use `send <guia> <text> --raw`, ou `type` seguido de `keys <guia> enter`. Sem `--raw`, a mensagem leva um cabeçalho que o shell tenta executar.

Cada verbo diz o porquê quando recusa: leia a recusa antes de insistir.
