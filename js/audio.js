// The one AudioContext, and the two buses everything else hangs off.
//
// sfx.js and music.js both need to make sound, and a browser gives you a
// limited number of AudioContexts -- so neither of them owns one. This does,
// and hands each a bus with its own gain:
//
//   ctx.destination
//     └── master (mute)
//           ├── sfxBus    (sfx volume)
//           └── musicBus  (music volume)
//
// Two independent volumes matters here: the music is a bed that plays
// continuously, while the cues are short and land on top of it. Being able
// to keep the cues and turn the bed down (or off) is the setting people
// actually want, and one combined slider can't express it.
//
// Nothing is created until the first sound is asked for: browsers refuse to
// start audio before a user gesture, and by the time anything here is called
// the player has clicked something.

const KEY = { muted: 'wf-muted', sfx: 'wf-vol-sfx', music: 'wf-vol-music' };

// Defaults. Music sits deliberately under the cues -- it is scenery, and a
// bed that competes with the tile-flip chimes is a bed you turn off.
const DEFAULT_SFX = 0.5;
const DEFAULT_MUSIC = 0.34;

function readNum(key, fallback) {
  try {
    const v = parseFloat(localStorage.getItem(key));
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : fallback;
  } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, String(value)); } catch { /* private mode */ }
}

let muted = (() => {
  try { return localStorage.getItem(KEY.muted) === '1'; } catch { return false; }
})();
let sfxVolume = readNum(KEY.sfx, DEFAULT_SFX);
let musicVolume = readNum(KEY.music, DEFAULT_MUSIC);

let ctx = null;
let master = null;
let sfxBus = null;
let musicBus = null;

function build() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  ctx = new AC();
  master = ctx.createGain();
  sfxBus = ctx.createGain();
  musicBus = ctx.createGain();
  master.gain.value = muted ? 0 : 1;
  sfxBus.gain.value = sfxVolume;
  musicBus.gain.value = musicVolume;
  sfxBus.connect(master);
  musicBus.connect(master);
  master.connect(ctx.destination);
  return true;
}

/**
 * The context, built on first use and resumed if the browser suspended it.
 * Returns null when muted, so every caller's existing `if (!c) return` guard
 * keeps working as the mute check.
 */
export function ensureAudio() {
  if (muted) return null;
  if (!ctx && !build()) return null;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/**
 * The context WITHOUT the mute guard. The music engine needs this: it keeps
 * its scheduler running while muted (silently, since master is at 0) so that
 * unmuting resumes mid-phrase instead of restarting the track.
 */
export function audioContext() {
  if (!ctx && !build()) return null;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

export const buses = {
  get sfx() { return sfxBus; },
  get music() { return musicBus; },
};

/** Ramp rather than jump: a step change on a live gain node clicks. */
function ramp(node, value) {
  if (!node || !ctx) return;
  const now = ctx.currentTime;
  node.gain.cancelScheduledValues(now);
  node.gain.setValueAtTime(node.gain.value, now);
  node.gain.linearRampToValueAtTime(value, now + 0.06);
}

export const volume = {
  get muted() { return muted; },
  get sfx() { return sfxVolume; },
  get music() { return musicVolume; },

  setMuted(next) {
    muted = !!next;
    write(KEY.muted, muted ? '1' : '0');
    ramp(master, muted ? 0 : 1);
    return muted;
  },
  toggleMuted() { return this.setMuted(!muted); },

  setSfx(v) {
    sfxVolume = Math.min(1, Math.max(0, v));
    write(KEY.sfx, sfxVolume);
    ramp(sfxBus, sfxVolume);
    return sfxVolume;
  },

  setMusic(v) {
    musicVolume = Math.min(1, Math.max(0, v));
    write(KEY.music, musicVolume);
    ramp(musicBus, musicVolume);
    return musicVolume;
  },
};
