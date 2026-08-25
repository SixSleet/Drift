// Synthesised sound. No audio files: a couple of oscillators and a gain
// envelope per cue, so the whole soundtrack costs nothing to ship.
//
// The context and the buses live in audio.js -- music.js needs the same
// context, and a browser only gives you so many. Everything here lands on
// the SFX bus, which carries its own volume independent of the music bed.
//
// Browsers will not let audio start before a gesture, so the context is
// created lazily on the first sound — by which point the player has tapped
// something.

import { ensureAudio, buses, volume } from './audio.js';

// `ensure()` returns null while muted, which is what every cue below uses as
// its mute check -- keep that contract.
const ensure = ensureAudio;


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
  osc.connect(env).connect(buses.sfx);
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

  osc.connect(band).connect(env).connect(buses.sfx);
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

  osc.connect(lp).connect(env).connect(buses.sfx);
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
  get muted() { return volume.muted; },

  toggleMute() {
    const next = volume.toggleMuted();
    if (!next) this.type();
    return next;
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

  /**
   * The match ending badly. Not a buzzer and not a joke: the same falling
   * shape as `lost()` but longer and lower, so it reads as the end of
   * something rather than one bad guess.
   */
  matchLost() {
    [523.25, 440, 349.23, 261.63].forEach((f, i) =>
      tone({ freq: f, dur: 0.9, type: 'sine', gain: 0.1, delay: i * 0.22,
             cutoff: 1200, attack: 0.05 }));
    tone({ freq: 130.81, dur: 1.6, type: 'sine', gain: 0.07, delay: 0.66,
           cutoff: 500, attack: 0.12 });
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
    } else if (kind === 'deceit') {
      // A phrase that starts sweet and goes wrong: a clean chime, then the
      // same note again a semitone flat under it. Two pitches that close
      // together beat against each other, which is the sound of something
      // being not-quite-right -- exactly what this round is.
      chime({ freq: 659.25, dur: 0.5, gain: 0.1 });
      tone({ freq: 659.25 * 0.943, dur: 0.9, type: 'sine', gain: 0.075,
             cutoff: 1600, attack: 0.06, delay: 0.16 });
      tone({ freq: 440 * 0.943, to: 380, dur: 1.1, type: 'triangle', gain: 0.06,
             cutoff: 1200, attack: 0.1, delay: 0.3 });
    } else if (kind === 'cipher') {
      // Colour draining out: four descending taps with the top end filtered
      // further off each one, ending somewhere flat and toneless.
      [880, 740, 622, 523.25].forEach((f, i) => {
        tone({ freq: f, dur: 0.22, type: 'triangle', gain: 0.085,
               cutoff: 2600 - i * 550, delay: i * 0.13 });
      });
      tone({ freq: 262, dur: 0.7, type: 'sine', gain: 0.05, cutoff: 500, attack: 0.08, delay: 0.5 });
    } else if (kind === 'lockdown') {
      // A bolt going across: a hard mechanical clunk, then a lower one
      // settling into place behind it.
      const c = ensure();
      if (c) {
        const t0 = c.currentTime;
        for (const [at, freq] of [[0, 2000], [0.14, 1500]]) {
          const src = noise(c);
          const bp = c.createBiquadFilter();
          const env = c.createGain();
          bp.type = 'bandpass';
          bp.frequency.setValueAtTime(freq, t0 + at);
          bp.Q.setValueAtTime(1.5, t0 + at);
          env.gain.setValueAtTime(0.15, t0 + at);
          env.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.08);
          src.connect(bp).connect(env).connect(buses.sfx);
          src.start(t0 + at); src.stop(t0 + at + 0.1);
        }
      }
      tone({ freq: 150, to: 70, dur: 0.5, type: 'square', gain: 0.09, cutoff: 400, attack: 0.004, delay: 0.14 });
    } else if (kind === 'head_start') {
      // A gift: one clean rising figure, over almost immediately. Small on
      // purpose -- this is the friendliest thing in the set and does not
      // need a fanfare to land.
      [659.25, 880, 1174.66].forEach((f, i) =>
        chime({ freq: f, dur: 0.5, gain: 0.1, delay: i * 0.09 }));
    }
  },

  /**
   * One row landing in a CIPHER round. The usual per-tile reveal chimes are
   * suppressed there -- they play left to right with a different pitch per
   * tier, so they would announce the exact positions the modifier exists to
   * withhold. This replaces the lot with a single flat, position-free tick.
   */
  cipherRow() {
    tone({ freq: 523.25, dur: 0.14, type: 'triangle', gain: 0.075, cutoff: 1900, attack: 0.006 });
    tone({ freq: 349.23, dur: 0.22, type: 'sine', gain: 0.05, cutoff: 1100, attack: 0.01, delay: 0.06 });
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
    src.connect(lp).connect(env).connect(buses.sfx);
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

      src.connect(bp).connect(env).connect(buses.sfx);
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
      osc.connect(env).connect(buses.sfx);
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
      src.connect(hp).connect(renv).connect(buses.sfx);
      src.start(t); rchop.start(t);
      src.stop(t + dur); rchop.stop(t + dur);
    }
  },

  /** Silenced it: the buzz cut off, and the room a little quieter for it. */
  phoneSilence() {
    tone({ freq: PENTA[3], to: PENTA[1], dur: 0.16, type: 'sine', gain: 0.07, cutoff: 1800, attack: 0.004 });
  },

  /** Paper moving through air: a soft band of noise that swells and passes. */
  paperGlide() {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime;
    const dur = 2.4;
    const src = noise(c);
    const bp = c.createBiquadFilter();
    const env = c.createGain();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(700, t0);
    bp.frequency.linearRampToValueAtTime(1500, t0 + dur * 0.5);
    bp.frequency.linearRampToValueAtTime(600, t0 + dur);
    bp.Q.setValueAtTime(1.1, t0);
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(0.016, t0 + dur * 0.45);
    env.gain.linearRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp).connect(env).connect(buses.sfx);
    src.start(t0); src.stop(t0 + dur + 0.05);
  },

  /** Caught it. A paper crumple: a fast rattle of tiny broadband ticks. */
  paperCatch() {
    const c = ensure();
    if (!c) return;
    let t = c.currentTime;
    for (let i = 0; i < 14; i++) {
      const src = noise(c);
      const hp = c.createBiquadFilter();
      const env = c.createGain();
      hp.type = 'highpass';
      hp.frequency.setValueAtTime(1400 + Math.random() * 1800, t);
      env.gain.setValueAtTime(0.0001, t);
      env.gain.linearRampToValueAtTime(0.014 * (1 - i / 18), t + 0.001);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
      src.connect(hp).connect(env).connect(buses.sfx);
      src.start(t); src.stop(t + 0.03);
      t += 0.008 + Math.random() * 0.018;
    }
  },

  /** The monitor browning out: the coil whine dips and comes back. */
  powerDip() {
    tone({ freq: 240, to: 90, dur: 0.35, type: 'sawtooth', gain: 0.045, cutoff: 900, attack: 0.006 });
    tone({ freq: 90, to: 250, dur: 0.4, type: 'sawtooth', gain: 0.035, cutoff: 1100, delay: 0.55 });
    tone({ freq: 62, dur: 0.5, type: 'sine', gain: 0.05, cutoff: 200, attack: 0.01 });
  },

  /** Fist on plasterboard. Low, dead, and over immediately. */
  wallBang() {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime;
    for (let i = 0; i < 2; i++) {
      const t = t0 + i * 0.19;
      tone({ freq: 96, to: 54, dur: 0.16, type: 'sine', gain: 0.13, cutoff: 260,
             attack: 0.003, delay: i * 0.19 });
      const src = noise(c);
      const lp = c.createBiquadFilter();
      const env = c.createGain();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(500, t);
      env.gain.setValueAtTime(0.05, t);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      src.connect(lp).connect(env).connect(buses.sfx);
      src.start(t); src.stop(t + 0.12);
    }
  },

  /**
   * A spider paying out silk. There is no real sound to copy here, so this
   * is the *idea* of one: a very quiet descending band of noise, which is
   * the shape your ear expects for something lowering itself.
   */
  silkDrop() {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime;
    const dur = 1.6;
    const src = noise(c);
    const bp = c.createBiquadFilter();
    const env = c.createGain();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(2600, t0);
    bp.frequency.exponentialRampToValueAtTime(700, t0 + dur);
    bp.Q.setValueAtTime(4, t0);
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(0.012, t0 + 0.2);
    env.gain.linearRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp).connect(env).connect(buses.sfx);
    src.start(t0); src.stop(t0 + dur + 0.05);
  },

  /** Poked. The same idea in reverse, and quicker. */
  silkRetreat() {
    tone({ freq: 900, to: 2400, dur: 0.22, type: 'sine', gain: 0.045, cutoff: 4200, attack: 0.005 });
  },

  /**
   * A small bird outside. Two or three notes, high and short, each one a
   * quick rise and fall -- a chirp is a gesture rather than a pitch, and a
   * plain beep at the same frequency sounds like a microwave.
   */
  birdChirp() {
    const notes = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < notes; i++) {
      const base = 2300 + Math.random() * 900;
      const delay = i * (0.1 + Math.random() * 0.07);
      tone({ freq: base, to: base * 1.5, dur: 0.045, type: 'sine',
             gain: 0.028, cutoff: 7000, attack: 0.004, delay });
      tone({ freq: base * 1.5, to: base * 0.85, dur: 0.05, type: 'sine',
             gain: 0.022, cutoff: 7000, attack: 0.004, delay: delay + 0.042 });
    }
  },

  /** A picture frame settling crooked: a short dry wood creak. */
  frameCreak() {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime;
    const src = noise(c);
    const bp = c.createBiquadFilter();
    const env = c.createGain();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(900, t0);
    bp.frequency.exponentialRampToValueAtTime(420, t0 + 0.3);
    bp.Q.setValueAtTime(3.5, t0);
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(0.045, t0 + 0.03);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.32);
    src.connect(bp).connect(env).connect(buses.sfx);
    src.start(t0); src.stop(t0 + 0.35);
  },

  /** A single, very quiet firefly twinkle -- barely there on purpose. */
  fireflyTwinkle() {
    const base = 1800 + Math.random() * 900;
    chime({ freq: base, dur: 0.5, gain: 0.028 });
  },

  /**
   * Headlights sweeping past outside: a car passing at speed, heard through
   * a wall rather than seen -- a band of noise that rises then falls away,
   * with the pitch drifting down through it the way an engine does as it
   * passes and recedes (the poor man's Doppler shift).
   */
  headlightPass() {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime;
    const dur = 2.2;
    const src = noise(c);
    const bp = c.createBiquadFilter();
    const env = c.createGain();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(280, t0);
    bp.frequency.linearRampToValueAtTime(520, t0 + dur * 0.4);
    bp.frequency.linearRampToValueAtTime(160, t0 + dur);
    bp.Q.setValueAtTime(0.8, t0);
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(0.05, t0 + dur * 0.35);
    env.gain.linearRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp).connect(env).connect(buses.sfx);
    src.start(t0); src.stop(t0 + dur + 0.05);
  },

  /** A field mouse's startled squeak, plus tiny scampering feet. */
  mouseSqueak() {
    tone({ freq: 2600, to: 1900, dur: 0.09, type: 'triangle', gain: 0.07, cutoff: 6000, attack: 0.003 });
    for (let i = 0; i < 5; i++) {
      blip({ freq: 900 + Math.random() * 500, dur: 0.02, type: 'triangle', gain: 0.04, delay: 0.06 + i * 0.045 });
    }
  },

  /** Shooed: a sharper squeak and a quick scatter of footsteps fleeing. */
  mouseScatter() {
    tone({ freq: 3000, to: 2100, dur: 0.11, type: 'triangle', gain: 0.08, cutoff: 6500, attack: 0.002 });
    for (let i = 0; i < 8; i++) {
      blip({ freq: 800 + Math.random() * 600, dur: 0.016, type: 'triangle', gain: 0.045, delay: i * 0.028 });
    }
  },

  /** A leaf drifting down: a soft, brief papery rustle. */
  leafRustle() {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime;
    const dur = 1.3;
    const src = noise(c);
    const bp = c.createBiquadFilter();
    const env = c.createGain();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1800, t0);
    bp.frequency.linearRampToValueAtTime(1200, t0 + dur);
    bp.Q.setValueAtTime(0.9, t0);
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(0.014, t0 + 0.15);
    env.gain.linearRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp).connect(env).connect(buses.sfx);
    src.start(t0); src.stop(t0 + dur + 0.05);
  },

  /** Caught the leaf: a light, dry tap -- much softer than paperCatch's crumple. */
  leafCatch() {
    chime({ freq: PENTA[4], dur: 0.28, gain: 0.06 });
  },

  /**
   * A breaker tripping: a hard mechanical clack, then everything the room
   * was humming winding down at once. The wind-down is what sells it --
   * silence arriving is more convincing than a noise.
   */
  breakerTrip() {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime;
    // The clack.
    const src = noise(c);
    const bp = c.createBiquadFilter();
    const env = c.createGain();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1800, t0);
    bp.Q.setValueAtTime(1.4, t0);
    env.gain.setValueAtTime(0.16, t0);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.07);
    src.connect(bp).connect(env).connect(buses.sfx);
    src.start(t0); src.stop(t0 + 0.09);
    // Mains hum falling away.
    tone({ freq: 100, to: 24, dur: 1.1, type: 'sawtooth', gain: 0.07, cutoff: 400, attack: 0.005 });
    tone({ freq: 50, to: 14, dur: 1.3, type: 'sine', gain: 0.06, cutoff: 200, attack: 0.005 });
  },

  /** Breaker back up: the clack again, then everything spooling back. */
  breakerReset() {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime;
    const src = noise(c);
    const bp = c.createBiquadFilter();
    const env = c.createGain();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(2200, t0);
    bp.Q.setValueAtTime(1.6, t0);
    env.gain.setValueAtTime(0.14, t0);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.06);
    src.connect(bp).connect(env).connect(buses.sfx);
    src.start(t0); src.stop(t0 + 0.08);
    tone({ freq: 26, to: 100, dur: 0.7, type: 'sawtooth', gain: 0.06, cutoff: 420, attack: 0.01, delay: 0.04 });
    chime({ freq: PENTA[2], dur: 0.4, gain: 0.08, delay: 0.18 });
  },

  /**
   * The bat. The one cue in this app allowed to be unpleasant, so it is
   * built out of the three things that actually make a sound frightening:
   * a broadband transient with no warning, a cluster of close, deliberately
   * dissonant pitches (minor seconds -- the interval a scream lives on),
   * and a sub-bass drop you feel rather than hear.
   *
   * Loud, but still on the effects bus, so the volume slider and mute
   * govern it like everything else.
   */
  screech() {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime;

    // The transient: full-spectrum, instant, no attack at all.
    const hit = noise(c);
    const hp = c.createBiquadFilter();
    const he = c.createGain();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(300, t0);
    he.gain.setValueAtTime(0.34, t0);
    he.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
    hit.connect(hp).connect(he).connect(buses.sfx);
    hit.start(t0); hit.stop(t0 + 0.55);

    // The scream: four sawtooths a semitone apart, sliding down together.
    for (const [i, mult] of [1, 1.06, 1.12, 1.19].entries()) {
      const osc = c.createOscillator();
      const bp = c.createBiquadFilter();
      const env = c.createGain();
      const vib = c.createOscillator();
      const vibAmt = c.createGain();
      const base = 1500 * mult;
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(base, t0);
      osc.frequency.exponentialRampToValueAtTime(base * 0.42, t0 + 0.75);
      vib.type = 'sine';
      vib.frequency.setValueAtTime(38 + i * 9, t0);
      vibAmt.gain.setValueAtTime(base * 0.06, t0);
      vib.connect(vibAmt).connect(osc.frequency);
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(base * 1.4, t0);
      bp.Q.setValueAtTime(2.2, t0);
      env.gain.setValueAtTime(0.11, t0);
      env.gain.setValueAtTime(0.11, t0 + 0.4);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.8);
      osc.connect(bp).connect(env).connect(buses.sfx);
      osc.start(t0); vib.start(t0);
      osc.stop(t0 + 0.85); vib.stop(t0 + 0.85);
    }

    // The drop underneath it.
    tone({ freq: 150, to: 28, dur: 0.9, type: 'sine', gain: 0.22, cutoff: 300, attack: 0.002 });
  },

  /**
   * The desk lamp guttering. One tick per dip, on the same beats the
   * animation dips -- 130, 312, 494, 754, 1092, 1456, 1872 and 2288ms into
   * `lamp-gutter` -- and getting quieter the way the dips get shallower.
   *
   * The rhythm is the whole point. It used to be four evenly spaced ticks
   * regardless of what the picture was doing, so the sound and the light
   * disagreed, and a sound that does not line up with a picture is the
   * clearest signal there is that something has gone wrong with the machine
   * rather than with the lamp.
   */
  lampBuzz() {
    // [when, how hard] -- shallower every time, like the dips.
    const beats = [
      [0.130, 1], [0.312, 0.94], [0.494, 1], [0.754, 0.82],
      [1.092, 0.9], [1.456, 0.6], [1.872, 0.42], [2.288, 0.26],
    ];
    for (const [at, force] of beats) {
      blip({ freq: 58 + Math.random() * 46, dur: 0.028, type: 'square', gain: 0.062 * force, delay: at });
      // The contact arcing back, a hair later than the tick.
      blip({ freq: 1900 + Math.random() * 700, dur: 0.02, type: 'square', gain: 0.012 * force, delay: at + 0.012 });
    }
    // Mains hum underneath the whole thing, loudest while it is worst.
    blip({ freq: 100, dur: 1.5, type: 'sawtooth', gain: 0.016, delay: 0.1 });
    blip({ freq: 50, dur: 2.3, type: 'sawtooth', gain: 0.012, delay: 0.1 });
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
    crack.connect(cf).connect(ce).connect(buses.sfx);
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
    rumble.connect(rf).connect(re).connect(buses.sfx);
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
    src.connect(hp).connect(lp).connect(env).connect(buses.sfx);
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
