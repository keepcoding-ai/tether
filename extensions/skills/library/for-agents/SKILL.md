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

| Verbo | O que faz |
|---|---|
| `list` | Lista o que é seu: mesas, guias e o que você pode fazer em cada uma. |
| `open` | Abre uma guia nova (um agente de um motor, ou um shell) numa das suas mesas. Nasce comandada por você e nunca toma o primeiro plano da pessoa. `brief` vai ao agente como primeira mensagem. |
| `send` | Manda uma mensagem ao agente de uma guia, como dono dela; não toca no que a pessoa digita. Com a guia nas mãos da pessoa, espera (`queued`). `raw: true` digita como uma pessoa, para corrigir um agente no meio do turno. |
| `interrupt` | Interrompe o que o agente da guia está fazendo (Esc; Ctrl+C num shell). Recusa com `not-busy` se ele está ocioso. |
| `read-screen` | Lê a tela da guia como texto (também guia que você só vê). `state` diz: busy, idle, permission, question, dialog ou unknown. |
| `last-answer` | Lê a última resposta do agente da guia. Ler limpa a atenção que veio a você. |
| `answer` | Responde um pedido de permissão ou pergunta que o agente da guia mostra agora: yes, always, no ou o número da opção. Lê a tela antes e recusa com `no-request` se não há cartão. |
| `command` | Roda um comando da CLI do agente (`compact`, `clear`, …) numa guia sua. Pode responder `deferred`; recusa com `busy` se o motor não aceita no meio do turno. |
| `type` | Digita texto numa guia de terminal como uma pessoa, sem Enter (use `keys` para o Enter). |
| `keys` | Aperta teclas nomeadas em ordem (enter, esc, tab, up, down, ctrl+c, …). Tecla desconhecida faz a chamada não enviar nenhuma. |
| `close` | Fecha uma guia sua: `forget` (padrão) para e remove; `stop` só para o processo. Recusa fechar a sua própria. |
| `restart` | Reinicia o agente da guia retomando a sessão; `fresh: true` começa sessão nova. Recusa reiniciar a sua própria. |
| `give` | Dá uma guia das suas mesas a outro agente (por id ou nome), ou a si mesmo com `to: self`; quem recebe a comanda e você só vê. A pessoa pode retomá-la quando quiser. |
| `revoke` | Retoma uma guia que você deu: volta ao seu comando. Recusa com `not-given` se a guia não tem dono próprio. |

Cada verbo diz o porquê quando recusa: leia a recusa antes de insistir.
