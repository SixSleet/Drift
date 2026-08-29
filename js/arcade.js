// Two small games for the dead time.
//
// Waiting in a lobby for someone to join is the deadest moment in the app,
// and the title screen is not far behind. Both are places you sit and look
// at a static panel, so both get something to do.
//
// These deliberately touch NO game state. They are not worth anything, they
// award nothing, and the only record they keep is a personal best in
// localStorage. That is the same reasoning as the room events: a client-side
// thing that hands out a reward is a client-side thing worth cheating at,
// and a leaderboard nobody else can see is not a leaderboard. It is
// something to do while you wait.
//
// The round starting interrupts whatever is running -- game.js switches to
// the game screen on the live phase, which tears the arcade down with it.

import { loadDictionary } from './words.js';
import { sfx } from './sfx.js';
import { t, foldKey } from './i18n.js';
import { buildKeyboard, wantsOnScreenKeys } from './ui.js';

const bestKey = (id) => `wf-best-${id}`;

export function bestScore(id) {
  try { return parseInt(localStorage.getItem(bestKey(id)), 10) || 0; }
  catch { return 0; }
}
function recordBest(id, score) {
  if (score <= bestScore(id)) return false;
  try { localStorage.setItem(bestKey(id), String(score)); } catch { /* private mode */ }
  return true;
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/* ── Word Hunt ────────────────────────────────────────────────────────────
   Six letters; make as many 4- and 5-letter words out of them as you can.
   Not "unscramble this word" -- that version was tried first and is a bad
   game on this dictionary, because the shipped word list is a broad one and
   most racks scramble to something nobody has heard of. A rack you can pick
   at gives you a way in (a median rack here has 19 findable words, and the
   common ones are always among them) and a ceiling worth chasing.

   Everything comes from data/valid-4/5/6.json, which already ship. It never
   touches answers-*.json -- that is the answer key, and is deliberately not
   deployed. */

const HUNT_SECONDS = 60;
const REROLL_PENALTY_S = 5;
const MIN_RACK_WORDS = 12;
/** Stop looking for a better rack once one is at least this rich. */
const RICH_RACK = 28;

/** Every 4- and 5-letter word makeable from these six letters. */
function solveRack(rack, dict4, dict5) {
  const found = new Set();
  const letters = rack.split('');
  const walk = (i, picked) => {
    if (picked.length === 4 || picked.length === 5) {
      const w = picked.join('');
      // Permutations of the chosen letters, checked against the dictionary.
      permute(w).forEach((p) => {
        if ((p.length === 4 ? dict4 : dict5).has(p)) found.add(p);
      });
    }
    if (picked.length >= 5 || i >= letters.length) return;
    for (let j = i; j < letters.length; j++) {
      walk(j + 1, [...picked, letters[j]]);
    }
  };
  walk(0, []);
  return found;
}

const permCache = new Map();
function permute(word) {
  const key = [...word].sort().join('');
  if (permCache.has(key)) return permCache.get(key);
  const out = new Set();
  const build = (rest, acc) => {
    if (!rest.length) { out.add(acc); return; }
    for (let i = 0; i < rest.length; i++) {
      build(rest.slice(0, i) + rest.slice(i + 1), acc + rest[i]);
    }
  };
  build(key, '');
  const arr = [...out];
  permCache.set(key, arr);
  return arr;
}

async function wordHunt(root, api) {
  const [d4, d5, d6] = await Promise.all([
    loadDictionary(4), loadDictionary(5), loadDictionary(6),
  ]);
  if (!d6.size || !d5.size || !d4.size) {
    root.appendChild(el('p', 'arcade-note', t('arcade.offline')));
    return () => {};
  }
  const sixes = [...d6];

  const rackEl = el('div', 'rack');
  const entry = el('div', 'rack-entry');
  const foundBox = el('div', 'found-words');
  const progress = el('p', 'arcade-note');
  const hint = el('p', 'hint hint-inline',
    t(wantsOnScreenKeys() ? 'arcade.hunt.hintTouch' : 'arcade.hunt.hint'));
  root.append(rackEl, entry, progress, foundBox, hint);

  let rack = '', solutions = new Set(), found = new Set(), typed = '';
  let score = 0, over = false;

  const paintRack = () => {
    rackEl.innerHTML = '';
    const spent = countLetters(typed);
    for (const [i, ch] of [...rack].entries()) {
      const t = el('i', 'rack-tile', ch.toUpperCase());
      // Grey a tile once the letters typed have used it up, so you can see
      // what is left rather than counting duplicates in your head.
      if ((spent.get(ch) ?? 0) > countBefore(rack, ch, i)) t.classList.add('is-used');
      rackEl.appendChild(t);
    }
  };
  const paintEntry = () => {
    entry.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      const slot = el('i', 'rack-slot', typed[i] ? typed[i].toUpperCase() : '');
      if (i >= 4 && !typed[i]) slot.classList.add('is-optional');
      if (typed[i]) slot.classList.add('is-filled');
      entry.appendChild(slot);
    }
  };
  const paintFound = () => {
    foundBox.innerHTML = '';
    for (const w of [...found].sort()) {
      foundBox.appendChild(el('span', `found-word${w.length === 5 ? ' is-long' : ''}`, w.toUpperCase()));
    }
    progress.textContent = t('arcade.progress', { n: found.size, total: solutions.size });
  };

  const newRack = () => {
    // Best of a handful rather than first-past-a-threshold. The shipped word
    // list is a broad one, so a rack drawn at random can technically clear a
    // minimum while every word in it is obscure -- and a rack you cannot get
    // into is the one thing that makes this feel unfair. Solution count is a
    // decent proxy for common letters, and common letters is where the
    // findable words are.
    let bestRack = null, bestSol = null;
    for (let tries = 0; tries < 8; tries++) {
      const candidate = sixes[Math.floor(Math.random() * sixes.length)];
      const sol = solveRack(candidate, d4, d5);
      if (!bestSol || sol.size > bestSol.size) { bestRack = candidate; bestSol = sol; }
      if (sol.size >= RICH_RACK) break;      // good enough, stop looking
    }
    if (bestSol && bestSol.size >= MIN_RACK_WORDS) {
      rack = shuffle(bestRack);
      solutions = bestSol;
    }
    found = new Set();
    typed = '';
    paintRack(); paintEntry(); paintFound();
  };

  const submit = () => {
    if (typed.length < 4) return;
    if (found.has(typed)) { flash('dupe'); return; }
    if (!solutions.has(typed)) { flash('bad'); sfx.invalid(); return; }
    found.add(typed);
    // A five costs more of the rack, so it is worth more.
    score += typed.length === 5 ? 3 : 1;
    api.setScore(score);
    sfx.reveal(typed.length === 5 ? 'hit' : 'present');
    typed = '';
    paintRack(); paintEntry(); paintFound();
    if (found.size === solutions.size) { flash('clear'); newRack(); }
  };

  const flash = (kind) => {
    entry.classList.remove('is-bad', 'is-dupe', 'is-clear');
    void entry.offsetWidth;
    entry.classList.add(kind === 'bad' ? 'is-bad' : kind === 'dupe' ? 'is-dupe' : 'is-clear');
  };

  // One place both a keystroke and a tap arrive at, so the two cannot drift
  // apart: 'ENTER', 'BACK', 'TAB', or a single letter.
  const press = (key) => {
    if (over) return;
    if (key === 'ENTER') { submit(); return; }
    if (key === 'BACK') { typed = typed.slice(0, -1); paintRack(); paintEntry(); return; }
    if (key === 'TAB') { api.penalise(REROLL_PENALTY_S); newRack(); return; }
    const ch = key.toLowerCase();
    if (!/^[a-z]$/.test(ch) || typed.length >= 5) return;
    // Only letters actually left in the rack.
    const spent = countLetters(typed);
    const have = countLetters(rack);
    if ((spent.get(ch) ?? 0) >= (have.get(ch) ?? 0)) { flash('bad'); return; }
    typed += ch;
    sfx.type();
    paintRack(); paintEntry();
  };

  const onKey = (e) => {
    if (over) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === 'Enter') { e.preventDefault(); press('ENTER'); return; }
    if (e.key === 'Backspace') { e.preventDefault(); press('BACK'); return; }
    if (e.key === 'Tab') { e.preventDefault(); press('TAB'); return; }
    // Accents fold to the letter underneath, same as the main board.
    const ch = e.key.length === 1 ? foldKey(e.key) : null;
    if (!ch) return;
    e.preventDefault();
    press(ch);
  };

  document.addEventListener('keydown', onKey);
  // The rack tiles are already the letters you are allowed to use, so with a
  // finger they are the keyboard -- tapping the one you want beats hunting
  // for it in a QWERTY grid where twenty of the keys do nothing.
  if (wantsOnScreenKeys()) {
    rackEl.classList.add('is-tappable');
    rackEl.addEventListener('pointerdown', (e) => {
      const tile = e.target.closest?.('.rack-tile');
      if (!tile || !rackEl.contains(tile)) return;
      e.preventDefault();
      press(tile.textContent.trim());
    });
    const actions = el('div', 'arcade-actions');
    for (const [key, label] of [['BACK', '⌫'], ['TAB', t('arcade.newLetters')], ['ENTER', '⏎']]) {
      const b = el('button', `legend-key legend-action${key === 'TAB' ? ' legend-wide' : ''}`, label);
      b.type = 'button';
      b.dataset.key = key;
      actions.appendChild(b);
    }
    actions.addEventListener('pointerdown', (e) => {
      const b = e.target.closest?.('.legend-key');
      if (!b || !actions.contains(b)) return;
      e.preventDefault();
      press(b.dataset.key);
    });
    root.insertBefore(actions, foundBox);
  }
  newRack();
  api.setScore(0);

  return () => { over = true; document.removeEventListener('keydown', onKey); };
}

const countLetters = (s) => {
  const m = new Map();
  for (const ch of s) m.set(ch, (m.get(ch) ?? 0) + 1);
  return m;
};
const countBefore = (s, ch, upto) => {
  let n = 0;
  for (let i = 0; i < upto; i++) if (s[i] === ch) n++;
  return n;
};
function shuffle(word) {
  const a = [...word];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  const out = a.join('');
  return out === word && word.length > 1 ? shuffle(word) : out;
}

/* ── Moth Swat ────────────────────────────────────────────────────────────
   Reflex rather than vocabulary, so there is something here for the times
   you do not want to think about words at all. Moths cross the panel and
   you click them; three that get past you ends it. They arrive faster as it
   goes on, which is the whole difficulty curve. */

const SWAT_SECONDS = 45;
const SWAT_STRIKES = 3;

function mothSwat(root, api) {
  const arena = el('div', 'swat-arena');
  const strikeRow = el('div', 'swat-strikes');
  root.append(strikeRow, arena,
    el('p', 'hint hint-inline', t('arcade.swat.hint', { n: SWAT_STRIKES })));

  let score = 0, strikes = 0, over = false, spawnTimer = null;
  const live = new Set();

  const paintStrikes = () => {
    strikeRow.innerHTML = '';
    for (let i = 0; i < SWAT_STRIKES; i++) {
      const s = el('i', 'swat-strike');
      if (i < strikes) s.classList.add('is-spent');
      strikeRow.appendChild(s);
    }
  };
  paintStrikes();

  const spawn = () => {
    if (over) return;
    const m = document.createElement('button');
    m.type = 'button';
    m.className = 'swat-moth';
    m.setAttribute('aria-label', 'Swat');
    // Reuses the room moth's shape, at arena scale.
    m.innerHTML = `
      <svg viewBox="0 0 60 48" aria-hidden="true">
        <g class="moth-wing moth-wing-l"><path d="M29 24 C 14 4, 2 8, 4 22 C 5 34, 18 34, 29 26 Z"/></g>
        <g class="moth-wing moth-wing-r"><path d="M31 24 C 46 4, 58 8, 56 22 C 55 34, 42 34, 31 26 Z"/></g>
        <ellipse class="moth-body" cx="30" cy="26" rx="4.5" ry="12"/>
        <path class="moth-antenna" d="M28 15 L22 6 M32 15 L38 6"/>
      </svg>`;
    const dir = Math.random() < 0.5 ? 1 : -1;
    // Faster as the score climbs, floored so it stays possible.
    const seconds = Math.max(1.15, 2.6 - score * 0.055);
    m.style.setProperty('--dir', dir);
    m.style.setProperty('--y', `${6 + Math.random() * 66}%`);
    m.style.setProperty('--drift', `${(Math.random() * 34 - 17).toFixed(1)}%`);
    m.style.animationDuration = `${seconds}s`;
    arena.appendChild(m);
    live.add(m);

    const escape = setTimeout(() => {
      if (over || !live.has(m)) return;
      live.delete(m);
      m.remove();
      strikes += 1;
      paintStrikes();
      sfx.invalid();
      if (strikes >= SWAT_STRIKES) api.end();
    }, seconds * 1000);

    m.addEventListener('click', () => {
      if (over || !live.has(m)) return;
      clearTimeout(escape);
      live.delete(m);
      score += 1;
      api.setScore(score);
      sfx.reveal('hit');

      // Pin it where it actually is before swapping animations.
      //
      // `swat-cross` animates `left` across the arena, and `is-swatted`
      // replaces that animation with `swat-hit`. The moment it does, `left`
      // stops being animated and falls back to the static `left: 0` in the
      // rule -- so the moth jumped to the arena's left edge and died there,
      // however far across it had got. Same for the vertical drift, which
      // rides on `transform`. Writing both as inline styles first means the
      // fallback value IS where it was standing.
      const a = arena.getBoundingClientRect();
      const r = m.getBoundingClientRect();
      m.style.left = `${r.left - a.left}px`;
      m.style.top = `${r.top - a.top}px`;

      m.classList.add('is-swatted');
      setTimeout(() => m.remove(), 260);
    });
    m.dataset.escapeTimer = '1';
    m._escape = escape;

    // Overlapping moths once you are good at it.
    const gap = Math.max(320, 1150 - score * 34);
    spawnTimer = setTimeout(spawn, gap);
  };

  api.setScore(0);
  spawnTimer = setTimeout(spawn, 500);

  return () => {
    over = true;
    clearTimeout(spawnTimer);
    for (const m of live) { clearTimeout(m._escape); m.remove(); }
    live.clear();
  };
}

/* ── Chain ────────────────────────────────────────────────────────────────
   The main game's own chain-letter rule, on its own. You are given a letter;
   type any 4- or 5-letter word starting with it, and the last letter of that
   word is what you have to start the next one with.

   It is the closest thing here to an actual warm-up: the constraint is
   exactly the one that catches people out mid-match, when a round demands a
   word starting with the previous round's last letter and the opening guess
   they always use is suddenly illegal.

   Only `x` is genuinely thin in the shipped list (18 words against 2,007 for
   `s`), so a pass costs time rather than being forbidden -- the same deal as
   Word Hunt's reroll. */

const CHAIN_SECONDS = 60;
const CHAIN_PASS_S = 5;
/** Letters a pass will hand you: common enough that a pass is a real reset. */
const KIND_LETTERS = 'abcdefghlmnoprstw';

function chainStart(root, api) {
  const cue = el('div', 'chain-cue');
  const entry = el('div', 'rack-entry');
  const chainBox = el('div', 'chain-links');
  const hint = el('p', 'hint hint-inline',
    t(wantsOnScreenKeys() ? 'arcade.chain.hintTouch' : 'arcade.chain.hint'));
  root.append(cue, entry, chainBox, hint);
  return { cue, entry, chainBox, hint };
}

async function chain(root, api) {
  const [d4, d5] = await Promise.all([loadDictionary(4), loadDictionary(5)]);
  if (!d4.size || !d5.size) {
    root.appendChild(el('p', 'arcade-note', t('arcade.offline')));
    return () => {};
  }
  const { cue, entry, chainBox } = chainStart(root, api);

  let letter = KIND_LETTERS[Math.floor(Math.random() * KIND_LETTERS.length)];
  let typed = '';
  let score = 0;
  let over = false;
  const used = new Set();

  const paintCue = () => {
    cue.innerHTML = '';
    cue.append(el('span', 'chain-cue-label', 'starts with'),
               el('b', 'chain-cue-letter', letter.toUpperCase()));
  };
  const paintEntry = () => {
    entry.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      const slot = el('i', 'rack-slot', typed[i] ? typed[i].toUpperCase() : '');
      if (i >= 4 && !typed[i]) slot.classList.add('is-optional');
      if (typed[i]) slot.classList.add('is-filled');
      // The first slot is spoken for -- show it rather than making people
      // remember to type it.
      if (i === 0 && !typed[i]) { slot.textContent = letter.toUpperCase(); slot.classList.add('is-ghost'); }
      entry.appendChild(slot);
    }
  };
  const paintChain = () => {
    chainBox.innerHTML = '';
    // Only the tail: a 40-word chain would push everything else off screen.
    for (const w of [...used].slice(-9)) {
      chainBox.appendChild(el('span', `found-word${w.length === 5 ? ' is-long' : ''}`, w.toUpperCase()));
    }
  };
  const flash = (kind) => {
    entry.classList.remove('is-bad', 'is-dupe');
    void entry.offsetWidth;
    entry.classList.add(kind);
  };

  const submit = () => {
    if (typed.length < 4) return;
    if (typed[0] !== letter) { flash('is-bad'); sfx.invalid(); return; }
    if (used.has(typed)) { flash('is-dupe'); return; }
    const dict = typed.length === 5 ? d5 : d4;
    if (!dict.has(typed)) { flash('is-bad'); sfx.invalid(); return; }

    used.add(typed);
    score += typed.length === 5 ? 2 : 1;
    api.setScore(score);
    sfx.reveal(typed.length === 5 ? 'hit' : 'present');
    letter = typed[typed.length - 1];
    typed = '';
    paintCue(); paintEntry(); paintChain();
  };

  const press = (key) => {
    if (over) return;
    if (key === 'ENTER') { submit(); return; }
    if (key === 'BACK') { typed = typed.slice(0, -1); paintEntry(); return; }
    if (key === 'TAB') {
      api.penalise(CHAIN_PASS_S);
      letter = KIND_LETTERS[Math.floor(Math.random() * KIND_LETTERS.length)];
      typed = '';
      paintCue(); paintEntry();
      return;
    }
    const ch = key.toLowerCase();
    if (!/^[a-z]$/.test(ch) || typed.length >= 5) return;
    typed += ch;
    sfx.type();
    paintEntry();
  };

  const onKey = (e) => {
    if (over) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === 'Enter') { e.preventDefault(); press('ENTER'); return; }
    if (e.key === 'Backspace') { e.preventDefault(); press('BACK'); return; }
    if (e.key === 'Tab') { e.preventDefault(); press('TAB'); return; }
    // Accents fold to the letter underneath, same as the main board.
    const ch = e.key.length === 1 ? foldKey(e.key) : null;
    if (!ch) return;
    e.preventDefault();
    press(ch);
  };

  document.addEventListener('keydown', onKey);
  // Any letter is legal here, so this one needs the whole keyboard.
  if (wantsOnScreenKeys()) {
    const keys = el('div');
    buildKeyboard(keys, press, { tab: t('arcade.newLetter') });
    root.appendChild(keys);
  }
  paintCue(); paintEntry(); paintChain();
  api.setScore(0);

  return () => { over = true; document.removeEventListener('keydown', onKey); };
}

export const GAMES = {
  // Every word here is a translation key rather than a string: the picker
  // is rebuilt on a language change, and a name baked in at module load
  // would survive it.
  hunt: {
    nameKey: 'arcade.wordHunt',
    blurbKey: 'arcade.wordHunt.blurb',
    seconds: HUNT_SECONDS,
    unitKey: 'arcade.unit.points',
    run: wordHunt,
  },
  chain: {
    nameKey: 'arcade.chain',
    blurbKey: 'arcade.chain.blurb',
    seconds: CHAIN_SECONDS,
    unitKey: 'arcade.unit.points',
    run: chain,
  },
  swat: {
    nameKey: 'arcade.moth',
    blurbKey: 'arcade.moth.blurb',
    seconds: SWAT_SECONDS,
    unitKey: 'arcade.unit.swatted',
    run: mothSwat,
  },
};

/* ── The runner ───────────────────────────────────────────────────────────
   Owns the clock, the score readout and the personal best, so neither game
   above has to. Each game gets an `api` and gives back a stop(). */

let stopCurrent = null;
let clock = null;

const $a = (sel) => document.querySelector(sel);

/**
 * Tear down whatever is running. Safe to call when nothing is.
 *
 * This empties the stage as well as cancelling the timers. Leaving a rack
 * of letters or a half-dozen moths sitting in a screen nobody is looking at
 * is not visible, but it is still there -- and a `.rack-tile` selector run
 * later will find it, which is exactly how this was caught.
 */
export function stopArcade() {
  if (stopCurrent) { stopCurrent(); stopCurrent = null; }
  clearInterval(clock);
  clock = null;
  const stage = $a('#arcade-stage');
  if (stage) { stage.innerHTML = ''; stage.dataset.game = ''; }
}

/**
 * Start a game inside #arcade-stage.
 * @param {'hunt'|'swat'} id
 * @param {() => void} [onFinish] called when the clock runs out or the game ends itself
 */
export async function startArcade(id, onFinish) {
  const game = GAMES[id];
  const stage = $a('#arcade-stage');
  if (!game || !stage) return;

  stopArcade();
  stage.innerHTML = '';
  stage.dataset.game = id;

  let score = 0;
  let remaining = game.seconds;
  let finished = false;

  const scoreEl = $a('#arcade-score');
  const bestEl = $a('#arcade-best');
  const timeEl = $a('#arcade-time');
  const titleEl = $a('#arcade-title');
  const resultEl = $a('#arcade-result');

  if (titleEl) titleEl.textContent = t(game.nameKey);
  if (resultEl) { resultEl.hidden = true; resultEl.textContent = ''; }
  if (bestEl) bestEl.textContent = t('arcade.best', { n: bestScore(id) });

  const paintTime = () => {
    if (timeEl) timeEl.textContent = `0:${String(Math.max(0, Math.ceil(remaining))).padStart(2, '0')}`;
    timeEl?.classList.toggle('is-low', remaining <= 10);
  };
  paintTime();

  const finish = () => {
    if (finished) return;
    finished = true;
    clearInterval(clock);
    clock = null;
    if (stopCurrent) { stopCurrent(); stopCurrent = null; }
    const isBest = recordBest(id, score);
    if (bestEl) bestEl.textContent = t('arcade.best', { n: bestScore(id) });
    if (resultEl) {
      resultEl.hidden = false;
      resultEl.textContent = isBest
        ? t('arcade.newBest', { score, unit: t(game.unitKey) })
        : t('arcade.result', { score, unit: t(game.unitKey), best: bestScore(id) });
      resultEl.classList.toggle('is-best', isBest);
    }
    stage.dataset.game = '';
    stage.innerHTML = '';
    if (isBest) sfx.win(); else sfx.lost();
    onFinish?.();
  };

  const api = {
    setScore(n) {
      score = n;
      if (scoreEl) scoreEl.textContent = String(n);
    },
    /** A reroll costs time rather than points -- it should be a choice. */
    penalise(seconds) {
      remaining = Math.max(0, remaining - seconds);
      paintTime();
      timeEl?.classList.remove('is-docked');
      void timeEl?.offsetWidth;
      timeEl?.classList.add('is-docked');
    },
    end: finish,
  };

  stopCurrent = (await game.run(stage, api)) ?? null;

  clock = setInterval(() => {
    remaining -= 0.25;
    paintTime();
    if (remaining <= 0) finish();
  }, 250);
}
