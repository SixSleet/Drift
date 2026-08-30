// Real instruments.
//
// Everything else the game makes a noise with is synthesised from
// oscillators (see sfx.js and the voices in music.js). That was a deliberate
// constraint -- nothing to download, nothing to license -- and it is a good
// constraint for a doorbell or a cat. It is a bad one for a guitar. An
// oscillator through a filter can imitate the ENVELOPE of a plucked string,
// but not the thing that actually makes a nylon string sound like a nylon
// string: the body resonating, the other strings ringing in sympathy, the
// finger noise, and a spectrum that changes shape as the note decays. Those
// are recordings or they are nothing.
//
// So this file is the exception. `assets/instruments/` holds about 1.5MB of
// recorded notes -- eight instruments, ten to thirteen notes each, four
// semitones apart -- and this plays them.
//
//   Samples: the MusyngKite set from the MIDI.js Soundfonts collection,
//   redistributed under the MIT licence by the `web-music-score-samples`
//   package. See assets/instruments/README.md.
//
// The rules this has to live by, which are what most of the code below is:
//
//   Nothing blocks. The music starts on the synth voices, exactly as it did
//   before, and each instrument swaps itself in the moment its samples have
//   decoded. A slow connection gets the old engine, not silence.
//
//   Nothing breaks. Every failure -- offline, a 404, a browser that will not
//   decode mp3 -- ends with `ready()` returning false, and the caller falls
//   back to the oscillator it was using before. There is no path here that
//   can stop the music.
//
//   Nothing downloads that is not needed. Instruments load per theme, on
//   demand, once. A player who only ever plays Solo never fetches the brass.

import { audioContext, buses } from './audio.js';

const BASE = 'assets/instruments';

// Which notes were extracted for each instrument, and how loud it is
// relative to the others -- these are recordings of eight different things
// at eight different distances, so they do not arrive matched.
//
// `low` and `high` are the outer MIDI notes each set can cover convincingly.
// Beyond about five semitones of pitch-shifting a sample stops sounding like
// the instrument and starts sounding like the instrument on a tape at the
// wrong speed, so a note outside the range falls back to the synth voice
// rather than being played badly.
const SETS = {
  nylon:   { notes: ['C2','E2','Ab2','C3','E3','Ab3','C4','E4','Ab4','C5','E5','Ab5','C6','E6','Ab6','C7'], gain: 0.9 },
  rhodes:  { notes: ['C2','E2','Ab2','C3','E3','Ab3','C4','E4','Ab4','C5','E5','Ab5','C6','E6','Ab6','C7'], gain: 0.8 },
  upright: { notes: ['C1','E1','Ab1','C2','E2','Ab2','C3','E3','Ab3','C4'], gain: 1.15 },
  ebass:   { notes: ['C1','E1','Ab1','C2','E2','Ab2','C3','E3','Ab3','C4'], gain: 1.0 },
  vibes:   { notes: ['C3','E3','Ab3','C4','E4','Ab4','C5','E5','Ab5','C6','E6','Ab6','C7'], gain: 0.75 },
  strings: { notes: ['C2','E2','Ab2','C3','E3','Ab3','C4','E4','Ab4','C5','E5','Ab5','C6'], gain: 0.85 },
  flute:   { notes: ['C4','E4','Ab4','C5','E5','Ab5','C6','E6','Ab6','C7'], gain: 0.7 },
  brass:   { notes: ['C2','E2','Ab2','C3','E3','Ab3','C4','E4','Ab4','C5','E5','Ab5','C6'], gain: 0.6 },
};

const SEMIS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "Ab3" / "C4" -> MIDI note number. The sample sets only use flats. */
function midiOf(name) {
  const m = /^([A-G])(b|#)?(-?\d)$/.exec(name);
  if (!m) return null;
  return SEMIS[m[1]] + (m[2] === 'b' ? -1 : m[2] === '#' ? 1 : 0) + (Number(m[3]) + 1) * 12;
}

const midiFromHz = (f) => 69 + 12 * Math.log2(f / 440);

// name -> { buffers: [{ midi, buffer }], gain, low, high } once decoded.
const loaded = new Map();
// name -> Promise, so ten calls in one bar do not start ten fetches.
const loading = new Map();
// Instruments that failed. Never retried: a 404 is a 404, and a retry loop
// on the audio path is worse than a synth guitar.
const dead = new Set();

// ── The room ─────────────────────────────────────────────────────────────
//
// One convolution reverb, shared by every instrument, on a send rather than
// inline so each layer can decide how wet it is.
//
// This matters more than it looks. A recorded note played completely dry
// sits in a different place from every other sound in the game and reads as
// a sample being triggered rather than as an instrument being played -- the
// tell is not the tone, it is the absence of a space around it. The impulse
// is generated rather than recorded: noise decaying exponentially, with the
// top end decaying faster than the bottom, which is what a real room does to
// a sound and is about ninety per cent of what a real impulse response
// carries.

let convolver = null;
let wetBus = null;

function makeImpulse(ctx, seconds = 2.2, decay = 2.6) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      // The early part is denser than the tail: a room's first reflections
      // arrive in a clump, and without that a convolution reverb sounds
      // like a wash rather than like a place.
      const early = i < ctx.sampleRate * 0.06 ? 1.6 : 1;
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * early;
    }
  }
  return buf;
}

function reverb(ctx) {
  if (convolver) return wetBus;
  convolver = ctx.createConvolver();
  convolver.buffer = makeImpulse(ctx);
  wetBus = ctx.createGain();
  wetBus.gain.value = 1;
  const tame = ctx.createBiquadFilter();
  tame.type = 'lowpass';
  tame.frequency.value = 3200;   // a room absorbs the top; so does this
  wetBus.connect(convolver).connect(tame).connect(buses.music);
  return wetBus;
}

// ── Loading ──────────────────────────────────────────────────────────────

async function fetchNote(ctx, inst, note) {
  const res = await fetch(`${BASE}/${inst}/${note}.mp3`);
  if (!res.ok) throw new Error(`${inst}/${note}: ${res.status}`);
  const bytes = await res.arrayBuffer();
  // decodeAudioData's promise form is not universal; the callback form is.
  const buffer = await new Promise((ok, no) => {
    const p = ctx.decodeAudioData(bytes, ok, no);
    if (p?.then) p.then(ok, no);
  });
  return { midi: midiOf(note), buffer };
}

/**
 * Start loading an instrument. Safe to call as often as you like -- once per
 * bar from the scheduler is the expected usage. Returns nothing; ask
 * `ready()` whether it arrived.
 */
export function preload(name) {
  if (!name || loaded.has(name) || loading.has(name) || dead.has(name)) return;
  const set = SETS[name];
  if (!set) { dead.add(name); return; }
  const ctx = audioContext();
  if (!ctx) return;                       // no audio yet; try again next bar

  loading.set(name, (async () => {
    try {
      const notes = await Promise.all(set.notes.map((n) => fetchNote(ctx, name, n)));
      const buffers = notes.filter((n) => n.midi != null).sort((a, b) => a.midi - b.midi);
      if (!buffers.length) throw new Error(`${name}: nothing decoded`);
      loaded.set(name, {
        buffers,
        gain: set.gain,
        // Five semitones past the outermost sample, either way.
        low: buffers[0].midi - 5,
        high: buffers[buffers.length - 1].midi + 5,
      });
    } catch {
      // Deliberately silent. A missing instrument is not an error the
      // player can do anything about, and the synth voice covers it.
      dead.add(name);
    } finally {
      loading.delete(name);
    }
  })());
}

/** Can this instrument play this frequency right now? */
export function ready(name, freq) {
  const inst = loaded.get(name);
  if (!inst) return false;
  const m = midiFromHz(freq);
  return m >= inst.low && m <= inst.high;
}

/** Has anything at all finished loading? Used only for the test harness. */
export const __state = () => ({
  loaded: [...loaded.keys()], loading: [...loading.keys()], dead: [...dead],
});

// ── Playing ──────────────────────────────────────────────────────────────

/**
 * One note. Returns false if it could not be played, which is the caller's
 * cue to fall back -- so the check and the play are one call and cannot
 * disagree with each other.
 *
 * `dur` cuts the note off with a short release rather than letting the
 * sample run to its end: these are recordings of notes held for seconds, and
 * a bass line at 146bpm needs them to stop.
 */
export function play(name, { freq, at, dur, gain = 0.1, cutoff = 0, wet = 0.18, attack = 0.004 }) {
  const inst = loaded.get(name);
  if (!inst) return false;
  const ctx = audioContext();
  if (!ctx) return false;

  const want = midiFromHz(freq);
  if (want < inst.low || want > inst.high) return false;

  // Nearest recorded note, then shift it. Nearest rather than "the one
  // below" on purpose: shifting down half a tone and shifting up half a
  // tone both sound fine, and always shifting one direction stacks the
  // error up at the top of every octave.
  let best = inst.buffers[0];
  for (const b of inst.buffers) {
    if (Math.abs(b.midi - want) < Math.abs(best.midi - want)) best = b;
  }

  const src = ctx.createBufferSource();
  src.buffer = best.buffer;
  src.playbackRate.value = Math.pow(2, (want - best.midi) / 12);

  const env = ctx.createGain();
  const g = Math.max(0.0001, gain * inst.gain);
  env.gain.setValueAtTime(0.0001, at);
  env.gain.linearRampToValueAtTime(g, at + attack);
  // Hold, then a release long enough not to click and short enough that the
  // next note is not playing over the top of this one.
  const rel = Math.min(0.28, Math.max(0.06, dur * 0.35));
  env.gain.setValueAtTime(g, at + Math.max(attack, dur - rel));
  env.gain.exponentialRampToValueAtTime(0.0001, at + dur + rel);

  let node = src;
  if (cutoff) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(cutoff, at);
    node.connect(lp);
    node = lp;
  }
  node.connect(env);
  env.connect(buses.music);
  if (wet > 0) {
    const send = ctx.createGain();
    send.gain.value = wet;
    env.connect(send).connect(reverb(ctx));
  }

  src.start(at);
  src.stop(at + dur + rel + 0.05);
  return true;
}

/** Every instrument this build ships, for the loader and the tests. */
export const INSTRUMENTS = Object.keys(SETS);

/**
 * The MIDI range each instrument can actually cover, sample set plus the
 * five semitones of shift either side. Exported so the range check in the
 * test harness reads the same table the player does rather than a copy of
 * it that can quietly fall out of date
 */
export const RANGES = Object.fromEntries(Object.entries(SETS).map(([name, set]) => {
  const m = set.notes.map(midiOf).sort((a, b) => a - b);
  return [name, [m[0] - 5, m[m.length - 1] + 5]];
}));
