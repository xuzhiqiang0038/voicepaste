const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const expectedRepoUrl = "https://github.com/xuzhiqiang0038/voicepaste";
const forbidden = ["github.com/that-yolanda/voicepaste", "ko-fi.com/thatyolanda", "com.yolanda.voicepaste"];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

const packageJson = JSON.parse(read("package.json"));
assert.equal(packageJson.repository.url, `${expectedRepoUrl}.git`);
assert.equal(packageJson.homepage, `${expectedRepoUrl}#readme`);
assert.equal(packageJson.bugs.url, `${expectedRepoUrl}/issues`);
assert.equal(packageJson.build.publish.owner, "xuzhiqiang0038");
assert.equal(packageJson.build.publish.repo, "voicepaste");
assert.equal(packageJson.build.appId, "com.xuzhiqiang0038.voicepaste");

const filesToScan = [
  "package.json",
  "README.md",
  "README.zh.md",
  "renderer/settings.html",
  ".claude/skills/github-release/SKILL.md",
  ".claude/skills/github-release/scripts/render-release-notes.sh",
];

for (const file of filesToScan) {
  const text = read(file);
  for (const value of forbidden) {
    assert.equal(text.includes(value), false, `${file} still contains ${value}`);
  }
}

const settingsHtml = read("renderer/settings.html");
const repoLinkCount = settingsHtml.split(expectedRepoUrl).length - 1;
assert.ok(repoLinkCount >= 2, "settings page should link to the maintained repo from support nav and About");

const releaseNotesScript = read(".claude/skills/github-release/scripts/render-release-notes.sh");
assert.ok(
  releaseNotesScript.includes("https://github.com/xuzhiqiang0038/voicepaste/compare/"),
  "release notes compare URL should point to the maintained repo",
);
