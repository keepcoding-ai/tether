---
name: llm-usage
description: Obter e interpretar os parâmetros de uso de LLM da plataforma do agente (limites, janelas, renovação, créditos). Use quando precisar saber quanto resta do que a plataforma deixa usar, ou quando o assunto for limite, consumo ou custo de LLM.
---

# llm-usage

Esta skill ensina uma coisa só: **obter e interpretar** os parâmetros de uso de LLM da plataforma em que o agente roda. O que fazer com a leitura (planejar, frear, negociar, prestar contas) é do agente e não faz parte daqui.

## Qual é a minha plataforma

Está na variável de ambiente `TETHER_AGENT` (por exemplo `claude`). Leia a parte correspondente:

| `TETHER_AGENT` | Leia |
|---|---|
| `claude` | [references/claude.md](references/claude.md) |

Se `TETHER_AGENT` não existir, ou nomear uma plataforma sem parte nesta tabela, diga que não sabe a plataforma ou que ainda não há leitura para ela. Não invente número nem tente adivinhar por outro caminho.

## Regras que valem em qualquer plataforma

- Tudo que é concreto (nomes de janelas, modelos, planos, percentuais, horários) vem da leitura feita na hora. Nunca traga número de memória nem de leitura antiga sem dizer a idade dela.
- O fornecedor muda as regras com frequência. Dado ausente, vazio ou novo é circunstância observada, não falha: relate como observado.
- A ferramenta nunca mostra o login. Não tente descobri-lo nem o repita.

## Como esta skill cresce

Cada plataforma entra como uma nova parte em `references/` (e uma linha na tabela acima), com o seu "como obter" e o seu "como interpretar". As próximas (o backbone do soul, o codex) entram assim, depois; nenhuma está escrita ainda.
