// Bootstrap: wire the buttons to the game, and nothing else.

import { Game } from './game.js';
import { startScreenFit } from './screen-fit.js';
import { DEFAULT_ROUNDS, DEFAULT_WORD_LENGTH, WORD_LENGTH_CHOICES } from './config.js';
import { sfx } from './sfx.js';
import { music } from './music.js';
import {
  $, showScreen, toast, buildKeypad, setCodeDisplay, flashKey, setMuteButton,
  chipGroup, showError, CODE_ALPHABET, buildSettings,
} from './ui.js';
import { volume } from './audio.js';

const game = new Game();
// Exposed so the browser test harness can inspect the live simulation.
window.__wordforge = game;
let chosenMode = 'solo';
let chosenRounds = DEFAULT_ROUNDS;
let chosenWordLength = DEFAULT_WORD_LENGTH;   // null = mixed
let codeBuffer = '';

function fail(err) {
  const msg = String(err?.message ?? err);
  if (/no such room/i.test(msg)) { showScreen('screen-code'); $('#code-note').textContent = 'No room with that code.'; codeBuffer = ''; setCodeDisplay(''); return; }
  if (/already started/i.test(msg)) { showScreen('screen-code'); $('#code-note').textContent = 'That game has already started.'; codeBuffer = ''; setCodeDisplay(''); return; }
  if (/room is full/i.test(msg)) { showScreen('screen-code'); $('#code-note').textContent = 'That room is full.'; codeBuffer = ''; setCodeDisplay(''); return; }
  showError('Something went wrong', msg);
}

// ── Title ──────────────────────────────────────────────────────────────

function setCreateLabel(mode) {
  $('#btn-create').textContent = mode === 'solo' ? 'Play solo' : 'Create a room';
}
setCreateLabel(chosenMode);

chipGroup($('#mode-chips'), (v) => { chosenMode = v; setCreateLabel(v); }, 'mode');
chipGroup($('#rounds-chips'), (v) => { chosenRounds = Number(v); }, 'rounds');

// Word length is fixed for the whole match and has to be settled before the
// room exists, since wf_create_room stores it on the room -- joiners inherit
// it and never get a say.
(function buildWordLengthChips() {
  const box = $('#length-chips');
  if (!box) return;
  for (const c of WORD_LENGTH_CHOICES) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.dataset.length = c.value === null ? 'mixed' : String(c.value);
    b.title = c.hint;
    b.textContent = c.label;
    if (c.value === DEFAULT_WORD_LENGTH) b.classList.add('is-on');
    box.appendChild(b);
  }
  const hint = $('#length-hint');
  const describe = (v) => WORD_LENGTH_CHOICES.find((c) => c.value === v)?.hint ?? '';
  if (hint) hint.textContent = describe(DEFAULT_WORD_LENGTH);
  chipGroup(box, (v) => {
    chosenWordLength = v === 'mixed' ? null : Number(v);
    if (hint) hint.textContent = describe(chosenWordLength);
  }, 'length');
})();

$('#btn-create').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try { await game.createRoom(chosenMode, chosenRounds, chosenWordLength); }
  catch (err) { fail(err); }
  finally { e.target.disabled = false; }
});

$('#btn-join').addEventListener('click', () => {
  codeBuffer = '';
  setCodeDisplay('');
  $('#code-note').textContent = '';
  showScreen('screen-code');
});

// ── Code entry: tap the pad or type on a real keyboard — both call this ──

async function submitCode() {
  $('#code-note').textContent = 'Joining…';
  try { await game.joinRoom(codeBuffer); }
  catch (err) { fail(err); }
}

function enterChar(ch) {
  if (codeBuffer.length >= 4 || !CODE_ALPHABET.includes(ch)) return;
  codeBuffer += ch;
  setCodeDisplay(codeBuffer);
  flashKey(ch);
  if (codeBuffer.length === 4) submitCode();
}

function deleteChar() {
  codeBuffer = codeBuffer.slice(0, -1);
  setCodeDisplay(codeBuffer);
  $('#code-note').textContent = '';
}

buildKeypad(enterChar);
$('#btn-code-del').addEventListener('click', deleteChar);
$('#btn-code-back').addEventListener('click', () => showScreen('screen-title'));

// A physical keyboard does the same thing a tap does on the code screen: any
// key on the pad enters that character, Backspace deletes, and browser
// shortcuts (anything held with Ctrl/Alt/Meta) are left alone.
document.addEventListener('keydown', (e) => {
  if (!$('#screen-code[data-active]')) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.target.closest?.('input, select, textarea, .settings-panel')) return;
  if (e.key === 'Backspace') { e.preventDefault(); deleteChar(); return; }
  const ch = e.key.length === 1 ? e.key.toUpperCase() : '';
  if (ch && CODE_ALPHABET.includes(ch)) { e.preventDefault(); enterChar(ch); }
});

// ── Lobby ──────────────────────────────────────────────────────────────

$('#btn-start').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try { await game.startGame(); }
  catch (err) { toast(String(err.message || err)); e.target.disabled = false; }
});

$('#btn-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Invite link copied.');
  } catch {
    toast(location.href, 6000);
  }
});

// ── Game ───────────────────────────────────────────────────────────────

setMuteButton(sfx.muted);

// The HUD icon and the panel's button are two views of one mute, so each has
// to repaint the other -- otherwise muting from the panel leaves a speaker
// icon in the HUD claiming sound is on.
const settings = buildSettings(
  { music: volume.music, sfx: volume.sfx, muted: volume.muted },
  {
    onMusic: (v) => volume.setMusic(v),
    onSfx: (v) => {
      volume.setSfx(v);
      sfx.type();          // so you can hear what you just set
    },
    onMute: () => {
      const muted = sfx.toggleMute();
      setMuteButton(muted);
      return muted;
    },
  },
);

$('#btn-mute').addEventListener('click', () => {
  const muted = sfx.toggleMute();
  setMuteButton(muted);
  settings?.paintMute(muted);
});

// Guesses are physical-keyboard only -- there's no on-screen keyboard to
// tap. This listener only fires while the game screen is showing, so it
// never fights the code-entry listener above or fires during lobby/board.
document.addEventListener('keydown', (e) => {
  if (!$('#screen-game[data-active]')) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  // A focused slider owns its own arrow keys, and a letter typed with one
  // focused must not do both things at once. The panel stops propagation
  // itself; this is the backstop for any control added later.
  if (e.target.closest?.('input, select, textarea, .settings-panel')) return;
  if (e.key === 'Enter') { e.preventDefault(); game.handleKey('ENTER'); return; }
  if (e.key === 'Backspace') { e.preventDefault(); game.handleKey('BACK'); return; }
  const ch = e.key.length === 1 ? e.key.toUpperCase() : '';
  if (ch && /^[A-Z]$/.test(ch)) { e.preventDefault(); game.handleKey(ch); }
});

$('#btn-again').addEventListener('click', () => { location.href = location.pathname; });
$('#btn-error-back').addEventListener('click', () => { location.href = location.pathname; });

// ── Go ─────────────────────────────────────────────────────────────────

// A browser will not let audio start before a gesture, so the soundtrack
// cannot begin on load -- it begins the first time the player touches
// anything. `once` because after that the game drives the theme itself.
for (const evt of ['pointerdown', 'keydown']) {
  document.addEventListener(evt, () => music.start(game.musicTheme()), { once: true });
}

startScreenFit();

(async () => {
  try {
    await game.boot();
    const code = new URL(location.href).searchParams.get('r');
    if (code && /^[A-Z2-9]{4}$/.test(code.toUpperCase())) {
      codeBuffer = code.toUpperCase();
      setCodeDisplay(codeBuffer);
      showScreen('screen-code');
      await submitCode();
    }
  } catch (err) {
    fail(err);
  }
})();
