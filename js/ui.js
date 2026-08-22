// DOM plumbing for the screens. Every control here is a button — the game never
// asks anyone to type, room codes included.

export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => [...document.querySelectorAll(sel)];

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // matches drift_create_room

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

/** Renders the 32-key tap-only code pad. */
export function buildKeypad(onKey) {
  const pad = $('#keypad');
  pad.innerHTML = '';
  for (const ch of CODE_ALPHABET) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.textContent = ch;
    b.addEventListener('click', () => onKey(ch));
    pad.appendChild(b);
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
  $('#lobby-count').textContent = `${players.length}/10`;
}

/** rows: [{ name, color, total, delta, streak, isMe }] already sorted. */
export function renderBoard(rows) {
  const ol = $('#board-list');
  ol.innerHTML = '';
  for (const r of rows) {
    const li = document.createElement('li');
    if (r.isMe) li.classList.add('is-me');
    const dot = document.createElement('i');
    dot.style.background = r.color;
    li.append(dot, document.createTextNode(r.name));

    if (r.streak >= 3) {
      const s = document.createElement('span');
      s.className = 'streak';
      s.textContent = `🔥${r.streak}`;
      li.appendChild(s);
    }
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

export function setPhase(text, tone) {
  const el = $('#hud-phase');
  el.textContent = text;
  if (tone) el.setAttribute('data-tone', tone);
  else el.removeAttribute('data-tone');
}

export function setOverlay(html, color) {
  const el = $('#stage-overlay');
  el.innerHTML = html || '';
  el.style.color = color || '#e8ecff';
}

export function showError(title, body) {
  $('#error-title').textContent = title;
  $('#error-body').innerHTML = body;
  showScreen('screen-error');
}
