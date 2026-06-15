const fs = require("node:fs");
const path = require("node:path");

const ANALYSIS_TARGETS = {
  // -- Tool layer --
  vocabulary: "高频词和个人词库候选",
  asr: "ASR 可能误识别模式",
  code_switching: "中英混用规范：检测中英夹杂模式，建议统一用法",
  // -- Energy layer --
  emotion: "情绪轨迹：按主题标注情感极性，识别充能/耗能话题",
  flow: "心流时刻：通过语速、长句比例、犹豫词密度识别 Flow 状态",
  attention_shift: "关注点迁移：兴趣的涌现、深耕、衰退周期",
  // -- Cognitive layer --
  speaking: "口语习惯：重复表达、长句、填充词",
  topics: "主题分布和主题迁移",
  thought_graph: "思维连接图谱：跨领域概念碰撞和隐性知识网络",
  decision_heuristics: "决策启发式：System 1/2 切换模式，认知偏误高发区",
  metacognition: "元认知痕迹：自我纠正频率、反思深度、思考中断点",
  creativity: "创造力指纹：新隐喻/类比涌现，创造性跳跃的时间规律",
  // -- Philosophy layer --
  values: "价值观考古：stated vs revealed preferences，真实优先级排序",
  beliefs: "信念演化：核心观点的漂移和固化趋势",
  self_narrative: "自我叙事模式：主角/旁观者/受害者叙事在不同话题的分布",
  // -- Efficiency layer --
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

function buildReplacementWordsSection(replacementWords) {
  const text = String(replacementWords || "").trim();
  if (!text) {
    return "\n## 当前替换词表\n\n（暂无已配置的替换词）\n";
  }
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const formatted = lines.map((l) => `- \`${l}\``).join("\n");
  return `\n## 当前替换词表

以下是用户已在火山引擎控制台配置的替换词（共 ${lines.length} 条），分析时请勿重复建议这些词对：

${formatted}
`;
}

// Detailed per-dimension analysis instructions for the prompt
const DIMENSION_GUIDES = {
  vocabulary: `### 高频词和个人词库候选
- 统计高频词 top 30，标注词性和典型搭配
- 识别个人专属术语（非通用词汇但反复出现的词）
- 候选词按"加入输入法词库的价值"排序`,

  asr: `### ASR 误识别模式
- 对比 rawText 和 finalText，提取系统性误识别模式
- 按误识别频率降序排列
- 区分：同音替换、吞字/多字、断句错误、专有名词误识别
- 输出替换词建议（见下方格式要求）`,

  code_switching: `### 中英混用规范
- 检测中英夹杂模式（如"我觉得这个 feature 很好"）
- 区分：必要技术术语 vs 可中文化的习惯性混用
- 建议统一用法规范（哪些保留英文、哪些建议用中文）
- 统计中英切换频率和典型触发场景`,

  emotion: `### 情绪轨迹
- 按条目标注情感极性（正面/负面/中性），给出 -5 到 +5 分值
- 识别"充能话题"（说到就兴奋、语速加快、用词积极）和"耗能话题"（语气疲惫、用词消极）
- 按日期绘制情绪曲线趋势
- 标注情绪峰值和低谷对应的具体话题`,

  flow: `### 心流时刻
- Flow 状态特征：长句比例高、犹豫词密度低、信息密度高、语速稳定
- 识别符合 Flow 特征的语料片段，标注时间和话题
- 对比 Flow vs 非 Flow 片段的语言特征差异
- 识别触发 Flow 的条件模式（时间段、话题类型、前序活动）`,

  attention_shift: `### 关注点迁移
- 追踪话题在时间线上的涌现、深耕、衰退周期
- 识别"痴迷周期"：突然出现并大量占据注意力、然后消失的话题
- 区分持续性兴趣（贯穿全周期）vs 脉冲式兴趣（短暂爆发）
- 按周/日粒度绘制注意力分布热力图`,

  speaking: `### 口语习惯
- 识别重复表达模式（口头禅、固定句式）
- 统计填充词频率（"就是"、"然后"、"那个"、"嗯"等）
- 分析句子长度分布，标注异常长句
- 识别个人语言指纹（独特的表达习惯）`,

  topics: `### 主题分布和迁移
- 按语义聚类提取 top 主题，标注每个主题的条目数和字数占比
- 识别主题间的共现关系和迁移路径
- 按日期维度追踪主题兴衰`,

  thought_graph: `### 思维连接图谱
- 找出跨领域概念碰撞的实例（在 A 话题中引用 B 领域的概念）
- 绘制隐性知识网络：哪些看似无关的话题在思维中被连接
- 识别"桥接概念"：频繁用于连接不同领域的中介概念
- 标注最有价值的跨域连接（可能产生创新洞察的组合）`,

  decision_heuristics: `### 决策启发式
- 识别 System 1（快速直觉判断，如"我觉得应该…"）vs System 2（慢速分析推理，如"让我想一下…如果…那么…"）的切换模式
- 标注潜在认知偏误高发区：锚定效应、确认偏误、沉没成本、可得性启发等
- 统计决策语言模式（"反正"、"肯定是"、"不管怎样" = 可能的 System 1 捷径）
- 识别用户在哪些话题上更依赖直觉、哪些话题上更依赖分析`,

  metacognition: `### 元认知痕迹
- 统计自我纠正实例（"不对"、"等一下"、"我说错了"、"让我重新想"）
- 评估反思深度：表层纠正（改个词）vs 深层反思（推翻整个思路）
- 识别"思考中断点"：突然停顿、换话题、或明确表示"想不下去了"
- 追踪元认知能力随时间的变化趋势`,

  creativity: `### 创造力指纹
- 发现新颖的隐喻、类比和意外的概念组合
- 追踪创造性跳跃（从 A 话题突然跳到看似无关的 B 并建立连接）
- 分析创造力高发的时间规律（时间段、星期几、前序话题）
- 识别此用户独有的创造性表达模式`,

  values: `### 价值观考古
- 提取显性价值判断（"我觉得最重要的是…"、"这不对"、"应该…"）
- 对比 stated preferences（口头说重要的）vs revealed preferences（实际花时间最多的）
- 识别价值观矛盾点（说一套做一套的领域）
- 按重要性排序用户的真实优先级`,

  beliefs: `### 信念演化
- 追踪核心观点在时间线上的变化：漂移（渐变）vs 突变（事件驱动）
- 识别正在固化的信念（重复强调且越来越绝对化）
- 识别正在松动的信念（开始出现"也许"、"不一定"等保留语气）
- 标注可能触发信念变化的事件或信息`,

  self_narrative: `### 自我叙事模式
- 分类叙事视角：主角叙事（"我做了 X"）、旁观者叙事（"X 发生了"）、受害者叙事（"X 发生在我身上"）
- 按话题统计叙事视角分布（工作中用哪种、生活中用哪种）
- 识别叙事模式的切换触发点
- 评估整体叙事健康度：agency（主动性）的比例`,

  polish: `### 润色收益
- 对比 rawText 和 finalText 的差异
- 分类修改类型：错别字修正、语序调整、信息补充、风格润色
- 评估润色 ROI：哪些类型的修改收益最高`,

  efficiency: `### 输入效率
- 按日期/时间段统计输入量（字数、条目数）
- 识别高产时段和低产时段
- 分析输入节奏：连续输入 vs 间歇输入的分布`,
};

// Map target IDs to their output chapter titles
const OUTPUT_CHAPTERS = {
  vocabulary: "高频词 / 专有词候选",
  asr: "ASR 误识别模式 & 替换词建议",
  code_switching: "中英混用分析与规范建议",
  emotion: "情绪轨迹与能量地图",
  flow: "心流时刻识别",
  attention_shift: "关注点迁移图谱",
  speaking: "口语习惯和表达结构",
  topics: "主题分布和近期关注点",
  thought_graph: "思维连接图谱",
  decision_heuristics: "决策启发式分析",
  metacognition: "元认知痕迹",
  creativity: "创造力指纹",
  values: "价值观考古",
  beliefs: "信念演化追踪",
  self_narrative: "自我叙事模式分析",
  polish: "润色收益分析",
  efficiency: "输入效率统计",
};

function buildPrompt(summary, targets, includeFields, replacementWords) {
  const targetLines = targets.map((target) => `- ${ANALYSIS_TARGETS[target]}`);
  const fieldLine = [
    includeFields.rawText ? "rawText" : null,
    includeFields.finalText ? "finalText" : null,
    includeFields.metadata ? "metadata" : null,
  ]
    .filter(Boolean)
    .join(" / ");

  const replacementSection = buildReplacementWordsSection(replacementWords);

  // Build per-dimension guide sections (only for selected targets)
  const guideSection = targets
    .filter((t) => DIMENSION_GUIDES[t])
    .map((t) => DIMENSION_GUIDES[t])
    .join("\n\n");

  // Build dynamic output chapter list
  const outputChapters = [
    "1. 总览结论",
    ...targets.filter((t) => OUTPUT_CHAPTERS[t]).map((t, i) => `${i + 2}. ${OUTPUT_CHAPTERS[t]}`),
    `${targets.length + 2}. 后续可改进建议`,
  ];

  // Only include replacement word requirements if asr target is selected
  const hasAsr = targets.includes("asr");
  const replacementReqSection = hasAsr
    ? `
## 替换词建议要求

在 ASR 误识别分析中，如果你发现语料中有反复出现的误识别模式，请在分析结果中增加一个「替换词建议」章节，按以下格式输出：

- 每条格式：\`原词|替换词\`（竖杠分隔，可直接复制到替换词表）
- 用 ★ 标注置信度：★★★★★ = 必加，★★★★ = 强烈建议，★★★ = 值得考虑
- **排除上方「当前替换词表」中已有的词对**，只输出增量建议
- 附简短理由（出现次数、典型上下文）

示例：

\`\`\`
★★★★★ 绘画|会话 — 出现 22 次，上下文均为"对话/会话"语境
★★★★  Codec|Codex — 出现 5 次，均指 OpenAI Codex
★★★   辨识度|辨识度 — 出现 3 次，可能是口音导致
\`\`\`
`
    : "";

  return `# VoicePaste 语料分析提示词

你正在分析一个 VoicePaste 语音输入语料包。这些语料来自用户日常的语音输入，是未经编辑的原始思维流。请读取本目录下的 \`corpus.jsonl\`、\`corpus.md\` 和 \`summary.json\`，不要臆造未在语料中出现的信息。

## 语料范围

- 日期范围：${summary.range.startDate || "-"} 至 ${summary.range.endDate || "-"}
- 模式：${summary.mode}
- 记录数：${summary.count}
- 总字数：${summary.totalCharacters}
- 总录音时长：${durationText(summary.totalDurationMs)}
- 包含字段：${fieldLine}

## 分析目标

${targetLines.join("\n")}

## 各维度分析指南

${guideSection}
${replacementSection}${replacementReqSection}
## 输出要求

请把结果写入同目录的 \`ANALYSIS.md\`，使用中文，结构清晰，优先给出可以直接行动的发现。

章节结构：

${outputChapters.join("\n")}

**通用原则：**
- 每个维度先给结论，再展开证据
- 引用语料原文时标注时间戳（从 ts 字段提取）
- 如果某个维度证据不足，明确写出"证据不足，需要更多语料"，不要猜测
- 涉及量化指标时给出具体数字，避免"较多""偶尔"等模糊描述`;
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
  const promptText = buildPrompt(summary, targets, includeFields, options.replacementWords);

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
