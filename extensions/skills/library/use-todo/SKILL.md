---
name: use-todo
argument-hint: "[arquivo] [--focus] [--pad]"
description: >-
  Adota um arquivo markdown como o todo COMPARTILHADO com o usuário: o quadro em que ele vê, de relance, o que estou fazendo, o que depende dele e o que ficou para ele. Mantenho o arquivo vivo a cada avanço; ele responde por escrito dentro do arquivo, e eu leio, aplico e limpo as respostas. Use quando o usuário chamar esta skill (com ou sem arquivo, com --focus ou --pad) ou pedir 'usa esse arquivo como todo', 'mantém a lista atualizada pra eu acompanhar', 'anota no arquivo o que precisa de mim'. Também quando ele pedir para VER o todo ('me mostra o todo', 'abre o todo', 'cadê a lista'): trago a nota para a frente.
---

# use-todo

Uso: `use-todo [arquivo] [--focus] [--pad]`. Argumentos desta chamada: `$ARGUMENTS`

O arquivo de todo é o quadro do usuário. Ele volta ao chat e, sem me perguntar nada, vê de relance:
1. o que estou fazendo;
2. o que depende dele e se perdeu na conversa;
3. o que ficou para ele, não me afeta e se perdeu na conversa.

Toda decisão sobre o arquivo segue essa régua.

## O ambiente

Quando o ambiente tem `TETHER_TAB_URL`, estou num painel do tether e também tenho:
- `TETHER_OPEN_CWD`: a pasta em que este painel foi aberto. É fixa, não acompanha `cd`; nunca uso o diretório atual no lugar dela.
- `TETHER_CLI`: o script da CLI do tether. Rodo sempre `node "$TETHER_CLI" <comando>`, porque `tether` pode não estar no PATH.

Sem `TETHER_TAB_URL`, não há prancheta nem foco: o todo é só o arquivo, e no lugar de mostrar a nota eu digo o caminho dela.

## O que cada chamada faz

| chamada | o que faço |
|---|---|
| sem argumentos, sem todo nesta conversa | crio `$TETHER_OPEN_CWD/.tether/notes/AAAA-MM-DD-<assunto>.md` com o esqueleto e a levo para a prancheta do painel (`focus --pad`) |
| sem argumentos, com todo | nada a fazer: digo numa linha qual é o todo |
| `--focus` | trago o todo para a frente, onde ele estiver: `node "$TETHER_CLI" focus "<arquivo>"` |
| `--pad` | levo o todo para a prancheta do painel e o foco: `node "$TETHER_CLI" focus "<arquivo>" --pad`. Se ele estava aberto na mesa, sai da mesa e vai para a prancheta |
| `<arquivo>` | esse arquivo vira o todo, onde ele mora (inclusive fora do projeto). O todo anterior fica como está e só deixa de ser mantido. Se o arquivo não existe, crio com o esqueleto; se existe, respeito o formato dele e preencho |

Os argumentos se combinam: `use-todo d:/my-note.md --pad` troca o todo para esse arquivo, cria ou preenche, e o leva para a prancheta do painel com foco.

Detalhes:
- **Nome do arquivo novo:** data de hoje e assunto curto em kebab-case, do que estamos fazendo. Se o nome existe, acrescento `-2`, `-3`… Crio a pasta se faltar. Fora do tether, sem arquivo dado, pergunto qual arquivo usar, sem inventar caminho.
- **Troca:** digo numa linha "troquei o todo: `<antigo>` → `<novo>`". Se o antigo tinha itens abertos, pergunto se levo para o novo.
- **Caminho para a CLI:** passo o caminho absoluto do arquivo, com `/`. `focus` exige que o arquivo já exista: crio antes, foco depois.
- **Depois de mostrar,** não repito o conteúdo no chat; no máximo uma linha dizendo que abri.

## Ao adotar

1. **Leio o arquivo.** Se ele já tem um formato (cabeçalho, estilo de checkbox), preencho dentro dele. Se não existe, crio com o esqueleto.
2. **Guia do agente:** no tether, logo abaixo do título fica a linha `> Guia do agente: <saída de node "$TETHER_CLI" link>`. Clicar nela traz o meu painel para a frente. Se a linha existe com outro link, troco pelo meu.
3. **Preencho com o estado real** do trabalho, não com o que imagino que esteja feito.
4. Digo em uma linha que adotei o arquivo e mostro a nota (pela tabela acima).

## Esqueleto

```markdown
# Todo: <assunto>

> Guia do agente: tether://tab/<id>

> ## 🚨 PRECISO DE VOCÊ
> _(nada no momento)_

## Plano

- [x] Item feito (com a prova ou o commit)
- [ ] ▶ Item em execução: o que está rodando agora
- [ ] Próximo item
- [ ] Trilha paralela que não trava o plano

## Pendências suas

- _(nada no momento)_
```

São três caixas, nesta ordem:
1. **🚨 PRECISO DE VOCÊ**, no topo e sempre presente: o que me trava e depende do usuário. Vazia, mostra `_(nada no momento)_`.
2. **Plano**: o meu trabalho. `[x]` no que foi feito, `▶` no que está em execução, e a fila em seguida. Trilha paralela também é item do plano.
3. **Pendências suas**: o que é do usuário e não me trava (ex.: reiniciar um serviço quando for conveniente, validar no uso algo que já está pronto).

O critério entre a caixa 1 e a 3 é um só: **isto me trava?** Se sem a resposta ou o ato dele eu não consigo seguir algum item, vai na 🚨. Se não, vai em Pendências suas. Nunca ponho na 🚨 o que não me trava, e nunca deixo uma tarefa dele em aberto fora do arquivo.

## As regras

1. **Atualizo a cada avanço**, no mesmo passo em que ele acontece: entrega provada → `[x]` com a prova; item começou → `▶`; item novo combinado → entra no plano. O arquivo nunca fica atrás do chat.
2. **Quando dependo do usuário, faço as duas coisas:**
   - no chat, um bloco chamativo: uma citação com `## 🚨 PRECISO DE VOCÊ` e itens numerados, cada um com a pergunta fechada e a minha recomendação;
   - no arquivo, o mesmo item na 🚨, curto, com a forma de responder ("responda 'pode'", "sim ou não").
   Só subo o que é de fato do usuário; decisão técnica eu tomo.
3. **O usuário responde dentro do arquivo**, em linhas que começam com `=>`, embaixo do item. Quando ele avisar que respondeu (ou eu notar um `=>` novo):
   - leio o arquivo inteiro;
   - aplico cada resposta: vira item do plano, fecha um item ou muda o que estou fazendo;
   - limpo a 🚨: tiro o item respondido e a resposta; se não sobrou nada, volta `_(nada no momento)_`;
   - confirmo no chat, item por item, o que fiz com cada resposta.
4. **Item que deixou de ser do usuário sai do arquivo.**
5. **Antes de dizer no chat que anotei algo,** confiro que a linha está mesmo no arquivo.
6. **Edito com cuidado: o arquivo é do usuário também.**
   - Releio o arquivo antes de cada escrita: ele pode ter mexido, renomeado ou mudado de lugar (se o caminho sumir, procuro na mesma pasta e sigo o nome novo).
   - Nunca sobrescrevo o arquivo inteiro com uma versão de memória: faço edições pontuais, seção por seção, preservando o que ele escreveu.
   - Escrevo caminhos com `/`. Um `\` escrito por script vira escape quebrado (`\a`, `\f`); confiro o resultado.

## Encerrar

Quando o plano fecha, ou o usuário pede para parar: deixo o arquivo no estado final (tudo `[x]`, ou o que ficou pendente e por quê) e aviso em uma linha.
