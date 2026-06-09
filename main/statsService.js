const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

const STATS_SCHEMA_VERSION = 3;
const HISTORY_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const COUNTABLE_CHARACTER_PATTERN = /[\p{L}\p{N}]/u;

let dataDir = null;
let historyDir = null;
let stats = null;
let historyBuffer = [];

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
  const text = typeof entry?.text === "string" ? entry.text : "";
  const chars = countInputCharacters(text);
  const durationMs = Number(entry?.durationMs || 0);
  return {
    ...entry,
    id: entry?.id || `legacy:${dateKey}:${lineIndex}:${hashHistoryEntry(entry)}`,
    ts: entry?.ts || new Date().toISOString(),
    text,
    chars,
    ...(durationMs > 0 ? { durationMs } : {}),
  };
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
  const charCount = countInputCharacters(text);
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
    text,
    chars: charCount,
    ...(durationMs > 0 ? { durationMs } : {}),
  };

  historyBuffer.push(historyEntry);
  flushHistory();
  flushStats();

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

  const days = Math.min(daysBack || 3, 365);
  const allItems = [];

  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const filePath = path.join(historyDir, `${key}.jsonl`);

    try {
      const raw = fs.readFileSync(filePath, "utf8").trim();
      if (!raw) continue;
      const lines = raw.split("\n");
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        try {
          allItems.push(normalizeHistoryEntry(JSON.parse(line), key, lineIndex));
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // file doesn't exist, skip
    }
  }

  allItems.sort((a, b) => (a.ts > b.ts ? -1 : 1));
  return allItems;
}

function deleteHistoryItem(id) {
  if (!id) return { ok: false };
  ensureHistoryDir();
  flushHistory();

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
  flushHistory();
  flushStats();
}

module.exports = {
  initStatsService,
  recordSession,
  getStats,
  getHistory,
  deleteHistoryItem,
  closeStatsService,
};
