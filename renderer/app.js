// --- Sound system (preloaded at startup, async, non-blocking) ---
const soundPool = {};
const soundTasks = {};
const activeSounds = new Set();
const soundUrls = {
  start: "./assets/start.mp3",
  end: "./assets/end.mp3",
};
const SOUND_DEFAULTS = {
  enabled: true,
  start: true,
  end: true,
  volume: 0.72,
};
const AUDIO_INPUT_CHECK_MS = 2000;
const AUDIO_INPUT_MIN_RMS = 0.0025;
const AUDIO_INPUT_MIN_PEAK = 0.012;
const AUDIO_INPUT_REQUIRED_FRAMES = 1;
const AUDIO_INPUT_MISSING_MESSAGE = "未检测到语音，请检查麦克风";
let soundConfig = { ...SOUND_DEFAULTS };

function reportSoundIssue(type, payload = {}) {
  window.voiceOverlay.sendDiagnostic({
    type: `sound:${type}`,
    ...payload,
  });
}

function getSoundFallbackMs(audio) {
  const durationMs = Number.isFinite(audio.duration) ? audio.duration * 1000 : 1200;
  return Math.max(1600, durationMs + 450);
}

function normalizeSoundConfig(config) {
  const source = config && typeof config === "object" ? config : {};
  const volume = Number(source.volume);
  return {
    enabled: source.enabled !== false,
    start: source.start !== false,
    end: source.end !== false,
    volume: Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : SOUND_DEFAULTS.volume,
  };
}

function shouldPlaySound(name) {
  if (!soundConfig.enabled) return false;
  if (name === "start") return soundConfig.start !== false;
  if (name === "end") return soundConfig.end !== false;
  return true;
}

async function loadSound(name, url) {
  return new Promise((resolve) => {
    const audio = new Audio(url);
    let settled = false;

    const finish = (ready) => {
      if (settled) {
        return;
      }
      settled = true;
      if (ready) {
        soundPool[name] = audio;
      }
      resolve(ready);
    };

    audio.preload = "auto";
    audio.volume = 0.72;
    audio.addEventListener(
      "canplaythrough",
      () => {
        finish(true);
      },
      { once: true },
    );
    audio.addEventListener(
      "canplay",
      () => {
        finish(true);
      },
      { once: true },
    );
    audio.addEventListener(
      "error",
      () => {
        reportSoundIssue("load-failed", {
          name,
          message: audio.error?.message || `media-error-${audio.error?.code || "unknown"}`,
        });
        finish(false);
      },
      { once: true },
    );
    audio.load();
    setTimeout(() => {
      finish(audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA);
    }, 1500);
  });
}

async function playSound(name) {
  if (!shouldPlaySound(name)) {
    return;
  }

  let fallbackTimer = 0;
  let didNotify = false;
  let audio = null;

  const finishEndSound = () => {
    if (didNotify) {
      return;
    }
    didNotify = true;
    clearTimeout(fallbackTimer);
    if (audio) {
      activeSounds.delete(audio);
    }
  };

  try {
    if (soundTasks[name]) {
      await soundTasks[name];
    }
    const template = soundPool[name] || new Audio(soundUrls[name]);
    if (!template) {
      reportSoundIssue("skip-not-ready", { name });
      finishEndSound();
      return;
    }
    audio = template.cloneNode(true);
    audio.volume = soundConfig.volume;
    audio.currentTime = 0;
    activeSounds.add(audio);
    audio.addEventListener(
      "ended",
      () => {
        activeSounds.delete(audio);
      },
      { once: true },
    );
    audio.addEventListener(
      "error",
      () => {
        activeSounds.delete(audio);
      },
      { once: true },
    );
    if (name === "end") {
      audio.addEventListener(
        "ended",
        () => {
          finishEndSound();
        },
        { once: true },
      );
      audio.addEventListener(
        "error",
        () => {
          finishEndSound();
        },
        { once: true },
      );
    }
    await audio.play();
    reportSoundIssue("play-started", { name });
    if (name === "end") {
      fallbackTimer = setTimeout(finishEndSound, getSoundFallbackMs(audio));
    }
  } catch (error) {
    if (audio) {
      activeSounds.delete(audio);
    }
    reportSoundIssue("play-failed", {
      name,
      message: error.message || String(error),
    });
    finishEndSound();
  }
}

function initSounds() {
  soundTasks.start = loadSound("start", soundUrls.start);
  soundTasks.end = loadSound("end", soundUrls.end);
  Promise.all(Object.values(soundTasks)).then((results) => {
    reportSoundIssue("preload-complete", {
      ready: Object.keys(soundPool),
      failed: results.filter((item) => !item).length,
    });
  });
}

initSounds();

// --- App state ---
const state = {
  finalText: "",
  partialText: "",
  hintText: "",
  hintLevel: "info",
  hintVariant: "text",
  appState: "idle",
  audioReady: false,
  mediaStream: null,
  audioContext: null,
  sourceNode: null,
  processorNode: null,
  analyserNode: null,
  audioInputTimer: 0,
  inputSignalDetected: false,
  inputSignalFrames: 0,
  maxInputRms: 0,
  maxInputPeak: 0,
  audioInputMissingReported: false,
  pendingSamples: [],
  layoutWidth: 0,
  layoutWrap: false,
  renderedWidth: 0,
  waveBarHeights: [],
  smoothedLevel: 0,
};

const elements = {
  stage: document.getElementById("stage"),
  bubble: document.getElementById("bubble"),
  finalText: document.getElementById("finalText"),
  partialText: document.getElementById("partialText"),
  hint: document.getElementById("hint"),
  hintLabel: document.getElementById("hintLabel"),
  transcript: document.getElementById("transcript"),
  measureText: document.getElementById("measureText"),
  statusBars: document.getElementById("statusBars"),
};

const statusBarItems = elements.statusBars
  ? Array.from(elements.statusBars.querySelectorAll(".status-bar"))
  : [];

// --- Waveform animation ---
let waveformRaf = 0;

function startWaveformAnimation() {
  const analyser = state.analyserNode;
  if (!analyser || statusBarItems.length === 0) return;

  const sampleCount = analyser.fftSize;
  const data = new Float32Array(sampleCount);
  const centerIndex = (statusBarItems.length - 1) / 2;
  const maxDistance = Math.max(1, centerIndex);

  function tick() {
    analyser.getFloatTimeDomainData(data);
    let sumSquares = 0;
    let peak = 0;
    for (let i = 0; i < sampleCount; i += 1) {
      const sample = data[i];
      sumSquares += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    const rms = Math.sqrt(sumSquares / sampleCount);
    const boostedLevel = Math.min(1, (rms * 13 + peak * 2.8) ** 0.82);
    const targetLevel = boostedLevel < 0.035 ? 0 : boostedLevel;
    state.smoothedLevel += (targetLevel - state.smoothedLevel) * 0.14;

    statusBarItems.forEach((bar, index) => {
      const distance = Math.abs(index - centerIndex);
      const centerWeight = 0.22 + (1 - distance / maxDistance) ** 1.7 * 0.78;
      const targetHeight = 3 + state.smoothedLevel * centerWeight * 20;
      const currentHeight = state.waveBarHeights[index] ?? targetHeight;
      const height = currentHeight + (targetHeight - currentHeight) * 0.18;
      state.waveBarHeights[index] = height;
      bar.style.height = `${Math.round(Math.max(3, Math.min(18, height)))}px`;
      bar.style.transform = "scaleY(1)";
    });
    elements.statusBars.dataset.active = "true";
    waveformRaf = requestAnimationFrame(tick);
  }

  waveformRaf = requestAnimationFrame(tick);
}

function stopWaveformAnimation() {
  if (waveformRaf) {
    cancelAnimationFrame(waveformRaf);
    waveformRaf = 0;
  }
  if (elements.statusBars) {
    elements.statusBars.dataset.active = "false";
  }
  statusBarItems.forEach((bar) => {
    bar.style.height = "";
    bar.style.transform = "";
  });
  state.waveBarHeights = [];
  state.smoothedLevel = 0;
}

function isCapturingAudioInput() {
  return state.appState === "connecting" || state.appState === "recording";
}

function clearAudioInputTimer() {
  if (!state.audioInputTimer) {
    return;
  }
  clearTimeout(state.audioInputTimer);
  state.audioInputTimer = 0;
}

function resetAudioInputMonitor() {
  clearAudioInputTimer();
  state.inputSignalDetected = false;
  state.inputSignalFrames = 0;
  state.maxInputRms = 0;
  state.maxInputPeak = 0;
  state.audioInputMissingReported = false;
}

function getAudioTrackLabel() {
  return state.mediaStream?.getAudioTracks?.()[0]?.label || "system";
}

function hasObservedAudioSignal() {
  return (
    state.inputSignalFrames >= AUDIO_INPUT_REQUIRED_FRAMES ||
    state.maxInputRms >= AUDIO_INPUT_MIN_RMS ||
    state.maxInputPeak >= AUDIO_INPUT_MIN_PEAK
  );
}

function markAudioInputDetected(type = "audio:input-detected") {
  if (state.inputSignalDetected) {
    return;
  }

  state.inputSignalDetected = true;
  clearAudioInputTimer();
  window.voiceOverlay.sendDiagnostic({
    type,
    deviceLabel: getAudioTrackLabel(),
    maxRms: Number(state.maxInputRms.toFixed(6)),
    maxPeak: Number(state.maxInputPeak.toFixed(6)),
  });
}

function reportAudioInputMissing() {
  clearAudioInputTimer();
  if (state.audioInputMissingReported || state.inputSignalDetected || !isCapturingAudioInput()) {
    return;
  }

  if (hasObservedAudioSignal()) {
    markAudioInputDetected("audio:input-detected-at-timeout");
    return;
  }

  state.audioInputMissingReported = true;
  window.voiceOverlay.sendAudioInputMissing({
    message: AUDIO_INPUT_MISSING_MESSAGE,
    deviceLabel: getAudioTrackLabel(),
    maxRms: Number(state.maxInputRms.toFixed(6)),
    maxPeak: Number(state.maxInputPeak.toFixed(6)),
  });
  state.hintText = AUDIO_INPUT_MISSING_MESSAGE;
  state.hintLevel = "error";
  state.hintVariant = "text";
  updateView();
}

function armAudioInputMonitor() {
  clearAudioInputTimer();
  if (state.inputSignalDetected || state.audioInputMissingReported || !state.mediaStream) {
    return;
  }
  state.audioInputTimer = setTimeout(reportAudioInputMissing, AUDIO_INPUT_CHECK_MS);
}

function observeAudioInput(inputData) {
  let sumSquares = 0;
  let peak = 0;

  for (let index = 0; index < inputData.length; index += 1) {
    const sample = inputData[index];
    sumSquares += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }

  const rms = Math.sqrt(sumSquares / inputData.length);
  state.maxInputRms = Math.max(state.maxInputRms, rms);
  state.maxInputPeak = Math.max(state.maxInputPeak, peak);

  if (rms >= AUDIO_INPUT_MIN_RMS || peak >= AUDIO_INPUT_MIN_PEAK) {
    state.inputSignalFrames += 1;
  }

  if (!state.inputSignalDetected && hasObservedAudioSignal()) {
    markAudioInputDetected();
  }
}

function normalizeAudioCaptureError(error) {
  const name = error?.name || "";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "未检测到麦克风，请检查设备连接";
  }
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "无法获取麦克风权限";
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return "麦克风被占用或不可用";
  }
  return error?.message || "音频设备初始化失败";
}

function getVisibleHintText() {
  if (state.hintLevel === "error" && state.hintText) {
    return state.hintText;
  }

  const visualState =
    state.appState === "recording" && !state.audioReady ? "connecting" : state.appState;

  if (visualState === "connecting") {
    return "Preparing";
  }

  if (visualState === "finishing" && state.hintVariant === "progress") {
    return "Thinking";
  }

  return state.hintText || "";
}

function shouldShowHint() {
  return Boolean(getVisibleHintText());
}

let resizeRaf = 0;

function scheduleResize() {
  if (resizeRaf) {
    cancelAnimationFrame(resizeRaf);
  }

  resizeRaf = requestAnimationFrame(() => {
    const hasText = Boolean(state.finalText || state.partialText);
    const hintText = getVisibleHintText();
    const hasHint = Boolean(hintText);
    const shouldMeasureHintOnly = hasHint;

    if (!hasText && !hasHint) {
      elements.bubble.style.width = "";
      state.renderedWidth = 0;
      elements.bubble.dataset.wrap = "single";
      return;
    }

    let measuredWidth = 0;
    if (hasText && !shouldMeasureHintOnly) {
      const visibleText = `${state.finalText}${state.partialText}`.trim();
      elements.measureText.textContent = visibleText;
      measuredWidth = Math.ceil(elements.measureText.getBoundingClientRect().width);
    }

    let hintWidth = 0;
    if (hasHint) {
      elements.measureText.textContent = hintText;
      hintWidth = Math.ceil(elements.measureText.getBoundingClientRect().width);
    }

    const horizontalPadding = 16;
    const borderWidth = 2;
    const singleLineLimit = 520;
    const multiLineWidth = 520;
    const lockLayout =
      !shouldMeasureHintOnly && (state.appState === "recording" || state.appState === "finishing");
    const shouldWrap =
      !shouldMeasureHintOnly && (state.layoutWrap || measuredWidth > singleLineLimit);
    const textWidth = Math.max(measuredWidth, hintWidth);
    const nextWidth = shouldWrap
      ? multiLineWidth + horizontalPadding + borderWidth
      : Math.min(
          singleLineLimit + horizontalPadding + borderWidth,
          Math.max(116, textWidth + horizontalPadding + borderWidth),
        );

    if (!lockLayout) {
      state.layoutWidth = nextWidth;
      state.layoutWrap = shouldWrap;
    } else {
      state.layoutWidth = Math.max(state.layoutWidth || 0, nextWidth);
      state.layoutWrap = state.layoutWrap || shouldWrap;
    }

    elements.bubble.dataset.wrap = state.layoutWrap ? "multi" : "single";

    const width = state.layoutWidth || nextWidth;

    if (width === state.renderedWidth) {
      return;
    }

    state.renderedWidth = width;
    elements.bubble.style.width = `${width}px`;
  });
}

function scrollTranscriptToBottom() {
  requestAnimationFrame(() => {
    elements.transcript.scrollTop = elements.transcript.scrollHeight;
  });
}

function updateView() {
  const visualState =
    state.appState === "recording" && !state.audioReady ? "connecting" : state.appState;
  const hintText = getVisibleHintText();
  const hasHint = Boolean(hintText);
  const showTranscript = !hasHint;
  const showWaveform = visualState === "recording" && !hasHint;

  elements.stage.dataset.state = visualState;
  elements.stage.dataset.mode = hasHint ? "hint" : "transcript";
  elements.finalText.textContent = showTranscript ? state.finalText : "";
  elements.partialText.textContent = showTranscript ? state.partialText : "";
  if (showTranscript) {
    scrollTranscriptToBottom();
  }
  elements.hintLabel.textContent = getVisibleHintText();
  elements.hint.dataset.visible = shouldShowHint() ? "true" : "false";
  elements.hint.dataset.level = state.hintLevel;
  elements.hint.dataset.variant =
    visualState === "connecting" ||
    (visualState === "finishing" && state.hintVariant === "progress")
      ? "progress"
      : state.hintVariant;
  if (elements.statusBars) {
    elements.statusBars.dataset.active = showWaveform
      ? elements.statusBars.dataset.active
      : "false";
  }
  scheduleResize();
}

function resetState() {
  state.finalText = "";
  state.partialText = "";
  state.hintText = "";
  state.hintLevel = "info";
  state.hintVariant = "text";
  state.audioReady = false;
  resetAudioInputMonitor();
  state.layoutWidth = 0;
  state.layoutWrap = false;
  state.renderedWidth = 0;
  elements.bubble.style.width = "";
  updateView();
}

function floatTo16BitPCM(float32Array) {
  const buffer = new Int16Array(float32Array.length);

  for (let index = 0; index < float32Array.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, float32Array[index]));
    buffer[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return buffer;
}

function downsampleBuffer(buffer, inputSampleRate, outputSampleRate) {
  if (outputSampleRate === inputSampleRate) {
    return buffer;
  }

  const sampleRateRatio = inputSampleRate / outputSampleRate;
  const newLength = Math.round(buffer.length / sampleRateRatio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    let accum = 0;
    let count = 0;

    for (let index = offsetBuffer; index < nextOffsetBuffer && index < buffer.length; index += 1) {
      accum += buffer[index];
      count += 1;
    }

    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }

  return result;
}

function int16ToBase64(int16Array) {
  const uint8Array = new Uint8Array(int16Array.buffer);
  let binary = "";

  for (let index = 0; index < uint8Array.length; index += 1) {
    binary += String.fromCharCode(uint8Array[index]);
  }

  return btoa(binary);
}

function flushPendingAudio(force = false) {
  const targetChunkSize = 1600;

  if (!state.inputSignalDetected || state.audioInputMissingReported) {
    if (force) {
      state.pendingSamples = [];
    }
    return;
  }

  while (
    state.pendingSamples.length >= targetChunkSize ||
    (force && state.pendingSamples.length > 0)
  ) {
    const chunkSize = force
      ? Math.min(state.pendingSamples.length, targetChunkSize)
      : targetChunkSize;
    const chunk = state.pendingSamples.splice(0, chunkSize);
    const pcm16 = floatTo16BitPCM(new Float32Array(chunk));
    const base64Chunk = int16ToBase64(pcm16);

    if (!state.audioReady) {
      state.audioReady = true;
      updateView();
    }

    window.voiceOverlay.sendAudioChunk(base64Chunk).catch(() => {
      state.hintText = "音频发送失败";
      state.hintLevel = "error";
      state.hintVariant = "text";
      updateView();
    });

    if (force) {
      break;
    }
  }
}

async function startAudioCapture() {
  if (state.mediaStream) {
    return;
  }

  window.voiceOverlay.sendDiagnostic({
    type: "audio:capture-starting",
  });

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      noiseSuppression: true,
      echoCancellation: true,
    },
    video: false,
  });

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AudioContextCtor();
  const sourceNode = audioContext.createMediaStreamSource(stream);
  const processorNode = audioContext.createScriptProcessor(4096, 1, 1);
  state.pendingSamples = [];
  state.audioReady = false;
  resetAudioInputMonitor();

  processorNode.onaudioprocess = (event) => {
    if (!isCapturingAudioInput() || state.audioInputMissingReported) {
      return;
    }

    const inputData = event.inputBuffer.getChannelData(0);
    observeAudioInput(inputData);

    if (state.appState !== "recording" || !state.inputSignalDetected) {
      return;
    }

    const downsampled = downsampleBuffer(inputData, audioContext.sampleRate, 16000);

    for (let index = 0; index < downsampled.length; index += 1) {
      state.pendingSamples.push(downsampled[index]);
    }

    flushPendingAudio(false);
  };

  const analyserNode = audioContext.createAnalyser();
  analyserNode.fftSize = 256;
  analyserNode.smoothingTimeConstant = 0.55;

  sourceNode.connect(analyserNode);
  analyserNode.connect(processorNode);
  processorNode.connect(audioContext.destination);

  state.mediaStream = stream;
  state.audioContext = audioContext;
  state.sourceNode = sourceNode;
  state.processorNode = processorNode;
  state.analyserNode = analyserNode;
  if (state.appState === "recording") {
    armAudioInputMonitor();
  }

  window.voiceOverlay.sendDiagnostic({
    type: "audio:capture-started",
    sampleRate: audioContext.sampleRate,
    deviceLabel: getAudioTrackLabel(),
  });
}

async function stopAudioCapture(options = {}) {
  const inputSignalDetected = state.inputSignalDetected;
  const shouldFlush =
    options.discardAudio !== true && inputSignalDetected && !state.audioInputMissingReported;

  clearAudioInputTimer();
  stopWaveformAnimation();
  if (shouldFlush) {
    flushPendingAudio(true);
  } else {
    state.pendingSamples = [];
  }

  if (state.analyserNode) {
    state.analyserNode.disconnect();
    state.analyserNode = null;
  }

  if (state.processorNode) {
    state.processorNode.disconnect();
    state.processorNode.onaudioprocess = null;
    state.processorNode = null;
  }

  if (state.sourceNode) {
    state.sourceNode.disconnect();
    state.sourceNode = null;
  }

  if (state.mediaStream) {
    for (const track of state.mediaStream.getTracks()) {
      track.stop();
    }
    state.mediaStream = null;
  }

  if (state.audioContext) {
    await state.audioContext.close();
    state.audioContext = null;
  }

  state.pendingSamples = [];
  resetAudioInputMonitor();
  return { inputSignalDetected };
}

window.voiceOverlay.onEvent(async ({ type, payload }) => {
  switch (type) {
    case "reset":
      resetState();
      break;
    case "state":
      state.appState = payload.state;
      if (payload.state === "idle" || payload.state === "connecting") {
        state.audioReady = false;
      }
      if (payload.state === "recording") {
        void playSound("start");
        startWaveformAnimation();
        armAudioInputMonitor();
      }
      if (
        payload.state === "idle" ||
        payload.state === "connecting" ||
        payload.state === "recording" ||
        payload.state === "finishing"
      ) {
        if (state.hintLevel === "info") {
          state.hintText = "";
          state.hintVariant = "text";
        }
      }
      updateView();
      break;
    case "audio:warmup":
      try {
        state.audioReady = false;
        await startAudioCapture();
        window.voiceOverlay.sendAudioWarmupReady();
      } catch (error) {
        const message = normalizeAudioCaptureError(error);
        window.voiceOverlay.sendAudioWarmupFailed({
          message,
        });
        state.hintText = message;
        state.hintLevel = "error";
        state.hintVariant = "text";
        updateView();
      }
      break;
    case "recording:start":
      try {
        state.audioReady = false;
        await startAudioCapture();
        startWaveformAnimation();
        state.hintText = "";
        state.hintLevel = "info";
        state.hintVariant = "text";
      } catch (error) {
        const message = normalizeAudioCaptureError(error);
        window.voiceOverlay.sendDiagnostic({
          type: "audio:capture-failed",
          message,
        });
        state.hintText = message;
        state.hintLevel = "error";
        state.hintVariant = "text";
      }
      updateView();
      break;
    case "recording:stop":
      {
        const result = await stopAudioCapture({
          discardAudio: payload?.discardAudio === true,
        });
        window.voiceOverlay.notifyAudioStopped(result);
      }
      break;
    case "transcript":
      state.finalText = payload.finalText || "";
      state.partialText = payload.partialText || "";
      updateView();
      break;
    case "hint":
      state.hintText = payload.text || "";
      state.hintLevel = payload.level || "info";
      state.hintVariant = payload.variant || "text";
      updateView();
      break;
    case "paste:done":
      void playSound("end");
      break;
    case "config":
      soundConfig = normalizeSoundConfig(payload?.sounds);
      break;
    default:
      break;
  }
});

window.addEventListener("beforeunload", () => {
  stopAudioCapture();
});

function hexToRgb(hex) {
  const clean = String(hex || "").replace(/^#/, "");
  const full = clean.length === 3 ? clean.replace(/./g, (c) => c + c) : clean;
  const r = Number.parseInt(full.slice(0, 2), 16);
  const g = Number.parseInt(full.slice(2, 4), 16);
  const b = Number.parseInt(full.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return "0, 0, 0";
  return `${r}, ${g}, ${b}`;
}

function applyOverlayAppearance(overlay) {
  if (!overlay) return;
  const root = document.documentElement;

  const bgRgb = hexToRgb(overlay.background_color);
  const bgOpacity = Number.isFinite(overlay.background_opacity) ? overlay.background_opacity : 0.68;
  root.style.setProperty("--bubble-bg", `rgba(${bgRgb}, ${bgOpacity})`);

  root.style.setProperty("--bubble-border", overlay.border_color || "#8e8e93");
  root.style.setProperty("--bubble-border-width", `${overlay.border_width ?? 1}px`);
  root.style.setProperty("--bubble-border-radius", `${overlay.border_radius ?? 16}px`);
  root.style.setProperty("--bubble-max-width", `${overlay.max_width ?? 680}px`);

  root.style.setProperty("--text", overlay.text_color || "#ffffff");

  const partialRgb = hexToRgb(overlay.partial_text_color);
  const partialOpacity = Number.isFinite(overlay.partial_text_opacity)
    ? overlay.partial_text_opacity
    : 0.58;
  root.style.setProperty("--partial-text", `rgba(${partialRgb}, ${partialOpacity})`);

  root.style.setProperty("--waveform", overlay.waveform_color || "#000000");

  const quoteFontFamily = (fontFamily) => `"${String(fontFamily).replace(/"/g, '\\"')}"`;
  const fontFamily = overlay.font_family
    ? `${quoteFontFamily(overlay.font_family)}, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif`
    : '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans CJK SC", Arial, system-ui, sans-serif';
  root.style.setProperty("--transcript-font-family", fontFamily);
  root.style.setProperty("--transcript-font-size", `${overlay.font_size ?? 16}px`);
  root.style.setProperty("--transcript-font-weight", String(overlay.font_weight ?? 500));
}

window.voiceOverlay.getConfig().then((config) => {
  soundConfig = normalizeSoundConfig(config?.sounds);
  applyOverlayAppearance(config?.overlay);
  updateView();
});

window.voiceOverlay.onAppearanceChanged((appearance) => {
  applyOverlayAppearance(appearance);
});
