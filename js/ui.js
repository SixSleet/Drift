// DOM plumbing. Every control is a button or a keypress — the game never
// requires a mouse. Guesses are physical-keyboard only, by design: there's
// no on-screen keyboard to tap.

export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => [...document.querySelectorAll(sel)];

// Matches wf_create_room / wf_join_room: no I/O (read as 1/0) and no 0/1
// themselves, for the 4-character room code.
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const CODE_KEYPAD_ROWS = [
  ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'P'],
  ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
  ['Z', 'X', 'C', 'V', 'B', 'N', 'M'],
  ['2', '3', '4', '5', '6', '7', '8', '9'],
];

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function showScreen(id) {
  $$('.screen').forEach((s) => s.removeAttribute('data-active'));
  $(`#${id}`)?.setAttribute('data-active', '');
}

/**
 * The app's own confirm(). Resolves true if they went through with it.
 *
 * window.confirm() blocks the whole page on a dialog drawn by the browser:
 * it cannot be styled, it sits outside the monitor the game is pretending to
 * be, and on mobile it hangs off the URL bar. It also freezes the music
 * scheduler's main thread while it is up. This is the same question, asked
 * inside the room.
 *
 * Focus starts on the cancel button, Escape cancels, and Tab cycles between
 * the two buttons rather than wandering off into the board behind -- which
 * is what makes it a modal rather than a panel that happens to be on top.
 */
export function confirmDialog({ title, body, confirm = 'Confirm', cancel = 'Cancel' } = {}) {
  const veil = $('#confirm-veil');
  const yes = $('#confirm-yes');
  const no = $('#confirm-no');
  $('#confirm-title').textContent = title;
  $('#confirm-body').textContent = body;
  yes.textContent = confirm;
  no.textContent = cancel;

  const returnFocus = document.activeElement;
  veil.hidden = false;
  no.focus();

  return new Promise((resolve) => {
    const done = (answer) => {
      veil.hidden = true;
      yes.removeEventListener('click', onYes);
      no.removeEventListener('click', onNo);
      veil.removeEventListener('mousedown', onVeil);
      document.removeEventListener('keydown', onKey, true);
      // Put focus back where it was, unless that button has since gone.
      if (returnFocus?.isConnected) returnFocus.focus();
      resolve(answer);
    };
    const onYes = () => done(true);
    const onNo = () => done(false);
    // Clicking the backdrop is a cancel; clicking inside the card is not.
    const onVeil = (e) => { if (e.target === veil) done(false); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); return; }
      if (e.key === 'Tab') {
        // Two focusable things, so the trap is just "the other one".
        e.preventDefault();
        (document.activeElement === yes ? no : yes).focus();
        return;
      }
      // Everything else is swallowed: the board below listens on document for
      // letter keys, and typing into a dialog must not also type a guess.
      if (e.key !== 'Enter' && e.key !== ' ') e.stopPropagation();
    };
    yes.addEventListener('click', onYes);
    no.addEventListener('click', onNo);
    veil.addEventListener('mousedown', onVeil);
    document.addEventListener('keydown', onKey, true);
  });
}

let toastTimer = null;
export function toast(message, ms = 2600) {
  const el = $('#toast');
  el.textContent = message;
  el.setAttribute('data-show', '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.removeAttribute('data-show'), ms);
}

/** Renders the 32-key room-code pad in QWERTY row order. Tap or type both work. */
export function buildKeypad(onKey) {
  const pad = $('#keypad');
  pad.innerHTML = '';
  for (const row of CODE_KEYPAD_ROWS) {
    const rowEl = document.createElement('div');
    rowEl.className = 'key-row';
    for (const ch of row) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.type = 'button';
      b.textContent = ch;
      b.dataset.key = ch;
      b.addEventListener('click', () => onKey(ch));
      rowEl.appendChild(b);
    }
    pad.appendChild(rowEl);
  }
}

export function flashKey(ch) {
  const btn = $(`#keypad .chip[data-key="${ch}"]`);
  if (!btn) return;
  btn.classList.add('is-pressed');
  setTimeout(() => btn.classList.remove('is-pressed'), 120);
}

/**
 * Renders the A-Z letter legend once -- a compact, non-interactive strip
 * showing which letters are known hit/present/miss so far this round.
 * There's no on-screen keyboard to tap: input is the physical keyboard
 * only, since the whole point of the room is that you're looking at a
 * monitor someone's actually typing at.
 */
export function buildLetterLegend() {
  const legend = $('#letter-legend');
  legend.innerHTML = '';
  for (const ch of ALPHABET) {
    const cell = document.createElement('i');
    cell.className = 'legend-key';
    cell.dataset.key = ch;
    cell.textContent = ch;
    legend.appendChild(cell);
  }
}

/** tiers: Map<letter, 'hit'|'present'|'miss'> — the best status seen so far. */
export function paintLetterLegend(tiers) {
  for (const cell of $$('#letter-legend .legend-key')) {
    const tier = tiers.get(cell.dataset.key);
    cell.dataset.tier = tier ?? '';
  }
}

export function setCodeDisplay(code) {
  $('#code-display').textContent = code.padEnd(4, '·');
}

/** Turns a group of chips into a single-select radio group. */
export function chipGroup(container, onPick, attr) {
  container.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip || chip.disabled || !container.contains(chip)) return;
    [...container.querySelectorAll('.chip')].forEach((c) => c.classList.toggle('is-on', c === chip));
    onPick(chip.dataset[attr], chip);
  });
}

export function selectChip(container, attr, value) {
  [...container.querySelectorAll('.chip')].forEach((c) =>
    c.classList.toggle('is-on', c.dataset[attr] === String(value)));
}

export function renderPlayers(players, meId) {
  const ul = $('#lobby-players');
  ul.innerHTML = '';
  for (const p of players) {
    const li = document.createElement('li');
    const dot = document.createElement('i');
    dot.style.background = p.color;
    li.append(dot, document.createTextNode(p.name + (p.id === meId ? ' (you)' : '')));
    if (p.is_host) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'HOST';
      li.appendChild(tag);
    }
    ul.appendChild(li);
  }
  $('#lobby-count').textContent = `${players.length}`;
}

/**
 * rows: [{ name, color, total, delta, isMe, solved, played, avgGuesses }]
 * already sorted, best first.
 *
 * Each row gets a bar filled to its share of the leader's score, so the
 * gap between first and last is something you see rather than something you
 * work out from two numbers.
 */
export function renderBoard(rows) {
  const ol = $('#board-list');
  ol.innerHTML = '';
  const top = Math.max(1, ...rows.map((r) => r.total));
  for (const r of rows) {
    const li = document.createElement('li');
    if (r.isMe) li.classList.add('is-me');

    const bar = el('i', 'board-bar');
    bar.style.width = `${Math.round((r.total / top) * 100)}%`;
    bar.style.background = `color-mix(in srgb, ${r.color} 26%, transparent)`;
    li.appendChild(bar);

    const dot = el('i', 'board-dot');
    dot.style.background = r.color;
    li.appendChild(dot);

    const who = el('span', 'board-who');
    const nameEl = el('span', 'board-name', r.name);
    if (r.left) {
      // They are still in the table because they earned those points, but
      // they are not in the room any more.
      nameEl.classList.add('has-left');
      nameEl.append(el('i', 'left-tag', 'left'));
    }
    who.appendChild(nameEl);
    if (r.played) {
      const bits = [`solved ${r.solved}/${r.played}`];
      if (r.avgGuesses) bits.push(`${r.avgGuesses.toFixed(1)} guesses avg`);
      who.appendChild(el('span', 'board-sub', bits.join(' · ')));
    }
    li.appendChild(who);

    if (r.delta > 0) li.appendChild(el('span', 'delta', `+${r.delta}`));
    li.appendChild(el('span', 'pts', String(r.total)));
    ol.appendChild(li);
  }
}

/** One line above the standings: the word, and who got it. */
export function setRoundRecap(html) {
  const el2 = $('#board-recap');
  if (!el2) return;
  el2.innerHTML = html || '';
  el2.hidden = !html;
}

/**
 * Draws the tile grid.
 *
 * Split deliberately into two paths. A full rebuild throws away every tile,
 * which restarts every CSS animation on every tile it touches -- so it only
 * happens when the grid's *structure* changes (a guess landed, the row count
 * changed, the round changed). Typing a letter changes no structure, so it
 * updates the active row's tiles in place.
 *
 * Getting that wrong is very visible: fold `active` into the rebuild
 * signature and every keystroke re-creates all the revealed tiles, so the
 * whole board re-plays its flip animation on each letter you type.
 *
 * opts: {
 *   wordLength, maxGuesses,
 *   guesses: [{ word, feedback, player_id }],  // already visibility-filtered
 *   active: string,          // the in-progress typed guess, or ''
 *   canType: boolean,        // round is live and this player/team can still guess
 *   playerColor: Map<player_id, color>,   // co-op only; omit for pvp
 *   meId: string,            // co-op only: marks your own rows
 *   shake: boolean,          // true for one frame after an invalid submit
 * }
 */
let _gridSig = null;

/**
 * Updates the row being typed into, without touching any other row. Tiles
 * whose letter has not changed are left completely alone -- re-setting an
 * identical letter would restart its pop animation on every frame.
 */
function paintActiveRow(row, wordLength, active, shake) {
  if (!row) return;
  row.classList.toggle('shake', shake);
  for (let j = 0; j < wordLength; j++) {
    const tile = row.children[j];
    if (!tile) continue;
    const ch = active[j] ? active[j].toUpperCase() : '';
    if (tile.textContent === ch) continue;
    tile.textContent = ch;
    if (ch) {
      // Re-add rather than toggle, so this one tile replays its pop while
      // its neighbours stay untouched.
      tile.classList.remove('is-filled');
      void tile.offsetWidth;
      tile.classList.add('is-filled');
    } else {
      tile.classList.remove('is-filled');
    }
  }
}

export function renderGrid(opts) {
  const { wordLength, maxGuesses, guesses, active, canType, playerColor } = opts;
  const shake = !!opts.shake;
  const board = $('#board');

  // Structure only -- `active` and `shake` are deliberately absent.
  const sig = JSON.stringify([wordLength, maxGuesses, canType, opts.meId ?? null,
    guesses.map((g) => `${g.player_id}:${g.attempt_no}`)]);
  const activeIndex = guesses.length;

  if (sig !== _gridSig) {
    _gridSig = sig;
    board.innerHTML = '';
    board.style.setProperty('--word-length', wordLength);
    // The panel is a fixed height, so the tiles have to size themselves to
    // the row count -- a Co-op 5-letter round is 8 rows, and a 7-letter one
    // is 10. Without this the board grows past the bottom of the screen.
    board.style.setProperty('--rows', maxGuesses);

    for (let i = 0; i < maxGuesses; i++) {
      const row = document.createElement('div');
      row.className = 'tile-row';

      const g = guesses[i];
      const fresh = g && !g._rendered;
      if (fresh) {
        g._rendered = true;
        // "Not even one" -- a guess with zero hits gets its own droop/shake,
        // played exactly once, on the pass where it first appears.
        if (g.feedback.every((f) => f !== 'hit')) row.classList.add('is-whiff');
      }

      if (playerColor && g) {
        row.style.setProperty('--row-owner', playerColor.get(g.player_id) ?? 'transparent');
        row.classList.add('has-owner');
        // Your own rows get a ring on the tab as well as the colour, so you
        // can find them without having to remember which colour you are.
        if (opts.meId && g.player_id === opts.meId) row.classList.add('is-mine');
      }

      for (let j = 0; j < wordLength; j++) {
        const tile = document.createElement('div');
        tile.className = 'tile';
        if (g) {
          tile.textContent = g.word[j]?.toUpperCase() ?? '';
          tile.dataset.tier = g.feedback[j];
          // Only a guess appearing for the first time flips. A rebuild for
          // some later reason must not re-flip guesses already on the board.
          if (fresh) {
            tile.style.setProperty('--flip-delay', `${j * 90}ms`);
            tile.classList.add('is-revealed');
          }
        }
        row.appendChild(tile);
      }
      board.appendChild(row);
    }
  }

  if (canType) paintActiveRow(board.children[activeIndex], wordLength, active, shake);
}

export function setPhase(text, tone) {
  const el = $('#hud-phase');
  el.textContent = text;
  if (tone) el.setAttribute('data-tone', tone);
  else el.removeAttribute('data-tone');
}

export function setStatusLine(html, color) {
  const el = $('#status-line');
  el.innerHTML = html || '';
  el.style.color = color || '';
}

export function setMuteButton(muted) {
  const btn = $('#btn-mute');
  if (!btn) return;
  btn.textContent = muted ? '🔇' : '🔊';
  btn.setAttribute('aria-pressed', String(muted));
  btn.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound');
}

export function showError(title, body) {
  $('#error-title').textContent = title;
  $('#error-body').innerHTML = body;
  showScreen('screen-error');
}

/* ── Side rails ───────────────────────────────────────────────────────
   The board is about 200px wide inside an 830px panel, so most of the
   screen used to be empty. These two columns fill it with the two things
   the game already knew but never showed: where you are in the match, and
   who else is at the table.

   Both are read-only. Nothing in them takes focus or a click, so they can
   never swallow a keystroke meant for the board.

   Rebuilt wholesale on every frame would restart the pulse animations, so
   like the grid these compare a signature first and only redraw on change.
*/

const _railSig = { left: null, right: null };

/**
 * opts: { roundNo, totalRounds, guessesUsed, maxGuesses, canType,
 *         eventLabel, eventEmoji, midLabel, midEmoji }
 */
export function renderRailLeft(opts) {
  const rail = $('#rail-left');
  if (!rail) return;
  const sig = JSON.stringify(opts);
  if (sig === _railSig.left) return;
  _railSig.left = sig;

  rail.innerHTML = '';

  const rounds = el('div', 'rail-block');
  rounds.append(el('p', 'rail-label', 'Match'));
  const dots = el('div', 'round-dots');
  for (let i = 1; i <= opts.totalRounds; i++) {
    const d = el('i', 'round-dot');
    if (i < opts.roundNo) d.classList.add('is-done');
    if (i === opts.roundNo) d.classList.add('is-now');
    d.title = `Round ${i}`;
    dots.appendChild(d);
  }
  rounds.append(dots, el('p', 'rail-sub', `Round ${opts.roundNo} of ${opts.totalRounds}`));
  rail.appendChild(rounds);

  const left = Math.max(0, opts.maxGuesses - opts.guessesUsed);
  const guesses = el('div', 'rail-block');
  guesses.append(el('p', 'rail-label', 'Guesses left'));
  const big = el('div', 'rail-big', String(left));
  if (left <= 1) big.classList.add('is-low');
  guesses.append(big);
  const pips = el('div', 'guess-pips');
  for (let i = 0; i < opts.maxGuesses; i++) {
    const p = el('i', 'guess-pip');
    if (i < opts.guessesUsed) p.classList.add('is-spent');
    pips.appendChild(p);
  }
  guesses.append(pips);
  rail.appendChild(guesses);

  if (opts.eventLabel || opts.midLabel) {
    const mods = el('div', 'rail-block');
    mods.append(el('p', 'rail-label', 'In play'));
    for (const [emoji, label, isMid] of [
      [opts.eventEmoji, opts.eventLabel, false],
      [opts.midEmoji, opts.midLabel, true],
    ]) {
      if (!label) continue;
      const card = el('div', 'rail-mod');
      if (isMid) card.classList.add('is-mid');
      card.append(el('span', 'rail-mod-emoji', emoji ?? '•'), el('span', null, label));
      mods.appendChild(card);
    }
    rail.appendChild(mods);
  }
}

/**
 * opts: {
 *   mode,
 *   rows: [{ id, name, color, isMe, guesses, solved, total }],  // coop/pvp/solo
 *   ghost: { attempts, hits, solved } | null,   // pvp only
 *   maxGuesses,
 * }
 */
export function renderRailRight(opts) {
  const rail = $('#rail-right');
  if (!rail) return;
  const sig = JSON.stringify(opts);
  if (sig === _railSig.right) return;
  _railSig.right = sig;

  rail.innerHTML = '';

  if (opts.mode === 'pvp') {
    const block = el('div', 'rail-block');
    block.append(el('p', 'rail-label', 'Rival'));
    const rival = opts.rows.find((r) => !r.isMe);
    block.append(el('div', 'rail-name', rival?.name ?? 'Waiting…'));
    // You never see a rival's letters -- only how much of their budget is
    // gone. The dots are that, and nothing more.
    const bar = el('div', 'ghost-bar');
    bar.id = 'ghost-bar';
    const filled = opts.ghost?.attempts ?? 0;
    for (let i = 0; i < opts.maxGuesses; i++) {
      const dot = el('i');
      if (i < filled) {
        dot.dataset.tier = opts.ghost.solved && i === filled - 1 ? 'hit'
          : i < (opts.ghost.hits ?? 0) ? 'hit' : 'present';
      }
      bar.appendChild(dot);
    }
    block.appendChild(bar);
    block.append(el('p', 'rail-sub', `${filled}/${opts.maxGuesses} guesses burned`));
    rail.appendChild(block);
    return;
  }

  if (opts.mode === 'solo') {
    const block = el('div', 'rail-block');
    block.append(el('p', 'rail-label', 'Score'));
    const me = opts.rows.find((r) => r.isMe);
    block.append(el('div', 'rail-big', String(me?.total ?? 0)));
    block.append(el('p', 'rail-sub', 'points this match'));
    rail.appendChild(block);
    return;
  }

  // Co-op: everyone shares the board, so the useful readout is who has
  // spent what out of the shared pool.
  const block = el('div', 'rail-block');
  block.append(el('p', 'rail-label', `Team · ${opts.rows.length}`));
  const list = el('ul', 'team-list');
  for (const r of opts.rows) {
    const li = el('li', 'team-row');
    if (r.isMe) li.classList.add('is-me');
    const dot = el('i', 'team-dot');
    dot.style.background = r.color;
    li.append(dot, el('span', 'team-name', r.name + (r.isMe ? ' (you)' : '')));
    li.append(el('span', 'team-count', String(r.guesses)));
    list.appendChild(li);
  }
  block.appendChild(list);
  block.append(el('p', 'rail-sub', 'guesses played this round'));
  rail.appendChild(block);
}

/** Forces the next renderRail* call to redraw — used when the round changes. */
export function resetRails() {
  _railSig.left = null;
  _railSig.right = null;
}

/* ── Sound settings ───────────────────────────────────────────────────
   Two sliders and a mute, sharing one panel between the HUD gear and the
   title screen's link.

   The keyboard is the whole difficulty here. Guesses are typed on a real
   keyboard with no on-screen alternative, and a focused `input[type=range]`
   eats arrow keys, Home/End and Page Up/Down. Worse, main.js's game-key
   listener fires on any keydown while #screen-game is showing -- so with a
   slider focused, typing a letter would both move the slider and enter a
   letter on the board.

   So: the panel stops keydown propagation while it is open (its own controls
   still work, the game never sees those keys), and closing it returns focus
   to whatever opened it. Escape closes. wf-settings-test.mjs checks that
   typing after using a slider goes to the board and not the slider. */

let settingsOpener = null;

function settingsOpen() {
  return !$('#settings-panel')?.hidden;
}

export function toggleSettings(force) {
  const panel = $('#settings-panel');
  if (!panel) return;
  const next = force ?? panel.hidden;
  panel.hidden = !next;
  for (const id of ['#btn-settings', '#btn-settings-title']) {
    $(id)?.setAttribute('aria-expanded', String(next));
  }
  if (next) {
    settingsOpener = document.activeElement;
    $('#vol-music')?.focus();
  } else {
    // Hand focus back, so the next keystroke is a guess again rather than
    // landing on a slider that is no longer visible.
    if (settingsOpener?.isConnected) settingsOpener.focus();
    else document.activeElement?.blur?.();
    settingsOpener = null;
  }
}

/**
 * @param {{ music: number, sfx: number, muted: boolean }} initial  0..1 volumes
 * @param {{ onMusic: fn, onSfx: fn, onMute: fn }} handlers
 */
export function buildSettings(initial, handlers) {
  const panel = $('#settings-panel');
  if (!panel) return;

  const pct = (v) => `${Math.round(v * 100)}%`;
  const wire = (id, valId, start, onChange) => {
    const el = $(id);
    const out = $(valId);
    if (!el) return null;
    el.value = String(Math.round(start * 100));
    if (out) out.textContent = pct(start);
    el.addEventListener('input', () => {
      const v = Number(el.value) / 100;
      if (out) out.textContent = pct(v);
      onChange(v);
    });
    return el;
  };

  wire('#vol-music', '#vol-music-val', initial.music, handlers.onMusic);
  wire('#vol-sfx', '#vol-sfx-val', initial.sfx, handlers.onSfx);

  const muteAll = $('#btn-mute-all');
  const paintMute = (muted) => {
    if (!muteAll) return;
    muteAll.textContent = muted ? 'Sound is off' : 'Mute everything';
    muteAll.setAttribute('aria-pressed', String(muted));
    muteAll.classList.toggle('is-on', muted);
  };
  paintMute(initial.muted);
  muteAll?.addEventListener('click', () => paintMute(handlers.onMute()));

  // Nothing typed inside the panel may reach the game's key handlers.
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { toggleSettings(false); return; }
    e.stopPropagation();
  });

  $('#btn-settings')?.addEventListener('click', () => toggleSettings());
  $('#btn-settings-title')?.addEventListener('click', () => toggleSettings());
  $('#btn-settings-close')?.addEventListener('click', () => toggleSettings(false));

  // Click anywhere else to dismiss — but not on the buttons that open it,
  // or the panel would close and reopen in the same click.
  document.addEventListener('pointerdown', (e) => {
    if (!settingsOpen()) return;
    if (panel.contains(e.target)) return;
    if (e.target.closest('#btn-settings, #btn-settings-title')) return;
    toggleSettings(false);
  });

  // Escape from outside the panel too.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && settingsOpen()) toggleSettings(false);
  });

  /** Lets the mute icon in the HUD and the panel's button stay in step. */
  return { paintMute };
}
