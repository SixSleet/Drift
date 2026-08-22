// Synthesised sound. No audio files: a couple of oscillators and a gain
// envelope per cue, so the whole soundtrack costs nothing to ship.
//
// Browsers will not let audio start before a gesture, so the context is
// created lazily on the first sound — by which point the player has tapped
// something.

const STORE_KEY = 'wf-muted';

let ctx = null;
let master = null;
let muted = (() => {
  try { return localStorage.getItem(STORE_KEY) === '1'; } catch { return false; }
})();

function ensure() {
  if (muted) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function blip({ freq = 440, to = null, dur = 0.09, type = 'sine', gain = 0.2, delay = 0 }) {
  const c = ensure();
  if (!c) return;
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const env = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(env).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

export const sfx = {
  get muted() { return muted; },

  toggleMute() {
    muted = !muted;
    try { localStorage.setItem(STORE_KEY, muted ? '1' : '0'); } catch { /* private mode */ }
    if (!muted) this.type();
    return muted;
  },

  /** A single key tap — physical or on-screen, letter or Backspace. */
  type() {
    blip({ freq: 720, dur: 0.035, type: 'square', gain: 0.06 });
  },

  /** A tile flipping to reveal its colour, pitched by tier. */
  reveal(tier) {
    if (tier === 'hit') blip({ freq: 660, to: 880, dur: 0.09, type: 'square', gain: 0.13 });
    else if (tier === 'present') blip({ freq: 520, to: 600, dur: 0.08, type: 'triangle', gain: 0.11 });
    else blip({ freq: 260, to: 180, dur: 0.07, type: 'sine', gain: 0.07 });
  },

  /** Guess rejected: wrong length, or not in the dictionary. */
  invalid() {
    blip({ freq: 180, dur: 0.12, type: 'sawtooth', gain: 0.1 });
  },

  /** Someone else's guess landing (co-op shared board). */
  teammateGuess() {
    blip({ freq: 440, dur: 0.05, type: 'triangle', gain: 0.07 });
  },

  countdown() {
    blip({ freq: 700, dur: 0.06, type: 'square', gain: 0.1 });
  },

  go() {
    blip({ freq: 520, to: 900, dur: 0.16, type: 'square', gain: 0.13 });
  },

  solved() {
    [660, 880, 1320].forEach((f, i) =>
      blip({ freq: f, dur: 0.18, type: 'square', gain: 0.15, delay: i * 0.08 }));
  },

  lost() {
    [400, 300, 200].forEach((f, i) =>
      blip({ freq: f, dur: 0.22, type: 'sawtooth', gain: 0.12, delay: i * 0.1 }));
  },

  win() {
    [523, 659, 784, 1047].forEach((f, i) =>
      blip({ freq: f, dur: 0.3, type: 'triangle', gain: 0.16, delay: i * 0.11 }));
  },
};
