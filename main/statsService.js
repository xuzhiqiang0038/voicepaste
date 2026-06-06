const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

const STATS_SCHEMA_VERSION = 2;
const HISTORY_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

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
  const chars = Number.isFinite(entry?.chars) ? Number(entry.chars) : text.length;
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

function readHistoryAggregates() {
  ensureHistoryDir();

  const aggregates = {
    dailyCounts: {},
    dailyDurations: {},
    dailySessions: {},
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
        aggregates.dailyCounts[dateKey] =
          (aggregates.dailyCounts[dateKey] || 0) + Number(entry.chars || entry.text.length);
        aggregates.dailyDurations[dateKey] =
          (aggregates.dailyDurations[dateKey] || 0) + Number(entry.durationMs || 0);
        aggregates.dailySessions[dateKey] = (aggregates.dailySessions[dateKey] || 0) + 1;
      } catch {
        // Skip malformed history lines during migration.
      }
    }
  }

  return aggregates;
}

function migrateStats(previousStats) {
  const migrated = {
    ...previousStats,
    schemaVersion: STATS_SCHEMA_VERSION,
    dailyCounts: { ...previousStats.dailyCounts },
    dailyDurations: { ...previousStats.dailyDurations },
    dailySessions: { ...previousStats.dailySessions },
  };
  const recovered = readHistoryAggregates();

  for (const [key, count] of Object.entries(recovered.dailyCounts)) {
    migrated.dailyCounts[key] = count;
  }
  for (const [key, count] of Object.entries(recovered.dailySessions)) {
    migrated.dailySessions[key] = count;
  }
  for (const [key, duration] of Object.entries(recovered.dailyDurations)) {
    if (!migrated.dailyDurations[key] && duration > 0) {
      migrated.dailyDurations[key] = duration;
    }
  }

  for (const [key, count] of Object.entries(migrated.dailyCounts)) {
    if (count > 0 && !migrated.dailySessions[key]) {
      migrated.dailySessions[key] = 1;
    }
  }

  return migrated;
}

function initStatsService() {
  resolveDataDir();
  loadStats();
}

function recordSession(text, options = {}) {
  if (!text) return;

  const s = loadStats();
  const now = new Date();
  const charCount = text.length;
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

function subtractStatValue(map, key, amount) {
  if (!map || !key || !amount) return;
  const nextValue = Math.max(0, Number(map[key] || 0) - amount);
  if (nextValue > 0) {
    map[key] = nextValue;
  } else {
    delete map[key];
  }
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

    const s = loadStats();
    const removedChars = Number(removed.chars || removed.text.length || 0);
    const removedDuration = Number(removed.durationMs || 0);

    s.totalSessions = Math.max(0, Number(s.totalSessions || 0) - 1);
    s.totalCharacters = Math.max(0, Number(s.totalCharacters || 0) - removedChars);
    s.totalDurationMs = Math.max(0, Number(s.totalDurationMs || 0) - removedDuration);
    subtractStatValue(s.dailyCounts, dateKey, removedChars);
    subtractStatValue(s.dailyDurations, dateKey, removedDuration);
    subtractStatValue(s.dailySessions, dateKey, 1);
    flushStats();

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
