const fs = require("node:fs");
const path = require("node:path");

const ANALYSIS_TARGETS = {
  vocabulary: "高频词和个人词库候选",
  asr: "ASR 可能误识别模式",
  speaking: "口语习惯：重复表达、长句、填充词",
  topics: "主题分布和主题迁移",
  polish: "润色收益：raw 到 final 到底改了什么",
  efficiency: "输入效率：高产日期、高产时间段、输入节奏",
};

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatDateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatTimestamp(date = new Date()) {
  return `${formatDateKey(date)}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function sanitizeFilePart(value) {
  const invalidChars = '<>:"/\\|?*';
  return Array.from(String(value || ""))
    .map((char) => (char.charCodeAt(0) < 32 || invalidChars.includes(char) ? "-" : char))
    .join("")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function normalizeMode(mode) {
  if (mode === "normal" || mode === "polish") {
    return mode;
  }
  return "unknown";
}

function modeLabel(mode) {
  if (mode === "normal") return "普通";
  if (mode === "polish") return "润色";
  return "旧记录";
}

function durationText(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds} 秒`;
  return `${minutes} 分 ${seconds} 秒`;
}

function normalizeIncludeFields(includeFields = {}) {
  const rawText = includeFields.rawText !== false;
  const finalText = includeFields.finalText !== false;
  return {
    rawText: rawText || !finalText,
    finalText: finalText || !rawText,
    metadata: includeFields.metadata !== false,
  };
}

function normalizeTargets(targets) {
  const selected = Array.isArray(targets)
    ? targets.filter((target) => ANALYSIS_TARGETS[target])
    : [];
  return selected.length > 0 ? selected : Object.keys(ANALYSIS_TARGETS);
}

function normalizeEntry(entry) {
  const finalText = typeof entry.finalText === "string" ? entry.finalText : entry.text || "";
  const rawText = typeof entry.rawText === "string" ? entry.rawText : entry.text || finalText;
  return {
    id: entry.id || "",
    ts: entry.ts || "",
    text: entry.text || finalText,
    rawText,
    finalText,
    mode: normalizeMode(entry.mode),
    promptId: entry.promptId || null,
    llmProvider: entry.llmProvider || null,
    llmModel: entry.llmModel || null,
    chars: Number(entry.chars || 0),
    durationMs: Number(entry.durationMs || 0),
  };
}

function buildSummary(entries, options = {}) {
  const normalizedEntries = entries.map(normalizeEntry);
  const modeCounts = normalizedEntries.reduce(
    (acc, entry) => {
      acc[entry.mode] = (acc[entry.mode] || 0) + 1;
      return acc;
    },
    { normal: 0, polish: 0, unknown: 0 },
  );

  return {
    generatedAt: new Date().toISOString(),
    range: options.range || {},
    mode: options.mode || "all",
    search: options.search || "",
    count: normalizedEntries.length,
    totalCharacters: normalizedEntries.reduce((sum, entry) => sum + Number(entry.chars || 0), 0),
    totalDurationMs: normalizedEntries.reduce(
      (sum, entry) => sum + Number(entry.durationMs || 0),
      0,
    ),
    modeCounts,
  };
}

function toJsonl(entries) {
  return `${entries.map((entry) => JSON.stringify(normalizeEntry(entry))).join("\n")}\n`;
}

function markdownForEntry(entry, includeFields) {
  const d = new Date(entry.ts);
  const time = Number.isNaN(d.getTime()) ? entry.ts : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const lines = [
    `### ${time || "未知时间"} · ${modeLabel(entry.mode)} · ${entry.chars} 字 · ${durationText(entry.durationMs)}`,
  ];

  if (includeFields.metadata) {
    lines.push("");
    lines.push(`- id: ${entry.id || "-"}`);
    lines.push(`- prompt: ${entry.promptId || "-"}`);
    lines.push(`- llm: ${entry.llmProvider || "-"} / ${entry.llmModel || "-"}`);
  }

  if (includeFields.rawText) {
    lines.push("");
    lines.push("#### Raw");
    lines.push("");
    lines.push(entry.rawText || "");
  }

  if (includeFields.finalText) {
    lines.push("");
    lines.push("#### Final");
    lines.push("");
    lines.push(entry.finalText || "");
  }

  return lines.join("\n");
}

function toMarkdown(entries, options = {}) {
  const includeFields = normalizeIncludeFields(options.includeFields);
  const normalizedEntries = entries.map(normalizeEntry);
  const summary = buildSummary(normalizedEntries, options);
  const lines = [
    "# VoicePaste 语料导出",
    "",
    `- 生成时间：${summary.generatedAt}`,
    `- 日期范围：${summary.range.startDate || "-"} 至 ${summary.range.endDate || "-"}`,
    `- 模式：${summary.mode}`,
    `- 记录数：${summary.count}`,
    `- 总字数：${summary.totalCharacters}`,
    `- 总录音时长：${durationText(summary.totalDurationMs)}`,
  ];

  let lastDate = "";
  for (const entry of normalizedEntries) {
    const d = new Date(entry.ts);
    const dateKey = Number.isNaN(d.getTime()) ? "未知日期" : formatDateKey(d);
    if (dateKey !== lastDate) {
      lines.push("");
      lines.push(`## ${dateKey}`);
      lastDate = dateKey;
    }
    lines.push("");
    lines.push(markdownForEntry(entry, includeFields));
  }

  return `${lines.join("\n")}\n`;
}

function csvEscape(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(entries) {
  const headers = [
    "id",
    "ts",
    "mode",
    "promptId",
    "llmProvider",
    "llmModel",
    "chars",
    "durationMs",
    "rawText",
    "finalText",
  ];
  const lines = [headers.join(",")];
  for (const entry of entries.map(normalizeEntry)) {
    lines.push(headers.map((header) => csvEscape(entry[header])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function formatCorpus(entries, options = {}) {
  if (options.format === "markdown") return toMarkdown(entries, options);
  if (options.format === "csv") return toCsv(entries);
  return toJsonl(entries);
}

function exportExtension(format) {
  if (format === "markdown") return "md";
  if (format === "csv") return "csv";
  return "jsonl";
}

function writeCorpusExport(entries, options, outputDir) {
  const format = ["jsonl", "markdown", "csv"].includes(options.format) ? options.format : "jsonl";
  const ext = exportExtension(format);
  const range = options.range || {};
  const rangePart = sanitizeFilePart(`${range.startDate || "start"}_${range.endDate || "end"}`);
  const fileName = `voicepaste-corpus-${rangePart}-${formatTimestamp()}.${ext}`;
  const filePath = path.join(outputDir, fileName);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(filePath, formatCorpus(entries, { ...options, format }), "utf8");
  return {
    ok: true,
    filePath,
    count: entries.length,
  };
}

function buildPrompt(summary, targets, includeFields) {
  const targetLines = targets.map((target) => `- ${ANALYSIS_TARGETS[target]}`);
  const fieldLine = [
    includeFields.rawText ? "rawText" : null,
    includeFields.finalText ? "finalText" : null,
    includeFields.metadata ? "metadata" : null,
  ]
    .filter(Boolean)
    .join(" / ");

  return `# VoicePaste 语料分析提示词

你正在分析一个 VoicePaste 语音输入语料包。请读取本目录下的 \`corpus.jsonl\`、\`corpus.md\` 和 \`summary.json\`，不要臆造未在语料中出现的信息。

## 语料范围

- 日期范围：${summary.range.startDate || "-"} 至 ${summary.range.endDate || "-"}
- 模式：${summary.mode}
- 记录数：${summary.count}
- 总字数：${summary.totalCharacters}
- 总录音时长：${durationText(summary.totalDurationMs)}
- 包含字段：${fieldLine}

## 分析目标

${targetLines.join("\n")}

## 输出要求

请把结果写入同目录的 \`ANALYSIS.md\`，使用中文，结构清晰，优先给出可以直接行动的发现：

1. 总览结论
2. 高频词 / 专有词候选
3. ASR 可能误识别模式
4. 口语习惯和表达结构
5. 主题分布和近期关注点
6. raw 到 final 的润色收益
7. 后续可改进建议

如果证据不足，请明确写出“证据不足”，不要猜测。`;
}

function writeAnalysisPackage(entries, options, outputDir) {
  const normalizedEntries = entries.map(normalizeEntry);
  const includeFields = normalizeIncludeFields(options.includeFields);
  const targets = normalizeTargets(options.targets);
  const summary = {
    ...buildSummary(normalizedEntries, options),
    includeFields,
    targets: targets.map((id) => ({ id, label: ANALYSIS_TARGETS[id] })),
    files: ["corpus.jsonl", "corpus.md", "summary.json", "PROMPT.md", "ANALYSIS.md"],
  };
  const packageName = sanitizeFilePart(
    `voicepaste-analysis-${formatTimestamp()}-${summary.range.startDate || "start"}_${summary.range.endDate || "end"}`,
  );
  const packageDir = path.join(outputDir, packageName);
  const promptText = buildPrompt(summary, targets, includeFields);

  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "corpus.jsonl"), toJsonl(normalizedEntries), "utf8");
  fs.writeFileSync(
    path.join(packageDir, "corpus.md"),
    toMarkdown(normalizedEntries, { ...options, includeFields }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(packageDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(packageDir, "PROMPT.md"), `${promptText}\n`, "utf8");
  fs.writeFileSync(path.join(packageDir, "ANALYSIS.md"), "# VoicePaste 语料分析结果\n\n", "utf8");

  return {
    ok: true,
    packageDir,
    promptText,
    summary,
  };
}

module.exports = {
  ANALYSIS_TARGETS,
  writeCorpusExport,
  writeAnalysisPackage,
};
