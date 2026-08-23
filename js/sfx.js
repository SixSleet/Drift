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


function tone({ freq = 440, to = null, dur = 0.24, type = 'sine', gain = 0.12,
                delay = 0, cutoff = 2600, attack = 0.02 } = {}) {
  const c = ensure();
  if (!c) return;
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const lp = c.createBiquadFilter();
  const env = c.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur * 0.9);

  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(cutoff, t0);
  lp.Q.setValueAtTime(0.6, t0);

  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  osc.connect(lp).connect(env).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.04);
}

/** A note plus a quiet octave above -- reads as a bell rather than a tone. */
function chime({ freq, dur = 0.5, gain = 0.11, delay = 0 }) {
  tone({ freq, dur, type: 'sine', gain, delay, cutoff: 3400, attack: 0.012 });
  tone({ freq: freq * 2, dur: dur * 0.6, type: 'sine', gain: gain * 0.32, delay, cutoff: 5200 });
  tone({ freq: freq * 3.01, dur: dur * 0.3, type: 'sine', gain: gain * 0.12, delay, cutoff: 6000 });
}

// C major pentatonic -- no semitone clashes, so overlapping cues never sour.
const PENTA = [523.25, 587.33, 659.25, 783.99, 880.00, 1046.50, 1174.66, 1318.51];

export const sfx = {
  get muted() { return muted; },

  toggleMute() {
    muted = !muted;
    try { localStorage.setItem(STORE_KEY, muted ? '1' : '0'); } catch { /* private mode */ }
    if (!muted) this.type();
    return muted;
  },

  /** A single keystroke. Soft and short -- this fires dozens of times a
      round, so it has to sit under the music rather than on top of it. */
  type() {
    tone({ freq: 1050, dur: 0.055, type: 'sine', gain: 0.035, cutoff: 1800, attack: 0.004 });
  },

  /** A tile flipping. Pitched by tier, and all three sit in the same
      pentatonic set so a row of mixed results still sounds like a phrase. */
  reveal(tier) {
    if (tier === 'hit') chime({ freq: 1046.50, dur: 0.42, gain: 0.1 });
    else if (tier === 'present') chime({ freq: 783.99, dur: 0.36, gain: 0.085 });
    else tone({ freq: 330, to: 262, dur: 0.16, type: 'sine', gain: 0.05, cutoff: 900 });
  },

  /** Guess rejected. A soft muted thud, not a buzzer. */
  invalid() {
    tone({ freq: 196, to: 147, dur: 0.2, type: 'triangle', gain: 0.09, cutoff: 700, attack: 0.01 });
  },

  /** Someone else's guess landing (co-op shared board). */
  teammateGuess() {
    chime({ freq: 587.33, dur: 0.28, gain: 0.055 });
  },

  countdown() {
    chime({ freq: 659.25, dur: 0.3, gain: 0.075 });
  },

  go() {
    chime({ freq: 880, dur: 0.5, gain: 0.11 });
    chime({ freq: 1318.51, dur: 0.42, gain: 0.06, delay: 0.07 });
  },

  solved() {
    [659.25, 880, 1318.51].forEach((f, i) => chime({ freq: f, dur: 0.6, gain: 0.11, delay: i * 0.09 }));
  },

  /** Falls rather than buzzes -- disappointment, not an error. */
  lost() {
    [587.33, 493.88, 392].forEach((f, i) =>
      tone({ freq: f, dur: 0.42, type: 'sine', gain: 0.085, delay: i * 0.13, cutoff: 1300, attack: 0.03 }));
  },

  win() {
    PENTA.slice(0, 5).forEach((f, i) => chime({ freq: f, dur: 0.75, gain: 0.115, delay: i * 0.1 }));
    chime({ freq: PENTA[5], dur: 1.1, gain: 0.13, delay: 0.55 });
  },

  /** A round's random event, announced at round start. One stinger per kind. */
  event(kind) {
    if (kind === 'double_points') {
      [659.25, 880, 1046.50, 1318.51].forEach((f, i) =>
        chime({ freq: f, dur: 0.45, gain: 0.1, delay: i * 0.07 }));
    } else if (kind === 'blitz') {
      [1046.50, 880, 1046.50, 880, 1174.66].forEach((f, i) =>
        tone({ freq: f, dur: 0.11, type: 'triangle', gain: 0.1, delay: i * 0.075, cutoff: 2400 }));
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
        tone({ freq: PENTA[i % PENTA.length], dur: 0.06, type: 'triangle',
               gain: 0.06, delay: i * 0.035, cutoff: 2600 });
      }
      PENTA.forEach((f, i) => chime({ freq: f, dur: 0.5, gain: 0.12, delay: 0.4 + i * 0.065 }));
      chime({ freq: PENTA[7] * 2, dur: 1.4, gain: 0.1, delay: 0.95 });
    }
  },

  /** A guess that landed zero hits -- a dud, "not even one." */
  whiff() {
    tone({ freq: 262, to: 131, dur: 0.34, type: 'triangle', gain: 0.1, cutoff: 800, attack: 0.015 });
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

  /**
   * A moth blundering around the lamp.
   *
   * The first version modulated a continuous band of noise with a 14 Hz
   * square LFO, which is amplitude-modulated hiss -- it read as static, not
   * as an insect. A wingbeat is a *discrete* event: a ~14 ms papery tap.
   * So this schedules the taps individually, jittered in spacing, level and
   * brightness, because a moth stalls and surges rather than beating like a
   * metronome. A swell over the whole burst carries it past the lamp and
   * away again.
   */
  mothFlutter() {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime;
    const beats = 16;
    let t = t0;
    for (let i = 0; i < beats; i++) {
      // Louder in the middle of the pass, quieter at either end.
      const swell = Math.sin((i / (beats - 1)) * Math.PI);
      const src = noise(c);
      const bp = c.createBiquadFilter();
      const env = c.createGain();
      const tap = 0.014 + Math.random() * 0.008;

      bp.type = 'bandpass';
      // Papery, and a touch brighter on the harder beats.
      bp.frequency.setValueAtTime(1250 + Math.random() * 900 + swell * 500, t);
      bp.Q.setValueAtTime(1.7, t);

      const peak = 0.006 + swell * 0.017 * (0.6 + Math.random() * 0.7);
      env.gain.setValueAtTime(0.0001, t);
      env.gain.linearRampToValueAtTime(peak, t + 0.002);
      env.gain.exponentialRampToValueAtTime(0.0001, t + tap);

      src.connect(bp).connect(env).connect(master);
      src.start(t);
      src.stop(t + tap + 0.01);

      // ~13-20 Hz, wandering. Every so often it hesitates for a beat.
      t += (Math.random() < 0.12 ? 0.13 : 0.05 + Math.random() * 0.026);
    }
  },

  /**
   * The phone buzzing face-down on the desk. Two things at once: the motor,
   * a low tone chopped by its own rotation, and the case chattering against
   * the wood. The old version was two square blips, which sounded like a
   * bass note rather than a vibration.
   */
  phoneBuzz() {
    const c = ensure();
    if (!c) return;
    for (let i = 0; i < 2; i++) {
      const t = c.currentTime + i * 0.62;
      const dur = 0.36;

      // Motor: 68 Hz body, gated by a ~29 Hz rotation so it stutters.
      const osc = c.createOscillator();
      const env = c.createGain();
      const chop = c.createOscillator();
      const chopAmt = c.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(68, t);
      osc.frequency.linearRampToValueAtTime(62, t + dur);
      chop.type = 'square';
      chop.frequency.setValueAtTime(29, t);
      chopAmt.gain.setValueAtTime(0.05, t);
      chop.connect(chopAmt).connect(env.gain);
      env.gain.setValueAtTime(0.055, t);
      env.gain.setValueAtTime(0.055, t + dur - 0.05);
      env.gain.linearRampToValueAtTime(0.0001, t + dur);
      osc.connect(env).connect(master);
      osc.start(t); chop.start(t);
      osc.stop(t + dur + 0.02); chop.stop(t + dur + 0.02);

      // Case on wood: a thin dry rattle riding the same gate.
      const src = noise(c);
      const hp = c.createBiquadFilter();
      const renv = c.createGain();
      const rchop = c.createOscillator();
      const rchopAmt = c.createGain();
      hp.type = 'bandpass';
      hp.frequency.setValueAtTime(2100, t);
      hp.Q.setValueAtTime(0.9, t);
      rchop.type = 'square';
      rchop.frequency.setValueAtTime(29, t);
      rchopAmt.gain.setValueAtTime(0.011, t);
      rchop.connect(rchopAmt).connect(renv.gain);
      renv.gain.setValueAtTime(0.011, t);
      renv.gain.linearRampToValueAtTime(0.0001, t + dur);
      src.connect(hp).connect(renv).connect(master);
      src.start(t); rchop.start(t);
      src.stop(t + dur); rchop.stop(t + dur);
    }
  },

  /** Silenced it: the buzz cut off, and the room a little quieter for it. */
  phoneSilence() {
    tone({ freq: PENTA[3], to: PENTA[1], dur: 0.16, type: 'sine', gain: 0.07, cutoff: 1800, attack: 0.004 });
  },

  /** The desk lamp stuttering -- a dry electrical tick. */
  lampBuzz() {
    for (let i = 0; i < 4; i++) {
      blip({ freq: 60 + Math.random() * 40, dur: 0.03, type: 'square', gain: 0.06, delay: i * 0.09 });
    }
    blip({ freq: 120, dur: 0.5, type: 'sawtooth', gain: 0.02, delay: 0.36 });
  },

  /**
   * A lightning strike. A short bright crack, then a low rumble that rolls
   * off over a couple of seconds -- distance is mostly the delay between
   * the two and how much top end survives.
   */
  thunder() {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime;

    const crack = noise(c);
    const cf = c.createBiquadFilter();
    const ce = c.createGain();
    cf.type = 'highpass';
    cf.frequency.setValueAtTime(900, t0);
    ce.gain.setValueAtTime(0.0001, t0);
    ce.gain.exponentialRampToValueAtTime(0.1, t0 + 0.012);
    ce.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.4);
    crack.connect(cf).connect(ce).connect(master);
    crack.start(t0); crack.stop(t0 + 0.45);

    const rumble = noise(c);
    const rf = c.createBiquadFilter();
    const re = c.createGain();
    rf.type = 'lowpass';
    rf.frequency.setValueAtTime(320, t0);
    rf.frequency.exponentialRampToValueAtTime(70, t0 + 2.8);
    re.gain.setValueAtTime(0.0001, t0 + 0.05);
    re.gain.exponentialRampToValueAtTime(0.14, t0 + 0.3);
    re.gain.exponentialRampToValueAtTime(0.0001, t0 + 3.2);
    rumble.connect(rf).connect(re).connect(master);
    rumble.start(t0); rumble.stop(t0 + 3.3);
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
    // Climbs the pentatonic set as it runs out, so the last ten seconds are
    // a rising phrase rather than an increasingly shrill beep.
    const step = Math.min(PENTA.length - 1, Math.max(0, 10 - Math.round(secondsLeft)));
    tone({ freq: PENTA[step], dur: 0.13, type: 'sine',
           gain: secondsLeft <= 3 ? 0.11 : 0.07, cutoff: 2200, attack: 0.008 });
  },
};
