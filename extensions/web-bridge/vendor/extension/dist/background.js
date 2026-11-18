// <define:__BRAND__>
var define_BRAND_default = { slug: "tether", name: "Tether", shortName: "Tether", description: "Deixa os agentes do Tether (Claude, soul) usarem este navegador, s\xF3 nas abas que eles abriram ou que voc\xEA entregou.", color: "#6aa6ff", colors: { accent: "#6aa6ff", light: { ink: "#1b1b1f", paper: "#f4f4f7" }, dark: { ink: "#e8e8ee", paper: "#141418" } }, host: { name: "tether", id: "studio.codr.tether" }, locale: "pt-BR", mcp: { serverName: "tether-bridge" }, tabs: { groupTitle: "{shortName}", agentTitle: "{shortName} \xB7 {agent}", groupColor: "blue" }, capabilities: { evaluate: "own-tabs", download: true, upload: true, pdf: true, readNetwork: true, windowPerAgent: false }, icons: { "16": "icons/icon-16.png", "32": "icons/icon-32.png", "48": "icons/icon-48.png", "128": "icons/icon-128.png" }, logos: { h: { light: "brand/logo-h-light.svg", dark: "brand/logo-h-dark.svg" }, symbol: { light: "brand/logo-light.svg", dark: "brand/logo-dark.svg" } }, product: "Tether Bridge" };

// src/protocol.ts
var PROTOCOL_VERSION = 1;
var DEFAULT_PORT = 47821;
var WS_PATH = "/ext";
var CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;
var CLIENT_NAME_MAX = 80;
function isClientId(v) {
  return typeof v === "string" && CLIENT_ID_PATTERN.test(v);
}
function cleanClientName(raw2) {
  if (typeof raw2 !== "string") return void 0;
  const cleaned = raw2.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, CLIENT_NAME_MAX).trim();
  return cleaned || void 0;
}
var SEED_FILE = "bridge.json";
function isSeed(v) {
  const s = v;
  return !!s && typeof s === "object" && typeof s.port === "number" && Number.isInteger(s.port) && s.port >= 1 && s.port <= 65535 && typeof s.token === "string" && s.token.length >= 16 && (s.host === void 0 || typeof s.host === "string" && s.host.length <= 64);
}

// src/errors.ts
var BridgeError = class extends Error {
  code;
  data;
  constructor(code, message, data) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    if (data !== void 0) this.data = data;
  }
};
function toWireError(e) {
  if (e && typeof e === "object" && typeof e.code === "string") {
    const err = e;
    const data = err.data ?? (err.occluder !== void 0 ? { occluder: err.occluder } : void 0);
    return { code: err.code, message: err.message ?? err.code, ...data !== void 0 ? { data } : {} };
  }
  return { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) };
}

// src/trace.ts
var REDACTED = "[redacted]";
var TRACE_VALUE_MAX = 2048;
var BASE64_LONG = /^[A-Za-z0-9+/=\r\n]{256,}$/;
function clipForTrace(value, max = TRACE_VALUE_MAX) {
  const shrink = (v) => {
    if (typeof v === "string") return BASE64_LONG.test(v) ? `[binary: ${v.length} chars]` : v;
    if (Array.isArray(v)) return v.map(shrink);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrink(x)]));
    return v;
  };
  const small = shrink(value);
  const json = JSON.stringify(small) ?? "null";
  if (json.length <= max) return small;
  return { $truncated: true, chars: json.length, preview: json.slice(0, max) };
}

// extension/src/calls.ts
var HISTORY_MAX = 200;
var live = /* @__PURE__ */ new Map();
var queues = /* @__PURE__ */ new Map();
var running = /* @__PURE__ */ new Map();
var history = [];
var cdpTokens = 0;
var localIds = 0;
function localCallId() {
  return `local-${++localIds}`;
}
function beginCall(callId, tool, client) {
  const now = Date.now();
  live.set(callId, { callId, tool, ...client ? { client } : {}, startedAt: now, stage: "start", stageAt: now });
}
function endCall(callId, outcome) {
  const c = live.get(callId);
  if (!c) return;
  live.delete(callId);
  if (c.tabId !== void 0) leaveQueue(callId, c.tabId);
  history.push({
    callId,
    tool: c.tool,
    ...c.tabId !== void 0 ? { tabId: c.tabId } : {},
    ...c.client ? { client: c.client } : {},
    durationMs: Date.now() - c.startedAt,
    ok: outcome.ok,
    ...outcome.ok ? {} : { code: outcome.code },
    stage: c.stage,
    endedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
  while (history.length > HISTORY_MAX) history.shift();
}
function setStageOf(c, stage2, progress) {
  if (c.stage !== stage2) {
    c.stage = stage2;
    c.stageAt = Date.now();
    traceEvent({ event: "stage", callId: c.callId, stage: stage2, ...c.tabId !== void 0 ? { tabId: c.tabId } : {} });
  }
  if (progress) c.progress = progress;
  else if (c.stage !== "typing") delete c.progress;
}
function setCallStage(callId, stage2) {
  const c = live.get(callId);
  if (c) setStageOf(c, stage2);
}
function stage(tabId, stage2, progress) {
  const id = running.get(tabId);
  const c = id ? live.get(id) : void 0;
  if (c) setStageOf(c, stage2, progress);
}
function enqueue(callId, tabId) {
  const c = live.get(callId);
  if (c) {
    c.tabId = tabId;
    setStageOf(c, "queued");
  }
  const q = queues.get(tabId) ?? [];
  q.push(callId);
  queues.set(tabId, q);
}
function startRunning(callId, tabId) {
  running.set(tabId, callId);
  const q = queues.get(tabId);
  if (q && q[0] !== callId) {
    const i = q.indexOf(callId);
    if (i > 0) q.splice(0, i);
  }
}
function leaveQueue(callId, tabId) {
  if (running.get(tabId) === callId) running.delete(tabId);
  const q = queues.get(tabId);
  if (!q) return;
  const i = q.indexOf(callId);
  if (i >= 0) q.splice(i, 1);
  if (q.length === 0) queues.delete(tabId);
}
function cdpStart(tabId, method, params) {
  const id = running.get(tabId);
  const c = id ? live.get(id) : void 0;
  const started = Date.now();
  const token = ++cdpTokens;
  if (c) c.cdp = { method, startedAt: started, pending: true, token };
  return (outcome) => {
    if (c?.cdp?.token === token) c.cdp.pending = false;
    if (!debugOn) return;
    const redact = (v) => redactFor(c, method, v);
    traceEvent({
      event: "cdp",
      ...c ? { callId: c.callId } : {},
      tabId,
      method,
      durationMs: Date.now() - started,
      ok: outcome.ok,
      params: clipForTrace(redact(params ?? {})),
      ...outcome.ok ? { result: clipForTrace(redact(outcome.result ?? null)) } : { error: redact(outcome.error) }
    });
  };
}
var TRACE_QUEUE_MAX = 1e3;
var TRACE_BATCH = 100;
var TRACE_FLUSH_MS = 100;
var debugOn = false;
var debugTimeoutMs;
var sink = null;
var queue = [];
var dropped = 0;
var flushTimer = null;
function setDebug(on, timeoutMs) {
  debugOn = on;
  debugTimeoutMs = on ? timeoutMs : void 0;
  if (!on) {
    queue = [];
    dropped = 0;
  }
}
var isDebug = () => debugOn;
function lockTimeout(defaultMs) {
  if (debugTimeoutMs === void 0) return defaultMs;
  return debugTimeoutMs === 0 ? Infinity : debugTimeoutMs;
}
function debugTimeoutOf(raw2) {
  return typeof raw2 === "string" && /^\d{1,10}$/.test(raw2) ? Number(raw2) : void 0;
}
function setTraceSink(send2) {
  sink = send2;
}
function traceEvent(ev) {
  if (!debugOn) return;
  queue.push({ ...ev, at: (/* @__PURE__ */ new Date()).toISOString() });
  if (queue.length > TRACE_QUEUE_MAX) {
    const extra = queue.length - TRACE_QUEUE_MAX;
    queue.splice(0, extra);
    dropped += extra;
  }
  flushTimer ??= setTimeout(flushTrace, TRACE_FLUSH_MS);
}
function flushTrace() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (!sink || queue.length === 0) return;
  if (dropped > 0) {
    queue.unshift({ event: "dropped", count: dropped, at: (/* @__PURE__ */ new Date()).toISOString() });
    dropped = 0;
  }
  while (queue.length) sink(queue.splice(0, TRACE_BATCH));
}
function traceGate(callId, gate, decision, reason2) {
  traceEvent({ event: "gate", callId, gate, decision, reason: reason2 });
}
function traceTyping(tabId, text, target) {
  const id = running.get(tabId);
  const c = id ? live.get(id) : void 0;
  if (target.secret && c) c.secret = text;
  traceEvent({ event: "typing", ...c ? { callId: c.callId } : {}, tabId, into: target.into, secret: target.secret, text: target.secret ? REDACTED : text });
}
function redactFor(c, method, value) {
  const secret = c?.secret;
  if (secret === void 0) return value;
  const scrub2 = (v, all) => {
    if (typeof v === "string") return all ? REDACTED : secret && v.includes(secret) ? v.split(secret).join(REDACTED) : v;
    if (Array.isArray(v)) return v.map((x) => scrub2(x, all));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub2(x, all)]));
    return v;
  };
  return scrub2(value, method.startsWith("Input."));
}
function noteTargetHint(callId, hint) {
  const c = live.get(callId);
  if (!c) return;
  const h = {};
  if (typeof hint.ref === "string") h.ref = hint.ref;
  if (typeof hint.x === "number") h.x = hint.x;
  if (typeof hint.y === "number") h.y = hint.y;
  if (Object.keys(h).length) c.hint = h;
}
function noteAim(tabId, aim2) {
  const id = running.get(tabId);
  const c = id ? live.get(id) : void 0;
  if (c) c.aim = aim2;
}
function notePageEvents(callId, events) {
  const c = live.get(callId);
  if (c) c.pageEvents = events;
}
function dumpSource(callId) {
  const c = live.get(callId);
  if (!c) return void 0;
  return {
    view: view(c, Date.now()),
    ...c.tabId !== void 0 ? { tabId: c.tabId } : {},
    ...c.hint ? { hint: c.hint } : {},
    ...c.aim ? { aim: c.aim } : {},
    ...c.pageEvents !== void 0 ? { pageEvents: c.pageEvents } : {},
    ...c.secret !== void 0 ? { secret: c.secret } : {}
  };
}
function traceFor(callId, event2, fields) {
  traceEvent({ event: event2, callId, ...fields });
}
function view(c, now) {
  const v = {
    callId: c.callId,
    tool: c.tool,
    ...c.tabId !== void 0 ? { tabId: c.tabId } : {},
    ...c.client ? { client: c.client } : {},
    ageMs: now - c.startedAt,
    stage: c.stage,
    stageAgeMs: now - c.stageAt
  };
  if (c.tabId !== void 0) {
    const q = queues.get(c.tabId) ?? [];
    const position = q.indexOf(c.callId);
    if (position >= 0) {
      const isRunning = running.get(c.tabId) === c.callId;
      v.queue = { state: isRunning ? "running" : "queued", position, ...position > 0 ? { behind: q[position - 1] } : {} };
    }
  }
  if (c.cdp) v.cdp = { method: c.cdp.method, ageMs: now - c.cdp.startedAt, pending: c.cdp.pending };
  if (c.progress) v.progress = { ...c.progress };
  return v;
}
async function tabView(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const win = await chrome.windows.get(tab.windowId);
    return { tabId, active: tab.active, windowFocused: win.focused, ...win.state ? { windowState: win.state } : {}, ...tab.discarded ? { discarded: true } : {} };
  } catch (e) {
    return { tabId, error: e.message };
  }
}
async function inspectCall(callId) {
  const now = Date.now();
  const c = live.get(callId);
  if (!c) return { found: false };
  const call = view(c, now);
  const report = { found: true, call };
  if (c.tabId !== void 0) {
    const runId = running.get(c.tabId);
    const r = runId && runId !== callId ? live.get(runId) : void 0;
    if (r) report.running = view(r, now);
    report.tab = await tabView(c.tabId);
  }
  return report;
}
async function diagnose(filter, self) {
  const now = Date.now();
  const views = [...live.values()].filter((c) => c.callId !== self).map((c) => view(c, now));
  const tabIds = [...new Set(views.flatMap((v) => v.tabId !== void 0 && v.queue ? [v.tabId] : []))];
  const tabs2 = [];
  for (const tabId of tabIds) {
    if (filter.tabId !== void 0 && tabId !== filter.tabId) continue;
    const here = views.filter((v) => v.tabId === tabId && v.queue).sort((a, b) => a.queue.position - b.queue.position);
    if (filter.callId !== void 0 && !here.some((v) => v.callId === filter.callId)) continue;
    const runningView = here.find((v) => v.queue.state === "running");
    tabs2.push({ ...await tabView(tabId), ...runningView ? { running: runningView } : {}, waiting: here.filter((v) => v.queue.state === "queued") });
  }
  const other = views.filter(
    (v) => !v.queue && (filter.callId === void 0 || v.callId === filter.callId) && (filter.tabId === void 0 || v.tabId === filter.tabId)
  );
  const past = history.filter((h) => (filter.callId === void 0 || h.callId === filter.callId) && (filter.tabId === void 0 || h.tabId === filter.tabId));
  return { tabs: tabs2, other, history: [...past].reverse() };
}

// ../../packages/browser/src/core/errors.ts
var BrowserError = class extends Error {
  code;
  /** Elemento que cobre o alvo (só em TARGET_OBSCURED); null = nada sob o ponto. */
  occluder;
  /** Diálogo aberto (só em DIALOG_PENDING). */
  dialog;
  constructor(code, message, options) {
    super(message, options?.cause === void 0 ? void 0 : { cause: options.cause });
    this.name = "BrowserError";
    this.code = code;
    if (options && "occluder" in options) this.occluder = options.occluder;
    if (options?.dialog) this.dialog = options.dialog;
  }
};
function describeOccluder(o) {
  if (!o) return "nothing (no element at the point)";
  const id = o.id ? `#${o.id}` : "";
  const name = o.name ? ` "${o.name}"` : "";
  return `${o.role}${name} (<${o.tag}${id}>)`;
}

// ../../packages/browser/src/core/page-fn.ts
var SHIM = "const __name=(f)=>f;";
function pageFn(fn) {
  const src = `(()=>{${SHIM}return (${Function.prototype.toString.call(fn)})})()`;
  const wrapped = ((...args) => fn(...args));
  wrapped.toString = () => src;
  return wrapped;
}

// ../../packages/browser/src/core/aim.ts
function topAt(p) {
  let el = document.elementsFromPoint(p.x, p.y)[0] ?? null;
  while (el && el.shadowRoot) {
    const inner = el.shadowRoot.elementsFromPoint(p.x, p.y)[0] ?? null;
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}
function inspect(a) {
  const { top, target } = a;
  const composedContains = (root, node) => {
    let cur = node;
    while (cur) {
      if (cur === root) return true;
      const parent = cur.assignedSlot ?? cur.parentNode;
      cur = parent instanceof ShadowRoot ? parent.host : parent;
    }
    return false;
  };
  let isTarget = false;
  if (target) {
    isTarget = composedContains(target, top);
    const label = top.closest("label");
    if (!isTarget && label && label.control === target) isTarget = true;
  }
  const tag = top.tagName.toLowerCase();
  const isFrame = tag === "iframe" || tag === "frame";
  const rect = top.getBoundingClientRect();
  const cs = getComputedStyle(top);
  const offset = {
    left: rect.left + top.clientLeft + parseFloat(cs.paddingLeft || "0"),
    top: rect.top + top.clientTop + parseFloat(cs.paddingTop || "0")
  };
  const roles = {
    a: "link",
    button: "button",
    select: "combobox",
    textarea: "textbox",
    img: "img",
    h1: "heading",
    h2: "heading",
    h3: "heading",
    h4: "heading",
    h5: "heading",
    h6: "heading",
    nav: "navigation",
    main: "main",
    dialog: "dialog",
    ul: "list",
    ol: "list",
    li: "listitem",
    table: "table",
    form: "form",
    iframe: "iframe",
    label: "label"
  };
  let role = top.getAttribute("role") || roles[tag] || "generic";
  if (tag === "input") {
    const t = top.type;
    role = t === "checkbox" || t === "radio" ? t : t === "button" || t === "submit" ? "button" : "textbox";
  }
  const labelledBy = top.getAttribute("aria-labelledby");
  const labelledText = labelledBy ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ") : "";
  const raw2 = top.getAttribute("aria-label") || labelledText || top.getAttribute("alt") || (tag === "input" ? top.value || top.getAttribute("placeholder") : "") || top.getAttribute("title") || top.textContent || "";
  const name = raw2.replace(/\s+/g, " ").trim().slice(0, 80);
  return { isTarget, isFrame, offset, desc: { tag, role, name, ...top.id ? { id: top.id } : {} } };
}
function candidatePoints(b) {
  const at = (fx, fy) => ({ x: b.x + b.width * fx, y: b.y + b.height * fy });
  return [at(0.5, 0.5), at(0.25, 0.25), at(0.75, 0.25), at(0.25, 0.75), at(0.75, 0.75)];
}
function clipToViewport(raw2, vp) {
  const x1 = Math.max(raw2.x, 0);
  const y1 = Math.max(raw2.y, 0);
  const x2 = Math.min(raw2.x + raw2.width, vp.width);
  const y2 = Math.min(raw2.y + raw2.height, vp.height);
  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

// ../../packages/browser/src/core/path.ts
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 1831565813 >>> 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
var clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
var between = (rng3, lo, hi) => lo + rng3() * (hi - lo);
var easeInOut = (t) => t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
function planPath(from, to, rng3, minSteps = 8) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.hypot(dx, dy);
  const steps = clamp(Math.round(d / 10), minSteps, Math.max(64, minSteps));
  let c1 = { x: from.x + dx / 3, y: from.y + dy / 3 };
  let c2 = { x: from.x + 2 * dx / 3, y: from.y + 2 * dy / 3 };
  if (d >= 12) {
    const nx = -dy / d;
    const ny = dx / d;
    const o1 = (rng3() < 0.5 ? -1 : 1) * between(rng3, 0.1, 0.25) * d;
    const o2 = (rng3() < 0.5 ? -1 : 1) * between(rng3, 0.1, 0.25) * d;
    c1 = { x: c1.x + nx * o1, y: c1.y + ny * o1 };
    c2 = { x: c2.x + nx * o2, y: c2.y + ny * o2 };
  }
  const pts = [];
  for (let i = 1; i <= steps; i++) {
    if (i === steps) {
      pts.push({ x: to.x, y: to.y });
      break;
    }
    const t = easeInOut(i / steps);
    const u = 1 - t;
    const bx = u ** 3 * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * to.x;
    const by = u ** 3 * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * to.y;
    pts.push({
      x: Math.round(bx + (d >= 12 ? between(rng3, -1, 1) : 0)),
      y: Math.round(by + (d >= 12 ? between(rng3, -1, 1) : 0))
    });
  }
  return pts;
}

// ../../packages/browser/src/core/input.ts
var MASK = { left: 1, right: 2, middle: 4 };
function buttonsMask(buttons) {
  let m = 0;
  for (const b of buttons) m |= MASK[b];
  return m;
}
function mouseMove(t, x, y, buttons = []) {
  const held = [...buttons];
  return t.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: held[0] ?? "none",
    buttons: buttonsMask(held),
    modifiers: 0,
    force: held.length ? 0.5 : 0
  }).then(() => void 0);
}
function mouseDown(t, x, y, button, clickCount = 1, held = []) {
  return t.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button,
    buttons: buttonsMask(held) | MASK[button],
    clickCount,
    modifiers: 0,
    force: 0.5
  }).then(() => void 0);
}
function mouseUp(t, x, y, button, clickCount = 1, held = []) {
  return t.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button,
    buttons: buttonsMask(held) & ~MASK[button],
    clickCount,
    modifiers: 0,
    force: 0
  }).then(() => void 0);
}
function mouseWheel(t, x, y, deltaX, deltaY) {
  return t.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY, modifiers: 0 }).then(() => void 0);
}
function insertText(t, text) {
  return t.send("Input.insertText", { text }).then(() => void 0);
}

// ../../packages/browser/src/core/tool-texts.ts
var REF = 'Element ref from the latest WebSnapshot of this tab (for example "e12"; a ref with a prefix such as "f1e140" belongs to an iframe and is just as valid).';
var REF_OR_POINT = `${REF} Alternatively give x and y instead of ref.`;
var X = "Horizontal pixel coordinate in the viewport (use together with y, instead of ref).";
var Y = "Vertical pixel coordinate in the viewport (use together with x, instead of ref).";
var TOOL_TEXTS = {
  navigate: {
    name: "WebNavigate",
    description: "Open a URL in your browser tab and wait for the page to load. Returns the final URL and the page title. Only public http(s) addresses are reachable; addresses inside the machine or its private network are refused.",
    params: { url: 'Absolute URL, for example "https://example.com/".' }
  },
  snapshot: {
    name: "WebSnapshot",
    description: "Read the page as an accessibility tree. Interactive elements carry a ref like [ref=e12] and a box [box=x,y,width,height]. Use it before acting: every ref you pass to the other Web tools must come from the latest snapshot of the same tab, and a navigation makes older refs stale. Refs with a prefix, such as [ref=f1e140], belong to an iframe (f1 is the first frame); they are valid like any other ref. Large pages can pass 30000 characters: pass ref to read only one region, maxChars to cap the size (a truncation notice is added) or depth for a shallower tree. To only read text use WebRead; to see the page use WebScreenshot.",
    params: {
      depth: "Limit the depth of the tree on very large pages.",
      ref: "Read only the region under this element, a ref from an earlier snapshot of this tab. Like any snapshot it replaces the previous one: refs from outside the region go stale, so take a full snapshot again to act there.",
      maxChars: "Character limit of the tree. When it is cut, the result says truncated and how to narrow down. Default: no limit."
    }
  },
  read: {
    name: "WebRead",
    description: "Read the text of the page (the main content when the page has one). Cheaper than WebSnapshot when you only need to read. Says when the text was truncated.",
    params: { maxChars: "Character limit before the text is cut. Default 50000." }
  },
  find: {
    name: "WebFind",
    description: "Search the page for elements by role, accessible name or text, without reading the whole tree. Takes a fresh snapshot, so the returned refs work right away in WebClick, WebType and the other Web tools. Give at least one of role, name or text; matches are case-insensitive. Returns a list of { ref, role, name, box }.",
    params: {
      role: "Exact ARIA role, for example button, link or textbox.",
      name: "Part of the accessible name.",
      text: "Part of the visible text of the element (its name or its own text).",
      limit: "Maximum results. Default 20."
    }
  },
  get_links: {
    name: "WebLinks",
    description: "List the visible links of the page: { ref, text, href } with absolute URLs, without repeating the same href and text. Takes a fresh snapshot, so the refs work in WebClick. Hidden links are left out, and so are links with neither text nor accessible name (pass includeUnnamed to see them).",
    params: {
      limit: "Maximum links. Default 100.",
      includeUnnamed: "Also list links with no text and no accessible name (icons without a label, empty anchors). Default false."
    }
  },
  click: {
    name: "WebClick",
    description: "Click like a person: the pointer travels to the element, then presses and releases the button. If something covers the target, the error names what covers it. Returns what was clicked, whether the page navigated, any native dialog that opened and any new tabs. When the click starts a navigation it waits briefly for it to commit, so url is the destination; navigationPending: true means it had not committed yet (use WebWait). After a click that navigates, take a new WebSnapshot.",
    params: {
      ref: REF_OR_POINT,
      x: X,
      y: Y,
      button: '"left" (default), "right" (opens the context menu) or "middle".',
      count: "1 (default), 2 (double click) or 3 (triple click)."
    }
  },
  hover: {
    name: "WebHover",
    description: "Move the pointer over an element and leave it there, so hover menus and tooltips appear. Use WebSnapshot or WebScreenshot afterwards to see them.",
    params: { ref: REF_OR_POINT, x: X, y: Y }
  },
  drag: {
    name: "WebDrag",
    description: "Drag from one element or point and drop on another, with the real pointer (sortable lists, sliders, drag and drop zones).",
    params: {
      ref: `Source. ${REF}`,
      x: "Source x coordinate in the viewport (use together with y, instead of ref).",
      y: "Source y coordinate in the viewport (use together with x, instead of ref).",
      toRef: `Destination. ${REF}`,
      toX: "Destination x coordinate in the viewport (use together with toY, instead of toRef).",
      toY: "Destination y coordinate in the viewport (use together with toX, instead of toRef)."
    }
  },
  type: {
    name: "WebType",
    description: 'Type text with the keyboard. With a ref it clicks the field first and appends the text at the end; without a ref it types into the element that has focus. Use "\\n" for Enter. To replace what a field already holds use WebFill.',
    params: {
      text: "The text to type.",
      ref: `Field to click first. ${REF}`,
      mode: '"keys" types key by key (default up to 200 characters); "paste" inserts all at once.'
    }
  },
  fill: {
    name: "WebFill",
    description: "Replace the content of a text field: clicks it, selects everything, deletes, then types the new text. Returns the value the field really holds afterwards (masks or autocomplete may change it) and whether it matches.",
    params: { ref: REF, text: "The new content.", mode: '"keys" or "paste" (default: keys up to 200 characters).' }
  },
  press_key: {
    name: "WebPressKey",
    description: 'Press a key or a combination, for example "Enter", "Tab", "Escape", "ArrowDown" or "Control+A". The key goes to the element that has focus. When the key starts a navigation (Enter in a search form) it waits briefly for it to commit, so navigated and url describe the new page; navigationPending: true means it had not committed yet (use WebWait).',
    params: {
      key: 'Key or combination, for example "Control+Shift+P". For a capital letter pass "A" with hold ["Shift"].',
      hold: 'Keys to keep pressed while the key is pressed, for example ["Shift"].'
    }
  },
  select_option: {
    name: "WebSelectOption",
    description: "Choose an option of a native select (dropdown) by its label, value or position. Reports the option that ended up selected, and fails if the label matches more than one option.",
    params: {
      ref: `The select. ${REF}`,
      label: "Visible text of the option.",
      value: "The option value attribute.",
      index: "Zero-based position of the option.",
      programmatic: "Set true only for a select that allows several options, or when the normal way failed."
    }
  },
  set_checked: {
    name: "WebSetChecked",
    description: "Leave a checkbox, radio button or switch checked or unchecked. It clicks only if the current state is different, then confirms the result.",
    params: { ref: REF, checked: "The state you want." }
  },
  scroll: {
    name: "WebScroll",
    description: "Scroll with the mouse wheel, over the page or over a scrollable area. Returns how far the area really moved. Give one of by or to.",
    params: {
      ref: `Put the pointer over this element first (its scrollable area receives the wheel). ${REF}`,
      x: X,
      y: Y,
      byX: "Pixels to scroll right (negative: left).",
      byY: "Pixels to scroll down (negative: up).",
      to: '"top" or "bottom": scroll until the area stops moving.'
    }
  },
  screenshot: {
    name: "WebScreenshot",
    description: "Take a picture of the page and see it. By default the visible viewport; or the whole page, one element, or a rectangle, optionally zoomed in to read small text.",
    params: {
      fullPage: "The whole page, not only the viewport.",
      ref: `Only this element. ${REF}`,
      clipX: "Rectangle left edge in viewport pixels (give clipX, clipY, clipWidth and clipHeight together).",
      clipY: "Rectangle top edge in viewport pixels.",
      clipWidth: "Rectangle width in pixels.",
      clipHeight: "Rectangle height in pixels.",
      zoom: "Magnify the element or rectangle from 1 to 4 times, sharp.",
      format: '"png" (default) or "jpeg".',
      quality: "JPEG quality from 1 to 100."
    }
  },
  save_pdf: {
    name: "WebSavePdf",
    description: "Save the current page as a PDF file. Returns the file path and size.",
    params: {
      format: "Paper size: a4 (default), letter, legal, tabloid, ledger, a0 to a6.",
      landscape: "Landscape orientation.",
      printBackground: "Print backgrounds and colors (default true).",
      scale: "Scale from 0.1 to 2 (default 1).",
      pageRanges: 'Pages to print, for example "1-3, 5". Default: all.'
    }
  },
  tabs: {
    name: "WebTabs",
    description: "List your browser tabs with their id, address and title, and which one is active. Tabs opened by pages appear here with a new id.",
    params: {}
  },
  new_tab: {
    name: "WebNewTab",
    description: "Open a new tab (optionally at a URL) and make it the active one. A session holds at most 8 tabs.",
    params: { url: "Absolute URL to open. Omit for a blank tab." }
  },
  close_tab: {
    name: "WebCloseTab",
    description: "Close a tab. Closing the active tab activates a neighbour.",
    params: { tab: 'Tab id such as "t2". Default: the active tab.' }
  },
  activate_tab: {
    name: "WebActivateTab",
    description: "Make a tab the active one. Every other Web tool acts on the active tab. Refs from a snapshot only work in the tab where it was taken.",
    params: { tab: 'Tab id such as "t2".' }
  },
  resize: {
    name: "WebResize",
    description: "Change the size of the browser window (the viewport). Returns the size measured in the page.",
    params: { width: "Width in pixels, 100 to 4000.", height: "Height in pixels, 100 to 4000." }
  },
  wait: {
    name: "WebWait",
    description: "Wait until a text appears on the page, an element becomes visible or hidden, the URL contains a string, or the URL changes. Give exactly one condition. Fails if it does not happen in time. The condition is checked right at the start: if it is already true (the URL already contains the string, the text is already there) it returns at once. To wait for a navigation that is still coming, use urlChanged, not url.",
    params: {
      text: "Text that must appear in the page (case sensitive).",
      ref: `Element to wait for. ${REF}`,
      state: 'With ref: "visible" (default) or "hidden" (it disappears, for example a spinner).',
      url: "String the page URL must contain. Checked at the start: it passes at once if the URL already contains it.",
      urlChanged: "true: wait until the page URL differs from the one it had when this wait began (for a navigation you just triggered).",
      timeoutMs: "How long to wait, up to 120000. Default 15000."
    }
  },
  dialog: {
    name: "WebDialog",
    description: "Answer a native dialog (alert, confirm, prompt, beforeunload) that a page opened. While a dialog is open the page is blocked and every other Web tool fails until you answer it. Nothing is accepted or dismissed for you.",
    params: { accept: "true to accept (OK), false to dismiss (Cancel).", promptText: "Text to enter when it is a prompt." }
  },
  console: {
    name: "WebConsole",
    description: "Read what the page wrote to the browser console and its uncaught errors, including what happened before this call.",
    params: {
      tab: "Tab id. Default: the active tab.",
      level: 'Minimum level: "debug", "log", "info", "warning" or "error".',
      afterSeq: "Only entries after this sequence number.",
      limit: "Maximum entries, default 100, at most 500.",
      clear: "Empty the console record after reading."
    }
  },
  network: {
    name: "WebNetwork",
    description: "Inspect the requests the page made: method, URL, status, type and timing. Pass id to get one request in detail. Response bodies are only kept after you turn captureBodies on, and only for text types.",
    params: {
      tab: "Tab id. Default: the active tab.",
      id: "Request id from the list, for detail.",
      body: "Include captured request and response bodies.",
      captureBodies: "Turn body capture on or off from now on.",
      urlIncludes: "Only requests whose URL contains this text.",
      status: 'An HTTP status such as "404", or "failed" or "blocked".',
      type: "Resource type such as document, xhr, fetch, script, image.",
      afterSeq: "Only entries after this sequence number."
    }
  },
  download: {
    name: "WebDownload",
    description: "List the files the page downloaded, or wait for the next one to finish. Downloads are saved in the session folder; the result gives the path and size.",
    params: { wait: "true: wait for the next download to finish. false (default): list the downloads so far.", timeoutMs: "How long to wait, with wait. Default 15000." }
  }
};
var LOCAL_TOOL_TEXTS = {
  evaluate: {
    name: "WebEvaluate",
    description: "Run a JavaScript expression in the page of the active tab and return its value as JSON (top-level await works; a returned promise is awaited). The code runs with full page privileges: it can read and change anything the page can, including the DOM and non-httpOnly storage. Use it to read data the other Web tools cannot reach (for example a JavaScript variable or the computed state of a widget); for ordinary clicking and typing prefer WebClick, WebType and WebFill, which behave like a real user. Available only in the local browser; results over 100000 characters are refused, not cut.",
    params: { expression: 'JavaScript expression or statements; the value of the last expression is returned. Example: "document.title".' }
  },
  upload: {
    name: "WebUpload",
    description: 'Attach a file from the disk of this computer to a file field of the page (an input of type file, or the button that opens the file chooser). Give the absolute path of the file. This sends the file contents to the website, so the operator must authorize it: unless an authorization already covers it, the operator is asked (the MCP client shows the file, its folder and the destination site) and answers "decline", "only this file" or "this folder to this site until the end of the session". An authorization is always a PAIR of one folder (and its subfolders) and one exact site (scheme, host and port of the page that owns the field); any other folder or site asks again. A folder that is too broad (a drive root, the home folder, an allowed upload folder itself, or a folder with .env, .git or .ssh in it) never becomes a pair: its files go only one at a time. If the page that owns the field changes site while the file is being attached, the field is emptied and the upload is refused. If the operator declines, or nobody can answer (a client without elicitation, or an agent running in the background), nothing is sent and the error says how to get it authorized: the operator calls WebAllowUploads with that folder and that site, from a session where the question can be shown. Files in a folder the operator pre-authorized (ATRIUM_BROWSER_UPLOAD_DIRS_TRUSTED) go without asking. A field inside an embedded frame from another site than the tab is never covered by an authorization or a pre-authorized folder: it is asked every time, or refused. Only files inside the allowed upload folders are accepted (by default the Downloads folder of the user; the operator can list others in the ATRIUM_BROWSER_UPLOAD_DIRS environment variable of this MCP server, absolute paths separated by ";" on Windows and ":" elsewhere). A path outside them is refused with an explanation. Returns how many files were attached and their names.',
    params: {
      ref: 'Ref of the file input or of the control that opens the file chooser, from the latest WebSnapshot of this tab (for example "e12").',
      path: 'Absolute path of the file on this computer, for example "C:/Users/me/Downloads/report.pdf" or "/home/me/Downloads/report.pdf".'
    }
  },
  allow_uploads: {
    name: "WebAllowUploads",
    description: "Ask the operator, ahead of time, to allow WebUpload to send files from one folder (and its subfolders) to one exact site until this MCP session ends, without asking again for each file. Use it before uploads that will run where the question cannot be shown (for example a background agent), or when many files from the same folder go to the same site. The operator sees the folder and the site and answers yes or no; if this MCP client cannot ask (no elicitation), the request is refused. The folder must be inside the allowed upload folders (ATRIUM_BROWSER_UPLOAD_DIRS; by default Downloads) and must not be too broad: a drive root, the home folder, an allowed upload folder itself, or a folder with .env, .git or .ssh directly in it is refused without asking; use a subfolder that holds only the files to send. The authorization lives only in the memory of this MCP server: it is never written to disk and ends when the server stops, or when the browser process has to be restarted after a crash (the answer that follows says so); WebSetGpu keeps it. It never covers a field embedded from another site. See the current authorizations with WebUploadPermissions; remove them with WebRevokeUploads.",
    params: {
      folder: 'Absolute path of the folder whose files may be sent, for example "C:/Users/me/Downloads/invoices". Links are resolved: the real folder is what is authorized.',
      origin: 'The exact site that may receive them: scheme, host and port, for example "https://portal.example.com" or "http://localhost:3000". A path after it is ignored.'
    }
  },
  upload_permissions: {
    name: "WebUploadPermissions",
    description: "List the upload authorizations of this MCP session: each pair of folder and site that WebUpload may use without asking, with when and how it was granted. They live only in memory and end with the session. Folders pre-authorized by the operator in ATRIUM_BROWSER_UPLOAD_DIRS_TRUSTED are listed apart.",
    params: {}
  },
  revoke_uploads: {
    name: "WebRevokeUploads",
    description: "Remove upload authorizations of this MCP session for one site: all of them for that site, or only the one for a given folder. Uploads from then on ask the operator again. Returns what was removed and what is left. It does not touch ATRIUM_BROWSER_UPLOAD_DIRS_TRUSTED.",
    params: {
      folder: "Absolute path of the folder to remove. Omit it to remove every authorization for the site.",
      origin: 'The site whose authorizations are removed: scheme, host and port, for example "https://portal.example.com".'
    }
  },
  set_gpu: {
    name: "WebSetGpu",
    description: "Choose how the browser draws pages: with the graphics card (GPU on, the default: the browser decides, like a normal Chromium) or only with the CPU (GPU off: steadier, but heavy on the CPU). Changing it RESTARTS the browser: every tab is closed and reopened at the same address, saved logins are kept, but whatever the pages held in memory is lost (unsent form text, scroll position, page state), so take a new WebSnapshot before acting again. While the browser is open, a call without confirm: true changes nothing: it reports the current mode and the tabs that would be closed; call again with confirm: true to apply. If no browser is open, or it already runs in the mode you ask for, there is nothing to confirm. Turn it OFF when pages freeze or go black, or when WebScreenshot or WebClick wait for a frame and never answer. Turn it ON when maps, 3D, video or WebGL pages do not work, or when the machine is slow (drawing on the CPU is heavy). Your choice lasts for the whole session, even if the browser process has to be restarted. Every answer says the current mode and whether it is the default or your choice.",
    params: {
      gpu: '"on" or "off".',
      confirm: "true to apply the change while the browser is open (it restarts the browser). Omit it to only see the current mode and what would be closed."
    }
  }
};
var ADOPT_TOOL_TEXTS = {
  ask_user: {
    name: "WebAskUser",
    description: 'Ask the person to do something in the active tab that only they can do, and wait until they hand the tab back. Use it when you are blocked by a login (a password, a two-factor code, a passkey), a captcha or a check that says you are a robot, or when the next step is a decision that belongs to the person (a purchase, sending a message in their name, accepting terms). Do not use it for things you can do yourself, and do not ask twice for the same thing. The tab goes to the person at once and this call WAITS for them, possibly many minutes: you cannot use the tab meanwhile, and the call ends when the person hands the tab back, dismisses the request, or when the wait runs out. Write the message as a short plain sentence that says what you need and why ("Log in to github.com so I can open the repository"); it is shown to the person as plain text and is cut at 500 characters. The answer says how it ended. After the tab comes back the page may have changed: take a new WebSnapshot before acting. Never ask the person to type a secret in the chat; this tool is how they enter it, in the page itself.',
    params: {
      message: "What you need from the person, in one or two plain sentences (text only, cut at 500 characters).",
      kind: '"login" when you need the person to sign in (the host hands the tab over clean of scripts), "other" for anything else. Default "other".'
    }
  }
};
var ASK_USER_TIMEOUT_MS = 30 * 6e4;

// ../../packages/browser/src/core/catalog.ts
var TOOL_TIERS = {
  navigate: "standard",
  snapshot: "standard",
  read: "standard",
  find: "standard",
  get_links: "standard",
  click: "standard",
  hover: "standard",
  drag: "standard",
  type: "standard",
  fill: "standard",
  press_key: "standard",
  select_option: "standard",
  set_checked: "standard",
  scroll: "standard",
  screenshot: "standard",
  tabs: "standard",
  new_tab: "standard",
  close_tab: "standard",
  activate_tab: "standard",
  wait: "standard",
  dialog: "standard",
  console: "standard",
  save_pdf: "advanced",
  resize: "advanced",
  network: "advanced",
  download: "advanced"
};
var str = { type: "string" };
var num = { type: "number" };
var int = { type: "integer" };
var bool = { type: "boolean" };
function build(text, op, params, required) {
  const texts = text.params;
  const properties = {};
  for (const [key, spec] of Object.entries(params)) {
    const description = texts[key];
    if (!description) throw new Error(`tool-texts: ${op}.${key} has no description`);
    const { type: type2, ...rest } = spec;
    properties[key] = type2 === "string[]" ? { type: "array", items: { type: "string" }, description, ...rest } : { type: type2, description, ...rest };
  }
  for (const key of Object.keys(texts)) {
    if (!(key in properties)) throw new Error(`tool-texts: ${op}.${key} is described but not declared in the catalog`);
  }
  return {
    name: text.name,
    description: text.description,
    inputSchema: { type: "object", properties, ...required.length ? { required } : {}, additionalProperties: false }
  };
}
function def(op, params, required = []) {
  return { op, scope: "server", tier: TOOL_TIERS[op], ...build(TOOL_TEXTS[op], op, params, required) };
}
function defLocal(op, params, required, destructive) {
  return { op, scope: "local", tier: "advanced", destructive, ...build(LOCAL_TOOL_TEXTS[op], op, params, required) };
}
function defAdopt(op, params, required) {
  return { op, scope: "local", tier: "advanced", ...build(ADOPT_TOOL_TEXTS[op], op, params, required) };
}
var PDF_FORMATS = ["letter", "legal", "tabloid", "ledger", "a0", "a1", "a2", "a3", "a4", "a5", "a6"];
var BROWSER_CATALOG = Object.freeze([
  def("navigate", { url: str }, ["url"]),
  def("snapshot", { depth: { ...int, minimum: 1 }, ref: str, maxChars: { ...int, minimum: 1 } }),
  def("read", { maxChars: { ...int, minimum: 1 } }),
  def("find", { role: str, name: str, text: str, limit: { ...int, minimum: 1 } }),
  def("get_links", { limit: { ...int, minimum: 1 }, includeUnnamed: bool }),
  def("click", { ref: str, x: num, y: num, button: { ...str, enum: ["left", "right", "middle"] }, count: { ...int, enum: [1, 2, 3] } }),
  def("hover", { ref: str, x: num, y: num }),
  def("drag", { ref: str, x: num, y: num, toRef: str, toX: num, toY: num }),
  def("type", { text: str, ref: str, mode: { ...str, enum: ["keys", "paste"] } }, ["text"]),
  def("fill", { ref: str, text: str, mode: { ...str, enum: ["keys", "paste"] } }, ["ref", "text"]),
  def("press_key", { key: str, hold: { type: "string[]" } }, ["key"]),
  def("select_option", { ref: str, label: str, value: str, index: { ...int, minimum: 0 }, programmatic: bool }, ["ref"]),
  def("set_checked", { ref: str, checked: bool }, ["ref", "checked"]),
  def("scroll", { ref: str, x: num, y: num, byX: num, byY: num, to: { ...str, enum: ["top", "bottom"] } }),
  def("screenshot", {
    fullPage: bool,
    ref: str,
    clipX: num,
    clipY: num,
    clipWidth: { ...num, minimum: 1 },
    clipHeight: { ...num, minimum: 1 },
    zoom: { ...num, minimum: 1, maximum: 4 },
    format: { ...str, enum: ["png", "jpeg"] },
    quality: { ...int, minimum: 1, maximum: 100 }
  }),
  def("save_pdf", {
    format: { ...str, enum: PDF_FORMATS },
    landscape: bool,
    printBackground: bool,
    scale: { ...num, minimum: 0.1, maximum: 2 },
    pageRanges: str
  }),
  def("tabs", {}),
  def("new_tab", { url: str }),
  def("close_tab", { tab: str }),
  def("activate_tab", { tab: str }, ["tab"]),
  def("resize", { width: { ...int, minimum: 100, maximum: 4e3 }, height: { ...int, minimum: 100, maximum: 4e3 } }, ["width", "height"]),
  def("wait", { text: str, ref: str, state: { ...str, enum: ["visible", "hidden"] }, url: str, urlChanged: bool, timeoutMs: { ...int, minimum: 1, maximum: 12e4 } }),
  def("dialog", { accept: bool, promptText: str }, ["accept"]),
  def("console", {
    tab: str,
    level: { ...str, enum: ["debug", "log", "info", "warning", "error"] },
    afterSeq: { ...int, minimum: 0 },
    limit: { ...int, minimum: 1, maximum: 500 },
    clear: bool
  }),
  def("network", { tab: str, id: str, body: bool, captureBodies: bool, urlIncludes: str, status: str, type: str, afterSeq: { ...int, minimum: 0 } }),
  def("download", { wait: bool, timeoutMs: { ...int, minimum: 1 } })
]);
var LOCAL_CATALOG = Object.freeze([
  defLocal("evaluate", { expression: str }, ["expression"], false),
  defLocal("upload", { ref: str, path: str }, ["ref", "path"], true),
  defLocal("allow_uploads", { folder: str, origin: str }, ["folder", "origin"], true),
  defLocal("upload_permissions", {}, [], false),
  defLocal("revoke_uploads", { folder: str, origin: str }, ["origin"], false),
  defLocal("set_gpu", { gpu: { ...str, enum: ["on", "off"] }, confirm: bool }, ["gpu"], false)
]);
var ADOPT_CATALOG = Object.freeze([defAdopt("ask_user", { message: str, kind: { ...str, enum: ["login", "other"] } }, ["message"])]);
var STANDARD_TOOLS = Object.freeze(BROWSER_CATALOG.filter((t) => t.tier === "standard"));

// ../../packages/browser/src/core/cosmetics/colors.ts
var HEX = String.raw`#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})`;
var NUM = String.raw`\d{1,3}(?:\.\d+)?%?`;
var RGB = String.raw`rgba?\( *${NUM} *[, ] *${NUM} *[, ] *${NUM} *(?:[,/] *(?:\d?\.?\d{1,3}%?) *)?\)`;
var COLOR = new RegExp(`^(?:${HEX}|${RGB})$`, "i");
var LEN = String.raw`(?:0|-?\d{1,3}(?:\.\d+)?px)`;
var LAYER = String.raw`(?:inset +)?${LEN}(?: +${LEN}){1,3} +(?:${HEX}|${RGB})`;
var SHADOW = new RegExp(String.raw`^${LAYER}(?: *, *${LAYER}){0,3}$`, "i");

// ../../packages/browser/src/core/cosmetics/style.ts
var glowRule = (glow) => `.glow{position:fixed;inset:0;pointer-events:none;border-radius:0;opacity:1;
  box-shadow:${glow}}`;
var css = (glow, ring) => `
:host{all:initial}
${glow === null ? "" : glowRule(glow)}
.cursor{position:fixed;left:0;top:0;pointer-events:none;display:none;
  filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))}
.cursor svg{display:none}
.cursor svg.on{display:block}
.cursor.pressed svg{transform:scale(.88);transform-origin:var(--hx) var(--hy)}
.ring{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;pointer-events:none;
  border:2px solid ${ring.border};background:${ring.fill};
  animation:ripple .5s ease-out forwards}
@keyframes ripple{from{transform:scale(.4);opacity:1}to{transform:scale(1.6);opacity:0}}
.scroll.kick{animation:kick .15s ease-out}
@keyframes kick{from{transform:translate(var(--dx),var(--dy))}to{transform:translate(0,0)}}
`;
var GLOW_GEOMETRY = "inset 0 0 60px 14px";
var BRAND_GLOW = `${GLOW_GEOMETRY} rgba(215,129,61,.55)`;
var BRAND_RING = { border: "rgba(215,129,61,.9)", fill: "rgba(215,129,61,.18)" };
var COSMETICS_CSS = css(BRAND_GLOW, BRAND_RING);

// extension/src/page.ts
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function pageEval(t, expression) {
  const r = await t.send("Runtime.evaluate", { expression, returnByValue: true });
  if (r.exceptionDetails) {
    throw new BrowserError("EVALUATE_FAILED", `page script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  }
  return r.result?.value;
}
function withTimeout(p, ms, onTimeout) {
  if (!(ms > 0 && ms <= 2147483647)) return p;
  let timer2;
  const timeout = new Promise((_, reject) => {
    timer2 = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer2));
}

// extension/src/brand.ts
var DEFAULT_BRAND = { name: "Atrium", product: "Atrium Bridge" };
var BUILD_BRAND = typeof define_BRAND_default === "undefined" ? DEFAULT_BRAND : { ...DEFAULT_BRAND, ...define_BRAND_default };
var brandName = () => BUILD_BRAND.name;
var productName = () => BUILD_BRAND.product;
var DEFAULT_GROUP_TITLE = "{shortName}";
var DEFAULT_AGENT_TITLE = "{shortName} \xB7 {agent}";
var DEFAULT_GROUP_COLOR = "grey";
function renderTemplate(template, vars) {
  return template.replace(/\{([A-Za-z]+)\}/g, (m, key) => key in vars ? vars[key] : m).trim();
}
var groupTitle = () => renderTemplate(BUILD_BRAND.tabs?.groupTitle ?? DEFAULT_GROUP_TITLE, { shortName: BUILD_BRAND.name });
var agentGroupTitle = (agent) => renderTemplate(BUILD_BRAND.tabs?.agentTitle ?? DEFAULT_AGENT_TITLE, { shortName: BUILD_BRAND.name, agent });
var brandGroupColor = () => BUILD_BRAND.tabs?.groupColor ?? DEFAULT_GROUP_COLOR;
var brandAccent = () => BUILD_BRAND.colors?.accent ?? BUILD_BRAND.color;

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
function ownerGroupTitle(client) {
  return agentGroupTitle(client.name ?? client.id);
}
var RELEASED_SUFFIX = " (encerrado)";
function releasedGroupTitle(title) {
  return title.endsWith(RELEASED_SUFFIX) ? title : `${title}${RELEASED_SUFFIX}`;
}

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
async function setStatus(status) {
  await chrome.storage.session.set({ [STATUS_KEY]: status });
}
var ALLOW_EVALUATE_KEY = "allowEvaluate";
async function getAllowEvaluate() {
  return (await chrome.storage.local.get(ALLOW_EVALUATE_KEY))[ALLOW_EVALUATE_KEY] === true;
}
var ALLOW_EVALUATE_STORAGE_KEY = ALLOW_EVALUATE_KEY;
var DEBUG_CHOICE_STORAGE_KEY = "debugChoice";
var HOST_DEBUG_STORAGE_KEY = "hostDebugMode";
async function getDebugChoice() {
  const v = (await chrome.storage.local.get(DEBUG_CHOICE_STORAGE_KEY))[DEBUG_CHOICE_STORAGE_KEY];
  return v && typeof v.enabled === "boolean" ? v : null;
}
async function saveHostDebugMode(mode) {
  await chrome.storage.local.set({ [HOST_DEBUG_STORAGE_KEY]: mode ?? null });
}
var SETTINGS_KEYS = ["port", "token", "name"];
async function saveHostBrand(brand, opts = {}) {
  if (opts.onlyIfMissing && await loadHostBrand()) return;
  if (brand) await chrome.storage.local.set({ hostBrand: brand });
  else await chrome.storage.local.remove("hostBrand");
}
async function loadHostBrand() {
  return (await chrome.storage.local.get("hostBrand")).hostBrand ?? null;
}
async function saveHostCapabilities(capabilities) {
  if (capabilities) await chrome.storage.local.set({ hostCapabilities: capabilities });
  else await chrome.storage.local.remove("hostCapabilities");
}
async function loadHostCapabilities() {
  return (await chrome.storage.local.get("hostCapabilities")).hostCapabilities ?? null;
}
async function capability(name, fallback) {
  const host = (await loadHostCapabilities())?.[name];
  if (typeof host === "boolean") return host;
  const packaged = BUILD_BRAND.capabilities?.[name];
  if (typeof packaged === "boolean") return packaged;
  return fallback;
}
var windowPerAgent = () => capability("windowPerAgent", true);
var EVALUATE_MODES = ["off", "own-tabs", "all"];
async function evaluateMode() {
  const host = (await loadHostCapabilities())?.evaluate;
  if (typeof host === "string" && EVALUATE_MODES.includes(host)) return host;
  const packaged = BUILD_BRAND.capabilities?.evaluate;
  if (packaged && EVALUATE_MODES.includes(packaged)) return packaged;
  return "own-tabs";
}
var HOST_STATUS_KEY = "hostStatus";
async function saveHostStatus(status) {
  await chrome.storage.session.set({ [HOST_STATUS_KEY]: status });
}
async function loadHostStatus() {
  return (await chrome.storage.session.get(HOST_STATUS_KEY))[HOST_STATUS_KEY] ?? { paused: false, clients: [] };
}

// extension/src/scope.ts
var GROUP_TITLE = groupTitle();
var SCOPE_KEY = "scope";
var CURRENT_KEY = "currentTab";
var CURRENT_BY_OWNER_KEY = "currentByOwner";
var CLIENT_NAMES_KEY = "clientNames";
var WINDOW_BY_OWNER_KEY = "windowByOwner";
var cache = null;
async function load() {
  if (!cache) cache = (await chrome.storage.session.get(SCOPE_KEY))[SCOPE_KEY] ?? {};
  return cache;
}
async function save() {
  await chrome.storage.session.set({ [SCOPE_KEY]: cache });
}
async function isScoped(tabId) {
  return String(tabId) in await load();
}
async function isGrouped(tabId) {
  return (await load())[String(tabId)]?.grouped === true;
}
async function entryOf(tabId) {
  return (await load())[String(tabId)];
}
async function listScope() {
  return Object.keys(await load()).map(Number);
}
async function listEntries() {
  return Object.entries(await load()).map(([id, e]) => [Number(id), e]);
}
function canAct(entry, client) {
  return entry.owner === void 0 || entry.owner === client?.id;
}
async function accessibleTabs(client) {
  const entries = await listEntries();
  const own = entries.filter(([, e]) => e.owner !== void 0 && e.owner === client?.id).map(([id]) => id);
  const shared = entries.filter(([, e]) => e.owner === void 0).map(([id]) => id);
  return [...own, ...shared];
}
async function addScope(tabId, owner, handed = false) {
  const scope = await load();
  const existing = scope[String(tabId)];
  if (existing) {
    if (handed && !existing.handed) existing.handed = true;
  } else {
    scope[String(tabId)] = { grouped: false, ...owner ? { owner: owner.id } : {}, ...handed ? { handed: true } : {} };
  }
  await save();
  if (owner) await rememberClient(owner);
  scheduleTabs();
}
async function removeScope(tabId) {
  const scope = await load();
  const entry = scope[String(tabId)];
  if (!entry) return;
  delete scope[String(tabId)];
  await save();
  if (await getCurrent(entry.owner) === tabId) await clearCurrent(entry.owner);
  scheduleTabs();
}
async function currentByOwner() {
  return (await chrome.storage.session.get(CURRENT_BY_OWNER_KEY))[CURRENT_BY_OWNER_KEY] ?? {};
}
async function getCurrent(owner) {
  if (owner === void 0) return (await chrome.storage.session.get(CURRENT_KEY))[CURRENT_KEY] ?? null;
  return (await currentByOwner())[owner] ?? null;
}
async function setCurrent(tabId, owner) {
  if (owner === void 0) return chrome.storage.session.set({ [CURRENT_KEY]: tabId });
  const map = await currentByOwner();
  map[owner] = tabId;
  await chrome.storage.session.set({ [CURRENT_BY_OWNER_KEY]: map });
}
async function clearCurrent(owner) {
  if (owner === void 0) return chrome.storage.session.remove(CURRENT_KEY);
  const map = await currentByOwner();
  delete map[owner];
  await chrome.storage.session.set({ [CURRENT_BY_OWNER_KEY]: map });
}
async function windowByOwner() {
  return (await chrome.storage.session.get(WINDOW_BY_OWNER_KEY))[WINDOW_BY_OWNER_KEY] ?? {};
}
async function getWindow(owner) {
  const id = (await windowByOwner())[owner];
  if (id === void 0) return null;
  const win = await chrome.windows.get(id).catch(() => null);
  if (win) return id;
  await clearWindow(owner);
  return null;
}
async function setWindow(owner, windowId) {
  const map = await windowByOwner();
  map[owner] = windowId;
  await chrome.storage.session.set({ [WINDOW_BY_OWNER_KEY]: map });
}
async function clearWindow(owner) {
  const map = await windowByOwner();
  if (!(owner in map)) return;
  delete map[owner];
  await chrome.storage.session.set({ [WINDOW_BY_OWNER_KEY]: map });
}
async function forgetWindow(windowId) {
  const map = await windowByOwner();
  const owners = Object.keys(map).filter((o) => map[o] === windowId);
  if (!owners.length) return;
  for (const o of owners) delete map[o];
  await chrome.storage.session.set({ [WINDOW_BY_OWNER_KEY]: map });
}
async function clientNames() {
  return (await chrome.storage.session.get(CLIENT_NAMES_KEY))[CLIENT_NAMES_KEY] ?? {};
}
async function rememberClient(client) {
  if (!client.name) return;
  const names = await clientNames();
  if (names[client.id] === client.name) return;
  names[client.id] = client.name;
  await chrome.storage.session.set({ [CLIENT_NAMES_KEY]: names });
}
async function clientName(id) {
  return (await clientNames())[id];
}
async function forgetClient(id) {
  const names = await clientNames();
  if (!(id in names)) return;
  delete names[id];
  await chrome.storage.session.set({ [CLIENT_NAMES_KEY]: names });
}
async function assertScoped(tabId) {
  const entry = await entryOf(tabId);
  if (!entry) {
    throw new BridgeError(
      "TAB_OUT_OF_SCOPE",
      `tab ${tabId} is not under ${brandName()} control: the agent only controls tabs it opened (tabs new) and tabs the user handed over with "Hand this tab to ${brandName()}"`
    );
  }
  return entry;
}
async function assertAccessible(tabId, client) {
  const entry = await assertScoped(tabId);
  if (!canAct(entry, client)) {
    const owner = entry.owner;
    const name = await clientName(owner);
    throw new BridgeError(
      "TAB_OWNED_BY_OTHER",
      `tab ${tabId} belongs to another agent (${name ? `${name}, ${owner}` : owner}): only that agent acts on it. Open your own tab with tabs {action:"new"} or ask the user to hand this one to you`,
      { owner, ...name ? { ownerName: name } : {} }
    );
  }
  return entry;
}
async function groupColor() {
  return await getAllowEvaluate() ? "yellow" : brandGroupColor();
}
async function groupTitleFor(owner) {
  if (owner === void 0) return GROUP_TITLE;
  const name = await clientName(owner);
  return ownerGroupTitle(name ? { id: owner, name } : { id: owner });
}
var grouping = Promise.resolve();
function groupTab(tabId) {
  const run = async () => {
    const entry = await entryOf(tabId);
    const owner = entry?.owner;
    const title = await groupTitleFor(owner);
    const color = owner === void 0 ? await groupColor() : ownerGroupColor(owner);
    const tab = await chrome.tabs.get(tabId);
    const existing = (await chrome.tabGroups.query({ title, windowId: tab.windowId }))[0];
    const groupId = await chrome.tabs.group(
      existing ? { tabIds: tabId, groupId: existing.id } : { tabIds: tabId, createProperties: { windowId: tab.windowId } }
    );
    if (!existing) await chrome.tabGroups.update(groupId, { title, color });
    const scope = await load();
    if (scope[String(tabId)]) {
      scope[String(tabId)].grouped = true;
      await save();
    }
  };
  const next = grouping.then(run, run);
  grouping = next.catch(() => void 0);
  return next;
}

// extension/src/alert.ts
var ALERT_COLOR = "#f5a524";
var ALERT_TEXT_COLOR = "#1a1a1a";
var BADGE_COLOR = brandAccent() ?? "#d7813d";
var BADGE_TEXT_COLOR = "#ffffff";
function badgeText(controlled, allowEvaluate) {
  if (controlled > 0) return controlled > 99 ? "99+" : String(controlled);
  return allowEvaluate ? "JS" : "";
}
async function applyBadge() {
  const allow = await getAllowEvaluate();
  const controlled = (await listScope()).length;
  await chrome.action.setBadgeText({ text: badgeText(controlled, allow) });
  await chrome.action.setBadgeBackgroundColor({ color: allow ? ALERT_COLOR : BADGE_COLOR });
  await chrome.action.setBadgeTextColor({ color: allow ? ALERT_TEXT_COLOR : BADGE_TEXT_COLOR });
}
async function applyAlertState() {
  await applyBadge();
  const color = await groupColor();
  for (const g of await chrome.tabGroups.query({ title: GROUP_TITLE })) await chrome.tabGroups.update(g.id, { color });
}

// extension/src/report.ts
var DEBOUNCE_MS = 250;
var sender = null;
var timer = null;
function setReporter(send2) {
  sender = send2;
}
async function scopedTabs() {
  const entries = await listEntries();
  const tabs2 = await Promise.all(entries.map(([id]) => chrome.tabs.get(id).catch(() => null)));
  return tabs2.flatMap((tab, i) => {
    if (tab?.id === void 0) return [];
    const owner = entries[i][1].owner;
    return [{ id: tab.id, url: tab.url ?? "", title: tab.title ?? "", ...owner !== void 0 ? { owner } : {} }];
  });
}
async function publishTabs() {
  if (timer) clearTimeout(timer);
  timer = null;
  sender?.({ t: "tabs", tabs: await scopedTabs() });
  await applyBadge().catch(() => void 0);
}
function scheduleTabs() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void publishTabs(), DEBOUNCE_MS);
}
function publishFocus() {
  sender?.({ t: "focus" });
}
async function publishFocusIfFocused() {
  const win = await chrome.windows.getLastFocused().catch(() => null);
  if (win?.focused) publishFocus();
}

// extension/src/session.ts
var CONSOLE_CAP = 1e3;
var NETWORK_CAP = 500;
var INFLIGHT_MAX_AGE_MS = 6e4;
var STREAMING_TYPES = /* @__PURE__ */ new Set(["WebSocket", "EventSource"]);
var formatArg = (a) => a.value !== void 0 ? typeof a.value === "string" ? a.value : JSON.stringify(a.value) : a.description ?? a.type ?? "";
function consoleLevel(type2) {
  switch (type2) {
    case "debug":
      return "debug";
    case "info":
      return "info";
    case "warning":
      return "warning";
    case "error":
    case "assert":
      return "error";
    default:
      return "log";
  }
}
var TabSession = class {
  tabId;
  transport;
  attached = false;
  /** ref do último snapshot -> backendNodeId. Vazio depois de uma navegação. */
  refs = /* @__PURE__ */ new Map();
  pointer = null;
  held = /* @__PURE__ */ new Set();
  console = [];
  /** Id do frame principal (Page.getFrameTree no attach, atualizado a cada frameNavigated do topo). */
  mainFrameId = null;
  /** O frame principal está carregando (Page.frameStartedLoading → loadEventFired/frameStoppedLoading). */
  loading = false;
  /** Quantas navegações do frame principal o debugger viu: back/forward/reload esperam a contagem subir. */
  navigations = 0;
  /** Pedidos de rede em voo (requestId → quando começou), para `wait networkidle`. */
  inflight = /* @__PURE__ */ new Map();
  /** Diálogo nativo aberto agora (A9): toda tool, menos `dialog`, erra com DIALOG_OPEN enquanto ele estiver aqui. */
  dialog = null;
  /** O gesto que o diálogo deixou pendurado no browser (termina quando o diálogo é respondido). */
  pending = null;
  /** Anel dos pedidos de rede vistos (A11, `readNetwork`), do mais antigo ao mais novo; os NETWORK_CAP últimos. */
  requests = [];
  /** Viewport emulada por `resize` (Emulation.setDeviceMetricsOverride), ou null com o tamanho real da janela. */
  emulated = null;
  seq = 0;
  netSeq = 0;
  waiters = [];
  constructor(tabId) {
    this.tabId = tabId;
    this.transport = {
      // O funil único de todo CDP da aba: anota o método e a hora na chamada que roda nela (calls.ts). Parâmetros e
      // resultado só vão ao traço no modo debug, truncados e sem texto de campo de senha.
      send: async (method, params) => {
        const done = cdpStart(tabId, method, params);
        try {
          const result = await chrome.debugger.sendCommand({ tabId }, method, params);
          done({ ok: true, result });
          return result;
        } catch (e) {
          done({ ok: false, error: e.message });
          throw new BrowserError("CDP_FAILED", `${method} failed: ${e.message}`, { cause: e });
        }
      }
    };
  }
  /** Anexa o debugger (ou reaproveita um anexo nosso de antes de o service worker reiniciar) e liga os domínios. */
  async attach() {
    if (this.attached) return;
    try {
      await chrome.debugger.attach({ tabId: this.tabId }, "1.3");
    } catch (e) {
      const msg = e.message;
      if (!/already attached/i.test(msg)) {
        throw new BridgeError("DEBUGGER_ATTACH_FAILED", `cannot attach the debugger to tab ${this.tabId}: ${msg}`);
      }
      try {
        await chrome.debugger.sendCommand({ tabId: this.tabId }, "Runtime.evaluate", { expression: "0" });
      } catch (e2) {
        throw new BridgeError("DEBUGGER_ATTACH_FAILED", `tab ${this.tabId} is already being debugged by another client: ${e2.message}`);
      }
    }
    this.attached = true;
    await this.transport.send("Page.enable");
    await this.transport.send("Runtime.enable");
    await this.transport.send("Log.enable");
    await this.transport.send("Network.enable");
    try {
      const tree = await this.transport.send("Page.getFrameTree");
      this.mainFrameId = tree.frameTree.frame.id;
    } catch {
    }
  }
  /** Pedidos em voo de verdade: os que começaram há mais de INFLIGHT_MAX_AGE_MS são esquecidos (sem fim relatado). */
  inflightCount() {
    const cutoff = Date.now() - INFLIGHT_MAX_AGE_MS;
    for (const [id, started] of this.inflight) if (started < cutoff) this.inflight.delete(id);
    return this.inflight.size;
  }
  async detach() {
    if (!this.attached) return;
    this.attached = false;
    try {
      await chrome.debugger.detach({ tabId: this.tabId });
    } catch {
    }
  }
  /** Espera o próximo evento CDP `method`. Registre ANTES de enviar o comando que o provoca. */
  waitFor(method, timeoutMs) {
    let waiter;
    let timer2;
    const promise = new Promise((resolve) => {
      waiter = { method, resolve: () => resolve(true) };
      this.waiters.push(waiter);
      if (timeoutMs > 0 && timeoutMs <= 2147483647) {
        timer2 = setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve(false);
        }, timeoutMs);
      }
    });
    const cancel = () => {
      clearTimeout(timer2);
      this.waiters = this.waiters.filter((w) => w !== waiter);
    };
    return { promise: promise.finally(() => clearTimeout(timer2)), cancel };
  }
  /** Despacho dos eventos do chrome.debugger para esta sessão. */
  onEvent(method, params) {
    for (const w of this.waiters.filter((x) => x.method === method)) {
      this.waiters = this.waiters.filter((x) => x !== w);
      w.resolve();
    }
    const p = params ?? {};
    if (method === "Page.frameNavigated") {
      const frame = p.frame;
      if (frame && !frame.parentId) {
        this.refs.clear();
        this.mainFrameId = frame.id;
        this.navigations++;
      }
    } else if (method === "Page.javascriptDialogOpening") {
      this.dialog = {
        type: p.type ?? "alert",
        message: typeof p.message === "string" ? p.message : "",
        defaultPrompt: typeof p.defaultPrompt === "string" ? p.defaultPrompt : ""
      };
    } else if (method === "Page.javascriptDialogClosed") {
      this.dialog = null;
    } else if (method === "Page.navigatedWithinDocument") {
      this.navigations++;
    } else if (method === "Page.frameStartedLoading") {
      if (this.mainFrameId === null || p.frameId === this.mainFrameId) this.loading = true;
    } else if (method === "Page.frameStoppedLoading") {
      if (this.mainFrameId === null || p.frameId === this.mainFrameId) this.loading = false;
    } else if (method === "Page.loadEventFired") {
      this.loading = false;
    } else if (method === "Network.requestWillBeSent") {
      if (!STREAMING_TYPES.has(String(p.type))) this.inflight.set(String(p.requestId), Date.now());
      this.onRequest(p);
    } else if (method === "Network.responseReceived") {
      const e = this.requestById(String(p.requestId));
      const r = p.response;
      if (e && r) {
        e.status = r.status;
        e.mimeType = r.mimeType;
        if (typeof p.type === "string") e.type = p.type;
        if (r.fromDiskCache || r.fromServiceWorker) e.fromCache = true;
      }
    } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      this.inflight.delete(String(p.requestId));
      const e = this.requestById(String(p.requestId));
      if (e) {
        if (typeof p.timestamp === "number") e.durationMs = Math.max(0, Math.round((p.timestamp - e.ts) * 1e3));
        if (method === "Network.loadingFinished") {
          if (typeof p.encodedDataLength === "number") e.bytes = p.encodedDataLength;
        } else {
          e.error = typeof p.errorText === "string" && p.errorText ? p.errorText : "failed";
          if (typeof p.type === "string" && !e.type) e.type = p.type;
        }
      }
    } else if (method === "Runtime.consoleAPICalled") {
      const args = p.args ?? [];
      this.pushConsole(consoleLevel(String(p.type)), args.map(formatArg).join(" "));
    } else if (method === "Runtime.exceptionThrown") {
      const d = p.exceptionDetails;
      this.pushConsole("error", d?.exception?.description ?? d?.text ?? "uncaught exception");
    } else if (method === "Log.entryAdded") {
      const e = p.entry;
      const level = e?.level === "verbose" ? "debug" : e?.level === "warning" || e?.level === "error" ? e.level : "info";
      this.pushConsole(level, `${e?.text ?? ""}${e?.url ? ` (${e.url})` : ""}`);
    }
  }
  pushConsole(level, text) {
    this.console.push({ seq: ++this.seq, level, text, ts: Date.now() });
    if (this.console.length > CONSOLE_CAP) this.console.splice(0, this.console.length - CONSOLE_CAP);
  }
  /** A entrada do anel com este requestId (a mais recente, se o id se repetiu), ou undefined se já saiu do anel. */
  requestById(id) {
    for (let i = this.requests.length - 1; i >= 0; i--) if (this.requests[i].id === id) return this.requests[i];
    return void 0;
  }
  /**
   * Network.requestWillBeSent: um pedido novo entra no anel; um redirecionamento (mesmo requestId, com `redirectResponse`)
   * atualiza a entrada existente (URL final, contagem de redirecionamentos) em vez de criar outra.
   */
  onRequest(p) {
    const req = p.request;
    const id = String(p.requestId);
    const ts = typeof p.timestamp === "number" ? p.timestamp : 0;
    if (p.redirectResponse) {
      const existing = this.requestById(id);
      if (existing) {
        existing.redirects = (existing.redirects ?? 0) + 1;
        existing.url = req?.url ?? existing.url;
        return;
      }
    }
    if (STREAMING_TYPES.has(String(p.type))) return;
    this.requests.push({
      seq: ++this.netSeq,
      id,
      url: req?.url ?? "",
      method: req?.method ?? "GET",
      ...typeof p.type === "string" ? { type: p.type } : {},
      startedAt: Date.now(),
      ts
    });
    if (this.requests.length > NETWORK_CAP) this.requests.splice(0, this.requests.length - NETWORK_CAP);
  }
};

// extension/src/sessions.ts
var sessions = /* @__PURE__ */ new Map();
function sessionFor(tabId) {
  let s = sessions.get(tabId);
  if (!s) {
    s = new TabSession(tabId);
    sessions.set(tabId, s);
  }
  return s;
}
function existingSession(tabId) {
  return sessions.get(tabId);
}
async function attachedSession(tabId, client) {
  await assertAccessible(tabId, client);
  const s = sessionFor(tabId);
  await s.attach();
  return s;
}
async function takeControl(tabId, owner, opts = {}) {
  await addScope(tabId, owner, opts.handed === true);
  const s = sessionFor(tabId);
  try {
    await s.attach();
    await groupTab(tabId);
  } catch (e) {
    await releaseControl(tabId);
    throw e;
  }
  return s;
}
async function adoptOpenedTab(tab) {
  const tabId = tab.id;
  if (tabId === void 0 || tab.openerTabId === void 0 || isOwnPage(tab.pendingUrl ?? tab.url)) return false;
  const opener = await entryOf(tab.openerTabId);
  if (!opener || await isScoped(tabId)) return false;
  await addScope(tabId, opener.owner !== void 0 ? { id: opener.owner } : void 0);
  const s = sessionFor(tabId);
  try {
    await s.attach();
  } catch {
    await releaseControl(tabId);
    return false;
  }
  await groupTab(tabId).catch(() => void 0);
  return true;
}
var isOwnPage = (url) => url !== void 0 && url.startsWith(chrome.runtime.getURL(""));
async function releaseControl(tabId) {
  await removeScope(tabId);
  const s = sessions.get(tabId);
  sessions.delete(tabId);
  await s?.detach();
}
async function releaseClient(clientId) {
  const title = await groupTitleFor(clientId);
  const released = [];
  for (const [tabId, entry] of await listEntries()) {
    if (entry.owner !== clientId) continue;
    await releaseControl(tabId);
    released.push(tabId);
  }
  await clearCurrent(clientId);
  await clearWindow(clientId);
  let groups = 0;
  for (const g of await chrome.tabGroups.query({ title })) {
    await chrome.tabGroups.update(g.id, { title: releasedGroupTitle(title), collapsed: true }).catch(() => chrome.tabGroups.update(g.id, { title: releasedGroupTitle(title) }));
    groups++;
  }
  await forgetClient(clientId);
  scheduleTabs();
  return { released, groups };
}
async function releaseAll() {
  const released = [];
  for (const [tabId] of await listEntries()) {
    await releaseControl(tabId);
    released.push(tabId);
  }
  scheduleTabs();
  return { released };
}
async function resolveTabId(requested, client) {
  if (requested !== void 0 && requested !== null && requested !== "") {
    const id = Number(requested);
    if (!Number.isInteger(id)) throw new BrowserError("INVALID_ARGUMENT", `tab must be a tab id from the tabs tool, got "${String(requested)}"`);
    await assertAccessible(id, client);
    return id;
  }
  const owner = client?.id;
  const reachable = await accessibleTabs(client);
  const current = await getCurrent(owner);
  if (current !== null && reachable.includes(current)) return current;
  for (const id of reachable) {
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (tab?.active) {
      await setCurrent(id, owner);
      return id;
    }
  }
  if (reachable[0] !== void 0) {
    await setCurrent(reachable[0], owner);
    return reachable[0];
  }
  throw new BrowserError(
    "NO_ACTIVE_TAB",
    `no tab is under ${brandName()} control${client ? ` for ${client.name ?? client.id}` : ""}: open one with tabs {action:"new"} or ask the user to hand a tab over with "Hand this tab to ${brandName()}"`
  );
}
function watchBrowserEvents() {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId !== void 0) sessions.get(source.tabId)?.onEvent(method, params);
  });
  chrome.debugger.onDetach.addListener((source, reason2) => {
    const tabId = source.tabId;
    if (tabId === void 0) return;
    const s = sessions.get(tabId);
    if (s) s.attached = false;
    if (reason2 === "canceled_by_user") void releaseControl(tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    sessions.delete(tabId);
    void removeScope(tabId);
  });
  chrome.tabs.onCreated.addListener((tab) => {
    void adoptOpenedTab(tab).catch(() => void 0);
  });
  chrome.windows.onRemoved.addListener((windowId) => {
    void forgetWindow(windowId);
  });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) return;
    void isGrouped(tabId).then((grouped) => grouped ? releaseControl(tabId) : void 0);
  });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.url === void 0 && change.title === void 0) return;
    void isScoped(tabId).then((scoped) => scoped ? isOwnPage(change.url) ? releaseControl(tabId) : scheduleTabs() : void 0);
  });
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId !== chrome.windows.WINDOW_ID_NONE) publishFocus();
  });
}

// extension/src/dump.ts
var SCREENSHOT_MS = 3e3;
var PAGE_MS = 2e3;
var SCREENSHOT_MAX_CHARS = Math.ceil(2 * 1024 * 1024 * 4 / 3);
var CONSOLE_TAIL = 200;
var raw = (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params);
var PAGE_STATE = `(() => {
  const desc = (el) => {
    if (!el || el.nodeType !== 1) return null;
    const r = el.getBoundingClientRect();
    const ac = el.getAttribute('autocomplete') || '';
    return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || null, id: el.id || null, type: el.type || null,
      name: el.getAttribute('aria-label') || null, password: (el.tagName === 'INPUT' && el.type === 'password') || /password/i.test(ac),
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } };
  };
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  return { url: location.href, title: document.title, visibilityState: document.visibilityState, hasFocus: document.hasFocus(),
    focused: el && el !== document.body ? desc(el) : null };
})()`;
var DESCRIBE_TARGET = `function() {
  const el = this;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  const top = r.width > 0 && r.height > 0 ? document.elementFromPoint(cx, cy) : null;
  const covered = !!top && top !== el && !el.contains(top);
  const d = (x) => x ? { tag: x.tagName.toLowerCase(), role: x.getAttribute('role') || null, id: x.id || null } : null;
  return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || null, name: el.getAttribute('aria-label') || null, id: el.id || null,
    rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
    enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true', covered, coveredBy: covered ? d(top) : null };
}`;
function scrub(value, secret) {
  if (!secret) return value;
  const walk = (v) => {
    if (typeof v === "string") return v.includes(secret) ? v.split(secret).join(REDACTED) : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}
async function screenshot(tabId) {
  const shot = (params) => withTimeout(raw(tabId, "Page.captureScreenshot", params), SCREENSHOT_MS, () => new Error(`no screenshot within ${SCREENSHOT_MS} ms`));
  const png = await shot({ format: "png" });
  if (png.data.length <= SCREENSHOT_MAX_CHARS) return { format: "png", data: png.data };
  const jpeg = await shot({ format: "jpeg", quality: 50 });
  if (jpeg.data.length <= SCREENSHOT_MAX_CHARS) return { format: "jpeg", data: jpeg.data };
  throw new Error(`the screenshot exceeded 2 MB even as JPEG (${jpeg.data.length} base64 chars)`);
}
async function pageState(tabId) {
  const r = await withTimeout(raw(tabId, "Runtime.evaluate", { expression: PAGE_STATE, returnByValue: true }), PAGE_MS, () => new Error(`the page did not answer within ${PAGE_MS} ms`));
  return r.result?.value ?? null;
}
async function describeRef(tabId, backendNodeId) {
  const timeout = () => new Error(`the page did not answer within ${PAGE_MS} ms`);
  const node = await withTimeout(raw(tabId, "DOM.resolveNode", { backendNodeId }), PAGE_MS, timeout);
  const objectId = node.object?.objectId;
  if (!objectId) return null;
  try {
    const r = await withTimeout(raw(tabId, "Runtime.callFunctionOn", { objectId, functionDeclaration: DESCRIBE_TARGET, returnByValue: true }), PAGE_MS, timeout);
    return r.result?.value ?? null;
  } finally {
    void raw(tabId, "Runtime.releaseObject", { objectId }).catch(() => void 0);
  }
}
async function tabState(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const win = await chrome.windows.get(tab.windowId);
    return { active: tab.active, windowFocused: win.focused, ...win.state ? { windowState: win.state } : {} };
  } catch (e) {
    return { error: e.message };
  }
}
var reason = (e) => e instanceof Error ? e.message : String(e);
async function collectDump(callId, error) {
  const src = dumpSource(callId);
  const missing = {};
  const call = {
    callId,
    ...src ? { call: src.view } : { call: null, note: "the extension has no record of this call" },
    ...error ? { error } : {},
    ...src?.pageEvents !== void 0 ? { pageEvents: src.pageEvents } : {}
  };
  const pieces = { call, missing };
  const tabId = src?.tabId;
  const session = tabId !== void 0 ? existingSession(tabId) : void 0;
  if (tabId === void 0 || !session?.attached) {
    const why = tabId === void 0 ? "the call has no tab" : "the debugger is not attached to the tab";
    missing.screenshot = why;
    missing.target = why;
    if (tabId === void 0) missing.console = why;
  }
  if (session) pieces.console = session.console.slice(-CONSOLE_TAIL);
  else if (!missing.console) missing.console = "no session for the tab";
  if (tabId !== void 0 && session?.attached) {
    const backendNodeId = src?.hint?.ref !== void 0 ? session.refs.get(src.hint.ref) : void 0;
    const [shot, page, node, tab] = await Promise.allSettled([
      screenshot(tabId),
      pageState(tabId),
      backendNodeId !== void 0 ? describeRef(tabId, backendNodeId) : Promise.resolve(void 0),
      tabState(tabId)
    ]);
    if (shot.status === "fulfilled") pieces.screenshot = shot.value;
    else missing.screenshot = reason(shot.reason);
    const target = {
      requested: src?.hint ?? null,
      ...src?.aim ? { aim: src.aim } : {},
      tab: tab.status === "fulfilled" ? { tabId, ...tab.value } : { tabId, error: reason(tab.reason) }
    };
    if (src?.hint?.ref !== void 0 && backendNodeId === void 0) target.resolved = { error: `ref "${src.hint.ref}" is not in the last snapshot` };
    if (node.status === "fulfilled" && node.value !== void 0) target.resolved = node.value;
    else if (node.status === "rejected") missing.target_node = reason(node.reason);
    if (page.status === "fulfilled") target.page = page.value;
    else missing.page = reason(page.reason);
    pieces.target = target;
  }
  const secret = src?.secret;
  return {
    ...pieces.screenshot ? { screenshot: pieces.screenshot } : {},
    ...pieces.console !== void 0 ? { console: scrub(pieces.console, secret) } : {},
    ...pieces.target !== void 0 ? { target: scrub(pieces.target, secret) } : {},
    call: scrub(pieces.call, secret),
    missing
  };
}

// extension/src/reload.ts
function decideReload(running2, expected, onDisk, attempted) {
  if (expected === running2) return { reload: false, reason: "same-version" };
  if (attempted === expected) return { reload: false, reason: "already-attempted" };
  if (onDisk !== null && onDisk === running2) return { reload: false, reason: "disk-not-updated" };
  return { reload: true, reason: "reload" };
}
var ATTEMPTED_KEY = "reloadAttemptedFor";
var EXPECTED_KEY = "hostExtensionVersion";
async function manifestVersionOnDisk() {
  try {
    const res = await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" });
    if (!res.ok) return null;
    const parsed = await res.json();
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}
async function maybeReloadForVersion(expected) {
  if (!expected) {
    await chrome.storage.session.remove(EXPECTED_KEY);
    return null;
  }
  await chrome.storage.session.set({ [EXPECTED_KEY]: expected });
  const running2 = chrome.runtime.getManifest().version;
  const attempted = (await chrome.storage.local.get(ATTEMPTED_KEY))[ATTEMPTED_KEY] ?? null;
  const decision = decideReload(running2, expected, await manifestVersionOnDisk(), attempted);
  if (decision.reload) {
    await chrome.storage.local.set({ [ATTEMPTED_KEY]: expected });
    chrome.runtime.reload();
  }
  return decision;
}

// extension/src/seed.ts
async function readSeed() {
  try {
    const res = await fetch(chrome.runtime.getURL(SEED_FILE));
    if (!res.ok) return null;
    const parsed = await res.json();
    return isSeed(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
async function applySeed() {
  const seed = await readSeed();
  if (!seed) return false;
  const settings = await loadSettings();
  if (seed.host) await saveHostBrand({ name: seed.host }, { onlyIfMissing: true });
  if (settings.token === seed.token && settings.port === seed.port) return false;
  await saveSettings({ ...settings, port: seed.port, token: seed.token });
  return true;
}

// extension/src/pointer.ts
var rng = mulberry32(Math.random() * 2 ** 32 >>> 0);
var HIT_TEST = `function(p){const topAt=${String(pageFn(topAt))};const inspect=${String(pageFn(inspect))};const el=topAt(p);if(!el)return null;return inspect({top:el,target:(this instanceof Element)?this:null})}`;
function hasPoint(a) {
  return typeof a.x === "number" && typeof a.y === "number";
}
async function viewport(s) {
  const m = await s.transport.send("Page.getLayoutMetrics");
  const v = m.cssVisualViewport;
  return { width: v.clientWidth, height: v.clientHeight, pageX: v.pageX, pageY: v.pageY };
}
function backendNodeOf(s, ref) {
  const id = s.refs.get(ref);
  if (id !== void 0) return id;
  if (s.refs.size === 0) {
    throw new BrowserError("STALE_REF", `ref "${ref}" is stale: no snapshot of this tab since its last navigation; take a new snapshot`);
  }
  throw new BrowserError("REF_NOT_FOUND", `ref "${ref}" is not in the latest snapshot of this tab; take a new snapshot`);
}
async function nodeBox(s, backendNodeId, ref) {
  const t = s.transport;
  try {
    await t.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
  } catch (e) {
    throw new BrowserError("STALE_REF", `ref "${ref}" no longer exists in the page; take a new snapshot`, { cause: e });
  }
  let quad;
  try {
    quad = (await t.send("DOM.getBoxModel", { backendNodeId })).model.border;
  } catch (e) {
    throw new BrowserError("TARGET_NOT_VISIBLE", `ref "${ref}" has no visible box (hidden or not rendered)`, { cause: e });
  }
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const box = {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys)
  };
  const vp = await viewport(s);
  const clipped = clipToViewport(box, vp);
  if (!clipped) throw new BrowserError("TARGET_NOT_VISIBLE", `ref "${ref}" is outside the visible viewport`);
  return { box, clipped };
}
async function hitAt(s, p, objectId) {
  const t = s.transport;
  if (objectId) {
    const r = await t.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: HIT_TEST,
      arguments: [{ value: p }],
      returnByValue: true
    });
    return r.result?.value ?? null;
  }
  return pageEval(t, `(${HIT_TEST}).call(null, ${JSON.stringify(p)})`);
}
async function aim(s, a, what = "target") {
  stage(s.tabId, "aim");
  if (a.ref !== void 0) {
    const backendNodeId = backendNodeOf(s, a.ref);
    const { clipped } = await nodeBox(s, backendNodeId, a.ref);
    const objectId = (await s.transport.send("DOM.resolveNode", { backendNodeId })).object.objectId;
    try {
      let occluder;
      for (const p of candidatePoints(clipped)) {
        const point = { x: Math.round(p.x), y: Math.round(p.y) };
        const hit = await hitAt(s, point, objectId);
        if (hit?.isTarget) {
          noteAim(s.tabId, { ref: a.ref, x: point.x, y: point.y, box: clipped, hit: hit.desc, covered: false });
          return { ...point, ref: a.ref, box: clipped, hit: hit.desc };
        }
        if (occluder === void 0) occluder = hit?.desc ?? null;
      }
      noteAim(s.tabId, { ref: a.ref, box: clipped, covered: true, occluder: occluder ?? null });
      throw new BrowserError("TARGET_OBSCURED", `ref "${a.ref}" is covered by ${describeOccluder(occluder ?? null)}`, {
        occluder: occluder ?? null
      });
    } finally {
      await s.transport.send("Runtime.releaseObject", { objectId }).catch(() => void 0);
    }
  }
  if (hasPoint(a)) {
    const point = { x: Math.round(a.x), y: Math.round(a.y) };
    const hit = await hitAt(s, point);
    noteAim(s.tabId, { x: point.x, y: point.y, hit: hit?.desc ?? null });
    return { ...point, hit: hit?.desc ?? null };
  }
  throw new BrowserError("INVALID_ARGUMENT", `${what}: give a ref, or both x and y`);
}
async function travel(s, to) {
  stage(s.tabId, "pointer");
  const from = s.pointer ?? { x: 0, y: 0 };
  for (const p of planPath(from, to, rng)) {
    await mouseMove(s.transport, p.x, p.y, s.held);
    await sleep(between(rng, 3, 12));
  }
  s.pointer = { x: to.x, y: to.y };
}
async function click(s, a) {
  const target = await aim(s, a);
  await travel(s, target);
  await sleep(between(rng, 30, 90));
  const button = a.button ?? "left";
  const count = a.count ?? 1;
  for (let i = 1; i <= count; i++) {
    await mouseDown(s.transport, target.x, target.y, button, i);
    await sleep(between(rng, 35, 90));
    await mouseUp(s.transport, target.x, target.y, button, i);
    if (i < count) await sleep(between(rng, 40, 90));
  }
  return { clicked: target.hit, x: target.x, y: target.y, ...target.ref ? { ref: target.ref } : {} };
}
async function hover(s, a) {
  const target = await aim(s, a);
  await travel(s, target);
  return { hovered: target.hit, x: target.x, y: target.y, ...target.ref ? { ref: target.ref } : {} };
}
async function drag(s, a) {
  const from = await aim(s, a, "drag source");
  const to = await aim(s, { ref: a.toRef, x: a.toX, y: a.toY }, "drag destination");
  await travel(s, from);
  await sleep(between(rng, 30, 90));
  await mouseDown(s.transport, from.x, from.y, "left");
  s.held.add("left");
  try {
    await sleep(between(rng, 60, 120));
    await travel(s, to);
    await sleep(between(rng, 40, 100));
  } finally {
    s.held.delete("left");
    await mouseUp(s.transport, to.x, to.y, "left");
  }
  return { from: { x: from.x, y: from.y, hit: from.hit }, to: { x: to.x, y: to.y, hit: to.hit } };
}
var SCROLL_POS = `(()=>{const e=document.scrollingElement||document.documentElement;return {x:Math.round(scrollX),y:Math.round(scrollY),maxX:Math.max(0,e.scrollWidth-innerWidth),maxY:Math.max(0,e.scrollHeight-innerHeight)}})()`;
async function settledScroll(s) {
  let prev = await pageEval(s.transport, SCROLL_POS);
  for (let i = 0; i < 30; i++) {
    await sleep(50);
    const cur = await pageEval(s.transport, SCROLL_POS);
    if (cur.x === prev.x && cur.y === prev.y) return cur;
    prev = cur;
  }
  return prev;
}
var WHEEL_STEP = 120;
async function scroll(s, a) {
  const wantsDelta = a.byX !== void 0 || a.byY !== void 0;
  if (!wantsDelta && a.to === void 0 && a.ref === void 0) {
    throw new BrowserError("INVALID_ARGUMENT", 'scroll: give byX/byY, to ("top" or "bottom") or a ref');
  }
  const vp = await viewport(s);
  let at = { x: Math.round(vp.width / 2), y: Math.round(vp.height / 2) };
  if (a.ref !== void 0) {
    const aimed = await aim(s, { ref: a.ref });
    at = { x: aimed.x, y: aimed.y };
  } else if (hasPoint(a)) {
    at = { x: Math.round(a.x), y: Math.round(a.y) };
  }
  if (wantsDelta) {
    const bx = a.byX ?? 0;
    const by = a.byY ?? 0;
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(bx), Math.abs(by)) / WHEEL_STEP));
    for (let i = 0; i < n; i++) {
      await mouseWheel(s.transport, at.x, at.y, bx / n, by / n);
      await sleep(between(rng, 8, 22));
    }
  } else if (a.to !== void 0) {
    const step = Math.min(1200, Math.max(300, Math.round(vp.height * 0.8))) * (a.to === "top" ? -1 : 1);
    let prev = await settledScroll(s);
    for (let i = 0; ; i++) {
      if (i >= 200) throw new BrowserError("SCROLL_INCOMPLETE", `scroll to ${a.to} did not reach the end after 200 wheel events (infinite page?)`);
      await mouseWheel(s.transport, at.x, at.y, 0, step);
      const cur = await settledScroll(s);
      if (cur.y === prev.y) break;
      prev = cur;
    }
  }
  return { scroll: await settledScroll(s) };
}

// extension/src/page-events.ts
var TYPES = ["pointerdown", "mousedown", "mouseup", "click", "focus", "blur", "keydown", "keyup", "beforeinput", "input", "change"];
var COLLECT_MS = 2e3;
var SELF_REMOVE_MS = 12e4;
var MAX_EVENTS = 500;
var INSTALL = `function(token, types, selfRemoveMs, maxEvents) {
  const target = this && this.nodeType === 1 ? this : null;
  const t0 = performance.now();
  const list = [];
  const seen = new WeakSet();
  const onEvent = (e) => {
    if (seen.has(e) || list.length >= maxEvents) return;
    seen.add(e);
    list.push({ e, t: performance.now() - t0, el: e.composedPath ? e.composedPath()[0] : e.target });
  };
  const opts = { capture: true, passive: true };
  for (const ty of types) { document.addEventListener(ty, onEvent, opts); if (target) target.addEventListener(ty, onEvent, opts); }
  const remove = () => { for (const ty of types) { document.removeEventListener(ty, onEvent, opts); if (target) target.removeEventListener(ty, onEvent, opts); } };
  const safety = setTimeout(() => { remove(); delete window[token]; }, selfRemoveMs);
  const secretEl = (el) => !!el && el.tagName === 'INPUT' && (el.type === 'password' || /password/i.test(el.getAttribute('autocomplete') || ''));
  const desc = (el) => {
    if (!el || el.nodeType !== 1) return { tag: el === document ? '#document' : el === window ? '#window' : String((el && el.nodeName) || '?') };
    const role = el.getAttribute('role');
    return Object.assign({ tag: el.tagName.toLowerCase() }, role ? { role } : {}, el.id ? { id: el.id } : {});
  };
  window[token] = { collect() {
    clearTimeout(safety); remove(); delete window[token];
    return list.map(({ e, t, el }) => {
      const secret = secretEl(el) || secretEl(target);
      const onTarget = !!target && !!el && el.nodeType === 1 && (el === target || target.contains(el));
      const out = { type: e.type, t: Math.round(t), onTarget, defaultPrevented: e.defaultPrevented, trusted: e.isTrusted };
      if (!onTarget) out.node = desc(el);
      if (secret) out.secret = true;
      else {
        if (e.type === 'keydown' || e.type === 'keyup') out.key = e.key;
        if (e.inputType) out.inputType = e.inputType;
      }
      return out;
    });
  } };
  return true;
}`;
async function targetObject(s, t) {
  if (t.ref !== void 0) {
    const backendNodeId = backendNodeOf(s, t.ref);
    return (await s.transport.send("DOM.resolveNode", { backendNodeId })).object.objectId ?? null;
  }
  const expression = typeof t.x === "number" && typeof t.y === "number" ? `document.elementFromPoint(${Math.round(t.x)}, ${Math.round(t.y)})` : `(() => { let el = document.activeElement; while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement; return el })()`;
  const r = await s.transport.send("Runtime.evaluate", { expression });
  return r.result?.objectId ?? null;
}
async function withPageEvents(s, callId, tool, target, fn) {
  if (!isDebug()) return fn();
  const token = `__atriumBridgeEvents_${Math.random().toString(36).slice(2)}`;
  let installed = false;
  let objectId = null;
  try {
    objectId = await targetObject(s, target).catch(() => null);
    const args = [{ value: token }, { value: TYPES }, { value: SELF_REMOVE_MS }, { value: MAX_EVENTS }];
    const r = objectId ? await s.transport.send("Runtime.callFunctionOn", { objectId, functionDeclaration: INSTALL, arguments: args, returnByValue: true }) : await s.transport.send("Runtime.evaluate", {
      expression: `(${INSTALL}).call(null, ${JSON.stringify(token)}, ${JSON.stringify(TYPES)}, ${SELF_REMOVE_MS}, ${MAX_EVENTS})`,
      returnByValue: true
    });
    installed = r.result?.value === true;
    if (!installed) traceFor(callId, "page_events_unavailable", { tool, reason: "the listeners could not be installed" });
  } catch (e) {
    traceFor(callId, "page_events_unavailable", { tool, reason: e.message });
  }
  try {
    return await fn();
  } finally {
    if (installed) await collect(s, callId, tool, token);
    if (objectId) await s.transport.send("Runtime.releaseObject", { objectId }).catch(() => void 0);
  }
}
async function collect(s, callId, tool, token) {
  try {
    const r = await withTimeout(
      s.transport.send("Runtime.evaluate", { expression: `window[${JSON.stringify(token)}] ? window[${JSON.stringify(token)}].collect() : null`, returnByValue: true }),
      COLLECT_MS,
      () => new Error(`the page did not answer within ${COLLECT_MS} ms (the listeners remove themselves in ${SELF_REMOVE_MS / 1e3} s)`)
    );
    const events = r.result?.value;
    if (!Array.isArray(events)) {
      traceFor(callId, "page_events_unavailable", { tool, reason: "the page changed during the gesture (navigation or reload): the listeners are gone" });
      notePageEvents(callId, { unavailable: "the page changed during the gesture" });
      return;
    }
    traceFor(callId, "page_events", { tool, events });
    notePageEvents(callId, events);
  } catch (e) {
    traceFor(callId, "page_events_unavailable", { tool, reason: e.message });
    notePageEvents(callId, { unavailable: e.message });
  }
}

// extension/src/forms.ts
function dialogOpenError(d) {
  return new BridgeError(
    "DIALOG_OPEN",
    `${d.type === "alert" ? "an" : "a"} ${d.type} dialog is open (${JSON.stringify(d.message)}); the page is blocked until you answer it with dialog {action:"accept"} or {action:"dismiss"}`,
    { dialog: d }
  );
}
var PENDING_GESTURE_MS = 5e3;
async function dialog(s, a) {
  const d = s.dialog;
  if (!d) throw new BrowserError("NO_DIALOG", "there is no open dialog in this tab");
  if (a.text !== void 0 && d.type !== "prompt") {
    throw new BrowserError("INVALID_ARGUMENT", `dialog: "text" is only for a prompt; this is a ${d.type}`);
  }
  const accept = a.action === "accept";
  const answer = d.type === "prompt" && accept ? a.text ?? d.defaultPrompt : void 0;
  await s.transport.send("Page.handleJavaScriptDialog", { accept, ...answer !== void 0 ? { promptText: answer } : {} });
  s.dialog = null;
  const pending = s.pending;
  s.pending = null;
  if (pending) await withTimeout(pending.catch(() => void 0), PENDING_GESTURE_MS, () => new Error("pending gesture")).catch(() => void 0);
  return { type: d.type, message: d.message, action: a.action, ...answer !== void 0 ? { text: answer } : {} };
}
async function withObject(s, ref, fn) {
  const backendNodeId = backendNodeOf(s, ref);
  let objectId;
  try {
    objectId = (await s.transport.send("DOM.resolveNode", { backendNodeId })).object.objectId;
  } catch (e) {
    throw new BrowserError("STALE_REF", `ref "${ref}" no longer exists in the page; take a new snapshot`, { cause: e });
  }
  try {
    return await fn(objectId);
  } finally {
    await s.transport.send("Runtime.releaseObject", { objectId }).catch(() => void 0);
  }
}
async function callOn(s, objectId, functionDeclaration, args = []) {
  const r = await s.transport.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration,
    arguments: args.map((value) => ({ value })),
    returnByValue: true
  });
  if (r.exceptionDetails) {
    throw new BrowserError("EVALUATE_FAILED", `page script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  }
  return r.result?.value;
}
var PROBE_SELECT = `function () {
  if (!(this instanceof HTMLSelectElement)) return null
  return {
    multiple: this.multiple,
    selectedIndex: this.selectedIndex,
    options: Array.from(this.options).map((o) => ({
      value: o.value,
      label: (o.label || o.text || '').replace(/\\s+/g, ' ').trim(),
      disabled: o.disabled || !!(o.parentElement && o.parentElement.tagName === 'OPTGROUP' && o.parentElement.disabled),
    })),
  }
}`;
var SET_SELECT = `function (i) {
  this.selectedIndex = i
  this.dispatchEvent(new Event('input', { bubbles: true }))
  this.dispatchEvent(new Event('change', { bubbles: true }))
  return this.selectedIndex
}`;
async function select(s, a) {
  if (a.value === void 0 === (a.label === void 0)) {
    throw new BrowserError("INVALID_ARGUMENT", "select: give exactly one of value or label");
  }
  return withObject(s, a.ref, async (objectId) => {
    const probe = await callOn(s, objectId, PROBE_SELECT);
    if (!probe) {
      throw new BrowserError("NOT_A_SELECT", `ref "${a.ref}" is not a native <select>; for a custom dropdown, click it and click its option`);
    }
    const by = a.value !== void 0 ? "value" : "label";
    const wanted = a.value !== void 0 ? a.value : a.label.replace(/\s+/g, " ").trim();
    const hits = probe.options.flatMap((o, i) => o[by] === wanted ? [i] : []);
    const list = probe.options.map((o) => `${JSON.stringify(o.label)} (value ${JSON.stringify(o.value)}${o.disabled ? ", disabled" : ""})`).join(", ");
    if (hits.length === 0) throw new BrowserError("OPTION_NOT_FOUND", `no option with ${by} ${JSON.stringify(wanted)}; options: ${list || "none"}`);
    if (hits.length > 1) {
      throw new BrowserError("OPTION_AMBIGUOUS", `${hits.length} options have ${by} ${JSON.stringify(wanted)}; select by ${by === "label" ? "value" : "label"} instead: ${list}`);
    }
    const index = hits[0];
    const opt = probe.options[index];
    if (opt.disabled) throw new BrowserError("OPTION_DISABLED", `option ${JSON.stringify(opt.label)} is disabled`);
    const selected = { index, value: opt.value, label: opt.label };
    if (!probe.multiple && probe.selectedIndex === index) return { selected, changed: false, trusted: false };
    await s.transport.send("DOM.scrollIntoViewIfNeeded", { objectId }).catch(() => void 0);
    const now = await callOn(s, objectId, SET_SELECT, [index]);
    if (now !== index) {
      throw new BrowserError("SELECT_FAILED", `selecting ${JSON.stringify(opt.label)} left ${now >= 0 ? JSON.stringify(probe.options[now]?.label ?? "") : "nothing"} selected`);
    }
    return { selected, changed: true, trusted: false };
  });
}
var PROBE_CHECKED = `function () {
  const el = this
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) return { checked: el.checked, kind: el.type }
  const role = el.getAttribute('role')
  if (role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'menuitemcheckbox' || role === 'menuitemradio') {
    return { checked: el.getAttribute('aria-checked') === 'true', kind: role }
  }
  return null
}`;
var SETTLE_MS = 500;
async function setChecked(s, a) {
  const probe = () => withObject(s, a.ref, (objectId) => callOn(s, objectId, PROBE_CHECKED));
  const state = await probe();
  if (!state) throw new BrowserError("NOT_CHECKABLE", `ref "${a.ref}" is not a checkbox, radio or switch (it has no checked state)`);
  if (state.checked === a.checked) return { checked: state.checked, kind: state.kind, changed: false };
  await click(s, { ref: a.ref });
  const deadline = Date.now() + SETTLE_MS;
  let now = await probe();
  while (now && now.checked !== a.checked && Date.now() < deadline) {
    await sleep(50);
    now = await probe();
  }
  if (!now || now.checked !== a.checked) {
    throw new BrowserError(
      "STATE_NOT_CHANGED",
      `clicking "${a.ref}" left it ${now?.checked ? "checked" : "unchecked"}; wanted ${a.checked ? "checked" : "unchecked"}` + (!a.checked && state.kind === "radio" ? " (a radio button cannot be unchecked by clicking it: check another one of its group)" : "")
    );
  }
  return { checked: now.checked, kind: now.kind, changed: true };
}

// extension/src/keys.ts
var MODIFIER_BIT = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
function modifierBits(mods) {
  let bits = 0;
  for (const m of mods) bits |= MODIFIER_BIT[m];
  return bits;
}
var rows = [];
var byChar = /* @__PURE__ */ new Map();
var byName = /* @__PURE__ */ new Map();
function printable(code, keyCode, key, shiftKey) {
  const row2 = { code, keyCode, key, shiftKey, text: key };
  rows.push(row2);
  byChar.set(key, { row: row2, shifted: false });
  if (shiftKey !== key) byChar.set(shiftKey, { row: row2, shifted: true });
}
function named(name, code, keyCode, extra = {}) {
  const row2 = { code, keyCode, key: name, ...extra };
  rows.push(row2);
  byName.set(name.toLowerCase(), row2);
}
for (let i = 0; i < 26; i++) {
  const lower = String.fromCharCode(97 + i);
  printable(`Key${lower.toUpperCase()}`, 65 + i, lower, lower.toUpperCase());
}
var DIGIT_SHIFT = ")!@#$%^&*(";
for (let d = 0; d <= 9; d++) printable(`Digit${d}`, 48 + d, String(d), DIGIT_SHIFT[d]);
for (const [code, keyCode, key, shift] of [
  ["Semicolon", 186, ";", ":"],
  ["Equal", 187, "=", "+"],
  ["Comma", 188, ",", "<"],
  ["Minus", 189, "-", "_"],
  ["Period", 190, ".", ">"],
  ["Slash", 191, "/", "?"],
  ["Backquote", 192, "`", "~"],
  ["BracketLeft", 219, "[", "{"],
  ["Backslash", 220, "\\", "|"],
  ["BracketRight", 221, "]", "}"],
  ["Quote", 222, "'", '"']
]) {
  printable(code, keyCode, key, shift);
}
printable("Space", 32, " ", " ");
named("Enter", "Enter", 13, { text: "\r" });
named("Tab", "Tab", 9);
named("Backspace", "Backspace", 8);
named("Delete", "Delete", 46);
named("Escape", "Escape", 27);
named("Insert", "Insert", 45);
named("Home", "Home", 36);
named("End", "End", 35);
named("PageUp", "PageUp", 33);
named("PageDown", "PageDown", 34);
named("ArrowLeft", "ArrowLeft", 37);
named("ArrowUp", "ArrowUp", 38);
named("ArrowRight", "ArrowRight", 39);
named("ArrowDown", "ArrowDown", 40);
named("CapsLock", "CapsLock", 20);
for (let n = 1; n <= 12; n++) named(`F${n}`, `F${n}`, 111 + n);
named("Shift", "ShiftLeft", 16, { location: 1 });
named("Control", "ControlLeft", 17, { location: 1 });
named("Alt", "AltLeft", 18, { location: 1 });
named("Meta", "MetaLeft", 91, { location: 1 });
named("Space", "Space", 32, { key: " ", text: " " });
var ALIASES = {
  esc: "escape",
  return: "enter",
  del: "delete",
  ins: "insert",
  ctrl: "control",
  cmd: "meta",
  command: "meta",
  super: "meta",
  win: "meta",
  option: "alt",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  pgup: "pageup",
  pgdn: "pagedown",
  plus: "+",
  spacebar: "space"
};
function fromRow(row2, shift, impliedShift) {
  const key = shift && row2.shiftKey ? row2.shiftKey : row2.key;
  const text = row2.text === void 0 ? void 0 : shift && row2.shiftKey ? row2.shiftKey : row2.text;
  return {
    key,
    code: row2.code,
    keyCode: row2.keyCode,
    ...text !== void 0 ? { text } : {},
    ...row2.location ? { location: row2.location } : {},
    impliedShift
  };
}
function resolveKey(token, shiftHeld = false) {
  const hit = [...token].length === 1 ? byChar.get(token) : void 0;
  if (hit) return fromRow(hit.row, hit.shifted || shiftHeld, hit.shifted);
  const lower = token.toLowerCase();
  const alias = ALIASES[lower] ?? lower;
  const aliasChar = alias.length === 1 ? byChar.get(alias) : void 0;
  if (aliasChar) return fromRow(aliasChar.row, aliasChar.shifted || shiftHeld, aliasChar.shifted);
  const row2 = byName.get(alias);
  return row2 ? fromRow(row2, shiftHeld, false) : null;
}
var MODIFIER_NAMES = { alt: "Alt", control: "Control", meta: "Meta", shift: "Shift" };
function toModifier(token) {
  const lower = token.toLowerCase();
  return MODIFIER_NAMES[ALIASES[lower] ?? lower] ?? null;
}
function parseCombo(combo, hold = []) {
  if (!combo) throw new BrowserError("KEY_INVALID", "key is empty");
  const parts = combo.split("+");
  if (combo.endsWith("+")) {
    parts.pop();
    parts.pop();
    parts.push("+");
  }
  const mainToken = parts.pop();
  const modifiers = [];
  const addMod = (token) => {
    const m = toModifier(token);
    if (!m) throw new BrowserError("KEY_INVALID", `"${token}" is not a modifier (Control, Shift, Alt, Meta) in key "${combo}"`);
    if (!modifiers.includes(m)) modifiers.push(m);
  };
  for (const h of hold) addMod(h);
  for (const p of parts) addMod(p);
  const main = resolveKey(mainToken, modifiers.includes("Shift"));
  if (!main) throw new BrowserError("KEY_INVALID", `unknown key "${mainToken}" in "${combo}"`);
  if (main.impliedShift && !modifiers.includes("Shift")) modifiers.push("Shift");
  const mainAsMod = toModifier(mainToken);
  if (mainAsMod && !modifiers.includes(mainAsMod)) modifiers.push(mainAsMod);
  return { modifiers, main };
}
function event(type2, k, modifiers, text) {
  return {
    type: type2,
    modifiers,
    windowsVirtualKeyCode: k.keyCode,
    nativeVirtualKeyCode: k.keyCode,
    key: k.key,
    code: k.code,
    ...text !== void 0 ? { text, unmodifiedText: text } : {},
    ...k.location ? { location: k.location } : {}
  };
}
function comboEvents({ modifiers, main }) {
  const events = [];
  const held = [];
  const mainIsModifier = toModifier(main.key) !== null;
  const pre = mainIsModifier ? modifiers.filter((m) => m !== toModifier(main.key)) : modifiers;
  for (const m of pre) {
    held.push(m);
    events.push(event("keyDown", resolveKey(m), modifierBits(held)));
  }
  const bits = modifierBits(modifiers);
  const shortcut = modifiers.some((m) => m !== "Shift");
  const text = shortcut ? void 0 : main.text;
  events.push(event(text !== void 0 ? "keyDown" : "rawKeyDown", main, bits, text));
  events.push(event("keyUp", main, bits));
  for (const m of [...pre].reverse()) {
    held.pop();
    events.push(event("keyUp", resolveKey(m), modifierBits(held)));
  }
  return events;
}
function charEvents(ch) {
  const control = ch === "\n" || ch === "\r" ? "Enter" : ch === "	" ? "Tab" : null;
  const k = control ? resolveKey(control) : resolveKey(ch);
  if (!k || !control && k.key !== ch) return null;
  return [event(k.text !== void 0 ? "keyDown" : "rawKeyDown", k, 0, k.text), event("keyUp", k, 0)];
}

// extension/src/keyboard.ts
var rng2 = mulberry32(Math.random() * 2 ** 32 >>> 0);
var FOCUS = `(()=>{let el=document.activeElement;while(el&&el.shadowRoot&&el.shadowRoot.activeElement)el=el.shadowRoot.activeElement;if(!el||el===document.body||el===document.documentElement)return null;const tag=el.tagName.toLowerCase();const noText=['button','submit','checkbox','radio','file','image','reset','range','color'];const editable=tag==='textarea'||(tag==='input'&&!noText.includes(el.type))||el.isContentEditable;const ac=String(el.getAttribute&&el.getAttribute('autocomplete')||'');const secret=(tag==='input'&&el.type==='password')||/password/i.test(ac);return {tag,editable,secret}})()`;
async function send(s, e) {
  await s.transport.send("Input.dispatchKeyEvent", { ...e });
}
async function type(s, a) {
  if (a.ref !== void 0) await click(s, { ref: a.ref });
  stage(s.tabId, "focus");
  const focus = await pageEval(s.transport, FOCUS);
  if (!focus) throw new BrowserError("NO_FOCUS", "nothing has focus: pass a ref to type into, or click a field first");
  if (!focus.editable) throw new BrowserError("NOT_EDITABLE", `the focused element (<${focus.tag}>) does not accept text`);
  traceTyping(s.tabId, a.text, { into: focus.tag, secret: focus.secret !== false });
  const mode = a.mode ?? "keys";
  const total = [...a.text].length;
  if (mode === "paste") {
    stage(s.tabId, "typing", { done: 0, total });
    await insertText(s.transport, a.text);
  } else {
    let done = 0;
    for (const ch of a.text) {
      stage(s.tabId, "typing", { done, total });
      const events = charEvents(ch);
      if (events) for (const e of events) await send(s, e);
      else await insertText(s.transport, ch);
      done++;
      await sleep(between(rng2, 15, 50));
    }
  }
  return { typed: [...a.text].length, mode, into: focus.tag };
}
async function pressKey(s, a) {
  const parsed = parseCombo(a.key, a.hold ?? []);
  for (const e of comboEvents(parsed)) {
    await send(s, e);
    await sleep(between(rng2, 5, 20));
  }
  return { pressed: [...parsed.modifiers.filter((m) => m !== parsed.main.key), parsed.main.key].join("+") };
}

// extension/src/navigation.ts
var NAVIGATION_TIMEOUT_MS = 3e4;
function assertNavigableUrl(url) {
  if (url === "about:blank") return;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new BrowserError("INVALID_ARGUMENT", `"${url}" is not an absolute URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BridgeError("URL_NOT_ALLOWED", `only http(s) and about:blank can be opened, got "${parsed.protocol}"`);
  }
}
async function where(s) {
  return pageEval(s.transport, "({url:location.href,title:document.title})");
}
async function awaitLoaded(s, since, what) {
  const limit = lockTimeout(NAVIGATION_TIMEOUT_MS);
  const end = Date.now() + limit;
  while (Date.now() < end) {
    if (s.navigations > since && !s.loading) {
      const ready = await pageEval(s.transport, "document.readyState").catch(() => null);
      if (ready === "complete") return;
    }
    await sleep(50);
  }
  throw new BridgeError("NAVIGATION_TIMEOUT", `${what} did not finish loading within ${limit / 1e3} s`);
}
async function historyNavigate(s, action) {
  const since = s.navigations;
  if (action === "reload") {
    s.refs.clear();
    await s.transport.send("Page.reload");
  } else {
    const h = await s.transport.send("Page.getNavigationHistory");
    const entry = h.entries[h.currentIndex + (action === "back" ? -1 : 1)];
    if (!entry) {
      throw new BridgeError(
        "NAVIGATION_FAILED",
        action === "back" ? "cannot go back: this is the first page in the history of this tab" : "cannot go forward: this is the last page in the history of this tab"
      );
    }
    s.refs.clear();
    await s.transport.send("Page.navigateToHistoryEntry", { entryId: entry.id });
  }
  await awaitLoaded(s, since, action);
  return { action, ...await where(s) };
}
async function navigate(s, a) {
  if (a.action !== void 0 && a.url !== void 0) throw new BrowserError("INVALID_ARGUMENT", "navigate: give url or action, not both");
  if (a.action !== void 0) return historyNavigate(s, a.action);
  if (a.url === void 0) throw new BrowserError("INVALID_ARGUMENT", 'navigate: give url (an absolute URL) or action ("back", "forward" or "reload")');
  assertNavigableUrl(a.url);
  const limit = lockTimeout(NAVIGATION_TIMEOUT_MS);
  const loaded = s.waitFor("Page.loadEventFired", limit);
  let nav;
  try {
    nav = await s.transport.send("Page.navigate", { url: a.url });
  } catch (e) {
    loaded.cancel();
    throw e;
  }
  if (nav.errorText) {
    loaded.cancel();
    throw new BridgeError("NAVIGATION_FAILED", `navigation to ${a.url} failed: ${nav.errorText}`);
  }
  s.refs.clear();
  if (nav.loaderId) {
    if (!await loaded.promise) {
      throw new BridgeError("NAVIGATION_TIMEOUT", `${a.url} did not finish loading within ${limit / 1e3} s`);
    }
  } else {
    loaded.cancel();
  }
  return where(s);
}
async function listTabs(client) {
  const current = await getCurrent(client?.id);
  const rows2 = [];
  for (const [id, entry] of await listEntries()) {
    const t = await chrome.tabs.get(id).catch(() => null);
    if (!t) continue;
    const mine = canAct(entry, client);
    const row2 = { tab: String(id), url: t.url ?? t.pendingUrl ?? "", title: t.title ?? "", active: t.active, current: mine && id === current };
    if (entry.handed) row2.handed = true;
    if (entry.owner !== void 0) {
      row2.owner = entry.owner;
      const name = await clientName(entry.owner);
      if (name) row2.ownerName = name;
      if (!mine) row2.ownedByOther = true;
    }
    rows2.push(row2);
  }
  return rows2;
}
async function createBlankTab(client, preference) {
  const inAgentWindow = client !== void 0 && preference !== "user-window" && await windowPerAgent();
  if (!inAgentWindow) {
    const created = await chrome.tabs.create({ url: "about:blank", active: true });
    return { id: created.id, windowId: created.windowId };
  }
  const existing = await getWindow(client.id);
  if (existing !== null) {
    const created = await chrome.tabs.create({ windowId: existing, url: "about:blank", active: true });
    return { id: created.id, windowId: existing };
  }
  const win = await chrome.windows.create({ url: "about:blank", focused: false });
  const windowId = win.id;
  const first = win.tabs?.[0] ?? (await chrome.tabs.query({ windowId }))[0];
  if (!first?.id) throw new BridgeError("INTERNAL", `the new window ${windowId} has no tab`);
  await setWindow(client.id, windowId);
  return { id: first.id, windowId };
}
async function tabs(a, client) {
  switch (a.action) {
    case "list":
      return { tabs: await listTabs(client) };
    case "new": {
      if (a.url !== void 0) assertNavigableUrl(a.url);
      const { id, windowId } = await createBlankTab(client, a.where);
      let s;
      try {
        s = await takeControl(id, client);
      } catch (e) {
        await chrome.tabs.remove(id).catch(() => void 0);
        throw e;
      }
      await setCurrent(id, client?.id);
      if (a.url && a.url !== "about:blank") await navigate(s, { url: a.url });
      return { tab: String(id), windowId, ...await where(s) };
    }
    case "close": {
      if (a.tab === void 0) throw new BrowserError("INVALID_ARGUMENT", 'tabs close: "tab" is required');
      const id = await resolveTabId(a.tab, client);
      await releaseControl(id);
      await chrome.tabs.remove(id);
      return { closed: String(id) };
    }
    case "activate": {
      if (a.tab === void 0) throw new BrowserError("INVALID_ARGUMENT", 'tabs activate: "tab" is required');
      const id = await resolveTabId(a.tab, client);
      await chrome.tabs.update(id, { active: true });
      await setCurrent(id, client?.id);
      await attachedSession(id, client);
      return { activated: String(id) };
    }
  }
}

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
  failed: (reason2) => `N\xE3o foi poss\xEDvel: ${reason2}`,
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
  /** Modo debug ligado pelo hospedeiro (capabilities.debug): uma linha discreta, sem mexer na faixa nem no badge. */
  debugOn: "Modo de depura\xE7\xE3o ligado",
  /** O atalho da linha de depuração para a página de opções. */
  debugOptions: "Op\xE7\xF5es de depura\xE7\xE3o",
  reloadHint: (expected, running2) => `Atualiza\xE7\xE3o dispon\xEDvel (${expected}; esta \xE9 ${running2}): clique em Recarregar em chrome://extensions.`
};
var EVALUATE = {
  /** Aba entregue pela pessoa, sem a liberação dela (modo `own-tabs`). */
  disabledError: `evaluate is turned off in this tab: the user handed it over, so it is their session. It works in tabs you open yourself (tabs {action:"new"}); for this tab the user must enable "C\xF3digo na p\xE1gina" in the ${P} extension options (chrome://extensions > ${P} > Options).`,
  /** A instalação desligou a evaluate em toda aba (`capabilities.evaluate = off`). */
  disabledByInstallation: `evaluate is turned off by this ${P} installation (capabilities.evaluate = "off"): no script runs in any tab.`,
  /** Uma capability booleana desligada pela instalação (download, upload, pdf, readNetwork). */
  capabilityOff: (tool, capability2) => `${tool} is turned off by this ${P} installation (capabilities.${capability2} = false).`,
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

// extension/src/notice.ts
var HOST_ATTR = "data-atrium-notice";
var VISIBLE_MS = 2100;
var FADE_MS = 400;
var NOTICE_SCRIPT = `(() => {
  document.querySelectorAll('[${HOST_ATTR}]').forEach((h) => h.remove())
  const host = document.createElement('div')
  host.setAttribute('${HOST_ATTR}', '')
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = 'all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647;pointer-events:none'
  const root = host.attachShadow({ mode: 'closed' })
  const box = document.createElement('div')
  box.textContent = ${JSON.stringify(`\u26A0 ${EVALUATE.pageNotice}`)}
  box.style.cssText = 'pointer-events:none;padding:8px 12px;border-radius:6px;font:600 13px/1.3 system-ui,sans-serif;' +
    'color:${ALERT_TEXT_COLOR};background:repeating-linear-gradient(-45deg,${ALERT_COLOR} 0 10px,#e0950f 10px 20px);' +
    'box-shadow:0 2px 8px rgba(0,0,0,.35)'
  root.append(box)
  document.documentElement.append(host)
  box.animate([{ opacity: 1 }, { opacity: 0 }], { delay: ${VISIBLE_MS}, duration: ${FADE_MS}, fill: 'forwards' })
  setTimeout(() => host.remove(), ${VISIBLE_MS + FADE_MS})
})()`;
async function showEvaluateNotice(t) {
  await pageEval(t, NOTICE_SCRIPT);
}
var setHidden = (hidden) => `document.querySelectorAll('[${HOST_ATTR}]').forEach((h) => { h.style.visibility = ${hidden ? "'hidden'" : "'visible'"} })`;
async function withNoticeHidden(t, fn) {
  await pageEval(t, setHidden(true));
  try {
    return await fn();
  } finally {
    await pageEval(t, setHidden(false)).catch(() => void 0);
  }
}

// extension/src/read.ts
var INTERACTIVE = /* @__PURE__ */ new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "option",
  "listbox",
  "treeitem",
  "textarea"
]);
var NOISE = /* @__PURE__ */ new Set(["none", "generic", "InlineTextBox", "LineBreak", "presentation"]);
var SHOWN_PROPS = ["checked", "disabled", "expanded", "selected", "required", "level", "invalid"];
var MAX_REFS = 400;
var MAX_NAME = 200;
var MAX_CHARS = 25e4;
var clip = (s) => s.length > MAX_NAME ? `${s.slice(0, MAX_NAME)}\u2026` : s;
var str2 = (v) => typeof v?.value === "string" ? v.value.replace(/\s+/g, " ").trim() : v?.value === void 0 ? "" : String(v.value);
function buildLines(nodes, maxDepth) {
  const byId = new Map(nodes.map((n2) => [n2.nodeId, n2]));
  const lines = [];
  const refs = /* @__PURE__ */ new Map();
  let n = 0;
  const walk = (node, depth, parentName) => {
    const role = str2(node.role);
    const name = str2(node.name);
    const kids = () => {
      for (const id of node.childIds ?? []) {
        const child = byId.get(id);
        if (child) walk(child, depth, parentName);
      }
    };
    if (node.ignored || role === "InlineTextBox" || role === "LineBreak") return kids();
    if (NOISE.has(role) && !name) return kids();
    if (role === "StaticText") {
      if (name && !parentName.includes(name)) lines.push({ depth, text: `text ${JSON.stringify(clip(name))}`, role, name, own: name });
      return;
    }
    if (maxDepth !== void 0 && depth >= maxDepth) return;
    const props = new Map((node.properties ?? []).map((p) => [p.name, p.value.value]));
    const focusable = props.get("focusable") === true;
    const wantsRef = (INTERACTIVE.has(role) || focusable) && node.backendDOMNodeId !== void 0 && n < MAX_REFS;
    let text = role === "RootWebArea" ? "page" : role || "node";
    if (name) text += ` ${JSON.stringify(clip(name))}`;
    let ref;
    if (wantsRef) {
      ref = `e${++n}`;
      refs.set(ref, node.backendDOMNodeId);
      text += ` [ref=${ref}]`;
    }
    const value = str2(node.value);
    if (value) text += ` value=${JSON.stringify(clip(value))}`;
    for (const p of SHOWN_PROPS) {
      const v = props.get(p);
      if (v === void 0 || v === false || v === "false") continue;
      text += v === true || v === "true" ? ` [${p}]` : ` [${p}=${String(v)}]`;
    }
    const url = props.get("url");
    if (role === "link" && typeof url === "string") text += ` href=${JSON.stringify(clip(url))}`;
    const own = (node.childIds ?? []).map((id) => byId.get(id)).filter((c) => !!c && str2(c.role) === "StaticText").map((c) => str2(c.name)).join(" ");
    lines.push({
      depth,
      text,
      role,
      name,
      own,
      ...ref ? { ref, backendNodeId: node.backendDOMNodeId } : {},
      ...role === "link" && typeof url === "string" ? { url } : {}
    });
    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (child) walk(child, depth + 1, name || parentName);
    }
  };
  const root = nodes[0];
  if (root) walk(root, 0, "");
  return { lines, refs };
}
async function boxOf(s, backendNodeId) {
  try {
    const q = (await s.transport.send("DOM.getBoxModel", { backendNodeId })).model.border;
    const xs = [q[0], q[2], q[4], q[6]];
    const ys = [q[1], q[3], q[5], q[7]];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return ` [box=${Math.round(x)},${Math.round(y)},${Math.round(Math.max(...xs) - x)},${Math.round(Math.max(...ys) - y)}]`;
  } catch {
    return " [no-box]";
  }
}
async function collect2(s, depth) {
  const { nodes } = await s.transport.send("Accessibility.getFullAXTree");
  const { lines, refs } = buildLines(nodes, depth);
  s.refs = refs;
  const where2 = await pageEval(s.transport, "({url:location.href,title:document.title})");
  return { lines, refs, ...where2 };
}
async function snapshot(s, a) {
  const { lines, refs, url, title } = await collect2(s, a.depth);
  for (let i = 0; i < lines.length; i += 32) {
    await Promise.all(
      lines.slice(i, i + 32).map(async (l) => {
        if (l.backendNodeId !== void 0) l.text += await boxOf(s, l.backendNodeId);
      })
    );
  }
  let tree = lines.map((l) => `${"  ".repeat(l.depth)}- ${l.text}`).join("\n");
  if (tree.length > MAX_CHARS) tree = `${tree.slice(0, MAX_CHARS)}
... [snapshot truncated at ${MAX_CHARS} characters; pass depth to get less]`;
  return { url, title, refs: refs.size, snapshot: tree };
}
async function boxJson(s, backendNodeId) {
  const m = /\[box=(-?\d+),(-?\d+),(-?\d+),(-?\d+)\]/.exec(await boxOf(s, backendNodeId));
  return m ? { x: +m[1], y: +m[2], width: +m[3], height: +m[4] } : null;
}
var norm = (v) => v.toLowerCase();
async function find(s, a) {
  const role = a.role?.trim();
  const name = a.name?.trim();
  const text = a.text?.trim();
  if (!role && !name && !text) throw new BrowserError("INVALID_ARGUMENT", "find: give at least one of role, name or text");
  const limit = a.limit ?? 20;
  const { lines, url, title } = await collect2(s);
  const hits = [];
  for (const l of lines) {
    if (!l.ref) continue;
    if (role && norm(l.role) !== norm(role)) continue;
    if (name && !norm(l.name).includes(norm(name))) continue;
    if (text && !norm(`${l.name}
${l.own}`).includes(norm(text))) continue;
    hits.push(l);
    if (hits.length >= limit) break;
  }
  const found = await Promise.all(hits.map(async (l) => ({ ref: l.ref, role: l.role, name: l.name, box: await boxJson(s, l.backendNodeId) })));
  return { url, title, found };
}
async function links(s, a) {
  const limit = a.limit ?? 100;
  const { lines, url, title } = await collect2(s);
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const l = lines[i];
    if (l.role !== "link" || !l.ref || l.url === void 0) continue;
    let href;
    try {
      href = new URL(l.url, url).href;
    } catch {
      continue;
    }
    let text = l.name;
    if (!text) {
      const names = [];
      for (let j = i + 1; j < lines.length && lines[j].depth > l.depth; j++) if (lines[j].name) names.push(lines[j].name);
      text = names.join(" ").trim();
    }
    if (!text && !a.includeUnnamed) continue;
    const key = `${href}\0${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ref: l.ref, text, href });
  }
  return { url, title, links: out };
}
var READ_MAX_CHARS = 5e4;
var READ_SCRIPT = (max) => `(() => {
  const root = document.querySelector('main') || document.querySelector('article') || document.body
  if (!root) return { text: '', truncated: false, source: 'body' }
  const source = root === document.body ? 'body' : root.tagName.toLowerCase()
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'IFRAME', 'SVG', 'CANVAS'])
  const BLOCK = new Set(['block', 'flex', 'grid', 'list-item', 'table', 'table-row', 'table-cell', 'table-caption', 'flow-root'])
  const PARAGRAPH = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'DL', 'TABLE', 'PRE', 'BLOCKQUOTE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'FORM', 'FIGURE'])
  const INLINE_BOX = new Set(['inline-block', 'inline-flex', 'inline-grid', 'inline-table'])
  const CONTROL = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'IMG'])
  const max = ${max}
  let out = ''
  let over = false
  // Separador pendente entre dois trechos de texto: o maior vence (dois blocos vizinhos d\xE3o UMA quebra, n\xE3o duas).
  let pending = ''
  const gapOf = (g) => { if (g.length > pending.length) pending = g }
  const push = (t) => { out += pending + t; pending = ''; if (out.length > max) over = true }
  const walk = (node) => {
    if (over) return
    if (node.nodeType === 3) { const t = node.data.replace(/\\s+/g, ' '); if (t.trim()) push(t); return }
    if (node.nodeType !== 1) return
    const el = node
    const tag = el.tagName.toUpperCase()
    if (SKIP.has(tag)) return
    if (el.hidden) return
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') return
    if (tag === 'BR') { out += '\\n'; pending = ''; return }
    const block = BLOCK.has(cs.display)
    const gap = PARAGRAPH.has(tag) ? '\\n\\n' : block ? '\\n' : INLINE_BOX.has(cs.display) || CONTROL.has(tag) ? ' ' : ''
    gapOf(gap)
    if (tag === 'LI') push('- ')
    if (tag === 'SELECT') {
      push('[' + (el.selectedOptions[0] ? el.selectedOptions[0].text : '') + ']')
    } else if (tag === 'INPUT') {
      const type = (el.type || 'text').toLowerCase()
      if (type === 'checkbox' || type === 'radio') push(el.checked ? '[x]' : '[ ]')
      else if (type === 'button' || type === 'submit' || type === 'reset') push(el.value)
      else if (type !== 'password' && type !== 'hidden' && el.value) push('[' + el.value + ']')
    } else if (tag === 'TEXTAREA') {
      if (el.value) push('[' + el.value + ']')
    } else if (tag === 'IMG') {
      if (el.alt) push(el.alt)
    } else {
      const before = out.length
      const kids = el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes
      for (const c of kids) walk(c)
      if (tag === 'A' && typeof el.href === 'string' && /^https?:/.test(el.href)) {
        const label = out.slice(before).trim()
        if (label && label !== el.href) { out += ' (' + el.href + ')'; pending = '' }
      }
    }
    gapOf(gap)
  }
  walk(root)
  const text = out
    .replace(/[ \\t]+\\n/g, '\\n')
    .replace(/\\n[ \\t]+/g, '\\n')
    .replace(/ {2,}/g, ' ')
    .replace(/\\n{3,}/g, '\\n\\n')
    .trim()
  return { text: text.slice(0, max), truncated: over || text.length > max, source }
})()`;
async function read(s, a) {
  const max = a.maxChars ?? READ_MAX_CHARS;
  const r = await pageEval(s.transport, READ_SCRIPT(max));
  const where2 = await pageEval(s.transport, "({url:location.href,title:document.title})");
  return { ...where2, ...r };
}
async function screenshot2(s, a) {
  const format = a.format ?? "png";
  const params = { format, captureBeyondViewport: a.fullPage === true };
  if (format === "jpeg" && a.quality !== void 0) params.quality = a.quality;
  if (a.ref !== void 0) {
    const target = await aim(s, { ref: a.ref });
    const b = target.box;
    const vp = await viewport(s);
    params.clip = { x: b.x + vp.pageX, y: b.y + vp.pageY, width: b.width, height: b.height, scale: 1 };
  }
  try {
    const r = await withTimeout(
      withNoticeHidden(s.transport, () => s.transport.send("Page.captureScreenshot", params)),
      15e3,
      () => new BrowserError("SCREENSHOT_FAILED", 'screenshot timed out: the tab is probably in the background; activate it with tabs {action:"activate"}')
    );
    return { mimeType: `image/${format}`, data: r.data };
  } catch (e) {
    if (e instanceof BrowserError && e.code === "SCREENSHOT_FAILED") throw e;
    throw new BrowserError("SCREENSHOT_FAILED", e.message, { cause: e });
  }
}
var LEVEL_RANK = { debug: 0, log: 1, info: 2, warning: 3, error: 4 };
function readConsole(s, a) {
  const min = LEVEL_RANK[a.level ?? "debug"];
  const entries = s.console.filter((e) => e.seq > (a.afterSeq ?? 0) && LEVEL_RANK[e.level] >= min).slice(0, a.limit ?? 100);
  const lastSeq = s.console.at(-1)?.seq ?? 0;
  if (a.clear) s.console.length = 0;
  return { entries, lastSeq };
}
var EVALUATE_TIMEOUT_MS = 15e3;
var EVALUATE_MAX_CHARS = 2e5;
async function evaluate(s, a) {
  const r = await withTimeout(
    s.transport.send("Runtime.evaluate", {
      expression: a.expression,
      returnByValue: true,
      awaitPromise: a.awaitPromise ?? true
    }),
    lockTimeout(EVALUATE_TIMEOUT_MS),
    () => new BrowserError("EVALUATE_TIMEOUT", `expression did not finish within ${lockTimeout(EVALUATE_TIMEOUT_MS)} ms`)
  );
  if (r.exceptionDetails) {
    throw new BrowserError("EVALUATE_FAILED", `page script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  }
  const result = r.result;
  const value = result.unserializableValue ?? (result.type === "undefined" ? null : result.value);
  if (JSON.stringify(value ?? null).length > EVALUATE_MAX_CHARS) {
    throw new BrowserError("EVALUATE_RESULT_TOO_LARGE", `the result is larger than ${EVALUATE_MAX_CHARS} characters; return less`);
  }
  return { value: value ?? null };
}

// extension/src/files.ts
var PROBE_FILE_INPUT = `function () {
  if (!(this instanceof HTMLInputElement) || this.type !== 'file') return null
  return { multiple: this.multiple, files: Array.from(this.files || []).map((f) => ({ name: f.name, size: f.size, type: f.type })) }
}`;
async function withObject2(s, ref, fn) {
  const backendNodeId = backendNodeOf(s, ref);
  let objectId;
  try {
    objectId = (await s.transport.send("DOM.resolveNode", { backendNodeId })).object.objectId;
  } catch (e) {
    throw new BrowserError("STALE_REF", `ref "${ref}" no longer exists in the page; take a new snapshot`, { cause: e });
  }
  try {
    return await fn(objectId, backendNodeId);
  } finally {
    await s.transport.send("Runtime.releaseObject", { objectId }).catch(() => void 0);
  }
}
async function callOn2(s, objectId, functionDeclaration) {
  const r = await s.transport.send("Runtime.callFunctionOn", { objectId, functionDeclaration, returnByValue: true });
  if (r.exceptionDetails) {
    throw new BrowserError("EVALUATE_FAILED", `page script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  }
  return r.result?.value;
}
function ownerFrameIn(node, target, frame) {
  if (node.backendNodeId === target) return frame;
  for (const child of [...node.children ?? [], ...node.shadowRoots ?? [], ...node.templateContent ? [node.templateContent] : []]) {
    const hit = ownerFrameIn(child, target, frame);
    if (hit !== null) return hit;
  }
  if (node.contentDocument) return ownerFrameIn(node.contentDocument, target, node.frameId ?? frame);
  return null;
}
function originOfFrame(f) {
  if (f.securityOrigin && f.securityOrigin !== "://") return f.securityOrigin;
  try {
    return new URL(f.url).origin;
  } catch {
    return "null";
  }
}
async function originsOf(s, backendNodeId) {
  return (await ownerOf(s, backendNodeId))?.origins ?? null;
}
async function ownerOf(s, backendNodeId) {
  const { root } = await s.transport.send("DOM.getDocument", { depth: -1, pierce: true });
  const { frameTree } = await s.transport.send("Page.getFrameTree");
  const frames = /* @__PURE__ */ new Map();
  const walk = (n) => {
    frames.set(n.frame.id, n.frame);
    for (const c of n.childFrames ?? []) walk(c);
  };
  walk(frameTree);
  const owner = ownerFrameIn(root, backendNodeId, frameTree.frame.id);
  if (owner === null) return null;
  const origins = [];
  for (let f = frames.get(owner); f; f = f.parentId ? frames.get(f.parentId) : void 0) origins.push(originOfFrame(f));
  if (origins.length === 0) throw new BridgeError("UPLOAD_FAILED", "could not tell which page owns the file field; nothing was sent");
  return { frameId: owner, origins };
}
async function emptyField(s, backendNodeId, frameId) {
  await s.transport.send("DOM.setFileInputFiles", { files: [], backendNodeId }).catch(() => void 0);
  try {
    const { executionContextId } = await s.transport.send("Page.createIsolatedWorld", { frameId, worldName: "bridge-upload-guard" });
    const { object } = await s.transport.send("DOM.resolveNode", { backendNodeId, executionContextId });
    try {
      return await callOn2(s, object.objectId, `function () { this.value = ''; return this.files ? this.files.length : 0 }`);
    } finally {
      await s.transport.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => void 0);
    }
  } catch {
    return -1;
  }
}
var sameChain = (a, b) => !!a && a.length === b.length && a.every((o, i) => o === b[i]);
function changeOf(now, before) {
  if (!now) return "the field is no longer in the page";
  if (now[0] !== before[0]) return `the page that owns the field is now ${now[0]}, not ${before[0]}`;
  if (now[now.length - 1] !== before[before.length - 1]) return `the tab is now ${now[now.length - 1]}, not ${before[before.length - 1]}`;
  return `the frame chain is now ${now.join(" > ")}, not ${before.join(" > ")}`;
}
async function uploadTarget(s, a) {
  return withObject2(s, a.ref, async (objectId, backendNodeId) => {
    const probe = await callOn2(s, objectId, PROBE_FILE_INPUT);
    if (!probe) throw new BridgeError("NOT_A_FILE_INPUT", `ref "${a.ref}" is not an <input type="file">; find the file field of the form and pass its ref`);
    const origins = await originsOf(s, backendNodeId);
    if (!origins) throw new BrowserError("STALE_REF", `ref "${a.ref}" no longer exists in the page; take a new snapshot`);
    return { tab: String(s.tabId), origins, multiple: probe.multiple };
  });
}
async function upload(s, a) {
  if (!Array.isArray(a.paths) || a.paths.length === 0) throw new BrowserError("INVALID_ARGUMENT", "upload: give at least one path");
  const expect = a.expect;
  return withObject2(s, a.ref, async (objectId, backendNodeId) => {
    const probe = await callOn2(s, objectId, PROBE_FILE_INPUT);
    if (!probe) throw new BridgeError("NOT_A_FILE_INPUT", `ref "${a.ref}" is not an <input type="file">; find the file field of the form and pass its ref`);
    if (a.paths.length > 1 && !probe.multiple) {
      throw new BrowserError("INVALID_ARGUMENT", `upload: this file input accepts a single file (no multiple attribute); ${a.paths.length} paths were given`);
    }
    const refused = (chain, change, emptied) => new BridgeError(
      "UPLOAD_NOT_ALLOWED",
      `The destination of the upload changed ${emptied ? "while the files were being attached" : "after it was authorized"} (${change}); the authorization was for ${chain[0]}` + (chain.length > 1 ? ` in ${chain[chain.length - 1]}` : "") + `. ${emptied ? "The field was emptied and the" : "Nothing was attached; the"} upload was refused. Look at the page again (snapshot) before trying anything else; do not try to work around this.`,
      { expected: chain }
    );
    let frameId = "";
    if (expect) {
      const before = await ownerOf(s, backendNodeId);
      if (!before || !sameChain(before.origins, expect)) throw refused(expect, changeOf(before?.origins ?? null, expect), false);
      frameId = before.frameId;
    }
    let failure = null;
    try {
      await s.transport.send("DOM.setFileInputFiles", { files: a.paths, backendNodeId });
    } catch (err) {
      failure = { err };
    }
    if (expect) {
      const after2 = await originsOf(s, backendNodeId).catch(() => null);
      if (!sameChain(after2, expect)) {
        const left = await emptyField(s, backendNodeId, frameId);
        const err = refused(expect, changeOf(after2, expect), true);
        if (left !== 0) err.message += " Warning: the field could not be confirmed empty; tell the user.";
        throw err;
      }
    }
    if (failure) throw new BridgeError("UPLOAD_FAILED", `the browser refused to attach the files: ${failure.err.message}`);
    const after = await callOn2(s, objectId, PROBE_FILE_INPUT);
    const files = after?.files ?? [];
    if (files.length !== a.paths.length) {
      throw new BridgeError("UPLOAD_FAILED", `${a.paths.length} file(s) were given but the input ended up with ${files.length}`);
    }
    return { files };
  });
}
var DOWNLOAD_TIMEOUT_MS = 6e4;
var POLL_MS = 150;
var TRACKED_KEY = "bridgeDownloads";
var TRACKED_MAX = 200;
async function trackedIds() {
  return (await chrome.storage.session.get(TRACKED_KEY))[TRACKED_KEY] ?? [];
}
async function remember(id) {
  const ids = (await trackedIds()).filter((x) => x !== id);
  ids.push(id);
  await chrome.storage.session.set({ [TRACKED_KEY]: ids.slice(-TRACKED_MAX) });
}
var describe = (d) => ({
  id: d.id,
  path: d.filename,
  bytes: d.fileSize > 0 ? d.fileSize : d.bytesReceived,
  mime: d.mime,
  url: d.finalUrl || d.url,
  state: d.state,
  startedAt: d.startTime,
  ...d.error ? { error: d.error } : {}
});
async function item(id) {
  return (await chrome.downloads.search({ id }))[0];
}
function assertDownloadUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new BrowserError("INVALID_ARGUMENT", `"${url}" is not an absolute URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BridgeError("URL_NOT_ALLOWED", `only http(s) URLs can be downloaded, got "${parsed.protocol}"`);
  }
}
function nextCreated(timeoutMs) {
  let listener;
  let timer2;
  const promise = new Promise((resolve, reject) => {
    listener = (d) => resolve(d);
    chrome.downloads.onCreated.addListener(listener);
    timer2 = setTimeout(() => reject(new BridgeError("DOWNLOAD_TIMEOUT", `the click did not start a download within ${timeoutMs} ms`)), timeoutMs);
  });
  const cancel = () => {
    clearTimeout(timer2);
    chrome.downloads.onCreated.removeListener(listener);
  };
  return { promise: promise.finally(cancel), cancel };
}
async function awaitDone(id, timeoutMs) {
  const end = Date.now() + timeoutMs;
  for (; ; ) {
    const d = await item(id);
    if (!d) throw new BridgeError("DOWNLOAD_FAILED", `download ${id} disappeared from the browser`);
    if (d.state === "complete") return describe(d);
    if (d.state === "interrupted") throw new BridgeError("DOWNLOAD_FAILED", `download of ${d.finalUrl || d.url} failed: ${d.error ?? "interrupted"}`, { download: describe(d) });
    if (Date.now() >= end) {
      throw new BridgeError("DOWNLOAD_TIMEOUT", `download ${id} (${d.finalUrl || d.url}) did not finish within ${timeoutMs} ms; it continues in the browser: check it with downloads {action:"list"}`, {
        download: describe(d)
      });
    }
    await sleep(POLL_MS);
  }
}
async function download(s, a) {
  if (a.ref === void 0 === (a.url === void 0)) throw new BrowserError("INVALID_ARGUMENT", "download: give exactly one of ref or url");
  const timeoutMs = a.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  let id;
  if (a.url !== void 0) {
    assertDownloadUrl(a.url);
    try {
      id = await chrome.downloads.download({ url: a.url, conflictAction: "uniquify", saveAs: false });
    } catch (e) {
      throw new BridgeError("DOWNLOAD_FAILED", `the browser refused to download ${a.url}: ${e.message}`);
    }
  } else {
    const created = nextCreated(timeoutMs);
    try {
      await click(s, { ref: a.ref });
    } catch (e) {
      created.cancel();
      throw e;
    }
    id = (await created.promise).id;
  }
  await remember(id);
  return awaitDone(id, timeoutMs);
}
async function downloads(a) {
  if (a.action !== "list") throw new BrowserError("INVALID_ARGUMENT", 'downloads: action must be "list"');
  const tracked = new Set(await trackedIds());
  if (tracked.size === 0) return { downloads: [] };
  const all = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 0 });
  return { downloads: all.filter((d) => tracked.has(d.id)).slice(0, a.limit ?? 50).map(describe) };
}
var PDF_TIMEOUT_MS = 6e4;
async function pdf(s, a) {
  const where2 = await pageEval(s.transport, "({url:location.href,title:document.title})");
  const params = {
    printBackground: a.printBackground ?? true,
    landscape: a.landscape ?? false,
    preferCSSPageSize: true
  };
  if (a.scale !== void 0) params.scale = a.scale;
  if (a.pageRanges !== void 0) params.pageRanges = a.pageRanges;
  let data;
  try {
    const r = await withTimeout(s.transport.send("Page.printToPDF", params), lockTimeout(PDF_TIMEOUT_MS), () => new BridgeError("PDF_FAILED", `printing did not finish within ${lockTimeout(PDF_TIMEOUT_MS) / 1e3} s`));
    data = r.data;
  } catch (e) {
    if (e instanceof BridgeError) throw e;
    throw new BridgeError("PDF_FAILED", `the browser could not print this page: ${e.message}`);
  }
  if (typeof data !== "string" || !data) throw new BridgeError("PDF_FAILED", "the browser returned an empty PDF");
  return { data, ...where2, ...a.filename !== void 0 ? { filename: a.filename } : {} };
}

// extension/src/network.ts
var BODY_MAX_CHARS = 1e5;
var row = (e) => {
  const { ts: _ts, ...rest } = e;
  void _ts;
  return rest;
};
async function readNetwork(s, a) {
  if (a.id !== void 0) {
    const entry = s.requestById(a.id);
    if (!entry) throw new BridgeError("REQUEST_NOT_FOUND", `no request with id "${a.id}" in this tab's recent network activity; list them with readNetwork first`);
    if (!a.body) return { request: row(entry) };
    const max = a.maxChars ?? BODY_MAX_CHARS;
    let r;
    try {
      r = await s.transport.send("Network.getResponseBody", { requestId: a.id });
    } catch (e) {
      throw new BridgeError(
        "BODY_UNAVAILABLE",
        `the browser no longer has the response body of ${entry.url} (${e.message}); bodies are kept only while the page that loaded them is open`
      );
    }
    const truncated = r.body.length > max;
    return { request: row(entry), body: { text: truncated ? r.body.slice(0, max) : r.body, base64Encoded: r.base64Encoded, truncated } };
  }
  if (a.body) throw new BrowserError("INVALID_ARGUMENT", "readNetwork: body needs the id of one request");
  const after = a.afterSeq ?? 0;
  const needle = a.urlContains?.toLowerCase();
  const requests = s.requests.filter((e) => e.seq > after && (!needle || e.url.toLowerCase().includes(needle))).slice(0, a.limit ?? 100).map(row);
  return { requests, lastSeq: s.requests.at(-1)?.seq ?? 0 };
}
async function resize(s, a) {
  if (a.reset) {
    await s.transport.send("Emulation.clearDeviceMetricsOverride");
    s.emulated = null;
  } else {
    if (a.width === void 0 || a.height === void 0) throw new BrowserError("INVALID_ARGUMENT", "resize: give width and height (or reset: true)");
    await s.transport.send("Emulation.setDeviceMetricsOverride", { width: a.width, height: a.height, deviceScaleFactor: 0, mobile: false });
    s.emulated = { width: a.width, height: a.height };
  }
  const inner = await pageEval(s.transport, "({innerWidth, innerHeight})");
  return { width: s.emulated?.width ?? inner.innerWidth, height: s.emulated?.height ?? inner.innerHeight, ...inner, emulated: s.emulated !== null };
}

// extension/src/wait.ts
var DEFAULT_TIMEOUT_MS = 15e3;
var MAX_WAIT_MS = 12e4;
var POLL_MS2 = 100;
var IDLE_MS = 500;
var WITH_VALUE = /* @__PURE__ */ new Set(["text", "selector", "url", "time"]);
async function wait(s, a) {
  const timeoutMs = a.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WAIT_MS) {
    throw new BrowserError("INVALID_ARGUMENT", `wait: timeoutMs must be an integer from 1 to ${MAX_WAIT_MS}`);
  }
  const value = a.value;
  if (WITH_VALUE.has(a.for)) {
    if (typeof value !== "string" || value === "") throw new BrowserError("INVALID_ARGUMENT", `wait ${a.for}: "value" is required`);
  } else if (value !== void 0) {
    throw new BrowserError("INVALID_ARGUMENT", `wait ${a.for}: "value" is not used; drop it`);
  }
  stage(s.tabId, "waiting");
  const started = Date.now();
  const currentUrl = () => pageEval(s.transport, "location.href").catch(() => "");
  const done = async () => ({ matched: a.for, elapsedMs: Date.now() - started, url: await currentUrl() });
  if (a.for === "time") {
    const ms = Number(value);
    if (!Number.isInteger(ms) || ms < 0 || ms > MAX_WAIT_MS) {
      throw new BrowserError("INVALID_ARGUMENT", `wait time: value must be a number of milliseconds from 0 to ${MAX_WAIT_MS}, got "${value}"`);
    }
    await sleep(ms);
    return done();
  }
  let idleSince = null;
  let check;
  let describe2;
  switch (a.for) {
    case "load":
      describe2 = "the page to finish loading";
      check = async () => !s.loading && await pageEval(s.transport, "document.readyState") === "complete";
      break;
    case "networkidle":
      describe2 = `the network to be idle for ${IDLE_MS} ms`;
      check = async () => {
        if (s.loading || s.inflightCount() > 0) {
          idleSince = null;
          return false;
        }
        idleSince ??= Date.now();
        return Date.now() - idleSince >= IDLE_MS;
      };
      break;
    case "text":
      describe2 = `text ${JSON.stringify(value)}`;
      check = () => pageEval(s.transport, `((document.body && document.body.innerText) || '').includes(${JSON.stringify(value)})`);
      break;
    case "selector":
      describe2 = `an element matching ${JSON.stringify(value)} to be visible`;
      check = async () => {
        const r = await pageEval(
          s.transport,
          `(() => { try { const el = document.querySelector(${JSON.stringify(value)}); return !!el && el.getClientRects().length > 0 } catch (e) { return 'invalid' } })()`
        );
        if (r === "invalid") throw new BrowserError("INVALID_ARGUMENT", `wait selector: ${JSON.stringify(value)} is not a valid CSS selector`);
        return r;
      };
      break;
    case "url":
      describe2 = `the URL to contain ${JSON.stringify(value)}`;
      check = () => pageEval(s.transport, `location.href.includes(${JSON.stringify(value)})`);
      break;
    default:
      throw new BrowserError("INVALID_ARGUMENT", `wait: unknown condition "${String(a.for)}"`);
  }
  const end = started + timeoutMs;
  for (; ; ) {
    try {
      if (await check()) return done();
    } catch (e) {
      if (e instanceof BrowserError && e.code === "INVALID_ARGUMENT") throw e;
    }
    const left = end - Date.now();
    if (left <= 0) throw new BrowserError("WAIT_TIMEOUT", `timed out after ${timeoutMs} ms waiting for ${describe2}`);
    await sleep(Math.min(POLL_MS2, left));
  }
}

// extension/src/tools.ts
var locks = /* @__PURE__ */ new Map();
function inTabQueue(tabId, callId, fn) {
  enqueue(callId, tabId);
  const turn = async () => {
    startRunning(callId, tabId);
    try {
      return await fn();
    } finally {
      leaveQueue(callId, tabId);
    }
  };
  const run = (locks.get(tabId) ?? Promise.resolve()).then(turn, turn);
  locks.set(tabId, run.catch(() => void 0));
  return run;
}
var DIALOG_RACE_MS = 6e5;
async function guardedByDialog(s, tool, callId, fn) {
  setCallStage(callId, "dialog-guard");
  if (tool === "dialog") {
    setCallStage(callId, "run");
    return fn(s);
  }
  if (s.dialog) {
    traceGate(callId, "dialog", "deny", `a ${s.dialog.type} dialog is open`);
    throw dialogOpenError(s.dialog);
  }
  traceGate(callId, "dialog", "allow", "no dialog open");
  const opened = s.waitFor("Page.javascriptDialogOpening", DIALOG_RACE_MS);
  setCallStage(callId, "run");
  const run = fn(s);
  try {
    const dialogWon = opened.promise.then((fired) => fired ? "dialog" : new Promise(() => void 0));
    const outcome = await Promise.race([run.then((value) => ({ value })), dialogWon]);
    if (outcome !== "dialog") return outcome.value;
  } finally {
    opened.cancel();
  }
  run.catch(() => void 0);
  traceGate(callId, "dialog", "deny", "a dialog opened during the gesture");
  s.pending = run;
  throw dialogOpenError(s.dialog ?? { type: "alert", message: "", defaultPrompt: "" });
}
async function onTabFor(tool, a, client, callId, fn) {
  setCallStage(callId, "resolve-tab");
  const tabId = await scopeGate(callId, () => resolveTabId(a.tab, client));
  return inTabQueue(tabId, callId, async () => {
    setCallStage(callId, "attach");
    const s = await scopeGate(callId, () => attachedSession(tabId, client));
    traceGate(callId, "scope", "allow", `tab ${tabId} is in scope${client ? ` for ${client.id}` : ""}`);
    return guardedByDialog(s, tool, callId, fn);
  });
}
var SCOPE_CODES = /* @__PURE__ */ new Set(["TAB_OUT_OF_SCOPE", "TAB_OWNED_BY_OTHER", "NO_ACTIVE_TAB"]);
async function scopeGate(callId, run) {
  try {
    return await run();
  } catch (e) {
    const code = e.code;
    if (typeof code === "string" && SCOPE_CODES.has(code)) traceGate(callId, code === "TAB_OWNED_BY_OTHER" ? "owner" : "scope", "deny", `${code}: ${e.message}`);
    throw e;
  }
}
var GATED = { upload: "upload", uploadTarget: "upload", download: "download", downloads: "download", pdf: "pdf", readNetwork: "readNetwork" };
async function assertCapability(tool, callId) {
  const name = GATED[tool];
  if (!name) return;
  const on = await capability(name, true);
  traceGate(callId, "capability", on ? "allow" : "deny", `capability "${name}" is ${on ? "on" : "off"}`);
  if (!on) throw new BridgeError("CAPABILITY_DISABLED", EVALUATE.capabilityOff(tool, name), { capability: name });
}
async function assertEvaluateAllowed(entry, callId) {
  const mode = await evaluateMode();
  if (mode === "off") {
    traceGate(callId, "evaluate", "deny", 'evaluate mode is "off"');
    throw new BridgeError("EVALUATE_DISABLED", EVALUATE.disabledByInstallation, { mode });
  }
  if (mode === "all" || !entry?.handed) {
    traceGate(callId, "evaluate", "allow", mode === "all" ? 'evaluate mode is "all"' : `evaluate mode is "${mode}" and the agent opened this tab`);
    return;
  }
  const allowed = await getAllowEvaluate();
  traceGate(callId, "evaluate", allowed ? "allow" : "deny", `handed-over tab; the user ${allowed ? "allowed" : "has not allowed"} code in the page`);
  if (!allowed) throw new BridgeError("EVALUATE_DISABLED", EVALUATE.disabledError, { mode, handed: true });
}
async function runTool(tool, a, client, callId = localCallId()) {
  const onTab = (args, fn) => onTabFor(tool, args, client, callId, fn);
  const gesture = (args, fn) => {
    noteTargetHint(callId, { ref: args.ref, x: args.x, y: args.y });
    return onTab(args, (s) => withPageEvents(s, callId, tool, { ref: args.ref, x: args.x, y: args.y }, () => fn(s)));
  };
  await assertCapability(tool, callId);
  switch (tool) {
    case "diagnose": {
      const tabId = a.tab !== void 0 ? Number(a.tab) : void 0;
      return diagnose({ ...typeof a.callId === "string" ? { callId: a.callId } : {}, ...Number.isInteger(tabId) ? { tabId } : {} }, callId);
    }
    case "tabs":
      return tabs({ action: a.action, url: a.url, tab: a.tab, where: a.where }, client);
    case "navigate":
      return onTab(a, (s) => navigate(s, { url: a.url, action: a.action }));
    case "wait":
      return onTab(a, (s) => wait(s, { for: a.for, value: a.value, timeoutMs: a.timeoutMs }));
    case "snapshot":
      return onTab(a, (s) => snapshot(s, { depth: a.depth }));
    case "find":
      return onTab(a, (s) => find(s, { role: a.role, name: a.name, text: a.text, limit: a.limit }));
    case "read":
      return onTab(a, (s) => read(s, { maxChars: a.maxChars }));
    case "links":
      return onTab(a, (s) => links(s, { limit: a.limit, includeUnnamed: a.includeUnnamed }));
    case "screenshot":
      return onTab(a, (s) => screenshot2(s, { fullPage: a.fullPage, ref: a.ref, format: a.format, quality: a.quality }));
    case "click":
      return gesture(a, (s) => click(s, { ref: a.ref, x: a.x, y: a.y, button: a.button, count: a.count }));
    case "hover":
      return gesture(a, (s) => hover(s, { ref: a.ref, x: a.x, y: a.y }));
    case "drag":
      return gesture(a, (s) => drag(s, { ref: a.ref, x: a.x, y: a.y, toRef: a.toRef, toX: a.toX, toY: a.toY }));
    case "scroll":
      return onTab(a, (s) => scroll(s, { ref: a.ref, x: a.x, y: a.y, byX: a.byX, byY: a.byY, to: a.to }));
    case "type":
      return gesture(a, (s) => type(s, { text: a.text, ref: a.ref, mode: a.mode }));
    case "pressKey":
      return gesture(a, (s) => pressKey(s, { key: a.key, hold: a.hold }));
    case "dialog":
      return onTab(a, (s) => dialog(s, { action: a.action, text: a.text }));
    case "select":
      return gesture(a, (s) => select(s, { ref: a.ref, value: a.value, label: a.label }));
    case "setChecked":
      return gesture(a, (s) => setChecked(s, { ref: a.ref, checked: a.checked }));
    case "readConsole":
      return onTab(a, async (s) => readConsole(s, { level: a.level, afterSeq: a.afterSeq, limit: a.limit, clear: a.clear }));
    case "uploadTarget":
      return onTab(a, (s) => uploadTarget(s, { ref: a.ref }));
    case "upload":
      return onTab(a, (s) => upload(s, { ref: a.ref, paths: a.paths, ...Array.isArray(a.expect) ? { expect: a.expect } : {} }));
    case "download":
      return onTab(a, (s) => download(s, { ref: a.ref, url: a.url, timeoutMs: a.timeoutMs }));
    case "downloads":
      return downloads({ action: a.action, limit: a.limit });
    case "pdf":
      return onTab(a, (s) => pdf(s, { filename: a.filename, landscape: a.landscape, scale: a.scale, pageRanges: a.pageRanges, printBackground: a.printBackground }));
    case "readNetwork":
      return onTab(a, async (s) => readNetwork(s, { afterSeq: a.afterSeq, limit: a.limit, urlContains: a.urlContains, id: a.id, body: a.body, maxChars: a.maxChars }));
    case "resize":
      return onTab(a, (s) => resize(s, { width: a.width, height: a.height, reset: a.reset }));
    case "evaluate":
      return onTab(a, async (s) => {
        await assertEvaluateAllowed(await entryOf(s.tabId), callId);
        await showEvaluateNotice(s.transport);
        return evaluate(s, { expression: a.expression, awaitPromise: a.awaitPromise });
      });
    default:
      throw new BridgeError("UNKNOWN_TOOL", `the extension does not implement "${tool}"`);
  }
}

// extension/src/connection.ts
var PING_MS = 2e4;
var BACKOFF_START_MS = 1e3;
var BACKOFF_MAX_MS = 3e4;
var DaemonConnection = class {
  ws = null;
  pingTimer = null;
  retryTimer = null;
  backoff = BACKOFF_START_MS;
  denied = false;
  generation = 0;
  opening = null;
  constructor() {
    setReporter((msg) => this.send(msg));
    setTraceSink((events) => this.send({ t: "trace", events }));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && DEBUG_CHOICE_STORAGE_KEY in changes) void this.sendDebugChoice();
    });
    void getDebugChoice().then((c) => {
      this.debugChoice ??= c;
    });
  }
  /** Abre a conexão se não há uma viva. Chamada pelo startup, pelo alarme e pela troca de opções. */
  async ensure() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (await applySeed()) return;
    if (this.denied) return;
    await this.start();
  }
  /** As opções mudaram: recomeça do zero (também sai do estado "recusado"). */
  async restart() {
    this.denied = false;
    this.backoff = BACKOFF_START_MS;
    this.close();
    await this.start();
  }
  /** Uma abertura por vez: startup, alarme e opções podem chamar juntos. */
  start() {
    this.opening ??= this.open().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }
  close() {
    this.generation++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.retryTimer = this.pingTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close();
    }
  }
  async open() {
    const settings = await loadSettings();
    if (!settings.token) {
      await setStatus({ state: "unpaired", detail: "paste the pairing token in the options page" });
      return;
    }
    if (this.denied) return;
    const gen = ++this.generation;
    await setStatus({ state: "connecting" });
    const ws = new WebSocket(`ws://127.0.0.1:${settings.port}${WS_PATH}`);
    this.ws = ws;
    ws.onopen = async () => {
      const hello = {
        t: "hello",
        v: PROTOCOL_VERSION,
        id: await bridgeId(),
        name: settings.name,
        userAgent: navigator.userAgent,
        token: settings.token
      };
      ws.send(JSON.stringify(hello));
    };
    ws.onmessage = (ev) => {
      if (gen !== this.generation) return;
      const msg = JSON.parse(String(ev.data));
      if (msg.t === "welcome") {
        this.backoff = BACKOFF_START_MS;
        void setStatus({ state: "connected" });
        void saveHostBrand(msg.brand);
        void saveHostCapabilities(msg.capabilities);
        this.applyDebug(msg.capabilities);
        void saveHostDebugMode(void 0).then(() => this.sendDebugChoice());
        this.pingTimer = setInterval(() => this.send({ t: "ping" }), PING_MS);
        void publishTabs();
        void publishFocusIfFocused();
        void maybeReloadForVersion(msg.extensionVersion);
      } else if (msg.t === "status") {
        void saveHostStatus({ paused: msg.paused === true, clients: Array.isArray(msg.clients) ? msg.clients : [] });
      } else if (msg.t === "denied") {
        this.denied = true;
        void setStatus({ state: "denied", detail: msg.reason });
        void applySeed();
      } else if (msg.t === "call") {
        void this.handleCall(msg.rid, () => runTool(msg.tool, msg.args, msg.client, msg.rid), { tool: msg.tool, client: msg.client?.id });
      } else if (msg.t === "release") {
        void this.handleCall(msg.rid, () => releaseClient(msg.client), { tool: "release" });
      } else if (msg.t === "release-all") {
        void this.handleCall(msg.rid, () => releaseAll(), { tool: "release-all" });
      } else if (msg.t === "inspect") {
        void this.handleCall(msg.rid, () => inspectCall(msg.call));
      } else if (msg.t === "dump-request") {
        void this.handleCall(msg.rid, () => collectDump(msg.call));
      } else if (msg.t === "config") {
        void saveHostBrand(msg.brand);
        void saveHostCapabilities(msg.capabilities);
        this.applyDebug(msg.capabilities);
        void saveHostDebugMode(msg.debugMode);
      }
    };
    ws.onclose = () => {
      if (gen !== this.generation) return;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.ws = null;
      if (this.denied) return;
      void setStatus({ state: "disconnected", detail: `retrying in ${Math.round(this.backoff / 1e3)} s` });
      const delay = this.backoff + Math.random() * 300;
      this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
      this.retryTimer = setTimeout(() => void this.start(), delay);
    };
    ws.onerror = () => {
    };
  }
  /** Conectado ao daemon agora? (O popup só pausa/retoma pelo daemon; sem ele, só solta as abas localmente.) */
  isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }
  /** A pessoa pausou ou retomou pelo popup (A12): o daemon faz o mesmo que em POST /pause e /resume. Devolve false sem conexão. */
  setPaused(paused) {
    if (!this.isOpen()) return false;
    this.send({ t: paused ? "pause" : "resume" });
    return true;
  }
  /**
   * O modo debug desta extensão: só liga com a escolha da pessoa AQUI e a confirmação do daemon. Um daemon que mande
   * `debug: true` sem ela ter escolhido não liga nada (o hospedeiro não toma o controle do navegador).
   */
  applyDebug(capabilities) {
    const chosen = this.debugChoice?.enabled === true;
    setDebug(chosen && capabilities?.debug === true, debugTimeoutOf(capabilities?.debugCallTimeoutMs));
  }
  /** A escolha da pessoa, em memória (aplicar o modo é síncrono: a chamada seguinte já o segue). */
  debugChoice = null;
  /** F6: manda ao daemon o modo debug que a pessoa escolheu aqui (sem escolha guardada, nada sai). */
  async sendDebugChoice() {
    const choice = await getDebugChoice();
    this.debugChoice = choice;
    if (!choice) return;
    if (!choice.enabled) setDebug(false);
    this.send({ t: "debug", enabled: choice.enabled, ...choice.callTimeoutMs !== void 0 ? { callTimeoutMs: choice.callTimeoutMs } : {} });
  }
  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
  /** Roda e responde. Com `traced`, a chamada entra na tabela em voo e, ao terminar, no anel (calls.ts). */
  async handleCall(rid, run, traced) {
    if (traced) beginCall(rid, traced.tool, traced.client);
    try {
      const value = await run();
      if (traced) endCall(rid, { ok: true });
      flushTrace();
      this.send({ t: "result", rid, ok: true, value });
    } catch (e) {
      const error = toWireError(e);
      if (traced && isDebug()) this.send({ t: "dump", call: rid, pieces: await collectDump(rid, error) });
      if (traced) endCall(rid, { ok: false, code: error.code });
      flushTrace();
      this.send({ t: "result", rid, ok: false, error });
    }
  }
};

// extension/src/background.ts
var connection = new DaemonConnection();
watchBrowserEvents();
chrome.runtime.onStartup.addListener(() => void connection.ensure());
chrome.runtime.onInstalled.addListener(() => void connection.ensure());
void chrome.alarms.create("bridge-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "bridge-reconnect") void connection.ensure();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && SETTINGS_KEYS.some((k) => k in changes)) void connection.restart();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && ALLOW_EVALUATE_STORAGE_KEY in changes) void applyAlertState();
});
void applyAlertState();
async function overview() {
  const [host, settings, entries] = await Promise.all([loadHostStatus(), loadSettings(), listEntries()]);
  const tabs2 = [];
  const agents = new Map(host.clients.map((c) => [c.id, c]));
  for (const [id, entry] of entries) {
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (!tab) continue;
    const ownerName = entry.owner !== void 0 ? await clientName(entry.owner) : void 0;
    if (entry.owner !== void 0 && !agents.has(entry.owner)) agents.set(entry.owner, { id: entry.owner, ...ownerName ? { name: ownerName } : {} });
    tabs2.push({
      id,
      title: tab.title ?? "",
      url: tab.url ?? "",
      ...entry.owner !== void 0 ? { owner: entry.owner } : {},
      ...ownerName ? { ownerName } : {},
      ...entry.handed ? { handed: true } : {}
    });
  }
  return { connected: connection.isOpen(), paused: host.paused, name: settings.name, tabs: tabs2, agents: [...agents.values()] };
}
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const run = async () => {
    switch (msg.t) {
      case "is-scoped":
        return { scoped: await isScoped(msg.tabId) };
      case "handover":
        await takeControl(msg.tabId, ownerOf2(msg.owner), { handed: true });
        return { ok: true };
      case "release":
        await releaseControl(msg.tabId);
        return { ok: true };
      case "overview":
        return overview();
      case "release-all":
        return { ok: true, ...await releaseAll() };
      case "set-paused":
        if (!connection.setPaused(msg.paused === true)) return { error: POPUP.noDaemon };
        return { ok: true };
      case "set-name": {
        const name = cleanClientName(msg.name) ?? "";
        const settings = await loadSettings();
        if (name && name !== settings.name) await saveSettings({ ...settings, name });
        return { ok: true, name: name || settings.name };
      }
      default:
        return { error: `unknown message ${String(msg.t)}` };
    }
  };
  run().then(reply, (e) => reply({ error: e.message }));
  return true;
});
function ownerOf2(raw2) {
  if (!raw2 || !isClientId(raw2.id)) return void 0;
  const name = cleanClientName(raw2.name);
  return name ? { id: raw2.id, name } : { id: raw2.id };
}
void connection.ensure();
