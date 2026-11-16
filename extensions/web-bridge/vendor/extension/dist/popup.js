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

// extension/src/owner.ts
var OWNER_GROUP_COLORS = ["blue", "red", "green", "pink", "purple", "cyan", "orange"];
function ownerGroupColor(clientId) {
  let h = 2166136261;
  for (let i = 0; i < clientId.length; i++) {
    h ^= clientId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return OWNER_GROUP_COLORS[h % OWNER_GROUP_COLORS.length];
}

// extension/src/reload.ts
var EXPECTED_KEY = "hostExtensionVersion";
var EXPECTED_VERSION_STORAGE_KEY = EXPECTED_KEY;
async function expectedExtensionVersion() {
  return (await chrome.storage.session.get(EXPECTED_KEY))[EXPECTED_KEY] ?? null;
}

// extension/src/settings.ts
var STATUS_KEY = "status";
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
var DEBUG_CHOICE_STORAGE_KEY = "debugChoice";
async function getDebugChoice() {
  const v = (await chrome.storage.local.get(DEBUG_CHOICE_STORAGE_KEY))[DEBUG_CHOICE_STORAGE_KEY];
  return v && typeof v.enabled === "boolean" ? v : null;
}
async function setDebugChoice(choice) {
  await chrome.storage.local.set({ [DEBUG_CHOICE_STORAGE_KEY]: choice });
}
var STATUS_STORAGE_KEY = STATUS_KEY;
var HOST_STATUS_KEY = "hostStatus";
var HOST_STATUS_STORAGE_KEY = HOST_STATUS_KEY;

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
  /** Faixa no topo do popup enquanto a depuração (escolha da pessoa nas opções) está ligada. */
  debugBanner: "Depura\xE7\xE3o LIGADA \u2014 prazos relaxados e chamadas gravadas no disco",
  debugTurnOff: "Desligar",
  /** O atalho dentro da faixa para a seção de depuração das opções. */
  debugOptions: "Op\xE7\xF5es de depura\xE7\xE3o",
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
var DEBUG = {
  optionTitle: "Depura\xE7\xE3o",
  optionHelp: "Grava neste computador o passo a passo de cada a\xE7\xE3o dos agentes, com os endere\xE7os das p\xE1ginas e os textos digitados (senhas ficam sempre de fora), e relaxa os prazos. Serve para investigar uma falha; desligue quando terminar. S\xF3 voc\xEA liga este modo, aqui neste navegador.",
  off: "Desligado",
  offHint: "Nada \xE9 gravado al\xE9m do registro de sempre.",
  on: "Modo de depura\xE7\xE3o",
  onHint: "Grava o passo a passo e usa o prazo abaixo.",
  timeoutLabel: "Prazo de cada chamada (segundos)",
  timeoutHelp: "Vazio = o padr\xE3o de 60 s. 0 = sem prazo.",
  timeoutInvalid: `Use um n\xFAmero inteiro de segundos, de 0 a 86400, ou deixe vazio.`,
  saved: "Salvo.",
  stateOff: "Agora: desligado.",
  stateOn: "Agora: ligado.",
  stateOutdated: `Ligado aqui, mas o programa do ${B} neste computador precisa ser atualizado para o modo valer.`,
  stateOffline: `Sem conex\xE3o com o ${B}: a escolha vale quando ele conectar.`,
  timeoutNow: (ms) => ms === null ? "Prazo em vigor: sem prazo." : `Prazo em vigor: ${Math.round(ms / 1e3)} s.`,
  traceAt: (path) => `O passo a passo \xE9 gravado em ${path}`
};

// extension/src/popup.ts
var $ = (id) => document.getElementById(id);
var status = $("status");
var note = $("note");
var button = $("toggle");
var error = $("error");
var pick = $("agent-pick");
var pickList = $("agent-pick-list");
var groups = $("groups");
var releaseAllButton = $("release-all");
var pauseButton = $("pause-toggle");
var evaluateSwitch = $("evaluate-switch");
var nameInput = $("name");
var tabId = null;
var view = null;
async function send(msg) {
  return chrome.runtime.sendMessage(msg);
}
async function resolveTab() {
  const forced = Number(new URLSearchParams(location.search).get("tab"));
  if (Number.isInteger(forced) && forced > 0) return forced;
  return (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id ?? null;
}
var agentLabel = (a) => a.name ?? a.id;
var hostOf = (url) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};
async function renderStatus() {
  const s = await getStatus();
  status.textContent = STATUS_LABEL[s.state];
  status.dataset.state = s.state;
}
async function renderAlert() {
  const on = await getAllowEvaluate();
  $("alert").hidden = !on;
  evaluateSwitch.setAttribute("aria-checked", String(on));
}
async function renderReloadHint() {
  const expected = await expectedExtensionVersion();
  const running = chrome.runtime.getManifest().version;
  const hint = $("reload-hint");
  hint.hidden = !expected || expected === running;
  if (!hint.hidden) hint.textContent = POPUP.reloadHint(expected, running);
}
async function renderDebugBanner() {
  $("debug-banner").hidden = (await getDebugChoice())?.enabled !== true;
}
async function turnOffDebug() {
  const choice = await getDebugChoice();
  await setDebugChoice({ enabled: false, ...choice?.callTimeoutMs !== void 0 ? { callTimeoutMs: choice.callTimeoutMs } : {} });
}
function renderThisTab() {
  if (!view) return;
  pick.hidden = true;
  button.hidden = false;
  if (tabId === null) {
    button.disabled = true;
    note.textContent = POPUP.noTab;
    return;
  }
  const mine = view.tabs.find((t) => t.id === tabId);
  button.disabled = false;
  if (mine) {
    button.textContent = POPUP.release;
    button.dataset.scoped = "true";
    note.textContent = mine.owner !== void 0 ? POPUP.handedOverTo(mine.ownerName ?? mine.owner) : POPUP.handedOver;
    return;
  }
  button.dataset.scoped = "false";
  note.textContent = POPUP.notHandedOver;
  const agents = view.agents;
  if (agents.length <= 1) {
    button.textContent = agents[0] ? POPUP.handoverTo(agentLabel(agents[0])) : POPUP.handover;
    button.dataset.owner = agents[0]?.id ?? "";
    return;
  }
  button.hidden = true;
  pick.hidden = false;
  $("agent-pick-title").textContent = POPUP.handoverPick;
  pickList.replaceChildren(
    ...agents.map((a) => pickButton(a.id, agentLabel(a), ownerGroupColor(a.id))),
    pickButton("", POPUP.anyAgent, "grey")
  );
}
function pickButton(owner, label, color) {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.owner = owner;
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.dataset.color = color;
  b.append(dot, document.createTextNode(label));
  b.addEventListener("click", () => void handover(owner));
  return b;
}
async function handover(owner) {
  if (tabId === null) return;
  const agent = view?.agents.find((a) => a.id === owner);
  await act(() => send({ t: "handover", tabId, ...agent ? { owner: agent } : {} }));
}
async function act(run) {
  error.textContent = "";
  button.disabled = true;
  button.textContent = POPUP.working;
  const reply = await run().catch((e) => ({ error: e.message }));
  if (reply.error) error.textContent = POPUP.failed(reply.error);
  await refresh();
}
button.addEventListener("click", () => {
  if (tabId === null) return;
  if (button.dataset.scoped === "true") void act(() => send({ t: "release", tabId }));
  else void handover(button.dataset.owner ?? "");
});
function renderControlled() {
  if (!view) return;
  const tabs = view.tabs;
  $("controlled-label").textContent = POPUP.controlledTitle;
  $("controlled-count").textContent = tabs.length ? `\xB7 ${POPUP.controlledCount(tabs.length)}` : "";
  const empty = $("controlled-empty");
  empty.hidden = tabs.length > 0;
  empty.textContent = POPUP.controlledEmpty;
  releaseAllButton.hidden = tabs.length === 0;
  releaseAllButton.textContent = POPUP.retakeAll;
  const byOwner = /* @__PURE__ */ new Map();
  for (const t of tabs) {
    const key = t.owner ?? "";
    byOwner.set(key, [...byOwner.get(key) ?? [], t]);
  }
  const ordered = [...view.agents.map((a) => a.id).filter((id) => byOwner.has(id)), ...[...byOwner.keys()].filter((k) => k !== "" && !view.agents.some((a) => a.id === k)), ...byOwner.has("") ? [""] : []];
  groups.replaceChildren(
    ...ordered.map((owner) => {
      const rows = byOwner.get(owner);
      const group = document.createElement("div");
      group.className = "group";
      group.dataset.owner = owner;
      const head = document.createElement("div");
      head.className = "group-head";
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.dataset.color = owner ? ownerGroupColor(owner) : "grey";
      const name = owner ? view.agents.find((a) => a.id === owner)?.name ?? rows[0].ownerName ?? owner : POPUP.sharedGroup;
      head.append(dot, document.createTextNode(name));
      group.append(head, ...rows.map(tabRow));
      return group;
    })
  );
}
function tabRow(t) {
  const row = document.createElement("div");
  row.className = "tab-row";
  row.dataset.tab = String(t.id);
  const text = document.createElement("div");
  text.className = "text";
  const title = document.createElement("span");
  title.className = "tab-title";
  title.textContent = t.title || hostOf(t.url);
  title.title = t.url;
  const host = document.createElement("span");
  host.className = "tab-host";
  host.textContent = hostOf(t.url);
  if (t.handed) {
    const mark = document.createElement("span");
    mark.className = "mark";
    mark.textContent = ` \xB7 ${POPUP.handedMark}`;
    host.append(mark);
  }
  text.append(title, host);
  const retake = document.createElement("button");
  retake.type = "button";
  retake.textContent = POPUP.retake;
  retake.addEventListener("click", () => void act(() => send({ t: "release", tabId: t.id })));
  row.append(text, retake);
  return row;
}
releaseAllButton.addEventListener("click", () => void act(() => send({ t: "release-all" })));
function renderPause() {
  if (!view) return;
  const banner = $("paused");
  banner.hidden = !view.paused;
  $("paused-text").textContent = POPUP.pausedBanner;
  $("paused-resume").textContent = POPUP.resume;
  pauseButton.textContent = view.paused ? POPUP.resume : POPUP.pause;
  pauseButton.disabled = !view.connected;
  $("pause-hint").textContent = view.connected ? POPUP.pauseHint : POPUP.noDaemon;
}
var setPaused = (paused) => act(() => send({ t: "set-paused", paused }));
pauseButton.addEventListener("click", () => void setPaused(!view?.paused));
$("paused-resume").addEventListener("click", () => void setPaused(false));
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
evaluateSwitch.addEventListener("click", async () => {
  const want = !await getAllowEvaluate();
  if (want && !await confirmEnable()) return;
  await setAllowEvaluate(want);
});
async function saveName() {
  const name = nameInput.value.trim();
  if (!name || name === view?.name) return;
  const reply = await send({ t: "set-name", name });
  if (reply.error) error.textContent = POPUP.failed(reply.error);
  await refresh();
}
nameInput.addEventListener("blur", () => void saveName());
nameInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") nameInput.blur();
});
async function refresh() {
  view = await send({ t: "overview" });
  if (document.activeElement !== nameInput) nameInput.value = view.name;
  renderThisTab();
  renderControlled();
  renderPause();
}
async function init() {
  document.title = POPUP.title;
  $("title").textContent = POPUP.title;
  applyBrandUi($("title"));
  $("alert-text").textContent = EVALUATE.banner;
  $("alert-off").textContent = EVALUATE.turnOff;
  $("alert-off").addEventListener("click", () => void setAllowEvaluate(false));
  $("evaluate-label").textContent = EVALUATE.optionTitle;
  $("evaluate-help").textContent = EVALUATE.popupHelp;
  for (const [id, text] of Object.entries({ "confirm-title": EVALUATE.confirmTitle, "confirm-body": EVALUATE.confirmBody, "confirm-yes": EVALUATE.confirmYes, "confirm-no": EVALUATE.confirmNo })) {
    $(id).textContent = text;
  }
  $("label-name").textContent = POPUP.browserName;
  $("help-name").textContent = POPUP.browserNameHelp;
  $("options").textContent = POPUP.options;
  $("options").addEventListener("click", () => void chrome.runtime.openOptionsPage());
  $("debug-banner-text").textContent = POPUP.debugBanner;
  $("debug-off").textContent = POPUP.debugTurnOff;
  $("debug-off").addEventListener("click", () => void turnOffDebug());
  $("debug-options").textContent = POPUP.debugOptions;
  $("debug-options").addEventListener("click", () => void chrome.runtime.openOptionsPage());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && STATUS_STORAGE_KEY in changes) void renderStatus();
    if (area === "session" && EXPECTED_VERSION_STORAGE_KEY in changes) void renderReloadHint();
    if (area === "local" && ALLOW_EVALUATE_STORAGE_KEY in changes) void renderAlert();
    if (area === "local" && DEBUG_CHOICE_STORAGE_KEY in changes) void renderDebugBanner();
    if (area === "session" && ("scope" in changes || HOST_STATUS_STORAGE_KEY in changes)) void refresh();
  });
  tabId = await resolveTab();
  await Promise.all([renderStatus(), renderAlert(), renderReloadHint(), renderDebugBanner(), refresh()]);
}
void init();
