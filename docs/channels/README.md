# Prévia de interface dos canais

Prévia de interface dos canais do tether, aprovada pelo PO em 23/11/2026. É a referência da experiência planejada para o Marco 3 da onda 3 (o canal na tela).

## Arquivos

- `channels-estrutura.html`: a estrutura em wireframe, com as bifurcações que ela levantou.
- `channels-preview.html`: o visual em claro e escuro (botão no canto da página), com a guia do canal, a lista de membros, os menus, a cápsula de mesas, o seletor "Abrir canal…" e os estados de calado, encerrado e dono ausente. É o visual aprovado.

## Como abrir

Abra os arquivos `.html` direto no navegador. Não há build nem servidor.

## Decisões de interface que a prévia fixa

- P1: só a fala dirigida ao usuário acende o laranja; fala para todos deixa a marca quieta de "há novas".
- P2: a lista de canais sem guia aberta mora no seletor "Abrir canal…" e em "Painéis da mesa"; nenhum gestor novo.
- P3: um canal, uma guia; abrir de novo foca a guia existente, na mesa em que estiver.
- P4: o canal da mesa segue a mesa, não o dono; sem dono fica encerrado e legível, e com dono de novo reabre sozinho, com o histórico.
- P5: o membro que veio da mesa pode ser tirado como qualquer outro, e fica fora até ser juntado de novo ou sair e voltar à mesa.
- P6: canal encerrado fica guardado e legível, e o dono ou o moderador pode reabri-lo; apagar de vez fica fora desta onda.
- P7: canal cujo dono deixou de existir passa ao usuário (o canal da mesa segue a P4).
- P8: o destinatário é endereço, não segredo; todos os membros ouvem tudo, "para X" só marca a quem a fala se dirige.
- P9: juntar, tirar, calar, devolver a voz, encerrar e reabrir viram linha de sistema na conversa, e o agente atingido recebe o aviso.
- P10: nomes de exemplo neutros (guias `claude · conferente`, `soul · bancada`, `codex · conferência`; dona Atrium; mesa `obra`).
- P11: na barra de topo da guia do canal, "Juntar agente…" aparece uma vez só, como item com texto e accent.
- P12: na tela, dono, membro, moderador e calado, com `#` antes do nome do canal; no código, `owner`, `member`, `moderator` e `muted`.

## Notas

`channels-estrutura.html` é o wireframe anterior ao visual; onde os dois diferirem, vale o `channels-preview.html`.
