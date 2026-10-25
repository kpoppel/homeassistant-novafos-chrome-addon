const fs = require("node:fs");
const path = require("node:path");
const { zipSync } = require("fflate");

const root = path.join(__dirname, "..");
const assets = ["background.js", "options.js", "popup.js", "popup.html", "images", "scripts"];

function build(browser, source = path.join(root, "ha-novafos-token"), destination = path.join(root, "dist")) {
  if (!["chrome", "firefox"].includes(browser)) {
    throw new Error("Unknown browser: " + browser);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
  if (browser === "chrome") {
    manifest.background = { service_worker: "background.js" };
    delete manifest.browser_specific_settings;
  } else {
    manifest.background = { scripts: ["background.js"] };
  }
  delete manifest.action.default_width;
  delete manifest.action.default_height;

  const entries = { "manifest.json": Buffer.from(JSON.stringify(manifest, null, 2) + "\n") };
  function addAsset(relativePath) {
    const fullPath = path.join(source, relativePath);
    if (fs.statSync(fullPath).isDirectory()) {
      for (const entry of fs.readdirSync(fullPath).sort()) {
        if (!entry.startsWith(".")) {
          addAsset(relativePath + "/" + entry);
        }
      }
    } else {
      entries[relativePath] = fs.readFileSync(fullPath);
    }
  }
  assets.forEach(addAsset);

  const directory = path.join(destination, browser);
  for (const [relativePath, content] of Object.entries(entries)) {
    const fullPath = path.join(directory, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  const extension = browser === "firefox" ? "unsigned.xpi" : "zip";
  const archive = path.join(destination, `ha-novafos-token-${browser}-${manifest.version}.${extension}`);
  fs.writeFileSync(archive, zipSync(entries));
  return { directory, archive };
}

if (require.main === module) {
  const browsers = process.argv[2] ? [process.argv[2]] : ["chrome", "firefox"];
  for (const browser of browsers) {
    const result = build(browser);
    console.log(`${browser}: ${result.directory}\nArchive: ${result.archive}`);
  }
}

module.exports = { build };