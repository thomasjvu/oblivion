// public/src/crypto.js
function bytesToBase64(bytes) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}
async function createVaultKey() {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  return { id: crypto.randomUUID(), raw, key };
}
async function encryptPayload(stateVaultKey, payload, aad) {
  let vaultKey = stateVaultKey;
  if (!vaultKey) {
    vaultKey = await createVaultKey();
  }
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(aad) },
    vaultKey.key,
    encoded
  );
  return {
    alg: "AES-256-GCM",
    keyId: vaultKey.id,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    aad
  };
}
async function wrapVaultKey(stateVaultKey, passphrase) {
  if (!stateVaultKey) throw { error: "vault-key-missing", message: "Open or create a case first." };
  if (passphrase.length < 12) throw { error: "passphrase-too-short", message: "Use at least 12 characters." };
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const passphraseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  const wrappingKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 31e4, hash: "SHA-256" },
    passphraseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const wrapped = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(stateVaultKey.id) },
    wrappingKey,
    stateVaultKey.raw
  );
  return {
    alg: "PBKDF2-SHA256+A256GCM",
    keyId: stateVaultKey.id,
    kdfSalt: bytesToBase64(salt),
    kdfIterations: 31e4,
    nonce: bytesToBase64(nonce),
    wrappedKey: bytesToBase64(new Uint8Array(wrapped))
  };
}

// public/src/metamaskSmartAccount.js
var SEPOLIA_CHAIN_ID = 11155111;
var SEPOLIA_HEX = "0xaa36a7";
function sepoliaAddChainParams(infuraKey) {
  const rpc = infuraKey ? `https://sepolia.infura.io/v3/${infuraKey}` : "https://rpc.sepolia.org";
  return {
    chainId: SEPOLIA_HEX,
    chainName: "Sepolia",
    nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: [rpc],
    blockExplorerUrls: ["https://sepolia.etherscan.io"]
  };
}
async function ensureChain(provider, config) {
  const chainIdHex = config?.chainIdHex || SEPOLIA_HEX;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }]
    });
    return;
  } catch (error) {
    if (error?.code !== 4902) throw error;
  }
  const addParams = config?.addChainParams || sepoliaAddChainParams(config?.infuraKey);
  await provider.request({
    method: "wallet_addEthereumChain",
    params: [addParams]
  });
}
async function sendUpgradeBatch(provider, walletAddress, config) {
  const chainIdHex = config?.chainIdHex || SEPOLIA_HEX;
  await ensureChain(provider, config);
  const calls = [
    {
      to: walletAddress,
      value: "0x0"
    }
  ];
  const result = await provider.request({
    method: "wallet_sendCalls",
    params: [
      {
        version: "2.0.0",
        chainId: chainIdHex,
        from: walletAddress,
        calls,
        atomicRequired: true
      }
    ]
  });
  const id = typeof result === "string" ? result : result?.id;
  if (!id) throw new Error("MetaMask did not return a batch id for wallet_sendCalls.");
  return { callsId: id, chainId: config?.chainId || SEPOLIA_CHAIN_ID };
}
async function pollCallsStatus(provider, callsId, options = {}) {
  const attempts = options.attempts ?? 12;
  const delayMs = options.delayMs ?? 1500;
  for (let i = 0; i < attempts; i += 1) {
    const status = await provider.request({
      method: "wallet_getCallsStatus",
      params: [callsId]
    });
    if (status?.status === "CONFIRMED" || status?.status === "success") {
      const txHash = status?.receipts?.[0]?.transactionHash || status?.receipts?.[0]?.txHash || status?.transactionHash;
      return { status: "confirmed", txHash, raw: status };
    }
    if (status?.status === "FAILED" || status?.status === "failure") {
      throw new Error("Smart account upgrade batch failed on chain.");
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { status: "pending", txHash: void 0, raw: null };
}
async function tryLiveSmartAccountUpgrade(provider, walletAddress, config) {
  if (!config?.liveEnabled) {
    return { ok: false, reason: "live-disabled" };
  }
  if (!provider?.request) {
    return { ok: false, reason: "no-provider" };
  }
  try {
    const sent = await sendUpgradeBatch(provider, walletAddress, config);
    const polled = await pollCallsStatus(provider, sent.callsId, config.poll);
    return {
      ok: true,
      mode: "live",
      callsId: sent.callsId,
      chainId: sent.chainId,
      txHash: polled.txHash,
      status: polled.status
    };
  } catch (error) {
    return {
      ok: false,
      reason: error?.code === 4001 ? "user-rejected" : "upgrade-failed",
      message: error?.message || "Live MetaMask upgrade failed."
    };
  }
}

// public/src/walletLog.js
var MAX = 24;
function createWalletLogger(onUpdate) {
  const entries = [];
  function push(level, message, detail) {
    const row = {
      ts: (/* @__PURE__ */ new Date()).toISOString().slice(11, 19),
      level,
      message,
      detail: detail ? JSON.stringify(detail, (_, v) => typeof v === "bigint" ? v.toString() : v) : ""
    };
    entries.unshift(row);
    if (entries.length > MAX) entries.length = MAX;
    console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](`[oblivion:wallet] ${message}`, detail ?? "");
    onUpdate?.(entries);
    return row;
  }
  return {
    entries: () => entries,
    info: (message, detail) => push("info", message, detail),
    warn: (message, detail) => push("warn", message, detail),
    error: (message, detail) => push("error", message, detail)
  };
}
var DEFAULT_WALLET_CONFIG = {
  mode: "demo",
  liveEnabled: false,
  chainId: 11155111,
  chainIdHex: "0xaa36a7",
  addChainParams: {
    chainId: "0xaa36a7",
    chainName: "Sepolia",
    nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://rpc.sepolia.org"],
    blockExplorerUrls: ["https://sepolia.etherscan.io"]
  },
  poll: { attempts: 12, delayMs: 1500 }
};

// node_modules/iconify-icon/dist/iconify-icon.mjs
var defaultIconDimensions = Object.freeze({
  left: 0,
  top: 0,
  width: 16,
  height: 16
});
var defaultIconTransformations = Object.freeze({
  rotate: 0,
  vFlip: false,
  hFlip: false
});
var defaultIconProps = Object.freeze({
  ...defaultIconDimensions,
  ...defaultIconTransformations
});
var defaultExtendedIconProps = Object.freeze({
  ...defaultIconProps,
  body: "",
  hidden: false
});
var defaultIconSizeCustomisations = Object.freeze({
  width: null,
  height: null
});
var defaultIconCustomisations = Object.freeze({
  ...defaultIconSizeCustomisations,
  ...defaultIconTransformations
});
function rotateFromString(value, defaultValue = 0) {
  const units = value.replace(/^-?[0-9.]*/, "");
  function cleanup(value$1) {
    while (value$1 < 0) value$1 += 4;
    return value$1 % 4;
  }
  if (units === "") {
    const num = parseInt(value);
    return isNaN(num) ? 0 : cleanup(num);
  } else if (units !== value) {
    let split = 0;
    switch (units) {
      case "%":
        split = 25;
        break;
      case "deg":
        split = 90;
    }
    if (split) {
      let num = parseFloat(value.slice(0, value.length - units.length));
      if (isNaN(num)) return 0;
      num = num / split;
      return num % 1 === 0 ? cleanup(num) : 0;
    }
  }
  return defaultValue;
}
var separator = /[\s,]+/;
function flipFromString(custom, flip) {
  flip.split(separator).forEach((str) => {
    switch (str.trim()) {
      case "horizontal":
        custom.hFlip = true;
        break;
      case "vertical":
        custom.vFlip = true;
        break;
    }
  });
}
var defaultCustomisations = {
  ...defaultIconCustomisations,
  preserveAspectRatio: ""
};
function getCustomisations(node) {
  const customisations = {
    ...defaultCustomisations
  };
  const attr = (key, def) => node.getAttribute(key) || def;
  customisations.width = attr("width", null);
  customisations.height = attr("height", null);
  customisations.rotate = rotateFromString(attr("rotate", ""));
  flipFromString(customisations, attr("flip", ""));
  customisations.preserveAspectRatio = attr("preserveAspectRatio", attr("preserveaspectratio", ""));
  return customisations;
}
function haveCustomisationsChanged(value1, value2) {
  for (const key in defaultCustomisations) {
    if (value1[key] !== value2[key]) {
      return true;
    }
  }
  return false;
}
var matchIconName = /^[a-z0-9]+(-[a-z0-9]+)*$/;
var stringToIcon = (value, validate, allowSimpleName, provider = "") => {
  const colonSeparated = value.split(":");
  if (value.slice(0, 1) === "@") {
    if (colonSeparated.length < 2 || colonSeparated.length > 3) return null;
    provider = colonSeparated.shift().slice(1);
  }
  if (colonSeparated.length > 3 || !colonSeparated.length) return null;
  if (colonSeparated.length > 1) {
    const name$1 = colonSeparated.pop();
    const prefix = colonSeparated.pop();
    const result = {
      provider: colonSeparated.length > 0 ? colonSeparated[0] : provider,
      prefix,
      name: name$1
    };
    return validate && !validateIconName(result) ? null : result;
  }
  const name = colonSeparated[0];
  const dashSeparated = name.split("-");
  if (dashSeparated.length > 1) {
    const result = {
      provider,
      prefix: dashSeparated.shift(),
      name: dashSeparated.join("-")
    };
    return validate && !validateIconName(result) ? null : result;
  }
  if (allowSimpleName && provider === "") {
    const result = {
      provider,
      prefix: "",
      name
    };
    return validate && !validateIconName(result, allowSimpleName) ? null : result;
  }
  return null;
};
var validateIconName = (icon, allowSimpleName) => {
  if (!icon) return false;
  return !!((allowSimpleName && icon.prefix === "" || !!icon.prefix) && !!icon.name);
};
function getIconsTree(data, names) {
  const icons = data.icons;
  const aliases = data.aliases || /* @__PURE__ */ Object.create(null);
  const resolved = /* @__PURE__ */ Object.create(null);
  function resolve(name) {
    if (icons[name]) return resolved[name] = [];
    if (!(name in resolved)) {
      resolved[name] = null;
      const parent = aliases[name] && aliases[name].parent;
      const value = parent && resolve(parent);
      if (value) resolved[name] = [parent].concat(value);
    }
    return resolved[name];
  }
  Object.keys(icons).concat(Object.keys(aliases)).forEach(resolve);
  return resolved;
}
function mergeIconTransformations(obj1, obj2) {
  const result = {};
  if (!obj1.hFlip !== !obj2.hFlip) result.hFlip = true;
  if (!obj1.vFlip !== !obj2.vFlip) result.vFlip = true;
  const rotate = ((obj1.rotate || 0) + (obj2.rotate || 0)) % 4;
  if (rotate) result.rotate = rotate;
  return result;
}
function mergeIconData(parent, child) {
  const result = mergeIconTransformations(parent, child);
  for (const key in defaultExtendedIconProps) if (key in defaultIconTransformations) {
    if (key in parent && !(key in result)) result[key] = defaultIconTransformations[key];
  } else if (key in child) result[key] = child[key];
  else if (key in parent) result[key] = parent[key];
  return result;
}
function internalGetIconData(data, name, tree) {
  const icons = data.icons;
  const aliases = data.aliases || /* @__PURE__ */ Object.create(null);
  let currentProps = {};
  function parse(name$1) {
    currentProps = mergeIconData(icons[name$1] || aliases[name$1], currentProps);
  }
  parse(name);
  tree.forEach(parse);
  return mergeIconData(data, currentProps);
}
function parseIconSet(data, callback) {
  const names = [];
  if (typeof data !== "object" || typeof data.icons !== "object") return names;
  if (data.not_found instanceof Array) data.not_found.forEach((name) => {
    callback(name, null);
    names.push(name);
  });
  const tree = getIconsTree(data);
  for (const name in tree) {
    const item = tree[name];
    if (item) {
      callback(name, internalGetIconData(data, name, item));
      names.push(name);
    }
  }
  return names;
}
var optionalPropertyDefaults = {
  provider: "",
  aliases: {},
  not_found: {},
  ...defaultIconDimensions
};
function checkOptionalProps(item, defaults) {
  for (const prop in defaults) if (prop in item && typeof item[prop] !== typeof defaults[prop]) return false;
  return true;
}
function quicklyValidateIconSet(obj) {
  if (typeof obj !== "object" || obj === null) return null;
  const data = obj;
  if (typeof data.prefix !== "string" || !obj.icons || typeof obj.icons !== "object") return null;
  if (!checkOptionalProps(obj, optionalPropertyDefaults)) return null;
  const icons = data.icons;
  for (const name in icons) {
    const icon = icons[name];
    if (!name || typeof icon.body !== "string" || !checkOptionalProps(icon, defaultExtendedIconProps)) return null;
  }
  const aliases = data.aliases || /* @__PURE__ */ Object.create(null);
  for (const name in aliases) {
    const icon = aliases[name];
    const parent = icon.parent;
    if (!name || typeof parent !== "string" || !icons[parent] && !aliases[parent] || !checkOptionalProps(icon, defaultExtendedIconProps)) return null;
  }
  return data;
}
var dataStorage = /* @__PURE__ */ Object.create(null);
function newStorage(provider, prefix) {
  return {
    provider,
    prefix,
    icons: /* @__PURE__ */ Object.create(null),
    missing: /* @__PURE__ */ new Set()
  };
}
function getStorage(provider, prefix) {
  const providerStorage = dataStorage[provider] || (dataStorage[provider] = /* @__PURE__ */ Object.create(null));
  return providerStorage[prefix] || (providerStorage[prefix] = newStorage(provider, prefix));
}
function addIconSet(storage2, data) {
  if (!quicklyValidateIconSet(data)) return [];
  return parseIconSet(data, (name, icon) => {
    if (icon) storage2.icons[name] = icon;
    else storage2.missing.add(name);
  });
}
function addIconToStorage(storage2, name, icon) {
  try {
    if (typeof icon.body === "string") {
      storage2.icons[name] = { ...icon };
      return true;
    }
  } catch (err) {
  }
  return false;
}
function listIcons$1(provider, prefix) {
  let allIcons = [];
  (typeof provider === "string" ? [provider] : Object.keys(dataStorage)).forEach((provider$1) => {
    (typeof provider$1 === "string" && typeof prefix === "string" ? [prefix] : Object.keys(dataStorage[provider$1] || {})).forEach((prefix$1) => {
      const storage2 = getStorage(provider$1, prefix$1);
      allIcons = allIcons.concat(Object.keys(storage2.icons).map((name) => (provider$1 !== "" ? "@" + provider$1 + ":" : "") + prefix$1 + ":" + name));
    });
  });
  return allIcons;
}
var simpleNames = false;
function allowSimpleNames(allow) {
  if (typeof allow === "boolean") simpleNames = allow;
  return simpleNames;
}
function getIconData(name) {
  const icon = typeof name === "string" ? stringToIcon(name, true, simpleNames) : name;
  if (icon) {
    const storage2 = getStorage(icon.provider, icon.prefix);
    const iconName = icon.name;
    return storage2.icons[iconName] || (storage2.missing.has(iconName) ? null : void 0);
  }
}
function addIcon$1(name, data) {
  const icon = stringToIcon(name, true, simpleNames);
  if (!icon) return false;
  const storage2 = getStorage(icon.provider, icon.prefix);
  if (data) return addIconToStorage(storage2, icon.name, data);
  else {
    storage2.missing.add(icon.name);
    return true;
  }
}
function addCollection$1(data, provider) {
  if (typeof data !== "object") return false;
  if (typeof provider !== "string") provider = data.provider || "";
  if (simpleNames && !provider && !data.prefix) {
    let added = false;
    if (quicklyValidateIconSet(data)) {
      data.prefix = "";
      parseIconSet(data, (name, icon) => {
        if (addIcon$1(name, icon)) added = true;
      });
    }
    return added;
  }
  const prefix = data.prefix;
  if (!validateIconName({
    prefix,
    name: "a"
  })) return false;
  return !!addIconSet(getStorage(provider, prefix), data);
}
function iconLoaded$1(name) {
  return !!getIconData(name);
}
function getIcon$1(name) {
  const result = getIconData(name);
  return result ? {
    ...defaultIconProps,
    ...result
  } : result;
}
function removeCallback(storages, id) {
  storages.forEach((storage2) => {
    const items = storage2.loaderCallbacks;
    if (items) storage2.loaderCallbacks = items.filter((row) => row.id !== id);
  });
}
function updateCallbacks(storage2) {
  if (!storage2.pendingCallbacksFlag) {
    storage2.pendingCallbacksFlag = true;
    setTimeout(() => {
      storage2.pendingCallbacksFlag = false;
      const items = storage2.loaderCallbacks ? storage2.loaderCallbacks.slice(0) : [];
      if (!items.length) return;
      let hasPending = false;
      const provider = storage2.provider;
      const prefix = storage2.prefix;
      items.forEach((item) => {
        const icons = item.icons;
        const oldLength = icons.pending.length;
        icons.pending = icons.pending.filter((icon) => {
          if (icon.prefix !== prefix) return true;
          const name = icon.name;
          if (storage2.icons[name]) icons.loaded.push({
            provider,
            prefix,
            name
          });
          else if (storage2.missing.has(name)) icons.missing.push({
            provider,
            prefix,
            name
          });
          else {
            hasPending = true;
            return true;
          }
          return false;
        });
        if (icons.pending.length !== oldLength) {
          if (!hasPending) removeCallback([storage2], item.id);
          item.callback(icons.loaded.slice(0), icons.missing.slice(0), icons.pending.slice(0), item.abort);
        }
      });
    });
  }
}
var idCounter = 0;
function storeCallback(callback, icons, pendingSources) {
  const id = idCounter++;
  const abort = removeCallback.bind(null, pendingSources, id);
  if (!icons.pending.length) return abort;
  const item = {
    id,
    icons,
    callback,
    abort
  };
  pendingSources.forEach((storage2) => {
    (storage2.loaderCallbacks || (storage2.loaderCallbacks = [])).push(item);
  });
  return abort;
}
function sortIcons(icons) {
  const result = {
    loaded: [],
    missing: [],
    pending: []
  };
  const storage2 = /* @__PURE__ */ Object.create(null);
  icons.sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    if (a.prefix !== b.prefix) return a.prefix.localeCompare(b.prefix);
    return a.name.localeCompare(b.name);
  });
  let lastIcon = {
    provider: "",
    prefix: "",
    name: ""
  };
  icons.forEach((icon) => {
    if (lastIcon.name === icon.name && lastIcon.prefix === icon.prefix && lastIcon.provider === icon.provider) return;
    lastIcon = icon;
    const provider = icon.provider;
    const prefix = icon.prefix;
    const name = icon.name;
    const providerStorage = storage2[provider] || (storage2[provider] = /* @__PURE__ */ Object.create(null));
    const localStorage2 = providerStorage[prefix] || (providerStorage[prefix] = getStorage(provider, prefix));
    let list;
    if (name in localStorage2.icons) list = result.loaded;
    else if (prefix === "" || localStorage2.missing.has(name)) list = result.missing;
    else list = result.pending;
    const item = {
      provider,
      prefix,
      name
    };
    list.push(item);
  });
  return result;
}
var storage = /* @__PURE__ */ Object.create(null);
function setAPIModule(provider, item) {
  storage[provider] = item;
}
function getAPIModule(provider) {
  return storage[provider] || storage[""];
}
function listToIcons(list, validate = true, simpleNames2 = false) {
  const result = [];
  list.forEach((item) => {
    const icon = typeof item === "string" ? stringToIcon(item, validate, simpleNames2) : item;
    if (icon) result.push(icon);
  });
  return result;
}
function createAPIConfig(source) {
  let resources;
  if (typeof source.resources === "string") resources = [source.resources];
  else {
    resources = source.resources;
    if (!(resources instanceof Array) || !resources.length) return null;
  }
  return {
    resources,
    path: source.path || "/",
    maxURL: source.maxURL || 500,
    rotate: source.rotate || 750,
    timeout: source.timeout || 5e3,
    random: source.random === true,
    index: source.index || 0,
    dataAfterTimeout: source.dataAfterTimeout !== false
  };
}
var configStorage = /* @__PURE__ */ Object.create(null);
var fallBackAPISources = ["https://api.simplesvg.com", "https://api.unisvg.com"];
var fallBackAPI = [];
while (fallBackAPISources.length > 0) if (fallBackAPISources.length === 1) fallBackAPI.push(fallBackAPISources.shift());
else if (Math.random() > 0.5) fallBackAPI.push(fallBackAPISources.shift());
else fallBackAPI.push(fallBackAPISources.pop());
configStorage[""] = createAPIConfig({ resources: ["https://api.iconify.design"].concat(fallBackAPI) });
function addAPIProvider$1(provider, customConfig) {
  const config = createAPIConfig(customConfig);
  if (config === null) return false;
  configStorage[provider] = config;
  return true;
}
function getAPIConfig(provider) {
  return configStorage[provider];
}
function listAPIProviders() {
  return Object.keys(configStorage);
}
var defaultConfig = {
  resources: [],
  index: 0,
  timeout: 2e3,
  rotate: 750,
  random: false,
  dataAfterTimeout: false
};
function sendQuery(config, payload, query, done) {
  const resourcesCount = config.resources.length;
  const startIndex = config.random ? Math.floor(Math.random() * resourcesCount) : config.index;
  let resources;
  if (config.random) {
    let list = config.resources.slice(0);
    resources = [];
    while (list.length > 1) {
      const nextIndex = Math.floor(Math.random() * list.length);
      resources.push(list[nextIndex]);
      list = list.slice(0, nextIndex).concat(list.slice(nextIndex + 1));
    }
    resources = resources.concat(list);
  } else resources = config.resources.slice(startIndex).concat(config.resources.slice(0, startIndex));
  const startTime = Date.now();
  let status = "pending";
  let queriesSent = 0;
  let lastError;
  let timer = null;
  let queue = [];
  let doneCallbacks = [];
  if (typeof done === "function") doneCallbacks.push(done);
  function resetTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }
  function abort() {
    if (status === "pending") status = "aborted";
    resetTimer();
    queue.forEach((item) => {
      if (item.status === "pending") item.status = "aborted";
    });
    queue = [];
  }
  function subscribe(callback, overwrite) {
    if (overwrite) doneCallbacks = [];
    if (typeof callback === "function") doneCallbacks.push(callback);
  }
  function getQueryStatus() {
    return {
      startTime,
      payload,
      status,
      queriesSent,
      queriesPending: queue.length,
      subscribe,
      abort
    };
  }
  function failQuery() {
    status = "failed";
    doneCallbacks.forEach((callback) => {
      callback(void 0, lastError);
    });
  }
  function clearQueue() {
    queue.forEach((item) => {
      if (item.status === "pending") item.status = "aborted";
    });
    queue = [];
  }
  function moduleResponse(item, response, data) {
    const isError = response !== "success";
    queue = queue.filter((queued) => queued !== item);
    switch (status) {
      case "pending":
        break;
      case "failed":
        if (isError || !config.dataAfterTimeout) return;
        break;
      default:
        return;
    }
    if (response === "abort") {
      lastError = data;
      failQuery();
      return;
    }
    if (isError) {
      lastError = data;
      if (!queue.length) if (!resources.length) failQuery();
      else execNext();
      return;
    }
    resetTimer();
    clearQueue();
    if (!config.random) {
      const index = config.resources.indexOf(item.resource);
      if (index !== -1 && index !== config.index) config.index = index;
    }
    status = "completed";
    doneCallbacks.forEach((callback) => {
      callback(data);
    });
  }
  function execNext() {
    if (status !== "pending") return;
    resetTimer();
    const resource = resources.shift();
    if (resource === void 0) {
      if (queue.length) {
        timer = setTimeout(() => {
          resetTimer();
          if (status === "pending") {
            clearQueue();
            failQuery();
          }
        }, config.timeout);
        return;
      }
      failQuery();
      return;
    }
    const item = {
      status: "pending",
      resource,
      callback: (status$1, data) => {
        moduleResponse(item, status$1, data);
      }
    };
    queue.push(item);
    queriesSent++;
    timer = setTimeout(execNext, config.rotate);
    query(resource, payload, item.callback);
  }
  setTimeout(execNext);
  return getQueryStatus;
}
function initRedundancy(cfg) {
  const config = {
    ...defaultConfig,
    ...cfg
  };
  let queries = [];
  function cleanup() {
    queries = queries.filter((item) => item().status === "pending");
  }
  function query(payload, queryCallback, doneCallback) {
    const query$1 = sendQuery(config, payload, queryCallback, (data, error) => {
      cleanup();
      if (doneCallback) doneCallback(data, error);
    });
    queries.push(query$1);
    return query$1;
  }
  function find(callback) {
    return queries.find((value) => {
      return callback(value);
    }) || null;
  }
  return {
    query,
    find,
    setIndex: (index) => {
      config.index = index;
    },
    getIndex: () => config.index,
    cleanup
  };
}
function emptyCallback$1() {
}
var redundancyCache = /* @__PURE__ */ Object.create(null);
function getRedundancyCache(provider) {
  if (!redundancyCache[provider]) {
    const config = getAPIConfig(provider);
    if (!config) return;
    redundancyCache[provider] = {
      config,
      redundancy: initRedundancy(config)
    };
  }
  return redundancyCache[provider];
}
function sendAPIQuery(target, query, callback) {
  let redundancy;
  let send2;
  if (typeof target === "string") {
    const api = getAPIModule(target);
    if (!api) {
      callback(void 0, 424);
      return emptyCallback$1;
    }
    send2 = api.send;
    const cached = getRedundancyCache(target);
    if (cached) redundancy = cached.redundancy;
  } else {
    const config = createAPIConfig(target);
    if (config) {
      redundancy = initRedundancy(config);
      const api = getAPIModule(target.resources ? target.resources[0] : "");
      if (api) send2 = api.send;
    }
  }
  if (!redundancy || !send2) {
    callback(void 0, 424);
    return emptyCallback$1;
  }
  return redundancy.query(query, send2, callback)().abort;
}
function emptyCallback() {
}
function loadedNewIcons(storage2) {
  if (!storage2.iconsLoaderFlag) {
    storage2.iconsLoaderFlag = true;
    setTimeout(() => {
      storage2.iconsLoaderFlag = false;
      updateCallbacks(storage2);
    });
  }
}
function checkIconNamesForAPI(icons) {
  const valid = [];
  const invalid = [];
  icons.forEach((name) => {
    (name.match(matchIconName) ? valid : invalid).push(name);
  });
  return {
    valid,
    invalid
  };
}
function parseLoaderResponse(storage2, icons, data) {
  function checkMissing() {
    const pending = storage2.pendingIcons;
    icons.forEach((name) => {
      if (pending) pending.delete(name);
      if (!storage2.icons[name]) storage2.missing.add(name);
    });
  }
  if (data && typeof data === "object") try {
    if (!addIconSet(storage2, data).length) {
      checkMissing();
      return;
    }
  } catch (err) {
    console.error(err);
  }
  checkMissing();
  loadedNewIcons(storage2);
}
function parsePossiblyAsyncResponse(response, callback) {
  if (response instanceof Promise) response.then((data) => {
    callback(data);
  }).catch(() => {
    callback(null);
  });
  else callback(response);
}
function loadNewIcons(storage2, icons) {
  if (!storage2.iconsToLoad) storage2.iconsToLoad = icons;
  else storage2.iconsToLoad = storage2.iconsToLoad.concat(icons).sort();
  if (!storage2.iconsQueueFlag) {
    storage2.iconsQueueFlag = true;
    setTimeout(() => {
      storage2.iconsQueueFlag = false;
      const { provider, prefix } = storage2;
      const icons$1 = storage2.iconsToLoad;
      delete storage2.iconsToLoad;
      if (!icons$1 || !icons$1.length) return;
      const customIconLoader = storage2.loadIcon;
      if (storage2.loadIcons && (icons$1.length > 1 || !customIconLoader)) {
        parsePossiblyAsyncResponse(storage2.loadIcons(icons$1, prefix, provider), (data) => {
          parseLoaderResponse(storage2, icons$1, data);
        });
        return;
      }
      if (customIconLoader) {
        icons$1.forEach((name) => {
          parsePossiblyAsyncResponse(customIconLoader(name, prefix, provider), (data) => {
            parseLoaderResponse(storage2, [name], data ? {
              prefix,
              icons: { [name]: data }
            } : null);
          });
        });
        return;
      }
      const { valid, invalid } = checkIconNamesForAPI(icons$1);
      if (invalid.length) parseLoaderResponse(storage2, invalid, null);
      if (!valid.length) return;
      const api = prefix.match(matchIconName) ? getAPIModule(provider) : null;
      if (!api) {
        parseLoaderResponse(storage2, valid, null);
        return;
      }
      api.prepare(provider, prefix, valid).forEach((item) => {
        sendAPIQuery(provider, item, (data) => {
          parseLoaderResponse(storage2, item.icons, data);
        });
      });
    });
  }
}
var loadIcons$1 = (icons, callback) => {
  const sortedIcons = sortIcons(listToIcons(icons, true, allowSimpleNames()));
  if (!sortedIcons.pending.length) {
    let callCallback = true;
    if (callback) setTimeout(() => {
      if (callCallback) callback(sortedIcons.loaded, sortedIcons.missing, sortedIcons.pending, emptyCallback);
    });
    return () => {
      callCallback = false;
    };
  }
  const newIcons = /* @__PURE__ */ Object.create(null);
  const sources = [];
  let lastProvider, lastPrefix;
  sortedIcons.pending.forEach((icon) => {
    const { provider, prefix } = icon;
    if (prefix === lastPrefix && provider === lastProvider) return;
    lastProvider = provider;
    lastPrefix = prefix;
    sources.push(getStorage(provider, prefix));
    const providerNewIcons = newIcons[provider] || (newIcons[provider] = /* @__PURE__ */ Object.create(null));
    if (!providerNewIcons[prefix]) providerNewIcons[prefix] = [];
  });
  sortedIcons.pending.forEach((icon) => {
    const { provider, prefix, name } = icon;
    const storage2 = getStorage(provider, prefix);
    const pendingQueue = storage2.pendingIcons || (storage2.pendingIcons = /* @__PURE__ */ new Set());
    if (!pendingQueue.has(name)) {
      pendingQueue.add(name);
      newIcons[provider][prefix].push(name);
    }
  });
  sources.forEach((storage2) => {
    const list = newIcons[storage2.provider][storage2.prefix];
    if (list.length) loadNewIcons(storage2, list);
  });
  return callback ? storeCallback(callback, sortedIcons, sources) : emptyCallback;
};
var loadIcon$1 = (icon) => {
  return new Promise((fulfill, reject) => {
    const iconObj = typeof icon === "string" ? stringToIcon(icon, true) : icon;
    if (!iconObj) {
      reject(icon);
      return;
    }
    loadIcons$1([iconObj || icon], (loaded) => {
      if (loaded.length && iconObj) {
        const data = getIconData(iconObj);
        if (data) {
          fulfill({
            ...defaultIconProps,
            ...data
          });
          return;
        }
      }
      reject(icon);
    });
  });
};
function testIconObject(value) {
  try {
    const obj = typeof value === "string" ? JSON.parse(value) : value;
    if (typeof obj.body === "string") {
      return {
        ...obj
      };
    }
  } catch (err) {
  }
}
function parseIconValue(value, onload) {
  if (typeof value === "object") {
    const data2 = testIconObject(value);
    return {
      data: data2,
      value
    };
  }
  if (typeof value !== "string") {
    return {
      value
    };
  }
  if (value.includes("{")) {
    const data2 = testIconObject(value);
    if (data2) {
      return {
        data: data2,
        value
      };
    }
  }
  const name = stringToIcon(value, true, true);
  if (!name) {
    return {
      value
    };
  }
  const data = getIconData(name);
  if (data !== void 0 || !name.prefix) {
    return {
      value,
      name,
      data
      // could be 'null' -> icon is missing
    };
  }
  const loading = loadIcons$1([name], () => onload(value, name, getIconData(name)));
  return {
    value,
    name,
    loading
  };
}
var isBuggedSafari = false;
try {
  isBuggedSafari = navigator.vendor.indexOf("Apple") === 0;
} catch (err) {
}
function getRenderMode(body, mode) {
  switch (mode) {
    // Force mode
    case "svg":
    case "bg":
    case "mask":
      return mode;
  }
  if (mode !== "style" && (isBuggedSafari || body.indexOf("<a") === -1)) {
    return "svg";
  }
  return body.indexOf("currentColor") === -1 ? "bg" : "mask";
}
var unitsSplit = /(-?[0-9.]*[0-9]+[0-9.]*)/g;
var unitsTest = /^-?[0-9.]*[0-9]+[0-9.]*$/g;
function calculateSize$1(size, ratio, precision) {
  if (ratio === 1) return size;
  precision = precision || 100;
  if (typeof size === "number") return Math.ceil(size * ratio * precision) / precision;
  if (typeof size !== "string") return size;
  const oldParts = size.split(unitsSplit);
  if (oldParts === null || !oldParts.length) return size;
  const newParts = [];
  let code = oldParts.shift();
  let isNumber = unitsTest.test(code);
  while (true) {
    if (isNumber) {
      const num = parseFloat(code);
      if (isNaN(num)) newParts.push(code);
      else newParts.push(Math.ceil(num * ratio * precision) / precision);
    } else newParts.push(code);
    code = oldParts.shift();
    if (code === void 0) return newParts.join("");
    isNumber = !isNumber;
  }
}
function splitSVGDefs(content, tag = "defs") {
  let defs = "";
  const index = content.indexOf("<" + tag);
  while (index >= 0) {
    const start = content.indexOf(">", index);
    const end = content.indexOf("</" + tag);
    if (start === -1 || end === -1) break;
    const endEnd = content.indexOf(">", end);
    if (endEnd === -1) break;
    defs += content.slice(start + 1, end).trim();
    content = content.slice(0, index).trim() + content.slice(endEnd + 1);
  }
  return {
    defs,
    content
  };
}
function mergeDefsAndContent(defs, content) {
  return defs ? "<defs>" + defs + "</defs>" + content : content;
}
function wrapSVGContent(body, start, end) {
  const split = splitSVGDefs(body);
  return mergeDefsAndContent(split.defs, start + split.content + end);
}
var isUnsetKeyword = (value) => value === "unset" || value === "undefined" || value === "none";
function iconToSVG(icon, customisations) {
  const fullIcon = {
    ...defaultIconProps,
    ...icon
  };
  const fullCustomisations = {
    ...defaultIconCustomisations,
    ...customisations
  };
  const box = {
    left: fullIcon.left,
    top: fullIcon.top,
    width: fullIcon.width,
    height: fullIcon.height
  };
  let body = fullIcon.body;
  [fullIcon, fullCustomisations].forEach((props) => {
    const transformations = [];
    const hFlip = props.hFlip;
    const vFlip = props.vFlip;
    let rotation = props.rotate;
    if (hFlip) if (vFlip) rotation += 2;
    else {
      transformations.push("translate(" + (box.width + box.left).toString() + " " + (0 - box.top).toString() + ")");
      transformations.push("scale(-1 1)");
      box.top = box.left = 0;
    }
    else if (vFlip) {
      transformations.push("translate(" + (0 - box.left).toString() + " " + (box.height + box.top).toString() + ")");
      transformations.push("scale(1 -1)");
      box.top = box.left = 0;
    }
    let tempValue;
    if (rotation < 0) rotation -= Math.floor(rotation / 4) * 4;
    rotation = rotation % 4;
    switch (rotation) {
      case 1:
        tempValue = box.height / 2 + box.top;
        transformations.unshift("rotate(90 " + tempValue.toString() + " " + tempValue.toString() + ")");
        break;
      case 2:
        transformations.unshift("rotate(180 " + (box.width / 2 + box.left).toString() + " " + (box.height / 2 + box.top).toString() + ")");
        break;
      case 3:
        tempValue = box.width / 2 + box.left;
        transformations.unshift("rotate(-90 " + tempValue.toString() + " " + tempValue.toString() + ")");
        break;
    }
    if (rotation % 2 === 1) {
      if (box.left !== box.top) {
        tempValue = box.left;
        box.left = box.top;
        box.top = tempValue;
      }
      if (box.width !== box.height) {
        tempValue = box.width;
        box.width = box.height;
        box.height = tempValue;
      }
    }
    if (transformations.length) body = wrapSVGContent(body, '<g transform="' + transformations.join(" ") + '">', "</g>");
  });
  const customisationsWidth = fullCustomisations.width;
  const customisationsHeight = fullCustomisations.height;
  const boxWidth = box.width;
  const boxHeight = box.height;
  let width;
  let height;
  if (customisationsWidth === null) {
    height = customisationsHeight === null ? "1em" : customisationsHeight === "auto" ? boxHeight : customisationsHeight;
    width = calculateSize$1(height, boxWidth / boxHeight);
  } else {
    width = customisationsWidth === "auto" ? boxWidth : customisationsWidth;
    height = customisationsHeight === null ? calculateSize$1(width, boxHeight / boxWidth) : customisationsHeight === "auto" ? boxHeight : customisationsHeight;
  }
  const attributes = {};
  const setAttr = (prop, value) => {
    if (!isUnsetKeyword(value)) attributes[prop] = value.toString();
  };
  setAttr("width", width);
  setAttr("height", height);
  const viewBox = [
    box.left,
    box.top,
    boxWidth,
    boxHeight
  ];
  attributes.viewBox = viewBox.join(" ");
  return {
    attributes,
    viewBox,
    body
  };
}
function iconToHTML$1(body, attributes) {
  let renderAttribsHTML = body.indexOf("xlink:") === -1 ? "" : ' xmlns:xlink="http://www.w3.org/1999/xlink"';
  for (const attr in attributes) renderAttribsHTML += " " + attr + '="' + attributes[attr] + '"';
  return '<svg xmlns="http://www.w3.org/2000/svg"' + renderAttribsHTML + ">" + body + "</svg>";
}
function encodeSVGforURL(svg) {
  return svg.replace(/"/g, "'").replace(/%/g, "%25").replace(/#/g, "%23").replace(/</g, "%3C").replace(/>/g, "%3E").replace(/\s+/g, " ");
}
function svgToData(svg) {
  return "data:image/svg+xml," + encodeSVGforURL(svg);
}
function svgToURL$1(svg) {
  return 'url("' + svgToData(svg) + '")';
}
var detectFetch = () => {
  let callback;
  try {
    callback = fetch;
    if (typeof callback === "function") return callback;
  } catch (err) {
  }
};
var fetchModule = detectFetch();
function setFetch(fetch$1) {
  fetchModule = fetch$1;
}
function getFetch() {
  return fetchModule;
}
function calculateMaxLength(provider, prefix) {
  const config = getAPIConfig(provider);
  if (!config) return 0;
  let result;
  if (!config.maxURL) result = 0;
  else {
    let maxHostLength = 0;
    config.resources.forEach((item) => {
      const host = item;
      maxHostLength = Math.max(maxHostLength, host.length);
    });
    const url = prefix + ".json?icons=";
    result = config.maxURL - maxHostLength - config.path.length - url.length;
  }
  return result;
}
function shouldAbort(status) {
  return status === 404;
}
var prepare = (provider, prefix, icons) => {
  const results = [];
  const maxLength = calculateMaxLength(provider, prefix);
  const type = "icons";
  let item = {
    type,
    provider,
    prefix,
    icons: []
  };
  let length = 0;
  icons.forEach((name, index) => {
    length += name.length + 1;
    if (length >= maxLength && index > 0) {
      results.push(item);
      item = {
        type,
        provider,
        prefix,
        icons: []
      };
      length = name.length;
    }
    item.icons.push(name);
  });
  results.push(item);
  return results;
};
function getPath(provider) {
  if (typeof provider === "string") {
    const config = getAPIConfig(provider);
    if (config) return config.path;
  }
  return "/";
}
var send = (host, params, callback) => {
  if (!fetchModule) {
    callback("abort", 424);
    return;
  }
  let path = getPath(params.provider);
  switch (params.type) {
    case "icons": {
      const prefix = params.prefix;
      const iconsList = params.icons.join(",");
      const urlParams = new URLSearchParams({ icons: iconsList });
      path += prefix + ".json?" + urlParams.toString();
      break;
    }
    case "custom": {
      const uri = params.uri;
      path += uri.slice(0, 1) === "/" ? uri.slice(1) : uri;
      break;
    }
    default:
      callback("abort", 400);
      return;
  }
  let defaultError = 503;
  fetchModule(host + path).then((response) => {
    const status = response.status;
    if (status !== 200) {
      setTimeout(() => {
        callback(shouldAbort(status) ? "abort" : "next", status);
      });
      return;
    }
    defaultError = 501;
    return response.json();
  }).then((data) => {
    if (typeof data !== "object" || data === null) {
      setTimeout(() => {
        if (data === 404) callback("abort", data);
        else callback("next", defaultError);
      });
      return;
    }
    setTimeout(() => {
      callback("success", data);
    });
  }).catch(() => {
    callback("next", defaultError);
  });
};
var fetchAPIModule = {
  prepare,
  send
};
function setCustomIconsLoader$1(loader, prefix, provider) {
  getStorage(provider || "", prefix).loadIcons = loader;
}
function setCustomIconLoader$1(loader, prefix, provider) {
  getStorage(provider || "", prefix).loadIcon = loader;
}
var nodeAttr = "data-style";
var customStyle = "";
function appendCustomStyle(style) {
  customStyle = style;
}
function updateStyle(parent, inline) {
  let styleNode = Array.from(parent.childNodes).find((node) => node.hasAttribute && node.hasAttribute(nodeAttr));
  if (!styleNode) {
    styleNode = document.createElement("style");
    styleNode.setAttribute(nodeAttr, nodeAttr);
    parent.appendChild(styleNode);
  }
  styleNode.textContent = ":host{display:inline-block;vertical-align:" + (inline ? "-0.125em" : "0") + "}span,svg{display:block;margin:auto}" + customStyle;
}
function exportFunctions() {
  setAPIModule("", fetchAPIModule);
  allowSimpleNames(true);
  let _window;
  try {
    _window = window;
  } catch (err) {
  }
  if (_window) {
    if (_window.IconifyPreload !== void 0) {
      const preload = _window.IconifyPreload;
      const err = "Invalid IconifyPreload syntax.";
      if (typeof preload === "object" && preload !== null) {
        (preload instanceof Array ? preload : [preload]).forEach((item) => {
          try {
            if (
              // Check if item is an object and not null/array
              typeof item !== "object" || item === null || item instanceof Array || // Check for 'icons' and 'prefix'
              typeof item.icons !== "object" || typeof item.prefix !== "string" || // Add icon set
              !addCollection$1(item)
            ) {
              console.error(err);
            }
          } catch (e) {
            console.error(err);
          }
        });
      }
    }
    if (_window.IconifyProviders !== void 0) {
      const providers = _window.IconifyProviders;
      if (typeof providers === "object" && providers !== null) {
        for (const key in providers) {
          const err = "IconifyProviders[" + key + "] is invalid.";
          try {
            const value = providers[key];
            if (typeof value !== "object" || !value || value.resources === void 0) {
              continue;
            }
            if (!addAPIProvider$1(key, value)) {
              console.error(err);
            }
          } catch (e) {
            console.error(err);
          }
        }
      }
    }
  }
  const _api2 = {
    getAPIConfig,
    setAPIModule,
    sendAPIQuery,
    setFetch,
    getFetch,
    listAPIProviders
  };
  return {
    iconLoaded: iconLoaded$1,
    getIcon: getIcon$1,
    listIcons: listIcons$1,
    addIcon: addIcon$1,
    addCollection: addCollection$1,
    calculateSize: calculateSize$1,
    buildIcon: iconToSVG,
    iconToHTML: iconToHTML$1,
    svgToURL: svgToURL$1,
    loadIcons: loadIcons$1,
    loadIcon: loadIcon$1,
    addAPIProvider: addAPIProvider$1,
    setCustomIconLoader: setCustomIconLoader$1,
    setCustomIconsLoader: setCustomIconsLoader$1,
    appendCustomStyle,
    _api: _api2
  };
}
var monotoneProps = {
  "background-color": "currentColor"
};
var coloredProps = {
  "background-color": "transparent"
};
var propsToAdd = {
  image: "var(--svg)",
  repeat: "no-repeat",
  size: "100% 100%"
};
var propsToAddTo = {
  "-webkit-mask": monotoneProps,
  "mask": monotoneProps,
  "background": coloredProps
};
for (const prefix in propsToAddTo) {
  const list = propsToAddTo[prefix];
  for (const prop in propsToAdd) {
    list[prefix + "-" + prop] = propsToAdd[prop];
  }
}
function fixSize(value) {
  return value ? value + (value.match(/^[-0-9.]+$/) ? "px" : "") : "inherit";
}
function renderSPAN(data, icon, useMask) {
  const node = document.createElement("span");
  let body = data.body;
  if (body.indexOf("<a") !== -1) {
    body += "<!-- " + Date.now() + " -->";
  }
  const renderAttribs = data.attributes;
  const html = iconToHTML$1(body, {
    ...renderAttribs,
    width: icon.width + "",
    height: icon.height + ""
  });
  const url = svgToURL$1(html);
  const svgStyle = node.style;
  const styles = {
    "--svg": url,
    "width": fixSize(renderAttribs.width),
    "height": fixSize(renderAttribs.height),
    ...useMask ? monotoneProps : coloredProps
  };
  for (const prop in styles) {
    svgStyle.setProperty(prop, styles[prop]);
  }
  return node;
}
var policy;
function createPolicy() {
  try {
    policy = window.trustedTypes.createPolicy("iconify", { createHTML: (s) => s });
  } catch (err) {
    policy = null;
  }
}
function cleanUpInnerHTML(html) {
  if (policy === void 0) createPolicy();
  return policy ? policy.createHTML(html) : html;
}
function renderSVG(data) {
  const node = document.createElement("span");
  const attr = data.attributes;
  let style = "";
  if (!attr.width) {
    style = "width: inherit;";
  }
  if (!attr.height) {
    style += "height: inherit;";
  }
  if (style) {
    attr.style = style;
  }
  const html = iconToHTML$1(data.body, attr);
  node.innerHTML = cleanUpInnerHTML(html);
  return node.firstChild;
}
function findIconElement(parent) {
  return Array.from(parent.childNodes).find((node) => {
    const tag = node.tagName && node.tagName.toUpperCase();
    return tag === "SPAN" || tag === "SVG";
  });
}
function renderIcon(parent, state2) {
  const iconData = state2.icon.data;
  const customisations = state2.customisations;
  const renderData = iconToSVG(iconData, customisations);
  if (customisations.preserveAspectRatio) {
    renderData.attributes["preserveAspectRatio"] = customisations.preserveAspectRatio;
  }
  const mode = state2.renderedMode;
  let node;
  switch (mode) {
    case "svg":
      node = renderSVG(renderData);
      break;
    default:
      node = renderSPAN(renderData, {
        ...defaultIconProps,
        ...iconData
      }, mode === "mask");
  }
  const oldNode = findIconElement(parent);
  if (oldNode) {
    if (node.tagName === "SPAN" && oldNode.tagName === node.tagName) {
      oldNode.setAttribute("style", node.getAttribute("style"));
    } else {
      parent.replaceChild(node, oldNode);
    }
  } else {
    parent.appendChild(node);
  }
}
function setPendingState(icon, inline, lastState) {
  const lastRender = lastState && (lastState.rendered ? lastState : lastState.lastRender);
  return {
    rendered: false,
    inline,
    icon,
    lastRender
  };
}
function defineIconifyIcon(name = "iconify-icon") {
  let customElements;
  let ParentClass;
  try {
    customElements = window.customElements;
    ParentClass = window.HTMLElement;
  } catch (err) {
    return;
  }
  if (!customElements || !ParentClass) {
    return;
  }
  const ConflictingClass = customElements.get(name);
  if (ConflictingClass) {
    return ConflictingClass;
  }
  const attributes = [
    // Icon
    "icon",
    // Mode
    "mode",
    "inline",
    "noobserver",
    // Customisations
    "width",
    "height",
    "rotate",
    "flip"
  ];
  const IconifyIcon = class extends ParentClass {
    // Root
    _shadowRoot;
    // Initialised
    _initialised = false;
    // Icon state
    _state;
    // Attributes check queued
    _checkQueued = false;
    // Connected
    _connected = false;
    // Observer
    _observer = null;
    _visible = true;
    /**
     * Constructor
     */
    constructor() {
      super();
      const root = this._shadowRoot = this.attachShadow({
        mode: "open"
      });
      const inline = this.hasAttribute("inline");
      updateStyle(root, inline);
      this._state = setPendingState({
        value: ""
      }, inline);
      this._queueCheck();
    }
    /**
     * Connected to DOM
     */
    connectedCallback() {
      this._connected = true;
      this.startObserver();
    }
    /**
     * Disconnected from DOM
     */
    disconnectedCallback() {
      this._connected = false;
      this.stopObserver();
    }
    /**
     * Observed attributes
     */
    static get observedAttributes() {
      return attributes.slice(0);
    }
    /**
     * Observed properties that are different from attributes
     *
     * Experimental! Need to test with various frameworks that support it
     */
    /*
    static get properties() {
        return {
            inline: {
                type: Boolean,
                reflect: true,
            },
            // Not listing other attributes because they are strings or combination
            // of string and another type. Cannot have multiple types
        };
    }
    */
    /**
     * Attribute has changed
     */
    attributeChangedCallback(name2) {
      switch (name2) {
        case "inline": {
          const newInline = this.hasAttribute("inline");
          const state2 = this._state;
          if (newInline !== state2.inline) {
            state2.inline = newInline;
            updateStyle(this._shadowRoot, newInline);
          }
          break;
        }
        case "noobserver": {
          const value = this.hasAttribute("noobserver");
          if (value) {
            this.startObserver();
          } else {
            this.stopObserver();
          }
          break;
        }
        default:
          this._queueCheck();
      }
    }
    /**
     * Get/set icon
     */
    get icon() {
      const value = this.getAttribute("icon");
      if (value && value.slice(0, 1) === "{") {
        try {
          return JSON.parse(value);
        } catch (err) {
        }
      }
      return value;
    }
    set icon(value) {
      if (typeof value === "object") {
        value = JSON.stringify(value);
      }
      this.setAttribute("icon", value);
    }
    /**
     * Get/set inline
     */
    get inline() {
      return this.hasAttribute("inline");
    }
    set inline(value) {
      if (value) {
        this.setAttribute("inline", "true");
      } else {
        this.removeAttribute("inline");
      }
    }
    /**
     * Get/set observer
     */
    get observer() {
      return this.hasAttribute("observer");
    }
    set observer(value) {
      if (value) {
        this.setAttribute("observer", "true");
      } else {
        this.removeAttribute("observer");
      }
    }
    /**
     * Restart animation
     */
    restartAnimation() {
      const state2 = this._state;
      if (state2.rendered) {
        const root = this._shadowRoot;
        if (state2.renderedMode === "svg") {
          try {
            root.lastChild.setCurrentTime(0);
            return;
          } catch (err) {
          }
        }
        renderIcon(root, state2);
      }
    }
    /**
     * Get status
     */
    get status() {
      const state2 = this._state;
      return state2.rendered ? "rendered" : state2.icon.data === null ? "failed" : "loading";
    }
    /**
     * Queue attributes re-check
     */
    _queueCheck() {
      if (!this._checkQueued) {
        this._checkQueued = true;
        setTimeout(() => {
          this._check();
        });
      }
    }
    /**
     * Check for changes
     */
    _check() {
      if (!this._checkQueued) {
        return;
      }
      this._checkQueued = false;
      const state2 = this._state;
      const newIcon = this.getAttribute("icon");
      if (newIcon !== state2.icon.value) {
        this._iconChanged(newIcon);
        return;
      }
      if (!state2.rendered || !this._visible) {
        return;
      }
      const mode = this.getAttribute("mode");
      const customisations = getCustomisations(this);
      if (state2.attrMode !== mode || haveCustomisationsChanged(state2.customisations, customisations) || !findIconElement(this._shadowRoot)) {
        this._renderIcon(state2.icon, customisations, mode);
      }
    }
    /**
     * Icon value has changed
     */
    _iconChanged(newValue) {
      const icon = parseIconValue(newValue, (value, name2, data) => {
        const state2 = this._state;
        if (state2.rendered || this.getAttribute("icon") !== value) {
          return;
        }
        const icon2 = {
          value,
          name: name2,
          data
        };
        if (icon2.data) {
          this._gotIconData(icon2);
        } else {
          state2.icon = icon2;
        }
      });
      if (icon.data) {
        this._gotIconData(icon);
      } else {
        this._state = setPendingState(icon, this._state.inline, this._state);
      }
    }
    /**
     * Force render icon on state change
     */
    _forceRender() {
      if (!this._visible) {
        const node = findIconElement(this._shadowRoot);
        if (node) {
          this._shadowRoot.removeChild(node);
        }
        return;
      }
      this._queueCheck();
    }
    /**
     * Got new icon data, icon is ready to (re)render
     */
    _gotIconData(icon) {
      this._checkQueued = false;
      this._renderIcon(icon, getCustomisations(this), this.getAttribute("mode"));
    }
    /**
     * Re-render based on icon data
     */
    _renderIcon(icon, customisations, attrMode) {
      const renderedMode = getRenderMode(icon.data.body, attrMode);
      const inline = this._state.inline;
      renderIcon(this._shadowRoot, this._state = {
        rendered: true,
        icon,
        inline,
        customisations,
        attrMode,
        renderedMode
      });
    }
    /**
     * Start observer
     */
    startObserver() {
      if (!this._observer && !this.hasAttribute("noobserver")) {
        try {
          this._observer = new IntersectionObserver((entries) => {
            const intersecting = entries.some((entry) => entry.isIntersecting);
            if (intersecting !== this._visible) {
              this._visible = intersecting;
              this._forceRender();
            }
          });
          this._observer.observe(this);
        } catch (err) {
          if (this._observer) {
            try {
              this._observer.disconnect();
            } catch (err2) {
            }
            this._observer = null;
          }
        }
      }
    }
    /**
     * Stop observer
     */
    stopObserver() {
      if (this._observer) {
        this._observer.disconnect();
        this._observer = null;
        this._visible = true;
        if (this._connected) {
          this._forceRender();
        }
      }
    }
  };
  attributes.forEach((attr) => {
    if (!(attr in IconifyIcon.prototype)) {
      Object.defineProperty(IconifyIcon.prototype, attr, {
        get: function() {
          return this.getAttribute(attr);
        },
        set: function(value) {
          if (value !== null) {
            this.setAttribute(attr, value);
          } else {
            this.removeAttribute(attr);
          }
        }
      });
    }
  });
  const functions = exportFunctions();
  for (const key in functions) {
    IconifyIcon[key] = IconifyIcon.prototype[key] = functions[key];
  }
  customElements.define(name, IconifyIcon);
  return IconifyIcon;
}
var IconifyIconComponent = defineIconifyIcon() || exportFunctions();
var { iconLoaded, getIcon, listIcons, addIcon, addCollection, calculateSize, buildIcon, iconToHTML, svgToURL, loadIcons, loadIcon, setCustomIconLoader, setCustomIconsLoader, addAPIProvider, _api } = IconifyIconComponent;

// node_modules/@iconify-json/pixelarticons/icons.json
var icons_default = {
  prefix: "pixelarticons",
  icons: {
    "4g": {
      body: '<path fill="currentColor" d="M5 7H3v6h5v4h2V7H8v4H5zm16 0h-9v10h9v-6h-4v2h2v2h-5V9h7z"/>',
      hidden: true
    },
    "4k": {
      body: '<path fill="currentColor" d="M3 7h2v4h4V7h2v10H9v-4H3zm10 0h2v4h2v2h-2v4h-2zm6 8h-2v-2h2zm0 0h2v2h-2zm0-6h-2v2h2zm0 0V7h2v2z"/>',
      hidden: true
    },
    "4k-box": {
      body: '<path fill="currentColor" d="M3 4H1v16h22V4zm18 2v12H3V6zM7 8H5v5h4v3h2V8H9v3H7zm8 0h-2v8h2v-3h2v3h2v-3h-2v-2h2V8h-2v3h-2z"/>',
      hidden: true
    },
    "5g": {
      body: '<path fill="currentColor" d="M10 7H3v6h5v2H3v2h7v-6H5V9h5zm11 0h-9v10h9v-6h-4v2h2v2h-5V9h7z"/>',
      hidden: true
    },
    "a-arrow-down": {
      body: '<g fill="currentColor"><path d="M16 6h2v12h-2zm2 8h2v2h-2zm-4 0h2v2h-2zm4-2h4v2h-4zm-6 0h4v2h-4zM2 8h2v10H2zm6 0h2v10H8z"/><path d="M4 12h6v2H4zm0-6h4v2H4z"/></g>'
    },
    "a-arrow-down-sharp": {
      body: '<g fill="currentColor"><path d="M16 6h2v12h-2zm2 8h2v2h-2zm-4 0h2v2h-2zm4-2h4v2h-4zm-6 0h4v2h-4zM2 8h2v10H2zm6 0h2v10H8z"/><path d="M4 12h6v2H4zM2 6h8v2H2z"/></g>'
    },
    "a-arrow-up": {
      body: '<g fill="currentColor"><path d="M16 18h2V6h-2zm2-8h2V8h-2zm-4 0h2V8h-2zm4 2h4v-2h-4zm-6 0h4v-2h-4zM2 8h2v10H2zm6 0h2v10H8z"/><path d="M4 12h6v2H4zm0-6h4v2H4z"/></g>'
    },
    "a-arrow-up-sharp": {
      body: '<g fill="currentColor"><path d="M16 18h2V6h-2zm2-8h2V8h-2zm-4 0h2V8h-2zm4 2h4v-2h-4zm-6 0h4v-2h-4zM2 8h2v10H2zm6 0h2v10H8z"/><path d="M4 12h6v2H4zM2 6h8v2H2z"/></g>'
    },
    "ab-testing": {
      body: '<path fill="currentColor" d="M3 3h6v2H5v2h4v2H5v2h4v2H3zm6 8h2V9H9zm0-4h2V5H9zm4 4h8v10h-2v-4h-4v4h-2zm2 4h4v-2h-4zm0-12h6v6h-2V5h-4zM3 15h2v4h4v2H3z"/>',
      hidden: true
    },
    ac: {
      body: '<path fill="currentColor" d="M13 2h-2v4H9V4H7v2h2v2h2v3H8V9H6V7H4v2h2v2H2v2h4v2H4v2h2v-2h2v-2h3v3H9v2H7v2h2v-2h2v4h2v-4h2v2h2v-2h-2v-2h-2v-3h3v2h2v2h2v-2h-2v-2h4v-2h-4V9h2V7h-2v2h-2v2h-3V8h2V6h2V4h-2v2h-2z"/>',
      hidden: true
    },
    "add-box": {
      body: '<path fill="currentColor" d="M3 3h18v18H3zm16 16V5H5v14zm-6-8h4v2h-4v4h-2v-4H7v-2h4V7h2z"/>',
      hidden: true
    },
    "add-box-multiple": {
      body: '<path fill="currentColor" d="M3 3h14v14H3zm12 12V5H5v10zm-8 6v-2h12V7h2v14zm4-12h2v2h-2v2H9v-2H7V9h2V7h2z"/>',
      hidden: true
    },
    "add-col": {
      body: '<path fill="currentColor" d="M2 2h10v20H2v-2h8v-4H2v-2h8v-4H2V8h8V4H2zm17 9h3v2h-3v3h-2v-3h-3v-2h3V8h2z"/>',
      hidden: true
    },
    "add-grid": {
      body: '<path fill="currentColor" d="M3 3h8v8H3zm6 6V5H5v4zm9 4h-2v3h-3v2h3v3h2v-3h3v-2h-3zM15 3h6v8h-8V3zm4 6V5h-4v4zM5 13h6v8H3v-8zm4 6v-4H5v4z"/>',
      hidden: true
    },
    "add-row": {
      body: '<path fill="currentColor" d="M4 10V2H2v10h20V2h-2v8h-4V2h-2v8h-4V2H8v8zm9 9v3h-2v-3H8v-2h3v-3h2v3h3v2z"/>',
      hidden: true
    },
    "ai-app-mac": {
      body: '<path fill="currentColor" d="M4 3h16v2H4zm0 16h6v2H4zM2 5h2v14H2zm18 0h2v8h-2zM6 7h2v2H6zm4 0h2v2h-2zm4 0h2v2h-2zm2 6h2v2h-2zm0 8h2v2h-2zm-4-4h2v2h-2zm8 0h2v2h-2zm-6-2h2v2h-2zm4 0h2v2h-2zm0 4h2v2h-2zm-4 0h2v2h-2z"/>'
    },
    "ai-app-mac-sharp": {
      body: '<path fill="currentColor" d="M2 3h20v2H2zm0 16h8v2H2zM2 5h2v14H2zm18 0h2v8h-2zM6 7h2v2H6zm4 0h2v2h-2zm4 0h2v2h-2zm2 6h2v2h-2zm0 8h2v2h-2zm-4-4h2v2h-2zm8 0h2v2h-2zm-6-2h2v2h-2zm4 0h2v2h-2zm0 4h2v2h-2zm-4 0h2v2h-2z"/>'
    },
    "ai-file": {
      body: '<g fill="currentColor"><path d="M6 4H4v8h2zm10-2H6v2h10zm4 4h-2v14h2zm-2 14h-4v2h4zM16 4h2v2h-2zm-4 0h2v6h-2z"/><path d="M12 8h6v2h-6zM2 16h2v6H2zm4 0h2v6H6zm4-2h2v8h-2zm-6 0h2v2H4zm0 4h2v2H4z"/></g>'
    },
    "ai-file-sharp": {
      body: '<g fill="currentColor"><path d="M6 4H4v8h2zm10-2H4v2h12zm4 4h-2v14h2zm0 14h-6v2h6zM16 4h2v2h-2zm-4 0h2v6h-2z"/><path d="M12 8h6v2h-6zM2 16h2v6H2zm4 0h2v6H6zm4-2h2v8h-2zm-8 0h6v2H2zm2 4h2v2H4z"/></g>'
    },
    "ai-scan": {
      body: '<path fill="currentColor" d="M9 11h2v2H9zm4 0h2v2h-2zM7 7h10v2H7zM5 9h2v6H5zm2 6h10v2H7zm10-6h2v6h-2zm-6-4h2v2h-2zM4 2h4v2H4zm0 18h4v2H4zM16 2h4v2h-4zm0 18h4v2h-4zM2 4h2v4H2zm0 12h2v4H2zM20 4h2v4h-2zm0 12h2v4h-2z"/>'
    },
    "ai-scan-sharp": {
      body: '<path fill="currentColor" d="M9 11h2v2H9zm4 0h2v2h-2zM5 7h14v2H5zm0 2h2v6H5zm0 6h14v2H5zm12-6h2v6h-2zm-6-4h2v2h-2zM2 2h6v2H2zm0 18h6v2H2zM16 2h6v2h-6zm0 18h6v2h-6zM2 4h2v4H2zm0 12h2v4H2zM20 4h2v4h-2zm0 12h2v4h-2z"/>'
    },
    "ai-settings-2": {
      body: '<g fill="currentColor"><path d="M18 2h2v2h-2zM4 2h2v2H4zm0 20h2v-2H4zM20 4h2v2h-2zM6 4h4v2H6zm0 16h4v-2H6zM18 6h2v4h-2zM4 6h2v4H4zm0 12h2v-4H4zM14 4h4v2h-4zM2 4h2v2H2zm0 16h2v-2H2z"/><path d="M8 2h2v4H8zm0 20h2v-4H8z"/><path d="M8 2h8v2H8zm0 20h4v-2H8zM2 8h2v8H2zm18 0h2v4h-2zM10 8h4v2h-4zm-2 2h2v4H8zm2 4h4v2h-4zm4-4h2v4h-2zm4 4h2v2h-2zm0 8h2v2h-2zm-4-4h2v2h-2zm8 0h2v2h-2zm-6-2h2v2h-2zm4 0h2v2h-2zm0 4h2v2h-2zm-4 0h2v2h-2z"/></g>'
    },
    "ai-settings-3": {
      body: '<g fill="currentColor"><path d="M4 2h2v2H4zm0 20h2v-2H4zM6 4h4v2H6zm0 16h4v-2H6zM4 6h2v4H4zm0 12h2v-4H4zM2 4h2v2H2zm0 16h2v-2H2z"/><path d="M8 2h2v4H8zm0 20h2v-4H8zM2 8h2v8H2zm8 0h3v2h-3zm4 3h4v2h-4zm2-8h2v2h-2zm-2 2h2v2h-2zm2 14h2v2h-2zm-2-2h2v2h-2zM10 2h3v2h-3zm0 18h3v2h-3zM8 10h2v4H8zm2 4h3v2h-3zm8-5h2v2h-2zm0-8h2v2h-2zm0 16h2v2h-2zm2-6h2v2h-2zm0-8h2v2h-2zm0 16h2v2h-2zm-2-6h2v2h-2zm0-8h2v2h-2zm0 16h2v2h-2z"/></g>'
    },
    "ai-user-circle": {
      body: '<path fill="currentColor" d="M6 2h8v2H6zm0 18h12v2H6zM4 4h2v2H4zM2 6h2v12H2zm20 4h-2v8h2zM4 18h2v2H4zm16 0h-2v2h2zM10 6h4v2h-4zM8 8h2v4H8zm2 4h4v2h-4zm4-4h2v4h-2zm-8 8h12v2H6zM18 2h2v2h-2zm-2 2h2v2h-2zm2 2h2v2h-2zm2-2h2v2h-2z"/>'
    },
    "ai-view": {
      body: '<path fill="currentColor" d="M2 15h2v2H2zm0 4h2v-2H2zm20-4h-2v2h2zm0 4h-2v-2h2zM4 13h4v2H4zm0 8h4v-2H4zm16-8h-4v2h4zm0 8h-4v-2h4zM8 11h8v2H8zm0 12h8v-2H8zm2-8h4v4h-4zm1-6V5h2v4zM3 7V5h2v2zm2 2V7h2v2zm14-2V5h2v2zm-2 2V7h2v2zM9 5V3h2v2zM1 5V3h2v2zm16 0V3h2v2zm-6-2V1h2v2zM3 3V1h2v2zm16 0V1h2v2zm-6 2V3h2v2zM5 5V3h2v2zm16 0V3h2v2z"/>'
    },
    "ai-voice": {
      body: '<path fill="currentColor" d="M4 3h16v2H4zm0 12h6v2H4zM2 5h2v10H2zm18 0h2v8h-2zM5 9h2v2H5zm3-2h2v6H8zm6 0h2v4h-2zm-3 2h2v3h-2zm5 4h2v2h-2zm0 8h2v2h-2zm-4-4h2v2h-2zm8 0h2v2h-2zm-6-2h2v2h-2zm4 0h2v2h-2zm0 4h2v2h-2zm-4 0h2v2h-2z"/>'
    },
    "ai-voice-sharp": {
      body: '<path fill="currentColor" d="M2 3h20v2H2zm0 12h8v2H2zM2 5h2v10H2zm18 0h2v8h-2zM5 9h2v2H5zm3-2h2v6H8zm6 0h2v4h-2zm-3 2h2v3h-2zm5 4h2v2h-2zm0 8h2v2h-2zm-4-4h2v2h-2zm8 0h2v2h-2zm-6-2h2v2h-2zm4 0h2v2h-2zm0 4h2v2h-2zm-4 0h2v2h-2z"/>'
    },
    airplay: {
      body: '<path fill="currentColor" d="M4 3h16v2H4zM2 5h2v12H2zm18 0h2v12h-2zM4 17h2v2H4zm14 0h2v2h-2zm-7-2h2v2h-2zm-2 2h4v2H9zm4 0h2v2h-2zm2 2h2v2h-2zm-8 0h8v2H7z"/>'
    },
    "airplay-sharp": {
      body: '<path fill="currentColor" d="M2 3h20v2H2zm0 2h2v12H2zm18 0h2v12h-2zM2 17h4v2H2zm16 0h4v2h-4zm-7-2h2v2h-2zm-2 2h4v2H9zm4 0h2v2h-2zm2 2h2v2h-2zm-8 0h8v2H7z"/>'
    },
    "alarm-clock": {
      body: '<path fill="currentColor" d="M8 5h8v2H8zm0 14h8v2H8zM6 7h2v2H6zm0 10h2v2H6zM16 7h2v2h-2zm0 10h2v2h-2zM4 9h2v8H4zm14 0h2v8h-2zM4 2h2v2H4zm0 17h2v2H4zm14 0h2v2h-2zm0-17h2v2h-2zM2 4h2v2H2zm18 0h2v2h-2zm-9 5h2v4h-2zm2 4h2v2h-2z"/>'
    },
    album: {
      body: '<g fill="currentColor"><path d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zm-4 0h2v8h-2zm-4 0h2v8h-2z"/><path d="M14 3h2v7h-2z"/></g>'
    },
    "album-sharp": {
      body: '<g fill="currentColor"><path d="M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2zm-4 0h2v8h-2zm-4 0h2v8h-2z"/><path d="M14 3h2v7h-2z"/></g>'
    },
    alert: {
      body: '<path fill="currentColor" d="M13 1h-2v2H9v2H7v2H5v2H3v2H1v2h2v2h2v2h2v2h2v2h2v2h2v-2h2v-2h2v-2h2v-2h2v-2h2v-2h-2V9h-2V7h-2V5h-2V3h-2zm0 2v2h2v2h2v2h2v2h2v2h-2v2h-2v2h-2v2h-2v2h-2v-2H9v-2H7v-2H5v-2H3v-2h2V9h2V7h2V5h2V3zm0 4h-2v6h2zm0 8h-2v2h2z"/>',
      hidden: true
    },
    algorithm: {
      body: '<g fill="currentColor"><path d="M11 16h4v2h-4zm-8 0h4v2H3zm16 0h4v2h-4zM9 16h2v6H9zm-8 0h2v6H1zm16 0h2v6h-2z"/><path d="M9 20h6v2H9zm-8 0h6v2H1zm16 0h6v2h-6z"/><path d="M13 16h2v6h-2zm-8 0h2v6H5zm16 0h2v6h-2zM8 8h8v2H8z"/><path d="M8 2h2v8H8z"/><path d="M8 2h8v2H8z"/><path d="M14 2h2v8h-2zM3 14h2v3H3zm2-2h14v2H5zm14 2h2v3h-2z"/><path d="M11 9h2v9h-2zm5-4h2v2h-2zm-5-5h2v2h-2zM6 5h2v2H6z"/></g>'
    },
    "algorithm-sharp": {
      body: '<g fill="currentColor"><path d="M11 16h4v2h-4zm-8 0h4v2H3zm16 0h4v2h-4zM9 16h2v6H9zm-8 0h2v6H1zm16 0h2v6h-2z"/><path d="M9 20h6v2H9zm-8 0h6v2H1zm16 0h6v2h-6z"/><path d="M13 16h2v6h-2zm-8 0h2v6H5zm16 0h2v6h-2zM8 8h8v2H8z"/><path d="M8 2h2v8H8z"/><path d="M8 2h8v2H8z"/><path d="M14 2h2v8h-2zM3 14h2v3H3zm0-2h18v2H3zm16 2h2v3h-2z"/><path d="M11 9h2v9h-2zm5-4h2v2h-2zm-5-5h2v2h-2zM6 5h2v2H6z"/></g>'
    },
    "align-center": {
      body: '<path fill="currentColor" d="M20 5H4v2h16zm-4 4H8v2h8zM4 13h16v2H4zm12 4H8v2h8z"/>',
      hidden: true
    },
    "align-center-horizontal": {
      body: '<path fill="currentColor" d="M5 2h4v2H5zm10 3h4v2h-4zm0 14h4v-2h-4zM3 15h2v5H3zM3 4h2v5H3zm10 3h2v2h-2zm0 10h2v-2h-2zm-8 3h4v2H5zm4-5h2v5H9zM9 4h2v5H9zm10 3h2v2h-2zm0 10h2v-2h-2zM2 11h20v2H2z"/>'
    },
    "align-center-horizontal-sharp": {
      body: '<path fill="currentColor" d="M3 2h8v2H3zm10 3h8v2h-8zm0 14h8v-2h-8zM3 15h2v5H3zM3 4h2v5H3zm10 3h2v2h-2zm0 10h2v-2h-2zM3 20h8v2H3zm6-5h2v5H9zM9 4h2v5H9zm10 3h2v2h-2zm0 10h2v-2h-2zM2 11h20v2H2z"/>'
    },
    "align-center-vertical": {
      body: '<path fill="currentColor" d="M22 5v4h-2V5zm-3 10v4h-2v-4zM5 15v4h2v-4zM9 3v2H4V3zm11 0v2h-5V3zm-3 10v2h-2v-2zM7 13v2h2v-2zM4 5v4H2V5zm5 4v2H4V9zm11 0v2h-5V9zm-3 10v2h-2v-2zM7 19v2h2v-2zm6-17v20h-2V2z"/>'
    },
    "align-center-vertical-sharp": {
      body: '<path fill="currentColor" d="M22 3v8h-2V3zm-3 10v8h-2v-8zM5 13v8h2v-8zM9 3v2H4V3zm11 0v2h-5V3zm-3 10v2h-2v-2zM7 13v2h2v-2zM4 3v8H2V3zm5 6v2H4V9zm11 0v2h-5V9zm-3 10v2h-2v-2zM7 19v2h2v-2zm6-17v20h-2V2z"/>'
    },
    "align-end-horizontal": {
      body: '<path fill="currentColor" d="M5 2h4v2H5zM3 4h2v12H3zm2 12h4v2H5zM9 4h2v12H9zm6 5h4v2h-4zm-2 2h2v5h-2zm2 5h4v2h-4zm4-5h2v5h-2zM2 20h20v2H2z"/>'
    },
    "align-end-horizontal-sharp": {
      body: '<path fill="currentColor" d="M3 2h8v2H3zm0 2h2v12H3zm0 12h8v2H3zM9 4h2v12H9zm4 5h8v2h-8zm0 2h2v5h-2zm0 5h8v2h-8zm6-5h2v5h-2zM2 20h20v2H2z"/>'
    },
    "align-end-vertical": {
      body: '<path fill="currentColor" d="M2 5v4h2V5zm2-2v2h12V3zm12 2v4h2V5zM4 9v2h12V9zm5 6v4h2v-4zm2-2v2h5v-2zm5 2v4h2v-4zm-5 4v2h5v-2zm9-17v20h2V2z"/>'
    },
    "align-end-vertical-sharp": {
      body: '<path fill="currentColor" d="M2 5v4h2V5zm0-2v2h16V3zm14 2v4h2V5zM2 9v2h16V9zm7 6v4h2v-4zm0-2v2h9v-2zm7 2v4h2v-4zm-7 4v2h9v-2zM20 2v20h2V2z"/>'
    },
    "align-horizontal-distribute-center": {
      body: '<path fill="currentColor" d="M5 8h4V6H5zm10 2h4V8h-4zm-6 6h2V8H9zm10-2h2v-4h-2zM5 18h4v-2H5zm10-2h4v-2h-4zM3 16h2V8H3zm10-2h2v-4h-2zM6 2h2v4H6zm0 16h2v4H6zm10-2h2v6h-2zm0-14h2v6h-2z"/>'
    },
    "align-horizontal-distribute-center-sharp": {
      body: '<path fill="currentColor" d="M5 8h4V6H5zm10 2h4V8h-4zm-6 8h2V6H9zm10-2h2V8h-2zM5 18h4v-2H5zm10-2h4v-2h-4zM3 18h2V6H3zm10-2h2V8h-2zM6 2h2v4H6zm0 16h2v4H6zm10-2h2v6h-2zm0-14h2v6h-2z"/>'
    },
    "align-horizontal-distribute-end": {
      body: '<path fill="currentColor" d="M9 4H6v2h3zm2-2H9v20h2zM9 18H6v2h3zM6 6H4v12h2zm9 1h3v2h-3zm-2 2h2v6h-2zm2 6h3v2h-3zm3-13h2v20h-2z"/>'
    },
    "align-horizontal-distribute-end-sharp": {
      body: '<path fill="currentColor" d="M9 4H6v2h3zm2-2H9v20h2zM9 18H6v2h3zM6 4H4v16h2zm9 3h3v2h-3zm-2 0h2v10h-2zm2 8h3v2h-3zm3-13h2v20h-2z"/>'
    },
    "align-horizontal-distribute-start": {
      body: '<path fill="currentColor" d="M6 4h3v2H6zM4 2h2v20H4zm2 16h3v2H6zM9 6h2v12H9zm9 1h-3v2h3zm2 2h-2v6h2zm-2 6h-3v2h3zM15 2h-2v20h2z"/>'
    },
    "align-horizontal-distribute-start-sharp": {
      body: '<path fill="currentColor" d="M6 4h3v2H6zM4 2h2v20H4zm2 16h3v2H6zM9 4h2v16H9zm9 3h-3v2h3zm2 0h-2v10h2zm-2 8h-3v2h3zM15 2h-2v20h2z"/>'
    },
    "align-horizontal-justify-center": {
      body: '<path fill="currentColor" d="M11 2v20h2V2zM7 4H4v2h3zm2 2H7v12h2zM7 18H4v2h3zM4 6H2v12h2zm13 1h3v2h-3zm-2 2h2v6h-2zm2 6h3v2h-3zm3-6h2v6h-2z"/>'
    },
    "align-horizontal-justify-center-sharp": {
      body: '<path fill="currentColor" d="M11 2v20h2V2zM7 4H4v2h3zm2 0H7v16h2zM7 18H4v2h3zM4 4H2v16h2zm13 3h3v2h-3zm-2 0h2v10h-2zm2 8h3v2h-3zm3-8h2v10h-2z"/>'
    },
    "align-horizontal-justify-end": {
      body: '<path fill="currentColor" d="M20 2v20h2V2zM7 4H4v2h3zm2 2H7v12h2zM7 18H4v2h3zM4 6H2v12h2zm9 1h3v2h-3zm-2 2h2v6h-2zm2 6h3v2h-3zm3-6h2v6h-2z"/>'
    },
    "align-horizontal-justify-end-sharp": {
      body: '<path fill="currentColor" d="M20 2v20h2V2zM7 4H4v2h3zm2 0H7v16h2zM7 18H4v2h3zM4 4H2v16h2zm9 3h3v2h-3zm-2 0h2v10h-2zm2 8h3v2h-3zm3-8h2v10h-2z"/>'
    },
    "align-horizontal-justify-start": {
      body: '<path fill="currentColor" d="M4 2v20H2V2zm4 2h3v2H8zM6 6h2v12H6zm2 12h3v2H8zm3-12h2v12h-2zm6 1h3v2h-3zm-2 2h2v6h-2zm2 6h3v2h-3zm3-6h2v6h-2z"/>'
    },
    "align-horizontal-justify-start-sharp": {
      body: '<path fill="currentColor" d="M4 2v20H2V2zm4 2h3v2H8zM6 4h2v16H6zm2 14h3v2H8zm3-14h2v16h-2zm6 3h3v2h-3zm-2 0h2v10h-2zm2 8h3v2h-3zm3-8h2v10h-2z"/>'
    },
    "align-horizontal-space-around": {
      body: '<path fill="currentColor" d="M10 6h4v2h-4zM8 8h2v8H8zm2 8h4v2h-4zm4-8h2v8h-2zM4 2v20h2V2zm14 0v20h2V2z"/>'
    },
    "align-horizontal-space-around-sharp": {
      body: '<path fill="currentColor" d="M10 6h4v2h-4zM8 6h2v12H8zm2 10h4v2h-4zm4-10h2v12h-2zM4 2v20h2V2zm14 0v20h2V2z"/>'
    },
    "align-horizontal-space-between": {
      body: '<path fill="currentColor" d="M5 4h3v2H5zM3 2h2v20H3zm2 16h3v2H5zM8 6h2v12H8zm8 1h3v2h-3zm-2 2h2v6h-2zm2 6h3v2h-3zm3-13h2v20h-2z"/>'
    },
    "align-horizontal-space-between-sharp": {
      body: '<path fill="currentColor" d="M5 4h3v2H5zM3 2h2v20H3zm2 16h3v2H5zM8 4h2v16H8zm8 3h3v2h-3zm-2 0h2v10h-2zm2 8h3v2h-3zm3-13h2v20h-2z"/>'
    },
    "align-justify": {
      body: '<path fill="currentColor" d="M20 5H4v2h16zm0 4H4v2h16zM4 13h16v2H4zm16 4H4v2h16z"/>',
      hidden: true
    },
    "align-left": {
      body: '<path fill="currentColor" d="M20 5H4v2h16zm-8 4H4v2h8zm8 4v2H4v-2zm-8 4H4v2h8z"/>',
      hidden: true
    },
    "align-right": {
      body: '<path fill="currentColor" d="M4 5h16v2H4zm8 4h8v2h-8zm-8 4v2h16v-2zm8 4h8v2h-8z"/>',
      hidden: true
    },
    "align-start-horizontal": {
      body: '<path fill="currentColor" d="M5 22h4v-2H5zm-2-2h2V8H3zM5 8h4V6H5zm4 12h2V8H9zm6-5h4v-2h-4zm-2-2h2V8h-2zm2-5h4V6h-4zm4 5h2V8h-2zM2 4h20V2H2z"/>'
    },
    "align-start-horizontal-sharp": {
      body: '<path fill="currentColor" d="M5 22h4v-2H5zm-2 0h2V6H3zM5 8h4V6H5zm4 14h2V6H9zm6-7h4v-2h-4zm-2 0h2V6h-2zm2-7h4V6h-4zm4 7h2V6h-2zM2 4h20V2H2z"/>'
    },
    "align-start-vertical": {
      body: '<path fill="currentColor" d="M22 5v4h-2V5zm-2-2v2H8V3zM8 5v4H6V5zm12 4v2H8V9zm-5 6v4h-2v-4zm-2-2v2H8v-2zm-5 2v4H6v-4zm5 4v2H8v-2zM4 2v20H2V2z"/>'
    },
    "align-start-vertical-sharp": {
      body: '<path fill="currentColor" d="M22 5v4h-2V5zm0-2v2H6V3zM8 5v4H6V5zm14 4v2H6V9zm-7 6v4h-2v-4zm0-2v2H6v-2zm-7 2v4H6v-4zm7 4v2H6v-2zM4 2v20H2V2z"/>'
    },
    "align-vertical-distribute-center": {
      body: '<path fill="currentColor" d="M8 19v-4H6v4zm2-10V5H8v4zm6 6v-2H8v2zM14 5V3h-4v2zm4 14v-4h-2v4zM16 9V5h-2v4zm0 12v-2H8v2zm-2-10V9h-4v2zM2 18v-2h4v2zm16 0v-2h4v2zM16 8V6h6v2zM2 8V6h6v2z"/>'
    },
    "align-vertical-distribute-center-sharp": {
      body: '<path fill="currentColor" d="M8 19v-4H6v4zm2-10V5H8v4zm8 6v-2H6v2zM16 5V3H8v2zm2 14v-4h-2v4zM16 9V5h-2v4zm2 12v-2H6v2zm-2-10V9H8v2zM2 18v-2h4v2zm16 0v-2h4v2zM16 8V6h6v2zM2 8V6h6v2z"/>'
    },
    "align-vertical-distribute-end": {
      body: '<path fill="currentColor" d="M4 18v-3h2v3zm-2 2v-2h20v2zm16-2v-3h2v3zM6 15v-2h12v2zm1-9v3h2V6zm2-2v2h6V4zm6 2v3h2V6zM2 9v2h20V9z"/>'
    },
    "align-vertical-distribute-end-sharp": {
      body: '<path fill="currentColor" d="M4 18v-3h2v3zm-2 2v-2h20v2zm16-2v-3h2v3zM4 15v-2h16v2zm3-9v3h2V6zm0-2v2h10V4zm8 2v3h2V6zM2 9v2h20V9z"/>'
    },
    "align-vertical-distribute-start": {
      body: '<path fill="currentColor" d="M4 6v3h2V6zM2 4v2h20V4zm16 2v3h2V6zM6 9v2h12V9zm1 9v-3h2v3zm2 2v-2h6v2zm6-2v-3h2v3zM2 15v-2h20v2z"/>'
    },
    "align-vertical-distribute-start-sharp": {
      body: '<path fill="currentColor" d="M4 6v3h2V6zM2 4v2h20V4zm16 2v3h2V6zM4 9v2h16V9zm3 9v-3h2v3zm0 2v-2h10v2zm8-2v-3h2v3zM2 15v-2h20v2z"/>'
    },
    "align-vertical-justify-center": {
      body: '<path fill="currentColor" d="M2 13h20v-2H2zm2 4v3h2v-3zm2-2v2h12v-2zm12 2v3h2v-3zM6 20v2h12v-2zM7 7V4h2v3zm2 2V7h6v2zm6-2V4h2v3zM9 4V2h6v2z"/>'
    },
    "align-vertical-justify-center-sharp": {
      body: '<path fill="currentColor" d="M2 13h20v-2H2zm2 4v3h2v-3zm0-2v2h16v-2zm14 2v3h2v-3zM4 20v2h16v-2zM7 7V4h2v3zm0 2V7h10v2zm8-2V4h2v3zM7 4V2h10v2z"/>'
    },
    "align-vertical-justify-end": {
      body: '<path fill="currentColor" d="M2 20h20v2H2zm2-4v-3h2v3zm2 2v-2h12v2zm12-2v-3h2v3zM6 13v-2h12v2zm1-6V4h2v3zm2 2V7h6v2zm6-2V4h2v3zM9 4V2h6v2z"/>'
    },
    "align-vertical-justify-end-sharp": {
      body: '<path fill="currentColor" d="M2 20h20v2H2zm2-4v-3h2v3zm0 2v-2h16v2zm14-2v-3h2v3zM4 13v-2h16v2zm3-6V4h2v3zm0 2V7h10v2zm8-2V4h2v3zM7 4V2h10v2z"/>'
    },
    "align-vertical-justify-start": {
      body: '<path fill="currentColor" d="M2 4h20V2H2zm5 4v3h2V8zm2-2v2h6V6zm6 2v3h2V8zm-6 3v2h6v-2zm-5 6v3h2v-3zm2-2v2h12v-2zm12 2v3h2v-3zM6 20v2h12v-2z"/>'
    },
    "align-vertical-justify-start-sharp": {
      body: '<path fill="currentColor" d="M2 4h20V2H2zm5 4v3h2V8zm0-2v2h10V6zm8 2v3h2V8zm-8 3v2h10v-2zm-3 6v3h2v-3zm0-2v2h16v-2zm14 2v3h2v-3zM4 20v2h16v-2z"/>'
    },
    "align-vertical-space-around": {
      body: '<path fill="currentColor" d="M18 10v4h-2v-4zm-2-2v2H8V8zm-8 2v4H6v-4zm8 4v2H8v-2zm6-10H2v2h20zm0 14H2v2h20z"/>'
    },
    "align-vertical-space-around-sharp": {
      body: '<path fill="currentColor" d="M18 10v4h-2v-4zm0-2v2H6V8zM8 10v4H6v-4zm10 4v2H6v-2zm4-10H2v2h20zm0 14H2v2h20z"/>'
    },
    "align-vertical-space-between": {
      body: '<path fill="currentColor" d="M4 19v-3h2v3zm-2 2v-2h20v2zm16-2v-3h2v3zM6 16v-2h12v2zm1-8V5h2v3zm2 2V8h6v2zm6-2V5h2v3zM2 5V3h20v2z"/>'
    },
    "align-vertical-space-between-sharp": {
      body: '<path fill="currentColor" d="M4 19v-3h2v3zm-2 2v-2h20v2zm16-2v-3h2v3zM4 16v-2h16v2zm3-8V5h2v3zm0 2V8h10v2zm8-2V5h2v3zM2 5V3h20v2z"/>'
    },
    ampersand: {
      body: '<path fill="currentColor" d="M15 11h6v2h-6zm2 2h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2h-2zm-8 2h8v2H5zm-2-6h2v6H3zm2-2h4v2H5zm4-2h4v2H9zm4-4h2v4h-2zM7 3h6v2H7zM5 5h2v4H5zm4 8h2v2H9zM7 9h2v2H7zm4 6h2v2h-2zm4 4h4v2h-4z"/>'
    },
    "ampersand-sharp": {
      body: '<path fill="currentColor" d="M15 11h6v2h-6zm2 2h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2h-2zm-8 2h8v2H5zm-2-8h2v10H3zm2 0h4v2H5zm4-2h4v2H9zm4-4h2v4h-2zM5 3h10v2H5zm0 2h2v4H5zm4 8h2v2H9zM7 9h2v2H7zm4 6h2v2h-2zm4 4h4v2h-4z"/>'
    },
    analytics: {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zm-9 8h2v6h-2zm-4 2h2v4H7zm8-8h2v12h-2z"/>'
    },
    "analytics-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2zm-9 8h2v6h-2zm-4 2h2v4H7zm8-8h2v12h-2z"/>'
    },
    anchor: {
      body: '<g fill="currentColor"><path d="M10 2h4v2h-4zm0 6h4v2h-4zM8 4h2v4H8zm6 0h2v4h-2z"/><path d="M11 9h2v12h-2z"/><path d="M5 20h14v2H5zm-2-8h2v8H3zm16 0h2v8h-2zM5 12h2v2H5zm12 0h2v2h-2z"/></g>'
    },
    "anchor-sharp": {
      body: '<g fill="currentColor"><path d="M8 2h8v2H8zm0 6h8v2H8zm0-4h2v4H8zm6 0h2v4h-2z"/><path d="M11 9h2v12h-2z"/><path d="M5 20h14v2H5zm-2-8h2v10H3zm16 0h2v10h-2zM5 12h2v2H5zm12 0h2v2h-2z"/></g>'
    },
    android: {
      body: '<path fill="currentColor" d="M2 5h2v2H2zm4 4H4V7h2zm2 0H6v2H4v2H2v6h20v-6h-2v-2h-2V9h2V7h2V5h-2v2h-2v2h-2V7H8zm0 0h8v2h2v2h2v4H4v-4h2v-2h2zm2 4H8v2h2zm4 0h2v2h-2z"/>',
      hidden: true
    },
    angry: {
      body: '<path fill="currentColor" d="M6 20h12v2H6zM6 2h12v2H6zm12 2h2v2h-2zM4 4h2v2H4zm0 14h2v2H4zm14 0h2v2h-2zM2 6h2v12H2zm18 0h2v12h-2zM7 7h2v2H7zm2 2h2v2H9zm6-2h2v2h-2zm-2 2h2v2h-2zm-6 6h2v2H7zm2-2h6v2H9zm6 2h2v2h-2z"/>'
    },
    "angry-sharp": {
      body: '<g fill="currentColor"><path d="M2 20h20v2H2zM2 2h20v2H2z"/><path d="M2 2h2v20H2zm18 0h2v20h-2zM7 7h2v2H7zm2 2h2v2H9zm6-2h2v2h-2zm-2 2h2v2h-2zm-6 6h2v2H7zm2-2h6v2H9zm6 2h2v2h-2z"/></g>'
    },
    animation: {
      body: '<path fill="currentColor" d="M4 2H2v12h2V4h10V2zm2 4h12v2H8v10H6zm4 4h12v12H10zm10 10v-8h-8v8z"/>',
      hidden: true
    },
    annoyed: {
      body: '<path fill="currentColor" d="M6 20h12v2H6zM6 2h12v2H6zm12 2h2v2h-2zM4 4h2v2H4zm0 14h2v2H4zm14 0h2v2h-2zM2 6h2v12H2zm18 0h2v12h-2zM7 8h3v2H7zm7 0h3v2h-3zm-7 6h10v2H7z"/>'
    },
    "annoyed-sharp": {
      body: '<path fill="currentColor" d="M2 20h20v2H2zM2 2h20v2H2zm0 2h2v16H2zm18 0h2v16h-2zM7 8h3v2H7zm7 0h3v2h-3zm-7 6h10v2H7z"/>'
    },
    "app-mac": {
      body: '<path fill="currentColor" d="M4 3h16v2H4zm0 16h16v2H4zM2 5h2v14H2zm18 0h2v14h-2zM6 7h2v2H6zm4 0h2v2h-2zm4 0h2v2h-2z"/>'
    },
    "app-mac-sharp": {
      body: '<path fill="currentColor" d="M2 3h20v2H2zm0 16h20v2H2zM2 5h2v14H2zm18 0h2v14h-2zM6 7h2v2H6zm4 0h2v2h-2zm4 0h2v2h-2z"/>'
    },
    "app-windows": {
      body: '<path fill="currentColor" d="M4 3h16v2H4zm0 16h16v2H4zM2 5h2v14H2zm18 0h2v14h-2zM4 7h16v2H4zm8-2h2v2h-2zm4 0h2v2h-2z"/>'
    },
    "app-windows-sharp": {
      body: '<path fill="currentColor" d="M2 3h20v2H2zm0 16h20v2H2zM2 5h2v14H2zm18 0h2v14h-2zM4 7h16v2H4zm8-2h2v2h-2zm4 0h2v2h-2z"/>'
    },
    archive: {
      body: '<path fill="currentColor" d="M3 2h18v2H3zm0 5h18v2H3zM1 4h2v3H1zm20 0h2v3h-2zm-2 5h2v11h-2zM3 9h2v11H3zm2 11h14v2H5zm4-9h6v2H9z"/>'
    },
    "archive-sharp": {
      body: '<path fill="currentColor" d="M1 2h22v2H1zm0 5h22v2H1zm0-3h2v3H1zm20 0h2v3h-2zm-2 5h2v11h-2zM3 9h2v11H3zm0 11h18v2H3zm6-9h6v2H9z"/>'
    },
    "arrow-bar-down": {
      body: '<path fill="currentColor" d="M4 20h16v2H4zm7-18h2v16h-2zm2 12h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm-8 4h2v2H9zm-2-2h2v2H7zm-2-2h2v2H5z"/>'
    },
    "arrow-bar-left": {
      body: '<path fill="currentColor" d="M4 4v16H2V4zm18 7v2H6v-2zm-12 2v2H8v-2zm2 2v2h-2v-2zm2 2v2h-2v-2zm-4-8v2H8V9zm2-2v2h-2V7zm2-2v2h-2V5z"/>'
    },
    "arrow-bar-right": {
      body: '<path fill="currentColor" d="M20 4v16h2V4zM2 11v2h16v-2zm12 2v2h2v-2zm-2 2v2h2v-2zm-2 2v2h2v-2zm4-8v2h2V9zm-2-2v2h2V7zm-2-2v2h2V5z"/>'
    },
    "arrow-bar-up": {
      body: '<path fill="currentColor" d="M4 4h16V2H4zm7 18h2V6h-2zm2-12h2V8h-2zm2 2h2v-2h-2zm2 2h2v-2h-2zm-8-4h2V8H9zm-2 2h2v-2H7zm-2 2h2v-2H5z"/>'
    },
    "arrow-big-down": {
      body: '<path fill="currentColor" d="M8 3h8v2H8zm0 2h2v6H8zm-5 6h5v2H3zm0 2h2v2H3zm2 2h2v2H5zm2 2h2v2H7zm2 2h2v2H9zm2 2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm2-4h2v4h-2zm-3 0h3v2h-3zm-2-6h2v6h-2z"/>'
    },
    "arrow-big-down-dash": {
      body: '<g fill="currentColor"><path d="M8 3h8v2H8zm0 4h8v2H8z"/><path d="M8 7h2v4H8zm-5 4h5v2H3zm0 2h2v2H3zm2 2h2v2H5zm2 2h2v2H7zm2 2h2v2H9zm2 2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm2-4h2v4h-2zm-3 0h3v2h-3zm-2-4h2v4h-2z"/></g>'
    },
    "arrow-big-down-dash-sharp": {
      body: '<g fill="currentColor"><path d="M8 3h8v2H8zm0 4h8v2H8z"/><path d="M8 7h2v6H8zm-5 4h5v2H3zm0 2h2v2H3zm2 2h2v2H5zm2 2h2v2H7zm2 2h2v2H9zm2 2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm2-4h2v4h-2zm-3 0h3v2h-3zm-2-4h2v6h-2z"/></g>'
    },
    "arrow-big-down-sharp": {
      body: '<path fill="currentColor" d="M8 3h8v2H8zm0 2h2v8H8zm-5 6h5v2H3zm0 2h2v2H3zm2 2h2v2H5zm2 2h2v2H7zm2 2h2v2H9zm2 2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm2-4h2v4h-2zm-3 0h3v2h-3zm-2-6h2v8h-2z"/>'
    },
    "arrow-big-up": {
      body: '<path fill="currentColor" d="M8 21h8v-2H8zm0-2h2v-6H8zm-5-6h5v-2H3zm0-2h2V9H3zm2-2h2V7H5zm2-2h2V5H7zm2-2h2V3H9zm2-2h2V1h-2zm2 2h2V3h-2zm2 2h2V5h-2zm2 2h2V7h-2zm2 4h2V9h-2zm-3 0h3v-2h-3zm-2 6h2v-6h-2z"/>'
    },
    "arrow-big-up-dash": {
      body: '<g fill="currentColor"><path d="M8 21h8v-2H8zm0-4h8v-2H8z"/><path d="M8 17h2v-4H8zm-5-4h5v-2H3zm0-2h2V9H3zm2-2h2V7H5zm2-2h2V5H7zm2-2h2V3H9zm2-2h2V1h-2zm2 2h2V3h-2zm2 2h2V5h-2zm2 2h2V7h-2zm2 4h2V9h-2zm-3 0h3v-2h-3zm-2 4h2v-4h-2z"/></g>'
    },
    "arrow-big-up-dash-sharp": {
      body: '<g fill="currentColor"><path d="M8 21h8v-2H8zm0-4h8v-2H8z"/><path d="M8 17h2v-6H8zm-5-4h5v-2H3zm0-2h2V9H3zm2-2h2V7H5zm2-2h2V5H7zm2-2h2V3H9zm2-2h2V1h-2zm2 2h2V3h-2zm2 2h2V5h-2zm2 2h2V7h-2zm2 4h2V9h-2zm-3 0h3v-2h-3zm-2 4h2v-6h-2z"/></g>'
    },
    "arrow-big-up-sharp": {
      body: '<path fill="currentColor" d="M8 21h8v-2H8zm0-2h2v-8H8zm-5-6h5v-2H3zm0-2h2V9H3zm2-2h2V7H5zm2-2h2V5H7zm2-2h2V3H9zm2-2h2V1h-2zm2 2h2V3h-2zm2 2h2V5h-2zm2 2h2V7h-2zm2 4h2V9h-2zm-3 0h3v-2h-3zm-2 6h2v-8h-2z"/>'
    },
    "arrow-down": {
      body: '<path fill="currentColor" d="M13 12h6v2h-2v2h-2v2h-2v2h-2v-2H9v-2H7v-2H5v-2h6V4h2z"/>'
    },
    "arrow-down-box": {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zm-9 12h2v2h-2zm0-10h2v6h-2zm-2 8h6v2H9zm-2-2h10v2H7z"/>'
    },
    "arrow-down-box-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2zm-9 12h2v2h-2zm0-10h2v6h-2zm-2 8h6v2H9zm-2-2h10v2H7z"/>'
    },
    "arrow-down-circle": {
      body: '<path fill="currentColor" d="M11 16h2v2h-2zm0-10h2v6h-2zm-2 8h6v2H9zm-2-2h10v2H7zm11 6h2v2h-2zm0-14h2v2h-2zM4 4h2v2H4zm0 14h2v2H4zM6 2h12v2H6zm0 18h12v2H6zM2 6h2v12H2zm18 0h2v12h-2z"/>'
    },
    "arrow-down-diamond": {
      body: '<path fill="currentColor" d="M11 16h2v2h-2zm0-10h2v6h-2zm-2 8h6v2H9zm-2-2h10v2H7zm4-11h2v2h-2zm2 2h2v2h-2zm-2 0H9v2h2zm4 2h2v2h-2zM9 5H7v2h2zm8 2h2v2h-2zM7 7H5v2h2zm12 2h2v2h-2zM5 9H3v2h2zm16 2h2v2h-2zM3 11H1v2h2zm16 2h2v2h-2zM5 13H3v2h2zm12 2h2v2h-2zM7 15H5v2h2zm8 2h2v2h-2zm-6 0H7v2h2zm4 2h2v2h-2zm-2 0H9v2h2zm0 2h2v2h-2z"/>'
    },
    "arrow-down-narrow-wide": {
      body: '<g fill="currentColor"><path d="M6 3h2v18H6z"/><path d="M4 17h6v2H4zm-2-2h10v2H2zm8-12h6v2h-6zm0 4h9v2h-9zm0 4h12v2H10z"/></g>'
    },
    "arrow-down-wide-narrow": {
      body: '<g fill="currentColor"><path d="M6 3h2v18H6z"/><path d="M4 17h6v2H4zm-2-2h10v2H2zm8-2h6v-2h-6zm0-4h9V7h-9zm0-4h12V3H10z"/></g>'
    },
    "arrow-down-z-a": {
      body: '<g fill="currentColor"><path d="M14 3h7v2h-7zm0 6h7v2h-7zm2-2h2v2h-2zm2-2h2v2h-2zM6 3h2v18H6z"/><path d="M4 17h6v2H4zm-2-2h10v2H2zm12 0h2v6h-2zm2-2h3v2h-3zm3 2h2v6h-2zm-3 2h3v2h-3z"/></g>'
    },
    "arrow-down-z-a-sharp": {
      body: '<g fill="currentColor"><path d="M14 3h7v2h-7zm0 6h7v2h-7zm2-2h2v2h-2zm2-2h2v2h-2zM6 3h2v18H6z"/><path d="M4 17h6v2H4zm-2-2h10v2H2zm12 0h2v6h-2zm0-2h7v2h-7zm5 2h2v6h-2zm-3 2h3v2h-3z"/></g>'
    },
    "arrow-left": {
      body: '<g fill="currentColor"><path d="M20 11v2H4v-2zM8 13v2H6v-2zm2 2v2H8v-2zm2 2v2h-2v-2zm-4-6V9H6v2z"/><path d="M10 15V7H8v8zm2 2V5h-2v12z"/></g>'
    },
    "arrow-left-box": {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zM8.067 11.009v2h-2v-2zm10 0v2h-6v-2zm-8-2v6h-2v-6zm2-2v10h-2v-10z"/>'
    },
    "arrow-left-box-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2zM8.067 11.009v2h-2v-2zm10 0v2h-6v-2zm-8-2v6h-2v-6zm2-2v10h-2v-10z"/>'
    },
    "arrow-right": {
      body: '<g fill="currentColor"><path d="M4 11v2h16v-2zm12 2v2h2v-2zm-2 2v2h2v-2zm-2 2v2h2v-2zm4-6V9h2v2z"/><path d="M14 15V7h2v8zm-2 2V5h2v12z"/></g>'
    },
    "arrow-right-box": {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zm-3.933 7.009v2h2v-2zm-10 0v2h6v-2zm8-2v6h2v-6zm-2-2v10h2v-10z"/>'
    },
    "arrow-right-box-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2zm-3.933 7.009v2h2v-2zm-10 0v2h6v-2zm8-2v6h2v-6zm-2-2v10h2v-10z"/>'
    },
    "arrow-up": {
      body: '<g fill="currentColor"><path d="M11 20h2V4h-2zm2-12h2V6h-2zm2 2h2V8h-2zm2 2h2v-2h-2zm-6-4H9V6h2z"/><path d="M15 10H7V8h8zm2 2H5v-2h12z"/></g>'
    },
    "arrow-up-box": {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zm-8.933 4.009h2v-2h-2zm0 10h2v-6h-2zm-2-8h6v-2h-6zm-2 2h10v-2h-10z"/>'
    },
    "arrow-up-box-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2zm-8.933 4.009h2v-2h-2zm0 10h2v-6h-2zm-2-8h6v-2h-6zm-2 2h10v-2h-10z"/>'
    },
    "arrow-up-narrow-wide": {
      body: '<g fill="currentColor"><path d="M6 21h2V3H6z"/><path d="M4 7h6V5H4zM2 9h10V7H2zm8 2h6v2h-6zm0 4h9v2h-9zm0 4h12v2H10z"/></g>'
    },
    "arrow-up-wide-narrow": {
      body: '<g fill="currentColor"><path d="M6 21h2V3H6z"/><path d="M4 7h6V5H4zM2 9h10V7H2zm8 12h6v-2h-6zm0-4h9v-2h-9zm0-4h12v-2H10z"/></g>'
    },
    "arrow-up-z-a": {
      body: '<g fill="currentColor"><path d="M14 9h7v2h-7zm0-6h7v2h-7zm2 4h2v2h-2zm2-2h2v2h-2zM6 21h2V3H6z"/><path d="M4 7h6V5H4zM2 9h10V7H2zm12 6h2v6h-2zm2-2h3v2h-3zm3 2h2v6h-2zm-3 2h3v2h-3z"/></g>'
    },
    "arrow-up-z-a-sharp": {
      body: '<g fill="currentColor"><path d="M14 9h7v2h-7zm0-6h7v2h-7zm2 4h2v2h-2zm2-2h2v2h-2zM6 21h2V3H6z"/><path d="M4 7h6V5H4zM2 9h10V7H2zm12 6h2v6h-2zm0-2h7v2h-7zm5 2h2v6h-2zm-3 2h3v2h-3z"/></g>'
    },
    "arrows-horizontal": {
      body: '<g fill="currentColor"><path d="M13 13v-2h10v2zm6 2v-2h2v2zm-2 2v-2h2v2zm2-6V9h2v2z"/><path d="M17 15V7h2v8zm-6-2v-2H1v2zm-6 2v-2H3v2zm2 2v-2H5v2zm-2-6V9H3v2z"/><path d="M7 15V7H5v8z"/></g>'
    },
    "arrows-vertical": {
      body: '<g fill="currentColor"><path d="M13 11h-2V1h2zm2-6h-2V3h2zm2 2h-2V5h2zm-6-2H9V3h2z"/><path d="M15 7H7V5h8zm-2 6h-2v10h2zm2 6h-2v2h2zm2-2h-2v2h2zm-6 2H9v2h2z"/><path d="M15 17H7v2h8z"/></g>'
    },
    "art-text": {
      body: '<path fill="currentColor" d="M2 7h10v10H2zm8 8V9H4v6zm12-8h-8v2h8zm-8 4h8v2h-8zm8 4h-8v2h8z"/>',
      hidden: true
    },
    article: {
      body: '<path fill="currentColor" d="M8 2h12v2H8zM6 4h2v16H6zm14 0h2v16h-2zM4 20h16v2H4zm-2-9h2v9H2zm2-2h2v2H4zm6-3h8v2h-8zm0 4h8v2h-8zm0-2h2v2h-2zm6 0h2v2h-2zm-6 5h8v2h-8zm0 3h4v2h-4z"/>'
    },
    "article-multiple": {
      body: '<path fill="currentColor" d="M3 1H1v18h18V1zm14 2v14H3V3zm4 18H5v2h18V5h-2zM15 5H5v2h10zM5 9h10v2H5zm7 4H5v2h7z"/>',
      hidden: true
    },
    "article-sharp": {
      body: '<path fill="currentColor" d="M6 2h16v2H6zm0 2h2v16H6zm14 0h2v16h-2zM2 20h20v2H2zm0-9h2v9H2zm0-2h4v2H2zm8-3h8v2h-8zm0 4h8v2h-8zm0-2h2v2h-2zm6 0h2v2h-2zm-6 5h8v2h-8zm0 3h4v2h-4z"/>'
    },
    "aspect-ratio": {
      body: '<path fill="currentColor" d="M4 4h16v2H4zM2 6h2v12H2zm2 12h16v2H4zM20 6h2v12h-2zM6 8h4v2H6zm8 6h4v2h-4zm-8-4h2v2H6zm10 2h2v2h-2z"/>'
    },
    "aspect-ratio-sharp": {
      body: '<path fill="currentColor" d="M2 4h20v2H2zm0 2h2v12H2zm0 12h20v2H2zM20 6h2v12h-2zM6 8h4v2H6zm8 6h4v2h-4zm-8-4h2v2H6zm10 2h2v2h-2z"/>'
    },
    at: {
      body: '<path fill="currentColor" d="M4 4h16v12H8V8h8v6h2V6H6v12h14v2H4zm10 10v-4h-4v4z"/>',
      hidden: true
    },
    "at-sign": {
      body: '<g fill="currentColor"><path d="M9 8h6v2H9zm0 6h8v2H9zm-2 0v-4h2v4z"/><path d="M13 14V8h2v6zm4-8h2v8h-2zM7 4h10v2H7zM3 8h2v8H3zm4 10h12v2H7zm-2-2h2v2H5zm14 0h2v2h-2zM5 6h2v2H5z"/></g>'
    },
    "at-sign-sharp": {
      body: '<g fill="currentColor"><path d="M9 8h6v2H9zm0 6h8v2H9zm-2 2V8h2v8z"/><path d="M13 14V8h2v6zm4-10h2v12h-2zM3 4h14v2H3zm0 2h2v12H3zm0 12h16v2H3z"/></g>'
    },
    attachment: {
      body: '<path fill="currentColor" d="M7 7v10H5V7zm12 0v12h-2V7zm-8 2v10H9V9zm4 0v8h-2V9zm0-6v2H9V3zm-2 4v2h-2V7zm4 12v2h-6v-2zm0-14v2h-2V5zM9 5v2H7V5z"/>'
    },
    "attachment-sharp": {
      body: '<path fill="currentColor" d="M7 3v14H5V3zm12 0v16h-2V3zm-8 6v10H9V9zm4 0v8h-2V9zm2-6v2H7V3zm-2 4v2H9V7zm4 12v2H9v-2z"/>'
    },
    "audio-device": {
      body: '<path fill="currentColor" d="M4 4h4v2H4v8h4v2H2V4zm6 0h10v2h-8v12h8v2H10zm12 0h-2v16h2zm-7 4h2v2h-2zm3 4h-4v4h4zM8 18H4v2h4z"/>',
      hidden: true
    },
    "audio-waveform": {
      body: '<path fill="currentColor" d="M3 7h2v5H3zm4 0h2v13H7zm4-3h2v16h-2zm4 0h2v13h-2zM5 5h2v2H5zm4 15h2v2H9zm4-18h2v2h-2zm4 15h2v2h-2zm2-5h2v5h-2zm2-2h2v2h-2zM1 12h2v2H1z"/>'
    },
    "audio-waveform-sharp": {
      body: '<path fill="currentColor" d="M3 7h2v5H3zm4 0h2v13H7zm4-3h2v16h-2zm4 0h2v13h-2zM3 5h6v2H3zm4 15h6v2H7zm4-18h6v2h-6zm4 15h6v2h-6zm4-5h2v5h-2zm0-2h4v2h-4zM1 12h4v2H1z"/>'
    },
    avatar: {
      body: '<path fill="currentColor" d="M3 3h18v18H3zm16 16V5H5v14zM14 7h-4v4h4zm1 6H9v2H7v2h2v-2h6v2h2v-2h-2z"/>',
      hidden: true
    },
    "avatar-circle": {
      body: '<path fill="currentColor" d="M6 2h12v2H6zm0 18h12v2H6zM2 6h2v12H2zm18 0h2v12h-2zM6 18h2v2H6zm10 0h2v2h-2zm2-14h2v2h-2zM4 4h2v2H4zm0 14h2v2H4zm14 0h2v2h-2zM8 16h8v2H8zm2-4h4v2h-4zM8 8h2v4H8zm2-2h4v2h-4zm4 2h2v4h-2z"/>'
    },
    "avatar-circle-minus": {
      body: '<g fill="currentColor"><path d="M6 2h12v2H6zm0 18h8v2H6zM2 6h2v12H2zm18 0h2v8h-2zM6 18h2v2H6zM18 4h2v2h-2zM4 4h2v2H4zm0 14h2v2H4zm14 0h2v2h-2zM8 16h6v2H8zm2-4h4v2h-4zM8 8h2v4H8zm2-2h4v2h-4zm4 2h2v4h-2z"/><path d="M16 18h6v2h-6z"/></g>'
    },
    "avatar-circle-minus-sharp": {
      body: '<g fill="currentColor"><path d="M6 2h12v2H6zm0 18h8v2H6zM2 6h2v12H2zm18 0h2v8h-2zM6 18h2v2H6zM18 4h2v2h-2zM4 4h2v2H4zm0 14h2v2H4zm14 0h2v2h-2zM6 16h8v2H6zm2-4h8v2H8zm0-4h2v4H8zm0-2h8v2H8zm6 2h2v4h-2z"/><path d="M16 18h6v2h-6z"/></g>'
    },
    "avatar-circle-plus": {
      body: '<g fill="currentColor"><path d="M6 2h12v2H6zm0 18h8v2H6zM2 6h2v12H2zm18 0h2v8h-2zM6 18h2v2H6zM18 4h2v2h-2zM4 4h2v2H4zm0 14h2v2H4zm14 0h2v2h-2zM8 16h6v2H8zm2-4h4v2h-4zM8 8h2v4H8zm2-2h4v2h-4zm4 2h2v4h-2z"/><path d="M18 16h2v6h-2z"/><path d="M16 18h6v2h-6z"/></g>'
    },
    "avatar-circle-plus-sharp": {
      body: '<g fill="currentColor"><path d="M6 2h12v2H6zm0 18h8v2H6zM2 6h2v12H2zm18 0h2v8h-2zM6 18h2v2H6zM18 4h2v2h-2zM4 4h2v2H4zm0 14h2v2H4zm14 0h2v2h-2zM6 16h8v2H6zm2-4h8v2H8zm0-4h2v4H8zm0-2h8v2H8zm6 2h2v4h-2z"/><path d="M18 16h2v6h-2z"/><path d="M16 18h6v2h-6z"/></g>'
    },
    "avatar-circle-sharp": {
      body: '<path fill="currentColor" d="M6 2h12v2H6zm0 18h12v2H6zM2 6h2v12H2zm18 0h2v12h-2zM6 18h2v2H6zm10 0h2v2h-2zm2-14h2v2h-2zM4 4h2v2H4zm0 14h2v2H4zm14 0h2v2h-2zM6 16h12v2H6zm2-4h8v2H8zm0-4h2v4H8zm0-2h8v2H8zm6 2h2v4h-2z"/>'
    },
    "avatar-circle-x": {
      body: '<path fill="currentColor" d="M6 2h12v2H6zm0 18h8v2H6zM2 6h2v12H2zm18 0h2v8h-2zM6 18h2v2H6zM18 4h2v2h-2zM4 4h2v2H4zm0 14h2v2H4zm4-2h6v2H8zm2-4h4v2h-4zM8 8h2v4H8zm2-2h4v2h-4zm4 2h2v4h-2zm4 10h2v2h-2zm-2-2h2v2h-2zm4 0h2v2h-2zm0 4h2v2h-2zm-4 0h2v2h-2z"/>'
    },
    "avatar-circle-x-sharp": {
      body: '<path fill="currentColor" d="M6 2h12v2H6zm0 18h8v2H6zM2 6h2v12H2zm18 0h2v8h-2zM6 18h2v2H6zM18 4h2v2h-2zM4 4h2v2H4zm0 14h2v2H4zm2-2h8v2H6zm2-4h8v2H8zm0-4h2v4H8zm0-2h8v2H8zm6 2h2v4h-2zm4 10h2v2h-2zm-2-2h2v2h-2zm4 0h2v2h-2zm0 4h2v2h-2zm-4 0h2v2h-2z"/>'
    },
    "avatar-square": {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zM6 18h2v2H6zm10 0h2v2h-2zm-8-2h8v2H8zm2-4h4v2h-4zM8 8h2v4H8zm2-2h4v2h-4zm4 2h2v4h-2z"/>'
    },
    "avatar-square-minus": {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 18h10v2H4zM2 4h2v16H2zm18 0h2v10h-2zM6 18h2v2H6zm2-2h6v2H8zm2-4h4v2h-4zM8 8h2v4H8zm2-2h4v2h-4zm4 2h2v4h-2zm2 10h6v2h-6z"/>'
    },
    "avatar-square-minus-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 18h12v2H2zM2 4h2v16H2zm18 0h2v10h-2zM6 18h2v2H6zm0-2h8v2H6zm2-4h8v2H8zm0-4h2v4H8zm0-2h8v2H8zm6 2h2v4h-2zm2 10h6v2h-6z"/>'
    },
    "avatar-square-plus": {
      body: '<g fill="currentColor"><path d="M4 2h16v2H4zm0 18h10v2H4zM2 4h2v16H2zm18 0h2v10h-2zM6 18h2v2H6zm2-2h6v2H8zm2-4h4v2h-4zM8 8h2v4H8zm2-2h4v2h-4zm4 2h2v4h-2zm4 8h2v6h-2z"/><path d="M16 18h6v2h-6z"/></g>'
    },
    "avatar-square-plus-sharp": {
      body: '<g fill="currentColor"><path d="M2 2h20v2H2zm0 18h12v2H2zM2 4h2v16H2zm18 0h2v10h-2zM6 18h2v2H6zm0-2h8v2H6zm2-4h8v2H8zm0-4h2v4H8zm0-2h8v2H8zm6 2h2v4h-2zm4 8h2v6h-2z"/><path d="M16 18h6v2h-6z"/></g>'
    },
    "avatar-square-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2zM6 18h2v2H6zm10 0h2v2h-2zM6 16h12v2H6zm2-4h8v2H8zm0-4h2v4H8zm0-2h8v2H8zm6 2h2v4h-2z"/>'
    },
    "avatar-square-x": {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 18h10v2H4zM2 4h2v16H2zm18 0h2v10h-2zM6 18h2v2H6zm2-2h6v2H8zm2-4h4v2h-4zM8 8h2v4H8zm2-2h4v2h-4zm4 2h2v4h-2zm4 10h2v2h-2zm-2-2h2v2h-2zm4 0h2v2h-2zm0 4h2v2h-2zm-4 0h2v2h-2z"/>'
    },
    "avatar-square-x-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 18h12v2H2zM2 4h2v16H2zm18 0h2v10h-2zM6 18h2v2H6zm0-2h8v2H6zm2-4h8v2H8zm0-4h2v4H8zm0-2h8v2H8zm6 2h2v4h-2zm4 10h2v2h-2zm-2-2h2v2h-2zm4 0h2v2h-2zm0 4h2v2h-2zm-4 0h2v2h-2z"/>'
    },
    backburger: {
      body: '<path fill="currentColor" d="M11 7h10v2H11zm-8 4h2V9h2v2h14v2H7v2H5v-2H3zm4 4v2h2v-2zm0-6V7h2v2zm14 6H11v2h10z"/>',
      hidden: true
    },
    backpack: {
      body: '<g fill="currentColor"><path d="M5 6h14v2H5zM3 8h2v12H3zm2 12h14v2H5zM19 8h2v12h-2z"/><path d="M7 16h2v6H7zm8 0h2v6h-2zm-6-2h6v2H9zm-2-4h10v2H7zm1-6h2v2H8zm6 0h2v2h-2zm-4-2h4v2h-4z"/></g>'
    },
    "backpack-sharp": {
      body: '<g fill="currentColor"><path d="M3 6h18v2H3zm0 2h2v12H3zm0 12h18v2H3zM19 8h2v12h-2z"/><path d="M7 16h2v6H7zm8 0h2v6h-2zm-8-2h10v2H7zm0-4h10v2H7zm1-6h2v2H8zm6 0h2v2h-2zM8 2h8v2H8z"/></g>'
    },
    "badge-4k": {
      body: '<path fill="currentColor" d="M3 4h18v2H3zm0 14h18v2H3zM1 6h2v12H1zm20 0h2v12h-2zM5 8h2v5H5zm4 0h2v8H9zm4 0h2v8h-2zm4 0h2v3h-2zm0 5h2v3h-2zm-2-2h2v2h-2zm-8 0h2v2H7z"/>'
    },
    "badge-4k-sharp": {
      body: '<path fill="currentColor" d="M1 4h22v2H1zm0 14h22v2H1zM1 6h2v12H1zm20 0h2v12h-2zM5 8h2v5H5zm4 0h2v8H9zm4 0h2v8h-2zm4 0h2v3h-2zm0 5h2v3h-2zm-2-2h2v2h-2zm-8 0h2v2H7z"/>'
    },
    "badge-5k": {
      body: '<path fill="currentColor" d="M3 4h18v2H3zm0 14h18v2H3zM1 6h2v12H1zm20 0h2v12h-2zM5 8h2v5H5zm4 3h2v3H9zm4-3h2v8h-2zm4 0h2v3h-2zm0 5h2v3h-2zm-2-2h2v2h-2zm-8 0h2v2H7zm0-3h4v2H7zm-2 6h4v2H5z"/>'
    },
    "badge-5k-sharp": {
      body: '<path fill="currentColor" d="M1 4h22v2H1zm0 14h22v2H1zM1 6h2v12H1zm20 0h2v12h-2zM5 8h2v5H5zm4 3h2v3H9zm4-3h2v8h-2zm4 0h2v3h-2zm0 5h2v3h-2zm-2-2h2v2h-2zm-8 0h2v2H7zm0-3h4v2H7zm-2 6h4v2H5z"/>'
    },
    "badge-captions": {
      body: '<path fill="currentColor" d="M3 4h18v2H3zm0 14h18v2H3zM1 6h2v12H1zm20 0h2v12h-2zm-6 8h4v2h-4zM5 10h4v2H5zm0 4h8v2H5zm6-4h8v2h-8z"/>'
    },
    "badge-captions-sharp": {
      body: '<path fill="currentColor" d="M1 4h22v2H1zm0 14h22v2H1zM1 6h2v12H1zm20 0h2v12h-2zm-6 8h4v2h-4zM5 10h4v2H5zm0 4h8v2H5zm6-4h8v2h-8z"/>'
    },
    "badge-hd": {
      body: '<path fill="currentColor" d="M3 4h18v2H3zm0 14h18v2H3zM1 6h2v12H1zm20 0h2v12h-2zM5 8h2v8H5zm4 0h2v8H9zm4 0h2v8h-2zm2 0h2v2h-2zm0 6h2v2h-2zm2-4h2v4h-2zM7 11h2v2H7z"/>'
    },
    "badge-hd-sharp": {
      body: '<path fill="currentColor" d="M1 4h22v2H1zm0 14h22v2H1zM1 6h2v12H1zm20 0h2v12h-2zM5 8h2v8H5zm4 0h2v8H9zm4 0h2v8h-2zm2 0h2v2h-2zm0 6h2v2h-2zm2-4h2v4h-2zM7 11h2v2H7z"/>'
    },
    balloon: {
      body: '<path fill="currentColor" d="M9 1h6v2H9zM7 3h2v2H7zm8 0h2v2h-2zm-4 2h2v2h-2zm2 2h2v2h-2zM5 5h2v8H5zm12 0h2v8h-2zM7 13h2v2H7zm2 2h2v2H9zm4 4h4v2h-4zm-2-4h4v2h-4zm4-2h2v2h-2zm2 8h2v2h-2zm-6-4h2v2h-2z"/>'
    },
    banknote: {
      body: '<path fill="currentColor" d="M3 5h18v2H3zM1 7h2v10H1zm2 10h18v2H3zM21 7h2v10h-2zM11 9h2v2h-2zm-2 2h2v2H9zm2 2h2v2h-2zm2-2h2v2h-2zm4 0h2v2h-2zM5 11h2v2H5z"/>'
    },
    "banknote-sharp": {
      body: '<path fill="currentColor" d="M1 5h22v2H1zm0 2h2v10H1zm0 10h22v2H1zM21 7h2v10h-2zM9 9h6v2H9zm0 2h2v2H9zm0 2h6v2H9zm4-2h2v2h-2zm4 0h2v2h-2zM5 11h2v2H5z"/>'
    },
    barcode: {
      body: '<path fill="currentColor" d="M2 4h2v16H2zm4 0h3v16H6zm5 0h3v16h-3zm5 0h2v16h-2zm4 0h2v16h-2z"/>'
    },
    battery: {
      body: '<path fill="currentColor" d="M4 5h14v2H4zm0 12h14v2H4zM2 7h2v10H2zm16-2h2v14h-2zm2 4h2v6h-2z"/>'
    },
    "battery-1": {
      body: '<path fill="currentColor" d="M4 5H2v14h18v-4h2V9h-2V5zm14 2v10H4V7zM8 9H6v6h2z"/>',
      hidden: true
    },
    "battery-2": {
      body: '<path fill="currentColor" d="M4 5H2v14h18v-4h2V9h-2V5zm14 2v10H4V7zM6 9h2v6H6zm6 0h-2v6h2z"/>',
      hidden: true
    },
    "battery-charging": {
      body: '<path fill="currentColor" d="M4 5H2v14h6v-2H4V7h4V5zm10 0h6v4h2v6h-2v4h-6v-2h4V7h-4zm-4 2h2v4h4v2h-2v2h-2v2h-2v-4H6v-2h2V9h2z"/>',
      hidden: true
    },
    "battery-full": {
      body: '<path fill="currentColor" d="M4 5h14v2H4zm0 12h14v2H4zM2 7h2v10H2zm16-2h2v14h-2zm2 4h2v6h-2zM6 9h2v6H6zm4 0h2v6h-2zm4 0h2v6h-2z"/>'
    },
    "battery-full-sharp": {
      body: '<path fill="currentColor" d="M4 5h14v2H4zm0 12h14v2H4zM2 5h2v14H2zm16 0h2v14h-2zm2 4h2v6h-2zM6 9h2v6H6zm4 0h2v6h-2zm4 0h2v6h-2z"/>'
    },
    "battery-low": {
      body: '<path fill="currentColor" d="M4 5h14v2H4zm0 12h14v2H4zM2 7h2v10H2zm16-2h2v14h-2zm2 4h2v6h-2zM6 9h2v6H6z"/>'
    },
    "battery-low-sharp": {
      body: '<path fill="currentColor" d="M4 5h14v2H4zm0 12h14v2H4zM2 5h2v14H2zm16 0h2v14h-2zm2 4h2v6h-2zM6 9h2v6H6z"/>'
    },
    "battery-medium": {
      body: '<path fill="currentColor" d="M4 5h14v2H4zm0 12h14v2H4zM2 7h2v10H2zm16-2h2v14h-2zm2 4h2v6h-2zM6 9h2v6H6zm4 0h2v6h-2z"/>'
    },
    "battery-medium-sharp": {
      body: '<path fill="currentColor" d="M4 5h14v2H4zm0 12h14v2H4zM2 5h2v14H2zm16 0h2v14h-2zm2 4h2v6h-2zM6 9h2v6H6zm4 0h2v6h-2z"/>'
    },
    "battery-sharp": {
      body: '<path fill="currentColor" d="M4 5h14v2H4zm0 12h14v2H4zM2 5h2v14H2zm16 0h2v14h-2zm2 4h2v6h-2z"/>'
    },
    bed: {
      body: '<g fill="currentColor"><path d="M2 4h2v16H2zm18 6h2v10h-2z"/><path d="M2 16h20v2H2zm2-8h16v2H4zm2 2h2v6H6z"/></g>'
    },
    "bed-sharp": {
      body: '<g fill="currentColor"><path d="M2 4h2v16H2zm18 6h2v10h-2z"/><path d="M2 16h20v2H2zm2-8h18v2H4zm2 2h2v6H6z"/></g>'
    },
    bell: {
      body: '<g fill="currentColor"><path d="M9 2h6v2H9zM7 4h2v2H7zm8 0h2v2h-2zM5 6h2v7H5zm12 0h2v7h-2zM3 13h2v4H3zm16 0h2v4h-2z"/><path d="M3 15h18v2H3zm5 3h2v2H8zm6 0h2v2h-2zm-4 2h4v2h-4z"/></g>'
    },
    "bell-off": {
      body: '<g fill="currentColor"><path d="M9 2h6v2H9zm6 2h2v2h-2zM5 6h2v7H5zm12 0h2v6h-2zM3 13h2v4H3z"/><path d="M3 15h14v2H3zm5 3h2v2H8zm6 0h2v2h-2zm-4 2h4v2h-4zM5 4h2v2H5zm2 2h2v2H7zm2 2h2v2H9zm2 2h2v2h-2zm2 2h2v2h-2z"/><path d="M15 14h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zM3 2h2v2H3z"/></g>'
    },
    "bell-off-sharp": {
      body: '<g fill="currentColor"><path d="M9 2h6v2H9zm6 2h2v2h-2zM5 6h2v7H5zm12 0h2v6h-2zM3 13h2v4H3z"/><path d="M3 15h14v2H3zm5 3h2v2H8zm6 0h2v2h-2zm-6 2h8v2H8zM5 4h2v2H5zm2 2h2v2H7zm2 2h2v2H9zm2 2h2v2h-2zm2 2h2v2h-2z"/><path d="M15 14h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zM3 2h2v2H3z"/></g>'
    },
    "bell-ring": {
      body: '<path fill="currentColor" d="M14 22h-4v-2h4zm-4-2H8v-2h2zm6 0h-2v-2h2zM5 15h14v-2h2v4H3v-4h2zm2-2H5V6h2zm12 0h-2V6h2zM3 6H1V4h2zm6 0H7V4h2zm8 0h-2V4h2zm6 0h-2V4h2zM5 4H3V2h2zm10 0H9V2h6zm6 0h-2V2h2z"/>'
    },
    "bell-ring-sharp": {
      body: '<path fill="currentColor" d="M16 22H8v-4h2v2h4v-2h2zM5 15h14v-2h2v4H3v-4h2zm2-2H5V6h2zm12 0h-2V6h2zM3 6H1V4h2zm6 0H7V4h2zm8 0h-2V4h2zm6 0h-2V4h2zM5 4H3V2h2zm10 0H9V2h6zm6 0h-2V2h2z"/>'
    },
    "bell-sharp": {
      body: '<g fill="currentColor"><path d="M9 2h6v2H9zM7 4h2v2H7zm8 0h2v2h-2zM5 6h2v7H5zm12 0h2v7h-2zM3 13h2v4H3zm16 0h2v4h-2z"/><path d="M3 15h18v2H3zm5 3h2v2H8zm6 0h2v2h-2zm-6 2h8v2H8z"/></g>'
    },
    binary: {
      body: '<path fill="currentColor" d="M7 3h2v2H7zm8 10h2v2h-2zM5 5h2v4H5zm8 10h2v4h-2zM9 5h2v4H9zm8 10h2v4h-2zM7 9h2v2H7zm8 10h2v2h-2zM13 3h4v2h-4zM5 13h4v2H5zm10-8h2v4h-2zM7 15h2v4H7zm6-6h6v2h-6zM5 19h6v2H5z"/>'
    },
    "binary-sharp": {
      body: '<path fill="currentColor" d="M5 3h6v2H5zm8 10h6v2h-6zM5 5h2v4H5zm8 10h2v4h-2zM9 5h2v4H9zm8 10h2v4h-2zM5 9h6v2H5zm8 10h6v2h-6zm0-16h4v2h-4zM5 13h4v2H5zm10-8h2v4h-2zM7 15h2v4H7zm6-6h6v2h-6zM5 19h6v2H5z"/>'
    },
    bitcoin: {
      body: '<path fill="currentColor" d="M13 3h2v2h2v2H9v4h8v2H9v4h8v2h-2v2h-2v-2h-2v2H9v-2H5v-2h2v-4H5v-2h2V7H5V5h4V3h2v2h2zm4 14v-4h2v4zm0-6V7h2v4z"/>',
      hidden: true
    },
    blocks: {
      body: '<g fill="currentColor"><path d="M15 1h6v2h-6zm-2 2h2v6h-2zm2 6h6v2h-6zm6-6h2v6h-2zM3 5h6v2H3zM1 7h2v14H1zm2 14h14v2H3zm14-6h2v6h-2zM3 13h14v2H3z"/><path d="M9 7h2v14H9z"/></g>'
    },
    "blocks-sharp": {
      body: '<g fill="currentColor"><path d="M13 1h10v2H13zm0 2h2v6h-2zm0 6h10v2H13zm8-6h2v6h-2zM1 5h10v2H1zm0 2h2v16H1zm2 14h14v2H3zm14-8h2v10h-2zM3 13h14v2H3z"/><path d="M9 7h2v14H9z"/></g>'
    },
    bluetooth: {
      body: '<path fill="currentColor" d="M15 3h-2v2h2v2h2v2h-2v2h2V9h2V7h-2V5h-2zm-2 0h-2v6H9V7H7V5H5v2h2v2h2v2h2v2H9v2H7v2H5v2h2v-2h2v-2h2v6h2zm2 8h-2v2h2v2h2v2h-2v2h-2v2h2v-2h2v-2h2v-2h-2v-2h-2z"/>',
      hidden: true
    },
    book: {
      body: '<path fill="currentColor" d="M8 2h12v20H4V2zm4 8h-2v2H8V4H6v16h12V4h-4v8h-2z"/>',
      hidden: true
    },
    "book-open": {
      body: '<path fill="currentColor" d="M2 3h9v2H2zM0 19h11v2H0zM13 3h9v2h-9zm0 16h11v2H13zM11 5h2v18h-2zM0 5h2v14H0zm22 0h2v14h-2zm-7 2h5v2h-5zm0 4h5v2h-5zm0 4h2v2h-2z"/>'
    },
    "book-open-sharp": {
      body: '<g fill="currentColor"><path d="M0 3h13v2H0zm0 16h11v2H0z"/><path d="M11 3h13v2H11zm2 16h11v2H13zM11 5h2v18h-2zM0 5h2v14H0zm22 0h2v14h-2zm-7 2h5v2h-5zm0 4h5v2h-5zm0 4h2v2h-2z"/></g>'
    },
    bookmark: {
      body: '<path fill="currentColor" d="M6 2h12v2H6zM4 4h2v18H4zm14 0h2v18h-2zm-2 16h2v2h-2zm-2-2h2v2h-2zm-8 2h2v2H6zm2-2h2v2H8zm2-2h4v2h-4z"/>'
    },
    "bookmark-sharp": {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 2h2v18H4zm14 0h2v18h-2zm-2 16h2v2h-2zm-2-2h2v2h-2zm-8 2h2v2H6zm2-2h2v2H8zm2-2h4v2h-4z"/>'
    },
    bookmarks: {
      body: '<path fill="currentColor" d="M21 18V2H7v2h12v14zM5 6H3v16h4v-2h2v-2h2v2h2v2h4V6zm8 14v-2h-2v-2H9v2H7v2H5V8h10v12z"/>',
      hidden: true
    },
    "bottle-wine": {
      body: '<path fill="currentColor" d="M9 1h6v2H9zm0 2h2v4H9zm4 0h2v4h-2zM7 7h2v2H7zm8 0h2v2h-2zm2 2h2v12h-2zM5 9h2v12H5zm2 12h10v2H7z"/>'
    },
    "bottle-wine-sharp": {
      body: '<path fill="currentColor" d="M9 1h6v2H9zm0 2h2v4H9zm4 0h2v4h-2zM7 7h2v2H7zm8 0h2v2h-2zm2 2h2v12h-2zM5 9h2v12H5zm0 12h14v2H5z"/>'
    },
    box: {
      body: '<g fill="currentColor"><path d="M14 4h4v2h-4zm-4-2h4v2h-4zM6 8h4v2H6zm0 10h4v2H6zm4-8h4v2h-4zm0 10h4v2h-4zm4-12h4v2h-4zm0 10h4v2h-4zM6 4h4v2H6zM2 6h4v2H2zm0 10h4v2H2zM18 6h4v2h-4zm0 10h4v2h-4z"/><path d="M2 6h2v12H2zm18 0h2v12h-2zm-8 6h2v8h-2z"/></g>'
    },
    braces: {
      body: '<path fill="currentColor" d="M6 4h4v2H6zm12 0h-4v2h4zM6 20h4v-2H6zm12 0h-4v-2h4zM4 6h2v5H4zm16 0h-2v5h2zM4 18h2v-5H4zm16 0h-2v-5h2zM2 11h2v2H2zm20 0h-2v2h2z"/>'
    },
    "braces-content": {
      body: '<path fill="currentColor" d="M5 4h4v2H5zm14 0h-4v2h4zM5 20h4v-2H5zm14 0h-4v-2h4zM3 6h2v5H3zm18 0h-2v5h2zM3 18h2v-5H3zm18 0h-2v-5h2zM1 11h2v2H1zm10 0h2v2h-2zm-4 0h2v2H7zm8 0h2v2h-2zm8 0h-2v2h2z"/>'
    },
    "braces-content-sharp": {
      body: '<path fill="currentColor" d="M3 4h6v2H3zm18 0h-6v2h6zM3 20h6v-2H3zm18 0h-6v-2h6zM3 6h2v5H3zm18 0h-2v5h2zM3 18h2v-5H3zm18 0h-2v-5h2zM1 11h2v2H1zm10 0h2v2h-2zm-4 0h2v2H7zm8 0h2v2h-2zm8 0h-2v2h2z"/>'
    },
    "braces-off": {
      body: '<g fill="currentColor"><path d="M8 3h2v2H8zm10 0h-4v2h4zM6 21h4v-2H6zm12 0h-4v-2h4zM4 5h2v6H4zm16 0h-2v6h2zM4 19h2v-6H4zm16-4h-2v-2h2zM2 11h2v2H2zm20 0h-2v2h2zM2 3h2v2H2z"/><path d="M4 5h2v2H4zm2 2h2v2H6zm2 2h2v2H8zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2z"/></g>'
    },
    "braces-off-sharp": {
      body: '<g fill="currentColor"><path d="M8 3h2v2H8zm12 0h-6v2h6zM4 21h6v-2H4zm14 0h-4v-2h4zM4 5h2v6H4zm16 0h-2v6h2zM4 19h2v-6H4zm16-4h-2v-2h2zM2 11h2v2H2zm20 0h-2v2h2zM2 3h2v2H2z"/><path d="M4 5h2v2H4zm2 2h2v2H6zm2 2h2v2H8zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2z"/></g>'
    },
    "braces-sharp": {
      body: '<path fill="currentColor" d="M4 4h6v2H4zm16 0h-6v2h6zM4 20h6v-2H4zm16 0h-6v-2h6zM4 6h2v5H4zm16 0h-2v5h2zM4 18h2v-5H4zm16 0h-2v-5h2zM2 11h2v2H2zm20 0h-2v2h2z"/>'
    },
    brackets: {
      body: '<path fill="currentColor" d="M5 4h4v2H5zm14 0h-4v2h4zM5 20h4v-2H5zm14 0h-4v-2h4zM3 6h2v12H3zm18 0h-2v12h2z"/>'
    },
    "brackets-angle": {
      body: '<path fill="currentColor" d="M8 5h2v2H8zM6 7h2v2H6zM4 9h2v2H4zm-2 2h2v2H2zm2 2h2v2H4zm2 2h2v2H6zm2 2h2v2H8zm8-12h-2v2h2zm2 2h-2v2h2zm2 2h-2v2h2zm2 2h-2v2h2zm-2 2h-2v2h2zm-2 2h-2v2h2zm-2 2h-2v2h2z"/>'
    },
    "brackets-angle-off": {
      body: '<path fill="currentColor" d="M2 1h2v2H2zm2 2h2v2H4zm2 2h2v2H6zm2 2h2v2H8zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zM4 9h2v2H4zm2-2h2v2H6zm-4 4h2v2H2zm2 2h2v2H4zm2 2h2v2H6zm2 2h2v2H8zm6 0h2v2h-2zm6-6h2v2h-2zm-2-2h2v2h-2zm-2-2h2v2h-2zm-2-2h2v2h-2z"/>'
    },
    "brackets-content": {
      body: '<path fill="currentColor" d="M5 4h4v2H5zm14 0h-4v2h4zM5 20h4v-2H5zm14 0h-4v-2h4zM3 6h2v12H3zm18 0h-2v12h2zm-10 5h2v2h-2zm-4 0h2v2H7zm8 0h2v2h-2z"/>'
    },
    "brackets-content-sharp": {
      body: '<path fill="currentColor" d="M3 4h6v2H3zm18 0h-6v2h6zM3 20h6v-2H3zm18 0h-6v-2h6zM3 6h2v12H3zm18 0h-2v12h2zm-10 5h2v2h-2zm-4 0h2v2H7zm8 0h2v2h-2z"/>'
    },
    "brackets-off": {
      body: '<path fill="currentColor" d="M19 3h-4v2h4zM5 21h4v-2H5zm14 0h-4v-2h4zM3 5h2v14H3zm18 0h-2v10h2zM3 3h2v2H3zm2 2h2v2H5zm2 2h2v2H7zm2 2h2v2H9zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2z"/>'
    },
    "brackets-off-sharp": {
      body: '<path fill="currentColor" d="M21 3h-6v2h6zM3 21h6v-2H3zm16 0h-4v-2h4zM3 5h2v14H3zm18 0h-2v10h2zM3 3h2v2H3zm2 2h2v2H5zm2 2h2v2H7zm2 2h2v2H9zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2z"/>'
    },
    "brackets-sharp": {
      body: '<path fill="currentColor" d="M3 4h6v2H3zm18 0h-6v2h6zM3 20h6v-2H3zm18 0h-6v-2h6zM3 6h2v12H3zm18 0h-2v12h2z"/>'
    },
    briefcase: {
      body: '<path fill="currentColor" d="M2 8h2v12H2zm18 0h2v12h-2zM4 6h16v2H4zm0 14h16v2H4zM8 4h2v2H8zm2-2h4v2h-4zm4 2h2v2h-2z"/>'
    },
    "briefcase-account": {
      body: '<path fill="currentColor" d="M16 3H8v4H2v14h20V7h-6zm-2 4h-4V5h4zM4 19V9h16v10zm6-8h4v3h-4zm-2 4h8v2H8z"/>',
      hidden: true
    },
    "briefcase-check": {
      body: '<path fill="currentColor" d="M16 3H8v4H2v14h20V7h-6zm-2 4h-4V5h4zM4 19V9h16v10zm10-8h2v2h-2zm-2 4v-2h2v2zm-2 0h2v2h-2zm0 0H8v-2h2z"/>',
      hidden: true
    },
    "briefcase-delete": {
      body: '<path fill="currentColor" d="M16 3H8v4H2v14h12v-2H4V9h16v4h2V7h-6zm-2 4h-4V5h4zm4 8h-2v2h2v2h-2v2h2v-2h2v2h2v-2h-2v-2h2v-2h-2v2h-2z"/>',
      hidden: true
    },
    "briefcase-download": {
      body: '<path fill="currentColor" d="M8 3h8v4h6v14h-5v-2h3V9H4v10h3v2H2V7h6zm6 2h-4v2h4zm-3 6h2v6h2v2h-2v2h-2v-2H9v-2h2zm-2 6H7v-2h2zm6 0v-2h2v2z"/>',
      hidden: true
    },
    "briefcase-minus": {
      body: '<path fill="currentColor" d="M8 3h8v4h6v6h-2V9H4v10h10v2H2V7h6zm6 2h-4v2h4zm2 12h6v2h-6z"/>',
      hidden: true
    },
    "briefcase-plus": {
      body: '<path fill="currentColor" d="M8 3h8v4h6v4h-2V9H4v10h8v2H2V7h6zm2 4h4V5h-4zm7 14h2v-3h3v-2h-3v-3h-2v3h-3v2h3z"/>',
      hidden: true
    },
    "briefcase-search": {
      body: '<path fill="currentColor" d="M16 3H8v4H2v14h10v-2H4V9h16v2h2V7h-6zm-2 4h-4V5h4zm6 6h-6v6h6v2h2v-2h-2zm-4 4v-2h2v2z"/>',
      hidden: true
    },
    "briefcase-search-1": {
      body: '<path fill="currentColor" d="M16 3H8v4H2v14h7v-2H4V9h18V7h-6zm-2 4h-4V5h4zm0 4h8v2h-8zm0 10h-2v-8h2zm8 0v2h-8v-2zm0 0h2v-8h-2zm-6-6h2v2h2v2h-4z"/>',
      hidden: true
    },
    "briefcase-sharp": {
      body: '<path fill="currentColor" d="M2 8h2v12H2zm18 0h2v12h-2zM2 6h20v2H2zm0 14h20v2H2zM8 4h2v2H8zm0-2h8v2H8zm6 2h2v2h-2z"/>'
    },
    "briefcase-upload": {
      body: '<path fill="currentColor" d="M8 3h8v4h6v14h-5v-2h3V9H4v10h3v2H2V7h6zm6 2h-4v2h4zm-3 16h2v-6h2v2h2v-2h-2v-2h-2v-2h-2v2H9v2H7v2h2v-2h2z"/>',
      hidden: true
    },
    briefcases: {
      body: '<path fill="currentColor" d="M6 8h2v8H6zm14 0h2v8h-2zM8 6h12v2H8zm0 10h12v2H8zm-6-4h2v8H2zm2 8h12v2H4zm6-16h2v2h-2zm2-2h4v2h-4zm4 2h2v2h-2zM4 10h2v2H4zm12 8h2v2h-2z"/>'
    },
    "briefcases-sharp": {
      body: '<path fill="currentColor" d="M6 8h2v8H6zm14 0h2v8h-2zM6 6h16v2H6zm0 10h16v2H6zm-4-4h2v8H2zm0 8h16v2H2zm8-16h2v2h-2zm0-2h8v2h-8zm6 2h2v2h-2zM2 10h4v2H2zm14 8h2v2h-2z"/>'
    },
    brush: {
      body: '<g fill="currentColor"><path d="M7 2h10v2H7zM5 4h2v10H5zm12-2h2v12h-2z"/><path d="M13 2h2v6h-2zM9 2h2v4H9zm-4 8h14v2H5zm2 4h10v2H7zm2 2h2v4H9zm4 0h2v4h-2zm-4 4h6v2H9z"/></g>'
    },
    "brush-sharp": {
      body: '<g fill="currentColor"><path d="M5 2h12v2H5zm0 2h2v10H5zm12-2h2v12h-2z"/><path d="M13 2h2v6h-2zM9 2h2v4H9zm-4 8h14v2H5zm0 4h14v2H5zm4 2h2v4H9zm4 0h2v4h-2zm-4 4h6v2H9z"/></g>'
    },
    bug: {
      body: '<g fill="currentColor"><path d="M2 5h2v4H2zm20 0h-2v4h2zM4 9h2v2H4zm16 0h-2v2h2zM2 13h4v2H2zm20 0h-4v2h4zM4 17h2v2H4zm16 0h-2v2h2zM2 19h2v2H2zm20 0h-2v2h2zM6 11h12v2H6z"/><path d="M6 7h2v12H6zm10 0h2v12h-2zM8 19h8v2H8zM8 5h8v2H8z"/><path d="M11 15h2v6h-2zM8 1h2v6H8zm6 0h2v6h-2z"/></g>'
    },
    "bug-sharp": {
      body: '<g fill="currentColor"><path d="M2 5h2v4H2zm20 0h-2v4h2zM2 9h4v2H2zm20 0h-4v2h4zM2 13h4v2H2zm20 0h-4v2h4zM2 17h4v2H2zm20 0h-4v2h4zM2 19h2v2H2zm20 0h-2v2h2zM6 11h12v2H6z"/><path d="M6 5h2v14H6zm10 0h2v14h-2zM6 19h12v2H6zM8 5h8v2H8z"/><path d="M11 15h2v6h-2zM8 1h2v6H8zm6 0h2v6h-2z"/></g>'
    },
    building: {
      body: '<path fill="currentColor" d="M5 2h14v2H5zm0 18h14v2H5zM3 4h2v16H3zm16 0h2v16h-2zM7 6h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2zm-8 4h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2zm-8 4h2v2H7zm4 0h2v2h-2zm-1 4h4v2h-4zm5-4h2v2h-2z"/>'
    },
    "building-community": {
      body: '<path fill="currentColor" d="M4 20h16v2H4zM20 4h2v16h-2zM10 2h10v2H10zM8 8h2v2H8zm0-4h2v2H8zm2 6h2v2h-2zm2 2h2v2h-2zm2 2h2v6h-2zm-8-4h2v2H6zm-2 2h2v2H4zm-2 2h2v6H2zm14-8h2v2h-2zm-4 0h2v2h-2zm4 4h2v2h-2zm-8 6h2v4H8z"/>'
    },
    "building-community-sharp": {
      body: '<path fill="currentColor" d="M2 20h20v2H2zM20 4h2v16h-2zM8 2h14v2H8zm0 6h2v2H8zm0-4h2v2H8zm2 6h2v2h-2zm2 2h2v2h-2zm2 2h2v6h-2zm-8-4h2v2H6zm-2 2h2v2H4zm-2 2h2v6H2zm14-8h2v2h-2zm-4 0h2v2h-2zm4 4h2v2h-2zm-8 6h2v4H8z"/>'
    },
    "building-sharp": {
      body: '<path fill="currentColor" d="M3 2h18v2H3zm0 18h18v2H3zM3 4h2v16H3zm16 0h2v16h-2zM7 6h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2zm-8 4h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2zm-8 4h2v2H7zm4 0h2v2h-2zm-1 4h4v2h-4zm5-4h2v2h-2z"/>'
    },
    "building-skyscraper": {
      body: '<path fill="currentColor" d="M10 2h4v5h2v2h-2v11h4v-9h2v9h2v2H2v-2h2V8h2v12h6V4h-2zM8 6V4h2v2zm0 0H6v2h2zm10 5h-2V9h2zm-8-1H8v2h2zm-2 4h2v2H8z"/>',
      hidden: true
    },
    buildings: {
      body: '<path fill="currentColor" d="M2 2h14v4h6v16H2zm18 6h-4v2h2v2h-2v2h2v2h-2v2h2v2h2zm-6-4H4v16h2v-2h6v2h2zM6 6h2v2H6zm6 0h-2v2h2zm-6 4h2v2H6zm6 0h-2v2h2zm-6 4h2v2H6zm6 0h-2v2h2z"/>',
      hidden: true
    },
    bulletlist: {
      body: '<path fill="currentColor" d="M10 5h12v2H10zm0 4h8v2h-8zm0 4h12v2H10zm0 4h8v2h-8zm-4-6H4V9h2zM4 9H2V7h2zm4 0H6V7h2zM6 7H4V5h2zm-2 6h2v2H4zm0 4h2v2H4zm-2 0v-2h2v2zm4 0v-2h2v2z"/>'
    },
    "bulletlist-sharp": {
      body: '<path fill="currentColor" d="M10 5h12v2H10zm0 4h8v2h-8zm0 4h12v2H10zm0 4h8v2h-8zM4 7v2h2V7zm4 4H2V5h6zm-6 2h6v2H2zm0 4h6v2H2zm0 0v-2h2v2zm4 0v-2h2v2z"/>'
    },
    bullseye: {
      body: '<path fill="currentColor" d="M18 2H6v2H4v2H2v12h2v2h2v2h12v-2h2v-2h2V6h-2V4h-2zm0 2v2h2v12h-2v2H6v-2H4V6h2V4zm-8 6h4v4h-4zM8 6h8v2H8zm0 10H6V8h2zm8 0v2H8v-2zm0 0h2V8h-2z"/>',
      hidden: true
    },
    "bullseye-arrow": {
      body: '<path fill="currentColor" d="M6 2h10v2H6zM4 6V4h2v2zm0 12H2V6h2zm2 2H4v-2h2zm12 0H6v2h12zm2-2v2h-2v-2zm0 0h2V8h-2zM12 6H8v2H6v8h2v2h8v-2h2v-4h-2v4H8V8h4zm2 8v-4h2V8h2V6h4V4h-2V2h-2v4h-2v2h-2v2h-4v4z"/>',
      hidden: true
    },
    bus: {
      body: '<path fill="currentColor" d="M4 15h6v2H4zm10 0h6v2h-6zM4 19h6v2H4zm10 0h6v2h-6zM0 7h2v10H0zm2-2h18v2H2zm20 4h2v8h-2zM2 11h20v2H2zm2 6h2v2H4zm4 0h8v2H8zm-6 0h2v2H2zm16 0h4v2h-4zm2-10h2v2h-2zm-6 0h2v4h-2zM7 7h2v4H7z"/>'
    },
    "bus-sharp": {
      body: '<path fill="currentColor" d="M4 15h6v2H4zm10 0h6v2h-6zM4 19h6v2H4zm10 0h6v2h-6zM0 7h2v10H0zm0-2h22v2H0zm22 2h2v10h-2zM2 11h20v2H2zm2 6h2v2H4zm4 0h8v2H8zm-8 0h4v2H0zm18 0h6v2h-6zM14 7h2v4h-2zM7 7h2v4H7z"/>'
    },
    cake: {
      body: '<path fill="currentColor" d="M1 20h22v2H1zm2-8h2v8H3zm2-2h14v2H5zm14 2h2v8h-2zm-8-5h2v3h-2zM7 7h2v3H7zm8 0h2v3h-2zM7 3h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2zM5 14h2v2H5zm2 2h4v2H7zm4-2h6v2h-6zm6 2h2v2h-2z"/>'
    },
    "cake-sharp": {
      body: '<path fill="currentColor" d="M1 20h22v2H1zm2-8h2v8H3zm0-2h18v2H3zm16 2h2v8h-2zm-8-5h2v3h-2zM7 7h2v3H7zm8 0h2v3h-2zM7 3h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2zM5 14h2v2H5zm2 2h4v2H7zm4-2h6v2h-6zm6 2h2v2h-2z"/>'
    },
    calculator: {
      body: '<path fill="currentColor" d="M5 2h14v2H5zm0 18h14v2H5zM3 4h2v16H3zm16 0h2v16h-2zM7 6h10v4H7zm0 6h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2zm-8 4h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2z"/>'
    },
    "calculator-sharp": {
      body: '<path fill="currentColor" d="M3 2h18v2H3zm0 18h18v2H3zM3 4h2v16H3zm16 0h2v16h-2zM7 6h10v4H7zm0 6h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2zm-8 4h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2z"/>'
    },
    calendar: {
      body: '<path fill="currentColor" d="M5 4h14v2H5zm0 16h14v2H5zM3 10h2v10H3zm0-4h2v2H3zm16 0h2v2h-2zm0 4h2v10h-2zM3 8h18v2H3zm12-6h2v2h-2zM7 2h2v2H7z"/>'
    },
    "calendar-2": {
      body: '<path fill="currentColor" d="M5 4h14v2H5zm0 16h14v2H5zM3 10h2v10H3zm0-4h2v2H3zm16 0h2v2h-2zm0 4h2v10h-2zM3 8h18v2H3zm12-6h2v2h-2zM7 2h2v2H7zm0 10h2v2H7zm0 4h2v2H7zm4-4h2v2h-2zm0 4h2v2h-2zm4-4h2v2h-2z"/>'
    },
    "calendar-2-sharp": {
      body: '<path fill="currentColor" d="M3 4h18v2H3zm0 16h18v2H3zm0-10h2v10H3zm0-4h2v2H3zm16 0h2v2h-2zm0 4h2v10h-2zM3 8h18v2H3zm12-6h2v2h-2zM7 2h2v2H7zm0 10h2v2H7zm0 4h2v2H7zm4-4h2v2h-2zm0 4h2v2h-2zm4-4h2v2h-2z"/>'
    },
    "calendar-alert": {
      body: '<path fill="currentColor" d="M7 5V4H5v2H3v14h14V6h-2V4h-2v2H7zm-2 5V8h10v2zm0 2h10v6H5zm16-3V8h-2v6h2zm0 6h-2v2h2z"/>',
      hidden: true
    },
    "calendar-arrow-left": {
      body: '<path fill="currentColor" d="M17 2h-2v2H9V2H7v2H3v8h2v-2h14v10h-8v2h10V4h-4zm2 6H5V6h14zm-6 8H7v-2h2v-2H7v2H5v2H3v2h2v2h2v2h2v-2H7v-2h6z"/>',
      hidden: true
    },
    "calendar-arrow-right": {
      body: '<path fill="currentColor" d="M17 2h-2v2H9V2H7v2H3v18h10v-2H5V10h14v2h2V4h-4zM7 6h12v2H5V6zm14 10h-2v-2h-2v-2h-2v2h2v2h-6v2h6v2h-2v2h2v-2h2v-2h2z"/>',
      hidden: true
    },
    "calendar-check": {
      body: '<path fill="currentColor" d="M15 2h2v2h4v18H3V4h4V2h2v2h6zm4 6V6H5v2zm0 2H5v10h14zm-3 2v2h-2v-2zm-4 4v-2h2v2zm-2 0h2v2h-2zm0 0H8v-2h2z"/>',
      hidden: true
    },
    "calendar-export": {
      body: '<path fill="currentColor" d="M17 2h-2v2H9V2H7v2H3v18h4v-2H5V10h14v10h-2v2h4V4h-4zM7 6h12v2H5V6zm6 6h-2v6H9v-2H7v2h2v2h2v2h2v-2h2v-2h2v-2h-2v2h-2z"/>',
      hidden: true
    },
    "calendar-grid": {
      body: '<path fill="currentColor" d="M3 3h18v18H3zm2 2v2h14V5zm14 4h-6v2h6zm0 4h-6v2h6zm0 4h-6v2h6zm-8 2v-2H5v2zm-6-4h6v-2H5zm0-4h6V9H5z"/>',
      hidden: true
    },
    "calendar-import": {
      body: '<path fill="currentColor" d="M17 2h-2v2H9V2H7v2H3v18h4v-2H5V10h14v10h-2v2h4V4h-4zM7 6h12v2H5V6zm6 16h-2v-6H9v-2h2v-2h2v2h2v2h-2zm2-6v2h2v-2zm-6 0v2H7v-2z"/>',
      hidden: true
    },
    "calendar-minus": {
      body: '<path fill="currentColor" d="M17 2h-2v2H9V2H7v2H3v18h18V4h-4zM7 6h12v2H5V6zM5 20V10h14v10zm10-6H9v2h6z"/>',
      hidden: true
    },
    "calendar-month": {
      body: '<path fill="currentColor" d="M15 2h2v2h4v18H3V4h4V2h2v2h6zM9 6H5v2h14V6zm-4 4v10h14V10zm2 2h2v2H7zm6 0h-2v2h2zm2 0h2v2h-2zm-6 4H7v2h2zm2 0h2v2h-2zm6 0h-2v2h2z"/>',
      hidden: true
    },
    "calendar-multiple": {
      body: '<path fill="currentColor" d="M17 2h2v2h4v14H5V4h4V2h2v2h6zm-6 4H7v2h14V6zm-4 4v6h14v-6zM3 20h16v2H1V8h2z"/>',
      hidden: true
    },
    "calendar-multiple-check": {
      body: '<path fill="currentColor" d="M17 2h2v2h4v10h-2v-4H7v6h6v2H5V4h4V2h2v2h6zm-6 4H7v2h14V6zm2 14v2H1V8h2v12zm2-2h2v2h-2zm4 2v2h-2v-2zm2-2h-2v2h2zm0 0v-2h2v2z"/>',
      hidden: true
    },
    "calendar-plus": {
      body: '<path fill="currentColor" d="M15 2h2v2h4v18H3V4h4V2h2v2h6zM9 6H5v2h14V6zm-4 4v10h14V10zm6 2h2v2h2v2h-2v2h-2v-2H9v-2h2z"/>',
      hidden: true
    },
    "calendar-range": {
      body: '<path fill="currentColor" d="M5 4h14v2H5zm0 16h14v2H5zM3 10h2v10H3zm0-4h2v2H3zm16 0h2v2h-2zm0 4h2v10h-2zM3 8h18v2H3zm12-6h2v2h-2zM7 2h2v2H7zm4 10h6v2h-6zm-4 4h6v2H7z"/>'
    },
    "calendar-range-sharp": {
      body: '<path fill="currentColor" d="M3 4h18v2H3zm0 16h18v2H3zm0-10h2v10H3zm0-4h2v2H3zm16 0h2v2h-2zm0 4h2v10h-2zM3 8h18v2H3zm12-6h2v2h-2zM7 2h2v2H7zm4 10h6v2h-6zm-4 4h6v2H7z"/>'
    },
    "calendar-remove": {
      body: '<path fill="currentColor" d="M17 2h-2v2H9V2H7v2H3v18h18V4h-4zM7 6h12v2H5V6zM5 20V10h14v10zm6-4H9v2h2zm0-2v-2H9v2zm2 0h-2v2h2v2h2v-2h-2zm0 0v-2h2v2z"/>',
      hidden: true
    },
    "calendar-search": {
      body: '<path fill="currentColor" d="M15 2h2v2h4v8h-2v-2H5v10h6v2H3V4h4V2h2v2h6zM9 6H5v2h14V6zm8 6v2h-4v-2zm-4 6h-2v-4h2zm4 0h-4v2h6v2h2v-2h-2v-6h-2z"/>',
      hidden: true
    },
    "calendar-sharp": {
      body: '<path fill="currentColor" d="M3 4h18v2H3zm0 16h18v2H3zm0-10h2v10H3zm0-4h2v2H3zm16 0h2v2h-2zm0 4h2v10h-2zM3 8h18v2H3zm12-6h2v2h-2zM7 2h2v2H7z"/>'
    },
    "calendar-sort-ascending": {
      body: '<path fill="currentColor" d="M10 5H8v2H4V5H2v2H0v12h12V7h-2zM2 9h8v2H2zm0 8v-4h8v4zM20 7h-2v8h-2v-2h-2v2h2v2h2v2h2v-2h2v-2h2v-2h-2v2h-2z"/>',
      hidden: true
    },
    "calendar-sort-descending": {
      body: '<path fill="currentColor" d="M10 5H8v2H4V5H2v2H0v12h12V7h-2zM2 9h8v2H2zm0 8v-4h8v4zm18 2h-2v-8h-2V9h2V7h2v2h2v2h-2zm2-8v2h2v-2zm-6 0v2h-2v-2z"/>',
      hidden: true
    },
    "calendar-text": {
      body: '<path fill="currentColor" d="M5 4h14v2H5zm0 16h14v2H5zM3 10h2v10H3zm0-4h2v2H3zm16 0h2v2h-2zm0 4h2v10h-2zM3 8h18v2H3zm12-6h2v2h-2zM7 2h2v2H7zm0 10h8v2H7zm0 4h4v2H7z"/>'
    },
    "calendar-text-sharp": {
      body: '<path fill="currentColor" d="M3 4h18v2H3zm0 16h18v2H3zm0-10h2v10H3zm0-4h2v2H3zm16 0h2v2h-2zm0 4h2v10h-2zM3 8h18v2H3zm12-6h2v2h-2zM7 2h2v2H7zm0 10h8v2H7zm0 4h4v2H7z"/>'
    },
    "calendar-today": {
      body: '<path fill="currentColor" d="M17 2h-2v2H9V2H7v2H3v18h18V4h-4zM7 6h12v2H5V6zM5 20V10h14v10zm6-4v-4H7v4z"/>',
      hidden: true
    },
    "calendar-tomorrow": {
      body: '<path fill="currentColor" d="M17 2h-2v2H9V2H7v2H3v18h18V4h-4zM7 6h12v2H5V6zM5 20V10h14v10zm12-2v-4h-4v4z"/>',
      hidden: true
    },
    "calendar-week": {
      body: '<path fill="currentColor" d="M17 2h-2v2H9V2H7v2H3v18h18V4h-4zM7 6h12v2H5V6zM5 20V10h14v10zm12-8H7v2h10z"/>',
      hidden: true
    },
    "calendar-week-begin": {
      body: '<path fill="currentColor" d="M17 2h-2v2H9V2H7v2H3v18h18V4h-4zM7 6h12v2H5V6zM5 20V10h14v10zm4-8H7v6h2z"/>',
      hidden: true
    },
    "calendar-weekend": {
      body: '<path fill="currentColor" d="M17 2h-2v2H9V2H7v2H3v18h18V4h-4zM7 6h12v2H5V6zM5 20V10h14v10zm12-8h-2v6h2z"/>',
      hidden: true
    },
    "calendar-weeks": {
      body: '<path fill="currentColor" d="M5 4h14v2H5zm0 16h14v2H5zM3 10h2v10H3zm0-4h2v2H3zm16 0h2v2h-2zm0 4h2v10h-2zM3 8h18v2H3zm12-6h2v2h-2zM7 2h2v2H7zm0 10h10v2H7zm0 4h10v2H7z"/>'
    },
    "calendar-weeks-sharp": {
      body: '<path fill="currentColor" d="M3 4h18v2H3zm0 16h18v2H3zm0-10h2v10H3zm0-4h2v2H3zm16 0h2v2h-2zm0 4h2v10h-2zM3 8h18v2H3zm12-6h2v2h-2zM7 2h2v2H7zm0 10h10v2H7zm0 4h10v2H7z"/>'
    },
    camera: {
      body: '<path fill="currentColor" d="M4 5h4v2H4zm4-2h8v2H8zm8 2h4v2h-4zM2 7h2v12H2zm2 12h16v2H4zM20 7h2v12h-2zM10 8h4v2h-4zm0 6h4v2h-4zm-2-4h2v4H8zm6 0h2v4h-2z"/>'
    },
    "camera-add": {
      body: '<path fill="currentColor" d="M5 2H3v3H0v2h3v3h2V7h3V5H5zm12 1h-7v2h5v2h5v12H5v-7H3v9h19V5h-5zm-7 6h4v2h2v4h-2v2h-4v-2h4v-4h-4zm-2 2h2v4H8z"/>',
      hidden: true
    },
    "camera-alt": {
      body: '<path fill="currentColor" d="M4 4H2v16h20V4zm16 2v12H4V6zM8 8H6v2h2zm4 0h4v2h-4zm-2 2h2v4h-2zm6 4h2v-4h-2zm0 0h-4v2h4z"/>',
      hidden: true
    },
    "camera-face": {
      body: '<path fill="currentColor" d="M7 3h10v2h5v16H2V7h2v12h16V7h-5V5H9v2H2V5h5zm7 12h-4v2h4zm-4-2v2H8v-2zm0-2V9H8v2zm6 2v2h-2v-2zm0-2V9h-2v2z"/>',
      hidden: true
    },
    "camera-sharp": {
      body: '<path fill="currentColor" d="M2 5h6v2H2zm4-2h12v2H6zm10 2h6v2h-6zM2 7h2v12H2zm0 12h20v2H2zM20 7h2v12h-2zM10 8h4v2h-4zm0 6h4v2h-4zm-2-4h2v4H8zm6 0h2v4h-2z"/>'
    },
    cancel: {
      body: '<path fill="currentColor" d="M6 2h12v2H6zm0 18h12v2H6zM2 6h2v12H2zm18 0h2v12h-2zm-2-2h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2H8zm-2 2h2v2H6zm12 2h2v2h-2zM4 4h2v2H4zm0 14h2v2H4z"/>'
    },
    car: {
      body: '<path fill="currentColor" d="M4 13h6v2H4zm10 0h6v2h-6zM4 17h6v2H4zm10 0h6v2h-6zM2 15h4v2H2zm6 0h8v2H8zm10 0h4v2h-4zm4-4h2v4h-2zm-6-4h2v2h-2zM4 5h12v2H4zm-4 6h2v4H0zm12-2h10v2H12zM2 7h2v4H2zm8 0h2v2h-2z"/>'
    },
    "car-sharp": {
      body: '<path fill="currentColor" d="M4 13h6v2H4zm10 0h6v2h-6zM4 17h6v2H4zm10 0h6v2h-6zM2 15h4v2H2zm6 0h8v2H8zm11 0h5v2h-5zm3-4h2v4h-2zm-6-4h2v2h-2zM4 5h12v2H4zM0 9h2v8H0zm12 0h10v2H12zM2 5h2v6H2zm8 2h2v2h-2z"/>'
    },
    card: {
      body: '<path fill="currentColor" d="M4 4h16v2H4zm0 14h16v2H4zM2 6h2v12H2zm18 0h2v12h-2z"/>'
    },
    "card-id": {
      body: '<path fill="currentColor" d="M2 4h20v16H2zm2 2v4h16V6zm16 6H10v2h10zm0 4h-4v2h4zm-6 2v-2H4v2zM4 14h4v-2H4z"/>',
      hidden: true
    },
    "card-plus": {
      body: '<path fill="currentColor" d="M22 4H2v16h10v-2H4V6h16v4h2zm-3 13h3v-2h-3v-3h-2v3h-3v2h3v3h2z"/>',
      hidden: true
    },
    "card-sharp": {
      body: '<path fill="currentColor" d="M2 4h20v2H2zm0 14h20v2H2zM2 6h2v12H2zm18 0h2v12h-2z"/>'
    },
    "card-stack": {
      body: '<path fill="currentColor" d="M4 4h18v12H2V4zm16 10V6H4v8zm2 4H2v2h20z"/>',
      hidden: true
    },
    "card-text": {
      body: '<path fill="currentColor" d="M6 8h12v2H6zm0 4h8v2H6zM4 4h16v2H4zm0 14h16v2H4zM2 6h2v12H2zm18 0h2v12h-2z"/>'
    },
    "card-text-sharp": {
      body: '<path fill="currentColor" d="M6 8h12v2H6zm0 4h8v2H6zM2 4h20v2H2zm0 14h20v2H2zM2 6h2v12H2zm18 0h2v12h-2z"/>'
    },
    cart: {
      body: '<path fill="currentColor" d="M2 2h4v4h16v11H4V4H2zm4 13h14V8H6zm0 4h3v3H6zm14 0h-3v3h3z"/>',
      hidden: true
    },
    cast: {
      body: '<path fill="currentColor" d="M4 3h18v18h-8v-2h6V5H4v4H2V3zm0 16H2v2h2zm-2-4h4v2H2zm8-4H2v2h8v8h2V11zm-4 4h2v6H6z"/>',
      hidden: true
    },
    castle: {
      body: '<path fill="currentColor" d="M1 8h2v12H1zm2 12h18v2H3zM21 8h2v12h-2zM3 10h18v2H3zm2-8h2v8H5zm12 0h2v8h-2zM7 4h10v2H7zm2-2h2v2H9zm4 0h2v2h-2zM8 16h2v4H8zm2-2h4v2h-4zm4 2h2v4h-2z"/>'
    },
    "castle-sharp": {
      body: '<path fill="currentColor" d="M1 8h2v12H1zm0 12h22v2H1zM21 8h2v12h-2zM3 10h18v2H3zm2-8h2v8H5zm12 0h2v8h-2zM7 4h10v2H7zm2-2h2v2H9zm4 0h2v2h-2zM8 16h2v4H8zm0-2h8v2H8zm6 2h2v4h-2z"/>'
    },
    "cellular-signal-0": {
      body: '<path fill="currentColor" d="M4 14h2v2H4zm7-4h2v2h-2zm7-6h2v2h-2zM2 16h2v2H2zm7-4h2v6H9zm7-6h2v12h-2zM6 14h2v4H6zm7-4h2v8h-2zm7-6h2v14h-2zM2 18h6v2H2zm7 0h6v2H9zm7 0h6v2h-6z"/>'
    },
    "cellular-signal-0-sharp": {
      body: '<path fill="currentColor" d="M4 14h2v2H4zm7-4h2v2h-2zm7-6h2v2h-2zM2 14h2v4H2zm7-4h2v8H9zm7-6h2v14h-2zM6 14h2v4H6zm7-4h2v8h-2zm7-6h2v14h-2zM2 18h6v2H2zm7 0h6v2H9zm7 0h6v2h-6z"/>'
    },
    "cellular-signal-1": {
      body: '<path fill="currentColor" d="M4 12h2v6H4zm7-2h2v2h-2zm7-6h2v2h-2zM2 14h2v4H2zm7-2h2v6H9zm7-6h2v12h-2zM6 12h2v6H6zm7-2h2v8h-2zm7-6h2v14h-2zM2 18h6v2H2zm7 0h6v2H9zm7 0h6v2h-6z"/>'
    },
    "cellular-signal-1-sharp": {
      body: '<path fill="currentColor" d="M4 12h2v6H4zm7-2h2v2h-2zm7-6h2v2h-2zM2 12h2v6H2zm7-2h2v8H9zm7-6h2v14h-2zM6 12h2v6H6zm7-2h2v8h-2zm7-6h2v14h-2zM2 18h6v2H2zm7 0h6v2H9zm7 0h6v2h-6z"/>'
    },
    "cellular-signal-2": {
      body: '<path fill="currentColor" d="M4 12h2v6H4zm7-4h2v10h-2zm7-4h2v2h-2zM2 14h2v4H2zm7-4h2v8H9zm7-4h2v12h-2zM6 12h2v6H6zm7-4h2v10h-2zm7-4h2v14h-2zM2 18h6v2H2zm7 0h6v2H9zm7 0h6v2h-6z"/>'
    },
    "cellular-signal-2-sharp": {
      body: '<path fill="currentColor" d="M4 12h2v6H4zm7-4h2v10h-2zm7-4h2v2h-2zM2 12h2v6H2zm7-4h2v10H9zm7-4h2v14h-2zM6 12h2v6H6zm7-4h2v10h-2zm7-4h2v14h-2zM2 18h6v2H2zm7 0h6v2H9zm7 0h6v2h-6z"/>'
    },
    "cellular-signal-3": {
      body: '<g fill="currentColor"><path d="M4 14h2v4H4zm7-4h2v8h-2zm7-6h2v14h-2zM2 16h2v3H2zm7-4h2v6H9zm7-6h2v12h-2zM6 14h2v5H6zm7-4h2v8h-2zm7-6h2v14h-2z"/><path d="M2 18h6v2H2zm7 0h6v2H9zm7 0h6v2h-6z"/></g>'
    },
    "cellular-signal-3-sharp": {
      body: '<g fill="currentColor"><path d="M4 14h2v4H4zm7-4h2v8h-2zm7-6h2v14h-2zM2 14h2v5H2zm7-4h2v8H9zm7-6h2v14h-2zM6 14h2v5H6zm7-4h2v8h-2zm7-6h2v14h-2z"/><path d="M2 18h6v2H2zm7 0h6v2H9zm7 0h6v2h-6z"/></g>'
    },
    "cellular-signal-off": {
      body: '<path fill="currentColor" d="M4 2H2v2h2v2H2v2h2V6h2v2h2V6H6V4h2V2H6v2H4zm12 2v16h6V4zm2 2h2v12h-2zm-9 4v10h6V10zm2 8v-6h2v6zm-3-4v6H2v-6zm-2 4v-2H4v2z"/>',
      hidden: true
    },
    chart: {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zM7 11h2v6H7zm4-4h2v10h-2zm4 6h2v4h-2z"/>'
    },
    "chart-add": {
      body: '<path fill="currentColor" d="M3 3h10v2H5v14h14v-8h2v10H3zm6 8H7v6h2zm2-4h2v10h-2zm6 6h-2v4h2zm0-10h2v2h2v2h-2v2h-2V7h-2V5h2z"/>',
      hidden: true
    },
    "chart-bar": {
      body: '<path fill="currentColor" d="M13 5h2v14h-2zm-2 4H9v10h2zm-4 4H5v6h2zm12 0h-2v6h2z"/>',
      hidden: true
    },
    "chart-bar-big": {
      body: '<path fill="currentColor" d="M4 20h18v2H4zM2 2h2v18H2zm16 11v3h-2v-3zM8 13v3H6v-3zm8-2v2H8v-2zm0 5v2H8v-2zm4-12v3h-2V4zM8 4v3H6V4zm10-2v2H8V2zm0 5v2H8V7z"/>'
    },
    "chart-bar-big-sharp": {
      body: '<path fill="currentColor" d="M4 20h18v2H4zM2 2h2v20H2zm16 11v3h-2v-3zM8 13v3H6v-3zm10-2v2H6v-2zm0 5v2H6v-2zm2-12v3h-2V4zM8 4v3H6V4zm12-2v2H6V2zm0 5v2H6V7z"/>'
    },
    "chart-column-decreasing": {
      body: '<path fill="currentColor" d="M4 20h18v2H4zM2 2h2v18H2zm5 4h2v12H7zm5 4h2v8h-2zm5 4h2v4h-2z"/>'
    },
    "chart-column-decreasing-sharp": {
      body: '<path fill="currentColor" d="M4 20h18v2H4zM2 2h2v20H2zm5 4h2v12H7zm5 4h2v8h-2zm5 4h2v4h-2z"/>'
    },
    "chart-delete": {
      body: '<path fill="currentColor" d="M13 3H3v18h18V11h-2v8H5V5h8zm-6 8h2v6H7zm6-4h-2v10h2zm2 6h2v4h-2zm2-6h-2v2h2zm0-2V3h-2v2zm2 0h-2v2h2v2h2V7h-2zm0 0V3h2v2z"/>',
      hidden: true
    },
    "chart-minus": {
      body: '<path fill="currentColor" d="M13 3H3v18h18V11h-2v8H5V5h8zm-6 8h2v6H7zm6-4h-2v10h2zm2 6h2v4h-2zm6-8h-6v2h6z"/>',
      hidden: true
    },
    "chart-multiple": {
      body: '<path fill="currentColor" d="M3 2H1v16h18V2zm0 2h14v12H3zm18 2v14H5v2h18V6zM7 8H5v6h2zm2-2h2v8H9zm6 4h-2v4h2z"/>',
      hidden: true
    },
    "chart-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2zM7 11h2v6H7zm4-4h2v10h-2zm4 6h2v4h-2z"/>'
    },
    chat: {
      body: '<path fill="currentColor" d="M20 2H2v20h2V4h16v12H6v2H4v2h2v-2h16V2z"/>',
      hidden: true
    },
    check: {
      body: '<path fill="currentColor" d="M10 18H8v-2h2zm-2-2H6v-2h2zm4-2v2h-2v-2zm-6 0H4v-2h2zm8 0h-2v-2h2zm2-2h-2v-2h2zm2-2h-2V8h2zm2-2h-2V6h2z"/>'
    },
    "check-double": {
      body: '<path fill="currentColor" d="M7 18H5v-2h2zm6 0h-2v-2h2zm-8-2H3v-2h2zm4 0H7v-2h2zm6-2v2h-2v-2zM3 14H1v-2h2zm8 0H9v-2h2zm6 0h-2v-2h2zm-4-2h-2v-2h2zm6 0h-2v-2h2zm-4-2h-2V8h2zm6 0h-2V8h2zm-4-2h-2V6h2zm6 0h-2V6h2z"/>'
    },
    checkbox: {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2z"/>'
    },
    "checkbox-on": {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zM7 12h2v2H7zm2 2h2v2H9zm2-2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2z"/>'
    },
    "checkbox-on-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2zM7 12h2v2H7zm2 2h2v2H9zm2-2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2z"/>'
    },
    "checkbox-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2z"/>'
    },
    checklist: {
      body: '<path fill="currentColor" d="M19 4h2v2h-2zm-2 4V6h2v2zm-2 0h2v2h-2zm0 0h-2V6h2zM3 6h8v2H3zm8 10H3v2h8zm7 2v-2h2v-2h-2v2h-2v-2h-2v2h2v2h-2v2h2v-2zm0 0v2h2v-2z"/>',
      hidden: true
    },
    chess: {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zM8 4h4v4H8zM4 8h4v4H4zm4 4h4v4H8zm-4 4h4v4H4zM16 4h4v4h-4zm-4 4h4v4h-4zm4 4h4v4h-4zm-4 4h4v4h-4z"/>'
    },
    "chess-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2zM8 4h4v4H8zM4 8h4v4H4zm4 4h4v4H8zm-4 4h4v4H4zM16 4h4v4h-4zm-4 4h4v4h-4zm4 4h4v4h-4zm-4 4h4v4h-4z"/>'
    },
    "chevron-down": {
      body: '<path fill="currentColor" d="M13 16h-2v-2h2zm-2-2H9v-2h2zm4 0h-2v-2h2zm-6-2H7v-2h2zm8 0h-2v-2h2zM7 10H5V8h2zm12 0h-2V8h2z"/>'
    },
    "chevron-down-2": {
      body: '<path fill="currentColor" d="M17 9v2h-2v2h-2v2h-2v-2H9v-2H7V9z"/>'
    },
    "chevron-left": {
      body: '<path fill="currentColor" d="M8 13v-2h2v2zm2-2V9h2v2zm0 4v-2h2v2zm2-6V7h2v2zm0 8v-2h2v2zm2-10V5h2v2zm0 12v-2h2v2z"/>'
    },
    "chevron-left-2": {
      body: '<path fill="currentColor" d="M15 17h-2v-2h-2v-2H9v-2h2V9h2V7h2z"/>'
    },
    "chevron-right": {
      body: '<path fill="currentColor" d="M16 13v-2h-2v2zm-2-2V9h-2v2zm0 4v-2h-2v2zm-2-6V7h-2v2zm0 8v-2h-2v2zM10 7V5H8v2zm0 12v-2H8v2z"/>'
    },
    "chevron-right-2": {
      body: '<path fill="currentColor" d="M9 17h2v-2h2v-2h2v-2h-2V9h-2V7H9z"/>'
    },
    "chevron-up": {
      body: '<path fill="currentColor" d="M13 8h-2v2h2zm-2 2H9v2h2zm4 0h-2v2h2zm-6 2H7v2h2zm8 0h-2v2h2zM7 14H5v2h2zm12 0h-2v2h2z"/>'
    },
    "chevron-up-2": {
      body: '<path fill="currentColor" d="M17 15v-2h-2v-2h-2V9h-2v2H9v2H7v2z"/>'
    },
    "chevrons-horizontal": {
      body: '<path fill="currentColor" d="M10 15v2H8v-2zm6 2h-2v-2h2zm-8-2H6v-2h2zm10 0h-2v-2h2zM6 13H4v-2h2zm14 0h-2v-2h2zM8 11H6V9h2zm10 0h-2V9h2zm-8-2H8V7h2zm6 0h-2V7h2z"/>'
    },
    "chevrons-horizontal-2": {
      body: '<path fill="currentColor" d="M8 15H6v-2H4v-2h2V9h2V7h2v10H8zm8-6h2v2h2v2h-2v2h-2v2h-2V7h2z"/>'
    },
    "chevrons-vertical": {
      body: '<path fill="currentColor" d="M13 20h-2v-2h2zm-2-2H9v-2h2zm4 0h-2v-2h2zm-6-2H7v-2h2zm8-2v2h-2v-2zm-8-4H7V8h2zm8 0h-2V8h2zm-6-2H9V6h2zm4 0h-2V6h2zm-2-2h-2V4h2z"/>'
    },
    "chevrons-vertical-2": {
      body: '<path fill="currentColor" d="M15 16v2h-2v2h-2v-2H9v-2H7v-2h10v2zM9 8V6h2V4h2v2h2v2h2v2H7V8z"/>'
    },
    "cigarette-off": {
      body: '<g fill="currentColor"><path d="M2 13h2v2H2zm2-2h9v2H4zm0 4h13v2H4zm3-2h2v2H7zm10-2h3v2h-3zm3 2h2v2h-2z"/><path d="M11 11h2v2h-2zM9 9h2v2H9zM7 7h2v2H7zM5 5h2v2H5zM3 3h2v2H3zm10 10h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zM14 6h2v3h-2zm-2-3h2v3h-2zm7 3h2v3h-2zm-2-3h2v3h-2z"/></g>'
    },
    "cigarette-off-sharp": {
      body: '<g fill="currentColor"><path d="M2 11h2v6H2zm2 0h9v2H4zm0 4h13v2H4zm3-2h2v2H7zm10-2h3v2h-3zm3 0h2v6h-2z"/><path d="M11 11h2v2h-2zM9 9h2v2H9zM7 7h2v2H7zM5 5h2v2H5zM3 3h2v2H3zm10 10h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zM14 6h2v3h-2zm-2-3h2v3h-2zm7 3h2v3h-2zm-2-3h2v3h-2z"/></g>'
    },
    circle: {
      body: '<path fill="currentColor" d="M6 2h12v2H6zm0 18h12v2H6zM2 6h2v12H2zm18 0h2v12h-2zm-2-2h2v2h-2zm0 14h2v2h-2zM4 4h2v2H4zm0 14h2v2H4z"/>'
    },
    "circle-pile": {
      body: '<path fill="currentColor" d="M11 2h2v2h-2zM7 9h2v2H7zm8 0h2v2h-2zM3 16h2v2H3zm8 0h2v2h-2zm8 0h2v2h-2zM9 4h2v2H9zm-4 7h2v2H5zm8 0h2v2h-2zM1 18h2v2H1zm8 0h2v2H9zm8 0h2v2h-2zM11 6h2v2h-2zm-4 7h2v2H7zm8 0h2v2h-2zM3 20h2v2H3zm8 0h2v2h-2zm8 0h2v2h-2zM13 4h2v2h-2zm-4 7h2v2H9zm8 0h2v2h-2zM5 18h2v2H5zm8 0h2v2h-2zm8 0h2v2h-2z"/>'
    },
    "circle-power": {
      body: '<path fill="currentColor" d="M6 20h12v2H6zM6 2h12v2H6zm12 2h2v2h-2zM4 4h2v2H4zm0 14h2v2H4zm14 0h2v2h-2zM2 6h2v12H2zm18 0h2v12h-2zM9 15h6v2H9zM7 9h2v6H7zm8 0h2v6h-2zm-4-2h2v5h-2z"/>'
    },
    "circle-square": {
      body: '<g fill="currentColor"><path d="M11 9h9v2h-9zm0 11h9v2h-9zm-2-9h2v9H9zm11 0h2v9h-2zM6 2h7v2H6z"/><path d="M6 15h7v2H6zm7-11h2v2h-2zm0 9h2v2h-2zM4 4h2v2H4zm0 9h2v2H4zm11-7h2v7h-2zM2 6h2v7H2z"/></g>'
    },
    "circuit-board": {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zM8 6h2v2H8zm8 12h-2v-2h2zM6 8h2v2H6zm12 8h-2v-2h2zM8 10h2v2H8zm8 4h-2v-2h2zm-6-6h6v2h-6zm4 8H8v-2h6zm2-12h2v4h-2zM8 20H6v-4h2z"/>'
    },
    "circuit-board-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2zM8 6h2v2H8zm8 12h-2v-2h2zM6 8h2v2H6zm12 8h-2v-2h2zM8 10h2v2H8zm8 4h-2v-2h2zm-6-6h6v2h-6zm4 8H8v-2h6zm2-12h2v4h-2zM8 20H6v-4h2z"/>'
    },
    clapperboard: {
      body: '<path fill="currentColor" d="M4 3h16v2H4zm0 6h16v2H4zM2 5h2v14H2zm18 0h2v14h-2zM4 19h16v2H4zM18 7h-2v2h2zm-8 0H8v2h2zm6-2h-2v2h2zM8 5H6v2h2z"/>'
    },
    "clapperboard-sharp": {
      body: '<path fill="currentColor" d="M2 3h20v2H2zm2 6h16v2H4zM2 5h2v14H2zm18 0h2v14h-2zM2 19h20v2H2zM18 7h-2v2h2zm-8 0H8v2h2zm6-2h-2v2h2zM8 5H6v2h2z"/>'
    },
    clipboard: {
      body: '<path fill="currentColor" d="M4 6h2v14H4zm2 14h12v2H6zM18 6h2v14h-2zM6 4h2v2H6zm10 0h2v2h-2zm-6-2h4v2h-4zm0 4h4v2h-4zM8 2h2v6H8zm6 0h2v6h-2z"/>'
    },
    "clipboard-note": {
      body: '<g fill="currentColor"><path d="M20 12h2v8h-2zm-8-2h8v2h-8zm0 10h8v2h-8zm-2-8h2v8h-2zM6 2h8v2H6zm0 4h8v2H6zm0-2h2v2H6zm6 0h2v2h-2zm2 0h2v2h-2z"/><path d="M16 6h2v5h-2zM4 4h2v2H4zM2 6h2v12H2zm2 12h6v2H4zm2-8h4v2H6zm0 4h2v2H6zm11 2h5v2h-5z"/><path d="M16 16h2v6h-2z"/></g>'
    },
    "clipboard-note-sharp": {
      body: '<g fill="currentColor"><path d="M20 12h2v8h-2zm-10-2h12v2H10zm0 10h10v2H10zm0-8h2v8h-2zM6 2h8v2H6zm0 4h8v2H6zm0-2h2v2H6zm6 0h2v2h-2zm2 0h4v2h-4z"/><path d="M16 6h2v5h-2zM2 4h4v2H2zm0 2h2v12H2zm0 12h8v2H2zm4-8h2v2H6zm0 4h2v2H6zm11 2h5v2h-5z"/><path d="M16 16h2v6h-2z"/></g>'
    },
    "clipboard-sharp": {
      body: '<path fill="currentColor" d="M4 6h2v14H4zm0 14h16v2H4zM18 6h2v14h-2zM4 4h4v2H4zm12 0h4v2h-4zm-6-2h4v2h-4zm0 4h4v2h-4zM8 2h2v6H8zm6 0h2v6h-2z"/>'
    },
    clock: {
      body: '<path fill="currentColor" d="M6 2h12v2H6zM2 6h2v12H2zm18 0h2v12h-2zm-2-2h2v2h-2zM4 4h2v2H4zm2 18h12v-2H6zm12-2h2v-2h-2zM4 20h2v-2H4zm7-14h2v7h-2zm2 7h2v2h-2zm2 2h2v2h-2z"/>'
    },
    close: {
      body: '<path fill="currentColor" d="M7 19H5v-2h2zm12 0h-2v-2h2zM9 15v2H7v-2zm8 2h-2v-2h2zm-6-2H9v-2h2zm4 0h-2v-2h2zm-2-2h-2v-2h2zm-2-2H9V9h2zm4 0h-2V9h2zM9 9H7V7h2zm8 0h-2V7h2zM7 7H5V5h2zm12 0h-2V5h2z"/>'
    },
    "close-box": {
      body: '<path fill="currentColor" d="M5 3H3v18h18V3zm14 2v14H5V5zm-8 4H9V7H7v2h2v2h2v2H9v2H7v2h2v-2h2v-2h2v2h2v2h2v-2h-2v-2h-2v-2h2V9h2V7h-2v2h-2v2h-2z"/>',
      hidden: true
    },
    cloud: {
      body: '<g fill="currentColor"><path d="M22 10h-4v2h4zm2 2h-2v6h2zm-2 6H2v2h20zM2 12H0v6h2zm2-2H2v2h2zm4-2H4v2h4zm8-4h-6v2h6zm-6 2H8v2h2zm0 4H8v2h2zm8-4h-2v2h2z"/><path d="M20 8h-2v4h2zm-2 4h-2v2h2z"/></g>'
    },
    "cloud-done": {
      body: '<path fill="currentColor" d="M16 4h-6v2H8v2H4v2H2v2H0v6h2v2h20v-2h2v-6h-2v-2h-2V8h-2V6h-2zm0 2v2h2v4h4v6H2v-6h2v-2h4V8h2V6zm-6 6H8v2h2v2h2v-2h2v-2h2v-2h-2v2h-2v2h-2z"/>',
      hidden: true
    },
    "cloud-download": {
      body: '<path fill="currentColor" d="M10 4h6v2h-6zM8 8V6h2v2zm-4 2V8h4v2zm-2 2v-2h2v2zm0 6H0v-6h2zm0 0h5v2H2zM18 8h-2V6h2zm4 4h-4V8h2v2h2zm0 6v-6h2v6zm0 0v2h-5v-2zm-11 2h2v-2h2v-2h2v-2h-4V9h-2v5H7v2h2v2h2z"/>',
      hidden: true
    },
    "cloud-moon": {
      body: '<path fill="currentColor" d="M14 22H4v-2h10zM4 20H2v-4h2zm12 0h-2v-4h2zm-6-2H8v-2h2zm-2-2H4v-2h4zm6 0h-2v-2h2zm6 0h-2v-2h2zm-8-2H8v-2h4zm10 0h-2v-4h-2V8h2V6h2zm-4-2h-4v-2h4zM8 10H6V6h2zm6 0h-2V6h2zm-4-4H8V4h2zm8-2h-2v2h-2V4h-4V2h8z"/>'
    },
    "cloud-server": {
      body: '<path fill="currentColor" d="M20 6h-2v2h2zm2 2h-2v4h2zm-2 4H4v2h16zM4 8H2v4h2zm4-2H4v2h4zm8-4h-6v2h6zm-6 2H8v2h2zm0 4H8v2h2zm8-4h-2v2h2zm0 4h-2v2h2zm-7 8h2v2h-2zm0 4h2v2h-2zm-7-2h7v2H4zm9 0h7v2h-7zm-2-4h2v2h-2z"/>'
    },
    "cloud-sun": {
      body: '<path fill="currentColor" d="M14 22H4v-2h10zM4 20H2v-4h2zm12 0h-2v-4h2zm-6-2H8v-2h2zm-2-2H4v-2h4zm6 0h-2v-2h2zm-2-2H8v-2h4zm12-1h-4v-2h4zm-6-1h-2v-2h2zM8 10H6V8h2zm8 0h-2V8h2zm-2-2H8V6h6zM6 6H4V4h2zm14 0h-2V4h2zM4 4H2V2h2zm9 0h-2V0h2zm9 0h-2V2h2z"/>'
    },
    "cloud-upload": {
      body: '<path fill="currentColor" d="M10 4h6v2h-6zM8 8V6h2v2zm-4 2V8h4v2zm-2 2v-2h2v2zm0 6H0v-6h2zm0 0h7v2H2zM18 8h-2V6h2zm4 4h-4V8h2v2h2zm0 6v-6h2v6zm0 0v2h-7v-2zM11 9h2v2h2v2h2v2h-4v5h-2v-5H7v-2h2v-2h2z"/>',
      hidden: true
    },
    cocktail: {
      body: '<path fill="currentColor" d="M19 3H3v4h2v2h2v2h2v2h2v6H7v2h10v-2h-4v-6h2v-2h2V9h2V7h2V3zm0 4H5V5h14z"/>',
      hidden: true
    },
    coffee: {
      body: '<path fill="currentColor" d="M4 4h16v2H4zm0 2h2v8H4zm2 8h10v2H6zm14-8h2v4h-2zm-2 4h2v2h-2zm-2-4h2v8h-2zM2 18h18v2H2z"/>'
    },
    "coffee-alt": {
      body: '<path fill="currentColor" d="M7 3H5v4h2zm4 0H9v4h2zm2 0h2v4h-2zm8 6H3v12h14v-5h4zm-2 5h-2v-3h2zM5 11h10v8H5z"/>',
      hidden: true
    },
    "coffee-sharp": {
      body: '<path fill="currentColor" d="M4 4h16v2H4zm0 2h2v8H4zm0 8h14v2H4zM20 4h2v8h-2zm-2 6h2v2h-2zm-2-4h2v8h-2zM2 18h18v2H2z"/>'
    },
    coin: {
      body: '<path fill="currentColor" d="M6 2h12v2H6zM4 6V4h2v2zm0 12V6H2v12zm2 2v-2H4v2zm12 0v2H6v-2zm2-2v2h-2v-2zm0-12h2v12h-2zm0 0V4h-2v2zm-9-1h2v2h3v2h-6v2h6v6h-3v2h-2v-2H8v-2h6v-2H8V7h3z"/>',
      hidden: true
    },
    coins: {
      body: '<g fill="currentColor"><path d="M6 2h6v2H6zM4 4h2v2H4zm8 0h2v2h-2zm-8 8h2v2H4zm8 0h2v2h-2zm-6 2h6v2H6zM2 6h2v6H2zm12 0h2v6h-2z"/><path d="M14 8h4v2h-4zm-4 10h2v2h-2zm8-8h2v2h-2zm-6 10h2v2h-2zm6-2h2v2h-2z"/><path d="M12 20h6v2h-6zm-4-6h2v4H8zm12-2h2v6h-2zM7 6h4v2H7z"/><path d="M9 6h2v6H9zm6 8h2v4h-2zm-1-2h3v2h-3z"/></g>'
    },
    collapse: {
      body: '<path fill="currentColor" d="M17 3h-2v2h-2v2h-2V5H9V3H7v2h2v2h2v2h2V7h2V5h2zM4 13h16v-2H4zm9 4h-2v-2h2zm2 2h-2v-2h2zm0 0h2v2h-2zm-6 0h2v-2H9zm0 0H7v2h2z"/>',
      hidden: true
    },
    "colors-swatch": {
      body: '<path fill="currentColor" d="M14 2h6v2h-6zm0 18h6v2h-6zM4 20h10v2H4zm8-16h2v16h-2zm8 0h2v16h-2zM2 16h2v4H2zm2-2h8v2H4zm12 2h2v2h-2zM6 12h2v2H6zM4 8h2v4H4zm2-2h4v2H6zm4 2h2v2h-2z"/>'
    },
    "colors-swatch-sharp": {
      body: '<path fill="currentColor" d="M12 2h10v2H12zm2 18h8v2h-8zM4 20h10v2H4zm8-16h2v16h-2zm8 0h2v16h-2zM2 14h2v8H2zm2 0h8v2H4zm12 2h2v2h-2zM6 12h2v2H6zm-2-2h2v2H4zm2-2h2v2H6zm2-2h2v2H8zm2 2h2v2h-2z"/>'
    },
    command: {
      body: '<path fill="currentColor" d="M4 2H2v8h2zm16 0h2v8h-2zm-6 6h-4V2H4v2h4v4H4v2h4v4H4v2h4v4H4v2h6v-6h4v6h2v-6h4v-2h-4v-4h4V8h-4V2h-2zm-4 6v-4h4v4zM20 2h-4v2h4zM2 14h2v8H2zm14 6h4v2h-4zm6-6h-2v8h2z"/>',
      hidden: true
    },
    comment: {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 14h14v2H4zM2 4h2v12H2zm18 0h2v18h-2zm-2 14h2v2h-2z"/>'
    },
    "comment-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 14h16v2H2zM2 4h2v12H2zm18 0h2v18h-2zm-2 14h2v2h-2z"/>'
    },
    "comment-text": {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 14h14v2H4zm2-6h6v2H6zm0-4h12v2H6zM2 4h2v12H2zm18 0h2v18h-2zm-2 14h2v2h-2z"/>'
    },
    "comment-text-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 14h16v2H2zm4-6h6v2H6zm0-4h12v2H6zM2 4h2v12H2zm18 0h2v18h-2zm-2 14h2v2h-2z"/>'
    },
    computer: {
      body: '<path fill="currentColor" d="M6 1h12v2H6zm0 8h12v2H6zM4 3h2v6H4zm14 0h2v6h-2zM4 13h16v2H4zm0 8h16v2H4zm-2-6h2v6H2zm18 0h2v6h-2zM6 17h2v2H6zm4 0h8v2h-8zm-2-6h2v2H8zm6 0h2v2h-2z"/>'
    },
    "computer-sharp": {
      body: '<path fill="currentColor" d="M4 1h16v2H4zm0 8h16v2H4zm0-6h2v6H4zm14 0h2v6h-2zM2 13h20v2H2zm0 8h20v2H2zm0-6h2v6H2zm18 0h2v6h-2zM6 17h2v2H6zm4 0h8v2h-8zm-2-6h2v2H8zm6 0h2v2h-2z"/>'
    },
    contact: {
      body: '<path fill="currentColor" d="M2 2h20v2H2zM0 4h2v16H0zm22 0h2v16h-2zM2 20h20v2H2zM14 7h6v2h-6zm0 4h6v2h-6zm0 4h4v2h-4zM6 7h4v4H6zm0 6h4v2H6zm4 2h2v2h-2zm-6 0h2v2H4z"/>'
    },
    "contact-delete": {
      body: '<path fill="currentColor" d="M22 3H0v18h16v-2H2V5h20v10h2V3zM6 7h4v4H6zm0 8H4v2h2zm4 0H6v-2h4zm0 0v2h2v-2zm4-8h6v2h-6zm6 4h-6v2h6zm-6 4h2v2h-2zm8 4h-2v-2h-2v2h2v2h-2v2h2v-2h2v2h2v-2h-2zm0 0h2v-2h-2z"/>',
      hidden: true
    },
    "contact-multiple": {
      body: '<path fill="currentColor" d="M4 3h20v14H4zm18 12V5H6v10zm-2 4H2V7H0v14h20zM9 7h2v2H9zm3 4H8v2h4zm2-4h6v2h-6zm6 4h-6v2h6z"/>',
      hidden: true
    },
    "contact-plus": {
      body: '<path fill="currentColor" d="M2 3h22v11h-2V5H2v14h12v2H0V3zm8 4H6v4h4zm-6 6h8v4H4zm16-6h-6v2h6zm-6 4h6v2h-6zm3 4h-3v2h3zm4 6v3h-2v-3h-3v-2h3v-3h2v3h3v2z"/>',
      hidden: true
    },
    "contact-sharp": {
      body: '<path fill="currentColor" d="M0 2h24v2H0zm0 2h2v16H0zm22 0h2v16h-2zM0 20h24v2H0zM14 7h6v2h-6zm0 4h6v2h-6zm0 4h4v2h-4zM6 7h4v4H6zm0 6h4v2H6zm4 2h2v2h-2zm-6 0h2v2H4z"/>'
    },
    copy: {
      body: '<path fill="currentColor" d="M8 6h12v2H8zM4 2h12v2H4zm2 6h2v12H6zM2 4h2v12H2zm6 16h12v2H8zM20 8h2v12h-2zm-4-4h2v2h-2zM4 16h2v2H4z"/>'
    },
    "copy-sharp": {
      body: '<path fill="currentColor" d="M6 6h16v2H6zM2 2h16v2H2zm4 6h2v12H6zM2 4h2v12H2zm4 16h16v2H6zM20 8h2v12h-2zm-4-4h2v2h-2zM2 16h4v2H2z"/>'
    },
    "copy-x": {
      body: '<path fill="currentColor" d="M8 6h12v2H8zM4 2h12v2H4zm2 6h2v12H6zM2 4h2v12H2zm6 16h12v2H8zM20 8h2v12h-2zm-4-4h2v2h-2zM4 16h2v2H4zm7-5h2v2h-2zm4 4h2v2h-2zm0-4h2v2h-2zm-4 4h2v2h-2zm2-2h2v2h-2z"/>'
    },
    "copy-x-sharp": {
      body: '<path fill="currentColor" d="M6 6h16v2H6zM2 2h16v2H2zm4 6h2v12H6zM2 4h2v12H2zm4 16h16v2H6zM20 8h2v12h-2zm-4-4h2v2h-2zM2 16h4v2H2zm9-5h2v2h-2zm4 4h2v2h-2zm0-4h2v2h-2zm-4 4h2v2h-2zm2-2h2v2h-2z"/>'
    },
    "corner-down-left": {
      body: '<g fill="currentColor"><path d="M18 16H4v-2h14zm2-2h-2V4h2z"/><path d="M8 10h2v8H8zm-2 2h2v2H6zm0 4h2v2H6zm2 2h2v2H8z"/></g>'
    },
    "corner-down-left-sharp": {
      body: '<g fill="currentColor"><path d="M18 16H4v-2h14zm2 0h-2V4h2z"/><path d="M8 10h2v8H8zm-2 2h2v2H6zm0 4h2v2H6zm2 2h2v2H8z"/></g>'
    },
    "corner-down-right": {
      body: '<g fill="currentColor"><path d="M6 16h14v-2H6zm-2-2h2V4H4z"/><path d="M16 10h-2v8h2zm2 2h-2v2h2zm0 4h-2v2h2zm-2 2h-2v2h2z"/></g>'
    },
    "corner-down-right-sharp": {
      body: '<g fill="currentColor"><path d="M6 16h14v-2H6zm-2 0h2V4H4z"/><path d="M16 10h-2v8h2zm2 2h-2v2h2zm0 4h-2v2h2zm-2 2h-2v2h2z"/></g>'
    },
    "corner-left-down": {
      body: '<g fill="currentColor"><path d="M8 6v14h2V6zm2-2v2h10V4zm4 12v-2h-2v2zm-2 2v-2h-2v2zm-4 0v-2H6v2z"/><path d="M14 16v-2H4v2z"/></g>'
    },
    "corner-left-down-sharp": {
      body: '<g fill="currentColor"><path d="M8 4v16h2V4zm2 0v2h10V4zm4 12v-2h-2v2zm-2 2v-2h-2v2zm-4 0v-2H6v2z"/><path d="M14 16v-2H4v2z"/></g>'
    },
    "corner-left-up": {
      body: '<g fill="currentColor"><path d="M8 18V4h2v14zm2 2v-2h10v2zm4-12v2h-2V8zm-2-2v2h-2V6zM8 6v2H6V6z"/><path d="M12 8v2H4V8z"/></g>'
    },
    "corner-left-up-sharp": {
      body: '<g fill="currentColor"><path d="M8 18V4h2v14zm0 2v-2h12v2zm6-12v2h-2V8zm-2-2v2h-2V6zM8 6v2H6V6z"/><path d="M12 8v2H4V8z"/></g>'
    },
    "corner-right-down": {
      body: '<g fill="currentColor"><path d="M16 6v14h-2V6zm-2-2v2H4V4z"/><path d="M10 16v-2h10v2zm2 2v-2h2v2zm4 0v-2h2v2z"/><path d="M18 16v-2h2v2z"/></g>'
    },
    "corner-right-down-sharp": {
      body: '<g fill="currentColor"><path d="M16 4v16h-2V4zm-2 0v2H4V4z"/><path d="M10 16v-2h10v2zm2 2v-2h2v2zm4 0v-2h2v2z"/><path d="M18 16v-2h2v2z"/></g>'
    },
    "corner-right-up": {
      body: '<g fill="currentColor"><path d="M16 18V4h-2v14zm-2 2v-2H4v2z"/><path d="M10 8v2h8V8zm2-2v2h2V6zm4 0v2h2V6zm2 2v2h2V8z"/></g>'
    },
    "corner-right-up-sharp": {
      body: '<g fill="currentColor"><path d="M16 20V4h-2v16zm-2 0v-2H4v2z"/><path d="M10 8v2h8V8zm2-2v2h2V6zm4 0v2h2V6zm2 2v2h2V8z"/></g>'
    },
    "corner-up-left": {
      body: '<g fill="currentColor"><path d="M18 8H4v2h14zm2 2h-2v10h2zM8 14h2v-2H8zm-2-2h2v-2H6zm0-4h2V6H6z"/><path d="M8 12h2V4H8z"/></g>'
    },
    "corner-up-left-sharp": {
      body: '<g fill="currentColor"><path d="M18 8H4v2h14zm2 0h-2v12h2zM8 14h2v-2H8zm-2-2h2v-2H6zm0-4h2V6H6z"/><path d="M8 12h2V4H8z"/></g>'
    },
    "corner-up-right": {
      body: '<g fill="currentColor"><path d="M6 8h14v2H6zm-2 2h2v10H4zm12 4h-2v-2h2zm2-2h-2v-2h2zm0-4h-2V6h2z"/><path d="M16 12h-2V4h2z"/></g>'
    },
    "corner-up-right-sharp": {
      body: '<g fill="currentColor"><path d="M6 8h14v2H6zM4 8h2v12H4zm12 6h-2v-2h2zm2-2h-2v-2h2zm0-4h-2V6h2z"/><path d="M16 12h-2V4h2z"/></g>'
    },
    cpu: {
      body: '<path fill="currentColor" d="M5 3h14v2H5zm0 16h14v2H5zM3 5h2v14H3zm16 0h2v14h-2zM9 7h6v2H9zm0 8h6v2H9zM7 9h2v6H7zm8 0h2v6h-2zm-4-8h2v2h-2zm0 20h2v2h-2zM1 11h2v2H1zm20 0h2v2h-2zm0-4h2v2h-2zm0 8h2v2h-2zM1 15h2v2H1zm0-8h2v2H1zm6-6h2v2H7zm8 0h2v2h-2zm0 20h2v2h-2zm-8 0h2v2H7z"/>'
    },
    "cpu-sharp": {
      body: '<path fill="currentColor" d="M5 3h14v2H5zm0 16h14v2H5zM3 5h2v14H3zm16 0h2v14h-2zM7 7h10v2H7zm0 8h10v2H7zm0-6h2v6H7zm8 0h2v6h-2zm-4-8h2v2h-2zm0 20h2v2h-2zM1 11h2v2H1zm20 0h2v2h-2zm0-4h2v2h-2zm0 8h2v2h-2zM1 15h2v2H1zm0-8h2v2H1zm6-6h2v2H7zm8 0h2v2h-2zm0 20h2v2h-2zm-8 0h2v2H7z"/>'
    },
    "credit-card": {
      body: '<path fill="currentColor" d="M4 4h16v2H4zm0 14h16v2H4zM2 6h2v12H2zm18 0h2v12h-2zM4 8h16v4H4zm2 6h6v2H6z"/>'
    },
    "credit-card-delete": {
      body: '<path fill="currentColor" d="M20 4H2v16h12v-2H4v-6h16V8H4V6h16zm0 0h2v8h-2zm2 14h-2v-2h2v-2h-2v2h-2v-2h-2v2h2v2h-2v2h2v-2h2v2h2z"/>',
      hidden: true
    },
    "credit-card-minus": {
      body: '<path fill="currentColor" d="M20 4H2v16h12v-2H4v-6h16V8H4V6h16zm0 0h2v8h-2zm2 12h-6v2h6z"/>',
      hidden: true
    },
    "credit-card-multiple": {
      body: '<path fill="currentColor" d="M1 3h16v2H3v2h14v4H3v4h14v2H1zm18 0h-2v14h2zM5 19h16v2H5zM23 7h-2v14h2z"/>',
      hidden: true
    },
    "credit-card-plus": {
      body: '<path fill="currentColor" d="M2 4h18v2H4v2h16v4H4v6h10v2H2zm20 0h-2v8h2zm-4 10h2v2h2v2h-2v2h-2v-2h-2v-2h2z"/>',
      hidden: true
    },
    "credit-card-settings": {
      body: '<path fill="currentColor" d="M20 4H2v16h18v-2H4v-6h16V8H4V6h16zm0 0h2v16h-2zm-7 18h-2v2h2zm2 0h2v2h-2zm-6 0H7v2h2z"/>',
      hidden: true
    },
    "credit-card-sharp": {
      body: '<path fill="currentColor" d="M2 4h20v2H2zm0 14h20v2H2zM2 6h2v12H2zm18 0h2v12h-2zM4 8h16v4H4zm2 6h6v2H6z"/>'
    },
    "credit-card-wireless": {
      body: '<path fill="currentColor" d="M16 2H8v2H6v2h2V4h8v2h2V4h-2zM8 8h2v2H8zm6 0V6h-4v2zm0 0h2v2h-2zM4 11h16v12H4zm14 10v-3H6v3zm0-6v-2H6v2z"/>',
      hidden: true
    },
    crop: {
      body: '<path fill="currentColor" d="M8 2H6v4H2v2h14v14h2v-4h4v-2h-4V6H8zm0 8H6v8h8v-2H8z"/>',
      hidden: true
    },
    crown: {
      body: '<g fill="currentColor"><path d="M3 3h2v12H3zm16 0h2v12h-2zm-8 0h2v2h-2zM9 5h2v2H9zM5 5h2v2H5z"/><path d="M3 3h2v2H3zm4 4h2v2H7zm6-2h2v2h-2zm2 2h2v2h-2zm2-2h2v2h-2zM5 15h14v2H5zm-2 4h18v2H3z"/></g>'
    },
    "crown-sharp": {
      body: '<g fill="currentColor"><path d="M3 3h2v12H3zm16 0h2v12h-2zm-8 0h2v2h-2zM9 5h2v2H9zM5 5h2v2H5z"/><path d="M3 3h2v2H3zm4 4h2v2H7zm6-2h2v2h-2zm2 2h2v2h-2zm2-2h2v2h-2zM3 15h18v2H3zm0 4h18v2H3z"/></g>'
    },
    "cursor-minimal": {
      body: '<path fill="currentColor" d="M6 4h2v16H6zm2 0h2v2H8zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm-8 6h2v2H8zm2-2h2v2h-2zm2-2h6v2h-6z"/>'
    },
    cut: {
      body: '<g fill="currentColor"><path d="M1 17h2v4H1zm14 0h2v4h-2zM3 21h4v2H3zm14 0h4v2h-4zM3 15h4v2H3zm14 0h4v2h-4zM7 17h2v4H7zm14 0h2v4h-2zM7 15h2v2H7zm8 0h2v2h-2zm-6-2h2v2H9zm6 0h-2v2h2zm-4-2h2v2h-2z"/><path d="M13 11h-2v2h2zm0-2h2v2h-2zm-2 0H9v2h2zm4-2h2v2h-2zM9 7H7v2h2zm8-2h2v2h-2zM7 5H5v2h2zm12-2h2v2h-2zM5 3H3v2h2z"/></g>'
    },
    "cut-sharp": {
      body: '<g fill="currentColor"><path d="M1 15h2v8H1zm14 2h2v4h-2zM3 21h6v2H3zm12 0h6v2h-6zM3 15h4v2H3zm14 0h4v2h-4zM7 17h2v4H7zm14-2h2v8h-2zM7 15h2v2H7zm8 0h2v2h-2zm-6-2h2v2H9zm6 0h-2v2h2zm-4-2h2v2h-2z"/><path d="M13 11h-2v2h2zm0-2h2v2h-2zm-2 0H9v2h2zm4-2h2v2h-2zM9 7H7v2h2zm8-2h2v2h-2zM7 5H5v2h2zm12-2h2v2h-2zM5 3H3v2h2z"/></g>'
    },
    dashboard: {
      body: '<path fill="currentColor" d="M3 3h8v10H3zm2 2v6h4V5zm8-2h8v6h-8zm2 2v2h4V5zm-2 6h8v10h-8zm2 2v6h4v-6zM3 15h8v6H3zm2 2v2h4v-2z"/>',
      hidden: true
    },
    database: {
      body: '<path fill="currentColor" d="M2 6h2v4H2zm0 4h2v4H2zm0 4h2v4H2zm18-8h2v4h-2zm0 4h2v4h-2zm0 4h2v4h-2zM4 4h4v2H4zm0 8h4v-2H4zm0 4h4v-2H4zm0 4h4v-2H4zM16 4h4v2h-4zm0 8h4v-2h-4zm0 4h4v-2h-4zm0 4h4v-2h-4zM8 2h8v2H8zm0 12h8v-2H8zm0 4h8v-2H8zm0 4h8v-2H8z"/>'
    },
    "date-time": {
      body: '<path fill="currentColor" d="M21 23h-8v-2h8zM9 21H3v-2h6zm4 0h-2v-8h2zm10 0h-2v-8h2zM3 7h14V5h2v4H3v10H1V5h2zm15 10h2v2h-2v-1h-2v-4h2zm3-4h-8v-2h8zM7 3h6V1h2v2h2v2H3V3h2V1h2z"/>'
    },
    debug: {
      body: '<path fill="currentColor" d="M8 6h8v2H8zm0 14h8v2H8zM6 8h2v12H6zm10 0h2v12h-2zM4 8h2v2H4zm16 0h-2v2h2zM4 18h2v2H4zm16 0h-2v2h2zM2 20h2v2H2zm20 0h-2v2h2zM2 6h2v2H2zm20 0h-2v2h2zM2 13h4v2H2zm20 0h-4v2h4zM6 2h2v2H6zm2 2h2v2H8zm6 0h2v2h-2zm2-2h2v2h-2zm-6 8h4v2h-4zm0 4h4v2h-4z"/>'
    },
    "debug-check": {
      body: '<path fill="currentColor" d="M8 2H6v2h2v2H6v3H4V7H2v2h2v2h2v2H2v2h4v2H4v2H2v2h2v-2h2v3h6v-2H8V8h8v6h2v-3h2V9h2V7h-2v2h-2V6h-2V4h2V2h-2v2h-2v2h-4V4H8zm6 9h-4v2h4zm-4 4h2v2h-2zm4 3h2v2h-2zm4 2v2h-2v-2zm2-2h-2v2h2zm0 0v-2h2v2z"/>',
      hidden: true
    },
    "debug-off": {
      body: '<path fill="currentColor" d="M16 2h2v2h-2zm4 7h-2V6h-2V4h-2v2h-2v2h4v5h2v2h4v-2h-4v-2h2zm0 0V7h2v2zM8 20v-9H6V9H4V7H2v2h2v2h2v2H2v2h4v2H4v2H2v2h2v-2h2v3h10v-2zm2-5h2v2h-2zM2 2h2v2H2zm4 4H4V4h2zm2 2H6V6h2zm2 2H8V8h2zm0 0v2h2v2h2v2h2v2h2v2h2v2h2v-2h-2v-2h-2v-2h-2v-2h-2v-2h-2v-2z"/>',
      hidden: true
    },
    "debug-pause": {
      body: '<path fill="currentColor" d="M8 2H6v2h2v2H6v3H4V7H2v2h2v2h2v2H2v2h4v2H4v2H2v2h2v-2h2v3h8v-2H8V8h8v6h2v-3h2V9h2V7h-2v2h-2V6h-2V4h2V2h-2v2h-2v2h-4V4H8zm6 9h-4v2h4zm-4 4h4v2h-4zm6 1h2v6h-2zm6 0h-2v6h2z"/>',
      hidden: true
    },
    "debug-play": {
      body: '<path fill="currentColor" d="M6 2h2v2H6zm10 2h-2v2h-4V4H8v2H6v3H4V7H2v2h2v2h2v2H2v2h4v2H4v2H2v2h2v-2h2v3h8v-2H8V8h8v3h4V9h2V7h-2v2h-2V6h-2zm0 0V2h2v2zm-6 7h4v2h-4zm4 4h-4v2h4zm4-2h-2v10h2v-2h2v-2h2v-2h-2v-2h-2z"/>',
      hidden: true
    },
    "debug-stop": {
      body: '<path fill="currentColor" d="M6 2h2v2H6zm10 2h-2v2h-4V4H8v2H6v3H4V7H2v2h2v2h2v2H2v2h4v2H4v2H2v2h2v-2h2v3h8v-2H8V8h8v6h2v-3h2V9h2V7h-2v2h-2V6h-2zm0 0V2h2v2zm-6 7h4v2h-4zm4 4h-4v2h4zm8 1h-6v6h6z"/>',
      hidden: true
    },
    delete: {
      body: '<path fill="currentColor" d="M6 7h2v2H6zm14 0h2v10h-2zM8 5h12v2H8zM4 9h2v2H4zm-2 2h2v2H2zm2 2h2v2H4zm2 2h2v2H6zm2 2h12v2H8zm6-6h2v2h-2zm2 2h2v2h-2zm0-4h2v2h-2zm-4 4h2v2h-2zm0-4h2v2h-2z"/>'
    },
    "delete-sharp": {
      body: '<path fill="currentColor" d="M6 7h2v2H6zm14 0h2v10h-2zM8 5h14v2H8zM4 9h2v2H4zm-2 2h2v2H2zm2 2h2v2H4zm2 2h2v2H6zm2 2h14v2H8zm6-6h2v2h-2zm2 2h2v2h-2zm0-4h2v2h-2zm-4 4h2v2h-2zm0-4h2v2h-2z"/>'
    },
    deskphone: {
      body: '<path fill="currentColor" d="M3 3h18v18H3zm2 2v6h8V5zm10 0v14h4V5zm-2 14v-2h-3v2zm-5 0v-2H5v2zm-3-4h3v-2H5zm5-2v2h3v-2z"/>',
      hidden: true
    },
    "device-laptop": {
      body: '<path fill="currentColor" d="M6 4H4v12h16V4zm12 2v8H6V6zm4 12H2v2h20z"/>',
      hidden: true
    },
    "device-phone": {
      body: '<path fill="currentColor" d="M6 3h12v18H6zm10 16V5h-2v2h-4V5H8v14zm-5-4h2v2h-2z"/>',
      hidden: true
    },
    "device-tablet": {
      body: '<path fill="currentColor" d="M6 2H4v20h16V2zm12 2v16H6V4zm-5 12h-2v2h2z"/>',
      hidden: true
    },
    "device-tv": {
      body: '<path fill="currentColor" d="M2 20h20V6h-7V4h-2v2h-2V4H9v2H2zM9 4V2H7v2zm6 0h2V2h-2zm5 4v10H4V8z"/>',
      hidden: true
    },
    "device-tv-smart": {
      body: '<path fill="currentColor" d="M4 4h18v14h-6v2H8v-2H2V4zm16 12V6H4v10z"/>',
      hidden: true
    },
    "device-vibrate": {
      body: '<path fill="currentColor" d="M8 3H6v18h12V3zm8 2v14H8V5zm-3 10h-2v2h2zm7-8h2v2h-2zm2 4V9h2v2zm0 2h-2v-2h2zm0 2v-2h2v2zm0 0v2h-2v-2zM2 17h2v-2H2v-2h2v-2H2V9h2V7H2v2H0v2h2v2H0v2h2z"/>',
      hidden: true
    },
    "device-watch": {
      body: '<path fill="currentColor" d="M8 2h8v4h5v12h-5v4H8v-4H3V6h5zM5 16h14V8H5zm6-6h2v2h2v2h-4z"/>',
      hidden: true
    },
    devices: {
      body: '<path fill="currentColor" d="M2 2h16v6h4v14H12v-6H2zm14 6V4H4v10h8V8zm-6-2H6v2h4zm10 14V10h-6v10zm-4-4h2v2h-2zM6 10h4v2H6z"/>',
      hidden: true
    },
    "diamond-gem": {
      body: '<path fill="currentColor" d="M7 1h10v2H7zM5 3h2v2H5zm12 0h2v2h-2zm2 2h2v2h-2zm0 8h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2h-2zm-2-2h2v2H9zm-2-2h2v2H7zm-2-2h2v2H5zm-2-2h2v2H3zm0-8h2v2H3zM1 7h2v6H1zm20 0h2v6h-2zM3 9h18v2H3zm6-6h2v3H9zM7 6h2v3H7zm8 0h2v3h-2zm-8 5h2v2H7zm2 2h2v3H9zm2 3h2v3h-2zm2-3h2v3h-2zm2-2h2v2h-2zm-2-8h2v3h-2z"/>'
    },
    dice: {
      body: '<path fill="currentColor" d="M5 3H3v18h18V3zm14 2v14H5V5zM9 7H7v2h2zm6 0h2v2h-2zm-6 8H7v2h2zm6 0h2v2h-2zm-2-4h-2v2h2z"/>',
      hidden: true
    },
    directions: {
      body: '<g fill="currentColor"><path d="M2 2h2v2H2zm2 2h2v2H4zm2-2h2v2H6zM2 6h2v2H2zm4 0h2v2H6zm11 9h3v2h-3zm-2 2h2v3h-2zm2 3h3v2h-3zm3-3h2v3h-2zM15 2h2v10h-2zm-2 2h2v2h-2z"/><path d="M11 6h9v2h-9z"/><path d="M19 6h2v2h-2zm-2-2h2v2h-2zM6 12h9v2H6zm-2 2h2v4H4zm0 6h2v2H4z"/></g>'
    },
    "directions-sharp": {
      body: '<g fill="currentColor"><path d="M2 2h2v2H2zm2 2h2v2H4zm2-2h2v2H6zM2 6h2v2H2zm4 0h2v2H6zm11 9h3v2h-3zm-2 2h2v3h-2zm2 3h3v2h-3zm3-3h2v3h-2zM15 2h2v10h-2zm-2 2h2v2h-2z"/><path d="M11 6h9v2h-9z"/><path d="M19 6h2v2h-2zm-2-2h2v2h-2zM4 12h13v2H4zm0 2h2v4H4zm0 6h2v2H4z"/></g>'
    },
    dock: {
      body: '<path fill="currentColor" d="M4 4h16v2H4zm0 14h16v2H4zM2 6h2v12H2zm18 0h2v12h-2zM4 8h16v2H4zm2 6h12v2H6z"/>'
    },
    "dock-sharp": {
      body: '<path fill="currentColor" d="M2 4h20v2H2zm0 14h20v2H2zM2 6h2v12H2zm18 0h2v12h-2zM4 8h16v2H4zm2 6h12v2H6z"/>'
    },
    dollar: {
      body: '<path fill="currentColor" d="M11 2h2v4h6v2H7v3H5V6h6zM5 18h6v4h2v-4h6v-2H5zm14-7H5v2h12v3h2z"/>',
      hidden: true
    },
    "door-closed": {
      body: '<path fill="currentColor" d="M3 19h18v2H3zM5 5h2v14H5zm2-2h10v2H7zm10 2h2v14h-2zm-8 6h2v2H9z"/>'
    },
    "door-closed-sharp": {
      body: '<path fill="currentColor" d="M3 19h18v2H3zM5 5h2v14H5zm0-2h14v2H5zm12 2h2v14h-2zm-8 6h2v2H9z"/>'
    },
    downasaur: {
      body: '<path fill="currentColor" d="M6 4h14v2h2v6h-8v2h6v2h-4v2h-2v2H2V8h2V6h2zm2 6h2V8H8z"/>',
      hidden: true
    },
    download: {
      body: '<g fill="currentColor"><path d="M21 15v4h-2v-4zm-2 4v2H5v-2zM5 15v4H3v-4zm8-12v14h-2V3z"/><path d="M7 11v2h10v-2zm2 2v2h2v-2zm4 0v2h2v-2z"/><path d="M15 11v2h2v-2z"/></g>'
    },
    "download-sharp": {
      body: '<g fill="currentColor"><path d="M21 15v4h-2v-4zm0 4v2H3v-2zM5 15v4H3v-4zm8-12v14h-2V3z"/><path d="M7 11v2h10v-2zm2 2v2h2v-2zm4 0v2h2v-2z"/><path d="M15 11v2h2v-2z"/></g>'
    },
    draft: {
      body: '<path fill="currentColor" d="M14 2h-4v2H8v2H6v2H4v2H2v12h20V10h-2V8h-2V6h-2V4h-2zm0 2v2h2v2h2v4h-2v2h-2v2h-4v-2H8v-2H6V8h2V6h2V4zm-8 8v2h2v2h2v2h4v-2h2v-2h2v-2h2v8H4v-8z"/>',
      hidden: true
    },
    "drag-and-drop": {
      body: '<path fill="currentColor" d="M5 3H3v2h2zm14 4h2v6h-2V9H9v10h4v2H7V7zM7 3h2v2H7zM5 7H3v2h2zm-2 4h2v2H3zm2 4H3v2h2zm6-12h2v2h-2zm6 0h-2v2h2zm-2 14v-2h6v2h-2v2h-2v2h-2zm4 2v2h2v-2z"/>',
      hidden: true
    },
    drop: {
      body: '<path fill="currentColor" d="M13 2h-2v2H9v4H7v4H5v6h2v2h2v2h6v-2h2v-2h2v-6h-2V8h-2V4h-2zm0 2v4h2v4h2v6h-2v2H9v-2H7v-6h2V8h2V4z"/>',
      hidden: true
    },
    "drop-area": {
      body: '<path fill="currentColor" d="M5 3H3v2h2zm2 0h2v2H7zm6 0h-2v2h2zm2 0h2v2h-2zm4 0h2v2h-2zM3 7h2v2H3zm2 4H3v2h2zm-2 4h2v2H3zm2 4H3v2h2zm2 0h2v2H7zm6 0h-2v2h2zm6-8h2v2h-2zm2-4h-2v2h2zm-6 10v-2h6v2h-2v2h-2v2h-2zm4 2v2h2v-2z"/>',
      hidden: true
    },
    "drop-full": {
      body: '<path fill="currentColor" d="M11 2h2v2h2v4h2v4h2v6h-2v2h-2v2H9v-2H7v-2H5v-6h2V8h2V4h2z"/>',
      hidden: true
    },
    "drop-half": {
      body: '<path fill="currentColor" d="M13 2h-2v2H9v4H7v4H5v6h2v2h2v2h6v-2h2v-2h2v-6h-2V8h-2V4h-2zm0 2v4h2v4h2v3H7v-3h2V8h2V4z"/>',
      hidden: true
    },
    drum: {
      body: '<path fill="currentColor" d="M8 3h8v2H8zm0 10h8v2H8zm0 6h8v2H8zm-4-8h4v2H4zm0 6h4v2H4zm16-6h-4v2h4zm0 6h-4v2h4zM2 7h2v4H2zm0 4h2v6H2zm20-4h-2v4h2zm0 4h-2v6h2zM6 5h2v2H6zM4 3h2v2H4zM2 1h2v2H2zm6 6h2v2H8zm4 2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2z"/>'
    },
    duplicate: {
      body: '<path fill="currentColor" d="M5 3h12v4h4v14H7v-4H3V3zm10 4V5H5v10h2V7zM9 17v2h10V9H9z"/>',
      hidden: true
    },
    "duplicate-alt": {
      body: '<path fill="currentColor" d="M5 1H3v14h10v2h-2v2h2v-2h2v-2h2v-2h-2v-2h-2V9h-2v2h2v2H5V3h12V1zm4 4H7v6h2V7h10v14H9v-4H7v6h14V5z"/>',
      hidden: true
    },
    earth: {
      body: '<path fill="currentColor" d="M6 2h12v2H6zm0 18h12v2H6zM18 4h2v2h-2zM4 18h2v2H4zM4 4h2v2H4zm14 14h2v2h-2zM2 6h2v12H2zm18 0h2v12h-2zM8 4h2v4H8zm2 4h4v2h-4zm4 2h4v2h-4zm4-2h2v2h-2zM4 12h2v2H4zm6 4h2v4h-2zm-4-2h4v2H6zm8 2h2v4h-2zm2-2h4v2h-4z"/>'
    },
    edit: {
      body: '<path fill="currentColor" d="M18 2h-2v2h-2v2h-2v2h-2v2H8v2H6v2H4v2H2v6h6v-2h2v-2h2v-2h2v-2h2v-2h2v-2h2V8h2V6h-2V4h-2zm0 8h-2v2h-2v2h-2v2h-2v2H8v-2H6v-2h2v-2h2v-2h2V8h2V6h2v2h2zM6 16H4v4h4v-2H6z"/>',
      hidden: true
    },
    "edit-box": {
      body: '<path fill="currentColor" d="M18 2h-2v2h2zM4 4h6v2H4v14h14v-6h2v8H2V4zm4 8H6v6h6v-2h2v-2h-2v2H8zm4-2h-2v2H8v-2h2V8h2V6h2v2h-2zm2-6h2v2h-2zm4 0h2v2h2v2h-2v2h-2v2h-2v-2h2V8h2V6h-2zm-4 8h2v2h-2z"/>',
      hidden: true
    },
    estate: {
      body: '<path fill="currentColor" d="M2 20h20v2H2zM2 4h2v16H2zm2-2h8v2H4zm8 2h2v16h-2zM6 6h4v2H6zm0 4h4v2H6zm1 6h2v4H7zm11-6h2v2h-2zm2 2h2v4h-2zm-4 0h2v4h-2zm2 4h2v4h-2z"/>'
    },
    "estate-sharp": {
      body: '<path fill="currentColor" d="M2 20h20v2H2zM2 4h2v16H2zm0-2h12v2H2zm10 2h2v16h-2zM6 6h4v2H6zm0 4h4v2H6zm1 6h2v4H7zm9-6h6v2h-6zm4 2h2v6h-2zm-4 0h2v6h-2zm2 4h2v4h-2z"/>'
    },
    euro: {
      body: '<path fill="currentColor" d="M9 4h10v2H9v3h7v2H9v2h7v2H9v3h10v2H7v-5H5v-2h2v-2H5V9h2V4z"/>',
      hidden: true
    },
    expand: {
      body: '<path fill="currentColor" d="M4 13h16v-2H4zm7-8h2V3h-2zM9 7h4V5H9zm4 0h2V5h-2zm2 2h2V7h-2zM7 9h8V7H7zm4 10h2v2h-2zm-2-2h4v2H9zm4 0h2v2h-2zm2-2h2v2h-2zm-8 0h8v2H7z"/>'
    },
    "external-link": {
      body: '<g fill="currentColor"><path d="M11 5H5v2h6zM5 7H3v12h2zm12 12H5v2h12zm2-6h-2v6h2zm-8 0H9v2h2zm2-2h-2v2h2zm2-2h-2v2h2zm2-2h-2v2h2zm2-2h-2v2h2zm2-2h-2v8h2z"/><path d="M21 3h-8v2h8z"/></g>'
    },
    "external-link-sharp": {
      body: '<g fill="currentColor"><path d="M11 5H3v2h8zM5 7H3v12h2zm14 12H3v2h16zm0-6h-2v6h2zm-8 0H9v2h2zm2-2h-2v2h2zm2-2h-2v2h2zm2-2h-2v2h2zm2-2h-2v2h2zm2-2h-2v8h2z"/><path d="M21 3h-8v2h8z"/></g>'
    },
    eye: {
      body: '<path fill="currentColor" d="M16 20H8v-2h8zm-8-2H4v-2h4zm12 0h-4v-2h4zM4 16H2v-2h2zm10-6h-2v2h2zh2v4h-2v2h-4v-2H8v-4h2V8h4zm8 6h-2v-2h2zM2 14H0v-4h2zm22 0h-2v-4h2zM4 10H2V8h2zm18 0h-2V8h2zM8 8H4V6h4zm12 0h-4V6h4zm-4-2H8V4h8z"/>'
    },
    "eye-closed": {
      body: '<path fill="currentColor" d="M0 7h2v2H0zm4 4H2V9h2zm4 2v-2H4v2H2v2h2v-2zm8 0H8v2H6v2h2v-2h8v2h2v-2h-2zm4-2h-4v2h4v2h2v-2h-2zm2-2v2h-2V9zm0 0V7h2v2z"/>',
      hidden: true
    },
    "eye-off": {
      body: '<g fill="currentColor"><path d="M0 10h2v4H0zm24 0h-2v4h2zm-8 0h-2v2h2zm-6 0H8v4h2zM2 8h2v2H2zm0 8h2v-2H2zm20-8h-2v2h2zm0 8h-2v-2h2zM4 6h4v2H4zm0 12h4v-2H4zM20 6h-4v2h4zM10 4h6v2h-6zM8 20h8v-2H8zm4-12h2v2h-2zm-2 6h4v2h-4zM8 8h2v2H8zm2 2h2v4h-2zm2 2h2v2h-2z"/><path d="M6 6h2v2H6zM4 4h2v2H4zM2 2h2v2H2zm12 12h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2z"/></g>'
    },
    factory: {
      body: '<path fill="currentColor" d="M2 4h2v16H2zm2 16h16v2H4zM20 7h2v13h-2zm-2 0h2v2h-2zm-6 0h2v2h-2zm4 2h2v2h-2zm-6 0h2v2h-2zm4-2h2v6h-2zM8 4h2v9H8zM4 2h6v2H4zm3 13h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2z"/>'
    },
    "factory-sharp": {
      body: '<path fill="currentColor" d="M2 2h2v20H2zm2 18h16v2H4zM20 7h2v15h-2zm-2 0h2v2h-2zm-6 0h2v2h-2zm4 2h2v2h-2zm-6 0h2v2h-2zm4-2h2v6h-2zM8 4h2v9H8zM4 2h6v2H4zm3 13h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2z"/>'
    },
    feather: {
      body: '<path fill="currentColor" d="M2 20h2v2H2zm6-2h6v2H8zm-2-2h2v2H6zm-2 2h2v2H4zm4-4h2v2H8zm2-2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm0 8h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm2-6h2v6h-2zm-2-2h2v2h-2zM4 10h2v6H4zm2-2h2v2H6zm2-2h2v2H8zm2-2h2v2h-2zm2-2h6v2h-6z"/>'
    },
    file: {
      body: '<g fill="currentColor"><path d="M6 4H4v16h2zm10-2H6v2h10zm4 4h-2v14h2zm-2 14H6v2h12zM16 4h2v2h-2zm-4 0h2v6h-2z"/><path d="M12 8h6v2h-6z"/></g>'
    },
    "file-alt": {
      body: '<path fill="currentColor" d="M21 22H3V2h12v2h2v2h2v2h2zM17 6h-2v2h2zM5 4v16h14V10h-6V4zm8 12H7v2h6zm-6-4h10v2H7zm4-4H7v2h4z"/>',
      hidden: true
    },
    "file-delete": {
      body: '<path fill="currentColor" d="M11 22h10V8h-2V6h-2v2h-2V6h2V4h-2V2H3v12h2V4h8v6h6v10h-8zm-4-2H5v2H3v-2h2v-2H3v-2h2v2h2v-2h2v2H7zm0 0h2v2H7z"/>',
      hidden: true
    },
    "file-flash": {
      body: '<path fill="currentColor" d="M19 22h-6v-2h6V10h-6V4H5v8H3V2h12v2h2v2h2v2h2v14zM17 6h-2v2h2zM7 12h2v4h4v2h-2v2H9v2H7v-4H3v-2h2v-2h2z"/>',
      hidden: true
    },
    "file-minus": {
      body: '<path fill="currentColor" d="M13 22h8V8h-2V6h-2v2h-2V6h2V4h-2V2H3v13h2V4h8v6h6v10h-6zm-2-3H3v-2h8z"/>',
      hidden: true
    },
    "file-multiple": {
      body: '<path fill="currentColor" d="M21 18H7V2h8v2h2v2h-2v2h2V6h2v2h2zM9 4v12h10v-6h-6V4zM3 6h2v14h12v2H3z"/>',
      hidden: true
    },
    "file-off": {
      body: '<path fill="currentColor" d="M5 2H3v2h2v2h2v2h2v2h2v2h2v2h2v2h2v2h2v2h2v2h2v-2h-2v-2h-2v-2h-2v-2h-2v-2h-2v-2h6v4h2V8h-2V6h-2V4h-2V2H9v2h4v6h-2V8H9V6H7V4H5zm12 4v2h-2V6zM3 8h2v12h12v2H3z"/>',
      hidden: true
    },
    "file-plus": {
      body: '<path fill="currentColor" d="M19 22h-7v-2h7V10h-6V4H5v8H3V2h12v2h2v2h2v2h2v14zM17 6h-2v2h2zM8 19h3v-2H8v-3H6v3H3v2h3v3h2z"/>',
      hidden: true
    },
    "file-sharp": {
      body: '<g fill="currentColor"><path d="M6 4H4v16h2zm10-2H4v2h12zm4 4h-2v14h2zm0 14H4v2h16zM16 4h2v2h-2zm-4 0h2v6h-2z"/><path d="M12 8h6v2h-6z"/></g>'
    },
    "file-text": {
      body: '<g fill="currentColor"><path d="M6 4H4v16h2zm10-2H6v2h10zm4 4h-2v14h2zm-2 14H6v2h12zM16 4h2v2h-2zm-4 0h2v6h-2z"/><path d="M12 8h6v2h-6zm-4 8h8v2H8zm0-4h8v2H8zm0-4h2v2H8z"/></g>'
    },
    "file-text-sharp": {
      body: '<g fill="currentColor"><path d="M6 4H4v16h2zm10-2H4v2h12zm4 4h-2v14h2zm0 14H4v2h16zM16 4h2v2h-2zm-4 0h2v6h-2z"/><path d="M12 8h6v2h-6zm-4 8h8v2H8zm0-4h8v2H8zm0-4h2v2H8z"/></g>'
    },
    files: {
      body: '<g fill="currentColor"><path d="M9 3H7v14h2zM5 7H3v14h2zm12-6H9v2h8zm4 4h-2v12h2zm-2 12H9v2h10zm-4 4H5v2h10zm2-18h2v2h-2zm-4 0h2v6h-2z"/><path d="M13 7h6v2h-6zM5 5h2v2H5zm10 14h2v2h-2z"/></g>'
    },
    "files-sharp": {
      body: '<g fill="currentColor"><path d="M9 3H7v14h2zM5 7H3v14h2zm12-6H9v2h8zm4 4h-2v12h2zm-2 12H9v2h10zm-4 4H5v2h10zm2-18h2v2h-2zm-4 0h2v6h-2z"/><path d="M13 7h6v2h-6zM5 5h2v2H5zm10 14h2v2h-2z"/></g>'
    },
    fill: {
      body: '<path fill="currentColor" d="M9 2h2v2H9zm4 4V4h-2v2H9v2H7v2H5v2H3v2h2v2h2v2h2v2h2v2h2v-2h2v-2h2v-2h2v6h2V12h-2v-2h-2V8h-2V6zm0 0v2h2v2h2v2h2v2h-2v2h-2v2h-2v2h-2v-2H9v-2H7v-2H5v-2h2v-2h2V8h2V6z"/>',
      hidden: true
    },
    "fill-half": {
      body: '<path fill="currentColor" d="M9 2h2v2H9zm4 4V4h-2v2H9v2H7v2H5v2H3v2h2v2h2v2h2v2h2v2h2v-2h2v-2h2v-2h2v6h2V12h-2v-2h-2V8h-2V6zm0 0v2h2v2h2v2h2v2H5v-2h2v-2h2V8h2V6z"/>',
      hidden: true
    },
    filter: {
      body: '<path fill="currentColor" d="M11 20h2v2H9V12h2zm4 0h-2v-8h2zm-6-8H7v-2h2zm8 0h-2v-2h2zM7 10H5V8h2zm12 0h-2V8h2zm2-2h-2V4H5v4H3V2h18z"/>'
    },
    fire: {
      body: '<g fill="currentColor"><path d="M9 2h2v4H9zM7 6h2v2H7zM5 8h2v2H5zm8 2h2v2h-2zm2-2h2v2h-2zm2 2h2v2h-2zm2 2h2v6h-2zM3 10h2v8H3zm8-4h2v4h-2zm6 12h2v2h-2zM7 20h10v2H7zm-2-2h2v2H5zm4-2h6v4H9z"/><path d="M11 14h2v3h-2z"/></g>'
    },
    fish: {
      body: '<path fill="currentColor" d="M20 9h2v6h-2zm-2-2h2v2h-2zm0 8h2v2h-2zm-6 2h6v2h-6zm0-12h6v2h-6zM2 7h2v10H2zm2 2h2v2H4zm0 4h2v2H4zm2-2h2v2H6zm2-2h2v2H8zm0 4h2v2H8zm2 2h2v2h-2zm0-8h2v2h-2zm5 3h2v2h-2z"/>'
    },
    flag: {
      body: '<g fill="currentColor"><path d="M4 2h2v20H4z"/><path d="M4 4h16v2H4zm12 2h2v2h-2zm-2 2h2v2h-2zm2 2h2v2h-2zM4 12h16v2H4z"/></g>'
    },
    flatten: {
      body: '<g fill="currentColor"><path d="M4 16h16v2H4zm4 4h8v2H8zm3-18h2v12h-2z"/><path d="M9 10h6v2H9zM7 8h10v2H7z"/></g>'
    },
    "flip-horizontal-2": {
      body: '<path fill="currentColor" d="M11 7h2v4h-2zm0-6h2v4h-2zm0 12h2v4h-2zm0 6h2v4h-2zm-4-8h2v2H7zm10 0h-2v2h2zM5 13h2v2H5zm14 0h-2v2h2zM5 9h2v4H5zm14 0h-2v4h2zM3 7h2v10H3zm18 0h-2v10h2z"/>'
    },
    "flip-to-back": {
      body: '<path fill="currentColor" d="M9 3H7v2h2zm0 12H7v2h2zm2-12h2v2h-2zm2 12h-2v2h2zm2-12h2v2h-2zm2 12h-2v2h2zm2-12h2v2h-2zm2 4h-2v2h2zM7 7h2v2H7zm14 4h-2v2h2zM7 11h2v2H7zm14 4h-2v2h2zM3 7h2v12h12v2H3z"/>',
      hidden: true
    },
    "flip-to-front": {
      body: '<path fill="currentColor" d="M21 3H7v14h14zm-2 12H9V5h10zM5 7H3v2h2zm-2 4h2v2H3zm2 4H3v2h2zm-2 4h2v2H3zm6 0H7v2h2zm2 0h2v2h-2zm6 0h-2v2h2z"/>',
      hidden: true
    },
    "flip-vertical-2": {
      body: '<path fill="currentColor" d="M17 11v2h-4v-2zm6 0v2h-4v-2zm-12 0v2H7v-2zm-6 0v2H1v-2zm8-4v2h-2V7zm0 10v-2h-2v2zm0-12v2H9V5zm0 14v-2H9v2zm2-14v2h-2V5zm0 14v-2h-2v2zm2-16v2H7V3zm0 18v-2H7v2z"/>'
    },
    "float-center": {
      body: '<path fill="currentColor" d="M18 6h4v2h-4zm0 4h4v2h-4zM2 6h4v2H2zm0 4h4v2H2zm0 4h20v2H2zm0 4h20v2H2zm8-14h4v2h-4zm0 6h4v2h-4zM8 6h2v4H8zm6 0h2v4h-2z"/>'
    },
    "float-center-sharp": {
      body: '<path fill="currentColor" d="M18 6h4v2h-4zm0 4h4v2h-4zM2 6h4v2H2zm0 4h4v2H2zm0 4h20v2H2zm0 4h20v2H2zM8 4h8v2H8zm0 6h8v2H8zm0-4h2v4H8zm6 0h2v4h-2z"/>'
    },
    "float-left": {
      body: '<path fill="currentColor" d="M12 6h10v2H12zm0 4h10v2H12zM2 14h20v2H2zm0 4h20v2H2zM4 4h4v2H4zm0 6h4v2H4zM2 6h2v4H2zm6 0h2v4H8z"/>'
    },
    "float-left-sharp": {
      body: '<path fill="currentColor" d="M12 6h10v2H12zm0 4h10v2H12zM2 14h20v2H2zm0 4h20v2H2zM2 4h8v2H2zm0 6h8v2H2zm0-4h2v4H2zm6 0h2v4H8z"/>'
    },
    "float-right": {
      body: '<path fill="currentColor" d="M2 6h10v2H2zm0 4h10v2H2zm0 4h20v2H2zm0 4h20v2H2zM16 4h4v2h-4zm0 6h4v2h-4zm-2-4h2v4h-2zm6 0h2v4h-2z"/>'
    },
    "float-right-sharp": {
      body: '<path fill="currentColor" d="M2 6h10v2H2zm0 4h10v2H2zm0 4h20v2H2zm0 4h20v2H2zM14 4h8v2h-8zm0 6h8v2h-8zm0-4h2v4h-2zm6 0h2v4h-2z"/>'
    },
    folder: {
      body: '<path fill="currentColor" d="M4 4h6v2H4zm0 14h16v2H4zM20 8h2v10h-2zM2 6h2v12H2zm8 0h10v2H10z"/>'
    },
    "folder-minus": {
      body: '<path fill="currentColor" d="M12 4H2v16h20V6H12zm-2 4h10v10H4V6h6zm8 6v-2h-6v2z"/>',
      hidden: true
    },
    "folder-plus": {
      body: '<g fill="currentColor"><path d="M4 4h6v2H4zm0 14h10v2H4zM20 8h2v6h-2zM2 6h2v12H2zm8 0h10v2H10zm12 12v2h-6v-2z"/><path d="M18 16h2v6h-2z"/></g>'
    },
    "folder-plus-sharp": {
      body: '<g fill="currentColor"><path d="M2 4h10v2H2zm0 14h12v2H2zM20 6h2v8h-2zM2 6h2v12H2zm8 0h10v2H10zm12 12v2h-6v-2z"/><path d="M18 16h2v6h-2z"/></g>'
    },
    "folder-sharp": {
      body: '<path fill="currentColor" d="M2 4h10v2H2zm0 14h20v2H2zM20 6h2v12h-2zM2 6h2v12H2zm8 0h10v2H10z"/>'
    },
    "folder-x": {
      body: '<path fill="currentColor" d="M12 4H2v16h20V6H12zm-2 4h10v10H4V6h6zm6 4h-2v-2h-2v2h2v2h-2v2h2v-2h2v2h2v-2h-2zm0 0h2v-2h-2z"/>',
      hidden: true
    },
    forward: {
      body: '<path fill="currentColor" d="M2 11h2v6H2zm2 6h2v2H4zm2-2h4v2H6zm0-8h4v2H6zm4 8h2v6h-2zm0-12h2v6h-2zm2 16h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm-2-2h2v2h-2zm-2-2h2v2h-2zm-2-2h2v2h-2zm-2-2h2v2h-2zM4 9h2v2H4z"/>'
    },
    "forward-sharp": {
      body: '<g fill="currentColor"><path d="M2 7h2v12H2zm0 12h6v2H2zm4-4h4v2H6zM4 7h6v2H4zm6 8h2v6h-2z"/><path d="M6 15h2v6H6zm4-12h2v6h-2zm2 16h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm-2-2h2v2h-2zm-2-2h2v2h-2zm-2-2h2v2h-2zm-2-2h2v2h-2z"/></g>'
    },
    forwardburger: {
      body: '<path fill="currentColor" d="M13 7H3v2h10zm8 4h-2V9h-2V7h-2v2h2v2H3v2h14v2h-2v2h2v-2h2v-2h2zM3 15h10v2H3z"/>',
      hidden: true
    },
    frame: {
      body: '<g fill="currentColor"><g clip-path="url(#SVGHcSWxdhd)"><path d="M5 2h2v20H5zm12 0h2v20h-2z"/><path d="M2 5h20v2H2zm0 12h20v2H2z"/><path d="M5 2h2v20H5zm12 0h2v11h-2z"/><path d="M2 5h20v2H2zm0 12h11v2H2zm13 0h6v2h-6z"/><path d="M17 15h2v6h-2z"/></g><defs><clipPath id="SVGHcSWxdhd"><path fill="#fff" d="M0 0h24v24H0z"/></clipPath></defs></g>'
    },
    "frame-add": {
      body: '<path fill="currentColor" d="M2 3h20v18H2zm18 16V7H4v12zm-7-7h3v2h-3v3h-2v-3H8v-2h3V9h2z"/>',
      hidden: true
    },
    "frame-check": {
      body: '<path fill="currentColor" d="M2 3h20v18H2zm18 16V7H4v12zm-4-9h-2v2h-2v2h-2v-2H8v2h2v2h2v-2h2v-2h2z"/>',
      hidden: true
    },
    "frame-delete": {
      body: '<path fill="currentColor" d="M2 3h20v18H2zm18 16V7H4v12zM9 10h2v2H9zm4 2h-2v2H9v2h2v-2h2v2h2v-2h-2zm0 0v-2h2v2z"/>',
      hidden: true
    },
    "frame-minus": {
      body: '<path fill="currentColor" d="M2 3h20v18H2zm18 16V7H4v12zM8 12h8v2H8z"/>',
      hidden: true
    },
    frown: {
      body: '<path fill="currentColor" d="M6 20h12v2H6zM6 2h12v2H6zm12 2h2v2h-2zM4 4h2v2H4zm0 14h2v2H4zm14 0h2v2h-2zM2 6h2v12H2zm18 0h2v12h-2zM8 8h2v2H8zm6 0h2v2h-2zm-7 7h2v2H7zm2-2h6v2H9zm6 2h2v2h-2z"/>'
    },
    "gallery-thumbnails": {
      body: '<path fill="currentColor" d="M4 2h16v2H4zM2 4h2v12H2zm2 12h16v2H4zM20 4h2v12h-2zM3 20h3v2H3zm5 0h3v2H8zm5 0h3v2h-3zm5 0h3v2h-3z"/>'
    },
    "gallery-thumbnails-sharp": {
      body: '<path fill="currentColor" d="M4 2h16v2H4zM2 2h2v16H2zm2 14h16v2H4zM20 2h2v16h-2zM3 20h3v2H3zm5 0h3v2H8zm5 0h3v2h-3zm5 0h3v2h-3z"/>'
    },
    gamepad: {
      body: '<g fill="currentColor"><path d="M4 4h16v2H4zm0 14h16v2H4zM2 6h2v12H2zm18 0h2v12h-2zM8 9h2v6H8z"/><path d="M6 11h6v2H6zm8-2h2v2h-2zm2 4h2v2h-2z"/></g>'
    },
    "gamepad-sharp": {
      body: '<g fill="currentColor"><path d="M4 4h16v2H4zm0 14h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zM8 9h2v6H8z"/><path d="M6 11h6v2H6zm8-2h2v2h-2zm2 4h2v2h-2z"/></g>'
    },
    gif: {
      body: '<path fill="currentColor" d="M3 7h6v2H3v6h4v-2H5v-2h4v6H1V7zm14 0h6v2h-6v2h4v2h-4v4h-2V7zm-4 0h-2v10h2z"/>',
      hidden: true
    },
    gift: {
      body: '<path fill="currentColor" d="M4 6h16v2H4zM2 8h2v4H2zm2 4h16v2H4zm16-4h2v4h-2zM6 4h2v2H6zm2-2h3v2H8zm3 2h2v2h-2zm2-2h3v2h-3zm3 2h2v2h-2zM4 14h2v6H4zm2 6h12v2H6zm12-6h2v6h-2zm-7-6h2v4h-2zm0 6h2v6h-2z"/>'
    },
    "gift-sharp": {
      body: '<path fill="currentColor" d="M2 6h20v2H2zm0 2h2v4H2zm0 4h20v2H2zm18-4h2v4h-2zM6 4h2v2H6zm2-2h3v2H8zm3 2h2v2h-2zm2-2h3v2h-3zm3 2h2v2h-2zM4 14h2v6H4zm0 6h16v2H4zm14-6h2v6h-2zm-7-6h2v4h-2zm0 6h2v6h-2z"/>'
    },
    "git-branch": {
      body: '<path fill="currentColor" d="M4 14h4v2H4zm0 6h4v2H4zm-2-4h2v4H2zm6 0h2v4H8zm8-14h4v2h-4zm0 6h4v2h-4zm-2-4h2v4h-2zm6 0h2v4h-2zm-8 13h5v2h-5zm5-5h2v5h-2zM5 2h2v10H5z"/>'
    },
    "git-branch-sharp": {
      body: '<path fill="currentColor" d="M2 14h8v2H2zm0 6h8v2H2zm0-4h2v4H2zm6 0h2v4H8zm6-14h8v2h-8zm0 6h8v2h-8zm0-4h2v4h-2zm6 0h2v4h-2zm-8 13h7v2h-7zm5-5h2v5h-2zM5 2h2v10H5z"/>'
    },
    "git-commit": {
      body: '<path fill="currentColor" d="M9 7h6v2H9zM7 9h2v6H7zm2 6h6v2H9zm6-6h2v6h-2zM0 11h5v2H0zm19 0h5v2h-5z"/>'
    },
    "git-commit-sharp": {
      body: '<path fill="currentColor" d="M7 7h10v2H7zm0 2h2v6H7zm0 6h10v2H7zm8-6h2v6h-2zM0 11h5v2H0zm19 0h5v2h-5z"/>'
    },
    "git-merge": {
      body: '<path fill="currentColor" d="M4 2h4v2H4zm0 6h4v2H4zM2 4h2v4H2zm6 0h2v4H8zm8 10h4v2h-4zm0 6h4v2h-4zm-2-4h2v4h-2zm6 0h2v4h-2zM5 12h2v10H5zm7 0h2v2h-2zm-2-2h2v2h-2z"/>'
    },
    "git-merge-sharp": {
      body: '<path fill="currentColor" d="M2 2h8v2H2zm0 6h8v2H2zm0-4h2v4H2zm6 0h2v4H8zm6 10h8v2h-8zm0 6h8v2h-8zm0-4h2v4h-2zm6 0h2v4h-2zM5 12h2v10H5zm7 0h2v2h-2zm-2-2h2v2h-2z"/>'
    },
    "git-pull-request": {
      body: '<path fill="currentColor" d="M4 10h4V8H4zm0-6h4V2H4zM2 8h2V4H2zm6 0h2V4H8zm8 14h4v-2h-4zm0-6h4v-2h-4zm-2 4h2v-4h-2zm6 0h2v-4h-2zM12 7h5V5h-5zM5 22h2V12H5z"/>'
    },
    "git-pull-request-sharp": {
      body: '<path fill="currentColor" d="M2 10h8V8H2zm0-6h8V2H2zm0 4h2V4H2zm6 0h2V4H8zm6 14h8v-2h-8zm0-6h8v-2h-8zm0 4h2v-4h-2zm6 0h2v-4h-2zM12 7h5V5h-5zM5 22h2V12H5z"/>'
    },
    github: {
      body: '<path fill="currentColor" d="M5 2h4v2H7v2H5zm0 10H3V6h2zm2 2H5v-2h2zm2 2v-2H7v2H3v-2H1v2h2v2h4v4h2v-4h2v-2zm0 0v2H7v-2zm6-12v2H9V4zm4 2h-2V4h-2V2h4zm0 6V6h2v6zm-2 2v-2h2v2zm-2 2v-2h2v2zm0 2h-2v-2h2zm0 0h2v4h-2z"/>',
      hidden: true
    },
    "github-2": {
      body: '<path fill="currentColor" d="M6 2h12v2H6zm4 12H8v-2h2zm4 0v2h-4v-2zm0 0v-2h2v2z"/><path fill="currentColor" d="M6 6V4H4v2H2v12h2v2h2v2h12v-2h2v-2h2V6h-2V4h-2v2h-2v2H8V6zm2 6v-2h8v2h2V6h2v12h-2v2h-2v-4h-2v4h-4v-4H6v2h2v2H6v-2H4v-2h2v-2H4V6h2v6z"/>',
      hidden: true
    },
    globe: {
      body: '<g fill="currentColor"><path d="M6 2h12v2H6zm0 18h12v2H6zM4 4h2v2H4zm5 0h2v2H9zm0 14h2v2H9zm4 0h2v2h-2zM7 6h2v12H7zm8 0h2v12h-2zm-2-2h2v2h-2zm7 0h-2v2h2zM2 6h2v12H2zm20 0h-2v12h2zM4 18h2v2H4zm16 0h-2v2h2z"/><path d="M3 11h18v2H3z"/></g>'
    },
    goal: {
      body: '<g fill="currentColor"><path d="M6 2h2v2H6zm0 18h12v2H6zm12-2h2v2h-2zM4 18h2v2H4zM4 4h2v2H4zm16 10h2v4h-2zM2 6h2v12H2zm6 10h8v2H8zM6 8h2v8H6zm10 6h2v2h-2zM10 2h2v12h-2z"/><path d="M10 2h6v2h-6zm0 6h6v2h-6zm6-4h6v2h-6zm0 6h6v2h-6zm4-4h2v4h-2z"/></g>'
    },
    gps: {
      body: '<path fill="currentColor" d="M9 5h6v2H9zM7 7h2v2H7zm0 8h2v2H7zm8 0h2v2h-2zm0-8h2v2h-2zm2 2h2v6h-2zm-8 8h6v2H9zM5 9h2v6H5zm14 2h4v2h-4zM1 11h4v2H1zM11 1h2v4h-2zm0 18h2v4h-2z"/>'
    },
    "gps-2": {
      body: '<path fill="currentColor" d="M9 5h6v2H9zM7 7h2v2H7zm0 8h2v2H7zm8 0h2v2h-2zm0-8h2v2h-2zm2 2h2v6h-2zm-8 8h6v2H9zM5 9h2v6H5zm14 2h4v2h-4zM1 11h4v2H1zM11 1h2v4h-2zm0 18h2v4h-2zm0-10h2v2h-2zm-2 2h2v2H9zm2 2h2v2h-2zm2-2h2v2h-2z"/>'
    },
    "gps-2-sharp": {
      body: '<path fill="currentColor" d="M7 5h10v2H7zm10 0h2v14h-2zM7 17h10v2H7zM5 5h2v14H5zm14 6h4v2h-4zM1 11h4v2H1zM11 1h2v4h-2zm0 18h2v4h-2zm0-10h2v2h-2zm-2 2h2v2H9zm2 2h2v2h-2zm2-2h2v2h-2z"/>'
    },
    "gps-sharp": {
      body: '<path fill="currentColor" d="M7 5h10v2H7zm10 0h2v14h-2zM7 17h10v2H7zM5 5h2v14H5zm14 6h4v2h-4zM1 11h4v2H1zM11 1h2v4h-2zm0 18h2v4h-2z"/>'
    },
    gpu: {
      body: '<path fill="currentColor" d="M1 2h2v20H1zm2 2h18v2H3zm18 2h2v10h-2zM3 16h18v2H3zm4 2h2v2H7zm2 2h6v2H9zm6-2h2v2h-2zM7 8h2v2H7zm8 0h2v2h-2zM5 10h2v2H5zm8 0h2v2h-2zm-6 2h2v2H7zm8 0h2v2h-2zm-6-2h2v2H9zm8 0h2v2h-2z"/>'
    },
    "gpu-sharp": {
      body: '<path fill="currentColor" d="M1 2h2v20H1zm2 2h20v2H3zm18 2h2v10h-2zM3 16h20v2H3zm4 2h2v2H7zm0 2h10v2H7zm8-2h2v2h-2zM7 8h2v2H7zm8 0h2v2h-2zM5 10h2v2H5zm8 0h2v2h-2zm-6 2h2v2H7zm8 0h2v2h-2zm-6-2h2v2H9zm8 0h2v2h-2z"/>'
    },
    grid: {
      body: '<path fill="currentColor" d="M2 2h20v20H2zm2 2v4h4V4zm6 0v4h4V4zm6 0v4h4V4zm4 6h-4v4h4zm0 6h-4v4h4zm-6 4v-4h-4v4zm-6 0v-4H4v4zm-4-6h4v-4H4zm6-4v4h4v-4z"/>',
      hidden: true
    },
    "grid-2x2-2": {
      body: '<g fill="currentColor"><path d="M4 2h16v2H4zM2 4h2v16H2zm2 7h16v2H4zm16-7h2v16h-2z"/><path d="M11 4h2v18h-2z"/><path d="M4 20h16v2H4z"/></g>'
    },
    "grid-2x2-2-sharp": {
      body: '<g fill="currentColor"><path d="M4 2h16v2H4zM2 2h2v20H2zm2 9h16v2H4zm16-9h2v20h-2z"/><path d="M11 4h2v18h-2z"/><path d="M4 20h16v2H4z"/></g>'
    },
    "grid-2x3": {
      body: '<g fill="currentColor"><path d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zm-7 0v16h-2V4z"/><path d="M20 8v2H4V8zm0 6v2H4v-2z"/></g>'
    },
    "grid-2x3-sharp": {
      body: '<g fill="currentColor"><path d="M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2zm-7 0v16h-2V4z"/><path d="M20 8v2H4V8zm0 6v2H4v-2z"/></g>'
    },
    "grid-3x2": {
      body: '<g fill="currentColor"><path d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zM4 11h16v2H4z"/><path d="M8 4h2v16H8zm6 0h2v16h-2z"/></g>'
    },
    "grid-3x2-sharp": {
      body: '<g fill="currentColor"><path d="M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2zM4 11h16v2H4z"/><path d="M8 4h2v16H8zm6 0h2v16h-2z"/></g>'
    },
    "grid-3x3": {
      body: '<g fill="currentColor"><path d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zM4 8h16v2H4zm0 6h16v2H4z"/><path d="M8 4h2v16H8zm6 0h2v16h-2z"/></g>'
    },
    "grid-3x3-sharp": {
      body: '<g fill="currentColor"><path d="M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2zM4 8h16v2H4zm0 6h16v2H4z"/><path d="M8 4h2v16H8zm6 0h2v16h-2z"/></g>'
    },
    group: {
      body: '<path fill="currentColor" d="M3 3h18v18H3zm2 2v14h14V5zm2 2h4v4H7zm6 0h4v4h-4zm-6 6h4v4H7zm6 0h4v4h-4z"/>',
      hidden: true
    },
    hand: {
      body: '<path fill="currentColor" d="M21 7h2v5h-2zm-4-2h2v7h-2zm-4-2h2v8h-2zM9 3h2v8H9zM5 5h2v8H5zm14 0h2v2h-2zm-4-2h2v2h-2zm-4-2h2v2h-2zM7 3h2v2H7zm-4 8h2v2H3zm-2 2h2v2H1zm0 2h2v2H1zm2 2h2v2H3zm2 2h2v2H5zm2 2h12v2H7zm12-2h2v2h-2zm2-7h2v7h-2zM5 13h2v2H5zm2 2h2v2H7z"/>'
    },
    handbag: {
      body: '<g fill="currentColor"><path d="M7 4h2v7H7zm2-2h6v2H9zm6 2h2v7h-2z"/><path d="M5 7h14v2H5zm14 2h2v5h-2zM5 9H3v5h2zm16 5h2v6h-2zM3 14H1v6h2zm0 6h18v2H3z"/></g>'
    },
    "handbag-sharp": {
      body: '<g fill="currentColor"><path d="M7 4h2v7H7zm2-2h6v2H9zm6 2h2v7h-2z"/><path d="M1 7h22v2H1zm20 2h2v11h-2zM3 9H1v11h2zM1 20h22v2H1z"/></g>'
    },
    hash: {
      body: '<path fill="currentColor" d="M9 3h2v5H9zm6 0h2v5h-2zm-7 7h2v4H8zm6 0h2v4h-2zm-7 6h2v5H7zm6 0h2v5h-2zM3 8h18v2H3zm0 6h18v2H3z"/>'
    },
    hd: {
      body: '<path fill="currentColor" d="M3 7h2v4h4V7h2v10H9v-4H5v4H3zm10 8V7h6v2h-4v6h4v2h-6zm6 0V9h2v6z"/>',
      hidden: true
    },
    heading: {
      body: '<g fill="currentColor"><path d="M5 4h2v16H5z"/><path d="M5 11h14v2H5z"/><path d="M17 4h2v16h-2z"/></g>'
    },
    "heading-1": {
      body: '<g fill="currentColor"><path d="M3 6h2v12H3z"/><path d="M3 11h10v2H3z"/><path d="M11 6h2v12h-2zm8 2h2v10h-2zm-4 2h2v2h-2zm2-2h2v2h-2z"/></g>'
    },
    "heading-2": {
      body: '<g fill="currentColor"><path d="M3 6h2v12H3z"/><path d="M3 11h10v2H3z"/><path d="M11 6h2v12h-2zm4 10h6v2h-6zm0-2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm-2-2h2v2h-2zm-2 0h2v2h-2z"/></g>'
    },
    "heading-3": {
      body: '<g fill="currentColor"><path d="M3 6h2v12H3z"/><path d="M3 11h10v2H3z"/><path d="M11 6h2v12h-2zm4 10h4v2h-4zm4-2h2v2h-2zm-4-2h4v2h-4zm4-2h2v2h-2zm-2-2h2v2h-2zm-2 0h2v2h-2z"/></g>'
    },
    "heading-4": {
      body: '<g fill="currentColor"><path d="M3 6h2v12H3z"/><path d="M3 11h10v2H3z"/><path d="M11 6h2v12h-2zm4 6h4v2h-4zm4-4h2v10h-2zm-4 0h2v4h-2z"/></g>'
    },
    "heading-5": {
      body: '<g fill="currentColor"><path d="M3 6h2v12H3z"/><path d="M3 11h10v2H3z"/><path d="M11 6h2v12h-2zm10 10h-6v2h6zm0-2h-2v2h2zm-2-2h-2v2h2zm-2-4h-2v6h2zm2 0h-2v2h2zm2 0h-2v2h2z"/></g>'
    },
    "heading-6": {
      body: '<g fill="currentColor"><path d="M3 6h2v12H3z"/><path d="M3 11h10v2H3z"/><path d="M11 6h2v12h-2zm4 10h4v2h-4zm4-2h2v2h-2zm-4 0h2v2h-2zm0-2h4v2h-4zm2-4h2v2h-2zm-2 2h2v2h-2z"/></g>'
    },
    headphone: {
      body: '<g fill="currentColor"><path d="M14 13h7v2h-7zm2 6h3v2h-3z"/><path d="M14 13h2v8h-2zm5-6h2v12h-2zM3 13h7v2H3zm2 6h3v2H5z"/><path d="M3 7h2v12H3zm5 6h2v8H8zM7 3h10v2H7zM5 5h2v2H5zm12 0h2v2h-2z"/></g>'
    },
    headset: {
      body: '<path fill="currentColor" d="M19 2H5v2H3v14h7v-8H5V4h14v6h-5v8h3v2h-6v2h8v-4h2V4h-2zm-3 10h3v4h-3zm-8 0v4H5v-4z"/>',
      hidden: true
    },
    heart: {
      body: '<path fill="currentColor" d="M13 22h-2v-2h2zm-2-2H9v-2h2zm4 0h-2v-2h2zm-6-2H7v-2h2zm8 0h-2v-2h2zM7 16H5v-2h2zm12 0h-2v-2h2zM5 14H3v-2h2zm16 0h-2v-2h2zM3 12H1V6h2zm20 0h-2V6h2zM13 8h-2V6h2zM5 6H3V4h2zm6 0H9V4h2zm4 0h-2V4h2zm6 0h-2V4h2zM9 4H5V2h4zm10 0h-4V2h4z"/>'
    },
    helicopter: {
      body: '<g fill="currentColor"><path d="M2 8h2v8H2zm2 4h2v2H4zm2-4h2v8H6zm2-2h10v2H8zm10 2h2v2h-2zm2 2h2v6h-2zM8 16h12v2H8zm2 2h2v2h-2zm6 0h2v2h-2zM6 20h16v2H6zM4 2h18v2H4z"/><path d="M12 4h2v8h-2zm2 8h6v2h-6z"/></g>'
    },
    hidden: {
      body: '<path fill="currentColor" d="M8 6h8v2H8zm-4 4V8h4v2zm-2 2v-2h2v2zm0 2v-2H0v2zm2 2H2v-2h2zm4 2H4v-2h4zm8 0v2H8v-2zm4-2v2h-4v-2zm2-2v2h-2v-2zm0-2h2v2h-2zm-2-2h2v2h-2zm0 0V8h-4v2zM9 10h2v2H9zm4 2h-2v2H9v2h2v-2h2v2h2v-2h-2zm0 0v-2h2v2z"/>',
      hidden: true
    },
    home: {
      body: '<path fill="currentColor" d="M4 20h16v2H4zm16-10h2v10h-2zM2 10h2v10H2zm2-2h2v2H4zm2-2h2v2H6zm2-2h2v2H8zm2-2h4v2h-4zm4 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zM8 14h2v6H8zm2-2h4v2h-4zm4 2h2v6h-2z"/>'
    },
    "home-sharp": {
      body: '<path fill="currentColor" d="M2 20h20v2H2zm18-10h2v10h-2zM2 10h2v10H2zm2-2h2v2H4zm2-2h2v2H6zm2-2h2v2H8zm2-2h4v2h-4zm4 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zM8 14h2v6H8zm0-2h8v2H8zm6 2h2v6h-2z"/>'
    },
    "hotel-bed": {
      body: '<path fill="currentColor" d="M2 16h10V8h10v2h-8v6h8v-6h2v10h-2v-2H2v2H0V4h2zm7-1H5v-2h4zm-4-2H3V9h2zm6 0H9V9h2zM9 9H5V7h4z"/>'
    },
    "hotel-bed-sharp": {
      body: '<path fill="currentColor" d="M2 16h10V8h12v12h-2v-2H2v2H0V4h2zm12 0h8v-6h-8zm-5-1H5v-2h4zm-4-2H3V9h2zm6 0H9V9h2zM9 9H5V7h4z"/>'
    },
    hourglass: {
      body: '<path fill="currentColor" d="M18 2H6v6h2v2h2v4H8v2H6v6h12v-6h-2v-2h-2v-4h2V8h2zm-2 6h-2v2h-4V8H8V4h8zm-2 6v2h2v4H8v-4h2v-2z"/>',
      hidden: true
    },
    hq: {
      body: '<path fill="currentColor" d="M3 7h2v4h4V7h2v10H9v-4H5v4H3zm10 2h2v6h-2zm6 6h-4v2h8v-2h-2V9h-2V7h-4v2h4z"/>',
      hidden: true
    },
    human: {
      body: '<path fill="currentColor" d="M10 2h4v4h-4zM3 7h18v2H3zm6 2h2v7H9zm4 0h2v7h-2zm-4 7h2v6H9zm4 0h2v6h-2zm-2-2h2v2h-2z"/>'
    },
    "human-arms-down": {
      body: '<path fill="currentColor" d="M10 2h4v4h-4zM7 7h10v2H7zm2 2h2v7H9zm4 0h2v7h-2zm-4 7h2v6H9zm4 0h2v6h-2zm-2-2h2v2h-2zM5 9h2v2H5zm-2 2h2v2H3zm14-2h2v2h-2zm2 2h2v2h-2z"/>'
    },
    "human-arms-up": {
      body: '<path fill="currentColor" d="M10 2h4v4h-4zM7 7h10v2H7zm2 2h2v7H9zm4 0h2v7h-2zm-4 7h2v6H9zm4 0h2v6h-2zm-2-2h2v2h-2zM5 5h2v2H5zM3 3h2v2H3zm14 2h2v2h-2zm2-2h2v2h-2z"/>'
    },
    "human-handsdown": {
      body: '<path fill="currentColor" d="M10 2h4v4h-4zM7 7h10v2h-2v13h-2v-6h-2v6H9V9H7zm-2 4h2V9H5zm0 0v2H3v-2zm14 0h-2V9h2zm0 0h2v2h-2z"/>',
      hidden: true
    },
    "human-handsup": {
      body: '<path fill="currentColor" d="M10 2h4v4h-4zM7 7h10v2h-2v13h-2v-6h-2v6H9V9H7zM5 5v2h2V5zm0 0H3V3h2zm14 0v2h-2V5zm0 0V3h2v2z"/>',
      hidden: true
    },
    "human-height": {
      body: '<path fill="currentColor" d="M6 2h4v4H6zM3 7h10v9h-2v6H9v-6H7v6H5v-6H3zm18-4h-6v2h6zm-4 4h4v2h-4zm4 4h-6v2h6zm-6 8h6v2h-6zm6-4h-4v2h4z"/>',
      hidden: true
    },
    "human-height-alt": {
      body: '<path fill="currentColor" d="M4 2h4v4H4zM1 7h10v9H9v6H7v-6H5v6H3v-6H1zm18-5h-2v2h-2v2h-2v2h2V6h2v12h-2v-2h-2v2h2v2h2v2h2v-2h2v-2h2v-2h-2v2h-2V6h2v2h2V6h-2V4h-2z"/>',
      hidden: true
    },
    "human-run": {
      body: '<path fill="currentColor" d="M10 3H8v2H6v2h2V5h2v2h2v2h-2v2H8v2H6v2H4v-2H2v2h2v2h2v-2h4v2h2v2h-2v2h2v-2h2v-2h-2v-4h2v-2h2v2h2v2h2v-2h2v-2h-2v2h-2v-2h-2V9h2V5h-4v2h-2V5h-2z"/>',
      hidden: true
    },
    "icon-category": {
      body: '<path fill="currentColor" d="M3 3h8v2H3zm0 6h8v2H3zm0-4h2v4H3zm6 0h2v4H9zm4-2h8v2h-8zm0 6h8v2h-8zm0-4h2v4h-2zm6 0h2v4h-2zM3 13h8v2H3zm0 6h8v2H3zm0-4h2v4H3zm6 0h2v4H9zm6-2h4v2h-4zm-2 2h2v4h-2zm2 4h4v2h-4zm4-4h2v4h-2z"/>'
    },
    icons: {
      body: '<g fill="currentColor"><path d="M3 1h6v2H3zM1 3h2v6H1zm2 6h6v2H3zm6-6h2v6H9zm4-2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm-2-6h2v2h-2zm2-2h2v2h-2zm-6 6h2v2h-2zm-2 2h2v2h-2zm0 4h10v2H13zm0 8h10v2H13zm0-6h2v6h-2zm8 0h2v6h-2zM5 13h2v2H5zm2 2h2v4H7zm-4 0h2v4H3zm-2 4h2v4H1zm8 0h2v4H9z"/><path d="M1 21h10v2H1z"/></g>'
    },
    image: {
      body: '<g fill="currentColor"><path d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zm-4 8h2v2h-2zm-2 2h2v2h-2zm4 0h2v2h-2zm-8 0h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2z"/><path d="M20 16h2v2h-2zM8 16h2v2H8zm-2 2h2v2H6zM8 6h2v2H8zM6 8h2v2H6zm2 2h2v2H8zm2-2h2v2h-2z"/></g>'
    },
    "image-2-plus": {
      body: '<g fill="currentColor"><path d="M4 2h10v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 6h2v10h-2zm-6 0h2v2h-2zm-2 2h2v2h-2zm4 0h2v2h-2zm-6 2h2v2h-2zm8 0h2v2h-2zM8 16h2v2H8zm-2 2h2v2H6zM8 6h2v2H8zM6 8h2v2H6zm2 2h2v2H8zm2-2h2v2h-2zm8-6h2v6h-2z"/><path d="M16 4h6v2h-6z"/></g>'
    },
    "image-2-plus-sharp": {
      body: '<g fill="currentColor"><path d="M2 2h12v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 6h2v10h-2zm-6 0h2v2h-2zm-2 2h2v2h-2zm4 0h2v2h-2zm-6 2h2v2h-2zm8 0h2v2h-2zM8 16h2v2H8zm-2 2h2v2H6zM8 6h2v2H8zM6 8h2v2H6zm2 2h2v2H8zm2-2h2v2h-2zm8-6h2v6h-2z"/><path d="M16 4h6v2h-6z"/></g>'
    },
    "image-arrow-right": {
      body: '<path fill="currentColor" d="M19 1h-2v2h2v2h-6v2h6v2h-2v2h2V9h2V7h2V5h-2V3h-2zm-8 2H2v18h20v-8h-2v6H4V5h7zm1 8V9h2v2zm-2 2v-2h2v2zm-2 2v-2h2v2zm0 0v2H6v-2zm8-2h-2v-2h2zm0 0h2v2h-2zM6 7h2v2H6z"/>',
      hidden: true
    },
    "image-broken": {
      body: '<path fill="currentColor" d="M22 3H2v18h20v-2h-2v-2h2v-2h-2v-2h2v-2h-2V9h2V7h-2V5h2zm-2 4v2h-2v2h2v2h-2v2h2v2h-2v2H4V5h14v2zm-6 2h-2v2h-2v2H8v2H6v2h2v-2h2v-2h2v-2h2v2h2v-2h-2zM6 7h2v2H6z"/>',
      hidden: true
    },
    "image-delete": {
      body: '<path fill="currentColor" d="M14 3H2v18h20V11h-2v8H4V5h10zM6 7h2v2H6zm14-2h-2V3h-2v2h2v2h-2v2h2V7h2v2h2V7h-2zm0 0V3h2v2zm-8 4h2v2h-2zm-2 4v-2h2v2zm-2 2h2v-2H8zm0 0v2H6v-2zm8-2h-2v-2h2zm0 0h2v2h-2z"/>',
      hidden: true
    },
    "image-flash": {
      body: '<path fill="currentColor" d="M18 0h2v4h4v2h-2v2h-2v2h-2V6h-4V4h2V2h2zM4 3h8v2H4v14h16v-7h2v9H2V3zm10 6h-2v2h-2v2H8v2H6v2h2v-2h2v-2h2v-2h2v2h2v2h2v-2h-2v-2h-2zM8 7H6v2h2z"/>',
      hidden: true
    },
    "image-frame": {
      body: '<path fill="currentColor" d="M13 1h-2v2H9v2H7v2H2v16h20V7h-5V5h-2V3h-2zm2 6H9V5h2V3h2v2h2zM4 9h16v12H4zm10 6v-2h-2v2h-2v2H8v2h2v-2h2v-2zm2 2v-2h-2v2zm0 0v2h2v-2zM6 13v-2h2v2z"/>',
      hidden: true
    },
    "image-gallery": {
      body: '<path fill="currentColor" d="M2 2h20v16h-5v2h-2v-2H9v2H7v-2H2zm5 18v2H5v-2zm10 0v2h2v-2zm3-16H4v12h16zm-8 4h2v2h-2zm-2 4v-2h2v2zm0 0v2H8v-2zm6 0h-2v-2h2zm0 0h2v2h-2zM8 6H6v2h2z"/>',
      hidden: true
    },
    "image-multiple": {
      body: '<path fill="currentColor" d="M24 2H4v16h20zM6 16V4h16v12zM2 4H0v18h20v-2H2zm12 2h2v2h-2zm-2 4V8h2v2zm-2 2v-2h2v2zm0 0v2H8v-2zm8-2h-2V8h2zm0 0h2v2h-2zM8 6h2v2H8z"/>',
      hidden: true
    },
    "image-new": {
      body: '<path fill="currentColor" d="M8 6h8v2H8zM6 8h2v8H6zm2 8h8v2H8zm8-8h2v8h-2zm-4 4h2v2h-2zm2-2h2v2h-2zm-4 4h2v2h-2zm1-13h2v3h-2zm0 19h2v3h-2zM1 11h3v2H1zm19 0h3v2h-3zm-1-8h2v2h-2zM3 3h2v2H3zM1 1h2v2H1zm2 18h2v2H3zm-2 2h2v2H1zm18-2h2v2h-2zm2 2h2v2h-2zm0-20h2v2h-2zM9 9h2v2H9z"/>'
    },
    "image-new-sharp": {
      body: '<path fill="currentColor" d="M6 6h12v2H6zm0 2h2v8H6zm0 8h12v2H6zm10-8h2v8h-2zm-2 4h2v2h-2zm-2-2h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2H8zm3-13h2v3h-2zm0 19h2v3h-2zM1 11h3v2H1zm19 0h3v2h-3zm-1-8h2v2h-2zM3 3h2v2H3zM1 1h2v2H1zm2 18h2v2H3zm-2 2h2v2H1zm18-2h2v2h-2zm2 2h2v2h-2zm0-20h2v2h-2z"/>'
    },
    "image-plus": {
      body: '<path fill="currentColor" d="M4 3h10v2H4v14h16v-8h2v10H2V3zm10 6h-2v2h-2v2H8v2H6v2h2v-2h2v-2h2v-2h2v2h2v2h2v-2h-2v-2h-2zM8 7H6v2h2zm10-4h2v2h2v2h-2v2h-2V7h-2V5h2z"/>',
      hidden: true
    },
    "image-sharp": {
      body: '<g fill="currentColor"><path d="M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2zm-4 8h2v2h-2zm-2 2h2v2h-2zm4 0h2v2h-2zm-8 0h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2z"/><path d="M20 16h2v2h-2zM8 16h2v2H8zm-2 2h2v2H6zM8 6h2v2H8zM6 8h2v2H6zm2 2h2v2H8zm2-2h2v2h-2z"/></g>'
    },
    images: {
      body: '<path fill="currentColor" d="M7 2h14v2H7zm0 14h14v2H7zm-4 4h14v2H3zM5 4h2v12H5zM1 8h2v12H1zm20-4h2v12h-2zm-4 6h2v2h-2zm2 2h2v2h-2zm-4 0h2v2h-2zm-2 2h2v2h-2zm-2-8h2v2h-2zM9 8h2v2H9zm2 2h2v2h-2zm2-2h2v2h-2zM3 6h2v2H3zm14 12h2v2h-2z"/>'
    },
    "images-sharp": {
      body: '<path fill="currentColor" d="M5 2h18v2H5zm0 14h18v2H5zm-4 4h18v2H1zM5 4h2v12H5zM1 8h2v12H1zm20-4h2v12h-2zm-4 6h2v2h-2zm2 2h2v2h-2zm-4 0h2v2h-2zm-2 2h2v2h-2zm-2-8h2v2h-2zM9 8h2v2H9zm2 2h2v2h-2zm2-2h2v2h-2zM1 6h4v2H1zm16 12h2v2h-2z"/>'
    },
    inbox: {
      body: '<path fill="currentColor" d="M2 4h2v16H2zm2 16h16v2H4zM20 4h2v16h-2zM4 2h16v2H4zm0 12h4v2H4zm4 2h8v2H8zm8-2h4v2h-4z"/>'
    },
    "inbox-all": {
      body: '<path fill="currentColor" d="M3 2h18v20H3zm2 2v4h4v2h6V8h4V4zm14 6h-2v2H7v-2H5v4h14zm0 6h-2v2H7v-2H5v4h14z"/>',
      hidden: true
    },
    "inbox-full": {
      body: '<path fill="currentColor" d="M3 2h18v20H3zm2 2v10h4v2h6v-2h4V4zm14 12h-2v2H7v-2H5v4h14zM7 6h10v2H7zm0 4h10v2H7z"/>',
      hidden: true
    },
    "inbox-sharp": {
      body: '<path fill="currentColor" d="M2 4h2v16H2zm0 16h20v2H2zM20 4h2v16h-2zM2 2h20v2H2zm2 12h4v2H4zm2 2h12v2H6zm10-2h4v2h-4z"/>'
    },
    "info-box": {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zm-9 5h2V7h-2zm0 8h2v-6h-2z"/>'
    },
    "info-box-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2zm-9 5h2V7h-2zm0 8h2v-6h-2z"/>'
    },
    invert: {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zM4 18h2v2H4zm0-2h4v2H4zm0-2h6v2H4zm0-2h8v2H4zm0-2h10v2H4zm0-2h12v2H4zm0-2h14v2H4zm0-2h16v2H4z"/>'
    },
    "invert-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2zM4 18h2v2H4zm0-2h4v2H4zm0-2h6v2H4zm0-2h8v2H4zm0-2h10v2H4zm0-2h12v2H4zm0-2h14v2H4zm0-2h16v2H4z"/>'
    },
    invoice: {
      body: '<path fill="currentColor" d="M5 20h2v2H3V4h2zm6 2H9v-2h2zm4 0h-2v-2h2zm6 0h-4v-2h2V4h2zM9 20H7v-2h2zm4 0h-2v-2h2zm4 0h-2v-2h2zm2-16H5V2h14z"/>'
    },
    "invoice-sharp": {
      body: '<path fill="currentColor" d="M21 22h-4v-2h2V4H5v16h2v2H3V2h18zm-10 0H9v-2h2zm4 0h-2v-2h2zm-6-2H7v-2h2zm4 0h-2v-2h2zm4 0h-2v-2h2z"/>'
    },
    iso: {
      body: '<path fill="currentColor" d="M8 3H6v3H3v2h3v3h2V8h3V6H8zm11 2h-2v2h-2v2h-2v2h-2v2H9v2H7v2H5v2h2v-2h2v-2h2v-2h2v-2h2V9h2V7h2zm-6 13v-2h8v2z"/>',
      hidden: true
    },
    joystick: {
      body: '<path fill="currentColor" d="M4 14h16v2H4zm0 6h16v2H4zm-2-4h2v4H2zm18 0h2v4h-2zM10 2h4v2h-4zM8 4h2v4H8zm6 0h2v4h-2zm-4 4h4v2h-4zm1 2h2v4h-2zm-4 2h2v2H7z"/>'
    },
    "joystick-sharp": {
      body: '<path fill="currentColor" d="M2 14h20v2H2zm0 6h20v2H2zm0-4h2v4H2zm18 0h2v4h-2zM8 2h8v2H8zm0 2h2v4H8zm6 0h2v4h-2zM8 8h8v2H8zm3 2h2v4h-2zm-4 2h2v2H7z"/>'
    },
    kanban: {
      body: '<path fill="currentColor" d="M21 3H3v18h18zM5 19V5h14v14zM9 7H7v8h2zm2 0h2v4h-2zm6 0h-2v10h2z"/>',
      hidden: true
    },
    keyboard: {
      body: '<path fill="currentColor" d="M21 3H3v18h18zM5 19V5h14v14zM9 7H7v2h2zm8 8H7v2h10zm-2-8h2v2h-2zm-2 0h-2v2h2zm-6 4h2v2H7zm10 0h-2v2h2zm-6 0h2v2h-2z"/>',
      hidden: true
    },
    "keyboard-music": {
      body: '<path fill="currentColor" d="M3 3h18v2H3zm0 16h18v2H3zM1 5h2v14H1zm20 0h2v14h-2zM3 11h18v2H3zm2-4h6v2H5zm8 0h2v2h-2zm4 0h2v2h-2zM5 13h2v4H5zm4 0h2v4H9zm4 0h2v4h-2zm4 0h2v4h-2z"/>'
    },
    "keyboard-music-sharp": {
      body: '<path fill="currentColor" d="M1 3h22v2H1zm0 16h22v2H1zM1 5h2v14H1zm20 0h2v14h-2zM3 11h18v2H3zm2-4h6v2H5zm8 0h2v2h-2zm4 0h2v2h-2zM5 13h2v4H5zm4 0h2v4H9zm4 0h2v4h-2zm4 0h2v4h-2z"/>'
    },
    label: {
      body: '<path fill="currentColor" d="M12 2H2v10h2v2h2v2h2v2h2v2h2v2h2v-2h2v-2h2v-2h2v-2h2v-2h-2v-2h-2V8h-2V6h-2V4h-2zm0 2v2h2v2h2v2h2v2h2v2h-2v2h-2v2h-2v2h-2v-2h-2v-2H8v-2H6v-2H4V4zM6 6h2v2H6z"/>',
      hidden: true
    },
    "label-alt": {
      body: '<path fill="currentColor" d="M16 5H2v14h14v-2h2v-2h2v-2h2v-2h-2V9h-2V7h-2zm0 2v2h2v2h2v2h-2v2h-2v2H4V7z"/>',
      hidden: true
    },
    "label-alt-multiple": {
      body: '<path fill="currentColor" d="M8 5H6v10h12v-2h2v-2h2V9h-2V7h-2V5zm10 2v2h2v2h-2v2H8V7zM4 9H2v10h12v-2H4z"/>',
      hidden: true
    },
    "label-sharp": {
      body: '<path fill="currentColor" d="M16 5H2v4h2v2h2v2H4v2H2v4h14v-2h2v-2h2v-2h2v-2h-2V9h-2V7h-2zm0 2v2h2v2h2v2h-2v2h-2v2H4v-2h2v-2h2v-2H6V9H4V7z"/>',
      hidden: true
    },
    languages: {
      body: '<path fill="currentColor" d="M7 2h4v2H7zM2 5h14v2H2zm9 2h2v2h-2zM9 9h2v2H9zm-2 2h2v2H7zM5 9h2v2H5zm4 4h2v2H9zm-4 0h2v2H5zm8 2h2v7h-2zm2-2h5v2h-5zm5 2h2v7h-2zm-5 2h5v2h-5z"/>'
    },
    "languages-sharp": {
      body: '<path fill="currentColor" d="M7 2h4v2H7zM2 5h14v2H2zm9 2h2v2h-2zM9 9h2v2H9zm-2 2h2v2H7zM5 9h2v2H5zm4 4h2v2H9zm-4 0h2v2H5zm8 2h2v7h-2zm0-2h9v2h-9zm7 2h2v7h-2zm-5 2h5v2h-5z"/>'
    },
    lasso: {
      body: '<path fill="currentColor" d="M4 12h2v2H4zm-2 2h2v2H2zm2 2h2v4H4zm2-2h4v2H6zm0 6h2v2H6zm4-4h4v2h-4zm0-14h4v2h-4zm4 12h4v2h-4zm4-2h2v2h-2zm0-6h2v2h-2zM6 4h4v2H6zM4 6h2v2H4zm10-2h4v2h-4zm6 4h2v4h-2zM2 8h2v4H2z"/>'
    },
    laugh: {
      body: '<path fill="currentColor" d="M6 20h12v2H6zM6 2h12v2H6zm12 2h2v2h-2zM4 4h2v2H4zm0 14h2v2H4zm14 0h2v2h-2zM2 6h2v12H2zm18 0h2v12h-2zM7 14h2v2H7zm0-2h10v2H7zm2 4h6v2H9zm6-2h2v2h-2zM8 8h2v2H8zm6 0h2v2h-2z"/>'
    },
    "laugh-sharp": {
      body: '<path fill="currentColor" d="M4 20h16v2H4zM4 2h16v2H4zM2 2h2v20H2zm18 0h2v20h-2zM7 14h2v2H7zm0-2h10v2H7zm2 4h6v2H9zm6-2h2v2h-2zM8 8h2v2H8zm6 0h2v2h-2z"/>'
    },
    layout: {
      body: '<path fill="currentColor" d="M2 5h20v14H2zm2 2v4h16V7zm16 6H10v4h10zM8 17v-4H4v4z"/>',
      hidden: true
    },
    "layout-align-bottom": {
      body: '<path fill="currentColor" d="M16 4H8v12h8zm-6 10V6h4v8zm10 6v-2H4v2z"/>',
      hidden: true
    },
    "layout-align-left": {
      body: '<path fill="currentColor" d="M20 16V8H8v8zm-10-6h8v4h-8zM4 20h2V4H4z"/>',
      hidden: true
    },
    "layout-align-right": {
      body: '<path fill="currentColor" d="M4 8v8h12V8zm10 6H6v-4h8zm6-10h-2v16h2z"/>',
      hidden: true
    },
    "layout-align-top": {
      body: '<path fill="currentColor" d="M16 20H8V8h8zm-6-10v8h4v-8zm10-6v2H4V4z"/>',
      hidden: true
    },
    "layout-columns": {
      body: '<path fill="currentColor" d="M2 5h20v14H2zm2 2v10h7V7zm9 0v10h7V7z"/>',
      hidden: true
    },
    "layout-distribute-horizontal": {
      body: '<path fill="currentColor" d="M6 4H4v16h2zm14 0h-2v16h2zM10 7h6v10H8V7zm4 8V9h-4v6z"/>',
      hidden: true
    },
    "layout-distribute-vertical": {
      body: '<path fill="currentColor" d="M20 6V4H4v2zm0 14v-2H4v2zM17 8v8h-2V8zm-8 6v-4h6V8H7v8h8v-2z"/>',
      hidden: true
    },
    "layout-footer": {
      body: '<path fill="currentColor" d="M2 5h20v14H2zm2 2v6h16V7zm16 8H4v2h16z"/>',
      hidden: true
    },
    "layout-header": {
      body: '<path fill="currentColor" d="M2 19h20V5H2zm2-2v-6h16v6zm16-8H4V7h16z"/>',
      hidden: true
    },
    "layout-rows": {
      body: '<path fill="currentColor" d="M2 5h20v14H2zm2 2v4h16V7zm16 6H4v4h16z"/>',
      hidden: true
    },
    "layout-sidebar-left": {
      body: '<path fill="currentColor" d="M2 5h20v14H2zm2 2v10h2V7zm4 0v10h12V7z"/>',
      hidden: true
    },
    "layout-sidebar-right": {
      body: '<path fill="currentColor" d="M22 5H2v14h20zm-2 2v10h-2V7zm-4 0v10H4V7z"/>',
      hidden: true
    },
    leaf: {
      body: '<path fill="currentColor" d="M1 18h2v4H1zm2-2h2v2H3zm2-2h6v2H5zm6-2h2v2h-2zm-6 6h4v2H5zm4 2h4v2H9zm4-2h4v2h-4zm4-2h2v2h-2zm2-8h2v8h-2zm0-4h2v4h-2zm-2-2h2v2h-2zm-4 2h4v2h-4zM7 6h6v2H7zM5 8h2v2H5zm-2 2h2v4H3z"/>'
    },
    library: {
      body: '<path fill="currentColor" d="M3 4h2v17H3zm4 4h2v13H7zm4-2h2v15h-2zm4 0h2v5h-2zm2 5h2v5h-2zm2 5h2v5h-2z"/>'
    },
    lightbulb: {
      body: '<path fill="currentColor" d="M9 4h6v2H9zM7 6h2v2H7zm8 0h2v2h-2zm4-2h2v2h-2zm2-2h2v2h-2zM0 10h3v2H0zm21 0h3v2h-3zM3 4h2v2H3zM1 2h2v2H1zm6 12h2v2H7zm8 0h2v2h-2zM5 8h2v6H5zm12 0h2v6h-2zm-8 8h6v2H9zm0 4h6v2H9zm0-2h2v2H9zm4 0h2v2h-2zM11 0h2v3h-2z"/>'
    },
    "lightbulb-2": {
      body: '<path fill="currentColor" d="M8 2h8v2H8zM6 6V4h2v2zm0 6H4V6h2zm2 2H6v-2h2zm2 0H8v4h8v-4h2v-2h2V6h-2V4h-2v2h2v6h-2v2h-2v2h-4zm2-2v2h-2v-2zm0-2h2v2h-2zm0-2v2h-2V8zm0 0V6h2v2zm4 14v-2H8v2z"/>',
      hidden: true
    },
    "lightbulb-off": {
      body: '<path fill="currentColor" d="M9 3h6v2H9zM7 5h2v2H7zm8 0h2v2h-2zm-8 8h2v2H7zm8 0h2v2h-2zM5 7h2v6H5zm12 0h2v6h-2zm-8 8h6v2H9zm0 4h6v2H9zm0-2h2v2H9zm4 0h2v2h-2z"/>'
    },
    "lightbulb-on": {
      body: '<path fill="currentColor" d="M13 2h-2v4h2zm2 6H9v2H7v4h2v4h6v-4h2v-4h-2zm0 2v4h-2v2h-2v-2H9v-4zM9 20h6v2H9zm14-9v2h-4v-2zM5 13v-2H1v2zm12-7h2v2h-2zm2 0h2V4h-2zM5 6h2v2H5zm0 0V4H3v2z"/>',
      hidden: true
    },
    link: {
      body: '<path fill="currentColor" d="M4 6h7v2H4zm0 10h7v2H4zM2 8h2v8H2zm18-2h-7v2h7zm0 10h-7v2h7zm2-8h-2v8h2zM7 11h10v2H7z"/>'
    },
    "link-sharp": {
      body: '<path fill="currentColor" d="M2 6h9v2H2zm0 10h9v2H2zm0-8h2v8H2zm20-2h-9v2h9zm0 10h-9v2h9zm0-8h-2v8h2zM7 11h10v2H7z"/>'
    },
    list: {
      body: '<path fill="currentColor" d="M6 6H4v2h2zm14 0H8v2h12zM4 11h2v2H4zm16 0H8v2h12zM4 16h2v2H4zm16 0H8v2h12z"/>',
      hidden: true
    },
    "list-box": {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm2 5h2v2H6zm4 0h8v2h-8zm-4 4h2v2H6zm4 0h8v2h-8zm-4 4h2v2H6zm4 0h8v2h-8zm-6 5h16v2H4zM2 4h2v16H2zm18 0h2v16h-2z"/>'
    },
    "list-box-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm4 5h2v2H6zm4 0h8v2h-8zm-4 4h2v2H6zm4 0h8v2h-8zm-4 4h2v2H6zm4 0h8v2h-8zm-8 5h20v2H2zM2 4h2v16H2zm18 0h2v16h-2z"/>'
    },
    loader: {
      body: '<path fill="currentColor" d="M13 22h-2v-6h2zm-6-3H5v-2h2zm12 0h-2v-2h2zM9 17H7v-2h2zm8 0h-2v-2h2zm-9-4H2v-2h6zm14 0h-6v-2h6zM9 9H7V7h2zm8 0h-2V7h2zm-4-1h-2V2h2zM7 7H5V5h2zm12 0h-2V5h2z"/>'
    },
    lock: {
      body: '<path fill="currentColor" d="M5 8h14v2H5zm0 12h14v2H5zM3 10h2v10H3zm16 0h2v10h-2zM7 4h2v4H7zm2-2h6v2H9zm6 2h2v4h-2z"/>'
    },
    "lock-open": {
      body: '<path fill="currentColor" d="M15 2H9v2H7v2h2V4h6v4H4v14h16V8h-3V4h-2zm0 8h3v10H6V10zm-2 3h-2v4h2z"/>',
      hidden: true
    },
    "lock-sharp": {
      body: '<path fill="currentColor" d="M3 8h18v2H3zm0 12h18v2H3zm0-10h2v10H3zm16 0h2v10h-2zM7 4h2v4H7zm0-2h10v2H7zm8 2h2v4h-2z"/>'
    },
    login: {
      body: '<g fill="currentColor"><path d="M2 11h14v2H2zm10-2h2v2h-2z"/><path d="M10 7h2v10h-2zm2 6h2v2h-2zM6 2h12v2H6zm0 18h12v2H6zM4 4h2v5H4zm0 11h2v5H4zM18 4h2v16h-2z"/></g>'
    },
    "login-sharp": {
      body: '<g fill="currentColor"><path d="M2 11h14v2H2zm10-2h2v2h-2z"/><path d="M10 7h2v10h-2zm2 6h2v2h-2zM4 2h16v2H4zm0 18h16v2H4zM4 4h2v5H4zm0 11h2v5H4zM18 4h2v16h-2z"/></g>'
    },
    logout: {
      body: '<g fill="currentColor"><path d="M8 11h12v2H8zm8-2h2v2h-2z"/><path d="M14 7h2v10h-2zm2 6h2v2h-2zM6 2h12v2H6zm0 18h12v2H6zM4 4h2v16H4zm14 0h2v3h-2zm0 13h2v3h-2z"/></g>'
    },
    "logout-sharp": {
      body: '<g fill="currentColor"><path d="M8 11h12v2H8zm8-2h2v2h-2z"/><path d="M14 7h2v10h-2zm2 6h2v2h-2zM4 2h16v2H4zm0 18h16v2H4zM4 4h2v16H4zm14 0h2v3h-2zm0 13h2v3h-2z"/></g>'
    },
    luggage: {
      body: '<path fill="currentColor" d="M9 2h6v4h4v14h-2v2h-2v-2H9v2H7v-2H5V6h4zm2 4h2V4h-2zM7 18h10V8H7zm4-8v6H9v-6zm4 0v6h-2v-6z"/>',
      hidden: true
    },
    "magic-edit": {
      body: '<path fill="currentColor" d="M16 2h4v2h-4zm2 2h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2H8zm-2 2h2v2H6zm-2 2h2v2H4zm-2-2h2v4H2zm2-2h2v2H4zm2-2h2v2H6zm2-2h2v2H8zm2-2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm0 2h2v2h-2zm2-2h2v2h-2zm0 8h2v2h-2zm0 8h2v2h-2zm-4-4h2v2h-2zm8 0h2v2h-2zm-6-2h2v2h-2zm4 0h2v2h-2zm0 4h2v2h-2zm-4 0h2v2h-2zM4 2h2v2H4zM2 4h2v2H2zm2 2h2v2H4zm2-2h2v2H6zm14 6h2v2h-2zM8 20h2v2H8z"/>'
    },
    mail: {
      body: '<path fill="currentColor" d="M6 8h2v2H6zm2 2h2v2H8zm10-2h-2v2h2zm-2 2h-2v2h2zm-6 2h4v2h-4zM2 6h2v12H2zm18 0h2v12h-2zM4 4h16v2H4zm0 14h16v2H4z"/>'
    },
    "mail-arrow-right": {
      body: '<path fill="currentColor" d="M20 4H2v16h10v-2H4V6h16v6h2V4zM6 8h2v2H6zm4 4H8v-2h2zm4 0v2h-4v-2zm2-2v2h-2v-2zm0 0V8h2v2zm8 8h-2v-2h-2v-2h-2v2h2v2h-6v2h6v2h-2v2h2v-2h2v-2h2z"/>',
      hidden: true
    },
    "mail-check": {
      body: '<path fill="currentColor" d="M4 4h18v10h-2V6H4v12h8v2H2V4zm4 4H6v2h2v2h2v2h4v-2h2v-2h2V8h-2v2h-2v2h-4v-2H8zm6 10h2v2h-2zm4 2v2h-2v-2zm2-2h-2v2h2zm0 0v-2h2v2z"/>',
      hidden: true
    },
    "mail-delete": {
      body: '<path fill="currentColor" d="M20 4H2v16h12v-2H4V6h16v8h2V4zM6 8h2v2H6zm4 4H8v-2h2zm4 0v2h-4v-2zm2-2v2h-2v-2zm0 0V8h2v2zm2 6h-2v2h2v2h-2v2h2v-2h2v2h2v-2h-2v-2h2v-2h-2v2h-2z"/>',
      hidden: true
    },
    "mail-flash": {
      body: '<path fill="currentColor" d="M4 4h18v8h-2V6H4v12h8v2H2V4zm4 4H6v2h2v2h2v2h4v-2h2v-2h2V8h-2v2h-2v2h-4v-2H8zm10 6h2v4h4v2h-2v2h-2v2h-2v-4h-4v-2h2v-2h2z"/>',
      hidden: true
    },
    "mail-multiple": {
      body: '<path fill="currentColor" d="M24 2H4v16h20zM6 16V4h16v12zM2 7H0v15h19v-2H2zm8-1H8v2h2v2h2v2h4v-2h2V8h2V6h-2v2h-2v2h-4V8h-2z"/>',
      hidden: true
    },
    "mail-off": {
      body: '<path fill="currentColor" d="M2 2h2v2H2zm4 4H4V4h2zm2 2H6V6h2zm2 2H8V8h2zm2 2h-2v-2h2zm2 0h-2v2h2v2h2v2h2v2h2v2h2v-2h-2v-2h-2v-2h-2v-2h-2zm2-2h-2v2h2zm0 0V8h2v2zm-6-6h12v12h-2V6H10zm4 14v2H2V8h2v10z"/>',
      hidden: true
    },
    "mail-open": {
      body: '<path fill="currentColor" d="M4 8h2V6H4zm2 4h2v2H6zm-2-2h2v2H4zm14 0h2v2h-2zM6 6h2V4H6zm2 8h8v2H8zm12-6h-2V6h2zm-2 4h-2v2h2zm0-6h-2V4h2zM8 4h8V2H8zM2 8h2v12H2zm18 0h2v12h-2zM4 20h16v2H4z"/>'
    },
    "mail-open-sharp": {
      body: '<path fill="currentColor" d="M4 8h2V6H4zm2 4h2v2H6zm-2-2h2v2H4zm14 0h2v2h-2zM6 6h2V4H6zm2 8h8v2H8zm12-6h-2V6h2zm-2 4h-2v2h2zm0-6h-2V4h2zM8 4h8V2H8zM2 8h2v12H2zm18 0h2v12h-2zM2 20h20v2H2z"/>'
    },
    "mail-right": {
      body: '<g fill="currentColor"><path d="M6 8h2v2H6zm2 2h2v2H8zm10-2h-2v2h2zm-2 2h-2v2h2zm-6 2h4v2h-4z" opacity=".1"/><path d="M4 4h16v2H4zm0 14h8v2H4zM2 6h2v12H2zm18 0h2v6h-2zM6 8h2v2H6zm2 2h2v2H8zm6 0h2v2h-2zm2-2h2v2h-2zm-6 4h4v2h-4zm12 6h2v2h-2zm-8 0h4v2h-4zm6-2h2v6h-2zm-2-2h2v10h-2z"/></g>'
    },
    "mail-right-sharp": {
      body: '<g fill="currentColor"><path d="M6 8h2v2H6zm2 2h2v2H8zm10-2h-2v2h2zm-2 2h-2v2h2zm-6 2h4v2h-4z" opacity=".1"/><path d="M2 4h20v2H2zm0 14h10v2H2zM2 6h2v12H2zm18 0h2v6h-2zM6 8h2v2H6zm2 2h2v2H8zm6 0h2v2h-2zm2-2h2v2h-2zm-6 4h4v2h-4zm12 6h2v2h-2zm-8 0h4v2h-4zm6-2h2v6h-2zm-2-2h2v10h-2z"/></g>'
    },
    "mail-sharp": {
      body: '<path fill="currentColor" d="M6 8h2v2H6zm2 2h2v2H8zm10-2h-2v2h2zm-2 2h-2v2h2zm-6 2h4v2h-4zM2 6h2v12H2zm18 0h2v12h-2zM2 4h20v2H2zm0 14h20v2H2z"/>'
    },
    "mail-unread": {
      body: '<path fill="currentColor" d="M22 2h-6v6h6zM4 4h10v2H4v12h16v-8h2v10H2V4zm4 4H6v2h2v2h2v2h4v-2h2v-2h-2v2h-4v-2H8z"/>',
      hidden: true
    },
    mailbox: {
      body: '<path fill="currentColor" d="M3 18h18v2H3zM1 8h2v10H1zm4-4h14v2H5zM3 6h2v2H3zm4 0h2v2H7zm12 0h2v2h-2zM9 8h2v10H9zm12 0h2v10h-2zM5 10h2v2H5zm9 0h4v2h-4zm2 2h2v2h-2z"/>'
    },
    "mailbox-sharp": {
      body: '<path fill="currentColor" d="M1 18h22v2H1zM1 8h2v10H1zm4-4h14v2H5zM3 6h2v2H3zm4 0h2v2H7zm12 0h2v2h-2zM9 8h2v10H9zm12 0h2v10h-2zM5 10h2v2H5zm9 0h4v2h-4zm2 2h2v2h-2z"/>'
    },
    map: {
      body: '<path fill="currentColor" d="M8 2h2v2h2v2h-2v10H8V6H6V4h2zM4 8V6h2v2zm2 10v2H4v2H2V8h2v10zm0 0h2v-2H6zm6 0h-2v-2h2zm2-10V6h-2v2zm2 0h-2v10h-2v2h2v2h2v-2h2v-2h2v-2h2V2h-2v2h-2v2h-2zm0 0h2V6h2v10h-2v2h-2z"/>',
      hidden: true
    },
    "map-pin": {
      body: '<path fill="currentColor" d="M7 2h10v2H7zM5 4h2v2H5zm14 0h-2v2h2zM7 17h2v2H7zm2 2h2v2H9zm6-2h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2h-2zm-6-7h2v3H5zm12 0h2v3h-2zM3 6h2v8H3zm18 0h-2v8h2zM10 6h4v2h-4zM8 8h2v4H8zm2 4h4v2h-4zm4-4h2v4h-2z"/>'
    },
    "map-pin-home": {
      body: '<path fill="currentColor" d="M6 2h10v2H6zM4 4h2v2H4zm14 0h-2v2h2zM6 17h2v2H6zm2 2h2v2H8zm2 2h2v2h-2zm-6-7h2v3H4zM2 6h2v8H2zm18 0h-2v3h2zM9 6h4v2H9zM7 8h2v4H7zm2 4h4v2H9zm4-4h2v4h-2zm3 5h2v2h-2zm-2 2h2v6h-2zm8 0h2v6h-2zm-4-4h2v2h-2zm2 2h2v2h-2zm-4 6h6v2h-6zm2-2h2v2h-2z"/>'
    },
    mastodon: {
      body: '<path fill="currentColor" d="M7 2v2h10V2zm10 2v2h2V4zm2 2v8h2V6zm0 8h-8v2h8zm-8 2H9v2h2zm0 2v2h2v-2zm0 2H7v2h4zm-4 0v-2H5v2zm-2-2V6H3v12zM5 6h2V4H5zm4 0v2h2V6zm2 2v2h2V8zm2 0h2V6h-2zm2 0v4h2V8zM9 8H7v4h2z"/>',
      hidden: true
    },
    megaphone: {
      body: '<path fill="currentColor" d="M4 6h12v2H4zM2 8h2v6H2zm2 6h12v2H4zM20 2h2v18h-2zm-2 16h2v2h-2zm-2-2h2v2h-2zm0-12h2v2h-2zm2-2h2v2h-2zM8 8h2v6H8zm-2 8h2v4H6zm2 4h4v2H8zm2-4h2v4h-2z"/>'
    },
    "megaphone-sharp": {
      body: '<path fill="currentColor" d="M4 6h12v2H4zM2 6h2v10H2zm2 8h12v2H4zM20 2h2v18h-2zm-2 16h2v2h-2zm-2-2h2v2h-2zm0-12h2v2h-2zm2-2h2v2h-2zM8 8h2v6H8zm-2 8h2v4H6zm0 4h6v2H6zm4-4h2v4h-2z"/>'
    },
    meh: {
      body: '<path fill="currentColor" d="M6 20h12v2H6zM6 2h12v2H6zm12 2h2v2h-2zM4 4h2v2H4zm0 14h2v2H4zm14 0h2v2h-2zM2 6h2v12H2zm18 0h2v12h-2zM7 14h10v2H7zm1-6h2v2H8zm6 0h2v2h-2z"/>'
    },
    "meh-sharp": {
      body: '<path fill="currentColor" d="M4 20h16v2H4zM4 2h16v2H4zM2 2h2v20H2zm18 0h2v20h-2zM7 14h10v2H7zm1-6h2v2H8zm6 0h2v2h-2z"/>'
    },
    membercard: {
      body: '<path fill="currentColor" d="M20 19h-5v4h-2v-2h-2v2H9v-4H4v-2h16zM4 17H2V7h2zm18 0h-2V7h2zm-8-2H6v-2h8zm4-4H6V9h12zm2-4H4V5h16z"/>'
    },
    "membercard-sharp": {
      body: '<path fill="currentColor" d="M22 19h-7v4h-2v-2h-2v2H9v-4H2V5h20zM4 17h16V7H4zm10-2H6v-2h8zm4-4H6V9h12z"/>'
    },
    "memory-stick": {
      body: '<path fill="currentColor" d="M3 4h18v2H3zM1 6h2v3H1zm0 5h2v7H1zm20 0h2v7h-2zM3 9h2v2H3zm16 0h2v2h-2zm2-3h2v3h-2zM3 18h18v2H3zm0-4h18v2H3zm2 2h2v2H5zm4 0h2v2H9zm4 0h2v2h-2zm4 0h2v2h-2zM7 8h2v4H7zm4 0h2v4h-2zm4 0h2v4h-2z"/>'
    },
    "memory-stick-sharp": {
      body: '<path fill="currentColor" d="M1 4h22v2H1zm0 2h2v3H1zm0 5h2v7H1zm20 0h2v7h-2zM3 9h2v2H3zm16 0h2v2h-2zm2-3h2v3h-2zM1 18h22v2H1zm2-4h18v2H3zm2 2h2v2H5zm4 0h2v2H9zm4 0h2v2h-2zm4 0h2v2h-2zM7 8h2v4H7zm4 0h2v4h-2zm4 0h2v4h-2z"/>'
    },
    menu: {
      body: '<path fill="currentColor" d="M20 18H4v-2h16zm0-5H4v-2h16zm0-5H4V6h16z"/>'
    },
    "menu-circle": {
      body: '<path fill="currentColor" d="M6 2h12v2H6zm0 18h12v2H6zM2 6h2v12H2zm18 0h2v12h-2zm-2-2h2v2h-2zm0 14h2v2h-2zM4 4h2v2H4zm0 14h2v2H4zM7 7h10v2H7zm0 4h10v2H7zm0 4h10v2H7z"/>'
    },
    "menu-square": {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zM7 7h10v2H7zm0 4h10v2H7zm0 4h10v2H7z"/>'
    },
    "menu-square-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2zM7 7h10v2H7zm0 4h10v2H7zm0 4h10v2H7z"/>'
    },
    message: {
      body: '<path fill="currentColor" d="M20 2H4v2h16zm0 14H6v2h14zm2-12h-2v12h2zM4 4H2v18h2zm2 14H4v2h2z"/>'
    },
    "message-arrow-left": {
      body: '<path fill="currentColor" d="M4 2h18v12h-2V4H4v18H2V2zm2 14h4v2H6v2H4v-2h2zm16 0h-6v-2h2v-2h-2v2h-2v2h-2v2h2v2h2v2h2v-2h-2v-2h6z"/>',
      hidden: true
    },
    "message-arrow-right": {
      body: '<path fill="currentColor" d="M4 2h18v10h-2V4H4v18H2V2zm2 14h4v2H6v2H4v-2h2zm16 0h-2v-2h-2v-2h-2v2h2v2h-6v2h6v2h-2v2h2v-2h2v-2h2z"/>',
      hidden: true
    },
    "message-bookmark": {
      body: '<path fill="currentColor" d="M4 2h18v16H6v2H4v-2h2v-2h14V4H4v18H2V2zm14 4h-6v8h2v-2h2v2h2z"/>',
      hidden: true
    },
    "message-clock": {
      body: '<path fill="currentColor" d="M20 2H2v20h2V4h16v4h2V2zM8 16H6v2H4v2h2v-2h2zm6-2h2v2h2v2h-4zm6-4h-8v2h-2v8h2v2h8v-2h2v-8h-2zm0 2v8h-8v-8z"/>',
      hidden: true
    },
    "message-delete": {
      body: '<path fill="currentColor" d="M4 2h18v16H6v2H4v-2h2v-2h14V4H4v18H2V2zm9 7h-2V7H9v2h2v2H9v2h2v-2h2v2h2v-2h-2zm0 0V7h2v2z"/>',
      hidden: true
    },
    "message-flash": {
      body: '<path fill="currentColor" d="M20 2H2v20h2V4h16v10h2V2zM10 16H6v2H4v2h2v-2h4zm6-4h2v4h4v2h-2v2h-2v2h-2v-4h-4v-2h2v-2h2z"/>',
      hidden: true
    },
    "message-image": {
      body: '<path fill="currentColor" d="M4 2h18v16H6v2H4v-2h2v-2h14V4H4v18H2V2zm10 4h-2v2h-2v2H8v2H6v2h2v-2h2v-2h2V8h2v2h2v2h2v-2h-2V8h-2zM6 6h2v2H6z"/>',
      hidden: true
    },
    "message-minus": {
      body: '<path fill="currentColor" d="M4 2h18v16H6v2H4v-2h2v-2h14V4H4v18H2V2zm12 7H8v2h8z"/>',
      hidden: true
    },
    "message-plus": {
      body: '<path fill="currentColor" d="M20 2H2v20h2V4h16v12H6v2H4v2h2v-2h16V2zm-7 7h3v2h-3v3h-2v-3H8V9h3V6h2z"/>',
      hidden: true
    },
    "message-processing": {
      body: '<path fill="currentColor" d="M4 2h18v16H6v2H4v-2h2v-2h14V4H4v18H2V2zm5 7H7v2h2zm2 0h2v2h-2zm6 0h-2v2h2z"/>',
      hidden: true
    },
    "message-reply": {
      body: '<path fill="currentColor" d="M4 2h18v20h-2V4H4v12h14v2h2v2h-2v-2H2V2z"/>',
      hidden: true
    },
    "message-sharp": {
      body: '<path fill="currentColor" d="M22 2H2v2h20zm0 14H6v2h16zm0-12h-2v12h2zM4 4H2v18h2zm2 14H4v2h2z"/>'
    },
    "message-text": {
      body: '<path fill="currentColor" d="M20 2H4v2h16zm0 14H6v2h14zm2-12h-2v12h2zM4 4H2v18h2zm2 14H4v2h2zm0-6h4v2H6zm0-4h8v2H6z"/>'
    },
    "message-text-sharp": {
      body: '<path fill="currentColor" d="M22 2H2v2h20zm0 14H6v2h16zm0-12h-2v12h2zM4 4H2v18h2zm2 14H4v2h2zm0-6h4v2H6zm0-4h8v2H6z"/>'
    },
    mic: {
      body: '<path fill="currentColor" d="M10 2h4v2h-4zM8 4h2v10H8zm2 10h4v2h-4zm4-10h2v10h-2zM4 10h2v6H4zm2 6h2v2H6zm2 2h8v2H8zm8-2h2v2h-2zm2-6h2v6h-2zm-7 10h2v2h-2z"/>'
    },
    "mic-off": {
      body: '<g fill="currentColor"><path d="M10 2h4v2h-4zM8 8h2v6H8zm2 6h4v2h-4zm4-10h2v6h-2zM4 10h2v6H4zm2 6h2v2H6zm2 2h8v2H8zm8-2h2v2h-2zm-2-2h2v2h-2zm-2-2h2v2h-2zm-2-2h2v2h-2z"/><path d="M8 8h2v2H8zM6 6h2v2H6zM4 4h2v2H4zM2 2h2v2H2zm16 16h2v2h-2zm2 2h2v2h-2zm-2-10h2v4h-2zm-7 10h2v2h-2z"/></g>'
    },
    "mic-off-sharp": {
      body: '<g fill="currentColor"><path d="M8 2h8v2H8zm0 6h2v8H8zm2 6h4v2h-4zm4-10h2v6h-2zM4 10h2v9H4zm2 8h12v2H6zm10-2h2v2h-2zm-2-2h2v2h-2zm-2-2h2v2h-2zm-2-2h2v2h-2z"/><path d="M8 8h2v2H8zM6 6h2v2H6zM4 4h2v2H4zM2 2h2v2H2zm16 16h2v2h-2zm2 2h2v2h-2zm-2-10h2v4h-2zm-7 10h2v2h-2z"/></g>'
    },
    "mic-sharp": {
      body: '<path fill="currentColor" d="M8 2h8v2H8zm0 2h2v10H8zm0 10h8v2H8zm6-10h2v10h-2zM4 10h2v8H4zm2 8h12v2H6zm12-8h2v8h-2zm-7 10h2v2h-2z"/>'
    },
    minus: {
      body: '<path fill="currentColor" d="M4 11h16v2H4z"/>'
    },
    "minus-box": {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zM8 11h8v2H8z"/>'
    },
    "minus-box-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2zM8 11h8v2H8z"/>'
    },
    "missed-call": {
      body: '<path fill="currentColor" d="M20 6h-4v2h2v2h-2v2h-2v2h-2v2h-2v-2H8v-2H6v-2H4V8H2v2h2v2h2v2h2v2h2v2h2v-2h2v-2h2v-2h2v-2h2v2h2V6z"/>',
      hidden: true
    },
    modem: {
      body: '<path fill="currentColor" d="M4 12h16v2H4zm0 8h16v2H4zm-2-6h2v6H2zm18 0h2v6h-2zm-4 2h2v2h-2zm-4 0h2v2h-2zm2-6h2v2h-2zm-3-2h2v2h-2zM9 4h2v2H9zm10 0h2v2h-2zm-2 4h2v2h-2zm-4-2h4v2h-4zm-2-4h8v2h-8z"/>'
    },
    "modem-sharp": {
      body: '<path fill="currentColor" d="M2 12h20v2H2zm0 8h20v2H2zm0-6h2v6H2zm18 0h2v6h-2zm-4 2h2v2h-2zm-4 0h2v2h-2zm2-6h2v2h-2zm-3-2h2v2h-2zM9 4h2v2H9zm10 0h2v2h-2zm-2 4h2v2h-2zm-4-2h4v2h-4zm-2-4h8v2h-8z"/>'
    },
    money: {
      body: '<path fill="currentColor" d="M8 8h12v2H8zm0 10h12v2H8zm-2-8h2v8H6zm14 0h2v8h-2zM4 4h12v2H4zm0 10h2v2H4zM2 6h2v8H2zm14 0h2v2h-2zm-4 6h4v4h-4z"/>'
    },
    "money-sharp": {
      body: '<path fill="currentColor" d="M6 8h16v2H6zm0 10h16v2H6zm0-8h2v8H6zm14 0h2v8h-2zM2 4h16v2H2zm0 10h4v2H2zm0-8h2v8H2zm14 0h2v2h-2zm-4 6h4v4h-4z"/>'
    },
    monitor: {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 14h16v2H4zM2 4h2v12H2zm18 0h2v12h-2zm-9 14h2v2h-2zm-3 2h8v2H8z"/>'
    },
    "monitor-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 14h20v2H2zM2 4h2v12H2zm18 0h2v12h-2zm-9 14h2v2h-2zm-3 2h8v2H8z"/>'
    },
    "mood-happy": {
      body: '<path fill="currentColor" d="M5 3h14v2H5zm0 16H3V5h2zm14 0v2H5v-2zm0 0h2V5h-2zM10 8H8v2h2zm4 0h2v2h-2zm-5 6v-2H7v2zm6 0v2H9v-2zm0 0h2v-2h-2z"/>',
      hidden: true
    },
    "mood-neutral": {
      body: '<path fill="currentColor" d="M5 3h14v2H5zm0 16H3V5h2zm14 0v2H5v-2zm0 0h2V5h-2zM10 8H8v2h2zm4 0h2v2h-2zm1 5H9v2h6z"/>',
      hidden: true
    },
    "mood-sad": {
      body: '<path fill="currentColor" d="M5 3h14v2H5zm0 16H3V5h2zm14 0v2H5v-2zm0 0h2V5h-2zM10 8H8v2h2zm4 0h2v2h-2zm-5 8v-2h6v2h2v-2h-2v-2H9v2H7v2z"/>',
      hidden: true
    },
    moon: {
      body: '<path fill="currentColor" d="M18 22H8v-2h10zM8 20H6v-2h2zm12 0h-2v-2h2zM6 18H4v-2h2zm16 0h-2v-4h-2v-2h2v-2h2zM4 16H2V6h2zm14 0h-6v-2h6zm-6-2h-2v-2h2zm-2-2H8V6h2zM6 6H4V4h2zm8-2h-2v2h-2V4H6V2h8z"/>'
    },
    "moon-star": {
      body: '<path fill="currentColor" d="M6 2h8v2h-2v2h-2V4H6zM4 6V4h2v2zm0 10H2V6h2zm2 2H4v-2h2zm2 2H6v-2h2zm10 0v2H8v-2zm2-2v2h-2v-2zm-2-4v-2h2v-2h2v8h-2v-4zm-6 0h6v2h-6zm-2-2h2v2h-2zm0 0V6H8v6zm8-10h2v2h2v2h-2v2h-2V6h-2V4h2z"/>',
      hidden: true
    },
    "moon-stars": {
      body: '<path fill="currentColor" d="M20 0h2v2h2v2h-2v2h-2V4h-2V2h2zM8 4h8v2h-2v2h-2V6H8zM6 8V6h2v2zm0 8H4V8h2zm2 2H6v-2h2zm8 0v2H8v-2zm2-2v2h-2v-2zm-2-4v-2h2V8h2v8h-2v-4zm-4 0h4v2h-4zm0 0V8h-2v4zm-8 6H2v2H0v2h2v2h2v-2h2v-2H4z"/>',
      hidden: true
    },
    "more-horizontal": {
      body: '<path fill="currentColor" d="M3 9h2v2H3zm8 0h2v2h-2zm8 0h2v2h-2zM1 11h2v2H1zm8 0h2v2H9zm8 0h2v2h-2zM3 13h2v2H3zm8 0h2v2h-2zm8 0h2v2h-2zM5 11h2v2H5zm8 0h2v2h-2zm8 0h2v2h-2z"/>'
    },
    "more-horizontal-sharp": {
      body: '<path fill="currentColor" d="M1 9h6v2H1zm8 0h6v2H9zm8 0h6v2h-6zM1 11h2v2H1zm8 0h2v2H9zm8 0h2v2h-2zM1 13h6v2H1zm8 0h6v2H9zm8 0h6v2h-6zM5 11h2v2H5zm8 0h2v2h-2zm8 0h2v2h-2z"/>'
    },
    "more-vertical": {
      body: '<path fill="currentColor" d="M15 3v2h-2V3zm0 8v2h-2v-2zm0 8v2h-2v-2zM13 1v2h-2V1zm0 8v2h-2V9zm0 8v2h-2v-2zM11 3v2H9V3zm0 8v2H9v-2zm0 8v2H9v-2zm2-14v2h-2V5zm0 8v2h-2v-2zm0 8v2h-2v-2z"/>'
    },
    "more-vertical-sharp": {
      body: '<path fill="currentColor" d="M15 1v6h-2V1zm0 8v6h-2V9zm0 8v6h-2v-6zM13 1v2h-2V1zm0 8v2h-2V9zm0 8v2h-2v-2zM11 1v6H9V1zm0 8v6H9V9zm0 8v6H9v-6zm2-12v2h-2V5zm0 8v2h-2v-2zm0 8v2h-2v-2z"/>'
    },
    mouse: {
      body: '<path fill="currentColor" d="M8 2h8v2H8zm0 20h8v-2H8zM6 4h2v2H6zm0 16h2v-2H6zM16 4h2v2h-2zm0 16h2v-2h-2zM4 6h2v12H4zm14 0h2v12h-2zm-7 0h2v4h-2z"/>'
    },
    move: {
      body: '<path fill="currentColor" d="M13 0h-2v2H9v2H7v2h2V4h2v7H4V9h2V7H4v2H2v2H0v2h2v2h2v2h2v-2H4v-2h7v7H9v-2H7v2h2v2h2v2h2v-2h2v-2h2v-2h-2v2h-2v-7h7v2h-2v2h2v-2h2v-2h2v-2h-2V9h-2V7h-2v2h2v2h-7V4h2v2h2V4h-2V2h-2z"/>',
      hidden: true
    },
    movie: {
      body: '<path fill="currentColor" d="M3 3h18v18H3zm2 2v2h2V5zm4 0v6h6V5zm8 0v2h2V5zm2 4h-2v2h2zm0 4h-2v2h2zm0 4h-2v2h2zm-4 2v-6H9v6zm-8 0v-2H5v2zm-2-4h2v-2H5zm0-4h2V9H5z"/>',
      hidden: true
    },
    music: {
      body: '<path fill="currentColor" d="M4 12h4v2H4zm-2 2h2v4H2zm2 4h4v2H4zM8 6h2v12H8zm10 0h2v12h-2zm-6 8h2v4h-2zm2-2h4v2h-4zm0 6h4v2h-4zM10 4h8v2h-8z"/>'
    },
    "music-sharp": {
      body: '<g fill="currentColor"><path d="M2 12h8v2H2zm0 2h2v4H2zm0 4h8v2H2z"/><path d="M8 6h2v12H8zm10 0h2v12h-2zm-6 8h2v4h-2z"/><path d="M12 12h8v2h-8zm0 6h8v2h-8zM8 4h12v2H8z"/></g>'
    },
    next: {
      body: '<path fill="currentColor" d="M6 4h2v2h2v2h2v2h2v4h-2v2h-2v2H8v2H6zm12 0h-2v16h2z"/>',
      hidden: true
    },
    note: {
      body: '<path fill="currentColor" d="M2 4h2v16H2zm18 0h2v12h-2zM4 2h16v2H4zm14 14h2v2h-2zm-2 2h2v2h-2zM4 20h12v2H4zm10-8h6v2h-6zm-2 2h2v6h-2z"/>'
    },
    "note-delete": {
      body: '<path fill="currentColor" d="M11 2h10v14h-2v2h-2v-2h-2v2h2v2h-2v2H3V10h2v10h8v-6h6V4h-8zM7 4H5V2H3v2h2v2H3v2h2V6h2v2h2V6H7zm0 0h2V2H7z"/>',
      hidden: true
    },
    "note-multiple": {
      body: '<path fill="currentColor" d="M21 6H7v16h8v-2h2v-2h-2v-2h2v2h2v-2h2zM9 20V8h10v6h-6v6zm-6-2h2V4h12V2H3z"/>',
      hidden: true
    },
    "note-plus": {
      body: '<path fill="currentColor" d="M7 1H5v3H2v2h3v3h2V6h3V4H7zm12 1h-7v2h7v10h-6v6H5v-9H3v11h12v-2h2v-2h2v-2h2V2zm-2 16h-2v-2h2z"/>',
      hidden: true
    },
    "note-sharp": {
      body: '<path fill="currentColor" d="M2 4h2v16H2zm18 0h2v12h-2zM2 2h20v2H2zm16 14h2v2h-2zm-2 2h2v2h-2zM2 20h14v2H2zm10-8h8v2h-8zm0 2h2v6h-2z"/>'
    },
    notebook: {
      body: '<g fill="currentColor"><path d="M6 2h14v2H6zm0 18h14v2H6zM20 4h2v16h-2zM4 4h2v16H4z"/><path d="M2 7h6v2H2zm0 4h6v2H2zm0 4h6v2H2zM16 4h2v16h-2z"/></g>'
    },
    "notebook-sharp": {
      body: '<g fill="currentColor"><path d="M4 2h18v2H4zm0 18h18v2H4zM20 4h2v16h-2zM4 4h2v16H4z"/><path d="M2 7h6v2H2zm0 4h6v2H2zm0 4h6v2H2zM16 4h2v16h-2z"/></g>'
    },
    notes: {
      body: '<g fill="currentColor"><path d="M6 8h2v12H6zM2 4h2v12H2zm18 4h2v8h-2zM8 6h12v2H8zM4 2h12v2H4zm14 14h2v2h-2zm-2 2h2v2h-2zm-8 2h8v2H8zm6-6h6v2h-6z"/><path d="M14 14h2v6h-2zm2-10h2v2h-2zM4 16h2v2H4z"/></g>'
    },
    "notes-delete": {
      body: '<path fill="currentColor" d="M19 2H3v20h10v-2H5V4h14v10h2V2zm-2 4H7v2h10zM7 10h10v2H7zm6 4H7v2h6zm6 4h-2v-2h-2v2h2v2h-2v2h2v-2h2v2h2v-2h-2zm0 0h2v-2h-2z"/>',
      hidden: true
    },
    "notes-multiple": {
      body: '<path fill="currentColor" d="M7 0h16v20H5V0zm14 18V2H7v16zM9 4h10v2H9zm10 4H9v2h10zM9 12h7v2H9zm10 10H3V4H1v20h18z"/>',
      hidden: true
    },
    "notes-plus": {
      body: '<path fill="currentColor" d="M5 2h16v12h-2V4H5v16h8v2H3V2zm2 4h10v2H7zm10 4H7v2h10zM7 14h7v2H7zm13 5h3v2h-3v3h-2v-3h-3v-2h3v-3h2z"/>',
      hidden: true
    },
    "notes-sharp": {
      body: '<g fill="currentColor"><path d="M6 8h2v12H6zM2 4h2v12H2zm18 4h2v8h-2zM6 6h16v2H6zM2 2h16v2H2zm16 14h2v2h-2zm-2 2h2v2h-2zM6 20h10v2H6zm8-6h6v2h-6z"/><path d="M14 14h2v6h-2zm2-10h2v2h-2zM2 16h4v2H2z"/></g>'
    },
    notification: {
      body: '<path fill="currentColor" d="M14 4V2h-4v2H5v2h14V4zm5 12H5v-4H3v6h5v4h2v-4h4v2h-4v2h6v-4h5v-6h-2V6h-2v8h2zM5 6v8h2V6z"/>',
      hidden: true
    },
    "notification-off": {
      body: '<path fill="currentColor" d="M14 2v2h5v2h-8V2zM5 16h9v2h2v4h-6v-2h4v-2h-4v4H8v-4H3v-6h2v-2h2v4H5zm16-2h-2v-2h-2V6h2v6h2zM5 2H3v2h2v2h2v2h2v2h2v2h2v2h2v2h2v2h2v2h2v-2h-2v-2h-2v-2h-2v-2h-2v-2h-2V8H9V6H7V4H5z"/>',
      hidden: true
    },
    open: {
      body: '<g fill="currentColor"><path d="M5 5h6v2H5zm8-2h8v2h-8zM5 19h12v2H5zM3 7h2v12H3zm14 6h2v6h-2z"/><path d="M19 3h2v8h-2zm-8 8h2v2h-2zm6-4h-2v2h2zm2-2h-2v2h2zm-4 4h-2v2h2zm-4 4H9v2h2z"/></g>'
    },
    "open-sharp": {
      body: '<g fill="currentColor"><path d="M3 5h8v2H3zm10-2h8v2h-8zM3 19h16v2H3zM3 7h2v12H3zm14 6h2v6h-2z"/><path d="M19 3h2v8h-2zm-8 8h2v2h-2zm6-4h-2v2h2zm2-2h-2v2h2zm-4 4h-2v2h2zm-4 4H9v2h2z"/></g>'
    },
    package: {
      body: '<g fill="currentColor"><path d="M10 20h4v2h-4zm0-16h4V2h-4zm0 6h4v2h-4zm4 8h4v2h-4zm0-12h4V4h-4zm0 2h4v2h-4zm4 8h4v2h-4zm0-8h4V6h-4zM6 18h4v2H6zM6 6h4V4H6zm0 2h4v2H6zm-4 8h4v2H2zm0-8h4V6H2z"/><path d="M2 6h2v12H2zm18 0h2v12h-2zm-8 6h2v8h-2zm-2-6h4v2h-4z"/></g>'
    },
    "paint-bucket": {
      body: '<path fill="currentColor" d="M8 3h8v2H8zm0 2H6v4H4v12h16V9h-2V5h-2v4H8zm8 6h2v8H6v-8h2v6h2v-4h2v2h2v-2h2z"/>',
      hidden: true
    },
    paperclip: {
      body: '<path fill="currentColor" d="M5 5h16v10H7V9h10v2H9v2h10V7H5v10h14v2H3V5z"/>',
      hidden: true
    },
    parking: {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zM8 6h2v12H8zm2 0h4v2h-4zm4 2h2v4h-2zm-4 4h4v2h-4z"/>'
    },
    "parking-off": {
      body: '<g fill="currentColor"><path d="M8 2h12v2H8zM4 20h14v2H4zM2 6h2v14H2zm18-2h2v12h-2zM8 8h2v10H8zm4-2h2v2h-2zm2 2h2v2h-2zm-4 4h4v2h-4zm10 8h2v2h-2zm-2-2h2v2h-2zm-2-2h2v2h-2zm-2-2h2v2h-2z"/><path d="M12 12h2v2h-2zm-2-2h2v2h-2zM8 8h2v2H8zM6 6h2v2H6zM4 4h2v2H4zM2 2h2v2H2z"/></g>'
    },
    "parking-off-sharp": {
      body: '<g fill="currentColor"><path d="M8 2h14v2H8zM4 20h14v2H4zM2 6h2v16H2zm18-2h2v12h-2zM8 8h2v10H8zm4-2h2v2h-2zm2 2h2v2h-2zm-4 4h4v2h-4zm10 8h2v2h-2zm-2-2h2v2h-2zm-2-2h2v2h-2zm-2-2h2v2h-2z"/><path d="M12 12h2v2h-2zm-2-2h2v2h-2zM8 8h2v2H8zM6 6h2v2H6zM4 4h2v2H4zM2 2h2v2H2z"/></g>'
    },
    "parking-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2zM8 6h2v12H8zm2 0h4v2h-4zm4 2h2v4h-2zm-4 4h4v2h-4z"/>'
    },
    "party-popper": {
      body: '<path fill="currentColor" d="M4 20h2v2H2v-4h2zm16 1h-2v-2h2zm-10-1H6v-2h4zm-4-2H4v-4h2zm8 0h-4v-2h4zm-4-2H8v-2h2zm6 0h-2v-4h2zm6 0h-2v-2h2zM8 14H6v-4h2zm12 0h-2v-2h2zm-6-2h-2v-2h2zm-2-2H8V8h4zm8-1h-4V7h4zM5 8H3V6h2zm17-1h-2V5h2zM12 6h-2V4h2zm-2-2H8V2h2zm7 0h-2V2h2z"/>'
    },
    pause: {
      body: '<path fill="currentColor" d="M10 4H5v16h5zm9 0h-5v16h5z"/>',
      hidden: true
    },
    "pc-case": {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 18h16v2H4zM6 4h2v16H6zM2 4h2v16H2zm18 0h2v16h-2zM10 6h8v2h-8zm0 4h2v2h-2z"/>'
    },
    "pc-case-sharp": {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 18h16v2H4zM6 4h2v16H6zM2 2h2v20H2zm18 0h2v20h-2zM10 6h8v2h-8zm0 4h2v2h-2z"/>'
    },
    "pen-square": {
      body: '<path fill="currentColor" d="M5 3h6v2H5zM3 5h2v14H3zm16 8h2v6h-2zM5 19h14v2H5zm3-9h2v6H8zm2 4h4v2h-4zm0-6h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2h-2zm-4 0h2v2h-2z"/>'
    },
    "pen-square-sharp": {
      body: '<path fill="currentColor" d="M5 3h6v2H5zM3 3h2v18H3zm16 10h2v6h-2zM5 19h16v2H5zm3-9h2v6H8zm2 4h4v2h-4zm0-6h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2h-2zm-4 0h2v2h-2z"/>'
    },
    percent: {
      body: '<path fill="currentColor" d="M20 4h-2v2h-2v2h-2v2h-2v2h-2v2H8v2H6v2H4v2h2v-2h2v-2h2v-2h2v-2h2v-2h2V8h2V6h2zm-4 10h4v6h-6v-6zm2 4v-2h-2v2zM6 4h4v6H4V4zm2 4V6H6v2z"/>',
      hidden: true
    },
    phone: {
      body: '<path fill="currentColor" d="M4 1h5v2H4zm5 2h2v4H9zM7 7h2v4H7zm-3 5h2v2H4zM2 3h2v9H2zm7 8h2v2H9zm2 2h2v2h-2zm2 2h4v2h-4zm4-2h4v2h-4zm4 2h2v5h-2zM6 14h2v2H6zm2 2h2v2H8zm2 2h2v2h-2zm2 2h9v2h-9z"/>'
    },
    "phone-call": {
      body: '<path fill="currentColor" d="M4 1h5v2H4zm5 2h2v4H9zM7 7h2v4H7zm-3 5h2v2H4zM2 3h2v9H2zm7 8h2v2H9zm2 2h2v2h-2zm2 2h4v2h-4zm4-2h4v2h-4zm4 2h2v5h-2zM6 14h2v2H6zm2 2h2v2H8zm2 2h2v2h-2zm2 2h9v2h-9zm1-18h5v2h-5zm7 4h2v5h-2zm-2-2h2v2h-2zm-5 2h3v2h-3zm3 2h2v3h-2z"/>'
    },
    "phone-call-sharp": {
      body: '<path fill="currentColor" d="M2 1h9v2H2zm7 2h2v6H9zM7 7h2v4H7zm-3 5h2v2H4zM2 3h2v9H2zm7 8h2v2H9zm2 2h2v2h-2zm2 2h4v2h-4zm2-2h6v2h-6zm6 0h2v9h-2zM6 14h2v2H6zm2 2h2v2H8zm2 2h2v2h-2zm2 2h9v2h-9zm1-18h5v2h-5zm7 4h2v5h-2zm-2-2h2v2h-2zm-5 2h3v2h-3zm3 2h2v3h-2z"/>'
    },
    "phone-outgoing": {
      body: '<g fill="currentColor"><path d="M4 1h5v2H4zm5 2h2v4H9zM7 7h2v4H7zm-3 5h2v2H4zM2 3h2v9H2zm7 8h2v2H9zm2 2h2v2h-2zm2 2h4v2h-4zm4-2h4v2h-4zm4 2h2v5h-2zM6 14h2v2H6zm2 2h2v2H8zm2 2h2v2h-2zm2 2h9v2h-9zm9-9h-2V3h2z"/><path d="M21 5h-8V3h8zm-2 2h-2V5h2zm-2 2h-2V7h2zm-2 2h-2V9h2z"/></g>'
    },
    "phone-outgoing-sharp": {
      body: '<g fill="currentColor"><path d="M21 11h-2V3h2z"/><path d="M21 5h-8V3h8zm-2 2h-2V5h2zm-2 2h-2V7h2zm-2 2h-2V9h2zM2 1h9v2H2zm7 2h2v6H9zM7 7h2v4H7zm-3 5h2v2H4zM2 3h2v9H2zm7 8h2v2H9zm2 2h2v2h-2zm2 2h4v2h-4zm2-2h6v2h-6zm6 0h2v9h-2zM6 14h2v2H6zm2 2h2v2H8zm2 2h2v2h-2zm2 2h9v2h-9z"/></g>'
    },
    "phone-sharp": {
      body: '<path fill="currentColor" d="M2 1h9v2H2zm7 2h2v6H9zM7 7h2v4H7zm-3 5h2v2H4zM2 3h2v9H2zm7 8h2v2H9zm2 2h2v2h-2zm2 2h4v2h-4zm2-2h6v2h-6zm6 0h2v9h-2zM6 14h2v2H6zm2 2h2v2H8zm2 2h2v2h-2zm2 2h9v2h-9z"/>'
    },
    pi: {
      body: '<path fill="currentColor" d="M8 6h2v15H8zm6 0h2v13h-2zm2 13h4v2h-4zM6 4h14v2H6zM4 6h2v4H4z"/>'
    },
    "pi-circle": {
      body: '<g fill="currentColor"><path d="M2 6h2v12H2zm4 14h12v2H6zM20 6h2v12h-2zM6 2h12v2H6zM4 4h2v2H4zm0 14h2v2H4zm14 0h2v2h-2zm0-14h2v2h-2zM6 9h2v2H6zm2-2h10v2H8z"/><path d="M10 7h2v10h-2zm3 0h2v8h-2zm2 8h2v2h-2z"/></g>'
    },
    "picture-in-picture": {
      body: '<path fill="currentColor" d="M4 4h16v2H4zM2 6h2v12H2zm2 12h16v2H4zM20 6h2v12h-2zm-8 2h6v2h-6zm4 2h2v4h-2zm-6 2h6v2h-6zm0-4h2v4h-2z"/>'
    },
    "picture-in-picture-alt": {
      body: '<path fill="currentColor" d="M2 4h20v16H2zm2 2v12h16V6zm6 4h8v6h-8zm2 2v2h4v-2z"/>',
      hidden: true
    },
    "picture-in-picture-sharp": {
      body: '<path fill="currentColor" d="M2 4h20v2H2zm0 2h2v12H2zm0 12h20v2H2zM20 6h2v12h-2zm-8 2h6v2h-6zm4 2h2v4h-2zm-6 2h6v2h-6zm0-4h2v4h-2z"/>'
    },
    pin: {
      body: '<path fill="currentColor" d="M7 2h10v2H7zM5 6V4h2v2zm0 8H3V6h2zm2 2H5v-2h2zm2 2H7v-2h2zm2 2H9v-2h2zm2 0v2h-2v-2zm2-2v2h-2v-2zm2-2v2h-2v-2zm2-2v2h-2v-2zm0-8h2v8h-2zm0 0V4h-2v2zm-5 2h-4v4h4z"/>',
      hidden: true
    },
    pipette: {
      body: '<g fill="currentColor"><path d="M3 15h2v4H3zm2 4h4v2H5zm0-6h2v2H5zm4 4h2v2H9zm-2-6h2v2H7zm4 4h2v2h-2zM9 9h2v2H9zm4 4h2v2h-2zm-2-6h2v2h-2zM9 5h2v2H9zm2-2h2v2h-2zm2 2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2h-2zm2 2h2v2h-2zm-2 2h2v2h-2zm-4-4h2v2h-2zm2 2h2v2h-2zM1 19h2v4H1z"/><path d="M1 21h4v2H1z"/></g>'
    },
    pixelarticons: {
      body: '<path fill="currentColor" d="M7 13h2v2H7zm0-6h6v2H7zM4 2h16v2H4zm0 18h16v2H4zm-2 0V4h2v16zm18 0V4h2v16zM7 11h6v2H7zm4-2h2v2h-2zM7 9h2v2H7zm6 4h2v2h-2zm2-2h2v2h-2zm0 4h2v2h-2zm-4 0h2v2h-2z"/>'
    },
    play: {
      body: '<path fill="currentColor" d="M15 11h-2V9h2zm0 4h-2v-2h2zm-2 2h-2v-2h2zm0-8h-2V7h2zm-2-2H9V5h2zM9 21H7V3h2zm6-8h2v-2h-2zm-6 4h2v2H9z"/>'
    },
    playlist: {
      body: '<path fill="currentColor" d="M10 13h6V5h6v4h-4v10h-8zm2 2v2h4v-2zM2 17h6v2H2zm6-4H2v2h6zM2 9h12v2H2zm12-4H2v2h12z"/>',
      hidden: true
    },
    plus: {
      body: '<path fill="currentColor" d="M13 11h7v2h-7v7h-2v-7H4v-2h7V4h2z"/>'
    },
    "plus-box": {
      body: '<g fill="currentColor"><path d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zM7 11h10v2H7z"/><path d="M11 17V7h2v10z"/></g>'
    },
    "plus-box-sharp": {
      body: '<g fill="currentColor"><path d="M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2zM7 11h10v2H7z"/><path d="M11 17V7h2v10z"/></g>'
    },
    pointer: {
      body: '<path fill="currentColor" d="M17 9h2v3h-2zm-4-2h2v4h-2zM9 3h2v8H9zM5 3h2v10H5zm14 6h2v2h-2zm-4-2h2v2h-2zm-4 0h2v2h-2zM7 1h2v2H7zM3 11h2v2H3zm-2 2h2v2H1zm0 2h2v2H1zm2 2h2v2H3zm2 2h2v2H5zm2 2h12v2H7zm12-2h2v2h-2zm2-8h2v8h-2zM5 13h2v2H5zm2 2h2v2H7z"/>'
    },
    potion: {
      body: '<path fill="currentColor" d="M8 6h8v2H8zm0-4h8v2H8zm0 6h2v2H8zm6 0h2v2h-2zM6 20h12v2H6zm-2-8h2v8H4zm14 0h2v8h-2zM6 10h2v2H6zm10 0h2v2h-2zM6 4h2v2H6zm10 0h2v2h-2z"/>'
    },
    "potion-sharp": {
      body: '<path fill="currentColor" d="M8 6h8v2H8zm0-4h8v2H8zm0 6h2v2H8zm6 0h2v2h-2zM4 20h16v2H4zm0-8h2v8H4zm14 0h2v8h-2zM6 10h2v2H6zm10 0h2v2h-2zM6 2h2v6H6zm10 0h2v6h-2z"/>'
    },
    power: {
      body: '<path fill="currentColor" d="M6 20h12v2H6zM18 6h2v2h-2zM4 6h2v2H4zm2-2h2v2H6zm10 0h2v2h-2zM4 18h2v2H4zm14 0h2v2h-2zM2 8h2v10H2zm18 0h2v10h-2zm-9-6h2v9h-2z"/>'
    },
    "power-off": {
      body: '<path fill="currentColor" d="M6 20h10v2H6zM18 6h2v2h-2zm-2-2h2v2h-2zM4 18h2v2H4zm14 0h2v2h-2zM2 8h2v10H2zm18 0h2v8h-2zm-9-6h2v6h-2zm9 18h2v2h-2zm-4-4h2v2h-2zm-2-2h2v2h-2zm-2-2h2v2h-2zm-2-2h2v2h-2zM8 8h2v2H8zM6 6h2v2H6zM4 4h2v2H4zM2 2h2v2H2z"/>'
    },
    presentation: {
      body: '<path fill="currentColor" d="M1 3h22v2H1zm1 2h2v11H2zm2 11h16v2H4zM20 5h2v11h-2zM9 18h2v2H9zm-2 2h2v2H7zm6-2h2v2h-2zm2 2h2v2h-2z"/>'
    },
    "presentation-sharp": {
      body: '<path fill="currentColor" d="M1 3h22v2H1zm1 2h2v11H2zm0 11h20v2H2zM20 5h2v11h-2zM9 18h2v2H9zm-2 2h2v2H7zm6-2h2v2h-2zm2 2h2v2h-2z"/>'
    },
    prev: {
      body: '<path fill="currentColor" d="M6 4h2v16H6zm12 0h-2v2h-2v3h-2v2h-2v2h2v3h2v2h2v2h2z"/>',
      hidden: true
    },
    print: {
      body: '<path fill="currentColor" d="M6 2h12v6h4v10h-4v4H6v-4H2V8h4zm2 6h8V4H8zm-2 8v-4h12v4h2v-6H4v6zm2-2v6h8v-6z"/>',
      hidden: true
    },
    printer: {
      body: '<g fill="currentColor"><path d="M6 4h2v4H6zm2-2h8v2H8zm8 2h2v4h-2z"/><path d="M4 6h16v2H4zM2 8h2v10H2zm2 10h2v2H4zm2-4h12v2H6z"/><path d="M6 14h2v8H6zm2 6h8v2H8zm8-6h2v8h-2zm2 4h2v2h-2zm2-10h2v10h-2zm-4 2h2v2h-2zm-4 0h2v2h-2z"/></g>'
    },
    "printer-minimal-sharp": {
      body: '<path fill="currentColor" d="M6 2h12v2H6zM4 8h16v2H4zm2-4h2v4H6zM2 8h2v8H2zm14-4h2v4h-2zM2 16h4v2H2zm4-2h2v6H6zm10 0h2v6h-2zM6 12h12v2H6zm0 8h12v2H6zm12-4h4v2h-4zm2-8h2v8h-2z"/>'
    },
    projector: {
      body: '<path fill="currentColor" d="M7 9h4v2H7zm-2 2h2v4H5zm2 4h4v2H7zm4-4h2v4h-2zm-8 0h2v2H3zm-2 2h2v6H1zm2 6h18v2H3zm18-6h2v6h-2zm-8-2h8v2h-8zM8 2h2v5H8zm4 4h2v2h-2zm2-2h2v2h-2zM4 6h2v2H4zM2 4h2v2H2zm13 11h4v2h-4z"/>'
    },
    proportions: {
      body: '<path fill="currentColor" d="M4 4h16v2H4zM2 6h2v12H2zm2 12h16v2H4zM20 6h2v12h-2zM4 10h12v2H4zm12 2h2v6h-2zm-5 0h2v6h-2z"/>'
    },
    "proportions-sharp": {
      body: '<path fill="currentColor" d="M2 4h20v2H2zm0 2h2v12H2zm0 12h20v2H2zM20 6h2v12h-2zM4 10h14v2H4zm12 2h2v6h-2zm-5 0h2v6h-2z"/>'
    },
    "quote-text-inline": {
      body: '<path fill="currentColor" d="M2 8h4v4H2zm6 0h4v4H8zM2 6h2v2H2zm6 0h2v2H8zM4 4h2v2H4zm6 0h2v2h-2zm4 2h8v2h-8zm0 4h8v2h-8zM2 14h20v2H2zm0 4h20v2H2z"/>'
    },
    radio: {
      body: '<path fill="currentColor" d="M11 9h2v2h-2zm0 4h2v2h-2zm-2-2h2v2H9zm4 0h2v2h-2zm6-2h-2v6h2zM5 9h2v6H5zm18-2h-2v10h2zM1 7h2v10H1zm16 0h-2v2h2zM7 7h2v2H7zm14-2h-2v2h2zM3 5h2v2H3zm14 10h-2v2h2zM7 15h2v2H7zm14 2h-2v2h2zM3 17h2v2H3z"/>'
    },
    "radio-handheld": {
      body: '<path fill="currentColor" d="M9 2v5h8v15H7V2zm0 7v4h6V9zm6 6H9v5h6z"/>',
      hidden: true
    },
    "radio-on": {
      body: '<path fill="currentColor" d="M17 3H7v2H5v2H3v10h2v2h2v2h10v-2h2v-2h2V7h-2V5h-2zm0 2v2h2v10h-2v2H7v-2H5V7h2V5zm-9 6h2v2h2v2h-2v-2H8zm8-2h-2v2h-2v2h2v-2h2z"/>',
      hidden: true
    },
    "radio-signal": {
      body: '<path fill="currentColor" d="M19 2h2v2h-2zm2 14V4h2v12zm0 0v2h-2v-2zM1 4h2v12H1zm2 12h2v2H3zM3 4h2V2H3zm2 2h2v8H5zm2 8h2v2H7zm0-8h2V4H7zm10 0h2v8h-2zm0 0h-2V4h2zm0 8v2h-2v-2zm-6-7h4v6h-2v9h-2v-9H9V7zm0 4h2V9h-2z"/>',
      hidden: true
    },
    "radio-tower": {
      body: '<path fill="currentColor" d="M22 2h-2v2h2v12h-2v2h2v-2h2V4h-2zM2 4H0v12h2v2h2v-2H2zm0 0V2h2v2zm4 2H4v8h2zm0 0V4h2v2zm4 0h4v2h-4zm0 6H8V8h2zm4 0h-4v2H8v4H6v4h2v-4h2v-4h4v4h2v4h2v-4h-2v-4h-2zm0 0h2V8h-2zm6-6h-2V4h-2v2h2v8h2z"/>',
      hidden: true
    },
    radius: {
      body: '<path fill="currentColor" d="M2 6h2v12H2zm4 14h8v2H6zM20 6h2v8h-2zM6 2h12v2H6zM4 4h2v2H4zm0 14h2v2H4zM18 4h2v2h-2zm-8 6h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm2 6h6v2h-6zm0-4h6v2h-6zm0 2h2v2h-2zm4 0h2v2h-2z"/>'
    },
    ratio: {
      body: '<g fill="currentColor"><path d="M4 6h16v2H4z"/><path d="M6 20V4h2v16zM2 8h2v8H2zm6 14v-2h8v2z"/><path d="M4 16h16v2H4z"/><path d="M16 20V4h2v16zm4-12h2v8h-2zM8 4V2h8v2z"/></g>'
    },
    receipt: {
      body: '<path fill="currentColor" d="M3 2h2v18H3zm16 0h2v18h-2zM5 4h2v2H5zm4 0h2v2H9zM5 20h14v2H5zm8-16h2v2h-2zM7 2h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2zm2 2h2v2h-2zM7 8h10v2H7zm0 4h10v2H7zm0 4h4v2H7z"/>'
    },
    "receipt-sharp": {
      body: '<path fill="currentColor" d="M3 2h2v18H3zm16 0h2v18h-2zM5 4h2v2H5zm4 0h2v2H9zM3 20h18v2H3zM13 4h2v2h-2zM7 2h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2zm2 2h2v2h-2zM7 8h10v2H7zm0 4h10v2H7zm0 4h4v2H7z"/>'
    },
    reciept: {
      body: '<path fill="currentColor" d="M3 2h2v2h2v2H5v14h14V6h-2V4h2V2h2v20H3zm12 2V2h2v2zm-2 0h2v2h-2zm-2 0V2h2v2zM9 4h2v2H9zm0 0V2H7v2zm8 4H7v2h10zM7 12h10v2H7zm10 6v-2h-4v2z"/>',
      hidden: true
    },
    "reciept-alt": {
      body: '<path fill="currentColor" d="M5 2H3v20h2v-2h2v2h2v-2h2v2h2v-2h2v2h2v-2h2v2h2V2h-2v2h-2V2h-2v2h-2V2h-2v2H9V2H7v2H5zm2 2h2v2h2V4h2v2h2V4h2v2h2v12h-2v2h-2v-2h-2v2h-2v-2H9v2H7v-2H5V6h2zm0 4h10v2H7zm10 4H7v2h10z"/>',
      hidden: true
    },
    recycle: {
      body: '<g fill="currentColor"><path d="M10 17h2v2h-2zm2-2h2v6h-2zm2-2h2v10h-2zm2 4h4v2h-4zm4-3h2v3h-2zm-2-2h2v2h-2zM4 8h6v2H4zm4 2h2v4H8zm-2 0h2v2H6zm-2 2h2v2H4zm-2 2h2v3H2zm2 3h4v2H4zm9-9h6v2h-6z"/><path d="M17 4h2v6h-2zm-2 2h2v2h-2zm-2-3h2v3h-2zM8 3h2v3H8zm2-2h3v2h-3z"/></g>'
    },
    redo: {
      body: '<g fill="currentColor"><path d="M20 8H6v2h14zM4 10h2v8H4zm2 8h6v2H6z"/><path d="M18 6h-2v6h2zm-2-2h-2v8h2zm0 8h-2v2h2z"/></g>'
    },
    "redo-sharp": {
      body: '<g fill="currentColor"><path d="M20 8H6v2h14zM4 8h2v12H4zm2 10h6v2H6z"/><path d="M18 6h-2v6h2zm-2-2h-2v8h2zm0 8h-2v2h2z"/></g>'
    },
    reload: {
      body: '<g fill="currentColor"><path d="M16 4h2v6h-2zm-2-2h2v2h-2zm0 2h2v8h-2zM4 8H2v5h2z"/><path d="M4 6h16v2H4zm4 14H6v-6h2zm2 2H8v-2h2zm0-2H8v-8h2zm10-4h2v-5h-2z"/><path d="M20 18H4v-2h16z"/></g>'
    },
    "reload-sharp": {
      body: '<g fill="currentColor"><path d="M16 4h2v6h-2zm-2-2h2v2h-2zm0 2h2v8h-2zM4 8H2v5h2z"/><path d="M2 6h18v2H2zm6 14H6v-6h2zm2 2H8v-2h2zm0-2H8v-8h2zm10-4h2v-5h-2z"/><path d="M22 18H4v-2h18z"/></g>'
    },
    "remove-box": {
      body: '<path fill="currentColor" d="M5 3H3v18h18V3zm14 2v14H5V5zm-3 6H8v2h8z"/>',
      hidden: true
    },
    "remove-box-multiple": {
      body: '<path fill="currentColor" d="M5 3H3v14h14V3zm10 2v10H5V5zm4 2v12H7v2h14V7zm-6 2H7v2h6z"/>',
      hidden: true
    },
    repeat: {
      body: '<g fill="currentColor"><path d="M17 5h2v2h-2zM5 17h2v2H5zm6-14h2v6h-2zM9 1h2v8H9zm0 8h2v2H9zm10 8H9v2h10zM5 7H3v10h2z"/><path d="M13 15h-2v6h2zm2-2h-2v8h2zm0 8h-2v2h2zM5 5h10v2H5zm14 12h2V7h-2z"/></g>'
    },
    "repeat-sharp": {
      body: '<g fill="currentColor"><path d="M17 5h2v2h-2zM5 17h2v2H5zm6-14h2v6h-2zM9 1h2v8H9zm0 8h2v2H9zm10 8H9v2h10zM5 5H3v14h2z"/><path d="M13 15h-2v6h2zm2-2h-2v8h2zm0 8h-2v2h2zM5 5h10v2H5zm14 14h2V5h-2z"/></g>'
    },
    reply: {
      body: '<path fill="currentColor" d="M12 19h-2v-2H8v-2H6v-2H4v-2h2V9h2V7h2V5h2v4h8v6h-8z"/>',
      hidden: true
    },
    "reply-all": {
      body: '<path fill="currentColor" d="M13 19h2v-4h7V9h-7V5h-2v2h-2v2H9v2H7v2h2v2h2v2h2zM8 7H6v2H4v2H2v2h2v2h2v2h2v2h2v-2H8v-2H6v-2H4v-2h2V9h2zm0 0h2V5H8z"/>',
      hidden: true
    },
    "road-sign": {
      body: '<g fill="currentColor"><path d="M2 10h2v2H2zm0 4h2v-2H2zm20-4h-2v2h2zm0 4h-2v-2h2zM4 8h2v2H4zm0 8h2v-2H4zm16-8h-2v2h2zm0 8h-2v-2h2zM6 6h2v2H6zm0 12h2v-2H6zM18 6h-2v2h2zm0 12h-2v-2h2zM8 4h2v2H8zm0 16h2v-2H8zm8-16h-2v2h2zm0 16h-2v-2h2zM10 2h2v2h-2zm0 20h2v-2h-2zm4-20h-2v2h2zm0 20h-2v-2h2zm2-11h2v2h-2zm-2-2h2v6h-2zm-2-2h2v10h-2zm-4 4h2v4H8z"/><path d="M10 11h3v2h-3z"/></g>'
    },
    robot: {
      body: '<path fill="currentColor" d="M5 7h14v2H5zm0 12h14v2H5zM3 9h2v10H3zm16 0h2v10h-2zM1 13h2v2H1zm20 0h2v2h-2zM11 5h2v2h-2zM7 3h4v2H7zm1 9h2v4H8zm6 0h2v4h-2z"/>'
    },
    "robot-face": {
      body: '<g fill="currentColor"><path d="M4 6h16v2H4zm0 14h16v2H4zM2 8h2v12H2zm18 0h2v12h-2z"/><path d="M11 4h2v4h-2zm-3 6h2v2H8zm6 0h4v2h-4zm-1-8h4v2h-4zM0 12h2v2H0zm22 0h2v2h-2zm-12 4h4v2h-4zm-2-2h2v2H8zm6 0h2v2h-2z"/></g>'
    },
    "robot-face-happy": {
      body: '<g fill="currentColor"><path d="M4 6h16v2H4zm0 14h16v2H4zM2 8h2v12H2zm18 0h2v12h-2z"/><path d="M11 4h2v4h-2zm-3 6h2v2H8zm6 0h2v2h-2zm-1-8h4v2h-4zM0 12h2v2H0zm22 0h2v2h-2zM7 14h10v2H7zm2 2h6v2H9z"/></g>'
    },
    "robot-face-happy-sharp": {
      body: '<path fill="currentColor" d="M2 6h20v2H2zm0 14h20v2H2zM2 8h2v12H2zm18 0h2v12h-2zm-9-6h2v4h-2zm-3 8h2v2H8zm6 0h2v2h-2zm-1-8h4v2h-4zM0 12h2v2H0zm22 0h2v2h-2zM7 14h10v2H7zm2 2h6v2H9z"/>'
    },
    "robot-face-sad": {
      body: '<g fill="currentColor"><path d="M4 6h16v2H4zm0 14h16v2H4zM2 8h2v12H2zm18 0h2v12h-2z"/><path d="M11 4h2v4h-2zM8 18h2v-2H8zm6 0h2v-2h-2zm-4-2h4v-2h-4zm-2-6h2v2H8zm6 0h2v2h-2zm-1-8h4v2h-4zM0 12h2v2H0zm22 0h2v2h-2z"/></g>'
    },
    "robot-face-sad-sharp": {
      body: '<path fill="currentColor" d="M2 6h20v2H2zm0 14h20v2H2zM2 8h2v12H2zm18 0h2v12h-2zm-9-6h2v4h-2zM8 18h2v-2H8zm6 0h2v-2h-2zm-4-2h4v-2h-4zm-2-6h2v2H8zm6 0h2v2h-2zm-1-8h4v2h-4zM0 12h2v2H0zm22 0h2v2h-2z"/>'
    },
    "robot-face-sharp": {
      body: '<path fill="currentColor" d="M2 6h20v2H2zm0 14h20v2H2zM2 8h2v12H2zm18 0h2v12h-2zm-9-6h2v4h-2zm-3 8h2v2H8zm6 0h4v2h-4zm-1-8h4v2h-4zM0 12h2v2H0zm22 0h2v2h-2zm-12 4h4v2h-4zm-2-2h2v2H8zm6 0h2v2h-2z"/>'
    },
    "robot-sharp": {
      body: '<path fill="currentColor" d="M3 7h18v2H3zm0 12h18v2H3zM3 9h2v10H3zm16 0h2v10h-2zM1 13h2v2H1zm20 0h2v2h-2zM11 5h2v2h-2zM7 3h4v2H7zm1 9h2v4H8zm6 0h2v4h-2z"/>'
    },
    "rounded-corner": {
      body: '<path fill="currentColor" d="M3 3h2v2H3zm0 4h2v2H3zm2 4H3v2h2zm-2 4h2v2H3zm2 4H3v2h2zm2 0h2v2H7zm6 0h-2v2h2zm2 0h2v2h-2zm6 0h-2v2h2zm-2-4h2v2h-2zM17 5h-2V3h-4v2h4v2h2v2h2v4h2V9h-2V7h-2zM7 3h2v2H7z"/>',
      hidden: true
    },
    rss: {
      body: '<path fill="currentColor" d="M4 10h6v2H4zm8 4h2v6h-2zm6 0h2v6h-2zM4 16h4v4H4zm12-6h2v4h-2zm-2-2h2v2h-2zM4 4h6v2H4zm6 2h4v2h-4zm0 6h2v2h-2z"/>'
    },
    "rss-circle": {
      body: '<path fill="currentColor" d="M6 2h12v2H6zm0 18h12v2H6zM20 6h2v12h-2zM2 6h2v12H2zm5 9h2v2H7zm0-4h4v2H7zm0-4h6v2H7zm4 6h2v4h-2zm4-2h2v6h-2zm-2-2h2v2h-2zm-9 9h2v2H4zM4 4h2v2H4zm14 0h2v2h-2zm0 14h2v2h-2z"/>'
    },
    "rss-square": {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 18h16v2H4zM20 4h2v16h-2zM2 4h2v16H2zm5 11h2v2H7zm0-4h4v2H7zm0-4h6v2H7zm4 6h2v4h-2zm4-2h2v6h-2zm-2-2h2v2h-2z"/>'
    },
    "rss-square-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 18h20v2H2zM20 4h2v16h-2zM2 4h2v16H2zm5 11h2v2H7zm0-4h4v2H7zm0-4h6v2H7zm4 6h2v4h-2zm4-2h2v6h-2zm-2-2h2v2h-2z"/>'
    },
    save: {
      body: '<path fill="currentColor" d="M20 22H4v-2h2v-6h2v6h8v-6h2v6h2zM4 20H2V4h2zm18 0h-2V6h2zm-6-6H8v-2h8zm-4-4H6V6h6zm8-4h-2V4h2zm-2-2H4V2h14z"/>'
    },
    "save-sharp": {
      body: '<path fill="currentColor" d="M16 20v-6H8v6zm-4-10H6V6h6zm8-4h-2V4h2zm0 14V6h2v16H2V2h16v2H4v16h2v-8h12v8z"/>'
    },
    scale: {
      body: '<g fill="currentColor"><path d="M13 9h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm2-2h2v8h-2z"/><path d="M13 3h8v2h-8zm-2 12H9v-2h2zm-2 2H7v-2h2zm-2 2H5v-2h2zm-2 2H3v-8h2z"/><path d="M11 21H3v-2h8z"/></g>'
    },
    "scan-barcode": {
      body: '<path fill="currentColor" d="M16 2h4v2h-4zm4 2h2v4h-2zm0 12h2v4h-2zm-4 4h4v2h-4zM4 20h4v2H4zm-2-4h2v4H2zM2 4h2v4H2zm2-2h4v2H4zm3 6h2v8H7zm4 0h2v8h-2zm5 0h2v8h-2z"/>'
    },
    "scan-barcode-sharp": {
      body: '<path fill="currentColor" d="M16 2h6v2h-6zm4 2h2v4h-2zm0 12h2v4h-2zm-4 4h6v2h-6zM2 20h6v2H2zm0-4h2v4H2zM2 4h2v4H2zm0-2h6v2H2zm5 6h2v8H7zm4 0h2v8h-2zm5 0h2v8h-2z"/>'
    },
    scissors: {
      body: '<path fill="currentColor" d="M5 2h4v2H5zm0 12h4v2H5zm0-6h4v2H5zm0 12h4v2H5zM3 4h2v4H3zm0 12h2v4H3zM9 4h2v4H9zm0 12h2v4H9zm0-8h2v2H9zm2 2h2v2h-2zm-2 4h2v2H9zm2-2h2v2h-2zm2-2h2v2h-2zm2 4h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zM15 8h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2z"/>'
    },
    "scissors-sharp": {
      body: '<path fill="currentColor" d="M5 2h6v2H5zm0 12h4v2H5zm0-6h4v2H5zm0 12h6v2H5zM3 2h2v8H3zm0 12h2v8H3zM9 4h2v4H9zm0 12h2v4H9zm0-8h2v2H9zm2 2h2v2h-2zm-2 4h2v2H9zm2-2h2v2h-2zm2-2h2v2h-2zm2 4h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zM15 8h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2z"/>'
    },
    script: {
      body: '<path fill="currentColor" d="M16 19h2v2H4v-2h10v-2h2zM6 15h8v2H4v2H2v-4h2V5h2zM20 5h2v6h-2v8h-2V5H6V3h14z"/>'
    },
    "script-sharp": {
      body: '<path fill="currentColor" d="M2 17h2v4H2zM18 5h2v16h-2zM4 3h2v12H4zm10 12h2v4h-2zM4 19h14v2H4zm-2-4h12v2H2zM6 3h14v2H6zm14 2h2v6h-2z"/>'
    },
    "script-text": {
      body: '<path fill="currentColor" d="M6 3h14v2h2v6h-2v8h-2V5H6zm8 14v-2H6V5H4v10H2v4h2v2h14v-2h-2v-2zm0 0v2H4v-2zM8 7h8v2H8zm8 4H8v2h8z"/>',
      hidden: true
    },
    "scroll-horizontal": {
      body: '<g fill="currentColor"><path d="M8 3v2H4V3zm0 16v2H4v-2zm6-16v2h-4V3zm0 16v2h-4v-2zm6-16v2h-4V3zm0 16v2h-4v-2zM18 9v6h2V9z"/><path d="M2 11v2h20v-2z"/><path d="M16 7v10h2V7zM6 9v6H4V9zm2-2v10H6V7z"/></g>'
    },
    "scroll-vertical": {
      body: '<g fill="currentColor"><path d="M21 8h-2V4h2zM5 8H3V4h2zm16 6h-2v-4h2zM5 14H3v-4h2zm16 6h-2v-4h2zM5 20H3v-4h2zm10-2H9v2h6z"/><path d="M13 2h-2v20h2z"/><path d="M17 16H7v2h10zM15 6H9V4h6zm2 2H7V6h10z"/></g>'
    },
    sd: {
      body: '<path fill="currentColor" d="M18 2h2v20H4V6h2v14h12V4H8V2zM8 4H6v2h2zm6 2h2v4h-2zm-2 0h-2v4h2z"/>',
      hidden: true
    },
    search: {
      body: '<path fill="currentColor" d="M22 22h-2v-2h2zm-2-2h-2v-2h2zm-6-2H6v-2h8zm4 0h-2v-2h2zM6 16H4v-2h2zm10 0h-2v-2h2zM4 14H2V6h2zm14 0h-2V6h2zM6 6H4V4h2zm10 0h-2V4h2zm-2-2H6V2h8z"/>'
    },
    section: {
      body: '<path fill="currentColor" d="M5 21H3v-2h2zm4 0H7v-2h2zm4 0h-2v-2h2zm4 0h-2v-2h2zm4 0h-2v-2h2zM5 17H3v-2h2zm16 0h-2v-2h2zM5 13H3v-2h2zm16 0h-2v-2h2zM5 9H3V7h2zm16 0h-2V7h2zM5 5H3V3h2zm4 0H7V3h2zm4 0h-2V3h2zm4 0h-2V3h2zm4 0h-2V3h2z"/>'
    },
    "section-copy": {
      body: '<path fill="currentColor" d="M9 21H7v-2h2zm4 0h-2v-2h2zm4 0h-2v-2h2zm4 0h-2v-2h2zM5 17H3v-2h2zm4 0H7v-2h2zm12 0h-2v-2h2zM5 13H3v-2h2zm4 0H7v-2h2zm12 0h-2v-2h2zM5 9H3V7h2zm4 0H7V7h2zm4 0h-2V7h2zm4 0h-2V7h2zm4 0h-2V7h2zM5 5H3V3h2zm4 0H7V3h2zm4 0h-2V3h2zm4 0h-2V3h2z"/>'
    },
    "section-minus": {
      body: '<path fill="currentColor" d="M5 21H3v-2h2zm4 0H7v-2h2zm4 0h-2v-2h2zm8-2h-6v-2h6zM5 17H3v-2h2zm0-4H3v-2h2zm16 0h-2v-2h2zM5 9H3V7h2zm16 0h-2V7h2zM5 5H3V3h2zm4 0H7V3h2zm4 0h-2V3h2zm4 0h-2V3h2zm4 0h-2V3h2z"/>'
    },
    "section-plus": {
      body: '<path fill="currentColor" d="M5 21H3v-2h2zm4 0H7v-2h2zm4 0h-2v-2h2zm6-4h2v2h-2v2h-2v-2h-2v-2h2v-2h2zM5 17H3v-2h2zm0-4H3v-2h2zm16 0h-2v-2h2zM5 9H3V7h2zm16 0h-2V7h2zM5 5H3V3h2zm4 0H7V3h2zm4 0h-2V3h2zm4 0h-2V3h2zm4 0h-2V3h2z"/>'
    },
    "section-x": {
      body: '<path fill="currentColor" d="M5 21H3v-2h2zm4 0H7v-2h2zm4 0h-2v-2h2zm4 0h-2v-2h2zm4 0h-2v-2h2zm-2-2h-2v-2h2zM5 17H3v-2h2zm12 0h-2v-2h2zm4 0h-2v-2h2zM5 13H3v-2h2zm16 0h-2v-2h2zM5 9H3V7h2zm16 0h-2V7h2zM5 5H3V3h2zm4 0H7V3h2zm4 0h-2V3h2zm4 0h-2V3h2zm4 0h-2V3h2z"/>'
    },
    send: {
      body: '<path fill="currentColor" d="M4 19h4v2H2v-8h2zm8 0H8v-2h4zm4-2h-4v-2h4zm4-2h-4v-2h4zm-10-2H4v-2h6zm12 0h-2v-2h2zM8 5H4v6H2V3h6zm12 6h-4V9h4zm-4-2h-4V7h4zm-4-2H8V5h4z"/>'
    },
    server: {
      body: '<path fill="currentColor" d="M6 7h4v2H6zm0 8h4v2H6zM2 5h2v14H2zm18 0h2v14h-2zM4 19h16v2H4zM4 3h16v2H4zm0 8h16v2H4z"/>'
    },
    "server-sharp": {
      body: '<g fill="currentColor"><path d="M6 7h4v2H6zm0 8h4v2H6zM2 5h2v14H2zm18 0h2v14h-2zM2 19h20v2H2zM2 3h20v2H2z"/><path d="M2 11h20v2H2z"/></g>'
    },
    "settings-2": {
      body: '<g fill="currentColor"><path d="M4 14h2v6H4zm6 0h2v6h-2zm-4-2h4v2H6zm0 8h4v2H6zm-4-4h2v2H2zm20-8h-4V6h4z"/><path d="M10 16h12v2H10zm4-8H2V6h12zm6-4v2h-2V4zm0 6V8h-2v2zm-6-8h4v2h-4zm0 10h4v-2h-4zm-2-8h2v2h-2zm0 6h2V8h-2z"/></g>'
    },
    "settings-2-sharp": {
      body: '<g fill="currentColor"><path d="M4 14h2v6H4zm5 0h2v6H9zm-5-2h7v2H4zm0 8h7v2H4zm-2-4h2v2H2zm20-8h-4V6h4z"/><path d="M10 16h12v2H10zm5-8H2V6h13zm5-4v2h-2V4zm0 6V8h-2v2zm-7-8h7v2h-7zm0 10h7v-2h-7zm0-8h2v2h-2zm0 6h2V8h-2z"/></g>'
    },
    "settings-cog": {
      body: '<g fill="currentColor"><g clip-path="url(#SVGHcSWxdhd)"><path d="M9 0h6v2H9zm6 24H9v-2h6zM0 15V9h2v6zm24-6v6h-2V9zM9 2h2v4H9zm6 20h-2v-4h2zM2 15v-2h4v2zm20-6v2h-4V9zm-9-7h2v4h-2zm-2 20H9v-4h2zM2 11V9h4v2zm20 2v2h-4v-2zM7 4h2v2H7zm10 0h-2v2h2zm0 16h-2v-2h2zM7 20h2v-2H7zM2 2h5v2H2zm20 0h-5v2h5zm0 20h-5v-2h5zM2 22h5v-2H2z"/><path d="M2 2h2v5H2zm20 0h-2v5h2zm0 20h-2v-5h2zM2 22h2v-5H2zM4 7h2v2H4zm16 0h-2v2h2zm0 10h-2v-2h2zM4 17h2v-2H4zm6-9h4v2h-4zm0 6h4v2h-4zm-2-4h2v4H8zm6 0h2v4h-2z"/></g><defs><clipPath id="SVGHcSWxdhd"><path fill="#fff" d="M0 0h24v24H0z"/></clipPath></defs></g>'
    },
    "settings-cog-2": {
      body: '<g fill="currentColor"><path d="M18 2h2v2h-2zM4 2h2v2H4zm16 20h-2v-2h2zM4 22h2v-2H4zM20 4h2v2h-2zM6 4h4v2H6zm12 16h-4v-2h4zM6 20h4v-2H6zM18 6h2v4h-2zM4 6h2v4H4zm16 12h-2v-4h2zM4 18h2v-4H4zM14 4h4v2h-4zM2 4h2v2H2zm20 16h-2v-2h2zM2 20h2v-2H2z"/><path d="M8 2h2v4H8zm0 20h2v-4H8z"/><path d="M8 2h8v2H8zm0 20h8v-2H8zM2 8h2v8H2zm20 8h-2V8h2z"/><path d="M20 8h2v4h-2zM10 8h4v2h-4zm-2 2h2v4H8zm2 4h4v2h-4zm4-4h2v4h-2z"/></g>'
    },
    shapes: {
      body: '<path fill="currentColor" d="M2 13h9v2H2zm0 2h2v5H2zm0 5h9v2H2zm7-5h2v5H9zm6-2h5v2h-5zm-2 2h2v5h-2zm2 5h5v2h-5zm5-5h2v5h-2zM7 9h10v2H7zm0-2h2v2H7zm2-3h2v3H9zm2-2h2v2h-2zm2 2h2v3h-2zm2 3h2v2h-2z"/>'
    },
    share: {
      body: '<path fill="currentColor" d="M20 22H4v-2h16zM4 20H2v-6h2zm18 0h-2v-6h2zM13 4h2v2h2v2h-4v10h-2V8H7V6h2V4h2V2h2zM9 14H4v-2h5zm11 0h-5v-2h5z"/>'
    },
    "share-sharp": {
      body: '<path fill="currentColor" d="M9 14H4v6h16v-6h-5v-2h7v10H2V12h7zm4-10h2v2h2v2h-4v10h-2V8H7V6h2V4h2V2h2z"/>'
    },
    "sharp-corner": {
      body: '<path fill="currentColor" d="M3 3h2v2H3zm0 4h2v2H3zm2 4H3v2h2zm-2 4h2v2H3zm2 4H3v2h2zm2 0h2v2H7zm6 0h-2v2h2zm2 0h2v2h-2zm6 0h-2v2h2zm-2-4h2v2h-2zm2-2V3H11v2h8v8zM7 3h2v2H7z"/>',
      hidden: true
    },
    shield: {
      body: '<path fill="currentColor" d="M4 2h16v2H4zM2 4h2v10H2zm18 0h2v10h-2zM4 14h2v2H4zm2 2h2v2H6zm4 4h4v2h-4zm10-6h-2v2h2zm-2 2h-2v2h2zm-2 2h-2v2h2zm-6 0H8v2h2z"/>'
    },
    "shield-off": {
      body: '<path fill="currentColor" d="M8 2h14v12h-2V4H8zM2 8h2v6H2zm2 6h2v2H4zm4 2H6v2h2v2h2v2h4v-2h-4v-2H8zm10 0h-2v2h2v2h2v2h2v-2h-2v-2h-2zM4 2H2v2h2v2h2v2h2v2h2v2h2v2h2v2h2v-2h-2v-2h-2v-2h-2V8H8V6H6V4H4z"/>',
      hidden: true
    },
    "shield-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 2h2v10H2zm18 0h2v10h-2zM4 14h2v2H4zm2 2h2v2H6zm4 4h4v2h-4zm10-6h-2v2h2zm-2 2h-2v2h2zm-2 2h-2v2h2zm-6 0H8v2h2z"/>'
    },
    ship: {
      body: '<g fill="currentColor"><path d="M14 8h2v2h-2zm4 8h2v2h-2zM8 4h2v4H8z"/><path d="M6 6h8v2H6zm-4 4h20v2H2zm18 2h2v4h-2zM2 12h2v6H2zm4-4h2v2H6z"/><path d="M0 16h4v2H0zm4 2h4v2H4zm4-2h4v2H8zm4 2h4v2h-4zm4-2h4v2h-4zm4 2h4v2h-4z"/></g>'
    },
    shirt: {
      body: '<g fill="currentColor"><path d="M4 3h6v2H4zM2 3h2v8H2zm2 6h4v2H4z"/><path d="M6 9h2v10H6zm2 10h8v2H8zm8-10h2v10h-2z"/><path d="M16 9h4v2h-4zm4-6h2v8h-2zm-6 0h6v2h-6zm-4 2h4v2h-4z"/></g>'
    },
    "shirt-sharp": {
      body: '<g fill="currentColor"><path d="M4 3h6v2H4zM2 3h2v8H2zm2 6h4v2H4z"/><path d="M6 9h2v10H6zm0 10h12v2H6zM16 9h2v10h-2z"/><path d="M16 9h4v2h-4zm4-6h2v8h-2zm-6 0h6v2h-6zM8 5h8v2H8z"/></g>'
    },
    "shopping-bag": {
      body: '<g fill="currentColor"><path d="M3 6h18v2H3zm2 14h14v2H5zM3 8h2v12H3zm16 0h2v12h-2z"/><path d="M7 4h2v6H7zm2-2h6v2H9zm6 2h2v6h-2z"/></g>'
    },
    "shopping-bag-sharp": {
      body: '<g fill="currentColor"><path d="M3 6h18v2H3zm2 14h14v2H5zM3 8h2v12H3zm16 0h2v12h-2z"/><path d="M7 4h2v6H7zm2-2h6v2H9zm6 2h2v6h-2z"/></g>'
    },
    "shopping-cart": {
      body: '<path fill="currentColor" d="M2 2h2v2H2zm2 6h2v4H4zm2 4h2v4H6zm2 4h10v2H8zm10-4h2v4h-2zm2-4h2v4h-2zM4 6h18v2H4zm0-4h2v4H4zm2 17h3v3H6zm11 0h3v3h-3z"/>'
    },
    shuffle: {
      body: '<path fill="currentColor" d="M10 19H2v-2h8zm12 0h-8v-2h8zm-10-2h-2v-6h2zm6-10h2v2h2v2h-2v2h-2v2h-2v-4h-4V9h4V5h2zM8 11H2V9h6z"/>'
    },
    "shuffle-sharp": {
      body: '<path fill="currentColor" d="M18 7h2v2h2v2h-2v2h-2v2h-2v-4h-4v8H2v-2h8V9h6V5h2zm4 12h-8v-2h8zM8 11H2V9h6z"/>'
    },
    signal: {
      body: '<path fill="currentColor" d="M19 3h2v18h-2zm-4 4h2v14h-2zm-4 4h2v10h-2zm-4 4h2v6H7zm-4 4h2v2H3z"/>'
    },
    siren: {
      body: '<path fill="currentColor" d="M6 11h2v5H6zm2-2h2v2H8zm2-2h4v2h-4zm4 2h2v2h-2zm2 2h2v5h-2zM6 16h12v2H6zm-2 4h16v2H4zm0-2h2v2H4zm14 0h2v2h-2zm-7-6h2v4h-2zm9-1h3v2h-3zM1 11h3v2H1zm5-6h2v2H6zm10 0h2v2h-2zm2-2h2v2h-2zM4 3h2v2H4zm7-1h2v3h-2z"/>'
    },
    "siren-off": {
      body: '<path fill="currentColor" d="M6 11h2v5H6zm2-2h2v2H8zm2-2h4v2h-4zm4 2h2v2h-2zm2 2h2v5h-2zM6 16h12v2H6zm-2 4h16v2H4zm0-2h2v2H4zm14 0h2v2h-2zm-7-6h2v4h-2z"/>'
    },
    "siren-off-sharp": {
      body: '<path fill="currentColor" d="M6 11h2v5H6zm2-2h2v2H8zm2-2h4v2h-4zm4 2h2v2h-2zm2 2h2v5h-2zM6 16h12v2H6zm-2 4h16v2H4zm0-4h2v4H4zm14 0h2v4h-2zm-7-4h2v4h-2z"/>'
    },
    "siren-sharp": {
      body: '<path fill="currentColor" d="M6 11h2v5H6zm2-2h2v2H8zm2-2h4v2h-4zm4 2h2v2h-2zm2 2h2v5h-2zM6 16h12v2H6zm-2 4h16v2H4zm0-4h2v4H4zm14 0h2v4h-2zm-7-4h2v4h-2zm9-1h3v2h-3zM1 11h3v2H1zm5-6h2v2H6zm10 0h2v2h-2zm2-2h2v2h-2zM4 3h2v2H4zm7-1h2v3h-2z"/>'
    },
    skull: {
      body: '<g fill="currentColor"><path d="M7 20h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2zm-6-4h2v4H9zm4 0h2v4h-2zm-8-2h2v6H5zm12 0h2v6h-2z"/><path d="M3 14h4v2H3zM1 4h2v10H1zm20 0h2v10h-2zM3 2h18v2H3zm14 12h4v2h-4zM8 7h2v4H8zm6 0h2v4h-2z"/></g>'
    },
    "skull-sharp": {
      body: '<g fill="currentColor"><path d="M5 20h14v2H5zm4-4h2v4H9zm4 0h2v4h-2zm-8-2h2v6H5zm12 0h2v6h-2z"/><path d="M3 14h4v2H3zM1 2h2v14H1zm20 0h2v14h-2zM3 2h18v2H3zm14 12h4v2h-4zM8 7h2v4H8zm6 0h2v4h-2z"/></g>'
    },
    sliders: {
      body: '<path fill="currentColor" d="M17 4h2v10h-2zm0 12h-2v2h2v2h2v-2h2v-2zm-4-6h-2v10h2zm-8 2H3v2h2v6h2v-6h2v-2zm8-8h-2v2H9v2h6V6h-2zM5 4h2v6H5z"/>',
      hidden: true
    },
    "sliders-2": {
      body: '<path fill="currentColor" d="M4 4h6v3h12v2H10v3H4V9H2V7h2zm2 2v4h2V6zm8 6h6v3h2v2h-2v3h-6v-3H2v-2h12zm2 2v4h2v-4z"/>',
      hidden: true
    },
    "smart-home": {
      body: '<path fill="currentColor" d="M4 20h16v2H4zm16-10h2v10h-2zM2 10h2v10H2zm2-2h2v2H4zm2-2h2v2H6zm2-2h2v2H8zm2-2h4v2h-4zm4 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm-9 8h6v2H9zm-2-2h2v2H7zm8 0h2v2h-2z"/>'
    },
    "smart-home-sharp": {
      body: '<path fill="currentColor" d="M2 20h20v2H2zm18-10h2v10h-2zM2 10h2v10H2zm2-2h2v2H4zm2-2h2v2H6zm2-2h2v2H8zm2-2h4v2h-4zm4 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm-9 8h6v2H9zm-2-2h2v2H7zm8 0h2v2h-2z"/>'
    },
    smartphone: {
      body: '<path fill="currentColor" d="M6 2h12v2H6zm0 18h12v2H6zM4 4h2v16H4zm14 0h2v16h-2zm-7 13h2v2h-2z"/>'
    },
    "smartphone-sharp": {
      body: '<path fill="currentColor" d="M6 2h12v2H6zm0 18h12v2H6zM4 2h2v20H4zm14 0h2v20h-2zm-7 15h2v2h-2z"/>'
    },
    smile: {
      body: '<path fill="currentColor" d="M6 20h12v2H6zM6 2h12v2H6zm12 2h2v2h-2zM4 4h2v2H4zm0 14h2v2H4zm14 0h2v2h-2zM2 6h2v12H2zm18 0h2v12h-2zM7 13h2v2H7zm2 2h6v2H9zm6-2h2v2h-2zM8 8h2v2H8zm6 0h2v2h-2z"/>'
    },
    "smile-sharp": {
      body: '<path fill="currentColor" d="M4 20h16v2H4zM4 2h16v2H4zM2 2h2v20H2zm18 0h2v20h-2zM7 13h2v2H7zm2 2h6v2H9zm6-2h2v2h-2zM8 8h2v2H8zm6 0h2v2h-2z"/>'
    },
    sofa: {
      body: '<path fill="currentColor" d="M5 3h14v2H5zM3 5h2v3H3zM1 8h6v2H1zm0 2h2v7H1zm2 7h18v2H3zm18-7h2v7h-2zm-4-2h6v2h-6zm0 2h2v2h-2zM7 12h10v2H7zm-2-2h2v2H5zm6-5h2v7h-2zm8 0h2v3h-2zm0 14h2v2h-2zM3 19h2v2H3z"/>'
    },
    "sofa-sharp": {
      body: '<path fill="currentColor" d="M3 3h18v2H3zm0 2h2v3H3zM1 8h6v2H1zm0 2h2v7H1zm0 7h22v2H1zm20-7h2v7h-2zm-4-2h6v2h-6zm0 2h2v2h-2zM5 12h14v2H5zm0-2h2v2H5zm6-5h2v7h-2zm8 0h2v3h-2zm0 14h2v2h-2zM3 19h2v2H3z"/>'
    },
    sort: {
      body: '<path fill="currentColor" d="M8 20H6V8H4V6h2V4h2v2h2v2H8zm2-12v2h2V8zM4 8v2H2V8zm14-4h-2v12h-2v-2h-2v2h2v2h2v2h2v-2h2v-2h2v-2h-2v2h-2z"/>',
      hidden: true
    },
    "sort-alphabetic": {
      body: '<path fill="currentColor" d="M11 2h2v2h-2zm0 2v2H9V4zm2 0h2v2h-2zM9 18v2h2v2h2v-2h2v-2h-2v2h-2v-2zM8 8H2v8h2v-2h2v2h2zm-2 4H4v-2h2zm6-1v-1h2v1zm4-3h-6v8h6zm-4 6v-1h2v1zm10-6h-4v8h4v-2h-2v-4h2z"/>',
      hidden: true
    },
    "sort-horizontal": {
      body: '<path fill="currentColor" d="M20 16v2H4v-2zm-10-2v2H6v-2zm0-2v2H8v-2zm0 6v2H6v-2zm0 2v2H8v-2zM4 6v2h16V6zm10-2v2h4V4zm0-2v2h2V2zm0 6v2h4V8zm0 2v2h2v-2z"/>'
    },
    "sort-numeric": {
      body: '<path fill="currentColor" d="M13 2h-2v2H9v2h2V4h2v2h2V4h-2zM2 8h4v8H4v-6H2zm6 0h6v5h-4v1h4v2H8v-5h4v-1H8zm12 0h-4v2h4v1h-4v2h4v1h-4v2h6V8zm-9 10v2H9v-2zm2 2h-2v2h2zm0 0v-2h2v2z"/>',
      hidden: true
    },
    "sort-vertical": {
      body: '<path fill="currentColor" d="M16 4h2v16h-2zm-2 10h2v4h-2zm-2 0h2v2h-2zm6 0h2v4h-2zm2 0h2v2h-2zM6 20h2V4H6zM4 10h2V6H4zm-2 0h2V8H2zm6 0h2V6H8zm2 0h2V8h-2z"/>'
    },
    sparkle: {
      body: '<path fill="currentColor" d="M11 1h2v4h-2zm0 22h2v-4h-2zM9 5h2v4H9zm0 14h2v-4H9zm4-14h2v4h-2zm0 14h2v-4h-2zM5 9h4v2H5zm14 0h-4v2h4zM1 11h4v2H1zm22 0h-4v2h4zM5 13h4v2H5zm14 0h-4v2h4z"/>'
    },
    sparkles: {
      body: '<g fill="currentColor"><path d="M11 1h2v4h-2zm0 22h2v-4h-2zM9 5h2v4H9zm0 14h2v-4H9zm4-14h2v4h-2zm0 14h2v-4h-2zM5 9h4v2H5zm14 0h-4v2h4zM1 11h4v2H1zm22 0h-4v2h4zM5 13h4v2H5zm14 0h-4v2h4zm0-12h2v6h-2z"/><path d="M17 3h6v2h-6zM3 17h2v2H3zm-2 2h2v2H1zm2 2h2v2H3zm2-2h2v2H5z"/></g>'
    },
    speaker: {
      body: '<path fill="currentColor" d="M4 2H3v20h18V2zm15 2v16H5V4zm-6 2h-2v2h2zm-5 4h8v6h-2v-4h-4v4H8zm8 6H8v2h8z"/>',
      hidden: true
    },
    "speed-fast": {
      body: '<path fill="currentColor" d="M5 19H3v-2h2zm16 0h-2v-2h2zM3 17H1v-6h2zm11 0h-4v-4h4zm9 0h-2v-6h2zm-7-4h-2v-2h2zM5 11H3V9h2zm13 0h-2V9h2zM9 9H5V7h4zm11 0h-2V7h2zm-5-2H9V5h6z"/>'
    },
    "speed-medium": {
      body: '<path fill="currentColor" d="M5 19H3v-2h2zm16 0h-2v-2h2zM3 17H1v-6h2zm11 0h-4v-4h1V5h2v8h1zm9 0h-2v-6h2zM5 11H3V9h2zm16 0h-2V9h2zM9 9H5V7h4zm10 0h-4V7h4z"/>'
    },
    "speed-slow": {
      body: '<path fill="currentColor" d="M5 19H3v-2h2zm16 0h-2v-2h2zM3 17H1v-6h2zm11 0h-4v-4h4zm9 0h-2v-6h2zm-13-4H8v-2h2zm-2-2H6V9h2zm13 0h-2V9h2zM6 7v2H4V7zm13 2h-4V7h4zm-4-2H9V5h6z"/>'
    },
    "spline-cursor": {
      body: '<path fill="currentColor" d="M12 10h2v12h-2zm2 0h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm-6 4h2v2h-2zm2-2h6v2h-6zM4 15h3v2H4zM17 2h3v2h-3zM7 17h2v3H7zM20 4h2v3h-2zM2 17h2v3H2zM15 4h2v3h-2zM4 20h3v2H4zM17 7h3v2h-3zM4 8h2v5H4zm2-2h2v2H6zm2-2h5v2H8z"/>'
    },
    spotlight: {
      body: '<path fill="currentColor" d="M19 2H5v2h14zm0 18H5v2h14zM5 4H3v16h2zm16 0h-2v16h2zm-8 2H7v2h6zm-4 4H7v8h2zm8 0h-2v8h2zm-8 0h6v2H9zm0 6h6v2H9z"/>'
    },
    "spotlight-sharp": {
      body: '<path fill="currentColor" d="M21 2H3v2h18zm0 18H3v2h18zM5 4H3v16h2zm16 0h-2v16h2zm-8 2H7v2h6zm-4 4H7v8h2zm8 0h-2v8h2zm-8 0h6v2H9zm0 6h6v2H9z"/>'
    },
    spray: {
      body: '<path fill="currentColor" d="M4 9h6v2H4zm2-2h2v2H6zm-4 4h2v10H2zm2 8h6v2H4zm6-8h2v10h-2zm2-4h2v2h-2zm2-2h2v2h-2zm0 6h2V9h-2zm2-8h2v2h-2zm0 10h2v-2h-2zm2-12h2v2h-2zm0 14h2v-2h-2zm-2-8h2v2h-2zm2-2h2v2h-2zm0 4h2v2h-2z"/>'
    },
    "spray-can": {
      body: '<g fill="currentColor"><path d="M9 3h4v4H9zM7 7h8v2H7zM5 21h12v2H5zM15 9h2v12h-2zM5 9h2v12H5zm4 8h6v2H9z"/><path d="M9 13h2v6H9z"/><path d="M9 13h8v2H9zm6-10h2v2h-2zm2-2h2v2h-2zm0 4h2v2h-2z"/></g>'
    },
    "spray-image": {
      body: '<path fill="currentColor" d="M4 12h6v2H4zm2-2h2v2H6zm-4 4h2v6H2zm0 6h10v2H2zm8-6h2v6h-2zM4 2h16v2H4zM2 4h2v6H2zm18 0h2v16h-2zm-6 16h6v2h-6zm4-8h2v2h-2zm0 4h2v2h-2zm-6-6h2v2h-2zm2-2h2v2h-2zm0 8h2v2h-2zm2-6h2v2h-2zm0 4h2v2h-2zM8 6h2v2H8z"/>'
    },
    "spray-wave": {
      body: '<g fill="currentColor"><path d="M4 9h6v2H4zm2-2h2v2H6zm-4 4h2v10H2zm2 8h6v2H4zm6-8h2v10h-2z"/><path d="M6 15h6v2H6zm8-11h2v2h-2zm4-2h2v2h-2zm0 10h2v2h-2zm-2-6h2v4h-2zm4-2h2v8h-2zm-6 6h2v2h-2zm-3-3h2v2h-2z"/></g>'
    },
    square: {
      body: '<path fill="currentColor" d="M2 4h2v16H2zm2 16h16v2H4zM20 4h2v16h-2zM4 2h16v2H4z"/>'
    },
    "square-alert": {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 18h16v2H4zM20 4h2v16h-2zM2 4h2v16H2zm9 2h2v8h-2zm0 10h2v2h-2z"/>'
    },
    "square-alert-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 18h20v2H2zM20 4h2v16h-2zM2 4h2v16H2zm9 2h2v8h-2zm0 10h2v2h-2z"/>'
    },
    "square-chevron-down": {
      body: '<path fill="currentColor" d="M4 20h16v2H4zM4 2h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zm-9 11h2v-2h-2zm-2-2h2v-2H9zm-2-2h2V9H7zm6 2h2v-2h-2zm2-2h2V9h-2z"/>'
    },
    "square-chevron-down-sharp": {
      body: '<path fill="currentColor" d="M2 20h20v2H2zM2 2h20v2H2zm0 2h2v16H2zm18 0h2v16h-2zm-9 11h2v-2h-2zm-2-2h2v-2H9zm-2-2h2V9H7zm6 2h2v-2h-2zm2-2h2V9h-2z"/>'
    },
    "square-chevron-left": {
      body: '<path fill="currentColor" d="M4 20h16v2H4zM4 2h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zM9 11v2h2v-2zm2-2v2h2V9zm2-2v2h2V7zm-2 6v2h2v-2zm2 2v2h2v-2z"/>'
    },
    "square-chevron-left-sharp": {
      body: '<path fill="currentColor" d="M2 20h20v2H2zM2 2h20v2H2zm0 2h2v16H2zm18 0h2v16h-2zM9 11v2h2v-2zm2-2v2h2V9zm2-2v2h2V7zm-2 6v2h2v-2zm2 2v2h2v-2z"/>'
    },
    "square-chevron-right": {
      body: '<path fill="currentColor" d="M4 20h16v2H4zM4 2h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zm-5 7v2h-2v-2zm-2-2v2h-2V9zm-2-2v2H9V7zm2 6v2h-2v-2zm-2 2v2H9v-2z"/>'
    },
    "square-chevron-right-sharp": {
      body: '<path fill="currentColor" d="M2 20h20v2H2zM2 2h20v2H2zm0 2h2v16H2zm18 0h2v16h-2zm-5 7v2h-2v-2zm-2-2v2h-2V9zm-2-2v2H9V7zm2 6v2h-2v-2zm-2 2v2H9v-2z"/>'
    },
    "square-chevron-up": {
      body: '<path fill="currentColor" d="M4 20h16v2H4zM4 2h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zm-9 5h2v2h-2zm-2 2h2v2H9zm-2 2h2v2H7zm6-2h2v2h-2zm2 2h2v2h-2z"/>'
    },
    "square-chevron-up-sharp": {
      body: '<path fill="currentColor" d="M2 20h20v2H2zM2 2h20v2H2zm0 2h2v16H2zm18 0h2v16h-2zm-9 5h2v2h-2zm-2 2h2v2H9zm-2 2h2v2H7zm6-2h2v2h-2zm2 2h2v2h-2z"/>'
    },
    "square-cursor": {
      body: '<path fill="currentColor" d="M12 10h2v12h-2zm2 0h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm-6 4h2v2h-2zm2-2h6v2h-6zM4 2h16v2H4zm0 18h6v2H4zM2 4h2v16H2zm18 0h2v8h-2z"/>'
    },
    "square-cursor-sharp": {
      body: '<path fill="currentColor" d="M12 10h2v12h-2zm2 0h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm-6 4h2v2h-2zm2-2h6v2h-6zM2 2h20v2H2zm0 18h8v2H2zM2 4h2v16H2zm18 0h2v8h-2z"/>'
    },
    "square-dashed-cursor": {
      body: '<path fill="currentColor" d="M12 10h2v12h-2zm2 0h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm-6 4h2v2h-2zm2-2h6v2h-6zM2 16h2v4H2zm2 4h2v2H4zm4 0h2v2H8zM2 10h2v4H2zm0-6h2v4H2zm2-2h2v2H4zm4 0h4v2H8zm6 0h4v2h-4zm6 2h2v4h-2zm0 6h2v2h-2z"/>'
    },
    "square-dashed-cursor-sharp": {
      body: '<g fill="currentColor"><path d="M12 10h2v12h-2zm2 0h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm-6 4h2v2h-2zm2-2h6v2h-6zM2 18h2v4H2zm2 2h2v2H4zm4 0h2v2H8zM2 8h2v4H2zm0-6h2v4H2zm2 0h2v2H4zm4 0h4v2H8zm10 0h4v2h-4z"/><path d="M20 2h2v4h-2zm0 6h2v4h-2zm-6-6h2v2h-2zM2 14h2v2H2z"/></g>'
    },
    "square-power": {
      body: '<path fill="currentColor" d="M4 20h16v2H4zM4 2h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zM9 15h6v2H9zM7 9h2v6H7zm8 0h2v6h-2zm-4-2h2v5h-2z"/>'
    },
    "square-power-sharp": {
      body: '<path fill="currentColor" d="M2 20h20v2H2zM2 2h20v2H2zm0 2h2v16H2zm18 0h2v16h-2zM9 15h6v2H9zM7 9h2v6H7zm8 0h2v6h-2zm-4-2h2v5h-2z"/>'
    },
    "square-scissors": {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zm-4 3h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2h-2zm4 4h2v2h-2zm-2-2h2v2h-2zm-4-2h2v2h-2zm0-2h2v2h-2zM8 7h2v2H8zm0 8h2v2H8zm-2-2h2v2H6zm2-2h2v2H8zM6 9h2v2H6zm4 4h2v2h-2z"/>'
    },
    "square-scissors-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2zm-4 3h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2h-2zm4 4h2v2h-2zm-2-2h2v2h-2zm-4-2h2v2h-2zm0-2h2v2h-2zM8 7h2v2H8zm0 8h2v2H8zm-2-2h2v2H6zm2-2h2v2H8zM6 9h2v2H6zm4 4h2v2h-2z"/>'
    },
    "square-sharp": {
      body: '<path fill="currentColor" d="M2 4h2v16H2zm0 16h20v2H2zM20 4h2v16h-2zM2 2h20v2H2z"/>'
    },
    star: {
      body: '<path fill="currentColor" d="M5 20h3v2H3v-6h2zm16 2h-5v-2h3v-4h2zm-11-2H8v-2h2zm6 0h-2v-2h2zm-2-2h-4v-2h4zm-7-2H5v-3h2zm12 0h-2v-3h2zM5 13H3v-2h2zm16 0h-2v-2h2zM9 9H3v2H1V7h8zm14 2h-2V9h-6V7h8zM11 7H9V3h2zm4 0h-2V3h2zm-2-4h-2V1h2z"/>'
    },
    sticker: {
      body: '<g fill="currentColor"><path d="M4 4H2v16h2zm14-2H4v2h14zm4 4h-2v14h2zm-2 14H4v2h16zM18 4h2v2h-2zm-4 0h2v4h-2z"/><path d="M14 6h6v2h-6zm-6 8h2v2H8zm6 0h2v2h-2zm-4 2h4v2h-4zm-2-6h2v2H8zm6 0h2v2h-2z"/></g>'
    },
    "sticker-sharp": {
      body: '<g fill="currentColor"><path d="M4 4H2v16h2zm14-2H2v2h16zm4 4h-2v14h2zm0 14H2v2h20zM18 4h2v2h-2zm-4 0h2v4h-2z"/><path d="M14 6h6v2h-6zm-6 8h2v2H8zm6 0h2v2h-2zm-4 2h4v2h-4zm-2-6h2v2H8zm6 0h2v2h-2z"/></g>'
    },
    "sticky-note": {
      body: '<path fill="currentColor" d="M4 4H2v16h2zm12-2H4v2h12zm6 6h-2v12h2zm-2 12H4v2h16zM18 6h2v2h-2zm-2-2h2v2h-2zm-4 0h2v6h-2zm0 6h8v2h-8z"/>'
    },
    "sticky-note-sharp": {
      body: '<path fill="currentColor" d="M4 4H2v16h2zm12-2H2v2h14zm6 6h-2v12h2zm0 12H2v2h20zM18 6h2v2h-2zm-2-2h2v2h-2zm-4 0h2v6h-2zm0 6h8v2h-8z"/>'
    },
    "sticky-note-text": {
      body: '<path fill="currentColor" d="M4 4H2v16h2zm12-2H4v2h12zm6 6h-2v12h2zm-2 12H4v2h16zM18 6h2v2h-2zm-2-2h2v2h-2zm-4 0h2v6h-2zm0 6h8v2h-8zm-6 2h4v2H6zm0 4h6v2H6z"/>'
    },
    "sticky-note-text-sharp": {
      body: '<path fill="currentColor" d="M4 4H2v16h2zm12-2H2v2h14zm6 6h-2v12h2zm0 12H2v2h20zM18 6h2v2h-2zm-2-2h2v2h-2zm-4 0h2v6h-2zm0 6h8v2h-8zm-6 2h4v2H6zm0 4h6v2H6z"/>'
    },
    store: {
      body: '<path fill="currentColor" d="M3 13h2v8H3zm2 8h14v2H5zm14-8h2v8h-2zm-9-2h4v2h-4zm4-2h4v2h-4zm4 2h4v2h-4zM6 9h4v2H6zm-4 2h4v2H2zM0 7h2v4H0zm2-2h2v2H2zm18 0h2v2h-2zm2 2h2v4h-2zM4 3h16v2H4zm6 12h4v2h-4zm-2 2h2v4H8zm6 0h2v4h-2z"/>'
    },
    "store-sharp": {
      body: '<path fill="currentColor" d="M3 13h2v8H3zm0 8h18v2H3zm16-8h2v8h-2zm-9-2h4v2h-4zm4-2h4v2h-4zm4 2h4v2h-4zM6 9h4v2H6zm-4 2h4v2H2zM0 5h2v6H0zm22 0h2v6h-2zM0 3h24v2H0zm8 12h8v2H8zm0 2h2v4H8zm6 0h2v4h-2z"/>'
    },
    subscriptions: {
      body: '<path fill="currentColor" d="M4 10h16v2H4zm0 10h16v2H4zm-2-8h2v8H2zm18 0h2v8h-2zM6 6h12v2H6zm2-4h8v2H8zM6 16h2v2H6zm4 0h2v2h-2zm4 0h2v2h-2z"/>'
    },
    "subscriptions-sharp": {
      body: '<path fill="currentColor" d="M2 10h20v2H2zm0 10h20v2H2zm0-8h2v8H2zm18 0h2v8h-2zM6 6h12v2H6zm2-4h8v2H8zM6 16h2v2H6zm4 0h2v2h-2zm4 0h2v2h-2z"/>'
    },
    subtitles: {
      body: '<path fill="currentColor" d="M21 7h-8v10h8v-2h-6V9h6zM3 15V7h8v2H5v6h6v2H3z"/>',
      hidden: true
    },
    suitcase: {
      body: '<path fill="currentColor" d="M4 6h16v2H4zM2 8h2v12H2zm18 0h2v12h-2zM4 20h16v2H4zM8 4h2v2H8zm2-2h4v2h-4zm4 2h2v2h-2zm-8 6h2v8H6zm10 0h2v8h-2z"/>'
    },
    "suitcase-sharp": {
      body: '<path fill="currentColor" d="M2 6h20v2H2zm0 2h2v12H2zm18 0h2v12h-2zM2 20h20v2H2zM8 4h2v2H8zm0-2h8v2H8zm6 2h2v2h-2zm-8 6h2v8H6zm10 0h2v8h-2z"/>'
    },
    sun: {
      body: '<path fill="currentColor" d="M13 3h-2v2h2zm4 2h2v2h-2zm-6 6h2v2h-2zm-8 0h2v2H3zm18 0h-2v2h2zM5 5h2v2H5zm14 14h-2v-2h2zm-8 2h2v-2h-2zm-4-2H5v-2h2zM9 7h6v2H9zm0 8H7V9h2zm0 0v2h6v-2h2V9h-2v6z"/>',
      hidden: true
    },
    "sun-alt": {
      body: '<path fill="currentColor" d="M13 0h-2v4h2zM0 11v2h4v-2zm24 0v2h-4v-2zM13 24h-2v-4h2zM8 6h8v2H8zM6 8h2v8H6zm2 10v-2h8v2zm10-2h-2V8h2zm2-14h2v2h-2zm0 2v2h-2V4zm2 18h-2v-2h2zm-2-2h-2v-2h2zM4 2H2v2h2v2h2V4H4zM2 22h2v-2h2v-2H4v2H2z"/>',
      hidden: true
    },
    sunglasses: {
      body: '<path fill="currentColor" d="M15 10h5v2h-5zM4 10h5v2H4zm16 2h2v5h-2zM9 12h2v5H9zm4 0h2v5h-2zM2 12h2v5H2zm13 5h5v2h-5zM4 17h5v2H4zm7-5h2v2h-2zM2 6h2v6H2zm18 0h2v6h-2zM4 4h2v2H4zm14 0h2v2h-2zM6 12h3v2H6zm11 0h3v2h-3zM4 14h2v3H4zm11 0h2v3h-2zm-9 2h3v1H6zm11 0h3v1h-3zm-9-2h1v2H8zm11 0h1v2h-1z"/>'
    },
    "sunglasses-sharp": {
      body: '<path fill="currentColor" d="M13 10h7v2h-7zm-9 0h7v2H4zm16 2h2v5h-2zM9 12h2v5H9zm4 0h2v5h-2zM2 12h2v5H2zm11 5h9v2h-9zM2 17h9v2H2zm9-5h2v2h-2zM2 6h2v6H2zm18 0h2v6h-2zM4 4h2v2H4zm14 0h2v2h-2zM6 12h3v2H6zm11 0h3v2h-3zM4 14h2v3H4zm11 0h2v3h-2zm-9 2h3v1H6zm11 0h3v1h-3zm-9-2h1v2H8zm11 0h1v2h-1z"/>'
    },
    switch: {
      body: '<path fill="currentColor" d="M5 21H3v-2h2zm16 0h-6v-2h2v-2h2v-2h2zM7 19H5v-2h2zm2-2H7v-2h2zm8 0h-2v-2h2zm-2-2h-2v-2h2zm-2-2h-2v-2h2zm-2-2H9V9h2zm4 0h-2V9h2zM9 9H7V7h2zm8 0h-2V7h2zm4-6v6h-2V7h-2V5h-2V3zM7 7H5V5h2zM5 5H3V3h2z"/>'
    },
    sword: {
      body: '<path fill="currentColor" d="M11 2h2v2h-2zM9 4h2v12H9zm4 0h2v12h-2zM7 16h10v2H7zm4 2h2v4h-2z"/>'
    },
    sync: {
      body: '<path fill="currentColor" d="M4 9V7h12V5h2v2h2v2h-2v2h-2V9zm12 2h-2v2h2zm0-6h-2V3h2zm4 12v-2H8v-2h2v-2H8v2H6v2H4v2h2v2h2v2h2v-2H8v-2z"/>',
      hidden: true
    },
    "t-arrow-down": {
      body: '<g fill="currentColor"><path d="M16 6h2v12h-2zm2 8h2v2h-2zm-4 0h2v2h-2zm4-2h4v2h-4zm-6 0h4v2h-4zM6 8h2v10H6zM2 6h8v2H2z"/><path d="M2 6h2v3H2zm8 0h2v3h-2zM4 16h6v2H4z"/></g>'
    },
    "t-arrow-up": {
      body: '<g fill="currentColor"><path d="M16 18h2V6h-2zm2-8h2V8h-2zm-4 0h2V8h-2zm4 2h4v-2h-4zm-6 0h4v-2h-4zM6 8h2v10H6zM2 6h8v2H2z"/><path d="M2 6h2v3H2zm8 0h2v3h-2zM4 16h6v2H4z"/></g>'
    },
    tab: {
      body: '<path fill="currentColor" d="M2 6h2v12H2zm2 12h16v2H4zM20 6h2v12h-2zM4 4h16v2H4zm8 2h8v4h-8z"/>'
    },
    "tab-sharp": {
      body: '<path fill="currentColor" d="M2 6h2v12H2zm0 12h20v2H2zM20 6h2v12h-2zM2 4h20v2H2zm10 2h8v4h-8z"/>'
    },
    table: {
      body: '<path fill="currentColor" d="M2 3h20v18H2zm2 4v5h7V7zm9 0v5h7V7zm7 7h-7v5h7zm-9 5v-5H4v5z"/>',
      hidden: true
    },
    tablet: {
      body: '<path fill="currentColor" d="M5 2h14v2H5zm0 18h14v2H5zM3 4h2v16H3zm16 0h2v16h-2zm-8 12h2v2h-2z"/>'
    },
    "tablet-sharp": {
      body: '<path fill="currentColor" d="M3 2h18v2H3zm0 18h18v2H3zM3 4h2v16H3zm16 0h2v16h-2zm-8 12h2v2h-2z"/>'
    },
    tangent: {
      body: '<g fill="currentColor"><path d="M6 16h2v2H6zm-2 0h2v2H4zm-2 0h2v6H2zm2 4h2v2H4zm2-2h2v4H6zM16 2h2v6h-2zm2 0h2v2h-2zm2 0h2v6h-2zm-2 4h2v2h-2zM8 14h2v2H8zm2-2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2z"/><path d="M16 6h2v2h-2zm-2 6h4v2h-4zm4 2h4v2h-4zm-6-2h2v6h-2zm2 6h2v4h-2z"/></g>'
    },
    target: {
      body: '<path fill="currentColor" d="M5 1h14v2H5zM3 3h2v2H3zm0 16h2v2H3zm16 0h2v2h-2zm0-16h2v2h-2zm2 2h2v14h-2zM5 21h14v2H5zM1 5h2v14H1zm8 0h6v2H9zM5 9h2v6H5zm4 8h6v2H9zm8-8h2v6h-2zm-6 0h2v2h-2zM7 7h2v2H7zm0 8h2v2H7zm8 0h2v2h-2zm0-8h2v2h-2zm-6 4h2v2H9zm2 2h2v2h-2zm2-2h2v2h-2z"/>'
    },
    tea: {
      body: '<path fill="currentColor" d="M4 6h16v2H4zm0 2h2v10H4zm2 10h10v2H6zM20 8h2v4h-2zm-2 4h2v2h-2zm-2-4h2v10h-2zM7 2h2v2H7zm6 0h2v2h-2zM9 0h2v2H9zm6 0h2v2h-2zm-5 8h2v4h-2zm-2 4h6v4H8z"/>'
    },
    "tea-sharp": {
      body: '<path fill="currentColor" d="M4 6h16v2H4zm0 2h2v10H4zm0 10h14v2H4zM20 6h2v8h-2zm-2 6h2v2h-2zm-2-4h2v10h-2zM7 2h2v2H7zm6 0h2v2h-2zM9 0h2v2H9zm6 0h2v2h-2zm-5 8h2v4h-2zm-2 4h6v4H8z"/>'
    },
    teach: {
      body: '<g fill="currentColor"><path d="M3 2h4v4H3zM2 8h12v2H2zm7-4h11v2H9zm1 10h10v2H10z"/><path d="M2 9h6v7H2zm0 7h2v4H2zm4 0h2v4H6zM20 6h2v8h-2z"/></g>'
    },
    "teach-sharp": {
      body: '<g fill="currentColor"><path d="M3 2h4v4H3zM2 8h12v2H2zm7-4h11v2H9zm1 10h10v2H10z"/><path d="M2 9h6v7H2zm0 7h2v4H2zm4 0h2v4H6zM20 4h2v12h-2z"/></g>'
    },
    tent: {
      body: '<g fill="currentColor"><path d="M1 19h22v2H1z"/><path d="M3 17h2v3H3zm2-3h2v3H5zm2-3h2v3H7zm2-3h2v3H9zm2-3h2v3h-2zM9 3h2v2H9zm4 5h2v3h-2zm2 3h2v3h-2zm2 3h2v3h-2zm2 3h2v3h-2zM9 17h2v2H9zm4 0h2v2h-2zm-2-2h2v2h-2zm2-12h2v2h-2z"/></g>'
    },
    terminal: {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zM6 16h2v2H6zm2-2h2v2H8zm-2-2h2v2H6z"/>'
    },
    "terminal-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2zM6 16h2v2H6zm2-2h2v2H8zm-2-2h2v2H6z"/>'
    },
    "test-tube": {
      body: '<g fill="currentColor"><path d="M7 2h10v2H7zm1 2h2v16H8zm2 16h4v2h-4zm4-16h2v16h-2z"/><path d="M8 13h8v2H8z"/></g>'
    },
    "test-tube-sharp": {
      body: '<g fill="currentColor"><path d="M7 2h10v2H7zm1 2h2v16H8zm0 16h8v2H8zm6-16h2v16h-2z"/><path d="M8 13h8v2H8z"/></g>'
    },
    "text-add": {
      body: '<path fill="currentColor" d="M19 4H3v2h16zm0 4H3v2h16zM3 12h8v2H3zm8 4H3v2h8zm7-1h3v2h-3v3h-2v-3h-3v-2h3v-3h2z"/>',
      hidden: true
    },
    "text-align-center": {
      body: '<path fill="currentColor" d="M2 5h20v2H2zm4 6h12v2H6zm-2 6h16v2H4z"/>'
    },
    "text-align-center-box": {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zM6 7h12v2H6zm3 4h6v2H9zm-2 4h10v2H7z"/>'
    },
    "text-align-center-box-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2zM6 7h12v2H6zm3 4h6v2H9zm-2 4h10v2H7z"/>'
    },
    "text-align-justify": {
      body: '<path fill="currentColor" d="M2 5h20v2H2zm0 6h20v2H2zm0 6h20v2H2z"/>'
    },
    "text-align-justify-box": {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zM6 7h12v2H6zm0 4h12v2H6zm0 4h12v2H6z"/>'
    },
    "text-align-justify-box-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2zM6 7h12v2H6zm0 4h12v2H6zm0 4h12v2H6z"/>'
    },
    "text-align-left": {
      body: '<path fill="currentColor" d="M2 5h20v2H2zm0 6h12v2H2zm0 6h16v2H2z"/>'
    },
    "text-align-left-box": {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zM6 7h12v2H6zm0 4h6v2H6zm0 4h10v2H6z"/>'
    },
    "text-align-left-box-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2zM6 7h12v2H6zm0 4h6v2H6zm0 4h10v2H6z"/>'
    },
    "text-align-right": {
      body: '<path fill="currentColor" d="M2 5h20v2H2zm8 6h12v2H10zm-4 6h16v2H6z"/>'
    },
    "text-align-right-box": {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zM6 7h12v2H6zm6 4h6v2h-6zm-4 4h10v2H8z"/>'
    },
    "text-align-right-box-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2zM6 7h12v2H6zm6 4h6v2h-6zm-4 4h10v2H8z"/>'
    },
    "text-colums": {
      body: '<path fill="currentColor" d="M11 19H3v-2h8zm10 0h-8v-2h8zm-10-4H3v-2h8zm10 0h-8v-2h8zm-10-4H3V9h8zm10 0h-8V9h8zM11 7H3V5h8zm10 0h-8V5h8z"/>'
    },
    "text-cursor": {
      body: '<path fill="currentColor" d="M5 2h4v2H5zm0 20h4v-2H5zM9 4h2v2H9zm0 16h2v-2H9zm4-16h2v2h-2zm0 16h2v-2h-2zm2-18h4v2h-4zm0 20h4v-2h-4zM11 6h2v12h-2z"/>'
    },
    "text-cursor-input": {
      body: '<path fill="currentColor" d="M5 3h4v2H5zm4 2h2v14H9zm2-2h4v2h-4zM4 7h3v2H4zM2 9h2v6H2zm2 6h3v2H4zm9 0h7v2h-7zm7-6h2v6h-2zm-7-2h7v2h-7zM6 19h3v2H6zm5 0h3v2h-3z"/>'
    },
    "text-cursor-input-sharp": {
      body: '<path fill="currentColor" d="M5 3h4v2H5zm4 2h2v14H9zm2-2h4v2h-4zM4 7h3v2H4zM2 7h2v10H2zm2 8h3v2H4zm9 0h7v2h-7zm7-8h2v10h-2zm-7 0h7v2h-7zM6 19h3v2H6zm5 0h3v2h-3z"/>'
    },
    "text-search": {
      body: '<path fill="currentColor" d="M20 4H4v2h16zm0 4H4v2h16zm-8 4H4v2h8zm8 0h-6v6h6v2h2v-2h-2zm-4 4v-2h2v2zm-4 0H4v2h8z"/>',
      hidden: true
    },
    "text-start-a": {
      body: '<path fill="currentColor" d="M12 6h10v2H12zm0 4h10v2H12zM2 14h20v2H2zm0 4h20v2H2zM2 6h2v6H2zm6 0h2v6H8zM4 4h4v2H4zm0 4h4v2H4z"/>'
    },
    "text-start-a-sharp": {
      body: '<path fill="currentColor" d="M12 6h10v2H12zm0 4h10v2H12zM2 14h20v2H2zm0 4h20v2H2zM2 6h2v6H2zm6 0h2v6H8zM2 4h8v2H2zm2 4h4v2H4z"/>'
    },
    "text-start-t": {
      body: '<g fill="currentColor"><path d="M12 6h10v2H12zm0 4h10v2H12zM2 14h20v2H2zm0 4h20v2H2zM2 4h8v2H2zm3 2h2v6H5z"/><path d="M3 10h6v2H3zM2 6h2v2H2zm6 0h2v2H8z"/></g>'
    },
    "text-wrap": {
      body: '<g fill="currentColor"><path d="M3 5h16v2H3zm0 8h4v2H3zm0 4h6v2H3zm0-8h6v2H3zm16-2h2v6h-2zM9 13h10v2H9z"/><path d="M11 11h2v6h-2zm2-2h2v8h-2zm0 8h2v2h-2z"/></g>'
    },
    "text-wrap-sharp": {
      body: '<g fill="currentColor"><path d="M3 5h16v2H3zm0 8h4v2H3zm0 4h6v2H3zm0-8h6v2H3zm16-4h2v10h-2zM9 13h10v2H9z"/><path d="M11 11h2v6h-2zm2-2h2v8h-2zm0 8h2v2h-2z"/></g>'
    },
    thermometer: {
      body: '<g fill="currentColor"><path d="M9 2h6v2H9zm0 18h6v2H9zm2-4h2v2h-2zM7 4h2v16H7zm8 0h2v16h-2z"/><path d="M5 16h4v2H5zM5 6h4v2H5zm0 5h4v2H5z"/></g>'
    },
    "thermometer-sharp": {
      body: '<g fill="currentColor"><path d="M7 2h10v2H7zm0 18h10v2H7zm4-4h2v2h-2zM7 4h2v16H7zm8 0h2v16h-2z"/><path d="M5 16h4v2H5zM5 6h4v2H5zm0 5h4v2H5z"/></g>'
    },
    "thumbs-down": {
      body: '<path fill="currentColor" d="M2 12h2V4H2zm2-8h14V2H4zm14 4h2V4h-2zm2 4h2V8h-2zm-6 2h6v-2h-6zm0 2h2v-2h-2zm2 4h2v-4h-2zm-2 2h2v-2h-2zm-2-2h2v-2h-2zm-2-2h2v-2h-2zm-2-2h2v-2H8zm-4-2h4v-2H4zm2-2h2V4H6z"/>'
    },
    "thumbs-down-sharp": {
      body: '<path fill="currentColor" d="M2 14h2V2H2zM4 4h14V2H4zm14 4h2V4h-2zm2 4h2V8h-2zm-6 2h6v-2h-6zm0 2h2v-2h-2zm2 4h2v-4h-2zm-2 2h2v-2h-2zm-2-2h2v-2h-2zm-2-2h2v-2h-2zm-2-2h2v-2H8zm-4-2h4v-2H4zm2-2h2V4H6z"/>'
    },
    "thumbs-up": {
      body: '<path fill="currentColor" d="M2 12h2v8H2zm2 8h14v2H4zm14-4h2v4h-2zm2-4h2v4h-2zm-6-2h6v2h-6zm0-2h2v2h-2zm2-4h2v4h-2zm-2-2h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2h-2zM8 8h2v2H8zm-4 2h4v2H4zm2 2h2v8H6z"/>'
    },
    "thumbs-up-sharp": {
      body: '<path fill="currentColor" d="M2 10h2v12H2zm2 10h14v2H4zm14-4h2v4h-2zm2-4h2v4h-2zm-6-2h6v2h-6zm0-2h2v2h-2zm2-4h2v4h-2zm-2-2h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2h-2zM8 8h2v2H8zm-4 2h4v2H4zm2 2h2v8H6z"/>'
    },
    timeline: {
      body: '<path fill="currentColor" d="M7 7h4v4H7zm-2 6v-2h2v2zm0 0v4H1v-4zm8 0h-2v-2h2zm4 0h-4v4h4zm2-2v2h-2v-2zm0 0h4V7h-4z"/>',
      hidden: true
    },
    "toggle-left": {
      body: '<path fill="currentColor" d="M4 5h16v2H4zm0 12H2V7h2zm16 0v2H4v-2zm0 0h2V7h-2zM10 9H6v6h4z"/>',
      hidden: true
    },
    "toggle-right": {
      body: '<path fill="currentColor" d="M4 5h16v2H4zm0 12H2V7h2zm16 0v2H4v-2zm0 0h2V7h-2zm-2-8h-4v6h4z"/>',
      hidden: true
    },
    "toke-circle": {
      body: '<path fill="currentColor" d="M6 2h12v2H6zm0 18h12v2H6zM4 4h2v2H4zm16 0h-2v2h2zM2 6h2v12H2zm20 0h-2v12h2zM4 18h2v2H4zm16 0h-2v2h2zM11 7h2v2h-2zm0 8h2v2h-2zm-4-4h2v2H7zm8 0h2v2h-2zM9 9h2v2H9zm4 0h2v2h-2zm0 4h2v2h-2zm-4 0h2v2H9z"/>'
    },
    "toke-square": {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zm-9 3h2v2h-2zm0 8h2v2h-2zm-4-4h2v2H7zm8 0h2v2h-2zM9 9h2v2H9zm4 0h2v2h-2zm0 4h2v2h-2zm-4 0h2v2H9z"/>'
    },
    "toke-square-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2zm-9 3h2v2h-2zm0 8h2v2h-2zm-4-4h2v2H7zm8 0h2v2h-2zM9 9h2v2H9zm4 0h2v2h-2zm0 4h2v2h-2zm-4 0h2v2H9z"/>'
    },
    "tool-case": {
      body: '<path fill="currentColor" d="M2 11h20v2H2zm0 2h2v8H2zm2 8h16v2H4zm16-8h2v8h-2zM9 15h6v2H9zM4 8h2v3H4zm2-2h6v2H6zm6 2h2v3h-2zM8 4h2v2H8zm10 0h2v7h-2zm-8-2h8v2h-8z"/>'
    },
    "tool-case-sharp": {
      body: '<g fill="currentColor"><path d="M2 11h20v2H2zm0 2h2v8H2zm0 8h20v2H2zm18-8h2v8h-2zM9 15h6v2H9zM4 8h2v3H4zm0-2h10v2H4zm8 2h2v3h-2zM8 2h2v4H8zm10 1h2v8h-2z"/><path d="M8 2h12v2H8z"/></g>'
    },
    tournament: {
      body: '<path fill="currentColor" d="M2 1h5v2H2zm0 12h5v2H2zm0-4h5v2H2zm0 12h5v2H2zM7 3h2v6H7zm7 4h2v10h-2zm-7 8h2v6H7zm2 2h5v2H9zM9 5h5v2H9zm7 6h6v2h-6z"/>'
    },
    "tournament-sharp": {
      body: '<path fill="currentColor" d="M2 1h5v2H2zm0 12h5v2H2zm0-4h5v2H2zm0 12h5v2H2zM7 1h2v10H7zm7 4h2v14h-2zm-7 8h2v10H7zm2 4h5v2H9zM9 5h5v2H9zm7 6h6v2h-6z"/>'
    },
    "track-changes": {
      body: '<path fill="currentColor" d="M11 2H2v20h20V4h-2v16H4V4h7v2H6v12h12V8h-2v8H8V8h3v2h-1v4h4v-4h-1V2z"/>',
      hidden: true
    },
    trash: {
      body: '<path fill="currentColor" d="M18 22H6v-2h12zM9 6h6V4h2v2h5v2h-2v12h-2V8H6v12H4V8H2V6h5V4h2zm6-2H9V2h6z"/>'
    },
    "trash-alt": {
      body: '<path fill="currentColor" d="M16 2v4h6v2h-2v14H4V8H2V6h6V2zm-2 2h-4v2h4zm0 4H6v12h12V8z"/>',
      hidden: true
    },
    "trash-sharp": {
      body: '<path fill="currentColor" d="M18 20V8H6v12zM9 6h6V4H9zm11 16H4V8H2V6h5V2h10v4h5v2h-2z"/>'
    },
    tree: {
      body: '<g fill="currentColor"><path d="M6 4h2v2H6zm2-2h8v2H8zm10 4h2v4h-2zm2 4h2v6h-2zm-2 6h2v2h-2zM4 16h2v2H4zm-2-6h2v6H2zm4 8h12v2H6zM4 6h2v4H4z"/><path d="M11 18h2v4h-2zm5-14h2v2h-2z"/></g>'
    },
    "tree-pine": {
      body: '<path fill="currentColor" d="M11 2h2v2h-2zM9 4h2v2H9zm4 0h2v2h-2zm2 2h2v2h-2zM7 6h2v2H7zm0 4h2v2H7zm-2 2h2v2H5zm2 2h2v2H7zm-2 2h2v2H5zm-2 2h18v2H3zM13 8h2v2h-2zm2 2h2v2h-2zM9 8h2v2H9zm8 4h2v2h-2zm-2 2h2v2h-2zm2 2h2v2h-2zm-6 4h2v2h-2z"/>'
    },
    trending: {
      body: '<path fill="currentColor" d="M3 4h2v14h16v2H3zm6 10H7v2h2zm2-2v2H9v-2zm2 0v-2h-2v2zm2 0h-2v2h2zm2-2h-2v2h2zm2-2v2h-2V8zm0 0V6h2v2z"/>',
      hidden: true
    },
    "trending-down": {
      body: '<path fill="currentColor" d="M2 8h2v2h2v2h2v2h2v-2h2v-2h2v2h2v2h2v2h-4v2h8v-8h-2v4h-2v-2h-2v-2h-2V8h-2v2h-2v2H8v-2H6V8H4V6H2z"/>',
      hidden: true
    },
    "trending-up": {
      body: '<path fill="currentColor" d="M14 6h8v8h-2v-4h-2V8h-4zm2 6v-2h2v2zm-2 2v-2h2v2zm-2 0h2v2h-2zm-2-2h2v2h-2zm-2 0v-2h2v2zm-2 2v-2h2v2zm-2 2v-2h2v2zm0 0v2H2v-2z"/>',
      hidden: true
    },
    trophy: {
      body: '<path fill="currentColor" d="M16 17h-3v2h2v2H9v-2h2v-2H8v-2h8zm2-12h4v6h-2V7h-2v4h2v2h-2v2h-2V5H8v10H6v-2H4v-2h2V7H4v4H2V5h4V3h12z"/>'
    },
    "trophy-sharp": {
      body: '<path fill="currentColor" d="M18 5h4v8h-4v4h-5v2h2v2H9v-2h2v-2H6v-4H2V5h4V3h12zM8 15h8V5H8zm-4-4h2V7H4zm14 0h2V7h-2z"/>'
    },
    truck: {
      body: '<g fill="currentColor"><path d="M2 4h12v2H2zM0 16h4v2H0zm10 0h4v2h-4zm12-4h2v6h-2zm-8-6h2v12h-2zM0 6h2v10H0zm20 4h2v2h-2z"/><path d="M14 8h6v2h-6zM4 14h6v2H4zm10 0h6v2h-6zM4 16h2v2H4zm10 0h2v2h-2zM4 18h6v2H4zm10 0h6v2h-6zm-6-2h2v2H8zm10 0h4v2h-4z"/></g>'
    },
    "truck-sharp": {
      body: '<g fill="currentColor"><path d="M0 4h14v2H0zm0 12h4v2H0zm10 0h4v2h-4zm12-4h2v6h-2zm-8-8h2v14h-2zM0 6h2v10H0zm20 4h2v2h-2z"/><path d="M14 8h6v2h-6zM4 14h6v2H4zm10 0h6v2h-6zM4 16h2v2H4zm10 0h2v2h-2zM4 18h6v2H4zm10 0h6v2h-6zm-6-2h2v2H8zm10 0h4v2h-4z"/></g>'
    },
    tv: {
      body: '<path fill="currentColor" d="M4 3h16v2H4zM2 5h2v10H2zm2 10h16v2H4zM20 5h2v10h-2zM6 19h12v2H6zm3-2h2v2H9zm4 0h2v2h-2z"/>'
    },
    "tv-sharp": {
      body: '<path fill="currentColor" d="M2 3h20v2H2zm0 2h2v10H2zm0 10h20v2H2zM20 5h2v10h-2zM6 19h12v2H6zm3-2h2v2H9zm4 0h2v2h-2z"/>'
    },
    undo: {
      body: '<path fill="currentColor" d="M18 20h-6v-2h6zm2-2h-2v-8h2zm-10-4H8v-2H6v-2H4V8h2V6h2V4h2v4h8v2h-8z"/>'
    },
    "undo-sharp": {
      body: '<path fill="currentColor" d="M10 14H8v-2H6v-2H4V8h2V6h2V4h2v4h10v12h-8v-2h6v-8h-8z"/>'
    },
    ungroup: {
      body: '<path fill="currentColor" d="M7 3H3v4h4zm0 14H3v4h4zM17 3h4v4h-4zm4 14h-4v4h4zM8 8h2v2H8zm4 2h-2v4H8v2h2v-2h4v2h2v-2h-2v-4h2V8h-2v2z"/>',
      hidden: true
    },
    university: {
      body: '<path fill="currentColor" d="M1 10h2v10H1zm2 10h18v2H3zm18-10h2v10h-2zM3 8h4v2H3zm14 0h4v2h-4zM7 6h2v2H7zm2-2h2v2H9zm2-2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm-4 2h2v2h-2zm-2 2h2v2H9zm2 2h2v2h-2zm2-2h2v2h-2zm-8 3h2v2H5zm0 4h2v2H5zm12 0h2v2h-2zm0-4h2v2h-2zm-8 5h2v2H9zm0-2h6v2H9zm4 2h2v2h-2z"/>'
    },
    "university-sharp": {
      body: '<path fill="currentColor" d="M1 10h2v10H1zm0 10h22v2H1zm20-10h2v10h-2zM1 8h6v2H1zm16 0h6v2h-6zM7 6h2v2H7zm2-2h2v2H9zm2-2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm-4 2h2v2h-2zm-2 2h2v2H9zm2 2h2v2h-2zm2-2h2v2h-2zm-8 3h2v2H5zm0 4h2v2H5zm12 0h2v2h-2zm0-4h2v2h-2zm-8 5h2v2H9zm0-2h6v2H9zm4 2h2v2h-2z"/>'
    },
    unlink: {
      body: '<path fill="currentColor" d="M4 6h5v2H4zm11 0h5v2h-5zm0 10h5v2h-5zM4 16h5v2H4zm16-8h2v8h-2zM2 8h2v8H2zm9-4h2v16h-2z"/>'
    },
    "unlink-sharp": {
      body: '<path fill="currentColor" d="M4 6h5v2H4zm11 0h5v2h-5zm0 10h5v2h-5zM4 16h5v2H4zM20 6h2v12h-2zM2 6h2v12H2zm9-2h2v16h-2z"/>'
    },
    unlock: {
      body: '<path fill="currentColor" d="M5 8h14v2H5zm0 12h14v2H5zM3 10h2v10H3zm16 0h2v10h-2zM7 4h2v4H7zm2-2h6v2H9zm6 2h2v2h-2z"/>'
    },
    "unlock-sharp": {
      body: '<path fill="currentColor" d="M3 8h18v2H3zm0 12h18v2H3zm0-10h2v10H3zm16 0h2v10h-2zM7 4h2v4H7zm0-2h10v2H7zm8 2h2v2h-2z"/>'
    },
    upload: {
      body: '<path fill="currentColor" d="M19 21H5v-2h14zM5 19H3v-4h2zm16 0h-2v-4h2zM13 5h2v2h2v2h-4v8h-2V9H7V7h2V5h2V3h2z"/>'
    },
    "upload-sharp": {
      body: '<path fill="currentColor" d="M5 19h14v-4h2v6H3v-6h2zm8-14h2v2h2v2h-4v8h-2V9H7V7h2V5h2V3h2z"/>'
    },
    user: {
      body: '<path fill="currentColor" d="M9 2h6v2H9zm0 8h6v2H9zm6-6h2v6h-2zM7 4h2v6H7zM4 18h2v4H4zm14 0h2v4h-2zM8 14h8v2H8zm-2 2h2v2H6zm10 0h2v2h-2z"/>'
    },
    "user-minus": {
      body: '<path fill="currentColor" d="M9 2h6v2H9zm0 8h6v2H9zm6-6h2v6h-2zM7 4h2v6H7zM4 18h2v4H4zm4-4h8v2H8zm-2 2h2v2H6zm10 2h6v2h-6z"/>'
    },
    "user-minus-sharp": {
      body: '<path fill="currentColor" d="M16 18h6v2h-6zM7 2h10v2H7zm0 8h10v2H7zm8-6h2v6h-2zM7 4h2v6H7zM4 14h2v8H4zm2 0h8v2H6z"/>'
    },
    "user-plus": {
      body: '<g fill="currentColor"><path d="M9 2h6v2H9zm0 8h6v2H9zm6-6h2v6h-2zM7 4h2v6H7zM4 18h2v4H4zm14 0h2v4h-2zM8 14h8v2H8zm-2 2h2v2H6z"/><path d="M18 16h2v6h-2z"/><path d="M16 18h6v2h-6z"/></g>'
    },
    "user-plus-sharp": {
      body: '<g fill="currentColor"><path d="M18 18h2v4h-2z"/><path d="M18 16h2v6h-2z"/><path d="M16 18h6v2h-6zM7 2h10v2H7zm0 8h10v2H7zm8-6h2v6h-2zM7 4h2v6H7zM4 14h2v8H4zm2 0h8v2H6z"/></g>'
    },
    "user-sharp": {
      body: '<path fill="currentColor" d="M7 2h10v2H7zm0 8h10v2H7zm8-6h2v6h-2zM7 4h2v6H7zM4 14h2v8H4zm14 0h2v8h-2zM6 14h12v2H6z"/>'
    },
    "user-x": {
      body: '<path fill="currentColor" d="M9 2h6v2H9zm0 8h6v2H9zm6-6h2v6h-2zM7 4h2v6H7zM4 18h2v4H4zm16 2h2v2h-2zM8 14h6v2H8zm-2 2h2v2H6zm10 0h2v2h-2zm2 2h2v2h-2zm2-2h2v2h-2zm-4 4h2v2h-2z"/>'
    },
    "user-x-sharp": {
      body: '<path fill="currentColor" d="M20 20h2v2h-2zm-4-4h2v2h-2zm2 2h2v2h-2zm2-2h2v2h-2zm-4 4h2v2h-2zM7 2h10v2H7zm0 8h10v2H7zm8-6h2v6h-2zM7 4h2v6H7zM4 14h2v8H4zm2 0h8v2H6z"/>'
    },
    users: {
      body: '<path fill="currentColor" d="M5 2h6v2H5zm10 0h4v2h-4zM5 10h6v2H5zm10 0h4v2h-4zm4-6h2v6h-2zm-8 0h2v6h-2zM3 4h2v6H3zM0 18h2v4H0zm14 0h2v4h-2zm8 0h2v4h-2zM4 14h8v2H4zm12 0h4v2h-4zM2 16h2v2H2zm10 0h2v2h-2zm8 0h2v2h-2z"/>'
    },
    "users-sharp": {
      body: '<path fill="currentColor" d="M3 2h10v2H3zm12 0h6v2h-6zM3 10h10v2H3zm12 0h6v2h-6zm-4-6h2v6h-2zm8 0h2v6h-2zM3 4h2v6H3zM0 14h2v8H0zm14 0h2v8h-2zm8 0h2v8h-2zM2 14h12v2H2zm16 0h4v2h-4z"/>'
    },
    "utility-pole": {
      body: '<g fill="currentColor"><path d="M11 2h2v20h-2z"/><path d="M1 5h22v2H1zm8 6h2v2H9zm4 0h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm2-4h2v2h-2zm-4 0h2v2h-2zM7 3h2v2H7zM3 3h2v2H3zm4 6h2v2H7zM5 7h2v2H5z"/></g>'
    },
    vibrate: {
      body: '<path fill="currentColor" d="M8 3h8v2H8zm0 16h8v2H8zM6 5h2v14H6zm10 0h2v14h-2zm-5 11h2v2h-2zm13-9h-2v2h2zM0 7h2v2H0zm22 2h-2v2h2zM2 9h2v2H2zm22 2h-2v2h2zM0 11h2v2H0zm22 2h-2v2h2zM2 13h2v2H2zm22 2h-2v2h2zM0 15h2v2H0z"/>'
    },
    "vibrate-sharp": {
      body: '<path fill="currentColor" d="M6 3h12v2H6zm0 16h12v2H6zM6 5h2v14H6zm10 0h2v14h-2zm-5 11h2v2h-2zm13-9h-2v2h2zM0 7h2v2H0zm22 2h-2v2h2zM2 9h2v2H2zm22 2h-2v2h2zM0 11h2v2H0zm22 2h-2v2h2zM2 13h2v2H2zm22 2h-2v2h2zM0 15h2v2H0z"/>'
    },
    video: {
      body: '<path fill="currentColor" d="M20 17V7h2v10zm-2-2V9h2v6zM2 7h2v10H2zm14 0h2v10h-2zM4 5h12v2H4zm0 12h12v2H4z"/>'
    },
    "video-off": {
      body: '<path fill="currentColor" d="M4 5H2v14h14v-4h2v2h2v2h2V5h-2v2h-2v2h-2V5zm10 12H4V7h10zm-4-6H8V9H6v2h2v2H6v2h2v-2h2v2h2v-2h-2zm0 0V9h2v2z"/>',
      hidden: true
    },
    "video-sharp": {
      body: '<path fill="currentColor" d="M20 17V7h2v10zm-2-2V9h2v6zM2 7h2v10H2zm14 0h2v10h-2zM2 5h16v2H2zm0 12h16v2H2z"/>'
    },
    "view-col": {
      body: '<path fill="currentColor" d="M2 5h20v14H2zm2 2v10h4V7zm6 0v10h4V7zm6 0v10h4V7z"/>',
      hidden: true
    },
    "view-list": {
      body: '<path fill="currentColor" d="M2 5h20v14H2zm2 2v2h16V7zm16 4H4v2h16zm0 4H4v2h16z"/>',
      hidden: true
    },
    "viewport-narrow": {
      body: '<path fill="currentColor" d="M10 2H8v4h2V4h4v2h2V2zM8 20v-2h2v2h4v-2h2v4H8zm9-9h5v2h-5v2h-2v-2h-2v-2h2V9h2zm0-2V7h2v2zm0 6h2v2h-2zM2 11h5V9h2v2h2v2H9v2H7v-2H2zm5 4v2H5v-2zm0-6V7H5v2z"/>',
      hidden: true
    },
    "viewport-wide": {
      body: '<path fill="currentColor" d="M4 2H2v4h2V4h16v2h2V2zM2 20v-2h2v2h16v-2h2v4H2zm16-9h-5v2h5v2h-2v2h2v-2h2v-2h2v-2h-2V9h-2V7h-2v2h2zm-7 0H6V9h2V7H6v2H4v2H2v2h2v2h2v2h2v-2H6v-2h5z"/>',
      hidden: true
    },
    visible: {
      body: '<path fill="currentColor" d="M0 0h2v2H0zm2 2h2v2H2zm18 0h2v2h-2zm2-2h2v2h-2zM2 20h2v2H2zm-2 2h2v2H0zm20-2h2v2h-2zm2 2h2v2h-2zM8 17h8v2H8zm8-2h4v2h-4zm-8 0H4v2h4zm8-8h4v2h-4zM8 7H4v2h4zm12 2h2v2h-2zM4 9H2v2h2zm18 2h2v2h-2zM2 11H0v2h2zm18 2h2v2h-2zM4 13H2v2h2zm4-8h8v2H8zm2 5h4v4h-4z"/>',
      hidden: true
    },
    volume: {
      body: '<path fill="currentColor" d="M17 22h-2v-2h-2v-2h2V6h-2V4h2V2h2zm-4-4h-2v-2h2zM11 8v2H9v4h2v2H7V8zm2 0h-2V6h2z"/>'
    },
    "volume-1": {
      body: '<path fill="currentColor" d="M15 22h-2v-2h-2v-2h2V6h-2V4h2V2h2zm-4-4H9v-2h2zM9 8v2H7v4h2v2H5V8zm10 6h-2v-4h2zm-8-6H9V6h2z"/>'
    },
    "volume-2": {
      body: '<path fill="currentColor" d="M13 22h-2v-2H9v-2h2V6H9V4h2V2h2zm-4-4H7v-2h2zm10 0h-4v-2h4zM7 10H5v4h2v2H3V8h4zm14 6h-2V8h2zm-4-2h-2v-4h2zM9 8H7V6h2zm10 0h-4V6h4z"/>'
    },
    "volume-3": {
      body: '<path fill="currentColor" d="M11 22H9v-2H7v-2h2V6H7V4h2V2h2zm8 0h-6v-2h6zm2-2h-2v-2h2zM7 18H5v-2h2zm10 0h-4v-2h4zm6 0h-2V6h2zM5 10H3v4h2v2H1V8h4zm14 6h-2V8h2zm-4-2h-2v-4h2zM7 8H5V6h2zm10 0h-4V6h4zm4-2h-2V4h2zm-2-2h-6V2h6z"/>'
    },
    "volume-minus": {
      body: '<path fill="currentColor" d="M12 2h-2v2H8v2H6v2H2v8h4v2h2v2h2v2h2zM8 18v-2H6v-2H4v-4h2V8h2V6h2v12zm14-7h-8v2h8z"/>',
      hidden: true
    },
    "volume-plus": {
      body: '<path fill="currentColor" d="M10 2h2v20h-2v-2H8v-2h2V6H8V4h2zM6 8V6h2v2zm0 8H2V8h4v2H4v4h2zm0 0v2h2v-2zm13-5h3v2h-3v3h-2v-3h-3v-2h3V8h2z"/>',
      hidden: true
    },
    "volume-vibrate": {
      body: '<path fill="currentColor" d="M14 2h-2v2h-2v2H8v2H4v8h4v2h2v2h2v2h2zm-4 16v-2H8v-2H6v-4h2V8h2V6h2v12zm8-15h-2v2h2v2h-2v2h2v2h-2v2h2v2h-2v2h2v2h-2v2h2v-2h2v-2h-2v-2h2v-2h-2v-2h2V9h-2V7h2V5h-2z"/>',
      hidden: true
    },
    "volume-x": {
      body: '<path fill="currentColor" d="M13 2h-2v2H9v2H7v2H3v8h4v2h2v2h2v2h2zM9 18v-2H7v-2H5v-4h2V8h2V6h2v12zm10-6.777h-2v-2h-2v2h2v2h-2v2h2v-2h2v2h2v-2h-2zm0 0h2v-2h-2z"/>',
      hidden: true
    },
    wall: {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zM4 8h16v2H4zm0 6h16v2H4zM6 4h2v4H6zm2 12h2v4H8zm6-12h2v4h-2zm2 12h2v4h-2zm-5-6h2v4h-2z"/>'
    },
    "wall-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm0 18h20v2H2zM2 4h2v16H2zm18 0h2v16h-2zM4 8h16v2H4zm0 6h16v2H4zM6 4h2v4H6zm2 12h2v4H8zm6-12h2v4h-2zm2 12h2v4h-2zm-5-6h2v4h-2z"/>'
    },
    wallet: {
      body: '<g fill="currentColor"><path d="M18 5h2v2h-2zM4 3h14v2H4zM2 5h2v14H2zm2 14h16v2H4zm12-4h6v2h-6zm0-4h6v2h-6zm-2 0h2v6h-2z"/><path d="M20 7h2v12h-2zM4 7h16v2H4z"/></g>'
    },
    "wallet-sharp": {
      body: '<g fill="currentColor"><path d="M18 5h2v2h-2zM2 3h18v2H2zm0 2h2v14H2zm0 14h20v2H2zm14-4h6v2h-6zm0-4h6v2h-6zm-2 0h2v6h-2z"/><path d="M20 7h2v12h-2zM4 7h16v2H4z"/></g>'
    },
    warehouse: {
      body: '<g fill="currentColor"><path d="M6 10h12v2H6z"/><path d="M6 10h2v10H6zm2 5h8v2H8zm-6 5h20v2H2zm14-10h2v10h-2z"/><path d="M2 6h2v16H2z"/><path d="M2 6h4v2H2zm4-2h4v2H6zm8 0h4v2h-4zm4 2h4v2h-4zm-8-4h4v2h-4z"/><path d="M20 6h2v16h-2z"/></g>'
    },
    "warning-box": {
      body: '<path fill="currentColor" d="M3 3h16v2H5v14h14v2H3zm18 0h-2v18h2zM11 15h2v2h-2zm2-8h-2v6h2z"/>',
      hidden: true
    },
    "warning-diamond": {
      body: '<path fill="currentColor" d="M2 10h2v2H2zm0 4h2v-2H2zm20-4h-2v2h2zm0 4h-2v-2h2zM4 8h2v2H4zm0 8h2v-2H4zm16-8h-2v2h2zm0 8h-2v-2h2zM6 6h2v2H6zm0 12h2v-2H6zM18 6h-2v2h2zm0 12h-2v-2h2zM8 4h2v2H8zm0 16h2v-2H8zm8-16h-2v2h2zm0 16h-2v-2h2zM10 2h2v2h-2zm0 20h2v-2h-2zm4-20h-2v2h2zm0 20h-2v-2h2zm-3-5h2v-2h-2zm0-4h2V7h-2z"/>'
    },
    waves: {
      body: '<path fill="currentColor" d="M2 18h4v-2H2zm0-6h4v-2H2zm0-6h4V4H2zm4 14h4v-2H6zm0-6h4v-2H6zm0-6h4V6H6zm4 10h4v-2h-4zm0-6h4v-2h-4zm0-6h4V4h-4zm4 14h4v-2h-4zm0-6h4v-2h-4zm0-6h4V6h-4zm4 10h4v-2h-4zm0-6h4v-2h-4zm0-6h4V4h-4z"/>'
    },
    "waves-arrow-down": {
      body: '<g fill="currentColor"><path d="M2 21h4v-2H2zm0-6h4v-2H2zm4 8h4v-2H6zm0-6h4v-2H6zm4 4h4v-2h-4zm4 2h4v-2h-4zm0-6h4v-2h-4zm-4-2h4v-2h-4zm8 6h4v-2h-4zm0-6h4v-2h-4zM11 1h2v10h-2z"/><path d="M9 7h6v2H9zM7 5h10v2H7z"/></g>'
    },
    "waves-arrow-up": {
      body: '<g fill="currentColor"><path d="M2 21h4v-2H2zm0-6h4v-2H2zm4 8h4v-2H6zm0-6h4v-2H6zm4 4h4v-2h-4zm4 2h4v-2h-4zm0-6h4v-2h-4zm-4-2h4v-2h-4zm8 6h4v-2h-4zm0-6h4v-2h-4zm-7-4h2V1h-2z"/><path d="M9 5h6V3H9zM7 7h10V5H7z"/></g>'
    },
    wifi: {
      body: '<path fill="currentColor" d="M11 19h2v2h-2zm-4-3h2v2H7zm8 0h2v2h-2zm-6-2h6v2H9zm-5-1h2v2H4zm2-2h2v2H6zm2-2h8v2H8zm-7 1h2v2H1zm20 0h2v2h-2zM3 8h2v2H3zm2-2h2v2H5zm2-2h10v2H7zm12 4h2v2h-2zm-2-2h2v2h-2zm1 7h2v2h-2zm-2-2h2v2h-2z"/>'
    },
    wind: {
      body: '<path fill="currentColor" d="M2 7h10v2H2zm10-4h2v4h-2zM7 1h5v2H7zM2 11h18v2H2zm18-4h2v4h-2zm-4-2h4v2h-4zM2 17h12v-2H2zm12 2h2v-2h-2zm-5 2h5v-2H9z"/>'
    },
    "window-frame": {
      body: '<path fill="currentColor" d="M4 2h16v2H4zm0 6h16v2H4zm0 12h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zM5 5h2v2H5zm3 0h2v2H8z"/>'
    },
    "window-frame-sharp": {
      body: '<path fill="currentColor" d="M2 2h20v2H2zm2 6h16v2H4zM2 20h20v2H2zM2 4h2v16H2zm18 0h2v16h-2zM5 5h2v2H5zm3 0h2v2H8z"/>'
    },
    zap: {
      body: '<path fill="currentColor" d="M4 13h8v6h2v2h-2v2h-2v-8H2v-4h2zm12 6h-2v-2h2zm2-2h-2v-2h2zm2-2h-2v-2h2zm-6-6h8v4h-2v-2h-8V5h-2V3h2V1h2zm-8 2H4V9h2zm2-2H6V7h2zm2-2H8V5h2z"/>'
    },
    "zap-off": {
      body: '<g fill="currentColor"><path d="M10 13h2v10h-2z"/><path d="M2 13h10v2H2zM12 1h2v6h-2zm4 8h6v2h-6zm4 2h2v2h-2zm-4 4h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2h-2zM2 11h2v2H2zm2-2h2v2H4zm2-2h2v2H6zm4-4h2v2h-2zM2 1h2v2H2zm2 2h2v2H4zm2 2h2v2H6zm2 2h2v2H8zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2z"/><path d="M16 15h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2z"/></g>'
    },
    "zoom-in": {
      body: '<path fill="currentColor" d="M22 22h-2v-2h2zm-2-2h-2v-2h2zm-6-2H6v-2h8zm4 0h-2v-2h2zM6 16H4v-2h2zm10 0h-2v-2h2zM4 14H2V6h2zm7-5h3v2h-3v3H9v-3H6V9h3V6h2zm7 5h-2V6h2zM6 6H4V4h2zm10 0h-2V4h2zm-2-2H6V2h8z"/>'
    },
    "zoom-out": {
      body: '<path fill="currentColor" d="M22 22h-2v-2h2zm-2-2h-2v-2h2zm-6-2H6v-2h8zm4 0h-2v-2h2zM6 16H4v-2h2zm10 0h-2v-2h2zM4 14H2V6h2zm14 0h-2V6h2zm-4-5v2H6V9zM6 6H4V4h2zm10 0h-2V4h2zm-2-2H6V2h8z"/>'
    }
  },
  aliases: {
    code: {
      parent: "brackets-angle"
    },
    dashbaord: {
      parent: "dashboard"
    },
    "sort-alpabetic": {
      parent: "sort-alphabetic"
    }
  },
  lastModified: 1779346529,
  width: 24,
  height: 24
};

// node_modules/@iconify-json/pixel/icons.json
var icons_default2 = {
  prefix: "pixel",
  icons: {
    ad: {
      body: '<path fill="currentColor" d="M22 5V4H2v1H1v14h1v1h20v-1h1V5zm-1 13H3V6h18z"/><path fill="currentColor" d="M18 7v3h-4v1h-1v5h1v1h5v-1h1V7zm-3 5h3v3h-3zm-5-2V9H9V8H8V7H7v1H6v1H5v1H4v7h2v-2h3v2h2v-7zm-1 3H6v-2h1v-1h1v1h1z"/>'
    },
    "ad-solid": {
      body: '<path fill="currentColor" d="M22 5V4H2v1H1v14h1v1h20v-1h1V5zM9 8v1h1v1h1v7H9v-2H6v2H4v-7h1V9h1V8h1V7h1v1zm4 8v-5h1v-1h4V7h2v9h-1v1h-5v-1z"/><path fill="currentColor" d="M9 11v2H6v-2h1v-1h1v1zm6 1h3v3h-3z"/>'
    },
    algolia: {
      body: '<path fill="currentColor" d="M23 1v22h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-2v1H9v-1H8v-1H7v-1H6V9h1V8h1V7h1V6h6v1h1v1h1v1h1v4h-1v-1h-1v-2h-1V9h-1V8h-4v1H9v1H8v4h1v1h1v1h4v-1h1v-1h2v1h1v1h1v1h1v1h1V3H9v1H7v1H6v1H5v1H4v2H3v6h1v2h1v1h1v1h1v1h2v1h6v-1h1v1h1v1h-1v1H8v-1H6v-1H5v-1H4v-1H3v-1H2v-2H1V8h1V6h1V5h1V4h1V3h1V2h2V1z"/>'
    },
    "align-center": {
      body: '<path fill="currentColor" d="M1 21h22v1H1zm4-6h14v1H5zM5 2h14v1H5zM1 8h22v1H1z"/>'
    },
    "align-center-solid": {
      body: '<path fill="currentColor" d="M6 3H5V2h1V1h12v1h1v1h-1v1H6zm12 11v1h1v1h-1v1H6v-1H5v-1h1v-1zm4 7h1v1h-1v1H2v-1H1v-1h1v-1h20zm1-13v1h-1v1H2V9H1V8h1V7h20v1z"/>'
    },
    "align-justify": {
      body: '<path fill="currentColor" d="M1 8h22v1H1zm0 13h22v1H1zm0-6h22v1H1zM1 2h22v1H1z"/>'
    },
    "align-justify-solid": {
      body: '<path fill="currentColor" d="M22 21h1v1h-1v1H2v-1H1v-1h1v-1h20zm1-6v1h-1v1H2v-1H1v-1h1v-1h20v1zm-1-7h1v1h-1v1H2V9H1V8h1V7h20zm1-6v1h-1v1H2V3H1V2h1V1h20v1z"/>'
    },
    "align-left": {
      body: '<path fill="currentColor" d="M1 2h15v1H1zm0 13h15v1H1zm0-7h22v1H1zm0 13h22v1H1z"/>'
    },
    "align-left-solid": {
      body: '<path fill="currentColor" d="M22 21h1v1h-1v1H2v-1H1v-1h1v-1h20zm1-13v1h-1v1H2V9H1V8h1V7h20v1zM2 3H1V2h1V1h13v1h1v1h-1v1H2zm0 13H1v-1h1v-1h13v1h1v1h-1v1H2z"/>'
    },
    "align-right": {
      body: '<path fill="currentColor" d="M8 2h15v1H8zM1 21h22v1H1zM1 8h22v1H1zm7 7h15v1H8z"/>'
    },
    "align-right-solid": {
      body: '<path fill="currentColor" d="M22 15h1v1h-1v1H9v-1H8v-1h1v-1h13zm1-13v1h-1v1H9V3H8V2h1V1h13v1zm-1 6h1v1h-1v1H2V9H1V8h1V7h20zm0 13h1v1h-1v1H2v-1H1v-1h1v-1h20z"/>'
    },
    analytics: {
      body: '<path fill="currentColor" d="M2 15h2v7H2zm6-5h2v12H8zm6 4h2v8h-2zm6-4h2v12h-2zm-2-5h1v1h-1zm-1 1h1v1h-1zm-3 1h2v1h-2zm0 3h2v1h-2zm-1-2h1v2h-1zm3 0h1v2h-1zm-4-2h1v1h-1zm-1-1h1v1h-1zM8 4h2v1H8zm0-3h2v1H8zm2 1h1v2h-1zM7 2h1v2H7zm13 2h2v1h-2zm-1-2h1v2h-1zm1-1h2v1h-2zm2 1h1v2h-1zM6 6h1v1H6zM5 7h1v1H5zM4 9h1v2H4zM1 9h1v2H1zm1-1h2v1H2zm0 3h2v1H2z"/>'
    },
    "analytics-solid": {
      body: '<path fill="currentColor" d="M10 11h1v10h-1v1H8v-1H7V11h1v-1h2zm1-6h1v1h-1zm1 1h1v1h-1zm4 2h1v2h-1v1h-2v-1h-1V8h1V7h2zm0 7h1v6h-1v1h-2v-1h-1v-6h1v-1h2zm1-9h1v1h-1zm1-1h1v1h-1zm5-3v2h-1v1h-2V4h-1V2h1V1h2v1zm-1 9h1v10h-1v1h-2v-1h-1V11h1v-1h2zM5 7h1v1H5zM4 9h1v2H4v1H2v-1H1V9h1V8h2zm0 7h1v5H4v1H2v-1H1v-5h1v-1h2zM6 6h1v1H6zm2-2H7V2h1V1h2v1h1v2h-1v1H8z"/>'
    },
    android: {
      body: '<path fill="currentColor" d="M5 10h1v2H5zm13 0h1v2h-1zm4 10v-2h-1v-1h-1v-1h-1v-1h-1v-3h-1v2h-2v-1H9v1H7v-2H6v3H5v1H4v1H3v1H2v2H1v3h22v-3zM8 18v2H6v-2zm8 0h2v2h-2z"/><path fill="none" d="M0 0h24v24H0z"/>'
    },
    angellist: {
      body: '<path fill="currentColor" d="M18 12h1v7h-1zm0-10h1v3h-1zm-1 17h1v1h-1zm0-8h1v1h-1zm0-6h1v3h-1zm-1 15h1v1h-1zm0-12h1v2h-1zm0-7h2v1h-2zm-2 9h3v1h-3zm1-8h1v2h-1zm-1 19h2v1h-2zm0-17h1v3h-1zm-1 15h1v1h-1zm1-12v3h-3V9h1V7zm2 6v1h-1v1h-1v1h-1v3h-1v-1h-1v1h-1v-2h2v-3h-1v-1zm-5-9h1v3h-1zm-1 18h4v1h-4zm0-10h1v1h-1zm0-10h1v2h-1zM9 16h1v1H9zm2-6v1h-1v1H9v-1H7v-1h2V8h1v2zM8 21h2v1H8zm0-2h2v1H8zm0-4h1v1H8zM8 5h1v3H8zm0-4h2v1H8zM7 20h1v1H7zm0-2h1v1H7zM7 2h1v3H7zM6 19h1v1H6zm0-2h1v1H6zm0-6h1v3H6zm-1 7h1v1H5zm0-4h3v1H5zm-1 1h1v3H4z"/>'
    },
    "angle-down": {
      body: '<path fill="currentColor" d="M20 8v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1h-1v-1H9v-1H8v-1H7v-1H6v-1H5V9H4V8h1V7h1v1h1v1h1v1h1v1h1v1h1v1h2v-1h1v-1h1v-1h1V9h1V8h1V7h1v1z"/>'
    },
    "angle-down-solid": {
      body: '<path fill="currentColor" d="M5 7h2v1h1v1h1v1h1v1h1v1h2v-1h1v-1h1V9h1V8h1V7h2v1h1v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1h-1v-1H9v-1H8v-1H7v-1H6v-1H5v-1H4V8h1z"/>'
    },
    "angle-left": {
      body: '<path fill="currentColor" d="M11 13h1v1h1v1h1v1h1v1h1v1h1v1h-1v1h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1H9v-1H8v-2h1v-1h1V9h1V8h1V7h1V6h1V5h1V4h1v1h1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1z"/>'
    },
    "angle-left-solid": {
      body: '<path fill="currentColor" d="M17 5v2h-1v1h-1v1h-1v1h-1v1h-1v2h1v1h1v1h1v1h1v1h1v2h-1v1h-2v-1h-1v-1h-1v-1h-1v-1h-1v-1H9v-1H8v-1H7v-2h1v-1h1V9h1V8h1V7h1V6h1V5h1V4h2v1z"/>'
    },
    "angle-right": {
      body: '<path fill="currentColor" d="M16 11v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H9v1H8v-1H7v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-2h-1v-1h-1V9h-1V8H9V7H8V6H7V5h1V4h1v1h1v1h1v1h1v1h1v1h1v1h1v1z"/>'
    },
    "angle-right-solid": {
      body: '<path fill="currentColor" d="M7 19v-2h1v-1h1v-1h1v-1h1v-1h1v-2h-1v-1h-1V9H9V8H8V7H7V5h1V4h2v1h1v1h1v1h1v1h1v1h1v1h1v1h1v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H8v-1z"/>'
    },
    "angle-up": {
      body: '<path fill="currentColor" d="M20 15v1h-1v1h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-2v1h-1v1H9v1H8v1H7v1H6v1H5v-1H4v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1V9h1V8h2v1h1v1h1v1h1v1h1v1h1v1h1v1z"/>'
    },
    "angle-up-solid": {
      body: '<path fill="currentColor" d="M19 17h-2v-1h-1v-1h-1v-1h-1v-1h-1v-1h-2v1h-1v1H9v1H8v1H7v1H5v-1H4v-2h1v-1h1v-1h1v-1h1v-1h1V9h1V8h1V7h2v1h1v1h1v1h1v1h1v1h1v1h1v1h1v2h-1z"/>'
    },
    anthropic: {
      body: '<path fill="currentColor" d="M16 17v-2h-1v-3h-1v-2h-1V8h-1V6h-1V4H7v2H6v2H5v2H4v2H3v3H2v2H1v2h3v-2h1v-2h8v2h1v2h3v-2Zm-5-5H7v-2h1V8h2v2h1Zm12 5v2h-3v-2h-1v-2h-1v-2h-1v-3h-1V8h-1V6h-1V4h3v2h1v2h1v2h1v3h1v2h1v2z"/>'
    },
    apple: {
      body: '<path fill="currentColor" d="M15 1v3h-1v1h-1v1h-2V3h1V2h1V1zm6 16v1h-1v2h-1v1h-1v1h-1v1h-2v-1h-5v1H8v-1H7v-1H6v-1H5v-1H4v-2H3v-7h1V8h1V7h2V6h3v1h4V6h3v1h2v1h1v1h-1v1h-1v5h1v1h1v1z"/>'
    },
    archive: {
      body: '<path fill="currentColor" d="M17 16v2h-1v1H8v-1H7v-2h1v-1h8v1z"/><path fill="currentColor" d="M22 12v-1h-1V6h-1V5h-1V4h-1V3h-1V2h-1V1H5v1H4v1H3v5H2v1H1v13h1v1h20v-1h1V12ZM8 10V9H7V8H5V4h1V3h8v5h5v3H9v-1Zm13 10h-1v1H4v-1H3v-9h1v-1h2v1h1v1h2v1h11v1h1Z"/>'
    },
    "archive-solid": {
      body: '<path fill="currentColor" d="M22 12v-1h-1V6h-1V5h-1V4h-1V3h-1V2h-1V1H5v1H4v1H3v5H2v1H1v13h1v1h20v-1h1V12ZM5 4h1V3h8v5h5v3H9v-1H8V9H7V8H5Zm12 14h-1v1H8v-1H7v-2h1v-1h8v1h1Z"/>'
    },
    "arrow-alt-circle-down": {
      body: '<path fill="currentColor" d="M15 22h2v-1h2v-1h1v-1h1v-2h1v-2h1V9h-1V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6zm-6-1v-1H7v-1H5v-2H4v-2H3V9h1V7h1V5h2V4h2V3h6v1h2v1h2v2h1v2h1v6h-1v2h-1v2h-2v1h-2v1z"/><path fill="currentColor" d="M13 17h-2v-1h-1v-1H9v-1H8v-1H7v-1h4V6h2v6h4v1h-1v1h-1v1h-1v1h-1z"/><path fill="none" d="M0 0h24v24H0z"/>'
    },
    "arrow-alt-circle-down-solid": {
      body: '<path fill="currentColor" d="M15 22h2v-1h2v-1h1v-1h1v-2h1v-2h1V9h-1V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6zm-5-6v-1H9v-1H8v-1H7v-1h4V6h2v6h4v1h-1v1h-1v1h-1v1h-1v1h-2v-1z"/>'
    },
    "arrow-alt-circle-left": {
      body: '<path fill="currentColor" d="M2 15v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9h-1V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6zm1-6h1V7h1V5h2V4h2V3h6v1h2v1h2v2h1v2h1v6h-1v2h-1v2h-2v1h-2v1H9v-1H7v-1H5v-2H4v-2H3z"/><path fill="currentColor" d="M7 13v-2h1v-1h1V9h1V8h1V7h1v4h6v2h-6v4h-1v-1h-1v-1H9v-1H8v-1z"/>'
    },
    "arrow-alt-circle-left-solid": {
      body: '<path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9zm-10 4v4h-1v-1h-1v-1H9v-1H8v-1H7v-2h1v-1h1V9h1V8h1V7h1v4h6v2z"/>'
    },
    "arrow-alt-circle-right": {
      body: '<path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9zm-1 6h-1v2h-1v2h-2v1h-2v1H9v-1H7v-1H5v-2H4v-2H3V9h1V7h1V5h2V4h2V3h6v1h2v1h2v2h1v2h1z"/><path fill="currentColor" d="M17 11v2h-1v1h-1v1h-1v1h-1v1h-1v-4H6v-2h6V7h1v1h1v1h1v1h1v1z"/>'
    },
    "arrow-alt-circle-right-solid": {
      body: '<path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9zm-6 5h-1v1h-1v1h-1v1h-1v-4H6v-2h6V7h1v1h1v1h1v1h1v1h1v2h-1z"/>'
    },
    "arrow-alt-circle-up": {
      body: '<path fill="currentColor" d="M9 2H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9h-1V7h-1V5h-1V4h-1V3h-2V2h-2V1H9zm6 1v1h2v1h2v2h1v2h1v6h-1v2h-1v2h-2v1h-2v1H9v-1H7v-1H5v-2H4v-2H3V9h1V7h1V5h2V4h2V3z"/><path fill="currentColor" d="M11 7h2v1h1v1h1v1h1v1h1v1h-4v6h-2v-6H7v-1h1v-1h1V9h1V8h1z"/><path fill="none" d="M0 0h24v24H0z"/>'
    },
    "arrow-alt-circle-up-solid": {
      body: '<path fill="currentColor" d="M9 2H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9h-1V7h-1V5h-1V4h-1V3h-2V2h-2V1H9zm5 6v1h1v1h1v1h1v1h-4v6h-2v-6H7v-1h1v-1h1V9h1V8h1V7h2v1z"/>'
    },
    "arrow-circle-down": {
      body: '<path fill="currentColor" d="M22 8V6h-1V5h-1V4h-1V3h-1V2h-2V1H8v1H6v1H5v1H4v1H3v1H2v2H1v8h1v2h1v1h1v1h1v1h1v1h2v1h8v-1h2v-1h1v-1h1v-1h1v-1h1v-2h1V8zm-1 8h-1v2h-1v1h-1v1h-2v1H8v-1H6v-1H5v-1H4v-2H3V8h1V6h1V5h1V4h2V3h8v1h2v1h1v1h1v2h1z"/><path fill="currentColor" d="M19 12v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1h-1v-1H9v-1H8v-1H7v-1H6v-1H5v-1h1v-1h1v1h1v1h1v1h1v1h1V5h2v10h1v-1h1v-1h1v-1h1v-1h1v1z"/>'
    },
    "arrow-circle-down-solid": {
      body: '<path fill="currentColor" d="M2 16v2h1v1h1v1h1v1h1v1h2v1h8v-1h2v-1h1v-1h1v-1h1v-1h1v-2h1V8h-1V6h-1V5h-1V4h-1V3h-1V2h-2V1H8v1H6v1H5v1H4v1H3v1H2v2H1v8zm9-1V5h2v10h1v-1h1v-1h1v-1h1v-1h1v1h1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1h-1v-1H9v-1H8v-1H7v-1H6v-1H5v-1h1v-1h1v1h1v1h1v1h1v1z"/>'
    },
    "arrow-circle-left": {
      body: '<path fill="currentColor" d="M8 2H6v1H5v1H4v1H3v1H2v2H1v8h1v2h1v1h1v1h1v1h1v1h2v1h8v-1h2v-1h1v-1h1v-1h1v-1h1v-2h1V8h-1V6h-1V5h-1V4h-1V3h-1V2h-2V1H8zm8 2h2v1h1v1h1v2h1v8h-1v2h-1v1h-1v1h-2v1H8v-1H6v-1H5v-1H4v-2H3V8h1V6h1V5h1V4h2V3h8z"/><path fill="currentColor" d="M11 5h1v1h1v1h-1v1h-1v1h-1v1H9v1h10v2H9v1h1v1h1v1h1v1h1v1h-1v1h-1v-1h-1v-1H9v-1H8v-1H7v-1H6v-1H5v-2h1v-1h1V9h1V8h1V7h1V6h1z"/>'
    },
    "arrow-circle-left-solid": {
      body: '<path fill="currentColor" d="M8 2H6v1H5v1H4v1H3v1H2v2H1v8h1v2h1v1h1v1h1v1h1v1h2v1h8v-1h2v-1h1v-1h1v-1h1v-1h1v-2h1V8h-1V6h-1V5h-1V4h-1V3h-1V2h-2V1H8zm1 9h10v2H9v1h1v1h1v1h1v1h1v1h-1v1h-1v-1h-1v-1H9v-1H8v-1H7v-1H6v-1H5v-2h1v-1h1V9h1V8h1V7h1V6h1V5h1v1h1v1h-1v1h-1v1h-1v1H9z"/>'
    },
    "arrow-circle-right": {
      body: '<path fill="currentColor" d="M16 22h2v-1h1v-1h1v-1h1v-1h1v-2h1V8h-1V6h-1V5h-1V4h-1V3h-1V2h-2V1H8v1H6v1H5v1H4v1H3v1H2v2H1v8h1v2h1v1h1v1h1v1h1v1h2v1h8zm-8-2H6v-1H5v-1H4v-2H3V8h1V6h1V5h1V4h2V3h8v1h2v1h1v1h1v2h1v8h-1v2h-1v1h-1v1h-2v1H8z"/><path fill="currentColor" d="M13 19h-1v-1h-1v-1h1v-1h1v-1h1v-1h1v-1H5v-2h10v-1h-1V9h-1V8h-1V7h-1V6h1V5h1v1h1v1h1v1h1v1h1v1h1v1h1v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1z"/>'
    },
    "arrow-circle-right-solid": {
      body: '<path fill="currentColor" d="M16 22h2v-1h1v-1h1v-1h1v-1h1v-2h1V8h-1V6h-1V5h-1V4h-1V3h-1V2h-2V1H8v1H6v1H5v1H4v1H3v1H2v2H1v8h1v2h1v1h1v1h1v1h1v1h2v1h8zm-1-9H5v-2h10v-1h-1V9h-1V8h-1V7h-1V6h1V5h1v1h1v1h1v1h1v1h1v1h1v1h1v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v-1h-1v-1h1v-1h1v-1h1v-1h1z"/>'
    },
    "arrow-circle-up": {
      body: '<path fill="currentColor" d="M22 8V6h-1V5h-1V4h-1V3h-1V2h-2V1H8v1H6v1H5v1H4v1H3v1H2v2H1v8h1v2h1v1h1v1h1v1h1v1h2v1h8v-1h2v-1h1v-1h1v-1h1v-1h1v-2h1V8zm-2 8v2h-1v1h-1v1h-2v1H8v-1H6v-1H5v-1H4v-2H3V8h1V6h1V5h1V4h2V3h8v1h2v1h1v1h1v2h1v8z"/><path fill="currentColor" d="M19 11v1h-1v1h-1v-1h-1v-1h-1v-1h-1V9h-1v10h-2V9h-1v1H9v1H8v1H7v1H6v-1H5v-1h1v-1h1V9h1V8h1V7h1V6h1V5h2v1h1v1h1v1h1v1h1v1h1v1z"/>'
    },
    "arrow-circle-up-solid": {
      body: '<path fill="currentColor" d="M22 8V6h-1V5h-1V4h-1V3h-1V2h-2V1H8v1H6v1H5v1H4v1H3v1H2v2H1v8h1v2h1v1h1v1h1v1h1v1h2v1h8v-1h2v-1h1v-1h1v-1h1v-1h1v-2h1V8zm-9 1v10h-2V9h-1v1H9v1H8v1H7v1H6v-1H5v-1h1v-1h1V9h1V8h1V7h1V6h1V5h2v1h1v1h1v1h1v1h1v1h1v1h1v1h-1v1h-1v-1h-1v-1h-1v-1h-1V9z"/>'
    },
    "arrow-down": {
      body: '<path fill="currentColor" d="M23 12v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1h-1v-1H9v-1H8v-1H7v-1H6v-1H5v-1H4v-1H3v-1H2v-1H1v-1h1v-1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1V1h2v18h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v1z"/>'
    },
    "arrow-down-solid": {
      body: '<path fill="currentColor" d="M13 23h-2v-1h-1v-1H9v-1H8v-1H7v-1H6v-1H5v-1H4v-1H3v-1H2v-1H1v-1h1v-1h1v-1h1v1h1v1h1v1h1v1h1v1h1v1h1V1h4v15h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v1h1v1h1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1z"/>'
    },
    "arrow-left": {
      body: '<path fill="currentColor" d="M23 11v2H5v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h-1v1h-1v-1h-1v-1H9v-1H8v-1H7v-1H6v-1H5v-1H4v-1H3v-1H2v-1H1v-2h1v-1h1V9h1V8h1V7h1V6h1V5h1V4h1V3h1V2h1V1h1v1h1v1h-1v1h-1v1h-1v1H9v1H8v1H7v1H6v1H5v1z"/>'
    },
    "arrow-left-solid": {
      body: '<path fill="currentColor" d="M1 13v-2h1v-1h1V9h1V8h1V7h1V6h1V5h1V4h1V3h1V2h1V1h1v1h1v1h1v1h-1v1h-1v1h-1v1h-1v1H9v1H8v1h15v4H8v1h1v1h1v1h1v1h1v1h1v1h1v1h-1v1h-1v1h-1v-1h-1v-1H9v-1H8v-1H7v-1H6v-1H5v-1H4v-1H3v-1H2v-1z"/>'
    },
    "arrow-right": {
      body: '<path fill="currentColor" d="M23 11v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v-1h-1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1H1v-2h18v-1h-1V9h-1V8h-1V7h-1V6h-1V5h-1V4h-1V3h-1V2h1V1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1z"/>'
    },
    "arrow-right-solid": {
      body: '<path fill="currentColor" d="M23 11v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v-1h-1v-1h-1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1H1v-4h15V9h-1V8h-1V7h-1V6h-1V5h-1V4h-1V3h1V2h1V1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1z"/>'
    },
    "arrow-up": {
      body: '<path fill="currentColor" d="M23 11v1h-1v1h-1v-1h-1v-1h-1v-1h-1V9h-1V8h-1V7h-1V6h-1V5h-1v18h-2V5h-1v1H9v1H8v1H7v1H6v1H5v1H4v1H3v1H2v-1H1v-1h1v-1h1V9h1V8h1V7h1V6h1V5h1V4h1V3h1V2h1V1h2v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1z"/>'
    },
    "arrow-up-solid": {
      body: '<path fill="currentColor" d="M11 1h2v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h-1v1h-1v1h-1v-1h-1v-1h-1v-1h-1v-1h-1V9h-1V8h-1v15h-4V8H9v1H8v1H7v1H6v1H5v1H4v1H3v-1H2v-1H1v-1h1v-1h1V9h1V8h1V7h1V6h1V5h1V4h1V3h1V2h1z"/>'
    },
    arweave: {
      body: '<path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9Zm-2 6v2h-1v2h-2v1h-2v1H9v-1H7v-1H5v-2H4v-2H3V9h1V7h1V5h2V4h2V3h6v1h2v1h2v2h1v2h1v6Z"/><path fill="currentColor" d="M15 9V8h-1V7h-4v1H9v2h2V9h2v1h1v1H9v1H8v3h1v1h4v-1h1v1h2V9Zm-4 5v-2h3v1h-1v1Z"/>'
    },
    at: {
      body: '<path fill="currentColor" d="M22 10V8h-1V6h-1V4h-1V3h-2V2h-3V1h-4v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h3v1h4v-1h3v-2h-3v1h-4v-1H7v-1H6v-1H5v-2H4v-2H3v-4h1V8h1V6h1V5h1V4h3V3h4v1h3v1h1v1h1v2h1v2h1v4h-1v1h-2v-5h-1V8h-1V7h-2V6h-4v1H8v1H7v2H6v4h1v2h1v1h2v1h4v-1h2v-1h1v1h4v-1h1v-2h1v-4zm-6 4h-1v1h-1v1h-4v-1H9v-1H8v-4h1V9h1V8h4v1h1v1h1z"/>'
    },
    "at-solid": {
      body: '<path fill="currentColor" d="M22 10V8h-1V6h-1V4h-1V3h-2V2h-3V1h-4v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h3v1h4v-1h3v-3h-3v1h-4v-1H7v-1H6v-2H5v-2H4v-4h1V8h1V6h1V5h3V4h4v1h3v1h1v2h1v2h1v4h-2v-4h-1V8h-1V7h-2V6h-4v1H8v1H7v2H6v4h1v2h1v1h2v1h4v-1h2v-1h1v1h4v-1h1v-2h1v-4zm-7 4h-1v1h-4v-1H9v-4h1V9h4v1h1z"/>'
    },
    "badge-check": {
      body: '<path fill="currentColor" d="M22 10V9h-1V5h-1V4h-1V3h-4V2h-1V1h-4v1H9v1H5v1H4v1H3v4H2v1H1v4h1v1h1v4h1v1h1v1h4v1h1v1h4v-1h1v-1h4v-1h1v-1h1v-4h1v-1h1v-4zm-1 4h-1v1h-1v4h-4v1h-1v1h-4v-1H9v-1H5v-4H4v-1H3v-4h1V9h1V5h4V4h1V3h4v1h1v1h4v4h1v1h1z"/><path fill="currentColor" d="M17 9v2h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1H9v-1H8v-1H7v-2h1v-1h1v1h1v1h2v-1h1v-1h1V9h1V8h1v1z"/>'
    },
    "badge-check-solid": {
      body: '<path fill="currentColor" d="M22 10V9h-1V5h-1V4h-1V3h-4V2h-1V1h-4v1H9v1H5v1H4v1H3v4H2v1H1v4h1v1h1v4h1v1h1v1h4v1h1v1h4v-1h1v-1h4v-1h1v-1h1v-4h1v-1h1v-4zM7 11h1v-1h1v1h1v1h2v-1h1v-1h1V9h1V8h1v1h1v2h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1H9v-1H8v-1H7z"/>'
    },
    bank: {
      body: '<path fill="currentColor" d="M14 4v2h-1v1h-2V6h-1V4h1V3h2v1zm7 16v-1h-1v-9h-2v9h-2v-9h-2v9h-4v-9H8v9H6v-9H4v9H3v1H1v2h1v1h20v-1h1v-2zm0 2H3v-1h1v-1h16v1h1zm1-15v1h-1v1H3V8H2V7h2v1h16V7z"/><path fill="currentColor" d="M23 5v2h-1V6h-3V5h-2V4h-2V3h-2V2h-2v1H9v1H7v1H5v1H2v1H1V5h3V4h2V3h2V2h2V1h4v1h2v1h2v1h2v1z"/>'
    },
    "bank-solid": {
      body: '<path fill="currentColor" d="M23 20v2h-1v1H2v-1H1v-2h2v-1h1v-9h2v9h2v-9h2v9h4v-9h2v9h2v-9h2v9h1v1zM20 5V4h-2V3h-2V2h-2V1h-4v1H8v1H6v1H4v1H1v2h1v1h1v1h18V8h1V7h1V5zm-9 2V6h-1V4h1V3h2v1h1v2h-1v1z"/>'
    },
    bars: {
      body: '<path fill="currentColor" d="M1 11h22v2H1zm0 8h22v2H1zM1 3h22v2H1z"/>'
    },
    "bars-solid": {
      body: '<path fill="currentColor" d="M22 11h1v2h-1v1H2v-1H1v-2h1v-1h20zm0 8h1v2h-1v1H2v-1H1v-2h1v-1h20zm1-16v2h-1v1H2V5H1V3h1V2h20v1z"/>'
    },
    behance: {
      body: '<path fill="currentColor" d="M22 11v-1h-1V9h-6v1h-1v1h-1v6h1v1h1v1h6v-1h1v-1h1v-1h-3v1h-3v-1h-1v-1h7v-4Zm-6 2v-2h4v2Zm-1-7h6v2h-6zm-4 7v-1h-1v-2h1V7h-1V6H9V5H1v14h9v-1h1v-1h1v-4ZM4 7h3v1h1v2H7v1H4Zm5 9H8v1H4v-4h4v1h1Z"/>'
    },
    bell: {
      body: '<path fill="currentColor" d="M15 20v2h-1v1h-4v-1H9v-2zm6-3v-1h-1v-2h-1V8h-1V6h-1V5h-1V4h-2V3h-1V1h-2v2h-1v1H8v1H7v1H6v2H5v6H4v2H3v1H2v1h1v1h18v-1h1v-1zM6 16v-2h1V8h1V6h2V5h4v1h2v2h1v6h1v2h1v1H5v-1z"/>'
    },
    "bell-exclaimation": {
      body: '<path fill="currentColor" d="M15 20v2h-1v1h-4v-1H9v-2zm6-3v-1h-1v-2h-1V8h-1V6h-1V5h-1V4h-2V3h-1V1h-2v2h-1v1H8v1H7v1H6v2H5v6H4v2H3v1H2v1h1v1h18v-1h1v-1zm-2 0H5v-1h1v-2h1V8h1V6h2V5h4v1h2v2h1v6h1v2h1z"/><path fill="currentColor" d="M11 14h2v2h-2zm3-7v3h-1v3h-2v-3h-1V7z"/>'
    },
    "bell-exclaimation-solid": {
      body: '<path fill="currentColor" d="M15 20v2h-1v1h-4v-1H9v-2zm6-3v-1h-1v-2h-1V8h-1V6h-1V5h-1V4h-2V3h-1V1h-2v2h-1v1H8v1H7v1H6v2H5v6H4v2H3v1H2v1h1v1h18v-1h1v-1zM14 6v3h-1v3h-2V9h-1V6zm-3 8h2v2h-2z"/>'
    },
    "bell-mute": {
      body: '<path fill="currentColor" d="M3 16h1v1H3zm2 0H4v-2h1V8h1V6h1V5h1V4h2V3h1V1h2v2h1v1h2v1h-1v1h-1V5h-4v1H8v2H7v6H6v1H5zm-3 1h1v1H2zm13 3v2h-1v1h-4v-1H9v-2zm6-3h1v1h-1v1H9v-1h1v-1h9v-1h-1v-2h-1v-4h1V9h1v5h1v2h1zm1-14v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H9v1H8v1H7v1H6v1H5v1H4v1H3v-1H2v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1V9h1V8h1V7h1V6h1V5h1V4h1V3h1V2h1v1z"/>'
    },
    "bell-mute-solid": {
      body: '<path fill="currentColor" d="M20 2h1v1h-1zm2 1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H9v1H8v1H7v1H6v1H5v1H4v1H3v-1H2v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1V9h1V8h1V7h1V6h1V5h1V4h1V3zm-1 14h1v1h-1v1H9v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1V9h1v5h1v2h1zM2 17h1v1H2zm3-1H4v-2h1V8h1V6h1V5h1V4h2V3h1V1h2v2h1v1h2v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H9v1H8v1H7v1H6v1H5zm-2 0h1v1H3zm12 4v2h-1v1h-4v-1H9v-2z"/>'
    },
    "bell-solid": {
      body: '<path fill="currentColor" d="M15 20v2h-1v1h-4v-1H9v-2zm7-3v1h-1v1H3v-1H2v-1h1v-1h1v-2h1V8h1V6h1V5h1V4h2V3h1V1h2v2h1v1h2v1h1v1h1v2h1v6h1v2h1v1z"/>'
    },
    bitcoin: {
      body: '<path fill="currentColor" d="M11 12h3v3h-3zm0-3h3v2h-3z"/><path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9ZM10 7V5h1v2h1V5h1v2h2v1h1v3h-1v1h1v1h1v2h-1v1h-1v1h-2v2h-1v-2h-1v2h-1v-2H7v-2h2V9H7V7Z"/>'
    },
    bloomberg: {
      body: '<path fill="currentColor" d="M22 2V1H2v1H1v20h1v1h20v-1h1V2zM7 5h7v1h1v1h1v4h-1v1h1v1h1v4h-1v1h-1v1H7z"/><path fill="currentColor" d="M15 14v2h-1v1H9v-4h5v1zm-1-6v2h-1v1H9V7h4v1z"/>'
    },
    bluesky: {
      body: '<path fill="currentColor" d="M23 3v8h-1v2h-2v1h-2v1h2v1h1v3h-1v1h-1v1h-2v1h-2v-1h-1v-1h-1v-2h-2v2h-1v1H9v1H7v-1H5v-1H4v-1H3v-3h1v-1h2v-1H4v-1H2v-2H1V3h1V2h2v1h2v1h1v1h1v1h1v1h1v2h1v1h2V9h1V7h1V6h1V5h1V4h1V3h2V2h2v1z"/>'
    },
    bold: {
      body: '<path fill="currentColor" d="M19 13v-1h-2v-1h1v-1h1V4h-1V3h-1V2h-1V1H5v1H4v20h1v1h12v-1h1v-1h1v-1h1v-7zM6 3h10v1h1v6H6zm12 17h-1v1H6v-9h10v1h1v1h1z"/>'
    },
    "bold-solid": {
      body: '<path fill="currentColor" d="M19 13v-1h-2v-1h1v-1h1V4h-1V3h-1V2h-1V1H5v1H4v20h1v1h12v-1h1v-1h1v-1h1v-7zm-3 6v1H7v-7h9v1h1v5zm0-14v4h-1v1H7V4h8v1z"/><path fill="none" d="M0 0h24v24H0z"/>'
    },
    bolt: {
      body: '<path fill="currentColor" d="M14 10V6h1V3h1V1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H9v1H8v1H7v1H6v1H5v1H4v1H3v1h7v4H9v3H8v2h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1zm4 2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v-5H6v-1h1v-1h1v-1h1V9h1V8h1V7h1V6h1v5h5z"/>'
    },
    "bolt-solid": {
      body: '<path fill="currentColor" d="M21 10v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H9v1H8v-2h1v-3h1v-4H3v-1h1v-1h1v-1h1v-1h1V9h1V8h1V7h1V6h1V5h1V4h1V3h1V2h1V1h1v2h-1v3h-1v4z"/>'
    },
    book: {
      body: '<path fill="currentColor" d="M20 17h1v-1h1V2h-1V1H4v1H3v1H2v18h1v1h1v1h17v-1h1v-1h-1v-1h-1Zm-2 4H5v-1H4v-2h1v-1h13ZM4 3h16v12H4Z"/>'
    },
    "book-bookmark": {
      body: '<path fill="currentColor" d="M20 17h1v-1h1V2h-1V1H4v1H3v1H2v18h1v1h1v1h17v-1h1v-1h-1v-1h-1Zm-2 4H5v-1H4v-2h1v-1h13ZM4 3h8v7h1V9h1V8h1v1h1v1h1V3h3v12H4Z"/>'
    },
    "book-bookmark-solid": {
      body: '<path fill="currentColor" d="M21 2V1h-4v9h-1V9h-1V8h-1v1h-1v1h-1V1H4v1H3v1H2v18h1v1h1v1h17v-1h1v-1h-1v-1h-1v-3h1v-1h1V2Zm-3 19H5v-1H4v-2h1v-1h13Z"/>'
    },
    "book-heart": {
      body: '<path fill="currentColor" d="M18 6v3h-1v1h-1v1h-1v1h-1v1h-1v1h-1v-1h-1v-1h-1v-1H9v-1H8V9H7V6h1V5h3v1h1v1h1V6h1V5h3v1z"/><path fill="currentColor" d="M20 17h1v-1h1V2h-1V1H4v1H3v1H2v18h1v1h1v1h17v-1h1v-1h-1v-1h-1zm-2 4H5v-1H4v-2h1v-1h13zM4 3h16v12H4z"/>'
    },
    "book-heart-solid": {
      body: '<path fill="currentColor" d="M21 17v-1h1V2h-1V1H4v1H3v1H2v18h1v1h1v1h17v-1h1v-1h-1v-1h-1v-3zm-3 4H6v-1H5v-2h1v-1h12zm0-12h-1v1h-1v1h-1v1h-1v1h-1v1h-1v-1h-1v-1h-1v-1H9v-1H8V9H7V6h1V5h3v1h1v1h1V6h1V5h3v1h1z"/>'
    },
    "book-solid": {
      body: '<path fill="currentColor" d="M21 2V1H4v1H3v1H2v18h1v1h1v1h17v-1h1v-1h-1v-1h-1v-3h1v-1h1V2Zm-3 19H5v-1H4v-2h1v-1h13Z"/>'
    },
    bookmark: {
      body: '<path fill="currentColor" d="M19 2V1H5v1H4v21h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h2v1h1v1h1v1h1v1h1v1h1v1h1v1h1V2zm-1 16h-1v-1h-1v-1h-1v-1h-1v-1h-4v1H9v1H8v1H7v1H6V4h1V3h10v1h1z"/>'
    },
    "bookmark-solid": {
      body: '<path fill="currentColor" d="M20 2v21h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-2v1h-1v1H9v1H8v1H7v1H6v1H5v1H4V2h1V1h14v1z"/>'
    },
    "box-heart": {
      body: '<path fill="currentColor" d="M22 6V4h-1V3h-1V2h-1V1H5v1H4v1H3v1H2v2H1v16h1v1h20v-1h1V6Zm-9-3h5v1h1v1h1v2h-7ZM4 5h1V4h1V3h5v4H4Zm17 16h-8v-2h1v-1h1v-1h1v-1h1v-3h-1v-1h-3v1h-2v-1H8v1H7v3h1v1h1v1h1v1h1v2H3V9h8v2h2V9h8Z"/>'
    },
    "box-heart-solid": {
      body: '<path fill="currentColor" d="M11 1v6H1V6h1V4h1V3h1V2h1V1zm12 5v1H13V1h6v1h1v1h1v1h1v2zM1 9v13h1v1h20v-1h1V9Zm9 10v-1H9v-1H8v-1H7v-3h1v-1h3v1h2v-1h3v1h1v3h-1v1h-1v1h-1v1h-1v1h-2v-1Z"/>'
    },
    "box-usd": {
      body: '<path fill="currentColor" d="M22 6V4h-1V3h-1V2h-1V1H5v1H4v1H3v1H2v2H1v16h1v1h20v-1h1V6zm-9-3h5v1h1v1h1v2h-7zM4 5h1V4h1V3h5v4H4zM3 21V9h8v2H9v4h1v1h3v1H9v2h2v2zm18 0h-8v-2h2v-4h-1v-1h-3v-1h4v-2h-2V9h8z"/>'
    },
    "box-usd-solid": {
      body: '<path fill="currentColor" d="M1 9v13h1v1h20v-1h1V9zm12 11v2h-2v-2H9v-2h4v-1h-3v-1H9v-4h2v-2h2v2h2v2h-4v1h3v1h1v4zM11 1v6H1V6h1V4h1V3h1V2h1V1zm12 5v1H13V1h6v1h1v1h1v1h1v2z"/>'
    },
    "bracket-curly": {
      body: '<path fill="currentColor" d="M10 3v2H6v1H5v4H4v4h1v4h1v1h4v2H5v-1H4v-1H3v-4H2v-2H1v-2h1V9h1V5h1V4h1V3zm13 8v2h-1v2h-1v4h-1v1h-1v1h-5v-2h4v-1h1v-4h1v-4h-1V6h-1V5h-4V3h5v1h1v1h1v4h1v2z"/>'
    },
    "bracket-curly-solid": {
      body: '<path fill="currentColor" d="M10 3v3H6v4H5v4h1v4h4v3H4v-1H3v-5H2v-1H1v-4h1V9h1V4h1V3zm13 7v4h-1v1h-1v5h-1v1h-6v-3h4v-4h1v-4h-1V6h-4V3h6v1h1v5h1v1z"/>'
    },
    "bracket-round": {
      body: '<path fill="currentColor" d="M7 3v2H5v2H4v2H3v6h1v2h1v2h2v2H5v-1H4v-1H3v-2H2v-2H1V9h1V7h1V5h1V4h1V3zm16 6v6h-1v2h-1v2h-1v1h-1v1h-2v-2h2v-2h1v-2h1V9h-1V7h-1V5h-2V3h2v1h1v1h1v2h1v2z"/>'
    },
    "bracket-round-solid": {
      body: '<path fill="currentColor" d="M7 3v3H6v1H5v2H4v6h1v2h1v1h1v3H5v-1H4v-1H3v-2H2v-2H1V9h1V7h1V5h1V4h1V3zm16 6v6h-1v2h-1v2h-1v1h-1v1h-2v-3h1v-1h1v-2h1V9h-1V7h-1V6h-1V3h2v1h1v1h1v2h1v2z"/>'
    },
    "bracket-square": {
      body: '<path fill="currentColor" d="M7 3v2H3v14h4v2H1V3zm16 0v18h-6v-2h4V5h-4V3z"/>'
    },
    "bracket-square-solid": {
      body: '<path fill="currentColor" d="M23 3v18h-6v-3h3V6h-3V3zM7 3v3H4v12h3v3H1V3z"/>'
    },
    branch: {
      body: '<path fill="currentColor" d="M20 2V1h-4v1h-1v4h1v1h1v4H7V7h1V6h1V2H8V1H4v1H3v4h1v1h1v10H4v1H3v4h1v1h4v-1h1v-4H8v-1H7v-4h12V7h1V6h1V2ZM5 3h2v2H5Zm2 18H5v-2h2ZM19 5h-2V3h2Z"/>'
    },
    "branch-solid": {
      body: '<path fill="currentColor" d="M21 3V2h-1V1h-3v1h-1v1h-1v3h1v1h1v3H7V7h1V6h1V3H8V2H7V1H4v1H3v1H2v3h1v1h1v10H3v1H2v3h1v1h1v1h3v-1h1v-1h1v-3H8v-1H7v-4h12v-1h1V7h1V6h1V3Zm-1 2h-1v1h-1V5h-1V4h1V3h1v1h1ZM4 5V4h1V3h1v1h1v1H6v1H5V5Zm3 14v1H6v1H5v-1H4v-1h1v-1h1v1Z"/>'
    },
    briefcase: {
      body: '<path fill="currentColor" d="M22 7V6h-5V3h-1V2H8v1H7v3H2v1H1v14h1v1h20v-1h1V7ZM9 4h6v2H9Zm12 15h-1v1H4v-1H3v-5h6v2h6v-2h6Zm0-7H3V9h1V8h16v1h1Z"/>'
    },
    "briefcase-solid": {
      body: '<path fill="currentColor" d="M22 7V6h-5V3h-1V2H8v1H7v3H2v1H1v6h22V7ZM9 4h6v2H9Zm14 11v6h-1v1H2v-1H1v-6h8v2h6v-2z"/>'
    },
    "brightness-high": {
      body: '<path fill="currentColor" d="M4 5H3V4h1V3h1v1h1v1h1v1h1v1H7v1H6V7H5V6H4zm-3 6h5v2H1zm6 6h1v1H7v1H6v1H5v1H4v-1H3v-1h1v-1h1v-1h1v-1h1zm4 1h2v5h-2zm0-17h2v5h-2zm7 10h5v2h-5zm-1-4h-1V6h1V5h1V4h1V3h1v1h1v1h-1v1h-1v1h-1v1h-1zm4 12v1h-1v1h-1v-1h-1v-1h-1v-1h-1v-1h1v-1h1v1h1v1h1v1zm-5-5h1v-4h-1V8h-2V7h-4v1H8v2H7v4h1v2h2v1h4v-1h2zm-1 0h-1v1h-4v-1H9v-4h1V9h4v1h1z"/>'
    },
    "brightness-high-solid": {
      body: '<path fill="currentColor" d="M1 11h5v2H1zm3-6H3V4h1V3h1v1h1v1h1v1h1v1H7v1H6V7H5V6H4zm3 12h1v1H7v1H6v1H5v1H4v-1H3v-1h1v-1h1v-1h1v-1h1zm4 1h2v5h-2zm0-17h2v5h-2zm9 18h1v1h-1v1h-1v-1h-1v-1h-1v-1h-1v-1h1v-1h1v1h1v1h1zm-2-8h5v2h-5zm-1-4h-1V6h1V5h1V4h1V3h1v1h1v1h-1v1h-1v1h-1v1h-1zm-1 9h-2v1h-4v-1H8v-2H7v-4h1V8h2V7h4v1h2v2h1v4h-1z"/>'
    },
    "brightness-low": {
      body: '<path fill="currentColor" d="M19 11h1v2h-1zm3 0h1v2h-1zm-2-1h2v1h-2zm0 3h2v1h-2zm-3-9h1v2h-1zm1 2h2v1h-2zm2-2h1v2h-1zm-2-1h2v1h-2zm0 14h2v1h-2zm2 1h1v2h-1zm-3 0h1v2h-1zm1 2h2v1h-2zm-7-1h2v1h-2zm0 3h2v1h-2zm2-2h1v2h-1zm-3 0h1v2h-1zm3-18h1v2h-1zm-3 0h1v2h-1zm1-1h2v1h-2zm0 3h2v1h-2zm5 6V8h-2V7h-4v1H8v2H7v4h1v2h2v1h4v-1h2v-2h1v-4zm-2 4v1h-4v-1H9v-4h1V9h4v1h1v4zM3 18h1v2H3zm1 2h2v1H4zm0-3h2v1H4zm2 1h1v2H6zM6 4h1v2H6zM4 3h2v1H4zm0 3h2v1H4zM3 4h1v2H3zm-1 9h2v1H2zm0-3h2v1H2zm-1 1h1v2H1zm3 0h1v2H4z"/>'
    },
    "brightness-low-solid": {
      body: '<path fill="currentColor" d="M6 18h1v2H6v1H4v-1H3v-2h1v-1h2zM4 6H3V4h1V3h2v1h1v2H6v1H4zm-2 8v-1H1v-2h1v-1h2v1h1v2H4v1zm11 6h1v2h-1v1h-2v-1h-1v-2h1v-1h2zM11 4h-1V2h1V1h2v1h1v2h-1v1h-2zm7 2h-1V4h1V3h2v1h1v2h-1v1h-2zm-1 8h-1v2h-2v1h-4v-1H8v-2H7v-4h1V8h2V7h4v1h2v2h1zm3 4h1v2h-1v1h-2v-1h-1v-2h1v-1h2zm3-7v2h-1v1h-2v-1h-1v-2h1v-1h2v1z"/>'
    },
    broom: {
      body: '<path fill="currentColor" d="M21 1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-5v1H8v1H6v1H4v1H2v1H1v2h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h2v-1h1v-2h1v-2h1v-2h1v-2h1V9h1V8h1V7h1V6h1V5h1V4h1V3h1V1Zm-8 15h-1v2h-1v2H9v-1H8v-1H7v-1H6v-1h1v-1h1v-1H6v1H4v-2h2v-1h2v-1h1v1h1v1h1v1h1v1h1Zm1-3h-1v-1h-1v-1h-1v-1h2v1h1Z"/>'
    },
    "broom-solid": {
      body: '<path fill="currentColor" d="M13 16h1v2h-1v2h-1v2h-1v1H9v-1H8v-1H7v-1H6v-1H5v-2h1v-1h1v-2H6v1H5v1H4v1H3v-1H2v-1H1v-2h1v-1h2v-1h2v-1h2v1h1v1h1v1h1v1h1v1h1zM23 1v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v2h1v2h-1v1h-2v-1h-1v-1h-1v-1h-1v-1h-1V8h1V7h2v1h2V7h1V6h1V5h1V4h1V3h1V2h1V1z"/>'
    },
    bug: {
      body: '<path fill="currentColor" d="M9 6H8V4h1V3h2V2h2v1h2v1h1v2h-1v1H9z"/><path fill="currentColor" d="M18 12v-2h1V9h1V8h1V6h-2v1h-1v1h-1v1H7V8H6V7H5V6H3v2h1v1h1v1h1v2H1v2h5v3H5v1H4v1H3v2h2v-1h1v-1h1v1h1v1h3v1h2v-1h3v-1h1v-1h1v1h1v1h2v-2h-1v-1h-1v-1h-1v-3h5v-2Zm-3 6v1h-2v-6h-2v6H9v-1H8v-6h1v-1h6v1h1v6Z"/>'
    },
    "bug-solid": {
      body: '<path fill="currentColor" d="M9 6H8V4h1V3h2V2h2v1h2v1h1v2h-1v1H9z"/><path fill="currentColor" d="M23 12v2h-5v3h1v1h1v1h1v2h-2v-1h-1v-1h-1v1h-1v1h-3v-8h-2v8H8v-1H7v-1H6v1H5v1H3v-2h1v-1h1v-1h1v-3H1v-2h5v-2H5V9H4V8H3V6h2v1h1v1h1v1h10V8h1V7h1V6h2v2h-1v1h-1v1h-1v2z"/>'
    },
    "bullet-list": {
      body: '<path fill="currentColor" d="M2 5h3v3H2zm0 6h3v3H2zm0 6h3v3H2zm6 1h14v1H8zM8 6h14v1H8zm0 6h14v1H8z"/>'
    },
    "bullet-list-solid": {
      body: '<path fill="currentColor" d="M2 5h3v3H2zm0 12h3v3H2zm0-6h3v3H2zm21-5v1h-1v1H10V7H9V6h1V5h12v1zm-1 6h1v1h-1v1H10v-1H9v-1h1v-1h12zm0 6h1v1h-1v1H10v-1H9v-1h1v-1h12z"/><path fill="none" d="M0 0h24v24H0z"/>'
    },
    bullhorn: {
      body: '<path fill="currentColor" d="M22 10V9h-1V3h-1V2h-1v1h-1v1h-2v1h-2v1h-2v1H2v1H1v7h1v1h3v5h1v1h2v-1h1v-5h3v1h2v1h2v1h2v1h1v1h1v-1h1v-6h1v-1h1v-3zm-3 7h-2v-1h-2v-1h-2v-1h-3V9h3V8h2V7h2V6h2z"/>'
    },
    "bullhorn-solid": {
      body: '<path fill="currentColor" d="M23 10v3h-1v1h-1V9h1v1zM2 7h6v15H6v-1H5v-5H2v-1H1V8h1zm18-5v19h-1v-1h-1v-1h-2v-1h-2v-1h-2v-1h-2V7h2V6h2V5h2V4h2V3h1V2z"/>'
    },
    business: {
      body: '<path fill="currentColor" d="M22.505 15.503v7.002h-1v1H3.5v-1h-1v-7.002h7.002v2h6.001v-2z"/><path fill="currentColor" d="M14.503 15.503h-4v1h4zm0-2h-4v1h4z"/><path fill="currentColor" d="M22.505 5.5v-1h-6.002v-2h-1v-1H9.502v1h-1v2H2.5v1h-1v8.003h1v1h7.002v-2h6.001v2h7.002v-1h1V5.5zm-12.003-2h4.001v1h-4.001z"/>'
    },
    "calendar-alt": {
      body: '<path fill="currentColor" d="M6 1h2v6H6zm3 3h6v2H9zm7-3h2v6h-2z"/><path fill="currentColor" d="M22 5V4h-3v2h2v3H3V6h2V4H2v1H1v17h1v1h20v-1h1V5Zm-1 16H3V11h18Z"/>'
    },
    "calendar-alt-solid": {
      body: '<path fill="currentColor" d="M16 1h2v1h-2zM6 1h2v1H6zm17 4v4H1V5h1V4h3V2h1v5h2V2h1v2h6V2h1v5h2V2h1v2h3v1zm0 6v11h-1v1H2v-1H1V11z"/>'
    },
    calender: {
      body: '<path fill="currentColor" d="M16 1h2v1h-2zm6 4V4h-3V2h-1v5h-2V2h-1v2H9V2H8v5H6V2H5v2H2v1H1v17h1v1h20v-1h1V5zM2 6h1V5h2v2H2zm4 16H3v-1H2v-3h4zm0-5H2v-4h4zm0-5H2V8h4zm11-4v4h-4V8zm0 9h-4v-4h4zM9 5h6v2H9zm2 17H7v-4h4zm0-5H7v-4h4zm0-5H7V8h4zm2 10v-4h4v4zm9-1h-1v1h-3v-4h4zm0-4h-4v-4h4zm0-5h-4V8h4zm0-5h-3V5h2v1h1zM6 1h2v1H6z"/>'
    },
    "calender-solid": {
      body: '<path fill="currentColor" d="M6 1h2v1H6zm10 0h2v1h-2zm6 4V4h-3V2h-1v5h-2V2h-1v2H9V2H8v5H6V2H5v2H2v1H1v17h1v1h20v-1h1V5zm-1 3v3h-3V8zm0 8h-3v-3h3zm0 5h-3v-3h3zM3 18h3v3H3zm0-5h3v3H3zm13 3h-3v-3h3zm-5 0H8v-3h3zm-3 2h3v3H8zm5 0h3v3h-3zm3-7h-3V8h3zm-5-3v3H8V8zm-5 3H3V8h3z"/>'
    },
    camera: {
      body: '<path fill="currentColor" d="M22 7V6h-1V5h-4V3h-1V2H8v1H7v2H3v1H2v1H1v13h1v1h1v1h18v-1h1v-1h1V7Zm-1 12h-1v1H4v-1H3V8h1V7h4V6h1V4h6v2h1v1h4v1h1Z"/><path fill="currentColor" d="M16 11v4h-1v1h-1v1h-4v-1H9v-1H8v-4h1v-1h1V9h4v1h1v1zM5 8h2v2H5z"/>'
    },
    "camera-solid": {
      body: '<path fill="currentColor" d="M22 7V6h-1V5h-4V3h-1V2H8v1H7v2H3v1H2v1H1v13h1v1h1v1h18v-1h1v-1h1V7ZM7 10H5V8h2Zm8 6h-1v1h-4v-1H9v-1H8v-4h1v-1h1V9h4v1h1v1h1v4h-1Z"/>'
    },
    "cart-add": {
      body: '<path fill="currentColor" d="M9 19h1v2H9v1H7v-1H6v-2h1v-1h2zm11 0h1v2h-1v1h-2v-1h-1v-2h1v-1h2zM4 3V2H1v2h3v3h1v5h1v4h1v1h13v-2H8v-2h12v-1h1V9h1V6h1V3Zm8 4h-2v2h2v2H7V7H6V5h6Zm9-1h-1v3h-1v2h-5V9h2V7h-2V5h7Z"/>'
    },
    "cart-add-solid": {
      body: '<path fill="currentColor" d="M21 19v2h-1v1h-2v-1h-1v-2h1v-1h2v1zM9 19h1v2H9v1H7v-1H6v-2h1v-1h2zM4 3V2H1v2h3v3h1v5h1v4h1v1h13v-2H8v-2h12v-1h1V9h1V6h1V3Zm10 6v2h-2V9h-2V7h2V5h2v2h2v2Z"/>'
    },
    "cart-minus": {
      body: '<path fill="currentColor" d="M10 7h6v2h-6zM9 19h1v2H9v1H7v-1H6v-2h1v-1h2z"/><path fill="currentColor" d="M4 3V2H1v2h3v3h1v5h1v4h1v1h13v-2H8v-2h12v-1h1V9h1V6h1V3Zm17 3h-1v3h-1v2H7V7H6V5h15Zm-1 13h1v2h-1v1h-2v-1h-1v-2h1v-1h2z"/>'
    },
    "cart-minus-solid": {
      body: '<path fill="currentColor" d="M9 19h1v2H9v1H7v-1H6v-2h1v-1h2zm11 0h1v2h-1v1h-2v-1h-1v-2h1v-1h2zM4 3V2H1v2h3v3h1v5h1v4h1v1h13v-2H8v-2h12v-1h1V9h1V6h1V3Zm12 4v2h-6V7Z"/>'
    },
    "cassette-tape": {
      body: '<path fill="currentColor" d="M17 19h1v1H6v-1h1v-2h1v-1h8v1h1z"/><path fill="currentColor" d="M22 5V4H2v1H1v14h1v1h2v-1h1v-2h1v-1h1v-1h10v1h1v1h1v2h1v1h2v-1h1V5Zm-1 11h-2v-1h-1v-1H6v1H5v1H3V6h18Z"/><path fill="currentColor" d="M8 9v2H7v1H5v-1H4V9h1V8h2v1zm6 2h1v1H9v-1h1V9H9V8h6v1h-1zm6-2v2h-1v1h-2v-1h-1V9h1V8h2v1z"/>'
    },
    "cassette-tape-solid": {
      body: '<path fill="currentColor" d="M22 5V4H2v1H1v14h1v1h2v-1h1v-2h1v-1h1v-1h10v1h1v1h1v2h1v1h2v-1h1V5ZM7 11H6v1H4v-1H3V9h1V8h2v1h1Zm8-2h-1v2h1v1H9v-1h1V9H9V8h6Zm6 2h-1v1h-2v-1h-1V9h1V8h2v1h1Z"/><path fill="currentColor" d="M17 19h1v1H6v-1h1v-2h1v-1h8v1h1z"/>'
    },
    cc: {
      body: '<path fill="currentColor" d="M22 5V4H2v1H1v14h1v1h20v-1h1V5zm-1 13H3V6h18z"/><path fill="currentColor" d="M20 7v2h-4v1h-1v4h1v1h4v2h-5v-1h-1v-1h-1V9h1V8h1V7zm-9 0v2H7v1H6v4h1v1h4v2H6v-1H5v-1H4V9h1V8h1V7z"/>'
    },
    "cc-solid": {
      body: '<path fill="currentColor" d="M22 5V4H2v1H1v14h1v1h20v-1h1V5zM11 9H7v1H6v4h1v1h4v2H6v-1H5v-1H4V9h1V8h1V7h5zm9 0h-4v1h-1v4h1v1h4v2h-5v-1h-1v-1h-1V9h1V8h1V7h5z"/>'
    },
    "chart-line": {
      body: '<path fill="currentColor" d="M22 5v7h-1V8h-2v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v-1h-1v-1h-1v-1h-1v-1H9v1H8v1H7v1H6v-2h1v-1h1V9h1V8h1v1h1v1h1v1h1v1h1v-1h1v-1h1V9h1V8h1V7h1V6h-4V5z"/><path fill="currentColor" d="M23 18v2H2v-1H1V4h2v14z"/>'
    },
    "chart-line-solid": {
      body: '<path fill="currentColor" d="M6 13v-2h1v-1h1V9h1V8h1v1h1v1h1v1h1v1h1v-1h1v-1h1V9h1V7h-1V6h-1V5h7v7h-1v-1h-1v-1h-2v1h-1v1h-1v1h-1v1h-1v1h-1v-1h-1v-1h-1v-1h-1v-1H9v1H8v1z"/><path fill="currentColor" d="M23 17v3H2v-1H1V4h3v13z"/>'
    },
    "chart-network": {
      body: '<path fill="currentColor" d="M7 7H5V6H4V4h1V3h2v1h1v2H7zm-2 4h1v3H5v1H2v-1H1v-3h1v-1h3zm4-3h1v1H9zm6 7h1v1h-1zm2-7h1v1h-1zM8 7h1v1H8zm-1 5h1v1H7z"/><path fill="currentColor" d="M16 14v-3h-1v-1h-1V9h-3v1h-1v1H9v3h1v1h1v1h3v-1h1v-1zm-5 0v-3h3v3zm5-5h1v1h-1zm0 7h1v1h-1zm5 2h1v3h-1v1h-3v-1h-1v-3h1v-1h3zm1-13v2h-1v1h-2V7h-1V5h1V4h2v1z"/>'
    },
    "chart-network-solid": {
      body: '<path fill="currentColor" d="M17 14v-4h1V9h1V8h2V7h1V5h-1V4h-2v1h-1v2h-1v1h-1v1h-2V8h-4V7H9V6H8V4H7V3H5v1H4v2h1v1h2v1h1v1h1v2H8v1H6v-1H5v-1H2v1H1v3h1v1h3v-1h4v1h1v1h1v1h3v-1h1v1h1v1h1v3h1v1h3v-1h1v-3h-1v-1h-3v-1h-1v-1h-1v-1zm-3 0h-3v-3h3z"/>'
    },
    check: {
      body: '<path fill="currentColor" d="M22 4v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H8v-1H7v-1H6v-1H5v-1H4v-1H3v-1H2v-2h2v1h1v1h1v1h1v1h1v1h2v-1h1v-1h1v-1h1v-1h1v-1h1V9h1V8h1V7h1V6h1V5h1V4z"/>'
    },
    "check-box": {
      body: '<path fill="currentColor" d="M19 9v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1H9v-1H8v-1H7v-1H6v-1H5v-1h1v-1h1V9h1v1h1v1h1v1h2v-1h1v-1h1V9h1V8h1V7h1v1h1v1z"/><path fill="currentColor" d="M22 2V1H2v1H1v20h1v1h20v-1h1V2zm-1 19H3V3h18z"/>'
    },
    "check-box-solid": {
      body: '<path fill="currentColor" d="M22 2V1H2v1H1v20h1v1h20v-1h1V2zM5 11h1v-1h1V9h1v1h1v1h1v1h2v-1h1v-1h1V9h1V8h1V7h1v1h1v1h1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1H9v-1H8v-1H7v-1H6v-1H5z"/>'
    },
    "check-circle": {
      body: '<path fill="currentColor" d="M19 9v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1H9v-1H8v-1H7v-1H6v-1h1v-1h1v1h1v1h1v1h2v-1h1v-1h1v-1h1v-1h1V9h1V8h1v1z"/><path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9zm-2 6v2h-1v2h-2v1h-2v1H9v-1H7v-1H5v-2H4v-2H3V9h1V7h1V5h2V4h2V3h6v1h2v1h2v2h1v2h1v6z"/>'
    },
    "check-circle-solid": {
      body: '<path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9zm-4 3h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1H9v-1H8v-1H7v-1H6v-2h1v-1h2v1h1v1h2v-1h1v-1h1v-1h1V9h1V8h2v1h1v2h-1z"/>'
    },
    "check-list": {
      body: '<path fill="currentColor" d="M9 18h14v1H9zm0-6h14v1H9zm0-6h14v1H9zm-2 9h1v2H7v1H6v1H5v1H4v1H3v-1H2v-1H1v-2h1v1h1v1h1v-1h1v-1h1v-1h1zm1-6v2H7v1H6v1H5v1H4v1H3v-1H2v-1H1v-2h1v1h1v1h1v-1h1v-1h1v-1h1V9zm0-6v2H7v1H6v1H5v1H4v1H3V8H2V7H1V5h1v1h1v1h1V6h1V5h1V4h1V3z"/>'
    },
    "check-list-solid": {
      body: '<path fill="currentColor" d="M23 6v1h-1v1H10V7H9V6h1V5h12v1zm-1 12h1v1h-1v1H10v-1H9v-1h1v-1h12zm0-6h1v1h-1v1H10v-1H9v-1h1v-1h12zM8 15v2H7v1H6v1H5v1H4v1H3v-1H2v-1H1v-2h1v1h1v1h1v-1h1v-1h1v-1h1v-1zm0-6v2H7v1H6v1H5v1H4v1H3v-1H2v-1H1v-2h1v1h1v1h1v-1h1v-1h1v-1h1V9zm0-6v2H7v1H6v1H5v1H4v1H3V8H2V7H1V5h1v1h1v1h1V6h1V5h1V4h1V3z"/><path fill="none" d="M0 0h24v24H0z"/>'
    },
    "check-solid": {
      body: '<path fill="currentColor" d="M23 5v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H8v-1H7v-1H6v-1H5v-1H4v-1H3v-1H2v-1H1v-1h1v-1h1V9h1v1h1v1h1v1h1v1h1v1h2v-1h1v-1h1v-1h1v-1h1V9h1V8h1V7h1V6h1V5h1V4h1V3h1v1h1v1z"/>'
    },
    "chevron-down": {
      body: '<path fill="currentColor" d="M22 6v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1h-1v-1H9v-1H8v-1H7v-1H6v-1H5v-1H4V9H3V8H2V6h2v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h2v-1h1v-1h1v-1h1v-1h1V9h1V8h1V7h1V6z"/>'
    },
    "chevron-down-solid": {
      body: '<path fill="currentColor" d="M23 8v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1h-1v-1H9v-1H8v-1H7v-1H6v-1H5v-1H4v-1H3v-1H2V9H1V8h1V7h1V6h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h2v-1h1v-1h1v-1h1v-1h1V9h1V8h1V7h1V6h1v1h1v1z"/>'
    },
    "chevron-up": {
      body: '<path fill="currentColor" d="M22 16v2h-2v-1h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-2v1h-1v1H9v1H8v1H7v1H6v1H5v1H4v1H2v-2h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1V9h1V8h1V7h2v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1z"/>'
    },
    "chevron-up-solid": {
      body: '<path fill="currentColor" d="M23 16v1h-1v1h-1v1h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-2v1h-1v1H9v1H8v1H7v1H6v1H5v1H4v1H3v-1H2v-1H1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1V9h1V8h1V7h1V6h2v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1z"/>'
    },
    "circle-notch": {
      body: '<path fill="currentColor" d="M23 9v6h-1v2h-1v2h-1v1h-1v1h-2v1h-2v1H9v-1H7v-1H5v-1H4v-1H3v-2H2v-2H1V9h1V7h1V5h1V4h1V3h2V2h2V1h1v1h1v1h-1v1H8v1H6v1H5v2H4v2H3v4h1v2h1v2h1v1h2v1h2v1h4v-1h2v-1h2v-1h1v-2h1v-2h1v-4h-1V8h-1V6h-1V5h-2V4h-2V3h-1V2h1V1h1v1h2v1h2v1h1v1h1v2h1v2z"/>'
    },
    "circle-notch-solid": {
      body: '<path fill="currentColor" d="M23 9v6h-1v2h-1v2h-1v1h-1v1h-2v1h-2v1H9v-1H7v-1H5v-1H4v-1H3v-2H2v-2H1V9h1V7h1V5h1V4h1V3h2V2h2V1h1v1h1v2H9v1H7v1H6v1H5v2H4v6h1v2h1v1h1v1h2v1h6v-1h2v-1h1v-1h1v-2h1V9h-1V7h-1V6h-1V5h-2V4h-2V2h1V1h1v1h2v1h2v1h1v1h1v2h1v2z"/>'
    },
    clipboard: {
      body: '<path fill="currentColor" d="M19 5V4h-3V3h-1V2h-1V1h-4v1H9v1H8v1H5v1H4v17h1v1h14v-1h1V5zm-9-2h1V2h2v1h1v2h-1v1h-2V5h-1zM6 6h2v1h8V6h2v15H6z"/>'
    },
    "clipboard-solid": {
      body: '<path fill="currentColor" d="M15 3V2h-1V1h-4v1H9v1H8v3h1v1h6V6h1V3zm-4 3V5h-1V3h1V2h2v1h1v2h-1v1z"/><path fill="currentColor" d="M20 5v17h-1v1H5v-1H4V5h1V4h2v3h1v1h8V7h1V4h2v1z"/>'
    },
    clock: {
      body: '<path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9zm-1 6h-1v2h-1v2h-2v1h-2v1H9v-1H7v-1H5v-2H4v-2H3V9h1V7h1V5h2V4h2V3h6v1h2v1h2v2h1v2h1z"/><path fill="currentColor" d="M16 15v1h-1v1h-1v-1h-1v-1h-1v-1h-1V5h2v8h1v1h1v1z"/>'
    },
    "clock-solid": {
      body: '<path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9zm-9 7v-1h-1v-1h-1V5h2v8h1v1h1v1h1v1h-1v1h-1v-1z"/>'
    },
    cloud: {
      body: '<path fill="currentColor" d="M23.505 17.503h-2v2h2zm-5.001 4.001h-2v2h2zm2-4v1h-2v-1h-1v-3.001h1v2h1v1zm-4.001 2v1h-2v-1h-1v-5.001h1v4h1v1.001zm-5.001-5.001v5.001h-1v1h-2v-1h1v-1h1v-4.001zm-3 7.001h-2v2h2zm-1.001-7.001v3h-1v1h-2v-1h1v-1h1v-2zm15.004-7.002v-1h-1v-1h-2v-2h-1.001v-1h-1V1.5h-5.002v1h-1v1h-1v1h-1v-1h-3v1H5.5v1h-1v2.001h-2v1h-1v3.001h1v1h1v1h18.005v-1h1v-1h1v-4zm-8.002 3.001v-1h-1v-2h1v1h1V5.5h1v3h1v-1h1v2h-1v1.001h-1v1h-1v-1zm-4.001-4v1h1v2h-1v-1h-1v3h-1v-3h-1v1h-1v-2h1v-1h1V5.5h1v1zM3.5 17.503h-2v2h2z"/>'
    },
    "cloud-download-alt": {
      body: '<path fill="currentColor" d="M14 13v2h-1v1h-1v1h-1v1h-1v-1H9v-1H8v-1H7v-2h1v1h1v1h1V9h1v6h1v-1h1v-1z"/><path fill="currentColor" d="M22 12v-1h-2V9h-1V8h-1V7h-3v1h-1V6h-1V5H8v1H7v1H6v1H5v3H2v1H1v5h1v1h1v1h2v1h14v-1h2v-1h1v-1h1v-5zm0 4h-1v1h-1v1h-2v1H6v-1H4v-1H3v-1H2v-3h1v-1h3V9h1V8h1V7h1V6h3v1h1v2h3V8h1v1h1v1h1v2h2v1h1z"/>'
    },
    "cloud-download-solid": {
      body: '<path fill="currentColor" d="M22 12v-1h-2V9h-1V8h-1V7h-3v1h-1V6h-1V5H8v1H7v1H6v1H5v3H2v1H1v5h1v1h1v1h2v1h14v-1h2v-1h1v-1h1v-5zM9 17v-1H8v-1H7v-1H6v-1h3V9h3v4h3v1h-1v1h-1v1h-1v1h-1v1h-1v-1z"/>'
    },
    "cloud-fog": {
      body: '<path fill="currentColor" d="M22 8V7h-2V5h-1V4h-1V3h-3v1h-1V2h-1V1H8v1H7v1H6v1H5v3H2v1H1v5h1v1h1v1h2v1h14v-1h2v-1h1v-1h1V8Zm0 4h-1v1h-1v1h-2v1H6v-1H4v-1H3v-1H2V9h1V8h3V5h1V4h1V3h1V2h3v1h1v2h3V4h1v1h1v1h1v2h2v1h1ZM5 21h6v1H5zm8 0h10v1H13zM3 18h15v1H3z"/>'
    },
    "cloud-fog-solid": {
      body: '<path fill="currentColor" d="M5 21h6v2H5zm-2-3h15v2H3zm10 3h10v2H13zM23 8v5h-1v1h-1v1h-2v1H5v-1H3v-1H2v-1H1V8h1V7h3V4h1V3h1V2h1V1h5v1h1v2h1V3h3v1h1v1h1v2h2v1z"/>'
    },
    "cloud-rain": {
      body: '<path fill="currentColor" d="M22 8V7h-2V5h-1V4h-1V3h-3v1h-1V2h-1V1H8v1H7v1H6v1H5v3H2v1H1v5h1v1h1v1h2v1h14v-1h2v-1h1v-1h1V8Zm0 4h-1v1h-1v1h-2v1H6v-1H4v-1H3v-1H2V9h1V8h3V5h1V4h1V3h1V2h3v1h1v2h3V4h1v1h1v1h1v2h2v1h1Zm-7 5h1v3h-1zM5 19h1v3H5zm8 1h1v3h-1zm4 0h1v3h-1zm4-1h1v3h-1zM9 19h1v3H9zm2-2h1v3h-1zm8 0h1v3h-1zM7 17h1v3H7zm-4-1h1v3H3z"/>'
    },
    "cloud-rain-solid": {
      body: '<path fill="currentColor" d="M3 16h1v3H3zm2 3h1v3H5zm2-2h1v3H7zm2 2h1v3H9zm4 1h1v3h-1zm-2-3h1v3h-1zm6 3h1v3h-1zm-2-3h1v3h-1zm6 2h1v3h-1zm2-11v5h-1v1h-1v1h-2v1H5v-1H3v-1H2v-1H1V8h1V7h3V4h1V3h1V2h1V1h5v1h1v2h1V3h3v1h1v1h1v2h2v1zm-4 9h1v3h-1z"/>'
    },
    "cloud-upload": {
      body: '<path fill="currentColor" d="M14 12v2h-1v-1h-1v-1h-1v6h-1v-6H9v1H8v1H7v-2h1v-1h1v-1h1V9h1v1h1v1h1v1z"/><path fill="currentColor" d="M22 12v-1h-2V9h-1V8h-1V7h-3v1h-1V6h-1V5H8v1H7v1H6v1H5v3H2v1H1v5h1v1h1v1h2v1h14v-1h2v-1h1v-1h1v-5zm0 4h-1v1h-1v1h-2v1H6v-1H4v-1H3v-1H2v-3h1v-1h3V9h1V8h1V7h1V6h3v1h1v2h3V8h1v1h1v1h1v2h2v1h1z"/>'
    },
    "cloud-upload-solid": {
      body: '<path fill="currentColor" d="M22 12v-1h-2V9h-1V8h-1V7h-3v1h-1V6h-1V5H8v1H7v1H6v1H5v3H2v1H1v5h1v1h1v1h2v1h14v-1h2v-1h1v-1h1v-5zM9 14H6v-1h1v-1h1v-1h1v-1h1V9h1v1h1v1h1v1h1v1h1v1h-3v4H9z"/>'
    },
    cloudflare: {
      body: '<path fill="currentColor" d="M18 11h-1v2H7v1h9v2H1v-2h1v-2h2v-2h1V9h2v1h1V8h1V7h2V6h5v1h1v1h1zm5 1v4h-6v-1h1v-1h3v-1h-3v-2h1v-1h2v1h1v1z"/>'
    },
    code: {
      body: '<path fill="currentColor" d="M7 7v1H6v1H5v1H4v1H3v2h1v1h1v1h1v1h1v1H5v-1H4v-1H3v-1H2v-1H1v-2h1v-1h1V9h1V8h1V7zm8-4h1v3h-1v3h-1v3h-1v2h-1v3h-1v3h-1v1H9v-3h1v-3h1v-3h1v-2h1V7h1V4h1zm8 8v2h-1v1h-1v1h-1v1h-1v1h-2v-1h1v-1h1v-1h1v-1h1v-2h-1v-1h-1V9h-1V8h-1V7h2v1h1v1h1v1h1v1z"/>'
    },
    "code-block": {
      body: '<path fill="currentColor" d="M14 10h-1V8h1V7h1V6h1V5h-1V4h-1V3h-1V1h1v1h1v1h1v1h1v1h1v1h-1v1h-1v1h-1v1h-1zM2 6H1V5h1V4h1V3h1V2h1V1h1v2H5v1H4v1H3v1h1v1h1v1h1v2H5V9H4V8H3V7H2zm6 4H7V8h1V6h1V4h1V2h1V1h1v2h-1v2h-1v2H9v2H8z"/><path fill="currentColor" d="M23 5v17h-1v1H2v-1H1V9h1v1h1v11h18V6h-2V4h3v1z"/>'
    },
    "code-block-solid": {
      body: '<path fill="currentColor" d="M18 4v3h-1v1h-1v1h-1v1h-2V8h1V7h1V6h1V5h-1V4h-1V3h-1V1h2v1h1v1h1v1zm-6-3v2h-1v2h-1v3H9v2H7V8h1V6h1V3h1V1zM2 7H1V4h1V3h1V2h1V1h2v2H5v1H4v1H3v1h1v1h1v1h1v2H4V9H3V8H2z"/><path fill="currentColor" d="M23 5v17h-1v1H2v-1H1V9h1v1h1v1h1v9h16V7h-1V4h3v1z"/>'
    },
    "code-solid": {
      body: '<path fill="currentColor" d="M15 4h1v2h-1v3h-1v3h-1v2h-1v3h-1v3h-1v1H9v-1H8v-2h1v-3h1v-3h1v-2h1V7h1V4h1V3h1zm8 7v2h-1v1h-1v1h-1v1h-1v1h-2v-2h1v-1h1v-1h1v-2h-1v-1h-1V9h-1V7h2v1h1v1h1v1h1v1zM7 7v2H6v1H5v1H4v2h1v1h1v1h1v2H5v-1H4v-1H3v-1H2v-1H1v-2h1v-1h1V9h1V8h1V7z"/>'
    },
    cog: {
      body: '<path fill="currentColor" d="M21 10V9h-1V7h1V5h-1V4h-1V3h-2v1h-2V3h-1V1h-4v2H9v1H7V3H5v1H4v1H3v2h1v2H3v1H1v4h2v1h1v2H3v2h1v1h1v1h2v-1h2v1h1v2h4v-2h1v-1h2v1h2v-1h1v-1h1v-2h-1v-2h1v-1h2v-4zm0 3h-1v1h-1v1h-1v2h1v2h-2v-1h-2v1h-1v1h-1v1h-2v-1h-1v-1H9v-1H7v1H5v-2h1v-2H5v-1H4v-1H3v-2h1v-1h1V9h1V7H5V5h2v1h2V5h1V4h1V3h2v1h1v1h1v1h2V5h2v2h-1v2h1v1h1v1h1z"/><path fill="currentColor" d="M16 10V9h-1V8h-1V7h-4v1H9v1H8v1H7v4h1v1h1v1h1v1h4v-1h1v-1h1v-1h1v-4zm-1 4h-1v1h-4v-1H9v-4h1V9h4v1h1z"/>'
    },
    "cog-solid": {
      body: '<path fill="currentColor" d="M21 10V9h-1V7h1V5h-1V4h-1V3h-2v1h-2V3h-1V1h-4v2H9v1H7V3H5v1H4v1H3v2h1v2H3v1H1v4h2v1h1v2H3v2h1v1h1v1h2v-1h2v1h1v2h4v-2h1v-1h2v1h2v-1h1v-1h1v-2h-1v-2h1v-1h2v-4zm-11 0V9h4v1h1v4h-1v1h-4v-1H9v-4z"/>'
    },
    coin: {
      body: '<path fill="currentColor" d="M17 9V8h-2V7H9v1H7v1H6v2h1v1h2v1h6v-1h2v-1h1V9Zm-2 2H9V9h6Z"/><path fill="currentColor" d="M21 8V7h-1V6h-2V5h-2V4H8v1H6v1H4v1H3v1H1v8h2v1h1v1h2v1h3v1h6v-1h3v-1h2v-1h1v-1h2V8ZM6 16H4v-1H3v-2h1v1h2Zm5 2H8v-2h3Zm5 0h-3v-2h3Zm5-3h-1v1h-2v-2h2v-1h1Zm0-4h-1v1h-2v1h-2v1H8v-1H6v-1H4v-1H3V9h1V8h2V7h2V6h8v1h2v1h2v1h1Z"/>'
    },
    "coin-solid": {
      body: '<path fill="currentColor" d="M21 8V7h-1V6h-2V5h-2V4H8v1H6v1H4v1H3v1H1v8h2v1h1v1h2v1h2v1h8v-1h2v-1h2v-1h1v-1h2V8ZM6 16H4v-1H3v-2h1v1h2Zm5 2H8v-2h3Zm5 0h-3v-2h3Zm1-7v1h-2v1H9v-1H7v-1H6V9h1V8h2V7h6v1h2v1h1v2Zm4 4h-1v1h-2v-2h2v-1h1Z"/><path fill="currentColor" d="M9 9h6v2H9z"/>'
    },
    coins: {
      body: '<path fill="currentColor" d="M23 4v11h-1v1h-3v-2h2v-2h-2v-2h2V8h-3V6h2V4h-2V3h-7v1H9v1H7V3h2V2h2V1h7v1h2v1h2v1z"/><path fill="currentColor" d="M15 8V7h-3V6H6v1H3v1H1v13h2v1h3v1h6v-1h3v-1h2V8ZM3 9h3V8h6v1h3v2h-3v1H6v-1H3Zm12 11h-3v1H6v-1H3v-3h3v1h6v-1h3Zm-3-5v1H6v-1H3v-2h3v1h6v-1h3v2Z"/>'
    },
    "coins-solid": {
      body: '<path fill="currentColor" d="M16 10h1v2h-1v1h-1v1h-3v1H6v-1H3v-1H2v-1H1v-2h1V9h1V8h3V7h6v1h3v1h1zm1 5v2h-2v1h-3v1H6v-1H3v-1H1v-2h2v1h3v1h6v-1h3v-1zm0 4v2h-2v1h-3v1H6v-1H3v-1H1v-2h2v1h3v1h6v-1h3v-1zm5-6h1v1h-1zm0-4h1v1h-1zm1-5v2h-1v1h-1v1h-3V7h-2V6h-4V5H6V4h1V3h1V2h3V1h7v1h3v1h1v1zm-1 10v1h-1v1h-2v-2zm0-4v1h-1v1h-2v-2z"/>'
    },
    collapse: {
      body: '<path fill="currentColor" d="M9 1v7H8v1H1V7h6V1zM8 16h1v7H7v-6H1v-2h7zm15-9v2h-7V8h-1V1h2v6zm0 8v2h-6v6h-2v-7h1v-1z"/>'
    },
    "collapse-solid": {
      body: '<path fill="currentColor" d="M23 6v3h-7V8h-1V1h3v5zm0 9v3h-5v5h-3v-7h1v-1zM8 16h1v7H6v-5H1v-3h7zM9 1v7H8v1H1V6h5V1z"/>'
    },
    command: {
      body: '<path fill="currentColor" d="M20 10V9h2V7h1V4h-1V2h-2V1h-3v1h-2v2h-1v4h-4V4H9V2H7V1H4v1H2v2H1v3h1v2h2v1h4v4H4v1H2v2H1v3h1v2h2v1h3v-1h2v-2h1v-4h4v4h1v2h2v1h3v-1h2v-2h1v-3h-1v-2h-2v-1h-4v-4Zm-4-6h1V3h3v1h1v3h-1v1h-3V7h-1ZM8 20H7v1H4v-1H3v-3h1v-1h3v1h1ZM8 7H7v1H4V7H3V4h1V3h3v1h1Zm2 7v-4h4v4Zm11 3v3h-1v1h-3v-1h-1v-3h1v-1h3v1Z"/>'
    },
    "command-solid": {
      body: '<path fill="currentColor" d="M22 4V2h-2V1h-3v1h-2v2h-1v3h-4V4H9V2H7V1H4v1H2v2H1v3h1v2h2v1h3v4H4v1H2v2H1v3h1v2h2v1h3v-1h2v-2h1v-3h4v3h1v2h2v1h3v-1h2v-2h1v-3h-1v-2h-2v-1h-3v-4h3V9h2V7h1V4ZM7 20H4v-3h3ZM4 7V4h3v3Zm10 7h-4v-4h4Zm6 3v3h-3v-3ZM17 7V4h3v3Z"/>'
    },
    comment: {
      body: '<path fill="currentColor" d="M22 8V6h-1V5h-1V4h-2V3h-3V2H9v1H6v1H4v1H3v1H2v2H1v6h1v2h1v2H2v1H1v2h5v-1h1v-1h2v1h6v-1h3v-1h2v-1h1v-1h1v-2h1V8zm-2 6v2h-2v1h-3v1H9v-1H7v1H6v1H4v-1h1v-2H4v-2H3V8h1V6h2V5h3V4h6v1h3v1h2v2h1v6z"/>'
    },
    "comment-dots": {
      body: '<path fill="currentColor" d="M19 10v2h-1v1h-2v-1h-1v-2h1V9h2v1zm-5 0v2h-1v1h-2v-1h-1v-2h1V9h2v1zm-5 0v2H8v1H6v-1H5v-2h1V9h2v1z"/><path fill="currentColor" d="M22 8V6h-1V5h-1V4h-2V3h-3V2H9v1H6v1H4v1H3v1H2v2H1v6h1v2h1v2H2v1H1v2h5v-1h1v-1h2v1h6v-1h3v-1h2v-1h1v-1h1v-2h1V8zm-1 6h-1v2h-2v1h-3v1H9v-1H7v1H6v1H4v-1h1v-2H4v-2H3V8h1V6h2V5h3V4h6v1h3v1h2v2h1z"/>'
    },
    "comment-dots-solid": {
      body: '<path fill="currentColor" d="M22 8V6h-1V5h-1V4h-2V3h-3V2H9v1H6v1H4v1H3v1H2v2H1v6h1v2h1v2H2v1H1v2h5v-1h1v-1h2v1h6v-1h3v-1h2v-1h1v-1h1v-2h1V8zm-6 5v-1h-1v-2h1V9h2v1h1v2h-1v1zm-6-1v-2h1V9h2v1h1v2h-1v1h-2v-1zM8 9v1h1v2H8v1H6v-1H5v-2h1V9z"/>'
    },
    "comment-quote": {
      body: '<path fill="currentColor" d="M17 7v8h-1v1h-3v-1h1v-1h1v-2h-2V7zm-6 0v8h-1v1H7v-1h1v-1h1v-2H7V7z"/><path fill="currentColor" d="M22 8V6h-1V5h-1V4h-2V3h-3V2H9v1H6v1H4v1H3v1H2v2H1v6h1v2h1v2H2v1H1v2h5v-1h1v-1h2v1h6v-1h3v-1h2v-1h1v-1h1v-2h1V8zm-2 6v2h-2v1h-3v1H9v-1H7v1H6v1H4v-1h1v-2H4v-2H3V8h1V6h2V5h3V4h6v1h3v1h2v2h1v6z"/>'
    },
    "comment-quote-solid": {
      body: '<path fill="currentColor" d="M22 8V6h-1V5h-1V4h-2V3h-3V2H9v1H6v1H4v1H3v1H2v2H1v6h1v2h1v2H2v1H1v2h5v-1h1v-1h2v1h6v-1h3v-1h2v-1h1v-1h1v-2h1V8zM7 15h1v-1h1v-2H7V7h4v8h-1v1H7zm6 0h1v-1h1v-2h-2V7h4v8h-1v1h-3z"/>'
    },
    "comment-solid": {
      body: '<path fill="currentColor" d="M23 8v6h-1v2h-1v1h-1v1h-2v1h-3v1H9v-1H7v1H6v1H1v-2h1v-1h1v-2H2v-2H1V8h1V6h1V5h1V4h2V3h3V2h6v1h3v1h2v1h1v1h1v2z"/>'
    },
    comments: {
      body: '<path fill="currentColor" d="M23 16v-5h-1V9h-2V8h-2V7h-3V5h-2V4h-2V3H6v1H4v1H2v2H1v5h1v2H1v4h3v-1h1v-1h4v2h2v1h2v1h6v1h1v1h3v-4h-1v-2zM5 14v1H4v1H3v-2h1v-2H3V7h1V6h2V5h5v1h2v1h1v5h-1v1h-2v1zm16 2h-1v2h1v2h-1v-1h-1v-1h-6v-1h-2v-2h2v-1h2v-2h1V9h2v1h2v1h1z"/>'
    },
    "comments-solid": {
      body: '<path fill="currentColor" d="M5 16v1H4v1H1v-4h1v-2H1V7h1V5h2V4h2V3h5v1h2v1h2v2h1v5h-1v2h-2v1h-2v1z"/><path fill="currentColor" d="M23 11v5h-1v2h1v4h-3v-1h-1v-1h-6v-1h-2v-1H9v-1h3v-1h2v-1h2v-2h1V7h1v1h2v1h2v2z"/>'
    },
    copy: {
      body: '<path fill="currentColor" d="M16 20v2h-1v1H3v-1H2V6h1V5h3v15z"/><path fill="currentColor" d="M16 7V1H8v1H7v16h1v1h13v-1h1V7zm4 10H9V3h5v6h6z"/><path fill="currentColor" d="M22 5v1h-5V1h1v1h1v1h1v1h1v1z"/>'
    },
    "copy-solid": {
      body: '<path fill="currentColor" d="M16 20v2h-1v1H3v-1H2V6h1V5h3v15z"/><path fill="currentColor" d="M22 7v11h-1v1H8v-1H7V2h1V1h8v6z"/><path fill="currentColor" d="M22 5v1h-5V1h1v1h1v1h1v1h1v1z"/>'
    },
    "creative-commons": {
      body: '<path fill="currentColor" d="M15 11v2h1v1h2v2h-3v-1h-1v-1h-1v-4h1V9h1V8h3v2h-2v1zm-4-3v2H9v1H8v2h1v1h2v2H8v-1H7v-1H6v-4h1V9h1V8z"/><path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9Zm-1 6h-1v2h-1v1h-1v1h-1v1h-2v1H9v-1H7v-1H6v-1H5v-1H4v-2H3V9h1V7h1V6h1V5h1V4h2V3h6v1h2v1h1v1h1v1h1v2h1Z"/>'
    },
    "credit-card": {
      body: '<path fill="currentColor" d="M22 5V4H2v1H1v14h1v1h20v-1h1V5zm-1 13H3v-7h18zm0-10H3V6h18z"/><path fill="currentColor" d="M4 15h4v1H4zm6 0h6v1h-6z"/>'
    },
    "credit-card-solid": {
      body: '<path fill="currentColor" d="M1 11v8h1v1h20v-1h1v-8zm3 4h4v1H4zm6 0h6v1h-6zM23 5v3H1V5h1V4h20v1z"/>'
    },
    crown: {
      body: '<path fill="currentColor" d="M22 7V6h-2v1h-1v2h1v1h-1v1h-1v1h-2v-1h-1V9h-1V7h-1V6h1V4h-1V3h-2v1h-1v2h1v1h-1v2H9v2H8v1H6v-1H5v-1H4V9h1V7H4V6H2v1H1v2h1v1h1v4h1v3h1v2h1v2h12v-2h1v-2h1v-3h1v-4h1V9h1V7zm-4 7v3h-1v2H7v-2H6v-3H5v-1h1v1h2v-1h1v-1h1v-1h1V9h2v2h1v1h1v1h1v1zv-1h1v1z"/>'
    },
    "crown-solid": {
      body: '<path fill="currentColor" d="M23 7v2h-1v1h-1v4h-1v3h-1v2h-1v2H6v-2H5v-2H4v-3H3v-4H2V9H1V7h1V6h2v1h1v2H4v1h1v1h1v1h2v-1h1V9h1V7h1V6h-1V4h1V3h2v1h1v2h-1v1h1v2h1v2h1v1h2v-1h1v-1h1V9h-1V7h1V6h2v1z"/>'
    },
    crunchbase: {
      body: '<path fill="currentColor" d="M22 2V1H2v1H1v20h1v1h20v-1h1V2zM5 10h5v1h1v2H9v-1H6v3h3v-1h2v2h-1v1H5v-1H4v-5h1zm14 7h-4v-1h-1v1h-1V7h2v3h4v1h1v5h-1z"/><path fill="currentColor" d="M15 12h3v3h-3z"/>'
    },
    cybersecurity: {
      body: '<path fill="currentColor" d="M22 2h-1v1h1zm-1 1h-1v1h1zm-1 1h-4v1h4zm-4-1h-2v1h2zm-2-1h-1v1h1zm-1-1h-2v1h2zm-2 1h-1v1h1zm-1 1H8v1h2zM8 4H4v1h4zM4 3H3v1h1zM3 2H2v1h1zm0 12H2v2h1zm1 2H3v2h1zm1 2H4v1h1zm2 1H5v1h2zm2 1H7v1h2zm2 1H9v1h2zm2 1h-2v1h2zm2-1h-2v1h2zm2-1h-2v1h2zm2-1h-2v1h2zm1-1h-1v1h1zm1-2h-1v2h1zm1-2h-1v2h1zm1-11h-1v11h1zM2 3H1v11h1z"/><path fill="currentColor" d="M20 5v1h-4V5h-2V4h-1V3h-2v1h-1v1H8v1H4V5H3v9h1v2h1v2h2v1h2v1h2v1h2v-1h2v-1h2v-1h2v-2h1v-2h1V5zM10 17v-2h1v-3h-1V9h1V8h2v1h1v3h-1v3h1v2z"/>'
    },
    "data-science": {
      body: '<path fill="currentColor" d="M23.505 22.505v1h-3v-1h1v-1h1v1zm-4.001 0v1h-3v-1h1v-1h1v1zm-4.001 0v1h-2v-2h1v1zm-4.001-1.001v2h-2v-1h1v-1zm-3 1.001v1H5.5v-1h1v-1h1v1zm-4.002 0v1h-3v-1h1v-1h1v1zm18.005-5.002v3.001h-1v-2h-3.001v2h-1v-2h-3.001v2h-1v-2h-2v2h-1v-2H7.5v2h-1v-2h-3v2h-1v-3zm-3.001-6.001v1h-1v1H6.5v-1h-1v-1h-1v3.001h1v1h1v1h12.003v-1h1v-1h1v-3zM9.502 15.503v-1h6.001v1z"/><path fill="currentColor" d="M19.504 7.501v1h-1v1H6.5v-1h-1v-1h-1v3.001h1v1h1v1h12.003v-1h1v-1h1v-3zM9.502 11.502v-1h6.001v1z"/><path fill="currentColor" d="M19.504 3.5v-1h-1v-1H6.5v1h-1v1h-1v3.001h1v1h1v1h12.003v-1h1v-1h1v-3zm-12.003 0v1h10.003v-1h1v1h-1v1H7.5v-1h-1v-1zm2 4.001v-1h6.002v1z"/>'
    },
    digg: {
      body: '<path fill="currentColor" d="M8 5h2v2H8zM5 5v3H2v8h5V5zm0 9H4v-4h1zm3-6h2v8H8zm3 0v8h3v1h-3v2h5V8zm2 2h1v4h-1zm4-2v8h3v1h-3v2h5V8zm2 2h1v4h-1z"/>'
    },
    disc: {
      body: '<path fill="currentColor" d="M15 10V9h-1V8h-4v1H9v1H8v4h1v1h1v1h4v-1h1v-1h1v-4Zm-1 3h-1v1h-2v-1h-1v-2h1v-1h2v1h1Z"/><path fill="currentColor" d="M12 4v2H9v1H8v1H7v1H6v3H4v-2h1V8h1V7h1V6h1V5h2V4z"/><path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9Zm-1 6h-1v2h-1v1h-1v1h-1v1h-2v1H9v-1H7v-1H6v-1H5v-1H4v-2H3V9h1V7h1V6h1V5h1V4h2V3h6v1h2v1h1v1h1v1h1v2h1Z"/>'
    },
    "disc-solid": {
      body: '<path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9Zm-7 0v1h1v4h-1v1h-1v1h-4v-1H9v-1H8v-4h1V9h1V8h4v1ZM3 9h1V7h1V6h1V5h1V4h2V3h3v3H9v1H8v1H7v1H6v3H3Z"/><path fill="currentColor" d="M14 11v2h-1v1h-2v-1h-1v-2h1v-1h2v1z"/>'
    },
    discord: {
      body: '<path fill="currentColor" d="M22 11V8h-1V6h-1V5h-2V4h-3v1H9V4H6v1H4v1H3v2H2v3H1v7h2v1h2v1h2v-2H6v-1h2v1h1v1h6v-1h1v-1h2v1h-1v2h2v-1h2v-1h2v-7ZM9 15H7v-1H6v-2h1v-1h2v1h1v2H9Zm9-1h-1v1h-2v-1h-1v-2h1v-1h2v1h1Z"/>'
    },
    discourse: {
      body: '<path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v14h14v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9zm-5-1v1h1v6h-1v1h-1v1h-1v1h-5v-1H9v1H7v1H5v-1h1v-2h1v-1H6V9h1V8h1V7h1V6h6v1h1v1z"/>'
    },
    divider: {
      body: '<path fill="currentColor" d="M3 6h18v1H3zm-2 5h22v2H1zm2 6h18v1H3z"/>'
    },
    "divider-solid": {
      body: '<path fill="currentColor" d="M4 7H3V6h1V5h16v1h1v1h-1v1H4zm16 10h1v1h-1v1H4v-1H3v-1h1v-1h16zM1 11h22v2H1z"/><path fill="none" d="M0 0h24v24H0z"/>'
    },
    dollar: {
      body: '<path fill="currentColor" d="M17 12v-1h-4V6h4V4h-4V1h-2v3H7v1H6v7h1v1h4v5H6v2h5v3h2v-3h4v-1h1v-7Zm-6-1H9v-1H8V7h1V6h2Zm4 6v1h-2v-5h2v1h1v3Z"/>'
    },
    "dollar-solid": {
      body: '<path fill="currentColor" d="M17 12v-1h-1v-1h-3V6h3V5h1V4h-1V3h-3V1h-2v2H8v1H7v1H6v6h1v1h1v1h3v5H7v1H6v1h1v1h4v2h2v-2h3v-1h1v-1h1v-7Zm-6-2h-1V9H9V7h1V6h1Zm4 7h-1v1h-1v-5h1v1h1Z"/>'
    },
    "door-closed": {
      body: '<path fill="currentColor" d="M20 21V2h-1V1H5v1H4v19H2v2h20v-2Zm-2 0H6V3h12Z"/><path fill="currentColor" d="M17 11v2h-1v1h-2v-1h-1v-2h1v-1h2v1z"/>'
    },
    "door-closed-solid": {
      body: '<path fill="currentColor" d="M20 21V2h-1V1H5v1H4v19H2v2h20v-2Zm-4-7h-2v-1h-1v-2h1v-1h2v1h1v2h-1Z"/>'
    },
    "door-open": {
      body: '<path fill="currentColor" d="M20 21V2h-1V1H5v1H4v19H2v2h13v-1h1V3h2v19h1v1h3v-2Zm-6 0H6V3h8Z"/><path fill="currentColor" d="M13 11v2h-1v1h-2v-1H9v-2h1v-1h2v1z"/>'
    },
    "door-open-solid": {
      body: '<path fill="currentColor" d="M20 21V2h-1V1H5v1H4v19H2v2h13v-1h1V3h2v19h1v1h3v-2Zm-8-7h-2v-1H9v-2h1v-1h2v1h1v2h-1Z"/>'
    },
    download: {
      body: '<path fill="currentColor" d="M5 10H4V8h2v1h1v1h1v1h1v1h1v1h1V1h2v12h1v-1h1v-1h1v-1h1V9h1V8h2v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1h-1v-1H9v-1H8v-1H7v-1H6v-1H5zM2 21h20v2H2z"/>'
    },
    "download-alt": {
      body: '<path fill="currentColor" d="M22 16v-1h-6v-1h1v-1h1v-1h1v-1h-4V2h-1V1h-4v1H9v9H5v1h1v1h1v1h1v1H2v1H1v6h1v1h20v-1h1v-6zm-1 5H3v-4h7v1h1v1h2v-1h1v-1h7zM9 12h2V3h2v9h2v1h-1v1h-1v1h-2v-1h-1v-1H9z"/><path fill="currentColor" d="M19 19h1v1h-1zm-2 0h1v1h-1z"/>'
    },
    "download-alt-solid": {
      body: '<path fill="currentColor" d="M6 12H5v-1h4V2h1V1h4v1h1v9h4v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1h-1v-1H9v-1H8v-1H7v-1H6z"/><path fill="currentColor" d="M22 16v-1h-5v1h-1v1h-1v1h-1v1h-4v-1H9v-1H8v-1H7v-1H2v1H1v6h1v1h20v-1h1v-6zm-2 4h-1v-1h1zm-2-1v1h-1v-1z"/>'
    },
    "download-solid": {
      body: '<path fill="currentColor" d="M2 20h20v3H2zM20 8v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1h-1v-1H9v-1H8v-1H7v-1H6v-1H5v-1H4V8h1V7h2v1h1v1h1v1h1V1h4v9h1V9h1V8h1V7h2v1z"/>'
    },
    edit: {
      body: '<path fill="currentColor" d="M22 4v3h-1v1h-1V7h-1V6h2V5h-1V4h-1v2h-1V5h-1V4h1V3h3v1zm-4 10v7h-1v1H2v-1H1V6h1V5h12v1h-1v1H3v13h13v-5h1v-1z"/><path fill="currentColor" d="M18 8V7h-1V6h-2v1h-1v1h-1v1h-1v1h-1v1h-1v1H9v1H8v1H7v4h4v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1V8zm-1 2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H8v-2h1v-1h1v-1h1v-1h1v-1h1v-1h1V9h1V8h2z"/>'
    },
    "edit-solid": {
      body: '<path fill="currentColor" d="M22 4v3h-1v1h-1V7h-1V6h-1V5h-1V4h1V3h3v1zm-5 10h1v7h-1v1H2v-1H1V6h1V5h12v1h-1v1H3v13h13v-5h1z"/><path fill="currentColor" d="M18 8h1v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H7v-4h1v-1h1v-1h1v-1h1v-1h1V9h1V8h1V7h1V6h2v1h1z"/>'
    },
    "ellipses-horizontal": {
      body: '<path fill="currentColor" d="M6 10H5V9H3v1H2v1H1v2h1v1h1v1h2v-1h1v-1h1v-2H6zm-1 3H3v-2h2zm9-3h-1V9h-2v1h-1v1H9v2h1v1h1v1h2v-1h1v-1h1v-2h-1zm-1 3h-2v-2h2zm9-2v-1h-1V9h-2v1h-1v1h-1v2h1v1h1v1h2v-1h1v-1h1v-2zm-3 2v-2h2v2z"/>'
    },
    "ellipses-horizontal-circle": {
      body: '<path fill="currentColor" d="M14 11v2h-1v1h-2v-1h-1v-2h1v-1h2v1zm5 0v2h-1v1h-2v-1h-1v-2h1v-1h2v1zM9 11v2H8v1H6v-1H5v-2h1v-1h2v1z"/><path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9zm-2 6v2h-1v2h-2v1h-2v1H9v-1H7v-1H5v-2H4v-2H3V9h1V7h1V5h2V4h2V3h6v1h2v1h2v2h1v2h1v6z"/>'
    },
    "ellipses-horizontal-circle-solid": {
      body: '<path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9zm-9 1v1h1v2h-1v1h-2v-1h-1v-2h1v-1zm-8 1h1v-1h2v1h1v2H8v1H6v-1H5zm14 2h-1v1h-2v-1h-1v-2h1v-1h2v1h1z"/>'
    },
    "ellipses-horizontal-solid": {
      body: '<path fill="currentColor" d="M14 11h1v2h-1v1h-1v1h-2v-1h-1v-1H9v-2h1v-1h1V9h2v1h1zm-8 0h1v2H6v1H5v1H3v-1H2v-1H1v-2h1v-1h1V9h2v1h1zm17 0v2h-1v1h-1v1h-2v-1h-1v-1h-1v-2h1v-1h1V9h2v1h1v1z"/>'
    },
    "ellipses-vertical": {
      body: '<path fill="currentColor" d="M14 18h-1v-1h-2v1h-1v1H9v2h1v1h1v1h2v-1h1v-1h1v-2h-1zm-1 3h-2v-2h2zm1-11h-1V9h-2v1h-1v1H9v2h1v1h1v1h2v-1h1v-1h1v-2h-1zm-1 3h-2v-2h2zm1-10V2h-1V1h-2v1h-1v1H9v2h1v1h1v1h2V6h1V5h1V3zm-3 2V3h2v2z"/>'
    },
    "ellipses-vertical-circle": {
      body: '<path fill="currentColor" d="M11 10h2v1h1v2h-1v1h-2v-1h-1v-2h1zm0-5h2v1h1v2h-1v1h-2V8h-1V6h1zm0 10h2v1h1v2h-1v1h-2v-1h-1v-2h1z"/><path fill="currentColor" d="M9 2H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9h-1V7h-1V5h-1V4h-1V3h-2V2h-2V1H9zm6 2h2v1h2v2h1v2h1v6h-1v2h-1v2h-2v1h-2v1H9v-1H7v-1H5v-2H4v-2H3V9h1V7h1V5h2V4h2V3h6z"/>'
    },
    "ellipses-vertical-circle-solid": {
      body: '<path fill="currentColor" d="M9 2H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9h-1V7h-1V5h-1V4h-1V3h-2V2h-2V1H9zm1 9h1v-1h2v1h1v2h-1v1h-2v-1h-1zm1 8v-1h-1v-2h1v-1h2v1h1v2h-1v1zm2-14v1h1v2h-1v1h-2V8h-1V6h1V5z"/>'
    },
    "ellipses-vertical-solid": {
      body: '<path fill="currentColor" d="M15 3v2h-1v1h-1v1h-2V6h-1V5H9V3h1V2h1V1h2v1h1v1zm-1 8h1v2h-1v1h-1v1h-2v-1h-1v-1H9v-2h1v-1h1V9h2v1h1zm0 8h1v2h-1v1h-1v1h-2v-1h-1v-1H9v-2h1v-1h1v-1h2v1h1z"/>'
    },
    envelope: {
      body: '<path fill="currentColor" d="M21 5V4H3v1H1v14h1v1h20v-1h1V5zm-11 7v-1H9v-1H8V9H7V8H6V7H5V6h14v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1zM4 7v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h2v-1h1v-1h1v-1h1v-1h1v-1h1V9h1V8h1V7h1v11H3V7z"/>'
    },
    "envelope-solid": {
      body: '<path fill="currentColor" d="M21 4v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1h-1v-1H9v-1H8V9H7V8H6V7H5V6H4V5H3V4z"/><path fill="currentColor" d="M23 5v14h-1v1H2v-1H1V5h2v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h2v-1h1v-1h1v-1h1v-1h1V9h1V8h1V7h1V6h1V5z"/>'
    },
    ethereum: {
      body: '<path fill="currentColor" d="M6 13v-2h1V9h1V7h1V5h1V3h1V1h2v2h1v2h1v2h1v2h1v2h1v2h-2v1h-2v1h-1v1h-2v-1h-1v-1H8v-1z"/><path fill="currentColor" d="M19 14v1h-1v1h-1v1h-1v2h-1v1h-1v1h-1v2h-2v-2h-1v-1H9v-1H8v-2H7v-1H6v-1H5v-1h2v1h2v1h1v1h4v-1h1v-1h2v-1z"/>'
    },
    exclaimation: {
      body: '<path fill="currentColor" d="M11 9h-1V1h4v8h-1v6h-2zm4 10v1h-1v1h-1v1h-2v-1h-1v-1H9v-1h1v-1h1v-1h2v1h1v1z"/>'
    },
    "exclaimation-solid": {
      body: '<path fill="currentColor" d="M16 18v3h-1v1h-1v1h-4v-1H9v-1H8v-3h1v-1h1v-1h4v1h1v1zM10 8H9V1h6v7h-1v6h-4z"/>'
    },
    "exclamation-triangle": {
      body: '<path fill="currentColor" d="M14 11v3h-1v3h-2v-3h-1v-3zm-3 7h2v2h-2z"/><path fill="currentColor" d="M22 20v-2h-1v-2h-1v-2h-1v-2h-1v-2h-1V8h-1V6h-1V4h-1V2h-1V1h-2v1h-1v2H9v2H8v2H7v2H6v2H5v2H4v2H3v2H2v2H1v2h1v1h20v-1h1v-2zM3 21v-1h1v-2h1v-2h1v-2h1v-2h1v-2h1V8h1V6h1V4h2v2h1v2h1v2h1v2h1v2h1v2h1v2h1v2h1v1z"/>'
    },
    "exclamation-triangle-solid": {
      body: '<path fill="currentColor" d="M22 20v-2h-1v-2h-1v-2h-1v-2h-1v-2h-1V8h-1V6h-1V4h-1V2h-1V1h-2v1h-1v2H9v2H8v2H7v2H6v2H5v2H4v2H3v2H2v2H1v2h1v1h20v-1h1v-2zm-12-9h4v3h-1v3h-2v-3h-1zm1 7h2v2h-2z"/>'
    },
    expand: {
      body: '<path fill="currentColor" d="M9 1v2H3v6H1V2h1V1zm0 20v2H2v-1H1v-7h2v6zm14-6v7h-1v1h-7v-2h6v-6zm0-13v7h-2V3h-6V1h7v1z"/>'
    },
    "expand-solid": {
      body: '<path fill="currentColor" d="M9 20v3H2v-1H1v-7h3v5zM9 1v3H4v5H1V2h1V1zm14 14v7h-1v1h-7v-3h5v-5zm0-13v7h-3V4h-5V1h7v1z"/>'
    },
    "external-link": {
      body: '<path fill="currentColor" d="M20 15v7h-1v1H2v-1H1V5h1V4h9v2H3v15h15v-6z"/><path fill="currentColor" d="M23 1v8h-2V5h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H9v1H7v-2h1v-1h1v-1h1v-1h1v-1h1v-1h1V9h1V8h1V7h1V6h1V5h1V4h1V3h-4V1z"/>'
    },
    "external-link-solid": {
      body: '<path fill="currentColor" d="M23 1v8h-2V8h-1V7h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H9v1H8v-1H7v-1H6v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1V9h1V8h1V7h1V6h1V5h1V4h-1V3h-1V1z"/><path fill="currentColor" d="M20 15v7h-1v1H2v-1H1V5h1V4h9v3H4v13h13v-5z"/>'
    },
    eye: {
      body: '<path fill="currentColor" d="M16 11h1v2h-1zm0 2v2h-1v1h-2v-1h1v-1h1v-1zm0-4v2h-1v-1h-1V9h-1V8h2v1zm-5 7h2v1h-2zm0-1v1H9v-1H8v-2h1v1h1v1zm2-8v1h-1v3h-1v1H8v1H7v-2h1V9h1V8h2V7z"/><path fill="currentColor" d="M22 11V9h-1V8h-1V7h-1V6h-2V5H7v1H5v1H4v1H3v1H2v2H1v2h1v2h1v1h1v1h1v1h2v1h10v-1h2v-1h1v-1h1v-1h1v-2h1v-2zm-1 3h-1v1h-1v1h-1v1h-2v1H8v-1H7v-1H5v-1H4v-1H3v-4h1V9h1V8h1V7h2V6h8v1h2v1h1v1h1v1h1z"/>'
    },
    "eye-cross": {
      body: '<path fill="currentColor" d="M15 13h1v2h-1v1h-2v-1h1v-1h1zm1-2h1v2h-1z"/><path fill="currentColor" d="M23 11v2h-1v2h-1v1h-1v1h-1v1h-2v1H9v-1h7v-1h2v-1h1v-1h1v-1h1v-4h-1V9h-1V8h2v1h1v2zM2 13H1v-2h1V9h1V8h1V7h1V6h2V5h8v1H8v1H6v1H5v1H4v1H3v4h1v1h1v1H3v-1H2z"/><path fill="currentColor" d="M13 7v1h-1v1h-1v1h-1v1H9v1H8v1H7v-2h1V9h1V8h2V7zM9 17H8v1H7v1H6v1H5v1H4v1H3v-1H2v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1V9h1V8h1V7h1V6h1V5h1V4h1V3h1V2h1v1h1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H9zm2-1h2v1h-2z"/>'
    },
    "eye-cross-solid": {
      body: '<path fill="currentColor" d="M2 13H1v-2h1V9h1V8h1V7h1V6h2V5h8v1h-1v1h-1V6h-2v1H9v1H8v1H7v2H6v2h1v1H6v1H5v1H3v-1H2z"/><path fill="currentColor" d="M8 11h1v1H8zm3-3h1v1h-1zm-2 9H8v1H7v1H6v1H5v1H4v1H3v-1H2v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1V9h1V8h1V7h1V6h1V5h1V4h1V3h1V2h1v1h1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H9zm3-2h1v1h-1zm1-1h1v1h-1zm2-2h1v1h-1zm-1 1h1v1h-1z"/><path fill="currentColor" d="M23 11v2h-1v2h-1v1h-1v1h-1v1h-2v1H9v-1h1v-1h1v1h2v-1h2v-1h1v-1h1v-2h1v-2h-1v-1h1V9h1V8h2v1h1v2z"/>'
    },
    "eye-snake": {
      body: '<path fill="currentColor" d="M14 8v2h3V9h1V4h-1V3h-1V2h-3V1h-2v1H5v1H4v2h1v1h3V5h1V4h2v10H8v-3h1v-1h1V8H8v1H7v1H6v5h1v1h4v3H8v2h3v2h2v-7h3v2h-1v1h-1v2h2v-1h1v-1h1v-4h-1v-1h-4V4h2v1h1v3ZM6 4V3h1v1Z"/>'
    },
    "eye-snake-solid": {
      body: '<path fill="currentColor" d="M18 4V3h-1V2h-4V1h-2v1H5v1H4v3h1v1h3V6h1V5h2v8H9v-2h1V8H8v1H7v1H6v4h1v1h1v1h3v2H9v1H8v1h1v1h2v2h2v-7h1v1h1v1h-1v3h2v-1h1v-1h1v-4h-1v-1h-1v-1h-3V5h2v1h1v1h-1v1h-1v3h3v-1h1V9h1V4ZM7 5H6V4h1Z"/>'
    },
    "eye-solid": {
      body: '<path fill="currentColor" d="M16 11v2h-1v1h-1v1h-1v1h-2v-1h-1v-1H9v-1H8v-2h2v-1h1V8h2v1h1v1h1v1z"/><path fill="currentColor" d="M22 11V9h-1V8h-1V7h-1V6h-2V5H7v1H5v1H4v1H3v1H2v2H1v2h1v2h1v1h1v1h1v1h2v1h10v-1h2v-1h1v-1h1v-1h1v-2h1v-2zm-4 2h-1v2h-1v1h-1v1h-2v1h-2v-1H9v-1H8v-1H7v-2H6v-2h1V9h1V8h1V7h2V6h2v1h2v1h1v1h1v2h1z"/>'
    },
    "face-angry": {
      body: '<path fill="currentColor" d="M16 16v2h-2v-1h-4v1H8v-2h1v-1h6v1zm-5-6v1h-1v2H8v-3H6V8h2v1h2v1zm7-2v2h-2v3h-2v-2h-1v-1h1V9h2V8z"/><path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9Zm-1 6h-1v2h-1v1h-1v1h-1v1h-2v1H9v-1H7v-1H6v-1H5v-1H4v-2H3V9h1V7h1V6h1V5h1V4h2V3h6v1h2v1h1v1h1v1h1v2h1Z"/>'
    },
    "face-angry-solid": {
      body: '<path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9ZM6 10V8h2v1h2v1h1v1h-1v2H8v-3Zm10 8h-2v-1h-4v1H8v-2h1v-1h6v1h1Zm2-8h-2v3h-2v-2h-1v-1h1V9h2V8h2Z"/>'
    },
    "face-grin": {
      body: '<path fill="currentColor" d="M16 14v1H8v-1H6v3h1v1h1v1h8v-1h1v-1h1v-3Zm-1 3v1h-5v-1h1v-1h5v1Z"/><path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9Zm-1 6h-1v2h-1v1h-1v1h-1v1h-2v1H9v-1H7v-1H6v-1H5v-1H4v-2H3V9h1V7h1V6h1V5h1V4h2V3h6v1h2v1h1v1h1v1h1v2h1Z"/><path fill="currentColor" d="M7 8h3v3H7zm7 0h3v3h-3z"/>'
    },
    "face-grin-solid": {
      body: '<path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9Zm-8-1h3v3h-3ZM7 8h3v3H7Zm11 9h-1v1h-1v1H8v-1H7v-1H6v-3h2v1h8v-1h2Z"/><path fill="currentColor" d="M16 16v1h-1v1h-5v-1h1v-1z"/>'
    },
    "face-heart-eyes": {
      body: '<path fill="currentColor" d="M4 5V4h1V3h2V2h2V1h6v1h2v1h2v1h1v1h-3V4h-2V3H9v1H7v1zm7 2v3h-1v1H9v1H8v1H7v-1H6v-1H5v-1H4V7h1V6h2v1h1V6h2v1zm-1 12v-1H8v-1H7v-1H6v-2h3v1h6v-1h3v2h-1v1h-1v1h-2v1z"/><path fill="currentColor" d="M23 9v6h-1v2h-1v2h-1v1h-1v1h-2v1h-2v1H9v-1H7v-1H5v-1H4v-1H3v-2H2v-2H1V9h2v6h1v2h1v1h1v1h1v1h2v1h6v-1h2v-1h1v-1h1v-1h1v-2h1V9z"/><path fill="currentColor" d="M18 12h-1v1h-1v-1h-1v-1h-1v-1h-1V7h1V6h2v1h1V6h2v1h1v3h-1v1h-1z"/>'
    },
    "face-heart-eyes-solid": {
      body: '<path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9ZM4 10V7h1V6h2v1h1V6h2v1h1v3h-1v1H9v1H8v1H7v-1H6v-1H5v-1Zm14 6h-1v1h-1v1h-2v1h-4v-1H8v-1H7v-1H6v-2h3v1h6v-1h3Zm2-6h-1v1h-1v1h-1v1h-1v-1h-1v-1h-1v-1h-1V7h1V6h2v1h1V6h2v1h1Z"/>'
    },
    "face-laugh-squint": {
      body: '<path fill="currentColor" d="M16 9v1h1v1h1v1h-3v-1h-1v-1h-1V9h1V8h1V7h3v1h-1v1zm2 5v2h-1v1h-1v1h-1v1H9v-1H8v-1H7v-1H6v-2zm-7-5v1h-1v1H9v1H6v-1h1v-1h1V9H7V8H6V7h3v1h1v1z"/><path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9Zm-1 6h-1v2h-1v1h-1v1h-1v1h-2v1H9v-1H7v-1H6v-1H5v-1H4v-2H3V9h1V7h1V6h1V5h1V4h2V3h6v1h2v1h1v1h1v1h1v2h1Z"/>'
    },
    "face-laugh-squint-solid": {
      body: '<path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9Zm-5 1v1h1v1h-3v-1h-1v-1h-1V9h1V8h1V7h3v1h-1v1h-1v1ZM7 9V8H6V7h3v1h1v1h1v1h-1v1H9v1H6v-1h1v-1h1V9Zm10 7v1h-1v1h-1v1H9v-1H8v-1H7v-1H6v-2h12v2Z"/>'
    },
    "face-sad": {
      body: '<path fill="currentColor" d="M14 8h3v3h-3z"/><path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9Zm-1 6h-1v2h-1v1h-1v1h-1v1h-2v1H9v-1H7v-1H6v-1H5v-1H4v-2H3V9h1V7h1V6h1V5h1V4h2V3h6v1h2v1h1v1h1v1h1v2h1Z"/><path fill="currentColor" d="M7 8h3v3H7zm10 8v1h-1v1h-1v-1h-1v-1h-4v1H9v1H8v-1H7v-1h1v-1h1v-1h6v1h1v1z"/>'
    },
    "face-sad-solid": {
      body: '<path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9Zm-6 9h-1v-1h-1v-1h-4v1H9v1H8v-1H7v-1h1v-1h1v-1h6v1h1v1h1v1h-1ZM10 8v3H7V8Zm4 0h3v3h-3Z"/>'
    },
    "face-thinking": {
      body: '<path fill="currentColor" d="M12 7h1v1h-2V7h-1V6H8v1H6V6h1V5h4v1h1zm1 6v1h-3v-1H8v-1h3v1zM8 8h2v2H8zm6 1h2v2h-2zm5-1v2h-1V9h-1V8h-2V7h3v1zm-5 7v2h-1v1h-2v2h-1v2H9v1H5v-1H4v-6h1v-1h1v3h2v-1h2v-1h2v-1z"/><path fill="currentColor" d="M23 9v6h-1v2h-1v2h-1v1h-1v1h-2v1h-2v1h-4v-2h4v-1h2v-1h1v-1h1v-1h1v-2h1V9h-1V7h-1V6h-1V5h-1V4h-2V3H9v1H7v1H6v1H5v1H4v2H3v5h1v1H3v1H2v-1H1V9h1V7h1V5h1V4h1V3h2V2h2V1h6v1h2v1h2v1h1v1h1v2h1v2z"/>'
    },
    "face-thinking-solid": {
      body: '<path fill="currentColor" d="M11 20h-1v2H9v1H5v-1H4v-6h1v-1h1v3h2v-1h2v-1h2v-1h2v2h-1v1h-2z"/><path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v1h1v-1h1v-1h3v2h2v-1h2v-1h-1v-1H8v-1h3v1h2v1h2v4h-1v1h-2v2h-1v2h4v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9zm-7-2h3v1h1v2h-1V9h-1V8h-2zm-1 2h2v2h-2zm-4 1H8V8h2zm1-2V7h-1V6H8v1H6V6h1V5h4v1h1v1h1v1z"/>'
    },
    "facebook-round": {
      body: '<path fill="currentColor" d="M23 9v6h-1v2h-1v2h-1v1h-1v1h-2v1h-2v1h-1v-8h2v-1h1v-2h-3V9h1V8h2V5h-4v1h-2v2h-1v4H7v3h3v8H9v-1H7v-1H5v-1H4v-1H3v-2H2v-2H1V9h1V7h1V5h1V4h1V3h2V2h2V1h6v1h2v1h2v1h1v1h1v2h1v2z"/>'
    },
    "facebook-square": {
      body: '<path fill="currentColor" d="M23 2v20h-1v1h-8v-8h2v-1h1v-2h-3V9h1V8h2V5h-4v1h-2v2h-1v4H7v3h3v8H2v-1H1V2h1V1h20v1z"/>'
    },
    figma: {
      body: '<path fill="currentColor" d="M18 3.5v-1h-1v-1H7v1H6v1H5v3h1v1h1v2H6v1H5v3h1v1h1v2H6v1H5v3h1v1h1v1h5v-1h1v-6h4v-1h1v-1h1v-3h-1v-1h-1v-2h1v-1h1v-3zm-7 18H8v-1H7v-3h1v-1h3zm0-7H8v-1H7v-3h1v-1h3zm0-7H8v-1H7v-3h1v-1h3zm6 3v3h-1v1h-2v-1h-1v-3h1v-1h2v1zm-1-4v1h-3v-5h3v1h1v3z"/>'
    },
    "file-import": {
      body: '<path fill="currentColor" d="M1 15v-2h11V8h1v1h1v1h1v1h1v1h1v1h1v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v-5z"/><path fill="currentColor" d="M23 6v16h-1v1H7v-1H6v-6h2v5h13V8h-5V3H8v9H6V2h1V1h11v1h1v1h1v1h1v1h1v1z"/>'
    },
    "file-import-solid": {
      body: '<path fill="currentColor" d="M1 13h5v3H1zm22-5v14h-1v1H7v-1H6v-6h6v4h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-1V9h-1v4H6V2h1V1h9v7z"/><path fill="currentColor" d="M23 6v1h-6V1h1v1h1v1h1v1h1v1h1v1z"/>'
    },
    filter: {
      body: '<path fill="currentColor" d="M1 2v4h1v1h1v1h1v1h1v1h1v1h1v1h1v2h1v3h1v1h1v1h1v1h1v1h1v1h1v-8h1v-2h1v-1h1v-1h1V9h1V8h1V7h1V6h1V2zm20 3h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v3h-1v3h-1v-1h-1v-2h-1v-3H9v-1H8V9H7V8H6V7H5V6H4V5H3V4h18z"/>'
    },
    "filter-alt-circle": {
      body: '<path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9zm-1 6h-1v2h-1v2h-2v1h-2v1H9v-1H7v-1H5v-2H4v-2H3V9h1V7h1V5h2V4h2V3h6v1h2v1h2v2h1v2h1z"/><path fill="currentColor" d="M10 15h4v2h-4zm-2-4h8v2H8zM6 7h12v2H6z"/>'
    },
    "filter-alt-circle-solid": {
      body: '<path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9zm-8 8h-4v-2h4zm-6-4v-2h8v2zM6 9V7h12v2z"/>'
    },
    "filter-solid": {
      body: '<path fill="currentColor" d="M23 2v4h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v2h-1v8h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1H9v-3H8v-2H7v-1H6v-1H5V9H4V8H3V7H2V6H1V2z"/>'
    },
    finance: {
      body: '<path fill="currentColor" d="M9.502 13.503v1h3v3h-2v1.001h-1v-1h-1v-1h3v-1h-3v-3.001h2v-1h1v1h1v1z"/><path fill="currentColor" d="M18.504 12.503v-2h-1V9.501h-1v-1h-1v-1H5.5v1h-1v1h-1v1h-1v2h-1v6.002h1v2h1v1h1v1h1v1.001h10.003v-1h1v-1h1v-1h1v-2.001h1.001v-6.001zm-10.002-2V9.501h4v1h2.001v2h1v5.002h-1v2h-2v1H8.502v-1h-2v-2H5.5v-5.001h1v-2zm9.002-4.002h-1v1h1zm2 1h-2v1h2zm1 1h-1v1h1zm1.001-3v3h-1v-2h-1.001v-1zM19.504 4.5h-3v1h3zm-3.001 1.001h-1v1h1zm-2 0H6.5v1h8.002zM16.504 1.5v1h-1v1h-1.001v1H6.501v-1h-1v-1h-1v-1h2v1h3v-1h2.001v1h3.001v-1z"/>'
    },
    fire: {
      body: '<path fill="currentColor" d="M19 13v-3h-1V9h-1V6h-1V4h-1V3h-1V2h-1V1h-2v1h1v2h-1v2h-1v1H9v1H8v1H7v1H6v3h1v2H6v-1H5v-2H4v2H3v3h1v2h1v1h1v1h1v1h1v1h8v-1h1v-1h1v-1h1v-2h1v-5zm-3 7v1h-2v1h-4v-1H9v-3h1v-1h1v-1h1v-1h1v-4h1v2h1v4h-1v2h1v-1h1v-1h1v3zm3-3h-1v-1h-2v-4h-1v-2h-1V9h-3v1h1v4h-1v1h-1v1H9v1H8v3H7v-1H6v-1H5v-2h3v-4H7v-1h1v-1h1V9h1V8h1V7h1V5h1V4h1v1h1v2h1v3h1v1h1v3h1z"/>'
    },
    "fire-solid": {
      body: '<path fill="currentColor" d="M19 13v-3h-1V9h-1V6h-1V4h-1V3h-1V2h-1V1h-2v1h1v2h-1v2h-1v1H9v1H8v1H7v1H6v3h1v2H6v-1H5v-2H4v2H3v3h1v2h1v1h1v1h1v1h1v1h8v-1h1v-1h1v-1h1v-2h1v-5zm-2 7h-1v1h-2v1h-4v-1H9v-4h1v-1h1v-1h1v-1h1v-3h-1v-1h-1V9h1v1h2v2h1v5h-1v2h1v-1h1v-1h1z"/>'
    },
    flag: {
      body: '<path fill="currentColor" d="M21 4v1h-2v1h-6V5H6v1H5V5h1V3H5V2H3v1H2v2h1v17h2v-4h1v-1h7v1h6v-1h2v-1h1V4zm-1 11h-1v1h-6v-1H6v1H5V8h1V7h7v1h6V7h1z"/>'
    },
    "flag-checkered": {
      body: '<path fill="currentColor" d="M21 4v1h-2v1h-6V5H6v1H5V5h1V3H5V2H3v1H2v2h1v17h2v-4h1v-1h7v1h6v-1h2v-1h1V4zm-9 11H6v1H5v-3h1v-1h6zm0-5H6v1H5V8h1V7h6zm8 5h-1v1h-5v-3h5v-1h1zm0-5h-1v1h-5V8h5V7h1z"/>'
    },
    "flag-checkered-solid": {
      body: '<path fill="currentColor" d="M22 4v12h-1v1h-2v1h-6v-1H6v-1h6v-4H6v1H5v4h1v1H5v4H3V5H2V3h1V2h2v1h1v2H5v1h1V5h7v1h6v1h-5v4h5v-1h2V6h-2V5h2V4z"/>'
    },
    "flag-solid": {
      body: '<path fill="currentColor" d="M22 4v12h-1v1h-2v1h-6v-1H6v1H5v4H3V5H2V3h1V2h2v1h1v2H5v1h1V5h7v1h6V5h2V4z"/>'
    },
    folder: {
      body: '<path fill="currentColor" d="M22 6V5h-9V4h-1V3h-1V2H2v1H1v18h1v1h20v-1h1V6zm-1 14H3V4h7v1h1v1h1v1h9z"/>'
    },
    "folder-open": {
      body: '<path fill="currentColor" d="M6 10v2H5v2H4v2H3v2H2v3h1v1h15v-1h1v-3h1v-2h1v-2h1v-2h1v-2zm14 4h-1v2h-1v2h-1v2H4v-2h1v-2h1v-2h1v-2h13z"/><path fill="currentColor" d="M20 5v4h-2V6H9V5H8V4H3v10H2v2H1V3h1V2h7v1h1v1h9v1z"/>'
    },
    "folder-open-solid": {
      body: '<path fill="currentColor" d="M2 16H1V3h1V2h7v1h1v1h9v1h1v4H5v1H4v2H3v2H2z"/><path fill="currentColor" d="M23 10v2h-1v2h-1v2h-1v2h-1v3h-1v1H3v-1H2v-3h1v-2h1v-2h1v-2h1v-2z"/>'
    },
    "folder-solid": {
      body: '<path fill="currentColor" d="M23 6v15h-1v1H2v-1H1V3h1V2h9v1h1v1h1v1h9v1z"/>'
    },
    fork: {
      body: '<path fill="currentColor" d="M21 2V1h-4v1h-1v4h1v1h1v4H6V7h1V6h1V2H7V1H3v1H2v4h1v1h1v6h7v4h-1v1H9v4h1v1h4v-1h1v-4h-1v-1h-1v-4h7V7h1V6h1V2ZM4 3h2v2H4Zm9 18h-2v-2h2Zm7-16h-2V3h2Z"/>'
    },
    "fork-solid": {
      body: '<path fill="currentColor" d="M21 3V2h-1V1h-3v1h-1v1h-1v3h1v1h1v4H7V7h1V6h1V3H8V2H7V1H4v1H3v1H2v3h1v1h1v6h1v1h5v2H9v1H8v4h1v1h1v1h4v-1h1v-1h1v-4h-1v-1h-1v-2h5v-1h1V7h1V6h1V3ZM6 6H5V5H4V4h1V3h1v1h1v1H6Zm8 14h-1v1h-2v-1h-1v-2h1v-1h2v1h1Zm6-15h-1v1h-1V5h-1V4h1V3h1v1h1Z"/>'
    },
    futurism: {
      body: '<path fill="currentColor" d="M23.505 17.503v2h-1v1.001h-6.002v1h-1v1h-1v1h-4.001v-1h-1v-1h-1v-1H2.5v-1h-1v-2zm0-2v1h-2v-2h1v1zm-3.001-7.001v8.001h-1v-4h-1v-1h-3v-1.001h3v-1h-3v-2h-1.001v-1h-1V5.5h-1v-2h1v-2h1v1h1v1h1v1h1v3.001h2.001v1zm-14.003 4v4.001H1.5v-1h1v-2h1v-1z"/><path fill="currentColor" d="M18.504 12.503v4H7.5v-4h-1v-1h-2V4.5h1v-3h3v14.003h1V3.5h1.001v1h1v1h1v1.001h1v1h1.001v8.002h1v-3z"/>'
    },
    gaming: {
      body: '<path fill="currentColor" d="M15.503 13.502H9.502v2h6.001z"/><path fill="currentColor" d="M22.505 10.501v-2h-1v-2h-1v-1h-1V4.5h-4.002v1H9.502v-1H5.5v1h-1v1h-1v2h-1v2.001h-1v8.002h1v1h3v-1h1.001v-1h1v-1h1v-3.001h1v-1h6.002v1h1v3h1v1.001h1v1h1.001v1h3v-1h1.001v-8.002zm-17.004-2v-1h1v-1h1v1h1v1h1v1h-1v1h-1v1h-1v-1h-1v-1h-1v-1zm8.002 1h-1v1h-1v-1h-1.001v-1h1v-1h1v1h1zm7.001 1h-2v2h-2v-2h-2.001v-2h2v-2h2v2h2.001z"/><path fill="currentColor" d="M18.504 8.501h-2v2h2z"/>'
    },
    giphy: {
      body: '<path fill="currentColor" d="M20 9h1v14H3V1h9v1h-1v1H5v18h14V10h1z"/><path fill="currentColor" d="M21 6v2h-8V1h2v2h3v3z"/>'
    },
    github: {
      body: '<path fill="currentColor" d="M23 9v6h-1v2h-1v2h-1v1h-1v1h-1v1h-2v1h-1v-5h-1v-1h1v-1h2v-1h1v-1h1V9h-1V6h-2v1h-1v1h-1V7h-4v1H9V7H8V6H6v3H5v5h1v1h1v1h2v2H7v-1H6v-1H4v1h1v2h1v1h3v3H8v-1H6v-1H5v-1H4v-1H3v-2H2v-2H1V9h1V7h1V5h1V4h1V3h2V2h2V1h6v1h2v1h2v1h1v1h1v2h1v2z"/>'
    },
    gitlab: {
      body: '<path fill="currentColor" d="M23 8v7h-1v1h-1v1h-1v1h-2v1h-1v1h-1v1h-2v1h-1v1h-2v-1h-1v-1H8v-1H7v-1H6v-1H4v-1H3v-1H2v-1H1V8h1V6h1V3h1V1h2v3h1v3h1v1h8V7h1V4h1V1h2v2h1v3h1v2z"/>'
    },
    glasses: {
      body: '<path fill="currentColor" d="M21 5V4h-1V3h-4v2h3v1h1v5h-5v1H9v-1H4V6h1V5h3V3H4v1H3v1H2v12h1v2h2v1h3v-1h2v-2h1v-1h2v1h1v2h2v1h3v-1h2v-2h1V5ZM8 17v1H5v-1H4v-3h1v-1h3v1h1v3Zm11 0v1h-3v-1h-1v-3h1v-1h3v1h1v3Z"/>'
    },
    "glasses-solid": {
      body: '<path fill="currentColor" d="M22 5v12h-1v2h-2v1h-3v-1h-2v-2h-1v-1h-2v1h-1v2H8v1H5v-1H3v-2H2V5h1V4h1V3h4v2H5v1H4v5h5v1h6v-1h5V6h-1V5h-3V3h4v1h1v1z"/>'
    },
    globe: {
      body: '<path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v7h1v1h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9zm-1 1v4h-3v-4zm-5-6h1v1h2v2h1v1h-3V5h-1zm-2 14v2h-1v1h-2v-1h-1v-2H9v-2h6v2zm2-8v4H8v-4zM9 6h1V4h1V3h2v1h1v2h1v2H9zM4 7h1V5h2V4h1v1H7v3H4zm-1 7v-4h3v4zm2 5v-2H4v-1h3v3h1v1H7v-1zm14-2v2h-2v1h-1v-1h1v-3h3v1z"/>'
    },
    "globe-americas": {
      body: '<path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9zM9 21v-1H7v-1H5v-2H4v-2H3v-4h1v1h1v1h1v1h2v3h1v1h1v3zm6-2h-1v2h-2v-3h-1v-1h-1v-3H9v-1H8v-1H7v-1H6v-1H5V9H4V7h1V6h1V5h1V4h3V3h2v1h1v4h-2v3h-1v-1H8v2h3v1h4v1h1v3h-1zm5-2h-1v2h-2v1h-1v-1h1v-2h1v-3h-1v-1h-1v-1h-1v-1h-2V9h1V8h1V4h-1V3h1v1h2v1h2v2h-1v1h-1v1h-1v3h1v1h1v1h1v1h1zm1-4h-2v-1h-1V9h1V8h1v1h1z"/>'
    },
    "globe-americas-solid": {
      body: '<path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9zm-4 3V9h1V8h1v1h1v4h-2v-1zm-4 7v2h-2v-3h-1v-1h-1v-3H9v-1H8v-1H7v-1H6v-1H5V9H4V7h1V6h1V5h1V4h3V3h2v1h1v4h-2v2h1v1h-2v-1H8v2h3v1h4v1h1v3h-1v2z"/>'
    },
    "globe-solid": {
      body: '<path fill="currentColor" d="M9 1h1v1H9zm0 1v1H8v2H7v3H2V7h1V5h1V4h1V3h2V2zm4 0h1v2h1v2h1v2H8V6h1V4h1V2h1V1h2zm1-1h1v1h-1zm8 6v1h-5V5h-1V3h-1V2h2v1h2v1h1v1h1v2zm-5 3v4h-1v1H8v-1H7v-4h1V9h8v1zM1 9h6v1H6v4h1v1H1zm22 0v6h-6v-1h1v-4h-1V9zm-1 7v1h-1v2h-1v1h-1v1h-2v1h-2v-1h1v-2h1v-3zM9 22h1v1H9zm0-1v1H7v-1H5v-1H4v-1H3v-2H2v-1h5v3h1v2zm5 1h1v1h-1zm0 0h-1v1h-2v-1h-1v-2H9v-2H8v-2h8v2h-1v2h-1z"/>'
    },
    golden: {
      body: '<path fill="currentColor" d="M6 9h1v1H6z"/><path fill="currentColor" d="M23 9v6h-1v1h-1v2h-1v1h-1v1h-1v1h-2v1h-2v1h-4v-1H8v-1H6v-1H5v-1H4v-8h1v2h1v2h1v1h2v1h5v-1h2v-1h1v-1h1v-2h1v-1h1V5h1v2h1v2z"/><path fill="currentColor" d="M5 10h1v1H5zm11 1h1v1h-1z"/><path fill="currentColor" d="M4 10H3v7H2v-3H1V9h1V7h1V5h1V4h1V3h2V2h2V1h6v1h2v1h1v1h1v6h-1v1h-1V8h-2V7H7v1H5v1H4z"/>'
    },
    google: {
      body: '<path fill="currentColor" d="M23 10v5h-1v2h-1v2h-1v1h-1v1h-2v1h-2v1H9v-1H7v-1H5v-1H4v-1H3v-2H2v-2H1V9h1V7h1V5h1V4h1V3h2V2h2V1h6v1h2v1h2v2h-1v1h-1v1h-2V6H9v1H7v2H6v6h1v2h2v1h6v-1h2v-2h1v-1h-6v-4z"/>'
    },
    "google-news": {
      body: '<path fill="currentColor" d="M20 10V9H4v1H3v11h1v1h16v-1h1V10zm-7 3h5v1h-5zm-2 5h-1v1H6v-1H5v-4h1v-1h4v1H7v1H6v2h1v1h2v-1h1v-1H8v-1h3zm7 0h-5v-1h5zm-5-2v-1h6v1z"/><path fill="currentColor" d="M23 8v4h-1V9h-1V8h-5V6h3v1h3v1zm-8-5h-5v1H7v1H5V3h1V2h12v1h1v2h-4z"/><path fill="currentColor" d="M14 6h1v2H3v1H2v3H1V8h1V7h3V6h3V5h3V4h3z"/>'
    },
    "graduation-cap": {
      body: '<path fill="currentColor" d="M22 8V7h-2V6h-3V5h-2V4h-2V3h-2v1H9v1H7v1H4v1H2v1H1v13h2V10h1v1h1v7h1v1h1v1h2v1h6v-1h2v-1h1v-1h1v-7h1v-1h2V9h1V8Zm-5 9h-1v1h-1v1H9v-1H8v-1H7v-5h2v1h2v1h2v-1h2v-1h2Zm3-8h-3v1h-2v1h-2v1h-2v-1H9v-1H7V9H4V8h3V7h2V6h2V5h2v1h2v1h2v1h3Z"/>'
    },
    "graduation-cap-solid": {
      body: '<path fill="currentColor" d="M19 13v5h-1v1h-1v1h-2v1H9v-1H7v-1H6v-1H5v-5h2v1h2v1h2v1h2v-1h2v-1h2v-1z"/><path fill="currentColor" d="M23 8v1h-1v1h-2v1h-3v1h-2v1h-2v1h-2v-1H9v-1H7v-1H4v-1H3v11H1V8h1V7h2V6h3V5h2V4h2V3h2v1h2v1h2v1h3v1h2v1z"/>'
    },
    grid: {
      body: '<path fill="currentColor" d="M10 13H2v1H1v8h1v1h8v-1h1v-8h-1zm-1 8H3v-6h6zm1-19V1H2v1H1v8h1v1h8v-1h1V2zM3 9V3h6v6zm19 4h-8v1h-1v8h1v1h8v-1h1v-8h-1zm-1 8h-6v-6h6zm1-19V1h-8v1h-1v8h1v1h8v-1h1V2zm-1 7h-6V3h6z"/>'
    },
    "grid-solid": {
      body: '<path fill="currentColor" d="M10 14h1v8h-1v1H2v-1H1v-8h1v-1h8zm0-12h1v8h-1v1H2v-1H1V2h1V1h8zm12 12h1v8h-1v1h-8v-1h-1v-8h1v-1h8zm1-12v8h-1v1h-8v-1h-1V2h1V1h8v1z"/>'
    },
    h1: {
      body: '<path fill="currentColor" d="M23 18v2h-9v-2h4V6h-1v1h-1v1h-2V6h1V5h1V4h4v14zM12 4v16h-2v-8H3v8H1V4h2v6h7V4z"/>'
    },
    h2: {
      body: '<path fill="currentColor" d="M12 4v16h-2v-8H3v8H1V4h2v6h7V4zm11 2v5h-1v1h-1v2h-1v1h-1v1h-1v1h-1v1h6v2h-9v-3h1v-1h1v-1h1v-1h1v-1h1v-2h1v-1h1V7h-1V6h-3v1h-1v3h-2V6h1V5h1V4h5v1h1v1z"/>'
    },
    h3: {
      body: '<path fill="currentColor" d="M23 6v5h-1v2h1v5h-1v1h-1v1h-5v-1h-1v-1h-1v-4h2v3h1v1h3v-1h1v-3h-1v-1h-1v-2h1v-1h1V7h-1V6h-3v1h-1v3h-2V6h1V5h1V4h5v1h1v1zM12 4v16h-2v-8H3v8H1V4h2v6h7V4z"/>'
    },
    hackernoon: {
      body: '<path fill="currentColor" d="M5 6H3v3h2zM3 9H1v6h2zm2 6H3v3h2zm12 3v5H5v-5h3v2h6v-2zm2-3h-2v3h2zm4-4v2h-2v2h-2V9h2v2zm-4-5h-2v3h2zm-2-5v5h-3V4h-2v9h-2V4H8v2H5V1z"/>'
    },
    "hackernoon-purcat": {
      body: '<path fill="currentColor" d="M5.5 6.501h-2v3h2zm-2 3.001h-2v6.001h2zm2 6.001h-2v3h2zm12.004 3.001v5.001H5.5v-5.001h3v2h6.002v-2zm2-3.001h-2v3h2zm4.001-4.001v2h-2v2.001h-2V9.502h2v2zm-4.001-5.001h-2v3h2zm-2-5.001v5.001h-3.001v-2h-2v9.002h-2.001V4.5h-2v2H5.5v-5z"/>'
    },
    handshake: {
      body: '<path fill="currentColor" d="M18 8V7h-7v1h-1v1H9v1H8v2h3v-1h1v-1h1V9h2v1h1v1h1v1h1v1h1v1h2v-1h2v2h-1v1h-2v1h-1v1h-1v1h-1v1h-3v1H8v-1H6v-1H5v-1H4v-1H3v-1H2v-1H1v-2h2v1h1v1h1v1h1v1h1v1h1v1h1v-1H8v-1H7v-1h2v1h1v1h1v1h2v-1h-1v-1h-1v-1h-1v-1h2v1h1v1h1v1h3v-1h-2v-1h-1v-1h-1v-1h2v1h1v1h2v-1h-1v-1h-1v-1h-1v-1h-2v1h-2v1H8v-1H7v-1H6v-2h1V9h1V8h1V7H6v1H5V7H3V6H1V4h2v1h2v1h1V5h12v1h1V5h2V4h2v2h-2v1h-2v1z"/>'
    },
    "handshake-solid": {
      body: '<path fill="currentColor" d="M6 12h1v1h5v-1h2v1h1v1h1v1h1v1h1v3h-1v-1h-1v-1h-1v-1h-1v-1h-1v1h1v1h1v1h1v1h1v1h-1v1h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-1v1h1v1h1v1h1v1h1v1h-3v-1h-1v-1H9v-1H8v1h1v1h1v1H7v-1H6v-1H5v-1H4v-1H3v-1H2v-1H1V4h1v1h2v1h2V5h3v2H8v1H7v1H6z"/><path fill="currentColor" d="M23 4v11h-1v1h-1v1h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-2v1h-1v1H7v-2h1V9h1V8h1V7h1V6h1V5h5v1h3V5h2V4z"/>'
    },
    hashtag: {
      body: '<path fill="currentColor" d="M17 12V9h6V7h-5V4h1V1h-2v3h-1v3h-6V4h1V1H9v3H8v3H3v2h4v3H6v3H1v2h4v3H4v3h2v-3h1v-3h6v3h-1v3h2v-3h1v-3h6v-2h-5v-3Zm-2 0h-1v3H8v-3h1V9h6Z"/>'
    },
    "hashtag-solid": {
      body: '<path fill="currentColor" d="M19 6V4h1V1h-3v3h-1v2h-5V4h1V1H9v3H8v2H3v3h4v3H6v3H1v3h4v2H4v3h3v-3h1v-2h5v2h-1v3h3v-3h1v-2h5v-3h-4v-3h1V9h5V6Zm-5 9H9v-3h1V9h5v3h-1Z"/>'
    },
    "heading-1-solid": {
      body: '<path fill="currentColor" d="M12 4v16H9v-7H4v7H1V4h3v6h5V4zm11 13v3h-9v-3h3V8h-1v1h-2V6h1V5h1V4h4v13z"/>'
    },
    "heading-2-solid": {
      body: '<path fill="currentColor" d="M9 4h3v16H9v-7H4v7H1V4h3v6h5zm14 2v5h-1v1h-1v2h-1v1h-1v1h-1v1h5v3h-9v-3h1v-1h1v-2h1v-1h1v-2h1v-1h1V7h-3v3h-3V6h1V5h1V4h5v1h1v1z"/><path fill="none" d="M0 0h24v24H0z"/>'
    },
    "heading-3-solid": {
      body: '<path fill="currentColor" d="M22 13h1v5h-1v1h-1v1h-5v-1h-1v-1h-1v-4h3v3h3v-3h-1v-1h-1v-2h1v-1h1V7h-3v3h-3V6h1V5h1V4h5v1h1v1h1v5h-1zM9 4h3v16H9v-7H4v7H1V4h3v6h5z"/><path fill="none" d="M0 0h24v24H0z"/>'
    },
    headphones: {
      body: '<path fill="currentColor" d="M22 9V7h-1V6h-1V5h-1V4h-1V3h-2V2H8v1H6v1H5v1H4v1H3v1H2v2H1v11h1v2h1v1h3v-1h1v-9H6v-1H3v2H2v-4h1V8h1V7h1V6h1V5h1V4h2V3h6v1h2v1h1v1h1v1h1v1h1v2h1v4h-1v-2h-3v1h-1v9h1v1h3v-1h1v-2h1V9zM3 15h1v-1h1v7H4v-1H3zm18 5h-1v1h-1v-7h1v1h1z"/>'
    },
    "headphones-solid": {
      body: '<path fill="currentColor" d="M23 9v11h-1v2h-1v1h-3v-1h-1v-9h1v-1h3v2h1v-4h-1V8h-1V7h-1V6h-1V5h-1V4h-2V3H9v1H7v1H6v1H5v1H4v1H3v2H2v4h1v-2h3v1h1v9H6v1H3v-1H2v-2H1V9h1V7h1V6h1V5h1V4h1V3h2V2h8v1h2v1h1v1h1v1h1v1h1v2z"/>'
    },
    heart: {
      body: '<path fill="currentColor" d="M22 6V5h-1V4h-1V3h-6v1h-1v1h-2V4h-1V3H4v1H3v1H2v1H1v5h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h2v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1V6zm-2 4v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1h-1v-1H9v-1H8v-1H7v-1H6v-1H5v-1H4v-1H3V7h1V6h1V5h4v1h1v1h1v1h2V7h1V6h1V5h4v1h1v1h1v3z"/>'
    },
    "heart-solid": {
      body: '<path fill="currentColor" d="M23 6v5h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1h-1v-1H9v-1H8v-1H7v-1H6v-1H5v-1H4v-1H3v-1H2v-1H1V6h1V5h1V4h1V3h6v1h1v1h2V4h1V3h6v1h1v1h1v1z"/>'
    },
    highlight: {
      body: '<path fill="currentColor" d="M21 1v8H11V1H9v10h1v2h1v2h1v6H1v2h19v-8h1v-2h1v-2h1V1zm-3 20h-4v-4h4zm2-8h-1v2h-6v-2h-1v-2h8z"/>'
    },
    "highlight-solid": {
      body: '<path fill="currentColor" d="M20 1v7h-8V1H9v10h1v2h1v2h1v5H1v3h19v-8h1v-2h1v-2h1V1zm-2 19h-4v-3h4zm1-7h-1v2h-4v-2h-1v-2h6z"/><path fill="none" d="M0 0h24v24H0z"/>'
    },
    "hockey-mask": {
      body: '<path fill="currentColor" d="M18 9h1v2h-1zm-1 2h1v1h-1zm-2 1h2v1h-2zm-1-1h1v1h-1zm0-3h4v1h-4zm-1-4h2v2h-2zm0 15h1v1h-1zm0-3h1v1h-1zm0-3h1v1h-1zm0-4h1v2h-1zm-2-3h2v2h-2zm-1 13h1v1h-1zm0-3h1v1h-1zm0-3h1v1h-1zm0-4h1v2h-1zm-1 2h1v1H9zm0-7h2v2H9zm-2 8h2v1H7zm-1-1h1v1H6z"/><path fill="currentColor" d="M20 6V5h-1V4h-1V3h-1V2h-2V1H9v1H7v1H6v1H5v1H4v1H3v12h1v1h1v1h1v1h1v1h2v1h6v-1h2v-1h1v-1h1v-1h1v-1h1V6zm0 10h-1v2h-1v1h-1v1h-1v1h-2v1h-4v-1H8v-1H7v-1H6v-1H5v-2H4V8h1V6h1V5h1V4h1V3h2V2h4v1h2v1h1v1h1v1h1v2h1z"/><path fill="currentColor" d="M6 8h4v1H6zM5 9h1v2H5z"/><path fill="none" d="M0 0h24v24H0z"/>'
    },
    "hockey-mask-solid": {
      body: '<path fill="currentColor" d="M20 6V5h-1V4h-1V3h-1V2h-2V1H9v1H7v1H6v1H5v1H4v1H3v12h1v1h1v1h1v1h1v1h2v1h6v-1h2v-1h1v-1h1v-1h1v-1h1V6zM10 19h1v1h-1zm1-5h-1v-1h1zm0 2v1h-1v-1zm2 4v-1h1v1zm1-6h-1v-1h1zm0 2v1h-1v-1zm4-7v2h-1v1h-2v-1h-1V9zM9 4h2v2h2V4h2v2h-2v2h-2V6H9zM6 9h4v2H9v1H7v-1H6z"/>'
    },
    home: {
      body: '<path fill="currentColor" d="M22 11v-1h-1V9h-1V8h-1V7h-1V6h-1V5h-1V4h-1V3h-1V2h-1V1h-2v1h-1v1H9v1H8v1H7v1H6v1H5v1H4v1H3v1H2v1H1v1h3v10h1v1h4v-7h6v7h4v-1h1V12h3v-1zm-3 0h-1v10h-1v-6h-1v-1H8v1H7v6H6V11H5v-1h1V9h1V8h1V7h1V6h1V5h1V4h2v1h1v1h1v1h1v1h1v1h1v1h1z"/>'
    },
    "home-solid": {
      body: '<path fill="currentColor" d="M23 11v1h-3v10h-1v1h-4v-7H9v7H5v-1H4V12H1v-1h1v-1h1V9h1V8h1V7h1V6h1V5h1V4h1V3h1V2h1V1h2v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1z"/>'
    },
    huggingface: {
      body: '<path fill="currentColor" d="M20 17h1v1h-1zm-1 1h1v1h-1zm-1-1h1v1h-1zm1-1h1v1h-1zm1-1h1v1h-1zm-1-1h1v1h-1zm-1 1h1v1h-1zm-1 1h1v1h-1zm0-2h1v1h-1zm-1 1h1v1h-1z"/><path fill="currentColor" d="M19 19v1h-5v-3h1v-1h1v1h1v1h1v1zm3-4h1v5h-1zm-1-7h1v7h-1zm-1 12h2v1h-2zm0-14h1v2h-1zm-1-1h1v1h-1zm-1-1h1v1h-1zm-2-1h2v1h-2zm-2 18h6v1h-6zm-4-1h4v1h-4zM8 2h8v1H8zM7 15h1v1H7zM6 3h2v1H6zm0 13h1v1H6zm0-2h1v1H6z"/><path fill="currentColor" d="M10 17v3H5v-1h1v-1h1v-1h1v-1h1v1z"/><path fill="currentColor" d="M5 17h1v1H5zm0-2h1v1H5zM5 4h1v1H5zM4 21h6v1H4zm0-3h1v1H4zm0-2h1v1H4zm0-2h1v1H4zm15-5V7h-1V6h-1V5h-2V4H9v1H7v1H6v1H5v2H4v4h3v1h1v1h1v1h1v1h1v2h2v-2h1v-1h1v-1h1v-1h1v-1h3V9zM7 10H6V9h1zm1 0V8h2v1H9v1zm7 3h-1v1h-1v-1h-2v1h-1v-1H9v-2h1v1h4v-1h1zm1-3h-1V9h-1V8h2zm2 0h-1V9h1zM4 5h1v1H4zM2 20h2v1H2zm1-3h1v1H3zm0-2h1v1H3zm0-9h1v2H3zM2 8h1v7H2zm-1 7h1v5H1z"/>'
    },
    image: {
      body: '<path fill="currentColor" d="M9 6v3H8v1H5V9H4V6h1V5h3v1z"/><path fill="currentColor" d="M22 2V1H2v1H1v20h1v1h20v-1h1V2zm-5 12v1h1v1h1v1h1v1h1v3H8v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v1zm3 1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H9v1H8v1H7v-1H6v-1H5v-1H4v-1H3V3h18v12zM5 18v1h1v1h1v1H3v-4h1v1z"/>'
    },
    "image-solid": {
      body: '<path fill="currentColor" d="M23 20v2h-1v1H2v-1H1v-7h1v1h1v1h1v1h1v1h1v1h1v1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v1h1v1h1v1h1v1h1v1h1v1h1v1z"/><path fill="currentColor" d="M22 2V1H2v1H1v10h1v1h1v1h1v1h1v1h1v1h1v1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1V2zM9 6v3H8v1H5V9H4V6h1V5h3v1z"/><path fill="none" d="M0 0h24v24H0z"/>'
    },
    imgur: {
      body: '<path fill="currentColor" d="M15 17h1v1h-1zm0 0v-1h-2v1h-1v1h-1v1h1v1h-1v-1h-1v1H8v-1H7v-1H6v-1H5v-2H4v1H3v-1H2v-1h1v-1h1v1h1v-1h1v-1h1v-1H6v-1h1v1h1V9H7V8H6v1H5v1H4v1H3v1H1v9h1v1h1v1h8v-1h1v-1h1v-1h1v-1h1v-1h-1v-1zM3 20H2v-1h1zm0-3h1v1H3zm4 4H6v1H5v-1H4v-1h1v-1h1v1h1zm3 1H9v-1h1z"/><path fill="currentColor" d="M23 3v18h-1v1h-1v1h-8v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1V5H7v1H6v1H5v1H4v1H3v1H2v1H1V3h1V2h1V1h18v1h1v1z"/><path fill="currentColor" d="M13 15h-1v1h-1v1h-1v1H8v-1H7v-1H6v-2h1v-1h1v-1h1v-1h1V9H9V8H8V7h1V6h9v9h-1v1h-1v-1h-1v-1h-2z"/>'
    },
    indent: {
      body: '<path fill="currentColor" d="M8 11v-1H7V9H6V8H5V7H4V6H2v1H1v10h1v1h2v-1h1v-1h1v-1h1v-1h1v-1h1v-2Zm-2 2v1H5v1H4v1H2V8h2v1h1v1h1v1h1v2Zm5-5h12v1H11zM1 21h22v1H1zm10-6h12v1H11zM1 2h22v1H1z"/>'
    },
    "indent-solid": {
      body: '<path fill="currentColor" d="M22 15h1v1h-1v1H12v-1h-1v-1h1v-1h10zm0 6h1v1h-1v1H2v-1H1v-1h1v-1h20zm0-13h1v1h-1v1H12V9h-1V8h1V7h10zm1-6v1h-1v1H2V3H1V2h1V1h20v1zM2 17H1V7h1V6h2v1h1v1h1v1h1v1h1v1h1v2H8v1H7v1H6v1H5v1H4v1H2z"/>'
    },
    "info-circle": {
      body: '<path fill="currentColor" d="M14 15v2h-4v-2h1v-5h-1V9h3v6zm-3-9h2v2h-2z"/><path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9zm-1 6h-1v2h-1v1h-1v1h-1v1h-2v1H9v-1H7v-1H6v-1H5v-1H4v-2H3V9h1V7h1V6h1V5h1V4h2V3h6v1h2v1h1v1h1v1h1v2h1z"/><path fill="none" d="M0 0h24v24H0z"/>'
    },
    "info-circle-solid": {
      body: '<path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9zM11 6h2v2h-2zm-1 9h1v-5h-1V9h3v6h1v2h-4z"/><path fill="none" d="M0 0h24v24H0z"/>'
    },
    instagram: {
      body: '<path fill="currentColor" d="M17 9V8h-1V7h-1V6H9v1H8v1H7v1H6v6h1v1h1v1h1v1h6v-1h1v-1h1v-1h1V9zm-1 5h-1v1h-1v1h-4v-1H9v-1H8v-4h1V9h1V8h4v1h1v1h1z"/><path fill="currentColor" d="M22 5V3h-1V2h-2V1H5v1H3v1H2v2H1v14h1v2h1v1h2v1h14v-1h2v-1h1v-2h1V5zm-1 14h-1v1h-1v1H5v-1H4v-1H3V5h1V4h1V3h14v1h1v1h1z"/><path fill="currentColor" d="M17 5h2v2h-2z"/>'
    },
    ios: {
      body: '<path fill="currentColor" d="M15 1v3h-1v1h-1v1h-2V3h1V2h1V1zm6 16v1h-1v2h-1v1h-1v1h-1v1h-2v-1h-5v1H8v-1H7v-1H6v-1H5v-1H4v-2H3v-7h1V8h1V7h2V6h3v1h4V6h3v1h2v1h1v1h-1v1h-1v5h1v1h1v1z"/><path fill="none" d="M0 0h24v24H0z"/>'
    },
    italics: {
      body: '<path fill="currentColor" d="M22 1v2h-5v1h-1v2h-1v2h-1v3h-1v2h-1v3h-1v2h-1v2H9v1h7v2H2v-2h5v-1h1v-2h1v-2h1v-3h1v-2h1V8h1V6h1V4h1V3H8V1z"/>'
    },
    "italics-solid": {
      body: '<path fill="currentColor" d="M22 1v3h-5v2h-1v2h-1v3h-1v2h-1v3h-1v2h-1v2h5v3H2v-3h5v-2h1v-2h1v-3h1v-2h1V8h1V6h1V4H8V1z"/>'
    },
    kaggle: {
      body: '<path fill="currentColor" d="M12 15v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h-4v-1h-1v-1h-1v-1h-1v-1h-1v-1H9v1H8v4H5V1h3v14h1v-1h1v-1h1v-1h1v-1h1v-1h1V9h1V8h4v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1z"/>'
    },
    laptop: {
      body: '<path fill="currentColor" d="M3 14V5h1V4h16v1h1v9h-2V6H5v8zm-2 1v3h1v1h1v1h18v-1h1v-1h1v-3Zm2 3v-1h18v1Z"/>'
    },
    "laptop-code": {
      body: '<path fill="currentColor" d="M3 14V5h1V4h16v1h1v9h-2V6H5v8z"/><path fill="currentColor" d="M10 11h1v2h-1v-1H9v-1H8V9h1V8h1V7h1v2h-1zm4-2h-1V7h1v1h1v1h1v2h-1v1h-1v1h-1v-2h1zM1 15v3h1v1h1v1h18v-1h1v-1h1v-3Zm2 3v-1h18v1Z"/>'
    },
    "laptop-code-solid": {
      body: '<path fill="currentColor" d="M3 14V5h1V4h16v1h1v9h-2V6H5v8z"/><path fill="currentColor" d="M10 11h1v2H9v-1H8v-1H7V9h1V8h1V7h2v2h-1zm4-2h-1V7h2v1h1v1h1v2h-1v1h-1v1h-2v-2h1zm9 6v3h-1v1h-1v1H3v-1H2v-1H1v-3z"/>'
    },
    "laptop-solid": {
      body: '<path fill="currentColor" d="M3 14V5h1V4h16v1h1v9h-2V6H5v8zm20 1v3h-1v1h-1v1H3v-1H2v-1H1v-3z"/>'
    },
    "life-hacking": {
      body: '<path fill="currentColor" d="M15.503 18.504v3h-1v1h-1.001v1.001h-2v-1h-1v-1h-1v-3.001zm5.001-11.003v4.001h-1v2h-1v1.001h-1.001v1h-1v1h-1v1h-1v-5h1v-1h1v-1.001h-1v1h-1v1h-1.001v5.002h-2v-5.002h-1v-1h-1v-1H8.5v1h1v1h1v5.002h-1v-1h-1v-1h-1v-1.001h-1v-1h-1v-2h-1V7.5h1v-2h1v-1h1v-1h1v-1h2.001v-1h4.001v1h2v1h1.001v1h1v1h1v2.001z"/>'
    },
    lightbulb: {
      body: '<path fill="currentColor" d="M14 21v1h-1v1h-2v-1h-1v-1zM11 4h2v1h-2zm-1 1h1v1h-1z"/><path fill="currentColor" d="M19 7V5h-1V4h-1V3h-1V2h-2V1h-4v1H8v1H7v1H6v1H5v2H4v4h1v2h1v1h1v1h1v1h1v4h6v-4h1v-1h1v-1h1v-1h1v-2h1V7zm-1 4h-1v2h-1v1h-1v1h-1v1h-4v-1H9v-1H8v-1H7v-2H6V7h1V5h1V4h2V3h4v1h2v1h1v2h1z"/><path fill="currentColor" d="M9 6h1v1H9zM8 7h1v2H8z"/>'
    },
    "lightbulb-solid": {
      body: '<path fill="currentColor" d="M2 1h1v1H2zm1 1h1v1H3zm1 1h1v1H4zM1 16h1v1H1zm1-1h1v1H2zm1-1h1v1H3zm19 2h1v1h-1zm-1-1h1v1h-1zm-1-1h1v1h-1zm1-13h1v1h-1zm-1 1h1v1h-1zm-1 1h1v1h-1zM1 8h2v1H1zm14 10v3h-1v1h-1v1h-2v-1h-1v-1H9v-3zm4-13h-1V4h-1V3h-1V2h-2V1h-4v1H8v1H7v1H6v1H5v2H4v4h1v2h1v1h1v1h1v1h1v1h6v-1h1v-1h1v-1h1v-1h1v-2h1V7h-1zM7 7h1V6h1V5h1V4h3v1h-3v1H9v1H8v2H7zm14 1h2v1h-2z"/>'
    },
    "line-height": {
      body: '<path fill="currentColor" d="M10 12h13v1H10zm0 6h13v1H10zM7 6h1v2H7V7H6V6H5v13h1v-1h1v-1h1v2H7v1H6v1H5v1H4v-1H3v-1H2v-1H1v-2h1v1h1v1h1V6H3v1H2v1H1V6h1V5h1V4h1V3h1v1h1v1h1zm3 0h13v1H10z"/>'
    },
    "line-height-solid": {
      body: '<path fill="currentColor" d="M8 6h1v2H7V7H6v11h1v-1h2v2H8v1H7v1H6v1H4v-1H3v-1H2v-1H1v-2h2v1h1V7H3v1H1V6h1V5h1V4h1V3h2v1h1v1h1zm14 6h1v1h-1v1H11v-1h-1v-1h1v-1h11zm1-6v1h-1v1H11V7h-1V6h1V5h11v1zm-1 12h1v1h-1v1H11v-1h-1v-1h1v-1h11z"/>'
    },
    link: {
      body: '<path fill="currentColor" d="M16 10h1v7h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H5v-1H4v-1H3v-1H2v-1H1v-5h1v-1h1v-1h1v-1h1v3H4v1H3v3h1v1h1v1h1v1h4v-1h1v-1h1v-1h1v-1h1v-1h1v-5h-1v-1h-1V9h1V8h1v1h1z"/><path fill="currentColor" d="M23 5v5h-1v1h-1v1h-1v1h-1v-3h1V9h1V6h-1V5h-1V4h-1V3h-4v1h-1v1h-1v1h-1v1h-1v1H9v5h1v1h1v1h-1v1H9v-1H8v-1H7V7h1V6h1V5h1V4h1V3h1V2h1V1h6v1h1v1h1v1h1v1z"/>'
    },
    "link-solid": {
      body: '<path fill="currentColor" d="M16 10h1v7h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H5v-1H4v-1H3v-1H2v-1H1v-5h1v-1h1v-1h1v-1h1v4H4v3h1v1h1v1h3v-1h1v-1h1v-1h1v-1h1v-1h1v-3h-1v-1h-1v-1h1V9h1V8h1v1h1z"/><path fill="currentColor" d="M23 5v5h-1v1h-1v1h-1v1h-1V9h1V6h-1V5h-1V4h-3v1h-1v1h-1v1h-1v1h-1v1h-1v3h1v1h1v1h-1v1h-1v1H9v-1H8v-1H7V7h1V6h1V5h1V4h1V3h1V2h1V1h6v1h1v1h1v1h1v1z"/>'
    },
    linkedin: {
      body: '<path fill="currentColor" d="M22 2V1H2v1H1v20h1v1h20v-1h1V2zm-9 10v8h-3V9h3v1h1V9h4v1h1v10h-3v-8zM4 8V5h3v3zm3 1v11H4V9z"/>'
    },
    "location-pin": {
      body: '<path fill="currentColor" d="M15 8v2h-1v1h-1v1h-2v-1h-1v-1H9V8h1V7h1V6h2v1h1v1z"/><path fill="currentColor" d="M19 6V4h-1V3h-1V2h-2V1H9v1H7v1H6v1H5v2H4v6h1v2h1v1h1v2h1v1h1v2h1v1h1v2h2v-2h1v-1h1v-2h1v-1h1v-2h1v-1h1v-2h1V6zm-2 6v2h-1v1h-1v2h-1v1h-1v2h-2v-2h-1v-1H9v-2H8v-1H7v-2H6V6h1V4h2V3h6v1h2v2h1v6z"/>'
    },
    "location-pin-solid": {
      body: '<path fill="currentColor" d="M19 6V4h-1V3h-1V2h-2V1H9v1H7v1H6v1H5v2H4v6h1v2h1v1h1v2h1v1h1v2h1v1h1v2h2v-2h1v-1h1v-2h1v-1h1v-2h1v-1h1v-2h1V6zm-5 5h-1v1h-2v-1h-1v-1H9V8h1V7h1V6h2v1h1v1h1v2h-1z"/>'
    },
    lock: {
      body: '<path fill="currentColor" d="M21 12v-1h-3V5h-1V3h-1V2h-2V1h-4v1H8v1H7v2H6v6H3v1H2v10h1v1h18v-1h1V12zm-1 1v8H4v-8zM9 5V4h1V3h4v1h1v1h1v6H8V5z"/>'
    },
    "lock-alt": {
      body: '<path fill="currentColor" d="M20 12v-1h-2V5h-1V3h-1V2h-2V1h-4v1H8v1H7v2H6v6H4v1H3v10h1v1h16v-1h1V12zM9 5V4h1V3h4v1h1v1h1v6H8V5zM5 21v-8h14v8z"/>'
    },
    "lock-alt-solid": {
      body: '<path fill="currentColor" d="M20 12v-1h-1V6h-1V4h-1V3h-1V2h-2V1h-4v1H8v1H7v1H6v2H5v5H4v1H3v10h1v1h16v-1h1V12zM8 6h1V5h1V4h4v1h1v1h1v5H8z"/>'
    },
    "lock-open": {
      body: '<path fill="currentColor" d="M22 5V3h-1V2h-2V1h-4v1h-2v1h-1v2h-1v6H2v1H1v10h1v1h15v-1h1V12h-1v-1h-4V5h1V4h1V3h4v1h1v1h1v6h2V5zm-6 8v8H3v-8z"/><path fill="none" d="M0 0h24v24H0z"/>'
    },
    "lock-open-solid": {
      body: '<path fill="currentColor" d="M23 6v5h-3V6h-1V5h-4v1h-1v5h3v1h1v9h-1v1H2v-1H1v-9h1v-1h9V6h1V4h1V3h2V2h4v1h2v1h1v2z"/>'
    },
    "lock-solid": {
      body: '<path fill="currentColor" d="M21 12v-1h-3V5h-1V3h-1V2h-2V1h-4v1H8v1H7v2H6v6H3v1H2v10h1v1h18v-1h1V12zm-6-1H9V5h1V4h4v1h1z"/>'
    },
    login: {
      body: '<path fill="currentColor" d="M10 19v1H8v-2h1v-1h1v-1h1v-1h1v-1h1v-1H1v-2h12v-1h-1V9h-1V8h-1V7H9V6H8V4h2v1h1v1h1v1h1v1h1v1h1v1h1v1h1v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1zM21 2h2v20h-2z"/>'
    },
    "login-solid": {
      body: '<path fill="currentColor" d="M20 2h3v20h-3zM8 4h2v1h1v1h1v1h1v1h1v1h1v1h1v1h1v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H8v-1H7v-2h1v-1h1v-1h1v-1H1v-4h9V9H9V8H8V7H7V5h1z"/>'
    },
    logout: {
      body: '<path fill="currentColor" d="M14 4h2v1h1v1h1v1h1v1h1v1h1v1h1v1h1v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-2h1v-1h1v-1h1v-1h1v-1h1v-1H7v-2h12v-1h-1V9h-1V8h-1V7h-1V6h-1zM1 2h2v20H1z"/>'
    },
    "logout-solid": {
      body: '<path fill="currentColor" d="M14 5V4h2v1h1v1h1v1h1v1h1v1h1v1h1v1h1v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1h-1v-2h1v-1h1v-1h1v-1H7v-4h9V9h-1V8h-1V7h-1V5zM1 2h3v20H1z"/>'
    },
    "machine-learning": {
      body: '<path fill="currentColor" d="M23.505 9.502v2h-2v1h-2v-1h-2.001v1h1v1h1v1.001h2v-1h1v-1h1.001v4h-1v3.001h-1v1h-1v-1h-1v-1h-3.002v1h2v1h1.001v2h-1v1.001h-4.001v-1h-1v-1h-1v-4.001h1v-1h1v-3.001h-1v-1h-1V8.502h1V5.5h-1v-3h1v-1h3v1h2v1h1.001v1h1v2.001h-2v1h-1v1h-1v1h2v-1h1v-1h2v1h1v1zM11.502 19.504h-1v1h1zm-1-1h-1v1h1zm1-14.004h-1v1h1zm-1 1.001h-1v1h1zM6.501 9.502h-1v1h1zm1-1.001h-1v1h1zm2.001-1h-1v1h1zm-1-1h-1v1h1zm2 2h-1v1h1zm1 1.001h-1v1h1zm1.001 4.001h-1v1h1zm-1.001 1h-1v1h1zm-1 1h-1v1h1zm-1 1h-1v1h1zm-1 1h-1v1h1zm-1.001-2h-1v1h1zm-1-1h-1v1h1zm1 5.001v2h-1v1h-2v-1h-1v-2h1v-1h2v1zM5.5 11.502v2h-1v1h-2v-1h-1v-2h1v-1h2v1zM7.501 3.5v2h-1v1h-2v-1h-1v-2h1v-1h2v1z"/>'
    },
    management: {
      body: '<path fill="currentColor" d="M8.502 20.504v1H4.5v-3h1v2zm12.002-2v3h-3v-1h2v-2zm-4.001 3.001v2H9.502v-2h1v-1h2v-1h-1v-1.001h-1v-3h1v-1.001h3.001v1h1v3h-1v1.001h-1v1h2v1zm7.002-6.002v2h-7.002v-2h1v-1h2.001v-1h-1v-1h-1V9.501h1v-1h3v1h1v3h-1v1h-1v1h2v1.001zm-15.003 0v2H1.5v-2h1v-1h2v-1h-1v-1h-1V9.501h1v-1h3.001v1h1v3h-1v1h-1v1h2v1.001zm0-12.003v1H5.5v3.001h-1v-4zm12.002 0v4.001h-1v-3h-4v-1zm-5.001 5.002v2H8.502v-2h1v-1h2v-1h-1V5.5h-1v-3h1v-1h3v1h1.001v3h-1v1.001h-1v1h2v1z"/>'
    },
    mastodon: {
      body: '<path fill="currentColor" d="M22 7V4h-1V3h-1V2h-1V1H5v1H4v1H3v1H2v3H1v9h1v3h1v1h1v1h1v1h2v1h7v-1h2v-2H9v-1H8v-2h1v1h9v-1h2v-1h1v-1h1v-2h1V7zm-3 7h-3V7h-2v1h-1v4h-2V8h-1V7H8v7H5V6h1V5h1V4h3v1h1v1h2V5h1V4h3v1h1v1h1z"/>'
    },
    media: {
      body: '<path fill="currentColor" d="M19.504 21.505v1h-1v1H2.5v-1h-1V6.5h1v-1h1v15.003h1v1z"/><path fill="currentColor" d="M22.505 5.5v-1h-6.002v-1h-1v-1h-1v-1H6.5v1h-2v17.004h1v1h17.004v-1h1V5.501zm-7.002 7.002v1h1v1.001h1v1h1v1h1.001v1H6.501v-5h1v-1h1v-1.001h1v-1h1.001v-1h1v1h1v1h1v1h1v1zm-9.002-8h1v-1h2v1h1.001v2h-1v1h-2v-1h-1zm16.004 13.003h-1v-1h-1v-1h-1v-1.001h-1.001v-1h-1v-1h-1v-1h-1v-1.001h1v-1h1v-1h1v1h1v1h1v1h1v1h1z"/>'
    },
    "medical-house": {
      body: '<path fill="currentColor" d="M22 11v-1h-1V9h-1V8h-1V7h-1V6h-1V5h-1V4h-1V3h-1V2h-1V1h-2v1h-1v1H9v1H8v1H7v1H6v1H5v1H4v1H3v1H2v1H1v1h3v10h1v1h14v-1h1V12h3v-1Zm-3 0h-1v10H6V11H5v-1h1V9h1V8h1V7h1V6h1V5h1V4h2v1h1v1h1v1h1v1h1v1h1v1h1Z"/><path fill="currentColor" d="M16 12v2h-3v3h-2v-3H8v-2h3V9h2v3z"/>'
    },
    "medical-house-solid": {
      body: '<path fill="currentColor" d="M22 11v-1h-1V9h-1V8h-1V7h-1V6h-1V5h-1V4h-1V3h-1V2h-1V1h-2v1h-1v1H9v1H8v1H7v1H6v1H5v1H4v1H3v1H2v1H1v1h3v10h1v1h14v-1h1V12h3v-1ZM8 12h3V9h2v3h3v2h-3v3h-2v-3H8Z"/>'
    },
    merge: {
      body: '<path fill="currentColor" d="M21 11v-1h-4v1h-1v1h-5v-1H9v-1H8V9H7V7h1V6h1V2H8V1H4v1H3v4h1v1h1v10H4v1H3v4h1v1h4v-1h1v-4H8v-1H7v-6h1v1h1v1h2v1h5v1h1v1h4v-1h1v-4ZM5 3h2v2H5Zm2 18H5v-2h2Zm13-7h-2v-2h2Z"/>'
    },
    "merge-solid": {
      body: '<path fill="currentColor" d="M21 11v-1h-1V9h-3v1h-1v1h-5v-1H9V9H8V8H7V7h1V6h1V3H8V2H7V1H4v1H3v1H2v3h1v1h1v10H3v1H2v3h1v1h1v1h3v-1h1v-1h1v-3H8v-1H7v-6h1v1h1v1h2v1h5v1h1v1h3v-1h1v-1h1v-3ZM5 4V3h1v1h1v1H6v1H5V5H4V4Zm1 16v1H5v-1H4v-1h1v-1h1v1h1v1Zm13-7v1h-1v-1h-1v-1h1v-1h1v1h1v1Z"/>'
    },
    message: {
      body: '<path fill="currentColor" d="M22 2V1H2v1H1v16h1v1h6v4h1v-1h1v-1h1v-1h2v-1h9v-1h1V2zm-1 15H3V3h18z"/>'
    },
    "message-dots": {
      body: '<path fill="currentColor" d="M19 9v2h-1v1h-2v-1h-1V9h1V8h2v1zm-5 0v2h-1v1h-2v-1h-1V9h1V8h2v1zM9 9v2H8v1H6v-1H5V9h1V8h2v1z"/><path fill="currentColor" d="M22 2V1H2v1H1v16h1v1h6v4h1v-1h1v-1h1v-1h2v-1h9v-1h1V2zm-1 15H3V3h18z"/>'
    },
    "message-dots-solid": {
      body: '<path fill="currentColor" d="M22 2V1H2v1H1v16h1v1h6v4h1v-1h1v-1h1v-1h2v-1h9v-1h1V2zM9 11H8v1H6v-1H5V9h1V8h2v1h1zm5 0h-1v1h-2v-1h-1V9h1V8h2v1h1zm5 0h-1v1h-2v-1h-1V9h1V8h2v1h1z"/>'
    },
    "message-solid": {
      body: '<path fill="currentColor" d="M23 2v16h-1v1h-9v1h-2v1h-1v1H9v1H8v-4H2v-1H1V2h1V1h20v1z"/>'
    },
    minds: {
      body: '<path fill="currentColor" d="M15 18v4h-1v1h-4v-1H9v-4zm4-13v7h-1v1h-1v1h-1v3H8v-3H7v-1H6v-1H5V5h1V4h1V3h1V2h1V1h6v1h1v1h1v1h1v1z"/>'
    },
    minus: {
      body: '<path fill="currentColor" d="M1 11h22v2H1z"/>'
    },
    "minus-solid": {
      body: '<path fill="currentColor" d="M23 11v2h-1v1H2v-1H1v-2h1v-1h20v1z"/>'
    },
    mistral: {
      body: '<path fill="currentColor" d="M23 17v3h-9v-3h3v-3h-3v3h-4v-3H7v3h3v3H1v-3h3V4h3v3h3v3h4V7h3V4h3v13z"/>'
    },
    moon: {
      body: '<path fill="currentColor" d="M21 17v1h-2v1h-4v-1h-2v-1h-2v-1h-1v-2H9v-2H8V8h1V6h1V4h1V3h2V2h2V1h-5v1H8v1H6v1H5v1H4v2H3v2H2v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2zM8 20v-1H6v-2H5v-2H4V9h1V7h1V5h2v1H7v2H6v4h1v2h1v2h1v1h1v1h1v1h2v1h2v1h-5v-1z"/>'
    },
    "moon-solid": {
      body: '<path fill="currentColor" d="M22 17v2h-1v1h-1v1h-2v1h-2v1h-6v-1H8v-1H6v-1H5v-1H4v-2H3v-2H2V9h1V7h1V5h1V4h1V3h2V2h2V1h5v1h-2v1h-2v1h-1v2H9v2H8v4h1v2h1v2h1v1h2v1h2v1h4v-1h2v-1z"/>'
    },
    music: {
      body: '<path fill="currentColor" d="M21 1v1h-3v1h-3v1h-4v1H8v1H6v10H3v1H2v1H1v3h1v1h1v1h4v-1h1v-1h1V11h2v-1h4V9h3V8h2v5h-3v1h-1v1h-1v3h1v1h1v1h4v-1h1v-1h1V1zM3 21v-3h4v3zM18 6v1h-3v1h-4v1H8V7h3V6h4V5h3V4h3v2zm-1 12v-3h4v3z"/>'
    },
    "music-solid": {
      body: '<path fill="currentColor" d="M23 1v17h-1v1h-1v1h-4v-1h-1v-1h-1v-3h1v-1h1v-1h3V8h-2v1h-3v1h-4v1H9v10H8v1H7v1H3v-1H2v-1H1v-3h1v-1h1v-1h3V6h2V5h3V4h4V3h3V2h3V1z"/>'
    },
    newsbreak: {
      body: '<path fill="currentColor" d="M23 2v4h-1v6h-1v5h-1v1h-2v1h-2v1h-2v1h-2v-1h-1v-2h-1v-2H9v-2H8v1H7v1H6v1H5v2H4v1H3v1H2v1H1v-3h1v-4h1v-4h1V7h1V6h2V5h2V4h2V3h2v2h1v2h1v2h1v2h2V9h1V7h1V5h1V3h1V2z"/>'
    },
    newspaper: {
      body: '<path fill="currentColor" d="M22 6V5H3v1H2v1H1v11h1v1h20v-1h1V6zM4 17H3V7h1zm17 0H6V7h15z"/><path fill="currentColor" d="M14 14h5v2h-5zm0-3h5v2h-5zm0-3h5v2h-5zM7 8v5h6V8zm4 3H9v-1h2zm-4 3h6v2H7z"/>'
    },
    "newspaper-solid": {
      body: '<path fill="currentColor" d="M22 6V5H3v1H2v1H1v11h1v1h20v-1h1V6zM4 17H3V7h1zm8-2H6v-5h6zm9 0h-8v-1h8zm-8-2v-1h7v1zm8-2h-8v-1h8zm0-2H6V7h15z"/><path fill="currentColor" d="M7 11h4v3H7z"/>'
    },
    notebook: {
      body: '<path fill="currentColor" d="M22 3V2h-1V1H5v1H4v3H1v2h3v4H1v2h3v4H1v2h3v3h1v1h16v-1h1v-1h1V3ZM9 21H6V3h3Zm12-1h-1v1h-9V3h9v1h1Z"/>'
    },
    "notebook-solid": {
      body: '<path fill="currentColor" d="M23 3v18h-1v1h-1v1H11V1h10v1h1v1zM9 1v22H5v-1H4v-3H1v-2h3v-4H1v-2h3V7H1V5h3V2h1V1z"/>'
    },
    notion: {
      body: '<path fill="currentColor" d="M19 8v1h-1v9h-3v-1h-1v-2h-1v-2h-1v-1h-1v6h1v1H8v-1h1v-8H8V9h5v2h1v2h1v1h1V9h-1V8z"/><path fill="currentColor" d="M22 5V4h-1V3h-1V2h-1V1h-8v1H1v16h1v1h1v1h1v1h1v2h9v-1h8v-1h1V5ZM5 6V5H4V4H3V3h9V2h5v1h1v1h1v1h-8v1Zm16 14h-8v1H6V7h6V6h9Z"/>'
    },
    npm: {
      body: '<path fill="currentColor" d="M22 2V1H2v1H1v20h1v1h20v-1h1V2zM12 8v11H5V5h14v14h-3V8z"/>'
    },
    "numbered-list": {
      body: '<path fill="currentColor" d="M4 11h1v2H4zm0-3h1v1H2V8h1V6H2V5h1V4h1zm0 2v1H3v1H2v-2zm1 6v5H2v-1h2v-1H3v-1h1v-1H2v-1zm-2-3h1v1h1v1H2v-1h1zm6-7h14v1H9zm0 6h14v1H9zm0 6h14v1H9z"/>'
    },
    "numbered-list-solid": {
      body: '<path fill="currentColor" d="M5 8v1H2V8h1V6H2V5h1V4h1v4zm0 8v5H2v-1h2v-1H3v-1h1v-1H2v-1zm-2-3h1v1h1v1H2v-1h1zm1-2h1v2H4zm0-1v1H3v1H2v-2zm18 2h1v1h-1v1H10v-1H9v-1h1v-1h12zm0 6h1v1h-1v1H10v-1H9v-1h1v-1h12zm1-12v1h-1v1H10V7H9V6h1V5h12v1z"/><path fill="none" d="M0 0h24v24H0z"/>'
    },
    "octagon-check": {
      body: '<path fill="currentColor" d="M17 9v2h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1H9v-1H8v-1H7v-2h1v-1h2v1h2v-1h1V9h1V8h2v1z"/><path fill="currentColor" d="M22 8V7h-1V6h-1V5h-1V4h-1V3h-1V2h-1V1H8v1H7v1H6v1H5v1H4v1H3v1H2v1H1v8h1v1h1v1h1v1h1v1h1v1h1v1h1v1h8v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1V8zm-1 7h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H9v-1H8v-1H7v-1H6v-1H5v-1H4v-1H3V9h1V8h1V7h1V6h1V5h1V4h1V3h6v1h1v1h1v1h1v1h1v1h1v1h1z"/>'
    },
    "octagon-check-solid": {
      body: '<path fill="currentColor" d="M22 8V7h-1V6h-1V5h-1V4h-1V3h-1V2h-1V1H8v1H7v1H6v1H5v1H4v1H3v1H2v1H1v8h1v1h1v1h1v1h1v1h1v1h1v1h1v1h8v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1V8zm-12 2v1h2v-1h1V9h1V8h2v1h1v2h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1H9v-1H8v-1H7v-2h1v-1z"/>'
    },
    "octagon-times": {
      body: '<path fill="currentColor" d="M17 8v2h-1v1h-1v2h1v1h1v2h-1v1h-2v-1h-1v-1h-2v1h-1v1H8v-1H7v-2h1v-1h1v-2H8v-1H7V8h1V7h2v1h1v1h2V8h1V7h2v1z"/><path fill="currentColor" d="M22 8V7h-1V6h-1V5h-1V4h-1V3h-1V2h-1V1H8v1H7v1H6v1H5v1H4v1H3v1H2v1H1v8h1v1h1v1h1v1h1v1h1v1h1v1h1v1h8v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1V8zm-2 7v1h-1v1h-1v1h-1v1h-1v1h-1v1H9v-1H8v-1H7v-1H6v-1H5v-1H4v-1H3V9h1V8h1V7h1V6h1V5h1V4h1V3h6v1h1v1h1v1h1v1h1v1h1v1h1v6z"/>'
    },
    "octagon-times-solid": {
      body: '<path fill="currentColor" d="M22 8V7h-1V6h-1V5h-1V4h-1V3h-1V2h-1V1H8v1H7v1H6v1H5v1H4v1H3v1H2v1H1v8h1v1h1v1h1v1h1v1h1v1h1v1h1v1h8v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1V8zm-6 9h-2v-1h-1v-1h-2v1h-1v1H8v-1H7v-2h1v-1h1v-2H8v-1H7V8h1V7h2v1h1v1h2V8h1V7h2v1h1v2h-1v1h-1v2h1v1h1v2h-1z"/>'
    },
    "open-ai": {
      body: '<path fill="currentColor" d="M22 8V7h-1V6h-2V4h-1V3h-1V2h-1V1h-5v1h-1v1H9V2H6v1H4v1H3v2H2v5H1v5h1v1h1v1h2v2h1v1h1v1h1v1h5v-1h1v-1h1v1h3v-1h2v-1h1v-2h1v-5h1V8ZM9 6h1V4h1V3h5v1h1v1h-5v1h-1v1h-1v2H9v2H8V8h1ZM5 17v-1H4v-1H3v-4h1v2h1v2h8v1h-1v1Zm10 1h-1v2h-1v1H8v-1H7v-1h5v-1h1v-1h1v-2h1v-2h1v3h-1Zm5 0h-1v1h-1v1h-2v-2h1v-2h1v-2h-1v-2h-1v-1h-1v1h-1v2h-4v-1H9v1H7v-1H6v-1H5v-2H4V6h1V5h1V4h2v2H7v2H6v2h1v2h1v1h1v-1h1v-2h4v1h1v-1h2v1h1v1h1v2h1Zm1-5h-1v-2h-1V9h-8V8h1V7h7v1h1v1h1Z"/>'
    },
    outdent: {
      body: '<path fill="currentColor" d="M11 8h12v1H11zm0 7h12v1H11zM1 21h22v1H1zM8 7V6H6v1H5v1H4v1H3v1H2v1H1v2h1v1h1v1h1v1h1v1h1v1h2v-1h1V7Zm0 9H6v-1H5v-1H4v-1H3v-2h1v-1h1V9h1V8h2ZM1 2h22v1H1z"/>'
    },
    "outdent-solid": {
      body: '<path fill="currentColor" d="M9 7v10H8v1H6v-1H5v-1H4v-1H3v-1H2v-1H1v-2h1v-1h1V9h1V8h1V7h1V6h2v1zm13 1h1v1h-1v1H12V9h-1V8h1V7h10zm0 7h1v1h-1v1H12v-1h-1v-1h1v-1h10zm1-13v1h-1v1H2V3H1V2h1V1h20v1zm-1 19h1v1h-1v1H2v-1H1v-1h1v-1h20z"/>'
    },
    "page-break": {
      body: '<path fill="currentColor" d="M3 8V1h2v5h14V1h2v7zm-2 3h5v2H1zm9 0h4v2h-4zm11 5v7h-2v-5H5v5H3v-7zm-3-5h5v2h-5z"/>'
    },
    "page-break-solid": {
      body: '<path fill="currentColor" d="M1 11h5v2H1zm9 0h4v2h-4zm11 5v7h-3v-4H6v4H3v-7zm0-15v7H3V1h3v4h12V1zm-3 10h5v2h-5z"/><path fill="none" d="M0 0h24v24H0z"/>'
    },
    "paint-brush": {
      body: '<path fill="currentColor" d="M19 2V1H4v1H3v14h1v1h5v4h1v1h1v1h2v-1h1v-1h1v-4h4v-1h1V2Zm-6 19h-2v-2h2Zm5-7H5V3h2v2h2V3h2v4h2V3h5Z"/>'
    },
    "paint-brush-solid": {
      body: '<path fill="currentColor" d="M20 2v10H3V2h1V1h3v3h2V1h2v5h2V1h6v1zM3 14v2h1v1h5v4h1v1h1v1h2v-1h1v-1h1v-4h4v-1h1v-2Zm8 7v-2h2v2Z"/>'
    },
    paperclip: {
      body: '<path fill="currentColor" d="M21 4v5h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H8v-1H7v-1H6v-3h1v-1h1v-1h1v-1h1v-1h1V9h1V8h1V7h1V6h1V5h1v1h1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H9v1H8v1h1v1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1V9h1V8h1V5h-1V4h-1V3h-3v1h-1v1h-1v1h-1v1h-1v1H9v1H8v1H7v1H6v1H5v1H4v5h1v1h1v1h1v1h5v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h2v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H7v-1H5v-1H4v-1H3v-2H2v-6h1v-1h1v-1h1V9h1V8h1V7h1V6h1V5h1V4h1V3h1V2h2V1h4v1h1v1h1v1z"/>'
    },
    "paperclip-solid": {
      body: '<path fill="currentColor" d="M21 4v5h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H8v-1H7v-1H6v-3h1v-1h1v-1h1v-1h1v-1h1V9h1V8h1V7h1V6h1V5h1v1h1v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H9v1h2v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1V9h1V5h-1V4h-3v1h-1v1h-1v1h-1v1h-1v1H9v1H8v1H7v1H6v1H5v5h1v1h1v1h5v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v1h1v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H7v-1H5v-1H4v-1H3v-2H2v-6h1v-1h1v-1h1V9h1V8h1V7h1V6h1V5h1V4h1V3h1V2h2V1h4v1h1v1h1v1z"/>'
    },
    paragraph: {
      body: '<path fill="currentColor" d="M7 1v1H5v1H4v1H3v2H2v6h1v2h1v1h1v1h2v1h4v6h2V3h3v20h2V3h4V1zm4 14H7v-1H5v-2H4V6h1V4h2V3h4z"/>'
    },
    "paragraph-solid": {
      body: '<path fill="currentColor" d="M22 1v3h-3v19h-3V4h-2v19h-3v-6H7v-1H5v-1H4v-1H3v-2H2V6h1V4h1V3h1V2h2V1z"/>'
    },
    pause: {
      body: '<path fill="currentColor" d="M9 1H2v1H1v20h1v1h7v-1h1V2H9zM8 3v18H3V3zm14-1V1h-7v1h-1v20h1v1h7v-1h1V2zm-1 1v18h-5V3z"/>'
    },
    "pause-solid": {
      body: '<path fill="currentColor" d="M23 2v20h-1v1h-7v-1h-1V2h1V1h7v1zM9 2h1v20H9v1H2v-1H1V2h1V1h7z"/>'
    },
    pc: {
      body: '<path fill="currentColor" d="M19 16h1v1h-1z"/><path fill="currentColor" d="M22 4V3h-5v1h-1v16h1v1h5v-1h1V4Zm-4 10h3v5h-3Zm0-2v-2h3v2Zm0-4V6h3v2ZM4 19h10v2H4zM3 5v10h11v2H2v-1H1V4h1V3h12v2z"/>'
    },
    "pc-solid": {
      body: '<path fill="currentColor" d="M19 16h1v1h-1z"/><path fill="currentColor" d="M22 4V3h-5v1h-1v16h1v1h5v-1h1V4Zm-1 15h-3v-5h3Zm0-7h-3v-2h3Zm0-4h-3V6h3ZM4 18h10v3H4zM14 3v3H4v7h10v3H2v-1H1V4h1V3z"/>'
    },
    pen: {
      body: '<path fill="currentColor" d="M23 5v2h-1v1h-1v1h-1v1h-1V9h-1V8h-1V7h-1V6h-1V5h-1V4h1V3h1V2h1V1h2v1h1v1h1v1h1v1zm-6 5V9h-1V8h-1V7h-1V6h-2v1h-1v1h-1v1H9v1H8v1H7v1H6v1H5v1H4v1H3v1H2v1H1v6h6v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-2zm-2 2v1h-1v1h-1v1h-1v1h-1v1h-1v1H9v1H8v1H7v1H3v-4h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1V9h1V8h2v1h1v1h1v2z"/>'
    },
    "pen-nib": {
      body: '<path fill="currentColor" d="M22 4V3h-1V2h-1V1h-3v1h-1v1h-1v1h-1v1h-2v1H9v1H6v1H5v2H4v3H3v3H2v3H1v3h1v1h3v-1h3v-1h3v-1h3v-1h2v-1h1v-3h1v-3h1v-2h1V9h1V8h1V7h1V4zm-6 8v3h-1v2h-1v1h-3v1H8v1H6v-1h1v-1h1v-1h1v-1h3v-3h-1v-1H8v3H7v1H6v1H5v1H4v-2h1v-3h1v-3h1V9h2V8h3V7h3v1h1v1h1v3z"/>'
    },
    "pen-nib-solid": {
      body: '<path fill="currentColor" d="M23 4v3h-1v1h-1v1h-1v1h-1V9h-1V8h-1V7h-1V6h-1V5h-1V4h1V3h1V2h1V1h3v1h1v1h1v1zm-5 7h1v1h-1v3h-1v3h-1v1h-2v1h-3v1H8v1H5v1H3v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h3v-3h-1v-1H8v3H7v1H6v1H5v1H4v1H3v1H2v1H1v-2h1v-3h1v-3h1v-3h1V8h1V7h3V6h3V5h1v1h1v1h1v1h1v1h1v1h1z"/>'
    },
    "pen-solid": {
      body: '<path fill="currentColor" d="M17 10h1v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H9v1H8v1H7v1H1v-6h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1V9h1V8h1V7h1V6h2v1h1v1h1v1h1zm6-5v2h-1v1h-1v1h-1v1h-1V9h-1V8h-1V7h-1V6h-1V5h-1V4h1V3h1V2h1V1h2v1h1v1h1v1h1v1z"/>'
    },
    pencil: {
      body: '<path fill="currentColor" d="M22 4V3h-1V2h-1V1h-4v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H9v1H8v1H7v1H6v1H5v1H4v1H3v1H2v1H1v7h7v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1V9h1V8h1V4zM8 20H7v1H4v-1H3v-3h1v-1h1v1h1v1h1v1h1zm9-9h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H9v-1H8v-1H7v-1H6v-1h1v-1h1v-1h1v-1h1v-1h1V9h1V8h1V7h2v1h1v1h1zm1-3V7h-1V6h-1V4h1V3h2v1h1v1h1v2h-1v1z"/>'
    },
    "pencil-ruler": {
      body: '<path fill="currentColor" d="M19 11v-1h1V9h1V8h1V7h1V4h-1V3h-1V2h-1V1h-3v1h-1v1h-1v1h-1v1h-1v1h-2V5h-1V4H9V3H8V2H7V1H5v1H4v1H3v1H2v1H1v2h1v1h1v1h1v1h1v1h1v2H5v1H4v1H3v1H2v1H1v6h6v-1h1v-1h1v-1h1v-1h1v-1h2v1h1v1h1v1h1v1h1v1h2v-1h1v-1h1v-1h1v-1h1v-2h-1v-1h-1v-1h-1v-1h-1v-1h-1v-2zM7 10V9H6V8H5V7H4V5h1V4h2v1h1v1H7v1h1v1h1V7h1v2H9v1zm6 3v1h-1v1h-1v1h-1v1H9v1H8v1H7v1H6v1H3v-3h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1V9h1V8h1V7h1v1h1v1h1v1h-1v1h-1v1h-1v1zm6 3v1h1v2h-1v1h-2v-1h-1v-1h-1v-1h-1v-2h1v-1h2v1h-1v1h1v1h1v-1zm-2-9V6h-1V5h1V4h1V3h1v1h1v1h1v1h-1v1h-1v1h-1V7z"/>'
    },
    "pencil-ruler-solid": {
      body: '<path fill="currentColor" d="M2 7H1V5h1V4h1V3h1V2h1V1h2v1h1v2H7v1H6v1h1v1h1V6h1V5h2v1h-1v1H9v1H8v1H7v1H6v1H5v-1H4V9H3V8H2zm11 10h-1v1h-1v1h-1v1H9v1H8v1H7v1H1v-6h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1V9h1V8h1V7h1V6h2v1h1v1h1v1h1v1h1v2h-1v1h-1v1h-1v1h-1v1h-1zM23 4v3h-1v1h-1v1h-2V8h-1V7h-1V6h-1V5h-1V3h1V2h1V1h3v1h1v1h1v1zm-1 13h1v2h-1v1h-1v1h-1v1h-1v1h-2v-1h-1v-1h-1v-1h-1v-1h-1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v2h-1v1h-1v1h1v1h1v-1h1v-1h2z"/>'
    },
    "pencil-solid": {
      body: '<path fill="currentColor" d="M8 20h1v1H8v1H7v1H1v-6h1v-1h1v-1h1v1h1v1h1v1h1v1h1zm9-10h1v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v-1H9v-1H8v-1H7v-1H6v-1H5v-1h1v-1h1v-1h1v-1h1V9h1V8h1V7h1V6h2v1h1v1h1v1h1zm6-6v3h-1v1h-1v1h-2V8h-1V7h-1V6h-1V5h-1V3h1V2h1V1h3v1h1v1h1v1z"/>'
    },
    "people-carry": {
      body: '<path fill="currentColor" d="M3 3h1v2H3zm1-1h2v1H4zm0 3h2v1H4zm2-2h1v2H6zM3 17h1v1H3v2H1v-3h1v-1h1z"/><path fill="currentColor" d="M20 15h1v-1h1v-3h-1V8h-1V7h-2v1h-1v2h-1v1h-1V7H9v4H8v-1H7V8H6V7H4v1H3v3H2v3h1v1h1v1h1v4h1v1h1v-1h1v-3H7v-3H6v-2h1v1h1v1h8v-1h1v-1h1v2h-1v3h-1v3h1v1h1v-1h1v-4h1zm-6-2h-4V8h4z"/><path fill="currentColor" d="M23 17v3h-2v-2h-1v-1h1v-1h1v1zM17 3h1v2h-1zm1-1h2v1h-2zm0 3h2v1h-2zm2-2h1v2h-1z"/>'
    },
    "people-carry-solid": {
      body: '<path fill="currentColor" d="M3 17h1v1H3v2H1v-3h1v-1h1zM4 5H3V3h1V2h2v1h1v2H6v1H4zm19 12v3h-2v-2h-1v-1h1v-1h1v1z"/><path fill="currentColor" d="M20 16h-1v4h-1v1h-1v-1h-1v-3h1v-3h1v-2h-1v1h-1v1H8v-1H7v-1H6v2h1v3h1v3H7v1H6v-1H5v-4H4v-1H3v-1H2v-3h1V8h1V7h2v1h1v2h1v1h1V7h6v4h1v-1h1V8h1V7h2v1h1v3h1v3h-1v1h-1zM18 5h-1V3h1V2h2v1h1v2h-1v1h-2z"/>'
    },
    perplexity: {
      body: '<path fill="currentColor" d="M19 8V1h-1v1h-1v1h-1v1h-1v1h-1v1h-1V1h-2v5h-1V5H9V4H8V3H7V2H6V1H5v7H2v9h3v6h1v-1h1v-1h1v-1h1v-1h1v-1h1v5h2v-5h1v1h1v1h1v1h1v1h1v1h1v-6h3V8ZM5 13v3H3V9h6v1H8v1H7v1H6v1Zm6 3h-1v1H9v1H8v1H7v1H6v-6h1v-1h1v-1h1v-1h1v-1h1Zm0-8H6V4h1v1h1v1h1v1h2Zm3-1h1V6h1V5h1V4h1v4h-4Zm4 13h-1v-1h-1v-1h-1v-1h-1v-1h-1v-6h1v1h1v1h1v1h1v1h1Zm3-4h-2v-3h-1v-1h-1v-1h-1v-1h-1V9h6Z"/>'
    },
    "phone-ringing-high": {
      body: '<path fill="currentColor" d="M12 10h2v2h-2zm6-1h1v3h-2v-2h-1V9h-1V8h-1V7h-2V5h3v1h1v1h1v1h1z"/><path fill="currentColor" d="M23 8v4h-2V8h-1V7h-1V6h-1V5h-1V4h-1V3h-4V1h4v1h2v1h1v1h1v1h1v1h1v2zm-1 9v-1h-1v-1h-2v-1h-3v1h-1v1h-3v-1h-1v-1h-1v-1H9v-1H8V9h1V8h1V5H9V3H8V2H7V1H4v1H2v1H1v5h1v4h1v2h1v1h1v1h1v1h1v1h1v1h1v1h1v1h2v1h4v1h5v-1h1v-2h1v-3zm-2 3v1h-4v-1h-4v-1h-2v-1H9v-1H8v-1H7v-1H6v-1H5v-2H4V8H3V4h1V3h3v2h1v3H7v1H6v3h1v1h1v1h1v1h1v1h1v1h1v1h3v-1h1v-1h3v1h2v3z"/>'
    },
    "phone-ringing-high-solid": {
      body: '<path fill="currentColor" d="M12 7V5h3v1h1v1h1v1h1v1h1v3h-2v-2h-1V9h-1V8h-1V7zm0 3h2v2h-2z"/><path fill="currentColor" d="M23 8v4h-2V8h-1V7h-1V6h-1V5h-1V4h-1V3h-4V1h4v1h2v1h1v1h1v1h1v1h1v2zm-1 9h1v3h-1v2h-1v1h-5v-1h-4v-1h-2v-1H9v-1H8v-1H7v-1H6v-1H5v-1H4v-1H3v-2H2V8H1V3h1V2h2V1h3v1h1v1h1v2h1v3H9v1H8v3h1v1h1v1h1v1h1v1h3v-1h1v-1h3v1h2v1h1z"/>'
    },
    "phone-ringing-low": {
      body: '<path fill="currentColor" d="M12 7V5h3v1h1v1h1v1h1v1h1v3h-2v-2h-1V9h-1V8h-1V7z"/><path fill="currentColor" d="M22 17v-1h-1v-1h-2v-1h-3v1h-1v1h-3v-1h-1v-1h-1v-1H9v-1H8V9h1V8h1V5H9V3H8V2H7V1H4v1H2v1H1v5h1v4h1v2h1v1h1v1h1v1h1v1h1v1h1v1h1v1h2v1h4v1h5v-1h1v-2h1v-3zm-1 3h-1v1h-4v-1h-4v-1h-2v-1H9v-1H8v-1H7v-1H6v-1H5v-2H4V8H3V4h1V3h3v2h1v3H7v1H6v3h1v1h1v1h1v1h1v1h1v1h1v1h3v-1h1v-1h3v1h2z"/>'
    },
    "phone-ringing-low-solid": {
      body: '<path fill="currentColor" d="M12 7V5h3v1h1v1h1v1h1v1h1v3h-2v-2h-1V9h-1V8h-1V7z"/><path fill="currentColor" d="M23 17v3h-1v2h-1v1h-5v-1h-4v-1h-2v-1H9v-1H8v-1H7v-1H6v-1H5v-1H4v-1H3v-2H2V8H1V3h1V2h2V1h3v1h1v1h1v2h1v3H9v1H8v3h1v1h1v1h1v1h1v1h3v-1h1v-1h3v1h2v1h1v1z"/>'
    },
    pinterest: {
      body: '<path fill="currentColor" d="M23 9v6h-1v2h-1v2h-1v1h-1v1h-2v1h-2v1H9v-2h1v-3h1v-1h1v1h4v-1h1v-1h1v-2h1v-4h-1V8h-1V7h-1V6h-2V5h-4v1H8v1H7v1H6v2H5v4h1v1h1v1h1v-2H7v-4h1V8h2V7h4v1h2v1h1v5h-1v1h-1v1h-4v-2h1V9h-2v1H9v7H8v3H7v1H5v-1H4v-1H3v-2H2v-2H1V9h1V7h1V5h1V4h1V3h2V2h2V1h6v1h2v1h2v1h1v1h1v2h1v2z"/>'
    },
    plane: {
      body: '<path fill="currentColor" d="M22 11v-1h-7V9h-1V7h-1V6h-1V4h-1V3h-1V2H7v3h1v3h1v2H5V9H4V8H3V7H1v3h1v4H1v3h2v-1h1v-1h1v-1h4v2H8v3H7v3h3v-1h1v-1h1v-2h1v-1h1v-2h1v-1h7v-1h1v-2zm-8 2v1h-1v2h-1v1h-1v2h-1v1H9v1H8v-1h1v-3h1v-4H4v1H3v-4h1v1h6V7H9V4H8V3h1v1h1v1h1v2h1v1h1v2h1v1h7v2z"/>'
    },
    "plane-departure": {
      body: '<path fill="currentColor" d="M1 18h22v2H1zM19 4v1h-2v1h-2v1h-2V6h-2V5H9V4H7V3H6v1H5v1H4v1h1v1h1v1h1v1h1v1H7v1H5v-1H4V9H1v3h1v1h1v1h1v1h6v-1h2v-1h2v-1h2v-1h2v-1h2V9h2V8h1V4zm3 3h-1v1h-2v1h-2v1h-2v1h-2v1h-2v1H9v1H5v-1H4v-1H3v-1H2v-1h1v1h1v1h4v-1h1V8H8V7H7V6H6V5h2v1h2v1h2v1h4V7h2V6h2V5h2z"/>'
    },
    "plane-departure-solid": {
      body: '<path fill="currentColor" d="M23 4v4h-1v1h-2v1h-2v1h-2v1h-2v1h-2v1h-2v1H4v-1H3v-1H2v-1H1v-2h1V9h2v1h1v1h2v-1h1V9H7V8H6V7H5V6H4V5h1V4h1V3h1v1h2v1h2v1h2v1h2V6h2V5h2V4zM1 18h22v2H1z"/>'
    },
    "plane-solid": {
      body: '<path fill="currentColor" d="M23 11v2h-1v1h-7v1h-1v2h-1v1h-1v2h-1v1h-1v1H7v-3h1v-3h1v-2H5v1H4v1H3v1H1v-3h1v-4H1V7h2v1h1v1h1v1h4V8H8V5H7V2h3v1h1v1h1v2h1v1h1v2h1v1h7v1z"/>'
    },
    play: {
      body: '<path fill="currentColor" d="M21 11v-1h-1V9h-2V8h-2V7h-1V6h-2V5h-2V4h-1V3H8V2H6V1H3v1H2v20h1v1h3v-1h2v-1h2v-1h1v-1h2v-1h2v-1h1v-1h2v-1h2v-1h1v-1h1v-2zm-2 2h-2v1h-2v1h-1v1h-2v1h-2v1H9v1H7v1H5v1H4V3h1v1h2v1h2v1h1v1h2v1h2v1h1v1h2v1h2z"/>'
    },
    "play-solid": {
      body: '<path fill="currentColor" d="M22 11v2h-1v1h-1v1h-2v1h-2v1h-1v1h-2v1h-2v1h-1v1H8v1H6v1H3v-1H2V2h1V1h3v1h2v1h2v1h1v1h2v1h2v1h1v1h2v1h2v1h1v1z"/>'
    },
    playlist: {
      body: '<path fill="currentColor" d="M21 1v1h-2v1h-2v1h-1v12h-4v1h-2v1H9v3h1v1h2v1h5v-1h1v-1h1V8h2V7h2V1zM11 20v-1h1v-1h5v2h-1v1h-4v-1zm8-14v1h-1V5h1V4h2v2zM1 15h6v2H1z"/><path fill="currentColor" d="M1 9h12v2H1zm0-6h12v2H1z"/>'
    },
    "playlist-solid": {
      body: '<path fill="currentColor" d="M1 3h12v3H1zm0 6h12v3H1zm0 6h6v3H1z"/><path fill="currentColor" d="M23 1v6h-2v1h-2v13h-1v1h-1v1h-5v-1h-2v-1H9v-3h1v-1h2v-1h4V4h1V3h2V2h2V1z"/>'
    },
    plus: {
      body: '<path fill="currentColor" d="M23 11v2H13v10h-2V13H1v-2h10V1h2v10z"/>'
    },
    "plus-solid": {
      body: '<path fill="currentColor" d="M23 11v2h-1v1h-8v8h-1v1h-2v-1h-1v-8H2v-1H1v-2h1v-1h8V2h1V1h2v1h1v8h8v1z"/>'
    },
    podcasts: {
      body: '<path fill="currentColor" d="M9 14H8v-2h3v-1H8V9h3V8H8V6h3V5H8V3h1V2h1V1h4v1h1v1h1v2h-3v1h3v2h-3v1h3v2h-3v1h3v2h-1v1h-1v1h-4v-1H9z"/><path fill="currentColor" d="M19 12v3h-1v2h-1v1h-2v1h-2v2h3v2H8v-2h3v-2H9v-1H7v-1H6v-2H5v-3h1v2h1v2h1v1h2v1h4v-1h2v-1h1v-2h1v-2z"/>'
    },
    print: {
      body: '<path fill="currentColor" d="M18 12h2v1h-2zm2-9v5h-2V4h-1V3H6v5H4V1h14v1h1v1z"/><path fill="currentColor" d="M1 9v8h3v6h16v-6h3V9zm17 12H6v-5h12zm3-6h-2v-1H5v1H3v-4h18z"/>'
    },
    "print-solid": {
      body: '<path fill="currentColor" d="M20 3v5h-3V5h-1V4H7v4H4V1h14v1h1v1zM1 9v8h3v6h16v-6h3V9zm16 11H7v-4h10zm1-8h2v1h-2z"/>'
    },
    pro: {
      body: '<path fill="currentColor" d="M22 5V4H2v1H1v14h1v1h20v-1h1V5zm0 13H2V6h20z"/><path fill="currentColor" d="M15 9v6h6V9zm4 4h-2v-2h2zM9 9v6h2v-1h1v1h2v-2h-1v-1h1V9zm2 3v-2h1v2zM3 9v6h2v-2h3V9zm2 3v-2h1v2z"/>'
    },
    "pro-solid": {
      body: '<path fill="currentColor" d="M17 11h2v2h-2zm-6-1h1v2h-1z"/><path fill="currentColor" d="M22 5V4H2v1H1v14h1v1h20v-1h1V5zm-1 10h-6V9h6zm-7-3h-1v1h1v2h-2v-1h-1v1H9V9h5zM8 9v4H5v2H3V9z"/><path fill="currentColor" d="M5 10h1v2H5z"/>'
    },
    "product-hunt": {
      body: '<path fill="currentColor" d="M15 9v2h-1v1h-4V8h4v1z"/><path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9zm-6 4h-2v1h-4v4H8V6h6v1h2v1h1v4h-1z"/>'
    },
    "product-management": {
      body: '<path fill="currentColor" d="M16.503 4.5v-1h-2v2H4.501v-2h-2v1H1.5v18.005h1v1h13.003v-1h-1v-1h1v-1h-1v-2.001h1v-1h-1v-1h1v-1h1v-1.001h1V4.501zm-4 14.004H8.502v-2h4zm0 3H3.5v-1h9.003zM3.5 8.503h1v1h1v-1h1.001v-1h1v1h-1v1h-1v1h-1v-1h-1zm0 4h1v1h1v-1h1.001v-1h1v1h-1v1h-1v1.001h-1v-1h-1zm1 4.001v1h1v-1h1.001v-1h1v1h-1v1h-1v1h-1v-1h-1v-1zm11.003-3h-1v1H8.502v-2h7.001zm0-3H8.502V8.501h7.001z"/><path fill="currentColor" d="M23.505 17.503v-1h-1v-1h-1v1h-1v-1h-2.001v1h-1v-1h-1v1h-1v1h1v1h-1v2.001h1v1h-1v1h1v1h1v-1h1v1h2v-1h1v1h1v-1h1.001v-1h-1v-1h1v-2h-1v-1zm-3 3.001h-2.001v-2h2zM13.503 2.5v2H5.5v-2h1v-1h6.001v1z"/>'
    },
    programming: {
      body: '<path fill="currentColor" d="M1.5 6.501v15.003h1v1h1v1h18.005v-1h1v-1h1V6.501zm8.002 3h-1v1h-1v2.001h-1v1H5.5v2.001h1v1h1v2h1v1h1v1.001h-2v-1h-1v-1h-1v-2h-1v-1.001h-1v-2h1v-1h1v-2.001h1v-1h1v-1h2zm5.001 3.001h-1v4.001h-1v4.001h-1v1h-1.001v-5h1v-3.001h1V8.5h1v-1h1.001zm7.002 3.001h-1v1h-1v2h-1.001v1h-1v1.001h-2v-1h1v-1h1v-2h1v-1.001h1v-2h-1v-1h-1v-2.001h-1v-1h-1v-1h2v1h1v1h1v2h1v1h1zm1-12.003v-1h-1v-1H3.5v1h-1v1h-1v2h22.005v-2zM4.5 4.5v-2h2v2zm3 0v-2h2v2zm3.001 0v-2h2v2z"/>'
    },
    "pull-request": {
      body: '<path fill="currentColor" d="M20 18v-1h-1V3h-4V1h-1v1h-1v1h-2v2h2v1h1v1h1V5h2v12h-1v1h-1v4h1v1h4v-1h1v-4Zm-1 1v2h-2v-2ZM8 2V1H4v1H3v4h1v1h1v10H4v1H3v4h1v1h4v-1h1v-4H8v-1H7V7h1V6h1V2ZM5 5V3h2v2Zm2 14v2H5v-2Z"/>'
    },
    "pull-request-solid": {
      body: '<path fill="currentColor" d="M21 18v-1h-1V4h-1V3h-4V1h-1v1h-1v1h-1v1h-1v1h1v1h1v1h1v1h1V6h2v11h-1v1h-1v3h1v1h1v1h3v-1h1v-1h1v-3Zm-2 2v1h-1v-1h-1v-1h1v-1h1v1h1v1ZM8 3V2H7V1H4v1H3v1H2v3h1v1h1v10H3v1H2v3h1v1h1v1h3v-1h1v-1h1v-3H8v-1H7V7h1V6h1V3ZM7 5H6v1H5V5H4V4h1V3h1v1h1Zm0 14v1H6v1H5v-1H4v-1h1v-1h1v1Z"/>'
    },
    question: {
      body: '<path fill="currentColor" d="M10 18h3v3h-3zm7-13v6h-1v1h-1v1h-2v2h-3v-3h1v-1h2v-1h1V6h-4v1H9v1H7V5h1V4h1V3h6v1h1v1z"/>'
    },
    "question-circle": {
      body: '<path fill="currentColor" d="M11 17h2v2h-2zm5-10v4h-1v1h-1v1h-1v2h-2v-3h1v-1h1v-1h1V8h-1V7h-2v1h-1v1H8V7h1V6h1V5h4v1h1v1z"/><path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9Zm-2 6v2h-1v1h-1v1h-1v1h-2v1H9v-1H7v-1H6v-1H5v-1H4v-2H3V9h1V7h1V6h1V5h1V4h2V3h6v1h2v1h1v1h1v1h1v2h1v6Z"/>'
    },
    "question-circle-solid": {
      body: '<path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9Zm-9 10h-2v-2h2Zm3-8h-1v1h-1v1h-1v2h-2v-3h1v-1h1v-1h1V8h-1V7h-2v1h-1v1H8V7h1V6h1V5h4v1h1v1h1Z"/>'
    },
    "question-solid": {
      body: '<path fill="currentColor" d="M18 5v6h-1v1h-2v1h-1v2H9v-3h1v-1h1v-1h2V9h1V7h-1V6h-2v1h-1v1H9v1H8V8H7V7H6V6H5V5h1V4h1V3h2V2h6v1h1v1h1v1zm-5 13h1v3h-1v1h-3v-1H9v-3h1v-1h3z"/>'
    },
    "quote-left": {
      body: '<path fill="currentColor" d="M22 13v-1h-5V8h1V7h2V6h1V3h-1V2h-2v1h-2v1h-1v1h-1v2h-1v14h1v1h8v-1h1v-8zm-7 0h1v1h5v6h-6zm-5 0v-1H5V8h1V7h2V6h1V3H8V2H6v1H4v1H3v1H2v2H1v14h1v1h8v-1h1v-8zm-7 0h1v1h5v6H3z"/>'
    },
    "quote-left-solid": {
      body: '<path fill="currentColor" d="M10 13h1v8h-1v1H2v-1H1V7h1V5h1V4h1V3h2V2h2v1h1v3H8v1H6v1H5v4h5zm13 0v8h-1v1h-8v-1h-1V7h1V5h1V4h1V3h2V2h2v1h1v3h-1v1h-2v1h-1v4h5v1z"/>'
    },
    "quote-right": {
      body: '<path fill="currentColor" d="M10 2H2v1H1v8h1v1h5v4H6v1H4v1H3v3h1v1h2v-1h2v-1h1v-1h1v-2h1V3h-1zm-1 9H8v-1H3V4h6zm13-8V2h-8v1h-1v8h1v1h5v4h-1v1h-2v1h-1v3h1v1h2v-1h2v-1h1v-1h1v-2h1V3zm-7 7V4h6v7h-1v-1z"/>'
    },
    "quote-right-solid": {
      body: '<path fill="currentColor" d="M10 3h1v14h-1v2H9v1H8v1H6v1H4v-1H3v-3h1v-1h2v-1h1v-4H2v-1H1V3h1V2h8zm13 0v14h-1v2h-1v1h-1v1h-2v1h-2v-1h-1v-3h1v-1h2v-1h1v-4h-5v-1h-1V3h1V2h8v1z"/>'
    },
    receipt: {
      body: '<path fill="currentColor" d="M7 15h10v2H7zm0-4h10v2H7zm0-4h10v2H7z"/><path fill="currentColor" d="M19 1v1h-1v1h-1V2h-1V1h-2v1h-1v1h-2V2h-1V1H8v1H7v1H6V2H5V1H4v22h1v-1h1v-1h1v1h1v1h2v-1h1v-1h2v1h1v1h2v-1h1v-1h1v1h1v1h1V1zm-3 19v1h-2v-1h-1v-1h-2v1h-1v1H8v-1H7v-1H6V5h1V4h1V3h2v1h1v1h2V4h1V3h2v1h1v1h1v14h-1v1z"/>'
    },
    "receipt-solid": {
      body: '<path fill="currentColor" d="M19 1v1h-1v1h-1V2h-1V1h-2v1h-1v1h-2V2h-1V1H8v1H7v1H6V2H5V1H4v22h1v-1h1v-1h1v1h1v1h2v-1h1v-1h2v1h1v1h2v-1h1v-1h1v1h1v1h1V1zm-1 8H6V7h12zm0 4H6v-2h12zm0 4H6v-2h12z"/>'
    },
    reddit: {
      body: '<path fill="currentColor" d="M14 15h1v1h-1zm-1-3h2v2h-2zm-4 0h2v2H9zm0 3h1v1H9z"/><path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9zm-3 5h-1v1h-1v2h-1v1h-2v1h-4v-1H8v-1H7v-3H6v-1H5v-2h1v-1h2v1h1v-1h3V5h2v1h3v2h-2V7h-2v3h2v1h1v-1h2v1h1z"/><path fill="currentColor" d="M10 16h4v1h-4z"/>'
    },
    refresh: {
      body: '<path fill="currentColor" d="M23 14v1h-1v2h-1v2h-1v1h-1v1h-2v1h-2v1H9v-1H7v-1H5v-1H3v1H2v1H1v-7h7v1H7v1H6v2h1v1h2v1h6v-1h2v-1h2v-2h1v-3zm0-12v7h-7V8h1V7h1V5h-1V4h-2V3H9v1H7v1H5v2H4v3H1V9h1V7h1V5h1V4h1V3h2V2h2V1h6v1h2v1h2v1h2V3h1V2z"/>'
    },
    "refresh-solid": {
      body: '<path fill="currentColor" d="M23 14v1h-1v2h-1v2h-1v1h-1v1h-2v1h-2v1H9v-1H7v-1H5v-1H3v1H2v1H1v-8h8v1H8v1H7v2h1v1h2v1h4v-1h2v-1h1v-1h1v-2h1v-1zm0-12v8h-8V9h1V8h1V6h-1V5h-2V4h-4v1H8v1H7v1H6v2H5v1H1V9h1V7h1V5h1V4h1V3h2V2h2V1h6v1h2v1h2v1h2V3h1V2z"/>'
    },
    remote: {
      body: '<path fill="currentColor" d="M13.503 16.503h-2v1h2zm3 1v2H8.502v-2h3v1h2v-1zm1.001-4v3h-3.001v-1h-4.001v1h-3v-3zm-4.001-2.001h-2v1h2zM7.501 3.5v2h-1v1.001h-1v1h-1v-4z"/><path fill="currentColor" d="M22.505 11.502v-1h-1v-1h-1v-1h-1v-1h-1.001v-1h-1V5.5h-1v-1h-1v-1h-1.001v-1h-1v-1h-2v1h-1.001v1h-1v1h-1v1h-1v1.001h-1v1H5.5v1h-1v1h-1v1.001h-1v1h-1v1h3v11.003h16.004V12.503h3.001v-1zm-4.001 6.002h-1v2h-1v1H8.501v-1h-1v-2h-1v-4.001h1v-1h3v-2.001h4.001v2h3v1h1z"/>'
    },
    "retro-camera": {
      body: '<path fill="currentColor" d="M22 3V2H2v1H1v18h1v1h20v-1h1V3zM3 4h6v1H3zm7 16H3V10h7v1H8v2H7v4h1v2h2zm-1-3v-4h1v-1h4v1h1v4h-1v1h-4v-1zm12 3h-7v-1h2v-2h1v-4h-1v-2h-2v-1h7zm0-12H3V7h6V6h1V5h1V4h10z"/><path fill="currentColor" d="M13 13v1h-2v2h-1v-3z"/>'
    },
    "retro-camera-solid": {
      body: '<path fill="currentColor" d="M22 3V2H2v1H1v18h1v1h20v-1h1V3zM3 4h6v1H3zm14 13h-1v2h-2v1h-4v-1H8v-2H7v-4h1v-2h2v-1h4v1h2v2h1zm4-9H3V7h6V6h1V5h1V4h10z"/><path fill="currentColor" d="M15 13v4h-1v1h-4v-1H9v-4h1v3h1v-2h2v-1h-3v-1h4v1z"/>'
    },
    "retro-pc": {
      body: '<path fill="currentColor" d="M11 14h7v2h-7zm-5 0h2v2H6zm12-8v5h-1v1H7v-1H6V6h1V5h10v1z"/><path fill="currentColor" d="M21 3V2h-1V1H4v1H3v1H2v14h1v1h1v4h1v1h14v-1h1v-4h1v-1h1V3Zm-3 18H6v-2h12Zm2-5h-1v1H5v-1H4V4h1V3h14v1h1Z"/>'
    },
    "retro-pc-solid": {
      body: '<path fill="currentColor" d="M4 21h16v2H4zM21 3V2h-1V1H4v1H3v1H2v14h1v1h1v1h16v-1h1v-1h1V3ZM8 16H6v-2h2Zm10 0h-7v-2h7ZM6 12v-1H5V5h1V4h12v1h1v6h-1v1Z"/>'
    },
    robot: {
      body: '<path fill="currentColor" d="M14 15h3v1h-3zm-3 0h2v1h-2zm-4 0h3v1H7z"/><path fill="currentColor" d="M19 7h-1V6h-5V3h-2v3H6v1H5v1H4v10h1v1h1v1h12v-1h1v-1h1V8h-1zm-2 10v1H7v-1H6V9h1V8h10v1h1v8zm6-6v5h-1v1h-1v-7h1v1zM2 10h1v7H2v-1H1v-5h1z"/><path fill="currentColor" d="M14 10h3v3h-3zm-7 0h3v3H7z"/>'
    },
    "robot-solid": {
      body: '<path fill="currentColor" d="M2 10h1v7H2v-1H1v-5h1zm17-3h-1V6h-5V3h-2v3H6v1H5v1H4v10h1v1h1v1h12v-1h1v-1h1V8h-1zm-2 6h-3v-3h3zm-4 4h-2v-1h2zm-6-1h3v1H7zm0-6h3v3H7zm7 7v-1h3v1zm9-6v5h-1v1h-1v-7h1v1z"/>'
    },
    rss: {
      body: '<path fill="currentColor" d="M22 2V1H2v1H1v20h1v1h20v-1h1V2zm-6 16v-3h-1v-2h-1v-1h-1v-1h-1v-1h-1V9H9V8H7V7H4V4h3v1h2v1h2v1h2v1h1v1h1v1h1v1h1v2h1v2h1v2h1v3h-3v-2zm-5 0v-2h-1v-1H9v-1H8v-1H6v-1H4V9h2v1h2v1h2v1h1v1h1v1h1v2h1v2h1v2h-3v-2zm-7 1v-3h1v-1h3v1h1v3H8v1H5v-1z"/>'
    },
    save: {
      body: '<path fill="currentColor" d="M15 14v4h-1v1h-4v-1H9v-4h1v-1h4v1z"/><path fill="currentColor" d="M22 7V6h-1V5h-1V4h-1V3h-1V2h-1V1H2v1H1v20h1v1h20v-1h1V7zm-7 3V3h1v1h1v1h1v1h1v1h1v1h1v13H3V3h1v7zM6 3h7v5H6z"/>'
    },
    "save-solid": {
      body: '<path fill="currentColor" d="M22 7V6h-1V5h-1V4h-1V3h-1V2h-1V1H2v1H1v20h1v1h20v-1h1V7zM9 19v-4h1v-1h4v1h1v4h-1v1h-4v-1zm7-9H4V4h12z"/>'
    },
    science: {
      body: '<path fill="currentColor" d="M2.5 20.504h-1v2h1zm1-2h-1v2h1zm1-2.001h-1v2h1zm1-1h-1v1h1zm1.001-1h-1v1h1zm1-1h-1v1h1zm1.001-1.001h-1v1h1zm7.001 0h-1v1h1zm1 1.001h-1v1h1zm1.001 1h-1v1h1zm1 1h-1v1h1zm1 1h-1v2h1zm1 2.001h-1v2h1zm1.001 2h-1v2h1zm-1.001 2.001H2.5v1h18.004z"/><path fill="currentColor" d="M18.504 20.505v-2h-1v-2.001h-1v-1h-1v-1h-1.001v-1.001h-3v1h-1v1H6.5v1h-1v2.001h-1v2h-1v1h16.003v-1zM7.5 17.504h2v2h-2zm4.001-1h1v1h-1zM14.503 3.5h-1v9.002h1zm-5.001 0h-1v9.002h1zm6.001-1h-1v1h1zm-7.001 0h-1v1h1zm6.001-1H8.502v1h6.001z"/>'
    },
    search: {
      body: '<path fill="currentColor" d="M22 20v-1h-1v-1h-1v-1h-1v-1h-2v-1h1v-2h1V7h-1V5h-1V4h-1V3h-1V2h-2V1H7v1H5v1H4v1H3v1H2v2H1v6h1v2h1v1h1v1h1v1h2v1h6v-1h2v-1h1v2h1v1h1v1h1v1h1v1h2v-1h1v-2zm-10-5v1H8v-1H6v-1H5v-2H4V8h1V6h1V5h2V4h4v1h2v1h1v2h1v4h-1v2h-1v1z"/>'
    },
    "search-solid": {
      body: '<path fill="currentColor" d="M16 17h-1v1h-2v1H7v-1H5v-1H4v-1H3v-1H2v-2H1V7h1V5h1V4h1V3h1V2h2V1h6v1h2v1h1v1h1v1h1v2h1v6h-1v2h-1v1h-1zm7 3v2h-1v1h-2v-1h-1v-1h-1v-1h-1v-1h-1v-1h1v-1h1v-1h1v1h1v1h1v1h1v1z"/>'
    },
    seedlings: {
      body: '<path fill="currentColor" d="M18 2v1h-2v1h-2v1h-1v1h-1v2h1v2h1v2h2v-1h2v-1h2V9h1V8h1V6h1V2zm2 4v2h-2v1h-2v1h-1V8h-1V6h2V5h2V4h3v2zm-8 3h-1V8h-1V7H8V6H6V5H1v3h1v2h1v2h1v1h1v1h2v1h4v7h2V11h-1zm-7 3v-2H4V8H3V7h3v1h2v1h2v2h1v2H7v-1z"/>'
    },
    "seedlings-solid": {
      body: '<path fill="currentColor" d="M12 11h1v11h-2v-7H7v-1H5v-1H4v-1H3v-2H2V8H1V5h5v1h2v1h2v1h1v1h1zm11-9v4h-1v2h-1v1h-1v1h-2v1h-2v1h-2v-2h-1V8h-1V6h1V5h1V4h2V3h2V2z"/>'
    },
    shapes: {
      body: '<path fill="currentColor" d="M16 8V6h-1V4h-1V2h-1V1h-2v1h-1v2H9v2H8v2H7v2h10V8ZM9 9V7h1V5h1V3h2v2h1v2h1v2Zm13 4v-1h-8v1h-1v8h1v1h8v-1h1v-8Zm0 7h-1v1h-6v-1h-1v-6h1v-1h6v1h1Zm-12-5v-2H8v-1H4v1H2v2H1v4h1v2h2v1h4v-1h2v-2h1v-4Zm0 3H9v2H7v1H5v-1H3v-2H2v-2h1v-2h2v-1h2v1h2v2h1Z"/>'
    },
    "shapes-solid": {
      body: '<path fill="currentColor" d="M7 10V8h1V6h1V4h1V2h1V1h2v1h1v2h1v2h1v2h1v2zm16 3v8h-1v1h-8v-1h-1v-8h1v-1h8v1zm-13 2h1v4h-1v2H8v1H4v-1H2v-2H1v-4h1v-2h2v-1h4v1h2z"/>'
    },
    share: {
      body: '<path fill="currentColor" d="M20 9V8h1V6h1V4h-1V2h-1V1h-5v1h-1v2h-1v2h-1v1h-1v1h-1v1H9V8H4v1H3v2H2v2h1v2h1v1h5v-1h1v1h1v1h1v1h1v2h1v2h1v1h5v-1h1v-2h1v-2h-1v-2h-1v-1h-5v1h-2v-1h-1v-1h-1v-4h1V9h1V8h2v1zM9 13H8v1H5v-1H4v-2h1v-1h3v1h1zm6 5h1v-1h3v1h1v2h-1v1h-3v-1h-1zm0-14h1V3h3v1h1v2h-1v1h-3V6h-1z"/>'
    },
    "share-alt": {
      body: '<path fill="currentColor" d="M22 9V8h-1V7h-1V6h-1V5h-1V4h-1V3h-1V2h-2v1h-1v4H6v1H4v1H3v2H2v2H1v3h1v2h1v2h1v1h1v1h2v-2H6v-5h1v-2h6v4h1v1h2v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1V9Zm-2 2h-1v1h-1v1h-1v1h-1v1h-1v-4H6v1H5v3H3v-2h1v-2h1v-1h2V9h8V5h1v1h1v1h1v1h1v1h1Z"/>'
    },
    "share-alt-solid": {
      body: '<path fill="currentColor" d="M23 9v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1h-1v-4H7v2H6v5h1v2H5v-1H4v-1H3v-2H2v-2H1v-3h1v-2h1V9h1V8h2V7h7V3h1V2h2v1h1v1h1v1h1v1h1v1h1v1h1v1z"/>'
    },
    "share-solid": {
      body: '<path fill="currentColor" d="M22 4v2h-1v2h-1v1h-5V8h-2v1h-1v1h-1v4h1v1h1v1h2v-1h5v1h1v2h1v2h-1v2h-1v1h-5v-1h-1v-2h-1v-2h-1v-1h-1v-1h-1v-1H9v1H4v-1H3v-2H2v-2h1V9h1V8h5v1h1V8h1V7h1V6h1V4h1V2h1V1h5v1h1v2z"/>'
    },
    shop: {
      body: '<path fill="currentColor" d="M14 11v9h-1v1H4v-1H3v-9h2v5h7v-5zm5 0h2v10h-2zm3-4V6h-1V4h-1V3H4v1H3v2H2v1H1v2h1v1h20V9h1V7zM3 8V7h1V6h1V5h14v1h1v1h1v1z"/>'
    },
    "shop-solid": {
      body: '<path fill="currentColor" d="M23 7v2h-1v1H2V9H1V7h1V6h1V4h1V3h16v1h1v2h1v1zm-9 4v9h-1v1H4v-1H3v-9h2v5h7v-5zm5 0h2v10h-2z"/>'
    },
    "shopping-cart": {
      body: '<path fill="currentColor" d="M9 19h1v2H9v1H7v-1H6v-2h1v-1h2zm11 0h1v2h-1v1h-2v-1h-1v-2h1v-1h2zM4 3V2H1v2h3v3h1v5h1v4h1v1h13v-2H8v-2h12v-1h1V9h1V6h1V3zm16 3v3h-1v2H7V7H6V5h15v1z"/>'
    },
    "shopping-cart-solid": {
      body: '<path fill="currentColor" d="M9 19h1v2H9v1H7v-1H6v-2h1v-1h2zm11 0h1v2h-1v1h-2v-1h-1v-2h1v-1h2zm3-16v3h-1v3h-1v3h-1v1H8v2h12v2H7v-1H6v-4H5V7H4V4H1V2h3v1z"/>'
    },
    shuffle: {
      body: '<path fill="currentColor" d="M8 15h1v2H8v1H7v1H1v-2h6v-1h1zm13 1h1v2h-1v1h-1v1h-1v1h-1v-3h-4v-1h-1v-1h-1v-2h-1v-1h-1v-2H9v-1H8V8H7V7H1V5h7v1h1v2h1v2h1v1h1v2h1v1h1v2h4v-3h1v1h1v1h1z"/><path fill="currentColor" d="M22 5v2h-1v1h-1v1h-1v1h-1V7h-4v1h-1v1h-1V7h1V6h1V5h4V2h1v1h1v1h1v1z"/>'
    },
    "shuffle-solid": {
      body: '<path fill="currentColor" d="M8 14h1v3H8v1H7v1H1v-3h6v-1h1z"/><path fill="currentColor" d="M22 17h1v1h-1v1h-1v1h-1v1h-1v1h-1v-3h-4v-1h-1v-1h-1v-2h-1v-1h-1v-2H9v-1H8V9H7V8H1V5h7v1h1v2h1v2h1v1h1v2h1v1h1v2h4v-3h1v1h1v1h1v1h1z"/><path fill="currentColor" d="M23 6v1h-1v1h-1v1h-1v1h-1v1h-1V8h-4v1h-1v1h-1V7h1V6h1V5h4V2h1v1h1v1h1v1h1v1z"/>'
    },
    sia: {
      body: '<path fill="currentColor" d="M16 6v3H7v1H6v1h1v1h2v1h3v1h2v1h1v1h1v4h-3v-3h-1v-1H9v-1H6v-1H5v-1H4v-1H3V8h1V7h2V6zm5-5v5h-3V4h-2V1zM4 20h9v3H4z"/>'
    },
    "side-nav-collapse": {
      body: '<path fill="currentColor" d="M22 5V3h-2V2H4v1H2v2H1v14h1v2h2v1h16v-1h2v-2h1V5ZM7 19H5v-1H4V6h1V5h2Zm13-1h-1v1h-9V5h9v1h1Z"/><path fill="currentColor" d="M18 7v2h-1v1h-1v1h-1v2h1v1h1v1h1v2h-2v-1h-1v-1h-1v-1h-1v-1h-1v-2h1v-1h1V9h1V8h1V7z"/>'
    },
    "side-nav-collapse-solid": {
      body: '<path fill="currentColor" d="M22 5V3h-2V2H4v1H2v2H1v14h1v2h2v1h16v-1h2v-2h1V5Zm-2 13h-1v1h-9V5h9v1h1Z"/><path fill="currentColor" d="M18 7v2h-1v1h-1v1h-1v2h1v1h1v1h1v2h-2v-1h-1v-1h-1v-1h-1v-1h-1v-2h1v-1h1V9h1V8h1V7z"/>'
    },
    "side-nav-expand": {
      body: '<path fill="currentColor" d="M22 5V3h-2V2H4v1H2v2H1v14h1v2h2v1h16v-1h2v-2h1V5ZM7 19H5v-1H4V6h1V5h2Zm13-1h-1v1h-9V5h9v1h1Z"/><path fill="currentColor" d="M18 11v2h-1v1h-1v1h-1v1h-1v1h-2v-2h1v-1h1v-1h1v-2h-1v-1h-1V9h-1V7h2v1h1v1h1v1h1v1z"/>'
    },
    "side-nav-expand-solid": {
      body: '<path fill="currentColor" d="M22 5V3h-2V2H4v1H2v2H1v14h1v2h2v1h16v-1h2v-2h1V5Zm-2 13h-1v1h-9V5h9v1h1Z"/><path fill="currentColor" d="M18 11v2h-1v1h-1v1h-1v1h-1v1h-2v-2h1v-1h1v-1h1v-2h-1v-1h-1V9h-1V7h2v1h1v1h1v1h1v1z"/>'
    },
    sitemap: {
      body: '<path fill="currentColor" d="M22 17v-1h-1v-4h-1v-1h-7V8h2V2H9v6h2v3H4v1H3v4H2v1H1v4h1v1h4v-1h1v-4H6v-1H5v-3h6v3h-1v1H9v4h1v1h4v-1h1v-4h-1v-1h-1v-3h6v3h-1v1h-1v4h1v1h4v-1h1v-4Zm-9 1v2h-2v-2Zm8 0v2h-2v-2ZM3 20v-2h2v2Zm8-14V4h2v2Z"/>'
    },
    "sitemap-solid": {
      body: '<path fill="currentColor" d="M23 17v4h-1v1h-4v-1h-1v-4h1v-1h1v-3h-6v3h1v1h1v4h-1v1h-4v-1H9v-4h1v-1h1v-3H5v3h1v1h1v4H6v1H2v-1H1v-4h1v-1h1v-4h1v-1h7V8H9V2h6v6h-2v3h7v1h1v4h1v1z"/>'
    },
    slack: {
      body: '<path fill="currentColor" d="M6 13v4H5v1H2v-1H1v-3h1v-1zm4-11h1v4H7V5H6V2h1V1h3zm0 6h1v2h-1v1H2v-1H1V8h1V7h8zm0 6h1v8h-1v1H8v-1H7v-8h1v-1h2zm4-4h-1V2h1V1h2v1h1v8h-1v1h-2zm8 4h1v2h-1v1h-8v-1h-1v-2h1v-1h8zm1-7v3h-1v1h-4V7h1V6h3v1zm-6 12h1v3h-1v1h-3v-1h-1v-4h4z"/>'
    },
    society: {
      body: '<path fill="currentColor" d="M11.502 9.502h-1v1h1zm4.001 0h-1v1h1z"/><path fill="currentColor" d="M22.505 9.502v-2h-1V5.5h-1v-1h-1v-1h-2.001v-1h-2v-1H9.501v1h-2v1H5.5v1h-1v1h-1v2.001h-1v2h-1v6.002h1v2h1v2.001h1v1h1v1h2.001v1h2v1.001h6.002v-1h2v-1h2.001v-1h1v-1h1v-2.001h1v-2h1.001V9.501zm-2 6.001h-5.002v1h1v2H9.502v-2h1v-1H5.501v-2h1v-1h2v-1h-1v-1.001h-1v-3h1v-1h3.001v1h1v2h3.001v-2h1v-1h3v1h1.001v3h-1v1h-1v1h2v1h1z"/><path fill="currentColor" d="M12.503 14.503v1h-2v-2h1v1zm3-1v2h-2v-1h1v-1zm1-3.001h-1v3h1zm-6.001 0h-1v3h1z"/>'
    },
    sort: {
      body: '<path fill="currentColor" d="M19 14v-1H5v1H4v2h1v1h1v1h1v1h1v1h1v1h1v1h1v1h2v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-2zm-2 2h-1v1h-1v1h-1v1h-1v1h-2v-1h-1v-1H9v-1H8v-1H7v-1h10zm2-8V7h-1V6h-1V5h-1V4h-1V3h-1V2h-1V1h-2v1h-1v1H9v1H8v1H7v1H6v1H5v1H4v2h1v1h14v-1h1V8zm-2 1H7V8h1V7h1V6h1V5h1V4h2v1h1v1h1v1h1v1h1z"/>'
    },
    "sort-solid": {
      body: '<path fill="currentColor" d="M20 8v2h-1v1H5v-1H4V8h1V7h1V6h1V5h1V4h1V3h1V2h1V1h2v1h1v1h1v1h1v1h1v1h1v1h1v1zm0 6v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1h-1v-1H9v-1H8v-1H7v-1H6v-1H5v-1H4v-2h1v-1h14v1z"/>'
    },
    "sound-mute": {
      body: '<path fill="currentColor" d="M22 8v2h-1v1h-1v2h1v1h1v2h-2v-1h-1v-1h-1v1h-1v1h-2v-2h1v-1h1v-2h-1v-1h-1V8h2v1h1v1h1V9h1V8zM11 2v1h-1v1H9v1H8v1H7v1H6v1H1v8h5v1h1v1h1v1h1v1h1v1h1v1h3V2zm-8 8h4V9h1V8h1V7h1V6h1V5h1v14h-1v-1h-1v-1H9v-1H8v-1H7v-1H3z"/>'
    },
    "sound-mute-solid": {
      body: '<path fill="currentColor" d="M14 2v20h-3v-1h-1v-1H9v-1H8v-1H7v-1H6v-1H1V8h5V7h1V6h1V5h1V4h1V3h1V2zm8 6v2h-1v1h-1v2h1v1h1v2h-2v-1h-1v-1h-1v1h-1v1h-2v-2h1v-1h1v-2h-1v-1h-1V8h2v1h1v1h1V9h1V8z"/>'
    },
    "sound-on": {
      body: '<path fill="currentColor" d="M17 15v-1h-1v-1h1v-2h-1v-1h1V9h1v1h1v4h-1v1z"/><path fill="currentColor" d="M23 10v4h-1v2h-1v1h-1v1h-1v-1h-1v-1h1v-1h1v-1h1v-4h-1V9h-1V8h-1V7h1V6h1v1h1v1h1v2zM11 2v1h-1v1H9v1H8v1H7v1H6v1H1v8h5v1h1v1h1v1h1v1h1v1h1v1h3V2zm1 17h-1v-1h-1v-1H9v-1H8v-1H7v-1H3v-4h4V9h1V8h1V7h1V6h1V5h1z"/>'
    },
    "sound-on-solid": {
      body: '<path fill="currentColor" d="M14 2v20h-3v-1h-1v-1H9v-1H8v-1H7v-1H6v-1H1V8h5V7h1V6h1V5h1V4h1V3h1V2zm3 13v-1h-1v-1h1v-2h-1v-1h1V9h1v1h1v4h-1v1z"/><path fill="currentColor" d="M23 10v4h-1v2h-1v1h-1v1h-1v-1h-1v-1h1v-1h1v-1h1v-4h-1V9h-1V8h-1V7h1V6h1v1h1v1h1v2z"/>'
    },
    sparkles: {
      body: '<path fill="currentColor" d="M23 5v1h-2v1h-1v2h-1V7h-1V6h-2V5h2V4h1V2h1v2h1v1zm0 13v1h-2v1h-1v2h-1v-2h-1v-1h-2v-1h2v-1h1v-2h1v2h1v1zm-8-7v-1h-2V9h-1V8h-1V6h-1V4H8v2H7v2H6v1H5v1H3v1H1v2h2v1h2v1h1v1h1v2h1v2h2v-2h1v-2h1v-1h1v-1h2v-1h2v-2Zm-3 2v1h-1v1h-1v2H8v-2H7v-1H6v-1H4v-2h2v-1h1V9h1V7h2v2h1v1h1v1h2v2Z"/>'
    },
    "sparkles-solid": {
      body: '<path fill="currentColor" d="M23 18v2h-2v1h-1v2h-2v-2h-1v-1h-2v-2h2v-1h1v-2h2v2h1v1zm0-14v2h-2v1h-1v2h-2V7h-1V6h-2V4h2V3h1V1h2v2h1v1zm-6 7v2h-2v1h-2v1h-1v1h-1v2h-1v2H8v-2H7v-2H6v-1H5v-1H3v-1H1v-2h2v-1h2V9h1V8h1V6h1V4h2v2h1v2h1v1h1v1h2v1z"/>'
    },
    spinner: {
      body: '<path fill="currentColor" d="M20 13h2v1h-2zm2-2h1v2h-1zm-2-1h2v1h-2zm-1 1h1v2h-1zm-2 8h2v1h-2zm2-2h1v2h-1zm-2-1h2v1h-2zm-1 1h1v2h-1zm-6 3h1v2h-1zm1 2h2v1h-2zm2-2h1v2h-1zm-2-1h2v1h-2zm-6 0h2v1H5zm8-17h1v2h-1zm-2 2h2v1h-2zm0-3h2v1h-2zm-1 1h1v2h-1zM7 17h1v2H7zM7 5h1v2H7zM5 7h2v1H5zm0 9h2v1H5zM5 4h2v1H5zM4 17h1v2H4zm0-6h1v2H4zm0-6h1v2H4zm-2 5h2v1H2zm0 3h2v1H2zm-1-2h1v2H1z"/>'
    },
    "spinner-solid": {
      body: '<path fill="currentColor" d="M7 5h1v2H7v1H5V7H4V5h1V4h2zm6-3h1v2h-1v1h-2V4h-1V2h1V1h2zM4 14H2v-1H1v-2h1v-1h2v1h1v2H4zm3 3h1v2H7v1H5v-1H4v-2h1v-1h2zm16-6v2h-1v1h-2v-1h-1v-2h1v-1h2v1zm-4 6h1v2h-1v1h-2v-1h-1v-2h1v-1h2zm-6 3h1v2h-1v1h-2v-1h-1v-2h1v-1h2z"/>'
    },
    "spinner-third": {
      body: '<path fill="currentColor" d="M23 9v6h-1v2h-2v-2h1V9h-1V7h-1V5h-2V4h-2V3h-3V1h3v1h2v1h2v1h1v1h1v2h1v2z"/>'
    },
    "spinner-third-solid": {
      body: '<path fill="currentColor" d="M23 9v6h-1v2h-3v-2h1V9h-1V7h-1V6h-1V5h-2V4h-2V3h-1V1h3v1h2v1h2v1h1v1h1v2h1v2z"/>'
    },
    star: {
      body: '<path fill="currentColor" d="M16 8V6h-1V4h-1V2h-1V1h-2v1h-1v2H9v2H8v2H1v2h1v1h1v1h1v1h1v1h1v5H5v4h2v-1h2v-1h2v-1h2v1h2v1h2v1h2v-4h-1v-5h1v-1h1v-1h1v-1h1v-1h1V8zm4 3h-1v1h-1v1h-1v1h-1v5h1v1h-2v-1h-2v-1h-2v1H9v1H7v-1h1v-5H7v-1H6v-1H5v-1H4v-1h4V9h1V8h1V6h1V4h2v2h1v2h1v1h1v1h4z"/>'
    },
    "star-crescent": {
      body: '<path fill="currentColor" d="M23 10v1h-1v1h-1v2h1v3h-1v-1h-1v-1h-1v-1h-1v1h-1v1h-1v1h-1v-3h1v-2h-1v-1h-1v-1h3V8h1V7h1v1h1v2z"/><path fill="currentColor" d="M8 10V8h1V6h1V5h2V4h2V3h3V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h-3v-1h-2v-1h-2v-1H9v-2H8v-2H7v-4zm-2 4v2h1v2h1v1h1v1h1v1H9v-1H7v-1H5v-2H4v-2H3V9h1V7h1V5h2V4h2V3h1v1H9v1H8v1H7v2H6v2H5v4z"/>'
    },
    "star-crescent-solid": {
      body: '<path fill="currentColor" d="M14 21h3v1h-2v1H9v-1H7v-1H5v-1H4v-1H3v-2H2v-2H1V9h1V7h1V5h1V4h1V3h2V2h2V1h6v1h2v1h-3v1h-2v1h-2v1H9v2H8v2H7v4h1v2h1v2h1v1h2v1h2z"/><path fill="currentColor" d="M23 10v1h-1v1h-1v2h1v3h-1v-1h-1v-1h-1v-1h-1v1h-1v1h-1v1h-1v-3h1v-2h-1v-1h-1v-1h3V8h1V7h1v1h1v2z"/>'
    },
    "star-solid": {
      body: '<path fill="currentColor" d="M23 8v2h-1v1h-1v1h-1v1h-1v1h-1v5h1v4h-2v-1h-2v-1h-2v-1h-2v1H9v1H7v1H5v-4h1v-5H5v-1H4v-1H3v-1H2v-1H1V8h7V6h1V4h1V2h1V1h2v1h1v2h1v2h1v2z"/>'
    },
    startups: {
      body: '<path fill="currentColor" d="M23.505 1.5v5.001h-1v2h-1v1h-1v-1h-1v-1h-1.001v-1h-1v-1h-1v-1h-1v-1h1v-1h2V1.5zM11.502 13.503v2h-1v1h-1v1h-1v1.001h-1v1H5.5v-2h1v-1h1v-1h1v-1h1v-1.001z"/><path fill="currentColor" d="M19.504 9.502v-1h-1v-1h-1V6.5h-1v-1h-1v-1h-1.001v1h-1v1h-1v1h-1v1h-1.001v1H4.501v1h-1v1.001h-1v1H1.5v2h4v-1h1.001v-1h1v-1h1v-1h1v1h-1v1h-1v2h1v-1h1v-1h3.002v3.001h-1v1h-1.001v1h2v-1h1v-1h1.001v1h-1v1h-1v1h-1v1h-1.001v4.002h2v-1h1v-1h1.001v-1h1v-6.002h1v-1h1v-1h1v-1h1.001v-1.001h1v-1zm-2-1v2h-1v1h-2.001v-1h-1v-2h1v-1h2v1z"/>'
    },
    steam: {
      body: '<path fill="currentColor" d="M18 8h-1v3h1zm-1 3h-3v1h3zm0-4h-3v1h3zm-3 1h-1v3h1zm-4 10H7v1h3zm0-4H8v1h2zm1 1h-1v3h1z"/><path fill="currentColor" d="M23 9v6h-1v2h-1v2h-1v1h-1v1h-2v1h-2v1H9v-1H7v-1H5v-1H4v-1H3v-2H2v-2h1v1h2v1h2v1H6v1h1v1h3v-1h1v-1h1v-2h1v-1h2v-1h2v-1h2v-2h1V8h-1V6h-2V5h-3v1h-2v2h-1v3h-1v1H9v1H7v1H6v-1H4v-1H2v-1H1V9h1V7h1V5h1V4h1V3h2V2h2V1h6v1h2v1h2v1h1v1h1v2h1v2z"/>'
    },
    "strike-through": {
      body: '<path fill="currentColor" d="M2 11h20v2H2zm17-9v1H9v1H8v5H6V3h1V2h1V1h10v1zm-1 13v6h-1v1h-1v1H6v-1H5v-1h10v-1h1v-5z"/>'
    },
    "strike-through-solid": {
      body: '<path fill="currentColor" d="M18 16v5h-1v1h-1v1H6v-1H5v-2h9v-1h1v-3zm4-5v2h-1v1H3v-1H2v-2h1v-1h18v1zM6 8V3h1V2h1V1h10v1h1v2h-9v1H9v3z"/><path fill="none" d="M0 0h24v24H0z"/>'
    },
    sun: {
      body: '<path fill="currentColor" d="M21 11v-1h1V9h1V7h-3V6h-2V4h-1V1h-2v1h-1v1h-1v1h-2V3h-1V2H9V1H7v3H6v2H4v1H1v2h1v1h1v1h1v2H3v1H2v1H1v2h3v1h2v2h1v3h2v-1h1v-1h1v-1h2v1h1v1h1v1h2v-3h1v-2h2v-1h3v-2h-1v-1h-1v-1h-1v-2zm-2 2v1h1v1h1v1h-3v1h-1v1h-1v3h-1v-1h-1v-1h-1v-1h-2v1h-1v1H9v1H8v-3H7v-1H6v-1H3v-1h1v-1h1v-1h1v-2H5v-1H4V9H3V8h3V7h1V6h1V3h1v1h1v1h1v1h2V5h1V4h1V3h1v2h1v2h1v1h3v1h-1v1h-1v1h-1v2z"/><path fill="currentColor" d="M16 10V9h-1V8h-1V7h-4v1H9v1H8v1H7v4h1v1h1v1h1v1h4v-1h1v-1h1v-1h1v-4zm-1 4h-1v1h-4v-1H9v-4h1V9h4v1h1z"/>'
    },
    "sun-solid": {
      body: '<path fill="currentColor" d="M17 10v4h-1v1h-1v1h-1v1h-4v-1H9v-1H8v-1H7v-4h1V9h1V8h1V7h4v1h1v1h1v1z"/><path fill="currentColor" d="M21 11v-1h1V9h1V7h-3V6h-2V4h-1V1h-2v1h-1v1h-1v1h-2V3h-1V2H9V1H7v3H6v2H4v1H1v2h1v1h1v1h1v2H3v1H2v1H1v2h3v1h2v2h1v3h2v-1h1v-1h1v-1h2v1h1v1h1v1h2v-3h1v-2h2v-1h3v-2h-1v-1h-1v-1h-1v-2zm-3 4h-1v1h-1v1h-1v1H9v-1H8v-1H7v-1H6V9h1V8h1V7h1V6h6v1h1v1h1v1h1z"/>'
    },
    table: {
      body: '<path fill="currentColor" d="M22 2V1H2v1H1v20h1v1h20v-1h1V2zm-9 14h8v5h-8zm0-1V9h8v6zm0-7V3h8v5zm-2 1v6H3V9zM3 8V3h8v5zm8 8v5H3v-5z"/>'
    },
    "table-solid": {
      body: '<path fill="currentColor" d="M22 2V1H2v1H1v20h1v1h20v-1h1V2zm-9 12v-4h7v4zm7 2v4h-7v-4zm-7-8V4h7v4zm-9 6v-4h7v4zm7 2v4H4v-4zM4 8V4h7v4z"/>'
    },
    tag: {
      body: '<path fill="currentColor" d="M8 5v2H7v1H5V7H4V5h1V4h2v1z"/><path fill="currentColor" d="M22 13v-1h-1v-1h-1v-1h-1V9h-1V8h-1V7h-1V6h-1V5h-1V4h-1V3h-1V2h-1V1H2v1H1v9h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h2v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-2zM3 3h7v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v2h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1h-1v-1h-1v-1h-1v-1H9v-1H8v-1H7v-1H6v-1H5v-1H4v-1H3z"/>'
    },
    "tag-solid": {
      body: '<path fill="currentColor" d="M22 13v-1h-1v-1h-1v-1h-1V9h-1V8h-1V7h-1V6h-1V5h-1V4h-1V3h-1V2h-1V1H2v1H1v9h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h2v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-2zM4 5h1V4h2v1h1v2H7v1H5V7H4z"/>'
    },
    "tech-companies": {
      body: '<path fill="currentColor" d="M11.502 1.5v22.005h1v-5.001h3.001v5.001h6.002V1.5zm6.002 1v2h-2v-2zm0 5.001h-2v-2h2zm0 3.001h-2v-2h2zm0 3h-2v-2h2zm0 3.001h-2v-2h2zM12.502 2.5h2v2h-2zm0 3h2v2.001h-2zm0 3.002h2v2h-2zm0 3h2v2h-2zm0 3.001h2v2h-2zm8.002 7.002h-4v-3.001h4zm0-5.002h-2v-2h2zm0-3h-2v-2h2zm0-3.001h-2v-2h2zm0-3h-2V5.5h2zm0-3.001h-2v-2h2zm-19.004 4v15.004h3v-4.001h3.001v4h3.001V8.502zm1 1h3v2.001h-3zm0 3.001h3v2h-3zm0 5.001v-2h3v2zm7.002 0h-3v-2h3zm0-3h-3v-2h3zm0-3h-3V9.501h3z"/>'
    },
    "tech-stories": {
      body: '<path fill="currentColor" d="M22.005 2V1H2v1H1v20.005h1v1h20.005v-1h1V2zm-1 3H3V3h18.005zm0 11.003H3V9.002h18.005zM3 17.003h3.001v3.001h-3zm16.004 1H8.002v-1h11.002zM8.002 19.005h11.002v1H8.002zM3 6.001h12.003v2H3zm5.002 16.004v-1h11.002v1z"/>'
    },
    technology: {
      body: '<path fill="currentColor" d="M17.504 7.501H7.5v10.003h10.003z"/><path fill="currentColor" d="M21.505 5.5v-2h-2v-2h-2.001v2h-2v-2h-2.001v2h-2v-2H9.501v2h-2v-2H5.5v2h-2v2h-2v2.001h2v2h-2v2.001h2v2h-2v2.001h2v2h-2v2.001h2v2h2v2.001h2.001v-2h2v2h2.001v-2h2v2h2.001v-2h2v2h2.001v-2h2v-2h2.001v-2.001h-2v-2h2v-2.001h-2v-2h2V9.501h-2v-2h2V5.5zm-2 14.004H5.5V5.501h14.003z"/>'
    },
    telegram: {
      body: '<path fill="currentColor" d="M13 10h1v1h-1zm-1 1h1v1h-1z"/><path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9Zm-5 2h-1v3h-1v4h-1v-1h-1v-1h-1v-1h-2v-1h1v-1h1v-1h-2v1H9v1H7v-1H5v-1h2v-1h2v-1h2V9h3V8h2V7h1Z"/>'
    },
    "text-slash": {
      body: '<path fill="currentColor" d="M11 15v4h-1v4H8v-4h1v-4zM4 4V1h18v3h-8v4h-1v3h-2V8h1V4zm19 15v2h-2v-1h-1v-1h-2v-1h-1v-1h-2v-1h-1v-1h-2v-1h-2v-1H9v-1H7v-1H6v-1H4V9H3V8H1V6h2v1h1v1h2v1h1v1h2v1h1v1h2v1h2v1h1v1h2v1h1v1h2v1h1v1z"/>'
    },
    "text-slash-solid": {
      body: '<path fill="currentColor" d="M11 17h1v2h-1v4H7v-4h1v-4h1v1h2zm12 2v3h-2v-1h-1v-1h-2v-1h-1v-1h-2v-1h-1v-1h-2v-1h-2v-1H9v-1H7v-1H6v-1H4v-1H3V9H1V6h2v1h1v1h2v1h1v1h2v1h1v1h2v1h2v1h1v1h2v1h1v1h2v1h1v1zM4 5V1h18v4h-7v4h-1v3h-1v-1h-2v-1h-1V9h1V5z"/>'
    },
    themes: {
      body: '<path fill="currentColor" d="M7 18v1H6v1H5v-1H4v-1h1v-1h1v1z"/><path fill="currentColor" d="M22 16v-1h-1v-1h-4v-1h1v-1h1v-1h1v-1h1V9h1V7h-1V6h-1V5h-1V4h-1V3h-1V2h-2v1h-1v1h-1v1h-1v1h-1v1h-1V3H9V2H8V1H3v1H2v1H1v17h1v2h1v1h18v-1h1v-1h1v-5ZM8 20H7v1H4v-1H3v-6h5Zm0-8H3V9h5Zm0-5H3V4h1V3h3v1h1Zm2 3h1V9h1V8h1V7h1V6h1V5h2v1h1v1h1v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1Zm11 10h-1v1H10v-1h1v-1h1v-1h1v-1h1v-1h6v1h1Z"/>'
    },
    "themes-solid": {
      body: '<path fill="currentColor" d="M22 16v-1h-1v-1h-4v-1h1v-1h1v-1h1v-1h1V9h1V7h-1V6h-1V5h-1V4h-1V3h-1V2h-2v1h-1v1h-1v1h-1v1h-1v1h-1V3H9V2H8V1H3v1H2v1H1v17h1v2h1v1h18v-1h1v-1h1v-5ZM8 7v2H3V7Zm-5 5h5v2H3Zm4 7H6v1H5v-1H4v-1h1v-1h1v1h1Zm9-7h-1v1h-1v1h-1v1h-1v1h-1v1h-1v-7h1V9h1V8h1V7h1V6h1V5h2v1h1v1h1v2h-1v1h-1v1h-1Z"/>'
    },
    threads: {
      body: '<path fill="currentColor" d="M21 7V5h-1V4h-1V3h-1V2h-2V1H8v1H6v1H5v1H4v1H3v3H2v8h1v3h1v1h1v1h1v1h2v1h8v-1h2v-1h1v-1h1v-1h1v-7h-1v-1h-1v-1h-3V8h-1V7h-1V6h-4v1H9v1H8v1h3V8h2v1h1v1h-4v1H9v1H8v4h1v1h1v1h4v-1h1v-1h1v-4h2v1h1v5h-1v1h-1v1h-2v1H9v-1H7v-1H6v-1H5v-3H4V9h1V6h1V5h1V4h2V3h6v1h2v1h1v1h1v2h3V7zm-8 8v1h-2v-1h-1v-2h1v-1h2v1h1v2z"/>'
    },
    thumbsdown: {
      body: '<path fill="currentColor" d="M6 2v13H2v-1H1V3h1V2zm16 10V9h-1V6h-1V3h-1V2h-7v1h-2v1H9v1H8v9h1v1h1v1h1v2h1v3h1v1h2v-1h1v-4h-1v-2h7v-1h1v-2zm-2 1h-6v1h-1v1h-1v-1h-1v-1h-1V6h1V5h2V4h5v2h1v3h1z"/>'
    },
    "thumbsdown-solid": {
      body: '<path fill="currentColor" d="M6 2v13H2v-1H1V3h1V2zm17 10v2h-1v1h-7v2h1v4h-1v1h-2v-1h-1v-3h-1v-2h-1v-1H9v-1H8V5h1V4h1V3h2V2h7v1h1v3h1v3h1v3z"/>'
    },
    thumbsup: {
      body: '<path fill="currentColor" d="M22 10V9h-7V7h1V3h-1V2h-2v1h-1v3h-1v2h-1v1H9v1H8v9h1v1h1v1h2v1h7v-1h1v-3h1v-3h1v-3h1v-2zm-3 5v3h-1v2h-5v-1h-2v-1h-1v-7h1v-1h1V9h1v1h1v1h6v4zM6 9v13H2v-1H1V10h1V9z"/>'
    },
    "thumbsup-solid": {
      body: '<path fill="currentColor" d="M23 10v2h-1v3h-1v3h-1v3h-1v1h-7v-1h-2v-1H9v-1H8v-9h1V9h1V8h1V6h1V3h1V2h2v1h1v4h-1v2h7v1zM6 9v13H2v-1H1V10h1V9z"/>'
    },
    thumbtack: {
      body: '<path fill="currentColor" d="M18 13v-1h-1v-1h-1V4h2V2h-1V1H7v1H6v2h2v7H7v1H6v1H5v2h1v1h5v7h2v-7h5v-1h1v-2zM9 3h6v1h-1v8h1v1h1v1H8v-1h1v-1h1V4H9z"/>'
    },
    "thumbtack-solid": {
      body: '<path fill="currentColor" d="M19 13v2h-1v1h-5v7h-2v-7H6v-1H5v-2h1v-1h1v-1h1V4H6V2h1V1h10v1h1v2h-2v7h1v1h1v1z"/>'
    },
    tiktok: {
      body: '<path fill="currentColor" d="M22 7v4h-2v-1h-2V9h-1v10h-1v1h-1v1h-1v1h-1v1H7v-1H6v-1H5v-1H4v-1H3v-1H2v-4h1v-2h1v-1h1v-1h1V9h4v4H8v1H7v3h1v1h3v-1h1V1h4v1h1v2h1v1h1v1h1v1z"/>'
    },
    times: {
      body: '<path fill="currentColor" d="M14 13h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h-1v1h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-2v1h-1v1H9v1H8v1H7v1H6v1H5v1H4v1H3v-1H2v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-2H9v-1H8V9H7V8H6V7H5V6H4V5H3V4H2V3h1V2h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h2V9h1V8h1V7h1V6h1V5h1V4h1V3h1V2h1v1h1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1z"/>'
    },
    "times-circle": {
      body: '<path fill="currentColor" d="M14 13h1v1h1v1h1v1h-1v1h-1v-1h-1v-1h-1v-1h-2v1h-1v1H9v1H8v-1H7v-1h1v-1h1v-1h1v-2H9v-1H8V9H7V8h1V7h1v1h1v1h1v1h2V9h1V8h1V7h1v1h1v1h-1v1h-1v1h-1z"/><path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9zm-1 6h-1v2h-1v2h-2v1h-2v1H9v-1H7v-1H5v-2H4v-2H3V9h1V7h1V5h2V4h2V3h6v1h2v1h2v2h1v2h1z"/>'
    },
    "times-circle-solid": {
      body: '<path fill="currentColor" d="M22 9V7h-1V5h-1V4h-1V3h-2V2h-2V1H9v1H7v1H5v1H4v1H3v2H2v2H1v6h1v2h1v2h1v1h1v1h2v1h2v1h6v-1h2v-1h2v-1h1v-1h1v-2h1v-2h1V9zm-8 7v-1h-1v-1h-2v1h-1v1H9v1H8v-1H7v-1h1v-1h1v-1h1v-2H9v-1H8V9H7V8h1V7h1v1h1v1h1v1h2V9h1V8h1V7h1v1h1v1h-1v1h-1v1h-1v2h1v1h1v1h1v1h-1v1h-1v-1z"/>'
    },
    "times-solid": {
      body: '<path fill="currentColor" d="M15 13h1v1h1v1h1v1h1v1h1v1h1v1h1v1h-1v1h-1v1h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-2v1h-1v1H9v1H8v1H7v1H6v1H5v1H4v-1H3v-1H2v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-2H8v-1H7V9H6V8H5V7H4V6H3V5H2V4h1V3h1V2h1v1h1v1h1v1h1v1h1v1h1v1h1v1h2V8h1V7h1V6h1V5h1V4h1V3h1V2h1v1h1v1h1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1z"/>'
    },
    "times-square": {
      body: '<path fill="currentColor" d="M22 2V1H2v1H1v20h1v1h20v-1h1V2Zm-1 19H3V3h18Z"/><path fill="currentColor" d="M14 13h1v1h1v1h1v1h-1v1h-1v-1h-1v-1h-1v-1h-2v1h-1v1H9v1H8v-1H7v-1h1v-1h1v-1h1v-2H9v-1H8V9H7V8h1V7h1v1h1v1h1v1h2V9h1V8h1V7h1v1h1v1h-1v1h-1v1h-1z"/>'
    },
    "times-square-solid": {
      body: '<path fill="currentColor" d="M22 2V1H2v1H1v20h1v1h20v-1h1V2Zm-7 11v1h1v1h1v1h-1v1h-1v-1h-1v-1h-1v-1h-2v1h-1v1H9v1H8v-1H7v-1h1v-1h1v-1h1v-2H9v-1H8V9H7V8h1V7h1v1h1v1h1v1h2V9h1V8h1V7h1v1h1v1h-1v1h-1v1h-1v2Z"/>'
    },
    translate: {
      body: '<path fill="currentColor" d="M11 22h11v1H11zm11-12h1v12h-1zM11 9h11v1H11zm11-4v1h-1v1h-1v1h-2V7h-1V6h-1V5h2V4h-1V3h-1V2h3v1h1v2zm-2 11v-2h-1v-1h-1v-1h-1v-1h-1v1h-1v1h-1v1h-1v2h-1v5h2v-3h5v3h2v-5zm-1 1h-5v-1h1v-2h3v2h1zm-9-7h1v12h-1zm3-8h1v6h-1zM2 1h11v1H2zM1 2h1v12H1zm1 12h7v1H2z"/><path fill="currentColor" d="M12 4V3H3v1h4v2H6V5H4v1H3v4h1v1h2v-1h1v3h1V8h1V7h2v1h1V6h-1V5H9v1H8V4zM7 8H6v1H4V7h3zM6 19v1h1v1h1v1H5v-1H4v-2H2v-1h1v-1h1v-1h2v1h1v1h1v1z"/>'
    },
    "translate-solid": {
      body: '<path fill="currentColor" d="M19 16v1h-5v-1h1v-2h3v2zm3-11v1h-1v1h-1v1h-2V7h-1V6h-1V5h2V4h-1V3h-1V2h3v1h1v2z"/><path fill="currentColor" d="M22 10V9H11v1h-1v12h1v1h11v-1h1V10zm-1 11h-2v-3h-5v3h-2v-5h1v-2h1v-1h1v-1h1v-1h1v1h1v1h1v1h1v2h1zM7 7v1H6v1H4V7z"/><path fill="currentColor" d="M14 2v6h-2V6h-1V5H9v1H8V4h4V3H3v1h4v2H6V5H4v1H3v4h1v1h2v-1h1v3h1V8h1V7h2v1h-1v1H9v6H2v-1H1V2h1V1h11v1zM6 19v1h1v1h1v1H5v-1H4v-2H2v-1h1v-1h1v-1h2v1h1v1h1v1z"/>'
    },
    trash: {
      body: '<path fill="currentColor" d="M4 6v8h1v8h1v1h12v-1h1v-8h1V6zm14 7h-1v8H7v-8H6V8h12zm3-10v2H3V3h1V2h5V1h6v1h5v1z"/>'
    },
    "trash-alt": {
      body: '<path fill="currentColor" d="M18 5V4h-1V3h-1V2h-1V1H9v1H8v1H7v1H6v1H2v2h2v15h1v1h14v-2h1V7h1V5zM8 4h1V3h6v1h1v1H8zm10 17H6V7h12z"/><path fill="currentColor" d="M8 9h2v10H8zm6 0h2v10h-2z"/>'
    },
    "trash-alt-solid": {
      body: '<path fill="currentColor" d="M22 3v2H2V3h6V2h1V1h6v1h1v1zM4 7v15h1v1h14v-2h1V7zm12 12h-2V9h2zm-6 0H8V9h2z"/>'
    },
    "trash-solid": {
      body: '<path fill="currentColor" d="M20 6v8h-1v8h-1v1H6v-1H5v-8H4V6zm1-3v2H3V3h1V2h5V1h6v1h5v1z"/>'
    },
    trending: {
      body: '<path fill="currentColor" d="M23 5v9h-1v-1h-1v-1h-1v-1h-2v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1H9v-1H8v-1H7v-1H5v1H4v1H3v1H1v-2h1v-1h1v-1h1v-1h1v-1h2v1h1v1h1v1h1v1h2v-1h1v-1h1v-1h1v-1h1v-1h1V8h-1V7h-1V6h-1V5z"/>'
    },
    "trending-solid": {
      body: '<path fill="currentColor" d="M23 5v10h-1v-1h-1v-1h-1v-1h-2v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1H9v-1H8v-1H7v-1H5v1H4v1H1v-3h1v-1h1v-1h1v-1h1v-1h2v1h1v1h1v1h1v1h2v-1h1v-1h1v-1h1v-1h1V8h-1V7h-1V6h-1V5z"/>'
    },
    trophy: {
      body: '<path fill="currentColor" d="M18 4V2H6v2H1v5h1v2h1v1h1v1h1v1h1v1h3v1h2v3H7v3h10v-3h-4v-3h2v-1h3v-1h1v-1h1v-1h1v-1h1V9h1V4zM8 13H6v-1H5v-1H4V9H3V6h2v1h1v2h1v3h1zm0-4V4h8v5h-1v3h-1v2h-4v-2H9V9zm12 0v2h-1v1h-1v1h-2v-1h1v-2h1V7h1V6h2v3z"/>'
    },
    "trophy-solid": {
      body: '<path fill="currentColor" d="M18 4V2H6v2H1v5h1v2h1v1h1v1h1v1h1v1h3v1h2v3H7v3h10v-3h-4v-3h2v-1h3v-1h1v-1h1v-1h1v-1h1V9h1V4zM5 12v-1H4V9H3V6h2v1h1v2h1v3h1v1H6v-1zm16-3h-1v2h-1v1h-1v1h-2v-1h1v-2h1V7h1V6h2z"/>'
    },
    twitch: {
      body: '<path fill="currentColor" d="M6 1v1H5v1H4v1H3v1H2v14h5v4h1v-1h1v-1h1v-1h1v-1h4v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1v-1h1V1Zm14 11h-1v1h-1v1h-5v1h-1v1h-1v1h-1v-3H7V3h13Z"/><path fill="currentColor" d="M16 5h2v5h-2zm-5 0h2v5h-2z"/>'
    },
    twitter: {
      body: '<path fill="currentColor" d="M22 5h1v1h-1zm0-2h1v1h-1zm-1 2v1h1v1h-1v5h-1v2h-1v2h-1v1h-1v1h-1v1h-2v1h-3v1H4v-1H2v-1H1v-1h2v1h3v-1h1v-1H5v-1H4v-1H3v-1h2v-1H3v-1H2v-2h2V9H3V8H2V4h1v1h1v1h1v1h2v1h3v1h2V5h1V4h1V3h5v1h3v1z"/>'
    },
    underline: {
      body: '<path fill="currentColor" d="M22 1v15h-1v2h-1v2h-1v1h-2v1h-2v1H9v-1H7v-1H5v-1H4v-2H3v-2H2V1h2v15h1v2h1v1h1v1h2v1h6v-1h2v-1h1v-1h1v-2h1V1z"/>'
    },
    "underline-solid": {
      body: '<path fill="currentColor" d="M22 1v15h-1v2h-1v2h-1v1h-2v1h-2v1H9v-1H7v-1H5v-1H4v-2H3v-2H2V1h3v15h1v2h1v1h2v1h6v-1h2v-1h1v-2h1V1z"/>'
    },
    unlock: {
      body: '<path fill="currentColor" d="M21 12v-1H8V5h1V4h1V3h4v1h1v1h1v4h2V5h-1V3h-1V2h-2V1h-4v1H8v1H7v2H6v6H3v1H2v10h1v1h18v-1h1V12zm-1 9H4v-8h16z"/>'
    },
    "unlock-alt": {
      body: '<path fill="currentColor" d="M20 12v-1H8V5h1V4h1V3h4v1h1v1h1v4h2V5h-1V3h-1V2h-2V1h-4v1H8v1H7v2H6v6H4v1H3v10h1v1h16v-1h1V12zm-1 9H5v-8h14z"/>'
    },
    "unlock-alt-solid": {
      body: '<path fill="currentColor" d="M21 12v10h-1v1H4v-1H3V12h1v-1h1V6h1V4h1V3h1V2h2V1h4v1h2v1h1v1h1v2h1v3h-3V6h-1V5h-1V4h-4v1H9v1H8v5h12v1z"/>'
    },
    "unlock-solid": {
      body: '<path fill="currentColor" d="M22 12v10h-1v1H3v-1H2V12h1v-1h3V5h1V3h1V2h2V1h4v1h2v1h1v2h1v4h-3V5h-1V4h-4v1H9v6h12v1z"/>'
    },
    unsplash: {
      body: '<path fill="currentColor" d="M8 1h8v6H8zm15 10v12H1V11h7v6h8v-6z"/>'
    },
    upload: {
      body: '<path fill="currentColor" d="M4 10V8h1V7h1V6h1V5h1V4h1V3h1V2h1V1h2v1h1v1h1v1h1v1h1v1h1v1h1v1h1v2h-2V9h-1V8h-1V7h-1V6h-1V5h-1v12h-2V5h-1v1H9v1H8v1H7v1H6v1zM2 20h20v3H2z"/>'
    },
    "upload-alt": {
      body: '<path fill="currentColor" d="M19 19h1v1h-1zm-2 0h1v1h-1z"/><path fill="currentColor" d="M22 16v-1h-7V8h4V7h-1V6h-1V5h-1V4h-1V3h-1V2h-1V1h-2v1h-1v1H9v1H8v1H7v1H6v1H5v1h4v7H2v1H1v6h1v1h20v-1h1v-6zM9 6h1V5h1V4h2v1h1v1h1v1h-2v9h-2V7H9zm12 15H3v-4h7v1h4v-1h7z"/>'
    },
    "upload-alt-solid": {
      body: '<path fill="currentColor" d="M22 16v-1h-6v3h-1v1H9v-1H8v-3H2v1H1v6h1v1h20v-1h1v-6zm-4 4h-1v-1h1zm2 0h-1v-1h1z"/><path fill="currentColor" d="M19 7v1h-4v9h-1v1h-4v-1H9V8H5V7h1V6h1V5h1V4h1V3h1V2h1V1h2v1h1v1h1v1h1v1h1v1h1v1z"/>'
    },
    "upload-solid": {
      body: '<path fill="currentColor" d="M5 10H4V8h1V7h1V6h1V5h1V4h1V3h1V2h1V1h2v1h1v1h1v1h1v1h1v1h1v1h1v1h1v2h-1v1h-2v-1h-1V9h-1V8h-1v9h-4V8H9v1H8v1H7v1H5zM2 20h20v3H2z"/>'
    },
    user: {
      body: '<path fill="currentColor" d="M17 5V3h-1V2h-2V1h-4v1H8v1H7v2H6v4h1v2h1v1h2v1h4v-1h2v-1h1V9h1V5zm-2 4v1h-1v1h-4v-1H9V9H8V5h1V4h1V3h4v1h1v1h1v4zm6 10v-1h-1v-1h-1v-1h-2v-1H7v1H5v1H4v1H3v1H2v3h1v1h18v-1h1v-3zM5 19v-1h2v-1h10v1h2v1h1v2H4v-2z"/>'
    },
    "user-check": {
      body: '<path fill="currentColor" d="M15 16v-1h-1v-1h-1v-1h-2v1H6v-1H4v1H3v1H2v1H1v4h1v1h13v-1h1v-4zm-1 3H3v-3h1v-1h2v1h5v-1h2v1h1zm9-10v1h-1v1h-1v1h-1v1h-1v1h-2v-1h-1v-1h-1v-1h1v-1h1v1h2v-1h1V9h1V8h1v1zM12 6V4h-2V3H7v1H5v2H4v3h1v2h2v1h3v-1h2V9h1V6zm-2 3v1H7V9H6V6h1V5h3v1h1v3z"/>'
    },
    "user-check-solid": {
      body: '<path fill="currentColor" d="M23 9v1h-1v1h-1v1h-1v1h-1v1h-2v-1h-1v-1h-1v-1h1v-1h1v1h2v-1h1V9h1V8h1v1zM13 6v3h-1v2h-2v1H7v-1H5V9H4V6h1V4h2V3h3v1h2v2zm3 10v4h-1v1H2v-1H1v-4h1v-1h1v-1h1v-1h2v1h5v-1h2v1h1v1h1v1z"/>'
    },
    "user-headset": {
      body: '<path fill="currentColor" d="M10 7H9v1H8v3h1v3H8v-1H7v-1H6V8h1V6h1V5h1V4h6v1h1v1h1v2h1v2h-1v1h-1V8h-1V6h-5z"/><path fill="currentColor" d="M20 6v6h-1v1h-1v1h-2v1h-6v-3h3v1h4v-1h1v-1h1V7h-1V5h-1V4h-1V3h-1V2H9v1H8v1H7v1H6v2H5v4H4v-1H3V7h1V6h1V4h1V3h1V2h1V1h8v1h1v1h1v1h1v2zm1 13v-1h-1v-1h-1v-1h-4v1H9v-1H5v1H4v1H3v1H2v3h1v1h18v-1h1v-3zm-1 2H4v-2h1v-1h3v1h8v-1h3v1h1z"/>'
    },
    "user-headset-solid": {
      body: '<path fill="currentColor" d="M20 6v6h-1v1h-1v1h-2v1h-6v-3h3v1h4v-1h1v-1h1V7h-1V5h-1V4h-1V3h-1V2H9v1H8v1H7v1H6v2H5v4H4v-1H3V7h1V6h1V4h1V3h1V2h1V1h8v1h1v1h1v1h1v2z"/><path fill="currentColor" d="M18 8v2h-1v1h-1v1h-2v-1H9v3H8v-1H7v-1H6V8h1V6h1V5h1V4h6v1h1v1h1v2zm4 11v3h-1v1H3v-1H2v-3h1v-1h1v-1h1v-1h4v1h6v-1h4v1h1v1h1v1z"/>'
    },
    "user-minus": {
      body: '<path fill="currentColor" d="M22 15v-2h-1v-1h-2v-1h-3v1h-2v1h-1v2h-1v3h1v2h1v1h2v1h3v-1h2v-1h1v-2h1v-3Zm-7 2v-1h5v1Zm-4 3h1v1H2v-1H1v-3h1v-1h1v-1h1v-1h7v1h-1v1H4v1H3v2h8zm1-15V4h-1V3H6v1H5v1H4v5h1v1h1v1h5v-1h1v-1h1V5Zm-1 4h-1v1H7V9H6V6h1V5h3v1h1Z"/>'
    },
    "user-minus-solid": {
      body: '<path fill="currentColor" d="M22 15v-2h-1v-1h-2v-1h-3v1h-2v1h-1v2h-1v3h1v2h1v1h2v1h3v-1h2v-1h1v-2h1v-3Zm-7 2v-1h5v1Zm-4 3h1v1H2v-1H1v-3h1v-1h1v-1h1v-1h7v1h-1v3h1zm2-15v5h-1v1h-1v1H6v-1H5v-1H4V5h1V4h1V3h5v1h1v1z"/>'
    },
    "user-plus": {
      body: '<path fill="currentColor" d="M11 20h1v1H2v-1H1v-3h1v-1h1v-1h1v-1h7v1h-1v1H4v1H3v2h8zm11-5v-2h-1v-1h-2v-1h-3v1h-2v1h-1v2h-1v3h1v2h1v1h2v1h3v-1h2v-1h1v-2h1v-3Zm-4 2v2h-1v-2h-2v-1h2v-2h1v2h2v1ZM12 5V4h-1V3H6v1H5v1H4v5h1v1h1v1h5v-1h1v-1h1V5Zm-2 4v1H7V9H6V6h1V5h3v1h1v3Z"/>'
    },
    "user-plus-solid": {
      body: '<path fill="currentColor" d="M11 20h1v1H2v-1H1v-3h1v-1h1v-1h1v-1h7v1h-1v3h1zm2-15v5h-1v1h-1v1H6v-1H5v-1H4V5h1V4h1V3h5v1h1v1zm9 10v-2h-1v-1h-2v-1h-3v1h-2v1h-1v2h-1v3h1v2h1v1h2v1h3v-1h2v-1h1v-2h1v-3Zm-4 4h-1v-2h-2v-1h2v-2h1v2h2v1h-2Z"/>'
    },
    "user-solid": {
      body: '<path fill="currentColor" d="M7 9H6V5h1V3h1V2h2V1h4v1h2v1h1v2h1v4h-1v2h-1v1h-2v1h-4v-1H8v-1H7zm15 10v3h-1v1H3v-1H2v-3h1v-1h1v-1h1v-1h2v-1h10v1h2v1h1v1h1v1z"/>'
    },
    users: {
      body: '<path fill="currentColor" d="M19 18v-1h-1v-1h-2v-1H8v1H6v1H5v1H4v3h1v1h14v-1h1v-3zM8 18v-1h8v1h2v2H6v-2zm7-11V6h-1V5h-4v1H9v1H8v4h1v1h1v1h4v-1h1v-1h1V7zm-5 4V7h4v4zM7 5h1v1H7v2H5V7H4V5h1V4h2zm0 7h1v1H2v-1H1v-2h1V9h5zm10-6h-1V5h1V4h2v1h1v2h-1v1h-2zm6 4v2h-1v1h-6v-1h1V9h5v1z"/>'
    },
    "users-crown": {
      body: '<path fill="currentColor" d="M13 12v-1h1V5h4v1h1v5h-1v1zm0-9h-1v1h-1v1h-1V4H9V3H8v1H7v1H6V4H5V3H4v7h1v1h1v1h5v-1h1v-1h1zm-2 6h-1v1H7V9H6V7h5zm12 8v3h-1v1h-6v-1h1v-4h-1v-1h-1v-1h5v1h1v1h1v1z"/><path fill="currentColor" d="M15 17v-1h-1v-1h-1v-1H4v1H3v1H2v1H1v3h1v1h13v-1h1v-3zM4 17v-1h9v1h1v2H3v-2z"/>'
    },
    "users-crown-solid": {
      body: '<path fill="currentColor" d="M16 20h-1v1H2v-1H1v-3h1v-1h1v-1h1v-1h9v1h1v1h1v1h1zm-3-8v-1h1V5h4v1h1v5h-1v1z"/><path fill="currentColor" d="M23 17v3h-1v1h-6v-1h1v-4h-1v-1h-1v-1h5v1h1v1h1v1zM12 3v1h-1v1h-1V4H9V3H8v1H7v1H6V4H5V3H4v7h1v1h1v1h5v-1h1v-1h1V3zm-1 6h-1v1H7V9H6V7h5z"/>'
    },
    "users-solid": {
      body: '<path fill="currentColor" d="M2 13v-1H1v-2h1V9h5v3h1v1zm3-6H4V5h1V4h2v1h1v1H7v2H5zm3 0h1V6h1V5h4v1h1v1h1v4h-1v1h-1v1h-4v-1H9v-1H8zm11 11h1v3h-1v1H5v-1H4v-3h1v-1h1v-1h2v-1h8v1h2v1h1zm4-8v2h-1v1h-6v-1h1V9h5v1zm-6-4h-1V5h1V4h2v1h1v2h-1v1h-2z"/>'
    },
    "video-camera": {
      body: '<path fill="currentColor" d="M23 7v10h-1v1h-1v-1h-1v-1h-1v-1h-1V9h1V8h1V7h1V6h1v1zm-8 0V5H3v1H2v1H1v10h1v1h1v1h12v-2h1V7Zm-1 9h-1v1H4v-1H3V8h1V7h9v1h1Z"/>'
    },
    "video-camera-solid": {
      body: '<path fill="currentColor" d="M15 7h1v10h-1v2H3v-1H2v-1H1V7h1V6h1V5h12zm8 0v10h-1v1h-1v-1h-1v-1h-1v-1h-1V9h1V8h1V7h1V6h1v1z"/>'
    },
    viewblocks: {
      body: '<path fill="currentColor" d="M21 11V9h-1V7h-1V6h-1V5h-1V4h-2V3h-2V1h-2v2H9v1H7v1H6v1H5v1H4v2H3v2H1v2h2v2h1v2h1v1h1v1h1v1h2v1h2v2h2v-2h2v-1h2v-1h1v-1h1v-1h1v-2h1v-2h2v-2zm-10 8h-1v-1H8v-1H7v-1H6v-1H5V9h1v1h1v1h1v1h2v1h1zm-1-8v-1H8V9H7V8H6V7h2V6h2V5h4v1h2v1h2v1h-1v1h-1v1h-2v1zm9 4h-1v1h-1v1h-1v1h-2v1h-1v-6h1v-1h2v-1h1v-1h1V9h1z"/>'
    },
    "vote-yeah": {
      body: '<path fill="currentColor" d="M16 8v1h-1v1h-1v1h-1v1h-1v1h-2v-1H9v-1H8v-1h1V9h1v1h2V9h1V8h1V7h1v1z"/><path fill="currentColor" d="M18 5V4H6v1H5v12h14V5zm-1 10H7V6h10z"/><path fill="currentColor" d="M23 15v4h-1v1H2v-1H1v-4h1v-1h2v2H3v2h18v-2h-1v-2h2v1z"/>'
    },
    "vote-yeah-solid": {
      body: '<path fill="currentColor" d="M18 5V4H6v1H5v12h14V5zm-2 4h-1v1h-1v1h-1v1h-1v1h-2v-1H9v-1H8v-1h1V9h1v1h2V9h1V8h1V7h1v1h1z"/><path fill="currentColor" d="M23 15v4h-1v1H2v-1H1v-4h1v-1h2v2H3v2h18v-2h-1v-2h2v1z"/>'
    },
    wallet: {
      body: '<path fill="currentColor" d="M18 12v1h1v2h-1v1h-2v-1h-1v-2h1v-1z"/><path fill="currentColor" d="M23 8v13h-1v1H2v-1H1V3h1V2h19v1h1v1H3v16h18V9H5V7h17v1z"/>'
    },
    "wallet-solid": {
      body: '<path fill="currentColor" d="M22 8V7H4V5h18V3h-1V2H2v1H1v18h1v1h20v-1h1V8zm-1 7h-1v1h-2v-1h-1v-2h1v-1h2v1h1z"/>'
    },
    web3: {
      body: '<path fill="currentColor" d="M10.502 22.505h-1v1h1zm-1-1v1h-2v-1H5.5v-1h-1v-1h-1v-1.001h-1v-2h5v3h1v2z"/><path fill="currentColor" d="M16.503 16.503v2h-1v2.001h-1v2h-1v1.001h-2v-1h-1.001v-2h-1v-2.001h-1v-2zm-1 6.002h-1v1h1zm7.002-6.002v2h-1v1.001h-1v1h-1v1h-2.001v1h-2v-1h1v-2h1v-3zm-6.002-6.001h-2v1h2zm0 2h-2v1h2z"/><path fill="currentColor" d="M1.5 8.501v7.002h22.005V8.501zm6.001 4.001h-1v2h-1v-2h-1v2h-1v-2h-1v-3h1v3h1v-1h1v1h1v-3h1zm5.001-2h-3v1h2v1h-2v1h3v1h-4v-5h4zm5.002 1h-1v1h1v1h-1v1h-3.001v-5h3v1h1zm5 0h-1v1h1v1h-1v1h-3v-1h3v-1h-2v-1h2v-1h-3v-1h3v1h1zm.001-5.002v1.001h-5.001v-2h-1v-2h-1V2.5h2v1h2v1h1v1h1v1zm-7.002-5h-1v1h1zm1 5.001v1H8.502v-1h1v-2h1v-2h1V1.5h2v1h1.001v2h1v2.001zM10.502 1.5h-1v1h1zm-1 1v1h-1v2h-1v2.001H2.5v-1h1v-1h1v-1h1v-1h2.001V2.5z"/>'
    },
    wifi: {
      body: '<path fill="currentColor" d="M14 17v-1h-4v1H9v4h1v1h4v-1h1v-4Zm-1 3h-2v-2h2ZM23 8v2h-3V9h-1V8h-1V7h-2V6H8v1H6v1H5v1H4v1H1V8h1V7h1V6h1V5h2V4h2V3h8v1h2v1h2v1h1v1h1v1z"/><path fill="currentColor" d="M18 12h1v3h-2v-1h-1v-1h-1v-1H9v1H8v1H7v1H5v-3h1v-1h2v-1h1V9h6v1h1v1h2z"/>'
    },
    "wifi-solid": {
      body: '<path fill="currentColor" d="M14 17h1v4h-1v1h-4v-1H9v-4h1v-1h4zm4-5h1v3h-3v-1h-1v-1H9v1H8v1H5v-3h1v-1h2v-1h1V9h6v1h1v1h2z"/><path fill="currentColor" d="M23 7v3h-3V9h-1V8h-1V7h-2V6H8v1H6v1H5v1H4v1H1V7h1V6h1V5h1V4h2V3h2V2h8v1h2v1h2v1h1v1h1v1z"/>'
    },
    wikipedia: {
      body: '<path fill="currentColor" d="M23 5v1h-1v1h-1v2h-1v2h-1v2h-1v2h-1v3h-1v1h-1v-1h-1v-3h-1v-2h-1v2h-1v2h-1v1H9v1H8v-1H7v-3H6v-2H5v-2H4V9H3V7H2V6H1V5h5v1H5v1h1v2h1v2h1v2h1v2h1v-1h1v-2h1v-1h-1V9h-1V7H9V6H8V5h4v1h-1v1h1v1h2V6h-1V5h4v1h-1v1h-1v2h-1v3h1v2h2v-2h1v-2h1V8h1V6h-1V5z"/>'
    },
    "window-close": {
      body: '<path fill="currentColor" d="M22 2V1H2v1H1v20h1v1h20v-1h1V2zm-1 19H3V3h18z"/><path fill="currentColor" d="M15 13h1v1h1v1h1v1h-1v1h-1v1h-1v-1h-1v-1h-1v-1h-2v1h-1v1H9v1H8v-1H7v-1H6v-1h1v-1h1v-1h1v-2H8v-1H7V9H6V8h1V7h1V6h1v1h1v1h1v1h2V8h1V7h1V6h1v1h1v1h1v1h-1v1h-1v1h-1z"/>'
    },
    "window-close-solid": {
      body: '<path fill="currentColor" d="M22 2V1H2v1H1v20h1v1h20v-1h1V2zm-4 7h-1v1h-1v1h-1v2h1v1h1v1h1v1h-1v1h-1v1h-1v-1h-1v-1h-1v-1h-2v1h-1v1H9v1H8v-1H7v-1H6v-1h1v-1h1v-1h1v-2H8v-1H7V9H6V8h1V7h1V6h1v1h1v1h1v1h2V8h1V7h1V6h1v1h1v1h1z"/>'
    },
    "window-restore": {
      body: '<path fill="currentColor" d="M23 2v16h-1v1h-2v-2h1V3H7v1H5V2h1V1h16v1z"/><path fill="currentColor" d="M18 6V5H2v1H1v16h1v1h16v-1h1V6ZM3 21V7h14v14Z"/>'
    },
    "window-restore-solid": {
      body: '<path fill="currentColor" d="M18 6h1v16h-1v1H2v-1H1V6h1V5h16z"/><path fill="currentColor" d="M23 2v16h-1v1h-2v-2h1V3H7v1H5V2h1V1h16v1z"/>'
    },
    writing: {
      body: '<path fill="currentColor" d="M23.505 7.501v2h-1v1h-1v-1h-1v-1h-1.001v-1h1v-1h2v1zm-2 3.001v1h-1v1h-1v1h-1.001v1h-1v1.001h-1v1h-1v1h-1.001v1h-3v-3h1v-1h1v-1h1v-1h1v-1h1v-1.001h1v-1h1v-1h1.001v1h1v1z"/><path fill="currentColor" d="M17.504 2.5v-1H2.5v1h-1v20.005h1v1h15.004v-1h1v-6.002h-1v1h-1v1h-1v1.001h-5.002v-5.001h1v-1h1v-1h1v-1h1.001v-1.001h1v-1h1v-1h1v-1h1V2.5zm-1 3H3.5v-1h13.003zm-2.001 3.002H3.5v-1h11.003zm-6.001 9.002H3.5v-1h5.002zM3.5 14.503v-1h6.002v1zm0-3v-1.001h9.003v1z"/>'
    },
    x: {
      body: '<path fill="currentColor" d="M15.5 10V9h1V8h1V7h1V6h1V5h1V4h1V3h1V2h-3v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2V7h-1V6h-1V4h-1V3h-1V2h-7v1h1v1h1v1h1v2h1v1h1v2h1v1h1v2h1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h3v-1h1v-1h1v-1h1v-1h1v-1h1v-1h2v1h1v1h1v2h1v1h1v1h7v-1h-1v-1h-1v-1h-1v-2h-1v-1h-1v-2h-1v-1h-1v-2h-1v-1zm0 4v1h1v2h1v1h1v2h-3v-2h-1v-1h-1v-1h-1v-2h-1v-1h-1v-1h-1v-2h-1V9h-1V7h-1V6h-1V4h3v1h1v2h1v1h1v2h1v1h1v1h1v2z"/>'
    },
    youtube: {
      body: '<path fill="currentColor" d="M22 7V5h-2V4H4v1H2v2H1v10h1v2h2v1h16v-1h2v-2h1V7zm-10 8h-2V9h2v1h2v1h2v2h-2v1h-2z"/>'
    }
  },
  lastModified: 1775804632,
  width: 24,
  height: 24
};

// public/src/icons.js
addCollection(icons_default);
addCollection(icons_default2);
function iconRef(name) {
  return name.includes(":") ? name : `pixelarticons:${name}`;
}
function applyIconAttrs(el, name) {
  el.setAttribute("icon", iconRef(name));
}
function iconEl(name, options = {}) {
  const el = document.createElement("iconify-icon");
  applyIconAttrs(el, name);
  if (options.className) el.className = options.className;
  if (options.title) {
    el.setAttribute("title", options.title);
    el.setAttribute("aria-hidden", "false");
  } else {
    el.setAttribute("aria-hidden", "true");
  }
  return el;
}
function setButtonLabel(button, text) {
  if (!button) return;
  const label = button.querySelector(".btn-label");
  if (label) label.textContent = text;
  else button.textContent = text;
}
function bindIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((host) => {
    const name = host.dataset.icon;
    if (!name) return;
    let icon = host.querySelector("iconify-icon");
    if (!icon) {
      icon = iconEl(name);
      const pos = host.dataset.iconPos || "start";
      if (pos === "end") host.appendChild(icon);
      else host.insertBefore(icon, host.firstChild);
    } else {
      applyIconAttrs(icon, name);
    }
  });
}
function setIcon(host, name) {
  if (!host) return;
  let icon = host.querySelector("iconify-icon");
  if (!icon) {
    icon = iconEl(name);
    host.insertBefore(icon, host.firstChild);
  } else {
    applyIconAttrs(icon, name);
  }
}
bindIcons(document);

// public/src/main.js
var state = {
  cases: [],
  currentCaseId: localStorage.getItem("oblivion.currentCaseId") || "",
  currentStatus: null,
  vaultKey: null,
  trustProof: null,
  privacy: null,
  presets: [],
  agentPlan: null,
  connectorResults: [],
  products: [],
  aiBudget: null,
  aiEntitlement: null,
  hackathon: null,
  hackathonStatus: null,
  integrationsStatus: null,
  agentNext: null,
  chatMessages: [
    {
      id: 1,
      role: "agent",
      text: "Hi \u2014 I'm your cleanup agent. I find listings, draft opt-outs, and pause for your approval before anything is sent.",
      animate: false
    },
    {
      id: 2,
      role: "agent",
      text: "Quick start: enter your name on the left, keep People-search selected, then tap Start cleanup. I'll ask you to confirm each match \u2014 Yes or Not me.",
      animate: false
    }
  ],
  walletAddress: "",
  smartAccountAddress: "",
  ethereumProvider: null,
  walletConfig: null,
  walletMode: "",
  smartAccountTxHash: "",
  walletCallsId: "",
  walletConnectNote: "",
  walletConnectError: "",
  walletPickAccount: false,
  appOpen: false,
  tab: "overview",
  actionType: "broker-opt-out",
  selectedPresetId: "people-search-cleanup",
  recommendedPresetId: "people-search-cleanup",
  intakeText: "",
  dockOpen: false,
  dockPinned: true,
  sidebarOpen: localStorage.getItem("oblivion.sidebarOpen") !== "0",
  showRouteTab: false,
  showAdvancedUI: false,
  autopilotBusy: false,
  casesPanelOpen: false,
  walletModalOpen: false,
  deleteConfirmCaseId: "",
  preSearchReady: false
};
var $ = (selector) => document.querySelector(selector);
var output = $("#output");
var chatMessageSeq = 2;
var chatTypewriterTimers = [];
function renderWalletDebugLog(entries) {
  const pre = $("#wallet-debug-log");
  if (!pre || !entries?.length) return;
  pre.textContent = entries.map((e) => `${e.ts} [${e.level}] ${e.message}${e.detail ? ` \u2014 ${e.detail}` : ""}`).join("\n");
}
var walletLog = createWalletLogger(renderWalletDebugLog);
var GUIDE_STEPS = [
  { num: 1, title: "Start", hint: "Enter your name and tap Start cleanup.", icon: "play" },
  { num: 2, title: "Review", hint: "Confirm which listings are yours.", icon: "search" },
  { num: 3, title: "Approve", hint: "Approve before anything is sent.", icon: "check" }
];
var WORKFLOW_PHASES = [
  { id: "collect-minimum-identifiers", label: "Vault" },
  { id: "verify-trust", label: "Trust" },
  { id: "discover-candidates", label: "Find" },
  { id: "confirm-matches", label: "Confirm" },
  { id: "verify-removal-path", label: "Paths" },
  { id: "draft-actions", label: "Draft" },
  { id: "request-approval", label: "Approve" },
  { id: "execute-approved-action", label: "Submit" },
  { id: "complete", label: "Done" }
];
var SIMPLE_PRESET_DEFAULTS = {
  "people-search-cleanup": { jurisdiction: "US", riskLevel: "standard" },
  "search-result-suppression": { jurisdiction: "US", riskLevel: "standard" },
  "california-drop": { jurisdiction: "US", riskLevel: "standard" },
  "gdpr-erasure": { jurisdiction: "EU", riskLevel: "standard" },
  "breach-exposure": { jurisdiction: "US", riskLevel: "standard" },
  "high-risk-safety": { jurisdiction: "US", riskLevel: "high-risk-safety" },
  "content-takedown": { jurisdiction: "US", riskLevel: "standard" }
};
var AGENT_INTAKE_TEMPLATES = {
  "people-search-cleanup": {
    name: "John Smith",
    alias: "J. Smith",
    region: "New York",
    urls: "",
    chatLine: "Data-broker and people-search cleanup for John Smith in New York (also known as J. Smith)."
  },
  "search-result-suppression": {
    name: "John Smith",
    alias: "",
    region: "New York",
    urls: "https://example.com/old-profile",
    chatLine: "Remove Google search results and source pages for John Smith in New York."
  },
  "gdpr-erasure": {
    name: "John Smith",
    alias: "",
    region: "Ireland",
    urls: "",
    chatLine: "GDPR erasure request for personal data about John Smith in Ireland."
  },
  "high-risk-safety": {
    name: "John Smith",
    alias: "J. Smith",
    region: "New York",
    urls: "",
    chatLine: "Urgent safety cleanup \u2014 remove address and profile exposure for John Smith in New York."
  },
  "content-takedown": {
    name: "Rights Holder",
    alias: "",
    region: "",
    urls: "https://example.com/unauthorized-copy",
    chatLine: "Takedown unauthorized copies of my content at the pasted URLs."
  }
};
function currentGuideStep() {
  if (!state.appOpen) return 1;
  if (!state.currentCaseId || !currentCase()) return 1;
  const pending = state.currentStatus?.pendingFindings?.length || 0;
  if (pending > 0 || state.agentPlan?.currentStep === "confirm-matches") return 2;
  const approvals = state.currentStatus?.approvalsNeeded?.length || 0;
  if (approvals > 0) return 3;
  if (state.agentPlan?.currentStep === "complete") return 3;
  return 2;
}
function guidePrimaryLabel(step) {
  if (!state.appOpen || step === 1) return "Start cleanup";
  if (step === 2) return state.currentStatus?.pendingFindings?.length ? "Continue" : "What's next?";
  if (step === 3) return "Review approval";
  return "Continue";
}
function setupLandingSkillInstall() {
  const origin = window.location.origin;
  const curl = $("#skill-install-curl");
  if (curl) {
    const code = curl.querySelector("code");
    if (code) code.textContent = `curl -fsSL ${origin}/skill.sh | bash`;
  }
}
async function copySkillInstallCommand(targetId, button) {
  const node = document.getElementById(targetId);
  const text = node?.querySelector("code")?.textContent?.trim() || node?.textContent?.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      const prior = button.querySelector(".btn-label")?.textContent;
      setButtonLabel(button, "Copied");
      window.setTimeout(() => setButtonLabel(button, prior || "Copy"), 1400);
    }
  } catch {
    write({ error: "copy-failed", message: "Could not copy install command." });
  }
}
function fillAgentInput(text) {
  const input = $("#agent-input");
  if (!input) return;
  input.value = text;
  input.focus();
  const end = input.value.length;
  input.setSelectionRange(end, end);
  updateAgentSendState();
}
function applyAdvancedUiVisibility() {
  document.querySelectorAll(".advanced-only").forEach((node) => {
    node.hidden = !state.showAdvancedUI;
    node.setAttribute("aria-hidden", state.showAdvancedUI ? "false" : "true");
  });
  const glance = $("#case-glance");
  if (glance) glance.hidden = !state.showAdvancedUI;
  const subtitle = $("#case-subtitle");
  if (subtitle) subtitle.hidden = !state.showAdvancedUI;
  const walletStrip = $("#wallet-command-strip");
  if (walletStrip) walletStrip.hidden = !state.appOpen;
  const advancedToggle = $("#show-advanced-ui");
  if (advancedToggle) advancedToggle.checked = state.showAdvancedUI;
}
function readSimpleIntakeForm() {
  const name = $("#simple-name")?.value?.trim();
  if (!name) throw { error: "name-required", message: "Enter your name to continue." };
  const alias = $("#simple-alias")?.value?.trim();
  const region = $("#simple-region")?.value?.trim();
  const presetId = state.selectedPresetId || "people-search-cleanup";
  const defaults = SIMPLE_PRESET_DEFAULTS[presetId] || SIMPLE_PRESET_DEFAULTS["people-search-cleanup"];
  const pastedUrls = ($("#simple-urls")?.value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const intakeText = intakeTextForPreset(presetId, { name, region, alias });
  return {
    intakeText,
    personLabel: name,
    aliases: alias ? [alias] : [],
    region,
    pastedUrls,
    presetId,
    jurisdiction: $("#jurisdiction")?.value || defaults.jurisdiction,
    authorityBasis: $("#authority")?.value || "self",
    riskLevel: $("#risk-level")?.value || defaults.riskLevel
  };
}
function intakeTextForPreset(presetId, { name, region, alias }) {
  const regionPart = region ? ` in ${region}` : "";
  const aliasPart = alias ? ` (also known as ${alias})` : "";
  switch (presetId) {
    case "search-result-suppression":
      return `Suppress Google search results and remove source pages for ${name}${regionPart}${aliasPart}.`;
    case "gdpr-erasure":
      return `Request GDPR/UK erasure for personal data about ${name}${regionPart}${aliasPart}.`;
    case "high-risk-safety":
      return `Urgent safety cleanup: remove address and profile exposure for ${name}${regionPart}${aliasPart}.`;
    case "breach-exposure":
      return `Check breach exposure and plan mitigation for ${name}${regionPart}${aliasPart}.`;
    case "california-drop":
      return `California DROP deletion request for ${name}${regionPart}${aliasPart}.`;
    case "content-takedown":
      return `Takedown unauthorized copies of my content at the URLs listed in this case.`;
    default:
      return `Remove ${name} from data-broker and people-search listings${regionPart}${aliasPart}.`;
  }
}
function selectPresetId(presetId) {
  state.selectedPresetId = presetId || "people-search-cleanup";
  document.querySelectorAll(".preset-chip").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.presetId === state.selectedPresetId);
  });
  document.querySelectorAll("[data-agent-preset]").forEach((starter) => {
    starter.classList.toggle("active", starter.dataset.agentPreset === state.selectedPresetId);
  });
  const defaults = SIMPLE_PRESET_DEFAULTS[state.selectedPresetId] || SIMPLE_PRESET_DEFAULTS["people-search-cleanup"];
  const jurisdiction = $("#jurisdiction");
  const risk = $("#risk-level");
  if (jurisdiction) jurisdiction.value = defaults.jurisdiction;
  if (risk) risk.value = defaults.riskLevel;
}
function applyAgentIntakeTemplate(presetId) {
  const template = AGENT_INTAKE_TEMPLATES[presetId];
  if (!template) return;
  selectPresetId(presetId);
  const nameEl = $("#simple-name");
  const aliasEl = $("#simple-alias");
  const regionEl = $("#simple-region");
  const urlsEl = $("#simple-urls");
  if (nameEl) nameEl.value = template.name;
  if (aliasEl) aliasEl.value = template.alias || "";
  if (regionEl) regionEl.value = template.region || "";
  if (urlsEl) urlsEl.value = template.urls || "";
  const defaults = SIMPLE_PRESET_DEFAULTS[presetId] || SIMPLE_PRESET_DEFAULTS["people-search-cleanup"];
  const intakeText = intakeTextForPreset(presetId, {
    name: template.name,
    region: template.region,
    alias: template.alias
  });
  syncSimpleFormToLegacyFields({
    intakeText,
    personLabel: template.name,
    pastedUrls: (template.urls || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    jurisdiction: defaults.jurisdiction,
    authorityBasis: "self",
    riskLevel: defaults.riskLevel
  });
  addChat("user", template.chatLine);
  addChat(
    "agent",
    `${presentPreset({ id: presetId }).title} template loaded in the main form. Edit anything on the left, then tap Start cleanup.`
  );
  renderIntakeInferencePreview();
  render();
  pulseFocusField(nameEl);
}
function syncSimpleFormToLegacyFields(parsed) {
  const intakeField = $("#agent-intake");
  if (intakeField) intakeField.value = parsed.intakeText;
  const label = $("#person-label");
  if (label) label.value = parsed.personLabel;
  const jurisdiction = $("#jurisdiction");
  if (jurisdiction) jurisdiction.value = parsed.jurisdiction;
  const authority = $("#authority");
  if (authority) authority.value = parsed.authorityBasis;
  const risk = $("#risk-level");
  if (risk) risk.value = parsed.riskLevel;
  if (parsed.pastedUrls.length && $("#findings-paste-input")) {
    $("#findings-paste-input").value = parsed.pastedUrls.join("\n");
  }
}
function pulseFocusField(field) {
  if (!field) return;
  field.focus({ preventScroll: true });
  field.classList.add("intake-focus-pulse");
  window.setTimeout(() => field.classList.remove("intake-focus-pulse"), 1600);
}
function focusIntake() {
  const onboardingActive = $("#onboarding-region")?.classList.contains("active");
  const simpleName = $("#simple-name");
  if (onboardingActive && simpleName) {
    $("#onboarding-region")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    window.setTimeout(() => pulseFocusField(simpleName), 120);
    return;
  }
  const intake = $("#agent-intake");
  if (onboardingActive && intake) {
    $("#onboarding-region")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    window.setTimeout(() => pulseFocusField(intake), 120);
    return;
  }
  if (state.appOpen && state.currentCaseId) {
    state.dockOpen = true;
    render();
    $("#app-workspace")?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => pulseFocusField($("#agent-input")), 120);
    return;
  }
  $("#app-workspace")?.scrollIntoView({ behavior: "smooth", block: "start" });
  window.setTimeout(() => pulseFocusField(intake || $("#agent-input")), 120);
}
function shouldShowRouteTab() {
  if (!state.currentCaseId || !currentCase()) return false;
  if (state.showRouteTab) return true;
  if (state.agentNext?.action === "select-preset") return true;
  if (!state.agentPlan) return true;
  if (state.selectedPresetId !== state.recommendedPresetId) return true;
  return false;
}
function revealRouteTab(options = {}) {
  state.showRouteTab = true;
  if (options.focusTab !== false) state.tab = "tasks";
  render();
}
function syncRouteTabVisibility() {
  const show = shouldShowRouteTab();
  document.querySelectorAll(".tab-route").forEach((tab) => {
    tab.hidden = !show;
  });
  const changeRoute = $("#change-route");
  if (changeRoute) changeRoute.hidden = !state.currentCaseId || show;
  if (!show && state.tab === "tasks") state.tab = "overview";
  if (show && state.agentNext?.action === "select-preset" && state.tab === "overview") {
    state.tab = "tasks";
  }
}
async function performGuidePrimaryAction() {
  const step = currentGuideStep();
  if (!state.appOpen) {
    openApp();
    return;
  }
  if (step === 1) {
    if (!state.currentCaseId) {
      await startSimpleCleanup();
      return;
    }
  }
  if (step === 2) {
    const pending = state.currentStatus?.pendingFindings?.length ?? 0;
    if (pending > 0) {
      $("#findings-panel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      render();
      return;
    }
    await agentAutopilot();
    return;
  }
  if (step === 3) {
    state.tab = "overview";
    state.dockOpen = true;
    render();
    return;
  }
  await agentAutopilot();
}
function renderUserGuide() {
  const guide = $("#user-guide");
  if (!guide) return;
  const step = currentGuideStep();
  const showDashboard = state.appOpen && Boolean(state.currentCaseId && currentCase() && state.currentStatus) && !state.preSearchReady;
  guide.hidden = !showDashboard;
  const lead = $("#guide-lead");
  if (lead) {
    const active = GUIDE_STEPS[step - 1];
    lead.textContent = showDashboard ? active.hint : "";
  }
  const toolbarMeta = $("#toolbar-case-meta");
  const toolbarStep = $("#toolbar-step-label");
  const showToolbar = state.appOpen && Boolean(state.currentCaseId && currentCase() && state.currentStatus);
  if (toolbarMeta) toolbarMeta.hidden = !showToolbar;
  if (toolbarStep && showToolbar) {
    const caseLabel = currentCase()?.redactedScope?.personLabel || "Case";
    const stepTitle = GUIDE_STEPS[step - 1]?.title || "Working";
    toolbarStep.textContent = `${stepTitle} \xB7 ${caseLabel}`;
  }
  const stepsEl = $("#guide-steps");
  if (stepsEl) {
    stepsEl.innerHTML = GUIDE_STEPS.map((item) => {
      const status = item.num < step ? "done" : item.num === step ? "active" : "pending";
      return `<li class="guide-checkpoint ${status}" role="listitem" data-guide-step="${item.num}" title="${escapeHtml(item.hint)}">
        <span class="guide-checkpoint-num">Step ${item.num}</span>
        <span class="guide-checkpoint-label">${escapeHtml(item.title)}</span>
      </li>`;
    }).join("");
    bindIcons(stepsEl);
  }
  const progressTrack = $("#guide-progress-track");
  const progressFill = $("#guide-progress-fill");
  const pct = GUIDE_STEPS.length > 1 ? (step - 1) / (GUIDE_STEPS.length - 1) * 100 : 0;
  if (progressTrack) {
    progressTrack.setAttribute("aria-valuenow", String(step));
    progressTrack.setAttribute("aria-valuetext", GUIDE_STEPS[step - 1]?.title || "Working");
  }
  if (progressFill) progressFill.style.width = `${pct}%`;
  const phaseStatus = $("#guide-phase-status");
  if (phaseStatus) phaseStatus.textContent = showDashboard ? workflowStatusLine() : "";
  syncRouteTabVisibility();
}
function write(value) {
  if (output) {
    output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  }
  if (value?.caseStatus) {
    state.currentStatus = value.caseStatus;
    if (value.plan) state.agentPlan = value.plan;
    if (value.connectorResults) state.connectorResults = value.connectorResults;
    renderDashboard();
    renderAgentChat();
    renderApprovals();
    renderActions();
  }
}
function pillClass(value) {
  if (value === true || value === "pass" || value === "used" || value === "ready") return "pill pass";
  if (value === false || value === "fail" || value === "blocked") return "pill fail";
  return "pill warn";
}
function chipClass(value) {
  return pillClass(value).replace("pill", "chip");
}
function yesNo(value) {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "unknown";
}
var PRESET_PRESENTATION = {
  "people-search-cleanup": {
    title: "People-search",
    description: "Find profiles, draft removals, recheck later.",
    tags: ["Profiles", "Recheck", "Approval"]
  },
  "search-result-suppression": {
    title: "Search results",
    description: "Plan source deletion and Google suppression.",
    tags: ["Google", "Source first", "Handoff"]
  },
  "california-drop": {
    title: "California DROP",
    description: "Guide the official California deletion route.",
    tags: ["CA only", "Official", "90d"]
  },
  "gdpr-erasure": {
    title: "GDPR/UK",
    description: "Draft erasure requests and response tracking.",
    tags: ["EU/UK", "Controller", "1mo"]
  },
  "breach-exposure": {
    title: "Breach check",
    description: "Check exposure safely and focus on mitigation.",
    tags: ["HIBP", "Prefix-safe", "Mitigation"]
  },
  "high-risk-safety": {
    title: "Safety cleanup",
    description: "Prioritize urgent address and safety exposure.",
    tags: ["Priority", "Address", "Manual confirm"]
  }
};
function presentPreset(preset) {
  return PRESET_PRESENTATION[preset?.id] || {
    title: preset?.title || "Cleanup",
    description: preset?.summary || "Prepare cleanup actions.",
    tags: ["Approval"]
  };
}
function runtimeLabel(proof = state.trustProof) {
  if (proof?.verifierResult === "pass") return { text: "TEE verified", state: "pass" };
  if (proof?.verifierResult === "fail") return { text: "TEE blocked", state: "fail" };
  return { text: "Local mode", state: "warn" };
}
function teeQuestionIntent(lower) {
  return /\b(tee|attestation|trust center|runtime proof|hardware quote|verify runtime)\b/.test(lower) || lower.includes("view tee") || lower.includes("verify tee");
}
async function buildTeeVerificationBrief() {
  const proof = state.trustProof || await refreshTrust();
  const privacy = state.privacy;
  const runtime = runtimeLabel(proof);
  const lines = [`Runtime: ${runtime.text}.`];
  if (proof) {
    lines.push(
      `Verifier result: ${proof.verifierResult || "unknown"}.`,
      `TEE quote verified: ${yesNo(proof.hardwareQuoteVerified)}.`,
      `Compose hash matches: ${yesNo(proof.composeHashMatches)}.`,
      `Image digests pinned: ${yesNo(proof.imageDigestsPinned)}.`,
      `Attestation fresh: ${yesNo(proof.attestationFresh)}.`
    );
    if (proof.errors?.length) {
      lines.push(`Open issues: ${proof.errors.slice(0, 3).join("; ")}.`);
    }
  } else {
    lines.push("Attestation proof is not loaded yet.");
  }
  if (privacy) {
    lines.push(`Server can decrypt vault: ${yesNo(privacy.serverCanDecryptCaseVault)} (should be no).`);
  }
  if (runtime.state === "pass") {
    lines.push("TEE is passing \u2014 sensitive connectors may run only after your explicit approval.");
  } else {
    lines.push("Sensitive connectors stay blocked until attestation passes. Open the Trust tab for the full proof JSON.");
  }
  return lines.join(" ");
}
function parseIntakeForCase(intakeText) {
  const text = String(intakeText || "").trim();
  const lower = text.toLowerCase();
  let jurisdiction = "US";
  if (/\b(uk|united kingdom|britain|england|scotland|wales)\b/.test(lower)) jurisdiction = "UK";
  else if (/\b(eu|europe|european|gdpr|ireland|germany|france)\b/.test(lower)) jurisdiction = "EU";
  let riskLevel = "standard";
  if (/(stalking|safety|current address|minor|work|school|urgent|harassment)/.test(lower)) {
    riskLevel = "high-risk-safety";
  }
  let authorityBasis = "self";
  if (/(guardian|minor child|my child)/.test(lower)) authorityBasis = "minor-guardian";
  else if (/(estate|deceased|death of)/.test(lower)) authorityBasis = "estate";
  else if (/(survivor|family member passed)/.test(lower)) authorityBasis = "survivor";
  else if (/(authorized representative|on behalf of)/.test(lower)) authorityBasis = "authorized-representative";
  const personLabel = personLabelFromIntake(text);
  return { intakeText: text, jurisdiction, riskLevel, authorityBasis, personLabel };
}
function personLabelFromIntake(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "Private case";
  const forMatch = trimmed.match(/\b(?:for|of)\s+([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+)\b/);
  if (forMatch) return forMatch[1].trim();
  return trimmed.length > 52 ? `${trimmed.slice(0, 49).trim()}\u2026` : trimmed;
}
function redactedScopeFromIntake(parsed) {
  const text = parsed.intakeText || "";
  const aliases = [...parsed.aliases || []];
  const approvedIdentifierLabels = [];
  if (parsed.personLabel && parsed.personLabel !== "Private case") {
    approvedIdentifierLabels.push("legal-name");
  }
  if (parsed.region || /(massachusetts|\bma\b|city-state|address|phone)/i.test(text)) {
    approvedIdentifierLabels.push("city-state");
  }
  if (/(email)/i.test(text)) approvedIdentifierLabels.push("email");
  const sensitiveConstraints = [];
  if (parsed.region) sensitiveConstraints.push(parsed.region);
  else if (/massachusetts/i.test(text)) sensitiveConstraints.push("Massachusetts");
  return {
    personLabel: parsed.personLabel,
    aliases,
    approvedIdentifierLabels,
    sensitiveConstraints
  };
}
var URL_IN_TEXT_RE = /https?:\/\/[^\s<>"']+/gi;
function urlsFromText(text) {
  return [...new Set((String(text || "").match(URL_IN_TEXT_RE) || []).map((item) => item.trim()))];
}
function pastedUrlsFromFindingsInput() {
  const raw = $("#findings-paste-input")?.value || "";
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
function discoveryUrlHints() {
  const fromPaste = pastedUrlsFromFindingsInput();
  if (fromPaste.length) return fromPaste;
  const fromSimple = ($("#simple-urls")?.value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (fromSimple.length) return fromSimple;
  const fromIntake = urlsFromText(state.intakeText || $("#agent-intake")?.value || "");
  if (fromIntake.length) return fromIntake;
  if (!state.currentCaseId) return [];
  try {
    const stored = localStorage.getItem(`oblivion.discoveryUrls.${state.currentCaseId}`);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}
function peopleSearchPresetActive() {
  const presetId = state.agentPlan?.presetId || state.selectedPresetId;
  return presetId === "people-search-cleanup" || presetId === "high-risk-safety" || presetId === "content-takedown";
}
function brokerSubmissionBadge(finding) {
  if (!finding.submissionMethod) return "";
  const mode = finding.teeAutomatable ? "automatable" : "handoff";
  return `<span class="pill small">${escapeHtml(finding.submissionMethod)} \xB7 ${mode}</span>`;
}
function needsExposureDiscovery() {
  const step = state.agentNext?.action || state.agentPlan?.currentStep;
  const blocked = state.agentNext?.blockedReasons || state.agentPlan?.blockedReasons || [];
  if (step !== "discover-candidates" && !blocked.includes("discovery-needed")) return false;
  const pending = state.currentStatus?.pendingFindings?.length ?? 0;
  const total = state.currentStatus?.findings?.length ?? 0;
  return pending === 0 && total === 0;
}
function openFindingsPastePanel() {
  const details = $("#findings-paste-details");
  if (details && !details.open) details.open = true;
  pulseFocusField($("#findings-paste-input"));
}
function applyParsedIntakeToForm(parsed) {
  const intakeField = $("#agent-intake");
  const legacyIntake = $("#intake");
  if (intakeField) intakeField.value = parsed.intakeText;
  if (legacyIntake) legacyIntake.value = parsed.intakeText;
  const label = $("#person-label");
  if (label) label.value = parsed.personLabel;
  const jurisdiction = $("#jurisdiction");
  if (jurisdiction) jurisdiction.value = parsed.jurisdiction;
  const authority = $("#authority");
  if (authority) authority.value = parsed.authorityBasis;
  const risk = $("#risk-level");
  if (risk) risk.value = parsed.riskLevel;
}
function renderIntakeInferencePreview() {
  const preview = $("#intake-inference-preview");
  const raw = $("#agent-intake")?.value?.trim();
  if (!preview) return;
  if (!raw) {
    preview.textContent = "Jurisdiction and route are inferred when you start.";
    return;
  }
  const parsed = parseIntakeForCase(raw);
  const presetId = recommendPreset(parsed);
  preview.textContent = `I\u2019ll use ${parsed.jurisdiction} \xB7 ${parsed.riskLevel === "high-risk-safety" ? "safety route" : "standard"} \xB7 route: ${presetTitle(presetId)}.`;
}
function recommendPreset(input) {
  const text = `${input.intakeText || ""} ${input.riskLevel || ""}`.toLowerCase();
  const jurisdiction = input.jurisdiction;
  if (/(stalking|safety|current address|minor|work|school)/.test(text)) return "high-risk-safety";
  if (/(drop|california|\bca\b)/.test(text) && jurisdiction === "US") return "california-drop";
  if (/(gdpr|erasure|controller|\buk\b|\beu\b)/.test(text) && ["EU", "UK"].includes(jurisdiction)) return "gdpr-erasure";
  if (/(breach|password|email leak|leaked email)/.test(text)) return "breach-exposure";
  if (/(takedown|dmca|copyright|onlyfans|fanvue|leaked video|stolen content|infringing)/.test(text)) {
    return "content-takedown";
  }
  if (/google/.test(text)) return "search-result-suppression";
  if (/(people-search|people search|profile|address)/.test(text)) return "people-search-cleanup";
  if (/(search|result)/.test(text)) return "search-result-suppression";
  return jurisdiction === "EU" || jurisdiction === "UK" ? "gdpr-erasure" : "people-search-cleanup";
}
function selectedPreset() {
  return state.presets.find((preset) => preset.id === state.selectedPresetId) || null;
}
function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function renderChatBubble(message) {
  const role = message.role === "user" ? "user" : "agent";
  const animate = role === "agent" && message.animate && message.text;
  const bodyText = animate ? "" : escapeHtml(message.text);
  const bodyAttrs = animate ? ` data-typewriter-text="${escapeHtml(message.text)}"` : "";
  const rowAttrs = message.id != null ? ` data-chat-msg-id="${message.id}"` : "";
  const body = `<div class="chat-bubble ${role}${animate ? " chat-bubble-typing" : ""}"${bodyAttrs}>${bodyText}</div>`;
  if (role === "user") {
    return `<div class="chat-row user" data-chat-role="user"${rowAttrs}>${body}</div>`;
  }
  const avatar = `<span class="chat-avatar chat-avatar-agent" title="Agent" aria-label="Agent" data-icon="message"></span>`;
  return `<div class="chat-row agent" data-chat-role="agent"${rowAttrs}>${avatar}${body}</div>`;
}
function cancelChatTypewriters() {
  chatTypewriterTimers.forEach((timer) => window.clearTimeout(timer));
  chatTypewriterTimers = [];
}
function runChatTypewriters(log, logShell) {
  cancelChatTypewriters();
  log.querySelectorAll("[data-typewriter-text]").forEach((bubble) => {
    const fullText = bubble.dataset.typewriterText || "";
    const row = bubble.closest("[data-chat-msg-id]");
    const msgId = row ? Number(row.dataset.chatMsgId) : NaN;
    let index = 0;
    const step = () => {
      bubble.textContent = fullText.slice(0, index);
      if (logShell) logShell.scrollTop = logShell.scrollHeight;
      if (index < fullText.length) {
        index += 1;
        const delay = fullText.length > 160 ? 8 : fullText.length > 80 ? 12 : 18;
        chatTypewriterTimers.push(window.setTimeout(step, delay));
      } else {
        bubble.classList.remove("chat-bubble-typing");
        bubble.removeAttribute("data-typewriter-text");
        const msg = state.chatMessages.find((item) => item.id === msgId);
        if (msg) msg.animate = false;
      }
    };
    step();
  });
}
function saveLocalCases() {
  const summaries = state.cases.map((item) => ({
    id: item.id,
    jurisdiction: item.jurisdiction,
    riskLevel: item.riskLevel,
    authorityBasis: item.authorityBasis,
    redactedScope: item.redactedScope,
    updatedAt: item.updatedAt
  }));
  localStorage.setItem("oblivion.caseSummaries", JSON.stringify(summaries));
  if (state.currentCaseId) localStorage.setItem("oblivion.currentCaseId", state.currentCaseId);
}
function loadLocalCases() {
  try {
    return JSON.parse(localStorage.getItem("oblivion.caseSummaries") || "[]");
  } catch {
    return [];
  }
}
async function refreshTrust() {
  const [proof, privacy] = await Promise.all([
    request("/api/trust/attestation"),
    request("/api/trust/privacy")
  ]);
  state.trustProof = proof;
  state.privacy = privacy;
  renderTrust();
  return proof;
}
function syncAppRoute() {
  state.appOpen = location.hash === "#app";
}
async function refreshCases() {
  const localCases = loadLocalCases();
  try {
    const remote = await request("/api/cases");
    const byId = new Map(localCases.map((item) => [item.id, item]));
    for (const item of remote.cases) byId.set(item.id, item);
    state.cases = [...byId.values()];
    saveLocalCases();
  } catch {
    state.cases = localCases;
  }
  if (state.appOpen && state.currentCaseId) {
    await loadCase(state.currentCaseId, { silent: true, openApp: false });
  } else {
    await refreshAgentPlan({ silent: true }).catch(() => {
    });
    await refreshHackathon({ silent: true }).catch(() => {
    });
    render();
  }
}
async function refreshPresets() {
  const result = await request("/api/presets");
  state.presets = result.presets || [];
  if (!state.presets.some((preset) => preset.id === state.selectedPresetId)) {
    state.selectedPresetId = state.presets[0]?.id || "people-search-cleanup";
  }
}
async function refreshAgentPlan(options = {}) {
  if (!state.currentCaseId) {
    state.agentPlan = null;
    state.connectorResults = [];
    return;
  }
  const result = await request(`/api/cases/${state.currentCaseId}/plan`);
  state.agentPlan = result.plan;
  state.connectorResults = result.connectorResults || [];
  if (result.presets?.length) state.presets = result.presets;
  if (!options.silent) write(result);
}
async function loadCase(caseId, options = {}) {
  if (options.openApp !== false) {
    state.appOpen = true;
    state.dockOpen = true;
    state.dockPinned = true;
    location.hash = "app";
  }
  state.currentCaseId = caseId;
  localStorage.setItem("oblivion.currentCaseId", caseId);
  try {
    const loaded = await request(`/api/cases/${caseId}`);
    state.currentStatus = loaded.status;
    const index = state.cases.findIndex((item) => item.id === caseId);
    const summary = { ...loaded.case, status: loaded.status };
    if (index >= 0) state.cases[index] = summary;
    else state.cases.unshift(summary);
    saveLocalCases();
    if (!options.silent) write(loaded);
    await refreshAgentPlan({ silent: true }).catch(() => {
    });
    await refreshHackathon({ silent: true }).catch(() => {
    });
  } catch (error) {
    state.currentStatus = null;
    if (error?.error === "case-not-found") {
      state.cases = state.cases.filter((item) => item.id !== caseId);
      state.currentCaseId = "";
      localStorage.removeItem("oblivion.currentCaseId");
      saveLocalCases();
      const replacement = state.appOpen ? state.cases[0] : null;
      if (replacement) {
        await loadCase(replacement.id, { silent: options.silent });
        return;
      }
    }
    if (!options.silent) write(error);
  }
  render();
}
if (typeof window !== "undefined") {
  window.__oblivionLoadCase = loadCase;
}
function currentCase() {
  return state.cases.find((item) => item.id === state.currentCaseId) || null;
}
function renderTrust() {
  const proof = state.trustProof;
  const privacy = state.privacy;
  if (!proof || !privacy) return;
  const runtime = runtimeLabel(proof);
  $("#trust-strip").innerHTML = `
    <span class="chip pass" data-testid="trust-vault" data-icon="lock" title="Vault locked">Vault</span>
    <span class="${chipClass(!privacy.serverCanDecryptCaseVault)}" data-testid="trust-server" data-icon="eye-closed" title="Server blind">Blind</span>
    <span class="${chipClass(runtime.state)}" data-testid="trust-runtime" data-icon="cast" title="${escapeHtml(runtime.text)}">${escapeHtml(runtime.text)}</span>
  `;
  const teeClass = pillClass(runtime.state);
  const teeNodes = ["#tee-status", "#command-tee-status", "#trust-tab-status"].map((sel) => $(sel)).filter(Boolean);
  teeNodes.forEach((node) => {
    node.className = teeClass;
    node.textContent = runtime.text;
  });
  $("#runtime-summary").innerHTML = `
    <div class="status-row"><span>Vault</span><strong>locked</strong></div>
    <div class="status-row"><span>Server</span><strong>blind</strong></div>
    <div class="status-row"><span>Runtime</span><strong>${runtimeLabel(proof).text}</strong></div>
  `;
  $("#trust-details").innerHTML = `
    <div class="status-row"><span>TEE quote</span><strong>${yesNo(proof.hardwareQuoteVerified)}</strong></div>
    <div class="status-row"><span>Compose hash</span><strong>${yesNo(proof.composeHashMatches)}</strong></div>
    <div class="status-row"><span>Image digests</span><strong>${yesNo(proof.imageDigestsPinned)}</strong></div>
    <div class="status-row"><span>Server can decrypt vault</span><strong>${yesNo(privacy.serverCanDecryptCaseVault)}</strong></div>
  `;
  $("#trust-output").textContent = JSON.stringify({ proof, privacy }, null, 2);
}
function formatCaseDate(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleDateString(void 0, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}
function toggleCasesPanel(open) {
  if (typeof open === "boolean") state.casesPanelOpen = open;
  else state.casesPanelOpen = !state.casesPanelOpen;
  renderCases();
}
function openNewCaseFlow() {
  state.appOpen = true;
  state.currentCaseId = "";
  state.currentStatus = null;
  state.agentPlan = null;
  state.connectorResults = [];
  state.recommendedPresetId = "people-search-cleanup";
  state.selectedPresetId = "people-search-cleanup";
  state.showRouteTab = false;
  state.casesPanelOpen = false;
  resetPreSearchUi();
  localStorage.removeItem("oblivion.currentCaseId");
  ["simple-name", "simple-alias", "simple-region", "simple-urls"].forEach((id) => {
    const field = $(`#${id}`);
    if (field) field.value = "";
  });
  const statusEl = $("#simple-start-status");
  if (statusEl) statusEl.textContent = "";
  focusIntake();
  render();
}
function renderCases() {
  const list = $("#case-list");
  if (!list) return;
  if (state.cases.length === 0) {
    list.innerHTML = `<div class="empty case-empty">No cases yet. Tap New case to start a cleanup.</div>`;
    return;
  }
  list.innerHTML = state.cases.map((item) => {
    const label = item.redactedScope?.personLabel || item.id.slice(0, 14);
    const active = item.id === state.currentCaseId ? " active" : "";
    const updated = formatCaseDate(item.updatedAt);
    const meta = [item.jurisdiction, item.riskLevel, updated].filter(Boolean).join(" \xB7 ");
    return `
      <div class="case-row${active}" data-case-row="${item.id}">
        <button type="button" class="case-button${active}" data-case-id="${item.id}" title="${escapeHtml(meta)}">
          <span class="case-button-label">${escapeHtml(label)}</span>
          <span class="case-button-meta muted small">${escapeHtml(meta)}</span>
        </button>
        <button type="button" class="ghost compact icon-only case-delete-btn" data-delete-case="${item.id}" data-icon="delete" aria-label="Delete ${escapeHtml(label)}"><span class="btn-label">Delete</span></button>
      </div>
    `;
  }).join("");
  bindIcons(list);
}
function workflowStatusLine() {
  const pending = state.currentStatus?.pendingFindings?.length || 0;
  const approvals = state.currentStatus?.approvalsNeeded?.length || 0;
  let statusLine = state.agentNext?.message || state.agentPlan?.nextUserDecision || "";
  if (pending > 0) statusLine = `${pending} listing(s) need your answer.`;
  if (approvals > 0) statusLine = "Approval required before anything is sent.";
  if (state.autopilotBusy) statusLine = "Running cleanup\u2026";
  return statusLine;
}
function renderShell() {
  const hasCase = Boolean(state.currentCaseId && currentCase() && state.currentStatus);
  const app = $(".app");
  const chrome = $("#app-chrome");
  const agentColumn = $("#app-agent-column");
  const workspace = $("#app-workspace");
  $("#landing-region")?.classList.toggle("hidden", state.appOpen);
  app?.classList.toggle("app-workspace-open", state.appOpen);
  if (chrome) {
    chrome.hidden = !state.appOpen;
    chrome.classList.toggle("active", state.appOpen);
    chrome.classList.toggle("agent-collapsed", state.appOpen && !state.dockPinned);
    chrome.classList.toggle("sidebar-collapsed", state.appOpen && !state.sidebarOpen);
  }
  const sidebarCollapse = $("#sidebar-collapse");
  if (sidebarCollapse) {
    sidebarCollapse.setAttribute("aria-expanded", state.sidebarOpen ? "true" : "false");
    sidebarCollapse.setAttribute("aria-label", state.sidebarOpen ? "Collapse sidebar" : "Expand sidebar");
    setIcon(sidebarCollapse, state.sidebarOpen ? "layout-sidebar-left" : "layout-sidebar-right");
  }
  workspace?.classList.toggle("simple-mode", !state.showAdvancedUI);
  agentColumn?.classList.toggle("collapsed", state.appOpen && !state.dockPinned);
  const showOnboarding = state.appOpen && (!hasCase || state.preSearchReady);
  const showDashboard = state.appOpen && hasCase && !state.preSearchReady;
  $("#onboarding-region")?.classList.toggle("active", showOnboarding);
  $("#dashboard-region")?.classList.toggle("active", showDashboard);
  applyAdvancedUiVisibility();
  const dockCollapse = $("#agent-dock-collapse");
  if (dockCollapse) {
    dockCollapse.setAttribute("aria-expanded", state.dockPinned ? "true" : "false");
    dockCollapse.setAttribute("aria-label", state.dockPinned ? "Hide agent panel" : "Show agent panel");
    setButtonLabel(dockCollapse, state.dockPinned ? "Hide" : "Show");
    setIcon(dockCollapse, state.dockPinned ? "minus" : "plus");
  }
  $("#agent-dock")?.classList.toggle("agent-dock-expanded", state.dockPinned);
}
function renderDashboard() {
  const caseRecord = currentCase();
  const status = state.currentStatus;
  if (!caseRecord) return;
  const label = caseRecord.redactedScope?.personLabel || "Private case";
  $("#case-heading").textContent = label;
  const subtitle = $("#case-subtitle");
  if (subtitle) {
    subtitle.textContent = `${presetTitle(state.agentPlan?.presetId) || "Cleanup"} \xB7 encrypted locally`;
  }
  const approvals = status?.approvalsNeeded?.length || 0;
  const ready = status?.actionsReady?.length || 0;
  const submitted = status?.submittedActions?.length || 0;
  const pending = status?.pendingFindings?.length || 0;
  const guideStep = currentGuideStep();
  const stepLabel = $("#current-step-label");
  if (stepLabel) stepLabel.textContent = GUIDE_STEPS[guideStep - 1]?.title || "Working";
  const nextPill = $("#next-action-pill");
  if (nextPill) nextPill.textContent = approvals > 0 ? "Approve" : pending > 0 ? "Review" : "Running";
  const nextCopy = $("#next-action-copy");
  if (nextCopy) {
    nextCopy.textContent = approvals > 0 ? "Nothing sends until you approve." : pending > 0 ? "Confirm your listings below." : "Agent is preparing opt-out requests.";
  }
  if (state.showAdvancedUI) {
    $("#case-glance").innerHTML = `
      <div class="status-row"><span>Approvals</span><strong>${approvals}</strong></div>
      <div class="status-row"><span>Ready</span><strong>${ready}</strong></div>
      <div class="status-row"><span>Recorded</span><strong>${submitted}</strong></div>
    `;
    const runtime = runtimeLabel();
    $("#ops-strip").innerHTML = `
      <div class="metric"><span>Runtime</span><strong>${runtime.text}</strong></div>
      <div class="metric"><span>Agent</span><strong>${state.agentNext ? shortStepTitle(state.agentNext.title) : "\u2026"}</strong></div>
    `;
    $("#agent-context").innerHTML = `
      <div class="agent-line"><span>Preset</span><strong>${escapeHtml(presetTitle(state.agentPlan?.presetId) || "\u2014")}</strong></div>
    `;
  }
  renderCleanupProgress();
}
function renderCleanupProgress() {
  const bar = $("#cleanup-progress");
  if (!bar) return;
  if (!state.agentPlan) {
    bar.innerHTML = "";
    return;
  }
  const statusLine = workflowStatusLine();
  const step = state.agentPlan.currentStep;
  const order = WORKFLOW_PHASES.map((phase) => phase.id);
  const index = Math.max(0, order.indexOf(step));
  bar.innerHTML = `
    <div class="progress-phases">
      ${WORKFLOW_PHASES.slice(0, 7).map((phase, i) => {
    const done = i < index;
    const active = phase.id === step;
    return `<span class="progress-phase ${done ? "done" : ""} ${active ? "active" : ""}">${escapeHtml(phase.label)}</span>`;
  }).join("")}
    </div>
    <p class="muted small progress-status">${escapeHtml(statusLine)}</p>
  `;
}
function matchScorePill(score) {
  if (score === "likely") return "pass";
  if (score === "unlikely") return "blocked";
  return "warn";
}
function shortenUrl(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.length > 28 ? `${parsed.pathname.slice(0, 28)}\u2026` : parsed.pathname;
    return `${parsed.hostname}${path}`;
  } catch {
    return url.length > 42 ? `${url.slice(0, 42)}\u2026` : url;
  }
}
function renderFindings() {
  const panel = $("#findings-panel");
  if (!panel) return;
  const status = state.currentStatus;
  const hasCase = Boolean(state.currentCaseId && status);
  panel.hidden = !hasCase;
  if (!hasCase) return;
  const pending = status.pendingFindings?.length ?? 0;
  const confirmed = status.confirmedFindings?.length ?? 0;
  const pill = $("#findings-count-pill");
  if (pill) {
    pill.textContent = pending > 0 ? `${pending} pending` : `${confirmed} confirmed`;
    pill.className = `pill ${pending > 0 ? "warn" : confirmed > 0 ? "pass" : ""}`.trim();
  }
  const hint = $("#findings-hint");
  if (hint) {
    hint.textContent = pending > 0 ? "Yes = yours \xB7 Not me = skip" : confirmed > 0 ? "Queued for removal after you approve." : "Add links below or tap Next.";
  }
  const list = $("#findings-list");
  const reviewables = (status.findings || []).filter((item) => item.matchStatus !== "rejected");
  if (list) {
    list.innerHTML = reviewables.length ? reviewables.map((finding) => {
      const pendingRow = (finding.matchStatus ?? "pending") === "pending";
      return `
        <article class="finding-card" data-finding-id="${finding.id}" data-testid="finding-card">
          <div class="finding-card-head">
            <strong>${escapeHtml(finding.brokerLabel || "Listing")}</strong>
            <span class="pill ${pillClass(matchScorePill(finding.matchScore))}">${escapeHtml(finding.matchScore || "uncertain")}</span>
            ${brokerSubmissionBadge(finding)}
          </div>
          <a class="finding-url" href="${escapeHtml(finding.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(shortenUrl(finding.sourceUrl))}</a>
          ${state.showAdvancedUI ? `<p class="muted small">${escapeHtml(finding.matchReason || finding.redactedSnippet || "Candidate")}</p>` : ""}
          ${pendingRow ? `<div class="finding-actions">
            <button type="button" class="secondary compact" data-finding-confirm="${finding.id}" data-testid="finding-confirm" data-icon="check">Confirm</button>
            <button type="button" class="ghost compact" data-finding-reject="${finding.id}" data-testid="finding-reject" data-icon="close">Not me</button>
          </div>` : `<span class="pill ${finding.matchStatus === "confirmed" ? "pass" : ""}">${escapeHtml(finding.matchStatus || "pending")}</span>`}
        </article>`;
    }).join("") : `<div class="empty">No links yet. Paste URLs above or run Discover.</div>`;
  }
  const queue = $("#removal-queue");
  const queueList = $("#removal-queue-list");
  const confirmedRows = status.confirmedFindings || [];
  if (queue) queue.hidden = confirmedRows.length === 0;
  if (queueList) {
    queueList.innerHTML = confirmedRows.length ? confirmedRows.map(
      (finding) => `
        <div class="finding-queue-row">
          <div>
            <strong>${escapeHtml(finding.brokerLabel || shortenUrl(finding.sourceUrl))}</strong>
            <div class="muted small">${escapeHtml(finding.removalStatus || "not-started")}${finding.submissionMethod ? ` \xB7 ${finding.submissionMethod}` : ""}</div>
          </div>
          ${finding.officialOptOutUrl ? `<a class="ghost compact" href="${escapeHtml(finding.officialOptOutUrl)}" target="_blank" rel="noopener noreferrer" data-icon="link">Opt out</a>` : ""}
        </div>`
    ).join("") : "";
  }
}
async function maybeAutoDiscoverFindings(options = {}) {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
  if (!options.force && (!peopleSearchPresetActive() || !needsExposureDiscovery())) {
    return { ran: false, reason: "not-needed" };
  }
  const pastedUrls = discoveryUrlHints();
  const braveReady = Boolean(state.integrationsStatus?.liveReady?.braveSearch);
  if (!pastedUrls.length && !braveReady) {
    if (!options.quiet) {
      openFindingsPastePanel();
      addChat("agent", "Paste profile URLs under Exposure links (one per line), then Discover or Run next step.");
    }
    return { ran: false, reason: "urls-needed" };
  }
  const result = await request(`/api/cases/${state.currentCaseId}/findings/discover`, {
    method: "POST",
    body: { pastedUrls }
  });
  state.currentStatus = result.status ?? (await request(`/api/cases/${state.currentCaseId}`)).status;
  if (pastedUrlsFromFindingsInput().length && $("#findings-paste-input")) {
    $("#findings-paste-input").value = "";
  }
  if (pastedUrls.length) {
    localStorage.setItem(`oblivion.discoveryUrls.${state.currentCaseId}`, JSON.stringify(pastedUrls));
  }
  await refreshAgentPlan({ silent: true }).catch(() => {
  });
  await refreshHackathon({ silent: true }).catch(() => {
  });
  if (!options.quiet) {
    addChat(
      "agent",
      result.discovered?.length ? `Found ${result.discovered.length} link(s) to review.` : "No new links \u2014 try pasting URLs or configure Brave search."
    );
    write(result);
  }
  return { ran: true, discovered: result.discovered?.length ?? 0, result };
}
async function discoverFindings() {
  const discovery = await maybeAutoDiscoverFindings({ force: true, quiet: false });
  if (!discovery.ran && discovery.reason === "urls-needed") {
    throw { error: "urls-required", message: "Paste at least one profile URL under Exposure links." };
  }
  if (discovery.ran && !discovery.discovered) {
    await syncCurrentCaseStatus();
  }
  render();
}
async function decideFinding(findingId, decision) {
  if (!state.currentCaseId) return;
  const result = await request(`/api/cases/${state.currentCaseId}/findings/${findingId}/${decision}`, {
    method: "POST",
    body: {}
  });
  state.currentStatus = result.status;
  await refreshAgentPlan({ silent: true }).catch(() => {
  });
  render();
  addChat("agent", decision === "confirm" ? "Marked as your listing." : "Marked as not you.");
}
function presetTitle(presetId) {
  const preset = state.presets.find((item) => item.id === presetId);
  return preset ? presentPreset(preset).title : "";
}
function renderPresets() {
  const caseRecord = currentCase();
  const presets = state.presets.length ? state.presets : [];
  const grid = $("#preset-grid");
  if (!grid) return;
  grid.innerHTML = presets.map((preset) => {
    const blocked = caseRecord && !preset.jurisdictions.includes(caseRecord.jurisdiction);
    const active = preset.id === state.selectedPresetId;
    const recommended = preset.id === state.recommendedPresetId;
    const display = presentPreset(preset);
    return `
      <button class="preset-card" data-preset-id="${preset.id}" ${active ? 'data-active="true"' : ""} ${recommended ? 'data-recommended="true"' : ""} ${blocked ? "disabled" : ""} data-testid="preset-card">
        <div>
          ${recommended ? `<span class="pill pass recommended-badge">Recommended</span>` : ""}
          <strong>${escapeHtml(display.title)}</strong>
          <div class="muted small">${escapeHtml(display.description)}</div>
        </div>
        <div class="preset-meta">
          ${display.tags.map((tag) => `<span class="pill">${escapeHtml(tag)}</span>`).join("")}
        </div>
      </button>
    `;
  }).join("") || `<div class="empty">Loading cleanup presets.</div>`;
  const selected = selectedPreset();
  const selectedDisplay = presentPreset(selected);
  const startPreset2 = $("#start-preset");
  if (startPreset2) {
    startPreset2.textContent = state.selectedPresetId === state.recommendedPresetId ? "Start recommended route" : "Start selected route";
  }
  const routeDetails = $("#route-details");
  if (!routeDetails) return;
  routeDetails.innerHTML = selected ? `
        <div class="status-row"><span>Route</span><strong>${escapeHtml(selectedDisplay.title)}</strong></div>
        <div class="status-row"><span>Needs</span><strong>${escapeHtml(selected.requiredIdentifierCategories.join(", "))}</strong></div>
        <div class="status-row"><span>Window</span><strong>${escapeHtml(selected.expectedWindow)}</strong></div>
        <div class="status-row"><span>Disclosure</span><strong>${escapeHtml(selected.disclosurePoints.join(", "))}</strong></div>
      ` : `<div class="empty">Select a route to see details.</div>`;
}
async function refreshHackathon(options = {}) {
  const products = await request("/api/x402/products");
  state.products = products.products || [];
  state.aiBudget = products.aiBudget || null;
  if (state.currentCaseId) {
    try {
      state.aiEntitlement = await request(`/api/cases/${state.currentCaseId}/ai-entitlement`);
    } catch {
      state.aiEntitlement = null;
    }
  } else {
    state.aiEntitlement = null;
  }
  if (!state.currentCaseId) {
    state.hackathon = null;
    state.hackathonStatus = null;
    return;
  }
  const [timeline, checklist] = await Promise.all([
    request(`/api/agents/timeline?caseId=${state.currentCaseId}`),
    request(`/api/hackathon/status?caseId=${state.currentCaseId}`)
  ]);
  const next = await request(`/api/agent/next?caseId=${state.currentCaseId}`);
  state.hackathon = timeline;
  state.hackathonStatus = checklist.status;
  state.hackathonPending = checklist.pending || [];
  state.agentNext = next;
  if (!options.silent) write({ products, timeline, checklist });
}
async function syncCurrentCaseStatus() {
  if (!state.currentCaseId) return;
  const loaded = await request(`/api/cases/${state.currentCaseId}`);
  state.currentStatus = loaded.status;
  const index = state.cases.findIndex((item) => item.id === state.currentCaseId);
  const summary = { ...loaded.case, status: loaded.status };
  if (index >= 0) state.cases[index] = summary;
  else state.cases.unshift(summary);
  saveLocalCases();
}
function addChat(role, text, options = {}) {
  if (role === "agent") {
    state.chatMessages.forEach((item) => {
      if (item.role === "agent") item.animate = false;
    });
  }
  const animate = role === "agent" && options.animate !== false;
  state.chatMessages.push({
    id: ++chatMessageSeq,
    role,
    text,
    animate
  });
  state.chatMessages = state.chatMessages.slice(-24);
}
function shortStepTitle(title) {
  return {
    "Choose cleanup preset": "Choose preset",
    "Collect minimum identifiers": "Vault ready",
    "Verify runtime trust": "Runtime checked",
    "Discover exposure candidates": "Scouting",
    "Confirm matches": "Match review",
    "Verify removal path": "Path verified",
    "Draft actions": "Draft ready",
    "Approval required": "Approval required",
    "Execute approved action": "Action ready",
    "Await confirmation": "Waiting",
    "Schedule recheck": "Recheck scheduled",
    "Escalate if needed": "Escalation ready",
    "Cleanup cycle complete": "Cycle complete",
    "Prepare wallet permissions": "Wallet ready",
    "Prepare one-off cleanup payment": "One-off payment ready",
    "Prepare monitoring subscription": "Monitor ready",
    "Ask Venice for redacted analysis": "Analysis ready",
    "Delegate specialist agents": "Agent network ready",
    "Relay latest payment": "Relay confirmed",
    "Prepare cleanup approval": "Approval drafted",
    "Waiting for approval": "Approval required",
    "Record approved action": "Action recorded",
    "Full demo complete": "Demo complete"
  }[title] || title;
}
function agentPromptForState() {
  const approvals = state.currentStatus?.approvalsNeeded || [];
  const readyActions = state.currentStatus?.actionsReady || [];
  const pendingFindings = state.currentStatus?.pendingFindings?.length ?? 0;
  const next = state.agentNext;
  const plan = state.agentPlan;
  if (!currentCase()) {
    return { state: "Start", message: "Enter your name \u2192 Start cleanup.", actions: [] };
  }
  if (!state.walletAddress && state.showAdvancedUI) {
    return { state: "Wallet", message: "Optional: connect wallet at the bottom of the sidebar.", actions: [] };
  }
  if (!plan) {
    return { state: "Setup", message: "Tap Next to run your template.", actions: ["run"] };
  }
  if (approvals.length > 0) {
    return {
      state: "Approve",
      message: "Review the card \u2014 nothing sends until you approve.",
      actions: ["review"]
    };
  }
  if (pendingFindings > 0) {
    return { state: "Review", message: "Tap Yes or Not me on each link.", actions: ["run"] };
  }
  if (next?.blockedReasons?.length) {
    const needsUrls = next.blockedReasons.includes("discovery-needed");
    return {
      state: "Paused",
      message: needsUrls ? "Add profile links, then Next." : next.message || "Paused \u2014 tap Next when ready.",
      actions: needsUrls ? ["run"] : ["run"]
    };
  }
  if (readyActions.length > 0) {
    return { state: "Record", message: "Tap Next to record approved work.", actions: ["run"] };
  }
  if (plan.currentStep === "complete") {
    return { state: "Done", message: "Cleanup cycle complete.", actions: [] };
  }
  const stepMessages = {
    "collect-minimum-identifiers": "Vault ready.",
    "verify-trust": runtimeLabel().text,
    "discover-candidates": "Searching listings\u2026",
    "confirm-matches": "Confirm your links.",
    "verify-removal-path": "Checking opt-out paths.",
    "draft-actions": "Drafting requests.",
    "request-approval": "Approval needed next.",
    "execute-approved-action": "Ready to record.",
    "await-confirmation": "Waiting on response.",
    "schedule-recheck": "Scheduling recheck.",
    "escalate-if-needed": "Preparing follow-up."
  };
  return {
    state: "Running",
    message: stepMessages[plan.currentStep] || "Tap Next to continue.",
    actions: ["run"]
  };
}
function hackathonPendingTracks() {
  const status = state.hackathonStatus;
  if (!status) return [];
  const pending = [];
  if (!status.x402OneOffReady) pending.push("x402");
  if (!status.veniceOutputReady) pending.push("Venice");
  if (!status.a2aRedelegationVisible) pending.push("A2A");
  if (!status.oneShotRelayerVisible) pending.push("1Shot");
  return pending;
}
function renderHackathonChecklist() {
  const target = $("#hackathon-checklist");
  if (!target) return;
  const pending = hackathonPendingTracks();
  const finishBtn = $("#finish-pending-tracks");
  if (finishBtn) {
    finishBtn.hidden = !state.currentCaseId || pending.length === 0;
    finishBtn.textContent = pending.length ? `Finish pending tracks (${pending.length})` : "All tracks ready";
    finishBtn.disabled = pending.length === 0;
  }
  const status = state.hackathonStatus;
  const rows = [
    ["MetaMask", status?.smartAccountVisible],
    ["ERC-7715 permission", status?.erc7715PermissionGranted],
    ["x402", status?.x402OneOffReady],
    ["ERC-7710", status?.erc7710SubscriptionReady],
    ["Venice", status?.veniceOutputReady],
    ["A2A", status?.a2aRedelegationVisible],
    ["1Shot", status?.oneShotRelayerVisible]
  ];
  target.innerHTML = rows.map(([label, value]) => `
    <div class="status-row">
      <span>${label}</span>
      <strong class="${pillClass(value)}">${value ? "ready" : "pending"}</strong>
    </div>
  `).join("");
}
function renderAgentPresetStarters() {
  const panel = $("#agent-template-panel");
  const container = $("#agent-preset-starters");
  if (!panel || !container) return;
  const show = state.appOpen;
  panel.hidden = !show;
  if (!show) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = Object.entries(AGENT_INTAKE_TEMPLATES).map(([presetId, template]) => {
    const title = presentPreset({ id: presetId }).title;
    const active = presetId === state.selectedPresetId;
    return `<button type="button" class="agent-preset-starter${active ? " active" : ""}" data-agent-preset="${presetId}" data-testid="agent-preset-${presetId}">${escapeHtml(title)}</button>`;
  }).join("");
}
function renderAgentChat() {
  const next = state.agentNext;
  const prompt = agentPromptForState();
  $("#agent-dock")?.classList.toggle("open", state.dockOpen);
  $("#app-agent-column")?.classList.toggle("open", state.dockOpen);
  const brief = $("#agent-dock-brief");
  if (brief) {
    brief.textContent = state.appOpen && !currentCase() ? "Pick a template below \u2014 it fills the chat and the main form." : prompt.message;
  }
  const live = $("#agent-live");
  if (live) live.textContent = `${prompt.state}. ${prompt.message}`;
  renderAgentPresetStarters();
  const log = $("#agent-chat-messages");
  const logShell = $("#agent-chat-log");
  if (log) {
    const transcript = [...state.chatMessages];
    if (state.appOpen && !currentCase() && transcript.length <= 2) {
      transcript.push({
        role: "agent",
        text: "Tap a template chip above to load a starter request, or type your own message below."
      });
    } else if (currentCase() && next) {
      transcript.push({
        role: "agent",
        text: `${shortStepTitle(next.title)} \xB7 ${next.message || "standing by"}`
      });
    }
    log.innerHTML = transcript.slice(-40).map(renderChatBubble).join("");
    bindIcons(log);
    runChatTypewriters(log, logShell);
    if (logShell) logShell.scrollTop = logShell.scrollHeight;
  }
  renderAgentQuickActions(prompt.actions);
  renderAgentActionCards();
  renderAgentSuggestionStrip(prompt);
  renderAgentSuggestions(prompt);
}
function renderAgentSuggestionStrip(prompt) {
  const container = $("#agent-suggestion-strip");
  if (!container) return;
  container.innerHTML = "";
  const phrases = [];
  if (state.appOpen) {
    phrases.push(guidePrimaryLabel(currentGuideStep()));
    phrases.push("Verify TEE");
  }
  if (prompt.actions.includes("review")) phrases.push("Review approval");
  if (prompt.actions.includes("explain")) phrases.push("Explain disclosure");
  if (currentCase()) {
    phrases.push("What's next?");
  }
  if (!currentCase() && state.appOpen) {
    phrases.push("Help me start");
  }
  [...new Set(phrases)].slice(0, 5).forEach((phrase) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "agent-suggestion-chip";
    btn.textContent = phrase;
    btn.addEventListener("click", () => fillAgentInput(phrase));
    container.appendChild(btn);
  });
  const agentDoNext = $("#agent-do-next");
  if (agentDoNext) setButtonLabel(agentDoNext, phrases[0] || "Next");
}
function renderAgentQuickActions(actions) {
  const actionSet = new Set(actions);
  const buttonMap = {
    start: $("#agent-start-recommended"),
    run: $("#agent-run-next"),
    review: $("#agent-review-approval"),
    explain: $("#agent-explain-disclosure"),
    settings: null,
    wallet: null
  };
  Object.entries(buttonMap).forEach(([key, button]) => {
    if (button) button.hidden = !actionSet.has(key);
  });
}
function renderAgentSuggestions(prompt) {
  const container = $("#agent-suggestions");
  if (!container) return;
  container.innerHTML = "";
  const suggestions = [];
  if (prompt.actions.includes("start")) suggestions.push("start recommended");
  if (prompt.actions.includes("run")) suggestions.push("run next");
  if (prompt.actions.includes("review")) suggestions.push("review approval");
  if (prompt.actions.includes("explain")) suggestions.push("explain disclosure");
  if (suggestions.length === 0 && currentCase()) {
    suggestions.push("run", "status");
  }
  suggestions.slice(0, 4).forEach((label) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.addEventListener("click", () => fillAgentInput(label));
    container.appendChild(btn);
  });
}
function renderAgentActionCards() {
  const approvals = state.currentStatus?.approvalsNeeded || [];
  const readyActions = state.currentStatus?.actionsReady || [];
  const cards = [
    ...approvals.map((approval) => `
      <div class="row" data-testid="approval-card">
        <div>
          <strong>Approval needed: ${escapeHtml(approval.destination)}</strong>
          <div class="muted small">${approval.actionType} \xB7 disclose ${approval.dataToDisclose.join(", ")} \xB7 expires ${escapeHtml(approval.expiresAt.slice(0, 10))}</div>
        </div>
        <button data-chat-approve-id="${approval.id}" data-testid="approve-exact">Approve exact action</button>
      </div>
    `),
    ...readyActions.map((action) => `
      <div class="row" data-testid="ready-action-card">
        <div>
          <strong>Ready: ${escapeHtml(action.destination)}</strong>
          <div class="muted small">${action.actionType} \xB7 ${action.executionStatus}</div>
        </div>
        <button data-chat-execute-id="${action.id}" data-testid="record-action">Record action</button>
      </div>
    `)
  ];
  const container = $("#agent-action-cards");
  if (!container) return;
  container.innerHTML = cards.join("");
}
function hasActiveCase() {
  return Boolean(state.currentCaseId && currentCase() && state.currentStatus);
}
function shortenAddress(address) {
  if (!address || address.length < 12) return address || "Not connected";
  return `${address.slice(0, 6)}\u2026${address.slice(-4)}`;
}
function pickMetaMaskFromWindow() {
  const eth = window.ethereum;
  if (!eth) return null;
  const list = eth.providers?.length ? eth.providers : eth.isMetaMask !== void 0 ? [eth] : [];
  if (list.length) {
    const mm = list.find((p) => p.isMetaMask);
    if (mm) return mm;
    walletLog.warn("No isMetaMask flag; multiple wallets may conflict", {
      count: list.length,
      names: list.map((p) => p.isMetaMask ? "metamask" : "other")
    });
  }
  if (eth.isMetaMask) return eth;
  return null;
}
async function resolveEthereumProvider(options = {}) {
  if (!options.forceFresh && state.ethereumProvider?.request) {
    walletLog.info("Reusing cached provider", { isMetaMask: state.ethereumProvider.isMetaMask });
    return state.ethereumProvider;
  }
  const direct = pickMetaMaskFromWindow();
  if (direct?.request) {
    walletLog.info("Using window MetaMask provider", { isMetaMask: direct.isMetaMask });
    return direct;
  }
  const discovered = await new Promise((resolve) => {
    const providers = [];
    const onAnnounce = (event) => {
      providers.push(event.detail);
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    window.setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      const preferred = providers.find((entry) => /metamask/i.test(entry?.info?.name || ""));
      walletLog.info("EIP-6963 discovery", {
        total: providers.length,
        picked: preferred?.info?.name || providers[0]?.info?.name || "none"
      });
      resolve(preferred?.provider || providers[0]?.provider || null);
    }, 800);
  });
  if (discovered?.request) return discovered;
  walletLog.warn("No injected provider \u2014 demo wallet fallback");
  return null;
}
async function revokeWalletPermissions(provider) {
  if (!provider?.request) return;
  try {
    await provider.request({
      method: "wallet_revokePermissions",
      params: [{ eth_accounts: {} }]
    });
    walletLog.info("wallet_revokePermissions ok");
  } catch (error) {
    walletLog.warn("wallet_revokePermissions skipped", { code: error?.code, message: error?.message });
  }
}
async function requestWalletAccounts(provider, options = {}) {
  if (!provider?.request) return [];
  if (options.pickAccount) {
    try {
      await provider.request({
        method: "wallet_requestPermissions",
        params: [{ eth_accounts: {} }]
      });
    } catch (error) {
      if (error?.code === 4001) throw error;
      walletLog.warn("wallet_requestPermissions skipped", { code: error?.code, message: error?.message });
    }
  }
  return provider.request({ method: "eth_requestAccounts" });
}
function walletButtonLabel() {
  if (state.smartAccountAddress) return shortenAddress(state.smartAccountAddress);
  if (state.walletAddress) return shortenAddress(state.walletAddress);
  return "Connect wallet";
}
function walletButtonTitle() {
  if (state.walletConnectError) return state.walletConnectError;
  if (state.smartAccountAddress) return `Smart Account \xB7 ${state.smartAccountAddress} \xB7 click for wallet details`;
  if (state.walletAddress) return `${state.walletAddress} \xB7 click for wallet details`;
  return "Connect MetaMask";
}
function toggleWalletModal(open) {
  const dialog = $("#wallet-modal");
  if (!dialog) return;
  const shouldOpen = typeof open === "boolean" ? open : !dialog.open;
  if (shouldOpen && state.walletAddress) {
    renderWalletModal();
    if (!dialog.open) dialog.showModal();
    state.walletModalOpen = true;
    bindIcons(dialog);
    return;
  }
  if (dialog.open) dialog.close();
  state.walletModalOpen = false;
}
function renderWalletModal() {
  const body = $("#wallet-modal-body");
  if (!body) return;
  const wallet = state.walletAddress || "Not connected";
  const smart = state.smartAccountAddress || "Not created";
  const mode = state.walletMode || "\u2014";
  body.innerHTML = `
    <div class="status-list wallet-modal-status">
      <div class="status-row"><span>Wallet</span><strong title="${escapeHtml(wallet)}">${escapeHtml(shortenAddress(wallet))}</strong></div>
      <div class="status-row"><span>Smart Account</span><strong title="${escapeHtml(smart)}">${escapeHtml(shortenAddress(smart))}</strong></div>
      <div class="status-row"><span>Mode</span><strong>${escapeHtml(mode)}</strong></div>
    </div>
    ${state.walletConnectNote ? `<p class="muted small">${escapeHtml(state.walletConnectNote)}</p>` : ""}
    ${state.walletConnectError ? `<p class="wallet-connect-feedback fail">${escapeHtml(state.walletConnectError)}</p>` : ""}
  `;
  const smartBtn = $("#wallet-modal-smart-account");
  if (smartBtn) {
    smartBtn.hidden = !state.currentCaseId || Boolean(state.smartAccountAddress);
  }
}
function renderWalletFeedback() {
  const errorText = state.walletConnectError || "";
  const primary = $("#wallet-feedback-primary");
  if (primary) {
    primary.className = errorText ? "visually-hidden wallet-connect-feedback fail" : "visually-hidden wallet-connect-feedback";
    primary.textContent = errorText;
  }
  document.querySelectorAll("[data-wallet-feedback-secondary]").forEach((node) => {
    if (errorText) {
      node.hidden = false;
      node.className = "wallet-connect-feedback fail";
      node.textContent = errorText;
    } else {
      node.hidden = true;
      node.textContent = "";
    }
  });
  const onboardingFb = $("#wallet-feedback-onboarding");
  if (onboardingFb) {
    onboardingFb.textContent = "";
  }
}
function openPaymentRails() {
  state.tab = "settings";
  state.dockOpen = false;
  render();
  window.setTimeout(() => {
    $("#payment-rails")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, 80);
}
function openWalletHub() {
  state.tab = "settings";
  state.dockOpen = false;
  render();
  window.setTimeout(() => {
    $("#wallet-hub")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    $("#wallet-feedback-primary")?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, 80);
}
function renderWalletCommandStrip() {
  const strip = $("#wallet-command-strip");
  if (!strip) return;
  strip.hidden = !state.appOpen;
  const primary = $("#connect-wallet-primary");
  if (primary) {
    setButtonLabel(primary, walletButtonLabel());
    primary.title = walletButtonTitle();
    primary.classList.toggle("connected", Boolean(state.walletAddress));
    primary.disabled = false;
    primary.removeAttribute("data-connect-wallet");
    if (!state.walletAddress) primary.setAttribute("data-connect-wallet", "");
    else primary.setAttribute("data-wallet-modal", "");
  }
  const liveBtn = $("#upgrade-metamask-live");
  if (liveBtn) {
    liveBtn.hidden = !state.walletConfig?.liveEnabled || !state.walletAddress;
  }
  const hint = $("#wallet-live-hint");
  if (hint) {
    hint.textContent = state.walletConfig?.liveEnabled ? "Sepolia Smart Account upgrade uses MetaMask wallet_sendCalls (EIP-5792)." : "Smart Account records EIP-7702 + ERC-7715 permissions for your case. Enable WALLET_LIVE_MODE for Sepolia on-chain upgrade.";
  }
  if (state.walletModalOpen && state.walletAddress) renderWalletModal();
}
function renderWalletPanels() {
  const wallet = state.walletAddress || "Not connected";
  const smart = state.smartAccountAddress || "Not created";
  const rows = `
    <div class="status-row"><span>Wallet</span><strong title="${escapeHtml(wallet)}">${escapeHtml(shortenAddress(wallet))}</strong></div>
    <div class="status-row"><span>Smart Account</span><strong title="${escapeHtml(smart)}">${escapeHtml(shortenAddress(smart))}</strong></div>
  `;
  const onboardingWallet = $("#onboarding-wallet-status");
  const settingsWallet = $("#wallet-status");
  if (onboardingWallet) onboardingWallet.innerHTML = rows;
  if (settingsWallet) settingsWallet.innerHTML = rows;
  const settingsConnect = $("#connect-wallet");
  const settingsDisconnect = $("#disconnect-wallet");
  if (settingsConnect) settingsConnect.hidden = Boolean(state.walletAddress);
  if (settingsDisconnect) settingsDisconnect.hidden = true;
  renderWalletFeedback();
  renderWalletCommandStrip();
}
function formatProductPrice(product) {
  if (product.mode === "subscription") {
    return `$${product.amountUsd} ${product.token}/mo`;
  }
  return `$${product.amountUsd} ${product.token}`;
}
function productBudgetLine(product) {
  const limits = state.aiBudget?.[product.mode];
  if (!limits) return "";
  return `${limits.maxChats} agent chats \xB7 ${limits.maxAnalyses} AI tasks \xB7 ${limits.maxTokens} token cap`;
}
function renderPayments() {
  renderWalletPanels();
  const grid = $("#payment-rails-grid");
  if (grid) {
    grid.innerHTML = state.products.length ? state.products.map((product) => {
      const activeSession = (state.hackathon?.payments || []).find(
        (session) => session.productId === product.id
      );
      const status = activeSession?.status || "not-started";
      return `
            <article class="payment-rail-card" data-payment-product="${product.id}">
              <div class="payment-rail-head">
                <strong>${escapeHtml(product.name)}</strong>
                <span class="pill">${formatProductPrice(product)}</span>
              </div>
              <p class="muted small">${escapeHtml(product.description)}</p>
              <p class="muted small payment-rail-budget">${escapeHtml(productBudgetLine(product))}</p>
              <button
                type="button"
                class="${product.mode === "subscription" ? "secondary" : ""}"
                data-pay-product="${product.id}"
                data-pay-mode="${product.mode}"
                data-testid="pay-${product.id}"
              >
                ${product.mode === "subscription" ? "Subscribe" : "Pay once"}
              </button>
              <p class="muted small payment-rail-status">${escapeHtml(status)}</p>
            </article>
          `;
    }).join("") : `<div class="empty">Payment products are loading.</div>`;
    grid.querySelectorAll("[data-pay-product]").forEach((button) => {
      button.addEventListener("click", () => {
        preparePayment(button.dataset.payMode).catch(write);
      });
    });
  }
  const entitlementEl = $("#ai-entitlement-status");
  if (entitlementEl) {
    const ent = state.aiEntitlement;
    if (!state.currentCaseId) {
      entitlementEl.innerHTML = `<div class="status-row"><span>Plan</span><strong>Start a case to pay</strong></div>`;
    } else if (!ent?.limits) {
      entitlementEl.innerHTML = `<div class="status-row"><span>Plan</span><strong>Payment required for agent AI</strong></div>`;
    } else {
      entitlementEl.innerHTML = `
        <div class="status-row"><span>Active plan</span><strong>${escapeHtml(ent.mode || "\u2014")}</strong></div>
        <div class="status-row"><span>Agent chats</span><strong>${ent.usage.chats} / ${ent.limits.maxChats}</strong></div>
        <div class="status-row"><span>AI tasks</span><strong>${ent.usage.analyses} / ${ent.limits.maxAnalyses}</strong></div>
      `;
    }
  }
  const payments = state.hackathon?.payments || [];
  $("#payments-table").innerHTML = payments.length ? payments.map((session) => `
        <div class="row">
          <div>
            <strong>${escapeHtml(session.productId)}</strong>
            <div class="muted small">${session.mode} \xB7 ${session.amountUsd} ${session.token} \xB7 ${session.status}</div>
          </div>
          <span class="${pillClass(session.status === "paid" || session.status === "authorized")}">x402</span>
        </div>
      `).join("") : `<div class="empty">No payment session yet. Choose a plan above.</div>`;
}
function renderAgentNetwork() {
  const timeline = state.hackathon?.timeline || [];
  const delegations = state.hackathon?.delegations || [];
  const venice = state.hackathon?.veniceAnalyses || [];
  const items = [
    ...venice.map((analysis) => ({
      actor: "Venice",
      title: analysis.output.title,
      summary: analysis.output.summary
    })),
    ...delegations.map((delegation) => ({
      actor: delegation.toAgent,
      title: `Delegated ${delegation.toAgent}`,
      summary: delegation.scope.join(", ")
    })),
    ...timeline.map((event) => ({
      actor: event.actor,
      title: event.title,
      summary: event.summary
    }))
  ];
  $("#agent-timeline").innerHTML = items.length ? items.slice(-12).reverse().map((item) => `
        <div class="timeline-item">
          <strong>${escapeHtml(item.title)}</strong>
          <div class="muted small">${escapeHtml(item.actor)} \xB7 ${escapeHtml(item.summary)}</div>
        </div>
      `).join("") : `<div class="empty">No agent events yet. Run Venice or delegate sub-agents.</div>`;
}
function renderRelayer() {
  const events = state.hackathon?.relayerEvents || [];
  $("#relayer-table").innerHTML = events.length ? events.map((event) => `
        <div class="row">
          <div>
            <strong>${escapeHtml(event.status)}</strong>
            <div class="muted small">${escapeHtml(event.txHash || "pending tx")} \xB7 ${escapeHtml(event.message)}</div>
          </div>
          <span class="${pillClass(event.status === "confirmed" ? "pass" : "warn")}">1Shot</span>
        </div>
      `).join("") : `<div class="empty">No relayer events yet. Relay a prepared payment session.</div>`;
}
function renderApprovals() {
  const approvals = state.currentStatus?.approvalsNeeded || [];
  $("#approval-table").innerHTML = approvals.length ? approvals.map((approval) => `
        <div class="row">
          <div>
            <strong>${escapeHtml(approval.destination)}</strong>
            <div class="muted small">${approval.actionType} \xB7 disclose ${approval.dataToDisclose.join(", ")}</div>
          </div>
          <button class="secondary" data-approve-id="${approval.id}">Approve</button>
        </div>
      `).join("") : `<div class="empty">No approval waiting. Choose one agent task first.</div>`;
  document.querySelectorAll("[data-approve-id]").forEach((button) => {
    button.addEventListener("click", () => approve(button.dataset.approveId));
  });
}
function renderActions() {
  const actions = [
    ...state.currentStatus?.actionsReady || [],
    ...state.currentStatus?.submittedActions || []
  ];
  $("#action-table").innerHTML = actions.length ? actions.map((action) => `
        <div class="row">
          <div>
            <strong>${escapeHtml(action.destination)}</strong>
            <div class="muted small">${action.actionType} \xB7 ${action.executionStatus}</div>
          </div>
          ${action.executionStatus === "ready" ? `<button data-execute-id="${action.id}">Record</button>` : `<span class="${pillClass(action.executionStatus)}">${action.executionStatus}</span>`}
        </div>
      `).join("") : `<div class="empty">No actions yet. Approved tasks will appear here.</div>`;
  document.querySelectorAll("[data-execute-id]").forEach((button) => {
    button.addEventListener("click", () => executeAction(button.dataset.executeId));
  });
}
function renderTabs() {
  syncRouteTabVisibility();
  document.querySelectorAll(".tab").forEach((button) => {
    if (button.hidden) return;
    const active = button.dataset.tab === state.tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `tab-${state.tab}`);
  });
}
function render() {
  renderTrust();
  renderCases();
  renderShell();
  renderUserGuide();
  renderWalletCommandStrip();
  renderIntakeInferencePreview();
  renderDashboard();
  renderFindings();
  renderPresets();
  renderAgentChat();
  renderHackathonChecklist();
  renderPayments();
  renderAgentNetwork();
  renderRelayer();
  renderApprovals();
  renderActions();
  renderTabs();
  updateAgentSendState();
  bindIcons();
}
function updateAgentSendState() {
  const input = $("#agent-input");
  const send2 = $("#agent-send");
  if (!input || !send2) return;
  const hasText = Boolean(input.value.trim());
  send2.disabled = !hasText;
  send2.classList.toggle("send-ready", hasText);
  send2.setAttribute("aria-disabled", hasText ? "false" : "true");
}
async function request(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? { "content-type": "application/json" } : void 0,
    body: options.body ? JSON.stringify(options.body) : void 0
  });
  const json = await response.json();
  if (!response.ok) throw json;
  return json;
}
async function createCase(options = {}) {
  state.appOpen = true;
  state.dockOpen = true;
  location.hash = "app";
  const parsed = options.parsed ? { ...options.parsed } : parseIntakeForCase(options.intakeText ?? $("#agent-intake")?.value ?? $("#intake")?.value ?? "");
  if (!parsed.intakeText) {
    throw { error: "intake-required", message: "Enter your name to continue." };
  }
  applyParsedIntakeToForm(parsed);
  const created = await request("/api/cases", {
    method: "POST",
    body: {
      jurisdiction: parsed.jurisdiction,
      authorityBasis: parsed.authorityBasis,
      riskLevel: parsed.riskLevel
    }
  });
  const caseId = created.case.id;
  const intakeText = parsed.intakeText;
  if (!state.vaultKey) state.vaultKey = await createVaultKey();
  const encryptedIntake = await encryptPayload(state.vaultKey, { notes: intakeText }, caseId);
  const label = parsed.personLabel;
  const intake = await request(`/api/cases/${caseId}/intake`, {
    method: "POST",
    body: {
      encryptedIntake,
      redactedScope: redactedScopeFromIntake(parsed)
    }
  });
  state.currentCaseId = caseId;
  state.currentStatus = intake.status;
  state.cases.unshift({ ...intake.case, status: intake.status });
  state.agentPlan = null;
  state.connectorResults = [];
  state.intakeText = intakeText;
  const inferredPreset = recommendPreset({
    jurisdiction: intake.case.jurisdiction,
    riskLevel: intake.case.riskLevel,
    intakeText
  });
  state.recommendedPresetId = options.presetId || inferredPreset;
  state.selectedPresetId = options.presetId || inferredPreset;
  state.showRouteTab = false;
  state.tab = "overview";
  state.dockOpen = true;
  addChat("user", parsed.personLabel || intakeText);
  if (options.autoStartRoute) {
    await startPreset({ quiet: true });
    if (options.pastedUrls?.length) {
      if ($("#findings-paste-input")) {
        $("#findings-paste-input").value = options.pastedUrls.join("\n");
      }
      localStorage.setItem(`oblivion.discoveryUrls.${caseId}`, JSON.stringify(options.pastedUrls));
      await maybeAutoDiscoverFindings({ force: true, quiet: true }).catch(() => {
      });
      await syncCurrentCaseStatus();
    }
    state.autopilotBusy = true;
    render();
    await agentAutopilot({ silentUser: true }).catch(() => {
    });
    state.autopilotBusy = false;
    addChat("agent", `Running ${presetTitle(state.selectedPresetId)}. Pauses for your OK.`);
  } else {
    addChat("agent", `Ready \u2014 ${presetTitle(state.selectedPresetId)}. Tap Next.`);
  }
  saveLocalCases();
  render();
  write(intake);
}
function resetPreSearchUi() {
  state.preSearchReady = false;
  const panel = $("#pre-search-panel");
  const list = $("#pre-search-results");
  const preStatus = $("#pre-search-status");
  if (panel) panel.hidden = true;
  if (list) list.innerHTML = "";
  if (preStatus) preStatus.textContent = "";
  const btn = $("#start-cleanup");
  if (btn) setButtonLabel(btn, "Start cleanup");
}
function renderPreSearchPreview(findings, message) {
  const panel = $("#pre-search-panel");
  const list = $("#pre-search-results");
  const preStatus = $("#pre-search-status");
  if (!panel || !list || !preStatus) return;
  panel.hidden = false;
  preStatus.textContent = message;
  const rows = (findings || []).slice(0, 12);
  if (!rows.length) {
    list.innerHTML = `<li class="muted">No links found yet. Paste URLs above or continue \u2014 the agent can search again later.</li>`;
    return;
  }
  list.innerHTML = rows.map((item) => {
    const label = shortenUrl(item.sourceUrl);
    return `<li><a href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>${item.title ? ` \u2014 ${escapeHtml(item.title)}` : ""}</li>`;
  }).join("");
}
async function runPreliminarySearch(parsed) {
  const statusEl = $("#simple-start-status");
  const preStatus = $("#pre-search-status");
  if (statusEl) statusEl.textContent = "Searching for exposure\u2026";
  if (preStatus) preStatus.textContent = "Searching\u2026";
  $("#pre-search-panel")?.removeAttribute("hidden");
  await refreshIntegrationsStatus().catch(() => {
  });
  await startPreset({ quiet: true });
  if (parsed.pastedUrls?.length) {
    if ($("#findings-paste-input")) {
      $("#findings-paste-input").value = parsed.pastedUrls.join("\n");
    }
    localStorage.setItem(`oblivion.discoveryUrls.${state.currentCaseId}`, JSON.stringify(parsed.pastedUrls));
  }
  const discovery = await maybeAutoDiscoverFindings({ force: true, quiet: true });
  await syncCurrentCaseStatus();
  const findings = state.currentStatus?.findings || [];
  const braveReady = Boolean(state.integrationsStatus?.liveReady?.braveSearch);
  let message = "";
  if (discovery.ran && findings.length) {
    message = `Found ${findings.length} link(s) to review. Continue to start cleanup.`;
  } else if (discovery.reason === "urls-needed" && !braveReady) {
    message = "Automated search is not configured \u2014 paste profile URLs above or continue anyway.";
  } else if (discovery.ran) {
    message = "Search complete. No new links yet \u2014 you can continue or paste URLs above.";
  } else {
    message = "Ready to continue. The agent can search again from Overview.";
  }
  renderPreSearchPreview(findings, message);
  state.preSearchReady = true;
  const btn = $("#start-cleanup");
  if (btn) setButtonLabel(btn, "Continue cleanup");
  if (statusEl) statusEl.textContent = "";
  addChat("agent", message);
  render();
}
async function continueAfterPreSearch() {
  const statusEl = $("#simple-start-status");
  if (statusEl) statusEl.textContent = "Starting cleanup\u2026";
  state.preSearchReady = false;
  state.autopilotBusy = true;
  render();
  try {
    await agentAutopilot({ silentUser: true }).catch(() => {
    });
    addChat("agent", `Running ${presetTitle(state.selectedPresetId)}. Pauses for your OK.`);
    resetPreSearchUi();
    if (statusEl) statusEl.textContent = "";
    $("#dashboard-region")?.scrollIntoView({ behavior: "smooth", block: "start" });
  } finally {
    state.autopilotBusy = false;
    render();
  }
}
async function startSimpleCleanup() {
  const btn = $("#start-cleanup");
  const statusEl = $("#simple-start-status");
  if (btn) btn.disabled = true;
  try {
    if (state.preSearchReady && state.currentCaseId) {
      await continueAfterPreSearch();
      return;
    }
    const parsed = readSimpleIntakeForm();
    syncSimpleFormToLegacyFields(parsed);
    selectPresetId(parsed.presetId);
    const previewFirst = Boolean($("#run-preview-search")?.checked);
    if (statusEl) statusEl.textContent = previewFirst ? "Creating case\u2026" : "Starting\u2026";
    await createCase({
      parsed: {
        intakeText: parsed.intakeText,
        jurisdiction: parsed.jurisdiction,
        riskLevel: parsed.riskLevel,
        authorityBasis: parsed.authorityBasis,
        personLabel: parsed.personLabel,
        aliases: parsed.aliases,
        region: parsed.region
      },
      presetId: parsed.presetId,
      pastedUrls: parsed.pastedUrls,
      autoStartRoute: !previewFirst
    });
    if (previewFirst) {
      await runPreliminarySearch(parsed);
      return;
    }
    if (statusEl) statusEl.textContent = "";
    $("#dashboard-region")?.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    const message = error?.message || "Could not start cleanup.";
    if (statusEl) statusEl.textContent = message;
    pulseFocusField($("#simple-name"));
    write(error);
  } finally {
    if (btn) btn.disabled = false;
  }
}
async function startWithAgent() {
  await startSimpleCleanup();
}
async function startPreset(options = {}) {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
  const result = await request(`/api/cases/${state.currentCaseId}/preset`, {
    method: "POST",
    body: {
      presetId: state.selectedPresetId,
      autonomyMode: $("#high-autonomy-toggle").checked ? "high-autonomy" : "approval-gated"
    }
  });
  state.agentPlan = result.plan;
  state.currentStatus = result.status;
  state.tab = "overview";
  await refreshAgentPlan({ silent: true });
  await refreshHackathon({ silent: true }).catch(() => {
  });
  if (!options.quiet) addChat("agent", `${presentPreset(result.preset).title} is staged. I can run the route now.`);
  render();
  write(result);
}
async function requireTrustedRuntime() {
  if (!$("#require-trust").checked) return;
  const proof = state.trustProof || await refreshTrust();
  if (proof.verifierResult !== "pass") {
    throw {
      error: "attestation-required",
      message: "Sensitive action blocked until Trust Center status is pass."
    };
  }
}
async function proposeAction() {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
  await requireTrustedRuntime();
  const result = await request("/api/actions/propose", {
    method: "POST",
    body: {
      caseId: state.currentCaseId,
      actionType: state.actionType,
      destination: $("#destination").value,
      purpose: $("#purpose").value,
      identifiers: ["email"],
      dataToDisclose: ["email"],
      sourceVerified: $("#source-verified").checked
    }
  });
  state.currentStatus = result.status;
  state.tab = "approvals";
  render();
  write(result);
}
async function approve(approvalId) {
  const result = await request(`/api/approvals/${approvalId}/approve`, {
    method: "POST",
    body: { userConfirmation: "I approve this exact action" }
  });
  state.currentStatus = result.status;
  await refreshAgentPlan({ silent: true }).catch(() => {
  });
  await refreshHackathon({ silent: true });
  addChat("agent", "Approved. I can record it without external submission.");
  state.tab = "overview";
  render();
  write(result);
}
async function executeAction(actionId) {
  const result = await request(`/api/actions/${actionId}/execute`, {
    method: "POST",
    body: {}
  });
  state.currentStatus = result.status;
  await refreshAgentPlan({ silent: true }).catch(() => {
  });
  await refreshHackathon({ silent: true });
  addChat("agent", "Recorded. No third-party submission.");
  state.tab = "overview";
  render();
  write(result);
}
async function exportCase() {
  if (!state.currentCaseId) throw { error: "case-required", message: "Select a case." };
  const exported = await request("/api/export", {
    method: "POST",
    body: { caseId: state.currentCaseId }
  });
  const passphrase = $("#export-passphrase").value;
  write({
    format: "oblivion-encrypted-case-v1",
    exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
    wrappedVaultKey: passphrase ? await wrapVaultKey(state.vaultKey, passphrase) : void 0,
    payload: exported
  });
}
function caseDeleteLabel(caseId) {
  return state.cases.find((item) => item.id === caseId)?.redactedScope?.personLabel || "this case";
}
function openDeleteCaseModal(caseId) {
  if (!caseId) return;
  const label = caseDeleteLabel(caseId);
  state.deleteConfirmCaseId = caseId;
  const copy = $("#delete-case-modal-copy");
  if (copy) {
    copy.textContent = `Delete ${label}? Server data will be purged and cannot be recovered.`;
  }
  const dialog = $("#delete-case-modal");
  if (dialog && !dialog.open) {
    dialog.showModal();
    bindIcons(dialog);
  }
}
function closeDeleteCaseModal() {
  state.deleteConfirmCaseId = "";
  $("#delete-case-modal")?.close();
}
async function deleteCaseById(caseId, options = {}) {
  if (!caseId) throw { error: "case-required", message: "Select a case." };
  if (!options.skipConfirm) {
    openDeleteCaseModal(caseId);
    return;
  }
  const deleted = await request("/api/delete", {
    method: "POST",
    body: { caseId }
  });
  state.cases = state.cases.filter((item) => item.id !== caseId);
  if (state.currentCaseId === caseId) {
    state.currentCaseId = "";
    state.currentStatus = null;
    state.vaultKey = null;
    state.agentPlan = null;
    state.connectorResults = [];
    state.tab = "overview";
    localStorage.removeItem("oblivion.currentCaseId");
  }
  saveLocalCases();
  closeDeleteCaseModal();
  render();
  write(deleted);
}
async function confirmDeleteCase() {
  const caseId = state.deleteConfirmCaseId || state.currentCaseId;
  if (!caseId) return;
  await deleteCaseById(caseId, { skipConfirm: true });
}
async function deleteCase() {
  if (!state.currentCaseId) throw { error: "case-required", message: "Select a case." };
  openDeleteCaseModal(state.currentCaseId);
}
async function refreshWalletConfig() {
  try {
    state.walletConfig = await request("/api/integrations/wallet-config");
    walletLog.info(
      state.walletConfig.liveEnabled ? "Payments: Sepolia (WALLET_LIVE_MODE=true)" : "Payments: session mode (set WALLET_LIVE_MODE=true for Sepolia on-chain)",
      { chainId: state.walletConfig.chainId, liveEnabled: state.walletConfig.liveEnabled }
    );
  } catch (error) {
    state.walletConfig = { ...DEFAULT_WALLET_CONFIG };
    walletLog.warn("wallet-config unavailable \u2014 using embedded defaults", {
      status: error?.error,
      hint: "Restart npm run dev if the server is an old build"
    });
  }
}
async function refreshIntegrationsStatus() {
  try {
    state.integrationsStatus = await request("/api/integrations/status");
  } catch {
    state.integrationsStatus = null;
  }
}
async function disconnectWallet() {
  const provider = state.ethereumProvider || pickMetaMaskFromWindow();
  await revokeWalletPermissions(provider);
  state.walletAddress = "";
  state.smartAccountAddress = "";
  state.ethereumProvider = null;
  state.walletMode = "";
  state.walletCallsId = "";
  state.smartAccountTxHash = "";
  state.walletConnectError = "";
  state.walletConnectNote = "";
  state.walletPickAccount = true;
  walletLog.info("disconnectWallet");
  toggleWalletModal(false);
  renderWalletPanels();
  render();
}
async function connectWallet(options = {}) {
  state.walletConnectError = "";
  state.walletConnectNote = "Opening MetaMask\u2026";
  state.dockOpen = true;
  renderWalletPanels();
  walletLog.info("connectWallet start", { hasCase: hasActiveCase() });
  let provider = null;
  const pickAccount = Boolean(state.walletPickAccount);
  state.walletPickAccount = false;
  try {
    provider = await resolveEthereumProvider({ forceFresh: pickAccount });
    state.ethereumProvider = provider;
    if (provider?.request) {
      walletLog.info("eth_requestAccounts", { pickAccount });
      const accounts = await requestWalletAccounts(provider, { pickAccount });
      state.walletAddress = accounts?.[0] || "";
      if (!state.walletAddress) {
        throw new Error("No account returned. Unlock MetaMask and try again.");
      }
      state.walletMode = provider.isMetaMask ? "metamask" : "injected";
      state.walletConnectNote = provider.isMetaMask ? `MetaMask connected ${shortenAddress(state.walletAddress)}` : `Wallet connected ${shortenAddress(state.walletAddress)}`;
      walletLog.info("connected", { address: shortenAddress(state.walletAddress), isMetaMask: provider.isMetaMask });
    } else {
      throw Object.assign(new Error("MetaMask not detected"), {
        code: 4902,
        message: "Install MetaMask (or disable conflicting wallet extensions) and try again."
      });
    }
  } catch (error) {
    const code = error?.code;
    let message = code === 4001 ? "Cancelled in MetaMask." : error?.message || "Wallet connection failed.";
    if (/unexpected error/i.test(message) || error?.message?.includes("selectExtension")) {
      message = "Wallet extension conflict. Disable other wallet extensions (e.g. evmAsk) or pick MetaMask when prompted.";
    }
    state.walletConnectError = message;
    state.walletConnectNote = "";
    walletLog.error("connect failed", { code, message: error?.message });
    render();
    write({ error: "wallet-connect-failed", message, code });
    throw error;
  }
  if (options.openHub) openWalletHub();
  else render();
  $("#wallet-feedback-primary")?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  write({
    walletAddress: state.walletAddress,
    mode: state.walletMode
  });
  return provider;
}
async function createSmartAccount(options = {}) {
  if (!state.currentCaseId) {
    throw { error: "case-required", message: "Start with the agent first \u2014 create a case, then enable Smart Account." };
  }
  if (!state.walletAddress) await connectWallet({ quiet: true });
  const body = {
    caseId: state.currentCaseId,
    walletAddress: state.walletAddress,
    mode: options.mode || (state.walletMode === "live" ? "live" : "demo"),
    txHash: options.txHash || state.smartAccountTxHash || void 0,
    callsId: options.callsId || state.walletCallsId || void 0,
    chainId: options.chainId || state.walletConfig?.chainId
  };
  const result = await request("/api/metamask/demo-session", {
    method: "POST",
    body
  });
  state.smartAccountAddress = result.smartAccountAddress;
  state.walletMode = result.mode || body.mode;
  await refreshHackathon({ silent: true });
  if (!options.quiet) {
    addChat("agent", "Smart Account ready. Checklist updated \u2014 finishing pending developer tracks next.");
  }
  await finishPendingDeveloperActions({ quiet: true });
  if (!options.quiet) {
    const remaining = hackathonPendingTracks();
    addChat(
      "agent",
      remaining.length ? `Still pending: ${remaining.join(", ")}. Open Settings \u2192 Developer details.` : "Developer tracks ready: x402, Venice, A2A, and 1Shot."
    );
  }
  if (options.openHub !== false) openWalletHub();
  else render();
  write(result);
  return result;
}
async function enableSmartAccount(options = {}) {
  if (!state.currentCaseId) {
    throw { error: "case-required", message: "Start a cleanup first, then enable Smart Account." };
  }
  if (!state.walletAddress) {
    await connectWallet({ quiet: true, openHub: false });
  }
  state.walletConnectNote = "Enabling Smart Account\u2026";
  renderWalletPanels();
  const provider = state.ethereumProvider || await resolveEthereumProvider();
  if (state.walletConfig?.liveEnabled && provider?.request) {
    state.walletConnectNote = "Confirm Sepolia Smart Account upgrade in MetaMask\u2026";
    renderWalletPanels();
    const liveResult = await tryLiveSmartAccountUpgrade(provider, state.walletAddress, state.walletConfig);
    if (liveResult.ok) {
      state.walletCallsId = liveResult.callsId || "";
      state.smartAccountTxHash = liveResult.txHash || "";
      await createSmartAccount({
        mode: "live",
        txHash: liveResult.txHash,
        callsId: liveResult.callsId,
        chainId: liveResult.chainId,
        quiet: options.quiet,
        openHub: options.openHub
      });
      if (!options.quiet) {
        addChat(
          "agent",
          liveResult.txHash ? `Smart Account upgrade submitted (${shortenAddress(liveResult.txHash)}).` : "Smart Account upgrade sent \u2014 confirm in MetaMask if still pending."
        );
      }
      return;
    }
    if (liveResult.reason === "user-rejected") {
      state.walletConnectError = "Smart Account upgrade cancelled in MetaMask.";
      render();
      return;
    }
  }
  await createSmartAccount({ quiet: options.quiet, openHub: options.openHub });
  if (!options.quiet) {
    addChat("agent", "Smart Account ready (EIP-7702 + ERC-7715). Open Payments for x402.");
  }
}
async function upgradeMetaMaskLive() {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create a case first." };
  if (!state.walletAddress) await connectWallet({ quiet: true });
  const provider = state.ethereumProvider || await resolveEthereumProvider();
  if (!provider?.request) throw { error: "no-provider", message: "Install MetaMask to use live upgrade." };
  state.walletConnectNote = "Confirm Sepolia upgrade in MetaMask\u2026";
  renderWalletPanels();
  const liveResult = await tryLiveSmartAccountUpgrade(provider, state.walletAddress, state.walletConfig);
  if (!liveResult.ok) {
    state.walletConnectError = liveResult.message || "Live upgrade failed.";
    render();
    write(liveResult);
    return;
  }
  state.walletCallsId = liveResult.callsId || "";
  state.smartAccountTxHash = liveResult.txHash || "";
  await createSmartAccount({
    mode: "live",
    txHash: liveResult.txHash,
    callsId: liveResult.callsId,
    chainId: liveResult.chainId
  });
}
async function preparePayment(mode) {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
  if (!state.smartAccountAddress) await createSmartAccount({ quiet: true, openHub: false });
  const productId = mode === "subscription" ? "weekly-monitor" : "broker-opt-out-packet";
  const result = await request(`/api/x402/${mode === "subscription" ? "subscription" : "one-off"}`, {
    method: "POST",
    body: {
      caseId: state.currentCaseId,
      productId,
      walletAddress: state.walletAddress,
      smartAccountAddress: state.smartAccountAddress
    }
  });
  await refreshHackathon({ silent: true });
  openPaymentRails();
  write(result);
}
async function finishPendingDeveloperActions(options = {}) {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
  await refreshHackathon({ silent: true });
  if (hackathonPendingTracks().length === 0) {
    if (!options.quiet) addChat("agent", "All developer tracks are already ready.");
    return { completed: [], status: state.hackathonStatus };
  }
  if (!state.smartAccountAddress && state.walletAddress) {
    await createSmartAccount({ quiet: true, openHub: false });
  }
  const result = await request("/api/hackathon/complete-pending", {
    method: "POST",
    body: {
      caseId: state.currentCaseId,
      walletAddress: state.walletAddress,
      smartAccountAddress: state.smartAccountAddress,
      notes: $("#purpose")?.value || "Redacted people-search cleanup case.",
      destination: $("#destination")?.value || "approved broker",
      actionType: state.actionType
    }
  });
  await refreshHackathon({ silent: true });
  if (!options.quiet) {
    addChat(
      "agent",
      result.completed?.length ? `Finished ${result.completed.join(", ")}. Check Developer details.` : "No pending developer tracks remained."
    );
  }
  state.tab = options.stayOnTab ? state.tab : "settings";
  render();
  write(result);
  return result;
}
async function runVenice(kind) {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
  const path = kind === "draft-request" ? "/api/ai/draft-request" : kind === "review-approval" ? "/api/ai/review-approval" : "/api/ai/classify-case";
  const result = await request(path, {
    method: "POST",
    body: {
      caseId: state.currentCaseId,
      notes: $("#purpose").value || "Redacted people-search cleanup case.",
      destination: $("#destination").value || "approved broker",
      actionType: state.actionType
    }
  });
  await refreshHackathon({ silent: true });
  state.tab = "settings";
  render();
  write(result);
}
async function delegateAgents() {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
  const result = await request("/api/agents/delegate", {
    method: "POST",
    body: { caseId: state.currentCaseId }
  });
  await refreshHackathon({ silent: true });
  state.tab = "settings";
  render();
  write(result);
}
async function relayDemo() {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
  const latest = [...state.hackathon?.payments || []].at(-1);
  if (!latest) await preparePayment("one-off");
  const session = [...state.hackathon?.payments || []].at(-1);
  const result = await request("/api/1shot/relay-demo", {
    method: "POST",
    body: {
      caseId: state.currentCaseId,
      sessionId: session?.id
    }
  });
  await refreshHackathon({ silent: true });
  state.tab = "settings";
  render();
  write(result);
}
async function askAgent() {
  const text = $("#agent-input").value.trim();
  if (!text) {
    updateAgentSendState();
    return;
  }
  addChat("user", text);
  $("#agent-input").value = "";
  updateAgentSendState();
  const lower = text.toLowerCase();
  if (teeQuestionIntent(lower)) {
    addChat("agent", await buildTeeVerificationBrief());
    state.tab = "trust";
    render();
    return;
  }
  if (!state.currentCaseId) {
    if (!text) {
      addChat("agent", "Describe what to clean up in one sentence \u2014 here or in the intake box.");
      render();
      return;
    }
    const intake = $("#agent-intake");
    if (intake) intake.value = text;
    renderIntakeInferencePreview();
    await startWithAgent();
    return;
  }
  if (lower.includes("run") || lower.includes("do it") || lower.includes("continue")) {
    await agentAutopilot();
    return;
  }
  if (lower.includes("disclosure") || lower.includes("explain")) {
    $("#agent-explain-disclosure").click();
    return;
  }
  if (state.integrationsStatus?.liveReady?.venice) {
    try {
      const result = await request("/api/agent/chat", {
        method: "POST",
        body: { caseId: state.currentCaseId, message: text || "What should I do next?" }
      });
      addChat("agent", result.reply || "No reply.");
      await refreshHackathon({ silent: true });
      render();
      return;
    } catch (error) {
      if (error?.error === "ai-payment-required" || error?.error === "ai-chat-budget-exhausted") {
        addChat(
          "agent",
          error?.error === "ai-chat-budget-exhausted" ? "AI chat budget used up for this plan. Subscribe for more capacity or start a new one-off run." : "Agent AI requires payment \u2014 $1 USDC one-off or $5 USDC/month. Open Payment rails in Settings."
        );
        openPaymentRails();
        render();
        return;
      }
      addChat("agent", error?.message || "Venice request failed.");
      render();
      return;
    }
  }
  await refreshHackathon({ silent: true });
  const next = state.agentNext;
  addChat("agent", next ? `${shortStepTitle(next.title)}. ${next.message || ""}`.trim() : "Set VENICE_API_KEY on the server for live agent replies.");
  render();
}
async function agentRunNext(options = {}) {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
  await refreshHackathon({ silent: true });
  if (state.agentNext?.action === "select-preset") {
    await startPreset({ quiet: true });
    await refreshHackathon({ silent: true });
  }
  if (state.agentNext?.action === "request-approval" && state.currentStatus?.approvalsNeeded?.length > 0) {
    addChat("agent", "Approval required. Review the card.");
    state.tab = "overview";
    render();
    return;
  }
  if (peopleSearchPresetActive() && needsExposureDiscovery()) {
    const discovery = await maybeAutoDiscoverFindings({ quiet: true });
    await refreshHackathon({ silent: true });
    await syncCurrentCaseStatus();
    if (discovery.reason === "urls-needed") {
      if (!options.quiet) {
        openFindingsPastePanel();
        addChat("agent", "Paste profile URLs under Exposure links, then run the next step again.");
      }
      state.tab = "overview";
      render();
      return;
    }
  }
  const pendingFindings = state.currentStatus?.pendingFindings?.length ?? 0;
  if (pendingFindings > 0 || state.agentNext?.action === "confirm-matches" || state.agentNext?.blockedReasons?.includes("candidate-confirmation-needed")) {
    if (!options.quiet) {
      addChat("agent", "Review Exposure links \u2014 confirm yours or mark Not me.");
      openFindingsPastePanel();
    }
    state.tab = "overview";
    render();
    return;
  }
  const blocked = state.agentNext?.blockedReasons || [];
  if (blocked.includes("discovery-needed")) {
    if (!options.quiet) {
      openFindingsPastePanel();
      addChat("agent", state.agentNext?.message || "Paste profile URLs to discover listings.");
    }
    state.tab = "overview";
    render();
    return;
  }
  if (blocked.length) {
    if (!options.quiet) addChat("agent", state.agentNext.message || "Paused for review.");
    state.tab = "overview";
    render();
    return;
  }
  if (state.agentNext?.action === "complete") {
    addChat("agent", "Cleanup cycle complete. Open the Trust tab for proof details.");
    render();
    return;
  }
  const result = await request(`/api/cases/${state.currentCaseId}/agent/run`, {
    method: "POST",
    body: {
      highAutonomy: $("#high-autonomy-toggle").checked
    }
  });
  if (result.caseStatus) state.currentStatus = result.caseStatus;
  if (result.plan) state.agentPlan = result.plan;
  if (result.connectorResults) state.connectorResults = result.connectorResults;
  await refreshAgentPlan({ silent: true }).catch(() => {
  });
  await refreshHackathon({ silent: true });
  await syncCurrentCaseStatus();
  if (!options.quiet) addChat("agent", `${shortStepTitle(result.ran.title)}. Next: ${shortStepTitle(result.next.title)}.`);
  render();
  write(result);
}
async function agentAutopilot(options = {}) {
  if (!state.currentCaseId) throw { error: "case-required", message: "Create or select a case." };
  if (!options.silentUser) addChat("user", "Run route.");
  for (let index = 0; index < 12; index += 1) {
    await refreshHackathon({ silent: true });
    const pending = state.currentStatus?.pendingFindings?.length ?? 0;
    const blocked = state.agentNext?.blockedReasons || [];
    if (state.agentNext?.action === "complete" || state.agentNext?.action === "request-approval" && state.currentStatus?.approvalsNeeded?.length > 0 || pending > 0 || state.agentNext?.action === "confirm-matches" || blocked.includes("candidate-confirmation-needed") || blocked.length > 0 && !blocked.includes("discovery-needed")) {
      break;
    }
    await agentRunNext({ quiet: true });
  }
  await refreshHackathon({ silent: true });
  await refreshAgentPlan({ silent: true }).catch(() => {
  });
  await syncCurrentCaseStatus();
  addChat("agent", state.agentNext?.action === "request-approval" ? "Approval required." : state.agentNext?.action === "complete" ? "Complete. No external submission." : state.agentNext?.blockedReasons?.length ? state.agentNext.message || "Paused for review." : "Paused for review.");
  state.tab = "overview";
  render();
}
$("#start-cleanup")?.addEventListener("click", () => startSimpleCleanup().catch(write));
$("#simple-name")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    startSimpleCleanup().catch(write);
  }
});
document.querySelectorAll(".preset-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    selectPresetId(chip.dataset.presetId || "people-search-cleanup");
    render();
  });
});
document.addEventListener("click", (event) => {
  const starter = event.target.closest("[data-agent-preset]");
  if (!starter) return;
  event.preventDefault();
  applyAgentIntakeTemplate(starter.dataset.agentPreset);
});
$("#show-advanced-ui")?.addEventListener("change", (event) => {
  state.showAdvancedUI = event.target.checked;
  applyAdvancedUiVisibility();
  render();
});
$("#agent-intake")?.addEventListener("input", () => renderIntakeInferencePreview());
$("#agent-intake")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    startSimpleCleanup().catch(write);
  }
});
function openApp() {
  state.appOpen = true;
  state.dockOpen = true;
  state.dockPinned = true;
  location.hash = "app";
  if (state.currentCaseId) {
    loadCase(state.currentCaseId, { silent: true, openApp: false }).catch(write);
    return;
  }
  render();
  focusIntake();
}
function backToLanding() {
  state.appOpen = false;
  state.dockOpen = false;
  location.hash = "";
  render();
  $("#landing-region")?.scrollIntoView({ behavior: "smooth", block: "start" });
}
$("#agent-do-next")?.addEventListener("click", () => performGuidePrimaryAction().catch(write));
$("#open-app-hero").addEventListener("click", openApp);
$("#toolbar-home")?.addEventListener("click", backToLanding);
function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  localStorage.setItem("oblivion.sidebarOpen", state.sidebarOpen ? "1" : "0");
  render();
}
$("#sidebar-home")?.addEventListener("click", backToLanding);
$("#sidebar-new-case")?.addEventListener("click", () => openNewCaseFlow());
$("#sidebar-collapse")?.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleSidebar();
});
window.addEventListener("hashchange", () => {
  syncAppRoute();
  if (state.appOpen && state.currentCaseId && !state.currentStatus) {
    loadCase(state.currentCaseId, { silent: true, openApp: false }).catch(() => render());
  } else {
    render();
  }
});
$("#jump-how-it-works").addEventListener("click", () => {
  $("#install-skill")?.scrollIntoView({ behavior: "smooth", block: "start" });
});
$("#refresh-dashboard")?.addEventListener("click", () => refreshTrust().then(refreshCases).catch(write));
$("#change-route")?.addEventListener("click", () => revealRouteTab());
$("#continue-flow").addEventListener("click", () => revealRouteTab());
$("#local-safe-mode").addEventListener("click", () => {
  $("#require-trust").checked = false;
  revealRouteTab();
});
$("#new-case").addEventListener("click", () => openNewCaseFlow());
$("#case-manager-new")?.addEventListener("click", () => openNewCaseFlow());
$("#toolbar-cases-toggle")?.addEventListener("click", () => toggleCasesPanel());
$("#case-manager-close")?.addEventListener("click", () => toggleCasesPanel(false));
$("#start-preset").addEventListener("click", () => startPreset().catch(write));
$("#propose-action").addEventListener("click", () => proposeAction().catch(write));
$("#wallet-modal-close")?.addEventListener("click", () => toggleWalletModal(false));
$("#wallet-modal-disconnect")?.addEventListener("click", () => disconnectWallet().catch(write));
$("#wallet-modal-settings")?.addEventListener("click", () => {
  toggleWalletModal(false);
  openWalletHub();
});
$("#wallet-modal-smart-account")?.addEventListener("click", () => {
  enableSmartAccount({ quiet: false, openHub: false }).then(() => renderWalletModal()).catch(write);
});
$("#wallet-modal")?.addEventListener("close", () => {
  state.walletModalOpen = false;
});
document.addEventListener("click", (event) => {
  const modalWalletBtn = event.target.closest("[data-wallet-modal]");
  if (modalWalletBtn) {
    event.preventDefault();
    event.stopPropagation();
    toggleWalletModal(true);
    return;
  }
  const walletBtn = event.target.closest("[data-connect-wallet]");
  if (walletBtn) {
    event.preventDefault();
    event.stopPropagation();
    walletLog.info("connect button clicked", { id: walletBtn.id || "delegated" });
    connectWallet({ openHub: walletBtn.id === "connect-wallet" && hasActiveCase() }).catch(write);
  }
});
$("#upgrade-metamask-live")?.addEventListener("click", () => upgradeMetaMaskLive().catch(write));
$("#create-smart-account")?.addEventListener("click", () => createSmartAccount().catch(write));
$("#finish-pending-tracks")?.addEventListener("click", () => finishPendingDeveloperActions().catch(write));
$("#classify-case").addEventListener("click", () => runVenice("classify-case").catch(write));
$("#draft-request").addEventListener("click", () => runVenice("draft-request").catch(write));
$("#review-approval").addEventListener("click", () => runVenice("review-approval").catch(write));
$("#delegate-agents").addEventListener("click", () => delegateAgents().catch(write));
$("#relay-demo").addEventListener("click", () => relayDemo().catch(write));
$("#agent-send").addEventListener("click", () => askAgent().catch(write));
$("#agent-input").addEventListener("input", updateAgentSendState);
$("#agent-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") askAgent().catch(write);
});
$("#agent-start-recommended").addEventListener("click", () => startPreset().catch(write));
$("#agent-run-next").addEventListener("click", () => agentAutopilot().catch(write));
$("#agent-review-approval").addEventListener("click", () => {
  state.tab = "approvals";
  state.dockOpen = false;
  render();
});
$("#agent-explain-disclosure").addEventListener("click", () => {
  const approval = state.currentStatus?.approvalsNeeded?.[0];
  addChat("agent", approval ? `This would disclose ${approval.dataToDisclose.join(", ")} to ${approval.destination}. I will not submit it without approval.` : "No disclosure is pending. I will stop before any external identifier is sent.");
  render();
});
function openAgentDock() {
  state.dockPinned = true;
  state.dockOpen = true;
  $("#app-agent-column")?.classList.add("open");
  $("#agent-dock")?.classList.add("open");
  render();
}
function toggleDockPinned() {
  state.dockPinned = !state.dockPinned;
  if (state.dockPinned) {
    state.dockOpen = true;
    $("#app-agent-column")?.classList.add("open");
    $("#agent-dock")?.classList.add("open");
  } else {
    $("#app-agent-column")?.classList.remove("open");
    $("#agent-dock")?.classList.remove("open");
  }
  render();
}
$("#agent-dock-collapse")?.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleDockPinned();
});
$("#agent-dock")?.querySelector(".agent-dock-head")?.addEventListener("click", (event) => {
  if (state.dockPinned) return;
  if (event.target.closest("button")) return;
  openAgentDock();
});
$("#export").addEventListener("click", () => exportCase().catch(write));
$("#delete").addEventListener("click", () => deleteCase().catch(write));
$("#delete-case-modal-close")?.addEventListener("click", closeDeleteCaseModal);
$("#delete-case-modal-cancel")?.addEventListener("click", closeDeleteCaseModal);
$("#delete-case-modal-confirm")?.addEventListener("click", () => confirmDeleteCase().catch(write));
$("#delete-case-modal")?.addEventListener("close", () => {
  state.deleteConfirmCaseId = "";
});
$("#delete-case-modal")?.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDeleteCaseModal();
});
document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    state.tab = button.dataset.tab;
    render();
  });
});
document.querySelectorAll("[data-action-choice]").forEach((button) => {
  button.addEventListener("click", () => {
    state.actionType = button.dataset.actionChoice;
    document.querySelectorAll("[data-action-choice]").forEach((choice) => choice.classList.remove("active"));
    button.classList.add("active");
  });
});
function setupDelegates() {
  const presetGrid = $("#preset-grid");
  if (presetGrid) {
    presetGrid.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-preset-id]");
      if (btn && !btn.disabled) {
        state.selectedPresetId = btn.dataset.presetId;
        if (state.selectedPresetId !== state.recommendedPresetId) state.showRouteTab = true;
        renderPresets();
        renderAgentChat();
        render();
      }
    });
    presetGrid.setAttribute("data-testid", "preset-grid");
  }
  const actionCards = $("#agent-action-cards");
  if (actionCards) {
    actionCards.addEventListener("click", (e) => {
      const approveBtn = e.target.closest("[data-chat-approve-id]");
      if (approveBtn) {
        approve(approveBtn.dataset.chatApproveId).catch(write);
        return;
      }
      const execBtn = e.target.closest("[data-chat-execute-id]");
      if (execBtn) {
        executeAction(execBtn.dataset.chatExecuteId).catch(write);
      }
    });
  }
  const approvalTable = $("#approval-table");
  if (approvalTable) {
    approvalTable.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-approve-id]");
      if (btn) approve(btn.dataset.approveId);
    });
    approvalTable.setAttribute("data-testid", "approval-table");
  }
  const actionTable = $("#action-table");
  if (actionTable) {
    actionTable.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-execute-id]");
      if (btn) executeAction(btn.dataset.executeId);
    });
  }
  const caseList = $("#case-list");
  if (caseList) {
    caseList.addEventListener("click", (e) => {
      const deleteBtn = e.target.closest("[data-delete-case]");
      if (deleteBtn) {
        e.preventDefault();
        deleteCaseById(deleteBtn.dataset.deleteCase).catch(write);
        return;
      }
      const btn = e.target.closest("[data-case-id]");
      if (btn) {
        state.casesPanelOpen = false;
        loadCase(btn.dataset.caseId);
      }
    });
  }
  const findingsList = $("#findings-list");
  if (findingsList) {
    findingsList.addEventListener("click", (e) => {
      const confirmBtn = e.target.closest("[data-finding-confirm]");
      if (confirmBtn) {
        decideFinding(confirmBtn.dataset.findingConfirm, "confirm").catch(write);
        return;
      }
      const rejectBtn = e.target.closest("[data-finding-reject]");
      if (rejectBtn) decideFinding(rejectBtn.dataset.findingReject, "reject").catch(write);
    });
  }
  document.addEventListener("click", (e) => {
    if (e.target.closest("#findings-discover")) {
      e.preventDefault();
      discoverFindings().catch(write);
    }
  });
  document.addEventListener("click", (e) => {
    const copyBtn = e.target.closest("[data-copy-target]");
    if (!copyBtn) return;
    e.preventDefault();
    copySkillInstallCommand(copyBtn.dataset.copyTarget, copyBtn).catch(write);
  });
}
setupDelegates();
setupLandingSkillInstall();
syncAppRoute();
await refreshPresets().catch(write);
await refreshTrust().catch(write);
await refreshWalletConfig().catch(write);
await refreshIntegrationsStatus().catch(write);
await refreshCases().catch(write);
render();
/*! Bundled license information:

iconify-icon/dist/iconify-icon.mjs:
  (**
  * (c) Iconify
  *
  * For the full copyright and license information, please view the license.txt
  * files at https://github.com/iconify/iconify
  *
  * Licensed under MIT.
  *
  * @license MIT
  * @version 3.0.2
  *)
*/
