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


let noiseBuf = null;
function noise(c) {
  if (!noiseBuf || noiseBuf.sampleRate !== c.sampleRate) {
    noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  return src;
}

/**
 * A cat's voice is a formant sweep, not a beep: a sawtooth glide through a
 * resonant bandpass, with the filter tracking the pitch. `shape` bends the
 * contour -- a short rising "mrrp", a full rising-then-falling "meow", or a
 * long plaintive one.
 */
function meowVoice({ dur = 0.5, base = 480, peak = 760, gain = 0.14, delay = 0 } = {}) {
  const c = ensure();
  if (!c) return;
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const band = c.createBiquadFilter();
  const env = c.createGain();
  const vib = c.createOscillator();
  const vibAmt = c.createGain();

  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(base, t0);
  osc.frequency.exponentialRampToValueAtTime(peak, t0 + dur * 0.35);
  osc.frequency.exponentialRampToValueAtTime(base * 0.72, t0 + dur);

  // A little wobble is most of what separates "cat" from "synth".
  vib.type = 'sine';
  vib.frequency.setValueAtTime(22, t0);
  vibAmt.gain.setValueAtTime(peak * 0.035, t0);
  vib.connect(vibAmt).connect(osc.frequency);

  band.type = 'bandpass';
  band.Q.setValueAtTime(6, t0);
  band.frequency.setValueAtTime(base * 2.4, t0);
  band.frequency.exponentialRampToValueAtTime(peak * 2.2, t0 + dur * 0.35);
  band.frequency.exponentialRampToValueAtTime(base * 1.6, t0 + dur);

  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(gain, t0 + 0.06);
  env.gain.setValueAtTime(gain, t0 + dur * 0.55);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  osc.connect(band).connect(env).connect(master);
  osc.start(t0); vib.start(t0);
  osc.stop(t0 + dur + 0.05); vib.stop(t0 + dur + 0.05);
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
    } else if (kind === 'letter_swap') {
      // Two quick tones crossing past each other -- a swap, not a reveal.
      blip({ freq: 700, to: 420, dur: 0.16, type: 'triangle', gain: 0.14 });
      blip({ freq: 420, to: 700, dur: 0.16, type: 'triangle', gain: 0.14, delay: 0.05 });
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

  /** The cat announces itself. A real rising-falling meow, not a beep. */
  catMeow() {
    meowVoice({ dur: 0.55, base: 460, peak: 780, gain: 0.15 });
  },

  /** A shorter, chirpier "mrrp" -- the one they do mid-stride. */
  catChirp() {
    meowVoice({ dur: 0.22, base: 560, peak: 880, gain: 0.11 });
  },

  /** Shooed off the desk: an indignant meow plus scampering paws. */
  catShoo() {
    meowVoice({ dur: 0.34, base: 620, peak: 980, gain: 0.16 });
    for (let i = 0; i < 6; i++) {
      blip({ freq: 150 + Math.random() * 90, dur: 0.04, type: 'triangle', gain: 0.07, delay: 0.12 + i * 0.055 });
    }
  },

  /** A contented rumble -- amplitude-modulated low noise, ~25Hz purr rate. */
  catPurr() {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime;
    const dur = 1.4;
    const src = noise(c);
    const lp = c.createBiquadFilter();
    const env = c.createGain();
    const lfo = c.createOscillator();
    const lfoAmt = c.createGain();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(220, t0);
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(25, t0);
    lfoAmt.gain.setValueAtTime(0.05, t0);
    lfo.connect(lfoAmt).connect(env.gain);
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(0.07, t0 + 0.15);
    env.gain.setValueAtTime(0.07, t0 + dur - 0.3);
    env.gain.linearRampToValueAtTime(0.0001, t0 + dur);
    src.connect(lp).connect(env).connect(master);
    src.start(t0); lfo.start(t0);
    src.stop(t0 + dur); lfo.stop(t0 + dur);
  },

  /** A moth blundering around the lamp -- soft, papery wingbeats. */
  mothFlutter() {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime;
    const dur = 1.1;
    const src = noise(c);
    const bp = c.createBiquadFilter();
    const env = c.createGain();
    const lfo = c.createOscillator();
    const lfoAmt = c.createGain();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1700, t0);
    bp.Q.setValueAtTime(1.2, t0);
    lfo.type = 'square';
    lfo.frequency.setValueAtTime(14, t0);   // wingbeat
    lfoAmt.gain.setValueAtTime(0.022, t0);
    lfo.connect(lfoAmt).connect(env.gain);
    env.gain.setValueAtTime(0.024, t0);
    env.gain.linearRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp).connect(env).connect(master);
    src.start(t0); lfo.start(t0);
    src.stop(t0 + dur); lfo.stop(t0 + dur);
  },

  /** The phone buzzing face-down on the desk. */
  phoneBuzz() {
    for (let i = 0; i < 2; i++) {
      const d = i * 0.62;
      blip({ freq: 82, dur: 0.34, type: 'square', gain: 0.09, delay: d });
      blip({ freq: 120, dur: 0.34, type: 'sawtooth', gain: 0.045, delay: d });
    }
  },

  /** Silenced it. */
  phoneSilence() {
    blip({ freq: 420, to: 240, dur: 0.11, type: 'sine', gain: 0.1 });
  },

  /** The desk lamp stuttering -- a dry electrical tick. */
  lampBuzz() {
    for (let i = 0; i < 4; i++) {
      blip({ freq: 60 + Math.random() * 40, dur: 0.03, type: 'square', gain: 0.06, delay: i * 0.09 });
    }
    blip({ freq: 120, dur: 0.5, type: 'sawtooth', gain: 0.02, delay: 0.36 });
  },

  /**
   * Rain against the window. Sustained, so this hands back a stop() the
   * caller owns -- unlike every other cue here, which is fire-and-forget.
   */
  rain(seconds = 20) {
    const c = ensure();
    if (!c) return () => {};
    const t0 = c.currentTime;
    const src = noise(c);
    const lp = c.createBiquadFilter();
    const hp = c.createBiquadFilter();
    const env = c.createGain();
    lp.type = 'lowpass'; lp.frequency.setValueAtTime(2600, t0);
    hp.type = 'highpass'; hp.frequency.setValueAtTime(420, t0);
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(0.045, t0 + 2.5);
    src.connect(hp).connect(lp).connect(env).connect(master);
    src.start(t0);
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      const now = c.currentTime;
      env.gain.cancelScheduledValues(now);
      env.gain.setValueAtTime(env.gain.value, now);
      env.gain.linearRampToValueAtTime(0.0001, now + 2);
      src.stop(now + 2.1);
    };
    setTimeout(stop, seconds * 1000);
    return stop;
  },

  /** The last few seconds of a round's clock. Pitch climbs as it nears zero. */
  tick(secondsLeft) {
    const freq = 500 + (10 - Math.min(10, Math.max(0, secondsLeft))) * 40;
    blip({ freq, dur: 0.05, type: 'square', gain: secondsLeft <= 3 ? 0.16 : 0.1 });
  },
};
