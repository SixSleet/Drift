// The soundtrack. Generative, synthesised, and no audio files -- same rule
// as the rest of the sound here.
//
// It is not a loop that plays back. There is a scheduler ticking on a timer,
// and a THEME describing what to build: a tempo, a scale, a chord
// progression, and a set of layers. Changing the theme changes what gets
// scheduled from the next bar, so the music follows the game rather than
// being cut and restarted at every transition.
//
// ── What changed, and why ────────────────────────────────────────────────
//
// The first version of this had four layers -- a pad, a root-note bass, a
// wandering arp and a soft thump -- and every one of them went through the
// same oscillator-into-a-lowpass voice. A theme could differ from another
// theme in tempo, in scale, and in how loud each layer was, and in nothing
// else. Which meant that at some level every theme WAS the same theme. You
// do not tell two pieces of music apart by their filter cutoff. You tell
// them apart by what they play.
//
// So the engine now has the three things that were missing:
//
//   1. Written parts. `bass` and `lead` are step patterns of scale degrees,
//      not "a root note every N steps". A theme can have a riff, and a riff
//      is the thing you actually remember afterwards.
//   2. A drum machine. Kick, snare, rim, closed and open hats and a clap,
//      each on its own pattern, instead of one thump that fired whenever
//      the step number divided by four.
//   3. Voices worth writing for: saw and square through a resonant filter
//      that sweeps across each note, detuned stacks, sub-oscillators, bells.
//
// Plus swing, which on its own is most of the difference between the Solo
// bed and the Co-op one.
//
// ── ...and what was still wrong after that ───────────────────────────────
//
// All of the above still described ONE LOOP. Patterns repeat on
// `n % length` and chords on `bar % chords.length`, so a theme was two to
// four bars long and then played those same bars for the rest of the round.
// At 84bpm the Solo bed came back around every 5.7 seconds; a five-minute
// round played it fifty times. Better instruments do not fix that -- they
// just make a more interesting thing repeat.
//
// So a theme can now have `sections`: a running order rather than a loop.
// See the block above scheduleStep. Solo went from 2 bars to 24 before
// anything repeats, and inside those it opens on pad and bass alone, brings
// the tune in, lifts, drops the lead for a break and thins out again.
//
// ── Patterns ─────────────────────────────────────────────────────────────
//
// Drums are strings, one character per 16th note: `x` a hit, `X` an accent,
// `.` a rest. Length is a multiple of 16, so a two-bar pattern is 32
// characters and still reads as two bars on one line.
//
// Bass and lead are arrays, one entry per 16th:
//   a number -- play this scale degree, relative to the bar's chord root
//   _        -- rest
//   H        -- hold the note before it
// A note lasts for however many H follow it, so a riff's rhythm lives in the
// same array as its pitches instead of in a parallel duration field.
//
// ── Scheduling ───────────────────────────────────────────────────────────
//
// Standard lookahead (Chris Wilson, "A Tale of Two Clocks"): a setInterval
// wakes often and queues every note falling inside a short window, at
// sample-accurate times, on the audio clock. Note timing never touches
// setTimeout, so a busy main thread -- a board full of tiles flipping --
// cannot make the music stutter.

import { audioContext, buses } from './audio.js';

const LOOKAHEAD_MS = 25;    // how often the scheduler wakes
const HORIZON_S = 0.14;     // how far ahead it queues
const STEPS_PER_BAR = 16;

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
  // Minor with a flattened second. Every line in it leans on that semitone
  // and wants to fall, which is why it is the sound of being chased.
  phryg:   [0, 1, 3, 5, 7, 8, 10],
  // Deliberately unsettled -- no perfect fifth to land on.
  whole:   [0, 2, 4, 6, 8, 10],
  // Flat fifth as well as a flat second: the one mode with no stable note
  // to resolve to at all. Used where nothing should feel safe.
  locrian: [0, 1, 3, 5, 6, 8, 10],
};

/** Degree -> semitone offset, wrapping into octaves above the scale's top. */
function degree(scale, n) {
  const len = scale.length;
  const oct = Math.floor(n / len);
  return scale[((n % len) + len) % len] + 12 * oct;
}

// Shorthand, so a written pattern reads as a rhythm rather than as
// punctuation. `_` is a rest and `H` holds the note before it.
const _ = null;
const H = 'hold';

// ── Themes ───────────────────────────────────────────────────────────────
// `chords` are root degrees; each bar takes the next one. Layer gains are
// absolute and small: the music bus already carries the player's volume, and
// this bed has to stay under a chime without being ducked.
const THEMES = {
  // ── Menus ──────────────────────────────────────────────────────────────

  // The first thing anyone hears. Slow and open, but it has a tune now:
  // four notes with long tails, once every two bars. A title screen that is
  // only texture gives you nothing to remember the game by.
  title: {
    name: 'Title',
    bpm: 66, root: -21, scale: 'penta', chords: [0, 3, 4, 2],
    pad: { gain: 0.045, cutoff: 1100, wave: 'triangle' },
    bass: { gain: 0.05, wave: 'sine', cutoff: 300, octave: -1, legato: 1.8,
      pattern: [0, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _] },
    lead: { gain: 0.034, wave: 'sine', bell: true, cutoff: 3400, octave: 1,
      pattern: [4, H, H, H, _, _, 2, H, H, _, _, _, 0, H, H, H,
                _, _, _, _, 7, H, H, H, _, _, 4, H, H, _, _, _] },
    arp: { gain: 0.024, every: 4, span: 5, jitter: 0.4, cutoff: 2200 },
    counter: { gain: 0.02, wave: 'triangle', cutoff: 1600, octave: 0, legato: 2.2,
      pattern: [_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _,
                7, H, H, H, H, H, H, H, _, _, _, _, _, _, _, _] },
    drums: null,
    // It opens on the pad alone, which is what a title screen wants; the
    // tune arrives once you have had a moment to look at it.
    sections: [
      { bars: 2, mute: ['lead', 'counter', 'arp'] },
      { bars: 6, mute: ['counter'] },
      { bars: 8 },
      { bars: 4, mute: ['lead'] },
    ],
  },

  // Waiting for people. The title's key, given a pulse and a walking bass:
  // the room is filling up and something is about to start.
  lobby: {
    name: 'Lobby',
    bpm: 82, root: -21, scale: 'penta', chords: [0, 4, 3, 4],
    pad: { gain: 0.038, cutoff: 1250, wave: 'triangle' },
    bass: { gain: 0.056, wave: 'sine', cutoff: 340, octave: -1,
      pattern: [0, _, _, _, 4, _, _, _, 2, _, _, _, 4, _, 5, _] },
    lead: { gain: 0.03, wave: 'triangle', cutoff: 2600, octave: 1,
      pattern: [_, _, 0, _, 2, _, _, 4, H, _, _, 2, _, _, _, _,
                _, _, 4, _, 5, _, _, 7, H, H, _, _, 4, _, 2, _] },
    counter: { gain: 0.02, wave: 'sine', bell: true, cutoff: 3600, octave: 2,
      pattern: [_, _, _, _, _, _, _, _, 7, H, H, _, _, _, _, _,
                _, _, _, _, _, _, _, _, _, _, _, _, 4, H, H, _,
                _, _, _, _, 9, H, _, _, _, _, _, _, _, _, _, _] },
    drums: { gain: 0.02, kick: 'x.......x.......', hat: '..x...x...x...x.',
             rim: '....x.......x...' },
    sections: [
      { bars: 4, mute: ['drums', 'counter'] },
      { bars: 8, mute: ['counter'] },
      { bars: 8 },
      { bars: 4, mute: ['lead'],
        drums: { gain: 0.022, kick: 'x...x...x...x...', shaker: '..x...x...x...x.',
                 rim: '....x.......x...' } },
    ],
  },

  // ── Under live play ────────────────────────────────────────────────────

  // Solo. The one theme whose whole job is to disappear: no lead, no arp,
  // nothing that moves. A line over the top is exactly what pulls attention
  // off a word, and in Solo there is nothing else to pull it back.
  //
  // Deliberately left alone in the rewrite. It is not a weak theme, it is a
  // bed, and those are different jobs.
  live: {
    name: 'Solo',
    bpm: 84, root: -21, scale: 'penta', chords: [0, 2, 3, 4],
    pad: { gain: 0.05, cutoff: 900, wave: 'triangle' },
    bass: { gain: 0.05, wave: 'sine', cutoff: 420, octave: -1, legato: 1.4,
      pattern: [0, _, _, _, _, _, _, _, 0, _, _, _, _, _, 4, _,
                0, _, _, _, _, _, _, _, 2, _, _, _, _, _, _, _] },
    // Sparse on purpose: this plays while somebody is trying to think.
    lead: { gain: 0.026, wave: 'sine', bell: true, cutoff: 3000, octave: 1,
      pattern: [_, _, _, _, 4, H, H, _, _, _, _, _, _, _, _, _,
                _, _, 2, H, H, _, _, _, _, _, _, _, 0, H, H, _] },
    counter: { gain: 0.018, wave: 'triangle', cutoff: 1800, octave: 1, legato: 1.6,
      pattern: [_, _, _, _, _, _, _, _, _, _, 7, H, H, H, _, _,
                _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _,
                _, _, _, _, _, _, 5, H, H, _, _, _, _, _, _, _] },
    drums: { gain: 0.012, kick: 'x...............', hat: '........x.......',
             shaker: '..x...x...x...x.' },
    // Twenty-four bars before anything repeats, and the shape of it is a
    // round: settle, work, a lift when it has gone on a while, then back
    // down. A two-bar loop under a five-minute round is a metronome.
    sections: [
      { bars: 4,  mute: ['lead', 'counter', 'drums'] },
      { bars: 6,  mute: ['counter'] },
      { bars: 6 },
      { bars: 4,  mute: ['lead'],
        drums: { gain: 0.014, kick: 'x.......x.......', hat: '..x...x...x...x.',
                 shaker: 'x.x.x.x.x.x.x.x.' } },
      { bars: 4,  mute: ['drums', 'counter'] },
    ],
  },

  // PvP. Someone else is racing you through the same word right now.
  //
  // This is the one that had to change most. The old version was the Solo
  // bed at 108bpm in a minor key, and "the same thing, faster and sadder" is
  // not adrenaline. This is built the way a fast track is actually built:
  // four-on-the-floor under a rolling 16th bass, accented snare on 2 and 4,
  // an open hat pulling into each bar line, and a two-bar saw hook over the
  // top with the filter sweeping shut through every note.
  //
  // The hook is 32 steps against a four-bar chord cycle, so it comes round
  // twice per cycle over different harmony each time -- often enough to be a
  // hook, never twice identically.
  live_pvp: {
    name: 'Duel',
    bpm: 146, root: -21, scale: 'minor', chords: [0, 0, 5, 6],
    pad: { gain: 0.026, cutoff: 640, wave: 'sawtooth', detune: 9 },
    bass: { gain: 0.07, wave: 'sawtooth', cutoff: 300, q: 4, sweep: 3, octave: -1,
      pattern: [0, _, 0, 0, _, 0, _, 0, 0, _, 0, _, 0, 0, _, 7] },
    lead: { gain: 0.032, wave: 'sawtooth', cutoff: 2100, q: 7, sweep: 4, spread: 11, octave: 1,
      pattern: [7, H, _, 4, _, 7, _, 9, 11, H, H, _, 9, _, 7, _,
                4, H, _, 7, _, 4, _, 2, 0, H, H, _, 2, 4, _, _] },
    // A stab answering the lead across the bar line.
    counter: { gain: 0.024, wave: 'square', cutoff: 1400, q: 5, sweep: 2, octave: 0,
      pattern: [_, _, _, _, _, _, _, _, _, _, _, _, 0, 0, _, _,
                _, _, _, _, _, _, _, _, _, _, _, _, 5, _, 5, _] },
    drums: { gain: 0.028, kick: 'x...x...x...x...', snare: '....X.......X...',
             hat: '..x...x...x...x.', open: '..............x.' },
    // Eight bars of build, eight of everything, then four where the kick
    // drops out and only the hats carry it -- which is what makes the kick
    // coming back land. A duel that is flat out from the first bar has
    // nowhere left to go by the third round.
    sections: [
      { bars: 4, mute: ['lead', 'counter'],
        drums: { gain: 0.024, kick: 'x...x...x...x...', hat: '..x...x...x...x.' } },
      { bars: 8, mute: ['counter'] },
      { bars: 8 },
      { bars: 4, mute: ['pad'],
        drums: { gain: 0.03, snare: '....X.......X..X', hat: 'x.x.x.x.x.x.x.x.',
                 ride: '....x.......x...' } },
    ],
  },

  // Co-op. Nobody is racing anybody -- you are all looking at one board --
  // so it stays calm. What makes it not-Solo is the swing: the off-16ths
  // land a fifth of a step late, which is the single change that turns a
  // straight bed into something with a shoulder roll in it. Dorian on top of
  // that, a dub bass with a long tail, a rimshot where a snare would be, and
  // a bell line sparse enough to read as space rather than movement.
  live_coop: {
    name: 'Together',
    bpm: 80, root: -21, scale: 'dorian', chords: [0, 3, 5, 4], swing: 0.2,
    pad: { gain: 0.046, cutoff: 1150, wave: 'triangle', detune: 6 },
    // Walking, rather than one note every other bar. The old bass had four
    // notes in sixteen steps and the lead had five in thirty-two, which is
    // not "chill", it is "not much happening" -- there is a difference, and
    // the first version was the second thing.
    bass: { gain: 0.058, wave: 'sine', cutoff: 260, octave: -1, legato: 1.2,
      pattern: [0, _, _, 4, _, _, 2, _, 0, _, _, 4, _, 7, _, 5] },
    // A shimmer under the tune. Slow enough not to pull at you, and the one
    // layer that makes the gaps in the melody feel like space rather than
    // like silence.
    arp: { gain: 0.022, every: 4, span: 6, jitter: 0.25, cutoff: 2600 },
    lead: { gain: 0.03, wave: 'sine', bell: true, cutoff: 3200, octave: 1,
      pattern: [_, _, 4, _, 5, _, 7, H, _, 4, _, 2, _, _, _, _,
                _, _, 7, _, 9, _, 7, H, _, 5, _, 4, 2, _, _, _] },
    counter: { gain: 0.02, wave: 'triangle', cutoff: 1500, octave: 0, legato: 1.5,
      pattern: [_, _, _, _, _, _, _, _, 5, H, H, _, _, _, _, _,
                _, _, _, _, 2, H, H, _, _, _, _, _, _, _, _, _,
                _, _, 7, H, H, H, _, _, _, _, _, _, _, _, _, _,
                _, _, _, _, _, _, _, _, _, _, 4, H, H, _, _, _] },
    drums: { gain: 0.016, kick: 'x.....x.x.......', rim: '....x.......x...',
             hat: '..x...x...x...x.', open: '..............x.' },
    // The counter line is 48 steps against the lead's 32, so the two only
    // line up every three bars -- which is most of why this one keeps
    // sounding like it is going somewhere.
    sections: [
      { bars: 4,  mute: ['lead', 'counter', 'drums'] },
      { bars: 8,  mute: ['counter'] },
      { bars: 8 },
      { bars: 4,  mute: ['lead'],
        drums: { gain: 0.018, kick: 'x.......x.......', shaker: '..x...x...x...x.',
                 rim: '....x.......x...', tom: '..............x.' } },
      { bars: 4,  mute: ['drums'] },
    ],
  },

  // ── Round modifiers ────────────────────────────────────────────────────

  // Blitz. The clock is the point, so everything here is a subdivision of
  // it: a square lead running straight 8ths with no rests in it at all, hats
  // on every sixteenth, and a bass that never lets a bar breathe. Square
  // rather than saw, so it does not just sound like PvP in a hurry.
  blitz: {
    name: 'Blitz',
    bpm: 138, root: -21, scale: 'minor', chords: [0, 5, 3, 4],
    pad: { gain: 0.026, cutoff: 780, wave: 'sawtooth' },
    bass: { gain: 0.066, wave: 'square', cutoff: 340, q: 3, sweep: 2.5, octave: -1,
      pattern: [0, _, 0, _, 0, _, 0, _, 0, _, 0, _, 0, _, 0, _] },
    lead: { gain: 0.03, wave: 'square', cutoff: 2800, q: 4, sweep: 2, octave: 1,
      pattern: [0, _, 2, _, 4, _, 2, _, 5, _, 4, _, 2, _, 0, _,
                7, _, 5, _, 4, _, 5, _, 4, _, 2, _, 0, _, 2, _] },
    drums: { gain: 0.028, kick: 'x...x...x...x...', snare: '....X.......X...',
             hat: 'x.x.x.x.x.x.x.x.', open: '..............x.' },
  },

  // Double Points. Warm and major, with a bell hook that keeps climbing --
  // it should sound like good news arriving.
  double_points: {
    name: 'Double Points',
    bpm: 96, root: -21, scale: 'major', chords: [0, 3, 5, 4],
    pad: { gain: 0.052, cutoff: 1700, wave: 'triangle' },
    bass: { gain: 0.055, wave: 'sine', cutoff: 380, octave: -1,
      pattern: [0, _, _, _, _, _, 4, _, 2, _, _, _, _, _, 4, _] },
    lead: { gain: 0.042, wave: 'sine', bell: true, cutoff: 4200, octave: 1,
      pattern: [4, _, 6, _, 7, H, _, _, 6, _, 4, _, 2, H, _, _,
                7, _, 6, _, 4, H, _, _, 2, _, 4, _, 6, H, H, _] },
    drums: { gain: 0.016, kick: 'x.......x...x...', hat: '..x...x...x...x.',
             rim: '....x.......x...' },
  },

  // Blackout. The legend has gone dark and so has the music: no top end at
  // all, a sub you feel more than hear, and one slow pulse. The only theme
  // with nothing on the beat except that pulse.
  blackout: {
    name: 'Blackout',
    bpm: 68, root: -24, scale: 'minor', chords: [0, 1, 0, 4],
    pad: { gain: 0.06, cutoff: 340, wave: 'triangle', detune: 12 },
    bass: { gain: 0.062, wave: 'sine', cutoff: 160, octave: -1, legato: 2,
      pattern: [0, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _] },
    lead: null,
    drums: { gain: 0.02, kick: 'x.......x.......' },
  },

  // Jackpot. The one theme allowed to be loud, and the only one that gets a
  // clap. Bouncing bass, bell hook, hats wide open: a machine paying out.
  jackpot: {
    name: 'Jackpot',
    bpm: 118, root: -21, scale: 'major', chords: [0, 4, 5, 4],
    pad: { gain: 0.044, cutoff: 2600, wave: 'sawtooth', detune: 7 },
    bass: { gain: 0.07, wave: 'square', cutoff: 420, q: 3, sweep: 2.5, octave: -1,
      pattern: [0, _, _, 0, _, 4, _, _, 0, _, _, 0, _, 7, _, 4] },
    lead: { gain: 0.05, wave: 'sine', bell: true, cutoff: 5000, octave: 1,
      pattern: [7, _, 9, _, 11, _, 9, _, 7, H, _, 4, _, 7, _, _,
                11, _, 9, _, 7, _, 9, _, 11, H, H, _, _, 9, 7, _] },
    drums: { gain: 0.03, kick: 'x...x...x...x...', clap: '....x.......x...',
             hat: 'x.x.x.x.x.x.x.x.', open: '......x.......x.' },
  },

  // Letter Swap. Your letters have moved, so the tune's do too: the second
  // bar of the hook is the first bar with every note shifted up two degrees.
  // Same shape, different places, which is the event.
  //
  // It used to be whole-tone -- six equal steps, no leading note, nothing
  // that resolves -- with a chromatic ladder sliding through it on a detuned
  // saw. That is a good description of "disorienting" and a bad piece of
  // music: with no stable note anywhere it does not sound wrong on purpose,
  // it just sounds wrong. A plain minor key can carry the joke on its own,
  // because a shape you recognise arriving somewhere unexpected is the whole
  // point, and you cannot recognise a shape in a scale with no landmarks.
  letter_swap: {
    name: 'Letter Swap',
    bpm: 106, root: -21, scale: 'minor', chords: [0, 5, 3, 4],
    pad: { gain: 0.04, cutoff: 1400, wave: 'triangle', detune: 6 },
    bass: { gain: 0.062, wave: 'sine', cutoff: 340, octave: -1,
      pattern: [0, _, _, 0, _, 4, _, _, 0, _, _, 2, _, 4, _, _] },
    lead: { gain: 0.038, wave: 'triangle', cutoff: 3000, octave: 1,
      pattern: [0, _, 2, _, 4, H, _, 2, 0, _, _, _, 4, _, 2, _,
                2, _, 4, _, 6, H, _, 4, 2, _, _, _, 6, _, 4, _] },
    drums: { gain: 0.02, kick: 'x...x...x...x...', snare: '....x.......x...',
             hat: '..x...x...x...x.', rim: '..............x.' },
  },

  // ── The room ───────────────────────────────────────────────────────────

  // The storm. Player-sided -- only the person whose window it is raining on
  // hears it -- and the one theme allowed to be unpleasant. Locrian has no
  // stable fifth to sit on, the bass moves on every other step, and the lead
  // is a figure that keeps trying to land and cannot.
  storm: {
    name: 'Storm',
    bpm: 128, root: -24, scale: 'locrian', chords: [0, 1, 4, 6, 0, 3],
    pad: { gain: 0.05, cutoff: 600, wave: 'sawtooth', detune: 24 },
    bass: { gain: 0.072, wave: 'sawtooth', cutoff: 260, q: 5, sweep: 3, octave: -1,
      pattern: [0, _, 0, _, 1, _, 0, _, 0, _, 4, _, 0, 0, _, 1] },
    lead: { gain: 0.03, wave: 'sawtooth', cutoff: 1700, q: 8, sweep: 3.5, spread: 18, octave: 1,
      pattern: [4, _, 3, _, 4, _, 6, H, _, 4, _, 3, _, 1, _, _,
                6, _, 4, _, 3, _, 1, H, _, 0, _, 1, _, 3, 4, _] },
    arp: { gain: 0.028, every: 2, span: 9, jitter: 0.85, cutoff: 2600 },
    drums: { gain: 0.026, kick: 'x...x..xx...x...', snare: '....X.......X...',
             hat: '..x...x...x...x.' },
  },

  // The lights are out and something is in the room with you. Almost
  // nothing: a low drone and a heartbeat, which is what your ears do with
  // silence when you are already braced for a fright. Two kicks close
  // together and then a long gap -- a heartbeat, not a pulse.
  outage: {
    name: 'Power Cut',
    bpm: 54, root: -27, scale: 'locrian', chords: [0, 0, 1, 0],
    pad: { gain: 0.07, cutoff: 200, wave: 'triangle', detune: 32 },
    bass: { gain: 0.05, wave: 'sine', cutoff: 140, octave: -1, legato: 2,
      pattern: [0, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _] },
    lead: null,
    drums: { gain: 0.03, kick: 'x..x............' },
  },

  // Someone else's music, through a wall. A room event rather than anything
  // the game did -- and the reason the engine has an override layer at all.
  // Four-on-the-floor with the top end taken off: what you actually hear
  // through plasterboard is the kick and the bass and nothing else, so there
  // are no hats here at all. Those are the first thing a wall eats.
  neighbour: {
    name: 'Next Door',
    bpm: 126, root: -24, scale: 'minor', chords: [0, 0, 5, 3],
    pad: { gain: 0.045, cutoff: 190, wave: 'sawtooth' },
    bass: { gain: 0.075, wave: 'square', cutoff: 200, octave: -1,
      pattern: [0, _, _, 0, _, _, 0, _, 0, _, _, 0, _, 7, _, _] },
    lead: { gain: 0.014, wave: 'sawtooth', cutoff: 320, octave: 0,
      pattern: [0, _, _, _, 4, _, _, _, 3, _, _, _, 0, _, _, _] },
    drums: { gain: 0.028, kick: 'x...x...x...x...' },
  },

  // ── Outcomes ───────────────────────────────────────────────────────────

  // The word is up. Held, resolved, and out of the way of the reveal cue --
  // this plays for a few seconds and hands back, so it is a chord and a
  // breath rather than a piece of music.
  reveal: {
    name: 'The Word',
    bpm: 60, root: -21, scale: 'major', chords: [0, 4],
    pad: { gain: 0.05, cutoff: 1500, wave: 'triangle' },
    bass: { gain: 0.045, wave: 'sine', cutoff: 300, octave: -1, legato: 2,
      pattern: [0, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _] },
    lead: null,
    drums: null,
  },

  // Between rounds. Mid-tempo and a little funky -- you are reading a table,
  // not playing, so this is one of the few places a tune can have your
  // attention without costing you anything.
  standings: {
    name: 'Standings',
    bpm: 90, root: -21, scale: 'penta', chords: [0, 4, 2, 3],
    pad: { gain: 0.04, cutoff: 1500, wave: 'triangle' },
    bass: { gain: 0.058, wave: 'sine', cutoff: 360, octave: -1,
      pattern: [0, _, _, 0, _, _, 4, _, _, 0, _, _, 5, _, 4, _] },
    lead: { gain: 0.036, wave: 'triangle', cutoff: 3000, octave: 1,
      pattern: [_, _, 4, _, 5, H, _, 4, _, 2, _, _, 0, H, _, _,
                _, _, 7, _, 5, H, _, 4, _, 5, _, _, 4, H, 2, _] },
    drums: { gain: 0.02, kick: 'x.....x.x.......', snare: '....x.......x...',
             hat: '..x...x...x...x.' },
  },

  // You won. Major, unhurried, and the only theme with a fanfare in it: a
  // rising figure that lands on the octave and stays there. It should sound
  // like the thing you were playing for.
  victory: {
    name: 'Victory',
    bpm: 100, root: -21, scale: 'major', chords: [0, 4, 5, 3],
    pad: { gain: 0.058, cutoff: 2600, wave: 'triangle' },
    bass: { gain: 0.062, wave: 'sine', cutoff: 400, octave: -1,
      pattern: [0, _, _, _, 4, _, _, _, 2, _, _, _, 4, _, 5, _] },
    lead: { gain: 0.05, wave: 'sine', bell: true, cutoff: 4600, octave: 1,
      pattern: [0, _, 2, _, 4, _, 5, _, 7, H, H, _, 4, _, 7, _,
                9, _, 7, _, 5, _, 4, _, 7, H, H, H, H, _, _, _] },
    drums: { gain: 0.022, kick: 'x...x...x...x...', clap: '....x.......x...',
             hat: '..x...x...x...x.', open: '..............x.' },
  },

  // You did not. Minor and slow, but deliberately not miserable -- there is
  // another match in a minute, and a dirge would make losing one round of a
  // word game feel like more than it is. The line falls, then turns back up
  // at the end of every phrase.
  defeat: {
    name: 'Defeat',
    bpm: 74, root: -24, scale: 'minor', chords: [0, 5, 3, 4],
    pad: { gain: 0.055, cutoff: 900, wave: 'triangle' },
    bass: { gain: 0.05, wave: 'sine', cutoff: 280, octave: -1, legato: 1.6,
      pattern: [0, _, _, _, _, _, _, _, 4, _, _, _, _, _, _, _] },
    lead: { gain: 0.03, wave: 'triangle', cutoff: 1900, octave: 1,
      pattern: [7, H, _, 5, _, 4, H, _, 2, H, H, _, _, _, _, _,
                4, H, _, 2, _, 0, H, _, 2, H, H, H, _, _, _, _] },
    drums: { gain: 0.012, rim: '........x.......' },
  },

  // ── The arcade ─────────────────────────────────────────────────────────
  //
  // Four themes, not one. The picker keeps its own, and then each game gets
  // the music its particular kind of pressure deserves. A minigame played
  // for a personal best is the one place in this app where the music is
  // allowed to be the loudest thing happening.

  // Choosing a game. Bright and busy and going somewhere -- but nothing has
  // started yet, so no snare.
  arcade: {
    name: 'Arcade',
    // Major and square-wave, not pentatonic and triangle. Measured against
    // the menu theme it comes straight off, the two were sitting closer
    // together than any other pair the game plays back to back -- same mode,
    // same waveform, only the tempo apart.
    bpm: 108, root: -21, scale: 'major', chords: [0, 4, 5, 3],
    pad: { gain: 0.034, cutoff: 1700, wave: 'triangle' },
    bass: { gain: 0.06, wave: 'square', cutoff: 380, q: 3, sweep: 2, octave: -1,
      pattern: [0, _, 0, _, _, 4, _, _, 0, _, 0, _, _, 5, _, _] },
    lead: { gain: 0.034, wave: 'square', cutoff: 3400, q: 3, sweep: 2, octave: 1,
      pattern: [0, _, 2, _, 4, _, _, 2, _, 4, _, 5, 4, _, 2, _,
                7, _, 5, _, 4, _, _, 5, _, 4, _, 2, 0, _, _, _] },
    drums: { gain: 0.02, kick: 'x.......x...x...', hat: '..x...x...x...x.',
             rim: '....x.......x...' },
  },

  // Word Hunt: sixty seconds staring at a rack of letters. Rummaging music
  // -- a bouncy, wide-interval bell figure that keeps turning things over
  // and putting them back. Major pentatonic, so it is still friendly at
  // minute four of a session.
  arcade_hunt: {
    name: 'Word Hunt',
    bpm: 114, root: -21, scale: 'penta', chords: [0, 2, 4, 2],
    pad: { gain: 0.03, cutoff: 1900, wave: 'triangle' },
    bass: { gain: 0.062, wave: 'sine', cutoff: 400, octave: -1,
      pattern: [0, _, _, 0, _, 4, _, _, 0, _, _, 2, _, 5, _, _] },
    lead: { gain: 0.042, wave: 'sine', bell: true, cutoff: 4000, octave: 1,
      pattern: [0, _, 4, _, 2, _, 7, _, 5, _, 2, _, 4, _, _, _,
                7, _, 4, _, 9, _, 5, _, 7, _, 4, _, 2, _, 0, _] },
    drums: { gain: 0.024, kick: 'x...x.....x.x...', snare: '....x.......x...',
             hat: '..x...x...x...x.', open: '..............x.' },
  },

  // Chain: every word has to start where the last one ended. So does the
  // music -- the second bar of the hook begins on the note the first bar
  // finished on, over a bass that never stops moving forward. Dorian,
  // because it is the mode that sounds like it is on its way somewhere.
  arcade_chain: {
    name: 'Chain',
    bpm: 124, root: -21, scale: 'dorian', chords: [0, 3, 5, 3],
    pad: { gain: 0.03, cutoff: 1200, wave: 'sawtooth', detune: 6 },
    bass: { gain: 0.068, wave: 'sawtooth', cutoff: 320, q: 4, sweep: 2.5, octave: -1,
      pattern: [0, _, 0, 3, _, 0, _, 5, 0, _, 0, 3, _, 7, _, 5] },
    lead: { gain: 0.036, wave: 'square', cutoff: 2600, q: 3, sweep: 2, octave: 1,
      pattern: [0, _, 2, _, 3, _, 5, H, _, _, 3, _, 2, _, 0, _,
                0, _, -2, _, 0, _, 2, H, _, _, 3, _, 5, _, 7, _] },
    drums: { gain: 0.026, kick: 'x...x...x...x...', snare: '....x.......x.x.',
             hat: 'x.x.x.x.x.x.x.x.' },
  },

  // Moth Swat: reflexes, three lives, and a moth that will not hold still.
  // The fastest thing in the app. Phrygian for that flat second, a lead in
  // stabs rather than lines, and a snare that keeps arriving a sixteenth
  // early so you never quite settle into the bar.
  arcade_swat: {
    name: 'Moth Swat',
    bpm: 152, root: -21, scale: 'phryg', chords: [0, 0, 1, 0],
    pad: { gain: 0.024, cutoff: 700, wave: 'sawtooth', detune: 11 },
    bass: { gain: 0.072, wave: 'sawtooth', cutoff: 280, q: 5, sweep: 3, octave: -1,
      pattern: [0, 0, _, 0, _, 0, 1, _, 0, 0, _, 0, _, 1, _, 0] },
    lead: { gain: 0.03, wave: 'square', cutoff: 2400, q: 6, sweep: 3, spread: 9, octave: 1,
      pattern: [0, _, _, 1, _, _, 0, _, _, 4, _, 3, _, _, 1, _,
                _, 0, _, _, 1, _, 3, _, 4, _, _, 3, _, 1, 0, _] },
    drums: { gain: 0.03, kick: 'x...x...x...x...', snare: '....X.....X.X...',
             hat: 'x.x.x.x.x.x.x.x.', open: '..........x.....' },
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
// A jukebox pick lands on the next BEAT rather than the next bar. The bar
// wait is right for the game -- a modifier landing on a downbeat reads as the
// music responding -- but after clicking a track in a list, up to four
// seconds of the old theme reads as a broken button.
let swapOnBeat = false;
let step = 0;           // 16th notes since the theme started
let nextStepTime = 0;
let noiseBuf = null;

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

/**
 * One voice: an oscillator (or a detuned pair) -> resonant lowpass ->
 * envelope.
 *
 * `sweep` is most of why the saw themes have any life in them: the filter
 * opens at cutoff * sweep and closes to cutoff over the front of the note.
 * A static filter on a sawtooth is a buzz; a moving one is a synth.
 */
function voice({
  freq, at, dur, type = 'sine', gain, cutoff = 2000, q = 0.5,
  attack = 0.02, detune = 0, spread = 0, sweep = 1, sub = 0, glide = 0,
}) {
  const lp = ctx.createBiquadFilter();
  const env = ctx.createGain();

  lp.type = 'lowpass';
  lp.Q.setValueAtTime(q, at);
  if (sweep > 1) {
    lp.frequency.setValueAtTime(Math.min(18000, cutoff * sweep), at);
    lp.frequency.exponentialRampToValueAtTime(Math.max(60, cutoff), at + Math.min(dur * 0.8, 0.28));
  } else {
    lp.frequency.setValueAtTime(cutoff, at);
  }

  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), at + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  lp.connect(env).connect(out);

  // `spread` is in cents, one oscillator either side of the note. Two
  // slightly detuned saws is the cheapest way to make a lead sound like more
  // than a pocket calculator.
  const offsets = spread ? [-spread, spread] : [0];
  for (const off of offsets) {
    const osc = ctx.createOscillator();
    osc.type = type;
    if (glide) {
      osc.frequency.setValueAtTime(freq * 0.94, at);
      osc.frequency.exponentialRampToValueAtTime(freq, at + glide);
    } else {
      osc.frequency.setValueAtTime(freq, at);
    }
    osc.detune.setValueAtTime(detune + off, at);
    osc.connect(lp);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }
  if (sub > 0) {
    const s = ctx.createOscillator();
    const sg = ctx.createGain();
    s.type = 'sine';
    s.frequency.setValueAtTime(freq / 2, at);
    sg.gain.setValueAtTime(0.0001, at);
    sg.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * sub), at + attack);
    sg.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    s.connect(sg).connect(out);
    s.start(at);
    s.stop(at + dur + 0.05);
  }
}

/** A bell: the note, its octave, and a slightly-out third partial on top. */
function bell({ freq, at, dur, gain, cutoff }) {
  voice({ freq, at, dur, type: 'sine', gain, cutoff, attack: 0.006 });
  voice({ freq: freq * 2, at, dur: dur * 0.55, type: 'sine', gain: gain * 0.28, cutoff });
  voice({ freq: freq * 3.01, at, dur: dur * 0.3, type: 'sine', gain: gain * 0.1, cutoff });
}

// ── Drums ────────────────────────────────────────────────────────────────
// Small, dry and mixed low. This is a bed under a word game, not a kit in a
// room -- but it is a kit, which the single soft thump it replaced was not.

function noiseHit({ at, gain, dur, filterType, freq, q = 1, attack = 0 }) {
  const src = noiseSource();
  const f = ctx.createBiquadFilter();
  const env = ctx.createGain();
  f.type = filterType;
  f.frequency.setValueAtTime(freq, at);
  f.Q.setValueAtTime(q, at);
  // A shaker is the one percussion sound with no transient -- straight to
  // full gain gives it a click on the front and turns it into a hat.
  if (attack > 0) {
    env.gain.setValueAtTime(0.0001, at);
    env.gain.linearRampToValueAtTime(gain, at + attack);
  } else {
    env.gain.setValueAtTime(gain, at);
  }
  env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  src.connect(f).connect(env).connect(out);
  src.start(at);
  src.stop(at + dur + 0.02);
}

function kick(at, g) {
  // The pitch drop is what makes a sine a kick rather than a boop.
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(150, at);
  osc.frequency.exponentialRampToValueAtTime(42, at + 0.09);
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(g * 2.4, at + 0.004);
  env.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
  osc.connect(env).connect(out);
  osc.start(at);
  osc.stop(at + 0.25);
  noiseHit({ at, gain: g * 0.5, dur: 0.014, filterType: 'lowpass', freq: 2400 });
}

function snare(at, g) {
  // Two tuned tones for the shell, noise for the wires under it.
  voice({ freq: 186, at, dur: 0.1, type: 'triangle', gain: g * 0.9, cutoff: 1400, attack: 0.001 });
  voice({ freq: 331, at, dur: 0.08, type: 'triangle', gain: g * 0.5, cutoff: 1800, attack: 0.001 });
  noiseHit({ at, gain: g * 1.5, dur: 0.12, filterType: 'bandpass', freq: 1900, q: 0.7 });
}

function rim(at, g) {
  voice({ freq: 420, at, dur: 0.035, type: 'triangle', gain: g * 1.1, cutoff: 3600, attack: 0.001 });
  noiseHit({ at, gain: g * 0.7, dur: 0.03, filterType: 'bandpass', freq: 2600, q: 2 });
}

function clap(at, g) {
  // Three fast bursts and a tail: one burst is a slap, three is a room.
  for (const [d, m] of [[0, 0.7], [0.011, 0.9], [0.023, 1]]) {
    noiseHit({ at: at + d, gain: g * 1.3 * m, dur: 0.02, filterType: 'bandpass', freq: 1500, q: 0.9 });
  }
  noiseHit({ at: at + 0.03, gain: g * 0.8, dur: 0.12, filterType: 'bandpass', freq: 1300, q: 0.6 });
}

const hat = (at, g) => noiseHit({ at, gain: g, dur: 0.028, filterType: 'highpass', freq: 7200 });
const openHat = (at, g) => noiseHit({ at, gain: g * 0.85, dur: 0.18, filterType: 'highpass', freq: 6400 });

/** A shaker: noise with a fast, soft envelope -- no click at the front. */
function shaker(at, g) {
  noiseHit({ at, gain: g * 0.5, dur: 0.055, filterType: 'highpass', freq: 5200, attack: 0.008 });
}

/** A floor tom. Same trick as the kick, an octave up and slower. */
function tom(at, g) {
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(210, at);
  osc.frequency.exponentialRampToValueAtTime(96, at + 0.18);
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(g * 1.5, at + 0.006);
  env.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
  osc.connect(env).connect(out);
  osc.start(at);
  osc.stop(at + 0.34);
}

/** A ride: a long, bright wash that a closed hat cannot give you. */
function ride(at, g) {
  noiseHit({ at, gain: g * 0.34, dur: 0.42, filterType: 'highpass', freq: 7200 });
  noiseHit({ at, gain: g * 0.16, dur: 0.9, filterType: 'bandpass', freq: 4200 });
}

const DRUM_VOICES = { kick, snare, rim, clap, hat, open: openHat, shaker, tom, ride };

// ── Patterns ─────────────────────────────────────────────────────────────

/** How long a note at `i` lasts, in steps: itself plus every hold after it. */
function heldSteps(pattern, i) {
  let n = 1;
  while (n < pattern.length && pattern[(i + n) % pattern.length] === H) n++;
  return n;
}

/** Play one step of a written part (`bass` or `lead`). */
function playPattern(layer, { at, n, scale, chordRoot, stepSec }) {
  const pat = layer.pattern;
  const i = n % pat.length;
  const d = pat[i];
  if (d === null || d === undefined || d === H) return;

  const semis = theme.root + 12 * (layer.octave ?? 0) + degree(scale, chordRoot + d);
  const dur = heldSteps(pat, i) * stepSec * (layer.legato ?? 0.92);

  if (layer.bell) {
    bell({ freq: hz(semis), at, dur: Math.max(dur, 0.5), gain: layer.gain, cutoff: layer.cutoff });
    return;
  }
  voice({
    freq: hz(semis), at, dur,
    type: layer.wave ?? 'triangle',
    gain: layer.gain,
    cutoff: layer.cutoff ?? 2000,
    q: layer.q ?? 0.5,
    sweep: layer.sweep ?? 1,
    spread: layer.spread ?? 0,
    sub: layer.sub ?? 0,
    glide: layer.glide ?? 0,
    attack: layer.attack ?? 0.012,
  });
}

// ── Arrangement ──────────────────────────────────────────────────────────
//
// Without this a theme is one loop: the patterns repeat on `n % length` and
// the chords on `bar % chords.length`, so after two bars you have heard
// everything the piece will ever do. A four-minute round then plays that
// same two bars sixty times.
//
// `sections` fixes it by making the theme a running order rather than a
// loop. Each section says how many bars it lasts and what is playing during
// them -- `mute` drops layers out, and naming a layer replaces it for those
// bars only. Which is how arrangement actually works: the parts do not
// change, what changes is which of them you can hear.
//
//   sections: [
//     { bars: 4, mute: ['lead', 'drums'] },              // intro
//     { bars: 8 },                                       // everything
//     { bars: 4, mute: ['lead'], drums: { ...quieter } } // breakdown
//   ]
//
// A theme with no `sections` behaves exactly as it did before.
//
// The lookup is memoised on the bar number: it runs once every sixteen
// steps rather than on all of them, which matters because the scheduler is
// on a 25ms timer and everything in here is on the main thread.
let sectionCache = { theme: null, bar: -1, value: null };

function sectionFor(bar) {
  const list = theme.sections;
  if (!list?.length) return null;
  if (sectionCache.theme === theme && sectionCache.bar === bar) return sectionCache.value;

  const total = list.reduce((sum, sec) => sum + sec.bars, 0);
  let at = bar % total;
  let found = list[list.length - 1];
  for (const sec of list) {
    if (at < sec.bars) { found = sec; break; }
    at -= sec.bars;
  }
  sectionCache = { theme, bar, value: found };
  return found;
}

/**
 * The layer as this bar wants it: the theme's own, unless the section
 * silences it or supplies a different one.
 */
function layerFor(name, section) {
  const base = theme[name];
  if (!section) return base;
  if (section.mute?.includes(name)) return null;
  const over = section[name];
  if (!over) return base;
  return base ? { ...base, ...over } : over;
}

/** Everything that happens on one 16th note. */
function scheduleStep(n, at) {
  const scale = SCALES[theme.scale];
  const bar = Math.floor(n / STEPS_PER_BAR);
  const inBar = n % STEPS_PER_BAR;
  const section = sectionFor(bar);
  const chordRoot = theme.chords[bar % theme.chords.length];
  const stepSec = stepDuration();
  const barSeconds = stepSec * STEPS_PER_BAR;

  const pad = layerFor('pad', section);
  const bass = layerFor('bass', section);
  const lead = layerFor('lead', section);
  const counter = layerFor('counter', section);
  const arp = layerFor('arp', section);
  const drums = layerFor('drums', section);

  // Pad: one sustained chord per bar, three voices a third apart.
  if (pad && inBar === 0) {
    for (const offset of [0, 2, 4]) {
      const semis = theme.root + degree(scale, chordRoot + offset);
      voice({
        freq: hz(semis), at, dur: barSeconds * 1.05,
        type: pad.wave ?? 'triangle',
        gain: pad.gain, cutoff: pad.cutoff,
        attack: barSeconds * 0.3,
        detune: pad.detune ? (offset - 2) * pad.detune : 0,
      });
    }
  }

  if (bass) playPattern(bass, { at, n, scale, chordRoot, stepSec });
  if (lead) playPattern(lead, { at, n, scale, chordRoot, stepSec });
  // A second written line. The point of having one is that it can answer
  // the lead rather than double it -- so it gets its own pattern, usually a
  // different length, and the two drift in and out of phase.
  if (counter) playPattern(counter, { at, n, scale, chordRoot, stepSec });

  // Arp: walks the chord with `jitter` of its notes nudged off the pattern,
  // so a long round never settles into something you can hum along to. Kept
  // for the two themes that want movement without a tune -- the title
  // screen's shimmer and the storm's chaos.
  if (arp && inBar % arp.every === 0) {
    const idx = Math.floor(n / arp.every);
    let d = chordRoot + (idx % arp.span);
    if (Math.random() < arp.jitter) d += [2, 4, -2, 7][Math.floor(Math.random() * 4)];
    const semis = theme.root + 12 + degree(scale, d);
    const g = arp.gain * (0.65 + Math.random() * 0.35);
    voice({ freq: hz(semis), at, dur: 0.45, type: 'triangle', gain: g, cutoff: arp.cutoff, attack: 0.01 });
  }

  // Drums. Each part carries its own pattern, so they can disagree with each
  // other -- which is the only way a pattern ends up with any groove in it.
  if (drums) {
    const g = drums.gain;
    for (const part of Object.keys(DRUM_VOICES)) {
      const pat = drums[part];
      if (!pat) continue;
      const c = pat[n % pat.length];
      if (c === 'x') DRUM_VOICES[part](at, g);
      else if (c === 'X') DRUM_VOICES[part](at, g * 1.45);
    }
  }
}

function tick() {
  if (!ctx) return;
  while (nextStepTime < ctx.currentTime + HORIZON_S) {
    // A theme swap waits for the top of a bar. Cutting mid-bar is audible as
    // a mistake; landing on the downbeat reads as the music responding.
    if (pending && step % (swapOnBeat ? 4 : STEPS_PER_BAR) === 0) {
      theme = THEMES[pending] ?? THEMES.live;
      themeName = pending;
      pending = null;
      swapOnBeat = false;
      step = 0;
      if (out) {
        const now = ctx.currentTime;
        out.gain.cancelScheduledValues(now);
        out.gain.setValueAtTime(out.gain.value, now);
        out.gain.linearRampToValueAtTime(1, now + 0.5);
      }
    }
    // Swing pushes the off-16ths late. It shifts when a note SOUNDS, not the
    // grid it was scheduled on, so the bar still ends where it should and a
    // theme change still lands on the downbeat.
    const swing = theme.swing && step % 2 ? theme.swing * stepDuration() : 0;
    scheduleStep(step, nextStepTime + swing);
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

  /**
   * Like override(), but it takes effect on the next beat instead of the
   * next bar. For the jukebox, where the wait is a click's response time
   * rather than a musical transition.
   */
  cue(name) {
    if (!THEMES[name]) return;
    swapOnBeat = true;
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

/**
 * Every theme, in the order they are written, for the jukebox in the lobby.
 * Ordered rather than sorted: written order is roughly the order you meet
 * them playing, which is more use than alphabetical.
 */
export function tracks() {
  return Object.entries(THEMES).map(([id, t]) => ({ id, name: t.name, bpm: t.bpm }));
}

// Named for the tests, and for anyone wanting to hear a theme in isolation
// from the console.
export const __themes = THEMES;
