const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

const MAX_DAILY_COUNTS_DAYS = 182;

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
    firstUsedAt: null,
    totalSessions: 0,
    totalCharacters: 0,
    totalDurationMs: 0,
    dailyCounts: {},
    dailyDurations: {},
  };
}

function normalizeStats(nextStats) {
  const fallback = defaultStats();
  const normalized = {
    ...fallback,
    ...(nextStats || {}),
    totalSessions: Number(nextStats?.totalSessions || 0),
    totalCharacters: Number(nextStats?.totalCharacters || 0),
    totalDurationMs: Number(nextStats?.totalDurationMs || 0),
    dailyCounts: nextStats?.dailyCounts || {},
    dailyDurations: nextStats?.dailyDurations || {},
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

function pruneDailyCounts() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_DAILY_COUNTS_DAYS);
  const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
  const keys = Object.keys(stats.dailyCounts);
  for (const k of keys) {
    if (k < cutoffKey) {
      delete stats.dailyCounts[k];
    }
  }
  for (const k of Object.keys(stats.dailyDurations || {})) {
    if (k < cutoffKey) {
      delete stats.dailyDurations[k];
    }
  }
}

function flushStats() {
  try {
    pruneDailyCounts();
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
  return loadStats();
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
    const removedDateKey = dateKeyFromDate(new Date(removed.ts));

    s.totalSessions = Math.max(0, Number(s.totalSessions || 0) - 1);
    s.totalCharacters = Math.max(0, Number(s.totalCharacters || 0) - removedChars);
    s.totalDurationMs = Math.max(0, Number(s.totalDurationMs || 0) - removedDuration);
    subtractStatValue(s.dailyCounts, removedDateKey, removedChars);
    subtractStatValue(s.dailyDurations, removedDateKey, removedDuration);
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
