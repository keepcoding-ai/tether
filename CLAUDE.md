# tether — instruções de trabalho

Projeto: rastrear e retomar sessões de Claude Code e soul-cli por slot de terminal. Leia [PRD.md](./PRD.md), [PLAN.md](./PLAN.md) e [PROGRESS.md](./PROGRESS.md) (fonte da verdade do andamento) antes de agir.

## Acordos de trabalho

Valem os acordos do Guga em `d:\atrium\mind\atlas\self\AGREEMENTS.md` (a cláusula de Coordenação no topo vence em conflito). Resumo do que mais pesa aqui:

- **Coordeno, não executo.** Toda edição de código-fonte vai por subagente, inclusive retoque pequeno. Meu: desenhar, brifar, provar, registrar, commitar.
- **Modelo e esforço explícitos** em cada brief, com a razão. Neste projeto o Guga pediu **Fable** pelo nome para a implementação; tarefas mecânicas (ler, listar, grepar) podem ir em haiku. Em dúvida entre dois degraus, o de cima.
- **Uma tarefa por agente**, em paralelo, com território de arquivos declarado; fatias que voltem em menos de ~1h; olho cada agente a cada ~15 min.
- **Provo pessoalmente** toda entrega antes de dizer que está pronta: rodo os testes e, quando possível, o fluxo real como o Guga usa.
- **Não paro entre fases.** Decisão de engenharia é minha; produto com default razoável eu decido, registro em PROGRESS.md em "Decisões para validar" e sigo.
- **Caixa destacada só para o que é ação ou resposta do Guga.** Relato curto: o que está rodando, o que ficou pronto, o que é dele.
- **Commit frequente e temático, sem perguntar.** Force push proibido. Antes de remover worktree/pasta, procuro links simbólicos que apontem para fora.
- **Falta de ferramenta/toolchain:** levanto opções, recomendo uma e peço autorização antes de instalar. Nada de Visual Studio.
- **Valido uma etapa por vez com o Guga usando de verdade**: entrego cedo algo utilizável e corrijo antes de empilhar a próxima.
- **Investigo em vez de perguntar** quando o objetivo está claro.

## Técnico

- Node 24 roda `.ts` direto: imports com extensão `.ts`, só sintaxe apagável. Zero dependências de runtime.
- `npm run check` (typecheck + unitários); `npm run test:e2e` (Claude real, `--model haiku`).
- Ao lançar `claude` de dentro de outra sessão do Claude, remover todas as variáveis `CLAUDE*` (senão o transcript não é gravado).
