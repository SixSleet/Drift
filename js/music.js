// The soundtrack. Generative, synthesised, and no audio files -- same rule
// as the rest of the sound here.
//
// It is not a loop that plays back. There is a scheduler ticking on a timer,
// and a THEME describing what to build: a tempo, a scale, a chord
// progression, and which layers are switched on. Changing the theme changes
// what gets scheduled from the next bar, so the music follows the game
// rather than being cut and restarted at every transition.
//
// Why generative rather than a written loop: the track has to sit under
// someone concentrating on a word for five minutes at a stretch. A short
// loop announces itself the third time round. A progression walking through
// its chords with a little controlled randomness in the arp stops being
// something you notice and turns into room tone -- which is the whole point.
//
// Scheduling uses the standard lookahead pattern (Chris Wilson, "A Tale of
// Two Clocks"): a setInterval wakes often and queues every note falling
// inside a short window, at sample-accurate times, on the audio clock. Note
// timing never touches setTimeout, so a busy main thread -- a board full of
// tiles flipping -- cannot make the music stutter.

import { audioContext, buses } from './audio.js';

const LOOKAHEAD_MS = 25;    // how often the scheduler wakes
const HORIZON_S = 0.14;     // how far ahead it queues

// ── Notes ────────────────────────────────────────────────────────────────
// Semitones from A4 = 440. Everything below is written in scale degrees, so
// a theme changes key by moving `root` and nothing else has to change.
const hz = (semitonesFromA4) => 440 * Math.pow(2, semitonesFromA4 / 12);

const SCALES = {
  // The cues in sfx.js are all C major pentatonic, so the default bed is
  // too -- a chime landing over the music is always consonant with it.
  penta:   [0, 2, 4, 7, 9],
  major:   [0, 2, 4, 5, 7, 9, 11],
  minor:   [0, 2, 3, 5, 7, 8, 10],
  dorian:  [0, 2, 3, 5, 7, 9, 10],
  // Deliberately unsettled -- no perfect fifth to land on.
  whole:   [0, 2, 4, 6, 8, 10],
};

/** Degree -> semitone offset, wrapping into octaves above the scale's top. */
function degree(scale, n) {
  const len = scale.length;
  const oct = Math.floor(n / len);
  return scale[((n % len) + len) % len] + 12 * oct;
}

// ── Themes ───────────────────────────────────────────────────────────────
// `chords` are root degrees; each bar takes the next one. Layer gains are
// absolute and small: the music bus already carries the player's volume, and
// this bed has to stay under a chime without being ducked.
const THEMES = {
  // Menus. Slow, open, almost still.
  title: {
    bpm: 66, root: -21, scale: 'penta', chords: [0, 3, 4, 2],
    pad: { gain: 0.045, cutoff: 1100 },
    bass: { gain: 0.05, every: 8 },
    arp: { gain: 0.035, every: 4, span: 5, jitter: 0.4, cutoff: 2200 },
    perc: null,
  },
  // Waiting for people. The same room, with a pulse to say time is passing.
  lobby: {
    bpm: 78, root: -21, scale: 'penta', chords: [0, 4, 3, 4],
    pad: { gain: 0.04, cutoff: 1200 },
    bass: { gain: 0.055, every: 4 },
    arp: { gain: 0.035, every: 2, span: 6, jitter: 0.3, cutoff: 2600 },
    perc: { gain: 0.018, hat: 4, kick: 8 },
  },
  // Under live play. The one that has to disappear: no arp at all, because
  // a moving line is exactly what pulls attention off a word.
  live: {
    bpm: 84, root: -21, scale: 'penta', chords: [0, 2, 3, 4],
    pad: { gain: 0.05, cutoff: 900 },
    bass: { gain: 0.05, every: 8 },
    arp: null,
    perc: { gain: 0.012, hat: 8, kick: 16 },
  },
  // ⚡ Blitz. Faster, minor, and the hats close up -- the clock is the point.
  blitz: {
    bpm: 138, root: -21, scale: 'minor', chords: [0, 5, 3, 4],
    pad: { gain: 0.032, cutoff: 800 },
    bass: { gain: 0.07, every: 2 },
    arp: { gain: 0.042, every: 1, span: 7, jitter: 0.1, cutoff: 3200 },
    perc: { gain: 0.03, hat: 2, kick: 4 },
  },
  // 💰 Double Points. Warm and major, with a bell arp over the top.
  double_points: {
    bpm: 92, root: -21, scale: 'major', chords: [0, 3, 5, 4],
    pad: { gain: 0.055, cutoff: 1600 },
    bass: { gain: 0.055, every: 4 },
    arp: { gain: 0.05, every: 2, span: 8, jitter: 0.25, cutoff: 4200, bell: true },
    perc: { gain: 0.016, hat: 4, kick: 8 },
  },
  // 🙈 Blackout. Everything shuts down to a low murmur -- the legend has
  // gone dark and so has the music.
  blackout: {
    bpm: 68, root: -24, scale: 'minor', chords: [0, 1, 0, 4],
    pad: { gain: 0.06, cutoff: 380 },
    bass: { gain: 0.06, every: 8 },
    arp: null,
    perc: null,
  },
  // 🎰 Jackpot. The only theme allowed to be loud.
  jackpot: {
    bpm: 116, root: -21, scale: 'major', chords: [0, 4, 5, 4],
    pad: { gain: 0.05, cutoff: 2600 },
    bass: { gain: 0.07, every: 2 },
    arp: { gain: 0.06, every: 1, span: 9, jitter: 0.15, cutoff: 5200, bell: true },
    perc: { gain: 0.032, hat: 2, kick: 4 },
  },
  // 🔀 Letter Swap. Whole-tone: nothing resolves, which is the joke.
  letter_swap: {
    bpm: 88, root: -22, scale: 'whole', chords: [0, 2, 4, 1],
    pad: { gain: 0.05, cutoff: 1300, detune: 14 },
    bass: { gain: 0.05, every: 4 },
    arp: { gain: 0.04, every: 2, span: 6, jitter: 0.5, cutoff: 2800 },
    perc: { gain: 0.014, hat: 4, kick: 8 },
  },
  // ⛈ The storm, which is a room event rather than a modifier -- so this is
  // player-sided, and only the person whose window it is rains on hears it.
  storm: {
    bpm: 72, root: -24, scale: 'dorian', chords: [0, 5, 3, 5],
    pad: { gain: 0.055, cutoff: 520 },
    bass: { gain: 0.06, every: 8 },
    arp: null,
    perc: { gain: 0.01, hat: 8, kick: 16 },
  },
  // The word is up. Held, resolved, and out of the way of the reveal cue.
  reveal: {
    bpm: 60, root: -21, scale: 'major', chords: [0, 4],
    pad: { gain: 0.05, cutoff: 1500 },
    bass: { gain: 0.045, every: 8 },
    arp: null,
    perc: null,
  },
  // Someone else's music, through a wall. A room event rather than anything
  // the game did -- and the reason the engine has an override layer at all.
  // Four-on-the-floor with the top end taken off: what you actually hear
  // through plasterboard is the kick and the bass, and nothing else.
  neighbour: {
    bpm: 124, root: -24, scale: 'minor', chords: [0, 0, 5, 3],
    pad: { gain: 0.045, cutoff: 190 },
    bass: { gain: 0.075, every: 2 },
    arp: null,
    perc: { gain: 0.028, hat: 4, kick: 4 },
  },
  standings: {
    bpm: 86, root: -21, scale: 'penta', chords: [0, 4, 2, 3],
    pad: { gain: 0.042, cutoff: 1500 },
    bass: { gain: 0.05, every: 4 },
    arp: { gain: 0.04, every: 2, span: 7, jitter: 0.3, cutoff: 3200 },
    perc: { gain: 0.02, hat: 4, kick: 8 },
  },
};

// ── Engine state ─────────────────────────────────────────────────────────
let ctx = null;
let out = null;         // the engine's own gain, between the layers and the bus
let timer = null;
let running = false;
let theme = THEMES.live;
let themeName = 'live';
let pending = null;     // theme queued for the next bar boundary

// Two levels, because two different things want to drive the music and they
// are not the same kind of thing. `base` is the game: phase and modifiers,
// shared by everybody in the room. `override` is a room event -- the storm,
// the neighbour's stereo -- which is player-sided, so it must be able to
// take the music over for a moment and hand it straight back without the
// game having to know it happened.
let base = 'live';
let override = null;
const wanted = () => override ?? base;
let step = 0;           // 16th notes since the engine started
let nextStepTime = 0;
let noiseBuf = null;

const STEPS_PER_BAR = 16;
const stepDuration = () => 60 / theme.bpm / 4;

function noiseSource() {
  if (!noiseBuf || noiseBuf.sampleRate !== ctx.sampleRate) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  return src;
}

/** One voice: oscillator -> lowpass -> envelope -> engine out. */
function voice({ freq, at, dur, type = 'sine', gain, cutoff = 2000, attack = 0.02, detune = 0 }) {
  const osc = ctx.createOscillator();
  const lp = ctx.createBiquadFilter();
  const env = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  if (detune) osc.detune.setValueAtTime(detune, at);
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(cutoff, at);
  lp.Q.setValueAtTime(0.5, at);
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), at + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(lp).connect(env).connect(out);
  osc.start(at);
  osc.stop(at + dur + 0.05);
}

function percHit({ at, kick }) {
  const src = noiseSource();
  const filt = ctx.createBiquadFilter();
  const env = ctx.createGain();
  const g = theme.perc.gain;
  if (kick) {
    // Not a drum kit -- a soft thump, the sort of low knock a room makes.
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(140, at);
    env.gain.setValueAtTime(g * 2.6, at);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
    src.connect(filt).connect(env).connect(out);
    src.start(at); src.stop(at + 0.2);
    voice({ freq: 68, at, dur: 0.17, type: 'sine', gain: g * 2.2, cutoff: 200, attack: 0.004 });
  } else {
    // Brushed, not a hi-hat: bandpassed and very short.
    filt.type = 'bandpass';
    filt.frequency.setValueAtTime(6200, at);
    filt.Q.setValueAtTime(0.8, at);
    env.gain.setValueAtTime(g, at);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.035);
    src.connect(filt).connect(env).connect(out);
    src.start(at); src.stop(at + 0.05);
  }
}

/** Everything that happens on one 16th note. */
function scheduleStep(n, at) {
  const scale = SCALES[theme.scale];
  const bar = Math.floor(n / STEPS_PER_BAR);
  const inBar = n % STEPS_PER_BAR;
  const chordRoot = theme.chords[bar % theme.chords.length];
  const barSeconds = stepDuration() * STEPS_PER_BAR;

  // Pad: one sustained chord per bar, three voices a third apart.
  if (theme.pad && inBar === 0) {
    for (const offset of [0, 2, 4]) {
      const semis = theme.root + degree(scale, chordRoot + offset);
      voice({
        freq: hz(semis), at, dur: barSeconds * 1.05,
        type: 'triangle', gain: theme.pad.gain, cutoff: theme.pad.cutoff,
        attack: barSeconds * 0.3,
        detune: theme.pad.detune ? (offset - 2) * theme.pad.detune : 0,
      });
    }
  }

  // Bass: the chord root, an octave and a half down.
  if (theme.bass && inBar % theme.bass.every === 0) {
    const semis = theme.root - 12 + degree(scale, chordRoot);
    voice({
      freq: hz(semis), at, dur: stepDuration() * theme.bass.every * 0.9,
      type: 'sine', gain: theme.bass.gain, cutoff: 420, attack: 0.02,
    });
  }

  // Arp: walks the chord, with `jitter` of the notes nudged off the pattern
  // so a long round never settles into something you can hum along to.
  if (theme.arp && inBar % theme.arp.every === 0) {
    const idx = Math.floor(n / theme.arp.every);
    let d = chordRoot + (idx % theme.arp.span);
    if (Math.random() < theme.arp.jitter) d += [2, 4, -2, 7][Math.floor(Math.random() * 4)];
    const semis = theme.root + 12 + degree(scale, d);
    const g = theme.arp.gain * (0.65 + Math.random() * 0.35);
    if (theme.arp.bell) {
      voice({ freq: hz(semis), at, dur: 0.7, type: 'sine', gain: g, cutoff: theme.arp.cutoff, attack: 0.008 });
      voice({ freq: hz(semis + 12), at, dur: 0.4, type: 'sine', gain: g * 0.3, cutoff: theme.arp.cutoff });
    } else {
      voice({ freq: hz(semis), at, dur: 0.45, type: 'triangle', gain: g, cutoff: theme.arp.cutoff, attack: 0.01 });
    }
  }

  if (theme.perc) {
    if (inBar % theme.perc.kick === 0) percHit({ at, kick: true });
    else if (inBar % theme.perc.hat === 0) percHit({ at, kick: false });
  }
}

function tick() {
  if (!ctx) return;
  while (nextStepTime < ctx.currentTime + HORIZON_S) {
    // A theme swap waits for the top of a bar. Cutting mid-bar is audible as
    // a mistake; landing on the downbeat reads as the music responding.
    if (pending && step % STEPS_PER_BAR === 0) {
      theme = THEMES[pending] ?? THEMES.live;
      themeName = pending;
      pending = null;
      step = 0;
      if (out) {
        const now = ctx.currentTime;
        out.gain.cancelScheduledValues(now);
        out.gain.setValueAtTime(out.gain.value, now);
        out.gain.linearRampToValueAtTime(1, now + 0.5);
      }
    }
    scheduleStep(step, nextStepTime);
    nextStepTime += stepDuration();
    step += 1;
  }
}

/** Queue whatever `wanted()` now says, ducking across the seam. */
function apply() {
  const name = wanted();
  if (!running) return;
  if (name === themeName && !pending) return;
  if (pending === name) return;
  pending = name;
  if (out && ctx) {
    const now = ctx.currentTime;
    out.gain.cancelScheduledValues(now);
    out.gain.setValueAtTime(out.gain.value, now);
    out.gain.linearRampToValueAtTime(0.25, now + 0.18);
  }
}

export const music = {
  get theme() { return themeName; },
  get running() { return running; },
  /** What is queued or playing — the tests assert on this, not on audio. */
  get target() { return wanted(); },

  /** Is there a theme for this name? Lets callers map a game event straight
      onto a theme without keeping a duplicate list of which ones exist. */
  knows(name) { return !!THEMES[name]; },

  /**
   * Must be called from a user gesture -- browsers will not start audio
   * otherwise. Safe to call repeatedly.
   */
  start(name = 'title') {
    base = THEMES[name] ? name : 'title';
    if (running) { apply(); return; }
    ctx = audioContext();
    if (!ctx) return;
    out = ctx.createGain();
    out.gain.value = 1;
    out.connect(buses.music);
    theme = THEMES[base];
    themeName = base;
    step = 0;
    nextStepTime = ctx.currentTime + 0.08;
    running = true;
    timer = setInterval(tick, LOOKAHEAD_MS);
    tick();
  },

  /**
   * Queue a theme. It takes effect on the next bar, and the engine ducks
   * across the change so the seam is a transition rather than a jump.
   *
   * Note this does NOT stop and restart anything: the scheduler keeps its
   * own clock running the whole time, which is why moving between phases
   * sounds continuous instead of like a playlist skipping tracks.
   */
  set(name) {
    if (!THEMES[name]) return;
    base = name;
    apply();
  },

  /**
   * A room event taking the music over. Player-sided and temporary: the
   * game's own theme is remembered underneath and comes back on release.
   */
  override(name) {
    if (!THEMES[name]) return;
    override = name;
    apply();
  },

  release(name) {
    // Only the event that took it may hand it back, so a storm ending
    // cannot cancel a takeover that started after it.
    if (name && override !== name) return;
    override = null;
    apply();
  },

  stop() {
    if (!running) return;
    running = false;
    override = null;
    pending = null;
    clearInterval(timer);
    timer = null;
    if (out && ctx) {
      const now = ctx.currentTime;
      out.gain.cancelScheduledValues(now);
      out.gain.setValueAtTime(out.gain.value, now);
      out.gain.linearRampToValueAtTime(0.0001, now + 0.6);
      const dying = out;
      setTimeout(() => dying.disconnect(), 1200);
    }
    out = null;
  },
};

// Named for the tests, and for anyone wanting to hear a theme in isolation
// from the console.
export const __themes = THEMES;
