# channels-terminal: o que uma fala de canal vira num Soul e num Codex (E2)

Medição de bancada, sem código de produto. Pergunta: quando a entrega do núcleo digita uma fala de canal no terminal de um Soul ou de um Codex, a fala vira turno do agente (submetida) ou fica na caixa de texto (presa)?

## O que o roteiro faz

`run.mjs` sobe um `tetherd` PRIVADO (home, pipe e host de painéis próprios; o tether real da pessoa nunca é tocado) e, por motor:

1. Um dono shell (processo Node numa guia shell, molde de `for-agents.codex.test.ts`) é dono da mesa `cena`.
2. O dono abre o agente pelo verbo `agents open`: a guia fica comandada, logo `held`, a condição para a entrega digitar.
   - Codex: `gpt-5.6-luna`, esforço baixo, `-a never -s read-only`, pasta de bancada nova e vazia.
   - Soul: ser de bancada novo e vazio, nascido pelos verbos do motor (`soul init -f`, `soul profiles create`), `--model cheap --effort low --strategy economy -P`.
3. A pessoa (cliente `app`, o moderator) cria um canal e junta o agente.
4. A pessoa fala quatro tipos de fala, `reps` vezes cada, todas com acentos e `·`, cada uma com uma etiqueta própria (`E2C01`...):
   - `short-1`: uma linha curta; `short-n`: três linhas curtas;
   - `long-1`: uma linha de ~295 caracteres; `long-n`: três linhas, ~290 caracteres.
5. Depois de cada fala espera o turno (ou 40 s) e lê a tela da guia. Veredito pela tela, não pela marca `turn` do daemon:
   - `submitted`: a etiqueta aparece acima de uma resposta do agente (`Worked for` ou resposta em marcador);
   - `stuck`: a etiqueta continua na caixa de texto, sem nada do agente depois dela;
   - `gone`: a etiqueta já rolou para fora da tela (ler a captura).
6. O aviso de entrada no canal (texto longo, `role: system`) é medido primeiro, como fala `entry`: chega sozinho depois do `join`.
7. Fala presa é "resgatada" com um Enter (o daemon vê um turno de verdade e o estado segue coerente; Ctrl+C foi tentado e deixou a entrega do daemon pendurada) e a medição segue na mesma guia. O registro diz se o Enter fez o agente responder.

## Limites conhecidos (22/11)

- Medido só no Codex. O Soul não foi rodado.
- Depois do Enter de resgate as falas seguintes ficaram `queued` na rodada em que isso foi tentado: para uma tabela limpa, use uma guia por fala (ou só as primeiras falas de uma guia ociosa, que foi o desenho da rodada limpa).
- Resultado e leitura: `.tmp/tether-agents/onda-3/e2/relatorio.md`.

## Rodar

```
node test/manual/channels-terminal/run.mjs <codex|soul> [reps] [pasta-de-evidencia]
```

Um motor por vez. O script limpa do ambiente `CLAUDE*`, `TETHER_*`, `CODEX_HOME` e `NODE_TEST_CONTEXT`, e ao fim derruba só os processos que subiu (por PID e identidade, `test/kill.ts`). Evidência: `run.log`, `results.json` e uma captura de tela por fala (`screen-NN-<tipo>.txt`).

Variáveis: `E2_WORKTREE` (o worktree), `E2_SOUL_BIN` (o bin do soul-cli).
