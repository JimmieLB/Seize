// Game sound effects (files in public/sounds). Each play uses a fresh copy of a preloaded clip so
// sounds can overlap, and failures (e.g. autoplay not allowed yet) are ignored.

const SOUNDS = {
  myTurn: "/sounds/notif.wav", // it's now your turn
  otherTurn: "/sounds/notif2.wav", // it's now someone else's turn
  explode: "/sounds/explode.wav", // a unit was destroyed
};
const mutedKey = "seize-muted";
const clips = {};

function clip(name) {
  if (typeof Audio === "undefined") return null;
  clips[name] ??= Object.assign(new Audio(SOUNDS[name]), { preload: "auto" });
  return clips[name];
}

/** Starts loading every sound so the first play isn't delayed. */
export function preloadSounds() {
  for (const name of Object.keys(SOUNDS)) clip(name);
}

export function isMuted() {
  try {
    return localStorage.getItem(mutedKey) === "1";
  } catch {
    return false;
  }
}

export function setMuted(muted) {
  try {
    localStorage.setItem(mutedKey, muted ? "1" : "0");
  } catch {
    // Storage unavailable: the setting just won't be remembered.
  }
}

export function playSound(name) {
  if (isMuted()) return;
  const base = clip(name);
  if (!base) return;
  const copy = base.cloneNode();
  copy.volume = 0.7;
  copy.play().catch(() => {});
}
