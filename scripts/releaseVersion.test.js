const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const expectedVersion = "2.0.0";

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

const packageJson = JSON.parse(read("package.json"));
assert.equal(packageJson.version, expectedVersion);

const changelog = read("CHANGELOG.md");
const changelogZh = read("CHANGELOG.zh.md");

assert.match(changelog, new RegExp(`## v${expectedVersion} \\(2026-06-15\\)`));
assert.match(changelogZh, new RegExp(`## v${expectedVersion} \\(2026-06-15\\)`));

for (const text of [changelog, changelogZh]) {
  assert.ok(text.indexOf(`## v${expectedVersion}`) < text.indexOf("## v1.2.0"));
}
