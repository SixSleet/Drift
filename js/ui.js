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
  const sig = JSON.stringify([wordLength, maxGuesses, canType,
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
