// <define:__BRAND__>
var define_BRAND_default = { name: "Tether", product: "Tether Bridge", color: "#5b8def" };

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

// src/protocol.ts
var PROTOCOL_VERSION = 1;
var DEFAULT_PORT = 47821;
var WS_PATH = "/ext";
var SEED_FILE = "bridge.json";
function isSeed(v) {
  const s = v;
  return !!s && typeof s === "object" && typeof s.port === "number" && Number.isInteger(s.port) && s.port >= 1 && s.port <= 65535 && typeof s.token === "string" && s.token.length >= 16 && (s.host === void 0 || typeof s.host === "string" && s.host.length <= 64);
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
var SETTINGS_KEYS = ["port", "token", "name"];
async function saveHostBrand(brand, opts = {}) {
  if (opts.onlyIfMissing && await loadHostBrand()) return;
  if (brand) await chrome.storage.local.set({ hostBrand: brand });
  else await chrome.storage.local.remove("hostBrand");
}
async function loadHostBrand() {
  return (await chrome.storage.local.get("hostBrand")).hostBrand ?? null;
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
  const raw = top.getAttribute("aria-label") || labelledText || top.getAttribute("alt") || (tag === "input" ? top.value || top.getAttribute("placeholder") : "") || top.getAttribute("title") || top.textContent || "";
  const name = raw.replace(/\s+/g, " ").trim().slice(0, 80);
  return { isTarget, isFrame, offset, desc: { tag, role, name, ...top.id ? { id: top.id } : {} } };
}
function candidatePoints(b) {
  const at = (fx, fy) => ({ x: b.x + b.width * fx, y: b.y + b.height * fy });
  return [at(0.5, 0.5), at(0.25, 0.25), at(0.75, 0.25), at(0.25, 0.75), at(0.75, 0.75)];
}
function clipToViewport(raw, vp) {
  const x1 = Math.max(raw.x, 0);
  const y1 = Math.max(raw.y, 0);
  const x2 = Math.min(raw.x + raw.width, vp.width);
  const y2 = Math.min(raw.y + raw.height, vp.height);
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
    description: 'Attach a file from the disk of this computer to a file field of the page (an input of type file, or the button that opens the file chooser). Give the absolute path of the file. This sends the file contents to the website, so on EVERY call the operator is asked to confirm (the MCP client shows the file and the destination site); if the operator declines, or the client cannot ask, nothing is sent, unless the file is in a folder the operator pre-authorized (ATRIUM_BROWSER_UPLOAD_DIRS_TRUSTED). Only files inside the allowed upload folders are accepted (by default the Downloads folder of the user; the operator can list others in the ATRIUM_BROWSER_UPLOAD_DIRS environment variable of this MCP server, absolute paths separated by ";" on Windows and ":" elsewhere). A path outside them is refused with an explanation. Returns how many files were attached and their names.',
    params: {
      ref: 'Ref of the file input or of the control that opens the file chooser, from the latest WebSnapshot of this tab (for example "e12").',
      path: 'Absolute path of the file on this computer, for example "C:/Users/me/Downloads/report.pdf" or "/home/me/Downloads/report.pdf".'
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
  defLocal("set_gpu", { gpu: { ...str, enum: ["on", "off"] }, confirm: bool }, ["gpu"], false)
]);
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
  const row = { code, keyCode, key, shiftKey, text: key };
  rows.push(row);
  byChar.set(key, { row, shifted: false });
  if (shiftKey !== key) byChar.set(shiftKey, { row, shifted: true });
}
function named(name, code, keyCode, extra = {}) {
  const row = { code, keyCode, key: name, ...extra };
  rows.push(row);
  byName.set(name.toLowerCase(), row);
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
function fromRow(row, shift, impliedShift) {
  const key = shift && row.shiftKey ? row.shiftKey : row.key;
  const text = row.text === void 0 ? void 0 : shift && row.shiftKey ? row.shiftKey : row.text;
  return {
    key,
    code: row.code,
    keyCode: row.keyCode,
    ...text !== void 0 ? { text } : {},
    ...row.location ? { location: row.location } : {},
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
  const row = byName.get(alias);
  return row ? fromRow(row, shiftHeld, false) : null;
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
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
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
  if (a.ref !== void 0) {
    const backendNodeId = backendNodeOf(s, a.ref);
    const { clipped } = await nodeBox(s, backendNodeId, a.ref);
    const objectId = (await s.transport.send("DOM.resolveNode", { backendNodeId })).object.objectId;
    try {
      let occluder;
      for (const p of candidatePoints(clipped)) {
        const point = { x: Math.round(p.x), y: Math.round(p.y) };
        const hit = await hitAt(s, point, objectId);
        if (hit?.isTarget) return { ...point, ref: a.ref, box: clipped, hit: hit.desc };
        if (occluder === void 0) occluder = hit?.desc ?? null;
      }
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
    return { ...point, hit: hit?.desc ?? null };
  }
  throw new BrowserError("INVALID_ARGUMENT", `${what}: give a ref, or both x and y`);
}
async function travel(s, to) {
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

// extension/src/keyboard.ts
var rng2 = mulberry32(Math.random() * 2 ** 32 >>> 0);
var FOCUS = `(()=>{let el=document.activeElement;while(el&&el.shadowRoot&&el.shadowRoot.activeElement)el=el.shadowRoot.activeElement;if(!el||el===document.body||el===document.documentElement)return null;const tag=el.tagName.toLowerCase();const noText=['button','submit','checkbox','radio','file','image','reset','range','color'];const editable=tag==='textarea'||(tag==='input'&&!noText.includes(el.type))||el.isContentEditable;return {tag,editable}})()`;
async function send(s, e) {
  await s.transport.send("Input.dispatchKeyEvent", { ...e });
}
async function type(s, a) {
  if (a.ref !== void 0) await click(s, { ref: a.ref });
  const focus = await pageEval(s.transport, FOCUS);
  if (!focus) throw new BrowserError("NO_FOCUS", "nothing has focus: pass a ref to type into, or click a field first");
  if (!focus.editable) throw new BrowserError("NOT_EDITABLE", `the focused element (<${focus.tag}>) does not accept text`);
  const mode = a.mode ?? "keys";
  if (mode === "paste") {
    await insertText(s.transport, a.text);
  } else {
    for (const ch of a.text) {
      const events = charEvents(ch);
      if (events) for (const e of events) await send(s, e);
      else await insertText(s.transport, ch);
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

// extension/src/brand.ts
var DEFAULT_BRAND = { name: "Atrium", product: "Atrium Bridge" };
var BUILD_BRAND = typeof define_BRAND_default === "undefined" ? DEFAULT_BRAND : { ...DEFAULT_BRAND, ...define_BRAND_default };
var brandName = () => BUILD_BRAND.name;
var productName = () => BUILD_BRAND.product;
var groupTitle = () => BUILD_BRAND.name;

// extension/src/scope.ts
var GROUP_TITLE = groupTitle();
var SCOPE_KEY = "scope";
var CURRENT_KEY = "currentTab";
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
async function listScope() {
  return Object.keys(await load()).map(Number);
}
async function addScope(tabId) {
  const scope = await load();
  scope[String(tabId)] ??= { grouped: false };
  await save();
}
async function removeScope(tabId) {
  const scope = await load();
  if (!(String(tabId) in scope)) return;
  delete scope[String(tabId)];
  await save();
  if (await getCurrent() === tabId) await chrome.storage.session.remove(CURRENT_KEY);
}
async function getCurrent() {
  return (await chrome.storage.session.get(CURRENT_KEY))[CURRENT_KEY] ?? null;
}
async function setCurrent(tabId) {
  await chrome.storage.session.set({ [CURRENT_KEY]: tabId });
}
async function assertScoped(tabId) {
  if (!await isScoped(tabId)) {
    throw new BridgeError(
      "TAB_OUT_OF_SCOPE",
      `tab ${tabId} is not under ${brandName()} control: the agent only controls tabs it opened (tabs new) and tabs the user handed over with "Hand this tab to ${brandName()}"`
    );
  }
}
async function groupColor() {
  return await getAllowEvaluate() ? "yellow" : "grey";
}
var grouping = Promise.resolve();
function groupTab(tabId) {
  const run = async () => {
    const tab = await chrome.tabs.get(tabId);
    const existing = (await chrome.tabGroups.query({ title: GROUP_TITLE, windowId: tab.windowId }))[0];
    const groupId = await chrome.tabs.group(
      existing ? { tabIds: tabId, groupId: existing.id } : { tabIds: tabId, createProperties: { windowId: tab.windowId } }
    );
    if (!existing) await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: await groupColor() });
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

// extension/src/session.ts
var CONSOLE_CAP = 1e3;
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
  seq = 0;
  waiters = [];
  constructor(tabId) {
    this.tabId = tabId;
    this.transport = {
      send: async (method, params) => {
        try {
          return await chrome.debugger.sendCommand({ tabId }, method, params);
        } catch (e) {
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
    let timer;
    const promise = new Promise((resolve) => {
      waiter = { method, resolve: () => resolve(true) };
      this.waiters.push(waiter);
      timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(false);
      }, timeoutMs);
    });
    const cancel = () => {
      clearTimeout(timer);
      this.waiters = this.waiters.filter((w) => w !== waiter);
    };
    return { promise: promise.finally(() => clearTimeout(timer)), cancel };
  }
  /** Despacho dos eventos do chrome.debugger para esta sessão. */
  onEvent(method, params) {
    for (const w of this.waiters.filter((x) => x.method === method)) {
      this.waiters = this.waiters.filter((x) => x !== w);
      w.resolve();
    }
    const p = params ?? {};
    if (method === "Page.frameNavigated" && !p.frame?.parentId) {
      this.refs.clear();
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
async function attachedSession(tabId) {
  await assertScoped(tabId);
  const s = sessionFor(tabId);
  await s.attach();
  return s;
}
async function takeControl(tabId) {
  await addScope(tabId);
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
async function releaseControl(tabId) {
  await removeScope(tabId);
  const s = sessions.get(tabId);
  sessions.delete(tabId);
  await s?.detach();
}
async function resolveTabId(requested) {
  if (requested !== void 0 && requested !== null && requested !== "") {
    const id = Number(requested);
    if (!Number.isInteger(id)) throw new BrowserError("INVALID_ARGUMENT", `tab must be a tab id from the tabs tool, got "${String(requested)}"`);
    await assertScoped(id);
    return id;
  }
  const scoped = await listScope();
  const current = await getCurrent();
  if (current !== null && scoped.includes(current)) return current;
  for (const id of scoped) {
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (tab?.active) {
      await setCurrent(id);
      return id;
    }
  }
  if (scoped[0] !== void 0) {
    await setCurrent(scoped[0]);
    return scoped[0];
  }
  throw new BrowserError(
    "NO_ACTIVE_TAB",
    `no tab is under ${brandName()} control: open one with tabs {action:"new"} or ask the user to hand a tab over with "Hand this tab to ${brandName()}"`
  );
}
function watchBrowserEvents() {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId !== void 0) sessions.get(source.tabId)?.onEvent(method, params);
  });
  chrome.debugger.onDetach.addListener((source, reason) => {
    const tabId = source.tabId;
    if (tabId === void 0) return;
    const s = sessions.get(tabId);
    if (s) s.attached = false;
    if (reason === "canceled_by_user") void releaseControl(tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    sessions.delete(tabId);
    void removeScope(tabId);
  });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) return;
    void isGrouped(tabId).then((grouped) => grouped ? releaseControl(tabId) : void 0);
  });
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
async function navigate(s, a) {
  assertNavigableUrl(a.url);
  const loaded = s.waitFor("Page.loadEventFired", NAVIGATION_TIMEOUT_MS);
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
      throw new BridgeError("NAVIGATION_TIMEOUT", `${a.url} did not finish loading within ${NAVIGATION_TIMEOUT_MS / 1e3} s`);
    }
  } else {
    loaded.cancel();
  }
  return where(s);
}
async function listTabs() {
  const current = await getCurrent();
  const rows2 = [];
  for (const id of await listScope()) {
    const t = await chrome.tabs.get(id).catch(() => null);
    if (t) rows2.push({ tab: String(id), url: t.url ?? t.pendingUrl ?? "", title: t.title ?? "", active: t.active, current: id === current });
  }
  return rows2;
}
async function tabs(a) {
  switch (a.action) {
    case "list":
      return { tabs: await listTabs() };
    case "new": {
      if (a.url !== void 0) assertNavigableUrl(a.url);
      const created = await chrome.tabs.create({ url: "about:blank", active: true });
      const id = created.id;
      let s;
      try {
        s = await takeControl(id);
      } catch (e) {
        await chrome.tabs.remove(id).catch(() => void 0);
        throw e;
      }
      await setCurrent(id);
      if (a.url && a.url !== "about:blank") await navigate(s, { url: a.url });
      return { tab: String(id), ...await where(s) };
    }
    case "close": {
      if (a.tab === void 0) throw new BrowserError("INVALID_ARGUMENT", 'tabs close: "tab" is required');
      const id = await resolveTabId(a.tab);
      await releaseControl(id);
      await chrome.tabs.remove(id);
      return { closed: String(id) };
    }
    case "activate": {
      if (a.tab === void 0) throw new BrowserError("INVALID_ARGUMENT", 'tabs activate: "tab" is required');
      const id = await resolveTabId(a.tab);
      await chrome.tabs.update(id, { active: true });
      await setCurrent(id);
      await attachedSession(id);
      return { activated: String(id) };
    }
  }
}

// extension/src/alert.ts
var ALERT_COLOR = "#f5a524";
var ALERT_TEXT_COLOR = "#1a1a1a";
async function applyAlertState() {
  const allow = await getAllowEvaluate();
  await chrome.action.setBadgeText({ text: allow ? "JS" : "" });
  if (allow) {
    await chrome.action.setBadgeBackgroundColor({ color: ALERT_COLOR });
    await chrome.action.setBadgeTextColor({ color: ALERT_TEXT_COLOR });
  }
  const color = await groupColor();
  for (const g of await chrome.tabGroups.query({ title: GROUP_TITLE })) await chrome.tabGroups.update(g.id, { color });
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
      if (name && !parentName.includes(name)) lines.push({ depth, text: `text ${JSON.stringify(clip(name))}` });
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
    lines.push({ depth, text, ...ref ? { backendNodeId: node.backendDOMNodeId } : {} });
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
async function snapshot(s, a) {
  const { nodes } = await s.transport.send("Accessibility.getFullAXTree");
  const { lines, refs } = buildLines(nodes, a.depth);
  s.refs = refs;
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
  const where2 = await pageEval(s.transport, "({url:location.href,title:document.title})");
  return { ...where2, refs: refs.size, snapshot: tree };
}
async function screenshot(s, a) {
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
    EVALUATE_TIMEOUT_MS,
    () => new BrowserError("EVALUATE_TIMEOUT", `expression did not finish within ${EVALUATE_TIMEOUT_MS} ms`)
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

// extension/src/tools.ts
var locks = /* @__PURE__ */ new Map();
function inTabQueue(tabId, fn) {
  const run = (locks.get(tabId) ?? Promise.resolve()).then(fn, fn);
  locks.set(tabId, run.catch(() => void 0));
  return run;
}
async function onTab(a, fn) {
  const tabId = await resolveTabId(a.tab);
  return inTabQueue(tabId, async () => fn(await attachedSession(tabId)));
}
async function runTool(tool, a) {
  switch (tool) {
    case "tabs":
      return tabs({ action: a.action, url: a.url, tab: a.tab });
    case "navigate":
      return onTab(a, (s) => navigate(s, { url: a.url }));
    case "snapshot":
      return onTab(a, (s) => snapshot(s, { depth: a.depth }));
    case "screenshot":
      return onTab(a, (s) => screenshot(s, { fullPage: a.fullPage, ref: a.ref, format: a.format, quality: a.quality }));
    case "click":
      return onTab(a, (s) => click(s, { ref: a.ref, x: a.x, y: a.y, button: a.button, count: a.count }));
    case "hover":
      return onTab(a, (s) => hover(s, { ref: a.ref, x: a.x, y: a.y }));
    case "drag":
      return onTab(a, (s) => drag(s, { ref: a.ref, x: a.x, y: a.y, toRef: a.toRef, toX: a.toX, toY: a.toY }));
    case "scroll":
      return onTab(a, (s) => scroll(s, { ref: a.ref, x: a.x, y: a.y, byX: a.byX, byY: a.byY, to: a.to }));
    case "type":
      return onTab(a, (s) => type(s, { text: a.text, ref: a.ref, mode: a.mode }));
    case "pressKey":
      return onTab(a, (s) => pressKey(s, { key: a.key, hold: a.hold }));
    case "readConsole":
      return onTab(a, async (s) => readConsole(s, { level: a.level, afterSeq: a.afterSeq, limit: a.limit, clear: a.clear }));
    case "evaluate":
      return onTab(a, async (s) => {
        if (!await getAllowEvaluate()) throw new BridgeError("EVALUATE_DISABLED", EVALUATE.disabledError);
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
        this.pingTimer = setInterval(() => this.send({ t: "ping" }), PING_MS);
      } else if (msg.t === "denied") {
        this.denied = true;
        void setStatus({ state: "denied", detail: msg.reason });
        void applySeed();
      } else if (msg.t === "call") {
        void this.handleCall(msg.rid, msg.tool, msg.args);
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
  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
  async handleCall(rid, tool, args) {
    try {
      this.send({ t: "result", rid, ok: true, value: await runTool(tool, args) });
    } catch (e) {
      this.send({ t: "result", rid, ok: false, error: toWireError(e) });
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
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const tabId = msg.tabId;
  if (tabId === void 0) return false;
  const run = async () => {
    if (msg.t === "handover") await takeControl(tabId);
    else if (msg.t === "release") await releaseControl(tabId);
    else if (msg.t === "is-scoped") return { scoped: await isScoped(tabId) };
    return { ok: true };
  };
  run().then(reply, (e) => reply({ error: e.message }));
  return true;
});
void connection.ensure();
