// Bootstrap: wire the buttons to the game, and nothing else.

import { Game } from './game.js';
import { DEFAULT_ROUNDS } from './config.js';
import {
  $, showScreen, toast, buildKeypad, setCodeDisplay,
  chipGroup, showError,
} from './ui.js';

const game = new Game();
// Exposed so the browser test harness can inspect the live simulation.
window.__drift = game;
let chosenRounds = DEFAULT_ROUNDS;
let codeBuffer = '';

function fail(err) {
  const msg = String(err?.message ?? err);
  if (/no such room/i.test(msg)) { showScreen('screen-code'); $('#code-note').textContent = 'No room with that code.'; codeBuffer = ''; setCodeDisplay(''); return; }
  if (/already started/i.test(msg)) { showScreen('screen-code'); $('#code-note').textContent = 'That game has already started.'; codeBuffer = ''; setCodeDisplay(''); return; }
  if (/room is full/i.test(msg)) { showScreen('screen-code'); $('#code-note').textContent = 'That room is full (10 players).'; codeBuffer = ''; setCodeDisplay(''); return; }
  showError('Something went wrong', msg);
}

// ── Title ──────────────────────────────────────────────────────────────

chipGroup($('#rounds-chips'), (v) => { chosenRounds = Number(v); }, 'rounds');

$('#btn-create').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try { await game.createRoom(chosenRounds); }
  catch (err) { fail(err); }
  finally { e.target.disabled = false; }
});

$('#btn-join').addEventListener('click', () => {
  codeBuffer = '';
  setCodeDisplay('');
  $('#code-note').textContent = '';
  showScreen('screen-code');
});

// ── Code entry: taps only, auto-submits on the 4th character ──────────

async function submitCode() {
  $('#code-note').textContent = 'Joining…';
  try { await game.joinRoom(codeBuffer); }
  catch (err) { fail(err); }
}

buildKeypad((ch) => {
  if (codeBuffer.length >= 4) return;
  codeBuffer += ch;
  setCodeDisplay(codeBuffer);
  if (codeBuffer.length === 4) submitCode();
});

$('#btn-code-del').addEventListener('click', () => {
  codeBuffer = codeBuffer.slice(0, -1);
  setCodeDisplay(codeBuffer);
  $('#code-note').textContent = '';
});
$('#btn-code-back').addEventListener('click', () => showScreen('screen-title'));

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

chipGroup($('#wager-chips'), (v) => game.setWager(Number(v)), 'wager');
chipGroup($('#ball-chips'), (v) => game.setBall(Number(v)), 'ball');

const arena = $('#arena');
arena.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  game.handleArenaClick(e);
});
// Stop a tap from also scrolling or firing a synthetic click.
arena.addEventListener('contextmenu', (e) => e.preventDefault());

$('#btn-again').addEventListener('click', () => { location.href = location.pathname; });
$('#btn-error-back').addEventListener('click', () => { location.href = location.pathname; });

// ── Go ─────────────────────────────────────────────────────────────────

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
