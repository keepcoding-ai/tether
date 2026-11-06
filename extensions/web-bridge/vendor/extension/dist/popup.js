// <define:__BRAND__>
var define_BRAND_default = { name: "Tether", product: "Tether Bridge", color: "#5b8def" };

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
var STATUS_STORAGE_KEY = STATUS_KEY;

// extension/src/brand.ts
var DEFAULT_BRAND = { name: "Atrium", product: "Atrium Bridge" };
var BUILD_BRAND = typeof define_BRAND_default === "undefined" ? DEFAULT_BRAND : { ...DEFAULT_BRAND, ...define_BRAND_default };
var brandName = () => BUILD_BRAND.name;
var productName = () => BUILD_BRAND.product;

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
  release: "Retomar esta aba",
  handedOver: `Esta aba est\xE1 com o ${B} (grupo "${B}").`,
  notHandedOver: `O ${B} s\xF3 controla as abas que ele abriu e as que voc\xEA entregar aqui.`,
  options: "Op\xE7\xF5es e pareamento",
  working: "Aguarde\u2026",
  failed: (reason) => `N\xE3o foi poss\xEDvel: ${reason}`,
  noTab: "Nenhuma aba ativa."
};
var EVALUATE = {
  disabledError: `evaluate is turned off in this browser: the user must enable "C\xF3digo na p\xE1gina" in the ${P} extension options (chrome://extensions > ${P} > Options).`,
  /** Faixa no topo do popup enquanto a opção está ligada. */
  banner: `C\xF3digo na p\xE1gina LIBERADO \u2014 o agente pode executar scripts nas abas ${B}`,
  turnOff: "Desligar",
  /** Aviso injetado na aba a cada evaluate. */
  pageNotice: `${B} executou c\xF3digo nesta p\xE1gina`,
  optionTitle: "C\xF3digo na p\xE1gina",
  optionHelp: `Permite que o agente execute scripts (JavaScript) nas abas do grupo ${B}. Desligado, a tool evaluate \xE9 recusada.`,
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

// extension/src/popup.ts
var $ = (id) => document.getElementById(id);
var status = $("status");
var note = $("note");
var button = $("toggle");
var error = $("error");
var tabId = null;
async function send(msg) {
  return chrome.runtime.sendMessage(msg);
}
async function renderStatus() {
  const s = await getStatus();
  status.textContent = STATUS_LABEL[s.state];
  status.dataset.state = s.state;
}
async function renderAlert() {
  $("alert").hidden = !await getAllowEvaluate();
}
async function renderTab() {
  const forced = Number(new URLSearchParams(location.search).get("tab"));
  tabId = Number.isInteger(forced) && forced > 0 ? forced : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id ?? null;
  if (tabId === null) {
    button.disabled = true;
    note.textContent = POPUP.noTab;
    return;
  }
  const { scoped } = await send({ t: "is-scoped", tabId });
  button.disabled = false;
  button.textContent = scoped ? POPUP.release : POPUP.handover;
  button.dataset.scoped = String(!!scoped);
  note.textContent = scoped ? POPUP.handedOver : POPUP.notHandedOver;
}
button.addEventListener("click", async () => {
  if (tabId === null) return;
  error.textContent = "";
  button.disabled = true;
  button.textContent = POPUP.working;
  const reply = await send({ t: button.dataset.scoped === "true" ? "release" : "handover", tabId });
  if (reply.error) error.textContent = POPUP.failed(reply.error);
  await renderTab();
});
document.title = POPUP.title;
$("title").textContent = POPUP.title;
$("alert-text").textContent = EVALUATE.banner;
$("alert-off").textContent = EVALUATE.turnOff;
$("alert-off").addEventListener("click", () => void setAllowEvaluate(false));
$("options").addEventListener("click", () => void chrome.runtime.openOptionsPage());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && STATUS_STORAGE_KEY in changes) void renderStatus();
  if (area === "local" && ALLOW_EVALUATE_STORAGE_KEY in changes) void renderAlert();
});
void renderStatus();
void renderAlert();
void renderTab();
