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

  /** A round's random event, announced at round start. One stinger per kind. */
  event(kind) {
    if (kind === 'double_points') {
      [660, 880, 1100, 1320].forEach((f, i) =>
        blip({ freq: f, dur: 0.14, type: 'triangle', gain: 0.14, delay: i * 0.06 }));
    } else if (kind === 'blitz') {
      [900, 700, 900, 700, 900].forEach((f, i) =>
        blip({ freq: f, dur: 0.06, type: 'square', gain: 0.15, delay: i * 0.07 }));
    } else if (kind === 'blackout') {
      // Lights going out: a slow, muffled descent into near-silence.
      blip({ freq: 480, to: 90, dur: 0.6, type: 'sine', gain: 0.16 });
      blip({ freq: 200, to: 60, dur: 0.4, type: 'sine', gain: 0.1, delay: 0.15 });
    } else if (kind === 'shuffle') {
      // A scatter of quick, randomly-pitched clicks -- keys being shuffled.
      for (let i = 0; i < 14; i++) {
        blip({ freq: 300 + Math.random() * 900, dur: 0.03, type: 'triangle', gain: 0.09, delay: i * 0.025 });
      }
    } else if (kind === 'bullseye') {
      // A dart zipping in, then a sharp thud on the target.
      blip({ freq: 260, to: 1200, dur: 0.14, type: 'sawtooth', gain: 0.13 });
      blip({ freq: 140, dur: 0.12, type: 'square', gain: 0.18, delay: 0.14 });
    } else if (kind === 'jackpot') {
      // Slot-machine reel spin-up, an ascending fanfare, then a shimmer tail.
      for (let i = 0; i < 10; i++) {
        blip({ freq: 300 + Math.random() * 500, dur: 0.03, type: 'square', gain: 0.08, delay: i * 0.035 });
      }
      [523, 659, 784, 1047, 1319, 1568].forEach((f, i) =>
        blip({ freq: f, dur: 0.22, type: 'triangle', gain: 0.17, delay: 0.4 + i * 0.07 }));
      [1568, 1976, 2637].forEach((f, i) =>
        blip({ freq: f, to: f * 1.15, dur: 0.5, type: 'sine', gain: 0.1, delay: 0.82 + i * 0.04 }));
    }
  },

  /** A guess that landed zero hits -- a dud, "not even one." */
  whiff() {
    blip({ freq: 220, to: 90, dur: 0.22, type: 'sawtooth', gain: 0.13 });
  },

  /** The last few seconds of a round's clock. Pitch climbs as it nears zero. */
  tick(secondsLeft) {
    const freq = 500 + (10 - Math.min(10, Math.max(0, secondsLeft))) * 40;
    blip({ freq, dur: 0.05, type: 'square', gain: secondsLeft <= 3 ? 0.16 : 0.1 });
  },
};
