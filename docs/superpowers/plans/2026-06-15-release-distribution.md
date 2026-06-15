# VoicePaste Release Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the independent VoicePaste repository into a formally installable Windows distribution with GitHub Release based auto-update support, starting from v2.0.0.

**Architecture:** Keep GitHub Releases as the update host because `package.json` already configures `electron-builder` publishing to `xuzhiqiang0038/voicepaste`, and the app already uses `electron-updater` from the main process. Use NSIS as the primary Windows installer because it is the configured Windows target and is one of electron-builder's auto-updatable targets. Treat macOS as a later release lane because signed/notarized macOS auto-update requires Apple credentials and a macOS build environment.

**Tech Stack:** Electron 41, electron-builder 26, electron-updater 6, NSIS Windows installer, GitHub Releases, pnpm, Biome.

---

## Distribution Decision

Primary release format for now:

- Windows x64 NSIS installer: `VoicePaste-2.0.0-win-x64.exe`
- Auto-update metadata: `latest.yml`
- Delta update helper: `VoicePaste-2.0.0-win-x64.exe.blockmap` when generated
- Host: GitHub Releases on `xuzhiqiang0038/voicepaste`

Other possible formats:

- Portable `.exe`: useful for quick copying, but not the right default for automatic updates.
- ZIP/unpacked folder: useful for debugging or internal smoke tests, but fragile for non-technical distribution.
- Microsoft Store/MSIX: more formal distribution, but slower to set up and unnecessary for the current private/limited sharing goal.
- Source repository: avoid as a distribution channel because source secrecy/resale risk is a user constraint.

Version decision:

- Use `2.0.0` as the independent baseline.
- Reason: this repository has diverged substantially from the original project, the GitHub fork network has been detached, the app identity changed to `com.xuzhiqiang0038.voicepaste`, and the user-facing feature set now includes major corpus/history/export/analysis/settings changes.
- The upstream also using `2.0.0` is not a blocker because tags and releases are now scoped to this independent repository.

Important auto-update facts to preserve:

- electron-builder's publish configuration creates and/or uploads update metadata such as `latest.yml`.
- electron-updater checks the configured publish server for new releases.
- Windows auto-update is supported for the NSIS target.
- macOS auto-update requires signed apps; keep macOS formal release as a separate validation lane.

Reference docs:

- electron-builder publish docs: https://www.electron.build/docs/publish/
- electron-builder auto-update docs: https://www.electron.build/docs/features/auto-update/
- electron-builder NSIS docs: https://www.electron.build/docs/nsis/
- GitHub release docs: https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository

## Current Findings

- `package.json` still has `"version": "1.2.0"`.
- The app displays the version through `app.getVersion()` in `main/main.js`, so changing `package.json.version` changes the About page version in packaged builds.
- `package.json.build.publish` already points to `xuzhiqiang0038/voicepaste`.
- `package.json.build.win.target` is already `nsis`.
- `.github/workflows/ci.yml` only runs lint; it does not build or publish installers.
- GitHub Releases for `xuzhiqiang0038/voicepaste` are currently empty.
- `.claude/skills/github-release/scripts/render-release-notes.sh` and `.claude/skills/github-release/SKILL.md` still have a `that-yolanda/voicepaste` compare URL and must be fixed before formal release notes are generated.
- The About page has no explicit project homepage row; add one so the app clearly links to `xuzhiqiang0038/voicepaste`.
- The MIT license text keeps the original author's copyright. Keep it and add/retain the xuzhiqiang0038 line; do not remove original attribution.

---

### Task 1: Release Identity Guardrails And About Link

**Files:**

- Create: `scripts/releaseIdentity.test.js`
- Modify: `renderer/settings.html`
- Modify: `.claude/skills/github-release/SKILL.md`
- Modify: `.claude/skills/github-release/scripts/render-release-notes.sh`

- [ ] **Step 1: Write the failing release identity test**

Create `scripts/releaseIdentity.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const expectedRepoUrl = "https://github.com/xuzhiqiang0038/voicepaste";
const forbidden = [
  "github.com/that-yolanda/voicepaste",
  "ko-fi.com/thatyolanda",
  "com.yolanda.voicepaste",
];

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
```

- [ ] **Step 2: Run the test and verify it fails for the current gaps**

Run:

```powershell
pwsh -NoProfile -Command "node scripts/releaseIdentity.test.js"
```

Expected before implementation:

- FAIL because the About page has only one maintained repo link.
- FAIL because `render-release-notes.sh` still points to the original repository.

- [ ] **Step 3: Add an About page project homepage row**

In `renderer/settings.html`, inside `section-about`, after the current version row and before the update row, add:

```html
              <div class="row">
                <div class="row-label">
                  <div class="title">项目主页</div>
                  <div class="desc">查看发布包、更新说明和问题反馈</div>
                </div>
                <a
                  class="btn btn-sm"
                  href="https://github.com/xuzhiqiang0038/voicepaste"
                  target="_blank"
                >
                  <span class="nav-icon" data-icon="external-link"></span> 打开
                </a>
              </div>
```

The settings window already calls `setWindowOpenHandler` in `main/windowManager.js`, so the link opens in the default browser.

- [ ] **Step 4: Fix release notes compare URL**

In `.claude/skills/github-release/scripts/render-release-notes.sh`, replace:

```bash
compare_url="https://github.com/that-yolanda/voicepaste/compare/v${previous}...v${version}"
```

with:

```bash
compare_url="https://github.com/xuzhiqiang0038/voicepaste/compare/v${previous}...v${version}"
```

In `.claude/skills/github-release/SKILL.md`, replace the sample Full Changelog URL with:

```md
**Full Changelog**: https://github.com/xuzhiqiang0038/voicepaste/compare/v<previous>...v<version>
```

- [ ] **Step 5: Verify Task 1**

Run:

```powershell
pwsh -NoProfile -Command "node scripts/releaseIdentity.test.js"
pwsh -NoProfile -Command "pnpm check"
pwsh -NoProfile -Command "git diff --check"
```

Expected:

- `node scripts/releaseIdentity.test.js` exits 0.
- `pnpm check` exits 0.
- `git diff --check` exits 0.

- [ ] **Step 6: Commit Task 1**

```powershell
pwsh -NoProfile -Command "git add -- scripts/releaseIdentity.test.js renderer/settings.html .claude/skills/github-release/SKILL.md .claude/skills/github-release/scripts/render-release-notes.sh docs/superpowers/plans/2026-06-15-release-distribution.md; git commit -m 'fix(repo): point release surfaces to maintained repository' -m 'Keep the in-app About page and generated release notes aligned with the independent xuzhiqiang0038 repository so packaged builds no longer route users to the original upstream project.'"
```

---

### Task 2: v2.0.0 Baseline Version And Changelog

**Files:**

- Create: `scripts/releaseVersion.test.js`
- Modify: `package.json`
- Modify: `CHANGELOG.md`
- Modify: `CHANGELOG.zh.md`

- [ ] **Step 1: Write the failing release version test**

Create `scripts/releaseVersion.test.js`:

```js
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

assert.match(changelog, new RegExp(`## v${expectedVersion} \\\\(2026-06-15\\\\)`));
assert.match(changelogZh, new RegExp(`## v${expectedVersion} \\\\(2026-06-15\\\\)`));

for (const text of [changelog, changelogZh]) {
  assert.ok(text.indexOf(`## v${expectedVersion}`) < text.indexOf("## v1.2.0"));
}
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```powershell
pwsh -NoProfile -Command "node scripts/releaseVersion.test.js"
```

Expected before implementation:

- FAIL because `package.json.version` is still `1.2.0`.
- FAIL because changelogs do not yet contain `v2.0.0`.

- [ ] **Step 3: Update package version**

In `package.json`, change:

```json
  "version": "1.2.0",
```

to:

```json
  "version": "2.0.0",
```

- [ ] **Step 4: Add English changelog entry**

At the top of `CHANGELOG.md`, below `# Changelog`, add:

```md
## v2.0.0 (2026-06-15)

- **Independent Release Line** — VoicePaste is now maintained from `xuzhiqiang0038/voicepaste` with updated repository, release, update, and app identity metadata.
- **Corpus Workspace** — Added corpus browsing, filtering, export, analysis package generation, and replacement-word management for long-term voice input review.
- **History Metadata** — Preserved raw ASR text, final pasted text, mode, prompt, provider, model, character count, and recording duration in history records.
- **Settings And Overlay Polish** — Added appearance presets, theme accents, live preview, sound controls, usage dashboard refinements, and hotkey stability fixes.
- **Release Readiness** — Windows NSIS packaging and GitHub Release metadata are prepared for installable builds with auto-update support.
```

- [ ] **Step 5: Add Chinese changelog entry**

At the top of `CHANGELOG.zh.md`, below `# 更新说明`, add:

```md
## v2.0.0 (2026-06-15)

- **独立发布线** — VoicePaste 现在由 `xuzhiqiang0038/voicepaste` 独立维护，仓库、发布、更新和应用身份元数据均已切换到当前项目。
- **语料库工作区** — 新增语料浏览、筛选、导出、分析包生成和替换词管理，用于长期语音输入复盘。
- **历史记录元数据** — 历史记录保存豆包 ASR 原文、最终粘贴文本、模式、提示词、LLM 厂商/模型、字数和录音时长。
- **设置页与浮层打磨** — 新增外观方案、主题强调色、实时预览、提示音控制、使用看板优化和快捷键稳定性修复。
- **正式发布准备** — Windows NSIS 安装包与 GitHub Release 更新元数据已准备好支持安装版和自动更新。
```

- [ ] **Step 6: Verify Task 2**

Run:

```powershell
pwsh -NoProfile -Command "node scripts/releaseVersion.test.js"
pwsh -NoProfile -Command "pnpm check"
pwsh -NoProfile -Command "git diff --check"
```

Expected:

- `node scripts/releaseVersion.test.js` exits 0.
- `pnpm check` exits 0.
- `git diff --check` exits 0.

- [ ] **Step 7: Commit Task 2**

```powershell
pwsh -NoProfile -Command "git add -- package.json CHANGELOG.md CHANGELOG.zh.md scripts/releaseVersion.test.js; git commit -m 'chore(release): prepare v2.0.0 baseline' -m 'Start the independent release line at v2.0.0 to reflect the detached repository, new app identity, corpus workflow, and installable distribution path.'"
```

---

### Task 3: Windows Release Build Verification

**Files:**

- No source files should change unless the build exposes a packaging bug.

- [ ] **Step 1: Run quality gate**

```powershell
pwsh -NoProfile -Command "pnpm check"
```

Expected:

- Exit code 0.

- [ ] **Step 2: Build Windows x64 installer**

```powershell
pwsh -NoProfile -Command "pnpm run pack -p win-x64"
```

Expected:

- Exit code 0.
- `dist/VoicePaste-2.0.0-win-x64.exe` exists.
- `dist/latest.yml` exists.
- `dist/VoicePaste-2.0.0-win-x64.exe.blockmap` exists if electron-builder generates it.

- [ ] **Step 3: Validate Windows artifacts with PowerShell**

```powershell
pwsh -NoProfile -Command "$required = @('dist/VoicePaste-2.0.0-win-x64.exe','dist/latest.yml'); foreach ($file in $required) { if (-not (Test-Path -LiteralPath $file)) { throw \"Missing $file\" } }; Get-ChildItem -LiteralPath dist -File | Where-Object { $_.Name -match 'VoicePaste-2\\.0\\.0-win-x64|latest\\.yml' } | Select-Object Name,Length,LastWriteTime | Format-Table -AutoSize"
```

Expected:

- Both required files are present.
- The table shows the installer and `latest.yml`.

- [ ] **Step 4: Inspect update metadata**

```powershell
pwsh -NoProfile -Command "Get-Content -LiteralPath 'dist/latest.yml' -Raw"
```

Expected:

- The YAML references version `2.0.0`.
- The YAML references `VoicePaste-2.0.0-win-x64.exe`.

- [ ] **Step 5: Smoke install locally**

Manual steps:

1. Close any running `VoicePaste.exe`.
2. Run `dist/VoicePaste-2.0.0-win-x64.exe`.
3. Launch the installed app.
4. Open Settings -> About.
5. Confirm current version shows `v2.0.0`.
6. Confirm the project homepage button opens `https://github.com/xuzhiqiang0038/voicepaste`.
7. Confirm Settings -> About -> Check update does not crash. Before the GitHub Release exists, it may report latest/failure depending on release availability; this is acceptable at this stage.

---

### Task 4: Publish v2.0.0 GitHub Release

**Files:**

- No source files should change.

- [ ] **Step 1: Confirm release assets**

Required Windows assets:

```text
dist/VoicePaste-2.0.0-win-x64.exe
dist/latest.yml
dist/VoicePaste-2.0.0-win-x64.exe.blockmap
```

If the blockmap file is absent, continue only after confirming electron-builder did not generate one for this build.

- [ ] **Step 2: Create the tag locally**

```powershell
pwsh -NoProfile -Command "git tag -a v2.0.0 -m 'Release v2.0.0'"
```

- [ ] **Step 3: Push commit and tag**

```powershell
pwsh -NoProfile -Command "git push origin main"
pwsh -NoProfile -Command "git push origin v2.0.0"
```

- [ ] **Step 4: Create a draft GitHub Release**

Manual GitHub UI path:

1. Open `https://github.com/xuzhiqiang0038/voicepaste/releases/new`.
2. Choose tag `v2.0.0`.
3. Title: `v2.0.0`
4. Keep it as a normal release, not prerelease.
5. Add release notes:

```md
## What's New

- **Independent Release Line** — VoicePaste is now maintained from `xuzhiqiang0038/voicepaste` with updated repository, release, update, and app identity metadata.
- **Corpus Workspace** — Browse, filter, export, and package voice-input corpus data for external analysis.
- **History Metadata** — Preserve raw ASR text, final pasted text, prompt/model metadata, character counts, and recording duration.
- **Settings And Overlay Polish** — Refined dashboard, themes, overlay appearance, sound controls, and hotkey stability.
- **Windows Installer** — First independent Windows x64 NSIS installer with GitHub Release update metadata.

## Downloads

- `VoicePaste-2.0.0-win-x64.exe` — Windows x64 installer
```

6. Upload:
   - `dist/VoicePaste-2.0.0-win-x64.exe`
   - `dist/latest.yml`
   - `dist/VoicePaste-2.0.0-win-x64.exe.blockmap` if present
7. Save draft first.

- [ ] **Step 5: Publish release after asset check**

Before publishing, confirm the draft release has all assets listed above. Then click Publish release.

- [ ] **Step 6: Verify release through GitHub API**

```powershell
pwsh -NoProfile -Command "$release = Invoke-RestMethod -Headers @{ 'User-Agent' = 'codex-audit' } -Uri 'https://api.github.com/repos/xuzhiqiang0038/voicepaste/releases/tags/v2.0.0'; $release | Select-Object tag_name,name,draft,prerelease,published_at | Format-List; $release.assets | Select-Object name,size,browser_download_url | Format-Table -AutoSize"
```

Expected:

- `draft` is `False`.
- `prerelease` is `False`.
- Assets include the installer and `latest.yml`.

---

### Task 5: Verify Auto-Update On Windows

**Files:**

- No source files should change for the first half.
- A temporary `2.0.1` test release may be created if a full auto-update verification is required.

- [ ] **Step 1: Install v2.0.0 on the target Win11 x64 device**

Manual steps:

1. Download `VoicePaste-2.0.0-win-x64.exe` from `https://github.com/xuzhiqiang0038/voicepaste/releases/tag/v2.0.0`.
2. Install it.
3. Start VoicePaste.
4. Open Settings -> About.
5. Confirm version `v2.0.0`.

- [ ] **Step 2: Decide per-machine vs per-user behavior**

Current config:

```json
"nsis": {
  "oneClick": false,
  "perMachine": true,
  "allowToChangeInstallationDirectory": true
}
```

Decision:

- Keep `perMachine: true` if the installer should be available to multiple Windows accounts on the same machine and UAC prompts are acceptable.
- Change to `perMachine: false` if smooth per-user auto-updates without admin prompts matter more than all-users installation.

For the user's current target, keep `perMachine: true` for the first release because the user mentioned another Windows account/device and controls the target machines. Revisit only if update prompts become annoying.

- [ ] **Step 3: Verify update check after release exists**

Manual steps:

1. In packaged v2.0.0, open Settings -> About.
2. Click Check update.
3. Expected when v2.0.0 is the latest release: `当前已是最新版本`.

- [ ] **Step 4: Full auto-update test with v2.0.1**

Only do this after v2.0.0 is installed and working:

1. Change `package.json.version` to `2.0.1`.
2. Add a tiny changelog entry for `v2.0.1`.
3. Build Windows x64: `pnpm run pack -p win-x64`.
4. Publish GitHub Release `v2.0.1` with:
   - `dist/VoicePaste-2.0.1-win-x64.exe`
   - `dist/latest.yml`
   - `dist/VoicePaste-2.0.1-win-x64.exe.blockmap` if present
5. In installed v2.0.0, click Check update.
6. Expected: button changes to `立即更新`.
7. Click update and install.
8. Expected after restart: About shows `v2.0.1`.

---

### Task 6: Optional CI Release Automation

**Files:**

- Modify: `.github/workflows/release.yml`

Reason to defer:

- The first formal release can be manual and safer.
- GitHub Actions would need secrets and signing decisions.
- The current user priority is Windows x64 distribution to controlled devices.

When ready, create `.github/workflows/release.yml` that runs on `v*` tags, installs pnpm, builds `win-x64`, and uploads installer plus update metadata to the GitHub Release. Keep macOS out until Apple signing/notarization is settled.

Minimal future workflow:

```yaml
name: Release

on:
  push:
    tags:
      - "v*"

jobs:
  win-x64:
    runs-on: windows-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm check
      - run: pnpm run pack -p win-x64
      - uses: softprops/action-gh-release@v2
        with:
          files: |
            dist/VoicePaste-*-win-x64.exe
            dist/VoicePaste-*-win-x64.exe.blockmap
            dist/latest.yml
```

---

## Execution Order

1. Task 1: fix remaining release identity surfaces.
2. Task 2: bump to `2.0.0` and write changelog.
3. Task 3: build and smoke-test Windows installer locally.
4. Task 4: publish v2.0.0 GitHub Release with update metadata.
5. Task 5: install on the other Win11 x64 device and verify update behavior.
6. Task 6: optionally automate releases after the manual path works.

## Completion Criteria

- GitHub repo is independent and release metadata points to `xuzhiqiang0038/voicepaste`.
- Packaged app About page shows `v2.0.0`.
- About page has a project homepage button pointing to `xuzhiqiang0038/voicepaste`.
- Windows installer exists and can install the app.
- GitHub Release `v2.0.0` includes the installer and `latest.yml`.
- Installed v2.0.0 can check updates without crashing.
- A later version can be delivered through the About page update flow.
