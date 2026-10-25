const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const apiUrl = "https://easy-energy-plugin-api.kmd.dk/api/consumption";
const extensionPath = path.join(__dirname, "../ha-novafos-token");

function tokenWith(payload) {
  return "eyJhbGciOiJSUzI1NiJ9." + Buffer.from(JSON.stringify(payload)).toString("base64url") + ".signature";
}

function validToken() {
  return tokenWith({ exp: Math.floor(Date.now() / 1000) + 3600 });
}

function createHarness(initialStorage = {}, fetchImpl = async () => ({ ok: true, status: 200 })) {
  const storage = { ...initialStorage };
  const listeners = {};
  const logs = [];
  const requests = [];
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, {
          style: {}, innerText: "", textContent: "", disabled: false,
          addEventListener(event, callback) { this[event] = callback; }
        });
      }
      return elements.get(id);
    }
  };
  const event = (name) => ({
    addListener(callback, filter) { listeners[name] = { callback, filter }; }
  });
  const chrome = {
    action: { setBadgeText(value) { listeners.badge = value.text; }, setBadgeBackgroundColor() {} },
    webNavigation: { onCommitted: event("navigation") },
    tabs: { onRemoved: event("tabRemoved") },
    webRequest: { onBeforeSendHeaders: event("request"), onHeadersReceived: event("response") },
    storage: {
      local: {
        async set(values) { Object.assign(storage, values); },
        get(keys, callback) { callback(Object.fromEntries(keys.map(key => [key, storage[key]]))); },
        remove(keys, callback) { keys.forEach(key => delete storage[key]); callback(); }
      }
    },
    runtime: {
      onMessage: event("message"),
      sendMessage(request, callback) { listeners.message.callback(request, {}, callback); }
    }
  };
  const globals = {
    chrome, document, URL, atob, Headers,
    console: { log: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    fetch: (...args) => { requests.push(args); return fetchImpl(...args); }
  };
  function load(file) {
    vm.runInNewContext(readFileSync(path.join(extensionPath, file), "utf8"), globals, { filename: file });
  }
  load("background.js");
  return {
    storage, listeners, logs, requests, document, load,
    capture(kind, token, url = apiUrl, name = "authorization", scheme = "Bearer", tabId = 7) {
      return listeners[kind].callback({
        tabId, url,
        [kind === "request" ? "requestHeaders" : "responseHeaders"]: [{ name, value: `${scheme} ${token}` }]
      });
    },
    getToken() { return new Promise(resolve => chrome.runtime.sendMessage({ message: "getToken" }, resolve)); }
  };
}

for (const kind of ["request", "response"]) {
  test(`${kind}: captures case-insensitive authorization headers and bearer schemes`, async () => {
    const harness = createHarness();
    const token = validToken();
    for (const name of ["Authorization", "authorization", "AUTHORIZATION"]) {
      await harness.capture(kind, token, apiUrl, name, "bEaReR");
      assert.equal(harness.storage.token, token);
    }
    assert.deepEqual(Array.from(harness.listeners[kind].filter.urls), ["https://easy-energy-plugin-api.kmd.dk/api/*"]);
    assert.equal(harness.listeners.badge, "Ok");
    assert.equal(JSON.stringify(harness.logs).includes(token), false);
  });

  test(`${kind}: unrelated origins and paths cannot overwrite the Novafos token`, async () => {
    const token = validToken();
    const harness = createHarness({ token, url: apiUrl });
    for (const url of [
      "https://unrelated.example/api/test",
      "https://easy-energy-plugin-api.kmd.dk.evil.example/api/test",
      "http://easy-energy-plugin-api.kmd.dk/api/test",
      "https://easy-energy-plugin-api.kmd.dk:8443/api/test",
      "https://easy-energy-plugin-api.kmd.dk/other/test"
    ]) {
      await harness.capture(kind, validToken(), url);
      assert.equal(harness.storage.url, apiUrl);
      assert.equal(harness.storage.token, token);
    }
    await harness.capture(kind, validToken(), apiUrl, "Authorization", "Bearer", -1);
    assert.equal(harness.storage.token, token);
  });

  test(`${kind}: rejects expired, malformed, or unverifiable expiry`, async () => {
    for (const token of [
      tokenWith({ exp: Math.floor(Date.now() / 1000) - 1 }),
      tokenWith({ exp: 0 }), tokenWith({}), tokenWith({ exp: "9999999999" }),
      "opaque-token", "header.invalid.signature", tokenWith({ exp: 1e308 })
    ]) {
      const harness = createHarness();
      await harness.capture(kind, token);
      assert.equal(harness.storage.token, undefined);
    }
  });
}

test("retrieval purges expired or foreign credentials already in storage", async () => {
  for (const data of [
    { token: tokenWith({ exp: Math.floor(Date.now() / 1000) - 1 }), url: apiUrl },
    { token: validToken(), url: "https://unrelated.example/api/test" },
    { token: "malformed", url: apiUrl }
  ]) {
    const harness = createHarness(data);
    const result = await harness.getToken();
    assert.equal(result.token, undefined);
    assert.equal(harness.storage.token, undefined);
    assert.equal(harness.storage.url, undefined);
    assert.equal(harness.listeners.badge, "");
  }
});

test("retrieval rechecks expiry rather than trusting a cached expiry value", async () => {
  const harness = createHarness();
  await harness.capture("request", validToken());
  assert.ok((await harness.getToken()).expiresAt > Date.now());
  harness.storage.token = tokenWith({ exp: Math.floor(Date.now() / 1000) - 1 });
  assert.equal((await harness.getToken()).token, undefined);
});

function popupHarness(fetchImpl, overrides = {}) {
  const harness = createHarness({
    token: validToken(), url: apiUrl, ha_url: "https://ha.example", ha_token: "ha-secret",
    ha_url_dev: "https://dev-ha.example", ha_token_dev: "dev-secret", ...overrides
  }, fetchImpl);
  harness.load("popup.js");
  return harness;
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test("popup reports success only after a successful HTTP response", async () => {
  let complete;
  const harness = popupHarness(() => new Promise(resolve => { complete = resolve; }));
  const button = harness.document.getElementById("ha-button");
  const notification = harness.document.getElementById("notification-container");
  button.click();
  assert.equal(button.disabled, true);
  assert.equal(notification.textContent, "Sending token to Home Assistant...");
  complete({ ok: true, status: 204 });
  await flush();
  assert.equal(notification.textContent, "Token sent to Home Assistant.");
  assert.equal(button.disabled, false);
  const [url, request] = harness.requests[0];
  assert.equal(url, "https://ha.example/api/services/novafos/update_token");
  assert.equal(request.headers.get("Authorization"), "Bearer ha-secret");
  assert.equal(JSON.parse(request.body).access_token, harness.storage.token);
  assert.equal(JSON.stringify(harness.logs).includes("ha-secret"), false);
  assert.equal(JSON.stringify(harness.logs).includes(harness.storage.token), false);
  assert.equal(harness.document.getElementById("output-token").value, harness.storage.token);
});

for (const status of [401, 403, 500]) {
  test(`popup reports HTTP ${status} as failure`, async () => {
    const harness = popupHarness(async () => ({ ok: false, status }));
    harness.document.getElementById("ha-button").click();
    await flush();
    const notification = harness.document.getElementById("notification-container");
    assert.match(notification.textContent, new RegExp(`HTTP ${status}`));
    assert.equal(notification.className, "uk-text-warning");
    assert.equal(harness.document.getElementById("ha-button").disabled, false);
  });
}

test("popup reports network failure", async () => {
  const harness = popupHarness(async () => { throw new Error("Network unavailable"); });
  harness.document.getElementById("ha-button").click();
  await flush();
  assert.match(harness.document.getElementById("notification-container").textContent, /Network unavailable/);
  assert.equal(harness.document.getElementById("ha-button").disabled, false);
});

test("popup refuses tokens that expire after the popup opens", async () => {
  const harness = popupHarness();
  harness.storage.token = tokenWith({ exp: Math.floor(Date.now() / 1000) - 1 });
  harness.document.getElementById("ha-button").click();
  await flush();
  assert.equal(harness.requests.length, 0);
  assert.match(harness.document.getElementById("notification-container").textContent, /No valid Novafos token/);
  assert.equal(harness.document.getElementById("output-token").value, "No valid Bearer token found.");
  assert.equal(harness.document.getElementById("token-url").innerText, "");
});

test("popup displays the optional Bearer prefix in the copyable field", () => {
  const harness = popupHarness(undefined, { include_bearer_toggle: true });
  assert.equal(harness.document.getElementById("output-token").value, "Bearer " + harness.storage.token);
});

test("popup uses developer configuration when selected", async () => {
  const harness = popupHarness(undefined, { debug_mode_toggle: true });
  harness.document.getElementById("ha-button").click();
  await flush();
  assert.equal(harness.requests[0][0], "https://dev-ha.example/api/services/novafos/update_token");
  assert.equal(harness.requests[0][1].headers.get("Authorization"), "Bearer dev-secret");
});

test("option changes persist HA credentials without logging them", () => {
  const harness = createHarness();
  for (const [form, fields] of [
    ["optionsForm", ["setup_toggle"]],
    ["setupForm", ["ha_url", "ha_token", "debug_mode_toggle"]],
    ["developerForm", ["ha_url_dev", "ha_token_dev", "include_bearer_toggle"]]
  ]) {
    for (const field of fields) {
      harness.document.getElementById(form)[field] = harness.document.getElementById(field);
    }
  }
  harness.load("options.js");
  for (const field of ["ha_token", "ha_token_dev"]) {
    const secret = `${field}-secret-value`;
    harness.document.getElementById(field).change({ target: { value: secret } });
    assert.equal(harness.storage[field], secret);
    assert.equal(JSON.stringify(harness.logs).includes(secret), false);
  }
});