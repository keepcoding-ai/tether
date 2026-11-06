// <define:__BRAND__>
var define_BRAND_default = { name: "Tether", product: "Tether Bridge", color: "#5b8def" };

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
