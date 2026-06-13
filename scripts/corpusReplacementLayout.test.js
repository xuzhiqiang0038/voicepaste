const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "renderer/settings.html"), "utf8");
const css = fs.readFileSync(path.join(root, "renderer/settings.css"), "utf8");
const js = fs.readFileSync(path.join(root, "renderer/settings.js"), "utf8");
const populateForm = js.slice(
  js.indexOf("function populateForm"),
  js.indexOf("function collectConfig"),
);
const switchSection = js.slice(
  js.indexOf("function switchSection"),
  js.indexOf("// ===== Home Module ====="),
);

assert.match(
  html,
  /id="corpusFilterCard"/,
  "the shared corpus filters need a stable element for tab-specific visibility",
);

assert.match(
  js,
  /classList\.toggle\("hidden", currentCorpusTab === "replacements"\)/,
  "the replacements tab must hide date, mode, and search filters",
);

assert.match(
  css,
  /\.corpus-filter-card\.hidden\s*\{\s*display:\s*none;/s,
  "the hidden state must actually remove the corpus filters from layout",
);

assert.doesNotMatch(
  populateForm,
  /autoResizeReplacementWords\(\)/,
  "loading settings while the replacements panel is hidden must not measure its textarea",
);

assert.match(
  switchSection,
  /currentCorpusTab === "replacements"[\s\S]*requestAnimationFrame\(autoResizeReplacementWords\)/,
  "returning to the corpus section must resize a visible replacement editor",
);

assert.match(
  css,
  /\.replacement-words-editor\s*\{[^}]*min-height:\s*calc\(/s,
  "the replacement editor needs a stable viewport-based minimum height",
);

assert.match(
  css,
  /\.replacement-words-editor\s*\{[^}]*overflow-y:\s*hidden/s,
  "replacement entries should extend the page and use the global scrollbar",
);
