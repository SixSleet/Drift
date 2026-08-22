// Synthesised sound. No audio files: everything here is a couple of oscillators
// and a gain envelope, so the whole soundtrack costs nothing to ship.
//
// Browsers will not let audio start before a gesture, so the context is created
// lazily on the first sound — by which point the player has clicked something.

const STORE_KEY = 'drift-muted';

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

/** One enveloped oscillator. Everything below is built out of this. */
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
    if (!muted) this.tick();
    return muted;
  },

  /** Wall and bumper hits. Pitch rises with impact speed. */
  bounce(speed, isBumper) {
    const norm = Math.max(0, Math.min(1, speed / 16));
    blip({
      freq: (isBumper ? 320 : 190) + norm * 260,
      to: (isBumper ? 190 : 120) + norm * 120,
      dur: isBumper ? 0.085 : 0.055,
      type: isBumper ? 'triangle' : 'sine',
      gain: (isBumper ? 0.16 : 0.09) * (0.45 + norm * 0.55),
    });
  },

  nudge() {
    blip({ freq: 180, to: 620, dur: 0.13, type: 'sawtooth', gain: 0.13 });
  },

  tick() {
    blip({ freq: 660, dur: 0.06, type: 'square', gain: 0.09 });
  },

  go() {
    blip({ freq: 520, to: 900, dur: 0.16, type: 'square', gain: 0.13 });
  },

  /** The balls going dark. A drop into something uneasy. */
  blackout() {
    blip({ freq: 420, to: 90, dur: 0.5, type: 'sawtooth', gain: 0.13 });
  },

  /** The freeze, and the three seconds starting. */
  freeze() {
    blip({ freq: 1250, to: 700, dur: 0.16, type: 'square', gain: 0.15 });
    blip({ freq: 700, to: 420, dur: 0.22, type: 'square', gain: 0.11, delay: 0.1 });
  },

  lock() {
    blip({ freq: 880, dur: 0.07, type: 'square', gain: 0.12 });
  },

  /** Reveal, pitched by how well you did. */
  score(tier) {
    if (tier === 'bullseye') {
      [660, 880, 1320].forEach((f, i) =>
        blip({ freq: f, dur: 0.18, type: 'square', gain: 0.15, delay: i * 0.08 }));
    } else if (tier === 'close') {
      [590, 780].forEach((f, i) =>
        blip({ freq: f, dur: 0.15, type: 'triangle', gain: 0.13, delay: i * 0.08 }));
    } else {
      blip({ freq: 220, to: 130, dur: 0.28, type: 'sine', gain: 0.11 });
    }
  },

  streak(n) {
    for (let i = 0; i < Math.min(4, n - 1); i++) {
      blip({ freq: 520 + i * 190, dur: 0.1, type: 'square', gain: 0.12, delay: i * 0.06 });
    }
  },

  fanfare() {
    [523, 659, 784, 1047].forEach((f, i) =>
      blip({ freq: f, dur: 0.3, type: 'triangle', gain: 0.16, delay: i * 0.11 }));
  },
};
