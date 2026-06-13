const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("voiceOverlay", {
  onEvent(listener) {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("overlay:event", wrapped);

    return () => {
      ipcRenderer.removeListener("overlay:event", wrapped);
    };
  },
  sendAudioChunk(base64Chunk) {
    return ipcRenderer.invoke("asr:audio-chunk", base64Chunk);
  },
  getConfig() {
    return ipcRenderer.invoke("app:get-config");
  },
  onAppearanceChanged(listener) {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("overlay:appearance-changed", wrapped);
    return () => ipcRenderer.removeListener("overlay:appearance-changed", wrapped);
  },
  sendDiagnostic(payload) {
    ipcRenderer.send("renderer:diagnostic", payload);
  },
  notifyAudioStopped(payload) {
    ipcRenderer.send("renderer:audio-stopped", payload);
  },
  sendAudioInputMissing(payload) {
    ipcRenderer.send("renderer:audio-input-missing", payload);
  },
  sendAudioWarmupReady() {
    ipcRenderer.send("renderer:audio-warmup-ready");
  },
  sendAudioWarmupFailed(payload) {
    ipcRenderer.send("renderer:audio-warmup-failed", payload);
  },
});

contextBridge.exposeInMainWorld("voiceSettings", {
  getData() {
    return ipcRenderer.invoke("settings:get-data");
  },
  saveConfig(payload) {
    return ipcRenderer.invoke("settings:save-config", payload);
  },
  saveConfigObject(config) {
    return ipcRenderer.invoke("settings:save-config-object", config);
  },
  getMicrophoneStatus() {
    return ipcRenderer.invoke("settings:get-microphone-status");
  },
  getAccessibilityStatus() {
    return ipcRenderer.invoke("settings:get-accessibility-status");
  },
  requestMicrophoneAccess() {
    return ipcRenderer.invoke("settings:request-microphone-access");
  },
  resetConfig() {
    return ipcRenderer.invoke("settings:reset-config");
  },
  openAccessibilitySettings() {
    return ipcRenderer.invoke("settings:open-accessibility-settings");
  },
  getLoginItemSettings() {
    return ipcRenderer.invoke("settings:get-login-item");
  },
  setLoginItemSettings(enabled) {
    return ipcRenderer.invoke("settings:set-login-item", enabled);
  },
  recordHotkey() {
    return ipcRenderer.invoke("settings:record-hotkey");
  },
  setTheme(preference) {
    return ipcRenderer.invoke("settings:set-theme", preference);
  },
  setAccentTheme(preference) {
    return ipcRenderer.invoke("settings:set-accent-theme", preference);
  },
  onEvent(listener) {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("settings:event", wrapped);

    return () => {
      ipcRenderer.removeListener("settings:event", wrapped);
    };
  },
  checkForUpdates() {
    return ipcRenderer.invoke("update:check");
  },
  downloadUpdate() {
    return ipcRenderer.invoke("update:download");
  },
  installUpdate() {
    return ipcRenderer.invoke("update:install");
  },
  getStats() {
    return ipcRenderer.invoke("stats:get");
  },
  getHistory(daysBack) {
    return ipcRenderer.invoke("stats:get-history", daysBack);
  },
  deleteHistoryItem(id) {
    return ipcRenderer.invoke("stats:delete-history-item", id);
  },
  queryCorpus(options) {
    return ipcRenderer.invoke("corpus:query", options);
  },
  exportCorpus(payload) {
    return ipcRenderer.invoke("corpus:export", payload);
  },
  chooseAnalysisPackageDir() {
    return ipcRenderer.invoke("analysis-package:choose-dir");
  },
  generateAnalysisPackage(payload) {
    return ipcRenderer.invoke("analysis-package:generate", payload);
  },
  openAnalysisPackageDir(directoryPath) {
    return ipcRenderer.invoke("analysis-package:open-dir", directoryPath);
  },
  copyText(text) {
    return ipcRenderer.invoke("settings:copy-text", text);
  },
  loadPrompts() {
    return ipcRenderer.invoke("prompts:load");
  },
  savePrompts(prompts) {
    return ipcRenderer.invoke("prompts:save", prompts);
  },
  updateAppearance(appearance) {
    return ipcRenderer.invoke("overlay:update-appearance", appearance);
  },
});
