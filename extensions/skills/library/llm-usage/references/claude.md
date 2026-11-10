# Claude Code

## Como obter

```bash
node "$TETHER_CLI" usage          # retrato em texto
node "$TETHER_CLI" usage --json   # os mesmos campos, para raciocinar sobre eles
node "$TETHER_CLI" usage --fresh  # ignora o cache e consulta agora
```

`TETHER_CLI` é definida pelo tether em todo painel; o comando funciona de qualquer shell e de qualquer pasta. A fonte é o uso oficial do plano da Anthropic, lido com o login do Claude Code da própria máquina. A ferramenta se basta e não mostra o login.

A leitura oficial só aceita cerca de uma consulta a cada 5 minutos. Por isso a ferramenta guarda a última leitura por 5 minutos (`source: "cache"`, com `ageSec`); se a fonte pedir intervalo ou cair, mostra a última leitura avisando a idade. `--fresh` só quando de fato precisar de dado do segundo.

Saídas: `0` ok · `3` sem login ou login expirado (peça para abrir o Claude Code e entrar de novo) · `4` erro de rede ou HTTP · `5` o formato da resposta mudou (não adivinhe valores).

## Como interpretar

Cada linha de limite diz: o nome da janela, quanto já foi **usado** (percentual), quando **renova** (data e quanto falta), e às vezes severidade ou "inativo".

- **Janela de 5 h**: limite de curto prazo; renova a partir da primeira mensagem dentro dela.
- **Semana**: limite semanal; "todos os modelos" é o total, uma linha com nome de modelo é o limite semanal só desse modelo.
- **Teto** (`teto: até X% da semana; já usou Y%`): um modelo ou recurso tem uma fatia máxima da semana, e Y é quanto dessa semana ele já consumiu.
- **Renovação**: o percentual volta a zero no horário indicado. "já renovou" significa que o horário passou e a leitura é anterior; leia de novo com `--fresh`.
- **Créditos de uso extra**: gasto além do plano, quando ligado: teto mensal, quanto foi usado e a moeda. Desligado significa que, ao esgotar um limite, o uso para até a renovação.
- **Campos novos**: chaves que a ferramenta não conhece aparecem em "Campos novos observados". A API está sempre evoluindo; relate-os como apareceram, sem inventar significado.

### Dado ausente ou vazio

Uma janela que vem sem valor ("janelas não computadas pelo fornecedor agora"), um campo que some ou um limite que aparece do nada costuma ser período de ajuste da API da Anthropic, não falha sua nem da ferramenta. Relate como circunstância observada ("hoje a janela de 5 h não está sendo computada"), nunca como erro, e não suponha que a regra de ontem continua valendo.

### Honestidade sobre o dado

- Nunca traga número de memória: todo percentual, horário e teto vem da leitura de agora; leitura em cache diz a idade.
- Qualquer custo em dólar que apareça é **equivalente de API**, uma régua de comparação, não cobrança.
