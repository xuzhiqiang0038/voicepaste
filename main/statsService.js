const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

const STATS_SCHEMA_VERSION = 3;
const HISTORY_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const COUNTABLE_CHARACTER_PATTERN = /[\p{L}\p{N}]/u;
const HISTORY_SEARCH_FIELDS = ["text", "rawText", "finalText"];

let dataDir = null;
let historyDir = null;
let stats = null;
let historyBuffer = [];
let flushTimer = null;

function resolveDataDir() {
  if (dataDir) return dataDir;
  dataDir = app.getPath("userData");
  historyDir = path.join(dataDir, "history");
  return dataDir;
}

function statsPath() {
  return path.join(resolveDataDir(), "stats.json");
}

function defaultStats() {
  return {
    schemaVersion: STATS_SCHEMA_VERSION,
    firstUsedAt: null,
    totalSessions: 0,
    totalCharacters: 0,
    totalDurationMs: 0,
    dailyCounts: {},
    dailyDurations: {},
    dailySessions: {},
  };
}

function countInputCharacters(text) {
  if (typeof text !== "string" || !text) return 0;
  return Array.from(text).filter((character) => COUNTABLE_CHARACTER_PATTERN.test(character)).length;
}

function normalizeDailyMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const normalized = {};
  for (const [key, amount] of Object.entries(value)) {
    const number = Number(amount);
    if (Number.isFinite(number) && number > 0) {
      normalized[key] = number;
    }
  }
  return normalized;
}

function normalizeStats(nextStats) {
  const fallback = defaultStats();
  const normalized = {
    ...fallback,
    ...(nextStats || {}),
    schemaVersion: Number(nextStats?.schemaVersion || 0),
    totalSessions: Number(nextStats?.totalSessions || 0),
    totalCharacters: Number(nextStats?.totalCharacters || 0),
    totalDurationMs: Number(nextStats?.totalDurationMs || 0),
    dailyCounts: normalizeDailyMap(nextStats?.dailyCounts),
    dailyDurations: normalizeDailyMap(nextStats?.dailyDurations),
    dailySessions: normalizeDailyMap(nextStats?.dailySessions),
  };

  return normalized;
}

function loadStats() {
  if (stats) return stats;
  try {
    const raw = fs.readFileSync(statsPath(), "utf8");
    stats = normalizeStats(JSON.parse(raw));
  } catch {
    stats = defaultStats();
  }
  if (stats.schemaVersion < STATS_SCHEMA_VERSION) {
    stats = migrateStats(stats);
    flushStats();
  }
  return stats;
}

function ensureHistoryDir() {
  resolveDataDir();
  if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true });
  }
}

function todayKey() {
  return dateKeyFromDate(new Date());
}

function dateKeyFromDate(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
    return todayKey();
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseDateKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return dateKeyFromDate(date);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function dateKeysBetween(startKey, endKey) {
  const start = new Date(`${startKey}T00:00:00`);
  const end = new Date(`${endKey}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return [];
  }

  const keys = [];
  const direction = start <= end ? 1 : -1;
  for (
    let date = start;
    direction > 0 ? date <= end : date >= end;
    date = addDays(date, direction)
  ) {
    keys.push(dateKeyFromDate(date));
  }
  return direction > 0 ? keys : keys.reverse();
}

function normalizeHistoryMode(mode) {
  if (mode === "normal" || mode === "polish") {
    return mode;
  }
  return "unknown";
}

function flushStats() {
  try {
    fs.writeFileSync(statsPath(), JSON.stringify(stats, null, 2), "utf8");
  } catch (err) {
    console.error("[StatsService] failed to write stats.json", err);
  }
}

function flushHistory() {
  if (historyBuffer.length === 0) return;

  ensureHistoryDir();

  const byDate = {};
  for (const entry of historyBuffer) {
    const d = new Date(entry.ts);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (!byDate[key]) byDate[key] = [];
    byDate[key].push(JSON.stringify(entry));
  }

  for (const [dateKey, lines] of Object.entries(byDate)) {
    const filePath = path.join(historyDir, `${dateKey}.jsonl`);
    try {
      fs.appendFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
    } catch (err) {
      console.error(`[StatsService] failed to append history for ${dateKey}`, err);
    }
  }

  historyBuffer = [];
}

function scheduleFlush() {
  if (flushTimer) return;

  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushHistory();
    flushStats();
  }, 0);

  flushTimer.unref?.();
}

function flushPendingWrites() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  flushHistory();
  flushStats();
}

function makeHistoryId(ts) {
  const timestamp = new Date(ts).getTime() || Date.now();
  return `${timestamp.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function hashHistoryEntry(entry) {
  const source = `${entry?.ts || ""}\n${entry?.text || ""}\n${entry?.chars || ""}`;
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

function normalizeHistoryEntry(entry, dateKey, lineIndex) {
  const finalText =
    typeof entry?.finalText === "string"
      ? entry.finalText
      : typeof entry?.text === "string"
        ? entry.text
        : "";
  const rawText =
    typeof entry?.rawText === "string"
      ? entry.rawText
      : typeof entry?.text === "string"
        ? entry.text
        : finalText;
  const text = typeof entry?.text === "string" ? entry.text : finalText;
  const chars = countInputCharacters(text);
  const durationMs = Number(entry?.durationMs || 0);
  return {
    ...entry,
    id: entry?.id || `legacy:${dateKey}:${lineIndex}:${hashHistoryEntry(entry)}`,
    ts: entry?.ts || new Date().toISOString(),
    text,
    rawText,
    finalText,
    mode: normalizeHistoryMode(entry?.mode),
    promptId: entry?.promptId || null,
    llmProvider: entry?.llmProvider || null,
    llmModel: entry?.llmModel || null,
    chars,
    ...(durationMs > 0 ? { durationMs } : {}),
  };
}

function readHistoryEntriesForDate(dateKey) {
  const filePath = path.join(historyDir, `${dateKey}.jsonl`);
  const entries = [];

  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return entries;
    const lines = raw.split("\n");
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      try {
        entries.push(normalizeHistoryEntry(JSON.parse(lines[lineIndex]), dateKey, lineIndex));
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // file doesn't exist, skip
  }

  return entries;
}

function readHistorySnapshot(options = {}) {
  ensureHistoryDir();

  const snapshot = {
    totalSessions: 0,
    totalCharacters: 0,
    totalDurationMs: 0,
    dailyCounts: {},
    dailyDurations: {},
    dailySessions: {},
    firstUsedAt: null,
  };

  const files = fs
    .readdirSync(historyDir)
    .filter((name) => HISTORY_FILE_PATTERN.test(name))
    .sort();

  for (const fileName of files) {
    const dateKey = fileName.replace(/\.jsonl$/, "");
    const filePath = path.join(historyDir, fileName);
    let lines;
    try {
      const raw = fs.readFileSync(filePath, "utf8").trim();
      if (!raw) continue;
      lines = raw.split("\n");
    } catch {
      continue;
    }

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      try {
        const entry = normalizeHistoryEntry(JSON.parse(lines[lineIndex]), dateKey, lineIndex);
        if (!entry.text) continue;
        snapshot.totalSessions += 1;
        snapshot.totalCharacters += entry.chars;
        snapshot.totalDurationMs += Number(entry.durationMs || 0);
        snapshot.dailyCounts[dateKey] = (snapshot.dailyCounts[dateKey] || 0) + entry.chars;
        snapshot.dailyDurations[dateKey] =
          (snapshot.dailyDurations[dateKey] || 0) + Number(entry.durationMs || 0);
        snapshot.dailySessions[dateKey] = (snapshot.dailySessions[dateKey] || 0) + 1;

        if (!snapshot.firstUsedAt || entry.ts < snapshot.firstUsedAt) {
          snapshot.firstUsedAt = entry.ts;
        }
      } catch {
        // Skip malformed history lines during migration.
      }
    }
  }

  if (options.rewriteHistory) {
    rewriteHistoryCharacterCounts(files);
  }

  return snapshot;
}

function rewriteHistoryCharacterCounts(files) {
  for (const fileName of files) {
    const dateKey = fileName.replace(/\.jsonl$/, "");
    const filePath = path.join(historyDir, fileName);
    let lines;
    try {
      const raw = fs.readFileSync(filePath, "utf8").trim();
      if (!raw) continue;
      lines = raw.split("\n");
    } catch {
      continue;
    }

    let changed = false;
    const nextLines = lines.map((line, lineIndex) => {
      try {
        const parsed = JSON.parse(line);
        const normalized = normalizeHistoryEntry(parsed, dateKey, lineIndex);
        if (parsed.chars !== normalized.chars) {
          changed = true;
        }
        return JSON.stringify(normalized);
      } catch {
        return line;
      }
    });

    if (changed) {
      fs.writeFileSync(filePath, `${nextLines.join("\n")}\n`, "utf8");
    }
  }
}

function migrateStats(previousStats) {
  const recovered = readHistorySnapshot({ rewriteHistory: true });
  if (recovered.totalSessions === 0 && Number(previousStats.totalSessions || 0) > 0) {
    return {
      ...previousStats,
      schemaVersion: STATS_SCHEMA_VERSION,
    };
  }

  return {
    ...defaultStats(),
    schemaVersion: STATS_SCHEMA_VERSION,
    firstUsedAt: previousStats.firstUsedAt || recovered.firstUsedAt,
    totalSessions: recovered.totalSessions,
    totalCharacters: recovered.totalCharacters,
    totalDurationMs: recovered.totalDurationMs,
    dailyCounts: recovered.dailyCounts,
    dailyDurations: recovered.dailyDurations,
    dailySessions: recovered.dailySessions,
  };
}

function initStatsService() {
  resolveDataDir();
  loadStats();
}

function recordSession(text, options = {}) {
  if (!text) return;

  const s = loadStats();
  const now = new Date();
  const finalText = typeof options.finalText === "string" ? options.finalText : text;
  const rawText = typeof options.rawText === "string" ? options.rawText : finalText;
  const mode = options.mode === "polish" ? "polish" : "normal";
  const charCount = countInputCharacters(finalText);
  const durationMs = Math.max(0, Math.round(Number(options.durationMs || 0)));

  if (!s.firstUsedAt) {
    s.firstUsedAt = now.toISOString();
  }
  s.totalSessions += 1;
  s.totalCharacters += charCount;
  s.totalDurationMs = (s.totalDurationMs || 0) + durationMs;

  const key = dateKeyFromDate(now);
  s.dailyCounts[key] = (s.dailyCounts[key] || 0) + charCount;
  s.dailyDurations[key] = (s.dailyDurations[key] || 0) + durationMs;
  s.dailySessions[key] = (s.dailySessions[key] || 0) + 1;

  const historyEntry = {
    id: makeHistoryId(now),
    ts: now.toISOString(),
    text: finalText,
    rawText,
    finalText,
    mode,
    promptId: options.promptId || null,
    llmProvider: options.llmProvider || null,
    llmModel: options.llmModel || null,
    chars: charCount,
    ...(durationMs > 0 ? { durationMs } : {}),
  };

  historyBuffer.push(historyEntry);
  scheduleFlush();

  return historyEntry;
}

function getStats() {
  const currentStats = loadStats();
  const activeDays = Object.values(currentStats.dailySessions).filter((count) => count > 0).length;
  return {
    ...currentStats,
    activeDays,
  };
}

function getHistory(daysBack) {
  ensureHistoryDir();
  flushPendingWrites();

  const days = Math.min(daysBack || 3, 365);
  const allItems = [];

  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    allItems.push(...readHistoryEntriesForDate(key));
  }

  allItems.sort((a, b) => (a.ts > b.ts ? -1 : 1));
  return allItems;
}

function queryHistory(options = {}) {
  ensureHistoryDir();
  flushPendingWrites();

  const today = new Date();
  const fallbackEnd = dateKeyFromDate(today);
  const fallbackStart = dateKeyFromDate(addDays(today, -6));
  let startKey = parseDateKey(options.startDate) || fallbackStart;
  let endKey = parseDateKey(options.endDate) || fallbackEnd;
  if (startKey > endKey) {
    [startKey, endKey] = [endKey, startKey];
  }

  const mode = ["normal", "polish"].includes(options.mode) ? options.mode : "all";
  const search = String(options.search || "")
    .trim()
    .toLowerCase();
  const allItems = [];

  for (const key of dateKeysBetween(startKey, endKey)) {
    allItems.push(...readHistoryEntriesForDate(key));
  }

  const filtered = allItems.filter((item) => {
    if (mode !== "all" && item.mode !== mode) {
      return false;
    }
    if (!search) {
      return true;
    }

    return HISTORY_SEARCH_FIELDS.some((field) =>
      String(item[field] || "")
        .toLowerCase()
        .includes(search),
    );
  });

  filtered.sort((a, b) => {
    if (options.order === "asc") {
      return a.ts > b.ts ? 1 : -1;
    }
    return a.ts > b.ts ? -1 : 1;
  });

  return {
    items: filtered,
    range: {
      startDate: startKey,
      endDate: endKey,
    },
    mode,
    search,
  };
}

function deleteHistoryItem(id) {
  if (!id) return { ok: false };
  ensureHistoryDir();
  flushPendingWrites();

  const files = fs
    .readdirSync(historyDir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();

  for (const fileName of files) {
    const dateKey = fileName.replace(/\.jsonl$/, "");
    const filePath = path.join(historyDir, fileName);
    let raw = "";
    try {
      raw = fs.readFileSync(filePath, "utf8").trim();
    } catch {
      continue;
    }
    if (!raw) continue;

    const entries = [];
    let removed = null;
    const lines = raw.split("\n");

    for (let i = 0; i < lines.length; i += 1) {
      try {
        const parsed = JSON.parse(lines[i]);
        const normalized = normalizeHistoryEntry(parsed, dateKey, i);
        if (normalized.id === id && !removed) {
          removed = normalized;
          continue;
        }
        entries.push(parsed);
      } catch {
        entries.push(lines[i]);
      }
    }

    if (!removed) continue;

    const nextContent = entries
      .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
      .join("\n");
    fs.writeFileSync(filePath, nextContent ? `${nextContent}\n` : "", "utf8");

    return { ok: true };
  }

  return { ok: false };
}

function closeStatsService() {
  flushPendingWrites();
}

module.exports = {
  initStatsService,
  recordSession,
  getStats,
  getHistory,
  queryHistory,
  deleteHistoryItem,
  closeStatsService,
};
