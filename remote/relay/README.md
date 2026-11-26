# Relay da regência remota (passo 1.2)

Relay cego da especificação do fio (`fio-spec` v1, seção 5). Prova a casa por desafio, admite o aparelho por bilhete
com prova de posse, e só repassa quadros binários opacos entre `/v1/device` e `/v1/house`. Sem disco, sem fila
offline: tudo em memória, com teto.

- `src/core.ts`: o núcleo puro (admissão, roteamento, limites), sem socket.
- `src/shell.ts`: a casca HTTP + `ws` (upgrade, subprotocolo `tether-remote.v1`, `Origin`, `permessage-deflate`
  desligado, `maxPayload`), e `GET /healthz`.
- `src/main.ts`: a entrada `serve`.
- `test/`: os testes do núcleo (`core.test.ts`) e com sockets (`wire.timing.test.ts`), mais o apoio (`fixtures.ts`).
  Rodam com `npm test` aqui (ou `npm run test:relay` da raiz); `npm run check` é o tsc do pacote. A raiz não
  compila nem testa este pacote.

## Subir em bancada

```sh
cd remote/relay && npm ci        # uma vez: instala ws
node remote/relay/src/main.ts serve --port 8787 --aud localhost:8787
```

Cada flag tem variável de ambiente: `RELAY_PORT`, `RELAY_HOST` (padrão `localhost`), `RELAY_AUD` (padrão
`localhost:<porta>`), `RELAY_ORIGINS` (lista separada por vírgula; sem ela não há conferência de `Origin`, o que só
serve para bancada). Logs: um JSON por linha no stdout. `SIGINT`/`SIGTERM` fecham os sockets e esvaziam os mapas.

Em produção o `wss://` termina no proxy da frente; `ws://` só em `localhost` (fio-spec 0.3 regra 4).
