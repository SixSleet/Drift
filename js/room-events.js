// Room events: the things that happen *around* your monitor while you play.
//
// These are deliberately player-sided. Nothing here touches the server, the
// round row, or any other player's screen -- your cat is your cat. Two people
// in the same PvP duel get different distractions at different moments, and
// neither can see the other's. That's the whole point: they're the room being
// alive, not a shared rule change. The shared rule changes are the modifiers,
// which stay server-authoritative (see game.js #checkMidModifier).
//
// Because they mutate no game state there is nothing here worth cheating at,
// which is why rolling them on the client is safe in a way that a client-rolled
// *bonus* would not be.
//
// The cost of a room event is the distraction itself -- a cat sitting in front
// of your board, the lamp cutting out mid-guess. Clicking one clears it early.

import { $ } from './ui.js';
import { sfx } from './sfx.js';

/** How long after the round goes live before the room can first interrupt. */
const FIRST_GAP_MS = [9000, 26000];
/** Gap between one event ending and the next being scheduled. */
const NEXT_GAP_MS = [16000, 42000];

const layer = () => $('#room-3d-fx');

/* ── The cat ──────────────────────────────────────────────────────────────
   A real model, not a glyph: body, chest, haunch, head with ears and muzzle,
   four legs on a walk cycle and a tail that swings. It walks the desk in
   front of the monitor, so it genuinely gets between you and the board --
   and it stops halfway to sit and look at you, because of course it does. */
function cat(done) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'cat-rig';
  el.setAttribute('aria-label', 'Shoo the cat off the desk');
  el.style.setProperty('--dir', Math.random() < 0.5 ? 1 : -1);
  // Inline SVG rather than stacked divs: at ~430px on screen a cat has to be
  // carried by its outline -- the back curve, the haunch, the ear angle --
  // and box-shapes can't hold those. It is still a real object in the 3D
  // stage (see .cat-rig), just with a shape worth looking at.
  el.innerHTML = `
    <svg viewBox="0 0 600 340" aria-hidden="true">
      <defs>
        <linearGradient id="catFur" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#a08260"/>
          <stop offset=".5" stop-color="#6d5540"/>
          <stop offset="1" stop-color="#2b2118"/>
        </linearGradient>
        <linearGradient id="catFurDim" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#7a6047"/>
          <stop offset="1" stop-color="#241b13"/>
        </linearGradient>
        <radialGradient id="catEye" cx=".4" cy=".34" r=".72">
          <stop offset="0" stop-color="#eaf585"/>
          <stop offset=".6" stop-color="#a8bf46"/>
          <stop offset="1" stop-color="#465316"/>
        </radialGradient>
      </defs>

      <!-- Far pair first: they read as the other side of the cat purely by
           being darker and drawn behind the torso. -->
      <g class="cat-leg cat-leg-far-b"><rect x="198" y="196" width="31" height="144" rx="15"/></g>
      <g class="cat-leg cat-leg-far-f"><rect x="394" y="198" width="30" height="142" rx="15"/></g>

      <g class="cat-tail">
        <path d="M170 104 C 92 88, 44 44, 66 6" stroke="url(#catFurDim)" stroke-width="36"
              stroke-linecap="round" fill="none"/>
        <path d="M78 26 C 72 18, 69 12, 66 6" stroke="#c9b79a" stroke-width="33"
              stroke-linecap="round" fill="none" opacity=".8"/>
      </g>

      <g class="cat-torso">
        <ellipse cx="175" cy="146" rx="92" ry="82"/>
        <ellipse cx="398" cy="154" rx="78" ry="72"/>
        <path d="M175 64 C 245 54, 330 64, 398 82 L 398 226 C 330 238, 245 238, 175 228 Z"/>
        <path d="M398 98 C 430 82, 452 74, 470 70 L 486 146 C 452 150, 420 146, 398 136 Z"/>
      </g>

      <g class="cat-leg cat-leg-near-b"><rect x="234" y="196" width="33" height="144" rx="16"/></g>
      <g class="cat-leg cat-leg-near-f"><rect x="428" y="198" width="32" height="142" rx="16"/></g>

      <g class="cat-head">
        <path class="cat-ear" d="M426 46 L436 -18 L484 30 Z"/>
        <path class="cat-ear" d="M508 24 L544 -20 L548 44 Z"/>
        <path class="cat-ear-in" d="M444 38 L450 4 L472 30 Z"/>
        <path class="cat-ear-in" d="M516 26 L536 0 L538 38 Z"/>
        <ellipse class="cat-skull" cx="478" cy="76" rx="68" ry="62"/>
        <ellipse class="cat-cheek" cx="478" cy="86" rx="56" ry="46"/>
        <g class="cat-eyes">
          <ellipse cx="452" cy="72" rx="16" ry="18"/>
          <ellipse cx="506" cy="70" rx="16" ry="18"/>
        </g>
        <rect class="cat-pupil" x="449.5" y="59" width="5" height="26" rx="2.5"/>
        <rect class="cat-pupil" x="503.5" y="57" width="5" height="26" rx="2.5"/>
        <ellipse class="cat-muzzle" cx="492" cy="112" rx="34" ry="23"/>
        <path class="cat-nose" d="M486 102 L502 102 L494 112 Z"/>
        <path class="cat-whisker" d="M470 114 L418 106 M470 120 L420 122 M516 114 L566 106 M516 120 L564 124"/>
      </g>
    </svg>`;

  layer().appendChild(el);
  sfx.catMeow();
  const chirp = setTimeout(() => sfx.catChirp(), 4200);
  const purr = setTimeout(() => sfx.catPurr(), 6000);

  let over = false;
  const finish = (shooed) => {
    if (over) return;
    over = true;
    clearTimeout(chirp); clearTimeout(purr); clearTimeout(timer);
    if (shooed) {
      sfx.catShoo();
      // Freeze where it actually is before swapping animations, or it snaps
      // back to the start of the walk for the exit.
      const r = el.getBoundingClientRect();
      const p = layer().getBoundingClientRect();
      el.style.setProperty('--frozen-x', `${r.left + r.width / 2 - (p.left + p.width / 2)}px`);
      el.classList.add('is-shooed');
      el.addEventListener('animationend', () => { el.remove(); done(); }, { once: true });
    } else {
      el.remove();
      done();
    }
  };

  const timer = setTimeout(() => finish(false), 13000);
  el.addEventListener('click', () => finish(true));
  return () => { clearTimeout(chirp); clearTimeout(purr); clearTimeout(timer); over = true; el.remove(); };
}

/* ── The moth ─────────────────────────────────────────────────────────────
   Blunders around the lamp on a wandering path. Harmless, brief, and the
   only event that lives up near the lamp rather than on the desk. */
function moth(done) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'moth-rig';
  el.setAttribute('aria-label', 'Wave the moth away');
  el.innerHTML = `<i class="moth-wing moth-wing-l"></i><i class="moth-wing moth-wing-r"></i><i class="moth-body"></i>`;
  layer().appendChild(el);
  sfx.mothFlutter();
  const again = setInterval(() => sfx.mothFlutter(), 1500);

  let over = false;
  const finish = () => {
    if (over) return;
    over = true;
    clearInterval(again); clearTimeout(timer);
    el.classList.add('is-gone');
    el.addEventListener('animationend', () => { el.remove(); done(); }, { once: true });
  };
  const timer = setTimeout(finish, 9000);
  el.addEventListener('click', finish);
  return () => { clearInterval(again); clearTimeout(timer); over = true; el.remove(); };
}

/* ── The phone ────────────────────────────────────────────────────────────
   Buzzes face-up on the desk beside the keyboard, screen lit. */
function phone(done) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'phone-rig';
  el.setAttribute('aria-label', 'Silence the phone');
  el.innerHTML = `<i class="phone-body"></i><i class="phone-screen"></i><i class="phone-glow"></i>`;
  layer().appendChild(el);
  sfx.phoneBuzz();
  const again = setInterval(() => sfx.phoneBuzz(), 1400);

  let over = false;
  const finish = (silenced) => {
    if (over) return;
    over = true;
    clearInterval(again); clearTimeout(timer);
    if (silenced) sfx.phoneSilence();
    el.classList.add('is-done');
    el.addEventListener('animationend', () => { el.remove(); done(); }, { once: true });
  };
  const timer = setTimeout(() => finish(false), 8000);
  el.addEventListener('click', () => finish(true));
  return () => { clearInterval(again); clearTimeout(timer); over = true; el.remove(); };
}

/* ── Ambient: no target to click, just the room doing something ────────── */

/** The desk lamp stutters and the warm half of the room drops out with it. */
function lampFlicker(done) {
  const room = $('#room-scene');
  if (!room) return done();
  sfx.lampBuzz();
  room.classList.add('is-flickering');
  const t = setTimeout(() => { room.classList.remove('is-flickering'); done(); }, 2200);
  return () => { clearTimeout(t); room.classList.remove('is-flickering'); };
}

/** Rain arrives at the window and runs for a while. */
function rain(done) {
  const room = $('#room-scene');
  if (!room) return done();
  const seconds = 18 + Math.random() * 14;
  room.classList.add('is-raining');
  const stopSound = sfx.rain(seconds);
  const t = setTimeout(() => {
    room.classList.remove('is-raining');
    stopSound();
    done();
  }, seconds * 1000);
  return () => { clearTimeout(t); room.classList.remove('is-raining'); stopSound(); };
}

// Weights, not equal odds: the cat is the headline act, ambience is filler.
const KINDS = [
  { run: cat,          weight: 30 },
  { run: moth,         weight: 18 },
  { run: phone,        weight: 18 },
  { run: lampFlicker,  weight: 20 },
  { run: rain,         weight: 14 },
];
const TOTAL_WEIGHT = KINDS.reduce((n, k) => n + k.weight, 0);

function pick() {
  let r = Math.random() * TOTAL_WEIGHT;
  for (const k of KINDS) {
    r -= k.weight;
    if (r <= 0) return k.run;
  }
  return KINDS[0].run;
}

const between = ([lo, hi]) => lo + Math.random() * (hi - lo);

// Exposed for the browser test harness (same spirit as window.__wordforge in
// main.js): the scheduler's gaps are tens of seconds, so a test that wants to
// see a specific event runs it directly rather than waiting one out.
export const __events = { cat, moth, phone, lampFlicker, rain };

/**
 * Starts the room running for one round. Returns a stop() that cancels the
 * pending event and clears anything on screen -- the caller must call it when
 * the round ends, or a cat outlives its round and wanders over the standings.
 */
export function startRoomEvents() {
  let stopped = false;
  let timer = null;
  let running = false;
  let cancelActive = null;

  const schedule = (gap) => {
    if (stopped) return;
    timer = setTimeout(() => {
      if (stopped || running) return;
      running = true;
      cancelActive = pick()(() => {
        running = false;
        cancelActive = null;
        schedule(between(NEXT_GAP_MS));
      }) || null;
    }, gap);
  };

  schedule(between(FIRST_GAP_MS));

  return function stop() {
    stopped = true;
    clearTimeout(timer);
    if (cancelActive) { cancelActive(); cancelActive = null; }
    const l = layer();
    if (l) l.innerHTML = '';
    const room = $('#room-scene');
    if (room) room.classList.remove('is-flickering', 'is-raining');
  };
}
