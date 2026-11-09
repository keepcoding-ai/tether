import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/protocol.ts
function isClientId(v) {
  return typeof v === "string" && CLIENT_ID_PATTERN.test(v);
}
function cleanClientName(raw) {
  if (typeof raw !== "string") return void 0;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, CLIENT_NAME_MAX).trim();
  return cleaned || void 0;
}
function sanitizeTabs(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const raw of v.slice(0, STATUS_TABS_MAX)) {
    const t = raw;
    if (!t || typeof t !== "object" || typeof t.id !== "number" || !Number.isInteger(t.id)) continue;
    out.push({
      id: t.id,
      url: typeof t.url === "string" ? t.url.slice(0, STATUS_URL_MAX) : "",
      title: typeof t.title === "string" ? t.title.slice(0, STATUS_TITLE_MAX) : "",
      ...isClientId(t.owner) ? { owner: t.owner } : {}
    });
  }
  return out;
}
var PROTOCOL_VERSION, DEFAULT_PORT, WS_PATH, CLOSE_DENIED, CLOSE_REPLACED, CLOSE_PROTOCOL, CLIENT_ID_HEADER, CLIENT_NAME_HEADER, CLIENT_ID_PATTERN, CLIENT_NAME_MAX, STATUS_TABS_MAX, STATUS_URL_MAX, STATUS_TITLE_MAX, SEED_FILE, EXTENSION_ID_PATTERN;
var init_protocol = __esm({
  "src/protocol.ts"() {
    "use strict";
    PROTOCOL_VERSION = 1;
    DEFAULT_PORT = 47821;
    WS_PATH = "/ext";
    CLOSE_DENIED = 4401;
    CLOSE_REPLACED = 4409;
    CLOSE_PROTOCOL = 4400;
    CLIENT_ID_HEADER = "x-bridge-client";
    CLIENT_NAME_HEADER = "x-bridge-client-name";
    CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;
    CLIENT_NAME_MAX = 80;
    STATUS_TABS_MAX = 500;
    STATUS_URL_MAX = 2048;
    STATUS_TITLE_MAX = 300;
    SEED_FILE = "bridge.json";
    EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
  }
});

// daemon/src/package-info.ts
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
function isPackagedBrand(v) {
  if (!isRecord(v) || typeof v.slug !== "string" || typeof v.name !== "string") return false;
  if (v.host !== void 0 && !(isRecord(v.host) && typeof v.host.name === "string")) return false;
  if (v.mcp !== void 0 && !(isRecord(v.mcp) && (v.mcp.serverName === void 0 || typeof v.mcp.serverName === "string"))) return false;
  if (v.capabilities !== void 0 && !isCapabilities(v.capabilities)) return false;
  return true;
}
function readPackagedBrand(buildInfo) {
  if (!buildInfo || !existsSync(buildInfo)) return void 0;
  try {
    const info2 = JSON.parse(readFileSync(buildInfo, "utf8"));
    return isRecord(info2) && isPackagedBrand(info2.brand) ? info2.brand : void 0;
  } catch {
    return void 0;
  }
}
function packagedServerName(buildInfo) {
  const name = readPackagedBrand(buildInfo)?.mcp?.serverName?.trim();
  return name && SERVER_NAME_PATTERN.test(name) ? name : void 0;
}
var BUILD_INFO_FILE, isRecord, isCapabilities, buildInfoNextTo, buildInfoOfScript, SERVER_NAME_PATTERN;
var init_package_info = __esm({
  "daemon/src/package-info.ts"() {
    "use strict";
    BUILD_INFO_FILE = "build-info.json";
    isRecord = (v) => !!v && typeof v === "object" && !Array.isArray(v);
    isCapabilities = (v) => isRecord(v) && Object.entries(v).every(([k, val]) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(k) && (typeof val === "boolean" || typeof val === "string" && val.length > 0 && val.length <= 32));
    buildInfoNextTo = (extensionDir) => join(dirname(resolve(extensionDir)), BUILD_INFO_FILE);
    buildInfoOfScript = (script = process.argv[1]) => script ? join(dirname(resolve(script)), BUILD_INFO_FILE) : null;
    SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
  }
});

// daemon/src/secrets.ts
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
function findBySecret(items, presented) {
  const probe = digest(presented);
  let found = null;
  for (const item of items) {
    const stored = Buffer.from(item.hash.slice(HASH_PREFIX.length), "base64url");
    if (stored.length === probe.length && timingSafeEqual(stored, probe) && found === null) found = item;
  }
  return found;
}
var newSecret, HASH_PREFIX, digest, hashSecret, isSecretHash, sameSecret;
var init_secrets = __esm({
  "daemon/src/secrets.ts"() {
    "use strict";
    newSecret = () => randomBytes(32).toString("base64url");
    HASH_PREFIX = "sha256:";
    digest = (s) => createHash("sha256").update(s, "utf8").digest();
    hashSecret = (value) => HASH_PREFIX + digest(value).toString("base64url");
    isSecretHash = (v) => typeof v === "string" && /^sha256:[A-Za-z0-9_-]{43}$/.test(v);
    sameSecret = (a, b) => timingSafeEqual(digest(a), digest(b));
  }
});

// daemon/src/config.ts
import { randomBytes as randomBytes2 } from "node:crypto";
import { chmodSync, existsSync as existsSync2, mkdirSync, readFileSync as readFileSync2, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";
function bridgeHome(env = process.env) {
  return env.ATRIUM_BRIDGE_HOME || join2(homedir(), ".atrium-bridge");
}
function isStored(v) {
  const c = v;
  if (!c || typeof c !== "object") return false;
  const keysOk = c.apiKeys === void 0 || Array.isArray(c.apiKeys) && c.apiKeys.every(isKey);
  const names = (c.apiKeys ?? []).map((k) => k.name);
  return typeof c.port === "number" && typeof c.pairingToken === "string" && c.pairingToken.length >= 16 && keysOk && new Set(names).size === names.length && (c.apiToken === void 0 || typeof c.apiToken === "string" && c.apiToken.length >= 16) && (c.apiKeys !== void 0 || c.apiToken !== void 0) && (c.brand === void 0 || isBrand(c.brand)) && (c.capabilities === void 0 || isCapabilities(c.capabilities)) && (c.extensionIds === void 0 || isExtensionIdList(c.extensionIds)) && (c.embedded === void 0 || typeof c.embedded === "boolean") && (c.supervisorEnvFile === void 0 || typeof c.supervisorEnvFile === "string" && c.supervisorEnvFile.length > 0) && (c.downloadsDir === void 0 || typeof c.downloadsDir === "string" && c.downloadsDir.length > 0) && (c.extensionVersion === void 0 || isExtensionVersion(c.extensionVersion));
}
function readStored(home3) {
  const p = configPath(home3);
  if (!existsSync2(p)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync2(p, "utf8"));
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    throw new Error(`config file ${p} is not valid JSON; fix or delete it to generate new tokens`);
  }
  if (!isStored(parsed)) throw new Error(`config file ${p} is invalid; fix or delete it to generate new tokens`);
  return parsed;
}
function legacyName(keys) {
  let name = LEGACY_KEY_NAME;
  for (let i = 2; keys.some((k) => k.name === name); i++) name = `${LEGACY_KEY_NAME}-${i}`;
  return name;
}
function normalize(stored, legacyCreatedAt) {
  const { apiToken, apiKeys = [], port, pairingToken, brand, capabilities, extensionIds, embedded, supervisorEnvFile, downloadsDir, extensionVersion } = stored;
  const keys = apiKeys.map((k) => ({ ...k }));
  if (apiToken !== void 0) {
    const hash = hashSecret(apiToken);
    if (!keys.some((k) => k.hash === hash)) keys.push({ name: legacyName(keys), hash, createdAt: legacyCreatedAt });
  }
  return {
    port,
    pairingToken,
    apiKeys: keys,
    ...brand !== void 0 ? { brand: { ...brand } } : {},
    ...capabilities !== void 0 ? { capabilities: { ...capabilities } } : {},
    ...extensionIds !== void 0 ? { extensionIds: [...extensionIds] } : {},
    ...embedded !== void 0 ? { embedded } : {},
    ...supervisorEnvFile !== void 0 ? { supervisorEnvFile } : {},
    ...downloadsDir !== void 0 ? { downloadsDir } : {},
    ...extensionVersion !== void 0 ? { extensionVersion } : {}
  };
}
function readConfig(home3) {
  const stored = readStored(home3);
  return stored ? normalize(stored, mtimeIso(configPath(home3))) : null;
}
function readLocalKey(home3) {
  try {
    const value = readFileSync2(localKeyPath(home3), "utf8").trim();
    if (value) return value;
  } catch {
  }
  try {
    return readStored(home3)?.apiToken ?? null;
  } catch {
    return null;
  }
}
function writeFileAtomic(p, text) {
  const staged = `${p}.${process.pid}.${randomBytes2(4).toString("hex")}.tmp`;
  writeFileSync(staged, text, { mode: 384, flag: "wx" });
  try {
    try {
      chmodSync(staged, 384);
    } catch {
    }
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(staged, p);
        return;
      } catch (e) {
        const code = e.code;
        if (attempt >= 20 || code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw e;
        sleepSync(25);
      }
    }
  } finally {
    rmSync(staged, { force: true });
  }
}
function withConfigLock(home3, fn) {
  mkdirSync(home3, { recursive: true });
  const lock = lockPath(home3);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (; ; ) {
    try {
      writeFileSync(lock, `${process.pid}
`, { flag: "wx" });
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true });
      } catch {
      }
      if (Date.now() > deadline) throw new Error(`config lock ${lock} is held by another process; try again`);
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}
function writeStored(home3, config2, extra = {}) {
  const { apiToken: _legacy, ...unknownFields } = extra;
  void _legacy;
  const out = { ...unknownFields, ...config2 };
  if (config2.brand === void 0) delete out.brand;
  if (config2.capabilities === void 0) delete out.capabilities;
  if (config2.extensionIds === void 0) delete out.extensionIds;
  if (config2.extensionVersion === void 0) delete out.extensionVersion;
  writeFileAtomic(configPath(home3), JSON.stringify(out, null, 2));
}
function ensureLocked(home3, port) {
  const stored = readStored(home3);
  if (!stored) {
    const value = newSecret();
    writeFileAtomic(localKeyPath(home3), `${value}
`);
    const config3 = {
      port: port ?? DEFAULT_PORT,
      pairingToken: newSecret(),
      apiKeys: [{ name: DEFAULT_KEY_NAME, hash: hashSecret(value), createdAt: (/* @__PURE__ */ new Date()).toISOString() }]
    };
    writeStored(home3, config3);
    return { config: config3, stored: config3 };
  }
  const config2 = normalize(stored, mtimeIso(configPath(home3)));
  if (stored.apiToken !== void 0) {
    writeFileAtomic(localKeyPath(home3), `${stored.apiToken}
`);
    writeStored(home3, config2, stored);
  }
  return { config: config2, stored };
}
function ensureConfig(home3, port) {
  const stored = readStored(home3);
  if (stored && stored.apiToken === void 0) return withPort(normalize(stored, ""), port);
  return withPort(withConfigLock(home3, () => ensureLocked(home3, port).config), port);
}
function updateConfig(home3, mutate) {
  return withConfigLock(home3, () => {
    const { config: config2, stored } = ensureLocked(home3, void 0);
    const result = mutate(config2);
    writeStored(home3, config2, stored);
    return result;
  });
}
function writeDaemonPid(home3, pid) {
  mkdirSync(home3, { recursive: true });
  writeFileSync(daemonPidPath(home3), `${pid}
`);
}
function readDaemonPid(home3) {
  try {
    const n = Number(readFileSync2(daemonPidPath(home3), "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
function daemonPidWrittenAt(home3) {
  try {
    return statSync(daemonPidPath(home3)).mtimeMs;
  } catch {
    return null;
  }
}
function removeDaemonPid(home3, pid) {
  try {
    if (readDaemonPid(home3) === pid) rmSync(daemonPidPath(home3), { force: true });
  } catch {
  }
}
var KEY_SCOPES, UPLOAD_TOOLS, UPLOAD_KEY_NAME, DEFAULT_KEY_NAME, LEGACY_KEY_NAME, KEY_NAME_PATTERN, supervisorHome, daemonPidPath, daemonLogPath, mcpLogPath, localKeyPath, uploadKeyPath, configPath, lockPath, isKey, isBrand, isExtensionVersion, isExtensionIdList, mtimeIso, sleepSync, LOCK_STALE_MS, LOCK_WAIT_MS, withPort;
var init_config = __esm({
  "daemon/src/config.ts"() {
    "use strict";
    init_protocol();
    init_package_info();
    init_secrets();
    KEY_SCOPES = ["use", "admin", "upload"];
    UPLOAD_TOOLS = /* @__PURE__ */ new Set(["upload", "uploadTarget"]);
    UPLOAD_KEY_NAME = "mcp-upload";
    DEFAULT_KEY_NAME = "default";
    LEGACY_KEY_NAME = "legacy";
    KEY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
    supervisorHome = (home3) => join2(home3, "supervisor");
    daemonPidPath = (home3) => join2(home3, "daemon.pid");
    daemonLogPath = (home3) => join2(home3, "daemon.log");
    mcpLogPath = (home3) => join2(home3, "mcp.log");
    localKeyPath = (home3) => join2(home3, "api.key");
    uploadKeyPath = (home3) => join2(home3, "upload.key");
    configPath = (home3) => join2(home3, "config.json");
    lockPath = (home3) => join2(home3, "config.lock");
    isKey = (v) => {
      const k = v;
      return !!k && typeof k.name === "string" && KEY_NAME_PATTERN.test(k.name) && isSecretHash(k.hash) && typeof k.createdAt === "string" && (k.scope === void 0 || KEY_SCOPES.includes(k.scope));
    };
    isBrand = (v) => {
      const b = v;
      return !!b && typeof b.name === "string" && b.name.trim().length > 0 && b.name.length <= 64 && (b.color === void 0 || typeof b.color === "string" && /^#[0-9a-fA-F]{6}$/.test(b.color)) && (b.hostId === void 0 || typeof b.hostId === "string" && b.hostId.length > 0 && b.hostId.length <= 100);
    };
    isExtensionVersion = (v) => typeof v === "string" && /^\d{1,9}(\.\d{1,9}){0,3}$/.test(v);
    isExtensionIdList = (v) => Array.isArray(v) && v.every((id) => typeof id === "string" && EXTENSION_ID_PATTERN.test(id));
    mtimeIso = (p) => {
      try {
        return statSync(p).mtime.toISOString();
      } catch {
        return (/* @__PURE__ */ new Date()).toISOString();
      }
    };
    sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    LOCK_STALE_MS = 1e4;
    LOCK_WAIT_MS = 1e4;
    withPort = (config2, port) => port !== void 0 && port !== config2.port ? { ...config2, port } : config2;
  }
});

// daemon/src/keys.ts
import { readFileSync as readFileSync3, rmSync as rmSync2 } from "node:fs";
function addKey(home3, name, opts = {}) {
  if (!KEY_NAME_PATTERN.test(name)) {
    throw keyError("KEY_INVALID_NAME", `invalid key name "${name}": use 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit`);
  }
  if (opts.scope !== void 0 && !KEY_SCOPES.includes(opts.scope)) {
    throw keyError("KEY_INVALID_SCOPE", `invalid scope "${String(opts.scope)}": use ${KEY_SCOPES.join(" or ")}`);
  }
  const value = newSecret();
  const key = {
    name,
    hash: hashSecret(value),
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    ...opts.scope ? { scope: opts.scope } : {}
  };
  updateConfig(home3, (config2) => {
    const i = config2.apiKeys.findIndex((k) => k.name === name);
    if (i >= 0 && !opts.replace) throw keyError("KEY_EXISTS", `a key named "${name}" already exists (revoke it first, or replace it)`);
    if (i >= 0) config2.apiKeys[i] = key;
    else config2.apiKeys.push(key);
  });
  return { ...info(key), value };
}
function listKeys(home3) {
  return ensureConfig(home3).apiKeys.map(info);
}
function revokeKey(home3, name) {
  return updateConfig(home3, (config2) => {
    const revoked = config2.apiKeys.find((k) => k.name === name);
    if (!revoked) return false;
    config2.apiKeys = config2.apiKeys.filter((k) => k !== revoked);
    const local = readLocalKey(home3);
    if (local !== null && hashSecret(local) === revoked.hash) rmSync2(localKeyPath(home3), { force: true });
    const upload = readUploadKey(home3);
    if (upload !== null && hashSecret(upload) === revoked.hash) rmSync2(uploadKeyPath(home3), { force: true });
    return true;
  });
}
function ensureUploadKey(home3) {
  const ready = (() => {
    try {
      return validUploadKey(home3, ensureConfig(home3).apiKeys);
    } catch {
      return null;
    }
  })();
  if (ready !== null) return ready;
  return updateConfig(home3, (config2) => {
    const again = validUploadKey(home3, config2.apiKeys);
    if (again !== null) return again;
    const value = newSecret();
    const key = { name: UPLOAD_KEY_NAME, hash: hashSecret(value), createdAt: (/* @__PURE__ */ new Date()).toISOString(), scope: "upload" };
    writeFileAtomic(uploadKeyPath(home3), `${value}
`);
    const i = config2.apiKeys.findIndex((k) => k.name === UPLOAD_KEY_NAME);
    if (i >= 0) config2.apiKeys[i] = key;
    else config2.apiKeys.push(key);
    return value;
  });
}
function setBrand(home3, brand) {
  if (brand !== null && !isBrand(brand)) {
    throw keyError("BRAND_INVALID", 'invalid brand: { name: 1-64 chars, color?: "#rrggbb", hostId?: 1-100 chars }');
  }
  updateConfig(home3, (config2) => {
    if (brand === null) delete config2.brand;
    else
      config2.brand = {
        name: brand.name,
        ...brand.color !== void 0 ? { color: brand.color } : {},
        ...brand.hostId !== void 0 ? { hostId: brand.hostId } : {}
      };
  });
}
function setCapabilities(home3, capabilities) {
  if (capabilities !== null && !isCapabilities(capabilities)) throw capabilitiesError();
  updateConfig(home3, (config2) => {
    if (capabilities === null) delete config2.capabilities;
    else config2.capabilities = { ...capabilities };
  });
}
function setExtensionVersion(home3, version3) {
  if (version3 !== null && !isExtensionVersion(version3)) {
    throw Object.assign(new Error("extensionVersion must be 1 to 4 integers separated by dots (a Chrome manifest version)"), { code: "INVALID_ARGUMENT" });
  }
  updateConfig(home3, (config2) => {
    if (version3 === null) delete config2.extensionVersion;
    else config2.extensionVersion = version3;
  });
}
function seedCapabilities(home3, defaults) {
  if (!isCapabilities(defaults)) throw capabilitiesError();
  return updateConfig(home3, (config2) => {
    if (config2.capabilities !== void 0) return [];
    config2.capabilities = { ...defaults };
    return Object.keys(defaults);
  });
}
function setExtensionIds(home3, ids) {
  if (!isExtensionIdList(ids)) throw keyError("EXTENSION_ID_INVALID", "invalid extension id: expected 32 letters a-p");
  updateConfig(home3, (config2) => {
    if (ids.length === 0) delete config2.extensionIds;
    else config2.extensionIds = [...new Set(ids)];
  });
}
function pinExtensionId(home3, id) {
  if (!EXTENSION_ID_PATTERN.test(id)) throw keyError("EXTENSION_ID_INVALID", `invalid extension id "${id}": expected 32 letters a-p`);
  return updateConfig(home3, (config2) => {
    const ids = new Set(config2.extensionIds ?? []);
    ids.add(id);
    config2.extensionIds = [...ids];
    return config2.extensionIds;
  });
}
function rotatePairingToken(home3) {
  const value = newSecret();
  updateConfig(home3, (config2) => {
    config2.pairingToken = value;
  });
  return value;
}
var keyError, info, readUploadKey, validUploadKey, capabilitiesError;
var init_keys = __esm({
  "daemon/src/keys.ts"() {
    "use strict";
    init_config();
    init_secrets();
    init_protocol();
    keyError = (code, message) => Object.assign(new Error(message), { code });
    info = (k) => ({ name: k.name, createdAt: k.createdAt, ...k.scope ? { scope: k.scope } : {} });
    readUploadKey = (home3) => {
      try {
        return readFileSync3(uploadKeyPath(home3), "utf8").trim() || null;
      } catch {
        return null;
      }
    };
    validUploadKey = (home3, keys) => {
      const value = readUploadKey(home3);
      if (value === null) return null;
      const hash = hashSecret(value);
      return keys.some((k) => k.hash === hash && k.scope === "upload") ? value : null;
    };
    capabilitiesError = () => keyError("CAPABILITIES_INVALID", 'invalid capabilities: an object of booleans or short modes, e.g. { evaluate: "own-tabs", download: true }');
  }
});

// scripts/extension-id.ts
import { createHash as createHash2 } from "node:crypto";
function extensionIdFromKey(keyBase64) {
  const hash = createHash2("sha256").update(Buffer.from(keyBase64, "base64")).digest();
  let id = "";
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (hash[i] >> 4));
    id += String.fromCharCode(97 + (hash[i] & 15));
  }
  return id;
}
var init_extension_id = __esm({
  "scripts/extension-id.ts"() {
    "use strict";
  }
});

// daemon/src/install.ts
import { cpSync, existsSync as existsSync3, mkdirSync as mkdirSync2, readFileSync as readFileSync4, readdirSync, rmSync as rmSync3, statSync as statSync2 } from "node:fs";
import { dirname as dirname2, join as join3, resolve as resolve2 } from "node:path";
import { fileURLToPath } from "node:url";
function brandFromPackage(packaged) {
  if (!packaged.host?.name) return void 0;
  return {
    name: packaged.host.name,
    ...packaged.color !== void 0 ? { color: packaged.color } : {},
    ...packaged.host.id !== void 0 ? { hostId: packaged.host.id } : {}
  };
}
function seedFromPackage(home3, packaged, hadBrand) {
  const seeded = { capabilities: [], brand: false };
  if (!packaged) return seeded;
  if (packaged.capabilities) seeded.capabilities = seedCapabilities(home3, packaged.capabilities);
  const brand = brandFromPackage(packaged);
  if (brand && !hadBrand) {
    setBrand(home3, brand);
    seeded.brand = true;
  }
  return seeded;
}
function extensionIdOf(dir) {
  const manifestPath = join3(dir, "manifest.json");
  if (!existsSync3(manifestPath)) throw installError("EXTENSION_NOT_FOUND", `no manifest.json in ${dir}`);
  const manifest = JSON.parse(readFileSync4(manifestPath, "utf8"));
  if (typeof manifest.key !== "string" || !manifest.key) {
    throw installError("EXTENSION_NO_KEY", `${manifestPath} has no "key": the extension id would change at every load`);
  }
  const id = extensionIdFromKey(manifest.key);
  if (!EXTENSION_ID_PATTERN.test(id)) throw installError("EXTENSION_NO_KEY", `${manifestPath}: invalid key`);
  return id;
}
function writeSeed(dir, seed) {
  const p = join3(dir, SEED_FILE);
  const out = { port: seed.port, token: seed.token, ...seed.host ? { host: seed.host } : {} };
  writeFileAtomic(p, `${JSON.stringify(out, null, 2)}
`);
  return p;
}
function defaultExtensionSource() {
  const here = dirname2(fileURLToPath(import.meta.url));
  const script = process.argv[1] ? dirname2(resolve2(process.argv[1])) : null;
  const candidates = [
    ...script ? [join3(script, "extension")] : [],
    join3(here, "extension"),
    join3(here, "..", "..", "dist", "extension")
  ];
  return candidates.find((c) => existsSync3(join3(c, "manifest.json"))) ?? null;
}
function countFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? countFiles(join3(dir, e.name)) : 1), 0);
}
function installExtension(opts) {
  const source = opts.source ?? defaultExtensionSource();
  if (!source) throw installError("EXTENSION_NOT_FOUND", "no built extension found: run `npm run build` or pass --from <extension dir>");
  if (!existsSync3(join3(source, "manifest.json"))) throw installError("EXTENSION_NOT_FOUND", `no manifest.json in ${source}`);
  const extensionId = extensionIdOf(source);
  const dir = resolve2(opts.dir);
  if (existsSync3(dir) && !statSync2(dir).isDirectory()) throw installError("INSTALL_DIR_INVALID", `${dir} is not a directory`);
  if (resolve2(source) === dir) throw installError("INSTALL_DIR_INVALID", "the destination is the source folder");
  let config2 = ensureConfig(opts.home, opts.port);
  const seeded = opts.seed === false ? { capabilities: [], brand: false } : seedFromPackage(opts.home, readPackagedBrand(opts.buildInfo ?? buildInfoNextTo(source)), config2.brand !== void 0);
  if (seeded.brand || seeded.capabilities.length) config2 = ensureConfig(opts.home, opts.port);
  mkdirSync2(dir, { recursive: true });
  rmSync3(join3(dir, SEED_FILE), { force: true });
  cpSync(source, dir, { recursive: true, force: true });
  writeSeed(dir, { port: config2.port, token: config2.pairingToken, ...config2.brand?.name ? { host: config2.brand.name } : {} });
  const extensionIds = opts.pin === false ? config2.extensionIds ?? [] : pinExtensionId(opts.home, extensionId);
  return { dir, extensionId, port: config2.port, extensionIds, files: countFiles(dir), seeded };
}
var installError;
var init_install = __esm({
  "daemon/src/install.ts"() {
    "use strict";
    init_protocol();
    init_config();
    init_keys();
    init_package_info();
    init_extension_id();
    installError = (code, message) => Object.assign(new Error(message), { code });
  }
});

// node_modules/zod/v4/core/util.js
var util_exports = {};
__export(util_exports, {
  BIGINT_FORMAT_RANGES: () => BIGINT_FORMAT_RANGES,
  CONSTANT_CATCH: () => CONSTANT_CATCH,
  Class: () => Class,
  NUMBER_FORMAT_RANGES: () => NUMBER_FORMAT_RANGES,
  aborted: () => aborted,
  allowsEval: () => allowsEval,
  assert: () => assert,
  assertEqual: () => assertEqual,
  assertIs: () => assertIs,
  assertNever: () => assertNever,
  assertNotEqual: () => assertNotEqual,
  assignProp: () => assignProp,
  attachSchema: () => attachSchema,
  base64ToUint8Array: () => base64ToUint8Array,
  base64urlToUint8Array: () => base64urlToUint8Array,
  cached: () => cached,
  captureStackTrace: () => captureStackTrace,
  cleanEnum: () => cleanEnum,
  cleanRegex: () => cleanRegex,
  clone: () => clone,
  cloneDef: () => cloneDef,
  codePointLength: () => codePointLength,
  constantCatch: () => constantCatch,
  createTransparentProxy: () => createTransparentProxy,
  defineLazy: () => defineLazy,
  defineLazyInternal: () => defineLazyInternal,
  derived: () => derived,
  esc: () => esc,
  escapeRegex: () => escapeRegex,
  explicitlyAborted: () => explicitlyAborted,
  extend: () => extend,
  finalizeIssue: () => finalizeIssue,
  floatSafeRemainder: () => floatSafeRemainder,
  getElementAtPath: () => getElementAtPath,
  getEnumValues: () => getEnumValues,
  getLengthableOrigin: () => getLengthableOrigin,
  getParsedType: () => getParsedType,
  getSizableOrigin: () => getSizableOrigin,
  hexToUint8Array: () => hexToUint8Array,
  hide: () => hide,
  installLazyProp: () => installLazyProp,
  isObject: () => isObject,
  isPlainObject: () => isPlainObject,
  issue: () => issue,
  joinValues: () => joinValues,
  jsonStringifyReplacer: () => jsonStringifyReplacer,
  members: () => members,
  merge: () => merge,
  mergeDefs: () => mergeDefs,
  normalizeParams: () => normalizeParams,
  nullish: () => nullish,
  numKeys: () => numKeys,
  objectClone: () => objectClone,
  omit: () => omit,
  optionalKeys: () => optionalKeys,
  own: () => own,
  parsedType: () => parsedType,
  partial: () => partial,
  pick: () => pick,
  prefixIssues: () => prefixIssues,
  primitiveTypes: () => primitiveTypes,
  promiseAllObject: () => promiseAllObject,
  propertyKeyTypes: () => propertyKeyTypes,
  randomString: () => randomString,
  rawShape: () => rawShape,
  required: () => required,
  safeExtend: () => safeExtend,
  shallowClone: () => shallowClone,
  sizeCaps: () => sizeCaps,
  slugify: () => slugify,
  stringifyPrimitive: () => stringifyPrimitive,
  toZod: () => toZod,
  uint8ArrayToBase64: () => uint8ArrayToBase64,
  uint8ArrayToBase64url: () => uint8ArrayToBase64url,
  uint8ArrayToHex: () => uint8ArrayToHex,
  unwrapMessage: () => unwrapMessage
});
function assertEqual(val) {
  return val;
}
function assertNotEqual(val) {
  return val;
}
function toZod() {
  return (schema) => schema;
}
function assertIs(_arg) {
}
function assertNever(_x) {
  throw new Error("Unexpected value in exhaustive check");
}
function assert(_) {
}
function getEnumValues(entries) {
  const numericValues = Object.values(entries).filter((v) => typeof v === "number");
  const values = Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
  return values;
}
function joinValues(array2, separator = "|") {
  return array2.map((val) => stringifyPrimitive(val)).join(separator);
}
function jsonStringifyReplacer(_, value) {
  if (typeof value === "bigint")
    return value.toString();
  return value;
}
function cached(getter) {
  return new Cached(getter);
}
function nullish(input) {
  return input === null || input === void 0;
}
function cleanRegex(source) {
  const start = source.startsWith("^") ? 1 : 0;
  const end = source.endsWith("$") ? source.length - 1 : source.length;
  return source.slice(start, end);
}
function floatSafeRemainder(val, step) {
  const ratio = val / step;
  const roundedRatio = Math.round(ratio);
  const tolerance = 4 * Number.EPSILON * Math.max(Math.abs(ratio), 1);
  if (Math.abs(ratio - roundedRatio) < tolerance)
    return 0;
  return ratio - roundedRatio;
}
function defineLazy(object3, key, getter) {
  let value = void 0;
  Object.defineProperty(object3, key, {
    get() {
      if (value === EVALUATING) {
        return void 0;
      }
      if (value === void 0) {
        value = EVALUATING;
        value = getter();
      }
      return value;
    },
    set(v) {
      Object.defineProperty(object3, key, {
        value: v
        // configurable: true,
      });
    },
    configurable: true
  });
}
function objectClone(obj) {
  return Object.create(Object.getPrototypeOf(obj), Object.getOwnPropertyDescriptors(obj));
}
function assignProp(target, prop, value) {
  Object.defineProperty(target, prop, {
    value,
    writable: true,
    enumerable: true,
    configurable: true
  });
}
function rawShape(def3) {
  const desc = Object.getOwnPropertyDescriptor(def3, "shape");
  return desc?.get ? desc.get.raw : desc?.value;
}
function sourceShape(schema) {
  return rawShape(schema._zod.def) ?? schema._zod.def.shape;
}
function deferProp(target, key, getter) {
  Object.defineProperty(target, key, {
    get() {
      const value = getter();
      assignProp(this, key, value);
      return value;
    },
    enumerable: true,
    configurable: true
  });
}
function putProp(target, key, value) {
  if (key in target)
    assignProp(target, key, value);
  else
    target[key] = value;
}
function mirrorShape(target, source, keys, wrap) {
  const raw = sourceShape(source);
  for (const key of keys) {
    const desc = Object.getOwnPropertyDescriptor(raw, key);
    if (!desc.enumerable)
      continue;
    if (desc.get) {
      deferProp(target, key, () => {
        const value = source._zod.def.shape[key];
        return wrap ? wrap(value, key) : value;
      });
    } else
      putProp(target, key, wrap ? wrap(desc.value, key) : desc.value);
  }
}
function mirrorProps(target, source) {
  for (const key of Reflect.ownKeys(source)) {
    const desc = Object.getOwnPropertyDescriptor(source, key);
    if (!desc.enumerable)
      continue;
    if (desc.get)
      deferProp(target, key, () => source[key]);
    else
      putProp(target, key, desc.value);
  }
}
function mergeDefs(...defs) {
  const mergedDescriptors = {};
  for (const def3 of defs) {
    const descriptors = Object.getOwnPropertyDescriptors(def3);
    Object.assign(mergedDescriptors, descriptors);
  }
  return Object.defineProperties({}, mergedDescriptors);
}
function cloneDef(schema) {
  return mergeDefs(schema._zod.def);
}
function getElementAtPath(obj, path) {
  if (!path)
    return obj;
  return path.reduce((acc, key) => acc?.[key], obj);
}
function promiseAllObject(promisesObj) {
  const keys = Object.keys(promisesObj);
  const promises = keys.map((key) => promisesObj[key]);
  return Promise.all(promises).then((results) => {
    const resolvedObj = {};
    for (let i = 0; i < keys.length; i++) {
      resolvedObj[keys[i]] = results[i];
    }
    return resolvedObj;
  });
}
function randomString(length = 10) {
  const chars = "abcdefghijklmnopqrstuvwxyz";
  let str3 = "";
  for (let i = 0; i < length; i++) {
    str3 += chars[Math.floor(Math.random() * chars.length)];
  }
  return str3;
}
function esc(str3) {
  return JSON.stringify(str3);
}
function slugify(input) {
  return input.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
}
function isObject(data) {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}
function isPlainObject(o) {
  if (isObject(o) === false)
    return false;
  const ctor = o.constructor;
  if (ctor === void 0)
    return true;
  if (typeof ctor !== "function")
    return true;
  const prot = ctor.prototype;
  if (isObject(prot) === false)
    return false;
  if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) {
    return false;
  }
  return true;
}
function shallowClone(o) {
  if (isPlainObject(o))
    return { ...o };
  if (Array.isArray(o))
    return [...o];
  if (o instanceof Map)
    return new Map(o);
  if (o instanceof Set)
    return new Set(o);
  return o;
}
function numKeys(data) {
  let keyCount = 0;
  for (const key in data) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      keyCount++;
    }
  }
  return keyCount;
}
function escapeRegex(str3) {
  return str3.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function clone(inst, def3, params) {
  const cl = new inst._zod.constr(def3 ?? inst._zod.def);
  if (!def3 || params?.parent)
    cl._zod.parent = inst;
  return cl;
}
function normalizeParams(_params) {
  const params = _params;
  if (!params)
    return {};
  if (typeof params === "string")
    return { error: () => params };
  if (params?.message !== void 0) {
    if (params?.error !== void 0)
      throw new Error("Cannot specify both `message` and `error` params");
    params.error = params.message;
  }
  delete params.message;
  if (typeof params.error === "string")
    return { ...params, error: () => params.error };
  return params;
}
function createTransparentProxy(getter) {
  let target;
  return new Proxy({}, {
    get(_, prop, receiver) {
      target ?? (target = getter());
      return Reflect.get(target, prop, receiver);
    },
    set(_, prop, value, receiver) {
      target ?? (target = getter());
      return Reflect.set(target, prop, value, receiver);
    },
    has(_, prop) {
      target ?? (target = getter());
      return Reflect.has(target, prop);
    },
    deleteProperty(_, prop) {
      target ?? (target = getter());
      return Reflect.deleteProperty(target, prop);
    },
    ownKeys(_) {
      target ?? (target = getter());
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(_, prop) {
      target ?? (target = getter());
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
    defineProperty(_, prop, descriptor) {
      target ?? (target = getter());
      return Reflect.defineProperty(target, prop, descriptor);
    }
  });
}
function stringifyPrimitive(value) {
  if (typeof value === "bigint")
    return value.toString() + "n";
  if (typeof value === "string")
    return `"${value}"`;
  return `${value}`;
}
function optionalKeys(shape) {
  return Object.keys(shape).filter((k) => {
    return shape[k]._zod.optin !== void 0 && shape[k]._zod.optout === "optional";
  });
}
function pick(schema, mask) {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(".pick() cannot be used on object schemas containing refinements");
  }
  const newShape = {};
  mirrorShape(newShape, schema, maskedKeys(schema, mask));
  return clone(schema, mergeDefs(currDef, { shape: newShape, checks: [] }));
}
function maskedKeys(schema, mask) {
  const raw = sourceShape(schema);
  const keys = [];
  for (const key of Reflect.ownKeys(mask)) {
    if (!Object.getOwnPropertyDescriptor(raw, key)?.enumerable) {
      throw new Error(`Unrecognized key: "${String(key)}"`);
    }
    if (mask[key])
      keys.push(key);
  }
  return keys;
}
function omit(schema, mask) {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(".omit() cannot be used on object schemas containing refinements");
  }
  const omitted = new Set(maskedKeys(schema, mask));
  const newShape = {};
  mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)).filter((key) => !omitted.has(key)));
  return clone(schema, mergeDefs(currDef, { shape: newShape, checks: [] }));
}
function extend(schema, shape) {
  if (!isPlainObject(shape)) {
    throw new Error("Invalid input to extend: expected a plain object");
  }
  const checks = schema._zod.def.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    const existingShape = sourceShape(schema);
    for (const key of Reflect.ownKeys(shape)) {
      if (Object.getOwnPropertyDescriptor(existingShape, key) !== void 0) {
        throw new Error("Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.");
      }
    }
  }
  return clone(schema, mergeDefs(schema._zod.def, { shape: extended(schema, shape) }));
}
function extended(schema, shape) {
  const newShape = {};
  mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)));
  mirrorProps(newShape, shape);
  return newShape;
}
function safeExtend(schema, shape) {
  if (!isPlainObject(shape)) {
    throw new Error("Invalid input to safeExtend: expected a plain object");
  }
  return clone(schema, mergeDefs(schema._zod.def, { shape: extended(schema, shape) }));
}
function merge(a, b) {
  if (!b?._zod?.def) {
    throw new Error("Invalid input to merge: expected an object schema. To merge a plain shape, use `.extend()`.");
  }
  if (a._zod.def.checks?.length) {
    throw new Error(".merge() cannot be used on object schemas containing refinements. Use .safeExtend() instead.");
  }
  const newShape = {};
  mirrorShape(newShape, a, Reflect.ownKeys(sourceShape(a)));
  mirrorShape(newShape, b, Reflect.ownKeys(sourceShape(b)));
  const def3 = mergeDefs(a._zod.def, {
    shape: newShape,
    get catchall() {
      return b._zod.def.catchall;
    },
    checks: b._zod.def.checks ?? []
  });
  return clone(a, def3);
}
function partial(Class2, schema, mask, name = "partial") {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(`.${name}() cannot be used on object schemas containing refinements`);
  }
  const selected = mask ? new Set(maskedKeys(schema, mask)) : void 0;
  const newShape = {};
  mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)), Class2 && ((value, key) => selected && !selected.has(key) ? value : new Class2({ type: "optional", innerType: value })));
  return clone(schema, mergeDefs(schema._zod.def, { shape: newShape, checks: [] }));
}
function required(Class2, schema, mask) {
  const selected = mask ? new Set(maskedKeys(schema, mask)) : void 0;
  const newShape = {};
  mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)), (value, key) => (
    // overwrite with non-optional
    selected && !selected.has(key) ? value : new Class2({ type: "nonoptional", innerType: value })
  ));
  return clone(schema, mergeDefs(schema._zod.def, { shape: newShape }));
}
function aborted(x, startIndex = 0) {
  if (x.aborted === true)
    return true;
  for (let i = startIndex; i < x.issues.length; i++) {
    if (x.issues[i]?.continue !== true) {
      return true;
    }
  }
  return false;
}
function explicitlyAborted(x, startIndex = 0) {
  if (x.aborted === true)
    return true;
  for (let i = startIndex; i < x.issues.length; i++) {
    if (x.issues[i]?.continue === false) {
      return true;
    }
  }
  return false;
}
function prefixIssues(path, issues) {
  return issues.map((iss) => {
    var _a3;
    (_a3 = iss).path ?? (_a3.path = []);
    iss.path.unshift(path);
    return iss;
  });
}
function unwrapMessage(message) {
  return typeof message === "string" ? message : message?.message;
}
function sizeCaps(defChecks) {
  const caps = [];
  for (const ch of defChecks ?? []) {
    const d = ch._zod.def;
    if (!/_(length|size)$|_equals$/.test(d.check))
      break;
    const max = d.maximum ?? d.length ?? d.size;
    if (max >= 0)
      caps.push([max, ch]);
  }
  return caps;
}
function attachSchema(issues, start, inst) {
  var _a3;
  for (let i = start; i < issues.length; i++) {
    (_a3 = issues[i]).schema ?? (_a3.schema = inst);
  }
}
function finalizeIssue(iss, ctx, config2) {
  var _a3;
  const traits = iss.inst?._zod?.traits;
  if (traits?.has("$ZodType")) {
    if (traits.has("$ZodCheck"))
      (_a3 = iss).schema ?? (_a3.schema = iss.inst);
    else
      iss.schema = iss.inst;
  }
  const schemaError = iss.schema !== iss.inst ? iss.schema?._zod.def?.error : void 0;
  const message = iss.message ? iss.message : unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(schemaError?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config2.customError?.(iss)) ?? unwrapMessage(config2.localeError?.(iss)) ?? "Invalid input";
  const full = {};
  for (const k of Object.keys(iss)) {
    if (k === "inst" || k === "schema" || k === "continue" || k === "input" || k === "__proto__")
      continue;
    full[k] = iss[k];
  }
  full.path ?? (full.path = []);
  full.message = message;
  if (ctx?.reportInput) {
    full.input = iss.input;
  }
  return full;
}
function getSizableOrigin(input) {
  if (input instanceof Set)
    return "set";
  if (input instanceof Map)
    return "map";
  if (input instanceof File)
    return "file";
  return "unknown";
}
function codePointLength(str3) {
  const units = str3.length;
  if (!highSurrogate.test(str3))
    return units;
  let count = units;
  for (let i = 0; i < units - 1; i++) {
    if ((str3.charCodeAt(i) & 64512) === 55296 && (str3.charCodeAt(i + 1) & 64512) === 56320) {
      count--;
      i++;
    }
  }
  return count;
}
function getLengthableOrigin(input) {
  if (Array.isArray(input))
    return "array";
  if (typeof input === "string")
    return "string";
  return "unknown";
}
function parsedType(data) {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "nan" : "number";
    }
    case "object": {
      if (data === null) {
        return "null";
      }
      if (Array.isArray(data)) {
        return "array";
      }
      const obj = data;
      if (obj && Object.getPrototypeOf(obj) !== Object.prototype && "constructor" in obj && obj.constructor) {
        return obj.constructor.name;
      }
    }
  }
  return t;
}
function issue(...args) {
  const [iss, input, inst] = args;
  if (typeof iss === "string") {
    return {
      message: iss,
      code: "custom",
      input,
      inst
    };
  }
  return { ...iss };
}
function cleanEnum(obj) {
  return Object.entries(obj).filter(([k, _]) => {
    return Number.isNaN(Number.parseInt(k, 10));
  }).map((el) => el[1]);
}
function base64ToUint8Array(base642) {
  const binaryString = atob(base642);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
function uint8ArrayToBase64(bytes) {
  let binaryString = "";
  for (let i = 0; i < bytes.length; i++) {
    binaryString += String.fromCharCode(bytes[i]);
  }
  return btoa(binaryString);
}
function base64urlToUint8Array(base64url2) {
  const base642 = base64url2.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - base642.length % 4) % 4);
  return base64ToUint8Array(base642 + padding);
}
function uint8ArrayToBase64url(bytes) {
  return uint8ArrayToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function hexToUint8Array(hex) {
  const cleanHex = hex.replace(/^0x/, "");
  if (cleanHex.length % 2 !== 0) {
    throw new Error("Invalid hex string length");
  }
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(cleanHex.slice(i, i + 2), 16);
  }
  return bytes;
}
function uint8ArrayToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function members(proto, table) {
  for (const key in table) {
    const desc = Object.getOwnPropertyDescriptor(table, key);
    if (desc.get)
      Object.defineProperty(proto, key, { ...desc, enumerable: false });
    else
      defineBound(proto, key, desc.value);
  }
}
function own(inst, key, value, enumerable = true) {
  Object.defineProperty(inst, key, { configurable: true, writable: true, enumerable, value });
  return value;
}
function hide(inst, key, value) {
  return own(inst, key, value, false);
}
// @__NO_SIDE_EFFECTS__
function derived(computes, table) {
  for (const key in computes) {
    const compute = computes[key];
    Object.defineProperty(table, key, {
      configurable: true,
      enumerable: true,
      get() {
        return own(this, key, compute(this));
      },
      set(value) {
        own(this, key, value);
      }
    });
  }
  return table;
}
function defineBound(proto, key, fn) {
  Object.defineProperty(proto, key, {
    configurable: true,
    get() {
      return this == null ? fn : own(this, key, fn.bind(this));
    },
    set(value) {
      own(this, key, value);
    }
  });
}
function claim(inst, sentinel) {
  const proto = Object.getPrototypeOf(inst);
  return sentinel in proto ? void 0 : proto;
}
function defineLazyInternal(inst, key, compute) {
  const proto = Object.getPrototypeOf(inst._zod);
  if (key in proto && installing !== inst._zod) {
    installing = void 0;
    return;
  }
  installing = inst._zod;
  Object.defineProperty(proto, key, {
    configurable: true,
    get() {
      Object.defineProperty(this, key, breaker);
      const outer = broke;
      broke = false;
      try {
        const value = compute(this);
        if (broke)
          delete this[key];
        else
          Object.defineProperty(this, key, { configurable: true, writable: true, value });
        broke = broke || outer;
        return value;
      } catch (err) {
        delete this[key];
        broke = broke || outer;
        throw err;
      }
    },
    set(value) {
      Object.defineProperty(this, key, { configurable: true, writable: true, value });
    }
  });
}
function installLazyProp(inst, key, make, enumerable) {
  const proto = claim(inst, key);
  if (!proto)
    return;
  Object.defineProperty(proto, key, {
    configurable: true,
    get() {
      const desc = { configurable: true, writable: true, enumerable, value: void 0 };
      Object.defineProperty(this, key, desc);
      desc.value = make(this);
      Object.defineProperty(this, key, desc);
      return desc.value;
    },
    set(value) {
      Object.defineProperty(this, key, { configurable: true, writable: true, enumerable, value });
    }
  });
}
function constantCatch(value) {
  const fn = () => value;
  fn[CONSTANT_CATCH] = true;
  return fn;
}
var Cached, EVALUATING, captureStackTrace, allowsEval, getParsedType, propertyKeyTypes, primitiveTypes, NUMBER_FORMAT_RANGES, BIGINT_FORMAT_RANGES, highSurrogate, Class, installing, broke, breaker, CONSTANT_CATCH;
var init_util = __esm({
  "node_modules/zod/v4/core/util.js"() {
    init_core();
    Cached = class {
      constructor(getter) {
        this._getter = getter;
        this._value = void 0;
      }
      get value() {
        const getter = this._getter;
        if (getter !== void 0) {
          this._value = getter();
          this._getter = void 0;
        }
        return this._value;
      }
    };
    EVALUATING = /* @__PURE__ */ Symbol("evaluating");
    captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {
    };
    allowsEval = /* @__PURE__ */ cached(() => {
      if (globalConfig.jitless) {
        return false;
      }
      if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) {
        return false;
      }
      try {
        const F = Function;
        new F("");
        return true;
      } catch (_) {
        return false;
      }
    });
    getParsedType = (data) => {
      const t = typeof data;
      switch (t) {
        case "undefined":
          return "undefined";
        case "string":
          return "string";
        case "number":
          return Number.isNaN(data) ? "nan" : "number";
        case "boolean":
          return "boolean";
        case "function":
          return "function";
        case "bigint":
          return "bigint";
        case "symbol":
          return "symbol";
        case "object":
          if (Array.isArray(data)) {
            return "array";
          }
          if (data === null) {
            return "null";
          }
          if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
            return "promise";
          }
          if (typeof Map !== "undefined" && data instanceof Map) {
            return "map";
          }
          if (typeof Set !== "undefined" && data instanceof Set) {
            return "set";
          }
          if (typeof Date !== "undefined" && data instanceof Date) {
            return "date";
          }
          if (typeof File !== "undefined" && data instanceof File) {
            return "file";
          }
          return "object";
        default:
          throw new Error(`Unknown data type: ${t}`);
      }
    };
    propertyKeyTypes = /* @__PURE__ */ new Set(["string", "number", "symbol"]);
    primitiveTypes = /* @__PURE__ */ new Set([
      "string",
      "number",
      "bigint",
      "boolean",
      "symbol",
      "undefined"
    ]);
    NUMBER_FORMAT_RANGES = /* @__PURE__ */ (() => ({
      safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
      int32: [-2147483648, 2147483647],
      uint32: [0, 4294967295],
      float32: [-34028234663852886e22, 34028234663852886e22],
      float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
    }))();
    BIGINT_FORMAT_RANGES = {
      int64: [/* @__PURE__ */ BigInt("-9223372036854775808"), /* @__PURE__ */ BigInt("9223372036854775807")],
      uint64: [/* @__PURE__ */ BigInt(0), /* @__PURE__ */ BigInt("18446744073709551615")]
    };
    highSurrogate = /[\uD800-\uDBFF]/;
    Class = class {
      constructor(..._args) {
      }
    };
    broke = false;
    breaker = {
      configurable: true,
      get() {
        broke = true;
        return void 0;
      }
    };
    CONSTANT_CATCH = "~constantCatch";
  }
});

// node_modules/zod/v4/core/core.js
function newError(Definition) {
  const E = _E;
  if (E) {
    const saved = E.stackTraceLimit;
    if (typeof saved === "number") {
      try {
        E.stackTraceLimit = 0;
      } catch {
        _E = null;
        return new Definition();
      }
      try {
        return new Definition();
      } finally {
        E.stackTraceLimit = saved;
      }
    }
  }
  return new Definition();
}
// @__NO_SIDE_EFFECTS__
function $constructor(name, initializer3, proto, params) {
  const zodProto = {};
  function Internals(def3) {
    this.def = def3;
    this.constr = _;
    this.traits = /* @__PURE__ */ new Set();
  }
  Internals.prototype = zodProto;
  const protoMembers = proto;
  const initialized = protoMembers && /* @__PURE__ */ new WeakSet();
  function init(inst, def3) {
    if (!inst._zod) {
      _zodDesc.value = new Internals(def3);
      try {
        Object.defineProperty(inst, "_zod", _zodDesc);
      } finally {
        _zodDesc.value = void 0;
      }
    } else if (inst._zod.traits.has(name)) {
      return;
    }
    inst._zod.traits.add(name);
    initializer3(inst, def3);
    if (initialized) {
      const own2 = Object.getPrototypeOf(inst);
      const ctorProto = inst._zod.constr.prototype;
      let up = own2;
      while (up && up !== ctorProto)
        up = Object.getPrototypeOf(up);
      const target = up ?? own2;
      if (!initialized.has(target)) {
        initialized.add(target);
        members(target, protoMembers);
      }
    }
    const proto2 = _.prototype;
    for (const k in proto2) {
      if (!Object.prototype.hasOwnProperty.call(proto2, k))
        continue;
      if (!(k in inst)) {
        inst[k] = proto2[k].bind(inst);
      }
    }
  }
  const Parent = params?.Parent ?? Object;
  class Definition extends Parent {
  }
  Object.defineProperty(Definition, "name", { value: name });
  function _(def3) {
    const inst = params?.Parent ? newError(Definition) : this;
    init(inst, def3);
    const deferred = inst._zod.deferred;
    if (deferred) {
      for (const fn of deferred) {
        fn();
      }
      inst._zod.deferred = void 0;
    }
    const pp = globalThis.__zod_globalConfig?.postProcessor;
    if (pp)
      pp(inst);
    return inst;
  }
  Object.defineProperty(_, "init", { value: init });
  Object.defineProperty(_, Symbol.hasInstance, {
    value: (inst) => {
      if (params?.Parent && inst instanceof params.Parent)
        return true;
      return inst?._zod?.traits?.has(name);
    }
  });
  Object.defineProperty(_, "name", { value: name });
  return _;
}
function config(newConfig) {
  if (newConfig)
    Object.assign(globalConfig, newConfig);
  return globalConfig;
}
var _a, _zodDesc, _E, $ZodAsyncError, $ZodEncodeError, globalConfig;
var init_core = __esm({
  "node_modules/zod/v4/core/core.js"() {
    init_util();
    _zodDesc = { value: void 0, enumerable: false };
    _E = "captureStackTrace" in Error ? Error : null;
    $ZodAsyncError = class extends Error {
      constructor() {
        super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
      }
    };
    $ZodEncodeError = class extends Error {
      constructor(name) {
        super(`Encountered unidirectional transform during encode: ${name}`);
        this.name = "ZodEncodeError";
      }
    };
    (_a = globalThis).__zod_globalConfig ?? (_a.__zod_globalConfig = {});
    globalConfig = globalThis.__zod_globalConfig;
  }
});

// node_modules/zod/v4/core/errors.js
function _getMessage() {
  const internals = this._zod;
  internals.message ?? (internals.message = JSON.stringify(internals.def, jsonStringifyReplacer, 2));
  return internals.message;
}
function _setMessage(value) {
  this._zod.message = value;
}
function node(obj, key, make) {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) {
    if (key === "__proto__") {
      Object.defineProperty(obj, key, { value: make(), writable: true, enumerable: true, configurable: true });
    } else {
      obj[key] = make();
    }
  }
  return obj[key];
}
function flattenError(error2, mapper = (issue2) => issue2.message) {
  const fieldErrors = {};
  const formErrors = [];
  for (const sub of error2.issues) {
    if (sub.path.length > 0) {
      node(fieldErrors, sub.path[0], () => []).push(mapper(sub));
    } else {
      formErrors.push(mapper(sub));
    }
  }
  return { formErrors, fieldErrors };
}
function formatError(error2, mapper = (issue2) => issue2.message) {
  const fieldErrors = { _errors: [] };
  const processError = (error3, path = []) => {
    for (const issue2 of error3.issues) {
      if (issue2.code === "invalid_union" && issue2.errors.length) {
        issue2.errors.map((issues) => processError({ issues }, [...path, ...issue2.path]));
      } else if (issue2.code === "invalid_key") {
        processError({ issues: issue2.issues }, [...path, ...issue2.path]);
      } else if (issue2.code === "invalid_element") {
        processError({ issues: issue2.issues }, [...path, ...issue2.path]);
      } else {
        const fullpath = [...path, ...issue2.path];
        if (fullpath.length === 0) {
          fieldErrors._errors.push(mapper(issue2));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < fullpath.length) {
            const el = fullpath[i];
            const terminal = i === fullpath.length - 1;
            if (el === "_errors") {
              if (terminal)
                curr._errors.push(mapper(issue2));
              i++;
              continue;
            }
            if (!Object.prototype.hasOwnProperty.call(curr, el)) {
              Object.defineProperty(curr, el, {
                value: { _errors: [] },
                enumerable: true,
                writable: true,
                configurable: true
              });
            }
            const node2 = curr[el];
            if (terminal) {
              node2._errors.push(mapper(issue2));
            }
            curr = node2;
            i++;
          }
        }
      }
    }
  };
  processError(error2);
  return fieldErrors;
}
var _messageDesc, _issuesDesc, _installedToString, initializer, $ZodError, $ZodRealError;
var init_errors = __esm({
  "node_modules/zod/v4/core/errors.js"() {
    init_core();
    init_util();
    _messageDesc = {
      get: _getMessage,
      set: _setMessage,
      enumerable: true,
      configurable: true
    };
    _issuesDesc = { value: void 0, enumerable: false };
    _installedToString = /* @__PURE__ */ new WeakSet([Object.prototype, Error.prototype]);
    initializer = (inst, def3) => {
      inst.name = "$ZodError";
      _issuesDesc.value = def3;
      Object.defineProperty(inst, "issues", _issuesDesc);
      _issuesDesc.value = void 0;
      Object.defineProperty(inst, "message", _messageDesc);
      const proto = Object.getPrototypeOf(inst);
      if (!_installedToString.has(proto)) {
        _installedToString.add(proto);
        Object.defineProperty(proto, "toString", {
          configurable: true,
          enumerable: false,
          get() {
            const value = () => this.message;
            Object.defineProperty(this, "toString", { value, configurable: true, writable: true });
            return value;
          },
          set(value) {
            Object.defineProperty(this, "toString", { value, configurable: true, writable: true });
          }
        });
      }
    };
    $ZodError = $constructor("$ZodError", initializer);
    $ZodRealError = $constructor("$ZodError", initializer, void 0, {
      Parent: Error
    });
  }
});

// node_modules/zod/v4/core/parse.js
function finalizeParams(callee, params) {
  return { callee: params?.callee ?? callee, Err: params?.Err };
}
function failure(Err, issues, ctx) {
  let error2;
  return {
    success: false,
    get error() {
      if (!error2) {
        error2 = new Err(issues.map((iss) => finalizeIssue(iss, ctx, config())));
        issues = void 0;
        ctx = void 0;
      }
      return error2;
    },
    set error(e) {
      error2 = e;
      issues = void 0;
      ctx = void 0;
    }
  };
}
function validateFallback(schema, value, _ctx) {
  const ctx = _ctx ? { ..._ctx, async: false, abortEarly: true } : { async: false, abortEarly: true };
  const fallbackRun = schema._zod.bag.fallbackRun;
  let result;
  if (fallbackRun) {
    ctx[COMPILE_FALLBACK] = true;
    result = fallbackRun({ value, issues: [] }, ctx);
  } else {
    result = schema._zod.run({ value, issues: [] }, ctx);
  }
  if (result instanceof Promise) {
    throw new $ZodAsyncError();
  }
  return result.issues.length === 0;
}
var _parse, _parseAsync, _safeParse, safeParse, _safeParseAsync, COMPILE_INVALID, COMPILE_FALLBACK, validate, validateAsync, _encode, _decode, _encodeAsync, _decodeAsync, _safeEncode, _safeDecode, _safeEncodeAsync, _safeDecodeAsync;
var init_parse = __esm({
  "node_modules/zod/v4/core/parse.js"() {
    init_core();
    init_errors();
    init_util();
    _parse = (_Err) => {
      const fn = (schema, value, _ctx, _params) => {
        const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
        const result = schema._zod.run({ value, issues: [] }, ctx);
        if (result instanceof Promise) {
          throw new $ZodAsyncError();
        }
        if (result.issues.length) {
          const e = new (_params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
          captureStackTrace(e, _params?.callee ?? fn);
          throw e;
        }
        return result.value;
      };
      return fn;
    };
    _parseAsync = (_Err) => {
      const fn = async (schema, value, _ctx, params) => {
        const ctx = _ctx ? { ..._ctx, async: true } : { async: true };
        let result = schema._zod.run({ value, issues: [] }, ctx);
        if (result instanceof Promise)
          result = await result;
        if (result.issues.length) {
          const e = new (params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
          captureStackTrace(e, params?.callee ?? fn);
          throw e;
        }
        return result.value;
      };
      return fn;
    };
    _safeParse = (_Err) => (schema, value, _ctx) => {
      const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
      const result = schema._zod.run({ value, issues: [] }, ctx);
      if (result instanceof Promise) {
        throw new $ZodAsyncError();
      }
      return result.issues.length ? failure(_Err, result.issues, ctx) : { success: true, data: result.value };
    };
    safeParse = /* @__PURE__ */ _safeParse($ZodRealError);
    _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
      const ctx = _ctx ? { ..._ctx, async: true } : { async: true };
      let result = schema._zod.run({ value, issues: [] }, ctx);
      if (result instanceof Promise)
        result = await result;
      return result.issues.length ? failure(_Err, result.issues, ctx) : { success: true, data: result.value };
    };
    COMPILE_INVALID = /* @__PURE__ */ Symbol.for("zod.compile.invalid");
    COMPILE_FALLBACK = /* @__PURE__ */ Symbol.for("zod.compile.fallback");
    validate = ((schema, value, _ctx) => {
      const validator = schema._zod.bag.validator;
      if (validator !== void 0) {
        if (validator(value) !== COMPILE_INVALID)
          return true;
        if (validator.definite === true && _ctx === void 0)
          return false;
      }
      return validateFallback(schema, value, _ctx);
    });
    validateAsync = async (schema, value, _ctx) => {
      const ctx = _ctx ? { ..._ctx, async: true, abortEarly: true } : { async: true, abortEarly: true };
      let result = schema._zod.run({ value, issues: [] }, ctx);
      if (result instanceof Promise)
        result = await result;
      return result.issues.length === 0;
    };
    _encode = (_Err) => {
      const parse4 = _parse(_Err);
      const fn = (schema, value, _ctx, _params) => {
        const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
        return parse4(schema, value, ctx, finalizeParams(fn, _params));
      };
      return fn;
    };
    _decode = (_Err) => {
      const parse4 = _parse(_Err);
      const fn = (schema, value, _ctx, _params) => {
        return parse4(schema, value, _ctx, finalizeParams(fn, _params));
      };
      return fn;
    };
    _encodeAsync = (_Err) => {
      const parseAsync3 = _parseAsync(_Err);
      const fn = async (schema, value, _ctx, _params) => {
        const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
        return await parseAsync3(schema, value, ctx, finalizeParams(fn, _params));
      };
      return fn;
    };
    _decodeAsync = (_Err) => {
      const parseAsync3 = _parseAsync(_Err);
      const fn = async (schema, value, _ctx, _params) => {
        return await parseAsync3(schema, value, _ctx, finalizeParams(fn, _params));
      };
      return fn;
    };
    _safeEncode = (_Err) => (schema, value, _ctx) => {
      const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
      return _safeParse(_Err)(schema, value, ctx);
    };
    _safeDecode = (_Err) => (schema, value, _ctx) => {
      return _safeParse(_Err)(schema, value, _ctx);
    };
    _safeEncodeAsync = (_Err) => async (schema, value, _ctx) => {
      const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
      return _safeParseAsync(_Err)(schema, value, ctx);
    };
    _safeDecodeAsync = (_Err) => async (schema, value, _ctx) => {
      return _safeParseAsync(_Err)(schema, value, _ctx);
    };
  }
});

// node_modules/zod/v4/core/regexes.js
function nanoidOfLength(length) {
  return new RegExp(`^[a-zA-Z0-9_-]{${length}}$`);
}
function emoji() {
  return new RegExp(_emoji, "u");
}
function anchor(source) {
  return new RegExp(`^${source}$`);
}
function timeSource(args) {
  const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
  const regex = typeof args.precision === "number" ? args.precision === -1 ? `${hhmm}` : args.precision === 0 ? `${hhmm}:[0-5]\\d` : `${hhmm}:[0-5]\\d\\.\\d{${args.precision}}` : args.seconds ? `${hhmm}:[0-5]\\d(?:\\.\\d+)?` : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
  return regex;
}
function time(args) {
  return new RegExp(`^${timeSource(args)}$`);
}
function datetime(args) {
  const opts = ["Z"];
  if (args.offset)
    opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
  const qualified = `${timeSource({ precision: args.precision, seconds: true })}(?:${opts.join("|")})`;
  const timeRegex = args.local ? `${qualified}|${timeSource({ precision: args.precision })}` : qualified;
  return new RegExp(`^${dateSource}T(?:${timeRegex})$`);
}
var cuid, cuid2, ulid, xid, ksuid, nanoid, duration, guid, uuid, email, _emoji, ipv4, ipv6, cidrv4, cidrv6, base64, base64url, httpProtocol, e164, dateSource, date, anyString, integer, number, boolean, _null, lowercase, uppercase;
var init_regexes = __esm({
  "node_modules/zod/v4/core/regexes.js"() {
    cuid = /^[cC][0-9a-z]{6,}$/;
    cuid2 = /^[0-9a-z]+$/;
    ulid = /^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$/;
    xid = /^[0-9a-vA-V]{20}$/;
    ksuid = /^[A-Za-z0-9]{27}$/;
    nanoid = /^[a-zA-Z0-9_-]{21}$/;
    duration = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
    guid = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
    uuid = (version3) => {
      if (!version3)
        return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
      return new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${version3}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`);
    };
    email = /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
    _emoji = `^(?=[\\s\\S]*[\\p{Extended_Pictographic}\\p{Regional_Indicator}\\u20E3])[\\p{Extended_Pictographic}\\p{Emoji_Component}]+$`;
    ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
    ipv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
    cidrv4 = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
    cidrv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
    base64 = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
    base64url = /^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$/;
    httpProtocol = /^https?$/;
    e164 = /^\+[1-9]\d{6,14}$/;
    dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
    date = /* @__PURE__ */ anchor(dateSource);
    anyString = /^[\s\S]{0,}$/;
    integer = /^-?\d+$/;
    number = /^-?\d+(?:\.\d+)?$/;
    boolean = /^(?:true|false)$/i;
    _null = /^null$/i;
    lowercase = /^[^A-Z]*$/;
    uppercase = /^[^a-z]*$/;
  }
});

// node_modules/zod/v4/core/checks.js
var $ZodCheck, _whenHasLength, numericOriginMap, $ZodCheckLessThan, $ZodCheckGreaterThan, $ZodCheckMultipleOf, $ZodCheckNumberFormat, $ZodCheckMaxLength, $ZodCheckMinLength, $ZodCheckLengthEquals, $ZodCheckStringFormat, $ZodCheckRegex, $ZodCheckLowerCase, $ZodCheckUpperCase, $ZodCheckIncludes, $ZodCheckStartsWith, $ZodCheckEndsWith, $ZodCheckOverwrite;
var init_checks = __esm({
  "node_modules/zod/v4/core/checks.js"() {
    init_core();
    init_regexes();
    init_util();
    $ZodCheck = /* @__PURE__ */ $constructor("$ZodCheck", (inst, def3) => {
      var _a3;
      inst._zod ?? (inst._zod = {});
      inst._zod.def = def3;
      (_a3 = inst._zod).onattach ?? (_a3.onattach = []);
    });
    _whenHasLength = (payload) => {
      const val = payload.value;
      return !nullish(val) && val.length !== void 0;
    };
    numericOriginMap = {
      number: "number",
      bigint: "bigint",
      object: "date"
    };
    $ZodCheckLessThan = /* @__PURE__ */ $constructor("$ZodCheckLessThan", (inst, def3) => {
      $ZodCheck.init(inst, def3);
      const origin = numericOriginMap[typeof def3.value];
      inst._zod.check = (payload) => {
        if (def3.inclusive ? payload.value <= def3.value : payload.value < def3.value) {
          return;
        }
        payload.issues.push({
          origin: numericOriginMap[typeof payload.value] ?? origin,
          code: "too_big",
          maximum: typeof def3.value === "object" ? def3.value.getTime() : def3.value,
          input: payload.value,
          inclusive: def3.inclusive,
          inst,
          continue: !def3.abort
        });
      };
    });
    $ZodCheckGreaterThan = /* @__PURE__ */ $constructor("$ZodCheckGreaterThan", (inst, def3) => {
      $ZodCheck.init(inst, def3);
      const origin = numericOriginMap[typeof def3.value];
      inst._zod.check = (payload) => {
        if (def3.inclusive ? payload.value >= def3.value : payload.value > def3.value) {
          return;
        }
        payload.issues.push({
          origin: numericOriginMap[typeof payload.value] ?? origin,
          code: "too_small",
          minimum: typeof def3.value === "object" ? def3.value.getTime() : def3.value,
          input: payload.value,
          inclusive: def3.inclusive,
          inst,
          continue: !def3.abort
        });
      };
    });
    $ZodCheckMultipleOf = /* @__PURE__ */ $constructor("$ZodCheckMultipleOf", (inst, def3) => {
      $ZodCheck.init(inst, def3);
      inst._zod.check = (payload) => {
        if (typeof payload.value !== typeof def3.value)
          throw new Error("Cannot mix number and bigint in multiple_of check.");
        const isMultiple = typeof payload.value === "bigint" ? (
          // `value % 0n` throws, and nothing is a multiple of zero — the number branch already fails this way via NaN
          def3.value !== BigInt(0) && payload.value % def3.value === BigInt(0)
        ) : floatSafeRemainder(payload.value, def3.value) === 0;
        if (isMultiple)
          return;
        payload.issues.push({
          origin: typeof payload.value,
          code: "not_multiple_of",
          divisor: def3.value,
          input: payload.value,
          inst,
          continue: !def3.abort
        });
      };
    });
    $ZodCheckNumberFormat = /* @__PURE__ */ $constructor("$ZodCheckNumberFormat", (inst, def3) => {
      $ZodCheck.init(inst, def3);
      def3.format = def3.format || "float64";
      const isInt = def3.format?.includes("int");
      const origin = isInt ? "int" : "number";
      const [minimum, maximum] = NUMBER_FORMAT_RANGES[def3.format];
      inst._zod.check = (payload) => {
        const input = payload.value;
        if (isInt) {
          if (!Number.isInteger(input)) {
            payload.issues.push({
              expected: origin,
              format: def3.format,
              code: "invalid_type",
              continue: false,
              input,
              inst
            });
            return;
          }
          if (!Number.isSafeInteger(input)) {
            if (input > 0) {
              payload.issues.push({
                input,
                code: "too_big",
                maximum: Number.MAX_SAFE_INTEGER,
                note: "Integers must be within the safe integer range.",
                inst,
                origin,
                inclusive: true,
                continue: !def3.abort
              });
            } else {
              payload.issues.push({
                input,
                code: "too_small",
                minimum: Number.MIN_SAFE_INTEGER,
                note: "Integers must be within the safe integer range.",
                inst,
                origin,
                inclusive: true,
                continue: !def3.abort
              });
            }
            return;
          }
        }
        if (input < minimum) {
          payload.issues.push({
            origin: "number",
            input,
            code: "too_small",
            minimum,
            inclusive: true,
            inst,
            continue: !def3.abort
          });
        }
        if (input > maximum) {
          payload.issues.push({
            origin: "number",
            input,
            code: "too_big",
            maximum,
            inclusive: true,
            inst,
            continue: !def3.abort
          });
        }
      };
    });
    $ZodCheckMaxLength = /* @__PURE__ */ $constructor("$ZodCheckMaxLength", (inst, def3) => {
      var _a3;
      $ZodCheck.init(inst, def3);
      (_a3 = inst._zod.def).when ?? (_a3.when = _whenHasLength);
      inst._zod.check = (payload) => {
        const input = payload.value;
        const units = input.length;
        const length = typeof input === "string" && units > def3.maximum ? codePointLength(input) : units;
        if (length <= def3.maximum)
          return;
        const origin = getLengthableOrigin(input);
        payload.issues.push({
          origin,
          code: "too_big",
          maximum: def3.maximum,
          inclusive: true,
          input,
          inst,
          continue: !def3.abort
        });
      };
    });
    $ZodCheckMinLength = /* @__PURE__ */ $constructor("$ZodCheckMinLength", (inst, def3) => {
      var _a3;
      $ZodCheck.init(inst, def3);
      (_a3 = inst._zod.def).when ?? (_a3.when = _whenHasLength);
      inst._zod.check = (payload) => {
        const input = payload.value;
        const units = input.length;
        const length = typeof input === "string" && units >= def3.minimum && units < def3.minimum * 2 ? codePointLength(input) : units;
        if (length >= def3.minimum)
          return;
        const origin = getLengthableOrigin(input);
        payload.issues.push({
          origin,
          code: "too_small",
          minimum: def3.minimum,
          inclusive: true,
          input,
          inst,
          continue: !def3.abort
        });
      };
    });
    $ZodCheckLengthEquals = /* @__PURE__ */ $constructor("$ZodCheckLengthEquals", (inst, def3) => {
      var _a3;
      $ZodCheck.init(inst, def3);
      (_a3 = inst._zod.def).when ?? (_a3.when = _whenHasLength);
      inst._zod.check = (payload) => {
        const input = payload.value;
        const units = input.length;
        const length = typeof input === "string" && units >= def3.length && units <= def3.length * 2 ? codePointLength(input) : units;
        if (length === def3.length)
          return;
        const origin = getLengthableOrigin(input);
        const tooBig = length > def3.length;
        payload.issues.push({
          origin,
          ...tooBig ? { code: "too_big", maximum: def3.length } : { code: "too_small", minimum: def3.length },
          inclusive: true,
          exact: true,
          input: payload.value,
          inst,
          continue: !def3.abort
        });
      };
    });
    $ZodCheckStringFormat = /* @__PURE__ */ $constructor("$ZodCheckStringFormat", (inst, def3) => {
      var _a3, _b;
      $ZodCheck.init(inst, def3);
      if (def3.pattern)
        (_a3 = inst._zod).check ?? (_a3.check = (payload) => {
          def3.pattern.lastIndex = 0;
          if (def3.pattern.test(payload.value))
            return;
          payload.issues.push({
            origin: "string",
            code: "invalid_format",
            format: def3.format,
            input: payload.value,
            ...def3.pattern ? { pattern: def3.pattern.toString() } : {},
            inst,
            continue: !def3.abort
          });
        });
      else
        (_b = inst._zod).check ?? (_b.check = () => {
        });
    });
    $ZodCheckRegex = /* @__PURE__ */ $constructor("$ZodCheckRegex", (inst, def3) => {
      $ZodCheckStringFormat.init(inst, def3);
      inst._zod.check = (payload) => {
        def3.pattern.lastIndex = 0;
        if (def3.pattern.test(payload.value))
          return;
        payload.issues.push({
          origin: "string",
          code: "invalid_format",
          format: "regex",
          input: payload.value,
          pattern: def3.pattern.toString(),
          inst,
          continue: !def3.abort
        });
      };
    });
    $ZodCheckLowerCase = /* @__PURE__ */ $constructor("$ZodCheckLowerCase", (inst, def3) => {
      def3.pattern ?? (def3.pattern = lowercase);
      $ZodCheckStringFormat.init(inst, def3);
    });
    $ZodCheckUpperCase = /* @__PURE__ */ $constructor("$ZodCheckUpperCase", (inst, def3) => {
      def3.pattern ?? (def3.pattern = uppercase);
      $ZodCheckStringFormat.init(inst, def3);
    });
    $ZodCheckIncludes = /* @__PURE__ */ $constructor("$ZodCheckIncludes", (inst, def3) => {
      $ZodCheck.init(inst, def3);
      const escapedRegex = escapeRegex(def3.includes);
      const pattern = new RegExp(typeof def3.position === "number" ? `^.{${def3.position},}${escapedRegex}` : escapedRegex);
      def3.pattern = pattern;
      inst._zod.check = (payload) => {
        if (payload.value.includes(def3.includes, def3.position))
          return;
        payload.issues.push({
          origin: "string",
          code: "invalid_format",
          format: "includes",
          includes: def3.includes,
          input: payload.value,
          inst,
          continue: !def3.abort
        });
      };
    });
    $ZodCheckStartsWith = /* @__PURE__ */ $constructor("$ZodCheckStartsWith", (inst, def3) => {
      $ZodCheck.init(inst, def3);
      const pattern = new RegExp(`^${escapeRegex(def3.prefix)}.*`);
      def3.pattern ?? (def3.pattern = pattern);
      inst._zod.check = (payload) => {
        if (payload.value.startsWith(def3.prefix))
          return;
        payload.issues.push({
          origin: "string",
          code: "invalid_format",
          format: "starts_with",
          prefix: def3.prefix,
          input: payload.value,
          inst,
          continue: !def3.abort
        });
      };
    });
    $ZodCheckEndsWith = /* @__PURE__ */ $constructor("$ZodCheckEndsWith", (inst, def3) => {
      $ZodCheck.init(inst, def3);
      const pattern = new RegExp(`.*${escapeRegex(def3.suffix)}$`);
      def3.pattern ?? (def3.pattern = pattern);
      inst._zod.check = (payload) => {
        if (payload.value.endsWith(def3.suffix))
          return;
        payload.issues.push({
          origin: "string",
          code: "invalid_format",
          format: "ends_with",
          suffix: def3.suffix,
          input: payload.value,
          inst,
          continue: !def3.abort
        });
      };
    });
    $ZodCheckOverwrite = /* @__PURE__ */ $constructor("$ZodCheckOverwrite", (inst, def3) => {
      $ZodCheck.init(inst, def3);
      inst._zod.check = (payload) => {
        payload.value = def3.tx(payload.value);
      };
    });
  }
});

// node_modules/zod/v4/core/doc.js
var Doc;
var init_doc = __esm({
  "node_modules/zod/v4/core/doc.js"() {
    Doc = class {
      constructor(args = [], closed = {}) {
        this.content = [];
        this.indent = 0;
        this.args = args;
        this.closed = closed;
      }
      // the compiler catches a child's throw and keeps writing into this doc, so the indent has to unwind with it
      indented(fn) {
        this.indent += 1;
        try {
          fn(this);
        } finally {
          this.indent -= 1;
        }
      }
      write(arg) {
        if (typeof arg === "function") {
          arg(this, { execution: "sync" });
          arg(this, { execution: "async" });
          return;
        }
        const content = arg;
        const lines = content.split("\n").filter((x) => x);
        const minIndent = Math.min(...lines.map((x) => x.length - x.trimStart().length));
        const dedented = lines.map((x) => x.slice(minIndent)).map((x) => " ".repeat(this.indent * 2) + x);
        for (const line of dedented) {
          this.content.push(line);
        }
      }
      compile() {
        const F = Function;
        const content = this?.content ?? [``];
        const factory = new F(...Object.keys(this.closed), `return function (${this.args.join(", ")}) {
${content.join("\n")}
};`);
        return factory(...Object.values(this.closed));
      }
    };
  }
});

// node_modules/zod/v4/core/versions.js
var version;
var init_versions = __esm({
  "node_modules/zod/v4/core/versions.js"() {
    version = {
      major: 4,
      minor: 6,
      patch: 7
    };
  }
});

// node_modules/zod/v4/core/schemas.js
async function validateAsync2(inst, value) {
  const ctx = { async: true };
  return toStandardResult(await inst._zod.run({ value, issues: [] }, ctx), ctx);
}
function standardProps(inst) {
  return {
    validate: (value) => {
      const ctx = { async: false };
      try {
        const r = inst._zod.run({ value, issues: [] }, ctx);
        if (!(r instanceof Promise))
          return toStandardResult(r, ctx);
      } catch (_) {
      }
      return validateAsync2(inst, value);
    },
    vendor: "zod",
    version: 1
  };
}
function canParseURL(input) {
  try {
    if (typeof URL !== "undefined" && typeof URL.canParse === "function")
      return URL.canParse(input);
    new URL(input);
    return true;
  } catch {
    return false;
  }
}
function validateURL(trimmed, def3) {
  if (!("normalize" in def3) && !("hostname" in def3) && !("protocol" in def3)) {
    return canParseURL(trimmed) || URL_UNPARSEABLE;
  }
  return parseURLObject(trimmed, def3);
}
function parseURLObject(trimmed, def3) {
  if (!def3.normalize && def3.protocol?.source === httpProtocol.source && !/^https?:\/\//i.test(trimmed)) {
    return URL_BAD_FORMAT;
  }
  try {
    if (typeof URL !== "undefined") {
      const URLStatic = URL;
      if (typeof URLStatic.parse === "function")
        return URLStatic.parse(trimmed) ?? URL_UNPARSEABLE;
    }
    return new URL(trimmed);
  } catch {
    return URL_UNPARSEABLE;
  }
}
function stripTabAndNewline(value) {
  return value.replace(asciiTabOrNewline, "");
}
function urlHostnameOk(url, hostname) {
  hostname.lastIndex = 0;
  return hostname.test(url.hostname);
}
function urlProtocolOk(url, protocol) {
  protocol.lastIndex = 0;
  return protocol.test(url.protocol.endsWith(":") ? url.protocol.slice(0, -1) : url.protocol);
}
function isValidIPv6(value) {
  if (!ipv6Alphabet.test(value))
    return false;
  return canParseURL(`http://[${value}]`);
}
function isValidCIDRv6(value) {
  const parts = value.split("/");
  if (parts.length !== 2)
    return false;
  const [address, prefix] = parts;
  if (!prefix)
    return false;
  const prefixNum = Number(prefix);
  if (`${prefixNum}` !== prefix)
    return false;
  if (prefixNum < 0 || prefixNum > 128)
    return false;
  return isValidIPv6(address);
}
function isValidBase64(data) {
  if (data === "")
    return true;
  if (/\s/.test(data))
    return false;
  if (data.length % 4 !== 0)
    return false;
  try {
    atob(data);
    return true;
  } catch {
    return false;
  }
}
function isValidBase64URL(data) {
  if (!base64urlCharset.test(data))
    return false;
  const base642 = data.replace(/[-_]/g, (c) => c === "-" ? "+" : "/");
  const padded = base642.padEnd(Math.ceil(base642.length / 4) * 4, "=");
  return isValidBase64(padded);
}
function isValidJWT(token, algorithm = null) {
  try {
    const tokensParts = token.split(".");
    if (tokensParts.length !== 3)
      return false;
    const [header] = tokensParts;
    if (!header)
      return false;
    const parsedHeader = JSON.parse(atob(header));
    if ("typ" in parsedHeader && parsedHeader?.typ !== "JWT")
      return false;
    if (!parsedHeader.alg)
      return false;
    if (algorithm && (!("alg" in parsedHeader) || parsedHeader.alg !== algorithm))
      return false;
    return true;
  } catch {
    return false;
  }
}
function capSize(inst, size) {
  const caps = sizeCaps(inst._zod.def.checks);
  if (!caps.length)
    return;
  const cap = Math.min(...caps.map((c) => c[0]));
  const parse4 = inst._zod.parse;
  inst._zod.parse = (payload, ctx) => {
    const n = size(payload.value);
    if (n > cap && !ctx?.skipChecks && ctx?.direction !== "backward") {
      for (const [max, ch] of sizeCaps(inst._zod.def.checks)) {
        if (n > max && ch._zod.def.when(payload)) {
          const start = payload.issues.length;
          ch._zod.check(payload);
          payload.issues[start].continue = false;
          attachSchema(payload.issues, start, inst);
          return payload;
        }
      }
    }
    return parse4(payload, ctx);
  };
}
function handleArrayResult(result, final, index) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(index, result.issues));
  }
  final.value[index] = result.value;
}
function handlePropertyResult(result, final, key, input, optin, optout) {
  const isPresent = key in input;
  const isOptionalOut = optout === "optional";
  if (!isPresent && isOptionalOut && optin === "optional") {
    return;
  }
  if (result.issues.length) {
    if (optin !== void 0 && isOptionalOut && !isPresent) {
      return;
    }
    final.issues.push(...prefixIssues(key, result.issues));
  }
  if (!isPresent && optin === void 0) {
    if (!result.issues.length) {
      final.issues.push({
        code: "invalid_type",
        expected: "nonoptional",
        input: void 0,
        path: [key]
      });
    }
    return;
  }
  if (result.value === void 0) {
    if (isPresent || optin === "defaulted" && !isOptionalOut) {
      final.value[key] = void 0;
    }
  } else {
    final.value[key] = result.value;
  }
}
function normalizeDef(def3) {
  const keys = Object.keys(def3.shape);
  const ownSymbols = Object.getOwnPropertySymbols(def3.shape);
  const symbolKeys = ownSymbols.length ? ownSymbols : NO_SYMBOL_KEYS;
  const allKeys = symbolKeys.length ? [...keys, ...symbolKeys] : keys;
  for (const k of allKeys) {
    if (!def3.shape?.[k]?._zod?.traits?.has("$ZodType")) {
      throw new Error(`Invalid element at key "${String(k)}": expected a Zod schema`);
    }
  }
  const okeys = optionalKeys(def3.shape);
  return {
    ...def3,
    allKeys,
    symbolKeys,
    // string-only: handleCatchall matches it against `for...in`, which never yields a symbol
    keySet: new Set(keys),
    numKeys: keys.length,
    optionalKeys: new Set(okeys)
  };
}
function handleCatchall(proms, input, payload, ctx, def3, inst, abortEarly) {
  const unrecognized = [];
  const keySet = def3.keySet;
  const _catchall = def3.catchall._zod;
  const t = _catchall.def.type;
  const optin = _catchall.optin;
  const optout = _catchall.optout;
  let seen = 0;
  for (const key in input) {
    if (abortEarly && payload.issues.length !== seen) {
      if (aborted(payload, seen))
        break;
      seen = payload.issues.length;
    }
    if (keySet.has(key))
      continue;
    if (key === "__proto__") {
      if (t === "never")
        unrecognized.push(key);
      continue;
    }
    if (t === "never") {
      unrecognized.push(key);
      continue;
    }
    const r = _catchall.run({ value: input[key], issues: [] }, ctx);
    if (r instanceof Promise) {
      proms.push(r.then((r2) => handlePropertyResult(r2, payload, key, input, optin, optout)));
    } else {
      handlePropertyResult(r, payload, key, input, optin, optout);
    }
  }
  if (unrecognized.length) {
    payload.issues.push({
      code: "unrecognized_keys",
      keys: unrecognized,
      input,
      inst,
      // Describes the shape of the input, not the validity of the parsed value, so it never aborts. The parse still fails; the schema's own checks just get to run first, and an enclosing intersection can reconcile the key against a sibling operand.
      continue: true
    });
  }
  if (!proms.length)
    return payload;
  return Promise.all(proms).then(() => {
    return payload;
  });
}
function handleUnionResults(results, final, inst, ctx) {
  for (const result of results) {
    if (result.issues.length === 0) {
      final.value = result.value;
      return final;
    }
  }
  const nonaborted = results.filter((r) => !aborted(r));
  if (nonaborted.length === 1) {
    final.value = nonaborted[0].value;
    return nonaborted[0];
  }
  final.issues.push({
    code: "invalid_union",
    input: final.value,
    inst,
    errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  });
  return final;
}
function discriminatorMap(def3) {
  const map = /* @__PURE__ */ new Map();
  for (const option of def3.options) {
    const values = option._zod.propValues?.[def3.discriminator];
    if (!values || values.size === 0)
      throw new Error(`Invalid discriminated union option at index "${def3.options.indexOf(option)}"`);
    for (const value of values) {
      if (map.has(value)) {
        if (value !== void 0)
          throw new Error(`Duplicate discriminator value "${String(value)}"`);
        map.set(value, null);
      } else {
        map.set(value, option);
      }
    }
  }
  return map;
}
function mergeValues(a, b) {
  if (a === b) {
    return { valid: true, data: a };
  }
  if (a instanceof Date && b instanceof Date && +a === +b) {
    return { valid: true, data: a };
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const bKeys = Object.keys(b);
    const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    if (Object.prototype.hasOwnProperty.call(newObj, "__proto__"))
      delete newObj.__proto__;
    for (const key of sharedKeys) {
      if (key === "__proto__")
        continue;
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [key, ...sharedValue.mergeErrorPath]
        };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return { valid: false, mergeErrorPath: [] };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [index, ...sharedValue.mergeErrorPath]
        };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  }
  return { valid: false, mergeErrorPath: [] };
}
function handleIntersectionResults(result, left, right) {
  const unrecKeys = /* @__PURE__ */ new Map();
  let unrecIssue;
  const keyIssues = /* @__PURE__ */ new Map();
  const collect = (iss, side) => {
    let keys;
    if (iss.code === "unrecognized_keys" && !iss.path?.length) {
      unrecIssue ?? (unrecIssue = iss);
      keys = iss.keys;
    } else if (iss.code === "invalid_key" && iss.origin === "record" && iss.path?.length === 1) {
      const k = String(iss.path[0]);
      if (!keyIssues.has(k))
        keyIssues.set(k, iss);
      keys = [k];
    } else {
      return false;
    }
    for (const k of keys) {
      if (!unrecKeys.has(k))
        unrecKeys.set(k, {});
      unrecKeys.get(k)[side] = true;
    }
    return true;
  };
  for (const iss of left.issues) {
    if (!collect(iss, "l"))
      result.issues.push(iss);
  }
  for (const iss of right.issues) {
    if (!collect(iss, "r"))
      result.issues.push(iss);
  }
  const bothKeys = [...unrecKeys].filter(([, f]) => f.l && f.r).map(([k]) => k);
  if (bothKeys.length) {
    const aggregated = unrecIssue ? bothKeys.filter((k) => unrecIssue.keys.includes(k)) : [];
    if (aggregated.length)
      result.issues.push({ ...unrecIssue, keys: aggregated });
    for (const k of bothKeys) {
      if (!aggregated.includes(k) && keyIssues.has(k))
        result.issues.push(keyIssues.get(k));
    }
  }
  const merged = mergeValues(left.value, right.value);
  if (!merged.valid) {
    if (aborted(result))
      return result;
    throw new Error(`Unmergable intersection. Error path: ${JSON.stringify(merged.mergeErrorPath)}`);
  }
  result.value = merged.data;
  return result;
}
function handleOptionalResult(payload, result) {
  payload.value = result.issues.length ? void 0 : result.value;
  return payload;
}
function handleDefaultResult(payload, def3) {
  if (payload.value === void 0) {
    payload.value = def3.defaultValue;
  }
  return payload;
}
function handleNonOptionalResult(payload, inst) {
  if (!payload.issues.length && payload.value === void 0) {
    payload.issues.push({
      code: "invalid_type",
      expected: "nonoptional",
      input: payload.value,
      inst
    });
  }
  return payload;
}
function handleCatchResult(payload, result, def3, ctx) {
  if (!result.issues.length) {
    payload.value = result.value;
    if (result.memo)
      payload.memo = true;
    return payload;
  }
  payload.value = def3.catchValue({
    ...result,
    value: payload.value,
    error: {
      issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config()))
    },
    input: payload.value
  });
  return payload;
}
function handlePipeResult(left, next, ctx) {
  if (left.issues.some((iss) => iss.code !== "unrecognized_keys")) {
    left.aborted = true;
    return left;
  }
  return next._zod.run({ value: left.value, issues: left.issues }, ctx);
}
function handleReadonlyResult(payload) {
  if (!payload.memo)
    payload.value = Object.freeze(payload.value);
  return payload;
}
function handleRefineResult(result, payload, input, inst) {
  if (!result) {
    const _iss = {
      code: "custom",
      input,
      inst,
      // incorporates params.error into issue reporting
      path: [...inst._zod.def.path ?? []],
      // incorporates params.error into issue reporting
      continue: !inst._zod.def.abort
      // params: inst._zod.def.params,
    };
    if (inst._zod.def.params)
      _iss.params = inst._zod.def.params;
    payload.issues.push(issue(_iss));
  }
}
var $ZodType, toStandardResult, $ZodString, $ZodStringFormat, $ZodGUID, $ZodUUID, $ZodEmail, URL_BAD_FORMAT, URL_UNPARSEABLE, asciiTabOrNewline, $ZodURL, $ZodEmoji, $ZodNanoID, $ZodCUID, $ZodCUID2, $ZodULID, $ZodXID, $ZodKSUID, $ZodISODateTime, $ZodISODate, $ZodISOTime, $ZodISODuration, $ZodIPv4, ipv6Alphabet, $ZodIPv6, $ZodCIDRv4, $ZodCIDRv6, base64Charset, $ZodBase64, base64urlCharset, $ZodBase64URL, $ZodE164, $ZodJWT, $ZodNumber, $ZodNumberFormat, $ZodBoolean, $ZodNull, $ZodUnknown, $ZodNever, arraySize, $ZodArray, NO_SYMBOL_KEYS, $ZodObject, $ZodObjectJIT, $ZodUnion, $ZodDiscriminatedUnion, $ZodIntersection, $ZodRecord, $ZodEnum, $ZodLiteral, $ZodTransform, $ZodOptional, $ZodExactOptional, $ZodNullable, $ZodDefault, $ZodPrefault, $ZodNonOptional, $ZodCatch, $ZodPipe, $ZodPreprocess, $ZodReadonly, $ZodCustom;
var init_schemas = __esm({
  "node_modules/zod/v4/core/schemas.js"() {
    init_checks();
    init_core();
    init_doc();
    init_regexes();
    init_util();
    init_versions();
    init_util();
    $ZodType = /* @__PURE__ */ $constructor("$ZodType", (inst, def3) => {
      var _a3;
      inst ?? (inst = {});
      inst._zod.def = def3;
      inst._zod.bag = inst._zod.bag || {};
      inst._zod.version = version;
      const defChecks = inst._zod.def.checks;
      const checks = inst._zod.traits.has("$ZodCheck") ? [inst, ...defChecks ?? []] : defChecks?.length ? [...defChecks] : [];
      for (const ch of checks) {
        for (const fn of ch._zod.onattach) {
          fn(inst);
        }
      }
      if (checks.length === 0) {
        (_a3 = inst._zod).deferred ?? (_a3.deferred = []);
        inst._zod.deferred?.push(() => {
          inst._zod.run = inst._zod.parse;
        });
      } else {
        const runChecks = (payload, checks2, ctx) => {
          if (payload.memo)
            return payload;
          let isAborted = aborted(payload);
          let asyncResult;
          for (const ch of checks2) {
            if (ch._zod.def.when) {
              if (explicitlyAborted(payload))
                continue;
              const shouldRun = ch._zod.def.when(payload);
              if (!shouldRun)
                continue;
            } else if (isAborted) {
              continue;
            }
            const currLen = payload.issues.length;
            const _ = ch._zod.check(payload);
            if (_ instanceof Promise && ctx?.async === false) {
              throw new $ZodAsyncError();
            }
            if (asyncResult || _ instanceof Promise) {
              asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
                await _;
                const nextLen = payload.issues.length;
                if (nextLen === currLen)
                  return;
                attachSchema(payload.issues, currLen, inst);
                if (!isAborted)
                  isAborted = aborted(payload, currLen);
              });
            } else {
              const nextLen = payload.issues.length;
              if (nextLen === currLen)
                continue;
              attachSchema(payload.issues, currLen, inst);
              if (!isAborted)
                isAborted = aborted(payload, currLen);
            }
          }
          if (asyncResult) {
            return asyncResult.then(() => {
              return payload;
            });
          }
          return payload;
        };
        const handleCanaryResult = (canary, payload, ctx) => {
          if (aborted(canary)) {
            canary.aborted = true;
            return canary;
          }
          const checkResult = runChecks(payload, checks, ctx);
          if (checkResult instanceof Promise) {
            if (ctx.async === false)
              throw new $ZodAsyncError();
            return checkResult.then((checkResult2) => inst._zod.parse(checkResult2, ctx));
          }
          return inst._zod.parse(checkResult, ctx);
        };
        inst._zod.run = (payload, ctx) => {
          if (ctx.skipChecks) {
            return inst._zod.parse(payload, ctx);
          }
          if (ctx.direction === "backward") {
            const canary = inst._zod.parse({ value: payload.value, issues: [] }, { ...ctx, skipChecks: true });
            if (canary instanceof Promise) {
              return canary.then((canary2) => {
                return handleCanaryResult(canary2, payload, ctx);
              });
            }
            return handleCanaryResult(canary, payload, ctx);
          }
          const result = inst._zod.parse(payload, ctx);
          if (result instanceof Promise) {
            if (ctx.async === false)
              throw new $ZodAsyncError();
            return result.then((result2) => runChecks(result2, checks, ctx));
          }
          return runChecks(result, checks, ctx);
        };
      }
    }, {
      // Wrappers extend this by installing a richer factory over it; reading it eagerly would defeat the laziness.
      get "~standard"() {
        return hide(this, "~standard", standardProps(this));
      },
      set "~standard"(value) {
        own(this, "~standard", value);
      }
    });
    toStandardResult = (r, ctx) => r.issues.length ? { issues: r.issues.map((iss) => finalizeIssue(iss, ctx, config())) } : { value: r.value };
    $ZodString = /* @__PURE__ */ $constructor("$ZodString", (inst, def3) => {
      $ZodType.init(inst, def3);
      inst._zod.pattern = def3.pattern ?? anyString;
      inst._zod.parse = (payload, _) => {
        if (def3.coerce)
          try {
            payload.value = String(payload.value);
          } catch (_2) {
          }
        if (typeof payload.value === "string")
          return payload;
        payload.issues.push({
          expected: "string",
          code: "invalid_type",
          input: payload.value,
          inst
        });
        return payload;
      };
    });
    $ZodStringFormat = /* @__PURE__ */ $constructor("$ZodStringFormat", (inst, def3) => {
      $ZodCheckStringFormat.init(inst, def3);
      $ZodString.init(inst, def3);
    });
    $ZodGUID = /* @__PURE__ */ $constructor("$ZodGUID", (inst, def3) => {
      def3.pattern ?? (def3.pattern = guid);
      $ZodStringFormat.init(inst, def3);
    });
    $ZodUUID = /* @__PURE__ */ $constructor("$ZodUUID", (inst, def3) => {
      if (def3.version) {
        const versionMap = {
          v1: 1,
          v2: 2,
          v3: 3,
          v4: 4,
          v5: 5,
          v6: 6,
          v7: 7,
          v8: 8
        };
        const v = versionMap[def3.version];
        if (v === void 0)
          throw new Error(`Invalid UUID version: "${def3.version}"`);
        def3.pattern ?? (def3.pattern = uuid(v));
      } else
        def3.pattern ?? (def3.pattern = uuid());
      $ZodStringFormat.init(inst, def3);
    });
    $ZodEmail = /* @__PURE__ */ $constructor("$ZodEmail", (inst, def3) => {
      def3.pattern ?? (def3.pattern = email);
      $ZodStringFormat.init(inst, def3);
    });
    URL_BAD_FORMAT = 1;
    URL_UNPARSEABLE = 2;
    asciiTabOrNewline = /[\t\n\r]/g;
    $ZodURL = /* @__PURE__ */ $constructor("$ZodURL", (inst, def3) => {
      $ZodStringFormat.init(inst, def3);
      inst._zod.check = (payload) => {
        try {
          const trimmed = payload.value.trim();
          const url = validateURL(trimmed, def3);
          if (url === URL_BAD_FORMAT) {
            payload.issues.push({
              code: "invalid_format",
              format: "url",
              note: "Invalid URL format",
              input: payload.value,
              inst,
              continue: !def3.abort
            });
            return;
          }
          if (url === URL_UNPARSEABLE) {
            payload.issues.push({
              code: "invalid_format",
              format: "url",
              input: payload.value,
              inst,
              continue: !def3.abort
            });
            return;
          }
          if (url === true) {
            payload.value = stripTabAndNewline(trimmed);
            return;
          }
          if (def3.hostname && !urlHostnameOk(url, def3.hostname)) {
            payload.issues.push({
              code: "invalid_format",
              format: "url",
              note: "Invalid hostname",
              pattern: def3.hostname.source,
              input: payload.value,
              inst,
              continue: !def3.abort
            });
          }
          if (def3.protocol && !urlProtocolOk(url, def3.protocol)) {
            payload.issues.push({
              code: "invalid_format",
              format: "url",
              note: "Invalid protocol",
              pattern: def3.protocol.source,
              input: payload.value,
              inst,
              continue: !def3.abort
            });
          }
          payload.value = def3.normalize ? url.href : stripTabAndNewline(trimmed);
          return;
        } catch (_) {
          payload.issues.push({
            code: "invalid_format",
            format: "url",
            input: payload.value,
            inst,
            continue: !def3.abort
          });
        }
      };
    });
    $ZodEmoji = /* @__PURE__ */ $constructor("$ZodEmoji", (inst, def3) => {
      def3.pattern ?? (def3.pattern = emoji());
      $ZodStringFormat.init(inst, def3);
    });
    $ZodNanoID = /* @__PURE__ */ $constructor("$ZodNanoID", (inst, def3) => {
      if (def3.length !== void 0 && (!Number.isInteger(def3.length) || def3.length < 1))
        throw new Error(`Invalid nanoid length: ${def3.length}`);
      def3.pattern ?? (def3.pattern = def3.length === void 0 ? nanoid : nanoidOfLength(def3.length));
      $ZodStringFormat.init(inst, def3);
    });
    $ZodCUID = /* @__PURE__ */ $constructor("$ZodCUID", (inst, def3) => {
      def3.pattern ?? (def3.pattern = cuid);
      $ZodStringFormat.init(inst, def3);
    });
    $ZodCUID2 = /* @__PURE__ */ $constructor("$ZodCUID2", (inst, def3) => {
      def3.pattern ?? (def3.pattern = cuid2);
      $ZodStringFormat.init(inst, def3);
    });
    $ZodULID = /* @__PURE__ */ $constructor("$ZodULID", (inst, def3) => {
      def3.pattern ?? (def3.pattern = ulid);
      $ZodStringFormat.init(inst, def3);
    });
    $ZodXID = /* @__PURE__ */ $constructor("$ZodXID", (inst, def3) => {
      def3.pattern ?? (def3.pattern = xid);
      $ZodStringFormat.init(inst, def3);
    });
    $ZodKSUID = /* @__PURE__ */ $constructor("$ZodKSUID", (inst, def3) => {
      def3.pattern ?? (def3.pattern = ksuid);
      $ZodStringFormat.init(inst, def3);
    });
    $ZodISODateTime = /* @__PURE__ */ $constructor("$ZodISODateTime", (inst, def3) => {
      def3.pattern ?? (def3.pattern = datetime(def3));
      $ZodStringFormat.init(inst, def3);
    });
    $ZodISODate = /* @__PURE__ */ $constructor("$ZodISODate", (inst, def3) => {
      def3.pattern ?? (def3.pattern = date);
      $ZodStringFormat.init(inst, def3);
    });
    $ZodISOTime = /* @__PURE__ */ $constructor("$ZodISOTime", (inst, def3) => {
      def3.pattern ?? (def3.pattern = time(def3));
      $ZodStringFormat.init(inst, def3);
    });
    $ZodISODuration = /* @__PURE__ */ $constructor("$ZodISODuration", (inst, def3) => {
      def3.pattern ?? (def3.pattern = duration);
      $ZodStringFormat.init(inst, def3);
    });
    $ZodIPv4 = /* @__PURE__ */ $constructor("$ZodIPv4", (inst, def3) => {
      def3.pattern ?? (def3.pattern = ipv4);
      $ZodStringFormat.init(inst, def3);
    });
    ipv6Alphabet = /^[0-9a-fA-F:.]+$/;
    $ZodIPv6 = /* @__PURE__ */ $constructor("$ZodIPv6", (inst, def3) => {
      def3.pattern ?? (def3.pattern = ipv6);
      $ZodStringFormat.init(inst, def3);
      inst._zod.check = (payload) => {
        if (!isValidIPv6(payload.value)) {
          payload.issues.push({
            code: "invalid_format",
            format: "ipv6",
            input: payload.value,
            inst,
            continue: !def3.abort
          });
        }
      };
    });
    $ZodCIDRv4 = /* @__PURE__ */ $constructor("$ZodCIDRv4", (inst, def3) => {
      def3.pattern ?? (def3.pattern = cidrv4);
      $ZodStringFormat.init(inst, def3);
    });
    $ZodCIDRv6 = /* @__PURE__ */ $constructor("$ZodCIDRv6", (inst, def3) => {
      def3.pattern ?? (def3.pattern = cidrv6);
      $ZodStringFormat.init(inst, def3);
      inst._zod.check = (payload) => {
        if (!isValidCIDRv6(payload.value)) {
          payload.issues.push({
            code: "invalid_format",
            format: "cidrv6",
            input: payload.value,
            inst,
            continue: !def3.abort
          });
        }
      };
    });
    base64Charset = /^[0-9a-zA-Z+/]*={0,2}$/;
    $ZodBase64 = /* @__PURE__ */ $constructor("$ZodBase64", (inst, def3) => {
      def3.pattern ?? (def3.pattern = base64Charset);
      $ZodStringFormat.init(inst, def3);
      inst._zod.check = (payload) => {
        if (isValidBase64(payload.value))
          return;
        payload.issues.push({
          code: "invalid_format",
          format: "base64",
          input: payload.value,
          inst,
          continue: !def3.abort
        });
      };
    });
    base64urlCharset = /^[A-Za-z0-9_-]*$/;
    $ZodBase64URL = /* @__PURE__ */ $constructor("$ZodBase64URL", (inst, def3) => {
      def3.pattern ?? (def3.pattern = base64urlCharset);
      $ZodStringFormat.init(inst, def3);
      inst._zod.check = (payload) => {
        if (isValidBase64URL(payload.value))
          return;
        payload.issues.push({
          code: "invalid_format",
          format: "base64url",
          input: payload.value,
          inst,
          continue: !def3.abort
        });
      };
    });
    $ZodE164 = /* @__PURE__ */ $constructor("$ZodE164", (inst, def3) => {
      def3.pattern ?? (def3.pattern = e164);
      $ZodStringFormat.init(inst, def3);
    });
    $ZodJWT = /* @__PURE__ */ $constructor("$ZodJWT", (inst, def3) => {
      $ZodStringFormat.init(inst, def3);
      inst._zod.check = (payload) => {
        if (isValidJWT(payload.value, def3.alg))
          return;
        payload.issues.push({
          code: "invalid_format",
          format: "jwt",
          input: payload.value,
          inst,
          continue: !def3.abort
        });
      };
    });
    $ZodNumber = /* @__PURE__ */ $constructor("$ZodNumber", (inst, def3) => {
      $ZodType.init(inst, def3);
      inst._zod.pattern = number;
      inst._zod.parse = (payload, _ctx) => {
        if (def3.coerce)
          try {
            payload.value = Number(payload.value);
          } catch (_) {
          }
        const input = payload.value;
        if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) {
          return payload;
        }
        const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? String(input) : void 0 : void 0;
        payload.issues.push({
          expected: "number",
          code: "invalid_type",
          input,
          inst,
          ...received ? { received } : {}
        });
        return payload;
      };
    });
    $ZodNumberFormat = /* @__PURE__ */ $constructor("$ZodNumberFormat", (inst, def3) => {
      $ZodCheckNumberFormat.init(inst, def3);
      $ZodNumber.init(inst, def3);
    });
    $ZodBoolean = /* @__PURE__ */ $constructor("$ZodBoolean", (inst, def3) => {
      $ZodType.init(inst, def3);
      inst._zod.pattern = boolean;
      inst._zod.parse = (payload, _ctx) => {
        if (def3.coerce)
          try {
            payload.value = Boolean(payload.value);
          } catch (_) {
          }
        const input = payload.value;
        if (typeof input === "boolean")
          return payload;
        payload.issues.push({
          expected: "boolean",
          code: "invalid_type",
          input,
          inst
        });
        return payload;
      };
    });
    $ZodNull = /* @__PURE__ */ $constructor("$ZodNull", (inst, def3) => {
      $ZodType.init(inst, def3);
      inst._zod.pattern = _null;
      inst._zod.values = /* @__PURE__ */ new Set([null]);
      inst._zod.parse = (payload, _ctx) => {
        const input = payload.value;
        if (input === null)
          return payload;
        payload.issues.push({
          expected: "null",
          code: "invalid_type",
          input,
          inst
        });
        return payload;
      };
    });
    $ZodUnknown = /* @__PURE__ */ $constructor("$ZodUnknown", (inst, def3) => {
      $ZodType.init(inst, def3);
      inst._zod.parse = (payload) => payload;
    });
    $ZodNever = /* @__PURE__ */ $constructor("$ZodNever", (inst, def3) => {
      $ZodType.init(inst, def3);
      inst._zod.parse = (payload, _ctx) => {
        payload.issues.push({
          expected: "never",
          code: "invalid_type",
          input: payload.value,
          inst
        });
        return payload;
      };
    });
    arraySize = (input) => Array.isArray(input) ? input.length : -1;
    $ZodArray = /* @__PURE__ */ $constructor("$ZodArray", (inst, def3) => {
      $ZodType.init(inst, def3);
      const memo2 = globalConfig.memoizer;
      memo2?.attach(inst);
      inst._zod.parse = (payload, ctx) => {
        const input = payload.value;
        if (!Array.isArray(input)) {
          payload.issues.push({
            expected: "array",
            code: "invalid_type",
            input,
            inst
          });
          return payload;
        }
        payload.value = memo2 ? memo2.alloc(inst, payload, Array(input.length), ctx) : Array(input.length);
        const proms = [];
        const abortEarly = ctx?.abortEarly;
        for (let i = 0; i < input.length; i++) {
          const item = input[i];
          const result = def3.element._zod.run({
            value: item,
            issues: []
          }, ctx);
          if (result instanceof Promise) {
            proms.push(result.then((result2) => handleArrayResult(result2, payload, i)));
          } else {
            handleArrayResult(result, payload, i);
            if (abortEarly && result.issues.length !== 0 && aborted(result))
              break;
          }
        }
        if (proms.length) {
          return Promise.all(proms).then(() => payload);
        }
        return payload;
      };
      capSize(inst, arraySize);
    });
    NO_SYMBOL_KEYS = [];
    $ZodObject = /* @__PURE__ */ $constructor("$ZodObject", (inst, def3) => {
      $ZodType.init(inst, def3);
      const desc = Object.getOwnPropertyDescriptor(def3, "shape");
      const sh = desc?.get ? desc.get.raw : def3.shape ?? {};
      if (sh) {
        const get = () => {
          const newSh = { ...sh };
          Object.defineProperty(def3, "shape", { value: newSh });
          get.raw = newSh;
          return newSh;
        };
        get.raw = sh;
        Object.defineProperty(def3, "shape", { get });
      }
      const _normalized = cached(() => normalizeDef(def3));
      defineLazyInternal(inst, "propValues", (zod) => {
        const shape = zod.def.shape;
        const propValues = {};
        for (const key in shape) {
          const field = shape[key]._zod;
          if (field.values) {
            if (!Object.prototype.hasOwnProperty.call(propValues, key)) {
              assignProp(propValues, key, /* @__PURE__ */ new Set());
            }
            for (const v of field.values)
              propValues[key].add(v);
            if (field.optin !== void 0)
              propValues[key].add(void 0);
          }
        }
        return propValues;
      });
      const isObject2 = isObject;
      const catchall = def3.catchall;
      let value;
      const memo2 = globalConfig.memoizer;
      memo2?.attach(inst);
      inst._zod.parse = (payload, ctx) => {
        value ?? (value = _normalized.value);
        const input = payload.value;
        if (!isObject2(input)) {
          payload.issues.push({
            expected: "object",
            code: "invalid_type",
            input,
            inst
          });
          return payload;
        }
        payload.value = memo2 ? memo2.alloc(inst, payload, {}, ctx) : {};
        const proms = [];
        const shape = value.shape;
        const abortEarly = ctx?.abortEarly;
        let seen = payload.issues.length;
        for (const key of value.allKeys) {
          if (abortEarly && payload.issues.length !== seen) {
            if (aborted(payload, seen))
              break;
            seen = payload.issues.length;
          }
          if (key === "__proto__")
            continue;
          const el = shape[key];
          const optin = el._zod.optin;
          const optout = el._zod.optout;
          const r = el._zod.run({ value: input[key], issues: [] }, ctx);
          if (r instanceof Promise) {
            proms.push(r.then((r2) => handlePropertyResult(r2, payload, key, input, optin, optout)));
          } else {
            handlePropertyResult(r, payload, key, input, optin, optout);
          }
        }
        if (!catchall) {
          return proms.length ? Promise.all(proms).then(() => payload) : payload;
        }
        return handleCatchall(proms, input, payload, ctx, _normalized.value, inst, abortEarly === true);
      };
    });
    $ZodObjectJIT = /* @__PURE__ */ $constructor("$ZodObjectJIT", (inst, def3) => {
      $ZodObject.init(inst, def3);
      const superParse = inst._zod.parse;
      const _normalized = cached(() => normalizeDef(def3));
      const memo2 = globalConfig.memoizer;
      const generateFastpass = (shape) => {
        const normalized = _normalized.value;
        const syms = normalized.symbolKeys;
        const doc = new Doc(["payload", "ctx"], { shape, inst, memo: memo2, syms });
        const parseStr = (k) => `shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx)`;
        const prefixStr = (id, k) => `
          let ${id}_ab = false;
          for (let i = 0; i < ${id}.issues.length; i++) {
            const iss = ${id}.issues[i];
            iss.path = iss.path ? [${k}, ...iss.path] : [${k}];
            payload.issues.push(iss);
            if (iss.continue !== true) ${id}_ab = true;
          }
          if (${id}_ab && ctx && ctx.abortEarly) {
            payload.value = newResult;
            return payload;
          }`;
        doc.write(`const input = payload.value;`);
        const ids = /* @__PURE__ */ Object.create(null);
        let counter = 0;
        for (const key of normalized.allKeys) {
          ids[key] = `key_${counter++}`;
        }
        doc.write(memo2 ? `const newResult = memo.alloc(inst, payload, {}, ctx);` : `const newResult = {};`);
        for (const key of normalized.allKeys) {
          if (key === "__proto__")
            continue;
          const id = ids[key];
          const k = typeof key === "symbol" ? `syms[${syms.indexOf(key)}]` : esc(key);
          const isPresent = `${k} in input`;
          const schema = shape[key];
          const optin = schema?._zod?.optin;
          const isOptionalIn = optin !== void 0;
          const isOptionalOut = schema?._zod?.optout === "optional";
          doc.write(`const ${id} = ${parseStr(k)};`);
          if (isOptionalIn && isOptionalOut) {
            const assign = optin === "optional" ? `${id}_present` : `${id}.value !== undefined || ${id}_present`;
            doc.write(`
        const ${id}_present = ${isPresent};
        if (!${id}.issues.length || ${id}_present) {
          if (${id}.issues.length) {${prefixStr(id, k)}
          }

          if (${assign}) {
            newResult[${k}] = ${id}.value;
          }
        }

      `);
          } else if (!isOptionalIn) {
            doc.write(`
        const ${id}_present = ${isPresent};
        if (${id}.issues.length) {${prefixStr(id, k)}
        }
        if (!${id}_present && !${id}.issues.length) {
          payload.issues.push({
            code: "invalid_type",
            expected: "nonoptional",
            input: undefined,
            path: [${k}]
          });
          if (ctx && ctx.abortEarly) {
            payload.value = newResult;
            return payload;
          }
        }

        if (${id}_present) {
          newResult[${k}] = ${id}.value;
        }

      `);
          } else {
            doc.write(`
        if (${id}.issues.length) {${prefixStr(id, k)}
        }
      `);
            if (optin === "defaulted") {
              doc.write(`newResult[${k}] = ${id}.value;`);
            } else {
              doc.write(`
        if (${id}.value !== undefined || ${isPresent}) {
          newResult[${k}] = ${id}.value;
        }
      `);
            }
          }
        }
        doc.write(`payload.value = newResult;`);
        doc.write(`return payload;`);
        return doc.compile();
      };
      let fastpass;
      const isObject2 = isObject;
      const jit = !globalConfig.jitless;
      const allowsEval2 = allowsEval;
      const fastEnabled = jit && allowsEval2.value;
      const catchall = def3.catchall;
      let value;
      inst._zod.parse = (payload, ctx) => {
        value ?? (value = _normalized.value);
        const input = payload.value;
        if (!isObject2(input)) {
          payload.issues.push({
            expected: "object",
            code: "invalid_type",
            input,
            inst
          });
          return payload;
        }
        if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
          if (!fastpass)
            fastpass = generateFastpass(def3.shape);
          payload = fastpass(payload, ctx);
          if (!catchall)
            return payload;
          return handleCatchall([], input, payload, ctx, value, inst, ctx?.abortEarly === true);
        }
        return superParse(payload, ctx);
      };
    });
    $ZodUnion = /* @__PURE__ */ $constructor("$ZodUnion", (inst, def3) => {
      $ZodType.init(inst, def3);
      defineLazyInternal(inst, "optin", (zod) => zod.def.options.some((o) => o._zod.optin === "defaulted") ? "defaulted" : zod.def.options.some((o) => o._zod.optin !== void 0) ? "optional" : void 0);
      defineLazyInternal(inst, "optout", (zod) => zod.def.options.some((o) => o._zod.optout === "optional") ? "optional" : void 0);
      defineLazyInternal(inst, "values", (zod) => {
        if (zod.def.options.every((o) => o._zod.values)) {
          return new Set(zod.def.options.flatMap((option) => Array.from(option._zod.values)));
        }
        return void 0;
      });
      defineLazyInternal(inst, "pattern", (zod) => {
        if (zod.def.options.every((o) => o._zod.pattern)) {
          const patterns = zod.def.options.map((o) => o._zod.pattern);
          return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
        }
        return void 0;
      });
      const first = def3.options.length === 1 ? def3.options[0]._zod.run : null;
      inst._zod.parse = (payload, ctx) => {
        if (first) {
          return first(payload, ctx);
        }
        let async = false;
        const results = [];
        for (const option of def3.options) {
          const result = option._zod.run({
            value: payload.value,
            issues: []
          }, ctx);
          if (result instanceof Promise) {
            results.push(result);
            async = true;
          } else {
            if (result.issues.length === 0)
              return result;
            results.push(result);
          }
        }
        if (!async)
          return handleUnionResults(results, payload, inst, ctx);
        return Promise.all(results).then((results2) => {
          return handleUnionResults(results2, payload, inst, ctx);
        });
      };
    });
    $ZodDiscriminatedUnion = /* @__PURE__ */ $constructor("$ZodDiscriminatedUnion", (inst, def3) => {
      def3.inclusive = false;
      $ZodUnion.init(inst, def3);
      const _super = inst._zod.parse;
      defineLazyInternal(inst, "propValues", (zod) => {
        const propValues = {};
        let undefinedCount = 0;
        for (const option of zod.def.options) {
          const pv = option._zod.propValues;
          if (!pv || Object.keys(pv).length === 0)
            throw new Error(`Invalid discriminated union option at index "${zod.def.options.indexOf(option)}"`);
          if (pv[zod.def.discriminator]?.has(void 0))
            undefinedCount++;
          for (const [k, v] of Object.entries(pv)) {
            if (!Object.prototype.hasOwnProperty.call(propValues, k)) {
              assignProp(propValues, k, /* @__PURE__ */ new Set());
            }
            for (const val of v) {
              propValues[k].add(val);
            }
          }
        }
        if (!zod.def.unionFallback && undefinedCount > 1)
          propValues[zod.def.discriminator]?.delete(void 0);
        return propValues;
      });
      def3.options.forEach((option, i) => {
        const propShape = rawShape(option._zod.def);
        if (propShape && !Object.prototype.hasOwnProperty.call(propShape, def3.discriminator)) {
          throw new Error(`Invalid discriminated union option at index "${i}"`);
        }
      });
      const disc = cached(() => discriminatorMap(def3));
      inst._zod.parse = (payload, ctx) => {
        const input = payload.value;
        if (!isObject(input)) {
          payload.issues.push({
            code: "invalid_type",
            expected: "object",
            input,
            inst
          });
          return payload;
        }
        const value = input?.[def3.discriminator];
        const opt = disc.value.get(value);
        if (opt && (value !== void 0 || ctx.direction !== "backward")) {
          return opt._zod.run(payload, ctx);
        }
        if (def3.unionFallback || ctx.direction === "backward") {
          return _super(payload, ctx);
        }
        payload.issues.push({
          code: "invalid_union",
          errors: [],
          note: "No matching discriminator",
          discriminator: def3.discriminator,
          options: Array.from(disc.value.keys()).filter((value2) => disc.value.get(value2) !== null),
          input,
          path: [def3.discriminator],
          inst
        });
        return payload;
      };
    });
    $ZodIntersection = /* @__PURE__ */ $constructor("$ZodIntersection", (inst, def3) => {
      $ZodType.init(inst, def3);
      inst._zod.parse = (payload, ctx) => {
        const input = payload.value;
        const left = def3.left._zod.run({ value: input, issues: [] }, ctx);
        const right = def3.right._zod.run({ value: input, issues: [] }, ctx);
        const async = left instanceof Promise || right instanceof Promise;
        if (async) {
          return Promise.all([left, right]).then(([left2, right2]) => {
            return handleIntersectionResults(payload, left2, right2);
          });
        }
        return handleIntersectionResults(payload, left, right);
      };
    });
    $ZodRecord = /* @__PURE__ */ $constructor("$ZodRecord", (inst, def3) => {
      $ZodType.init(inst, def3);
      const memo2 = globalConfig.memoizer;
      memo2?.attach(inst);
      inst._zod.parse = (payload, ctx) => {
        const input = payload.value;
        if (!isPlainObject(input)) {
          payload.issues.push({
            expected: "record",
            code: "invalid_type",
            input,
            inst
          });
          return payload;
        }
        const proms = [];
        const values = def3.keyType._zod.values;
        if (values && !def3.partial) {
          payload.value = memo2 ? memo2.alloc(inst, payload, {}, ctx) : {};
          const recordKeys = /* @__PURE__ */ new Set();
          for (const key of values) {
            if (typeof key === "string" || typeof key === "number" || typeof key === "symbol") {
              recordKeys.add(typeof key === "number" ? key.toString() : key);
              if (key === "__proto__")
                continue;
              const keyResult = def3.keyType._zod.run({ value: key, issues: [] }, ctx);
              if (keyResult instanceof Promise) {
                throw new Error("Async schemas not supported in object keys currently");
              }
              if (keyResult.issues.length) {
                payload.issues.push({
                  code: "invalid_key",
                  origin: "record",
                  issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
                  input: key,
                  path: [key],
                  inst
                });
                continue;
              }
              const outKey = keyResult.value;
              if (outKey === "__proto__")
                continue;
              const result = def3.valueType._zod.run({ value: input[key], issues: [] }, ctx);
              if (result instanceof Promise) {
                proms.push(result.then((result2) => {
                  if (result2.issues.length) {
                    payload.issues.push(...prefixIssues(key, result2.issues));
                  }
                  payload.value[outKey] = result2.value;
                }));
              } else {
                if (result.issues.length) {
                  payload.issues.push(...prefixIssues(key, result.issues));
                }
                payload.value[outKey] = result.value;
              }
            }
          }
          let unrecognized;
          for (const key in input) {
            if (!recordKeys.has(key)) {
              if (def3.mode === "loose") {
                if (key === "__proto__")
                  continue;
                payload.value[key] = input[key];
              } else {
                unrecognized = unrecognized ?? [];
                unrecognized.push(key);
              }
            }
          }
          if (unrecognized && unrecognized.length > 0) {
            payload.issues.push({
              code: "unrecognized_keys",
              input,
              inst,
              keys: unrecognized,
              continue: true
            });
          }
        } else {
          payload.value = memo2 ? memo2.alloc(inst, payload, {}, ctx) : {};
          let unrecognized;
          for (const key of Reflect.ownKeys(input)) {
            if (key === "__proto__")
              continue;
            if (!Object.prototype.propertyIsEnumerable.call(input, key))
              continue;
            let keyResult = def3.keyType._zod.run({ value: key, issues: [] }, ctx);
            if (keyResult instanceof Promise) {
              throw new Error("Async schemas not supported in object keys currently");
            }
            const checkNumericKey = typeof key === "string" && number.test(key) && keyResult.issues.length;
            if (checkNumericKey) {
              const retryResult = def3.keyType._zod.run({ value: Number(key), issues: [] }, ctx);
              if (retryResult instanceof Promise) {
                throw new Error("Async schemas not supported in object keys currently");
              }
              if (retryResult.issues.length === 0) {
                keyResult = retryResult;
              }
            }
            if (keyResult.issues.length) {
              if (def3.mode === "loose") {
                payload.value[key] = input[key];
              } else if (values) {
                unrecognized = unrecognized ?? [];
                unrecognized.push(key);
              } else {
                payload.issues.push({
                  code: "invalid_key",
                  origin: "record",
                  issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
                  input: key,
                  path: [key],
                  inst
                });
              }
              continue;
            }
            const outKey = keyResult.value;
            if (outKey === "__proto__")
              continue;
            const result = def3.valueType._zod.run({ value: input[key], issues: [] }, ctx);
            if (result instanceof Promise) {
              proms.push(result.then((result2) => {
                if (result2.issues.length) {
                  payload.issues.push(...prefixIssues(key, result2.issues));
                }
                payload.value[outKey] = result2.value;
              }));
            } else {
              if (result.issues.length) {
                payload.issues.push(...prefixIssues(key, result.issues));
              }
              payload.value[outKey] = result.value;
            }
          }
          if (unrecognized && unrecognized.length > 0) {
            payload.issues.push({
              code: "unrecognized_keys",
              input,
              inst,
              keys: unrecognized,
              continue: true
            });
          }
        }
        if (proms.length) {
          return Promise.all(proms).then(() => payload);
        }
        return payload;
      };
    });
    $ZodEnum = /* @__PURE__ */ $constructor("$ZodEnum", (inst, def3) => {
      $ZodType.init(inst, def3);
      const values = getEnumValues(def3.entries);
      const valuesSet = new Set(values);
      inst._zod.values = valuesSet;
      defineLazyInternal(inst, "pattern", (zod) => {
        const patternValues = getEnumValues(zod.def.entries).filter((k) => propertyKeyTypes.has(typeof k));
        return new RegExp(patternValues.length ? `^(${patternValues.map((o) => escapeRegex(o.toString())).join("|")})$` : "^[^\\s\\S]$");
      });
      inst._zod.parse = (payload, _ctx) => {
        const input = payload.value;
        if (valuesSet.has(input)) {
          return payload;
        }
        payload.issues.push({
          code: "invalid_value",
          values,
          input,
          inst
        });
        return payload;
      };
    });
    $ZodLiteral = /* @__PURE__ */ $constructor("$ZodLiteral", (inst, def3) => {
      $ZodType.init(inst, def3);
      const values = new Set(def3.values);
      inst._zod.values = values;
      defineLazyInternal(inst, "pattern", (zod) => {
        const vals = zod.def.values;
        return new RegExp(vals.length ? `^(${vals.map((o) => typeof o === "string" ? escapeRegex(o) : o ? escapeRegex(o.toString()) : String(o)).join("|")})$` : "^[^\\s\\S]$");
      });
      inst._zod.parse = (payload, _ctx) => {
        const input = payload.value;
        if (values.has(input)) {
          return payload;
        }
        payload.issues.push({
          code: "invalid_value",
          values: def3.values,
          input,
          inst
        });
        return payload;
      };
    });
    $ZodTransform = /* @__PURE__ */ $constructor("$ZodTransform", (inst, def3) => {
      $ZodType.init(inst, def3);
      inst._zod.optin = "optional";
      globalConfig.memoizer?.guard(inst);
      inst._zod.parse = (payload, ctx) => {
        if (ctx.direction === "backward") {
          throw new $ZodEncodeError(inst.constructor.name);
        }
        const _out = def3.transform(payload.value, payload);
        if (ctx.async) {
          const output = _out instanceof Promise ? _out : Promise.resolve(_out);
          return output.then((output2) => {
            payload.value = output2;
            return payload;
          });
        }
        if (_out instanceof Promise) {
          throw new $ZodAsyncError();
        }
        payload.value = _out;
        return payload;
      };
    });
    $ZodOptional = /* @__PURE__ */ $constructor("$ZodOptional", (inst, def3) => {
      $ZodType.init(inst, def3);
      defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin === "defaulted" ? "defaulted" : "optional");
      inst._zod.optout = "optional";
      defineLazyInternal(inst, "values", (zod) => {
        const values = zod.def.innerType._zod.values;
        return values ? /* @__PURE__ */ new Set([...values, void 0]) : void 0;
      });
      defineLazyInternal(inst, "pattern", (zod) => {
        const pattern = zod.def.innerType._zod.pattern;
        return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : void 0;
      });
      inst._zod.parse = (payload, ctx) => {
        if (payload.value === void 0) {
          if (def3.innerType._zod.optin !== "defaulted")
            return payload;
          const result = def3.innerType._zod.run({ value: payload.value, issues: [] }, ctx);
          if (result instanceof Promise)
            return result.then((result2) => handleOptionalResult(payload, result2));
          return handleOptionalResult(payload, result);
        }
        return def3.innerType._zod.run(payload, ctx);
      };
    });
    $ZodExactOptional = /* @__PURE__ */ $constructor("$ZodExactOptional", (inst, def3) => {
      $ZodOptional.init(inst, def3);
      defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
      defineLazyInternal(inst, "pattern", (zod) => zod.def.innerType._zod.pattern);
      inst._zod.parse = (payload, ctx) => {
        return def3.innerType._zod.run(payload, ctx);
      };
    });
    $ZodNullable = /* @__PURE__ */ $constructor("$ZodNullable", (inst, def3) => {
      $ZodType.init(inst, def3);
      defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin);
      defineLazyInternal(inst, "optout", (zod) => zod.def.innerType._zod.optout);
      defineLazyInternal(inst, "pattern", (zod) => {
        const pattern = zod.def.innerType._zod.pattern;
        return pattern ? new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : void 0;
      });
      defineLazyInternal(inst, "values", (zod) => {
        return zod.def.innerType._zod.values ? /* @__PURE__ */ new Set([...zod.def.innerType._zod.values, null]) : void 0;
      });
      inst._zod.parse = (payload, ctx) => {
        if (payload.value === null)
          return payload;
        return def3.innerType._zod.run(payload, ctx);
      };
    });
    $ZodDefault = /* @__PURE__ */ $constructor("$ZodDefault", (inst, def3) => {
      $ZodType.init(inst, def3);
      inst._zod.optin = "defaulted";
      defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
      inst._zod.parse = (payload, ctx) => {
        if (ctx.direction === "backward") {
          return def3.innerType._zod.run(payload, ctx);
        }
        if (payload.value === void 0) {
          payload.value = def3.defaultValue;
          return payload;
        }
        const result = def3.innerType._zod.run(payload, ctx);
        if (result instanceof Promise) {
          return result.then((result2) => handleDefaultResult(result2, def3));
        }
        return handleDefaultResult(result, def3);
      };
    });
    $ZodPrefault = /* @__PURE__ */ $constructor("$ZodPrefault", (inst, def3) => {
      $ZodType.init(inst, def3);
      inst._zod.optin = "defaulted";
      defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
      inst._zod.parse = (payload, ctx) => {
        if (ctx.direction === "backward") {
          return def3.innerType._zod.run(payload, ctx);
        }
        if (payload.value === void 0) {
          payload.value = def3.defaultValue;
        }
        return def3.innerType._zod.run(payload, ctx);
      };
    });
    $ZodNonOptional = /* @__PURE__ */ $constructor("$ZodNonOptional", (inst, def3) => {
      $ZodType.init(inst, def3);
      defineLazyInternal(inst, "values", (zod) => {
        const v = zod.def.innerType._zod.values;
        return v ? new Set([...v].filter((x) => x !== void 0)) : void 0;
      });
      inst._zod.parse = (payload, ctx) => {
        const result = def3.innerType._zod.run(payload, ctx);
        if (result instanceof Promise) {
          return result.then((result2) => handleNonOptionalResult(result2, inst));
        }
        return handleNonOptionalResult(result, inst);
      };
    });
    $ZodCatch = /* @__PURE__ */ $constructor("$ZodCatch", (inst, def3) => {
      $ZodType.init(inst, def3);
      defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin === "defaulted" ? "defaulted" : "optional");
      defineLazyInternal(inst, "optout", (zod) => zod.def.innerType._zod.optout);
      defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
      inst._zod.parse = (payload, ctx) => {
        if (ctx.direction === "backward") {
          return def3.innerType._zod.run(payload, ctx);
        }
        const result = def3.innerType._zod.run({ value: payload.value, issues: [] }, ctx);
        if (result instanceof Promise) {
          return result.then((result2) => handleCatchResult(payload, result2, def3, ctx));
        }
        return handleCatchResult(payload, result, def3, ctx);
      };
    });
    $ZodPipe = /* @__PURE__ */ $constructor("$ZodPipe", (inst, def3) => {
      $ZodType.init(inst, def3);
      defineLazyInternal(inst, "values", (zod) => zod.def.in._zod.values);
      defineLazyInternal(inst, "optin", (zod) => zod.def.in._zod.optin);
      defineLazyInternal(inst, "optout", (zod) => zod.def.out._zod.optout);
      defineLazyInternal(inst, "propValues", (zod) => zod.def.in._zod.propValues);
      inst._zod.parse = (payload, ctx) => {
        if (ctx.direction === "backward") {
          const right = def3.out._zod.run(payload, ctx);
          if (right instanceof Promise) {
            return right.then((right2) => handlePipeResult(right2, def3.in, ctx));
          }
          return handlePipeResult(right, def3.in, ctx);
        }
        const left = def3.in._zod.run(payload, ctx);
        if (left instanceof Promise) {
          return left.then((left2) => handlePipeResult(left2, def3.out, ctx));
        }
        return handlePipeResult(left, def3.out, ctx);
      };
    });
    $ZodPreprocess = /* @__PURE__ */ $constructor("$ZodPreprocess", (inst, def3) => {
      $ZodPipe.init(inst, def3);
    });
    $ZodReadonly = /* @__PURE__ */ $constructor("$ZodReadonly", (inst, def3) => {
      $ZodType.init(inst, def3);
      defineLazyInternal(inst, "propValues", (zod) => zod.def.innerType._zod.propValues);
      defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
      defineLazyInternal(inst, "optin", (zod) => zod.def.innerType?._zod?.optin);
      defineLazyInternal(inst, "optout", (zod) => zod.def.innerType?._zod?.optout);
      inst._zod.parse = (payload, ctx) => {
        if (ctx.direction === "backward") {
          return def3.innerType._zod.run(payload, ctx);
        }
        const result = def3.innerType._zod.run(payload, ctx);
        if (result instanceof Promise) {
          return result.then(handleReadonlyResult);
        }
        return handleReadonlyResult(result);
      };
    });
    $ZodCustom = /* @__PURE__ */ $constructor("$ZodCustom", (inst, def3) => {
      $ZodCheck.init(inst, def3);
      $ZodType.init(inst, def3);
      inst._zod.parse = (payload, _) => {
        return payload;
      };
      inst._zod.check = (payload) => {
        const input = payload.value;
        const r = def3.fn(input);
        if (r instanceof Promise) {
          return r.then((r2) => handleRefineResult(r2, payload, input, inst));
        }
        handleRefineResult(r, payload, input, inst);
        return;
      };
    });
  }
});

// node_modules/zod/v4/core/memoizer.js
function isRef(value) {
  return value !== null && typeof value === "object";
}
function cloneIssues(issues) {
  return issues.map((iss) => iss.path ? { ...iss, path: iss.path.slice() } : { ...iss });
}
function isRecursive(inst, stack, resolve9) {
  const cached2 = recursive.get(inst);
  if (cached2 !== void 0)
    return cached2 ? PROVEN : NONE;
  if (stack.has(inst))
    return PROVEN;
  stack.add(inst);
  let result = NONE;
  const check = (child) => {
    if (result !== PROVEN && child?._zod) {
      const answer = isRecursive(child, stack, resolve9);
      if (answer > result)
        result = answer;
    }
  };
  const shape = (sh, spread) => {
    let answer = NONE;
    for (const key of Reflect.ownKeys(sh)) {
      const desc = Object.getOwnPropertyDescriptor(sh, key);
      if (spread && !desc.enumerable)
        continue;
      const child = desc.get ? ASSUMED : desc.value?._zod ? isRecursive(desc.value, stack, resolve9) : NONE;
      if (child > answer)
        answer = child;
    }
    return answer;
  };
  const merge2 = (answer) => {
    if (answer > result)
      result = answer;
  };
  const def3 = inst._zod.def;
  const kind = def3.type;
  switch (kind) {
    case "object": {
      const raw = rawShape(def3);
      merge2(raw ? shape(raw, true) : ASSUMED);
      check(def3.catchall);
      break;
    }
    case "array":
      check(def3.element);
      break;
    case "tuple":
      for (const el of def3.items)
        check(el);
      check(def3.rest);
      break;
    case "record":
    case "map":
      check(def3.keyType);
      check(def3.valueType);
      break;
    case "set":
      check(def3.valueType);
      break;
    case "union":
      for (const el of def3.options)
        check(el);
      break;
    case "intersection":
      check(def3.left);
      check(def3.right);
      break;
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "catch":
    case "readonly":
    case "nonoptional":
    case "promise":
    case "success":
      check(def3.innerType);
      break;
    case "pipe":
      check(def3.in);
      check(def3.out);
      break;
    case "function":
      check(def3.input);
      check(def3.output);
      break;
    // `$ZodLazy` caches its inner on the def, so a resolved edge is followed exactly
    case "lazy": {
      const inner = def3._cachedInner ?? (resolve9 ? inst._zod.innerType : void 0);
      merge2(inner ? isRecursive(inner, stack, false) : ASSUMED);
      break;
    }
    // a leaf by choice: `parts` are regex fragments, not data positions
    case "template_literal":
    // leaves
    case "string":
    case "number":
    case "int":
    case "boolean":
    case "bigint":
    case "symbol":
    case "undefined":
    case "null":
    case "void":
    case "never":
    case "any":
    case "unknown":
    case "date":
    case "nan":
    case "enum":
    case "literal":
    case "file":
    case "transform":
    case "custom":
      break;
    default: {
      kind;
      for (const key in def3) {
        const desc = Object.getOwnPropertyDescriptor(def3, key);
        if (!desc || desc.get)
          continue;
        const value = desc.value;
        if (!value || typeof value !== "object")
          continue;
        if (value._zod)
          check(value);
        else if (Array.isArray(value))
          for (const el of value)
            check(el);
      }
    }
  }
  stack.delete(inst);
  return settle(inst, result);
}
function settle(inst, answer) {
  if (answer !== ASSUMED)
    recursive.set(inst, answer === PROVEN);
  return answer;
}
function bucketFor(state, inst) {
  let bucket = state.buckets.get(inst);
  if (!bucket) {
    bucket = /* @__PURE__ */ new WeakMap();
    state.buckets.set(inst, bucket);
  }
  return bucket;
}
function memoizer() {
  return memo;
}
function isBackEdge(ctx, value) {
  const backEdges = ctx[STATE]?.backEdges;
  return backEdges !== void 0 && isRef(value) && backEdges.has(value);
}
var $ZodCyclicError, STATE, NO_ISSUES, recursive, NONE, ASSUMED, PROVEN, handoff, open, memo;
var init_memoizer = __esm({
  "node_modules/zod/v4/core/memoizer.js"() {
    init_util();
    $ZodCyclicError = class extends Error {
      constructor() {
        super(`Cannot parse a reference cycle that closes through a transform`);
        this.name = "ZodCyclicError";
      }
    };
    STATE = "~memo";
    NO_ISSUES = [];
    recursive = /* @__PURE__ */ new WeakMap();
    NONE = 0;
    ASSUMED = 1;
    PROVEN = 2;
    open = [];
    memo = {
      alloc(_inst, payload, empty) {
        const bucket = handoff;
        if (!bucket)
          return empty;
        handoff = void 0;
        const entry = { value: empty, issues: null };
        bucket.set(payload.value, entry);
        open.push(entry);
        return empty;
      },
      guard(inst) {
        var _a3;
        (_a3 = inst._zod).deferred ?? (_a3.deferred = []);
        inst._zod.deferred.push(() => {
          const base = inst._zod.parse;
          const wrapped = (payload, ctx) => {
            if (ctx.direction !== "backward" && isBackEdge(ctx, payload.value))
              throw new $ZodCyclicError();
            return base(payload, ctx);
          };
          inst._zod.parse = wrapped;
          if (inst._zod.run === base)
            inst._zod.run = wrapped;
        });
      },
      attach(inst) {
        var _a3;
        let isRecursiveInst;
        let rechecked = false;
        let lastCtx;
        let lastBucket;
        (_a3 = inst._zod).deferred ?? (_a3.deferred = []);
        inst._zod.deferred.push(() => {
          const base = inst._zod.parse;
          const wrapped = (payload, ctx) => {
            if (isRecursiveInst === void 0) {
              const walked = isRecursive(inst, /* @__PURE__ */ new Set(), false);
              if (walked === NONE) {
                inst._zod.parse = base;
                if (inst._zod.run === wrapped)
                  inst._zod.run = base;
                return base(payload, ctx);
              }
              if (walked === PROVEN || rechecked)
                isRecursiveInst = true;
              else
                rechecked = true;
            }
            const input = payload.value;
            if (!isRef(input))
              return base(payload, ctx);
            let state = ctx[STATE];
            if (!state) {
              state = { buckets: /* @__PURE__ */ new WeakMap(), backEdges: void 0 };
              ctx[STATE] = state;
            }
            let bucket;
            if (lastCtx === ctx) {
              bucket = lastBucket;
            } else {
              bucket = bucketFor(state, inst);
              lastCtx = ctx;
              lastBucket = bucket;
            }
            const hit = bucket.get(input);
            if (hit) {
              payload.value = hit.value;
              if (hit.issues) {
                if (hit.issues.length)
                  payload.issues.push(...cloneIssues(hit.issues));
              } else {
                payload.memo = true;
                state.backEdges ?? (state.backEdges = /* @__PURE__ */ new WeakSet());
                state.backEdges.add(hit.value);
              }
              return payload;
            }
            handoff = bucket;
            const depth = open.length;
            const result = base(payload, ctx);
            handoff = void 0;
            const entry = open.length > depth ? open.pop() : void 0;
            if (result instanceof Promise) {
              return result.then((r) => {
                if (entry)
                  entry.issues = r.issues.length ? cloneIssues(r.issues) : NO_ISSUES;
                return r;
              });
            }
            if (entry)
              entry.issues = result.issues.length ? cloneIssues(result.issues) : NO_ISSUES;
            return result;
          };
          inst._zod.parse = wrapped;
          if (inst._zod.run === base)
            inst._zod.run = wrapped;
        });
      }
    };
  }
});

// node_modules/zod/v4/locales/en.js
function en_default() {
  return {
    localeError: error()
  };
}
var error;
var init_en = __esm({
  "node_modules/zod/v4/locales/en.js"() {
    init_util();
    error = () => {
      const Sizable = {
        string: { unit: "characters", verb: "to have" },
        file: { unit: "bytes", verb: "to have" },
        array: { unit: "items", verb: "to have" },
        set: { unit: "items", verb: "to have" },
        map: { unit: "entries", verb: "to have" }
      };
      function getSizing(origin) {
        return Sizable[origin] ?? null;
      }
      const FormatDictionary = {
        regex: "input",
        email: "email address",
        url: "URL",
        emoji: "emoji",
        uuid: "UUID",
        uuidv4: "UUIDv4",
        uuidv6: "UUIDv6",
        nanoid: "nanoid",
        guid: "GUID",
        cuid: "cuid",
        cuid2: "cuid2",
        ulid: "ULID",
        xid: "XID",
        ksuid: "KSUID",
        datetime: "ISO datetime",
        date: "ISO date",
        time: "ISO time",
        duration: "ISO duration",
        ipv4: "IPv4 address",
        ipv6: "IPv6 address",
        mac: "MAC address",
        cidrv4: "IPv4 range",
        cidrv6: "IPv6 range",
        base64: "base64-encoded string",
        base64url: "base64url-encoded string",
        json_string: "JSON string",
        e164: "E.164 number",
        currency_code: "currency code",
        credit_card: "credit card number",
        iban: "IBAN",
        jwt: "JWT",
        template_literal: "input"
      };
      const TypeDictionary = {
        // Compatibility: "nan" -> "NaN" for display
        nan: "NaN"
        // All other type names omitted - they fall back to raw values via ?? operator
      };
      function getTypeName(type, input) {
        if (type === "number" && typeof input === "number" && !Number.isFinite(input)) {
          return String(input);
        }
        return TypeDictionary[type] ?? type;
      }
      return (issue2) => {
        switch (issue2.code) {
          case "invalid_type": {
            const expected = getTypeName(issue2.expected);
            const receivedType = parsedType(issue2.input);
            const received = getTypeName(receivedType, issue2.input);
            return `Invalid input: expected ${expected}, received ${received}`;
          }
          case "invalid_value":
            if (issue2.values.length === 1)
              return `Invalid input: expected ${stringifyPrimitive(issue2.values[0])}`;
            return `Invalid option: expected one of ${joinValues(issue2.values, "|")}`;
          case "too_big": {
            const adj = issue2.exact ? "exactly " : issue2.inclusive ? "<=" : "<";
            const sizing = getSizing(issue2.origin);
            if (sizing)
              return `Too big: expected ${issue2.origin ?? "value"} to have ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elements"}`;
            return `Too big: expected ${issue2.origin ?? "value"} to be ${adj}${issue2.maximum.toString()}`;
          }
          case "too_small": {
            const adj = issue2.exact ? "exactly " : issue2.inclusive ? ">=" : ">";
            const sizing = getSizing(issue2.origin);
            if (sizing) {
              return `Too small: expected ${issue2.origin} to have ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
            }
            return `Too small: expected ${issue2.origin} to be ${adj}${issue2.minimum.toString()}`;
          }
          case "invalid_format": {
            const _issue = issue2;
            if (_issue.format === "starts_with") {
              return `Invalid string: must start with "${_issue.prefix}"`;
            }
            if (_issue.format === "ends_with")
              return `Invalid string: must end with "${_issue.suffix}"`;
            if (_issue.format === "includes")
              return `Invalid string: must include "${_issue.includes}"`;
            if (_issue.format === "regex")
              return `Invalid string: must match pattern ${_issue.pattern}`;
            return `Invalid ${FormatDictionary[_issue.format] ?? issue2.format}`;
          }
          case "not_multiple_of":
            return `Invalid number: must be a multiple of ${issue2.divisor}`;
          case "unrecognized_keys":
            return `Unrecognized key${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
          case "invalid_key":
            return `Invalid key in ${issue2.origin}`;
          case "invalid_union":
            if (issue2.options && Array.isArray(issue2.options) && issue2.options.length > 0) {
              const opts = issue2.options.map((o) => `'${o}'`).join(" | ");
              return `Invalid discriminator value. Expected ${opts}`;
            }
            if (issue2.inclusive === false) {
              return "Invalid input: more than one option matched";
            }
            return "Invalid input";
          case "invalid_element":
            return `Invalid value in ${issue2.origin}`;
          default:
            return `Invalid input`;
        }
      };
    };
  }
});

// node_modules/zod/v4/locales/index.js
var init_locales = __esm({
  "node_modules/zod/v4/locales/index.js"() {
  }
});

// node_modules/zod/v4/core/registries.js
function registry() {
  return new $ZodRegistry();
}
var _a2, $ZodRegistry, globalRegistry;
var init_registries = __esm({
  "node_modules/zod/v4/core/registries.js"() {
    $ZodRegistry = class {
      constructor() {
        this._map = /* @__PURE__ */ new WeakMap();
        this._idmap = /* @__PURE__ */ new Map();
      }
      add(schema, ..._meta) {
        const meta2 = _meta[0];
        this._map.set(schema, meta2);
        if (meta2 && typeof meta2 === "object" && "id" in meta2) {
          this._idmap.set(meta2.id, schema);
        }
        return this;
      }
      clear() {
        this._map = /* @__PURE__ */ new WeakMap();
        this._idmap = /* @__PURE__ */ new Map();
        return this;
      }
      remove(schema) {
        const meta2 = this._map.get(schema);
        if (meta2 && typeof meta2 === "object" && "id" in meta2) {
          this._idmap.delete(meta2.id);
        }
        this._map.delete(schema);
        return this;
      }
      get(schema) {
        const p = schema._zod.parent;
        if (p) {
          const pm = { ...this.get(p) ?? {} };
          delete pm.id;
          const f = { ...pm, ...this._map.get(schema) };
          return Object.keys(f).length ? f : void 0;
        }
        return this._map.get(schema);
      }
      has(schema) {
        return this._map.has(schema);
      }
    };
    (_a2 = globalThis).__zod_globalRegistry ?? (_a2.__zod_globalRegistry = registry());
    globalRegistry = globalThis.__zod_globalRegistry;
  }
});

// node_modules/zod/v4/core/compile.js
var INVALID, FALLBACK_FLAG;
var init_compile = __esm({
  "node_modules/zod/v4/core/compile.js"() {
    INVALID = Symbol.for("zod.compile.invalid");
    FALLBACK_FLAG = Symbol.for("zod.compile.fallback");
  }
});

// node_modules/zod/v4/core/api.js
function snapshotChecks(def3) {
  if (def3.checks)
    def3.checks = [...def3.checks];
  return def3;
}
// @__NO_SIDE_EFFECTS__
function _string(Class2, params) {
  return new Class2(snapshotChecks({ type: "string", ...normalizeParams(params) }));
}
// @__NO_SIDE_EFFECTS__
function _email(Class2, params) {
  return new Class2({
    type: "string",
    format: "email",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _guid(Class2, params) {
  return new Class2({
    type: "string",
    format: "guid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _uuid(Class2, params) {
  return new Class2({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _uuidv4(Class2, params) {
  return new Class2({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v4",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _uuidv6(Class2, params) {
  return new Class2({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v6",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _uuidv7(Class2, params) {
  return new Class2({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v7",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _url(Class2, params) {
  return new Class2({
    type: "string",
    format: "url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _emoji2(Class2, params) {
  return new Class2({
    type: "string",
    format: "emoji",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _nanoid(Class2, params) {
  return new Class2({
    type: "string",
    format: "nanoid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _cuid(Class2, params) {
  return new Class2({
    type: "string",
    format: "cuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _cuid2(Class2, params) {
  return new Class2({
    type: "string",
    format: "cuid2",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _ulid(Class2, params) {
  return new Class2({
    type: "string",
    format: "ulid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _xid(Class2, params) {
  return new Class2({
    type: "string",
    format: "xid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _ksuid(Class2, params) {
  return new Class2({
    type: "string",
    format: "ksuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _ipv4(Class2, params) {
  return new Class2({
    type: "string",
    format: "ipv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _ipv6(Class2, params) {
  return new Class2({
    type: "string",
    format: "ipv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _cidrv4(Class2, params) {
  return new Class2({
    type: "string",
    format: "cidrv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _cidrv6(Class2, params) {
  return new Class2({
    type: "string",
    format: "cidrv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _base64(Class2, params) {
  return new Class2({
    type: "string",
    format: "base64",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _base64url(Class2, params) {
  return new Class2({
    type: "string",
    format: "base64url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _e164(Class2, params) {
  return new Class2({
    type: "string",
    format: "e164",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _jwt(Class2, params) {
  return new Class2({
    type: "string",
    format: "jwt",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _isoDateTime(Class2, params) {
  return new Class2({
    type: "string",
    format: "datetime",
    check: "string_format",
    offset: false,
    local: false,
    precision: null,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _isoDate(Class2, params) {
  return new Class2({
    type: "string",
    format: "date",
    check: "string_format",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _isoTime(Class2, params) {
  return new Class2({
    type: "string",
    format: "time",
    check: "string_format",
    precision: null,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _isoDuration(Class2, params) {
  return new Class2({
    type: "string",
    format: "duration",
    check: "string_format",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _number(Class2, params) {
  return new Class2(snapshotChecks({ type: "number", checks: [], ...normalizeParams(params) }));
}
// @__NO_SIDE_EFFECTS__
function _int(Class2, params) {
  return new Class2({
    type: "number",
    check: "number_format",
    abort: false,
    format: "safeint",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _boolean(Class2, params) {
  return new Class2({
    type: "boolean",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _null2(Class2, params) {
  return new Class2({
    type: "null",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _unknown(Class2) {
  return new Class2({
    type: "unknown"
  });
}
// @__NO_SIDE_EFFECTS__
function _never(Class2, params) {
  return new Class2({
    type: "never",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _lt(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
// @__NO_SIDE_EFFECTS__
function _lte(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
// @__NO_SIDE_EFFECTS__
function _gt(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
// @__NO_SIDE_EFFECTS__
function _gte(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
// @__NO_SIDE_EFFECTS__
function _multipleOf(value, params) {
  return new $ZodCheckMultipleOf({
    check: "multiple_of",
    ...normalizeParams(params),
    value
  });
}
// @__NO_SIDE_EFFECTS__
function _maxLength(maximum, params) {
  const ch = new $ZodCheckMaxLength({
    check: "max_length",
    ...normalizeParams(params),
    maximum
  });
  return ch;
}
// @__NO_SIDE_EFFECTS__
function _minLength(minimum, params) {
  return new $ZodCheckMinLength({
    check: "min_length",
    ...normalizeParams(params),
    minimum
  });
}
// @__NO_SIDE_EFFECTS__
function _length(length, params) {
  return new $ZodCheckLengthEquals({
    check: "length_equals",
    ...normalizeParams(params),
    length
  });
}
// @__NO_SIDE_EFFECTS__
function _regex(pattern, params) {
  return new $ZodCheckRegex({
    check: "string_format",
    format: "regex",
    ...normalizeParams(params),
    pattern
  });
}
// @__NO_SIDE_EFFECTS__
function _lowercase(params) {
  return new $ZodCheckLowerCase({
    check: "string_format",
    format: "lowercase",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _uppercase(params) {
  return new $ZodCheckUpperCase({
    check: "string_format",
    format: "uppercase",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _includes(includes, params) {
  return new $ZodCheckIncludes({
    check: "string_format",
    format: "includes",
    ...normalizeParams(params),
    includes
  });
}
// @__NO_SIDE_EFFECTS__
function _startsWith(prefix, params) {
  return new $ZodCheckStartsWith({
    check: "string_format",
    format: "starts_with",
    ...normalizeParams(params),
    prefix
  });
}
// @__NO_SIDE_EFFECTS__
function _endsWith(suffix, params) {
  return new $ZodCheckEndsWith({
    check: "string_format",
    format: "ends_with",
    ...normalizeParams(params),
    suffix
  });
}
// @__NO_SIDE_EFFECTS__
function _overwrite(tx) {
  return new $ZodCheckOverwrite({
    check: "overwrite",
    tx
  });
}
// @__NO_SIDE_EFFECTS__
function _normalize(form) {
  return /* @__PURE__ */ _overwrite((input) => input.normalize(form));
}
// @__NO_SIDE_EFFECTS__
function _trim() {
  return /* @__PURE__ */ _overwrite((input) => input.trim());
}
// @__NO_SIDE_EFFECTS__
function _toLowerCase() {
  return /* @__PURE__ */ _overwrite((input) => input.toLowerCase());
}
// @__NO_SIDE_EFFECTS__
function _toUpperCase() {
  return /* @__PURE__ */ _overwrite((input) => input.toUpperCase());
}
// @__NO_SIDE_EFFECTS__
function _slugify() {
  return /* @__PURE__ */ _overwrite((input) => slugify(input));
}
// @__NO_SIDE_EFFECTS__
function _array(Class2, element, params) {
  return new Class2({
    type: "array",
    element,
    // get element() {
    //   return element;
    // },
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _custom(Class2, fn, _params) {
  const norm2 = normalizeParams(_params);
  norm2.abort ?? (norm2.abort = true);
  const schema = new Class2({
    type: "custom",
    check: "custom",
    fn,
    ...norm2
  });
  return schema;
}
// @__NO_SIDE_EFFECTS__
function _refine(Class2, fn, _params) {
  const schema = new Class2({
    type: "custom",
    check: "custom",
    fn,
    ...normalizeParams(_params)
  });
  return schema;
}
// @__NO_SIDE_EFFECTS__
function _superRefine(fn, params) {
  const ch = /* @__PURE__ */ _check((payload) => {
    payload.addIssue = (issue2) => {
      if (typeof issue2 === "string") {
        payload.issues.push(issue(issue2, payload.value, ch._zod.def));
      } else {
        const _issue = issue2;
        if (_issue.fatal)
          _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        if (!("input" in _issue))
          _issue.input = payload.value;
        _issue.inst ?? (_issue.inst = ch);
        _issue.continue ?? (_issue.continue = !ch._zod.def.abort);
        payload.issues.push(issue(_issue));
      }
    };
    return fn(payload.value, payload);
  }, params);
  return ch;
}
// @__NO_SIDE_EFFECTS__
function _check(fn, params) {
  const ch = new $ZodCheck({
    check: "custom",
    ...normalizeParams(params)
  });
  ch._zod.check = fn;
  return ch;
}
var init_api = __esm({
  "node_modules/zod/v4/core/api.js"() {
    init_checks();
    init_util();
  }
});

// node_modules/zod/v4/core/to-json-schema.js
function assignProps(target, ...sources) {
  for (const source of sources) {
    for (const key of Reflect.ownKeys(source)) {
      if (Object.prototype.propertyIsEnumerable.call(source, key)) {
        assignProp(target, key, source[key]);
      }
    }
  }
  return target;
}
function initializeContext(params) {
  let target = params?.target ?? "draft-2020-12";
  if (target === "draft-4")
    target = "draft-04";
  if (target === "draft-7")
    target = "draft-07";
  return {
    processors: params.processors ?? {},
    metadataRegistry: params?.metadata ?? globalRegistry,
    target,
    unrepresentable: params?.unrepresentable ?? "throw",
    override: params?.override ?? (() => {
    }),
    io: params?.io ?? "output",
    counter: 0,
    seen: /* @__PURE__ */ new Map(),
    sharedDefsExtractedFor: void 0,
    sharedEmitDoneFor: void 0,
    cycles: params?.cycles ?? "ref",
    reused: params?.reused ?? "inline",
    intersections: [],
    deferred: [],
    external: params?.external ?? void 0
  };
}
function handleUnrepresentable(schema, ctx, json, params, message) {
  const result = typeof ctx.unrepresentable === "function" ? ctx.unrepresentable({ zodSchema: schema, path: params.path, message }) : ctx.unrepresentable;
  if (result === "any")
    return false;
  if (result === void 0 || result === "throw")
    throw new Error(message);
  Object.assign(json, result);
  return true;
}
function processSchema(schema, ctx, _params = { path: [], schemaPath: [] }) {
  var _a3;
  const def3 = schema._zod.def;
  const seen = ctx.seen.get(schema);
  if (seen) {
    seen.count++;
    const isCycle = _params.schemaPath.includes(schema);
    if (isCycle) {
      seen.cycle = _params.path;
    }
    return seen.schema;
  }
  const result = { schema: {}, count: 1, cycle: void 0, path: _params.path };
  ctx.seen.set(schema, result);
  ctx.sharedDefsExtractedFor = void 0;
  ctx.sharedEmitDoneFor = void 0;
  const overrideSchema = schema._zod.toJSONSchema?.();
  if (overrideSchema) {
    result.schema = overrideSchema;
  } else {
    const params = {
      ..._params,
      schemaPath: [..._params.schemaPath, schema],
      path: _params.path
    };
    if (schema._zod.processJSONSchema) {
      schema._zod.processJSONSchema(ctx, result.schema, params);
    } else {
      const _json = result.schema;
      const processor = ctx.processors[def3.type];
      if (!processor) {
        throw new Error(`[toJSONSchema]: Non-representable type encountered: ${def3.type}`);
      }
      processor(schema, ctx, _json, params);
    }
    const parent = schema._zod.parent;
    if (parent) {
      if (!result.ref)
        result.ref = parent;
      processSchema(parent, ctx, params);
      ctx.seen.get(parent).isParent = true;
    }
  }
  const meta2 = ctx.metadataRegistry.get(schema);
  if (meta2)
    assignProps(result.schema, meta2);
  if (ctx.io === "input" && isTransforming(schema)) {
    delete result.schema.examples;
    delete result.schema.default;
  }
  if (ctx.io === "input" && "_prefault" in result.schema)
    (_a3 = result.schema).default ?? (_a3.default = result.schema._prefault);
  delete result.schema._prefault;
  const _result = ctx.seen.get(schema);
  return _result.schema;
}
function encodeJSONPointerSegment(segment) {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}
function extractDefs(ctx, schema) {
  const root = ctx.seen.get(schema);
  if (!root)
    throw new Error("Unprocessed schema. This is a bug in Zod.");
  if (ctx.external && ctx.sharedDefsExtractedFor === ctx.external)
    return;
  const idToSchema = /* @__PURE__ */ new Map();
  for (const entry of ctx.seen.entries()) {
    const id = ctx.metadataRegistry.get(entry[0])?.id;
    if (id) {
      const existing = idToSchema.get(id);
      if (existing && existing !== entry[0]) {
        throw new Error(`Duplicate schema id "${id}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`);
      }
      idToSchema.set(id, entry[0]);
    }
  }
  const makeURI = (entry) => {
    const defsSegment = ctx.target === "draft-2020-12" ? "$defs" : "definitions";
    if (ctx.external) {
      const externalId = ctx.external.registry.get(entry[0])?.id;
      const uriGenerator = ctx.external.uri ?? ((id2) => id2);
      if (externalId) {
        return { ref: uriGenerator(externalId) };
      }
      const id = entry[1].defId ?? entry[1].schema.id ?? `schema${ctx.counter++}`;
      entry[1].defId = id;
      return { defId: id, ref: `${uriGenerator("__shared")}#/${defsSegment}/${encodeJSONPointerSegment(id)}` };
    }
    const uriPrefix = `#`;
    const defUriPrefix = `${uriPrefix}/${defsSegment}/`;
    if (entry[1] === root && !entry[1].schema.id) {
      return { ref: uriPrefix };
    }
    const defId = entry[1].schema.id ?? `__schema${ctx.counter++}`;
    return { defId, ref: defUriPrefix + encodeJSONPointerSegment(defId) };
  };
  const extractToDef = (entry) => {
    if (entry[1].schema.$ref) {
      return;
    }
    const seen = entry[1];
    const { ref, defId } = makeURI(entry);
    seen.def = { ...seen.schema };
    if (defId)
      seen.defId = defId;
    const schema2 = seen.schema;
    for (const key in schema2) {
      delete schema2[key];
    }
    schema2.$ref = ref;
  };
  if (ctx.cycles === "throw") {
    for (const entry of ctx.seen.entries()) {
      const seen = entry[1];
      if (seen.cycle) {
        throw new Error(`Cycle detected: #/${seen.cycle?.join("/")}/<root>

Set the \`cycles\` parameter to \`"ref"\` to resolve cyclical schemas with defs.`);
      }
    }
  }
  for (const entry of ctx.seen.entries()) {
    const seen = entry[1];
    if (schema === entry[0]) {
      extractToDef(entry);
      continue;
    }
    if (ctx.external) {
      const ext = ctx.external.registry.get(entry[0])?.id;
      if (schema !== entry[0] && ext) {
        extractToDef(entry);
        continue;
      }
    }
    const id = ctx.metadataRegistry.get(entry[0])?.id;
    if (id) {
      extractToDef(entry);
      continue;
    }
    if (seen.cycle) {
      extractToDef(entry);
      continue;
    }
    if (seen.count > 1) {
      if (ctx.reused === "ref") {
        extractToDef(entry);
      }
    }
  }
  if (ctx.external)
    ctx.sharedDefsExtractedFor = ctx.external;
}
function compactTypeUnion(schema) {
  const options = schema.anyOf;
  if (!Array.isArray(options) || options.length === 0 || schema.type !== void 0)
    return;
  const types = [];
  for (const option of options) {
    if (!option || typeof option !== "object")
      return;
    compactTypeUnion(option);
    const keys = Object.keys(option);
    if (keys.length !== 1 || keys[0] !== "type")
      return;
    const type = option.type;
    for (const member of Array.isArray(type) ? type : [type]) {
      if (typeof member !== "string")
        return;
      if (!types.includes(member))
        types.push(member);
    }
  }
  delete schema.anyOf;
  schema.type = types.length === 1 ? types[0] : types;
}
function undeclaredConstraint(member) {
  const extra = member.additionalProperties;
  if (extra === void 0 || extra === false || typeof extra !== "object" || extra === null)
    return null;
  return Object.keys(extra).length ? extra : null;
}
function foldObjects(members2) {
  const objects = [];
  for (const member of members2) {
    if (typeof member !== "object" || member.type !== "object")
      return null;
    for (const key in member) {
      if (!FOLDABLE_KEYS.has(key))
        return null;
    }
    objects.push(member);
  }
  const properties = {};
  const required2 = /* @__PURE__ */ new Set();
  for (const object3 of objects) {
    for (const key in object3.properties) {
      if (Object.prototype.hasOwnProperty.call(properties, key))
        continue;
      const parts = [];
      for (const other of objects) {
        const part = other.properties?.[key] ?? undeclaredConstraint(other);
        if (part === null || part === void 0)
          continue;
        if (!parts.some((seen) => JSON.stringify(seen) === JSON.stringify(part)))
          parts.push(part);
      }
      const merged = parts.length === 1 ? parts[0] : foldObjects(parts) ?? { allOf: parts };
      assignProp(properties, key, merged);
    }
    for (const key of object3.required ?? [])
      required2.add(key);
  }
  const folded = { type: "object", properties };
  if (required2.size)
    folded.required = [...required2];
  if (objects.every((object3) => object3.additionalProperties === false)) {
    folded.additionalProperties = false;
  } else {
    const constraints = [];
    for (const object3 of objects) {
      const constraint = undeclaredConstraint(object3);
      if (constraint && !constraints.some((seen) => JSON.stringify(seen) === JSON.stringify(constraint)))
        constraints.push(constraint);
    }
    if (constraints.length === 1)
      folded.additionalProperties = constraints[0];
    else if (constraints.length > 1)
      folded.additionalProperties = { allOf: constraints };
  }
  return folded;
}
function foldIntersection(json) {
  const allOf = json.allOf;
  if (!Array.isArray(allOf) || allOf.length < 2)
    return;
  for (const key of FOLDABLE_KEYS)
    if (key in json)
      return;
  const unions = allOf.filter((m) => UNION_KEYS.some((k) => Array.isArray(m[k])));
  let folded = null;
  if (!unions.length) {
    folded = foldObjects(allOf);
  } else {
    const union2 = unions[0];
    const keyword = UNION_KEYS.find((k) => Array.isArray(union2[k]));
    if (Object.keys(union2).length !== 1)
      return;
    const rest2 = allOf.filter((m) => m !== union2);
    const branches = union2[keyword].map((branch) => foldObjects([...rest2, branch]));
    if (branches.some((b) => !b))
      return;
    folded = { [keyword]: branches };
  }
  if (!folded)
    return;
  delete json.allOf;
  assignProps(json, folded);
}
function finalize(ctx, schema) {
  const root = ctx.seen.get(schema);
  if (!root)
    throw new Error("Unprocessed schema. This is a bug in Zod.");
  const flattenRef = (zodSchema) => {
    const seen = ctx.seen.get(zodSchema);
    if (seen.ref === null)
      return;
    const schema2 = seen.def ?? seen.schema;
    const _cached = { ...schema2 };
    const ref = seen.ref;
    seen.ref = null;
    if (ref) {
      flattenRef(ref);
      const refSeen = ctx.seen.get(ref);
      const refSchema = refSeen.schema;
      if (refSchema.$ref && (ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0")) {
        schema2.allOf = schema2.allOf ?? [];
        schema2.allOf.push(refSchema);
      } else {
        assignProps(schema2, refSchema);
      }
      assignProps(schema2, _cached);
      const isParentRef = zodSchema._zod.parent === ref;
      if (isParentRef) {
        for (const key in schema2) {
          if (key === "$ref" || key === "allOf")
            continue;
          if (!(key in _cached)) {
            delete schema2[key];
          }
        }
      }
      if (refSchema.$ref && refSeen.def) {
        for (const key in schema2) {
          if (key === "$ref" || key === "allOf")
            continue;
          if (key in refSeen.def && JSON.stringify(schema2[key]) === JSON.stringify(refSeen.def[key])) {
            delete schema2[key];
          }
        }
      }
    }
    const parent = zodSchema._zod.parent;
    if (parent && parent !== ref) {
      flattenRef(parent);
      const parentSeen = ctx.seen.get(parent);
      if (parentSeen?.schema.$ref) {
        schema2.$ref = parentSeen.schema.$ref;
        if (parentSeen.def) {
          for (const key in schema2) {
            if (key === "$ref" || key === "allOf")
              continue;
            if (key in parentSeen.def && JSON.stringify(schema2[key]) === JSON.stringify(parentSeen.def[key])) {
              delete schema2[key];
            }
          }
        }
      }
    }
    ctx.override({
      zodSchema,
      jsonSchema: schema2,
      path: seen.path ?? []
    });
  };
  if (!ctx.external || ctx.sharedEmitDoneFor !== ctx.external) {
    for (const entry of [...ctx.seen.entries()].reverse()) {
      flattenRef(entry[0]);
    }
    if (ctx.target !== "openapi-3.0") {
      for (const entry of ctx.seen.entries()) {
        compactTypeUnion(entry[1].def ?? entry[1].schema);
      }
    }
    for (const rewrite of ctx.deferred)
      rewrite();
    if (ctx.intersections.length) {
      const carriers = /* @__PURE__ */ new Map();
      for (const seen of ctx.seen.values()) {
        for (const json of [seen.schema, seen.def]) {
          const allOf = json?.allOf;
          if (!Array.isArray(allOf))
            continue;
          const existing = carriers.get(allOf);
          if (existing)
            existing.push(json);
          else
            carriers.set(allOf, [json]);
        }
      }
      for (const allOf of ctx.intersections) {
        for (const json of carriers.get(allOf) ?? [])
          foldIntersection(json);
      }
    }
  }
  const result = {};
  if (ctx.target === "draft-2020-12") {
    result.$schema = "https://json-schema.org/draft/2020-12/schema";
  } else if (ctx.target === "draft-07") {
    result.$schema = "http://json-schema.org/draft-07/schema#";
  } else if (ctx.target === "draft-04") {
    result.$schema = "http://json-schema.org/draft-04/schema#";
  } else if (ctx.target === "openapi-3.0") {
  } else {
  }
  if (ctx.external?.uri) {
    const id = ctx.external.registry.get(schema)?.id;
    if (!id)
      throw new Error("Schema is missing an `id` property");
    result.$id = ctx.external.uri(id);
  }
  assignProps(result, root.defId ? root.schema : root.def ?? root.schema);
  const rootMetaId = ctx.metadataRegistry.get(schema)?.id;
  if (rootMetaId !== void 0 && result.id === rootMetaId)
    delete result.id;
  const defs = ctx.external?.defs ?? {};
  if (!ctx.external || ctx.sharedEmitDoneFor !== ctx.external) {
    for (const entry of ctx.seen.entries()) {
      const seen = entry[1];
      if (seen.def && seen.defId) {
        if (seen.def.id === seen.defId)
          delete seen.def.id;
        assignProp(defs, seen.defId, seen.def);
      }
    }
  }
  if (ctx.external)
    ctx.sharedEmitDoneFor = ctx.external;
  if (ctx.external) {
  } else {
    if (Object.keys(defs).length > 0) {
      if (ctx.target === "draft-2020-12") {
        result.$defs = defs;
      } else {
        result.definitions = defs;
      }
    }
  }
  try {
    const finalized = JSON.parse(JSON.stringify(result));
    Object.defineProperty(finalized, "~standard", {
      value: {
        ...schema["~standard"],
        jsonSchema: {
          input: createStandardJSONSchemaMethod(schema, "input", ctx.processors),
          output: createStandardJSONSchemaMethod(schema, "output", ctx.processors)
        }
      },
      enumerable: false,
      writable: false
    });
    return finalized;
  } catch (_err) {
    throw new Error("Error converting schema to JSON.");
  }
}
function isTransforming(_schema, _ctx) {
  const ctx = _ctx ?? { seen: /* @__PURE__ */ new Set() };
  if (ctx.seen.has(_schema))
    return false;
  ctx.seen.add(_schema);
  const def3 = _schema._zod.def;
  if (def3.type === "transform")
    return true;
  if (def3.type === "array")
    return isTransforming(def3.element, ctx);
  if (def3.type === "set")
    return isTransforming(def3.valueType, ctx);
  if (def3.type === "lazy")
    return isTransforming(def3.getter(), ctx);
  if (def3.type === "promise" || def3.type === "optional" || def3.type === "nonoptional" || def3.type === "nullable" || def3.type === "readonly" || def3.type === "default" || def3.type === "prefault" || def3.type === "catch") {
    return isTransforming(def3.innerType, ctx);
  }
  if (def3.type === "intersection") {
    return isTransforming(def3.left, ctx) || isTransforming(def3.right, ctx);
  }
  if (def3.type === "record" || def3.type === "map") {
    return isTransforming(def3.keyType, ctx) || isTransforming(def3.valueType, ctx);
  }
  if (def3.type === "pipe") {
    if (_schema._zod.traits.has("$ZodCodec"))
      return true;
    return isTransforming(def3.in, ctx) || isTransforming(def3.out, ctx);
  }
  if (def3.type === "object") {
    for (const key in def3.shape) {
      if (isTransforming(def3.shape[key], ctx))
        return true;
    }
    return false;
  }
  if (def3.type === "union") {
    for (const option of def3.options) {
      if (isTransforming(option, ctx))
        return true;
    }
    return false;
  }
  if (def3.type === "tuple") {
    for (const item of def3.items) {
      if (isTransforming(item, ctx))
        return true;
    }
    if (def3.rest && isTransforming(def3.rest, ctx))
      return true;
    return false;
  }
  return false;
}
var FOLDABLE_KEYS, UNION_KEYS, createToJSONSchemaMethod, createStandardJSONSchemaMethod;
var init_to_json_schema = __esm({
  "node_modules/zod/v4/core/to-json-schema.js"() {
    init_registries();
    init_util();
    FOLDABLE_KEYS = /* @__PURE__ */ new Set(["type", "properties", "required", "additionalProperties"]);
    UNION_KEYS = ["oneOf", "anyOf"];
    createToJSONSchemaMethod = (schema, processors = {}) => (params) => {
      const ctx = initializeContext({ ...params, processors });
      processSchema(schema, ctx);
      extractDefs(ctx, schema);
      return finalize(ctx, schema);
    };
    createStandardJSONSchemaMethod = (schema, io, processors = {}) => (params) => {
      const { libraryOptions, target } = params ?? {};
      const ctx = initializeContext({ ...libraryOptions ?? {}, target, io, processors });
      processSchema(schema, ctx);
      extractDefs(ctx, schema);
      return finalize(ctx, schema);
    };
  }
});

// node_modules/zod/v4/core/json-schema-processors.js
function aggregateChecks(schema) {
  const agg = {};
  const def3 = schema._zod.def;
  const list = schema._zod.traits.has("$ZodCheck") ? [schema, ...def3.checks ?? []] : def3.checks ?? [];
  for (const ch of list)
    contributors[ch._zod.def.check]?.(agg, ch._zod.def);
  const bag = schema._zod.bag;
  if (bag.minimum !== void 0)
    narrowMin(agg, "minimum", bag.minimum);
  if (bag.exclusiveMinimum !== void 0)
    narrowMin(agg, "exclusiveMinimum", bag.exclusiveMinimum);
  if (bag.maximum !== void 0)
    narrowMax(agg, "maximum", bag.maximum);
  if (bag.exclusiveMaximum !== void 0)
    narrowMax(agg, "exclusiveMaximum", bag.exclusiveMaximum);
  if (bag.multipleOf !== void 0)
    addDivisor(agg, bag.multipleOf);
  if (bag.format !== void 0) {
    agg.format ?? (agg.format = bag.format);
    if (bag.format.includes("int"))
      agg.isInt = true;
  }
  if (bag.mime)
    intersectMime(agg, bag.mime);
  for (const pattern of bag.patterns ?? [])
    addPattern(agg, pattern);
  return agg;
}
function inputOptin(schema) {
  const def3 = schema._zod.def;
  if (def3.type === "pipe" && def3.in._zod.traits.has("$ZodTransform")) {
    return inputOptin(def3.out);
  }
  if (def3.type === "catch") {
    return inputOptin(def3.innerType);
  }
  return schema._zod.optin;
}
function stringifyKeyNames(bySchema, json, visited) {
  if (json.$ref) {
    if (visited.has(json))
      return json;
    visited.add(json);
    const def3 = bySchema.get(json)?.def;
    if (!def3)
      return json;
    const inlined = stringifyKeyNames(bySchema, def3, visited);
    return inlined === def3 ? json : inlined;
  }
  for (const keyword of ["anyOf", "oneOf"]) {
    const branches = json[keyword];
    if (!Array.isArray(branches))
      continue;
    const mapped = branches.map((branch) => stringifyKeyNames(bySchema, branch, visited));
    if (mapped.some((branch, i) => branch !== branches[i]))
      json = { ...json, [keyword]: mapped };
  }
  const types = Array.isArray(json.type) ? json.type : [json.type];
  const numericType = !types.includes("string") && types.some((t) => t === "number" || t === "integer");
  const values = json.enum ?? (json.const !== void 0 ? [json.const] : void 0);
  if (!numericType && !values?.some((v) => typeof v === "number"))
    return json;
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf, format, id, ...rest2 } = json;
  if (rest2.enum)
    rest2.enum = rest2.enum.map((v) => typeof v === "number" ? String(v) : v);
  else if (typeof rest2.const === "number")
    rest2.const = String(rest2.const);
  if (!numericType)
    return rest2;
  rest2.type = "string";
  if (!values)
    rest2.pattern = (types.includes("number") ? number : integer).source;
  return rest2;
}
function rewriteKeyNames(ctx) {
  const bySchema = /* @__PURE__ */ new Map();
  for (const entry of ctx.seen.values()) {
    if (entry.def && !bySchema.has(entry.schema))
      bySchema.set(entry.schema, entry);
  }
  const rewrites = /* @__PURE__ */ new Map();
  for (const record2 of pendingRecords.get(ctx) ?? []) {
    const seen = ctx.seen.get(record2);
    const names = (seen?.def ?? seen?.schema)?.propertyNames;
    if (!names || names === true || rewrites.has(names))
      continue;
    const rewritten = stringifyKeyNames(bySchema, names, /* @__PURE__ */ new Set());
    if (rewritten !== names)
      rewrites.set(names, rewritten);
  }
  if (!rewrites.size)
    return;
  for (const entry of ctx.seen.values()) {
    for (const carrier of [entry.schema, entry.def]) {
      const rewritten = carrier && rewrites.get(carrier.propertyNames);
      if (rewritten)
        carrier.propertyNames = rewritten;
    }
  }
}
function serializeDefaultValue(value, schema, ctx, json, params) {
  let unrepresentable = false;
  const serialized = JSON.stringify(value, (_, val) => {
    if (typeof val !== "bigint")
      return val;
    unrepresentable = true;
    return null;
  });
  if (!unrepresentable)
    return JSON.parse(serialized);
  handleUnrepresentable(schema, ctx, json, params, "BigInt defaults cannot be represented in JSON Schema");
  return UNREPRESENTABLE_DEFAULT;
}
var narrowMin, narrowMax, narrowBoth, addDivisor, addPattern, intersectMime, setFormat, minContributor, maxContributor, formatContributor, contributors, formatMap, exactPatterns, exactPattern, stringProcessor, numberProcessor, booleanProcessor, nullProcessor, neverProcessor, unknownProcessor, enumProcessor, literalProcessor, customProcessor, transformProcessor, arrayProcessor, objectProcessor, unionProcessor, intersectionProcessor, pendingRecords, recordProcessor, nullableProcessor, nonoptionalProcessor, UNREPRESENTABLE_DEFAULT, defaultProcessor, prefaultProcessor, catchProcessor, pipeProcessor, readonlyProcessor, optionalProcessor;
var init_json_schema_processors = __esm({
  "node_modules/zod/v4/core/json-schema-processors.js"() {
    init_regexes();
    init_schemas();
    init_to_json_schema();
    init_util();
    narrowMin = (agg, key, value) => {
      if (agg[key] === void 0 || value > agg[key])
        agg[key] = value;
    };
    narrowMax = (agg, key, value) => {
      if (agg[key] === void 0 || value < agg[key])
        agg[key] = value;
    };
    narrowBoth = (agg, value) => {
      narrowMin(agg, "minimum", value);
      narrowMax(agg, "maximum", value);
    };
    addDivisor = (agg, value) => {
      agg.multipleOf ?? (agg.multipleOf = []);
      if (!agg.multipleOf.includes(value))
        agg.multipleOf.push(value);
    };
    addPattern = (agg, pattern) => {
      agg.patterns ?? (agg.patterns = /* @__PURE__ */ new Set());
      agg.patterns.add(pattern);
    };
    intersectMime = (agg, mime) => {
      agg.mime = agg.mime ? agg.mime.filter((m) => mime.includes(m)) : [...mime];
    };
    setFormat = (agg, format) => {
      agg.format = format;
      if (format.includes("int"))
        agg.isInt = true;
    };
    minContributor = (agg, def3) => narrowMin(agg, "minimum", def3.minimum);
    maxContributor = (agg, def3) => narrowMax(agg, "maximum", def3.maximum);
    formatContributor = (ranges) => (agg, def3) => {
      setFormat(agg, def3.format);
      const [minimum, maximum] = ranges[def3.format];
      narrowMin(agg, "minimum", minimum);
      narrowMax(agg, "maximum", maximum);
    };
    contributors = {
      greater_than: (agg, def3) => narrowMin(agg, def3.inclusive ? "minimum" : "exclusiveMinimum", def3.value),
      less_than: (agg, def3) => narrowMax(agg, def3.inclusive ? "maximum" : "exclusiveMaximum", def3.value),
      multiple_of: (agg, def3) => addDivisor(agg, def3.value),
      number_format: formatContributor(NUMBER_FORMAT_RANGES),
      bigint_format: formatContributor(BIGINT_FORMAT_RANGES),
      min_length: minContributor,
      max_length: maxContributor,
      length_equals: (agg, def3) => narrowBoth(agg, def3.length),
      min_size: minContributor,
      max_size: maxContributor,
      size_equals: (agg, def3) => narrowBoth(agg, def3.size),
      string_format: (agg, def3) => {
        setFormat(agg, def3.format);
        if (def3.pattern)
          addPattern(agg, def3.pattern);
        if (def3.format === "base64" || def3.format === "base64url")
          agg.contentEncoding = def3.format;
        if (def3.local || def3.precision === -1)
          agg.laxFormat = true;
      },
      mime_type: (agg, def3) => intersectMime(agg, def3.mime)
    };
    formatMap = {
      guid: "uuid",
      url: "uri",
      datetime: "date-time",
      json_string: "json-string",
      regex: ""
      // do not set
    };
    exactPatterns = /* @__PURE__ */ new Map([
      [base64Charset, base64],
      [base64urlCharset, base64url]
    ]);
    exactPattern = (p) => exactPatterns.get(p) ?? p;
    stringProcessor = (schema, ctx, _json, _params) => {
      const json = _json;
      json.type = "string";
      const { minimum, maximum, format, patterns, contentEncoding, laxFormat } = aggregateChecks(schema);
      if (typeof minimum === "number")
        json.minLength = minimum;
      if (typeof maximum === "number")
        json.maxLength = maximum;
      if (format) {
        json.format = formatMap[format] ?? format;
        if (json.format === "")
          delete json.format;
        if (format === "time" || laxFormat) {
          delete json.format;
        }
      }
      if (contentEncoding)
        json.contentEncoding = contentEncoding;
      if (patterns && patterns.size > 0) {
        const patternList = [...patterns].map(exactPattern);
        if (patternList.length === 1)
          json.pattern = patternList[0].source;
        else if (patternList.length > 1) {
          json.allOf = [
            ...patternList.map((regex) => ({
              ...ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0" ? { type: "string" } : {},
              pattern: regex.source
            }))
          ];
        }
      }
    };
    numberProcessor = (schema, ctx, _json, params) => {
      const json = _json;
      const { minimum, maximum, multipleOf, exclusiveMaximum, exclusiveMinimum, isInt } = aggregateChecks(schema);
      json.type = isInt ? "integer" : "number";
      const exMin = typeof exclusiveMinimum === "number" && exclusiveMinimum >= (minimum ?? Number.NEGATIVE_INFINITY);
      const exMax = typeof exclusiveMaximum === "number" && exclusiveMaximum <= (maximum ?? Number.POSITIVE_INFINITY);
      const legacy = ctx.target === "draft-04" || ctx.target === "openapi-3.0";
      if (exMin) {
        if (legacy) {
          json.minimum = exclusiveMinimum;
          json.exclusiveMinimum = true;
        } else {
          json.exclusiveMinimum = exclusiveMinimum;
        }
      } else if (typeof minimum === "number") {
        json.minimum = minimum;
      }
      if (exMax) {
        if (legacy) {
          json.maximum = exclusiveMaximum;
          json.exclusiveMaximum = true;
        } else {
          json.exclusiveMaximum = exclusiveMaximum;
        }
      } else if (typeof maximum === "number") {
        json.maximum = maximum;
      }
      if (multipleOf) {
        const divisors = /* @__PURE__ */ new Set();
        for (const divisor of multipleOf) {
          if (Number.isFinite(divisor) && divisor !== 0)
            divisors.add(Math.abs(divisor));
          else
            handleUnrepresentable(schema, ctx, json, params, `A multipleOf divisor of ${divisor} cannot be represented in JSON Schema`);
        }
        const [first, ...rest2] = divisors;
        if (first !== void 0)
          json.multipleOf = first;
        if (rest2.length)
          json.allOf = [...json.allOf ?? [], ...rest2.map((m) => ({ multipleOf: m }))];
      }
    };
    booleanProcessor = (_schema, _ctx, json, _params) => {
      json.type = "boolean";
    };
    nullProcessor = (_schema, ctx, json, _params) => {
      if (ctx.target === "openapi-3.0") {
        json.type = "string";
        json.nullable = true;
        json.enum = [null];
      } else {
        json.type = "null";
      }
    };
    neverProcessor = (_schema, _ctx, json, _params) => {
      json.not = {};
    };
    unknownProcessor = (_schema, _ctx, _json, _params) => {
    };
    enumProcessor = (schema, _ctx, json, _params) => {
      const def3 = schema._zod.def;
      const values = getEnumValues(def3.entries);
      if (values.length === 0) {
        json.not = {};
        return;
      }
      if (values.every((v) => typeof v === "number"))
        json.type = "number";
      if (values.every((v) => typeof v === "string"))
        json.type = "string";
      json.enum = values;
    };
    literalProcessor = (schema, ctx, json, params) => {
      const def3 = schema._zod.def;
      if (def3.values.length === 0) {
        json.not = {};
        return;
      }
      const vals = [];
      for (const val of def3.values) {
        if (val === void 0) {
          if (handleUnrepresentable(schema, ctx, json, params, "Literal `undefined` cannot be represented in JSON Schema"))
            return;
        } else if (typeof val === "bigint") {
          if (handleUnrepresentable(schema, ctx, json, params, "BigInt literals cannot be represented in JSON Schema"))
            return;
          vals.push(Number(val));
        } else {
          vals.push(val);
        }
      }
      if (vals.length === 0) {
      } else if (vals.length === 1) {
        const val = vals[0];
        json.type = val === null ? "null" : typeof val;
        if (ctx.target === "draft-04" || ctx.target === "openapi-3.0") {
          json.enum = [val];
        } else {
          json.const = val;
        }
      } else {
        if (vals.every((v) => typeof v === "number"))
          json.type = "number";
        if (vals.every((v) => typeof v === "string"))
          json.type = "string";
        if (vals.every((v) => typeof v === "boolean"))
          json.type = "boolean";
        if (vals.every((v) => v === null))
          json.type = "null";
        json.enum = vals;
      }
    };
    customProcessor = (schema, ctx, json, params) => {
      handleUnrepresentable(schema, ctx, json, params, "Custom types cannot be represented in JSON Schema");
    };
    transformProcessor = (schema, ctx, json, params) => {
      handleUnrepresentable(schema, ctx, json, params, "Transforms cannot be represented in JSON Schema");
    };
    arrayProcessor = (schema, ctx, _json, params) => {
      const json = _json;
      const def3 = schema._zod.def;
      const { minimum, maximum } = aggregateChecks(schema);
      if (typeof minimum === "number")
        json.minItems = minimum;
      if (typeof maximum === "number")
        json.maxItems = maximum;
      json.type = "array";
      json.items = processSchema(def3.element, ctx, {
        ...params,
        path: [...params.path, "items"]
      });
    };
    objectProcessor = (schema, ctx, _json, params) => {
      const json = _json;
      const def3 = schema._zod.def;
      const shape = def3.shape;
      const symbolKeys = Object.getOwnPropertySymbols(shape);
      if (symbolKeys.length && handleUnrepresentable(schema, ctx, json, params, "Symbol keys cannot be represented in JSON Schema")) {
        return;
      }
      json.type = "object";
      json.properties = {};
      for (const key in shape) {
        assignProp(json.properties, key, processSchema(shape[key], ctx, {
          ...params,
          path: [...params.path, "properties", key]
        }));
      }
      const requiredKeys = [];
      for (const key of Object.keys(shape)) {
        const field = def3.shape[key];
        if (ctx.io === "input" ? inputOptin(field) === void 0 : field._zod.optout === void 0) {
          requiredKeys.push(key);
        }
      }
      if (requiredKeys.length > 0) {
        json.required = requiredKeys;
      }
      if (def3.catchall?._zod.def.type === "never") {
        json.additionalProperties = false;
      } else if (!def3.catchall) {
        if (ctx.io === "output")
          json.additionalProperties = false;
      } else if (def3.catchall) {
        json.additionalProperties = processSchema(def3.catchall, ctx, {
          ...params,
          path: [...params.path, "additionalProperties"]
        });
      }
    };
    unionProcessor = (schema, ctx, json, params) => {
      const def3 = schema._zod.def;
      const isExclusive = def3.inclusive === false;
      const options = def3.options.map((x, i) => processSchema(x, ctx, {
        ...params,
        path: [...params.path, isExclusive ? "oneOf" : "anyOf", i]
      }));
      if (isExclusive) {
        json.oneOf = options;
      } else {
        json.anyOf = options;
      }
    };
    intersectionProcessor = (schema, ctx, json, params) => {
      const def3 = schema._zod.def;
      const a = processSchema(def3.left, ctx, {
        ...params,
        path: [...params.path, "allOf", 0]
      });
      const b = processSchema(def3.right, ctx, {
        ...params,
        path: [...params.path, "allOf", 1]
      });
      const isSimpleIntersection = (val) => "allOf" in val && Object.keys(val).length === 1;
      const allOf = [
        ...isSimpleIntersection(a) ? a.allOf : [a],
        ...isSimpleIntersection(b) ? b.allOf : [b]
      ];
      json.allOf = allOf;
      ctx.intersections.push(allOf);
    };
    pendingRecords = /* @__PURE__ */ new WeakMap();
    recordProcessor = (schema, ctx, _json, params) => {
      const json = _json;
      const def3 = schema._zod.def;
      json.type = "object";
      const keyType = def3.keyType;
      const patterns = aggregateChecks(keyType).patterns;
      if (def3.mode === "loose" && patterns && patterns.size > 0) {
        const valueSchema = processSchema(def3.valueType, ctx, {
          ...params,
          path: [...params.path, "patternProperties", "*"]
        });
        json.patternProperties = {};
        for (const pattern of patterns) {
          assignProp(json.patternProperties, exactPattern(pattern).source, valueSchema);
        }
      } else {
        if (ctx.target === "draft-07" || ctx.target === "draft-2020-12") {
          json.propertyNames = processSchema(def3.keyType, ctx, {
            ...params,
            path: [...params.path, "propertyNames"]
          });
          let pending = pendingRecords.get(ctx);
          if (!pending) {
            pending = [];
            pendingRecords.set(ctx, pending);
            ctx.deferred.push(() => rewriteKeyNames(ctx));
          }
          pending.push(schema);
        }
        json.additionalProperties = processSchema(def3.valueType, ctx, {
          ...params,
          path: [...params.path, "additionalProperties"]
        });
      }
      const keyValues = keyType._zod.values;
      const omittableOnInput = ctx.io === "input" && inputOptin(def3.valueType) !== void 0;
      if (keyValues && !def3.partial && !omittableOnInput) {
        const validKeyValues = [...keyValues].filter((v) => typeof v === "string" || typeof v === "number");
        if (validKeyValues.length > 0) {
          json.required = validKeyValues.map(String);
        }
      }
    };
    nullableProcessor = (schema, ctx, json, params) => {
      const def3 = schema._zod.def;
      const inner = processSchema(def3.innerType, ctx, params);
      const seen = ctx.seen.get(schema);
      if (ctx.target === "openapi-3.0") {
        seen.ref = def3.innerType;
        json.nullable = true;
      } else {
        json.anyOf = [inner, { type: "null" }];
      }
    };
    nonoptionalProcessor = (schema, ctx, _json, params) => {
      const def3 = schema._zod.def;
      processSchema(def3.innerType, ctx, params);
      const seen = ctx.seen.get(schema);
      seen.ref = def3.innerType;
    };
    UNREPRESENTABLE_DEFAULT = Symbol();
    defaultProcessor = (schema, ctx, json, params) => {
      const def3 = schema._zod.def;
      processSchema(def3.innerType, ctx, params);
      const seen = ctx.seen.get(schema);
      seen.ref = def3.innerType;
      const value = serializeDefaultValue(def3.defaultValue, schema, ctx, json, params);
      if (value !== UNREPRESENTABLE_DEFAULT)
        json.default = value;
    };
    prefaultProcessor = (schema, ctx, json, params) => {
      const def3 = schema._zod.def;
      processSchema(def3.innerType, ctx, params);
      const seen = ctx.seen.get(schema);
      seen.ref = def3.innerType;
      if (ctx.io !== "input")
        return;
      const value = serializeDefaultValue(def3.defaultValue, schema, ctx, json, params);
      if (value !== UNREPRESENTABLE_DEFAULT)
        json._prefault = value;
    };
    catchProcessor = (schema, ctx, json, params) => {
      const def3 = schema._zod.def;
      processSchema(def3.innerType, ctx, params);
      const seen = ctx.seen.get(schema);
      seen.ref = def3.innerType;
      let catchValue;
      try {
        catchValue = def3.catchValue(void 0);
      } catch {
        handleUnrepresentable(schema, ctx, json, params, "Dynamic catch values are not supported in JSON Schema");
        return;
      }
      json.default = catchValue;
    };
    pipeProcessor = (schema, ctx, _json, params) => {
      const def3 = schema._zod.def;
      const inIsTransform = def3.in._zod.traits.has("$ZodTransform");
      const innerType = ctx.io === "input" ? inIsTransform ? def3.out : def3.in : def3.out;
      processSchema(innerType, ctx, params);
      const seen = ctx.seen.get(schema);
      seen.ref = innerType;
    };
    readonlyProcessor = (schema, ctx, json, params) => {
      const def3 = schema._zod.def;
      processSchema(def3.innerType, ctx, params);
      const seen = ctx.seen.get(schema);
      seen.ref = def3.innerType;
      json.readOnly = true;
    };
    optionalProcessor = (schema, ctx, _json, params) => {
      const def3 = schema._zod.def;
      processSchema(def3.innerType, ctx, params);
      const seen = ctx.seen.get(schema);
      seen.ref = def3.innerType;
    };
  }
});

// node_modules/zod/v4/core/json-schema.js
var init_json_schema = __esm({
  "node_modules/zod/v4/core/json-schema.js"() {
  }
});

// node_modules/zod/v4/core/index.js
var init_core2 = __esm({
  "node_modules/zod/v4/core/index.js"() {
    init_core();
    init_parse();
    init_errors();
    init_schemas();
    init_memoizer();
    init_checks();
    init_versions();
    init_util();
    init_regexes();
    init_locales();
    init_registries();
    init_doc();
    init_compile();
    init_api();
    init_to_json_schema();
    init_json_schema();
  }
});

// node_modules/zod/v4/classic/checks.js
var init_checks2 = __esm({
  "node_modules/zod/v4/classic/checks.js"() {
    init_core2();
  }
});

// node_modules/zod/v4/classic/errors.js
function _lazyMethod(proto, key, make) {
  Object.defineProperty(proto, key, {
    configurable: true,
    enumerable: false,
    get() {
      const value = make(this);
      Object.defineProperty(this, key, { value, configurable: true, writable: true });
      return value;
    },
    set(value) {
      Object.defineProperty(this, key, { value, configurable: true, writable: true });
    }
  });
}
var _installedErrorProtos, initializer2, ZodRealError;
var init_errors2 = __esm({
  "node_modules/zod/v4/classic/errors.js"() {
    init_core2();
    init_core2();
    init_util();
    _installedErrorProtos = /* @__PURE__ */ new WeakSet([Object.prototype, Error.prototype]);
    initializer2 = (inst, issues) => {
      $ZodError.init(inst, issues);
      inst.name = "ZodError";
      const proto = Object.getPrototypeOf(inst);
      if (_installedErrorProtos.has(proto))
        return;
      _installedErrorProtos.add(proto);
      _lazyMethod(proto, "format", (self) => (mapper) => formatError(self, mapper));
      _lazyMethod(proto, "flatten", (self) => (mapper) => flattenError(self, mapper));
      _lazyMethod(proto, "addIssue", (self) => (issue2) => {
        self.issues.push(issue2);
        self.message = JSON.stringify(self.issues, jsonStringifyReplacer, 2);
      });
      _lazyMethod(proto, "addIssues", (self) => (issues2) => {
        self.issues.push(...issues2);
        self.message = JSON.stringify(self.issues, jsonStringifyReplacer, 2);
      });
      Object.defineProperty(proto, "isEmpty", {
        configurable: true,
        enumerable: false,
        get() {
          return this.issues.length === 0;
        }
      });
    };
    ZodRealError = /* @__PURE__ */ $constructor("ZodError", initializer2, void 0, {
      Parent: Error
    });
  }
});

// node_modules/zod/v4/classic/parse.js
var parse, parseAsync, safeParse2, safeParseAsync, encode, decode, encodeAsync, decodeAsync, safeEncode, safeDecode, safeEncodeAsync, safeDecodeAsync;
var init_parse2 = __esm({
  "node_modules/zod/v4/classic/parse.js"() {
    init_core2();
    init_errors2();
    init_core2();
    parse = /* @__PURE__ */ _parse(ZodRealError);
    parseAsync = /* @__PURE__ */ _parseAsync(ZodRealError);
    safeParse2 = /* @__PURE__ */ _safeParse(ZodRealError);
    safeParseAsync = /* @__PURE__ */ _safeParseAsync(ZodRealError);
    encode = /* @__PURE__ */ _encode(ZodRealError);
    decode = /* @__PURE__ */ _decode(ZodRealError);
    encodeAsync = /* @__PURE__ */ _encodeAsync(ZodRealError);
    decodeAsync = /* @__PURE__ */ _decodeAsync(ZodRealError);
    safeEncode = /* @__PURE__ */ _safeEncode(ZodRealError);
    safeDecode = /* @__PURE__ */ _safeDecode(ZodRealError);
    safeEncodeAsync = /* @__PURE__ */ _safeEncodeAsync(ZodRealError);
    safeDecodeAsync = /* @__PURE__ */ _safeDecodeAsync(ZodRealError);
  }
});

// node_modules/zod/v4/classic/schemas.js
function _ensureDefaultLocale() {
  if (!globalConfig.localeError)
    config(en_default());
}
function _ensureDefaultMemoizer() {
  if (!globalConfig.memoizer)
    config({ memoizer: memoizer() });
}
function string2(params) {
  return _string(ZodString, params);
}
function number2(params) {
  return _number(ZodNumber, params);
}
function int(params) {
  return _int(ZodNumberFormat, params);
}
function boolean2(params) {
  return _boolean(ZodBoolean, params);
}
function _null3(params) {
  return _null2(ZodNull, params);
}
function unknown() {
  return _unknown(ZodUnknown);
}
function never(params) {
  return _never(ZodNever, params);
}
function array(element, params) {
  return _array(ZodArray, element, params);
}
function object(shape, params) {
  const def3 = {
    type: "object",
    shape: shape ?? {},
    ...util_exports.normalizeParams(params)
  };
  return new ZodObject(def3);
}
function looseObject(shape, params) {
  return new ZodObject({
    type: "object",
    shape,
    catchall: unknown(),
    ...util_exports.normalizeParams(params)
  });
}
function union(options, params) {
  return new ZodUnion({
    type: "union",
    options,
    ...util_exports.normalizeParams(params)
  });
}
function discriminatedUnion(discriminator, options, params) {
  return new ZodDiscriminatedUnion({
    type: "union",
    options,
    discriminator,
    ...util_exports.normalizeParams(params)
  });
}
function intersection(left, right) {
  return new ZodIntersection({
    type: "intersection",
    left,
    right
  });
}
function record(keyType, valueType, params) {
  if (!valueType || !valueType._zod) {
    return new ZodRecord({
      type: "record",
      keyType: string2(),
      valueType: keyType,
      ...util_exports.normalizeParams(valueType)
    });
  }
  return new ZodRecord({
    type: "record",
    keyType,
    valueType,
    ...util_exports.normalizeParams(params)
  });
}
function _enum(values, params) {
  const entries = Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values;
  return new ZodEnum({
    type: "enum",
    entries,
    ...util_exports.normalizeParams(params)
  });
}
function literal(value, params) {
  return new ZodLiteral({
    type: "literal",
    values: Array.isArray(value) ? value : [value],
    ...util_exports.normalizeParams(params)
  });
}
function transform(fn) {
  return new ZodTransform({
    type: "transform",
    transform: fn
  });
}
function optional(innerType) {
  return new ZodOptional({
    type: "optional",
    innerType
  });
}
function exactOptional(innerType) {
  return new ZodExactOptional({
    type: "optional",
    innerType
  });
}
function nullable(innerType) {
  return new ZodNullable({
    type: "nullable",
    innerType
  });
}
function _default(innerType, defaultValue) {
  return new ZodDefault({
    type: "default",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : util_exports.shallowClone(defaultValue);
    }
  });
}
function prefault(innerType, defaultValue) {
  return new ZodPrefault({
    type: "prefault",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : util_exports.shallowClone(defaultValue);
    }
  });
}
function nonoptional(innerType, params) {
  return new ZodNonOptional({
    type: "nonoptional",
    innerType,
    ...util_exports.normalizeParams(params)
  });
}
function _catch(innerType, catchValue) {
  return new ZodCatch({
    type: "catch",
    innerType,
    catchValue: typeof catchValue === "function" ? catchValue : util_exports.constantCatch(catchValue)
  });
}
function pipe(in_, out) {
  return new ZodPipe({
    type: "pipe",
    in: in_,
    out
    // ...util.normalizeParams(params),
  });
}
function readonly(innerType) {
  return new ZodReadonly({
    type: "readonly",
    innerType
  });
}
function custom(fn, _params) {
  return _custom(ZodCustom, fn ?? (() => true), _params);
}
function refine(fn, _params = {}) {
  return _refine(ZodCustom, fn, _params);
}
function superRefine(fn, params) {
  return _superRefine(fn, params);
}
function preprocess(fn, schema) {
  return new ZodPreprocess({
    type: "pipe",
    in: transform(fn),
    out: schema
  });
}
var ZodType, _ZodString, ZodString, ZodStringFormat, ZodISODateTime, ZodISODate, ZodISOTime, ZodISODuration, ZodEmail, ZodGUID, ZodUUID, ZodURL, ZodEmoji, ZodNanoID, ZodCUID, ZodCUID2, ZodULID, ZodXID, ZodKSUID, ZodIPv4, ZodIPv6, ZodCIDRv4, ZodCIDRv6, ZodBase64, ZodBase64URL, ZodE164, ZodJWT, ZodNumber, ZodNumberFormat, ZodBoolean, ZodNull, ZodUnknown, ZodNever, ZodArray, ZodObject, ZodUnion, ZodDiscriminatedUnion, ZodIntersection, ZodRecord, ZodEnum, ZodLiteral, ZodTransform, ZodOptional, ZodExactOptional, ZodNullable, ZodDefault, ZodPrefault, ZodNonOptional, ZodCatch, ZodPipe, ZodPreprocess, ZodReadonly, ZodCustom;
var init_schemas2 = __esm({
  "node_modules/zod/v4/classic/schemas.js"() {
    init_core2();
    init_core2();
    init_json_schema_processors();
    init_to_json_schema();
    init_en();
    init_checks2();
    init_parse2();
    ZodType = /* @__PURE__ */ $constructor("ZodType", (inst, def3) => {
      _ensureDefaultLocale();
      $ZodType.init(inst, def3);
      inst.def = def3;
      inst.type = def3.type;
      return inst;
    }, {
      check(...chks) {
        const def3 = this.def;
        return this.clone(util_exports.mergeDefs(def3, {
          checks: [
            ...def3.checks ?? [],
            ...chks.map((ch) => typeof ch === "function" ? { _zod: { check: ch, def: { check: "custom" }, onattach: [] } } : ch)
          ]
        }), { parent: true });
      },
      with(...chks) {
        return this.check(...chks);
      },
      clone(def3, params) {
        return clone(this, def3, params);
      },
      brand() {
        return this;
      },
      register(reg, meta2) {
        reg.add(this, meta2);
        return this;
      },
      refine(check, params) {
        return this.check(refine(check, params));
      },
      superRefine(refinement, params) {
        return this.check(superRefine(refinement, params));
      },
      overwrite(fn) {
        return this.check(_overwrite(fn));
      },
      optional() {
        return optional(this);
      },
      exactOptional() {
        return exactOptional(this);
      },
      nullable() {
        return nullable(this);
      },
      nullish() {
        return optional(nullable(this));
      },
      nonoptional(params) {
        return nonoptional(this, params);
      },
      array() {
        return array(this);
      },
      or(arg) {
        return union([this, arg]);
      },
      and(arg) {
        return intersection(this, arg);
      },
      transform(tx) {
        return pipe(this, transform(tx));
      },
      default(d) {
        return _default(this, d);
      },
      prefault(d) {
        return prefault(this, d);
      },
      catch(params) {
        return _catch(this, params);
      },
      pipe(target) {
        return pipe(this, target);
      },
      readonly() {
        return readonly(this);
      },
      describe(description) {
        const cl = this.clone();
        globalRegistry.add(cl, { description });
        return cl;
      },
      meta(...args) {
        if (args.length === 0)
          return globalRegistry.get(this);
        const cl = this.clone();
        globalRegistry.add(cl, args[0]);
        return cl;
      },
      isOptional() {
        return this.safeParse(void 0).success;
      },
      isNullable() {
        return this.safeParse(null).success;
      },
      apply(fn, ...args) {
        return args.length === 0 ? fn(this) : fn(this, ...args);
      },
      // Overrides core's `~standard` to add `jsonSchema`. Must stay a prototype entry: redefining it per instance demotes instances to dictionary mode.
      get "~standard"() {
        return util_exports.hide(this, "~standard", {
          ...standardProps(this),
          jsonSchema: {
            input: createStandardJSONSchemaMethod(this, "input"),
            output: createStandardJSONSchemaMethod(this, "output")
          }
        });
      },
      set "~standard"(value) {
        util_exports.own(this, "~standard", value);
      },
      parse: function _parse2(data, params) {
        return parse(this, data, params, { callee: _parse2 });
      },
      parseAsync: async function _parseAsync2(data, params) {
        return await parseAsync(this, data, params, { callee: _parseAsync2 });
      },
      safeParse(data, params) {
        return safeParse2(this, data, params);
      },
      async safeParseAsync(data, params) {
        return safeParseAsync(this, data, params);
      },
      // `spa` is an alias: same function object as `safeParseAsync`, as before.
      get spa() {
        return this?.safeParseAsync;
      },
      set spa(value) {
        util_exports.own(this, "spa", value);
      },
      validate(data, params) {
        return validate(this, data, params);
      },
      validateAsync(data, params) {
        return validateAsync(this, data, params);
      },
      encode: function _encode2(data, params) {
        return encode(this, data, params, { callee: _encode2 });
      },
      decode: function _decode2(data, params) {
        return decode(this, data, params, { callee: _decode2 });
      },
      encodeAsync: async function _encodeAsync2(data, params) {
        return await encodeAsync(this, data, params, { callee: _encodeAsync2 });
      },
      decodeAsync: async function _decodeAsync2(data, params) {
        return await decodeAsync(this, data, params, { callee: _decodeAsync2 });
      },
      safeEncode(data, params) {
        return safeEncode(this, data, params);
      },
      safeDecode(data, params) {
        return safeDecode(this, data, params);
      },
      async safeEncodeAsync(data, params) {
        return safeEncodeAsync(this, data, params);
      },
      async safeDecodeAsync(data, params) {
        return safeDecodeAsync(this, data, params);
      },
      toJSONSchema(params) {
        return createToJSONSchemaMethod(this, {})(params);
      },
      // Reads through to the registry on every access, so it must not cache.
      get description() {
        return globalRegistry.get(this)?.description;
      },
      // No setter: `schema._def = x` throws, as it did when `_def` was a non-writable own property.
      get _def() {
        return this._zod.def;
      }
    });
    _ZodString = /* @__PURE__ */ $constructor(
      "_ZodString",
      (inst, def3) => {
        $ZodString.init(inst, def3);
        ZodType.init(inst, def3);
        inst._zod.processJSONSchema = (ctx, json, params) => stringProcessor(inst, ctx, json, params);
      },
      /* @__PURE__ */ util_exports.derived({
        format: (inst) => aggregateChecks(inst).format ?? null,
        minLength: (inst) => aggregateChecks(inst).minimum ?? null,
        maxLength: (inst) => aggregateChecks(inst).maximum ?? null
      }, {
        regex(...args) {
          return this.check(_regex(...args));
        },
        includes(...args) {
          return this.check(_includes(...args));
        },
        startsWith(...args) {
          return this.check(_startsWith(...args));
        },
        endsWith(...args) {
          return this.check(_endsWith(...args));
        },
        min(...args) {
          return this.check(_minLength(...args));
        },
        max(...args) {
          return this.check(_maxLength(...args));
        },
        length(...args) {
          return this.check(_length(...args));
        },
        nonempty(...args) {
          return this.check(_minLength(1, ...args));
        },
        lowercase(params) {
          return this.check(_lowercase(params));
        },
        uppercase(params) {
          return this.check(_uppercase(params));
        },
        trim() {
          return this.check(_trim());
        },
        normalize(...args) {
          return this.check(_normalize(...args));
        },
        toLowerCase() {
          return this.check(_toLowerCase());
        },
        toUpperCase() {
          return this.check(_toUpperCase());
        },
        slugify() {
          return this.check(_slugify());
        }
      })
    );
    ZodString = /* @__PURE__ */ $constructor("ZodString", (inst, def3) => {
      $ZodString.init(inst, def3);
      _ZodString.init(inst, def3);
    }, {
      email(params) {
        return this.check(_email(ZodEmail, params));
      },
      url(params) {
        return this.check(_url(ZodURL, params));
      },
      jwt(params) {
        return this.check(_jwt(ZodJWT, params));
      },
      emoji(params) {
        return this.check(_emoji2(ZodEmoji, params));
      },
      guid(params) {
        return this.check(_guid(ZodGUID, params));
      },
      uuid(params) {
        return this.check(_uuid(ZodUUID, params));
      },
      uuidv4(params) {
        return this.check(_uuidv4(ZodUUID, params));
      },
      uuidv6(params) {
        return this.check(_uuidv6(ZodUUID, params));
      },
      uuidv7(params) {
        return this.check(_uuidv7(ZodUUID, params));
      },
      nanoid(params) {
        return this.check(_nanoid(ZodNanoID, params));
      },
      cuid(params) {
        return this.check(_cuid(ZodCUID, params));
      },
      cuid2(params) {
        return this.check(_cuid2(ZodCUID2, params));
      },
      ulid(params) {
        return this.check(_ulid(ZodULID, params));
      },
      base64(params) {
        return this.check(_base64(ZodBase64, params));
      },
      base64url(params) {
        return this.check(_base64url(ZodBase64URL, params));
      },
      xid(params) {
        return this.check(_xid(ZodXID, params));
      },
      ksuid(params) {
        return this.check(_ksuid(ZodKSUID, params));
      },
      ipv4(params) {
        return this.check(_ipv4(ZodIPv4, params));
      },
      ipv6(params) {
        return this.check(_ipv6(ZodIPv6, params));
      },
      cidrv4(params) {
        return this.check(_cidrv4(ZodCIDRv4, params));
      },
      cidrv6(params) {
        return this.check(_cidrv6(ZodCIDRv6, params));
      },
      e164(params) {
        return this.check(_e164(ZodE164, params));
      },
      datetime(params) {
        return this.check(_isoDateTime(ZodISODateTime, params));
      },
      date(params) {
        return this.check(_isoDate(ZodISODate, params));
      },
      time(params) {
        return this.check(_isoTime(ZodISOTime, params));
      },
      duration(params) {
        return this.check(_isoDuration(ZodISODuration, params));
      }
    });
    ZodStringFormat = /* @__PURE__ */ $constructor("ZodStringFormat", (inst, def3) => {
      $ZodStringFormat.init(inst, def3);
      _ZodString.init(inst, def3);
    });
    ZodISODateTime = /* @__PURE__ */ $constructor("ZodISODateTime", (inst, def3) => {
      $ZodISODateTime.init(inst, def3);
      ZodStringFormat.init(inst, def3);
    });
    ZodISODate = /* @__PURE__ */ $constructor("ZodISODate", (inst, def3) => {
      $ZodISODate.init(inst, def3);
      ZodStringFormat.init(inst, def3);
    });
    ZodISOTime = /* @__PURE__ */ $constructor("ZodISOTime", (inst, def3) => {
      $ZodISOTime.init(inst, def3);
      ZodStringFormat.init(inst, def3);
    });
    ZodISODuration = /* @__PURE__ */ $constructor("ZodISODuration", (inst, def3) => {
      $ZodISODuration.init(inst, def3);
      ZodStringFormat.init(inst, def3);
    });
    ZodEmail = /* @__PURE__ */ $constructor("ZodEmail", (inst, def3) => {
      $ZodEmail.init(inst, def3);
      ZodStringFormat.init(inst, def3);
    });
    ZodGUID = /* @__PURE__ */ $constructor("ZodGUID", (inst, def3) => {
      $ZodGUID.init(inst, def3);
      ZodStringFormat.init(inst, def3);
    });
    ZodUUID = /* @__PURE__ */ $constructor("ZodUUID", (inst, def3) => {
      $ZodUUID.init(inst, def3);
      ZodStringFormat.init(inst, def3);
    });
    ZodURL = /* @__PURE__ */ $constructor("ZodURL", (inst, def3) => {
      $ZodURL.init(inst, def3);
      ZodStringFormat.init(inst, def3);
    });
    ZodEmoji = /* @__PURE__ */ $constructor("ZodEmoji", (inst, def3) => {
      $ZodEmoji.init(inst, def3);
      ZodStringFormat.init(inst, def3);
    });
    ZodNanoID = /* @__PURE__ */ $constructor("ZodNanoID", (inst, def3) => {
      $ZodNanoID.init(inst, def3);
      ZodStringFormat.init(inst, def3);
    });
    ZodCUID = /* @__PURE__ */ $constructor("ZodCUID", (inst, def3) => {
      $ZodCUID.init(inst, def3);
      ZodStringFormat.init(inst, def3);
    });
    ZodCUID2 = /* @__PURE__ */ $constructor("ZodCUID2", (inst, def3) => {
      $ZodCUID2.init(inst, def3);
      ZodStringFormat.init(inst, def3);
    });
    ZodULID = /* @__PURE__ */ $constructor("ZodULID", (inst, def3) => {
      $ZodULID.init(inst, def3);
      ZodStringFormat.init(inst, def3);
    });
    ZodXID = /* @__PURE__ */ $constructor("ZodXID", (inst, def3) => {
      $ZodXID.init(inst, def3);
      ZodStringFormat.init(inst, def3);
    });
    ZodKSUID = /* @__PURE__ */ $constructor("ZodKSUID", (inst, def3) => {
      $ZodKSUID.init(inst, def3);
      ZodStringFormat.init(inst, def3);
    });
    ZodIPv4 = /* @__PURE__ */ $constructor("ZodIPv4", (inst, def3) => {
      $ZodIPv4.init(inst, def3);
      ZodStringFormat.init(inst, def3);
    });
    ZodIPv6 = /* @__PURE__ */ $constructor("ZodIPv6", (inst, def3) => {
      $ZodIPv6.init(inst, def3);
      ZodStringFormat.init(inst, def3);
    });
    ZodCIDRv4 = /* @__PURE__ */ $constructor("ZodCIDRv4", (inst, def3) => {
      $ZodCIDRv4.init(inst, def3);
      ZodStringFormat.init(inst, def3);
    });
    ZodCIDRv6 = /* @__PURE__ */ $constructor("ZodCIDRv6", (inst, def3) => {
      $ZodCIDRv6.init(inst, def3);
      ZodStringFormat.init(inst, def3);
    });
    ZodBase64 = /* @__PURE__ */ $constructor("ZodBase64", (inst, def3) => {
      $ZodBase64.init(inst, def3);
      ZodStringFormat.init(inst, def3);
    });
    ZodBase64URL = /* @__PURE__ */ $constructor("ZodBase64URL", (inst, def3) => {
      $ZodBase64URL.init(inst, def3);
      ZodStringFormat.init(inst, def3);
    });
    ZodE164 = /* @__PURE__ */ $constructor("ZodE164", (inst, def3) => {
      $ZodE164.init(inst, def3);
      ZodStringFormat.init(inst, def3);
    });
    ZodJWT = /* @__PURE__ */ $constructor("ZodJWT", (inst, def3) => {
      $ZodJWT.init(inst, def3);
      ZodStringFormat.init(inst, def3);
    });
    ZodNumber = /* @__PURE__ */ $constructor(
      "ZodNumber",
      (inst, def3) => {
        $ZodNumber.init(inst, def3);
        ZodType.init(inst, def3);
        inst._zod.processJSONSchema = (ctx, json, params) => numberProcessor(inst, ctx, json, params);
        inst.isFinite = true;
      },
      /* @__PURE__ */ util_exports.derived({
        minValue: (inst) => {
          const { minimum, exclusiveMinimum } = aggregateChecks(inst);
          return Math.max(minimum ?? Number.NEGATIVE_INFINITY, exclusiveMinimum ?? Number.NEGATIVE_INFINITY);
        },
        maxValue: (inst) => {
          const { maximum, exclusiveMaximum } = aggregateChecks(inst);
          return Math.min(maximum ?? Number.POSITIVE_INFINITY, exclusiveMaximum ?? Number.POSITIVE_INFINITY);
        },
        isInt: (inst) => {
          const { isInt, multipleOf } = aggregateChecks(inst);
          return !!isInt || !!multipleOf?.some(Number.isSafeInteger);
        },
        format: (inst) => aggregateChecks(inst).format ?? null
      }, {
        gt(value, params) {
          return this.check(_gt(value, params));
        },
        gte(value, params) {
          return this.check(_gte(value, params));
        },
        min(value, params) {
          return this.check(_gte(value, params));
        },
        lt(value, params) {
          return this.check(_lt(value, params));
        },
        lte(value, params) {
          return this.check(_lte(value, params));
        },
        max(value, params) {
          return this.check(_lte(value, params));
        },
        int(params) {
          return this.check(int(params));
        },
        safe(params) {
          return this.check(int(params));
        },
        positive(params) {
          return this.check(_gt(0, params));
        },
        nonnegative(params) {
          return this.check(_gte(0, params));
        },
        negative(params) {
          return this.check(_lt(0, params));
        },
        nonpositive(params) {
          return this.check(_lte(0, params));
        },
        multipleOf(value, params) {
          return this.check(_multipleOf(value, params));
        },
        step(value, params) {
          return this.check(_multipleOf(value, params));
        },
        finite() {
          return this;
        }
      })
    );
    ZodNumberFormat = /* @__PURE__ */ $constructor("ZodNumberFormat", (inst, def3) => {
      $ZodNumberFormat.init(inst, def3);
      ZodNumber.init(inst, def3);
    });
    ZodBoolean = /* @__PURE__ */ $constructor("ZodBoolean", (inst, def3) => {
      $ZodBoolean.init(inst, def3);
      ZodType.init(inst, def3);
      inst._zod.processJSONSchema = (ctx, json, params) => booleanProcessor(inst, ctx, json, params);
    });
    ZodNull = /* @__PURE__ */ $constructor("ZodNull", (inst, def3) => {
      $ZodNull.init(inst, def3);
      ZodType.init(inst, def3);
      inst._zod.processJSONSchema = (ctx, json, params) => nullProcessor(inst, ctx, json, params);
    });
    ZodUnknown = /* @__PURE__ */ $constructor("ZodUnknown", (inst, def3) => {
      $ZodUnknown.init(inst, def3);
      ZodType.init(inst, def3);
      inst._zod.processJSONSchema = (ctx, json, params) => unknownProcessor(inst, ctx, json, params);
    });
    ZodNever = /* @__PURE__ */ $constructor("ZodNever", (inst, def3) => {
      $ZodNever.init(inst, def3);
      ZodType.init(inst, def3);
      inst._zod.processJSONSchema = (ctx, json, params) => neverProcessor(inst, ctx, json, params);
    });
    ZodArray = /* @__PURE__ */ $constructor("ZodArray", (inst, def3) => {
      _ensureDefaultMemoizer();
      $ZodArray.init(inst, def3);
      ZodType.init(inst, def3);
      inst._zod.processJSONSchema = (ctx, json, params) => arrayProcessor(inst, ctx, json, params);
      inst.element = def3.element;
    }, {
      min(n, params) {
        return this.check(_minLength(n, params));
      },
      nonempty(params) {
        return this.check(_minLength(1, params));
      },
      max(n, params) {
        return this.check(_maxLength(n, params));
      },
      length(n, params) {
        return this.check(_length(n, params));
      },
      unwrap() {
        return this.element;
      }
    });
    ZodObject = /* @__PURE__ */ $constructor("ZodObject", (inst, def3) => {
      _ensureDefaultMemoizer();
      $ZodObjectJIT.init(inst, def3);
      ZodType.init(inst, def3);
      inst._zod.processJSONSchema = (ctx, json, params) => objectProcessor(inst, ctx, json, params);
      util_exports.installLazyProp(inst, "shape", (self) => self._zod.def.shape, false);
    }, {
      keyof() {
        return _enum(Object.keys(this._zod.def.shape));
      },
      catchall(catchall) {
        return this.clone(util_exports.mergeDefs(this._zod.def, { catchall }));
      },
      passthrough() {
        return this.clone(util_exports.mergeDefs(this._zod.def, { catchall: unknown() }));
      },
      loose() {
        return this.clone(util_exports.mergeDefs(this._zod.def, { catchall: unknown() }));
      },
      strict() {
        return this.clone(util_exports.mergeDefs(this._zod.def, { catchall: never() }));
      },
      strip() {
        return this.clone(util_exports.mergeDefs(this._zod.def, { catchall: void 0 }));
      },
      extend(incoming) {
        return util_exports.extend(this, incoming);
      },
      safeExtend(incoming) {
        return util_exports.safeExtend(this, incoming);
      },
      merge(other) {
        return util_exports.merge(this, other);
      },
      pick(mask) {
        return util_exports.pick(this, mask);
      },
      omit(mask) {
        return util_exports.omit(this, mask);
      },
      partial(...args) {
        return util_exports.partial(ZodOptional, this, args[0]);
      },
      exactPartial(...args) {
        return util_exports.partial(ZodExactOptional, this, args[0], "exactPartial");
      },
      required(...args) {
        return util_exports.required(ZodNonOptional, this, args[0]);
      }
    });
    ZodUnion = /* @__PURE__ */ $constructor("ZodUnion", (inst, def3) => {
      $ZodUnion.init(inst, def3);
      ZodType.init(inst, def3);
      inst._zod.processJSONSchema = (ctx, json, params) => unionProcessor(inst, ctx, json, params);
      inst.options = def3.options;
    });
    ZodDiscriminatedUnion = /* @__PURE__ */ $constructor("ZodDiscriminatedUnion", (inst, def3) => {
      ZodUnion.init(inst, def3);
      $ZodDiscriminatedUnion.init(inst, def3);
    });
    ZodIntersection = /* @__PURE__ */ $constructor("ZodIntersection", (inst, def3) => {
      $ZodIntersection.init(inst, def3);
      ZodType.init(inst, def3);
      inst._zod.processJSONSchema = (ctx, json, params) => intersectionProcessor(inst, ctx, json, params);
    });
    ZodRecord = /* @__PURE__ */ $constructor("ZodRecord", (inst, def3) => {
      _ensureDefaultMemoizer();
      $ZodRecord.init(inst, def3);
      ZodType.init(inst, def3);
      inst._zod.processJSONSchema = (ctx, json, params) => recordProcessor(inst, ctx, json, params);
      inst.keyType = def3.keyType;
      inst.valueType = def3.valueType;
    });
    ZodEnum = /* @__PURE__ */ $constructor("ZodEnum", (inst, def3) => {
      $ZodEnum.init(inst, def3);
      ZodType.init(inst, def3);
      inst._zod.processJSONSchema = (ctx, json, params) => enumProcessor(inst, ctx, json, params);
      inst.enum = def3.entries;
      inst.options = [...inst._zod.values];
      const keys = new Set(Object.keys(def3.entries));
      inst.extract = (values, params) => {
        const newEntries = {};
        for (const value of values) {
          if (keys.has(value)) {
            newEntries[value] = def3.entries[value];
          } else
            throw new Error(`Key ${value} not found in enum`);
        }
        return new ZodEnum({
          ...def3,
          checks: [],
          ...util_exports.normalizeParams(params),
          entries: newEntries
        });
      };
      inst.exclude = (values, params) => {
        const newEntries = { ...def3.entries };
        for (const value of values) {
          if (keys.has(value)) {
            delete newEntries[value];
          } else
            throw new Error(`Key ${value} not found in enum`);
        }
        return new ZodEnum({
          ...def3,
          checks: [],
          ...util_exports.normalizeParams(params),
          entries: newEntries
        });
      };
    });
    ZodLiteral = /* @__PURE__ */ $constructor("ZodLiteral", (inst, def3) => {
      $ZodLiteral.init(inst, def3);
      ZodType.init(inst, def3);
      inst._zod.processJSONSchema = (ctx, json, params) => literalProcessor(inst, ctx, json, params);
      inst.values = new Set(def3.values);
      Object.defineProperty(inst, "value", {
        get() {
          if (def3.values.length > 1) {
            throw new Error("This schema contains multiple valid literal values. Use `.values` instead.");
          }
          return def3.values[0];
        }
      });
    });
    ZodTransform = /* @__PURE__ */ $constructor("ZodTransform", (inst, def3) => {
      _ensureDefaultMemoizer();
      $ZodTransform.init(inst, def3);
      ZodType.init(inst, def3);
      inst._zod.processJSONSchema = (ctx, json, params) => transformProcessor(inst, ctx, json, params);
      inst._zod.parse = (payload, _ctx) => {
        if (_ctx.direction === "backward") {
          throw new $ZodEncodeError(inst.constructor.name);
        }
        payload.addIssue = (issue2) => {
          if (typeof issue2 === "string") {
            payload.issues.push(util_exports.issue(issue2, payload.value, def3));
          } else {
            const _issue = issue2;
            if (_issue.fatal)
              _issue.continue = false;
            _issue.code ?? (_issue.code = "custom");
            if (!("input" in _issue))
              _issue.input = payload.value;
            _issue.inst ?? (_issue.inst = inst);
            payload.issues.push(util_exports.issue(_issue));
          }
        };
        const output = def3.transform(payload.value, payload);
        if (output instanceof Promise) {
          return output.then((output2) => {
            payload.value = output2;
            return payload;
          });
        }
        payload.value = output;
        return payload;
      };
    });
    ZodOptional = /* @__PURE__ */ $constructor("ZodOptional", (inst, def3) => {
      $ZodOptional.init(inst, def3);
      ZodType.init(inst, def3);
      inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
      inst.unwrap = () => inst._zod.def.innerType;
    });
    ZodExactOptional = /* @__PURE__ */ $constructor("ZodExactOptional", (inst, def3) => {
      $ZodExactOptional.init(inst, def3);
      ZodType.init(inst, def3);
      inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
      inst.unwrap = () => inst._zod.def.innerType;
    });
    ZodNullable = /* @__PURE__ */ $constructor("ZodNullable", (inst, def3) => {
      $ZodNullable.init(inst, def3);
      ZodType.init(inst, def3);
      inst._zod.processJSONSchema = (ctx, json, params) => nullableProcessor(inst, ctx, json, params);
      inst.unwrap = () => inst._zod.def.innerType;
    });
    ZodDefault = /* @__PURE__ */ $constructor("ZodDefault", (inst, def3) => {
      $ZodDefault.init(inst, def3);
      ZodType.init(inst, def3);
      inst._zod.processJSONSchema = (ctx, json, params) => defaultProcessor(inst, ctx, json, params);
      inst.unwrap = () => inst._zod.def.innerType;
      inst.removeDefault = inst.unwrap;
    });
    ZodPrefault = /* @__PURE__ */ $constructor("ZodPrefault", (inst, def3) => {
      $ZodPrefault.init(inst, def3);
      ZodType.init(inst, def3);
      inst._zod.processJSONSchema = (ctx, json, params) => prefaultProcessor(inst, ctx, json, params);
      inst.unwrap = () => inst._zod.def.innerType;
    });
    ZodNonOptional = /* @__PURE__ */ $constructor("ZodNonOptional", (inst, def3) => {
      $ZodNonOptional.init(inst, def3);
      ZodType.init(inst, def3);
      inst._zod.processJSONSchema = (ctx, json, params) => nonoptionalProcessor(inst, ctx, json, params);
      inst.unwrap = () => inst._zod.def.innerType;
    });
    ZodCatch = /* @__PURE__ */ $constructor("ZodCatch", (inst, def3) => {
      $ZodCatch.init(inst, def3);
      ZodType.init(inst, def3);
      inst._zod.processJSONSchema = (ctx, json, params) => catchProcessor(inst, ctx, json, params);
      inst.unwrap = () => inst._zod.def.innerType;
      inst.removeCatch = inst.unwrap;
    });
    ZodPipe = /* @__PURE__ */ $constructor("ZodPipe", (inst, def3) => {
      $ZodPipe.init(inst, def3);
      ZodType.init(inst, def3);
      inst._zod.processJSONSchema = (ctx, json, params) => pipeProcessor(inst, ctx, json, params);
      inst.in = def3.in;
      inst.out = def3.out;
    });
    ZodPreprocess = /* @__PURE__ */ $constructor("ZodPreprocess", (inst, def3) => {
      ZodPipe.init(inst, def3);
      $ZodPreprocess.init(inst, def3);
    });
    ZodReadonly = /* @__PURE__ */ $constructor("ZodReadonly", (inst, def3) => {
      $ZodReadonly.init(inst, def3);
      ZodType.init(inst, def3);
      inst._zod.processJSONSchema = (ctx, json, params) => readonlyProcessor(inst, ctx, json, params);
      inst.unwrap = () => inst._zod.def.innerType;
    });
    ZodCustom = /* @__PURE__ */ $constructor("ZodCustom", (inst, def3) => {
      $ZodCustom.init(inst, def3);
      ZodType.init(inst, def3);
      inst._zod.processJSONSchema = (ctx, json, params) => customProcessor(inst, ctx, json, params);
    });
  }
});

// node_modules/zod/v4/classic/compat.js
var ZodFirstPartyTypeKind;
var init_compat = __esm({
  "node_modules/zod/v4/classic/compat.js"() {
    /* @__PURE__ */ (function(ZodFirstPartyTypeKind2) {
    })(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
  }
});

// node_modules/zod/v4/classic/iso.js
var iso_exports = {};
__export(iso_exports, {
  ZodISODate: () => ZodISODate,
  ZodISODateTime: () => ZodISODateTime,
  ZodISODuration: () => ZodISODuration,
  ZodISOTime: () => ZodISOTime,
  date: () => date2,
  datetime: () => datetime2,
  duration: () => duration2,
  time: () => time2
});
function datetime2(params) {
  return _isoDateTime(ZodISODateTime, params);
}
function date2(params) {
  return _isoDate(ZodISODate, params);
}
function time2(params) {
  return _isoTime(ZodISOTime, params);
}
function duration2(params) {
  return _isoDuration(ZodISODuration, params);
}
var init_iso = __esm({
  "node_modules/zod/v4/classic/iso.js"() {
    init_core2();
    init_schemas2();
    init_schemas2();
  }
});

// node_modules/zod/v4/classic/coerce.js
var init_coerce = __esm({
  "node_modules/zod/v4/classic/coerce.js"() {
  }
});

// node_modules/zod/v4/classic/external.js
var init_external = __esm({
  "node_modules/zod/v4/classic/external.js"() {
    init_core2();
    init_schemas2();
    init_checks2();
    init_errors2();
    init_parse2();
    init_compat();
    init_locales();
    init_iso();
    init_coerce();
  }
});

// node_modules/zod/v4/classic/index.js
var init_classic = __esm({
  "node_modules/zod/v4/classic/index.js"() {
    init_external();
  }
});

// node_modules/zod/v4/index.js
var init_v4 = __esm({
  "node_modules/zod/v4/index.js"() {
    init_classic();
  }
});

// node_modules/@modelcontextprotocol/sdk/dist/esm/types.js
var LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, RELATED_TASK_META_KEY, JSONRPC_VERSION, AssertObjectSchema, ProgressTokenSchema, CursorSchema, TaskCreationParamsSchema, TaskMetadataSchema, RelatedTaskMetadataSchema, RequestMetaSchema, BaseRequestParamsSchema, TaskAugmentedRequestParamsSchema, isTaskAugmentedRequestParams, RequestSchema, NotificationsParamsSchema, NotificationSchema, ResultSchema, RequestIdSchema, JSONRPCRequestSchema, isJSONRPCRequest, JSONRPCNotificationSchema, isJSONRPCNotification, JSONRPCResultResponseSchema, isJSONRPCResultResponse, ErrorCode, JSONRPCErrorResponseSchema, isJSONRPCErrorResponse, JSONRPCMessageSchema, JSONRPCResponseSchema, EmptyResultSchema, CancelledNotificationParamsSchema, CancelledNotificationSchema, IconSchema, IconsSchema, BaseMetadataSchema, ImplementationSchema, FormElicitationCapabilitySchema, ElicitationCapabilitySchema, ClientTasksCapabilitySchema, ServerTasksCapabilitySchema, ClientCapabilitiesSchema, InitializeRequestParamsSchema, InitializeRequestSchema, ServerCapabilitiesSchema, InitializeResultSchema, InitializedNotificationSchema, PingRequestSchema, ProgressSchema, ProgressNotificationParamsSchema, ProgressNotificationSchema, PaginatedRequestParamsSchema, PaginatedRequestSchema, PaginatedResultSchema, TaskStatusSchema, TaskSchema, CreateTaskResultSchema, TaskStatusNotificationParamsSchema, TaskStatusNotificationSchema, GetTaskRequestSchema, GetTaskResultSchema, GetTaskPayloadRequestSchema, GetTaskPayloadResultSchema, ListTasksRequestSchema, ListTasksResultSchema, CancelTaskRequestSchema, CancelTaskResultSchema, ResourceContentsSchema, TextResourceContentsSchema, Base64Schema, BlobResourceContentsSchema, RoleSchema, AnnotationsSchema, ResourceSchema, ResourceTemplateSchema, ListResourcesRequestSchema, ListResourcesResultSchema, ListResourceTemplatesRequestSchema, ListResourceTemplatesResultSchema, ResourceRequestParamsSchema, ReadResourceRequestParamsSchema, ReadResourceRequestSchema, ReadResourceResultSchema, ResourceListChangedNotificationSchema, SubscribeRequestParamsSchema, SubscribeRequestSchema, UnsubscribeRequestParamsSchema, UnsubscribeRequestSchema, ResourceUpdatedNotificationParamsSchema, ResourceUpdatedNotificationSchema, PromptArgumentSchema, PromptSchema, ListPromptsRequestSchema, ListPromptsResultSchema, GetPromptRequestParamsSchema, GetPromptRequestSchema, TextContentSchema, ImageContentSchema, AudioContentSchema, ToolUseContentSchema, EmbeddedResourceSchema, ResourceLinkSchema, ContentBlockSchema, PromptMessageSchema, GetPromptResultSchema, PromptListChangedNotificationSchema, ToolAnnotationsSchema, ToolExecutionSchema, ToolSchema, ListToolsRequestSchema, ListToolsResultSchema, CallToolResultSchema, CompatibilityCallToolResultSchema, CallToolRequestParamsSchema, CallToolRequestSchema, ToolListChangedNotificationSchema, ListChangedOptionsBaseSchema, LoggingLevelSchema, SetLevelRequestParamsSchema, SetLevelRequestSchema, LoggingMessageNotificationParamsSchema, LoggingMessageNotificationSchema, ModelHintSchema, ModelPreferencesSchema, ToolChoiceSchema, ToolResultContentSchema, SamplingContentSchema, SamplingMessageContentBlockSchema, SamplingMessageSchema, CreateMessageRequestParamsSchema, CreateMessageRequestSchema, CreateMessageResultSchema, CreateMessageResultWithToolsSchema, BooleanSchemaSchema, StringSchemaSchema, NumberSchemaSchema, UntitledSingleSelectEnumSchemaSchema, TitledSingleSelectEnumSchemaSchema, LegacyTitledEnumSchemaSchema, SingleSelectEnumSchemaSchema, UntitledMultiSelectEnumSchemaSchema, TitledMultiSelectEnumSchemaSchema, MultiSelectEnumSchemaSchema, EnumSchemaSchema, PrimitiveSchemaDefinitionSchema, ElicitRequestFormParamsSchema, ElicitRequestURLParamsSchema, ElicitRequestParamsSchema, ElicitRequestSchema, ElicitationCompleteNotificationParamsSchema, ElicitationCompleteNotificationSchema, ElicitResultSchema, ResourceTemplateReferenceSchema, PromptReferenceSchema, CompleteRequestParamsSchema, CompleteRequestSchema, CompleteResultSchema, RootSchema, ListRootsRequestSchema, ListRootsResultSchema, RootsListChangedNotificationSchema, ClientRequestSchema, ClientNotificationSchema, ClientResultSchema, ServerRequestSchema, ServerNotificationSchema, ServerResultSchema, McpError, UrlElicitationRequiredError;
var init_types = __esm({
  "node_modules/@modelcontextprotocol/sdk/dist/esm/types.js"() {
    init_v4();
    LATEST_PROTOCOL_VERSION = "2025-11-25";
    SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
    RELATED_TASK_META_KEY = "io.modelcontextprotocol/related-task";
    JSONRPC_VERSION = "2.0";
    AssertObjectSchema = custom((v) => v !== null && (typeof v === "object" || typeof v === "function"));
    ProgressTokenSchema = union([string2(), number2().int()]);
    CursorSchema = string2();
    TaskCreationParamsSchema = looseObject({
      /**
       * Requested duration in milliseconds to retain task from creation.
       */
      ttl: number2().optional(),
      /**
       * Time in milliseconds to wait between task status requests.
       */
      pollInterval: number2().optional()
    });
    TaskMetadataSchema = object({
      ttl: number2().optional()
    });
    RelatedTaskMetadataSchema = object({
      taskId: string2()
    });
    RequestMetaSchema = looseObject({
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: ProgressTokenSchema.optional(),
      /**
       * If specified, this request is related to the provided task.
       */
      [RELATED_TASK_META_KEY]: RelatedTaskMetadataSchema.optional()
    });
    BaseRequestParamsSchema = object({
      /**
       * See [General fields: `_meta`](/specification/draft/basic/index#meta) for notes on `_meta` usage.
       */
      _meta: RequestMetaSchema.optional()
    });
    TaskAugmentedRequestParamsSchema = BaseRequestParamsSchema.extend({
      /**
       * If specified, the caller is requesting task-augmented execution for this request.
       * The request will return a CreateTaskResult immediately, and the actual result can be
       * retrieved later via tasks/result.
       *
       * Task augmentation is subject to capability negotiation - receivers MUST declare support
       * for task augmentation of specific request types in their capabilities.
       */
      task: TaskMetadataSchema.optional()
    });
    isTaskAugmentedRequestParams = (value) => TaskAugmentedRequestParamsSchema.safeParse(value).success;
    RequestSchema = object({
      method: string2(),
      params: BaseRequestParamsSchema.loose().optional()
    });
    NotificationsParamsSchema = object({
      /**
       * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
       * for notes on _meta usage.
       */
      _meta: RequestMetaSchema.optional()
    });
    NotificationSchema = object({
      method: string2(),
      params: NotificationsParamsSchema.loose().optional()
    });
    ResultSchema = looseObject({
      /**
       * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
       * for notes on _meta usage.
       */
      _meta: RequestMetaSchema.optional()
    });
    RequestIdSchema = union([string2(), number2().int()]);
    JSONRPCRequestSchema = object({
      jsonrpc: literal(JSONRPC_VERSION),
      id: RequestIdSchema,
      ...RequestSchema.shape
    }).strict();
    isJSONRPCRequest = (value) => JSONRPCRequestSchema.safeParse(value).success;
    JSONRPCNotificationSchema = object({
      jsonrpc: literal(JSONRPC_VERSION),
      ...NotificationSchema.shape
    }).strict();
    isJSONRPCNotification = (value) => JSONRPCNotificationSchema.safeParse(value).success;
    JSONRPCResultResponseSchema = object({
      jsonrpc: literal(JSONRPC_VERSION),
      id: RequestIdSchema,
      result: ResultSchema
    }).strict();
    isJSONRPCResultResponse = (value) => JSONRPCResultResponseSchema.safeParse(value).success;
    (function(ErrorCode2) {
      ErrorCode2[ErrorCode2["ConnectionClosed"] = -32e3] = "ConnectionClosed";
      ErrorCode2[ErrorCode2["RequestTimeout"] = -32001] = "RequestTimeout";
      ErrorCode2[ErrorCode2["ParseError"] = -32700] = "ParseError";
      ErrorCode2[ErrorCode2["InvalidRequest"] = -32600] = "InvalidRequest";
      ErrorCode2[ErrorCode2["MethodNotFound"] = -32601] = "MethodNotFound";
      ErrorCode2[ErrorCode2["InvalidParams"] = -32602] = "InvalidParams";
      ErrorCode2[ErrorCode2["InternalError"] = -32603] = "InternalError";
      ErrorCode2[ErrorCode2["UrlElicitationRequired"] = -32042] = "UrlElicitationRequired";
    })(ErrorCode || (ErrorCode = {}));
    JSONRPCErrorResponseSchema = object({
      jsonrpc: literal(JSONRPC_VERSION),
      id: RequestIdSchema.optional(),
      error: object({
        /**
         * The error type that occurred.
         */
        code: number2().int(),
        /**
         * A short description of the error. The message SHOULD be limited to a concise single sentence.
         */
        message: string2(),
        /**
         * Additional information about the error. The value of this member is defined by the sender (e.g. detailed error information, nested errors etc.).
         */
        data: unknown().optional()
      })
    }).strict();
    isJSONRPCErrorResponse = (value) => JSONRPCErrorResponseSchema.safeParse(value).success;
    JSONRPCMessageSchema = union([
      JSONRPCRequestSchema,
      JSONRPCNotificationSchema,
      JSONRPCResultResponseSchema,
      JSONRPCErrorResponseSchema
    ]);
    JSONRPCResponseSchema = union([JSONRPCResultResponseSchema, JSONRPCErrorResponseSchema]);
    EmptyResultSchema = ResultSchema.strict();
    CancelledNotificationParamsSchema = NotificationsParamsSchema.extend({
      /**
       * The ID of the request to cancel.
       *
       * This MUST correspond to the ID of a request previously issued in the same direction.
       */
      requestId: RequestIdSchema.optional(),
      /**
       * An optional string describing the reason for the cancellation. This MAY be logged or presented to the user.
       */
      reason: string2().optional()
    });
    CancelledNotificationSchema = NotificationSchema.extend({
      method: literal("notifications/cancelled"),
      params: CancelledNotificationParamsSchema
    });
    IconSchema = object({
      /**
       * URL or data URI for the icon.
       */
      src: string2(),
      /**
       * Optional MIME type for the icon.
       */
      mimeType: string2().optional(),
      /**
       * Optional array of strings that specify sizes at which the icon can be used.
       * Each string should be in WxH format (e.g., `"48x48"`, `"96x96"`) or `"any"` for scalable formats like SVG.
       *
       * If not provided, the client should assume that the icon can be used at any size.
       */
      sizes: array(string2()).optional(),
      /**
       * Optional specifier for the theme this icon is designed for. `light` indicates
       * the icon is designed to be used with a light background, and `dark` indicates
       * the icon is designed to be used with a dark background.
       *
       * If not provided, the client should assume the icon can be used with any theme.
       */
      theme: _enum(["light", "dark"]).optional()
    });
    IconsSchema = object({
      /**
       * Optional set of sized icons that the client can display in a user interface.
       *
       * Clients that support rendering icons MUST support at least the following MIME types:
       * - `image/png` - PNG images (safe, universal compatibility)
       * - `image/jpeg` (and `image/jpg`) - JPEG images (safe, universal compatibility)
       *
       * Clients that support rendering icons SHOULD also support:
       * - `image/svg+xml` - SVG images (scalable but requires security precautions)
       * - `image/webp` - WebP images (modern, efficient format)
       */
      icons: array(IconSchema).optional()
    });
    BaseMetadataSchema = object({
      /** Intended for programmatic or logical use, but used as a display name in past specs or fallback */
      name: string2(),
      /**
       * Intended for UI and end-user contexts — optimized to be human-readable and easily understood,
       * even by those unfamiliar with domain-specific terminology.
       *
       * If not provided, the name should be used for display (except for Tool,
       * where `annotations.title` should be given precedence over using `name`,
       * if present).
       */
      title: string2().optional()
    });
    ImplementationSchema = BaseMetadataSchema.extend({
      ...BaseMetadataSchema.shape,
      ...IconsSchema.shape,
      version: string2(),
      /**
       * An optional URL of the website for this implementation.
       */
      websiteUrl: string2().optional(),
      /**
       * An optional human-readable description of what this implementation does.
       *
       * This can be used by clients or servers to provide context about their purpose
       * and capabilities. For example, a server might describe the types of resources
       * or tools it provides, while a client might describe its intended use case.
       */
      description: string2().optional()
    });
    FormElicitationCapabilitySchema = intersection(object({
      applyDefaults: boolean2().optional()
    }), record(string2(), unknown()));
    ElicitationCapabilitySchema = preprocess((value) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        if (Object.keys(value).length === 0) {
          return { form: {} };
        }
      }
      return value;
    }, intersection(object({
      form: FormElicitationCapabilitySchema.optional(),
      url: AssertObjectSchema.optional()
    }), record(string2(), unknown()).optional()));
    ClientTasksCapabilitySchema = looseObject({
      /**
       * Present if the client supports listing tasks.
       */
      list: AssertObjectSchema.optional(),
      /**
       * Present if the client supports cancelling tasks.
       */
      cancel: AssertObjectSchema.optional(),
      /**
       * Capabilities for task creation on specific request types.
       */
      requests: looseObject({
        /**
         * Task support for sampling requests.
         */
        sampling: looseObject({
          createMessage: AssertObjectSchema.optional()
        }).optional(),
        /**
         * Task support for elicitation requests.
         */
        elicitation: looseObject({
          create: AssertObjectSchema.optional()
        }).optional()
      }).optional()
    });
    ServerTasksCapabilitySchema = looseObject({
      /**
       * Present if the server supports listing tasks.
       */
      list: AssertObjectSchema.optional(),
      /**
       * Present if the server supports cancelling tasks.
       */
      cancel: AssertObjectSchema.optional(),
      /**
       * Capabilities for task creation on specific request types.
       */
      requests: looseObject({
        /**
         * Task support for tool requests.
         */
        tools: looseObject({
          call: AssertObjectSchema.optional()
        }).optional()
      }).optional()
    });
    ClientCapabilitiesSchema = object({
      /**
       * Experimental, non-standard capabilities that the client supports.
       */
      experimental: record(string2(), AssertObjectSchema).optional(),
      /**
       * Present if the client supports sampling from an LLM.
       */
      sampling: object({
        /**
         * Present if the client supports context inclusion via includeContext parameter.
         * If not declared, servers SHOULD only use `includeContext: "none"` (or omit it).
         */
        context: AssertObjectSchema.optional(),
        /**
         * Present if the client supports tool use via tools and toolChoice parameters.
         */
        tools: AssertObjectSchema.optional()
      }).optional(),
      /**
       * Present if the client supports eliciting user input.
       */
      elicitation: ElicitationCapabilitySchema.optional(),
      /**
       * Present if the client supports listing roots.
       */
      roots: object({
        /**
         * Whether the client supports issuing notifications for changes to the roots list.
         */
        listChanged: boolean2().optional()
      }).optional(),
      /**
       * Present if the client supports task creation.
       */
      tasks: ClientTasksCapabilitySchema.optional(),
      /**
       * Extensions that the client supports. Keys are extension identifiers (vendor-prefix/extension-name).
       */
      extensions: record(string2(), AssertObjectSchema).optional()
    });
    InitializeRequestParamsSchema = BaseRequestParamsSchema.extend({
      /**
       * The latest version of the Model Context Protocol that the client supports. The client MAY decide to support older versions as well.
       */
      protocolVersion: string2(),
      capabilities: ClientCapabilitiesSchema,
      clientInfo: ImplementationSchema
    });
    InitializeRequestSchema = RequestSchema.extend({
      method: literal("initialize"),
      params: InitializeRequestParamsSchema
    });
    ServerCapabilitiesSchema = object({
      /**
       * Experimental, non-standard capabilities that the server supports.
       */
      experimental: record(string2(), AssertObjectSchema).optional(),
      /**
       * Present if the server supports sending log messages to the client.
       */
      logging: AssertObjectSchema.optional(),
      /**
       * Present if the server supports sending completions to the client.
       */
      completions: AssertObjectSchema.optional(),
      /**
       * Present if the server offers any prompt templates.
       */
      prompts: object({
        /**
         * Whether this server supports issuing notifications for changes to the prompt list.
         */
        listChanged: boolean2().optional()
      }).optional(),
      /**
       * Present if the server offers any resources to read.
       */
      resources: object({
        /**
         * Whether this server supports clients subscribing to resource updates.
         */
        subscribe: boolean2().optional(),
        /**
         * Whether this server supports issuing notifications for changes to the resource list.
         */
        listChanged: boolean2().optional()
      }).optional(),
      /**
       * Present if the server offers any tools to call.
       */
      tools: object({
        /**
         * Whether this server supports issuing notifications for changes to the tool list.
         */
        listChanged: boolean2().optional()
      }).optional(),
      /**
       * Present if the server supports task creation.
       */
      tasks: ServerTasksCapabilitySchema.optional(),
      /**
       * Extensions that the server supports. Keys are extension identifiers (vendor-prefix/extension-name).
       */
      extensions: record(string2(), AssertObjectSchema).optional()
    });
    InitializeResultSchema = ResultSchema.extend({
      /**
       * The version of the Model Context Protocol that the server wants to use. This may not match the version that the client requested. If the client cannot support this version, it MUST disconnect.
       */
      protocolVersion: string2(),
      capabilities: ServerCapabilitiesSchema,
      serverInfo: ImplementationSchema,
      /**
       * Instructions describing how to use the server and its features.
       *
       * This can be used by clients to improve the LLM's understanding of available tools, resources, etc. It can be thought of like a "hint" to the model. For example, this information MAY be added to the system prompt.
       */
      instructions: string2().optional()
    });
    InitializedNotificationSchema = NotificationSchema.extend({
      method: literal("notifications/initialized"),
      params: NotificationsParamsSchema.optional()
    });
    PingRequestSchema = RequestSchema.extend({
      method: literal("ping"),
      params: BaseRequestParamsSchema.optional()
    });
    ProgressSchema = object({
      /**
       * The progress thus far. This should increase every time progress is made, even if the total is unknown.
       */
      progress: number2(),
      /**
       * Total number of items to process (or total progress required), if known.
       */
      total: optional(number2()),
      /**
       * An optional message describing the current progress.
       */
      message: optional(string2())
    });
    ProgressNotificationParamsSchema = object({
      ...NotificationsParamsSchema.shape,
      ...ProgressSchema.shape,
      /**
       * The progress token which was given in the initial request, used to associate this notification with the request that is proceeding.
       */
      progressToken: ProgressTokenSchema
    });
    ProgressNotificationSchema = NotificationSchema.extend({
      method: literal("notifications/progress"),
      params: ProgressNotificationParamsSchema
    });
    PaginatedRequestParamsSchema = BaseRequestParamsSchema.extend({
      /**
       * An opaque token representing the current pagination position.
       * If provided, the server should return results starting after this cursor.
       */
      cursor: CursorSchema.optional()
    });
    PaginatedRequestSchema = RequestSchema.extend({
      params: PaginatedRequestParamsSchema.optional()
    });
    PaginatedResultSchema = ResultSchema.extend({
      /**
       * An opaque token representing the pagination position after the last returned result.
       * If present, there may be more results available.
       */
      nextCursor: CursorSchema.optional()
    });
    TaskStatusSchema = _enum(["working", "input_required", "completed", "failed", "cancelled"]);
    TaskSchema = object({
      taskId: string2(),
      status: TaskStatusSchema,
      /**
       * Time in milliseconds to keep task results available after completion.
       * If null, the task has unlimited lifetime until manually cleaned up.
       */
      ttl: union([number2(), _null3()]),
      /**
       * ISO 8601 timestamp when the task was created.
       */
      createdAt: string2(),
      /**
       * ISO 8601 timestamp when the task was last updated.
       */
      lastUpdatedAt: string2(),
      pollInterval: optional(number2()),
      /**
       * Optional diagnostic message for failed tasks or other status information.
       */
      statusMessage: optional(string2())
    });
    CreateTaskResultSchema = ResultSchema.extend({
      task: TaskSchema
    });
    TaskStatusNotificationParamsSchema = NotificationsParamsSchema.merge(TaskSchema);
    TaskStatusNotificationSchema = NotificationSchema.extend({
      method: literal("notifications/tasks/status"),
      params: TaskStatusNotificationParamsSchema
    });
    GetTaskRequestSchema = RequestSchema.extend({
      method: literal("tasks/get"),
      params: BaseRequestParamsSchema.extend({
        taskId: string2()
      })
    });
    GetTaskResultSchema = ResultSchema.merge(TaskSchema);
    GetTaskPayloadRequestSchema = RequestSchema.extend({
      method: literal("tasks/result"),
      params: BaseRequestParamsSchema.extend({
        taskId: string2()
      })
    });
    GetTaskPayloadResultSchema = ResultSchema.loose();
    ListTasksRequestSchema = PaginatedRequestSchema.extend({
      method: literal("tasks/list")
    });
    ListTasksResultSchema = PaginatedResultSchema.extend({
      tasks: array(TaskSchema)
    });
    CancelTaskRequestSchema = RequestSchema.extend({
      method: literal("tasks/cancel"),
      params: BaseRequestParamsSchema.extend({
        taskId: string2()
      })
    });
    CancelTaskResultSchema = ResultSchema.merge(TaskSchema);
    ResourceContentsSchema = object({
      /**
       * The URI of this resource.
       */
      uri: string2(),
      /**
       * The MIME type of this resource, if known.
       */
      mimeType: optional(string2()),
      /**
       * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
       * for notes on _meta usage.
       */
      _meta: record(string2(), unknown()).optional()
    });
    TextResourceContentsSchema = ResourceContentsSchema.extend({
      /**
       * The text of the item. This must only be set if the item can actually be represented as text (not binary data).
       */
      text: string2()
    });
    Base64Schema = string2().refine((val) => {
      try {
        atob(val);
        return true;
      } catch {
        return false;
      }
    }, { message: "Invalid Base64 string" });
    BlobResourceContentsSchema = ResourceContentsSchema.extend({
      /**
       * A base64-encoded string representing the binary data of the item.
       */
      blob: Base64Schema
    });
    RoleSchema = _enum(["user", "assistant"]);
    AnnotationsSchema = object({
      /**
       * Intended audience(s) for the resource.
       */
      audience: array(RoleSchema).optional(),
      /**
       * Importance hint for the resource, from 0 (least) to 1 (most).
       */
      priority: number2().min(0).max(1).optional(),
      /**
       * ISO 8601 timestamp for the most recent modification.
       */
      lastModified: iso_exports.datetime({ offset: true }).optional()
    });
    ResourceSchema = object({
      ...BaseMetadataSchema.shape,
      ...IconsSchema.shape,
      /**
       * The URI of this resource.
       */
      uri: string2(),
      /**
       * A description of what this resource represents.
       *
       * This can be used by clients to improve the LLM's understanding of available resources. It can be thought of like a "hint" to the model.
       */
      description: optional(string2()),
      /**
       * The MIME type of this resource, if known.
       */
      mimeType: optional(string2()),
      /**
       * The size of the raw resource content, in bytes (i.e., before base64 encoding or any tokenization), if known.
       *
       * This can be used by Hosts to display file sizes and estimate context window usage.
       */
      size: optional(number2()),
      /**
       * Optional annotations for the client.
       */
      annotations: AnnotationsSchema.optional(),
      /**
       * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
       * for notes on _meta usage.
       */
      _meta: optional(looseObject({}))
    });
    ResourceTemplateSchema = object({
      ...BaseMetadataSchema.shape,
      ...IconsSchema.shape,
      /**
       * A URI template (according to RFC 6570) that can be used to construct resource URIs.
       */
      uriTemplate: string2(),
      /**
       * A description of what this template is for.
       *
       * This can be used by clients to improve the LLM's understanding of available resources. It can be thought of like a "hint" to the model.
       */
      description: optional(string2()),
      /**
       * The MIME type for all resources that match this template. This should only be included if all resources matching this template have the same type.
       */
      mimeType: optional(string2()),
      /**
       * Optional annotations for the client.
       */
      annotations: AnnotationsSchema.optional(),
      /**
       * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
       * for notes on _meta usage.
       */
      _meta: optional(looseObject({}))
    });
    ListResourcesRequestSchema = PaginatedRequestSchema.extend({
      method: literal("resources/list")
    });
    ListResourcesResultSchema = PaginatedResultSchema.extend({
      resources: array(ResourceSchema)
    });
    ListResourceTemplatesRequestSchema = PaginatedRequestSchema.extend({
      method: literal("resources/templates/list")
    });
    ListResourceTemplatesResultSchema = PaginatedResultSchema.extend({
      resourceTemplates: array(ResourceTemplateSchema)
    });
    ResourceRequestParamsSchema = BaseRequestParamsSchema.extend({
      /**
       * The URI of the resource to read. The URI can use any protocol; it is up to the server how to interpret it.
       *
       * @format uri
       */
      uri: string2()
    });
    ReadResourceRequestParamsSchema = ResourceRequestParamsSchema;
    ReadResourceRequestSchema = RequestSchema.extend({
      method: literal("resources/read"),
      params: ReadResourceRequestParamsSchema
    });
    ReadResourceResultSchema = ResultSchema.extend({
      contents: array(union([TextResourceContentsSchema, BlobResourceContentsSchema]))
    });
    ResourceListChangedNotificationSchema = NotificationSchema.extend({
      method: literal("notifications/resources/list_changed"),
      params: NotificationsParamsSchema.optional()
    });
    SubscribeRequestParamsSchema = ResourceRequestParamsSchema;
    SubscribeRequestSchema = RequestSchema.extend({
      method: literal("resources/subscribe"),
      params: SubscribeRequestParamsSchema
    });
    UnsubscribeRequestParamsSchema = ResourceRequestParamsSchema;
    UnsubscribeRequestSchema = RequestSchema.extend({
      method: literal("resources/unsubscribe"),
      params: UnsubscribeRequestParamsSchema
    });
    ResourceUpdatedNotificationParamsSchema = NotificationsParamsSchema.extend({
      /**
       * The URI of the resource that has been updated. This might be a sub-resource of the one that the client actually subscribed to.
       */
      uri: string2()
    });
    ResourceUpdatedNotificationSchema = NotificationSchema.extend({
      method: literal("notifications/resources/updated"),
      params: ResourceUpdatedNotificationParamsSchema
    });
    PromptArgumentSchema = object({
      /**
       * The name of the argument.
       */
      name: string2(),
      /**
       * A human-readable description of the argument.
       */
      description: optional(string2()),
      /**
       * Whether this argument must be provided.
       */
      required: optional(boolean2())
    });
    PromptSchema = object({
      ...BaseMetadataSchema.shape,
      ...IconsSchema.shape,
      /**
       * An optional description of what this prompt provides
       */
      description: optional(string2()),
      /**
       * A list of arguments to use for templating the prompt.
       */
      arguments: optional(array(PromptArgumentSchema)),
      /**
       * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
       * for notes on _meta usage.
       */
      _meta: optional(looseObject({}))
    });
    ListPromptsRequestSchema = PaginatedRequestSchema.extend({
      method: literal("prompts/list")
    });
    ListPromptsResultSchema = PaginatedResultSchema.extend({
      prompts: array(PromptSchema)
    });
    GetPromptRequestParamsSchema = BaseRequestParamsSchema.extend({
      /**
       * The name of the prompt or prompt template.
       */
      name: string2(),
      /**
       * Arguments to use for templating the prompt.
       */
      arguments: record(string2(), string2()).optional()
    });
    GetPromptRequestSchema = RequestSchema.extend({
      method: literal("prompts/get"),
      params: GetPromptRequestParamsSchema
    });
    TextContentSchema = object({
      type: literal("text"),
      /**
       * The text content of the message.
       */
      text: string2(),
      /**
       * Optional annotations for the client.
       */
      annotations: AnnotationsSchema.optional(),
      /**
       * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
       * for notes on _meta usage.
       */
      _meta: record(string2(), unknown()).optional()
    });
    ImageContentSchema = object({
      type: literal("image"),
      /**
       * The base64-encoded image data.
       */
      data: Base64Schema,
      /**
       * The MIME type of the image. Different providers may support different image types.
       */
      mimeType: string2(),
      /**
       * Optional annotations for the client.
       */
      annotations: AnnotationsSchema.optional(),
      /**
       * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
       * for notes on _meta usage.
       */
      _meta: record(string2(), unknown()).optional()
    });
    AudioContentSchema = object({
      type: literal("audio"),
      /**
       * The base64-encoded audio data.
       */
      data: Base64Schema,
      /**
       * The MIME type of the audio. Different providers may support different audio types.
       */
      mimeType: string2(),
      /**
       * Optional annotations for the client.
       */
      annotations: AnnotationsSchema.optional(),
      /**
       * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
       * for notes on _meta usage.
       */
      _meta: record(string2(), unknown()).optional()
    });
    ToolUseContentSchema = object({
      type: literal("tool_use"),
      /**
       * The name of the tool to invoke.
       * Must match a tool name from the request's tools array.
       */
      name: string2(),
      /**
       * Unique identifier for this tool call.
       * Used to correlate with ToolResultContent in subsequent messages.
       */
      id: string2(),
      /**
       * Arguments to pass to the tool.
       * Must conform to the tool's inputSchema.
       */
      input: record(string2(), unknown()),
      /**
       * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
       * for notes on _meta usage.
       */
      _meta: record(string2(), unknown()).optional()
    });
    EmbeddedResourceSchema = object({
      type: literal("resource"),
      resource: union([TextResourceContentsSchema, BlobResourceContentsSchema]),
      /**
       * Optional annotations for the client.
       */
      annotations: AnnotationsSchema.optional(),
      /**
       * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
       * for notes on _meta usage.
       */
      _meta: record(string2(), unknown()).optional()
    });
    ResourceLinkSchema = ResourceSchema.extend({
      type: literal("resource_link")
    });
    ContentBlockSchema = union([
      TextContentSchema,
      ImageContentSchema,
      AudioContentSchema,
      ResourceLinkSchema,
      EmbeddedResourceSchema
    ]);
    PromptMessageSchema = object({
      role: RoleSchema,
      content: ContentBlockSchema
    });
    GetPromptResultSchema = ResultSchema.extend({
      /**
       * An optional description for the prompt.
       */
      description: string2().optional(),
      messages: array(PromptMessageSchema)
    });
    PromptListChangedNotificationSchema = NotificationSchema.extend({
      method: literal("notifications/prompts/list_changed"),
      params: NotificationsParamsSchema.optional()
    });
    ToolAnnotationsSchema = object({
      /**
       * A human-readable title for the tool.
       */
      title: string2().optional(),
      /**
       * If true, the tool does not modify its environment.
       *
       * Default: false
       */
      readOnlyHint: boolean2().optional(),
      /**
       * If true, the tool may perform destructive updates to its environment.
       * If false, the tool performs only additive updates.
       *
       * (This property is meaningful only when `readOnlyHint == false`)
       *
       * Default: true
       */
      destructiveHint: boolean2().optional(),
      /**
       * If true, calling the tool repeatedly with the same arguments
       * will have no additional effect on the its environment.
       *
       * (This property is meaningful only when `readOnlyHint == false`)
       *
       * Default: false
       */
      idempotentHint: boolean2().optional(),
      /**
       * If true, this tool may interact with an "open world" of external
       * entities. If false, the tool's domain of interaction is closed.
       * For example, the world of a web search tool is open, whereas that
       * of a memory tool is not.
       *
       * Default: true
       */
      openWorldHint: boolean2().optional()
    });
    ToolExecutionSchema = object({
      /**
       * Indicates the tool's preference for task-augmented execution.
       * - "required": Clients MUST invoke the tool as a task
       * - "optional": Clients MAY invoke the tool as a task or normal request
       * - "forbidden": Clients MUST NOT attempt to invoke the tool as a task
       *
       * If not present, defaults to "forbidden".
       */
      taskSupport: _enum(["required", "optional", "forbidden"]).optional()
    });
    ToolSchema = object({
      ...BaseMetadataSchema.shape,
      ...IconsSchema.shape,
      /**
       * A human-readable description of the tool.
       */
      description: string2().optional(),
      /**
       * A JSON Schema 2020-12 object defining the expected parameters for the tool.
       * Must have type: 'object' at the root level per MCP spec.
       */
      inputSchema: object({
        type: literal("object"),
        properties: record(string2(), AssertObjectSchema).optional(),
        required: array(string2()).optional()
      }).catchall(unknown()),
      /**
       * An optional JSON Schema 2020-12 object defining the structure of the tool's output
       * returned in the structuredContent field of a CallToolResult.
       * Must have type: 'object' at the root level per MCP spec.
       */
      outputSchema: object({
        type: literal("object"),
        properties: record(string2(), AssertObjectSchema).optional(),
        required: array(string2()).optional()
      }).catchall(unknown()).optional(),
      /**
       * Optional additional tool information.
       */
      annotations: ToolAnnotationsSchema.optional(),
      /**
       * Execution-related properties for this tool.
       */
      execution: ToolExecutionSchema.optional(),
      /**
       * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
       * for notes on _meta usage.
       */
      _meta: record(string2(), unknown()).optional()
    });
    ListToolsRequestSchema = PaginatedRequestSchema.extend({
      method: literal("tools/list")
    });
    ListToolsResultSchema = PaginatedResultSchema.extend({
      tools: array(ToolSchema)
    });
    CallToolResultSchema = ResultSchema.extend({
      /**
       * A list of content objects that represent the result of the tool call.
       *
       * If the Tool does not define an outputSchema, this field MUST be present in the result.
       * For backwards compatibility, this field is always present, but it may be empty.
       */
      content: array(ContentBlockSchema).default([]),
      /**
       * An object containing structured tool output.
       *
       * If the Tool defines an outputSchema, this field MUST be present in the result, and contain a JSON object that matches the schema.
       */
      structuredContent: record(string2(), unknown()).optional(),
      /**
       * Whether the tool call ended in an error.
       *
       * If not set, this is assumed to be false (the call was successful).
       *
       * Any errors that originate from the tool SHOULD be reported inside the result
       * object, with `isError` set to true, _not_ as an MCP protocol-level error
       * response. Otherwise, the LLM would not be able to see that an error occurred
       * and self-correct.
       *
       * However, any errors in _finding_ the tool, an error indicating that the
       * server does not support tool calls, or any other exceptional conditions,
       * should be reported as an MCP error response.
       */
      isError: boolean2().optional()
    });
    CompatibilityCallToolResultSchema = CallToolResultSchema.or(ResultSchema.extend({
      toolResult: unknown()
    }));
    CallToolRequestParamsSchema = TaskAugmentedRequestParamsSchema.extend({
      /**
       * The name of the tool to call.
       */
      name: string2(),
      /**
       * Arguments to pass to the tool.
       */
      arguments: record(string2(), unknown()).optional()
    });
    CallToolRequestSchema = RequestSchema.extend({
      method: literal("tools/call"),
      params: CallToolRequestParamsSchema
    });
    ToolListChangedNotificationSchema = NotificationSchema.extend({
      method: literal("notifications/tools/list_changed"),
      params: NotificationsParamsSchema.optional()
    });
    ListChangedOptionsBaseSchema = object({
      /**
       * If true, the list will be refreshed automatically when a list changed notification is received.
       * The callback will be called with the updated list.
       *
       * If false, the callback will be called with null items, allowing manual refresh.
       *
       * @default true
       */
      autoRefresh: boolean2().default(true),
      /**
       * Debounce time in milliseconds for list changed notification processing.
       *
       * Multiple notifications received within this timeframe will only trigger one refresh.
       * Set to 0 to disable debouncing.
       *
       * @default 300
       */
      debounceMs: number2().int().nonnegative().default(300)
    });
    LoggingLevelSchema = _enum(["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"]);
    SetLevelRequestParamsSchema = BaseRequestParamsSchema.extend({
      /**
       * The level of logging that the client wants to receive from the server. The server should send all logs at this level and higher (i.e., more severe) to the client as notifications/logging/message.
       */
      level: LoggingLevelSchema
    });
    SetLevelRequestSchema = RequestSchema.extend({
      method: literal("logging/setLevel"),
      params: SetLevelRequestParamsSchema
    });
    LoggingMessageNotificationParamsSchema = NotificationsParamsSchema.extend({
      /**
       * The severity of this log message.
       */
      level: LoggingLevelSchema,
      /**
       * An optional name of the logger issuing this message.
       */
      logger: string2().optional(),
      /**
       * The data to be logged, such as a string message or an object. Any JSON serializable type is allowed here.
       */
      data: unknown()
    });
    LoggingMessageNotificationSchema = NotificationSchema.extend({
      method: literal("notifications/message"),
      params: LoggingMessageNotificationParamsSchema
    });
    ModelHintSchema = object({
      /**
       * A hint for a model name.
       */
      name: string2().optional()
    });
    ModelPreferencesSchema = object({
      /**
       * Optional hints to use for model selection.
       */
      hints: array(ModelHintSchema).optional(),
      /**
       * How much to prioritize cost when selecting a model.
       */
      costPriority: number2().min(0).max(1).optional(),
      /**
       * How much to prioritize sampling speed (latency) when selecting a model.
       */
      speedPriority: number2().min(0).max(1).optional(),
      /**
       * How much to prioritize intelligence and capabilities when selecting a model.
       */
      intelligencePriority: number2().min(0).max(1).optional()
    });
    ToolChoiceSchema = object({
      /**
       * Controls when tools are used:
       * - "auto": Model decides whether to use tools (default)
       * - "required": Model MUST use at least one tool before completing
       * - "none": Model MUST NOT use any tools
       */
      mode: _enum(["auto", "required", "none"]).optional()
    });
    ToolResultContentSchema = object({
      type: literal("tool_result"),
      toolUseId: string2().describe("The unique identifier for the corresponding tool call."),
      content: array(ContentBlockSchema).default([]),
      structuredContent: object({}).loose().optional(),
      isError: boolean2().optional(),
      /**
       * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
       * for notes on _meta usage.
       */
      _meta: record(string2(), unknown()).optional()
    });
    SamplingContentSchema = discriminatedUnion("type", [TextContentSchema, ImageContentSchema, AudioContentSchema]);
    SamplingMessageContentBlockSchema = discriminatedUnion("type", [
      TextContentSchema,
      ImageContentSchema,
      AudioContentSchema,
      ToolUseContentSchema,
      ToolResultContentSchema
    ]);
    SamplingMessageSchema = object({
      role: RoleSchema,
      content: union([SamplingMessageContentBlockSchema, array(SamplingMessageContentBlockSchema)]),
      /**
       * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
       * for notes on _meta usage.
       */
      _meta: record(string2(), unknown()).optional()
    });
    CreateMessageRequestParamsSchema = TaskAugmentedRequestParamsSchema.extend({
      messages: array(SamplingMessageSchema),
      /**
       * The server's preferences for which model to select. The client MAY modify or omit this request.
       */
      modelPreferences: ModelPreferencesSchema.optional(),
      /**
       * An optional system prompt the server wants to use for sampling. The client MAY modify or omit this prompt.
       */
      systemPrompt: string2().optional(),
      /**
       * A request to include context from one or more MCP servers (including the caller), to be attached to the prompt.
       * The client MAY ignore this request.
       *
       * Default is "none". Values "thisServer" and "allServers" are soft-deprecated. Servers SHOULD only use these values if the client
       * declares ClientCapabilities.sampling.context. These values may be removed in future spec releases.
       */
      includeContext: _enum(["none", "thisServer", "allServers"]).optional(),
      temperature: number2().optional(),
      /**
       * The requested maximum number of tokens to sample (to prevent runaway completions).
       *
       * The client MAY choose to sample fewer tokens than the requested maximum.
       */
      maxTokens: number2().int(),
      stopSequences: array(string2()).optional(),
      /**
       * Optional metadata to pass through to the LLM provider. The format of this metadata is provider-specific.
       */
      metadata: AssertObjectSchema.optional(),
      /**
       * Tools that the model may use during generation.
       * The client MUST return an error if this field is provided but ClientCapabilities.sampling.tools is not declared.
       */
      tools: array(ToolSchema).optional(),
      /**
       * Controls how the model uses tools.
       * The client MUST return an error if this field is provided but ClientCapabilities.sampling.tools is not declared.
       * Default is `{ mode: "auto" }`.
       */
      toolChoice: ToolChoiceSchema.optional()
    });
    CreateMessageRequestSchema = RequestSchema.extend({
      method: literal("sampling/createMessage"),
      params: CreateMessageRequestParamsSchema
    });
    CreateMessageResultSchema = ResultSchema.extend({
      /**
       * The name of the model that generated the message.
       */
      model: string2(),
      /**
       * The reason why sampling stopped, if known.
       *
       * Standard values:
       * - "endTurn": Natural end of the assistant's turn
       * - "stopSequence": A stop sequence was encountered
       * - "maxTokens": Maximum token limit was reached
       *
       * This field is an open string to allow for provider-specific stop reasons.
       */
      stopReason: optional(_enum(["endTurn", "stopSequence", "maxTokens"]).or(string2())),
      role: RoleSchema,
      /**
       * Response content. Single content block (text, image, or audio).
       */
      content: SamplingContentSchema
    });
    CreateMessageResultWithToolsSchema = ResultSchema.extend({
      /**
       * The name of the model that generated the message.
       */
      model: string2(),
      /**
       * The reason why sampling stopped, if known.
       *
       * Standard values:
       * - "endTurn": Natural end of the assistant's turn
       * - "stopSequence": A stop sequence was encountered
       * - "maxTokens": Maximum token limit was reached
       * - "toolUse": The model wants to use one or more tools
       *
       * This field is an open string to allow for provider-specific stop reasons.
       */
      stopReason: optional(_enum(["endTurn", "stopSequence", "maxTokens", "toolUse"]).or(string2())),
      role: RoleSchema,
      /**
       * Response content. May be a single block or array. May include ToolUseContent if stopReason is "toolUse".
       */
      content: union([SamplingMessageContentBlockSchema, array(SamplingMessageContentBlockSchema)])
    });
    BooleanSchemaSchema = object({
      type: literal("boolean"),
      title: string2().optional(),
      description: string2().optional(),
      default: boolean2().optional()
    });
    StringSchemaSchema = object({
      type: literal("string"),
      title: string2().optional(),
      description: string2().optional(),
      minLength: number2().optional(),
      maxLength: number2().optional(),
      format: _enum(["email", "uri", "date", "date-time"]).optional(),
      default: string2().optional()
    });
    NumberSchemaSchema = object({
      type: _enum(["number", "integer"]),
      title: string2().optional(),
      description: string2().optional(),
      minimum: number2().optional(),
      maximum: number2().optional(),
      default: number2().optional()
    });
    UntitledSingleSelectEnumSchemaSchema = object({
      type: literal("string"),
      title: string2().optional(),
      description: string2().optional(),
      enum: array(string2()),
      default: string2().optional()
    });
    TitledSingleSelectEnumSchemaSchema = object({
      type: literal("string"),
      title: string2().optional(),
      description: string2().optional(),
      oneOf: array(object({
        const: string2(),
        title: string2()
      })),
      default: string2().optional()
    });
    LegacyTitledEnumSchemaSchema = object({
      type: literal("string"),
      title: string2().optional(),
      description: string2().optional(),
      enum: array(string2()),
      enumNames: array(string2()).optional(),
      default: string2().optional()
    });
    SingleSelectEnumSchemaSchema = union([UntitledSingleSelectEnumSchemaSchema, TitledSingleSelectEnumSchemaSchema]);
    UntitledMultiSelectEnumSchemaSchema = object({
      type: literal("array"),
      title: string2().optional(),
      description: string2().optional(),
      minItems: number2().optional(),
      maxItems: number2().optional(),
      items: object({
        type: literal("string"),
        enum: array(string2())
      }),
      default: array(string2()).optional()
    });
    TitledMultiSelectEnumSchemaSchema = object({
      type: literal("array"),
      title: string2().optional(),
      description: string2().optional(),
      minItems: number2().optional(),
      maxItems: number2().optional(),
      items: object({
        anyOf: array(object({
          const: string2(),
          title: string2()
        }))
      }),
      default: array(string2()).optional()
    });
    MultiSelectEnumSchemaSchema = union([UntitledMultiSelectEnumSchemaSchema, TitledMultiSelectEnumSchemaSchema]);
    EnumSchemaSchema = union([LegacyTitledEnumSchemaSchema, SingleSelectEnumSchemaSchema, MultiSelectEnumSchemaSchema]);
    PrimitiveSchemaDefinitionSchema = union([EnumSchemaSchema, BooleanSchemaSchema, StringSchemaSchema, NumberSchemaSchema]);
    ElicitRequestFormParamsSchema = TaskAugmentedRequestParamsSchema.extend({
      /**
       * The elicitation mode.
       *
       * Optional for backward compatibility. Clients MUST treat missing mode as "form".
       */
      mode: literal("form").optional(),
      /**
       * The message to present to the user describing what information is being requested.
       */
      message: string2(),
      /**
       * A restricted subset of JSON Schema.
       * Only top-level properties are allowed, without nesting.
       */
      requestedSchema: object({
        type: literal("object"),
        properties: record(string2(), PrimitiveSchemaDefinitionSchema),
        required: array(string2()).optional()
      })
    });
    ElicitRequestURLParamsSchema = TaskAugmentedRequestParamsSchema.extend({
      /**
       * The elicitation mode.
       */
      mode: literal("url"),
      /**
       * The message to present to the user explaining why the interaction is needed.
       */
      message: string2(),
      /**
       * The ID of the elicitation, which must be unique within the context of the server.
       * The client MUST treat this ID as an opaque value.
       */
      elicitationId: string2(),
      /**
       * The URL that the user should navigate to.
       */
      url: string2().url()
    });
    ElicitRequestParamsSchema = union([ElicitRequestFormParamsSchema, ElicitRequestURLParamsSchema]);
    ElicitRequestSchema = RequestSchema.extend({
      method: literal("elicitation/create"),
      params: ElicitRequestParamsSchema
    });
    ElicitationCompleteNotificationParamsSchema = NotificationsParamsSchema.extend({
      /**
       * The ID of the elicitation that completed.
       */
      elicitationId: string2()
    });
    ElicitationCompleteNotificationSchema = NotificationSchema.extend({
      method: literal("notifications/elicitation/complete"),
      params: ElicitationCompleteNotificationParamsSchema
    });
    ElicitResultSchema = ResultSchema.extend({
      /**
       * The user action in response to the elicitation.
       * - "accept": User submitted the form/confirmed the action
       * - "decline": User explicitly decline the action
       * - "cancel": User dismissed without making an explicit choice
       */
      action: _enum(["accept", "decline", "cancel"]),
      /**
       * The submitted form data, only present when action is "accept".
       * Contains values matching the requested schema.
       * Per MCP spec, content is "typically omitted" for decline/cancel actions.
       * We normalize null to undefined for leniency while maintaining type compatibility.
       */
      content: preprocess((val) => val === null ? void 0 : val, record(string2(), union([string2(), number2(), boolean2(), array(string2())])).optional())
    });
    ResourceTemplateReferenceSchema = object({
      type: literal("ref/resource"),
      /**
       * The URI or URI template of the resource.
       */
      uri: string2()
    });
    PromptReferenceSchema = object({
      type: literal("ref/prompt"),
      /**
       * The name of the prompt or prompt template
       */
      name: string2()
    });
    CompleteRequestParamsSchema = BaseRequestParamsSchema.extend({
      ref: union([PromptReferenceSchema, ResourceTemplateReferenceSchema]),
      /**
       * The argument's information
       */
      argument: object({
        /**
         * The name of the argument
         */
        name: string2(),
        /**
         * The value of the argument to use for completion matching.
         */
        value: string2()
      }),
      context: object({
        /**
         * Previously-resolved variables in a URI template or prompt.
         */
        arguments: record(string2(), string2()).optional()
      }).optional()
    });
    CompleteRequestSchema = RequestSchema.extend({
      method: literal("completion/complete"),
      params: CompleteRequestParamsSchema
    });
    CompleteResultSchema = ResultSchema.extend({
      completion: looseObject({
        /**
         * An array of completion values. Must not exceed 100 items.
         */
        values: array(string2()).max(100),
        /**
         * The total number of completion options available. This can exceed the number of values actually sent in the response.
         */
        total: optional(number2().int()),
        /**
         * Indicates whether there are additional completion options beyond those provided in the current response, even if the exact total is unknown.
         */
        hasMore: optional(boolean2())
      })
    });
    RootSchema = object({
      /**
       * The URI identifying the root. This *must* start with file:// for now.
       */
      uri: string2().startsWith("file://"),
      /**
       * An optional name for the root.
       */
      name: string2().optional(),
      /**
       * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
       * for notes on _meta usage.
       */
      _meta: record(string2(), unknown()).optional()
    });
    ListRootsRequestSchema = RequestSchema.extend({
      method: literal("roots/list"),
      params: BaseRequestParamsSchema.optional()
    });
    ListRootsResultSchema = ResultSchema.extend({
      roots: array(RootSchema)
    });
    RootsListChangedNotificationSchema = NotificationSchema.extend({
      method: literal("notifications/roots/list_changed"),
      params: NotificationsParamsSchema.optional()
    });
    ClientRequestSchema = union([
      PingRequestSchema,
      InitializeRequestSchema,
      CompleteRequestSchema,
      SetLevelRequestSchema,
      GetPromptRequestSchema,
      ListPromptsRequestSchema,
      ListResourcesRequestSchema,
      ListResourceTemplatesRequestSchema,
      ReadResourceRequestSchema,
      SubscribeRequestSchema,
      UnsubscribeRequestSchema,
      CallToolRequestSchema,
      ListToolsRequestSchema,
      GetTaskRequestSchema,
      GetTaskPayloadRequestSchema,
      ListTasksRequestSchema,
      CancelTaskRequestSchema
    ]);
    ClientNotificationSchema = union([
      CancelledNotificationSchema,
      ProgressNotificationSchema,
      InitializedNotificationSchema,
      RootsListChangedNotificationSchema,
      TaskStatusNotificationSchema
    ]);
    ClientResultSchema = union([
      EmptyResultSchema,
      CreateMessageResultSchema,
      CreateMessageResultWithToolsSchema,
      ElicitResultSchema,
      ListRootsResultSchema,
      GetTaskResultSchema,
      ListTasksResultSchema,
      CreateTaskResultSchema
    ]);
    ServerRequestSchema = union([
      PingRequestSchema,
      CreateMessageRequestSchema,
      ElicitRequestSchema,
      ListRootsRequestSchema,
      GetTaskRequestSchema,
      GetTaskPayloadRequestSchema,
      ListTasksRequestSchema,
      CancelTaskRequestSchema
    ]);
    ServerNotificationSchema = union([
      CancelledNotificationSchema,
      ProgressNotificationSchema,
      LoggingMessageNotificationSchema,
      ResourceUpdatedNotificationSchema,
      ResourceListChangedNotificationSchema,
      ToolListChangedNotificationSchema,
      PromptListChangedNotificationSchema,
      TaskStatusNotificationSchema,
      ElicitationCompleteNotificationSchema
    ]);
    ServerResultSchema = union([
      EmptyResultSchema,
      InitializeResultSchema,
      CompleteResultSchema,
      GetPromptResultSchema,
      ListPromptsResultSchema,
      ListResourcesResultSchema,
      ListResourceTemplatesResultSchema,
      ReadResourceResultSchema,
      CallToolResultSchema,
      ListToolsResultSchema,
      GetTaskResultSchema,
      ListTasksResultSchema,
      CreateTaskResultSchema
    ]);
    McpError = class _McpError extends Error {
      constructor(code, message, data) {
        super(`MCP error ${code}: ${message}`);
        this.code = code;
        this.data = data;
        this.name = "McpError";
      }
      /**
       * Factory method to create the appropriate error type based on the error code and data
       */
      static fromError(code, message, data) {
        if (code === ErrorCode.UrlElicitationRequired && data) {
          const errorData = data;
          if (errorData.elicitations) {
            return new UrlElicitationRequiredError(errorData.elicitations, message);
          }
        }
        return new _McpError(code, message, data);
      }
    };
    UrlElicitationRequiredError = class extends McpError {
      constructor(elicitations, message = `URL elicitation${elicitations.length > 1 ? "s" : ""} required`) {
        super(ErrorCode.UrlElicitationRequired, message, {
          elicitations
        });
      }
      get elicitations() {
        return this.data?.elicitations ?? [];
      }
    };
  }
});

// node_modules/@modelcontextprotocol/sdk/dist/esm/shared/stdio.js
function deserializeMessage(line) {
  return JSONRPCMessageSchema.parse(JSON.parse(line));
}
function serializeMessage(message) {
  return JSON.stringify(message) + "\n";
}
var STDIO_DEFAULT_MAX_BUFFER_SIZE, ReadBuffer;
var init_stdio = __esm({
  "node_modules/@modelcontextprotocol/sdk/dist/esm/shared/stdio.js"() {
    init_types();
    STDIO_DEFAULT_MAX_BUFFER_SIZE = 10 * 1024 * 1024;
    ReadBuffer = class {
      constructor(options) {
        this._maxBufferSize = options?.maxBufferSize ?? STDIO_DEFAULT_MAX_BUFFER_SIZE;
      }
      append(chunk) {
        const newSize = (this._buffer?.length ?? 0) + chunk.length;
        if (newSize > this._maxBufferSize) {
          this.clear();
          throw new Error(`ReadBuffer exceeded maximum size of ${this._maxBufferSize} bytes`);
        }
        this._buffer = this._buffer ? Buffer.concat([this._buffer, chunk]) : chunk;
      }
      readMessage() {
        if (!this._buffer) {
          return null;
        }
        const index = this._buffer.indexOf("\n");
        if (index === -1) {
          return null;
        }
        const line = this._buffer.toString("utf8", 0, index).replace(/\r$/, "");
        this._buffer = this._buffer.subarray(index + 1);
        return deserializeMessage(line);
      }
      clear() {
        this._buffer = void 0;
      }
    };
  }
});

// node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js
import process2 from "node:process";
var StdioServerTransport;
var init_stdio2 = __esm({
  "node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js"() {
    init_stdio();
    StdioServerTransport = class {
      constructor(_stdin = process2.stdin, _stdout = process2.stdout, options) {
        this._stdin = _stdin;
        this._stdout = _stdout;
        this._started = false;
        this._ondata = (chunk) => {
          try {
            this._readBuffer.append(chunk);
            this.processReadBuffer();
          } catch (error2) {
            this.onerror?.(error2);
            this.close().catch(() => {
            });
          }
        };
        this._onerror = (error2) => {
          this.onerror?.(error2);
        };
        this._readBuffer = new ReadBuffer({ maxBufferSize: options?.maxBufferSize });
      }
      /**
       * Starts listening for messages on stdin.
       */
      async start() {
        if (this._started) {
          throw new Error("StdioServerTransport already started! If using Server class, note that connect() calls start() automatically.");
        }
        this._started = true;
        this._stdin.on("data", this._ondata);
        this._stdin.on("error", this._onerror);
      }
      processReadBuffer() {
        while (true) {
          try {
            const message = this._readBuffer.readMessage();
            if (message === null) {
              break;
            }
            this.onmessage?.(message);
          } catch (error2) {
            this.onerror?.(error2);
          }
        }
      }
      async close() {
        this._stdin.off("data", this._ondata);
        this._stdin.off("error", this._onerror);
        const remainingDataListeners = this._stdin.listenerCount("data");
        if (remainingDataListeners === 0) {
          this._stdin.pause();
        }
        this._readBuffer.clear();
        this.onclose?.();
      }
      send(message) {
        return new Promise((resolve9) => {
          const json = serializeMessage(message);
          if (this._stdout.write(json)) {
            resolve9();
          } else {
            this._stdout.once("drain", resolve9);
          }
        });
      }
    };
  }
});

// src/errors.ts
function toWireError(e) {
  if (e && typeof e === "object" && typeof e.code === "string") {
    const err = e;
    const data = err.data ?? (err.occluder !== void 0 ? { occluder: err.occluder } : void 0);
    return { code: err.code, message: err.message ?? err.code, ...data !== void 0 ? { data } : {} };
  }
  return { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) };
}
var BridgeError, RemoteError;
var init_errors3 = __esm({
  "src/errors.ts"() {
    "use strict";
    BridgeError = class extends Error {
      code;
      data;
      constructor(code, message, data) {
        super(message);
        this.name = "BridgeError";
        this.code = code;
        if (data !== void 0) this.data = data;
      }
    };
    RemoteError = class extends Error {
      code;
      data;
      constructor(wire) {
        super(wire.message);
        this.name = "RemoteError";
        this.code = wire.code;
        if (wire.data !== void 0) this.data = wire.data;
      }
    };
  }
});

// daemon/src/client.ts
import { readFileSync as readFileSync5 } from "node:fs";
function clientFromEnv(env = process.env) {
  const id = env.ATRIUM_BRIDGE_CLIENT_ID?.trim();
  if (!id) return void 0;
  if (!isClientId(id)) {
    throw new BridgeError("CLIENT_INVALID", `ATRIUM_BRIDGE_CLIENT_ID must match ${CLIENT_ID_PATTERN.source} (1 to 64 of letters, digits, . _ : @ -)`);
  }
  const name = cleanClientName(env.ATRIUM_BRIDGE_CLIENT_NAME);
  return name ? { id, name } : { id };
}
function resolvePort(env = process.env) {
  const fromEnv = envPort(env);
  if (fromEnv !== void 0) return fromEnv;
  try {
    return readConfig(bridgeHome(env))?.port ?? DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}
function apiKeyFromEnv(env = process.env) {
  const file = env.ATRIUM_BRIDGE_KEY_FILE;
  if (file) {
    let value = "";
    try {
      value = readFileSync5(file, "utf8").trim();
    } catch (e) {
      throw new BridgeError("KEY_UNAVAILABLE", `cannot read the API key file ATRIUM_BRIDGE_KEY_FILE=${file} (${e.code ?? "error"})`);
    }
    if (!value) throw new BridgeError("KEY_UNAVAILABLE", `the API key file ATRIUM_BRIDGE_KEY_FILE=${file} is empty`);
    return value;
  }
  const direct = env.ATRIUM_BRIDGE_KEY?.trim();
  if (direct) return direct;
  return readLocalKey(bridgeHome(env));
}
function targetFromEnv(env = process.env) {
  const home3 = bridgeHome(env);
  const config2 = readConfig(home3);
  if (!config2) {
    throw new BridgeError(
      "DAEMON_NOT_CONFIGURED",
      `no Atrium Bridge config in ${home3} yet: the daemon creates it the first time it starts (node daemon/src/cli.ts start)`,
      { phase: "before-send" }
    );
  }
  const apiKey = apiKeyFromEnv(env);
  if (!apiKey) {
    throw new BridgeError(
      "KEY_UNAVAILABLE",
      `no API key for the Atrium Bridge in ${home3}: create one with \`key create <name>\` and give it to this process by ATRIUM_BRIDGE_KEY_FILE`
    );
  }
  const client = clientFromEnv(env);
  return { port: envPort(env) ?? config2.port, apiKey, ...client ? { client } : {} };
}
function uploadKeyOf(get) {
  try {
    return get();
  } catch (e) {
    throw new BridgeError("KEY_UNAVAILABLE", `cannot prepare the upload key of the MCP server (upload.key): ${e.message}`);
  }
}
function causeCodes(e) {
  const codes = [];
  const visit = (x, depth) => {
    if (!x || typeof x !== "object" || depth > 3) return;
    const o = x;
    if (typeof o.code === "string") codes.push(o.code);
    visit(o.cause, depth + 1);
    if (Array.isArray(o.errors)) for (const sub of o.errors) visit(sub, depth + 1);
  };
  visit(e, 0);
  return codes;
}
function classifyFetchFailure(e) {
  return causeCodes(e).some((code) => BEFORE_SEND_CODES.has(code)) ? "before-send" : "in-flight";
}
function downPhase(e) {
  const err = e;
  if (err?.code === "DAEMON_NOT_CONFIGURED") return "before-send";
  if (err?.code === "DAEMON_UNREACHABLE") return err.data?.phase === "in-flight" ? "in-flight" : "before-send";
  return void 0;
}
function unreachable(port, e) {
  const timedOut = e?.name === "TimeoutError";
  const why = timedOut ? "no answer in time" : [e.message, ...causeCodes(e)].join(": ");
  return new BridgeError("DAEMON_UNREACHABLE", `cannot reach the Atrium Bridge daemon on 127.0.0.1:${port} (${why}). Is it running?`, {
    phase: classifyFetchFailure(e)
  });
}
var CONTROL_TIMEOUT_MS, DAEMON_CALL_TIMEOUT_MS, CALL_MARGIN_MS, envPort, BEFORE_SEND_CODES, BridgeClient;
var init_client = __esm({
  "daemon/src/client.ts"() {
    "use strict";
    init_errors3();
    init_protocol();
    init_config();
    CONTROL_TIMEOUT_MS = 5e3;
    DAEMON_CALL_TIMEOUT_MS = 6e4;
    CALL_MARGIN_MS = 15e3;
    envPort = (env) => {
      const n = Number(env.ATRIUM_BRIDGE_PORT);
      return env.ATRIUM_BRIDGE_PORT && Number.isInteger(n) && n > 0 && n < 65536 ? n : void 0;
    };
    BEFORE_SEND_CODES = /* @__PURE__ */ new Set([
      "ECONNREFUSED",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "EADDRNOTAVAIL",
      "ENOTFOUND",
      "EAI_AGAIN",
      "UND_ERR_CONNECT_TIMEOUT"
    ]);
    BridgeClient = class {
      target;
      controlTimeoutMs;
      callMarginMs;
      constructor(target, opts = {}) {
        this.target = target;
        this.controlTimeoutMs = opts.controlTimeoutMs ?? CONTROL_TIMEOUT_MS;
        this.callMarginMs = opts.callMarginMs ?? CALL_MARGIN_MS;
      }
      async request(method, path, timeoutMs, body, upload = false) {
        const target = typeof this.target === "function" ? this.target() : this.target;
        const bearer = upload && target.uploadKey ? uploadKeyOf(target.uploadKey) : target.apiKey;
        let res;
        let text;
        try {
          res = await fetch(`http://127.0.0.1:${target.port}${path}`, {
            method,
            headers: {
              authorization: `Bearer ${bearer}`,
              // Uma conexão nova por pedido. Com o keep-alive do pool, o 1º pedido depois da morte do daemon reaproveita o
              // socket morto e falha como ECONNRESET ("em voo"), mesmo sem ter saído nada. Assim, ECONNREFUSED prova que o
              // pedido não saiu, e a classificação de classifyFetchFailure vale. Em loopback a conexão nova custa microssegundos.
              connection: "close",
              // Quem chama, quando a casca se identificou: o daemon loga o id e o repassa à extensão em cada `call`.
              ...target.client ? { [CLIENT_ID_HEADER]: target.client.id } : {},
              ...target.client?.name ? { [CLIENT_NAME_HEADER]: target.client.name } : {},
              ...body !== void 0 ? { "content-type": "application/json" } : {}
            },
            ...body !== void 0 ? { body: JSON.stringify(body) } : {},
            signal: AbortSignal.timeout(timeoutMs)
          });
          text = await res.text();
        } catch (e) {
          throw unreachable(target.port, e);
        }
        let payload = null;
        try {
          payload = JSON.parse(text);
        } catch {
        }
        if (!res.ok || !payload || payload.ok === false) {
          throw new RemoteError(payload?.error ?? { code: "INTERNAL", message: `daemon answered HTTP ${res.status}` });
        }
        return payload;
      }
      async browsers() {
        return (await this.request("GET", "/browsers", this.controlTimeoutMs)).browsers;
      }
      /** GET /status: browsers com abas sob controle e último foco, clientes vistos, pausa. O que um hospedeiro mostra. */
      async status() {
        return await this.request("GET", "/status", this.controlTimeoutMs);
      }
      /** POST /clients/:id/release: o agente `clientId` encerrou; cada browser solta as abas dele e recolhe o grupo dele. */
      async releaseClient(clientId) {
        const deadline = DAEMON_CALL_TIMEOUT_MS + this.callMarginMs;
        return (await this.request("POST", `/clients/${encodeURIComponent(clientId)}/release`, deadline)).browsers;
      }
      /** POST /pause: nenhuma tool roda e toda extensão solta as abas sob controle, até `resume`. Devolve o que cada browser soltou. */
      async pause() {
        const r = await this.request("POST", "/pause", DAEMON_CALL_TIMEOUT_MS + this.callMarginMs);
        return { paused: true, browsers: r.browsers };
      }
      /** POST /resume: as tools voltam a rodar (o escopo começa vazio: abas novas, ou a pessoa entrega de novo). */
      async resume() {
        await this.request("POST", "/resume", this.controlTimeoutMs);
        return { paused: false };
      }
      async call(browserId, tool, args, timeoutMs) {
        const body = { tool, args, ...timeoutMs ? { timeoutMs } : {} };
        const deadline = Math.min(timeoutMs ?? DAEMON_CALL_TIMEOUT_MS, 6e5) + this.callMarginMs;
        return (await this.request("POST", `/browsers/${encodeURIComponent(browserId)}/call`, deadline, body, UPLOAD_TOOLS.has(tool))).result;
      }
    };
  }
});

// src/texts.ts
var SERVER_NAME, REF, REF_OR_POINT, X, Y, COMMON_PARAMS, BRIDGE_TOOL_TEXTS, BROWSER_TEXTS, DAEMON_TEXTS;
var init_texts = __esm({
  "src/texts.ts"() {
    "use strict";
    SERVER_NAME = "atrium-bridge";
    REF = 'Element ref from the latest snapshot of this tab (for example "e12").';
    REF_OR_POINT = `${REF} Alternatively give x and y instead of ref.`;
    X = "Horizontal pixel coordinate in the viewport (use together with y, instead of ref).";
    Y = "Vertical pixel coordinate in the viewport (use together with x, instead of ref).";
    COMMON_PARAMS = {
      browser: "Which connected browser to act in: its id or its name, as listed by list_browsers. Optional when exactly one browser is connected. With several connected and this omitted, the call goes to the browser the user focused most recently and the result starts with a Notice saying which one; pass browser to choose. If no browser has reported focus yet the call fails with BROWSER_AMBIGUOUS: ask the user which one, unless they already said.",
      tab: "Tab id from the tabs tool. Optional: defaults to the current tab of that browser."
    };
    BRIDGE_TOOL_TEXTS = {
      list_browsers: {
        description: 'List the user browsers connected to the Atrium Bridge: { id, name, userAgent, connectedAt, lastFocusedAt? }. Call it first when you do not know which browser to use. With one browser you can use it directly; with several, the other tools default to the one the user focused most recently (lastFocusedAt) and say so in a Notice; pass browser when the user said which one ("in Brave").',
        params: {}
      },
      navigate: {
        description: 'Open a URL in a tab you control and wait for the page to load, or move in the tab history with action "back", "forward" or "reload". Give url or action, not both. Returns the final URL and the page title. Only http(s) and about:blank are accepted. Refs from before the navigation go stale: take a new snapshot afterwards.',
        params: {
          url: 'Absolute URL, for example "https://example.com/".',
          action: '"back", "forward" or "reload" (instead of url). back/forward fail with NAVIGATION_FAILED at the ends of the history.'
        }
      },
      wait: {
        description: 'Wait for something to happen in the tab: for "load" (the page finished loading), "networkidle" (no network requests for 500 ms), "text" (value appears in the visible text of the page, case sensitive), "selector" (an element matching the CSS selector in value is visible), "url" (the page URL contains value) or "time" (value milliseconds pass). The condition is checked right away: if it already holds the call returns at once. Fails with WAIT_TIMEOUT when it does not happen in time. Returns { matched, elapsedMs, url }.',
        params: {
          for: '"load", "networkidle", "text", "selector", "url" or "time".',
          value: "The text, CSS selector, URL fragment or number of milliseconds, depending on for. Not used with load and networkidle.",
          timeoutMs: "How long to wait, in milliseconds, up to 120000. Default 15000."
        }
      },
      find: {
        description: "Search the page for elements by role, accessible name or text, without reading the whole tree. Takes a fresh snapshot, so the returned refs work right away in click, type and the other tools (and older refs go stale). Give at least one of role, name or text; matches are case-insensitive. Returns { url, title, found: [{ ref, role, name, box }] }.",
        params: {
          role: "Exact ARIA role, for example button, link or textbox.",
          name: "Part of the accessible name.",
          text: "Part of the visible text of the element (its name or its own text).",
          limit: "Maximum results. Default 20."
        }
      },
      read: {
        description: "Read the text of the page in reading order (the main content when the page has one), with the URL of each link after its text. Cheaper than snapshot when you only need to read. Returns { url, title, text, truncated, source } and says when the text was cut.",
        params: { maxChars: "Character limit before the text is cut. Default 50000." }
      },
      links: {
        description: "List the visible links of the page: { ref, text, href } with absolute URLs, without repeating the same href and text. Takes a fresh snapshot, so the refs work in click. Links with neither text nor accessible name are left out (pass includeUnnamed to see them).",
        params: {
          limit: "Maximum links. Default 100.",
          includeUnnamed: "Also list links with no text and no accessible name (icons without a label, empty anchors). Default false."
        }
      },
      snapshot: {
        description: "Read the page as an accessibility tree. Interactive elements carry a ref like [ref=e12] and a box [box=x,y,width,height]. Use it before acting: every ref you pass to the other tools must come from the latest snapshot of the same tab, and a navigation makes older refs stale.",
        params: { depth: "Limit the depth of the tree on very large pages." }
      },
      screenshot: {
        description: "Capture the visible part of the tab (or the whole page, or one element) as an image. The tab must be the active tab of its window.",
        params: {
          fullPage: "Capture the whole scrollable page instead of the viewport.",
          ref: "Capture only this element.",
          format: '"png" (default) or "jpeg".',
          quality: "JPEG quality, 1 to 100."
        }
      },
      click: {
        description: "Click like a person: the pointer travels along a curved path to the element, then presses and releases the button (trusted events). If something covers the target the error names what covers it.",
        params: {
          ref: REF_OR_POINT,
          x: X,
          y: Y,
          button: '"left" (default), "right" or "middle".',
          count: "1 (default), 2 (double click) or 3 (triple click)."
        }
      },
      hover: {
        description: "Move the pointer to the element or point along a human path and leave it there (real :hover, tooltips and menus open).",
        params: { ref: REF_OR_POINT, x: X, y: Y }
      },
      drag: {
        description: "Press at the source, move along a human path with the button held, release at the destination. Mouse-driven drag only: native HTML5 drag-and-drop is not synthesized.",
        params: {
          ref: "Source element ref.",
          x: "Source x (instead of ref).",
          y: "Source y (instead of ref).",
          toRef: "Destination element ref.",
          toX: "Destination x (instead of toRef).",
          toY: "Destination y (instead of toRef)."
        }
      },
      scroll: {
        description: 'Scroll with the mouse wheel. Give byX/byY for a relative scroll, or to "top"/"bottom" for the ends of the page; with ref the element is scrolled into view. Returns the resulting scroll position.',
        params: {
          ref: "Element to scroll into view.",
          x: "Wheel x position (default: viewport center).",
          y: "Wheel y position (default: viewport center).",
          byX: "Horizontal pixels to scroll (positive = right).",
          byY: "Vertical pixels to scroll (positive = down).",
          to: '"top" or "bottom": scroll until the page stops moving.'
        }
      },
      type: {
        description: "Type text into the focused element, key by key (trusted keyboard events), or into the element given by ref (it is clicked first to focus it). Fails with NO_FOCUS when nothing editable has focus.",
        params: {
          text: "The text. A newline presses Enter.",
          ref: "Element to click and type into.",
          mode: '"keys" (default): one key at a time. "paste": insert all at once.'
        }
      },
      pressKey: {
        description: 'Press a key or a combination, for example "Enter", "Tab", "ArrowDown", "Control+a", "Shift+Tab", "Control+Shift+ArrowRight". Goes to the focused element of the page.',
        params: {
          key: 'Key name or combination joined by "+".',
          hold: "Modifier names to hold while pressing (Control, Shift, Alt, Meta); same effect as writing them in the combination."
        }
      },
      tabs: {
        description: `Manage the tabs the agent controls. The agent only sees and controls tabs it opened itself and tabs the user handed over with the "Hand this tab to Atrium" button; they live in a tab group named "Atrium". Actions: list, new (opens a tab and makes it current), close, activate. When several agents share the browser, each one owns the tabs it opened (its own tab group and its own current tab); tabs the user handed over without choosing an agent are shared. "list" also shows other agents' tabs, marked ownedByOther: acting on one of those fails with TAB_OWNED_BY_OTHER. Open your own tab instead. An identified agent gets a browser window of its own: "new" opens there (created behind the user's window, never stealing focus, reused afterwards) unless where is "user-window". Tabs a page opens from one of your tabs (popups, target=_blank, OAuth) join your tabs automatically.`,
        params: {
          action: '"list", "new", "close" or "activate".',
          url: 'URL for "new" (default about:blank).',
          where: 'For "new": "agent-window" (default: the window of this agent, created unfocused if needed) or "user-window" (the window the user is in, as a tab next to theirs).'
        }
      },
      dialog: {
        description: 'Answer a native dialog (alert, confirm, prompt or beforeunload) that the page opened. While a dialog is open the page is blocked and every other tool on that tab fails with DIALOG_OPEN, telling you the dialog type and message; nothing is accepted or dismissed for you. "accept" presses OK (with text as the answer of a prompt; default: the prompt default), "dismiss" presses Cancel. Returns { type, message, action }.',
        params: {
          action: '"accept" (OK) or "dismiss" (Cancel).',
          text: "The answer to type into a prompt (only with accept on a prompt)."
        }
      },
      select: {
        description: "Choose an option of a native <select> (dropdown) by its value or its visible label; give exactly one. Sets the selection and fires input and change, but these events are not isTrusted (no real click on the list). Reports the option that ended up selected and whether it changed; fails with OPTION_NOT_FOUND (listing the options), OPTION_AMBIGUOUS or OPTION_DISABLED. For a custom dropdown, click it and click its option instead.",
        params: {
          ref: `The select. ${REF}`,
          value: "The option value attribute.",
          label: "Visible text of the option."
        }
      },
      setChecked: {
        description: "Leave a checkbox, radio button or switch checked or unchecked. It clicks like a person (trusted click) only if the current state differs, then confirms the result. Fails with NOT_CHECKABLE when the element has no checked state and STATE_NOT_CHANGED when the click did not flip it (a radio cannot be unchecked).",
        params: { ref: REF, checked: "The state you want." }
      },
      readConsole: {
        description: "Read the console of the tab (console.* calls, uncaught errors and browser log entries) collected since the tab came under control. Each entry has a seq number; pass the last one as afterSeq to read only what is new.",
        params: {
          level: "Minimum level: debug, log, info, warning or error.",
          afterSeq: "Only entries with seq greater than this.",
          limit: "Maximum entries (default 100, at most 500).",
          clear: "Drop the buffer after reading."
        }
      },
      upload: {
        description: 'Attach files from the disk of this computer to a file input (<input type="file">) of the page, like the user picking them in the file dialog: the input gets the files and fires input/change. Give the ref of the file input (find it with snapshot or find) and absolute paths of files on this machine. This sends the file contents to the website, so the operator must authorize it: unless an authorization already covers it, the operator is asked for each file (the MCP client shows the file, its folder and the destination site) and answers "decline", "only this file" or "this folder to this site until the end of the session". An authorization is always a PAIR of one folder (and its subfolders) and one exact site (scheme, host and port of the page that owns the field); any other folder or site asks again. A folder that is too broad (a drive root, the home folder, an allowed upload folder itself, a folder that contains one of those, a .ssh, .git or .gnupg folder, or a folder with .env, .git or .ssh in it) never becomes a pair: its files go only one at a time. If the page that owns the field changes site before or while the files are attached, the field is emptied and the upload is refused. If the operator declines, or nobody can answer (a client without elicitation, or an agent running in the background), nothing is sent and the error says how to get it authorized: the operator calls allowUploads with that folder and that site, from a session where the question can be shown. Files in a folder the operator pre-authorized (ATRIUM_BRIDGE_UPLOAD_DIRS_TRUSTED) go without asking. A field inside an embedded frame from another site than the tab is never covered by an authorization or a pre-authorized folder: it is asked every time, or refused. Only files inside the allowed upload folders are accepted (by default the Downloads folder of the user; the operator can list others in the ATRIUM_BRIDGE_UPLOAD_DIRS environment variable of this MCP server, absolute paths separated by ";" on Windows and ":" elsewhere); a path outside them is refused with an explanation. Fails with NOT_A_FILE_INPUT when the ref is not a file input and UPLOAD_NOT_ALLOWED when it is not authorized. Returns { files: [{ name, size, type }] }.',
        params: {
          ref: `The file input. ${REF}`,
          paths: "Absolute paths of the files to attach (several only if the input has the multiple attribute)."
        }
      },
      allowUploads: {
        description: "Ask the operator, ahead of time, to allow upload to send files from one folder (and its subfolders) to one exact site until this MCP session ends, without asking again for each file. Use it before uploads that will run where the question cannot be shown (for example a background agent), or when many files from the same folder go to the same site. The operator sees the folder and the site and answers yes or no; if this MCP client cannot ask (no elicitation), the request is refused. The folder must be inside the allowed upload folders (ATRIUM_BRIDGE_UPLOAD_DIRS; by default Downloads) and must not be too broad: a drive root, the home folder, an allowed upload folder itself, a folder that contains one of those, a .ssh, .git or .gnupg folder, or a folder with .env, .git or .ssh directly in it is refused without asking; use a subfolder that holds only the files to send. The authorization lives only in the memory of this MCP server (not in the Bridge daemon, not on disk) and ends when this MCP server stops. It never covers a field embedded from another site. See the current authorizations with uploadPermissions; remove them with revokeUploads.",
        params: {
          folder: 'Absolute path of the folder whose files may be sent, for example "C:/Users/me/Downloads/invoices". Links are resolved: the real folder is what is authorized.',
          origin: 'The exact site that may receive them: scheme, host and port, for example "https://portal.example.com" or "http://localhost:3000". A path after it is ignored.'
        }
      },
      uploadPermissions: {
        description: "List the upload authorizations of this MCP session: each pair of folder and site that upload may use without asking, with when and how it was granted. They live only in memory and end with the session. Folders pre-authorized by the operator in ATRIUM_BRIDGE_UPLOAD_DIRS_TRUSTED are listed apart.",
        params: {}
      },
      revokeUploads: {
        description: "Remove upload authorizations of this MCP session for one site: all of them for that site, or only the one for a given folder. Uploads from then on ask the operator again. Returns what was removed and what is left. It does not touch ATRIUM_BRIDGE_UPLOAD_DIRS_TRUSTED.",
        params: {
          folder: "Absolute path of the folder to remove. Omit it to remove every authorization for the site.",
          origin: 'The site whose authorizations are removed: scheme, host and port, for example "https://portal.example.com".'
        }
      },
      download: {
        description: "Download a file into the user's Downloads folder and wait for it to finish. Either click a ref (a link or button that starts a download, with a real click) or give a url to fetch directly (http(s), with the cookies of the browser). Returns { id, path, bytes, mime, url, state } once the file is complete; fails with DOWNLOAD_FAILED (reason from the browser) or DOWNLOAD_TIMEOUT (the id still works in downloads list). Use pdf to save the page itself.",
        params: {
          ref: "Element whose click starts the download (instead of url).",
          url: "URL to download directly (instead of ref).",
          timeoutMs: "How long to wait for the file to complete, in milliseconds, up to 600000. Default 60000."
        }
      },
      downloads: {
        description: "List the downloads this bridge started in the browser (through download or pdf), newest first: { downloads: [{ id, path, bytes, mime, url, state, startedAt }] }. Downloads the user made by themselves are not listed.",
        params: {
          action: '"list".',
          limit: "Maximum entries (default 50, at most 200)."
        }
      },
      pdf: {
        description: "Save the page as a PDF file in the user's Downloads folder (like Print to PDF). Returns { path, bytes, title, url }. Optional landscape, scale, pageRanges and filename. Fails with PDF_FAILED when the page cannot be printed.",
        params: {
          filename: 'File name (without folder; ".pdf" is added if missing). Default: the page title. An existing name gets a numeric suffix.',
          landscape: "Landscape orientation (default false).",
          scale: "Zoom of the rendering, 0.1 to 2 (default 1).",
          pageRanges: 'Pages to include, like "1-3, 5" (default all).',
          printBackground: "Print background colors and images (default true)."
        }
      },
      readNetwork: {
        description: "Read the network requests of the tab seen since it came under control (page loads, fetch/XHR, scripts, images...), oldest first: { requests: [{ seq, id, url, method, type, status, mimeType, durationMs, bytes, error? }], lastSeq }. Pass afterSeq to read only what is new and urlContains to filter. To read one response, give its id (from the list) with body true: returns { request, body: { text, base64Encoded, truncated } }; BODY_UNAVAILABLE when the browser no longer has it (after a navigation, for example). WebSocket and EventSource traffic is not listed.",
        params: {
          afterSeq: "Only requests with seq greater than this.",
          limit: "Maximum requests in the list (default 100, at most 500).",
          urlContains: "Only requests whose URL contains this text.",
          id: "Request id from the list, to read a single request (with body for its response body).",
          body: "With id: also return the response body (text, or base64 for binary), cut at maxChars.",
          maxChars: "Character limit of the body (default 100000, at most 1000000)."
        }
      },
      resize: {
        description: "Set the size of the viewport of the tab in CSS pixels (the page sees the new innerWidth/innerHeight, media queries react, screenshot captures that size). Emulated per tab, independent of the window; stays until the tab leaves the agent's control or reset is passed. Returns { width, height, innerWidth, innerHeight }.",
        params: {
          width: "Viewport width in CSS pixels (1 to 10000).",
          height: "Viewport height in CSS pixels (1 to 10000).",
          reset: "Remove the emulation and go back to the real window size (width and height are then ignored)."
        }
      },
      evaluate: {
        description: 'Run a JavaScript expression in the page and return its JSON-serializable value. Use it for reading page state that the snapshot does not show; use click/type for actions so the events are real. Promises are awaited. Allowed in the tabs the agent opened; in a tab the user handed over it fails with EVALUATE_DISABLED until the user enables "C\xF3digo na p\xE1gina" in the extension (the installation can also turn evaluate fully on or off).',
        params: {
          expression: 'JavaScript expression, for example "document.title".',
          awaitPromise: "Await the value when it is a promise (default true)."
        }
      }
    };
    BROWSER_TEXTS = {
      /** Primeiro bloco de texto do resultado quando a casca escolheu o browser pelo foco. */
      focusedNotice: (name) => `Notice: usei "${name}", o navegador em que voc\xEA mexeu por \xFAltimo; passe browser= para escolher.`
    };
    DAEMON_TEXTS = {
      /** Sucesso de uma chamada que precisou reiniciar o daemon. Vai como primeiro bloco de texto do resultado. */
      restartedNotice: "Notice: the Atrium Bridge daemon had stopped and was restarted before this call. The browser reconnected by itself; tabs handed over to Atrium were kept. Refs from an earlier snapshot may be stale: take a new snapshot before clicking.",
      /** DAEMON_RESTARTED: o daemon caiu com a chamada em voo e a chamada não é uma leitura pura (não se repete). */
      restarted: (tool) => `the Atrium Bridge daemon went down while ${tool} was in flight and was restarted. The action may or may not have happened. Nothing else was done. Take a snapshot to see the current state before repeating it.`,
      /** Acrescentado à falha do reinício quando uma chamada não repetível estava em voo: o agente precisa saber das duas coisas. */
      lostSuffix: (tool) => `Also, ${tool} was in flight when the daemon went down: the action may or may not have happened.`,
      /** DAEMON_CRASH_LOOP: o disjuntor está aberto; nenhuma tentativa de subir o daemon enquanto a pausa durar. */
      crashLoop: (o) => `the Atrium Bridge daemon was restarted ${o.restarts} times in the last ${o.minutes} minutes and keeps dying; automatic restarts are paused for the next ${o.pauseSeconds} s.` + (o.tail ? ` Last lines of ${o.logFile}:
${o.tail}
` : " ") + "Tell the user.",
      /** DAEMON_START_FAILED: o spawn falhou, o processo caiu, ou o /health não respondeu. `reason` vem de `startReasons`. */
      startFailed: (o) => `the Atrium Bridge daemon could not be started: ${o.reason}.` + (o.tail ? ` Last lines of ${o.logFile}:
${o.tail}` : ""),
      /** Motivos de DAEMON_START_FAILED, na ordem em que a casca os observa. */
      startReasons: {
        spawnFailed: (message) => `the daemon process could not be launched (${message})`,
        exited: (code) => code === null ? "the daemon process was killed before it was listening" : `the daemon process exited with code ${code} before it was listening`,
        notReady: (seconds) => `the daemon did not answer /health within ${seconds} s`,
        portMute: (port, owner) => `port ${port} is held by a process that does not answer /health${owner ? ` (pid ${owner})` : ""}; stop it or free the port`,
        portForeign: (port, owner) => `port ${port} is in use by another program${owner ? ` (pid ${owner})` : ""} that is not the Atrium Bridge daemon; free the port or set ATRIUM_BRIDGE_PORT`
      },
      /** Acrescentado a NO_BROWSER_CONNECTED / BROWSER_NOT_FOUND quando a casca esperou a extensão reaparecer e ela não veio. */
      waitedSuffix: (o) => `The daemon was restarted ${o.ageSeconds} s ago and the extension reconnects by itself (usually within 30 s); I waited ${o.waitedSeconds} s for it. Try again in a moment.`
    };
  }
});

// daemon/src/embedded.ts
import { execFile, spawn } from "node:child_process";
import { existsSync as existsSync4, mkdirSync as mkdirSync3 } from "node:fs";
import { createServer } from "node:net";
import { resolve as resolve3 } from "node:path";
function childEnv(extra) {
  const env = {};
  for (const key of ENV_ALLOWLIST) if (process.env[key] !== void 0) env[key] = process.env[key];
  return { ...env, ...extra };
}
function scrub(text) {
  return text.replace(/sup_[A-Za-z0-9_-]+/g, "sup_[redacted]").replace(/device_code["'=:\s]+[A-Za-z0-9_-]{8,}/gi, "device_code=[redacted]").replace(/\u001b\[[0-9;]*m/g, "");
}
async function assertPortFree(port) {
  await new Promise((resolveFree, reject) => {
    const probe = createServer();
    probe.once(
      "error",
      (e) => reject(
        e.code === "EADDRINUSE" ? new Error(`port ${port} (Bridge port + 1) is already in use; the embedded supervisor needs it`) : e
      )
    );
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolveFree()));
  });
}
function startEmbeddedSupervisor(opts) {
  const dataDir = supervisorHome(opts.home);
  const baseEnv = {
    SUPERVISOR_DATA_DIR: dataDir,
    SUPERVISOR_DEVICE_VERIFICATION_ORIGIN: opts.verificationOrigin
  };
  let status = "starting";
  let detail;
  let child = null;
  let exited = Promise.resolve();
  const tail = [];
  const fail = (message) => {
    if (status === "stopped") return;
    status = "failed";
    detail = scrub(message).slice(0, 500);
    opts.log("supervisor_failed", { detail });
  };
  const cli = (args, timeout) => new Promise((resolveCli, reject) => {
    execFile(
      process.execPath,
      ["scripts/supervisor.mjs", ...args],
      { cwd: SUPERVISOR_SERVICE_DIR, env: childEnv({ ...baseEnv, LOG_LEVEL: "warn" }), timeout, windowsHide: true },
      (error2, _stdout, stderr) => {
        if (!error2) return resolveCli({ code: 0, stderr });
        const code = error2.code;
        if (typeof code === "number") return resolveCli({ code, stderr });
        reject(error2);
      }
    );
  });
  const ready = (async () => {
    if (!existsSync4(SUPERVISOR_SERVICE_DIR)) throw new Error(`supervisor service not found at ${SUPERVISOR_SERVICE_DIR}`);
    if (opts.envFile !== void 0 && !existsSync4(opts.envFile)) throw new Error(`supervisor env file not found: ${opts.envFile}`);
    await assertPortFree(opts.port);
    mkdirSync3(dataDir, { recursive: true });
    const args = [
      "scripts/supervisor.mjs",
      "serve",
      "--port",
      String(opts.port),
      "--hostname",
      "127.0.0.1",
      "--data-dir",
      dataDir,
      ...opts.envFile !== void 0 ? ["--env-file", opts.envFile] : []
    ];
    opts.log("supervisor_starting", { port: opts.port, envFile: opts.envFile !== void 0 });
    const proc = spawn(process.execPath, args, {
      cwd: SUPERVISOR_SERVICE_DIR,
      env: childEnv(baseEnv),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    child = proc;
    opts.log("supervisor_spawned", { pid: proc.pid });
    const keep = (chunk) => {
      tail.push(chunk.toString());
      if (tail.length > 60) tail.shift();
    };
    proc.stdout?.on("data", keep);
    proc.stderr?.on("data", keep);
    let exitCode;
    exited = new Promise((resolveExit) => {
      proc.once("exit", (code) => {
        exitCode = code;
        if (status === "running" || status === "starting") fail(`supervisor exited unexpectedly (code ${code})`);
        else opts.log("supervisor_exited", { code });
        resolveExit();
      });
    });
    process.once("exit", () => proc.kill());
    const deadline = Date.now() + (opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
    for (; ; ) {
      if (exitCode !== void 0) throw new Error(`supervisor exited during startup (code ${exitCode}):
${scrub(tail.join("")).slice(-1200)}`);
      if (status === "stopped") throw new Error("stopped during startup");
      try {
        if ((await fetch(`http://127.0.0.1:${opts.port}/healthz`)).ok) break;
      } catch {
      }
      if (Date.now() > deadline) {
        proc.kill();
        throw new Error(`supervisor did not become healthy within ${opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS} ms`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    const added = await cli(["operators", "add", EMBEDDED_OWNER], APPROVE_TIMEOUT_MS);
    if (added.code !== 0) throw new Error(`could not register the local owner (exit ${added.code}): ${scrub(added.stderr).slice(0, 300)}`);
    if (status === "starting") status = "running";
    opts.log("supervisor_ready", { port: opts.port });
  })();
  ready.catch((e) => fail(e instanceof Error ? e.message : String(e)));
  let queue = Promise.resolve();
  const approve = (userCode) => {
    const run = async () => {
      if (status !== "running") throw new BridgeError("EMBEDDED_UNAVAILABLE", `the embedded supervisor is ${status}`);
      const code = normalizeUserCode(userCode);
      if (!code) throw Object.assign(new Error("user_code is malformed"), { code: "INVALID_ARGUMENT" });
      const result = await cli(["device", "approve", code, "--sub", EMBEDDED_OWNER], APPROVE_TIMEOUT_MS);
      if (result.code === 2) throw new BridgeError("DEVICE_REQUEST_NOT_FOUND", "no live device request with that code (expired or never started)");
      if (result.code !== 0) throw new BridgeError("EMBEDDED_UNAVAILABLE", `the supervisor refused the approval: ${scrub(result.stderr).slice(0, 200)}`);
    };
    const next = queue.then(run, run);
    queue = next.catch(() => void 0);
    return next;
  };
  return {
    port: opts.port,
    state: () => ({ status, port: opts.port, ...detail !== void 0 ? { detail } : {} }),
    ready,
    approve,
    async stop() {
      const wasStopped = status === "stopped";
      status = "stopped";
      if (wasStopped) return;
      const proc = child;
      if (proc && proc.exitCode === null) proc.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3e4))]);
    }
  };
}
var EMBEDDED_OWNER, SUPERVISOR_SERVICE_DIR, DEFAULT_START_TIMEOUT_MS, APPROVE_TIMEOUT_MS, USER_CODE, ENV_ALLOWLIST, normalizeUserCode;
var init_embedded = __esm({
  "daemon/src/embedded.ts"() {
    "use strict";
    init_errors3();
    init_config();
    EMBEDDED_OWNER = "owner@atrium-bridge.local";
    SUPERVISOR_SERVICE_DIR = resolve3(import.meta.dirname, "../../../../services/supervisor");
    DEFAULT_START_TIMEOUT_MS = 24e4;
    APPROVE_TIMEOUT_MS = 12e4;
    USER_CODE = /^[A-Z0-9]{4,12}(?:-[A-Z0-9]{4,12})?$/;
    ENV_ALLOWLIST = [
      "PATH",
      "Path",
      "PATHEXT",
      "SystemRoot",
      "SYSTEMROOT",
      "windir",
      "COMSPEC",
      "OS",
      "TEMP",
      "TMP",
      "TMPDIR",
      "USERPROFILE",
      "HOME",
      "HOMEDRIVE",
      "HOMEPATH",
      "USERNAME",
      "APPDATA",
      "LOCALAPPDATA",
      "ProgramData",
      "ProgramFiles",
      "ProgramFiles(x86)",
      "PROCESSOR_ARCHITECTURE",
      "NUMBER_OF_PROCESSORS",
      "LANG",
      "LC_ALL",
      "TERM"
    ];
    normalizeUserCode = (raw) => {
      const code = raw.trim().toUpperCase();
      return USER_CODE.test(code) ? code : null;
    };
  }
});

// daemon/src/ensure.ts
import { execFile as execFile2, spawn as spawn2 } from "node:child_process";
import { appendFileSync, closeSync, fstatSync, mkdirSync as mkdirSync4, openSync, readFileSync as readFileSync6, readSync, renameSync as renameSync2, statSync as statSync3 } from "node:fs";
import { request } from "node:http";
import { dirname as dirname3, resolve as resolve4 } from "node:path";
function createEnsure(ops, opts) {
  const breaker2 = new Breaker(opts.breaker, ops.now);
  const reasons = DAEMON_TEXTS.startReasons;
  let opening;
  let startedAt = null;
  const startFailed = (reason) => new BridgeError("DAEMON_START_FAILED", DAEMON_TEXTS.startFailed({ reason, logFile: opts.logFile, tail: ops.logTail() }));
  const crashLoop = (restarts, retryInMs) => new BridgeError(
    "DAEMON_CRASH_LOOP",
    DAEMON_TEXTS.crashLoop({
      restarts,
      minutes: Math.round(opts.breaker.windowMs / 6e4),
      pauseSeconds: Math.ceil(retryInMs / 1e3),
      logFile: opts.logFile,
      tail: ops.logTail()
    })
  );
  async function killHung(port, owner) {
    const pid = ops.readPid();
    if (pid === null || !ops.isAlive(pid)) {
      ops.log("daemon_kill_skipped", { why: pid === null ? "no-pid-file" : "pid-not-alive" });
      return false;
    }
    if (owner !== pid) {
      ops.log("daemon_kill_skipped", { why: "pid-is-not-the-port-owner", pid, owner });
      return false;
    }
    try {
      await ops.killTree(pid);
    } catch (e) {
      ops.log("daemon_kill_failed", { pid, reason: e instanceof Error ? e.message : String(e) });
      return false;
    }
    ops.log("daemon_killed", { pid });
    const until = ops.now() + opts.killWaitMs;
    while (ops.now() < until && await ops.probe(port, opts.quickProbeMs) !== "refused") await ops.sleep(opts.pollMs);
    return true;
  }
  async function run(source) {
    const port = opts.port();
    if (await ops.probe(port, opts.quickProbeMs) === "ok") return { restarted: false, source };
    let busyKnown = false;
    let killed = false;
    let skipDelay = false;
    let attempts = 0;
    let reason = "";
    const startOnce = async () => {
      const began = ops.now();
      ops.log("daemon_spawning", { port });
      const child = ops.spawn(port);
      ops.log("daemon_spawned", { pid: child.pid ?? null });
      const state = {};
      void child.exited.then((e) => {
        state.exit = e;
      });
      const ready = (by) => {
        startedAt = ops.now();
        ops.log("daemon_ready", { ms: startedAt - began, pid: child.pid ?? null, by });
        return { kind: "ready" };
      };
      for (; ; ) {
        await ops.sleep(opts.pollMs);
        const exit = state.exit;
        if (!exit && await ops.probe(port, opts.quickProbeMs) === "ok") return ready("child");
        if (exit) {
          const confirm = await ops.probe(port, busyKnown ? opts.quickProbeMs : opts.hungAfterMs);
          if (confirm === "ok") return ready("other");
          if (confirm === "refused") {
            return { kind: "failed", reason: exit.error !== void 0 ? reasons.spawnFailed(exit.error) : reasons.exited(exit.code) };
          }
          busyKnown = true;
          const owner = await ops.portOwner(port);
          return {
            kind: "busy",
            verdict: confirm,
            owner,
            reason: confirm === "mute" ? reasons.portMute(port, owner) : reasons.portForeign(port, owner)
          };
        }
        if (ops.now() - began > opts.readyTimeoutMs) {
          if (child.pid !== void 0) await ops.killTree(child.pid).catch(noop);
          return { kind: "failed", reason: reasons.notReady(Math.round(opts.readyTimeoutMs / 1e3)) };
        }
      }
    };
    for (; ; ) {
      const admission = breaker2.admit();
      if (!admission.allowed) {
        ops.log("breaker_open", { restarts: admission.restarts, retryInMs: admission.retryInMs });
        if (attempts === 0) throw crashLoop(admission.restarts, admission.retryInMs);
        break;
      }
      attempts++;
      const wait = admission.halfOpen || skipDelay ? 0 : opts.backoffMs[Math.min(admission.index, opts.backoffMs.length - 1)] ?? 0;
      skipDelay = false;
      if (wait > 0) await ops.sleep(wait);
      const result = await startOnce();
      if (result.kind === "ready") {
        breaker2.succeeded();
        return { restarted: true, source };
      }
      reason = result.reason;
      if (result.kind === "busy") {
        if (result.verdict === "foreign") {
          breaker2.failed();
          break;
        }
        if (!killed && await killHung(port, result.owner)) {
          killed = true;
          skipDelay = true;
          continue;
        }
      }
      breaker2.failed();
      if (admission.halfOpen || attempts >= opts.maxAttempts) break;
    }
    ops.log("daemon_start_failed", { reason, attempts });
    throw startFailed(reason);
  }
  const ensure2 = (source = "call") => opening ??= run(source).finally(() => {
    opening = void 0;
  });
  return {
    ensure: ensure2,
    async warmup() {
      if (opening) {
        await opening.then(noop, noop);
        return;
      }
      if (await ops.probe(opts.port(), opts.quickProbeMs) !== "refused") return;
      await ensure2("warmup").then(noop, noop);
    },
    youngAgeMs() {
      const stamps = [startedAt, ops.pidWrittenAt()].filter((t) => t !== null);
      if (stamps.length === 0) return null;
      const age = Math.max(0, ops.now() - Math.max(...stamps));
      return age < opts.youngMs ? age : null;
    }
  };
}
function daemonEnv(home3) {
  return childEnv({ ATRIUM_BRIDGE_HOME: resolve4(home3) });
}
function probeHealth(port, timeoutMs) {
  return new Promise((resolve9) => {
    let settled = false;
    let timer;
    const finish = (result, req2) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      req2?.destroy();
      resolve9(result);
    };
    const req = request(
      { host: "127.0.0.1", port, path: "/health", method: "GET", agent: false, headers: { connection: "close" } },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > 64 * 1024) return finish("foreign", req);
          chunks.push(c);
        });
        res.on("error", () => finish("mute", req));
        res.on("end", () => {
          let ok = false;
          try {
            ok = res.statusCode === 200 && JSON.parse(Buffer.concat(chunks).toString("utf8")).ok === true;
          } catch {
          }
          finish(ok ? "ok" : "foreign", req);
        });
      }
    );
    timer = setTimeout(() => finish("mute", req), timeoutMs);
    req.on("error", (e) => finish(e.code === "ECONNREFUSED" ? "refused" : "mute", req));
    req.end();
  });
}
function parseListenOwner(output, port) {
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*TCP\s+\S+:(\d+)\s+(?:0\.0\.0\.0:0|\[::\]:0)\s+\S+\s+(\d+)\s*$/i.exec(line);
    if (m && Number(m[1]) === port) return Number(m[2]);
  }
  return null;
}
function exec(cmd, args) {
  return new Promise((resolve9) => {
    execFile2(cmd, args, { windowsHide: true, timeout: 1e4, maxBuffer: 4 * 1024 * 1024 }, (_e, stdout) => resolve9(String(stdout ?? "")));
  });
}
async function portOwner(port) {
  if (process.platform === "win32") return parseListenOwner(await exec("netstat", ["-ano", "-p", "TCP"]), port);
  const n = Number((await exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])).trim().split(/\s+/)[0]);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
async function killTree(pid) {
  if (process.platform === "win32") {
    await exec("taskkill", ["/PID", String(pid), "/T", "/F"]);
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
  }
}
function rotateLog(file, maxBytes = LOG_MAX_BYTES) {
  try {
    if (statSync3(file).size > maxBytes) renameSync2(file, `${file}.1`);
  } catch {
  }
}
function readTail(file, maxBytes = 4096, maxLines = 12) {
  let fd;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
    if (size > maxBytes) lines.shift();
    return scrub(lines.slice(-maxLines).map((l) => l.slice(0, 300)).join("\n"));
  } catch {
    return "";
  } finally {
    if (fd !== void 0) closeSync(fd);
  }
}
function redactTokens(text, home3) {
  try {
    const config2 = readConfig(home3);
    if (!config2) return text;
    const secrets = [config2.pairingToken, readLocalKey(home3), process.env.ATRIUM_BRIDGE_KEY?.trim()];
    try {
      secrets.push(apiKeyFromEnv() ?? void 0);
    } catch {
    }
    try {
      secrets.push(readFileSync6(uploadKeyPath(home3), "utf8").trim() || void 0);
    } catch {
    }
    return secrets.filter((x) => !!x).reduce((t, secret) => t.split(secret).join("[redacted]"), text);
  } catch {
    return text;
  }
}
function createShellLog(file) {
  let prepared = false;
  let writes = 0;
  return (event, fields = {}) => {
    const line = `${JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), event, mcp: process.pid, ...fields })}
`;
    try {
      if (!prepared) {
        mkdirSync4(dirname3(file), { recursive: true });
        rotateLog(file);
        prepared = true;
      } else if (++writes % 200 === 0) {
        rotateLog(file);
      }
      appendFileSync(file, line);
    } catch {
    }
    try {
      process.stderr.write(line);
    } catch {
    }
  };
}
function spawnDaemon(home3, launch2, port) {
  const logFile = daemonLogPath(home3);
  let fd;
  try {
    mkdirSync4(home3, { recursive: true });
    rotateLog(logFile);
    fd = openSync(logFile, "a");
    const child = spawn2(process.execPath, [...launch2.execArgv, launch2.entry, ...launch2.args, "--port", String(port)], {
      cwd: resolve4(home3),
      env: daemonEnv(home3),
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd]
    });
    const exited = new Promise((resolve9) => {
      child.once("error", (e) => resolve9({ code: null, error: e.message }));
      child.once("exit", (code) => resolve9({ code }));
    });
    child.unref();
    return { pid: child.pid, exited };
  } catch (e) {
    return { pid: void 0, exited: Promise.resolve({ code: null, error: e instanceof Error ? e.message : String(e) }) };
  } finally {
    if (fd !== void 0) closeSync(fd);
  }
}
function nodeEnsureOps(cfg) {
  const { home: home3, launch: launch2, log: log2 } = cfg;
  return {
    probe: probeHealth,
    spawn: (port) => spawnDaemon(home3, launch2, port),
    readPid: () => readDaemonPid(home3),
    pidWrittenAt: () => daemonPidWrittenAt(home3),
    isAlive,
    portOwner,
    killTree,
    logTail: () => redactTokens(readTail(daemonLogPath(home3)), home3),
    sleep: (ms) => new Promise((resolve9) => setTimeout(resolve9, ms)),
    now: () => Date.now(),
    log: log2
  };
}
var ENSURE_DEFAULTS, Breaker, noop, LOG_MAX_BYTES;
var init_ensure = __esm({
  "daemon/src/ensure.ts"() {
    "use strict";
    init_errors3();
    init_texts();
    init_config();
    init_client();
    init_embedded();
    ENSURE_DEFAULTS = {
      readyTimeoutMs: 15e3,
      pollMs: 200,
      quickProbeMs: 1e3,
      hungAfterMs: 5e3,
      killWaitMs: 5e3,
      maxAttempts: 3,
      backoffMs: [0, 2e3, 5e3],
      breaker: { threshold: 3, windowMs: 5 * 6e4, pauseMs: 6e4 },
      youngMs: 6e4
    };
    Breaker = class {
      events = [];
      openUntil = 0;
      tripped = false;
      opts;
      now;
      constructor(opts, now) {
        this.opts = opts;
        this.now = now;
      }
      prune(t) {
        this.events = this.events.filter((e) => t - e < this.opts.windowMs);
      }
      admit() {
        const t = this.now();
        this.prune(t);
        if (this.tripped) {
          if (t < this.openUntil) return { allowed: false, restarts: this.events.length, retryInMs: this.openUntil - t };
          this.events.push(t);
          return { allowed: true, halfOpen: true, index: 0 };
        }
        if (this.events.length >= this.opts.threshold) {
          this.tripped = true;
          this.openUntil = t + this.opts.pauseMs;
          return { allowed: false, restarts: this.events.length, retryInMs: this.opts.pauseMs };
        }
        const index = this.events.length;
        this.events.push(t);
        return { allowed: true, halfOpen: false, index };
      }
      /** A tentativa deu certo: se era a do meio-aberto, o disjuntor fecha e o histórico some. */
      succeeded() {
        if (!this.tripped) return;
        this.tripped = false;
        this.events = [];
      }
      /** A tentativa falhou: se era a do meio-aberto, reabre por mais uma pausa. */
      failed() {
        if (this.tripped) this.openUntil = this.now() + this.opts.pauseMs;
      }
    };
    noop = () => void 0;
    LOG_MAX_BYTES = 5 * 1024 * 1024;
  }
});

// node_modules/zod/v4/mini/parse.js
var init_parse3 = __esm({
  "node_modules/zod/v4/mini/parse.js"() {
    init_core2();
  }
});

// node_modules/zod/v4/mini/schemas.js
var init_schemas3 = __esm({
  "node_modules/zod/v4/mini/schemas.js"() {
  }
});

// node_modules/zod/v4/mini/checks.js
var init_checks3 = __esm({
  "node_modules/zod/v4/mini/checks.js"() {
  }
});

// node_modules/zod/v4/mini/iso.js
var init_iso2 = __esm({
  "node_modules/zod/v4/mini/iso.js"() {
  }
});

// node_modules/zod/v4/mini/coerce.js
var init_coerce2 = __esm({
  "node_modules/zod/v4/mini/coerce.js"() {
  }
});

// node_modules/zod/v4/mini/external.js
var init_external2 = __esm({
  "node_modules/zod/v4/mini/external.js"() {
    init_core2();
    init_parse3();
    init_schemas3();
    init_checks3();
    init_locales();
    init_iso2();
    init_coerce2();
  }
});

// node_modules/zod/v4-mini/index.js
var init_v4_mini = __esm({
  "node_modules/zod/v4-mini/index.js"() {
    init_external2();
  }
});

// node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-compat.js
function isZ4Schema(s) {
  const schema = s;
  return !!schema._zod;
}
function safeParse3(schema, data) {
  if (isZ4Schema(schema)) {
    const result2 = safeParse(schema, data);
    return result2;
  }
  const v3Schema = schema;
  const result = v3Schema.safeParse(data);
  return result;
}
function getObjectShape(schema) {
  if (!schema)
    return void 0;
  let rawShape2;
  if (isZ4Schema(schema)) {
    const v4Schema = schema;
    rawShape2 = v4Schema._zod?.def?.shape;
  } else {
    const v3Schema = schema;
    rawShape2 = v3Schema.shape;
  }
  if (!rawShape2)
    return void 0;
  if (typeof rawShape2 === "function") {
    try {
      return rawShape2();
    } catch {
      return void 0;
    }
  }
  return rawShape2;
}
function getLiteralValue(schema) {
  if (isZ4Schema(schema)) {
    const v4Schema = schema;
    const def4 = v4Schema._zod?.def;
    if (def4) {
      if (def4.value !== void 0)
        return def4.value;
      if (Array.isArray(def4.values) && def4.values.length > 0) {
        return def4.values[0];
      }
    }
  }
  const v3Schema = schema;
  const def3 = v3Schema._def;
  if (def3) {
    if (def3.value !== void 0)
      return def3.value;
    if (Array.isArray(def3.values) && def3.values.length > 0) {
      return def3.values[0];
    }
  }
  const directValue = schema.value;
  if (directValue !== void 0)
    return directValue;
  return void 0;
}
var init_zod_compat = __esm({
  "node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-compat.js"() {
    init_v4_mini();
  }
});

// node_modules/@modelcontextprotocol/sdk/dist/esm/experimental/tasks/interfaces.js
function isTerminal(status) {
  return status === "completed" || status === "failed" || status === "cancelled";
}
var init_interfaces = __esm({
  "node_modules/@modelcontextprotocol/sdk/dist/esm/experimental/tasks/interfaces.js"() {
  }
});

// node_modules/zod-to-json-schema/dist/esm/Options.js
var ignoreOverride;
var init_Options = __esm({
  "node_modules/zod-to-json-schema/dist/esm/Options.js"() {
    ignoreOverride = Symbol("Let zodToJsonSchema decide on which parser to use");
  }
});

// node_modules/zod-to-json-schema/dist/esm/Refs.js
var init_Refs = __esm({
  "node_modules/zod-to-json-schema/dist/esm/Refs.js"() {
    init_Options();
  }
});

// node_modules/zod-to-json-schema/dist/esm/errorMessages.js
var init_errorMessages = __esm({
  "node_modules/zod-to-json-schema/dist/esm/errorMessages.js"() {
  }
});

// node_modules/zod-to-json-schema/dist/esm/getRelativePath.js
var init_getRelativePath = __esm({
  "node_modules/zod-to-json-schema/dist/esm/getRelativePath.js"() {
  }
});

// node_modules/zod-to-json-schema/dist/esm/parsers/any.js
var init_any = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parsers/any.js"() {
    init_getRelativePath();
  }
});

// node_modules/zod-to-json-schema/dist/esm/parsers/array.js
var init_array = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parsers/array.js"() {
    init_errorMessages();
    init_parseDef();
  }
});

// node_modules/zod-to-json-schema/dist/esm/parsers/bigint.js
var init_bigint = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parsers/bigint.js"() {
    init_errorMessages();
  }
});

// node_modules/zod-to-json-schema/dist/esm/parsers/boolean.js
var init_boolean = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parsers/boolean.js"() {
  }
});

// node_modules/zod-to-json-schema/dist/esm/parsers/branded.js
var init_branded = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parsers/branded.js"() {
    init_parseDef();
  }
});

// node_modules/zod-to-json-schema/dist/esm/parsers/catch.js
var init_catch = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parsers/catch.js"() {
    init_parseDef();
  }
});

// node_modules/zod-to-json-schema/dist/esm/parsers/date.js
var init_date = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parsers/date.js"() {
    init_errorMessages();
  }
});

// node_modules/zod-to-json-schema/dist/esm/parsers/default.js
var init_default = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parsers/default.js"() {
    init_parseDef();
  }
});

// node_modules/zod-to-json-schema/dist/esm/parsers/effects.js
var init_effects = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parsers/effects.js"() {
    init_parseDef();
    init_any();
  }
});

// node_modules/zod-to-json-schema/dist/esm/parsers/enum.js
var init_enum = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parsers/enum.js"() {
  }
});

// node_modules/zod-to-json-schema/dist/esm/parsers/intersection.js
var init_intersection = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parsers/intersection.js"() {
    init_parseDef();
  }
});

// node_modules/zod-to-json-schema/dist/esm/parsers/literal.js
var init_literal = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parsers/literal.js"() {
  }
});

// node_modules/zod-to-json-schema/dist/esm/parsers/string.js
var ALPHA_NUMERIC;
var init_string = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parsers/string.js"() {
    init_errorMessages();
    ALPHA_NUMERIC = new Set("ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvxyz0123456789");
  }
});

// node_modules/zod-to-json-schema/dist/esm/parsers/record.js
var init_record = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parsers/record.js"() {
    init_parseDef();
    init_string();
    init_branded();
    init_any();
  }
});

// node_modules/zod-to-json-schema/dist/esm/parsers/map.js
var init_map = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parsers/map.js"() {
    init_parseDef();
    init_record();
    init_any();
  }
});

// node_modules/zod-to-json-schema/dist/esm/parsers/nativeEnum.js
var init_nativeEnum = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parsers/nativeEnum.js"() {
  }
});

// node_modules/zod-to-json-schema/dist/esm/parsers/never.js
var init_never = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parsers/never.js"() {
    init_any();
  }
});

// node_modules/zod-to-json-schema/dist/esm/parsers/null.js
var init_null = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parsers/null.js"() {
  }
});

// node_modules/zod-to-json-schema/dist/esm/parsers/union.js
var init_union = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parsers/union.js"() {
    init_parseDef();
  }
});

// node_modules/zod-to-json-schema/dist/esm/parsers/nullable.js
var init_nullable = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parsers/nullable.js"() {
    init_parseDef();
    init_union();
  }
});

// node_modules/zod-to-json-schema/dist/esm/parsers/number.js
var init_number = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parsers/number.js"() {
    init_errorMessages();
  }
});

// node_modules/zod-to-json-schema/dist/esm/parsers/object.js
var init_object = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parsers/object.js"() {
    init_parseDef();
  }
});

// node_modules/zod-to-json-schema/dist/esm/parsers/optional.js
var init_optional = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parsers/optional.js"() {
    init_parseDef();
    init_any();
  }
});

// node_modules/zod-to-json-schema/dist/esm/parsers/pipeline.js
var init_pipeline = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parsers/pipeline.js"() {
    init_parseDef();
  }
});

// node_modules/zod-to-json-schema/dist/esm/parsers/promise.js
var init_promise = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parsers/promise.js"() {
    init_parseDef();
  }
});

// node_modules/zod-to-json-schema/dist/esm/parsers/set.js
var init_set = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parsers/set.js"() {
    init_errorMessages();
    init_parseDef();
  }
});

// node_modules/zod-to-json-schema/dist/esm/parsers/tuple.js
var init_tuple = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parsers/tuple.js"() {
    init_parseDef();
  }
});

// node_modules/zod-to-json-schema/dist/esm/parsers/undefined.js
var init_undefined = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parsers/undefined.js"() {
    init_any();
  }
});

// node_modules/zod-to-json-schema/dist/esm/parsers/unknown.js
var init_unknown = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parsers/unknown.js"() {
    init_any();
  }
});

// node_modules/zod-to-json-schema/dist/esm/parsers/readonly.js
var init_readonly = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parsers/readonly.js"() {
    init_parseDef();
  }
});

// node_modules/zod-to-json-schema/dist/esm/selectParser.js
var init_selectParser = __esm({
  "node_modules/zod-to-json-schema/dist/esm/selectParser.js"() {
    init_any();
    init_array();
    init_bigint();
    init_boolean();
    init_branded();
    init_catch();
    init_date();
    init_default();
    init_effects();
    init_enum();
    init_intersection();
    init_literal();
    init_map();
    init_nativeEnum();
    init_never();
    init_null();
    init_nullable();
    init_number();
    init_object();
    init_optional();
    init_pipeline();
    init_promise();
    init_record();
    init_set();
    init_string();
    init_tuple();
    init_undefined();
    init_union();
    init_unknown();
    init_readonly();
  }
});

// node_modules/zod-to-json-schema/dist/esm/parseDef.js
var init_parseDef = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parseDef.js"() {
    init_Options();
    init_selectParser();
    init_getRelativePath();
    init_any();
  }
});

// node_modules/zod-to-json-schema/dist/esm/parseTypes.js
var init_parseTypes = __esm({
  "node_modules/zod-to-json-schema/dist/esm/parseTypes.js"() {
  }
});

// node_modules/zod-to-json-schema/dist/esm/zodToJsonSchema.js
var init_zodToJsonSchema = __esm({
  "node_modules/zod-to-json-schema/dist/esm/zodToJsonSchema.js"() {
    init_parseDef();
    init_Refs();
    init_any();
  }
});

// node_modules/zod-to-json-schema/dist/esm/index.js
var init_esm = __esm({
  "node_modules/zod-to-json-schema/dist/esm/index.js"() {
    init_Options();
    init_Refs();
    init_errorMessages();
    init_getRelativePath();
    init_parseDef();
    init_parseTypes();
    init_any();
    init_array();
    init_bigint();
    init_boolean();
    init_branded();
    init_catch();
    init_date();
    init_default();
    init_effects();
    init_enum();
    init_intersection();
    init_literal();
    init_map();
    init_nativeEnum();
    init_never();
    init_null();
    init_nullable();
    init_number();
    init_object();
    init_optional();
    init_pipeline();
    init_promise();
    init_readonly();
    init_record();
    init_set();
    init_string();
    init_tuple();
    init_undefined();
    init_union();
    init_unknown();
    init_selectParser();
    init_zodToJsonSchema();
    init_zodToJsonSchema();
  }
});

// node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-json-schema-compat.js
function getMethodLiteral(schema) {
  const shape = getObjectShape(schema);
  const methodSchema = shape?.method;
  if (!methodSchema) {
    throw new Error("Schema is missing a method literal");
  }
  const value = getLiteralValue(methodSchema);
  if (typeof value !== "string") {
    throw new Error("Schema method literal must be a string");
  }
  return value;
}
function parseWithCompat(schema, data) {
  const result = safeParse3(schema, data);
  if (!result.success) {
    throw result.error;
  }
  return result.data;
}
var init_zod_json_schema_compat = __esm({
  "node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-json-schema-compat.js"() {
    init_zod_compat();
    init_esm();
  }
});

// node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js
function isPlainObject2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function mergeCapabilities(base, additional) {
  const result = { ...base };
  for (const key in additional) {
    const k = key;
    const addValue = additional[k];
    if (addValue === void 0)
      continue;
    const baseValue = result[k];
    if (isPlainObject2(baseValue) && isPlainObject2(addValue)) {
      result[k] = { ...baseValue, ...addValue };
    } else {
      result[k] = addValue;
    }
  }
  return result;
}
var DEFAULT_REQUEST_TIMEOUT_MSEC, Protocol;
var init_protocol2 = __esm({
  "node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js"() {
    init_zod_compat();
    init_types();
    init_interfaces();
    init_zod_json_schema_compat();
    DEFAULT_REQUEST_TIMEOUT_MSEC = 6e4;
    Protocol = class {
      constructor(_options) {
        this._options = _options;
        this._requestMessageId = 0;
        this._requestHandlers = /* @__PURE__ */ new Map();
        this._requestHandlerAbortControllers = /* @__PURE__ */ new Map();
        this._notificationHandlers = /* @__PURE__ */ new Map();
        this._responseHandlers = /* @__PURE__ */ new Map();
        this._progressHandlers = /* @__PURE__ */ new Map();
        this._timeoutInfo = /* @__PURE__ */ new Map();
        this._pendingDebouncedNotifications = /* @__PURE__ */ new Set();
        this._taskProgressTokens = /* @__PURE__ */ new Map();
        this._requestResolvers = /* @__PURE__ */ new Map();
        this.setNotificationHandler(CancelledNotificationSchema, (notification) => {
          this._oncancel(notification);
        });
        this.setNotificationHandler(ProgressNotificationSchema, (notification) => {
          this._onprogress(notification);
        });
        this.setRequestHandler(
          PingRequestSchema,
          // Automatic pong by default.
          (_request) => ({})
        );
        this._taskStore = _options?.taskStore;
        this._taskMessageQueue = _options?.taskMessageQueue;
        if (this._taskStore) {
          this.setRequestHandler(GetTaskRequestSchema, async (request2, extra) => {
            const task = await this._taskStore.getTask(request2.params.taskId, extra.sessionId);
            if (!task) {
              throw new McpError(ErrorCode.InvalidParams, "Failed to retrieve task: Task not found");
            }
            return {
              ...task
            };
          });
          this.setRequestHandler(GetTaskPayloadRequestSchema, async (request2, extra) => {
            const handleTaskResult = async () => {
              const taskId = request2.params.taskId;
              if (this._taskMessageQueue) {
                let queuedMessage;
                while (queuedMessage = await this._taskMessageQueue.dequeue(taskId, extra.sessionId)) {
                  if (queuedMessage.type === "response" || queuedMessage.type === "error") {
                    const message = queuedMessage.message;
                    const requestId = message.id;
                    const resolver = this._requestResolvers.get(requestId);
                    if (resolver) {
                      this._requestResolvers.delete(requestId);
                      if (queuedMessage.type === "response") {
                        resolver(message);
                      } else {
                        const errorMessage = message;
                        const error2 = new McpError(errorMessage.error.code, errorMessage.error.message, errorMessage.error.data);
                        resolver(error2);
                      }
                    } else {
                      const messageType = queuedMessage.type === "response" ? "Response" : "Error";
                      this._onerror(new Error(`${messageType} handler missing for request ${requestId}`));
                    }
                    continue;
                  }
                  await this._transport?.send(queuedMessage.message, { relatedRequestId: extra.requestId });
                }
              }
              const task = await this._taskStore.getTask(taskId, extra.sessionId);
              if (!task) {
                throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`);
              }
              if (!isTerminal(task.status)) {
                await this._waitForTaskUpdate(taskId, extra.signal);
                return await handleTaskResult();
              }
              if (isTerminal(task.status)) {
                const result = await this._taskStore.getTaskResult(taskId, extra.sessionId);
                this._clearTaskQueue(taskId);
                return {
                  ...result,
                  _meta: {
                    ...result._meta,
                    [RELATED_TASK_META_KEY]: {
                      taskId
                    }
                  }
                };
              }
              return await handleTaskResult();
            };
            return await handleTaskResult();
          });
          this.setRequestHandler(ListTasksRequestSchema, async (request2, extra) => {
            try {
              const { tasks, nextCursor } = await this._taskStore.listTasks(request2.params?.cursor, extra.sessionId);
              return {
                tasks,
                nextCursor,
                _meta: {}
              };
            } catch (error2) {
              throw new McpError(ErrorCode.InvalidParams, `Failed to list tasks: ${error2 instanceof Error ? error2.message : String(error2)}`);
            }
          });
          this.setRequestHandler(CancelTaskRequestSchema, async (request2, extra) => {
            try {
              const task = await this._taskStore.getTask(request2.params.taskId, extra.sessionId);
              if (!task) {
                throw new McpError(ErrorCode.InvalidParams, `Task not found: ${request2.params.taskId}`);
              }
              if (isTerminal(task.status)) {
                throw new McpError(ErrorCode.InvalidParams, `Cannot cancel task in terminal status: ${task.status}`);
              }
              await this._taskStore.updateTaskStatus(request2.params.taskId, "cancelled", "Client cancelled task execution.", extra.sessionId);
              this._clearTaskQueue(request2.params.taskId);
              const cancelledTask = await this._taskStore.getTask(request2.params.taskId, extra.sessionId);
              if (!cancelledTask) {
                throw new McpError(ErrorCode.InvalidParams, `Task not found after cancellation: ${request2.params.taskId}`);
              }
              return {
                _meta: {},
                ...cancelledTask
              };
            } catch (error2) {
              if (error2 instanceof McpError) {
                throw error2;
              }
              throw new McpError(ErrorCode.InvalidRequest, `Failed to cancel task: ${error2 instanceof Error ? error2.message : String(error2)}`);
            }
          });
        }
      }
      async _oncancel(notification) {
        if (!notification.params.requestId) {
          return;
        }
        const controller = this._requestHandlerAbortControllers.get(notification.params.requestId);
        controller?.abort(notification.params.reason);
      }
      _setupTimeout(messageId, timeout, maxTotalTimeout, onTimeout, resetTimeoutOnProgress = false) {
        this._timeoutInfo.set(messageId, {
          timeoutId: setTimeout(onTimeout, timeout),
          startTime: Date.now(),
          timeout,
          maxTotalTimeout,
          resetTimeoutOnProgress,
          onTimeout
        });
      }
      _resetTimeout(messageId) {
        const info2 = this._timeoutInfo.get(messageId);
        if (!info2)
          return false;
        const totalElapsed = Date.now() - info2.startTime;
        if (info2.maxTotalTimeout && totalElapsed >= info2.maxTotalTimeout) {
          this._timeoutInfo.delete(messageId);
          throw McpError.fromError(ErrorCode.RequestTimeout, "Maximum total timeout exceeded", {
            maxTotalTimeout: info2.maxTotalTimeout,
            totalElapsed
          });
        }
        clearTimeout(info2.timeoutId);
        info2.timeoutId = setTimeout(info2.onTimeout, info2.timeout);
        return true;
      }
      _cleanupTimeout(messageId) {
        const info2 = this._timeoutInfo.get(messageId);
        if (info2) {
          clearTimeout(info2.timeoutId);
          this._timeoutInfo.delete(messageId);
        }
      }
      /**
       * Attaches to the given transport, starts it, and starts listening for messages.
       *
       * The Protocol object assumes ownership of the Transport, replacing any callbacks that have already been set, and expects that it is the only user of the Transport instance going forward.
       */
      async connect(transport) {
        if (this._transport) {
          throw new Error("Already connected to a transport. Call close() before connecting to a new transport, or use a separate Protocol instance per connection.");
        }
        this._transport = transport;
        const _onclose = this.transport?.onclose;
        this._transport.onclose = () => {
          _onclose?.();
          this._onclose();
        };
        const _onerror = this.transport?.onerror;
        this._transport.onerror = (error2) => {
          _onerror?.(error2);
          this._onerror(error2);
        };
        const _onmessage = this._transport?.onmessage;
        this._transport.onmessage = (message, extra) => {
          _onmessage?.(message, extra);
          if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
            this._onresponse(message);
          } else if (isJSONRPCRequest(message)) {
            this._onrequest(message, extra);
          } else if (isJSONRPCNotification(message)) {
            this._onnotification(message);
          } else {
            this._onerror(new Error(`Unknown message type: ${JSON.stringify(message)}`));
          }
        };
        await this._transport.start();
      }
      _onclose() {
        const responseHandlers = this._responseHandlers;
        this._responseHandlers = /* @__PURE__ */ new Map();
        this._progressHandlers.clear();
        this._taskProgressTokens.clear();
        this._pendingDebouncedNotifications.clear();
        for (const info2 of this._timeoutInfo.values()) {
          clearTimeout(info2.timeoutId);
        }
        this._timeoutInfo.clear();
        for (const controller of this._requestHandlerAbortControllers.values()) {
          controller.abort();
        }
        this._requestHandlerAbortControllers.clear();
        const error2 = McpError.fromError(ErrorCode.ConnectionClosed, "Connection closed");
        this._transport = void 0;
        this.onclose?.();
        for (const handler of responseHandlers.values()) {
          handler(error2);
        }
      }
      _onerror(error2) {
        this.onerror?.(error2);
      }
      _onnotification(notification) {
        const handler = this._notificationHandlers.get(notification.method) ?? this.fallbackNotificationHandler;
        if (handler === void 0) {
          return;
        }
        Promise.resolve().then(() => handler(notification)).catch((error2) => this._onerror(new Error(`Uncaught error in notification handler: ${error2}`)));
      }
      _onrequest(request2, extra) {
        const handler = this._requestHandlers.get(request2.method) ?? this.fallbackRequestHandler;
        const capturedTransport = this._transport;
        const relatedTaskId = request2.params?._meta?.[RELATED_TASK_META_KEY]?.taskId;
        if (handler === void 0) {
          const errorResponse = {
            jsonrpc: "2.0",
            id: request2.id,
            error: {
              code: ErrorCode.MethodNotFound,
              message: "Method not found"
            }
          };
          if (relatedTaskId && this._taskMessageQueue) {
            this._enqueueTaskMessage(relatedTaskId, {
              type: "error",
              message: errorResponse,
              timestamp: Date.now()
            }, capturedTransport?.sessionId).catch((error2) => this._onerror(new Error(`Failed to enqueue error response: ${error2}`)));
          } else {
            capturedTransport?.send(errorResponse).catch((error2) => this._onerror(new Error(`Failed to send an error response: ${error2}`)));
          }
          return;
        }
        const abortController = new AbortController();
        this._requestHandlerAbortControllers.set(request2.id, abortController);
        const taskCreationParams = isTaskAugmentedRequestParams(request2.params) ? request2.params.task : void 0;
        const taskStore = this._taskStore ? this.requestTaskStore(request2, capturedTransport?.sessionId) : void 0;
        const fullExtra = {
          signal: abortController.signal,
          sessionId: capturedTransport?.sessionId,
          _meta: request2.params?._meta,
          sendNotification: async (notification) => {
            if (abortController.signal.aborted)
              return;
            const notificationOptions = { relatedRequestId: request2.id };
            if (relatedTaskId) {
              notificationOptions.relatedTask = { taskId: relatedTaskId };
            }
            await this.notification(notification, notificationOptions);
          },
          sendRequest: async (r, resultSchema, options) => {
            if (abortController.signal.aborted) {
              throw new McpError(ErrorCode.ConnectionClosed, "Request was cancelled");
            }
            const requestOptions = { ...options, relatedRequestId: request2.id };
            if (relatedTaskId && !requestOptions.relatedTask) {
              requestOptions.relatedTask = { taskId: relatedTaskId };
            }
            const effectiveTaskId = requestOptions.relatedTask?.taskId ?? relatedTaskId;
            if (effectiveTaskId && taskStore) {
              await taskStore.updateTaskStatus(effectiveTaskId, "input_required");
            }
            return await this.request(r, resultSchema, requestOptions);
          },
          authInfo: extra?.authInfo,
          requestId: request2.id,
          requestInfo: extra?.requestInfo,
          taskId: relatedTaskId,
          taskStore,
          taskRequestedTtl: taskCreationParams?.ttl,
          closeSSEStream: extra?.closeSSEStream,
          closeStandaloneSSEStream: extra?.closeStandaloneSSEStream
        };
        Promise.resolve().then(() => {
          if (taskCreationParams) {
            this.assertTaskHandlerCapability(request2.method);
          }
        }).then(() => handler(request2, fullExtra)).then(async (result) => {
          if (abortController.signal.aborted) {
            return;
          }
          const response = {
            result,
            jsonrpc: "2.0",
            id: request2.id
          };
          if (relatedTaskId && this._taskMessageQueue) {
            await this._enqueueTaskMessage(relatedTaskId, {
              type: "response",
              message: response,
              timestamp: Date.now()
            }, capturedTransport?.sessionId);
          } else {
            await capturedTransport?.send(response);
          }
        }, async (error2) => {
          if (abortController.signal.aborted) {
            return;
          }
          const errorResponse = {
            jsonrpc: "2.0",
            id: request2.id,
            error: {
              code: Number.isSafeInteger(error2["code"]) ? error2["code"] : ErrorCode.InternalError,
              message: error2.message ?? "Internal error",
              ...error2["data"] !== void 0 && { data: error2["data"] }
            }
          };
          if (relatedTaskId && this._taskMessageQueue) {
            await this._enqueueTaskMessage(relatedTaskId, {
              type: "error",
              message: errorResponse,
              timestamp: Date.now()
            }, capturedTransport?.sessionId);
          } else {
            await capturedTransport?.send(errorResponse);
          }
        }).catch((error2) => this._onerror(new Error(`Failed to send response: ${error2}`))).finally(() => {
          if (this._requestHandlerAbortControllers.get(request2.id) === abortController) {
            this._requestHandlerAbortControllers.delete(request2.id);
          }
        });
      }
      _onprogress(notification) {
        const { progressToken, ...params } = notification.params;
        const messageId = Number(progressToken);
        const handler = this._progressHandlers.get(messageId);
        if (!handler) {
          this._onerror(new Error(`Received a progress notification for an unknown token: ${JSON.stringify(notification)}`));
          return;
        }
        const responseHandler = this._responseHandlers.get(messageId);
        const timeoutInfo = this._timeoutInfo.get(messageId);
        if (timeoutInfo && responseHandler && timeoutInfo.resetTimeoutOnProgress) {
          try {
            this._resetTimeout(messageId);
          } catch (error2) {
            this._responseHandlers.delete(messageId);
            this._progressHandlers.delete(messageId);
            this._cleanupTimeout(messageId);
            responseHandler(error2);
            return;
          }
        }
        handler(params);
      }
      _onresponse(response) {
        const messageId = Number(response.id);
        const resolver = this._requestResolvers.get(messageId);
        if (resolver) {
          this._requestResolvers.delete(messageId);
          if (isJSONRPCResultResponse(response)) {
            resolver(response);
          } else {
            const error2 = new McpError(response.error.code, response.error.message, response.error.data);
            resolver(error2);
          }
          return;
        }
        const handler = this._responseHandlers.get(messageId);
        if (handler === void 0) {
          this._onerror(new Error(`Received a response for an unknown message ID: ${JSON.stringify(response)}`));
          return;
        }
        this._responseHandlers.delete(messageId);
        this._cleanupTimeout(messageId);
        let isTaskResponse = false;
        if (isJSONRPCResultResponse(response) && response.result && typeof response.result === "object") {
          const result = response.result;
          if (result.task && typeof result.task === "object") {
            const task = result.task;
            if (typeof task.taskId === "string") {
              isTaskResponse = true;
              this._taskProgressTokens.set(task.taskId, messageId);
            }
          }
        }
        if (!isTaskResponse) {
          this._progressHandlers.delete(messageId);
        }
        if (isJSONRPCResultResponse(response)) {
          handler(response);
        } else {
          const error2 = McpError.fromError(response.error.code, response.error.message, response.error.data);
          handler(error2);
        }
      }
      get transport() {
        return this._transport;
      }
      /**
       * Closes the connection.
       */
      async close() {
        await this._transport?.close();
      }
      /**
       * Sends a request and returns an AsyncGenerator that yields response messages.
       * The generator is guaranteed to end with either a 'result' or 'error' message.
       *
       * @example
       * ```typescript
       * const stream = protocol.requestStream(request, resultSchema, options);
       * for await (const message of stream) {
       *   switch (message.type) {
       *     case 'taskCreated':
       *       console.log('Task created:', message.task.taskId);
       *       break;
       *     case 'taskStatus':
       *       console.log('Task status:', message.task.status);
       *       break;
       *     case 'result':
       *       console.log('Final result:', message.result);
       *       break;
       *     case 'error':
       *       console.error('Error:', message.error);
       *       break;
       *   }
       * }
       * ```
       *
       * @experimental Use `client.experimental.tasks.requestStream()` to access this method.
       */
      async *requestStream(request2, resultSchema, options) {
        const { task } = options ?? {};
        if (!task) {
          try {
            const result = await this.request(request2, resultSchema, options);
            yield { type: "result", result };
          } catch (error2) {
            yield {
              type: "error",
              error: error2 instanceof McpError ? error2 : new McpError(ErrorCode.InternalError, String(error2))
            };
          }
          return;
        }
        let taskId;
        try {
          const createResult = await this.request(request2, CreateTaskResultSchema, options);
          if (createResult.task) {
            taskId = createResult.task.taskId;
            yield { type: "taskCreated", task: createResult.task };
          } else {
            throw new McpError(ErrorCode.InternalError, "Task creation did not return a task");
          }
          while (true) {
            const task2 = await this.getTask({ taskId }, options);
            yield { type: "taskStatus", task: task2 };
            if (isTerminal(task2.status)) {
              if (task2.status === "completed") {
                const result = await this.getTaskResult({ taskId }, resultSchema, options);
                yield { type: "result", result };
              } else if (task2.status === "failed") {
                yield {
                  type: "error",
                  error: new McpError(ErrorCode.InternalError, `Task ${taskId} failed`)
                };
              } else if (task2.status === "cancelled") {
                yield {
                  type: "error",
                  error: new McpError(ErrorCode.InternalError, `Task ${taskId} was cancelled`)
                };
              }
              return;
            }
            if (task2.status === "input_required") {
              const result = await this.getTaskResult({ taskId }, resultSchema, options);
              yield { type: "result", result };
              return;
            }
            const pollInterval = task2.pollInterval ?? this._options?.defaultTaskPollInterval ?? 1e3;
            await new Promise((resolve9) => setTimeout(resolve9, pollInterval));
            options?.signal?.throwIfAborted();
          }
        } catch (error2) {
          yield {
            type: "error",
            error: error2 instanceof McpError ? error2 : new McpError(ErrorCode.InternalError, String(error2))
          };
        }
      }
      /**
       * Sends a request and waits for a response.
       *
       * Do not use this method to emit notifications! Use notification() instead.
       */
      request(request2, resultSchema, options) {
        const { relatedRequestId, resumptionToken, onresumptiontoken, task, relatedTask } = options ?? {};
        return new Promise((resolve9, reject) => {
          const earlyReject = (error2) => {
            reject(error2);
          };
          if (!this._transport) {
            earlyReject(new Error("Not connected"));
            return;
          }
          if (this._options?.enforceStrictCapabilities === true) {
            try {
              this.assertCapabilityForMethod(request2.method);
              if (task) {
                this.assertTaskCapability(request2.method);
              }
            } catch (e) {
              earlyReject(e);
              return;
            }
          }
          options?.signal?.throwIfAborted();
          const messageId = this._requestMessageId++;
          const jsonrpcRequest = {
            ...request2,
            jsonrpc: "2.0",
            id: messageId
          };
          if (options?.onprogress) {
            this._progressHandlers.set(messageId, options.onprogress);
            jsonrpcRequest.params = {
              ...request2.params,
              _meta: {
                ...request2.params?._meta || {},
                progressToken: messageId
              }
            };
          }
          if (task) {
            jsonrpcRequest.params = {
              ...jsonrpcRequest.params,
              task
            };
          }
          if (relatedTask) {
            jsonrpcRequest.params = {
              ...jsonrpcRequest.params,
              _meta: {
                ...jsonrpcRequest.params?._meta || {},
                [RELATED_TASK_META_KEY]: relatedTask
              }
            };
          }
          const cancel = (reason) => {
            this._responseHandlers.delete(messageId);
            this._progressHandlers.delete(messageId);
            this._cleanupTimeout(messageId);
            this._transport?.send({
              jsonrpc: "2.0",
              method: "notifications/cancelled",
              params: {
                requestId: messageId,
                reason: String(reason)
              }
            }, { relatedRequestId, resumptionToken, onresumptiontoken }).catch((error3) => this._onerror(new Error(`Failed to send cancellation: ${error3}`)));
            const error2 = reason instanceof McpError ? reason : new McpError(ErrorCode.RequestTimeout, String(reason));
            reject(error2);
          };
          this._responseHandlers.set(messageId, (response) => {
            if (options?.signal?.aborted) {
              return;
            }
            if (response instanceof Error) {
              return reject(response);
            }
            try {
              const parseResult = safeParse3(resultSchema, response.result);
              if (!parseResult.success) {
                reject(parseResult.error);
              } else {
                resolve9(parseResult.data);
              }
            } catch (error2) {
              reject(error2);
            }
          });
          options?.signal?.addEventListener("abort", () => {
            cancel(options?.signal?.reason);
          });
          const timeout = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC;
          const timeoutHandler = () => cancel(McpError.fromError(ErrorCode.RequestTimeout, "Request timed out", { timeout }));
          this._setupTimeout(messageId, timeout, options?.maxTotalTimeout, timeoutHandler, options?.resetTimeoutOnProgress ?? false);
          const relatedTaskId = relatedTask?.taskId;
          if (relatedTaskId) {
            const responseResolver = (response) => {
              const handler = this._responseHandlers.get(messageId);
              if (handler) {
                handler(response);
              } else {
                this._onerror(new Error(`Response handler missing for side-channeled request ${messageId}`));
              }
            };
            this._requestResolvers.set(messageId, responseResolver);
            this._enqueueTaskMessage(relatedTaskId, {
              type: "request",
              message: jsonrpcRequest,
              timestamp: Date.now()
            }).catch((error2) => {
              this._cleanupTimeout(messageId);
              reject(error2);
            });
          } else {
            this._transport.send(jsonrpcRequest, { relatedRequestId, resumptionToken, onresumptiontoken }).catch((error2) => {
              this._cleanupTimeout(messageId);
              reject(error2);
            });
          }
        });
      }
      /**
       * Gets the current status of a task.
       *
       * @experimental Use `client.experimental.tasks.getTask()` to access this method.
       */
      async getTask(params, options) {
        return this.request({ method: "tasks/get", params }, GetTaskResultSchema, options);
      }
      /**
       * Retrieves the result of a completed task.
       *
       * @experimental Use `client.experimental.tasks.getTaskResult()` to access this method.
       */
      async getTaskResult(params, resultSchema, options) {
        return this.request({ method: "tasks/result", params }, resultSchema, options);
      }
      /**
       * Lists tasks, optionally starting from a pagination cursor.
       *
       * @experimental Use `client.experimental.tasks.listTasks()` to access this method.
       */
      async listTasks(params, options) {
        return this.request({ method: "tasks/list", params }, ListTasksResultSchema, options);
      }
      /**
       * Cancels a specific task.
       *
       * @experimental Use `client.experimental.tasks.cancelTask()` to access this method.
       */
      async cancelTask(params, options) {
        return this.request({ method: "tasks/cancel", params }, CancelTaskResultSchema, options);
      }
      /**
       * Emits a notification, which is a one-way message that does not expect a response.
       */
      async notification(notification, options) {
        if (!this._transport) {
          throw new Error("Not connected");
        }
        this.assertNotificationCapability(notification.method);
        const relatedTaskId = options?.relatedTask?.taskId;
        if (relatedTaskId) {
          const jsonrpcNotification2 = {
            ...notification,
            jsonrpc: "2.0",
            params: {
              ...notification.params,
              _meta: {
                ...notification.params?._meta || {},
                [RELATED_TASK_META_KEY]: options.relatedTask
              }
            }
          };
          await this._enqueueTaskMessage(relatedTaskId, {
            type: "notification",
            message: jsonrpcNotification2,
            timestamp: Date.now()
          });
          return;
        }
        const debouncedMethods = this._options?.debouncedNotificationMethods ?? [];
        const canDebounce = debouncedMethods.includes(notification.method) && !notification.params && !options?.relatedRequestId && !options?.relatedTask;
        if (canDebounce) {
          if (this._pendingDebouncedNotifications.has(notification.method)) {
            return;
          }
          this._pendingDebouncedNotifications.add(notification.method);
          Promise.resolve().then(() => {
            this._pendingDebouncedNotifications.delete(notification.method);
            if (!this._transport) {
              return;
            }
            let jsonrpcNotification2 = {
              ...notification,
              jsonrpc: "2.0"
            };
            if (options?.relatedTask) {
              jsonrpcNotification2 = {
                ...jsonrpcNotification2,
                params: {
                  ...jsonrpcNotification2.params,
                  _meta: {
                    ...jsonrpcNotification2.params?._meta || {},
                    [RELATED_TASK_META_KEY]: options.relatedTask
                  }
                }
              };
            }
            this._transport?.send(jsonrpcNotification2, options).catch((error2) => this._onerror(error2));
          });
          return;
        }
        let jsonrpcNotification = {
          ...notification,
          jsonrpc: "2.0"
        };
        if (options?.relatedTask) {
          jsonrpcNotification = {
            ...jsonrpcNotification,
            params: {
              ...jsonrpcNotification.params,
              _meta: {
                ...jsonrpcNotification.params?._meta || {},
                [RELATED_TASK_META_KEY]: options.relatedTask
              }
            }
          };
        }
        await this._transport.send(jsonrpcNotification, options);
      }
      /**
       * Registers a handler to invoke when this protocol object receives a request with the given method.
       *
       * Note that this will replace any previous request handler for the same method.
       */
      setRequestHandler(requestSchema, handler) {
        const method = getMethodLiteral(requestSchema);
        this.assertRequestHandlerCapability(method);
        this._requestHandlers.set(method, (request2, extra) => {
          const parsed = parseWithCompat(requestSchema, request2);
          return Promise.resolve(handler(parsed, extra));
        });
      }
      /**
       * Removes the request handler for the given method.
       */
      removeRequestHandler(method) {
        this._requestHandlers.delete(method);
      }
      /**
       * Asserts that a request handler has not already been set for the given method, in preparation for a new one being automatically installed.
       */
      assertCanSetRequestHandler(method) {
        if (this._requestHandlers.has(method)) {
          throw new Error(`A request handler for ${method} already exists, which would be overridden`);
        }
      }
      /**
       * Registers a handler to invoke when this protocol object receives a notification with the given method.
       *
       * Note that this will replace any previous notification handler for the same method.
       */
      setNotificationHandler(notificationSchema, handler) {
        const method = getMethodLiteral(notificationSchema);
        this._notificationHandlers.set(method, (notification) => {
          const parsed = parseWithCompat(notificationSchema, notification);
          return Promise.resolve(handler(parsed));
        });
      }
      /**
       * Removes the notification handler for the given method.
       */
      removeNotificationHandler(method) {
        this._notificationHandlers.delete(method);
      }
      /**
       * Cleans up the progress handler associated with a task.
       * This should be called when a task reaches a terminal status.
       */
      _cleanupTaskProgressHandler(taskId) {
        const progressToken = this._taskProgressTokens.get(taskId);
        if (progressToken !== void 0) {
          this._progressHandlers.delete(progressToken);
          this._taskProgressTokens.delete(taskId);
        }
      }
      /**
       * Enqueues a task-related message for side-channel delivery via tasks/result.
       * @param taskId The task ID to associate the message with
       * @param message The message to enqueue
       * @param sessionId Optional session ID for binding the operation to a specific session
       * @throws Error if taskStore is not configured or if enqueue fails (e.g., queue overflow)
       *
       * Note: If enqueue fails, it's the TaskMessageQueue implementation's responsibility to handle
       * the error appropriately (e.g., by failing the task, logging, etc.). The Protocol layer
       * simply propagates the error.
       */
      async _enqueueTaskMessage(taskId, message, sessionId) {
        if (!this._taskStore || !this._taskMessageQueue) {
          throw new Error("Cannot enqueue task message: taskStore and taskMessageQueue are not configured");
        }
        const maxQueueSize = this._options?.maxTaskQueueSize;
        await this._taskMessageQueue.enqueue(taskId, message, sessionId, maxQueueSize);
      }
      /**
       * Clears the message queue for a task and rejects any pending request resolvers.
       * @param taskId The task ID whose queue should be cleared
       * @param sessionId Optional session ID for binding the operation to a specific session
       */
      async _clearTaskQueue(taskId, sessionId) {
        if (this._taskMessageQueue) {
          const messages = await this._taskMessageQueue.dequeueAll(taskId, sessionId);
          for (const message of messages) {
            if (message.type === "request" && isJSONRPCRequest(message.message)) {
              const requestId = message.message.id;
              const resolver = this._requestResolvers.get(requestId);
              if (resolver) {
                resolver(new McpError(ErrorCode.InternalError, "Task cancelled or completed"));
                this._requestResolvers.delete(requestId);
              } else {
                this._onerror(new Error(`Resolver missing for request ${requestId} during task ${taskId} cleanup`));
              }
            }
          }
        }
      }
      /**
       * Waits for a task update (new messages or status change) with abort signal support.
       * Uses polling to check for updates at the task's configured poll interval.
       * @param taskId The task ID to wait for
       * @param signal Abort signal to cancel the wait
       * @returns Promise that resolves when an update occurs or rejects if aborted
       */
      async _waitForTaskUpdate(taskId, signal) {
        let interval = this._options?.defaultTaskPollInterval ?? 1e3;
        try {
          const task = await this._taskStore?.getTask(taskId);
          if (task?.pollInterval) {
            interval = task.pollInterval;
          }
        } catch {
        }
        return new Promise((resolve9, reject) => {
          if (signal.aborted) {
            reject(new McpError(ErrorCode.InvalidRequest, "Request cancelled"));
            return;
          }
          const timeoutId = setTimeout(resolve9, interval);
          signal.addEventListener("abort", () => {
            clearTimeout(timeoutId);
            reject(new McpError(ErrorCode.InvalidRequest, "Request cancelled"));
          }, { once: true });
        });
      }
      requestTaskStore(request2, sessionId) {
        const taskStore = this._taskStore;
        if (!taskStore) {
          throw new Error("No task store configured");
        }
        return {
          createTask: async (taskParams) => {
            if (!request2) {
              throw new Error("No request provided");
            }
            return await taskStore.createTask(taskParams, request2.id, {
              method: request2.method,
              params: request2.params
            }, sessionId);
          },
          getTask: async (taskId) => {
            const task = await taskStore.getTask(taskId, sessionId);
            if (!task) {
              throw new McpError(ErrorCode.InvalidParams, "Failed to retrieve task: Task not found");
            }
            return task;
          },
          storeTaskResult: async (taskId, status, result) => {
            await taskStore.storeTaskResult(taskId, status, result, sessionId);
            const task = await taskStore.getTask(taskId, sessionId);
            if (task) {
              const notification = TaskStatusNotificationSchema.parse({
                method: "notifications/tasks/status",
                params: task
              });
              await this.notification(notification);
              if (isTerminal(task.status)) {
                this._cleanupTaskProgressHandler(taskId);
              }
            }
          },
          getTaskResult: (taskId) => {
            return taskStore.getTaskResult(taskId, sessionId);
          },
          updateTaskStatus: async (taskId, status, statusMessage) => {
            const task = await taskStore.getTask(taskId, sessionId);
            if (!task) {
              throw new McpError(ErrorCode.InvalidParams, `Task "${taskId}" not found - it may have been cleaned up`);
            }
            if (isTerminal(task.status)) {
              throw new McpError(ErrorCode.InvalidParams, `Cannot update task "${taskId}" from terminal status "${task.status}" to "${status}". Terminal states (completed, failed, cancelled) cannot transition to other states.`);
            }
            await taskStore.updateTaskStatus(taskId, status, statusMessage, sessionId);
            const updatedTask = await taskStore.getTask(taskId, sessionId);
            if (updatedTask) {
              const notification = TaskStatusNotificationSchema.parse({
                method: "notifications/tasks/status",
                params: updatedTask
              });
              await this.notification(notification);
              if (isTerminal(updatedTask.status)) {
                this._cleanupTaskProgressHandler(taskId);
              }
            }
          },
          listTasks: (cursor) => {
            return taskStore.listTasks(cursor, sessionId);
          }
        };
      }
    };
  }
});

// node_modules/ajv/dist/compile/codegen/code.js
var require_code = __commonJS({
  "node_modules/ajv/dist/compile/codegen/code.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.regexpCode = exports.getEsmExportName = exports.getProperty = exports.safeStringify = exports.stringify = exports.strConcat = exports.addCodeArg = exports.str = exports._ = exports.nil = exports._Code = exports.Name = exports.IDENTIFIER = exports._CodeOrName = void 0;
    var _CodeOrName = class {
    };
    exports._CodeOrName = _CodeOrName;
    exports.IDENTIFIER = /^[a-z$_][a-z$_0-9]*$/i;
    var Name = class extends _CodeOrName {
      constructor(s) {
        super();
        if (!exports.IDENTIFIER.test(s))
          throw new Error("CodeGen: name must be a valid identifier");
        this.str = s;
      }
      toString() {
        return this.str;
      }
      emptyStr() {
        return false;
      }
      get names() {
        return { [this.str]: 1 };
      }
    };
    exports.Name = Name;
    var _Code = class extends _CodeOrName {
      constructor(code) {
        super();
        this._items = typeof code === "string" ? [code] : code;
      }
      toString() {
        return this.str;
      }
      emptyStr() {
        if (this._items.length > 1)
          return false;
        const item = this._items[0];
        return item === "" || item === '""';
      }
      get str() {
        var _a3;
        return (_a3 = this._str) !== null && _a3 !== void 0 ? _a3 : this._str = this._items.reduce((s, c) => `${s}${c}`, "");
      }
      get names() {
        var _a3;
        return (_a3 = this._names) !== null && _a3 !== void 0 ? _a3 : this._names = this._items.reduce((names, c) => {
          if (c instanceof Name)
            names[c.str] = (names[c.str] || 0) + 1;
          return names;
        }, {});
      }
    };
    exports._Code = _Code;
    exports.nil = new _Code("");
    function _(strs, ...args) {
      const code = [strs[0]];
      let i = 0;
      while (i < args.length) {
        addCodeArg(code, args[i]);
        code.push(strs[++i]);
      }
      return new _Code(code);
    }
    exports._ = _;
    var plus = new _Code("+");
    function str3(strs, ...args) {
      const expr = [safeStringify(strs[0])];
      let i = 0;
      while (i < args.length) {
        expr.push(plus);
        addCodeArg(expr, args[i]);
        expr.push(plus, safeStringify(strs[++i]));
      }
      optimize(expr);
      return new _Code(expr);
    }
    exports.str = str3;
    function addCodeArg(code, arg) {
      if (arg instanceof _Code)
        code.push(...arg._items);
      else if (arg instanceof Name)
        code.push(arg);
      else
        code.push(interpolate(arg));
    }
    exports.addCodeArg = addCodeArg;
    function optimize(expr) {
      let i = 1;
      while (i < expr.length - 1) {
        if (expr[i] === plus) {
          const res = mergeExprItems(expr[i - 1], expr[i + 1]);
          if (res !== void 0) {
            expr.splice(i - 1, 3, res);
            continue;
          }
          expr[i++] = "+";
        }
        i++;
      }
    }
    function mergeExprItems(a, b) {
      if (b === '""')
        return a;
      if (a === '""')
        return b;
      if (typeof a == "string") {
        if (b instanceof Name || a[a.length - 1] !== '"')
          return;
        if (typeof b != "string")
          return `${a.slice(0, -1)}${b}"`;
        if (b[0] === '"')
          return a.slice(0, -1) + b.slice(1);
        return;
      }
      if (typeof b == "string" && b[0] === '"' && !(a instanceof Name))
        return `"${a}${b.slice(1)}`;
      return;
    }
    function strConcat(c1, c2) {
      return c2.emptyStr() ? c1 : c1.emptyStr() ? c2 : str3`${c1}${c2}`;
    }
    exports.strConcat = strConcat;
    function interpolate(x) {
      return typeof x == "number" || typeof x == "boolean" || x === null ? x : safeStringify(Array.isArray(x) ? x.join(",") : x);
    }
    function stringify(x) {
      return new _Code(safeStringify(x));
    }
    exports.stringify = stringify;
    function safeStringify(x) {
      return JSON.stringify(x).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    }
    exports.safeStringify = safeStringify;
    function getProperty(key) {
      return typeof key == "string" && exports.IDENTIFIER.test(key) ? new _Code(`.${key}`) : _`[${key}]`;
    }
    exports.getProperty = getProperty;
    function getEsmExportName(key) {
      if (typeof key == "string" && exports.IDENTIFIER.test(key)) {
        return new _Code(`${key}`);
      }
      throw new Error(`CodeGen: invalid export name: ${key}, use explicit $id name mapping`);
    }
    exports.getEsmExportName = getEsmExportName;
    function regexpCode(rx) {
      return new _Code(rx.toString());
    }
    exports.regexpCode = regexpCode;
  }
});

// node_modules/ajv/dist/compile/codegen/scope.js
var require_scope = __commonJS({
  "node_modules/ajv/dist/compile/codegen/scope.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ValueScope = exports.ValueScopeName = exports.Scope = exports.varKinds = exports.UsedValueState = void 0;
    var code_1 = require_code();
    var ValueError = class extends Error {
      constructor(name) {
        super(`CodeGen: "code" for ${name} not defined`);
        this.value = name.value;
      }
    };
    var UsedValueState;
    (function(UsedValueState2) {
      UsedValueState2[UsedValueState2["Started"] = 0] = "Started";
      UsedValueState2[UsedValueState2["Completed"] = 1] = "Completed";
    })(UsedValueState || (exports.UsedValueState = UsedValueState = {}));
    exports.varKinds = {
      const: new code_1.Name("const"),
      let: new code_1.Name("let"),
      var: new code_1.Name("var")
    };
    var Scope = class {
      constructor({ prefixes, parent } = {}) {
        this._names = {};
        this._prefixes = prefixes;
        this._parent = parent;
      }
      toName(nameOrPrefix) {
        return nameOrPrefix instanceof code_1.Name ? nameOrPrefix : this.name(nameOrPrefix);
      }
      name(prefix) {
        return new code_1.Name(this._newName(prefix));
      }
      _newName(prefix) {
        const ng = this._names[prefix] || this._nameGroup(prefix);
        return `${prefix}${ng.index++}`;
      }
      _nameGroup(prefix) {
        var _a3, _b;
        if (((_b = (_a3 = this._parent) === null || _a3 === void 0 ? void 0 : _a3._prefixes) === null || _b === void 0 ? void 0 : _b.has(prefix)) || this._prefixes && !this._prefixes.has(prefix)) {
          throw new Error(`CodeGen: prefix "${prefix}" is not allowed in this scope`);
        }
        return this._names[prefix] = { prefix, index: 0 };
      }
    };
    exports.Scope = Scope;
    var ValueScopeName = class extends code_1.Name {
      constructor(prefix, nameStr) {
        super(nameStr);
        this.prefix = prefix;
      }
      setValue(value, { property, itemIndex }) {
        this.value = value;
        this.scopePath = (0, code_1._)`.${new code_1.Name(property)}[${itemIndex}]`;
      }
    };
    exports.ValueScopeName = ValueScopeName;
    var line = (0, code_1._)`\n`;
    var ValueScope = class extends Scope {
      constructor(opts) {
        super(opts);
        this._values = {};
        this._scope = opts.scope;
        this.opts = { ...opts, _n: opts.lines ? line : code_1.nil };
      }
      get() {
        return this._scope;
      }
      name(prefix) {
        return new ValueScopeName(prefix, this._newName(prefix));
      }
      value(nameOrPrefix, value) {
        var _a3;
        if (value.ref === void 0)
          throw new Error("CodeGen: ref must be passed in value");
        const name = this.toName(nameOrPrefix);
        const { prefix } = name;
        const valueKey = (_a3 = value.key) !== null && _a3 !== void 0 ? _a3 : value.ref;
        let vs = this._values[prefix];
        if (vs) {
          const _name = vs.get(valueKey);
          if (_name)
            return _name;
        } else {
          vs = this._values[prefix] = /* @__PURE__ */ new Map();
        }
        vs.set(valueKey, name);
        const s = this._scope[prefix] || (this._scope[prefix] = []);
        const itemIndex = s.length;
        s[itemIndex] = value.ref;
        name.setValue(value, { property: prefix, itemIndex });
        return name;
      }
      getValue(prefix, keyOrRef) {
        const vs = this._values[prefix];
        if (!vs)
          return;
        return vs.get(keyOrRef);
      }
      scopeRefs(scopeName, values = this._values) {
        return this._reduceValues(values, (name) => {
          if (name.scopePath === void 0)
            throw new Error(`CodeGen: name "${name}" has no value`);
          return (0, code_1._)`${scopeName}${name.scopePath}`;
        });
      }
      scopeCode(values = this._values, usedValues, getCode) {
        return this._reduceValues(values, (name) => {
          if (name.value === void 0)
            throw new Error(`CodeGen: name "${name}" has no value`);
          return name.value.code;
        }, usedValues, getCode);
      }
      _reduceValues(values, valueCode, usedValues = {}, getCode) {
        let code = code_1.nil;
        for (const prefix in values) {
          const vs = values[prefix];
          if (!vs)
            continue;
          const nameSet = usedValues[prefix] = usedValues[prefix] || /* @__PURE__ */ new Map();
          vs.forEach((name) => {
            if (nameSet.has(name))
              return;
            nameSet.set(name, UsedValueState.Started);
            let c = valueCode(name);
            if (c) {
              const def3 = this.opts.es5 ? exports.varKinds.var : exports.varKinds.const;
              code = (0, code_1._)`${code}${def3} ${name} = ${c};${this.opts._n}`;
            } else if (c = getCode === null || getCode === void 0 ? void 0 : getCode(name)) {
              code = (0, code_1._)`${code}${c}${this.opts._n}`;
            } else {
              throw new ValueError(name);
            }
            nameSet.set(name, UsedValueState.Completed);
          });
        }
        return code;
      }
    };
    exports.ValueScope = ValueScope;
  }
});

// node_modules/ajv/dist/compile/codegen/index.js
var require_codegen = __commonJS({
  "node_modules/ajv/dist/compile/codegen/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.or = exports.and = exports.not = exports.CodeGen = exports.operators = exports.varKinds = exports.ValueScopeName = exports.ValueScope = exports.Scope = exports.Name = exports.regexpCode = exports.stringify = exports.getProperty = exports.nil = exports.strConcat = exports.str = exports._ = void 0;
    var code_1 = require_code();
    var scope_1 = require_scope();
    var code_2 = require_code();
    Object.defineProperty(exports, "_", { enumerable: true, get: function() {
      return code_2._;
    } });
    Object.defineProperty(exports, "str", { enumerable: true, get: function() {
      return code_2.str;
    } });
    Object.defineProperty(exports, "strConcat", { enumerable: true, get: function() {
      return code_2.strConcat;
    } });
    Object.defineProperty(exports, "nil", { enumerable: true, get: function() {
      return code_2.nil;
    } });
    Object.defineProperty(exports, "getProperty", { enumerable: true, get: function() {
      return code_2.getProperty;
    } });
    Object.defineProperty(exports, "stringify", { enumerable: true, get: function() {
      return code_2.stringify;
    } });
    Object.defineProperty(exports, "regexpCode", { enumerable: true, get: function() {
      return code_2.regexpCode;
    } });
    Object.defineProperty(exports, "Name", { enumerable: true, get: function() {
      return code_2.Name;
    } });
    var scope_2 = require_scope();
    Object.defineProperty(exports, "Scope", { enumerable: true, get: function() {
      return scope_2.Scope;
    } });
    Object.defineProperty(exports, "ValueScope", { enumerable: true, get: function() {
      return scope_2.ValueScope;
    } });
    Object.defineProperty(exports, "ValueScopeName", { enumerable: true, get: function() {
      return scope_2.ValueScopeName;
    } });
    Object.defineProperty(exports, "varKinds", { enumerable: true, get: function() {
      return scope_2.varKinds;
    } });
    exports.operators = {
      GT: new code_1._Code(">"),
      GTE: new code_1._Code(">="),
      LT: new code_1._Code("<"),
      LTE: new code_1._Code("<="),
      EQ: new code_1._Code("==="),
      NEQ: new code_1._Code("!=="),
      NOT: new code_1._Code("!"),
      OR: new code_1._Code("||"),
      AND: new code_1._Code("&&"),
      ADD: new code_1._Code("+")
    };
    var Node = class {
      optimizeNodes() {
        return this;
      }
      optimizeNames(_names, _constants) {
        return this;
      }
    };
    var Def = class extends Node {
      constructor(varKind, name, rhs) {
        super();
        this.varKind = varKind;
        this.name = name;
        this.rhs = rhs;
      }
      render({ es5, _n }) {
        const varKind = es5 ? scope_1.varKinds.var : this.varKind;
        const rhs = this.rhs === void 0 ? "" : ` = ${this.rhs}`;
        return `${varKind} ${this.name}${rhs};` + _n;
      }
      optimizeNames(names, constants) {
        if (!names[this.name.str])
          return;
        if (this.rhs)
          this.rhs = optimizeExpr(this.rhs, names, constants);
        return this;
      }
      get names() {
        return this.rhs instanceof code_1._CodeOrName ? this.rhs.names : {};
      }
    };
    var Assign = class extends Node {
      constructor(lhs, rhs, sideEffects) {
        super();
        this.lhs = lhs;
        this.rhs = rhs;
        this.sideEffects = sideEffects;
      }
      render({ _n }) {
        return `${this.lhs} = ${this.rhs};` + _n;
      }
      optimizeNames(names, constants) {
        if (this.lhs instanceof code_1.Name && !names[this.lhs.str] && !this.sideEffects)
          return;
        this.rhs = optimizeExpr(this.rhs, names, constants);
        return this;
      }
      get names() {
        const names = this.lhs instanceof code_1.Name ? {} : { ...this.lhs.names };
        return addExprNames(names, this.rhs);
      }
    };
    var AssignOp = class extends Assign {
      constructor(lhs, op, rhs, sideEffects) {
        super(lhs, rhs, sideEffects);
        this.op = op;
      }
      render({ _n }) {
        return `${this.lhs} ${this.op}= ${this.rhs};` + _n;
      }
    };
    var Label = class extends Node {
      constructor(label) {
        super();
        this.label = label;
        this.names = {};
      }
      render({ _n }) {
        return `${this.label}:` + _n;
      }
    };
    var Break = class extends Node {
      constructor(label) {
        super();
        this.label = label;
        this.names = {};
      }
      render({ _n }) {
        const label = this.label ? ` ${this.label}` : "";
        return `break${label};` + _n;
      }
    };
    var Throw = class extends Node {
      constructor(error2) {
        super();
        this.error = error2;
      }
      render({ _n }) {
        return `throw ${this.error};` + _n;
      }
      get names() {
        return this.error.names;
      }
    };
    var AnyCode = class extends Node {
      constructor(code) {
        super();
        this.code = code;
      }
      render({ _n }) {
        return `${this.code};` + _n;
      }
      optimizeNodes() {
        return `${this.code}` ? this : void 0;
      }
      optimizeNames(names, constants) {
        this.code = optimizeExpr(this.code, names, constants);
        return this;
      }
      get names() {
        return this.code instanceof code_1._CodeOrName ? this.code.names : {};
      }
    };
    var ParentNode = class extends Node {
      constructor(nodes = []) {
        super();
        this.nodes = nodes;
      }
      render(opts) {
        return this.nodes.reduce((code, n) => code + n.render(opts), "");
      }
      optimizeNodes() {
        const { nodes } = this;
        let i = nodes.length;
        while (i--) {
          const n = nodes[i].optimizeNodes();
          if (Array.isArray(n))
            nodes.splice(i, 1, ...n);
          else if (n)
            nodes[i] = n;
          else
            nodes.splice(i, 1);
        }
        return nodes.length > 0 ? this : void 0;
      }
      optimizeNames(names, constants) {
        const { nodes } = this;
        let i = nodes.length;
        while (i--) {
          const n = nodes[i];
          if (n.optimizeNames(names, constants))
            continue;
          subtractNames(names, n.names);
          nodes.splice(i, 1);
        }
        return nodes.length > 0 ? this : void 0;
      }
      get names() {
        return this.nodes.reduce((names, n) => addNames(names, n.names), {});
      }
    };
    var BlockNode = class extends ParentNode {
      render(opts) {
        return "{" + opts._n + super.render(opts) + "}" + opts._n;
      }
    };
    var Root = class extends ParentNode {
    };
    var Else = class extends BlockNode {
    };
    Else.kind = "else";
    var If = class _If extends BlockNode {
      constructor(condition, nodes) {
        super(nodes);
        this.condition = condition;
      }
      render(opts) {
        let code = `if(${this.condition})` + super.render(opts);
        if (this.else)
          code += "else " + this.else.render(opts);
        return code;
      }
      optimizeNodes() {
        super.optimizeNodes();
        const cond = this.condition;
        if (cond === true)
          return this.nodes;
        let e = this.else;
        if (e) {
          const ns = e.optimizeNodes();
          e = this.else = Array.isArray(ns) ? new Else(ns) : ns;
        }
        if (e) {
          if (cond === false)
            return e instanceof _If ? e : e.nodes;
          if (this.nodes.length)
            return this;
          return new _If(not(cond), e instanceof _If ? [e] : e.nodes);
        }
        if (cond === false || !this.nodes.length)
          return void 0;
        return this;
      }
      optimizeNames(names, constants) {
        var _a3;
        this.else = (_a3 = this.else) === null || _a3 === void 0 ? void 0 : _a3.optimizeNames(names, constants);
        if (!(super.optimizeNames(names, constants) || this.else))
          return;
        this.condition = optimizeExpr(this.condition, names, constants);
        return this;
      }
      get names() {
        const names = super.names;
        addExprNames(names, this.condition);
        if (this.else)
          addNames(names, this.else.names);
        return names;
      }
    };
    If.kind = "if";
    var For = class extends BlockNode {
    };
    For.kind = "for";
    var ForLoop = class extends For {
      constructor(iteration) {
        super();
        this.iteration = iteration;
      }
      render(opts) {
        return `for(${this.iteration})` + super.render(opts);
      }
      optimizeNames(names, constants) {
        if (!super.optimizeNames(names, constants))
          return;
        this.iteration = optimizeExpr(this.iteration, names, constants);
        return this;
      }
      get names() {
        return addNames(super.names, this.iteration.names);
      }
    };
    var ForRange = class extends For {
      constructor(varKind, name, from, to) {
        super();
        this.varKind = varKind;
        this.name = name;
        this.from = from;
        this.to = to;
      }
      render(opts) {
        const varKind = opts.es5 ? scope_1.varKinds.var : this.varKind;
        const { name, from, to } = this;
        return `for(${varKind} ${name}=${from}; ${name}<${to}; ${name}++)` + super.render(opts);
      }
      get names() {
        const names = addExprNames(super.names, this.from);
        return addExprNames(names, this.to);
      }
    };
    var ForIter = class extends For {
      constructor(loop, varKind, name, iterable) {
        super();
        this.loop = loop;
        this.varKind = varKind;
        this.name = name;
        this.iterable = iterable;
      }
      render(opts) {
        return `for(${this.varKind} ${this.name} ${this.loop} ${this.iterable})` + super.render(opts);
      }
      optimizeNames(names, constants) {
        if (!super.optimizeNames(names, constants))
          return;
        this.iterable = optimizeExpr(this.iterable, names, constants);
        return this;
      }
      get names() {
        return addNames(super.names, this.iterable.names);
      }
    };
    var Func = class extends BlockNode {
      constructor(name, args, async) {
        super();
        this.name = name;
        this.args = args;
        this.async = async;
      }
      render(opts) {
        const _async = this.async ? "async " : "";
        return `${_async}function ${this.name}(${this.args})` + super.render(opts);
      }
    };
    Func.kind = "func";
    var Return = class extends ParentNode {
      render(opts) {
        return "return " + super.render(opts);
      }
    };
    Return.kind = "return";
    var Try = class extends BlockNode {
      render(opts) {
        let code = "try" + super.render(opts);
        if (this.catch)
          code += this.catch.render(opts);
        if (this.finally)
          code += this.finally.render(opts);
        return code;
      }
      optimizeNodes() {
        var _a3, _b;
        super.optimizeNodes();
        (_a3 = this.catch) === null || _a3 === void 0 ? void 0 : _a3.optimizeNodes();
        (_b = this.finally) === null || _b === void 0 ? void 0 : _b.optimizeNodes();
        return this;
      }
      optimizeNames(names, constants) {
        var _a3, _b;
        super.optimizeNames(names, constants);
        (_a3 = this.catch) === null || _a3 === void 0 ? void 0 : _a3.optimizeNames(names, constants);
        (_b = this.finally) === null || _b === void 0 ? void 0 : _b.optimizeNames(names, constants);
        return this;
      }
      get names() {
        const names = super.names;
        if (this.catch)
          addNames(names, this.catch.names);
        if (this.finally)
          addNames(names, this.finally.names);
        return names;
      }
    };
    var Catch = class extends BlockNode {
      constructor(error2) {
        super();
        this.error = error2;
      }
      render(opts) {
        return `catch(${this.error})` + super.render(opts);
      }
    };
    Catch.kind = "catch";
    var Finally = class extends BlockNode {
      render(opts) {
        return "finally" + super.render(opts);
      }
    };
    Finally.kind = "finally";
    var CodeGen = class {
      constructor(extScope, opts = {}) {
        this._values = {};
        this._blockStarts = [];
        this._constants = {};
        this.opts = { ...opts, _n: opts.lines ? "\n" : "" };
        this._extScope = extScope;
        this._scope = new scope_1.Scope({ parent: extScope });
        this._nodes = [new Root()];
      }
      toString() {
        return this._root.render(this.opts);
      }
      // returns unique name in the internal scope
      name(prefix) {
        return this._scope.name(prefix);
      }
      // reserves unique name in the external scope
      scopeName(prefix) {
        return this._extScope.name(prefix);
      }
      // reserves unique name in the external scope and assigns value to it
      scopeValue(prefixOrName, value) {
        const name = this._extScope.value(prefixOrName, value);
        const vs = this._values[name.prefix] || (this._values[name.prefix] = /* @__PURE__ */ new Set());
        vs.add(name);
        return name;
      }
      getScopeValue(prefix, keyOrRef) {
        return this._extScope.getValue(prefix, keyOrRef);
      }
      // return code that assigns values in the external scope to the names that are used internally
      // (same names that were returned by gen.scopeName or gen.scopeValue)
      scopeRefs(scopeName) {
        return this._extScope.scopeRefs(scopeName, this._values);
      }
      scopeCode() {
        return this._extScope.scopeCode(this._values);
      }
      _def(varKind, nameOrPrefix, rhs, constant) {
        const name = this._scope.toName(nameOrPrefix);
        if (rhs !== void 0 && constant)
          this._constants[name.str] = rhs;
        this._leafNode(new Def(varKind, name, rhs));
        return name;
      }
      // `const` declaration (`var` in es5 mode)
      const(nameOrPrefix, rhs, _constant) {
        return this._def(scope_1.varKinds.const, nameOrPrefix, rhs, _constant);
      }
      // `let` declaration with optional assignment (`var` in es5 mode)
      let(nameOrPrefix, rhs, _constant) {
        return this._def(scope_1.varKinds.let, nameOrPrefix, rhs, _constant);
      }
      // `var` declaration with optional assignment
      var(nameOrPrefix, rhs, _constant) {
        return this._def(scope_1.varKinds.var, nameOrPrefix, rhs, _constant);
      }
      // assignment code
      assign(lhs, rhs, sideEffects) {
        return this._leafNode(new Assign(lhs, rhs, sideEffects));
      }
      // `+=` code
      add(lhs, rhs) {
        return this._leafNode(new AssignOp(lhs, exports.operators.ADD, rhs));
      }
      // appends passed SafeExpr to code or executes Block
      code(c) {
        if (typeof c == "function")
          c();
        else if (c !== code_1.nil)
          this._leafNode(new AnyCode(c));
        return this;
      }
      // returns code for object literal for the passed argument list of key-value pairs
      object(...keyValues) {
        const code = ["{"];
        for (const [key, value] of keyValues) {
          if (code.length > 1)
            code.push(",");
          code.push(key);
          if (key !== value || this.opts.es5) {
            code.push(":");
            (0, code_1.addCodeArg)(code, value);
          }
        }
        code.push("}");
        return new code_1._Code(code);
      }
      // `if` clause (or statement if `thenBody` and, optionally, `elseBody` are passed)
      if(condition, thenBody, elseBody) {
        this._blockNode(new If(condition));
        if (thenBody && elseBody) {
          this.code(thenBody).else().code(elseBody).endIf();
        } else if (thenBody) {
          this.code(thenBody).endIf();
        } else if (elseBody) {
          throw new Error('CodeGen: "else" body without "then" body');
        }
        return this;
      }
      // `else if` clause - invalid without `if` or after `else` clauses
      elseIf(condition) {
        return this._elseNode(new If(condition));
      }
      // `else` clause - only valid after `if` or `else if` clauses
      else() {
        return this._elseNode(new Else());
      }
      // end `if` statement (needed if gen.if was used only with condition)
      endIf() {
        return this._endBlockNode(If, Else);
      }
      _for(node2, forBody) {
        this._blockNode(node2);
        if (forBody)
          this.code(forBody).endFor();
        return this;
      }
      // a generic `for` clause (or statement if `forBody` is passed)
      for(iteration, forBody) {
        return this._for(new ForLoop(iteration), forBody);
      }
      // `for` statement for a range of values
      forRange(nameOrPrefix, from, to, forBody, varKind = this.opts.es5 ? scope_1.varKinds.var : scope_1.varKinds.let) {
        const name = this._scope.toName(nameOrPrefix);
        return this._for(new ForRange(varKind, name, from, to), () => forBody(name));
      }
      // `for-of` statement (in es5 mode replace with a normal for loop)
      forOf(nameOrPrefix, iterable, forBody, varKind = scope_1.varKinds.const) {
        const name = this._scope.toName(nameOrPrefix);
        if (this.opts.es5) {
          const arr = iterable instanceof code_1.Name ? iterable : this.var("_arr", iterable);
          return this.forRange("_i", 0, (0, code_1._)`${arr}.length`, (i) => {
            this.var(name, (0, code_1._)`${arr}[${i}]`);
            forBody(name);
          });
        }
        return this._for(new ForIter("of", varKind, name, iterable), () => forBody(name));
      }
      // `for-in` statement.
      // With option `ownProperties` replaced with a `for-of` loop for object keys
      forIn(nameOrPrefix, obj, forBody, varKind = this.opts.es5 ? scope_1.varKinds.var : scope_1.varKinds.const) {
        if (this.opts.ownProperties) {
          return this.forOf(nameOrPrefix, (0, code_1._)`Object.keys(${obj})`, forBody);
        }
        const name = this._scope.toName(nameOrPrefix);
        return this._for(new ForIter("in", varKind, name, obj), () => forBody(name));
      }
      // end `for` loop
      endFor() {
        return this._endBlockNode(For);
      }
      // `label` statement
      label(label) {
        return this._leafNode(new Label(label));
      }
      // `break` statement
      break(label) {
        return this._leafNode(new Break(label));
      }
      // `return` statement
      return(value) {
        const node2 = new Return();
        this._blockNode(node2);
        this.code(value);
        if (node2.nodes.length !== 1)
          throw new Error('CodeGen: "return" should have one node');
        return this._endBlockNode(Return);
      }
      // `try` statement
      try(tryBody, catchCode, finallyCode) {
        if (!catchCode && !finallyCode)
          throw new Error('CodeGen: "try" without "catch" and "finally"');
        const node2 = new Try();
        this._blockNode(node2);
        this.code(tryBody);
        if (catchCode) {
          const error2 = this.name("e");
          this._currNode = node2.catch = new Catch(error2);
          catchCode(error2);
        }
        if (finallyCode) {
          this._currNode = node2.finally = new Finally();
          this.code(finallyCode);
        }
        return this._endBlockNode(Catch, Finally);
      }
      // `throw` statement
      throw(error2) {
        return this._leafNode(new Throw(error2));
      }
      // start self-balancing block
      block(body, nodeCount) {
        this._blockStarts.push(this._nodes.length);
        if (body)
          this.code(body).endBlock(nodeCount);
        return this;
      }
      // end the current self-balancing block
      endBlock(nodeCount) {
        const len = this._blockStarts.pop();
        if (len === void 0)
          throw new Error("CodeGen: not in self-balancing block");
        const toClose = this._nodes.length - len;
        if (toClose < 0 || nodeCount !== void 0 && toClose !== nodeCount) {
          throw new Error(`CodeGen: wrong number of nodes: ${toClose} vs ${nodeCount} expected`);
        }
        this._nodes.length = len;
        return this;
      }
      // `function` heading (or definition if funcBody is passed)
      func(name, args = code_1.nil, async, funcBody) {
        this._blockNode(new Func(name, args, async));
        if (funcBody)
          this.code(funcBody).endFunc();
        return this;
      }
      // end function definition
      endFunc() {
        return this._endBlockNode(Func);
      }
      optimize(n = 1) {
        while (n-- > 0) {
          this._root.optimizeNodes();
          this._root.optimizeNames(this._root.names, this._constants);
        }
      }
      _leafNode(node2) {
        this._currNode.nodes.push(node2);
        return this;
      }
      _blockNode(node2) {
        this._currNode.nodes.push(node2);
        this._nodes.push(node2);
      }
      _endBlockNode(N1, N2) {
        const n = this._currNode;
        if (n instanceof N1 || N2 && n instanceof N2) {
          this._nodes.pop();
          return this;
        }
        throw new Error(`CodeGen: not in block "${N2 ? `${N1.kind}/${N2.kind}` : N1.kind}"`);
      }
      _elseNode(node2) {
        const n = this._currNode;
        if (!(n instanceof If)) {
          throw new Error('CodeGen: "else" without "if"');
        }
        this._currNode = n.else = node2;
        return this;
      }
      get _root() {
        return this._nodes[0];
      }
      get _currNode() {
        const ns = this._nodes;
        return ns[ns.length - 1];
      }
      set _currNode(node2) {
        const ns = this._nodes;
        ns[ns.length - 1] = node2;
      }
    };
    exports.CodeGen = CodeGen;
    function addNames(names, from) {
      for (const n in from)
        names[n] = (names[n] || 0) + (from[n] || 0);
      return names;
    }
    function addExprNames(names, from) {
      return from instanceof code_1._CodeOrName ? addNames(names, from.names) : names;
    }
    function optimizeExpr(expr, names, constants) {
      if (expr instanceof code_1.Name)
        return replaceName(expr);
      if (!canOptimize(expr))
        return expr;
      return new code_1._Code(expr._items.reduce((items, c) => {
        if (c instanceof code_1.Name)
          c = replaceName(c);
        if (c instanceof code_1._Code)
          items.push(...c._items);
        else
          items.push(c);
        return items;
      }, []));
      function replaceName(n) {
        const c = constants[n.str];
        if (c === void 0 || names[n.str] !== 1)
          return n;
        delete names[n.str];
        return c;
      }
      function canOptimize(e) {
        return e instanceof code_1._Code && e._items.some((c) => c instanceof code_1.Name && names[c.str] === 1 && constants[c.str] !== void 0);
      }
    }
    function subtractNames(names, from) {
      for (const n in from)
        names[n] = (names[n] || 0) - (from[n] || 0);
    }
    function not(x) {
      return typeof x == "boolean" || typeof x == "number" || x === null ? !x : (0, code_1._)`!${par(x)}`;
    }
    exports.not = not;
    var andCode = mappend(exports.operators.AND);
    function and(...args) {
      return args.reduce(andCode);
    }
    exports.and = and;
    var orCode = mappend(exports.operators.OR);
    function or(...args) {
      return args.reduce(orCode);
    }
    exports.or = or;
    function mappend(op) {
      return (x, y) => x === code_1.nil ? y : y === code_1.nil ? x : (0, code_1._)`${par(x)} ${op} ${par(y)}`;
    }
    function par(x) {
      return x instanceof code_1.Name ? x : (0, code_1._)`(${x})`;
    }
  }
});

// node_modules/ajv/dist/compile/util.js
var require_util = __commonJS({
  "node_modules/ajv/dist/compile/util.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.checkStrictMode = exports.getErrorPath = exports.Type = exports.useFunc = exports.setEvaluated = exports.evaluatedPropsToName = exports.mergeEvaluated = exports.eachItem = exports.unescapeJsonPointer = exports.escapeJsonPointer = exports.escapeFragment = exports.unescapeFragment = exports.schemaRefOrVal = exports.schemaHasRulesButRef = exports.schemaHasRules = exports.checkUnknownRules = exports.alwaysValidSchema = exports.toHash = void 0;
    var codegen_1 = require_codegen();
    var code_1 = require_code();
    function toHash(arr) {
      const hash = {};
      for (const item of arr)
        hash[item] = true;
      return hash;
    }
    exports.toHash = toHash;
    function alwaysValidSchema(it, schema) {
      if (typeof schema == "boolean")
        return schema;
      if (Object.keys(schema).length === 0)
        return true;
      checkUnknownRules(it, schema);
      return !schemaHasRules(schema, it.self.RULES.all);
    }
    exports.alwaysValidSchema = alwaysValidSchema;
    function checkUnknownRules(it, schema = it.schema) {
      const { opts, self } = it;
      if (!opts.strictSchema)
        return;
      if (typeof schema === "boolean")
        return;
      const rules = self.RULES.keywords;
      for (const key in schema) {
        if (!rules[key])
          checkStrictMode(it, `unknown keyword: "${key}"`);
      }
    }
    exports.checkUnknownRules = checkUnknownRules;
    function schemaHasRules(schema, rules) {
      if (typeof schema == "boolean")
        return !schema;
      for (const key in schema)
        if (rules[key])
          return true;
      return false;
    }
    exports.schemaHasRules = schemaHasRules;
    function schemaHasRulesButRef(schema, RULES) {
      if (typeof schema == "boolean")
        return !schema;
      for (const key in schema)
        if (key !== "$ref" && RULES.all[key])
          return true;
      return false;
    }
    exports.schemaHasRulesButRef = schemaHasRulesButRef;
    function schemaRefOrVal({ topSchemaRef, schemaPath }, schema, keyword, $data) {
      if (!$data) {
        if (typeof schema == "number" || typeof schema == "boolean")
          return schema;
        if (typeof schema == "string")
          return (0, codegen_1._)`${schema}`;
      }
      return (0, codegen_1._)`${topSchemaRef}${schemaPath}${(0, codegen_1.getProperty)(keyword)}`;
    }
    exports.schemaRefOrVal = schemaRefOrVal;
    function unescapeFragment(str3) {
      return unescapeJsonPointer(decodeURIComponent(str3));
    }
    exports.unescapeFragment = unescapeFragment;
    function escapeFragment(str3) {
      return encodeURIComponent(escapeJsonPointer(str3));
    }
    exports.escapeFragment = escapeFragment;
    function escapeJsonPointer(str3) {
      if (typeof str3 == "number")
        return `${str3}`;
      return str3.replace(/~/g, "~0").replace(/\//g, "~1");
    }
    exports.escapeJsonPointer = escapeJsonPointer;
    function unescapeJsonPointer(str3) {
      return str3.replace(/~1/g, "/").replace(/~0/g, "~");
    }
    exports.unescapeJsonPointer = unescapeJsonPointer;
    function eachItem(xs, f) {
      if (Array.isArray(xs)) {
        for (const x of xs)
          f(x);
      } else {
        f(xs);
      }
    }
    exports.eachItem = eachItem;
    function makeMergeEvaluated({ mergeNames, mergeToName, mergeValues: mergeValues2, resultToName }) {
      return (gen, from, to, toName) => {
        const res = to === void 0 ? from : to instanceof codegen_1.Name ? (from instanceof codegen_1.Name ? mergeNames(gen, from, to) : mergeToName(gen, from, to), to) : from instanceof codegen_1.Name ? (mergeToName(gen, to, from), from) : mergeValues2(from, to);
        return toName === codegen_1.Name && !(res instanceof codegen_1.Name) ? resultToName(gen, res) : res;
      };
    }
    exports.mergeEvaluated = {
      props: makeMergeEvaluated({
        mergeNames: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true && ${from} !== undefined`, () => {
          gen.if((0, codegen_1._)`${from} === true`, () => gen.assign(to, true), () => gen.assign(to, (0, codegen_1._)`${to} || {}`).code((0, codegen_1._)`Object.assign(${to}, ${from})`));
        }),
        mergeToName: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true`, () => {
          if (from === true) {
            gen.assign(to, true);
          } else {
            gen.assign(to, (0, codegen_1._)`${to} || {}`);
            setEvaluated(gen, to, from);
          }
        }),
        mergeValues: (from, to) => from === true ? true : { ...from, ...to },
        resultToName: evaluatedPropsToName
      }),
      items: makeMergeEvaluated({
        mergeNames: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true && ${from} !== undefined`, () => gen.assign(to, (0, codegen_1._)`${from} === true ? true : ${to} > ${from} ? ${to} : ${from}`)),
        mergeToName: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true`, () => gen.assign(to, from === true ? true : (0, codegen_1._)`${to} > ${from} ? ${to} : ${from}`)),
        mergeValues: (from, to) => from === true ? true : Math.max(from, to),
        resultToName: (gen, items) => gen.var("items", items)
      })
    };
    function evaluatedPropsToName(gen, ps) {
      if (ps === true)
        return gen.var("props", true);
      const props = gen.var("props", (0, codegen_1._)`{}`);
      if (ps !== void 0)
        setEvaluated(gen, props, ps);
      return props;
    }
    exports.evaluatedPropsToName = evaluatedPropsToName;
    function setEvaluated(gen, props, ps) {
      Object.keys(ps).forEach((p) => gen.assign((0, codegen_1._)`${props}${(0, codegen_1.getProperty)(p)}`, true));
    }
    exports.setEvaluated = setEvaluated;
    var snippets = {};
    function useFunc(gen, f) {
      return gen.scopeValue("func", {
        ref: f,
        code: snippets[f.code] || (snippets[f.code] = new code_1._Code(f.code))
      });
    }
    exports.useFunc = useFunc;
    var Type;
    (function(Type2) {
      Type2[Type2["Num"] = 0] = "Num";
      Type2[Type2["Str"] = 1] = "Str";
    })(Type || (exports.Type = Type = {}));
    function getErrorPath(dataProp, dataPropType, jsPropertySyntax) {
      if (dataProp instanceof codegen_1.Name) {
        const isNumber = dataPropType === Type.Num;
        return jsPropertySyntax ? isNumber ? (0, codegen_1._)`"[" + ${dataProp} + "]"` : (0, codegen_1._)`"['" + ${dataProp} + "']"` : isNumber ? (0, codegen_1._)`"/" + ${dataProp}` : (0, codegen_1._)`"/" + ${dataProp}.replace(/~/g, "~0").replace(/\\//g, "~1")`;
      }
      return jsPropertySyntax ? (0, codegen_1.getProperty)(dataProp).toString() : "/" + escapeJsonPointer(dataProp);
    }
    exports.getErrorPath = getErrorPath;
    function checkStrictMode(it, msg, mode = it.opts.strictSchema) {
      if (!mode)
        return;
      msg = `strict mode: ${msg}`;
      if (mode === true)
        throw new Error(msg);
      it.self.logger.warn(msg);
    }
    exports.checkStrictMode = checkStrictMode;
  }
});

// node_modules/ajv/dist/compile/names.js
var require_names = __commonJS({
  "node_modules/ajv/dist/compile/names.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var names = {
      // validation function arguments
      data: new codegen_1.Name("data"),
      // data passed to validation function
      // args passed from referencing schema
      valCxt: new codegen_1.Name("valCxt"),
      // validation/data context - should not be used directly, it is destructured to the names below
      instancePath: new codegen_1.Name("instancePath"),
      parentData: new codegen_1.Name("parentData"),
      parentDataProperty: new codegen_1.Name("parentDataProperty"),
      rootData: new codegen_1.Name("rootData"),
      // root data - same as the data passed to the first/top validation function
      dynamicAnchors: new codegen_1.Name("dynamicAnchors"),
      // used to support recursiveRef and dynamicRef
      // function scoped variables
      vErrors: new codegen_1.Name("vErrors"),
      // null or array of validation errors
      errors: new codegen_1.Name("errors"),
      // counter of validation errors
      this: new codegen_1.Name("this"),
      // "globals"
      self: new codegen_1.Name("self"),
      scope: new codegen_1.Name("scope"),
      // JTD serialize/parse name for JSON string and position
      json: new codegen_1.Name("json"),
      jsonPos: new codegen_1.Name("jsonPos"),
      jsonLen: new codegen_1.Name("jsonLen"),
      jsonPart: new codegen_1.Name("jsonPart")
    };
    exports.default = names;
  }
});

// node_modules/ajv/dist/compile/errors.js
var require_errors = __commonJS({
  "node_modules/ajv/dist/compile/errors.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.extendErrors = exports.resetErrorsCount = exports.reportExtraError = exports.reportError = exports.keyword$DataError = exports.keywordError = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var names_1 = require_names();
    exports.keywordError = {
      message: ({ keyword }) => (0, codegen_1.str)`must pass "${keyword}" keyword validation`
    };
    exports.keyword$DataError = {
      message: ({ keyword, schemaType }) => schemaType ? (0, codegen_1.str)`"${keyword}" keyword must be ${schemaType} ($data)` : (0, codegen_1.str)`"${keyword}" keyword is invalid ($data)`
    };
    function reportError(cxt, error2 = exports.keywordError, errorPaths, overrideAllErrors) {
      const { it } = cxt;
      const { gen, compositeRule, allErrors } = it;
      const errObj = errorObjectCode(cxt, error2, errorPaths);
      if (overrideAllErrors !== null && overrideAllErrors !== void 0 ? overrideAllErrors : compositeRule || allErrors) {
        addError(gen, errObj);
      } else {
        returnErrors(it, (0, codegen_1._)`[${errObj}]`);
      }
    }
    exports.reportError = reportError;
    function reportExtraError(cxt, error2 = exports.keywordError, errorPaths) {
      const { it } = cxt;
      const { gen, compositeRule, allErrors } = it;
      const errObj = errorObjectCode(cxt, error2, errorPaths);
      addError(gen, errObj);
      if (!(compositeRule || allErrors)) {
        returnErrors(it, names_1.default.vErrors);
      }
    }
    exports.reportExtraError = reportExtraError;
    function resetErrorsCount(gen, errsCount) {
      gen.assign(names_1.default.errors, errsCount);
      gen.if((0, codegen_1._)`${names_1.default.vErrors} !== null`, () => gen.if(errsCount, () => gen.assign((0, codegen_1._)`${names_1.default.vErrors}.length`, errsCount), () => gen.assign(names_1.default.vErrors, null)));
    }
    exports.resetErrorsCount = resetErrorsCount;
    function extendErrors({ gen, keyword, schemaValue, data, errsCount, it }) {
      if (errsCount === void 0)
        throw new Error("ajv implementation error");
      const err = gen.name("err");
      gen.forRange("i", errsCount, names_1.default.errors, (i) => {
        gen.const(err, (0, codegen_1._)`${names_1.default.vErrors}[${i}]`);
        gen.if((0, codegen_1._)`${err}.instancePath === undefined`, () => gen.assign((0, codegen_1._)`${err}.instancePath`, (0, codegen_1.strConcat)(names_1.default.instancePath, it.errorPath)));
        gen.assign((0, codegen_1._)`${err}.schemaPath`, (0, codegen_1.str)`${it.errSchemaPath}/${keyword}`);
        if (it.opts.verbose) {
          gen.assign((0, codegen_1._)`${err}.schema`, schemaValue);
          gen.assign((0, codegen_1._)`${err}.data`, data);
        }
      });
    }
    exports.extendErrors = extendErrors;
    function addError(gen, errObj) {
      const err = gen.const("err", errObj);
      gen.if((0, codegen_1._)`${names_1.default.vErrors} === null`, () => gen.assign(names_1.default.vErrors, (0, codegen_1._)`[${err}]`), (0, codegen_1._)`${names_1.default.vErrors}.push(${err})`);
      gen.code((0, codegen_1._)`${names_1.default.errors}++`);
    }
    function returnErrors(it, errs) {
      const { gen, validateName, schemaEnv } = it;
      if (schemaEnv.$async) {
        gen.throw((0, codegen_1._)`new ${it.ValidationError}(${errs})`);
      } else {
        gen.assign((0, codegen_1._)`${validateName}.errors`, errs);
        gen.return(false);
      }
    }
    var E = {
      keyword: new codegen_1.Name("keyword"),
      schemaPath: new codegen_1.Name("schemaPath"),
      // also used in JTD errors
      params: new codegen_1.Name("params"),
      propertyName: new codegen_1.Name("propertyName"),
      message: new codegen_1.Name("message"),
      schema: new codegen_1.Name("schema"),
      parentSchema: new codegen_1.Name("parentSchema")
    };
    function errorObjectCode(cxt, error2, errorPaths) {
      const { createErrors } = cxt.it;
      if (createErrors === false)
        return (0, codegen_1._)`{}`;
      return errorObject(cxt, error2, errorPaths);
    }
    function errorObject(cxt, error2, errorPaths = {}) {
      const { gen, it } = cxt;
      const keyValues = [
        errorInstancePath(it, errorPaths),
        errorSchemaPath(cxt, errorPaths)
      ];
      extraErrorProps(cxt, error2, keyValues);
      return gen.object(...keyValues);
    }
    function errorInstancePath({ errorPath }, { instancePath }) {
      const instPath = instancePath ? (0, codegen_1.str)`${errorPath}${(0, util_1.getErrorPath)(instancePath, util_1.Type.Str)}` : errorPath;
      return [names_1.default.instancePath, (0, codegen_1.strConcat)(names_1.default.instancePath, instPath)];
    }
    function errorSchemaPath({ keyword, it: { errSchemaPath } }, { schemaPath, parentSchema }) {
      let schPath = parentSchema ? errSchemaPath : (0, codegen_1.str)`${errSchemaPath}/${keyword}`;
      if (schemaPath) {
        schPath = (0, codegen_1.str)`${schPath}${(0, util_1.getErrorPath)(schemaPath, util_1.Type.Str)}`;
      }
      return [E.schemaPath, schPath];
    }
    function extraErrorProps(cxt, { params, message }, keyValues) {
      const { keyword, data, schemaValue, it } = cxt;
      const { opts, propertyName, topSchemaRef, schemaPath } = it;
      keyValues.push([E.keyword, keyword], [E.params, typeof params == "function" ? params(cxt) : params || (0, codegen_1._)`{}`]);
      if (opts.messages) {
        keyValues.push([E.message, typeof message == "function" ? message(cxt) : message]);
      }
      if (opts.verbose) {
        keyValues.push([E.schema, schemaValue], [E.parentSchema, (0, codegen_1._)`${topSchemaRef}${schemaPath}`], [names_1.default.data, data]);
      }
      if (propertyName)
        keyValues.push([E.propertyName, propertyName]);
    }
  }
});

// node_modules/ajv/dist/compile/validate/boolSchema.js
var require_boolSchema = __commonJS({
  "node_modules/ajv/dist/compile/validate/boolSchema.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.boolOrEmptySchema = exports.topBoolOrEmptySchema = void 0;
    var errors_1 = require_errors();
    var codegen_1 = require_codegen();
    var names_1 = require_names();
    var boolError = {
      message: "boolean schema is false"
    };
    function topBoolOrEmptySchema(it) {
      const { gen, schema, validateName } = it;
      if (schema === false) {
        falseSchemaError(it, false);
      } else if (typeof schema == "object" && schema.$async === true) {
        gen.return(names_1.default.data);
      } else {
        gen.assign((0, codegen_1._)`${validateName}.errors`, null);
        gen.return(true);
      }
    }
    exports.topBoolOrEmptySchema = topBoolOrEmptySchema;
    function boolOrEmptySchema(it, valid) {
      const { gen, schema } = it;
      if (schema === false) {
        gen.var(valid, false);
        falseSchemaError(it);
      } else {
        gen.var(valid, true);
      }
    }
    exports.boolOrEmptySchema = boolOrEmptySchema;
    function falseSchemaError(it, overrideAllErrors) {
      const { gen, data } = it;
      const cxt = {
        gen,
        keyword: "false schema",
        data,
        schema: false,
        schemaCode: false,
        schemaValue: false,
        params: {},
        it
      };
      (0, errors_1.reportError)(cxt, boolError, void 0, overrideAllErrors);
    }
  }
});

// node_modules/ajv/dist/compile/rules.js
var require_rules = __commonJS({
  "node_modules/ajv/dist/compile/rules.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.getRules = exports.isJSONType = void 0;
    var _jsonTypes = ["string", "number", "integer", "boolean", "null", "object", "array"];
    var jsonTypes = new Set(_jsonTypes);
    function isJSONType(x) {
      return typeof x == "string" && jsonTypes.has(x);
    }
    exports.isJSONType = isJSONType;
    function getRules() {
      const groups = {
        number: { type: "number", rules: [] },
        string: { type: "string", rules: [] },
        array: { type: "array", rules: [] },
        object: { type: "object", rules: [] }
      };
      return {
        types: { ...groups, integer: true, boolean: true, null: true },
        rules: [{ rules: [] }, groups.number, groups.string, groups.array, groups.object],
        post: { rules: [] },
        all: {},
        keywords: {}
      };
    }
    exports.getRules = getRules;
  }
});

// node_modules/ajv/dist/compile/validate/applicability.js
var require_applicability = __commonJS({
  "node_modules/ajv/dist/compile/validate/applicability.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.shouldUseRule = exports.shouldUseGroup = exports.schemaHasRulesForType = void 0;
    function schemaHasRulesForType({ schema, self }, type) {
      const group = self.RULES.types[type];
      return group && group !== true && shouldUseGroup(schema, group);
    }
    exports.schemaHasRulesForType = schemaHasRulesForType;
    function shouldUseGroup(schema, group) {
      return group.rules.some((rule) => shouldUseRule(schema, rule));
    }
    exports.shouldUseGroup = shouldUseGroup;
    function shouldUseRule(schema, rule) {
      var _a3;
      return schema[rule.keyword] !== void 0 || ((_a3 = rule.definition.implements) === null || _a3 === void 0 ? void 0 : _a3.some((kwd) => schema[kwd] !== void 0));
    }
    exports.shouldUseRule = shouldUseRule;
  }
});

// node_modules/ajv/dist/compile/validate/dataType.js
var require_dataType = __commonJS({
  "node_modules/ajv/dist/compile/validate/dataType.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.reportTypeError = exports.checkDataTypes = exports.checkDataType = exports.coerceAndCheckDataType = exports.getJSONTypes = exports.getSchemaTypes = exports.DataType = void 0;
    var rules_1 = require_rules();
    var applicability_1 = require_applicability();
    var errors_1 = require_errors();
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var DataType;
    (function(DataType2) {
      DataType2[DataType2["Correct"] = 0] = "Correct";
      DataType2[DataType2["Wrong"] = 1] = "Wrong";
    })(DataType || (exports.DataType = DataType = {}));
    function getSchemaTypes(schema) {
      const types = getJSONTypes(schema.type);
      const hasNull = types.includes("null");
      if (hasNull) {
        if (schema.nullable === false)
          throw new Error("type: null contradicts nullable: false");
      } else {
        if (!types.length && schema.nullable !== void 0) {
          throw new Error('"nullable" cannot be used without "type"');
        }
        if (schema.nullable === true)
          types.push("null");
      }
      return types;
    }
    exports.getSchemaTypes = getSchemaTypes;
    function getJSONTypes(ts) {
      const types = Array.isArray(ts) ? ts : ts ? [ts] : [];
      if (types.every(rules_1.isJSONType))
        return types;
      throw new Error("type must be JSONType or JSONType[]: " + types.join(","));
    }
    exports.getJSONTypes = getJSONTypes;
    function coerceAndCheckDataType(it, types) {
      const { gen, data, opts } = it;
      const coerceTo = coerceToTypes(types, opts.coerceTypes);
      const checkTypes = types.length > 0 && !(coerceTo.length === 0 && types.length === 1 && (0, applicability_1.schemaHasRulesForType)(it, types[0]));
      if (checkTypes) {
        const wrongType = checkDataTypes(types, data, opts.strictNumbers, DataType.Wrong);
        gen.if(wrongType, () => {
          if (coerceTo.length)
            coerceData(it, types, coerceTo);
          else
            reportTypeError(it);
        });
      }
      return checkTypes;
    }
    exports.coerceAndCheckDataType = coerceAndCheckDataType;
    var COERCIBLE = /* @__PURE__ */ new Set(["string", "number", "integer", "boolean", "null"]);
    function coerceToTypes(types, coerceTypes) {
      return coerceTypes ? types.filter((t) => COERCIBLE.has(t) || coerceTypes === "array" && t === "array") : [];
    }
    function coerceData(it, types, coerceTo) {
      const { gen, data, opts } = it;
      const dataType = gen.let("dataType", (0, codegen_1._)`typeof ${data}`);
      const coerced = gen.let("coerced", (0, codegen_1._)`undefined`);
      if (opts.coerceTypes === "array") {
        gen.if((0, codegen_1._)`${dataType} == 'object' && Array.isArray(${data}) && ${data}.length == 1`, () => gen.assign(data, (0, codegen_1._)`${data}[0]`).assign(dataType, (0, codegen_1._)`typeof ${data}`).if(checkDataTypes(types, data, opts.strictNumbers), () => gen.assign(coerced, data)));
      }
      gen.if((0, codegen_1._)`${coerced} !== undefined`);
      for (const t of coerceTo) {
        if (COERCIBLE.has(t) || t === "array" && opts.coerceTypes === "array") {
          coerceSpecificType(t);
        }
      }
      gen.else();
      reportTypeError(it);
      gen.endIf();
      gen.if((0, codegen_1._)`${coerced} !== undefined`, () => {
        gen.assign(data, coerced);
        assignParentData(it, coerced);
      });
      function coerceSpecificType(t) {
        switch (t) {
          case "string":
            gen.elseIf((0, codegen_1._)`${dataType} == "number" || ${dataType} == "boolean"`).assign(coerced, (0, codegen_1._)`"" + ${data}`).elseIf((0, codegen_1._)`${data} === null`).assign(coerced, (0, codegen_1._)`""`);
            return;
          case "number":
            gen.elseIf((0, codegen_1._)`${dataType} == "boolean" || ${data} === null
              || (${dataType} == "string" && ${data} && ${data} == +${data})`).assign(coerced, (0, codegen_1._)`+${data}`);
            return;
          case "integer":
            gen.elseIf((0, codegen_1._)`${dataType} === "boolean" || ${data} === null
              || (${dataType} === "string" && ${data} && ${data} == +${data} && !(${data} % 1))`).assign(coerced, (0, codegen_1._)`+${data}`);
            return;
          case "boolean":
            gen.elseIf((0, codegen_1._)`${data} === "false" || ${data} === 0 || ${data} === null`).assign(coerced, false).elseIf((0, codegen_1._)`${data} === "true" || ${data} === 1`).assign(coerced, true);
            return;
          case "null":
            gen.elseIf((0, codegen_1._)`${data} === "" || ${data} === 0 || ${data} === false`);
            gen.assign(coerced, null);
            return;
          case "array":
            gen.elseIf((0, codegen_1._)`${dataType} === "string" || ${dataType} === "number"
              || ${dataType} === "boolean" || ${data} === null`).assign(coerced, (0, codegen_1._)`[${data}]`);
        }
      }
    }
    function assignParentData({ gen, parentData, parentDataProperty }, expr) {
      gen.if((0, codegen_1._)`${parentData} !== undefined`, () => gen.assign((0, codegen_1._)`${parentData}[${parentDataProperty}]`, expr));
    }
    function checkDataType(dataType, data, strictNums, correct = DataType.Correct) {
      const EQ = correct === DataType.Correct ? codegen_1.operators.EQ : codegen_1.operators.NEQ;
      let cond;
      switch (dataType) {
        case "null":
          return (0, codegen_1._)`${data} ${EQ} null`;
        case "array":
          cond = (0, codegen_1._)`Array.isArray(${data})`;
          break;
        case "object":
          cond = (0, codegen_1._)`${data} && typeof ${data} == "object" && !Array.isArray(${data})`;
          break;
        case "integer":
          cond = numCond((0, codegen_1._)`!(${data} % 1) && !isNaN(${data})`);
          break;
        case "number":
          cond = numCond();
          break;
        default:
          return (0, codegen_1._)`typeof ${data} ${EQ} ${dataType}`;
      }
      return correct === DataType.Correct ? cond : (0, codegen_1.not)(cond);
      function numCond(_cond = codegen_1.nil) {
        return (0, codegen_1.and)((0, codegen_1._)`typeof ${data} == "number"`, _cond, strictNums ? (0, codegen_1._)`isFinite(${data})` : codegen_1.nil);
      }
    }
    exports.checkDataType = checkDataType;
    function checkDataTypes(dataTypes, data, strictNums, correct) {
      if (dataTypes.length === 1) {
        return checkDataType(dataTypes[0], data, strictNums, correct);
      }
      let cond;
      const types = (0, util_1.toHash)(dataTypes);
      if (types.array && types.object) {
        const notObj = (0, codegen_1._)`typeof ${data} != "object"`;
        cond = types.null ? notObj : (0, codegen_1._)`!${data} || ${notObj}`;
        delete types.null;
        delete types.array;
        delete types.object;
      } else {
        cond = codegen_1.nil;
      }
      if (types.number)
        delete types.integer;
      for (const t in types)
        cond = (0, codegen_1.and)(cond, checkDataType(t, data, strictNums, correct));
      return cond;
    }
    exports.checkDataTypes = checkDataTypes;
    var typeError = {
      message: ({ schema }) => `must be ${schema}`,
      params: ({ schema, schemaValue }) => typeof schema == "string" ? (0, codegen_1._)`{type: ${schema}}` : (0, codegen_1._)`{type: ${schemaValue}}`
    };
    function reportTypeError(it) {
      const cxt = getTypeErrorContext(it);
      (0, errors_1.reportError)(cxt, typeError);
    }
    exports.reportTypeError = reportTypeError;
    function getTypeErrorContext(it) {
      const { gen, data, schema } = it;
      const schemaCode = (0, util_1.schemaRefOrVal)(it, schema, "type");
      return {
        gen,
        keyword: "type",
        data,
        schema: schema.type,
        schemaCode,
        schemaValue: schemaCode,
        parentSchema: schema,
        params: {},
        it
      };
    }
  }
});

// node_modules/ajv/dist/compile/validate/defaults.js
var require_defaults = __commonJS({
  "node_modules/ajv/dist/compile/validate/defaults.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.assignDefaults = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    function assignDefaults(it, ty) {
      const { properties, items } = it.schema;
      if (ty === "object" && properties) {
        for (const key in properties) {
          assignDefault(it, key, properties[key].default);
        }
      } else if (ty === "array" && Array.isArray(items)) {
        items.forEach((sch, i) => assignDefault(it, i, sch.default));
      }
    }
    exports.assignDefaults = assignDefaults;
    function assignDefault(it, prop, defaultValue) {
      const { gen, compositeRule, data, opts } = it;
      if (defaultValue === void 0)
        return;
      const childData = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(prop)}`;
      if (compositeRule) {
        (0, util_1.checkStrictMode)(it, `default is ignored for: ${childData}`);
        return;
      }
      let condition = (0, codegen_1._)`${childData} === undefined`;
      if (opts.useDefaults === "empty") {
        condition = (0, codegen_1._)`${condition} || ${childData} === null || ${childData} === ""`;
      }
      gen.if(condition, (0, codegen_1._)`${childData} = ${(0, codegen_1.stringify)(defaultValue)}`);
    }
  }
});

// node_modules/ajv/dist/vocabularies/code.js
var require_code2 = __commonJS({
  "node_modules/ajv/dist/vocabularies/code.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.validateUnion = exports.validateArray = exports.usePattern = exports.callValidateCode = exports.schemaProperties = exports.allSchemaProperties = exports.noPropertyInData = exports.propertyInData = exports.isOwnProperty = exports.hasPropFunc = exports.reportMissingProp = exports.checkMissingProp = exports.checkReportMissingProp = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var names_1 = require_names();
    var util_2 = require_util();
    function checkReportMissingProp(cxt, prop) {
      const { gen, data, it } = cxt;
      gen.if(noPropertyInData(gen, data, prop, it.opts.ownProperties), () => {
        cxt.setParams({ missingProperty: (0, codegen_1._)`${prop}` }, true);
        cxt.error();
      });
    }
    exports.checkReportMissingProp = checkReportMissingProp;
    function checkMissingProp({ gen, data, it: { opts } }, properties, missing) {
      return (0, codegen_1.or)(...properties.map((prop) => (0, codegen_1.and)(noPropertyInData(gen, data, prop, opts.ownProperties), (0, codegen_1._)`${missing} = ${prop}`)));
    }
    exports.checkMissingProp = checkMissingProp;
    function reportMissingProp(cxt, missing) {
      cxt.setParams({ missingProperty: missing }, true);
      cxt.error();
    }
    exports.reportMissingProp = reportMissingProp;
    function hasPropFunc(gen) {
      return gen.scopeValue("func", {
        // eslint-disable-next-line @typescript-eslint/unbound-method
        ref: Object.prototype.hasOwnProperty,
        code: (0, codegen_1._)`Object.prototype.hasOwnProperty`
      });
    }
    exports.hasPropFunc = hasPropFunc;
    function isOwnProperty(gen, data, property) {
      return (0, codegen_1._)`${hasPropFunc(gen)}.call(${data}, ${property})`;
    }
    exports.isOwnProperty = isOwnProperty;
    function propertyInData(gen, data, property, ownProperties) {
      const cond = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(property)} !== undefined`;
      return ownProperties ? (0, codegen_1._)`${cond} && ${isOwnProperty(gen, data, property)}` : cond;
    }
    exports.propertyInData = propertyInData;
    function noPropertyInData(gen, data, property, ownProperties) {
      const cond = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(property)} === undefined`;
      return ownProperties ? (0, codegen_1.or)(cond, (0, codegen_1.not)(isOwnProperty(gen, data, property))) : cond;
    }
    exports.noPropertyInData = noPropertyInData;
    function allSchemaProperties(schemaMap) {
      return schemaMap ? Object.keys(schemaMap).filter((p) => p !== "__proto__") : [];
    }
    exports.allSchemaProperties = allSchemaProperties;
    function schemaProperties(it, schemaMap) {
      return allSchemaProperties(schemaMap).filter((p) => !(0, util_1.alwaysValidSchema)(it, schemaMap[p]));
    }
    exports.schemaProperties = schemaProperties;
    function callValidateCode({ schemaCode, data, it: { gen, topSchemaRef, schemaPath, errorPath }, it }, func, context, passSchema) {
      const dataAndSchema = passSchema ? (0, codegen_1._)`${schemaCode}, ${data}, ${topSchemaRef}${schemaPath}` : data;
      const valCxt = [
        [names_1.default.instancePath, (0, codegen_1.strConcat)(names_1.default.instancePath, errorPath)],
        [names_1.default.parentData, it.parentData],
        [names_1.default.parentDataProperty, it.parentDataProperty],
        [names_1.default.rootData, names_1.default.rootData]
      ];
      if (it.opts.dynamicRef)
        valCxt.push([names_1.default.dynamicAnchors, names_1.default.dynamicAnchors]);
      const args = (0, codegen_1._)`${dataAndSchema}, ${gen.object(...valCxt)}`;
      return context !== codegen_1.nil ? (0, codegen_1._)`${func}.call(${context}, ${args})` : (0, codegen_1._)`${func}(${args})`;
    }
    exports.callValidateCode = callValidateCode;
    var newRegExp = (0, codegen_1._)`new RegExp`;
    function usePattern({ gen, it: { opts } }, pattern) {
      const u = opts.unicodeRegExp ? "u" : "";
      const { regExp } = opts.code;
      const rx = regExp(pattern, u);
      return gen.scopeValue("pattern", {
        key: rx.toString(),
        ref: rx,
        code: (0, codegen_1._)`${regExp.code === "new RegExp" ? newRegExp : (0, util_2.useFunc)(gen, regExp)}(${pattern}, ${u})`
      });
    }
    exports.usePattern = usePattern;
    function validateArray(cxt) {
      const { gen, data, keyword, it } = cxt;
      const valid = gen.name("valid");
      if (it.allErrors) {
        const validArr = gen.let("valid", true);
        validateItems(() => gen.assign(validArr, false));
        return validArr;
      }
      gen.var(valid, true);
      validateItems(() => gen.break());
      return valid;
      function validateItems(notValid) {
        const len = gen.const("len", (0, codegen_1._)`${data}.length`);
        gen.forRange("i", 0, len, (i) => {
          cxt.subschema({
            keyword,
            dataProp: i,
            dataPropType: util_1.Type.Num
          }, valid);
          gen.if((0, codegen_1.not)(valid), notValid);
        });
      }
    }
    exports.validateArray = validateArray;
    function validateUnion(cxt) {
      const { gen, schema, keyword, it } = cxt;
      if (!Array.isArray(schema))
        throw new Error("ajv implementation error");
      const alwaysValid = schema.some((sch) => (0, util_1.alwaysValidSchema)(it, sch));
      if (alwaysValid && !it.opts.unevaluated)
        return;
      const valid = gen.let("valid", false);
      const schValid = gen.name("_valid");
      gen.block(() => schema.forEach((_sch, i) => {
        const schCxt = cxt.subschema({
          keyword,
          schemaProp: i,
          compositeRule: true
        }, schValid);
        gen.assign(valid, (0, codegen_1._)`${valid} || ${schValid}`);
        const merged = cxt.mergeValidEvaluated(schCxt, schValid);
        if (!merged)
          gen.if((0, codegen_1.not)(valid));
      }));
      cxt.result(valid, () => cxt.reset(), () => cxt.error(true));
    }
    exports.validateUnion = validateUnion;
  }
});

// node_modules/ajv/dist/compile/validate/keyword.js
var require_keyword = __commonJS({
  "node_modules/ajv/dist/compile/validate/keyword.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.validateKeywordUsage = exports.validSchemaType = exports.funcKeywordCode = exports.macroKeywordCode = void 0;
    var codegen_1 = require_codegen();
    var names_1 = require_names();
    var code_1 = require_code2();
    var errors_1 = require_errors();
    function macroKeywordCode(cxt, def3) {
      const { gen, keyword, schema, parentSchema, it } = cxt;
      const macroSchema = def3.macro.call(it.self, schema, parentSchema, it);
      const schemaRef = useKeyword(gen, keyword, macroSchema);
      if (it.opts.validateSchema !== false)
        it.self.validateSchema(macroSchema, true);
      const valid = gen.name("valid");
      cxt.subschema({
        schema: macroSchema,
        schemaPath: codegen_1.nil,
        errSchemaPath: `${it.errSchemaPath}/${keyword}`,
        topSchemaRef: schemaRef,
        compositeRule: true
      }, valid);
      cxt.pass(valid, () => cxt.error(true));
    }
    exports.macroKeywordCode = macroKeywordCode;
    function funcKeywordCode(cxt, def3) {
      var _a3;
      const { gen, keyword, schema, parentSchema, $data, it } = cxt;
      checkAsyncKeyword(it, def3);
      const validate2 = !$data && def3.compile ? def3.compile.call(it.self, schema, parentSchema, it) : def3.validate;
      const validateRef = useKeyword(gen, keyword, validate2);
      const valid = gen.let("valid");
      cxt.block$data(valid, validateKeyword);
      cxt.ok((_a3 = def3.valid) !== null && _a3 !== void 0 ? _a3 : valid);
      function validateKeyword() {
        if (def3.errors === false) {
          assignValid();
          if (def3.modifying)
            modifyData(cxt);
          reportErrs(() => cxt.error());
        } else {
          const ruleErrs = def3.async ? validateAsync3() : validateSync();
          if (def3.modifying)
            modifyData(cxt);
          reportErrs(() => addErrs(cxt, ruleErrs));
        }
      }
      function validateAsync3() {
        const ruleErrs = gen.let("ruleErrs", null);
        gen.try(() => assignValid((0, codegen_1._)`await `), (e) => gen.assign(valid, false).if((0, codegen_1._)`${e} instanceof ${it.ValidationError}`, () => gen.assign(ruleErrs, (0, codegen_1._)`${e}.errors`), () => gen.throw(e)));
        return ruleErrs;
      }
      function validateSync() {
        const validateErrs = (0, codegen_1._)`${validateRef}.errors`;
        gen.assign(validateErrs, null);
        assignValid(codegen_1.nil);
        return validateErrs;
      }
      function assignValid(_await = def3.async ? (0, codegen_1._)`await ` : codegen_1.nil) {
        const passCxt = it.opts.passContext ? names_1.default.this : names_1.default.self;
        const passSchema = !("compile" in def3 && !$data || def3.schema === false);
        gen.assign(valid, (0, codegen_1._)`${_await}${(0, code_1.callValidateCode)(cxt, validateRef, passCxt, passSchema)}`, def3.modifying);
      }
      function reportErrs(errors) {
        var _a4;
        gen.if((0, codegen_1.not)((_a4 = def3.valid) !== null && _a4 !== void 0 ? _a4 : valid), errors);
      }
    }
    exports.funcKeywordCode = funcKeywordCode;
    function modifyData(cxt) {
      const { gen, data, it } = cxt;
      gen.if(it.parentData, () => gen.assign(data, (0, codegen_1._)`${it.parentData}[${it.parentDataProperty}]`));
    }
    function addErrs(cxt, errs) {
      const { gen } = cxt;
      gen.if((0, codegen_1._)`Array.isArray(${errs})`, () => {
        gen.assign(names_1.default.vErrors, (0, codegen_1._)`${names_1.default.vErrors} === null ? ${errs} : ${names_1.default.vErrors}.concat(${errs})`).assign(names_1.default.errors, (0, codegen_1._)`${names_1.default.vErrors}.length`);
        (0, errors_1.extendErrors)(cxt);
      }, () => cxt.error());
    }
    function checkAsyncKeyword({ schemaEnv }, def3) {
      if (def3.async && !schemaEnv.$async)
        throw new Error("async keyword in sync schema");
    }
    function useKeyword(gen, keyword, result) {
      if (result === void 0)
        throw new Error(`keyword "${keyword}" failed to compile`);
      return gen.scopeValue("keyword", typeof result == "function" ? { ref: result } : { ref: result, code: (0, codegen_1.stringify)(result) });
    }
    function validSchemaType(schema, schemaType, allowUndefined = false) {
      return !schemaType.length || schemaType.some((st) => st === "array" ? Array.isArray(schema) : st === "object" ? schema && typeof schema == "object" && !Array.isArray(schema) : typeof schema == st || allowUndefined && typeof schema == "undefined");
    }
    exports.validSchemaType = validSchemaType;
    function validateKeywordUsage({ schema, opts, self, errSchemaPath }, def3, keyword) {
      if (Array.isArray(def3.keyword) ? !def3.keyword.includes(keyword) : def3.keyword !== keyword) {
        throw new Error("ajv implementation error");
      }
      const deps = def3.dependencies;
      if (deps === null || deps === void 0 ? void 0 : deps.some((kwd) => !Object.prototype.hasOwnProperty.call(schema, kwd))) {
        throw new Error(`parent schema must have dependencies of ${keyword}: ${deps.join(",")}`);
      }
      if (def3.validateSchema) {
        const valid = def3.validateSchema(schema[keyword]);
        if (!valid) {
          const msg = `keyword "${keyword}" value is invalid at path "${errSchemaPath}": ` + self.errorsText(def3.validateSchema.errors);
          if (opts.validateSchema === "log")
            self.logger.error(msg);
          else
            throw new Error(msg);
        }
      }
    }
    exports.validateKeywordUsage = validateKeywordUsage;
  }
});

// node_modules/ajv/dist/compile/validate/subschema.js
var require_subschema = __commonJS({
  "node_modules/ajv/dist/compile/validate/subschema.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.extendSubschemaMode = exports.extendSubschemaData = exports.getSubschema = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    function getSubschema(it, { keyword, schemaProp, schema, schemaPath, errSchemaPath, topSchemaRef }) {
      if (keyword !== void 0 && schema !== void 0) {
        throw new Error('both "keyword" and "schema" passed, only one allowed');
      }
      if (keyword !== void 0) {
        const sch = it.schema[keyword];
        return schemaProp === void 0 ? {
          schema: sch,
          schemaPath: (0, codegen_1._)`${it.schemaPath}${(0, codegen_1.getProperty)(keyword)}`,
          errSchemaPath: `${it.errSchemaPath}/${keyword}`
        } : {
          schema: sch[schemaProp],
          schemaPath: (0, codegen_1._)`${it.schemaPath}${(0, codegen_1.getProperty)(keyword)}${(0, codegen_1.getProperty)(schemaProp)}`,
          errSchemaPath: `${it.errSchemaPath}/${keyword}/${(0, util_1.escapeFragment)(schemaProp)}`
        };
      }
      if (schema !== void 0) {
        if (schemaPath === void 0 || errSchemaPath === void 0 || topSchemaRef === void 0) {
          throw new Error('"schemaPath", "errSchemaPath" and "topSchemaRef" are required with "schema"');
        }
        return {
          schema,
          schemaPath,
          topSchemaRef,
          errSchemaPath
        };
      }
      throw new Error('either "keyword" or "schema" must be passed');
    }
    exports.getSubschema = getSubschema;
    function extendSubschemaData(subschema, it, { dataProp, dataPropType: dpType, data, dataTypes, propertyName }) {
      if (data !== void 0 && dataProp !== void 0) {
        throw new Error('both "data" and "dataProp" passed, only one allowed');
      }
      const { gen } = it;
      if (dataProp !== void 0) {
        const { errorPath, dataPathArr, opts } = it;
        const nextData = gen.let("data", (0, codegen_1._)`${it.data}${(0, codegen_1.getProperty)(dataProp)}`, true);
        dataContextProps(nextData);
        subschema.errorPath = (0, codegen_1.str)`${errorPath}${(0, util_1.getErrorPath)(dataProp, dpType, opts.jsPropertySyntax)}`;
        subschema.parentDataProperty = (0, codegen_1._)`${dataProp}`;
        subschema.dataPathArr = [...dataPathArr, subschema.parentDataProperty];
      }
      if (data !== void 0) {
        const nextData = data instanceof codegen_1.Name ? data : gen.let("data", data, true);
        dataContextProps(nextData);
        if (propertyName !== void 0)
          subschema.propertyName = propertyName;
      }
      if (dataTypes)
        subschema.dataTypes = dataTypes;
      function dataContextProps(_nextData) {
        subschema.data = _nextData;
        subschema.dataLevel = it.dataLevel + 1;
        subschema.dataTypes = [];
        it.definedProperties = /* @__PURE__ */ new Set();
        subschema.parentData = it.data;
        subschema.dataNames = [...it.dataNames, _nextData];
      }
    }
    exports.extendSubschemaData = extendSubschemaData;
    function extendSubschemaMode(subschema, { jtdDiscriminator, jtdMetadata, compositeRule, createErrors, allErrors }) {
      if (compositeRule !== void 0)
        subschema.compositeRule = compositeRule;
      if (createErrors !== void 0)
        subschema.createErrors = createErrors;
      if (allErrors !== void 0)
        subschema.allErrors = allErrors;
      subschema.jtdDiscriminator = jtdDiscriminator;
      subschema.jtdMetadata = jtdMetadata;
    }
    exports.extendSubschemaMode = extendSubschemaMode;
  }
});

// node_modules/fast-deep-equal/index.js
var require_fast_deep_equal = __commonJS({
  "node_modules/fast-deep-equal/index.js"(exports, module) {
    "use strict";
    module.exports = function equal(a, b) {
      if (a === b) return true;
      if (a && b && typeof a == "object" && typeof b == "object") {
        if (a.constructor !== b.constructor) return false;
        var length, i, keys;
        if (Array.isArray(a)) {
          length = a.length;
          if (length != b.length) return false;
          for (i = length; i-- !== 0; )
            if (!equal(a[i], b[i])) return false;
          return true;
        }
        if (a.constructor === RegExp) return a.source === b.source && a.flags === b.flags;
        if (a.valueOf !== Object.prototype.valueOf) return a.valueOf() === b.valueOf();
        if (a.toString !== Object.prototype.toString) return a.toString() === b.toString();
        keys = Object.keys(a);
        length = keys.length;
        if (length !== Object.keys(b).length) return false;
        for (i = length; i-- !== 0; )
          if (!Object.prototype.hasOwnProperty.call(b, keys[i])) return false;
        for (i = length; i-- !== 0; ) {
          var key = keys[i];
          if (!equal(a[key], b[key])) return false;
        }
        return true;
      }
      return a !== a && b !== b;
    };
  }
});

// node_modules/json-schema-traverse/index.js
var require_json_schema_traverse = __commonJS({
  "node_modules/json-schema-traverse/index.js"(exports, module) {
    "use strict";
    var traverse = module.exports = function(schema, opts, cb) {
      if (typeof opts == "function") {
        cb = opts;
        opts = {};
      }
      cb = opts.cb || cb;
      var pre = typeof cb == "function" ? cb : cb.pre || function() {
      };
      var post = cb.post || function() {
      };
      _traverse(opts, pre, post, schema, "", schema);
    };
    traverse.keywords = {
      additionalItems: true,
      items: true,
      contains: true,
      additionalProperties: true,
      propertyNames: true,
      not: true,
      if: true,
      then: true,
      else: true
    };
    traverse.arrayKeywords = {
      items: true,
      allOf: true,
      anyOf: true,
      oneOf: true
    };
    traverse.propsKeywords = {
      $defs: true,
      definitions: true,
      properties: true,
      patternProperties: true,
      dependencies: true
    };
    traverse.skipKeywords = {
      default: true,
      enum: true,
      const: true,
      required: true,
      maximum: true,
      minimum: true,
      exclusiveMaximum: true,
      exclusiveMinimum: true,
      multipleOf: true,
      maxLength: true,
      minLength: true,
      pattern: true,
      format: true,
      maxItems: true,
      minItems: true,
      uniqueItems: true,
      maxProperties: true,
      minProperties: true
    };
    function _traverse(opts, pre, post, schema, jsonPtr, rootSchema, parentJsonPtr, parentKeyword, parentSchema, keyIndex) {
      if (schema && typeof schema == "object" && !Array.isArray(schema)) {
        pre(schema, jsonPtr, rootSchema, parentJsonPtr, parentKeyword, parentSchema, keyIndex);
        for (var key in schema) {
          var sch = schema[key];
          if (Array.isArray(sch)) {
            if (key in traverse.arrayKeywords) {
              for (var i = 0; i < sch.length; i++)
                _traverse(opts, pre, post, sch[i], jsonPtr + "/" + key + "/" + i, rootSchema, jsonPtr, key, schema, i);
            }
          } else if (key in traverse.propsKeywords) {
            if (sch && typeof sch == "object") {
              for (var prop in sch)
                _traverse(opts, pre, post, sch[prop], jsonPtr + "/" + key + "/" + escapeJsonPtr(prop), rootSchema, jsonPtr, key, schema, prop);
            }
          } else if (key in traverse.keywords || opts.allKeys && !(key in traverse.skipKeywords)) {
            _traverse(opts, pre, post, sch, jsonPtr + "/" + key, rootSchema, jsonPtr, key, schema);
          }
        }
        post(schema, jsonPtr, rootSchema, parentJsonPtr, parentKeyword, parentSchema, keyIndex);
      }
    }
    function escapeJsonPtr(str3) {
      return str3.replace(/~/g, "~0").replace(/\//g, "~1");
    }
  }
});

// node_modules/ajv/dist/compile/resolve.js
var require_resolve = __commonJS({
  "node_modules/ajv/dist/compile/resolve.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.getSchemaRefs = exports.resolveUrl = exports.normalizeId = exports._getFullPath = exports.getFullPath = exports.inlineRef = void 0;
    var util_1 = require_util();
    var equal = require_fast_deep_equal();
    var traverse = require_json_schema_traverse();
    var SIMPLE_INLINED = /* @__PURE__ */ new Set([
      "type",
      "format",
      "pattern",
      "maxLength",
      "minLength",
      "maxProperties",
      "minProperties",
      "maxItems",
      "minItems",
      "maximum",
      "minimum",
      "uniqueItems",
      "multipleOf",
      "required",
      "enum",
      "const"
    ]);
    function inlineRef(schema, limit = true) {
      if (typeof schema == "boolean")
        return true;
      if (limit === true)
        return !hasRef(schema);
      if (!limit)
        return false;
      return countKeys(schema) <= limit;
    }
    exports.inlineRef = inlineRef;
    var REF_KEYWORDS = /* @__PURE__ */ new Set([
      "$ref",
      "$recursiveRef",
      "$recursiveAnchor",
      "$dynamicRef",
      "$dynamicAnchor"
    ]);
    function hasRef(schema) {
      for (const key in schema) {
        if (REF_KEYWORDS.has(key))
          return true;
        const sch = schema[key];
        if (Array.isArray(sch) && sch.some(hasRef))
          return true;
        if (typeof sch == "object" && hasRef(sch))
          return true;
      }
      return false;
    }
    function countKeys(schema) {
      let count = 0;
      for (const key in schema) {
        if (key === "$ref")
          return Infinity;
        count++;
        if (SIMPLE_INLINED.has(key))
          continue;
        if (typeof schema[key] == "object") {
          (0, util_1.eachItem)(schema[key], (sch) => count += countKeys(sch));
        }
        if (count === Infinity)
          return Infinity;
      }
      return count;
    }
    function getFullPath(resolver, id = "", normalize2) {
      if (normalize2 !== false)
        id = normalizeId(id);
      const p = resolver.parse(id);
      return _getFullPath(resolver, p);
    }
    exports.getFullPath = getFullPath;
    function _getFullPath(resolver, p) {
      const serialized = resolver.serialize(p);
      return serialized.split("#")[0] + "#";
    }
    exports._getFullPath = _getFullPath;
    var TRAILING_SLASH_HASH = /#\/?$/;
    function normalizeId(id) {
      return id ? id.replace(TRAILING_SLASH_HASH, "") : "";
    }
    exports.normalizeId = normalizeId;
    function resolveUrl(resolver, baseId, id) {
      id = normalizeId(id);
      return resolver.resolve(baseId, id);
    }
    exports.resolveUrl = resolveUrl;
    var ANCHOR = /^[a-z_][-a-z0-9._]*$/i;
    function getSchemaRefs(schema, baseId) {
      if (typeof schema == "boolean")
        return {};
      const { schemaId, uriResolver } = this.opts;
      const schId = normalizeId(schema[schemaId] || baseId);
      const baseIds = { "": schId };
      const pathPrefix = getFullPath(uriResolver, schId, false);
      const localRefs = {};
      const schemaRefs = /* @__PURE__ */ new Set();
      traverse(schema, { allKeys: true }, (sch, jsonPtr, _, parentJsonPtr) => {
        if (parentJsonPtr === void 0)
          return;
        const fullPath = pathPrefix + jsonPtr;
        let innerBaseId = baseIds[parentJsonPtr];
        if (typeof sch[schemaId] == "string")
          innerBaseId = addRef.call(this, sch[schemaId]);
        addAnchor.call(this, sch.$anchor);
        addAnchor.call(this, sch.$dynamicAnchor);
        baseIds[jsonPtr] = innerBaseId;
        function addRef(ref) {
          const _resolve = this.opts.uriResolver.resolve;
          ref = normalizeId(innerBaseId ? _resolve(innerBaseId, ref) : ref);
          if (schemaRefs.has(ref))
            throw ambiguos(ref);
          schemaRefs.add(ref);
          let schOrRef = this.refs[ref];
          if (typeof schOrRef == "string")
            schOrRef = this.refs[schOrRef];
          if (typeof schOrRef == "object") {
            checkAmbiguosRef(sch, schOrRef.schema, ref);
          } else if (ref !== normalizeId(fullPath)) {
            if (ref[0] === "#") {
              checkAmbiguosRef(sch, localRefs[ref], ref);
              localRefs[ref] = sch;
            } else {
              this.refs[ref] = fullPath;
            }
          }
          return ref;
        }
        function addAnchor(anchor2) {
          if (typeof anchor2 == "string") {
            if (!ANCHOR.test(anchor2))
              throw new Error(`invalid anchor "${anchor2}"`);
            addRef.call(this, `#${anchor2}`);
          }
        }
      });
      return localRefs;
      function checkAmbiguosRef(sch1, sch2, ref) {
        if (sch2 !== void 0 && !equal(sch1, sch2))
          throw ambiguos(ref);
      }
      function ambiguos(ref) {
        return new Error(`reference "${ref}" resolves to more than one schema`);
      }
    }
    exports.getSchemaRefs = getSchemaRefs;
  }
});

// node_modules/ajv/dist/compile/validate/index.js
var require_validate = __commonJS({
  "node_modules/ajv/dist/compile/validate/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.getData = exports.KeywordCxt = exports.validateFunctionCode = void 0;
    var boolSchema_1 = require_boolSchema();
    var dataType_1 = require_dataType();
    var applicability_1 = require_applicability();
    var dataType_2 = require_dataType();
    var defaults_1 = require_defaults();
    var keyword_1 = require_keyword();
    var subschema_1 = require_subschema();
    var codegen_1 = require_codegen();
    var names_1 = require_names();
    var resolve_1 = require_resolve();
    var util_1 = require_util();
    var errors_1 = require_errors();
    function validateFunctionCode(it) {
      if (isSchemaObj(it)) {
        checkKeywords(it);
        if (schemaCxtHasRules(it)) {
          topSchemaObjCode(it);
          return;
        }
      }
      validateFunction(it, () => (0, boolSchema_1.topBoolOrEmptySchema)(it));
    }
    exports.validateFunctionCode = validateFunctionCode;
    function validateFunction({ gen, validateName, schema, schemaEnv, opts }, body) {
      if (opts.code.es5) {
        gen.func(validateName, (0, codegen_1._)`${names_1.default.data}, ${names_1.default.valCxt}`, schemaEnv.$async, () => {
          gen.code((0, codegen_1._)`"use strict"; ${funcSourceUrl(schema, opts)}`);
          destructureValCxtES5(gen, opts);
          gen.code(body);
        });
      } else {
        gen.func(validateName, (0, codegen_1._)`${names_1.default.data}, ${destructureValCxt(opts)}`, schemaEnv.$async, () => gen.code(funcSourceUrl(schema, opts)).code(body));
      }
    }
    function destructureValCxt(opts) {
      return (0, codegen_1._)`{${names_1.default.instancePath}="", ${names_1.default.parentData}, ${names_1.default.parentDataProperty}, ${names_1.default.rootData}=${names_1.default.data}${opts.dynamicRef ? (0, codegen_1._)`, ${names_1.default.dynamicAnchors}={}` : codegen_1.nil}}={}`;
    }
    function destructureValCxtES5(gen, opts) {
      gen.if(names_1.default.valCxt, () => {
        gen.var(names_1.default.instancePath, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.instancePath}`);
        gen.var(names_1.default.parentData, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.parentData}`);
        gen.var(names_1.default.parentDataProperty, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.parentDataProperty}`);
        gen.var(names_1.default.rootData, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.rootData}`);
        if (opts.dynamicRef)
          gen.var(names_1.default.dynamicAnchors, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.dynamicAnchors}`);
      }, () => {
        gen.var(names_1.default.instancePath, (0, codegen_1._)`""`);
        gen.var(names_1.default.parentData, (0, codegen_1._)`undefined`);
        gen.var(names_1.default.parentDataProperty, (0, codegen_1._)`undefined`);
        gen.var(names_1.default.rootData, names_1.default.data);
        if (opts.dynamicRef)
          gen.var(names_1.default.dynamicAnchors, (0, codegen_1._)`{}`);
      });
    }
    function topSchemaObjCode(it) {
      const { schema, opts, gen } = it;
      validateFunction(it, () => {
        if (opts.$comment && schema.$comment)
          commentKeyword(it);
        checkNoDefault(it);
        gen.let(names_1.default.vErrors, null);
        gen.let(names_1.default.errors, 0);
        if (opts.unevaluated)
          resetEvaluated(it);
        typeAndKeywords(it);
        returnResults(it);
      });
      return;
    }
    function resetEvaluated(it) {
      const { gen, validateName } = it;
      it.evaluated = gen.const("evaluated", (0, codegen_1._)`${validateName}.evaluated`);
      gen.if((0, codegen_1._)`${it.evaluated}.dynamicProps`, () => gen.assign((0, codegen_1._)`${it.evaluated}.props`, (0, codegen_1._)`undefined`));
      gen.if((0, codegen_1._)`${it.evaluated}.dynamicItems`, () => gen.assign((0, codegen_1._)`${it.evaluated}.items`, (0, codegen_1._)`undefined`));
    }
    function funcSourceUrl(schema, opts) {
      const schId = typeof schema == "object" && schema[opts.schemaId];
      return schId && (opts.code.source || opts.code.process) ? (0, codegen_1._)`/*# sourceURL=${schId} */` : codegen_1.nil;
    }
    function subschemaCode(it, valid) {
      if (isSchemaObj(it)) {
        checkKeywords(it);
        if (schemaCxtHasRules(it)) {
          subSchemaObjCode(it, valid);
          return;
        }
      }
      (0, boolSchema_1.boolOrEmptySchema)(it, valid);
    }
    function schemaCxtHasRules({ schema, self }) {
      if (typeof schema == "boolean")
        return !schema;
      for (const key in schema)
        if (self.RULES.all[key])
          return true;
      return false;
    }
    function isSchemaObj(it) {
      return typeof it.schema != "boolean";
    }
    function subSchemaObjCode(it, valid) {
      const { schema, gen, opts } = it;
      if (opts.$comment && schema.$comment)
        commentKeyword(it);
      updateContext(it);
      checkAsyncSchema(it);
      const errsCount = gen.const("_errs", names_1.default.errors);
      typeAndKeywords(it, errsCount);
      gen.var(valid, (0, codegen_1._)`${errsCount} === ${names_1.default.errors}`);
    }
    function checkKeywords(it) {
      (0, util_1.checkUnknownRules)(it);
      checkRefsAndKeywords(it);
    }
    function typeAndKeywords(it, errsCount) {
      if (it.opts.jtd)
        return schemaKeywords(it, [], false, errsCount);
      const types = (0, dataType_1.getSchemaTypes)(it.schema);
      const checkedTypes = (0, dataType_1.coerceAndCheckDataType)(it, types);
      schemaKeywords(it, types, !checkedTypes, errsCount);
    }
    function checkRefsAndKeywords(it) {
      const { schema, errSchemaPath, opts, self } = it;
      if (schema.$ref && opts.ignoreKeywordsWithRef && (0, util_1.schemaHasRulesButRef)(schema, self.RULES)) {
        self.logger.warn(`$ref: keywords ignored in schema at path "${errSchemaPath}"`);
      }
    }
    function checkNoDefault(it) {
      const { schema, opts } = it;
      if (schema.default !== void 0 && opts.useDefaults && opts.strictSchema) {
        (0, util_1.checkStrictMode)(it, "default is ignored in the schema root");
      }
    }
    function updateContext(it) {
      const schId = it.schema[it.opts.schemaId];
      if (schId)
        it.baseId = (0, resolve_1.resolveUrl)(it.opts.uriResolver, it.baseId, schId);
    }
    function checkAsyncSchema(it) {
      if (it.schema.$async && !it.schemaEnv.$async)
        throw new Error("async schema in sync schema");
    }
    function commentKeyword({ gen, schemaEnv, schema, errSchemaPath, opts }) {
      const msg = schema.$comment;
      if (opts.$comment === true) {
        gen.code((0, codegen_1._)`${names_1.default.self}.logger.log(${msg})`);
      } else if (typeof opts.$comment == "function") {
        const schemaPath = (0, codegen_1.str)`${errSchemaPath}/$comment`;
        const rootName = gen.scopeValue("root", { ref: schemaEnv.root });
        gen.code((0, codegen_1._)`${names_1.default.self}.opts.$comment(${msg}, ${schemaPath}, ${rootName}.schema)`);
      }
    }
    function returnResults(it) {
      const { gen, schemaEnv, validateName, ValidationError, opts } = it;
      if (schemaEnv.$async) {
        gen.if((0, codegen_1._)`${names_1.default.errors} === 0`, () => gen.return(names_1.default.data), () => gen.throw((0, codegen_1._)`new ${ValidationError}(${names_1.default.vErrors})`));
      } else {
        gen.assign((0, codegen_1._)`${validateName}.errors`, names_1.default.vErrors);
        if (opts.unevaluated)
          assignEvaluated(it);
        gen.return((0, codegen_1._)`${names_1.default.errors} === 0`);
      }
    }
    function assignEvaluated({ gen, evaluated, props, items }) {
      if (props instanceof codegen_1.Name)
        gen.assign((0, codegen_1._)`${evaluated}.props`, props);
      if (items instanceof codegen_1.Name)
        gen.assign((0, codegen_1._)`${evaluated}.items`, items);
    }
    function schemaKeywords(it, types, typeErrors, errsCount) {
      const { gen, schema, data, allErrors, opts, self } = it;
      const { RULES } = self;
      if (schema.$ref && (opts.ignoreKeywordsWithRef || !(0, util_1.schemaHasRulesButRef)(schema, RULES))) {
        gen.block(() => keywordCode(it, "$ref", RULES.all.$ref.definition));
        return;
      }
      if (!opts.jtd)
        checkStrictTypes(it, types);
      gen.block(() => {
        for (const group of RULES.rules)
          groupKeywords(group);
        groupKeywords(RULES.post);
      });
      function groupKeywords(group) {
        if (!(0, applicability_1.shouldUseGroup)(schema, group))
          return;
        if (group.type) {
          gen.if((0, dataType_2.checkDataType)(group.type, data, opts.strictNumbers));
          iterateKeywords(it, group);
          if (types.length === 1 && types[0] === group.type && typeErrors) {
            gen.else();
            (0, dataType_2.reportTypeError)(it);
          }
          gen.endIf();
        } else {
          iterateKeywords(it, group);
        }
        if (!allErrors)
          gen.if((0, codegen_1._)`${names_1.default.errors} === ${errsCount || 0}`);
      }
    }
    function iterateKeywords(it, group) {
      const { gen, schema, opts: { useDefaults } } = it;
      if (useDefaults)
        (0, defaults_1.assignDefaults)(it, group.type);
      gen.block(() => {
        for (const rule of group.rules) {
          if ((0, applicability_1.shouldUseRule)(schema, rule)) {
            keywordCode(it, rule.keyword, rule.definition, group.type);
          }
        }
      });
    }
    function checkStrictTypes(it, types) {
      if (it.schemaEnv.meta || !it.opts.strictTypes)
        return;
      checkContextTypes(it, types);
      if (!it.opts.allowUnionTypes)
        checkMultipleTypes(it, types);
      checkKeywordTypes(it, it.dataTypes);
    }
    function checkContextTypes(it, types) {
      if (!types.length)
        return;
      if (!it.dataTypes.length) {
        it.dataTypes = types;
        return;
      }
      types.forEach((t) => {
        if (!includesType(it.dataTypes, t)) {
          strictTypesError(it, `type "${t}" not allowed by context "${it.dataTypes.join(",")}"`);
        }
      });
      narrowSchemaTypes(it, types);
    }
    function checkMultipleTypes(it, ts) {
      if (ts.length > 1 && !(ts.length === 2 && ts.includes("null"))) {
        strictTypesError(it, "use allowUnionTypes to allow union type keyword");
      }
    }
    function checkKeywordTypes(it, ts) {
      const rules = it.self.RULES.all;
      for (const keyword in rules) {
        const rule = rules[keyword];
        if (typeof rule == "object" && (0, applicability_1.shouldUseRule)(it.schema, rule)) {
          const { type } = rule.definition;
          if (type.length && !type.some((t) => hasApplicableType(ts, t))) {
            strictTypesError(it, `missing type "${type.join(",")}" for keyword "${keyword}"`);
          }
        }
      }
    }
    function hasApplicableType(schTs, kwdT) {
      return schTs.includes(kwdT) || kwdT === "number" && schTs.includes("integer");
    }
    function includesType(ts, t) {
      return ts.includes(t) || t === "integer" && ts.includes("number");
    }
    function narrowSchemaTypes(it, withTypes) {
      const ts = [];
      for (const t of it.dataTypes) {
        if (includesType(withTypes, t))
          ts.push(t);
        else if (withTypes.includes("integer") && t === "number")
          ts.push("integer");
      }
      it.dataTypes = ts;
    }
    function strictTypesError(it, msg) {
      const schemaPath = it.schemaEnv.baseId + it.errSchemaPath;
      msg += ` at "${schemaPath}" (strictTypes)`;
      (0, util_1.checkStrictMode)(it, msg, it.opts.strictTypes);
    }
    var KeywordCxt = class {
      constructor(it, def3, keyword) {
        (0, keyword_1.validateKeywordUsage)(it, def3, keyword);
        this.gen = it.gen;
        this.allErrors = it.allErrors;
        this.keyword = keyword;
        this.data = it.data;
        this.schema = it.schema[keyword];
        this.$data = def3.$data && it.opts.$data && this.schema && this.schema.$data;
        this.schemaValue = (0, util_1.schemaRefOrVal)(it, this.schema, keyword, this.$data);
        this.schemaType = def3.schemaType;
        this.parentSchema = it.schema;
        this.params = {};
        this.it = it;
        this.def = def3;
        if (this.$data) {
          this.schemaCode = it.gen.const("vSchema", getData(this.$data, it));
        } else {
          this.schemaCode = this.schemaValue;
          if (!(0, keyword_1.validSchemaType)(this.schema, def3.schemaType, def3.allowUndefined)) {
            throw new Error(`${keyword} value must be ${JSON.stringify(def3.schemaType)}`);
          }
        }
        if ("code" in def3 ? def3.trackErrors : def3.errors !== false) {
          this.errsCount = it.gen.const("_errs", names_1.default.errors);
        }
      }
      result(condition, successAction, failAction) {
        this.failResult((0, codegen_1.not)(condition), successAction, failAction);
      }
      failResult(condition, successAction, failAction) {
        this.gen.if(condition);
        if (failAction)
          failAction();
        else
          this.error();
        if (successAction) {
          this.gen.else();
          successAction();
          if (this.allErrors)
            this.gen.endIf();
        } else {
          if (this.allErrors)
            this.gen.endIf();
          else
            this.gen.else();
        }
      }
      pass(condition, failAction) {
        this.failResult((0, codegen_1.not)(condition), void 0, failAction);
      }
      fail(condition) {
        if (condition === void 0) {
          this.error();
          if (!this.allErrors)
            this.gen.if(false);
          return;
        }
        this.gen.if(condition);
        this.error();
        if (this.allErrors)
          this.gen.endIf();
        else
          this.gen.else();
      }
      fail$data(condition) {
        if (!this.$data)
          return this.fail(condition);
        const { schemaCode } = this;
        this.fail((0, codegen_1._)`${schemaCode} !== undefined && (${(0, codegen_1.or)(this.invalid$data(), condition)})`);
      }
      error(append, errorParams, errorPaths) {
        if (errorParams) {
          this.setParams(errorParams);
          this._error(append, errorPaths);
          this.setParams({});
          return;
        }
        this._error(append, errorPaths);
      }
      _error(append, errorPaths) {
        ;
        (append ? errors_1.reportExtraError : errors_1.reportError)(this, this.def.error, errorPaths);
      }
      $dataError() {
        (0, errors_1.reportError)(this, this.def.$dataError || errors_1.keyword$DataError);
      }
      reset() {
        if (this.errsCount === void 0)
          throw new Error('add "trackErrors" to keyword definition');
        (0, errors_1.resetErrorsCount)(this.gen, this.errsCount);
      }
      ok(cond) {
        if (!this.allErrors)
          this.gen.if(cond);
      }
      setParams(obj, assign) {
        if (assign)
          Object.assign(this.params, obj);
        else
          this.params = obj;
      }
      block$data(valid, codeBlock, $dataValid = codegen_1.nil) {
        this.gen.block(() => {
          this.check$data(valid, $dataValid);
          codeBlock();
        });
      }
      check$data(valid = codegen_1.nil, $dataValid = codegen_1.nil) {
        if (!this.$data)
          return;
        const { gen, schemaCode, schemaType, def: def3 } = this;
        gen.if((0, codegen_1.or)((0, codegen_1._)`${schemaCode} === undefined`, $dataValid));
        if (valid !== codegen_1.nil)
          gen.assign(valid, true);
        if (schemaType.length || def3.validateSchema) {
          gen.elseIf(this.invalid$data());
          this.$dataError();
          if (valid !== codegen_1.nil)
            gen.assign(valid, false);
        }
        gen.else();
      }
      invalid$data() {
        const { gen, schemaCode, schemaType, def: def3, it } = this;
        return (0, codegen_1.or)(wrong$DataType(), invalid$DataSchema());
        function wrong$DataType() {
          if (schemaType.length) {
            if (!(schemaCode instanceof codegen_1.Name))
              throw new Error("ajv implementation error");
            const st = Array.isArray(schemaType) ? schemaType : [schemaType];
            return (0, codegen_1._)`${(0, dataType_2.checkDataTypes)(st, schemaCode, it.opts.strictNumbers, dataType_2.DataType.Wrong)}`;
          }
          return codegen_1.nil;
        }
        function invalid$DataSchema() {
          if (def3.validateSchema) {
            const validateSchemaRef = gen.scopeValue("validate$data", { ref: def3.validateSchema });
            return (0, codegen_1._)`!${validateSchemaRef}(${schemaCode})`;
          }
          return codegen_1.nil;
        }
      }
      subschema(appl, valid) {
        const subschema = (0, subschema_1.getSubschema)(this.it, appl);
        (0, subschema_1.extendSubschemaData)(subschema, this.it, appl);
        (0, subschema_1.extendSubschemaMode)(subschema, appl);
        const nextContext = { ...this.it, ...subschema, items: void 0, props: void 0 };
        subschemaCode(nextContext, valid);
        return nextContext;
      }
      mergeEvaluated(schemaCxt, toName) {
        const { it, gen } = this;
        if (!it.opts.unevaluated)
          return;
        if (it.props !== true && schemaCxt.props !== void 0) {
          it.props = util_1.mergeEvaluated.props(gen, schemaCxt.props, it.props, toName);
        }
        if (it.items !== true && schemaCxt.items !== void 0) {
          it.items = util_1.mergeEvaluated.items(gen, schemaCxt.items, it.items, toName);
        }
      }
      mergeValidEvaluated(schemaCxt, valid) {
        const { it, gen } = this;
        if (it.opts.unevaluated && (it.props !== true || it.items !== true)) {
          gen.if(valid, () => this.mergeEvaluated(schemaCxt, codegen_1.Name));
          return true;
        }
      }
    };
    exports.KeywordCxt = KeywordCxt;
    function keywordCode(it, keyword, def3, ruleType) {
      const cxt = new KeywordCxt(it, def3, keyword);
      if ("code" in def3) {
        def3.code(cxt, ruleType);
      } else if (cxt.$data && def3.validate) {
        (0, keyword_1.funcKeywordCode)(cxt, def3);
      } else if ("macro" in def3) {
        (0, keyword_1.macroKeywordCode)(cxt, def3);
      } else if (def3.compile || def3.validate) {
        (0, keyword_1.funcKeywordCode)(cxt, def3);
      }
    }
    var JSON_POINTER = /^\/(?:[^~]|~0|~1)*$/;
    var RELATIVE_JSON_POINTER = /^([0-9]+)(#|\/(?:[^~]|~0|~1)*)?$/;
    function getData($data, { dataLevel, dataNames, dataPathArr }) {
      let jsonPointer;
      let data;
      if ($data === "")
        return names_1.default.rootData;
      if ($data[0] === "/") {
        if (!JSON_POINTER.test($data))
          throw new Error(`Invalid JSON-pointer: ${$data}`);
        jsonPointer = $data;
        data = names_1.default.rootData;
      } else {
        const matches = RELATIVE_JSON_POINTER.exec($data);
        if (!matches)
          throw new Error(`Invalid JSON-pointer: ${$data}`);
        const up = +matches[1];
        jsonPointer = matches[2];
        if (jsonPointer === "#") {
          if (up >= dataLevel)
            throw new Error(errorMsg("property/index", up));
          return dataPathArr[dataLevel - up];
        }
        if (up > dataLevel)
          throw new Error(errorMsg("data", up));
        data = dataNames[dataLevel - up];
        if (!jsonPointer)
          return data;
      }
      let expr = data;
      const segments = jsonPointer.split("/");
      for (const segment of segments) {
        if (segment) {
          data = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)((0, util_1.unescapeJsonPointer)(segment))}`;
          expr = (0, codegen_1._)`${expr} && ${data}`;
        }
      }
      return expr;
      function errorMsg(pointerType, up) {
        return `Cannot access ${pointerType} ${up} levels up, current level is ${dataLevel}`;
      }
    }
    exports.getData = getData;
  }
});

// node_modules/ajv/dist/runtime/validation_error.js
var require_validation_error = __commonJS({
  "node_modules/ajv/dist/runtime/validation_error.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var ValidationError = class extends Error {
      constructor(errors) {
        super("validation failed");
        this.errors = errors;
        this.ajv = this.validation = true;
      }
    };
    exports.default = ValidationError;
  }
});

// node_modules/ajv/dist/compile/ref_error.js
var require_ref_error = __commonJS({
  "node_modules/ajv/dist/compile/ref_error.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var resolve_1 = require_resolve();
    var MissingRefError = class extends Error {
      constructor(resolver, baseId, ref, msg) {
        super(msg || `can't resolve reference ${ref} from id ${baseId}`);
        this.missingRef = (0, resolve_1.resolveUrl)(resolver, baseId, ref);
        this.missingSchema = (0, resolve_1.normalizeId)((0, resolve_1.getFullPath)(resolver, this.missingRef));
      }
    };
    exports.default = MissingRefError;
  }
});

// node_modules/ajv/dist/compile/index.js
var require_compile = __commonJS({
  "node_modules/ajv/dist/compile/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.resolveSchema = exports.getCompilingSchema = exports.resolveRef = exports.compileSchema = exports.SchemaEnv = void 0;
    var codegen_1 = require_codegen();
    var validation_error_1 = require_validation_error();
    var names_1 = require_names();
    var resolve_1 = require_resolve();
    var util_1 = require_util();
    var validate_1 = require_validate();
    var SchemaEnv = class {
      constructor(env) {
        var _a3;
        this.refs = {};
        this.dynamicAnchors = {};
        let schema;
        if (typeof env.schema == "object")
          schema = env.schema;
        this.schema = env.schema;
        this.schemaId = env.schemaId;
        this.root = env.root || this;
        this.baseId = (_a3 = env.baseId) !== null && _a3 !== void 0 ? _a3 : (0, resolve_1.normalizeId)(schema === null || schema === void 0 ? void 0 : schema[env.schemaId || "$id"]);
        this.schemaPath = env.schemaPath;
        this.localRefs = env.localRefs;
        this.meta = env.meta;
        this.$async = schema === null || schema === void 0 ? void 0 : schema.$async;
        this.refs = {};
      }
    };
    exports.SchemaEnv = SchemaEnv;
    function compileSchema(sch) {
      const _sch = getCompilingSchema.call(this, sch);
      if (_sch)
        return _sch;
      const rootId = (0, resolve_1.getFullPath)(this.opts.uriResolver, sch.root.baseId);
      const { es5, lines } = this.opts.code;
      const { ownProperties } = this.opts;
      const gen = new codegen_1.CodeGen(this.scope, { es5, lines, ownProperties });
      let _ValidationError;
      if (sch.$async) {
        _ValidationError = gen.scopeValue("Error", {
          ref: validation_error_1.default,
          code: (0, codegen_1._)`require("ajv/dist/runtime/validation_error").default`
        });
      }
      const validateName = gen.scopeName("validate");
      sch.validateName = validateName;
      const schemaCxt = {
        gen,
        allErrors: this.opts.allErrors,
        data: names_1.default.data,
        parentData: names_1.default.parentData,
        parentDataProperty: names_1.default.parentDataProperty,
        dataNames: [names_1.default.data],
        dataPathArr: [codegen_1.nil],
        // TODO can its length be used as dataLevel if nil is removed?
        dataLevel: 0,
        dataTypes: [],
        definedProperties: /* @__PURE__ */ new Set(),
        topSchemaRef: gen.scopeValue("schema", this.opts.code.source === true ? { ref: sch.schema, code: (0, codegen_1.stringify)(sch.schema) } : { ref: sch.schema }),
        validateName,
        ValidationError: _ValidationError,
        schema: sch.schema,
        schemaEnv: sch,
        rootId,
        baseId: sch.baseId || rootId,
        schemaPath: codegen_1.nil,
        errSchemaPath: sch.schemaPath || (this.opts.jtd ? "" : "#"),
        errorPath: (0, codegen_1._)`""`,
        opts: this.opts,
        self: this
      };
      let sourceCode;
      try {
        this._compilations.add(sch);
        (0, validate_1.validateFunctionCode)(schemaCxt);
        gen.optimize(this.opts.code.optimize);
        const validateCode = gen.toString();
        sourceCode = `${gen.scopeRefs(names_1.default.scope)}return ${validateCode}`;
        if (this.opts.code.process)
          sourceCode = this.opts.code.process(sourceCode, sch);
        const makeValidate = new Function(`${names_1.default.self}`, `${names_1.default.scope}`, sourceCode);
        const validate2 = makeValidate(this, this.scope.get());
        this.scope.value(validateName, { ref: validate2 });
        validate2.errors = null;
        validate2.schema = sch.schema;
        validate2.schemaEnv = sch;
        if (sch.$async)
          validate2.$async = true;
        if (this.opts.code.source === true) {
          validate2.source = { validateName, validateCode, scopeValues: gen._values };
        }
        if (this.opts.unevaluated) {
          const { props, items } = schemaCxt;
          validate2.evaluated = {
            props: props instanceof codegen_1.Name ? void 0 : props,
            items: items instanceof codegen_1.Name ? void 0 : items,
            dynamicProps: props instanceof codegen_1.Name,
            dynamicItems: items instanceof codegen_1.Name
          };
          if (validate2.source)
            validate2.source.evaluated = (0, codegen_1.stringify)(validate2.evaluated);
        }
        sch.validate = validate2;
        return sch;
      } catch (e) {
        delete sch.validate;
        delete sch.validateName;
        if (sourceCode)
          this.logger.error("Error compiling schema, function code:", sourceCode);
        throw e;
      } finally {
        this._compilations.delete(sch);
      }
    }
    exports.compileSchema = compileSchema;
    function resolveRef(root, baseId, ref) {
      var _a3;
      ref = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, ref);
      const schOrFunc = root.refs[ref];
      if (schOrFunc)
        return schOrFunc;
      let _sch = resolve9.call(this, root, ref);
      if (_sch === void 0) {
        const schema = (_a3 = root.localRefs) === null || _a3 === void 0 ? void 0 : _a3[ref];
        const { schemaId } = this.opts;
        if (schema)
          _sch = new SchemaEnv({ schema, schemaId, root, baseId });
      }
      if (_sch === void 0)
        return;
      return root.refs[ref] = inlineOrCompile.call(this, _sch);
    }
    exports.resolveRef = resolveRef;
    function inlineOrCompile(sch) {
      if ((0, resolve_1.inlineRef)(sch.schema, this.opts.inlineRefs))
        return sch.schema;
      return sch.validate ? sch : compileSchema.call(this, sch);
    }
    function getCompilingSchema(schEnv) {
      for (const sch of this._compilations) {
        if (sameSchemaEnv(sch, schEnv))
          return sch;
      }
    }
    exports.getCompilingSchema = getCompilingSchema;
    function sameSchemaEnv(s1, s2) {
      return s1.schema === s2.schema && s1.root === s2.root && s1.baseId === s2.baseId;
    }
    function resolve9(root, ref) {
      let sch;
      while (typeof (sch = this.refs[ref]) == "string")
        ref = sch;
      return sch || this.schemas[ref] || resolveSchema.call(this, root, ref);
    }
    function resolveSchema(root, ref) {
      const p = this.opts.uriResolver.parse(ref);
      const refPath = (0, resolve_1._getFullPath)(this.opts.uriResolver, p);
      let baseId = (0, resolve_1.getFullPath)(this.opts.uriResolver, root.baseId, void 0);
      if (Object.keys(root.schema).length > 0 && refPath === baseId) {
        return getJsonPointer.call(this, p, root);
      }
      const id = (0, resolve_1.normalizeId)(refPath);
      const schOrRef = this.refs[id] || this.schemas[id];
      if (typeof schOrRef == "string") {
        const sch = resolveSchema.call(this, root, schOrRef);
        if (typeof (sch === null || sch === void 0 ? void 0 : sch.schema) !== "object")
          return;
        return getJsonPointer.call(this, p, sch);
      }
      if (typeof (schOrRef === null || schOrRef === void 0 ? void 0 : schOrRef.schema) !== "object")
        return;
      if (!schOrRef.validate)
        compileSchema.call(this, schOrRef);
      if (id === (0, resolve_1.normalizeId)(ref)) {
        const { schema } = schOrRef;
        const { schemaId } = this.opts;
        const schId = schema[schemaId];
        if (schId)
          baseId = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, schId);
        return new SchemaEnv({ schema, schemaId, root, baseId });
      }
      return getJsonPointer.call(this, p, schOrRef);
    }
    exports.resolveSchema = resolveSchema;
    var PREVENT_SCOPE_CHANGE = /* @__PURE__ */ new Set([
      "properties",
      "patternProperties",
      "enum",
      "dependencies",
      "definitions"
    ]);
    function getJsonPointer(parsedRef, { baseId, schema, root }) {
      var _a3;
      if (((_a3 = parsedRef.fragment) === null || _a3 === void 0 ? void 0 : _a3[0]) !== "/")
        return;
      for (const part of parsedRef.fragment.slice(1).split("/")) {
        if (typeof schema === "boolean")
          return;
        const partSchema = schema[(0, util_1.unescapeFragment)(part)];
        if (partSchema === void 0)
          return;
        schema = partSchema;
        const schId = typeof schema === "object" && schema[this.opts.schemaId];
        if (!PREVENT_SCOPE_CHANGE.has(part) && schId) {
          baseId = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, schId);
        }
      }
      let env;
      if (typeof schema != "boolean" && schema.$ref && !(0, util_1.schemaHasRulesButRef)(schema, this.RULES)) {
        const $ref = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, schema.$ref);
        env = resolveSchema.call(this, root, $ref);
      }
      const { schemaId } = this.opts;
      env = env || new SchemaEnv({ schema, schemaId, root, baseId });
      if (env.schema !== env.root.schema)
        return env;
      return void 0;
    }
  }
});

// node_modules/ajv/dist/refs/data.json
var require_data = __commonJS({
  "node_modules/ajv/dist/refs/data.json"(exports, module) {
    module.exports = {
      $id: "https://raw.githubusercontent.com/ajv-validator/ajv/master/lib/refs/data.json#",
      description: "Meta-schema for $data reference (JSON AnySchema extension proposal)",
      type: "object",
      required: ["$data"],
      properties: {
        $data: {
          type: "string",
          anyOf: [{ format: "relative-json-pointer" }, { format: "json-pointer" }]
        }
      },
      additionalProperties: false
    };
  }
});

// node_modules/fast-uri/lib/utils.js
var require_utils = __commonJS({
  "node_modules/fast-uri/lib/utils.js"(exports, module) {
    "use strict";
    var isUUID = RegExp.prototype.test.bind(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu);
    var isIPv4 = RegExp.prototype.test.bind(/^(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)$/u);
    var isPort = RegExp.prototype.test.bind(/^\d*$/u);
    var isHexPair = RegExp.prototype.test.bind(/^[\da-f]{2}$/iu);
    var isUnreserved = RegExp.prototype.test.bind(/^[\da-z\-._~]$/iu);
    var isPathCharacter = RegExp.prototype.test.bind(/^[A-Za-z0-9\-._~!$&'()*+,;=:@/]$/u);
    var isQueryFragmentCharacter = RegExp.prototype.test.bind(/^[A-Za-z0-9\-._~!$&'()*+,;=:@/?]$/u);
    var isUserinfoCharacter = RegExp.prototype.test.bind(/^[A-Za-z0-9\-._~!$&'()*+,;=:]$/u);
    var BYTE_HEX = new Array(256);
    {
      const HEX_DIGITS = "0123456789ABCDEF";
      for (let i = 0; i < 256; i++) {
        BYTE_HEX[i] = "%" + HEX_DIGITS[i >> 4] + HEX_DIGITS[i & 15];
      }
    }
    function percentEncodeNonAscii(cp) {
      if (cp < 2048) {
        return BYTE_HEX[192 | cp >> 6] + BYTE_HEX[128 | cp & 63];
      }
      if (cp < 65536) {
        return BYTE_HEX[224 | cp >> 12] + BYTE_HEX[128 | cp >> 6 & 63] + BYTE_HEX[128 | cp & 63];
      }
      return BYTE_HEX[240 | cp >> 18] + BYTE_HEX[128 | cp >> 12 & 63] + BYTE_HEX[128 | cp >> 6 & 63] + BYTE_HEX[128 | cp & 63];
    }
    function stringArrayToHexStripped(input) {
      let acc = "";
      let code = 0;
      let i = 0;
      for (i = 0; i < input.length; i++) {
        code = input[i].charCodeAt(0);
        if (code === 48) {
          continue;
        }
        if (!(code >= 48 && code <= 57 || code >= 65 && code <= 70 || code >= 97 && code <= 102)) {
          return "";
        }
        acc += input[i];
        break;
      }
      for (i += 1; i < input.length; i++) {
        code = input[i].charCodeAt(0);
        if (!(code >= 48 && code <= 57 || code >= 65 && code <= 70 || code >= 97 && code <= 102)) {
          return "";
        }
        acc += input[i];
      }
      return acc;
    }
    var isHextet = RegExp.prototype.test.bind(/^[\dA-Fa-f]{1,4}$/);
    var isIPvFuture = RegExp.prototype.test.bind(/^[vV][\dA-Fa-f]+\.[A-Za-z\d\-._~!$&'()*+,;=:]+$/);
    var isZoneCharacter = RegExp.prototype.test.bind(/^[A-Za-z\d\-._~]$/);
    var nonSimpleDomain = RegExp.prototype.test.bind(/[^!"$&'()*+,\-.;=_`a-z{}~]/u);
    function isZoneIdentifier(zone) {
      if (zone.length === 0) return false;
      for (let i = 0; i < zone.length; i++) {
        if (isZoneCharacter(zone[i])) continue;
        if (zone[i] === "%" && i + 2 < zone.length && isHexPair(zone.slice(i + 1, i + 3))) {
          i += 2;
          continue;
        }
        return false;
      }
      return true;
    }
    function compressIPv6ZeroRun(hextets) {
      let bestStart = -1;
      let bestLength = 0;
      let runStart = -1;
      let runLength = 0;
      for (let i = 0; i < hextets.length; i++) {
        if (hextets[i] === "0") {
          if (runStart === -1) runStart = i;
          runLength++;
          if (runLength > bestLength) {
            bestLength = runLength;
            bestStart = runStart;
          }
        } else {
          runStart = -1;
          runLength = 0;
        }
      }
      if (bestLength < 2) return hextets.join(":");
      const head = hextets.slice(0, bestStart).join(":");
      const tail = hextets.slice(bestStart + bestLength).join(":");
      return head + "::" + tail;
    }
    function normalizeIPv6Address(input) {
      const compression = input.indexOf("::");
      if (compression !== -1 && input.indexOf("::", compression + 1) !== -1) return void 0;
      const left = compression === -1 ? input.split(":") : input.slice(0, compression).split(":");
      const right = compression === -1 ? [] : input.slice(compression + 2).split(":");
      if (compression !== -1) {
        if (left.length === 1 && left[0] === "") left.length = 0;
        if (right.length === 1 && right[0] === "") right.length = 0;
      }
      const parts = left.concat(right);
      let hextetCount = 0;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part === "") return void 0;
        if (part.indexOf(".") !== -1) {
          if (i !== parts.length - 1 || compression !== -1 && right.length === 0 || !isIPv4(part)) return void 0;
          hextetCount += 2;
          continue;
        }
        if (!isHextet(part)) return void 0;
        parts[i] = parseInt(part, 16).toString(16);
        hextetCount++;
      }
      if (compression === -1) {
        if (hextetCount !== 8) return void 0;
        return compressIPv6ZeroRun(parts);
      }
      if (hextetCount >= 8) return void 0;
      const expanded = parts.slice(0, left.length);
      for (let i = hextetCount; i < 8; i++) expanded.push("0");
      for (let i = left.length; i < parts.length; i++) expanded.push(parts[i]);
      return compressIPv6ZeroRun(expanded);
    }
    function normalizeIPv6(host) {
      const bracketed = host[0] === "[" && host[host.length - 1] === "]";
      const hasBracket = host[0] === "[" || host[host.length - 1] === "]";
      if (hasBracket && !bracketed) return { host, isIPV6: false, error: true };
      let input = bracketed ? host.slice(1, -1) : host;
      if (bracketed && isIPvFuture(input)) {
        input = input.toLowerCase();
        return { host: `[${input}]`, escapedHost: input, isIPV6: false, isIPVFuture: true };
      }
      if (findToken(input, ":") < 2) {
        return { host, isIPV6: false, error: bracketed };
      }
      let zoneIdentifier = "";
      const zoneSeparator = input.indexOf("%");
      if (zoneSeparator !== -1) {
        const separatorLength = input.slice(zoneSeparator, zoneSeparator + 3).toLowerCase() === "%25" ? 3 : 1;
        zoneIdentifier = input.slice(zoneSeparator + separatorLength);
        if (!isZoneIdentifier(zoneIdentifier)) return { host, isIPV6: false, error: true };
        input = input.slice(0, zoneSeparator);
      }
      const address = normalizeIPv6Address(input);
      if (address === void 0) return { host, isIPV6: false, error: true };
      return {
        host: address + (zoneIdentifier ? "%" + zoneIdentifier : ""),
        escapedHost: address + (zoneIdentifier ? "%25" + zoneIdentifier : ""),
        isIPV6: true
      };
    }
    function findToken(str3, token) {
      let ind = 0;
      for (let i = 0; i < str3.length; i++) {
        if (str3[i] === token) ind++;
      }
      return ind;
    }
    function removeDotSegments(path) {
      let input = path;
      const output = [];
      let nextSlash = -1;
      let len = 0;
      while (len = input.length) {
        if (len === 1) {
          if (input === ".") {
            break;
          } else if (input === "/") {
            output.push("/");
            break;
          } else {
            output.push(input);
            break;
          }
        } else if (len === 2) {
          if (input[0] === ".") {
            if (input[1] === ".") {
              break;
            } else if (input[1] === "/") {
              input = input.slice(2);
              continue;
            }
          } else if (input[0] === "/") {
            if (input[1] === "." || input[1] === "/") {
              output.push("/");
              break;
            }
          }
        } else if (len === 3) {
          if (input === "/..") {
            if (output.length !== 0) {
              output.pop();
            }
            output.push("/");
            break;
          }
        }
        if (input[0] === ".") {
          if (input[1] === ".") {
            if (input[2] === "/") {
              input = input.slice(3);
              continue;
            }
          } else if (input[1] === "/") {
            input = input.slice(2);
            continue;
          }
        } else if (input[0] === "/") {
          if (input[1] === ".") {
            if (input[2] === "/") {
              input = input.slice(2);
              continue;
            } else if (input[2] === ".") {
              if (input[3] === "/") {
                input = input.slice(3);
                if (output.length !== 0) {
                  output.pop();
                }
                continue;
              }
            }
          }
        }
        if ((nextSlash = input.indexOf("/", 1)) === -1) {
          output.push(input);
          break;
        } else {
          output.push(input.slice(0, nextSlash));
          input = input.slice(nextSlash);
        }
      }
      return output.join("");
    }
    var HOST_DELIMS = { "@": "%40", "/": "%2F", "?": "%3F", "#": "%23", ":": "%3A" };
    var HOST_DELIM_RE = /[@/?#:]/g;
    var HOST_DELIM_NO_COLON_RE = /[@/?#]/g;
    function reescapeHostDelimiters(host, isIP) {
      const re = isIP ? HOST_DELIM_NO_COLON_RE : HOST_DELIM_RE;
      re.lastIndex = 0;
      return host.replace(re, (ch) => HOST_DELIMS[ch]);
    }
    function normalizePercentEncoding(input, decodeUnreserved = false) {
      if (input.indexOf("%") === -1) {
        return input;
      }
      let output = "";
      for (let i = 0; i < input.length; i++) {
        if (input[i] === "%" && i + 2 < input.length) {
          const hex = input.slice(i + 1, i + 3);
          if (isHexPair(hex)) {
            const normalizedHex = hex.toUpperCase();
            const decoded = String.fromCharCode(parseInt(normalizedHex, 16));
            if (decodeUnreserved && isUnreserved(decoded)) {
              output += decoded;
            } else {
              output += "%" + normalizedHex;
            }
            i += 2;
            continue;
          }
        }
        output += input[i];
      }
      return output;
    }
    function normalizePathEncoding(input) {
      let output = "";
      for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (ch === "%" && i + 2 < input.length) {
          const hex = input.slice(i + 1, i + 3);
          if (isHexPair(hex)) {
            const normalizedHex = hex.toUpperCase();
            const decoded = String.fromCharCode(parseInt(normalizedHex, 16));
            if (decoded !== "." && isUnreserved(decoded)) {
              output += decoded;
            } else {
              output += "%" + normalizedHex;
            }
            i += 2;
            continue;
          }
        }
        if (isPathCharacter(ch)) {
          output += ch;
        } else {
          const code = input.charCodeAt(i);
          if (code < 128) {
            output += isEscapeSafe(code) ? ch : BYTE_HEX[code];
          } else if (code < 55296 || code > 57343) {
            output += percentEncodeNonAscii(code);
          } else if (code <= 56319 && i + 1 < input.length) {
            const low = input.charCodeAt(i + 1);
            if (low >= 56320 && low <= 57343) {
              output += percentEncodeNonAscii(65536 + (code - 55296 << 10) + (low - 56320));
              i++;
            } else {
              output += percentEncodeNonAscii(65533);
            }
          } else {
            output += percentEncodeNonAscii(65533);
          }
        }
      }
      return output;
    }
    function serializePathEncoding(input, pathNoScheme = false) {
      let output = "";
      let firstSegment = pathNoScheme && input[0] !== "/";
      for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (ch === "%" && i + 2 < input.length) {
          const hex = input.slice(i + 1, i + 3);
          if (isHexPair(hex)) {
            output += "%" + hex.toUpperCase();
            i += 2;
            continue;
          }
        }
        if (ch === "/") {
          firstSegment = false;
        }
        if (isPathCharacter(ch) && (ch !== ":" || !firstSegment)) {
          output += ch;
        } else {
          const code = input.charCodeAt(i);
          if (code < 128) {
            output += BYTE_HEX[code];
          } else if (code < 55296 || code > 57343) {
            output += percentEncodeNonAscii(code);
          } else if (code <= 56319 && i + 1 < input.length) {
            const low = input.charCodeAt(i + 1);
            if (low >= 56320 && low <= 57343) {
              output += percentEncodeNonAscii(65536 + (code - 55296 << 10) + (low - 56320));
              i++;
            } else {
              output += percentEncodeNonAscii(65533);
            }
          } else {
            output += percentEncodeNonAscii(65533);
          }
        }
      }
      return output;
    }
    function encodeComponent(input, isAllowed) {
      let output = "";
      for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (ch === "%" && i + 2 < input.length) {
          const hex = input.slice(i + 1, i + 3);
          if (isHexPair(hex)) {
            output += "%" + hex.toUpperCase();
            i += 2;
            continue;
          }
        }
        if (isAllowed(ch)) {
          output += ch;
        } else {
          const code = input.charCodeAt(i);
          if (code < 128) {
            output += BYTE_HEX[code];
          } else if (code < 55296 || code > 57343) {
            output += percentEncodeNonAscii(code);
          } else if (code <= 56319 && i + 1 < input.length) {
            const low = input.charCodeAt(i + 1);
            if (low >= 56320 && low <= 57343) {
              output += percentEncodeNonAscii(65536 + (code - 55296 << 10) + (low - 56320));
              i++;
            } else {
              output += percentEncodeNonAscii(65533);
            }
          } else {
            output += percentEncodeNonAscii(65533);
          }
        }
      }
      return output;
    }
    function encodeUserinfo(input) {
      return encodeComponent(input, isUserinfoCharacter);
    }
    function encodeQuery(input) {
      return encodeComponent(input, isQueryFragmentCharacter);
    }
    function encodeFragment(input) {
      return encodeComponent(input, isQueryFragmentCharacter);
    }
    function isEscapeSafe(cp) {
      return cp >= 48 && cp <= 57 || cp >= 65 && cp <= 90 || cp >= 97 && cp <= 122 || cp === 42 || cp === 43 || cp === 45 || cp === 46 || cp === 47 || cp === 64 || cp === 95;
    }
    function normalizeQueryFragmentEncoding(input) {
      let output = "";
      for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (ch === "%" && i + 2 < input.length) {
          const hex = input.slice(i + 1, i + 3);
          if (isHexPair(hex)) {
            const normalizedHex = hex.toUpperCase();
            const decoded = String.fromCharCode(parseInt(normalizedHex, 16));
            if (isUnreserved(decoded)) {
              output += decoded;
            } else {
              output += "%" + normalizedHex;
            }
            i += 2;
            continue;
          }
        }
        if (isQueryFragmentCharacter(ch)) {
          output += ch;
        } else {
          const code = input.charCodeAt(i);
          if (code < 128) {
            output += isEscapeSafe(code) ? ch : BYTE_HEX[code];
          } else if (code < 55296 || code > 57343) {
            output += percentEncodeNonAscii(code);
          } else if (code <= 56319 && i + 1 < input.length) {
            const low = input.charCodeAt(i + 1);
            if (low >= 56320 && low <= 57343) {
              output += percentEncodeNonAscii(65536 + (code - 55296 << 10) + (low - 56320));
              i++;
            } else {
              output += percentEncodeNonAscii(65533);
            }
          } else {
            output += percentEncodeNonAscii(65533);
          }
        }
      }
      return output;
    }
    function escapePreservingEscapes(input) {
      let output = "";
      for (let i = 0; i < input.length; i++) {
        if (input[i] === "%" && i + 2 < input.length) {
          const hex = input.slice(i + 1, i + 3);
          if (isHexPair(hex)) {
            output += "%" + hex.toUpperCase();
            i += 2;
            continue;
          }
        }
        output += escape(input[i]);
      }
      return output;
    }
    function recomposeAuthority(component) {
      const uriTokens = [];
      if (component.userinfo !== void 0) {
        uriTokens.push(encodeUserinfo(component.userinfo));
        uriTokens.push("@");
      }
      if (component.host !== void 0) {
        let host = component.host;
        if (!isIPv4(host)) {
          let ipV6res = normalizeIPv6(host);
          if (ipV6res.isIPV6 !== true && ipV6res.isIPVFuture !== true) {
            host = normalizePercentEncoding(host, true);
            ipV6res = normalizeIPv6(host);
          }
          if (ipV6res.isIPV6 === true || ipV6res.isIPVFuture === true) {
            host = `[${ipV6res.escapedHost}]`;
          } else {
            host = reescapeHostDelimiters(host, false);
          }
        }
        uriTokens.push(host);
      }
      if (typeof component.port === "number" || typeof component.port === "string") {
        const port = String(component.port);
        if (!isPort(port)) {
          throw new TypeError("URI port is malformed.");
        }
        uriTokens.push(":");
        uriTokens.push(port);
      }
      return uriTokens.length ? uriTokens.join("") : void 0;
    }
    module.exports = {
      nonSimpleDomain,
      recomposeAuthority,
      reescapeHostDelimiters,
      normalizePercentEncoding,
      normalizePathEncoding,
      serializePathEncoding,
      normalizeQueryFragmentEncoding,
      encodeUserinfo,
      encodeQuery,
      encodeFragment,
      escapePreservingEscapes,
      removeDotSegments,
      isIPv4,
      isUUID,
      normalizeIPv6,
      stringArrayToHexStripped
    };
  }
});

// node_modules/fast-uri/lib/schemes.js
var require_schemes = __commonJS({
  "node_modules/fast-uri/lib/schemes.js"(exports, module) {
    "use strict";
    var { isUUID } = require_utils();
    var URN_REG = /^([\da-z][\d\-a-z]{0,31}):((?:[\w!$'()*+,\-./:;=@]|%[\da-f]{2})+)$/iu;
    var supportedSchemeNames = (
      /** @type {const} */
      [
        "http",
        "https",
        "ws",
        "wss",
        "urn",
        "urn:uuid"
      ]
    );
    function isValidSchemeName(name) {
      return supportedSchemeNames.indexOf(
        /** @type {*} */
        name
      ) !== -1;
    }
    function wsIsSecure(wsComponent) {
      if (wsComponent.secure === true) {
        return true;
      } else if (wsComponent.secure === false) {
        return false;
      } else if (wsComponent.scheme) {
        return wsComponent.scheme.length === 3 && (wsComponent.scheme[0] === "w" || wsComponent.scheme[0] === "W") && (wsComponent.scheme[1] === "s" || wsComponent.scheme[1] === "S") && (wsComponent.scheme[2] === "s" || wsComponent.scheme[2] === "S");
      } else {
        return false;
      }
    }
    function httpParse(component) {
      if (!component.host) {
        component.error = component.error || "HTTP URIs must have a host.";
      }
      return component;
    }
    function httpSerialize(component) {
      const secure = String(component.scheme).toLowerCase() === "https";
      if (component.port === (secure ? 443 : 80) || component.port === "") {
        component.port = void 0;
      }
      if (!component.path) {
        component.path = "/";
      }
      return component;
    }
    function wsParse(wsComponent) {
      wsComponent.secure = wsIsSecure(wsComponent);
      wsComponent.resourceName = (wsComponent.path || "/") + (wsComponent.query ? "?" + wsComponent.query : "");
      wsComponent.path = void 0;
      wsComponent.query = void 0;
      return wsComponent;
    }
    function wsSerialize(wsComponent) {
      if (wsComponent.port === (wsIsSecure(wsComponent) ? 443 : 80) || wsComponent.port === "") {
        wsComponent.port = void 0;
      }
      if (typeof wsComponent.secure === "boolean") {
        wsComponent.scheme = wsComponent.secure ? "wss" : "ws";
        wsComponent.secure = void 0;
      }
      if (wsComponent.resourceName) {
        const queryIndex = wsComponent.resourceName.indexOf("?");
        const path = queryIndex === -1 ? wsComponent.resourceName : wsComponent.resourceName.slice(0, queryIndex);
        wsComponent.path = path && path !== "/" ? path : void 0;
        wsComponent.query = queryIndex === -1 ? void 0 : wsComponent.resourceName.slice(queryIndex + 1);
        wsComponent.resourceName = void 0;
      }
      wsComponent.fragment = void 0;
      return wsComponent;
    }
    function urnParse(urnComponent, options) {
      if (!urnComponent.path) {
        urnComponent.error = "URN can not be parsed";
        return urnComponent;
      }
      const matches = urnComponent.path.match(URN_REG);
      if (matches && matches[0] === urnComponent.path) {
        const scheme = options.scheme || urnComponent.scheme || "urn";
        urnComponent.nid = matches[1].toLowerCase();
        urnComponent.nss = matches[2];
        const urnScheme = `${scheme}:${options.nid || urnComponent.nid}`;
        const schemeHandler = getSchemeHandler(urnScheme);
        urnComponent.path = void 0;
        if (schemeHandler) {
          urnComponent = schemeHandler.parse(urnComponent, options);
        }
      } else {
        urnComponent.error = urnComponent.error || "URN can not be parsed.";
      }
      return urnComponent;
    }
    function urnSerialize(urnComponent, options) {
      if (urnComponent.nid === void 0) {
        throw new Error("URN without nid cannot be serialized");
      }
      const scheme = options.scheme || urnComponent.scheme || "urn";
      const nid = urnComponent.nid.toLowerCase();
      const urnScheme = `${scheme}:${options.nid || nid}`;
      const schemeHandler = getSchemeHandler(urnScheme);
      if (schemeHandler) {
        urnComponent = schemeHandler.serialize(urnComponent, options);
      }
      const uriComponent = urnComponent;
      const nss = urnComponent.nss;
      uriComponent.path = `${nid || options.nid}:${nss}`;
      options.skipEscape = true;
      return uriComponent;
    }
    function urnuuidParse(urnComponent, options) {
      const uuidComponent = urnComponent;
      uuidComponent.uuid = uuidComponent.nss;
      uuidComponent.nss = void 0;
      if (!options.tolerant && (!uuidComponent.uuid || !isUUID(uuidComponent.uuid))) {
        uuidComponent.error = uuidComponent.error || "UUID is not valid.";
      }
      return uuidComponent;
    }
    function urnuuidSerialize(uuidComponent) {
      const urnComponent = uuidComponent;
      urnComponent.nss = (uuidComponent.uuid || "").toLowerCase();
      return urnComponent;
    }
    var http = (
      /** @type {SchemeHandler} */
      {
        scheme: "http",
        domainHost: true,
        parse: httpParse,
        serialize: httpSerialize
      }
    );
    var https = (
      /** @type {SchemeHandler} */
      {
        scheme: "https",
        domainHost: http.domainHost,
        parse: httpParse,
        serialize: httpSerialize
      }
    );
    var ws = (
      /** @type {SchemeHandler} */
      {
        scheme: "ws",
        domainHost: true,
        parse: wsParse,
        serialize: wsSerialize
      }
    );
    var wss = (
      /** @type {SchemeHandler} */
      {
        scheme: "wss",
        domainHost: ws.domainHost,
        parse: ws.parse,
        serialize: ws.serialize
      }
    );
    var urn = (
      /** @type {SchemeHandler} */
      {
        scheme: "urn",
        parse: urnParse,
        serialize: urnSerialize,
        skipNormalize: true
      }
    );
    var urnuuid = (
      /** @type {SchemeHandler} */
      {
        scheme: "urn:uuid",
        parse: urnuuidParse,
        serialize: urnuuidSerialize,
        skipNormalize: true
      }
    );
    var SCHEMES = (
      /** @type {Record<SchemeName, SchemeHandler>} */
      {
        http,
        https,
        ws,
        wss,
        urn,
        "urn:uuid": urnuuid
      }
    );
    Object.setPrototypeOf(SCHEMES, null);
    function getSchemeHandler(scheme) {
      return scheme && (SCHEMES[
        /** @type {SchemeName} */
        scheme
      ] || SCHEMES[
        /** @type {SchemeName} */
        scheme.toLowerCase()
      ]) || void 0;
    }
    module.exports = {
      wsIsSecure,
      SCHEMES,
      isValidSchemeName,
      getSchemeHandler
    };
  }
});

// node_modules/fast-uri/index.js
var require_fast_uri = __commonJS({
  "node_modules/fast-uri/index.js"(exports, module) {
    "use strict";
    var { normalizeIPv6, removeDotSegments, recomposeAuthority, normalizePercentEncoding, normalizePathEncoding, serializePathEncoding, normalizeQueryFragmentEncoding, encodeQuery, encodeFragment, reescapeHostDelimiters, isIPv4, nonSimpleDomain } = require_utils();
    var { SCHEMES, getSchemeHandler } = require_schemes();
    var VALID_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*$/u;
    var MALFORMED_SCHEME_ERROR = "URI scheme is malformed.";
    function decodeValidScheme(scheme) {
      const decodedScheme = unescape(String(scheme));
      if (!VALID_SCHEME.test(decodedScheme)) {
        throw new TypeError(MALFORMED_SCHEME_ERROR);
      }
      return decodedScheme;
    }
    function normalize2(uri, options) {
      if (typeof uri === "string") {
        uri = /** @type {T} */
        normalizeString(uri, options);
      } else if (typeof uri === "object") {
        uri = /** @type {T} */
        parse4(serialize(uri, options), options);
      }
      return uri;
    }
    function resolve9(baseURI, relativeURI, options) {
      const schemelessOptions = options ? Object.assign({ scheme: "null" }, options) : { scheme: "null" };
      const {
        parsed: baseParsed,
        malformedAuthorityOrPort: baseMalformed,
        malformedPercentEncoding: baseMalformedPercentEncoding,
        malformedSchemeSpecific: baseMalformedSchemeSpecific,
        malformedHost: baseMalformedHost,
        malformedScheme: baseMalformedScheme
      } = parseWithStatus(baseURI, schemelessOptions);
      const {
        parsed: relativeParsed,
        malformedAuthorityOrPort: relativeMalformed,
        malformedPercentEncoding: relativeMalformedPercentEncoding,
        malformedSchemeSpecific: relativeMalformedSchemeSpecific,
        malformedHost: relativeMalformedHost,
        malformedScheme: relativeMalformedScheme
      } = parseWithStatus(relativeURI, schemelessOptions);
      if (baseMalformed || relativeMalformed || baseMalformedPercentEncoding || relativeMalformedPercentEncoding || baseMalformedSchemeSpecific || relativeMalformedSchemeSpecific || baseMalformedHost || relativeMalformedHost || baseMalformedScheme || relativeMalformedScheme) {
        throw new Error(baseParsed.error || relativeParsed.error || "URI is malformed.");
      }
      const resolved = resolveComponent(baseParsed, relativeParsed, schemelessOptions, true);
      const resolvedSchemeHandler = getSchemeHandler(options && options.scheme || resolved.scheme);
      const resolvedHost = resolved.host;
      const resolvedHostIsIP = resolvedHost !== void 0 && resolvedHost !== "" && (isIPv4(resolvedHost) || normalizeIPv6(resolvedHost).isIPV6);
      canonicalizeHost(resolved, options || {}, resolvedSchemeHandler, resolvedHostIsIP);
      const encodedASCIIHost = resolvedHost && resolvedHost.indexOf("%") !== -1 && !new RegExp("\\P{ASCII}", "u").test(resolvedHost);
      if (resolved.error && !encodedASCIIHost) {
        throw new Error(resolved.error);
      }
      schemelessOptions.skipEscape = true;
      return serialize(resolved, schemelessOptions);
    }
    function resolveComponent(base, relative2, options, skipNormalization) {
      const target = {};
      if (!skipNormalization) {
        base = parse4(serialize(base, options), options);
        relative2 = parse4(serialize(relative2, options), options);
      }
      options = options || {};
      if (!options.tolerant && relative2.scheme) {
        target.scheme = relative2.scheme;
        target.userinfo = relative2.userinfo;
        target.host = relative2.host;
        target.port = relative2.port;
        target.path = removeDotSegments(relative2.path || "");
        target.query = relative2.query;
      } else {
        if (relative2.userinfo !== void 0 || relative2.host !== void 0 || relative2.port !== void 0) {
          target.userinfo = relative2.userinfo;
          target.host = relative2.host;
          target.port = relative2.port;
          target.path = removeDotSegments(relative2.path || "");
          target.query = relative2.query;
        } else {
          if (!relative2.path) {
            target.path = base.path;
            if (relative2.query !== void 0) {
              target.query = relative2.query;
            } else {
              target.query = base.query;
            }
          } else {
            if (relative2.path[0] === "/") {
              target.path = removeDotSegments(relative2.path);
            } else {
              if ((base.userinfo !== void 0 || base.host !== void 0 || base.port !== void 0) && !base.path) {
                target.path = "/" + relative2.path;
              } else if (!base.path) {
                target.path = relative2.path;
              } else {
                target.path = base.path.slice(0, base.path.lastIndexOf("/") + 1) + relative2.path;
              }
              target.path = removeDotSegments(target.path);
            }
            target.query = relative2.query;
          }
          target.userinfo = base.userinfo;
          target.host = base.host;
          target.port = base.port;
        }
        target.scheme = base.scheme;
      }
      target.fragment = relative2.fragment;
      return target;
    }
    function equal(uriA, uriB, options) {
      const normalizedA = normalizeComparableURI(uriA, options);
      const normalizedB = normalizeComparableURI(uriB, options);
      return normalizedA !== void 0 && normalizedB !== void 0 && normalizedA === normalizedB;
    }
    function serialize(cmpts, opts) {
      const component = {
        host: cmpts.host,
        scheme: cmpts.scheme,
        userinfo: cmpts.userinfo,
        port: cmpts.port,
        path: cmpts.path,
        query: cmpts.query,
        nid: cmpts.nid,
        nss: cmpts.nss,
        uuid: cmpts.uuid,
        fragment: cmpts.fragment,
        reference: cmpts.reference,
        resourceName: cmpts.resourceName,
        secure: cmpts.secure,
        error: ""
      };
      const options = Object.assign({}, opts);
      const uriTokens = [];
      if (component.scheme) {
        component.scheme = decodeValidScheme(component.scheme);
      }
      const schemeHandler = getSchemeHandler(options.scheme || component.scheme);
      if (schemeHandler && schemeHandler.serialize) schemeHandler.serialize(component, options);
      const hasAuthority = component.userinfo !== void 0 || component.host !== void 0 || component.port !== void 0;
      const pathNoScheme = !options.skipEscape && component.scheme === void 0 && !hasAuthority;
      if (component.path !== void 0) {
        if (!options.skipEscape) {
          component.path = serializePathEncoding(component.path, pathNoScheme);
        } else {
          component.path = normalizePercentEncoding(component.path);
        }
      }
      if (options.reference !== "suffix" && component.scheme) {
        component.scheme = decodeValidScheme(component.scheme);
        uriTokens.push(component.scheme, ":");
      }
      const authority = recomposeAuthority(component);
      if (authority !== void 0) {
        if (options.reference !== "suffix") {
          uriTokens.push("//");
        }
        uriTokens.push(authority);
        if (component.path && component.path[0] !== "/") {
          uriTokens.push("/");
        }
      }
      if (component.path !== void 0) {
        let s = component.path;
        if (!options.absolutePath && (!schemeHandler || !schemeHandler.absolutePath)) {
          s = removeDotSegments(s);
        }
        if (pathNoScheme) {
          s = serializePathEncoding(s, true);
        }
        if (authority === void 0 && s[0] === "/" && s[1] === "/") {
          s = "/%2F" + s.slice(2);
        }
        uriTokens.push(s);
      }
      if (component.query !== void 0) {
        uriTokens.push("?", encodeQuery(component.query));
      }
      if (component.fragment !== void 0) {
        uriTokens.push("#", encodeFragment(component.fragment));
      }
      return uriTokens.join("");
    }
    var URI_PARSE = /^(?:([^#/:?]+):)?(?:\/\/((?:([^#/?@]*)@)?(\[[^#/?\]]+\]|[^#/:?]*)(?::(\d*))?))?([^#?]*)(?:\?([^#]*))?(?:#((?:.|[\n\r])*))?/u;
    var AUTHORITY_PREFIX = /^(?:[^#/:?]+:)?\/\/([^/?#]*)/;
    var AUTHORITY_INTRODUCER_REGION = /^(?:[^#/:?]+:)?([/\\\t\n\r]*)/;
    function getParseError(parsed, matches) {
      if (matches[2] !== void 0 && parsed.path && parsed.path[0] !== "/") {
        return 'URI path must start with "/" when authority is present.';
      }
      if (typeof parsed.port === "number" && (parsed.port < 0 || parsed.port > 65535)) {
        return "URI port is malformed.";
      }
      return void 0;
    }
    function hasMalformedPercentEncoding(component) {
      if (component === void 0) return false;
      let percent = component.indexOf("%");
      while (percent !== -1) {
        if (percent + 2 >= component.length || !/^[\da-f]{2}$/iu.test(component.slice(percent + 1, percent + 3))) {
          return true;
        }
        percent = component.indexOf("%", percent + 3);
      }
      return false;
    }
    function isIPLiteral(host) {
      return host[0] === "[" && host[host.length - 1] === "]";
    }
    function hasMalformedComponentPercentEncoding(matches) {
      const host = matches[4];
      return hasMalformedPercentEncoding(matches[3]) || host !== void 0 && !isIPLiteral(host) && hasMalformedPercentEncoding(host) || hasMalformedPercentEncoding(matches[6]) || hasMalformedPercentEncoding(matches[7]) || hasMalformedPercentEncoding(matches[8]);
    }
    function canonicalizeHost(parsed, options, schemeHandler, isIP) {
      if (!options.unicodeSupport && (!schemeHandler || !schemeHandler.unicodeSupport) && parsed.host && !isIPLiteral(parsed.host) && (options.domainHost || schemeHandler && schemeHandler.domainHost) && isIP === false && nonSimpleDomain(parsed.host)) {
        try {
          parsed.host = new URL("http://" + parsed.host).hostname;
        } catch (e) {
          parsed.error = parsed.error || "Host's domain name can not be converted to ASCII: " + e;
          return true;
        }
      }
      return false;
    }
    function parseWithStatus(uri, opts) {
      const options = Object.assign({}, opts);
      const parsed = {
        scheme: void 0,
        userinfo: void 0,
        host: "",
        port: void 0,
        path: "",
        query: void 0,
        fragment: void 0
      };
      let malformedAuthorityOrPort = false;
      let malformedPercentEncoding = false;
      let malformedSchemeSpecific = false;
      let malformedHost = false;
      let malformedIPLiteral = false;
      let malformedScheme = false;
      let isIP = false;
      if (options.reference === "suffix") {
        if (options.scheme) {
          uri = options.scheme + ":" + uri;
        } else {
          uri = "//" + uri;
        }
      }
      const authorityMatch = uri.match(AUTHORITY_PREFIX);
      if (authorityMatch !== null && authorityMatch[1].indexOf("\\") !== -1) {
        parsed.error = "URI authority must not contain a literal backslash.";
        malformedAuthorityOrPort = true;
      }
      const introducerMatch = uri.match(AUTHORITY_INTRODUCER_REGION);
      if (introducerMatch !== null) {
        const region = introducerMatch[1];
        const normalizedRegion = region.replace(/[\t\n\r]/g, "");
        if (normalizedRegion.length >= 2) {
          if (normalizedRegion.slice(0, 2) !== "//") {
            parsed.error = parsed.error || "URI authority must not contain a literal backslash.";
            malformedAuthorityOrPort = true;
          } else if (region.length !== normalizedRegion.length) {
            parsed.error = parsed.error || "URI authority introducer must not contain whitespace.";
            malformedAuthorityOrPort = true;
          }
        }
      }
      const matches = uri.match(URI_PARSE);
      if (matches) {
        parsed.scheme = matches[1];
        parsed.userinfo = matches[3];
        parsed.host = matches[4];
        parsed.port = parseInt(matches[5], 10);
        parsed.path = matches[6] || "";
        parsed.query = matches[7];
        parsed.fragment = matches[8];
        if (parsed.scheme !== void 0) {
          const decodedScheme = unescape(parsed.scheme);
          if (VALID_SCHEME.test(decodedScheme)) {
            parsed.scheme = decodedScheme.toLowerCase();
          } else {
            parsed.error = parsed.error || MALFORMED_SCHEME_ERROR;
            malformedScheme = true;
          }
        }
        malformedPercentEncoding = hasMalformedComponentPercentEncoding(matches);
        if (malformedPercentEncoding) {
          parsed.error = parsed.error || "URI contains malformed percent-encoding.";
        }
        if (isNaN(parsed.port)) {
          parsed.port = matches[5];
        }
        const parseError = getParseError(parsed, matches);
        if (parseError !== void 0) {
          parsed.error = parsed.error || parseError;
          malformedAuthorityOrPort = true;
        }
        if (parsed.host) {
          const ipv4result = isIPv4(parsed.host);
          if (ipv4result === false) {
            const bracketedIPLiteral = isIPLiteral(parsed.host);
            const hasIPLiteralBracket = parsed.host.indexOf("[") !== -1 || parsed.host.indexOf("]") !== -1;
            const ipv6result = normalizeIPv6(parsed.host);
            isIP = ipv6result.isIPV6 || ipv6result.isIPVFuture === true;
            malformedIPLiteral = hasIPLiteralBracket && (!bracketedIPLiteral || ipv6result.error === true);
            parsed.host = isIP ? ipv6result.host : ipv6result.host.toLowerCase();
            if (malformedIPLiteral) {
              parsed.error = parsed.error || "URI host is malformed.";
              malformedAuthorityOrPort = true;
            }
          } else {
            isIP = true;
          }
        }
        if (parsed.scheme === void 0 && parsed.userinfo === void 0 && parsed.host === void 0 && parsed.port === void 0 && parsed.query === void 0 && !parsed.path) {
          parsed.reference = "same-document";
        } else if (parsed.scheme === void 0) {
          parsed.reference = "relative";
        } else if (parsed.fragment === void 0) {
          parsed.reference = "absolute";
        } else {
          parsed.reference = "uri";
        }
        if (options.reference && options.reference !== "suffix" && options.reference !== parsed.reference) {
          parsed.error = parsed.error || "URI is not a " + options.reference + " reference.";
        }
        const schemeHandler = getSchemeHandler(options.scheme || parsed.scheme);
        if (!malformedIPLiteral) {
          malformedHost = canonicalizeHost(parsed, options, schemeHandler, isIP);
        }
        if (uri.indexOf("%") !== -1 && parsed.host !== void 0 && !malformedIPLiteral) {
          let host = isIP ? parsed.host : normalizePercentEncoding(parsed.host, true);
          if (!isIP) {
            host = normalizePercentEncoding(host.toLowerCase());
          }
          parsed.host = reescapeHostDelimiters(host, isIP);
        }
        if (!schemeHandler || schemeHandler && !schemeHandler.skipNormalize) {
          if (parsed.path) {
            parsed.path = normalizePathEncoding(parsed.path);
          }
          if (parsed.query) {
            parsed.query = normalizeQueryFragmentEncoding(parsed.query);
          }
          if (parsed.fragment) {
            parsed.fragment = normalizeQueryFragmentEncoding(parsed.fragment);
          }
        }
        if (schemeHandler && schemeHandler.parse) {
          schemeHandler.parse(parsed, options);
          if (schemeHandler === SCHEMES.urn && parsed.nid === void 0) {
            malformedSchemeSpecific = true;
          }
        }
      } else {
        parsed.error = parsed.error || "URI can not be parsed.";
      }
      return { parsed, malformedAuthorityOrPort, malformedPercentEncoding, malformedSchemeSpecific, malformedHost, malformedScheme };
    }
    function parse4(uri, opts) {
      return parseWithStatus(uri, opts).parsed;
    }
    function normalizeString(uri, opts) {
      return normalizeStringWithStatus(uri, opts).normalized;
    }
    function normalizeStringWithStatus(uri, opts) {
      const { parsed, malformedAuthorityOrPort, malformedPercentEncoding, malformedSchemeSpecific, malformedHost, malformedScheme } = parseWithStatus(uri, opts);
      return {
        normalized: malformedAuthorityOrPort || malformedPercentEncoding || malformedSchemeSpecific || malformedHost || malformedScheme ? uri : serialize(parsed, opts),
        malformedAuthorityOrPort,
        malformedPercentEncoding,
        malformedSchemeSpecific,
        malformedHost,
        malformedScheme
      };
    }
    function normalizeComparableURI(uri, opts) {
      if (typeof uri !== "string" && typeof uri !== "object") {
        return void 0;
      }
      let value;
      try {
        value = typeof uri === "string" ? uri : serialize(uri, opts);
      } catch {
        return void 0;
      }
      const { normalized, malformedAuthorityOrPort, malformedPercentEncoding, malformedSchemeSpecific, malformedHost, malformedScheme } = normalizeStringWithStatus(value, opts);
      return malformedAuthorityOrPort || malformedPercentEncoding || malformedSchemeSpecific || malformedHost || malformedScheme ? void 0 : normalized;
    }
    var fastUri = {
      SCHEMES,
      normalize: normalize2,
      resolve: resolve9,
      resolveComponent,
      equal,
      serialize,
      parse: parse4
    };
    module.exports = fastUri;
    module.exports.default = fastUri;
    module.exports.fastUri = fastUri;
  }
});

// node_modules/ajv/dist/runtime/uri.js
var require_uri = __commonJS({
  "node_modules/ajv/dist/runtime/uri.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var uri = require_fast_uri();
    uri.code = 'require("ajv/dist/runtime/uri").default';
    exports.default = uri;
  }
});

// node_modules/ajv/dist/core.js
var require_core = __commonJS({
  "node_modules/ajv/dist/core.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.CodeGen = exports.Name = exports.nil = exports.stringify = exports.str = exports._ = exports.KeywordCxt = void 0;
    var validate_1 = require_validate();
    Object.defineProperty(exports, "KeywordCxt", { enumerable: true, get: function() {
      return validate_1.KeywordCxt;
    } });
    var codegen_1 = require_codegen();
    Object.defineProperty(exports, "_", { enumerable: true, get: function() {
      return codegen_1._;
    } });
    Object.defineProperty(exports, "str", { enumerable: true, get: function() {
      return codegen_1.str;
    } });
    Object.defineProperty(exports, "stringify", { enumerable: true, get: function() {
      return codegen_1.stringify;
    } });
    Object.defineProperty(exports, "nil", { enumerable: true, get: function() {
      return codegen_1.nil;
    } });
    Object.defineProperty(exports, "Name", { enumerable: true, get: function() {
      return codegen_1.Name;
    } });
    Object.defineProperty(exports, "CodeGen", { enumerable: true, get: function() {
      return codegen_1.CodeGen;
    } });
    var validation_error_1 = require_validation_error();
    var ref_error_1 = require_ref_error();
    var rules_1 = require_rules();
    var compile_1 = require_compile();
    var codegen_2 = require_codegen();
    var resolve_1 = require_resolve();
    var dataType_1 = require_dataType();
    var util_1 = require_util();
    var $dataRefSchema = require_data();
    var uri_1 = require_uri();
    var defaultRegExp = (str3, flags) => new RegExp(str3, flags);
    defaultRegExp.code = "new RegExp";
    var META_IGNORE_OPTIONS = ["removeAdditional", "useDefaults", "coerceTypes"];
    var EXT_SCOPE_NAMES = /* @__PURE__ */ new Set([
      "validate",
      "serialize",
      "parse",
      "wrapper",
      "root",
      "schema",
      "keyword",
      "pattern",
      "formats",
      "validate$data",
      "func",
      "obj",
      "Error"
    ]);
    var removedOptions = {
      errorDataPath: "",
      format: "`validateFormats: false` can be used instead.",
      nullable: '"nullable" keyword is supported by default.',
      jsonPointers: "Deprecated jsPropertySyntax can be used instead.",
      extendRefs: "Deprecated ignoreKeywordsWithRef can be used instead.",
      missingRefs: "Pass empty schema with $id that should be ignored to ajv.addSchema.",
      processCode: "Use option `code: {process: (code, schemaEnv: object) => string}`",
      sourceCode: "Use option `code: {source: true}`",
      strictDefaults: "It is default now, see option `strict`.",
      strictKeywords: "It is default now, see option `strict`.",
      uniqueItems: '"uniqueItems" keyword is always validated.',
      unknownFormats: "Disable strict mode or pass `true` to `ajv.addFormat` (or `formats` option).",
      cache: "Map is used as cache, schema object as key.",
      serialize: "Map is used as cache, schema object as key.",
      ajvErrors: "It is default now."
    };
    var deprecatedOptions = {
      ignoreKeywordsWithRef: "",
      jsPropertySyntax: "",
      unicode: '"minLength"/"maxLength" account for unicode characters by default.'
    };
    var MAX_EXPRESSION = 200;
    function requiredOptions(o) {
      var _a3, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0;
      const s = o.strict;
      const _optz = (_a3 = o.code) === null || _a3 === void 0 ? void 0 : _a3.optimize;
      const optimize = _optz === true || _optz === void 0 ? 1 : _optz || 0;
      const regExp = (_c = (_b = o.code) === null || _b === void 0 ? void 0 : _b.regExp) !== null && _c !== void 0 ? _c : defaultRegExp;
      const uriResolver = (_d = o.uriResolver) !== null && _d !== void 0 ? _d : uri_1.default;
      return {
        strictSchema: (_f = (_e = o.strictSchema) !== null && _e !== void 0 ? _e : s) !== null && _f !== void 0 ? _f : true,
        strictNumbers: (_h = (_g = o.strictNumbers) !== null && _g !== void 0 ? _g : s) !== null && _h !== void 0 ? _h : true,
        strictTypes: (_k = (_j = o.strictTypes) !== null && _j !== void 0 ? _j : s) !== null && _k !== void 0 ? _k : "log",
        strictTuples: (_m = (_l = o.strictTuples) !== null && _l !== void 0 ? _l : s) !== null && _m !== void 0 ? _m : "log",
        strictRequired: (_p = (_o = o.strictRequired) !== null && _o !== void 0 ? _o : s) !== null && _p !== void 0 ? _p : false,
        code: o.code ? { ...o.code, optimize, regExp } : { optimize, regExp },
        loopRequired: (_q = o.loopRequired) !== null && _q !== void 0 ? _q : MAX_EXPRESSION,
        loopEnum: (_r = o.loopEnum) !== null && _r !== void 0 ? _r : MAX_EXPRESSION,
        meta: (_s = o.meta) !== null && _s !== void 0 ? _s : true,
        messages: (_t = o.messages) !== null && _t !== void 0 ? _t : true,
        inlineRefs: (_u = o.inlineRefs) !== null && _u !== void 0 ? _u : true,
        schemaId: (_v = o.schemaId) !== null && _v !== void 0 ? _v : "$id",
        addUsedSchema: (_w = o.addUsedSchema) !== null && _w !== void 0 ? _w : true,
        validateSchema: (_x = o.validateSchema) !== null && _x !== void 0 ? _x : true,
        validateFormats: (_y = o.validateFormats) !== null && _y !== void 0 ? _y : true,
        unicodeRegExp: (_z = o.unicodeRegExp) !== null && _z !== void 0 ? _z : true,
        int32range: (_0 = o.int32range) !== null && _0 !== void 0 ? _0 : true,
        uriResolver
      };
    }
    var Ajv2 = class {
      constructor(opts = {}) {
        this.schemas = {};
        this.refs = {};
        this.formats = /* @__PURE__ */ Object.create(null);
        this._compilations = /* @__PURE__ */ new Set();
        this._loading = {};
        this._cache = /* @__PURE__ */ new Map();
        opts = this.opts = { ...opts, ...requiredOptions(opts) };
        const { es5, lines } = this.opts.code;
        this.scope = new codegen_2.ValueScope({ scope: {}, prefixes: EXT_SCOPE_NAMES, es5, lines });
        this.logger = getLogger(opts.logger);
        const formatOpt = opts.validateFormats;
        opts.validateFormats = false;
        this.RULES = (0, rules_1.getRules)();
        checkOptions.call(this, removedOptions, opts, "NOT SUPPORTED");
        checkOptions.call(this, deprecatedOptions, opts, "DEPRECATED", "warn");
        this._metaOpts = getMetaSchemaOptions.call(this);
        if (opts.formats)
          addInitialFormats.call(this);
        this._addVocabularies();
        this._addDefaultMetaSchema();
        if (opts.keywords)
          addInitialKeywords.call(this, opts.keywords);
        if (typeof opts.meta == "object")
          this.addMetaSchema(opts.meta);
        addInitialSchemas.call(this);
        opts.validateFormats = formatOpt;
      }
      _addVocabularies() {
        this.addKeyword("$async");
      }
      _addDefaultMetaSchema() {
        const { $data, meta: meta2, schemaId } = this.opts;
        let _dataRefSchema = $dataRefSchema;
        if (schemaId === "id") {
          _dataRefSchema = { ...$dataRefSchema };
          _dataRefSchema.id = _dataRefSchema.$id;
          delete _dataRefSchema.$id;
        }
        if (meta2 && $data)
          this.addMetaSchema(_dataRefSchema, _dataRefSchema[schemaId], false);
      }
      defaultMeta() {
        const { meta: meta2, schemaId } = this.opts;
        return this.opts.defaultMeta = typeof meta2 == "object" ? meta2[schemaId] || meta2 : void 0;
      }
      validate(schemaKeyRef, data) {
        let v;
        if (typeof schemaKeyRef == "string") {
          v = this.getSchema(schemaKeyRef);
          if (!v)
            throw new Error(`no schema with key or ref "${schemaKeyRef}"`);
        } else {
          v = this.compile(schemaKeyRef);
        }
        const valid = v(data);
        if (!("$async" in v))
          this.errors = v.errors;
        return valid;
      }
      compile(schema, _meta) {
        const sch = this._addSchema(schema, _meta);
        return sch.validate || this._compileSchemaEnv(sch);
      }
      compileAsync(schema, meta2) {
        if (typeof this.opts.loadSchema != "function") {
          throw new Error("options.loadSchema should be a function");
        }
        const { loadSchema } = this.opts;
        return runCompileAsync.call(this, schema, meta2);
        async function runCompileAsync(_schema, _meta) {
          await loadMetaSchema.call(this, _schema.$schema);
          const sch = this._addSchema(_schema, _meta);
          return sch.validate || _compileAsync.call(this, sch);
        }
        async function loadMetaSchema($ref) {
          if ($ref && !this.getSchema($ref)) {
            await runCompileAsync.call(this, { $ref }, true);
          }
        }
        async function _compileAsync(sch) {
          try {
            return this._compileSchemaEnv(sch);
          } catch (e) {
            if (!(e instanceof ref_error_1.default))
              throw e;
            checkLoaded.call(this, e);
            await loadMissingSchema.call(this, e.missingSchema);
            return _compileAsync.call(this, sch);
          }
        }
        function checkLoaded({ missingSchema: ref, missingRef }) {
          if (this.refs[ref]) {
            throw new Error(`AnySchema ${ref} is loaded but ${missingRef} cannot be resolved`);
          }
        }
        async function loadMissingSchema(ref) {
          const _schema = await _loadSchema.call(this, ref);
          if (!this.refs[ref])
            await loadMetaSchema.call(this, _schema.$schema);
          if (!this.refs[ref])
            this.addSchema(_schema, ref, meta2);
        }
        async function _loadSchema(ref) {
          const p = this._loading[ref];
          if (p)
            return p;
          try {
            return await (this._loading[ref] = loadSchema(ref));
          } finally {
            delete this._loading[ref];
          }
        }
      }
      // Adds schema to the instance
      addSchema(schema, key, _meta, _validateSchema = this.opts.validateSchema) {
        if (Array.isArray(schema)) {
          for (const sch of schema)
            this.addSchema(sch, void 0, _meta, _validateSchema);
          return this;
        }
        let id;
        if (typeof schema === "object") {
          const { schemaId } = this.opts;
          id = schema[schemaId];
          if (id !== void 0 && typeof id != "string") {
            throw new Error(`schema ${schemaId} must be string`);
          }
        }
        key = (0, resolve_1.normalizeId)(key || id);
        this._checkUnique(key);
        this.schemas[key] = this._addSchema(schema, _meta, key, _validateSchema, true);
        return this;
      }
      // Add schema that will be used to validate other schemas
      // options in META_IGNORE_OPTIONS are alway set to false
      addMetaSchema(schema, key, _validateSchema = this.opts.validateSchema) {
        this.addSchema(schema, key, true, _validateSchema);
        return this;
      }
      //  Validate schema against its meta-schema
      validateSchema(schema, throwOrLogError) {
        if (typeof schema == "boolean")
          return true;
        let $schema;
        $schema = schema.$schema;
        if ($schema !== void 0 && typeof $schema != "string") {
          throw new Error("$schema must be a string");
        }
        $schema = $schema || this.opts.defaultMeta || this.defaultMeta();
        if (!$schema) {
          this.logger.warn("meta-schema not available");
          this.errors = null;
          return true;
        }
        const valid = this.validate($schema, schema);
        if (!valid && throwOrLogError) {
          const message = "schema is invalid: " + this.errorsText();
          if (this.opts.validateSchema === "log")
            this.logger.error(message);
          else
            throw new Error(message);
        }
        return valid;
      }
      // Get compiled schema by `key` or `ref`.
      // (`key` that was passed to `addSchema` or full schema reference - `schema.$id` or resolved id)
      getSchema(keyRef) {
        let sch;
        while (typeof (sch = getSchEnv.call(this, keyRef)) == "string")
          keyRef = sch;
        if (sch === void 0) {
          const { schemaId } = this.opts;
          const root = new compile_1.SchemaEnv({ schema: {}, schemaId });
          sch = compile_1.resolveSchema.call(this, root, keyRef);
          if (!sch)
            return;
          this.refs[keyRef] = sch;
        }
        return sch.validate || this._compileSchemaEnv(sch);
      }
      // Remove cached schema(s).
      // If no parameter is passed all schemas but meta-schemas are removed.
      // If RegExp is passed all schemas with key/id matching pattern but meta-schemas are removed.
      // Even if schema is referenced by other schemas it still can be removed as other schemas have local references.
      removeSchema(schemaKeyRef) {
        if (schemaKeyRef instanceof RegExp) {
          this._removeAllSchemas(this.schemas, schemaKeyRef);
          this._removeAllSchemas(this.refs, schemaKeyRef);
          return this;
        }
        switch (typeof schemaKeyRef) {
          case "undefined":
            this._removeAllSchemas(this.schemas);
            this._removeAllSchemas(this.refs);
            this._cache.clear();
            return this;
          case "string": {
            const sch = getSchEnv.call(this, schemaKeyRef);
            if (typeof sch == "object")
              this._cache.delete(sch.schema);
            delete this.schemas[schemaKeyRef];
            delete this.refs[schemaKeyRef];
            return this;
          }
          case "object": {
            const cacheKey = schemaKeyRef;
            this._cache.delete(cacheKey);
            let id = schemaKeyRef[this.opts.schemaId];
            if (id) {
              id = (0, resolve_1.normalizeId)(id);
              delete this.schemas[id];
              delete this.refs[id];
            }
            return this;
          }
          default:
            throw new Error("ajv.removeSchema: invalid parameter");
        }
      }
      // add "vocabulary" - a collection of keywords
      addVocabulary(definitions) {
        for (const def3 of definitions)
          this.addKeyword(def3);
        return this;
      }
      addKeyword(kwdOrDef, def3) {
        let keyword;
        if (typeof kwdOrDef == "string") {
          keyword = kwdOrDef;
          if (typeof def3 == "object") {
            this.logger.warn("these parameters are deprecated, see docs for addKeyword");
            def3.keyword = keyword;
          }
        } else if (typeof kwdOrDef == "object" && def3 === void 0) {
          def3 = kwdOrDef;
          keyword = def3.keyword;
          if (Array.isArray(keyword) && !keyword.length) {
            throw new Error("addKeywords: keyword must be string or non-empty array");
          }
        } else {
          throw new Error("invalid addKeywords parameters");
        }
        checkKeyword.call(this, keyword, def3);
        if (!def3) {
          (0, util_1.eachItem)(keyword, (kwd) => addRule.call(this, kwd));
          return this;
        }
        keywordMetaschema.call(this, def3);
        const definition = {
          ...def3,
          type: (0, dataType_1.getJSONTypes)(def3.type),
          schemaType: (0, dataType_1.getJSONTypes)(def3.schemaType)
        };
        (0, util_1.eachItem)(keyword, definition.type.length === 0 ? (k) => addRule.call(this, k, definition) : (k) => definition.type.forEach((t) => addRule.call(this, k, definition, t)));
        return this;
      }
      getKeyword(keyword) {
        const rule = this.RULES.all[keyword];
        return typeof rule == "object" ? rule.definition : !!rule;
      }
      // Remove keyword
      removeKeyword(keyword) {
        const { RULES } = this;
        delete RULES.keywords[keyword];
        delete RULES.all[keyword];
        for (const group of RULES.rules) {
          const i = group.rules.findIndex((rule) => rule.keyword === keyword);
          if (i >= 0)
            group.rules.splice(i, 1);
        }
        return this;
      }
      // Add format
      addFormat(name, format) {
        if (typeof format == "string")
          format = new RegExp(format);
        this.formats[name] = format;
        return this;
      }
      errorsText(errors = this.errors, { separator = ", ", dataVar = "data" } = {}) {
        if (!errors || errors.length === 0)
          return "No errors";
        return errors.map((e) => `${dataVar}${e.instancePath} ${e.message}`).reduce((text, msg) => text + separator + msg);
      }
      $dataMetaSchema(metaSchema, keywordsJsonPointers) {
        const rules = this.RULES.all;
        metaSchema = JSON.parse(JSON.stringify(metaSchema));
        for (const jsonPointer of keywordsJsonPointers) {
          const segments = jsonPointer.split("/").slice(1);
          let keywords = metaSchema;
          for (const seg of segments)
            keywords = keywords[seg];
          for (const key in rules) {
            const rule = rules[key];
            if (typeof rule != "object")
              continue;
            const { $data } = rule.definition;
            const schema = keywords[key];
            if ($data && schema)
              keywords[key] = schemaOrData(schema);
          }
        }
        return metaSchema;
      }
      _removeAllSchemas(schemas, regex) {
        for (const keyRef in schemas) {
          const sch = schemas[keyRef];
          if (!regex || regex.test(keyRef)) {
            if (typeof sch == "string") {
              delete schemas[keyRef];
            } else if (sch && !sch.meta) {
              this._cache.delete(sch.schema);
              delete schemas[keyRef];
            }
          }
        }
      }
      _addSchema(schema, meta2, baseId, validateSchema = this.opts.validateSchema, addSchema = this.opts.addUsedSchema) {
        let id;
        const { schemaId } = this.opts;
        if (typeof schema == "object") {
          id = schema[schemaId];
        } else {
          if (this.opts.jtd)
            throw new Error("schema must be object");
          else if (typeof schema != "boolean")
            throw new Error("schema must be object or boolean");
        }
        let sch = this._cache.get(schema);
        if (sch !== void 0)
          return sch;
        baseId = (0, resolve_1.normalizeId)(id || baseId);
        const localRefs = resolve_1.getSchemaRefs.call(this, schema, baseId);
        sch = new compile_1.SchemaEnv({ schema, schemaId, meta: meta2, baseId, localRefs });
        this._cache.set(sch.schema, sch);
        if (addSchema && !baseId.startsWith("#")) {
          if (baseId)
            this._checkUnique(baseId);
          this.refs[baseId] = sch;
        }
        if (validateSchema)
          this.validateSchema(schema, true);
        return sch;
      }
      _checkUnique(id) {
        if (this.schemas[id] || this.refs[id]) {
          throw new Error(`schema with key or id "${id}" already exists`);
        }
      }
      _compileSchemaEnv(sch) {
        if (sch.meta)
          this._compileMetaSchema(sch);
        else
          compile_1.compileSchema.call(this, sch);
        if (!sch.validate)
          throw new Error("ajv implementation error");
        return sch.validate;
      }
      _compileMetaSchema(sch) {
        const currentOpts = this.opts;
        this.opts = this._metaOpts;
        try {
          compile_1.compileSchema.call(this, sch);
        } finally {
          this.opts = currentOpts;
        }
      }
    };
    Ajv2.ValidationError = validation_error_1.default;
    Ajv2.MissingRefError = ref_error_1.default;
    exports.default = Ajv2;
    function checkOptions(checkOpts, options, msg, log2 = "error") {
      for (const key in checkOpts) {
        const opt = key;
        if (opt in options)
          this.logger[log2](`${msg}: option ${key}. ${checkOpts[opt]}`);
      }
    }
    function getSchEnv(keyRef) {
      keyRef = (0, resolve_1.normalizeId)(keyRef);
      return this.schemas[keyRef] || this.refs[keyRef];
    }
    function addInitialSchemas() {
      const optsSchemas = this.opts.schemas;
      if (!optsSchemas)
        return;
      if (Array.isArray(optsSchemas))
        this.addSchema(optsSchemas);
      else
        for (const key in optsSchemas)
          this.addSchema(optsSchemas[key], key);
    }
    function addInitialFormats() {
      for (const name in this.opts.formats) {
        const format = this.opts.formats[name];
        if (format)
          this.addFormat(name, format);
      }
    }
    function addInitialKeywords(defs) {
      if (Array.isArray(defs)) {
        this.addVocabulary(defs);
        return;
      }
      this.logger.warn("keywords option as map is deprecated, pass array");
      for (const keyword in defs) {
        const def3 = defs[keyword];
        if (!def3.keyword)
          def3.keyword = keyword;
        this.addKeyword(def3);
      }
    }
    function getMetaSchemaOptions() {
      const metaOpts = { ...this.opts };
      for (const opt of META_IGNORE_OPTIONS)
        delete metaOpts[opt];
      return metaOpts;
    }
    var noLogs = { log() {
    }, warn() {
    }, error() {
    } };
    function getLogger(logger) {
      if (logger === false)
        return noLogs;
      if (logger === void 0)
        return console;
      if (logger.log && logger.warn && logger.error)
        return logger;
      throw new Error("logger must implement log, warn and error methods");
    }
    var KEYWORD_NAME = /^[a-z_$][a-z0-9_$:-]*$/i;
    function checkKeyword(keyword, def3) {
      const { RULES } = this;
      (0, util_1.eachItem)(keyword, (kwd) => {
        if (RULES.keywords[kwd])
          throw new Error(`Keyword ${kwd} is already defined`);
        if (!KEYWORD_NAME.test(kwd))
          throw new Error(`Keyword ${kwd} has invalid name`);
      });
      if (!def3)
        return;
      if (def3.$data && !("code" in def3 || "validate" in def3)) {
        throw new Error('$data keyword must have "code" or "validate" function');
      }
    }
    function addRule(keyword, definition, dataType) {
      var _a3;
      const post = definition === null || definition === void 0 ? void 0 : definition.post;
      if (dataType && post)
        throw new Error('keyword with "post" flag cannot have "type"');
      const { RULES } = this;
      let ruleGroup = post ? RULES.post : RULES.rules.find(({ type: t }) => t === dataType);
      if (!ruleGroup) {
        ruleGroup = { type: dataType, rules: [] };
        RULES.rules.push(ruleGroup);
      }
      RULES.keywords[keyword] = true;
      if (!definition)
        return;
      const rule = {
        keyword,
        definition: {
          ...definition,
          type: (0, dataType_1.getJSONTypes)(definition.type),
          schemaType: (0, dataType_1.getJSONTypes)(definition.schemaType)
        }
      };
      if (definition.before)
        addBeforeRule.call(this, ruleGroup, rule, definition.before);
      else
        ruleGroup.rules.push(rule);
      RULES.all[keyword] = rule;
      (_a3 = definition.implements) === null || _a3 === void 0 ? void 0 : _a3.forEach((kwd) => this.addKeyword(kwd));
    }
    function addBeforeRule(ruleGroup, rule, before) {
      const i = ruleGroup.rules.findIndex((_rule) => _rule.keyword === before);
      if (i >= 0) {
        ruleGroup.rules.splice(i, 0, rule);
      } else {
        ruleGroup.rules.push(rule);
        this.logger.warn(`rule ${before} is not defined`);
      }
    }
    function keywordMetaschema(def3) {
      let { metaSchema } = def3;
      if (metaSchema === void 0)
        return;
      if (def3.$data && this.opts.$data)
        metaSchema = schemaOrData(metaSchema);
      def3.validateSchema = this.compile(metaSchema, true);
    }
    var $dataRef = {
      $ref: "https://raw.githubusercontent.com/ajv-validator/ajv/master/lib/refs/data.json#"
    };
    function schemaOrData(schema) {
      return { anyOf: [schema, $dataRef] };
    }
  }
});

// node_modules/ajv/dist/vocabularies/core/id.js
var require_id = __commonJS({
  "node_modules/ajv/dist/vocabularies/core/id.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var def3 = {
      keyword: "id",
      code() {
        throw new Error('NOT SUPPORTED: keyword "id", use "$id" for schema ID');
      }
    };
    exports.default = def3;
  }
});

// node_modules/ajv/dist/vocabularies/core/ref.js
var require_ref = __commonJS({
  "node_modules/ajv/dist/vocabularies/core/ref.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.callRef = exports.getValidate = void 0;
    var ref_error_1 = require_ref_error();
    var code_1 = require_code2();
    var codegen_1 = require_codegen();
    var names_1 = require_names();
    var compile_1 = require_compile();
    var util_1 = require_util();
    var def3 = {
      keyword: "$ref",
      schemaType: "string",
      code(cxt) {
        const { gen, schema: $ref, it } = cxt;
        const { baseId, schemaEnv: env, validateName, opts, self } = it;
        const { root } = env;
        if (($ref === "#" || $ref === "#/") && baseId === root.baseId)
          return callRootRef();
        const schOrEnv = compile_1.resolveRef.call(self, root, baseId, $ref);
        if (schOrEnv === void 0)
          throw new ref_error_1.default(it.opts.uriResolver, baseId, $ref);
        if (schOrEnv instanceof compile_1.SchemaEnv)
          return callValidate(schOrEnv);
        return inlineRefSchema(schOrEnv);
        function callRootRef() {
          if (env === root)
            return callRef(cxt, validateName, env, env.$async);
          const rootName = gen.scopeValue("root", { ref: root });
          return callRef(cxt, (0, codegen_1._)`${rootName}.validate`, root, root.$async);
        }
        function callValidate(sch) {
          const v = getValidate(cxt, sch);
          callRef(cxt, v, sch, sch.$async);
        }
        function inlineRefSchema(sch) {
          const schName = gen.scopeValue("schema", opts.code.source === true ? { ref: sch, code: (0, codegen_1.stringify)(sch) } : { ref: sch });
          const valid = gen.name("valid");
          const schCxt = cxt.subschema({
            schema: sch,
            dataTypes: [],
            schemaPath: codegen_1.nil,
            topSchemaRef: schName,
            errSchemaPath: $ref
          }, valid);
          cxt.mergeEvaluated(schCxt);
          cxt.ok(valid);
        }
      }
    };
    function getValidate(cxt, sch) {
      const { gen } = cxt;
      return sch.validate ? gen.scopeValue("validate", { ref: sch.validate }) : (0, codegen_1._)`${gen.scopeValue("wrapper", { ref: sch })}.validate`;
    }
    exports.getValidate = getValidate;
    function callRef(cxt, v, sch, $async) {
      const { gen, it } = cxt;
      const { allErrors, schemaEnv: env, opts } = it;
      const passCxt = opts.passContext ? names_1.default.this : codegen_1.nil;
      if ($async)
        callAsyncRef();
      else
        callSyncRef();
      function callAsyncRef() {
        if (!env.$async)
          throw new Error("async schema referenced by sync schema");
        const valid = gen.let("valid");
        gen.try(() => {
          gen.code((0, codegen_1._)`await ${(0, code_1.callValidateCode)(cxt, v, passCxt)}`);
          addEvaluatedFrom(v);
          if (!allErrors)
            gen.assign(valid, true);
        }, (e) => {
          gen.if((0, codegen_1._)`!(${e} instanceof ${it.ValidationError})`, () => gen.throw(e));
          addErrorsFrom(e);
          if (!allErrors)
            gen.assign(valid, false);
        });
        cxt.ok(valid);
      }
      function callSyncRef() {
        cxt.result((0, code_1.callValidateCode)(cxt, v, passCxt), () => addEvaluatedFrom(v), () => addErrorsFrom(v));
      }
      function addErrorsFrom(source) {
        const errs = (0, codegen_1._)`${source}.errors`;
        gen.assign(names_1.default.vErrors, (0, codegen_1._)`${names_1.default.vErrors} === null ? ${errs} : ${names_1.default.vErrors}.concat(${errs})`);
        gen.assign(names_1.default.errors, (0, codegen_1._)`${names_1.default.vErrors}.length`);
      }
      function addEvaluatedFrom(source) {
        var _a3;
        if (!it.opts.unevaluated)
          return;
        const schEvaluated = (_a3 = sch === null || sch === void 0 ? void 0 : sch.validate) === null || _a3 === void 0 ? void 0 : _a3.evaluated;
        if (it.props !== true) {
          if (schEvaluated && !schEvaluated.dynamicProps) {
            if (schEvaluated.props !== void 0) {
              it.props = util_1.mergeEvaluated.props(gen, schEvaluated.props, it.props);
            }
          } else {
            const props = gen.var("props", (0, codegen_1._)`${source}.evaluated.props`);
            it.props = util_1.mergeEvaluated.props(gen, props, it.props, codegen_1.Name);
          }
        }
        if (it.items !== true) {
          if (schEvaluated && !schEvaluated.dynamicItems) {
            if (schEvaluated.items !== void 0) {
              it.items = util_1.mergeEvaluated.items(gen, schEvaluated.items, it.items);
            }
          } else {
            const items = gen.var("items", (0, codegen_1._)`${source}.evaluated.items`);
            it.items = util_1.mergeEvaluated.items(gen, items, it.items, codegen_1.Name);
          }
        }
      }
    }
    exports.callRef = callRef;
    exports.default = def3;
  }
});

// node_modules/ajv/dist/vocabularies/core/index.js
var require_core2 = __commonJS({
  "node_modules/ajv/dist/vocabularies/core/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var id_1 = require_id();
    var ref_1 = require_ref();
    var core = [
      "$schema",
      "$id",
      "$defs",
      "$vocabulary",
      { keyword: "$comment" },
      "definitions",
      id_1.default,
      ref_1.default
    ];
    exports.default = core;
  }
});

// node_modules/ajv/dist/vocabularies/validation/limitNumber.js
var require_limitNumber = __commonJS({
  "node_modules/ajv/dist/vocabularies/validation/limitNumber.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var ops = codegen_1.operators;
    var KWDs = {
      maximum: { okStr: "<=", ok: ops.LTE, fail: ops.GT },
      minimum: { okStr: ">=", ok: ops.GTE, fail: ops.LT },
      exclusiveMaximum: { okStr: "<", ok: ops.LT, fail: ops.GTE },
      exclusiveMinimum: { okStr: ">", ok: ops.GT, fail: ops.LTE }
    };
    var error2 = {
      message: ({ keyword, schemaCode }) => (0, codegen_1.str)`must be ${KWDs[keyword].okStr} ${schemaCode}`,
      params: ({ keyword, schemaCode }) => (0, codegen_1._)`{comparison: ${KWDs[keyword].okStr}, limit: ${schemaCode}}`
    };
    var def3 = {
      keyword: Object.keys(KWDs),
      type: "number",
      schemaType: "number",
      $data: true,
      error: error2,
      code(cxt) {
        const { keyword, data, schemaCode } = cxt;
        cxt.fail$data((0, codegen_1._)`${data} ${KWDs[keyword].fail} ${schemaCode} || isNaN(${data})`);
      }
    };
    exports.default = def3;
  }
});

// node_modules/ajv/dist/vocabularies/validation/multipleOf.js
var require_multipleOf = __commonJS({
  "node_modules/ajv/dist/vocabularies/validation/multipleOf.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var error2 = {
      message: ({ schemaCode }) => (0, codegen_1.str)`must be multiple of ${schemaCode}`,
      params: ({ schemaCode }) => (0, codegen_1._)`{multipleOf: ${schemaCode}}`
    };
    var def3 = {
      keyword: "multipleOf",
      type: "number",
      schemaType: "number",
      $data: true,
      error: error2,
      code(cxt) {
        const { gen, data, schemaCode, it } = cxt;
        const prec = it.opts.multipleOfPrecision;
        const res = gen.let("res");
        const invalid = prec ? (0, codegen_1._)`Math.abs(Math.round(${res}) - ${res}) > 1e-${prec}` : (0, codegen_1._)`${res} !== parseInt(${res})`;
        cxt.fail$data((0, codegen_1._)`(${schemaCode} === 0 || (${res} = ${data}/${schemaCode}, ${invalid}))`);
      }
    };
    exports.default = def3;
  }
});

// node_modules/ajv/dist/runtime/ucs2length.js
var require_ucs2length = __commonJS({
  "node_modules/ajv/dist/runtime/ucs2length.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    function ucs2length(str3) {
      const len = str3.length;
      let length = 0;
      let pos = 0;
      let value;
      while (pos < len) {
        length++;
        value = str3.charCodeAt(pos++);
        if (value >= 55296 && value <= 56319 && pos < len) {
          value = str3.charCodeAt(pos);
          if ((value & 64512) === 56320)
            pos++;
        }
      }
      return length;
    }
    exports.default = ucs2length;
    ucs2length.code = 'require("ajv/dist/runtime/ucs2length").default';
  }
});

// node_modules/ajv/dist/vocabularies/validation/limitLength.js
var require_limitLength = __commonJS({
  "node_modules/ajv/dist/vocabularies/validation/limitLength.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var ucs2length_1 = require_ucs2length();
    var error2 = {
      message({ keyword, schemaCode }) {
        const comp = keyword === "maxLength" ? "more" : "fewer";
        return (0, codegen_1.str)`must NOT have ${comp} than ${schemaCode} characters`;
      },
      params: ({ schemaCode }) => (0, codegen_1._)`{limit: ${schemaCode}}`
    };
    var def3 = {
      keyword: ["maxLength", "minLength"],
      type: "string",
      schemaType: "number",
      $data: true,
      error: error2,
      code(cxt) {
        const { keyword, data, schemaCode, it } = cxt;
        const op = keyword === "maxLength" ? codegen_1.operators.GT : codegen_1.operators.LT;
        const len = it.opts.unicode === false ? (0, codegen_1._)`${data}.length` : (0, codegen_1._)`${(0, util_1.useFunc)(cxt.gen, ucs2length_1.default)}(${data})`;
        cxt.fail$data((0, codegen_1._)`${len} ${op} ${schemaCode}`);
      }
    };
    exports.default = def3;
  }
});

// node_modules/ajv/dist/vocabularies/validation/pattern.js
var require_pattern = __commonJS({
  "node_modules/ajv/dist/vocabularies/validation/pattern.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var code_1 = require_code2();
    var util_1 = require_util();
    var codegen_1 = require_codegen();
    var error2 = {
      message: ({ schemaCode }) => (0, codegen_1.str)`must match pattern "${schemaCode}"`,
      params: ({ schemaCode }) => (0, codegen_1._)`{pattern: ${schemaCode}}`
    };
    var def3 = {
      keyword: "pattern",
      type: "string",
      schemaType: "string",
      $data: true,
      error: error2,
      code(cxt) {
        const { gen, data, $data, schema, schemaCode, it } = cxt;
        const u = it.opts.unicodeRegExp ? "u" : "";
        if ($data) {
          const { regExp } = it.opts.code;
          const regExpCode = regExp.code === "new RegExp" ? (0, codegen_1._)`new RegExp` : (0, util_1.useFunc)(gen, regExp);
          const valid = gen.let("valid");
          gen.try(() => gen.assign(valid, (0, codegen_1._)`${regExpCode}(${schemaCode}, ${u}).test(${data})`), () => gen.assign(valid, false));
          cxt.fail$data((0, codegen_1._)`!${valid}`);
        } else {
          const regExp = (0, code_1.usePattern)(cxt, schema);
          cxt.fail$data((0, codegen_1._)`!${regExp}.test(${data})`);
        }
      }
    };
    exports.default = def3;
  }
});

// node_modules/ajv/dist/vocabularies/validation/limitProperties.js
var require_limitProperties = __commonJS({
  "node_modules/ajv/dist/vocabularies/validation/limitProperties.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var error2 = {
      message({ keyword, schemaCode }) {
        const comp = keyword === "maxProperties" ? "more" : "fewer";
        return (0, codegen_1.str)`must NOT have ${comp} than ${schemaCode} properties`;
      },
      params: ({ schemaCode }) => (0, codegen_1._)`{limit: ${schemaCode}}`
    };
    var def3 = {
      keyword: ["maxProperties", "minProperties"],
      type: "object",
      schemaType: "number",
      $data: true,
      error: error2,
      code(cxt) {
        const { keyword, data, schemaCode } = cxt;
        const op = keyword === "maxProperties" ? codegen_1.operators.GT : codegen_1.operators.LT;
        cxt.fail$data((0, codegen_1._)`Object.keys(${data}).length ${op} ${schemaCode}`);
      }
    };
    exports.default = def3;
  }
});

// node_modules/ajv/dist/vocabularies/validation/required.js
var require_required = __commonJS({
  "node_modules/ajv/dist/vocabularies/validation/required.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var code_1 = require_code2();
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error2 = {
      message: ({ params: { missingProperty } }) => (0, codegen_1.str)`must have required property '${missingProperty}'`,
      params: ({ params: { missingProperty } }) => (0, codegen_1._)`{missingProperty: ${missingProperty}}`
    };
    var def3 = {
      keyword: "required",
      type: "object",
      schemaType: "array",
      $data: true,
      error: error2,
      code(cxt) {
        const { gen, schema, schemaCode, data, $data, it } = cxt;
        const { opts } = it;
        if (!$data && schema.length === 0)
          return;
        const useLoop = schema.length >= opts.loopRequired;
        if (it.allErrors)
          allErrorsMode();
        else
          exitOnErrorMode();
        if (opts.strictRequired) {
          const props = cxt.parentSchema.properties;
          const { definedProperties } = cxt.it;
          for (const requiredKey of schema) {
            if ((props === null || props === void 0 ? void 0 : props[requiredKey]) === void 0 && !definedProperties.has(requiredKey)) {
              const schemaPath = it.schemaEnv.baseId + it.errSchemaPath;
              const msg = `required property "${requiredKey}" is not defined at "${schemaPath}" (strictRequired)`;
              (0, util_1.checkStrictMode)(it, msg, it.opts.strictRequired);
            }
          }
        }
        function allErrorsMode() {
          if (useLoop || $data) {
            cxt.block$data(codegen_1.nil, loopAllRequired);
          } else {
            for (const prop of schema) {
              (0, code_1.checkReportMissingProp)(cxt, prop);
            }
          }
        }
        function exitOnErrorMode() {
          const missing = gen.let("missing");
          if (useLoop || $data) {
            const valid = gen.let("valid", true);
            cxt.block$data(valid, () => loopUntilMissing(missing, valid));
            cxt.ok(valid);
          } else {
            gen.if((0, code_1.checkMissingProp)(cxt, schema, missing));
            (0, code_1.reportMissingProp)(cxt, missing);
            gen.else();
          }
        }
        function loopAllRequired() {
          gen.forOf("prop", schemaCode, (prop) => {
            cxt.setParams({ missingProperty: prop });
            gen.if((0, code_1.noPropertyInData)(gen, data, prop, opts.ownProperties), () => cxt.error());
          });
        }
        function loopUntilMissing(missing, valid) {
          cxt.setParams({ missingProperty: missing });
          gen.forOf(missing, schemaCode, () => {
            gen.assign(valid, (0, code_1.propertyInData)(gen, data, missing, opts.ownProperties));
            gen.if((0, codegen_1.not)(valid), () => {
              cxt.error();
              gen.break();
            });
          }, codegen_1.nil);
        }
      }
    };
    exports.default = def3;
  }
});

// node_modules/ajv/dist/vocabularies/validation/limitItems.js
var require_limitItems = __commonJS({
  "node_modules/ajv/dist/vocabularies/validation/limitItems.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var error2 = {
      message({ keyword, schemaCode }) {
        const comp = keyword === "maxItems" ? "more" : "fewer";
        return (0, codegen_1.str)`must NOT have ${comp} than ${schemaCode} items`;
      },
      params: ({ schemaCode }) => (0, codegen_1._)`{limit: ${schemaCode}}`
    };
    var def3 = {
      keyword: ["maxItems", "minItems"],
      type: "array",
      schemaType: "number",
      $data: true,
      error: error2,
      code(cxt) {
        const { keyword, data, schemaCode } = cxt;
        const op = keyword === "maxItems" ? codegen_1.operators.GT : codegen_1.operators.LT;
        cxt.fail$data((0, codegen_1._)`${data}.length ${op} ${schemaCode}`);
      }
    };
    exports.default = def3;
  }
});

// node_modules/ajv/dist/runtime/equal.js
var require_equal = __commonJS({
  "node_modules/ajv/dist/runtime/equal.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var equal = require_fast_deep_equal();
    equal.code = 'require("ajv/dist/runtime/equal").default';
    exports.default = equal;
  }
});

// node_modules/ajv/dist/vocabularies/validation/uniqueItems.js
var require_uniqueItems = __commonJS({
  "node_modules/ajv/dist/vocabularies/validation/uniqueItems.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var dataType_1 = require_dataType();
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var equal_1 = require_equal();
    var error2 = {
      message: ({ params: { i, j } }) => (0, codegen_1.str)`must NOT have duplicate items (items ## ${j} and ${i} are identical)`,
      params: ({ params: { i, j } }) => (0, codegen_1._)`{i: ${i}, j: ${j}}`
    };
    var def3 = {
      keyword: "uniqueItems",
      type: "array",
      schemaType: "boolean",
      $data: true,
      error: error2,
      code(cxt) {
        const { gen, data, $data, schema, parentSchema, schemaCode, it } = cxt;
        if (!$data && !schema)
          return;
        const valid = gen.let("valid");
        const itemTypes = parentSchema.items ? (0, dataType_1.getSchemaTypes)(parentSchema.items) : [];
        cxt.block$data(valid, validateUniqueItems, (0, codegen_1._)`${schemaCode} === false`);
        cxt.ok(valid);
        function validateUniqueItems() {
          const i = gen.let("i", (0, codegen_1._)`${data}.length`);
          const j = gen.let("j");
          cxt.setParams({ i, j });
          gen.assign(valid, true);
          gen.if((0, codegen_1._)`${i} > 1`, () => (canOptimize() ? loopN : loopN2)(i, j));
        }
        function canOptimize() {
          return itemTypes.length > 0 && !itemTypes.some((t) => t === "object" || t === "array");
        }
        function loopN(i, j) {
          const item = gen.name("item");
          const wrongType = (0, dataType_1.checkDataTypes)(itemTypes, item, it.opts.strictNumbers, dataType_1.DataType.Wrong);
          const indices = gen.const("indices", (0, codegen_1._)`{}`);
          gen.for((0, codegen_1._)`;${i}--;`, () => {
            gen.let(item, (0, codegen_1._)`${data}[${i}]`);
            gen.if(wrongType, (0, codegen_1._)`continue`);
            if (itemTypes.length > 1)
              gen.if((0, codegen_1._)`typeof ${item} == "string"`, (0, codegen_1._)`${item} += "_"`);
            gen.if((0, codegen_1._)`typeof ${indices}[${item}] == "number"`, () => {
              gen.assign(j, (0, codegen_1._)`${indices}[${item}]`);
              cxt.error();
              gen.assign(valid, false).break();
            }).code((0, codegen_1._)`${indices}[${item}] = ${i}`);
          });
        }
        function loopN2(i, j) {
          const eql = (0, util_1.useFunc)(gen, equal_1.default);
          const outer = gen.name("outer");
          gen.label(outer).for((0, codegen_1._)`;${i}--;`, () => gen.for((0, codegen_1._)`${j} = ${i}; ${j}--;`, () => gen.if((0, codegen_1._)`${eql}(${data}[${i}], ${data}[${j}])`, () => {
            cxt.error();
            gen.assign(valid, false).break(outer);
          })));
        }
      }
    };
    exports.default = def3;
  }
});

// node_modules/ajv/dist/vocabularies/validation/const.js
var require_const = __commonJS({
  "node_modules/ajv/dist/vocabularies/validation/const.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var equal_1 = require_equal();
    var error2 = {
      message: "must be equal to constant",
      params: ({ schemaCode }) => (0, codegen_1._)`{allowedValue: ${schemaCode}}`
    };
    var def3 = {
      keyword: "const",
      $data: true,
      error: error2,
      code(cxt) {
        const { gen, data, $data, schemaCode, schema } = cxt;
        if ($data || schema && typeof schema == "object") {
          cxt.fail$data((0, codegen_1._)`!${(0, util_1.useFunc)(gen, equal_1.default)}(${data}, ${schemaCode})`);
        } else {
          cxt.fail((0, codegen_1._)`${schema} !== ${data}`);
        }
      }
    };
    exports.default = def3;
  }
});

// node_modules/ajv/dist/vocabularies/validation/enum.js
var require_enum = __commonJS({
  "node_modules/ajv/dist/vocabularies/validation/enum.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var equal_1 = require_equal();
    var error2 = {
      message: "must be equal to one of the allowed values",
      params: ({ schemaCode }) => (0, codegen_1._)`{allowedValues: ${schemaCode}}`
    };
    var def3 = {
      keyword: "enum",
      schemaType: "array",
      $data: true,
      error: error2,
      code(cxt) {
        const { gen, data, $data, schema, schemaCode, it } = cxt;
        if (!$data && schema.length === 0)
          throw new Error("enum must have non-empty array");
        const useLoop = schema.length >= it.opts.loopEnum;
        let eql;
        const getEql = () => eql !== null && eql !== void 0 ? eql : eql = (0, util_1.useFunc)(gen, equal_1.default);
        let valid;
        if (useLoop || $data) {
          valid = gen.let("valid");
          cxt.block$data(valid, loopEnum);
        } else {
          if (!Array.isArray(schema))
            throw new Error("ajv implementation error");
          const vSchema = gen.const("vSchema", schemaCode);
          valid = (0, codegen_1.or)(...schema.map((_x, i) => equalCode(vSchema, i)));
        }
        cxt.pass(valid);
        function loopEnum() {
          gen.assign(valid, false);
          gen.forOf("v", schemaCode, (v) => gen.if((0, codegen_1._)`${getEql()}(${data}, ${v})`, () => gen.assign(valid, true).break()));
        }
        function equalCode(vSchema, i) {
          const sch = schema[i];
          return typeof sch === "object" && sch !== null ? (0, codegen_1._)`${getEql()}(${data}, ${vSchema}[${i}])` : (0, codegen_1._)`${data} === ${sch}`;
        }
      }
    };
    exports.default = def3;
  }
});

// node_modules/ajv/dist/vocabularies/validation/index.js
var require_validation = __commonJS({
  "node_modules/ajv/dist/vocabularies/validation/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var limitNumber_1 = require_limitNumber();
    var multipleOf_1 = require_multipleOf();
    var limitLength_1 = require_limitLength();
    var pattern_1 = require_pattern();
    var limitProperties_1 = require_limitProperties();
    var required_1 = require_required();
    var limitItems_1 = require_limitItems();
    var uniqueItems_1 = require_uniqueItems();
    var const_1 = require_const();
    var enum_1 = require_enum();
    var validation = [
      // number
      limitNumber_1.default,
      multipleOf_1.default,
      // string
      limitLength_1.default,
      pattern_1.default,
      // object
      limitProperties_1.default,
      required_1.default,
      // array
      limitItems_1.default,
      uniqueItems_1.default,
      // any
      { keyword: "type", schemaType: ["string", "array"] },
      { keyword: "nullable", schemaType: "boolean" },
      const_1.default,
      enum_1.default
    ];
    exports.default = validation;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/additionalItems.js
var require_additionalItems = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/additionalItems.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.validateAdditionalItems = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error2 = {
      message: ({ params: { len } }) => (0, codegen_1.str)`must NOT have more than ${len} items`,
      params: ({ params: { len } }) => (0, codegen_1._)`{limit: ${len}}`
    };
    var def3 = {
      keyword: "additionalItems",
      type: "array",
      schemaType: ["boolean", "object"],
      before: "uniqueItems",
      error: error2,
      code(cxt) {
        const { parentSchema, it } = cxt;
        const { items } = parentSchema;
        if (!Array.isArray(items)) {
          (0, util_1.checkStrictMode)(it, '"additionalItems" is ignored when "items" is not an array of schemas');
          return;
        }
        validateAdditionalItems(cxt, items);
      }
    };
    function validateAdditionalItems(cxt, items) {
      const { gen, schema, data, keyword, it } = cxt;
      it.items = true;
      const len = gen.const("len", (0, codegen_1._)`${data}.length`);
      if (schema === false) {
        cxt.setParams({ len: items.length });
        cxt.pass((0, codegen_1._)`${len} <= ${items.length}`);
      } else if (typeof schema == "object" && !(0, util_1.alwaysValidSchema)(it, schema)) {
        const valid = gen.var("valid", (0, codegen_1._)`${len} <= ${items.length}`);
        gen.if((0, codegen_1.not)(valid), () => validateItems(valid));
        cxt.ok(valid);
      }
      function validateItems(valid) {
        gen.forRange("i", items.length, len, (i) => {
          cxt.subschema({ keyword, dataProp: i, dataPropType: util_1.Type.Num }, valid);
          if (!it.allErrors)
            gen.if((0, codegen_1.not)(valid), () => gen.break());
        });
      }
    }
    exports.validateAdditionalItems = validateAdditionalItems;
    exports.default = def3;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/items.js
var require_items = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/items.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.validateTuple = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var code_1 = require_code2();
    var def3 = {
      keyword: "items",
      type: "array",
      schemaType: ["object", "array", "boolean"],
      before: "uniqueItems",
      code(cxt) {
        const { schema, it } = cxt;
        if (Array.isArray(schema))
          return validateTuple(cxt, "additionalItems", schema);
        it.items = true;
        if ((0, util_1.alwaysValidSchema)(it, schema))
          return;
        cxt.ok((0, code_1.validateArray)(cxt));
      }
    };
    function validateTuple(cxt, extraItems, schArr = cxt.schema) {
      const { gen, parentSchema, data, keyword, it } = cxt;
      checkStrictTuple(parentSchema);
      if (it.opts.unevaluated && schArr.length && it.items !== true) {
        it.items = util_1.mergeEvaluated.items(gen, schArr.length, it.items);
      }
      const valid = gen.name("valid");
      const len = gen.const("len", (0, codegen_1._)`${data}.length`);
      schArr.forEach((sch, i) => {
        if ((0, util_1.alwaysValidSchema)(it, sch))
          return;
        gen.if((0, codegen_1._)`${len} > ${i}`, () => cxt.subschema({
          keyword,
          schemaProp: i,
          dataProp: i
        }, valid));
        cxt.ok(valid);
      });
      function checkStrictTuple(sch) {
        const { opts, errSchemaPath } = it;
        const l = schArr.length;
        const fullTuple = l === sch.minItems && (l === sch.maxItems || sch[extraItems] === false);
        if (opts.strictTuples && !fullTuple) {
          const msg = `"${keyword}" is ${l}-tuple, but minItems or maxItems/${extraItems} are not specified or different at path "${errSchemaPath}"`;
          (0, util_1.checkStrictMode)(it, msg, opts.strictTuples);
        }
      }
    }
    exports.validateTuple = validateTuple;
    exports.default = def3;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/prefixItems.js
var require_prefixItems = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/prefixItems.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var items_1 = require_items();
    var def3 = {
      keyword: "prefixItems",
      type: "array",
      schemaType: ["array"],
      before: "uniqueItems",
      code: (cxt) => (0, items_1.validateTuple)(cxt, "items")
    };
    exports.default = def3;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/items2020.js
var require_items2020 = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/items2020.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var code_1 = require_code2();
    var additionalItems_1 = require_additionalItems();
    var error2 = {
      message: ({ params: { len } }) => (0, codegen_1.str)`must NOT have more than ${len} items`,
      params: ({ params: { len } }) => (0, codegen_1._)`{limit: ${len}}`
    };
    var def3 = {
      keyword: "items",
      type: "array",
      schemaType: ["object", "boolean"],
      before: "uniqueItems",
      error: error2,
      code(cxt) {
        const { schema, parentSchema, it } = cxt;
        const { prefixItems } = parentSchema;
        it.items = true;
        if ((0, util_1.alwaysValidSchema)(it, schema))
          return;
        if (prefixItems)
          (0, additionalItems_1.validateAdditionalItems)(cxt, prefixItems);
        else
          cxt.ok((0, code_1.validateArray)(cxt));
      }
    };
    exports.default = def3;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/contains.js
var require_contains = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/contains.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error2 = {
      message: ({ params: { min, max } }) => max === void 0 ? (0, codegen_1.str)`must contain at least ${min} valid item(s)` : (0, codegen_1.str)`must contain at least ${min} and no more than ${max} valid item(s)`,
      params: ({ params: { min, max } }) => max === void 0 ? (0, codegen_1._)`{minContains: ${min}}` : (0, codegen_1._)`{minContains: ${min}, maxContains: ${max}}`
    };
    var def3 = {
      keyword: "contains",
      type: "array",
      schemaType: ["object", "boolean"],
      before: "uniqueItems",
      trackErrors: true,
      error: error2,
      code(cxt) {
        const { gen, schema, parentSchema, data, it } = cxt;
        let min;
        let max;
        const { minContains, maxContains } = parentSchema;
        if (it.opts.next) {
          min = minContains === void 0 ? 1 : minContains;
          max = maxContains;
        } else {
          min = 1;
        }
        const len = gen.const("len", (0, codegen_1._)`${data}.length`);
        cxt.setParams({ min, max });
        if (max === void 0 && min === 0) {
          (0, util_1.checkStrictMode)(it, `"minContains" == 0 without "maxContains": "contains" keyword ignored`);
          return;
        }
        if (max !== void 0 && min > max) {
          (0, util_1.checkStrictMode)(it, `"minContains" > "maxContains" is always invalid`);
          cxt.fail();
          return;
        }
        if ((0, util_1.alwaysValidSchema)(it, schema)) {
          let cond = (0, codegen_1._)`${len} >= ${min}`;
          if (max !== void 0)
            cond = (0, codegen_1._)`${cond} && ${len} <= ${max}`;
          cxt.pass(cond);
          return;
        }
        it.items = true;
        const valid = gen.name("valid");
        if (max === void 0 && min === 1) {
          validateItems(valid, () => gen.if(valid, () => gen.break()));
        } else if (min === 0) {
          gen.let(valid, true);
          if (max !== void 0)
            gen.if((0, codegen_1._)`${data}.length > 0`, validateItemsWithCount);
        } else {
          gen.let(valid, false);
          validateItemsWithCount();
        }
        cxt.result(valid, () => cxt.reset());
        function validateItemsWithCount() {
          const schValid = gen.name("_valid");
          const count = gen.let("count", 0);
          validateItems(schValid, () => gen.if(schValid, () => checkLimits(count)));
        }
        function validateItems(_valid, block) {
          gen.forRange("i", 0, len, (i) => {
            cxt.subschema({
              keyword: "contains",
              dataProp: i,
              dataPropType: util_1.Type.Num,
              compositeRule: true
            }, _valid);
            block();
          });
        }
        function checkLimits(count) {
          gen.code((0, codegen_1._)`${count}++`);
          if (max === void 0) {
            gen.if((0, codegen_1._)`${count} >= ${min}`, () => gen.assign(valid, true).break());
          } else {
            gen.if((0, codegen_1._)`${count} > ${max}`, () => gen.assign(valid, false).break());
            if (min === 1)
              gen.assign(valid, true);
            else
              gen.if((0, codegen_1._)`${count} >= ${min}`, () => gen.assign(valid, true));
          }
        }
      }
    };
    exports.default = def3;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/dependencies.js
var require_dependencies = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/dependencies.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.validateSchemaDeps = exports.validatePropertyDeps = exports.error = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var code_1 = require_code2();
    exports.error = {
      message: ({ params: { property, depsCount, deps } }) => {
        const property_ies = depsCount === 1 ? "property" : "properties";
        return (0, codegen_1.str)`must have ${property_ies} ${deps} when property ${property} is present`;
      },
      params: ({ params: { property, depsCount, deps, missingProperty } }) => (0, codegen_1._)`{property: ${property},
    missingProperty: ${missingProperty},
    depsCount: ${depsCount},
    deps: ${deps}}`
      // TODO change to reference
    };
    var def3 = {
      keyword: "dependencies",
      type: "object",
      schemaType: "object",
      error: exports.error,
      code(cxt) {
        const [propDeps, schDeps] = splitDependencies(cxt);
        validatePropertyDeps(cxt, propDeps);
        validateSchemaDeps(cxt, schDeps);
      }
    };
    function splitDependencies({ schema }) {
      const propertyDeps = {};
      const schemaDeps = {};
      for (const key in schema) {
        if (key === "__proto__")
          continue;
        const deps = Array.isArray(schema[key]) ? propertyDeps : schemaDeps;
        deps[key] = schema[key];
      }
      return [propertyDeps, schemaDeps];
    }
    function validatePropertyDeps(cxt, propertyDeps = cxt.schema) {
      const { gen, data, it } = cxt;
      if (Object.keys(propertyDeps).length === 0)
        return;
      const missing = gen.let("missing");
      for (const prop in propertyDeps) {
        const deps = propertyDeps[prop];
        if (deps.length === 0)
          continue;
        const hasProperty = (0, code_1.propertyInData)(gen, data, prop, it.opts.ownProperties);
        cxt.setParams({
          property: prop,
          depsCount: deps.length,
          deps: deps.join(", ")
        });
        if (it.allErrors) {
          gen.if(hasProperty, () => {
            for (const depProp of deps) {
              (0, code_1.checkReportMissingProp)(cxt, depProp);
            }
          });
        } else {
          gen.if((0, codegen_1._)`${hasProperty} && (${(0, code_1.checkMissingProp)(cxt, deps, missing)})`);
          (0, code_1.reportMissingProp)(cxt, missing);
          gen.else();
        }
      }
    }
    exports.validatePropertyDeps = validatePropertyDeps;
    function validateSchemaDeps(cxt, schemaDeps = cxt.schema) {
      const { gen, data, keyword, it } = cxt;
      const valid = gen.name("valid");
      for (const prop in schemaDeps) {
        if ((0, util_1.alwaysValidSchema)(it, schemaDeps[prop]))
          continue;
        gen.if(
          (0, code_1.propertyInData)(gen, data, prop, it.opts.ownProperties),
          () => {
            const schCxt = cxt.subschema({ keyword, schemaProp: prop }, valid);
            cxt.mergeValidEvaluated(schCxt, valid);
          },
          () => gen.var(valid, true)
          // TODO var
        );
        cxt.ok(valid);
      }
    }
    exports.validateSchemaDeps = validateSchemaDeps;
    exports.default = def3;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/propertyNames.js
var require_propertyNames = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/propertyNames.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error2 = {
      message: "property name must be valid",
      params: ({ params }) => (0, codegen_1._)`{propertyName: ${params.propertyName}}`
    };
    var def3 = {
      keyword: "propertyNames",
      type: "object",
      schemaType: ["object", "boolean"],
      error: error2,
      code(cxt) {
        const { gen, schema, data, it } = cxt;
        if ((0, util_1.alwaysValidSchema)(it, schema))
          return;
        const valid = gen.name("valid");
        gen.forIn("key", data, (key) => {
          cxt.setParams({ propertyName: key });
          cxt.subschema({
            keyword: "propertyNames",
            data: key,
            dataTypes: ["string"],
            propertyName: key,
            compositeRule: true
          }, valid);
          gen.if((0, codegen_1.not)(valid), () => {
            cxt.error(true);
            if (!it.allErrors)
              gen.break();
          });
        });
        cxt.ok(valid);
      }
    };
    exports.default = def3;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/additionalProperties.js
var require_additionalProperties = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/additionalProperties.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var code_1 = require_code2();
    var codegen_1 = require_codegen();
    var names_1 = require_names();
    var util_1 = require_util();
    var error2 = {
      message: "must NOT have additional properties",
      params: ({ params }) => (0, codegen_1._)`{additionalProperty: ${params.additionalProperty}}`
    };
    var def3 = {
      keyword: "additionalProperties",
      type: ["object"],
      schemaType: ["boolean", "object"],
      allowUndefined: true,
      trackErrors: true,
      error: error2,
      code(cxt) {
        const { gen, schema, parentSchema, data, errsCount, it } = cxt;
        if (!errsCount)
          throw new Error("ajv implementation error");
        const { allErrors, opts } = it;
        it.props = true;
        if (opts.removeAdditional !== "all" && (0, util_1.alwaysValidSchema)(it, schema))
          return;
        const props = (0, code_1.allSchemaProperties)(parentSchema.properties);
        const patProps = (0, code_1.allSchemaProperties)(parentSchema.patternProperties);
        checkAdditionalProperties();
        cxt.ok((0, codegen_1._)`${errsCount} === ${names_1.default.errors}`);
        function checkAdditionalProperties() {
          gen.forIn("key", data, (key) => {
            if (!props.length && !patProps.length)
              additionalPropertyCode(key);
            else
              gen.if(isAdditional(key), () => additionalPropertyCode(key));
          });
        }
        function isAdditional(key) {
          let definedProp;
          if (props.length > 8) {
            const propsSchema = (0, util_1.schemaRefOrVal)(it, parentSchema.properties, "properties");
            definedProp = (0, code_1.isOwnProperty)(gen, propsSchema, key);
          } else if (props.length) {
            definedProp = (0, codegen_1.or)(...props.map((p) => (0, codegen_1._)`${key} === ${p}`));
          } else {
            definedProp = codegen_1.nil;
          }
          if (patProps.length) {
            definedProp = (0, codegen_1.or)(definedProp, ...patProps.map((p) => (0, codegen_1._)`${(0, code_1.usePattern)(cxt, p)}.test(${key})`));
          }
          return (0, codegen_1.not)(definedProp);
        }
        function deleteAdditional(key) {
          gen.code((0, codegen_1._)`delete ${data}[${key}]`);
        }
        function additionalPropertyCode(key) {
          if (opts.removeAdditional === "all" || opts.removeAdditional && schema === false) {
            deleteAdditional(key);
            return;
          }
          if (schema === false) {
            cxt.setParams({ additionalProperty: key });
            cxt.error();
            if (!allErrors)
              gen.break();
            return;
          }
          if (typeof schema == "object" && !(0, util_1.alwaysValidSchema)(it, schema)) {
            const valid = gen.name("valid");
            if (opts.removeAdditional === "failing") {
              applyAdditionalSchema(key, valid, false);
              gen.if((0, codegen_1.not)(valid), () => {
                cxt.reset();
                deleteAdditional(key);
              });
            } else {
              applyAdditionalSchema(key, valid);
              if (!allErrors)
                gen.if((0, codegen_1.not)(valid), () => gen.break());
            }
          }
        }
        function applyAdditionalSchema(key, valid, errors) {
          const subschema = {
            keyword: "additionalProperties",
            dataProp: key,
            dataPropType: util_1.Type.Str
          };
          if (errors === false) {
            Object.assign(subschema, {
              compositeRule: true,
              createErrors: false,
              allErrors: false
            });
          }
          cxt.subschema(subschema, valid);
        }
      }
    };
    exports.default = def3;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/properties.js
var require_properties = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/properties.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var validate_1 = require_validate();
    var code_1 = require_code2();
    var util_1 = require_util();
    var additionalProperties_1 = require_additionalProperties();
    var def3 = {
      keyword: "properties",
      type: "object",
      schemaType: "object",
      code(cxt) {
        const { gen, schema, parentSchema, data, it } = cxt;
        if (it.opts.removeAdditional === "all" && parentSchema.additionalProperties === void 0) {
          additionalProperties_1.default.code(new validate_1.KeywordCxt(it, additionalProperties_1.default, "additionalProperties"));
        }
        const allProps = (0, code_1.allSchemaProperties)(schema);
        for (const prop of allProps) {
          it.definedProperties.add(prop);
        }
        if (it.opts.unevaluated && allProps.length && it.props !== true) {
          it.props = util_1.mergeEvaluated.props(gen, (0, util_1.toHash)(allProps), it.props);
        }
        const properties = allProps.filter((p) => !(0, util_1.alwaysValidSchema)(it, schema[p]));
        if (properties.length === 0)
          return;
        const valid = gen.name("valid");
        for (const prop of properties) {
          if (hasDefault(prop)) {
            applyPropertySchema(prop);
          } else {
            gen.if((0, code_1.propertyInData)(gen, data, prop, it.opts.ownProperties));
            applyPropertySchema(prop);
            if (!it.allErrors)
              gen.else().var(valid, true);
            gen.endIf();
          }
          cxt.it.definedProperties.add(prop);
          cxt.ok(valid);
        }
        function hasDefault(prop) {
          return it.opts.useDefaults && !it.compositeRule && schema[prop].default !== void 0;
        }
        function applyPropertySchema(prop) {
          cxt.subschema({
            keyword: "properties",
            schemaProp: prop,
            dataProp: prop
          }, valid);
        }
      }
    };
    exports.default = def3;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/patternProperties.js
var require_patternProperties = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/patternProperties.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var code_1 = require_code2();
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var util_2 = require_util();
    var def3 = {
      keyword: "patternProperties",
      type: "object",
      schemaType: "object",
      code(cxt) {
        const { gen, schema, data, parentSchema, it } = cxt;
        const { opts } = it;
        const patterns = (0, code_1.allSchemaProperties)(schema);
        const alwaysValidPatterns = patterns.filter((p) => (0, util_1.alwaysValidSchema)(it, schema[p]));
        if (patterns.length === 0 || alwaysValidPatterns.length === patterns.length && (!it.opts.unevaluated || it.props === true)) {
          return;
        }
        const checkProperties = opts.strictSchema && !opts.allowMatchingProperties && parentSchema.properties;
        const valid = gen.name("valid");
        if (it.props !== true && !(it.props instanceof codegen_1.Name)) {
          it.props = (0, util_2.evaluatedPropsToName)(gen, it.props);
        }
        const { props } = it;
        validatePatternProperties();
        function validatePatternProperties() {
          for (const pat of patterns) {
            if (checkProperties)
              checkMatchingProperties(pat);
            if (it.allErrors) {
              validateProperties(pat);
            } else {
              gen.var(valid, true);
              validateProperties(pat);
              gen.if(valid);
            }
          }
        }
        function checkMatchingProperties(pat) {
          for (const prop in checkProperties) {
            if (new RegExp(pat).test(prop)) {
              (0, util_1.checkStrictMode)(it, `property ${prop} matches pattern ${pat} (use allowMatchingProperties)`);
            }
          }
        }
        function validateProperties(pat) {
          gen.forIn("key", data, (key) => {
            gen.if((0, codegen_1._)`${(0, code_1.usePattern)(cxt, pat)}.test(${key})`, () => {
              const alwaysValid = alwaysValidPatterns.includes(pat);
              if (!alwaysValid) {
                cxt.subschema({
                  keyword: "patternProperties",
                  schemaProp: pat,
                  dataProp: key,
                  dataPropType: util_2.Type.Str
                }, valid);
              }
              if (it.opts.unevaluated && props !== true) {
                gen.assign((0, codegen_1._)`${props}[${key}]`, true);
              } else if (!alwaysValid && !it.allErrors) {
                gen.if((0, codegen_1.not)(valid), () => gen.break());
              }
            });
          });
        }
      }
    };
    exports.default = def3;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/not.js
var require_not = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/not.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var util_1 = require_util();
    var def3 = {
      keyword: "not",
      schemaType: ["object", "boolean"],
      trackErrors: true,
      code(cxt) {
        const { gen, schema, it } = cxt;
        if ((0, util_1.alwaysValidSchema)(it, schema)) {
          cxt.fail();
          return;
        }
        const valid = gen.name("valid");
        cxt.subschema({
          keyword: "not",
          compositeRule: true,
          createErrors: false,
          allErrors: false
        }, valid);
        cxt.failResult(valid, () => cxt.reset(), () => cxt.error());
      },
      error: { message: "must NOT be valid" }
    };
    exports.default = def3;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/anyOf.js
var require_anyOf = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/anyOf.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var code_1 = require_code2();
    var def3 = {
      keyword: "anyOf",
      schemaType: "array",
      trackErrors: true,
      code: code_1.validateUnion,
      error: { message: "must match a schema in anyOf" }
    };
    exports.default = def3;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/oneOf.js
var require_oneOf = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/oneOf.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error2 = {
      message: "must match exactly one schema in oneOf",
      params: ({ params }) => (0, codegen_1._)`{passingSchemas: ${params.passing}}`
    };
    var def3 = {
      keyword: "oneOf",
      schemaType: "array",
      trackErrors: true,
      error: error2,
      code(cxt) {
        const { gen, schema, parentSchema, it } = cxt;
        if (!Array.isArray(schema))
          throw new Error("ajv implementation error");
        if (it.opts.discriminator && parentSchema.discriminator)
          return;
        const schArr = schema;
        const valid = gen.let("valid", false);
        const passing = gen.let("passing", null);
        const schValid = gen.name("_valid");
        cxt.setParams({ passing });
        gen.block(validateOneOf);
        cxt.result(valid, () => cxt.reset(), () => cxt.error(true));
        function validateOneOf() {
          schArr.forEach((sch, i) => {
            let schCxt;
            if ((0, util_1.alwaysValidSchema)(it, sch)) {
              gen.var(schValid, true);
            } else {
              schCxt = cxt.subschema({
                keyword: "oneOf",
                schemaProp: i,
                compositeRule: true
              }, schValid);
            }
            if (i > 0) {
              gen.if((0, codegen_1._)`${schValid} && ${valid}`).assign(valid, false).assign(passing, (0, codegen_1._)`[${passing}, ${i}]`).else();
            }
            gen.if(schValid, () => {
              gen.assign(valid, true);
              gen.assign(passing, i);
              if (schCxt)
                cxt.mergeEvaluated(schCxt, codegen_1.Name);
            });
          });
        }
      }
    };
    exports.default = def3;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/allOf.js
var require_allOf = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/allOf.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var util_1 = require_util();
    var def3 = {
      keyword: "allOf",
      schemaType: "array",
      code(cxt) {
        const { gen, schema, it } = cxt;
        if (!Array.isArray(schema))
          throw new Error("ajv implementation error");
        const valid = gen.name("valid");
        schema.forEach((sch, i) => {
          if ((0, util_1.alwaysValidSchema)(it, sch))
            return;
          const schCxt = cxt.subschema({ keyword: "allOf", schemaProp: i }, valid);
          cxt.ok(valid);
          cxt.mergeEvaluated(schCxt);
        });
      }
    };
    exports.default = def3;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/if.js
var require_if = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/if.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error2 = {
      message: ({ params }) => (0, codegen_1.str)`must match "${params.ifClause}" schema`,
      params: ({ params }) => (0, codegen_1._)`{failingKeyword: ${params.ifClause}}`
    };
    var def3 = {
      keyword: "if",
      schemaType: ["object", "boolean"],
      trackErrors: true,
      error: error2,
      code(cxt) {
        const { gen, parentSchema, it } = cxt;
        if (parentSchema.then === void 0 && parentSchema.else === void 0) {
          (0, util_1.checkStrictMode)(it, '"if" without "then" and "else" is ignored');
        }
        const hasThen = hasSchema(it, "then");
        const hasElse = hasSchema(it, "else");
        if (!hasThen && !hasElse)
          return;
        const valid = gen.let("valid", true);
        const schValid = gen.name("_valid");
        validateIf();
        cxt.reset();
        if (hasThen && hasElse) {
          const ifClause = gen.let("ifClause");
          cxt.setParams({ ifClause });
          gen.if(schValid, validateClause("then", ifClause), validateClause("else", ifClause));
        } else if (hasThen) {
          gen.if(schValid, validateClause("then"));
        } else {
          gen.if((0, codegen_1.not)(schValid), validateClause("else"));
        }
        cxt.pass(valid, () => cxt.error(true));
        function validateIf() {
          const schCxt = cxt.subschema({
            keyword: "if",
            compositeRule: true,
            createErrors: false,
            allErrors: false
          }, schValid);
          cxt.mergeEvaluated(schCxt);
        }
        function validateClause(keyword, ifClause) {
          return () => {
            const schCxt = cxt.subschema({ keyword }, schValid);
            gen.assign(valid, schValid);
            cxt.mergeValidEvaluated(schCxt, valid);
            if (ifClause)
              gen.assign(ifClause, (0, codegen_1._)`${keyword}`);
            else
              cxt.setParams({ ifClause: keyword });
          };
        }
      }
    };
    function hasSchema(it, keyword) {
      const schema = it.schema[keyword];
      return schema !== void 0 && !(0, util_1.alwaysValidSchema)(it, schema);
    }
    exports.default = def3;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/thenElse.js
var require_thenElse = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/thenElse.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var util_1 = require_util();
    var def3 = {
      keyword: ["then", "else"],
      schemaType: ["object", "boolean"],
      code({ keyword, parentSchema, it }) {
        if (parentSchema.if === void 0)
          (0, util_1.checkStrictMode)(it, `"${keyword}" without "if" is ignored`);
      }
    };
    exports.default = def3;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/index.js
var require_applicator = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var additionalItems_1 = require_additionalItems();
    var prefixItems_1 = require_prefixItems();
    var items_1 = require_items();
    var items2020_1 = require_items2020();
    var contains_1 = require_contains();
    var dependencies_1 = require_dependencies();
    var propertyNames_1 = require_propertyNames();
    var additionalProperties_1 = require_additionalProperties();
    var properties_1 = require_properties();
    var patternProperties_1 = require_patternProperties();
    var not_1 = require_not();
    var anyOf_1 = require_anyOf();
    var oneOf_1 = require_oneOf();
    var allOf_1 = require_allOf();
    var if_1 = require_if();
    var thenElse_1 = require_thenElse();
    function getApplicator(draft2020 = false) {
      const applicator = [
        // any
        not_1.default,
        anyOf_1.default,
        oneOf_1.default,
        allOf_1.default,
        if_1.default,
        thenElse_1.default,
        // object
        propertyNames_1.default,
        additionalProperties_1.default,
        dependencies_1.default,
        properties_1.default,
        patternProperties_1.default
      ];
      if (draft2020)
        applicator.push(prefixItems_1.default, items2020_1.default);
      else
        applicator.push(additionalItems_1.default, items_1.default);
      applicator.push(contains_1.default);
      return applicator;
    }
    exports.default = getApplicator;
  }
});

// node_modules/ajv/dist/vocabularies/format/format.js
var require_format = __commonJS({
  "node_modules/ajv/dist/vocabularies/format/format.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var error2 = {
      message: ({ schemaCode }) => (0, codegen_1.str)`must match format "${schemaCode}"`,
      params: ({ schemaCode }) => (0, codegen_1._)`{format: ${schemaCode}}`
    };
    var def3 = {
      keyword: "format",
      type: ["number", "string"],
      schemaType: "string",
      $data: true,
      error: error2,
      code(cxt, ruleType) {
        const { gen, data, $data, schema, schemaCode, it } = cxt;
        const { opts, errSchemaPath, schemaEnv, self } = it;
        if (!opts.validateFormats)
          return;
        if ($data)
          validate$DataFormat();
        else
          validateFormat();
        function validate$DataFormat() {
          const fmts = gen.scopeValue("formats", {
            ref: self.formats,
            code: opts.code.formats
          });
          const fDef = gen.const("fDef", (0, codegen_1._)`${fmts}[${schemaCode}]`);
          const fType = gen.let("fType");
          const format = gen.let("format");
          gen.if((0, codegen_1._)`typeof ${fDef} == "object" && !(${fDef} instanceof RegExp)`, () => gen.assign(fType, (0, codegen_1._)`${fDef}.type || "string"`).assign(format, (0, codegen_1._)`${fDef}.validate`), () => gen.assign(fType, (0, codegen_1._)`"string"`).assign(format, fDef));
          cxt.fail$data((0, codegen_1.or)(unknownFmt(), invalidFmt()));
          function unknownFmt() {
            if (opts.strictSchema === false)
              return codegen_1.nil;
            return (0, codegen_1._)`${schemaCode} && !${format}`;
          }
          function invalidFmt() {
            const callFormat = schemaEnv.$async ? (0, codegen_1._)`(${fDef}.async ? await ${format}(${data}) : ${format}(${data}))` : (0, codegen_1._)`${format}(${data})`;
            const validData = (0, codegen_1._)`(typeof ${format} == "function" ? ${callFormat} : ${format}.test(${data}))`;
            return (0, codegen_1._)`${format} && ${format} !== true && ${fType} === ${ruleType} && !${validData}`;
          }
        }
        function validateFormat() {
          const formatDef = self.formats[schema];
          if (!formatDef) {
            unknownFormat();
            return;
          }
          if (formatDef === true)
            return;
          const [fmtType, format, fmtRef] = getFormat(formatDef);
          if (fmtType === ruleType)
            cxt.pass(validCondition());
          function unknownFormat() {
            if (opts.strictSchema === false) {
              self.logger.warn(unknownMsg());
              return;
            }
            throw new Error(unknownMsg());
            function unknownMsg() {
              return `unknown format "${schema}" ignored in schema at path "${errSchemaPath}"`;
            }
          }
          function getFormat(fmtDef) {
            const code = fmtDef instanceof RegExp ? (0, codegen_1.regexpCode)(fmtDef) : opts.code.formats ? (0, codegen_1._)`${opts.code.formats}${(0, codegen_1.getProperty)(schema)}` : void 0;
            const fmt = gen.scopeValue("formats", { key: schema, ref: fmtDef, code });
            if (typeof fmtDef == "object" && !(fmtDef instanceof RegExp)) {
              return [fmtDef.type || "string", fmtDef.validate, (0, codegen_1._)`${fmt}.validate`];
            }
            return ["string", fmtDef, fmt];
          }
          function validCondition() {
            if (typeof formatDef == "object" && !(formatDef instanceof RegExp) && formatDef.async) {
              if (!schemaEnv.$async)
                throw new Error("async format in sync schema");
              return (0, codegen_1._)`await ${fmtRef}(${data})`;
            }
            return typeof format == "function" ? (0, codegen_1._)`${fmtRef}(${data})` : (0, codegen_1._)`${fmtRef}.test(${data})`;
          }
        }
      }
    };
    exports.default = def3;
  }
});

// node_modules/ajv/dist/vocabularies/format/index.js
var require_format2 = __commonJS({
  "node_modules/ajv/dist/vocabularies/format/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var format_1 = require_format();
    var format = [format_1.default];
    exports.default = format;
  }
});

// node_modules/ajv/dist/vocabularies/metadata.js
var require_metadata = __commonJS({
  "node_modules/ajv/dist/vocabularies/metadata.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.contentVocabulary = exports.metadataVocabulary = void 0;
    exports.metadataVocabulary = [
      "title",
      "description",
      "default",
      "deprecated",
      "readOnly",
      "writeOnly",
      "examples"
    ];
    exports.contentVocabulary = [
      "contentMediaType",
      "contentEncoding",
      "contentSchema"
    ];
  }
});

// node_modules/ajv/dist/vocabularies/draft7.js
var require_draft7 = __commonJS({
  "node_modules/ajv/dist/vocabularies/draft7.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var core_1 = require_core2();
    var validation_1 = require_validation();
    var applicator_1 = require_applicator();
    var format_1 = require_format2();
    var metadata_1 = require_metadata();
    var draft7Vocabularies = [
      core_1.default,
      validation_1.default,
      (0, applicator_1.default)(),
      format_1.default,
      metadata_1.metadataVocabulary,
      metadata_1.contentVocabulary
    ];
    exports.default = draft7Vocabularies;
  }
});

// node_modules/ajv/dist/vocabularies/discriminator/types.js
var require_types = __commonJS({
  "node_modules/ajv/dist/vocabularies/discriminator/types.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.DiscrError = void 0;
    var DiscrError;
    (function(DiscrError2) {
      DiscrError2["Tag"] = "tag";
      DiscrError2["Mapping"] = "mapping";
    })(DiscrError || (exports.DiscrError = DiscrError = {}));
  }
});

// node_modules/ajv/dist/vocabularies/discriminator/index.js
var require_discriminator = __commonJS({
  "node_modules/ajv/dist/vocabularies/discriminator/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var types_1 = require_types();
    var compile_1 = require_compile();
    var ref_error_1 = require_ref_error();
    var util_1 = require_util();
    var error2 = {
      message: ({ params: { discrError, tagName } }) => discrError === types_1.DiscrError.Tag ? `tag "${tagName}" must be string` : `value of tag "${tagName}" must be in oneOf`,
      params: ({ params: { discrError, tag, tagName } }) => (0, codegen_1._)`{error: ${discrError}, tag: ${tagName}, tagValue: ${tag}}`
    };
    var def3 = {
      keyword: "discriminator",
      type: "object",
      schemaType: "object",
      error: error2,
      code(cxt) {
        const { gen, data, schema, parentSchema, it } = cxt;
        const { oneOf } = parentSchema;
        if (!it.opts.discriminator) {
          throw new Error("discriminator: requires discriminator option");
        }
        const tagName = schema.propertyName;
        if (typeof tagName != "string")
          throw new Error("discriminator: requires propertyName");
        if (schema.mapping)
          throw new Error("discriminator: mapping is not supported");
        if (!oneOf)
          throw new Error("discriminator: requires oneOf keyword");
        const valid = gen.let("valid", false);
        const tag = gen.const("tag", (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(tagName)}`);
        gen.if((0, codegen_1._)`typeof ${tag} == "string"`, () => validateMapping(), () => cxt.error(false, { discrError: types_1.DiscrError.Tag, tag, tagName }));
        cxt.ok(valid);
        function validateMapping() {
          const mapping = getMapping();
          gen.if(false);
          for (const tagValue in mapping) {
            gen.elseIf((0, codegen_1._)`${tag} === ${tagValue}`);
            gen.assign(valid, applyTagSchema(mapping[tagValue]));
          }
          gen.else();
          cxt.error(false, { discrError: types_1.DiscrError.Mapping, tag, tagName });
          gen.endIf();
        }
        function applyTagSchema(schemaProp) {
          const _valid = gen.name("valid");
          const schCxt = cxt.subschema({ keyword: "oneOf", schemaProp }, _valid);
          cxt.mergeEvaluated(schCxt, codegen_1.Name);
          return _valid;
        }
        function getMapping() {
          var _a3;
          const oneOfMapping = {};
          const topRequired = hasRequired(parentSchema);
          let tagRequired = true;
          for (let i = 0; i < oneOf.length; i++) {
            let sch = oneOf[i];
            if ((sch === null || sch === void 0 ? void 0 : sch.$ref) && !(0, util_1.schemaHasRulesButRef)(sch, it.self.RULES)) {
              const ref = sch.$ref;
              sch = compile_1.resolveRef.call(it.self, it.schemaEnv.root, it.baseId, ref);
              if (sch instanceof compile_1.SchemaEnv)
                sch = sch.schema;
              if (sch === void 0)
                throw new ref_error_1.default(it.opts.uriResolver, it.baseId, ref);
            }
            const propSch = (_a3 = sch === null || sch === void 0 ? void 0 : sch.properties) === null || _a3 === void 0 ? void 0 : _a3[tagName];
            if (typeof propSch != "object") {
              throw new Error(`discriminator: oneOf subschemas (or referenced schemas) must have "properties/${tagName}"`);
            }
            tagRequired = tagRequired && (topRequired || hasRequired(sch));
            addMappings(propSch, i);
          }
          if (!tagRequired)
            throw new Error(`discriminator: "${tagName}" must be required`);
          return oneOfMapping;
          function hasRequired({ required: required2 }) {
            return Array.isArray(required2) && required2.includes(tagName);
          }
          function addMappings(sch, i) {
            if (sch.const) {
              addMapping(sch.const, i);
            } else if (sch.enum) {
              for (const tagValue of sch.enum) {
                addMapping(tagValue, i);
              }
            } else {
              throw new Error(`discriminator: "properties/${tagName}" must have "const" or "enum"`);
            }
          }
          function addMapping(tagValue, i) {
            if (typeof tagValue != "string" || tagValue in oneOfMapping) {
              throw new Error(`discriminator: "${tagName}" values must be unique strings`);
            }
            oneOfMapping[tagValue] = i;
          }
        }
      }
    };
    exports.default = def3;
  }
});

// node_modules/ajv/dist/refs/json-schema-draft-07.json
var require_json_schema_draft_07 = __commonJS({
  "node_modules/ajv/dist/refs/json-schema-draft-07.json"(exports, module) {
    module.exports = {
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "http://json-schema.org/draft-07/schema#",
      title: "Core schema meta-schema",
      definitions: {
        schemaArray: {
          type: "array",
          minItems: 1,
          items: { $ref: "#" }
        },
        nonNegativeInteger: {
          type: "integer",
          minimum: 0
        },
        nonNegativeIntegerDefault0: {
          allOf: [{ $ref: "#/definitions/nonNegativeInteger" }, { default: 0 }]
        },
        simpleTypes: {
          enum: ["array", "boolean", "integer", "null", "number", "object", "string"]
        },
        stringArray: {
          type: "array",
          items: { type: "string" },
          uniqueItems: true,
          default: []
        }
      },
      type: ["object", "boolean"],
      properties: {
        $id: {
          type: "string",
          format: "uri-reference"
        },
        $schema: {
          type: "string",
          format: "uri"
        },
        $ref: {
          type: "string",
          format: "uri-reference"
        },
        $comment: {
          type: "string"
        },
        title: {
          type: "string"
        },
        description: {
          type: "string"
        },
        default: true,
        readOnly: {
          type: "boolean",
          default: false
        },
        examples: {
          type: "array",
          items: true
        },
        multipleOf: {
          type: "number",
          exclusiveMinimum: 0
        },
        maximum: {
          type: "number"
        },
        exclusiveMaximum: {
          type: "number"
        },
        minimum: {
          type: "number"
        },
        exclusiveMinimum: {
          type: "number"
        },
        maxLength: { $ref: "#/definitions/nonNegativeInteger" },
        minLength: { $ref: "#/definitions/nonNegativeIntegerDefault0" },
        pattern: {
          type: "string",
          format: "regex"
        },
        additionalItems: { $ref: "#" },
        items: {
          anyOf: [{ $ref: "#" }, { $ref: "#/definitions/schemaArray" }],
          default: true
        },
        maxItems: { $ref: "#/definitions/nonNegativeInteger" },
        minItems: { $ref: "#/definitions/nonNegativeIntegerDefault0" },
        uniqueItems: {
          type: "boolean",
          default: false
        },
        contains: { $ref: "#" },
        maxProperties: { $ref: "#/definitions/nonNegativeInteger" },
        minProperties: { $ref: "#/definitions/nonNegativeIntegerDefault0" },
        required: { $ref: "#/definitions/stringArray" },
        additionalProperties: { $ref: "#" },
        definitions: {
          type: "object",
          additionalProperties: { $ref: "#" },
          default: {}
        },
        properties: {
          type: "object",
          additionalProperties: { $ref: "#" },
          default: {}
        },
        patternProperties: {
          type: "object",
          additionalProperties: { $ref: "#" },
          propertyNames: { format: "regex" },
          default: {}
        },
        dependencies: {
          type: "object",
          additionalProperties: {
            anyOf: [{ $ref: "#" }, { $ref: "#/definitions/stringArray" }]
          }
        },
        propertyNames: { $ref: "#" },
        const: true,
        enum: {
          type: "array",
          items: true,
          minItems: 1,
          uniqueItems: true
        },
        type: {
          anyOf: [
            { $ref: "#/definitions/simpleTypes" },
            {
              type: "array",
              items: { $ref: "#/definitions/simpleTypes" },
              minItems: 1,
              uniqueItems: true
            }
          ]
        },
        format: { type: "string" },
        contentMediaType: { type: "string" },
        contentEncoding: { type: "string" },
        if: { $ref: "#" },
        then: { $ref: "#" },
        else: { $ref: "#" },
        allOf: { $ref: "#/definitions/schemaArray" },
        anyOf: { $ref: "#/definitions/schemaArray" },
        oneOf: { $ref: "#/definitions/schemaArray" },
        not: { $ref: "#" }
      },
      default: true
    };
  }
});

// node_modules/ajv/dist/ajv.js
var require_ajv = __commonJS({
  "node_modules/ajv/dist/ajv.js"(exports, module) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MissingRefError = exports.ValidationError = exports.CodeGen = exports.Name = exports.nil = exports.stringify = exports.str = exports._ = exports.KeywordCxt = exports.Ajv = void 0;
    var core_1 = require_core();
    var draft7_1 = require_draft7();
    var discriminator_1 = require_discriminator();
    var draft7MetaSchema = require_json_schema_draft_07();
    var META_SUPPORT_DATA = ["/properties"];
    var META_SCHEMA_ID = "http://json-schema.org/draft-07/schema";
    var Ajv2 = class extends core_1.default {
      _addVocabularies() {
        super._addVocabularies();
        draft7_1.default.forEach((v) => this.addVocabulary(v));
        if (this.opts.discriminator)
          this.addKeyword(discriminator_1.default);
      }
      _addDefaultMetaSchema() {
        super._addDefaultMetaSchema();
        if (!this.opts.meta)
          return;
        const metaSchema = this.opts.$data ? this.$dataMetaSchema(draft7MetaSchema, META_SUPPORT_DATA) : draft7MetaSchema;
        this.addMetaSchema(metaSchema, META_SCHEMA_ID, false);
        this.refs["http://json-schema.org/schema"] = META_SCHEMA_ID;
      }
      defaultMeta() {
        return this.opts.defaultMeta = super.defaultMeta() || (this.getSchema(META_SCHEMA_ID) ? META_SCHEMA_ID : void 0);
      }
    };
    exports.Ajv = Ajv2;
    module.exports = exports = Ajv2;
    module.exports.Ajv = Ajv2;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.default = Ajv2;
    var validate_1 = require_validate();
    Object.defineProperty(exports, "KeywordCxt", { enumerable: true, get: function() {
      return validate_1.KeywordCxt;
    } });
    var codegen_1 = require_codegen();
    Object.defineProperty(exports, "_", { enumerable: true, get: function() {
      return codegen_1._;
    } });
    Object.defineProperty(exports, "str", { enumerable: true, get: function() {
      return codegen_1.str;
    } });
    Object.defineProperty(exports, "stringify", { enumerable: true, get: function() {
      return codegen_1.stringify;
    } });
    Object.defineProperty(exports, "nil", { enumerable: true, get: function() {
      return codegen_1.nil;
    } });
    Object.defineProperty(exports, "Name", { enumerable: true, get: function() {
      return codegen_1.Name;
    } });
    Object.defineProperty(exports, "CodeGen", { enumerable: true, get: function() {
      return codegen_1.CodeGen;
    } });
    var validation_error_1 = require_validation_error();
    Object.defineProperty(exports, "ValidationError", { enumerable: true, get: function() {
      return validation_error_1.default;
    } });
    var ref_error_1 = require_ref_error();
    Object.defineProperty(exports, "MissingRefError", { enumerable: true, get: function() {
      return ref_error_1.default;
    } });
  }
});

// node_modules/ajv-formats/dist/formats.js
var require_formats = __commonJS({
  "node_modules/ajv-formats/dist/formats.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.formatNames = exports.fastFormats = exports.fullFormats = void 0;
    function fmtDef(validate2, compare) {
      return { validate: validate2, compare };
    }
    exports.fullFormats = {
      // date: http://tools.ietf.org/html/rfc3339#section-5.6
      date: fmtDef(date3, compareDate),
      // date-time: http://tools.ietf.org/html/rfc3339#section-5.6
      time: fmtDef(getTime(true), compareTime),
      "date-time": fmtDef(getDateTime(true), compareDateTime),
      "iso-time": fmtDef(getTime(), compareIsoTime),
      "iso-date-time": fmtDef(getDateTime(), compareIsoDateTime),
      // duration: https://tools.ietf.org/html/rfc3339#appendix-A
      duration: /^P(?!$)((\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?|(\d+W)?)$/,
      uri,
      "uri-reference": /^(?:[a-z][a-z0-9+\-.]*:)?(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'"()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?(?:\?(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i,
      // uri-template: https://tools.ietf.org/html/rfc6570
      "uri-template": /^(?:(?:[^\x00-\x20"'<>%\\^`{|}]|%[0-9a-f]{2})|\{[+#./;?&=,!@|]?(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?(?:,(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?)*\})*$/i,
      // For the source: https://gist.github.com/dperini/729294
      // For test cases: https://mathiasbynens.be/demo/url-regex
      url: /^(?:https?|ftp):\/\/(?:\S+(?::\S*)?@)?(?:(?!(?:10|127)(?:\.\d{1,3}){3})(?!(?:169\.254|192\.168)(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z0-9\u{00a1}-\u{ffff}]+-)*[a-z0-9\u{00a1}-\u{ffff}]+)(?:\.(?:[a-z0-9\u{00a1}-\u{ffff}]+-)*[a-z0-9\u{00a1}-\u{ffff}]+)*(?:\.(?:[a-z\u{00a1}-\u{ffff}]{2,})))(?::\d{2,5})?(?:\/[^\s]*)?$/iu,
      email: /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i,
      hostname: /^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-0-9a-z]{0,61}[0-9a-z])?)*\.?$/i,
      // optimized https://www.safaribooksonline.com/library/view/regular-expressions-cookbook/9780596802837/ch07s16.html
      ipv4: /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/,
      ipv6: /^((([0-9a-f]{1,4}:){7}([0-9a-f]{1,4}|:))|(([0-9a-f]{1,4}:){6}(:[0-9a-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){5}(((:[0-9a-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){4}(((:[0-9a-f]{1,4}){1,3})|((:[0-9a-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){3}(((:[0-9a-f]{1,4}){1,4})|((:[0-9a-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){2}(((:[0-9a-f]{1,4}){1,5})|((:[0-9a-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){1}(((:[0-9a-f]{1,4}){1,6})|((:[0-9a-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9a-f]{1,4}){1,7})|((:[0-9a-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))$/i,
      regex,
      // uuid: http://tools.ietf.org/html/rfc4122
      uuid: /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i,
      // JSON-pointer: https://tools.ietf.org/html/rfc6901
      // uri fragment: https://tools.ietf.org/html/rfc3986#appendix-A
      "json-pointer": /^(?:\/(?:[^~/]|~0|~1)*)*$/,
      "json-pointer-uri-fragment": /^#(?:\/(?:[a-z0-9_\-.!$&'()*+,;:=@]|%[0-9a-f]{2}|~0|~1)*)*$/i,
      // relative JSON-pointer: http://tools.ietf.org/html/draft-luff-relative-json-pointer-00
      "relative-json-pointer": /^(?:0|[1-9][0-9]*)(?:#|(?:\/(?:[^~/]|~0|~1)*)*)$/,
      // the following formats are used by the openapi specification: https://spec.openapis.org/oas/v3.0.0#data-types
      // byte: https://github.com/miguelmota/is-base64
      byte,
      // signed 32 bit integer
      int32: { type: "number", validate: validateInt32 },
      // signed 64 bit integer
      int64: { type: "number", validate: validateInt64 },
      // C-type float
      float: { type: "number", validate: validateNumber },
      // C-type double
      double: { type: "number", validate: validateNumber },
      // hint to the UI to hide input strings
      password: true,
      // unchecked string payload
      binary: true
    };
    exports.fastFormats = {
      ...exports.fullFormats,
      date: fmtDef(/^\d\d\d\d-[0-1]\d-[0-3]\d$/, compareDate),
      time: fmtDef(/^(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)$/i, compareTime),
      "date-time": fmtDef(/^\d\d\d\d-[0-1]\d-[0-3]\dt(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)$/i, compareDateTime),
      "iso-time": fmtDef(/^(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)?$/i, compareIsoTime),
      "iso-date-time": fmtDef(/^\d\d\d\d-[0-1]\d-[0-3]\d[t\s](?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)?$/i, compareIsoDateTime),
      // uri: https://github.com/mafintosh/is-my-json-valid/blob/master/formats.js
      uri: /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/)?[^\s]*$/i,
      "uri-reference": /^(?:(?:[a-z][a-z0-9+\-.]*:)?\/?\/)?(?:[^\\\s#][^\s#]*)?(?:#[^\\\s]*)?$/i,
      // email (sources from jsen validator):
      // http://stackoverflow.com/questions/201323/using-a-regular-expression-to-validate-an-email-address#answer-8829363
      // http://www.w3.org/TR/html5/forms.html#valid-e-mail-address (search for 'wilful violation')
      email: /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i
    };
    exports.formatNames = Object.keys(exports.fullFormats);
    function isLeapYear(year) {
      return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    }
    var DATE = /^(\d\d\d\d)-(\d\d)-(\d\d)$/;
    var DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    function date3(str3) {
      const matches = DATE.exec(str3);
      if (!matches)
        return false;
      const year = +matches[1];
      const month = +matches[2];
      const day = +matches[3];
      return month >= 1 && month <= 12 && day >= 1 && day <= (month === 2 && isLeapYear(year) ? 29 : DAYS[month]);
    }
    function compareDate(d1, d2) {
      if (!(d1 && d2))
        return void 0;
      if (d1 > d2)
        return 1;
      if (d1 < d2)
        return -1;
      return 0;
    }
    var TIME = /^(\d\d):(\d\d):(\d\d(?:\.\d+)?)(z|([+-])(\d\d)(?::?(\d\d))?)?$/i;
    function getTime(strictTimeZone) {
      return function time3(str3) {
        const matches = TIME.exec(str3);
        if (!matches)
          return false;
        const hr = +matches[1];
        const min = +matches[2];
        const sec = +matches[3];
        const tz = matches[4];
        const tzSign = matches[5] === "-" ? -1 : 1;
        const tzH = +(matches[6] || 0);
        const tzM = +(matches[7] || 0);
        if (tzH > 23 || tzM > 59 || strictTimeZone && !tz)
          return false;
        if (hr <= 23 && min <= 59 && sec < 60)
          return true;
        const utcMin = min - tzM * tzSign;
        const utcHr = hr - tzH * tzSign - (utcMin < 0 ? 1 : 0);
        return (utcHr === 23 || utcHr === -1) && (utcMin === 59 || utcMin === -1) && sec < 61;
      };
    }
    function compareTime(s1, s2) {
      if (!(s1 && s2))
        return void 0;
      const t1 = (/* @__PURE__ */ new Date("2020-01-01T" + s1)).valueOf();
      const t2 = (/* @__PURE__ */ new Date("2020-01-01T" + s2)).valueOf();
      if (!(t1 && t2))
        return void 0;
      return t1 - t2;
    }
    function compareIsoTime(t1, t2) {
      if (!(t1 && t2))
        return void 0;
      const a1 = TIME.exec(t1);
      const a2 = TIME.exec(t2);
      if (!(a1 && a2))
        return void 0;
      t1 = a1[1] + a1[2] + a1[3];
      t2 = a2[1] + a2[2] + a2[3];
      if (t1 > t2)
        return 1;
      if (t1 < t2)
        return -1;
      return 0;
    }
    var DATE_TIME_SEPARATOR = /t|\s/i;
    function getDateTime(strictTimeZone) {
      const time3 = getTime(strictTimeZone);
      return function date_time(str3) {
        const dateTime = str3.split(DATE_TIME_SEPARATOR);
        return dateTime.length === 2 && date3(dateTime[0]) && time3(dateTime[1]);
      };
    }
    function compareDateTime(dt1, dt2) {
      if (!(dt1 && dt2))
        return void 0;
      const d1 = new Date(dt1).valueOf();
      const d2 = new Date(dt2).valueOf();
      if (!(d1 && d2))
        return void 0;
      return d1 - d2;
    }
    function compareIsoDateTime(dt1, dt2) {
      if (!(dt1 && dt2))
        return void 0;
      const [d1, t1] = dt1.split(DATE_TIME_SEPARATOR);
      const [d2, t2] = dt2.split(DATE_TIME_SEPARATOR);
      const res = compareDate(d1, d2);
      if (res === void 0)
        return void 0;
      return res || compareTime(t1, t2);
    }
    var NOT_URI_FRAGMENT = /\/|:/;
    var URI = /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)(?:\?(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i;
    function uri(str3) {
      return NOT_URI_FRAGMENT.test(str3) && URI.test(str3);
    }
    var BYTE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/gm;
    function byte(str3) {
      BYTE.lastIndex = 0;
      return BYTE.test(str3);
    }
    var MIN_INT32 = -(2 ** 31);
    var MAX_INT32 = 2 ** 31 - 1;
    function validateInt32(value) {
      return Number.isInteger(value) && value <= MAX_INT32 && value >= MIN_INT32;
    }
    function validateInt64(value) {
      return Number.isInteger(value);
    }
    function validateNumber() {
      return true;
    }
    var Z_ANCHOR = /[^\\]\\Z/;
    function regex(str3) {
      if (Z_ANCHOR.test(str3))
        return false;
      try {
        new RegExp(str3);
        return true;
      } catch (e) {
        return false;
      }
    }
  }
});

// node_modules/ajv-formats/dist/limit.js
var require_limit = __commonJS({
  "node_modules/ajv-formats/dist/limit.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.formatLimitDefinition = void 0;
    var ajv_1 = require_ajv();
    var codegen_1 = require_codegen();
    var ops = codegen_1.operators;
    var KWDs = {
      formatMaximum: { okStr: "<=", ok: ops.LTE, fail: ops.GT },
      formatMinimum: { okStr: ">=", ok: ops.GTE, fail: ops.LT },
      formatExclusiveMaximum: { okStr: "<", ok: ops.LT, fail: ops.GTE },
      formatExclusiveMinimum: { okStr: ">", ok: ops.GT, fail: ops.LTE }
    };
    var error2 = {
      message: ({ keyword, schemaCode }) => (0, codegen_1.str)`should be ${KWDs[keyword].okStr} ${schemaCode}`,
      params: ({ keyword, schemaCode }) => (0, codegen_1._)`{comparison: ${KWDs[keyword].okStr}, limit: ${schemaCode}}`
    };
    exports.formatLimitDefinition = {
      keyword: Object.keys(KWDs),
      type: "string",
      schemaType: "string",
      $data: true,
      error: error2,
      code(cxt) {
        const { gen, data, schemaCode, keyword, it } = cxt;
        const { opts, self } = it;
        if (!opts.validateFormats)
          return;
        const fCxt = new ajv_1.KeywordCxt(it, self.RULES.all.format.definition, "format");
        if (fCxt.$data)
          validate$DataFormat();
        else
          validateFormat();
        function validate$DataFormat() {
          const fmts = gen.scopeValue("formats", {
            ref: self.formats,
            code: opts.code.formats
          });
          const fmt = gen.const("fmt", (0, codegen_1._)`${fmts}[${fCxt.schemaCode}]`);
          cxt.fail$data((0, codegen_1.or)((0, codegen_1._)`typeof ${fmt} != "object"`, (0, codegen_1._)`${fmt} instanceof RegExp`, (0, codegen_1._)`typeof ${fmt}.compare != "function"`, compareCode(fmt)));
        }
        function validateFormat() {
          const format = fCxt.schema;
          const fmtDef = self.formats[format];
          if (!fmtDef || fmtDef === true)
            return;
          if (typeof fmtDef != "object" || fmtDef instanceof RegExp || typeof fmtDef.compare != "function") {
            throw new Error(`"${keyword}": format "${format}" does not define "compare" function`);
          }
          const fmt = gen.scopeValue("formats", {
            key: format,
            ref: fmtDef,
            code: opts.code.formats ? (0, codegen_1._)`${opts.code.formats}${(0, codegen_1.getProperty)(format)}` : void 0
          });
          cxt.fail$data(compareCode(fmt));
        }
        function compareCode(fmt) {
          return (0, codegen_1._)`${fmt}.compare(${data}, ${schemaCode}) ${KWDs[keyword].fail} 0`;
        }
      },
      dependencies: ["format"]
    };
    var formatLimitPlugin = (ajv) => {
      ajv.addKeyword(exports.formatLimitDefinition);
      return ajv;
    };
    exports.default = formatLimitPlugin;
  }
});

// node_modules/ajv-formats/dist/index.js
var require_dist = __commonJS({
  "node_modules/ajv-formats/dist/index.js"(exports, module) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var formats_1 = require_formats();
    var limit_1 = require_limit();
    var codegen_1 = require_codegen();
    var fullName = new codegen_1.Name("fullFormats");
    var fastName = new codegen_1.Name("fastFormats");
    var formatsPlugin = (ajv, opts = { keywords: true }) => {
      if (Array.isArray(opts)) {
        addFormats(ajv, opts, formats_1.fullFormats, fullName);
        return ajv;
      }
      const [formats, exportName] = opts.mode === "fast" ? [formats_1.fastFormats, fastName] : [formats_1.fullFormats, fullName];
      const list = opts.formats || formats_1.formatNames;
      addFormats(ajv, list, formats, exportName);
      if (opts.keywords)
        (0, limit_1.default)(ajv);
      return ajv;
    };
    formatsPlugin.get = (name, mode = "full") => {
      const formats = mode === "fast" ? formats_1.fastFormats : formats_1.fullFormats;
      const f = formats[name];
      if (!f)
        throw new Error(`Unknown format "${name}"`);
      return f;
    };
    function addFormats(ajv, list, fs, exportName) {
      var _a3;
      var _b;
      (_a3 = (_b = ajv.opts.code).formats) !== null && _a3 !== void 0 ? _a3 : _b.formats = (0, codegen_1._)`require("ajv-formats/dist/formats").${exportName}`;
      for (const f of list)
        ajv.addFormat(f, fs[f]);
    }
    module.exports = exports = formatsPlugin;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.default = formatsPlugin;
  }
});

// node_modules/@modelcontextprotocol/sdk/dist/esm/validation/ajv-provider.js
function createDefaultAjvInstance() {
  const ajv = new import_ajv.default({
    strict: false,
    validateFormats: true,
    validateSchema: false,
    allErrors: true
  });
  const addFormats = import_ajv_formats.default;
  addFormats(ajv);
  return ajv;
}
var import_ajv, import_ajv_formats, AjvJsonSchemaValidator;
var init_ajv_provider = __esm({
  "node_modules/@modelcontextprotocol/sdk/dist/esm/validation/ajv-provider.js"() {
    import_ajv = __toESM(require_ajv(), 1);
    import_ajv_formats = __toESM(require_dist(), 1);
    AjvJsonSchemaValidator = class {
      /**
       * Create an AJV validator
       *
       * @param ajv - Optional pre-configured AJV instance. If not provided, a default instance will be created.
       *
       * @example
       * ```typescript
       * // Use default configuration (recommended for most cases)
       * import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
       * const validator = new AjvJsonSchemaValidator();
       *
       * // Or provide custom AJV instance for advanced configuration
       * import { Ajv } from 'ajv';
       * import addFormats from 'ajv-formats';
       *
       * const ajv = new Ajv({ validateFormats: true });
       * addFormats(ajv);
       * const validator = new AjvJsonSchemaValidator(ajv);
       * ```
       */
      constructor(ajv) {
        this._ajv = ajv ?? createDefaultAjvInstance();
      }
      /**
       * Create a validator for the given JSON Schema
       *
       * The validator is compiled once and can be reused multiple times.
       * If the schema has an $id, it will be cached by AJV automatically.
       *
       * @param schema - Standard JSON Schema object
       * @returns A validator function that validates input data
       */
      getValidator(schema) {
        const ajvValidator = "$id" in schema && typeof schema.$id === "string" ? this._ajv.getSchema(schema.$id) ?? this._ajv.compile(schema) : this._ajv.compile(schema);
        return (input) => {
          const valid = ajvValidator(input);
          if (valid) {
            return {
              valid: true,
              data: input,
              errorMessage: void 0
            };
          } else {
            return {
              valid: false,
              data: void 0,
              errorMessage: this._ajv.errorsText(ajvValidator.errors)
            };
          }
        };
      }
    };
  }
});

// node_modules/@modelcontextprotocol/sdk/dist/esm/experimental/tasks/server.js
var ExperimentalServerTasks;
var init_server = __esm({
  "node_modules/@modelcontextprotocol/sdk/dist/esm/experimental/tasks/server.js"() {
    init_types();
    ExperimentalServerTasks = class {
      constructor(_server) {
        this._server = _server;
      }
      /**
       * Sends a request and returns an AsyncGenerator that yields response messages.
       * The generator is guaranteed to end with either a 'result' or 'error' message.
       *
       * This method provides streaming access to request processing, allowing you to
       * observe intermediate task status updates for task-augmented requests.
       *
       * @param request - The request to send
       * @param resultSchema - Zod schema for validating the result
       * @param options - Optional request options (timeout, signal, task creation params, etc.)
       * @returns AsyncGenerator that yields ResponseMessage objects
       *
       * @experimental
       */
      requestStream(request2, resultSchema, options) {
        return this._server.requestStream(request2, resultSchema, options);
      }
      /**
       * Sends a sampling request and returns an AsyncGenerator that yields response messages.
       * The generator is guaranteed to end with either a 'result' or 'error' message.
       *
       * For task-augmented requests, yields 'taskCreated' and 'taskStatus' messages
       * before the final result.
       *
       * @example
       * ```typescript
       * const stream = server.experimental.tasks.createMessageStream({
       *     messages: [{ role: 'user', content: { type: 'text', text: 'Hello' } }],
       *     maxTokens: 100
       * }, {
       *     onprogress: (progress) => {
       *         // Handle streaming tokens via progress notifications
       *         console.log('Progress:', progress.message);
       *     }
       * });
       *
       * for await (const message of stream) {
       *     switch (message.type) {
       *         case 'taskCreated':
       *             console.log('Task created:', message.task.taskId);
       *             break;
       *         case 'taskStatus':
       *             console.log('Task status:', message.task.status);
       *             break;
       *         case 'result':
       *             console.log('Final result:', message.result);
       *             break;
       *         case 'error':
       *             console.error('Error:', message.error);
       *             break;
       *     }
       * }
       * ```
       *
       * @param params - The sampling request parameters
       * @param options - Optional request options (timeout, signal, task creation params, onprogress, etc.)
       * @returns AsyncGenerator that yields ResponseMessage objects
       *
       * @experimental
       */
      createMessageStream(params, options) {
        const clientCapabilities = this._server.getClientCapabilities();
        if ((params.tools || params.toolChoice) && !clientCapabilities?.sampling?.tools) {
          throw new Error("Client does not support sampling tools capability.");
        }
        if (params.messages.length > 0) {
          const lastMessage = params.messages[params.messages.length - 1];
          const lastContent = Array.isArray(lastMessage.content) ? lastMessage.content : [lastMessage.content];
          const hasToolResults = lastContent.some((c) => c.type === "tool_result");
          const previousMessage = params.messages.length > 1 ? params.messages[params.messages.length - 2] : void 0;
          const previousContent = previousMessage ? Array.isArray(previousMessage.content) ? previousMessage.content : [previousMessage.content] : [];
          const hasPreviousToolUse = previousContent.some((c) => c.type === "tool_use");
          if (hasToolResults) {
            if (lastContent.some((c) => c.type !== "tool_result")) {
              throw new Error("The last message must contain only tool_result content if any is present");
            }
            if (!hasPreviousToolUse) {
              throw new Error("tool_result blocks are not matching any tool_use from the previous message");
            }
          }
          if (hasPreviousToolUse) {
            const toolUseIds = new Set(previousContent.filter((c) => c.type === "tool_use").map((c) => c.id));
            const toolResultIds = new Set(lastContent.filter((c) => c.type === "tool_result").map((c) => c.toolUseId));
            if (toolUseIds.size !== toolResultIds.size || ![...toolUseIds].every((id) => toolResultIds.has(id))) {
              throw new Error("ids of tool_result blocks and tool_use blocks from previous message do not match");
            }
          }
        }
        return this.requestStream({
          method: "sampling/createMessage",
          params
        }, CreateMessageResultSchema, options);
      }
      /**
       * Sends an elicitation request and returns an AsyncGenerator that yields response messages.
       * The generator is guaranteed to end with either a 'result' or 'error' message.
       *
       * For task-augmented requests (especially URL-based elicitation), yields 'taskCreated'
       * and 'taskStatus' messages before the final result.
       *
       * @example
       * ```typescript
       * const stream = server.experimental.tasks.elicitInputStream({
       *     mode: 'url',
       *     message: 'Please authenticate',
       *     elicitationId: 'auth-123',
       *     url: 'https://example.com/auth'
       * }, {
       *     task: { ttl: 300000 } // Task-augmented for long-running auth flow
       * });
       *
       * for await (const message of stream) {
       *     switch (message.type) {
       *         case 'taskCreated':
       *             console.log('Task created:', message.task.taskId);
       *             break;
       *         case 'taskStatus':
       *             console.log('Task status:', message.task.status);
       *             break;
       *         case 'result':
       *             console.log('User action:', message.result.action);
       *             break;
       *         case 'error':
       *             console.error('Error:', message.error);
       *             break;
       *     }
       * }
       * ```
       *
       * @param params - The elicitation request parameters
       * @param options - Optional request options (timeout, signal, task creation params, etc.)
       * @returns AsyncGenerator that yields ResponseMessage objects
       *
       * @experimental
       */
      elicitInputStream(params, options) {
        const clientCapabilities = this._server.getClientCapabilities();
        const mode = params.mode ?? "form";
        switch (mode) {
          case "url": {
            if (!clientCapabilities?.elicitation?.url) {
              throw new Error("Client does not support url elicitation.");
            }
            break;
          }
          case "form": {
            if (!clientCapabilities?.elicitation?.form) {
              throw new Error("Client does not support form elicitation.");
            }
            break;
          }
        }
        const normalizedParams = mode === "form" && params.mode === void 0 ? { ...params, mode: "form" } : params;
        return this.requestStream({
          method: "elicitation/create",
          params: normalizedParams
        }, ElicitResultSchema, options);
      }
      /**
       * Gets the current status of a task.
       *
       * @param taskId - The task identifier
       * @param options - Optional request options
       * @returns The task status
       *
       * @experimental
       */
      async getTask(taskId, options) {
        return this._server.getTask({ taskId }, options);
      }
      /**
       * Retrieves the result of a completed task.
       *
       * @param taskId - The task identifier
       * @param resultSchema - Zod schema for validating the result
       * @param options - Optional request options
       * @returns The task result
       *
       * @experimental
       */
      async getTaskResult(taskId, resultSchema, options) {
        return this._server.getTaskResult({ taskId }, resultSchema, options);
      }
      /**
       * Lists tasks with optional pagination.
       *
       * @param cursor - Optional pagination cursor
       * @param options - Optional request options
       * @returns List of tasks with optional next cursor
       *
       * @experimental
       */
      async listTasks(cursor, options) {
        return this._server.listTasks(cursor ? { cursor } : void 0, options);
      }
      /**
       * Cancels a running task.
       *
       * @param taskId - The task identifier
       * @param options - Optional request options
       *
       * @experimental
       */
      async cancelTask(taskId, options) {
        return this._server.cancelTask({ taskId }, options);
      }
    };
  }
});

// node_modules/@modelcontextprotocol/sdk/dist/esm/experimental/tasks/helpers.js
function assertToolsCallTaskCapability(requests, method, entityName) {
  if (!requests) {
    throw new Error(`${entityName} does not support task creation (required for ${method})`);
  }
  switch (method) {
    case "tools/call":
      if (!requests.tools?.call) {
        throw new Error(`${entityName} does not support task creation for tools/call (required for ${method})`);
      }
      break;
    default:
      break;
  }
}
function assertClientRequestTaskCapability(requests, method, entityName) {
  if (!requests) {
    throw new Error(`${entityName} does not support task creation (required for ${method})`);
  }
  switch (method) {
    case "sampling/createMessage":
      if (!requests.sampling?.createMessage) {
        throw new Error(`${entityName} does not support task creation for sampling/createMessage (required for ${method})`);
      }
      break;
    case "elicitation/create":
      if (!requests.elicitation?.create) {
        throw new Error(`${entityName} does not support task creation for elicitation/create (required for ${method})`);
      }
      break;
    default:
      break;
  }
}
var init_helpers = __esm({
  "node_modules/@modelcontextprotocol/sdk/dist/esm/experimental/tasks/helpers.js"() {
  }
});

// node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js
var Server;
var init_server2 = __esm({
  "node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js"() {
    init_protocol2();
    init_types();
    init_ajv_provider();
    init_zod_compat();
    init_server();
    init_helpers();
    Server = class extends Protocol {
      /**
       * Initializes this server with the given name and version information.
       */
      constructor(_serverInfo, options) {
        super(options);
        this._serverInfo = _serverInfo;
        this._loggingLevels = /* @__PURE__ */ new Map();
        this.LOG_LEVEL_SEVERITY = new Map(LoggingLevelSchema.options.map((level, index) => [level, index]));
        this.isMessageIgnored = (level, sessionId) => {
          const currentLevel = this._loggingLevels.get(sessionId);
          return currentLevel ? this.LOG_LEVEL_SEVERITY.get(level) < this.LOG_LEVEL_SEVERITY.get(currentLevel) : false;
        };
        this._capabilities = options?.capabilities ?? {};
        this._instructions = options?.instructions;
        this._jsonSchemaValidator = options?.jsonSchemaValidator ?? new AjvJsonSchemaValidator();
        this.setRequestHandler(InitializeRequestSchema, (request2) => this._oninitialize(request2));
        this.setNotificationHandler(InitializedNotificationSchema, () => this.oninitialized?.());
        if (this._capabilities.logging) {
          this.setRequestHandler(SetLevelRequestSchema, async (request2, extra) => {
            const transportSessionId = extra.sessionId || extra.requestInfo?.headers["mcp-session-id"] || void 0;
            const { level } = request2.params;
            const parseResult = LoggingLevelSchema.safeParse(level);
            if (parseResult.success) {
              this._loggingLevels.set(transportSessionId, parseResult.data);
            }
            return {};
          });
        }
      }
      /**
       * Access experimental features.
       *
       * WARNING: These APIs are experimental and may change without notice.
       *
       * @experimental
       */
      get experimental() {
        if (!this._experimental) {
          this._experimental = {
            tasks: new ExperimentalServerTasks(this)
          };
        }
        return this._experimental;
      }
      /**
       * Registers new capabilities. This can only be called before connecting to a transport.
       *
       * The new capabilities will be merged with any existing capabilities previously given (e.g., at initialization).
       */
      registerCapabilities(capabilities) {
        if (this.transport) {
          throw new Error("Cannot register capabilities after connecting to transport");
        }
        this._capabilities = mergeCapabilities(this._capabilities, capabilities);
      }
      /**
       * Override request handler registration to enforce server-side validation for tools/call.
       */
      setRequestHandler(requestSchema, handler) {
        const shape = getObjectShape(requestSchema);
        const methodSchema = shape?.method;
        if (!methodSchema) {
          throw new Error("Schema is missing a method literal");
        }
        const methodValue = getLiteralValue(methodSchema);
        if (typeof methodValue !== "string") {
          throw new Error("Schema method literal must be a string");
        }
        const method = methodValue;
        if (method === "tools/call") {
          const wrappedHandler = async (request2, extra) => {
            const validatedRequest = safeParse3(CallToolRequestSchema, request2);
            if (!validatedRequest.success) {
              const errorMessage = validatedRequest.error instanceof Error ? validatedRequest.error.message : String(validatedRequest.error);
              throw new McpError(ErrorCode.InvalidParams, `Invalid tools/call request: ${errorMessage}`);
            }
            const { params } = validatedRequest.data;
            const result = await Promise.resolve(handler(request2, extra));
            if (params.task) {
              const taskValidationResult = safeParse3(CreateTaskResultSchema, result);
              if (!taskValidationResult.success) {
                const errorMessage = taskValidationResult.error instanceof Error ? taskValidationResult.error.message : String(taskValidationResult.error);
                throw new McpError(ErrorCode.InvalidParams, `Invalid task creation result: ${errorMessage}`);
              }
              return taskValidationResult.data;
            }
            const validationResult = safeParse3(CallToolResultSchema, result);
            if (!validationResult.success) {
              const errorMessage = validationResult.error instanceof Error ? validationResult.error.message : String(validationResult.error);
              throw new McpError(ErrorCode.InvalidParams, `Invalid tools/call result: ${errorMessage}`);
            }
            return validationResult.data;
          };
          return super.setRequestHandler(requestSchema, wrappedHandler);
        }
        return super.setRequestHandler(requestSchema, handler);
      }
      assertCapabilityForMethod(method) {
        switch (method) {
          case "sampling/createMessage":
            if (!this._clientCapabilities?.sampling) {
              throw new Error(`Client does not support sampling (required for ${method})`);
            }
            break;
          case "elicitation/create":
            if (!this._clientCapabilities?.elicitation) {
              throw new Error(`Client does not support elicitation (required for ${method})`);
            }
            break;
          case "roots/list":
            if (!this._clientCapabilities?.roots) {
              throw new Error(`Client does not support listing roots (required for ${method})`);
            }
            break;
          case "ping":
            break;
        }
      }
      assertNotificationCapability(method) {
        switch (method) {
          case "notifications/message":
            if (!this._capabilities.logging) {
              throw new Error(`Server does not support logging (required for ${method})`);
            }
            break;
          case "notifications/resources/updated":
          case "notifications/resources/list_changed":
            if (!this._capabilities.resources) {
              throw new Error(`Server does not support notifying about resources (required for ${method})`);
            }
            break;
          case "notifications/tools/list_changed":
            if (!this._capabilities.tools) {
              throw new Error(`Server does not support notifying of tool list changes (required for ${method})`);
            }
            break;
          case "notifications/prompts/list_changed":
            if (!this._capabilities.prompts) {
              throw new Error(`Server does not support notifying of prompt list changes (required for ${method})`);
            }
            break;
          case "notifications/elicitation/complete":
            if (!this._clientCapabilities?.elicitation?.url) {
              throw new Error(`Client does not support URL elicitation (required for ${method})`);
            }
            break;
          case "notifications/cancelled":
            break;
          case "notifications/progress":
            break;
        }
      }
      assertRequestHandlerCapability(method) {
        if (!this._capabilities) {
          return;
        }
        switch (method) {
          case "completion/complete":
            if (!this._capabilities.completions) {
              throw new Error(`Server does not support completions (required for ${method})`);
            }
            break;
          case "logging/setLevel":
            if (!this._capabilities.logging) {
              throw new Error(`Server does not support logging (required for ${method})`);
            }
            break;
          case "prompts/get":
          case "prompts/list":
            if (!this._capabilities.prompts) {
              throw new Error(`Server does not support prompts (required for ${method})`);
            }
            break;
          case "resources/list":
          case "resources/templates/list":
          case "resources/read":
            if (!this._capabilities.resources) {
              throw new Error(`Server does not support resources (required for ${method})`);
            }
            break;
          case "tools/call":
          case "tools/list":
            if (!this._capabilities.tools) {
              throw new Error(`Server does not support tools (required for ${method})`);
            }
            break;
          case "tasks/get":
          case "tasks/list":
          case "tasks/result":
          case "tasks/cancel":
            if (!this._capabilities.tasks) {
              throw new Error(`Server does not support tasks capability (required for ${method})`);
            }
            break;
          case "ping":
          case "initialize":
            break;
        }
      }
      assertTaskCapability(method) {
        assertClientRequestTaskCapability(this._clientCapabilities?.tasks?.requests, method, "Client");
      }
      assertTaskHandlerCapability(method) {
        if (!this._capabilities) {
          return;
        }
        assertToolsCallTaskCapability(this._capabilities.tasks?.requests, method, "Server");
      }
      async _oninitialize(request2) {
        const requestedVersion = request2.params.protocolVersion;
        this._clientCapabilities = request2.params.capabilities;
        this._clientVersion = request2.params.clientInfo;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion) ? requestedVersion : LATEST_PROTOCOL_VERSION;
        return {
          protocolVersion,
          capabilities: this.getCapabilities(),
          serverInfo: this._serverInfo,
          ...this._instructions && { instructions: this._instructions }
        };
      }
      /**
       * After initialization has completed, this will be populated with the client's reported capabilities.
       */
      getClientCapabilities() {
        return this._clientCapabilities;
      }
      /**
       * After initialization has completed, this will be populated with information about the client's name and version.
       */
      getClientVersion() {
        return this._clientVersion;
      }
      getCapabilities() {
        return this._capabilities;
      }
      async ping() {
        return this.request({ method: "ping" }, EmptyResultSchema);
      }
      // Implementation
      async createMessage(params, options) {
        if (params.tools || params.toolChoice) {
          if (!this._clientCapabilities?.sampling?.tools) {
            throw new Error("Client does not support sampling tools capability.");
          }
        }
        if (params.messages.length > 0) {
          const lastMessage = params.messages[params.messages.length - 1];
          const lastContent = Array.isArray(lastMessage.content) ? lastMessage.content : [lastMessage.content];
          const hasToolResults = lastContent.some((c) => c.type === "tool_result");
          const previousMessage = params.messages.length > 1 ? params.messages[params.messages.length - 2] : void 0;
          const previousContent = previousMessage ? Array.isArray(previousMessage.content) ? previousMessage.content : [previousMessage.content] : [];
          const hasPreviousToolUse = previousContent.some((c) => c.type === "tool_use");
          if (hasToolResults) {
            if (lastContent.some((c) => c.type !== "tool_result")) {
              throw new Error("The last message must contain only tool_result content if any is present");
            }
            if (!hasPreviousToolUse) {
              throw new Error("tool_result blocks are not matching any tool_use from the previous message");
            }
          }
          if (hasPreviousToolUse) {
            const toolUseIds = new Set(previousContent.filter((c) => c.type === "tool_use").map((c) => c.id));
            const toolResultIds = new Set(lastContent.filter((c) => c.type === "tool_result").map((c) => c.toolUseId));
            if (toolUseIds.size !== toolResultIds.size || ![...toolUseIds].every((id) => toolResultIds.has(id))) {
              throw new Error("ids of tool_result blocks and tool_use blocks from previous message do not match");
            }
          }
        }
        if (params.tools) {
          return this.request({ method: "sampling/createMessage", params }, CreateMessageResultWithToolsSchema, options);
        }
        return this.request({ method: "sampling/createMessage", params }, CreateMessageResultSchema, options);
      }
      /**
       * Creates an elicitation request for the given parameters.
       * For backwards compatibility, `mode` may be omitted for form requests and will default to `'form'`.
       * @param params The parameters for the elicitation request.
       * @param options Optional request options.
       * @returns The result of the elicitation request.
       */
      async elicitInput(params, options) {
        const mode = params.mode ?? "form";
        switch (mode) {
          case "url": {
            if (!this._clientCapabilities?.elicitation?.url) {
              throw new Error("Client does not support url elicitation.");
            }
            const urlParams = params;
            return this.request({ method: "elicitation/create", params: urlParams }, ElicitResultSchema, options);
          }
          case "form": {
            if (!this._clientCapabilities?.elicitation?.form) {
              throw new Error("Client does not support form elicitation.");
            }
            const formParams = params.mode === "form" ? params : { ...params, mode: "form" };
            const result = await this.request({ method: "elicitation/create", params: formParams }, ElicitResultSchema, options);
            if (result.action === "accept" && result.content && formParams.requestedSchema) {
              try {
                const validator = this._jsonSchemaValidator.getValidator(formParams.requestedSchema);
                const validationResult = validator(result.content);
                if (!validationResult.valid) {
                  throw new McpError(ErrorCode.InvalidParams, `Elicitation response content does not match requested schema: ${validationResult.errorMessage}`);
                }
              } catch (error2) {
                if (error2 instanceof McpError) {
                  throw error2;
                }
                throw new McpError(ErrorCode.InternalError, `Error validating elicitation response: ${error2 instanceof Error ? error2.message : String(error2)}`);
              }
            }
            return result;
          }
        }
      }
      /**
       * Creates a reusable callback that, when invoked, will send a `notifications/elicitation/complete`
       * notification for the specified elicitation ID.
       *
       * @param elicitationId The ID of the elicitation to mark as complete.
       * @param options Optional notification options. Useful when the completion notification should be related to a prior request.
       * @returns A function that emits the completion notification when awaited.
       */
      createElicitationCompletionNotifier(elicitationId, options) {
        if (!this._clientCapabilities?.elicitation?.url) {
          throw new Error("Client does not support URL elicitation (required for notifications/elicitation/complete)");
        }
        return () => this.notification({
          method: "notifications/elicitation/complete",
          params: {
            elicitationId
          }
        }, options);
      }
      async listRoots(params, options) {
        return this.request({ method: "roots/list", params }, ListRootsResultSchema, options);
      }
      /**
       * Sends a logging message to the client, if connected.
       * Note: You only need to send the parameters object, not the entire JSON RPC message
       * @see LoggingMessageNotification
       * @param params
       * @param sessionId optional for stateless and backward compatibility
       */
      async sendLoggingMessage(params, sessionId) {
        if (this._capabilities.logging) {
          if (!this.isMessageIgnored(params.level, sessionId)) {
            return this.notification({ method: "notifications/message", params });
          }
        }
      }
      async sendResourceUpdated(params) {
        return this.notification({
          method: "notifications/resources/updated",
          params
        });
      }
      async sendResourceListChanged() {
        return this.notification({
          method: "notifications/resources/list_changed"
        });
      }
      async sendToolListChanged() {
        return this.notification({ method: "notifications/tools/list_changed" });
      }
      async sendPromptListChanged() {
        return this.notification({ method: "notifications/prompts/list_changed" });
      }
    };
  }
});

// ../../packages/browser/src/core/transport.ts
var init_transport = __esm({
  "../../packages/browser/src/core/transport.ts"() {
    "use strict";
  }
});

// ../../packages/browser/src/core/errors.ts
var BrowserError;
var init_errors4 = __esm({
  "../../packages/browser/src/core/errors.ts"() {
    "use strict";
    BrowserError = class extends Error {
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
  }
});

// ../../packages/browser/src/core/page-fn.ts
var init_page_fn = __esm({
  "../../packages/browser/src/core/page-fn.ts"() {
    "use strict";
  }
});

// ../../packages/browser/src/core/aim.ts
var init_aim = __esm({
  "../../packages/browser/src/core/aim.ts"() {
    "use strict";
  }
});

// ../../packages/browser/src/core/path.ts
var init_path = __esm({
  "../../packages/browser/src/core/path.ts"() {
    "use strict";
  }
});

// ../../packages/browser/src/core/input.ts
var init_input = __esm({
  "../../packages/browser/src/core/input.ts"() {
    "use strict";
  }
});

// ../../packages/browser/src/core/tool-texts.ts
var REF2, REF_OR_POINT2, X2, Y2, TOOL_TEXTS, LOCAL_TOOL_TEXTS;
var init_tool_texts = __esm({
  "../../packages/browser/src/core/tool-texts.ts"() {
    "use strict";
    REF2 = 'Element ref from the latest WebSnapshot of this tab (for example "e12"; a ref with a prefix such as "f1e140" belongs to an iframe and is just as valid).';
    REF_OR_POINT2 = `${REF2} Alternatively give x and y instead of ref.`;
    X2 = "Horizontal pixel coordinate in the viewport (use together with y, instead of ref).";
    Y2 = "Vertical pixel coordinate in the viewport (use together with x, instead of ref).";
    TOOL_TEXTS = {
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
          ref: REF_OR_POINT2,
          x: X2,
          y: Y2,
          button: '"left" (default), "right" (opens the context menu) or "middle".',
          count: "1 (default), 2 (double click) or 3 (triple click)."
        }
      },
      hover: {
        name: "WebHover",
        description: "Move the pointer over an element and leave it there, so hover menus and tooltips appear. Use WebSnapshot or WebScreenshot afterwards to see them.",
        params: { ref: REF_OR_POINT2, x: X2, y: Y2 }
      },
      drag: {
        name: "WebDrag",
        description: "Drag from one element or point and drop on another, with the real pointer (sortable lists, sliders, drag and drop zones).",
        params: {
          ref: `Source. ${REF2}`,
          x: "Source x coordinate in the viewport (use together with y, instead of ref).",
          y: "Source y coordinate in the viewport (use together with x, instead of ref).",
          toRef: `Destination. ${REF2}`,
          toX: "Destination x coordinate in the viewport (use together with toY, instead of toRef).",
          toY: "Destination y coordinate in the viewport (use together with toX, instead of toRef)."
        }
      },
      type: {
        name: "WebType",
        description: 'Type text with the keyboard. With a ref it clicks the field first and appends the text at the end; without a ref it types into the element that has focus. Use "\\n" for Enter. To replace what a field already holds use WebFill.',
        params: {
          text: "The text to type.",
          ref: `Field to click first. ${REF2}`,
          mode: '"keys" types key by key (default up to 200 characters); "paste" inserts all at once.'
        }
      },
      fill: {
        name: "WebFill",
        description: "Replace the content of a text field: clicks it, selects everything, deletes, then types the new text. Returns the value the field really holds afterwards (masks or autocomplete may change it) and whether it matches.",
        params: { ref: REF2, text: "The new content.", mode: '"keys" or "paste" (default: keys up to 200 characters).' }
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
          ref: `The select. ${REF2}`,
          label: "Visible text of the option.",
          value: "The option value attribute.",
          index: "Zero-based position of the option.",
          programmatic: "Set true only for a select that allows several options, or when the normal way failed."
        }
      },
      set_checked: {
        name: "WebSetChecked",
        description: "Leave a checkbox, radio button or switch checked or unchecked. It clicks only if the current state is different, then confirms the result.",
        params: { ref: REF2, checked: "The state you want." }
      },
      scroll: {
        name: "WebScroll",
        description: "Scroll with the mouse wheel, over the page or over a scrollable area. Returns how far the area really moved. Give one of by or to.",
        params: {
          ref: `Put the pointer over this element first (its scrollable area receives the wheel). ${REF2}`,
          x: X2,
          y: Y2,
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
          ref: `Only this element. ${REF2}`,
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
          ref: `Element to wait for. ${REF2}`,
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
    LOCAL_TOOL_TEXTS = {
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
  }
});

// ../../packages/browser/src/core/catalog.ts
function build(text, op, params, required2) {
  const texts = text.params;
  const properties = {};
  for (const [key, spec] of Object.entries(params)) {
    const description = texts[key];
    if (!description) throw new Error(`tool-texts: ${op}.${key} has no description`);
    const { type, ...rest2 } = spec;
    properties[key] = type === "string[]" ? { type: "array", items: { type: "string" }, description, ...rest2 } : { type, description, ...rest2 };
  }
  for (const key of Object.keys(texts)) {
    if (!(key in properties)) throw new Error(`tool-texts: ${op}.${key} is described but not declared in the catalog`);
  }
  return {
    name: text.name,
    description: text.description,
    inputSchema: { type: "object", properties, ...required2.length ? { required: required2 } : {}, additionalProperties: false }
  };
}
function def(op, params, required2 = []) {
  return { op, scope: "server", tier: TOOL_TIERS[op], ...build(TOOL_TEXTS[op], op, params, required2) };
}
function defLocal(op, params, required2, destructive) {
  return { op, scope: "local", tier: "advanced", destructive, ...build(LOCAL_TOOL_TEXTS[op], op, params, required2) };
}
function validateArgs(tool, args) {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return ["arguments must be an object"];
  const input = args;
  const problems = [];
  const { properties, required: required2 = [] } = tool.inputSchema;
  for (const key of required2) {
    if (input[key] === void 0) problems.push(`"${key}" is required`);
  }
  for (const [key, value] of Object.entries(input)) {
    const spec = properties[key];
    if (!spec) {
      problems.push(`unknown argument "${key}"`);
      continue;
    }
    if (value === void 0) continue;
    const ok = spec.type === "string" ? typeof value === "string" : spec.type === "boolean" ? typeof value === "boolean" : spec.type === "number" ? typeof value === "number" && Number.isFinite(value) : spec.type === "integer" ? Number.isInteger(value) : Array.isArray(value) && value.every((v) => typeof v === "string");
    if (!ok) {
      problems.push(`"${key}" must be ${spec.type === "array" ? "an array of strings" : `a ${spec.type}`}`);
      continue;
    }
    if (spec.enum && !spec.enum.includes(value)) problems.push(`"${key}" must be one of ${spec.enum.join(", ")}`);
    if (typeof value === "number") {
      if (spec.minimum !== void 0 && value < spec.minimum) problems.push(`"${key}" must be at least ${spec.minimum}`);
      if (spec.maximum !== void 0 && value > spec.maximum) problems.push(`"${key}" must be at most ${spec.maximum}`);
    }
  }
  return problems;
}
var TOOL_TIERS, str, num, int2, bool, PDF_FORMATS, BROWSER_CATALOG, LOCAL_CATALOG, STANDARD_TOOLS;
var init_catalog = __esm({
  "../../packages/browser/src/core/catalog.ts"() {
    "use strict";
    init_errors4();
    init_tool_texts();
    TOOL_TIERS = {
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
    str = { type: "string" };
    num = { type: "number" };
    int2 = { type: "integer" };
    bool = { type: "boolean" };
    PDF_FORMATS = ["letter", "legal", "tabloid", "ledger", "a0", "a1", "a2", "a3", "a4", "a5", "a6"];
    BROWSER_CATALOG = Object.freeze([
      def("navigate", { url: str }, ["url"]),
      def("snapshot", { depth: { ...int2, minimum: 1 }, ref: str, maxChars: { ...int2, minimum: 1 } }),
      def("read", { maxChars: { ...int2, minimum: 1 } }),
      def("find", { role: str, name: str, text: str, limit: { ...int2, minimum: 1 } }),
      def("get_links", { limit: { ...int2, minimum: 1 }, includeUnnamed: bool }),
      def("click", { ref: str, x: num, y: num, button: { ...str, enum: ["left", "right", "middle"] }, count: { ...int2, enum: [1, 2, 3] } }),
      def("hover", { ref: str, x: num, y: num }),
      def("drag", { ref: str, x: num, y: num, toRef: str, toX: num, toY: num }),
      def("type", { text: str, ref: str, mode: { ...str, enum: ["keys", "paste"] } }, ["text"]),
      def("fill", { ref: str, text: str, mode: { ...str, enum: ["keys", "paste"] } }, ["ref", "text"]),
      def("press_key", { key: str, hold: { type: "string[]" } }, ["key"]),
      def("select_option", { ref: str, label: str, value: str, index: { ...int2, minimum: 0 }, programmatic: bool }, ["ref"]),
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
        quality: { ...int2, minimum: 1, maximum: 100 }
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
      def("resize", { width: { ...int2, minimum: 100, maximum: 4e3 }, height: { ...int2, minimum: 100, maximum: 4e3 } }, ["width", "height"]),
      def("wait", { text: str, ref: str, state: { ...str, enum: ["visible", "hidden"] }, url: str, urlChanged: bool, timeoutMs: { ...int2, minimum: 1, maximum: 12e4 } }),
      def("dialog", { accept: bool, promptText: str }, ["accept"]),
      def("console", {
        tab: str,
        level: { ...str, enum: ["debug", "log", "info", "warning", "error"] },
        afterSeq: { ...int2, minimum: 0 },
        limit: { ...int2, minimum: 1, maximum: 500 },
        clear: bool
      }),
      def("network", { tab: str, id: str, body: bool, captureBodies: bool, urlIncludes: str, status: str, type: str, afterSeq: { ...int2, minimum: 0 } }),
      def("download", { wait: bool, timeoutMs: { ...int2, minimum: 1 } })
    ]);
    LOCAL_CATALOG = Object.freeze([
      defLocal("evaluate", { expression: str }, ["expression"], false),
      defLocal("upload", { ref: str, path: str }, ["ref", "path"], true),
      defLocal("allow_uploads", { folder: str, origin: str }, ["folder", "origin"], true),
      defLocal("upload_permissions", {}, [], false),
      defLocal("revoke_uploads", { folder: str, origin: str }, ["origin"], false),
      defLocal("set_gpu", { gpu: { ...str, enum: ["on", "off"] }, confirm: bool }, ["gpu"], false)
    ]);
    STANDARD_TOOLS = Object.freeze(BROWSER_CATALOG.filter((t) => t.tier === "standard"));
  }
});

// ../../packages/browser/src/core/cosmetics/colors.ts
var HEX, NUM, RGB, COLOR, LEN, LAYER, SHADOW;
var init_colors = __esm({
  "../../packages/browser/src/core/cosmetics/colors.ts"() {
    "use strict";
    HEX = String.raw`#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})`;
    NUM = String.raw`\d{1,3}(?:\.\d+)?%?`;
    RGB = String.raw`rgba?\( *${NUM} *[, ] *${NUM} *[, ] *${NUM} *(?:[,/] *(?:\d?\.?\d{1,3}%?) *)?\)`;
    COLOR = new RegExp(`^(?:${HEX}|${RGB})$`, "i");
    LEN = String.raw`(?:0|-?\d{1,3}(?:\.\d+)?px)`;
    LAYER = String.raw`(?:inset +)?${LEN}(?: +${LEN}){1,3} +(?:${HEX}|${RGB})`;
    SHADOW = new RegExp(String.raw`^${LAYER}(?: *, *${LAYER}){0,3}$`, "i");
  }
});

// ../../packages/browser/src/core/cosmetics/cursor/svg.ts
var init_svg = __esm({
  "../../packages/browser/src/core/cosmetics/cursor/svg.ts"() {
    "use strict";
  }
});

// ../../packages/browser/src/core/cosmetics/style.ts
var glowRule, css, GLOW_GEOMETRY, BRAND_GLOW, BRAND_RING, COSMETICS_CSS;
var init_style = __esm({
  "../../packages/browser/src/core/cosmetics/style.ts"() {
    "use strict";
    init_colors();
    glowRule = (glow) => `.glow{position:fixed;inset:0;pointer-events:none;border-radius:0;opacity:1;
  box-shadow:${glow}}`;
    css = (glow, ring) => `
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
    GLOW_GEOMETRY = "inset 0 0 60px 14px";
    BRAND_GLOW = `${GLOW_GEOMETRY} rgba(215,129,61,.55)`;
    BRAND_RING = { border: "rgba(215,129,61,.9)", fill: "rgba(215,129,61,.18)" };
    COSMETICS_CSS = css(BRAND_GLOW, BRAND_RING);
  }
});

// ../../packages/browser/src/core/cosmetics/script.ts
var init_script = __esm({
  "../../packages/browser/src/core/cosmetics/script.ts"() {
    "use strict";
    init_page_fn();
    init_colors();
    init_svg();
    init_style();
  }
});

// ../../packages/browser/src/core/cosmetics/controller.ts
var init_controller = __esm({
  "../../packages/browser/src/core/cosmetics/controller.ts"() {
    "use strict";
    init_script();
  }
});

// ../../packages/browser/src/core/cosmetics/index.ts
var init_cosmetics = __esm({
  "../../packages/browser/src/core/cosmetics/index.ts"() {
    "use strict";
    init_script();
    init_controller();
    init_svg();
    init_colors();
    init_style();
  }
});

// ../../packages/browser/src/core/index.ts
var init_core3 = __esm({
  "../../packages/browser/src/core/index.ts"() {
    "use strict";
    init_transport();
    init_errors4();
    init_page_fn();
    init_aim();
    init_path();
    init_input();
    init_tool_texts();
    init_catalog();
    init_cosmetics();
  }
});

// src/core.ts
var init_core4 = __esm({
  "src/core.ts"() {
    "use strict";
    init_core3();
  }
});

// src/catalog.ts
function def2(name, params, required2 = [], opts = {}) {
  const text = BRIDGE_TOOL_TEXTS[name];
  const texts = text.params;
  const properties = {};
  for (const [key, spec] of Object.entries(params)) {
    const description = texts[key];
    if (!description) throw new Error(`texts: ${name}.${key} has no description`);
    const { type, ...rest2 } = spec;
    properties[key] = type === "string[]" ? { type: "array", items: { type: "string" }, description, ...rest2 } : { type, description, ...rest2 };
  }
  for (const key of Object.keys(texts)) {
    if (!(key in properties)) throw new Error(`texts: ${name}.${key} is described but not declared in the catalog`);
  }
  if (opts.common !== false) {
    properties.browser = { type: "string", description: COMMON_PARAMS.browser };
    properties.tab = { type: "string", description: COMMON_PARAMS.tab };
  }
  return {
    name,
    description: text.description,
    inputSchema: { type: "object", properties, ...required2.length ? { required: required2 } : {}, additionalProperties: false }
  };
}
function findBridgeTool(name, opts = {}) {
  return (opts.internal ? INTERNAL_CATALOG.find((t) => t.name === name) : void 0) ?? BRIDGE_CATALOG.find((t) => t.name === name);
}
function assertValidCall(tool, args, opts = {}) {
  const t = findBridgeTool(tool, opts);
  if (!t) throw new BridgeError("UNKNOWN_TOOL", `unknown tool "${tool}"`);
  const problems = validateArgs(t, args ?? {});
  if (problems.length) {
    throw Object.assign(new Error(`${tool}: ${problems.join("; ")}`), { code: "INVALID_ARGUMENT" });
  }
  return t;
}
var str2, num2, int3, bool2, BRIDGE_CATALOG, SHELL_ONLY_TOOLS, EXPECT, INTERNAL_CATALOG;
var init_catalog2 = __esm({
  "src/catalog.ts"() {
    "use strict";
    init_core4();
    init_errors3();
    init_texts();
    str2 = { type: "string" };
    num2 = { type: "number" };
    int3 = { type: "integer" };
    bool2 = { type: "boolean" };
    BRIDGE_CATALOG = Object.freeze([
      def2("list_browsers", {}, [], { common: false }),
      def2("navigate", { url: str2, action: { ...str2, enum: ["back", "forward", "reload"] } }),
      def2("wait", { for: { ...str2, enum: ["load", "networkidle", "text", "selector", "url", "time"] }, value: str2, timeoutMs: { ...int3, minimum: 1, maximum: 12e4 } }, ["for"]),
      def2("find", { role: str2, name: str2, text: str2, limit: { ...int3, minimum: 1, maximum: 500 } }),
      def2("read", { maxChars: { ...int3, minimum: 1 } }),
      def2("links", { limit: { ...int3, minimum: 1, maximum: 1e3 }, includeUnnamed: bool2 }),
      def2("snapshot", { depth: { ...int3, minimum: 1 } }),
      def2("screenshot", {
        fullPage: bool2,
        ref: str2,
        format: { ...str2, enum: ["png", "jpeg"] },
        quality: { ...int3, minimum: 1, maximum: 100 }
      }),
      def2("click", {
        ref: str2,
        x: num2,
        y: num2,
        button: { ...str2, enum: ["left", "right", "middle"] },
        count: { ...int3, enum: [1, 2, 3] }
      }),
      def2("hover", { ref: str2, x: num2, y: num2 }),
      def2("drag", { ref: str2, x: num2, y: num2, toRef: str2, toX: num2, toY: num2 }),
      def2("scroll", { ref: str2, x: num2, y: num2, byX: num2, byY: num2, to: { ...str2, enum: ["top", "bottom"] } }),
      def2("type", { text: str2, ref: str2, mode: { ...str2, enum: ["keys", "paste"] } }, ["text"]),
      def2("pressKey", { key: str2, hold: { type: "string[]" } }, ["key"]),
      def2("tabs", { action: { ...str2, enum: ["list", "new", "close", "activate"] }, url: str2, where: { ...str2, enum: ["agent-window", "user-window"] } }, ["action"]),
      def2("dialog", { action: { ...str2, enum: ["accept", "dismiss"] }, text: str2 }, ["action"]),
      def2("select", { ref: str2, value: str2, label: str2 }, ["ref"]),
      def2("setChecked", { ref: str2, checked: bool2 }, ["ref", "checked"]),
      def2("readConsole", {
        level: { ...str2, enum: ["debug", "log", "info", "warning", "error"] },
        afterSeq: { ...int3, minimum: 0 },
        limit: { ...int3, minimum: 1, maximum: 500 },
        clear: bool2
      }),
      def2("upload", { ref: str2, paths: { type: "string[]" } }, ["ref", "paths"]),
      // Autorizações de upload da sessão (molde do WebAllowUploads/WebUploadPermissions/WebRevokeUploads do @atrium/browser):
      // moram na casca MCP, não na extensão nem no daemon, por isso não levam browser/tab.
      def2("allowUploads", { folder: str2, origin: str2 }, ["folder", "origin"], { common: false }),
      def2("uploadPermissions", {}, [], { common: false }),
      def2("revokeUploads", { folder: str2, origin: str2 }, ["origin"], { common: false }),
      def2("download", { ref: str2, url: str2, timeoutMs: { ...int3, minimum: 1, maximum: 6e5 } }),
      def2("downloads", { action: { ...str2, enum: ["list"] }, limit: { ...int3, minimum: 1, maximum: 200 } }, ["action"]),
      def2("pdf", {
        filename: str2,
        landscape: bool2,
        scale: { ...num2, minimum: 0.1, maximum: 2 },
        pageRanges: str2,
        printBackground: bool2
      }),
      def2("readNetwork", {
        afterSeq: { ...int3, minimum: 0 },
        limit: { ...int3, minimum: 1, maximum: 500 },
        urlContains: str2,
        id: str2,
        body: bool2,
        maxChars: { ...int3, minimum: 1, maximum: 1e6 }
      }),
      def2("resize", { width: { ...int3, minimum: 1, maximum: 1e4 }, height: { ...int3, minimum: 1, maximum: 1e4 }, reset: bool2 }),
      def2("evaluate", { expression: str2, awaitPromise: bool2 }, ["expression"])
    ]);
    SHELL_ONLY_TOOLS = /* @__PURE__ */ new Set(["allowUploads", "uploadPermissions", "revokeUploads"]);
    EXPECT = { type: "array", items: { type: "string" }, description: "internal: the authorized origin chain, owner first" };
    INTERNAL_CATALOG = Object.freeze([
      ...BRIDGE_CATALOG.filter((t) => t.name === "upload").map((t) => ({
        ...t,
        inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, expect: EXPECT } }
      })),
      {
        name: "uploadTarget",
        description: "internal",
        inputSchema: {
          type: "object",
          properties: {
            ref: { type: "string", description: "internal" },
            browser: { type: "string", description: COMMON_PARAMS.browser },
            tab: { type: "string", description: COMMON_PARAMS.tab }
          },
          required: ["ref"],
          additionalProperties: false
        }
      }
    ]);
  }
});

// ../../packages/browser/src/errors.ts
var init_errors5 = __esm({
  "../../packages/browser/src/errors.ts"() {
    "use strict";
    init_errors4();
  }
});

// ../../packages/browser/src/host/policy.ts
import { lstatSync, realpathSync, statSync as statSync4 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { basename, delimiter, dirname as dirname4, join as join4, parse as parse3, relative, resolve as resolve5, isAbsolute, sep } from "node:path";
function dirsFrom(env, name) {
  const listed = (env[name] ?? "").split(delimiter).map((d) => d.trim()).filter(Boolean);
  for (const d of listed) {
    if (!isAbsolute(d)) {
      throw new BrowserError("INVALID_ARGUMENT", `${name}: ${JSON.stringify(d)} is a relative path; every entry must be absolute (a relative one would depend on where the server was launched).`);
    }
  }
  return listed.map((d) => resolve5(d));
}
function uploadDirs(env = process.env, home3 = homedir2(), name = UPLOAD_DIRS_ENV) {
  const listed = dirsFrom(env, name);
  return listed.length ? listed : [join4(home3, "Downloads")];
}
function uploadDirsTrusted(env = process.env, name = UPLOAD_DIRS_TRUSTED_ENV) {
  return dirsFrom(env, name);
}
function real(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}
function inside(dir, file) {
  const rel = relative(norm(dir), norm(file));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function isNetworkOrDevicePath(path) {
  return /^[\\/]{2}/.test(path) || /^\\\?\?\\/.test(path);
}
function uploadElicitSchema(options) {
  return {
    type: "object",
    properties: {
      decision: {
        type: "string",
        title: "Your answer",
        description: "What to do with this upload request.",
        oneOf: options.map((o) => ({ const: o.value, title: o.title })),
        ...options.some((o) => o.value === "decline") ? { default: "decline" } : {}
      }
    },
    required: ["decision"]
  };
}
function elicitUploadConfirm(server, log2 = () => {
}) {
  return async (message, options) => {
    const e = server.getClientCapabilities()?.elicitation;
    if (!e || !(e.form || Object.keys(e).length === 0)) return "unsupported";
    try {
      const answer = await server.elicitInput({ message, requestedSchema: uploadElicitSchema(options) });
      const decision = answer.action === "accept" ? answer.content?.decision : void 0;
      const chosen = options.find((o) => o.value === decision);
      return chosen ? chosen.value : "decline";
    } catch (err) {
      log2(`upload confirmation failed: ${err.message}`);
      return "decline";
    }
  };
}
function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
function uploadOrigin(input) {
  let url;
  try {
    url = typeof input === "string" ? new URL(input.trim()) : void 0;
  } catch {
    url = void 0;
  }
  if (!url || url.protocol !== "https:" && url.protocol !== "http:" || !url.hostname) {
    throw new BrowserError("INVALID_ARGUMENT", `origin must be an http or https site such as "https://portal.example.com" (scheme, host and optional port), got ${JSON.stringify(input)}.`);
  }
  return url.origin;
}
function insideOrSame(dir, path) {
  return relative(norm(dir), norm(path)) === "" || inside(dir, path);
}
function uploadPolicy(dirs, opts = {}) {
  const trusted = (opts.trusted ?? []).map((d) => resolve5(d));
  const listed = [...dirs.map((d) => resolve5(d)), ...trusted];
  const log2 = opts.log ?? (() => {
  });
  const now = opts.now ?? (() => /* @__PURE__ */ new Date());
  const grants = [];
  const home3 = resolve5(opts.home ?? homedir2());
  const names = { ...BROWSER_UPLOAD_NAMES, ...opts.names };
  const broadReason = (target) => {
    const f = resolve5(target);
    if (parse3(f).root === f || dirname4(f) === f) return `${f} is the root of a drive`;
    const refs = (list) => list.flatMap((d) => [d, real(d)].filter((x) => x !== null));
    const same = (list) => refs(list).some((d) => sameFolder(d, f));
    if (same([home3])) return `${f} is the user's home folder`;
    if (same(listed)) return `${f} is itself one of the folders allowed for upload (${names.dirsEnv}), so it would cover everything allowed`;
    const fr = real(f);
    const contains = (list) => refs(list).some((d) => [f, fr].some((x) => x !== null && !sameFolder(d, x) && inside(x, d)));
    if (contains([home3])) return `${f} contains the user's home folder, so it would cover everything in it (keys, secrets)`;
    if (contains(listed)) return `${f} contains a folder allowed for upload (${names.dirsEnv}), so it would cover everything allowed`;
    for (const x of [f, fr]) {
      if (x === null) continue;
      const base = refs(listed).find((d) => inside(d, x));
      const segs = (base ? relative(norm(base), norm(x)) : norm(x)).split(/[\\/]+/).filter(Boolean);
      const hit = segs.find((n) => SENSITIVE_SEGMENTS.has(n.toLowerCase()));
      if (hit) return `${f} is, or is inside, a ${hit} folder (keys or a repository)`;
    }
    const name = basename(f).toLowerCase();
    if (name.startsWith(".env")) return `${f} looks like a secrets file (${basename(f)})`;
    const found = SENSITIVE_ENTRIES.filter((n) => exists(join4(f, n)));
    if (found.length) return `${f} directly contains ${found.join(", ")} (secrets, a repository or keys)`;
    return null;
  };
  const tooBroad = (folder, reason) => new BrowserError(
    "UPLOAD_NOT_ALLOWED",
    `${folder} is too broad to authorize for a whole session: ${reason}. Nothing was authorized. Authorize a subfolder that holds only the files to send (for example ${join4(folder, "to-send")}), or send files one at a time with ${names.upload}.`
  );
  const grantFor = (file, site) => grants.find((g) => g.origin === site && inside(g.folder, file));
  const addGrant = (folder, origin, via) => {
    const broad = broadReason(folder);
    if (broad) throw tooBroad(folder, broad);
    const existing = grants.find((g) => g.origin === origin && sameFolder(g.folder, folder));
    if (existing) return existing;
    const grant = { folder, origin, grantedAt: now().toISOString(), via };
    grants.push(grant);
    log2(`upload authorization granted for this session (${via}): folder=${folder} origin=${origin} at=${grant.grantedAt}`);
    return grant;
  };
  const howToAllow = (folder, site, reason) => {
    const broad = reason ?? broadReason(folder);
    if (broad) {
      return `${folder} cannot be authorized for the session (${broad}). To send several files to ${site} without a question each, the operator puts them in a subfolder (for example ${join4(folder, "to-send")}) and calls ${names.allow} with that folder and origin ${JSON.stringify(site)}. Do not try to work around this.`;
    }
    return howToAllowFolder(folder, site);
  };
  const howToAllowFolder = (folder, site) => `To send files from ${folder} to ${site} without this question, the operator calls ${names.allow} with folder ${JSON.stringify(folder)} and origin ${JSON.stringify(site)} from a session where the question can be shown (it lasts until this MCP server stops). Do not try to work around this.`;
  return {
    resolveUploadPath(path) {
      if (typeof path !== "string" || !isAbsolute(path) || isNetworkOrDevicePath(path)) {
        throw new BrowserError("INVALID_ARGUMENT", `upload: path must be a local absolute path, got ${JSON.stringify(path)}.`);
      }
      if (!listed.some((d) => inside(d, resolve5(path)))) throw refusal(path, listed, names);
      const file = real(path);
      if (!file || !statSync4(file).isFile()) throw refusal(path, listed, names);
      const allowed = listed.map((d) => real(d)).filter((d) => d !== null);
      if (!allowed.some((d) => inside(d, file))) throw refusal(path, listed, names);
      return file;
    },
    async authorizeUpload({ file, site, top = site, ancestors = [] }) {
      const embedded = site !== top || ancestors.some((o) => o !== top);
      const owner = embedded ? `WARNING: the field belongs to ${site}, embedded in ${top}` + (ancestors.length > 1 ? ` (frame chain: ${[site, ...ancestors].join(" > ")})` : "") : null;
      const folder = dirname4(file);
      if (!embedded) {
        const trustedReal = trusted.map((d) => real(d)).filter((d) => d !== null);
        if (trustedReal.some((d) => inside(d, file))) return;
        const grant = broadReason(file) || broadReason(folder) ? void 0 : grantFor(file, site);
        if (grant) {
          log2(`upload sent under session authorization: file=${file} origin=${site} at=${now().toISOString()} (granted for folder=${grant.folder})`);
          return;
        }
      }
      const broad = broadReason(folder) ?? broadReason(file);
      const offerSession = !embedded && isWebOrigin(site) && !broad;
      const options = offerSession ? [DECLINE, ONCE, SESSION] : [DECLINE, ONCE];
      const answer = opts.confirm ? await opts.confirm(
        `The AI wants to send a file from this computer to a website.

File: ${show(file)}
Folder: ${show(folder)}
Site: ${show(site)}
` + (owner ? `${show(owner)}
` : "") + (broad && !embedded && isWebOrigin(site) ? `Only this file can be allowed: ${show(broad)}.
` : "") + `
Send it?` + (offerSession ? ` "${SESSION.title}" lets every file in ${show(folder)} (and its subfolders) go to ${show(site)} without asking again, until this ${names.server} stops.` : ""),
        options
      ) : "unsupported";
      if (answer === "once") return;
      if (answer === "session" && offerSession) {
        addGrant(folder, site, "upload");
        return;
      }
      throw new BrowserError(
        "UPLOAD_NOT_ALLOWED",
        answer === "unsupported" ? embedded ? `The upload field belongs to ${site}, embedded in ${top}, and this MCP client cannot ask the operator to confirm uploads (it does not support elicitation). Neither a pre-authorized folder nor a session authorization applies to a field embedded from another site, so ${file} was not sent. Do not try to work around this.` : `No authorization to send files from ${folder} to ${site}, and this MCP client cannot ask the operator (it does not support elicitation), so ${file} was not sent. ` + howToAllow(folder, site, broad) + ` (The operator can also pre-authorize a folder in the ${names.trustedEnv} environment variable of the ${names.server}, absolute paths separated by "${delimiter}".)` : `The operator declined to send ${file} to ${site}${embedded ? ` (embedded in ${top})` : ""}, or the question could not be shown (for example to an agent running in the background); nothing was sent. ` + (embedded || !isWebOrigin(site) ? "Do not try again or work around this; ask the user." : `Do not insist; ask the user. ${howToAllow(folder, site, broad)}`)
      );
    },
    async allowUploads({ folder: input, origin: rawOrigin }) {
      const origin = uploadOrigin(rawOrigin);
      if (typeof input !== "string" || !isAbsolute(input) || isNetworkOrDevicePath(input)) {
        throw new BrowserError("INVALID_ARGUMENT", `${names.allow}: folder must be a local absolute path, got ${JSON.stringify(input)}.`);
      }
      const notAllowed = () => new BrowserError(
        "UPLOAD_NOT_ALLOWED",
        `${input} cannot be authorized: it is not a folder inside the folders allowed for upload (${listed.join(", ")}). The operator adds it (or a parent) to the ${names.dirsEnv} environment variable of the ${names.server} and restarts the server. Nothing was authorized.`
      );
      if (!listed.some((d) => insideOrSame(d, resolve5(input)))) throw notAllowed();
      const folder = real(input);
      if (!folder || !statSync4(folder).isDirectory()) throw notAllowed();
      const allowed = listed.map((d) => real(d)).filter((d) => d !== null);
      if (!allowed.some((d) => insideOrSame(d, folder))) throw notAllowed();
      const broad = broadReason(input) ?? broadReason(folder);
      if (broad) throw tooBroad(folder, broad);
      const existing = grants.find((g) => g.origin === origin && sameFolder(g.folder, folder));
      if (existing) return { grant: { ...existing }, already: true };
      const answer = opts.confirm ? await opts.confirm(
        `The AI asks to send files from this computer to a website, without asking again for each file.

Folder: ${show(folder)} (and its subfolders)
Site: ${show(origin)}

Allow uploads from this folder to this site until this ${names.server} stops? Nothing is saved to disk; it can be revoked with ${names.revoke}.`,
        [DECLINE, ALLOW]
      ) : "unsupported";
      if (answer === "session") return { grant: { ...addGrant(folder, origin, "WebAllowUploads") }, already: false };
      throw new BrowserError(
        "UPLOAD_NOT_ALLOWED",
        answer === "unsupported" ? `This MCP client cannot ask the operator (it does not support elicitation), so uploads from ${folder} to ${origin} were not authorized. Call ${names.allow} from a client that can show the question, or the operator pre-authorizes the folder in ${names.trustedEnv}. Do not try to work around this.` : `The operator declined to allow uploads from ${folder} to ${origin}, or the question could not be shown (for example to an agent running in the background); nothing was authorized. Do not insist; ask the user.`
      );
    },
    uploadGrants() {
      return { grants: grants.map((g) => ({ ...g })), trusted: [...trusted] };
    },
    revokeUploads({ folder: input, origin: rawOrigin }) {
      const origin = uploadOrigin(rawOrigin);
      if (input !== void 0 && (typeof input !== "string" || !isAbsolute(input))) {
        throw new BrowserError("INVALID_ARGUMENT", `${names.revoke}: folder must be an absolute path, got ${JSON.stringify(input)}.`);
      }
      const keys = input === void 0 ? [] : [input, real(input)].filter((k) => k !== null);
      const removed = [];
      for (let i = grants.length - 1; i >= 0; i--) {
        const g = grants[i];
        if (g.origin !== origin || input !== void 0 && !keys.some((k) => sameFolder(k, g.folder))) continue;
        removed.unshift(...grants.splice(i, 1));
      }
      for (const g of removed) log2(`upload authorization revoked: folder=${g.folder} origin=${g.origin} at=${now().toISOString()}`);
      return { removed, grants: grants.map((g) => ({ ...g })) };
    }
  };
}
var UPLOAD_DIRS_ENV, UPLOAD_DIRS_TRUSTED_ENV, norm, BROWSER_UPLOAD_NAMES, ONCE, SESSION, DECLINE, ALLOW, SENSITIVE_ENTRIES, SENSITIVE_SEGMENTS, CONTROL_CHARS, show, isWebOrigin, refusal, sameFolder;
var init_policy = __esm({
  "../../packages/browser/src/host/policy.ts"() {
    "use strict";
    init_errors5();
    UPLOAD_DIRS_ENV = "ATRIUM_BROWSER_UPLOAD_DIRS";
    UPLOAD_DIRS_TRUSTED_ENV = "ATRIUM_BROWSER_UPLOAD_DIRS_TRUSTED";
    norm = (p) => process.platform === "win32" ? p.toLowerCase() : p;
    BROWSER_UPLOAD_NAMES = Object.freeze({
      upload: "WebUpload",
      allow: "WebAllowUploads",
      revoke: "WebRevokeUploads",
      server: "browser MCP server",
      dirsEnv: UPLOAD_DIRS_ENV,
      trustedEnv: UPLOAD_DIRS_TRUSTED_ENV
    });
    ONCE = { value: "once", title: "Send only this file" };
    SESSION = { value: "session", title: "Allow this folder to this site until the end of the session" };
    DECLINE = { value: "decline", title: "Decline" };
    ALLOW = { value: "session", title: "Allow for this session" };
    SENSITIVE_ENTRIES = [".env", ".git", ".ssh"];
    SENSITIVE_SEGMENTS = /* @__PURE__ */ new Set([".ssh", ".git", ".gnupg"]);
    CONTROL_CHARS = new RegExp("[\0-\x7F-\x9F\u2028\u2029]");
    show = (text) => CONTROL_CHARS.test(text) ? JSON.stringify(text) : text;
    isWebOrigin = (site) => /^https?:\/\/[^/]+$/.test(site);
    refusal = (path, dirs, names) => new BrowserError(
      "UPLOAD_NOT_ALLOWED",
      // Mensagem única para "não existe", "não é arquivo" e "fora das pastas": a LLM não usa a recusa para sondar o disco.
      `${path} cannot be uploaded: it is not a file inside the folders allowed for upload (${dirs.join(", ")}); nothing was sent. To allow it, the operator adds its folder to the ${names.dirsEnv} environment variable of the ${names.server} (absolute paths, separated by "${delimiter}") and restarts the server, or moves the file into an allowed folder. Do not try to work around this.`
    );
    sameFolder = (a, b) => norm(resolve5(a)) === norm(resolve5(b));
  }
});

// src/upload-policy.ts
var init_upload_policy = __esm({
  "src/upload-policy.ts"() {
    "use strict";
    init_policy();
  }
});

// daemon/src/mcp-server.ts
import { homedir as homedir3 } from "node:os";
function describeBrowsers(list) {
  return list.map((b) => `"${b.name}" (id ${b.id})`).join(", ");
}
function lastFocused(list) {
  let best;
  for (const b of list) {
    if (b.lastFocusedAt && (!best || b.lastFocusedAt > best.lastFocusedAt)) best = b;
  }
  return best;
}
function chooseBrowser(list, requested) {
  if (requested) {
    const byId = list.find((b) => b.id === requested);
    if (byId) return { browser: byId };
    const byName = list.filter((b) => b.name.toLowerCase() === requested.toLowerCase());
    if (byName.length === 1) return { browser: byName[0] };
    if (byName.length > 1) {
      throw new BridgeError("BROWSER_AMBIGUOUS", `several browsers are named "${requested}"; pass the id instead: ${describeBrowsers(byName)}`, {
        browsers: byName
      });
    }
    throw new BridgeError("BROWSER_NOT_FOUND", `no connected browser matches "${requested}"; connected: ${describeBrowsers(list) || "none"}`, {
      browsers: list
    });
  }
  if (list.length === 0) {
    throw new BridgeError("NO_BROWSER_CONNECTED", "no browser is connected to the Atrium Bridge; ask the user to open one with the extension paired");
  }
  if (list.length > 1) {
    const focused = lastFocused(list);
    if (focused) return { browser: focused, notice: BROWSER_TEXTS.focusedNotice(focused.name) };
    throw new BridgeError(
      "BROWSER_AMBIGUOUS",
      `${list.length} browsers are connected (${describeBrowsers(list)}) and none has reported focus yet; ask the user which one to use and pass it as "browser"`,
      { browsers: list }
    );
  }
  return { browser: list[0] };
}
function render(tool, result) {
  const r = result;
  if (tool === "snapshot" && r && typeof r.snapshot === "string") {
    return [{ type: "text", text: `url: ${String(r.url)}
title: ${String(r.title)}

${r.snapshot}` }];
  }
  if (tool === "read" && r && typeof r.text === "string") {
    const cut = r.truncated === true ? `

[truncated: pass maxChars to read more]` : "";
    return [{ type: "text", text: `url: ${String(r.url)}
title: ${String(r.title)}

${r.text}${cut}` }];
  }
  if (tool === "screenshot" && r && typeof r.data === "string") {
    const { data, mimeType, ...meta2 } = r;
    return [
      { type: "image", data, mimeType: String(mimeType) },
      { type: "text", text: JSON.stringify(meta2) }
    ];
  }
  return [{ type: "text", text: JSON.stringify(result ?? null, null, 2) }];
}
function isPureRead(tool, args) {
  switch (tool) {
    case "snapshot":
    case "screenshot":
    case "find":
    case "read":
    case "links":
    case "wait":
    case "readNetwork":
    case "uploadTarget":
      return true;
    case "readConsole":
      return args.clear !== true;
    case "tabs":
      return args.action === "list";
    case "downloads":
      return args.action === "list";
    default:
      return false;
  }
}
function present(list, requested) {
  if (!requested) return list.length > 0;
  return list.some((b) => b.id === requested || b.name.toLowerCase() === requested.toLowerCase());
}
function createResilientBridge(client, shell2) {
  if (!shell2) {
    return {
      listBrowsers: async () => ({ value: await client.browsers(), restarted: false }),
      callTool: async (tool, args, requested) => {
        const { browser, notice } = chooseBrowser(await client.browsers(), requested);
        return { value: await client.call(browser.id, tool, args), restarted: false, browser: browser.id, ...notice ? { notice } : {} };
      }
    };
  }
  const { ensure: ensure2, log: log2 } = shell2;
  let sawDaemon = false;
  const waitCallMs = shell2.waitCallMs ?? REAPPEAR_DEFAULTS.waitCallMs;
  const waitListMs = shell2.waitListMs ?? REAPPEAR_DEFAULTS.waitListMs;
  const pollMs = shell2.waitPollMs ?? REAPPEAR_DEFAULTS.waitPollMs;
  const sleep = shell2.sleep ?? ((ms) => new Promise((resolve9) => setTimeout(resolve9, ms)));
  const now = shell2.now ?? (() => Date.now());
  async function alive(request2) {
    try {
      const value = await request2;
      sawDaemon = true;
      return value;
    } catch (e) {
      if (downPhase(e) === void 0) sawDaemon = true;
      throw e;
    }
  }
  async function browsersWhen(isReady, maxWaitMs) {
    let list = await alive(client.browsers());
    const ageMs = isReady(list) ? null : ensure2.youngAgeMs();
    if (ageMs === null) return { list, waitedMs: 0, ageMs: 0 };
    const began = now();
    while (!isReady(list) && now() - began < maxWaitMs) {
      await sleep(pollMs);
      list = await alive(client.browsers());
    }
    const waitedMs = now() - began;
    log2("browsers_waited", { ms: waitedMs, found: isReady(list) });
    return { list, waitedMs, ageMs };
  }
  function resolveAfterWait(waited, requested) {
    try {
      return chooseBrowser(waited.list, requested);
    } catch (e) {
      if (waited.waitedMs > 0 && e instanceof BridgeError && (e.code === "NO_BROWSER_CONNECTED" || e.code === "BROWSER_NOT_FOUND")) {
        const suffix = DAEMON_TEXTS.waitedSuffix({ ageSeconds: Math.round(waited.ageMs / 1e3), waitedSeconds: Math.round(waited.waitedMs / 1e3) });
        throw new BridgeError(e.code, `${e.message}. ${suffix}`, e.data);
      }
      throw e;
    }
  }
  async function ensureAfterLoss(tool) {
    try {
      await ensure2.ensure("call");
    } catch (e) {
      if (e instanceof BridgeError) throw new BridgeError(e.code, `${e.message} ${DAEMON_TEXTS.lostSuffix(tool)}`, e.data);
      throw e;
    }
  }
  async function guarded(tool, pureRead, run) {
    let restarted = false;
    for (let round = 1; ; round++) {
      const progress = { stage: "lookup" };
      try {
        const value = await run(progress);
        return { value, restarted, ...progress.notice ? { notice: progress.notice } : {}, ...progress.browser ? { browser: progress.browser } : {} };
      } catch (e) {
        const phase = downPhase(e);
        if (phase === void 0) {
          if (progress.stage === "call" && round < MAX_ROUNDS && isRemote(e, "BROWSER_NOT_FOUND") && ensure2.youngAgeMs() !== null) continue;
          throw e;
        }
        if (round >= MAX_ROUNDS) throw e;
        log2("daemon_unreachable", { phase, tool });
        if (phase === "in-flight" && progress.stage === "call" && !pureRead) {
          await ensureAfterLoss(tool);
          log2("call_lost", { tool });
          throw new BridgeError("DAEMON_RESTARTED", DAEMON_TEXTS.restarted(tool), { tool });
        }
        const outcome = await ensure2.ensure("call");
        restarted ||= outcome.restarted && (outcome.source === "call" || sawDaemon);
        if (phase === "in-flight") log2("call_retried", { tool });
      }
    }
  }
  return {
    listBrowsers: () => guarded("list_browsers", true, async () => (await browsersWhen((list) => list.length > 0, waitListMs)).list),
    callTool: (tool, args, requested) => guarded(tool, isPureRead(tool, args), async (progress) => {
      const waited = await browsersWhen((list) => present(list, requested), waitCallMs);
      const { browser, notice } = resolveAfterWait(waited, requested);
      if (notice) progress.notice = notice;
      progress.browser = browser.id;
      progress.stage = "call";
      return alive(client.call(browser.id, tool, args));
    })
  };
}
function serverNameFromEnv(env = process.env, fallback = SERVER_NAME) {
  const name = env.ATRIUM_BRIDGE_SERVER_NAME?.trim();
  return name && SERVER_NAME_PATTERN2.test(name) ? name : fallback;
}
function uploadSetupFromEnv(env = process.env) {
  return {
    dirs: uploadDirs(env, homedir3(), BRIDGE_UPLOAD_NAMES.dirsEnv),
    trusted: uploadDirsTrusted(env, BRIDGE_UPLOAD_NAMES.trustedEnv)
  };
}
function buildMcpServer(client, shell2, info2 = {}) {
  const server = new Server({ name: info2.name ?? SERVER_NAME, version: "0.1.0" }, { capabilities: { tools: {} } });
  const bridge = createResilientBridge(client, shell2);
  const policyLog = (line) => shell2?.log("upload_policy", { line });
  let policy = null;
  const uploads = () => {
    if (policy) return policy;
    const setup = typeof info2.upload === "function" ? info2.upload() : info2.upload ?? uploadSetupFromEnv();
    policy = uploadPolicy(setup.dirs, {
      trusted: setup.trusted ?? [],
      confirm: elicitUploadConfirm(server, policyLog),
      log: policyLog,
      names: BRIDGE_UPLOAD_NAMES,
      ...setup.home ? { home: setup.home } : {}
    });
    return policy;
  };
  async function grantTool(tool, a) {
    const p = uploads();
    if (tool === "allowUploads") {
      const { grant, already } = await p.allowUploads({ folder: a.folder, origin: a.origin });
      return {
        authorized: showGrant(grant),
        note: already ? "This folder was already authorized for this site in this session; nothing changed." : "The operator allowed it. upload now sends files from this folder (and its subfolders) to this exact site without asking, until this MCP server stops."
      };
    }
    if (tool === "uploadPermissions") {
      const view = p.uploadGrants();
      return {
        grants: view.grants.map(showGrant),
        trusted: view.trusted,
        note: view.grants.length ? "Session authorizations live only in the memory of this MCP server and end when it stops. A field embedded from another site is never covered." : "No session authorizations: every upload outside the pre-authorized folders asks the operator."
      };
    }
    const r = p.revokeUploads({ origin: a.origin, ...a.folder !== void 0 ? { folder: a.folder } : {} });
    return { removed: r.removed.map(showGrant), grants: r.grants.map(showGrant) };
  }
  async function uploadCall(a) {
    const p = uploads();
    const { browser, tab, ref, paths } = a;
    const files = paths.map((path) => p.resolveUploadPath(path));
    const target = await bridge.callTool("uploadTarget", { ref, ...tab !== void 0 ? { tab } : {} }, browser);
    const { tab: tabId, origins, multiple } = target.value;
    if (files.length > 1 && !multiple) {
      throw Object.assign(new Error(`upload: this file input accepts a single file (no multiple attribute); ${files.length} paths were given`), { code: "INVALID_ARGUMENT" });
    }
    for (const file of files) {
      await p.authorizeUpload({ file, site: origins[0], top: origins[origins.length - 1], ancestors: origins.slice(1) });
    }
    const done = await bridge.callTool("upload", { ref, tab: tabId, paths: files, expect: origins }, target.browser ?? browser);
    return { ...done, restarted: target.restarted || done.restarted, ...target.notice ? { notice: target.notice } : {} };
  }
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: BRIDGE_CATALOG.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = req.params.name;
    try {
      const args = req.params.arguments ?? {};
      assertValidCall(tool, args);
      if (tool === "list_browsers") {
        const { value: value2, restarted: restarted2 } = await bridge.listBrowsers();
        return { content: withNotice([{ type: "text", text: JSON.stringify(value2, null, 2) }], restarted2) };
      }
      if (SHELL_ONLY_TOOLS.has(tool)) return { content: render(tool, await grantTool(tool, args)) };
      if (tool === "upload") {
        const { value: value2, restarted: restarted2, notice: notice2 } = await uploadCall(args);
        return { content: withNotice(render(tool, value2), restarted2, notice2) };
      }
      const { browser, ...rest2 } = args;
      const { value, restarted, notice } = await bridge.callTool(tool, rest2, browser);
      return { content: withNotice(render(tool, value), restarted, notice) };
    } catch (e) {
      const w = toWireError(e);
      const detail = w.data !== void 0 ? `
${JSON.stringify(w.data)}` : "";
      return { isError: true, content: [{ type: "text", text: `${w.code}: ${w.message}${detail}` }] };
    }
  });
  return server;
}
var REAPPEAR_DEFAULTS, MAX_ROUNDS, isRemote, withNotice, SERVER_NAME_PATTERN2, BRIDGE_UPLOAD_NAMES, showGrant;
var init_mcp_server = __esm({
  "daemon/src/mcp-server.ts"() {
    "use strict";
    init_server2();
    init_types();
    init_catalog2();
    init_errors3();
    init_texts();
    init_client();
    init_upload_policy();
    REAPPEAR_DEFAULTS = { waitCallMs: 4e4, waitListMs: 5e3, waitPollMs: 500 };
    MAX_ROUNDS = 3;
    isRemote = (e, code) => e instanceof RemoteError && e.code === code;
    withNotice = (content, restarted, notice) => {
      const notices = [];
      if (restarted) notices.push({ type: "text", text: DAEMON_TEXTS.restartedNotice });
      if (notice) notices.push({ type: "text", text: notice });
      return [...notices, ...content];
    };
    SERVER_NAME_PATTERN2 = /^[A-Za-z0-9_-]{1,64}$/;
    BRIDGE_UPLOAD_NAMES = Object.freeze({
      upload: "upload",
      allow: "allowUploads",
      revoke: "revokeUploads",
      server: "Bridge MCP server",
      dirsEnv: "ATRIUM_BRIDGE_UPLOAD_DIRS",
      trustedEnv: "ATRIUM_BRIDGE_UPLOAD_DIRS_TRUSTED"
    });
    showGrant = (g) => ({ ...g, via: g.via === "WebAllowUploads" ? "allowUploads" : g.via });
  }
});

// daemon/src/mcp.ts
var mcp_exports = {};
import { existsSync as existsSync5 } from "node:fs";
import { join as join5 } from "node:path";
var home, log, sourceCli, launch, ensure, serverName, uploadKey;
var init_mcp = __esm({
  async "daemon/src/mcp.ts"() {
    "use strict";
    init_stdio2();
    init_client();
    init_config();
    init_keys();
    init_ensure();
    init_mcp_server();
    init_package_info();
    init_texts();
    home = bridgeHome();
    log = createShellLog(mcpLogPath(home));
    sourceCli = join5(import.meta.dirname, "cli.ts");
    launch = {
      entry: existsSync5(sourceCli) ? sourceCli : process.argv[1],
      args: ["start"],
      execArgv: process.execArgv.filter((arg) => !arg.startsWith("--inspect"))
    };
    ensure = createEnsure(nodeEnsureOps({ home, launch, log }), {
      ...ENSURE_DEFAULTS,
      port: () => resolvePort(),
      logFile: daemonLogPath(home)
    });
    serverName = serverNameFromEnv(process.env, packagedServerName(buildInfoOfScript()) ?? SERVER_NAME);
    uploadKey = () => ensureUploadKey(home);
    await buildMcpServer(new BridgeClient(() => ({ ...targetFromEnv(), uploadKey })), { ensure, log }, { name: serverName }).connect(
      new StdioServerTransport()
    );
    void ensure.warmup();
    process.stdin.once("close", () => process.exit(0));
  }
});

// node_modules/ws/lib/constants.js
var require_constants = __commonJS({
  "node_modules/ws/lib/constants.js"(exports, module) {
    "use strict";
    var BINARY_TYPES = ["nodebuffer", "arraybuffer", "fragments"];
    var hasBlob = typeof Blob !== "undefined";
    if (hasBlob) BINARY_TYPES.push("blob");
    module.exports = {
      BINARY_TYPES,
      CLOSE_TIMEOUT: 3e4,
      EMPTY_BUFFER: Buffer.alloc(0),
      GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      hasBlob,
      kForOnEventAttribute: Symbol("kIsForOnEventAttribute"),
      kListener: Symbol("kListener"),
      kStatusCode: Symbol("status-code"),
      kWebSocket: Symbol("websocket"),
      NOOP: () => {
      }
    };
  }
});

// node_modules/ws/lib/buffer-util.js
var require_buffer_util = __commonJS({
  "node_modules/ws/lib/buffer-util.js"(exports, module) {
    "use strict";
    var { EMPTY_BUFFER } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    function concat(list, totalLength) {
      if (list.length === 0) return EMPTY_BUFFER;
      if (list.length === 1) return list[0];
      const target = Buffer.allocUnsafe(totalLength);
      let offset = 0;
      for (let i = 0; i < list.length; i++) {
        const buf = list[i];
        target.set(buf, offset);
        offset += buf.length;
      }
      if (offset < totalLength) {
        return new FastBuffer(target.buffer, target.byteOffset, offset);
      }
      return target;
    }
    function _mask(source, mask, output, offset, length) {
      for (let i = 0; i < length; i++) {
        output[offset + i] = source[i] ^ mask[i & 3];
      }
    }
    function _unmask(buffer, mask) {
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] ^= mask[i & 3];
      }
    }
    function toArrayBuffer(buf) {
      if (buf.length === buf.buffer.byteLength) {
        return buf.buffer;
      }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    }
    function toBuffer(data) {
      toBuffer.readOnly = true;
      if (Buffer.isBuffer(data)) return data;
      let buf;
      if (data instanceof ArrayBuffer) {
        buf = new FastBuffer(data);
      } else if (ArrayBuffer.isView(data)) {
        buf = new FastBuffer(data.buffer, data.byteOffset, data.byteLength);
      } else {
        buf = Buffer.from(data);
        toBuffer.readOnly = false;
      }
      return buf;
    }
    module.exports = {
      concat,
      mask: _mask,
      toArrayBuffer,
      toBuffer,
      unmask: _unmask
    };
    if (!process.env.WS_NO_BUFFER_UTIL) {
      try {
        const bufferUtil = __require("bufferutil");
        module.exports.mask = function(source, mask, output, offset, length) {
          if (length < 48) _mask(source, mask, output, offset, length);
          else bufferUtil.mask(source, mask, output, offset, length);
        };
        module.exports.unmask = function(buffer, mask) {
          if (buffer.length < 32) _unmask(buffer, mask);
          else bufferUtil.unmask(buffer, mask);
        };
      } catch (e) {
      }
    }
  }
});

// node_modules/ws/lib/limiter.js
var require_limiter = __commonJS({
  "node_modules/ws/lib/limiter.js"(exports, module) {
    "use strict";
    var kDone = Symbol("kDone");
    var kRun = Symbol("kRun");
    var Limiter = class {
      /**
       * Creates a new `Limiter`.
       *
       * @param {Number} [concurrency=Infinity] The maximum number of jobs allowed
       *     to run concurrently
       */
      constructor(concurrency) {
        this[kDone] = () => {
          this.pending--;
          this[kRun]();
        };
        this.concurrency = concurrency || Infinity;
        this.jobs = [];
        this.pending = 0;
      }
      /**
       * Adds a job to the queue.
       *
       * @param {Function} job The job to run
       * @public
       */
      add(job) {
        this.jobs.push(job);
        this[kRun]();
      }
      /**
       * Removes a job from the queue and runs it if possible.
       *
       * @private
       */
      [kRun]() {
        if (this.pending === this.concurrency) return;
        if (this.jobs.length) {
          const job = this.jobs.shift();
          this.pending++;
          job(this[kDone]);
        }
      }
    };
    module.exports = Limiter;
  }
});

// node_modules/ws/lib/permessage-deflate.js
var require_permessage_deflate = __commonJS({
  "node_modules/ws/lib/permessage-deflate.js"(exports, module) {
    "use strict";
    var zlib = __require("zlib");
    var bufferUtil = require_buffer_util();
    var Limiter = require_limiter();
    var { kStatusCode } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    var TRAILER = Buffer.from([0, 0, 255, 255]);
    var kPerMessageDeflate = Symbol("permessage-deflate");
    var kTotalLength = Symbol("total-length");
    var kCallback = Symbol("callback");
    var kBuffers = Symbol("buffers");
    var kError = Symbol("error");
    var zlibLimiter;
    var PerMessageDeflate2 = class {
      /**
       * Creates a PerMessageDeflate instance.
       *
       * @param {Object} [options] Configuration options
       * @param {(Boolean|Number)} [options.clientMaxWindowBits] Advertise support
       *     for, or request, a custom client window size
       * @param {Boolean} [options.clientNoContextTakeover=false] Advertise/
       *     acknowledge disabling of client context takeover
       * @param {Number} [options.concurrencyLimit=10] The number of concurrent
       *     calls to zlib
       * @param {Boolean} [options.isServer=false] Create the instance in either
       *     server or client mode
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {(Boolean|Number)} [options.serverMaxWindowBits] Request/confirm the
       *     use of a custom server window size
       * @param {Boolean} [options.serverNoContextTakeover=false] Request/accept
       *     disabling of server context takeover
       * @param {Number} [options.threshold=1024] Size (in bytes) below which
       *     messages should not be compressed if context takeover is disabled
       * @param {Object} [options.zlibDeflateOptions] Options to pass to zlib on
       *     deflate
       * @param {Object} [options.zlibInflateOptions] Options to pass to zlib on
       *     inflate
       */
      constructor(options) {
        this._options = options || {};
        this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024;
        this._maxPayload = this._options.maxPayload | 0;
        this._isServer = !!this._options.isServer;
        this._deflate = null;
        this._inflate = null;
        this.params = null;
        if (!zlibLimiter) {
          const concurrency = this._options.concurrencyLimit !== void 0 ? this._options.concurrencyLimit : 10;
          zlibLimiter = new Limiter(concurrency);
        }
      }
      /**
       * @type {String}
       */
      static get extensionName() {
        return "permessage-deflate";
      }
      /**
       * Create an extension negotiation offer.
       *
       * @return {Object} Extension parameters
       * @public
       */
      offer() {
        const params = {};
        if (this._options.serverNoContextTakeover) {
          params.server_no_context_takeover = true;
        }
        if (this._options.clientNoContextTakeover) {
          params.client_no_context_takeover = true;
        }
        if (this._options.serverMaxWindowBits) {
          params.server_max_window_bits = this._options.serverMaxWindowBits;
        }
        if (this._options.clientMaxWindowBits) {
          params.client_max_window_bits = this._options.clientMaxWindowBits;
        } else if (this._options.clientMaxWindowBits == null) {
          params.client_max_window_bits = true;
        }
        return params;
      }
      /**
       * Accept an extension negotiation offer/response.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Object} Accepted configuration
       * @public
       */
      accept(configurations) {
        configurations = this.normalizeParams(configurations);
        this.params = this._isServer ? this.acceptAsServer(configurations) : this.acceptAsClient(configurations);
        return this.params;
      }
      /**
       * Releases all resources used by the extension.
       *
       * @public
       */
      cleanup() {
        if (this._inflate) {
          this._inflate.close();
          this._inflate = null;
        }
        if (this._deflate) {
          const callback = this._deflate[kCallback];
          this._deflate.close();
          this._deflate = null;
          if (callback) {
            callback(
              new Error(
                "The deflate stream was closed while data was being processed"
              )
            );
          }
        }
      }
      /**
       *  Accept an extension negotiation offer.
       *
       * @param {Array} offers The extension negotiation offers
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsServer(offers) {
        const opts = this._options;
        const accepted = offers.find((params) => {
          if (opts.serverNoContextTakeover === false && params.server_no_context_takeover || params.server_max_window_bits && (opts.serverMaxWindowBits === false || typeof opts.serverMaxWindowBits === "number" && opts.serverMaxWindowBits > params.server_max_window_bits) || typeof opts.clientMaxWindowBits === "number" && (typeof params.client_max_window_bits === "number" ? opts.clientMaxWindowBits > params.client_max_window_bits : !params.client_max_window_bits)) {
            return false;
          }
          return true;
        });
        if (!accepted) {
          throw new Error("None of the extension offers can be accepted");
        }
        if (opts.serverNoContextTakeover) {
          accepted.server_no_context_takeover = true;
        }
        if (opts.clientNoContextTakeover) {
          accepted.client_no_context_takeover = true;
        }
        if (typeof opts.serverMaxWindowBits === "number") {
          accepted.server_max_window_bits = opts.serverMaxWindowBits;
        }
        if (typeof opts.clientMaxWindowBits === "number") {
          accepted.client_max_window_bits = opts.clientMaxWindowBits;
        } else if (accepted.client_max_window_bits === true || opts.clientMaxWindowBits === false) {
          delete accepted.client_max_window_bits;
        }
        return accepted;
      }
      /**
       * Accept the extension negotiation response.
       *
       * @param {Array} response The extension negotiation response
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsClient(response) {
        const params = response[0];
        if (this._options.clientNoContextTakeover === false && params.client_no_context_takeover) {
          throw new Error('Unexpected parameter "client_no_context_takeover"');
        }
        if (!params.client_max_window_bits) {
          if (typeof this._options.clientMaxWindowBits === "number") {
            params.client_max_window_bits = this._options.clientMaxWindowBits;
          }
        } else if (this._options.clientMaxWindowBits === false || typeof this._options.clientMaxWindowBits === "number" && params.client_max_window_bits > this._options.clientMaxWindowBits) {
          throw new Error(
            'Unexpected or invalid parameter "client_max_window_bits"'
          );
        }
        return params;
      }
      /**
       * Normalize parameters.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Array} The offers/response with normalized parameters
       * @private
       */
      normalizeParams(configurations) {
        configurations.forEach((params) => {
          Object.keys(params).forEach((key) => {
            let value = params[key];
            if (value.length > 1) {
              throw new Error(`Parameter "${key}" must have only a single value`);
            }
            value = value[0];
            if (key === "client_max_window_bits") {
              if (value !== true) {
                const num3 = +value;
                if (!Number.isInteger(num3) || num3 < 8 || num3 > 15) {
                  throw new TypeError(
                    `Invalid value for parameter "${key}": ${value}`
                  );
                }
                value = num3;
              } else if (!this._isServer) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else if (key === "server_max_window_bits") {
              const num3 = +value;
              if (!Number.isInteger(num3) || num3 < 8 || num3 > 15) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
              value = num3;
            } else if (key === "client_no_context_takeover" || key === "server_no_context_takeover") {
              if (value !== true) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else {
              throw new Error(`Unknown parameter "${key}"`);
            }
            params[key] = value;
          });
        });
        return configurations;
      }
      /**
       * Decompress data. Concurrency limited.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      decompress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._decompress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Compress data. Concurrency limited.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      compress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._compress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Decompress data.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _decompress(data, fin, callback) {
        const endpoint = this._isServer ? "client" : "server";
        if (!this._inflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._inflate = zlib.createInflateRaw({
            ...this._options.zlibInflateOptions,
            windowBits
          });
          this._inflate[kPerMessageDeflate] = this;
          this._inflate[kTotalLength] = 0;
          this._inflate[kBuffers] = [];
          this._inflate.on("error", inflateOnError);
          this._inflate.on("data", inflateOnData);
        }
        this._inflate[kCallback] = callback;
        this._inflate.write(data);
        if (fin) this._inflate.write(TRAILER);
        this._inflate.flush(() => {
          const err = this._inflate[kError];
          if (err) {
            this._inflate.close();
            this._inflate = null;
            callback(err);
            return;
          }
          const data2 = bufferUtil.concat(
            this._inflate[kBuffers],
            this._inflate[kTotalLength]
          );
          if (this._inflate._readableState.endEmitted) {
            this._inflate.close();
            this._inflate = null;
          } else {
            this._inflate[kTotalLength] = 0;
            this._inflate[kBuffers] = [];
            if (fin && this.params[`${endpoint}_no_context_takeover`]) {
              this._inflate.reset();
            }
          }
          callback(null, data2);
        });
      }
      /**
       * Compress data.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _compress(data, fin, callback) {
        const endpoint = this._isServer ? "server" : "client";
        if (!this._deflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._deflate = zlib.createDeflateRaw({
            ...this._options.zlibDeflateOptions,
            windowBits
          });
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          this._deflate.on("data", deflateOnData);
        }
        this._deflate[kCallback] = callback;
        this._deflate.write(data);
        this._deflate.flush(zlib.Z_SYNC_FLUSH, () => {
          if (!this._deflate) {
            return;
          }
          let data2 = bufferUtil.concat(
            this._deflate[kBuffers],
            this._deflate[kTotalLength]
          );
          if (fin) {
            data2 = new FastBuffer(data2.buffer, data2.byteOffset, data2.length - 4);
          }
          this._deflate[kCallback] = null;
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          if (fin && this.params[`${endpoint}_no_context_takeover`]) {
            this._deflate.reset();
          }
          callback(null, data2);
        });
      }
    };
    module.exports = PerMessageDeflate2;
    function deflateOnData(chunk) {
      this[kBuffers].push(chunk);
      this[kTotalLength] += chunk.length;
    }
    function inflateOnData(chunk) {
      this[kTotalLength] += chunk.length;
      if (this[kPerMessageDeflate]._maxPayload < 1 || this[kTotalLength] <= this[kPerMessageDeflate]._maxPayload) {
        this[kBuffers].push(chunk);
        return;
      }
      this[kError] = new RangeError("Max payload size exceeded");
      this[kError].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
      this[kError][kStatusCode] = 1009;
      this.removeListener("data", inflateOnData);
      this.reset();
    }
    function inflateOnError(err) {
      this[kPerMessageDeflate]._inflate = null;
      if (this[kError]) {
        this[kCallback](this[kError]);
        return;
      }
      err[kStatusCode] = 1007;
      this[kCallback](err);
    }
  }
});

// node_modules/ws/lib/validation.js
var require_validation2 = __commonJS({
  "node_modules/ws/lib/validation.js"(exports, module) {
    "use strict";
    var { isUtf8 } = __require("buffer");
    var { hasBlob } = require_constants();
    var tokenChars = [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 0 - 15
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 16 - 31
      0,
      1,
      0,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      1,
      1,
      0,
      1,
      1,
      0,
      // 32 - 47
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      // 48 - 63
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 64 - 79
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      1,
      1,
      // 80 - 95
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 96 - 111
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      1,
      0,
      1,
      0
      // 112 - 127
    ];
    function isValidStatusCode(code) {
      return code >= 1e3 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3e3 && code <= 4999;
    }
    function _isValidUTF8(buf) {
      const len = buf.length;
      let i = 0;
      while (i < len) {
        if ((buf[i] & 128) === 0) {
          i++;
        } else if ((buf[i] & 224) === 192) {
          if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) {
            return false;
          }
          i += 2;
        } else if ((buf[i] & 240) === 224) {
          if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || // Overlong
          buf[i] === 237 && (buf[i + 1] & 224) === 160) {
            return false;
          }
          i += 3;
        } else if ((buf[i] & 248) === 240) {
          if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || // Overlong
          buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) {
            return false;
          }
          i += 4;
        } else {
          return false;
        }
      }
      return true;
    }
    function isBlob(value) {
      return hasBlob && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.type === "string" && typeof value.stream === "function" && (value[Symbol.toStringTag] === "Blob" || value[Symbol.toStringTag] === "File");
    }
    module.exports = {
      isBlob,
      isValidStatusCode,
      isValidUTF8: _isValidUTF8,
      tokenChars
    };
    if (isUtf8) {
      module.exports.isValidUTF8 = function(buf) {
        return buf.length < 24 ? _isValidUTF8(buf) : isUtf8(buf);
      };
    } else if (!process.env.WS_NO_UTF_8_VALIDATE) {
      try {
        const isValidUTF8 = __require("utf-8-validate");
        module.exports.isValidUTF8 = function(buf) {
          return buf.length < 32 ? _isValidUTF8(buf) : isValidUTF8(buf);
        };
      } catch (e) {
      }
    }
  }
});

// node_modules/ws/lib/receiver.js
var require_receiver = __commonJS({
  "node_modules/ws/lib/receiver.js"(exports, module) {
    "use strict";
    var { Writable } = __require("stream");
    var PerMessageDeflate2 = require_permessage_deflate();
    var {
      BINARY_TYPES,
      EMPTY_BUFFER,
      kStatusCode,
      kWebSocket
    } = require_constants();
    var { concat, toArrayBuffer, unmask } = require_buffer_util();
    var { isValidStatusCode, isValidUTF8 } = require_validation2();
    var FastBuffer = Buffer[Symbol.species];
    var GET_INFO = 0;
    var GET_PAYLOAD_LENGTH_16 = 1;
    var GET_PAYLOAD_LENGTH_64 = 2;
    var GET_MASK = 3;
    var GET_DATA = 4;
    var INFLATING = 5;
    var DEFER_EVENT = 6;
    var Receiver2 = class extends Writable {
      /**
       * Creates a Receiver instance.
       *
       * @param {Object} [options] Options object
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {String} [options.binaryType=nodebuffer] The type for binary data
       * @param {Object} [options.extensions] An object containing the negotiated
       *     extensions
       * @param {Boolean} [options.isServer=false] Specifies whether to operate in
       *     client or server mode
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       */
      constructor(options = {}) {
        super();
        this._allowSynchronousEvents = options.allowSynchronousEvents !== void 0 ? options.allowSynchronousEvents : true;
        this._binaryType = options.binaryType || BINARY_TYPES[0];
        this._extensions = options.extensions || {};
        this._isServer = !!options.isServer;
        this._maxBufferedChunks = options.maxBufferedChunks | 0;
        this._maxFragments = options.maxFragments | 0;
        this._maxPayload = options.maxPayload | 0;
        this._skipUTF8Validation = !!options.skipUTF8Validation;
        this[kWebSocket] = void 0;
        this._bufferedBytes = 0;
        this._buffers = [];
        this._compressed = false;
        this._payloadLength = 0;
        this._mask = void 0;
        this._fragmented = 0;
        this._masked = false;
        this._fin = false;
        this._opcode = 0;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._numFragments = 0;
        this._fragments = [];
        this._errored = false;
        this._loop = false;
        this._state = GET_INFO;
      }
      /**
       * Implements `Writable.prototype._write()`.
       *
       * @param {Buffer} chunk The chunk of data to write
       * @param {String} encoding The character encoding of `chunk`
       * @param {Function} cb Callback
       * @private
       */
      _write(chunk, encoding, cb) {
        if (this._opcode === 8 && this._state == GET_INFO) return cb();
        if (this._maxBufferedChunks > 0 && this._buffers.length >= this._maxBufferedChunks) {
          cb(
            this.createError(
              RangeError,
              "Too many buffered chunks",
              false,
              1008,
              "WS_ERR_TOO_MANY_BUFFERED_PARTS"
            )
          );
          return;
        }
        this._bufferedBytes += chunk.length;
        this._buffers.push(chunk);
        this.startLoop(cb);
      }
      /**
       * Consumes `n` bytes from the buffered data.
       *
       * @param {Number} n The number of bytes to consume
       * @return {Buffer} The consumed bytes
       * @private
       */
      consume(n) {
        this._bufferedBytes -= n;
        if (n === this._buffers[0].length) return this._buffers.shift();
        if (n < this._buffers[0].length) {
          const buf = this._buffers[0];
          this._buffers[0] = new FastBuffer(
            buf.buffer,
            buf.byteOffset + n,
            buf.length - n
          );
          return new FastBuffer(buf.buffer, buf.byteOffset, n);
        }
        const dst = Buffer.allocUnsafe(n);
        do {
          const buf = this._buffers[0];
          const offset = dst.length - n;
          if (n >= buf.length) {
            dst.set(this._buffers.shift(), offset);
          } else {
            dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset);
            this._buffers[0] = new FastBuffer(
              buf.buffer,
              buf.byteOffset + n,
              buf.length - n
            );
          }
          n -= buf.length;
        } while (n > 0);
        return dst;
      }
      /**
       * Starts the parsing loop.
       *
       * @param {Function} cb Callback
       * @private
       */
      startLoop(cb) {
        this._loop = true;
        do {
          switch (this._state) {
            case GET_INFO:
              this.getInfo(cb);
              break;
            case GET_PAYLOAD_LENGTH_16:
              this.getPayloadLength16(cb);
              break;
            case GET_PAYLOAD_LENGTH_64:
              this.getPayloadLength64(cb);
              break;
            case GET_MASK:
              this.getMask();
              break;
            case GET_DATA:
              this.getData(cb);
              break;
            case INFLATING:
            case DEFER_EVENT:
              this._loop = false;
              return;
          }
        } while (this._loop);
        if (!this._errored) cb();
      }
      /**
       * Reads the first two bytes of a frame.
       *
       * @param {Function} cb Callback
       * @private
       */
      getInfo(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        const buf = this.consume(2);
        if ((buf[0] & 48) !== 0) {
          const error2 = this.createError(
            RangeError,
            "RSV2 and RSV3 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_2_3"
          );
          cb(error2);
          return;
        }
        const compressed = (buf[0] & 64) === 64;
        if (compressed && !this._extensions[PerMessageDeflate2.extensionName]) {
          const error2 = this.createError(
            RangeError,
            "RSV1 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_1"
          );
          cb(error2);
          return;
        }
        this._fin = (buf[0] & 128) === 128;
        this._opcode = buf[0] & 15;
        this._payloadLength = buf[1] & 127;
        if (this._opcode === 0) {
          if (compressed) {
            const error2 = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error2);
            return;
          }
          if (!this._fragmented) {
            const error2 = this.createError(
              RangeError,
              "invalid opcode 0",
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error2);
            return;
          }
          this._opcode = this._fragmented;
        } else if (this._opcode === 1 || this._opcode === 2) {
          if (this._fragmented) {
            const error2 = this.createError(
              RangeError,
              `invalid opcode ${this._opcode}`,
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error2);
            return;
          }
          this._compressed = compressed;
        } else if (this._opcode > 7 && this._opcode < 11) {
          if (!this._fin) {
            const error2 = this.createError(
              RangeError,
              "FIN must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_FIN"
            );
            cb(error2);
            return;
          }
          if (compressed) {
            const error2 = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error2);
            return;
          }
          if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
            const error2 = this.createError(
              RangeError,
              `invalid payload length ${this._payloadLength}`,
              true,
              1002,
              "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"
            );
            cb(error2);
            return;
          }
        } else {
          const error2 = this.createError(
            RangeError,
            `invalid opcode ${this._opcode}`,
            true,
            1002,
            "WS_ERR_INVALID_OPCODE"
          );
          cb(error2);
          return;
        }
        if (!this._fin && !this._fragmented) this._fragmented = this._opcode;
        this._masked = (buf[1] & 128) === 128;
        if (this._isServer) {
          if (!this._masked) {
            const error2 = this.createError(
              RangeError,
              "MASK must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_MASK"
            );
            cb(error2);
            return;
          }
        } else if (this._masked) {
          const error2 = this.createError(
            RangeError,
            "MASK must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_MASK"
          );
          cb(error2);
          return;
        }
        if (this._payloadLength === 126) this._state = GET_PAYLOAD_LENGTH_16;
        else if (this._payloadLength === 127) this._state = GET_PAYLOAD_LENGTH_64;
        else this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+16).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength16(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        this._payloadLength = this.consume(2).readUInt16BE(0);
        this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+64).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength64(cb) {
        if (this._bufferedBytes < 8) {
          this._loop = false;
          return;
        }
        const buf = this.consume(8);
        const num3 = buf.readUInt32BE(0);
        if (num3 > Math.pow(2, 53 - 32) - 1) {
          const error2 = this.createError(
            RangeError,
            "Unsupported WebSocket frame: payload length > 2^53 - 1",
            false,
            1009,
            "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH"
          );
          cb(error2);
          return;
        }
        this._payloadLength = num3 * Math.pow(2, 32) + buf.readUInt32BE(4);
        this.haveLength(cb);
      }
      /**
       * Payload length has been read.
       *
       * @param {Function} cb Callback
       * @private
       */
      haveLength(cb) {
        if (this._payloadLength && this._opcode < 8) {
          this._totalPayloadLength += this._payloadLength;
          if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
            const error2 = this.createError(
              RangeError,
              "Max payload size exceeded",
              false,
              1009,
              "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
            );
            cb(error2);
            return;
          }
        }
        if (this._masked) this._state = GET_MASK;
        else this._state = GET_DATA;
      }
      /**
       * Reads mask bytes.
       *
       * @private
       */
      getMask() {
        if (this._bufferedBytes < 4) {
          this._loop = false;
          return;
        }
        this._mask = this.consume(4);
        this._state = GET_DATA;
      }
      /**
       * Reads data bytes.
       *
       * @param {Function} cb Callback
       * @private
       */
      getData(cb) {
        let data = EMPTY_BUFFER;
        if (this._payloadLength) {
          if (this._bufferedBytes < this._payloadLength) {
            this._loop = false;
            return;
          }
          data = this.consume(this._payloadLength);
          if (this._masked && (this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0) {
            unmask(data, this._mask);
          }
        }
        if (this._opcode > 7) {
          this.controlMessage(data, cb);
          return;
        }
        if (this._maxFragments > 0 && ++this._numFragments > this._maxFragments) {
          const error2 = this.createError(
            RangeError,
            "Too many message fragments",
            false,
            1008,
            "WS_ERR_TOO_MANY_BUFFERED_PARTS"
          );
          cb(error2);
          return;
        }
        if (this._compressed) {
          this._state = INFLATING;
          this.decompress(data, cb);
          return;
        }
        if (data.length) {
          this._messageLength = this._totalPayloadLength;
          this._fragments.push(data);
        }
        this.dataMessage(cb);
      }
      /**
       * Decompresses data.
       *
       * @param {Buffer} data Compressed data
       * @param {Function} cb Callback
       * @private
       */
      decompress(data, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        perMessageDeflate.decompress(data, this._fin, (err, buf) => {
          if (err) return cb(err);
          if (buf.length) {
            this._messageLength += buf.length;
            if (this._messageLength > this._maxPayload && this._maxPayload > 0) {
              const error2 = this.createError(
                RangeError,
                "Max payload size exceeded",
                false,
                1009,
                "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
              );
              cb(error2);
              return;
            }
            this._fragments.push(buf);
          }
          this.dataMessage(cb);
          if (this._state === GET_INFO) this.startLoop(cb);
        });
      }
      /**
       * Handles a data message.
       *
       * @param {Function} cb Callback
       * @private
       */
      dataMessage(cb) {
        if (!this._fin) {
          this._state = GET_INFO;
          return;
        }
        const messageLength = this._messageLength;
        const fragments = this._fragments;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragmented = 0;
        this._numFragments = 0;
        this._fragments = [];
        if (this._opcode === 2) {
          let data;
          if (this._binaryType === "nodebuffer") {
            data = concat(fragments, messageLength);
          } else if (this._binaryType === "arraybuffer") {
            data = toArrayBuffer(concat(fragments, messageLength));
          } else if (this._binaryType === "blob") {
            data = new Blob(fragments);
          } else {
            data = fragments;
          }
          if (this._allowSynchronousEvents) {
            this.emit("message", data, true);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", data, true);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        } else {
          const buf = concat(fragments, messageLength);
          if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
            const error2 = this.createError(
              Error,
              "invalid UTF-8 sequence",
              true,
              1007,
              "WS_ERR_INVALID_UTF8"
            );
            cb(error2);
            return;
          }
          if (this._state === INFLATING || this._allowSynchronousEvents) {
            this.emit("message", buf, false);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", buf, false);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        }
      }
      /**
       * Handles a control message.
       *
       * @param {Buffer} data Data to handle
       * @return {(Error|RangeError|undefined)} A possible error
       * @private
       */
      controlMessage(data, cb) {
        if (this._opcode === 8) {
          if (data.length === 0) {
            this._loop = false;
            this.emit("conclude", 1005, EMPTY_BUFFER);
            this.end();
          } else {
            const code = data.readUInt16BE(0);
            if (!isValidStatusCode(code)) {
              const error2 = this.createError(
                RangeError,
                `invalid status code ${code}`,
                true,
                1002,
                "WS_ERR_INVALID_CLOSE_CODE"
              );
              cb(error2);
              return;
            }
            const buf = new FastBuffer(
              data.buffer,
              data.byteOffset + 2,
              data.length - 2
            );
            if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
              const error2 = this.createError(
                Error,
                "invalid UTF-8 sequence",
                true,
                1007,
                "WS_ERR_INVALID_UTF8"
              );
              cb(error2);
              return;
            }
            this._loop = false;
            this.emit("conclude", code, buf);
            this.end();
          }
          this._state = GET_INFO;
          return;
        }
        if (this._allowSynchronousEvents) {
          this.emit(this._opcode === 9 ? "ping" : "pong", data);
          this._state = GET_INFO;
        } else {
          this._state = DEFER_EVENT;
          setImmediate(() => {
            this.emit(this._opcode === 9 ? "ping" : "pong", data);
            this._state = GET_INFO;
            this.startLoop(cb);
          });
        }
      }
      /**
       * Builds an error object.
       *
       * @param {function(new:Error|RangeError)} ErrorCtor The error constructor
       * @param {String} message The error message
       * @param {Boolean} prefix Specifies whether or not to add a default prefix to
       *     `message`
       * @param {Number} statusCode The status code
       * @param {String} errorCode The exposed error code
       * @return {(Error|RangeError)} The error
       * @private
       */
      createError(ErrorCtor, message, prefix, statusCode, errorCode) {
        this._loop = false;
        this._errored = true;
        const err = new ErrorCtor(
          prefix ? `Invalid WebSocket frame: ${message}` : message
        );
        Error.captureStackTrace(err, this.createError);
        err.code = errorCode;
        err[kStatusCode] = statusCode;
        return err;
      }
    };
    module.exports = Receiver2;
  }
});

// node_modules/ws/lib/sender.js
var require_sender = __commonJS({
  "node_modules/ws/lib/sender.js"(exports, module) {
    "use strict";
    var { Duplex } = __require("stream");
    var { randomFillSync } = __require("crypto");
    var {
      types: { isUint8Array }
    } = __require("util");
    var PerMessageDeflate2 = require_permessage_deflate();
    var { EMPTY_BUFFER, kWebSocket, NOOP } = require_constants();
    var { isBlob, isValidStatusCode } = require_validation2();
    var { mask: applyMask, toBuffer } = require_buffer_util();
    var kByteLength = Symbol("kByteLength");
    var maskBuffer = Buffer.alloc(4);
    var RANDOM_POOL_SIZE = 8 * 1024;
    var randomPool;
    var randomPoolPointer = RANDOM_POOL_SIZE;
    var DEFAULT = 0;
    var DEFLATING = 1;
    var GET_BLOB_DATA = 2;
    var Sender2 = class _Sender {
      /**
       * Creates a Sender instance.
       *
       * @param {Duplex} socket The connection socket
       * @param {Object} [extensions] An object containing the negotiated extensions
       * @param {Function} [generateMask] The function used to generate the masking
       *     key
       */
      constructor(socket, extensions, generateMask) {
        this._extensions = extensions || {};
        if (generateMask) {
          this._generateMask = generateMask;
          this._maskBuffer = Buffer.alloc(4);
        }
        this._socket = socket;
        this._firstFragment = true;
        this._compress = false;
        this._bufferedBytes = 0;
        this._queue = [];
        this._state = DEFAULT;
        this.onerror = NOOP;
        this[kWebSocket] = void 0;
      }
      /**
       * Frames a piece of data according to the HyBi WebSocket protocol.
       *
       * @param {(Buffer|String)} data The data to frame
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @return {(Buffer|String)[]} The framed data
       * @public
       */
      static frame(data, options) {
        let mask;
        let merge2 = false;
        let offset = 2;
        let skipMasking = false;
        if (options.mask) {
          mask = options.maskBuffer || maskBuffer;
          if (options.generateMask) {
            options.generateMask(mask);
          } else {
            if (randomPoolPointer === RANDOM_POOL_SIZE) {
              if (randomPool === void 0) {
                randomPool = Buffer.alloc(RANDOM_POOL_SIZE);
              }
              randomFillSync(randomPool, 0, RANDOM_POOL_SIZE);
              randomPoolPointer = 0;
            }
            mask[0] = randomPool[randomPoolPointer++];
            mask[1] = randomPool[randomPoolPointer++];
            mask[2] = randomPool[randomPoolPointer++];
            mask[3] = randomPool[randomPoolPointer++];
          }
          skipMasking = (mask[0] | mask[1] | mask[2] | mask[3]) === 0;
          offset = 6;
        }
        let dataLength;
        if (typeof data === "string") {
          if ((!options.mask || skipMasking) && options[kByteLength] !== void 0) {
            dataLength = options[kByteLength];
          } else {
            data = Buffer.from(data);
            dataLength = data.length;
          }
        } else {
          dataLength = data.length;
          merge2 = options.mask && options.readOnly && !skipMasking;
        }
        let payloadLength = dataLength;
        if (dataLength >= 65536) {
          offset += 8;
          payloadLength = 127;
        } else if (dataLength > 125) {
          offset += 2;
          payloadLength = 126;
        }
        const target = Buffer.allocUnsafe(merge2 ? dataLength + offset : offset);
        target[0] = options.fin ? options.opcode | 128 : options.opcode;
        if (options.rsv1) target[0] |= 64;
        target[1] = payloadLength;
        if (payloadLength === 126) {
          target.writeUInt16BE(dataLength, 2);
        } else if (payloadLength === 127) {
          target[2] = target[3] = 0;
          target.writeUIntBE(dataLength, 4, 6);
        }
        if (!options.mask) return [target, data];
        target[1] |= 128;
        target[offset - 4] = mask[0];
        target[offset - 3] = mask[1];
        target[offset - 2] = mask[2];
        target[offset - 1] = mask[3];
        if (skipMasking) return [target, data];
        if (merge2) {
          applyMask(data, mask, target, offset, dataLength);
          return [target];
        }
        applyMask(data, mask, data, 0, dataLength);
        return [target, data];
      }
      /**
       * Sends a close message to the other peer.
       *
       * @param {Number} [code] The status code component of the body
       * @param {(String|Buffer)} [data] The message component of the body
       * @param {Boolean} [mask=false] Specifies whether or not to mask the message
       * @param {Function} [cb] Callback
       * @public
       */
      close(code, data, mask, cb) {
        let buf;
        if (code === void 0) {
          buf = EMPTY_BUFFER;
        } else if (typeof code !== "number" || !isValidStatusCode(code)) {
          throw new TypeError("First argument must be a valid error code number");
        } else if (data === void 0 || !data.length) {
          buf = Buffer.allocUnsafe(2);
          buf.writeUInt16BE(code, 0);
        } else {
          const length = Buffer.byteLength(data);
          if (length > 123) {
            throw new RangeError("The message must not be greater than 123 bytes");
          }
          buf = Buffer.allocUnsafe(2 + length);
          buf.writeUInt16BE(code, 0);
          if (typeof data === "string") {
            buf.write(data, 2);
          } else if (isUint8Array(data)) {
            buf.set(data, 2);
          } else {
            throw new TypeError("Second argument must be a string or a Uint8Array");
          }
        }
        const options = {
          [kByteLength]: buf.length,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 8,
          readOnly: false,
          rsv1: false
        };
        if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, buf, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(buf, options), cb);
        }
      }
      /**
       * Sends a ping message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      ping(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 9,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a pong message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      pong(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 10,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a data message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Object} options Options object
       * @param {Boolean} [options.binary=false] Specifies whether `data` is binary
       *     or text
       * @param {Boolean} [options.compress=false] Specifies whether or not to
       *     compress `data`
       * @param {Boolean} [options.fin=false] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Function} [cb] Callback
       * @public
       */
      send(data, options, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        let opcode = options.binary ? 2 : 1;
        let rsv1 = options.compress;
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (this._firstFragment) {
          this._firstFragment = false;
          if (rsv1 && perMessageDeflate && perMessageDeflate.params[perMessageDeflate._isServer ? "server_no_context_takeover" : "client_no_context_takeover"]) {
            rsv1 = byteLength >= perMessageDeflate._threshold;
          }
          this._compress = rsv1;
        } else {
          rsv1 = false;
          opcode = 0;
        }
        if (options.fin) this._firstFragment = true;
        const opts = {
          [kByteLength]: byteLength,
          fin: options.fin,
          generateMask: this._generateMask,
          mask: options.mask,
          maskBuffer: this._maskBuffer,
          opcode,
          readOnly,
          rsv1
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, this._compress, opts, cb]);
          } else {
            this.getBlobData(data, this._compress, opts, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, this._compress, opts, cb]);
        } else {
          this.dispatch(data, this._compress, opts, cb);
        }
      }
      /**
       * Gets the contents of a blob as binary data.
       *
       * @param {Blob} blob The blob
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     the data
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      getBlobData(blob, compress, options, cb) {
        this._bufferedBytes += options[kByteLength];
        this._state = GET_BLOB_DATA;
        blob.arrayBuffer().then((arrayBuffer) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while the blob was being read"
            );
            process.nextTick(callCallbacks, this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          const data = toBuffer(arrayBuffer);
          if (!compress) {
            this._state = DEFAULT;
            this.sendFrame(_Sender.frame(data, options), cb);
            this.dequeue();
          } else {
            this.dispatch(data, compress, options, cb);
          }
        }).catch((err) => {
          process.nextTick(onError, this, err, cb);
        });
      }
      /**
       * Dispatches a message.
       *
       * @param {(Buffer|String)} data The message to send
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     `data`
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      dispatch(data, compress, options, cb) {
        if (!compress) {
          this.sendFrame(_Sender.frame(data, options), cb);
          return;
        }
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        this._bufferedBytes += options[kByteLength];
        this._state = DEFLATING;
        perMessageDeflate.compress(data, options.fin, (_, buf) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while data was being compressed"
            );
            callCallbacks(this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          this._state = DEFAULT;
          options.readOnly = false;
          this.sendFrame(_Sender.frame(buf, options), cb);
          this.dequeue();
        });
      }
      /**
       * Executes queued send operations.
       *
       * @private
       */
      dequeue() {
        while (this._state === DEFAULT && this._queue.length) {
          const params = this._queue.shift();
          this._bufferedBytes -= params[3][kByteLength];
          Reflect.apply(params[0], this, params.slice(1));
        }
      }
      /**
       * Enqueues a send operation.
       *
       * @param {Array} params Send operation parameters.
       * @private
       */
      enqueue(params) {
        this._bufferedBytes += params[3][kByteLength];
        this._queue.push(params);
      }
      /**
       * Sends a frame.
       *
       * @param {(Buffer | String)[]} list The frame to send
       * @param {Function} [cb] Callback
       * @private
       */
      sendFrame(list, cb) {
        if (list.length === 2) {
          this._socket.cork();
          this._socket.write(list[0]);
          this._socket.write(list[1], cb);
          this._socket.uncork();
        } else {
          this._socket.write(list[0], cb);
        }
      }
    };
    module.exports = Sender2;
    function callCallbacks(sender, err, cb) {
      if (typeof cb === "function") cb(err);
      for (let i = 0; i < sender._queue.length; i++) {
        const params = sender._queue[i];
        const callback = params[params.length - 1];
        if (typeof callback === "function") callback(err);
      }
    }
    function onError(sender, err, cb) {
      callCallbacks(sender, err, cb);
      sender.onerror(err);
    }
  }
});

// node_modules/ws/lib/event-target.js
var require_event_target = __commonJS({
  "node_modules/ws/lib/event-target.js"(exports, module) {
    "use strict";
    var { kForOnEventAttribute, kListener } = require_constants();
    var kCode = Symbol("kCode");
    var kData = Symbol("kData");
    var kError = Symbol("kError");
    var kMessage = Symbol("kMessage");
    var kReason = Symbol("kReason");
    var kTarget = Symbol("kTarget");
    var kType = Symbol("kType");
    var kWasClean = Symbol("kWasClean");
    var Event = class {
      /**
       * Create a new `Event`.
       *
       * @param {String} type The name of the event
       * @throws {TypeError} If the `type` argument is not specified
       */
      constructor(type) {
        this[kTarget] = null;
        this[kType] = type;
      }
      /**
       * @type {*}
       */
      get target() {
        return this[kTarget];
      }
      /**
       * @type {String}
       */
      get type() {
        return this[kType];
      }
    };
    Object.defineProperty(Event.prototype, "target", { enumerable: true });
    Object.defineProperty(Event.prototype, "type", { enumerable: true });
    var CloseEvent = class extends Event {
      /**
       * Create a new `CloseEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {Number} [options.code=0] The status code explaining why the
       *     connection was closed
       * @param {String} [options.reason=''] A human-readable string explaining why
       *     the connection was closed
       * @param {Boolean} [options.wasClean=false] Indicates whether or not the
       *     connection was cleanly closed
       */
      constructor(type, options = {}) {
        super(type);
        this[kCode] = options.code === void 0 ? 0 : options.code;
        this[kReason] = options.reason === void 0 ? "" : options.reason;
        this[kWasClean] = options.wasClean === void 0 ? false : options.wasClean;
      }
      /**
       * @type {Number}
       */
      get code() {
        return this[kCode];
      }
      /**
       * @type {String}
       */
      get reason() {
        return this[kReason];
      }
      /**
       * @type {Boolean}
       */
      get wasClean() {
        return this[kWasClean];
      }
    };
    Object.defineProperty(CloseEvent.prototype, "code", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "reason", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "wasClean", { enumerable: true });
    var ErrorEvent = class extends Event {
      /**
       * Create a new `ErrorEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.error=null] The error that generated this event
       * @param {String} [options.message=''] The error message
       */
      constructor(type, options = {}) {
        super(type);
        this[kError] = options.error === void 0 ? null : options.error;
        this[kMessage] = options.message === void 0 ? "" : options.message;
      }
      /**
       * @type {*}
       */
      get error() {
        return this[kError];
      }
      /**
       * @type {String}
       */
      get message() {
        return this[kMessage];
      }
    };
    Object.defineProperty(ErrorEvent.prototype, "error", { enumerable: true });
    Object.defineProperty(ErrorEvent.prototype, "message", { enumerable: true });
    var MessageEvent = class extends Event {
      /**
       * Create a new `MessageEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.data=null] The message content
       */
      constructor(type, options = {}) {
        super(type);
        this[kData] = options.data === void 0 ? null : options.data;
      }
      /**
       * @type {*}
       */
      get data() {
        return this[kData];
      }
    };
    Object.defineProperty(MessageEvent.prototype, "data", { enumerable: true });
    var EventTarget = {
      /**
       * Register an event listener.
       *
       * @param {String} type A string representing the event type to listen for
       * @param {(Function|Object)} handler The listener to add
       * @param {Object} [options] An options object specifies characteristics about
       *     the event listener
       * @param {Boolean} [options.once=false] A `Boolean` indicating that the
       *     listener should be invoked at most once after being added. If `true`,
       *     the listener would be automatically removed when invoked.
       * @public
       */
      addEventListener(type, handler, options = {}) {
        for (const listener of this.listeners(type)) {
          if (!options[kForOnEventAttribute] && listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            return;
          }
        }
        let wrapper;
        if (type === "message") {
          wrapper = function onMessage(data, isBinary) {
            const event = new MessageEvent("message", {
              data: isBinary ? data : data.toString()
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "close") {
          wrapper = function onClose(code, message) {
            const event = new CloseEvent("close", {
              code,
              reason: message.toString(),
              wasClean: this._closeFrameReceived && this._closeFrameSent
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "error") {
          wrapper = function onError(error2) {
            const event = new ErrorEvent("error", {
              error: error2,
              message: error2.message
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "open") {
          wrapper = function onOpen() {
            const event = new Event("open");
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else {
          return;
        }
        wrapper[kForOnEventAttribute] = !!options[kForOnEventAttribute];
        wrapper[kListener] = handler;
        if (options.once) {
          this.once(type, wrapper);
        } else {
          this.on(type, wrapper);
        }
      },
      /**
       * Remove an event listener.
       *
       * @param {String} type A string representing the event type to remove
       * @param {(Function|Object)} handler The listener to remove
       * @public
       */
      removeEventListener(type, handler) {
        for (const listener of this.listeners(type)) {
          if (listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            this.removeListener(type, listener);
            break;
          }
        }
      }
    };
    module.exports = {
      CloseEvent,
      ErrorEvent,
      Event,
      EventTarget,
      MessageEvent
    };
    function callListener(listener, thisArg, event) {
      if (typeof listener === "object" && listener.handleEvent) {
        listener.handleEvent.call(listener, event);
      } else {
        listener.call(thisArg, event);
      }
    }
  }
});

// node_modules/ws/lib/extension.js
var require_extension = __commonJS({
  "node_modules/ws/lib/extension.js"(exports, module) {
    "use strict";
    var { tokenChars } = require_validation2();
    function push(dest, name, elem) {
      if (dest[name] === void 0) dest[name] = [elem];
      else dest[name].push(elem);
    }
    function parse4(header) {
      const offers = /* @__PURE__ */ Object.create(null);
      let params = /* @__PURE__ */ Object.create(null);
      let mustUnescape = false;
      let isEscaping = false;
      let inQuotes = false;
      let extensionName;
      let paramName;
      let start = -1;
      let code = -1;
      let end = -1;
      let i = 0;
      for (; i < header.length; i++) {
        code = header.charCodeAt(i);
        if (extensionName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (i !== 0 && (code === 32 || code === 9)) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            const name = header.slice(start, end);
            if (code === 44) {
              push(offers, name, params);
              params = /* @__PURE__ */ Object.create(null);
            } else {
              extensionName = name;
            }
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else if (paramName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (code === 32 || code === 9) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            push(params, header.slice(start, end), true);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            start = end = -1;
          } else if (code === 61 && start !== -1 && end === -1) {
            paramName = header.slice(start, i);
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else {
          if (isEscaping) {
            if (tokenChars[code] !== 1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (start === -1) start = i;
            else if (!mustUnescape) mustUnescape = true;
            isEscaping = false;
          } else if (inQuotes) {
            if (tokenChars[code] === 1) {
              if (start === -1) start = i;
            } else if (code === 34 && start !== -1) {
              inQuotes = false;
              end = i;
            } else if (code === 92) {
              isEscaping = true;
            } else {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
          } else if (code === 34 && header.charCodeAt(i - 1) === 61) {
            inQuotes = true;
          } else if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (start !== -1 && (code === 32 || code === 9)) {
            if (end === -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            let value = header.slice(start, end);
            if (mustUnescape) {
              value = value.replace(/\\/g, "");
              mustUnescape = false;
            }
            push(params, paramName, value);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            paramName = void 0;
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        }
      }
      if (start === -1 || inQuotes || code === 32 || code === 9) {
        throw new SyntaxError("Unexpected end of input");
      }
      if (end === -1) end = i;
      const token = header.slice(start, end);
      if (extensionName === void 0) {
        push(offers, token, params);
      } else {
        if (paramName === void 0) {
          push(params, token, true);
        } else if (mustUnescape) {
          push(params, paramName, token.replace(/\\/g, ""));
        } else {
          push(params, paramName, token);
        }
        push(offers, extensionName, params);
      }
      return offers;
    }
    function format(extensions) {
      return Object.keys(extensions).map((extension2) => {
        let configurations = extensions[extension2];
        if (!Array.isArray(configurations)) configurations = [configurations];
        return configurations.map((params) => {
          return [extension2].concat(
            Object.keys(params).map((k) => {
              let values = params[k];
              if (!Array.isArray(values)) values = [values];
              return values.map((v) => v === true ? k : `${k}=${v}`).join("; ");
            })
          ).join("; ");
        }).join(", ");
      }).join(", ");
    }
    module.exports = { format, parse: parse4 };
  }
});

// node_modules/ws/lib/websocket.js
var require_websocket = __commonJS({
  "node_modules/ws/lib/websocket.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events");
    var https = __require("https");
    var http = __require("http");
    var net = __require("net");
    var tls = __require("tls");
    var { randomBytes: randomBytes4, createHash: createHash3 } = __require("crypto");
    var { Duplex, Readable } = __require("stream");
    var { URL: URL2 } = __require("url");
    var PerMessageDeflate2 = require_permessage_deflate();
    var Receiver2 = require_receiver();
    var Sender2 = require_sender();
    var { isBlob } = require_validation2();
    var {
      BINARY_TYPES,
      CLOSE_TIMEOUT,
      EMPTY_BUFFER,
      GUID,
      kForOnEventAttribute,
      kListener,
      kStatusCode,
      kWebSocket,
      NOOP
    } = require_constants();
    var {
      EventTarget: { addEventListener, removeEventListener }
    } = require_event_target();
    var { format, parse: parse4 } = require_extension();
    var { toBuffer } = require_buffer_util();
    var kAborted = Symbol("kAborted");
    var protocolVersions = [8, 13];
    var readyStates = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    var subprotocolRegex = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
    var WebSocket2 = class _WebSocket extends EventEmitter {
      /**
       * Create a new `WebSocket`.
       *
       * @param {(String|URL)} address The URL to which to connect
       * @param {(String|String[])} [protocols] The subprotocols
       * @param {Object} [options] Connection options
       */
      constructor(address, protocols, options) {
        super();
        this._binaryType = BINARY_TYPES[0];
        this._closeCode = 1006;
        this._closeFrameReceived = false;
        this._closeFrameSent = false;
        this._closeMessage = EMPTY_BUFFER;
        this._closeTimer = null;
        this._errorEmitted = false;
        this._extensions = {};
        this._paused = false;
        this._protocol = "";
        this._readyState = _WebSocket.CONNECTING;
        this._receiver = null;
        this._sender = null;
        this._socket = null;
        if (address !== null) {
          this._bufferedAmount = 0;
          this._isServer = false;
          this._redirects = 0;
          if (protocols === void 0) {
            if (!options || options.protocols === void 0) {
              protocols = [];
            } else if (Array.isArray(options.protocols)) {
              protocols = options.protocols;
            } else {
              protocols = [options.protocols];
            }
          } else if (!Array.isArray(protocols)) {
            if (typeof protocols === "object" && protocols !== null) {
              options = protocols;
              if (options.protocols === void 0) {
                protocols = [];
              } else if (Array.isArray(options.protocols)) {
                protocols = options.protocols;
              } else {
                protocols = [options.protocols];
              }
            } else {
              protocols = [protocols];
            }
          }
          initAsClient(this, address, protocols, options);
        } else {
          this._autoPong = options.autoPong;
          this._closeTimeout = options.closeTimeout;
          this._isServer = true;
        }
      }
      /**
       * For historical reasons, the custom "nodebuffer" type is used by the default
       * instead of "blob".
       *
       * @type {String}
       */
      get binaryType() {
        return this._binaryType;
      }
      set binaryType(type) {
        if (!BINARY_TYPES.includes(type)) return;
        this._binaryType = type;
        if (this._receiver) this._receiver._binaryType = type;
      }
      /**
       * @type {Number}
       */
      get bufferedAmount() {
        if (!this._socket) return this._bufferedAmount;
        return this._socket._writableState.length + this._sender._bufferedBytes;
      }
      /**
       * @type {String}
       */
      get extensions() {
        return Object.keys(this._extensions).join();
      }
      /**
       * @type {Boolean}
       */
      get isPaused() {
        return this._paused;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onclose() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onerror() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onopen() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onmessage() {
        return null;
      }
      /**
       * @type {String}
       */
      get protocol() {
        return this._protocol;
      }
      /**
       * @type {Number}
       */
      get readyState() {
        return this._readyState;
      }
      /**
       * @type {String}
       */
      get url() {
        return this._url;
      }
      /**
       * Set up the socket and the internal resources.
       *
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Object} options Options object
       * @param {Boolean} [options.allowSynchronousEvents=false] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message size
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @private
       */
      setSocket(socket, head, options) {
        const receiver = new Receiver2({
          allowSynchronousEvents: options.allowSynchronousEvents,
          binaryType: this.binaryType,
          extensions: this._extensions,
          isServer: this._isServer,
          maxBufferedChunks: options.maxBufferedChunks,
          maxFragments: options.maxFragments,
          maxPayload: options.maxPayload,
          skipUTF8Validation: options.skipUTF8Validation
        });
        const sender = new Sender2(socket, this._extensions, options.generateMask);
        this._receiver = receiver;
        this._sender = sender;
        this._socket = socket;
        receiver[kWebSocket] = this;
        sender[kWebSocket] = this;
        socket[kWebSocket] = this;
        receiver.on("conclude", receiverOnConclude);
        receiver.on("drain", receiverOnDrain);
        receiver.on("error", receiverOnError);
        receiver.on("message", receiverOnMessage);
        receiver.on("ping", receiverOnPing);
        receiver.on("pong", receiverOnPong);
        sender.onerror = senderOnError;
        if (socket.setTimeout) socket.setTimeout(0);
        if (socket.setNoDelay) socket.setNoDelay();
        if (head.length > 0) socket.unshift(head);
        socket.on("close", socketOnClose);
        socket.on("data", socketOnData);
        socket.on("end", socketOnEnd);
        socket.on("error", socketOnError);
        this._readyState = _WebSocket.OPEN;
        this.emit("open");
      }
      /**
       * Emit the `'close'` event.
       *
       * @private
       */
      emitClose() {
        if (!this._socket) {
          this._readyState = _WebSocket.CLOSED;
          this.emit("close", this._closeCode, this._closeMessage);
          return;
        }
        if (this._extensions[PerMessageDeflate2.extensionName]) {
          this._extensions[PerMessageDeflate2.extensionName].cleanup();
        }
        this._receiver.removeAllListeners();
        this._readyState = _WebSocket.CLOSED;
        this.emit("close", this._closeCode, this._closeMessage);
      }
      /**
       * Start a closing handshake.
       *
       *          +----------+   +-----------+   +----------+
       *     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
       *    |     +----------+   +-----------+   +----------+     |
       *          +----------+   +-----------+         |
       * CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
       *          +----------+   +-----------+   |
       *    |           |                        |   +---+        |
       *                +------------------------+-->|fin| - - - -
       *    |         +---+                      |   +---+
       *     - - - - -|fin|<---------------------+
       *              +---+
       *
       * @param {Number} [code] Status code explaining why the connection is closing
       * @param {(String|Buffer)} [data] The reason why the connection is
       *     closing
       * @public
       */
      close(code, data) {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this.readyState === _WebSocket.CLOSING) {
          if (this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted)) {
            this._socket.end();
          }
          return;
        }
        this._sender.close(code, data, !this._isServer, (err) => {
          if (err) return;
          this._closeFrameSent = true;
          if (this._closeFrameReceived || this._receiver._writableState.errorEmitted) {
            this._socket.end();
          }
        });
        this._readyState = _WebSocket.CLOSING;
        setCloseTimer(this);
      }
      /**
       * Pause the socket.
       *
       * @public
       */
      pause() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = true;
        this._socket.pause();
      }
      /**
       * Send a ping.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the ping is sent
       * @public
       */
      ping(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.ping(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Send a pong.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the pong is sent
       * @public
       */
      pong(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.pong(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Resume the socket.
       *
       * @public
       */
      resume() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = false;
        if (!this._receiver._writableState.needDrain) this._socket.resume();
      }
      /**
       * Send a data message.
       *
       * @param {*} data The message to send
       * @param {Object} [options] Options object
       * @param {Boolean} [options.binary] Specifies whether `data` is binary or
       *     text
       * @param {Boolean} [options.compress] Specifies whether or not to compress
       *     `data`
       * @param {Boolean} [options.fin=true] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when data is written out
       * @public
       */
      send(data, options, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof options === "function") {
          cb = options;
          options = {};
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        const opts = {
          binary: typeof data !== "string",
          mask: !this._isServer,
          compress: true,
          fin: true,
          ...options
        };
        if (!this._extensions[PerMessageDeflate2.extensionName]) {
          opts.compress = false;
        }
        this._sender.send(data || EMPTY_BUFFER, opts, cb);
      }
      /**
       * Forcibly close the connection.
       *
       * @public
       */
      terminate() {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this._socket) {
          this._readyState = _WebSocket.CLOSING;
          this._socket.destroy();
        }
      }
    };
    Object.defineProperty(WebSocket2, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2.prototype, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2.prototype, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    [
      "binaryType",
      "bufferedAmount",
      "extensions",
      "isPaused",
      "protocol",
      "readyState",
      "url"
    ].forEach((property) => {
      Object.defineProperty(WebSocket2.prototype, property, { enumerable: true });
    });
    ["open", "error", "close", "message"].forEach((method) => {
      Object.defineProperty(WebSocket2.prototype, `on${method}`, {
        enumerable: true,
        get() {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) return listener[kListener];
          }
          return null;
        },
        set(handler) {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) {
              this.removeListener(method, listener);
              break;
            }
          }
          if (typeof handler !== "function") return;
          this.addEventListener(method, handler, {
            [kForOnEventAttribute]: true
          });
        }
      });
    });
    WebSocket2.prototype.addEventListener = addEventListener;
    WebSocket2.prototype.removeEventListener = removeEventListener;
    module.exports = WebSocket2;
    function initAsClient(websocket, address, protocols, options) {
      const opts = {
        allowSynchronousEvents: true,
        autoPong: true,
        closeTimeout: CLOSE_TIMEOUT,
        protocolVersion: protocolVersions[1],
        maxBufferedChunks: 256 * 1024,
        maxFragments: 16 * 1024,
        maxPayload: 100 * 1024 * 1024,
        skipUTF8Validation: false,
        perMessageDeflate: true,
        followRedirects: false,
        maxRedirects: 10,
        ...options,
        socketPath: void 0,
        hostname: void 0,
        protocol: void 0,
        protocols: void 0,
        timeout: void 0,
        method: "GET",
        host: void 0,
        path: void 0,
        port: void 0
      };
      websocket._autoPong = opts.autoPong;
      websocket._closeTimeout = opts.closeTimeout;
      if (!protocolVersions.includes(opts.protocolVersion)) {
        throw new RangeError(
          `Unsupported protocol version: ${opts.protocolVersion} (supported versions: ${protocolVersions.join(", ")})`
        );
      }
      let parsedUrl;
      if (address instanceof URL2) {
        parsedUrl = address;
      } else {
        try {
          parsedUrl = new URL2(address);
        } catch {
          throw new SyntaxError(`Invalid URL: ${address}`);
        }
      }
      if (parsedUrl.protocol === "http:") {
        parsedUrl.protocol = "ws:";
      } else if (parsedUrl.protocol === "https:") {
        parsedUrl.protocol = "wss:";
      }
      websocket._url = parsedUrl.href;
      const isSecure = parsedUrl.protocol === "wss:";
      const isIpcUrl = parsedUrl.protocol === "ws+unix:";
      let invalidUrlMessage;
      if (parsedUrl.protocol !== "ws:" && !isSecure && !isIpcUrl) {
        invalidUrlMessage = `The URL's protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:"`;
      } else if (isIpcUrl && !parsedUrl.pathname) {
        invalidUrlMessage = "The URL's pathname is empty";
      } else if (parsedUrl.hash) {
        invalidUrlMessage = "The URL contains a fragment identifier";
      }
      if (invalidUrlMessage) {
        const err = new SyntaxError(invalidUrlMessage);
        if (websocket._redirects === 0) {
          throw err;
        } else {
          emitErrorAndClose(websocket, err);
          return;
        }
      }
      const defaultPort = isSecure ? 443 : 80;
      const key = randomBytes4(16).toString("base64");
      const request2 = isSecure ? https.request : http.request;
      const protocolSet = /* @__PURE__ */ new Set();
      let perMessageDeflate;
      opts.createConnection = opts.createConnection || (isSecure ? tlsConnect : netConnect);
      opts.defaultPort = opts.defaultPort || defaultPort;
      opts.port = parsedUrl.port || defaultPort;
      opts.host = parsedUrl.hostname.startsWith("[") ? parsedUrl.hostname.slice(1, -1) : parsedUrl.hostname;
      opts.headers = {
        ...opts.headers,
        "Sec-WebSocket-Version": opts.protocolVersion,
        "Sec-WebSocket-Key": key,
        Connection: "Upgrade",
        Upgrade: "websocket"
      };
      opts.path = parsedUrl.pathname + parsedUrl.search;
      opts.timeout = opts.handshakeTimeout;
      if (opts.perMessageDeflate) {
        perMessageDeflate = new PerMessageDeflate2({
          ...opts.perMessageDeflate,
          isServer: false,
          maxPayload: opts.maxPayload
        });
        opts.headers["Sec-WebSocket-Extensions"] = format({
          [PerMessageDeflate2.extensionName]: perMessageDeflate.offer()
        });
      }
      if (protocols.length) {
        for (const protocol of protocols) {
          if (typeof protocol !== "string" || !subprotocolRegex.test(protocol) || protocolSet.has(protocol)) {
            throw new SyntaxError(
              "An invalid or duplicated subprotocol was specified"
            );
          }
          protocolSet.add(protocol);
        }
        opts.headers["Sec-WebSocket-Protocol"] = protocols.join(",");
      }
      if (opts.origin) {
        if (opts.protocolVersion < 13) {
          opts.headers["Sec-WebSocket-Origin"] = opts.origin;
        } else {
          opts.headers.Origin = opts.origin;
        }
      }
      if (parsedUrl.username || parsedUrl.password) {
        opts.auth = `${parsedUrl.username}:${parsedUrl.password}`;
      }
      if (isIpcUrl) {
        const parts = opts.path.split(":");
        opts.socketPath = parts[0];
        opts.path = parts[1];
      }
      let req;
      if (opts.followRedirects) {
        if (websocket._redirects === 0) {
          websocket._originalIpc = isIpcUrl;
          websocket._originalSecure = isSecure;
          websocket._originalHostOrSocketPath = isIpcUrl ? opts.socketPath : parsedUrl.host;
          const headers = options && options.headers;
          options = { ...options, headers: {} };
          if (headers) {
            for (const [key2, value] of Object.entries(headers)) {
              options.headers[key2.toLowerCase()] = value;
            }
          }
        } else if (websocket.listenerCount("redirect") === 0) {
          const isSameHost = isIpcUrl ? websocket._originalIpc ? opts.socketPath === websocket._originalHostOrSocketPath : false : websocket._originalIpc ? false : parsedUrl.host === websocket._originalHostOrSocketPath;
          if (!isSameHost || websocket._originalSecure && !isSecure) {
            delete opts.headers.authorization;
            delete opts.headers.cookie;
            if (!isSameHost) delete opts.headers.host;
            opts.auth = void 0;
          }
        }
        if (opts.auth && !options.headers.authorization) {
          options.headers.authorization = "Basic " + Buffer.from(opts.auth).toString("base64");
        }
        req = websocket._req = request2(opts);
        if (websocket._redirects) {
          websocket.emit("redirect", websocket.url, req);
        }
      } else {
        req = websocket._req = request2(opts);
      }
      if (opts.timeout) {
        req.on("timeout", () => {
          abortHandshake(websocket, req, "Opening handshake has timed out");
        });
      }
      req.on("error", (err) => {
        if (req === null || req[kAborted]) return;
        req = websocket._req = null;
        emitErrorAndClose(websocket, err);
      });
      req.on("response", (res) => {
        const location = res.headers.location;
        const statusCode = res.statusCode;
        if (location && opts.followRedirects && statusCode >= 300 && statusCode < 400) {
          if (++websocket._redirects > opts.maxRedirects) {
            abortHandshake(websocket, req, "Maximum redirects exceeded");
            return;
          }
          req.abort();
          let addr;
          try {
            addr = new URL2(location, address);
          } catch (e) {
            const err = new SyntaxError(`Invalid URL: ${location}`);
            emitErrorAndClose(websocket, err);
            return;
          }
          initAsClient(websocket, addr, protocols, options);
        } else if (!websocket.emit("unexpected-response", req, res)) {
          abortHandshake(
            websocket,
            req,
            `Unexpected server response: ${res.statusCode}`
          );
        }
      });
      req.on("upgrade", (res, socket, head) => {
        websocket.emit("upgrade", res);
        if (websocket.readyState !== WebSocket2.CONNECTING) return;
        req = websocket._req = null;
        const upgrade = res.headers.upgrade;
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          abortHandshake(websocket, socket, "Invalid Upgrade header");
          return;
        }
        const digest2 = createHash3("sha1").update(key + GUID).digest("base64");
        if (res.headers["sec-websocket-accept"] !== digest2) {
          abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Accept header");
          return;
        }
        const serverProt = res.headers["sec-websocket-protocol"];
        let protError;
        if (serverProt !== void 0) {
          if (!protocolSet.size) {
            protError = "Server sent a subprotocol but none was requested";
          } else if (!protocolSet.has(serverProt)) {
            protError = "Server sent an invalid subprotocol";
          }
        } else if (protocolSet.size) {
          protError = "Server sent no subprotocol";
        }
        if (protError) {
          abortHandshake(websocket, socket, protError);
          return;
        }
        if (serverProt) websocket._protocol = serverProt;
        const secWebSocketExtensions = res.headers["sec-websocket-extensions"];
        if (secWebSocketExtensions !== void 0) {
          if (!perMessageDeflate) {
            const message = "Server sent a Sec-WebSocket-Extensions header but no extension was requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          let extensions;
          try {
            extensions = parse4(secWebSocketExtensions);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          const extensionNames = Object.keys(extensions);
          if (extensionNames.length !== 1 || extensionNames[0] !== PerMessageDeflate2.extensionName) {
            const message = "Server indicated an extension that was not requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          try {
            perMessageDeflate.accept(extensions[PerMessageDeflate2.extensionName]);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          websocket._extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
        }
        websocket.setSocket(socket, head, {
          allowSynchronousEvents: opts.allowSynchronousEvents,
          generateMask: opts.generateMask,
          maxBufferedChunks: opts.maxBufferedChunks,
          maxFragments: opts.maxFragments,
          maxPayload: opts.maxPayload,
          skipUTF8Validation: opts.skipUTF8Validation
        });
      });
      if (opts.finishRequest) {
        opts.finishRequest(req, websocket);
      } else {
        req.end();
      }
    }
    function emitErrorAndClose(websocket, err) {
      websocket._readyState = WebSocket2.CLOSING;
      websocket._errorEmitted = true;
      websocket.emit("error", err);
      websocket.emitClose();
    }
    function netConnect(options) {
      options.path = options.socketPath;
      return net.connect(options);
    }
    function tlsConnect(options) {
      options.path = void 0;
      if (!options.servername && options.servername !== "") {
        options.servername = net.isIP(options.host) ? "" : options.host;
      }
      return tls.connect(options);
    }
    function abortHandshake(websocket, stream, message) {
      websocket._readyState = WebSocket2.CLOSING;
      const err = new Error(message);
      Error.captureStackTrace(err, abortHandshake);
      if (stream.setHeader) {
        stream[kAborted] = true;
        stream.abort();
        if (stream.socket && !stream.socket.destroyed) {
          stream.socket.destroy();
        }
        process.nextTick(emitErrorAndClose, websocket, err);
      } else {
        stream.destroy(err);
        stream.once("error", websocket.emit.bind(websocket, "error"));
        stream.once("close", websocket.emitClose.bind(websocket));
      }
    }
    function sendAfterClose(websocket, data, cb) {
      if (data) {
        const length = isBlob(data) ? data.size : toBuffer(data).length;
        if (websocket._socket) websocket._sender._bufferedBytes += length;
        else websocket._bufferedAmount += length;
      }
      if (cb) {
        const err = new Error(
          `WebSocket is not open: readyState ${websocket.readyState} (${readyStates[websocket.readyState]})`
        );
        process.nextTick(cb, err);
      }
    }
    function receiverOnConclude(code, reason) {
      const websocket = this[kWebSocket];
      websocket._closeFrameReceived = true;
      websocket._closeMessage = reason;
      websocket._closeCode = code;
      if (websocket._socket[kWebSocket] === void 0) return;
      websocket._socket.removeListener("data", socketOnData);
      process.nextTick(resume, websocket._socket);
      if (code === 1005) websocket.close();
      else websocket.close(code, reason);
    }
    function receiverOnDrain() {
      const websocket = this[kWebSocket];
      if (!websocket.isPaused) websocket._socket.resume();
    }
    function receiverOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket._socket[kWebSocket] !== void 0) {
        websocket._socket.removeListener("data", socketOnData);
        process.nextTick(resume, websocket._socket);
        websocket.close(err[kStatusCode]);
      }
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function receiverOnFinish() {
      this[kWebSocket].emitClose();
    }
    function receiverOnMessage(data, isBinary) {
      this[kWebSocket].emit("message", data, isBinary);
    }
    function receiverOnPing(data) {
      const websocket = this[kWebSocket];
      if (websocket._autoPong) websocket.pong(data, !this._isServer, NOOP);
      websocket.emit("ping", data);
    }
    function receiverOnPong(data) {
      this[kWebSocket].emit("pong", data);
    }
    function resume(stream) {
      stream.resume();
    }
    function senderOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket.readyState === WebSocket2.CLOSED) return;
      if (websocket.readyState === WebSocket2.OPEN) {
        websocket._readyState = WebSocket2.CLOSING;
        setCloseTimer(websocket);
      }
      this._socket.end();
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function setCloseTimer(websocket) {
      websocket._closeTimer = setTimeout(
        websocket._socket.destroy.bind(websocket._socket),
        websocket._closeTimeout
      );
    }
    function socketOnClose() {
      const websocket = this[kWebSocket];
      this.removeListener("close", socketOnClose);
      this.removeListener("data", socketOnData);
      this.removeListener("end", socketOnEnd);
      websocket._readyState = WebSocket2.CLOSING;
      if (!this._readableState.endEmitted && !websocket._closeFrameReceived && !websocket._receiver._writableState.errorEmitted && this._readableState.length !== 0) {
        const chunk = this.read(this._readableState.length);
        websocket._receiver.write(chunk);
      }
      websocket._receiver.end();
      this[kWebSocket] = void 0;
      clearTimeout(websocket._closeTimer);
      if (websocket._receiver._writableState.finished || websocket._receiver._writableState.errorEmitted) {
        websocket.emitClose();
      } else {
        websocket._receiver.on("error", receiverOnFinish);
        websocket._receiver.on("finish", receiverOnFinish);
      }
    }
    function socketOnData(chunk) {
      if (!this[kWebSocket]._receiver.write(chunk)) {
        this.pause();
      }
    }
    function socketOnEnd() {
      const websocket = this[kWebSocket];
      websocket._readyState = WebSocket2.CLOSING;
      websocket._receiver.end();
      this.end();
    }
    function socketOnError() {
      const websocket = this[kWebSocket];
      this.removeListener("error", socketOnError);
      this.on("error", NOOP);
      if (websocket) {
        websocket._readyState = WebSocket2.CLOSING;
        this.destroy();
      }
    }
  }
});

// node_modules/ws/lib/stream.js
var require_stream = __commonJS({
  "node_modules/ws/lib/stream.js"(exports, module) {
    "use strict";
    var WebSocket2 = require_websocket();
    var { Duplex } = __require("stream");
    function emitClose(stream) {
      stream.emit("close");
    }
    function duplexOnEnd() {
      if (!this.destroyed && this._writableState.finished) {
        this.destroy();
      }
    }
    function duplexOnError(err) {
      this.removeListener("error", duplexOnError);
      this.destroy();
      if (this.listenerCount("error") === 0) {
        this.emit("error", err);
      }
    }
    function createWebSocketStream2(ws, options) {
      let terminateOnDestroy = true;
      const duplex = new Duplex({
        ...options,
        autoDestroy: false,
        emitClose: false,
        objectMode: false,
        writableObjectMode: false
      });
      ws.on("message", function message(msg, isBinary) {
        const data = !isBinary && duplex._readableState.objectMode ? msg.toString() : msg;
        if (!duplex.push(data)) ws.pause();
      });
      ws.once("error", function error2(err) {
        if (duplex.destroyed) return;
        terminateOnDestroy = false;
        duplex.destroy(err);
      });
      ws.once("close", function close() {
        if (duplex.destroyed) return;
        duplex.push(null);
      });
      duplex._destroy = function(err, callback) {
        if (ws.readyState === ws.CLOSED) {
          callback(err);
          process.nextTick(emitClose, duplex);
          return;
        }
        let called = false;
        ws.once("error", function error2(err2) {
          called = true;
          callback(err2);
        });
        ws.once("close", function close() {
          if (!called) callback(err);
          process.nextTick(emitClose, duplex);
        });
        if (terminateOnDestroy) ws.terminate();
      };
      duplex._final = function(callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open2() {
            duplex._final(callback);
          });
          return;
        }
        if (ws._socket === null) return;
        if (ws._socket._writableState.finished) {
          callback();
          if (duplex._readableState.endEmitted) duplex.destroy();
        } else {
          ws._socket.once("finish", function finish() {
            callback();
          });
          ws.close();
        }
      };
      duplex._read = function() {
        if (ws.isPaused) ws.resume();
      };
      duplex._write = function(chunk, encoding, callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open2() {
            duplex._write(chunk, encoding, callback);
          });
          return;
        }
        ws.send(chunk, callback);
      };
      duplex.on("end", duplexOnEnd);
      duplex.on("error", duplexOnError);
      return duplex;
    }
    module.exports = createWebSocketStream2;
  }
});

// node_modules/ws/lib/subprotocol.js
var require_subprotocol = __commonJS({
  "node_modules/ws/lib/subprotocol.js"(exports, module) {
    "use strict";
    var { tokenChars } = require_validation2();
    function parse4(header) {
      const protocols = /* @__PURE__ */ new Set();
      let start = -1;
      let end = -1;
      let i = 0;
      for (i; i < header.length; i++) {
        const code = header.charCodeAt(i);
        if (end === -1 && tokenChars[code] === 1) {
          if (start === -1) start = i;
        } else if (i !== 0 && (code === 32 || code === 9)) {
          if (end === -1 && start !== -1) end = i;
        } else if (code === 44) {
          if (start === -1) {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
          if (end === -1) end = i;
          const protocol2 = header.slice(start, end);
          if (protocols.has(protocol2)) {
            throw new SyntaxError(`The "${protocol2}" subprotocol is duplicated`);
          }
          protocols.add(protocol2);
          start = end = -1;
        } else {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }
      }
      if (start === -1 || end !== -1) {
        throw new SyntaxError("Unexpected end of input");
      }
      const protocol = header.slice(start, i);
      if (protocols.has(protocol)) {
        throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
      }
      protocols.add(protocol);
      return protocols;
    }
    module.exports = { parse: parse4 };
  }
});

// node_modules/ws/lib/websocket-server.js
var require_websocket_server = __commonJS({
  "node_modules/ws/lib/websocket-server.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events");
    var http = __require("http");
    var { Duplex } = __require("stream");
    var { createHash: createHash3 } = __require("crypto");
    var extension2 = require_extension();
    var PerMessageDeflate2 = require_permessage_deflate();
    var subprotocol2 = require_subprotocol();
    var WebSocket2 = require_websocket();
    var { CLOSE_TIMEOUT, GUID, kWebSocket } = require_constants();
    var keyRegex = /^[+/0-9A-Za-z]{22}==$/;
    var RUNNING = 0;
    var CLOSING = 1;
    var CLOSED = 2;
    var WebSocketServer2 = class extends EventEmitter {
      /**
       * Create a `WebSocketServer` instance.
       *
       * @param {Object} options Configuration options
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Boolean} [options.autoPong=true] Specifies whether or not to
       *     automatically send a pong in response to a ping
       * @param {Number} [options.backlog=511] The maximum length of the queue of
       *     pending connections
       * @param {Boolean} [options.clientTracking=true] Specifies whether or not to
       *     track clients
       * @param {Number} [options.closeTimeout=30000] Duration in milliseconds to
       *     wait for the closing handshake to finish after `websocket.close()` is
       *     called
       * @param {Function} [options.handleProtocols] A hook to handle protocols
       * @param {String} [options.host] The hostname where to bind the server
       * @param {Number} [options.maxBufferedChunks=262144] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=16384] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=104857600] The maximum allowed message
       *     size
       * @param {Boolean} [options.noServer=false] Enable no server mode
       * @param {String} [options.path] Accept only connections matching this path
       * @param {(Boolean|Object)} [options.perMessageDeflate=false] Enable/disable
       *     permessage-deflate
       * @param {Number} [options.port] The port where to bind the server
       * @param {(http.Server|https.Server)} [options.server] A pre-created HTTP/S
       *     server to use
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @param {Function} [options.verifyClient] A hook to reject connections
       * @param {Function} [options.WebSocket=WebSocket] Specifies the `WebSocket`
       *     class to use. It must be the `WebSocket` class or class that extends it
       * @param {Function} [callback] A listener for the `listening` event
       */
      constructor(options, callback) {
        super();
        options = {
          allowSynchronousEvents: true,
          autoPong: true,
          maxBufferedChunks: 256 * 1024,
          maxFragments: 16 * 1024,
          maxPayload: 100 * 1024 * 1024,
          skipUTF8Validation: false,
          perMessageDeflate: false,
          handleProtocols: null,
          clientTracking: true,
          closeTimeout: CLOSE_TIMEOUT,
          verifyClient: null,
          noServer: false,
          backlog: null,
          // use default (511 as implemented in net.js)
          server: null,
          host: null,
          path: null,
          port: null,
          WebSocket: WebSocket2,
          ...options
        };
        if (options.port == null && !options.server && !options.noServer || options.port != null && (options.server || options.noServer) || options.server && options.noServer) {
          throw new TypeError(
            'One and only one of the "port", "server", or "noServer" options must be specified'
          );
        }
        if (options.port != null) {
          this._server = http.createServer((req, res) => {
            const body = http.STATUS_CODES[426];
            res.writeHead(426, {
              "Content-Length": body.length,
              "Content-Type": "text/plain"
            });
            res.end(body);
          });
          this._server.listen(
            options.port,
            options.host,
            options.backlog,
            callback
          );
        } else if (options.server) {
          this._server = options.server;
        }
        if (this._server) {
          const emitConnection = this.emit.bind(this, "connection");
          this._removeListeners = addListeners(this._server, {
            listening: this.emit.bind(this, "listening"),
            error: this.emit.bind(this, "error"),
            upgrade: (req, socket, head) => {
              this.handleUpgrade(req, socket, head, emitConnection);
            }
          });
        }
        if (options.perMessageDeflate === true) options.perMessageDeflate = {};
        if (options.clientTracking) {
          this.clients = /* @__PURE__ */ new Set();
          this._shouldEmitClose = false;
        }
        this.options = options;
        this._state = RUNNING;
      }
      /**
       * Returns the bound address, the address family name, and port of the server
       * as reported by the operating system if listening on an IP socket.
       * If the server is listening on a pipe or UNIX domain socket, the name is
       * returned as a string.
       *
       * @return {(Object|String|null)} The address of the server
       * @public
       */
      address() {
        if (this.options.noServer) {
          throw new Error('The server is operating in "noServer" mode');
        }
        if (!this._server) return null;
        return this._server.address();
      }
      /**
       * Stop the server from accepting new connections and emit the `'close'` event
       * when all existing connections are closed.
       *
       * @param {Function} [cb] A one-time listener for the `'close'` event
       * @public
       */
      close(cb) {
        if (this._state === CLOSED) {
          if (cb) {
            this.once("close", () => {
              cb(new Error("The server is not running"));
            });
          }
          process.nextTick(emitClose, this);
          return;
        }
        if (cb) this.once("close", cb);
        if (this._state === CLOSING) return;
        this._state = CLOSING;
        if (this.options.noServer || this.options.server) {
          if (this._server) {
            this._removeListeners();
            this._removeListeners = this._server = null;
          }
          if (this.clients) {
            if (!this.clients.size) {
              process.nextTick(emitClose, this);
            } else {
              this._shouldEmitClose = true;
            }
          } else {
            process.nextTick(emitClose, this);
          }
        } else {
          const server = this._server;
          this._removeListeners();
          this._removeListeners = this._server = null;
          server.close(() => {
            emitClose(this);
          });
        }
      }
      /**
       * See if a given request should be handled by this server instance.
       *
       * @param {http.IncomingMessage} req Request object to inspect
       * @return {Boolean} `true` if the request is valid, else `false`
       * @public
       */
      shouldHandle(req) {
        if (this.options.path) {
          const index = req.url.indexOf("?");
          const pathname = index !== -1 ? req.url.slice(0, index) : req.url;
          if (pathname !== this.options.path) return false;
        }
        return true;
      }
      /**
       * Handle a HTTP Upgrade request.
       *
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @public
       */
      handleUpgrade(req, socket, head, cb) {
        socket.on("error", socketOnError);
        const key = req.headers["sec-websocket-key"];
        const upgrade = req.headers.upgrade;
        const version3 = +req.headers["sec-websocket-version"];
        if (req.method !== "GET") {
          const message = "Invalid HTTP method";
          abortHandshakeOrEmitwsClientError(this, req, socket, 405, message);
          return;
        }
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          const message = "Invalid Upgrade header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (key === void 0 || !keyRegex.test(key)) {
          const message = "Missing or invalid Sec-WebSocket-Key header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (version3 !== 13 && version3 !== 8) {
          const message = "Missing or invalid Sec-WebSocket-Version header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message, {
            "Sec-WebSocket-Version": "13, 8"
          });
          return;
        }
        if (!this.shouldHandle(req)) {
          abortHandshake(socket, 400);
          return;
        }
        const secWebSocketProtocol = req.headers["sec-websocket-protocol"];
        let protocols = /* @__PURE__ */ new Set();
        if (secWebSocketProtocol !== void 0) {
          try {
            protocols = subprotocol2.parse(secWebSocketProtocol);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Protocol header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        const secWebSocketExtensions = req.headers["sec-websocket-extensions"];
        const extensions = {};
        if (this.options.perMessageDeflate && secWebSocketExtensions !== void 0) {
          const perMessageDeflate = new PerMessageDeflate2({
            ...this.options.perMessageDeflate,
            isServer: true,
            maxPayload: this.options.maxPayload
          });
          try {
            const offers = extension2.parse(secWebSocketExtensions);
            if (offers[PerMessageDeflate2.extensionName]) {
              perMessageDeflate.accept(offers[PerMessageDeflate2.extensionName]);
              extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
            }
          } catch (err) {
            const message = "Invalid or unacceptable Sec-WebSocket-Extensions header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        if (this.options.verifyClient) {
          const info2 = {
            origin: req.headers[`${version3 === 8 ? "sec-websocket-origin" : "origin"}`],
            secure: !!(req.socket.authorized || req.socket.encrypted),
            req
          };
          if (this.options.verifyClient.length === 2) {
            this.options.verifyClient(info2, (verified, code, message, headers) => {
              if (!verified) {
                return abortHandshake(socket, code || 401, message, headers);
              }
              this.completeUpgrade(
                extensions,
                key,
                protocols,
                req,
                socket,
                head,
                cb
              );
            });
            return;
          }
          if (!this.options.verifyClient(info2)) return abortHandshake(socket, 401);
        }
        this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
      }
      /**
       * Upgrade the connection to WebSocket.
       *
       * @param {Object} extensions The accepted extensions
       * @param {String} key The value of the `Sec-WebSocket-Key` header
       * @param {Set} protocols The subprotocols
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @throws {Error} If called more than once with the same socket
       * @private
       */
      completeUpgrade(extensions, key, protocols, req, socket, head, cb) {
        if (!socket.readable || !socket.writable) return socket.destroy();
        if (socket[kWebSocket]) {
          throw new Error(
            "server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration"
          );
        }
        if (this._state > RUNNING) return abortHandshake(socket, 503);
        const digest2 = createHash3("sha1").update(key + GUID).digest("base64");
        const headers = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${digest2}`
        ];
        const ws = new this.options.WebSocket(null, void 0, this.options);
        if (protocols.size) {
          const protocol = this.options.handleProtocols ? this.options.handleProtocols(protocols, req) : protocols.values().next().value;
          if (protocol) {
            headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
            ws._protocol = protocol;
          }
        }
        if (extensions[PerMessageDeflate2.extensionName]) {
          const params = extensions[PerMessageDeflate2.extensionName].params;
          const value = extension2.format({
            [PerMessageDeflate2.extensionName]: [params]
          });
          headers.push(`Sec-WebSocket-Extensions: ${value}`);
          ws._extensions = extensions;
        }
        this.emit("headers", headers, req);
        socket.write(headers.concat("\r\n").join("\r\n"));
        socket.removeListener("error", socketOnError);
        ws.setSocket(socket, head, {
          allowSynchronousEvents: this.options.allowSynchronousEvents,
          maxBufferedChunks: this.options.maxBufferedChunks,
          maxFragments: this.options.maxFragments,
          maxPayload: this.options.maxPayload,
          skipUTF8Validation: this.options.skipUTF8Validation
        });
        if (this.clients) {
          this.clients.add(ws);
          ws.on("close", () => {
            this.clients.delete(ws);
            if (this._shouldEmitClose && !this.clients.size) {
              process.nextTick(emitClose, this);
            }
          });
        }
        cb(ws, req);
      }
    };
    module.exports = WebSocketServer2;
    function addListeners(server, map) {
      for (const event of Object.keys(map)) server.on(event, map[event]);
      return function removeListeners() {
        for (const event of Object.keys(map)) {
          server.removeListener(event, map[event]);
        }
      };
    }
    function emitClose(server) {
      server._state = CLOSED;
      server.emit("close");
    }
    function socketOnError() {
      this.destroy();
    }
    function abortHandshake(socket, code, message, headers) {
      message = message || http.STATUS_CODES[code];
      headers = {
        Connection: "close",
        "Content-Type": "text/html",
        "Content-Length": Buffer.byteLength(message),
        ...headers
      };
      socket.once("finish", socket.destroy);
      socket.end(
        `HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r
` + Object.keys(headers).map((h) => `${h}: ${headers[h]}`).join("\r\n") + "\r\n\r\n" + message
      );
    }
    function abortHandshakeOrEmitwsClientError(server, req, socket, code, message, headers) {
      if (server.listenerCount("wsClientError")) {
        const err = new Error(message);
        Error.captureStackTrace(err, abortHandshakeOrEmitwsClientError);
        server.emit("wsClientError", err, socket, req);
      } else {
        abortHandshake(socket, code, message, headers);
      }
    }
  }
});

// node_modules/ws/wrapper.mjs
var import_stream, import_extension, import_permessage_deflate, import_receiver, import_sender, import_subprotocol, import_websocket, import_websocket_server;
var init_wrapper = __esm({
  "node_modules/ws/wrapper.mjs"() {
    import_stream = __toESM(require_stream(), 1);
    import_extension = __toESM(require_extension(), 1);
    import_permessage_deflate = __toESM(require_permessage_deflate(), 1);
    import_receiver = __toESM(require_receiver(), 1);
    import_sender = __toESM(require_sender(), 1);
    import_subprotocol = __toESM(require_subprotocol(), 1);
    import_websocket = __toESM(require_websocket(), 1);
    import_websocket_server = __toESM(require_websocket_server(), 1);
  }
});

// daemon/src/approval-page.ts
import { randomBytes as randomBytes3 } from "node:crypto";
function createNonceStore(now = Date.now) {
  const live = /* @__PURE__ */ new Map();
  const sweep = () => {
    for (const [k, v] of live) if (v.expiresAt <= now()) live.delete(k);
    while (live.size >= MAX_NONCES) live.delete(live.keys().next().value);
  };
  return {
    issue(userCode) {
      sweep();
      const nonce = randomBytes3(24).toString("base64url");
      live.set(nonce, { userCode, expiresAt: now() + NONCE_TTL_MS });
      return nonce;
    },
    consume(nonce, userCode) {
      const entry = live.get(nonce);
      live.delete(nonce);
      return !!entry && entry.expiresAt > now() && entry.userCode === userCode;
    }
  };
}
var APPROVAL_TEXTS, NONCE_TTL_MS, MAX_NONCES, escapeHtml, shell, approvalPage, messagePage, PAGE_HEADERS;
var init_approval_page = __esm({
  "daemon/src/approval-page.ts"() {
    "use strict";
    APPROVAL_TEXTS = {
      title: "Aprovar acesso \u2014 Atrium",
      heading: "Aprovar este c\xF3digo?",
      codeHelp: "Confira se o c\xF3digo abaixo \xE9 o mesmo que aparece no painel do Atrium Assistant.",
      approve: "Aprovar",
      invalidHeading: "C\xF3digo ausente ou inv\xE1lido",
      invalidBody: "Volte ao painel do Atrium Assistant e clique em Entrar de novo.",
      approvedHeading: "Aprovado",
      approvedBody: "Pode fechar esta aba e voltar ao painel do Atrium Assistant.",
      failedHeading: "N\xE3o foi poss\xEDvel aprovar",
      expiredBody: "O c\xF3digo expirou ou n\xE3o existe mais. Volte ao painel e clique em Entrar de novo.",
      unavailableBody: "O supervisor embutido n\xE3o est\xE1 pronto. Aguarde alguns segundos e tente de novo.",
      staleBody: "Esta p\xE1gina venceu. Volte ao painel e clique em Entrar de novo."
    };
    NONCE_TTL_MS = 5 * 6e4;
    MAX_NONCES = 50;
    escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    shell = (body) => `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(APPROVAL_TEXTS.title)}</title>
<style>
  :root{color-scheme:light dark}
  body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;padding:16px}
  main{max-width:28rem;width:100%}
  h1{font-size:1.25rem;margin:0 0 .5rem}
  p{margin:.5rem 0}
  .code{font:600 1.75rem/1.2 ui-monospace,monospace;letter-spacing:.12em;margin:1rem 0;padding:.75rem 1rem;border:1px solid currentColor;border-radius:.5rem;text-align:center}
  button{font:inherit;padding:.6rem 1.25rem;border-radius:.5rem;border:0;background:#2563eb;color:#fff;cursor:pointer}
</style></head><body><main>${body}</main></body></html>`;
    approvalPage = (userCode, nonce) => shell(`<h1>${escapeHtml(APPROVAL_TEXTS.heading)}</h1>
<p>${escapeHtml(APPROVAL_TEXTS.codeHelp)}</p>
<div class="code" data-testid="user-code">${escapeHtml(userCode)}</div>
<form method="post" action="/device/approve">
<input type="hidden" name="user_code" value="${escapeHtml(userCode)}">
<input type="hidden" name="nonce" value="${escapeHtml(nonce)}">
<button type="submit" data-testid="approve">${escapeHtml(APPROVAL_TEXTS.approve)}</button>
</form>`);
    messagePage = (heading, body, testId) => shell(`<h1 data-testid="${testId}">${escapeHtml(heading)}</h1><p>${escapeHtml(body)}</p>`);
    PAGE_HEADERS = {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      // `same-origin` (não `no-referrer`): com no-referrer o navegador manda `Origin: null` no POST, e o Origin é a prova.
      "referrer-policy": "same-origin"
    };
  }
});

// daemon/src/files.ts
import { existsSync as existsSync6, mkdirSync as mkdirSync5, statSync as statSync5, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { basename as basename2, isAbsolute as isAbsolute2, join as join6, resolve as resolve6 } from "node:path";
function assertUploadPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw Object.assign(new Error('upload: "paths" must be a non-empty array of absolute file paths'), { code: "INVALID_ARGUMENT" });
  }
  return paths.map((p) => {
    if (typeof p !== "string" || !isAbsolute2(p)) {
      throw Object.assign(new Error(`upload: "${String(p)}" is not an absolute path`), { code: "INVALID_ARGUMENT" });
    }
    let st;
    try {
      st = statSync5(p);
    } catch {
      throw new BridgeError("FILE_NOT_FOUND", `upload: file not found: ${p}`, { path: p });
    }
    if (!st.isFile()) throw new BridgeError("FILE_NOT_FOUND", `upload: not a file: ${p}`, { path: p });
    return resolve6(p);
  });
}
function pdfFilename(requested, title) {
  let name = basename2((requested ?? "").replace(/\\/g, "/")).trim();
  if (!name) name = (title ?? "").replace(/\s+/g, " ").trim();
  name = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").slice(0, 150);
  if (!name || /^\.+$/.test(name)) name = "page";
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) name = `_${name}`;
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}
function uniquePath(dir, name) {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let candidate = join6(dir, name);
  for (let n = 2; existsSync6(candidate); n++) candidate = join6(dir, `${stem} (${n})${ext}`);
  return candidate;
}
function persistPdf(dir, result) {
  const r = result;
  if (!r || typeof r.data !== "string" || !r.data) throw new BridgeError("PDF_FAILED", "the extension returned no PDF data");
  const title = typeof r.title === "string" ? r.title : "";
  const url = typeof r.url === "string" ? r.url : "";
  const bytes = Buffer.from(r.data, "base64");
  if (bytes.length === 0) throw new BridgeError("PDF_FAILED", "the extension returned an empty PDF");
  try {
    mkdirSync5(dir, { recursive: true });
    const path = uniquePath(dir, pdfFilename(typeof r.filename === "string" ? r.filename : void 0, title));
    writeFileSync2(path, bytes, { flag: "wx" });
    return { path, bytes: bytes.length, title, url };
  } catch (e) {
    throw new BridgeError("PDF_FAILED", `could not save the PDF in ${dir}: ${e.message}`);
  }
}
var defaultDownloadsDir;
var init_files = __esm({
  "daemon/src/files.ts"() {
    "use strict";
    init_errors3();
    defaultDownloadsDir = () => join6(homedir4(), "Downloads");
  }
});

// daemon/src/registry.ts
import { randomUUID } from "node:crypto";
var CLIENTS_MAX, RELEASE_TOOL, BrowserConnection, Registry;
var init_registry = __esm({
  "daemon/src/registry.ts"() {
    "use strict";
    init_errors3();
    CLIENTS_MAX = 200;
    RELEASE_TOOL = "release";
    BrowserConnection = class {
      info;
      ws;
      pending = /* @__PURE__ */ new Map();
      /** Abas sob controle, como a extensão relatou por último (`{t:'tabs'}`). Vazia até o primeiro relato. */
      tabs = [];
      /** Último `{t:'focus'}` desta conexão (ISO); undefined se nunca. */
      lastFocusedAt;
      constructor(info2, ws) {
        this.info = info2;
        this.ws = ws;
      }
      /** O `BrowserInfo` com o último foco: o que `GET /browsers` devolve (e o que o MCP usa para escolher sem `browser`). */
      described() {
        return { ...this.info, ...this.lastFocusedAt ? { lastFocusedAt: this.lastFocusedAt } : {} };
      }
      status() {
        return { ...this.described(), tabs: this.tabs };
      }
      send(message) {
        this.ws.send(JSON.stringify(message));
      }
      /** Falha todas as chamadas em voo (a conexão caiu ou foi substituída). */
      failAll(error2) {
        for (const [rid, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(error2);
          this.pending.delete(rid);
        }
      }
    };
    Registry = class {
      browsers = /* @__PURE__ */ new Map();
      /** Clientes vistos, na ordem de inserção; `noteClient` reinsere para que o mais recente fique no fim. */
      clients = /* @__PURE__ */ new Map();
      list() {
        return [...this.browsers.values()].map((c) => c.described());
      }
      /** O que `GET /status` devolve: browsers com abas e foco, clientes do mais recente para o mais antigo. */
      status() {
        return { browsers: [...this.browsers.values()].map((c) => c.status()), clients: [...this.clients.values()].reverse() };
      }
      /**
       * Chamado quando o conjunto de agentes ATIVOS muda (um novo, um nome novo, um que encerrou): o servidor repassa às
       * extensões (`{t:'status'}`, A12). Só a mudança do conjunto, nunca cada chamada: N agentes agindo não geram tráfego.
       */
      onClientsChanged = null;
      /** Anota que `client` acabou de pedir `tool` (chamada ou consulta). O nome mais recente vence; sem nome, mantém o anterior. */
      noteClient(client, tool, now = /* @__PURE__ */ new Date()) {
        const previous = this.clients.get(client.id);
        this.clients.delete(client.id);
        const name = client.name ?? previous?.name;
        this.clients.set(client.id, { id: client.id, ...name ? { name } : {}, lastTool: tool, lastSeenAt: now.toISOString(), calls: (previous?.calls ?? 0) + 1 });
        while (this.clients.size > CLIENTS_MAX) this.clients.delete(this.clients.keys().next().value);
        const wasActive = previous !== void 0 && previous.lastTool !== RELEASE_TOOL;
        const isActive = tool !== RELEASE_TOOL;
        if (wasActive !== isActive || isActive && previous?.name !== name) this.onClientsChanged?.();
      }
      /**
       * Os agentes ativos, para o popup escolher a quem entregar uma aba (A12): clientes vistos cuja última ação não foi o
       * `release` (o agente que encerrou não recebe aba). Do mais recente para o mais antigo; só id e nome.
       */
      activeClients() {
        return [...this.clients.values()].reverse().filter((c) => c.lastTool !== RELEASE_TOOL).map((c) => ({ id: c.id, ...c.name ? { name: c.name } : {} }));
      }
      get(id) {
        return this.browsers.get(id);
      }
      /** Registra; devolve a conexão anterior do mesmo id (quem chama a encerra), se havia. */
      add(conn) {
        const previous = this.browsers.get(conn.info.id);
        this.browsers.set(conn.info.id, conn);
        return previous;
      }
      /** Remove só se ainda for esta conexão (uma substituta pode já ter tomado o lugar). */
      remove(conn) {
        if (this.browsers.get(conn.info.id) !== conn) return false;
        this.browsers.delete(conn.info.id);
        return true;
      }
      call(id, tool, args, timeoutMs, client) {
        const conn = this.browsers.get(id);
        if (!conn) {
          return Promise.reject(new BridgeError("BROWSER_NOT_FOUND", `no connected browser with id "${id}"`, { browsers: this.list() }));
        }
        return this.request(conn, tool, (rid) => client ? { t: "call", rid, tool, args, client } : { t: "call", rid, tool, args }, timeoutMs);
      }
      /**
       * `POST /clients/:id/release`: avisa TODOS os browsers conectados que o cliente encerrou; cada extensão solta as abas
       * dele e recolhe o grupo dele. Nunca rejeita: o agente já se foi, e o hospedeiro quer saber o que cada browser fez.
       * Sem browser conectado, lista vazia (nada a soltar).
       */
      async releaseClient(clientId, timeoutMs) {
        return Promise.all(
          [...this.browsers.values()].map(async (conn) => {
            const base = { id: conn.info.id, name: conn.info.name };
            try {
              const r = await this.request(conn, "release", (rid) => ({ t: "release", rid, client: clientId }), timeoutMs);
              const released = Array.isArray(r?.released) ? r.released.filter((n) => Number.isInteger(n)) : [];
              return { ...base, ok: true, released, groups: typeof r?.groups === "number" ? r.groups : 0 };
            } catch (e) {
              return { ...base, ok: false, error: toWireError(e) };
            }
          })
        );
      }
      /**
       * Pausa (`POST /pause`): toda extensão conectada solta TODAS as abas sob controle. Nunca rejeita: o resultado por
       * browser diz o que cada um soltou (um browser mudo vem com `ok: false`). Sem browser conectado, lista vazia.
       */
      async releaseAll(timeoutMs) {
        return Promise.all(
          [...this.browsers.values()].map(async (conn) => {
            const base = { id: conn.info.id, name: conn.info.name };
            try {
              const r = await this.request(conn, "release-all", (rid) => ({ t: "release-all", rid }), timeoutMs);
              const released = Array.isArray(r?.released) ? r.released.filter((n) => Number.isInteger(n)) : [];
              return { ...base, ok: true, released };
            } catch (e) {
              return { ...base, ok: false, error: toWireError(e) };
            }
          })
        );
      }
      /** Uma mensagem sem resposta a todas as extensões conectadas (ex.: `{t:'config'}` quando o config.json muda). */
      broadcast(message) {
        for (const conn of this.browsers.values()) {
          try {
            conn.send(message);
          } catch {
          }
        }
      }
      /** Um pedido com resposta (`{t:'result'}` com o mesmo rid) a uma extensão: o que `call` e `releaseClient` têm em comum. */
      request(conn, what, build2, timeoutMs) {
        const rid = randomUUID();
        return new Promise((resolve9, reject) => {
          const timer = setTimeout(() => {
            conn.pending.delete(rid);
            reject(new BridgeError("CALL_TIMEOUT", `browser "${conn.info.name}" did not answer ${what} within ${timeoutMs} ms`));
          }, timeoutMs);
          conn.pending.set(rid, { resolve: resolve9, reject, timer });
          try {
            conn.send(build2(rid));
          } catch (e) {
            clearTimeout(timer);
            conn.pending.delete(rid);
            reject(new BridgeError("BROWSER_DISCONNECTED", `browser "${conn.info.name}" is not reachable: ${e.message}`));
          }
        });
      }
      /** Entrega o resultado de uma chamada; false se o rid é desconhecido (timeout já disparou). */
      settle(conn, rid, outcome) {
        const p = conn.pending.get(rid);
        if (!p) return false;
        clearTimeout(p.timer);
        conn.pending.delete(rid);
        if (outcome.ok) p.resolve(outcome.value);
        else p.reject(new RemoteError(outcome.error));
        return true;
      }
    };
  }
});

// daemon/src/server.ts
import { statSync as statSync6 } from "node:fs";
import { createServer as createServer2 } from "node:http";
import { resolve as resolve7 } from "node:path";
function statusFor(code) {
  switch (code) {
    case "BROWSER_NOT_FOUND":
      return 404;
    case "INVALID_ARGUMENT":
    case "UNKNOWN_TOOL":
      return 400;
    case "UNAUTHORIZED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "CONFIG_INVALID":
      return 500;
    case "DEVICE_REQUEST_NOT_FOUND":
      return 404;
    case "EMBEDDED_UNAVAILABLE":
      return 503;
    case "CALL_TIMEOUT":
      return 504;
    case "BRIDGE_PAUSED":
      return 423;
    case "BROWSER_DISCONNECTED":
      return 502;
    default:
      return 422;
  }
}
async function startDaemon(opts) {
  const log2 = opts.log ?? defaultLog;
  const callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  let config2 = ensureConfig(opts.home, opts.port);
  const registry2 = new Registry();
  const stamp = () => {
    const s = statSync6(configPath(opts.home), { bigint: true });
    return `${s.ino}:${s.mtimeNs}:${s.size}`;
  };
  let seen = stamp();
  const fresh = () => {
    let now;
    try {
      now = stamp();
      if (now === seen) return config2;
      const next = readConfig(opts.home);
      if (!next) throw new Error("config.json disappeared");
      config2 = { ...next, port: config2.port };
    } catch (e) {
      log2("config_reload_failed", { reason: e.code ?? (e instanceof SyntaxError ? "invalid JSON" : "invalid") });
      throw new BridgeError("CONFIG_INVALID", "the Atrium Bridge config.json could not be read; fix it and retry");
    }
    seen = now;
    log2("config_reloaded", { keys: config2.apiKeys.length });
    registry2.broadcast({ t: "config", ...config2.brand ? { brand: config2.brand } : {}, ...config2.capabilities ? { capabilities: config2.capabilities } : {} });
    return config2;
  };
  let paused = false;
  const statusMessage = () => ({ t: "status", paused, clients: registry2.activeClients() });
  const pushStatus = (to) => to ? to.send(statusMessage()) : registry2.broadcast(statusMessage());
  registry2.onClientsChanged = () => pushStatus();
  const pause = async (who) => {
    paused = true;
    pushStatus();
    const started = Date.now();
    const browsers = await registry2.releaseAll(callTimeoutMs);
    log2("paused", { ...who, browsers: browsers.length, ok: browsers.every((b) => b.ok), ms: Date.now() - started });
    return browsers;
  };
  const resume = (who) => {
    const was = paused;
    paused = false;
    if (was) {
      log2("resumed", who);
      pushStatus();
    }
  };
  const downloadsDir = () => opts.downloadsDir ?? current().downloadsDir ?? defaultDownloadsDir();
  const current = () => {
    try {
      return fresh();
    } catch {
      return config2;
    }
  };
  const authenticate = (req) => {
    const auth = req.headers.authorization ?? "";
    const key = auth.startsWith("Bearer ") ? findBySecret(fresh().apiKeys, auth.slice(7)) : null;
    if (!key) throw new BridgeError("UNAUTHORIZED", "missing or invalid API key");
    return key;
  };
  const clientOf = (req) => {
    const id = req.headers[CLIENT_ID_HEADER];
    if (id === void 0) return void 0;
    if (!isClientId(id)) {
      throw Object.assign(new Error(`invalid X-Bridge-Client: expected ${CLIENT_ID_PATTERN.source}`), { code: "INVALID_ARGUMENT" });
    }
    const name = cleanClientName(req.headers[CLIENT_NAME_HEADER]);
    return name ? { id, name } : { id };
  };
  let boundPort = 0;
  let embedded;
  const nonces = createNonceStore();
  const hostOk = (host) => !!host && [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`].includes(host.toLowerCase());
  const json = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
    res.end(text);
  };
  const fail = (res, e) => {
    const error2 = toWireError(e);
    json(res, statusFor(error2.code), { ok: false, error: error2 });
  };
  const readBody = (req) => new Promise((resolve9, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("request body too large"), { code: "INVALID_ARGUMENT" }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve9(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
  const page = (res, status, html) => {
    res.writeHead(status, { ...PAGE_HEADERS, "content-length": Buffer.byteLength(html) });
    res.end(html);
  };
  const failurePage = (res, e) => {
    const code = toWireError(e).code;
    const body = code === "DEVICE_REQUEST_NOT_FOUND" ? APPROVAL_TEXTS.expiredBody : APPROVAL_TEXTS.unavailableBody;
    page(res, statusFor(code), messagePage(APPROVAL_TEXTS.failedHeading, body, "approval-failed"));
  };
  const handleApprovalPage = async (req, res, url) => {
    if (!embedded) return false;
    if (req.method === "GET" && url.pathname === "/device") {
      const code = normalizeUserCode(url.searchParams.get("user_code") ?? "");
      if (!code) {
        page(res, 400, messagePage(APPROVAL_TEXTS.invalidHeading, APPROVAL_TEXTS.invalidBody, "approval-invalid"));
      } else {
        page(res, 200, approvalPage(code, nonces.issue(code)));
      }
      return true;
    }
    if (req.method === "POST" && url.pathname === "/device/approve") {
      const sameOrigin = req.headers.origin === `http://${req.headers.host}`;
      const fromClick = req.headers["sec-fetch-site"] === "same-origin" && req.headers["sec-fetch-user"] === "?1";
      if (!sameOrigin || !fromClick) {
        page(res, 403, messagePage(APPROVAL_TEXTS.failedHeading, APPROVAL_TEXTS.staleBody, "approval-forbidden"));
        return true;
      }
      const form = new URLSearchParams(await readBody(req));
      const code = normalizeUserCode(form.get("user_code") ?? "");
      if (!code || !nonces.consume(form.get("nonce") ?? "", code)) {
        page(res, 403, messagePage(APPROVAL_TEXTS.failedHeading, APPROVAL_TEXTS.staleBody, "approval-forbidden"));
        return true;
      }
      try {
        await embedded.approve(code);
        log2("device_approved", { via: "page" });
        page(res, 200, messagePage(APPROVAL_TEXTS.approvedHeading, APPROVAL_TEXTS.approvedBody, "approval-done"));
      } catch (e) {
        log2("device_approval_failed", { via: "page", code: toWireError(e).code });
        failurePage(res, e);
      }
      return true;
    }
    return false;
  };
  const handleHttp = async (req, res) => {
    try {
      if (!hostOk(req.headers.host)) throw Object.assign(new Error("host not allowed"), { code: "UNAUTHORIZED" });
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (await handleApprovalPage(req, res, url)) return;
      if (req.headers.origin) throw Object.assign(new Error("browser-origin requests are refused"), { code: "UNAUTHORIZED" });
      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, { ok: true, ...embedded ? { embedded: embedded.state() } : {} });
      }
      const key = authenticate(req);
      const client = clientOf(req);
      if (req.method === "GET" && url.pathname === "/browsers") {
        if (client) registry2.noteClient(client, "list_browsers");
        return json(res, 200, { ok: true, browsers: registry2.list() });
      }
      if (req.method === "GET" && url.pathname === "/status") {
        const body = { ok: true, paused, ...registry2.status() };
        return json(res, 200, body);
      }
      if (req.method === "POST" && url.pathname === "/pause") {
        const browsers = await pause({ key: key.name });
        return json(res, 200, { ok: true, paused: true, browsers });
      }
      if (req.method === "POST" && url.pathname === "/resume") {
        resume({ key: key.name });
        return json(res, 200, { ok: true, paused: false });
      }
      if (req.method === "POST" && url.pathname === "/embedded/approve") {
        if (key.scope === "use" || key.scope === "upload") throw new BridgeError("FORBIDDEN", `key "${key.name}" has scope "${key.scope}"; approving a login needs a full or admin key`);
        if (!embedded) throw new BridgeError("EMBEDDED_UNAVAILABLE", "embedded mode is off (start the daemon with --embedded)");
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch (e) {
          if (e.code) throw e;
          throw Object.assign(new Error('body must be JSON: { "user_code": string }'), { code: "INVALID_ARGUMENT" });
        }
        const code = typeof body.user_code === "string" ? normalizeUserCode(body.user_code) : null;
        if (!code) throw Object.assign(new Error('"user_code" is required (as shown in the Assistant panel)'), { code: "INVALID_ARGUMENT" });
        await embedded.approve(code);
        log2("device_approved", { via: "api", key: key.name });
        return json(res, 200, { ok: true });
      }
      const rel = /^\/clients\/([^/]+)\/release$/.exec(url.pathname);
      if (req.method === "POST" && rel) {
        const id = decodeURIComponent(rel[1]);
        if (!isClientId(id)) {
          throw Object.assign(new Error(`invalid client id: expected ${CLIENT_ID_PATTERN.source}`), { code: "INVALID_ARGUMENT" });
        }
        const started = Date.now();
        const browsers = await registry2.releaseClient(id, callTimeoutMs);
        registry2.noteClient({ id }, "release");
        log2("release", { key: key.name, client: id, browsers: browsers.length, ok: browsers.every((b) => b.ok), ms: Date.now() - started });
        return json(res, 200, { ok: true, client: id, browsers });
      }
      const m = /^\/browsers\/([^/]+)\/call$/.exec(url.pathname);
      if (req.method === "POST" && m) {
        const id = decodeURIComponent(m[1]);
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch (e) {
          if (e.code) throw e;
          throw Object.assign(new Error('body must be JSON: { "tool": string, "args": object }'), { code: "INVALID_ARGUMENT" });
        }
        if (typeof body.tool !== "string") throw Object.assign(new Error('"tool" is required'), { code: "INVALID_ARGUMENT" });
        const args = body.args ?? {};
        assertValidCall(body.tool, args, { internal: true });
        if (SHELL_ONLY_TOOLS.has(body.tool)) {
          throw Object.assign(new Error(`${body.tool} runs only in the MCP server of the Bridge (the upload authorizations live in its memory), not in the daemon API`), { code: "INVALID_ARGUMENT" });
        }
        if (UPLOAD_TOOLS.has(body.tool) && key.scope !== "upload") {
          log2("upload_refused", { key: key.name, ...client ? { client: client.id } : {}, browser: id, tool: body.tool });
          throw new BridgeError(
            "FORBIDDEN",
            `upload only through the MCP server of the Bridge, with the operator's consent: key "${key.name}" has no "upload" scope`
          );
        }
        if (body.tool === "list_browsers") {
          throw Object.assign(new Error("list_browsers is GET /browsers"), { code: "INVALID_ARGUMENT" });
        }
        const timeout = typeof body.timeoutMs === "number" && body.timeoutMs > 0 ? Math.min(body.timeoutMs, 6e5) : callTimeoutMs;
        const started = Date.now();
        if (client) registry2.noteClient(client, body.tool);
        const who = { key: key.name, ...client ? { client: client.id } : {}, browser: id, tool: body.tool };
        try {
          if (paused) throw new BridgeError("BRIDGE_PAUSED", "the user paused the Bridge: no tool runs and no tab is under control until they resume it. Tell the user and wait.");
          if (body.tool === "upload") args.paths = assertUploadPaths(args.paths);
          let result = await registry2.call(id, body.tool, args, timeout, client);
          if (body.tool === "pdf") result = persistPdf(downloadsDir(), result);
          log2("call", { ...who, ok: true, ms: Date.now() - started });
          return json(res, 200, { ok: true, result });
        } catch (e) {
          log2("call", { ...who, ok: false, code: toWireError(e).code, ms: Date.now() - started });
          throw e;
        }
      }
      json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "no such route" } });
    } catch (e) {
      fail(res, e);
    }
  };
  const server = createServer2((req, res) => void handleHttp(req, res));
  const wss = new import_websocket_server.default({ noServer: true, maxPayload: MAX_FRAME });
  const refuseUpgrade = (socket, reason, origin) => {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    log2("upgrade_refused", { reason, origin: origin.slice(0, 120) });
  };
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const origin = req.headers.origin ?? "";
    if (url.pathname !== WS_PATH || !hostOk(req.headers.host) || !origin.startsWith(EXTENSION_ORIGIN_PREFIX)) {
      return refuseUpgrade(socket, "not an extension origin", origin);
    }
    const allowed = current().extensionIds ?? [];
    if (allowed.length > 0 && !allowed.includes(origin.slice(EXTENSION_ORIGIN_PREFIX.length))) {
      return refuseUpgrade(socket, "extension id not allowed", origin);
    }
    wss.handleUpgrade(req, socket, head, (ws) => onExtension(ws, req));
  });
  const onExtension = (ws, req) => {
    let conn = null;
    const helloTimer = setTimeout(() => ws.close(CLOSE_DENIED, "hello timeout"), HELLO_TIMEOUT_MS);
    const deny = (reason) => {
      clearTimeout(helloTimer);
      try {
        ws.send(JSON.stringify({ t: "denied", reason }));
      } catch {
      }
      ws.close(CLOSE_DENIED, reason);
      log2("pairing_denied", { reason, remote: req.socket.remoteAddress });
    };
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.close(CLOSE_PROTOCOL, "invalid JSON");
        return;
      }
      if (!conn) {
        if (msg.t !== "hello") return deny("hello expected first");
        if (msg.v !== PROTOCOL_VERSION) return deny(`protocol version ${msg.v} not supported`);
        if (typeof msg.token !== "string" || !msg.token || !sameSecret(msg.token, current().pairingToken)) {
          return deny("invalid pairing token");
        }
        if (typeof msg.id !== "string" || !msg.id || msg.id.length > 100) return deny("invalid id");
        clearTimeout(helloTimer);
        const info2 = {
          id: msg.id,
          name: String(msg.name ?? "").slice(0, 100) || msg.id,
          userAgent: String(msg.userAgent ?? "").slice(0, 300),
          connectedAt: (/* @__PURE__ */ new Date()).toISOString()
        };
        const mine = new BrowserConnection(info2, ws);
        const previous = registry2.add(mine);
        if (previous) {
          previous.failAll(new BridgeError("BROWSER_DISCONNECTED", "the browser reconnected; the call was lost"));
          previous.ws.close(CLOSE_REPLACED, "replaced by a new connection");
        }
        conn = mine;
        const { brand, capabilities, extensionVersion } = current();
        mine.send({
          t: "welcome",
          ...brand ? { brand } : {},
          ...capabilities ? { capabilities } : {},
          ...extensionVersion ? { extensionVersion } : {}
        });
        pushStatus(mine);
        log2("browser_connected", { browser: info2.id, name: info2.name });
        return;
      }
      if (msg.t === "pause") {
        void pause({ browser: conn.info.id });
        return;
      }
      if (msg.t === "resume") return resume({ browser: conn.info.id });
      if (msg.t === "ping") return conn.send({ t: "pong" });
      if (msg.t === "result" && typeof msg.rid === "string") {
        registry2.settle(conn, msg.rid, msg.ok ? { ok: true, value: msg.value } : { ok: false, error: msg.error });
        return;
      }
      if (msg.t === "tabs") {
        conn.tabs = sanitizeTabs(msg.tabs);
        return;
      }
      if (msg.t === "focus") {
        conn.lastFocusedAt = (/* @__PURE__ */ new Date()).toISOString();
        return;
      }
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (!conn) return;
      conn.failAll(new BridgeError("BROWSER_DISCONNECTED", `browser "${conn.info.name}" disconnected during the call`));
      if (registry2.remove(conn)) log2("browser_disconnected", { browser: conn.info.id, name: conn.info.name });
    });
    ws.on("error", () => ws.terminate());
  };
  await new Promise((resolve9, reject) => {
    server.once("error", (e) => {
      reject(
        e.code === "EADDRINUSE" ? new Error(`port ${opts.port ?? config2.port} is already in use (is another Atrium Bridge daemon running?)`) : e
      );
    });
    server.listen(opts.port ?? config2.port, "127.0.0.1", () => resolve9());
  });
  boundPort = server.address().port;
  if (boundPort !== config2.port) {
    updateConfig(opts.home, (c) => {
      c.port = boundPort;
    });
  }
  config2 = { ...config2, port: boundPort };
  log2("listening", { host: "127.0.0.1", port: boundPort });
  if (opts.embedded ?? config2.embedded === true) {
    const envFile = opts.supervisorEnvFile !== void 0 ? resolve7(opts.supervisorEnvFile) : config2.supervisorEnvFile !== void 0 ? resolve7(opts.home, config2.supervisorEnvFile) : void 0;
    embedded = startEmbeddedSupervisor({
      home: opts.home,
      port: opts.supervisorPort ?? boundPort + 1,
      verificationOrigin: `http://127.0.0.1:${boundPort}`,
      ...envFile !== void 0 ? { envFile } : {},
      ...opts.supervisorStartTimeoutMs !== void 0 ? { startTimeoutMs: opts.supervisorStartTimeoutMs } : {},
      log: log2
    });
  }
  return {
    port: boundPort,
    registry: registry2,
    ...embedded ? { embedded } : {},
    close: async () => {
      await embedded?.stop();
      await new Promise((resolveClose) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => resolveClose());
      });
    }
  };
}
var HELLO_TIMEOUT_MS, EXTENSION_ORIGIN_PREFIX, MAX_BODY, DEFAULT_CALL_TIMEOUT_MS, MAX_FRAME, defaultLog;
var init_server3 = __esm({
  "daemon/src/server.ts"() {
    "use strict";
    init_wrapper();
    init_catalog2();
    init_errors3();
    init_protocol();
    init_approval_page();
    init_config();
    init_embedded();
    init_files();
    init_registry();
    init_secrets();
    HELLO_TIMEOUT_MS = 5e3;
    EXTENSION_ORIGIN_PREFIX = "chrome-extension://";
    MAX_BODY = 1024 * 1024;
    DEFAULT_CALL_TIMEOUT_MS = 6e4;
    MAX_FRAME = 64 * 1024 * 1024;
    defaultLog = (event, fields = {}) => {
      process.stderr.write(JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), event, ...fields }) + "\n");
    };
  }
});

// daemon/src/cli.ts
var cli_exports = {};
import { execFileSync } from "node:child_process";
function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : void 0;
}
var USAGE, command, rest, home2;
var init_cli = __esm({
  async "daemon/src/cli.ts"() {
    "use strict";
    init_config();
    init_install();
    init_keys();
    init_server3();
    USAGE = `Atrium Bridge daemon
  start [--port N] [--embedded [--supervisor-env-file PATH]]
                            start the daemon (WebSocket + HTTP on 127.0.0.1). --embedded (or "embedded": true in
                            config.json) also hosts the Atrium supervisor on 127.0.0.1:<port+1> for the Assistant
  token pairing|api [--copy] show a secret on request (pairing: typed into the extension options; api: the local
                            API key in api.key, the one the MCP server uses when no key is given to it)
  key create <name> [--scope use|admin|upload] [--replace] [--json]
                            create a named API key and print its value ONCE (only its hash is stored). Give it to
                            a caller by ATRIUM_BRIDGE_KEY_FILE (a file holding the value) or ATRIUM_BRIDGE_KEY.
                            No --scope = full access except upload. --scope upload = use + upload/uploadTarget
                            straight through the API, WITHOUT the operator's consent (insecure; only the MCP server
                            should upload, with its own upload.key). The running daemon accepts it on the next request
  key list [--json]         list the API keys (names, dates, scopes; never values)
  key revoke <name>         revoke a key; the running daemon refuses it on the next request
  install --dir <folder> [--from <extension dir>] [--no-pin] [--json]
                            copy the built extension into <folder> and seed its pairing there (bridge.json with the
                            port and pairing token): load that folder in chrome://extensions and it connects by
                            itself. Also pins the extension id in config.json (extensionIds), so the daemon accepts
                            only that extension; --no-pin keeps accepting any
Environment: ATRIUM_BRIDGE_HOME (config folder, default ~/.atrium-bridge)
Files in that folder: daemon.pid (pid of the process that listens; written once it listens, removed on a clean exit)`;
    [command, ...rest] = process.argv.slice(2);
    home2 = bridgeHome();
    if (command === "start") {
      const portArg = flag(rest, "--port");
      const port = portArg === void 0 ? void 0 : Number(portArg);
      if (port !== void 0 && (!Number.isInteger(port) || port < 0 || port > 65535)) {
        process.stderr.write("--port must be an integer between 0 and 65535\n");
        process.exit(2);
      }
      const supervisorEnvFile = flag(rest, "--supervisor-env-file");
      const embedded = rest.includes("--embedded") ? true : void 0;
      if (supervisorEnvFile !== void 0 && (!supervisorEnvFile || supervisorEnvFile.startsWith("--"))) {
        process.stderr.write("--supervisor-env-file needs a path\n");
        process.exit(2);
      }
      const daemon = await startDaemon({
        home: home2,
        port,
        ...embedded ? { embedded } : {},
        ...supervisorEnvFile !== void 0 ? { supervisorEnvFile } : {}
      }).catch((e) => {
        process.stderr.write(`atrium-bridge daemon: ${e instanceof Error ? e.message : String(e)}
`);
        return process.exit(1);
      });
      try {
        writeDaemonPid(home2, process.pid);
      } catch (e) {
        process.stderr.write(`atrium-bridge daemon: could not write daemon.pid (${e instanceof Error ? e.message : String(e)})
`);
      }
      process.once("exit", () => removeDaemonPid(home2, process.pid));
      const stop = () => void daemon.close().then(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      daemon.embedded?.ready.catch((e) => {
        process.stderr.write(`embedded supervisor failed to start: ${e instanceof Error ? e.message : String(e)}
`);
        void daemon.close().then(() => process.exit(1));
      });
    } else if (command === "token") {
      const which = rest[0];
      if (which !== "pairing" && which !== "api") {
        process.stderr.write(`${USAGE}
`);
        process.exit(2);
      }
      const config2 = ensureConfig(home2);
      const value = which === "pairing" ? config2.pairingToken : readLocalKey(home2);
      if (value === null) {
        process.stderr.write("no local API key (api.key was revoked or removed): create one with `key create <name>`\n");
        process.exit(1);
      }
      if (rest.includes("--copy")) {
        execFileSync("clip", { input: value });
        process.stderr.write(`${which} token copied to the clipboard
`);
      } else {
        process.stdout.write(`${value}
`);
      }
    } else if (command === "key") {
      const [sub, name] = rest;
      const json = rest.includes("--json");
      const fail = (message, code = 1) => {
        process.stderr.write(`${message}
`);
        return process.exit(code);
      };
      const named = (n) => n && !n.startsWith("--") ? n : fail(`key ${sub ?? ""} needs a <name>
${USAGE}`, 2);
      try {
        if (sub === "create") {
          const keyName = named(name);
          const scopeArg = flag(rest, "--scope");
          if (rest.includes("--scope") && !KEY_SCOPES.includes(scopeArg)) fail(`--scope must be ${KEY_SCOPES.join(" or ")}`, 2);
          const created = addKey(home2, keyName, {
            ...scopeArg ? { scope: scopeArg } : {},
            ...rest.includes("--replace") ? { replace: true } : {}
          });
          if (json) process.stdout.write(`${JSON.stringify(created)}
`);
          else {
            process.stdout.write(`${created.value}
`);
            process.stderr.write(`key "${created.name}" created; this is the only time its value is shown
`);
          }
          if (created.scope === "upload") {
            process.stderr.write(
              'WARNING: scope "upload" lets this key send local files to sites through the daemon API directly, with no question\nto the operator and no folder rule (the consent lives only in the MCP server). Revoke it with `key revoke` when done.\n'
            );
          }
        } else if (sub === "list") {
          const keys = listKeys(home2);
          if (json) process.stdout.write(`${JSON.stringify(keys)}
`);
          else if (keys.length === 0) process.stdout.write("no API keys\n");
          else for (const k of keys) process.stdout.write(`${k.name}	${k.createdAt}	${k.scope ?? "full"}
`);
        } else if (sub === "revoke") {
          const keyName = named(name);
          if (!revokeKey(home2, keyName)) fail(`no key named "${keyName}"`);
          process.stderr.write(`key "${keyName}" revoked
`);
        } else {
          fail(USAGE, 2);
        }
      } catch (e) {
        fail(`atrium-bridge key ${sub}: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (command === "install") {
      const dir = flag(rest, "--dir");
      if (!dir || dir.startsWith("--")) {
        process.stderr.write(`install needs --dir <folder>
${USAGE}
`);
        process.exit(2);
      }
      const from = flag(rest, "--from");
      try {
        const result = installExtension({
          home: home2,
          dir,
          ...from && !from.startsWith("--") ? { source: from } : {},
          ...rest.includes("--no-pin") ? { pin: false } : {}
        });
        if (rest.includes("--json")) process.stdout.write(`${JSON.stringify(result)}
`);
        else {
          process.stdout.write(`extension installed in ${result.dir} (id ${result.extensionId}, ${result.files} files)
`);
          process.stdout.write(`pairing seeded for port ${result.port}; the daemon accepts ${result.extensionIds.length ? `only extension ids ${result.extensionIds.join(", ")}` : "any extension"}
`);
          process.stdout.write("load it: chrome://extensions > Developer mode > Load unpacked > that folder\n");
        }
      } catch (e) {
        process.stderr.write(`atrium-bridge install: ${e instanceof Error ? e.message : String(e)}
`);
        process.exit(1);
      }
    } else {
      process.stderr.write(`${USAGE}
`);
      process.exit(command ? 2 : 0);
    }
  }
});

// daemon/src/bundle.ts
import { realpathSync as realpathSync2 } from "node:fs";
import { resolve as resolve8 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// package.json
var package_default = {
  name: "@atrium/bridge",
  version: "0.1.0",
  private: true,
  type: "module",
  description: "Atrium Bridge: deixa os sistemas Atrium controlarem o browser Chromium do usuario (extensao MV3 + daemon local com API HTTP e servidor MCP).",
  scripts: {
    build: "node scripts/build.ts",
    icons: "node scripts/make-icons.ts",
    "brand:derive": "node scripts/brand-derive.ts",
    daemon: "node daemon/src/cli.ts start",
    mcp: "node daemon/src/mcp.ts",
    typecheck: "tsc --noEmit",
    test: "vitest run"
  },
  dependencies: {
    "@modelcontextprotocol/sdk": "1.30.1",
    ws: "^8.18.0"
  },
  devDependencies: {
    "@types/chrome": "^0.0.300",
    "@types/node": "^22.10.2",
    "@types/ws": "^8.5.13",
    esbuild: "^0.25.0",
    "playwright-core": "1.63.0",
    typescript: "^5.6.3",
    vitest: "^3.0.0",
    zod: "^4.6.7"
  }
};

// daemon/src/bundle.ts
init_keys();
init_install();
init_config();
init_package_info();
var version2 = package_default.version;
var USAGE2 = `Atrium Bridge ${package_default.version}
  start [--port N]            start the daemon (WebSocket + HTTP on 127.0.0.1)
  mcp                         MCP server (stdio); starts the daemon by itself when it does not answer
  token pairing|api [--copy]  show a secret on request
  key create <name> [--scope use|admin|upload] [--replace] [--json]
                              create a named API key; its value is printed once (only its hash is stored)
  key list [--json]           list the API keys (never values)
  key revoke <name>           revoke a key (the running daemon refuses it on the next request)
  install --dir <folder> [--from <extension dir>] [--no-pin] [--json]
                              copy the extension next to this bundle into <folder>, seed its pairing (bridge.json)
                              and pin its id in config.json; then "Load unpacked" that folder in chrome://extensions
  --version                   print the version
Environment: ATRIUM_BRIDGE_HOME (config folder, default ~/.atrium-bridge), ATRIUM_BRIDGE_PORT (mcp),
  ATRIUM_BRIDGE_KEY_FILE / ATRIUM_BRIDGE_KEY (mcp: the API key to use), ATRIUM_BRIDGE_SERVER_NAME (mcp: server name)`;
function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const norm2 = (p) => process.platform === "win32" ? p.toLowerCase() : p;
    return norm2(realpathSync2(resolve8(entry))) === norm2(realpathSync2(fileURLToPath2(import.meta.url)));
  } catch {
    return false;
  }
}
if (isMain()) {
  const [command2, ...rest2] = process.argv.slice(2);
  const [node2, script] = process.argv;
  if (command2 === "--version" || command2 === "-v") {
    process.stdout.write(`${package_default.version}
`);
  } else if (command2 === "mcp") {
    process.argv = [node2, script, ...rest2];
    await init_mcp().then(() => mcp_exports);
  } else if (command2 === "start" || command2 === "token" || command2 === "key" || command2 === "install") {
    process.argv = [node2, script, command2, ...rest2];
    await init_cli().then(() => cli_exports);
  } else {
    const help = command2 === "--help" || command2 === "-h" || command2 === void 0;
    process.stderr.write(`${USAGE2}
`);
    process.exit(help ? 0 : 2);
  }
}
export {
  addKey,
  brandFromPackage,
  bridgeHome,
  buildInfoNextTo,
  ensureConfig,
  extensionIdOf,
  installExtension,
  listKeys,
  localKeyPath,
  packagedServerName,
  pinExtensionId,
  readConfig,
  readPackagedBrand,
  revokeKey,
  rotatePairingToken,
  seedCapabilities,
  setBrand,
  setCapabilities,
  setExtensionIds,
  setExtensionVersion,
  version2 as version,
  writeSeed
};
