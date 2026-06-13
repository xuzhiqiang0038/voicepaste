const assert = require("node:assert/strict");
const { shouldRecoverStuckToggleChord } = require("../main/hotkeyRecovery");

function runTests() {
  const keycodes = [29, 57];
  const activatedAt = 1000;

  assert.equal(
    shouldRecoverStuckToggleChord({
      chordActive: true,
      chordActiveAt: activatedAt,
      now: 2400,
      keycodes,
      pressedKeys: new Map([
        [29, 2300],
        [57, 2400],
      ]),
      isChordPressed: true,
    }),
    true,
    "recovers when every hotkey key was pressed again after a stuck chord",
  );

  assert.equal(
    shouldRecoverStuckToggleChord({
      chordActive: true,
      chordActiveAt: activatedAt,
      now: 2400,
      keycodes,
      pressedKeys: new Map([
        [29, 1000],
        [57, 2400],
      ]),
      isChordPressed: true,
    }),
    false,
    "does not recover from a normal key repeat while the modifier is still held",
  );

  assert.equal(
    shouldRecoverStuckToggleChord({
      chordActive: true,
      chordActiveAt: activatedAt,
      now: 1500,
      keycodes,
      pressedKeys: new Map([
        [29, 1450],
        [57, 1500],
      ]),
      isChordPressed: true,
    }),
    false,
    "does not recover before the stuck-chord grace period",
  );
}

runTests();
