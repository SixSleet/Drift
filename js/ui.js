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
 * }
 */
let _gridSig = null;
export function renderGrid(opts) {
  const { wordLength, maxGuesses, guesses, active, canType, playerColor } = opts;
  const shake = !!opts.shake;
  const sig = JSON.stringify([wordLength, maxGuesses, active, canType, shake,
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

    for (let j = 0; j < wordLength; j++) {
      const tile = document.createElement('div');
      tile.className = 'tile';
      if (g) {
        tile.textContent = g.word[j]?.toUpperCase() ?? '';
        tile.dataset.tier = g.feedback[j];
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

/**
 * A distraction sprite in the room (never over the monitor screen) that
 * lingers for `windowMs`. Clicking it before it leaves calls `onCatch` and
 * plays a caught exit; letting it time out plays a fled exit instead.
 * Self-removing either way -- callers never have to clean this up.
 */
function spawnDistraction({ className, emoji, ariaLabel, windowMs, onCatch }) {
  const scene = $('#room-scene');
  if (!scene) return;
  const el = document.createElement('button');
  el.type = 'button';
  el.className = className;
  el.setAttribute('aria-label', ariaLabel);
  el.textContent = emoji;
  el.style.setProperty('--walk-dur', `${windowMs}ms`);
  scene.appendChild(el);

  // Freeze the sprite's current position as a plain inline style before
  // swapping in the caught/fled animation -- otherwise the browser resets
  // `left` to the base rule's value the instant the idle animation stops,
  // and a walking sprite visibly teleports back to the edge it started from.
  const freeze = () => {
    const rect = el.getBoundingClientRect();
    const sceneRect = scene.getBoundingClientRect();
    el.style.left = `${rect.left - sceneRect.left}px`;
    el.style.bottom = `${sceneRect.bottom - rect.bottom}px`;
  };

  let resolved = false;
  const timeout = setTimeout(() => {
    if (resolved) return;
    resolved = true;
    freeze();
    el.classList.add('is-fleeing');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, windowMs);

  el.addEventListener('click', () => {
    if (resolved) return;
    resolved = true;
    clearTimeout(timeout);
    freeze();
    el.classList.add('is-caught');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    onCatch();
  });
}

/** A cat walks across the room. See spawnDistraction. */
export function spawnCat(windowMs, onCatch) {
  spawnDistraction({ className: 'cat-sprite', emoji: '🐈', ariaLabel: 'Catch the cat', windowMs, onCatch });
}

/** A phone rings on the desk, stationary and shaking rather than walking. */
export function spawnPhone(windowMs, onCatch) {
  spawnDistraction({ className: 'phone-sprite', emoji: '📱', ariaLabel: 'Answer the phone', windowMs, onCatch });
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
