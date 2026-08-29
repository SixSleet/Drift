// The room you can touch.
//
// Everything else in here is scenery that happens at you: the cat decides to
// walk across the desk, the lamp decides to flicker. This file is the other
// direction -- three things in the room that answer to you rather than to a
// timer.
//
//   the lamp     click the shade to pull the switch. The whole room relights:
//                the wall wash, the pool on the desk, the warm side of every
//                object. What is left is the monitor, which is the only other
//                light source, so the room goes blue.
//   the window   click it to slide the sash up. Night air comes in, the
//                curtain moves in it, and you can hear outside.
//   the clock    not clickable, but it is set to the real time and keeps it.
//                A clock frozen at a decorative 10:10 is worse than no clock.
//
// Both switches are remembered per browser. Someone who plays with the lamp
// off is telling you how they want the room to look, and asking them again
// every visit would be forgetting it on purpose.
//
// The lighting is done with one class on #room-scene and CSS custom
// properties, NOT by animating each prop: a class flip is a single style
// recalculation, where walking twenty elements would be twenty. Nothing here
// runs per frame -- the clock ticks once a minute and the rest is idle.

import { sfx } from './sfx.js';
import { ensureAudio, buses } from './audio.js';

const $ = (sel) => document.querySelector(sel);
const KEY = { lamp: 'wf-room-lamp', window: 'wf-room-window' };

const read = (key, fallback) => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch { return fallback; }
};
const write = (key, on) => {
  try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* private mode */ }
};

// ── State ────────────────────────────────────────────────────────────────

let lampOn = read(KEY.lamp, true);
let windowOpen = read(KEY.window, false);

/** Read by room-events.js: a lamp that is off has nothing to flicker. */
export const roomState = {
  get lampOn() { return lampOn; },
  get windowOpen() { return windowOpen; },
};

// ── Night air ────────────────────────────────────────────────────────────
//
// One noise source through a low-pass, running only while the window is
// open. Filtered noise is what wind through a gap actually is, and it costs
// one buffer and two nodes rather than a loop of samples to download.

let air = null;

function startAir() {
  const c = ensureAudio();
  if (!c || air) return;
  const buf = c.createBuffer(1, c.sampleRate * 3, c.sampleRate);
  const d = buf.getChannelData(0);
  // Brown-ish noise: integrating white noise tilts it toward the low end,
  // which is the difference between "wind" and "static".
  let last = 0;
  for (let i = 0; i < d.length; i++) {
    last = (last + Math.random() * 2 - 1) * 0.5;
    d[i] = last;
  }
  const src = c.createBufferSource();
  src.buffer = buf;
  src.loop = true;

  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 420;

  const gain = c.createGain();
  gain.gain.setValueAtTime(0.0001, c.currentTime);
  gain.gain.linearRampToValueAtTime(0.055, c.currentTime + 1.6);

  // A slow wander on the cutoff, so it breathes instead of hissing. One
  // oscillator at 0.06Hz -- the audio thread does this, not a timer.
  const lfo = c.createOscillator();
  const lfoGain = c.createGain();
  lfo.frequency.value = 0.06;
  lfoGain.gain.value = 180;
  lfo.connect(lfoGain).connect(lp.frequency);

  src.connect(lp).connect(gain).connect(buses.sfx);
  src.start();
  lfo.start();
  air = { src, gain, lfo, ctx: c };
}

function stopAir() {
  if (!air) return;
  const { src, gain, lfo, ctx } = air;
  air = null;
  const t = ctx.currentTime;
  gain.gain.cancelScheduledValues(t);
  gain.gain.setValueAtTime(gain.gain.value, t);
  gain.gain.linearRampToValueAtTime(0.0001, t + 0.9);
  src.stop(t + 1);
  lfo.stop(t + 1);
}

// ── The switches ─────────────────────────────────────────────────────────

function paint() {
  const room = $('#room-scene');
  if (!room) return;
  room.classList.toggle('is-lamp-off', !lampOn);
  room.classList.toggle('is-window-open', windowOpen);
  $('#lamp-switch')?.setAttribute('aria-pressed', String(lampOn));
  $('#window-switch')?.setAttribute('aria-pressed', String(windowOpen));
}

export function setLamp(on, { silent = false } = {}) {
  if (on === lampOn) return lampOn;
  lampOn = !!on;
  write(KEY.lamp, lampOn);
  paint();
  if (!silent) sfx.lampSwitch(lampOn);
  return lampOn;
}

export function setWindow(open, { silent = false } = {}) {
  if (open === windowOpen) return windowOpen;
  windowOpen = !!open;
  write(KEY.window, windowOpen);
  paint();
  if (!silent) sfx.windowSlide(windowOpen);
  if (windowOpen) startAir(); else stopAir();
  return windowOpen;
}

// ── The clock ────────────────────────────────────────────────────────────

function tickClock() {
  const el = $('.wall-clock');
  if (!el) return;
  const now = new Date();
  const mins = now.getMinutes();
  // 30° per hour plus the half-degree per minute that stops the hour hand
  // sitting exactly on the numeral at twenty-five past.
  el.style.setProperty('--hour', `${((now.getHours() % 12) + mins / 60) * 30}deg`);
  el.style.setProperty('--minute', `${mins * 6}deg`);
}

// ── Boot ─────────────────────────────────────────────────────────────────

export function startRoom() {
  paint();
  tickClock();
  // Once a minute, and aligned to the minute so the hand moves when the
  // clock does rather than 40 seconds after it.
  setTimeout(() => {
    tickClock();
    setInterval(tickClock, 60_000);
  }, (60 - new Date().getSeconds()) * 1000);

  $('#lamp-switch')?.addEventListener('click', (e) => {
    e.stopPropagation();
    setLamp(!lampOn);
  });
  $('#window-switch')?.addEventListener('click', (e) => {
    e.stopPropagation();
    setWindow(!windowOpen);
  });

  // The air only exists once there has been a gesture, so a window left open
  // from last visit starts silent and comes in on the first click anywhere.
  if (windowOpen) {
    const wake = () => { startAir(); document.removeEventListener('pointerdown', wake); };
    document.addEventListener('pointerdown', wake, { once: true });
  }
}
