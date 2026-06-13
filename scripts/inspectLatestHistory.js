const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REQUIRED_FIELDS = [
  "id",
  "ts",
  "text",
  "rawText",
  "finalText",
  "mode",
  "promptId",
  "llmProvider",
  "llmModel",
  "chars",
  "durationMs",
];
const COUNTABLE_CHARACTER_PATTERN = /[\p{L}\p{N}]/u;

function resolveVoicePasteDataDir() {
  if (process.env.VOICEPASTE_USER_DATA_DIR) {
    return process.env.VOICEPASTE_USER_DATA_DIR;
  }

  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "voicepaste");
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "voicepaste");
  }

  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "voicepaste");
}

function readLatestHistoryEntry(historyDir) {
  if (!fs.existsSync(historyDir)) {
    return null;
  }

  const files = fs
    .readdirSync(historyDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort()
    .reverse();

  for (const fileName of files) {
    const filePath = path.join(historyDir, fileName);
    const lines = fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return {
          filePath,
          lineNumber: index + 1,
          entry: JSON.parse(lines[index]),
        };
      } catch {
        // Keep scanning older lines when the latest line is malformed.
      }
    }
  }

  return null;
}

function textLength(value) {
  return typeof value === "string" ? value.length : null;
}

function countInputCharacters(text) {
  if (typeof text !== "string" || !text) return 0;
  return Array.from(text).filter((character) => COUNTABLE_CHARACTER_PATTERN.test(character)).length;
}

function normalizeHistoryEntry(entry) {
  const finalText =
    typeof entry.finalText === "string"
      ? entry.finalText
      : typeof entry.text === "string"
        ? entry.text
        : "";
  const rawText =
    typeof entry.rawText === "string"
      ? entry.rawText
      : typeof entry.text === "string"
        ? entry.text
        : finalText;
  const text = typeof entry.text === "string" ? entry.text : finalText;

  return {
    ...entry,
    id: entry.id || null,
    ts: entry.ts || null,
    text,
    rawText,
    finalText,
    mode: entry.mode || "normal",
    promptId: entry.promptId || null,
    llmProvider: entry.llmProvider || null,
    llmModel: entry.llmModel || null,
    chars: Number.isFinite(Number(entry.chars)) ? Number(entry.chars) : countInputCharacters(text),
    durationMs: Number.isFinite(Number(entry.durationMs)) ? Number(entry.durationMs) : null,
  };
}

function main() {
  const dataDir = resolveVoicePasteDataDir();
  const latest = readLatestHistoryEntry(path.join(dataDir, "history"));

  if (!latest) {
    console.log(JSON.stringify({ ok: false, dataDir, message: "No history entries found" }, null, 2));
    return;
  }

  const entry = normalizeHistoryEntry(latest.entry);
  const storedMissingFields = REQUIRED_FIELDS.filter((field) => !Object.hasOwn(latest.entry, field));
  const missingFields = REQUIRED_FIELDS.filter((field) => !Object.hasOwn(entry, field));
  const summary = {
    ok: missingFields.length === 0,
    dataDir,
    filePath: latest.filePath,
    lineNumber: latest.lineNumber,
    missingFields,
    storedMissingFields,
    storageSchemaComplete: storedMissingFields.length === 0,
    presentFields: Object.keys(latest.entry).sort(),
    id: entry.id || null,
    ts: entry.ts || null,
    mode: entry.mode || null,
    promptId: entry.promptId || null,
    llmProvider: entry.llmProvider || null,
    llmModel: entry.llmModel || null,
    chars: entry.chars ?? null,
    durationMs: entry.durationMs ?? null,
    lengths: {
      text: textLength(entry.text),
      rawText: textLength(entry.rawText),
      finalText: textLength(entry.finalText),
    },
  };

  console.log(JSON.stringify(summary, null, 2));
}

main();
