const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { unzipSync } = require("fflate");
const { build } = require("../scripts/build.cjs");

for (const browser of ["chrome", "firefox"]) {
  test(`${browser}: builds the correct manifest and complete archive`, (context) => {
    const destination = fs.mkdtempSync(path.join(os.tmpdir(), "novafos-build-"));
    context.after(() => fs.rmSync(destination, { recursive: true, force: true }));
    const source = path.join(__dirname, "../ha-novafos-token");
    const originalManifest = fs.readFileSync(path.join(source, "manifest.json"), "utf8");
    const result = build(browser, source, destination);
    const entries = unzipSync(fs.readFileSync(result.archive));
    const manifest = JSON.parse(Buffer.from(entries["manifest.json"]).toString("utf8"));
    const original = JSON.parse(originalManifest);

    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.version, original.version);
    assert.deepEqual(manifest.permissions, original.permissions);
    assert.deepEqual(manifest.host_permissions, original.host_permissions);
    assert.equal(manifest.action.default_width, undefined);
    assert.equal(manifest.action.default_height, undefined);
    if (browser === "chrome") {
      assert.deepEqual(manifest.background, { service_worker: "background.js" });
      assert.equal(manifest.browser_specific_settings, undefined);
      assert.ok(result.archive.endsWith(".zip"));
    } else {
      assert.deepEqual(manifest.background, { scripts: ["background.js"] });
      assert.deepEqual(manifest.browser_specific_settings, original.browser_specific_settings);
      assert.ok(result.archive.endsWith(".unsigned.xpi"));
    }
    for (const asset of [
      "background.js", "options.js", "popup.js", "popup.html", "scripts/uikit.min.js",
      "scripts/uikit-icons.min.js", ...Object.values(manifest.action.default_icon)
    ]) {
      assert.ok(entries[asset], `Missing ${asset}`);
      assert.deepEqual(Buffer.from(entries[asset]), fs.readFileSync(path.join(result.directory, asset)));
    }
    assert.equal(entries[".amo-upload-uuid"], undefined);
    assert.equal(entries["tests/token-flow.test.cjs"], undefined);
    const popup = Buffer.from(entries["popup.html"]).toString("utf8");
    for (const [, script] of popup.matchAll(/<script src="([^"]+)"/g)) {
      assert.ok(entries[script], `Missing popup script ${script}`);
    }
    assert.equal(fs.readFileSync(path.join(source, "manifest.json"), "utf8"), originalManifest);
  });
}

test("build rejects unsupported browser targets", () => {
  assert.throws(() => build("unknown"), /Unknown browser/);
});