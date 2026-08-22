// DOM plumbing. Every control is a button or a keypress — the game never
// requires a mouse, and the on-screen keyboard and a physical one do exactly
// the same thing.

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

const LETTER_KEYBOARD_ROWS = [
  ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
  ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
  ['ENTER', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', 'BACK'],
];

export function showScreen(id) {
  $$('.screen').forEach((s) => s.removeAttribute('data-active'));
  $(`#${id}`)?.setAttribute('data-active', '');
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
 * Renders the A-Z on-screen keyboard. Tiers are applied afterward.
 * `rows` defaults to QWERTY order; pass a shuffled layout (see
 * `shuffledLetterRows`) to rebuild with a scrambled one instead — each key
 * plays a one-shot "shuffle-in" entrance when `shuffled` is true.
 */
export function buildLetterKeyboard(onKey, rows = LETTER_KEYBOARD_ROWS, shuffled = false) {
  const kb = $('#keyboard');
  kb.innerHTML = '';
  kb.classList.toggle('is-shuffled', shuffled);
  let i = 0;
  for (const row of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'kb-row';
    for (const key of row) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.key = key;
      if (key === 'ENTER' || key === 'BACK') {
        b.className = 'kb-key kb-wide';
        b.textContent = key === 'ENTER' ? '⏎' : '⌫';
      } else {
        b.className = 'kb-key';
        b.textContent = key;
      }
      if (shuffled) b.style.setProperty('--shuffle-delay', `${(i++) * 18}ms`);
      b.addEventListener('click', () => onKey(key));
      rowEl.appendChild(b);
    }
    kb.appendChild(rowEl);
  }
}

/** A-Z + ENTER/BACK, reshuffled within each row (row sizes/anchors kept so ENTER and BACK stay put). */
export function shuffledLetterRows() {
  const letters = LETTER_KEYBOARD_ROWS.flat().filter((k) => k !== 'ENTER' && k !== 'BACK');
  for (let i = letters.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [letters[i], letters[j]] = [letters[j], letters[i]];
  }
  const sizes = LETTER_KEYBOARD_ROWS.map((row) => row.filter((k) => k !== 'ENTER' && k !== 'BACK').length);
  const rows = [];
  let cursor = 0;
  for (const size of sizes) {
    rows.push(letters.slice(cursor, cursor + size));
    cursor += size;
  }
  rows[rows.length - 1] = ['ENTER', ...rows[rows.length - 1], 'BACK'];
  return rows;
}

/** tiers: Map<letter, 'hit'|'present'|'miss'> — the best status seen so far. */
export function paintKeyboard(tiers) {
  for (const btn of $$('#keyboard .kb-key')) {
    const k = btn.dataset.key;
    if (k === 'ENTER' || k === 'BACK') continue;
    const tier = tiers.get(k);
    btn.dataset.tier = tier ?? '';
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

/** rows: [{ name, color, total, delta, isMe }] already sorted. */
export function renderBoard(rows) {
  const ol = $('#board-list');
  ol.innerHTML = '';
  for (const r of rows) {
    const li = document.createElement('li');
    if (r.isMe) li.classList.add('is-me');
    const dot = document.createElement('i');
    dot.style.background = r.color;
    li.append(dot, document.createTextNode(r.name));
    if (r.delta > 0) {
      const d = document.createElement('span');
      d.className = 'delta';
      d.textContent = `+${r.delta}`;
      li.appendChild(d);
    }
    const pts = document.createElement('span');
    pts.className = 'pts';
    pts.textContent = r.total;
    li.appendChild(pts);
    ol.appendChild(li);
  }
}

/**
 * Rebuilds the tile grid from scratch. Cheap enough for a text game (at most
 * ~10 rows x 7 tiles) that a full rebuild beats diffing -- but a rebuild
 * also restarts every CSS entrance animation on every tile it touches, so
 * this bails out early when nothing the grid actually shows has changed
 * (the game loop calls this every animation frame). Without that guard, a
 * freshly-revealed tile's flip never gets more than ~16ms of its own
 * animation before the next frame tears it down and builds an identical
 * replacement at frame zero again -- so the flip visually never plays.
 *
 * opts: {
 *   wordLength, maxGuesses,
 *   guesses: [{ word, feedback, player_id }],  // already visibility-filtered
 *   active: string,          // the in-progress typed guess, or ''
 *   canType: boolean,        // round is live and this player/team can still guess
 *   playerColor: Map<player_id, color>,   // co-op only; omit for pvp
 *   shake: boolean,          // true for one frame after an invalid submit
 *   bullseye: boolean,       // hide per-letter tier colour, show a hit-count badge instead
 * }
 */
let _gridSig = null;
export function renderGrid(opts) {
  const { wordLength, maxGuesses, guesses, active, canType, playerColor, bullseye } = opts;
  const shake = !!opts.shake;
  const sig = JSON.stringify([wordLength, maxGuesses, active, canType, shake, !!bullseye,
    guesses.map((g) => `${g.player_id}:${g.attempt_no}`)]);
  if (sig === _gridSig) return;
  _gridSig = sig;

  const board = $('#board');
  board.innerHTML = '';
  board.style.setProperty('--word-length', wordLength);

  for (let i = 0; i < maxGuesses; i++) {
    const row = document.createElement('div');
    row.className = 'tile-row';

    const g = guesses[i];
    const isActive = !g && i === guesses.length && canType;
    if (isActive && shake) row.classList.add('shake');

    if (playerColor && g) {
      row.style.setProperty('--row-owner', playerColor.get(g.player_id) ?? 'transparent');
      row.classList.add('has-owner');
    }

    if (g && !g._rendered) {
      g._rendered = true;
      // "Not even one" -- a guess with zero hits gets its own droop/shake,
      // played exactly once (right here, on the render pass where it first
      // appears) rather than replaying every time the grid is rebuilt later.
      if (g.feedback.every((f) => f !== 'hit')) row.classList.add('is-whiff');
    }

    const hits = bullseye ? g?.feedback.filter((f) => f === 'hit').length : null;
    if (bullseye && g) {
      const badge = document.createElement('div');
      badge.className = 'hit-badge';
      badge.textContent = `🎯 ${hits}/${wordLength}`;
      row.appendChild(badge);
    }

    for (let j = 0; j < wordLength; j++) {
      const tile = document.createElement('div');
      tile.className = 'tile';
      if (g) {
        tile.textContent = g.word[j]?.toUpperCase() ?? '';
        tile.dataset.tier = bullseye ? 'asked' : g.feedback[j];
        tile.style.setProperty('--flip-delay', `${j * 90}ms`);
        tile.classList.add('is-revealed');
      } else if (isActive && active[j]) {
        tile.textContent = active[j].toUpperCase();
        tile.classList.add('is-filled');
      }
      row.appendChild(tile);
    }
    board.appendChild(row);
  }
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
