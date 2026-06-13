const STUCK_CHORD_RECOVERY_MS = 1000;
const REPLAYED_CHORD_REFRESH_MS = 80;

function getPressedAt(pressedKeys, keycode) {
  if (!pressedKeys || typeof pressedKeys.get !== "function") {
    return null;
  }

  const pressedAt = pressedKeys.get(keycode);
  return typeof pressedAt === "number" ? pressedAt : null;
}

function wasEveryChordKeyPressedAgain({ keycodes, pressedKeys, chordActiveAt, minRefreshMs }) {
  return keycodes.every((keycode) => {
    const pressedAt = getPressedAt(pressedKeys, keycode);
    return pressedAt !== null && pressedAt - chordActiveAt >= minRefreshMs;
  });
}

function shouldRecoverStuckToggleChord({
  chordActive,
  chordActiveAt,
  now,
  keycodes,
  pressedKeys,
  isChordPressed,
  stuckMs = STUCK_CHORD_RECOVERY_MS,
  minRefreshMs = REPLAYED_CHORD_REFRESH_MS,
}) {
  if (!chordActive || !chordActiveAt || !isChordPressed) {
    return false;
  }

  if (!Array.isArray(keycodes) || keycodes.length === 0) {
    return false;
  }

  if (now - chordActiveAt < stuckMs) {
    return false;
  }

  return wasEveryChordKeyPressedAgain({
    keycodes,
    pressedKeys,
    chordActiveAt,
    minRefreshMs,
  });
}

module.exports = {
  STUCK_CHORD_RECOVERY_MS,
  shouldRecoverStuckToggleChord,
};
