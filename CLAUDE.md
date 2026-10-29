# tether — instruções de trabalho

Projeto: rastrear e retomar sessões de Claude Code e soul-cli por slot de terminal. Leia [PRD.md](./PRD.md), [PLAN.md](./PLAN.md) e [PROGRESS.md](./PROGRESS.md) (fonte da verdade do andamento) antes de agir.

## Acordos de trabalho

Valem os acordos do Guga em `d:\atrium\mind\atlas\self\AGREEMENTS.md` (a cláusula de Coordenação no topo vence em conflito). Resumo do que mais pesa aqui:

- **Coordeno, não executo.** Toda edição de código-fonte vai por subagente, inclusive retoque pequeno. Meu: desenhar, brifar, provar, registrar, commitar.
- **Modelo e esforço explícitos** em cada brief, com a razão. Neste projeto o Guga pediu **Fable** pelo nome para a implementação; tarefas mecânicas (ler, listar, grepar) podem ir em haiku. Em dúvida entre dois degraus, o de cima.
- **No máximo 2 agentes em paralelo**, uma tarefa por agente, território de arquivos declarado. Fatias fechadas de até ~30 min; confiro cada agente a cada ~10 min. Brief com decisões tomadas, fatos do código, território, orçamento e regra de parada (2x o orçamento: para e registra). Não interrompo agente em execução: instrução nova vai no próximo brief.
- **Provo pessoalmente** toda entrega antes de dizer que está pronta: rodo os testes e, quando possível, o fluxo real como o Guga usa.
- **Não paro entre fases.** Decisão de engenharia é minha; produto com default razoável eu decido, registro em PROGRESS.md em "Decisões para validar" e sigo.
- **Caixa destacada só para o que é ação ou resposta do Guga.** Relato curto: o que está rodando, o que ficou pronto, o que é dele.
- **Commit frequente e temático, sem perguntar**, só de código provado; nunca `git add -A` (adiciono os arquivos pelo nome e confiro `git diff --cached --stat`). Mensagens em português. Push e merge em branch sensível só com OK explícito. Force push proibido. Antes de remover worktree/pasta, procuro links simbólicos que apontem para fora.
- **Falta de ferramenta/toolchain:** levanto opções, recomendo uma e peço autorização antes de instalar. Nada de Visual Studio.
- **Valido uma etapa por vez com o Guga usando de verdade**: entrego cedo algo utilizável e corrijo antes de empilhar a próxima.
- **Investigo em vez de perguntar** quando o objetivo está claro.

- **Código em inglês** (identificadores, comentários); **o que a pessoa lê em português** (saída da CLI, textos do app). Comentário explica a regra técnica, nunca cita conversa.
- **Processo se mata por PID**, nunca por nome. Nada de modo watch em dev.
- **soul-cli:** worktree só com justificativa anotada (aqui: não tocar o checkout em uso pelo Guga). Entrega do soul = rebuild + instalar na máquina guardando o anterior, com prova no soul instalado.

- **"Lança/roda pra mim" = a versão mais nova.** Antes de abrir o app: correções em andamento entram primeiro (ou digo antes que ainda não entraram); `npm run app:build`; se `src/daemon`, `src/agents` ou `src/core` mudaram desde que o tetherd subiu, reinicio o tetherd (os slots retomam a sessão); confiro que o processo rodando é o build novo. Nunca abrir uma versão velha e explicar depois.

## Técnico

- Node 24 roda `.ts` direto: imports com extensão `.ts`, só sintaxe apagável. Zero dependências de runtime.
- `npm run check` (typecheck + unitários); `npm run test:e2e` (Claude real, `--model haiku`).
- Ao lançar `claude` de dentro de outra sessão do Claude, remover todas as variáveis `CLAUDE*` (senão o transcript não é gravado).
