# Estudo: aparência do terminal no tether (cores semânticas e fonte)

Escopo: as 16 cores ANSI + primeiro plano, cursor e seleção (por claro/escuro) e as características da fonte. Fundo e superfície do painel ficam fora.

Prévia para escolher: [`terminal-theme-preview.html`](./terminal-theme-preview.html) (abrir no navegador; tem seletor de fonte, peso, negrito, tamanho, altura de linha e o contraste WCAG de cada cor medido contra o fundo real do tether).

> Nota de método: o estudo foi escrito sem acesso à web; em 2026-10-30 cada hex e cada licença foram conferidos contra a fonte oficial e corrigidos aqui e na prévia (ver "Verificação"). A implementação vive em `app/shared/terminal-theme.ts` (registro, com a URL de origem em comentário por preset), `app/renderer/terminal-theme.ts` (diálogo) e `app/renderer/fonts/` (woff2 + licenças).

## Verificação contra as fontes oficiais (2026-10-30)

| Preset | Fonte conferida | Correções em relação ao estudo original |
|---|---|---|
| VS Code | `terminalColorRegistry.ts` (`ansiColorMap`) | No claro, os brilhantes vermelho/azul/magenta/ciano são `#f14c4c`/`#3b8eea`/`#d670d6`/`#29b8db` (iguais ao escuro); o estudo trazia os valores de `hcLight` (`#cd3131`/`#0451a5`/`#bc05bc`/`#0598bc`). |
| GitHub | `@primer/primitives` 7.10.0 `colors/{light,dark}.json` → `ansi`, mais o override de `fg.default` do tema (`#1f2328`/`#e6edf3`) | Nenhuma nos 16 + fg. Seleção passou a ser `accent.muted` (rgba 0,4) de cada tema. |
| Ubuntu / Yaru | `gnome-terminal` `src/profile-editor.cc`, paleta "GNOME" (comentada "Based on GNOME 3.32 palette") e esquemas "GNOME light/dark" | Nenhuma nos 16. fg claro `#171421`, escuro `#d0cfcc`. Licença do arquivo: GPL-3.0-or-later; os 16 valores entram como dados. |
| Catppuccin | `catppuccin/palette` `palette.json` → `ansiColors` | Os brilhantes são cores próprias (ex.: Latte vermelho brilhante `#de293e`, Mocha verde brilhante `#89d88b`), não cópias dos normais; no Mocha o estudo tinha branco/branco brilhante trocados (certo: `#a6adc8` / `#bac2de`). Cursor = rosewater. |
| One | `atom/one-{light,dark}-syntax` `colors.less` | Nenhuma nos hues. O Atom não define tabela ANSI: preto/branco/brilhantes seguem os ports comuns. |
| Tokyo Night | `extras/alacritty/tokyonight_{night,day}.toml` (gerados da paleta: brilhantes = `Util.brighten`) | Night: brilhantes são versões clareadas (`#ff899d`, `#9fe044`, `#faba4a`, `#8db0ff`, `#c7a9ff`, `#a4daff`). Day: preto é `#b4b5b9` (o estudo dizia `#e9e9ed`) e os brilhantes também são próprios. Com `minimumContrastRatio` 4.5 o Day lê bem; foi adotado como par claro. |

Fontes: **Ubuntu Sans Mono é Ubuntu Font Licence 1.0, não OFL** (o repositório `canonical/Ubuntu-Sans-Mono-fonts` e a Fontsource confirmam; a UFL permite "bundled, embedded, and redistributed" com a licença junto, e o nome fica intacto porque a fonte não é modificada). JetBrains Mono 2.304, IBM Plex Mono (variável, `@ibm/plex-mono-variable` 1.0.0) e Cascadia Mono 2407.24 são OFL 1.1. Tamanhos medidos dos woff2 embarcados (variáveis, cobertura completa, sem subset — não havia `fonttools` na máquina e instalar toolchain pede autorização): JetBrains Mono 114 KB, Ubuntu Sans Mono 111 KB, IBM Plex Mono 83 KB, Cascadia Mono 210 KB (519 KB no total).

## Hoje no tether

- `app/renderer/panel.ts`: `TERMINAL_THEME` (escuro = cores brilhantes do Dark+ usadas também como normais, amarelo `#f5f543`; claro = Light+ com amarelo/ciano escurecidos à mão).
- Fonte: `"Cascadia Mono", "Cascadia Code", Consolas`, 13px, sem `fontWeight`, sem `lineHeight` (=1.0), sem `minimumContrastRatio`, renderizador DOM (sem addon WebGL).
- Por que parece "pesado": Cascadia em peso 400 tem traço grosso e x-height alto; linha 1.0 cola as linhas; no escuro as cores normais são as **brilhantes** (`#f5f543`, `#23d18b`) — tudo grita igual.

## 1. Existe um padrão de qualidade?

Não existe norma formal, mas há um padrão de fato, e o VS Code é a referência (o xterm.js é dele):

| Item | VS Code (terminal integrado) |
|---|---|
| Cores ANSI | `terminal.ansi*` fixas no código, uma tabela para claro, outra para escuro/alto contraste. Os temas *Modern* (Dark Modern / Light Modern) mudam fundo e primeiro plano (`#cccccc` / `#3b3b3b`) e herdam as 16 cores. [fonte: terminalColorRegistry.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/common/terminalColorRegistry.ts) |
| Contraste | `terminal.integrated.minimumContrastRatio` = **4.5** (WCAG AA). O xterm.js ajusta a luminosidade de cada célula cuja cor não atinge 4,5:1 contra o fundo. É por isso que o VS Code pode ter amarelo `#949800` no tema claro sem ficar ilegível. [docs](https://code.visualstudio.com/docs/terminal/appearance#_minimum-contrast-ratio) |
| Fonte | herda `editor.fontFamily` (Consolas no Windows), `fontSize` 14 (12 no macOS), `lineHeight` 1, `letterSpacing` 0, `fontWeight` `normal`, `fontWeightBold` `bold`, ligaduras desligadas. [docs](https://code.visualstudio.com/docs/terminal/appearance) |
| Renderização | `gpuAcceleration: auto` → addon WebGL; caixa (box drawing) e blocos são desenhados pelo próprio xterm (`customGlyphs`), não pela fonte, então as linhas emendam perfeitamente. |

- **JetBrains** (IntelliJ, Fleet): terminal usa a fonte do editor (JetBrains Mono, 13px, linha 1.2) e o esquema de cores do IDE define as 16 cores "Console Colors" por tema; o New UI usa as paletas Light/Dark ("Islands") com amarelo escurecido no claro. [docs](https://www.jetbrains.com/help/idea/settings-tools-terminal.html)
- **Zed**: tema define `terminal.ansi.*`; padrão One Light/One Dark; fonte Zed Mono (Iosevka); `minimum_contrast` 45 (escala APCA). [docs](https://zed.dev/docs/configuring-zed#terminal)
- **Warp**: temas próprios, fonte Hack, linha ~1.2.
- **WCAG**: texto normal pede 4,5:1 ([SC 1.4.3](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html)). Num fundo branco, quase todas as paletas falham em **amarelo**, **branco/cinza claro**, **ciano** e às vezes **verde**. É o problema clássico: as paletas ANSI foram feitas para fundo preto.

**Conclusão:** o "bem otimizado" do VS Code é a soma de (a) paleta separada para claro, (b) `minimumContrastRatio` 4.5 como rede de segurança, (c) renderização WebGL com glifos de caixa próprios. O tether tem só (a). Ligar (b) é uma linha e resolve a maioria dos problemas de contraste de qualquer preset.

## 2. Presets candidatos (claro/escuro)

Valores completos (hex de todas as 16 cores, fg, seleção) estão no array `PRESETS` da prévia, que serve como fonte única. Contrastes medidos contra os fundos do tether (`#fbfbfd` / `#1b1b1f`).

| Preset | Licença | Avaliação honesta |
|---|---|---|
| **VS Code Light+/Dark+ (Modern)** | MIT ([vscode](https://github.com/microsoft/vscode)) | Referência. Escuro: cores normais mais sóbrias que as que o tether usa hoje. Claro: amarelo `#949800`, ciano `#0598bc`, verde brilhante `#14ce14` e branco brilhante `#a5a5a5` falham — **depende** de `minimumContrastRatio` 4.5. |
| **Ubuntu / Yaru (GNOME)** | GPL-3.0-or-later (gnome-terminal `profile-editor.cc`; os 16 valores usados como dados) | A "cara do Ubuntu" no escuro. No claro: amarelo vira marrom `#a2734c` (≈4:1), brilhantes `#33d17a`, `#e9ad0c`, `#33c7de` falham. Bom no escuro, médio no claro. |
| **GitHub Light/Dark** | MIT ([github-vscode-theme](https://github.com/primer/github-vscode-theme)) | **Melhor contraste no claro** de toda a lista (amarelo `#4d2d00`, verde `#116329`). Escuro sóbrio. Única falha relevante: `brightWhite`/`white` (por desenho). Visual de IDE moderno. |
| **One Light/One Dark** | MIT ([atom](https://github.com/atom/atom)) | Suave e familiar. Claro: amarelo `#c18401` e verde `#50a14f` abaixo de 4,5. Escuro bom. |
| **Catppuccin Latte/Mocha** | MIT ([catppuccin](https://github.com/catppuccin/catppuccin)) | Mocha é lindo e legível. Latte: amarelo `#df8e1d` ≈2,3:1, verde e rosa fracos. |
| **Rosé Pine Dawn/Moon** | MIT ([rose-pine](https://github.com/rose-pine)) | Baixo contraste por estética. Dawn falha em várias cores e tem "preto" ANSI quase igual ao fundo. Opção de gosto, nunca padrão. |
| **Tokyo Night Day/Night** | Apache-2.0 ([tokyonight.nvim](https://github.com/folke/tokyonight.nvim)) | Night excelente. Day: `black` = `#b4b5b9` (cinza claro de propósito; o contraste mínimo o escurece no fundo claro), amarelo marrom ok. |
| **Solarized Light/Dark** | MIT ([solarized](https://github.com/altercation/solarized)) | Brilhantes são cinzas da base, não cores; Claude Code usa bright para destaque → perde informação. Contraste baixo. Não recomendo. |

**Shortlist:** GitHub, VS Code (Modern), Ubuntu/Yaru, Catppuccin, One. Tokyo Night como extra só no escuro.

## 3. Fontes que o tether pode embarcar

Embarcar = empacotar o woff2 no app. Todas abaixo permitem.

| Fonte | Licença | Pesos finos | Variável | woff2 (aprox., latin) | Caixa / Powerline / Nerd | Em Chromium/Windows 13–14px |
|---|---|---|---|---|---|---|
| **JetBrains Mono** | OFL 1.1 | 100–800 (Thin, ExtraLight, Light) | sim (wght) | 114 KB variável (medido, cobertura completa) | caixa e blocos completos; Powerline sim; Nerd só com o patch | Muito boa: x-height alto, hinting decente; peso 300–350 fica fino sem sumir. |
| **Ubuntu Sans Mono** (2023) | Ubuntu Font Licence 1.0 (permite embarcar e redistribuir com a licença junto) | 100–700 (variável, inclui Thin/Light) | sim | 111 KB variável (medido) | caixa sim; Powerline não | Boa, mais "redonda" e estreita, a cara do Ubuntu 23.10+. |
| **Ubuntu Mono** | Ubuntu Font Licence 1.0 (permite embarcar e redistribuir; derivadas não podem usar o nome "Ubuntu") | só 400/700 | não | ~50 KB por peso | caixa parcial | Pequena para o corpo: precisa 15–16px para igualar 13px de outras. Leve pela forma, não pelo peso. |
| **Cascadia Code/Mono** (atual) | OFL 1.1 | 200–700 | sim | 210 KB variável Mono (medido, cobertura grande) | caixa, Powerline nativo ("PL"), Nerd ("NF") | Traço encorpado; em 300 melhora bastante. |
| **Fira Code / Fira Mono** | OFL 1.1 | 300–700 | Code sim | ~100 KB | caixa, Powerline | Larga e pesada mesmo em 300. |
| **IBM Plex Mono** | OFL 1.1 | 100–700 | sim (`@ibm/plex-mono-variable`) | 83 KB variável (medido) | caixa parcial | Elegante, serifada leve; Light (300) ótima no escuro. |
| **Source Code Pro** | OFL 1.1 | 200–900 | sim | ~60 KB | caixa sim | Clara e leve em 300; x-height baixo, parece pequena. |
| **Geist Mono** | OFL 1.1 | 100–900 | sim | ~60 KB | caixa parcial | Moderna, "tipo Vercel"; boa em 300. |
| **Iosevka** | OFL 1.1 | 100–900 | sim | grande (centenas de KB) | caixa completa | Muito estreita; ótima densidade, polarizante. |
| **Commit Mono** | OFL 1.1 | 200–700 | sim | ~60 KB | caixa sim | Neutra, desenhada para legibilidade; boa em 350. |
| **Monaspace (Neon)** | OFL 1.1 | 200–800 | sim (wght + wdth) | ~150 KB+ | caixa sim | Bonita, mas larga; pesa no disco. |

Observações técnicas que valem para todas:

- **Caixa/box drawing:** o tether usa o renderizador DOM, que desenha `╭─│` com a fonte; frestas aparecem com `lineHeight` > 1. Com o addon **WebGL** do xterm (`@xterm/addon-webgl`), `customGlyphs: true` desenha esses glifos geometricamente e emenda em qualquer altura de linha — é o que o VS Code faz. Vale adotar junto com `lineHeight` 1.2.
- **Pesos finos no Windows:** o Chromium usa DirectWrite com antialiasing em tons de cinza no canvas/WebGL; pesos 200–250 ficam acinzentados a 13px. **300–350 é o piso prático.** Texto claro sobre fundo escuro parece mais grosso (irradiação), então o fino funciona melhor no escuro.
- **Carregar antes de abrir o terminal:** `await document.fonts.load('350 14px "JetBrains Mono"')` antes de `term.open()`, senão o xterm mede a fonte de fallback e as células ficam erradas.
- **Ubuntu "fino"** vem da forma estreita e do x-height pequeno, não de um peso Light. Quem quiser a cara exata pode escolher Ubuntu Sans Mono ou Ubuntu Mono como opção.

### Recomendação

- **Padrão de cores:** **GitHub Light / GitHub Dark**, com `minimumContrastRatio: 4.5`. É o que mais parece IDE, passa WCAG no claro sem truque e não grita no escuro.
- **Alternativas para a lista de personalização:** VS Code Modern, Ubuntu (Yaru), Catppuccin Latte/Mocha, One Light/One Dark.
- **Fonte padrão:** **JetBrains Mono** variável (OFL, ~100 KB), `fontSize` 14, `fontWeight` **350** (300 se o PO quiser mais fino no escuro), `fontWeightBold` **600**, `lineHeight` **1.2**, `letterSpacing` 0, ligaduras desligadas (agentes imprimem `=>`/`!=` em diffs; ligadura confunde). Opções extras: Ubuntu Sans Mono, IBM Plex Mono, Cascadia Mono (300).

## 4. Esboço de implementação (implementado em 2026-10-30; o que mudou em relação ao esboço: o registro é `app/shared/terminal-theme.ts`, as preferências vão em `settings.json` → `terminal`, e o WebGL entrou com fallback para o DOM — ver PROGRESS.md)

- **Registro:** `app/shared/terminal-presets.ts` — `TerminalPreset = { id, label, license, light: TerminalColors, dark: TerminalColors }` onde `TerminalColors` = `ITheme` sem `background`/`cursorAccent` (esses continuam vindo de `WINDOW_BACKGROUND`, fora do escopo). `TERMINAL_FONTS` com `{ id, label, family, weights, defaultWeight, file }`.
- **Fontes:** woff2 em `app/renderer/fonts/`, declaradas por `@font-face` no CSS do renderer (não depender de rede).
- **Configuração:** estender o mesmo arquivo de preferências de `theme.ts` (`normalizeTheme`) com `terminalPreset`, `terminalFont`, `terminalFontWeight`, `terminalFontSize`; normalização que cai no padrão para valor desconhecido.
- **Mapeamento no `panel.ts`:**
  ```ts
  const c = preset[scheme]
  term.options.theme = { ...c, background: WINDOW_BACKGROUND[scheme], cursorAccent: WINDOW_BACKGROUND[scheme] }
  Object.assign(term.options, {
    fontFamily: `"${font.family}", Consolas, monospace`,
    fontWeight: weight, fontWeightBold: 600, fontSize: 14, lineHeight: 1.2,
    letterSpacing: 0, minimumContrastRatio: 4.5,
  })
  ```
  Toda chave de `ITheme` preenchida (o comentário atual já explica que chave ausente cai no default escuro do xterm). Trocar fonte/tamanho em tempo de execução exige `fit.fit()` em seguida.
- **Opcional:** `@xterm/addon-webgl` com fallback para DOM em `onContextLoss`.
