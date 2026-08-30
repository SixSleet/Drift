// The soundtrack. Generative -- written by the engine as you play, never a
// recording of a piece of music -- but PLAYED on real instruments: see
// instruments.js and assets/instruments/, which is the one place in this
// project that ships recorded audio. The drums, and the parts that are meant
// to sound electronic, are still oscillators.
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
import * as instruments from './instruments.js';

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
    pad: { inst: 'strings', gain: 0.042, cutoff: 1100, wave: 'triangle', voicing: [0, 2, 4, 6] },
    bass: { inst: 'upright', gain: 0.05, wave: 'sine', cutoff: 300, octave: -1, legato: 1.8,
      pattern: [0, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _] },
    lead: { inst: 'vibes', gain: 0.034, wave: 'sine', bell: true, cutoff: 3400, octave: 1,
      // Four bars, not two: a phrase and its answer. Two bars is a cell,
      // and a cell repeated is what "looped" actually sounds like.
      pattern: [4, H, H, H, _, _, 2, H, H, _, _, _, 0, H, H, H,
                _, _, _, _, 7, H, H, H, _, _, 4, H, H, _, _, _,
                7, H, H, H, _, _, 9, H, H, _, _, _, 7, H, H, H,
                _, _, _, _, 4, H, H, H, H, _, 2, H, H, H, _, _] },
    // Under the bell, in thirds. One number -- `interval: 2` -- and the
    // theme has two voices in it instead of one.
    harmony: { inst: 'strings', gain: 0.019, wave: 'triangle', cutoff: 2000, octave: 0, legato: 2.4,
      interval: 2, intervalGain: 0.75,
      vibrato: { rate: 4.4, depth: 9, delay: 0.5 },
      pattern: [_, _, _, _, _, _, _, _, _, _, _, _, 0, H, H, H,
                H, H, _, _, 4, H, H, H, H, _, _, _, _, _, _, _] },
    arp: { inst: 'nylon', gain: 0.022, every: 4, span: 5, jitter: 0.4, cutoff: 2200,
           wave: 'triangle', pluck: 0.5, dur: 0.9 },
    counter: { inst: 'vibes', gain: 0.02, wave: 'triangle', cutoff: 1600, octave: 0, legato: 2.2,
      pattern: [_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _,
                7, H, H, H, H, H, H, H, _, _, _, _, _, _, _, _] },
    // A plucked line, only in the bridge. It is the one place in the whole
    // theme where something is picked rather than struck or blown, which is
    // the point of having it.
    solo: { inst: 'nylon', gain: 0.03, wave: 'triangle', cutoff: 2600, octave: 0, legato: 0.8,
      pluck: 0.7,
      pattern: [_, _, 7, _, 9, _, 7, _, 4, _, _, 2, _, _, _, _,
                _, _, 4, _, 7, _, 9, _, 11, H, _, _, 9, _, 7, _,
                _, _, 2, _, 4, _, 2, _, 0, _, _, _, _, _, _, _] },
    drums: null,
    // Thirty-four bars. It opens on the pad alone, which is what a title
    // screen wants; the tune arrives once you have had a moment to look at
    // it; and then it goes somewhere -- six bars up a fourth, on a
    // progression this theme never otherwise plays, with the pluck on top.
    // That is a bridge, and it is what stops a menu you leave running for
    // ten minutes turning into a hold line.
    sections: [
      { bars: 2,  mute: ['lead', 'counter', 'arp', 'harmony', 'solo'] },
      { bars: 6,  mute: ['counter', 'solo'] },
      { bars: 8,  mute: ['solo'] },
      { bars: 6,  mute: ['lead', 'counter'], transpose: 5, chords: [0, 4, 2, 5] },
      { bars: 8,  mute: ['solo'] },
      { bars: 4,  mute: ['lead', 'solo', 'harmony'] },
    ],
  },

  // Waiting for people. The title's key, given a pulse and a walking bass:
  // the room is filling up and something is about to start.
  lobby: {
    name: 'Lobby',
    bpm: 82, root: -21, scale: 'penta', chords: [0, 4, 3, 4],
    pad: { inst: 'strings', gain: 0.036, cutoff: 1250, wave: 'triangle', voicing: [0, 2, 4, 6] },
    bass: { inst: 'upright', gain: 0.056, wave: 'sine', cutoff: 340, octave: -1,
      pattern: [0, _, _, _, 4, _, _, _, 2, _, _, _, 4, _, 5, _] },
    lead: { inst: 'rhodes', gain: 0.03, wave: 'triangle', cutoff: 2600, octave: 1,
      vibrato: { rate: 5.0, depth: 11, delay: 0.18 },
      pattern: [_, _, 0, _, 2, _, _, 4, H, _, _, 2, _, _, _, _,
                _, _, 4, _, 5, _, _, 7, H, H, _, _, 4, _, 2, _,
                _, _, 7, _, 5, _, _, 4, H, _, _, 5, _, _, _, _,
                _, _, 2, _, 4, _, _, 5, H, _, 4, _, 2, _, 0, _] },
    // Octave 2 is above the top of every sample set in the game, so this
    // one stays the synthesised bell it always was rather than being half
    // vibraphone and half oscillator depending on which note it is on.
    counter: { gain: 0.02, wave: 'sine', bell: true, cutoff: 3600, octave: 2,
      pattern: [_, _, _, _, _, _, _, _, 7, H, H, _, _, _, _, _,
                _, _, _, _, _, _, _, _, _, _, _, _, 4, H, H, _,
                _, _, _, _, 9, H, _, _, _, _, _, _, _, _, _, _] },
    // A guitar-ish figure between the bass and the tune, filling the half
    // of every bar the melody leaves empty. 24 steps against the lead's 32,
    // so the two only agree every three bars.
    harmony: { inst: 'nylon', gain: 0.022, wave: 'triangle', cutoff: 2100, octave: 0, legato: 0.7,
      pluck: 0.65, interval: 2, intervalGain: 0.5,
      pattern: [0, _, _, 4, _, _, 2, _, _, 4, _, _, 5, _, _, _,
                2, _, _, 0, _, _, 4, _] },
    solo: { inst: 'nylon', gain: 0.03, wave: 'triangle', cutoff: 3000, octave: 0, legato: 0.85,
      pluck: 0.55, vibrato: { rate: 5.6, depth: 16, delay: 0.1 },
      pattern: [_, 7, _, 9, _, 7, _, 4, 5, _, 4, _, 2, _, _, _,
                _, 4, _, 7, _, 9, _, 11, 9, _, 7, _, 4, _, 2, _,
                _, 2, _, 4, _, 5, _, 7, H, _, _, 4, _, _, _, _] },
    drums: { gain: 0.02, kick: 'x.......x.......', hat: '..x...x...x...x.',
             rim: '....x.......x...' },
    // Thirty-six bars, because a lobby is the one screen people genuinely
    // sit on for minutes at a time waiting for a friend to load. Bars 21-26
    // are the bridge: up a fourth, on a progression the theme has not used,
    // with the pluck taking the tune.
    sections: [
      { bars: 4,  mute: ['drums', 'counter', 'harmony', 'solo'] },
      { bars: 8,  mute: ['counter', 'solo'] },
      { bars: 8,  mute: ['solo'] },
      { bars: 6,  mute: ['lead', 'counter'], transpose: 5, chords: [0, 5, 3, 4],
        drums: { gain: 0.02, kick: 'x.....x.x.......', shaker: '..x...x...x...x.',
                 rim: '....x.......x...', crash: 'x...............' } },
      { bars: 6,  mute: ['solo'],
        drums: { gain: 0.022, kick: 'x...x...x...x...', hat: '..x...x...x...x.',
                 rim: '....x.......x...', crash: 'x...............' } },
      { bars: 4,  mute: ['lead', 'solo'],
        drums: { gain: 0.02, kick: 'x...x...x...x...', shaker: '..x...x...x...x.',
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
    pad: { inst: 'strings', gain: 0.05, cutoff: 900, wave: 'triangle', voicing: [0, 2, 4, 6] },
    bass: { inst: 'upright', gain: 0.05, wave: 'sine', cutoff: 420, octave: -1, legato: 1.4,
      pattern: [0, _, _, _, _, _, _, _, 0, _, _, _, _, _, 4, _,
                0, _, _, _, _, _, _, _, 2, _, _, _, _, _, _, _] },
    // Sparse on purpose: this plays while somebody is trying to think.
    lead: { inst: 'vibes', gain: 0.026, wave: 'sine', bell: true, cutoff: 3000, octave: 1,
      // Still four notes a bar at most -- somebody is trying to think --
      // but four bars of them, so the same note never lands in the same
      // place two bars running.
      pattern: [_, _, _, _, 4, H, H, _, _, _, _, _, _, _, _, _,
                _, _, 2, H, H, _, _, _, _, _, _, _, 0, H, H, _,
                _, _, _, _, _, _, _, _, 5, H, H, H, _, _, _, _,
                _, _, _, _, 4, H, H, H, _, _, _, _, 2, H, H, _] },
    counter: { inst: 'rhodes', gain: 0.018, wave: 'triangle', cutoff: 1800, octave: 1, legato: 1.6,
      pattern: [_, _, _, _, _, _, _, _, _, _, 7, H, H, H, _, _,
                _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _,
                _, _, _, _, _, _, 5, H, H, _, _, _, _, _, _, _] },
    // Thirds under the bell, and nothing else. Depth here has to come from
    // more voices rather than more notes -- Solo is the one theme whose job
    // is to be un-hummable, so a second line that MOVES would undo it.
    harmony: { inst: 'strings', gain: 0.014, wave: 'triangle', cutoff: 1500, octave: 0, legato: 2.6,
      interval: 2, intervalGain: 0.7,
      vibrato: { rate: 4.2, depth: 8, delay: 0.6 },
      pattern: [_, _, _, _, 0, H, H, H, H, H, _, _, _, _, _, _,
                _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _,
                _, _, _, _, _, _, 4, H, H, H, H, _, _, _, _, _] },
    // Almost inaudible, and only in the two calm sections: single plucked
    // notes a long way apart, like something ticking over in the room.
    solo: { inst: 'nylon', gain: 0.016, wave: 'triangle', cutoff: 2400, octave: 1, legato: 0.6,
      pluck: 0.5,
      pattern: [_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _,
                7, _, _, _, _, _, _, _, _, _, 4, _, _, _, _, _,
                _, _, _, _, _, _, _, _, 2, _, _, _, _, _, _, _,
                _, _, 5, _, _, _, _, _, _, _, _, _, _, _, _, _] },
    drums: { gain: 0.012, kick: 'x...............', hat: '........x.......',
             shaker: '..x...x...x...x.' },
    // Thirty-two bars before anything repeats, and the shape of it is a
    // round: settle, work, a lift when it has gone on a while, a stretch
    // where the harmony moves under a tune that does not, then back down.
    // A two-bar loop under a five-minute round is a metronome.
    sections: [
      { bars: 4,  mute: ['lead', 'counter', 'drums', 'harmony', 'solo'] },
      { bars: 6,  mute: ['counter', 'solo'] },
      { bars: 6,  mute: ['solo'] },
      // The one place the ground moves. Same tune, different chords under
      // it -- which is the quietest way a piece of music can go somewhere,
      // and quiet is the entire brief for this theme.
      { bars: 6,  mute: ['lead'], chords: [5, 4, 2, 3],
        drums: { gain: 0.014, kick: 'x.......x.......', hat: '..x...x...x...x.',
                 shaker: 'x.x.x.x.x.x.x.x.' } },
      { bars: 6,  mute: ['counter'] },
      { bars: 4,  mute: ['drums', 'counter', 'lead'] },
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
    pad: { gain: 0.026, cutoff: 640, wave: 'sawtooth', detune: 9, voicing: [0, 2, 4, 6] },
    bass: { inst: 'ebass', gain: 0.07, wave: 'sawtooth', cutoff: 300, q: 4, sweep: 3, octave: -1,
      pattern: [0, _, 0, 0, _, 0, _, 0, 0, _, 0, _, 0, 0, _, 7] },
    lead: { gain: 0.032, wave: 'sawtooth', cutoff: 2100, q: 7, sweep: 4, spread: 11, octave: 1,
      vibrato: { rate: 6.2, depth: 12, delay: 0.1 },
      pattern: [7, H, _, 4, _, 7, _, 9, 11, H, H, _, 9, _, 7, _,
                4, H, _, 7, _, 4, _, 2, 0, H, H, _, 2, 4, _, _,
                9, H, _, 7, _, 9, _, 11, 12, H, H, _, 11, _, 9, _,
                7, H, _, 4, _, 7, _, 9, 11, H, _, 9, 7, 4, _, _] },
    // A stab answering the lead across the bar line.
    counter: { inst: 'brass', gain: 0.024, wave: 'square', cutoff: 1400, q: 5, sweep: 2, octave: 0,
      pattern: [_, _, _, _, _, _, _, _, _, _, _, _, 0, 0, _, _,
                _, _, _, _, _, _, _, _, _, _, _, _, 5, _, 5, _] },
    // Fifths under the hook. Not thirds: at this tempo and on a saw, a
    // third turns into mud and a fifth turns into a wall.
    harmony: { gain: 0.02, wave: 'sawtooth', cutoff: 1600, q: 4, sweep: 2.5, octave: 0,
      interval: 4, intervalGain: 0.55,
      pattern: [7, H, H, H, _, _, _, _, 4, H, H, H, _, _, _, _,
                5, H, H, H, _, _, _, _, 2, H, H, H, _, _, _, _] },
    // Sixteen bars in, the hook stops and something else takes it: a
    // narrower, brighter saw playing a line that is all upbeats, over the
    // bridge's chords. This is the only part of the theme that is allowed
    // to sound like a person is playing it.
    solo: { gain: 0.034, wave: 'sawtooth', cutoff: 2600, q: 9, sweep: 5, spread: 16, octave: 1,
      vibrato: { rate: 7, depth: 22, delay: 0.06 },
      pattern: [_, 11, _, 9, _, 7, _, 11, _, 12, H, _, 9, _, 7, _,
                _, 9, _, 7, _, 4, _, 9, _, 11, H, _, 7, _, 4, _,
                _, 7, _, 9, _, 11, _, 12, 14, H, H, _, 12, _, 11, _,
                _, 9, _, 7, _, 9, _, 11, 9, H, _, _, _, _, _, _] },
    drums: { gain: 0.028, kick: 'x...x...x...x...', snare: '....X.......X...',
             hat: '..x...x...x...x.', open: '..............x.' },
    // Forty bars. Build, everything, a four-bar drop where only the hats
    // carry it -- which is what makes the kick coming back land -- then the
    // solo over a new progression a minor third up, then home. A duel that
    // is flat out from the first bar has nowhere left to go by round three.
    sections: [
      { bars: 4,  mute: ['lead', 'counter', 'harmony', 'solo'],
        drums: { gain: 0.024, kick: 'x...x...x...x...', hat: '..x...x...x...x.' } },
      { bars: 8,  mute: ['counter', 'solo'] },
      { bars: 8,  mute: ['solo'] },
      { bars: 4,  mute: ['pad', 'solo', 'lead'],
        drums: { gain: 0.03, snare: '....X.......X..X', hat: 'x.x.x.x.x.x.x.x.',
                 ride: '....x.......x...' } },
      { bars: 8,  mute: ['lead', 'counter'], transpose: 3, chords: [0, 6, 5, 0],
        drums: { gain: 0.03, kick: 'x...x...x...x...', snare: '....X.......X...',
                 hat: 'x.x.x.x.x.x.x.x.', crash: 'x...............' } },
      { bars: 8,  mute: ['solo'],
        drums: { gain: 0.03, kick: 'x...x...x...x...', snare: '....X.......X..X',
                 hat: 'x.x.x.x.x.x.x.x.', open: '..............x.',
                 crash: 'x...............' } },
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
    pad: { inst: 'strings', gain: 0.044, cutoff: 1150, wave: 'triangle', detune: 6, voicing: [0, 2, 4, 6] },
    // Walking, rather than one note every other bar. The old bass had four
    // notes in sixteen steps and the lead had five in thirty-two, which is
    // not "chill", it is "not much happening" -- there is a difference, and
    // the first version was the second thing.
    bass: { inst: 'upright', gain: 0.058, wave: 'sine', cutoff: 260, octave: -1, legato: 1.2,
      pattern: [0, _, _, 4, _, _, 2, _, 0, _, _, 4, _, 7, _, 5] },
    // A shimmer under the tune. Slow enough not to pull at you, and the one
    // layer that makes the gaps in the melody feel like space rather than
    // like silence. Plucked now, so the shimmer has an edge on it.
    arp: { inst: 'nylon', gain: 0.02, every: 4, span: 6, jitter: 0.25, cutoff: 2600,
           pluck: 0.45, dur: 0.7 },
    lead: { inst: 'vibes', gain: 0.03, wave: 'sine', bell: true, cutoff: 3200, octave: 1,
      pattern: [_, _, 4, _, 5, _, 7, H, _, 4, _, 2, _, _, _, _,
                _, _, 7, _, 9, _, 7, H, _, 5, _, 4, 2, _, _, _,
                _, _, 2, _, 4, _, 5, H, _, 7, _, 5, _, _, _, _,
                _, _, 4, _, 2, _, 0, H, H, _, _, 2, 4, _, _, _] },
    counter: { inst: 'rhodes', gain: 0.02, wave: 'triangle', cutoff: 1500, octave: 0, legato: 1.5,
      pattern: [_, _, _, _, _, _, _, _, 5, H, H, _, _, _, _, _,
                _, _, _, _, 2, H, H, _, _, _, _, _, _, _, _, _,
                _, _, 7, H, H, H, _, _, _, _, _, _, _, _, _, _,
                _, _, _, _, _, _, _, _, _, _, 4, H, H, _, _, _] },
    // Sixths under the bell -- the interval that makes a dorian tune sound
    // like two people playing rather than one playing louder.
    harmony: { inst: 'nylon', gain: 0.017, wave: 'triangle', cutoff: 1900, octave: 0, legato: 1.4,
      interval: 5, intervalGain: 0.65,
      vibrato: { rate: 4.6, depth: 10, delay: 0.35 },
      pattern: [_, _, _, _, 0, H, H, H, _, _, _, _, 4, H, H, H,
                _, _, _, _, 2, H, H, H, _, _, _, _, _, _, _, _,
                _, _, 5, H, H, H, _, _, _, _, _, _, 0, H, H, _] },
    // The only line in the game written for the swing rather than despite
    // it: every note lands on an off-16th, which is where the fifth-of-a-
    // step delay lives. Plucked and quiet -- a thumb on a nylon string.
    solo: { inst: 'nylon', gain: 0.026, wave: 'triangle', cutoff: 2800, octave: 1, legato: 0.75,
      pluck: 0.7,
      pattern: [_, _, _, 4, _, _, 5, _, _, 7, _, _, 9, _, 7, _,
                _, _, _, 5, _, _, 4, _, _, 2, _, _, 0, _, 2, _,
                _, _, _, 7, _, _, 9, _, _, 11, _, _, 9, _, 7, _,
                _, _, _, 4, _, _, 5, _, _, 4, _, _, 2, _, _, _] },
    drums: { gain: 0.016, kick: 'x.....x.x.......', rim: '....x.......x...',
             hat: '..x...x...x...x.', open: '..............x.' },
    // The counter line is 48 steps against the lead's 32, so the two only
    // line up every three bars -- which is most of why this one keeps
    // sounding like it is going somewhere. Forty bars total, with eight in
    // the middle where the bell steps aside for the plucked solo over a
    // progression that walks down instead of round.
    sections: [
      { bars: 4,  mute: ['lead', 'counter', 'drums', 'harmony', 'solo'] },
      { bars: 8,  mute: ['counter', 'solo'] },
      { bars: 8,  mute: ['solo'] },
      { bars: 8,  mute: ['lead', 'counter'], chords: [5, 4, 3, 0],
        drums: { gain: 0.017, kick: 'x.......x.......', shaker: '..x...x...x...x.',
                 rim: '....x.......x...', crash: 'x...............' } },
      { bars: 8,  mute: ['solo'],
        drums: { gain: 0.018, kick: 'x.....x.x.......', shaker: '..x...x...x...x.',
                 rim: '....x.......x...', tom: '..............x.' } },
      { bars: 4,  mute: ['drums', 'solo', 'lead'] },
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
    pad: { gain: 0.026, cutoff: 780, wave: 'sawtooth', voicing: [0, 2, 4, 6] },
    bass: { inst: 'ebass', gain: 0.066, wave: 'square', cutoff: 340, q: 3, sweep: 2.5, octave: -1,
      pattern: [0, _, 0, _, 0, _, 0, _, 0, _, 0, _, 0, _, 0, _] },
    lead: { gain: 0.03, wave: 'square', cutoff: 2800, q: 4, sweep: 2, octave: 1,
      pattern: [0, _, 2, _, 4, _, 2, _, 5, _, 4, _, 2, _, 0, _,
                7, _, 5, _, 4, _, 5, _, 4, _, 2, _, 0, _, 2, _] },
    // Octaves rather than an interval: the clock is the point, and an
    // octave is the one doubling that adds weight without adding harmony
    // for you to listen to instead of the timer.
    harmony: { gain: 0.018, wave: 'square', cutoff: 1500, q: 3, sweep: 2, octave: 0,
      interval: 7, intervalGain: 0.5,
      pattern: [0, _, _, _, 4, _, _, _, 5, _, _, _, 4, _, _, _] },
    solo: { gain: 0.028, wave: 'square', cutoff: 3400, q: 6, sweep: 3, spread: 8, octave: 2,
      vibrato: { rate: 7.5, depth: 20, delay: 0.05 },
      pattern: [_, _, 7, _, 5, _, 7, _, 9, _, 7, _, 5, _, 4, _,
                _, _, 5, _, 4, _, 5, _, 7, _, 5, _, 4, _, 2, _] },
    drums: { gain: 0.028, kick: 'x...x...x...x...', snare: '....X.......X...',
             hat: 'x.x.x.x.x.x.x.x.', open: '..............x.' },
    // Twenty bars. The last four are the ones that matter: a semitone up,
    // and the solo on top -- the round is running out and the music knows.
    sections: [
      { bars: 4,  mute: ['solo', 'harmony'] },
      { bars: 8,  mute: ['solo'] },
      { bars: 4,  mute: ['lead'],
        drums: { gain: 0.03, kick: 'x.x.x.x.x.x.x.x.', snare: '....X.......X..X',
                 hat: 'x.x.x.x.x.x.x.x.' } },
      { bars: 4,  mute: ['lead'], transpose: 1,
        drums: { gain: 0.032, kick: 'x...x...x...x...', snare: '....X...X...X..X',
                 hat: 'x.x.x.x.x.x.x.x.', crash: 'x...............' } },
    ],
  },

  // Double Points. Warm and major, with a bell hook that keeps climbing --
  // it should sound like good news arriving.
  double_points: {
    name: 'Double Points',
    bpm: 96, root: -21, scale: 'major', chords: [0, 3, 5, 4],
    pad: { inst: 'strings', gain: 0.05, cutoff: 1700, wave: 'triangle', voicing: [0, 2, 4, 6] },
    bass: { inst: 'upright', gain: 0.055, wave: 'sine', cutoff: 380, octave: -1,
      pattern: [0, _, _, _, _, _, 4, _, 2, _, _, _, _, _, 4, _] },
    lead: { inst: 'vibes', gain: 0.042, wave: 'sine', bell: true, cutoff: 4200, octave: 1,
      pattern: [4, _, 6, _, 7, H, _, _, 6, _, 4, _, 2, H, _, _,
                7, _, 6, _, 4, H, _, _, 2, _, 4, _, 6, H, H, _] },
    // Thirds under a major bell hook, which is the most straightforwardly
    // pleasant sound in this whole file, and this is the theme for good news.
    harmony: { inst: 'nylon', gain: 0.022, wave: 'triangle', cutoff: 2400, octave: 0, legato: 1.3,
      interval: 2, intervalGain: 0.7, pluck: 0.5,
      pattern: [0, _, _, 4, _, _, 2, _, _, 4, _, _, 5, _, 4, _] },
    counter: { inst: 'flute', gain: 0.018, wave: 'triangle', cutoff: 2000, octave: 1, legato: 1.4,
      vibrato: { rate: 5, depth: 12, delay: 0.2 },
      pattern: [_, _, _, _, _, _, _, _, 9, H, H, H, _, _, _, _,
                _, _, _, _, 7, H, H, _, _, _, _, _, _, _, _, _,
                _, _, 11, H, H, H, _, _, _, _, _, _, _, _, _, _] },
    drums: { gain: 0.016, kick: 'x.......x...x...', hat: '..x...x...x...x.',
             rim: '....x.......x...' },
    sections: [
      { bars: 4,  mute: ['counter', 'harmony'] },
      { bars: 8,  mute: ['counter'] },
      { bars: 4,  chords: [3, 4, 5, 5],
        drums: { gain: 0.018, kick: 'x...x...x...x...', clap: '....x.......x...',
                 hat: '..x...x...x...x.', crash: 'x...............' } },
      { bars: 4 },
    ],
  },

  // Blackout. The legend has gone dark and so has the music: no top end at
  // all, a sub you feel more than hear, and one slow pulse. The only theme
  // with nothing on the beat except that pulse.
  blackout: {
    name: 'Blackout',
    bpm: 68, root: -24, scale: 'minor', chords: [0, 1, 0, 4],
    pad: { inst: 'strings', gain: 0.06, cutoff: 340, wave: 'triangle', detune: 12 },
    bass: { inst: 'upright', gain: 0.062, wave: 'sine', cutoff: 160, octave: -1, legato: 2,
      pattern: [0, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _] },
    lead: null,
    drums: { gain: 0.02, kick: 'x.......x.......' },
    // Even here. Four bars of one chord and one pulse is a held breath;
    // twelve, where the chord underneath moves once and the pulse doubles
    // before it lets go, is dread. The brief was "almost nothing", not
    // "nothing", and those are different.
    sections: [
      { bars: 4 },
      { bars: 4, chords: [1, 1, 0, 5] },
      { bars: 4, drums: { gain: 0.022, kick: 'x.......x...x...' } },
    ],
  },

  // Jackpot. The one theme allowed to be loud, and the only one that gets a
  // clap. Bouncing bass, bell hook, hats wide open: a machine paying out.
  jackpot: {
    name: 'Jackpot',
    bpm: 118, root: -21, scale: 'major', chords: [0, 4, 5, 4],
    pad: { gain: 0.042, cutoff: 2600, wave: 'sawtooth', detune: 7, voicing: [0, 2, 4, 6] },
    bass: { inst: 'ebass', gain: 0.07, wave: 'square', cutoff: 420, q: 3, sweep: 2.5, octave: -1,
      pattern: [0, _, _, 0, _, 4, _, _, 0, _, _, 0, _, 7, _, 4] },
    lead: { inst: 'vibes', gain: 0.05, wave: 'sine', bell: true, cutoff: 5000, octave: 1,
      pattern: [7, _, 9, _, 11, _, 9, _, 7, H, _, 4, _, 7, _, _,
                11, _, 9, _, 7, _, 9, _, 11, H, H, _, _, 9, 7, _] },
    // Sixths on a saw, panning-bright: the sound of a machine that is very
    // pleased with itself.
    harmony: { inst: 'brass', gain: 0.026, wave: 'sawtooth', cutoff: 2600, q: 2, sweep: 2.5, octave: 0,
      interval: 5, intervalGain: 0.6,
      pattern: [4, H, H, H, _, _, _, _, 7, H, H, H, _, _, _, _,
                9, H, H, H, _, _, _, _, 7, H, H, H, _, _, _, _] },
    solo: { gain: 0.036, wave: 'square', cutoff: 4200, q: 5, sweep: 3, spread: 10, octave: 2,
      vibrato: { rate: 6.6, depth: 24, delay: 0.06 },
      pattern: [_, _, 0, _, 2, _, 4, _, 5, _, 7, _, 9, _, 11, _,
                12, H, _, 11, _, 9, _, 7, 9, H, H, _, _, _, _, _] },
    drums: { gain: 0.03, kick: 'x...x...x...x...', clap: '....x.......x...',
             hat: 'x.x.x.x.x.x.x.x.', open: '......x.......x.' },
    sections: [
      { bars: 4,  mute: ['solo'] },
      { bars: 4,  mute: ['lead'], transpose: 2,
        drums: { gain: 0.032, kick: 'x...x...x...x...', clap: '....x.......x..x',
                 hat: 'x.x.x.x.x.x.x.x.', crash: 'x...............' } },
      { bars: 4,  mute: ['solo'] },
    ],
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
    pad: { inst: 'strings', gain: 0.038, cutoff: 1400, wave: 'triangle', detune: 6, voicing: [0, 2, 4, 6] },
    bass: { inst: 'upright', gain: 0.062, wave: 'sine', cutoff: 340, octave: -1,
      pattern: [0, _, _, 0, _, 4, _, _, 0, _, _, 2, _, 4, _, _] },
    lead: { inst: 'rhodes', gain: 0.038, wave: 'triangle', cutoff: 3000, octave: 1,
      vibrato: { rate: 5.4, depth: 13, delay: 0.14 },
      pattern: [0, _, 2, _, 4, H, _, 2, 0, _, _, _, 4, _, 2, _,
                2, _, 4, _, 6, H, _, 4, 2, _, _, _, 6, _, 4, _] },
    // The harmony gets the joke too: it is the same shape a third up, so
    // when the tune moves the whole stack moves with it.
    harmony: { inst: 'nylon', gain: 0.02, wave: 'triangle', cutoff: 2000, octave: 0, legato: 1.1,
      interval: 2, intervalGain: 0.65, pluck: 0.55,
      pattern: [_, _, 0, _, _, _, 4, _, _, _, 2, _, _, _, _, _,
                _, _, 2, _, _, _, 6, _, _, _, 4, _, _, _, _, _] },
    drums: { gain: 0.02, kick: 'x...x...x...x...', snare: '....x.......x...',
             hat: '..x...x...x...x.', rim: '..............x.' },
    // Four bars of it in the wrong place, which is the event in one move.
    sections: [
      { bars: 4,  mute: ['harmony'] },
      { bars: 8 },
      { bars: 4,  transpose: 2, chords: [3, 4, 0, 5],
        drums: { gain: 0.022, kick: 'x..x..x...x.x...', snare: '....x.......x..x',
                 hat: '..x...x...x...x.', crash: 'x...............' } },
    ],
  },

  // ── The room ───────────────────────────────────────────────────────────

  // The storm. Player-sided -- only the person whose window it is raining on
  // hears it -- and the one theme allowed to be unpleasant. Locrian has no
  // stable fifth to sit on, the bass moves on every other step, and the lead
  // is a figure that keeps trying to land and cannot.
  storm: {
    name: 'Storm',
    bpm: 128, root: -24, scale: 'locrian', chords: [0, 1, 4, 6, 0, 3],
    pad: { inst: 'strings', gain: 0.05, cutoff: 600, wave: 'sawtooth', detune: 24 },
    bass: { gain: 0.072, wave: 'sawtooth', cutoff: 260, q: 5, sweep: 3, octave: -1,
      pattern: [0, _, 0, _, 1, _, 0, _, 0, _, 4, _, 0, 0, _, 1] },
    lead: { gain: 0.03, wave: 'sawtooth', cutoff: 1700, q: 8, sweep: 3.5, spread: 18, octave: 1,
      // The vibrato is wide and slow enough to be audibly wrong, which is
      // the only place in the game that is a compliment.
      vibrato: { rate: 3.1, depth: 38, delay: 0.05 },
      pattern: [4, _, 3, _, 4, _, 6, H, _, 4, _, 3, _, 1, _, _,
                6, _, 4, _, 3, _, 1, H, _, 0, _, 1, _, 3, 4, _] },
    // Tritones. In locrian, `interval: 3` off the root IS the interval the
    // mode is named for -- the one that will not resolve. Everything else
    // here is trying to land; this is the layer that says it cannot.
    harmony: { gain: 0.018, wave: 'sawtooth', cutoff: 1200, q: 6, sweep: 2, octave: 0,
      interval: 3, intervalGain: 0.7,
      pattern: [0, H, H, H, H, H, H, H, 1, H, H, H, H, H, H, H] },
    arp: { gain: 0.028, every: 2, span: 9, jitter: 0.85, cutoff: 2600 },
    drums: { gain: 0.026, kick: 'x...x..xx...x...', snare: '....X.......X...',
             hat: '..x...x...x...x.' },
    sections: [
      { bars: 6,  mute: ['harmony'] },
      { bars: 6 },
      { bars: 6,  mute: ['lead'],
        drums: { gain: 0.028, kick: 'x..xx..xx..xx..x', snare: '....X...X...X..X',
                 hat: 'x.x.x.x.x.x.x.x.', crash: 'x...............' } },
    ],
  },

  // The lights are out and something is in the room with you. Almost
  // nothing: a low drone and a heartbeat, which is what your ears do with
  // silence when you are already braced for a fright. Two kicks close
  // together and then a long gap -- a heartbeat, not a pulse.
  outage: {
    name: 'Power Cut',
    bpm: 54, root: -27, scale: 'locrian', chords: [0, 0, 1, 0],
    pad: { inst: 'strings', gain: 0.07, cutoff: 200, wave: 'triangle', detune: 32 },
    bass: { inst: 'upright', gain: 0.05, wave: 'sine', cutoff: 140, octave: -1, legato: 2,
      pattern: [0, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _] },
    lead: null,
    drums: { gain: 0.03, kick: 'x..x............' },
    // The heartbeat gets faster. Nothing else changes, and nothing else
    // needs to.
    sections: [
      { bars: 4 },
      { bars: 4, drums: { gain: 0.032, kick: 'x..x........x..x' } },
      { bars: 4, transpose: -1, drums: { gain: 0.034, kick: 'x..x....x..x....' } },
    ],
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
    bass: { inst: 'ebass', gain: 0.075, wave: 'square', cutoff: 200, octave: -1,
      pattern: [0, _, _, 0, _, _, 0, _, 0, _, _, 0, _, 7, _, _] },
    lead: { gain: 0.014, wave: 'sawtooth', cutoff: 320, octave: 0,
      pattern: [0, _, _, _, 4, _, _, _, 3, _, _, _, 0, _, _, _] },
    drums: { gain: 0.028, kick: 'x...x...x...x...' },
    // The track next door changes. You would not hear the transition
    // through a wall -- you would hear the bass line become a different
    // bass line, which is all this does.
    sections: [
      { bars: 6 },
      { bars: 6, chords: [3, 3, 0, 5],
        bass: { gain: 0.075, wave: 'square', cutoff: 200, octave: -1,
          pattern: [0, _, 0, _, _, 5, _, _, 0, _, 0, _, _, 3, _, _] },
        drums: { gain: 0.03, kick: 'x...x...x...x..x' } },
    ],
  },

  // ── Outcomes ───────────────────────────────────────────────────────────

  // The word is up. Held, resolved, and out of the way of the reveal cue --
  // this plays for a few seconds and hands back, so it is a chord and a
  // breath rather than a piece of music.
  reveal: {
    name: 'The Word',
    bpm: 60, root: -21, scale: 'major', chords: [0, 4],
    pad: { inst: 'strings', gain: 0.05, cutoff: 1500, wave: 'triangle' },
    bass: { inst: 'upright', gain: 0.045, wave: 'sine', cutoff: 300, octave: -1, legato: 2,
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
    pad: { inst: 'strings', gain: 0.038, cutoff: 1500, wave: 'triangle', voicing: [0, 2, 4, 6] },
    bass: { inst: 'upright', gain: 0.058, wave: 'sine', cutoff: 360, octave: -1,
      pattern: [0, _, _, 0, _, _, 4, _, _, 0, _, _, 5, _, 4, _] },
    lead: { inst: 'rhodes', gain: 0.036, wave: 'triangle', cutoff: 3000, octave: 1,
      vibrato: { rate: 5.1, depth: 12, delay: 0.16 },
      pattern: [_, _, 4, _, 5, H, _, 4, _, 2, _, _, 0, H, _, _,
                _, _, 7, _, 5, H, _, 4, _, 5, _, _, 4, H, 2, _] },
    // A plucked comp between the bass and the tune -- 24 steps against the
    // lead's 32, so the two never land in the same place twice running.
    harmony: { inst: 'nylon', gain: 0.024, wave: 'triangle', cutoff: 2200, octave: 0, legato: 0.65,
      pluck: 0.7, interval: 2, intervalGain: 0.5,
      pattern: [_, _, 0, _, _, 4, _, _, 2, _, _, 5, _, _, 4, _,
                _, _, 2, _, _, 0, _, _] },
    // You are reading a table, not playing. This is one of two places in
    // the game where a line is allowed to have your attention outright.
    solo: { inst: 'flute', gain: 0.03, wave: 'triangle', cutoff: 3200, octave: 1, legato: 0.8,
      pluck: 0.5, vibrato: { rate: 5.8, depth: 18, delay: 0.1 },
      pattern: [_, 7, _, 9, _, 7, _, 5, 4, _, _, 2, _, _, _, _,
                _, 5, _, 7, _, 9, _, 11, 9, _, 7, _, 5, _, 4, _,
                _, 2, _, 4, _, 5, _, 7, H, H, _, _, 4, _, 2, _] },
    drums: { gain: 0.02, kick: 'x.....x.x.......', snare: '....x.......x...',
             hat: '..x...x...x...x.' },
    sections: [
      { bars: 4,  mute: ['solo', 'harmony'] },
      { bars: 8,  mute: ['solo'] },
      { bars: 6,  mute: ['lead'], chords: [3, 2, 4, 0],
        drums: { gain: 0.021, kick: 'x...x...x...x...', rim: '....x.......x...',
                 shaker: '..x...x...x...x.', crash: 'x...............' } },
      { bars: 6,  mute: ['solo'] },
    ],
  },

  // You won. Major, unhurried, and the only theme with a fanfare in it: a
  // rising figure that lands on the octave and stays there. It should sound
  // like the thing you were playing for.
  victory: {
    name: 'Victory',
    bpm: 100, root: -21, scale: 'major', chords: [0, 4, 5, 3],
    pad: { inst: 'strings', gain: 0.055, cutoff: 2600, wave: 'triangle', voicing: [0, 2, 4, 6] },
    bass: { inst: 'upright', gain: 0.062, wave: 'sine', cutoff: 400, octave: -1,
      pattern: [0, _, _, _, 4, _, _, _, 2, _, _, _, 4, _, 5, _] },
    lead: { inst: 'brass', gain: 0.05, wave: 'sine', bell: true, cutoff: 4600, octave: 1,
      pattern: [0, _, 2, _, 4, _, 5, _, 7, H, H, _, 4, _, 7, _,
                9, _, 7, _, 5, _, 4, _, 7, H, H, H, H, _, _, _] },
    // The fanfare, harmonised in thirds. A rising figure in one voice is a
    // scale; the same figure in two is a fanfare.
    harmony: { inst: 'brass', gain: 0.028, wave: 'triangle', cutoff: 2600, octave: 0, legato: 1.1,
      interval: 2, intervalGain: 0.75,
      vibrato: { rate: 5.2, depth: 12, delay: 0.25 },
      pattern: [0, _, _, _, 4, _, _, _, 7, H, H, H, _, _, _, _,
                5, _, _, _, 4, _, _, _, 7, H, H, H, H, H, _, _] },
    counter: { inst: 'nylon', gain: 0.022, wave: 'triangle', cutoff: 2200, octave: 0, legato: 0.7,
      pluck: 0.65,
      pattern: [_, _, 4, _, _, 7, _, _, 9, _, _, 7, _, _, 5, _,
                _, _, 7, _, _, 9, _, _, 11, _, _, 9, _, _, 7, _] },
    drums: { gain: 0.022, kick: 'x...x...x...x...', clap: '....x.......x...',
             hat: '..x...x...x...x.', open: '..............x.' },
    sections: [
      { bars: 2,  mute: ['counter'],
        drums: { gain: 0.024, kick: 'x...x...x...x...', clap: '....x.......x...',
                 hat: '..x...x...x...x.', crash: 'x...............' } },
      { bars: 6 },
      { bars: 4,  transpose: 2, mute: ['counter'],
        drums: { gain: 0.024, kick: 'x...x...x...x...', clap: '....x.......x..x',
                 hat: 'x.x.x.x.x.x.x.x.', crash: 'x...............' } },
      { bars: 4 },
    ],
  },

  // You did not. Minor and slow, but deliberately not miserable -- there is
  // another match in a minute, and a dirge would make losing one round of a
  // word game feel like more than it is. The line falls, then turns back up
  // at the end of every phrase.
  defeat: {
    name: 'Defeat',
    bpm: 74, root: -24, scale: 'minor', chords: [0, 5, 3, 4],
    pad: { inst: 'strings', gain: 0.052, cutoff: 900, wave: 'triangle', voicing: [0, 2, 4, 6] },
    bass: { inst: 'upright', gain: 0.05, wave: 'sine', cutoff: 280, octave: -1, legato: 1.6,
      pattern: [0, _, _, _, _, _, _, _, 4, _, _, _, _, _, _, _] },
    lead: { inst: 'rhodes', gain: 0.03, wave: 'triangle', cutoff: 1900, octave: 1,
      vibrato: { rate: 4.4, depth: 15, delay: 0.3 },
      pattern: [7, H, _, 5, _, 4, H, _, 2, H, H, _, _, _, _, _,
                4, H, _, 2, _, 0, H, _, 2, H, H, H, _, _, _, _] },
    // Sixths, which is the interval that stops a minor line being a dirge.
    // There is another match in a minute.
    harmony: { inst: 'strings', gain: 0.018, wave: 'triangle', cutoff: 1500, octave: 0, legato: 2,
      interval: 5, intervalGain: 0.7,
      pattern: [0, H, H, H, H, H, H, H, _, _, _, _, _, _, _, _,
                4, H, H, H, H, H, H, H, _, _, _, _, _, _, _, _] },
    counter: { inst: 'nylon', gain: 0.02, wave: 'triangle', cutoff: 2000, octave: 1, legato: 0.7,
      pluck: 0.6,
      pattern: [_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _,
                _, _, _, _, _, _, _, _, _, _, 7, _, 5, _, 4, _,
                _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _,
                _, _, _, _, _, _, _, _, 2, _, 4, _, 5, _, _, _] },
    drums: { gain: 0.012, rim: '........x.......' },
    // It turns up at the end. The last four bars are the relative major --
    // same notes, different home -- which is the sound of it not mattering
    // as much as it did thirty seconds ago.
    sections: [
      { bars: 4,  mute: ['counter', 'harmony'] },
      { bars: 6,  mute: ['counter'] },
      { bars: 4,  chords: [2, 4, 0, 5],
        drums: { gain: 0.013, rim: '........x.......', shaker: '..x...x...x...x.' } },
    ],
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
    pad: { gain: 0.032, cutoff: 1700, wave: 'triangle', voicing: [0, 2, 4, 6] },
    bass: { inst: 'ebass', gain: 0.06, wave: 'square', cutoff: 380, q: 3, sweep: 2, octave: -1,
      pattern: [0, _, 0, _, _, 4, _, _, 0, _, 0, _, _, 5, _, _] },
    lead: { gain: 0.034, wave: 'square', cutoff: 3400, q: 3, sweep: 2, octave: 1,
      vibrato: { rate: 6, depth: 14, delay: 0.1 },
      pattern: [0, _, 2, _, 4, _, _, 2, _, 4, _, 5, 4, _, 2, _,
                7, _, 5, _, 4, _, _, 5, _, 4, _, 2, 0, _, _, _] },
    harmony: { gain: 0.02, wave: 'square', cutoff: 2000, q: 2, sweep: 2, octave: 0,
      interval: 2, intervalGain: 0.6,
      pattern: [0, H, H, H, _, _, _, _, 4, H, H, H, _, _, _, _,
                5, H, H, H, _, _, _, _, 2, H, H, H, _, _, _, _] },
    drums: { gain: 0.02, kick: 'x.......x...x...', hat: '..x...x...x...x.',
             rim: '....x.......x...' },
    sections: [
      { bars: 4,  mute: ['harmony'] },
      { bars: 8 },
      { bars: 4,  mute: ['lead'], chords: [3, 5, 4, 4],
        drums: { gain: 0.021, kick: 'x...x...x...x...', rim: '....x.......x...',
                 shaker: '..x...x...x...x.', crash: 'x...............' } },
    ],
  },

  // Word Hunt: sixty seconds staring at a rack of letters. Rummaging music
  // -- a bouncy, wide-interval bell figure that keeps turning things over
  // and putting them back. Major pentatonic, so it is still friendly at
  // minute four of a session.
  arcade_hunt: {
    name: 'Word Hunt',
    bpm: 114, root: -21, scale: 'penta', chords: [0, 2, 4, 2],
    pad: { inst: 'strings', gain: 0.028, cutoff: 1900, wave: 'triangle', voicing: [0, 2, 4, 6] },
    bass: { inst: 'upright', gain: 0.062, wave: 'sine', cutoff: 400, octave: -1,
      pattern: [0, _, _, 0, _, 4, _, _, 0, _, _, 2, _, 5, _, _] },
    lead: { inst: 'vibes', gain: 0.042, wave: 'sine', bell: true, cutoff: 4000, octave: 1,
      pattern: [0, _, 4, _, 2, _, 7, _, 5, _, 2, _, 4, _, _, _,
                7, _, 4, _, 9, _, 5, _, 7, _, 4, _, 2, _, 0, _] },
    // A plucked line rummaging along underneath the bell, 24 steps against
    // its 32 -- the two turn things over and put them back in a different
    // order every three bars, which is the game.
    harmony: { inst: 'nylon', gain: 0.024, wave: 'triangle', cutoff: 2400, octave: 0, legato: 0.6,
      pluck: 0.7, interval: 2, intervalGain: 0.5,
      pattern: [0, _, _, 2, _, _, 4, _, _, 2, _, _, 5, _, _, 4,
                _, _, 2, _, _, 0, _, _] },
    drums: { gain: 0.024, kick: 'x...x.....x.x...', snare: '....x.......x...',
             hat: '..x...x...x...x.', open: '..............x.' },
    sections: [
      { bars: 4,  mute: ['harmony'] },
      { bars: 8 },
      { bars: 4,  mute: ['lead'], chords: [4, 2, 0, 2],
        drums: { gain: 0.026, kick: 'x...x...x...x...', snare: '....x.......x..x',
                 hat: 'x.x.x.x.x.x.x.x.', crash: 'x...............' } },
    ],
  },

  // Chain: every word has to start where the last one ended. So does the
  // music -- the second bar of the hook begins on the note the first bar
  // finished on, over a bass that never stops moving forward. Dorian,
  // because it is the mode that sounds like it is on its way somewhere.
  arcade_chain: {
    name: 'Chain',
    bpm: 124, root: -21, scale: 'dorian', chords: [0, 3, 5, 3],
    pad: { gain: 0.028, cutoff: 1200, wave: 'sawtooth', detune: 6, voicing: [0, 2, 4, 6] },
    bass: { inst: 'ebass', gain: 0.068, wave: 'sawtooth', cutoff: 320, q: 4, sweep: 2.5, octave: -1,
      pattern: [0, _, 0, 3, _, 0, _, 5, 0, _, 0, 3, _, 7, _, 5] },
    lead: { gain: 0.036, wave: 'square', cutoff: 2600, q: 3, sweep: 2, octave: 1,
      vibrato: { rate: 6.4, depth: 15, delay: 0.08 },
      pattern: [0, _, 2, _, 3, _, 5, H, _, _, 3, _, 2, _, 0, _,
                0, _, -2, _, 0, _, 2, H, _, _, 3, _, 5, _, 7, _] },
    // Fourths. The interval that hands you on to the next thing rather
    // than settling, which is the whole rule of this game.
    harmony: { inst: 'brass', gain: 0.02, wave: 'sawtooth', cutoff: 1700, q: 3, sweep: 2, octave: 0,
      interval: 3, intervalGain: 0.55,
      pattern: [0, H, H, H, H, H, H, H, 3, H, H, H, H, H, H, H] },
    drums: { gain: 0.026, kick: 'x...x...x...x...', snare: '....x.......x.x.',
             hat: 'x.x.x.x.x.x.x.x.' },
    sections: [
      { bars: 4,  mute: ['harmony'] },
      { bars: 8 },
      { bars: 4,  mute: ['lead'], chords: [5, 3, 0, 3], transpose: 3,
        drums: { gain: 0.028, kick: 'x..x..x.x..x..x.', snare: '....x.......x.x.',
                 hat: 'x.x.x.x.x.x.x.x.', crash: 'x...............' } },
    ],
  },

  // Moth Swat: reflexes, three lives, and a moth that will not hold still.
  // The fastest thing in the app. Phrygian for that flat second, a lead in
  // stabs rather than lines, and a snare that keeps arriving a sixteenth
  // early so you never quite settle into the bar.
  arcade_swat: {
    name: 'Moth Swat',
    bpm: 152, root: -21, scale: 'phryg', chords: [0, 0, 1, 0],
    pad: { gain: 0.024, cutoff: 700, wave: 'sawtooth', detune: 11 },
    bass: { inst: 'ebass', gain: 0.072, wave: 'sawtooth', cutoff: 280, q: 5, sweep: 3, octave: -1,
      pattern: [0, 0, _, 0, _, 0, 1, _, 0, 0, _, 0, _, 1, _, 0] },
    lead: { gain: 0.03, wave: 'square', cutoff: 2400, q: 6, sweep: 3, spread: 9, octave: 1,
      vibrato: { rate: 7.8, depth: 18, delay: 0.05 },
      pattern: [0, _, _, 1, _, _, 0, _, _, 4, _, 3, _, _, 1, _,
                _, 0, _, _, 1, _, 3, _, 4, _, _, 3, _, 1, 0, _] },
    // The flat second, held under everything. Phrygian's whole character
    // is that one note, so this is the theme saying its own name.
    harmony: { gain: 0.016, wave: 'sawtooth', cutoff: 1300, q: 4, sweep: 2, octave: 0,
      interval: 1, intervalGain: 0.6,
      pattern: [0, H, H, H, H, H, H, H, H, H, H, H, H, H, H, H] },
    solo: { gain: 0.028, wave: 'square', cutoff: 3600, q: 7, sweep: 3.5, spread: 12, octave: 2,
      vibrato: { rate: 8.4, depth: 26, delay: 0.04 },
      pattern: [_, 7, _, 8, _, 7, _, 4, 3, _, 1, _, 0, _, _, _,
                _, 4, _, 3, _, 1, _, 0, 1, _, 3, _, 4, _, 7, _] },
    drums: { gain: 0.03, kick: 'x...x...x...x...', snare: '....X.....X.X...',
             hat: 'x.x.x.x.x.x.x.x.', open: '..........x.....' },
    sections: [
      { bars: 4,  mute: ['solo', 'harmony'] },
      { bars: 8,  mute: ['solo'] },
      { bars: 4,  mute: ['lead'], transpose: 1,
        drums: { gain: 0.032, kick: 'x..xx...x..xx...', snare: '....X.....X.X..X',
                 hat: 'x.x.x.x.x.x.x.x.', crash: 'x...............' } },
      { bars: 4,  mute: ['solo'] },
    ],
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

// ── Humanising ───────────────────────────────────────────────────────────
//
// A sequencer plays every note exactly on the grid at exactly the same
// volume, and that is most of what "sounds looped" actually is. It is not
// the repetition -- a four-bar loop played by a person does not sound
// looped -- it is that the second time round is bit-identical to the first.
//
// Two numbers fix most of it. `feel` pushes a note a few milliseconds off
// the grid, and the velocity varies per note, with the notes that land on a
// beat played harder than the ones between them. Both are small: 8ms and
// 15% are below the threshold where you would call it sloppy and well above
// the one where a bar stops being a photocopy of the last bar.
const HUMAN_MS = 8;
const drift = (amount = 1) => (Math.random() * 2 - 1) * (HUMAN_MS / 1000) * amount;

/** Beat 1 hardest, the other beats next, the notes between them lightest. */
function accent(step) {
  const inBar = ((step % STEPS_PER_BAR) + STEPS_PER_BAR) % STEPS_PER_BAR;
  const base = inBar === 0 ? 1.12 : inBar % 4 === 0 ? 1.0 : inBar % 2 === 0 ? 0.88 : 0.8;
  return base * (0.92 + Math.random() * 0.16);
}

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
  vibrato = null, pluck = 0,
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

  // A plucked string is a hard transient and then a body that is already
  // fading before you have finished hearing the attack. The transient is a
  // few milliseconds of filtered noise at the note's own pitch -- the same
  // trick as the finger on the string -- and the filter shutting fast
  // underneath it is what stops it reading as an organ with a click.
  if (pluck > 0) {
    const tick = noiseSource();
    const tf = ctx.createBiquadFilter();
    const tg = ctx.createGain();
    tf.type = 'bandpass';
    tf.frequency.setValueAtTime(Math.min(9000, freq * 4), at);
    tf.Q.setValueAtTime(1.4, at);
    tg.gain.setValueAtTime(gain * pluck, at);
    tg.gain.exponentialRampToValueAtTime(0.0001, at + 0.035);
    tick.connect(tf).connect(tg).connect(out);
    tick.start(at);
    tick.stop(at + 0.06);
    lp.frequency.cancelScheduledValues(at);
    lp.frequency.setValueAtTime(Math.min(18000, cutoff * 3.4), at);
    lp.frequency.exponentialRampToValueAtTime(Math.max(80, cutoff * 0.55), at + Math.min(dur, 0.5));
  }

  // One LFO for the whole note, shared by both spread oscillators. A lead
  // that holds a note dead still is the single clearest tell that a part
  // was written rather than played.
  let vib = null;
  if (vibrato) {
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(vibrato.rate ?? 5.2, at);
    // Cents, ramped in: vibrato that is already at full width on the
    // attack sounds like a broken tape, not like a player leaning on it.
    depth.gain.setValueAtTime(0, at);
    depth.gain.linearRampToValueAtTime(vibrato.depth ?? 14, at + Math.min(dur * 0.5, vibrato.delay ?? 0.12));
    lfo.connect(depth);
    lfo.start(at);
    lfo.stop(at + dur + 0.05);
    vib = depth;
  }

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
    vib?.connect(osc.detune);
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

/** A crash: bright, long, and the only drum allowed to ring over a bar line. */
function crash(at, g) {
  noiseHit({ at, gain: g * 1.15, dur: 1.5, filterType: 'highpass', freq: 3800 });
  noiseHit({ at, gain: g * 0.5, dur: 0.9, filterType: 'bandpass', freq: 6400, q: 0.4 });
}

/** A stick click. No body at all -- it is the count-in, not a drum. */
function stick(at, g) {
  noiseHit({ at, gain: g * 0.7, dur: 0.014, filterType: 'bandpass', freq: 2400, q: 2.4 });
}

const DRUM_VOICES = {
  kick, snare, rim, clap, hat, open: openHat, shaker, tom, ride, crash, stick,
};

// ── Patterns ─────────────────────────────────────────────────────────────

/** How long a note at `i` lasts, in steps: itself plus every hold after it. */
function heldSteps(pattern, i) {
  let n = 1;
  while (n < pattern.length && pattern[(i + n) % pattern.length] === H) n++;
  return n;
}

/**
 * Play one step of a written part. `root` comes from the caller rather than
 * from the theme, because a section is allowed to transpose -- see the
 * arrangement notes below.
 *
 * `harmony` is what makes one written line into two: give the layer an
 * `interval` in scale degrees and every note it plays gets a second voice
 * that many degrees above, in the key. Two degrees is a third, four is a
 * fifth. That is one number for the difference between a tune and a part.
 */
function playPattern(layer, { at, n, scale, chordRoot, stepSec, root }) {
  const pat = layer.pattern;
  const i = n % pat.length;
  const d = pat[i];
  if (d === null || d === undefined || d === H) return;

  const dur = heldSteps(pat, i) * stepSec * (layer.legato ?? 0.92);
  const voices = layer.interval ? [d, d + layer.interval] : [d];
  // One offset for the whole chord: a harmony note that drifts away from
  // the note it is harmonising is a mistake, not a feel.
  const when = at + drift(layer.feel ?? 1);
  const push = accent(n);

  voices.forEach((deg, k) => {
    const semis = root + 12 * (layer.octave ?? 0) + degree(scale, chordRoot + deg);
    // The harmony note sits under the melody note, never level with it.
    const gain = layer.gain * push * (k === 0 ? 1 : (layer.intervalGain ?? 0.6));

    // A real recording of the instrument if we have one in range, and the
    // oscillator underneath if we do not. Same call site, same pattern, so
    // a theme reads the same whether its samples have arrived yet or not.
    if (layer.inst && instruments.play(layer.inst, {
      freq: hz(semis), at: when, dur, gain: gain * (layer.instGain ?? 1),
      cutoff: layer.instCutoff ?? 0, wet: layer.wet ?? 0.18,
      attack: layer.instAttack ?? 0.004,
    })) return;

    if (layer.bell) {
      bell({ freq: hz(semis), at: when, dur: Math.max(dur, 0.5), gain, cutoff: layer.cutoff });
      return;
    }
    voice({
      freq: hz(semis), at: when, dur,
      type: layer.wave ?? 'triangle',
      gain,
      cutoff: layer.cutoff ?? 2000,
      q: layer.q ?? 0.5,
      sweep: layer.sweep ?? 1,
      spread: layer.spread ?? 0,
      sub: layer.sub ?? 0,
      glide: layer.glide ?? 0,
      attack: layer.attack ?? 0.012,
      vibrato: layer.vibrato ?? null,
      pluck: layer.pluck ?? 0,
    });
  });
}

// The written melodic parts, in the order they are scheduled. Adding a name
// here is all it takes for a theme to gain another line -- they all go
// through the same playPattern, and `sections` can mute or replace any of
// them by name.
const VOICES = ['bass', 'lead', 'counter', 'harmony', 'solo'];

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
// A section can also change the harmony under those bars, which is what
// separates a bridge from a quieter verse:
//
//   `chords`     a different progression for this section only. Muting
//                layers gets you dynamics; changing the chords is the only
//                way to get somewhere new.
//   `transpose`  semitones, added to the theme's root. +5 for the section
//                that lifts and then comes back is the oldest trick there
//                is and it still works.
//
// And `solo` is just another written line that most sections mute: name it
// in one section and nowhere else, and the theme has a solo in it.
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
  // The section's harmony if it has one, otherwise the theme's.
  const chords = section?.chords ?? theme.chords;
  const chordRoot = chords[bar % chords.length];
  const root = theme.root + (section?.transpose ?? 0);
  const stepSec = stepDuration();
  const barSeconds = stepSec * STEPS_PER_BAR;

  const pad = layerFor('pad', section);
  const arp = layerFor('arp', section);
  const drums = layerFor('drums', section);

  // Pad: one sustained chord per bar, three voices a third apart -- four
  // where the theme asks for a seventh, which is the difference between a
  // chord that sits there and one that leans somewhere.
  if (pad && inBar === 0) {
    for (const offset of (pad.voicing ?? [0, 2, 4])) {
      const semis = root + degree(scale, chordRoot + offset);
      // Each note of the chord placed slightly separately, because a string
      // section does not start four notes on the same millisecond.
      const when = at + drift(pad.feel ?? 2.5);
      if (pad.inst && instruments.play(pad.inst, {
        freq: hz(semis), at: when, dur: barSeconds * 0.98,
        gain: pad.gain * (pad.instGain ?? 1), cutoff: pad.instCutoff ?? 0,
        wet: pad.wet ?? 0.42, attack: pad.instAttack ?? barSeconds * 0.22,
      })) continue;
      voice({
        freq: hz(semis), at: when, dur: barSeconds * 1.05,
        type: pad.wave ?? 'triangle',
        gain: pad.gain, cutoff: pad.cutoff,
        attack: barSeconds * 0.3,
        detune: pad.detune ? (offset - 2) * pad.detune : 0,
      });
    }
  }

  // Every written line, through the same path. The reason to have more than
  // one is that they can answer each other rather than double up -- so each
  // gets its own pattern, usually a different length, and they drift in and
  // out of phase over a long round.
  for (const name of VOICES) {
    const layer = layerFor(name, section);
    if (layer) playPattern(layer, { at, n, scale, chordRoot, stepSec, root });
  }

  // Arp: walks the chord with `jitter` of its notes nudged off the pattern,
  // so a long round never settles into something you can hum along to. Kept
  // for the two themes that want movement without a tune -- the title
  // screen's shimmer and the storm's chaos.
  if (arp && inBar % arp.every === 0) {
    const idx = Math.floor(n / arp.every);
    let d = chordRoot + (idx % arp.span);
    if (Math.random() < arp.jitter) d += [2, 4, -2, 7][Math.floor(Math.random() * 4)];
    const semis = root + 12 * (arp.octave ?? 1) + degree(scale, d);
    const g = arp.gain * (0.65 + Math.random() * 0.35);
    voice({ freq: hz(semis), at, dur: arp.dur ?? 0.45, type: arp.wave ?? 'triangle',
            gain: g, cutoff: arp.cutoff, attack: 0.01, pluck: arp.pluck ?? 0 });
  }

  // Drums. Each part carries its own pattern, so they can disagree with each
  // other -- which is the only way a pattern ends up with any groove in it.
  if (drums) {
    const g = drums.gain;
    for (const part of Object.keys(DRUM_VOICES)) {
      const pat = drums[part];
      if (!pat) continue;
      const c = pat[n % pat.length];
      if (c !== 'x' && c !== 'X') continue;
      // Every limb slightly out with every other one. A kit where the kick
      // and the hat are on the same sample is a drum machine -- which is
      // fine for the Duel and is not what Together wants.
      const lean = part === 'kick' ? 0.4 : part === 'snare' ? 0.9 : 1.4;
      const at2 = at + drift(lean);
      const vel = g * (c === 'X' ? 1.45 : 1) * (0.9 + Math.random() * 0.2);
      DRUM_VOICES[part](at2, vel);
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
/**
 * Every instrument a theme could ask for, including the ones that only
 * appear in a section override. Walked once per theme change, not per step
 * -- `preload` is idempotent but this still has no business in the
 * scheduler's hot loop.
 */
function instrumentsIn(t) {
  const names = new Set();
  const take = (layer) => { if (layer?.inst) names.add(layer.inst); };
  for (const key of [...VOICES, 'pad', 'arp']) take(t[key]);
  for (const sec of t.sections ?? []) for (const key of [...VOICES, 'pad', 'arp']) take(sec[key]);
  return names;
}

function apply() {
  const name = wanted();
  if (!running) return;
  if (name === themeName && !pending) return;
  if (pending === name) return;
  pending = name;
  // Start fetching now, while the current theme plays out its bar. If they
  // are not decoded by the time the first note lands, that note comes out
  // of an oscillator and the second one does not.
  for (const inst of instrumentsIn(THEMES[name] ?? {})) instruments.preload(inst);
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
