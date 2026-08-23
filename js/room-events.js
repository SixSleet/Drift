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
import { music } from './music.js';

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
   Comes in past the lamp and settles on the board, sitting over one already
   revealed letter and blurring it. That is the point: the other room events
   are scenery, this one actually costs you something -- a letter you'd
   already earned goes unreadable until you swat it.

   It lives in a flat layer in viewport coordinates rather than the 3D stage,
   because it has to land on a specific tile, and converting a tile's screen
   rectangle back into stage coordinates would be guesswork. */
function moth(done) {
  const fx = $('#screen-fx');
  if (!fx) return done();

  // Only revealed tiles carry a letter worth hiding.
  const tiles = [...document.querySelectorAll('#board .tile[data-tier]')]
    .filter((t) => t.textContent.trim());
  const target = tiles.length ? tiles[Math.floor(Math.random() * tiles.length)] : null;

  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'moth-rig';
  el.setAttribute('aria-label', 'Swat the moth off the screen');
  el.innerHTML = `
    <svg viewBox="0 0 60 48" aria-hidden="true">
      <g class="moth-wing moth-wing-l">
        <path d="M29 24 C 14 4, 2 8, 4 22 C 5 34, 18 34, 29 26 Z"/>
      </g>
      <g class="moth-wing moth-wing-r">
        <path d="M31 24 C 46 4, 58 8, 56 22 C 55 34, 42 34, 31 26 Z"/>
      </g>
      <ellipse class="moth-body" cx="30" cy="26" rx="4.5" ry="12"/>
      <path class="moth-antenna" d="M28 15 L22 6 M32 15 L38 6"/>
    </svg>`;
  fx.appendChild(el);

  // Fly in from the lamp's corner, then settle on the tile.
  const lamp = $('.lamp')?.getBoundingClientRect();
  const from = lamp ? { x: lamp.left + lamp.width / 2, y: lamp.top } : { x: 40, y: 80 };
  const to = target
    ? (() => { const r = target.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()
    : { x: from.x + 160, y: from.y + 60 };

  el.style.setProperty('--from-x', `${Math.round(from.x)}px`);
  el.style.setProperty('--from-y', `${Math.round(from.y)}px`);
  el.style.setProperty('--to-x', `${Math.round(to.x)}px`);
  el.style.setProperty('--to-y', `${Math.round(to.y)}px`);
  el.style.setProperty('--mid-x', `${Math.round((from.x + to.x) / 2 + 90)}px`);
  el.style.setProperty('--mid-y', `${Math.round(Math.min(from.y, to.y) - 70)}px`);

  sfx.mothFlutter();
  const again = setInterval(() => sfx.mothFlutter(), 1800);
  // Smudge only once it has actually arrived.
  const land = setTimeout(() => { if (target) target.classList.add('is-smudged'); }, 1500);

  let over = false;
  const clear = () => {
    clearInterval(again); clearTimeout(land); clearTimeout(timer);
    if (target) target.classList.remove('is-smudged');
  };
  const finish = () => {
    if (over) return;
    over = true;
    clear();
    el.classList.add('is-gone');
    el.addEventListener('animationend', () => { el.remove(); done(); }, { once: true });
  };
  const timer = setTimeout(finish, 11000);
  el.addEventListener('click', finish);
  return () => { over = true; clear(); el.remove(); };
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

/**
 * A thunderstorm. Rain at the window, and every few seconds a strike: the
 * room flashes white and the lamp cuts out with it, so for a beat the only
 * light in the room is the monitor. Ambient -- nothing to click, and it
 * never touches the board.
 */
function storm(done) {
  const room = $('#room-scene');
  if (!room) return done();

  const seconds = 20 + Math.random() * 12;
  room.classList.add('is-storm');
  // The weather gets the soundtrack for as long as it lasts. An override
  // rather than a set(), so whatever the round was playing is waiting
  // underneath when the rain stops.
  music.override('storm');
  const stopRain = sfx.rain(seconds);
  const strikes = [];

  // 3-5 strikes, one per slice of the storm rather than all drawn from the
  // whole window. Drawing independently meant the first strike could land
  // 18 seconds in, by which point the event has just been rain -- and it
  // also let two strikes land a moment apart and then nothing. A slice each
  // keeps them spread and puts the first one early, where it establishes
  // what is happening.
  const count = 3 + Math.floor(Math.random() * 3);
  const window = seconds * 1000 - 4000;
  const slice = window / count;
  for (let i = 0; i < count; i++) {
    const at = 1500 + i * slice + Math.random() * slice * 0.7;
    strikes.push(setTimeout(() => {
      room.classList.add('is-lightning');
      // The thunder trails the flash, the way it does outdoors.
      setTimeout(() => sfx.thunder(), 120 + Math.random() * 400);
      setTimeout(() => room.classList.remove('is-lightning'), 700);
    }, at));
  }

  const end = setTimeout(() => {
    room.classList.remove('is-storm', 'is-lightning');
    music.release('storm');
    stopRain();
    done();
  }, seconds * 1000);

  return () => {
    strikes.forEach(clearTimeout);
    clearTimeout(end);
    room.classList.remove('is-storm', 'is-lightning');
    music.release('storm');
    stopRain();
  };
}

/* ── The mouse ────────────────────────────────────────────────────────────
   Runs the front edge of the desk in a couple of darting bursts, low and
   quick. It is deliberately the *small* interruption: it never crosses the
   screen, so the cost is having something move in the corner of your eye
   while you are trying to hold five letters in your head. Click to scare it
   off early. */
function mouse(done) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'mouse-rig';
  el.setAttribute('aria-label', 'Scare the mouse off the desk');
  el.style.setProperty('--dir', Math.random() < 0.5 ? 1 : -1);
  el.innerHTML = `
    <svg viewBox="0 0 200 96" aria-hidden="true">
      <defs>
        <linearGradient id="mouseFur" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#8a7b6b"/>
          <stop offset="1" stop-color="#3a312a"/>
        </linearGradient>
      </defs>
      <path class="mouse-tail" d="M42 62 C 8 62, 6 34, 26 30"/>
      <ellipse class="mouse-ear" cx="132" cy="38" rx="15" ry="15"/>
      <path class="mouse-body" d="M40 68 C 40 40, 78 26, 112 30 C 142 33, 160 44, 168 56
                                   C 174 65, 168 72, 152 72 L 56 72 C 44 72, 40 71, 40 68 Z"/>
      <circle class="mouse-eye" cx="150" cy="49" r="3.4"/>
      <circle class="mouse-nose" cx="170" cy="58" r="3"/>
      <g class="mouse-leg mouse-leg-f"><rect x="140" y="66" width="7" height="18" rx="3.5"/></g>
      <g class="mouse-leg mouse-leg-b"><rect x="62" y="66" width="7" height="18" rx="3.5"/></g>
    </svg>`;
  layer().appendChild(el);
  sfx.mouseSkitter();
  const again = setInterval(() => sfx.mouseSkitter(), 2300);

  let over = false;
  const finish = (scared) => {
    if (over) return;
    over = true;
    clearInterval(again); clearTimeout(timer);
    if (scared) sfx.mouseSqueak();
    el.classList.add('is-gone');
    el.addEventListener('animationend', () => { el.remove(); done(); }, { once: true });
  };
  const timer = setTimeout(() => finish(false), 7600);
  el.addEventListener('click', () => finish(true));
  return () => { clearInterval(again); clearTimeout(timer); over = true; el.remove(); };
}

/* ── The paper plane ──────────────────────────────────────────────────────
   Sails in on an arc across the front of the room. The only room event with
   a window on it: catch it in flight and you get a small papery thump and it
   is gone, miss it and it glides on and lands off-screen. Nothing is won
   either way -- like everything else here, the stake is entirely that it is
   in your way. */
function paperPlane(done) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'plane-rig';
  el.setAttribute('aria-label', 'Catch the paper plane');
  el.style.setProperty('--dir', Math.random() < 0.5 ? 1 : -1);
  el.innerHTML = `
    <svg viewBox="0 0 220 120" aria-hidden="true">
      <path class="plane-wing-far"  d="M8 30 L212 54 L96 74 Z"/>
      <path class="plane-wing-near" d="M8 30 L96 74 L52 96 Z"/>
      <path class="plane-fold"      d="M8 30 L96 74"/>
    </svg>`;
  layer().appendChild(el);
  sfx.paperGlide();

  let over = false;
  const finish = (caught) => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    if (caught) sfx.paperCatch();
    el.classList.add(caught ? 'is-caught' : 'is-gone');
    el.addEventListener('animationend', () => { el.remove(); done(); }, { once: true });
    // A caught plane is crumpled instantly; a missed one is already most of
    // the way out of frame, so don't wait on an animation that may not fire.
    setTimeout(() => { if (el.isConnected) { el.remove(); done(); } }, 1400);
  };
  const timer = setTimeout(() => finish(false), 5200);
  el.addEventListener('click', () => finish(true));
  return () => { clearTimeout(timer); over = true; el.remove(); };
}

/* ── The power flicker ────────────────────────────────────────────────────
   Not the lamp -- the monitor. The board dims and stutters for a beat, which
   is the most intrusive thing in here, so it is also the shortest and the
   rarest. It never hides a letter outright: at its darkest the board is
   still readable, just unpleasant. */
function powerCut(done) {
  const overlay = $('#app-overlay');
  const room = $('#room-scene');
  if (!overlay) return done();
  sfx.powerDip();
  overlay.classList.add('is-powercut');
  room?.classList.add('is-powercut');
  const t = setTimeout(() => {
    overlay.classList.remove('is-powercut');
    room?.classList.remove('is-powercut');
    done();
  }, 1100);
  return () => {
    clearTimeout(t);
    overlay.classList.remove('is-powercut');
    room?.classList.remove('is-powercut');
  };
}

/* ── The neighbour ────────────────────────────────────────────────────────
   Someone through the wall puts music on. This is the one room event that
   takes over the *soundtrack* rather than the picture: the bed swaps to a
   muffled four-on-the-floor with the top end gone, which is what actually
   makes it through plasterboard.

   Bang on the wall to make it stop. That is the interaction -- and unlike
   the cat, what you are clearing is something you can hear rather than
   something you can see, so the target is the wall itself. */
function neighbour(done) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'neighbour-rig';
  el.setAttribute('aria-label', 'Bang on the wall');
  el.innerHTML = `<i class="neighbour-thump"></i>`;
  layer().appendChild(el);

  const room = $('#room-scene');
  room?.classList.add('is-neighbour');
  music.override('neighbour');

  let over = false;
  const finish = (banged) => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    room?.classList.remove('is-neighbour');
    music.release('neighbour');
    if (banged) sfx.wallBang();
    el.remove();
    done();
  };
  const timer = setTimeout(() => finish(false), 22000);
  el.addEventListener('click', () => {
    sfx.wallBang();
    // One bang is rude, not effective. The second one works.
    if (el.dataset.banged) { finish(false); return; }
    el.dataset.banged = '1';
    el.classList.remove('is-banged');
    void el.offsetWidth;
    el.classList.add('is-banged');
  });
  return () => {
    clearTimeout(timer);
    over = true;
    room?.classList.remove('is-neighbour');
    music.release('neighbour');
    el.remove();
  };
}

// Weights, not equal odds: the cat is the headline act, ambience is filler.
const KINDS = [
  { run: cat,          weight: 24 },
  { run: moth,         weight: 15 },
  { run: phone,        weight: 13 },
  { run: mouse,        weight: 13 },
  { run: paperPlane,   weight: 12 },
  { run: lampFlicker,  weight: 14 },
  { run: neighbour,    weight: 12 },
  { run: storm,        weight: 11 },
  // The most intrusive one in here, so the rarest.
  { run: powerCut,     weight: 6 },
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
export const __events = {
  cat, moth, phone, mouse, paperPlane, lampFlicker, neighbour, storm, powerCut,
};

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
    if (room) room.classList.remove('is-flickering', 'is-storm', 'is-lightning',
                                    'is-neighbour', 'is-powercut');
    $('#app-overlay')?.classList.remove('is-powercut');
    // Any event that took the music has to hand it back, even if the round
    // ended mid-storm -- otherwise the standings play thunder.
    music.release();
    const fx = $('#screen-fx');
    if (fx) fx.innerHTML = '';
    document.querySelectorAll('.tile.is-smudged').forEach((t) => t.classList.remove('is-smudged'));
  };
}
