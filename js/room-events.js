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

// Weights, not equal odds: the cat is the headline act, ambience is filler.
const KINDS = [
  { run: cat,          weight: 24 },
  { run: moth,         weight: 15 },
  { run: phone,        weight: 13 },
  { run: paperPlane,   weight: 12 },
  { run: lampFlicker,  weight: 14 },
  { run: neighbour,    weight: 11 },
  { run: spider,       weight: 11 },
  { run: bird,         weight: 10 },
  { run: storm,        weight: 10 },
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
  cat, moth, phone, paperPlane, spider, bird,
  lampFlicker, neighbour, storm, powerCut,
};
/** The blackout is reached through the storm, so the tests need it directly. */
export const __power = { cutPower, jumpscare, restorePower, BLACKOUT_GRACE_MS };

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
    document.querySelectorAll('.bird-rig').forEach((b) => b.remove());
    // A round that ends mid-blackout must not leave the next one in the
    // dark, and must certainly not leave a bat on screen.
    restorePower();
    const fx = $('#screen-fx');
    if (fx) fx.innerHTML = '';
    document.querySelectorAll('.tile.is-smudged').forEach((t) => t.classList.remove('is-smudged'));
  };
}
