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
import { roomState } from './room.js';

// Two clocks, not one.
//
// The room used to run a single queue: one event at a time, sixteen to
// forty-two seconds apart. On paper that is eight events in a five-minute
// round. In practice almost no round lasts five minutes -- most are solved
// or dead inside ninety seconds -- so what a player actually saw was two
// events, sometimes one, and the room read as empty.
//
// So the interrupting events come faster, AND the ambient ones (a mote of
// dust, a light in the sky, a knock in the pipes) run on their own clock
// beside them. Those cost you nothing, cannot be missed and cannot pile up
// on each other -- a kind already on screen is never picked twice -- so
// running them in parallel makes the room continuously alive without
// making it any harder to play.
/** How long after the round goes live before the room can first interrupt. */
const FIRST_GAP_MS = [3500, 11000];
/** Gap between one event ending and the next being scheduled. */
const NEXT_GAP_MS = [6000, 17000];
/** The ambient clock: sooner, and closer together, because it costs nothing. */
const AMBIENT_FIRST_GAP_MS = [1500, 6000];
const AMBIENT_NEXT_GAP_MS = [4000, 13000];

const layer = () => $('#room-3d-fx');

/* ── The cat ──────────────────────────────────────────────────────────────
   It jumps up, crosses to the middle of the desk, and SITS DOWN in front of
   the monitor, facing you, covering the bottom of the board until you move
   it. Then it washes a paw, because it is not in a hurry.

   The previous version walked past below the screen and could be ignored
   completely, which is the one thing a room event must not be -- the moth
   works because it takes a letter away from you, and the cat is a much
   bigger animal, so it takes more. What it covers is the active row and the
   rows below it: you can still see the guesses you have already made, but
   not the one you are typing.

   Drawn front-on rather than in profile. A profile cat is carried entirely
   by its outline -- the back curve, the haunch, the shoulder -- and getting
   any of those slightly wrong makes it read as a generic quadruped, which
   is exactly what happened. A sitting cat facing you is a much more
   forgiving silhouette (pear, circle, two triangles) and it is also the
   pose this event is actually about. */
function cat(done) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'cat-rig';
  el.setAttribute('aria-label', 'Move the cat off the desk');
  el.style.setProperty('--dir', Math.random() < 0.5 ? 1 : -1);
  el.innerHTML = `
    <svg viewBox="0 0 400 520" aria-hidden="true">
      <defs>
        <linearGradient id="catFur" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#9c7f5e"/>
          <stop offset=".46" stop-color="#6d5540"/>
          <stop offset="1" stop-color="#33271c"/>
        </linearGradient>
        <linearGradient id="catFurDim" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#6b543f"/>
          <stop offset="1" stop-color="#241b13"/>
        </linearGradient>
        <radialGradient id="catEye" cx=".38" cy=".32" r=".75">
          <stop offset="0" stop-color="#f0fa96"/>
          <stop offset=".55" stop-color="#b3ca4f"/>
          <stop offset="1" stop-color="#4c5a19"/>
        </radialGradient>
      </defs>

      <!-- Tail, curled round the near side of the haunches. -->
      <path class="cat-tail" d="M330 470 C 392 452, 392 372, 336 356 C 300 346, 282 372, 296 392"/>

      <!-- Haunches, then the body tapering up to the shoulders. A sitting
           cat is a pear: almost all of the mass is at the bottom. -->
      <ellipse class="cat-haunch" cx="200" cy="424" rx="152" ry="90"/>
      <path class="cat-body" d="M200 196
        C 268 196, 306 268, 322 346
        C 336 414, 300 452, 200 452
        C 100 452, 64 414, 78 346
        C 94 268, 132 196, 200 196 Z"/>
      <!-- Chest, catching the monitor's light. -->
      <path class="cat-chest" d="M200 236 C 240 236, 262 300, 262 350
        C 262 396, 236 416, 200 416 C 164 416, 138 396, 138 350
        C 138 300, 160 236, 200 236 Z"/>

      <!-- Front legs, side by side, with paws. -->
      <g class="cat-legs">
        <rect x="146" y="356" width="44" height="104" rx="22"/>
        <rect x="210" y="356" width="44" height="104" rx="22"/>
        <ellipse cx="168" cy="456" rx="30" ry="17"/>
        <ellipse cx="232" cy="456" rx="30" ry="17"/>
      </g>

      <g class="cat-head">
        <path class="cat-ear" d="M104 96 L118 8 L188 66 Z"/>
        <path class="cat-ear" d="M296 96 L282 8 L212 66 Z"/>
        <path class="cat-ear-in" d="M124 88 L132 34 L170 70 Z"/>
        <path class="cat-ear-in" d="M276 88 L268 34 L230 70 Z"/>
        <ellipse class="cat-skull" cx="200" cy="140" rx="116" ry="104"/>
        <ellipse class="cat-cheek" cx="200" cy="164" rx="104" ry="82"/>
        <g class="cat-eyes">
          <ellipse cx="152" cy="136" rx="25" ry="27"/>
          <ellipse cx="248" cy="136" rx="25" ry="27"/>
        </g>
        <rect class="cat-pupil" x="148" y="116" width="8" height="40" rx="4"/>
        <rect class="cat-pupil" x="244" y="116" width="8" height="40" rx="4"/>
        <ellipse class="cat-muzzle" cx="176" cy="196" rx="34" ry="24"/>
        <ellipse class="cat-muzzle" cx="224" cy="196" rx="34" ry="24"/>
        <path class="cat-nose" d="M186 178 L214 178 L200 194 Z"/>
        <path class="cat-mouth" d="M200 194 L200 204 M200 204 C 190 214, 176 212, 172 202
                                    M200 204 C 210 214, 224 212, 228 202"/>
        <path class="cat-whisker" d="M146 194 L44 178 M146 204 L46 206
                                     M254 194 L356 178 M254 204 L354 206"/>
      </g>
    </svg>`;

  layer().appendChild(el);
  sfx.catMeow();
  const chirp = setTimeout(() => sfx.catChirp(), 5200);
  const purr = setTimeout(() => sfx.catPurr(), 8000);

  let over = false;
  const finish = (moved) => {
    if (over) return;
    over = true;
    clearTimeout(chirp); clearTimeout(purr); clearTimeout(timer);
    if (moved) {
      sfx.catShoo();
      el.classList.add('is-shooed');
      el.addEventListener('animationend', () => { el.remove(); done(); }, { once: true });
      setTimeout(() => { if (el.isConnected) { el.remove(); done(); } }, 1200);
    } else {
      el.remove();
      done();
    }
  };

  // Long enough to be a real nuisance, short enough that ignoring it is not
  // a strategy. Clicking is much faster.
  const timer = setTimeout(() => finish(false), 15000);
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

/** The desk lamp gutters: it dips and surges and settles, and the warm half
    of the room's light follows it down and back. 2.6s rather than 2.2 -- the
    tail of it is the part that reads as a bulb calming down rather than as
    an effect being switched off. */
function lampFlicker(done) {
  const room = $('#room-scene');
  if (!room) return done();
  sfx.lampBuzz();
  room.classList.add('is-flickering');
  const t = setTimeout(() => { room.classList.remove('is-flickering'); done(); }, 2600);
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

  let over = false;
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
  // Exactly one strike per storm takes the power out, never the first --
  // tripping on every strike would make a storm four blackouts in a row,
  // and tripping on the first gives no warning that a storm is even what
  // is happening.
  const trips = 1 + Math.floor(Math.random() * (count - 1));
  let cancelCut = null;
  for (let i = 0; i < count; i++) {
    const at = 1500 + i * slice + Math.random() * slice * 0.7;
    strikes.push(setTimeout(() => {
      room.classList.add('is-lightning');
      // The thunder trails the flash, the way it does outdoors.
      setTimeout(() => sfx.thunder(), 120 + Math.random() * 400);
      setTimeout(() => room.classList.remove('is-lightning'), 700);
      if (i === trips) {
        // Just after the flash, so the strike reads as the cause.
        setTimeout(() => {
          if (over) return;
          music.override('outage');
          cancelCut = cutPower(() => music.override('storm'));
        }, 260);
      }
    }, at));
  }

  const end = setTimeout(() => {
    over = true;
    cancelCut?.();
    room.classList.remove('is-storm', 'is-lightning');
    music.release('storm');
    music.release('outage');
    stopRain();
    done();
  }, seconds * 1000);

  return () => {
    over = true;
    strikes.forEach(clearTimeout);
    clearTimeout(end);
    cancelCut?.();
    room.classList.remove('is-storm', 'is-lightning');
    music.release('storm');
    music.release('outage');
    stopRain();
  };
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

/* ── The power cut ────────────────────────────────────────────────────────
   A lightning strike trips the breaker on the wall to your right. Everything
   goes -- the room, the monitor, the board -- and the only thing left is the
   red light on the consumer unit. Throw it back on and the round carries on
   where it was.

   Leave it, and after ten seconds something comes out of the dark.

   The round clock keeps running throughout, which is the cost. That is the
   same deal as the cat sitting on your board: no game state is touched, the
   server does not know this happened, and the price is entirely the seconds
   you spend not being able to play. The fix is one click and it is right
   there, pulsing. */
const BLACKOUT_GRACE_MS = 10000;

function cutPower(onRestored) {
  const box = $('#fusebox');
  const black = $('#blackout');
  if (!box || !black) { onRestored?.(); return () => {}; }

  box.classList.add('is-tripped');
  box.setAttribute('aria-hidden', 'false');
  black.hidden = false;
  sfx.breakerTrip();

  let done = false;
  const restore = (byPlayer) => {
    if (done) return;
    done = true;
    clearTimeout(scareTimer);
    box.removeEventListener('click', onClick);
    box.classList.remove('is-tripped');
    box.setAttribute('aria-hidden', 'true');
    black.hidden = true;
    if (byPlayer) sfx.breakerReset();
    onRestored?.();
  };
  const onClick = () => restore(true);
  box.addEventListener('click', onClick);

  const scareTimer = setTimeout(() => {
    // The lights come back on by themselves afterwards -- the bat is the
    // punishment, not being stuck in the dark.
    jumpscare(() => restore(false));
  }, BLACKOUT_GRACE_MS);

  return () => { clearTimeout(scareTimer); restore(false); };
}

/** Full-screen bat, and the loudest thing in the app. */
function jumpscare(after) {
  const el = $('#jumpscare');
  if (!el) { after?.(); return; }
  el.hidden = false;
  el.setAttribute('aria-hidden', 'false');
  sfx.screech();
  const end = () => {
    el.hidden = true;
    el.setAttribute('aria-hidden', 'true');
    after?.();
  };
  el.addEventListener('animationend', end, { once: true });
  // Belt and braces: an animation that never fires must not strand the
  // player staring at a bat with the power still off.
  setTimeout(() => { if (!el.hidden) end(); }, 1400);
}

/** Put everything back, whatever state it was left in. */
function restorePower() {
  const box = $('#fusebox');
  const black = $('#blackout');
  const scare = $('#jumpscare');
  box?.classList.remove('is-tripped');
  box?.setAttribute('aria-hidden', 'true');
  if (black) black.hidden = true;
  if (scare) scare.hidden = true;
}

/* ── The spider ───────────────────────────────────────────────────────────
   Comes down on a thread from somewhere above the monitor, hangs in front of
   the screen for a moment, then climbs back up. The only event that moves
   vertically, which is most of why it registers at all -- everything else in
   this room travels sideways, so a thing descending through the middle of
   your field of view is genuinely hard to ignore.

   Click it and it retreats early. */
function spider(done) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'spider-rig';
  el.setAttribute('aria-label', 'Send the spider back up');
  el.style.setProperty('--drop', `${300 + Math.random() * 220}px`);
  el.style.setProperty('--x', `${(Math.random() * 620 - 310).toFixed(0)}px`);
  el.innerHTML = `
    <i class="spider-thread"></i>
    <svg class="spider-body-svg" viewBox="0 0 120 96" aria-hidden="true">
      <g class="spider-legs">
        <path d="M52 46 C 34 34, 20 30, 8 36"/>
        <path d="M52 50 C 32 46, 18 48, 6 58"/>
        <path d="M52 54 C 32 60, 20 66, 10 78"/>
        <path d="M54 58 C 42 70, 36 80, 32 92"/>
        <path d="M68 46 C 86 34, 100 30, 112 36"/>
        <path d="M68 50 C 88 46, 102 48, 114 58"/>
        <path d="M68 54 C 88 60, 100 66, 110 78"/>
        <path d="M66 58 C 78 70, 84 80, 88 92"/>
      </g>
      <ellipse class="spider-abdomen" cx="60" cy="58" rx="17" ry="15"/>
      <ellipse class="spider-head" cx="60" cy="40" rx="10" ry="9"/>
      <circle class="spider-eye" cx="56" cy="38" r="2.1"/>
      <circle class="spider-eye" cx="64" cy="38" r="2.1"/>
    </svg>`;
  layer().appendChild(el);
  sfx.silkDrop();

  let over = false;
  const finish = (poked) => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    if (poked) sfx.silkRetreat();
    el.classList.add('is-climbing');
    el.addEventListener('animationend', () => { el.remove(); done(); }, { once: true });
    setTimeout(() => { if (el.isConnected) { el.remove(); done(); } }, 1600);
  };
  const timer = setTimeout(() => finish(false), 9000);
  el.addEventListener('click', () => finish(true));
  return () => { clearTimeout(timer); over = true; el.remove(); };
}

/* ── The bird ─────────────────────────────────────────────────────────────
   Lands on the sill outside, hops about, and goes. Purely ambient: it is
   across the room, behind glass, and there is nothing to click.

   It goes in the window rather than the fx layer because it is *outside* --
   the window lives in the room stage, which sits behind the app overlay, so
   a bird placed there is correctly behind the monitor rather than floating
   in front of it. */
function bird(done) {
  const win = document.querySelector('.window');
  if (!win) return done();
  const el = document.createElement('i');
  el.className = 'bird-rig';
  el.style.setProperty('--perch', `${18 + Math.random() * 52}%`);
  el.innerHTML = `
    <svg viewBox="0 0 90 70" aria-hidden="true">
      <path class="bird-tail" d="M18 40 L2 50 L20 50 Z"/>
      <path class="bird-body" d="M18 42 C 18 26, 32 18, 48 20 C 62 22, 70 30, 72 40
                                  C 74 50, 62 56, 46 56 C 28 56, 18 52, 18 42 Z"/>
      <path class="bird-wing" d="M32 34 C 44 30, 58 34, 62 42 C 54 48, 40 46, 32 34 Z"/>
      <circle class="bird-eye" cx="62" cy="30" r="2.6"/>
      <path class="bird-beak" d="M70 32 L84 35 L70 38 Z"/>
      <path class="bird-legs" d="M40 56 L40 64 M52 56 L52 64"/>
    </svg>`;
  win.appendChild(el);
  sfx.birdChirp();
  const chirps = setInterval(() => sfx.birdChirp(), 3200 + Math.random() * 2600);

  let over = false;
  const finish = () => {
    if (over) return;
    over = true;
    clearInterval(chirps);
    clearTimeout(timer);
    el.classList.add('is-away');
    setTimeout(() => { el.remove(); done(); }, 900);
  };
  const timer = setTimeout(finish, 11000 + Math.random() * 5000);
  return () => { clearInterval(chirps); clearTimeout(timer); over = true; el.remove(); };
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

/* ── The crooked frame ─────────────────────────────────────────────────────
   One of the two picture frames on the back wall goes crooked, holds for a
   while, then straightens itself back out. Purely ambient -- it lives in the
   BACK room stage with everything else on that wall, which is pointer-events:
   none for the whole layer, so it is not something to click. The nuisance is
   entirely visual: a small wrongness sitting in your peripheral vision for
   ten seconds. */
function frameTilt(done) {
  const which = Math.random() < 0.5 ? '.frame-a' : '.frame-b';
  const el = document.querySelector(which);
  if (!el) return done();
  const angle = (6 + Math.random() * 7) * (Math.random() < 0.5 ? 1 : -1);
  el.style.setProperty('--tilt', `${angle.toFixed(1)}deg`);
  el.classList.add('is-crooked');
  sfx.frameCreak();
  const t = setTimeout(() => {
    el.classList.remove('is-crooked');
    done();
  }, 9000);
  return () => { clearTimeout(t); el.classList.remove('is-crooked'); };
}

/* ── The firefly ──────────────────────────────────────────────────────────
   A single mote of light wanders through the lamp's glow and out again.
   Nothing to click, nothing to miss -- it is there for the same reason the
   bird is: the room going on being a room whether or not you are watching
   it. */
function firefly(done) {
  const el = document.createElement('i');
  el.className = 'firefly-rig';
  // Wanders near the lamp, roughly desk height, well clear of the board.
  el.style.setProperty('--fx1', `${-60 + Math.random() * 40}px`);
  el.style.setProperty('--fy1', `${-40 + Math.random() * 80}px`);
  el.style.setProperty('--fx2', `${40 + Math.random() * 60}px`);
  el.style.setProperty('--fy2', `${-90 + Math.random() * 60}px`);
  el.style.setProperty('--fx3', `${-20 + Math.random() * 50}px`);
  el.style.setProperty('--fy3', `${20 + Math.random() * 50}px`);
  layer().appendChild(el);

  sfx.fireflyTwinkle();
  const again = setInterval(() => sfx.fireflyTwinkle(), 2600 + Math.random() * 1400);
  const t = setTimeout(() => {
    clearInterval(again);
    el.classList.add('is-gone');
    el.addEventListener('animationend', () => { el.remove(); done(); }, { once: true });
    setTimeout(() => { if (el.isConnected) { el.remove(); done(); } }, 900);
  }, 10000);
  return () => { clearInterval(again); clearTimeout(t); el.remove(); };
}

/* ── Passing headlights ───────────────────────────────────────────────────
   A car passes outside, out of frame, and its headlights sweep across the
   back wall for a couple of seconds. Ambient, like the storm's rain -- a
   single CSS class toggled on the room itself, same trick as lampFlicker. */
function headlights(done) {
  const room = $('#room-scene');
  if (!room) return done();
  sfx.headlightPass();
  room.classList.add('is-headlights');
  const t = setTimeout(() => { room.classList.remove('is-headlights'); done(); }, 2200);
  return () => { clearTimeout(t); room.classList.remove('is-headlights'); };
}

/* ── The field mouse ──────────────────────────────────────────────────────
   Darts along the floor in front of the desk, low and quick -- gone almost
   as soon as it registers unless you catch it. Click shoos it off early;
   ignored, it simply finishes its dash and is gone regardless. Built on the
   same translate/--dir arc as the paper plane, just lower and much faster. */
function fieldMouse(done) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'mouse-rig';
  el.setAttribute('aria-label', 'Shoo the mouse');
  el.style.setProperty('--dir', Math.random() < 0.5 ? 1 : -1);
  el.innerHTML = `
    <svg viewBox="0 0 90 46" aria-hidden="true">
      <path class="mouse-tail" d="M14 26 C -6 20, -14 34, -4 42"/>
      <ellipse class="mouse-body" cx="46" cy="26" rx="34" ry="17"/>
      <circle class="mouse-ear" cx="70" cy="10" r="9"/>
      <circle class="mouse-ear-in" cx="70" cy="10" r="4.5"/>
      <circle class="mouse-eye" cx="76" cy="21" r="2.4"/>
      <path class="mouse-nose" d="M88 25 L78 21 L78 29 Z"/>
      <path class="mouse-whisker" d="M80 26 L90 22 M80 28 L91 28 M80 30 L90 34"/>
    </svg>`;
  layer().appendChild(el);
  sfx.mouseSqueak();

  let over = false;
  const finish = (shooed) => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    if (shooed) sfx.mouseScatter();
    el.classList.add('is-gone');
    el.addEventListener('animationend', () => { el.remove(); done(); }, { once: true });
    setTimeout(() => { if (el.isConnected) { el.remove(); done(); } }, 500);
  };
  const timer = setTimeout(() => finish(false), 2600);
  el.addEventListener('click', () => finish(true));
  return () => { clearTimeout(timer); over = true; el.remove(); };
}

/* ── The falling leaf ─────────────────────────────────────────────────────
   One leaf lets go of the desk plant and drifts down, swaying, toward the
   desk. Catch it before it lands, or it settles and fades on its own --
   the same "window" mechanic as the paper plane, on a much shorter fuse and
   a much gentler fall. Spawned at the plant's own coordinates (see
   .desk-plant in app.css) so it genuinely leaves the plant rather than
   appearing from nowhere. */
function fallingLeaf(done) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'falling-leaf-rig';
  el.setAttribute('aria-label', 'Catch the leaf');
  el.style.setProperty('--sway', `${(Math.random() < 0.5 ? 1 : -1) * (40 + Math.random() * 50)}px`);
  layer().appendChild(el);
  sfx.leafRustle();

  let over = false;
  const finish = (caught) => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    if (caught) sfx.leafCatch();
    el.classList.add(caught ? 'is-caught' : 'is-landed');
    el.addEventListener('animationend', () => { el.remove(); done(); }, { once: true });
    setTimeout(() => { if (el.isConnected) { el.remove(); done(); } }, 900);
  };
  const timer = setTimeout(() => finish(false), 3400);
  el.addEventListener('click', () => finish(true));
  return () => { clearTimeout(timer); over = true; el.remove(); };
}

/* ── Dust in the lamplight ────────────────────────────────────────────────
   Motes turning over in the cone under the shade. This is the quietest
   thing in the file on purpose: no sound, nothing to click, no cost to you
   at all. It exists because a room where SOMETHING is always moving reads
   as lived in, and the events that cost you something cannot be frequent
   enough to do that job on their own without becoming a nuisance.

   It lives in the FLAT layer, at the lamp's projected screen coordinates,
   not in the 3D one -- the same trick the moth uses to sit on a tile.
   Nine elements animating a transform inside the room's preserve-3d
   subtree cannot be composited: the browser has to re-rasterise the whole
   room every frame for them, which is what the curtain taught us. In
   #screen-fx they are plain 2D boxes that a compositor can promote and
   leave alone. Nobody can tell that a 3px dot is not in perspective.

   Worth being straight about what was and was not measured. On the test
   machine (software rendering, no GPU) this costs about the same either
   way -- there is no compositor there to do the promoting, so it cannot
   show the win. What it does show is the bar: the firefly that already
   ships costs nearly twice this, so nine motes are not the expensive thing
   in this file. The flat layer is the right call for real hardware
   regardless. */
function dustMotes(done) {
  const fx = $('#screen-fx');
  const lamp = $('.lamp')?.getBoundingClientRect();
  if (!fx || !lamp || lamp.width < 20) return done();

  // The cone hangs below the shade. Everything below is in lamp-rig units
  // (the prop is 360x500 in room space) scaled by however big it landed on
  // screen, so the dust is the right size at any zoom.
  const k = lamp.width / 360;
  const el = document.createElement('i');
  el.className = 'dust-rig';
  el.style.left = `${Math.round(lamp.left + lamp.width / 2)}px`;
  el.style.top = `${Math.round(lamp.top + lamp.height * 0.55)}px`;
  for (let i = 0; i < 9; i++) {
    const m = document.createElement('i');
    m.className = 'dust-mote';
    m.style.setProperty('--dx', `${Math.round((-70 + Math.random() * 140) * k)}px`);
    m.style.setProperty('--dy', `${Math.round((-40 + Math.random() * 150) * k)}px`);
    m.style.setProperty('--drift', `${Math.round((Math.random() < 0.5 ? -1 : 1) * (14 + Math.random() * 34) * k)}px`);
    m.style.setProperty('--rise', `${Math.round(70 * k)}px`);
    m.style.setProperty('--dur', `${7 + Math.random() * 7}s`);
    m.style.setProperty('--delay', `${-Math.random() * 8}s`);
    m.style.setProperty('--size', `${(2 + Math.random() * 2.6) * Math.max(0.6, k)}px`);
    el.appendChild(m);
  }
  fx.appendChild(el);

  let gone = null;
  const fade = () => {
    if (gone) return;
    clearTimeout(life);
    clearInterval(watch);
    el.classList.add('is-gone');
    gone = setTimeout(() => { el.remove(); done(); }, 1200);
  };
  const life = setTimeout(fade, 13000);
  // The motes are made of lamplight. If the player reaches over and pulls
  // the switch while they are drifting, they have to go with it -- dust
  // still turning over in a dark room is the room arguing with them.
  const watch = setInterval(() => { if (!roomState.lampOn) fade(); }, 1000);
  return () => {
    clearTimeout(life); clearInterval(watch); clearTimeout(gone);
    el.remove();
  };
}

/* ── A plane going over ───────────────────────────────────────────────────
   A light crossing the sky in the window, blinking, taking its time, with a
   drone so far under the music you register it as weather. It lives inside
   the .window prop rather than in the fx layer, because the window is a
   hole in the back wall and anything in the sky has to be behind the glass
   and clipped by the frame -- put it in the fx layer and it flies across
   the wall. */
function planeLight(done) {
  const sky = document.querySelector('.window .window-sky');
  if (!sky) return done();
  const el = document.createElement('i');
  el.className = 'plane-rig';
  el.style.setProperty('--dir', Math.random() < 0.5 ? 1 : -1);
  el.style.setProperty('--alt', `${12 + Math.random() * 34}%`);
  sky.parentElement.insertBefore(el, sky.nextSibling);
  sfx.planeDrone(9);
  const t = setTimeout(() => { el.remove(); done(); }, 9200);
  return () => { clearTimeout(t); el.remove(); };
}

/* ── The heating ──────────────────────────────────────────────────────────
   Pipes knocking behind the wall. There is nothing to see -- that is the
   event: a room makes noises with no visible cause, and one that only ever
   makes a sound when something is on screen to explain it is a stage set.
   The faint shudder is there so it does not read as a stray sound effect
   from the game itself. Works flat, since it is barely visual. */
function pipes(done) {
  const room = $('#room-scene');
  sfx.pipeKnock();
  room?.classList.add('is-knocking');
  const t = setTimeout(() => { room?.classList.remove('is-knocking'); done(); }, 1400);
  return () => { clearTimeout(t); room?.classList.remove('is-knocking'); };
}

/* ── A gust at the window ─────────────────────────────────────────────────
   Only when the window is actually open: air cannot come through a closed
   sash, and firing this against the player's own switch would be the room
   contradicting them. The curtain gets the same breathe animation the
   opening gust uses -- retriggered by removing and re-adding the class,
   because restarting a CSS animation needs a reflow between the two. */
function curtainBreeze(done) {
  const win = document.querySelector('.window');
  if (!win || !roomState.windowOpen) return done();
  win.classList.remove('is-gusting');
  void win.offsetWidth;              // forces the restart; do not remove
  win.classList.add('is-gusting');
  sfx.gust();
  const t = setTimeout(() => { win.classList.remove('is-gusting'); done(); }, 5200);
  return () => { clearTimeout(t); win.classList.remove('is-gusting'); };
}

/* ── A note off the pinboard ──────────────────────────────────────────────
   One of the notes gives up on its pin and drops behind the desk. It does
   not come back this round, which is the small thing that makes it worth
   having: most of these events undo themselves, and one that leaves the
   room slightly different is a room rather than a loop. (The next round
   restores it -- see the reset in stop().) */
function pinNote(done) {
  const notes = [...document.querySelectorAll('.pin-note:not(.is-fallen)')];
  if (!notes.length) return done();
  const el = notes[Math.floor(Math.random() * notes.length)];
  el.style.setProperty('--fall-spin', `${(Math.random() < 0.5 ? -1 : 1) * (30 + Math.random() * 50)}deg`);
  el.classList.add('is-fallen');
  sfx.paperGlide();
  const t = setTimeout(done, 2400);
  // Cancel puts it back. Cancel only ever runs at the end of the round,
  // which is exactly when the board is meant to reset anyway -- and an
  // event that cannot undo itself is the one thing every other event here
  // promises it can.
  return () => { clearTimeout(t); el.classList.remove('is-fallen'); };
}

/* ── A paw over the desk edge ─────────────────────────────────────────────
   The cat, without the cat: a single paw comes up over the front edge of
   the desk and bats at nothing twice before dropping back down. Costs you
   the corner of the screen for a couple of seconds rather than the middle
   of it, which is why it can be common where the cat has to be rare.
   Camera-relative like the cat, so it survives the flat layout. */
function pawSwipe(done) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'paw-rig';
  el.setAttribute('aria-label', 'Shoo the paw off the desk');
  el.style.setProperty('--dir', Math.random() < 0.5 ? 1 : -1);
  el.innerHTML = `
    <svg viewBox="0 0 120 150" aria-hidden="true">
      <path class="paw-leg" d="M40 150 L40 62 C 40 40, 80 40, 80 62 L80 150 Z"/>
      <ellipse class="paw-pad" cx="60" cy="52" rx="40" ry="34"/>
      <ellipse class="paw-toe" cx="26" cy="30" rx="14" ry="16"/>
      <ellipse class="paw-toe" cx="52" cy="18" rx="15" ry="17"/>
      <ellipse class="paw-toe" cx="80" cy="20" rx="15" ry="17"/>
      <ellipse class="paw-toe" cx="102" cy="36" rx="13" ry="15"/>
    </svg>`;
  layer().appendChild(el);
  sfx.catChirp();

  let over = false;
  const finish = (shooed) => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    if (shooed) sfx.catShoo();
    el.classList.add('is-gone');
    el.addEventListener('animationend', () => { el.remove(); done(); }, { once: true });
    setTimeout(() => { if (el.isConnected) { el.remove(); done(); } }, 700);
  };
  const timer = setTimeout(() => finish(false), 4200);
  el.addEventListener('click', () => finish(true));
  return () => { clearTimeout(timer); over = true; el.remove(); };
}

// Weights, not equal odds: the cat is the headline act, ambience is filler.
//
// `flat` marks the ones that still work when the room is not being drawn --
// a phone drops the geometry (see the flat fallback in app.css) and shows
// the app full-screen instead. Two kinds survive that:
//
//   rigs placed relative to the camera rather than to a prop -- the cat
//   walks in front of the screen, the neighbour's light comes through the
//   near edge of frame, so both still land where you are looking;
//   effects that were never in the room to begin with -- the storm takes
//   over the music, the power cut darkens the app itself and puts a bat on
//   the screen, the lamp flicker and the headlights wash the whole view.
//
// The rest are pinned to furniture: the moth circles the lamp, the leaf
// falls past the window, the spider comes down the wall, the mouse runs the
// skirting board. With no lamp, window, wall or skirting board on screen
// they play out somewhere off the side of a phone, so they are left to the
// desktop rather than fired invisibly.
//
// `ambient` marks the ones the second clock is allowed to draw from: no
// click to make, nothing covered, nothing taken away. Everything ambient is
// still in the main pool too -- the two clocks share the table, they just
// weight it differently.
const KINDS = [
  { key: 'cat',        run: cat,          weight: 22, flat: true },
  { key: 'moth',       run: moth,         weight: 14, needsLamp: true },
  { key: 'phone',      run: phone,        weight: 12 },
  { key: 'paperPlane', run: paperPlane,   weight: 11 },
  { key: 'lampFlicker',run: lampFlicker,  weight: 13, flat: true, needsLamp: true },
  { key: 'pawSwipe',   run: pawSwipe,     weight: 13, flat: true },
  { key: 'neighbour',  run: neighbour,    weight: 10, flat: true, heavy: true },
  { key: 'spider',     run: spider,       weight: 10 },
  { key: 'bird',       run: bird,         weight: 10, ambient: true },
  { key: 'storm',      run: storm,        weight: 9,  flat: true, heavy: true },
  { key: 'fieldMouse', run: fieldMouse,   weight: 10 },
  { key: 'fallingLeaf',run: fallingLeaf,  weight: 9 },
  { key: 'frameTilt',  run: frameTilt,    weight: 8,  ambient: true },
  { key: 'firefly',    run: firefly,      weight: 8,  ambient: true },
  { key: 'headlights', run: headlights,   weight: 9,  flat: true, ambient: true, heavy: true },
  { key: 'dustMotes',  run: dustMotes,    weight: 12, needsLamp: true, ambient: true },
  { key: 'pipes',      run: pipes,        weight: 10, flat: true, ambient: true },
  { key: 'planeLight', run: planeLight,   weight: 9,  ambient: true },
  { key: 'pinNote',    run: pinNote,      weight: 7,  ambient: true },
  { key: 'curtainBreeze', run: curtainBreeze, weight: 9, ambient: true, needsWindow: true },
  // The most intrusive one in here, so the rarest.
  { key: 'powerCut',   run: powerCut,     weight: 5,  flat: true, heavy: true },
];

/**
 * Checked per pick rather than once at load: a tablet can be rotated and a
 * window can be dragged across the breakpoint mid-match, and the answer
 * should follow the layout rather than whatever it was at boot.
 */
function pool({ ambientOnly = false, exclude = null } = {}) {
  const flatOnly = getComputedStyle(document.getElementById('room-scene')).perspective === 'none';
  let kinds = flatOnly ? KINDS.filter((k) => k.flat) : KINDS;
  // A lamp the player has switched off has nothing to flicker, and a moth
  // has nothing to circle. Firing either would either do nothing visible or
  // -- worse -- flick the lamp back on behind the player's own decision.
  // Same for a gust through a sash the player has shut.
  if (!roomState.lampOn) kinds = kinds.filter((k) => !k.needsLamp);
  if (!roomState.windowOpen) kinds = kinds.filter((k) => !k.needsWindow);
  if (ambientOnly) kinds = kinds.filter((k) => k.ambient);
  // Two of the same thing at once is not a busier room, it is a bug: one
  // frame cannot be crooked twice and two dust rigs are just dimmer dust.
  if (exclude?.size) kinds = kinds.filter((k) => !exclude.has(k.key));
  return kinds;
}

function pick(opts) {
  const kinds = pool(opts);
  if (!kinds.length) return null;
  const total = kinds.reduce((n, k) => n + k.weight, 0);
  let r = Math.random() * total;
  for (const k of kinds) {
    r -= k.weight;
    if (r <= 0) return k;
  }
  return kinds[0];
}

const between = ([lo, hi]) => lo + Math.random() * (hi - lo);

// Exposed for the browser test harness (same spirit as window.__wordforge in
// main.js): the scheduler's gaps are tens of seconds, so a test that wants to
// see a specific event runs it directly rather than waiting one out.
export const __events = {
  cat, moth, phone, paperPlane, spider, bird,
  lampFlicker, neighbour, storm, powerCut,
  fieldMouse, fallingLeaf, frameTilt, firefly, headlights,
  dustMotes, pipes, planeLight, pinNote, curtainBreeze, pawSwipe,
};
/** The weight table, so a test can check the pools without re-declaring it. */
export const __kinds = KINDS;
/** The blackout is reached through the storm, so the tests need it directly. */
export const __power = { cutPower, jumpscare, restorePower, BLACKOUT_GRACE_MS };

/**
 * Starts the room running for one round. Returns a stop() that cancels the
 * pending event and clears anything on screen -- the caller must call it when
 * the round ends, or a cat outlives its round and wanders over the standings.
 */
export function startRoomEvents() {
  let stopped = false;
  const timers = new Set();
  // key -> cancel, for everything on screen right now. Doubles as the
  // exclusion set the pickers use, so nothing is ever running twice.
  const active = new Map();

  /**
   * One clock. `ambientOnly` is the difference between the two: the main
   * clock draws from the whole table, the ambient one only from the events
   * that cost the player nothing, so at most one demanding thing is ever
   * in front of you even though the room is busier than it was.
   */
  const loop = (gap, ambientOnly) => {
    if (stopped) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (stopped) return;
      const next = () => loop(between(ambientOnly ? AMBIENT_NEXT_GAP_MS : NEXT_GAP_MS), ambientOnly);
      // The main clock still waits its turn behind a demanding event -- a
      // cat and a power cut at once is not atmosphere, it is chaos. Ambient
      // events do not count toward that, so the room keeps moving under it.
      const live = [...active.keys()].map((k) => KINDS.find((x) => x.key === k)).filter(Boolean);
      const busy = live.some((k) => !k.ambient);
      // And the ambient clock sits out anything that washes the whole
      // screen. Two clocks doubles the worst case for how much is animating
      // at once, and a mote of dust drifting over a lightning strike is
      // both invisible and the one moment it could actually cost a frame.
      const heavy = live.some((k) => k.heavy);
      const blocked = ambientOnly ? heavy : busy;
      const kind = blocked ? null : pick({ ambientOnly, exclude: new Set(active.keys()) });
      if (!kind) return next();
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        active.delete(kind.key);
        next();
      };
      // Set the slot before running: an event that finishes synchronously
      // (a guard clause bailing out) would otherwise delete a slot that was
      // never taken, and then never be excluded again.
      active.set(kind.key, () => {});
      const cancel = kind.run(finish);
      if (settled) return;                       // it bailed out immediately
      active.set(kind.key, cancel || (() => {}));
    }, gap);
    timers.add(timer);
  };

  loop(between(FIRST_GAP_MS), false);
  loop(between(AMBIENT_FIRST_GAP_MS), true);

  return function stop() {
    stopped = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    for (const cancel of active.values()) { try { cancel(); } catch { /* already gone */ } }
    active.clear();
    const l = layer();
    if (l) l.innerHTML = '';
    const room = $('#room-scene');
    if (room) room.classList.remove('is-flickering', 'is-storm', 'is-lightning',
                                    'is-neighbour', 'is-powercut', 'is-headlights',
                                    'is-knocking');
    $('#app-overlay')?.classList.remove('is-powercut');
    // Any event that took the music has to hand it back, even if the round
    // ended mid-storm -- otherwise the standings play thunder.
    music.release();
    document.querySelectorAll('.bird-rig').forEach((b) => b.remove());
    // frame-a/frame-b live outside #room-3d-fx (they're back-wall props), so
    // clearing that layer below does not reach a crooked one.
    document.querySelectorAll('.frame.is-crooked').forEach((f) => f.classList.remove('is-crooked'));
    // Same story for the props the new ambient events touch: they live in
    // the room's own markup, not in the fx layer, so clearing that layer
    // does not reach them. The pinboard gets its note back for the next
    // round -- the room resets between rounds even though it does not
    // within one.
    document.querySelectorAll('.pin-note.is-fallen').forEach((n) => n.classList.remove('is-fallen'));
    document.querySelector('.window')?.classList.remove('is-gusting');
    document.querySelectorAll('.plane-rig').forEach((n) => n.remove());
    // A round that ends mid-blackout must not leave the next one in the
    // dark, and must certainly not leave a bat on screen.
    restorePower();
    const fx = $('#screen-fx');
    if (fx) fx.innerHTML = '';
    document.querySelectorAll('.tile.is-smudged').forEach((t) => t.classList.remove('is-smudged'));
  };
}
