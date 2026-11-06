// <define:__BRAND__>
var define_BRAND_default = { slug: "tether", name: "Tether", shortName: "Tether", description: "Deixa os agentes do Tether (Claude, soul) usarem este navegador, s\xF3 nas abas que eles abriram ou que voc\xEA entregou.", color: "#6aa6ff", colors: { accent: "#6aa6ff", light: { ink: "#1b1b1f", paper: "#f4f4f7" }, dark: { ink: "#e8e8ee", paper: "#141418" } }, host: { name: "tether", id: "studio.codr.tether" }, locale: "pt-BR", mcp: { serverName: "tether-bridge" }, tabs: { groupTitle: "{shortName}", agentTitle: "{shortName} \xB7 {agent}", groupColor: "blue" }, capabilities: { evaluate: "own-tabs", download: true, upload: true, pdf: true, readNetwork: true, windowPerAgent: true }, icons: { "16": "icons/icon-16.png", "32": "icons/icon-32.png", "48": "icons/icon-48.png", "128": "icons/icon-128.png" }, logos: { h: { light: "brand/logo-h-light.svg", dark: "brand/logo-h-dark.svg" }, symbol: { light: "brand/logo-light.svg", dark: "brand/logo-dark.svg" } }, product: "Tether Bridge" };

// extension/src/brand.ts
var DEFAULT_BRAND = { name: "Atrium", product: "Atrium Bridge" };
var BUILD_BRAND = typeof define_BRAND_default === "undefined" ? DEFAULT_BRAND : { ...DEFAULT_BRAND, ...define_BRAND_default };
var brandName = () => BUILD_BRAND.name;
var productName = () => BUILD_BRAND.product;
var brandAccent = () => BUILD_BRAND.colors?.accent ?? BUILD_BRAND.color;
var brandTheme = (scheme) => BUILD_BRAND.colors?.[scheme];
var brandLogos = () => BUILD_BRAND.logos?.h;

// extension/src/brand-ui.ts
function mountLogo(title, logos) {
  const text = title.textContent ?? "";
  title.replaceChildren();
  const picture = document.createElement("picture");
  picture.className = "brand-logo";
  const dark = document.createElement("source");
  dark.media = "(prefers-color-scheme: dark)";
  dark.srcset = logos.dark;
  const img = document.createElement("img");
  img.src = logos.light;
  img.alt = "";
  img.decoding = "sync";
  picture.append(dark, img);
  const label = document.createElement("span");
  label.className = "sr-only";
  label.textContent = text;
  title.append(picture, label);
  title.classList.add("has-logo");
}
function mountColors() {
  const accent = brandAccent();
  const light = brandTheme("light");
  const dark = brandTheme("dark");
  if (!accent && !light && !dark) return;
  const vars = (t) => t ? `--bg: ${t.paper}; --fg: ${t.ink};` : "";
  const style = document.createElement("style");
  style.id = "brand-colors";
  style.textContent = `:root { ${accent ? `--brand-accent: ${accent};` : ""} ${vars(light)} }
@media (prefers-color-scheme: dark) { :root { ${vars(dark)} } }
`;
  document.head.append(style);
}
function applyBrandUi(title) {
  mountColors();
  const logos = brandLogos();
  if (logos) mountLogo(title, logos);
}

// src/protocol.ts
var DEFAULT_PORT = 47821;

// extension/src/settings.ts
var STATUS_KEY = "status";
async function bridgeId() {
  const stored = (await chrome.storage.local.get("bridgeId")).bridgeId;
  if (stored) return stored;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ bridgeId: id });
  return id;
}
function browserBrand() {
  const brands = (navigator.userAgentData?.brands ?? []).map((b) => b.brand);
  if (brands.some((b) => /brave/i.test(b))) return "Brave";
  if (brands.some((b) => /edge/i.test(b))) return "Edge";
  if (brands.some((b) => /google chrome/i.test(b))) return "Chrome";
  return "Chromium";
}
async function loadSettings() {
  const s = await chrome.storage.local.get(["port", "token", "name"]);
  const id = await bridgeId();
  return {
    port: typeof s.port === "number" ? s.port : DEFAULT_PORT,
    token: typeof s.token === "string" ? s.token : "",
    name: typeof s.name === "string" && s.name.trim() ? s.name.trim() : `${browserBrand()} ${id.slice(0, 4)}`
  };
}
async function saveSettings(s) {
  await chrome.storage.local.set({ port: s.port, token: s.token, name: s.name.trim() });
}
async function getStatus() {
  return (await chrome.storage.session.get(STATUS_KEY))[STATUS_KEY] ?? { state: "disconnected" };
}
var ALLOW_EVALUATE_KEY = "allowEvaluate";
async function getAllowEvaluate() {
  return (await chrome.storage.local.get(ALLOW_EVALUATE_KEY))[ALLOW_EVALUATE_KEY] === true;
}
async function setAllowEvaluate(allow) {
  await chrome.storage.local.set({ [ALLOW_EVALUATE_KEY]: allow });
}
var ALLOW_EVALUATE_STORAGE_KEY = ALLOW_EVALUATE_KEY;
var STATUS_STORAGE_KEY = STATUS_KEY;

// extension/src/strings.ts
var B = brandName();
var P = productName();
var STATUS_LABEL = {
  unpaired: "N\xE3o pareado",
  connecting: "Conectando\u2026",
  connected: `Conectado ao ${B}`,
  denied: "Pareamento recusado",
  disconnected: "Desconectado"
};
var POPUP = {
  title: P,
  handover: `Entregar esta aba ao ${B}`,
  /** Com um agente ativo: a aba vai direto para ele. */
  handoverTo: (agent) => `Entregar esta aba a ${agent}`,
  /** Com vários agentes: a pessoa escolhe. */
  handoverPick: "Entregar esta aba a:",
  anyAgent: "Qualquer agente",
  release: "Retomar esta aba",
  handedOver: `Esta aba est\xE1 com o ${B} (grupo "${B}").`,
  handedOverTo: (agent) => `Esta aba est\xE1 com ${agent}.`,
  notHandedOver: `O ${B} s\xF3 controla as abas que ele abriu e as que voc\xEA entregar aqui.`,
  options: "Op\xE7\xF5es e pareamento",
  working: "Aguarde\u2026",
  failed: (reason) => `N\xE3o foi poss\xEDvel: ${reason}`,
  noTab: "Nenhuma aba ativa.",
  // A12: o que está sob controle, agrupado por agente.
  controlledTitle: "Sob controle",
  controlledCount: (n) => n === 1 ? "1 aba" : `${n} abas`,
  controlledEmpty: `Nenhuma aba sob controle do ${B} agora.`,
  sharedGroup: "Qualquer agente",
  handedMark: "entregue por voc\xEA",
  retake: "Retomar",
  retakeAll: "Retomar tudo",
  // Pausa (o kill switch, também daqui).
  pausedBanner: `${B} PAUSADO \u2014 nenhum agente controla abas at\xE9 voc\xEA retomar`,
  pause: "Pausar agentes",
  resume: "Retomar agentes",
  pauseHint: "Pausar solta todas as abas, em todos os navegadores; as tools dos agentes param at\xE9 voc\xEA retomar.",
  noDaemon: `sem conex\xE3o com o ${B}; use "Retomar tudo" para soltar as abas deste navegador`,
  // Nome do browser, inline (sem ir às opções).
  browserName: "Nome deste navegador",
  browserNameHelp: "Como os agentes veem este navegador. Enter ou sair do campo salva.",
  // Atualização em lugar (C5): a pasta mudou e a extensão não conseguiu se recarregar sozinha.
  reloadHint: (expected, running) => `Atualiza\xE7\xE3o dispon\xEDvel (${expected}; esta \xE9 ${running}): clique em Recarregar em chrome://extensions.`
};
var EVALUATE = {
  /** Aba entregue pela pessoa, sem a liberação dela (modo `own-tabs`). */
  disabledError: `evaluate is turned off in this tab: the user handed it over, so it is their session. It works in tabs you open yourself (tabs {action:"new"}); for this tab the user must enable "C\xF3digo na p\xE1gina" in the ${P} extension options (chrome://extensions > ${P} > Options).`,
  /** A instalação desligou a evaluate em toda aba (`capabilities.evaluate = off`). */
  disabledByInstallation: `evaluate is turned off by this ${P} installation (capabilities.evaluate = "off"): no script runs in any tab.`,
  /** Uma capability booleana desligada pela instalação (download, upload, pdf, readNetwork). */
  capabilityOff: (tool, capability) => `${tool} is turned off by this ${P} installation (capabilities.${capability} = false).`,
  /** Faixa no topo do popup enquanto a opção está ligada. */
  banner: `C\xF3digo na p\xE1gina LIBERADO \u2014 o agente pode executar scripts nas abas ${B}`,
  turnOff: "Desligar",
  /** Aviso injetado na aba a cada evaluate. */
  pageNotice: `${B} executou c\xF3digo nesta p\xE1gina`,
  optionTitle: "C\xF3digo na p\xE1gina",
  optionHelp: `Permite que o agente execute scripts (JavaScript) nas abas do grupo ${B}. Desligado, a tool evaluate \xE9 recusada.`,
  /** O interruptor no popup (A12): vale para as abas que a pessoa entregou; nas que o agente abriu já vale (Q1). */
  popupHelp: "Nas abas que voc\xEA entregou. Nas que o agente abriu, j\xE1 vale.",
  off: "\u{1F512} Desligado",
  offHint: "O agente n\xE3o executa scripts nas p\xE1ginas.",
  on: "\u26A0\uFE0F Liberado",
  onHint: `O agente executa JavaScript nas abas ${B}.`,
  risk: "RISCO: um script pode ler e alterar o que a p\xE1gina mostra, inclusive dados da sua sess\xE3o nela.",
  confirmTitle: "Liberar c\xF3digo na p\xE1gina?",
  confirmBody: `O agente poder\xE1 executar scripts em qualquer aba ${B}, com o mesmo acesso que a pr\xF3pria p\xE1gina tem: ler conte\xFAdo, preencher formul\xE1rios e agir em nome da sua sess\xE3o aberta. S\xF3 libere se confiar no que o agente est\xE1 fazendo.`,
  confirmYes: "Liberar c\xF3digo na p\xE1gina",
  confirmNo: "Cancelar",
  savedOn: "C\xF3digo na p\xE1gina liberado.",
  savedOff: "C\xF3digo na p\xE1gina desligado."
};
var OPTIONS = {
  title: `${P} \u2014 pareamento`,
  intro: `O ${P} conecta este browser ao daemon local do ${B}. Rode o daemon, copie o token de pareamento (node daemon/src/cli.ts token pairing --copy) e cole abaixo.`,
  name: "Nome deste browser",
  nameHelp: 'Como os agentes veem este browser (por exemplo "Brave (Trabalho)"). Inclua o perfil: a extens\xE3o n\xE3o consegue descobri-lo.',
  port: "Porta do daemon",
  token: "Token de pareamento",
  tokenHelp: "Fica guardado s\xF3 neste perfil do browser.",
  save: "Salvar e conectar",
  saved: "Salvo.",
  invalidPort: "A porta precisa ser um n\xFAmero entre 1 e 65535.",
  id: "Identificador"
};

// extension/src/options.ts
var $ = (id) => document.getElementById(id);
async function renderStatus() {
  const s = await getStatus();
  const el = $("status");
  el.textContent = s.detail ? `${STATUS_LABEL[s.state]} \u2014 ${s.detail}` : STATUS_LABEL[s.state];
  el.dataset.state = s.state;
}
var choices = [...document.querySelectorAll("#evaluate-choice button")];
async function renderEvaluate() {
  const on = await getAllowEvaluate();
  for (const b of choices) b.setAttribute("aria-checked", String(b.dataset.value === (on ? "on" : "off")));
  $("risk").hidden = !on;
}
function confirmEnable() {
  const overlay = $("confirm");
  const yes = $("confirm-yes");
  const no = $("confirm-no");
  overlay.hidden = false;
  no.focus();
  return new Promise((resolve) => {
    const done = (v) => {
      overlay.hidden = true;
      yes.removeEventListener("click", onYes);
      no.removeEventListener("click", onNo);
      document.removeEventListener("keydown", onKey);
      resolve(v);
    };
    const onYes = () => done(true);
    const onNo = () => done(false);
    const onKey = (ev) => ev.key === "Escape" && done(false);
    yes.addEventListener("click", onYes);
    no.addEventListener("click", onNo);
    document.addEventListener("keydown", onKey);
  });
}
async function initEvaluate() {
  for (const [id, text] of Object.entries({
    "label-evaluate": EVALUATE.optionTitle,
    "help-evaluate": EVALUATE.optionHelp,
    "off-title": EVALUATE.off,
    "off-hint": EVALUATE.offHint,
    "on-title": EVALUATE.on,
    "on-hint": EVALUATE.onHint,
    risk: EVALUATE.risk,
    "confirm-title": EVALUATE.confirmTitle,
    "confirm-body": EVALUATE.confirmBody,
    "confirm-yes": EVALUATE.confirmYes,
    "confirm-no": EVALUATE.confirmNo
  })) {
    $(id).textContent = text;
  }
  for (const b of choices) {
    b.addEventListener("click", async () => {
      const want = b.dataset.value === "on";
      if (want === await getAllowEvaluate()) return;
      if (want && !await confirmEnable()) return;
      await setAllowEvaluate(want);
      $("evaluate-message").textContent = want ? EVALUATE.savedOn : EVALUATE.savedOff;
    });
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && ALLOW_EVALUATE_STORAGE_KEY in changes) void renderEvaluate();
  });
  await renderEvaluate();
}
async function init() {
  document.title = OPTIONS.title;
  for (const [id, text] of Object.entries({
    title: OPTIONS.title,
    intro: OPTIONS.intro,
    "label-name": OPTIONS.name,
    "help-name": OPTIONS.nameHelp,
    "label-port": OPTIONS.port,
    "label-token": OPTIONS.token,
    "help-token": OPTIONS.tokenHelp,
    "label-id": OPTIONS.id
  })) {
    $(id).textContent = text;
  }
  applyBrandUi($("title"));
  $("save").textContent = OPTIONS.save;
  const s = await loadSettings();
  $("name").value = s.name;
  $("port").value = String(s.port);
  $("token").value = s.token;
  $("id").textContent = await bridgeId();
  $("form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const port = Number($("port").value);
    const msg = $("message");
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      msg.textContent = OPTIONS.invalidPort;
      return;
    }
    await saveSettings({
      port,
      token: $("token").value.trim(),
      name: $("name").value
    });
    msg.textContent = OPTIONS.saved;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && STATUS_STORAGE_KEY in changes) void renderStatus();
  });
  await renderStatus();
  await initEvaluate();
}
void init();
